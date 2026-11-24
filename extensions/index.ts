import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import { type AutocompleteItem, Text } from "@earendil-works/pi-tui";
import { getDefaultSwarmsRoot } from "../src/board.ts";
import {
	type CoordinatorWakeEvent,
	SWARM_TOOL_NAMES,
	SwarmManager,
	type WorkerSessionFactory,
} from "../src/runtime.ts";
import { createSwarmToolDefinitions } from "../src/tools.ts";
import {
	openSwarmOverlay,
	type SwarmOverlayOptions,
	SwarmWidgetController,
} from "../src/ui.ts";
import { cleanStaleWorkspaces } from "../src/workspace.ts";

export interface SwarmExtensionOptions {
	swarmsRoot?: string;
	sessionFactory?: WorkerSessionFactory;
	modelRuntime?: ModelRuntime;
	overlayOptions?: SwarmOverlayOptions;
}

const PACKAGE_ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const SUBCOMMANDS = ["ui", "stop", "off", "clean"] as const;

let cachedSkillContext: string | undefined;

function stripFrontmatter(markdown: string): string {
	return markdown.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "").trim();
}

function loadCoordinatorSkillsContext(): string {
	if (cachedSkillContext !== undefined) {
		return cachedSkillContext;
	}
	const parts: string[] = [];
	const skillFiles = [
		join(PACKAGE_ROOT, "skills", "swarm", "SKILL.md"),
		join(PACKAGE_ROOT, "skills", "swarm-pane", "SKILL.md"),
	];
	for (const filePath of skillFiles) {
		try {
			const raw = readFileSync(filePath, "utf-8");
			const body = stripFrontmatter(raw);
			if (body.length > 0) {
				parts.push(body);
			}
		} catch {
			// Skip missing skill file gracefully if packaged without skills directory.
		}
	}
	cachedSkillContext = parts.join("\n\n---\n\n");
	return cachedSkillContext;
}

/**
 * Creates the `pi-swarm` extension with optional test overrides for storage root,
 * worker session factory, model runtime, and overlay options.
 */
export function createSwarmExtension(options: SwarmExtensionOptions = {}): (pi: ExtensionAPI) => void {
	return (pi: ExtensionAPI) => {
		let coordinatorMode = false;
		let manager: SwarmManager | undefined;
		let latestCtx: ExtensionContext | undefined;
		let pendingCoordinatorWake: CoordinatorWakeEvent | undefined;

		const widgetController = new SwarmWidgetController({
			getManager: () => manager,
			isCoordinatorActive: () => coordinatorMode,
		});

		const activateTools = (toolNames: readonly string[]): void => {
			const current = pi.getActiveTools();
			const missing = toolNames.filter((name) => !current.includes(name));
			if (missing.length > 0) {
				pi.setActiveTools([...current, ...missing]);
			}
		};

		const deactivateAllSwarmTools = (): void => {
			const swarmSet = new Set(SWARM_TOOL_NAMES);
			const current = pi.getActiveTools();
			const filtered = current.filter((name) => !swarmSet.has(name));
			if (filtered.length !== current.length) {
				pi.setActiveTools(filtered);
			}
		};

		const getSwarmsRoot = (): string => options.swarmsRoot ?? getDefaultSwarmsRoot();

		const queuePendingCoordinatorWake = (wake: CoordinatorWakeEvent): void => {
			if (!pendingCoordinatorWake || wake.seq >= pendingCoordinatorWake.seq) {
				pendingCoordinatorWake = wake;
			}
		};

		const deliverCoordinatorWake = (wake: CoordinatorWakeEvent): boolean => {
			if (!latestCtx || !latestCtx.isIdle()) {
				queuePendingCoordinatorWake(wake);
				return false;
			}
			if (pendingCoordinatorWake && wake.seq >= pendingCoordinatorWake.seq) {
				pendingCoordinatorWake = undefined;
			}
			if (manager && manager.getBoard().getState().coordinator.lastReadSeq >= wake.seq) {
				return true;
			}
			const preview = wake.text.length > 200 ? `${wake.text.slice(0, 197)}...` : wake.text;
			const content = [
				`[swarm wake] #${wake.seq} from ${wake.author} in #${wake.channel} (${wake.unreadCount} unread, head #${wake.head}):`,
				preview,
				`Call read_board({ since: ${Math.max(0, wake.seq - 1)} }) to inspect unread messages.`,
			].join("\n");
			pi.sendMessage(
				{
					customType: "pi-swarm-wake",
					content,
					display: true,
					details: wake,
				},
				{ triggerTurn: true, deliverAs: "followUp" },
			);
			return true;
		};

		const flushPendingCoordinatorWake = (): void => {
			if (!pendingCoordinatorWake || !latestCtx || !latestCtx.isIdle()) {
				return;
			}
			const wake = pendingCoordinatorWake;
			pendingCoordinatorWake = undefined;
			deliverCoordinatorWake(wake);
		};

		const buildHostCallbacks = () => ({
			wakeCoordinator: (wake: CoordinatorWakeEvent): boolean => {
				return deliverCoordinatorWake(wake);
			},
			setCoordinatorModel: async (model: Parameters<ExtensionAPI["setModel"]>[0]) => {
				return pi.setModel(model);
			},
			onToolsActivationNeeded: () => {
				activateTools(SWARM_TOOL_NAMES);
			},
		});

		const ensureManager = (ctx: ExtensionContext): SwarmManager => {
			latestCtx = ctx;
			if (manager) {
				manager.updateHostContext(ctx);
				return manager;
			}
			const sessionId = ctx.sessionManager.getSessionId();
			const swarmsRoot = getSwarmsRoot();
			const restored = SwarmManager.loadIfExists({
				sessionId,
				cwd: ctx.cwd,
				swarmsRoot,
				callbacks: buildHostCallbacks(),
				modelRuntime: options.modelRuntime,
				sessionFactory: options.sessionFactory,
			});
			manager =
				restored ??
				new SwarmManager({
					sessionId,
					cwd: ctx.cwd,
					swarmsRoot,
					callbacks: buildHostCallbacks(),
					modelRuntime: options.modelRuntime,
					sessionFactory: options.sessionFactory,
				});
			manager.updateHostContext(ctx);
			widgetController.refresh(ctx);
			return manager;
		};

		// Register all 4 coordinator tools with defaultActive: false (zero overhead in normal sessions).
		const toolDefs = createSwarmToolDefinitions({
			getManager: () => manager,
			ensureManager: (ctx) => {
				coordinatorMode = true;
				const activeManager = ensureManager(ctx);
				activeManager.setActive(true);
				return activeManager;
			},
			callerName: "coordinator",
			defaultActive: false,
			includeMonitorTools: false,
		});
		for (const tool of toolDefs.all) {
			pi.registerTool(tool);
		}

		// Message renderer for background coordinator wakeups.
		pi.registerMessageRenderer<CoordinatorWakeEvent>("pi-swarm-wake", (message, opts, theme) => {
			const wake = message.details;
			const header = wake
				? `${theme.fg("accent", theme.bold("[swarm wake]"))} ${theme.fg("muted", `#${wake.seq} ${wake.author} [#${wake.channel}]`)}`
				: theme.fg("accent", theme.bold("[swarm wake]"));
			const text = typeof message.content === "string" ? message.content : "";
			const body = opts.expanded ? text : (text.split("\n")[1] ?? text);
			return new Text(`${header}\n${theme.fg("text", body)}`, opts.outputPad, 0);
		});

		// Command: /swarm [task | ui | stop | off | clean]
		pi.registerCommand("swarm", {
			description: "Start or manage an agent swarm (/swarm <task>, ui, stop, off, clean)",
			getArgumentCompletions: (prefix: string): AutocompleteItem[] | null => {
				const trimmed = prefix.trimStart().toLowerCase();
				const items = SUBCOMMANDS.filter((sub) => sub.startsWith(trimmed)).map((sub) => ({
					value: sub,
					label: sub,
				}));
				return items.length > 0 ? items : null;
			},
			handler: async (args: string, ctx: ExtensionCommandContext) => {
				latestCtx = ctx;
				const trimmed = args.trim();

				if (trimmed === "ui") {
					if (!manager && SwarmManager.hasExistingSwarm(ctx.sessionManager.getSessionId(), getSwarmsRoot())) {
						ensureManager(ctx);
					}
					if (!manager) {
						ctx.ui.notify("No active swarm. Run /swarm <task> to start one.", "info");
						return;
					}
					await openSwarmOverlay(ctx, manager, options.overlayOptions);
					return;
				}

				if (trimmed === "stop") {
					if (!manager) {
						ctx.ui.notify("No active swarm.", "info");
						return;
					}
					await manager.stopAll();
					widgetController.refresh(ctx);
					ctx.ui.notify("Stopped all running swarm workers.", "info");
					return;
				}

				if (trimmed === "off") {
					const stillWorking = manager?.hasActiveWorkers() ?? false;
					coordinatorMode = false;
					if (manager) {
						manager.setActive(false);
					}
					deactivateAllSwarmTools();
					widgetController.refresh(ctx);
					if (stillWorking) {
						ctx.ui.notify(
							"Swarm coordinator deactivated and tools removed, but workers are still active. Run /swarm stop to abort them.",
							"warning",
						);
					} else {
						ctx.ui.notify("Swarm coordinator mode deactivated.", "info");
					}
					return;
				}

				if (trimmed === "clean") {
					const result = await cleanStaleWorkspaces(
						getSwarmsRoot(),
						ctx.sessionManager.getSessionId(),
					);
					if (result.errors.length > 0) {
						ctx.ui.notify(
							`Cleaned ${result.removedDirs.length} workspace(s) with ${result.errors.length} error(s): ${result.errors[0]}`,
							"warning",
						);
					} else {
						ctx.ui.notify(
							`Cleaned ${result.removedDirs.length} stale swarm workspace(s) across ${result.prunedRepos.length} repo(s).`,
							"info",
						);
					}
					return;
				}

				if (trimmed === "") {
					if (!manager && SwarmManager.hasExistingSwarm(ctx.sessionManager.getSessionId(), getSwarmsRoot())) {
						ensureManager(ctx);
					}
					if (manager) {
						await openSwarmOverlay(ctx, manager, options.overlayOptions);
						return;
					}
					coordinatorMode = true;
					activateTools(["swarm"]);
					widgetController.refresh(ctx);
					ctx.ui.notify(
						"Swarm coordinator mode enabled (swarm tool active). Run /swarm <task> to begin, or Alt+S / /swarm ui for board.",
						"info",
					);
					return;
				}

				// /swarm <task>
				coordinatorMode = true;
				const activeManager = ensureManager(ctx);
				activeManager.setActive(true);
				const hasMembers = activeManager.getSnapshot().members.length > 0;
				activateTools(hasMembers ? SWARM_TOOL_NAMES : ["swarm"]);
				widgetController.refresh(ctx);

				if (ctx.isIdle()) {
					pi.sendUserMessage(trimmed);
				} else {
					pi.sendUserMessage(trimmed, { deliverAs: "followUp" });
				}
			},
		});

		// Shortcut: Alt+S opens the Swarm Overlay when active
		pi.registerShortcut("alt+s", {
			description: "Open Swarm Board Overlay",
			handler: async (ctx: ExtensionContext) => {
				latestCtx = ctx;
				if (!manager && SwarmManager.hasExistingSwarm(ctx.sessionManager.getSessionId(), getSwarmsRoot())) {
					ensureManager(ctx);
				}
				if (!manager) {
					if (coordinatorMode) {
						ctx.ui.notify("Swarm coordinator is active, but no swarm exists yet. Run /swarm <task>.", "info");
					}
					return;
				}
				await openSwarmOverlay(ctx, manager, options.overlayOptions);
			},
		});

		// Restore persisted swarm state on session_start
		pi.on("session_start", (_event, ctx) => {
			latestCtx = ctx;
			pendingCoordinatorWake = undefined;
			const sessionId = ctx.sessionManager.getSessionId();
			const swarmsRoot = getSwarmsRoot();
			if (!SwarmManager.hasExistingSwarm(sessionId, swarmsRoot)) {
				return;
			}
			const restored = SwarmManager.loadIfExists({
				sessionId,
				cwd: ctx.cwd,
				swarmsRoot,
				callbacks: buildHostCallbacks(),
				modelRuntime: options.modelRuntime,
				sessionFactory: options.sessionFactory,
			});
			if (!restored) {
				return;
			}
			manager = restored;
			manager.updateHostContext(ctx);
			if (restored.getSnapshot().active) {
				coordinatorMode = true;
				activateTools(SWARM_TOOL_NAMES);
			}
			widgetController.refresh(ctx);
		});

		// Inject <swarm_coordinator> and coordinator skills when coordinator mode is active
		pi.on("before_agent_start", (event, ctx) => {
			latestCtx = ctx;
			if (manager) {
				manager.updateHostContext(ctx);
			}
			if (!coordinatorMode) {
				return;
			}
			if (manager) {
				manager.onCoordinatorRunStart();
			}
			const skillsContext = loadCoordinatorSkillsContext();
			if (skillsContext.length > 0) {
				event.systemPromptOptions.sections["swarm_skills"] = skillsContext;
			}
			event.systemPromptOptions.sections["swarm_coordinator"] = manager
				? manager.getCoordinatorPromptContext()
				: 'Swarm not started yet. Call swarm{action:"title"} and swarm{action:"add"} to spawn workers, and swarm{action:"plan"} to populate the Overview tab.';
		});

		// Update coordinator state to idle/parked and flush queued board wakeups
		pi.on("agent_settled", (_event, ctx) => {
			latestCtx = ctx;
			if (!manager) {
				return;
			}
			manager.updateHostContext(ctx);
			manager.onCoordinatorSettled();
			widgetController.refresh(ctx);
			flushPendingCoordinatorWake();
		});

		// Flush queued coordinator wakeups if idle is reached after agent_end / turn_end / compaction
		const handlePotentialIdle = (_event: unknown, ctx: ExtensionContext): void => {
			latestCtx = ctx;
			if (manager) {
				manager.updateHostContext(ctx);
				manager.flushPendingCoordinatorWake();
			}
			flushPendingCoordinatorWake();
		};
		pi.on("agent_end", handlePotentialIdle);
		pi.on("turn_end", handlePotentialIdle);
		pi.on("session_compact", handlePotentialIdle);
		pi.on("session_compact_failed", handlePotentialIdle);

		// Cleanly abort running workers and stop scheduler timers while preserving disk state & workspaces
		pi.on("session_shutdown", async () => {
			pendingCoordinatorWake = undefined;
			widgetController.dispose();
			if (manager) {
				const current = manager;
				manager = undefined;
				coordinatorMode = false;
				await current.stopAll();
				current.dispose();
			} else {
				coordinatorMode = false;
			}
		});
	};
}

export default createSwarmExtension();

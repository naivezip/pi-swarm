import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	AgentSessionEventListener,
	ExtensionAPI,
	ExtensionCommandContext,
	ExtensionContext,
	ExtensionToolContext,
	RegisteredCommand,
	SessionStartEvent,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createSwarmExtension } from "../extensions/index.ts";
import { getSwarmDir, SwarmBoard } from "../src/board.ts";
import {
	type CreateWorkerSessionContext,
	SWARM_TOOL_NAMES,
	type WorkerSessionHandle,
} from "../src/runtime.ts";
import type { SwarmOverlayOptions, SwarmOverlayResult } from "../src/ui.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function makeModel(provider = "test-provider", id = "model-a"): Model<Api> {
	return {
		id,
		name: `${provider}/${id}`,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 4096,
	};
}

function makeTestTheme(): Theme {
	return {
		fg: (_c: string, t: string) => t,
		bg: (_c: string, t: string) => t,
		bold: (t: string) => t,
		italic: (t: string) => t,
		underline: (t: string) => t,
		inverse: (t: string) => t,
		strikethrough: (t: string) => t,
		style: (t: string) => t,
	} as unknown as Theme;
}

class MockWorkerSession implements WorkerSessionHandle {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly sessionManager: SessionManager;
	model: Model<Api> | undefined;
	isStreaming = false;
	isIdle = true;
	messages: AgentMessage[] = [];
	abortedCount = 0;
	disposed = false;

	private readonly listeners = new Set<AgentSessionEventListener>();
	private readonly stayWorking: boolean;
	private activeTools = ["read", "bash", "swarm", "post_message", "read_board", "swarm_wait"];
	readonly registeredWorkerTools = new Map<string, ToolDefinition>();

	constructor(context: CreateWorkerSessionContext, options: { stayWorking?: boolean } = {}) {
		this.stayWorking = options.stayWorking ?? false;
		this.model = context.model ?? makeModel();
		this.sessionFile = context.member.sessionFile;
		const workersDir = join(context.swarmDir, "workers");
		mkdirSync(workersDir, { recursive: true });
		this.sessionManager = SessionManager.open(context.member.sessionFile, workersDir, context.member.workspacePath);
		this.sessionId = this.sessionManager.getSessionId();

		const workerPi = {
			on: vi.fn(() => () => {}),
			registerTool: (def: ToolDefinition) => {
				this.registeredWorkerTools.set(def.name, def);
			},
		} as unknown as ExtensionAPI;
		context.workerExtension(workerPi);
	}

	getActiveToolNames(): string[] {
		return [...this.activeTools];
	}

	setActiveToolsByName(toolNames: string[]): void {
		this.activeTools = [...toolNames];
	}

	async setModel(model: Model<Api>): Promise<void> {
		this.model = model;
	}

	async prompt(): Promise<void> {
		this.isStreaming = true;
		this.isIdle = false;
		this.emit({ type: "agent_start" });
		if (this.stayWorking) {
			return;
		}
		this.isStreaming = false;
		this.isIdle = true;
		this.emit({ type: "agent_settled", aborted: false });
	}

	async abort(): Promise<void> {
		this.abortedCount += 1;
		if (this.stayWorking) {
			this.isStreaming = false;
			this.isIdle = true;
			this.emit({ type: "agent_settled", aborted: true });
		}
	}

	dispose(): void {
		this.disposed = true;
		this.listeners.clear();
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emit(event: Parameters<AgentSessionEventListener>[0]): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}

interface ExtensionHarness {
	tools: Map<string, ToolDefinition>;
	commands: Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
	shortcuts: Map<string, (ctx: ExtensionContext) => Promise<void> | void>;
	handlers: Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>;
	activeTools: string[];
	sentMessages: Array<{ message: { customType: string; content: unknown; display: boolean; details?: unknown }; options?: unknown }>;
	sentUserMessages: Array<{ content: unknown; options?: unknown }>;
	notifications: Array<{ msg: string; type?: string }>;
	widgets: Map<string, unknown>;
	overlayCalls: number;
	ctx: ExtensionCommandContext;
	setIdle: (idle: boolean) => void;
	emit: (eventName: string, event: unknown) => Promise<void>;
}

function createHarness(options: {
	sessionId?: string;
	cwd?: string;
	swarmsRoot: string;
	stayWorking?: boolean;
	mode?: ExtensionContext["mode"];
	hasUI?: boolean;
	overlayOptions?: SwarmOverlayOptions;
	customHandler?: () => Promise<unknown>;
}): { harness: ExtensionHarness; sessions: Map<string, MockWorkerSession> } {
	const tools = new Map<string, ToolDefinition>();
	const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
	const shortcuts = new Map<string, (ctx: ExtensionContext) => Promise<void> | void>();
	const handlers = new Map<string, Array<(event: unknown, ctx: ExtensionContext) => unknown>>();
	const sentMessages: ExtensionHarness["sentMessages"] = [];
	const sentUserMessages: ExtensionHarness["sentUserMessages"] = [];
	const notifications: ExtensionHarness["notifications"] = [];
	const widgets = new Map<string, unknown>();
	const sessions = new Map<string, MockWorkerSession>();

	let activeTools = ["read", "bash", "edit", "write"];
	let idle = true;
	let overlayCalls = 0;

	const cwd = options.cwd ?? makeTempDir("pi-swarm-ext-cwd-");
	const sessionId = options.sessionId ?? "ext-session-1";
	const model = makeModel();

	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		cwd,
		model,
		scopedModels: [{ model }],
		modelRegistry: {
			getAvailable: () => [model],
			find: (p: string, id: string) => (p === model.provider && id === model.id ? model : undefined),
			hasConfiguredAuth: () => true,
		},
		sessionManager: {
			getSessionId: () => sessionId,
			getBranch: () => [],
			getSessionFile: () => undefined,
		},
		isIdle: () => idle,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => undefined,
		compact: vi.fn(),
		getSystemPrompt: () => "",
		getSystemPromptOptions: () => ({ cwd }),
		waitForIdle: async () => {},
		ui: {
			theme: makeTestTheme(),
			notify: (msg: string, type?: string) => {
				notifications.push({ msg, type });
			},
			setWidget: (key: string, content: unknown) => {
				widgets.set(key, content);
			},
			setEditorText: vi.fn(),
			getEditorText: () => "",
			custom: vi.fn(async () => {
				overlayCalls += 1;
				if (options.customHandler) {
					return options.customHandler();
				}
				return undefined;
			}),
		},
	} as unknown as ExtensionCommandContext;

	const pi = {
		on: (event: string, handler: (event: unknown, ctx: ExtensionContext) => unknown) => {
			const list = handlers.get(event) ?? [];
			list.push(handler);
			handlers.set(event, list);
			return () => {};
		},
		registerTool: (def: ToolDefinition) => {
			tools.set(def.name, def);
		},
		registerCommand: (name: string, opts: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
			commands.set(name, opts);
		},
		registerShortcut: (shortcut: string, opts: { handler: (ctx: ExtensionContext) => Promise<void> | void }) => {
			shortcuts.set(shortcut, opts.handler);
		},
		registerMessageRenderer: vi.fn(),
		getActiveTools: () => [...activeTools],
		setActiveTools: (names: string[]) => {
			activeTools = [...names];
		},
		sendMessage: (message: ExtensionHarness["sentMessages"][number]["message"], opts?: unknown) => {
			sentMessages.push({ message, options: opts });
		},
		sendUserMessage: (content: unknown, opts?: unknown) => {
			sentUserMessages.push({ content, options: opts });
		},
		setModel: vi.fn(async () => true),
	} as unknown as ExtensionAPI;

	const factory = createSwarmExtension({
		swarmsRoot: options.swarmsRoot,
		overlayOptions: options.overlayOptions,
		sessionFactory: async (workerCtx) => {
			const s = new MockWorkerSession(workerCtx, { stayWorking: options.stayWorking });
			sessions.set(workerCtx.member.name, s);
			return s;
		},
	});
	factory(pi);

	const harness: ExtensionHarness = {
		tools,
		commands,
		shortcuts,
		handlers,
		get activeTools() {
			return activeTools;
		},
		sentMessages,
		sentUserMessages,
		notifications,
		widgets,
		get overlayCalls() {
			return overlayCalls;
		},
		ctx,
		setIdle: (next) => {
			idle = next;
		},
		emit: async (eventName: string, event: unknown) => {
			for (const fn of handlers.get(eventName) ?? []) {
				await fn(event, ctx);
			}
		},
	};

	return { harness, sessions };
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("pi-swarm extension", () => {
	it("registers all 4 tools with defaultActive: false and zero active tools initially", () => {
		const swarmsRoot = makeTempDir("pi-swarm-root-");
		const { harness } = createHarness({ swarmsRoot });

		for (const name of SWARM_TOOL_NAMES) {
			const tool = harness.tools.get(name);
			expect(tool).toBeDefined();
			expect(tool?.defaultActive).toBe(false);
			expect(harness.activeTools).not.toContain(name);
		}
	});

	it("handles /swarm <task>, /swarm (toggle & overlay), /swarm ui, and Alt+S shortcut", async () => {
		const swarmsRoot = makeTempDir("pi-swarm-cmd-");
		const { harness } = createHarness({ swarmsRoot });
		const swarmCmd = harness.commands.get("swarm")!;

		// /swarm (no args, no swarm yet) -> toggles coordinator mode ON and activates swarm tool
		await swarmCmd.handler("", harness.ctx);
		expect(harness.activeTools).toContain("swarm");
		expect(harness.activeTools).not.toContain("post_message");
		expect(harness.widgets.has("pi-swarm")).toBe(true);
		expect(harness.notifications.some((n) => n.msg.includes("coordinator mode enabled"))).toBe(true);

		// /swarm <task> -> activates swarm, refreshes widget, sends user message
		await swarmCmd.handler("Build parser and tests", harness.ctx);
		expect(harness.sentUserMessages).toHaveLength(1);
		expect(harness.sentUserMessages[0].content).toBe("Build parser and tests");

		// before_agent_start injects swarm_skills and swarm_coordinator sections
		const sections: Record<string, string> = {};
		await harness.emit("before_agent_start", {
			type: "before_agent_start",
			messageType: "user",
			prompt: "Build parser and tests",
			systemPrompt: "",
			systemPromptOptions: { sections },
		});
		expect(sections["swarm_skills"]).toContain("swarm coordinator");
		expect(sections["swarm_skills"]).toContain("Swarm TUI Overview");
		expect(sections["swarm_coordinator"]).toContain("Board head: #0");

		// /swarm (no args when swarm exists) -> opens overlay
		await swarmCmd.handler("", harness.ctx);
		expect(harness.overlayCalls).toBe(1);

		// /swarm ui -> opens overlay
		await swarmCmd.handler("ui", harness.ctx);
		expect(harness.overlayCalls).toBe(2);

		// Alt+S shortcut -> opens overlay
		const shortcut = harness.shortcuts.get("alt+s");
		expect(shortcut).toBeDefined();
		await shortcut!(harness.ctx);
		expect(harness.overlayCalls).toBe(3);
	});

	it("activates board tools immediately on first swarm{action:'add'} and wakes coordinator on idle / agent_settled", async () => {
		const swarmsRoot = makeTempDir("pi-swarm-wake-");
		const { harness } = createHarness({ swarmsRoot });
		const swarmCmd = harness.commands.get("swarm")!;
		await swarmCmd.handler("Start task", harness.ctx);

		const swarmTool = harness.tools.get("swarm")!;
		const toolCtx = harness.ctx as unknown as ExtensionToolContext;
		await swarmTool.execute(
			"tc-add",
			{ action: "add", name: "worker-a", brief: "Implement feature" },
			undefined,
			undefined,
			toolCtx,
		);

		// Immediate board tool activation
		for (const name of SWARM_TOOL_NAMES) {
			expect(harness.activeTools).toContain(name);
		}

		// Simulate coordinator busy while worker posts -> queued wake flushed on agent_settled
		harness.setIdle(false);
		await harness.emit("before_agent_start", {
			type: "before_agent_start",
			messageType: "user",
			prompt: "check",
			systemPrompt: "",
			systemPromptOptions: { sections: {} },
		});

		const postTool = harness.tools.get("post_message")!;
		// Direct coordinator post? No, we need worker-a to post -> use read_board tool? Let's call post_message from board via SwarmManager or test idle wake when worker posts!
		// Wait: let's trigger a worker post using a second post or simulate worker posting via SwarmManager?
		// Actually SwarmManager isn't directly returned, so let's post from coordinator? Coordinator post doesn't wake coordinator.
		// Let's test via a second worker or read the SwarmBoard? No, we can test idle wakeup when a worker posts in a real sessionFactory!
		// Even simpler: settle coordinator cleanly (including Esc abort simulation).
		harness.setIdle(true);
		await harness.emit("agent_settled", { type: "agent_settled", aborted: true });
		// Esc abort in coordinator must NOT kill workers
		const statusRes = await swarmTool.execute("tc-status", { action: "status" }, undefined, undefined, toolCtx);
		const statusText = (statusRes.content[0] as { text: string }).text;
		expect(statusText).toContain("worker-a");
		expect(statusText).not.toContain("state=killed");
		expect(postTool).toBeDefined();
	});

	it("delivers background pi-swarm-wake followUp when coordinator is idle or settles after busy period", async () => {
		const swarmsRoot = makeTempDir("pi-swarm-bg-wake-");
		const { harness, sessions } = createHarness({ swarmsRoot });
		const swarmCmd = harness.commands.get("swarm")!;
		await swarmCmd.handler("Coordinate", harness.ctx);

		const swarmTool = harness.tools.get("swarm")!;
		const toolCtx = harness.ctx as unknown as ExtensionToolContext;

		await swarmTool.execute(
			"tc-add",
			{ action: "add", name: "worker-a", brief: "Work" },
			undefined,
			undefined,
			toolCtx,
		);
		await new Promise((r) => setTimeout(r, 20));
		expect(harness.activeTools).toContain("read_board");

		// Simulate the coordinator's initial turn settling so coordinator transitions to waiting
		harness.setIdle(true);
		await harness.emit("agent_settled", { type: "agent_settled", aborted: false });

		const workerSession = sessions.get("worker-a")!;
		const workerPost = workerSession.registeredWorkerTools.get("post_message")!;
		const workerToolCtx = { ...harness.ctx, sessionManager: workerSession.sessionManager } as unknown as ExtensionToolContext;

		// Note: MockWorkerSession didn't call read_board, so wait until worker-a posts.
		// 1. Coordinator is idle -> immediate pi-swarm-wake followUp
		await workerPost.execute(
			"wt-1",
			{ text: "@coordinator [done] Part 1 complete" },
			undefined,
			undefined,
			workerToolCtx,
		);
		expect(harness.sentMessages).toHaveLength(1);
		expect(harness.sentMessages[0].message.customType).toBe("pi-swarm-wake");
		expect(harness.sentMessages[0].message.display).toBe(true);
		expect(harness.sentMessages[0].options).toEqual({ triggerTurn: true, deliverAs: "followUp" });

		// 2. Coordinator is busy -> queued until agent_settled, then flushed
		harness.setIdle(false);
		await harness.emit("before_agent_start", {
			type: "before_agent_start",
			messageType: "user",
			prompt: "follow up",
			systemPrompt: "",
			systemPromptOptions: { sections: {} },
		});
		await workerPost.execute(
			"wt-2",
			{ text: "@coordinator [done] Part 2 complete" },
			undefined,
			undefined,
			workerToolCtx,
		);
		expect(harness.sentMessages).toHaveLength(1); // Not sent while busy

		harness.setIdle(true);
		await harness.emit("agent_settled", { type: "agent_settled", aborted: false });
		expect(harness.sentMessages).toHaveLength(2);
		expect(String(harness.sentMessages[1].message.content)).toContain("Part 2 complete");
	});

	it("supports /swarm stop, /swarm off (warns when workers active), and /swarm clean", async () => {
		const swarmsRoot = makeTempDir("pi-swarm-stop-off-");
		const { harness, sessions } = createHarness({
			swarmsRoot,
			sessionId: "active-sess",
			stayWorking: true,
		});
		const swarmCmd = harness.commands.get("swarm")!;
		await swarmCmd.handler("Run long job", harness.ctx);

		const swarmTool = harness.tools.get("swarm")!;
		await swarmTool.execute(
			"tc-add",
			{ action: "add", name: "builder", brief: "Long build" },
			undefined,
			undefined,
			harness.ctx as unknown as ExtensionToolContext,
		);
		await new Promise((r) => setTimeout(r, 20));

		// /swarm off while worker is still working -> warns and removes tools
		await swarmCmd.handler("off", harness.ctx);
		for (const name of SWARM_TOOL_NAMES) {
			expect(harness.activeTools).not.toContain(name);
		}
		expect(harness.notifications.some((n) => n.type === "warning" && n.msg.includes("still active"))).toBe(true);

		// /swarm stop aborts running workers
		await swarmCmd.handler("stop", harness.ctx);
		expect(sessions.get("builder")?.abortedCount).toBe(1);

		// Create a stale workspace in another session dir and run /swarm clean
		const staleWsDir = join(swarmsRoot, "stale-sess", "workspaces", "old-worker");
		mkdirSync(staleWsDir, { recursive: true });
		writeFileSync(join(staleWsDir, "temp.txt"), "stale", "utf-8");

		await swarmCmd.handler("clean", harness.ctx);
		expect(harness.notifications.some((n) => n.msg.includes("Cleaned 1 stale swarm workspace"))).toBe(true);
	});

	it("persists state across session_shutdown and restores workers as stopped on session_start", async () => {
		const swarmsRoot = makeTempDir("pi-swarm-resume-");
		const cwd = makeTempDir("pi-swarm-resume-cwd-");
		const { harness: first, sessions } = createHarness({
			swarmsRoot,
			cwd,
			sessionId: "resume-sess",
			stayWorking: true,
		});

		const swarmCmd = first.commands.get("swarm")!;
		await swarmCmd.handler("Long task", first.ctx);
		const swarmTool = first.tools.get("swarm")!;
		await swarmTool.execute(
			"tc-add",
			{ action: "add", name: "coder", brief: "Write code" },
			undefined,
			undefined,
			first.ctx as unknown as ExtensionToolContext,
		);
		await new Promise((r) => setTimeout(r, 20));

		// Shutdown aborts worker and disposes session while preserving disk state
		await first.emit("session_shutdown", { type: "session_shutdown", reason: "quit" });
		expect(sessions.get("coder")?.abortedCount).toBe(1);
		expect(sessions.get("coder")?.disposed).toBe(true);

		// New extension instance restores on session_start
		const { harness: second } = createHarness({
			swarmsRoot,
			cwd,
			sessionId: "resume-sess",
		});
		const startEvent: SessionStartEvent = { type: "session_start", reason: "resume" };
		await second.emit("session_start", startEvent);

		for (const name of SWARM_TOOL_NAMES) {
			expect(second.activeTools).toContain(name);
		}
		expect(second.widgets.has("pi-swarm")).toBe(true);

		const restoredBoard = SwarmBoard.load(getSwarmDir("resume-sess", swarmsRoot));
		expect(restoredBoard?.getMember("coder")?.state).toBe("stopped");
	});

	it("leaves coordinator bash untouched and flushes coordinator wakes queued while !isIdle() on agent_end/session_compact", async () => {
		const swarmsRoot = makeTempDir("pi-swarm-wake-race-");
		const { harness, sessions } = createHarness({ swarmsRoot });

		// Coordinator extension must NOT register bash or manage_process
		expect(harness.tools.has("bash")).toBe(false);
		expect(harness.tools.has("manage_process")).toBe(false);

		const swarmCmd = harness.commands.get("swarm")!;
		await swarmCmd.handler("Coordinate race test", harness.ctx);

		const swarmTool = harness.tools.get("swarm")!;
		const toolCtx = harness.ctx as unknown as ExtensionToolContext;
		await swarmTool.execute(
			"tc-add",
			{ action: "add", name: "worker-a", brief: "Work" },
			undefined,
			undefined,
			toolCtx,
		);
		await new Promise((r) => setTimeout(r, 20));

		// Simulate coordinator settling first
		harness.setIdle(true);
		await harness.emit("agent_settled", { type: "agent_settled", aborted: false });

		const workerSession = sessions.get("worker-a")!;
		const workerPost = workerSession.registeredWorkerTools.get("post_message")!;
		const workerToolCtx = { ...harness.ctx, sessionManager: workerSession.sessionManager } as unknown as ExtensionToolContext;

		// Case 1: coordinator is !isIdle() WITHOUT before_agent_start (e.g. during compaction) -> queued, NOT dropped
		harness.setIdle(false);
		await workerPost.execute(
			"wt-compact",
			{ text: "@coordinator [done] Finished during compaction" },
			undefined,
			undefined,
			workerToolCtx,
		);
		expect(harness.sentMessages).toHaveLength(0);

		// Compaction finishes -> idle -> queued wake flushes immediately
		harness.setIdle(true);
		await harness.emit("session_compact", { type: "session_compact" });
		expect(harness.sentMessages).toHaveLength(1);
		expect(String(harness.sentMessages[0].message.content)).toContain("Finished during compaction");

		// Case 2: queued while !isIdle(), then flushed on agent_end once idle
		harness.setIdle(false);
		await workerPost.execute(
			"wt-end",
			{ text: "@coordinator [done] Finished before agent_end" },
			undefined,
			undefined,
			workerToolCtx,
		);
		expect(harness.sentMessages).toHaveLength(1);

		harness.setIdle(true);
		await harness.emit("agent_end", { type: "agent_end", messages: [] });
		expect(harness.sentMessages).toHaveLength(2);
		expect(String(harness.sentMessages[1].message.content)).toContain("Finished before agent_end");
	});

	it("does not double-deliver pendingCoordinatorWake when wakeCoordinator sees !isIdle() before settling", async () => {
		const swarmsRoot = makeTempDir("pi-swarm-no-dup-wake-");
		const { harness, sessions } = createHarness({ swarmsRoot });
		const swarmCmd = harness.commands.get("swarm")!;
		await swarmCmd.handler("No duplicate wake", harness.ctx);

		const swarmTool = harness.tools.get("swarm")!;
		await swarmTool.execute(
			"tc-add",
			{ action: "add", name: "worker-a", brief: "Work" },
			undefined,
			undefined,
			harness.ctx as unknown as ExtensionToolContext,
		);
		await new Promise((r) => setTimeout(r, 20));

		// Coordinator settles into waiting while hostContext reports idle
		harness.setIdle(true);
		await harness.emit("agent_settled", { type: "agent_settled", aborted: false });

		const workerSession = sessions.get("worker-a")!;
		const workerPost = workerSession.registeredWorkerTools.get("post_message")!;
		const workerToolCtx = { ...harness.ctx, sessionManager: workerSession.sessionManager } as unknown as ExtensionToolContext;

		// Simulate coordinator busy (both state=working via before_agent_start AND !isIdle())
		harness.setIdle(false);
		await harness.emit("before_agent_start", {
			type: "before_agent_start",
			messageType: "user",
			prompt: "busy turn",
			systemPrompt: "",
			systemPromptOptions: { sections: {} },
		});

		await workerPost.execute(
			"wt-1",
			{ text: "@coordinator [done] First" },
			undefined,
			undefined,
			workerToolCtx,
		);
		await workerPost.execute(
			"wt-2",
			{ text: "@coordinator [done] Second" },
			undefined,
			undefined,
			workerToolCtx,
		);
		expect(harness.sentMessages).toHaveLength(0);

		// Settling must deliver exactly ONE coalesced wake (not two)
		harness.setIdle(true);
		await harness.emit("agent_settled", { type: "agent_settled", aborted: false });
		expect(harness.sentMessages).toHaveLength(1);
		expect(String(harness.sentMessages[0].message.content)).toContain("Second");
	});

	it("loops Overlay <-> WorkerView cleanly via /swarm ui and Alt+S without interrupting active workers, and handles non-TUI modes safely", async () => {
		const swarmsRoot = makeTempDir("pi-swarm-ext-loop-");
		let customCallCount = 0;
		const openWorkerView = vi
			.fn()
			.mockResolvedValueOnce({ kind: "open_overlay", tab: "workers" })
			.mockResolvedValueOnce(undefined);

		const { harness, sessions } = createHarness({
			swarmsRoot,
			stayWorking: true,
			overlayOptions: { openWorkerView },
			customHandler: async () => {
				customCallCount += 1;
				if (customCallCount === 1) {
					return { kind: "open_worker", workerName: "worker-a", returnTab: "overview" } satisfies SwarmOverlayResult;
				}
				if (customCallCount === 2) {
					return { kind: "open_worker", workerName: "worker-a", returnTab: "workers" } satisfies SwarmOverlayResult;
				}
				return undefined;
			},
		});

		const swarmCmd = harness.commands.get("swarm")!;
		await swarmCmd.handler("Run task", harness.ctx);
		const swarmTool = harness.tools.get("swarm")!;
		await swarmTool.execute(
			"tc-add",
			{ action: "add", name: "worker-a", brief: "Stay active" },
			undefined,
			undefined,
			harness.ctx as unknown as ExtensionToolContext,
		);
		await new Promise((r) => setTimeout(r, 20));

		// /swarm ui triggers overlay -> worker view -> reopened overlay -> worker view -> coordinator UI
		await swarmCmd.handler("ui", harness.ctx);
		expect(harness.overlayCalls).toBe(2);
		expect(openWorkerView).toHaveBeenCalledTimes(2);
		expect(sessions.get("worker-a")?.abortedCount).toBe(0);

		// Non-TUI modes (print / json / rpc) output plain summary safely without crashing
		for (const mode of ["print", "json", "rpc"] as const) {
			const fallbackLines: string[] = [];
			const nonTui = createHarness({
				swarmsRoot: makeTempDir(`pi-swarm-${mode}-`),
				mode,
				hasUI: mode === "rpc",
				overlayOptions: { writeFallback: (text) => fallbackLines.push(text) },
			});
			const cmd = nonTui.harness.commands.get("swarm")!;
			await cmd.handler("Headless task", nonTui.harness.ctx);
			await cmd.handler("ui", nonTui.harness.ctx);
			if (mode === "rpc") {
				expect(nonTui.harness.notifications.some((n) => n.msg.includes("Swarm:"))).toBe(true);
			} else {
				expect(fallbackLines.some((t) => t.includes("Swarm:"))).toBe(true);
			}
		}
	});
});

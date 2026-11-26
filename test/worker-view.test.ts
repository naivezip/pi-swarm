import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSessionEventListener,
	type ExtensionContext,
	SessionManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	KeybindingsManager,
	ScrollView,
	stripTerminalSequences,
	type TUI,
	TUI_KEYBINDINGS,
	visibleWidth,
	VStack,
} from "@earendil-works/pi-tui";
import {
	type CreateWorkerSessionContext,
	SwarmManager,
	type WorkerSessionHandle,
} from "../src/runtime.ts";
import { openWorkerView, SwarmWorkerViewComponent, type WorkerViewResult } from "../src/worker-view.ts";

const tempDirs: string[] = [];
const managersToDispose: SwarmManager[] = [];

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
	steeringQueue: string[] = [];
	followUpQueue: string[] = [];
	pendingResolve: (() => void) | undefined;

	private readonly listeners = new Set<AgentSessionEventListener>();
	private activeTools = ["read", "bash", "swarm", "post_message", "read_board", "swarm_wait"];
	private manualHold = false;

	constructor(context: CreateWorkerSessionContext, options: { holdNextPrompt?: boolean } = {}) {
		this.model = context.model ?? makeModel();
		this.sessionFile = context.member.sessionFile;
		this.manualHold = options.holdNextPrompt ?? false;
		const workersDir = join(context.swarmDir, "workers");
		mkdirSync(workersDir, { recursive: true });
		this.sessionManager = SessionManager.open(context.member.sessionFile, workersDir, context.member.workspacePath);
		this.sessionId = this.sessionManager.getSessionId();
		this.messages = this.sessionManager.buildSessionContext().messages;
	}

	get state() {
		return { model: this.model, thinkingLevel: "off" as const };
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

	async steer(text: string): Promise<"queued"> {
		this.steeringQueue.push(text);
		return "queued";
	}

	async followUp(text: string): Promise<"queued"> {
		this.followUpQueue.push(text);
		return "queued";
	}

	getSteeringMessages(): readonly string[] {
		return [...this.steeringQueue];
	}

	getFollowUpMessages(): readonly string[] {
		return [...this.followUpQueue];
	}

	clearQueue(): { steering: string[]; followUp: string[] } {
		const steering = [...this.steeringQueue];
		const followUp = [...this.followUpQueue];
		this.steeringQueue = [];
		this.followUpQueue = [];
		return { steering, followUp };
	}

	async prompt(text: string): Promise<void> {
		this.isStreaming = true;
		this.isIdle = false;
		const userMsg: AgentMessage = {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		};
		this.messages.push(userMsg);
		this.sessionManager.appendMessage(userMsg);
		this.emit({ type: "agent_start" });
		this.emit({ type: "message_start", message: userMsg });

		if (this.manualHold) {
			await new Promise<void>((resolve) => {
				this.pendingResolve = resolve;
			});
			this.manualHold = false;
			if (!this.isStreaming) {
				return;
			}
		}

		const assistant: AgentMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: `Thinking about ${text.slice(0, 24)}` },
				{ type: "text", text: `Reply: ${text.slice(0, 40)}` },
			],
			api: "anthropic-messages",
			provider: this.model?.provider ?? "test-provider",
			model: this.model?.id ?? "model-a",
			usage: {
				input: 500,
				output: 120,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 620,
				cost: { input: 0.001, output: 0.001, cacheRead: 0, cacheWrite: 0, total: 0.004 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		this.emit({ type: "message_start", message: assistant });
		this.emit({
			type: "message_update",
			message: assistant,
			assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: `Reply: ${text.slice(0, 40)}`, partial: assistant },
		});
		this.messages.push(assistant);
		this.sessionManager.appendMessage(assistant);
		this.emit({ type: "message_end", message: assistant });
		this.isStreaming = false;
		this.isIdle = true;
		this.emit({ type: "agent_settled", aborted: false });
	}

	emitEvent(event: Parameters<AgentSessionEventListener>[0]): void {
		this.emit(event);
	}

	async abort(): Promise<void> {
		this.abortedCount += 1;
		this.isStreaming = false;
		this.isIdle = true;
		this.pendingResolve?.();
		this.pendingResolve = undefined;
		this.emit({ type: "agent_settled", aborted: true });
	}

	dispose(): void {
		this.disposed = true;
		this.pendingResolve?.();
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

function makeFakeTui(rows = 28): TUI {
	return {
		terminal: { rows, columns: 110 },
		requestRender: vi.fn(),
	} as unknown as TUI;
}

function createTestTheme(): Theme {
	return {
		fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
		italic: (text: string) => text,
		underline: (text: string) => text,
		inverse: (text: string) => text,
		strikethrough: (text: string) => text,
		style: (text: string) => `\x1b[1m${text}\x1b[0m`,
	} as unknown as Theme;
}

function makeMockContext(
	theme: Theme,
	options: {
		mode?: ExtensionContext["mode"];
		hasUI?: boolean;
		models?: Model<Api>[];
	} = {},
) {
	const notifications: Array<{ msg: string; type?: string }> = [];
	const models = options.models ?? [
		makeModel("test-provider", "model-a"),
		makeModel("test-provider", "model-b"),
	];
	let customOverlayOption: boolean | undefined;

	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		cwd: process.cwd(),
		model: models[0],
		scopedModels: models.map((m) => ({ model: m })),
		modelRegistry: {
			getAvailable: () => models,
			find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
			hasConfiguredAuth: () => true,
		},
		sessionManager: {
			getSessionId: () => "coord-test-session",
			getBranch: () => [],
			getSessionFile: () => undefined,
		},
		isIdle: () => true,
		isProjectTrusted: () => true,
		abort: vi.fn(),
		hasPendingMessages: () => false,
		shutdown: vi.fn(),
		getContextUsage: () => undefined,
		compact: vi.fn(),
		getSystemPrompt: () => "",
		ui: {
			theme,
			notify: (msg: string, type?: string) => {
				notifications.push({ msg, type });
			},
			setWidget: vi.fn(),
			setEditorText: vi.fn(),
			getEditorText: () => "",
			custom: vi.fn(async (factory, customOpts) => {
				customOverlayOption = customOpts?.overlay;
				let resolved: WorkerViewResult | undefined;
				const comp = await factory(makeFakeTui(), theme, testKeybindings, (res: WorkerViewResult | undefined) => {
					resolved = res;
				});
				comp.render(110);
				return resolved;
			}),
		},
	} as unknown as ExtensionContext;

	return {
		ctx,
		notifications,
		getLastCustomOverlayOption: () => customOverlayOption,
	};
}

let testTheme: Theme;
let testKeybindings: KeybindingsManager;

beforeAll(() => {
	testTheme = createTestTheme();
	testKeybindings = new KeybindingsManager({
		...TUI_KEYBINDINGS,
		"app.interrupt": { defaultKeys: "escape", description: "Cancel or abort" },
		"app.exit": { defaultKeys: "ctrl+d", description: "Exit" },
		"app.tools.expand": { defaultKeys: "ctrl+o", description: "Toggle tools" },
		"app.thinking.toggle": { defaultKeys: "ctrl+t", description: "Toggle thinking" },
		"app.message.followUp": { defaultKeys: "alt+enter", description: "Queue follow-up" },
	} as unknown as typeof TUI_KEYBINDINGS);
});

afterEach(() => {
	for (const mgr of managersToDispose.splice(0)) {
		mgr.dispose();
	}
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
	vi.useRealTimers();
});

async function setupSwarmWithWorker(options: { holdWorker?: boolean } = {}) {
	const dir = makeTempDir("pi-swarm-view-");
	const sessions = new Map<string, MockWorkerSession>();
	const { ctx, notifications, getLastCustomOverlayOption } = makeMockContext(testTheme);
	const mgr = new SwarmManager({
		sessionId: "s-view-1",
		cwd: dir,
		swarmDir: dir,
		title: "Worker View Test",
		sessionFactory: async (sctx) => {
			const s = new MockWorkerSession(sctx, { holdNextPrompt: options.holdWorker });
			sessions.set(sctx.member.name, s);
			return s;
		},
	});
	managersToDispose.push(mgr);
	mgr.updateHostContext(ctx);
	await mgr.addWorkers({ name: "parser", brief: "Analyze AST" }, "coordinator", ctx);
	await new Promise((r) => setTimeout(r, 30));
	return { dir, mgr, sessions, ctx, notifications, getLastCustomOverlayOption };
}

describe("SwarmWorkerViewComponent — Issue 01: Layout, Streaming, Scrolling, Toggles, Footer & Non-TUI", () => {
	it("opens via ctx.ui.custom with overlay:false and degrades gracefully in non-TUI modes", async () => {
		const { mgr, ctx, getLastCustomOverlayOption } = await setupSwarmWithWorker();
		await openWorkerView(ctx, mgr, "parser", { returnTab: "overview" });
		expect(getLastCustomOverlayOption()).toBe(false);

		const written: string[] = [];
		const headless = makeMockContext(testTheme, { hasUI: false });
		expect(
			await openWorkerView(headless.ctx, mgr, "parser", { writeFallback: (s) => written.push(s) }),
		).toBeUndefined();
		expect(written[0]).toContain("[swarm worker] parser");

		const printCtx = makeMockContext(testTheme, { mode: "print", hasUI: true });
		expect(await openWorkerView(printCtx.ctx, mgr, "parser")).toBeUndefined();
		expect(printCtx.notifications[0]?.msg).toContain("[swarm worker] parser");
	});

	it("renders 1-line identity bar, Pi-native ScrollView/VStack/messages/tools, toggles Ctrl+O/Ctrl+T, and scrolls with follow-to-bottom", async () => {
		const { mgr, sessions, ctx } = await setupSwarmWithWorker();
		const session = sessions.get("parser")!;
		const tui = makeFakeTui(20);
		const done = vi.fn();

		const view = new SwarmWorkerViewComponent(tui, testTheme, testKeybindings, mgr, ctx, "parser", done, {
			throttleMs: 0,
		});

		// Uses Pi native ScrollView and VStack internally
		expect((view as unknown as { rootStack: unknown }).rootStack).toBeInstanceOf(VStack);
		expect((view as unknown as { transcript: { scrollView: unknown } }).transcript.scrollView).toBeInstanceOf(
			ScrollView,
		);

		// Stream a custom message, a long tool execution, and an assistant message with thinking
		session.emitEvent({
			type: "message_start",
			message: {
				role: "custom",
				customType: "note",
				content: "Custom note body",
				display: true,
				timestamp: Date.now(),
			},
		});
		const longLines = Array.from({ length: 20 }, (_, i) => `tool-line-${i + 1}`).join("\n");
		session.emitEvent({
			type: "tool_execution_start",
			toolCallId: "tc-read",
			toolName: "read",
			args: { path: "src/index.ts" },
		});
		session.emitEvent({
			type: "tool_execution_end",
			toolCallId: "tc-read",
			toolName: "read",
			result: { content: [{ type: "text", text: longLines }] },
			isError: false,
		});
		const assistantWithThinking: AgentMessage = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "SECRET_THOUGHT_STEP" },
				{ type: "text", text: "FINAL_ANSWER_LINE" },
			],
			api: "anthropic-messages",
			provider: "test-provider",
			model: "model-a",
			usage: { input: 10, output: 10, cacheRead: 0, cacheWrite: 0, totalTokens: 20, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
			stopReason: "stop",
			timestamp: Date.now(),
		};
		session.emitEvent({ type: "message_start", message: assistantWithThinking });
		session.emitEvent({ type: "message_end", message: assistantWithThinking });

		const initialPlain = view.render(100).map(stripTerminalSequences).join("\n");
		const firstLine = stripTerminalSequences(view.render(100)[0]!);
		expect(firstLine).toContain("[swarm worker] parser [waiting]");
		expect(initialPlain).toContain("FINAL_ANSWER_LINE");
		expect(initialPlain).toContain("SECRET_THOUGHT_STEP");
		// Native footer shows model id
		expect(initialPlain).toContain("model-a");

		// Ctrl+T hides thinking blocks
		view.handleInput("\x14");
		const hiddenThinkingPlain = view.render(100).map(stripTerminalSequences).join("\n");
		expect(hiddenThinkingPlain).not.toContain("SECRET_THOUGHT_STEP");

		// Ctrl+O expands tool output (shows later lines like tool-line-18)
		view.handleInput("\x0f");
		const expandedPlain = view.render(100).map(stripTerminalSequences).join("\n");
		expect(expandedPlain).toContain("tool-line-18");

		// Scrolling up with PgUp disables follow-to-bottom; wheel down returns to bottom
		const scrollView = (view as unknown as { transcript: { scrollView: ScrollView } }).transcript.scrollView;
		expect(scrollView.isFollowingEnd).toBe(true);
		view.handleInput("\x1b[5~"); // PageUp
		expect(scrollView.isFollowingEnd).toBe(false);
		view.handleMouse({
			type: "wheel",
			button: "none",
			x: 10,
			y: 5,
			screenX: 10,
			screenY: 5,
			width: 100,
			height: 20,
			shift: false,
			alt: false,
			ctrl: false,
			wheelDelta: 200,
		});
		expect(scrollView.isFollowingEnd).toBe(true);

		view.dispose();
	});

	it("renders fallback footer with workspace, usage, model, and bg info when stopped", async () => {
		const { dir, mgr, ctx } = await setupSwarmWithWorker();
		mgr.dispose();
		const stoppedMgr = SwarmManager.loadIfExists({
			sessionId: "s-view-1",
			cwd: dir,
			swarmDir: dir,
			sessionFactory: async (sctx) => new MockWorkerSession(sctx),
		})!;
		managersToDispose.push(stoppedMgr);
		stoppedMgr.updateHostContext(ctx);

		const tui = makeFakeTui(24);
		const view = new SwarmWorkerViewComponent(tui, testTheme, testKeybindings, stoppedMgr, ctx, "parser", vi.fn(), {
			throttleMs: 0,
		});

		const lines = view.render(100).map(stripTerminalSequences);
		const joined = lines.join("\n");
		expect(joined).toContain("[stopped]");
		expect(joined).toContain("$0.004");
		expect(joined).toContain("test-provider/model-a");
		view.dispose();
	});

	it("clips ANSI-styled user message lines cleanly on narrow viewports when scrollbar is visible", async () => {
		const { mgr, sessions, ctx } = await setupSwarmWithWorker();
		const session = sessions.get("parser")!;
		const view = new SwarmWorkerViewComponent(makeFakeTui(18), testTheme, testKeybindings, mgr, ctx, "parser", vi.fn(), {
			throttleMs: 0,
		});
		for (let i = 1; i <= 15; i++) {
			session.emitEvent({
				type: "message_start",
				message: {
					role: "user",
					content: [{ type: "text", text: `User message line ${i} with some extra text` }],
					timestamp: Date.now(),
				},
			});
		}

		// Initial render establishes ScrollView layout bounds; PgUp then reveals the auto scrollbar
		view.render(40);
		view.handleInput("\x1b[5~");
		const rawLines = view.render(40);
		const transcriptLines = rawLines.slice(1, rawLines.length - 5);
		const scrollbarLine = transcriptLines.find((l) => stripTerminalSequences(l).includes("User message"));
		expect(scrollbarLine).toBeDefined();
		expect(visibleWidth(scrollbarLine!)).toBeLessThanOrEqual(40);
		expect(scrollbarLine!).toMatch(/\x1b\[0m.*(?:│|┃)/);
		expect(stripTerminalSequences(scrollbarLine!)).toMatch(/(?:│|┃)$/);
		view.dispose();
	});
});

describe("SwarmWorkerViewComponent — Issue 03: Private Direct Chat, Steer/FollowUp, Auto-Resume & Killed Read-Only", () => {
	it("sends private direct prompts when waiting without posting to the swarm board", async () => {
		const { mgr, ctx } = await setupSwarmWithWorker();
		const headBefore = mgr.getBoard().head;
		const tui = makeFakeTui(24);
		const view = new SwarmWorkerViewComponent(tui, testTheme, testKeybindings, mgr, ctx, "parser", vi.fn(), {
			throttleMs: 0,
		});

		view.editor.setText("Private check-in");
		view.handleInput("\r");
		await new Promise((r) => setTimeout(r, 30));

		expect(mgr.getBoard().head).toBe(headBefore);
		const plain = view.render(100).map(stripTerminalSequences).join("\n");
		expect(plain).toContain("Private check-in");
		expect(plain).toContain("Reply: Private check-in");
		view.dispose();
	});

	it("queues steer on Enter and followUp on Alt+Enter while working and displays queued items above editor", async () => {
		const { mgr, sessions, ctx } = await setupSwarmWithWorker({ holdWorker: true });
		const tui = makeFakeTui(24);
		const view = new SwarmWorkerViewComponent(tui, testTheme, testKeybindings, mgr, ctx, "parser", vi.fn(), {
			throttleMs: 0,
		});

		// Worker is currently working (held)
		expect(mgr.getSnapshot().members.find((m) => m.name === "parser")?.state).toBe("working");

		view.editor.setText("Steer now");
		view.handleInput("\r");
		await new Promise((r) => setTimeout(r, 20));

		view.editor.setText("Follow up later");
		view.handleInput("\x1b\r"); // Alt+Enter
		await new Promise((r) => setTimeout(r, 20));

		const queuedPlain = view.render(100).map(stripTerminalSequences).join("\n");
		expect(queuedPlain).toContain("Steering: Steer now");
		expect(queuedPlain).toContain("Follow-up: Follow up later");

		// Release worker turn and verify queue clears cleanly
		const session = sessions.get("parser")!;
		session.clearQueue();
		session.emitEvent({ type: "queue_update", steering: [], followUp: [] });
		session.pendingResolve?.();
		await new Promise((r) => setTimeout(r, 20));

		const afterPlain = view.render(100).map(stripTerminalSequences).join("\n");
		expect(afterPlain).not.toContain("Steering: Steer now");
		view.dispose();
	});

	it("auto-resumes stopped worker on direct message and re-attaches live streaming", async () => {
		const { dir, mgr, ctx } = await setupSwarmWithWorker();
		mgr.dispose();
		const recovered = SwarmManager.loadIfExists({
			sessionId: "s-view-1",
			cwd: dir,
			swarmDir: dir,
			sessionFactory: async (sctx) => new MockWorkerSession(sctx),
		})!;
		managersToDispose.push(recovered);
		recovered.updateHostContext(ctx);
		expect(recovered.getWorkerSession("parser")).toBeUndefined();

		const tui = makeFakeTui(24);
		const view = new SwarmWorkerViewComponent(tui, testTheme, testKeybindings, recovered, ctx, "parser", vi.fn(), {
			throttleMs: 0,
		});

		view.editor.setText("Resume privately");
		view.handleInput("\r");
		await new Promise((r) => setTimeout(r, 40));

		expect(recovered.getWorkerSession("parser")).toBeDefined();
		const plain = view.render(100).map(stripTerminalSequences).join("\n");
		expect(plain).toContain("Reply: Resume privately");
		view.dispose();
	});

	it("keeps killed worker history browsable in read-only mode with editor disabled", async () => {
		const { mgr, ctx } = await setupSwarmWithWorker();
		await mgr.killWorkerByUser("parser");

		const tui = makeFakeTui(24);
		const view = new SwarmWorkerViewComponent(tui, testTheme, testKeybindings, mgr, ctx, "parser", vi.fn(), {
			throttleMs: 0,
		});

		const plain = view.render(100).map(stripTerminalSequences).join("\n");
		expect(plain).toContain("[read-only]");
		expect(plain).toContain("Analyze AST");
		expect(view.editor.disableSubmit).toBe(true);
		view.dispose();
	});
});

describe("SwarmWorkerViewComponent — Issue 04: Smart Esc, Ctrl+D, Alt+S & Single-Worker Abort Isolation", () => {
	it("Esc dismisses autocomplete or modal first, aborts only working worker, and exits when idle", async () => {
		const dir = makeTempDir("pi-swarm-esc-");
		const sessions = new Map<string, MockWorkerSession>();
		const { ctx } = makeMockContext(testTheme);
		const mgr = new SwarmManager({
			sessionId: "s-esc-1",
			cwd: dir,
			swarmDir: dir,
			sessionFactory: async (sctx) => {
				const hold = sctx.member.name === "worker-a" || sctx.member.name === "worker-b";
				const s = new MockWorkerSession(sctx, { holdNextPrompt: hold });
				sessions.set(sctx.member.name, s);
				return s;
			},
		});
		managersToDispose.push(mgr);
		mgr.updateHostContext(ctx);
		await mgr.addWorkers({ name: "worker-a", brief: "Task A" }, "coordinator", ctx);
		await mgr.addWorkers({ name: "worker-b", brief: "Task B" }, "coordinator", ctx);
		await new Promise((r) => setTimeout(r, 30));

		const done = vi.fn();
		const view = new SwarmWorkerViewComponent(makeFakeTui(24), testTheme, testKeybindings, mgr, ctx, "worker-a", done, {
			throttleMs: 0,
		});

		// 1. Open autocomplete by typing '/'
		view.handleInput("/");
		await new Promise((r) => setTimeout(r, 20));
		expect(view.editor.isShowingAutocomplete()).toBe(true);

		// Esc dismisses autocomplete WITHOUT aborting worker-a or exiting
		view.handleInput("\x1b");
		expect(view.editor.isShowingAutocomplete()).toBe(false);
		expect(sessions.get("worker-a")!.abortedCount).toBe(0);
		expect(done).not.toHaveBeenCalled();

		// 2. Esc with no modal/autocomplete while working aborts ONLY worker-a, stays open
		view.handleInput("\x1b");
		await new Promise((r) => setTimeout(r, 25));
		expect(sessions.get("worker-a")!.abortedCount).toBe(1);
		expect(sessions.get("worker-b")!.abortedCount).toBe(0);
		expect(mgr.getSnapshot().members.find((m) => m.name === "worker-b")?.state).toBe("working");
		expect(done).not.toHaveBeenCalled();

		// 3. Esc while idle exits directly to Coordinator
		view.handleInput("\x1b");
		expect(done).toHaveBeenCalledWith(undefined);
	});

	it("Ctrl+D exits and Alt+S switches to Swarm Overlay without interrupting a working worker", async () => {
		const { mgr, sessions, ctx } = await setupSwarmWithWorker({ holdWorker: true });
		const doneCtrlD = vi.fn();
		const view1 = new SwarmWorkerViewComponent(
			makeFakeTui(24),
			testTheme,
			testKeybindings,
			mgr,
			ctx,
			"parser",
			doneCtrlD,
			{ throttleMs: 0 },
		);
		view1.handleInput("\x04"); // Ctrl+D
		expect(doneCtrlD).toHaveBeenCalledWith(undefined);
		expect(sessions.get("parser")!.abortedCount).toBe(0);
		expect(mgr.getSnapshot().members.find((m) => m.name === "parser")?.state).toBe("working");

		const doneAltS = vi.fn();
		const view2 = new SwarmWorkerViewComponent(
			makeFakeTui(24),
			testTheme,
			testKeybindings,
			mgr,
			ctx,
			"parser",
			doneAltS,
			{ throttleMs: 0, returnTab: "overview" },
		);
		view2.handleInput("\x1bs"); // Alt+S
		expect(doneAltS).toHaveBeenCalledWith({ kind: "open_overlay", tab: "overview" });
		expect(sessions.get("parser")!.abortedCount).toBe(0);
	});
});

describe("SwarmWorkerViewComponent — Issue 05: Slash Commands & CombinedAutocompleteProvider", () => {
	it("registers only /model, /abort, /kill, /exit in autocomplete and rejects /board or unknown commands locally", async () => {
		const { mgr, ctx } = await setupSwarmWithWorker();
		const headBefore = mgr.getBoard().head;
		const view = new SwarmWorkerViewComponent(makeFakeTui(24), testTheme, testKeybindings, mgr, ctx, "parser", vi.fn(), {
			throttleMs: 0,
		});

		view.handleInput("/");
		await new Promise((r) => setTimeout(r, 20));
		const rendered = view.render(100).map(stripTerminalSequences).join("\n");
		expect(rendered).toContain("model");
		expect(rendered).toContain("abort");
		expect(rendered).toContain("kill");
		expect(rendered).toContain("exit");
		expect(rendered).not.toContain("/board");
		expect(rendered).not.toContain("/compact");

		view.handleInput("\x1b"); // close autocomplete
		view.editor.setText("/board hello world");
		view.handleInput("\r");
		await new Promise((r) => setTimeout(r, 20));
		expect(mgr.getBoard().head).toBe(headBefore);
		expect(view.render(100).map(stripTerminalSequences).join("\n")).toContain('Unknown command "/board"');
		view.dispose();
	});

	it("executes /model (blocks while working, applies on waiting), /abort, /kill (cancel + confirm), and /exit", async () => {
		const { mgr, sessions, ctx } = await setupSwarmWithWorker({ holdWorker: true });
		const done = vi.fn();
		const view = new SwarmWorkerViewComponent(makeFakeTui(24), testTheme, testKeybindings, mgr, ctx, "parser", done, {
			throttleMs: 0,
		});

		// /model blocked while working
		view.editor.setText("/model");
		view.handleInput("\r");
		expect(view.render(100).map(stripTerminalSequences).join("\n")).toContain("while worker");

		// /abort aborts working worker
		view.editor.setText("/abort");
		view.handleInput("\r");
		await new Promise((r) => setTimeout(r, 25));
		expect(sessions.get("parser")!.abortedCount).toBe(1);

		// /abort when idle shows non-error idle notice
		view.editor.setText("/abort");
		view.handleInput("\r");
		await new Promise((r) => setTimeout(r, 15));
		expect(view.render(100).map(stripTerminalSequences).join("\n")).toContain("already idle");

		// /model opens picker when waiting; Esc cancels; Enter applies model-b
		view.editor.setText("/model");
		view.handleInput("\r");
		expect(view.render(100).map(stripTerminalSequences).join("\n")).toContain('Switch model for "parser"');
		view.handleInput("\x1b"); // cancel modal without exiting view
		expect(done).not.toHaveBeenCalled();

		view.editor.setText("/model");
		view.handleInput("\r");
		view.handleInput("\x1b[B"); // Down to model-b (current model-a is first)
		view.handleInput("\r");
		await new Promise((r) => setTimeout(r, 30));
		expect(mgr.getSnapshot().members.find((m) => m.name === "parser")?.model).toBe("test-provider/model-b");
		// Native FooterComponent updates live to reflect the switched model
		const afterModelPlain = view.render(100).map(stripTerminalSequences).join("\n");
		expect(afterModelPlain).toContain("model-b");
		expect(afterModelPlain).not.toContain("model-a");

		// /kill prompts confirmation; 'n' cancels; 'y' confirms and switches to read-only
		view.editor.setText("/kill");
		view.handleInput("\r");
		expect(view.render(100).map(stripTerminalSequences).join("\n")).toContain('Kill worker "parser"?');
		view.handleInput("n");
		expect(mgr.getSnapshot().members.find((m) => m.name === "parser")?.state).toBe("waiting");

		view.editor.setText("/kill");
		view.handleInput("\r");
		view.handleInput("y");
		await new Promise((r) => setTimeout(r, 30));
		expect(mgr.getSnapshot().members.find((m) => m.name === "parser")?.state).toBe("killed");
		expect(view.render(100).map(stripTerminalSequences).join("\n")).toContain("[read-only]");

		// /exit returns to Coordinator (test on a fresh view)
		const doneExit = vi.fn();
		const { mgr: mgr2, ctx: ctx2 } = await setupSwarmWithWorker({ holdWorker: true });
		const view2 = new SwarmWorkerViewComponent(makeFakeTui(24), testTheme, testKeybindings, mgr2, ctx2, "parser", doneExit, {
			throttleMs: 0,
		});
		view2.editor.setText("/exit");
		view2.handleInput("\r");
		expect(doneExit).toHaveBeenCalledWith(undefined);
		expect(mgr2.getSnapshot().members.find((m) => m.name === "parser")?.state).toBe("working");
		view.dispose();
	});

	it("clears queued steering/followUp banner on Esc abort and dismisses autocomplete/modal if killed externally", async () => {
		const { mgr, ctx } = await setupSwarmWithWorker({ holdWorker: true });
		const view = new SwarmWorkerViewComponent(makeFakeTui(24), testTheme, testKeybindings, mgr, ctx, "parser", vi.fn(), {
			throttleMs: 0,
		});

		view.editor.setText("Pending steer");
		view.handleInput("\r");
		await new Promise((r) => setTimeout(r, 20));
		expect(view.render(100).map(stripTerminalSequences).join("\n")).toContain("Steering: Pending steer");

		// Esc aborts working worker and clears queued steering display immediately
		view.handleInput("\x1b");
		await new Promise((r) => setTimeout(r, 25));
		const afterAbort = view.render(100).map(stripTerminalSequences).join("\n");
		expect(afterAbort).not.toContain("Steering: Pending steer");
		expect(afterAbort).toContain("[waiting]");

		// Open autocomplete, then kill worker externally -> autocomplete dismisses & PgUp scrolling works
		view.handleInput("/");
		await new Promise((r) => setTimeout(r, 20));
		expect(view.editor.isShowingAutocomplete()).toBe(true);

		await mgr.killWorkerByUser("parser");
		expect(view.editor.isShowingAutocomplete()).toBe(false);
		expect(view.render(100).map(stripTerminalSequences).join("\n")).toContain("[read-only]");
		view.dispose();
	});

	it("does not requestRender after closed via fallback Escape or mutate status after closed mid-abort", async () => {
		const { mgr, ctx } = await setupSwarmWithWorker({ holdWorker: false });
		const tui = makeFakeTui(24);
		const minimalKeybindings = { matches: () => false } as unknown as typeof testKeybindings;
		const done = vi.fn();
		const view = new SwarmWorkerViewComponent(tui, testTheme, minimalKeybindings, mgr, ctx, "parser", done, {
			throttleMs: 0,
		});

		const rendersBeforeEsc = (tui.requestRender as ReturnType<typeof vi.fn>).mock.calls.length;
		view.handleInput("\x1b");
		expect(done).toHaveBeenCalledWith(undefined);
		expect((tui.requestRender as ReturnType<typeof vi.fn>).mock.calls.length).toBe(rendersBeforeEsc);

		const { mgr: mgr2, ctx: ctx2 } = await setupSwarmWithWorker({ holdWorker: true });
		let releaseAbort: (() => void) | undefined;
		const origAbort = mgr2.abortWorkerByUser.bind(mgr2);
		mgr2.abortWorkerByUser = async (name: string) => {
			await new Promise<void>((resolve) => {
				releaseAbort = resolve;
			});
			return origAbort(name);
		};
		const tui2 = makeFakeTui(24);
		const done2 = vi.fn();
		const view2 = new SwarmWorkerViewComponent(tui2, testTheme, testKeybindings, mgr2, ctx2, "parser", done2, {
			throttleMs: 0,
		});
		view2.editor.setText("/abort");
		view2.handleInput("\r");
		for (let i = 0; i < 20 && !releaseAbort; i++) {
			await new Promise((r) => setTimeout(r, 5));
		}
		expect(releaseAbort).toBeDefined();
		const rendersAtClose = (tui2.requestRender as ReturnType<typeof vi.fn>).mock.calls.length;
		view2.handleInput("\x04"); // Ctrl+D closes view mid-abort
		expect(done2).toHaveBeenCalledWith(undefined);
		releaseAbort!();
		await new Promise((r) => setTimeout(r, 25));
		expect((tui2.requestRender as ReturnType<typeof vi.fn>).mock.calls.length).toBe(rendersAtClose);
	});
});

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	type AgentSessionEventListener,
	type ExtensionContext,
	SessionManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, stripTerminalSequences, type TUI, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
	type CreateWorkerSessionContext,
	SwarmManager,
	type WorkerSessionHandle,
} from "../src/runtime.ts";
import {
	openSwarmOverlay,
	renderSwarmWidgetLines,
	SwarmOverlayComponent,
	type SwarmOverlayResult,
	SwarmWidgetComponent,
	SwarmWidgetController,
} from "../src/ui.ts";

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
	private readonly listeners = new Set<AgentSessionEventListener>();
	private activeTools = ["read", "bash", "swarm", "post_message", "read_board", "swarm_wait"];

	constructor(context: CreateWorkerSessionContext) {
		this.model = context.model ?? makeModel();
		this.sessionFile = context.member.sessionFile;
		const workersDir = join(context.swarmDir, "workers");
		mkdirSync(workersDir, { recursive: true });
		this.sessionManager = SessionManager.open(context.member.sessionFile, workersDir, context.member.workspacePath);
		this.sessionId = this.sessionManager.getSessionId();
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

	async prompt(text: string): Promise<void> {
		this.isStreaming = true;
		this.isIdle = false;
		this.messages.push({
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		});
		this.emit({ type: "agent_start" });
		this.emit({
			type: "tool_execution_start",
			toolCallId: "tc-1",
			toolName: "read",
			args: { path: "src/app.ts" },
		});
		this.emit({
			type: "tool_execution_end",
			toolCallId: "tc-1",
			toolName: "read",
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
		const assistant: AgentMessage = {
			role: "assistant",
			content: [{ type: "text", text: `Processed: ${text.slice(0, 32)}` }],
			api: "anthropic-messages",
			provider: this.model?.provider ?? "test-provider",
			model: this.model?.id ?? "model-a",
			usage: {
				input: 1200,
				output: 300,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 1500,
				cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.015 },
			},
			stopReason: "stop",
			timestamp: Date.now(),
		};
		this.messages.push(assistant);
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

function makeFakeTui(rows = 32): TUI {
	return {
		terminal: { rows, columns: 120 },
		requestRender: vi.fn(),
	} as unknown as TUI;
}

function makeMockContext(
	theme: Theme,
	options: {
		mode?: ExtensionContext["mode"];
		hasUI?: boolean;
		models?: Model<Api>[];
		scopedModels?: Array<{ model: Model<Api> }>;
	} = {},
): {
	ctx: ExtensionContext;
	notifications: Array<{ msg: string; type?: string }>;
	widgets: Map<string, unknown>;
	editorText: { value: string };
} {
	const notifications: Array<{ msg: string; type?: string }> = [];
	const widgets = new Map<string, unknown>();
	const editorText = { value: "" };
	const models = options.models ?? [makeModel("test-provider", "model-a"), makeModel("test-provider", "model-b")];

	const ctx = {
		mode: options.mode ?? "tui",
		hasUI: options.hasUI ?? true,
		cwd: process.cwd(),
		model: models[0],
		scopedModels: options.scopedModels ?? models.map((m) => ({ model: m })),
		modelRegistry: {
			getAvailable: () => models,
			find: (p: string, id: string) => models.find((m) => m.provider === p && m.id === id),
			hasConfiguredAuth: () => true,
		},
		sessionManager: {
			getSessionId: () => "ui-test-session",
			getBranch: () => [],
			getSessionFile: () => undefined,
		},
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
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
			setWidget: (key: string, content: unknown) => {
				widgets.set(key, content);
			},
			setEditorText: (text: string) => {
				editorText.value = text;
			},
			getEditorText: () => editorText.value,
			custom: vi.fn(async () => undefined),
		},
	} as unknown as ExtensionContext;

	return { ctx, notifications, widgets, editorText };
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

let testTheme: Theme;
let testKeybindings: KeybindingsManager;

beforeAll(() => {
	testTheme = createTestTheme();
	testKeybindings = new KeybindingsManager(TUI_KEYBINDINGS);
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

describe("Swarm TUI widget & summary", () => {
	it("renders empty when inactive, coordinator-only when active, and full worker status when swarm exists", async () => {
		expect(renderSwarmWidgetLines(undefined, testTheme, 80, false)).toEqual([]);

		const coordOnly = renderSwarmWidgetLines(undefined, testTheme, 80, true);
		expect(coordOnly.length).toBe(1);
		expect(stripTerminalSequences(coordOnly[0])).toContain("Coordinator active");
		expect(stripTerminalSequences(coordOnly[0])).toContain("Alt+S");

		const dir = makeTempDir("pi-swarm-ui-");
		const sessions = new Map<string, MockWorkerSession>();
		const mgr = new SwarmManager({
			sessionId: "s-ui-1",
			cwd: dir,
			swarmDir: dir,
			title: "Parser Rewrite",
			sessionFactory: async (ctx) => {
				const s = new MockWorkerSession(ctx);
				sessions.set(ctx.member.name, s);
				return s;
			},
		});
		managersToDispose.push(mgr);

		const { ctx } = makeMockContext(testTheme);
		mgr.updateHostContext(ctx);
		await mgr.addWorkers({ name: "parser", brief: "Fix parser bugs" }, "coordinator", ctx);
		await new Promise((r) => setTimeout(r, 30));

		const snap = mgr.getSnapshot();
		const lines = renderSwarmWidgetLines(snap, testTheme, 72, true);
		const plain = lines.map((l) => stripTerminalSequences(l)).join("\n");
		expect(plain).toContain("Parser Rewrite");
		expect(plain).toContain("parser");
		expect(plain).toContain("waiting");
		expect(plain).toContain("$0.015");
		expect(plain).toContain("Alt+S");
		for (const line of lines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(72);
		}
	});

	it("throttles live widget redraws on rapid SwarmManager updates", async () => {
		vi.useFakeTimers();
		const dir = makeTempDir("pi-swarm-widget-throttle-");
		const mgr = new SwarmManager({
			sessionId: "s-throttle",
			cwd: dir,
			swarmDir: dir,
			title: "Throttle Test",
			sessionFactory: async (ctx) => new MockWorkerSession(ctx),
		});
		managersToDispose.push(mgr);

		const tui = makeFakeTui();
		const widget = new SwarmWidgetComponent({
			tui,
			theme: testTheme,
			manager: mgr,
			throttleMs: 80,
		});

		mgr.setTitle("Title 1");
		mgr.setTitle("Title 2");
		mgr.setTitle("Title 3");
		// First change triggers immediate render, subsequent rapid changes coalesce into one trailing render
		expect((tui.requestRender as ReturnType<typeof vi.fn>).mock.calls.length).toBe(1);

		vi.advanceTimersByTime(100);
		expect((tui.requestRender as ReturnType<typeof vi.fn>).mock.calls.length).toBe(2);

		const firstRender = widget.render(80);
		const secondRender = widget.render(80);
		expect(secondRender).toBe(firstRender); // Cached by width until invalidated

		widget.dispose();
	});
});

describe("SwarmOverlayComponent", () => {
	async function setupSwarm() {
		const dir = makeTempDir("pi-swarm-overlay-");
		const sessions = new Map<string, MockWorkerSession>();
		const mgr = new SwarmManager({
			sessionId: "s-overlay",
			cwd: dir,
			swarmDir: dir,
			title: "Overlay Swarm",
			sessionFactory: async (ctx) => {
				const s = new MockWorkerSession(ctx);
				sessions.set(ctx.member.name, s);
				return s;
			},
		});
		managersToDispose.push(mgr);
		const mockCtx = makeMockContext(testTheme);
		mgr.updateHostContext(mockCtx.ctx);
		mgr.handleChannelOp({ op: "create", channel: "parser", topic: "Parser work" }, "coordinator");
		await mgr.addWorkers({ name: "parser", brief: "Fix lexer", channels: ["parser"] }, "coordinator", mockCtx.ctx);
		await mgr.addWorkers({ name: "verifier", brief: "Verify fixes" }, "coordinator", mockCtx.ctx);
		await new Promise((r) => setTimeout(r, 30));
		mgr.postMessage("parser", "@coordinator [done] Fixed #1", "parser");
		mgr.postMessage("coordinator", "@verifier check #3", "main");
		await new Promise((r) => setTimeout(r, 30));
		return { mgr, sessions, ctx: mockCtx.ctx };
	}

	it("renders Overview fallback when no plan.json exists and renders plan.json when published", async () => {
		const { mgr, ctx } = await setupSwarm();
		const tui = makeFakeTui(30);
		const done = vi.fn<(r: SwarmOverlayResult | undefined) => void>();
		const overlay = new SwarmOverlayComponent(tui, testTheme, testKeybindings, mgr, ctx, done);

		// Fallback without plan.json
		let plain = overlay.render(100).map((l) => stripTerminalSequences(l)).join("\n");
		expect(plain).toContain("No plan.json published yet");
		expect(plain).toContain("#parser");
		expect(plain).toContain("verifier");

		// Publish plan.json
		mgr.setPlan({
			goal: { title: "Ship parser and verifier", line: "Fix lexer and verify all cases." },
			tasks: { parser: "Fix lexer edge cases", verifier: "Verify lexer diff and tests" },
			threads: [
				{
					id: "t-core",
					title: "Core parser fix",
					goal: "Lexer passes all tests",
					tasks: ["parser", "verifier"],
				},
			],
		});
		overlay.invalidate();
		plain = overlay.render(100).map((l) => stripTerminalSequences(l)).join("\n");
		expect(plain).toContain("Ship parser and verifier");
		expect(plain).toContain("Core parser fix");
		expect(plain).toContain("Fix lexer edge cases");

		for (const line of overlay.render(100)) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(100);
		}
		overlay.dispose();
	});

	it("supports tab switching, Board filters (c/m), and prefill #seq on r/Enter", async () => {
		const { mgr, ctx } = await setupSwarm();
		const tui = makeFakeTui(30);
		const done = vi.fn<(r: SwarmOverlayResult | undefined) => void>();
		const overlay = new SwarmOverlayComponent(tui, testTheme, testKeybindings, mgr, ctx, done);

		// Switch to Board tab via '2'
		overlay.handleInput("2");
		let plain = overlay.render(100).map((l) => stripTerminalSequences(l)).join("\n");
		expect(plain).toContain("Channel (c): all");
		expect(plain).toContain("Fixed #1");

		// Cycle channel filter ('c' -> main -> parser)
		overlay.handleInput("c");
		plain = overlay.render(100).map((l) => stripTerminalSequences(l)).join("\n");
		expect(plain).toContain("Channel (c): #main");

		overlay.handleInput("c");
		plain = overlay.render(100).map((l) => stripTerminalSequences(l)).join("\n");
		expect(plain).toContain("Channel (c): #parser");
		expect(plain).toContain("Fixed #1");

		// Cycle member filter ('m' -> coordinator -> parser)
		overlay.handleInput("m");
		overlay.handleInput("m");
		plain = overlay.render(100).map((l) => stripTerminalSequences(l)).join("\n");
		expect(plain).toContain("Member (m): parser");

		// Press 'r' on selected message to prefill #seq
		overlay.handleInput("r");
		expect(done).toHaveBeenCalledTimes(1);
		expect(done.mock.calls[0][0]?.kind).toBe("prefill");
		expect(done.mock.calls[0][0]?.text).toMatch(/^#\d+ $/);

		overlay.dispose();
	});

	it("supports Workers tab transcript inspection, kill confirmation (k), model switch (M), stop all (S), and Esc/q close", async () => {
		const { mgr, ctx } = await setupSwarm();
		const tui = makeFakeTui(34);
		const done = vi.fn<(r: SwarmOverlayResult | undefined) => void>();
		const overlay = new SwarmOverlayComponent(tui, testTheme, testKeybindings, mgr, ctx, done, {
			initialTab: "workers",
		});

		let plain = overlay.render(110).map((l) => stripTerminalSequences(l)).join("\n");
		expect(plain).toContain("parser");
		expect(plain).toContain("verifier");
		expect(plain).toContain("[assistant] Processed:");

		// Switch model via 'M', move down to model-b, press Enter
		overlay.handleInput("M");
		plain = overlay.render(110).map((l) => stripTerminalSequences(l)).join("\n");
		expect(plain).toContain('Switch model for "parser"');
		overlay.handleInput("\x1b[B"); // Down arrow
		overlay.handleInput("\r"); // Enter
		await new Promise((r) => setTimeout(r, 20));
		expect(mgr.getBoard().getMember("parser")?.model).toBe("test-provider/model-b");

		// Kill confirmation: 'k' then 'n' cancels
		overlay.handleInput("k");
		plain = overlay.render(110).map((l) => stripTerminalSequences(l)).join("\n");
		expect(plain).toContain('Kill worker "parser"?');
		overlay.handleInput("n");
		expect(mgr.getBoard().getMember("parser")?.state).not.toBe("killed");

		// Kill confirmation: 'k' then 'y' kills
		overlay.handleInput("k");
		overlay.handleInput("y");
		await new Promise((r) => setTimeout(r, 20));
		expect(mgr.getBoard().getMember("parser")?.state).toBe("killed");

		// Stop all via 'S'
		overlay.handleInput("S");
		await new Promise((r) => setTimeout(r, 20));

		// Close via 'q'
		overlay.handleInput("q");
		expect(done).toHaveBeenCalledWith(undefined);
		overlay.dispose();
	});
});

describe("Non-TUI fallback and WidgetController", () => {
	it("prints plain summary without crashing when !ctx.hasUI or ctx.mode === 'rpc'", async () => {
		const dir = makeTempDir("pi-swarm-nontui-");
		const mgr = new SwarmManager({
			sessionId: "s-nontui",
			cwd: dir,
			swarmDir: dir,
			title: "Headless Swarm",
		});
		managersToDispose.push(mgr);
		mgr.postMessage("coordinator", "Hello @all", "main");

		const printFallback: string[] = [];
		const printMock = makeMockContext(testTheme, { mode: "print", hasUI: false });
		await openSwarmOverlay(printMock.ctx, mgr, {
			writeFallback: (text) => printFallback.push(text),
		});
		expect(printFallback.length).toBe(1);
		expect(printFallback[0]).toContain("Headless Swarm");
		expect(printFallback[0]).toContain("Hello @all");

		const rpcMock = makeMockContext(testTheme, { mode: "rpc", hasUI: true });
		await openSwarmOverlay(rpcMock.ctx, mgr);
		expect(rpcMock.notifications.length).toBe(1);
		expect(rpcMock.notifications[0].msg).toContain("Headless Swarm");

		const controller = new SwarmWidgetController({
			getManager: () => mgr,
			isCoordinatorActive: () => true,
		});
		controller.refresh(rpcMock.ctx);
		expect(Array.isArray(rpcMock.widgets.get("pi-swarm"))).toBe(true);
		controller.dispose();
	});

	it("applies editor prefill when openSwarmOverlay resolves in TUI mode", async () => {
		const dir = makeTempDir("pi-swarm-prefill-");
		const mgr = new SwarmManager({
			sessionId: "s-prefill",
			cwd: dir,
			swarmDir: dir,
			title: "Prefill Swarm",
		});
		managersToDispose.push(mgr);
		const tuiMock = makeMockContext(testTheme, { mode: "tui", hasUI: true });
		(tuiMock.ctx.ui.custom as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
			kind: "prefill",
			text: "#42 ",
		} satisfies SwarmOverlayResult);

		await openSwarmOverlay(tuiMock.ctx, mgr);
		expect(tuiMock.editorText.value).toBe("#42 ");
	});
});

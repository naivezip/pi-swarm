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
	type SwarmSnapshot,
	type WorkerSessionHandle,
} from "../src/runtime.ts";
import type { BackgroundProcessSummary } from "../src/types.ts";
import {
	formatDurationShort,
	openSwarmOverlay,
	renderSwarmPlainSummary,
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
		const prefillRes = done.mock.calls[0][0];
		expect(prefillRes?.kind).toBe("prefill");
		if (prefillRes?.kind === "prefill") {
			expect(prefillRes.text).toMatch(/^#\d+ $/);
		}

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

		// Move selection down to verifier and press Enter -> opens worker view from Workers tab
		overlay.handleInput("\x1b[B"); // Down arrow -> verifier
		overlay.handleInput("\r"); // Enter
		expect(done).toHaveBeenCalledWith({
			kind: "open_worker",
			workerName: "verifier",
			returnTab: "workers",
		});

		// Footer hint includes Enter open
		expect(plain).toContain("Enter open");

		// Close via 'q'
		overlay.handleInput("q");
		expect(done).toHaveBeenCalledWith(undefined);
		overlay.dispose();
	});

	it("selects real workers in Overview (published plan + unassigned + no-plan), skips '?' placeholders, auto-scrolls, and handles Enter", async () => {
		const { mgr, ctx } = await setupSwarm();
		await mgr.addWorkers({ name: "extra", brief: "Extra unassigned work" }, "coordinator", ctx);
		await new Promise((r) => setTimeout(r, 30));

		const tui = makeFakeTui(28);
		const done = vi.fn<(r: SwarmOverlayResult | undefined) => void>();
		const overlay = new SwarmOverlayComponent(tui, testTheme, testKeybindings, mgr, ctx, done, {
			initialTab: "overview",
		});

		// 1. No-plan fallback roster: Up/Down moves cursor across real workers and Enter opens selected
		let plain = overlay.render(110).map((l) => stripTerminalSequences(l)).join("\n");
		expect(plain).toContain("Enter open worker");
		expect(plain).toMatch(/>\s+o\s+parser/);
		overlay.handleInput("\x1b[B"); // Down -> verifier
		plain = overlay.render(110).map((l) => stripTerminalSequences(l)).join("\n");
		expect(plain).toMatch(/>\s+o\s+verifier/);
		overlay.handleInput("\r"); // Enter -> open verifier
		expect(done).toHaveBeenLastCalledWith({
			kind: "open_worker",
			workerName: "verifier",
			returnTab: "overview",
		});

		// 2. Published plan with '?' placeholders + unassigned section: skips '?' rows
		mgr.setPlan({
			goal: { title: "Multi-thread plan", line: "Verify cursor skipping and unassigned workers." },
			tasks: {
				"ghost-1": "Not yet created",
				parser: "Parse input",
				"ghost-2": "Also not created",
				verifier: "Check output",
				extra: "Unassigned helper",
			},
			threads: [
				{
					id: "t-1",
					title: "Thread One",
					goal: "First thread",
					tasks: ["ghost-1", "parser", "ghost-2", "verifier"],
				},
			],
		});
		overlay.invalidate();
		plain = overlay.render(110).map((l) => stripTerminalSequences(l)).join("\n");
		// Selected worker remains verifier; ghost rows never get '>' cursor
		expect(plain).toMatch(/\s+\?\s+ghost-1/);
		expect(plain).toMatch(/\s+\?\s+ghost-2/);
		expect(plain).not.toMatch(/>\s+\?\s+ghost/);
		expect(plain).toMatch(/>\s+o\s+verifier/);

		// Down from verifier crosses into Unassigned workers ('extra'), Up skips ghost-2 back to 'parser'
		overlay.handleInput("\x1b[B"); // Down -> extra
		plain = overlay.render(110).map((l) => stripTerminalSequences(l)).join("\n");
		expect(plain).toMatch(/>\s+o\s+extra/);
		overlay.handleInput("\r");
		expect(done).toHaveBeenLastCalledWith({
			kind: "open_worker",
			workerName: "extra",
			returnTab: "overview",
		});

		overlay.handleInput("\x1b[A"); // Up -> verifier
		overlay.handleInput("\x1b[A"); // Up -> parser (skips ghost-2)
		plain = overlay.render(110).map((l) => stripTerminalSequences(l)).join("\n");
		expect(plain).toMatch(/>\s+o\s+parser/);
		overlay.handleInput("\r");
		expect(done).toHaveBeenLastCalledWith({
			kind: "open_worker",
			workerName: "parser",
			returnTab: "overview",
		});

		overlay.dispose();
	});

	it("auto-scrolls Overview viewport to keep selected worker visible while preserving PgUp/PgDn and empty-roster scroll fallback", async () => {
		const dir = makeTempDir("pi-swarm-overview-scroll-");
		const mgr = new SwarmManager({
			sessionId: "s-scroll",
			cwd: dir,
			swarmDir: dir,
			title: "Scroll Swarm",
			sessionFactory: async (ctx) => new MockWorkerSession(ctx),
		});
		managersToDispose.push(mgr);
		const mockCtx = makeMockContext(testTheme);
		mgr.updateHostContext(mockCtx.ctx);

		// Case A: zero real workers (only '?' planned placeholders) -> Up/Down scrolls, Enter is no-op
		mgr.setPlan({
			goal: { title: "Planned Only", line: "Many threads before workers are created" },
			tasks: {},
			threads: Array.from({ length: 10 }, (_, i) => ({
				id: `t-${i}`,
				title: `Thread ${i}`,
				goal: `Goal ${i}`,
				tasks: [`future-${i}`],
			})),
		});
		const smallTui = makeFakeTui(18); // bodyHeight = 12
		const doneEmpty = vi.fn<(r: SwarmOverlayResult | undefined) => void>();
		const emptyOverlay = new SwarmOverlayComponent(smallTui, testTheme, testKeybindings, mgr, mockCtx.ctx, doneEmpty);

		const topPlain = emptyOverlay.render(100).map((l) => stripTerminalSequences(l)).join("\n");
		expect(topPlain).toContain("Thread 0");
		expect(topPlain).not.toContain("Thread 8");

		for (let i = 0; i < 10; i++) {
			emptyOverlay.handleInput("\x1b[B"); // Down scrolls when 0 real workers
		}
		const scrolledPlain = emptyOverlay.render(100).map((l) => stripTerminalSequences(l)).join("\n");
		expect(scrolledPlain).toContain("Thread 4");
		emptyOverlay.handleInput("\r"); // Safe no-op
		expect(doneEmpty).not.toHaveBeenCalled();
		emptyOverlay.dispose();

		// Case B: many real workers -> Down auto-scrolls viewport down, PgUp/PgDn page-scrolls, Up scrolls back up
		for (let i = 0; i < 8; i++) {
			await mgr.addWorkers({ name: `worker-${i}`, brief: `Task ${i}` }, "coordinator", mockCtx.ctx);
		}
		await new Promise((r) => setTimeout(r, 30));
		mgr.setPlan({
			goal: { title: "Scrollable Plan", line: "Verify auto-scroll on cursor movement" },
			tasks: Object.fromEntries(Array.from({ length: 8 }, (_, i) => [`worker-${i}`, `Task ${i}`])),
			threads: Array.from({ length: 8 }, (_, i) => ({
				id: `t-${i}`,
				title: `Section ${i}`,
				goal: `Goal ${i}`,
				tasks: [`worker-${i}`],
			})),
		});

		const doneWorkers = vi.fn<(r: SwarmOverlayResult | undefined) => void>();
		const overlay = new SwarmOverlayComponent(smallTui, testTheme, testKeybindings, mgr, mockCtx.ctx, doneWorkers);

		// Initially worker-0 is visible at top, worker-7 is off-screen below
		let plain = overlay.render(100).map((l) => stripTerminalSequences(l)).join("\n");
		expect(plain).toMatch(/>\s+o\s+worker-0/);
		expect(plain).not.toContain("worker-7");

		// Press Down 7 times -> auto-scrolls viewport so worker-7 is visible and selected
		for (let i = 0; i < 7; i++) {
			overlay.handleInput("\x1b[B");
		}
		plain = overlay.render(100).map((l) => stripTerminalSequences(l)).join("\n");
		expect(plain).toMatch(/>\s+o\s+worker-7/);

		// PgUp scrolls viewport up toward top without resetting to worker-7
		overlay.handleInput("\x1b[5~"); // PageUp
		overlay.handleInput("\x1b[5~"); // PageUp
		overlay.handleInput("\x1b[5~"); // PageUp
		plain = overlay.render(100).map((l) => stripTerminalSequences(l)).join("\n");
		expect(plain).toContain("Scrollable Plan");
		expect(plain).not.toContain("worker-7");

		// PgDn scrolls back down
		overlay.handleInput("\x1b[6~"); // PageDown
		plain = overlay.render(100).map((l) => stripTerminalSequences(l)).join("\n");
		expect(plain).not.toContain("Scrollable Plan");

		// Press Up 7 times from worker-7 -> auto-scrolls back up to keep worker-0 visible
		for (let i = 0; i < 7; i++) {
			overlay.handleInput("\x1b[A");
		}
		plain = overlay.render(100).map((l) => stripTerminalSequences(l)).join("\n");
		expect(plain).toMatch(/>\s+o\s+worker-0/);

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

	it("loops cleanly between SwarmOverlay and WorkerView and exits to Coordinator on undefined", async () => {
		const dir = makeTempDir("pi-swarm-loop-");
		const mgr = new SwarmManager({
			sessionId: "s-loop",
			cwd: dir,
			swarmDir: dir,
			title: "Transition Loop Swarm",
		});
		managersToDispose.push(mgr);
		const tuiMock = makeMockContext(testTheme, { mode: "tui", hasUI: true });
		const seenInitialTabs: Array<string | undefined> = [];

		const customMock = tuiMock.ctx.ui.custom as ReturnType<typeof vi.fn>;
		customMock.mockImplementation(async (factory) => {
			// Inspect the initialTab wired into SwarmOverlayComponent
			const comp = factory(makeFakeTui(30), testTheme, testKeybindings, vi.fn()) as SwarmOverlayComponent;
			const rendered = comp.render(100).map((l) => stripTerminalSequences(l)).join("\n");
			if (rendered.includes("1-3/Tab/Left/Right tabs")) {
				seenInitialTabs.push("overview");
			} else if (rendered.includes("Up/Down worker")) {
				seenInitialTabs.push("workers");
			} else {
				seenInitialTabs.push("board");
			}
			comp.dispose();

			if (customMock.mock.calls.length === 1) {
				return { kind: "open_worker", workerName: "parser", returnTab: "overview" } satisfies SwarmOverlayResult;
			}
			if (customMock.mock.calls.length === 2) {
				return { kind: "open_worker", workerName: "verifier", returnTab: "workers" } satisfies SwarmOverlayResult;
			}
			return undefined;
		});

		const openWorkerView = vi
			.fn()
			.mockResolvedValueOnce({ kind: "open_overlay" }) // restores returnTab ("overview")
			.mockResolvedValueOnce({ kind: "open_overlay", tab: "workers" }); // opens explicit tab ("workers")

		const res1 = await openSwarmOverlay(tuiMock.ctx, mgr, {
			initialTab: "overview",
			openWorkerView,
		});
		expect(res1).toBeUndefined();
		expect(seenInitialTabs).toEqual(["overview", "overview", "workers"]);
		expect(openWorkerView).toHaveBeenNthCalledWith(
			1,
			tuiMock.ctx,
			mgr,
			"parser",
			expect.objectContaining({ returnTab: "overview" }),
		);
		expect(openWorkerView).toHaveBeenNthCalledWith(
			2,
			tuiMock.ctx,
			mgr,
			"verifier",
			expect.objectContaining({ returnTab: "workers" }),
		);

		// When openWorkerView returns undefined (Esc idle / Ctrl+D / /exit), exit directly without reopening overlay
		customMock.mockClear();
		openWorkerView.mockReset();
		customMock.mockResolvedValueOnce({
			kind: "open_worker",
			workerName: "parser",
			returnTab: "workers",
		} satisfies SwarmOverlayResult);
		openWorkerView.mockResolvedValueOnce(undefined);

		const res2 = await openSwarmOverlay(tuiMock.ctx, mgr, {
			initialTab: "workers",
			openWorkerView,
		});
		expect(res2).toBeUndefined();
		expect(customMock).toHaveBeenCalledTimes(1);
		expect(openWorkerView).toHaveBeenCalledTimes(1);
	});
});

describe("Background processes in widget, overlay, and plain summary", () => {
	function makeProcess(overrides: Partial<BackgroundProcessSummary>): BackgroundProcessSummary {
		const now = Date.now();
		return {
			taskId: "bg-1",
			ownerWorker: "verifier",
			command: "npm test",
			commandPreview: "npm test",
			state: "running",
			isDaemon: false,
			pid: 12345,
			startedAt: now - 15_200,
			lastOutputAt: now - 3_400,
			elapsedMs: 15_200,
			silentMs: 3_400,
			...overrides,
		};
	}

	async function setupBackgroundSwarm() {
		const dir = makeTempDir("pi-swarm-bg-ui-");
		const mgr = new SwarmManager({
			sessionId: "s-bg-ui",
			cwd: dir,
			swarmDir: dir,
			title: "BG UI Swarm",
			sessionFactory: async (ctx) => new MockWorkerSession(ctx),
		});
		managersToDispose.push(mgr);
		const mockCtx = makeMockContext(testTheme);
		mgr.updateHostContext(mockCtx.ctx);
		await mgr.addWorkers({ name: "author", brief: "Run dev server" }, "coordinator", mockCtx.ctx);
		await mgr.addWorkers({ name: "verifier", brief: "Run integration tests" }, "coordinator", mockCtx.ctx);
		await new Promise((r) => setTimeout(r, 30));
		return { mgr, ctx: mockCtx.ctx };
	}

	it("formats durations cleanly and omits background process UI when empty or undefined", async () => {
		expect(formatDurationShort(450)).toBe("450ms");
		expect(formatDurationShort(15_200)).toBe("15.2s");
		expect(formatDurationShort(65_000)).toBe("1m5s");
		expect(formatDurationShort(3_660_000)).toBe("1h1m");

		const { mgr, ctx } = await setupBackgroundSwarm();
		const baseSnap = mgr.getSnapshot();
		const legacySnap = {
			...baseSnap,
			backgroundProcesses: undefined,
			members: baseSnap.members.map((m) => ({ ...m, backgroundProcesses: undefined })),
		} as unknown as SwarmSnapshot;

		const emptyWidget = renderSwarmWidgetLines(baseSnap, testTheme, 100, true)
			.map((l) => stripTerminalSequences(l))
			.join("\n");
		const undefinedWidget = renderSwarmWidgetLines(legacySnap, testTheme, 100, true)
			.map((l) => stripTerminalSequences(l))
			.join("\n");

		expect(emptyWidget).toBe(undefinedWidget);
		expect(emptyWidget).not.toContain("bg");

		const tui = makeFakeTui(32);
		const done = vi.fn<(r: SwarmOverlayResult | undefined) => void>();
		const overlay = new SwarmOverlayComponent(tui, testTheme, testKeybindings, mgr, ctx, done, {
			initialTab: "workers",
		});
		const workersPlain = overlay.render(110).map((l) => stripTerminalSequences(l)).join("\n");
		expect(workersPlain).not.toContain("Background Processes");
		overlay.dispose();
	});

	it("renders active background process counts, daemon tags, command previews, and durations in widget, overlay, and plain summary", async () => {
		const { mgr, ctx } = await setupBackgroundSwarm();
		const devProc = makeProcess({
			taskId: "bg-dev-1",
			ownerWorker: "author",
			command: "npm run dev -- --port 3000",
			commandPreview: "npm run dev -- --port 3000",
			isDaemon: true,
			elapsedMs: 75_000,
			silentMs: 62_000,
		});
		const testProc = makeProcess({
			taskId: "bg-test-2",
			ownerWorker: "verifier",
			command: "vitest run test/integration.test.ts --reporter=verbose",
			commandPreview: "vitest run test/integration.test.ts --reporter=verbose",
			isDaemon: false,
			elapsedMs: 18_400,
			silentMs: 2_100,
		});
		const exitedProc = makeProcess({
			taskId: "bg-old-3",
			ownerWorker: "verifier",
			command: "echo done",
			commandPreview: "echo done",
			state: "exited",
			exitCode: 0,
			elapsedMs: 500,
			silentMs: 100,
		});

		const baseSnap = mgr.getSnapshot();
		const snapWithBg: SwarmSnapshot = {
			...baseSnap,
			backgroundProcesses: [devProc, testProc],
			members: baseSnap.members.map((m) => {
				if (m.name === "author") {
					return { ...m, backgroundProcesses: [devProc] };
				}
				if (m.name === "verifier") {
					return { ...m, backgroundProcesses: [testProc, exitedProc] };
				}
				return m;
			}),
		};

		// 1. Persistent widget lines (counts, daemon indicator, preview, elapsed, width safety)
		const widgetLines = renderSwarmWidgetLines(snapWithBg, testTheme, 88, true);
		const widgetPlain = widgetLines.map((l) => stripTerminalSequences(l)).join("\n");
		expect(widgetPlain).toContain("2 bg");
		expect(widgetPlain).toContain("1 bg");
		expect(widgetPlain).toContain("[daemon]");
		expect(widgetPlain).toContain("npm run dev");
		expect(widgetPlain).toContain("1m15s");
		expect(widgetPlain).toContain("vitest run");
		expect(widgetPlain).toContain("18.4s");
		expect(widgetPlain).not.toContain("echo done");
		for (const line of widgetLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(88);
		}

		// Narrow widget width safety
		const narrowWidgetLines = renderSwarmWidgetLines(snapWithBg, testTheme, 42, true);
		for (const line of narrowWidgetLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(42);
		}

		// 2. Plain summary
		const plainSummary = renderSwarmPlainSummary(snapWithBg);
		expect(plainSummary).toContain("bg=1");
		expect(plainSummary).toContain("bg-dev-1 [daemon]");
		expect(plainSummary).toContain("elapsed 1m15s, silent 1m2s");
		expect(plainSummary).toContain("bg-test-2 vitest run");

		// 3. Interactive Overlay (Overview & Workers tabs)
		vi.spyOn(mgr, "getSnapshot").mockReturnValue(snapWithBg);
		const tui = makeFakeTui(34);
		const done = vi.fn<(r: SwarmOverlayResult | undefined) => void>();
		const overlay = new SwarmOverlayComponent(tui, testTheme, testKeybindings, mgr, ctx, done, {
			initialTab: "overview",
		});

		const overviewLines = overlay.render(110);
		const overviewPlain = overviewLines.map((l) => stripTerminalSequences(l)).join("\n");
		expect(overviewPlain).toContain("[1 bg: [daemon]");
		expect(overviewPlain).toContain("[1 bg: vitest run");
		for (const line of overviewLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(110);
		}

		// Switch to Workers tab -> author selected first (has daemon process)
		overlay.handleInput("3");
		const authorWideLines = overlay.render(110);
		const authorWidePlain = authorWideLines.map((l) => stripTerminalSequences(l)).join("\n");
		expect(authorWidePlain).toContain("[1 bg]");
		expect(authorWidePlain).toContain("Background Processes (1):");
		expect(authorWidePlain).toContain("bg-dev-1 [daemon]");
		expect(authorWidePlain).toContain("elapsed 1m15s, silent 1m2s");
		for (const line of authorWideLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(110);
		}

		// Move selection down to verifier (non-daemon process)
		overlay.handleInput("\x1b[B");
		const verifierWidePlain = overlay.render(110).map((l) => stripTerminalSequences(l)).join("\n");
		expect(verifierWidePlain).toContain("Background Processes (1):");
		expect(verifierWidePlain).toContain("bg-test-2");
		expect(verifierWidePlain).toContain("elapsed 18.4s, silent 2.1s");
		expect(verifierWidePlain).not.toContain("bg-old-3");

		// Narrow stacked Workers layout keeps width <= 72 and still shows details
		const stackedLines = overlay.render(72);
		const stackedPlain = stackedLines.map((l) => stripTerminalSequences(l)).join("\n");
		expect(stackedPlain).toContain("Background Processes (1):");
		expect(stackedPlain).toContain("bg-test-2");
		expect(stackedPlain).toContain("elapsed 18.4s, silent 2.1s");
		for (const line of stackedLines) {
			expect(visibleWidth(line)).toBeLessThanOrEqual(72);
		}

		overlay.dispose();
	});
});

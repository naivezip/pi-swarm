import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import {
	type Api,
	type AssistantMessage,
	fauxAssistantMessage,
	fauxToolCall,
	type Model,
	registerFauxProvider,
	type Tool,
	type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
	type AgentSessionEvent,
	type AgentSessionEventListener,
	CURRENT_SESSION_VERSION,
	type ExtensionContext,
	ModelRegistry,
	ModelRuntime,
	type PromptOptions,
	type SessionEntry,
	SessionManager,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	buildSettledBranchEntries,
	type CoordinatorWakeEvent,
	type CreateWorkerSessionContext,
	SwarmManager,
	type WorkerSessionHandle,
} from "../src/runtime.ts";
import type { SwarmPlan } from "../src/types.ts";

const tempDirs: string[] = [];
const managersToDispose: SwarmManager[] = [];
const extraCleanups: Array<() => void> = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function makeModel(provider = "test-provider", id = "model-a", overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		id,
		name: `${provider}/${id}`,
		api: "anthropic-messages",
		provider,
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 100000,
		maxTokens: 4096,
		...overrides,
	};
}

function makeAssistantMessage(
	text: string,
	options: {
		stopReason?: AssistantMessage["stopReason"];
		errorMessage?: string;
		model?: Model<Api>;
		usage?: AssistantMessage["usage"];
		toolCalls?: Array<{ id: string; name: string; arguments?: Record<string, unknown> }>;
	} = {},
): AssistantMessage {
	const m = options.model ?? makeModel();
	const content: AssistantMessage["content"] = [];
	if (text) {
		content.push({ type: "text", text });
	}
	for (const tc of options.toolCalls ?? []) {
		content.push({
			type: "toolCall",
			id: tc.id,
			name: tc.name,
			arguments: (tc.arguments ?? {}) as AssistantMessage["content"] extends Array<infer U>
				? U extends { type: "toolCall"; arguments: infer A }
					? A
					: never
				: never,
		});
	}
	return {
		role: "assistant",
		content,
		api: m.api,
		provider: m.provider,
		model: m.id,
		usage: options.usage ?? {
			input: 10,
			output: 5,
			cacheRead: 2,
			cacheWrite: 1,
			totalTokens: 18,
			cost: { input: 0.001, output: 0.002, cacheRead: 0, cacheWrite: 0, total: 0.003 },
		},
		stopReason: options.stopReason ?? "stop",
		...(options.errorMessage ? { errorMessage: options.errorMessage } : {}),
		timestamp: Date.now(),
	};
}

class MockWorkerSession implements WorkerSessionHandle {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly sessionManager: SessionManager;
	model: Model<Api> | undefined;
	isStreaming = false;
	isIdle = true;
	prompts: string[] = [];
	abortedCount = 0;
	disposed = false;

	private readonly listeners = new Set<AgentSessionEventListener>();
	private readonly onPromptBehavior: (
		promptText: string,
		session: MockWorkerSession,
		context: CreateWorkerSessionContext,
	) => Promise<void> | void;
	private readonly ctx: CreateWorkerSessionContext;
	private activeTools = ["read", "bash", "edit", "write", "grep", "find", "ls", "swarm", "post_message", "read_board", "swarm_wait"];

	constructor(
		context: CreateWorkerSessionContext,
		onPromptBehavior: (
			promptText: string,
			session: MockWorkerSession,
			context: CreateWorkerSessionContext,
		) => Promise<void> | void,
	) {
		this.ctx = context;
		this.model = context.model ?? makeModel();
		this.sessionFile = context.member.sessionFile;
		const workersDir = join(context.swarmDir, "workers");
		mkdirSync(workersDir, { recursive: true });
		this.sessionManager = SessionManager.open(context.member.sessionFile, workersDir, context.member.workspacePath);
		this.sessionId = this.sessionManager.getSessionId();
		this.onPromptBehavior = onPromptBehavior;
	}

	get messages(): AgentMessage[] {
		return this.sessionManager.buildSessionContext().messages;
	}

	getActiveToolNames(): string[] {
		return [...this.activeTools];
	}

	setActiveToolsByName(toolNames: string[]): void {
		this.activeTools = [...toolNames];
	}

	async setModel(model: Model<Api>): Promise<void> {
		this.model = model;
		this.sessionManager.appendModelChange(model.provider, model.id);
	}

	async prompt(text: string, _options?: PromptOptions): Promise<void> {
		this.prompts.push(text);
		this.isStreaming = true;
		this.isIdle = false;
		this.emit({ type: "agent_start" });
		const userMsg: AgentMessage = {
			role: "user",
			content: [{ type: "text", text }],
			timestamp: Date.now(),
		};
		this.sessionManager.appendMessage(userMsg);
		this.emit({ type: "message_start", message: userMsg });
		this.emit({ type: "message_end", message: userMsg });

		try {
			await this.onPromptBehavior(text, this, this.ctx);
		} finally {
			this.isStreaming = false;
			this.isIdle = true;
			this.emit({ type: "agent_settled", aborted: false });
		}
	}

	emitAssistantSuccess(text: string, usage?: AssistantMessage["usage"]): void {
		const msg = makeAssistantMessage(text, { model: this.model, usage });
		this.sessionManager.appendMessage(msg);
		this.emit({ type: "message_start", message: msg });
		this.emit({
			type: "message_update",
			message: msg,
			assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: text, partial: msg },
		});
		this.emit({ type: "message_end", message: msg });
	}

	emitAssistantError(errorMessage: string): void {
		const msg = makeAssistantMessage("", {
			model: this.model,
			stopReason: "error",
			errorMessage,
		});
		this.sessionManager.appendMessage(msg);
		this.emit({ type: "message_start", message: msg });
		this.emit({ type: "message_end", message: msg });
	}

	emitToolEvent(toolName: string, args: Record<string, unknown>): void {
		this.emit({ type: "tool_execution_start", toolCallId: "tc-1", toolName, args });
		this.emit({
			type: "tool_execution_end",
			toolCallId: "tc-1",
			toolName,
			result: { content: [{ type: "text", text: "ok" }] },
			isError: false,
		});
	}

	async abort(): Promise<void> {
		this.abortedCount += 1;
		this.isStreaming = false;
		this.isIdle = true;
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

	protected emit(event: AgentSessionEvent): void {
		for (const listener of this.listeners) {
			listener(event);
		}
	}
}

function makeFakeExtensionContext(
	cwd: string,
	model: Model<Api>,
	availableModels: Model<Api>[],
	sessionManager: SessionManager,
	scopedModels: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }> = [],
): ExtensionContext {
	const fakeRegistry = {
		getAvailable: () => availableModels,
		getAll: () => availableModels,
		find: (provider: string, id: string) => availableModels.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: () => true,
	} as unknown as ModelRegistry;

	return {
		cwd,
		model,
		scopedModels,
		modelRegistry: fakeRegistry,
		sessionManager,
		hasUI: false,
		mode: "print",
		thinkingLevel: "off",
		isIdle: () => true,
		isProjectTrusted: () => true,
		signal: undefined,
		abort: () => {},
		hasPendingMessages: () => false,
		shutdown: () => {},
		getContextUsage: () => undefined,
		compact: () => {},
		getSystemPrompt: () => "",
		ui: {} as ExtensionContext["ui"],
	};
}

function initTempGitRepo(): string {
	const repoDir = makeTempDir("pi-swarm-repo-");
	execFileSync("git", ["init"], { cwd: repoDir, stdio: "ignore" });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "ignore" });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: repoDir, stdio: "ignore" });
	writeFileSync(join(repoDir, "README.md"), "# Test Repo\n", "utf-8");
	execFileSync("git", ["add", "README.md"], { cwd: repoDir, stdio: "ignore" });
	execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "ignore" });
	return repoDir;
}

async function flushMicrotasks(ticks = 5): Promise<void> {
	for (let i = 0; i < ticks; i++) {
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
}

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 4000, intervalMs = 20): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await new Promise((resolve) => setTimeout(resolve, intervalMs));
	}
	throw new Error(`Condition not met within ${timeoutMs}ms`);
}

afterEach(() => {
	while (managersToDispose.length > 0) {
		managersToDispose.pop()!.dispose();
	}
	while (extraCleanups.length > 0) {
		extraCleanups.pop()!();
	}
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("buildSettledBranchEntries", () => {
	it("strips trailing incomplete assistant turns with unresolved tool calls and re-chains parentId", () => {
		const sm = SessionManager.inMemory("/tmp/repo");
		const e1 = sm.appendMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 1 });
		sm.appendMessage(makeAssistantMessage("running tool", { toolCalls: [{ id: "tc-a", name: "read" }] }));
		sm.appendMessage({
			role: "toolResult",
			toolCallId: "tc-a",
			toolName: "read",
			content: [{ type: "text", text: "file" }],
			isError: false,
			timestamp: 2,
		});
		const e4 = sm.appendMessage(makeAssistantMessage("settled answer"));
		// Now an unresolved multi-tool turn (one answered, one still in-flight like swarm{add, fork})
		sm.appendMessage(
			makeAssistantMessage("", {
				toolCalls: [
					{ id: "tc-b", name: "read" },
					{ id: "tc-c", name: "swarm" },
				],
			}),
		);
		sm.appendMessage({
			role: "toolResult",
			toolCallId: "tc-b",
			toolName: "read",
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 3,
		});

		const settled = buildSettledBranchEntries(sm.getBranch());
		expect(settled.map((e) => e.id)).toEqual([e1, settled[1].id, settled[2].id, e4]);
		expect(settled[0].parentId).toBeNull();
		expect(settled[3].id).toBe(e4);
		expect(settled[3].parentId).toBe(settled[2].id);
	});

	it("strips trailing error or aborted assistant messages", () => {
		const sm = SessionManager.inMemory("/tmp/repo");
		const u1 = sm.appendMessage({ role: "user", content: [{ type: "text", text: "go" }], timestamp: 1 });
		sm.appendMessage(makeAssistantMessage("", { stopReason: "error", errorMessage: "429" }));

		const settled = buildSettledBranchEntries(sm.getBranch());
		expect(settled).toHaveLength(1);
		expect(settled[0].id).toBe(u1);
	});

	it("removes label entries while remapping compaction firstKeptEntryId", () => {
		const sm = SessionManager.inMemory("/tmp/repo");
		const u1 = sm.appendMessage({ role: "user", content: [{ type: "text", text: "first" }], timestamp: 1 });
		const labelId = sm.appendLabelChange(u1, "checkpoint");
		const u2 = sm.appendMessage({ role: "user", content: [{ type: "text", text: "second" }], timestamp: 2 });
		const cId = sm.appendCompaction("summary", labelId, 100);

		const settled = buildSettledBranchEntries(sm.getBranch());
		expect(settled.some((e) => e.type === "label")).toBe(false);
		const comp = settled.find((e) => e.id === cId);
		expect(comp?.type).toBe("compaction");
		if (comp?.type === "compaction") {
			expect(comp.firstKeptEntryId).toBe(u2);
		}
	});
});

describe("SwarmManager runtime mechanics", () => {
	it("spawns single and sharded workers, posts briefs, tracks usage, and wakes coordinator", async () => {
		const cwd = makeTempDir("pi-swarm-cwd-");
		const swarmsRoot = makeTempDir("pi-swarm-root-");
		const modelA = makeModel("anthropic", "claude-sonnet");
		const coordSm = SessionManager.inMemory(cwd);
		const hostCtx = makeFakeExtensionContext(cwd, modelA, [modelA], coordSm);

		const wakes: CoordinatorWakeEvent[] = [];
		let toolsActivated = false;
		const sessions = new Map<string, MockWorkerSession>();

		const manager = new SwarmManager(
			{
				sessionId: "sess-1",
				cwd,
				swarmsRoot,
				callbacks: {
					wakeCoordinator: (wake) => {
						wakes.push(wake);
					},
					onToolsActivationNeeded: () => {
						toolsActivated = true;
					},
				},
				sessionFactory: async (ctx) => {
					const session = new MockWorkerSession(ctx, (_prompt, s, wCtx) => {
						s.emitToolEvent("read", { path: "src/app.ts" });
						s.emitAssistantSuccess(`Done ${wCtx.member.name}`);
						manager.postMessage(wCtx.member.name, `@coordinator [done] finished ${wCtx.member.name}`);
					});
					sessions.set(ctx.member.name, session);
					return session;
				},
			},
		);
		managersToDispose.push(manager);
		manager.updateHostContext(hostCtx);

		manager.onCoordinatorSettled();
		const addResult = await manager.addWorkers(
			{
				name: "parser",
				brief: "Parse input",
				tasks: ["slice A", "slice B"],
			},
			"coordinator",
			hostCtx,
		);

		expect(toolsActivated).toBe(true);
		expect(addResult.workers.map((w) => w.name)).toEqual(["parser-1", "parser-2"]);
		expect(addResult.workers[0].group).toBe("parser");

		await flushMicrotasks();

		const status = manager.getDetailedStatus();
		expect(status.members).toHaveLength(2);
		expect(status.members[0].state).toBe("waiting");
		expect(status.members[0].usage.turns).toBe(1);
		expect(status.members[0].usage.cost).toBeCloseTo(0.003);
		expect(wakes.length).toBe(2);
		expect(wakes[0].author).toBe("parser-1");
		expect(manager.getSnapshot().totals.turns).toBe(2);
	});

	it("implements non-blocking swarm_wait with anti-lost-wakeup check and pending wake while working", async () => {
		const cwd = makeTempDir("pi-swarm-cwd-");
		const swarmsRoot = makeTempDir("pi-swarm-root-");
		const modelA = makeModel();
		const coordSm = SessionManager.inMemory(cwd);
		const hostCtx = makeFakeExtensionContext(cwd, modelA, [modelA], coordSm);

		const sessions = new Map<string, MockWorkerSession>();
		let releaseWorkerTurn: (() => void) | undefined;
		let turnCount = 0;

		const manager = new SwarmManager({
			sessionId: "sess-wait",
			cwd,
			swarmsRoot,
			sessionFactory: async (ctx) => {
				const session = new MockWorkerSession(ctx, async (_prompt, s) => {
					turnCount += 1;
					if (turnCount === 1) {
						await new Promise<void>((resolve) => {
							releaseWorkerTurn = resolve;
						});
					}
					s.emitAssistantSuccess(`turn ${turnCount}`);
				});
				sessions.set(ctx.member.name, session);
				return session;
			},
		});
		managersToDispose.push(manager);
		manager.updateHostContext(hostCtx);

		await manager.addWorkers({ name: "worker", brief: "Start task" }, "coordinator", hostCtx);
		// Worker is currently working on brief (#1)
		expect(manager.getDetailedStatus().members[0].state).toBe("working");

		// Post #2 while worker is working
		manager.postMessage("coordinator", "@worker follow-up task");

		// Anti-lost-wakeup: calling swarm_wait with since=1 detects #2 immediately
		const checkWait = manager.requestWait("worker", { since: 1 });
		expect(checkWait.parked).toBe(false);
		expect(checkWait.matchingSeqs).toEqual([2]);

		// Without reading #2, worker settles -> pending wake triggers turn 2 automatically!
		releaseWorkerTurn!();
		await flushMicrotasks();

		expect(sessions.get("worker")?.prompts).toHaveLength(2);
		expect(sessions.get("worker")?.prompts[1]).toContain("#2");

		// Now worker reads #2, calls swarm_wait({ since: 2, mentions_only: false }) -> parks cleanly
		manager.readBoard({ since: 1, viewer: "worker" });
		const parked = manager.requestWait("worker", { since: 2, mentions_only: false });
		expect(parked.parked).toBe(true);
		expect(parked.wakeMode).toBe("anything");

		// Posting an unaddressed message in #main wakes worker because mentions_only was false
		manager.postMessage("coordinator", "general update in main");
		await flushMicrotasks();
		expect(sessions.get("worker")?.prompts).toHaveLength(3);
	});

	it("suppresses stale coordinator wakeups when coordinator already read past the post", () => {
		const cwd = makeTempDir("pi-swarm-cwd-");
		const swarmsRoot = makeTempDir("pi-swarm-root-");
		const wakes: CoordinatorWakeEvent[] = [];

		const manager = new SwarmManager({
			sessionId: "sess-coord-wake",
			cwd,
			swarmsRoot,
			callbacks: {
				wakeCoordinator: (wake) => {
					wakes.push(wake);
				},
			},
		});
		managersToDispose.push(manager);

		manager.onCoordinatorRunStart();
		// Message #1 arrives while coordinator is working
		manager.postMessage("worker", "@coordinator hello");
		expect(wakes).toHaveLength(0);

		// Coordinator reads #1 before ending its turn
		manager.readBoard({ since: 0, viewer: "coordinator" });
		manager.onCoordinatorSettled();
		expect(wakes).toHaveLength(0);

		// Now coordinator is waiting; message #2 arrives -> wakes coordinator
		manager.postMessage("worker", "@coordinator wake me");
		expect(wakes).toHaveLength(1);
		expect(wakes[0].seq).toBe(2);
	});

	it("enforces recursive helper permissions for add, kill, model, and channel ops", async () => {
		const cwd = makeTempDir("pi-swarm-cwd-");
		const swarmsRoot = makeTempDir("pi-swarm-root-");
		const modelA = makeModel("p", "a");
		const modelB = makeModel("p", "b");
		const coordSm = SessionManager.inMemory(cwd);
		const hostCtx = makeFakeExtensionContext(cwd, modelA, [modelA, modelB], coordSm);

		const manager = new SwarmManager({
			sessionId: "sess-perms",
			cwd,
			swarmsRoot,
			sessionFactory: async (ctx) =>
				new MockWorkerSession(ctx, (_p, s) => {
					s.emitAssistantSuccess("ok");
				}),
		});
		managersToDispose.push(manager);
		manager.updateHostContext(hostCtx);

		manager.handleChannelOp({ op: "create", channel: "area1", topic: "Area 1" }, "coordinator");
		await manager.addWorkers({ name: "lead", brief: "Lead area 1", channels: ["area1"] }, "coordinator", hostCtx);
		await manager.addWorkers({ name: "other", brief: "Other worker" }, "coordinator", hostCtx);
		await flushMicrotasks();

		// Lead adds a helper -> inherits area1 channel by default
		await manager.addWorkers({ name: "helper", brief: "Help lead" }, "lead", hostCtx);
		await flushMicrotasks();
		const helperRecord = manager.getBoard().getMember("helper");
		expect(helperRecord?.addedBy).toBe("lead");
		expect(helperRecord?.channels).toEqual(["area1"]);

		// Lead CANNOT kill "other", CAN kill "helper"
		await expect(manager.killTarget("other", "lead")).rejects.toThrow(/Permission denied/);
		const killHelper = await manager.killTarget("helper", "lead");
		expect(killHelper.killed).toEqual(["helper"]);

		// Killed worker name cannot be reused
		await expect(manager.addWorkers({ name: "helper", brief: "Reuse?" }, "coordinator", hostCtx)).rejects.toThrow(
			/already exists/,
		);

		// Lead CANNOT switch "other" model, CAN switch self
		await expect(manager.switchModel({ name: "other", model: "p/b" }, "lead", hostCtx)).rejects.toThrow(
			/Permission denied/,
		);
		const selfSwitch = await manager.switchModel({ model: "p/b" }, "lead", hostCtx);
		expect(selfSwitch.model).toBe("p/b");

		// Worker CANNOT set title or plan
		expect(() => manager.setTitle("hack", "lead")).toThrow(/Only the coordinator/);
		expect(() =>
			manager.setPlan({ goal: { title: "x", line: "y" }, tasks: {}, threads: [] }, "lead"),
		).toThrow(/Only the coordinator/);

		// Killing lead does NOT kill helpers added by lead
		await manager.addWorkers({ name: "subhelper", brief: "Sub" }, "other", hostCtx);
		await flushMicrotasks();
		await manager.killTarget("other", "coordinator");
		expect(manager.getBoard().getMember("subhelper")?.state).not.toBe("killed");
	});

	it("handles 429/rate-limit error tracking, refuses model switch while working, and auto-resumes after model switch", async () => {
		const cwd = makeTempDir("pi-swarm-cwd-");
		const swarmsRoot = makeTempDir("pi-swarm-root-");
		const modelA = makeModel("p", "a");
		const modelB = makeModel("p", "b");
		const coordSm = SessionManager.inMemory(cwd);
		const hostCtx = makeFakeExtensionContext(cwd, modelA, [modelA, modelB], coordSm);

		const sessions = new Map<string, MockWorkerSession>();
		let failFirst = true;
		let holdSecond: (() => void) | undefined;

		const manager = new SwarmManager({
			sessionId: "sess-quota",
			cwd,
			swarmsRoot,
			sessionFactory: async (ctx) => {
				const session = new MockWorkerSession(ctx, async (_p, s) => {
					if (failFirst) {
						failFirst = false;
						s.emitAssistantError("429 Too Many Requests: quota exceeded");
						return;
					}
					if (holdSecond) {
						const fn = holdSecond;
						holdSecond = undefined;
						await new Promise<void>((r) => {
							setTimeout(r, 30);
						});
						fn();
					}
					s.emitAssistantSuccess("recovered on model B");
				});
				sessions.set(ctx.member.name, session);
				return session;
			},
		});
		managersToDispose.push(manager);
		manager.updateHostContext(hostCtx);

		await manager.addWorkers({ name: "coder", brief: "Write code" }, "coordinator", hostCtx);
		await flushMicrotasks();

		const member = manager.getBoard().getMember("coder")!;
		expect(member.state).toBe("waiting");
		expect(member.lastError).toContain("429");

		// Switch model while waiting -> wakes to resume failed turn
		const switched = await manager.switchModel({ name: "coder", model: "p/b" }, "coordinator", hostCtx);
		expect(switched.woke).toBe(true);
		expect(switched.model).toBe("p/b");
		await flushMicrotasks();

		expect(sessions.get("coder")?.prompts).toHaveLength(2);
		expect(manager.getBoard().getMember("coder")?.lastError).toBeUndefined();
		expect(sessions.get("coder")?.model?.id).toBe("b");

		// Cannot switch another worker while it is working
		holdSecond = () => {};
		manager.postMessage("coordinator", "@coder do more");
		await new Promise((r) => setTimeout(r, 5));
		await expect(manager.switchModel({ name: "coder", model: "p/a" }, "coordinator", hostCtx)).rejects.toThrow(
			/while it is working/,
		);
		await flushMicrotasks(6);
	});

	it("forks settled history from coordinator (stripping unresolved toolCall) and from worker", async () => {
		const cwd = makeTempDir("pi-swarm-cwd-");
		const swarmsRoot = makeTempDir("pi-swarm-root-");
		const modelA = makeModel("p", "a");
		const coordSm = SessionManager.inMemory(cwd);
		coordSm.appendMessage({ role: "user", content: [{ type: "text", text: "Coordinator context" }], timestamp: 1 });
		coordSm.appendMessage(makeAssistantMessage("Investigated auth.ts"));
		// Simulate in-flight toolCall on coordinator right when swarm{add, fork:"coordinator"} runs
		coordSm.appendMessage(makeAssistantMessage("", { toolCalls: [{ id: "tc-live", name: "swarm" }] }));
		const hostCtx = makeFakeExtensionContext(cwd, modelA, [modelA], coordSm);

		const sessions = new Map<string, MockWorkerSession>();
		const manager = new SwarmManager({
			sessionId: "sess-fork",
			cwd,
			swarmsRoot,
			sessionFactory: async (ctx) => {
				const session = new MockWorkerSession(ctx, (_p, s) => {
					s.emitAssistantSuccess("forked ok");
				});
				sessions.set(ctx.member.name, session);
				return session;
			},
		});
		managersToDispose.push(manager);
		manager.updateHostContext(hostCtx);

		await manager.addWorkers(
			{ name: "forked", brief: "Continue investigation", fork: "coordinator" },
			"coordinator",
			hostCtx,
		);
		await flushMicrotasks();

		const msgs = manager.getWorkerMessages("forked");
		// Should include Coordinator context + Investigated auth.ts, NOT the unresolved tc-live assistant message
		expect(msgs.some((m) => m.role === "assistant" && Array.isArray(m.content) && m.content.some((b) => b.type === "toolCall"))).toBe(false);
		expect(JSON.stringify(msgs)).toContain("Coordinator context");
		expect(JSON.stringify(msgs)).toContain("Investigated auth.ts");
		expect(JSON.stringify(msgs)).toContain("Continue investigation");
	});

	it("creates share git worktrees on add, removes them on kill, and recovers stopped workers on restart", async () => {
		const repoDir = initTempGitRepo();
		const swarmsRoot = makeTempDir("pi-swarm-root-");
		const modelA = makeModel("p", "a");
		const coordSm = SessionManager.inMemory(repoDir);
		const hostCtx = makeFakeExtensionContext(repoDir, modelA, [modelA], coordSm);

		const sessions = new Map<string, MockWorkerSession>();
		const manager = new SwarmManager({
			sessionId: "sess-recover",
			cwd: repoDir,
			swarmsRoot,
			sessionFactory: async (ctx) => {
				const session = new MockWorkerSession(ctx, (_p, s) => {
					s.emitAssistantSuccess("hi");
				});
				sessions.set(ctx.member.name, session);
				return session;
			},
		});
		manager.updateHostContext(hostCtx);

		const added = await manager.addWorkers(
			{ name: "editor", brief: "Edit files", workspace: "share" },
			"coordinator",
			hostCtx,
		);
		const wsPath = added.workers[0].workspacePath;
		expect(existsSync(wsPath)).toBe(true);
		await flushMicrotasks();

		// Persist plan as well
		const plan: SwarmPlan = {
			goal: { title: "Ship feature cleanly", line: "Implement and test." },
			tasks: { editor: "Edit files" },
			threads: [{ id: "t-1", title: "Core", goal: "Edit", tasks: ["editor"] }],
		};
		manager.setPlan(plan, "coordinator");

		// Dispose preserves workspace & state on disk for /resume
		manager.dispose();
		expect(existsSync(wsPath)).toBe(true);

		// Reload on restart: non-killed workers become `stopped` and revive on `@name`
		let revivedCount = 0;
		const recovered = SwarmManager.loadIfExists({
			sessionId: "sess-recover",
			cwd: repoDir,
			swarmsRoot,
			sessionFactory: async (ctx) => {
				revivedCount += 1;
				return new MockWorkerSession(ctx, (_p, s) => {
					s.emitAssistantSuccess("revived!");
				});
			},
		})!;
		expect(recovered).toBeDefined();
		managersToDispose.push(recovered);
		expect(recovered.getBoard().getMember("editor")?.state).toBe("stopped");
		expect(recovered.getSnapshot().plan.goal.title).toBe("Ship feature cleanly");

		recovered.postMessage("coordinator", "@editor wake up after restart");
		await flushMicrotasks();
		expect(revivedCount).toBe(1);
		expect(recovered.getBoard().getMember("editor")?.state).toBe("waiting");

		// Kill removes workspace
		await recovered.killWorkerByUser("editor");
		expect(existsSync(wsPath)).toBe(false);
		expect(recovered.getBoard().getMember("editor")?.state).toBe("killed");
	});

	it("restricts schedule and manage_task to monitor workers and wakes monitor on ticks", async () => {
		const cwd = makeTempDir("pi-swarm-cwd-");
		const swarmsRoot = makeTempDir("pi-swarm-root-");
		const modelA = makeModel("p", "a");
		const coordSm = SessionManager.inMemory(cwd);
		const hostCtx = makeFakeExtensionContext(cwd, modelA, [modelA], coordSm);

		vi.useFakeTimers();
		extraCleanups.push(() => vi.useRealTimers());

		const monitorPrompts: string[] = [];
		const manager = new SwarmManager({
			sessionId: "sess-mon",
			cwd,
			swarmsRoot,
			schedulerNow: () => Date.now(),
			sessionFactory: async (ctx) =>
				new MockWorkerSession(ctx, (p, s) => {
					if (ctx.member.name === "monitor") {
						monitorPrompts.push(p);
					}
					s.emitAssistantSuccess("checked");
				}),
		});
		managersToDispose.push(manager);
		manager.updateHostContext(hostCtx);

		await manager.addWorkers({ name: "worker", brief: "Do work" }, "coordinator", hostCtx);
		await manager.addWorkers({ name: "monitor", brief: "Watch swarm" }, "coordinator", hostCtx);
		await vi.advanceTimersByTimeAsync(20);

		expect(() => manager.scheduleForMonitor("worker", { DurationSeconds: 1, Prompt: "nope" })).toThrow(
			/Only monitor workers/,
		);

		const sched = manager.scheduleForMonitor("monitor", { DurationSeconds: 5, Prompt: "tick check" });
		expect(sched.kind).toBe("timer");

		await vi.advanceTimersByTimeAsync(5050);
		expect(monitorPrompts.some((p) => p.includes("tick check"))).toBe(true);
	});

	it("runs real createAgentSession worker with faux provider, DefaultResourceLoader, and <swarm_worker> prompt section", async () => {
		const cwd = makeTempDir("pi-swarm-real-cwd-");
		const agentDir = makeTempDir("pi-swarm-real-agent-");
		const swarmsRoot = makeTempDir("pi-swarm-real-root-");

		writeFileSync(join(cwd, "AGENTS.md"), "PROJECT_RULE_ALPHA: always be concise.\n", "utf-8");

		const faux = registerFauxProvider({
			models: [{ id: "faux-worker-1", name: "Faux Worker", reasoning: false }],
		});
		extraCleanups.push(() => faux.unregister());

		const fauxModel = faux.getModel();
		faux.setResponses([
			fauxAssistantMessage([
				fauxToolCall("post_message", { text: "@coordinator [done] real sdk worker completed" }),
			]),
			fauxAssistantMessage("Posted completion to board."),
		]);

		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		});
		await modelRuntime.setRuntimeApiKey(fauxModel.provider, "faux-key");
		modelRuntime.registerProvider(fauxModel.provider, {
			baseUrl: fauxModel.baseUrl,
			api: fauxModel.api,
			models: [
				{
					id: fauxModel.id,
					name: fauxModel.name,
					api: fauxModel.api,
					reasoning: fauxModel.reasoning,
					input: fauxModel.input,
					cost: fauxModel.cost,
					contextWindow: fauxModel.contextWindow,
					maxTokens: fauxModel.maxTokens,
					baseUrl: fauxModel.baseUrl,
				},
			],
		});

		const coordSm = SessionManager.inMemory(cwd);
		const available = [...modelRuntime.getAvailableSnapshot()];
		const hostCtx = makeFakeExtensionContext(cwd, fauxModel as Model<Api>, available as Model<Api>[], coordSm);

		const wakes: CoordinatorWakeEvent[] = [];
		const manager = new SwarmManager({
			sessionId: "sess-real-sdk",
			cwd,
			agentDir,
			swarmsRoot,
			modelRuntime,
			callbacks: {
				wakeCoordinator: (wake) => {
					wakes.push(wake);
				},
			},
		});
		managersToDispose.push(manager);
		manager.updateHostContext(hostCtx);

		await manager.addWorkers({ name: "builder", brief: "Post done to coordinator" }, "coordinator", hostCtx);
		manager.onCoordinatorSettled();

		// Wait for real AgentSession turn to finish
		for (let i = 0; i < 80; i++) {
			if (wakes.length > 0 && manager.getBoard().getMember("builder")?.state === "waiting") {
				break;
			}
			await new Promise((r) => setTimeout(r, 25));
		}

		const member = manager.getBoard().getMember("builder")!;
		expect(member.lastError).toBeUndefined();
		expect(wakes).toHaveLength(1);
		expect(wakes[0].text).toContain("[done] real sdk worker completed");

		expect(member.state).toBe("waiting");
		expect(existsSync(member.sessionFile)).toBe(true);

		const sessionJsonl = readFileSync(member.sessionFile, "utf-8");
		expect(sessionJsonl).toContain("<swarm_worker>");
		expect(sessionJsonl).toContain("You are builder");
		expect(sessionJsonl).toContain("PROJECT_RULE_ALPHA");
	});

	it("does not activate board tools if first add fails, and falls back to host cwd when killing helper after adder is killed", async () => {
		const nonGitDir = makeTempDir("pi-swarm-nongit-");
		const swarmsRoot = makeTempDir("pi-swarm-root-");
		const modelA = makeModel("p", "a");
		const hostCtx1 = makeFakeExtensionContext(nonGitDir, modelA, [modelA], SessionManager.inMemory(nonGitDir));

		let activated = false;
		const failingManager = new SwarmManager({
			sessionId: "sess-fail-add",
			cwd: nonGitDir,
			swarmsRoot,
			callbacks: {
				wakeCoordinator: () => {},
				onToolsActivationNeeded: () => {
					activated = true;
				},
			},
		});
		managersToDispose.push(failingManager);

		await expect(
			failingManager.addWorkers({ name: "bad", brief: "Needs git", workspace: "share" }, "coordinator", hostCtx1),
		).rejects.toThrow(/not a git repo/);
		expect(activated).toBe(false);

		// Now test killing a share adder before killing its share helper
		const repoDir = initTempGitRepo();
		const hostCtx2 = makeFakeExtensionContext(repoDir, modelA, [modelA], SessionManager.inMemory(repoDir));
		const manager = new SwarmManager({
			sessionId: "sess-helper-prune",
			cwd: repoDir,
			swarmsRoot,
			sessionFactory: async (ctx) =>
				new MockWorkerSession(ctx, (_p, s) => {
					s.emitAssistantSuccess("ok");
				}),
		});
		managersToDispose.push(manager);
		manager.updateHostContext(hostCtx2);

		const lead = await manager.addWorkers({ name: "lead", brief: "Lead", workspace: "share" }, "coordinator", hostCtx2);
		const helper = await manager.addWorkers({ name: "helper", brief: "Help", workspace: "share" }, "lead", hostCtx2);
		await flushMicrotasks();

		await manager.killTarget("lead", "coordinator");
		expect(existsSync(lead.workers[0].workspacePath)).toBe(false);

		// Killing helper after lead's workspace was deleted should still remove and prune helper's worktree
		await manager.killTarget("helper", "coordinator");
		expect(existsSync(helper.workers[0].workspacePath)).toBe(false);
		const worktreeList = execFileSync("git", ["worktree", "list"], { cwd: repoDir, encoding: "utf-8" });
		expect(worktreeList).not.toContain("helper");
	});

	it("wakes waiting worker on process_exit and flushes queued process_exit on onWorkerSettled when working", async () => {
		const cwd = makeTempDir("pi-swarm-proc-wake-cwd-");
		const swarmsRoot = makeTempDir("pi-swarm-proc-wake-root-");
		const modelA = makeModel("p", "a");
		const hostCtx = makeFakeExtensionContext(cwd, modelA, [modelA], SessionManager.inMemory(cwd));

		const sessions = new Map<string, MockWorkerSession>();
		let turnCount = 0;
		let releaseWorkingTurn: (() => void) | undefined;

		const manager = new SwarmManager({
			sessionId: "sess-proc-wake",
			cwd,
			swarmsRoot,
			sessionFactory: async (ctx) => {
				const session = new MockWorkerSession(ctx, async (_p, s) => {
					turnCount += 1;
					if (turnCount === 2) {
						await new Promise<void>((resolve) => {
							releaseWorkingTurn = resolve;
						});
					}
					s.emitAssistantSuccess(`turn-${turnCount}`);
				});
				sessions.set(ctx.member.name, session);
				return session;
			},
		});
		managersToDispose.push(manager);
		manager.updateHostContext(hostCtx);

		await manager.addWorkers({ name: "verifier", brief: "Run checks" }, "coordinator", hostCtx);
		await flushMicrotasks();

		// 1. Worker is waiting -> slow command promotes and emits process_exit -> wakes verifier immediately
		const bg1 = await manager.runWorkerBash("verifier", {
			command: `node -e "setTimeout(() => { console.log('bg1-done'); process.exit(0); }, 250)"`,
			wait_ms: 60,
			notify_after_seconds: 10,
		});
		expect(bg1.status).toBe("running");

		// Snapshot & detailed status reflect active background process
		const snapDuring = manager.getSnapshot();
		expect(snapDuring.backgroundProcesses).toHaveLength(1);
		expect(snapDuring.backgroundProcesses[0].taskId).toBe(bg1.taskId);
		expect(snapDuring.members[0].backgroundProcesses).toHaveLength(1);

		await waitForCondition(() => (sessions.get("verifier")?.prompts.length ?? 0) >= 2);
		const wakePrompt1 = sessions.get("verifier")!.prompts[1];
		expect(wakePrompt1).toContain("[process exit]");
		expect(wakePrompt1).toContain(bg1.taskId);
		expect(wakePrompt1).toContain("exited with code 0");
		expect(wakePrompt1).toContain("bg1-done");
		expect(manager.getSnapshot().backgroundProcesses).toHaveLength(0);

		// 2. Worker is working during process exit -> queued and flushed right after onWorkerSettled
		const bg2 = await manager.runWorkerBash("verifier", {
			command: `node -e "setTimeout(() => { console.log('bg2-queued'); process.exit(2); }, 180)"`,
			wait_ms: 50,
			notify_after_seconds: 10,
		});
		expect(bg2.status).toBe("running");

		// Put verifier into working state (turn 2 holds until released)
		manager.postMessage("coordinator", "@verifier start another check");
		await waitForCondition(() => releaseWorkingTurn !== undefined);
		expect(manager.getBoard().getMember("verifier")?.state).toBe("working");

		// Wait until bg2 exits while verifier is still working
		await waitForCondition(() => manager.getSnapshot().backgroundProcesses.length === 0);
		expect(sessions.get("verifier")!.prompts).toHaveLength(2);

		// Settle turn 2 -> queued process_exit flushes automatically as turn 3
		releaseWorkingTurn!();
		await waitForCondition(() => (sessions.get("verifier")?.prompts.length ?? 0) >= 3);
		const wakePrompt2 = sessions.get("verifier")!.prompts[2];
		expect(wakePrompt2).toContain("[process exit]");
		expect(wakePrompt2).toContain(bg2.taskId);
		expect(wakePrompt2).toContain("exited with code 2");
		expect(wakePrompt2).toContain("bg2-queued");
	});

	it("fires process_still_running for non-daemon, suppresses for is_daemon: true, and suppresses process_exit on manual kill", async () => {
		const cwd = makeTempDir("pi-swarm-proc-rem-cwd-");
		const swarmsRoot = makeTempDir("pi-swarm-proc-rem-root-");
		const modelA = makeModel("p", "a");
		const hostCtx = makeFakeExtensionContext(cwd, modelA, [modelA], SessionManager.inMemory(cwd));

		const sessions = new Map<string, MockWorkerSession>();
		const manager = new SwarmManager({
			sessionId: "sess-proc-rem",
			cwd,
			swarmsRoot,
			sessionFactory: async (ctx) => {
				const session = new MockWorkerSession(ctx, (_p, s) => s.emitAssistantSuccess("ok"));
				sessions.set(ctx.member.name, session);
				return session;
			},
		});
		managersToDispose.push(manager);
		manager.updateHostContext(hostCtx);

		await manager.addWorkers({ name: "runner", brief: "Run jobs" }, "coordinator", hostCtx);
		await flushMicrotasks();

		// Daemon process with short notify_after_seconds -> must NOT fire process_still_running
		const daemonRes = await manager.runWorkerBash("runner", {
			command: `node -e "setInterval(() => {}, 1000)"`,
			wait_ms: 50,
			is_daemon: true,
			notify_after_seconds: 0.1,
		});
		expect(daemonRes.status).toBe("running");

		await new Promise((r) => setTimeout(r, 260));
		expect(sessions.get("runner")!.prompts).toHaveLength(1);

		// Non-daemon process -> fires process_still_running reminder
		const slowRes = await manager.runWorkerBash("runner", {
			command: `node -e "console.log('still-going'); setInterval(() => {}, 1000)"`,
			wait_ms: 50,
			is_daemon: false,
			notify_after_seconds: 0.15,
		});
		expect(slowRes.status).toBe("running");

		await waitForCondition(() => (sessions.get("runner")?.prompts.length ?? 0) >= 2);
		const reminderPrompt = sessions.get("runner")!.prompts[1];
		expect(reminderPrompt).toContain("[process still running]");
		expect(reminderPrompt).toContain(slowRes.taskId);
		expect(reminderPrompt).toContain("silent for");
		expect(reminderPrompt).toContain("still-going");
		expect(reminderPrompt).toContain("manage_process");

		// Manual kill suppresses process_exit wake
		await manager.manageWorkerProcess("runner", { action: "kill", task_id: slowRes.taskId });
		await manager.manageWorkerProcess("runner", { action: "kill", task_id: daemonRes.taskId });
		await new Promise((r) => setTimeout(r, 150));
		expect(sessions.get("runner")!.prompts).toHaveLength(2);
	});

	it("preserves pending process_exit across worker model errors and delivers after switchModel recovery", async () => {
		const cwd = makeTempDir("pi-swarm-proc-err-cwd-");
		const swarmsRoot = makeTempDir("pi-swarm-proc-err-root-");
		const modelA = makeModel("p", "a");
		const modelB = makeModel("p", "b");
		const hostCtx = makeFakeExtensionContext(cwd, modelA, [modelA, modelB], SessionManager.inMemory(cwd));

		const sessions = new Map<string, MockWorkerSession>();
		let failNext = true;

		const manager = new SwarmManager({
			sessionId: "sess-proc-err",
			cwd,
			swarmsRoot,
			sessionFactory: async (ctx) => {
				const session = new MockWorkerSession(ctx, (_p, s) => {
					if (failNext) {
						failNext = false;
						s.emitAssistantError("429 quota exceeded");
						return;
					}
					s.emitAssistantSuccess("recovered ok");
				});
				sessions.set(ctx.member.name, session);
				return session;
			},
		});
		managersToDispose.push(manager);
		manager.updateHostContext(hostCtx);

		await manager.addWorkers({ name: "builder", brief: "Build" }, "coordinator", hostCtx);
		await flushMicrotasks();
		expect(manager.getBoard().getMember("builder")?.lastError).toContain("429");

		// Process exits while worker has lastError -> preserved (not dropped, not hammering broken model)
		const bg = await manager.runWorkerBash("builder", {
			command: `node -e "setTimeout(() => { console.log('built-while-errored'); process.exit(0); }, 150)"`,
			wait_ms: 40,
			notify_after_seconds: 10,
		});
		expect(bg.status).toBe("running");

		await waitForCondition(() => manager.getSnapshot().backgroundProcesses.length === 0);
		await flushMicrotasks();
		expect(sessions.get("builder")!.prompts).toHaveLength(1);

		// Switch model -> wakes worker to recover, then flushes preserved process_exit wake
		const switched = await manager.switchModel({ name: "builder", model: "p/b" }, "coordinator", hostCtx);
		expect(switched.woke).toBe(true);
		await waitForCondition(() => (sessions.get("builder")?.prompts.length ?? 0) >= 3);
		expect(sessions.get("builder")!.prompts[1]).toContain("[model switched]");
		expect(sessions.get("builder")!.prompts[2]).toContain("[process exit]");
		expect(sessions.get("builder")!.prompts[2]).toContain("built-while-errored");
	});

	it("cleans up real child process trees on killTarget, stopAll, and dispose", async () => {
		const cwd = makeTempDir("pi-swarm-proc-clean-cwd-");
		const swarmsRoot = makeTempDir("pi-swarm-proc-clean-root-");
		const modelA = makeModel("p", "a");
		const hostCtx = makeFakeExtensionContext(cwd, modelA, [modelA], SessionManager.inMemory(cwd));

		const manager = new SwarmManager({
			sessionId: "sess-proc-clean",
			cwd,
			swarmsRoot,
			sessionFactory: async (ctx) =>
				new MockWorkerSession(ctx, (_p, s) => s.emitAssistantSuccess("ok")),
		});
		managersToDispose.push(manager);
		manager.updateHostContext(hostCtx);

		await manager.addWorkers({ name: "w1", brief: "Work 1" }, "coordinator", hostCtx);
		await manager.addWorkers({ name: "w2", brief: "Work 2" }, "coordinator", hostCtx);
		await flushMicrotasks();

		const p1 = await manager.runWorkerBash("w1", {
			command: `node -e "setInterval(() => {}, 1000)"`,
			wait_ms: 40,
			is_daemon: true,
		});
		const p2 = await manager.runWorkerBash("w2", {
			command: `node -e "setInterval(() => {}, 1000)"`,
			wait_ms: 40,
			is_daemon: true,
		});
		expect(p1.status).toBe("running");
		expect(p2.status).toBe("running");
		if (p1.status !== "running" || p2.status !== "running") throw new Error("unreachable");

		expect(isPidAlive(p1.pid!)).toBe(true);
		expect(isPidAlive(p2.pid!)).toBe(true);

		// killTarget kills w1's process without killing w2's
		await manager.killTarget("w1", "coordinator");
		await waitForCondition(() => !isPidAlive(p1.pid!));
		expect(isPidAlive(p2.pid!)).toBe(true);

		// stopAll kills remaining active processes
		await manager.stopAll();
		await waitForCondition(() => !isPidAlive(p2.pid!));
		expect(manager.getSnapshot().backgroundProcesses).toHaveLength(0);

		// dispose kills synchronously
		await manager.addWorkers({ name: "w3", brief: "Work 3" }, "coordinator", hostCtx);
		await flushMicrotasks();
		const p3 = await manager.runWorkerBash("w3", {
			command: `node -e "setInterval(() => {}, 1000)"`,
			wait_ms: 40,
			is_daemon: true,
		});
		if (p3.status !== "running") throw new Error("unreachable");
		expect(isPidAlive(p3.pid!)).toBe(true);
		manager.dispose();
		await waitForCondition(() => !isPidAlive(p3.pid!));
	});

	it("E2E createAgentSession exposes async bash + manage_process on workers and excludes them from monitor", async () => {
		const cwd = makeTempDir("pi-swarm-e2e-proc-cwd-");
		const agentDir = makeTempDir("pi-swarm-e2e-proc-agent-");
		const swarmsRoot = makeTempDir("pi-swarm-e2e-proc-root-");

		const faux = registerFauxProvider({
			models: [{ id: "faux-proc-1", name: "Faux Proc", reasoning: false }],
		});
		extraCleanups.push(() => faux.unregister());

		const fauxModel = faux.getModel();
		let verifierBashParams: Record<string, unknown> | undefined;
		let verifierToolNames: string[] = [];
		let monitorToolNames: string[] = [];
		let verifierSawPromotedBg = false;

		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		});
		await modelRuntime.setRuntimeApiKey(fauxModel.provider, "faux-key");
		modelRuntime.registerProvider(fauxModel.provider, {
			baseUrl: fauxModel.baseUrl,
			api: fauxModel.api,
			models: [
				{
					id: fauxModel.id,
					name: fauxModel.name,
					api: fauxModel.api,
					reasoning: fauxModel.reasoning,
					input: fauxModel.input,
					cost: fauxModel.cost,
					contextWindow: fauxModel.contextWindow,
					maxTokens: fauxModel.maxTokens,
					baseUrl: fauxModel.baseUrl,
				},
			],
		});

		const coordSm = SessionManager.inMemory(cwd);
		const available = [...modelRuntime.getAvailableSnapshot()];
		const hostCtx = makeFakeExtensionContext(cwd, fauxModel as Model<Api>, available as Model<Api>[], coordSm);

		const wakes: CoordinatorWakeEvent[] = [];
		const manager = new SwarmManager({
			sessionId: "sess-e2e-proc",
			cwd,
			agentDir,
			swarmsRoot,
			modelRuntime,
			callbacks: {
				wakeCoordinator: (wake) => {
					wakes.push(wake);
				},
			},
		});
		managersToDispose.push(manager);
		manager.updateHostContext(hostCtx);

		const extractToolsFromContext = (ctx: TranscriptContext): Tool[] => {
			const tools = new Map<string, Tool>();
			for (const msg of ctx.messages) {
				if (msg.role === "system") {
					for (const removed of msg.toolsRemoved ?? []) {
						tools.delete(removed.name);
					}
					for (const added of msg.toolsAdded ?? []) {
						tools.set(added.name, added);
					}
				}
			}
			return [...tools.values()];
		};

		// Verifier turn 1: inspect tools, invoke slow bash (wait_ms: 80 -> promotes to background)
		// Verifier turn 2: end turn after seeing promoted taskId so async process_exit wakes it
		// Verifier turn 3 (woken by process_exit): post [done] to coordinator
		let step = 0;
		let capturedLastMsgBeforeExit = "";
		let capturedWakePrompt = "";
		faux.setResponses([
			(ctx) => {
				step += 1;
				const currentTools = extractToolsFromContext(ctx);
				verifierToolNames = currentTools.map((t) => t.name);
				verifierBashParams = currentTools.find((t) => t.name === "bash")?.parameters as
					| Record<string, unknown>
					| undefined;
				return fauxAssistantMessage([
					fauxToolCall("bash", {
						command: `node -e "setTimeout(() => { console.log('e2e-bg-complete'); process.exit(0); }, 600)"`,
						wait_ms: 80,
						notify_after_seconds: 10,
					}),
				]);
			},
			(ctx) => {
				step += 1;
				const lastMsg = ctx.messages[ctx.messages.length - 1];
				capturedLastMsgBeforeExit = JSON.stringify(lastMsg);
				verifierSawPromotedBg = capturedLastMsgBeforeExit.includes("promoted to background");
				return fauxAssistantMessage("Ending turn to await async process_exit wake.");
			},
			(ctx) => {
				step += 1;
				capturedWakePrompt = JSON.stringify(ctx.messages[ctx.messages.length - 1]);
				return fauxAssistantMessage([
					fauxToolCall("post_message", { text: "@coordinator [done] e2e async bash verified" }),
				]);
			},
			() => fauxAssistantMessage("Reported done."),
		]);

		await manager.addWorkers({ name: "verifier", brief: "Run slow check" }, "coordinator", hostCtx);
		manager.onCoordinatorSettled();
		await waitForCondition(() => {
			const m = manager.getBoard().getMember("verifier");
			if (m?.lastError) {
				throw new Error(`verifier failed: ${m.lastError}`);
			}
			return wakes.length >= 1 && m?.state === "waiting";
		}, 8000);

		expect(step).toBeGreaterThanOrEqual(3);
		expect(verifierSawPromotedBg).toBe(true);
		expect(capturedWakePrompt).toContain("[process exit]");
		expect(capturedWakePrompt).toContain("e2e-bg-complete");
		expect(verifierToolNames).toContain("bash");
		expect(verifierToolNames).toContain("manage_process");
		const props = (verifierBashParams as { properties?: Record<string, unknown> } | undefined)?.properties;
		expect(props).toHaveProperty("wait_ms");
		expect(props).toHaveProperty("is_daemon");
		expect(props).toHaveProperty("notify_after_seconds");
		expect(wakes[0].text).toContain("[done] e2e async bash verified");

		const verifierJsonl = readFileSync(manager.getBoard().getMember("verifier")!.sessionFile, "utf-8");
		expect(verifierJsonl).toContain("NEVER poll `manage_process` in a loop");

		// Now spawn a real monitor and verify strict read-only + scheduler boundary
		faux.setResponses([
			(ctx) => {
				monitorToolNames = extractToolsFromContext(ctx).map((t) => t.name);
				return fauxAssistantMessage("Monitor ready.");
			},
		]);
		await manager.addWorkers({ name: "monitor", brief: "Watch swarm" }, "coordinator", hostCtx);
		await waitForCondition(() => monitorToolNames.length > 0 && manager.getBoard().getMember("monitor")?.state === "waiting", 6000);

		expect(monitorToolNames).not.toContain("bash");
		expect(monitorToolNames).not.toContain("manage_process");
		expect(monitorToolNames).not.toContain("edit");
		expect(monitorToolNames).not.toContain("write");
		expect(monitorToolNames).toContain("read");
		expect(monitorToolNames).toContain("schedule");
		expect(monitorToolNames).toContain("manage_task");
	});

	it("does not leave orphan processes when killTarget or stopAll races with in-flight runWorkerBash", async () => {
		const cwd = makeTempDir("pi-swarm-kill-race-cwd-");
		const swarmsRoot = makeTempDir("pi-swarm-kill-race-root-");
		const modelA = makeModel("p", "a");
		const hostCtx = makeFakeExtensionContext(cwd, modelA, [modelA], SessionManager.inMemory(cwd));

		const manager = new SwarmManager({
			sessionId: "sess-kill-race",
			cwd,
			swarmsRoot,
			sessionFactory: async (ctx) =>
				new MockWorkerSession(ctx, (_p, s) => s.emitAssistantSuccess("ok")),
		});
		managersToDispose.push(manager);
		manager.updateHostContext(hostCtx);

		await manager.addWorkers({ name: "w1", brief: "Work 1" }, "coordinator", hostCtx);
		await flushMicrotasks();

		// Race in-flight runWorkerBash against killTarget
		const bashPromise = manager.runWorkerBash("w1", {
			command: `node -e "setInterval(() => {}, 1000)"`,
			wait_ms: 40,
			is_daemon: true,
		});
		const killPromise = manager.killTarget("w1", "coordinator");
		await expect(bashPromise).rejects.toThrow(/cancelled|killed/i);
		await killPromise;
		expect(manager.getSnapshot().backgroundProcesses).toEqual([]);
		expect(manager.getBoard().getMember("w1")?.state).toBe("killed");

		// Race in-flight runWorkerBash against stopAll
		await manager.addWorkers({ name: "w2", brief: "Work 2" }, "coordinator", hostCtx);
		await flushMicrotasks();
		const bashPromise2 = manager.runWorkerBash("w2", {
			command: `node -e "setInterval(() => {}, 1000)"`,
			wait_ms: 40,
			is_daemon: true,
		});
		const stopPromise = manager.stopAll();
		await expect(bashPromise2).rejects.toThrow(/cancelled|stopping/i);
		await stopPromise;
		expect(manager.getSnapshot().backgroundProcesses).toEqual([]);
	});

	it("does not launch prompt or resurrect worker if killTarget runs while wakeWorker awaits sessionFactory", async () => {
		const cwd = makeTempDir("pi-swarm-wake-kill-cwd-");
		const swarmsRoot = makeTempDir("pi-swarm-wake-kill-root-");
		const modelA = makeModel("p", "a");
		const hostCtx = makeFakeExtensionContext(cwd, modelA, [modelA], SessionManager.inMemory(cwd));

		let allowSecondSession!: () => void;
		let callCount = 0;
		const createdSessions: MockWorkerSession[] = [];

		const manager = new SwarmManager({
			sessionId: "sess-wake-kill-race",
			cwd,
			swarmsRoot,
			sessionFactory: async (ctx) => {
				callCount += 1;
				if (callCount === 2) {
					await new Promise<void>((resolve) => {
						allowSecondSession = resolve;
					});
				}
				const s = new MockWorkerSession(ctx, (_p, sess) => sess.emitAssistantSuccess("ok"));
				createdSessions.push(s);
				return s;
			},
		});
		managersToDispose.push(manager);
		manager.updateHostContext(hostCtx);

		await manager.addWorkers({ name: "w1", brief: "Initial" }, "coordinator", hostCtx);
		await flushMicrotasks();

		// Simulate restart where w1 is stopped (no activeWorkers entry)
		manager.dispose();
		const resumed = SwarmManager.loadIfExists({
			sessionId: "sess-wake-kill-race",
			cwd,
			swarmsRoot,
			sessionFactory: async (ctx) => {
				callCount += 1;
				await new Promise<void>((resolve) => {
					allowSecondSession = resolve;
				});
				const s = new MockWorkerSession(ctx, (_p, sess) => sess.emitAssistantSuccess("ok"));
				createdSessions.push(s);
				return s;
			},
		})!;
		managersToDispose.push(resumed);
		resumed.updateHostContext(hostCtx);

		// Wake stopped worker -> enters await sessionFactory
		resumed.postMessage("coordinator", "@w1 resume work");
		await waitForCondition(() => allowSecondSession !== undefined);

		// Kill w1 while sessionFactory is still pending
		await resumed.killTarget("w1", "coordinator");
		allowSecondSession();
		await flushMicrotasks();

		expect(resumed.getBoard().getMember("w1")?.state).toBe("killed");
		const secondSession = createdSessions[1];
		expect(secondSession.disposed).toBe(true);
		expect(secondSession.prompts).toEqual([]);
	});

	it("sends private direct messages to waiting workers with zero board posts and relays live events", async () => {
		const cwd = makeTempDir("pi-swarm-direct-wait-cwd-");
		const swarmsRoot = makeTempDir("pi-swarm-direct-wait-root-");
		const modelA = makeModel("p", "a");
		const hostCtx = makeFakeExtensionContext(cwd, modelA, [modelA], SessionManager.inMemory(cwd));

		const sessions = new Map<string, MockWorkerSession>();
		const manager = new SwarmManager({
			sessionId: "sess-direct-wait",
			cwd,
			swarmsRoot,
			sessionFactory: async (ctx) => {
				const session = new MockWorkerSession(ctx, (promptText, s) => {
					s.emitToolEvent("read", { path: "README.md" });
					s.emitAssistantSuccess(`reply to: ${promptText}`);
				});
				sessions.set(ctx.member.name, session);
				return session;
			},
		});
		managersToDispose.push(manager);
		manager.updateHostContext(hostCtx);

		await manager.addWorkers({ name: "coder", brief: "Initial brief" }, "coordinator", hostCtx);
		await flushMicrotasks();

		const headBefore = manager.getBoard().head;
		const boardCountBefore = manager.getMessages().length;
		expect(manager.getWorkerSession("coder")).toBe(sessions.get("coder"));

		const receivedEvents: AgentSessionEvent[] = [];
		const unsubscribeEvents = manager.subscribeWorkerEvents("coder", (ev) => {
			receivedEvents.push(ev);
		});
		const snapshots: Array<{ state: string; turns: number }> = [];
		const unsubscribeSnap = manager.subscribe((snap) => {
			const m = snap.members.find((x) => x.name === "coder");
			if (m) {
				snapshots.push({ state: m.state, turns: m.usage.turns });
			}
		});

		const result = await manager.sendDirectWorkerMessage("coder", "Explain your diff privately");
		expect(result.worker).toBe("coder");
		expect(result.delivery).toBe("prompt");
		expect(result.resumed).toBe(false);
		expect(result.queued).toBe(false);
		await flushMicrotasks();

		// Strictly private: zero board posts
		expect(manager.getBoard().head).toBe(headBefore);
		expect(manager.getMessages()).toHaveLength(boardCountBefore);

		// Live session events relayed and usage/state updated
		expect(receivedEvents.some((e) => e.type === "agent_start")).toBe(true);
		expect(receivedEvents.some((e) => e.type === "message_update")).toBe(true);
		expect(receivedEvents.some((e) => e.type === "tool_execution_start")).toBe(true);
		expect(receivedEvents.some((e) => e.type === "agent_settled")).toBe(true);
		expect(sessions.get("coder")?.prompts).toContain("Explain your diff privately");
		expect(manager.getBoard().getMember("coder")?.state).toBe("waiting");
		expect(manager.getBoard().getMember("coder")?.usage.turns).toBe(2);
		expect(snapshots.some((s) => s.state === "working")).toBe(true);
		expect(snapshots[snapshots.length - 1]).toEqual({ state: "waiting", turns: 2 });

		await expect(manager.sendDirectWorkerMessage("coder", "   ")).rejects.toThrow(/non-empty/);
		await expect(manager.sendDirectWorkerMessage("missing", "hi")).rejects.toThrow(/does not exist/);

		unsubscribeEvents();
		unsubscribeSnap();
	});

	it("queues steer (default) and followUp when working with both native queue hooks and fallback queue", async () => {
		const cwd = makeTempDir("pi-swarm-queue-cwd-");
		const swarmsRoot = makeTempDir("pi-swarm-queue-root-");
		const modelA = makeModel("p", "a");
		const hostCtx = makeFakeExtensionContext(cwd, modelA, [modelA], SessionManager.inMemory(cwd));

		class QueueAwareSession extends MockWorkerSession {
			private steeringQueue: string[] = [];
			private followUpQueue: string[] = [];

			async steer(text: string): Promise<"handled" | "queued"> {
				this.steeringQueue.push(text);
				this.emit({
					type: "queue_update",
					steering: [...this.steeringQueue],
					followUp: [...this.followUpQueue],
				});
				return "queued";
			}

			async followUp(text: string): Promise<"handled" | "queued"> {
				this.followUpQueue.push(text);
				this.emit({
					type: "queue_update",
					steering: [...this.steeringQueue],
					followUp: [...this.followUpQueue],
				});
				return "queued";
			}

			getSteeringMessages(): readonly string[] {
				return this.steeringQueue;
			}

			getFollowUpMessages(): readonly string[] {
				return this.followUpQueue;
			}

			drainQueuedForTest(): string[] {
				const consumed: string[] = [];
				while (this.steeringQueue.length > 0) {
					const next = this.steeringQueue.shift()!;
					consumed.push(next);
					this.emit({
						type: "queue_update",
						steering: [...this.steeringQueue],
						followUp: [...this.followUpQueue],
					});
					const msg: AgentMessage = { role: "user", content: [{ type: "text", text: next }], timestamp: Date.now() };
					this.sessionManager.appendMessage(msg);
					this.emit({ type: "message_start", message: msg });
					this.emit({ type: "message_end", message: msg });
				}
				while (this.followUpQueue.length > 0) {
					const next = this.followUpQueue.shift()!;
					consumed.push(next);
					this.emit({
						type: "queue_update",
						steering: [...this.steeringQueue],
						followUp: [...this.followUpQueue],
					});
					const msg: AgentMessage = { role: "user", content: [{ type: "text", text: next }], timestamp: Date.now() };
					this.sessionManager.appendMessage(msg);
					this.emit({ type: "message_start", message: msg });
					this.emit({ type: "message_end", message: msg });
				}
				return consumed;
			}
		}

		let releaseNativeTurn: (() => void) | undefined;
		let releaseFallbackTurn: (() => void) | undefined;
		const nativeConsumed: string[] = [];
		const fallbackSessions = new Map<string, MockWorkerSession>();
		const nativeSessions = new Map<string, QueueAwareSession>();

		const manager = new SwarmManager({
			sessionId: "sess-queue",
			cwd,
			swarmsRoot,
			sessionFactory: async (ctx) => {
				if (ctx.member.name === "native-w") {
					let turn = 0;
					const s = new QueueAwareSession(ctx, async (_p, sess) => {
						turn += 1;
						if (turn === 1) {
							await new Promise<void>((resolve) => {
								releaseNativeTurn = resolve;
							});
						}
						nativeConsumed.push(...(sess as QueueAwareSession).drainQueuedForTest());
						sess.emitAssistantSuccess("native-ok");
					});
					nativeSessions.set(ctx.member.name, s);
					return s;
				}
				let turn = 0;
				const s = new MockWorkerSession(ctx, async (_p, sess) => {
					turn += 1;
					if (turn === 1) {
						await new Promise<void>((resolve) => {
							releaseFallbackTurn = resolve;
						});
					}
					sess.emitAssistantSuccess(`fallback-${turn}`);
				});
				fallbackSessions.set(ctx.member.name, s);
				return s;
			},
		});
		managersToDispose.push(manager);
		manager.updateHostContext(hostCtx);

		await manager.addWorkers({ name: "native-w", brief: "Work 1" }, "coordinator", hostCtx);
		await manager.addWorkers({ name: "fallback-w", brief: "Work 2" }, "coordinator", hostCtx);
		await waitForCondition(() => releaseNativeTurn !== undefined && releaseFallbackTurn !== undefined);

		const headBefore = manager.getBoard().head;
		const nativeQueueEvents: Array<{ steering: readonly string[]; followUp: readonly string[] }> = [];
		manager.subscribeWorkerEvents("native-w", (ev) => {
			if (ev.type === "queue_update") {
				nativeQueueEvents.push({ steering: [...ev.steering], followUp: [...ev.followUp] });
			}
		});

		// Default delivery while working is "steer"
		const r1 = await manager.sendDirectWorkerMessage("native-w", "steer-1");
		expect(r1).toMatchObject({ worker: "native-w", delivery: "steer", resumed: false, queued: true, state: "working" });
		const r2 = await manager.sendDirectWorkerMessage("native-w", "followup-1", "followUp");
		expect(r2).toMatchObject({
			worker: "native-w",
			delivery: "followUp",
			resumed: false,
			queued: true,
			state: "working",
		});

		expect(manager.getWorkerQueuedMessages("native-w")).toEqual({
			steering: ["steer-1"],
			followUp: ["followup-1"],
		});
		expect(nativeQueueEvents.length).toBeGreaterThanOrEqual(2);

		// Fallback mock session (without steer/followUp methods) also tracks and drains queues
		const f1 = await manager.sendDirectWorkerMessage("fallback-w", "fb-steer");
		const f2 = await manager.sendDirectWorkerMessage("fallback-w", "fb-follow", "followUp");
		expect(f1.delivery).toBe("steer");
		expect(f1.queued).toBe(true);
		expect(f2.delivery).toBe("followUp");
		expect(f2.queued).toBe(true);
		expect(manager.getWorkerQueuedMessages("fallback-w")).toEqual({
			steering: ["fb-steer"],
			followUp: ["fb-follow"],
		});

		// Release both turns and verify queues drain to empty without touching board
		releaseNativeTurn!();
		releaseFallbackTurn!();
		await waitForCondition(
			() =>
				manager.getBoard().getMember("native-w")?.state === "waiting" &&
				manager.getBoard().getMember("fallback-w")?.state === "waiting" &&
				fallbackSessions.get("fallback-w")!.prompts.length === 3,
		);

		expect(nativeConsumed).toEqual(["steer-1", "followup-1"]);
		expect(manager.getWorkerQueuedMessages("native-w")).toEqual({ steering: [], followUp: [] });
		expect(fallbackSessions.get("fallback-w")!.prompts.slice(1)).toEqual(["fb-steer", "fb-follow"]);
		expect(manager.getWorkerQueuedMessages("fallback-w")).toEqual({ steering: [], followUp: [] });
		expect(manager.getBoard().head).toBe(headBefore);
	});

	it("auto-resumes stopped worker on direct message, re-attaches live events, and rejects killed workers", async () => {
		const cwd = makeTempDir("pi-swarm-direct-resume-cwd-");
		const swarmsRoot = makeTempDir("pi-swarm-direct-resume-root-");
		const modelA = makeModel("p", "a");
		const hostCtx = makeFakeExtensionContext(cwd, modelA, [modelA], SessionManager.inMemory(cwd));

		const manager = new SwarmManager({
			sessionId: "sess-direct-resume",
			cwd,
			swarmsRoot,
			sessionFactory: async (ctx) =>
				new MockWorkerSession(ctx, (p, s) => {
					s.emitAssistantSuccess(`initial:${p}`);
				}),
		});
		manager.updateHostContext(hostCtx);

		await manager.addWorkers({ name: "editor", brief: "Initial brief" }, "coordinator", hostCtx);
		await flushMicrotasks();
		manager.dispose();

		// Reload from disk -> worker is stopped, no live session
		const resumedSessions = new Map<string, MockWorkerSession>();
		const recovered = SwarmManager.loadIfExists({
			sessionId: "sess-direct-resume",
			cwd,
			swarmsRoot,
			sessionFactory: async (ctx) => {
				const s = new MockWorkerSession(ctx, (p, sess) => {
					sess.emitAssistantSuccess(`resumed:${p}`);
				});
				resumedSessions.set(ctx.member.name, s);
				return s;
			},
		})!;
		managersToDispose.push(recovered);
		recovered.updateHostContext(hostCtx);

		expect(recovered.getBoard().getMember("editor")?.state).toBe("stopped");
		expect(recovered.getWorkerSession("editor")).toBeUndefined();

		// Subscribe BEFORE auto-resume while worker is still stopped
		const eventsBeforeKill: AgentSessionEvent[] = [];
		recovered.subscribeWorkerEvents("editor", (ev) => {
			eventsBeforeKill.push(ev);
		});

		const headBefore = recovered.getBoard().head;
		const res = await recovered.sendDirectWorkerMessage("editor", "Continue privately");
		expect(res.resumed).toBe(true);
		expect(res.delivery).toBe("prompt");
		expect(res.queued).toBe(false);
		await flushMicrotasks();

		// Zero board posts, live session attached, pre-registered listener received events
		expect(recovered.getBoard().head).toBe(headBefore);
		expect(recovered.getWorkerSession("editor")).toBe(resumedSessions.get("editor"));
		expect(recovered.getBoard().getMember("editor")?.state).toBe("waiting");
		expect(eventsBeforeKill.some((e) => e.type === "agent_start")).toBe(true);
		expect(eventsBeforeKill.some((e) => e.type === "message_update")).toBe(true);
		expect(eventsBeforeKill.some((e) => e.type === "agent_settled")).toBe(true);

		// Kill worker -> read-only enforcement
		const killSnapshots: string[] = [];
		recovered.subscribe((snap) => {
			const m = snap.members.find((x) => x.name === "editor");
			if (m) killSnapshots.push(m.state);
		});
		await recovered.killWorkerByUser("editor");
		expect(killSnapshots[killSnapshots.length - 1]).toBe("killed");
		expect(recovered.getWorkerSession("editor")).toBeUndefined();
		expect(recovered.getWorkerQueuedMessages("editor")).toEqual({ steering: [], followUp: [] });
		expect(recovered.getWorkerMessages("editor").length).toBeGreaterThan(0);

		await expect(recovered.sendDirectWorkerMessage("editor", "After kill")).rejects.toThrow(/killed|read-only/i);
		expect(recovered.getBoard().head).toBe(headBefore);
	});

	it("aborts only the targeted working worker without affecting coordinator or peer workers, and safely no-ops on idle", async () => {
		const cwd = makeTempDir("pi-swarm-abort-iso-cwd-");
		const swarmsRoot = makeTempDir("pi-swarm-abort-iso-root-");
		const modelA = makeModel("p", "a");
		const modelB = makeModel("p", "b");
		const hostCtx = makeFakeExtensionContext(cwd, modelA, [modelA, modelB], SessionManager.inMemory(cwd));

		let releaseW1: (() => void) | undefined;
		let releaseW2: (() => void) | undefined;
		const sessions = new Map<string, MockWorkerSession>();

		const manager = new SwarmManager({
			sessionId: "sess-abort-iso",
			cwd,
			swarmsRoot,
			sessionFactory: async (ctx) => {
				const session = new MockWorkerSession(ctx, async (_p, s) => {
					if (ctx.member.name === "w1") {
						await new Promise<void>((resolve) => {
							releaseW1 = resolve;
						});
					} else if (ctx.member.name === "w2") {
						await new Promise<void>((resolve) => {
							releaseW2 = resolve;
						});
						s.emitAssistantSuccess("w2 finished undisturbed");
					} else {
						s.emitAssistantSuccess("idle ready");
					}
				});
				sessions.set(ctx.member.name, session);
				return session;
			},
		});
		managersToDispose.push(manager);
		manager.updateHostContext(hostCtx);

		// Coordinator is actively working
		manager.onCoordinatorRunStart();
		await manager.addWorkers({ name: "w1", brief: "Long task 1" }, "coordinator", hostCtx);
		await manager.addWorkers({ name: "w2", brief: "Long task 2" }, "coordinator", hostCtx);
		await manager.addWorkers({ name: "w3", brief: "Idle worker" }, "coordinator", hostCtx);
		await waitForCondition(() => releaseW1 !== undefined && releaseW2 !== undefined);
		await flushMicrotasks();

		// Queue a board post to w1 while working to verify abort does not auto-restart a loop
		manager.postMessage("coordinator", "@w1 extra post");

		// Cannot switch model while working
		await expect(manager.switchWorkerModelByUser("w1", "p/b")).rejects.toThrow(/while it is working/);

		// Abort ONLY w1
		const abortRes = await manager.abortWorkerByUser("w1");
		expect(abortRes).toEqual({ aborted: true, state: "waiting" });
		expect(sessions.get("w1")?.abortedCount).toBe(1);
		expect(manager.getBoard().getMember("w1")?.state).toBe("waiting");
		expect(manager.getBoard().getMember("w1")?.lastError).toBeUndefined();
		expect(sessions.get("w1")?.prompts).toHaveLength(1);

		// Coordinator and w2 are completely unaffected
		expect(manager.getBoard().getState().coordinator.state).toBe("working");
		expect(manager.getBoard().getMember("w2")?.state).toBe("working");
		expect(sessions.get("w2")?.abortedCount).toBe(0);

		// Now w1 is waiting -> can switch model cleanly and emits snapshot
		let switchedModelSnap: string | undefined;
		manager.subscribe((snap) => {
			switchedModelSnap = snap.members.find((m) => m.name === "w1")?.model;
		});
		const switchRes = await manager.switchWorkerModelByUser("w1", "p/b");
		expect(switchRes.model).toBe("p/b");
		expect(switchedModelSnap).toBe("p/b");

		// Safe non-error no-op on already-idle waiting and killed workers
		expect(await manager.abortWorkerByUser("w3")).toEqual({ aborted: false, state: "waiting" });
		await manager.killWorkerByUser("w3");
		expect(await manager.abortWorkerByUser("w3")).toEqual({ aborted: false, state: "killed" });
		await expect(manager.switchWorkerModelByUser("w3", "p/a")).rejects.toThrow(/killed/);

		// Unblock w2 and verify it completes normally
		releaseW2!();
		releaseW1!();
		await waitForCondition(() => manager.getBoard().getMember("w2")?.state === "waiting");
		expect(manager.getBoard().getMember("w2")?.usage.turns).toBe(1);
	});

	it("E2E real AgentSession supports getWorkerSession capabilities, private direct steer/followUp, and single-worker abort", async () => {
		const cwd = makeTempDir("pi-swarm-e2e-direct-cwd-");
		const agentDir = makeTempDir("pi-swarm-e2e-direct-agent-");
		const swarmsRoot = makeTempDir("pi-swarm-e2e-direct-root-");

		const faux = registerFauxProvider({
			models: [{ id: "faux-direct-1", name: "Faux Direct", reasoning: false }],
		});
		extraCleanups.push(() => faux.unregister());

		const fauxModel = faux.getModel();
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
		});
		await modelRuntime.setRuntimeApiKey(fauxModel.provider, "faux-key");
		modelRuntime.registerProvider(fauxModel.provider, {
			baseUrl: fauxModel.baseUrl,
			api: fauxModel.api,
			models: [
				{
					id: fauxModel.id,
					name: fauxModel.name,
					api: fauxModel.api,
					reasoning: fauxModel.reasoning,
					input: fauxModel.input,
					cost: fauxModel.cost,
					contextWindow: fauxModel.contextWindow,
					maxTokens: fauxModel.maxTokens,
					baseUrl: fauxModel.baseUrl,
				},
			],
		});

		const coordSm = SessionManager.inMemory(cwd);
		const available = [...modelRuntime.getAvailableSnapshot()];
		const hostCtx = makeFakeExtensionContext(cwd, fauxModel as Model<Api>, available as Model<Api>[], coordSm);

		faux.setResponses([
			fauxAssistantMessage("Initial turn complete."),
			fauxAssistantMessage("Private answer received."),
		]);

		const manager = new SwarmManager({
			sessionId: "sess-e2e-direct",
			cwd,
			agentDir,
			swarmsRoot,
			modelRuntime,
		});
		managersToDispose.push(manager);
		manager.updateHostContext(hostCtx);

		await manager.addWorkers({ name: "helper", brief: "Ready" }, "coordinator", hostCtx);
		await waitForCondition(() => manager.getBoard().getMember("helper")?.state === "waiting", 6000);

		const session = manager.getWorkerSession("helper");
		expect(session).toBeDefined();
		expect(session?.state).toBeDefined();
		expect(session?.settingsManager).toBeDefined();
		expect(session?.resourceLoader).toBeDefined();
		expect(session?.modelRuntime).toBeDefined();
		expect(session?.extensionRunner).toBeDefined();
		expect(typeof session?.getContextUsage).toBe("function");
		expect(typeof session?.steer).toBe("function");
		expect(typeof session?.followUp).toBe("function");
		expect(typeof session?.getSteeringMessages).toBe("function");
		expect(typeof session?.getFollowUpMessages).toBe("function");

		const headBefore = manager.getBoard().head;
		const events: AgentSessionEvent[] = [];
		manager.subscribeWorkerEvents("helper", (ev) => events.push(ev));

		await manager.sendDirectWorkerMessage("helper", "Hello privately");
		await waitForCondition(
			() =>
				manager.getBoard().getMember("helper")?.state === "waiting" &&
				events.some((e) => e.type === "agent_settled"),
			6000,
		);

		expect(manager.getBoard().head).toBe(headBefore);
		expect(manager.getWorkerMessages("helper").some((m) => JSON.stringify(m).includes("Private answer received."))).toBe(
			true,
		);

		// Idle abort is a safe no-op
		expect(await manager.abortWorkerByUser("helper")).toEqual({ aborted: false, state: "waiting" });
	});

	it("clears native/tracked and fallback queued messages on abortWorkerByUser and rejects model switch if killed during setModel", async () => {
		const cwd = makeTempDir("pi-swarm-abort-queue-cwd-");
		const swarmsRoot = makeTempDir("pi-swarm-abort-queue-root-");
		const modelA = makeModel("p", "a");
		const modelB = makeModel("p", "b");
		const hostCtx = makeFakeExtensionContext(cwd, modelA, [modelA, modelB], SessionManager.inMemory(cwd));

		let releaseWork: (() => void) | undefined;
		let releaseSetModel: (() => void) | undefined;

		class NativeQueueAbortSession extends MockWorkerSession {
			steeringQueue: string[] = [];
			followUpQueue: string[] = [];

			async steer(text: string): Promise<"queued"> {
				this.steeringQueue.push(text);
				return "queued";
			}

			async followUp(text: string): Promise<"queued"> {
				this.followUpQueue.push(text);
				return "queued";
			}

			getSteeringMessages(): readonly string[] {
				return this.steeringQueue;
			}

			getFollowUpMessages(): readonly string[] {
				return this.followUpQueue;
			}

			clearQueue(): { steering: string[]; followUp: string[] } {
				const steering = [...this.steeringQueue];
				const followUp = [...this.followUpQueue];
				this.steeringQueue = [];
				this.followUpQueue = [];
				return { steering, followUp };
			}
		}

		class TrackedOnlySession extends MockWorkerSession {
			async steer(): Promise<"queued"> {
				return "queued";
			}
		}

		const manager = new SwarmManager({
			sessionId: "sess-abort-queue",
			cwd,
			swarmsRoot,
			sessionFactory: async (ctx) => {
				if (ctx.member.name === "native-q") {
					return new NativeQueueAbortSession(ctx, async (_p, s) => {
						await new Promise<void>((resolve) => {
							releaseWork = resolve;
						});
						s.emitAssistantSuccess("done");
					});
				}
				if (ctx.member.name === "tracked-q") {
					return new TrackedOnlySession(ctx, async () => {
						await new Promise<void>(() => {});
					});
				}
				const s = new MockWorkerSession(ctx, (_p, sess) => sess.emitAssistantSuccess("ok"));
				s.setModel = async () => {
					await new Promise<void>((resolve) => {
						releaseSetModel = resolve;
					});
				};
				return s;
			},
		});
		managersToDispose.push(manager);
		manager.updateHostContext(hostCtx);

		await manager.addWorkers({ name: "native-q", brief: "Work" }, "coordinator", hostCtx);
		await manager.addWorkers({ name: "tracked-q", brief: "Work 2" }, "coordinator", hostCtx);
		await manager.addWorkers({ name: "race-w", brief: "Work 3" }, "coordinator", hostCtx);
		await waitForCondition(() => releaseWork !== undefined);
		await flushMicrotasks();

		await manager.sendDirectWorkerMessage("native-q", "steer-msg", "steer");
		await manager.sendDirectWorkerMessage("native-q", "follow-msg", "followUp");
		await manager.sendDirectWorkerMessage("tracked-q", "tracked-steer", "steer");

		expect(manager.getWorkerQueuedMessages("native-q")).toEqual({
			steering: ["steer-msg"],
			followUp: ["follow-msg"],
		});
		expect(manager.getWorkerQueuedMessages("tracked-q")).toEqual({
			steering: ["tracked-steer"],
			followUp: [],
		});

		const queueEvents: Array<{ steering: readonly string[]; followUp: readonly string[] }> = [];
		manager.subscribeWorkerEvents("native-q", (ev) => {
			if (ev.type === "queue_update") {
				queueEvents.push({ steering: [...ev.steering], followUp: [...ev.followUp] });
			}
		});

		const abortRes = await manager.abortWorkerByUser("native-q");
		expect(abortRes).toEqual({ aborted: true, state: "waiting" });
		expect(manager.getWorkerQueuedMessages("native-q")).toEqual({ steering: [], followUp: [] });
		expect(queueEvents.some((e) => e.steering.length === 0 && e.followUp.length === 0)).toBe(true);

		await manager.abortWorkerByUser("tracked-q");
		expect(manager.getWorkerQueuedMessages("tracked-q")).toEqual({ steering: [], followUp: [] });

		releaseWork!();

		// Race killWorkerByUser against in-flight switchWorkerModelByUser
		const switchPromise = manager.switchWorkerModelByUser("race-w", "p/b");
		await waitForCondition(() => releaseSetModel !== undefined);
		await manager.killWorkerByUser("race-w");
		releaseSetModel!();
		await expect(switchPromise).rejects.toThrow(/killed/);
		expect(manager.getBoard().getMember("race-w")?.state).toBe("killed");
	});

	it("clears stranded queue and rejects if abortWorkerByUser or killWorkerByUser runs while async steer() awaits", async () => {
		const cwd = makeTempDir("pi-swarm-async-steer-cwd-");
		const swarmsRoot = makeTempDir("pi-swarm-async-steer-root-");
		const modelA = makeModel("p", "a");
		const hostCtx = makeFakeExtensionContext(cwd, modelA, [modelA], SessionManager.inMemory(cwd));

		let releaseSteerAbort: (() => void) | undefined;
		let releaseSteerKill: (() => void) | undefined;

		class SlowSteerSession extends MockWorkerSession {
			steeringQueue: string[] = [];
			private gate: (release: () => void) => void;

			constructor(ctx: CreateWorkerSessionContext, gate: (release: () => void) => void) {
				super(ctx, async () => {
					await new Promise<void>(() => {});
				});
				this.gate = gate;
			}

			async steer(text: string): Promise<"queued"> {
				await new Promise<void>((resolve) => {
					this.gate(resolve);
				});
				this.steeringQueue.push(text);
				return "queued";
			}

			getSteeringMessages(): readonly string[] {
				return this.steeringQueue;
			}

			clearQueue(): { steering: string[]; followUp: string[] } {
				const steering = [...this.steeringQueue];
				this.steeringQueue = [];
				return { steering, followUp: [] };
			}
		}

		const manager = new SwarmManager({
			sessionId: "sess-async-steer-race",
			cwd,
			swarmsRoot,
			sessionFactory: async (ctx) => {
				if (ctx.member.name === "w-abort") {
					return new SlowSteerSession(ctx, (r) => {
						releaseSteerAbort = r;
					});
				}
				return new SlowSteerSession(ctx, (r) => {
					releaseSteerKill = r;
				});
			},
		});
		managersToDispose.push(manager);
		manager.updateHostContext(hostCtx);

		await manager.addWorkers({ name: "w-abort", brief: "Work" }, "coordinator", hostCtx);
		await manager.addWorkers({ name: "w-kill", brief: "Work 2" }, "coordinator", hostCtx);
		await flushMicrotasks();

		const abortSteerPromise = manager.sendDirectWorkerMessage("w-abort", "late-steer", "steer");
		await waitForCondition(() => releaseSteerAbort !== undefined);
		await manager.abortWorkerByUser("w-abort");
		releaseSteerAbort!();
		await expect(abortSteerPromise).rejects.toThrow(/stopped working/);
		expect(manager.getBoard().getMember("w-abort")?.state).toBe("waiting");
		expect(manager.getWorkerQueuedMessages("w-abort")).toEqual({ steering: [], followUp: [] });

		const killEvents: string[] = [];
		manager.subscribeWorkerEvents("w-kill", (ev) => killEvents.push(ev.type));
		const killSteerPromise = manager.sendDirectWorkerMessage("w-kill", "dead-steer", "steer");
		await waitForCondition(() => releaseSteerKill !== undefined);
		await manager.killWorkerByUser("w-kill");
		const eventsBeforeResolve = killEvents.length;
		releaseSteerKill!();
		await expect(killSteerPromise).rejects.toThrow(/killed/);
		expect(killEvents.slice(eventsBeforeResolve)).not.toContain("queue_update");
	});
});

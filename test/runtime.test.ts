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

	private emit(event: AgentSessionEvent): void {
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
});

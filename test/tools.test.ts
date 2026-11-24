import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type {
	ExtensionContext,
	ExtensionToolContext,
	ModelRegistry,
	Theme,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { TSchema } from "typebox";
import { Value } from "typebox/value";
import { afterEach, describe, expect, it } from "vitest";
import { type CreateWorkerSessionContext, SwarmManager, type WorkerSessionHandle } from "../src/runtime.ts";
import {
	BashToolParams,
	createSwarmToolDefinitions,
	ManageProcessToolParams,
	ManageTaskToolParams,
	PostMessageToolParams,
	ReadBoardToolParams,
	ScheduleToolParams,
	SwarmToolParams,
	SwarmWaitToolParams,
} from "../src/tools.ts";

const tempDirs: string[] = [];
const managersToDispose: SwarmManager[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function makeModel(provider = "p", id = "m1"): Model<Api> {
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

function makeToolContext(cwd: string, models: Model<Api>[]): ExtensionToolContext {
	const sm = SessionManager.inMemory(cwd);
	const registry = {
		getAvailable: () => models,
		getAll: () => models,
		find: (provider: string, id: string) => models.find((m) => m.provider === provider && m.id === id),
		hasConfiguredAuth: () => true,
	} as unknown as ModelRegistry;

	return {
		cwd,
		model: models[0],
		scopedModels: [{ model: models[0] }],
		modelRegistry: registry,
		sessionManager: sm,
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
		tools: [],
		executeTool: async () => {
			throw new Error("nested executeTool not used in test");
		},
	};
}

function makeFakeSession(ctx: CreateWorkerSessionContext): WorkerSessionHandle {
	const workersDir = join(ctx.swarmDir, "workers");
	const sm = SessionManager.open(ctx.member.sessionFile, workersDir, ctx.member.workspacePath);
	let currentModel = ctx.model;
	return {
		sessionId: sm.getSessionId(),
		sessionFile: ctx.member.sessionFile,
		get model() {
			return currentModel;
		},
		isStreaming: false,
		isIdle: true,
		messages: [],
		sessionManager: sm,
		getActiveToolNames: () => [],
		setActiveToolsByName: () => {},
		setModel: async (m) => {
			currentModel = m;
		},
		prompt: async () => {},
		abort: async () => {},
		dispose: () => {},
		subscribe: () => () => {},
	};
}

type AnyToolRenderContext = Parameters<NonNullable<ToolDefinition<TSchema>["renderCall"]>>[2];

function makeRenderCtx<TArgs>(args: TArgs): AnyToolRenderContext & { args: TArgs } {
	return {
		args,
		toolCallId: "t1",
		invalidate: () => {},
		lastComponent: undefined,
		state: {},
		cwd: "/tmp",
		executionStarted: true,
		argsComplete: true,
		isPartial: false,
		expanded: false,
		showImages: false,
		isError: false,
		durationMs: 12,
		outputPad: 0,
		keyText: () => "",
		keyHint: () => "",
	};
}

afterEach(() => {
	while (managersToDispose.length > 0) {
		managersToDispose.pop()!.dispose();
	}
	while (tempDirs.length > 0) {
		rmSync(tempDirs.pop()!, { recursive: true, force: true });
	}
});

describe("swarm tool schemas and registration", () => {
	it("registers 4 coordinator tools with defaultActive=false and 6 tools for monitor", () => {
		const coordTools = createSwarmToolDefinitions({
			getManager: () => undefined,
			callerName: "coordinator",
			defaultActive: false,
		});
		expect(coordTools.all.map((t) => t.name)).toEqual(["swarm", "post_message", "read_board", "swarm_wait"]);
		expect(coordTools.all.every((t) => t.defaultActive === false)).toBe(true);
		expect(coordTools.schedule).toBeUndefined();
		expect(coordTools.manage_task).toBeUndefined();

		const monitorTools = createSwarmToolDefinitions({
			getManager: () => undefined,
			callerName: "monitor",
			defaultActive: true,
		});
		expect(monitorTools.all.map((t) => t.name)).toEqual([
			"swarm",
			"post_message",
			"read_board",
			"swarm_wait",
			"schedule",
			"manage_task",
		]);
		expect(monitorTools.all.every((t) => t.defaultActive === true)).toBe(true);
	});

	it("validates TypeBox schemas for all swarm tools", () => {
		expect(Value.Check(SwarmToolParams, { action: "add", name: "parser", brief: "Parse", tasks: ["a", "b"] })).toBe(
			true,
		);
		expect(
			Value.Check(SwarmToolParams, {
				action: "plan",
				goal: { title: "Ship parser", line: "Split and verify." },
				tasks: { parser: "Build parser" },
				threads: [{ id: "t-1", title: "Parser", goal: "Works", tasks: ["parser"] }],
			}),
		).toBe(true);
		expect(Value.Check(SwarmToolParams, { action: "invalid" })).toBe(false);

		expect(Value.Check(PostMessageToolParams, { text: "@parser go", channel: "main" })).toBe(true);
		expect(Value.Check(ReadBoardToolParams, { since: 0, limit: 10, status: true })).toBe(true);
		expect(Value.Check(SwarmWaitToolParams, { since: 2, mentions_only: false })).toBe(true);
		expect(Value.Check(ScheduleToolParams, { CronExpression: "*/3 * * * *", IsDaemon: true, Prompt: "tick" })).toBe(
			true,
		);
		expect(Value.Check(ManageTaskToolParams, { Action: "list" })).toBe(true);
		expect(Value.Check(ManageTaskToolParams, { Action: "kill", TaskId: "sched-1" })).toBe(true);
	});
});

describe("swarm tool execution and rendering", () => {
	it("executes all coordinator swarm, board, wait, and monitor tools end-to-end", async () => {
		const cwd = makeTempDir("pi-tools-cwd-");
		const swarmsRoot = makeTempDir("pi-tools-root-");
		const m1 = makeModel("p", "m1");
		const m2 = makeModel("p", "m2");
		const ctx = makeToolContext(cwd, [m1, m2]);

		const manager = new SwarmManager({
			sessionId: "sess-tools",
			cwd,
			swarmsRoot,
			sessionFactory: async (wCtx) => makeFakeSession(wCtx),
		});
		managersToDispose.push(manager);

		const coordTools = createSwarmToolDefinitions({
			getManager: () => manager,
			callerName: "coordinator",
			defaultActive: false,
		});

		// Title
		const titleRes = await coordTools.swarm.execute("c1", { action: "title", title: "Test Swarm" }, undefined, undefined, ctx);
		expect((titleRes.content[0] as { text: string }).text).toContain("Test Swarm");

		// Models (scoped vs all)
		const scopedRes = await coordTools.swarm.execute("c2", { action: "models" }, undefined, undefined, ctx);
		expect((scopedRes.content[0] as { text: string }).text).toContain("p/m1");
		expect((scopedRes.content[0] as { text: string }).text).not.toContain("p/m2");

		const allModelsRes = await coordTools.swarm.execute("c3", { action: "models", all: true }, undefined, undefined, ctx);
		expect((allModelsRes.content[0] as { text: string }).text).toContain("p/m2");

		// Channel create + list
		await coordTools.swarm.execute("c4", { action: "channel", op: "create", channel: "api", topic: "API work" }, undefined, undefined, ctx);
		const chList = await coordTools.swarm.execute("c5", { action: "channel", op: "list" }, undefined, undefined, ctx);
		expect((chList.content[0] as { text: string }).text).toContain("#api");

		// Add worker + monitor
		const addRes = await coordTools.swarm.execute(
			"c6",
			{ action: "add", name: "api-dev", brief: "Implement routes", channels: ["api"] },
			undefined,
			undefined,
			ctx,
		);
		expect((addRes.content[0] as { text: string }).text).toContain("Added api-dev in #api");
		await coordTools.swarm.execute("c7", { action: "add", name: "monitor", brief: "Monitor" }, undefined, undefined, ctx);

		// Plan
		const planRes = await coordTools.swarm.execute(
			"c8",
			{
				action: "plan",
				goal: { title: "Build API routes cleanly", line: "Implement and test endpoints." },
				tasks: { "api-dev": "Build routes" },
				threads: [{ id: "t-api", title: "API", goal: "Routes pass", tasks: ["api-dev"] }],
			},
			undefined,
			undefined,
			ctx,
		);
		expect((planRes.content[0] as { text: string }).text).toContain("Build API routes cleanly");

		// Status
		const statusRes = await coordTools.swarm.execute("c9", { action: "status" }, undefined, undefined, ctx);
		expect((statusRes.content[0] as { text: string }).text).toContain("api-dev");

		// Post & Read board
		const postRes = await coordTools.post_message.execute("c10", { text: "@coordinator [done] routes ready", channel: "api" }, undefined, undefined, ctx);
		expect((postRes.content[0] as { text: string }).text).toContain("Posted #3 to #api");

		const readRes = await coordTools.read_board.execute("c11", { since: 0 }, undefined, undefined, ctx);
		expect((readRes.content[0] as { text: string }).text).toContain("routes ready");

		// Monitor tools
		const monTools = createSwarmToolDefinitions({
			getManager: () => manager,
			callerName: "monitor",
			includeMonitorTools: true,
		});
		const schedRes = await monTools.schedule!.execute(
			"m1",
			{ CronExpression: "*/3 * * * *", IsDaemon: true, Prompt: "check stall" },
			undefined,
			undefined,
			ctx,
		);
		const taskId = (schedRes.details as { taskId: string }).taskId;
		const listTasksRes = await monTools.manage_task!.execute("m2", { Action: "list" }, undefined, undefined, ctx);
		expect((listTasksRes.content[0] as { text: string }).text).toContain(taskId);
		const killTaskRes = await monTools.manage_task!.execute("m3", { Action: "kill", TaskId: taskId }, undefined, undefined, ctx);
		expect((killTaskRes.content[0] as { text: string }).text).toContain(`Killed scheduled task ${taskId}`);

		// read_board status:true for monitor
		const monStatus = await monTools.read_board.execute("m4", { status: true }, undefined, undefined, ctx);
		expect((monStatus.content[0] as { text: string }).text).toContain("Board head: #3");

		// Non-monitor cannot invoke schedule even if tool instance exists
		const rogueSchedule = createSwarmToolDefinitions({
			getManager: () => manager,
			callerName: "api-dev",
			includeMonitorTools: true,
		}).schedule!;
		await expect(
			rogueSchedule.execute("r1", { DurationSeconds: 10, Prompt: "rogue" }, undefined, undefined, ctx),
		).rejects.toThrow(/restricted to monitor/);

		// swarm_wait returns parked notice when caught up
		const waitRes = await coordTools.swarm_wait.execute("c12", { since: 3 }, undefined, undefined, ctx);
		expect((waitRes.details as { parked: boolean }).parked).toBe(true);

		// Kill worker
		const killRes = await coordTools.swarm.execute("c13", { action: "kill", name: "api-dev" }, undefined, undefined, ctx);
		expect((killRes.content[0] as { text: string }).text).toContain("Killed api-dev");

		// RenderCall & RenderResult smoke checks
		const mockTheme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme;
		expect(coordTools.swarm.renderCall!({ action: "add", name: "x" }, mockTheme, makeRenderCtx({ action: "add", name: "x" })).render(80)[0]).toContain("swarm");
		expect(coordTools.swarm.renderResult!(addRes, { expanded: false, isPartial: false }, mockTheme, makeRenderCtx({ action: "add", name: "x" })).render(80)[0]).toContain("Added api-dev");
		expect(coordTools.post_message.renderCall!({ text: "hello" }, mockTheme, makeRenderCtx({ text: "hello" })).render(80)[0]).toContain("post_message");
		expect(coordTools.read_board.renderCall!({ status: true }, mockTheme, makeRenderCtx({ status: true })).render(80)[0]).toContain("read_board");
		expect(coordTools.swarm_wait.renderCall!({ since: 1 }, mockTheme, makeRenderCtx({ since: 1 })).render(80)[0]).toContain("swarm_wait");
		expect(monTools.schedule!.renderCall!({ CronExpression: "*/3 * * * *", Prompt: "tick" }, mockTheme, makeRenderCtx({ CronExpression: "*/3 * * * *", Prompt: "tick" })).render(80)[0]).toContain("schedule");
		expect(monTools.manage_task!.renderCall!({ Action: "list" }, mockTheme, makeRenderCtx({ Action: "list" })).render(80)[0]).toContain("manage_task");
	});

	it("registers worker async bash and manage_process tools and excludes them from monitor", () => {
		const workerTools = createSwarmToolDefinitions({
			getManager: () => undefined,
			callerName: "verifier",
			defaultActive: true,
			includeWorkerProcessTools: true,
		});
		expect(workerTools.all.map((t) => t.name)).toEqual([
			"swarm",
			"post_message",
			"read_board",
			"swarm_wait",
			"bash",
			"manage_process",
		]);
		expect(workerTools.bash).toBeDefined();
		expect(workerTools.manage_process).toBeDefined();
		expect(workerTools.schedule).toBeUndefined();

		const monitorTools = createSwarmToolDefinitions({
			getManager: () => undefined,
			callerName: "monitor",
			defaultActive: true,
			includeWorkerProcessTools: true,
		});
		expect(monitorTools.all.map((t) => t.name)).toEqual([
			"swarm",
			"post_message",
			"read_board",
			"swarm_wait",
			"schedule",
			"manage_task",
		]);
		expect(monitorTools.bash).toBeUndefined();
		expect(monitorTools.manage_process).toBeUndefined();

		expect(Value.Check(BashToolParams, { command: "echo hi", wait_ms: 5000, is_daemon: false, notify_after_seconds: 10 })).toBe(true);
		expect(Value.Check(BashToolParams, { command: "echo hi", wait_ms: 45000 })).toBe(false);
		expect(Value.Check(BashToolParams, { command: "echo hi", notify_after_seconds: 0 })).toBe(false);
		expect(Value.Check(ManageProcessToolParams, { action: "list" })).toBe(true);
		expect(Value.Check(ManageProcessToolParams, { action: "send_input", task_id: "proc-1", input: "hello\n" })).toBe(true);
		expect(Value.Check(ManageProcessToolParams, { action: "invalid" })).toBe(false);
	});

	it("executes async bash, manage_process loop, isolation, status formatting, and renderers", async () => {
		const cwd = makeTempDir("pi-tools-proc-cwd-");
		const swarmsRoot = makeTempDir("pi-tools-proc-root-");
		const m1 = makeModel("p", "m1");
		const ctx = makeToolContext(cwd, [m1]);

		const manager = new SwarmManager({
			sessionId: "sess-tools-proc",
			cwd,
			swarmsRoot,
			sessionFactory: async (wCtx) => makeFakeSession(wCtx),
		});
		managersToDispose.push(manager);

		await manager.addWorkers({ name: "alpha", brief: "Alpha work" }, "coordinator", ctx);
		await manager.addWorkers({ name: "beta", brief: "Beta work" }, "coordinator", ctx);
		await manager.addWorkers({ name: "monitor", brief: "Monitor" }, "coordinator", ctx);

		const coordTools = createSwarmToolDefinitions({
			getManager: () => manager,
			callerName: "coordinator",
			defaultActive: false,
		});
		const alphaTools = createSwarmToolDefinitions({
			getManager: () => manager,
			callerName: "alpha",
			defaultActive: true,
			includeWorkerProcessTools: true,
		});
		const betaTools = createSwarmToolDefinitions({
			getManager: () => manager,
			callerName: "beta",
			defaultActive: true,
			includeWorkerProcessTools: true,
		});
		const monitorTools = createSwarmToolDefinitions({
			getManager: () => manager,
			callerName: "monitor",
			defaultActive: true,
			includeMonitorTools: true,
		});

		// Sync fast command
		const fastRes = await alphaTools.bash!.execute(
			"b1",
			{ command: `node -e "console.log('fast-ok')"`, wait_ms: 5000 },
			undefined,
			undefined,
			ctx,
		);
		expect((fastRes.content[0] as { text: string }).text).toContain("Command exited with code 0");
		expect((fastRes.content[0] as { text: string }).text).toContain("fast-ok");
		expect((fastRes.details as { status: string }).status).toBe("exited");

		// Sync non-zero command marks isError
		const failRes = await alphaTools.bash!.execute(
			"b2",
			{ command: `node -e "console.error('boom'); process.exit(3)"`, wait_ms: 5000 },
			undefined,
			undefined,
			ctx,
		);
		expect((failRes as { isError?: boolean }).isError).toBe(true);
		expect((failRes.content[0] as { text: string }).text).toContain("code 3");

		// Slow interactive command promotes to background at wait_ms
		const slowCmd = `node -e "console.log('booting'); process.stdin.setEncoding('utf8'); process.stdin.on('data', d => { process.stdout.write('echo:' + d.trim() + '\\n'); if (d.trim() === 'quit') process.exit(0); }); setInterval(() => {}, 1000);"`;
		const bgRes = await alphaTools.bash!.execute(
			"b3",
			{ command: slowCmd, wait_ms: 150, is_daemon: true },
			undefined,
			undefined,
			ctx,
		);
		const bgText = (bgRes.content[0] as { text: string }).text;
		const bgDetails = bgRes.details as { status: string; taskId: string; isDaemon: boolean };
		expect(bgDetails.status).toBe("running");
		expect(bgDetails.isDaemon).toBe(true);
		expect(bgText).toContain(bgDetails.taskId);
		expect(bgText).toContain("Daemon mode is enabled");

		// Non-daemon promotion returns no-polling instruction
		const nonDaemonCmd = `node -e "setTimeout(() => process.exit(0), 2000)"`;
		const ndRes = await alphaTools.bash!.execute(
			"b4",
			{ command: nonDaemonCmd, wait_ms: 80, notify_after_seconds: 10 },
			undefined,
			undefined,
			ctx,
		);
		const ndText = (ndRes.content[0] as { text: string }).text;
		const ndDetails = ndRes.details as { status: string; taskId: string };
		expect(ndText).toContain("Do NOT poll manage_process in a loop");

		// swarm{action:"status"} and read_board{status:true} both show active background processes
		const coordStatusText = (
			(await coordTools.swarm.execute("s1", { action: "status" }, undefined, undefined, ctx)).content[0] as { text: string }
		).text;
		expect(coordStatusText).toContain(bgDetails.taskId);
		expect(coordStatusText).toContain("daemon=true");
		expect(coordStatusText).toContain(ndDetails.taskId);
		expect(coordStatusText).toContain("daemon=false");

		const monStatusText = (
			(await monitorTools.read_board.execute("m1", { status: true }, undefined, undefined, ctx)).content[0] as { text: string }
		).text;
		expect(monStatusText).toContain(bgDetails.taskId);
		expect(monStatusText).toContain("daemon=true");
		expect(monStatusText).toContain("elapsed=");
		expect(monStatusText).toContain("silent=");

		// manage_process: list, send_input, status, kill
		const listRes = await alphaTools.manage_process!.execute("p1", { action: "list" }, undefined, undefined, ctx);
		expect((listRes.content[0] as { text: string }).text).toContain(bgDetails.taskId);

		const sendRes = await alphaTools.manage_process!.execute(
			"p2",
			{ action: "send_input", task_id: bgDetails.taskId, input: "hello\n" },
			undefined,
			undefined,
			ctx,
		);
		expect((sendRes.content[0] as { text: string }).text).toContain("Sent 6 bytes");

		await new Promise((r) => setTimeout(r, 120));
		const statRes = await alphaTools.manage_process!.execute(
			"p3",
			{ action: "status", task_id: bgDetails.taskId },
			undefined,
			undefined,
			ctx,
		);
		expect((statRes.content[0] as { text: string }).text).toContain("echo:hello");

		// Cross-worker isolation enforced
		await expect(
			betaTools.manage_process!.execute("p4", { action: "status", task_id: bgDetails.taskId }, undefined, undefined, ctx),
		).rejects.toThrow(/Permission denied/);
		await expect(
			betaTools.manage_process!.execute("p5", { action: "kill", task_id: bgDetails.taskId }, undefined, undefined, ctx),
		).rejects.toThrow(/Permission denied/);

		// Kill both processes
		const killBg = await alphaTools.manage_process!.execute(
			"p6",
			{ action: "kill", task_id: bgDetails.taskId },
			undefined,
			undefined,
			ctx,
		);
		expect((killBg.content[0] as { text: string }).text).toContain(`Killed background process ${bgDetails.taskId}`);
		await alphaTools.manage_process!.execute("p7", { action: "kill", task_id: ndDetails.taskId }, undefined, undefined, ctx);

		// RenderCall & RenderResult smoke checks for bash and manage_process
		const mockTheme = {
			fg: (_color: string, text: string) => text,
			bold: (text: string) => text,
		} as unknown as Theme;
		expect(
			alphaTools.bash!
				.renderCall!(
					{ command: "npm test", wait_ms: 5000, is_daemon: true },
					mockTheme,
					makeRenderCtx({ command: "npm test", wait_ms: 5000, is_daemon: true }),
				)
				.render(80)[0],
		).toContain("bash");
		expect(
			alphaTools.bash!
				.renderResult!(bgRes, { expanded: false, isPartial: false }, mockTheme, makeRenderCtx({ command: slowCmd }))
				.render(80)[0],
		).toContain(bgDetails.taskId);
		expect(
			alphaTools.manage_process!
				.renderCall!({ action: "kill", task_id: bgDetails.taskId }, mockTheme, makeRenderCtx({ action: "kill", task_id: bgDetails.taskId }))
				.render(80)[0],
		).toContain("manage_process");
		expect(
			alphaTools.manage_process!
				.renderResult!(killBg, { expanded: false, isPartial: false }, mockTheme, makeRenderCtx({ action: "kill", task_id: bgDetails.taskId }))
				.render(80)[0],
		).toContain("Killed background process");
	});
});

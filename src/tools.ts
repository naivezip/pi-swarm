import { type Static, StringEnum, Type } from "@earendil-works/pi-ai";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
	ExtensionContext,
	ExtensionToolContext,
	ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import type { SwarmManager } from "./runtime.ts";
import {
	isMonitorName,
	type ManageTaskResult,
	type ScheduleResult,
	type SwarmPlan,
	type WorkspaceMode,
} from "./types.ts";

export const SwarmPlanGoalSchema = Type.Object({
	title: Type.String({ description: "Short 4-8 word goal title" }),
	line: Type.String({ description: "One-line goal summary (<= 12 words)" }),
});

export const SwarmPlanThreadSchema = Type.Object({
	id: Type.String({ description: "Stable thread ID (e.g. t-parser)" }),
	title: Type.String({ description: "Outcome-focused thread title" }),
	goal: Type.String({ description: "Outcome this thread delivers" }),
	tasks: Type.Array(Type.String({ description: "Member name assigned to this thread" })),
});

export const SwarmToolParams = Type.Object({
	action: StringEnum(["status", "models", "add", "model", "kill", "title", "channel", "plan"] as const, {
		description: "Swarm management action",
	}),
	name: Type.Optional(Type.String({ description: "Worker or group name" })),
	brief: Type.Optional(Type.String({ description: "Initial assignment brief for add" })),
	model: Type.Optional(Type.String({ description: "Model reference (provider/id or id) for add/model" })),
	workspace: Type.Optional(
		StringEnum(["inherit", "share", "branch"] as const, {
			description: "Workspace isolation mode for add",
		}),
	),
	fork: Type.Optional(Type.String({ description: 'Member name or "coordinator" to fork session history from' })),
	channels: Type.Optional(Type.Array(Type.String({ description: "Channel name to subscribe worker to" }))),
	tasks: Type.Optional(
		Type.Union([
			Type.Array(Type.String({ description: "Per-worker slice task for sharded add" })),
			Type.Record(Type.String(), Type.String(), { description: "Per-worker task summary map for plan" }),
		]),
	),
	n: Type.Optional(Type.Integer({ minimum: 1, description: "Number of homogeneous worker copies to spawn" })),
	all: Type.Optional(Type.Boolean({ description: "When true for models, list all available registry models" })),
	title: Type.Optional(Type.String({ description: "Swarm display title for title action" })),
	op: Type.Optional(
		StringEnum(["create", "list", "subscribe", "unsubscribe", "archive"] as const, {
			description: "Channel operation for channel action",
		}),
	),
	channel: Type.Optional(Type.String({ description: "Target channel name" })),
	topic: Type.Optional(Type.String({ description: "Channel topic description for channel create" })),
	goal: Type.Optional(SwarmPlanGoalSchema),
	threads: Type.Optional(Type.Array(SwarmPlanThreadSchema)),
});

export type SwarmToolInput = Static<typeof SwarmToolParams>;

export const PostMessageToolParams = Type.Object({
	text: Type.String({ description: "Message text to post to the swarm board" }),
	channel: Type.Optional(Type.String({ description: "Target channel (defaults to caller primary channel or main)" })),
});

export type PostMessageToolInput = Static<typeof PostMessageToolParams>;

export const ReadBoardToolParams = Type.Object({
	since: Type.Optional(Type.Integer({ minimum: 0, description: "Return messages with seq > since" })),
	limit: Type.Optional(Type.Integer({ minimum: 1, description: "Maximum number of messages to return" })),
	channel: Type.Optional(Type.String({ description: 'Channel name, or "*" for all visible channels' })),
	status: Type.Optional(Type.Boolean({ description: "When true, return detailed member/channel status snapshot" })),
});

export type ReadBoardToolInput = Static<typeof ReadBoardToolParams>;

export const SwarmWaitToolParams = Type.Object({
	since: Type.Optional(Type.Integer({ minimum: 0, description: "Board seq cursor to wait after" })),
	mentions_only: Type.Optional(
		Type.Boolean({ description: "Wake only on @name/@group/@all/@#channel (default true)" }),
	),
});

export type SwarmWaitToolInput = Static<typeof SwarmWaitToolParams>;

export const ScheduleToolParams = Type.Object({
	CronExpression: Type.Optional(Type.String({ description: "Standard 5-field cron expression" })),
	DurationSeconds: Type.Optional(Type.Number({ exclusiveMinimum: 0, description: "One-shot delay in seconds" })),
	IsDaemon: Type.Optional(Type.Boolean({ description: "Whether cron keeps running while idle" })),
	Prompt: Type.String({ description: "Wake prompt delivered when the timer or cron fires" }),
});

export type ScheduleToolInput = Static<typeof ScheduleToolParams>;

export const ManageTaskToolParams = Type.Object({
	Action: StringEnum(["list", "kill"] as const, { description: "Task management action" }),
	TaskId: Type.Optional(Type.String({ description: "Task ID to kill when Action is kill" })),
});

export type ManageTaskToolInput = Static<typeof ManageTaskToolParams>;

export interface CreateSwarmToolsOptions {
	getManager: () => SwarmManager | undefined;
	ensureManager?: (ctx: ExtensionContext) => SwarmManager;
	callerName: string | (() => string);
	defaultActive?: boolean;
	includeMonitorTools?: boolean;
}

export interface SwarmToolDefinitions {
	swarm: ToolDefinition<typeof SwarmToolParams>;
	post_message: ToolDefinition<typeof PostMessageToolParams>;
	read_board: ToolDefinition<typeof ReadBoardToolParams>;
	swarm_wait: ToolDefinition<typeof SwarmWaitToolParams>;
	schedule?: ToolDefinition<typeof ScheduleToolParams>;
	manage_task?: ToolDefinition<typeof ManageTaskToolParams>;
	all: ToolDefinition[];
}

function resolveCaller(callerName: string | (() => string)): string {
	return typeof callerName === "function" ? callerName() : callerName;
}

function resolveManager(options: CreateSwarmToolsOptions, ctx: ExtensionContext): SwarmManager {
	const existing = options.getManager();
	if (existing) {
		existing.updateHostContext(ctx);
		return existing;
	}
	if (options.ensureManager) {
		const created = options.ensureManager(ctx);
		created.updateHostContext(ctx);
		return created;
	}
	throw new Error("Swarm is not active. Start a swarm with /swarm <task> first.");
}

function formatTextResult(text: string, details: Record<string, unknown> = {}): AgentToolResult<Record<string, unknown>> {
	return {
		content: [{ type: "text", text }],
		details,
	};
}

function formatTimestamp(ms: number): string {
	const d = new Date(ms);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

function renderSimpleText(text: string, lastComponent: unknown): Text {
	const component = lastComponent instanceof Text ? lastComponent : new Text("", 0, 0);
	component.setText(text);
	return component;
}

function extractResultText(result: AgentToolResult<unknown>): string {
	return result.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text")
		.map((block) => block.text)
		.join("\n");
}

function formatSwarmStatus(manager: SwarmManager): string {
	const status = manager.getDetailedStatus();
	const lines: string[] = [
		`Swarm: ${status.title} (${status.swarmId}) | head #${status.head} | active=${status.active}`,
		`Coordinator: state=${status.coordinator.state}, wakeMode=${status.coordinator.wakeMode}, waitSince=#${status.coordinator.waitSince}, lastReadSeq=#${status.coordinator.lastReadSeq}`,
		`Channels: ${status.channels.map((c) => `#${c.name}${c.archived ? " (archived)" : ""}`).join(", ")}`,
	];
	if (status.members.length === 0) {
		lines.push("Members: (none)");
	} else {
		lines.push("Members:");
		for (const m of status.members) {
			const parts = [
				`${m.name}`,
				`state=${m.state}`,
				m.group ? `group=${m.group}` : undefined,
				`addedBy=${m.addedBy}`,
				m.model ? `model=${m.model}` : undefined,
				`ws=${m.workspaceMode}:${m.workspacePath}`,
				m.channels.length > 0 ? `channels=${m.channels.map((c) => `#${c}`).join(",")}` : "channels=#main",
				`wake=${m.wakeMode}@#${m.waitSince}`,
				`read=#${m.lastReadSeq}`,
				m.unreadCount > 0 ? `unread=${m.unreadCount}` : undefined,
				m.lastPostSeq !== undefined ? `lastPost=#${m.lastPostSeq}` : undefined,
				m.currentActivity ? `activity="${m.currentActivity}"` : undefined,
				m.lastError ? `error="${m.lastError}"` : undefined,
			].filter((p): p is string => p !== undefined);
			lines.push(`- ${parts.join(" | ")}`);
		}
	}
	return lines.join("\n");
}

function formatDetailedStatusForMonitor(manager: SwarmManager): string {
	const status = manager.getDetailedStatus();
	const lines: string[] = [
		`Board head: #${status.head} | Swarm: ${status.title} | Active: ${status.active}`,
		`Coordinator: state=${status.coordinator.state} wakeMode=${status.coordinator.wakeMode} waitSince=#${status.coordinator.waitSince} lastReadSeq=#${status.coordinator.lastReadSeq}${
			status.coordinator.lastPostSeq !== undefined
				? ` lastPost=#${status.coordinator.lastPostSeq}@${formatTimestamp(status.coordinator.lastPostTime ?? 0)}`
				: ""
		}`,
	];
	lines.push("Channels:");
	for (const ch of status.channels) {
		lines.push(`- #${ch.name}${ch.archived ? " [archived]" : ""}: ${ch.topic || "(no topic)"}`);
	}
	lines.push("Members:");
	if (status.members.length === 0) {
		lines.push("- (none)");
	} else {
		for (const m of status.members) {
			const lastPost =
				m.lastPostSeq !== undefined
					? `lastPost=#${m.lastPostSeq}@${formatTimestamp(m.lastPostTime ?? 0)}`
					: "lastPost=none";
			const chStr = m.channels.length > 0 ? m.channels.map((c) => `#${c}`).join(",") : "#main";
			lines.push(
				`- ${m.name} | state=${m.state} | wake=${m.wakeMode}(since=#${m.waitSince}) | lastRead=#${m.lastReadSeq} | unread=${m.unreadCount} | ${lastPost} | channels=${chStr}${
					m.currentActivity ? ` | activity=${m.currentActivity}` : ""
				}${m.lastError ? ` | error=${m.lastError}` : ""}`,
			);
		}
	}
	return lines.join("\n");
}

/** Creates the `swarm` management tool definition. */
export function createSwarmTool(options: CreateSwarmToolsOptions): ToolDefinition<typeof SwarmToolParams> {
	const defaultActive = options.defaultActive ?? true;
	return {
		name: "swarm",
		label: "Swarm",
		description:
			"Manage the agent swarm: status, models, add, model, kill, title, channel, and plan.",
		promptSnippet: "Manage swarm workers, models, channels, title, and plan",
		defaultActive,
		parameters: SwarmToolParams,
		async execute(
			_toolCallId: string,
			params: SwarmToolInput,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionToolContext,
		) {
			const caller = resolveCaller(options.callerName);
			const manager = resolveManager(options, ctx);

			switch (params.action) {
				case "status": {
					return formatTextResult(formatSwarmStatus(manager), {
						action: "status",
						status: manager.getDetailedStatus(),
					});
				}
				case "models": {
					const models = manager.listModels({ all: params.all, ctx });
					if (models.length === 0) {
						return formatTextResult("No models available.", { action: "models", models: [] });
					}
					const lines = models.map(
						(m) =>
							`- ${m.provider}/${m.id} (${m.name}) | ctx=${m.contextWindow} | reasoning=${m.reasoning} | cost=$${m.cost.input}/$${m.cost.output}${m.current ? " [current]" : ""}`,
					);
					return formatTextResult(lines.join("\n"), { action: "models", models });
				}
				case "add": {
					if (!params.name || !params.brief) {
						throw new Error('swarm{action:"add"} requires both "name" and "brief".');
					}
					if (params.tasks !== undefined && !Array.isArray(params.tasks)) {
						throw new Error('For swarm{action:"add"}, "tasks" must be an array of task strings.');
					}
					const result = await manager.addWorkers(
						{
							name: params.name,
							brief: params.brief,
							model: params.model,
							workspace: params.workspace as WorkspaceMode | undefined,
							fork: params.fork,
							channels: params.channels,
							tasks: params.tasks,
							n: params.n,
						},
						caller,
						ctx,
					);
					const lines = result.workers.map((w) => {
						const warn = w.dirtyWarning ? ` (warning: ${w.dirtyWarning})` : "";
						return `Added ${w.name} in #${w.channel} (brief #${w.briefSeq}, ws=${w.workspaceMode}:${w.workspacePath}${
							w.workspaceBranch ? ` @ ${w.workspaceBranch}` : ""
						})${warn}`;
					});
					return formatTextResult(lines.join("\n"), { action: "add", ...result });
				}
				case "model": {
					const result = await manager.switchModel(
						{ name: params.name, model: params.model },
						caller,
						ctx,
					);
					return formatTextResult(
						`Switched ${result.target} model to ${result.model}${result.woke ? " and resumed unfinished work." : "."}`,
						{ action: "model", ...result },
					);
				}
				case "kill": {
					if (!params.name) {
						throw new Error('swarm{action:"kill"} requires "name".');
					}
					const result = await manager.killTarget(params.name, caller);
					return formatTextResult(
						`Killed ${result.killed.join(", ")} (permanent).`,
						{ action: "kill", ...result },
					);
				}
				case "title": {
					if (!params.title || !params.title.trim()) {
						throw new Error('swarm{action:"title"} requires a non-empty "title".');
					}
					manager.setTitle(params.title.trim(), caller);
					return formatTextResult(`Swarm title set to "${params.title.trim()}".`, {
						action: "title",
						title: params.title.trim(),
					});
				}
				case "channel": {
					if (!params.op) {
						throw new Error('swarm{action:"channel"} requires "op" (create|list|subscribe|unsubscribe|archive).');
					}
					const result = manager.handleChannelOp(
						{
							op: params.op,
							channel: params.channel,
							topic: params.topic,
							name: params.name,
						},
						caller,
					);
					return formatTextResult(result.summary, { action: "channel", ...result });
				}
				case "plan": {
					if (!params.goal || !params.tasks || Array.isArray(params.tasks) || !params.threads) {
						throw new Error(
							'swarm{action:"plan"} requires "goal" ({title, line}), "tasks" (object mapping worker->task), and "threads" (array).',
						);
					}
					const plan: SwarmPlan = {
						goal: params.goal,
						tasks: params.tasks,
						threads: params.threads,
					};
					manager.setPlan(plan, caller);
					return formatTextResult(
						`Updated plan: "${plan.goal.title}" (${plan.threads.length} threads, ${Object.keys(plan.tasks).length} tasks).`,
						{ action: "plan", plan },
					);
				}
			}
		},
		renderCall(args, theme, context) {
			const detail =
				args.action === "add" && args.name
					? ` ${args.name}${args.workspace ? ` (${args.workspace})` : ""}`
					: args.action === "kill" && args.name
						? ` ${args.name}`
						: args.action === "model"
							? ` ${args.name ?? "self"} -> ${args.model ?? "default"}`
							: args.action === "channel" && args.op
								? ` ${args.op}${args.channel ? ` #${args.channel}` : ""}`
								: args.action === "title" && args.title
									? ` "${args.title}"`
									: "";
			return renderSimpleText(
				`${theme.fg("toolTitle", theme.bold("swarm"))}${theme.fg("accent", ` ${args.action}`)}${theme.fg("muted", detail)}`,
				context.lastComponent,
			);
		},
		renderResult(result, opt, theme, context) {
			const text = extractResultText(result);
			const lines = text.split("\n");
			const preview = opt.expanded ? text : lines.slice(0, 6).join("\n") + (lines.length > 6 ? `\n... (${lines.length - 6} more lines)` : "");
			const color = context.isError ? "error" : "toolOutput";
			return renderSimpleText(theme.fg(color, preview), context.lastComponent);
		},
	};
}

/** Creates the `post_message` board tool definition. */
export function createPostMessageTool(options: CreateSwarmToolsOptions): ToolDefinition<typeof PostMessageToolParams> {
	const defaultActive = options.defaultActive ?? true;
	return {
		name: "post_message",
		label: "Post Message",
		description: "Post a message to the shared swarm board. Use @name, @group, @all, or @#channel to wake recipients.",
		promptSnippet: "Post a message to the swarm board",
		defaultActive,
		parameters: PostMessageToolParams,
		async execute(
			_toolCallId: string,
			params: PostMessageToolInput,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionToolContext,
		) {
			const caller = resolveCaller(options.callerName);
			const manager = resolveManager(options, ctx);
			const msg = manager.postMessage(caller, params.text, params.channel);
			return formatTextResult(`Posted #${msg.seq} to #${msg.channel}.`, { message: msg });
		},
		renderCall(args, theme, context) {
			const ch = args.channel ? `#${args.channel} ` : "";
			const preview = args.text.length > 72 ? `${args.text.slice(0, 69)}...` : args.text;
			return renderSimpleText(
				`${theme.fg("toolTitle", theme.bold("post_message"))} ${theme.fg("muted", `${ch}${preview}`)}`,
				context.lastComponent,
			);
		},
		renderResult(result, _opt, theme, context) {
			const color = context.isError ? "error" : "toolOutput";
			return renderSimpleText(theme.fg(color, extractResultText(result)), context.lastComponent);
		},
	};
}

/** Creates the `read_board` board tool definition. */
export function createReadBoardTool(options: CreateSwarmToolsOptions): ToolDefinition<typeof ReadBoardToolParams> {
	const defaultActive = options.defaultActive ?? true;
	return {
		name: "read_board",
		label: "Read Board",
		description: "Read messages from the swarm board or inspect member/channel status (status: true).",
		promptSnippet: "Read swarm board messages or member status",
		defaultActive,
		parameters: ReadBoardToolParams,
		async execute(
			_toolCallId: string,
			params: ReadBoardToolInput,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionToolContext,
		) {
			const caller = resolveCaller(options.callerName);
			const manager = resolveManager(options, ctx);
			if (params.status) {
				const status = manager.getDetailedStatus();
				return formatTextResult(formatDetailedStatusForMonitor(manager), { status });
			}
			const result = manager.readBoard({
				since: params.since,
				limit: params.limit,
				channel: params.channel,
				viewer: caller,
			});
			if (result.messages.length === 0) {
				return formatTextResult(`No messages (board head #${result.head}).`, { ...result });
			}
			const lines = result.messages.map(
				(m) => `#${m.seq} [${formatTimestamp(m.timestamp)}] [#${m.channel}] ${m.author}: ${m.text}`,
			);
			lines.push(`(head #${result.head})`);
			return formatTextResult(lines.join("\n"), { ...result });
		},
		renderCall(args, theme, context) {
			const parts = [
				args.status ? "status=true" : undefined,
				args.since !== undefined ? `since=#${args.since}` : undefined,
				args.channel ? `channel=${args.channel}` : undefined,
				args.limit !== undefined ? `limit=${args.limit}` : undefined,
			].filter((p): p is string => p !== undefined);
			return renderSimpleText(
				`${theme.fg("toolTitle", theme.bold("read_board"))} ${theme.fg("muted", parts.join(" "))}`,
				context.lastComponent,
			);
		},
		renderResult(result, opt, theme, context) {
			const text = extractResultText(result);
			const lines = text.split("\n");
			const preview = opt.expanded ? text : lines.slice(0, 8).join("\n") + (lines.length > 8 ? `\n... (${lines.length - 8} more lines)` : "");
			const color = context.isError ? "error" : "toolOutput";
			return renderSimpleText(theme.fg(color, preview), context.lastComponent);
		},
	};
}

/** Creates the non-blocking `swarm_wait` tool definition. */
export function createSwarmWaitTool(options: CreateSwarmToolsOptions): ToolDefinition<typeof SwarmWaitToolParams> {
	const defaultActive = options.defaultActive ?? true;
	return {
		name: "swarm_wait",
		label: "Swarm Wait",
		description:
			"Non-blocking park on the swarm board. Checks if matching posts already exist after `since`; if none, records your wait cursor and returns immediately so you can end your turn and be woken asynchronously.",
		promptSnippet: "Non-blocking park until matching swarm board posts arrive",
		defaultActive,
		parameters: SwarmWaitToolParams,
		async execute(
			_toolCallId: string,
			params: SwarmWaitToolInput,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionToolContext,
		) {
			const caller = resolveCaller(options.callerName);
			const manager = resolveManager(options, ctx);
			const waitResult = manager.requestWait(caller, {
				since: params.since,
				mentions_only: params.mentions_only,
			});
			return formatTextResult(waitResult.notice, { ...waitResult });
		},
		renderCall(args, theme, context) {
			const parts = [
				args.since !== undefined ? `since=#${args.since}` : undefined,
				args.mentions_only !== undefined ? `mentions_only=${args.mentions_only}` : undefined,
			].filter((p): p is string => p !== undefined);
			return renderSimpleText(
				`${theme.fg("toolTitle", theme.bold("swarm_wait"))} ${theme.fg("muted", parts.join(" "))}`,
				context.lastComponent,
			);
		},
		renderResult(result, _opt, theme, context) {
			const color = context.isError ? "error" : "toolOutput";
			return renderSimpleText(theme.fg(color, extractResultText(result)), context.lastComponent);
		},
	};
}

/** Creates the monitor-only `schedule` tool definition. */
export function createScheduleTool(options: CreateSwarmToolsOptions): ToolDefinition<typeof ScheduleToolParams> {
	const defaultActive = options.defaultActive ?? true;
	return {
		name: "schedule",
		label: "Schedule",
		description: "Schedule a one-shot timer (DurationSeconds) or recurring 5-field cron (CronExpression) for the monitor.",
		promptSnippet: "Schedule a monitor timer or cron tick",
		defaultActive,
		parameters: ScheduleToolParams,
		async execute(
			_toolCallId: string,
			params: ScheduleToolInput,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionToolContext,
		) {
			const caller = resolveCaller(options.callerName);
			if (!isMonitorName(caller)) {
				throw new Error(`Tool "schedule" is restricted to monitor workers (caller is "${caller}").`);
			}
			const manager = resolveManager(options, ctx);
			const result: ScheduleResult = manager.scheduleForMonitor(caller, {
				CronExpression: params.CronExpression,
				DurationSeconds: params.DurationSeconds,
				IsDaemon: params.IsDaemon,
				Prompt: params.Prompt,
			});
			return formatTextResult(
				`Scheduled ${result.kind} task ${result.taskId} (next run at ${new Date(result.nextRunAt).toISOString()}).`,
				{ ...result },
			);
		},
		renderCall(args, theme, context) {
			const expr = args.CronExpression ?? (args.DurationSeconds !== undefined ? `${args.DurationSeconds}s` : "");
			return renderSimpleText(
				`${theme.fg("toolTitle", theme.bold("schedule"))} ${theme.fg("muted", `${expr} ${args.Prompt.slice(0, 48)}`)}`,
				context.lastComponent,
			);
		},
		renderResult(result, _opt, theme, context) {
			const color = context.isError ? "error" : "toolOutput";
			return renderSimpleText(theme.fg(color, extractResultText(result)), context.lastComponent);
		},
	};
}

/** Creates the monitor-only `manage_task` tool definition. */
export function createManageTaskTool(options: CreateSwarmToolsOptions): ToolDefinition<typeof ManageTaskToolParams> {
	const defaultActive = options.defaultActive ?? true;
	return {
		name: "manage_task",
		label: "Manage Task",
		description: 'List ("list") or stop ("kill") scheduled tasks owned by this monitor.',
		promptSnippet: "List or kill monitor scheduled tasks",
		defaultActive,
		parameters: ManageTaskToolParams,
		async execute(
			_toolCallId: string,
			params: ManageTaskToolInput,
			_signal: AbortSignal | undefined,
			_onUpdate: AgentToolUpdateCallback<unknown> | undefined,
			ctx: ExtensionToolContext,
		) {
			const caller = resolveCaller(options.callerName);
			if (!isMonitorName(caller)) {
				throw new Error(`Tool "manage_task" is restricted to monitor workers (caller is "${caller}").`);
			}
			const manager = resolveManager(options, ctx);
			const result: ManageTaskResult = manager.manageMonitorTask(caller, {
				Action: params.Action,
				TaskId: params.TaskId,
			});
			if (result.kind === "list") {
				if (result.tasks.length === 0) {
					return formatTextResult("No scheduled tasks.", { ...result });
				}
				const lines = result.tasks.map(
					(t) =>
						`- ${t.taskId} | kind=${t.kind} | active=${t.active} | runs=${t.runCount}${
							t.cronExpression ? ` | cron="${t.cronExpression}"` : ""
						}${t.nextRunAt ? ` | next=${new Date(t.nextRunAt).toISOString()}` : ""}`,
				);
				return formatTextResult(lines.join("\n"), { ...result });
			}
			return formatTextResult(
				result.killed ? `Killed scheduled task ${result.taskId}.` : `Task ${result.taskId} was not active or not found.`,
				{ ...result },
			);
		},
		renderCall(args, theme, context) {
			return renderSimpleText(
				`${theme.fg("toolTitle", theme.bold("manage_task"))} ${theme.fg("muted", `${args.Action}${args.TaskId ? ` ${args.TaskId}` : ""}`)}`,
				context.lastComponent,
			);
		},
		renderResult(result, _opt, theme, context) {
			const color = context.isError ? "error" : "toolOutput";
			return renderSimpleText(theme.fg(color, extractResultText(result)), context.lastComponent);
		},
	};
}

/** Builds the complete swarm tool set for either coordinator or worker sessions. */
export function createSwarmToolDefinitions(options: CreateSwarmToolsOptions): SwarmToolDefinitions {
	const swarm = createSwarmTool(options);
	const post_message = createPostMessageTool(options);
	const read_board = createReadBoardTool(options);
	const swarm_wait = createSwarmWaitTool(options);
	const includeMonitor =
		options.includeMonitorTools ?? isMonitorName(resolveCaller(options.callerName));

	if (includeMonitor) {
		const schedule = createScheduleTool(options);
		const manage_task = createManageTaskTool(options);
		return {
			swarm,
			post_message,
			read_board,
			swarm_wait,
			schedule,
			manage_task,
			all: [swarm, post_message, read_board, swarm_wait, schedule, manage_task],
		};
	}

	return {
		swarm,
		post_message,
		read_board,
		swarm_wait,
		all: [swarm, post_message, read_board, swarm_wait],
	};
}

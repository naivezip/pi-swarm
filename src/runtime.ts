import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { AgentMessage, ThinkingLevel } from "@earendil-works/pi-agent-core";
import { type Api, type AssistantMessage, type ImageContent, type Model, type ToolCall, uuidv7 } from "@earendil-works/pi-ai";
import {
	type AgentSessionEvent,
	type AgentSessionEventListener,
	type CompactionEntry,
	type ContextUsage,
	createAgentSession,
	createMcpExtension,
	CURRENT_SESSION_VERSION,
	DefaultResourceLoader,
	type ExtensionAPI,
	type ExtensionContext,
	type ExtensionRunner,
	getAgentDir,
	type InputSource,
	type ModelRegistry,
	type ModelRuntime,
	type PromptOptions,
	type ResourceLoader,
	type SessionEntry,
	type SessionHeader,
	SessionManager,
	SettingsManager,
	type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import {
	doesMessageWakeCoordinator,
	doesMessageWakeMember,
	getSwarmDir,
	SwarmBoard,
} from "./board.ts";
import { BackgroundProcessManager } from "./process-manager.ts";
import { SwarmScheduler } from "./scheduler.ts";
import { createSwarmToolDefinitions } from "./tools.ts";
import {
	type AsyncBashInput,
	type AsyncBashResult,
	type BackgroundProcessEvent,
	type BackgroundProcessSummary,
	type BoardMessage,
	type ChannelRecord,
	type CoordinatorState,
	createEmptyUsage,
	isMonitorName,
	MAIN_CHANNEL,
	type ManageProcessInput,
	type ManageProcessResult,
	type ManageTaskInput,
	type ManageTaskResult,
	type MemberRecord,
	type MemberState,
	type MemberStatusSummary,
	type MemberUsage,
	type ReadBoardOptions,
	type ReadBoardResult,
	type ScheduledTaskRecord,
	type ScheduleInput,
	type ScheduleResult,
	type SwarmDetailedStatus,
	type SwarmPlan,
	validateChannelName,
	validateWorkerName,
	type WakeMode,
	type WorkspaceMode,
} from "./types.ts";
import { removeWorkspace, setupWorkspace } from "./workspace.ts";

export const SWARM_TOOL_NAMES: readonly string[] = ["swarm", "post_message", "read_board", "swarm_wait"];
export const MONITOR_TOOL_NAMES: readonly string[] = ["schedule", "manage_task"];
export const WORKER_PROCESS_TOOL_NAMES: readonly string[] = ["bash", "manage_process"];

export interface CoordinatorWakeEvent {
	seq: number;
	author: string;
	channel: string;
	text: string;
	unreadCount: number;
	head: number;
}

export interface HostCallbacks {
	wakeCoordinator: (wake: CoordinatorWakeEvent) => boolean | void | Promise<boolean | void>;
	setCoordinatorModel?: (model: Model<Api>) => Promise<boolean>;
	onToolsActivationNeeded?: () => void;
}

export interface WorkerLiveActivity {
	streamingText: string;
	activeTools: string[];
	currentActivity?: string;
}

export interface SwarmTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface SwarmSnapshot {
	swarmId: string;
	sessionId: string;
	title: string;
	cwd: string;
	swarmDir: string;
	active: boolean;
	head: number;
	channels: ChannelRecord[];
	members: MemberStatusSummary[];
	coordinator: CoordinatorState;
	plan: SwarmPlan;
	messages: BoardMessage[];
	totals: SwarmTotals;
	scheduledTasks: ScheduledTaskRecord[];
	backgroundProcesses: BackgroundProcessSummary[];
}

export interface AddWorkerInput {
	name: string;
	brief: string;
	model?: string;
	workspace?: WorkspaceMode;
	fork?: string;
	channels?: string[];
	tasks?: string[];
	n?: number;
}

export interface AddWorkerEntryResult {
	name: string;
	group?: string;
	workspaceMode: WorkspaceMode;
	workspacePath: string;
	workspaceBranch?: string;
	dirtyWarning?: string;
	channel: string;
	briefSeq: number;
}

export interface AddWorkerResult {
	workers: AddWorkerEntryResult[];
}

export interface ModelInfoEntry {
	provider: string;
	id: string;
	name: string;
	contextWindow: number;
	reasoning: boolean;
	cost: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
	};
	current: boolean;
	thinkingLevel?: ThinkingLevel;
}

export interface ModelSwitchResult {
	target: string;
	model: string;
	previousModel?: string;
	woke: boolean;
}

export interface KillResult {
	killed: string[];
}

export interface ChannelOpInput {
	op: "create" | "list" | "subscribe" | "unsubscribe" | "archive";
	channel?: string;
	topic?: string;
	name?: string;
}

export interface ChannelOpResult {
	op: "create" | "list" | "subscribe" | "unsubscribe" | "archive";
	summary: string;
	channels?: Array<ChannelRecord & { subscribers: number }>;
	channel?: ChannelRecord;
	memberChannels?: string[];
}

export interface RequestWaitInput {
	since?: number;
	mentions_only?: boolean;
}

export interface RequestWaitResult {
	parked: boolean;
	wakeMode: WakeMode;
	waitSince: number;
	matchingSeqs: number[];
	notice: string;
}

export type DirectWorkerMessageDelivery = "prompt" | "steer" | "followUp";

export interface DirectWorkerMessageResult {
	worker: string;
	delivery: DirectWorkerMessageDelivery;
	resumed: boolean;
	queued: boolean;
	state: MemberState;
}

export interface WorkerQueuedMessages {
	steering: readonly string[];
	followUp: readonly string[];
}

export interface AbortWorkerResult {
	aborted: boolean;
	state: MemberState;
}

export interface WorkerSessionHandle {
	readonly sessionId: string;
	readonly sessionFile: string | undefined;
	readonly model: Model<Api> | undefined;
	readonly isStreaming: boolean;
	readonly isIdle: boolean;
	readonly messages: AgentMessage[];
	readonly sessionManager: ExtensionContext["sessionManager"];
	readonly state?: { readonly model?: Model<Api>; readonly thinkingLevel?: ThinkingLevel };
	readonly thinkingLevel?: ThinkingLevel;
	readonly routedModel?: { model: Model<Api>; thinkingLevel?: ThinkingLevel };
	readonly retryAttempt?: number;
	readonly settingsManager?: SettingsManager;
	readonly resourceLoader?: ResourceLoader;
	readonly modelRuntime?: ModelRuntime;
	readonly modelRegistry?: ModelRegistry;
	readonly extensionRunner?: ExtensionRunner;
	readonly scopedModels?: ReadonlyArray<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	readonly autoCompactionEnabled?: boolean;
	readonly pendingMessageCount?: number;
	readonly sessionName?: string;
	getContextUsage?(): ContextUsage | undefined;
	getToolDefinition?(name: string): ToolDefinition | undefined;
	getAvailableThinkingLevels?(): ThinkingLevel[];
	setThinkingLevel?(level: ThinkingLevel, options?: { persist?: boolean }): void;
	getActiveToolNames(): string[];
	setActiveToolsByName(toolNames: string[]): void;
	setModel(model: Model<Api>): Promise<void>;
	prompt(text: string, options?: PromptOptions): Promise<void>;
	steer?(
		text: string,
		images?: ImageContent[],
		options?: { source?: InputSource },
	): Promise<"handled" | "queued" | void>;
	followUp?(
		text: string,
		images?: ImageContent[],
		options?: { source?: InputSource },
	): Promise<"handled" | "queued" | void>;
	getSteeringMessages?(): readonly string[];
	getFollowUpMessages?(): readonly string[];
	clearQueue?(): { steering: string[]; followUp: string[] };
	waitForIdle?(): Promise<void>;
	abort(): Promise<void>;
	dispose(): void;
	subscribe(listener: AgentSessionEventListener): () => void;
}

export interface CreateWorkerSessionContext {
	member: MemberRecord;
	swarmDir: string;
	agentDir: string;
	model?: Model<Api>;
	scopedModels?: Array<{ model: Model<Api>; thinkingLevel?: ThinkingLevel }>;
	modelRuntime?: ModelRuntime;
	workerExtension: (pi: ExtensionAPI) => void;
}

export type WorkerSessionFactory = (context: CreateWorkerSessionContext) => Promise<WorkerSessionHandle>;

export interface SwarmManagerOptions {
	sessionId: string;
	cwd: string;
	swarmDir?: string;
	swarmsRoot?: string;
	agentDir?: string;
	title?: string;
	callbacks?: HostCallbacks;
	modelRuntime?: ModelRuntime;
	sessionFactory?: WorkerSessionFactory;
	schedulerNow?: () => number;
}

type WakeReason =
	| { kind: "board"; message: BoardMessage }
	| { kind: "schedule"; task: ScheduledTaskRecord }
	| { kind: "model_switch"; modelRef: string }
	| { kind: "process_exit"; event: BackgroundProcessEvent; extraEvents?: BackgroundProcessEvent[] }
	| { kind: "process_still_running"; event: BackgroundProcessEvent; extraEvents?: BackgroundProcessEvent[] };

interface ActiveWorkerRuntime {
	session: WorkerSessionHandle;
	unsubscribe: () => void;
	streamingText: string;
	activeTools: Set<string>;
	explicitWaitCalledThisTurn: boolean;
	lastTurnErrored: boolean;
	abortRequestedByUser: boolean;
	trackedSteering: string[];
	trackedFollowUp: string[];
	fallbackQueuedSteering: string[];
	fallbackQueuedFollowUp: string[];
	queueUpdateSeen: boolean;
}

function extractUserMessageText(message: AgentMessage): string {
	if (message.role !== "user") {
		return "";
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	if (!Array.isArray(message.content)) {
		return "";
	}
	return message.content
		.filter((part): part is { type: "text"; text: string } => part.type === "text" && typeof part.text === "string")
		.map((part) => part.text)
		.join("");
}

function formatModelRef(model: Model<Api>): string {
	return `${model.provider}/${model.id}`;
}

function formatTimestampShort(ms: number): string {
	const d = new Date(ms);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

function formatToolActivity(toolName: string, args: unknown): string {
	if (args && typeof args === "object") {
		const record = args as Record<string, unknown>;
		if (typeof record.path === "string") {
			return `${toolName} ${record.path}`;
		}
		if (typeof record.command === "string") {
			const cmd = record.command.replace(/\s+/g, " ").trim();
			return `${toolName} ${cmd.length > 36 ? `${cmd.slice(0, 33)}...` : cmd}`;
		}
		if (typeof record.action === "string") {
			return `${toolName}:${record.action}`;
		}
		if (typeof record.pattern === "string") {
			return `${toolName} ${record.pattern}`;
		}
	}
	return toolName;
}

function formatQuotaOrErrorText(rawMessage: string | undefined): string {
	const text = rawMessage?.trim();
	return text && text.length > 0 ? text : "Model request failed";
}

function hasUnfinishedAssistantTurn(messages: readonly AgentMessage[]): boolean {
	if (messages.length === 0) {
		return false;
	}
	const last = messages[messages.length - 1];
	if (last.role === "user" || last.role === "toolResult") {
		return true;
	}
	if (last.role === "assistant") {
		const assistant = last as AssistantMessage;
		if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
			return true;
		}
		if (Array.isArray(assistant.content) && assistant.content.some((b) => b.type === "toolCall")) {
			return true;
		}
	}
	return false;
}

/**
 * Extracts active branch entries up to the last settled point, stripping any trailing
 * incomplete assistant turn (unresolved `toolCall`s or trailing aborted/error assistant messages)
 * and re-chaining `parentId` cleanly so provider APIs never reject forked history.
 */
export function buildSettledBranchEntries(entries: readonly SessionEntry[]): SessionEntry[] {
	const withoutLabels: SessionEntry[] = [];
	const replacementByLabelId = new Map<string, string>();
	const pendingLabelIds: string[] = [];

	for (const entry of entries) {
		if (entry.type === "label") {
			pendingLabelIds.push(entry.id);
			continue;
		}
		for (const labelId of pendingLabelIds) {
			replacementByLabelId.set(labelId, entry.id);
		}
		pendingLabelIds.length = 0;
		if (entry.type === "compaction") {
			const comp = entry as CompactionEntry;
			withoutLabels.push({
				...comp,
				firstKeptEntryId:
					comp.firstKeptEntryId === comp.id
						? comp.id
						: (replacementByLabelId.get(comp.firstKeptEntryId) ?? comp.firstKeptEntryId),
			});
		} else {
			withoutLabels.push({ ...entry });
		}
	}

	const pendingToolCalls = new Set<string>();
	let lastSettledLength = 0;

	for (let i = 0; i < withoutLabels.length; i++) {
		const entry = withoutLabels[i];
		if (entry.type !== "message") {
			if (pendingToolCalls.size === 0) {
				lastSettledLength = i + 1;
			}
			continue;
		}

		const msg = entry.message;
		if (msg.role === "assistant") {
			const toolCallIds = Array.isArray(msg.content)
				? msg.content
						.filter((block): block is ToolCall => block.type === "toolCall")
						.map((block) => block.id)
				: [];

			if (toolCallIds.length > 0) {
				for (const id of toolCallIds) {
					pendingToolCalls.add(id);
				}
				continue;
			}

			if (msg.stopReason === "error" || msg.stopReason === "aborted") {
				continue;
			}

			if (pendingToolCalls.size === 0) {
				lastSettledLength = i + 1;
			}
			continue;
		}

		if (msg.role === "toolResult") {
			pendingToolCalls.delete(msg.toolCallId);
			if (pendingToolCalls.size === 0) {
				lastSettledLength = i + 1;
			}
			continue;
		}

		if (pendingToolCalls.size === 0) {
			lastSettledLength = i + 1;
		}
	}

	const settled = withoutLabels.slice(0, lastSettledLength);
	let parentId: string | null = null;
	return settled.map((entry) => {
		const next = { ...entry, parentId };
		parentId = entry.id;
		return next;
	});
}

function writeForkedSessionFile(
	sourceEntries: readonly SessionEntry[],
	targetSessionFile: string,
	targetCwd: string,
	parentSessionFile?: string,
): void {
	const settled = buildSettledBranchEntries(sourceEntries);
	const header: SessionHeader = {
		type: "session",
		version: CURRENT_SESSION_VERSION,
		id: uuidv7(),
		timestamp: new Date().toISOString(),
		cwd: targetCwd,
		...(parentSessionFile ? { parentSession: parentSessionFile } : {}),
	};
	mkdirSync(dirname(targetSessionFile), { recursive: true });
	const lines = [JSON.stringify(header), ...settled.map((entry) => JSON.stringify(entry))];
	writeFileSync(targetSessionFile, `${lines.join("\n")}\n`, "utf-8");
}

function formatDurationShort(ms: number): string {
	if (ms < 1000) {
		return `${Math.max(0, Math.round(ms))}ms`;
	}
	const secs = ms / 1000;
	if (secs < 60) {
		return `${secs.toFixed(1)}s`;
	}
	const mins = Math.floor(secs / 60);
	const remSecs = Math.round(secs % 60);
	return `${mins}m${remSecs}s`;
}

function buildWorkerSystemPromptSection(member: MemberRecord): string {
	const channelList = member.channels.length > 0 ? member.channels.map((c) => `#${c}`).join(", ") : "#main";
	if (isMonitorName(member.name)) {
		return [
			`You are ${member.name}, the swarm's stall monitor.`,
			`Channels: all (#main + every area channel). Workspace: ${member.workspacePath} (${member.workspaceMode}).`,
			"Rules:",
			"- Never do coding, file edits, builds, or user replies. Load and follow the `swarm-monitor` skill.",
			"- You remain strictly read-only: you have no `bash` or `manage_process` tools.",
			"- Post only to break a stall, citing #seq numbers and timestamps, addressed to one member by name.",
			"- You have exclusive access to `schedule` and `manage_task`.",
			"- `swarm_wait` is a non-blocking park: call `swarm_wait` and end your turn immediately; Pi wakes you asynchronously on cron ticks or matching posts.",
		].join("\n");
	}

	return [
		`You are ${member.name}, one agent in a swarm working together on one task.`,
		`Added by: ${member.addedBy}. Workspace: ${member.workspacePath} (${member.workspaceMode}${
			member.workspaceBranch ? `, branch ${member.workspaceBranch}` : ""
		}). Channels: #main${member.channels.length > 0 ? `, ${channelList}` : ""}.`,
		"Board and swarm rules:",
		"- Read messages with `read_board` and post updates/asks with `post_message`.",
		"- Always address recipients with `@name` (wake doorbell) and cite prior posts as `#seq` instead of copy-pasting.",
		"- Start your final completion post with `[done]` after the `@mention` (e.g. `@coordinator [done] <summary>`).",
		"- `swarm_wait` is a non-blocking park: call `swarm_wait({ since: <lastReadSeq>, mentions_only?: boolean })` and end your turn immediately; you will be woken asynchronously when a matching post arrives.",
		"- You may call `swarm{action:\"add\"}` to spawn helpers for your own work (you may `kill` only helpers you added, and `model` yourself or helpers you added).",
		"Shell and background process rules:",
		"- `bash` runs commands with sync-to-async promotion (`wait_ms`, default 10000ms, max 30000ms). Commands exiting within `wait_ms` return synchronously; longer commands promote to the background without being killed and return a `taskId` and output tail so far.",
		"- NEVER poll `manage_process` in a loop after a command promotes to the background. End your turn (or do other independent work) and wait for the async `process_exit` or `process_still_running` wake.",
		"- For long-lived dev servers, watchers, or port listeners, pass `is_daemon: true` to `bash` so reminder wakes are suppressed, and always terminate them with `manage_process({ action: \"kill\", task_id })` once finished.",
		"- Use `manage_process` (`list`, `status`, `send_input`, `kill`) to inspect, send stdin to, or terminate your own background processes.",
	].join("\n");
}

async function defaultWorkerSessionFactory(context: CreateWorkerSessionContext): Promise<WorkerSessionHandle> {
	const { member, swarmDir, agentDir, model, scopedModels, modelRuntime, workerExtension } = context;
	const workersDir = join(swarmDir, "workers");
	mkdirSync(workersDir, { recursive: true });

	const settingsManager = SettingsManager.create(member.workspacePath, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: member.workspacePath,
		agentDir,
		settingsManager,
		noExtensions: true,
		extensionFactories: [createMcpExtension(), workerExtension],
	});
	await resourceLoader.reload();

	const isMonitor = isMonitorName(member.name);
	const sessionManager = SessionManager.open(member.sessionFile, workersDir, member.workspacePath);
	const { session } = await createAgentSession({
		cwd: member.workspacePath,
		agentDir,
		model,
		modelRuntime,
		scopedModels,
		tools: isMonitor ? ["-bash", "-powershell", "-edit", "-write", "+grep", "+find", "+ls"] : ["+grep", "+find", "+ls"],
		...(isMonitor ? { excludeTools: ["bash", "powershell", "edit", "write", "manage_process"] } : {}),
		resourceLoader,
		sessionManager,
		settingsManager,
	});

	await session.bindExtensions({});

	const requiredTools = isMonitor
		? [...SWARM_TOOL_NAMES, ...MONITOR_TOOL_NAMES]
		: [...SWARM_TOOL_NAMES, ...WORKER_PROCESS_TOOL_NAMES];
	const currentActive = session.getActiveToolNames();
	const missingTools = requiredTools.filter((name) => !currentActive.includes(name));
	if (missingTools.length > 0) {
		session.setActiveToolsByName([...currentActive, ...missingTools]);
	}

	return session as unknown as WorkerSessionHandle;
}

/**
 * Coordinates in-process Pi SDK workers, board persistence, non-blocking parks,
 * async wakeups, channel routing, workspaces, and monitor scheduling.
 */
export class SwarmManager {
	readonly sessionId: string;
	readonly cwd: string;
	readonly swarmDir: string;
	readonly agentDir: string;

	private readonly board: SwarmBoard;
	private readonly scheduler: SwarmScheduler;
	private readonly processManager: BackgroundProcessManager;
	private readonly callbacks: HostCallbacks | undefined;
	private readonly modelRuntime: ModelRuntime | undefined;
	private readonly sessionFactory: WorkerSessionFactory;

	private readonly activeWorkers = new Map<string, ActiveWorkerRuntime>();
	private readonly wakingWorkers = new Set<string>();
	private readonly resumingWorkers = new Map<string, Promise<ActiveWorkerRuntime>>();
	private readonly abortRequestedBeforeSession = new Set<string>();
	private readonly workerEventListeners = new Map<string, Set<AgentSessionEventListener>>();
	private readonly pendingWorkerWakeSeq = new Map<string, number>();
	private readonly pendingWorkerScheduleWake = new Map<string, ScheduledTaskRecord>();
	private readonly pendingWorkerProcessEvents = new Map<string, BackgroundProcessEvent[]>();
	private readonly listeners = new Set<(snapshot: SwarmSnapshot) => void>();

	private hostContext: ExtensionContext | undefined;
	private coordinatorExplicitWaitThisTurn = false;
	private pendingCoordinatorWake: CoordinatorWakeEvent | undefined;
	private stopping = false;
	private disposed = false;

	constructor(options: SwarmManagerOptions, existingBoard?: SwarmBoard) {
		this.sessionId = options.sessionId;
		this.cwd = options.cwd;
		this.agentDir = options.agentDir ?? getAgentDir();
		this.swarmDir = options.swarmDir ?? getSwarmDir(options.sessionId, options.swarmsRoot);
		this.callbacks = options.callbacks;
		this.modelRuntime = options.modelRuntime;
		this.sessionFactory = options.sessionFactory ?? defaultWorkerSessionFactory;

		this.board =
			existingBoard ??
			SwarmBoard.openOrCreate({
				swarmDir: this.swarmDir,
				sessionId: this.sessionId,
				cwd: this.cwd,
				title: options.title,
			});

		this.scheduler = new SwarmScheduler({
			now: options.schedulerNow,
			isTargetBusy: (workerName) =>
				this.board.getMember(workerName)?.state === "working" || this.wakingWorkers.has(workerName),
			onTrigger: (task) => {
				this.handleScheduledTick(task);
			},
		});

		this.processManager = new BackgroundProcessManager({
			onEvent: (event) => {
				this.handleBackgroundProcessEvent(event);
			},
		});
	}

	/** Checks whether a persisted swarm exists on disk for `sessionId`. */
	static hasExistingSwarm(sessionId: string, swarmsRoot?: string, swarmDir?: string): boolean {
		const dir = swarmDir ?? getSwarmDir(sessionId, swarmsRoot);
		return existsSync(join(dir, "state.json"));
	}

	/** Loads an existing swarm from disk and transitions any non-killed workers to `stopped` for recovery. */
	static loadIfExists(options: SwarmManagerOptions): SwarmManager | undefined {
		const dir = options.swarmDir ?? getSwarmDir(options.sessionId, options.swarmsRoot);
		const board = SwarmBoard.load(dir);
		if (!board) {
			return undefined;
		}
		const state = board.getState();
		let dirty = false;
		if (state.coordinator.state !== "waiting") {
			state.coordinator.state = "waiting";
			dirty = true;
		}
		for (const member of board.listMembers()) {
			if (member.state === "working" || member.state === "waiting") {
				member.state = "stopped";
				member.currentActivity = undefined;
				dirty = true;
			}
		}
		if (dirty) {
			board.saveState();
		}
		return new SwarmManager(options, board);
	}

	/** Updates the latest host `ExtensionContext` for model registry / scoped models / coordinator session snapshots. */
	updateHostContext(ctx: ExtensionContext): void {
		if (this.isWorkerContext(ctx)) {
			return;
		}
		this.hostContext = ctx;
	}

	/** Returns the underlying `SwarmBoard` instance. */
	getBoard(): SwarmBoard {
		return this.board;
	}

	/** Subscribes to live swarm state, board, usage, and plan snapshots. */
	subscribe(listener: (snapshot: SwarmSnapshot) => void): () => void {
		this.listeners.add(listener);
		return () => {
			this.listeners.delete(listener);
		};
	}

	private emitSnapshot(): void {
		if (this.listeners.size === 0) {
			return;
		}
		const snapshot = this.getSnapshot();
		for (const listener of this.listeners) {
			try {
				listener(snapshot);
			} catch {
				// Observer errors must not break runtime state transitions.
			}
		}
	}

	/** Returns a full point-in-time snapshot for UI widgets, overlays, and extensions. */
	getSnapshot(): SwarmSnapshot {
		const detailed = this.getDetailedStatus();
		const activeProcs = this.processManager.getActiveSummaries();
		const totals: SwarmTotals = {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0,
			turns: 0,
		};
		for (const member of detailed.members) {
			totals.input += member.usage.input;
			totals.output += member.usage.output;
			totals.cacheRead += member.usage.cacheRead;
			totals.cacheWrite += member.usage.cacheWrite;
			totals.cost += member.usage.cost;
			totals.turns += member.usage.turns;
		}
		const messages = this.board.peekUnread("coordinator", 0);
		return {
			swarmId: detailed.swarmId,
			sessionId: detailed.sessionId,
			title: detailed.title,
			cwd: this.board.getState().cwd,
			swarmDir: this.swarmDir,
			active: detailed.active,
			head: detailed.head,
			channels: detailed.channels,
			members: detailed.members,
			coordinator: detailed.coordinator,
			plan: this.board.getPlan(),
			messages,
			totals,
			scheduledTasks: this.getScheduledTasks(),
			backgroundProcesses: activeProcs,
		};
	}

	/** Returns the detailed member/channel status snapshot (`read_board{status: true}`). */
	getDetailedStatus(): SwarmDetailedStatus {
		const detailed = this.board.getDetailedStatus();
		const activeProcs = this.processManager.getActiveSummaries();
		const byOwner = new Map<string, BackgroundProcessSummary[]>();
		for (const proc of activeProcs) {
			const list = byOwner.get(proc.ownerWorker) ?? [];
			list.push(proc);
			byOwner.set(proc.ownerWorker, list);
		}
		for (const member of detailed.members) {
			member.backgroundProcesses = byOwner.get(member.name) ?? [];
		}
		return detailed;
	}

	/** Reads board messages for UI inspection without advancing any read cursor. */
	getMessages(options?: { channel?: string; author?: string; since?: number; limit?: number }): BoardMessage[] {
		const since = options?.since ?? 0;
		let msgs = this.board.peekUnread("coordinator", since);
		if (options?.channel && options.channel !== "*") {
			msgs = msgs.filter((m) => m.channel === options.channel);
		}
		if (options?.author) {
			msgs = msgs.filter((m) => m.author === options.author);
		}
		if (options?.limit !== undefined && options.limit >= 0) {
			msgs = msgs.slice(-options.limit);
		}
		return msgs;
	}

	/** Lists all scheduled tasks tracked by the monitor scheduler. */
	getScheduledTasks(): ScheduledTaskRecord[] {
		const result = this.scheduler.manageTask({ Action: "list" });
		return result.kind === "list" ? result.tasks : [];
	}

	/** Returns the conversation messages for a worker (from live session or persisted JSONL). */
	getWorkerMessages(name: string): AgentMessage[] {
		const active = this.activeWorkers.get(name);
		if (active) {
			return [...active.session.messages];
		}
		const member = this.board.getMember(name);
		if (!member || !existsSync(member.sessionFile)) {
			return [];
		}
		const workersDir = join(this.swarmDir, "workers");
		try {
			const sm = SessionManager.open(member.sessionFile, workersDir, member.workspacePath);
			return sm.buildSessionContext().messages;
		} catch {
			return [];
		}
	}

	/** Returns the live `WorkerSessionHandle` for an active worker, or `undefined` if stopped/killed. */
	getWorkerSession(name: string): WorkerSessionHandle | undefined {
		return this.activeWorkers.get(name)?.session;
	}

	/** Subscribes to live `AgentSessionEvent`s for a worker, automatically re-attaching across resume. */
	subscribeWorkerEvents(name: string, listener: AgentSessionEventListener): () => void {
		let set = this.workerEventListeners.get(name);
		if (!set) {
			set = new Set<AgentSessionEventListener>();
			this.workerEventListeners.set(name, set);
		}
		set.add(listener);
		return () => {
			const listeners = this.workerEventListeners.get(name);
			if (!listeners) {
				return;
			}
			listeners.delete(listener);
			if (listeners.size === 0) {
				this.workerEventListeners.delete(name);
			}
		};
	}

	/** Returns pending private steering and follow-up messages queued for a worker. */
	getWorkerQueuedMessages(name: string): WorkerQueuedMessages {
		const runtime = this.activeWorkers.get(name);
		if (!runtime) {
			return { steering: [], followUp: [] };
		}
		const steering = runtime.session.getSteeringMessages
			? [...runtime.session.getSteeringMessages()]
			: runtime.trackedSteering.length > 0
				? [...runtime.trackedSteering]
				: [...runtime.fallbackQueuedSteering];
		const followUp = runtime.session.getFollowUpMessages
			? [...runtime.session.getFollowUpMessages()]
			: runtime.trackedFollowUp.length > 0
				? [...runtime.trackedFollowUp]
				: [...runtime.fallbackQueuedFollowUp];
		return { steering, followUp };
	}

	private emitWorkerEvent(name: string, event: AgentSessionEvent): void {
		const listeners = this.workerEventListeners.get(name);
		if (!listeners || listeners.size === 0) {
			return;
		}
		for (const listener of [...listeners]) {
			try {
				listener(event);
			} catch {
				// Observer errors must not break worker session event processing.
			}
		}
	}

	/** Returns live streaming text and active tool names for a worker. */
	getWorkerLiveActivity(name: string): WorkerLiveActivity {
		const active = this.activeWorkers.get(name);
		const member = this.board.getMember(name);
		return {
			streamingText: active?.streamingText ?? "",
			activeTools: active ? [...active.activeTools] : [],
			currentActivity: member?.currentActivity,
		};
	}

	/** Returns true if any worker is currently in the `working` state. */
	hasActiveWorkers(): boolean {
		return this.board.listMembers().some((m) => m.state === "working");
	}

	/** Marks the swarm active/inactive on disk and notifies listeners. */
	setActive(active: boolean): void {
		this.board.setActive(active);
		this.emitSnapshot();
	}

	/** Marks the coordinator as active (`working`) at the start of an agent run. */
	onCoordinatorRunStart(): void {
		const state = this.board.getState();
		state.coordinator.state = "working";
		this.coordinatorExplicitWaitThisTurn = false;
		this.board.saveState();
		this.emitSnapshot();
	}

	/** Parks the coordinator on `agent_settled` and flushes any queued wakeups not yet read. */
	onCoordinatorSettled(): void {
		if (this.disposed) {
			return;
		}
		const state = this.board.getState();
		state.coordinator.state = "waiting";
		if (!this.coordinatorExplicitWaitThisTurn) {
			state.coordinator.wakeMode = "mentions";
			state.coordinator.waitSince = state.coordinator.lastReadSeq;
		}
		this.coordinatorExplicitWaitThisTurn = false;
		this.board.saveState();
		this.emitSnapshot();

		this.flushPendingCoordinatorWake();
	}

	/** Flushes any queued coordinator wakeup if the coordinator is waiting and idle. */
	flushPendingCoordinatorWake(): void {
		if (this.disposed) {
			return;
		}
		const state = this.board.getState();
		if (state.coordinator.state === "working" || (this.hostContext && !this.hostContext.isIdle())) {
			return;
		}
		const pending = this.pendingCoordinatorWake;
		this.pendingCoordinatorWake = undefined;
		if (pending && state.coordinator.lastReadSeq < pending.seq) {
			this.dispatchCoordinatorWake(pending);
		}
	}

	/** Builds a concise `<swarm_coordinator>` system prompt section for the host extension. */
	getCoordinatorPromptContext(): string {
		const status = this.board.getDetailedStatus();
		const plan = this.board.getPlan();
		const unread = Math.max(0, status.head - status.coordinator.lastReadSeq);
		const liveWorkers = status.members.filter((m) => m.state !== "killed");
		const channelList = status.channels.map((c) => `#${c.name}${c.archived ? "(archived)" : ""}`).join(", ");
		const rosterSummary =
			liveWorkers.length === 0
				? "none"
				: liveWorkers
						.map((m) => `${m.name}:${m.state}${m.lastError ? `[err]` : ""}`)
						.join(", ");
		const planLine = plan.goal.title
			? `${plan.goal.title} (${plan.threads.length} threads)`
			: "not set (call swarm{action:\"plan\", goal, tasks, threads} once workers are added)";

		return [
			`Title: ${status.title} | Board head: #${status.head} | Coordinator unread: ${unread}`,
			`Channels: ${channelList}`,
			`Workers: ${rosterSummary}`,
			`Plan: ${planLine}`,
			"Reminders: swarm_wait is a non-blocking park (end your turn right after calling it); keep turns short and delegate technical work to workers.",
		].join("\n");
	}

	/** Lists scoped models (or all available registry models when `all: true`). */
	listModels(options: { all?: boolean; ctx?: ExtensionContext } = {}): ModelInfoEntry[] {
		const ctx = options.ctx ?? this.hostContext;
		const currentModel = ctx?.model;
		const scoped = ctx?.scopedModels ?? [];
		const useScoped = !options.all && scoped.length > 0;

		if (useScoped) {
			return scoped.map((entry) => ({
				provider: entry.model.provider,
				id: entry.model.id,
				name: entry.model.name,
				contextWindow: entry.model.contextWindow,
				reasoning: entry.model.reasoning,
				cost: { ...entry.model.cost },
				current:
					currentModel !== undefined &&
					currentModel.provider === entry.model.provider &&
					currentModel.id === entry.model.id,
				thinkingLevel: entry.thinkingLevel,
			}));
		}

		const available = ctx?.modelRegistry.getAvailable() ?? [];
		return available.map((m) => ({
			provider: m.provider,
			id: m.id,
			name: m.name,
			contextWindow: m.contextWindow,
			reasoning: m.reasoning,
			cost: { ...m.cost },
			current:
				currentModel !== undefined && currentModel.provider === m.provider && currentModel.id === m.id,
		}));
	}

	private resolveModelFromContext(
		modelRef: string,
		callerCtx?: ExtensionContext,
		explicitRegistry?: ModelRegistry,
	): Model<Api> {
		const registry = explicitRegistry ?? callerCtx?.modelRegistry ?? this.hostContext?.modelRegistry;
		const trimmed = modelRef.trim();
		const slashIdx = trimmed.indexOf("/");
		if (slashIdx > 0) {
			const provider = trimmed.slice(0, slashIdx);
			const id = trimmed.slice(slashIdx + 1);
			const exact = registry?.find(provider, id);
			if (exact) {
				if (registry && !registry.hasConfiguredAuth(exact)) {
					throw new Error(`Model "${trimmed}" has no configured authentication.`);
				}
				return exact;
			}
		}

		const candidates: Model<Api>[] = [
			...(registry?.getAvailable() ?? []),
			...((callerCtx?.scopedModels ?? this.hostContext?.scopedModels ?? []).map((s) => s.model)),
		];
		const seen = new Set<string>();
		const uniqueCandidates: Model<Api>[] = [];
		for (const candidate of candidates) {
			const key = `${candidate.provider}/${candidate.id}`;
			if (!seen.has(key)) {
				seen.add(key);
				uniqueCandidates.push(candidate);
			}
		}

		const lower = trimmed.toLowerCase();
		const exactMatch =
			uniqueCandidates.find((m) => `${m.provider}/${m.id}`.toLowerCase() === lower) ??
			uniqueCandidates.find((m) => m.id.toLowerCase() === lower);
		if (exactMatch) {
			return exactMatch;
		}

		if (this.modelRuntime) {
			if (slashIdx > 0) {
				const provider = trimmed.slice(0, slashIdx);
				const id = trimmed.slice(slashIdx + 1);
				const rtModel = this.modelRuntime.getModel(provider, id);
				if (rtModel) {
					return rtModel;
				}
			}
			const rtAvailable = [...this.modelRuntime.getAvailableSnapshot()];
			const rtMatch =
				rtAvailable.find((m) => `${m.provider}/${m.id}`.toLowerCase() === lower) ??
				rtAvailable.find((m) => m.id.toLowerCase() === lower);
			if (rtMatch) {
				return rtMatch;
			}
		}

		throw new Error(`Model "${modelRef}" not found or unavailable in registry.`);
	}

	private resolveCallerModel(callerName: string, callerCtx?: ExtensionContext): Model<Api> | undefined {
		if (callerName !== "coordinator") {
			const activeModel = this.activeWorkers.get(callerName)?.session.model;
			if (activeModel) {
				return activeModel;
			}
		}
		return callerCtx?.model ?? this.hostContext?.model;
	}

	private resolveForkSource(
		forkRef: string,
		callerCtx?: ExtensionContext,
	): { entries: SessionEntry[]; parentSessionFile?: string } {
		if (forkRef === "coordinator") {
			const sm =
				callerCtx && !this.isWorkerContext(callerCtx)
					? callerCtx.sessionManager
					: this.hostContext?.sessionManager;
			if (!sm) {
				throw new Error('Cannot fork from "coordinator": coordinator session snapshot is unavailable.');
			}
			return {
				entries: sm.getBranch(),
				parentSessionFile: sm.getSessionFile(),
			};
		}

		const sourceMember = this.board.getMember(forkRef);
		if (!sourceMember) {
			throw new Error(`Cannot fork from unknown member "${forkRef}".`);
		}
		const active = this.activeWorkers.get(forkRef);
		if (active) {
			return {
				entries: active.session.sessionManager.getBranch(),
				parentSessionFile: active.session.sessionFile ?? sourceMember.sessionFile,
			};
		}
		if (!existsSync(sourceMember.sessionFile)) {
			throw new Error(`Cannot fork from "${forkRef}": session file does not exist (${sourceMember.sessionFile}).`);
		}
		const workersDir = join(this.swarmDir, "workers");
		const sm = SessionManager.open(sourceMember.sessionFile, workersDir, sourceMember.workspacePath);
		return {
			entries: sm.getBranch(),
			parentSessionFile: sourceMember.sessionFile,
		};
	}

	private isWorkerContext(ctx: ExtensionContext): boolean {
		const sessionId = ctx.sessionManager.getSessionId();
		for (const worker of this.activeWorkers.values()) {
			if (worker.session.sessionId === sessionId) {
				return true;
			}
		}
		return false;
	}

	/** Spawns one worker or a sharded/homogeneous group (`tasks` / `n`), posts public briefs, and starts runs asynchronously. */
	async addWorkers(
		input: AddWorkerInput,
		callerName: string,
		callerCtx?: ExtensionContext,
	): Promise<AddWorkerResult> {
		if (this.disposed) {
			throw new Error("SwarmManager is disposed.");
		}
		if (input.tasks !== undefined && input.n !== undefined) {
			throw new Error('Provide either "tasks" or "n" for swarm{action:"add"}, not both.');
		}
		if (input.tasks !== undefined && input.tasks.length === 0) {
			throw new Error('"tasks" must contain at least one task string.');
		}
		if (input.n !== undefined && (!Number.isInteger(input.n) || input.n < 1)) {
			throw new Error('"n" must be a positive integer >= 1.');
		}

		const callerMember = callerName === "coordinator" ? undefined : this.board.getMember(callerName);
		if (callerName !== "coordinator" && !callerMember) {
			throw new Error(`Unknown caller "${callerName}".`);
		}

		// Determine target worker specs
		const isGroup = input.tasks !== undefined || input.n !== undefined;
		const count = input.tasks ? input.tasks.length : (input.n ?? 1);
		const baseValidation = validateWorkerName(input.name);
		if (!baseValidation.ok) {
			throw new Error(baseValidation.error);
		}

		const existingMembers = this.board.listMembers();
		if (isGroup && existingMembers.some((m) => m.name === input.name)) {
			throw new Error(`Group base name "${input.name}" collides with existing worker "${input.name}".`);
		}
		if (!isGroup && existingMembers.some((m) => m.group === input.name)) {
			throw new Error(`Worker name "${input.name}" collides with existing group "${input.name}".`);
		}

		const specs: Array<{ name: string; group?: string; taskText?: string }> = [];
		if (isGroup) {
			for (let i = 0; i < count; i++) {
				const workerName = `${input.name}-${i + 1}`;
				const check = validateWorkerName(workerName);
				if (!check.ok) {
					throw new Error(check.error);
				}
				if (this.board.getMember(workerName)) {
					throw new Error(`Worker "${workerName}" already exists (killed names cannot be reused).`);
				}
				specs.push({
					name: workerName,
					group: input.name,
					taskText: input.tasks ? input.tasks[i] : undefined,
				});
			}
		} else {
			if (this.board.getMember(input.name)) {
				throw new Error(`Worker "${input.name}" already exists (killed names cannot be reused).`);
			}
			specs.push({ name: input.name });
		}

		// Resolve channels (workers inherit adder's channels unless explicitly provided)
		const rawChannels =
			input.channels !== undefined
				? input.channels
				: callerMember
					? [...callerMember.channels]
					: [];
		const resolvedChannels: string[] = [];
		const state = this.board.getState();
		for (const ch of rawChannels) {
			const check = validateChannelName(ch);
			if (!check.ok) {
				throw new Error(check.error);
			}
			const record = state.channels[ch];
			if (!record) {
				throw new Error(`Channel "#${ch}" does not exist.`);
			}
			if (record.archived) {
				throw new Error(`Channel "#${ch}" is archived.`);
			}
			if (ch !== MAIN_CHANNEL && !resolvedChannels.includes(ch)) {
				resolvedChannels.push(ch);
			}
		}

		// Resolve model before creating workspaces/sessions
		const resolvedModel = input.model
			? this.resolveModelFromContext(input.model, callerCtx)
			: this.resolveCallerModel(callerName, callerCtx);

		// Resolve fork snapshot once if requested
		const forkSource = input.fork ? this.resolveForkSource(input.fork, callerCtx) : undefined;

		// Base cwd for workspace setup: worker helpers inherit adder's workspace by default
		const baseCwd = callerMember ? callerMember.workspacePath : this.cwd;
		const workspaceMode: WorkspaceMode = input.workspace ?? "inherit";
		const workersDir = join(this.swarmDir, "workers");
		mkdirSync(workersDir, { recursive: true });

		const results: AddWorkerEntryResult[] = [];
		for (const spec of specs) {
			if (this.disposed || this.stopping) {
				throw new Error("SwarmManager is stopping or disposed.");
			}
			const ws = await setupWorkspace({
				mode: workspaceMode,
				hostCwd: baseCwd,
				swarmDir: this.swarmDir,
				swarmId: state.swarmId,
				workerName: spec.name,
			});
			if (this.disposed || this.stopping) {
				const fallbackCwd = existsSync(baseCwd) ? baseCwd : this.cwd;
				await removeWorkspace(ws.mode, ws.workspacePath, fallbackCwd).catch(() => {});
				throw new Error("SwarmManager is stopping or disposed.");
			}

			const sessionFile = join(workersDir, `${spec.name}.jsonl`);
			if (forkSource) {
				writeForkedSessionFile(
					forkSource.entries,
					sessionFile,
					ws.workspacePath,
					forkSource.parentSessionFile,
				);
			}

			const fullBrief = spec.taskText
				? `${input.brief}\n\nAssigned slice: ${spec.taskText}`
				: input.brief;
			const primaryChannel = resolvedChannels[0] ?? MAIN_CHANNEL;
			const briefText = `@${spec.name} ${fullBrief}`;
			const briefMsg = this.board.postMessage({
				author: callerName,
				text: briefText,
				channel: primaryChannel,
			});

			const member: MemberRecord = {
				name: spec.name,
				...(spec.group ? { group: spec.group } : {}),
				addedBy: callerName,
				state: "working",
				...(resolvedModel ? { model: formatModelRef(resolvedModel) } : {}),
				workspaceMode: ws.mode,
				workspacePath: ws.workspacePath,
				...(ws.workspaceBranch ? { workspaceBranch: ws.workspaceBranch } : {}),
				channels: [...resolvedChannels],
				wakeMode: "mentions",
				waitSince: briefMsg.seq,
				lastReadSeq: briefMsg.seq,
				sessionFile,
				usage: createEmptyUsage(),
				createdAt: Date.now(),
			};
			this.board.upsertMember(member);

			try {
				await this.createAndStartWorkerSession(member, resolvedModel);
			} catch (err) {
				// Clean up workspace if session creation fails
				const fallbackCwd = existsSync(baseCwd) ? baseCwd : this.cwd;
				await removeWorkspace(member.workspaceMode, member.workspacePath, fallbackCwd).catch(() => {});
				member.state = "killed";
				member.killedAt = Date.now();
				member.lastError = err instanceof Error ? err.message : String(err);
				this.board.upsertMember(member);
				this.emitSnapshot();
				throw err;
			}

			if (results.length === 0) {
				this.callbacks?.onToolsActivationNeeded?.();
			}

			// Evaluate wakeups for OTHER members mentioned in the brief, skipping the newly spawned worker
			this.evaluatePostWakeups(briefMsg, new Set([spec.name]));

			const initialPrompt = [
				`Brief from ${callerName} (posted as #${briefMsg.seq} in #${primaryChannel}):`,
				fullBrief,
				"",
				`Your board cursor is initialized at #${briefMsg.seq}. Report completion or blockers to @${callerName} (or the next peer) on the board.`,
			].join("\n");

			this.launchWorkerPrompt(member.name, initialPrompt);

			results.push({
				name: member.name,
				...(member.group ? { group: member.group } : {}),
				workspaceMode: member.workspaceMode,
				workspacePath: member.workspacePath,
				...(member.workspaceBranch ? { workspaceBranch: member.workspaceBranch } : {}),
				...(ws.dirtyWarning ? { dirtyWarning: ws.dirtyWarning } : {}),
				channel: primaryChannel,
				briefSeq: briefMsg.seq,
			});
		}

		this.emitSnapshot();
		return { workers: results };
	}

	private createWorkerExtension(memberName: string): (pi: ExtensionAPI) => void {
		const manager = this;
		const includeMonitor = isMonitorName(memberName);
		return (pi: ExtensionAPI) => {
			const tools = createSwarmToolDefinitions({
				getManager: () => manager,
				callerName: memberName,
				defaultActive: true,
				includeMonitorTools: includeMonitor,
				includeWorkerProcessTools: !includeMonitor,
			});
			for (const tool of tools.all) {
				pi.registerTool(tool);
			}
			pi.on("before_agent_start", (event) => {
				const currentMember = manager.board.getMember(memberName);
				if (currentMember) {
					event.systemPromptOptions.sections["swarm_worker"] = buildWorkerSystemPromptSection(currentMember);
				}
			});
		};
	}

	private async createAndStartWorkerSession(member: MemberRecord, model?: Model<Api>): Promise<ActiveWorkerRuntime> {
		const scopedModels = this.hostContext?.scopedModels
			? this.hostContext.scopedModels.map((s) => ({ model: s.model, thinkingLevel: s.thinkingLevel }))
			: undefined;

		const session = await this.sessionFactory({
			member,
			swarmDir: this.swarmDir,
			agentDir: this.agentDir,
			model,
			scopedModels,
			modelRuntime: this.modelRuntime,
			workerExtension: this.createWorkerExtension(member.name),
		});

		if (this.disposed || this.stopping || member.state === "killed") {
			try {
				session.dispose();
			} catch {
				// Ignore dispose errors on cancelled startup.
			}
			throw new Error(`Worker "${member.name}" was killed or stopped during session startup.`);
		}

		if (session.model && !member.model) {
			member.model = formatModelRef(session.model);
			this.board.upsertMember(member);
		}

		const runtime: ActiveWorkerRuntime = {
			session,
			unsubscribe: () => {},
			streamingText: "",
			activeTools: new Set<string>(),
			explicitWaitCalledThisTurn: false,
			lastTurnErrored: false,
			abortRequestedByUser: false,
			trackedSteering: [],
			trackedFollowUp: [],
			fallbackQueuedSteering: [],
			fallbackQueuedFollowUp: [],
			queueUpdateSeen: false,
		};

		runtime.unsubscribe = session.subscribe((event) => {
			this.handleWorkerSessionEvent(member.name, runtime, event);
		});

		this.activeWorkers.set(member.name, runtime);
		return runtime;
	}

	private async ensureActiveWorkerRuntime(member: MemberRecord): Promise<ActiveWorkerRuntime> {
		const existing = this.activeWorkers.get(member.name);
		if (existing) {
			return existing;
		}
		const inFlight = this.resumingWorkers.get(member.name);
		if (inFlight) {
			return inFlight;
		}
		const model = member.model ? this.resolveModelBestEffort(member.model) : undefined;
		const promise = this.createAndStartWorkerSession(member, model).finally(() => {
			if (this.resumingWorkers.get(member.name) === promise) {
				this.resumingWorkers.delete(member.name);
			}
		});
		this.resumingWorkers.set(member.name, promise);
		return promise;
	}

	private handleWorkerSessionEvent(
		memberName: string,
		runtime: ActiveWorkerRuntime,
		event: AgentSessionEvent,
	): void {
		const member = this.board.getMember(memberName);
		if (!member || member.state === "killed") {
			return;
		}

		switch (event.type) {
			case "agent_start": {
				member.state = "working";
				member.lastError = undefined;
				runtime.lastTurnErrored = false;
				runtime.streamingText = "";
				this.board.saveState();
				this.emitSnapshot();
				break;
			}
			case "queue_update": {
				runtime.queueUpdateSeen = true;
				runtime.trackedSteering = [...event.steering];
				runtime.trackedFollowUp = [...event.followUp];
				this.emitSnapshot();
				break;
			}
			case "message_start": {
				if (event.message.role === "user") {
					const msgText = extractUserMessageText(event.message);
					if (!runtime.session.getSteeringMessages) {
						const steerIdx = runtime.trackedSteering.indexOf(msgText);
						if (steerIdx !== -1) {
							runtime.trackedSteering.splice(steerIdx, 1);
							this.emitSnapshot();
							break;
						}
					}
					if (!runtime.session.getFollowUpMessages) {
						const followIdx = runtime.trackedFollowUp.indexOf(msgText);
						if (followIdx !== -1) {
							runtime.trackedFollowUp.splice(followIdx, 1);
							this.emitSnapshot();
						}
					}
				}
				break;
			}
			case "tool_execution_start": {
				runtime.activeTools.add(event.toolName);
				member.currentActivity = formatToolActivity(event.toolName, event.args);
				this.emitSnapshot();
				break;
			}
			case "tool_execution_end": {
				runtime.activeTools.delete(event.toolName);
				member.currentActivity = runtime.activeTools.size > 0
					? [...runtime.activeTools].join(", ")
					: "thinking";
				this.emitSnapshot();
				break;
			}
			case "message_update": {
				if (event.assistantMessageEvent.type === "text_delta") {
					runtime.streamingText += event.assistantMessageEvent.delta;
					this.emitSnapshot();
				}
				break;
			}
			case "message_end": {
				runtime.streamingText = "";
				if (event.message.role === "assistant") {
					const assistant = event.message as AssistantMessage;
					if (assistant.usage) {
						member.usage.input += assistant.usage.input;
						member.usage.output += assistant.usage.output;
						member.usage.cacheRead += assistant.usage.cacheRead;
						member.usage.cacheWrite += assistant.usage.cacheWrite;
						member.usage.cost += assistant.usage.cost.total;
					}
					member.usage.turns += 1;
					if (assistant.stopReason === "error") {
						member.lastError = formatQuotaOrErrorText(assistant.errorMessage);
						runtime.lastTurnErrored = true;
					}
					this.board.saveState();
					this.emitSnapshot();
				}
				break;
			}
			case "agent_settled": {
				this.onWorkerSettled(member, runtime, event.aborted);
				break;
			}
			default:
				break;
		}

		this.emitWorkerEvent(memberName, event);
	}

	private enqueuePendingProcessEvent(memberName: string, event: BackgroundProcessEvent): void {
		const queue = this.pendingWorkerProcessEvents.get(memberName) ?? [];
		queue.push(event);
		this.pendingWorkerProcessEvents.set(memberName, queue);
	}

	private clearWorkerQueues(memberName: string, runtime: ActiveWorkerRuntime): void {
		const before = this.getWorkerQueuedMessages(memberName);
		const hadAny =
			before.steering.length > 0 ||
			before.followUp.length > 0 ||
			runtime.trackedSteering.length > 0 ||
			runtime.trackedFollowUp.length > 0 ||
			runtime.fallbackQueuedSteering.length > 0 ||
			runtime.fallbackQueuedFollowUp.length > 0;

		runtime.queueUpdateSeen = false;
		runtime.trackedSteering.length = 0;
		runtime.trackedFollowUp.length = 0;
		runtime.fallbackQueuedSteering.length = 0;
		runtime.fallbackQueuedFollowUp.length = 0;
		runtime.session.clearQueue?.();

		if (hadAny && !runtime.queueUpdateSeen) {
			const queued = this.getWorkerQueuedMessages(memberName);
			this.emitWorkerEvent(memberName, {
				type: "queue_update",
				steering: queued.steering,
				followUp: queued.followUp,
			});
			this.emitSnapshot();
		}
	}

	private onWorkerSettled(member: MemberRecord, runtime: ActiveWorkerRuntime, aborted: boolean): void {
		if (this.disposed || member.state === "killed") {
			return;
		}

		const wasAborted = aborted || runtime.abortRequestedByUser;
		runtime.abortRequestedByUser = false;
		runtime.streamingText = "";
		runtime.activeTools.clear();
		member.currentActivity = undefined;

		if (!runtime.explicitWaitCalledThisTurn) {
			member.wakeMode = "mentions";
			member.waitSince = member.lastReadSeq;
		}
		runtime.explicitWaitCalledThisTurn = false;
		member.state = "waiting";
		if (wasAborted) {
			runtime.lastTurnErrored = false;
			member.lastError = undefined;
		}
		this.board.saveState();
		this.emitSnapshot();

		if (wasAborted || runtime.lastTurnErrored) {
			if (wasAborted) {
				this.clearWorkerQueues(member.name, runtime);
				this.pendingWorkerWakeSeq.delete(member.name);
				this.pendingWorkerScheduleWake.delete(member.name);
				this.pendingWorkerProcessEvents.delete(member.name);
				this.scheduler.notifyWorkerIdle(member.name);
			}
			// Aborted or failed turns sit out until a new wake/prompt/model-switch arrives.
			return;
		}

		const nextDirectText =
			runtime.fallbackQueuedSteering.shift() ?? runtime.fallbackQueuedFollowUp.shift();
		if (nextDirectText !== undefined) {
			this.emitWorkerEvent(member.name, {
				type: "queue_update",
				steering: [...runtime.fallbackQueuedSteering],
				followUp: [...runtime.fallbackQueuedFollowUp],
			});
			this.emitSnapshot();
			queueMicrotask(() => {
				const current = this.board.getMember(member.name);
				if (this.disposed || this.stopping || !current || current.state !== "waiting") {
					return;
				}
				current.state = "working";
				current.lastError = undefined;
				this.board.saveState();
				this.emitSnapshot();
				this.launchWorkerPrompt(member.name, nextDirectText);
			});
			return;
		}

		const pendingProcEvents = this.pendingWorkerProcessEvents.get(member.name);
		if (pendingProcEvents && pendingProcEvents.length > 0) {
			this.pendingWorkerProcessEvents.delete(member.name);
			const [firstEvent, ...extraEvents] = pendingProcEvents;
			queueMicrotask(() => {
				void this.wakeWorker(member.name, {
					kind: firstEvent.kind,
					event: firstEvent,
					...(extraEvents.length > 0 ? { extraEvents } : {}),
				});
			});
			return;
		}

		const pendingSeq = this.pendingWorkerWakeSeq.get(member.name);
		this.pendingWorkerWakeSeq.delete(member.name);

		if (pendingSeq !== undefined && member.lastReadSeq < pendingSeq) {
			const msg = this.board.getMessagesBySeqs([pendingSeq], member.name)[0];
			if (msg && doesMessageWakeMember(msg, member, this.board.getState().members, this.board.getState().channels)) {
				queueMicrotask(() => {
					void this.wakeWorker(member.name, { kind: "board", message: msg });
				});
				return;
			}
		}

		const pendingSchedule = this.pendingWorkerScheduleWake.get(member.name);
		if (pendingSchedule) {
			this.pendingWorkerScheduleWake.delete(member.name);
			queueMicrotask(() => {
				void this.wakeWorker(member.name, { kind: "schedule", task: pendingSchedule });
			});
			return;
		}

		this.scheduler.notifyWorkerIdle(member.name);
	}

	private launchWorkerPrompt(memberName: string, promptText: string): void {
		const runtime = this.activeWorkers.get(memberName);
		if (!runtime) {
			return;
		}
		void runtime.session.prompt(promptText).catch((err: unknown) => {
			const member = this.board.getMember(memberName);
			if (!member || member.state === "killed") {
				return;
			}
			if (runtime.abortRequestedByUser || member.state !== "working") {
				return;
			}
			runtime.lastTurnErrored = true;
			member.lastError = err instanceof Error ? err.message : String(err);
			member.currentActivity = undefined;
			member.state = "waiting";
			this.board.saveState();
			this.emitSnapshot();
		});
	}

	/**
	 * Sends a strictly private message directly to a worker's session (zero board posts).
	 * - `waiting`: prompts immediately
	 * - `working`: queues as `steer` (default) or `followUp`
	 * - `stopped`: resumes persisted session, re-attaches live events, and prompts
	 * - `killed`: throws a read-only error
	 */
	async sendDirectWorkerMessage(
		name: string,
		text: string,
		delivery?: DirectWorkerMessageDelivery,
	): Promise<DirectWorkerMessageResult> {
		if (this.disposed || this.stopping) {
			throw new Error("SwarmManager is stopping or disposed.");
		}
		if (!text || text.trim().length === 0) {
			throw new Error("Direct worker message requires non-empty text.");
		}
		const member = this.board.getMember(name);
		if (!member) {
			throw new Error(`Worker "${name}" does not exist.`);
		}
		if (member.state === "killed") {
			throw new Error(`Worker "${name}" has been killed and is read-only.`);
		}

		let resumed = false;
		let runtime = this.activeWorkers.get(name);
		if (!runtime) {
			const inFlight = this.resumingWorkers.get(name);
			if (inFlight) {
				await inFlight.catch(() => {});
				runtime = this.activeWorkers.get(name);
			}
		}

		const postResumeMember = this.board.getMember(name);
		if (!postResumeMember || postResumeMember.state === "killed") {
			throw new Error(`Worker "${name}" has been killed and is read-only.`);
		}

		if (!runtime) {
			resumed = true;
			this.wakingWorkers.add(name);
			postResumeMember.state = "working";
			postResumeMember.lastError = undefined;
			this.board.saveState();
			this.emitSnapshot();
			try {
				runtime = await this.ensureActiveWorkerRuntime(postResumeMember);
				if (this.disposed || this.stopping || this.board.getMember(name)?.state === "killed") {
					throw new Error(`Worker "${name}" was killed or stopped during session resume.`);
				}
				if (this.abortRequestedBeforeSession.delete(name)) {
					postResumeMember.state = "waiting";
					postResumeMember.currentActivity = undefined;
					this.board.saveState();
					this.emitSnapshot();
					return {
						worker: name,
						delivery: "prompt",
						resumed: true,
						queued: false,
						state: postResumeMember.state,
					};
				}
				runtime.lastTurnErrored = false;
				runtime.abortRequestedByUser = false;
				this.emitSnapshot();
				this.launchWorkerPrompt(name, text);
				return {
					worker: name,
					delivery: "prompt",
					resumed: true,
					queued: false,
					state: this.board.getMember(name)?.state ?? "waiting",
				};
			} catch (err) {
				const current = this.board.getMember(name);
				if (current && current.state !== "killed" && !this.disposed && !this.stopping) {
					current.state = this.activeWorkers.has(name) ? "waiting" : "stopped";
					current.currentActivity = undefined;
					current.lastError = err instanceof Error ? err.message : String(err);
					this.board.saveState();
					this.emitSnapshot();
				}
				throw err;
			} finally {
				this.wakingWorkers.delete(name);
			}
		}

		if (postResumeMember.state === "working" || this.wakingWorkers.has(name)) {
			const effectiveDelivery: DirectWorkerMessageDelivery =
				delivery === "followUp" ? "followUp" : "steer";
			if (effectiveDelivery === "followUp") {
				if (runtime.session.followUp) {
					runtime.queueUpdateSeen = false;
					const trackFallback = !runtime.session.getFollowUpMessages;
					if (trackFallback) {
						runtime.trackedFollowUp.push(text);
					}
					try {
						await runtime.session.followUp(text);
					} catch (err) {
						if (trackFallback && !runtime.queueUpdateSeen) {
							const idx = runtime.trackedFollowUp.lastIndexOf(text);
							if (idx !== -1) {
								runtime.trackedFollowUp.splice(idx, 1);
							}
						}
						throw err;
					}
					if (!runtime.queueUpdateSeen) {
						const queued = this.getWorkerQueuedMessages(name);
						this.emitWorkerEvent(name, {
							type: "queue_update",
							steering: queued.steering,
							followUp: queued.followUp,
						});
						this.emitSnapshot();
					}
				} else {
					runtime.fallbackQueuedFollowUp.push(text);
					const queued = this.getWorkerQueuedMessages(name);
					this.emitWorkerEvent(name, {
						type: "queue_update",
						steering: queued.steering,
						followUp: queued.followUp,
					});
					this.emitSnapshot();
				}
			} else {
				if (runtime.session.steer) {
					runtime.queueUpdateSeen = false;
					const trackFallback = !runtime.session.getSteeringMessages;
					if (trackFallback) {
						runtime.trackedSteering.push(text);
					}
					try {
						await runtime.session.steer(text);
					} catch (err) {
						if (trackFallback && !runtime.queueUpdateSeen) {
							const idx = runtime.trackedSteering.lastIndexOf(text);
							if (idx !== -1) {
								runtime.trackedSteering.splice(idx, 1);
							}
						}
						throw err;
					}
					if (!runtime.queueUpdateSeen) {
						const queued = this.getWorkerQueuedMessages(name);
						this.emitWorkerEvent(name, {
							type: "queue_update",
							steering: queued.steering,
							followUp: queued.followUp,
						});
						this.emitSnapshot();
					}
				} else {
					runtime.fallbackQueuedSteering.push(text);
					const queued = this.getWorkerQueuedMessages(name);
					this.emitWorkerEvent(name, {
						type: "queue_update",
						steering: queued.steering,
						followUp: queued.followUp,
					});
					this.emitSnapshot();
				}
			}
			return {
				worker: name,
				delivery: effectiveDelivery,
				resumed,
				queued: true,
				state: this.board.getMember(name)?.state ?? "working",
			};
		}

		// Worker is waiting with a live session attached -> prompt immediately
		postResumeMember.state = "working";
		postResumeMember.lastError = undefined;
		runtime.lastTurnErrored = false;
		runtime.abortRequestedByUser = false;
		this.board.saveState();
		this.emitSnapshot();
		this.launchWorkerPrompt(name, text);
		return {
			worker: name,
			delivery: "prompt",
			resumed,
			queued: false,
			state: this.board.getMember(name)?.state ?? "waiting",
		};
	}

	/**
	 * Aborts only the specified worker's running turn without affecting Coordinator or peers.
	 * Safe no-op (`{ aborted: false, state }`) when the worker is already idle/stopped/killed.
	 */
	async abortWorkerByUser(name: string): Promise<AbortWorkerResult> {
		const member = this.board.getMember(name);
		if (!member) {
			throw new Error(`Worker "${name}" does not exist.`);
		}
		if (member.state !== "working" && !this.wakingWorkers.has(name)) {
			return { aborted: false, state: member.state };
		}

		let runtime = this.activeWorkers.get(name);
		if (!runtime) {
			this.abortRequestedBeforeSession.add(name);
			const pendingResume = this.resumingWorkers.get(name);
			if (pendingResume) {
				await pendingResume.catch(() => {});
			}
			runtime = this.activeWorkers.get(name);
			if (!runtime) {
				this.abortRequestedBeforeSession.delete(name);
				const refreshed = this.board.getMember(name);
				if (refreshed && refreshed.state === "working") {
					refreshed.state = "waiting";
					refreshed.currentActivity = undefined;
					this.board.saveState();
					this.emitSnapshot();
				}
				return { aborted: true, state: refreshed?.state ?? "waiting" };
			}
		}

		runtime.abortRequestedByUser = true;
		this.clearWorkerQueues(name, runtime);

		try {
			await runtime.session.abort();
		} catch {
			// Ignore abort errors and settle worker state cleanly.
		}

		const current = this.board.getMember(name);
		if (!current || current.state === "killed") {
			runtime.abortRequestedByUser = false;
			return { aborted: true, state: current?.state ?? "killed" };
		}
		if (current.state === "working") {
			this.onWorkerSettled(current, runtime, true);
		} else {
			runtime.abortRequestedByUser = false;
		}
		return {
			aborted: true,
			state: this.board.getMember(name)?.state ?? "waiting",
		};
	}

	/** Posts a message to the board and evaluates wakeups for all non-killed members and coordinator. */
	postMessage(author: string, text: string, channel?: string): BoardMessage {
		if (!text || text.trim().length === 0) {
			throw new Error("post_message requires non-empty text.");
		}
		let resolvedChannel = channel;
		if (!resolvedChannel && author !== "coordinator") {
			const member = this.board.getMember(author);
			if (member && member.channels.length > 0) {
				resolvedChannel = member.channels[0];
			}
		}

		const msg = this.board.postMessage({
			author,
			text,
			channel: resolvedChannel ?? MAIN_CHANNEL,
		});
		this.emitSnapshot();
		this.evaluatePostWakeups(msg);
		return msg;
	}

	/** Reads messages visible to `viewer`, advancing `lastReadSeq` on full-view reads. */
	readBoard(options: ReadBoardOptions): ReadBoardResult {
		const result = this.board.readBoard(options);
		this.emitSnapshot();
		return result;
	}

	/**
	 * Non-blocking `swarm_wait`: checks for existing matching posts after `since`.
	 * If found, returns an immediate notice to read them; otherwise persists `{ wakeMode, waitSince }`
	 * and instructs the caller to end its turn immediately.
	 */
	requestWait(callerName: string, input: RequestWaitInput = {}): RequestWaitResult {
		const state = this.board.getState();
		const wakeMode: WakeMode = input.mentions_only === false ? "anything" : "mentions";

		if (callerName === "coordinator") {
			const waitSince = input.since ?? state.coordinator.lastReadSeq;
			const probeState: CoordinatorState = { ...state.coordinator, wakeMode };
			const matching = this.board
				.peekUnread("coordinator", waitSince)
				.filter((msg) => doesMessageWakeCoordinator(msg, probeState, state.channels));

			if (matching.length > 0) {
				const seqList = matching.map((m) => `#${m.seq}`).join(", ");
				return {
					parked: false,
					wakeMode,
					waitSince,
					matchingSeqs: matching.map((m) => m.seq),
					notice: `Matching posts already exist after #${waitSince}: ${seqList}. Call read_board({ since: ${waitSince} }) before parking.`,
				};
			}

			state.coordinator.wakeMode = wakeMode;
			state.coordinator.waitSince = waitSince;
			this.coordinatorExplicitWaitThisTurn = true;
			this.board.saveState();
			this.emitSnapshot();

			return {
				parked: true,
				wakeMode,
				waitSince,
				matchingSeqs: [],
				notice: `Parked coordinator in "${wakeMode}" mode waiting for posts after #${waitSince}. End your turn now without further tool calls; Pi will wake you automatically when a matching post arrives.`,
			};
		}

		const member = this.board.getMember(callerName);
		if (!member) {
			throw new Error(`Unknown swarm member "${callerName}".`);
		}
		if (member.state === "killed") {
			throw new Error(`Member "${callerName}" has been killed.`);
		}

		const waitSince = input.since ?? member.lastReadSeq;
		const probeMember: MemberRecord = { ...member, wakeMode };
		const matching = this.board
			.peekUnread(callerName, waitSince)
			.filter((msg) => doesMessageWakeMember(msg, probeMember, state.members, state.channels));

		if (matching.length > 0) {
			const seqList = matching.map((m) => `#${m.seq}`).join(", ");
			return {
				parked: false,
				wakeMode,
				waitSince,
				matchingSeqs: matching.map((m) => m.seq),
				notice: `Matching posts already exist after #${waitSince}: ${seqList}. Call read_board({ since: ${waitSince} }) before parking.`,
			};
		}

		member.wakeMode = wakeMode;
		member.waitSince = waitSince;
		const runtime = this.activeWorkers.get(callerName);
		if (runtime) {
			runtime.explicitWaitCalledThisTurn = true;
		}
		this.board.saveState();
		this.emitSnapshot();

		return {
			parked: true,
			wakeMode,
			waitSince,
			matchingSeqs: [],
			notice: `Parked "${callerName}" in "${wakeMode}" mode waiting for posts after #${waitSince}. End your turn now without further tool calls; you will be woken automatically when a matching post arrives.`,
		};
	}

	private evaluatePostWakeups(msg: BoardMessage, skipMembers?: Set<string>): void {
		if (this.disposed) {
			return;
		}
		const state = this.board.getState();

		for (const member of this.board.listMembers()) {
			if (member.state === "killed" || member.name === msg.author || skipMembers?.has(member.name)) {
				continue;
			}
			if (!doesMessageWakeMember(msg, member, state.members, state.channels)) {
				continue;
			}
			if (member.state === "working" || this.wakingWorkers.has(member.name)) {
				const prev = this.pendingWorkerWakeSeq.get(member.name) ?? 0;
				if (msg.seq > prev) {
					this.pendingWorkerWakeSeq.set(member.name, msg.seq);
				}
				continue;
			}
			if (msg.seq > member.waitSince || member.state === "stopped") {
				queueMicrotask(() => {
					void this.wakeWorker(member.name, { kind: "board", message: msg });
				});
			}
		}

		if (msg.author !== "coordinator" && doesMessageWakeCoordinator(msg, state.coordinator, state.channels)) {
			const unreadCount = this.board.peekUnread("coordinator", state.coordinator.lastReadSeq).length;
			const wake: CoordinatorWakeEvent = {
				seq: msg.seq,
				author: msg.author,
				channel: msg.channel,
				text: msg.text,
				unreadCount,
				head: this.board.head,
			};
			if (state.coordinator.state === "working" || (this.hostContext && !this.hostContext.isIdle())) {
				this.queueCoordinatorWake(wake);
			} else if (state.coordinator.lastReadSeq < msg.seq) {
				this.dispatchCoordinatorWake(wake);
			}
		}
	}

	private queueCoordinatorWake(wake: CoordinatorWakeEvent): void {
		if (!this.pendingCoordinatorWake || wake.seq >= this.pendingCoordinatorWake.seq) {
			this.pendingCoordinatorWake = wake;
		}
	}

	private dispatchCoordinatorWake(wake: CoordinatorWakeEvent): void {
		if (this.disposed) {
			return;
		}
		const state = this.board.getState();
		if (state.coordinator.lastReadSeq >= wake.seq) {
			return;
		}
		if (this.hostContext && !this.hostContext.isIdle()) {
			this.queueCoordinatorWake(wake);
			return;
		}
		void Promise.resolve(this.callbacks?.wakeCoordinator(wake))
			.then((delivered) => {
				if (delivered === false && !this.disposed) {
					this.queueCoordinatorWake(wake);
				}
			})
			.catch(() => {
				// Host wake callback failures must not crash board posting.
			});
	}

	private handleBackgroundProcessEvent(event: BackgroundProcessEvent): void {
		if (this.disposed || this.stopping) {
			return;
		}
		const ownerName = event.summary.ownerWorker;
		const member = this.board.getMember(ownerName);
		if (!member || member.state === "killed") {
			return;
		}

		this.emitSnapshot();

		const runtime = this.activeWorkers.get(ownerName);
		const isBusy = member.state === "working" || this.wakingWorkers.has(ownerName);
		const hasPendingError = Boolean(member.lastError) || Boolean(runtime?.lastTurnErrored);
		if (isBusy || hasPendingError) {
			this.enqueuePendingProcessEvent(ownerName, event);
			return;
		}

		void this.wakeWorker(ownerName, { kind: event.kind, event });
	}

	private handleScheduledTick(task: ScheduledTaskRecord): void {
		if (this.disposed) {
			return;
		}
		const member = this.board.getMember(task.targetWorker);
		if (!member || member.state === "killed") {
			return;
		}
		if (member.state === "working" || this.wakingWorkers.has(member.name)) {
			this.pendingWorkerScheduleWake.set(member.name, task);
			return;
		}
		void this.wakeWorker(member.name, { kind: "schedule", task });
	}

	private queueReasonWhileBusy(memberName: string, reason: WakeReason): void {
		if (reason.kind === "board") {
			const prev = this.pendingWorkerWakeSeq.get(memberName) ?? 0;
			if (reason.message.seq > prev) {
				this.pendingWorkerWakeSeq.set(memberName, reason.message.seq);
			}
		} else if (reason.kind === "schedule") {
			this.pendingWorkerScheduleWake.set(memberName, reason.task);
		} else if (reason.kind === "process_exit" || reason.kind === "process_still_running") {
			this.enqueuePendingProcessEvent(memberName, reason.event);
			if (reason.extraEvents) {
				for (const extra of reason.extraEvents) {
					this.enqueuePendingProcessEvent(memberName, extra);
				}
			}
		}
	}

	private async wakeWorker(memberName: string, reason: WakeReason): Promise<void> {
		if (this.disposed || this.stopping) {
			return;
		}
		if (this.wakingWorkers.has(memberName)) {
			this.queueReasonWhileBusy(memberName, reason);
			return;
		}
		const member = this.board.getMember(memberName);
		if (!member || member.state === "killed") {
			return;
		}
		if (member.state === "working") {
			this.queueReasonWhileBusy(memberName, reason);
			return;
		}

		if (reason.kind === "board" && member.lastReadSeq >= reason.message.seq) {
			return;
		}

		this.wakingWorkers.add(memberName);
		member.state = "working";
		member.lastError = undefined;
		this.board.saveState();
		this.emitSnapshot();

		try {
			const runtime = await this.ensureActiveWorkerRuntime(member);
			if (this.disposed || this.stopping || this.board.getMember(memberName)?.state === "killed") {
				return;
			}
			if (this.abortRequestedBeforeSession.delete(memberName)) {
				member.state = "waiting";
				member.currentActivity = undefined;
				this.board.saveState();
				this.emitSnapshot();
				return;
			}
			runtime.lastTurnErrored = false;
			runtime.abortRequestedByUser = false;

			const promptText = this.formatWakePrompt(member, reason);
			this.launchWorkerPrompt(memberName, promptText);
		} catch (err) {
			if (this.disposed || this.stopping || this.board.getMember(memberName)?.state === "killed") {
				return;
			}
			member.state = this.activeWorkers.has(memberName) ? "waiting" : "stopped";
			member.lastError = err instanceof Error ? err.message : String(err);
			this.board.saveState();
			this.emitSnapshot();
		} finally {
			this.wakingWorkers.delete(memberName);
		}
	}

	private resolveModelBestEffort(modelRef: string): Model<Api> | undefined {
		try {
			return this.resolveModelFromContext(modelRef);
		} catch {
			return undefined;
		}
	}

	private formatProcessEventSection(event: BackgroundProcessEvent): string {
		const s = event.summary;
		const tailBlock = event.outputTail.length > 0 ? event.outputTail : "(no output)";
		const logLine = event.fullOutputPath ? `\nFull output log: ${event.fullOutputPath}` : "";
		if (event.kind === "process_exit") {
			const signalNote = s.signal ? ` (signal ${s.signal})` : "";
			return [
				`[process exit] Background process ${s.taskId} exited with code ${s.exitCode ?? 1}${signalNote} after ${formatDurationShort(s.elapsedMs)}.`,
				`Command: ${s.command}${logLine}`,
				`Output tail${event.truncated ? " (truncated)" : ""}:`,
				tailBlock,
				`Action: Process ${s.taskId} has finished. Continue your work, post results on the board with post_message, or call swarm_wait if waiting on others.`,
			].join("\n");
		}
		return [
			`[process still running] Background process ${s.taskId} is still running (elapsed ${formatDurationShort(s.elapsedMs)}, silent for ${formatDurationShort(s.silentMs)}).`,
			`Command: ${s.command}${logLine}`,
			`Latest output tail${event.truncated ? " (truncated)" : ""}:`,
			tailBlock,
			`Action: Do NOT poll in a loop. End your turn to keep waiting for process_exit, inspect with manage_process({ action: "status", task_id: "${s.taskId}" }), send input with manage_process({ action: "send_input", task_id: "${s.taskId}", input: "..." }), or kill it with manage_process({ action: "kill", task_id: "${s.taskId}" }).`,
		].join("\n");
	}

	private formatWakePrompt(member: MemberRecord, reason: WakeReason): string {
		if (reason.kind === "schedule") {
			return `[scheduled:${reason.task.taskId}] ${reason.task.prompt}`;
		}
		if (reason.kind === "model_switch") {
			return `[model switched] Your model was switched to ${reason.modelRef}. Resume your unfinished work.`;
		}
		if (reason.kind === "process_exit" || reason.kind === "process_still_running") {
			const events = [reason.event, ...(reason.extraEvents ?? [])];
			return events.map((ev) => this.formatProcessEventSection(ev)).join("\n\n---\n\n");
		}
		const msg = reason.message;
		const preview = msg.text.length > 160 ? `${msg.text.slice(0, 157)}...` : msg.text;
		return [
			`[board wake] New message #${msg.seq} from ${msg.author} in #${msg.channel} (${formatTimestampShort(msg.timestamp)}):`,
			preview,
			`Your lastReadSeq is #${member.lastReadSeq} (board head is #${this.board.head}). Call read_board({ since: ${member.lastReadSeq} }) to inspect unread messages.`,
		].join("\n");
	}

	/** Switches a worker's or coordinator's model while keeping conversation history. */
	async switchModel(
		input: { name?: string; model?: string },
		callerName: string,
		callerCtx?: ExtensionContext,
		explicitRegistry?: ModelRegistry,
	): Promise<ModelSwitchResult> {
		const target = input.name ?? callerName;

		if (target === "coordinator") {
			if (callerName !== "coordinator") {
				throw new Error(`Worker "${callerName}" cannot switch the coordinator's model.`);
			}
			if (!input.model) {
				throw new Error('Switching coordinator model requires "model".');
			}
			const resolvedModel = this.resolveModelFromContext(input.model, callerCtx, explicitRegistry);
			if (!this.callbacks?.setCoordinatorModel) {
				throw new Error("Host coordinator model switching callback is not configured.");
			}
			const previous = callerCtx?.model ?? this.hostContext?.model;
			const ok = await this.callbacks.setCoordinatorModel(resolvedModel);
			if (!ok) {
				throw new Error(`Failed to switch coordinator model to ${formatModelRef(resolvedModel)}.`);
			}
			this.emitSnapshot();
			return {
				target: "coordinator",
				model: formatModelRef(resolvedModel),
				...(previous ? { previousModel: formatModelRef(previous) } : {}),
				woke: false,
			};
		}

		const member = this.board.getMember(target);
		if (!member) {
			throw new Error(`Worker "${target}" does not exist.`);
		}
		if (member.state === "killed") {
			throw new Error(`Worker "${target}" has been killed.`);
		}
		if (callerName !== "coordinator" && target !== callerName && member.addedBy !== callerName) {
			throw new Error(
				`Permission denied: worker "${callerName}" can only switch its own model or helpers it added ("${target}" was added by "${member.addedBy}").`,
			);
		}
		if (target !== callerName && (member.state === "working" || this.wakingWorkers.has(target))) {
			throw new Error(`Cannot switch model of worker "${target}" while it is working.`);
		}

		const resolvedModel = input.model
			? this.resolveModelFromContext(input.model, callerCtx, explicitRegistry)
			: this.resolveCallerModel(callerName, callerCtx);
		if (!resolvedModel) {
			throw new Error('Could not resolve target model; provide an explicit "model" argument.');
		}

		const previousModel = member.model;
		const newModelRef = formatModelRef(resolvedModel);
		const hadError = Boolean(member.lastError);

		let runtime = this.activeWorkers.get(target);
		if (runtime) {
			await runtime.session.setModel(resolvedModel);
			const refreshed = this.board.getMember(target);
			if (this.disposed || !refreshed || refreshed.state === "killed") {
				throw new Error(`Worker "${target}" has been killed.`);
			}
		}

		member.model = newModelRef;
		member.lastError = undefined;
		if (runtime) {
			runtime.lastTurnErrored = false;
		}
		this.board.upsertMember(member);
		this.emitSnapshot();

		let woke = false;
		if (target !== callerName) {
			const messages = this.getWorkerMessages(target);
			const hasUnfinished = hasUnfinishedAssistantTurn(messages);
			const hasMatchingUnread = this.board
				.peekUnread(target, member.lastReadSeq)
				.some((m) => doesMessageWakeMember(m, member, this.board.getState().members, this.board.getState().channels));
			const hasPendingProcessEvents = (this.pendingWorkerProcessEvents.get(target)?.length ?? 0) > 0;
			const hasPendingSchedule = this.pendingWorkerScheduleWake.has(target);

			if (hadError || hasUnfinished || hasMatchingUnread || hasPendingProcessEvents || hasPendingSchedule) {
				woke = true;
				queueMicrotask(() => {
					void this.wakeWorker(target, { kind: "model_switch", modelRef: newModelRef });
				});
			}
		}

		return {
			target,
			model: newModelRef,
			...(previousModel ? { previousModel } : {}),
			woke,
		};
	}

	/** User-initiated model switch from the TUI Overlay (acts with coordinator authority). */
	switchWorkerModelByUser(
		name: string,
		modelRef: string,
		modelRegistry?: ModelRegistry,
	): Promise<ModelSwitchResult> {
		return this.switchModel({ name, model: modelRef }, "coordinator", this.hostContext, modelRegistry);
	}

	/** Permanently kills a single worker or an entire group (`<group>`), disposing sessions and removing workspaces. */
	async killTarget(name: string, callerName: string): Promise<KillResult> {
		const single = this.board.getMember(name);
		const groupMembers = single
			? []
			: this.board.listMembers().filter((m) => m.group === name && m.state !== "killed");

		const targets = single ? [single] : groupMembers;
		if (targets.length === 0) {
			throw new Error(`No live worker or group named "${name}".`);
		}
		if (single && single.state === "killed") {
			throw new Error(`Worker "${name}" is already killed.`);
		}

		if (callerName !== "coordinator") {
			for (const target of targets) {
				if (target.addedBy !== callerName) {
					throw new Error(
						`Permission denied: "${callerName}" cannot kill "${target.name}" (added by "${target.addedBy}").`,
					);
				}
			}
		}

		const killedAt = Date.now();
		for (const target of targets) {
			target.state = "killed";
			target.killedAt = killedAt;
			target.currentActivity = undefined;
			this.scheduler.killTasksForWorker(target.name);
			this.pendingWorkerWakeSeq.delete(target.name);
			this.pendingWorkerScheduleWake.delete(target.name);
			this.pendingWorkerProcessEvents.delete(target.name);
			this.abortRequestedBeforeSession.delete(target.name);
			this.board.upsertMember(target);
		}

		const killedNames: string[] = [];
		for (const target of targets) {
			await this.processManager.killByOwner(target.name);

			const runtime = this.activeWorkers.get(target.name);
			if (runtime) {
				this.activeWorkers.delete(target.name);
				runtime.unsubscribe();
				try {
					await runtime.session.abort();
				} catch {
					// Ignore abort errors during permanent termination.
				}
				try {
					runtime.session.dispose();
				} catch {
					// Ignore dispose errors during permanent termination.
				}
			}

			const adder = target.addedBy === "coordinator" ? undefined : this.board.getMember(target.addedBy);
			const hostCwd = adder && existsSync(adder.workspacePath) ? adder.workspacePath : this.cwd;
			await removeWorkspace(target.workspaceMode, target.workspacePath, hostCwd);

			killedNames.push(target.name);
		}

		this.emitSnapshot();
		return { killed: killedNames };
	}

	/** User-initiated kill from the TUI Overlay (acts with coordinator authority). */
	killWorkerByUser(name: string): Promise<KillResult> {
		return this.killTarget(name, "coordinator");
	}

	/** Updates the swarm title (coordinator-only). */
	setTitle(title: string, callerName = "coordinator"): void {
		if (callerName !== "coordinator") {
			throw new Error("Only the coordinator can set the swarm title.");
		}
		this.board.setTitle(title);
		this.emitSnapshot();
	}

	/** Updates `plan.json` (coordinator-only). */
	setPlan(plan: SwarmPlan, callerName = "coordinator"): SwarmPlan {
		if (callerName !== "coordinator") {
			throw new Error("Only the coordinator can update the swarm plan.");
		}
		const saved = this.board.setPlan(plan);
		this.emitSnapshot();
		return saved;
	}

	/** Handles channel `create`, `list`, `subscribe`, `unsubscribe`, and `archive` operations. */
	handleChannelOp(input: ChannelOpInput, callerName: string): ChannelOpResult {
		switch (input.op) {
			case "create": {
				if (!input.channel) {
					throw new Error('channel{op:"create"} requires "channel".');
				}
				const record = this.board.createChannel(input.channel, callerName, input.topic ?? "");
				this.emitSnapshot();
				return {
					op: "create",
					channel: record,
					summary: `Created channel #${record.name}${record.topic ? `: ${record.topic}` : ""}.`,
				};
			}
			case "list": {
				const liveMembers = this.board.listMembers().filter((m) => m.state !== "killed");
				const channels = this.board.listChannels(true).map((ch) => {
					const subscribers =
						ch.name === MAIN_CHANNEL
							? liveMembers.length + 1
							: liveMembers.filter((m) => m.channels.includes(ch.name)).length + 1;
					return { ...ch, subscribers };
				});
				const summary = channels
					.map(
						(c) =>
							`- #${c.name}${c.archived ? " [archived]" : ""} | subscribers=${c.subscribers} | by=${c.createdBy}${c.topic ? ` | ${c.topic}` : ""}`,
					)
					.join("\n");
				return {
					op: "list",
					channels,
					summary,
				};
			}
			case "subscribe": {
				if (!input.channel) {
					throw new Error('channel{op:"subscribe"} requires "channel".');
				}
				const target = input.name ?? callerName;
				this.assertCanModifyMemberChannel(callerName, target);
				const memberChannels = this.board.subscribeChannel(target, input.channel);
				this.emitSnapshot();
				return {
					op: "subscribe",
					memberChannels,
					summary: `Subscribed ${target} to #${input.channel}.`,
				};
			}
			case "unsubscribe": {
				if (!input.channel) {
					throw new Error('channel{op:"unsubscribe"} requires "channel".');
				}
				const target = input.name ?? callerName;
				this.assertCanModifyMemberChannel(callerName, target);
				const memberChannels = this.board.unsubscribeChannel(target, input.channel);
				this.emitSnapshot();
				return {
					op: "unsubscribe",
					memberChannels,
					summary: `Unsubscribed ${target} from #${input.channel}.`,
				};
			}
			case "archive": {
				if (!input.channel) {
					throw new Error('channel{op:"archive"} requires "channel".');
				}
				const record = this.board.archiveChannel(input.channel);
				this.emitSnapshot();
				return {
					op: "archive",
					channel: record,
					summary: `Archived channel #${record.name}.`,
				};
			}
		}
	}

	private assertCanModifyMemberChannel(callerName: string, targetName: string): void {
		if (callerName === "coordinator" || targetName === callerName) {
			return;
		}
		const target = this.board.getMember(targetName);
		if (!target) {
			throw new Error(`Member "${targetName}" does not exist.`);
		}
		if (target.addedBy !== callerName) {
			throw new Error(
				`Permission denied: "${callerName}" can only change channel subscriptions for itself or helpers it added.`,
			);
		}
	}

	/** Schedules a timer or cron task for a monitor worker. */
	scheduleForMonitor(callerName: string, input: ScheduleInput): ScheduleResult {
		if (!isMonitorName(callerName)) {
			throw new Error(`Only monitor workers can call schedule (caller: "${callerName}").`);
		}
		const member = this.board.getMember(callerName);
		if (!member || member.state === "killed") {
			throw new Error(`Monitor "${callerName}" is not active.`);
		}
		const result = this.scheduler.schedule(input, callerName);
		this.emitSnapshot();
		return result;
	}

	/** Lists or kills scheduled tasks owned by a monitor worker. */
	manageMonitorTask(callerName: string, input: ManageTaskInput): ManageTaskResult {
		if (!isMonitorName(callerName)) {
			throw new Error(`Only monitor workers can call manage_task (caller: "${callerName}").`);
		}
		const result = this.scheduler.manageTask(input, callerName);
		this.emitSnapshot();
		return result;
	}

	/** Executes an async backgrounding shell command on behalf of a non-monitor worker. */
	async runWorkerBash(callerName: string, input: AsyncBashInput): Promise<AsyncBashResult> {
		if (this.disposed || this.stopping) {
			throw new Error("SwarmManager is stopping or disposed.");
		}
		if (callerName === "coordinator" || isMonitorName(callerName)) {
			throw new Error(`Permission denied: "${callerName}" cannot execute worker background bash.`);
		}
		const member = this.board.getMember(callerName);
		if (!member) {
			throw new Error(`Unknown swarm worker "${callerName}".`);
		}
		if (member.state === "killed") {
			throw new Error(`Worker "${callerName}" has been killed.`);
		}

		const result = await this.processManager.runCommand({
			ownerWorker: callerName,
			command: input.command,
			cwd: member.workspacePath,
			waitMs: input.wait_ms,
			isDaemon: input.is_daemon,
			notifyAfterSeconds: input.notify_after_seconds,
			isCancelled: () => this.disposed || this.stopping || member.state === "killed",
		});
		if (result.status === "running") {
			this.emitSnapshot();
		}
		return result;
	}

	/** Manages background processes owned by a non-monitor worker (`list`, `status`, `send_input`, `kill`). */
	async manageWorkerProcess(callerName: string, input: ManageProcessInput): Promise<ManageProcessResult> {
		if (this.disposed) {
			throw new Error("SwarmManager is disposed.");
		}
		if (callerName === "coordinator" || isMonitorName(callerName)) {
			throw new Error(`Permission denied: "${callerName}" cannot manage worker background processes.`);
		}
		const member = this.board.getMember(callerName);
		if (!member) {
			throw new Error(`Unknown swarm worker "${callerName}".`);
		}
		if (member.state === "killed") {
			throw new Error(`Worker "${callerName}" has been killed.`);
		}

		switch (input.action) {
			case "list":
				return {
					kind: "list",
					processes: this.processManager.list(callerName),
				};
			case "status": {
				if (!input.task_id) {
					throw new Error('manage_process{action:"status"} requires "task_id".');
				}
				return {
					kind: "status",
					process: this.processManager.getStatus(callerName, input.task_id),
				};
			}
			case "send_input": {
				if (!input.task_id) {
					throw new Error('manage_process{action:"send_input"} requires "task_id".');
				}
				if (input.input === undefined) {
					throw new Error('manage_process{action:"send_input"} requires "input".');
				}
				return this.processManager.sendInput(callerName, input.task_id, input.input);
			}
			case "kill": {
				if (!input.task_id) {
					throw new Error('manage_process{action:"kill"} requires "task_id".');
				}
				const result = await this.processManager.kill(callerName, input.task_id);
				this.emitSnapshot();
				return result;
			}
		}
	}

	/** Aborts all running workers cleanly without deleting their workspaces or histories. */
	async stopAll(): Promise<void> {
		this.stopping = true;
		try {
			this.pendingWorkerWakeSeq.clear();
			this.pendingWorkerScheduleWake.clear();
			this.pendingWorkerProcessEvents.clear();
			this.pendingCoordinatorWake = undefined;

			const entries = [...this.activeWorkers.entries()];
			for (const [name, runtime] of entries) {
				this.clearWorkerQueues(name, runtime);
				try {
					await runtime.session.abort();
				} catch {
					// Ignore abort errors during stopAll.
				}
				const member = this.board.getMember(name);
				if (member && member.state === "working") {
					member.state = "waiting";
					member.currentActivity = undefined;
				}
			}

			await this.processManager.killAll();

			for (const member of this.board.listMembers()) {
				if (member.state === "working") {
					member.state = "stopped";
					member.currentActivity = undefined;
				}
			}

			this.board.saveState();
			this.emitSnapshot();
		} finally {
			this.stopping = false;
		}
	}

	/** Aborts workers, stops scheduler timers, and disposes sessions while preserving disk state & workspaces for `/resume`. */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.scheduler.dispose();
		this.processManager.dispose();
		this.pendingWorkerWakeSeq.clear();
		this.pendingWorkerScheduleWake.clear();
		this.pendingWorkerProcessEvents.clear();
		this.abortRequestedBeforeSession.clear();
		this.pendingCoordinatorWake = undefined;

		for (const [name, runtime] of this.activeWorkers.entries()) {
			runtime.unsubscribe();
			try {
				runtime.session.dispose();
			} catch {
				// Ignore dispose errors on shutdown.
			}
			const member = this.board.getMember(name);
			if (member && member.state !== "killed") {
				member.state = "stopped";
				member.currentActivity = undefined;
			}
		}
		this.activeWorkers.clear();

		for (const member of this.board.listMembers()) {
			if (member.state === "working" || member.state === "waiting") {
				member.state = "stopped";
				member.currentActivity = undefined;
			}
		}
		const state = this.board.getState();
		state.coordinator.state = "waiting";
		this.board.saveState();
		this.listeners.clear();
		this.workerEventListeners.clear();
	}
}

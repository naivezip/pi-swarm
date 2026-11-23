export type MemberState = "waiting" | "working" | "stopped" | "killed";

export type WakeMode = "mentions" | "anything";

export type WorkspaceMode = "inherit" | "share" | "branch";

export interface MemberUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	turns: number;
}

export interface MemberRecord {
	name: string;
	group?: string;
	addedBy: string;
	state: MemberState;
	model?: string;
	workspaceMode: WorkspaceMode;
	workspacePath: string;
	workspaceBranch?: string;
	channels: string[];
	wakeMode: WakeMode;
	waitSince: number;
	lastReadSeq: number;
	lastPostSeq?: number;
	lastPostTime?: number;
	sessionFile: string;
	usage: MemberUsage;
	currentActivity?: string;
	lastError?: string;
	createdAt: number;
	killedAt?: number;
}

export interface CoordinatorState {
	state: "waiting" | "working";
	wakeMode: WakeMode;
	waitSince: number;
	lastReadSeq: number;
	lastPostSeq?: number;
	lastPostTime?: number;
}

export interface ChannelRecord {
	name: string;
	topic: string;
	createdBy: string;
	createdAt: number;
	archived: boolean;
	archivedAt?: number;
}

export interface MessageMentions {
	members: string[];
	groups: string[];
	channels: string[];
	all: boolean;
}

export interface BoardMessage {
	seq: number;
	timestamp: number;
	author: string;
	channel: string;
	text: string;
	mentions: MessageMentions;
}

export interface SwarmPlanGoal {
	title: string;
	line: string;
}

export interface SwarmPlanThread {
	id: string;
	title: string;
	goal: string;
	tasks: string[];
}

export interface SwarmPlan {
	goal: SwarmPlanGoal;
	tasks: Record<string, string>;
	threads: SwarmPlanThread[];
}

export interface SwarmState {
	version: 1;
	swarmId: string;
	sessionId: string;
	title: string;
	cwd: string;
	createdAt: number;
	active: boolean;
	channels: Record<string, ChannelRecord>;
	members: Record<string, MemberRecord>;
	coordinator: CoordinatorState;
}

export type ScheduleKind = "cron" | "timer";

export interface ScheduledTaskRecord {
	taskId: string;
	kind: ScheduleKind;
	cronExpression?: string;
	durationSeconds?: number;
	isDaemon: boolean;
	prompt: string;
	targetWorker: string;
	createdAt: number;
	nextRunAt?: number;
	lastRunAt?: number;
	runCount: number;
	active: boolean;
}

export interface ScheduleInput {
	CronExpression?: string;
	DurationSeconds?: number;
	IsDaemon?: boolean;
	Prompt: string;
}

export interface ScheduleResult {
	taskId: string;
	kind: ScheduleKind;
	nextRunAt: number;
}

export type ManageTaskAction = "list" | "kill";

export interface ManageTaskInput {
	Action: ManageTaskAction;
	TaskId?: string;
}

export type ManageTaskResult =
	| { kind: "list"; tasks: ScheduledTaskRecord[] }
	| { kind: "kill"; taskId: string; killed: boolean };

export interface ReadBoardOptions {
	since?: number;
	limit?: number;
	channel?: string;
	viewer: string;
}

export interface ReadBoardResult {
	messages: BoardMessage[];
	head: number;
}

export interface MemberStatusSummary {
	name: string;
	group?: string;
	addedBy: string;
	state: MemberState;
	model?: string;
	workspaceMode: WorkspaceMode;
	workspacePath: string;
	workspaceBranch?: string;
	channels: string[];
	wakeMode: WakeMode;
	waitSince: number;
	lastReadSeq: number;
	unreadCount: number;
	lastPostSeq?: number;
	lastPostTime?: number;
	currentActivity?: string;
	lastError?: string;
	usage: MemberUsage;
}

export interface SwarmDetailedStatus {
	head: number;
	swarmId: string;
	sessionId: string;
	title: string;
	active: boolean;
	channels: ChannelRecord[];
	coordinator: CoordinatorState;
	members: MemberStatusSummary[];
}

export interface WorkspaceSetupResult {
	mode: WorkspaceMode;
	workspacePath: string;
	workspaceBranch?: string;
	dirtyWarning?: string;
}

export type ValidationResult =
	| { ok: true; value: string }
	| { ok: false; error: string };

export const MAIN_CHANNEL = "main";

export const WORKER_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,23}$/;

export const CHANNEL_NAME_REGEX = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** Returns true if the member name designates a swarm monitor (`monitor` or `monitor-<N>`). */
export function isMonitorName(name: string): boolean {
	return name === "monitor" || /^monitor-\d+$/.test(name);
}

/** Validates a worker roster name against syntax and reserved-name rules. */
export function validateWorkerName(name: string): ValidationResult {
	if (!WORKER_NAME_REGEX.test(name)) {
		return {
			ok: false,
			error: `Invalid worker name "${name}": must match ${WORKER_NAME_REGEX.source} (1-24 chars, lowercase a-z, 0-9, -, _, starting with a-z or 0-9).`,
		};
	}
	if (name === "all" || name === "coordinator" || name.startsWith("coordinator-")) {
		return {
			ok: false,
			error: `Worker name "${name}" is reserved (cannot be "all", "coordinator", or "coordinator-*").`,
		};
	}
	return { ok: true, value: name };
}

/** Returns true when the worker name is valid and not reserved. */
export function isValidWorkerName(name: string): boolean {
	return validateWorkerName(name).ok;
}

/** Validates a board channel name. */
export function validateChannelName(name: string): ValidationResult {
	if (!CHANNEL_NAME_REGEX.test(name)) {
		return {
			ok: false,
			error: `Invalid channel name "${name}": must match ${CHANNEL_NAME_REGEX.source} (1-32 chars, lowercase a-z, 0-9, -, _, starting with a-z or 0-9).`,
		};
	}
	return { ok: true, value: name };
}

/** Returns true when the channel name is syntactically valid. */
export function isValidChannelName(name: string): boolean {
	return validateChannelName(name).ok;
}

/** Creates a zero-initialized token/cost usage record. */
export function createEmptyUsage(): MemberUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		cost: 0,
		turns: 0,
	};
}

/** Creates an empty initial swarm plan. */
export function createDefaultPlan(): SwarmPlan {
	return {
		goal: { title: "", line: "" },
		tasks: {},
		threads: [],
	};
}

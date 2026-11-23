import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	type BoardMessage,
	type ChannelRecord,
	type CoordinatorState,
	createDefaultPlan,
	isMonitorName,
	MAIN_CHANNEL,
	type MemberRecord,
	type MessageMentions,
	type ReadBoardOptions,
	type ReadBoardResult,
	type SwarmDetailedStatus,
	type SwarmPlan,
	type SwarmState,
	validateChannelName,
} from "./types.ts";

export interface CreateBoardOptions {
	swarmDir: string;
	sessionId: string;
	cwd: string;
	swarmId?: string;
	title?: string;
}

export interface PostMessageInput {
	author: string;
	text: string;
	channel?: string;
}

const FENCED_CODE_RE = /(^|\n)[ \t]{0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:(?<=\n)[ \t]{0,3}\2[ \t]*(?=\n|$)|$)/g;
const INLINE_CODE_RE = /(`+)([\s\S]*?)\1/g;
const CHANNEL_MENTION_RE = /(^|[^a-zA-Z0-9_])@#([^\s,.:;!?()[\]{}"'`]+)/g;
const WORD_MENTION_RE = /(^|[^a-zA-Z0-9_])@([a-z0-9][a-z0-9_-]*)/g;

/** Returns the default root directory where Pi swarms are persisted (`<agentDir>/swarms`). */
export function getDefaultSwarmsRoot(agentDir?: string): string {
	return join(agentDir ?? getAgentDir(), "swarms");
}

/** Sanitizes a session ID so it is safe as a single directory name on all platforms. */
export function sanitizeSessionDirName(sessionId: string): string {
	const cleaned = sessionId.replace(/[^a-zA-Z0-9._-]/g, "_");
	return cleaned.length > 0 ? cleaned : "default";
}

/** Returns the directory path for a session's swarm (`<swarmsRoot>/<sessionId>`). */
export function getSwarmDir(sessionId: string, swarmsRoot?: string): string {
	return join(swarmsRoot ?? getDefaultSwarmsRoot(), sanitizeSessionDirName(sessionId));
}

/** Strips fenced code blocks and inline backtick spans while preserving character boundaries for mention parsing. */
function stripCodeForMentions(text: string): string {
	const withoutFences = text.replace(FENCED_CODE_RE, (match, prefix: string) => `${prefix} `);
	return withoutFences.replace(INLINE_CODE_RE, " ");
}

/** Parses `@name`, `@group`, `@all`, and `@#channel` mentions from message text, ignoring code blocks and inline backticks. */
export function parseMentions(
	text: string,
	knownMembers?: Iterable<string>,
	knownGroups?: Iterable<string>,
): MessageMentions {
	const cleaned = stripCodeForMentions(text);
	const memberSet = knownMembers ? new Set(knownMembers) : undefined;
	const groupSet = knownGroups ? new Set(knownGroups) : undefined;

	const members: string[] = [];
	const groups: string[] = [];
	const channels: string[] = [];
	let all = false;

	const seenMembers = new Set<string>();
	const seenGroups = new Set<string>();
	const seenChannels = new Set<string>();

	for (const match of cleaned.matchAll(CHANNEL_MENTION_RE)) {
		const channelName = match[2];
		if (!seenChannels.has(channelName)) {
			seenChannels.add(channelName);
			channels.push(channelName);
		}
	}

	// Remove @#channel tokens before scanning @name so channel names aren't double-parsed.
	const withoutChannelMentions = cleaned.replace(CHANNEL_MENTION_RE, "$1 ");

	for (const match of withoutChannelMentions.matchAll(WORD_MENTION_RE)) {
		const token = match[2];
		if (token === "all") {
			all = true;
			continue;
		}
		if (groupSet?.has(token)) {
			if (!seenGroups.has(token)) {
				seenGroups.add(token);
				groups.push(token);
			}
			// If a member also happens to share that exact name, include it as a member mention too.
			if (memberSet?.has(token) && !seenMembers.has(token)) {
				seenMembers.add(token);
				members.push(token);
			}
			continue;
		}
		if (!seenMembers.has(token)) {
			seenMembers.add(token);
			members.push(token);
		}
	}

	return { members, groups, channels, all };
}

function resolveWakeChannels(
	mentionedChannels: readonly string[],
	channels?: Record<string, ChannelRecord>,
): string[] {
	if (!channels) {
		return [...mentionedChannels];
	}
	return mentionedChannels.filter((ch) => {
		const record = channels[ch];
		return record !== undefined && !record.archived;
	});
}

/** Evaluates whether a board message wakes a worker member according to native_swarm routing rules. */
export function doesMessageWakeMember(
	msg: BoardMessage,
	member: MemberRecord,
	_allMembers?: readonly MemberRecord[] | Record<string, MemberRecord>,
	channels?: Record<string, ChannelRecord>,
): boolean {
	if (msg.author === member.name) {
		return false;
	}
	if (member.state === "killed") {
		return false;
	}
	if (msg.mentions.all) {
		return true;
	}
	if (msg.mentions.members.includes(member.name)) {
		return true;
	}
	if (
		member.group !== undefined &&
		(msg.mentions.groups.includes(member.group) || msg.mentions.members.includes(member.group))
	) {
		return true;
	}
	const activeChannels = resolveWakeChannels(msg.mentions.channels, channels);
	if (activeChannels.length > 0) {
		if (isMonitorName(member.name)) {
			return true;
		}
		if (activeChannels.some((ch) => ch === MAIN_CHANNEL || member.channels.includes(ch))) {
			return true;
		}
	}
	if (member.wakeMode === "anything") {
		if (isMonitorName(member.name)) {
			return true;
		}
		if (msg.channel === MAIN_CHANNEL || member.channels.includes(msg.channel)) {
			return true;
		}
	}
	return false;
}

/** Evaluates whether a board message wakes the coordinator. */
export function doesMessageWakeCoordinator(
	msg: BoardMessage,
	coordinator: CoordinatorState,
	channels?: Record<string, ChannelRecord>,
): boolean {
	if (msg.author === "coordinator") {
		return false;
	}
	if (msg.mentions.all) {
		return true;
	}
	if (msg.mentions.members.includes("coordinator")) {
		return true;
	}
	const activeChannels = resolveWakeChannels(msg.mentions.channels, channels);
	if (activeChannels.length > 0) {
		return true;
	}
	if (coordinator.wakeMode === "anything") {
		return true;
	}
	return false;
}

function writeJsonAtomic(filePath: string, data: unknown): void {
	const dir = dirname(filePath);
	mkdirSync(dir, { recursive: true });
	const tmpPath = `${filePath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
	writeFileSync(tmpPath, `${JSON.stringify(data, null, "\t")}\n`, "utf-8");
	renameSync(tmpPath, filePath);
}

function readBoardJsonl(boardPath: string): { messages: BoardMessage[]; hadTrailingPartial: boolean } {
	if (!existsSync(boardPath)) {
		return { messages: [], hadTrailingPartial: false };
	}
	const raw = readFileSync(boardPath, "utf-8");
	const lines = raw.split(/\r?\n/);
	const messages: BoardMessage[] = [];
	let hadTrailingPartial = false;
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i].trim();
		if (line.length === 0) {
			continue;
		}
		try {
			const parsed = JSON.parse(line) as BoardMessage;
			messages.push(parsed);
		} catch (err) {
			// Ignore an incomplete trailing line caused by a crash mid-append.
			const isLastNonEmpty = lines.slice(i + 1).every((tail) => tail.trim().length === 0);
			if (isLastNonEmpty) {
				hadTrailingPartial = true;
				break;
			}
			throw new Error(`Corrupted board.jsonl at line ${i + 1}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	return { messages, hadTrailingPartial };
}

function createInitialState(options: CreateBoardOptions): SwarmState {
	const now = Date.now();
	return {
		version: 1,
		swarmId: options.swarmId ?? `swarm-${now.toString(36)}`,
		sessionId: options.sessionId,
		title: options.title ?? "Swarm",
		cwd: options.cwd,
		createdAt: now,
		active: true,
		channels: {
			[MAIN_CHANNEL]: {
				name: MAIN_CHANNEL,
				topic: "Default swarm channel visible to all members",
				createdBy: "coordinator",
				createdAt: now,
				archived: false,
			},
		},
		members: {},
		coordinator: {
			state: "working",
			wakeMode: "mentions",
			waitSince: 0,
			lastReadSeq: 0,
		},
	};
}

/** Persistent file-backed swarm message board, channel registry, member state, and plan store. */
export class SwarmBoard {
	readonly swarmDir: string;
	readonly statePath: string;
	readonly boardPath: string;
	readonly planPath: string;

	private state: SwarmState;
	private messages: BoardMessage[];
	private plan: SwarmPlan;

	private constructor(swarmDir: string, state: SwarmState, messages: BoardMessage[], plan: SwarmPlan) {
		this.swarmDir = swarmDir;
		this.statePath = join(swarmDir, "state.json");
		this.boardPath = join(swarmDir, "board.jsonl");
		this.planPath = join(swarmDir, "plan.json");
		this.state = state;
		this.messages = messages;
		this.plan = plan;
		this.ensureMainChannel();
	}

	/** Loads an existing swarm board from disk, or returns undefined if `state.json` does not exist. */
	static load(swarmDir: string): SwarmBoard | undefined {
		const statePath = join(swarmDir, "state.json");
		if (!existsSync(statePath)) {
			return undefined;
		}
		const state = JSON.parse(readFileSync(statePath, "utf-8")) as SwarmState;
		const boardPath = join(swarmDir, "board.jsonl");
		const { messages, hadTrailingPartial } = readBoardJsonl(boardPath);
		if (hadTrailingPartial) {
			const cleanContent = messages.map((m) => JSON.stringify(m)).join("\n");
			const tmpPath = `${boardPath}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 10)}`;
			writeFileSync(tmpPath, cleanContent.length > 0 ? `${cleanContent}\n` : "", "utf-8");
			renameSync(tmpPath, boardPath);
		}
		const planPath = join(swarmDir, "plan.json");
		const plan = existsSync(planPath)
			? (JSON.parse(readFileSync(planPath, "utf-8")) as SwarmPlan)
			: createDefaultPlan();
		return new SwarmBoard(swarmDir, state, messages, plan);
	}

	/** Opens an existing swarm board on disk or initializes a new one atomically. */
	static openOrCreate(options: CreateBoardOptions): SwarmBoard {
		const existing = SwarmBoard.load(options.swarmDir);
		if (existing) {
			return existing;
		}
		mkdirSync(options.swarmDir, { recursive: true });
		const state = createInitialState(options);
		const plan = createDefaultPlan();
		const board = new SwarmBoard(options.swarmDir, state, [], plan);
		board.saveState();
		return board;
	}

	private ensureMainChannel(): void {
		if (!this.state.channels[MAIN_CHANNEL]) {
			this.state.channels[MAIN_CHANNEL] = {
				name: MAIN_CHANNEL,
				topic: "Default swarm channel visible to all members",
				createdBy: "coordinator",
				createdAt: this.state.createdAt,
				archived: false,
			};
		}
	}

	/** Returns the highest message sequence number on the board (0 when empty). */
	get head(): number {
		return this.messages.length > 0 ? this.messages[this.messages.length - 1].seq : 0;
	}

	/** Returns the current mutable-safe snapshot of SwarmState. */
	getState(): SwarmState {
		return this.state;
	}

	/** Persists state.json atomically via a temporary file rename. */
	saveState(): void {
		writeJsonAtomic(this.statePath, this.state);
	}

	/** Returns the current swarm plan. */
	getPlan(): SwarmPlan {
		return this.plan;
	}

	/** Updates and atomically persists plan.json. */
	setPlan(plan: SwarmPlan): SwarmPlan {
		this.plan = plan;
		writeJsonAtomic(this.planPath, this.plan);
		return this.plan;
	}

	/** Updates the swarm title and persists state.json. */
	setTitle(title: string): void {
		this.state.title = title;
		this.saveState();
	}

	/** Marks the swarm active/inactive and persists state.json. */
	setActive(active: boolean): void {
		this.state.active = active;
		this.saveState();
	}

	/** Registers or updates a member record and persists state.json. */
	upsertMember(member: MemberRecord): void {
		this.state.members[member.name] = member;
		this.saveState();
	}

	/** Returns a member record by name, or undefined if absent. */
	getMember(name: string): MemberRecord | undefined {
		return this.state.members[name];
	}

	/** Returns all registered member records. */
	listMembers(): MemberRecord[] {
		return Object.values(this.state.members);
	}

	/** Creates a new board channel. Throws on invalid name or duplicate. */
	createChannel(name: string, createdBy: string, topic = ""): ChannelRecord {
		const check = validateChannelName(name);
		if (!check.ok) {
			throw new Error(check.error);
		}
		if (this.state.channels[name]) {
			throw new Error(`Channel "#${name}" already exists.`);
		}
		const record: ChannelRecord = {
			name,
			topic,
			createdBy,
			createdAt: Date.now(),
			archived: false,
		};
		this.state.channels[name] = record;
		this.saveState();
		return record;
	}

	/** Lists channels (`main` first), optionally filtering out archived channels. */
	listChannels(includeArchived = true): ChannelRecord[] {
		const all = Object.values(this.state.channels).filter((ch) => includeArchived || !ch.archived);
		return all.sort((a, b) => {
			if (a.name === MAIN_CHANNEL) return -1;
			if (b.name === MAIN_CHANNEL) return 1;
			return a.createdAt - b.createdAt || a.name.localeCompare(b.name);
		});
	}

	/** Subscribes a worker to a channel. Rejects unknown, archived, or killed targets. */
	subscribeChannel(memberName: string, channelName: string): string[] {
		const channel = this.state.channels[channelName];
		if (!channel) {
			throw new Error(`Channel "#${channelName}" does not exist.`);
		}
		if (channel.archived) {
			throw new Error(`Channel "#${channelName}" is archived.`);
		}
		if (memberName === "coordinator") {
			return this.listChannels().map((c) => c.name);
		}
		const member = this.state.members[memberName];
		if (!member) {
			throw new Error(`Member "${memberName}" does not exist.`);
		}
		if (member.state === "killed") {
			throw new Error(`Member "${memberName}" has been killed.`);
		}
		if (channelName !== MAIN_CHANNEL && !member.channels.includes(channelName)) {
			member.channels = [...member.channels, channelName];
			this.saveState();
		}
		return member.channels;
	}

	/** Unsubscribes a worker from a channel. Rejects `#main` and unknown/killed members. */
	unsubscribeChannel(memberName: string, channelName: string): string[] {
		if (channelName === MAIN_CHANNEL) {
			throw new Error(`Cannot unsubscribe from #${MAIN_CHANNEL}; all members have access to #${MAIN_CHANNEL}.`);
		}
		if (!this.state.channels[channelName]) {
			throw new Error(`Channel "#${channelName}" does not exist.`);
		}
		if (memberName === "coordinator") {
			throw new Error("Coordinator sees all channels and cannot unsubscribe.");
		}
		const member = this.state.members[memberName];
		if (!member) {
			throw new Error(`Member "${memberName}" does not exist.`);
		}
		if (member.state === "killed") {
			throw new Error(`Member "${memberName}" has been killed.`);
		}
		const next = member.channels.filter((ch) => ch !== channelName);
		if (next.length !== member.channels.length) {
			member.channels = next;
			this.saveState();
		}
		return member.channels;
	}

	/** Archives a channel (history remains readable, new posts are rejected). Rejects `#main`. */
	archiveChannel(channelName: string): ChannelRecord {
		if (channelName === MAIN_CHANNEL) {
			throw new Error(`Cannot archive #${MAIN_CHANNEL}.`);
		}
		const channel = this.state.channels[channelName];
		if (!channel) {
			throw new Error(`Channel "#${channelName}" does not exist.`);
		}
		if (!channel.archived) {
			channel.archived = true;
			channel.archivedAt = Date.now();
			this.saveState();
		}
		return channel;
	}

	/** Checks whether a viewer can see messages posted to `channelName`. */
	canViewChannel(viewer: string, channelName: string): boolean {
		if (viewer === "coordinator" || isMonitorName(viewer)) {
			return true;
		}
		if (channelName === MAIN_CHANNEL) {
			return true;
		}
		const member = this.state.members[viewer];
		if (!member) {
			return false;
		}
		return member.channels.includes(channelName);
	}

	/** Appends a new message to `board.jsonl`, parses mentions, and updates author post metadata. */
	postMessage(input: PostMessageInput): BoardMessage {
		const channelName = input.channel ?? MAIN_CHANNEL;
		const channel = this.state.channels[channelName];
		if (!channel) {
			throw new Error(`Channel "#${channelName}" does not exist.`);
		}
		if (channel.archived) {
			throw new Error(`Channel "#${channelName}" is archived and cannot accept new posts.`);
		}

		const knownMembers = new Set<string>(["coordinator", ...Object.keys(this.state.members)]);
		const knownGroups = new Set<string>();
		for (const member of Object.values(this.state.members)) {
			if (member.group) {
				knownGroups.add(member.group);
			}
		}

		const mentions = parseMentions(input.text, knownMembers, knownGroups);
		if (mentions.channels.includes(MAIN_CHANNEL)) {
			throw new Error(`Cannot mention @#${MAIN_CHANNEL}; all members already see #${MAIN_CHANNEL}.`);
		}
		mentions.channels = mentions.channels.filter((ch) => {
			const target = this.state.channels[ch];
			return target !== undefined && !target.archived;
		});

		const msg: BoardMessage = {
			seq: this.head + 1,
			timestamp: Date.now(),
			author: input.author,
			channel: channelName,
			text: input.text,
			mentions,
		};

		mkdirSync(this.swarmDir, { recursive: true });
		appendFileSync(this.boardPath, `${JSON.stringify(msg)}\n`, "utf-8");
		this.messages.push(msg);

		if (input.author === "coordinator") {
			this.state.coordinator.lastPostSeq = msg.seq;
			this.state.coordinator.lastPostTime = msg.timestamp;
			this.saveState();
		} else if (this.state.members[input.author]) {
			this.state.members[input.author].lastPostSeq = msg.seq;
			this.state.members[input.author].lastPostTime = msg.timestamp;
			this.saveState();
		}

		return msg;
	}

	/** Reads messages visible to `viewer`, advancing their `lastReadSeq` cursor. */
	readBoard(options: ReadBoardOptions): ReadBoardResult {
		const limit = options.limit ?? 20;
		const channelFilter = options.channel;

		const visible = this.messages.filter((msg) => {
			if (!this.canViewChannel(options.viewer, msg.channel)) {
				return false;
			}
			if (channelFilter !== undefined && channelFilter !== "*" && msg.channel !== channelFilter) {
				return false;
			}
			return true;
		});

		let selected: BoardMessage[];
		if (options.since !== undefined) {
			const after = visible.filter((msg) => msg.seq > options.since!);
			selected = limit > 0 ? after.slice(0, limit) : [];
		} else {
			selected = limit > 0 ? visible.slice(-limit) : [];
		}

		const isFullView = channelFilter === undefined || channelFilter === "*";
		if (isFullView) {
			this.advanceReadCursor(options.viewer, selected, visible, options.since);
		}

		return {
			messages: selected,
			head: this.head,
		};
	}

	private advanceReadCursor(
		viewer: string,
		selected: BoardMessage[],
		allVisible: BoardMessage[],
		since: number | undefined,
	): void {
		let nextReadSeq: number | undefined;
		if (selected.length > 0) {
			const lastDeliveredSeq = selected[selected.length - 1].seq;
			const hasMoreVisibleAfter =
				since !== undefined && allVisible.some((msg) => msg.seq > lastDeliveredSeq);
			nextReadSeq = hasMoreVisibleAfter ? lastDeliveredSeq : Math.max(lastDeliveredSeq, this.head);
		} else if (since !== undefined && !allVisible.some((msg) => msg.seq > since)) {
			nextReadSeq = this.head;
		} else if (since === undefined && allVisible.length === 0) {
			nextReadSeq = this.head;
		}

		if (nextReadSeq === undefined) {
			return;
		}

		if (viewer === "coordinator") {
			if (nextReadSeq > this.state.coordinator.lastReadSeq) {
				this.state.coordinator.lastReadSeq = nextReadSeq;
				this.saveState();
			}
			return;
		}

		const member = this.state.members[viewer];
		if (member && nextReadSeq > member.lastReadSeq) {
			member.lastReadSeq = nextReadSeq;
			this.saveState();
		}
	}

	/** Returns all messages matching a sequence number list (without mutating cursors). */
	getMessagesBySeqs(seqs: number[], viewer: string): BoardMessage[] {
		const seqSet = new Set(seqs);
		return this.messages.filter((msg) => seqSet.has(msg.seq) && this.canViewChannel(viewer, msg.channel));
	}

	/** Returns messages matching `since` for a viewer without advancing their `lastReadSeq`. */
	peekUnread(viewer: string, since: number): BoardMessage[] {
		return this.messages.filter((msg) => msg.seq > since && this.canViewChannel(viewer, msg.channel));
	}

	/** Returns a detailed status snapshot of channels, coordinator, and members (`read_board{status: true}`). */
	getDetailedStatus(): SwarmDetailedStatus {
		const members = this.listMembers().map((member) => {
			const unreadCount = this.messages.filter(
				(msg) => msg.seq > member.lastReadSeq && this.canViewChannel(member.name, msg.channel),
			).length;
			return {
				name: member.name,
				group: member.group,
				addedBy: member.addedBy,
				state: member.state,
				model: member.model,
				workspaceMode: member.workspaceMode,
				workspacePath: member.workspacePath,
				workspaceBranch: member.workspaceBranch,
				channels: [...member.channels],
				wakeMode: member.wakeMode,
				waitSince: member.waitSince,
				lastReadSeq: member.lastReadSeq,
				unreadCount,
				lastPostSeq: member.lastPostSeq,
				lastPostTime: member.lastPostTime,
				currentActivity: member.currentActivity,
				lastError: member.lastError,
				usage: { ...member.usage },
			};
		});

		return {
			head: this.head,
			swarmId: this.state.swarmId,
			sessionId: this.state.sessionId,
			title: this.state.title,
			active: this.state.active,
			channels: this.listChannels(true),
			coordinator: { ...this.state.coordinator },
			members,
		};
	}
}

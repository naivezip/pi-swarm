import { appendFileSync, existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	doesMessageWakeCoordinator,
	doesMessageWakeMember,
	getDefaultSwarmsRoot,
	getSwarmDir,
	parseMentions,
	SwarmBoard,
} from "../src/board.ts";
import {
	createDefaultPlan,
	createEmptyUsage,
	isMonitorName,
	MAIN_CHANNEL,
	type MemberRecord,
	validateChannelName,
	validateWorkerName,
} from "../src/types.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function makeMember(overrides: Partial<MemberRecord> & { name: string }): MemberRecord {
	return {
		addedBy: "coordinator",
		state: "waiting",
		workspaceMode: "inherit",
		workspacePath: "/tmp/ws",
		channels: [],
		wakeMode: "mentions",
		waitSince: 0,
		lastReadSeq: 0,
		sessionFile: "/tmp/session.jsonl",
		usage: createEmptyUsage(),
		createdAt: Date.now(),
		...overrides,
	};
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("types validation helpers", () => {
	it("validates worker names and reserved names", () => {
		expect(validateWorkerName("alice").ok).toBe(true);
		expect(validateWorkerName("worker-1").ok).toBe(true);
		expect(validateWorkerName("a_b_01").ok).toBe(true);
		expect(validateWorkerName("123456789012345678901234").ok).toBe(true);

		expect(validateWorkerName("").ok).toBe(false);
		expect(validateWorkerName("Alice").ok).toBe(false);
		expect(validateWorkerName("-alice").ok).toBe(false);
		expect(validateWorkerName("1234567890123456789012345").ok).toBe(false);
		expect(validateWorkerName("all").ok).toBe(false);
		expect(validateWorkerName("coordinator").ok).toBe(false);
		expect(validateWorkerName("coordinator-1").ok).toBe(false);
		expect(validateWorkerName("coordinator-helper").ok).toBe(false);
	});

	it("identifies monitor names and validates channel names", () => {
		expect(isMonitorName("monitor")).toBe(true);
		expect(isMonitorName("monitor-1")).toBe(true);
		expect(isMonitorName("monitor-12")).toBe(true);
		expect(isMonitorName("monitor-a")).toBe(false);
		expect(isMonitorName("my-monitor")).toBe(false);

		expect(validateChannelName("main").ok).toBe(true);
		expect(validateChannelName("backend-api_v2").ok).toBe(true);
		expect(validateChannelName("*").ok).toBe(false);
		expect(validateChannelName("Backend").ok).toBe(false);
	});

	it("computes default swarms root and session directory", () => {
		const root = getDefaultSwarmsRoot("/tmp/pi-agent");
		expect(root).toBe(join("/tmp/pi-agent", "swarms"));
		expect(getSwarmDir("sess:1/2", root)).toBe(join(root, "sess_1_2"));
	});
});

describe("mention parsing", () => {
	it("parses @name, @group, @all, and @#channel", () => {
		const parsed = parseMentions(
			"Hey @alice and @worker, check @#backend and @all please.",
			["alice", "worker-1", "worker-2", "coordinator"],
			["worker"],
		);
		expect(parsed).toEqual({
			members: ["alice"],
			groups: ["worker"],
			channels: ["backend"],
			all: true,
		});
	});

	it("ignores mentions inside fenced code blocks, inline backticks, and emails", () => {
		const text = [
			"Contact user@example.com or check `@all` and `@#main` and `@alice`.",
			"```ts",
			"// @bob @all @#main",
			"```",
			"~~~",
			"@carol",
			"~~~",
			"```",
			"```",
			"Real ping for @dave.",
		].join("\n");

		const parsed = parseMentions(text, ["alice", "bob", "carol", "dave"]);
		expect(parsed).toEqual({
			members: ["dave"],
			groups: [],
			channels: [],
			all: false,
		});
	});
});

describe("SwarmBoard persistence and channels", () => {
	it("initializes with #main, persists state/board/plan, and recovers from partial trailing JSONL", () => {
		const root = makeTempDir("pi-swarm-board-");
		const swarmDir = getSwarmDir("sess-1", root);
		const board = SwarmBoard.openOrCreate({
			swarmDir,
			sessionId: "sess-1",
			cwd: root,
			title: "Test Swarm",
		});

		expect(board.listChannels().map((c) => c.name)).toEqual([MAIN_CHANNEL]);
		const alice = makeMember({ name: "alice" });
		board.upsertMember(alice);

		const m1 = board.postMessage({ author: "coordinator", text: "@alice start" });
		expect(m1.seq).toBe(1);

		const plan = createDefaultPlan();
		plan.goal = { title: "Ship feature", line: "Build and verify pi-swarm" };
		plan.tasks = { alice: "Core board" };
		board.setPlan(plan);

		// Simulate a crash mid-append on board.jsonl.
		appendFileSync(board.boardPath, '{"seq":2,"author":"alice"', "utf-8");

		const reloaded = SwarmBoard.load(swarmDir);
		expect(reloaded).toBeDefined();
		expect(reloaded!.head).toBe(1);
		expect(reloaded!.getState().title).toBe("Test Swarm");
		expect(reloaded!.getPlan().goal.title).toBe("Ship feature");

		const m2 = reloaded!.postMessage({ author: "alice", text: "@coordinator done" });
		expect(m2.seq).toBe(2);
		expect(existsSync(reloaded!.statePath)).toBe(true);
	});

	it("manages channels, visibility, archiving, and @#main refusal", () => {
		const swarmDir = makeTempDir("pi-swarm-chan-");
		const board = SwarmBoard.openOrCreate({ swarmDir, sessionId: "s1", cwd: swarmDir });

		board.upsertMember(makeMember({ name: "alice", channels: [] }));
		board.upsertMember(makeMember({ name: "bob", channels: [] }));
		board.upsertMember(makeMember({ name: "monitor-1", channels: [] }));

		board.createChannel("backend", "coordinator", "Backend work");
		board.subscribeChannel("alice", "backend");

		expect(() => board.unsubscribeChannel("alice", MAIN_CHANNEL)).toThrow(/#main/);
		expect(() => board.archiveChannel(MAIN_CHANNEL)).toThrow(/#main/);
		expect(() => board.postMessage({ author: "coordinator", text: "ping @#main" })).toThrow(/@#main/);

		const p1 = board.postMessage({ author: "coordinator", text: "on main" });
		const p2 = board.postMessage({ author: "alice", channel: "backend", text: "secret backend update" });
		expect(p1.seq).toBe(1);
		expect(p2.seq).toBe(2);

		// Bob is not subscribed to #backend, so he only sees #main.
		const bobRead = board.readBoard({ viewer: "bob" });
		expect(bobRead.messages.map((m) => m.seq)).toEqual([1]);

		// Alice sees both #main and #backend.
		const aliceRead = board.readBoard({ viewer: "alice", channel: "*" });
		expect(aliceRead.messages.map((m) => m.seq)).toEqual([1, 2]);

		// Monitor and coordinator see all channels.
		expect(board.readBoard({ viewer: "monitor-1" }).messages.map((m) => m.seq)).toEqual([1, 2]);
		expect(board.readBoard({ viewer: "coordinator" }).messages.map((m) => m.seq)).toEqual([1, 2]);

		// Archiving rejects new posts while history remains readable.
		board.archiveChannel("backend");
		expect(() => board.postMessage({ author: "alice", channel: "backend", text: "after archive" })).toThrow(
			/archived/,
		);
		expect(board.readBoard({ viewer: "alice", channel: "backend" }).messages.map((m) => m.seq)).toEqual([2]);
	});

	it("handles since/limit pagination and detailed status unread counts", () => {
		const swarmDir = makeTempDir("pi-swarm-read-");
		const board = SwarmBoard.openOrCreate({ swarmDir, sessionId: "s2", cwd: swarmDir });
		board.upsertMember(makeMember({ name: "alice", lastReadSeq: 0 }));

		for (let i = 1; i <= 5; i++) {
			board.postMessage({ author: "coordinator", text: `msg ${i}` });
		}

		const statusBefore = board.getDetailedStatus();
		expect(statusBefore.head).toBe(5);
		expect(statusBefore.members[0].unreadCount).toBe(5);

		const page1 = board.readBoard({ viewer: "alice", since: 1, limit: 2 });
		expect(page1.messages.map((m) => m.seq)).toEqual([2, 3]);
		expect(board.getMember("alice")!.lastReadSeq).toBe(3);

		const page2 = board.readBoard({ viewer: "alice", since: 3, limit: 10 });
		expect(page2.messages.map((m) => m.seq)).toEqual([4, 5]);
		expect(board.getMember("alice")!.lastReadSeq).toBe(5);
		expect(board.getDetailedStatus().members[0].unreadCount).toBe(0);
	});

	it("does not advance global lastReadSeq on single-channel reads", () => {
		const swarmDir = makeTempDir("pi-swarm-chan-cursor-");
		const board = SwarmBoard.openOrCreate({ swarmDir, sessionId: "s2b", cwd: swarmDir });
		board.createChannel("backend", "coordinator");
		board.upsertMember(makeMember({ name: "alice", channels: ["backend"], lastReadSeq: 0 }));

		board.postMessage({ author: "coordinator", channel: "backend", text: "backend 1" }); // #1
		board.postMessage({ author: "coordinator", channel: "main", text: "main 2" }); // #2

		const backendOnly = board.readBoard({ viewer: "alice", channel: "backend", since: 0 });
		expect(backendOnly.messages.map((m) => m.seq)).toEqual([1]);
		expect(board.getMember("alice")!.lastReadSeq).toBe(0);

		const allVisible = board.readBoard({ viewer: "alice", channel: "*", since: 0 });
		expect(allVisible.messages.map((m) => m.seq)).toEqual([1, 2]);
		expect(board.getMember("alice")!.lastReadSeq).toBe(2);
	});
});

describe("wake matching rules", () => {
	it("matches direct, group, @all, @#channel, wakeMode, and never self-wakes or wakes killed", () => {
		const swarmDir = makeTempDir("pi-swarm-wake-");
		const board = SwarmBoard.openOrCreate({ swarmDir, sessionId: "s3", cwd: swarmDir });
		board.createChannel("backend", "coordinator");
		board.createChannel("frontend", "coordinator");

		const w1 = makeMember({ name: "worker-1", group: "worker", channels: ["backend"], wakeMode: "mentions" });
		const w2 = makeMember({ name: "worker-2", group: "worker", channels: ["frontend"], wakeMode: "anything" });
		const killed = makeMember({ name: "old", state: "killed", channels: ["backend"], wakeMode: "anything" });
		const mon = makeMember({ name: "monitor-1", channels: [], wakeMode: "mentions" });
		board.upsertMember(w1);
		board.upsertMember(w2);
		board.upsertMember(killed);
		board.upsertMember(mon);

		const allMembers = board.getState().members;

		// Cross-channel @group mention wakes w1 and w2, not killed, not mon
		const groupMsg = board.postMessage({ author: "coordinator", channel: "frontend", text: "@worker sync up" });
		expect(doesMessageWakeMember(groupMsg, w1, allMembers)).toBe(true);
		expect(doesMessageWakeMember(groupMsg, w2, allMembers)).toBe(true);
		expect(doesMessageWakeMember(groupMsg, killed, allMembers)).toBe(false);
		expect(doesMessageWakeMember(groupMsg, mon, allMembers)).toBe(false);

		// Never self-wakes author
		const selfMsg = board.postMessage({ author: "worker-1", text: "@worker-1 @all note" });
		expect(doesMessageWakeMember(selfMsg, w1, allMembers)).toBe(false);
		expect(doesMessageWakeMember(selfMsg, w2, allMembers)).toBe(true);
		expect(doesMessageWakeMember(selfMsg, mon, allMembers)).toBe(true);
		expect(doesMessageWakeMember(selfMsg, killed, allMembers)).toBe(false);

		// @#channel wakes subscribers + coordinator + monitor
		const chanPing = board.postMessage({ author: "worker-2", channel: "main", text: "heads up @#backend" });
		expect(doesMessageWakeMember(chanPing, w1, allMembers)).toBe(true);
		expect(doesMessageWakeMember(chanPing, w2, allMembers)).toBe(false);
		expect(doesMessageWakeMember(chanPing, mon, allMembers)).toBe(true);
		expect(doesMessageWakeCoordinator(chanPing, board.getState().coordinator)).toBe(true);

		// Unmentioned post in #frontend wakes w2 (wakeMode: anything) but not w1 or coordinator (mentions)
		const frontendChat = board.postMessage({ author: "worker-1", channel: "frontend", text: "fyi" });
		expect(doesMessageWakeMember(frontendChat, w1, allMembers)).toBe(false);
		expect(doesMessageWakeMember(frontendChat, w2, allMembers)).toBe(true);
		expect(doesMessageWakeCoordinator(frontendChat, board.getState().coordinator)).toBe(false);

		// Unknown or archived @#channel mentions wake nobody (even monitor or coordinator)
		board.archiveChannel("backend");
		const staleChanPing = board.postMessage({
			author: "worker-2",
			channel: "main",
			text: "ping @#backend and @#nonexistent",
		});
		expect(staleChanPing.mentions.channels).toEqual([]);
		expect(doesMessageWakeMember(staleChanPing, w1, allMembers, board.getState().channels)).toBe(false);
		expect(doesMessageWakeMember(staleChanPing, mon, allMembers, board.getState().channels)).toBe(false);
		expect(doesMessageWakeCoordinator(staleChanPing, board.getState().coordinator, board.getState().channels)).toBe(
			false,
		);
	});
});

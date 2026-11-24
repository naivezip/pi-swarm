import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { BackgroundProcessManager } from "../src/process-manager.ts";
import type { BackgroundProcessEvent } from "../src/types.ts";

const NODE_BIN = process.execPath.replace(/\\/g, "/");

function isPidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function waitForCondition(predicate: () => boolean, timeoutMs = 5000, intervalMs = 20): Promise<void> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (predicate()) {
			return;
		}
		await new Promise((r) => setTimeout(r, intervalMs));
	}
	throw new Error(`Timed out after ${timeoutMs}ms waiting for condition.`);
}

describe("BackgroundProcessManager", () => {
	const tempDirs: string[] = [];
	const managers: BackgroundProcessManager[] = [];

	function makeTempDir(prefix = "pi-swarm-proc-test-"): string {
		const dir = mkdtempSync(join(tmpdir(), prefix));
		tempDirs.push(dir);
		return dir;
	}

	function createManager(
		options: ConstructorParameters<typeof BackgroundProcessManager>[0] = {},
	): BackgroundProcessManager {
		const mgr = new BackgroundProcessManager(options);
		managers.push(mgr);
		return mgr;
	}

	afterEach(() => {
		while (managers.length > 0) {
			managers.pop()!.dispose();
		}
		while (tempDirs.length > 0) {
			rmSync(tempDirs.pop()!, { recursive: true, force: true });
		}
	});

	it("returns synchronously when a command exits within waitMs and does not emit process_exit", async () => {
		const dir = makeTempDir();
		const events: BackgroundProcessEvent[] = [];
		const manager = createManager({
			tempDir: dir,
			onEvent: (ev) => {
				events.push(ev);
			},
		});

		const res = await manager.runCommand({
			ownerWorker: "verifier",
			cwd: dir,
			waitMs: 5000,
			command: `"${NODE_BIN}" -e "console.log('hello-out'); console.error('hello-err');"`,
		});

		expect(res.status).toBe("exited");
		if (res.status !== "exited") throw new Error("unreachable");
		expect(res.exitCode).toBe(0);
		expect(res.outputTail).toContain("hello-out");
		expect(res.outputTail).toContain("hello-err");
		expect(res.truncated).toBe(false);
		expect(res.fullOutputPath).toBeUndefined();
		expect(res.elapsedMs).toBeGreaterThanOrEqual(0);
		expect(events).toEqual([]);
		expect(manager.list("verifier")).toEqual([]);
		expect(manager.list("verifier", { includeEnded: true })).toHaveLength(1);
	});

	it("returns non-zero exit codes synchronously", async () => {
		const dir = makeTempDir();
		const manager = createManager({ tempDir: dir });

		const res = await manager.runCommand({
			ownerWorker: "author",
			cwd: dir,
			waitMs: 5000,
			command: `"${NODE_BIN}" -e "console.error('boom'); process.exit(42);"`,
		});

		expect(res.status).toBe("exited");
		if (res.status !== "exited") throw new Error("unreachable");
		expect(res.exitCode).toBe(42);
		expect(res.outputTail).toContain("boom");
	});

	it("promotes slow commands to background without killing and emits process_exit on natural exit", async () => {
		const dir = makeTempDir();
		const events: BackgroundProcessEvent[] = [];
		const manager = createManager({
			tempDir: dir,
			onEvent: (ev) => {
				events.push(ev);
			},
		});

		const scriptPath = join(dir, "slow.mjs");
		writeFileSync(
			scriptPath,
			`console.log("phase-1");\nsetTimeout(() => { console.log("phase-2"); process.exit(0); }, 280);\n`,
		);

		const res = await manager.runCommand({
			ownerWorker: "verifier",
			cwd: dir,
			waitMs: 80,
			command: `"${NODE_BIN}" "${scriptPath.replace(/\\/g, "/")}"`,
		});

		expect(res.status).toBe("running");
		if (res.status !== "running") throw new Error("unreachable");
		expect(res.taskId).toBe("proc-1");
		expect(res.isDaemon).toBe(false);
		expect(res.pid).toBeGreaterThan(0);

		const active = manager.list("verifier");
		expect(active).toHaveLength(1);
		expect(active[0].state).toBe("running");

		await waitForCondition(() => events.length === 1, 5000);
		expect(events[0].kind).toBe("process_exit");
		expect(events[0].summary.taskId).toBe(res.taskId);
		expect(events[0].summary.state).toBe("exited");
		expect(events[0].summary.exitCode).toBe(0);
		expect(events[0].outputTail).toContain("phase-1");
		expect(events[0].outputTail).toContain("phase-2");

		expect(manager.list("verifier")).toEqual([]);
		const ended = manager.list("verifier", { includeEnded: true });
		expect(ended).toHaveLength(1);
		expect(ended[0].state).toBe("exited");
	});

	it("fires process_still_running reminder for non-daemon processes and never for isDaemon: true", async () => {
		const dir = makeTempDir();
		const events: BackgroundProcessEvent[] = [];
		const manager = createManager({
			tempDir: dir,
			onEvent: (ev) => {
				events.push(ev);
			},
		});

		const sleeperScript = join(dir, "sleep.mjs");
		writeFileSync(sleeperScript, `console.log("started"); setInterval(() => {}, 1000);\n`);
		const cmd = `"${NODE_BIN}" "${sleeperScript.replace(/\\/g, "/")}"`;

		const nonDaemon = await manager.runCommand({
			ownerWorker: "verifier",
			cwd: dir,
			waitMs: 50,
			isDaemon: false,
			notifyAfterSeconds: 0.15,
			command: cmd,
		});
		expect(nonDaemon.status).toBe("running");

		const daemon = await manager.runCommand({
			ownerWorker: "verifier",
			cwd: dir,
			waitMs: 50,
			isDaemon: true,
			notifyAfterSeconds: 0.1,
			command: cmd,
		});
		expect(daemon.status).toBe("running");
		if (daemon.status === "running") {
			expect(daemon.isDaemon).toBe(true);
		}

		await waitForCondition(() => events.some((e) => e.kind === "process_still_running"), 4000);
		// Wait a little extra to confirm daemon still does not emit reminder and non-daemon fires once.
		await new Promise((r) => setTimeout(r, 250));

		const reminders = events.filter((e) => e.kind === "process_still_running");
		expect(reminders).toHaveLength(1);
		expect(reminders[0].summary.taskId).toBe(nonDaemon.taskId);
		expect(reminders[0].summary.state).toBe("running");
		expect(reminders[0].summary.isDaemon).toBe(false);
	});

	it("tracks lastOutputAt separately from startedAt so silentMs resets on new output", async () => {
		const dir = makeTempDir();
		const manager = createManager({ tempDir: dir });

		const scriptPath = join(dir, "chatty.mjs");
		writeFileSync(
			scriptPath,
			`console.log("first");\nsetTimeout(() => { console.log("second"); }, 220);\nsetInterval(() => {}, 1000);\n`,
		);

		const res = await manager.runCommand({
			ownerWorker: "author",
			cwd: dir,
			waitMs: 50,
			isDaemon: true,
			command: `"${NODE_BIN}" "${scriptPath.replace(/\\/g, "/")}"`,
		});
		expect(res.status).toBe("running");

		await waitForCondition(() => {
			const detail = manager.getStatus("author", res.taskId);
			return detail.outputTail.includes("second");
		}, 4000);

		const rightAfterSecond = manager.getStatus("author", res.taskId);
		expect(rightAfterSecond.lastOutputAt).toBeGreaterThan(rightAfterSecond.startedAt);
		expect(rightAfterSecond.elapsedMs).toBeGreaterThanOrEqual(rightAfterSecond.silentMs);

		await new Promise((r) => setTimeout(r, 150));
		const later = manager.getStatus("author", res.taskId);
		expect(later.silentMs).toBeGreaterThanOrEqual(100);
		expect(later.elapsedMs).toBeGreaterThan(later.silentMs);
	});

	it("delivers stdin via sendInput to a running process and rejects sendInput after exit", async () => {
		const dir = makeTempDir();
		const events: BackgroundProcessEvent[] = [];
		const manager = createManager({
			tempDir: dir,
			onEvent: (ev) => {
				events.push(ev);
			},
		});

		const interactiveScript = join(dir, "interactive.mjs");
		writeFileSync(
			interactiveScript,
			`console.log("ready");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (chunk.includes("ping")) {
    console.log("pong");
    process.exit(0);
  }
});
`,
		);

		const res = await manager.runCommand({
			ownerWorker: "verifier",
			cwd: dir,
			waitMs: 80,
			isDaemon: true,
			command: `"${NODE_BIN}" "${interactiveScript.replace(/\\/g, "/")}"`,
		});
		expect(res.status).toBe("running");

		await waitForCondition(() => manager.getStatus("verifier", res.taskId).outputTail.includes("ready"), 3000);

		const sendRes = await manager.sendInput("verifier", res.taskId, "ping\n");
		expect(sendRes).toEqual({
			kind: "send_input",
			taskId: res.taskId,
			bytesWritten: 5,
		});

		await waitForCondition(() => events.some((e) => e.kind === "process_exit"), 4000);
		const exitEvent = events.find((e) => e.kind === "process_exit")!;
		expect(exitEvent.summary.exitCode).toBe(0);
		expect(exitEvent.outputTail).toContain("pong");

		await expect(manager.sendInput("verifier", res.taskId, "again\n")).rejects.toThrow(/already exited/i);
	});

	it("enforces strict ownerWorker isolation across list, getStatus, sendInput, and kill", async () => {
		const dir = makeTempDir();
		const manager = createManager({ tempDir: dir });

		const sleeperScript = join(dir, "hold.mjs");
		writeFileSync(sleeperScript, `setInterval(() => {}, 1000);\n`);

		const res = await manager.runCommand({
			ownerWorker: "author",
			cwd: dir,
			waitMs: 50,
			isDaemon: true,
			command: `"${NODE_BIN}" "${sleeperScript.replace(/\\/g, "/")}"`,
		});
		expect(res.status).toBe("running");

		expect(manager.list("verifier")).toEqual([]);
		expect(manager.list("verifier", { includeEnded: true })).toEqual([]);
		expect(manager.getActiveSummaries("verifier")).toEqual([]);
		expect(manager.getActiveSummaries("author")).toHaveLength(1);

		expect(() => manager.getStatus("verifier", res.taskId)).toThrow(/Permission denied/i);
		await expect(manager.sendInput("verifier", res.taskId, "hi\n")).rejects.toThrow(/Permission denied/i);
		await expect(manager.kill("verifier", res.taskId)).rejects.toThrow(/Permission denied/i);

		expect(manager.getStatus("author", res.taskId).state).toBe("running");
	});

	it("suppresses process_exit and cancels reminder timer on manual kill", async () => {
		const dir = makeTempDir();
		const events: BackgroundProcessEvent[] = [];
		const manager = createManager({
			tempDir: dir,
			onEvent: (ev) => {
				events.push(ev);
			},
		});

		const sleeperScript = join(dir, "wait-kill.mjs");
		writeFileSync(sleeperScript, `setInterval(() => {}, 1000);\n`);

		const res = await manager.runCommand({
			ownerWorker: "verifier",
			cwd: dir,
			waitMs: 50,
			isDaemon: false,
			notifyAfterSeconds: 0.2,
			command: `"${NODE_BIN}" "${sleeperScript.replace(/\\/g, "/")}"`,
		});
		expect(res.status).toBe("running");

		const killRes = await manager.kill("verifier", res.taskId);
		expect(killRes.kind).toBe("kill");
		if (killRes.kind === "kill") {
			expect(killRes.killed).toBe(true);
			expect(killRes.summary.state).toBe("killed");
		}

		const secondKill = await manager.kill("verifier", res.taskId);
		expect(secondKill.kind).toBe("kill");
		if (secondKill.kind === "kill") {
			expect(secondKill.killed).toBe(false);
		}

		await new Promise((r) => setTimeout(r, 320));
		expect(events).toEqual([]);
	});

	it("kills the entire process tree including nested child processes", async () => {
		const dir = makeTempDir();
		const manager = createManager({ tempDir: dir });

		const pidFile = join(dir, "nested.pid");
		const parentScript = join(dir, "parent.mjs");
		writeFileSync(
			parentScript,
			`import { spawn } from "node:child_process";
import { writeFileSync } from "node:fs";
const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
writeFileSync(${JSON.stringify(pidFile)}, String(child.pid));
console.log("nested:" + child.pid);
setInterval(() => {}, 1000);
`,
		);

		const res = await manager.runCommand({
			ownerWorker: "author",
			cwd: dir,
			waitMs: 50,
			isDaemon: true,
			command: `"${NODE_BIN}" "${parentScript.replace(/\\/g, "/")}"`,
		});
		expect(res.status).toBe("running");

		await waitForCondition(() => existsSync(pidFile) && readFileSync(pidFile, "utf8").trim().length > 0, 4000);
		const nestedPid = Number(readFileSync(pidFile, "utf8").trim());
		expect(nestedPid).toBeGreaterThan(0);
		expect(isPidAlive(nestedPid)).toBe(true);

		await manager.kill("author", res.taskId);

		await waitForCondition(() => !isPidAlive(nestedPid), 3000);
		expect(isPidAlive(nestedPid)).toBe(false);
		if (res.status === "running" && res.pid) {
			expect(isPidAlive(res.pid)).toBe(false);
		}
	});

	it("truncates large output to tail and spills full log to temp file", async () => {
		const dir = makeTempDir();
		const events: BackgroundProcessEvent[] = [];
		const manager = createManager({
			tempDir: dir,
			maxLines: 15,
			maxBytes: 400,
			onEvent: (ev) => {
				events.push(ev);
			},
		});

		// Sync overflow test
		const syncRes = await manager.runCommand({
			ownerWorker: "verifier",
			cwd: dir,
			waitMs: 5000,
			command: `"${NODE_BIN}" -e "for (let i = 1; i <= 50; i++) console.log('line-' + i);"`,
		});
		expect(syncRes.status).toBe("exited");
		if (syncRes.status !== "exited") throw new Error("unreachable");
		expect(syncRes.truncated).toBe(true);
		expect(syncRes.outputTail).toContain("line-50");
		expect(syncRes.outputTail).not.toContain("line-1\n");
		expect(syncRes.fullOutputPath).toBeTruthy();
		expect(existsSync(syncRes.fullOutputPath!)).toBe(true);
		const fullText = readFileSync(syncRes.fullOutputPath!, "utf8");
		expect(fullText).toContain("line-1\n");
		expect(fullText).toContain("line-50\n");

		// Async promoted overflow test
		const asyncScript = join(dir, "async-overflow.mjs");
		writeFileSync(
			asyncScript,
			`setTimeout(() => { for (let i = 1; i <= 40; i++) console.log('async-line-' + i); }, 120);\n`,
		);
		const asyncRes = await manager.runCommand({
			ownerWorker: "verifier",
			cwd: dir,
			waitMs: 40,
			command: `"${NODE_BIN}" "${asyncScript.replace(/\\/g, "/")}"`,
		});
		expect(asyncRes.status).toBe("running");

		await waitForCondition(() => events.some((e) => e.summary.taskId === asyncRes.taskId), 4000);
		const exitEv = events.find((e) => e.summary.taskId === asyncRes.taskId)!;
		expect(exitEv.kind).toBe("process_exit");
		expect(exitEv.truncated).toBe(true);
		expect(exitEv.outputTail).toContain("async-line-40");
		expect(exitEv.fullOutputPath).toBeTruthy();
		expect(readFileSync(exitEv.fullOutputPath!, "utf8")).toContain("async-line-1\n");
	});

	it("bounds retained ended-process history by maxEndedHistory", async () => {
		const dir = makeTempDir();
		const manager = createManager({ tempDir: dir, maxEndedHistory: 3 });

		for (let i = 1; i <= 5; i++) {
			const res = await manager.runCommand({
				ownerWorker: "author",
				cwd: dir,
				waitMs: 5000,
				command: `"${NODE_BIN}" -e "console.log(${i})"`,
			});
			expect(res.status).toBe("exited");
		}

		expect(manager.list("author")).toEqual([]);
		const ended = manager.list("author", { includeEnded: true });
		expect(ended.map((p) => p.taskId)).toEqual(["proc-3", "proc-4", "proc-5"]);
	});

	it("cleans up worker processes with killByOwner and kills all remaining trees on dispose", async () => {
		const dir = makeTempDir();
		const events: BackgroundProcessEvent[] = [];
		const manager = createManager({
			tempDir: dir,
			onEvent: (ev) => {
				events.push(ev);
			},
		});

		const sleeperScript = join(dir, "daemon.mjs");
		writeFileSync(sleeperScript, `setInterval(() => {}, 1000);\n`);
		const cmd = `"${NODE_BIN}" "${sleeperScript.replace(/\\/g, "/")}"`;

		const a1 = await manager.runCommand({ ownerWorker: "worker-a", cwd: dir, waitMs: 40, isDaemon: true, command: cmd });
		const a2 = await manager.runCommand({ ownerWorker: "worker-a", cwd: dir, waitMs: 40, isDaemon: true, command: cmd });
		const b1 = await manager.runCommand({ ownerWorker: "worker-b", cwd: dir, waitMs: 40, isDaemon: true, command: cmd });
		expect(a1.status).toBe("running");
		expect(a2.status).toBe("running");
		expect(b1.status).toBe("running");

		const killedA = await manager.killByOwner("worker-a");
		expect(killedA).toBe(2);
		expect(manager.getActiveSummaries("worker-a")).toEqual([]);
		expect(manager.getActiveSummaries("worker-b")).toHaveLength(1);

		const bPid = b1.status === "running" ? b1.pid : undefined;
		expect(bPid).toBeGreaterThan(0);

		manager.dispose();
		expect(manager.getActiveSummaries()).toEqual([]);
		if (bPid) {
			await waitForCondition(() => !isPidAlive(bPid), 3000);
			expect(isPidAlive(bPid)).toBe(false);
		}
		expect(events).toEqual([]);

		await expect(
			manager.runCommand({ ownerWorker: "worker-b", cwd: dir, waitMs: 50, command: `"${NODE_BIN}" -e "1"` }),
		).rejects.toThrow(/disposed/i);
	});

	it("does not spawn orphan processes when killByOwner or dispose runs while runCommand awaits cwd check", async () => {
		const dir = makeTempDir();
		const mgr1 = createManager({ tempDir: dir });
		const pendingOwner = mgr1.runCommand({
			ownerWorker: "w1",
			cwd: dir,
			waitMs: 50,
			isDaemon: true,
			command: `"${NODE_BIN}" -e "setInterval(() => {}, 1000)"`,
		});
		const killCountPromise = mgr1.killByOwner("w1");
		await expect(pendingOwner).rejects.toThrow(/cancelled/i);
		await killCountPromise;
		expect(mgr1.getActiveSummaries("w1")).toEqual([]);

		const mgr2 = createManager({ tempDir: dir });
		const pendingDispose = mgr2.runCommand({
			ownerWorker: "w1",
			cwd: dir,
			waitMs: 50,
			isDaemon: true,
			command: `"${NODE_BIN}" -e "setInterval(() => {}, 1000)"`,
		});
		mgr2.dispose();
		await expect(pendingDispose).rejects.toThrow(/cancelled|disposed/i);
		expect(mgr2.getActiveSummaries()).toEqual([]);
	});

	it("suppresses process_exit if child emits error after manual kill", async () => {
		const dir = makeTempDir();
		const events: BackgroundProcessEvent[] = [];
		const manager = createManager({
			tempDir: dir,
			onEvent: (ev) => {
				events.push(ev);
			},
		});

		const sleeperScript = join(dir, "sleeper-err.mjs");
		writeFileSync(sleeperScript, `setInterval(() => {}, 1000);\n`);
		const res = await manager.runCommand({
			ownerWorker: "w1",
			cwd: dir,
			waitMs: 40,
			command: `"${NODE_BIN}" "${sleeperScript.replace(/\\/g, "/")}"`,
		});
		expect(res.status).toBe("running");

		// Grab the internal entry's child before kill moves it to endedProcesses
		const internalMap = (manager as unknown as { activeProcesses: Map<string, { child: import("node:child_process").ChildProcess }> }).activeProcesses;
		const child = internalMap.get(res.taskId)!.child;

		const killPromise = manager.kill("w1", res.taskId);
		// Simulate child emitting an error event after killEntry sets state = "killed"
		child.emit("error", new Error("synthetic post-kill error"));
		await killPromise;

		await new Promise((r) => setTimeout(r, 80));
		expect(events).toEqual([]);
	});
});

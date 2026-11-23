import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getSwarmDir, SwarmBoard } from "../src/board.ts";
import { cleanStaleWorkspaces, removeWorkspace, setupWorkspace } from "../src/workspace.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
	const dir = mkdtempSync(join(tmpdir(), prefix));
	tempDirs.push(dir);
	return dir;
}

function initGitRepo(dir: string, withCommit = true): void {
	execFileSync("git", ["init"], { cwd: dir, windowsHide: true });
	execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir, windowsHide: true });
	execFileSync("git", ["config", "user.name", "Test User"], { cwd: dir, windowsHide: true });
	if (withCommit) {
		writeFileSync(join(dir, "README.md"), "# repo\n", "utf-8");
		execFileSync("git", ["add", "README.md"], { cwd: dir, windowsHide: true });
		execFileSync("git", ["commit", "-m", "initial"], { cwd: dir, windowsHide: true });
	}
}

afterEach(() => {
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop()!;
		rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	}
});

describe("workspace manager", () => {
	it("returns hostCwd for inherit mode even outside a git repository", async () => {
		const hostCwd = makeTempDir("pi-swarm-nogit-");
		const swarmDir = makeTempDir("pi-swarm-dir-");

		const res = await setupWorkspace({
			mode: "inherit",
			hostCwd,
			swarmDir,
			swarmId: "swarm-abc123",
			workerName: "alice",
		});

		expect(res).toEqual({
			mode: "inherit",
			workspacePath: hostCwd,
		});
	});

	it("rejects share and branch modes on non-git directories or empty repos", async () => {
		const nonGit = makeTempDir("pi-swarm-nongit-");
		const swarmDir = makeTempDir("pi-swarm-dir-");

		await expect(
			setupWorkspace({
				mode: "share",
				hostCwd: nonGit,
				swarmDir,
				swarmId: "swarm-1234",
				workerName: "alice",
			}),
		).rejects.toThrow(/not a git repo/i);

		const emptyGit = makeTempDir("pi-swarm-emptygit-");
		initGitRepo(emptyGit, false);

		await expect(
			setupWorkspace({
				mode: "branch",
				hostCwd: emptyGit,
				swarmDir,
				swarmId: "swarm-1234",
				workerName: "alice",
			}),
		).rejects.toThrow(/no commits/i);
	});

	it("creates and removes a share git worktree and reports dirtyWarning", async () => {
		const repo = makeTempDir("pi-swarm-repo-");
		const swarmDir = makeTempDir("pi-swarm-ws-");
		initGitRepo(repo, true);

		const cleanRes = await setupWorkspace({
			mode: "share",
			hostCwd: repo,
			swarmDir,
			swarmId: "swarm-abcd1234",
			workerName: "alice",
		});

		expect(cleanRes.mode).toBe("share");
		expect(cleanRes.workspaceBranch).toBe("swarm/abcd1234/alice");
		expect(cleanRes.dirtyWarning).toBeUndefined();
		expect(existsSync(join(cleanRes.workspacePath, "README.md"))).toBe(true);

		// Make repo dirty before creating bob's worktree
		writeFileSync(join(repo, "dirty.txt"), "uncommitted\n", "utf-8");
		const dirtyRes = await setupWorkspace({
			mode: "share",
			hostCwd: repo,
			swarmDir,
			swarmId: "swarm-abcd1234",
			workerName: "bob",
		});
		expect(dirtyRes.dirtyWarning).toMatch(/uncommitted changes/i);
		expect(existsSync(join(dirtyRes.workspacePath, "dirty.txt"))).toBe(false);

		// Removing share worktree deletes folder and prunes git worktree list
		await removeWorkspace("share", cleanRes.workspacePath, repo);
		expect(existsSync(cleanRes.workspacePath)).toBe(false);
		const worktreeList = execFileSync("git", ["worktree", "list"], {
			cwd: repo,
			encoding: "utf-8",
			windowsHide: true,
		});
		expect(worktreeList).not.toContain("alice");
		expect(worktreeList).toContain("bob");
	});

	it("creates and removes an isolated branch local clone", async () => {
		const repo = makeTempDir("pi-swarm-clone-repo-");
		const swarmDir = makeTempDir("pi-swarm-clone-ws-");
		initGitRepo(repo, true);

		const res = await setupWorkspace({
			mode: "branch",
			hostCwd: repo,
			swarmDir,
			swarmId: "swarm-xyz",
			workerName: "cloner",
		});

		expect(res.mode).toBe("branch");
		expect(existsSync(join(res.workspacePath, ".git"))).toBe(true);
		expect(existsSync(join(res.workspacePath, "README.md"))).toBe(true);

		await removeWorkspace("branch", res.workspacePath, repo);
		expect(existsSync(res.workspacePath)).toBe(false);
	});

	it("cleans stale workspaces across sessions while preserving the active session", async () => {
		const repo = makeTempDir("pi-swarm-clean-repo-");
		const swarmsRoot = makeTempDir("pi-swarm-root-");
		initGitRepo(repo, true);

		const staleDir = getSwarmDir("stale-session", swarmsRoot);
		const activeDir = getSwarmDir("active-session", swarmsRoot);
		SwarmBoard.openOrCreate({ swarmDir: staleDir, sessionId: "stale-session", cwd: repo });
		SwarmBoard.openOrCreate({ swarmDir: activeDir, sessionId: "active-session", cwd: repo });

		const staleWs = await setupWorkspace({
			mode: "share",
			hostCwd: repo,
			swarmDir: staleDir,
			swarmId: "swarm-stale1",
			workerName: "w1",
		});
		const activeWs = await setupWorkspace({
			mode: "share",
			hostCwd: repo,
			swarmDir: activeDir,
			swarmId: "swarm-active1",
			workerName: "w2",
		});

		// Add an unindexed stale workspace directory as well
		const orphanWs = join(swarmsRoot, "orphan-session", "workspaces", "ghost");
		mkdirSync(orphanWs, { recursive: true });
		writeFileSync(join(orphanWs, "tmp.txt"), "hi", "utf-8");

		const cleaned = await cleanStaleWorkspaces(swarmsRoot, "active-session");
		expect(cleaned.errors).toEqual([]);
		expect(cleaned.removedDirs).toContain(staleWs.workspacePath);
		expect(cleaned.removedDirs).toContain(orphanWs);
		expect(existsSync(staleWs.workspacePath)).toBe(false);
		expect(existsSync(orphanWs)).toBe(false);
		expect(existsSync(activeWs.workspacePath)).toBe(true);
	});
});

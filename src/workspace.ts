import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";
import { sanitizeSessionDirName } from "./board.ts";
import type { SwarmState, WorkspaceMode, WorkspaceSetupResult } from "./types.ts";

const execFileAsync = promisify(execFile);

export interface SetupWorkspaceOptions {
	mode: WorkspaceMode;
	hostCwd: string;
	swarmDir: string;
	swarmId: string;
	workerName: string;
}

export interface CleanWorkspacesResult {
	removedDirs: string[];
	prunedRepos: string[];
	errors: string[];
}

async function runGit(args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	const result = await execFileAsync("git", args, {
		cwd,
		windowsHide: true,
		encoding: "utf-8",
	});
	return { stdout: result.stdout.trim(), stderr: result.stderr.trim() };
}

async function resolveGitRoot(cwd: string, mode: WorkspaceMode): Promise<string> {
	try {
		const { stdout } = await runGit(["rev-parse", "--show-toplevel"], cwd);
		if (!stdout) {
			throw new Error("Empty git top-level path.");
		}
		return stdout;
	} catch (err) {
		const detail = err instanceof Error ? err.message : String(err);
		throw new Error(
			`Workspace mode "${mode}" requires a git repository, but "${cwd}" is not a git repo (${detail}).`,
		);
	}
}

async function getDirtyWarning(repoRoot: string): Promise<string | undefined> {
	const { stdout } = await runGit(["status", "--porcelain"], repoRoot);
	if (stdout.length === 0) {
		return undefined;
	}
	return "Host repository has uncommitted changes; worker workspace starts from committed HEAD.";
}

function makeShortId(swarmId: string): string {
	const cleaned = swarmId.replace(/[^a-zA-Z0-9_-]/g, "").replace(/^swarm-/, "");
	return (cleaned || "swarm").slice(0, 8);
}

/** Creates or resolves a worker's filesystem workspace for `inherit`, `share` (git worktree), or `branch` (local clone). */
export async function setupWorkspace(options: SetupWorkspaceOptions): Promise<WorkspaceSetupResult> {
	if (options.mode === "inherit") {
		return {
			mode: "inherit",
			workspacePath: options.hostCwd,
		};
	}

	const repoRoot = await resolveGitRoot(options.hostCwd, options.mode);

	try {
		await runGit(["rev-parse", "--verify", "HEAD"], repoRoot);
	} catch {
		throw new Error(
			`Cannot create "${options.mode}" workspace: git repository at "${repoRoot}" has no commits (HEAD is unborn).`,
		);
	}

	const workspacesRoot = join(options.swarmDir, "workspaces");
	mkdirSync(workspacesRoot, { recursive: true });
	const workspacePath = join(workspacesRoot, options.workerName);
	const dirtyWarning = await getDirtyWarning(repoRoot);

	if (options.mode === "share") {
		const branch = `swarm/${makeShortId(options.swarmId)}/${options.workerName}`;
		await runGit(["worktree", "add", "-b", branch, workspacePath, "HEAD"], repoRoot);
		return {
			mode: "share",
			workspacePath,
			workspaceBranch: branch,
			...(dirtyWarning ? { dirtyWarning } : {}),
		};
	}

	// mode === "branch": isolated local git clone
	await runGit(["clone", "--local", repoRoot, workspacePath], repoRoot);
	let workspaceBranch: string | undefined;
	try {
		const headInfo = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], workspacePath);
		if (headInfo.stdout && headInfo.stdout !== "HEAD") {
			workspaceBranch = headInfo.stdout;
		}
	} catch {
		// Detached HEAD clone has no branch name; omit workspaceBranch.
	}

	return {
		mode: "branch",
		workspacePath,
		...(workspaceBranch ? { workspaceBranch } : {}),
		...(dirtyWarning ? { dirtyWarning } : {}),
	};
}

/** Removes a worker's `share` worktree or `branch` clone directory. No-op for `inherit`. */
export async function removeWorkspace(
	mode: WorkspaceMode,
	workspacePath: string,
	hostCwd: string,
): Promise<void> {
	if (mode === "inherit") {
		return;
	}

	if (mode === "share") {
		let repoRoot: string | undefined;
		if (existsSync(hostCwd)) {
			try {
				repoRoot = (await runGit(["rev-parse", "--show-toplevel"], hostCwd)).stdout;
			} catch {
				repoRoot = undefined;
			}
		}

		if (repoRoot) {
			try {
				await runGit(["worktree", "remove", "--force", workspacePath], repoRoot);
			} catch {
				// Fall back to direct filesystem removal + worktree prune below.
			}
		}

		if (existsSync(workspacePath)) {
			rmSync(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
		}

		if (repoRoot) {
			try {
				await runGit(["worktree", "prune"], repoRoot);
			} catch {
				// Best-effort prune.
			}
		}
		return;
	}

	// mode === "branch"
	if (existsSync(workspacePath)) {
		rmSync(workspacePath, { recursive: true, force: true, maxRetries: 3, retryDelay: 50 });
	}
}

/** Cleans stale worker worktrees and clones under `swarmsRoot`, skipping `activeSessionId` if given. */
export async function cleanStaleWorkspaces(
	swarmsRoot: string,
	activeSessionId?: string,
): Promise<CleanWorkspacesResult> {
	const removedDirs: string[] = [];
	const prunedRepos: string[] = [];
	const errors: string[] = [];

	if (!existsSync(swarmsRoot)) {
		return { removedDirs, prunedRepos, errors };
	}

	const activeDirName = activeSessionId ? sanitizeSessionDirName(activeSessionId) : undefined;
	const entries = readdirSync(swarmsRoot, { withFileTypes: true });
	const reposToPrune = new Set<string>();

	for (const entry of entries) {
		if (!entry.isDirectory()) {
			continue;
		}
		if (activeDirName && entry.name === activeDirName) {
			continue;
		}

		const sessionDir = join(swarmsRoot, entry.name);
		const statePath = join(sessionDir, "state.json");
		let parsedState: SwarmState | undefined;
		if (existsSync(statePath)) {
			try {
				parsedState = JSON.parse(readFileSync(statePath, "utf-8")) as SwarmState;
			} catch (err) {
				errors.push(`Failed to read ${statePath}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		if (activeSessionId && parsedState?.sessionId === activeSessionId) {
			continue;
		}

		const workspacesDir = join(sessionDir, "workspaces");
		if (!existsSync(workspacesDir)) {
			continue;
		}

		const hostCwd = parsedState?.cwd ?? "";
		if (hostCwd && existsSync(hostCwd)) {
			reposToPrune.add(hostCwd);
		}

		const wsEntries = readdirSync(workspacesDir, { withFileTypes: true });
		for (const wsEntry of wsEntries) {
			if (!wsEntry.isDirectory()) {
				continue;
			}
			const wsPath = join(workspacesDir, wsEntry.name);
			const memberMode = parsedState?.members[wsEntry.name]?.workspaceMode ?? "share";
			try {
				await removeWorkspace(memberMode === "inherit" ? "branch" : memberMode, wsPath, hostCwd);
				removedDirs.push(wsPath);
			} catch (err) {
				errors.push(`Failed to remove ${wsPath}: ${err instanceof Error ? err.message : String(err)}`);
			}
		}

		try {
			const remaining = readdirSync(workspacesDir);
			if (remaining.length === 0) {
				rmSync(workspacesDir, { recursive: true, force: true });
			}
		} catch {
			// Ignore cleanup failure on empty wrapper dir.
		}
	}

	for (const repoCwd of reposToPrune) {
		try {
			await runGit(["worktree", "prune"], repoCwd);
			prunedRepos.push(repoCwd);
		} catch {
			// Ignore if repo is no longer valid.
		}
	}

	return { removedDirs, prunedRepos, errors };
}

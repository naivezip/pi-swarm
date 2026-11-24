import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { accessSync, constants, createWriteStream, mkdirSync, type WriteStream, writeFileSync } from "node:fs";
import { access as fsAccess } from "node:fs/promises";
import { constants as osConstants, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, getShellConfig, truncateTail } from "@earendil-works/pi-coding-agent";
import type {
	AsyncBashResult,
	BackgroundProcessDetail,
	BackgroundProcessEvent,
	BackgroundProcessState,
	BackgroundProcessSummary,
	ManageProcessResult,
} from "./types.ts";

const DEFAULT_WAIT_MS = 10_000;
const DEFAULT_MAX_WAIT_MS = 30_000;
const DEFAULT_NOTIFY_AFTER_SECONDS = 120;
const DEFAULT_MAX_ENDED_HISTORY = 50;
const EXIT_STDIO_GRACE_MS = 100;
const KILL_WAIT_TIMEOUT_MS = 3_000;
const MAX_TIMEOUT_MS = 0x7fff_ffff;
const COMMAND_PREVIEW_MAX_CHARS = 72;

interface ResolvedShellConfig {
	shell: string;
	args: string[];
	commandTransport?: "argv" | "stdin";
}

export interface BackgroundProcessManagerOptions {
	onEvent?: (event: BackgroundProcessEvent) => void | Promise<void>;
	now?: () => number;
	maxLines?: number;
	maxBytes?: number;
	maxEndedHistory?: number;
	defaultWaitMs?: number;
	maxWaitMs?: number;
	defaultNotifyAfterSeconds?: number;
	shellPath?: string;
	tempDir?: string;
}

export interface RunBackgroundCommandOptions {
	ownerWorker: string;
	command: string;
	cwd: string;
	waitMs?: number;
	isDaemon?: boolean;
	notifyAfterSeconds?: number;
	env?: NodeJS.ProcessEnv;
	isCancelled?: () => boolean;
}

export interface ListBackgroundProcessesOptions {
	includeEnded?: boolean;
}

function pathExists(filePath: string): boolean {
	try {
		accessSync(filePath, constants.F_OK);
		return true;
	} catch {
		return false;
	}
}

function findGitBashOnWindows(): string | undefined {
	if (process.platform !== "win32") {
		return undefined;
	}
	try {
		const res = spawnSync("where.exe", ["git"], {
			encoding: "utf-8",
			timeout: 5000,
			windowsHide: true,
		});
		if (res.status !== 0 || !res.stdout) {
			return undefined;
		}
		for (const line of res.stdout.trim().split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed) continue;
			// Typical layout: <GitRoot>\cmd\git.exe or <GitRoot>\bin\git.exe -> <GitRoot>\bin\bash.exe
			const gitRoot = dirname(dirname(trimmed));
			const candidates = [join(gitRoot, "bin", "bash.exe"), join(gitRoot, "usr", "bin", "bash.exe")];
			for (const candidate of candidates) {
				if (pathExists(candidate)) {
					return candidate;
				}
			}
		}
	} catch {
		// Ignore lookup errors and fall back to Pi's shell resolution.
	}
	return undefined;
}

function isWslLegacyBash(config: ResolvedShellConfig): boolean {
	if (process.platform !== "win32") {
		return false;
	}
	return (
		config.commandTransport === "stdin" ||
		/[\\/](?:system32|sysnative)[\\/]bash\.exe$/i.test(config.shell)
	);
}

function resolveShellConfig(customShellPath?: string): ResolvedShellConfig {
	if (customShellPath) {
		return getShellConfig(customShellPath);
	}
	try {
		const cfg = getShellConfig();
		if (isWslLegacyBash(cfg)) {
			const gitBash = findGitBashOnWindows();
			if (gitBash) {
				return { shell: gitBash, args: ["-c"] };
			}
		}
		return cfg;
	} catch (err) {
		const gitBash = findGitBashOnWindows();
		if (gitBash) {
			return { shell: gitBash, args: ["-c"] };
		}
		throw err;
	}
}

function getTaskkillPath(): string {
	return join(process.env.SystemRoot || "C:\\Windows", "System32", "taskkill.exe");
}

/** Kills a process and its descendants synchronously (best effort). */
export function killProcessTreeSync(pid: number): void {
	if (pid <= 0) return;
	if (process.platform === "win32") {
		try {
			spawnSync(getTaskkillPath(), ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				timeout: 2000,
				windowsHide: true,
			});
		} catch {
			// Process may have already exited.
		}
		return;
	}

	if (process.platform === "darwin") {
		try {
			process.kill(-pid, "SIGSTOP");
		} catch {
			// Ignore stop error.
		}
	}
	try {
		process.kill(-pid, "SIGKILL");
	} catch {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			// Process already dead.
		}
	}
}

/** Kills a process and its descendants asynchronously, resolving once the kill command completes. */
export async function killProcessTreeAsync(pid: number): Promise<void> {
	if (pid <= 0) return;
	if (process.platform !== "win32") {
		killProcessTreeSync(pid);
		return;
	}

	await new Promise<void>((resolve) => {
		let settled = false;
		const finish = () => {
			if (!settled) {
				settled = true;
				resolve();
			}
		};
		try {
			const killer = spawn(getTaskkillPath(), ["/F", "/T", "/PID", String(pid)], {
				stdio: "ignore",
				windowsHide: true,
			});
			killer.once("error", finish);
			killer.once("close", finish);
		} catch {
			finish();
		}
	});
}

function formatCommandPreview(command: string): string {
	const collapsed = command.replace(/\s+/g, " ").trim();
	if (collapsed.length <= COMMAND_PREVIEW_MAX_CHARS) {
		return collapsed;
	}
	return `${collapsed.slice(0, COMMAND_PREVIEW_MAX_CHARS - 3)}...`;
}

function resolveSignalExitCode(signal: NodeJS.Signals | null): number {
	if (!signal) return 1;
	const num = osConstants.signals[signal];
	return typeof num === "number" ? 128 + num : 1;
}

class ProcessOutputBuffer {
	private readonly taskId: string;
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxRollingBytes: number;
	private readonly tempDir: string;
	private readonly decoder = new TextDecoder("utf-8");

	private rawChunks: Buffer[] = [];
	private tailText = "";
	private tailBytes = 0;
	private tailNewlines = 0;
	private totalBytes = 0;
	private completedNewlines = 0;
	private endsWithNewline = false;
	private hasAnyText = false;
	private finished = false;
	private tempFilePath: string | undefined;
	private tempFileStream: WriteStream | undefined;

	constructor(options: { taskId: string; maxLines: number; maxBytes: number; tempDir: string }) {
		this.taskId = options.taskId;
		this.maxLines = options.maxLines;
		this.maxBytes = options.maxBytes;
		this.maxRollingBytes = Math.max(this.maxBytes * 2, 4096);
		this.tempDir = options.tempDir;
	}

	append(chunk: Buffer): void {
		if (this.finished || chunk.length === 0) {
			return;
		}
		const decoded = this.decoder.decode(chunk, { stream: true });
		this.appendDecodedText(decoded);

		if (this.tempFileStream) {
			this.tempFileStream.write(chunk);
		} else if (this.shouldSpillToTempFile()) {
			this.spillToTempFile([...this.rawChunks, chunk]);
			this.rawChunks = [];
		} else {
			this.rawChunks.push(chunk);
		}
	}

	finish(): void {
		if (this.finished) {
			return;
		}
		this.finished = true;
		const trailing = this.decoder.decode();
		if (trailing.length > 0) {
			this.appendDecodedText(trailing);
		}
		if (!this.tempFilePath && this.shouldSpillToTempFile()) {
			this.spillToTempFile(this.rawChunks, false);
			this.rawChunks = [];
		}
	}

	async closeTempFile(): Promise<void> {
		const stream = this.tempFileStream;
		if (!stream) {
			return;
		}
		this.tempFileStream = undefined;
		await new Promise<void>((resolve) => {
			let settled = false;
			const done = () => {
				if (!settled) {
					settled = true;
					resolve();
				}
			};
			stream.once("error", done);
			stream.once("finish", done);
			stream.end();
		});
	}

	closeTempFileSync(): void {
		const stream = this.tempFileStream;
		if (!stream) {
			return;
		}
		this.tempFileStream = undefined;
		try {
			stream.end();
		} catch {
			// Ignore close errors during synchronous dispose.
		}
	}

	snapshot(): { outputTail: string; truncated: boolean; totalBytes: number; fullOutputPath?: string } {
		const totalLines = this.getTotalLines();
		const truncated = totalLines > this.maxLines || this.totalBytes > this.maxBytes;
		const tailResult = truncateTail(this.tailText, {
			maxLines: this.maxLines,
			maxBytes: this.maxBytes,
		});
		if (truncated && !this.tempFilePath && this.rawChunks.length > 0) {
			this.spillToTempFile(this.rawChunks, !this.finished);
			this.rawChunks = [];
		}
		return {
			outputTail: tailResult.content,
			truncated,
			totalBytes: this.totalBytes,
			...(this.tempFilePath ? { fullOutputPath: this.tempFilePath } : {}),
		};
	}

	private getTotalLines(): number {
		if (!this.hasAnyText) {
			return 0;
		}
		return this.endsWithNewline ? this.completedNewlines : this.completedNewlines + 1;
	}

	private shouldSpillToTempFile(): boolean {
		return this.totalBytes > this.maxBytes || this.getTotalLines() > this.maxLines;
	}

	private spillToTempFile(initialChunks: Buffer[], keepOpenStream = true): void {
		if (!this.tempFilePath) {
			mkdirSync(this.tempDir, { recursive: true });
			const suffix = randomBytes(4).toString("hex");
			this.tempFilePath = join(this.tempDir, `pi-swarm-${this.taskId}-${suffix}.log`);
		}
		const initialBuffer = initialChunks.length > 0 ? Buffer.concat(initialChunks) : Buffer.alloc(0);
		writeFileSync(this.tempFilePath, initialBuffer);
		if (keepOpenStream && !this.tempFileStream) {
			this.tempFileStream = createWriteStream(this.tempFilePath, { flags: "a" });
			this.tempFileStream.on("error", () => {});
		}
	}

	private appendDecodedText(text: string): void {
		if (text.length === 0) {
			return;
		}
		this.hasAnyText = true;
		const bytes = Buffer.byteLength(text, "utf-8");
		this.totalBytes += bytes;

		let newlines = 0;
		for (let i = 0; i < text.length; i++) {
			if (text.charCodeAt(i) === 10) {
				newlines += 1;
			}
		}
		this.completedNewlines += newlines;
		this.endsWithNewline = text.endsWith("\n");

		this.tailText += text;
		this.tailBytes += bytes;
		this.tailNewlines += newlines;

		if (this.tailBytes > this.maxRollingBytes || this.tailNewlines > this.maxLines * 2) {
			const hadTrailingNewline = this.tailText.endsWith("\n");
			const trimmed = truncateTail(this.tailText, {
				maxLines: this.maxLines,
				maxBytes: this.maxBytes,
			}).content;
			this.tailText = hadTrailingNewline && trimmed.length > 0 && !trimmed.endsWith("\n") ? `${trimmed}\n` : trimmed;
			this.tailBytes = Buffer.byteLength(this.tailText, "utf-8");
			this.tailNewlines = 0;
			for (let i = 0; i < this.tailText.length; i++) {
				if (this.tailText.charCodeAt(i) === 10) {
					this.tailNewlines += 1;
				}
			}
		}
	}
}

interface InternalProcessEntry {
	taskId: string;
	ownerWorker: string;
	command: string;
	commandPreview: string;
	state: BackgroundProcessState;
	isDaemon: boolean;
	pid?: number;
	startedAt: number;
	lastOutputAt: number;
	endedAt?: number;
	exitCode?: number;
	signal?: string;
	notifyAfterSeconds?: number;
	promoted: boolean;
	exiting: boolean;
	child: ChildProcess;
	output: ProcessOutputBuffer;
	waitTimer?: ReturnType<typeof setTimeout>;
	reminderTimer?: ReturnType<typeof setTimeout>;
	closedPromise: Promise<void>;
	resolveClosed: () => void;
}

/**
 * Manages worker shell commands with sync-to-async promotion, bounded tail output
 * buffers with temp-file spill, silence tracking, reminder timers, and tree kills.
 */
export class BackgroundProcessManager {
	private readonly onEventCallback?: (event: BackgroundProcessEvent) => void | Promise<void>;
	private readonly eventListeners = new Set<(event: BackgroundProcessEvent) => void | Promise<void>>();
	private readonly now: () => number;
	private readonly maxLines: number;
	private readonly maxBytes: number;
	private readonly maxEndedHistory: number;
	private readonly defaultWaitMs: number;
	private readonly maxWaitMs: number;
	private readonly defaultNotifyAfterSeconds: number;
	private readonly shellPath?: string;
	private readonly tempDir: string;

	private readonly activeProcesses = new Map<string, InternalProcessEntry>();
	private readonly endedProcesses = new Map<string, InternalProcessEntry>();
	private readonly ownerKillGeneration = new Map<string, number>();
	private cachedShellConfig: ResolvedShellConfig | undefined;
	private counter = 0;
	private globalKillGeneration = 0;
	private disposed = false;

	constructor(options: BackgroundProcessManagerOptions = {}) {
		this.onEventCallback = options.onEvent;
		this.now = options.now ?? (() => Date.now());
		this.maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
		this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
		this.maxEndedHistory = options.maxEndedHistory ?? DEFAULT_MAX_ENDED_HISTORY;
		this.defaultWaitMs = options.defaultWaitMs ?? DEFAULT_WAIT_MS;
		this.maxWaitMs = options.maxWaitMs ?? DEFAULT_MAX_WAIT_MS;
		this.defaultNotifyAfterSeconds = options.defaultNotifyAfterSeconds ?? DEFAULT_NOTIFY_AFTER_SECONDS;
		this.shellPath = options.shellPath;
		this.tempDir = options.tempDir ?? tmpdir();
	}

	/** Registers an additional event listener for background process events and returns an unsubscribe handle. */
	onEvent(listener: (event: BackgroundProcessEvent) => void | Promise<void>): () => void {
		this.eventListeners.add(listener);
		return () => {
			this.eventListeners.delete(listener);
		};
	}

	/**
	 * Executes a shell command in `cwd` owned by `ownerWorker`.
	 * Returns synchronously if it exits within `waitMs`, or promotes it to background without killing.
	 */
	async runCommand(options: RunBackgroundCommandOptions): Promise<AsyncBashResult> {
		if (this.disposed) {
			throw new Error("BackgroundProcessManager has been disposed.");
		}
		const ownerWorker = options.ownerWorker.trim();
		if (!ownerWorker) {
			throw new Error("ownerWorker must be a non-empty string.");
		}
		if (!options.command || options.command.trim().length === 0) {
			throw new Error("command must be a non-empty string.");
		}

		const requestedWaitMs = options.waitMs ?? this.defaultWaitMs;
		if (!Number.isFinite(requestedWaitMs) || requestedWaitMs < 0) {
			throw new Error(`wait_ms must be a non-negative finite number, got ${requestedWaitMs}.`);
		}
		const waitMs = Math.min(Math.round(requestedWaitMs), this.maxWaitMs);

		const isDaemon = Boolean(options.isDaemon);
		const notifyAfterSeconds = isDaemon
			? undefined
			: options.notifyAfterSeconds ?? this.defaultNotifyAfterSeconds;
		if (notifyAfterSeconds !== undefined && (!Number.isFinite(notifyAfterSeconds) || notifyAfterSeconds <= 0)) {
			throw new Error(`notify_after_seconds must be a positive finite number, got ${notifyAfterSeconds}.`);
		}

		const startGlobalGen = this.globalKillGeneration;
		const startOwnerGen = this.ownerKillGeneration.get(ownerWorker) ?? 0;

		try {
			await fsAccess(options.cwd, constants.F_OK);
		} catch {
			throw new Error(`Working directory does not exist: ${options.cwd}`);
		}

		if (
			this.disposed ||
			this.globalKillGeneration !== startGlobalGen ||
			(this.ownerKillGeneration.get(ownerWorker) ?? 0) !== startOwnerGen ||
			options.isCancelled?.()
		) {
			throw new Error(`Background command cancelled before launch for "${ownerWorker}".`);
		}

		const shellConfig = this.getResolvedShellConfig();
		const commandFromStdin = shellConfig.commandTransport === "stdin";

		this.counter += 1;
		const taskId = `proc-${this.counter}`;
		const startedAt = this.now();

		const child = spawn(
			shellConfig.shell,
			commandFromStdin ? shellConfig.args : [...shellConfig.args, options.command],
			{
				cwd: options.cwd,
				detached: process.platform !== "win32",
				env: options.env ?? process.env,
				stdio: ["pipe", "pipe", "pipe"],
				windowsHide: true,
			},
		);

		child.stdin?.on("error", () => {});
		if (commandFromStdin) {
			child.stdin?.end(options.command);
		}

		let resolveClosed!: () => void;
		const closedPromise = new Promise<void>((resolve) => {
			resolveClosed = resolve;
		});

		const entry: InternalProcessEntry = {
			taskId,
			ownerWorker,
			command: options.command,
			commandPreview: formatCommandPreview(options.command),
			state: "running",
			isDaemon,
			pid: child.pid,
			startedAt,
			lastOutputAt: startedAt,
			notifyAfterSeconds,
			promoted: false,
			exiting: false,
			child,
			output: new ProcessOutputBuffer({
				taskId,
				maxLines: this.maxLines,
				maxBytes: this.maxBytes,
				tempDir: this.tempDir,
			}),
			closedPromise,
			resolveClosed,
		};

		this.activeProcesses.set(taskId, entry);

		return await new Promise<AsyncBashResult>((resolve, reject) => {
			let runSettled = false;
			let exited = false;
			let stdoutEnded = child.stdout === null;
			let stderrEnded = child.stderr === null;
			let observedExitCode: number | null = null;
			let observedSignal: NodeJS.Signals | null = null;
			let postExitTimer: ReturnType<typeof setTimeout> | undefined;

			const clearWaitTimer = () => {
				if (entry.waitTimer !== undefined) {
					clearTimeout(entry.waitTimer);
					entry.waitTimer = undefined;
				}
			};

			const clearPostExitTimer = () => {
				if (postExitTimer !== undefined) {
					clearTimeout(postExitTimer);
					postExitTimer = undefined;
				}
			};

			const cleanupListeners = () => {
				clearPostExitTimer();
				child.removeListener("error", onError);
				child.removeListener("exit", onExit);
				child.removeListener("close", onClose);
				child.stdout?.removeListener("data", onChunk);
				child.stderr?.removeListener("data", onChunk);
				child.stdout?.removeListener("end", onStdoutEnd);
				child.stderr?.removeListener("end", onStderrEnd);
			};

			const finalizeProcess = async (code: number | null, signal: NodeJS.Signals | null) => {
				if (entry.exiting) {
					return;
				}
				entry.exiting = true;
				clearWaitTimer();
				this.clearReminderTimer(entry);
				cleanupListeners();

				child.stdout?.destroy();
				child.stderr?.destroy();

				entry.output.finish();
				await entry.output.closeTempFile();

				const wasKilled = entry.state === "killed" || this.disposed;
				if (!wasKilled) {
					entry.endedAt = this.now();
					entry.state = "exited";
					entry.signal = signal ?? undefined;
					entry.exitCode = code ?? resolveSignalExitCode(signal);
					this.moveToEnded(entry);
				}

				entry.resolveClosed();

				const snap = entry.output.snapshot();
				if (!runSettled) {
					runSettled = true;
					resolve({
						status: "exited",
						taskId: entry.taskId,
						command: entry.command,
						exitCode: entry.exitCode ?? 1,
						...(entry.signal ? { signal: entry.signal } : {}),
						outputTail: snap.outputTail,
						truncated: snap.truncated,
						totalBytes: snap.totalBytes,
						...(snap.fullOutputPath ? { fullOutputPath: snap.fullOutputPath } : {}),
						elapsedMs: Math.max(0, (entry.endedAt ?? this.now()) - entry.startedAt),
					});
					return;
				}

				if (entry.promoted && !wasKilled) {
					this.emitEvent({
						kind: "process_exit",
						summary: this.buildSummary(entry),
						outputTail: snap.outputTail,
						truncated: snap.truncated,
						...(snap.fullOutputPath ? { fullOutputPath: snap.fullOutputPath } : {}),
					});
				}
			};

			const armPostExitGrace = () => {
				clearPostExitTimer();
				postExitTimer = setTimeout(() => {
					void finalizeProcess(observedExitCode, observedSignal);
				}, EXIT_STDIO_GRACE_MS);
			};

			const maybeFinalizeAfterExit = () => {
				if (!exited || entry.exiting) return;
				if (stdoutEnded && stderrEnded) {
					void finalizeProcess(observedExitCode, observedSignal);
				}
			};

			const onChunk = (chunk: Buffer) => {
				entry.lastOutputAt = this.now();
				entry.output.append(chunk);
				if (exited && !entry.exiting) {
					armPostExitGrace();
				}
			};

			const onStdoutEnd = () => {
				stdoutEnded = true;
				maybeFinalizeAfterExit();
			};

			const onStderrEnd = () => {
				stderrEnded = true;
				maybeFinalizeAfterExit();
			};

			const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
				exited = true;
				observedExitCode = code;
				observedSignal = signal;
				maybeFinalizeAfterExit();
				if (!entry.exiting) {
					armPostExitGrace();
				}
			};

			const onClose = (code: number | null, signal: NodeJS.Signals | null) => {
				void finalizeProcess(code ?? observedExitCode, signal ?? observedSignal);
			};

			const onError = (err: Error) => {
				if (entry.exiting) {
					return;
				}
				entry.exiting = true;
				clearWaitTimer();
				this.clearReminderTimer(entry);
				cleanupListeners();

				entry.output.finish();
				entry.output.closeTempFileSync();

				const wasKilled = entry.state === "killed" || this.disposed;
				if (!wasKilled && entry.state === "running") {
					entry.state = "exited";
					entry.endedAt = this.now();
					entry.exitCode = 1;
					this.moveToEnded(entry);
				}
				entry.resolveClosed();

				if (!runSettled) {
					runSettled = true;
					if (wasKilled) {
						const snap = entry.output.snapshot();
						resolve({
							status: "exited",
							taskId: entry.taskId,
							command: entry.command,
							exitCode: entry.exitCode ?? 1,
							outputTail: snap.outputTail,
							truncated: snap.truncated,
							totalBytes: snap.totalBytes,
							...(snap.fullOutputPath ? { fullOutputPath: snap.fullOutputPath } : {}),
							elapsedMs: Math.max(0, (entry.endedAt ?? this.now()) - entry.startedAt),
						});
					} else {
						reject(err);
					}
					return;
				}

				if (entry.promoted && !wasKilled) {
					const snap = entry.output.snapshot();
					this.emitEvent({
						kind: "process_exit",
						summary: this.buildSummary(entry),
						outputTail: snap.outputTail,
						truncated: snap.truncated,
						...(snap.fullOutputPath ? { fullOutputPath: snap.fullOutputPath } : {}),
					});
				}
			};

			child.stdout?.on("data", onChunk);
			child.stderr?.on("data", onChunk);
			child.stdout?.once("end", onStdoutEnd);
			child.stderr?.once("end", onStderrEnd);
			child.once("exit", onExit);
			child.once("close", onClose);
			child.once("error", onError);

			entry.waitTimer = setTimeout(() => {
				entry.waitTimer = undefined;
				if (runSettled || entry.exiting || entry.state !== "running" || this.disposed) {
					return;
				}
				entry.promoted = true;
				runSettled = true;
				this.armReminderTimer(entry);
				const snap = entry.output.snapshot();
				const now = this.now();
				resolve({
					status: "running",
					taskId: entry.taskId,
					command: entry.command,
					...(entry.pid !== undefined ? { pid: entry.pid } : {}),
					isDaemon: entry.isDaemon,
					outputTail: snap.outputTail,
					truncated: snap.truncated,
					totalBytes: snap.totalBytes,
					...(snap.fullOutputPath ? { fullOutputPath: snap.fullOutputPath } : {}),
					elapsedMs: Math.max(0, now - entry.startedAt),
					silentMs: Math.max(0, now - entry.lastOutputAt),
					...(entry.notifyAfterSeconds !== undefined
						? { notifyAfterSeconds: entry.notifyAfterSeconds }
						: {}),
				});
			}, waitMs);
		});
	}

	/** Lists processes owned by `ownerWorker` (active only unless `includeEnded: true`). */
	list(ownerWorker: string, options: ListBackgroundProcessesOptions = {}): BackgroundProcessSummary[] {
		const results: BackgroundProcessSummary[] = [];
		for (const entry of this.activeProcesses.values()) {
			if (entry.ownerWorker === ownerWorker) {
				results.push(this.buildSummary(entry));
			}
		}
		if (options.includeEnded) {
			for (const entry of this.endedProcesses.values()) {
				if (entry.ownerWorker === ownerWorker) {
					results.push(this.buildSummary(entry));
				}
			}
		}
		return results;
	}

	/** Returns detailed status and tail output for a process owned by `ownerWorker`. */
	getStatus(ownerWorker: string, taskId: string): BackgroundProcessDetail {
		const entry = this.requireOwnedEntry(ownerWorker, taskId);
		const snap = entry.output.snapshot();
		return {
			...this.buildSummary(entry),
			outputTail: snap.outputTail,
			truncated: snap.truncated,
			totalBytes: snap.totalBytes,
		};
	}

	/** Writes UTF-8 `input` to the stdin of a running process owned by `ownerWorker`. */
	async sendInput(ownerWorker: string, taskId: string, input: string): Promise<ManageProcessResult> {
		const entry = this.requireOwnedEntry(ownerWorker, taskId);
		if (entry.state !== "running" || entry.exiting) {
			throw new Error(`Cannot send input to background process "${taskId}" because it is already ${entry.state}.`);
		}
		const stdin = entry.child.stdin;
		if (!stdin || stdin.destroyed || !stdin.writable) {
			throw new Error(`Cannot send input to background process "${taskId}": stdin is not writable.`);
		}

		const bytesWritten = Buffer.byteLength(input, "utf-8");
		await new Promise<void>((resolve, reject) => {
			try {
				stdin.write(input, "utf-8", (err) => {
					if (err) {
						reject(new Error(`Failed to write stdin to "${taskId}": ${err.message}`));
						return;
					}
					resolve();
				});
			} catch (err) {
				reject(
					new Error(
						`Failed to write stdin to "${taskId}": ${err instanceof Error ? err.message : String(err)}`,
					),
				);
			}
		});

		return {
			kind: "send_input",
			taskId,
			bytesWritten,
		};
	}

	/** Terminates a background process tree owned by `ownerWorker` and suppresses any exit event. */
	async kill(ownerWorker: string, taskId: string): Promise<ManageProcessResult> {
		const entry = this.requireOwnedEntry(ownerWorker, taskId);
		const killed = await this.killEntry(entry);
		return {
			kind: "kill",
			taskId,
			killed,
			summary: this.buildSummary(entry),
		};
	}

	/** Returns summaries of currently running background processes (all workers, or filtered by `ownerWorker`). */
	getActiveSummaries(ownerWorker?: string): BackgroundProcessSummary[] {
		const summaries: BackgroundProcessSummary[] = [];
		for (const entry of this.activeProcesses.values()) {
			if (ownerWorker && entry.ownerWorker !== ownerWorker) {
				continue;
			}
			summaries.push(this.buildSummary(entry));
		}
		return summaries;
	}

	/** Kills all active background processes owned by `ownerWorker` and returns the count killed. */
	async killByOwner(ownerWorker: string): Promise<number> {
		this.ownerKillGeneration.set(ownerWorker, (this.ownerKillGeneration.get(ownerWorker) ?? 0) + 1);
		const targets: InternalProcessEntry[] = [];
		for (const entry of this.activeProcesses.values()) {
			if (entry.ownerWorker === ownerWorker) {
				targets.push(entry);
			}
		}
		const results = await Promise.all(targets.map((entry) => this.killEntry(entry)));
		return results.filter(Boolean).length;
	}

	/** Kills all active background processes across all workers. */
	async killAll(): Promise<void> {
		this.globalKillGeneration += 1;
		const targets = Array.from(this.activeProcesses.values());
		await Promise.all(targets.map((entry) => this.killEntry(entry)));
	}

	/** Marks the manager disposed, clears all timers, and synchronously kills any active process trees. */
	dispose(): void {
		if (this.disposed) {
			return;
		}
		this.disposed = true;
		this.globalKillGeneration += 1;
		const targets = Array.from(this.activeProcesses.values());
		for (const entry of targets) {
			this.clearWaitTimer(entry);
			this.clearReminderTimer(entry);
			if (entry.state === "running") {
				entry.state = "killed";
				entry.endedAt = this.now();
				this.moveToEnded(entry);
			}
			if (entry.pid) {
				killProcessTreeSync(entry.pid);
			}
			entry.output.finish();
			entry.output.closeTempFileSync();
			entry.child.stdout?.destroy();
			entry.child.stderr?.destroy();
			entry.resolveClosed();
		}
		this.eventListeners.clear();
	}

	private getResolvedShellConfig(): ResolvedShellConfig {
		if (!this.cachedShellConfig) {
			this.cachedShellConfig = resolveShellConfig(this.shellPath);
		}
		return this.cachedShellConfig;
	}

	private requireOwnedEntry(ownerWorker: string, taskId: string): InternalProcessEntry {
		const entry = this.activeProcesses.get(taskId) ?? this.endedProcesses.get(taskId);
		if (!entry) {
			throw new Error(`Background process "${taskId}" not found.`);
		}
		if (entry.ownerWorker !== ownerWorker) {
			throw new Error(
				`Permission denied: worker "${ownerWorker}" cannot access background process "${taskId}" owned by "${entry.ownerWorker}".`,
			);
		}
		return entry;
	}

	private async killEntry(entry: InternalProcessEntry): Promise<boolean> {
		if (entry.state !== "running") {
			return false;
		}
		if (entry.exiting) {
			await this.waitForEntryClosed(entry);
			return false;
		}
		entry.state = "killed";
		entry.endedAt = this.now();
		this.clearWaitTimer(entry);
		this.clearReminderTimer(entry);
		this.moveToEnded(entry);

		if (entry.pid) {
			await killProcessTreeAsync(entry.pid);
		} else {
			try {
				entry.child.kill("SIGKILL");
			} catch {
				// Ignore already dead child.
			}
		}

		// Wait briefly for child pipes/exit cleanup so OS state and temp files are settled.
		await this.waitForEntryClosed(entry);
		return true;
	}

	private async waitForEntryClosed(entry: InternalProcessEntry): Promise<void> {
		await Promise.race([
			entry.closedPromise,
			new Promise<void>((resolve) => {
				const timer = setTimeout(resolve, KILL_WAIT_TIMEOUT_MS);
				timer.unref?.();
			}),
		]);
	}

	private clearWaitTimer(entry: InternalProcessEntry): void {
		if (entry.waitTimer !== undefined) {
			clearTimeout(entry.waitTimer);
			entry.waitTimer = undefined;
		}
	}

	private clearReminderTimer(entry: InternalProcessEntry): void {
		if (entry.reminderTimer !== undefined) {
			clearTimeout(entry.reminderTimer);
			entry.reminderTimer = undefined;
		}
	}

	private armReminderTimer(entry: InternalProcessEntry): void {
		if (this.disposed || entry.isDaemon || entry.notifyAfterSeconds === undefined) {
			return;
		}
		this.clearReminderTimer(entry);
		const delayMs = Math.min(Math.max(1, Math.round(entry.notifyAfterSeconds * 1000)), MAX_TIMEOUT_MS);
		entry.reminderTimer = setTimeout(() => {
			entry.reminderTimer = undefined;
			if (this.disposed || entry.state !== "running" || entry.exiting) {
				return;
			}
			const snap = entry.output.snapshot();
			this.emitEvent({
				kind: "process_still_running",
				summary: this.buildSummary(entry),
				outputTail: snap.outputTail,
				truncated: snap.truncated,
				...(snap.fullOutputPath ? { fullOutputPath: snap.fullOutputPath } : {}),
			});
		}, delayMs);
	}

	private moveToEnded(entry: InternalProcessEntry): void {
		this.activeProcesses.delete(entry.taskId);
		if (this.maxEndedHistory <= 0) {
			return;
		}
		this.endedProcesses.delete(entry.taskId);
		this.endedProcesses.set(entry.taskId, entry);
		while (this.endedProcesses.size > this.maxEndedHistory) {
			const oldestKey = this.endedProcesses.keys().next().value;
			if (oldestKey === undefined) break;
			this.endedProcesses.delete(oldestKey);
		}
	}

	private buildSummary(entry: InternalProcessEntry): BackgroundProcessSummary {
		const refTime = entry.endedAt ?? this.now();
		const snap = entry.output.snapshot();
		return {
			taskId: entry.taskId,
			ownerWorker: entry.ownerWorker,
			command: entry.command,
			commandPreview: entry.commandPreview,
			state: entry.state,
			isDaemon: entry.isDaemon,
			...(entry.pid !== undefined ? { pid: entry.pid } : {}),
			startedAt: entry.startedAt,
			lastOutputAt: entry.lastOutputAt,
			...(entry.endedAt !== undefined ? { endedAt: entry.endedAt } : {}),
			...(entry.exitCode !== undefined ? { exitCode: entry.exitCode } : {}),
			...(entry.signal !== undefined ? { signal: entry.signal } : {}),
			elapsedMs: Math.max(0, refTime - entry.startedAt),
			silentMs: Math.max(0, refTime - entry.lastOutputAt),
			...(snap.fullOutputPath ? { fullOutputPath: snap.fullOutputPath } : {}),
		};
	}

	private emitEvent(event: BackgroundProcessEvent): void {
		if (this.disposed) {
			return;
		}
		const dispatch = (fn: (ev: BackgroundProcessEvent) => void | Promise<void>) => {
			try {
				Promise.resolve(fn(event)).catch(() => {
					// Listener failures must not break process lifecycle management.
				});
			} catch {
				// Ignore synchronous listener errors.
			}
		};
		if (this.onEventCallback) {
			dispatch(this.onEventCallback);
		}
		for (const listener of this.eventListeners) {
			dispatch(listener);
		}
	}
}

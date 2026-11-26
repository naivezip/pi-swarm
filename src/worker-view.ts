import { basename } from "node:path";
import type { AgentMessage } from "@earendil-works/pi-agent-core";
import {
	CustomEditor,
	type ExtensionContext,
	getSelectListTheme,
	initTheme,
	type KeybindingsManager,
	type Theme,
	type ThemeColor,
} from "@earendil-works/pi-coding-agent";
import {
	CombinedAutocompleteProvider,
	type Component,
	Container,
	type EditorTheme,
	type Focusable,
	type KeybindingsManager as TuiKeybindingsManager,
	matchesKey,
	Spacer,
	Text,
	TruncatedText,
	truncateToWidth,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
	VStack,
} from "@earendil-works/pi-tui";
import type { DirectWorkerMessageDelivery, SwarmManager, SwarmSnapshot } from "./runtime.ts";
import type { MemberState, MemberStatusSummary } from "./types.ts";
import { formatCost, type SwarmOverlayTab } from "./ui.ts";
import {
	createWorkerSlashCommands,
	parseWorkerSlashCommand,
	WORKER_BUILT_IN_COMMAND_NAMES,
	WorkerModelPickerComponent,
} from "./worker-view-commands.ts";
import { WorkerViewFooterController } from "./worker-view-footer.ts";
import { WorkerViewTranscriptController } from "./worker-view-transcript.ts";

export type WorkerViewResult = {
	kind: "open_overlay";
	tab?: SwarmOverlayTab;
};

export interface WorkerViewOptions {
	throttleMs?: number;
	returnTab?: SwarmOverlayTab;
	writeFallback?: (text: string) => void;
}

type WorkerViewModalState =
	| { kind: "none" }
	| { kind: "confirm_kill" }
	| { kind: "model_picker"; picker: WorkerModelPickerComponent };

const DEFAULT_THROTTLE_MS = 60;
const GLOBAL_THEME_SYMBOL = Symbol.for("@earendil-works/pi-coding-agent:theme");

function ensurePiThemeInitialized(fallbackTheme: Theme): void {
	const store = globalThis as Record<symbol, unknown>;
	if (store[GLOBAL_THEME_SYMBOL]) {
		return;
	}
	try {
		initTheme(undefined, false);
	} catch {
		// Fall back to caller theme in restricted test environments.
	}
	if (!store[GLOBAL_THEME_SYMBOL]) {
		store[GLOBAL_THEME_SYMBOL] = fallbackTheme;
	}
}

function stateThemeColor(state: MemberState): ThemeColor {
	switch (state) {
		case "working":
			return "accent";
		case "waiting":
			return "success";
		case "stopped":
			return "warning";
		case "killed":
			return "error";
	}
}

function formatWorkspaceLabel(member: MemberStatusSummary | undefined, fallbackCwd: string): string {
	if (!member) {
		return basename(fallbackCwd) || fallbackCwd;
	}
	const dirName = basename(member.workspacePath) || member.workspacePath;
	if (member.workspaceBranch) {
		return `${member.workspaceMode}:${member.workspaceBranch}`;
	}
	return `${member.workspaceMode}:${dirName}`;
}

/** Renders a plain-text worker summary for non-TUI modes (`print`, `json`, `rpc`). */
export function renderWorkerPlainSummary(
	snapshot: SwarmSnapshot,
	workerName: string,
	messages: readonly AgentMessage[],
): string {
	const member = snapshot.members.find((m) => m.name === workerName);
	if (!member) {
		return `[swarm worker] ${workerName} [unavailable]`;
	}
	const lines = [
		`[swarm worker] ${member.name} [${member.state}] · ${formatWorkspaceLabel(member, snapshot.cwd)} · model=${member.model ?? "default"} · cost=${formatCost(member.usage.cost)} · messages=${messages.length}`,
	];
	if (member.lastError) {
		lines.push(`Last error: ${member.lastError}`);
	}
	return lines.join("\n");
}

/**
 * Full-screen Pi-native worker view component.
 * Displays a 1-line top identity bar, a scrollable native Pi conversation area,
 * pending steer/followUp queue display, a Pi `CustomEditor` with `/model`, `/abort`,
 * `/kill`, `/exit` autocomplete, and Pi's native footer (with fallback when stopped/killed).
 */
export class SwarmWorkerViewComponent implements Component, Focusable {
	readonly capturesViewportInput = true;

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: TuiKeybindingsManager | KeybindingsManager;
	private readonly manager: SwarmManager;
	private readonly ctx: ExtensionContext;
	private readonly workerName: string;
	private readonly done: (result: WorkerViewResult | undefined) => void;
	private readonly options: WorkerViewOptions | undefined;
	private readonly throttleMs: number;

	private readonly identityBarComponent: Component;
	private readonly transcript: WorkerViewTranscriptController;
	private readonly pendingMessagesContainer: Container;
	private readonly statusContainer: Container;
	private readonly dockInputContainer: Container;
	private readonly footerController: WorkerViewFooterController;
	private readonly dockStack: VStack;
	private readonly rootStack: VStack;
	readonly editor: CustomEditor;

	private modal: WorkerViewModalState = { kind: "none" };
	private statusNote: string | undefined;
	private statusIsError = false;
	private closed = false;
	private _focused = true;

	private unsubSnapshot: (() => void) | undefined;
	private unsubWorkerEvents: (() => void) | undefined;
	private throttleTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingRender = false;
	private lastRenderAt = 0;

	get focused(): boolean {
		return this._focused;
	}

	set focused(value: boolean) {
		this._focused = value;
		if (this.modal.kind === "model_picker") {
			this.modal.picker.focused = value;
			this.editor.focused = false;
		} else {
			this.editor.focused = value && !this.isReadOnly();
		}
	}

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: TuiKeybindingsManager | KeybindingsManager,
		manager: SwarmManager,
		ctx: ExtensionContext,
		workerName: string,
		done: (result: WorkerViewResult | undefined) => void,
		options?: WorkerViewOptions,
	) {
		ensurePiThemeInitialized(theme);
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.manager = manager;
		this.ctx = ctx;
		this.workerName = workerName;
		this.done = done;
		this.options = options;
		this.throttleMs = options?.throttleMs ?? DEFAULT_THROTTLE_MS;

		this.identityBarComponent = {
			render: (width: number) => [this.renderIdentityLine(width)],
			invalidate: () => {},
		};

		this.transcript = new WorkerViewTranscriptController({
			tui: this.tui,
			theme: this.theme,
			getCwd: () => this.getMember()?.workspacePath ?? this.manager.cwd,
			getSession: () => this.manager.getWorkerSession(this.workerName),
		});

		this.pendingMessagesContainer = new Container();
		this.statusContainer = new Container();
		this.dockInputContainer = new Container();

		this.footerController = new WorkerViewFooterController({
			theme: this.theme,
			ctx: this.ctx,
			workerName: this.workerName,
			getSnapshot: () => this.manager.getSnapshot(),
			getSession: () => this.manager.getWorkerSession(this.workerName),
		});

		const editorTheme: EditorTheme = {
			borderColor: (text: string) => this.theme.fg("borderMuted", text),
			selectList: getSelectListTheme(),
		};
		this.editor = new CustomEditor(this.tui, editorTheme, this.keybindings as KeybindingsManager, {
			paddingX: 1,
			autocompleteMaxVisible: 5,
		});

		const autocomplete = new CombinedAutocompleteProvider(
			createWorkerSlashCommands({
				getModels: () => this.manager.listModels({ all: true, ctx: this.ctx }),
			}),
			this.getMember()?.workspacePath ?? this.manager.cwd,
		);
		this.editor.setAutocompleteProvider(autocomplete);
		this.editor.onEscape = () => this.handleEditorEscape();
		this.editor.onCtrlD = () => this.close(undefined);
		this.editor.onSubmit = (text: string) => this.handleEditorSubmit(text);
		this.editor.focused = !this.isReadOnly();

		this.dockStack = new VStack([
			{ component: this.pendingMessagesContainer, shrink: 1, minSize: 0 },
			{ component: this.statusContainer, shrink: 1, minSize: 0 },
			{ component: this.dockInputContainer, shrink: 1, minSize: 1 },
			{ component: this.footerController, shrink: 1, minSize: 0 },
		]);

		this.rootStack = new VStack([
			{ component: this.identityBarComponent, basis: 1, shrink: 0, minSize: 1 },
			{ component: this.transcript.scrollView, basis: 0, grow: 1, shrink: 1, minSize: 1 },
			{ component: this.dockStack, basis: "auto", grow: 0, shrink: 1, minSize: 1 },
		]);

		this.transcript.hydrate(
			this.manager.getWorkerMessages(this.workerName),
			this.manager.getWorkerLiveActivity(this.workerName),
		);
		this.syncDock();

		this.unsubSnapshot = this.manager.subscribe(() => {
			if (this.closed) return;
			this.syncDock();
			this.scheduleRender();
		});
		this.unsubWorkerEvents = this.manager.subscribeWorkerEvents(this.workerName, (event) => {
			if (this.closed) return;
			const changed = this.transcript.handleEvent(event);
			if (event.type === "queue_update" || event.type === "message_start" || event.type === "agent_settled") {
				this.syncPendingMessages();
			}
			if (event.type === "message_end" || event.type === "agent_settled" || event.type === "session_info_changed") {
				this.footerController.invalidate();
			}
			if (changed || event.type === "queue_update" || event.type === "agent_settled") {
				this.scheduleRender();
			}
		});
	}

	private getMember(): MemberStatusSummary | undefined {
		return this.manager.getSnapshot().members.find((m) => m.name === this.workerName);
	}

	private isReadOnly(): boolean {
		const member = this.getMember();
		return !member || member.state === "killed";
	}

	private setStatus(message: string | undefined, isError = false): void {
		this.statusNote = message;
		this.statusIsError = isError;
		this.syncStatusLine();
	}

	private close(result: WorkerViewResult | undefined): void {
		if (this.closed) return;
		this.closed = true;
		this.dispose();
		this.done(result);
	}

	private scheduleRender(): void {
		if (this.closed) return;
		if (this.throttleMs <= 0) {
			this.tui.requestRender();
			return;
		}
		const now = Date.now();
		const elapsed = now - this.lastRenderAt;
		if (elapsed >= this.throttleMs && !this.throttleTimer) {
			this.lastRenderAt = now;
			this.tui.requestRender();
			return;
		}
		this.pendingRender = true;
		if (this.throttleTimer) return;
		const delay = Math.max(0, this.throttleMs - elapsed);
		this.throttleTimer = setTimeout(() => {
			this.throttleTimer = undefined;
			if (!this.pendingRender || this.closed) return;
			this.pendingRender = false;
			this.lastRenderAt = Date.now();
			this.tui.requestRender();
		}, delay);
	}

	private refreshNow(): void {
		if (this.closed) return;
		this.syncDock();
		this.lastRenderAt = Date.now();
		this.tui.requestRender();
	}

	private renderIdentityLine(width: number): string {
		const th = this.theme;
		const snap = this.manager.getSnapshot();
		const member = snap.members.find((m) => m.name === this.workerName);
		const state: MemberState = member?.state ?? "killed";
		const badge = th.fg("accent", th.bold("[swarm worker]"));
		const nameText = th.bold(this.workerName);
		const stateText = th.fg(stateThemeColor(state), `[${state}]`);
		const wsText = th.fg("muted", formatWorkspaceLabel(member, snap.cwd));
		const activityText =
			state === "working" && member?.currentActivity
				? ` ${th.fg("dim", "·")} ${th.fg("accent", member.currentActivity)}`
				: "";
		const hints = th.fg(
			"dim",
			state === "killed"
				? "Esc/Ctrl+D exit · Alt+S overlay · PgUp/PgDn scroll · Ctrl+O tools · Ctrl+T thinking"
				: "Esc abort/exit · Ctrl+D exit · Alt+S overlay · Ctrl+O tools · Ctrl+T thinking",
		);
		const sep = th.fg("dim", " · ");
		const line = ` ${badge} ${nameText} ${stateText}${sep}${wsText}${activityText}${sep}${hints}`;
		return truncateToWidth(line, width);
	}

	private syncPendingMessages(): void {
		this.pendingMessagesContainer.clear();
		const { steering, followUp } = this.manager.getWorkerQueuedMessages(this.workerName);
		if (steering.length === 0 && followUp.length === 0) {
			return;
		}
		const th = this.theme;
		this.pendingMessagesContainer.addChild(new Spacer(1));
		for (const msg of steering) {
			this.pendingMessagesContainer.addChild(
				new TruncatedText(th.fg("dim", `Steering: ${msg}`), 1, 0),
			);
		}
		for (const msg of followUp) {
			this.pendingMessagesContainer.addChild(
				new TruncatedText(th.fg("dim", `Follow-up: ${msg}`), 1, 0),
			);
		}
	}

	private syncStatusLine(): void {
		this.statusContainer.clear();
		if (!this.statusNote) return;
		const color: ThemeColor = this.statusIsError ? "error" : "warning";
		this.statusContainer.addChild(
			new TruncatedText(` ${this.theme.fg(color, this.statusNote)}`, 1, 0),
		);
	}

	private syncDockInput(): void {
		this.dockInputContainer.clear();
		const th = this.theme;

		if (this.modal.kind === "confirm_kill") {
			this.editor.focused = false;
			this.dockInputContainer.addChild(
				new Text(
					` ${th.fg("warning", th.bold(`Kill worker "${this.workerName}"?`))} ${th.fg("muted", "Permanent: disposes session and deletes share/branch workspace.")}`,
					0,
					0,
				),
			);
			this.dockInputContainer.addChild(
				new Text(` ${th.fg("accent", "[y/Enter]")} Confirm kill   ${th.fg("muted", "[n/Esc]")} Cancel`, 0, 0),
			);
			return;
		}

		if (this.modal.kind === "model_picker") {
			this.editor.focused = false;
			this.modal.picker.focused = this._focused;
			this.dockInputContainer.addChild(this.modal.picker);
			return;
		}

		const member = this.getMember();
		if (!member || member.state === "killed") {
			this.editor.disableSubmit = true;
			this.editor.focused = false;
			this.dockInputContainer.addChild(
				new Text(
					` ${th.fg("warning", th.bold("[read-only]"))} ${th.fg("muted", `Worker "${this.workerName}" is ${member?.state ?? "unavailable"}. History is read-only · Esc/Ctrl+D exit · Alt+S overlay.`)}`,
					0,
					0,
				),
			);
			return;
		}

		this.editor.disableSubmit = false;
		this.editor.focused = this._focused;
		this.updateEditorBorderColor(member);
		this.dockInputContainer.addChild(this.editor);
	}

	private updateEditorBorderColor(member: MemberStatusSummary): void {
		const session = this.manager.getWorkerSession(this.workerName);
		const thinkingLevel = session?.thinkingLevel ?? session?.state?.thinkingLevel ?? "off";
		const thinkingFn = (this.theme as { getThinkingBorderColor?: (lvl: string) => (s: string) => string }).getThinkingBorderColor;
		if (member.state === "stopped") {
			this.editor.borderColor = (text: string) => this.theme.fg("warning", text);
		} else if (typeof thinkingFn === "function") {
			this.editor.borderColor = thinkingFn.call(this.theme, thinkingLevel);
		} else {
			this.editor.borderColor = (text: string) => this.theme.fg("borderMuted", text);
		}
	}

	private syncDock(): void {
		this.syncPendingMessages();
		this.syncStatusLine();
		this.syncDockInput();
	}

	private handleEditorEscape(): void {
		const member = this.getMember();
		if (member?.state === "working") {
			void this.executeAbortCommand();
			return;
		}
		this.close(undefined);
	}

	private handleEditorSubmit(rawText: string): void {
		const text = rawText.trim();
		if (!text) return;

		const cmd = parseWorkerSlashCommand(text);
		if (cmd) {
			this.handleSlashCommand(cmd);
			return;
		}

		this.editor.addToHistory(text);
		const member = this.getMember();
		const delivery: DirectWorkerMessageDelivery = member?.state === "working" ? "steer" : "prompt";
		this.submitDirectMessage(text, delivery);
	}

	private submitDirectMessage(text: string, delivery: DirectWorkerMessageDelivery): void {
		const member = this.getMember();
		if (!member || member.state === "killed") {
			this.setStatus(`Worker "${this.workerName}" is killed (read-only).`, true);
			this.refreshNow();
			return;
		}
		if (member.state === "stopped") {
			this.setStatus(`Resuming ${this.workerName} and sending message...`);
		} else if (delivery === "steer") {
			this.setStatus("Queued steering message.");
		} else if (delivery === "followUp") {
			this.setStatus("Queued follow-up message.");
		} else {
			this.setStatus(undefined);
		}

		void this.manager
			.sendDirectWorkerMessage(this.workerName, text, delivery)
			.then((res) => {
				if (res.resumed) {
					this.setStatus(`Resumed ${this.workerName}.`);
				}
				this.syncDock();
				this.refreshNow();
			})
			.catch((err: unknown) => {
				this.setStatus(err instanceof Error ? err.message : String(err), true);
				this.refreshNow();
			});
	}

	private handleSlashCommand(cmd: { name: string; args: string; raw: string }): void {
		switch (cmd.name) {
			case "exit":
				this.close(undefined);
				return;
			case "abort":
				void this.executeAbortCommand();
				return;
			case "kill":
				this.openKillConfirmModal();
				return;
			case "model":
				this.executeModelCommand(cmd.args);
				return;
			default:
				this.setStatus(
					`Unknown command "/${cmd.name}". Available: ${WORKER_BUILT_IN_COMMAND_NAMES.map((c) => `/${c}`).join(", ")}.`,
					true,
				);
				this.refreshNow();
		}
	}

	private async executeAbortCommand(): Promise<void> {
		const member = this.getMember();
		if (!member) {
			this.setStatus(`Worker "${this.workerName}" does not exist.`, true);
			this.refreshNow();
			return;
		}
		if (member.state !== "working") {
			this.setStatus(`Worker "${this.workerName}" is already idle (${member.state}).`, false);
			this.refreshNow();
			return;
		}
		this.setStatus(`Aborting ${this.workerName}...`);
		this.refreshNow();
		try {
			const result = await this.manager.abortWorkerByUser(this.workerName);
			this.setStatus(
				result.aborted
					? `Aborted ${this.workerName} (now ${result.state}).`
					: `Worker "${this.workerName}" is already idle (${result.state}).`,
			);
		} catch (err) {
			this.setStatus(`Abort failed: ${err instanceof Error ? err.message : String(err)}`, true);
		}
		this.refreshNow();
	}

	private openKillConfirmModal(): void {
		const member = this.getMember();
		if (!member || member.state === "killed") {
			this.setStatus(`Worker "${this.workerName}" is already killed.`);
			this.refreshNow();
			return;
		}
		this.modal = { kind: "confirm_kill" };
		this.refreshNow();
	}

	private executeModelCommand(args: string): void {
		const member = this.getMember();
		if (!member) {
			this.setStatus(`Worker "${this.workerName}" does not exist.`, true);
			this.refreshNow();
			return;
		}
		if (member.state === "killed") {
			this.setStatus(`Cannot switch model: worker "${this.workerName}" has been killed.`, true);
			this.refreshNow();
			return;
		}
		if (member.state === "working") {
			this.setStatus(`Cannot switch model while worker "${this.workerName}" is working.`, true);
			this.refreshNow();
			return;
		}

		if (args) {
			const available = this.manager.listModels({ all: true, ctx: this.ctx });
			const exact = available.find(
				(m) => `${m.provider}/${m.id}`.toLowerCase() === args.toLowerCase() || m.id.toLowerCase() === args.toLowerCase(),
			);
			if (exact) {
				this.applyModelSwitch(`${exact.provider}/${exact.id}`);
				return;
			}
		}

		const picker = new WorkerModelPickerComponent({
			tui: this.tui,
			theme: this.theme,
			keybindings: this.keybindings,
			workerName: this.workerName,
			manager: this.manager,
			ctx: this.ctx,
			currentModelRef: member.model,
			initialFilter: args || undefined,
			onSelect: (modelRef) => {
				this.modal = { kind: "none" };
				this.applyModelSwitch(modelRef);
			},
			onCancel: () => {
				this.modal = { kind: "none" };
				this.setStatus("Model switch cancelled.");
				this.refreshNow();
			},
		});
		this.modal = { kind: "model_picker", picker };
		this.refreshNow();
	}

	private applyModelSwitch(modelRef: string): void {
		this.setStatus(`Switching ${this.workerName} to ${modelRef}...`);
		this.refreshNow();
		void this.manager
			.switchWorkerModelByUser(this.workerName, modelRef, this.ctx.modelRegistry)
			.then((res) => {
				this.setStatus(`Switched ${res.target} to ${res.model}${res.woke ? " (resumed)" : ""}.`);
				this.footerController.invalidate();
				this.refreshNow();
			})
			.catch((err: unknown) => {
				this.setStatus(`Model switch failed: ${err instanceof Error ? err.message : String(err)}`, true);
				this.refreshNow();
			});
	}

	handleInput(data: string): void {
		if (this.modal.kind === "confirm_kill") {
			if (data === "y" || data === "Y" || matchesKey(data, "enter") || matchesKey(data, "return")) {
				this.modal = { kind: "none" };
				this.setStatus(`Killing ${this.workerName}...`);
				this.refreshNow();
				void this.manager
					.killWorkerByUser(this.workerName)
					.then((res) => {
						this.setStatus(`Killed ${res.killed.join(", ")}. View is now read-only.`);
						this.footerController.invalidate();
						this.refreshNow();
					})
					.catch((err: unknown) => {
						this.setStatus(`Kill failed: ${err instanceof Error ? err.message : String(err)}`, true);
						this.refreshNow();
					});
				return;
			}
			if (
				data === "n" ||
				data === "N" ||
				matchesKey(data, "escape") ||
				this.keybindings.matches(data, "tui.select.cancel") ||
				this.keybindings.matches(data, "app.interrupt")
			) {
				this.modal = { kind: "none" };
				this.setStatus("Kill cancelled.");
				this.refreshNow();
			}
			return;
		}

		if (this.modal.kind === "model_picker") {
			this.modal.picker.handleInput(data);
			return;
		}

		// Ctrl+D always exits directly to Coordinator without interrupting a working worker.
		if (matchesKey(data, "ctrl+d")) {
			if (this.editor.isShowingAutocomplete()) {
				this.editor.handleInput("\x1b");
			}
			this.close(undefined);
			return;
		}

		// Alt+S always switches directly to Swarm Overlay without interrupting a working worker.
		if (matchesKey(data, "alt+s")) {
			if (this.editor.isShowingAutocomplete()) {
				this.editor.handleInput("\x1b");
			}
			this.close({ kind: "open_overlay", tab: this.options?.returnTab });
			return;
		}

		// Ctrl+O toggles tool output expansion.
		if (this.keybindings.matches(data, "app.tools.expand") || matchesKey(data, "ctrl+o")) {
			const expanded = this.transcript.toggleToolsExpanded();
			this.setStatus(expanded ? "Tool outputs expanded." : "Tool outputs collapsed.");
			this.refreshNow();
			return;
		}

		// Ctrl+T toggles thinking block visibility.
		if (this.keybindings.matches(data, "app.thinking.toggle") || matchesKey(data, "ctrl+t")) {
			const hidden = this.transcript.toggleThinkingHidden();
			this.setStatus(hidden ? "Thinking blocks hidden." : "Thinking blocks shown.");
			this.refreshNow();
			return;
		}

		// Transcript scrolling when autocomplete is not open.
		if (!this.editor.isShowingAutocomplete()) {
			if (matchesKey(data, "pageUp") || this.keybindings.matches(data, "tui.altScreen.pageUp")) {
				this.transcript.scrollPage(-1);
				this.tui.requestRender();
				return;
			}
			if (matchesKey(data, "pageDown") || this.keybindings.matches(data, "tui.altScreen.pageDown")) {
				this.transcript.scrollPage(1);
				this.tui.requestRender();
				return;
			}
			if (this.keybindings.matches(data, "tui.altScreen.top")) {
				this.transcript.scrollToStart();
				this.tui.requestRender();
				return;
			}
			if (this.keybindings.matches(data, "tui.altScreen.bottom")) {
				this.transcript.scrollToEnd();
				this.tui.requestRender();
				return;
			}
		}

		if (this.isReadOnly()) {
			if (
				matchesKey(data, "escape") ||
				this.keybindings.matches(data, "app.interrupt") ||
				this.keybindings.matches(data, "tui.select.cancel")
			) {
				this.close(undefined);
			}
			return;
		}

		// Alt+Enter (or configured followUp key) queues followUp when working.
		if (
			!this.editor.isShowingAutocomplete() &&
			(this.keybindings.matches(data, "app.message.followUp") ||
				matchesKey(data, "alt+enter") ||
				data === "\x1b\r")
		) {
			const text = (this.editor.getExpandedText?.() ?? this.editor.getText()).trim();
			if (!text) return;
			this.editor.setText("");
			const cmd = parseWorkerSlashCommand(text);
			if (cmd) {
				this.handleSlashCommand(cmd);
				return;
			}
			this.editor.addToHistory(text);
			const member = this.getMember();
			this.submitDirectMessage(text, member?.state === "working" ? "followUp" : "prompt");
			return;
		}

		// Fallback for minimal TUI-only KeybindingsManager instances that omit app.interrupt.
		if (
			matchesKey(data, "escape") &&
			!this.keybindings.matches(data, "app.interrupt") &&
			!this.editor.isShowingAutocomplete()
		) {
			this.handleEditorEscape();
			this.tui.requestRender();
			return;
		}

		this.editor.handleInput(data);
		this.tui.requestRender();
	}

	handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
		const totalRows = Math.max(12, this.tui.terminal?.rows ?? 24);
		const safeWidth = Math.max(20, event.width);
		const dockHeight = this.dockStack.render(safeWidth).length;
		const transcriptHeight = Math.max(3, totalRows - 1 - dockHeight);
		const res = this.transcript.handleMouse(event, 1, transcriptHeight);
		if (res?.handled) {
			this.tui.requestRender();
			return res;
		}
		const editorRowOffset = 1 + transcriptHeight + this.pendingMessagesContainer.render(safeWidth).length + this.statusContainer.render(safeWidth).length;
		if (this.modal.kind === "none" && !this.isReadOnly() && event.y >= editorRowOffset) {
			const editorRes = this.editor.handleMouse({
				...event,
				y: event.y - editorRowOffset,
			});
			if (editorRes?.handled) {
				this.tui.requestRender();
				return editorRes;
			}
		}
		return undefined;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(20, width);
		const totalRows = Math.max(12, this.tui.terminal?.rows ?? 24);

		// Keep rootStack synchronized while computing viewport height for ScrollView.
		void this.rootStack;
		this.syncDock();

		const identityLine = this.renderIdentityLine(safeWidth);
		const dockLines = this.dockStack.render(safeWidth);
		const transcriptHeight = Math.max(3, totalRows - 1 - dockLines.length);
		const transcriptLines = this.transcript.renderViewport(safeWidth, transcriptHeight);

		return [identityLine, ...transcriptLines, ...dockLines].map((line) =>
			visibleWidth(line) <= safeWidth ? line : truncateToWidth(line, safeWidth),
		);
	}

	invalidate(): void {
		this.transcript.chatContainer.invalidate();
		this.footerController.invalidate();
		this.editor.invalidate();
	}

	dispose(): void {
		if (this.unsubSnapshot) {
			this.unsubSnapshot();
			this.unsubSnapshot = undefined;
		}
		if (this.unsubWorkerEvents) {
			this.unsubWorkerEvents();
			this.unsubWorkerEvents = undefined;
		}
		if (this.throttleTimer) {
			clearTimeout(this.throttleTimer);
			this.throttleTimer = undefined;
		}
		this.pendingRender = false;
		this.footerController.dispose();
	}
}

/**
 * Opens the full-screen Pi-native worker view in TUI mode (`overlay: false`),
 * or outputs a plain summary cleanly in non-TUI (`print` / `json` / `rpc`) modes.
 */
export async function openWorkerView(
	ctx: ExtensionContext,
	manager: SwarmManager,
	workerName: string,
	options?: WorkerViewOptions,
): Promise<WorkerViewResult | undefined> {
	if (!ctx.hasUI) {
		const summary = renderWorkerPlainSummary(
			manager.getSnapshot(),
			workerName,
			manager.getWorkerMessages(workerName),
		);
		if (options?.writeFallback) {
			options.writeFallback(summary);
		} else {
			console.log(summary);
		}
		return undefined;
	}

	if (ctx.mode !== "tui") {
		const summary = renderWorkerPlainSummary(
			manager.getSnapshot(),
			workerName,
			manager.getWorkerMessages(workerName),
		);
		ctx.ui.notify(summary, "info");
		return undefined;
	}

	return ctx.ui.custom<WorkerViewResult | undefined>(
		(tui, theme, keybindings, done) =>
			new SwarmWorkerViewComponent(tui, theme, keybindings, manager, ctx, workerName, done, options),
		{
			overlay: false,
			blocked: { kind: "question", message: `Swarm Worker: ${workerName}` },
		},
	);
}

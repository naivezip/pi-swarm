import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage, ToolResultMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext, Theme, ThemeColor } from "@earendil-works/pi-coding-agent";
import {
	type Component,
	type KeybindingsManager,
	matchesKey,
	truncateToWidth,
	type TUI,
	visibleWidth,
	wrapTextWithAnsi,
} from "@earendil-works/pi-tui";
import type { ModelInfoEntry, SwarmManager, SwarmSnapshot } from "./runtime.ts";
import type { BoardMessage, MemberState, MemberStatusSummary } from "./types.ts";

export const SWARM_WIDGET_KEY = "pi-swarm";

export type SwarmOverlayTab = "overview" | "board" | "workers";

export type SwarmOverlayResult = {
	kind: "prefill";
	text: string;
};

export interface SwarmOverlayOptions {
	initialTab?: SwarmOverlayTab;
	throttleMs?: number;
	writeFallback?: (text: string) => void;
}

const DEFAULT_THROTTLE_MS = 80;
const TAB_ORDER: readonly SwarmOverlayTab[] = ["overview", "board", "workers"];
const MENTION_TOKEN_RE = /(@#[a-z0-9][a-z0-9_-]*|@[a-z0-9][a-z0-9_-]*|@all)/gi;

/** Formats a token count compactly (e.g. `450`, `1.2k`, `3.4M`). */
export function formatTokenCount(count: number): string {
	if (count >= 1_000_000) {
		return `${(count / 1_000_000).toFixed(1)}M`;
	}
	if (count >= 1_000) {
		return `${(count / 1_000).toFixed(1)}k`;
	}
	return String(Math.round(count));
}

/** Formats a USD cost figure compactly. */
export function formatCost(cost: number): string {
	if (cost <= 0) {
		return "$0.00";
	}
	if (cost < 0.01) {
		return `$${cost.toFixed(4)}`;
	}
	if (cost < 1) {
		return `$${cost.toFixed(3)}`;
	}
	return `$${cost.toFixed(2)}`;
}

/** Formats a Unix timestamp in `HH:MM:SS`. */
export function formatTimeShort(ms: number): string {
	const d = new Date(ms);
	const hh = String(d.getHours()).padStart(2, "0");
	const mm = String(d.getMinutes()).padStart(2, "0");
	const ss = String(d.getSeconds()).padStart(2, "0");
	return `${hh}:${mm}:${ss}`;
}

function getStateColor(state: MemberState): ThemeColor {
	switch (state) {
		case "working":
			return "accent";
		case "waiting":
			return "success";
		case "stopped":
			return "warning";
		case "killed":
			return "dim";
	}
}

function getStateGlyph(state: MemberState): string {
	switch (state) {
		case "working":
			return "*";
		case "waiting":
			return "o";
		case "stopped":
			return "-";
		case "killed":
			return "x";
	}
}

function highlightMentions(text: string, theme: Theme): string {
	return text.replace(MENTION_TOKEN_RE, (match) => theme.fg("accent", theme.bold(match)));
}

function padRightVisible(text: string, targetWidth: number): string {
	const truncated = truncateToWidth(text, targetWidth);
	const vis = visibleWidth(truncated);
	if (vis >= targetWidth) {
		return truncated;
	}
	return `${truncated}${" ".repeat(targetWidth - vis)}`;
}

function formatMessageLine(msg: BoardMessage, width: number, theme: Theme, selected: boolean): string[] {
	const prefix = selected ? theme.fg("accent", "> ") : "  ";
	const seqText = theme.fg("accent", `#${msg.seq}`);
	const timeText = theme.fg("dim", formatTimeShort(msg.timestamp));
	const channelText = theme.fg("muted", `[#${msg.channel}]`);
	const authorText = theme.bold(msg.author);
	const header = `${prefix}${seqText} ${timeText} ${channelText} ${authorText}:`;
	const bodyLines = wrapTextWithAnsi(highlightMentions(msg.text.trim(), theme), Math.max(16, width - 4));
	if (bodyLines.length === 0) {
		return [truncateToWidth(header, width)];
	}
	const out: string[] = [truncateToWidth(`${header} ${bodyLines[0]}`, width)];
	for (let i = 1; i < bodyLines.length; i++) {
		out.push(truncateToWidth(`    ${bodyLines[i]}`, width));
	}
	return out;
}

/** Renders a plain-text summary of the swarm for non-TUI (`print` / `json` / `rpc`) modes. */
export function renderSwarmPlainSummary(snapshot: SwarmSnapshot): string {
	const lines: string[] = [
		`Swarm: ${snapshot.title} (${snapshot.swarmId}) | active=${snapshot.active} | head=#${snapshot.head}`,
		`Coordinator: state=${snapshot.coordinator.state} wake=${snapshot.coordinator.wakeMode} lastRead=#${snapshot.coordinator.lastReadSeq}`,
		`Usage: in=${formatTokenCount(snapshot.totals.input)} out=${formatTokenCount(snapshot.totals.output)} cost=${formatCost(snapshot.totals.cost)} turns=${snapshot.totals.turns}`,
		`Channels (${snapshot.channels.length}): ${snapshot.channels.map((c) => `#${c.name}${c.archived ? "[archived]" : ""}`).join(", ")}`,
	];

	if (snapshot.plan.goal.title) {
		lines.push(`Plan: ${snapshot.plan.goal.title} - ${snapshot.plan.goal.line}`);
		for (const thread of snapshot.plan.threads) {
			lines.push(`  Thread [${thread.id}] ${thread.title}: ${thread.goal} (${thread.tasks.join(", ")})`);
		}
	}

	lines.push(`Workers (${snapshot.members.length}):`);
	if (snapshot.members.length === 0) {
		lines.push("  (none)");
	} else {
		for (const m of snapshot.members) {
			const parts = [
				`${m.name} [${m.state}]`,
				m.model ? `model=${m.model}` : undefined,
				`ws=${m.workspaceMode}`,
				`tok=${formatTokenCount(m.usage.input)}/${formatTokenCount(m.usage.output)}`,
				formatCost(m.usage.cost),
				m.currentActivity ? `activity="${m.currentActivity}"` : undefined,
				m.lastError ? `error="${m.lastError}"` : undefined,
			].filter((p): p is string => p !== undefined);
			lines.push(`  - ${parts.join(" | ")}`);
		}
	}

	const recent = snapshot.messages.slice(-5);
	lines.push(`Recent board posts (${recent.length}/${snapshot.messages.length}):`);
	for (const msg of recent) {
		lines.push(`  #${msg.seq} [${formatTimeShort(msg.timestamp)}] [#${msg.channel}] ${msg.author}: ${msg.text}`);
	}

	return lines.join("\n");
}

/** Renders the compact persistent TUI widget lines above the editor. */
export function renderSwarmWidgetLines(
	snapshot: SwarmSnapshot | undefined,
	theme: Theme,
	width: number,
	coordinatorModeActive = false,
): string[] {
	const safeWidth = Math.max(20, width);
	if (!snapshot) {
		if (!coordinatorModeActive) {
			return [];
		}
		const line = `${theme.fg("accent", theme.bold("[swarm]"))} ${theme.fg("text", "Coordinator active")} ${theme.fg("dim", "(0 workers · #0)")} ${theme.fg("muted", "· Alt+S / /swarm for board")}`;
		return [truncateToWidth(line, safeWidth)];
	}

	const liveMembers = snapshot.members.filter((m) => m.state !== "killed");
	const killedCount = snapshot.members.length - liveMembers.length;
	const activeChannelCount = snapshot.channels.filter((c) => !c.archived).length;
	const totalTokens = formatTokenCount(snapshot.totals.input + snapshot.totals.output);
	const totalCost = formatCost(snapshot.totals.cost);

	const headerLeft = `${theme.fg("accent", theme.bold("[swarm]"))} ${theme.bold(snapshot.title)} ${theme.fg("dim", `· ${activeChannelCount} ch · #${snapshot.head}`)}`;
	const headerStats = `${theme.fg("muted", `${totalTokens} tok · ${totalCost}`)} ${theme.fg("dim", "· Alt+S / /swarm")}`;
	const headerLine = truncateToWidth(`${headerLeft} ${headerStats}`, safeWidth);

	if (snapshot.members.length === 0) {
		return [
			headerLine,
			truncateToWidth(theme.fg("dim", "  No workers yet. Coordinator ready."), safeWidth),
		];
	}

	const lines: string[] = [headerLine];
	const displayMembers = liveMembers.length > 0 ? liveMembers : snapshot.members;
	for (const m of displayMembers) {
		const color = getStateColor(m.state);
		const glyph = theme.fg(color, getStateGlyph(m.state));
		const stateTag = theme.fg(color, m.state);
		const nameText = m.state === "killed" ? theme.fg("dim", m.name) : theme.bold(m.name);

		const extras: string[] = [];
		if (m.currentActivity) {
			extras.push(theme.fg("muted", m.currentActivity));
		}
		if (m.lastError) {
			const shortErr = m.lastError.length > 44 ? `${m.lastError.slice(0, 41)}...` : m.lastError;
			extras.push(theme.fg("error", `[err: ${shortErr}]`));
		}
		if (m.unreadCount > 0) {
			extras.push(theme.fg("warning", `${m.unreadCount} unread`));
		}
		const extraText = extras.length > 0 ? ` ${theme.fg("dim", "·")} ${extras.join(" ")}` : "";
		const workerLine = `  ${glyph} ${nameText} ${theme.fg("dim", "[")}${stateTag}${theme.fg("dim", "]")}${extraText}`;
		lines.push(truncateToWidth(workerLine, safeWidth));
	}

	if (liveMembers.length > 0 && killedCount > 0) {
		lines.push(truncateToWidth(theme.fg("dim", `  + ${killedCount} killed worker${killedCount === 1 ? "" : "s"}`), safeWidth));
	}

	return lines;
}

/** Live TUI widget component backed by `SwarmManager` change events with throttled redraws. */
export class SwarmWidgetComponent implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly getSnapshot: () => SwarmSnapshot | undefined;
	private readonly isCoordinatorActive: () => boolean;
	private readonly throttleMs: number;

	private unsubscribe: (() => void) | undefined;
	private throttleTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingRender = false;
	private lastRenderAt = 0;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(options: {
		tui: TUI;
		theme: Theme;
		manager?: SwarmManager;
		getSnapshot?: () => SwarmSnapshot | undefined;
		isCoordinatorActive?: () => boolean;
		throttleMs?: number;
	}) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.getSnapshot = options.getSnapshot ?? (() => options.manager?.getSnapshot());
		this.isCoordinatorActive = options.isCoordinatorActive ?? (() => true);
		this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;

		if (options.manager) {
			this.unsubscribe = options.manager.subscribe(() => {
				this.scheduleRefresh();
			});
		}
	}

	/** Schedules a throttled invalidation and TUI render request. */
	scheduleRefresh(): void {
		const now = Date.now();
		const elapsed = now - this.lastRenderAt;
		if (elapsed >= this.throttleMs && !this.throttleTimer) {
			this.lastRenderAt = now;
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		this.pendingRender = true;
		if (this.throttleTimer) {
			return;
		}
		const delay = Math.max(0, this.throttleMs - elapsed);
		this.throttleTimer = setTimeout(() => {
			this.throttleTimer = undefined;
			if (!this.pendingRender) {
				return;
			}
			this.pendingRender = false;
			this.lastRenderAt = Date.now();
			this.invalidate();
			this.tui.requestRender();
		}, delay);
	}

	render(width: number): readonly string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}
		this.cachedWidth = width;
		this.cachedLines = renderSwarmWidgetLines(
			this.getSnapshot(),
			this.theme,
			width,
			this.isCoordinatorActive(),
		);
		return this.cachedLines;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	dispose(): void {
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = undefined;
		}
		if (this.throttleTimer) {
			clearTimeout(this.throttleTimer);
			this.throttleTimer = undefined;
		}
		this.pendingRender = false;
	}
}

/** Manages persistent widget registration across TUI, RPC, and non-UI modes. */
export class SwarmWidgetController {
	private readonly getManager: () => SwarmManager | undefined;
	private readonly isCoordinatorActive: () => boolean;
	private readonly throttleMs: number;

	private currentCtx: ExtensionContext | undefined;
	private attachedManager: SwarmManager | undefined;
	private widgetComponent: SwarmWidgetComponent | undefined;
	private unsubscribeRpc: (() => void) | undefined;
	private rpcTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingRpc = false;

	constructor(options: {
		getManager: () => SwarmManager | undefined;
		isCoordinatorActive: () => boolean;
		throttleMs?: number;
	}) {
		this.getManager = options.getManager;
		this.isCoordinatorActive = options.isCoordinatorActive;
		this.throttleMs = options.throttleMs ?? DEFAULT_THROTTLE_MS;
	}

	/** Refreshes or clears the widget for the given `ExtensionContext`. */
	refresh(ctx?: ExtensionContext): void {
		if (ctx) {
			this.currentCtx = ctx;
		}
		const activeCtx = this.currentCtx;
		if (!activeCtx || !activeCtx.hasUI) {
			return;
		}

		const manager = this.getManager();
		const active = this.isCoordinatorActive();
		const shouldShow = active || (manager !== undefined && manager.getSnapshot().active);

		if (!shouldShow) {
			this.clearWidget(activeCtx);
			return;
		}

		if (activeCtx.mode === "tui") {
			if (this.widgetComponent && this.attachedManager === manager) {
				this.widgetComponent.scheduleRefresh();
				return;
			}
			this.attachedManager = manager;
			activeCtx.ui.setWidget(SWARM_WIDGET_KEY, (tui, theme) => {
				const comp = new SwarmWidgetComponent({
					tui,
					theme,
					manager,
					getSnapshot: () => this.getManager()?.getSnapshot(),
					isCoordinatorActive: this.isCoordinatorActive,
					throttleMs: this.throttleMs,
				});
				this.widgetComponent = comp;
				return comp;
			});
			return;
		}

		// RPC mode: push plain string arrays (component factories are ignored in RPC mode).
		if (manager !== this.attachedManager) {
			this.unsubscribeRpc?.();
			this.unsubscribeRpc = undefined;
			this.attachedManager = manager;
			if (manager) {
				this.unsubscribeRpc = manager.subscribe(() => {
					this.scheduleRpcUpdate();
				});
			}
		}
		this.pushRpcLines(activeCtx);
	}

	private scheduleRpcUpdate(): void {
		if (this.rpcTimer) {
			this.pendingRpc = true;
			return;
		}
		if (this.currentCtx) {
			this.pushRpcLines(this.currentCtx);
		}
		this.rpcTimer = setTimeout(() => {
			this.rpcTimer = undefined;
			if (this.pendingRpc && this.currentCtx) {
				this.pendingRpc = false;
				this.pushRpcLines(this.currentCtx);
			}
		}, this.throttleMs);
	}

	private pushRpcLines(ctx: ExtensionContext): void {
		const snapshot = this.getManager()?.getSnapshot();
		const lines = renderSwarmWidgetLines(snapshot, ctx.ui.theme, 100, this.isCoordinatorActive());
		ctx.ui.setWidget(SWARM_WIDGET_KEY, lines.length > 0 ? lines : undefined);
	}

	private clearWidget(ctx: ExtensionContext): void {
		this.unsubscribeRpc?.();
		this.unsubscribeRpc = undefined;
		if (this.rpcTimer) {
			clearTimeout(this.rpcTimer);
			this.rpcTimer = undefined;
		}
		this.pendingRpc = false;
		this.widgetComponent = undefined;
		this.attachedManager = undefined;
		ctx.ui.setWidget(SWARM_WIDGET_KEY, undefined);
	}

	dispose(): void {
		this.unsubscribeRpc?.();
		this.unsubscribeRpc = undefined;
		if (this.rpcTimer) {
			clearTimeout(this.rpcTimer);
			this.rpcTimer = undefined;
		}
		this.widgetComponent?.dispose();
		this.widgetComponent = undefined;
		this.attachedManager = undefined;
	}
}

type OverlayModal =
	| { kind: "none" }
	| { kind: "confirm_kill"; workerName: string }
	| { kind: "model_picker"; workerName: string; models: ModelInfoEntry[]; selectedIndex: number; showAll: boolean };

function formatTranscriptMessages(messages: readonly AgentMessage[], liveStreaming: string, activeTools: readonly string[]): string[] {
	const lines: string[] = [];
	for (const msg of messages) {
		if (msg.role === "user") {
			const text =
				typeof msg.content === "string"
					? msg.content
					: msg.content
							.filter((b): b is { type: "text"; text: string } => b.type === "text")
							.map((b) => b.text)
							.join("\n");
			lines.push(`[user] ${text.trim()}`);
			continue;
		}
		if (msg.role === "assistant") {
			const assistant = msg as AssistantMessage;
			for (const block of assistant.content) {
				if (block.type === "text" && block.text.trim().length > 0) {
					lines.push(`[assistant] ${block.text.trim()}`);
				} else if (block.type === "toolCall") {
					lines.push(`[toolCall] ${block.name}(${JSON.stringify(block.arguments)})`);
				}
			}
			if (assistant.stopReason === "error" && assistant.errorMessage) {
				lines.push(`[error] ${assistant.errorMessage}`);
			}
			continue;
		}
		if (msg.role === "toolResult") {
			const tr = msg as ToolResultMessage;
			const text = tr.content
				.filter((b): b is { type: "text"; text: string } => b.type === "text")
				.map((b) => b.text)
				.join("\n")
				.trim();
			const preview = text.length > 240 ? `${text.slice(0, 237)}...` : text;
			lines.push(`[toolResult:${tr.toolName}${tr.isError ? " ERROR" : ""}] ${preview}`);
		}
	}

	if (activeTools.length > 0) {
		lines.push(`[running tools] ${activeTools.join(", ")}`);
	}
	if (liveStreaming.trim().length > 0) {
		lines.push(`[streaming] ${liveStreaming.trim()}`);
	}
	if (lines.length === 0) {
		lines.push("(no messages yet)");
	}
	return lines;
}

/** Interactive 3-tab Swarm Board Overlay (`Overview`, `Board`, `Workers`). */
export class SwarmOverlayComponent implements Component {
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: KeybindingsManager;
	private readonly manager: SwarmManager;
	private readonly ctx: ExtensionContext;
	private readonly done: (result: SwarmOverlayResult | undefined) => void;
	private readonly throttleMs: number;

	private activeTab: SwarmOverlayTab;
	private overviewScroll = 0;
	private boardScroll = 0;
	private boardSelectedIndex = -1;
	private channelFilterIndex = 0;
	private memberFilterIndex = 0;
	private workerSelectedIndex = 0;
	private workerDetailScroll = 0;
	private workerDetailPinnedToBottom = true;
	private modal: OverlayModal = { kind: "none" };
	private statusNote: string | undefined;

	private unsubscribe: (() => void) | undefined;
	private throttleTimer: ReturnType<typeof setTimeout> | undefined;
	private pendingRender = false;
	private lastRenderAt = 0;
	private cachedWidth: number | undefined;
	private cachedLines: string[] | undefined;

	constructor(
		tui: TUI,
		theme: Theme,
		keybindings: KeybindingsManager,
		manager: SwarmManager,
		ctx: ExtensionContext,
		done: (result: SwarmOverlayResult | undefined) => void,
		options?: SwarmOverlayOptions,
	) {
		this.tui = tui;
		this.theme = theme;
		this.keybindings = keybindings;
		this.manager = manager;
		this.ctx = ctx;
		this.done = done;
		this.activeTab = options?.initialTab ?? "overview";
		this.throttleMs = options?.throttleMs ?? DEFAULT_THROTTLE_MS;

		this.unsubscribe = this.manager.subscribe(() => {
			this.scheduleRefresh();
		});
	}

	private scheduleRefresh(): void {
		const now = Date.now();
		const elapsed = now - this.lastRenderAt;
		if (elapsed >= this.throttleMs && !this.throttleTimer) {
			this.lastRenderAt = now;
			this.invalidate();
			this.tui.requestRender();
			return;
		}
		this.pendingRender = true;
		if (this.throttleTimer) {
			return;
		}
		const delay = Math.max(0, this.throttleMs - elapsed);
		this.throttleTimer = setTimeout(() => {
			this.throttleTimer = undefined;
			if (!this.pendingRender) {
				return;
			}
			this.pendingRender = false;
			this.lastRenderAt = Date.now();
			this.invalidate();
			this.tui.requestRender();
		}, delay);
	}

	private getChannelFilterOptions(snapshot: SwarmSnapshot): Array<string | undefined> {
		return [undefined, ...snapshot.channels.map((c) => c.name)];
	}

	private getMemberFilterOptions(snapshot: SwarmSnapshot): Array<string | undefined> {
		return [undefined, "coordinator", ...snapshot.members.map((m) => m.name)];
	}

	private getFilteredMessages(snapshot: SwarmSnapshot): BoardMessage[] {
		const chOpts = this.getChannelFilterOptions(snapshot);
		const memOpts = this.getMemberFilterOptions(snapshot);
		const ch = chOpts[this.channelFilterIndex % chOpts.length];
		const mem = memOpts[this.memberFilterIndex % memOpts.length];
		return snapshot.messages.filter((msg) => {
			if (ch !== undefined && msg.channel !== ch) {
				return false;
			}
			if (mem !== undefined && msg.author !== mem) {
				return false;
			}
			return true;
		});
	}

	private getSelectedWorker(snapshot: SwarmSnapshot): MemberStatusSummary | undefined {
		if (snapshot.members.length === 0) {
			return undefined;
		}
		const clamped = Math.max(0, Math.min(this.workerSelectedIndex, snapshot.members.length - 1));
		this.workerSelectedIndex = clamped;
		return snapshot.members[clamped];
	}

	handleInput(data: string): void {
		const snapshot = this.manager.getSnapshot();

		if (this.modal.kind === "confirm_kill") {
			if (data === "y" || data === "Y" || matchesKey(data, "enter") || matchesKey(data, "return")) {
				const targetName = this.modal.workerName;
				this.modal = { kind: "none" };
				this.statusNote = `Killing ${targetName}...`;
				this.refreshNow();
				void this.manager
					.killWorkerByUser(targetName)
					.then((res) => {
						this.statusNote = `Killed ${res.killed.join(", ")}.`;
						this.refreshNow();
					})
					.catch((err: unknown) => {
						this.statusNote = `Kill failed: ${err instanceof Error ? err.message : String(err)}`;
						this.refreshNow();
					});
				return;
			}
			if (data === "n" || data === "N" || data === "q" || matchesKey(data, "escape") || this.keybindings.matches(data, "tui.select.cancel")) {
				this.modal = { kind: "none" };
				this.statusNote = "Kill cancelled.";
				this.refreshNow();
			}
			return;
		}

		if (this.modal.kind === "model_picker") {
			const modal = this.modal;
			if (matchesKey(data, "escape") || data === "q" || this.keybindings.matches(data, "tui.select.cancel")) {
				this.modal = { kind: "none" };
				this.statusNote = "Model switch cancelled.";
				this.refreshNow();
				return;
			}
			if (data === "a") {
				const nextAll = !modal.showAll;
				const models = this.manager.listModels({ all: nextAll, ctx: this.ctx });
				this.modal = {
					kind: "model_picker",
					workerName: modal.workerName,
					models,
					selectedIndex: 0,
					showAll: nextAll,
				};
				this.refreshNow();
				return;
			}
			if (matchesKey(data, "up")) {
				if (modal.models.length > 0) {
					modal.selectedIndex = (modal.selectedIndex - 1 + modal.models.length) % modal.models.length;
					this.refreshNow();
				}
				return;
			}
			if (matchesKey(data, "down")) {
				if (modal.models.length > 0) {
					modal.selectedIndex = (modal.selectedIndex + 1) % modal.models.length;
					this.refreshNow();
				}
				return;
			}
			if (matchesKey(data, "enter") || matchesKey(data, "return")) {
				const chosen = modal.models[modal.selectedIndex];
				if (!chosen) {
					this.modal = { kind: "none" };
					this.refreshNow();
					return;
				}
				const targetName = modal.workerName;
				const modelRef = `${chosen.provider}/${chosen.id}`;
				this.modal = { kind: "none" };
				this.statusNote = `Switching ${targetName} to ${modelRef}...`;
				this.refreshNow();
				void this.manager
					.switchWorkerModelByUser(targetName, modelRef, this.ctx.modelRegistry)
					.then((res) => {
						this.statusNote = `Switched ${res.target} to ${res.model}${res.woke ? " (resumed)" : ""}.`;
						this.refreshNow();
					})
					.catch((err: unknown) => {
						this.statusNote = `Model switch failed: ${err instanceof Error ? err.message : String(err)}`;
						this.refreshNow();
					});
				return;
			}
			return;
		}

		// Global overlay close keys
		if (
			matchesKey(data, "escape") ||
			data === "q" ||
			this.keybindings.matches(data, "tui.select.cancel")
		) {
			this.done(undefined);
			return;
		}

		// Tab switching
		if (data === "1") {
			this.switchTab("overview");
			return;
		}
		if (data === "2") {
			this.switchTab("board");
			return;
		}
		if (data === "3") {
			this.switchTab("workers");
			return;
		}
		if (matchesKey(data, "tab") || matchesKey(data, "right")) {
			const idx = TAB_ORDER.indexOf(this.activeTab);
			this.switchTab(TAB_ORDER[(idx + 1) % TAB_ORDER.length]);
			return;
		}
		if (matchesKey(data, "shift+tab") || matchesKey(data, "left")) {
			const idx = TAB_ORDER.indexOf(this.activeTab);
			this.switchTab(TAB_ORDER[(idx - 1 + TAB_ORDER.length) % TAB_ORDER.length]);
			return;
		}

		// Per-tab input
		if (this.activeTab === "overview") {
			if (matchesKey(data, "up")) {
				this.overviewScroll = Math.max(0, this.overviewScroll - 1);
				this.refreshNow();
			} else if (matchesKey(data, "down")) {
				this.overviewScroll += 1;
				this.refreshNow();
			} else if (matchesKey(data, "pageUp")) {
				this.overviewScroll = Math.max(0, this.overviewScroll - 8);
				this.refreshNow();
			} else if (matchesKey(data, "pageDown")) {
				this.overviewScroll += 8;
				this.refreshNow();
			}
			return;
		}

		if (this.activeTab === "board") {
			const filtered = this.getFilteredMessages(snapshot);
			if (data === "c") {
				const chOpts = this.getChannelFilterOptions(snapshot);
				this.channelFilterIndex = (this.channelFilterIndex + 1) % chOpts.length;
				this.boardSelectedIndex = -1;
				this.boardScroll = 0;
				this.refreshNow();
				return;
			}
			if (data === "m") {
				const memOpts = this.getMemberFilterOptions(snapshot);
				this.memberFilterIndex = (this.memberFilterIndex + 1) % memOpts.length;
				this.boardSelectedIndex = -1;
				this.boardScroll = 0;
				this.refreshNow();
				return;
			}
			if (filtered.length === 0) {
				return;
			}
			const currentIdx =
				this.boardSelectedIndex < 0 || this.boardSelectedIndex >= filtered.length
					? filtered.length - 1
					: this.boardSelectedIndex;

			if (matchesKey(data, "up")) {
				this.boardSelectedIndex = Math.max(0, currentIdx - 1);
				this.refreshNow();
				return;
			}
			if (matchesKey(data, "down")) {
				this.boardSelectedIndex = Math.min(filtered.length - 1, currentIdx + 1);
				this.refreshNow();
				return;
			}
			if (matchesKey(data, "pageUp")) {
				this.boardSelectedIndex = Math.max(0, currentIdx - 8);
				this.refreshNow();
				return;
			}
			if (matchesKey(data, "pageDown")) {
				this.boardSelectedIndex = Math.min(filtered.length - 1, currentIdx + 8);
				this.refreshNow();
				return;
			}
			if (data === "r" || matchesKey(data, "enter") || matchesKey(data, "return")) {
				const chosen = filtered[currentIdx];
				if (chosen) {
					this.done({ kind: "prefill", text: `#${chosen.seq} ` });
				}
			}
			return;
		}

		// Workers tab
		const selected = this.getSelectedWorker(snapshot);
		if (matchesKey(data, "up")) {
			if (snapshot.members.length > 0) {
				this.workerSelectedIndex =
					(this.workerSelectedIndex - 1 + snapshot.members.length) % snapshot.members.length;
				this.workerDetailScroll = 0;
				this.workerDetailPinnedToBottom = true;
				this.refreshNow();
			}
			return;
		}
		if (matchesKey(data, "down")) {
			if (snapshot.members.length > 0) {
				this.workerSelectedIndex = (this.workerSelectedIndex + 1) % snapshot.members.length;
				this.workerDetailScroll = 0;
				this.workerDetailPinnedToBottom = true;
				this.refreshNow();
			}
			return;
		}
		if (matchesKey(data, "pageUp")) {
			this.workerDetailPinnedToBottom = false;
			this.workerDetailScroll = Math.max(0, this.workerDetailScroll - 8);
			this.refreshNow();
			return;
		}
		if (matchesKey(data, "pageDown")) {
			this.workerDetailScroll += 8;
			this.refreshNow();
			return;
		}
		if (data === "S") {
			this.statusNote = "Stopping all running workers...";
			this.refreshNow();
			void this.manager
				.stopAll()
				.then(() => {
					this.statusNote = "Stopped all running workers.";
					this.refreshNow();
				})
				.catch((err: unknown) => {
					this.statusNote = `Stop failed: ${err instanceof Error ? err.message : String(err)}`;
					this.refreshNow();
				});
			return;
		}
		if (!selected) {
			return;
		}
		if (data === "k") {
			if (selected.state === "killed") {
				this.statusNote = `Worker "${selected.name}" is already killed.`;
				this.refreshNow();
				return;
			}
			this.modal = { kind: "confirm_kill", workerName: selected.name };
			this.refreshNow();
			return;
		}
		if (data === "M") {
			if (selected.state === "killed") {
				this.statusNote = `Worker "${selected.name}" is killed.`;
				this.refreshNow();
				return;
			}
			if (selected.state === "working") {
				this.statusNote = `Cannot switch model while "${selected.name}" is working; wait or stop (S) first.`;
				this.refreshNow();
				return;
			}
			const models = this.manager.listModels({ all: false, ctx: this.ctx });
			if (models.length === 0) {
				const allModels = this.manager.listModels({ all: true, ctx: this.ctx });
				if (allModels.length === 0) {
					this.statusNote = "No models available in registry.";
					this.refreshNow();
					return;
				}
				this.modal = {
					kind: "model_picker",
					workerName: selected.name,
					models: allModels,
					selectedIndex: 0,
					showAll: true,
				};
				this.refreshNow();
				return;
			}
			this.modal = {
				kind: "model_picker",
				workerName: selected.name,
				models,
				selectedIndex: 0,
				showAll: false,
			};
			this.refreshNow();
		}
	}

	private switchTab(tab: SwarmOverlayTab): void {
		if (this.activeTab === tab) {
			return;
		}
		this.activeTab = tab;
		this.statusNote = undefined;
		this.refreshNow();
	}

	private refreshNow(): void {
		this.invalidate();
		this.tui.requestRender();
	}

	render(width: number): readonly string[] {
		if (this.cachedLines && this.cachedWidth === width) {
			return this.cachedLines;
		}

		const outerW = Math.max(40, width);
		const innerW = outerW - 2;
		const termRows = Math.max(18, (this.tui.terminal?.rows ?? 30) - 4);
		const snapshot = this.manager.getSnapshot();
		const th = this.theme;

		const row = (content: string): string =>
			`${th.fg("border", "│")}${padRightVisible(content, innerW)}${th.fg("border", "│")}`;
		const divider = (): string => th.fg("border", `├${"─".repeat(innerW)}┤`);

		const lines: string[] = [];
		lines.push(th.fg("border", `╭${"─".repeat(innerW)}╮`));

		// Title & stats header
		const titleText = ` ${th.fg("accent", th.bold("Swarm"))} ${th.bold(snapshot.title)}`;
		const statsText = `${th.fg("dim", `#${snapshot.head}`)} · ${th.fg("muted", `${formatTokenCount(snapshot.totals.input + snapshot.totals.output)} tok`)} · ${th.fg("muted", formatCost(snapshot.totals.cost))} `;
		lines.push(row(`${titleText}  ${statsText}`));

		// Tab bar
		const tabLabel = (tab: SwarmOverlayTab, num: string, label: string): string => {
			const text = `[${num}] ${label}`;
			if (this.activeTab === tab) {
				return th.style(` ${text} `, { fg: "accent", bg: "selectedBg", bold: true });
			}
			return th.fg("muted", ` ${text} `);
		};
		lines.push(
			row(
				` ${tabLabel("overview", "1", "Overview")}  ${tabLabel("board", "2", "Board")}  ${tabLabel("workers", "3", "Workers")}`,
			),
		);
		lines.push(divider());

		// Reserve space for header (4), footer (2-3), modal if active
		const modalLines = this.renderModalLines(innerW);
		const footerReserve = 2 + (modalLines.length > 0 ? modalLines.length + 1 : 0);
		const bodyHeight = Math.max(6, termRows - lines.length - footerReserve);

		let bodyLines: string[];
		if (this.activeTab === "overview") {
			bodyLines = this.renderOverviewBody(snapshot, innerW, bodyHeight);
		} else if (this.activeTab === "board") {
			bodyLines = this.renderBoardBody(snapshot, innerW, bodyHeight);
		} else {
			bodyLines = this.renderWorkersBody(snapshot, innerW, bodyHeight);
		}

		for (let i = 0; i < bodyHeight; i++) {
			lines.push(row(bodyLines[i] ?? ""));
		}

		if (modalLines.length > 0) {
			lines.push(divider());
			for (const ml of modalLines) {
				lines.push(row(ml));
			}
		}

		lines.push(divider());
		lines.push(row(this.renderFooterHint()));
		lines.push(th.fg("border", `╰${"─".repeat(innerW)}╯`));

		this.cachedWidth = width;
		this.cachedLines = lines;
		return lines;
	}

	private renderOverviewBody(snapshot: SwarmSnapshot, innerW: number, bodyHeight: number): string[] {
		const th = this.theme;
		const content: string[] = [];
		const memberMap = new Map(snapshot.members.map((m) => [m.name, m]));

		const hasPlan =
			snapshot.plan.goal.title.trim().length > 0 ||
			snapshot.plan.threads.length > 0 ||
			Object.keys(snapshot.plan.tasks).length > 0;

		if (hasPlan) {
			content.push(` ${th.fg("accent", th.bold(snapshot.plan.goal.title || snapshot.title))}`);
			if (snapshot.plan.goal.line) {
				content.push(` ${th.fg("muted", snapshot.plan.goal.line)}`);
			}
			content.push("");

			if (snapshot.plan.threads.length > 0) {
				for (const thread of snapshot.plan.threads) {
					content.push(` ${th.fg("accent", "◆")} ${th.bold(thread.title)} ${th.fg("dim", `[${thread.id}]`)}`);
					if (thread.goal) {
						content.push(`   ${th.fg("muted", thread.goal)}`);
					}
					for (const workerName of thread.tasks) {
						const member = memberMap.get(workerName);
						const taskDesc = snapshot.plan.tasks[workerName] ?? "";
						content.push(this.formatOverviewWorkerRow(workerName, member, taskDesc));
					}
					content.push("");
				}
			}

			// Any workers not listed in threads
			const threadedNames = new Set(snapshot.plan.threads.flatMap((t) => t.tasks));
			const unthreaded = snapshot.members.filter((m) => !threadedNames.has(m.name));
			if (unthreaded.length > 0) {
				content.push(` ${th.fg("dim", "Unassigned workers")}`);
				for (const m of unthreaded) {
					content.push(this.formatOverviewWorkerRow(m.name, m, snapshot.plan.tasks[m.name] ?? ""));
				}
				content.push("");
			}
		} else {
			content.push(` ${th.fg("muted", "No plan.json published yet — live roster & channels summary:")}`);
			content.push("");
			content.push(` ${th.bold("Channels")}`);
			for (const ch of snapshot.channels) {
				const status = ch.archived ? th.fg("dim", " [archived]") : "";
				const topic = ch.topic ? th.fg("muted", ` - ${ch.topic}`) : "";
				content.push(`   #${ch.name}${status}${topic}`);
			}
			content.push("");
			content.push(` ${th.bold("Workers")}`);
			if (snapshot.members.length === 0) {
				content.push(`   ${th.fg("dim", "(none)")}`);
			} else {
				for (const m of snapshot.members) {
					content.push(this.formatOverviewWorkerRow(m.name, m, ""));
				}
			}
			content.push("");
		}

		// Recent board refs
		content.push(` ${th.bold("Recent Board Posts")}`);
		const recent = snapshot.messages.slice(-5);
		if (recent.length === 0) {
			content.push(`   ${th.fg("dim", "(board empty)")}`);
		} else {
			for (const msg of recent) {
				const preview = msg.text.replace(/\s+/g, " ").trim();
				const line = `   ${th.fg("accent", `#${msg.seq}`)} ${th.fg("dim", formatTimeShort(msg.timestamp))} ${th.fg("muted", `[#${msg.channel}]`)} ${th.bold(msg.author)}: ${preview}`;
				content.push(truncateToWidth(line, innerW));
			}
		}

		const maxScroll = Math.max(0, content.length - bodyHeight);
		this.overviewScroll = Math.max(0, Math.min(this.overviewScroll, maxScroll));
		return content.slice(this.overviewScroll, this.overviewScroll + bodyHeight);
	}

	private formatOverviewWorkerRow(
		workerName: string,
		member: MemberStatusSummary | undefined,
		taskDesc: string,
	): string {
		const th = this.theme;
		if (!member) {
			return `   ${th.fg("dim", "?")} ${th.bold(workerName)} ${taskDesc ? th.fg("muted", `- ${taskDesc}`) : ""}`;
		}
		const color = getStateColor(member.state);
		const glyph = th.fg(color, getStateGlyph(member.state));
		const stateStr = th.fg(color, member.state);
		const desc = taskDesc ? ` ${th.fg("muted", `- ${taskDesc}`)}` : "";
		const activity = member.currentActivity ? ` ${th.fg("dim", `(${member.currentActivity})`)}` : "";
		const err = member.lastError ? ` ${th.fg("error", `[err]`)}` : "";
		return `   ${glyph} ${th.bold(workerName)} [${stateStr}]${desc}${activity}${err}`;
	}

	private renderBoardBody(snapshot: SwarmSnapshot, innerW: number, bodyHeight: number): string[] {
		const th = this.theme;
		const chOpts = this.getChannelFilterOptions(snapshot);
		const memOpts = this.getMemberFilterOptions(snapshot);
		const activeChannel = chOpts[this.channelFilterIndex % chOpts.length];
		const activeMember = memOpts[this.memberFilterIndex % memOpts.length];
		const filtered = this.getFilteredMessages(snapshot);

		const filterBar = ` ${th.fg("muted", "Channel (c):")} ${th.fg("accent", activeChannel ? `#${activeChannel}` : "all")}  ${th.fg("muted", "Member (m):")} ${th.fg("accent", activeMember ?? "all")}  ${th.fg("dim", `(${filtered.length}/${snapshot.messages.length})`)}`;

		const feedHeight = Math.max(1, bodyHeight - 2);
		if (filtered.length === 0) {
			return [filterBar, th.fg("borderMuted", ` ${"─".repeat(Math.max(1, innerW - 2))}`), ` ${th.fg("dim", "No board messages match the current filter.")}`];
		}

		if (this.boardSelectedIndex < 0 || this.boardSelectedIndex >= filtered.length) {
			this.boardSelectedIndex = filtered.length - 1;
		}

		const renderedBlocks: Array<{ index: number; lines: string[]; startRow: number; endRow: number }> = [];
		const allFeedLines: string[] = [];
		for (let i = 0; i < filtered.length; i++) {
			const msg = filtered[i];
			const msgLines = formatMessageLine(msg, innerW, th, i === this.boardSelectedIndex);
			const startRow = allFeedLines.length;
			allFeedLines.push(...msgLines);
			renderedBlocks.push({
				index: i,
				lines: msgLines,
				startRow,
				endRow: allFeedLines.length - 1,
			});
		}

		const selectedBlock = renderedBlocks[this.boardSelectedIndex];
		const maxScroll = Math.max(0, allFeedLines.length - feedHeight);
		if (selectedBlock) {
			if (selectedBlock.startRow < this.boardScroll) {
				this.boardScroll = selectedBlock.startRow;
			} else if (selectedBlock.endRow >= this.boardScroll + feedHeight) {
				this.boardScroll = selectedBlock.endRow - feedHeight + 1;
			}
		}
		this.boardScroll = Math.max(0, Math.min(this.boardScroll, maxScroll));

		const visibleFeed = allFeedLines.slice(this.boardScroll, this.boardScroll + feedHeight);
		return [
			filterBar,
			th.fg("borderMuted", ` ${"─".repeat(Math.max(1, innerW - 2))}`),
			...visibleFeed,
		];
	}

	private renderWorkersBody(snapshot: SwarmSnapshot, innerW: number, bodyHeight: number): string[] {
		const th = this.theme;
		if (snapshot.members.length === 0) {
			return [` ${th.fg("dim", "No workers have been added to this swarm yet.")}`];
		}

		const selected = this.getSelectedWorker(snapshot)!;
		const workerListLines: string[] = [];
		for (let i = 0; i < snapshot.members.length; i++) {
			const m = snapshot.members[i];
			const isSel = i === this.workerSelectedIndex;
			const pointer = isSel ? th.fg("accent", ">") : " ";
			const color = getStateColor(m.state);
			const glyph = th.fg(color, getStateGlyph(m.state));
			const name = isSel ? th.fg("accent", th.bold(m.name)) : th.bold(m.name);
			const tok = formatTokenCount(m.usage.input + m.usage.output);
			const line = `${pointer} ${glyph} ${name} ${th.fg(color, m.state)} ${th.fg("dim", `${tok} ${formatCost(m.usage.cost)}`)}${m.lastError ? ` ${th.fg("error", "[err]")}` : ""}`;
			workerListLines.push(line);
		}

		if (innerW >= 90) {
			const leftW = 34;
			const rightW = innerW - leftW - 1;
			const detailLines = this.buildWorkerDetailLines(selected, rightW, bodyHeight);
			const out: string[] = [];
			for (let i = 0; i < bodyHeight; i++) {
				const left = padRightVisible(workerListLines[i] ?? "", leftW);
				const right = padRightVisible(detailLines[i] ?? "", rightW);
				out.push(`${left}${th.fg("borderMuted", "│")}${right}`);
			}
			return out;
		}

		// Stacked layout for narrow terminals
		const listHeight = Math.min(Math.max(3, workerListLines.length), Math.floor(bodyHeight / 3));
		const remHeight = Math.max(3, bodyHeight - listHeight - 1);
		const out: string[] = [];
		for (let i = 0; i < listHeight; i++) {
			out.push(truncateToWidth(workerListLines[i] ?? "", innerW));
		}
		out.push(th.fg("borderMuted", ` ${"─".repeat(Math.max(1, innerW - 2))}`));
		const detailLimited = this.buildWorkerDetailLines(selected, innerW, remHeight);
		for (let i = 0; i < remHeight; i++) {
			out.push(truncateToWidth(detailLimited[i] ?? "", innerW));
		}
		return out;
	}

	private buildWorkerDetailLines(
		member: MemberStatusSummary,
		paneWidth: number,
		maxRows?: number,
	): string[] {
		const th = this.theme;
		const safePaneW = Math.max(20, paneWidth);
		const color = getStateColor(member.state);
		const chList = member.channels.length > 0 ? `#main, ${member.channels.map((c) => `#${c}`).join(", ")}` : "#main";

		const header: string[] = [
			` ${th.bold(member.name)} ${th.fg(color, `[${member.state}]`)}${member.group ? th.fg("dim", ` group=${member.group}`) : ""} ${th.fg("dim", `by ${member.addedBy}`)}`,
			` ${th.fg("muted", "Model:")} ${member.model ?? "(default)"}  ${th.fg("muted", "WS:")} ${member.workspaceMode} (${member.workspacePath})`,
			` ${th.fg("muted", "Channels:")} ${chList}  ${th.fg("muted", "Usage:")} ${formatTokenCount(member.usage.input)}/${formatTokenCount(member.usage.output)} ${formatCost(member.usage.cost)} (${member.usage.turns}t)`,
		];
		if (member.currentActivity) {
			header.push(` ${th.fg("accent", "Activity:")} ${member.currentActivity}`);
		}
		if (member.lastError) {
			header.push(` ${th.fg("error", "Error:")} ${member.lastError}`);
		}
		header.push(th.fg("borderMuted", ` ${"─".repeat(Math.max(1, safePaneW - 2))}`));

		const rawTranscript = formatTranscriptMessages(
			this.manager.getWorkerMessages(member.name),
			this.manager.getWorkerLiveActivity(member.name).streamingText,
			this.manager.getWorkerLiveActivity(member.name).activeTools,
		);
		const wrappedTranscript: string[] = [];
		for (const entry of rawTranscript) {
			const wrapped = wrapTextWithAnsi(entry, Math.max(16, safePaneW - 2));
			for (const line of wrapped) {
				wrappedTranscript.push(` ${line}`);
			}
		}

		const availableRows = Math.max(3, (maxRows ?? 20) - header.length);
		const maxScroll = Math.max(0, wrappedTranscript.length - availableRows);
		if (this.workerDetailPinnedToBottom) {
			this.workerDetailScroll = maxScroll;
		} else {
			this.workerDetailScroll = Math.max(0, Math.min(this.workerDetailScroll, maxScroll));
		}

		const slice = wrappedTranscript.slice(this.workerDetailScroll, this.workerDetailScroll + availableRows);
		return [...header, ...slice].map((line) => truncateToWidth(line, safePaneW));
	}

	private renderModalLines(innerW: number): string[] {
		const th = this.theme;
		if (this.modal.kind === "confirm_kill") {
			return [
				` ${th.fg("warning", th.bold(`Kill worker "${this.modal.workerName}"?`))} ${th.fg("muted", "Permanent: disposes session and deletes share/branch workspace.")}`,
				` ${th.fg("accent", "[y/Enter]")} Confirm kill   ${th.fg("muted", "[n/Esc]")} Cancel`,
			];
		}
		if (this.modal.kind === "model_picker") {
			const lines: string[] = [
				` ${th.fg("accent", th.bold(`Switch model for "${this.modal.workerName}"`))} ${th.fg("dim", `(${this.modal.showAll ? "all available" : "scoped"} · press [a] to toggle)`)}`,
			];
			const maxShow = Math.min(6, this.modal.models.length);
			const start = Math.max(
				0,
				Math.min(
					this.modal.selectedIndex - Math.floor(maxShow / 2),
					Math.max(0, this.modal.models.length - maxShow),
				),
			);
			for (let i = start; i < start + maxShow; i++) {
				const m = this.modal.models[i];
				if (!m) continue;
				const isSel = i === this.modal.selectedIndex;
				const prefix = isSel ? th.fg("accent", " > ") : "   ";
				const label = `${m.provider}/${m.id}${m.current ? " [current]" : ""}`;
				lines.push(truncateToWidth(`${prefix}${isSel ? th.bold(label) : label}`, innerW));
			}
			lines.push(` ${th.fg("dim", "Up/Down pick · Enter switch · a toggle all · Esc cancel")}`);
			return lines;
		}
		return [];
	}

	private renderFooterHint(): string {
		const th = this.theme;
		const status = this.statusNote ? `${th.fg("warning", this.statusNote)}  ${th.fg("dim", "│")}  ` : "";
		if (this.activeTab === "overview") {
			return ` ${status}${th.fg("dim", "1-3/Tab/Left/Right tabs · Up/Down/PgUp/PgDn scroll · Esc/q close")}`;
		}
		if (this.activeTab === "board") {
			return ` ${status}${th.fg("dim", "Up/Down select · c channel · m member · r/Enter prefill #seq · Esc/q close")}`;
		}
		return ` ${status}${th.fg("dim", "Up/Down worker · PgUp/PgDn transcript · k kill · M model · S stop all · Esc/q close")}`;
	}

	invalidate(): void {
		this.cachedWidth = undefined;
		this.cachedLines = undefined;
	}

	dispose(): void {
		if (this.unsubscribe) {
			this.unsubscribe();
			this.unsubscribe = undefined;
		}
		if (this.throttleTimer) {
			clearTimeout(this.throttleTimer);
			this.throttleTimer = undefined;
		}
		this.pendingRender = false;
	}
}

/**
 * Opens the interactive 3-tab Swarm Board Overlay in TUI mode, or prints a
 * plain-text summary cleanly in non-TUI (`print` / `json` / `rpc`) modes.
 */
export async function openSwarmOverlay(
	ctx: ExtensionContext,
	manager: SwarmManager,
	options?: SwarmOverlayOptions,
): Promise<SwarmOverlayResult | undefined> {
	if (!ctx.hasUI) {
		const summary = renderSwarmPlainSummary(manager.getSnapshot());
		if (options?.writeFallback) {
			options.writeFallback(summary);
		} else {
			console.log(summary);
		}
		return undefined;
	}

	if (ctx.mode !== "tui") {
		ctx.ui.notify(renderSwarmPlainSummary(manager.getSnapshot()), "info");
		return undefined;
	}

	const result = await ctx.ui.custom<SwarmOverlayResult | undefined>(
		(tui, theme, keybindings, done) =>
			new SwarmOverlayComponent(tui, theme, keybindings, manager, ctx, done, options),
		{
			overlay: true,
			overlayOptions: {
				anchor: "center",
				width: "92%",
				minWidth: 60,
				maxHeight: "88%",
				margin: 1,
			},
			blocked: { kind: "question", message: "Swarm Board" },
		},
	);

	if (result?.kind === "prefill") {
		ctx.ui.setEditorText(result.text);
	}

	return result;
}

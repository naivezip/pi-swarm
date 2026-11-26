import type { AgentMessage } from "@earendil-works/pi-agent-core";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	type AgentSessionEvent,
	AssistantMessageComponent,
	BashExecutionComponent,
	BranchSummaryMessageComponent,
	CompactionSummaryMessageComponent,
	createBashToolDefinition,
	createEditToolDefinition,
	createFindToolDefinition,
	createGrepToolDefinition,
	createLsToolDefinition,
	createPowerShellToolDefinition,
	createReadToolDefinition,
	createWriteToolDefinition,
	CustomMessageComponent,
	getMarkdownTheme,
	parseSkillBlock,
	SkillInvocationMessageComponent,
	type Theme,
	type ToolDefinition,
	ToolExecutionComponent,
	type ToolRenderers,
	UserMessageComponent,
} from "@earendil-works/pi-coding-agent";
import {
	type Component,
	Container,
	ScrollView,
	Spacer,
	Text,
	truncateToWidth,
	type TUI,
	type TuiMouseEvent,
	type TuiMouseEventResult,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type { WorkerLiveActivity, WorkerSessionHandle } from "./runtime.ts";

const PAGE_SCROLL_OVERLAP = 4;

function extractUserText(message: AgentMessage): string {
	if (message.role !== "user") {
		return "";
	}
	if (typeof message.content === "string") {
		return message.content;
	}
	return message.content
		.filter((block): block is { type: "text"; text: string } => block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("");
}

function getBuiltInToolRenderer(toolName: string, cwd: string): ToolDefinition<any, any, any> | undefined {
	switch (toolName) {
		case "read":
			return createReadToolDefinition(cwd);
		case "edit":
			return createEditToolDefinition(cwd);
		case "write":
			return createWriteToolDefinition(cwd);
		case "bash":
			return createBashToolDefinition(cwd);
		case "powershell":
			return createPowerShellToolDefinition(cwd);
		case "grep":
			return createGrepToolDefinition(cwd);
		case "find":
			return createFindToolDefinition(cwd);
		case "ls":
			return createLsToolDefinition(cwd);
		default:
			return undefined;
	}
}

/**
 * Manages the worker transcript inside Pi's native `ScrollView` and message/tool components.
 * Supports persisted history hydration, real-time `AgentSessionEvent` streaming, `PgUp`/`PgDn` +
 * mouse-wheel scrolling with follow-to-bottom, `Ctrl+O` tool output toggle, and `Ctrl+T` thinking toggle.
 */
export class WorkerViewTranscriptController {
	readonly chatContainer: Container;
	readonly scrollView: ScrollView;

	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly getCwd: () => string;
	private readonly getSession: () => WorkerSessionHandle | undefined;

	private streamingComponent: AssistantMessageComponent | undefined;
	private streamingMessage: AssistantMessage | undefined;
	private pendingTools = new Map<string, ToolExecutionComponent>();
	private emptyHintComponent: Text | undefined;

	toolOutputExpanded = false;
	hideThinkingBlock = false;

	constructor(options: {
		tui: TUI;
		theme: Theme;
		getCwd: () => string;
		getSession: () => WorkerSessionHandle | undefined;
	}) {
		this.tui = options.tui;
		this.theme = options.theme;
		this.getCwd = options.getCwd;
		this.getSession = options.getSession;

		this.chatContainer = new Container();
		this.scrollView = new ScrollView(this.chatContainer, {
			follow: "end",
			primary: true,
			overscroll: "contain",
			scrollbar: "auto",
			scrollbarTrackStyle: (text) => this.theme.fg("scrollbarTrack", text),
			scrollbarThumbStyle: (text) => this.theme.fg("scrollbarThumb", text),
		});
	}

	private getToolRenderer(toolName: string): ToolRenderers | ToolDefinition<any, any, any> | undefined {
		const session = this.getSession();
		const cwd = this.getCwd();
		if (session?.extensionRunner) {
			return session.extensionRunner.resolveToolRenderers(
				toolName,
				() => (session.getToolDefinition?.(toolName) ?? getBuiltInToolRenderer(toolName, cwd)) as ToolRenderers | undefined,
			);
		}
		return session?.getToolDefinition?.(toolName) ?? getBuiltInToolRenderer(toolName, cwd);
	}

	private clearEmptyHint(): void {
		if (this.emptyHintComponent) {
			this.chatContainer.removeChild(this.emptyHintComponent);
			this.emptyHintComponent = undefined;
		}
	}

	private ensureEmptyHint(): void {
		if (this.chatContainer.children.length === 0) {
			this.emptyHintComponent = new Text(this.theme.fg("muted", " (No worker messages yet.)"), 1, 0);
			this.chatContainer.addChild(this.emptyHintComponent);
		}
	}

	/** Hydrates the transcript from initial persisted/live messages and optional mid-turn activity. */
	hydrate(messages: readonly AgentMessage[], liveActivity?: WorkerLiveActivity): void {
		this.chatContainer.clear();
		this.pendingTools.clear();
		this.streamingComponent = undefined;
		this.streamingMessage = undefined;
		this.emptyHintComponent = undefined;

		const renderedTools = new Map<string, ToolExecutionComponent>();
		const markdownTheme = getMarkdownTheme();

		for (const message of messages) {
			if (message.role === "user") {
				const text = extractUserText(message);
				if (!text) continue;
				if (this.chatContainer.children.length > 0) {
					this.chatContainer.addChild(new Spacer(1));
				}
				const skillBlock = parseSkillBlock(text);
				if (skillBlock) {
					const skillComponent = new SkillInvocationMessageComponent(skillBlock, markdownTheme);
					skillComponent.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(skillComponent);
					if (skillBlock.userMessage) {
						this.chatContainer.addChild(new Spacer(1));
						this.chatContainer.addChild(new UserMessageComponent(skillBlock.userMessage, markdownTheme));
					}
				} else {
					this.chatContainer.addChild(new UserMessageComponent(text, markdownTheme));
				}
			} else if (message.role === "assistant") {
				const assistantComponent = new AssistantMessageComponent(
					message,
					this.hideThinkingBlock,
					markdownTheme,
				);
				this.chatContainer.addChild(assistantComponent);
				for (const block of message.content) {
					if (block.type !== "toolCall") continue;
					const toolComp = new ToolExecutionComponent(
						block.name,
						block.id,
						block.arguments,
						{},
						this.getToolRenderer(block.name),
						this.tui,
						this.getCwd(),
					);
					toolComp.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(toolComp);
					if (message.stopReason === "aborted" || message.stopReason === "error") {
						toolComp.updateResult({
							content: [{ type: "text", text: message.errorMessage || (message.stopReason === "aborted" ? "Operation aborted" : "Error") }],
							isError: true,
						});
					} else {
						renderedTools.set(block.id, toolComp);
					}
				}
			} else if (message.role === "toolResult") {
				const toolComp = renderedTools.get(message.toolCallId);
				if (toolComp) {
					toolComp.updateResult({
						content: message.content,
						details: message.details,
						isError: message.isError,
					});
					renderedTools.delete(message.toolCallId);
				}
			} else if (message.role === "custom") {
				if (message.display) {
					const renderer = this.getSession()?.extensionRunner?.getMessageRenderer(message.customType);
					const comp = new CustomMessageComponent(message, renderer, markdownTheme);
					comp.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(comp);
				}
			} else if (message.role === "bashExecution") {
				const comp = new BashExecutionComponent(message.command, this.tui, message.excludeFromContext);
				if (message.output) {
					comp.appendOutput(message.output);
				}
				comp.setComplete(message.exitCode, message.cancelled, undefined, message.fullOutputPath);
				this.chatContainer.addChild(comp);
			} else if (message.role === "compactionSummary") {
				this.chatContainer.addChild(new Spacer(1));
				const comp = new CompactionSummaryMessageComponent(message, markdownTheme);
				comp.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(comp);
			} else if (message.role === "branchSummary") {
				this.chatContainer.addChild(new Spacer(1));
				const comp = new BranchSummaryMessageComponent(message, markdownTheme);
				comp.setExpanded(this.toolOutputExpanded);
				this.chatContainer.addChild(comp);
			}
		}

		// Re-seed pending tool execution placeholders if view opened mid-turn
		for (const [id, comp] of renderedTools) {
			this.pendingTools.set(id, comp);
		}
		if (liveActivity?.streamingText && !this.streamingComponent) {
			const partialMsg: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: liveActivity.streamingText }],
				api: "anthropic-messages",
				provider: "unknown",
				model: "unknown",
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				stopReason: "stop",
				timestamp: Date.now(),
			};
			this.streamingComponent = new AssistantMessageComponent(partialMsg, this.hideThinkingBlock, markdownTheme);
			this.streamingMessage = partialMsg;
			this.streamingComponent.updateContent(partialMsg, true);
			this.chatContainer.addChild(this.streamingComponent);
		}

		this.ensureEmptyHint();
		this.scrollView.scrollToEnd();
	}

	/** Applies a live `AgentSessionEvent` from the worker session. */
	handleEvent(event: AgentSessionEvent): boolean {
		const markdownTheme = getMarkdownTheme();
		switch (event.type) {
			case "message_start": {
				this.clearEmptyHint();
				if (event.message.role === "user") {
					const text = extractUserText(event.message);
					if (text) {
						if (this.chatContainer.children.length > 0) {
							this.chatContainer.addChild(new Spacer(1));
						}
						this.chatContainer.addChild(new UserMessageComponent(text, markdownTheme));
					}
					return true;
				}
				if (event.message.role === "custom" && event.message.display) {
					const renderer = this.getSession()?.extensionRunner?.getMessageRenderer(event.message.customType);
					const comp = new CustomMessageComponent(event.message, renderer, markdownTheme);
					comp.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(comp);
					return true;
				}
				if (event.message.role === "assistant") {
					if (this.streamingComponent) {
						this.chatContainer.removeChild(this.streamingComponent);
					}
					this.streamingComponent = new AssistantMessageComponent(
						undefined,
						this.hideThinkingBlock,
						markdownTheme,
					);
					this.streamingMessage = event.message;
					this.chatContainer.addChild(this.streamingComponent);
					this.streamingComponent.updateContent(event.message, true);
					return true;
				}
				return false;
			}
			case "message_update": {
				if (event.message.role !== "assistant") {
					return false;
				}
				this.clearEmptyHint();
				if (!this.streamingComponent) {
					this.streamingComponent = new AssistantMessageComponent(
						undefined,
						this.hideThinkingBlock,
						markdownTheme,
					);
					this.chatContainer.addChild(this.streamingComponent);
				}
				this.streamingMessage = event.message;
				this.streamingComponent.updateContent(event.message, true);
				for (const block of event.message.content) {
					if (block.type !== "toolCall") continue;
					const existing = this.pendingTools.get(block.id);
					if (!existing) {
						const comp = new ToolExecutionComponent(
							block.name,
							block.id,
							block.arguments,
							{},
							this.getToolRenderer(block.name),
							this.tui,
							this.getCwd(),
						);
						comp.setExpanded(this.toolOutputExpanded);
						this.chatContainer.addChild(comp);
						this.pendingTools.set(block.id, comp);
					} else {
						existing.updateArgs(block.arguments);
					}
				}
				return true;
			}
			case "message_end": {
				if (event.message.role === "user") {
					return false;
				}
				if (event.message.role === "assistant") {
					this.clearEmptyHint();
					if (!this.streamingComponent) {
						this.streamingComponent = new AssistantMessageComponent(
							undefined,
							this.hideThinkingBlock,
							markdownTheme,
						);
						this.chatContainer.addChild(this.streamingComponent);
					}
					this.streamingMessage = event.message;
					this.streamingComponent.updateContent(event.message, false);
					if (event.message.stopReason === "aborted" || event.message.stopReason === "error") {
						const errorText = event.message.errorMessage || (event.message.stopReason === "aborted" ? "Operation aborted" : "Error");
						for (const comp of this.pendingTools.values()) {
							comp.updateResult({ content: [{ type: "text", text: errorText }], isError: true });
						}
						this.pendingTools.clear();
					} else {
						for (const comp of this.pendingTools.values()) {
							comp.setArgsComplete();
						}
					}
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
					return true;
				}
				return false;
			}
			case "tool_execution_start": {
				if (event.parentToolCallId) return false;
				this.clearEmptyHint();
				let comp = this.pendingTools.get(event.toolCallId);
				if (!comp) {
					comp = new ToolExecutionComponent(
						event.toolName,
						event.toolCallId,
						event.args,
						{},
						this.getToolRenderer(event.toolName),
						this.tui,
						this.getCwd(),
					);
					comp.setExpanded(this.toolOutputExpanded);
					this.chatContainer.addChild(comp);
					this.pendingTools.set(event.toolCallId, comp);
				}
				comp.markExecutionStarted();
				return true;
			}
			case "tool_execution_update": {
				const comp = this.pendingTools.get(event.toolCallId);
				if (comp) {
					comp.updateResult({ ...event.partialResult, isError: false }, true);
					return true;
				}
				return false;
			}
			case "tool_execution_end": {
				const comp = this.pendingTools.get(event.toolCallId);
				if (comp) {
					comp.updateResult({ ...event.result, isError: event.isError, durationMs: event.durationMs }, false);
					this.pendingTools.delete(event.toolCallId);
					return true;
				}
				return false;
			}
			case "agent_end": {
				if (this.streamingComponent && this.streamingMessage) {
					this.streamingComponent.updateContent(this.streamingMessage, false);
					this.streamingComponent = undefined;
					this.streamingMessage = undefined;
				}
				this.pendingTools.clear();
				return true;
			}
			default:
				return false;
		}
	}

	/** Toggles expanded output on all tool and custom/summary components (`Ctrl+O`). */
	toggleToolsExpanded(): boolean {
		this.toolOutputExpanded = !this.toolOutputExpanded;
		for (const child of this.chatContainer.children) {
			if (
				child instanceof ToolExecutionComponent ||
				child instanceof CustomMessageComponent ||
				child instanceof CompactionSummaryMessageComponent ||
				child instanceof BranchSummaryMessageComponent ||
				child instanceof SkillInvocationMessageComponent
			) {
				child.setExpanded(this.toolOutputExpanded);
			}
		}
		for (const comp of this.pendingTools.values()) {
			comp.setExpanded(this.toolOutputExpanded);
		}
		return this.toolOutputExpanded;
	}

	/** Toggles thinking block visibility on all assistant messages (`Ctrl+T`). */
	toggleThinkingHidden(): boolean {
		this.hideThinkingBlock = !this.hideThinkingBlock;
		for (const child of this.chatContainer.children) {
			if (child instanceof AssistantMessageComponent) {
				child.setHideThinkingBlock(this.hideThinkingBlock);
			}
		}
		this.streamingComponent?.setHideThinkingBlock(this.hideThinkingBlock);
		return this.hideThinkingBlock;
	}

	scrollPage(direction: -1 | 1): void {
		const step = Math.max(1, this.scrollView.viewportHeight - PAGE_SCROLL_OVERLAP);
		this.scrollView.scrollBy(direction * step);
	}

	scrollBy(lines: number): void {
		this.scrollView.scrollBy(lines);
	}

	scrollToStart(): void {
		this.scrollView.scrollToStart();
	}

	scrollToEnd(): void {
		this.scrollView.scrollToEnd();
	}

	/** Renders the visible transcript slice and updates `ScrollView` layout/follow-to-bottom state. */
	renderViewport(width: number, viewportHeight: number): string[] {
		const safeWidth = Math.max(10, width);
		const safeHeight = Math.max(1, viewportHeight);
		const contentWidth = this.scrollView.getContentWidth(safeWidth);
		const allLines = this.scrollView.render(safeWidth);
		this.scrollView.updateLayout(allLines.length, safeHeight, () => this.tui.requestRender());

		const start = this.scrollView.scrollTop;
		const visible = allLines.slice(start, start + safeHeight);
		const padded: string[] = [...visible];
		while (padded.length < safeHeight) {
			padded.push("");
		}

		if (this.scrollView.isScrollbarVisible && allLines.length > safeHeight && safeWidth > 1) {
			const maxScroll = Math.max(1, allLines.length - safeHeight);
			const thumbHeight = Math.max(1, Math.min(safeHeight, Math.round((safeHeight * safeHeight) / allLines.length)));
			const maxThumbTop = safeHeight - thumbHeight;
			const thumbTop = Math.round((start / maxScroll) * maxThumbTop);
			const textWidth = Math.max(1, safeWidth - 1);
			for (let row = 0; row < safeHeight; row++) {
				const isThumb = row >= thumbTop && row < thumbTop + thumbHeight;
				const barChar = isThumb ? this.theme.fg("accent", "┃") : this.theme.fg("dim", "│");
				const line = padded[row] ?? "";
				const clipped = truncateToWidth(line, textWidth, "", true);
				const reset = clipped.includes("\x1b") ? "\x1b[0m" : "";
				padded[row] = `${clipped}${reset}${barChar}`;
			}
		}

		return padded;
	}

	handleMouse(event: TuiMouseEvent, transcriptTopRow: number, transcriptHeight: number): TuiMouseEventResult | undefined {
		if (event.type === "wheel") {
			const delta = event.wheelDelta ?? (event.y < transcriptTopRow + transcriptHeight / 2 ? -3 : 3);
			this.scrollView.scrollBy(delta);
			return { handled: true, render: true };
		}
		if (event.y >= transcriptTopRow && event.y < transcriptTopRow + transcriptHeight) {
			const childY = event.y - transcriptTopRow + this.scrollView.scrollTop;
			let runningY = 0;
			for (const child of this.chatContainer.children as Component[]) {
				const h = child.render(event.width).length;
				if (childY >= runningY && childY < runningY + h) {
					const res = child.handleMouse?.({
						...event,
						y: childY - runningY,
						height: h,
					});
					if (res?.handled) {
						return res;
					}
					break;
				}
				runningY += h;
			}
		}
		return undefined;
	}
}

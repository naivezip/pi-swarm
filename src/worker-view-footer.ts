import { homedir } from "node:os";
import type { AgentSession, ExtensionContext, ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { FooterComponent } from "@earendil-works/pi-coding-agent";
import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SwarmSnapshot, WorkerSessionHandle } from "./runtime.ts";
import type { BackgroundProcessSummary, MemberStatusSummary } from "./types.ts";
import { formatCost, formatTokenCount } from "./ui.ts";

function formatWorkspacePath(workspacePath: string): string {
	const home = process.env.HOME || process.env.USERPROFILE || homedir();
	if (home && workspacePath.startsWith(home)) {
		const rest = workspacePath.slice(home.length);
		if (rest === "" || rest.startsWith("/") || rest.startsWith("\\")) {
			return `~${rest}`;
		}
	}
	return workspacePath;
}

function getWorkerActiveProcesses(
	snapshot: SwarmSnapshot,
	member: MemberStatusSummary | undefined,
	workerName: string,
): BackgroundProcessSummary[] {
	const fromMember = member?.backgroundProcesses ?? [];
	const fromSnapshot = (snapshot.backgroundProcesses ?? []).filter((p) => p.ownerWorker === workerName);
	const list = fromMember.length > 0 ? fromMember : fromSnapshot;
	return list.filter((p) => p.state === "running");
}

function adaptWorkerSessionForFooter(handle: WorkerSessionHandle, member: MemberStatusSummary): AgentSession {
	const sm = handle.sessionManager as ExtensionContext["sessionManager"] & {
		getEntryCount?: () => number;
	};
	const safeSessionManager = {
		getEntryCount: () =>
			typeof sm?.getEntryCount === "function"
				? sm.getEntryCount()
				: typeof sm?.getEntries === "function"
					? sm.getEntries().length
					: 0,
		getSessionId: () => (typeof sm?.getSessionId === "function" ? sm.getSessionId() : handle.sessionId),
		getLeafId: () => (typeof sm?.getLeafId === "function" ? sm.getLeafId() : null),
		getEntries: () => (typeof sm?.getEntries === "function" ? sm.getEntries() : []),
		getCwd: () => (typeof sm?.getCwd === "function" ? sm.getCwd() : member.workspacePath),
		getSessionName: () => (typeof sm?.getSessionName === "function" ? sm.getSessionName() : handle.sessionName),
	};

	return {
		sessionManager: safeSessionManager,
		model: handle.model,
		routedModel: handle.routedModel,
		state: handle.state ?? {
			model: handle.model,
			thinkingLevel: handle.thinkingLevel ?? "off",
		},
		modelRuntime: handle.modelRuntime ?? {
			isUsingSubscription: () => false,
		},
		getContextUsage: () => (typeof handle.getContextUsage === "function" ? handle.getContextUsage() : undefined),
	} as unknown as AgentSession;
}

function createWorkerFooterDataProvider(options: {
	ctx: ExtensionContext;
	getMember: () => MemberStatusSummary | undefined;
	getBackgroundProcesses: () => BackgroundProcessSummary[];
}): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => options.getMember()?.workspaceBranch ?? null,
		getExtensionStatuses: () => {
			const statuses = new Map<string, string>();
			const procs = options.getBackgroundProcesses();
			if (procs.length > 0) {
				statuses.set("bg", `${procs.length} bg`);
			}
			return statuses;
		},
		getAvailableProviderCount: () => {
			try {
				const available = options.ctx.modelRegistry?.getAvailable?.() ?? [];
				return new Set(available.map((m) => m.provider)).size;
			} catch {
				return 1;
			}
		},
		onBranchChange: () => () => {},
	};
}

/**
 * Renders the bottom status footer for the worker view:
 * - Reuses Pi's native `FooterComponent` when a live `WorkerSessionHandle` is attached.
 * - Renders a matching fallback footer (workspace, usage/cost, model, background processes)
 *   when the worker is `stopped`, `killed`, or detached.
 */
export class WorkerViewFooterController implements Component {
	private readonly theme: Theme;
	private readonly ctx: ExtensionContext;
	private readonly workerName: string;
	private readonly getSnapshot: () => SwarmSnapshot;
	private readonly getSession: () => WorkerSessionHandle | undefined;
	private readonly footerData: ReadonlyFooterDataProvider;

	private nativeFooter: FooterComponent | undefined;
	private boundSession: WorkerSessionHandle | undefined;

	constructor(options: {
		theme: Theme;
		ctx: ExtensionContext;
		workerName: string;
		getSnapshot: () => SwarmSnapshot;
		getSession: () => WorkerSessionHandle | undefined;
	}) {
		this.theme = options.theme;
		this.ctx = options.ctx;
		this.workerName = options.workerName;
		this.getSnapshot = options.getSnapshot;
		this.getSession = options.getSession;
		this.footerData = createWorkerFooterDataProvider({
			ctx: this.ctx,
			getMember: () => this.getSnapshot().members.find((m) => m.name === this.workerName),
			getBackgroundProcesses: () => {
				const snap = this.getSnapshot();
				const member = snap.members.find((m) => m.name === this.workerName);
				return getWorkerActiveProcesses(snap, member, this.workerName);
			},
		});
	}

	private syncNativeFooter(member: MemberStatusSummary | undefined): FooterComponent | undefined {
		const session = this.getSession();
		if (!session || !member || member.state === "stopped" || member.state === "killed") {
			if (this.nativeFooter) {
				this.nativeFooter.dispose();
				this.nativeFooter = undefined;
				this.boundSession = undefined;
			}
			return undefined;
		}

		if (this.nativeFooter && this.boundSession === session) {
			return this.nativeFooter;
		}

		const adapted = adaptWorkerSessionForFooter(session, member);
		if (!this.nativeFooter) {
			this.nativeFooter = new FooterComponent(adapted, this.footerData);
			if (session.autoCompactionEnabled !== undefined) {
				this.nativeFooter.setAutoCompactEnabled(session.autoCompactionEnabled);
			}
		} else {
			this.nativeFooter.setSession(adapted);
		}
		this.boundSession = session;
		return this.nativeFooter;
	}

	invalidate(): void {
		this.nativeFooter?.invalidate();
	}

	dispose(): void {
		this.nativeFooter?.dispose();
		this.nativeFooter = undefined;
		this.boundSession = undefined;
	}

	render(width: number): string[] {
		const safeWidth = Math.max(10, width);
		const snap = this.getSnapshot();
		const member = snap.members.find((m) => m.name === this.workerName);

		const footer = this.syncNativeFooter(member);
		if (footer) {
			return [...footer.render(safeWidth)];
		}

		return this.renderFallbackFooter(safeWidth, snap, member);
	}

	private renderFallbackFooter(
		width: number,
		snapshot: SwarmSnapshot,
		member: MemberStatusSummary | undefined,
	): string[] {
		const th = this.theme;
		const workspace = formatWorkspacePath(member?.workspacePath ?? snapshot.cwd);
		const branchPart = member?.workspaceBranch ? ` (${member.workspaceBranch})` : "";
		const stateTag = member ? ` • [${member.state}]` : " • [unavailable]";
		const line1 = truncateToWidth(th.fg("dim", `${workspace}${branchPart}${stateTag}`), width, "...");

		const usage = member?.usage;
		const leftParts: string[] = [];
		if (usage) {
			if (usage.input > 0) leftParts.push(`↑${formatTokenCount(usage.input)}`);
			if (usage.output > 0) leftParts.push(`↓${formatTokenCount(usage.output)}`);
			if (usage.cacheRead > 0) leftParts.push(`R${formatTokenCount(usage.cacheRead)}`);
			if (usage.cacheWrite > 0) leftParts.push(`W${formatTokenCount(usage.cacheWrite)}`);
			leftParts.push(formatCost(usage.cost));
			leftParts.push(`${usage.turns}t`);
		} else {
			leftParts.push("$0.00");
		}
		const bgProcs = getWorkerActiveProcesses(snapshot, member, this.workerName);
		if (bgProcs.length > 0) {
			leftParts.push(`${bgProcs.length} bg`);
		}
		const leftText = leftParts.join(" ");
		const rightText = member?.model ?? "no-model";

		const leftWidth = visibleWidth(leftText);
		const rightWidth = visibleWidth(rightText);
		let line2Raw: string;
		if (leftWidth + 2 + rightWidth <= width) {
			line2Raw = `${leftText}${" ".repeat(width - leftWidth - rightWidth)}${rightText}`;
		} else {
			line2Raw = truncateToWidth(`${leftText}  ${rightText}`, width, "...");
		}

		return [line1, th.fg("dim", line2Raw)];
	}
}

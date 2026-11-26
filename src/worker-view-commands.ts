import {
	DynamicBorder,
	type ExtensionContext,
	getSelectListTheme,
	type KeybindingsManager as AppKeybindingsManager,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteItem,
	Container,
	type Focusable,
	fuzzyFilter,
	Input,
	type KeybindingsManager as TuiKeybindingsManager,
	matchesKey,
	type SlashCommand,
	Spacer,
	Text,
	type TUI,
	truncateToWidth,
} from "@earendil-works/pi-tui";
import type { ModelInfoEntry, SwarmManager } from "./runtime.ts";

export const WORKER_BUILT_IN_COMMAND_NAMES = ["model", "abort", "kill", "exit"] as const;
export type WorkerBuiltInCommandName = (typeof WORKER_BUILT_IN_COMMAND_NAMES)[number];

export interface ParsedWorkerSlashCommand {
	name: string;
	args: string;
	raw: string;
}

/**
 * Parses a leading slash command from trimmed user input.
 * Returns `null` when the input does not start with `/`.
 */
export function parseWorkerSlashCommand(text: string): ParsedWorkerSlashCommand | null {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) {
		return null;
	}
	const body = trimmed.slice(1);
	const spaceIdx = body.search(/\s/);
	if (spaceIdx === -1) {
		return {
			name: body.toLowerCase(),
			args: "",
			raw: trimmed,
		};
	}
	return {
		name: body.slice(0, spaceIdx).toLowerCase(),
		args: body.slice(spaceIdx + 1).trim(),
		raw: trimmed,
	};
}

/**
 * Returns the 4 built-in worker-view slash commands for `CombinedAutocompleteProvider`.
 * Explicitly excludes `/board`, `!bash`, and `/compact`.
 */
export function createWorkerSlashCommands(options: {
	getModels: () => ModelInfoEntry[];
}): SlashCommand[] {
	return [
		{
			name: "model",
			description: "Switch this worker's model (waiting or stopped only)",
			argumentHint: "[provider/model-id]",
			getArgumentCompletions(argumentPrefix: string): AutocompleteItem[] | null {
				const models = options.getModels();
				if (models.length === 0) {
					return null;
				}
				const q = argumentPrefix.trim().toLowerCase();
				const items: AutocompleteItem[] = models
					.map((m) => {
						const ref = `${m.provider}/${m.id}`;
						return {
							value: ref,
							label: m.current ? `${ref} [current]` : ref,
							description: m.name !== ref ? m.name : undefined,
						};
					})
					.filter((item) => !q || item.value.toLowerCase().includes(q) || (item.description?.toLowerCase().includes(q) ?? false));
				return items.length > 0 ? items : null;
			},
		},
		{
			name: "abort",
			description: "Abort only this worker's active turn",
		},
		{
			name: "kill",
			description: "Permanently kill this worker (with confirmation)",
		},
		{
			name: "exit",
			description: "Return to Coordinator UI without interrupting worker",
		},
	];
}

const MAX_MODEL_PICKER_VISIBLE = 8;

/**
 * Pi-style interactive model picker scoped to a single swarm worker.
 * Supports fuzzy filtering, `Tab` scope toggle (`scoped` vs `all`), `Up`/`Down`/`PgUp`/`PgDn`,
 * `Enter` to select, and `Esc` to cancel without affecting the worker.
 */
export class WorkerModelPickerComponent extends Container implements Focusable {
	readonly capturesViewportInput = true;
	private readonly tui: TUI;
	private readonly theme: Theme;
	private readonly keybindings: TuiKeybindingsManager | AppKeybindingsManager;
	private readonly workerName: string;
	private readonly manager: SwarmManager;
	private readonly ctx: ExtensionContext;
	private readonly currentModelRef: string | undefined;
	private readonly onSelect: (modelRef: string) => void;
	private readonly onCancel: () => void;

	private readonly searchInput: Input;
	private readonly scopeText: Text;
	private readonly listContainer: Container;

	private showAll: boolean;
	private allModels: ModelInfoEntry[] = [];
	private filteredModels: ModelInfoEntry[] = [];
	private selectedIndex = 0;

	private _focused = false;
	get focused(): boolean {
		return this._focused;
	}
	set focused(value: boolean) {
		this._focused = value;
		this.searchInput.focused = value;
	}

	constructor(options: {
		tui: TUI;
		theme: Theme;
		keybindings: TuiKeybindingsManager | AppKeybindingsManager;
		workerName: string;
		manager: SwarmManager;
		ctx: ExtensionContext;
		currentModelRef?: string;
		initialFilter?: string;
		onSelect: (modelRef: string) => void;
		onCancel: () => void;
	}) {
		super();
		this.tui = options.tui;
		this.theme = options.theme;
		this.keybindings = options.keybindings;
		this.workerName = options.workerName;
		this.manager = options.manager;
		this.ctx = options.ctx;
		this.currentModelRef = options.currentModelRef;
		this.onSelect = options.onSelect;
		this.onCancel = options.onCancel;

		const scoped = this.manager.listModels({ all: false, ctx: this.ctx });
		const all = this.manager.listModels({ all: true, ctx: this.ctx });
		this.showAll = scoped.length === 0 || (scoped.length === all.length && (this.ctx.scopedModels?.length ?? 0) === 0);

		const th = this.theme;
		this.addChild(new DynamicBorder((s) => th.fg("accent", s)));
		this.addChild(
			new Text(
				` ${th.fg("accent", th.bold(`Switch model for "${this.workerName}"`))} ${th.fg("dim", "(waiting/stopped only)")}`,
				0,
				0,
			),
		);
		this.scopeText = new Text(this.formatScopeLine(), 0, 0);
		this.addChild(this.scopeText);
		this.addChild(new Spacer(1));

		this.searchInput = new Input();
		if (options.initialFilter) {
			this.searchInput.setValue(options.initialFilter);
		}
		this.searchInput.onSubmit = () => {
			const chosen = this.filteredModels[this.selectedIndex];
			if (chosen) {
				this.onSelect(`${chosen.provider}/${chosen.id}`);
			}
		};
		this.addChild(this.searchInput);
		this.addChild(new Spacer(1));

		this.listContainer = new Container();
		this.addChild(this.listContainer);
		this.addChild(new Spacer(1));
		this.addChild(
			new Text(
				` ${th.fg("dim", "Up/Down pick · Tab scope (scoped/all) · Enter apply · Esc cancel")}`,
				0,
				0,
			),
		);
		this.addChild(new DynamicBorder((s) => th.fg("accent", s)));

		this.reloadModels(options.initialFilter ?? "");
	}

	private formatScopeLine(): string {
		const th = this.theme;
		const scopedStyle = !this.showAll ? th.fg("accent", "scoped") : th.fg("muted", "scoped");
		const allStyle = this.showAll ? th.fg("accent", "all") : th.fg("muted", "all");
		return ` ${th.fg("muted", "Scope:")} ${scopedStyle} ${th.fg("dim", "|")} ${allStyle} ${th.fg("dim", "(Tab to toggle)")}`;
	}

	private reloadModels(query: string): void {
		const list = this.manager.listModels({ all: this.showAll, ctx: this.ctx });
		this.allModels = list.map((m) => ({
			...m,
			current: this.currentModelRef ? `${m.provider}/${m.id}` === this.currentModelRef : m.current,
		}));
		this.allModels.sort((a, b) => {
			if (a.current && !b.current) return -1;
			if (!a.current && b.current) return 1;
			return `${a.provider}/${a.id}`.localeCompare(`${b.provider}/${b.id}`);
		});
		this.scopeText.setText(this.formatScopeLine());
		this.applyFilter(query);
	}

	private applyFilter(query: string): void {
		const trimmed = query.trim();
		if (!trimmed) {
			this.filteredModels = [...this.allModels];
		} else {
			this.filteredModels = fuzzyFilter(
				this.allModels,
				trimmed,
				(m) => `${m.provider}/${m.id} ${m.name}`,
			);
		}
		const currentIdx = trimmed
			? 0
			: Math.max(
					0,
					this.filteredModels.findIndex((m) => m.current),
				);
		this.selectedIndex = Math.max(0, Math.min(currentIdx, Math.max(0, this.filteredModels.length - 1)));
		this.rebuildList();
	}

	private rebuildList(): void {
		this.listContainer.clear();
		const th = this.theme;
		const selectTheme = getSelectListTheme();

		if (this.filteredModels.length === 0) {
			this.listContainer.addChild(new Text(` ${selectTheme.noMatch("No matching models available.")}`, 0, 0));
			return;
		}

		const total = this.filteredModels.length;
		const maxShow = Math.min(MAX_MODEL_PICKER_VISIBLE, total);
		const start = Math.max(0, Math.min(this.selectedIndex - Math.floor(maxShow / 2), total - maxShow));
		const end = Math.min(total, start + maxShow);

		for (let i = start; i < end; i++) {
			const m = this.filteredModels[i]!;
			const isSelected = i === this.selectedIndex;
			const ref = `${m.provider}/${m.id}`;
			const currentTag = m.current ? th.fg("success", " [current]") : "";
			const desc = m.name && m.name !== ref ? selectTheme.description(` · ${m.name}`) : "";
			const prefix = isSelected ? selectTheme.selectedPrefix(" → ") : "   ";
			const label = isSelected ? selectTheme.selectedText(ref) : ref;
			this.listContainer.addChild(
				new Text(`${prefix}${label}${currentTag}${desc}`, 0, 0),
			);
		}

		if (total > maxShow) {
			this.listContainer.addChild(
				new Text(` ${selectTheme.scrollInfo(`(${this.selectedIndex + 1}/${total})`)}`, 0, 0),
			);
		}
	}

	handleInput(data: string): void {
		if (
			matchesKey(data, "escape") ||
			this.keybindings.matches(data, "tui.select.cancel") ||
			this.keybindings.matches(data, "app.interrupt")
		) {
			this.onCancel();
			return;
		}
		if (matchesKey(data, "tab") || this.keybindings.matches(data, "tui.input.tab")) {
			this.showAll = !this.showAll;
			this.reloadModels(this.searchInput.getValue());
			this.tui.requestRender();
			return;
		}
		if (matchesKey(data, "up") || this.keybindings.matches(data, "tui.select.up")) {
			if (this.filteredModels.length > 0) {
				this.selectedIndex = (this.selectedIndex - 1 + this.filteredModels.length) % this.filteredModels.length;
				this.rebuildList();
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "down") || this.keybindings.matches(data, "tui.select.down")) {
			if (this.filteredModels.length > 0) {
				this.selectedIndex = (this.selectedIndex + 1) % this.filteredModels.length;
				this.rebuildList();
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "pageUp") || this.keybindings.matches(data, "tui.select.pageUp")) {
			if (this.filteredModels.length > 0) {
				this.selectedIndex = Math.max(0, this.selectedIndex - MAX_MODEL_PICKER_VISIBLE);
				this.rebuildList();
				this.tui.requestRender();
			}
			return;
		}
		if (matchesKey(data, "pageDown") || this.keybindings.matches(data, "tui.select.pageDown")) {
			if (this.filteredModels.length > 0) {
				this.selectedIndex = Math.min(this.filteredModels.length - 1, this.selectedIndex + MAX_MODEL_PICKER_VISIBLE);
				this.rebuildList();
				this.tui.requestRender();
			}
			return;
		}
		if (
			matchesKey(data, "enter") ||
			matchesKey(data, "return") ||
			this.keybindings.matches(data, "tui.select.confirm")
		) {
			const chosen = this.filteredModels[this.selectedIndex];
			if (chosen) {
				this.onSelect(`${chosen.provider}/${chosen.id}`);
			}
			return;
		}

		const prev = this.searchInput.getValue();
		this.searchInput.handleInput(data);
		const next = this.searchInput.getValue();
		if (next !== prev) {
			this.applyFilter(next);
		}
		this.tui.requestRender();
	}

	override render(width: number): string[] {
		return super.render(width).map((line) => truncateToWidth(line, width));
	}
}

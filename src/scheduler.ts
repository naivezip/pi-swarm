import {
	type ManageTaskInput,
	type ManageTaskResult,
	type ScheduledTaskRecord,
	type ScheduleInput,
	type ScheduleResult,
} from "./types.ts";

export interface ParsedCron {
	minutes: Set<number>;
	hours: Set<number>;
	daysOfMonth: Set<number>;
	months: Set<number>;
	daysOfWeek: Set<number>;
	domRestricted: boolean;
	dowRestricted: boolean;
}

export interface SwarmSchedulerOptions {
	onTrigger: (task: ScheduledTaskRecord) => void | Promise<void>;
	isTargetBusy?: (workerName: string) => boolean;
	now?: () => number;
}

const MAX_TIMEOUT_MS = 0x7fffffff;

function parseCronField(field: string, min: number, max: number, normalizeSevenToZero = false): Set<number> {
	const result = new Set<number>();
	const parts = field.split(",");
	for (const part of parts) {
		if (part.length === 0) {
			throw new Error(`Invalid empty cron segment in "${field}".`);
		}
		const [rangePart, stepPart, ...extra] = part.split("/");
		if (extra.length > 0) {
			throw new Error(`Invalid cron step syntax in "${part}".`);
		}
		const step = stepPart !== undefined ? Number(stepPart) : 1;
		if (!Number.isInteger(step) || step <= 0) {
			throw new Error(`Invalid cron step "${stepPart}" in "${part}".`);
		}

		let start: number;
		let end: number;

		if (rangePart === "*") {
			start = min;
			end = max;
		} else if (rangePart.includes("-")) {
			const bounds = rangePart.split("-");
			if (bounds.length !== 2) {
				throw new Error(`Invalid cron range "${rangePart}".`);
			}
			start = Number(bounds[0]);
			end = Number(bounds[1]);
			if (!Number.isInteger(start) || !Number.isInteger(end) || start > end) {
				throw new Error(`Invalid cron range bounds in "${rangePart}".`);
			}
		} else {
			const exact = Number(rangePart);
			if (!Number.isInteger(exact)) {
				throw new Error(`Invalid cron value "${rangePart}".`);
			}
			start = exact;
			// "N/step" means starting at N through max; plain "N" is just N.
			end = stepPart !== undefined ? max : exact;
		}

		if (start < min || end > max) {
			throw new Error(`Cron value out of range [${min}..${max}] in "${part}".`);
		}

		for (let value = start; value <= end; value += step) {
			result.add(normalizeSevenToZero && value === 7 ? 0 : value);
		}
	}

	if (result.size === 0) {
		throw new Error(`Cron field "${field}" matched no values.`);
	}
	return result;
}

/** Parses and validates a standard 5-field cron expression (`minute hour dom month dow`). */
export function parseCronExpression(expr: string): ParsedCron {
	const fields = expr.trim().split(/\s+/);
	if (fields.length !== 5) {
		throw new Error(`CronExpression must have 5 whitespace-separated fields, got ${fields.length}: "${expr}".`);
	}
	const [minField, hourField, domField, monthField, dowField] = fields;
	return {
		minutes: parseCronField(minField, 0, 59),
		hours: parseCronField(hourField, 0, 23),
		daysOfMonth: parseCronField(domField, 1, 31),
		months: parseCronField(monthField, 1, 12),
		daysOfWeek: parseCronField(dowField, 0, 7, true),
		domRestricted: domField !== "*",
		dowRestricted: dowField !== "*",
	};
}

function matchesCron(parsed: ParsedCron, date: Date): boolean {
	const minute = date.getMinutes();
	const hour = date.getHours();
	const dom = date.getDate();
	const month = date.getMonth() + 1;
	const dow = date.getDay();

	if (!parsed.minutes.has(minute) || !parsed.hours.has(hour) || !parsed.months.has(month)) {
		return false;
	}

	const domMatches = parsed.daysOfMonth.has(dom);
	const dowMatches = parsed.daysOfWeek.has(dow);

	if (parsed.domRestricted && parsed.dowRestricted) {
		return domMatches || dowMatches;
	}
	return domMatches && dowMatches;
}

/** Computes the next wall-clock timestamp (ms) strictly after `afterMs` matching `expr`. */
export function getNextCronRun(expr: string, afterMs = Date.now()): number {
	const parsed = parseCronExpression(expr);
	// Advance to the start of the next whole minute.
	const candidate = new Date(afterMs);
	candidate.setSeconds(0, 0);
	candidate.setMinutes(candidate.getMinutes() + 1);

	// Scan up to 4 years of minutes (~2.1M) to guarantee termination even for Feb 29 schedules.
	const maxMinutes = 366 * 4 * 24 * 60;
	for (let i = 0; i < maxMinutes; i++) {
		if (matchesCron(parsed, candidate)) {
			return candidate.getTime();
		}
		candidate.setMinutes(candidate.getMinutes() + 1);
	}
	throw new Error(`No matching run time found within 4 years for cron expression "${expr}".`);
}

interface InternalTask {
	record: ScheduledTaskRecord;
	timer?: ReturnType<typeof setTimeout>;
	coalescedPending: boolean;
	inFlight: boolean;
}

/** Lightweight timer and 5-field cron scheduler for monitor workers, with tick coalescing. */
export class SwarmScheduler {
	private readonly onTrigger: (task: ScheduledTaskRecord) => void | Promise<void>;
	private readonly isTargetBusy?: (workerName: string) => boolean;
	private readonly now: () => number;
	private readonly tasks = new Map<string, InternalTask>();
	private counter = 0;
	private disposed = false;

	constructor(options: SwarmSchedulerOptions) {
		this.onTrigger = options.onTrigger;
		this.isTargetBusy = options.isTargetBusy;
		this.now = options.now ?? (() => Date.now());
	}

	/** Schedules a one-shot timer (`DurationSeconds`) or recurring cron (`CronExpression`) for `targetWorker`. */
	schedule(input: ScheduleInput, targetWorker = "monitor"): ScheduleResult {
		if (this.disposed) {
			throw new Error("Scheduler has been disposed.");
		}
		const hasCron = input.CronExpression !== undefined && input.CronExpression.trim().length > 0;
		const hasDuration = input.DurationSeconds !== undefined;
		if (hasCron === hasDuration) {
			throw new Error("Provide exactly one of CronExpression or DurationSeconds.");
		}
		if (!input.Prompt || input.Prompt.trim().length === 0) {
			throw new Error("Prompt must be a non-empty string.");
		}

		const createdAt = this.now();
		let nextRunAt: number;
		let kind: "cron" | "timer";

		if (hasCron) {
			kind = "cron";
			nextRunAt = getNextCronRun(input.CronExpression!, createdAt);
		} else {
			const seconds = input.DurationSeconds!;
			if (!Number.isFinite(seconds) || seconds <= 0) {
				throw new Error(`DurationSeconds must be a positive finite number, got ${seconds}.`);
			}
			kind = "timer";
			nextRunAt = createdAt + Math.round(seconds * 1000);
		}

		this.counter += 1;
		const taskId = `sched-${this.counter}`;
		const record: ScheduledTaskRecord = {
			taskId,
			kind,
			...(hasCron ? { cronExpression: input.CronExpression!.trim() } : { durationSeconds: input.DurationSeconds }),
			isDaemon: kind === "cron" ? Boolean(input.IsDaemon) : false,
			prompt: input.Prompt,
			targetWorker,
			createdAt,
			nextRunAt,
			runCount: 0,
			active: true,
		};

		const entry: InternalTask = {
			record,
			coalescedPending: false,
			inFlight: false,
		};
		this.tasks.set(taskId, entry);
		this.armTimer(entry);

		return {
			taskId,
			kind,
			nextRunAt,
		};
	}

	/** Lists scheduled tasks or kills a specific task by `TaskId`. */
	manageTask(input: ManageTaskInput, targetWorker?: string): ManageTaskResult {
		if (input.Action === "list") {
			const tasks: ScheduledTaskRecord[] = [];
			for (const entry of this.tasks.values()) {
				if (targetWorker && entry.record.targetWorker !== targetWorker) {
					continue;
				}
				tasks.push({ ...entry.record });
			}
			return { kind: "list", tasks };
		}

		if (!input.TaskId) {
			throw new Error('TaskId is required for Action "kill".');
		}
		const entry = this.tasks.get(input.TaskId);
		if (!entry || (targetWorker && entry.record.targetWorker !== targetWorker)) {
			return { kind: "kill", taskId: input.TaskId, killed: false };
		}
		const wasActive = entry.record.active;
		this.deactivateTask(entry);
		return { kind: "kill", taskId: input.TaskId, killed: wasActive };
	}

	/** Notifies the scheduler that `workerName` became idle so any coalesced missed tick fires once. */
	notifyWorkerIdle(workerName: string): void {
		if (this.disposed) {
			return;
		}
		for (const entry of this.tasks.values()) {
			if (entry.record.targetWorker !== workerName || !entry.coalescedPending) {
				continue;
			}
			if (!entry.record.active && entry.record.kind === "cron") {
				continue;
			}
			if (entry.inFlight || this.isTargetBusy?.(workerName)) {
				continue;
			}
			entry.coalescedPending = false;
			this.dispatchTrigger(entry);
		}
	}

	/** Kills all scheduled tasks owned by `workerName` and returns how many active tasks were stopped. */
	killTasksForWorker(workerName: string): number {
		let killed = 0;
		for (const entry of this.tasks.values()) {
			if (entry.record.targetWorker === workerName && entry.record.active) {
				this.deactivateTask(entry);
				killed += 1;
			}
		}
		return killed;
	}

	/** Cancels all active timers and marks all tasks inactive. */
	dispose(): void {
		this.disposed = true;
		for (const entry of this.tasks.values()) {
			this.deactivateTask(entry);
		}
	}

	private deactivateTask(entry: InternalTask): void {
		if (entry.timer !== undefined) {
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}
		entry.record.active = false;
		entry.record.nextRunAt = undefined;
		entry.coalescedPending = false;
	}

	private armTimer(entry: InternalTask): void {
		if (this.disposed || !entry.record.active || entry.record.nextRunAt === undefined) {
			return;
		}
		if (entry.timer !== undefined) {
			clearTimeout(entry.timer);
			entry.timer = undefined;
		}
		const delay = Math.max(0, entry.record.nextRunAt - this.now());
		const boundedDelay = Math.min(delay, MAX_TIMEOUT_MS);
		entry.timer = setTimeout(() => {
			entry.timer = undefined;
			if (this.disposed || !entry.record.active || entry.record.nextRunAt === undefined) {
				return;
			}
			if (this.now() < entry.record.nextRunAt) {
				this.armTimer(entry);
				return;
			}
			this.onTick(entry);
		}, boundedDelay);
	}

	private onTick(entry: InternalTask): void {
		if (this.disposed || !entry.record.active) {
			return;
		}
		const firedAt = this.now();
		entry.record.lastRunAt = firedAt;
		entry.record.runCount += 1;

		if (entry.record.kind === "timer") {
			entry.record.active = false;
			entry.record.nextRunAt = undefined;
		} else {
			entry.record.nextRunAt = getNextCronRun(entry.record.cronExpression!, firedAt);
			this.armTimer(entry);
		}

		if (entry.inFlight || this.isTargetBusy?.(entry.record.targetWorker)) {
			entry.coalescedPending = true;
			return;
		}

		this.dispatchTrigger(entry);
	}

	private dispatchTrigger(entry: InternalTask): void {
		entry.inFlight = true;
		Promise.resolve(this.onTrigger({ ...entry.record }))
			.catch(() => {
				// Errors from trigger handlers should not kill the scheduler loop.
			})
			.finally(() => {
				entry.inFlight = false;
			});
	}
}

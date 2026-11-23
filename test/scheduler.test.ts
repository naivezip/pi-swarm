import { afterEach, describe, expect, it, vi } from "vitest";
import { getNextCronRun, parseCronExpression, SwarmScheduler } from "../src/scheduler.ts";

afterEach(() => {
	vi.useRealTimers();
});

describe("cron parser", () => {
	it("parses */N, lists, ranges, stepped ranges, and weekday 7", () => {
		const parsed = parseCronExpression("*/15 9-17 1,15 1-6/2 7");
		expect(Array.from(parsed.minutes)).toEqual([0, 15, 30, 45]);
		expect(Array.from(parsed.hours)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
		expect(Array.from(parsed.daysOfMonth)).toEqual([1, 15]);
		expect(Array.from(parsed.months)).toEqual([1, 3, 5]);
		expect(Array.from(parsed.daysOfWeek)).toEqual([0]);
	});

	it("rejects malformed cron expressions", () => {
		expect(() => parseCronExpression("* * *")).toThrow(/5 whitespace-separated fields/);
		expect(() => parseCronExpression("60 * * * *")).toThrow(/out of range/);
		expect(() => parseCronExpression("*/0 * * * *")).toThrow(/Invalid cron step/);
		expect(() => parseCronExpression("10-5 * * * *")).toThrow(/Invalid cron range/);
	});

	it("computes the next matching minute strictly after afterMs", () => {
		const base = new Date(2026, 0, 1, 10, 14, 30, 0).getTime();
		const next = getNextCronRun("*/5 * * * *", base);
		const nextDate = new Date(next);
		expect(nextDate.getHours()).toBe(10);
		expect(nextDate.getMinutes()).toBe(15);
		expect(nextDate.getSeconds()).toBe(0);
	});
});

describe("SwarmScheduler", () => {
	it("schedules and fires one-shot DurationSeconds timers", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0, 0));

		const fired: string[] = [];
		const scheduler = new SwarmScheduler({
			now: () => Date.now(),
			onTrigger: (task) => {
				fired.push(`${task.taskId}:${task.prompt}`);
			},
		});

		const res = scheduler.schedule({ DurationSeconds: 10, Prompt: "check status" }, "monitor");
		expect(res.kind).toBe("timer");

		await vi.advanceTimersByTimeAsync(9999);
		expect(fired).toEqual([]);

		await vi.advanceTimersByTimeAsync(1);
		expect(fired).toEqual([`${res.taskId}:check status`]);

		const list = scheduler.manageTask({ Action: "list" });
		expect(list.kind).toBe("list");
		if (list.kind === "list") {
			expect(list.tasks[0].active).toBe(false);
			expect(list.tasks[0].runCount).toBe(1);
		}

		scheduler.dispose();
	});

	it("fires recurring cron ticks and stops after kill or dispose", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0, 0));

		const prompts: string[] = [];
		const scheduler = new SwarmScheduler({
			now: () => Date.now(),
			onTrigger: (task) => {
				prompts.push(`${task.runCount}:${task.prompt}`);
			},
		});

		const res = scheduler.schedule(
			{ CronExpression: "*/2 * * * *", IsDaemon: true, Prompt: "poll swarm" },
			"monitor-1",
		);
		expect(res.kind).toBe("cron");

		// 12:02 and 12:04
		await vi.advanceTimersByTimeAsync(4 * 60 * 1000);
		expect(prompts).toEqual(["1:poll swarm", "2:poll swarm"]);

		const killRes = scheduler.manageTask({ Action: "kill", TaskId: res.taskId }, "monitor-1");
		expect(killRes).toEqual({ kind: "kill", taskId: res.taskId, killed: true });

		await vi.advanceTimersByTimeAsync(10 * 60 * 1000);
		expect(prompts).toEqual(["1:poll swarm", "2:poll swarm"]);

		scheduler.dispose();
	});

	it("coalesces missed ticks when target worker is busy and flushes once when idle", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(new Date(2026, 0, 1, 12, 0, 0, 0));

		let busy = true;
		let triggers = 0;
		const scheduler = new SwarmScheduler({
			now: () => Date.now(),
			isTargetBusy: () => busy,
			onTrigger: () => {
				triggers += 1;
			},
		});

		scheduler.schedule({ CronExpression: "* * * * *", Prompt: "tick" }, "monitor");

		// Advance across 3 minutes while monitor is busy.
		await vi.advanceTimersByTimeAsync(3 * 60 * 1000);
		expect(triggers).toBe(0);

		// Monitor finishes current turn -> only one coalesced trigger fires.
		busy = false;
		scheduler.notifyWorkerIdle("monitor");
		expect(triggers).toBe(1);

		scheduler.dispose();
		await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
		expect(triggers).toBe(1);
	});
});

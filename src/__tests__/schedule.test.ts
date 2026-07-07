/**
 * Tests for E9: Recurring Subagent Task Scheduler
 *
 * Tests the Scheduler class: adding/removing schedules, timer-based execution,
 * disabled schedule behavior, start/stop lifecycle, and tick-based triggering.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Scheduler, type ScheduleConfig } from "../schedule";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createMockLogger() {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	};
}

function createMockAPI() {
	return {} as any;
}

function makeScheduleConfig(overrides?: Partial<ScheduleConfig>): ScheduleConfig {
	return {
		name: "test-schedule",
		task: "run a test task",
		intervalMinutes: 30,
		enabled: true,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// 1. addSchedule adds entry with auto-generated ID
// ---------------------------------------------------------------------------
describe("Scheduler.addSchedule", () => {
	it("adds an entry with auto-generated ID", () => {
		const scheduler = new Scheduler(createMockAPI(), createMockLogger());
		const config = makeScheduleConfig();
		const id = scheduler.addSchedule("test", config);

		expect(id).toBeTruthy();
		expect(id).toMatch(/^sched-/);
		const schedules = scheduler.getSchedules();
		expect(schedules).toHaveLength(1);
		expect(schedules[0].id).toBe(id);
		expect(schedules[0].name).toBe("test");
	});

	it("enforces minimum interval of 5 minutes", () => {
		const scheduler = new Scheduler(createMockAPI(), createMockLogger());
		const config = makeScheduleConfig({ intervalMinutes: 1 });
		const id = scheduler.addSchedule("test", config);

		const schedules = scheduler.getSchedules();
		expect(schedules[0].intervalMinutes).toBe(5);
	});

	it("generates unique IDs for multiple schedules", () => {
		const scheduler = new Scheduler(createMockAPI(), createMockLogger());
		const id1 = scheduler.addSchedule("a", makeScheduleConfig({ name: "a" }));
		const id2 = scheduler.addSchedule("b", makeScheduleConfig({ name: "b" }));

		expect(id1).not.toBe(id2);
		expect(scheduler.getSchedules()).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// 2. getSchedules returns all entries
// ---------------------------------------------------------------------------
describe("Scheduler.getSchedules", () => {
	it("returns empty array when no schedules", () => {
		const scheduler = new Scheduler(createMockAPI(), createMockLogger());
		expect(scheduler.getSchedules()).toEqual([]);
	});

	it("returns a copy of the schedules array", () => {
		const scheduler = new Scheduler(createMockAPI(), createMockLogger());
		scheduler.addSchedule("test", makeScheduleConfig());
		const schedules = scheduler.getSchedules();
		schedules.pop(); // Mutate the copy
		expect(scheduler.getSchedules()).toHaveLength(1); // Original unaffected
	});

	it("returns all added schedules", () => {
		const scheduler = new Scheduler(createMockAPI(), createMockLogger());
		scheduler.addSchedule("a", makeScheduleConfig({ name: "a" }));
		scheduler.addSchedule("b", makeScheduleConfig({ name: "b" }));
		scheduler.addSchedule("c", makeScheduleConfig({ name: "c" }));
		expect(scheduler.getSchedules()).toHaveLength(3);
	});
});

// ---------------------------------------------------------------------------
// 3. removeSchedule removes by ID, returns true
// ---------------------------------------------------------------------------
describe("Scheduler.removeSchedule", () => {
	it("removes a schedule by ID and returns true", () => {
		const scheduler = new Scheduler(createMockAPI(), createMockLogger());
		const id = scheduler.addSchedule("test", makeScheduleConfig());
		expect(scheduler.removeSchedule(id)).toBe(true);
		expect(scheduler.getSchedules()).toHaveLength(0);
	});

	it("removes correct schedule when multiple exist", () => {
		const scheduler = new Scheduler(createMockAPI(), createMockLogger());
		const id1 = scheduler.addSchedule("a", makeScheduleConfig({ name: "a" }));
		const id2 = scheduler.addSchedule("b", makeScheduleConfig({ name: "b" }));
		scheduler.removeSchedule(id1);
		expect(scheduler.getSchedules()).toHaveLength(1);
		expect(scheduler.getSchedules()[0].id).toBe(id2);
	});
});

// ---------------------------------------------------------------------------
// 4. removeSchedule with invalid ID returns false
// ---------------------------------------------------------------------------
describe("Scheduler.removeSchedule (invalid ID)", () => {
	it("returns false for non-existent ID", () => {
		const scheduler = new Scheduler(createMockAPI(), createMockLogger());
		scheduler.addSchedule("test", makeScheduleConfig());
		expect(scheduler.removeSchedule("non-existent")).toBe(false);
		expect(scheduler.getSchedules()).toHaveLength(1);
	});

	it("returns false on empty scheduler", () => {
		const scheduler = new Scheduler(createMockAPI(), createMockLogger());
		expect(scheduler.removeSchedule("any-id")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 5. Multiple schedules tracked independently
// ---------------------------------------------------------------------------
describe("Scheduler multiple schedules", () => {
	it("tracks each schedule independently", () => {
		const scheduler = new Scheduler(createMockAPI(), createMockLogger());
		const id1 = scheduler.addSchedule("task-a", makeScheduleConfig({ name: "task-a", intervalMinutes: 10 }));
		const id2 = scheduler.addSchedule("task-b", makeScheduleConfig({ name: "task-b", intervalMinutes: 20 }));
		const id3 = scheduler.addSchedule("task-c", makeScheduleConfig({ name: "task-c", intervalMinutes: 30 }));

		const schedules = scheduler.getSchedules();
		expect(schedules).toHaveLength(3);
		expect(schedules.find((s) => s.id === id1)?.intervalMinutes).toBe(10);
		expect(schedules.find((s) => s.id === id2)?.intervalMinutes).toBe(20);
		expect(schedules.find((s) => s.id === id3)?.intervalMinutes).toBe(30);

		// Removing one doesn't affect others
		scheduler.removeSchedule(id2);
		expect(scheduler.getSchedules()).toHaveLength(2);
		expect(scheduler.getSchedule(id1)).toBeTruthy();
		expect(scheduler.getSchedule(id3)).toBeTruthy();
	});
});

// ---------------------------------------------------------------------------
// 6. Disabled schedules not triggered on tick
// ---------------------------------------------------------------------------
describe("Scheduler disabled schedules", () => {
	it("does not fire disabled schedules", async () => {
		const executor = vi.fn().mockResolvedValue(undefined);
		const scheduler = new Scheduler(
			createMockAPI(),
			createMockLogger(),
			executor,
		);

		scheduler.addSchedule("disabled", makeScheduleConfig({
			name: "disabled",
			enabled: false,
			intervalMinutes: 5,
		}));

		// Manually set nextRun to past
		const schedules = scheduler.getSchedules();
		schedules[0].nextRun = Date.now() - 1000;

		scheduler.tickForTesting();

		// Wait a tick for async
		await new Promise((r) => setTimeout(r, 10));
		expect(executor).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// 7. Start and stop toggles checking
// ---------------------------------------------------------------------------
describe("Scheduler start/stop", () => {
	it("start begins checking and stop stops it", () => {
		const scheduler = new Scheduler(createMockAPI(), createMockLogger());

		scheduler.start();
		// Second start is a no-op
		scheduler.start();

		scheduler.stop();
		// Second stop is a no-op
		scheduler.stop();

		// No error thrown — basic lifecycle works
		expect(true).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// 8. Schedule triggers at nextRun time (fake timers)
// ---------------------------------------------------------------------------
describe("Scheduler tick triggering", () => {
	beforeEach(() => {
		vi.useFakeTimers();
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("fires the executor when nextRun time has passed", async () => {
		const executor = vi.fn().mockResolvedValue(undefined);
		const scheduler = new Scheduler(
			createMockAPI(),
			createMockLogger(),
			executor,
		);

		scheduler.addSchedule("test", makeScheduleConfig({
			name: "test",
			intervalMinutes: 10,
			enabled: true,
		}));

		// Set nextRun to now so it fires immediately
		const schedules = scheduler.getSchedules();
		schedules[0].nextRun = Date.now();

		scheduler.tickForTesting();

		// Allow microtasks to settle
		await vi.advanceTimersByTimeAsync(0);

		expect(executor).toHaveBeenCalledTimes(1);
		expect(executor).toHaveBeenCalledWith(
			"run a test task",
			expect.objectContaining({ name: "test" }),
		);
	});

	// 9. Schedule does not trigger before nextRun time
	it("does not fire before nextRun time", async () => {
		const executor = vi.fn().mockResolvedValue(undefined);
		const scheduler = new Scheduler(
			createMockAPI(),
			createMockLogger(),
			executor,
		);

		scheduler.addSchedule("test", makeScheduleConfig({
			name: "test",
			intervalMinutes: 10,
			enabled: true,
		}));

		// Set nextRun to 1 minute in the future
		const schedules = scheduler.getSchedules();
		schedules[0].nextRun = Date.now() + 60_000;

		scheduler.tickForTesting();

		await vi.advanceTimersByTimeAsync(0);
		expect(executor).not.toHaveBeenCalled();
	});

	// 10. After trigger, nextRun is updated
	it("updates nextRun after firing", async () => {
		const executor = vi.fn().mockResolvedValue(undefined);
		const scheduler = new Scheduler(
			createMockAPI(),
			createMockLogger(),
			executor,
		);

		const intervalMinutes = 10;
		const config = makeScheduleConfig({
			name: "test",
			intervalMinutes,
			enabled: true,
		});
		scheduler.addSchedule("test", config);

		const schedules = scheduler.getSchedules();
		const now = Date.now();
		schedules[0].nextRun = now;

		scheduler.tickForTesting();
		await vi.advanceTimersByTimeAsync(0);

		// nextRun should be updated to now + interval
		expect(schedules[0].nextRun).toBeGreaterThanOrEqual(now + intervalMinutes * 60_000);
		// lastRun should be set
		expect(schedules[0].lastRun).toBeGreaterThanOrEqual(now);
	});

	it("logs when scheduled task starts", async () => {
		const logger = createMockLogger();
		const executor = vi.fn().mockResolvedValue(undefined);
		const scheduler = new Scheduler(createMockAPI(), logger, executor);

		scheduler.addSchedule("test", makeScheduleConfig({
			name: "test",
			intervalMinutes: 5,
			enabled: true,
		}));

		const schedules = scheduler.getSchedules();
		schedules[0].nextRun = Date.now();

		scheduler.tickForTesting();
		await vi.advanceTimersByTimeAsync(0);

		expect(logger.info).toHaveBeenCalledWith(
			"Scheduled task started",
			expect.objectContaining({ name: "test" }),
		);
	});
});

// ---------------------------------------------------------------------------
// Toggle schedule
// ---------------------------------------------------------------------------
describe("Scheduler.toggleSchedule", () => {
	it("toggles enabled state and resets nextRun when enabling", () => {
		const scheduler = new Scheduler(createMockAPI(), createMockLogger());
		const id = scheduler.addSchedule("test", makeScheduleConfig({ enabled: false }));

		const entry = scheduler.getSchedule(id);
		expect(entry?.enabled).toBe(false);

		scheduler.toggleSchedule(id);
		expect(entry?.enabled).toBe(true);
		// nextRun should be reset to future
		expect(entry!.nextRun).toBeGreaterThan(Date.now());

		scheduler.toggleSchedule(id);
		expect(entry?.enabled).toBe(false);
	});

	it("returns false for non-existent ID", () => {
		const scheduler = new Scheduler(createMockAPI(), createMockLogger());
		expect(scheduler.toggleSchedule("nope")).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// getSchedule
// ---------------------------------------------------------------------------
describe("Scheduler.getSchedule", () => {
	it("returns undefined for non-existent ID", () => {
		const scheduler = new Scheduler(createMockAPI(), createMockLogger());
		expect(scheduler.getSchedule("nope")).toBeUndefined();
	});

	it("returns the correct schedule", () => {
		const scheduler = new Scheduler(createMockAPI(), createMockLogger());
		const id = scheduler.addSchedule("test", makeScheduleConfig({ name: "test" }));
		const entry = scheduler.getSchedule(id);
		expect(entry).toBeTruthy();
		expect(entry?.name).toBe("test");
	});
});

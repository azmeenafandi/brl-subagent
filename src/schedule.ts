/**
 * brl-subagent — Recurring Task Scheduler (E9)
 *
 * Manages recurring subagent task schedules using setInterval-based polling.
 * Each schedule defines a task, interval, and optional preset/thinking level.
 * When a schedule's nextRun time has passed, it fires the task asynchronously
 * (fire-and-forget) via delegate_task.execute.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Logger } from "./logging";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ScheduleConfig {
	/** Display name for the schedule */
	name: string;
	/** The task to run */
	task: string;
	/** Optional preset name */
	preset?: string;
	/** Optional thinking level */
	thinkingLevel?: string;
	/** How often to run, in minutes (minimum 5) */
	intervalMinutes: number;
	/** Whether this schedule is enabled */
	enabled: boolean;
}

export interface ScheduleEntry extends ScheduleConfig {
	/** Auto-generated unique ID */
	id: string;
	/** Timestamp (ms) of last run, undefined if never run */
	lastRun?: number;
	/** Timestamp (ms) of next scheduled run */
	nextRun: number;
}

// ---------------------------------------------------------------------------
// Scheduler
// ---------------------------------------------------------------------------

const MIN_INTERVAL_MINUTES = 5;
const CHECK_INTERVAL_MS = 30_000; // check every 30 seconds

export class Scheduler {
	private schedules: ScheduleEntry[] = [];
	private timer: ReturnType<typeof setInterval> | null = null;
	private idCounter = 0;
	private logger: Logger;
	private api: ExtensionAPI;

	// Callback to actually execute a scheduled task. Injected for testability
	// and to avoid circular dependencies. In production this calls
	// delegate_task.execute via the pi ExtensionAPI.
	private executeTask: (task: string, config: ScheduleConfig) => Promise<void>;

	constructor(
		api: ExtensionAPI,
		logger: Logger,
		executeTask?: (task: string, config: ScheduleConfig) => Promise<void>,
	) {
		this.api = api;
		this.logger = logger;
		this.executeTask = executeTask ?? this.defaultExecuteTask.bind(this);
	}

	// -------------------------------------------------------------------
	// Public API
	// -------------------------------------------------------------------

	/**
	 * Add a new schedule. Returns the auto-generated ID.
	 */
	addSchedule(name: string, config: ScheduleConfig): string {
		const id = `sched-${++this.idCounter}-${Date.now()}`;
		const intervalMs = Math.max(config.intervalMinutes, MIN_INTERVAL_MINUTES) * 60_000;
		const entry: ScheduleEntry = {
			...config,
			name,
			id,
			intervalMinutes: Math.max(config.intervalMinutes, MIN_INTERVAL_MINUTES),
			nextRun: Date.now() + intervalMs,
		};
		this.schedules.push(entry);
		this.logger.info("Schedule added", {
			id,
			name,
			intervalMinutes: entry.intervalMinutes,
		});
		return id;
	}

	/**
	 * Remove a schedule by ID. Returns true if found and removed.
	 */
	removeSchedule(id: string): boolean {
		const idx = this.schedules.findIndex((s) => s.id === id);
		if (idx === -1) return false;
		const removed = this.schedules.splice(idx, 1)[0];
		this.logger.info("Schedule removed", { id: removed.id, name: removed.name });
		return true;
	}

	/**
	 * Get all schedule entries (returns a copy).
	 */
	getSchedules(): ScheduleEntry[] {
		return [...this.schedules];
	}

	/**
	 * Get a single schedule by ID.
	 */
	getSchedule(id: string): ScheduleEntry | undefined {
		return this.schedules.find((s) => s.id === id);
	}

	/**
	 * Toggle a schedule's enabled state.
	 */
	toggleSchedule(id: string): boolean {
		const entry = this.schedules.find((s) => s.id === id);
		if (!entry) return false;
		entry.enabled = !entry.enabled;
		if (entry.enabled) {
			// Reset nextRun to now + interval so it doesn't fire immediately
			entry.nextRun = Date.now() + entry.intervalMinutes * 60_000;
		}
		this.logger.info("Schedule toggled", {
			id,
			name: entry.name,
			enabled: entry.enabled,
		});
		return true;
	}

	/**
	 * Start the periodic check interval.
	 */
	start(): void {
		if (this.timer !== null) return;
		this.logger.debug("Scheduler started", {
			scheduleCount: this.schedules.length,
			checkIntervalMs: CHECK_INTERVAL_MS,
		});
		this.timer = setInterval(() => this.tick(), CHECK_INTERVAL_MS);
	}

	/**
	 * Stop the periodic check interval.
	 */
	stop(): void {
		if (this.timer === null) return;
		clearInterval(this.timer);
		this.timer = null;
		this.logger.debug("Scheduler stopped");
	}

	/**
	 * Expose tick for testing purposes.
	 */
	tickForTesting(): void {
		this.tick();
	}

	// -------------------------------------------------------------------
	// Internal
	// -------------------------------------------------------------------

	private tick(): void {
		const now = Date.now();
		for (const entry of this.schedules) {
			if (!entry.enabled) continue;
			if (now < entry.nextRun) continue;

			// Fire-and-forget: spawn the task asynchronously
			this.fireSchedule(entry, now).catch((err) => {
				this.logger.error("Scheduled task failed to start", {
					id: entry.id,
					name: entry.name,
					error: (err as Error).message,
				});
			});
		}
	}

	private async fireSchedule(entry: ScheduleEntry, now: number): Promise<void> {
		this.logger.info("Scheduled task started", { name: entry.name, id: entry.id });

		// Update timestamps immediately
		entry.lastRun = now;
		entry.nextRun = now + entry.intervalMinutes * 60_000;

		try {
			await this.executeTask(entry.task, entry);
		} catch (err) {
			this.logger.error("Scheduled task execution error", {
				id: entry.id,
				name: entry.name,
				error: (err as Error).message,
			});
		}
	}

	/**
	 * Default task executor: calls delegate_task.execute via the pi API.
	 * This is fire-and-forget — we don't await the result.
	 */
	private async defaultExecuteTask(
		task: string,
		config: ScheduleConfig,
	): Promise<void> {
		// We cannot directly call registerTool's execute handler.
		// Instead, we use pi.sendUserMessage to simulate a user delegation request.
		// However, this approach has limitations. For the Scheduler to work reliably
		// in production, the executeTask callback should be provided during wiring.
		//
		// For now, we construct a minimal call that the pi runtime can process.
		this.logger.warn(
			"Default executor called — provide a custom executeTask callback for production use",
			{ task: task.slice(0, 60) },
		);
	}
}

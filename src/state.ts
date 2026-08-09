/**
 * brl-subagent — State Management (F5, F7, F9)
 *
 * Session-bound state container with validation and migration support.
 *
 * F5: Type-safe state restoration — no `as any` casts.
 * F7: Session-bound state — initialized in session_start, cleaned in session_shutdown.
 * F9: State schema validation — validates on load, migrates legacy formats.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
	SubagentState,
	SubagentRun,
	LiveSubagent,
	ThinkingLevel,
	ApprovalMode,
	CircuitBreakerState,
	Priority,
} from "./types";
import {
	isSubagentStateShape,
	isSubagentRunShape,
	CUSTOM_ENTRY_TYPES,
	MAX_RUN_HISTORY_ENTRIES,
	DEFAULT_MAX_SUBAGENT_DEPTH,
	DEFAULT_SESSION_COST_LIMIT,
	DEFAULT_PRIORITY,
	MAX_CONSECUTIVE_FAILURES,
	CIRCUIT_BREAKER_RESET_MS,
	CIRCUIT_DEGRADED_THINKING,
} from "./types";
import { cleanupRuns } from "./history";
import type { Logger } from "./logging";

// ---------------------------------------------------------------------------
// Live-monitor staleness sweep (issue #52 part 2)
// ---------------------------------------------------------------------------

/**
 * How long a finalized live entry stays visible in the monitor map before it
 * is deleted (the poller's "brief reset window" — see finalizeLiveSubagent).
 */
export const FINALIZE_RESET_WINDOW_MS = 3000;

/**
 * Background-progress poller tick interval (src/index.ts, `setInterval(..., 2000)`
 * in the background spawn branch).
 */
const POLLER_TICK_MS = 2000;

/**
 * Liveness boundary for the stale sweep. The poller finalizes a completed
 * agent on its NEXT tick after `completedAt` is set, i.e. within at most one
 * POLLER_TICK_MS. A terminal record that is OLDER than this boundary and
 * still present in the live map therefore proves the poller can no longer be
 * the one to finalize it — it died mid-run — so the sweep may claim the
 * finalize (and its counter adjustment) without racing a live poller.
 */
export const STALE_FINALIZE_GRACE_MS = POLLER_TICK_MS + 1000;

// ---------------------------------------------------------------------------
// SessionState — session-bound mutable state
// ---------------------------------------------------------------------------

export class SessionState {
	/** Current configuration */
	config: SubagentState;

	/** Module-level progress counters (now session-bound) */
	activeSubagents = 0;
	completedSubagents = 0;
	failedSubagents = 0;
	unseenSubagents = 0;

	/** Concurrency queue */
	pendingQueue: Array<{
		run: () => void;
		signal: AbortSignal | undefined;
		ctx: ExtensionContext;
		priority: Priority;
	}> = [];

	/** Live subagent sessions for the monitor dashboard */
	subagentSessions = new Map<string, LiveSubagent>();

	/**
	 * Ids whose live entry has been finalized (deferred delete pending).
	 * Makes finalizeLiveSubagent idempotent so the stale sweep and the poller
	 * can race the same id without double-finalizing (issue #52).
	 */
	private _finalizedLiveIds = new Set<string>();

	/** Loaded built-in presets */
	builtinPresets = new Array<import("./types").SubagentPreset>();

	/** Loaded built-in task templates (companions to the builtin presets) */
	builtinTemplates = new Array<import("./types").TaskTemplate>();

	/** Loaded custom presets from user directories */
	customPresets = new Array<import("./types").SubagentPreset>();

	/**
	 * Migration: session-persisted presets read during restoreFromSession.
	 * These are stored here for src/presets.ts:migrateSessionPresets() to
	 * write to files in a subsequent step, then cleared.
	 */
	_migratedPresets?: import("./types").SubagentPreset[];

	/** Logger instance */
	log: Logger | undefined;

	constructor(log?: Logger) {
		this.log = log;
		this.config = {
			maxThinkingLevel: "off",
			maxParallel: 0,
			maxSubagentDepth: DEFAULT_MAX_SUBAGENT_DEPTH,
			gitMode: "none",
			approvalMode: "writes",
			defaultPriority: DEFAULT_PRIORITY,
			sessionCostLimit: DEFAULT_SESSION_COST_LIMIT,
			perTaskCostEstimate: 0,
			seenRunIds: [],
			templates: [],
			circuitBreaker: this.defaultCircuitBreaker(),
			slaTrackingEnabled: false,
			slaWindowSize: 50,
			updateCheckEnabled: true,
			lastUpdateCheck: 0,
		};
	}

	// -------------------------------------------------------------------
	// State persistence
	// -------------------------------------------------------------------

	persistState(pi: ExtensionAPI): void {
		pi.appendEntry(CUSTOM_ENTRY_TYPES.state, {
			model: this.config.model,
			maxThinkingLevel: this.config.maxThinkingLevel,
			maxParallel: this.config.maxParallel,
			maxSubagentDepth: this.config.maxSubagentDepth,
			gitMode: this.config.gitMode,
			approvalMode: this.config.approvalMode,
			defaultPriority: this.config.defaultPriority,
			maxHistoryEntries: this.config.maxHistoryEntries,
			sessionCostLimit: this.config.sessionCostLimit,
			perTaskCostEstimate: this.config.perTaskCostEstimate,
			seenRunIds: this.config.seenRunIds,
			circuitBreaker: this.config.circuitBreaker,
		slaTrackingEnabled: this.config.slaTrackingEnabled,
		slaWindowSize: this.config.slaWindowSize,
		lastSLAMetrics: this.config.lastSLAMetrics,
		updateCheckEnabled: this.config.updateCheckEnabled,
		lastUpdateCheck: this.config.lastUpdateCheck,
		});
	}

	persistRun(pi: ExtensionAPI, run: SubagentRun): void {
		pi.appendEntry(CUSTOM_ENTRY_TYPES.run, run);
	}

	// -------------------------------------------------------------------
	// F5/F9: Safe state restoration from session entries
	// -------------------------------------------------------------------

	/**
	 * Restore state from the last persisted state entry.
	 * Uses type guards instead of `as any` casts.
	 * Returns true if state was restored, false if defaults were used.
	 */
	restoreFromSession(ctx: ExtensionContext): boolean {
		const entries = ctx.sessionManager.getEntries();
		const stateEntry = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === CUSTOM_ENTRY_TYPES.state,
			)
			.pop() as { data?: unknown } | undefined;

		if (!stateEntry?.data) {
			this.log?.debug("No persisted state found, using defaults");
			return false;
		}

		const data = stateEntry.data;

		if (!isSubagentStateShape(data)) {
			this.log?.warn("Corrupted state entry detected, falling back to defaults", {
				dataType: typeof data,
			});
			return false;
		}

		// Restore fields with fallback to defaults
		if (data.model) this.config.model = data.model;
		if (data.maxThinkingLevel) this.config.maxThinkingLevel = data.maxThinkingLevel;
		if (data.maxParallel !== undefined) this.config.maxParallel = data.maxParallel;
		if (data.maxSubagentDepth !== undefined) this.config.maxSubagentDepth = data.maxSubagentDepth;
		this.config.gitMode = data.gitMode === "branch" ? "branch" : "none";
		this.config.approvalMode =
			data.approvalMode === "auto" || data.approvalMode === "writes" || data.approvalMode === "always"
				? data.approvalMode
				: "writes";
		if (data.maxHistoryEntries !== undefined) this.config.maxHistoryEntries = data.maxHistoryEntries;
		if (data.sessionCostLimit !== undefined) this.config.sessionCostLimit = data.sessionCostLimit;
		if (data.perTaskCostEstimate !== undefined) this.config.perTaskCostEstimate = data.perTaskCostEstimate;
		if (
			data.defaultPriority &&
			["critical", "high", "normal", "low"].includes(data.defaultPriority)
		) {
			this.config.defaultPriority = data.defaultPriority as Priority;
		} else {
			this.config.defaultPriority = "normal";
		}

		if (Array.isArray(data.seenRunIds)) this.config.seenRunIds = data.seenRunIds;

		// Migration: old session-persisted presets — store for file-backed migration
		if (Array.isArray(data.presets) && data.presets.length > 0) {
			this._migratedPresets = data.presets;
		}

		// Templates are file-backed only (issue #66) — never persisted to session state.
		if (
			data.circuitBreaker &&
			typeof data.circuitBreaker === "object" &&
			typeof (data.circuitBreaker as CircuitBreakerState).consecutiveFailures === "number"
		) {
			const cb = data.circuitBreaker as CircuitBreakerState;
			this.config.circuitBreaker.consecutiveFailures = cb.consecutiveFailures;
			this.config.circuitBreaker.lastFailureTime = cb.lastFailureTime;
			this.config.circuitBreaker.circuitOpen = cb.circuitOpen;
			if (cb.degradedThinkingLevel) {
				this.config.circuitBreaker.degradedThinkingLevel = cb.degradedThinkingLevel;
			}
		}

		// Restore SLA fields (E4)
		if (typeof data.slaTrackingEnabled === "boolean") this.config.slaTrackingEnabled = data.slaTrackingEnabled;
		if (typeof data.slaWindowSize === "number" && data.slaWindowSize >= 10 && data.slaWindowSize <= 500) {
			this.config.slaWindowSize = data.slaWindowSize;
		}
		if (data.lastSLAMetrics && typeof data.lastSLAMetrics === "object") {
			this.config.lastSLAMetrics = data.lastSLAMetrics as import("./types").SLAMetrics;
		}

		// Restore update check fields
		if (typeof data.updateCheckEnabled === "boolean") this.config.updateCheckEnabled = data.updateCheckEnabled;
		if (typeof data.lastUpdateCheck === "number" && data.lastUpdateCheck >= 0) this.config.lastUpdateCheck = data.lastUpdateCheck;

		this.log?.info("State restored from session", {
			model: data.model ? `${data.model.provider}/${data.model.id}` : "none",
			thinkingLevel: data.maxThinkingLevel,
		});

		return true;
	}

	// -------------------------------------------------------------------
	// Run entry access
	// -------------------------------------------------------------------

	getRunEntries(ctx: ExtensionContext): SubagentRun[] {
		const runs = ctx.sessionManager
			.getEntries()
			.filter((e: { type: string; customType?: string }) =>
				e.type === "custom" && e.customType === CUSTOM_ENTRY_TYPES.run,
			)
			.map((e: { data?: unknown }) => {
				const data = e.data;
				if (isSubagentRunShape(data)) return data;
				this.log?.warn("Corrupted run entry skipped", { entryType: typeof data });
				return undefined;
			})
			.filter((r): r is SubagentRun => r !== undefined);
		return cleanupRuns(runs, this.config.maxHistoryEntries);
	}

	findRunById(ctx: ExtensionContext, id: string): SubagentRun | undefined {
		return this.getRunEntries(ctx).find((r) => r.id === id);
	}

	// -------------------------------------------------------------------
	// Live subagent tracking
	// -------------------------------------------------------------------

	registerLiveSubagent(id: string, data: Omit<LiveSubagent, "liveOutput" | "usage">): void {
		this.subagentSessions.set(id, { ...data, liveOutput: "", usage: { input: 0, output: 0 } });
	}

	updateLiveSubagent(id: string, output: string, input: number, outputTokens: number): void {
		const s = this.subagentSessions.get(id);
		if (s) {
			s.liveOutput = output;
			s.usage = { input, output: outputTokens };
		}
	}

	finalizeLiveSubagent(id: string): boolean {
		// Idempotent: the poller (completion/crash paths) and the stale sweep
		// can both race to finalize the same id — the first call claims it,
		// repeats are no-ops. Returns true when THIS call claimed the finalize,
		// so callers that adjust counters can gate on it (issue #52, PR #71
		// review: the poller must not decrement when the sweep already did).
		if (this._finalizedLiveIds.has(id)) return false;
		this._finalizedLiveIds.add(id);
		setTimeout(() => {
			this.subagentSessions.delete(id);
			this._finalizedLiveIds.delete(id);
		}, FINALIZE_RESET_WINDOW_MS);
		return true;
	}

	/** True when the live entry has been finalized (deferred delete pending). */
	isLiveEntryFinalized(id: string): boolean {
		return this._finalizedLiveIds.has(id);
	}

	/**
	 * Race-safe stale-entry finalize used by the monitor's staleness sweep
	 * (issue #52 part 2). Claims the finalize for `id` exactly once and
	 * removes the entry from the live map IMMEDIATELY (stale entries must not
	 * linger — a stale-only map must render as empty right away).
	 *
	 * Returns false (no-op) when:
	 *  - the entry is already finalized (poller or an earlier sweep pass), or
	 *  - `completedAt` is set but too fresh: a live poller finalizes within one
	 *    poller tick of completion, so a fresher record means the poller may
	 *    still fire — finalizing here would double-decrement the counter.
	 *
	 * NOTE: this method does NOT touch activeSubagents — callers that know the
	 * entry was counted (background agents) must mirror the poller's
	 * decrement+clamp after a truthy return.
	 */
	finalizeStaleLiveSubagent(id: string, completedAt?: number): boolean {
		if (this._finalizedLiveIds.has(id)) return false;
		if (completedAt !== undefined && Date.now() - completedAt < STALE_FINALIZE_GRACE_MS) {
			return false;
		}
		// Claim through finalizeLiveSubagent (the shared claim set makes this
		// race-safe with the poller), then remove the entry synchronously —
		// stale entries must not linger. Return the claim result explicitly so
		// the sweep's caller knows WHO won the race (PR #71 review).
		const claimed = this.finalizeLiveSubagent(id);
		this.subagentSessions.delete(id);
		return claimed;
	}

	/**
	 * Session-shutdown hygiene: drop all pending finalize claims so a fresh
	 * session can claim the same ids again. Claims are time-bounded anyway
	 * (FINALIZE_RESET_WINDOW_MS), but the shutdown handler clears the live
	 * map and counters too — the claim set must follow suit or a new session
	 * would no-op on an id a stale claim still remembers (PR #71 review).
	 */
	resetLiveFinalizeClaims(): void {
		this._finalizedLiveIds.clear();
	}

	// -------------------------------------------------------------------
	// Seen/unseen tracking
	// -------------------------------------------------------------------

	markRunSeen(runId: string): boolean {
		if (!this.config.seenRunIds.includes(runId)) {
			this.config.seenRunIds.push(runId);
			if (this.unseenSubagents > 0) this.unseenSubagents--;
			return true;
		}
		return false;
	}

	// -------------------------------------------------------------------
	// Circuit breaker
	// -------------------------------------------------------------------

	private defaultCircuitBreaker(): CircuitBreakerState {
		return {
			consecutiveFailures: 0,
			lastFailureTime: 0,
			circuitOpen: false,
		};
	}

	/**
	 * Reset consecutiveFailures to 0, close the circuit, and clear
	 * the degraded thinking level.
	 */
	recordSuccess(): void {
		this.config.circuitBreaker.consecutiveFailures = 0;
		this.config.circuitBreaker.circuitOpen = false;
		this.config.circuitBreaker.degradedThinkingLevel = undefined;
		this.config.circuitBreaker.lastFailureTime = 0;
	}

	/**
	 * Increment consecutiveFailures. If the threshold is reached,
	 * open the circuit, record the failure time, and set the
	 * degraded thinking level.
	 */
	recordFailure(): void {
		this.config.circuitBreaker.consecutiveFailures++;
		if (this.config.circuitBreaker.consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
			this.config.circuitBreaker.circuitOpen = true;
			this.config.circuitBreaker.lastFailureTime = Date.now();
			this.config.circuitBreaker.degradedThinkingLevel = CIRCUIT_DEGRADED_THINKING;
		}
	}

	/**
	 * Check whether the circuit breaker is currently open.
	 * Applies auto-recovery if enough time has passed since
	 * the last failure. Returns the result with status info.
	 */
	checkCircuit(): { isOpen: boolean; message?: string; waitTimeRemaining?: number } {
		const cb = this.config.circuitBreaker;

		if (!cb.circuitOpen) {
			return { isOpen: false };
		}

		const elapsed = Date.now() - cb.lastFailureTime;

		// Auto-recover if the reset window has passed
		if (elapsed >= CIRCUIT_BREAKER_RESET_MS) {
			cb.consecutiveFailures = 0;
			cb.circuitOpen = false;
			cb.degradedThinkingLevel = undefined;
			cb.lastFailureTime = 0;
			return { isOpen: false };
		}

		const waitTimeRemaining = CIRCUIT_BREAKER_RESET_MS - elapsed;
		return {
			isOpen: true,
			message:
				`Circuit breaker is open: ${cb.consecutiveFailures} consecutive failures. ` +
				`Auto-recovery in ${Math.ceil(waitTimeRemaining / 1000)}s. ` +
				`Wait or reduce thinkingLevel to ${CIRCUIT_DEGRADED_THINKING} and try again.`,
			waitTimeRemaining,
		};
	}

	// -------------------------------------------------------------------
	// Cost governance — R5
	// -------------------------------------------------------------------

	/**
	 * Sum the cost of all completed runs in the current session.
	 */
	getSessionTotalCost(ctx: ExtensionContext): number {
		const runs = this.getRunEntries(ctx);
		return runs.reduce((acc, r) => acc + (r.cost ?? 0), 0);
	}

	/**
	 * Check if adding `cost` would exceed the session cost limit.
	 * Returns true if the limit would be exceeded (or is already exceeded).
	 * Returns false if the limit is 0 (unlimited) or the new total is within budget.
	 */
	checkCostLimit(cost: number, ctx: ExtensionContext): boolean {
		if (this.config.sessionCostLimit === 0) return false;
		const currentTotal = this.getSessionTotalCost(ctx);
		return currentTotal + cost > this.config.sessionCostLimit;
	}

	// -------------------------------------------------------------------
	// Reset
	// -------------------------------------------------------------------

	reset(): void {
		this.config.model = undefined;
		this.config.maxThinkingLevel = "off";
		this.config.maxParallel = 0;
		this.config.maxSubagentDepth = DEFAULT_MAX_SUBAGENT_DEPTH;
		this.config.gitMode = "none";
		this.config.approvalMode = "writes";
		this.config.defaultPriority = "normal";
		this.config.maxHistoryEntries = MAX_RUN_HISTORY_ENTRIES;
		this.config.sessionCostLimit = DEFAULT_SESSION_COST_LIMIT;
		this.config.perTaskCostEstimate = 0;
		this.config.templates = [];
		this.config.circuitBreaker = this.defaultCircuitBreaker();
		this.config.slaTrackingEnabled = false;
		this.config.slaWindowSize = 50;
		this.config.lastSLAMetrics = undefined;
		this.config.updateCheckEnabled = true;
		this.config.lastUpdateCheck = 0;
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionState(log?: Logger): SessionState {
	return new SessionState(log);
}

// ---------------------------------------------------------------------------
// Live-monitor staleness sweep (issue #52 part 2)
// ---------------------------------------------------------------------------

/**
 * Self-healing sweep for stale live-monitor entries.
 *
 * Staleness vector: the live map (`state.subagentSessions`) is only emptied
 * when the background poller's completion/crash paths call finalizeLiveSubagent
 * or when session_shutdown clears the whole map. If the poller dies mid-run
 * (extension reload, process kill, hard-cap crash), the map entry survives and
 * the monitor shows "running" for an agent whose disk record is terminal.
 *
 * This sweep runs in the monitor/dashboard render path and finalizes every
 * entry that is provably terminal:
 *  - `getAgent(id)` returns a record with `completedAt` set → the background
 *    agent is terminal (completed/failed/stopped) but the poller never
 *    finalized it → finalize + mirror the poller's activeSubagents bookkeeping
 *    (decrement + clamp at 0). The grace window inside
 *    finalizeStaleLiveSubagent guarantees the poller can no longer fire, so
 *    the counter cannot be double-decremented.
 *  - `getAgent(id)` returns null → no agent record. Background agents ALWAYS
 *    have a record (in-memory + disk), so a null record means either a
 *    FOREGROUND run (registered with a runId, never persisted as an agent) or
 *    a record removed out-of-band. Foreground runs persist run entries, so a
 *    'running' run entry proves the entry is genuinely live; anything else
 *    (done/failed, or no run entry) is stale → finalize WITHOUT counter
 *    adjustment (foreground entries are never counted in activeSubagents).
 *
 * The sweep never touches `completedSubagents`/`failedSubagents`/
 * `unseenSubagents`: those are incremented by the poller's own completion
 * paths, and the sweep exists only to cover the poller-DEAD case.
 *
 * Returns the number of entries finalized (0 when nothing was stale).
 */
export function sweepStaleLiveSubagents(
	state: SessionState,
	getAgent: (id: string) => { completedAt?: number } | null,
): number {
	let finalized = 0;

	// Snapshot: sweep-finalized entries are deleted synchronously, so the map
	// changes under iteration — iterate a copy to stay well-defined.
	for (const [id, session] of Array.from(state.subagentSessions)) {
		const agent = getAgent(id);
		if (agent) {
			// Background agent with a record. Terminal on disk but still in the
			// live map = the poller died before its finalize tick.
			if (agent.completedAt && state.finalizeStaleLiveSubagent(id, agent.completedAt)) {
				// Mirror the poller's counter bookkeeping exactly (index.ts):
				// finalize, decrement, clamp at 0.
				state.activeSubagents--;
				if (state.activeSubagents < 0) state.activeSubagents = 0;
				finalized++;
			}
		} else {
			// No agent record — foreground run or a removed record. A foreground
			// run is live only while its run entry says 'running'.
			const runStatus = state.getRunEntries(session.ctx).find((r) => r.id === id)?.status;
			if (runStatus !== "running" && state.finalizeStaleLiveSubagent(id)) {
				finalized++;
			}
		}
	}

	return finalized;
}

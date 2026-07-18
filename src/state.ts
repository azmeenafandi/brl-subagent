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
	AVAILABLE_BACKENDS,
} from "./types";
import { cleanupRuns } from "./history";
import type { Logger } from "./logging";

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

	/** Loaded built-in presets */
	builtinPresets = new Array<import("./types").SubagentPreset>();

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
			presets: [],
			templates: [],
			circuitBreaker: this.defaultCircuitBreaker(),
			poolEnabled: false,
			poolSize: 2,
			slaTrackingEnabled: false,
			slaWindowSize: 50,
			defaultBackend: "pi",
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
			presets: this.config.presets,
			templates: this.config.templates,
			circuitBreaker: this.config.circuitBreaker,
			poolEnabled: this.config.poolEnabled,
			poolSize: this.config.poolSize,
			defaultBackend: this.config.defaultBackend,
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

		// Restore defaultBackend (E8)
		if (
			data.defaultBackend &&
			typeof data.defaultBackend === "string" &&
			AVAILABLE_BACKENDS.includes(data.defaultBackend)
		) {
			this.config.defaultBackend = data.defaultBackend;
		} else {
			this.config.defaultBackend = "pi";
		}

		if (Array.isArray(data.seenRunIds)) this.config.seenRunIds = data.seenRunIds;
		if (Array.isArray(data.presets)) this.config.presets = data.presets;
		if (Array.isArray(data.templates)) this.config.templates = data.templates;
		if (typeof data.poolEnabled === "boolean") this.config.poolEnabled = data.poolEnabled;
		if (typeof data.poolSize === "number" && data.poolSize >= 1 && data.poolSize <= 8) {
			this.config.poolSize = data.poolSize;
		}
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

	finalizeLiveSubagent(id: string): void {
		// Keep for a brief reset window, then clean up
		setTimeout(() => {
			this.subagentSessions.delete(id);
		}, 3000);
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
		this.config.defaultBackend = "pi";
		this.config.maxHistoryEntries = MAX_RUN_HISTORY_ENTRIES;
		this.config.sessionCostLimit = DEFAULT_SESSION_COST_LIMIT;
		this.config.perTaskCostEstimate = 0;
		this.config.templates = [];
		this.config.circuitBreaker = this.defaultCircuitBreaker();
		this.config.poolEnabled = false;
		this.config.slaTrackingEnabled = false;
		this.config.slaWindowSize = 50;
		this.config.lastSLAMetrics = undefined;
		this.config.poolSize = 2;
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

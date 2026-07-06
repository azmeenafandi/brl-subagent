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
} from "./types";
import {
	isSubagentStateShape,
	isSubagentRunShape,
	CUSTOM_ENTRY_TYPES,
} from "./types";
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
			maxSubagentDepth: 1,
			seenRunIds: [],
			presets: [],
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
			seenRunIds: this.config.seenRunIds,
			presets: this.config.presets,
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
		if (Array.isArray(data.seenRunIds)) this.config.seenRunIds = data.seenRunIds;
		if (Array.isArray(data.presets)) this.config.presets = data.presets;

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
		return ctx.sessionManager
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
	// Reset
	// -------------------------------------------------------------------

	reset(): void {
		this.config.model = undefined;
		this.config.maxThinkingLevel = "off";
		this.config.maxParallel = 0;
		this.config.maxSubagentDepth = 1;
	}
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createSessionState(log?: Logger): SessionState {
	return new SessionState(log);
}

/**
 * brl-subagent — Run History
 *
 * Manages subagent run records: creation, finalization, retry resolution,
 * and duration formatting.
 */

import type { SubagentRun, SubagentResult } from "./types";
import { isSubagentError, getFinalOutput, isSubagentRunShape, CUSTOM_ENTRY_TYPES, MAX_RUN_HISTORY_ENTRIES } from "./types";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Run pruning — R2: Disk usage policy
// ---------------------------------------------------------------------------

/**
 * Prune a SubagentRun array to keep only the newest entries up to maxEntries.
 * Uses startedAt timestamp for ordering (newest first). If maxEntries is 0,
 * returns all entries (no limit). Returns a new array; does not mutate input.
 */
export function cleanupRuns(
	runs: SubagentRun[],
	maxEntries: number = MAX_RUN_HISTORY_ENTRIES,
): SubagentRun[] {
	if (runs.length === 0) return [];
	if (maxEntries === 0) return runs;

	// Always sort newest-first for consistency, even when not truncating
	const sorted = [...runs].sort(
		(a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime(),
	);

	if (sorted.length <= maxEntries) return sorted;
	return sorted.slice(0, maxEntries);
}

/**
 * Prune run entries in the current session to at most maxEntries.
 * Gets all entries from the session, identifies run entries, prunes them via
 * cleanupRuns, and writes a prune marker entry back to the session.
 * Since session entries are append-only, actual old entries remain in the
 * session file but are filtered out at read time by getRunEntries (state.ts).
 * Returns the number of entries that were pruned.
 */
export function pruneSessionRuns(
	ctx: ExtensionContext,
	maxEntries: number = MAX_RUN_HISTORY_ENTRIES,
): number {
	const entries = ctx.sessionManager.getEntries();
	const runEntries: SubagentRun[] = [];

	for (const entry of entries) {
		if (
			entry.type === "custom" &&
			entry.customType === CUSTOM_ENTRY_TYPES.run &&
			entry.data &&
			isSubagentRunShape(entry.data)
		) {
			runEntries.push(entry.data);
		}
	}

	const pruned = cleanupRuns(runEntries, maxEntries);
	const prunedCount = runEntries.length - pruned.length;
	if (prunedCount <= 0) return 0;

	// Append a prune marker entry for reference (actual filtering is in getRunEntries)
	ctx.sessionManager.appendCustomEntry(CUSTOM_ENTRY_TYPES.run + ":prune", {
		prunedCount,
		keptCount: pruned.length,
		timestamp: Date.now(),
	});

	return prunedCount;
}

// ---------------------------------------------------------------------------
// Run record management
// ---------------------------------------------------------------------------

export function createEmptyResult(): SubagentResult {
	return {
		messages: [],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
		exitCode: 0,
		stderr: "",
	};
}

/**
 * Finalize a run record with results after the subagent completes.
 */
export function finalizeRunRecord(
	run: SubagentRun,
	result: SubagentResult,
	finalOutput: string,
	startTimestamp: number,
): void {
	const error = isSubagentError(result);
	run.status = error ? "failed" : "done";
	run.finishedAt = new Date().toISOString();
	run.durationMs = Date.now() - startTimestamp;
	run.cost = result.usage.cost;
	run.tokensIn = result.usage.input;
	run.tokensOut = result.usage.output;
	run.errorMessage = result.errorMessage;
	run.outputSummary = finalOutput.slice(0, 200);
	run.fullOutput = finalOutput || undefined;
}

// ---------------------------------------------------------------------------
// Retry parameter resolution
// ---------------------------------------------------------------------------

/**
 * Merge retry parameters: explicit params override original,
 * but task falls back to the original task if not provided.
 */
export function resolveRetryParams(
	params: {
		task: string;
		label?: string;
		preset?: string;
		systemPrompt?: string;
		inheritSystemPrompt?: boolean;
		thinkingLevel?: string;
		outputFile?: string;
		timeout?: number;
		cwd?: string;
		tools?: string[];
		excludeTools?: string[];
		noBuiltinTools?: boolean;
		retryRunId?: string;
		retryOnTimeout?: boolean;
	},
	run: SubagentRun,
): typeof params {
	const orig = run.originalParams;
	return {
		task: params.task || run.task,
		label: params.label ?? run.label,
		preset: params.preset ?? orig?.preset,
		systemPrompt: params.systemPrompt ?? orig?.systemPrompt,
		inheritSystemPrompt: params.inheritSystemPrompt ?? orig?.inheritSystemPrompt,
		thinkingLevel: params.thinkingLevel ?? orig?.thinkingLevel,
		outputFile: params.outputFile ?? orig?.outputFile,
		timeout: params.timeout ?? orig?.timeout,
		cwd: params.cwd ?? orig?.cwd,
		tools: params.tools ?? orig?.tools,
		excludeTools: params.excludeTools ?? orig?.excludeTools,
		noBuiltinTools: params.noBuiltinTools ?? orig?.noBuiltinTools,
		retryOnTimeout: params.retryOnTimeout,
	};
}

// ---------------------------------------------------------------------------
// Duration formatting
// ---------------------------------------------------------------------------

export function formatRunDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	const sec = (ms / 1000).toFixed(1);
	if (ms < 60_000) return `${sec}s`;
	const min = Math.floor(ms / 60_000);
	const secs = Math.round((ms % 60_000) / 1000);
	return `${min}m ${secs}s`;
}

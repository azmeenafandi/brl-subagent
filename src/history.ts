// Purpose: Run-record store: creation, finalization, retry lookup, and history pruning.
/**
 * brl-subagent — Run History
 *
 * Manages subagent run records: creation, finalization, retry resolution,
 * and duration formatting.
 */

import type { SubagentRun, SubagentResult } from "./types";
import { isSubagentError, getFinalOutput, isSubagentRunShape, classifyError, coherentFailureReason, CUSTOM_ENTRY_TYPES, MAX_RUN_HISTORY_ENTRIES, DEFAULT_OUTPUT_CAP_BYTES } from "./types";
import { isOutputTruncated } from "./sanitize";
import { transcriptDisplayPath } from "./transcript-path";
import type { ExtensionContext, SessionManager } from "@earendil-works/pi-coding-agent";

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
	// ctx.sessionManager is typed ReadonlySessionManager, but the runtime object
	// IS the full SessionManager (runner exposes it unwrapped) — appendCustomEntry
	// is the only way to persist a marker here (no `pi` handle in scope).
	(ctx.sessionManager as SessionManager).appendCustomEntry(CUSTOM_ENTRY_TYPES.run + ":prune", {
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
	// Issue #187: mirror the background finalize rule — a FAILED run always
	// records a terminal reason that AGREES with its status (coherentFailureReason
	// through the shared helper), while a non-failed run records whatever reason
	// the result carried (may be undefined, e.g. a success with no stopReason).
	run.stopReason = error
		? coherentFailureReason(result.stopReason, classifyError(result))
		: result.stopReason;
	run.outputSummary = finalOutput.slice(0, 200);
	run.fullOutput = finalOutput || undefined;
}

// ---------------------------------------------------------------------------
// Retry parameter resolution
// ---------------------------------------------------------------------------

/**
 * Merge retry parameters: explicit params override original,
 * but task falls back to the original task if not provided.
 *
 * The execution-shape keys (background, gitMode, approvalMode, force) follow
 * the same explicit-wins rule as everything else: an explicitly passed value
 * is honoured, otherwise the recorded value is restored. Fan-out unit records
 * (src/index.ts and unit-run.ts) snapshot their resolved unit params and do
 * NOT set these, so a retried unit stays a single foreground run.
 * `retryOnTimeout` is deliberately explicit-only: it arms a deadline for THIS
 * call, so it is never inherited. `template`, `chain`, `tasks`, `graph` and
 * `params` are not carried — a retried multi-step run degrades to a single task.
 */
export function resolveRetryParams(
	params: {
		// task is optional here by design: the retry path is reachable in
		// chain/parallel/graph modes where the top-level task is legitimately
		// absent — it falls back to the original run's task below.
		task?: string;
		label?: string;
		model?: string;
		preset?: string;
		systemPrompt?: string;
		inheritSystemPrompt?: boolean;
		thinkingLevel?: string;
		priority?: string;
		outputFile?: string;
		timeout?: number;
		cwd?: string;
		tools?: string[];
		excludeTools?: string[];
		noBuiltinTools?: boolean;
		retryRunId?: string;
		retryOnTimeout?: boolean;
		background?: boolean;
		gitMode?: string;
		approvalMode?: string;
		force?: boolean;
	},
	run: SubagentRun,
): typeof params {
	const orig = run.originalParams;
	return {
		task: params.task || run.task,
		label: params.label ?? run.label,
		model: params.model ?? orig?.model,
		preset: params.preset ?? orig?.preset,
		systemPrompt: params.systemPrompt ?? orig?.systemPrompt,
		inheritSystemPrompt: params.inheritSystemPrompt ?? orig?.inheritSystemPrompt,
		thinkingLevel: params.thinkingLevel ?? orig?.thinkingLevel,
		priority: params.priority ?? orig?.priority,
		outputFile: params.outputFile ?? orig?.outputFile,
		timeout: params.timeout ?? orig?.timeout,
		cwd: params.cwd ?? orig?.cwd,
		tools: params.tools ?? orig?.tools,
		excludeTools: params.excludeTools ?? orig?.excludeTools,
		noBuiltinTools: params.noBuiltinTools ?? orig?.noBuiltinTools,
		retryOnTimeout: params.retryOnTimeout,
		background: params.background ?? orig?.background,
		gitMode: params.gitMode ?? orig?.gitMode,
		approvalMode: params.approvalMode ?? orig?.approvalMode,
		force: params.force ?? orig?.force,
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

// ---------------------------------------------------------------------------
// Full-output honesty lines (issue #261)
// ---------------------------------------------------------------------------

/**
 * Human-readable size for an output cap, e.g. `100 * 1024` → "100 KB".
 * Byte caps are whole-KB by construction; sub-KB values (mostly tests) render
 * as plain bytes.
 */
function formatCapSize(capBytes: number): string {
	if (capBytes > 0 && capBytes % 1024 === 0) return `${capBytes / 1024} KB`;
	return `${capBytes} B`;
}

/**
 * Honest disclosure lines for a settled run's full-output view (issue #261).
 *
 * Always returns the transcript pointer. When the stored output hit the
 * `capBytes` cap it also adds a disclosure that points at the transcript for
 * the rest. Detection is deliberately two-signal:
 *
 *   1. `isOutputTruncated(run.fullOutput)` — the exact `capOutput` notice, true
 *      only when the stored text was genuinely truncated;
 *   2. `Buffer.byteLength` at/over `capBytes` — the length fallback, so an
 *      UNCAPPED record (background/crash paths store raw `liveOutput`) that
 *      already sits at or over the cap budget is still disclosed instead of
 *      pretending the panel can show more than the cap's worth.
 *
 * Boundary precision: `capOutput` truncates only when the byte length is
 * STRICTLY greater than the cap, so an output of exactly `capBytes` takes the
 * length branch and is disclosed as "at or over" without carrying the notice.
 * The notice branch alone is exact for "was truncated".
 *
 * Pure and pi-tui-free, so it is unit-testable in isolation.
 */
export function buildOutputHonestyLines(
	run: Pick<SubagentRun, "id" | "fullOutput">,
	capBytes: number = DEFAULT_OUTPUT_CAP_BYTES,
): string[] {
	const transcriptPath = transcriptDisplayPath(run.id);
	const lines = [`Transcript: ${transcriptPath}`];
	const output = run.fullOutput;
	const size = formatCapSize(capBytes);
	if (isOutputTruncated(output)) {
		lines.push(
			`Output was truncated at the ${size} cap — full text in the transcript: ${transcriptPath}`,
		);
	} else if (output && Buffer.byteLength(output, "utf8") >= capBytes) {
		lines.push(
			`Stored output is at or over the ${size} cap — full transcript: ${transcriptPath}`,
		);
	}
	return lines;
}

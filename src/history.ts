/**
 * brl-subagent — Run History
 *
 * Manages subagent run records: creation, finalization, retry resolution,
 * and duration formatting.
 */

import type { SubagentRun, SubagentResult } from "./types";
import { isSubagentError, getFinalOutput } from "./types";

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

// Purpose: The per-unit param merge (SubTask over global) and the unit display name, shared by chain/parallel/graph and the background fan-out.
/**
 * brl-subagent — per-unit params (cycle S1, ADR 0027 D6)
 *
 * `mergeSubTaskParams` and `displayTaskName` used to be closures inside
 * src/index.ts's default export. A closure cannot be imported, so the two
 * consumers that needed the real thing kept substitutes: a hand-maintained
 * replica in chain-parallel.test.ts and a SOURCE-TEXT ratchet in
 * integration.test.ts. Extracted here for the reason params.ts was extracted
 * (issue #59) — the tests drive the real function instead of a copy.
 *
 * The move is verbatim apart from the file's one captured binding:
 * `state.config.maxThinkingLevel` is now the `maxThinkingLevel` parameter, so
 * the merge reads no per-invocation state and stays a pure function of its
 * arguments.
 */

import {
	resolveThinkingLevel,
	type ApprovalMode,
	type GitMode,
	type Priority,
	type ResolvedParams,
	type SubTaskParams,
	type SubagentToolOptions,
	type ThinkingLevel,
} from "./types";

/** A merged unit: the fields every batch mode's spawn path reads. */
export type MergedSubTaskParams = {
	task: string;
	label: string | undefined;
	model: string | undefined;
	inheritSP: boolean;
	customSP: string | undefined;
	outputFile: string | undefined;
	timeout: number | undefined;
	effectiveCwd: string;
	thinkingLevel: ThinkingLevel;
	priority: Priority | undefined;
	toolOptions: SubagentToolOptions | undefined;
	resolvedGitMode: GitMode;
	resolvedApprovalMode: ApprovalMode;
};

/**
 * Merge global resolved params with a SubTaskParams.
 * SubTask fields override global fields. Tools/excludeTools/noBuiltinTools
 * are replaced entirely if set in the subTask, otherwise inherited from global.
 */
export function mergeSubTaskParams(
	globalParams: ResolvedParams & { resolvedGitMode: GitMode; resolvedApprovalMode: ApprovalMode },
	subTask: SubTaskParams,
	maxThinkingLevel: ThinkingLevel,
): MergedSubTaskParams {
	const mergedThinkingLevel = subTask.thinkingLevel
		? resolveThinkingLevel(
				subTask.thinkingLevel as ThinkingLevel,
				maxThinkingLevel,
			)
		: globalParams.thinkingLevel;

	const mergedTools = subTask.tools ?? globalParams.toolOptions?.tools;
	// Fix: edit depends on write in pi's tool system.
	const resolvedTools = mergedTools && mergedTools.includes("edit") && !mergedTools.includes("write")
		? [...mergedTools, "write"]
		: mergedTools;
	const mergedExcludeTools = subTask.excludeTools ?? globalParams.toolOptions?.excludeTools;
	const mergedNoBuiltinTools =
		subTask.noBuiltinTools ?? globalParams.toolOptions?.noBuiltinTools;

	const mergedToolOptions: SubagentToolOptions | undefined =
		resolvedTools || mergedExcludeTools || mergedNoBuiltinTools
			? {
					tools: resolvedTools,
					excludeTools: mergedExcludeTools,
					noBuiltinTools: mergedNoBuiltinTools,
				}
			: undefined;

	return {
		task: subTask.task || globalParams.task,
		label: subTask.label ?? globalParams.label,
		model: subTask.model,
		inheritSP: subTask.inheritSystemPrompt ?? globalParams.inheritSP,
		customSP: subTask.systemPrompt ?? globalParams.customSP,
		outputFile: subTask.outputFile ?? globalParams.outputFile,
		timeout: subTask.timeout ?? globalParams.timeout,
		effectiveCwd: subTask.cwd ?? globalParams.effectiveCwd,
		thinkingLevel: mergedThinkingLevel,
		// Issue #114: per-unit priority — undefined when the step declares none
		// (the caller then falls back to the call-level priority).
		priority: subTask.priority && ["critical", "high", "normal", "low"].includes(subTask.priority)
			? (subTask.priority as Priority)
			: undefined,
		toolOptions: mergedToolOptions,
		resolvedGitMode: globalParams.resolvedGitMode,
		resolvedApprovalMode: globalParams.resolvedApprovalMode,
	};
}

/**
 * Per-unit display name for validation prefixes: the label when present,
 * else the task truncated to 60 chars. Shared by the foreground parallel
 * pre-pass and the background fan-out pre-pass (issue #220) so a unit
 * renders identically in either shape.
 */
export function displayTaskName(merged: MergedSubTaskParams): string {
	return (
		merged.label ??
		(merged.task.length > 60 ? `${merged.task.slice(0, 57)}...` : merged.task)
	);
}

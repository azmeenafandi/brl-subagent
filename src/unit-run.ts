/**
 * Per-unit run-entry helpers extracted from src/index.ts (issue #132).
 *
 * Chain, parallel and graph modes each build a per-unit SubagentRun entry,
 * wrap onUpdate for live-monitor progress, and finalize the entry on the
 * success path. Those blocks were duplicated 4x/3x/3x; these helpers make the
 * behavior single-source. This is a behavior-identical refactor (the one
 * intentional delta: the mode-specific finalize debug line is replaced by a
 * single generic log inside finalizeUnitRun).
 *
 * The crash paths (buildCrashResult + finalizeLiveSubagent + finalizeRunRecord
 * + classify + persistRun + rethrow) and single mode's record block are NOT
 * extracted here — their labels and rethrow semantics differ.
 */

import type {
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type {
	SubagentResult,
	SubagentRun,
	SubagentToolOptions,
	Priority,
} from "./types";
import { getFinalOutput } from "./types";
import { snapshotOriginalParams } from "./params";
import { capOutput, stripAnsi } from "./sanitize";
import { finalizeRunRecord, pruneSessionRuns } from "./history";
import type { Logger } from "./logging";
import { SessionState } from "./state";

// ---------------------------------------------------------------------------
// Structural source for a per-unit run entry
// ---------------------------------------------------------------------------

/**
 * The per-unit fields shared by chain/parallel/graph modes (`merged` from
 * mergeSubTaskParams). Kept structural so the call sites verify by shape —
 * mergeSubTaskParams itself is not imported (it lives in index.ts).
 */
export interface UnitRunSource {
	task: string;
	label?: string;
	customSP?: string;
	inheritSP: boolean;
	model?: string;
	thinkingLevel: string;
	priority?: Priority;
	outputFile?: string;
	timeout?: number;
	effectiveCwd: string;
	toolOptions?: SubagentToolOptions;
}

// ---------------------------------------------------------------------------
// makeLiveOnUpdate
// ---------------------------------------------------------------------------

/**
 * Wrap a foreground `onUpdate` callback so partial results also stream into
 * the live monitor for this run's `runId`. Returns undefined when `onUpdate`
 * is undefined (the callers then pass the unwrapped value through).
 */
export function makeLiveOnUpdate(
	state: SessionState,
	runId: string,
	onUpdate?: AgentToolUpdateCallback<SubagentResult>,
): AgentToolUpdateCallback<SubagentResult> | undefined {
	return onUpdate
		? (partial: AgentToolResult<SubagentResult>) => {
				onUpdate(partial);
				if (partial.details) {
					state.updateLiveSubagent(
						runId,
						getFinalOutput(partial.details.messages),
						partial.details.usage.input,
						partial.details.usage.output,
						partial.details.liveTranscript,
					);
				}
			}
		: undefined;
}

// ---------------------------------------------------------------------------
// createUnitRun
// ---------------------------------------------------------------------------

/**
 * Create the per-unit SubagentRun entry for a chain/parallel/graph unit and
 * return it with a fresh runId (the runId doubles as the live id, so
 * sweepStaleLiveSubagents finds a 'running' record for every foreground live
 * entry). `priorityFloor` is the call-level floor for this mode; `source.priority`
 * wins when present. `presetName` feeds snapshotOriginalParams (issue #114
 * retry-snapshot visibility).
 */
export function createUnitRun(
	source: UnitRunSource,
	stepModel: { provider: string; id: string },
	priorityFloor: Priority,
	presetName?: string,
): { runId: string; run: SubagentRun } {
	const runId = crypto.randomUUID();
	const run: SubagentRun = {
		id: runId,
		task: source.task,
		label: source.label,
		// Issue #98 symmetry: the background entry carries the caller
		// label as `description` — kept separate from `label`.
		description: source.label,
		status: "running",
		model: `${stepModel.provider}/${stepModel.id}`,
		thinkingLevel: source.thinkingLevel,
		// Issue #114: per-unit priority wins; the call-level floor is the
		// fallback when the unit declares none. Issue #119 R3: snapshot the
		// RESOLVED priority so a retry of a fallback-priority unit restores the
		// same priority the run entry itself carried.
		priority: source.priority ?? priorityFloor,
		startedAt: new Date().toISOString(),
		originalParams: snapshotOriginalParams({
			systemPrompt: source.customSP,
			inheritSystemPrompt: source.inheritSP,
			model: source.model,
			thinkingLevel: source.thinkingLevel,
			priority: source.priority ?? priorityFloor,
			outputFile: source.outputFile,
			timeout: source.timeout,
			cwd: source.effectiveCwd,
			tools: source.toolOptions?.tools,
			excludeTools: source.toolOptions?.excludeTools,
			noBuiltinTools: source.toolOptions?.noBuiltinTools,
			preset: presetName,
		}),
	};
	return { runId, run };
}

// ---------------------------------------------------------------------------
// finalizeUnitRun
// ---------------------------------------------------------------------------

/**
 * Finalize a per-unit run entry on the success path: status/duration/cost/
 * tokens/sanitized output land on the entry, the errorCategory is classified
 * onto originalParams, the entry is persisted, run history is pruned past
 * maxHistoryEntries, and the live entry is released. `runId` is `run.id` (the
 * run entry carries the same id used as the live id).
 */
export function finalizeUnitRun(
	state: SessionState,
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	run: SubagentRun,
	result: SubagentResult,
	log: Logger,
): void {
	const finalOutput = capOutput(stripAnsi(getFinalOutput(result.messages)));
	finalizeRunRecord(run, result, finalOutput, new Date(run.startedAt).getTime());
	run.originalParams = { ...run.originalParams, errorCategory: result.errorCategory };
	state.persistRun(pi, run);
	if (state.config.maxHistoryEntries > 0) {
		const p = pruneSessionRuns(ctx, state.config.maxHistoryEntries);
		if (p > 0) log.debug("Run history pruned", { pruned: p });
	}
	state.finalizeLiveSubagent(run.id);
	log.debug("Unit run finalized", { runId: run.id, status: run.status });
}

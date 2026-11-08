// Purpose: The three foreground batch-mode runners (chain, parallel, graph) plus their per-unit helpers, built over one runtime context.
/**
 * brl-subagent — the mode runners (cycle S2, ADR 0027 D1/D3/D6)
 *
 * `runChainMode`, `runParallelMode` and `runGraphMode` used to be closures
 * inside `src/index.ts`'s default export, alongside the two per-unit helpers
 * they share (`resolveStepModel`, `applyUnitShapeGuard`) and the two record
 * mappings (`graphTaskToSubTaskParams`, `toSubTaskResult`). ~1,300 lines of the
 * composition root were the mode implementations themselves.
 *
 * D3: this module may import the `src/*.ts` modules it needs, and NOT the
 * composition root — `architecture-rules` forbids a non-entry module importing
 * `index.ts`. The three bindings the moved bodies read from their old closure
 * (`pi`, `log`, `state`) arrive as the `RuntimeContext` argument; everything else
 * they touch was already a module import.
 *
 * The move is verbatim. `createModeRunners` destructures its context on its
 * first lines and the bodies carry their original indentation, so a body line
 * that differs from 46b427e is a bug in this commit, not a refactor: the diff is
 * moves plus the alias wrapper. Notably NOT part of the wrapper: an adapter
 * object, a re-stated signature per call, or a fourth context field (ADR 0027
 * F1 — a runner needing one means the split is wrong).
 *
 * The factory's return properties ARE the interface the composition root
 * consumes. Only `BatchGuardContext` is exported as a type: `execute` builds it
 * and, until S3, `runBackgroundFanOut` takes it as a parameter.
 */

import type { RuntimeContext } from "./runtime";
import type { AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { acquireSlot, releaseSlot, repaintStatus } from "./concurrency";
import { Intercom } from "./messaging";
import { runModePrologue } from "./mode-prologue";
import { modelIsAvailable, parseModelString } from "./model-availability";
import { shouldDropUnitTimeout, THINKING_UNIT_TIMEOUT_DROP_NOTICE, type UnitShape } from "./params";
import { formatValidationWarnings, rejection, resolveModeModel, validateUnitPrePass } from "./prelude";
import { buildSubagentPrompt, describePromptMode } from "./prompt";
import { runSubagent } from "./runner";
import { buildCrashResult, capOutput, sanitizeErrorMessage } from "./sanitize";
import { topologicalSort, validateGraph } from "./scheduler";
import { describeWorktreeState } from "./worktree-report";
import {
	EMPTY_USAGE,
	DEFAULT_PRIORITY,
	PREVIOUS_OUTPUT_PLACEHOLDER,
	GRAPH_OUTPUT_PLACEHOLDER_RE,
	getFinalOutput,
	isSubagentError,
	countSubagentOutcomes,
	classifyError,
	type ChainDetails,
	type DelegateTaskDetails,
	type DelegateTaskParams,
	type GraphDetails,
	type GraphTask,
	type GraphWave,
	type ParallelDetails,
	type Priority,
	type SubagentResult,
	type SubagentRun,
	type SubTaskParams,
	type SubTaskResult,
	type ThinkingLevel,
	type ToolResult,
} from "./types";
import { displayTaskName, mergeSubTaskParams, type MergedSubTaskParams } from "./unit-params";
import { createUnitRun, finalizeUnitRun, finalizeUnitRunCrash, makeLiveOnUpdate, pruneHistoryIfNeeded, registerLiveRun } from "./unit-run";

/**
 * Issue #434: what every unit of ONE dispatch needs from the dispatch-level
 * pre-flight — threaded from `execute` into the four batch handlers, never
 * re-derived at a unit site.
 *
 *   - `processChecks` is the project opt-in `execute` already resolved from the
 *     dispatch's OWN cwd. Re-reading it per unit (from a relative
 *     `params.cwd`) judges a different directory than the dispatch did.
 *   - `dispatchDeclaredLevel` is the declared (uncapped) level the dispatch arm
 *     judged, so a unit that declares only a `timeout` is still judged against
 *     the thinking level it actually inherits.
 *   - `force` and `unitShape` are the dispatch-level facts the unit projection
 *     asks for; `params` is in scope at every unit site, so passing them here is
 *     what keeps the predicate's inputs in ONE place.
 *   - `noticeEmitted` is the one-shot flag on this shared object (all handlers
 *     received the same reference): the unit projection emits AT MOST one
 *     additional notice per dispatch, and a dispatch-arm notice starts it true
 *     (the drop still happens — the deadline is the hazard, the notice is the
 *     report). A flag on the shared context, not a boolean copy, because the
 *     first unit to reach its run is whichever won the slot, not the first in
 *     the array.
 */
export interface BatchGuardContext {
	processChecks: boolean;
	dispatchDeclaredLevel: ThinkingLevel | undefined;
	/** The dispatch's `force` — the override applies to every unit of it. */
	force: boolean | undefined;
	unitShape: UnitShape;
	/** True once any notice for this dispatch went out — mutated at the unit site. */
	noticeEmitted: boolean;
}

/**
 * The five functions `createModeRunners` hands the composition root. Declared
 * once as the module's public contract rather than inferred: the return
 * statement is checked against it, so a runner whose signature drifts is a
 * compile error here instead of a surprise at the `execute` call site. S3
 * receives these as its function dependencies — the properties, not the module.
 */
interface ModeRunners {
	runChainMode: (
		params: DelegateTaskParams,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<DelegateTaskDetails> | undefined,
		ctx: ExtensionContext,
		guard: BatchGuardContext,
	) => Promise<ToolResult<SubagentResult | ChainDetails | undefined>>;
	runParallelMode: (
		params: DelegateTaskParams,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<DelegateTaskDetails> | undefined,
		ctx: ExtensionContext,
		guard: BatchGuardContext,
	) => Promise<ToolResult<SubagentResult | ParallelDetails | undefined>>;
	runGraphMode: (
		params: DelegateTaskParams,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<DelegateTaskDetails> | undefined,
		ctx: ExtensionContext,
		guard: BatchGuardContext,
	) => Promise<ToolResult<SubagentResult | GraphDetails | undefined>>;
	resolveStepModel: (
		ctx: ExtensionContext,
		stepModel: string | undefined,
		globalModel: { provider: string; id: string },
	) => { provider: string; id: string };
	applyUnitShapeGuard: (
		ctx: ExtensionContext,
		guard: BatchGuardContext,
		step: SubTaskParams,
		merged: MergedSubTaskParams,
	) => void;
}

/**
 * Build the three batch-mode runners over one runtime context (ADR 0027 D1).
 *
 * The destructure is the whole point of the wrapper: it re-creates, as locals,
 * the three names the bodies read from their old closure, so every moved
 * statement stays byte-identical. Nothing else is captured — `createModeRunners`
 * allocates no state of its own, so two contexts produce two independent runner
 * sets over two independent stores (the S2 boundary test pins exactly that).
 */
export function createModeRunners(rt: RuntimeContext): ModeRunners {
	const { pi, log, state } = rt;

/**
 * Issue #381 (audit D4): the one graph-node → SubTaskParams mapping, shared by
 * the graph pre-pass and the per-wave dispatch. GraphTask is a structural
 * superset of SubTaskParams, so the node-only scheduling fields are dropped by
 * destructuring instead of re-listing every per-subtask field — a field added
 * to either type can no longer be silently forgotten at one of the two sites.
 */
function graphTaskToSubTaskParams(node: GraphTask): SubTaskParams {
	const { id: _id, dependsOn: _dependsOn, ...subTask } = node;
	return subTask;
}

/**
 * Issue #376 (audit D3): the one `SubagentResult` → `SubTaskResult` field
 * mapping, shared by every dispatch mode (chain, parallel, graph). The ten
 * assignments plus the error classification were copied per mode, so a field
 * added to `SubTaskResult` could be silently forgotten at one of the sites —
 * and `errorCategory` could be passed through unclassified. Callers add their
 * own mode-specific fields (`step`/`task`/`label`) around this mapping.
 *
 * Issue #474: the failure-only `worktreeState` rides the same mapping, probed at
 * `cwd` — the unit's OWN resolved cwd, which the caller has and this function
 * cannot guess. It is a subprocess read, so it runs only for a FAILED unit
 * (successful runs pay nothing and carry no block).
 */
function toSubTaskResult(
	result: SubagentResult,
	cwd: string,
): Pick<
	SubTaskResult,
	| "exitCode"
	| "messages"
	| "stderr"
	| "usage"
	| "model"
	| "stopReason"
	| "errorMessage"
	| "errorCategory"
	| "gitBranch"
	| "gitDiff"
	| "worktreeState"
> {
	return {
		exitCode: result.exitCode,
		messages: result.messages,
		stderr: result.stderr,
		usage: result.usage,
		model: result.model,
		stopReason: result.stopReason,
		errorMessage: result.errorMessage,
		// The classification path is part of the mapping: every mode derives the
		// category from the raw result, never from the runner's own field.
		errorCategory: classifyError(result),
		gitBranch: result.gitBranch,
		gitDiff: result.gitDiff,
		...(isSubagentError(result) ? { worktreeState: describeWorktreeState(cwd) } : {}),
	};
}

/**
 * Issue #474: the `SubTaskResult` an allSettled REJECTION earns.
 *
 * Before this, a unit whose run threw (and whose crash finalizer rethrew) was
 * logged and then silently dropped from the aggregate; every other unit's row
 * survived, so the conductor read a shorter list as "nothing failed there".
 * The synthesized row states the failure, carries the unit's own worktree block
 * and classifies through the SAME `classifyError` as a real result (a subagent
 * with this shape classifies identically — exitCode 1, the sanitized reason).
 */
function rejectedUnitResult(
	task: string,
	label: string | undefined,
	cwd: string,
	reason: unknown,
): SubTaskResult {
	const entry: SubTaskResult = {
		task,
		label,
		exitCode: 1,
		messages: [],
		// The raw reason persists for post-mortems, like a real unit's stderr;
		// `errorMessage` is the sanitized half the conductor reads.
		stderr: String(reason),
		usage: { ...EMPTY_USAGE },
		errorMessage: sanitizeErrorMessage(
			reason instanceof Error ? reason.message || String(reason) : String(reason),
			cwd,
		),
		worktreeState: describeWorktreeState(cwd),
	};
	entry.errorCategory = classifyError(entry);
	return entry;
}
	// C3: Resolve a step's model override (step.model > global resolved model).
	// Parsed + availability-checked; falls back to the global model on failure.
	function resolveStepModel(
		ctx: ExtensionContext,
		stepModel: string | undefined,
		globalModel: { provider: string; id: string },
	): { provider: string; id: string } {
		if (stepModel) {
			const parsed = parseModelString(stepModel);
			if (!parsed) {
				log.warn("Step model is not a valid provider/model-id, falling back to global model", { model: stepModel });
			} else if (modelIsAvailable(ctx.modelRegistry, parsed)) {
				log.info("Using step model override", { model: stepModel });
				return parsed;
			} else {
				log.warn("Step model unavailable, falling back to global model", { model: stepModel });
			}
		}
		return globalModel;
	}

	/**
	 * Issue #434: apply the dispatch pre-flight's UNIT projection to one merged
	 * unit — `merged.timeout = undefined` before the unit's run record exists, so
	 * the retry snapshot records an absent deadline (ADR 0009) and no
	 * `createUnitRun`/`startBackgroundAgent` ever sees it. The decision itself
	 * lives in `shouldDropUnitTimeout` (params.ts): re-stating the condition here
	 * is the drift #361's resolver extraction exists to prevent.
	 *
	 * EVERY input is threaded (`ctx`'s guard) or the unit's own declaration
	 * (`step`) — the unit site reads no config, no manifest and no cap of its
	 * own. `merged.thinkingLevel` is deliberately not an input: it is the capped
	 * level, and the default cap would silently disable the guard.
	 *
	 * Emission discipline (issue #434 [c2]): called from the unit's dispatch
	 * point, AFTER its slot is held and immediately BEFORE its run — a pre-pass
	 * would announce a unit that a cancellation can still skip. At most ONE
	 * notice per dispatch: a dispatch-arm notice suppresses this one entirely
	 * (the drop still happens — the deadline is the hazard, the notice is the
	 * report), and the first unit to reach its run claims it.
	 */
	function applyUnitShapeGuard(
		ctx: ExtensionContext,
		guard: BatchGuardContext,
		step: SubTaskParams,
		merged: MergedSubTaskParams,
	): void {
		const shouldDrop = shouldDropUnitTimeout({
			processChecks: guard.processChecks,
			force: guard.force,
			dispatchDeclaredLevel: guard.dispatchDeclaredLevel,
			unitShape: guard.unitShape,
			declaredLevel: step.thinkingLevel as ThinkingLevel | "" | undefined,
			declaredTimeout: step.timeout,
			mergedTimeout: merged.timeout,
		});
		if (!shouldDrop) return;

		const previousTimeout = merged.timeout;
		const unit = displayTaskName(merged);
		const effectiveLevel = step.thinkingLevel || guard.dispatchDeclaredLevel;
		// The drop precedes `createUnitRun`: that is what makes the recorded
		// `originalParams.timeout` absent, so a retry re-derives instead of
		// restoring the cap (ADR 0009). A drop after it passes every
		// runner-argument assertion and still restores the deadline on retry.
		merged.timeout = undefined;
		log.info("Dispatch pre-flight: unit-declared timeout dropped, unit stays foreground", {
			unit,
			thinkingLevel: effectiveLevel,
			previousTimeout,
		});
		if (!guard.noticeEmitted) {
			guard.noticeEmitted = true;
			pi.sendMessage({
				customType: "delegate-notification",
				content: THINKING_UNIT_TIMEOUT_DROP_NOTICE,
				display: true,
				details: {
					unit,
					thinkingLevel: effectiveLevel,
					// The ACTUAL ms value, mirroring the dispatch drop arm: the
					// friction log needs the number to tell a budget cap from a clock.
					previousTimeout,
				},
			}, { deliverAs: "followUp" });
			ctx.ui.notify(THINKING_UNIT_TIMEOUT_DROP_NOTICE, "warning");
		}
	}

	// -------------------------------------------------------------------
	// P1: runChainMode
	// -------------------------------------------------------------------

	async function runChainMode(
		params: DelegateTaskParams,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<DelegateTaskDetails> | undefined,
		ctx: ExtensionContext,
		guard: BatchGuardContext,
	): Promise<ToolResult<SubagentResult | ChainDetails | undefined>> {
		const chainSteps: SubTaskParams[] = params.chain!;

		// Issue #133: dispatch-start timestamp — the aggregate run entry's
		// startedAt (captured once, at mode entry, not at completion).
		const chainModeStartedAt = new Date().toISOString();

		// Mode prologue (issue #379): cost → depth → resolve → targets →
		// preflight → H1, the sequence every batch mode shares (mode-prologue.ts).
		// Chain's per-mode inputs are only the label and the unit count; H1 here
		// validates the MODE-level params (top-level tasks are empty, so only the
		// hard outputFile-vs-write conflict applies), while every step's own
		// cwd/outputFile/tools belong to the per-step pass below (issue #222).
		const pro = runModePrologue({
			params,
			state,
			ctx,
			log,
			label: "Chain",
			units: chainSteps.length,
		});
		if (!pro.ok) return pro.error;
		const { globalParams, resolvedCwd, currentDepth } = pro;

		// Per-step pre-pass (issue #222): resolve + validate EVERY step before
		// any spawn, so a single bad step rejects the chain with nothing
		// started — the same all-before-any-spawn semantics the background
		// fan-out and the parallel `tasks` shape use. Chain steps are fully
		// known up front and a step's cwd/outputFile never depend on a previous
		// step's output (only its TASK text consumes {previous}), so the pass
		// can run up front — and must, because discovering step 5's bad cwd
		// after four steps already ran would waste their whole budget.
		const stepPass = validateUnitPrePass({
			units: chainSteps,
			label: "Chain",
			gitMode: globalParams.resolvedGitMode,
			ctx,
			log,
			force: params.force as boolean | undefined,
			noJev: params.noJev,
			// Issue #443: the DECLARED per-step level (the merged one is resolved).
			declaredThinkingLevel: (step) => step.thinkingLevel,
			merge: (step) =>
				mergeSubTaskParams(globalParams, step, state.config.maxThinkingLevel),
			describe: (_step, merged, i) => ({
				prefix: `Step ${i + 1} ("${displayTaskName(merged)}")`,
				logContext: { step: i + 1 },
			}),
		});
		if (!stepPass.ok) return stepPass.error;
		const stepCwds = stepPass.units.map((u) => u.cwd);
		const stepWarnings = stepPass.warnings;

		// Mode tail (issue #379): resolve the model (preset + per-call override,
		// auto-route included in `resolvedPreset`), reject an empty resolution,
		// then the circuit breaker. It runs AFTER the per-step pass — IN8 keeps
		// a bad step's rejection ahead of an unconfigured model.
		const tail = resolveModeModel({
			state,
			ctx,
			log,
			preset: globalParams.resolvedPreset,
			perCallModel: params.model,
		});
		if (!tail.ok) return tail.error;
		const subagentModel = tail.model;
		const modelStr = tail.modelStr;

		// Resolve priority (issue #114: no config knob — the call-level default)
		const chainPriority: Priority = (
			params.priority && ["critical", "high", "normal", "low"].includes(params.priority as string)
				? (params.priority as Priority)
				: DEFAULT_PRIORITY
		);

		// Acquire concurrency slot for the chain
		const acquired = await acquireSlot(state, ctx, signal, chainPriority);
		if (!acquired) {
			return {
				content: [
					{
						type: "text" as const,
						text: "Chain cancelled while waiting for concurrency slot.",
					},
				],
				details: undefined,
				isError: true,
			};
		}

		let chainSuccess = false;
		try {
			const basePrompt = ctx.getSystemPrompt();
			let previousOutput = "";
			const chainResults: SubTaskResult[] = [];
			let stoppedEarly = false;

			for (let i = 0; i < chainSteps.length; i++) {
				const step = chainSteps[i];

				// Merge params for this step
				const merged = mergeSubTaskParams(globalParams, step, state.config.maxThinkingLevel);

				// Issue #434: the unit projection of the dispatch pre-flight (#412/#431).
				// A chain holds its ONE mode-level slot across the whole loop, so the
				// slot is already held here; the drop lands BEFORE `createUnitRun`
				// below, or the retry snapshot would restore the deadline (ADR 0009).
				applyUnitShapeGuard(ctx, guard, step, merged);

				// C3: Resolve this step's model override (step.model > global resolved model)
				const stepModel = resolveStepModel(ctx, merged.model, subagentModel);

				// Substitute {previous} placeholder
				merged.task = merged.task.replaceAll(
					PREVIOUS_OUTPUT_PLACEHOLDER,
					previousOutput,
				);

				// Build system prompt
				const subagentPrompt = buildSubagentPrompt(
					basePrompt,
					merged.inheritSP,
					merged.customSP,
					merged.outputFile,
					merged.toolOptions?.tools,
					globalParams.resolvedPreset?.promptGuideline,
				);

				// Create SubTaskResult for this step
				const subTaskResult: SubTaskResult = {
					step: i + 1,
					task: merged.task,
					label: merged.label,
					exitCode: 0,
					messages: [],
					stderr: "",
					usage: { ...EMPTY_USAGE },
				};

				// Issue #133: status-bar breakdown — the mode context shows the
				// current step while the dispatch is in flight.
				state.modeContext = {
					kind: "chain",
					step: i + 1,
					totalSteps: chainSteps.length,
				};
				// Issue #133: render the breakdown — the chain holds ONE mode-level
				// slot (acquired at mode start, released in the finally), so no
				// per-step acquire/release calls repaintStatus while the
				// mode context is set. Call it directly here (mirrors how the
				// graph path's per-node slot operations trigger the render).
				repaintStatus(state, ctx);

				// Emit initial progress for this step
				const modeInfo = describePromptMode(
					merged.inheritSP,
					Boolean(merged.customSP),
				);
				onUpdate?.({
					content: [
						{
							type: "text" as const,
							text: `Chain step ${i + 1}/${chainSteps.length} (${modeInfo})...`,
						},
					],
					details: {
						messages: [],
						usage: { ...EMPTY_USAGE },
						exitCode: -1,
						stderr: "",
					},
				});

				// Issue #133: per-step run entry — mirrors runParallelMode's
				// per-unit block (issue #119): the runId doubles as the live id,
				// so sweepStaleLiveSubagents finds a 'running' record for every
				// foreground live entry (the #130 invariant gap that swept
				// graph/chain entries immediately).
				const { runId, run } = createUnitRun(merged, stepModel, chainPriority, globalParams.resolvedPreset?.name, state.config.recovery);
				state.persistRun(pi, run, "unit");

				// R2: Prune old run entries if history exceeds limit
				pruneHistoryIfNeeded(state, ctx, log);

				// Register for live monitor — chain steps now appear in the
				// drill-in under the runId (issue #133 single identity, mirrors
				// parallel mode's issue #119 registration). Fall back to
				// "Step N" when the step carries no label (liveRowName would
				// otherwise show the truncated task).
				registerLiveRun(state, run, ctx, merged.label ?? `Step ${i + 1}`, merged.timeout);

				// Wrap onUpdate so the live monitor sees per-step progress
				// (mirrors parallel mode's taskOnUpdate).
				const stepOnUpdate = makeLiveOnUpdate(state, runId, onUpdate);

				// Run the subagent for this step — crash-protected (issue #130,
				// #133 R1/C1 discipline): a throw must finalize the run entry as
				// failed AND release the live entry, or the persisted record stays
				// 'running' forever. finalizeLiveSubagent is idempotent; the
				// rethrow is handled by the mode's existing outer catch (chain is
				// sequential — no sibling wave to cancel).
				let result: SubagentResult;
				try {
					result = await runSubagent(
						// Issue #222: this step's OWN validated cwd (the pre-pass
						// resolved it against ctx.cwd) — the mode-level
						// resolvedCwd is the fallback for steps that declare none.
						stepCwds[i],
						subagentPrompt,
						stepModel,
						merged.thinkingLevel,
						merged.task,
						signal,
						stepOnUpdate,
						merged.toolOptions,
						merged.timeout,
						getFinalOutput,
						log,
						currentDepth + 1,
						undefined, // intercom
						undefined, // subagentId
						run.childMarker,
					);
				} catch (err) {
					// Issue #133 (mirrors the #119 R1/C1 discipline): finalize the
					// run entry as failed — crashOutput comes from the live entry's
					// last streamed output (the crash result itself has no
					// messages), and errorCategory is classified onto originalParams.
					finalizeUnitRunCrash(state, pi, run, err, "Chain step", stepCwds[i], log, {
						step: i + 1,
					});
				}

				// Issue #133: finalize the per-step run entry — status, duration,
				// cost, tokens and sanitized output land on the entry (mirrors
				// parallel's issue #119 finalize; result carries the SubagentResult
				// shape finalizeRunRecord expects, errorCategory included).
				finalizeUnitRun(state, pi, ctx, run, result, log);

				// Fill SubTaskResult (one shared field mapping — issue #376/D3).
				// Issue #474: the step's OWN cwd, so a failed step reports the tree
				// it ran in rather than the dispatch's.
				Object.assign(subTaskResult, toSubTaskResult(result, stepCwds[i]));

				chainResults.push(subTaskResult);

				// Emit update with current ChainDetails
				const completedSteps = chainResults.length;
				const currentDetails: ChainDetails = {
					mode: "chain",
					results: chainResults,
					totalInput: chainResults.reduce(
						(s, r) => s + r.usage.input,
						0,
					),
					totalOutput: chainResults.reduce(
						(s, r) => s + r.usage.output,
						0,
					),
					totalCost: chainResults.reduce(
						(s, r) => s + r.usage.cost,
						0,
					),
					totalTurns: chainResults.reduce(
						(s, r) => s + r.usage.turns,
						0,
					),
					completedSteps,
					totalSteps: chainSteps.length,
					stoppedEarly: false,
				};

				const stepFailed = isSubagentError(result);
				onUpdate?.({
					content: [
						{
							type: "text" as const,
							text: `Chain step ${completedSteps}/${chainSteps.length} completed${stepFailed ? " (failed)" : ""}`,
						},
					],
					details: currentDetails,
				});

				// Stop on failure (unless this was the last step)
				if (stepFailed && i < chainSteps.length - 1) {
					stoppedEarly = true;
					break;
				}

				// Set previous output for the next step
				previousOutput = getFinalOutput(result.messages);
			}

			chainSuccess = countSubagentOutcomes(chainResults).failed === 0;

			// Compute aggregated totals
			const totalInput = chainResults.reduce(
				(s, r) => s + r.usage.input,
				0,
			);
			const totalOutput = chainResults.reduce(
				(s, r) => s + r.usage.output,
				0,
			);
			const totalCost = chainResults.reduce(
				(s, r) => s + r.usage.cost,
				0,
			);
			const totalTurns = chainResults.reduce(
				(s, r) => s + r.usage.turns,
				0,
			);

			const chainDetails: ChainDetails = {
				mode: "chain",
				results: chainResults,
				totalInput,
				totalOutput,
				totalCost,
				totalTurns,
				completedSteps: chainResults.length,
				totalSteps: chainSteps.length,
				stoppedEarly,
			};

			// R1: Record circuit breaker outcome
			if (chainSuccess) {
				state.recordSuccess();
			} else {
				state.recordFailure();
			}

			log.info("Chain completed", {
				totalSteps: chainSteps.length,
				completedSteps: chainResults.length,
				stoppedEarly,
				totalInput,
				totalOutput,
				totalCost,
			});

			// Issue #133: one aggregate run entry per chain dispatch — fresh id,
			// persisted ONCE as done (no live entry: the drill-in shows the
			// per-step entries while running; the aggregate is a post-hoc audit
			// summary). Fields come from the dispatch-level resolved values and
			// the aggregate totals; startedAt is the mode-entry timestamp.
			const chainAggregateRun: SubagentRun = {
				id: crypto.randomUUID(),
				task: `Chain dispatch: ${chainSteps.length} steps`,
				label: globalParams.label ?? "chain",
				// Issue #133: persist the ACTUAL outcome — "failed" when any step
				// failed (chainSuccess === false), "done" otherwise.
				status: chainSuccess ? "done" : "failed",
				model: `${subagentModel.provider}/${subagentModel.id}`,
				thinkingLevel: globalParams.thinkingLevel,
				priority: chainPriority,
				startedAt: chainModeStartedAt,
				finishedAt: new Date().toISOString(),
				durationMs: Date.now() - new Date(chainModeStartedAt).getTime(),
				cost: totalCost,
				tokensIn: totalInput,
				tokensOut: totalOutput,
				outputSummary: capOutput(JSON.stringify(chainDetails, null, 2)),
			};
			state.persistRun(pi, chainAggregateRun);

			// Per-step validation warnings ride the result, prefixed with their
			// step (issue #222), after the JSON payload — empty renders nothing so
			// warning-free results stay byte-identical.
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(chainDetails, null, 2) + formatValidationWarnings(stepWarnings),
					},
				],
				details: chainDetails,
			};
		} catch (err) {
			// F7 (issue #65): err.message may embed absolute paths — sanitize
			// BEFORE it reaches the main agent's context (tool result content +
			// details.errorMessage). resolvedCwd is the validated subagent cwd.
			const result = buildCrashResult("Chain mode", err, resolvedCwd);
			log.error("Chain mode crashed", { error: result.details.errorMessage });
			return result;
		} finally {
			// Issue #133: clear the status-bar mode breakdown — the dispatch is
			// over (success or outer-catch crash).
			state.modeContext = undefined;
			releaseSlot(state, chainSuccess, ctx);
		}
	}

	// -------------------------------------------------------------------
	// P2: runParallelMode
	// -------------------------------------------------------------------

	async function runParallelMode(
		params: DelegateTaskParams,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<DelegateTaskDetails> | undefined,
		ctx: ExtensionContext,
		guard: BatchGuardContext,
	): Promise<ToolResult<SubagentResult | ParallelDetails | undefined>> {
		const taskList: SubTaskParams[] = params.tasks!;

		// Mode prologue (issue #379): cost → depth → resolve → targets →
		// preflight → H1, the sequence every batch mode shares (mode-prologue.ts).
		// Parallel's per-mode inputs are only the label and the unit count; H1
		// validates the MODE-level params (top-level tasks are empty, so only the
		// hard outputFile-vs-write conflict applies — issue #34), while every
		// task's own cwd/outputFile/tools belong to the per-task pass below.
		const pro = runModePrologue({
			params,
			state,
			ctx,
			log,
			label: "Parallel",
			units: taskList.length,
		});
		if (!pro.ok) return pro.error;
		const { globalParams, resolvedCwd, currentDepth } = pro;

		// Per-task pre-pass (issue #220, extended by #222): validate EVERY task
		// before any spawn, so a single bad task rejects the batch with nothing
		// started (`force` degrades capability errors to warnings) — the same
		// semantics runBackgroundFanOut applies. Each task's OWN cwd is resolved
		// and validated here (with its outputFile, resolved against that cwd) and
		// the resolved value is what that task spawns in — issue #222 closed the
		// gap where a per-task `cwd` was merged but the spawn still used the
		// mode-level cwd. Per-task warnings are prefixed with their unit and
		// collected here to ride the final result. The mode-entry validation
		// above stays for the mode-level outputFile (issue #34).
		const taskPass = validateUnitPrePass({
			units: taskList,
			label: "Parallel",
			gitMode: globalParams.resolvedGitMode,
			ctx,
			log,
			force: params.force as boolean | undefined,
			noJev: params.noJev,
			// Issue #443: the DECLARED per-task level (the merged one is resolved).
			declaredThinkingLevel: (task) => task.thinkingLevel,
			merge: (task) =>
				mergeSubTaskParams(globalParams, task, state.config.maxThinkingLevel),
			describe: (_task, merged, i) => ({
				prefix: `Task ${i + 1} ("${displayTaskName(merged)}")`,
				logContext: { task: i + 1 },
			}),
		});
		if (!taskPass.ok) return taskPass.error;
		// Parallel index → the task's own validated cwd (issue #222).
		const taskCwds = taskPass.units.map((u) => u.cwd);
		const taskWarnings = taskPass.warnings;

		// Mode tail (issue #379): model resolution (preset + per-call override,
		// auto-route included in `resolvedPreset`), the empty-model rejection and
		// the circuit check. Runs AFTER the per-task pass (IN8).
		const tail = resolveModeModel({
			state,
			ctx,
			log,
			preset: globalParams.resolvedPreset,
			perCallModel: params.model,
		});
		if (!tail.ok) return tail.error;
		const subagentModel = tail.model;
		const modelStr = tail.modelStr;

		// Build base prompt once
		const basePrompt = ctx.getSystemPrompt();

		// Results array — final positions match taskList indices
		const results: SubTaskResult[] = [];
		let completedCount = 0;

		// E10: Intercom for subagent-to-subagent messaging
		const intercom = new Intercom();

		// Individual task runner (captures merged params, runs subagent)
		const runTask = async (
			index: number,
			merged: MergedSubTaskParams,
			unitCwd: string,
		): Promise<boolean> => {

			// Issue #434: the unit projection of the dispatch pre-flight. Applied
			// HERE, not in the launcher's pre-merge: the launcher awaits
			// `acquireSlot` and only then calls this, so a unit cancelled while
			// waiting for its slot is never announced (and never dropped). The
			// drop still precedes `createUnitRun` below, so the retry snapshot
			// records an absent deadline rather than restoring the cap.
			applyUnitShapeGuard(ctx, guard, taskList[index], merged);

			// C3: Resolve this step's model override (step.model > global resolved model)
			const stepModel = resolveStepModel(ctx, merged.model, subagentModel);

			// Build system prompt for this task
			const subagentPrompt = buildSubagentPrompt(
				basePrompt,
				merged.inheritSP,
				merged.customSP,
				merged.outputFile,
				merged.toolOptions?.tools,
				globalParams.resolvedPreset?.promptGuideline,
			);

			// Create SubTaskResult
			const subTaskResult: SubTaskResult = {
				task: merged.task,
				label: merged.label,
				exitCode: 0,
				messages: [],
				stderr: "",
				usage: { ...EMPTY_USAGE },
			};

			// E10: Register subagent ID for intercom
			const subagentId = merged.label ?? `parallel-${index}`;
			intercom.register(subagentId);

			// Issue #119: per-subtask run entry — created at spawn so the
			// monitor drill-in shows per-unit priority and a post-hoc audit
			// trail exists per subtask (mirrors single-mode run persistence).
			const { runId, run } = createUnitRun(merged, stepModel, parallelPriority, globalParams.resolvedPreset?.name, state.config.recovery);
			state.persistRun(pi, run, "unit");

			// R2: Prune old run entries if history exceeds limit
			pruneHistoryIfNeeded(state, ctx, log);

			// Register for live monitor — parallel subtasks now appear in the
			// drill-in with their per-unit priority (issue #119). The merged
			// timeout rides along as the display deadline (issue #423).
			registerLiveRun(state, run, ctx, undefined, merged.timeout);

			log.debug("Parallel subtask run registered", { runId, index });

			// Emit initial progress
			const modeInfo = describePromptMode(
				merged.inheritSP,
				Boolean(merged.customSP),
			);
			onUpdate?.({
				content: [
					{
						type: "text" as const,
						text: `Parallel task ${index + 1}/${taskList.length} (${modeInfo})...`,
					},
				],
				details: {
					messages: [],
					usage: { ...EMPTY_USAGE },
					exitCode: -1,
					stderr: "",
				},
			});

			// Wrap onUpdate for per-task progress — also feed the live monitor so
			// the drill-in streams output instead of showing "waiting for first
			// output…" for the whole run (mirrors single mode's liveOnUpdate).
			const taskOnUpdate = makeLiveOnUpdate(state, runId, onUpdate);

			// Run subagent — the post-spawn body is crash-protected (issue #119
			// R1, C1 fix): a throw here (e.g. runner writeToTempFile) must
			// finalize the run entry and release the live monitor, or the entry
			// stays 'running' forever and sweepStaleLiveSubagents cannot reclaim
			// the live ghost (grace logic treats a 'running' record as live).
			try {
				const result = await runSubagent(
					// Issue #222: this task's OWN validated cwd.
					unitCwd,
					subagentPrompt,
					stepModel,
					merged.thinkingLevel,
					merged.task,
					signal,
					taskOnUpdate,
					merged.toolOptions,
					merged.timeout,
					getFinalOutput,
					log,
					currentDepth + 1,
					intercom,
					subagentId,
					run.childMarker,
				);

				// Fill SubTaskResult (one shared field mapping — issue #376/D3).
				// Issue #474: probed at THIS task's own cwd.
				Object.assign(subTaskResult, toSubTaskResult(result, unitCwd));

				results[index] = subTaskResult;
				completedCount++;

				// Issue #119: finalize the per-subtask run entry — status, duration,
				// cost, tokens and sanitized output land on the entry (mirrors
				// single-mode finalization; result carries the SubagentResult shape
				// finalizeRunRecord expects, errorCategory included).
				finalizeUnitRun(state, pi, ctx, run, result, log);
			} catch (err) {
				// Issue #119 R1 (C1 fix): mirror the single-mode crash catch — a
				// post-spawn throw must finalize the entry as failed and release
				// the live monitor, or the persisted entry stays 'running' and
				// the live drill-in loops forever. finalizeLiveSubagent is
				// idempotent; the rethrow keeps Promise.allSettled semantics (the
				// caller's finally still releases the concurrency slot).
				finalizeUnitRunCrash(state, pi, run, err, "Parallel subtask", unitCwd, log, {
					index,
				});
			}

			// Emit progress update
			const { succeeded, failed } = countSubagentOutcomes(results);
			const completed = succeeded + failed;

			const partialDetails: ParallelDetails = {
				mode: "parallel",
				results: results.filter((r) => r !== undefined),
				totalInput: results.reduce(
					(s, r) => s + (r?.usage.input ?? 0),
					0,
				),
				totalOutput: results.reduce(
					(s, r) => s + (r?.usage.output ?? 0),
					0,
				),
				totalCost: results.reduce(
					(s, r) => s + (r?.usage.cost ?? 0),
					0,
				),
				totalTurns: results.reduce(
					(s, r) => s + (r?.usage.turns ?? 0),
					0,
				),
				succeeded,
				failed,
			};

			onUpdate?.({
				content: [
					{
						type: "text" as const,
						text: `Parallel: ${completed}/${taskList.length} completed (${succeeded} succeeded, ${failed} failed)`,
					},
				],
				details: partialDetails,
			});

			// Issue #137: return the unit's real success so the caller's slot
			// release is honest — the status bar's "N failed" count reflects the
			// true outcome (same check as the aggregate chainSuccess).
			return !isSubagentError(subTaskResult);
		};

		// Resolve priority — the FALLBACK for per-unit priority (issue #114): a
		// task-level priority on tasks[] items wins per slot; this is the floor.
		const parallelPriority: Priority = (
			params.priority && ["critical", "high", "normal", "low"].includes(params.priority as string)
				? (params.priority as Priority)
				: DEFAULT_PRIORITY
		);

		// Launch all tasks concurrently using acquireSlot for natural concurrency limiting
		const promises = taskList.map(async (_, index) => {
			// Issue #114: per-unit priority wins the slot — the step's merged
			// priority (if any) beats the call-level parallelPriority fallback.
			const merged = mergeSubTaskParams(globalParams, taskList[index], state.config.maxThinkingLevel);
			const acquired = await acquireSlot(state, ctx, signal, merged.priority ?? parallelPriority);
			if (!acquired) {
				results[index] = {
					task: taskList[index].task,
					exitCode: 1,
					messages: [],
					stderr: "",
					usage: { ...EMPTY_USAGE },
					errorMessage:
						"Cancelled while waiting for concurrency slot",
					errorCategory: "aborted",
				};
				completedCount++;
				return;
			}
			let taskSuccess = false;
			try {
				taskSuccess = await runTask(index, merged, taskCwds[index]);
			} finally {
				// Issue #137: release with the unit's real success — the status
				// bar's "N failed" count reflects the true outcome.
				releaseSlot(state, taskSuccess, ctx);
			}
		});

		const settledUnits = await Promise.allSettled(promises);
		// Issue #474: a rejected unit is a FAILED unit, not an absent one — it earns
		// a row (the crash finalizer rethrows, so "rejected" is the only trace of a
		// unit that died). `results[index]` is never set on that path (the rejection
		// skips the assignment inside `runTask`), so the guard is belt-and-braces.
		settledUnits.forEach((settled, index) => {
			if (settled.status !== "rejected" || results[index]) return;
			results[index] = rejectedUnitResult(
				taskList[index].task,
				taskList[index].label,
				taskCwds[index],
				settled.reason,
			);
		});

		// Compute final aggregates
		const finalResults = results.filter(Boolean);
		const totalInput = finalResults.reduce(
			(s, r) => s + r.usage.input,
			0,
		);
		const totalOutput = finalResults.reduce(
			(s, r) => s + r.usage.output,
			0,
		);
		const totalCost = finalResults.reduce(
			(s, r) => s + r.usage.cost,
			0,
		);
		const totalTurns = finalResults.reduce(
			(s, r) => s + r.usage.turns,
			0,
		);
		const { succeeded, failed } = countSubagentOutcomes(finalResults);

		const parallelDetails: ParallelDetails = {
			mode: "parallel",
			results: finalResults,
			totalInput,
			totalOutput,
			totalCost,
			totalTurns,
			succeeded,
			failed,
		};

		// R1: Record circuit breaker outcome
		if (failed === 0) {
			state.recordSuccess();
		} else {
			state.recordFailure();
		}

		log.info("Parallel execution completed", {
			totalTasks: taskList.length,
			succeeded,
			failed,
			totalInput,
			totalOutput,
			totalCost,
		});

		// C: per-task validation warnings ride the result, prefixed with their
		// task (issue #220), after the JSON payload — empty renders nothing so
		// warning-free results stay byte-identical.
		return {
			content: [
				{
					type: "text" as const,
					text: JSON.stringify(parallelDetails, null, 2) + formatValidationWarnings(taskWarnings),
				},
			],
			details: parallelDetails,
		};
	}

	// -------------------------------------------------------------------
	// P10: runGraphMode
	// -------------------------------------------------------------------

	async function runGraphMode(
		params: DelegateTaskParams,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<DelegateTaskDetails> | undefined,
		ctx: ExtensionContext,
		guard: BatchGuardContext,
	): Promise<ToolResult<SubagentResult | GraphDetails | undefined>> {
		const graphTasks: GraphTask[] = params.graph!;

		// Issue #133: dispatch-start timestamp — the aggregate run entry's
		// startedAt (captured once, at mode entry, not at completion).
		const graphModeStartedAt = new Date().toISOString();

		// Mode prologue (issue #379): cost → depth → resolve → targets →
		// preflight → H1, with the DAG check as the graph-only pre-cost hook — a
		// malformed graph (empty / over-limit / duplicate id / missing dep) is
		// rejected before the session spends anything (IN1 boundary). Cycles are
		// NOT caught here; topologicalSort rejects them after the tail.
		const pro = runModePrologue({
			params,
			state,
			ctx,
			log,
			label: "Graph",
			units: graphTasks.length,
			beforeCost: () => {
				const errors = validateGraph(graphTasks);
				return errors.length === 0
					? undefined
					: rejection(`Graph validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`);
			},
		});
		if (!pro.ok) return pro.error;
		const { globalParams, resolvedCwd, currentDepth } = pro;

		// Mode tail (issue #379): model resolution (preset + per-call override,
		// auto-route included in `resolvedPreset`), the empty-model rejection and
		// the circuit check. It runs BEFORE the topological sort and the per-node
		// pass (IN8/IN11): a graph with a bad node AND an unconfigured model
		// reports the MODEL error first.
		const tail = resolveModeModel({
			state,
			ctx,
			log,
			preset: globalParams.resolvedPreset,
			perCallModel: params.model,
		});
		if (!tail.ok) return tail.error;
		const subagentModel = tail.model;
		const modelStr = tail.modelStr;

		// Resolve priority — the FALLBACK for per-unit priority (issue #114): a
		// task-level priority on graph[] items wins per slot; this is the floor.
		const graphPriority: Priority = (
			params.priority && ["critical", "high", "normal", "low"].includes(params.priority as string)
				? (params.priority as Priority)
				: DEFAULT_PRIORITY
		);

		// Topological sort → execution waves
		const sortResult = topologicalSort(graphTasks);
		if (!sortResult.ok) {
			return {
				content: [
					{ type: "text" as const, text: `Graph scheduling failed: ${sortResult.error}` },
				],
				details: undefined,
				isError: true,
			};
		}
		const waves = sortResult.waves;

		// Per-node pre-pass (issue #222): resolve + validate EVERY node before
		// any spawn, so a single bad node rejects the whole graph with nothing
		// started — the same all-before-any-spawn semantics the background
		// fan-out, the parallel `tasks` shape and the chain use. Each node's OWN
		// cwd is resolved and validated here (with its outputFile, resolved
		// against that cwd) and the resolved value is what that node spawns in.
		// The pre-pass runs on the DECLARED task text, before {id} substitution
		// (the substituted text is only known mid-dispatch, once a dependency's
		// output exists) — the declared text is validated with the placeholder
		// TOKENS stripped (a dependency whose id happens to be a blocking
		// keyword must not make `{<id>}` itself trip the keyword rules), while
		// the SUBSTITUTED content stays unvalidated by design. The host's own
		// wording is still validated, and refusing to validate up front would
		// mean a bad node in the LAST wave is discovered after every earlier
		// wave already spent its budget.
		const nodePass = validateUnitPrePass({
			units: graphTasks,
			label: "Graph",
			gitMode: globalParams.resolvedGitMode,
			ctx,
			log,
			force: params.force as boolean | undefined,
			noJev: params.noJev,
			// Issue #443: the DECLARED per-node level (the merged one is resolved).
			declaredThinkingLevel: (node) => node.thinkingLevel,
			merge: (node) =>
				mergeSubTaskParams(globalParams, graphTaskToSubTaskParams(node), state.config.maxThinkingLevel),
			describe: (node, merged) => ({
				prefix: `Node "${node.id}"`,
				logContext: { id: node.id },
				// Placeholder TOKENS stripped (issue #222 review): the rules
				// read the declared string, so a `{<id>}` whose dependency id
				// is a blocking keyword would block on a token, not on text
				// the host wrote. The declared wording around it is unchanged
				// and still validated. Graph policy — it stays here, not in
				// the shared helper.
				task: merged.task.replace(GRAPH_OUTPUT_PLACEHOLDER_RE, " "),
			}),
		});
		if (!nodePass.ok) return nodePass.error;
		const nodeCwds = new Map(nodePass.units.map((u) => [u.unit.id, u.cwd] as const));
		const nodeWarnings = nodePass.warnings;

		// Build base prompt once
		const basePrompt = ctx.getSystemPrompt();

		// Results map: task id → SubTaskResult (populated as waves complete)
		const resultMap = new Map<string, SubTaskResult>();
		const allWaves: GraphWave[] = [];

		// E10: Intercom for subagent-to-subagent messaging
		const intercom = new Intercom();

		// Issue #133: global node counter — node positions are reported against
		// the WHOLE dispatch (dispatch-wide ordinal), not the current wave; a
		// later wave's first node is its true global position (e.g. node 3/5),
		// not "node 1/5". Incremented once per node as each wave's nodes run.
		let globalNodeCounter = 0;
		let chainSuccess = false;
		try {
			for (let w = 0; w < waves.length; w++) {
				const wave = waves[w];
				const waveIndex = w + 1;
				const isParallel = wave.length > 1;

				// Issue #133: status-bar breakdown — wave-level context set at
				// each wave start (nodes within the wave refine it as they start).
				state.modeContext = {
					kind: "graph",
					wave: waveIndex,
					totalWaves: waves.length,
					node: 0,
					totalNodes: graphTasks.length,
				};

				// Emit initial progress
				onUpdate?.({
					content: [
						{
							type: "text" as const,
							text: `Graph wave ${waveIndex}/${waves.length} (${wave.length} task${wave.length > 1 ? "s" : ""})...`,
						},
					],
					details: {
						messages: [],
						usage: { ...EMPTY_USAGE },
						exitCode: -1,
						stderr: "",
					},
				});

				// Run all tasks in this wave concurrently
				const wavePromises = wave.map(async (graphTask, nodeIndex) => {
					// Issue #133: capture this node's dispatch-wide ordinal before any
					// sibling node advances the counter (same-wave siblings run
					// concurrently, so the value must be pinned here).
					const globalNode = ++globalNodeCounter;
					const subTaskParams = graphTaskToSubTaskParams(graphTask);

					const merged = mergeSubTaskParams(globalParams, subTaskParams, state.config.maxThinkingLevel);
					// Issue #222: the node's OWN validated cwd (pre-pass);
					// resolvedCwd (the mode-level cwd) is the guaranteed
					// fallback, so a node that declares none still resolves.
					const nodeCwd = nodeCwds.get(graphTask.id) ?? resolvedCwd;

					// C3: Resolve this step's model override (step.model > global resolved model)
					const stepModel = resolveStepModel(ctx, merged.model, subagentModel);

					// Substitute {id} placeholders with previous outputs
					merged.task = merged.task.replace(GRAPH_OUTPUT_PLACEHOLDER_RE, (_match, id) => {
						const depResult = resultMap.get(id);
						if (!depResult) return _match; // Leave unchanged if dep not found
						return getFinalOutput(depResult.messages);
					});

					// Build system prompt
					const subagentPrompt = buildSubagentPrompt(
						basePrompt,
						merged.inheritSP,
						merged.customSP,
						merged.outputFile,
						merged.toolOptions?.tools,
						globalParams.resolvedPreset?.promptGuideline,
					);

					// Acquire concurrency slot — issue #114: per-unit priority wins the
					// slot; the call-level graphPriority is the fallback.
					const acquired = await acquireSlot(state, ctx, signal, merged.priority ?? graphPriority);
					if (!acquired) {
						return {
							id: graphTask.id,
							result: {
								task: merged.task,
								label: merged.label,
								exitCode: 1,
								messages: [],
								stderr: "",
								usage: { ...EMPTY_USAGE },
								errorMessage: "Cancelled while waiting for concurrency slot",
								errorCategory: "aborted" as const,
							} satisfies SubTaskResult,
						};
					}

					const subagentId = graphTask.id;
					intercom.register(subagentId);

					// Issue #434: the unit projection of the dispatch pre-flight, applied
					// after this node's slot is held (a node cancelled above never
					// reaches here) and BEFORE `createUnitRun` below, so the retry
					// snapshot records the dropped deadline (ADR 0009).
					applyUnitShapeGuard(ctx, guard, subTaskParams, merged);

					// Issue #133: status-bar breakdown — the node's dispatch-wide
					// position (globalNode, not the wave-local nodeIndex) so a later
					// wave reports its true global ordinal.
					state.modeContext = {
						kind: "graph",
						wave: waveIndex,
						totalWaves: waves.length,
						node: globalNode,
						totalNodes: graphTasks.length,
					};

					// Issue #133: per-node run entry — mirrors runParallelMode's
					// per-unit block (issue #119): the runId doubles as the live id,
					// so sweepStaleLiveSubagents finds a 'running' record for every
					// foreground live entry (the #130 invariant gap that swept
					// graph/chain entries immediately).
					const { runId, run } = createUnitRun(merged, stepModel, graphPriority, globalParams.resolvedPreset?.name, state.config.recovery);
					state.persistRun(pi, run, "unit");

					// R2: Prune old run entries if history exceeds limit
					pruneHistoryIfNeeded(state, ctx, log);

					// Register for live monitor — graph nodes now appear in the
					// drill-in under the runId with their per-unit priority
					// (issue #133 single identity, mirrors parallel mode's issue
					// #119 registration). A FRESH runId per node: subagentSessions
					// is host-global, so raw graph-task ids would collide across
					// concurrent graph runs (the intercom namespace is per-run and
					// stays untouched).
					// Issue #423: the merged timeout rides along as the display deadline.
					registerLiveRun(state, run, ctx, undefined, merged.timeout);

					let nodeSuccess = false;
					try {
						// Wrap onUpdate for per-node progress — also feed the live
						// monitor so the drill-in streams output instead of showing
						// "waiting for first output…" (mirrors parallel mode's
						// taskOnUpdate).
						const stepOnUpdate = makeLiveOnUpdate(state, runId, onUpdate);

						const result = await runSubagent(
							nodeCwd,
							subagentPrompt,
							stepModel,
							merged.thinkingLevel,
							merged.task,
							signal,
							stepOnUpdate,
							merged.toolOptions,
							merged.timeout,
							getFinalOutput,
							log,
							currentDepth + 1,
							intercom,
							subagentId,
							run.childMarker,
						);

						// One shared field mapping — issue #376/D3 (the graph literal was a
						// third copy of it).
						const subTaskResult: SubTaskResult = {
							task: merged.task,
							label: merged.label,
							// Issue #474: probed at THIS node's own cwd.
							...toSubTaskResult(result, nodeCwd),
						};

						// Issue #133: finalize the per-node run entry — status, duration,
						// cost, tokens and sanitized output land on the entry (mirrors
						// parallel's issue #119 finalize; result carries the
						// SubagentResult shape finalizeRunRecord expects, errorCategory
						// included).
						finalizeUnitRun(state, pi, ctx, run, result, log);
						// Issue #137: the node's real success — the status bar's
						// "N failed" count reflects the true outcome (same check as
						// the aggregate chainSuccess).
						nodeSuccess = !isSubagentError(result);

						return { id: graphTask.id, result: subTaskResult };
					} catch (err) {
						// Issue #133 (mirrors the #119 R1/C1 discipline): crash-protected
						// — a post-spawn throw must finalize the run entry as failed AND
						// release the live entry, or the persisted record stays
						// 'running' forever and the sweep treats the ghost as live.
						// finalizeLiveSubagent is idempotent; the rethrow keeps
						// Promise.allSettled semantics (a failing node must NOT cancel
						// sibling nodes in the wave).
						finalizeUnitRunCrash(state, pi, run, err, "Graph node", nodeCwd, log, {
							id: graphTask.id,
						});
					} finally {
						releaseSlot(state, nodeSuccess, ctx);
					}
				});

				const waveResults = await Promise.allSettled(wavePromises);
				const graphWaveTasks: SubTaskResult[] = [];

				for (const [nodeIndex, settled] of waveResults.entries()) {
					if (settled.status === "fulfilled") {
						resultMap.set(settled.value.id, settled.value.result);
						graphWaveTasks.push(settled.value.result);
					} else {
						log.error("Graph wave task rejected", { error: String(settled.reason) });
						// Issue #474: the rejected node keeps its place in the wave as a
						// FAILED row — a dropped row made a crashed node read as an
						// absent one, and the aggregate could settle `done`.
						const node = wave[nodeIndex];
						graphWaveTasks.push(
							rejectedUnitResult(
								node.task,
								node.label,
								nodeCwds.get(node.id) ?? resolvedCwd,
								settled.reason,
							),
						);
					}
				}

				const graphWave: GraphWave = {
					waveIndex,
					tasks: graphWaveTasks,
					parallel: isParallel,
				};
				allWaves.push(graphWave);

				// Emit progress update
				onUpdate?.({
					details: undefined,
					content: [
						{
							type: "text" as const,
							text: `Graph wave ${waveIndex}/${waves.length} completed`,
						},
					],
				});
			}

			// Compute final aggregates
			const allResults = allWaves.flatMap((w) => w.tasks);
			const totalInput = allResults.reduce((s, r) => s + r.usage.input, 0);
			const totalOutput = allResults.reduce((s, r) => s + r.usage.output, 0);
			const totalCost = allResults.reduce((s, r) => s + r.usage.cost, 0);
			const totalTurns = allResults.reduce((s, r) => s + r.usage.turns, 0);

			chainSuccess = countSubagentOutcomes(allResults).failed === 0;

			const graphDetails: GraphDetails = {
				mode: "graph",
				waves: allWaves,
				totalInput,
				totalOutput,
				totalCost,
				totalTurns,
			};

			// R1: Record circuit breaker outcome
			if (chainSuccess) {
				state.recordSuccess();
			} else {
				state.recordFailure();
			}

			log.info("Graph completed", {
				totalTasks: graphTasks.length,
				waves: allWaves.length,
				totalInput,
				totalOutput,
				totalCost,
			});

			// Issue #133: one aggregate run entry per graph dispatch — fresh id,
			// persisted ONCE as done (no live entry: the drill-in shows the
			// per-node entries while running; the aggregate is a post-hoc audit
			// summary). Fields come from the dispatch-level resolved values and
			// the aggregate totals; startedAt is the mode-entry timestamp.
			const graphAggregateRun: SubagentRun = {
				id: crypto.randomUUID(),
				task: `Graph dispatch: ${graphTasks.length} tasks in ${allWaves.length} waves`,
				label: globalParams.label ?? "graph",
				// Issue #133: persist the ACTUAL outcome — "failed" when any node
				// failed (chainSuccess === false), "done" otherwise.
				status: chainSuccess ? "done" : "failed",
				model: `${subagentModel.provider}/${subagentModel.id}`,
				thinkingLevel: globalParams.thinkingLevel,
				priority: graphPriority,
				startedAt: graphModeStartedAt,
				finishedAt: new Date().toISOString(),
				durationMs: Date.now() - new Date(graphModeStartedAt).getTime(),
				cost: totalCost,
				tokensIn: totalInput,
				tokensOut: totalOutput,
				outputSummary: capOutput(JSON.stringify(graphDetails, null, 2)),
			};
			state.persistRun(pi, graphAggregateRun);

			// Per-node validation warnings ride the result, prefixed with their
			// node id (issue #222), after the JSON payload — empty renders
			// nothing so warning-free results stay byte-identical.
			return {
				content: [
					{
						type: "text" as const,
						text: JSON.stringify(graphDetails, null, 2) + formatValidationWarnings(nodeWarnings),
					},
				],
				details: graphDetails,
			};
		} catch (err) {
			// F7 (issue #65): err.message may embed absolute paths — sanitize
			// BEFORE it reaches the main agent's context (tool result content +
			// details.errorMessage). resolvedCwd is the validated subagent cwd.
			const result = buildCrashResult("Graph mode", err, resolvedCwd);
			log.error("Graph mode crashed", { error: result.details.errorMessage });
			return result;
		} finally {
			// Issue #133: clear the status-bar mode breakdown — the dispatch is
			// over (success or outer-catch crash).
			state.modeContext = undefined;
			releaseSlot(state, chainSuccess, ctx);
		}
	}

	return { runChainMode, runParallelMode, runGraphMode, resolveStepModel, applyUnitShapeGuard };
}

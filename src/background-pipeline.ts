// Purpose: The background pipeline — the fan-out handler, the shared spawn tail and the single-background spawn — built over one runtime context.
/**
 * brl-subagent — the background pipeline (cycle S3, ADR 0027 D3/D6)
 *
 * `runBackgroundFanOut`, `startBackgroundAgent` and `spawnBackgroundRun` used to
 * be closures inside `src/index.ts`'s default export: ~830 lines of the
 * composition root that owned the background lifecycle (spawns, session refs,
 * live records, abort/settle). They move here verbatim.
 *
 * D3: this module may import the `src/*.ts` modules it needs, and NOT the
 * composition root — `architecture-rules` forbids a non-entry module importing
 * `index.ts`. The three bindings the moved bodies read from their old closure
 * (`pi`, `log`, `state`) arrive as the `RuntimeContext` argument, and the three
 * capabilities the moved bodies cannot reach from here arrive as `deps`:
 *
 *   - `loadSessionManager` is the seam ADR 0027 D3 forces. `startBackgroundAgent`
 *     awaits `spawnBackgroundSession`, `setAgentFinalOutput` and
 *     `extractFinalOutput` — session-manager LIFECYCLE MUTATORS, which
 *     `architecture-rules` ("non-entry modules take only the reader API") forbids
 *     a non-entry module to import. The thunk is awaited at the ORIGINAL
 *     statement position, so the lazy-load timing and the rejection path that the
 *     two callers already translate into their own failure shape are unchanged.
 *   - `resolveStepModel` and `applyUnitShapeGuard` live in `mode-runners.ts` (S2)
 *     and the fan-out's per-task pre-pass/spawn loop calls both.
 *
 * `deps` carries FUNCTION fields only; no data (ADR 0027 F2), and the context is
 * exactly the three fields `runtime.ts` declares — a fourth would mean the split
 * is wrong (ADR 0027 F1), not that this interface should widen.
 *
 * The move is verbatim. `createBackgroundPipeline` destructures its context on
 * its first lines and the bodies carry their original indentation, so a body line
 * that differs from 156d238 is a bug in this commit, not a refactor. The three
 * deliberate non-verbatim edits are named in the PR: the retired
 * `resolveSubagentModel` wrapper (explicit `resolveSubagentModelPrecedence`
 * arguments), the loader thunk, and the spawn request shape lifted to
 * `BackgroundAgentSpawnRequest` so the returned interface reuses it instead of
 * restating 25 lines.
 */

import type { BatchGuardContext } from "./mode-runners";
import type { RuntimeContext } from "./runtime";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { repaintStatus } from "./concurrency";
import { resolveRetryParams } from "./history";
import { buildMonitoringDegradedParagraph, claimTerminalNotice, sendMonitoringDegradedAdvisory } from "./notify-completion";
import { resolveDispatchPreset, resolveSubagentParams, snapshotOriginalParams } from "./params";
import {
	formatValidationWarnings,
	gateSessionCost,
	invalidThinkingLevelRejection,
	rejectApprovalAlwaysInBackground,
	resolveSubagentModelPrecedence,
	runPreTaskValidation,
	validateDelegationTargets,
} from "./prelude";
import { formatPresetRestriction, formatToolRestriction } from "./presets";
import { buildSubagentPrompt } from "./prompt";
import { newDispatchIdentity } from "./recovery";
import { clearInflightRun } from "./run-registry";
import { sanitizeErrorMessage } from "./sanitize";
import {
	declaredThinkingLevel,
	type BackgroundAgent,
	type BackgroundAgentIdentity,
	type BackgroundAgentSpawnResult,
	type DelegateTaskParams,
	type GitMode,
	type RecoveryMode,
	type SubagentResult,
	type SubagentRun,
	type SubagentToolOptions,
	type SubTaskParams,
	type ThinkingLevel,
	type ToolResult,
} from "./types";
import { displayTaskName, mergeSubTaskParams, type MergedSubTaskParams } from "./unit-params";

/**
 * The session-manager lifecycle mutators `startBackgroundAgent` needs, named
 * through the module's own types rather than restated (a signature drift there
 * is a compile error here). Never imported: the composition root passes them in
 * through `loadSessionManager`, which is the one place allowed to reach them.
 */
export interface SessionManagerSpawnDeps {
	spawnBackgroundSession: (typeof import("./session-manager"))["spawnBackgroundSession"];
	setAgentFinalOutput: (typeof import("./session-manager"))["setAgentFinalOutput"];
	extractFinalOutput: (typeof import("./session-manager"))["extractFinalOutput"];
}

/**
 * The capabilities the moved bodies cannot reach from this module: the lazy
 * session-manager load, and the two unit helpers `mode-runners.ts` owns (S2).
 * Function fields only — no data crosses this seam (ADR 0027 F2).
 */
export interface BackgroundPipelineDeps {
	/**
	 * Injected so this module never imports session-manager's lifecycle
	 * mutators. Called at the top of `startBackgroundAgent` and awaited there, so
	 * a rejected load rejects that function — the two callers classify it.
	 */
	loadSessionManager: () => Promise<SessionManagerSpawnDeps>;
	/** C3: per-unit model override (step.model > global resolved model). */
	resolveStepModel: (
		ctx: ExtensionContext,
		stepModel: string | undefined,
		globalModel: { provider: string; id: string },
	) => { provider: string; id: string };
	/** Issue #434: the dispatch pre-flight's unit projection. */
	applyUnitShapeGuard: (
		ctx: ExtensionContext,
		guard: BatchGuardContext,
		step: SubTaskParams,
		merged: MergedSubTaskParams,
	) => void;
}

/**
 * `startBackgroundAgent`'s request. Named at module scope because the returned
 * interface declares the same function: one shape, declared once.
 */
interface BackgroundAgentSpawnRequest {
	task: string;
	type?: string;
	description?: string;
	model?: string;
	thinkingLevel: ThinkingLevel;
	priority?: string;
	systemPrompt: string;
	/** Issue #411: conductor-authored resume context for an auto-retry,
	 *  delivered on the system-prompt side (never inside the task fence). */
	resumeContext?: string;
	cwd: string;
	toolOptions?: SubagentToolOptions;
	timeout?: number;
	gitMode: GitMode;
	originalParams?: SubagentRun["originalParams"];
	/** cwd used to redact paths from crash notifications. */
	sanitizeCwd: string;
	// Option B U1: durability identity threaded onto the background records.
	dispatchId?: string;
	resumeOf?: string;
	attempt?: number;
	// Option B U3 (D4): recovery posture snapshot for the background run.
	recoveryPosture?: RecoveryMode;
}

/**
 * The three functions `createBackgroundPipeline` hands the composition root.
 * Declared once as the module's public contract rather than inferred: the return
 * statement is checked against it, so a signature that drifts is a compile error
 * here instead of a surprise at the `execute` call site.
 */
interface BackgroundPipeline {
	runBackgroundFanOut: (
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		params: DelegateTaskParams,
		signal: AbortSignal | undefined,
		guard: BatchGuardContext,
	) => Promise<ToolResult<SubagentResult | undefined>>;
	startBackgroundAgent: (
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		spawn: BackgroundAgentSpawnRequest,
	) => Promise<BackgroundAgentSpawnResult>;
	spawnBackgroundRun: (
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		params: (DelegateTaskParams & { noJev?: string }) | ReturnType<typeof resolveRetryParams>,
		singleTask: string,
		retrySourceRun?: SubagentRun,
		attemptContext?: string,
	) => Promise<ToolResult<undefined>>;
}

/**
 * Build the background pipeline over one runtime context (ADR 0027 D1/D3).
 *
 * The two destructures are the whole point of the wrapper: they re-create, as
 * locals, the names the bodies read from their old closure, so every moved
 * statement stays byte-identical. `pi` is NOT among them — all three moved
 * bodies take it as a parameter, so the composition root supplies it exactly
 * where it did before and a destructured `pi` would be a dead binding.
 *
 * Nothing else is captured: the factory allocates no state of its own, so two
 * contexts produce two independent pipelines over two independent stores (the
 * S3 boundary test pins that).
 */
export function createBackgroundPipeline(
	rt: RuntimeContext,
	deps: BackgroundPipelineDeps,
): BackgroundPipeline {
	const { log, state } = rt;
	const { resolveStepModel, applyUnitShapeGuard } = deps;

	// -------------------------------------------------------------------
	// runBackgroundFanOut — background fan-out for tasks mode.
	// Resolves + validates the WHOLE batch up front (no spawn on any
	// failure), then spawns the tasks sequentially, in task order, through the
	// shared startBackgroundAgent tail, and returns immediately with their ids.
	// Foreground-only gates (preflight, circuit breaker, recursion depth) are
	// deliberately skipped — the single-background path skips them too.
	// -------------------------------------------------------------------

	async function runBackgroundFanOut(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		params: DelegateTaskParams,
		signal: AbortSignal | undefined,
		guard: BatchGuardContext,
	): Promise<ToolResult<SubagentResult | undefined>> {
		const taskList: SubTaskParams[] = params.tasks!;

		// Session cost limit gates the WHOLE batch before any spawn — same
		// estimate/limit logic as runParallelMode, scaled by task count.
		const costError = gateSessionCost({
			state,
			ctx,
			log,
			units: taskList.length,
			label: "Background fan-out",
		});
		if (costError) return costError;

		// Resolve global params once — same call shape as runParallelMode.
		const globalParams = resolveSubagentParams(params, state, ctx, log);

		// Resolve the global model once (per-call model beats preset/config).
		// ADR 0027 (S3): the retired `resolveSubagentModel` wrapper called the
		// precedence chain with a positional (ctx, presets, per-call) shape; the
		// call is spelled out here so this module depends on the chain directly.
		const globalModelResult = resolveSubagentModelPrecedence({
			state,
			ctx,
			log,
			preset: globalParams.resolvedPreset,
			perCallModel: params.model as string | undefined,
		});
		if (!globalModelResult.ok) return globalModelResult.error;
		const globalModel = globalModelResult.model;

		// Same rejection as the single-background path: approvalMode 'always'
		// cannot work in background — there is no interactive dialog to approve
		// the diff, for any of the N agents.
		const approvalError = rejectApprovalAlwaysInBackground(globalParams.resolvedApprovalMode);
		if (approvalError) return approvalError;
		// W5 parity with the single-background path: 'writes' silently
		// auto-approves in background — warn once so the caller knows none of
		// the N agents' diffs will be gated on approval.
		if (globalParams.resolvedApprovalMode === 'writes') {
			log.warn("Background fan-out spawned with approvalMode 'writes' — auto-approving (no dialog in background)", {
				tasks: taskList.length,
			});
		}

		// gitMode 'branch' is rejected for the whole batch: the per-repository
		// git lock is awaited inside the first spawn and held until that agent
		// settles, so same-repository branch-mode spawns would serialize and
		// block this call for the whole chain. The rule is blanket (not
		// per-repository-checked) because the lock is keyed by the resolved
		// repository root: units in different directories of one repo share the
		// working tree and contend for the same lock.
		if (globalParams.resolvedGitMode === 'branch') {
			return {
				content: [{ type: "text" as const, text:
					`Cannot start ${taskList.length} background agents with gitMode 'branch': the per-repository git lock ` +
					`is awaited by the first spawn and held until that agent settles, so same-repository branch-mode ` +
					`spawns would serialize and block this call for the whole chain. Background fan-out therefore ` +
					`rejects gitMode 'branch' for all tasks in this version. Use gitMode 'none' for the batch, or ` +
					`dispatch each unit as a separate single-task background call.`
				}],
				details: undefined,
				isError: true,
			};
		}

		// Per-task pre-pass: resolve + validate EVERYTHING before any spawn, so a
		// single bad task rejects the whole batch with nothing started.
		type FanOutTask = {
			merged: MergedSubTaskParams;
			model: { provider: string; id: string };
			cwd: string;
			outputFile: string | undefined;
		};

		const fanOutTasks: FanOutTask[] = [];
		// C: per-task warnings collect here to ride the immediate spawn result.
		const taskWarnings: string[] = [];
		for (let i = 0; i < taskList.length; i++) {
			const merged = mergeSubTaskParams(globalParams, taskList[i], state.config.maxThinkingLevel);
			const name = displayTaskName(merged);
			const taskPrefix = `Task ${i + 1} ("${name}")`;
			// Issue #443: the DECLARED per-task level — `merged.thinkingLevel` is
			// already resolved, so an unknown declaration is indistinguishable from
			// an omitted one by the time the spawn pass reads it. Checked here, in
			// the all-before-any-spawn pass, so a bad SECOND task rejects the whole
			// batch with nothing started.
			const declaredThinkingError = invalidThinkingLevelRejection(
				taskList[i].thinkingLevel,
				taskPrefix,
			);
			if (declaredThinkingError) return declaredThinkingError;
			// Per-task model override wins; the global model is the fallback.
			const stepModel = resolveStepModel(ctx, merged.model, globalModel);

			const targets = validateDelegationTargets({
				ctx,
				effectiveCwd: merged.effectiveCwd,
				outputFile: merged.outputFile,
				prefix: taskPrefix,
			});
			if (!targets.ok) return targets.error;

			const preTask = runPreTaskValidation({
				log,
				label: "Background fan-out",
				prefix: taskPrefix,
				logContext: { task: i + 1 },
				preTask: {
					task: merged.task,
					toolOptions: merged.toolOptions,
					thinkingLevel: merged.thinkingLevel,
					gitMode: globalParams.resolvedGitMode,
					outputFile: merged.outputFile,
					force: params.force as boolean | undefined,
					cwd: targets.cwd,
					noJev: params.noJev,
				},
			});
			if (preTask.error) return preTask.error;
			for (const w of preTask.warnings) taskWarnings.push(`${taskPrefix}: ${w}`);

			fanOutTasks.push({ merged, model: stepModel, cwd: targets.cwd, outputFile: targets.outputFile });
		}

		// Spawn pass — sequential, in task order, through the shared tail.
		// Issue #439: a unit's report is built from its plain identity record plus
		// its own containment ledger, so a degraded unit is still reported as
		// STARTED — including when a LATER unit fails or the batch is cancelled.
		const started: Array<{ id: string; label?: string; tailFailures: string[] }> = [];
		const startedIdsText = (): string => started.map((s) => s.id).join(", ");
		/** The degraded paragraph for every unit whose monitoring did not attach. */
		const degradedReport = (): string =>
			started
				.filter((s) => s.tailFailures.length > 0)
				.map((s) => buildMonitoringDegradedParagraph(s, s.tailFailures))
				.join("");

		for (let i = 0; i < fanOutTasks.length; i++) {
			if (signal?.aborted) {
				if (started.length === 0) {
					return {
						content: [{ type: "text" as const, text: `Background fan-out cancelled before any agent started.` }],
						details: undefined,
						isError: true,
					};
				}
				return {
					content: [{ type: "text" as const, text:
						`Background fan-out cancelled after starting ${started.length} of ${fanOutTasks.length} agents ` +
						`(${startedIdsText()}) — they are detached and will still wake you.` +
						degradedReport()
					}],
					details: undefined,
					isError: true,
				};
			}

			const { merged, model, cwd, outputFile } = fanOutTasks[i];
			// Issue #434: called with the dispatch's `unitShape`, which is
			// "background" here — a detached unit's deadline is the legitimate
			// 30-minute budget, so nothing is dropped and no unit notice is ever
			// emitted on this path. The call is here (not omitted) so the exclusion
			// is visible at the spawn site instead of hidden in a never-taken branch.
			applyUnitShapeGuard(ctx, guard, taskList[i], merged);
			const name = displayTaskName(merged);
			const subagentPrompt = buildSubagentPrompt(
				ctx.getSystemPrompt(),
				merged.inheritSP,
				merged.customSP,
				outputFile,
				merged.toolOptions?.tools,
				globalParams.resolvedPreset?.promptGuideline,
			);
			const unitPriority = merged.priority ?? (params.priority as string | undefined);

			let spawned: BackgroundAgentSpawnResult;
			try {
				spawned = await startBackgroundAgent(pi, ctx, {
					task: merged.task,
					type: (params.preset as string | undefined) || 'general-purpose',
					description: merged.label,
					model: `${model.provider}/${model.id}`,
					thinkingLevel: merged.thinkingLevel,
					priority: unitPriority,
					systemPrompt: subagentPrompt,
					cwd,
					toolOptions: merged.toolOptions,
					timeout: merged.timeout,
					gitMode: globalParams.resolvedGitMode,
					// Retry parity with createUnitRun: snapshot this unit's resolved
					// values so a retry restores them. The execution-shape fields
					// (background/gitMode/approvalMode/force) are deliberately NOT
					// passed here — a fan-out unit is spec'd to retry as a single
					// run, so it must not inherit this spawn's background-ness.
					// Same omission in unit-run.ts's createUnitRun.
					originalParams: snapshotOriginalParams({
						systemPrompt: merged.customSP,
						inheritSystemPrompt: merged.inheritSP,
						model: merged.model,
						thinkingLevel: merged.thinkingLevel,
						priority: unitPriority,
						outputFile: merged.outputFile,
						timeout: merged.timeout,
						cwd: merged.effectiveCwd,
						tools: merged.toolOptions?.tools,
						excludeTools: merged.toolOptions?.excludeTools,
						noBuiltinTools: merged.toolOptions?.noBuiltinTools,
						preset: globalParams.resolvedPreset?.name,
					}),
					sanitizeCwd: merged.effectiveCwd,
					recoveryPosture: state.config.recovery,
				});
			} catch (err) {
				const message = sanitizeErrorMessage(
					err instanceof Error ? err.message : String(err),
					merged.effectiveCwd,
				);
				log.error("Background fan-out spawn failed", { task: i + 1, error: message });
				const alreadyStarted = started.length > 0
					? `\n\nAlready started: ${startedIdsText()} — they are detached and will still wake you.`
					: "";
				return {
					content: [{ type: "text" as const, text:
						`Failed to spawn background agent for Task ${i + 1} ("${name}"): ${message}` + alreadyStarted +
						// A degraded EARLIER unit is still a started run: its report must
						// survive this later unit's failure.
						degradedReport()
					}],
					details: undefined,
					isError: true,
				};
			}
			started.push({ id: spawned.identity.id, label: merged.label, tailFailures: spawned.tailFailures });
		}

		// Text-only result: ids in task order + the wake hint. C: per-task
		// validation warnings ride the immediate SPAWN result (prefixed with
		// their task) so the conductor can stop/re-dispatch in the same turn.
		// Issue #439: a unit whose monitoring did not attach is still reported
		// STARTED, with its own degraded paragraph — `isError` stays false.
		const lines = started
			.map((s, i) => `${i + 1}. ${s.label ? `"${s.label}" ` : ""}— ${s.id}`)
			.join("\n");
		return {
			content: [{ type: "text" as const, text:
				`Background agents started: ${started.length}\n\n` +
				`${lines}\n\n` +
				`You'll be woken with a completion message as each finishes; use get_subagent_result({ agent_id }) for retrieval and stall checks.` +
				formatValidationWarnings(taskWarnings) +
				degradedReport()
			}],
			details: undefined,
		};
	}

	// -------------------------------------------------------------------
	// startBackgroundAgent — the shared background-spawn tail.
	// Used by BOTH spawnBackgroundRun (single task) and runBackgroundFanOut
	// (tasks fan-out): the session-manager import, the spawn call, live-monitor
	// registration, footer counters, the 2s progress poller and the default
	// deadline timer live here exactly once. Callers keep their own prelude,
	// checks, validations and result formatting. THROWS only on spawn failure —
	// callers translate THAT into their own failure shape. Everything after the
	// spawn is contained (issue #439): it returns `{ agent, identity,
	// tailFailures }`, and a non-empty `tailFailures` is a STARTED run with
	// degraded monitoring, never a failed spawn.
	// -------------------------------------------------------------------

	async function startBackgroundAgent(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		spawn: BackgroundAgentSpawnRequest,
	): Promise<BackgroundAgentSpawnResult> {
		// ADR 0027 D3: the lifecycle mutators arrive through the injected loader
		// thunk, not a module import. Awaited at the ORIGINAL statement position so
		// the import stays lazy and its rejection keeps its timing: a rejected load
		// rejects THIS function, and both callers translate that into their own
		// failure shape (see their catches).
		const { spawnBackgroundSession, setAgentFinalOutput, extractFinalOutput } = await deps.loadSessionManager();
		// Issue #31 (PR #76 review, DRY): extract final output from a
		// possibly-released ref — the poller may observe a terminal agent
		// whose ref was already nulled by the settlement path.
		const extractAgentFinalOutput = (a: BackgroundAgent): string =>
			extractFinalOutput(a._sessionRef ?? { messages: [] });

		const agent = await spawnBackgroundSession(pi, ctx, {
			task: spawn.task,
			type: spawn.type,
			description: spawn.description,
			model: spawn.model,
			thinkingLevel: spawn.thinkingLevel,
			// Issue #114: per-unit priority rides the spawn so the background
			// run entry + drill-in header carry it like foreground runs.
			priority: spawn.priority,
			systemPrompt: spawn.systemPrompt,
			resumeContext: spawn.resumeContext,
			cwd: spawn.cwd,
			toolOptions: spawn.toolOptions,
			// Issue #453: the deadline rides the spawn's own timer (one owner). The
			// caller passes the budget only — no ownership flag, no timer of its own.
			timeout: spawn.timeout,
			gitMode: spawn.gitMode,
			// Issue #98/#108: snapshotOriginalParams is the single source of truth
			// for the caller params a later retry restores.
			originalParams: spawn.originalParams,
			// Option B U1: durability identity for the agent record + run entry.
			dispatchId: spawn.dispatchId,
			resumeOf: spawn.resumeOf,
			attempt: spawn.attempt,
			// Option B U3 (D4): recovery posture snapshot for the background run.
			recoveryPosture: spawn.recoveryPosture,
		});
		
		// -----------------------------------------------------------------
		// Post-spawn containment (issue #439).
		//
		// The session EXISTS from here on: the run is live and will wake the
		// conductor however this tail behaves. A fault in the tail must therefore
		// classify the run as STARTED with degraded monitoring — never as a failed
		// spawn. Before this containment an escaping throw reached the callers'
		// catch, which said "Failed to spawn background agent" while the agent was
		// running, and the transport retry read that as "did not start".
		//
		// Boundary statement (falsifiable). Two different records, and only one of
		// them is read here:
		//   - `identity` below is a plain record THIS module constructs. Reading its
		//     properties cannot throw; only a monkey-patched accessor could, and this
		//     module never installs one. A fault that wants to reach the degraded
		//     report must therefore be injected at a STATEMENT (a throwing
		//     registerLiveSubagent, a throwing scheduler, a rejecting spawn), which is
		//     what the #439 tests do.
		//   - `agent` (the live record from the spawn) is read ONLY by the identity
		//     capture immediately below and by the poller's terminal-state guard;
		//     every later statement reads `identity` and the captured
		//     primitives instead. The capture itself sits before the outer try, so a
		//     getter-backed `agent` (which the production spawn cannot produce but an
		//     injected one can) would still escape to the caller's catch — that is the
		//     one unpinned read, stated rather than claimed away (2026-11-07 review).
		//     The callers format their results from `identity` alone, so an
		//     adversarial accessor on the live record cannot reach the report text.
		// If a future change makes `identity` a proxy or getter-backed, this boundary
		// is void: the failing test is the one asserting a started run never reports
		// "Failed to spawn".
		//
		// Two independently contained groups record into `tailFailures` — G1
		// bookkeeping, G2 poller — so a fault in one never skips the other. The
		// deadline is NOT one of them (issue #453): it is the spawn's, armed before
		// the spawn returned, so no statement here can leave a run unbounded. An
		// outer catch backstops the ledger itself, and the degraded result is
		// assembled from `identity` only.
		// -----------------------------------------------------------------
		const identity: BackgroundAgentIdentity = {
			id: agent.id,
			label: spawn.description,
			description: agent.description,
			task: agent.task,
			status: agent.status,
			model: agent.model,
		};

		const tailFailures: string[] = [];
		/** Record a contained fault. The text reaches the conductor and the user: sanitize. */
		const recordTailFailure = (group: string, err: unknown): void => {
			tailFailures.push(
				`${group}: ${sanitizeErrorMessage(err instanceof Error ? err.message : String(err), spawn.sanitizeCwd)}`,
			);
		};

		let pollInterval: ReturnType<typeof setInterval> | undefined;
		/** G1 completed the counter increment — the ONLY runs that may decrement. */
		let countedForThisRun = false;
		let completed = false;

		/** Stop the live-poll. The deadline is NOT the caller's to stop (issue #453). */
		const stopTailPolling = (): void => {
			if (pollInterval !== undefined) clearInterval(pollInterval);
		};

		/**
		 * Release this run's live counter — the ONE decrement shape for all five
		 * poller/deadline sites. Gated on `countedForThisRun` AND on the finalize
		 * claim: a run that never incremented (G1 failed before it) must not
		 * decrement, and a run the stale sweep already finalized had its decrement
		 * taken there (PR #71 review). The first gate is what keeps the ordering in
		 * G1 honest — without it, a row registered before the increment let the
		 * sweep's decrement land on a SIBLING's count.
		 *
		 * Belt-and-braces, stated as such (2026-11-07 review): with the current
		 * increment-first order in G1, `countedForThisRun` is always true by the time
		 * any callback can call this, so removing the flag alone changes nothing and
		 * no test pins it (an extra removal mutant survived). It is kept because the
		 * ORDERING is the real invariant: when the row is registered before the
		 * increment, the flag is the only thing standing between a settle and a
		 * sibling's count — M8 (reorder G1) fails T2b exactly because of it.
		 *
		 * Stated limit: the decrement is only reachable from a monitor that a run
		 * owns. If G1 AND G2 BOTH fail for the same run (counted, no row, no poller)
		 * nothing can release its count, so the footer's active count stays one high
		 * for the session. That is the honest reading — the run is real and
		 * unmonitored — and the alternative (releasing from a group that never
		 * attached) is how a sibling's count gets stolen.
		 *
		 * Issue #453: the deadline used to be a third releaser. It is not any more
		 * and does not need to be — the poller sees the spawn's `stopped` +
		 * `completedAt` on its next tick and releases there, which is exactly how an
		 * explicit-timeout run has always been released.
		 */
		const releaseLiveCount = (): void => {
			if (!countedForThisRun) return;
			if (!state.finalizeLiveSubagent(identity.id)) return;
			state.activeSubagents--;
			if (state.activeSubagents < 0) state.activeSubagents = 0;
		};

		// Issue #318 (from #316 review): the two poller crash sites share one
		// claimed notification envelope. Content is the only variable; the
		// claim guard, display, details and deliverAs live here once.
		// Issue #439: best-effort — the claim and the send sit in their own try, so
		// neither a throwing claim nor a throwing send can turn a crash notice into
		// a fault on the run's reporting path.
		const sendCrashNotice = (content: string): void => {
			try {
				if (!claimTerminalNotice(identity.id)) return;
			} catch {
				return;
			}
			try {
				pi.sendMessage({
					customType: "subagent-notification",
					content,
					display: true,
					details: { agentId: identity.id }
				}, { deliverAs: "followUp" });
			} catch { /* best-effort */ }
		};

		try {
			// ---- G1: bookkeeping ------------------------------------------
			// Ordering (issue #439, measured): counter FIRST, then the live row,
			// then the repaint. A row therefore always implies a counted run, so the
			// stale sweep's decrement can only release this run's own count.
			try {
				state.activeSubagents++;
				countedForThisRun = true;
				state.registerLiveSubagent(identity.id, {
					id: identity.id,
					label: identity.description,
					task: identity.task,
					model: identity.model,
					thinkingLevel: agent.thinkingLevel,
					priority: agent.priority,
					startedAt: agent.startedAt,
					// Issue #423: the persisted EFFECTIVE budget, anchored on the record's
					// own start clock — the same clock the deadline timers use.
					...(agent.timeoutMs !== undefined
						? { deadlineAt: agent.startedAt + agent.timeoutMs }
						: {}),
					ctx,
				});
				repaintStatus(state, ctx);
			} catch (err) {
				recordTailFailure("live-monitor bookkeeping", err);
			}

			// ---- G2: live progress poller --------------------------------
			// Issue #453: this poller is the CLEANUP OWNER for a deadline stop. The
			// spawn's timer sets `status: 'stopped'` + `completedAt` (via
			// updateAgentStatus) and aborts; on its next tick the poller below sees
			// the terminal record and does every caller-owned step — output capture,
			// the finalize claim, the counter decrement, the repaint — then stops
			// itself. Nothing here arms or clears a deadline.
			try {
				pollInterval = setInterval(() => {
					try {
						if (completed) return;

						const session = agent._sessionRef;
						// Issue #31: a nulled ref on a TERMINAL agent is expected (the
						// settlement path releases the ref) — fall through to finalize
						// below instead of treating it as a crash. A nulled ref on a
						// live agent is still a crash.
						if (!session && !agent.completedAt) {
							// Session ref not available — session may have crashed.
							// Defensive: the ref is assigned synchronously before the poller starts
							// and is never nulled, so this is mostly unreachable — but keep the
							// bookkeeping safe regardless.
							completed = true;
							stopTailPolling();
							// Capture whatever output exists (may be empty — fine).
							setAgentFinalOutput(identity.id, state.subagentSessions.get(identity.id)?.liveOutput ?? '');
							releaseLiveCount();
							state.failedSubagents++;
							repaintStatus(state, ctx);
							sendCrashNotice(`Background agent "${identity.description}" crashed.`);
							return;
						}

						// While running, update the live monitor.
						// Once completedAt is set, skip straight to finalize below.
						// Issue #31: past the guard above, the only nulled-ref path left is a
						// TERMINAL agent (settlement releases the ref), so a live agent always
						// has its session — the guard already returned on the live-nulled-ref
						// crash path. The compiler can't correlate the two checks, so assert it.
						if (!agent.completedAt) {
							const finalOutput = extractFinalOutput(session!);

							try {
								const stats = session!.getSessionStats();
								state.updateLiveSubagent(identity.id, finalOutput, stats.tokens.input, stats.tokens.output);
							} catch {
								state.updateLiveSubagent(identity.id, finalOutput, 0, 0);
							}
						}

						// Authoritative completion: the prompt promise settled — status and
						// completedAt are set by .then()/.catch() in spawnBackgroundSession.
						// Do NOT rely on !session.isStreaming: it is false during prompt()
						// preflight (auth check, model resolution) and for failed starts.
						if (agent.completedAt) {
							completed = true;
							stopTailPolling();

							// Issue #31: prefer the output already captured at settlement;
							// the ref may already be nulled on terminal agents, so never
							// overwrite with empty and stay null-safe.
							const finalOutput = agent.finalOutput ?? extractAgentFinalOutput(agent);
							setAgentFinalOutput(identity.id, finalOutput);

							releaseLiveCount();

							if (agent.status === 'failed') {
								state.failedSubagents++;
								repaintStatus(state, ctx);
								// Issue #315: the terminal wake (`subagent-completion`, emitted by
								// the session-manager settle) is the ONE notice for a failed run.
								// The status here was set by that settle, so the wake already
								// delivered — this legacy poller notice would duplicate it.
							} else if (agent.status === 'stopped') {
								// User-initiated stop (stop_subagent) or deadline abort
								// (timeout/deadline) — not a failure.
								repaintStatus(state, ctx);
							} else {
								state.completedSubagents++;
								state.unseenSubagents++;
								repaintStatus(state, ctx);
							}
						}
					} catch (err) {
						if (!completed) {
							completed = true;
							stopTailPolling();
							try {
								setAgentFinalOutput(identity.id, extractAgentFinalOutput(agent));
							} catch { /* ignore */ }
							releaseLiveCount();
							state.failedSubagents++;
							repaintStatus(state, ctx);
							sendCrashNotice(`Background agent "${identity.description}" crashed: ${sanitizeErrorMessage((err as Error).message, spawn.sanitizeCwd)}`);
						}
					}
				}, 2000);
			} catch (err) {
				recordTailFailure("progress polling", err);
			}

			try {
				log.info("Background agent spawned", { agentId: identity.id, task: spawn.task, model: identity.model });
			} catch (err) {
				recordTailFailure("spawn log", err);
			}
		} catch (err) {
			// Backstop: the groups above swallow their own faults, so this can only
			// see a fault in the ledger machinery itself. The degraded result below is
			// assembled from `identity` — never from a property read on `agent`.
			recordTailFailure("spawn tail", err);
		}

		if (tailFailures.length > 0) {
			// ONE advisory per run, after aggregation. It is NOT a terminal notice
			// and never takes the terminal claim (issue #439 contract): the run's
			// genuine completion notice is still delivered when it settles.
			// 2026-11-07 review: this call is INSIDE the outer containment, not after
			// it — the advisory's own dispatch surfaces are contained too, and the
			// inner per-channel tries in `sendMonitoringDegradedAdvisory` cover the
			// case where one channel throws (so one failure cannot lose both).
			try {
				sendMonitoringDegradedAdvisory(pi, ctx, identity, tailFailures);
			} catch (err) {
				recordTailFailure("monitoring advisory", err);
			}
		}

		return { agent, identity, tailFailures };
	}

	// -------------------------------------------------------------------
	// spawnBackgroundRun — Phase 6.5 background spawn, extracted verbatim
	// from execute() (#198 phase 1) so a later phase can fan out N runs.
	// -------------------------------------------------------------------

	async function spawnBackgroundRun(
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		/**
		 * Two shapes, both passed WITHOUT an assertion (issue #379):
		 *  - `DelegateTaskParams` — a fresh dispatch, schema-validated;
		 *  - the `resolveRetryParams` bag — rebuilt from a run record, whose
		 *    `priority` is the unvalidated persisted string. It is the only field
		 *    the two shapes disagree on, and claiming the recorded value was
		 *    schema-validated would be a lie: records are read back from disk.
		 */
		params: (DelegateTaskParams & { noJev?: string }) | ReturnType<typeof resolveRetryParams>,
		singleTask: string,
		// Option B U1: the spawn entry a retryRunId resolved to, so a retried
		// background run inherits dispatchId/resumeOf/attempt (record identity,
		// not a delegate param — D4).
		retrySourceRun?: SubagentRun,
		/**
		 * Issue #401/#411: the resume preamble for a TRANSPORT auto-retry. It rides
		 * the child's system prompt only (as a `<resume-context>` section) — never
		 * inside the `<task>` fence. `resolveSubagentParams`, every gate and every
		 * H1 check above still see `singleTask` (which stays byte-identical to the
		 * recorded original), so routing, capability warnings and pre-flight checks
		 * cannot be steered by the preamble's wording.
		 */
		attemptContext?: string,
	): Promise<ToolResult<undefined>> {
		// Issue #443: the DECLARED level, guarded before `bgResolved` clamps it.
		// This is the seam for the TRANSPORT auto-retry (`scheduleTransportRetry`
		// re-enters here with `resolveRetryParams`' rebuilt bag and never passes
		// through `execute`), and the reason a restored record carrying an unknown
		// level cannot launch a session at pi's default. A rejection here surfaces
		// as the ORIGINAL failure's notice — the caller reports it unchanged.
		const bgDeclaredThinkingLevel = declaredThinkingLevel(
			params.thinkingLevel,
			resolveDispatchPreset({ ...params, task: singleTask }, state).preset?.thinkingLevel,
		);
		const bgDeclaredThinkingError = invalidThinkingLevelRejection(bgDeclaredThinkingLevel);
		if (bgDeclaredThinkingError) return bgDeclaredThinkingError;

		// Phase 6.5: Background execution — spawn session and return ID immediately.
		// Resolve the preset and its model BEFORE the background branch so the
		// preset's model (and system prompt) are honored in background mode.
		const bgResolved = resolveSubagentParams({ ...params, task: singleTask }, state, ctx, log);
		const {
			resolvedPreset: bgResolvedPreset,
			autoRoutedPreset: bgAutoRoutedPreset,
			autoRouteKeyword: bgAutoRouteKeyword,
		} = bgResolved;
		// ADR 0027 (S3): explicit argument mapping — the same three inputs the
		// retired wrapper forwarded, plus the context bindings it captured.
		const bgModelResult = resolveSubagentModelPrecedence({
			state,
			ctx,
			log,
			preset: bgResolvedPreset,
			perCallModel: params.model,
		});
		const bgModel = bgModelResult.ok
			? `${bgModelResult.model.provider}/${bgModelResult.model.id}`
			: undefined;

		try {
			// W5 (issue #28): approvalMode 'always' cannot work in background —
			// there is no interactive dialog to approve the diff. Reject loudly
			// instead of silently running unattended with write access.
			const approvalError = rejectApprovalAlwaysInBackground(bgResolved.resolvedApprovalMode);
			if (approvalError) return approvalError;
			// W5: 'writes' in background silently auto-approves — warn once so the
			// caller knows the diff will NOT be gated on approval.
			if (bgResolved.resolvedApprovalMode === 'writes') {
				log.warn("Background agent spawned with approvalMode 'writes' — auto-approving (no dialog in background)", {
					task: params.task,
				});
			}

			// W6 (issue #28): session cost limit must gate background spawns too —
			// the R5 check after the background branch never runs for them.
			// Same estimate/limit logic as single mode.
			const costError = gateSessionCost({
				state,
				ctx,
				log,
				units: 1,
				label: "Background delegation",
			});
			if (costError) return costError;

			// F1: Validate cwd + outputFile the same way foreground single mode does —
			// an unvalidated outputFile would reach the prompt and could steer the
			// background agent's write tool outside the project root.
			const targets = validateDelegationTargets({
				ctx,
				effectiveCwd: bgResolved.effectiveCwd,
				outputFile: bgResolved.outputFile,
			});
			if (!targets.ok) return targets.error;
			const bgResolvedOutputFile = targets.outputFile;

			// C: H1 validation for background mode — reject capability blocks and
			// outputFile-vs-write conflicts before spawning (same as single mode;
			// `force` honors the same override foreground does).
			const bgPreTask = runPreTaskValidation({
				log,
				label: "Background",
				preTask: {
					task: singleTask,
					toolOptions: bgResolved.toolOptions,
					thinkingLevel: bgResolved.thinkingLevel,
					gitMode: bgResolved.resolvedGitMode,
					outputFile: bgResolvedOutputFile,
					force: params.force,
					cwd: targets.cwd,
					noJev: params.noJev,
				},
			});
			if (bgPreTask.error) return bgPreTask.error;

			// Build the full prompt the same way foreground single mode does:
			// base prompt (optionally inherited) + custom prompt + preset guidance.
			const bgPrompt = buildSubagentPrompt(
				ctx.getSystemPrompt(),
				bgResolved.inheritSP,
				bgResolved.customSP,
				bgResolvedOutputFile,
				bgResolved.toolOptions?.tools,
				bgResolvedPreset?.promptGuideline,
			);

			// Option B U1: durability identity (retry inherits the original dispatch).
			const bgIdentity = newDispatchIdentity(retrySourceRun);
			const spawned = await startBackgroundAgent(pi, ctx, {
				// Issue #411: the preamble rides the system-prompt side
				// (`resumeContext`), never the task. The task stays the recorded
				// original, and the snapshot keeps it too, so a later retry of this
				// retry resolves from the un-prefixed text and never compounds.
				task: singleTask,
				resumeContext: attemptContext,
				type: params.preset || 'general-purpose',
				description: params.label,
				model: bgModel,
				thinkingLevel: bgResolved.thinkingLevel,
				priority: params.priority,
				systemPrompt: bgPrompt,
				cwd: targets.cwd,
				toolOptions: bgResolved.toolOptions,
				timeout: bgResolved.timeout,
				gitMode: bgResolved.resolvedGitMode,
				originalParams: attemptContext
					? { ...snapshotOriginalParams(params), task: singleTask }
					: snapshotOriginalParams(params),
				sanitizeCwd: bgResolved.effectiveCwd,
				dispatchId: bgIdentity.dispatchId,
				resumeOf: bgIdentity.resumeOf,
				attempt: bgIdentity.attempt,
				recoveryPosture: state.config.recovery,
			});

			// Retire-on-retry (O3 fold, decision 2026-10-11): the source interrupted
			// registry entry is superseded once the new background run is actually
			// spawned (a throwing spawn is caught below and leaves the source intact
			// and retryable).
			if (retrySourceRun) clearInflightRun(retrySourceRun.id);

			// B2: Surface auto-route decisions in background spawn result too —
			// preset name + matched-keyword evidence + restriction, derived from
			// the RESOLVED toolOptions (reflects per-call overrides).
			const bgAutoRouteNote = bgAutoRoutedPreset
				? `\n\n[auto-routed to preset '${bgAutoRoutedPreset.name}'${bgAutoRouteKeyword ? ` (matched keyword '${bgAutoRouteKeyword}')` : ""} — ${bgResolved.toolOptions ? formatToolRestriction(bgResolved.toolOptions) : formatPresetRestriction(bgAutoRoutedPreset)}]`
				: "";

			// Issue #439: everything the result states comes from `identity`, the plain
			// record captured at spawn time — never a property read on the live agent.
			// A non-empty `tailFailures` is a STARTED run with degraded monitoring, so
			// this stays a success (`isError` false) with the degraded paragraph;
			// the transport retry reads `isError` as "did not start" and must not see
			// a started run here.
			return {
				content: [{
					type: "text" as const,
					text: `Background agent started: ${spawned.identity.id}\n\n` +
						`Description: ${spawned.identity.description}\n` +
						`Task: ${spawned.identity.task}\n` +
						`Status: ${spawned.identity.status}\n\n` +
						`You'll be woken with a completion message when it finishes; use get_subagent_result({ agent_id: "${spawned.identity.id}" }) for retrieval and stall checks.` +
						bgAutoRouteNote +
						// C: warnings ride the immediate SPAWN result so the conductor
						// can stop/re-dispatch in the same turn.
						formatValidationWarnings(bgPreTask.warnings) +
						buildMonitoringDegradedParagraph(spawned.identity, spawned.tailFailures),
				}],
				details: undefined,
				isError: false,
			};
		} catch (err) {
			// Issue #439: this catch is reachable ONLY for a pre-spawn gate or a
			// rejected `spawnBackgroundSession`. Everything after a successful spawn
			// is contained in `startBackgroundAgent` — a run that started never lands
			// here, so the wording below can never describe a live run.
			const message = sanitizeErrorMessage(
				err instanceof Error ? err.message : String(err),
				bgResolved.effectiveCwd,
			);
			log.error("Failed to spawn background agent", { error: message });
			return {
				content: [{ type: "text" as const, text: `Failed to spawn background agent: ${message}` }],
				details: undefined,
				isError: true,
			};
		}
	}

	return { runBackgroundFanOut, startBackgroundAgent, spawnBackgroundRun };
}

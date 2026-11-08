// Purpose: Entry point: tool/command registration, the delegate_task handlers, dispatch, single mode and the background fan-out.
/**
 * brl-subagent — multi-agent orchestration for pi.
 * Entry point: tool registrations, command surface, dispatch (mode selection,
 * guard construction, single mode and the background fan-out). The three
 * batch-mode runners live in `mode-runners.ts` (ADR 0027 S2).
 * See AGENT.md for the conductor-facing capability reference.
 */

import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import { Type } from "typebox";
import {
	declaredThinkingLevel,
	resolveThinkingLevel,
	EMPTY_USAGE,
	getFinalOutput,
	isSubagentError,
	MAX_CHAIN_STEPS,
	MAX_PARALLEL_TASKS,
	MAX_GRAPH_TASKS,
	DEFAULT_PRIORITY,
	type GitMode,
	type BackgroundAgent,
	type BackgroundAgentIdentity,
	type BackgroundAgentSpawnResult,
	type RecoveryMode,
	type SubagentPreset,
	type SubagentResult,
	type SubagentRun,
	type SubagentToolOptions,
	type ResolvedParams,
	type ThinkingLevel,
	type ApprovalMode,
	type SubTaskParams,
	type MultiSubagentDetails,
	type DelegateTaskDetails,
	type DelegateTaskParams,
	type Priority,
	type TaskTemplate,
	type ToolResult,
	type SubagentEvent,
	type SubagentEventListener,
} from "./types";
import { createModeRunners, type BatchGuardContext } from "./mode-runners";
import { createRuntime } from "./runtime";
import { resolveTemplate, loadAllTemplates, loadBuiltinTemplates, validateTemplatePresetRefs, extractParamNames } from "./templates";
import { pkgPath } from "./paths";
import {
	sanitizeTask,
	validateCwd,
	validateOutputFile,
	stripAnsi,
	capOutput,
	getCurrentDepth,
	sanitizeErrorMessage,
	buildCrashResult,
} from "./sanitize";
import {
	hasUncommittedChanges,
	createWorkBranch,
	newWorkBranchName,
	captureDiff,
	getHeadState,
	getHeadBranch,
	getRepoRoot,
	listWorkBranches,
	restoreHead,
	deleteBranch,
	mergeWorkBranch,
	type HeadState,
} from "./git";
import { preflightCheck } from "./preflight";
import {
	depthLimitRejection,
	formatValidationWarnings,
	gateSessionCost,
	invalidThinkingLevelRejection,
	modelNotConfiguredRejection,
	rejectApprovalAlwaysInBackground,
	resolveSubagentModelPrecedence,
	runPreTaskValidation,
	validateDelegationTargets,
	type SubagentModelResolution,
} from "./prelude";
import {
	loadBuiltinPresets,
	loadCustomPresets,
	getAllPresets,
	writePresetFile,
	formatPresetRestriction,
	formatToolRestriction,
} from "./presets";
import { resolveTerminalRunEntry, type SessionState } from "./state";
import { makeLiveOnUpdate, pruneHistoryIfNeeded, registerLiveRun } from "./unit-run";
import { validatePreTask, diagnoseFailure } from "./validate";
import {
	defaultBackgroundFor,
	findUnknownParams,
	KNOWN_DELEGATE_KEYS,
	resolveDispatchPreset,
	resolveEffectiveApprovalMode,
	resolveSubagentParams,
	resolveThinkingDispatchSwitch,
	shouldRejectBackgroundForBatch,
	snapshotOriginalParams,
	THINKING_SWITCH_NOTICE,
	THINKING_TIMEOUT_DROP_NOTICE,
	type DispatchShape,
	type ResolveInputParams,
} from "./params";
import { displayTaskName, mergeSubTaskParams, type MergedSubTaskParams } from "./unit-params";
import { delegateTaskParamsSchema } from "./schema";
import { readProcessChecks } from "./project-flags";
import { buildSubagentPrompt, describePromptMode } from "./prompt";
import { runSubagent, cleanupTempDirs, reapActiveChildren } from "./runner";
import { recoverProduction, currentProcessOwner, newDispatchIdentity, classifyOwner, defaultRecoveryDeps } from "./recovery";
import {
	buildHeadStateNotice,
	reconcileHeadStates,
	sweepHeadStates,
	writeHeadState,
	clearHeadState,
	HEAD_STATE_VERSION,
	type HeadStateDeps,
	type HeadStateOutcome,
} from "./headstate";
import { markInterrupted, listInflightRuns, clearInflightRun } from "./run-registry";
import { acquireSlot, clearProgressLinger, releaseSlot, repaintStatus, stopProgressTicker } from "./concurrency";
import { transcriptDisplayPath } from "./transcript-path";
import { finalizeRunRecord, resolveRetryParams, createEmptyResult } from "./history";
import { computeSLAMetrics, computeDegradation } from "./metrics";
import {
	showSelectList,
	showModelSelector,
	showThinkingSelector,
	showConcurrencyInput,
	showDepthInput,
	showHistoryEntriesInput,
	showCostLimitInput,
	showApprovalModeSelector,
	showApprovalDialog,
	showCompletionNotifySelector,
	showRecoverySelector,
	showPresetManager,
	showTemplateManager,
	showSLAConfig,
	showSLAStats,
	showConfigMenu,
	showRunHistory,
	showMonitor,
	showDashboard,
	showComplianceMenu,
	showRetryMenu,
	renderDelegateCall,
	renderDelegateResult,
} from "./tui";
import { setLogCwd } from "./logging";
import {
	collectInterruptedRuns,
	offeredInterruptedRuns,
	buildRecoveryNotice,
	resolveRecoveryNoticeDelivery,
	abandonInterruptedRun,
	visibleRunEntriesForSession,
	type RecoveryAgentLookup,
} from "./recovery-surface";
import * as eventBus from "./event-bus";
import {
	buildCompletionMessage,
	formatBudgetLine,
	normalizeCompletionStatus,
	resolveDelivery,
	sendCompletionNotification,
	claimTerminalNotice,
	resolveRunEntry,
	buildMonitoringDegradedParagraph,
	sendMonitoringDegradedAdvisory,
} from "./notify-completion";
import { isTransportRetryable, TRANSPORT_RETRY_TOAST } from "./transport-retry";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * DRY helper (issue #154 review): shape an inventory of items into a single
 * comma-delimited summary line for the LLM-facing delegation guidance. Both
 * the B1 preset-restriction summary and the B1b template summary load an
 * inventory at registration, map each item to a formatted string, then join.
 */
export function buildInventorySummary<T>(items: T[], formatItem: (item: T) => string): string {
	return items.map(formatItem).join(", ");
}

/**
 * Format one built-in template into a compact summary entry for the conductor:
 * `name` (+ ` (lowercased description; slots ${a}, ${b})`) — the slot note is
 * omitted when the template declares no params, and the description is omitted
 * when it is empty. Mirrors the B1b summary shape (issue #154 review).
 */
export function formatTemplateSummaryItem(t: TaskTemplate): string {
	const slots = [...new Set([
		...extractParamNames(t.task),
		...(t.outputFile ? extractParamNames(t.outputFile) : []),
	])];
	const slotNote = slots.length > 0
		? `; slots ${slots.map((s) => `\${${s}}`).join(", ")}`
		: "";
	const desc = t.description
		? `${t.description.charAt(0).toLowerCase()}${t.description.slice(1)}`
		: "";
	return `${t.name}${desc ? ` (${desc}${slotNote})` : slotNote}`;
}

/**
 * Render the template guideline line with the built-in inventory summary
 * interpolated. Exported so the guidance test can assert the RENDERED text
 * rather than the literal `${templateSummary}` placeholder that a double-quoted
 * string would leave in the conductor-facing guidance (issue #154 review).
 */
export function buildTemplateGuideline(templateSummary: string): string {
	return `Templates are file-backed task starters with \${param} slots. Built-in templates: ${templateSummary}. Custom templates are NOT listed here — inspect them via /brl-subagent templates before choosing one.`;
}

/**
 * Issue #354 review minor: the synchronous shutdown cleanup, extracted so the
 * real body (not a hand-mirrored copy) is exercised by tests. Clears every
 * session-bound live collection, resets the counters, and stops both footer
 * timers. Ordering is significant: the ticker is stopped before the linger is
 * cleared, and the maps are cleared before their guard claim set.
 */
export function cleanupSessionState(state: SessionState): void {
	// Clear all live subagent sessions
	state.subagentSessions.clear();
	// Drop pending finalize claims too (PR #71 review: the claim set must
	// not outlive the map it guards — a fresh session could otherwise
	// no-op on an id a stale claim still remembers).
	state.resetLiveFinalizeClaims();
	// Reset counters
	state.activeSubagents = 0;
	state.completedSubagents = 0;
	state.failedSubagents = 0;
	state.unseenSubagents = 0;
	// Issue #354: the footer ticker must not outlive the session (it also
	// drops the elapsed anchor, so a new session starts its own clock), and
	// neither may the 3 s linger timer (F2) — it would repaint a dead pane.
	stopProgressTicker(state);
	clearProgressLinger(state);
	// Clear pending queue
	state.pendingQueue.length = 0;
}

/**
 * Issue #401/#411: the resume preamble a transport auto-retry builds and delivers
 * as a `<resume-context>` section on the child's system prompt — never inside
 * the `<task>` fence. A dropped connection costs the child its context, not its
 * files: the retry spawns into the same directory, so the work it already did
 * (commits, written files, a bank) is still there. The preamble turns a blind
 * replay into a resume by naming what to inspect first.
 *
 * Kept bounded (5 lines max) and deliberately vetted for runtime vocabulary —
 * it is prompt text a user can see in the child's system prompt.
 *
 * Issue #404: it also names the retained SDK session directory when one exists.
 * That is the only artifact that holds attempt 1's CONVERSATION — the output log
 * is a start/steering stub — and the settle path retains it for exactly this
 * class of run. The pointer is absolute and computed conductor-side at build
 * time: the retry's child can run in a different cwd (worktree/branch mode), so
 * a relative path would point at the wrong tree. The exists gate is deliberate:
 * an attempt whose session was not retained (size floor, marker failure, a
 * legacy run) gets the bank-only preamble, never a dead path.
 */
function buildRetryResumePreamble(
	run: SubagentRun,
	nextAttempt: number,
	retainedSessionDir?: string,
): string {
	const sanitize = (value: string): string => value.replace(/[^A-Za-z0-9._-]/g, "-");
	const label = sanitize(run.label ?? "");
	// A label made only of separators ("---") is not a filename; fall back to the
	// (UUID-shaped, hence already safe) id.
	const bankLabel = /[A-Za-z0-9]/.test(label) ? label : sanitize(run.id);
	const lines = [
		`[attempt ${nextAttempt} — the previous attempt (${run.id}) died on a transport failure.`,
		"This directory may already contain its uncommitted edits.",
		`Before acting, inspect: \`git status --short\`, \`git log --oneline -8\`, and the progress bank at /tmp/brl-${bankLabel}-bank.md if it exists.`,
		"Continue from what exists; do NOT redo committed, written, or banked work.]",
	];
	if (retainedSessionDir) {
		// Insert before the closing line so the block still reads as one unit.
		lines.splice(
			lines.length - 1,
			0,
			`The previous attempt's session is retained at ${retainedSessionDir} — read the newest .jsonl inside (ISO-prefixed names sort lexicographically) to recover what it had worked out.`,
		);
	}
	return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

/**
 * Compile-time coverage (issue #229 item 4): fails to compile if
 * DelegateTaskParams omits any KNOWN_DELEGATE_KEYS entry. Runtime drift is
 * invisible (the schema passes the key through, the handler ignores it), so
 * only the compiler can catch it. Together with per-step-model.test.ts's
 * runtime ratchet this closes the chain: registered schema <-> KNOWN_DELEGATE_KEYS <-> DelegateTaskParams.
 */
type _KnownDelegateKey = (typeof KNOWN_DELEGATE_KEYS extends Set<infer K> ? K : never) & string;
type _ExpectNever<T extends never> = T;
type _DelegateParamCoverage = _ExpectNever<Exclude<_KnownDelegateKey, keyof DelegateTaskParams>>;

/**
 * Issue #379: `ResolveInputParams` derives from the schema via `Pick`, so a
 * params field ADDED to the schema is not in the resolver's input until the
 * key list names it — and a missed field is invisible at runtime (the key
 * reaches execute and is silently unused). Only the compiler can catch it.
 *
 * The excluded keys are the ones resolution deliberately does not read: the
 * execution-shape inputs (`chain`/`tasks`/`graph`), the template machinery
 * (`template` is the exception — it IS read, so it stays in the resolver;
 * `params` is not), the retry inputs, and the per-dispatch fields
 * (`model`/`priority`/`background`) that resolve outside this merge.
 */
type _NonResolutionDelegateKey =
	| "chain"
	| "tasks"
	| "graph"
	| "params"
	| "retryRunId"
	| "retryOnTimeout"
	| "model"
	| "priority"
	| "background"
	// Issue #412: `force`/`noJev` are consumed at the validation seam (they
	// reach `validatePreTask`, not the merge), so `force` stays in the resolver's
	// key list while `noJev` — never read by resolution — is excluded here.
	| "noJev";
type _ResolveInputCoverage = _ExpectNever<
	Exclude<_KnownDelegateKey, keyof ResolveInputParams | _NonResolutionDelegateKey>
>;

export default function (pi: ExtensionAPI) {
	// ADR 0027 (S2): the composition root builds the runtime once per invocation
	// and composes the mode runners over it. `state` is no longer a rebindable
	// `let`: the context owns the instance, and a rebind here would be a second
	// owner of the store the runners hold.
	const rt = createRuntime(pi);
	const { log, state } = rt;
	const { runChainMode, runParallelMode, runGraphMode, resolveStepModel, applyUnitShapeGuard } = createModeRunners(rt);

	// Issue #147: the completion-push subscriber needs the session context to
	// resolve the run entry (state.getLogicalRunEntries(ctx)). The event-bus listener
	// receives no ctx, so capture it in session_start where it is available.
	let sessionCtx: ExtensionContext | undefined;

	// Option B U3 (D2): "one recovery notice per boot". The boot scan may be
	// followed by more session_starts in the same process (reload); without this
	// guard every one would re-list the same interrupted runs. Reset on shutdown
	// so a genuinely new session notifies again.
	let recoveryNoticeDelivered = false;

	// -------------------------------------------------------------------
	// Config change callback
	// -------------------------------------------------------------------

	function applyConfig(ctx: ExtensionContext, message: string) {
		// Issue #354: a config change mid-run must not blank the footer —
		// repaintStatus renders the activity line while runs are active and
		// falls back to the idle config line when none are.
		repaintStatus(state, ctx);
		state.persistState(pi);
		ctx.ui.notify(message, "info");
	}

	function resetState(ctx: ExtensionContext) {
		state.reset();
		// Templates are file-backed (issue #66): state.reset() clears
		// state.config.templates, so reload them from disk — otherwise
		// template lookups stay empty until the next session_start.
		// Full stack: custom (project+global) merged over builtins.
		state.config.templates = loadAllTemplates(ctx.cwd, log);
		// Issue #81: cross-check template `preset:` refs against the full
		// preset universe now that both loads are complete — warn (never skip)
		// for dangling references instead of running preset-less silently.
		validateTemplatePresetRefs(
			state.config.templates,
			getAllPresets(state.builtinPresets, state.customPresets),
			log,
		);
		repaintStatus(state, ctx);
		state.persistState(pi);
		ctx.ui.notify("Subagent configuration reset", "info");
	}

	// -------------------------------------------------------------------
	// Parameter resolution (extracted to src/params.ts — issue #59)
	// -------------------------------------------------------------------

	// The model-precedence chain lives in prelude.ts (issue #379) so the batch
	// modes' tail (`resolveModeModel`) and these single/background paths resolve
	// identically; this wrapper keeps their call shape (context + preset +
	// per-call override) unchanged.
	function resolveSubagentModel(
		ctx: ExtensionContext,
		preset: SubagentPreset | undefined,
		perCallModel?: string, // NEW: top-level delegate_task model param (issue #96)
	): SubagentModelResolution {
		return resolveSubagentModelPrecedence({ state, ctx, log, preset, perCallModel });
	}

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
		const globalModelResult = resolveSubagentModel(
			ctx,
			globalParams.resolvedPreset,
			params.model as string | undefined,
		);
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
		spawn: {
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
		},
	): Promise<BackgroundAgentSpawnResult> {
		const { spawnBackgroundSession, setAgentFinalOutput, extractFinalOutput } = await import('./session-manager');
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
		const bgModelResult = resolveSubagentModel(ctx, bgResolvedPreset, params.model);
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

	// -------------------------------------------------------------------
	// /brl-subagent command
	// -------------------------------------------------------------------

	pi.registerCommand("brl-subagent", {
		description: "Configure subagent model and thinking level",
		getArgumentCompletions: (prefix: string) => {
			const options = [
				"history", "historyentries", "monitor", "dashboard", "preset", "templates", "retry", "completionnotify", "recovery",
			];
			const filtered = options.filter((o) => o.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((o) => ({ value: o, label: o }))
				: null;
		},
		handler: async (args, ctx) => {
			const trimmed = args?.trim();

			const handlers: Record<string, () => Promise<void> | void> = {
				model: () => showModelSelector(ctx, state, applyConfig),
				thinking: () => showThinkingSelector(ctx, state, applyConfig),
				concurrency: () => showConcurrencyInput(ctx, state, applyConfig),
				depth: () => showDepthInput(ctx, state, applyConfig),
				approval: () => showApprovalModeSelector(ctx, state, applyConfig),
				completionnotify: () => showCompletionNotifySelector(ctx, state, applyConfig),
				recovery: () => showRecoverySelector(ctx, state, applyConfig),
				costlimit: () => showCostLimitInput(ctx, state, applyConfig),
				reset: () => resetState(ctx),
				history: () => showRunHistory(ctx, state, () => state.persistState(pi)),
				historyentries: () => showHistoryEntriesInput(ctx, state, applyConfig),
				monitor: () => showMonitor(ctx, state),
				dashboard: () => showDashboard(ctx, state),
				preset: () => showPresetManager(ctx, state),
				templates: () => showTemplateManager(ctx, state),
				retry: () => showRetryMenu(ctx, state, (id) => abandonProductionRun(ctx, id)),
			sla: () => showSLAConfig(ctx, state, applyConfig),
			"sla-stats": () => showSLAStats(ctx, state),
			// E5: the compliance report menu (file access / secrets exposure /
			// full summary) shipped in tui.ts but had no handler key, so
			// `/brl-subagent compliance` fell through to the config menu and the
			// feature was unreachable (broken wiring, not dead code).
			compliance: () => showComplianceMenu(ctx, state),
			};

			if (trimmed && trimmed in handlers) {
				await handlers[trimmed]();
			} else if (trimmed?.startsWith("templates")) {
				await handlers.templates();
			} else if (trimmed?.startsWith("preset")) {
				await handlers.preset();
			} else {
				await showConfigMenu(ctx, state, handlers);
			}
		},
	});

	// -------------------------------------------------------------------
	// delegate_task tool
	// -------------------------------------------------------------------

	// B1: Load built-in presets once at registration to expose their tool
	// restrictions to the conductor before any delegate_task call happens.
	const registrationPresets = loadBuiltinPresets(pkgPath("presets"));
	const presetRestrictionSummary = buildInventorySummary(registrationPresets, (p) => {
		const restricted = p.excludeTools?.length || p.tools?.length;
		if (!restricted) return p.name;
		return `${p.name} (${formatPresetRestriction(p)})`;
	});

	// B1b: Load built-in templates once at registration to expose the built-in
	// inventory (name + purpose + ${param} slots) to the conductor before any
	// delegate_task call. Custom/user templates can't be enumerated statically,
	// so the summary covers built-ins only and points at /brl-subagent templates.
	const registrationTemplates = loadBuiltinTemplates(pkgPath("templates"));
	const templateSummary = buildInventorySummary(registrationTemplates, formatTemplateSummaryItem);

	// Issue #158: resolve the shipped AGENT.md from the extension's own directory
	// rather than a hardcoded sync-copy destination, so npm-installed packages
	// (installed via `pi install npm:brl-subagent`) can find it.
	const agentMdPath = pkgPath("AGENT.md");

	pi.registerTool({
		name: "delegate_task",
		label: "Delegate Task",
		description: [
			"Delegate a task to the brl-subagent with isolated context.",
			"The subagent inherits your current system prompt and runs with",
			"its configured model and thinking level (set via /brl-subagent).",
			"If no subagent model is configured, your current model is used.",
			"The subagent reports what it did when complete.",
			"Optionally provide a custom systemPrompt and control inheritance via inheritSystemPrompt.",
		].join(" "),
		promptSnippet:
			"Delegate tasks to a subagent for isolated, parallel or background work",
		promptGuidelines: [
			"Use delegate_task when the user asks you to hand off work to a subagent, or when a task would benefit from an isolated context window (e.g., deep investigation, parallel research, long-running analysis).",
			`The authoritative capability reference for delegation is the extension's AGENT.md — read it at ${agentMdPath}, or ./AGENT.md in the project root when present, when planning delegation-heavy work.`,
			"The subagent inherits your system prompt and runs with its own model (configurable via /brl-subagent). It reports what it did when done.",
			"You can customize per-call via inheritSystemPrompt and systemPrompt: set inheritSystemPrompt: false to save context, provide a systemPrompt for custom instructions, or use both to add instructions on top of inheritance.",
			"Set thinkingLevel per call to match task complexity. The level is capped at the user's configured maximum. Map tasks to levels using this heuristic: off = file listing, grep, simple read. minimal = file diff, syntax check, find-and-replace. low = refactoring, test generation, documentation. medium = default — code review, debugging, moderate analysis. high = security audit, architecture review, complex debugging. xhigh = multi-step causal reasoning, research, novel problem solving. Default to 'off' or 'minimal' for trivial tasks — do not waste the user's budget.",
			"Use outputFile to have the subagent write full findings to disk and return only a structured summary — saves context tokens for large investigations.",
			"Set timeout (in ms) to limit how long a subagent can run. Useful for tasks that might hang or get stuck. Background runs default to a 30-minute deadline when no timeout is given; an explicit timeout is honored as given (30 minutes is a default, not a ceiling).",
			"Set cwd to override the subagent's working directory. Defaults to the current project directory.",
			"Set label to give the subagent a human-readable name (e.g., 'security-audit' or 'docs-review'). Labels appear in the status bar and tool call display.",
			`Use preset to apply a delegation configuration (built-in or custom via /brl-subagent preset). Preset values are defaults — explicit parameters override them. IMPORTANT: some presets restrict tools — e.g. outputFile requires the subagent's write tool, which security-auditor and code-reviewer exclude. Built-in presets: ${presetRestrictionSummary}. Custom presets are NOT listed here — inspect them via /brl-subagent preset before combining with outputFile or tool-dependent work. When combining a preset with outputFile or tool-dependent work, verify the preset allows the required tools.`,
			buildTemplateGuideline(templateSummary),
			"To retry a failed subagent, pass its run ID as retryRunId. The retry restores the recorded params - including background, gitMode, approvalMode, force - with explicit values on this call winning. Multi-step runs degrade to a single task. See the retryRunId description for the full field list.",
			"Set retryOnTimeout: true to automatically retry a FOREGROUND subagent that times out. Only retries once — the second timeout is treated as a final failure. A background run is not retried on its deadline, but it IS retried once automatically when it dies on a transport-class error (a dropped connection before the work started), recorded as attempt 2 and announced with a warning toast — do not re-dispatch it yourself. Any other background failure needs an explicit retryRunId.",
			"Background is the CONDITIONAL default for delegate_task. With background omitted, a single task or a tasks fan-out runs in the BACKGROUND when the effective approvalMode is 'auto' (call param, else config): the tool returns an agent ID immediately, and with tasks it fans out — every task starts as its own background agent, one ID per task in task order, and the conductor is woken once per agent as each finishes. It stays FOREGROUND when the effective approvalMode is 'writes' or 'always' (a background run has no approval dialog, so a gate that needs the user must keep blocking), and for chain and graph (they block by definition; an explicit background: true with chain/graph is rejected). Pass background: false for a quick probe whose answer the next step needs inline; pass background: true to force a background run where the default would block. Background runs wake the conductor with a structured completion message when they finish — do not poll: polling is only correct when completion notifications are disabled (completionNotify \"off\"); one status check as a stall check is legitimate. A background run defaults to a 30-minute deadline when no timeout is given.",
			"",
			"## Conductor Guardrails",
			"",
			"Before delegating, verify the subagent configuration matches the task:",
			"",
			"2. **Thinking level**: Match thinking level to task complexity: off/minimal for trivial tasks (file listing, grep), low for refactoring/docs, medium for code review/debugging, high for security audits/complex debugging, xhigh for multi-step reasoning/novel problems.",
			"3. **Git mode**: Use gitMode='branch' for tasks that create commits or PRs. Use gitMode='none' for read-only tasks.",
			"4. **Tools**: Verify the subagent has the tools it needs. If the task writes files, ensure write and edit are not excluded. If the task runs commands, ensure bash is not excluded.",
			"5. **Timeout**: Set timeout based on task complexity. Simple: 30s. Medium: 60s. Complex: 120s+. xhigh thinking: at least 120s. Background runs default to a 30-minute deadline when no timeout is set; an explicit timeout is honored.",
			"",
			"These guardrails prevent common misconfigurations. The extension also validates configuration before spawning (H1): tool warnings are surfaced in the returned result, but two mismatches are HARD errors that reject the delegation — outputFile with the write tool excluded, and a capability-critical task/toolset mismatch (a run/execute/test/compile/benchmark task without bash, or an exploration task with none of find/ls/grep/bash; pass force: true to override the capability class). Getting it right the first time is faster and more efficient.",
			"",
			"Before delegating, evaluate existing presets to find the best match for the task: tech-writer (documentation), code-reviewer (code review), security-auditor (security analysis), test-engineer (test writing), debugger (debugging), refactorer (refactoring), data-analyst (data analysis), rapid-prototyper (quick prototypes). Use the preset parameter to apply the best match. If no preset fits, use dev-agent for general development tasks.",
			"The autoRoutePreset() function can automatically select the best preset based on task keywords. Consider using it for preset selection.",
			"Prefer a preset when the delegation matches a standard shape — review/audit/test/docs; override per-call deliberately.",
		],
		parameters: delegateTaskParamsSchema,

		async execute(
			_toolCallId: string,
			params: DelegateTaskParams,
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<DelegateTaskDetails> | undefined,
			ctx: ExtensionContext,
		) {
			// Option B U1: the run a retryRunId resolves to (spawn entry). Internal
			// record identity — dispatchId/resumeOf/attempt are threaded onto the new
			// record, NOT through the delegate-param surface (D4).
			let retrySourceRun: SubagentRun | undefined;
			// Issue #99: warn on unknown params — typebox allows additional properties
			// by default (pi's validateToolArguments passes unknown keys through), so a
			// typo like `thinkinglevel` or a schema-drifted param is otherwise silently
			// ignored. Warn-not-reject: never break a delegation.
			const unknownKeys = findUnknownParams(params, KNOWN_DELEGATE_KEYS);
			if (unknownKeys.length > 0) {
				log.warn("delegate_task: unknown param(s) ignored — check spelling or add to schema", { unknown: unknownKeys });
				// Issue #110: log.warn alone is invisible — pi's TUI swallows extension
				// console output. Route through pi.sendMessage (the subagent-notification
				// pattern, index.ts ~2312) so BOTH the LLM (followUp enters the
				// conversation) and the human (session transcript) see the correction.
				pi.sendMessage({
					customType: "delegate-notification",
					content: `delegate_task: unknown param(s) ignored — check spelling or add to schema: ${unknownKeys.join(", ")}`,
					display: true,
					details: { unknown: unknownKeys },
				}, { deliverAs: "followUp" });
			}

			// Handle template resolution — MUST run before the single-mode sanitize
			// block below: a template ASSIGNS params.task, so resolving first lets the
			// sanitizer validate the real resolved body (a template-only call has no
			// task yet) and lets mode detection see a non-empty task (issue #175).
			if (params.template) {
				const templateEntry = state.config.templates.find((t) => t.name === params.template);
				if (!templateEntry) {
					const available = state.config.templates.map((t) => t.name).join(", ") || "none";
					return {
						content: [
							{
								type: "text" as const,
								text: `Template '${params.template}' not found. Available: ${available}`,
							},
						],
						details: undefined,
						isError: true,
					};
				}

				const resolved = resolveTemplate(templateEntry, params.params ?? {});
				if (!resolved.ok) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Template '${params.template}' resolution failed: ${resolved.error}`,
							},
						],
						details: undefined,
						isError: true,
					};
				}

				const tv = resolved.value;
				// Issue #175 review (fix 4): template-wins silently replaces a
				// supplied `task`. If that task would itself have failed sanitization
				// (e.g. over-length), the caller gets no signal — pre-#175 `dev`
				// rejected it. Warn (never reject — #99/#110 precedent, same
				// pi.sendMessage channel as the unknown-param warning) so both the LLM
				// and the human see the ignored task. Emitted ONLY when the supplied
				// task actually fails sanitization: a valid task alongside a template
				// is the intended template-wins override (issue #57), not noise.
				if (params.task !== undefined) {
					const suppliedTask = sanitizeTask(params.task);
					if (!suppliedTask.ok) {
						log.warn("delegate_task: supplied task ignored because a template was given", {
							template: params.template,
							error: suppliedTask.error,
						});
						pi.sendMessage({
							customType: "delegate-notification",
							content: `delegate_task: the supplied 'task' was ignored because a template ('${params.template}') was given. The task would otherwise have been rejected: ${suppliedTask.error}`,
							display: true,
							details: { template: params.template, rejectedTask: suppliedTask.error },
						}, { deliverAs: "followUp" });
					}
				}
				// Issue #175 review (fix direction item 4): this assignment is
				// UNCONDITIONAL — the resolved template task replaces any supplied
				// `task` (template-wins, issue #57); it is NOT a default the caller can
				// override. The fields below, by contrast, ARE defaults: an explicitly
				// provided param wins over the template's value.
				params.task = tv.task;
				if (tv.preset && !params.preset) params.preset = tv.preset;
				if (tv.thinkingLevel && !params.thinkingLevel) params.thinkingLevel = tv.thinkingLevel;
				if (tv.outputFile && !params.outputFile) params.outputFile = tv.outputFile;
				if (tv.timeout !== undefined && params.timeout === undefined) params.timeout = tv.timeout;
				if (tv.tools && !params.tools) params.tools = tv.tools;
				if (tv.excludeTools && !params.excludeTools) params.excludeTools = tv.excludeTools;
				if (tv.noBuiltinTools !== undefined && params.noBuiltinTools === undefined) params.noBuiltinTools = tv.noBuiltinTools;
				if (tv.inheritSystemPrompt !== undefined && params.inheritSystemPrompt === undefined) params.inheritSystemPrompt = tv.inheritSystemPrompt;
			}

			// Handle retryRunId — MUST run after template resolution and before the
			// single-mode sanitize block. resolveRetryParams assigns params.task from
			// the recorded run, so the sanitizer must see the retried body (a
			// retry-only call has no task yet). It MUST run AFTER template resolution:
			// resolveRetryParams returns a fresh object that DROPS `template`, so
			// resolving templates first keeps a combined template + retryRunId call
			// from silently disabling template resolution (issue #175 review).
			if (params.retryRunId) {
				// Fix A: prefer the session spawn entry (it carries `originalParams`);
				// a run that exists ONLY in the durable registry after a fresh boot
				// resolves through the visibility bridge instead of being rejected as
				// not found — the id the boot notice names must resolve here.
				let runEntry = state.findSpawnRunById(ctx, params.retryRunId);
				if (!runEntry) {
					const { getAgent } = await import("./session-manager");
					runEntry = resolveTerminalRunEntry(
						visibleRunsFor(ctx, getAgent),
						params.retryRunId,
					);
				}
				if (runEntry) {
					retrySourceRun = runEntry;
					params = resolveRetryParams(params, runEntry) as DelegateTaskParams;
				} else {
					// Issue #98: a silent no-op here made retries of background runs
					// (which previously never wrote run entries) start as FRESH runs
					// with no signal to the caller. Fail loudly instead.
					log.warn("Retry run ID not found", { retryRunId: params.retryRunId });
					return {
						content: [{
							type: "text" as const,
							text: `Retry run ID not found: ${params.retryRunId}. The run may have been pruned, or it was a background run created before the run-entry fix. Pass the run's agent ID — for background runs the agent ID and run ID are now the same.`,
						}],
						details: undefined,
						isError: true,
					};
				}
			}

			// F1: Sanitize task input — skip for chain/parallel/graph modes
			const hasChain = params.chain && params.chain.length > 0;
			const hasParallel = params.tasks && params.tasks.length > 0;
			const hasGraph = params.graph && params.graph.length > 0;
			if (!hasChain && !hasParallel && !hasGraph) {
				// task is optional per the schema; single mode requires it. When absent,
				// feed "" to the sanitizer — same rejection path ("Task must not be
				// empty.") as when task was a required field.
				const taskResult = sanitizeTask(params.task ?? "");
				if (!taskResult.ok) {
					log.warn("Task rejected by sanitizer", { error: taskResult.error });
					return {
						content: [{ type: "text" as const, text: `Invalid task: ${taskResult.error}` }],
						details: undefined,
						isError: true,
					};
				}
				params.task = taskResult.value;
			}

			// P1+P2+P10: Mode detection — graph > chain > parallel > single
			const isChain = hasChain;
			const isParallel = hasParallel;
			const isGraph = hasGraph;
			const isSingle = typeof params.task === "string" && params.task.length > 0;

			const modeCount = [isChain, isParallel, isGraph, isSingle].filter(Boolean).length;
			if (modeCount !== 1) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								"Provide exactly one of: task (single), chain (sequential), tasks (parallel), or graph (dependency graph).",
						},
					],
					details: undefined,
					isError: true,
				};
			}

			const dispatchShape: DispatchShape = isChain
				? "chain"
				: isGraph
					? "graph"
					: isParallel
						? "parallel"
						: "single";

			// Capture the caller's value BEFORE the default is recorded on
			// `params.background` below. The guard must judge what the caller
			// actually asked for; reading the recorded value would make it depend
			// on the default. Keeping the capture first makes that ordering
			// self-evident (issue #361 review).
			const explicitBackground = params.background;

			// Issue #412 (rule 2: "no deadline ⇒ durable path") — the dispatch-shape
			// pre-flight. A high/xhigh-thinking run the conductor asked to run
			// FOREGROUND with an explicit timeout is the shape that lost 14 minutes of
			// plan critique on 2026-10-31: foreground runs persist nothing, so the
			// deadline kills the work outright, while a background run keeps its
			// session and is retried on a transport error. The switch is applied HERE
			// — after template/retry resolution and BEFORE `useBackground` is resolved
			// and before any run record is written — so the shape every downstream
			// reader sees (the spawn, the retry snapshot, the pending-work record) is
			// the switched one. Moving it after `snapshotOriginalParams` would record
			// `background:false` and silently cost the run its transport auto-retry
			// (`transport-retry.ts` classifies off that snapshot).
			// Issue #415: the switch is OUR process (a conductor decision rule), not
			// product behavior — a user's explicit foreground timeout is usually a
			// budget cap, so a GLOBAL switch could triple time and cost against
			// their instruction. The umbrella project-local `processChecks` flag
			// gates it (fail-open: no/malformed manifest → off). Resolve the
			// dispatch cwd ONCE, the way the target validation below will.
			const processChecksCwd =
				params.cwd === undefined ? ctx.cwd : path.resolve(ctx.cwd, params.cwd);
			const processChecks = readProcessChecks(processChecksCwd);
			// The preset the dispatch will actually run with — an auto-routed
			// `code-reviewer`/`debugger` is a high-thinking run even though the
			// caller declared no level, so the pre-flight resolves the SAME preset
			// the merge below will (one rule, `resolveDispatchPreset`).
			const declaredPresetForSwitch = resolveDispatchPreset(params, state).preset;
			// Issue #443: guard the EFFECTIVE DECLARED level here — the per-call value
			// or the selected preset's (named, or auto-routed by the line above) —
			// BEFORE `resolveSubagentParams` clamps it. `params.thinkingLevel` is
			// already the post-template, post-`retryRunId` value by this point, so a
			// level restored from a run record is judged too; a preset object injected
			// in memory never passed a schema or the preset-file validator, so this
			// is its only check. Everything below runs through this one seam: the
			// single, background, chain, parallel and graph handlers are all reached
			// from here, and the per-unit declarations are guarded by the pre-passes.
			const effectiveDeclaredThinkingLevel = declaredThinkingLevel(
				params.thinkingLevel,
				declaredPresetForSwitch?.thinkingLevel,
			);
			const declaredThinkingError = invalidThinkingLevelRejection(effectiveDeclaredThinkingLevel);
			if (declaredThinkingError) return declaredThinkingError;
			// The EFFECTIVE approval mode (call param, else the configured default) —
			// the same resolver `resolveSubagentParams` and the #361 default use, so the
			// pre-flight cannot judge a mode the child will not run with. Reading
			// `params.approvalMode` raw here would miss a config-tier mode entirely.
			const effectiveApprovalModeForSwitch = resolveEffectiveApprovalMode(
				params.approvalMode,
				state,
			);
			const thinkingSwitch = resolveThinkingDispatchSwitch({
				processChecks,
				thinkingLevel: effectiveDeclaredThinkingLevel as ThinkingLevel | undefined,
				explicitBackground,
				timeout: params.timeout,
				force: params.force,
				shape: dispatchShape,
				effectiveApprovalMode: effectiveApprovalModeForSwitch,
			});
			if (thinkingSwitch === "switch") {
				params.background = true;
				// Drop the foreground deadline: the 30-minute background default
				// (DEFAULT_BACKGROUND_DEADLINE_MS) applies instead. Recorded as
				// undefined, so a retry re-derives it rather than restoring the cap.
				params.timeout = undefined;
				log.info("Dispatch pre-flight: high-thinking foreground switched to background", {
					thinkingLevel: params.thinkingLevel,
					timeout: "dropped (background default applies)",
				});
				pi.sendMessage({
					customType: "delegate-notification",
					content: THINKING_SWITCH_NOTICE,
					display: true,
					details: { thinkingLevel: params.thinkingLevel, previousTimeout: "dropped" },
				}, { deliverAs: "followUp" });
				ctx.ui.notify(THINKING_SWITCH_NOTICE, "warning");
			} else if (thinkingSwitch === "drop-timeout") {
				// Issue #431 — the second arm: the shape cannot move (an effective
				// 'always'/'writes' run needs the interactive gate, and switching an
				// explicit-foreground 'always' dispatch would be REJECTED — #433), so
				// the only thing the pre-flight can remove is the deadline. Clearing it
				// HERE, before `snapshotOriginalParams` records the run (:3035
				// foreground, :2374 background), is what makes a retry re-derive an
				// absent deadline instead of restoring the cap (ADR 0009).
				const previousTimeout = params.timeout;
				params.timeout = undefined;
				log.info("Dispatch pre-flight: high-thinking foreground timeout dropped, shape kept", {
					thinkingLevel: params.thinkingLevel,
					previousTimeout,
					effectiveApprovalMode: effectiveApprovalModeForSwitch,
				});
				pi.sendMessage({
					customType: "delegate-notification",
					content: THINKING_TIMEOUT_DROP_NOTICE,
					display: true,
					details: {
						thinkingLevel: params.thinkingLevel,
						// The ACTUAL ms value, not "dropped": the friction log needs the
						// number to tell a budget cap from a tight clock.
						previousTimeout,
						effectiveApprovalMode: effectiveApprovalModeForSwitch,
					},
				}, { deliverAs: "followUp" });
				ctx.ui.notify(THINKING_TIMEOUT_DROP_NOTICE, "warning");
			} else if (thinkingSwitch === "forced") {
				// The override is recorded, not silent: the dispatch text is the reason
				// (`force` has no reason field — ADR 0007's contract stays unchanged).
				log.info("Dispatch pre-flight: high-thinking foreground forced", {
					thinkingLevel: params.thinkingLevel,
					timeout: params.timeout,
				});
			}

			// background: true with chain/graph was silently ignored — the batch ran
			// foreground (blocking until every unit finished) while the caller believed
			// it was background. Both remain rejected loudly at dispatch validation;
			// tasks (parallel) fans out into independent background agents instead.
			// Only an EXPLICIT true trips this (issue #361): an omitted `background`
			// now defaults to foreground here rather than being rejected.
			if (shouldRejectBackgroundForBatch(dispatchShape, explicitBackground)) {
				const batchMode = dispatchShape === "chain" ? "chain" : "graph";
				return {
					content: [
						{
							type: "text" as const,
							text: `background: true is not supported with ${batchMode} — batch modes run foreground and would block until every unit finishes. Remove background to run it foreground, or start each unit as its own single-task background call and sequence the dependencies yourself.`,
						},
					],
					details: undefined,
					isError: true,
				};
			}

			// Issue #361: background is the CONDITIONAL default for the shapes that
			// can run unattended. Resolved ONCE per dispatch and reused by the
			// single and fan-out paths below, so the decision cannot drift between
			// them. The approval mode is the EFFECTIVE one (call param, else the
			// configured default — presets declare no approvalMode today) — the same
			// value the child will run with — so the default never routes a run into a
			// background context that would break or silently auto-approve it
			// ('always' has no dialog; 'writes' gates the diff on approval).
			const useBackground =
				params.background ??
				defaultBackgroundFor(dispatchShape, resolveEffectiveApprovalMode(params.approvalMode, state));
			// Record the EFFECTIVE value on the dispatch (a no-op when the caller was
			// explicit): a run started by the default must retry as what it actually
			// was instead of re-deriving the default, which may since have moved with
			// the config. Fan-out units still record no background of their own — a
			// unit retries as a single foreground run (issue #229), unaffected here.
			params.background ??= useBackground;

			// Issue #434: the unit projection's inputs, resolved ONCE here so no
			// unit site can re-derive them (a relative `params.cwd` re-read of the
			// manifest measured `false` where this resolution measured `true`).
			// `noticeEmitted` starts true when the DISPATCH arm announced its own
			// change: the drop still reaches every eligible unit, but the dispatch
			// already spoke, and a second notice would double-report one decision.
			// (`forced` emits nothing — the caller asked for the explicit pair, so
			// there is nothing to announce and no arm acted.)
			const batchGuard: BatchGuardContext = {
				processChecks,
				dispatchDeclaredLevel: effectiveDeclaredThinkingLevel as ThinkingLevel | undefined,
				force: params.force as boolean | undefined,
				// A `tasks` fan-out spawns detached background units (their deadline is
				// the legitimate budget); every other batch handler runs its units
				// foreground. Chain/graph can never be background: an explicit
				// `background: true` batch was rejected above.
				unitShape: isParallel && useBackground ? "background" : "foreground",
				noticeEmitted: thinkingSwitch === "switch" || thinkingSwitch === "drop-timeout",
			};

			if (isChain) {
				if (params.chain!.length > MAX_CHAIN_STEPS) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Chain exceeds max ${MAX_CHAIN_STEPS} steps.`,
							},
						],
						details: undefined,
						isError: true,
					};
				}
				return runChainMode(params, signal, onUpdate, ctx, batchGuard);
			}

			if (isParallel) {
				if (params.tasks!.length > MAX_PARALLEL_TASKS) {
					return {
						content: [
							{
								type: "text" as const,
								text: `Parallel exceeds max ${MAX_PARALLEL_TASKS} tasks.`,
							},
						],
						details: undefined,
						isError: true,
					};
				}
				if (useBackground) return runBackgroundFanOut(pi, ctx, params, signal, batchGuard);
				return runParallelMode(params, signal, onUpdate, ctx, batchGuard);
			}

			if (isGraph) {
				return runGraphMode(params, signal, onUpdate, ctx, batchGuard);
			}

			// Single mode: isSingle is true (modeCount===1, none of chain/parallel/graph),
			// so params.task is a non-empty string. TS can't infer this through the
			// boolean-array filter — assert, mirroring params.chain!/params.tasks! above.
			const singleTask = params.task!; // non-empty (sanitizer guarantees; isSingle confirms)

			if (useBackground) {
				return spawnBackgroundRun(pi, ctx, params, singleTask, retrySourceRun);
			}

			// R5: Check session cost limit before spawning
			// Use a default per-task estimate of $0.05 if no perTaskCostEstimate is set
			const costError = gateSessionCost({
				state,
				ctx,
				log,
				units: 1,
				label: "Subagent delegation",
			});
			if (costError) return costError;

			// Reject delegation if recursion depth exceeds configured max.
			// This prevents subagents from spawning infinite sub-subagents while
			// still allowing other extensions to function normally in subprocesses.
			const currentDepth = getCurrentDepth();
			if (currentDepth >= state.config.maxSubagentDepth) {
				log.warn("Subagent delegation rejected: max depth reached", {
					currentDepth,
					maxDepth: state.config.maxSubagentDepth,
				});
				return depthLimitRejection(currentDepth, state.config.maxSubagentDepth);
			}

			const {
				task,
				label,
				inheritSP,
				customSP,
				outputFile,
				timeout,
				effectiveCwd,
				thinkingLevel,
				toolOptions,
				resolvedGitMode,
				resolvedApprovalMode,
				resolvedPreset,
				autoRoutedPreset,
				autoRouteKeyword,
			} = resolveSubagentParams({ ...params, task: singleTask }, state, ctx, log);

			// F1: Validate CWD
			const cwdResult = validateCwd(effectiveCwd, ctx.cwd);
			if (!cwdResult.ok) {
				return {
					content: [{ type: "text" as const, text: `Invalid cwd: ${cwdResult.error}` }],
					details: undefined,
					isError: true,
				};
			}
			const resolvedCwd = cwdResult.value;

			// F1: Validate outputFile
			let resolvedOutputFile: string | undefined;
			if (outputFile) {
				const ofResult = validateOutputFile(outputFile, resolvedCwd);
				if (!ofResult.ok) {
					return {
						content: [
							{ type: "text" as const, text: `Invalid outputFile: ${ofResult.error}` },
						],
						details: undefined,
						isError: true,
					};
				}
				resolvedOutputFile = ofResult.value;
			}

			// R3: Pre-flight checks — fail fast before consuming resources
			const pfResult = preflightCheck(resolvedCwd);
			if (!pfResult.ok) {
				log.warn("Pre-flight check failed", { error: pfResult.error });
				return {
					content: [{ type: "text" as const, text: `Pre-flight check failed: ${pfResult.error}` }],
					details: undefined,
					isError: true,
				};
			}

			// H1: Pre-task validation — deterministic check that tools/thinking match task
			// (`force` degrades capability errors to warnings — B2's override).
			const validation = validatePreTask({
				task,
				toolOptions,
				thinkingLevel,
				gitMode: resolvedGitMode,
				outputFile: resolvedOutputFile,
				force: params.force,
				cwd: resolvedCwd,
				noJev: params.noJev,
			});
			if (validation.warnings.length > 0) {
				log.warn("Pre-task validation warnings", { warnings: validation.warnings });
			}
			if (!validation.valid) {
				const errText = validation.errors.join("; ");
				log.warn("Pre-task validation failed", { errors: validation.errors });
				return {
					content: [{
						type: "text" as const,
						text: errText,
					}],
					details: undefined,
					isError: true,
				};
			}
			// C: surface warnings in the returned result (not just the log) —
			// shared renderer so foreground/background wording stays identical.
			const warningsNote = formatValidationWarnings(validation.warnings);

			// Resolve model (per-call top-level model override beats preset)
			const modelResult = resolveSubagentModel(ctx, resolvedPreset, params.model);
			if (!modelResult.ok) return modelResult.error;
			const subagentModel = modelResult.model;

			// R3: Verify resolved model provider+id is non-empty
			const modelStr = `${subagentModel.provider}/${subagentModel.id}`.trim();
			if (!modelStr || modelStr === "/") {
				log.warn("Model string is empty after resolution", { model: subagentModel });
				return modelNotConfiguredRejection();
			}

			// Create run record
			const runId = crypto.randomUUID();
			// Option B U1: durability identity — a retry inherits the original
			// dispatchId and records resumeOf/attempt; a fresh marker keys the
			// child process for boot-time orphan discovery.
			const identity = newDispatchIdentity(retrySourceRun);
			const run: SubagentRun = {
				id: runId,
				task,
				label,
				status: "running",
				model: `${subagentModel.provider}/${subagentModel.id}`,
				thinkingLevel,
				// Issue #114: record-level visibility — the run's priority (absent
				// when the caller left it to the default).
				priority: params.priority,
				startedAt: new Date().toISOString(),
				originalParams: snapshotOriginalParams(params),
				dispatchId: identity.dispatchId,
				resumeOf: identity.resumeOf,
				attempt: identity.attempt,
				owner: currentProcessOwner(),
				childMarker: crypto.randomUUID(),
				// U3 (D4): the session recovery posture at dispatch.
				recoveryPosture: state.config.recovery,
			};
			state.persistRun(pi, run, "foreground");

			// R2: Prune old run entries if history exceeds limit
			pruneHistoryIfNeeded(state, ctx, log);

			// Register for live monitor
			// Issue #423: the merged timeout is the display deadline (absent → no
			// deadline; a foreground run has no 30m default).
			registerLiveRun(state, run, ctx, undefined, timeout);

			// P3: Git integration — set up work branch if gitMode is "branch"
			let headState: HeadState | undefined;
			let workBranchName: string | undefined;
			// Issue #466 (ADR 0026 D6): the foreground path creates the same work
			// branch with the same crash exposure, so it writes and clears the same
			// durable record — with `kind: "foreground"`, so "no record" means "no
			// orphan" for every branch run, not just background ones.
			let headStateRoot: string | undefined;
			const clearForegroundHeadState = (): void => {
				if (!headStateRoot) return;
				clearHeadState(headStateRoot);
				headStateRoot = undefined;
			};
			if (resolvedGitMode === "branch") {
				try {
					headState = getHeadState(resolvedCwd);

					if (hasUncommittedChanges(resolvedCwd)) {
						log.warn("Uncommitted changes detected; proceeding with branch-based workflow anyway", {
							cwd: resolvedCwd,
						});
					}

					// Written BEFORE the branch exists (D1): the name must be minted here.
					headStateRoot = getRepoRoot(resolvedCwd) ?? resolvedCwd;
					workBranchName = newWorkBranchName();
					if (!writeHeadState({
						version: HEAD_STATE_VERSION,
						repoRoot: headStateRoot,
						runId: run.id,
						kind: "foreground",
						base: headState,
						workBranch: workBranchName,
						owner: currentProcessOwner(),
						createdAt: new Date().toISOString(),
					})) {
						log.warn("headState record could not be written — an interrupted run will name no base", {
							runId: run.id,
							workBranch: workBranchName,
						});
					}

					const branchResult = createWorkBranch(resolvedCwd, headState.sha, workBranchName);
					if (branchResult.ok) {
						log.info("Created work branch for subagent", {
							branch: workBranchName,
							base: headState.branch,
						});
					} else {
						log.error("Failed to create work branch, falling back to 'none'", {
							error: branchResult.error,
						});
						// Nothing was created: nothing to repair.
						clearForegroundHeadState();
						headState = undefined;
						workBranchName = undefined;
					}
				} catch (err) {
					log.warn("Not a git repository or git error; falling back to gitMode 'none'", {
						error: (err as Error).message,
					});
					clearForegroundHeadState();
					headState = undefined;
					workBranchName = undefined;
				}
			}

			// Helper to restore the starting HEAD and delete the work branch. The
			// delete is NOT gated on the restore succeeding: the branch must never
			// survive teardown. A still-checked-out branch simply makes deleteBranch
			// fail (logged) rather than silently leaking the ref.
			const cleanupGitBranch = () => {
				if (!workBranchName) return;
				if (headState) {
					const restoreResult = restoreHead(resolvedCwd, headState);
					if (restoreResult.ok) {
						log.info("Restored original HEAD", {
							branch: headState.branch,
							detached: headState.detached,
						});
						// Issue #466: verified off the work branch — the record is done.
						// A FAILED restore keeps it: the base lives only in the record.
						clearForegroundHeadState();
					} else {
						log.warn("Failed to restore original HEAD during cleanup", {
							branch: headState.branch,
							error: restoreResult.error,
						});
					}
				}
				// Attempt to delete the work branch (non-critical)
				const deleteResult = deleteBranch(resolvedCwd, workBranchName);
				if (!deleteResult.ok) {
					log.warn("Failed to delete work branch during cleanup", {
						branch: workBranchName,
						error: deleteResult.error,
					});
				}
			};

			// #340: both pre-start gate rejections below must finalize the
			// `running` record persisted just above. Without this the session entry
			// stays non-terminal, the inflight registry row (written by
			// `persistRun(..., "foreground")`) is never cleared, and the live
			// registration is never released — a phantom interrupted run at the
			// next boot (and, on a retry, a dangling twin beside the source).
			// The fabricated result drives `finalizeRunRecord` to terminal
			// `failed`; `stopReason: "aborted"` makes `coherentFailureReason` keep
			// the D1 `aborted` category coherent. The exact gate message the caller
			// receives is recorded as `errorMessage`; the terminal
			// `state.persistRun` (no kind) clears the registry row via its
			// terminal-clear rule. Returned content/isError and the retry-source
			// retention below are unchanged.
			const SLOT_CANCEL_MESSAGE = "Subagent cancelled while waiting for concurrency slot.";
			const finalizePreStartRejection = (errorMessage: string): void => {
				const rejection: SubagentResult = {
					messages: [],
					usage: { ...EMPTY_USAGE },
					exitCode: 1,
					stderr: "",
					stopReason: "aborted",
					errorMessage,
					errorCategory: "aborted",
				};
				finalizeRunRecord(run, rejection, "", new Date(run.startedAt).getTime());
				run.originalParams = { ...run.originalParams, errorCategory: rejection.errorCategory };
				state.persistRun(pi, run);
				state.finalizeLiveSubagent(run.id);
			};

			// R1: Circuit breaker check — reject if circuit is open
			const circuitCheck = state.checkCircuit();
			if (circuitCheck.isOpen) {
				finalizePreStartRejection(circuitCheck.message!);
				cleanupGitBranch();
				return {
					content: [{ type: "text" as const, text: circuitCheck.message! }],
					details: undefined,
					isError: true,
				};
			}

			// Resolve priority (issue #99 R2: single mode honors priority like chain/parallel/graph)
			const singlePriority: Priority = (
				params.priority && ["critical", "high", "normal", "low"].includes(params.priority)
					? (params.priority as Priority)
					: DEFAULT_PRIORITY
			);

			// Acquire concurrency slot
			const acquired = await acquireSlot(state, ctx, signal, singlePriority);
			if (!acquired) {
				finalizePreStartRejection(SLOT_CANCEL_MESSAGE);
				cleanupGitBranch();
				return {
					content: [
						{
							type: "text" as const,
							text: SLOT_CANCEL_MESSAGE,
						},
					],
					details: undefined,
					isError: true,
				};
			}

			let success = false;

			// Retire-on-retry (O3 fold, decision 2026-10-11): the retry has passed
			// every pre-spawn gate and is about to start, so the SOURCE interrupted
			// registry entry is superseded — clear it here so the old run is not
			// re-offered at every subsequent boot. A failed pre-start (circuit open,
			// slot cancelled) returns ABOVE this point: the source is left intact
			// and retryable, while the NEW twin has already been finalized terminal
			// by the gate (#340) — nothing dangles. `retrySourceRun` is set only on
			// a `retryRunId` call.
			if (retrySourceRun) clearInflightRun(retrySourceRun.id);

			// F7 (issue #65): import BEFORE the try — the crash-path catch calls
			// completeTranscript, and block-scoped consts declared inside the try
			// are invisible in its catch (pre-fix, a crash here threw
			// "completeTranscript is not defined" instead of returning the
			// sanitized crash result).
			const { startTranscript, completeTranscript } = await import('./transcript');

			try {
				// Build system prompt
				const basePrompt = ctx.getSystemPrompt();
				const subagentPrompt = buildSubagentPrompt(
					basePrompt,
					inheritSP,
					customSP,
					resolvedOutputFile,
					toolOptions?.tools,
					resolvedPreset?.promptGuideline,
				);

				// Emit initial progress
				const modeInfo = describePromptMode(inheritSP, Boolean(customSP));
				onUpdate?.({
					content: [
						{
							type: "text" as const,
							text: `Starting subagent (${modeInfo})...`,
						},
					],
					details: {
						messages: [],
						usage: { ...EMPTY_USAGE },
						exitCode: -1,
						stderr: "",
					},
				});

				// Wrap onUpdate to feed live monitor
				const liveOnUpdate = makeLiveOnUpdate(state, runId, onUpdate);

				const childDepth = currentDepth + 1;

				// Start transcript for audit trail
				startTranscript(runId, task);

				let result = await runSubagent(
					resolvedCwd,
					subagentPrompt,
					subagentModel,
					thinkingLevel,
					task,
					signal,
					liveOnUpdate,
					toolOptions,
					timeout,
					getFinalOutput,
					log,
					childDepth,
					undefined, // intercom
					undefined, // subagentId
					run.childMarker,
				);

				// Auto-retry on timeout
				if (
					params.retryOnTimeout &&
					isSubagentError(result) &&
					result.errorMessage?.includes("timed out")
				) {
					log.info("Auto-retrying after timeout", { runId });
					// Issue #423: the retry restarts the clock, so its display deadline is
					// re-anchored on it (the same clock `startedAt` carries). Registering
					// also clears the finalize claim, so the row is live again.
					const retryStartedAt = Date.now();
					const retryDeadlineAt =
						timeout && timeout > 0 ? retryStartedAt + timeout : undefined;
					state.registerLiveSubagent(runId, {
						id: runId,
						label,
						task,
						model: run.model,
						thinkingLevel,
						priority: params.priority,
						startedAt: retryStartedAt,
						...(retryDeadlineAt !== undefined ? { deadlineAt: retryDeadlineAt } : {}),
						ctx,
					});

					onUpdate?.({
						content: [
							{ type: "text" as const, text: "Retrying after timeout..." },
						],
						details: {
							messages: [],
							usage: { ...EMPTY_USAGE },
							exitCode: -1,
							stderr: "",
						},
					});

					result = await runSubagent(
						resolvedCwd,
						subagentPrompt,
						subagentModel,
						thinkingLevel,
						task,
						signal,
						liveOnUpdate,
						toolOptions,
						timeout,
						getFinalOutput,
						log,
						childDepth,
						undefined, // intercom
						undefined, // subagentId
						run.childMarker,
					);
				}

				// F3: Sanitize and cap output
				let finalOutput = getFinalOutput(result.messages);
				finalOutput = stripAnsi(finalOutput);
				finalOutput = capOutput(finalOutput);

				// Attach label for display
				result.label = label;

				// P3: Capture git diff if we created a work branch
				if (workBranchName && headState) {
					// Diff against the captured starting sha rather than the branch
					// name: a detached start's branch label is the "HEAD" pseudo-ref,
					// for which `git diff HEAD...HEAD` is always empty.
					const diffResult = captureDiff(resolvedCwd, headState.sha);
					if (diffResult.ok) {
						result.gitBranch = workBranchName;
						result.gitDiff = diffResult.diff;
					}

					// Restore the starting HEAD (branch, or detached sha)
					const restoreResult = restoreHead(resolvedCwd, headState);
					if (restoreResult.ok) {
						log.info("Restored original HEAD", {
							branch: headState.branch,
							detached: headState.detached,
						});
						// Issue #466: the tree is verified off the work branch, so the
						// durable record has nothing left to repair.
						clearForegroundHeadState();

						// P4: Change approval workflow — let user review the diff
						const diffContent = (result.gitDiff ?? "").trim();
						const hasChanges = diffContent.length > 0;
						const shouldPrompt =
							ctx.hasUI !== false &&
							(resolvedApprovalMode === "always" ||
								(resolvedApprovalMode === "writes" && hasChanges));

						if (shouldPrompt) {
							const choice = await showApprovalDialog(ctx, label, result.gitDiff ?? "", workBranchName);

							if (choice === "apply") {
								const mergeResult = mergeWorkBranch(resolvedCwd, workBranchName);
								if (mergeResult.ok) {
									log.info("Merged work branch (approved)", { branch: workBranchName });
									result.approved = true;
								} else {
									log.error("Failed to merge work branch", {
										branch: workBranchName,
										error: mergeResult.error,
									});
									result.approved = false;
								}
							} else {
								// Discard or cancelled
								deleteBranch(resolvedCwd, workBranchName);
								log.info("Discarded work branch", { branch: workBranchName });
								result.approved = false;
							}
							workBranchName = undefined; // Prevent double-cleanup
						} else if (hasChanges) {
							// Auto-approve: merge the work branch
							const mergeResult = mergeWorkBranch(resolvedCwd, workBranchName);
							if (mergeResult.ok) {
								log.info("Merged work branch (auto-approve)", { branch: workBranchName });
								result.approved = true;
							} else {
								log.error("Failed to merge work branch (auto-approve)", {
									branch: workBranchName,
									error: mergeResult.error,
								});
							}
							// #308: a DETACHED start has no branch of its own to hold the
							// merge result — teardown re-detached at the captured sha and
							// the merge fast-forwarded THAT detached HEAD, so deleting the
							// work branch would leave the committed work reachable only
							// from the detached HEAD (silently lost on the next checkout).
							// Keep the branch as the durable ref and log where the work
							// lives. An ATTACHED start merged onto its own branch, which
							// already retains the commit, so the temporary work branch is
							// safe to drop.
							if (headState.detached) {
								log.info("detached checkout: work preserved on branch", {
									branch: workBranchName,
								});
							} else {
								deleteBranch(resolvedCwd, workBranchName);
							}
							workBranchName = undefined;
						} else {
							// No changes — just delete the empty branch
							deleteBranch(resolvedCwd, workBranchName);
							workBranchName = undefined;
						}
					} else {
						log.warn("Failed to restore original HEAD after work-branch run", {
							branch: headState.branch,
							error: restoreResult.error,
						});
					}

					// Nothing may leave teardown with the work branch still present: the
					// approval flow above clears workBranchName on every terminal choice
					// (including "apply", where keeping the branch is intentional), so a
					// still-set name means the restore failed and the flow was skipped.
					if (workBranchName) {
						deleteBranch(resolvedCwd, workBranchName);
						workBranchName = undefined;
					}
				}

				// Finalize run record
				finalizeRunRecord(
					run,
					result,
					finalOutput,
					new Date(run.startedAt).getTime(),
				);
				run.originalParams = {
					...run.originalParams,
					errorCategory: result.errorCategory,
				};
				state.persistRun(pi, run);

				// R2: Prune old run entries
				pruneHistoryIfNeeded(state, ctx, log);

				// Finalize live monitor
				state.finalizeLiveSubagent(runId);

				// E4: SLA tracking — compute metrics if enabled
				if (state.config.slaTrackingEnabled) {
					const recentRuns = state.getLogicalRunEntries(ctx).slice(0, state.config.slaWindowSize);
					const metrics = computeSLAMetrics(recentRuns);
					log.info("SLA metrics computed", {
						totalRuns: metrics.totalRuns,
						successRate: metrics.successRate,
						p95DurationMs: metrics.p95DurationMs,
						totalCost: metrics.totalCost,
					});
					if (state.config.lastSLAMetrics) {
						const report = computeDegradation(metrics, state.config.lastSLAMetrics);
						if (report.degraded) {
							log.warn("SLA degradation detected", {
								successRateChange: report.successRateChange,
								p95Change: report.p95Change,
								recommendations: report.recommendations,
							});
						}
					}
					state.config.lastSLAMetrics = metrics;
				}

				if (isSubagentError(result)) {
					const errorMsg =
						result.errorMessage ||
						result.stderr ||
						finalOutput ||
						"(no output from subagent)";
					log.warn("Subagent failed", {
						runId,
						error: errorMsg,
						exitCode: result.exitCode,
						errorCategory: result.errorCategory,
					});

					// H3: Post-mortem diagnostics — suggest fixes for the failure
					const suggestions = diagnoseFailure({
						task,
						toolOptions,
						thinkingLevel,
						gitMode: resolvedGitMode,
						errorMessage: result.errorMessage,
						exitCode: result.exitCode,
						timeout,
					});

					// R1: Record failure in circuit breaker
					state.recordFailure();

					let finalMsg = `Subagent failed: ${errorMsg}`;
					if (suggestions.length > 0) {
						finalMsg += "\n\nSuggestions:\n" + suggestions.map((s) => `- ${s}`).join("\n");
					}
					// C: warnings ride the returned result too — a failed run is
					// exactly when the conductor most needs the mismatch signal.
					finalMsg += warningsNote;

				completeTranscript(runId, 'failed');

					return {
						content: [
							{ type: "text" as const, text: finalMsg },
						],
						details: result,
						isError: true,
					};
				}

				success = true;
				completeTranscript(runId, 'completed');
				log.info("Subagent completed successfully",{
					runId,
					tokensIn: result.usage.input,
					tokensOut: result.usage.output,
					cost: result.usage.cost,
					sessionTotalCost: state.getSessionTotalCost(ctx),
				});

				// R1: Record success in circuit breaker
				state.recordSuccess();

				// B2: Surface auto-route decisions in the tool result so the conductor
				// sees WHICH preset was auto-selected, the KEYWORD evidence for it,
				// and what it restricts. Derive the restriction from the RESOLVED
				// toolOptions (reflects per-call overrides) rather than the preset's
				// declared values.
				const autoRouteNote = autoRoutedPreset
					? `\n\n[auto-routed to preset '${autoRoutedPreset.name}'${autoRouteKeyword ? ` (matched keyword '${autoRouteKeyword}')` : ""} — ${toolOptions ? formatToolRestriction(toolOptions) : formatPresetRestriction(autoRoutedPreset)}]`
					: "";

				return {
					content: [
						{ type: "text" as const, text: (finalOutput || "(no output)") + autoRouteNote + warningsNote },
					],
					details: result,
				};
			} catch (err) {
				// P3: Clean up git branch on crash
				cleanupGitBranch();
				completeTranscript(runId, 'failed');

				const result = buildCrashResult("Subagent", err, resolvedCwd);
				log.error("Subagent crashed", { runId, error: result.details.errorMessage });

				// R2 (review): mirror the completion path — finalize the live entry
				// and persist a FAILED run record. Without this the live entry stays
				// 'running' forever, the stale sweep never reclaims it, and the
				// drill-in loops on the live branch indefinitely. finalizeLiveSubagent
				// is idempotent (true = THIS call claimed it; the foreground path has
				// no activeSubagents counters to gate).
				state.finalizeLiveSubagent(runId);
				const crashOutput = state.subagentSessions.get(runId)?.liveOutput ?? "";
				finalizeRunRecord(
					run,
					result.details,
					crashOutput,
					new Date(run.startedAt).getTime(),
				);
				state.persistRun(pi, run);

				return result;
			} finally {
				releaseSlot(state, success, ctx);
			}
		},

		renderCall(
			args: DelegateTaskParams,
			theme: Theme,
			_context: unknown,
		) {
			return renderDelegateCall(args, theme);
		},

		renderResult(
			result: AgentToolResult<DelegateTaskDetails>,
			options: ToolRenderResultOptions,
			theme: Theme,
			_context: unknown,
		) {
			return renderDelegateResult(result, options, theme);
		},
	});

	// -------------------------------------------------------------------
	// get_subagent_result tool — retrieve terminal status/result on demand
	// -------------------------------------------------------------------

	pi.registerTool({
		name: "get_subagent_result",
		label: "Get Subagent Result",
		description: [
			"Check the status of a background agent and retrieve its result.",
			"The conductor is woken with a completion message when the agent finishes; use this for post-wake retrieval, stall checks, and detail access — not for polling.",
			"Accepts a full agent id or a unique 8-character id prefix.",
			"When the id belongs to a retried run, the answer names the latest attempt; a finished run that was superseded also reports its successor.",
			"Returns the agent's status, result (if completed), and transcript path.",
		].join(" "),
		parameters: Type.Object({
			agent_id: Type.String({
				description: "The agent ID returned by delegate_task when background=true",
			}),
			verbose: Type.Optional(
				Type.Boolean({
					description: "If true, include the full conversation log. Default: false.",
				}),
			),
		}),
		execute: async (toolCallId, params) => {
			const { getAgent, resolveAgentId, findRetryLineage, isTerminalAgentStatus, RETRY_SCAN_WINDOW_MS, RETRY_SCAN_WINDOW_DAYS } = await import('./session-manager');
			const { getTranscript } = await import('./transcript');

			// The notices render the first 8 hex characters of an id; resolve a
			// unique prefix before both the record read and the lineage lookup.
			// Ambiguity fails closed — a guess here could report the wrong run.
			const resolution = resolveAgentId(params.agent_id);
			if (resolution.kind === 'ambiguous') {
				return {
					content: [{
						type: "text" as const,
						text: `Agent id prefix "${params.agent_id}" is ambiguous — matches: ${resolution.matches.join(', ')}`,
					}],
					details: undefined,
					isError: true,
				};
			}
			// Anything that is not a full id or a matching 8-hex prefix keeps
			// today's message — there is no id to resolve against the stores.
			if (resolution.kind === 'unresolved') {
				return {
					content: [{ type: "text" as const, text: `Agent ${params.agent_id} not found` }],
					details: undefined,
					isError: true,
				};
			}
			const agentId = resolution.id;

			const agent = getAgent(agentId);
			
			if (!agent) {
				const lineage = findRetryLineage(agentId);
				if (lineage.latest && lineage.latest.id !== agentId) {
					const latest = lineage.latest;
					return {
						content: [{
							type: "text" as const,
							text: `Agent ${params.agent_id} not found — run ${params.agent_id} was retried as ${latest.id} (attempt ${latest.attempt}, ${latest.status}, started ${new Date(latest.startedAt).toISOString()}).`,
						}],
						details: undefined,
						isError: true,
					};
				}

				const registryRun = lineage.inflight.find((run) => run.id === agentId);
				const registryStarted = registryRun
					? (Number.isFinite(Date.parse(registryRun.startedAt))
						? new Date(registryRun.startedAt).toISOString()
						: registryRun.startedAt)
					: undefined;
				const registryText = registryRun
					? `no recent retry lineage recorded, but the registry still lists run ${registryRun.id} (attempt ${registryRun.attempt ?? 1}, started ${registryStarted}).`
					: `no recent retry lineage recorded (scanned the last ${RETRY_SCAN_WINDOW_DAYS} days), and no registry record either.`;
				return {
					content: [{
						type: "text" as const,
						text: `Agent ${params.agent_id} not found — ${registryText}`,
					}],
					details: undefined,
					isError: true,
				};
			}
			
			let resultText = `Agent: ${agent.description}\n`;
			resultText += `Status: ${agent.status}\n`;
			resultText += `Started: ${new Date(agent.startedAt).toISOString()}\n`;
			
			if (agent.completedAt) {
				resultText += `Completed: ${new Date(agent.completedAt).toISOString()}\n`;
				resultText += `Duration: ${agent.completedAt - agent.startedAt}ms\n`;
			}

			// Issue #423: the budget the run actually ran under — from the PERSISTED
			// record, so it survives the closure that armed the timer. The result
			// path has no run entry to consult, so the timeout evidence is the
			// agent's own error stamp (one shared predicate owns both paths).
			const budgetLine = formatBudgetLine(
				agent,
				normalizeCompletionStatus(agent.status),
				undefined,
			);
			if (budgetLine) resultText += `${budgetLine}\n`;
			
			if (agent.error) {
				resultText += `Error: ${agent.error}\n`;
			}

			// A terminal source can be the WRONG run to act on: the retry that
			// actually finished is a later attempt of the same dispatch. Name it
			// so a terminal status is not read as the final word.
			if (isTerminalAgentStatus(agent.status)) {
				const lineage = findRetryLineage(agentId, agent);
				if (lineage.latest && lineage.latest.id !== agentId) {
					const latest = lineage.latest;
					resultText += `Superseded by ${latest.id} (attempt ${latest.attempt}, ${latest.status}, started ${new Date(latest.startedAt).toISOString()})\n`;
				} else if (agent.startedAt < Date.now() - RETRY_SCAN_WINDOW_MS) {
					// The lineage scan is windowed: an older run cannot be shown a
					// later attempt that fell outside it. Say so instead of implying
					// there is none.
					resultText += `Retry lineage not checked: this run started more than ${RETRY_SCAN_WINDOW_DAYS} days ago.\n`;
				}
			}
			
			if (agent.result) {
				resultText += `\nResult:\n`;
				if (agent.result.messages && agent.result.messages.length > 0) {
					resultText += agent.result.messages.join('\n');
				}
				// W4: surface the background agent's git work-branch diff so the
				// captured changes are reviewable (the branch itself is discarded).
				if (agent.result.gitBranch) {
					resultText += `\nGit branch: ${agent.result.gitBranch}\n`;
				}
				if (agent.result.gitDiff) {
					const diff = agent.result.gitDiff;
					const truncated = diff.length > 8000 ? diff.slice(0, 8000) + "\n…[diff truncated]" : diff;
					resultText += `\nGit diff (branch ${agent.result.gitBranch ?? 'work'}):\n${truncated}\n`;
				}
			}
			
			if (agent.finalOutput) {
				const full = agent.finalOutput;
				const truncated = full.length > 8000 ? full.slice(0, 8000) + "\n…[truncated — full output in transcript]" : full;
				resultText += `\n\nFinal output:\n${truncated}`;
			}
			
			// Include transcript if verbose
			if (params.verbose) {
				const transcript = getTranscript(agentId);
				if (transcript.length > 0) {
					resultText += `\n\nTranscript (${transcript.length} entries):\n`;
					for (const entry of transcript.slice(-10)) { // Last 10 entries
						resultText += `[${new Date(entry.timestamp).toISOString()}] ${entry.type}: ${entry.content.slice(0, 100)}\n`;
					}
				}
			}
			
			// Include transcript path
			resultText += `\nTranscript: ${transcriptDisplayPath(agentId)}`;
			
			return {
				content: [{ type: "text" as const, text: resultText }],
				details: undefined,
			};
		},
	});

	// -------------------------------------------------------------------
	// steer_subagent tool — inject messages into running agents
	// -------------------------------------------------------------------

	// steer_subagent tool — inject messages into running agents
	pi.registerTool({
		name: "steer_subagent",
		label: "Steer Subagent",
		description: [
			"Send a steering message to a running background agent.",
			"The message is delivered after the agent's current tool call finishes, before its next model call.",
			"Use this to redirect an agent's work without restarting it.",
		].join(" "),
		parameters: Type.Object({
			agent_id: Type.String({
				description: "The agent ID to steer",
			}),
			message: Type.String({
				description: "The message to inject into the agent's conversation",
			}),
		}),
		execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
			const { steerAgent } = await import('./session-manager');
			
			try {
				const agent = await steerAgent(params.agent_id, params.message);
				
				if (!agent) {
					return {
						content: [{ type: "text" as const, text: `Agent ${params.agent_id} not found` }],
						details: undefined,
						isError: true,
					};
				}
				
				return {
					content: [{
						type: "text" as const,
						text: `Steered agent ${params.agent_id}: "${params.message.slice(0, 50)}${params.message.length > 50 ? '...' : ''}"`,
					}],
					details: undefined,
				};
			} catch (err) {
				// F7 (issue #65): sanitize BEFORE the message reaches the main
				// agent's context. pi passes ctx as the 5th arg to tool execute,
				// so ctx.cwd is in scope — sibling-project paths are properly
				// masked (defensive process.cwd() fallback if ctx is undefined).
				const message = sanitizeErrorMessage(err instanceof Error ? err.message : String(err), ctx?.cwd);
				return {
					content: [{ type: "text" as const, text: `Failed to steer agent: ${message}` }],
					details: undefined,
					isError: true,
				};
			}
		},
	});

	pi.registerTool({
		name: "stop_subagent",
		label: "Stop Subagent",
		description: [
			"Stop a running background agent by aborting its session.",
			"The agent's current operation is aborted and the session is marked stopped.",
			"Use this to halt a background agent that is no longer needed.",
		].join(" "),
		parameters: Type.Object({
			agent_id: Type.String({
				description: "The agent ID to stop",
			}),
		}),
		execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
			const { stopAgent } = await import('./session-manager');
			
			try {
				const agent = await stopAgent(params.agent_id);
				
				if (!agent) {
					return {
						content: [{ type: "text" as const, text: `Agent ${params.agent_id} not found` }],
						details: undefined,
						isError: true,
					};
				}
				
				return {
					content: [{
						type: "text" as const,
						text: `Stopped agent ${params.agent_id} (${agent.description}).`,
					}],
					details: undefined,
				};
			} catch (err) {
				// F7 (issue #65): sanitize BEFORE the message reaches the main
				// agent's context. pi passes ctx as the 5th arg to tool execute,
				// so ctx.cwd is in scope — sibling-project paths are properly
				// masked (defensive process.cwd() fallback if ctx is undefined).
				const message = sanitizeErrorMessage(err instanceof Error ? err.message : String(err), ctx?.cwd);
				return {
					content: [{ type: "text" as const, text: `Failed to stop agent: ${message}` }],
					details: undefined,
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------
	// Session lifecycle — F7: Session-bound state initialization
	// -------------------------------------------------------------------

	// -------------------------------------------------------------------
	// Option B U1: boot recovery — identity/liveness detection + child reap
	// -------------------------------------------------------------------
	// Runs AFTER restoreFromSession so config is ready. Candidate runs come from
	// the DURABLE registry (`.pi/run-registry/`), NOT from this session's run
	// entries: a crashed session's foreground/unit records are invisible to a
	// default fresh startup, and the full `.pi/subagents/` store is too costly to
	// parse (only the one agent record a background entry names is read). For
	// each in-flight run whose owner is dead, its orphaned marker-verified child
	// is reaped and the record is marked: the registry entry always, plus the
	// agent record for background runs. The scan itself is SILENT in the UI —
	// U3's `maybeSendRecoveryNotice` (below) is the one notice surface.
	// Platforms without /proc skip the whole scan (one log line):
	// pid-only liveness cannot rule out pid reuse, so nothing is killed or
	// marked unverified.
	async function performBootRecovery(): Promise<void> {
		try {
			const { getAgent, markAgentInterrupted } = await import("./session-manager");
			// `recoverProduction` owns the /proc platform guard (nothing is marked or
			// killed without start-token verification) — see src/recovery.ts.
			const summary = await recoverProduction({
				log,
				// Read THAT ONE agent record by id — never the whole store.
				readAgentRecord: (id) => getAgent(id),
				mark(record, interruptedAt) {
					// Registry entry = the durable mark for every kind. Issue #304: its
					// boolean is the durable-write result — do NOT drop it, or the boot
					// summary would claim a mark that never landed. The scan counts a
					// `false` as `markFailures` and warns with the id.
					const durable = markInterrupted(record.id, interruptedAt);
					if (record.kind === "agent") markAgentInterrupted(record.id, interruptedAt);
					return durable;
				},
				// Issue #447: a dispatch whose acceptance marker is still `null` never
				// reached `session.prompt()`. It is finalized `failed` here — a
				// terminal write, so `persistRunRecord` retires the registry entry in
				// the same call and no interrupted/retry surface can pick it up.
				finalizeNeverStarted: (run) => {
					state.persistRun(pi, run);
				},
			});
			// Report the scan whenever it did anything durable OR attempted a mark
			// that failed — a failure-only boot must not be silent (issue #304).
			if (summary.marked > 0 || summary.markFailures > 0) {
				log.warn("Boot recovery marked interrupted runs", { ...summary });
			}
			// Issue #447: never-started dispatches are finalized, not marked — a
			// separate line so the two outcomes cannot be read as one another.
			if (summary.neverStarted > 0) {
				log.info("Boot recovery finalized never-started dispatches", {
					count: summary.neverStarted,
				});
			}
		} catch (err) {
			// Recovery is best-effort hygiene — it must never break session start.
			log.warn("Boot recovery scan failed", { error: (err as Error).message });
		}
	}

	/**
	 * Issue #466 (ADR 0026 D2): the git/process surface the head-state table
	 * reads, wired once so the boot step and its tests cannot drift apart.
	 */
	function headStateDeps(): HeadStateDeps {
		const procDeps = defaultRecoveryDeps();
		return {
			getRepoRoot,
			classifyOwner: (owner) => classifyOwner(owner, procDeps),
			getHeadBranch,
			restoreHead,
			hasUncommittedChanges,
			listWorkBranches,
		};
	}

	/**
	 * Issue #466: the boot's ONE git-mutating step, between the scan (which only
	 * marks records) and the notices. Best-effort like the scan — a failing store
	 * must never break session start — but every record still ends in exactly one
	 * LOGGED verdict (D5: silence is not a verdict).
	 *
	 * The repair itself is NEVER gated by `config.recovery`: a tree left on a dead
	 * run's branch is a correctness problem, not a recovery offer. Only the notice
	 * below is gated.
	 */
	function reconcileHeadStatesAtBoot(): HeadStateOutcome[] {
		try {
			const outcomes = reconcileHeadStates(headStateDeps());
			for (const outcome of outcomes) {
				log.info("Boot head-state verdict", { ...outcome });
			}
			// Housekeeping, never part of the repair contract: only a record whose
			// repository no longer resolves (or that cannot be parsed) is swept, so
			// a live orphan's base is never deleted by age.
			const swept = sweepHeadStates({
				repoGone: (record) => getRepoRoot(record.repoRoot) === undefined,
			});
			if (swept > 0) log.info("Swept stale head-state records", { count: swept });
			return outcomes;
		} catch (err) {
			log.warn("Boot head-state reconciliation failed", { error: (err as Error).message });
			return [];
		}
	}

	/**
	 * Issue #466 (D5): the repair and the needs-manual verdict reach the user
	 * once, on the same `nextTurn` channel as the recovery notice, and are gated
	 * by `config.recovery !== "off"` like every other boot surface.
	 */
	function maybeSendHeadStateNotice(outcomes: HeadStateOutcome[]): void {
		if (state.config.recovery === "off") return;
		const notice = buildHeadStateNotice(outcomes);
		if (!notice) return;
		try {
			pi.sendMessage(notice, resolveRecoveryNoticeDelivery());
			log.info("Head-state notice delivered", { count: notice.details.count });
		} catch (err) {
			// The notice is best-effort — it must never break session start.
			log.warn("Head-state notice failed", { error: (err as Error).message });
		}
	}

	/**
	 * Option B U3 Fix A: the recovery visibility bridge, wired for the two
	 * extension consumers that resolve a run id (the retryRunId branch and the
	 * abandon action). Session run entries UNIONED with synthetic durable
	 * interrupted records the session has never seen (a genuine fresh boot), so
	 * an id named by the boot notice resolves here instead of being rejected as
	 * not found. `getAgent` is injected because the callers already load it
	 * dynamically — this keeps the registry/agent reads in ONE place.
	 */
	function visibleRunsFor(
		ctx: ExtensionContext,
		getAgent: RecoveryAgentLookup,
	): SubagentRun[] {
		return visibleRunEntriesForSession(state.getLogicalRunEntries(ctx), getAgent);
	}

	/**
	 * Option B U3 (D2): after the boot scan, send ONE notice at the next turn
	 * boundary listing every unresolved interrupted run whose dispatch snapshot
	 * (and the session posture) says "offer". Delivery is `nextTurn` — the notice
	 * can never steer or arrive mid-turn (see `resolveRecoveryNoticeDelivery`).
	 * Silent when there is nothing to offer; at most once per session start.
	 */
	async function maybeSendRecoveryNotice(ctx: ExtensionContext): Promise<void> {
		if (recoveryNoticeDelivered) return;
		recoveryNoticeDelivered = true;
		// Session posture off silences the whole surface, regardless of per-run
		// snapshots (a user opting out expects quiet).
		if (state.config.recovery === "off") return;
		try {
			const { getAgent } = await import("./session-manager");
			const offered = offeredInterruptedRuns(
				collectInterruptedRuns({
					listInflight: () => listInflightRuns(),
					getAgent: (id) => getAgent(id),
					findRun: (id) => state.findTerminalRunById(ctx, id),
				}),
			);
			if (offered.length === 0) return;
			pi.sendMessage(buildRecoveryNotice(offered), resolveRecoveryNoticeDelivery());
			log.info("Recovery notice delivered", { count: offered.length });
		} catch (err) {
			// The notice is best-effort — it must never break session start.
			log.warn("Recovery notice failed", { error: (err as Error).message });
		}
	}

	/**
	 * Option B U3 (D5): finalize ONE interrupted run as the existing terminal
	 * `stopped` outcome and prune its U2 session dir. Wired through injected deps
	 * so the pure core (`recovery-surface.ts`) stays testable; the run record is
	 * written terminal (the run store's `status` union has no `stopped` — a
	 * stopped outcome is represented as `failed` + `errorCategory: "aborted"`,
	 * exactly as every other stop path does) and the background agent record is
	 * flipped to `stopped`.
	 */
	async function abandonProductionRun(ctx: ExtensionContext, id: string): Promise<void> {
		const { updateAgentStatus, pruneBackgroundSession, getAgent } = await import("./session-manager");
		// Fix A: the abandon lookup routes through the visibility bridge, so a run
		// that exists ONLY in the durable registry after a fresh boot is
		// abandonable instead of resolving to undefined (the silent `false`).
		const visible = visibleRunsFor(ctx, getAgent);
		abandonInterruptedRun(id, {
			getRun: (runId) => resolveTerminalRunEntry(visible, runId),
			writeRun: (run) => {
				state.persistRun(pi, run);
				pruneHistoryIfNeeded(state, ctx, log);
			},
			markAgentStopped: (agentId) => {
				const agent = updateAgentStatus(agentId, "stopped");
				if (agent) log.info("Abandoned background agent record", { agentId });
			},
			retireRegistry: (runId) => clearInflightRun(runId),
			pruneSession: (runId) => pruneBackgroundSession(runId),
		});
	}

	pi.on("session_start", async (_event, ctx) => {
		// Issue #147: capture the session context for the completion-push subscriber.
		sessionCtx = ctx;
		// Issue #179 (D6): createLogger ran at module load with no cwd — point
		// the shared file sink at this session's cwd now that it exists.
		setLogCwd(ctx.cwd);
		// Load built-in presets
		const presetsDir = pkgPath("presets");
		state.builtinPresets = loadBuiltinPresets(presetsDir, log);
		state.customPresets = loadCustomPresets(ctx.cwd, log);
		// Builtin templates + merged full stack (custom overrides builtin)
		const templatesDir = pkgPath("templates");
		state.builtinTemplates = loadBuiltinTemplates(templatesDir, log);
		state.config.templates = loadAllTemplates(ctx.cwd, log, templatesDir);

		// Issue #81: cross-check template `preset:` refs against the full
		// preset universe now that both loads are complete — warn (never skip)
		// for dangling references instead of running preset-less silently with
		// auto-route suppressed.
		validateTemplatePresetRefs(
			state.config.templates,
			getAllPresets(state.builtinPresets, state.customPresets),
			log,
		);

		// Migration: write any session-persisted presets to files
		if (state._migratedPresets && state._migratedPresets.length > 0) {
			for (const preset of state._migratedPresets) {
				writePresetFile(preset, path.join(ctx.cwd, ".pi", "brl-subagent", "presets"));
			}
			state._migratedPresets = undefined;
			state.customPresets = loadCustomPresets(ctx.cwd, log);
			state.config.templates = loadAllTemplates(ctx.cwd, log);
			log?.info("Migrated presets from session to files");
		}

		// R2: Clean stale temp dirs from previous sessions
		cleanupTempDirs(ctx.cwd).then((count) => {
			if (count > 0) log.info("Cleaned stale temp directories", { count });
		});

		log.info("Session started", {
			builtinPresets: state.builtinPresets.length,
			builtinTemplates: state.builtinTemplates.length,
			presetsDir,
		});

		// F5/F9: Safe state restoration with type guards
		state.restoreFromSession(ctx);

		// Option B U1: reap a dead conductor's orphaned children and mark the
		// records interrupted BEFORE anything else touches their worktrees.
		await performBootRecovery();

		// Issue #466 (ADR 0026 D2/D5): reconcile the durable head-state records —
		// the ONE step allowed to move git at boot, and only for a record whose
		// owner it has proved dead.
		const headStateOutcomes = reconcileHeadStatesAtBoot();

		// Option B U3 (D2): after the scan, surface every unresolved interrupted
		// run ONCE, at the next turn boundary (never mid-turn).
		await maybeSendRecoveryNotice(ctx);

		// Issue #466: the head-state verdicts ride the same nextTurn channel.
		maybeSendHeadStateNotice(headStateOutcomes);

		// Issue #356: boot is a config-paint edge — route it through the same
		// chokepoint as every other footer repaint. With no runs in flight the
		// chokepoint draws the idle config line the old direct call painted.
		repaintStatus(state, ctx);
	});

	// F7: Clean up session-bound state on shutdown
	pi.on("session_shutdown", async (_event, _ctx) => {
		// Issue #437: release THIS runtime's terminal subscribers FIRST — before
		// any await or fallible cleanup. A clean replacement (/new, /resume,
		// /fork, /reload, quit) tears this runtime down and loads a new factory
		// instance; the old listeners used to survive and win the shared terminal
		// claim for the NEW session's run, delivering (or throwing) through dead
		// pi/ctx handles. Only our three exact identities are removed, and the
		// release is idempotent, so other subscribers and a later runtime are
		// untouched. `releaseTerminalSubscriptions` is a hoisted declaration
		// below (the subscription block is registered after this handler).
		releaseTerminalSubscriptions();

		log.info("Session shutting down", {
			activeSubagents: state.activeSubagents,
		});

		// Option B U1: reap in-flight foreground children first, so a clean exit
		// never orphans a subprocess (the crash case is covered by boot recovery).
		try {
			await reapActiveChildren(log);
		} catch (err) {
			log.warn("Shutdown reap failed", { error: (err as Error).message });
		}

		cleanupSessionState(state);
		// U3: a new session boot may notify again.
		recoveryNoticeDelivered = false;
	});

	// -------------------------------------------------------------------
	// Issue #147: completion-push wake — subscribe to terminal event-bus events
	// -------------------------------------------------------------------
	// The event-bus is the complete terminal chokepoint (subagent:completed /
	// subagent:failed / subagent:stopped), so the conductor is woken via
	// pi.sendMessage + triggerTurn when a background run reaches a terminal state.
	// Delivery is always-on (minimum nextTurn); the completionNotify knob controls
	// the WAKE (D1+D2 — see notify-completion.ts). The shared terminal claim
	// (issue #315) defends the pathological double-emit path (first terminal
	// event or crash notice per id wins); it is capped simply (cleared when it
	// exceeds 200 entries).
	//
	// Stopped-run degradation — ACCEPTED BY DESIGN (review #2, adjudicated
	// 2026-09-01): subagent:stopped fires at stop time (updateAgentStatus) BEFORE
	// finalizeRunEntry stamps cost/duration/errorCategory and before finalOutput
	// is captured. So the stopped shape may lack those fields and the run entry
	// resolveRunEntry returns may be the pre-finalize spawn entry. The wake is
	// the point; details are best-effort — the notification must never throw or
	// block on their absence.
	const terminalTypes = ["subagent:completed", "subagent:failed", "subagent:stopped"] as const;

	// Issue #437: keep the EXACT listener references this factory instance owns.
	// Anonymous subscriptions could never be released, so a shut-down runtime's
	// listeners stayed on the shared bus forever. Ownership is per factory
	// invocation: the array and the released flag are this runtime's alone, so a
	// replacement's listeners are never in the removal set.
	const terminalSubscriptions: Array<{
		type: (typeof terminalTypes)[number];
		listener: SubagentEventListener;
	}> = [];
	let terminalSubscriptionsReleased = false;

	/**
	 * Issue #437: unsubscribe exactly the listeners registered above.
	 *
	 * Idempotent — a repeated/double `session_shutdown` (or a late one after the
	 * replacement runtime is already live) is a no-op. Synchronous, so it can run
	 * as the first statement of `session_shutdown`, before any await or fallible
	 * cleanup. Never touches another subscriber or another runtime's listeners.
	 */
	function releaseTerminalSubscriptions(): void {
		if (terminalSubscriptionsReleased) return;
		terminalSubscriptionsReleased = true;
		for (const { type, listener } of terminalSubscriptions) {
			eventBus.off(type, listener);
		}
		terminalSubscriptions.length = 0;
	}

	for (const type of terminalTypes) {
		const listener: SubagentEventListener = (event) => {
			void deliverCompletionAlert(event);
		};
		terminalSubscriptions.push({ type, listener });
		eventBus.on(type, listener);
	}

	/**
	 * Issue #365: re-dispatch a background run that settled with a transport-class
	 * failure, using the `retryRunId` machinery. `resolveRetryParams({}, run)`
	 * restores the recorded params and `spawnBackgroundRun(..., run)` mints the
	 * lineage (`resumeOf` + `attempt: 2`), so the retry re-runs the normal gates
	 * (cost, approval, pre-task) and is visible in the record.
	 *
	 * Issue #401/#411: the retry carries a resume preamble (`attemptContext`) that
	 * is injected into the child's system prompt only (as a `<resume-context>`
	 * section), never inside the `<task>` fence. The task handed to
	 * `resolveSubagentParams` stays the recorded original, so auto-routing, H1
	 * keyword warnings and the capability checks behave exactly as they did on
	 * attempt 1.
	 *
	 * Returns TRUE when the retry was actually spawned — the caller then SUPPRESSES
	 * the source run's completion notice, because the retry's own terminal settle
	 * is the wake. A gate rejection or a throwing spawn returns FALSE and the
	 * caller reports the original failure exactly as before (no silent drop).
	 *
	 * Issue #439: this reads only `isError`, and a retry whose post-spawn tail
	 * faulted is still a SUCCESSFUL spawn (`isError: false`, degraded monitoring).
	 * It therefore returns TRUE for it: the source notice stays suppressed and the
	 * degraded advisory is the signal that the retry started with degraded
	 * monitoring. Reading a contained tail failure as "did not start" would
	 * surface the source failure for a run that is live.
	 */
	async function scheduleTransportRetry(
		ctx: ExtensionContext,
		run: SubagentRun,
	): Promise<boolean> {
		const sourceAttempt = run.attempt ?? 1;
		try {
			const retryParams = resolveRetryParams({}, run);
			// Issue #404: point at the retained session ONLY when it is really
			// there. Resolve this conductor-side: the child may run in another cwd.
			// An invalid id cannot have a session dir (and `backgroundSessionDir`
			// throws on one) — no pointer, no throw.
			let retainedSessionDir: string | undefined;
			try {
				const { retainedSessionPointer } = await import('./session-manager');
				const candidate = retainedSessionPointer(run.id);
				if (fs.existsSync(candidate)) retainedSessionDir = candidate;
			} catch {
				retainedSessionDir = undefined;
			}
			const result = await spawnBackgroundRun(
				pi,
				ctx,
				retryParams,
				retryParams.task!,
				run,
				buildRetryResumePreamble(run, sourceAttempt + 1, retainedSessionDir),
			);
			if (result.isError) {
				log.warn("Transport auto-retry spawn rejected — surfacing the original failure", {
					sourceId: run.id,
					attempt: sourceAttempt,
					error: result.content[0]?.type === "text" ? result.content[0].text : undefined,
				});
				return false;
			}
		} catch (err) {
			log.warn("Transport auto-retry spawn failed — surfacing the original failure", {
				sourceId: run.id,
				attempt: sourceAttempt,
				error: (err as Error).message,
			});
			return false;
		}
		log.info("Background run settled — transport auto-retry scheduled", {
			sourceId: run.id,
			attempt: sourceAttempt + 1,
		});
		ctx.ui.notify(TRANSPORT_RETRY_TOAST, "warning");
		return true;
	}

	async function deliverCompletionAlert(event: SubagentEvent): Promise<void> {
		const id = event.agentId;
		if (!claimTerminalNotice(id)) return;
		const ctx = sessionCtx;
		if (!ctx) return;
		try {
			const { getAgent } = await import("./session-manager");
			const agent = getAgent(id);
			if (!agent) return; // pruned or foreign id — nothing to notify
			const knob = state.config.completionNotify ?? "all";
			const run = resolveRunEntry(state.getLogicalRunEntries(ctx), id);
			// Issue #365: a transport-class background failure is re-dispatched once
			// and the source notice is suppressed (the retry's settle is the wake).
			// Every other terminal type — and every non-retryable failure — keeps the
			// existing path unchanged.
			if (event.type === "subagent:failed" && run && isTransportRetryable(run)) {
				const retried = await scheduleTransportRetry(ctx, run);
				if (retried) return;
			}
			const message = buildCompletionMessage(agent, run);
			// Issue #179 (D2): resolve delivery from the CLASSIFIED notification
			// status, not the raw agent status — otherwise a run whose completion
			// the builder downgraded to failed would still be delivered as a success.
			const delivery = resolveDelivery(message.details.status, knob);
			sendCompletionNotification(pi, message, delivery);
		} catch (err) {
			log.warn(`completion-push handler failed for ${id}`, {
				error: (err as Error).message,
			});
		}
	}
}

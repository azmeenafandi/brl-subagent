// Purpose: Entry point: tool/command registration, the delegate_task handlers, and the execution-mode runners.
/**
 * brl-subagent — multi-agent orchestration for pi.
 * Entry point: tool registrations, command surface, and the multi-mode runners.
 * See AGENT.md for the conductor-facing capability reference.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type {
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type {
	SubagentPreset,
	SubagentResult,
	SubagentRun,
	SubagentToolOptions,
	ResolvedParams,
	ThinkingLevel,
	ApprovalMode,
	SubTaskParams,
	SubTaskResult,
	ChainDetails,
	ParallelDetails,
	MultiSubagentDetails,
	GraphTask,
	GraphDetails,
	GraphWave,
	DelegateTaskDetails,
	DelegateTaskParams,
	Priority,
	TaskTemplate,
	ToolResult,
	SubagentEvent,
} from "./types";
import {
	resolveThinkingLevel,
	EMPTY_USAGE,
	getFinalOutput,
	isSubagentError,
	countSubagentOutcomes,
	classifyError,
	MAX_CHAIN_STEPS,
	MAX_PARALLEL_TASKS,
	MAX_GRAPH_TASKS,
	PREVIOUS_OUTPUT_PLACEHOLDER,
	GRAPH_OUTPUT_PLACEHOLDER_RE,
	DEFAULT_PRIORITY,
	type GitMode,
	type BackgroundAgent,
	type RecoveryMode,
} from "./types";
import { validateGraph, topologicalSort } from "./scheduler";
import { runModePrologue } from "./mode-prologue";
import { resolveTemplate, loadAllTemplates, loadBuiltinTemplates, validateTemplatePresetRefs, extractParamNames } from "./templates";
import { pkgPath } from "./paths";

import { sanitizeTask, validateCwd, validateOutputFile, stripAnsi, capOutput, getCurrentDepth, sanitizeErrorMessage, buildCrashResult } from "./sanitize";
import {
	hasUncommittedChanges,
	createWorkBranch,
	captureDiff,
	getHeadState,
	restoreHead,
	deleteBranch,
	mergeWorkBranch,
	type HeadState,
} from "./git";
import { preflightCheck } from "./preflight";
import { depthLimitRejection, formatValidationWarnings, gateSessionCost, modelNotConfiguredRejection, rejectApprovalAlwaysInBackground, rejection, resolveModeModel, resolveSubagentModelPrecedence, runPreTaskValidation, validateDelegationTargets, validateUnitPrePass, type SubagentModelResolution } from "./prelude";
import { loadBuiltinPresets, loadCustomPresets, getAllPresets, getPreset, writePresetFile, formatPresetRestriction, formatToolRestriction } from "./presets";
import { modelIsAvailable, parseModelString } from "./model-availability";
import { validatePreTask, diagnoseFailure, DEFAULT_BACKGROUND_DEADLINE_MS } from "./validate";
import {
	defaultBackgroundFor,
	findUnknownParams,
	KNOWN_DELEGATE_KEYS,
	resolveEffectiveApprovalMode,
	resolveSubagentParams,
	resolveThinkingDispatchSwitch,
	shouldRejectBackgroundForBatch,
	snapshotOriginalParams,
	THINKING_SWITCH_NOTICE,
	type DispatchShape,
	type ResolveInputParams,
} from "./params";
import { delegateTaskParamsSchema } from "./schema";
import { createSessionState, resolveTerminalRunEntry, type SessionState } from "./state";
import { makeLiveOnUpdate, createUnitRun, finalizeUnitRun, finalizeUnitRunCrash, pruneHistoryIfNeeded, registerLiveRun } from "./unit-run";
import { buildSubagentPrompt, describePromptMode } from "./prompt";
import { runSubagent, cleanupTempDirs, reapActiveChildren } from "./runner";
import {
	recoverProduction,
	currentProcessOwner,
	newDispatchIdentity,
} from "./recovery";
import { markInterrupted, listInflightRuns, clearInflightRun } from "./run-registry";
import { acquireSlot, clearProgressLinger, releaseSlot, repaintStatus, stopProgressTicker } from "./concurrency";
import { transcriptDisplayPath } from "./transcript-path";
import {
	finalizeRunRecord,
	resolveRetryParams,
	createEmptyResult,
} from "./history";
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
import { createLogger, setLogCwd, type Logger } from "./logging";
import {
	collectInterruptedRuns,
	offeredInterruptedRuns,
	buildRecoveryNotice,
	resolveRecoveryNoticeDelivery,
	abandonInterruptedRun,
	visibleRunEntriesForSession,
	type RecoveryAgentLookup,
} from "./recovery-surface";
import { Intercom } from "./messaging";
import * as eventBus from "./event-bus";
import {
	buildCompletionMessage,
	resolveDelivery,
	sendCompletionNotification,
	claimTerminalNotice,
	resolveRunEntry,
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
	| "background";
type _ResolveInputCoverage = _ExpectNever<
	Exclude<_KnownDelegateKey, keyof ResolveInputParams | _NonResolutionDelegateKey>
>;

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
 */
function toSubTaskResult(
	result: SubagentResult,
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
	};
}

export default function (pi: ExtensionAPI) {
	const log = createLogger("brl-subagent");

	// F7: Session-bound state — initialized per session
	let state = createSessionState(log);

	// Issue #147: the completion-push subscriber needs the session context to
	// resolve the run entry (state.getRunEntries(ctx)). The event-bus listener
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

	// -------------------------------------------------------------------
	// P1+P2: mergeSubTaskParams
	// -------------------------------------------------------------------

	/**
	 * Merge global resolved params with a SubTaskParams.
	 * SubTask fields override global fields. Tools/excludeTools/noBuiltinTools
	 * are replaced entirely if set in the subTask, otherwise inherited from global.
	 */
	function mergeSubTaskParams(
		globalParams: ResolvedParams & { resolvedGitMode: GitMode; resolvedApprovalMode: ApprovalMode },
		subTask: SubTaskParams,
	): {
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
	} {
		const mergedThinkingLevel = subTask.thinkingLevel
			? resolveThinkingLevel(
					subTask.thinkingLevel as ThinkingLevel,
					state.config.maxThinkingLevel,
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

	// Per-unit display name for validation prefixes: the label when present,
	// else the task truncated to 60 chars. Shared by the foreground parallel
	// pre-pass and the background fan-out pre-pass (issue #220) so a unit
	// renders identically in either shape.
	const displayTaskName = (merged: ReturnType<typeof mergeSubTaskParams>): string =>
		merged.label ??
		(merged.task.length > 60 ? `${merged.task.slice(0, 57)}...` : merged.task);

	// -------------------------------------------------------------------
	// P1: runChainMode
	// -------------------------------------------------------------------

	async function runChainMode(
		params: DelegateTaskParams,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<DelegateTaskDetails> | undefined,
		ctx: ExtensionContext,
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
			merge: (step) => mergeSubTaskParams(globalParams, step),
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
				const merged = mergeSubTaskParams(globalParams, step);

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
				registerLiveRun(state, run, ctx, merged.label ?? `Step ${i + 1}`);

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
				Object.assign(subTaskResult, toSubTaskResult(result));

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
			merge: (task) => mergeSubTaskParams(globalParams, task),
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
			merged: ReturnType<typeof mergeSubTaskParams>,
			unitCwd: string,
		): Promise<boolean> => {

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
			// drill-in with their per-unit priority (issue #119).
			registerLiveRun(state, run, ctx);

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
				Object.assign(subTaskResult, toSubTaskResult(result));

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
			const merged = mergeSubTaskParams(globalParams, taskList[index]);
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

		await Promise.allSettled(promises);

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
			merge: (node) => mergeSubTaskParams(globalParams, graphTaskToSubTaskParams(node)),
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

					const merged = mergeSubTaskParams(globalParams, subTaskParams);
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
					registerLiveRun(state, run, ctx);

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
							...toSubTaskResult(result),
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

				for (const settled of waveResults) {
					if (settled.status === "fulfilled") {
						resultMap.set(settled.value.id, settled.value.result);
						graphWaveTasks.push(settled.value.result);
					} else {
						log.error("Graph wave task rejected", { error: String(settled.reason) });
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
			merged: ReturnType<typeof mergeSubTaskParams>;
			model: { provider: string; id: string };
			cwd: string;
			outputFile: string | undefined;
		};

		const fanOutTasks: FanOutTask[] = [];
		// C: per-task warnings collect here to ride the immediate spawn result.
		const taskWarnings: string[] = [];
		for (let i = 0; i < taskList.length; i++) {
			const merged = mergeSubTaskParams(globalParams, taskList[i]);
			const name = displayTaskName(merged);
			const taskPrefix = `Task ${i + 1} ("${name}")`;
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
				},
			});
			if (preTask.error) return preTask.error;
			for (const w of preTask.warnings) taskWarnings.push(`${taskPrefix}: ${w}`);

			fanOutTasks.push({ merged, model: stepModel, cwd: targets.cwd, outputFile: targets.outputFile });
		}

		// Spawn pass — sequential, in task order, through the shared tail.
		const started: Array<{ id: string; label?: string }> = [];
		const startedIdsText = (): string => started.map((s) => s.id).join(", ");

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
						`(${startedIdsText()}) — they are detached and will still wake you.`
					}],
					details: undefined,
					isError: true,
				};
			}

			const { merged, model, cwd, outputFile } = fanOutTasks[i];
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

			let agent: BackgroundAgent;
			try {
				agent = await startBackgroundAgent(pi, ctx, {
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
						`Failed to spawn background agent for Task ${i + 1} ("${name}"): ${message}` + alreadyStarted
					}],
					details: undefined,
					isError: true,
				};
			}
			started.push({ id: agent.id, label: merged.label });
		}

		// Text-only result: ids in task order + the wake hint. C: per-task
		// validation warnings ride the immediate SPAWN result (prefixed with
		// their task) so the conductor can stop/re-dispatch in the same turn.
		const lines = started
			.map((s, i) => `${i + 1}. ${s.label ? `"${s.label}" ` : ""}— ${s.id}`)
			.join("\n");
		return {
			content: [{ type: "text" as const, text:
				`Background agents started: ${started.length}\n\n` +
				`${lines}\n\n` +
				`You'll be woken with a completion message as each finishes; use get_subagent_result({ agent_id }) for retrieval and stall checks.` +
				formatValidationWarnings(taskWarnings)
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
	// checks, validations and result formatting. THROWS on spawn failure —
	// callers translate the error into their own result shape.
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
	): Promise<BackgroundAgent> {
		const { spawnBackgroundSession, setAgentFinalOutput, extractFinalOutput, updateAgentStatus } = await import('./session-manager');
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
		
		// Issue #318 (from #316 review): the two poller crash sites share one
		// claimed notification envelope. Content is the only variable; the
		// claim guard, display, details and deliverAs live here once.
		const sendCrashNotice = (content: string): void => {
			if (claimTerminalNotice(agent.id)) {
				pi.sendMessage({
					customType: "subagent-notification",
					content,
					display: true,
					details: { agentId: agent.id }
				}, { deliverAs: "followUp" });
			}
		};

		// Register for live monitor
		state.registerLiveSubagent(agent.id, {
			id: agent.id,
			label: agent.description,
			task: agent.task,
			model: agent.model,
			thinkingLevel: agent.thinkingLevel,
			priority: agent.priority,
			startedAt: agent.startedAt,
			ctx,
		});
		
		// Update footer counters
		state.activeSubagents++;
		repaintStatus(state, ctx);

		let completed = false;
		
		// Poll for live progress
		const pollInterval = setInterval(() => {
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
					clearInterval(pollInterval);
					clearTimeout(hardCapHandle);
					// Capture whatever output exists (may be empty — fine).
					setAgentFinalOutput(agent.id, state.subagentSessions.get(agent.id)?.liveOutput ?? '');
					// Gate the counter on the finalize claim: if the
					// stale sweep already finalized this entry, the
					// decrement happened there (PR #71 review).
					if (state.finalizeLiveSubagent(agent.id)) {
						state.activeSubagents--;
						if (state.activeSubagents < 0) state.activeSubagents = 0;
					}
					state.failedSubagents++;
					repaintStatus(state, ctx);
					sendCrashNotice(`Background agent "${agent.description}" crashed.`);
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
						state.updateLiveSubagent(agent.id, finalOutput, stats.tokens.input, stats.tokens.output);
					} catch {
						state.updateLiveSubagent(agent.id, finalOutput, 0, 0);
					}
				}
				
				// Authoritative completion: the prompt promise settled — status and
				// completedAt are set by .then()/.catch() in spawnBackgroundSession.
				// Do NOT rely on !session.isStreaming: it is false during prompt()
				// preflight (auth check, model resolution) and for failed starts.
				if (agent.completedAt) {
					completed = true;
					clearInterval(pollInterval);
					clearTimeout(hardCapHandle);
					
					// Issue #31: prefer the output already captured at settlement;
					// the ref may already be nulled on terminal agents, so never
					// overwrite with empty and stay null-safe.
					const finalOutput = agent.finalOutput ?? extractAgentFinalOutput(agent);
					setAgentFinalOutput(agent.id, finalOutput);
					
					// Gate the counter on the finalize claim: if the
					// stale sweep already finalized this entry, the
					// decrement happened there (PR #71 review).
					if (state.finalizeLiveSubagent(agent.id)) {
						state.activeSubagents--;
						if (state.activeSubagents < 0) state.activeSubagents = 0;
					}
					
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
					clearInterval(pollInterval);
					clearTimeout(hardCapHandle);
					try {
						setAgentFinalOutput(agent.id, extractAgentFinalOutput(agent));
					} catch { /* ignore */ }
					// Gate the counter on the finalize claim: if the
					// stale sweep already finalized this entry, the
					// decrement happened there (PR #71 review).
					if (state.finalizeLiveSubagent(agent.id)) {
						state.activeSubagents--;
						if (state.activeSubagents < 0) state.activeSubagents = 0;
					}
					state.failedSubagents++;
					repaintStatus(state, ctx);
					sendCrashNotice(`Background agent "${agent.description}" crashed: ${sanitizeErrorMessage((err as Error).message, spawn.sanitizeCwd)}`);
				}
			}
		}, 2000);
		
		// Default deadline: stop polling AND abort the session after the
		// deadline. W2 (issue #28): previously this only stopped the poller —
		// the pi session kept running forever (orphaned). Now it pre-sets
		// 'stopped' (so the .then keeps it, per W1) and aborts the session.
		// Issue #240: an explicit per-agent timeout is HONORED verbatim; this
		// deadline DEFAULTS to 30m only when no timeout is given. It is a
		// default, not a ceiling. Issue #244: exactly ONE deadline timer per
		// run — an explicit timeout is owned by the session-manager W3 timer,
		// so this index timer arms ONLY on the no-timeout path, mirroring
		// spawnBackgroundSession's `params.timeout && params.timeout > 0` guard
		// (with no timeout, it owns the 30m default, #28).
		const hasExplicitDeadline = spawn.timeout !== undefined && spawn.timeout > 0;
		const hardCapMs = spawn.timeout ?? DEFAULT_BACKGROUND_DEADLINE_MS;
		const hardCapHandle: ReturnType<typeof setTimeout> | undefined =
			hasExplicitDeadline ? undefined : setTimeout(() => {
			if (!completed && !agent.completedAt) {
				try {
					completed = true;
					clearInterval(pollInterval);
					// Pre-set stopped BEFORE aborting so the .then in
					// spawnBackgroundSession keeps the stopped state.
					updateAgentStatus(agent.id, 'stopped', `Timed out (${hardCapMs}ms deadline)`);
					agent._sessionRef?.abort().catch(() => {
						// Abort may reject if the session is mid-dispose;
						// the status flip above is already recorded.
					});
					// Capture whatever final output exists in the session
					const hardCapSession = agent._sessionRef;
					const hardCapFinalOutput = hardCapSession ? extractFinalOutput(hardCapSession) : '';
					setAgentFinalOutput(agent.id, hardCapFinalOutput);
					// Gate the counter on the finalize claim: if the
					// stale sweep already finalized this entry, the
					// decrement happened there (PR #71 review).
					if (state.finalizeLiveSubagent(agent.id)) {
						state.activeSubagents--;
						if (state.activeSubagents < 0) state.activeSubagents = 0;
					}
					// m6: deadline abort is a stop, not a completion — mirror the
					// W3/poller stopped path (no completedSubagents increment).
					repaintStatus(state, ctx);
				} catch (err) {
					// Defensive: never let the deadline timer throw uncaught — that would
					// skip finalizeLiveSubagent, the counter decrement, and the notification.
					// Do all fallible work first (output capture), then mutate counters,
					// then notify — a throw mid-path can't double-fire mutations.
					completed = true;
					clearInterval(pollInterval);
					// m3: the try may have thrown BEFORE updateAgentStatus ran (e.g.
					// persistAgent fs failure) — leave the record terminal so
					// get_subagent_result doesn't report 'running' and the W3 timer
					// guard (!agent.completedAt) can't re-fire later.
					try {
						updateAgentStatus(agent.id, 'stopped', `Timed out (${hardCapMs}ms deadline)`);
					} catch { /* ignore */ }
					try {
						setAgentFinalOutput(agent.id, extractAgentFinalOutput(agent));
					} catch { /* ignore */ }
					// Gate the counter on the finalize claim: if the
					// stale sweep already finalized this entry, the
					// decrement happened there (PR #71 review).
					if (state.finalizeLiveSubagent(agent.id)) {
						state.activeSubagents--;
						if (state.activeSubagents < 0) state.activeSubagents = 0;
					}
					state.failedSubagents++;
					repaintStatus(state, ctx);
				}
			}
		}, hardCapMs);
		
		log.info("Background agent spawned", { agentId: agent.id, task: spawn.task, model: agent.model });

		return agent;
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
		params: DelegateTaskParams | ReturnType<typeof resolveRetryParams>,
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
			const agent = await startBackgroundAgent(pi, ctx, {
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

			return {
				content: [{
					type: "text" as const,
					text: `Background agent started: ${agent.id}\n\n` +
						`Description: ${agent.description}\n` +
						`Task: ${agent.task}\n` +
						`Status: ${agent.status}\n\n` +
						`You'll be woken with a completion message when it finishes; use get_subagent_result({ agent_id: "${agent.id}" }) for retrieval and stall checks.` +
						bgAutoRouteNote +
						// C: warnings ride the immediate SPAWN result so the conductor
						// can stop/re-dispatch in the same turn.
						formatValidationWarnings(bgPreTask.warnings),
				}],
				details: undefined,
			};
		} catch (err) {
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
			const declaredPresetForSwitch = params.preset
				? getPreset(params.preset, state.builtinPresets, state.customPresets)
				: undefined;
			const thinkingSwitch = resolveThinkingDispatchSwitch({
				thinkingLevel: (params.thinkingLevel ?? declaredPresetForSwitch?.thinkingLevel) as
					| ThinkingLevel
					| undefined,
				explicitBackground,
				timeout: params.timeout,
				force: params.force,
				shape: dispatchShape,
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
				return runChainMode(params, signal, onUpdate, ctx);
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
				if (useBackground) return runBackgroundFanOut(pi, ctx, params, signal);
				return runParallelMode(params, signal, onUpdate, ctx);
			}

			if (isGraph) {
				return runGraphMode(params, signal, onUpdate, ctx);
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
			registerLiveRun(state, run, ctx);

			// P3: Git integration — set up work branch if gitMode is "branch"
			let headState: HeadState | undefined;
			let workBranchName: string | undefined;
			if (resolvedGitMode === "branch") {
				try {
					headState = getHeadState(resolvedCwd);

					if (hasUncommittedChanges(resolvedCwd)) {
						log.warn("Uncommitted changes detected; proceeding with branch-based workflow anyway", {
							cwd: resolvedCwd,
						});
					}

					const branchResult = createWorkBranch(resolvedCwd, headState.sha);
					if (branchResult.ok) {
						workBranchName = branchResult.branch;
						log.info("Created work branch for subagent", {
							branch: workBranchName,
							base: headState.branch,
						});
					} else {
						log.error("Failed to create work branch, falling back to 'none'", {
							error: branchResult.error,
						});
						headState = undefined;
					}
				} catch (err) {
					log.warn("Not a git repository or git error; falling back to gitMode 'none'", {
						error: (err as Error).message,
					});
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
					state.registerLiveSubagent(runId, {
						id: runId,
						label,
						task,
						model: run.model,
						thinkingLevel,
						priority: params.priority,
						startedAt: Date.now(),
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
					const recentRuns = state.getRunEntries(ctx).slice(0, state.config.slaWindowSize);
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
			});
			// Report the scan whenever it did anything durable OR attempted a mark
			// that failed — a failure-only boot must not be silent (issue #304).
			if (summary.marked > 0 || summary.markFailures > 0) {
				log.warn("Boot recovery marked interrupted runs", { ...summary });
			}
		} catch (err) {
			// Recovery is best-effort hygiene — it must never break session start.
			log.warn("Boot recovery scan failed", { error: (err as Error).message });
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
		return visibleRunEntriesForSession(state.getRunEntries(ctx), getAgent);
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

		// Option B U3 (D2): after the scan, surface every unresolved interrupted
		// run ONCE, at the next turn boundary (never mid-turn).
		await maybeSendRecoveryNotice(ctx);

		// Issue #356: boot is a config-paint edge — route it through the same
		// chokepoint as every other footer repaint. With no runs in flight the
		// chokepoint draws the idle config line the old direct call painted.
		repaintStatus(state, ctx);
	});

	// F7: Clean up session-bound state on shutdown
	pi.on("session_shutdown", async (_event, _ctx) => {
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
	for (const type of terminalTypes) {
		eventBus.on(type, (event) => {
			void deliverCompletionAlert(event);
		});
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
			const run = resolveRunEntry(state.getRunEntries(ctx), id);
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

// Purpose: The delegate_task tool — its definition, the dispatch pre-flight, the foreground run path — returned to the composition root to register.
/**
 * brl-subagent — the `delegate_task` definition (ADR 0027 S5, issue #483)
 *
 * This was the largest single literal in `src/index.ts`: a ~1,200-line
 * `pi.registerTool({ … })` whose `execute` carried the whole dispatch seam —
 * template resolution, the retry restore, shape selection, the #412 pre-flight,
 * the single foreground run (git work branch, approval flow, finalize). The
 * definition moves here; the REGISTRATION does not (D7): the composition root
 * calls `pi.registerTool(createDelegateHandler(rt, deps))`, so the tool surface
 * is still registered in exactly one place.
 *
 * **Instance identity is the contract (D5).** Four things this body calls must
 * be the SAME instances `index.ts` created, and they arrive through `deps`:
 *
 *   - the three S2 mode runners (chain/parallel/graph);
 *   - the S3 background pipeline's fan-out and single-spawn entry (a second
 *     `createBackgroundPipeline` would carry a second spawn queue);
 *   - the S4 boot cluster's `visibleRunsFor` (a second `createBootRecovery`
 *     would carry a second notice latch).
 *
 * Nothing in this module calls a `create*` factory. The three `type` imports of
 * those factories exist only to NAME the dep types — `ReturnType<…>` on a
 * type-only import resolves to the factory's published contract without
 * instantiating anything, so the seam cannot drift from the real signature the
 * way a hand-copied function type would.
 *
 * The move is verbatim. The factory's own first lines destructure the runtime
 * (the S2/S3 pattern) so the moved statements keep the names they read from
 * their old closure; a body line that differs from 876bb5d is a bug in this
 * commit, not a refactor.
 *
 * S6 (#430) then splits the validation/pre-flight/run seams INSIDE this module
 * into the private same-file helpers below. They are private on purpose (D7):
 * nothing outside this file may depend on a seam, and the tests drive them
 * through `createDelegateHandler` — a seam is an implementation detail of the
 * definition, not a second public surface.
 */

import type { createBackgroundPipeline } from "./background-pipeline";
import type { createBootRecovery } from "./boot-recovery";
import type { Logger } from "./logging";
import type { BatchGuardContext, createModeRunners } from "./mode-runners";
import type { RuntimeContext } from "./runtime";
import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, Theme, ToolDefinition, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import {
	DEFAULT_PRIORITY,
	EMPTY_USAGE,
	MAX_CHAIN_STEPS,
	MAX_PARALLEL_TASKS,
	declaredThinkingLevel,
	getFinalOutput,
	isSubagentError,
	type DelegateTaskDetails,
	type DelegateTaskParams,
	type ApprovalMode,
	type GitMode,
	type Priority,
	type SubagentResult,
	type SubagentRun,
	type SubagentPreset,
	type SubagentToolOptions,
	type TaskTemplate,
	type ThinkingLevel,
} from "./types";
import { resolveTemplate, loadBuiltinTemplates, extractParamNames } from "./templates";
import { pkgPath } from "./paths";
import { sanitizeTask, validateCwd, validateOutputFile, stripAnsi, capOutput, getCurrentDepth, buildCrashResult } from "./sanitize";
import {
	hasUncommittedChanges,
	createWorkBranch,
	newWorkBranchName,
	captureDiff,
	getHeadState,
	getRepoRoot,
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
	resolveSubagentModelPrecedence,
} from "./prelude";
import { loadBuiltinPresets, formatPresetRestriction, formatToolRestriction } from "./presets";
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
} from "./params";
import { delegateTaskParamsSchema } from "./schema";
import { readProcessChecks } from "./project-flags";
import { buildSubagentPrompt, describePromptMode } from "./prompt";
import { runSubagent } from "./runner";
import { currentProcessOwner, newDispatchIdentity } from "./recovery";
import { writeHeadState, clearHeadState, HEAD_STATE_VERSION } from "./headstate";
import { clearInflightRun } from "./run-registry";
import { acquireSlot, releaseSlot } from "./concurrency";
import { finalizeRunRecord, resolveRetryParams } from "./history";
import { computeSLAMetrics, computeDegradation } from "./metrics";
import { showApprovalDialog, renderDelegateCall, renderDelegateResult } from "./tui";
import { appendWorktreeState } from "./worktree-report";

// ---------------------------------------------------------------------------
// Registration-time inventory summaries (moved with the guidance they feed)
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
 * What the dispatch needs from the composition root. Every entry is an instance
 * `index.ts` already built — see the header's instance-identity note. The types
 * are the factories' own return members (`ReturnType<…>` on a type-only import),
 * so this seam cannot drift from the functions it names.
 */
export interface DelegateHandlerDeps {
	/** S2: the three foreground batch runners. */
	runChainMode: ReturnType<typeof createModeRunners>["runChainMode"];
	runParallelMode: ReturnType<typeof createModeRunners>["runParallelMode"];
	runGraphMode: ReturnType<typeof createModeRunners>["runGraphMode"];
	/** S3: the background fan-out (the `tasks` shape) — one spawn queue. */
	runBackgroundFanOut: ReturnType<typeof createBackgroundPipeline>["runBackgroundFanOut"];
	/** S3: the single-task background spawn (`useBackground` on the single shape). */
	spawnBackgroundRun: ReturnType<typeof createBackgroundPipeline>["spawnBackgroundRun"];
	/** S4: the run-visibility bridge the retry restore resolves through. */
	visibleRunsFor: ReturnType<typeof createBootRecovery>["visibleRunsFor"];
}

/**
 * The definition `pi.registerTool` consumes. The two generics are the ones the
 * inline literal used to have inferred for it: the params schema (so `execute`
 * keeps its `DelegateTaskParams` parameter and `renderCall`/`renderResult` their
 * `Static<…>` shapes) and the details type the result/update callbacks carry.
 */
export type DelegateTaskTool = ToolDefinition<
	typeof delegateTaskParamsSchema,
	DelegateTaskDetails
>;

// ---------------------------------------------------------------------------
// Dispatch seams (issue #430) — private to this module, driven by `execute`
// ---------------------------------------------------------------------------

/**
 * What `execute` returns: `ToolDefinition`'s result for this tool. Named once
 * so an `Outcome` can carry an early rejection without re-spelling the
 * `AgentToolResult<DelegateTaskDetails>` generic at every seam boundary.
 */
type ToolResult = AgentToolResult<DelegateTaskDetails>;

/**
 * The seam result type: either the value the next seam needs, or a finished
 * tool result the caller returns unchanged.
 *
 * A rejection is a RETURNED result rather than a thrown error because every
 * early exit in the original body returned a tool result. Throwing would land
 * in the foreground `catch`, which builds a crash result — the caller would
 * see different content, and the trace contract (issue #430) forbids that.
 */
type Outcome<T> = { ok: true; value: T } | { ok: false; result: ToolResult };

/**
 * What seam A reads from its surroundings. A narrow `Pick`-style object, not
 * the whole `RuntimeContext`: A needs `ctx`/`pi` for the retry lookup and the
 * two notification channels, and `visibleRunsFor` for the registry fallback.
 */
interface NormalizeDeps {
	state: SessionState;
	ctx: ExtensionContext;
	pi: ExtensionAPI;
	log: Logger;
	/** S4's run-visibility bridge — the retry restore's post-boot fallback. */
	visibleRunsFor: DelegateHandlerDeps["visibleRunsFor"];
}

/** Seam A's value: the resolved inputs every later seam reads. */
interface NormalizedDispatch {
	/** The original object (mutated in place) or the retry-rebound replacement. */
	params: DelegateTaskParams;
	/** The run a `retryRunId` resolved to — identity and source retirement. */
	retrySourceRun: SubagentRun | undefined;
}

/** Seam B's value: the sanitized params plus the one shape the dispatch names. */
interface DispatchSelection {
	/** The same object seam A produced (the sanitizer writes `params.task`). */
	params: DelegateTaskParams;
	isChain: boolean;
	isParallel: boolean;
	isGraph: boolean;
	dispatchShape: DispatchShape;
}

/**
 * Seam A1 — the unknown-param warning (issues #99/#110).
 *
 * Typebox allows additional properties by default (pi's validateToolArguments
 * passes unknown keys through), so a typo like `thinkinglevel` or a
 * schema-drifted param is otherwise silently ignored. Warn-not-reject: never
 * break a delegation. Both channels speak — `log.warn` for the file, and
 * `pi.sendMessage` because pi's TUI swallows extension console output, so the
 * LLM (followUp) and the human (session transcript) both see the correction.
 */
function warnUnknownParams(
	params: DelegateTaskParams,
	deps: Pick<NormalizeDeps, "pi" | "log">,
): void {
	const { pi, log } = deps;
	const unknownKeys = findUnknownParams(params, KNOWN_DELEGATE_KEYS);
	if (unknownKeys.length === 0) return;
	log.warn("delegate_task: unknown param(s) ignored — check spelling or add to schema", { unknown: unknownKeys });
	pi.sendMessage({
		customType: "delegate-notification",
		content: `delegate_task: unknown param(s) ignored — check spelling or add to schema: ${unknownKeys.join(", ")}`,
		display: true,
		details: { unknown: unknownKeys },
	}, { deliverAs: "followUp" });
}

/**
 * Seam A2 — apply a task template to the dispatch params (issues #57/#175).
 *
 * MUST run before the single-mode sanitize seam: a template ASSIGNS
 * `params.task`, so resolving first lets the sanitizer validate the real
 * resolved body (a template-only call has no task yet) and lets mode detection
 * see a non-empty task.
 *
 * Two rules that look contradictory and are not: the resolved BODY is
 * template-wins (it replaces any supplied `task` unconditionally — issue #57),
 * while the template's other fields are DEFAULTS an explicit param overrides.
 * A supplied task the sanitizer would have rejected is reported rather than
 * silently dropped — but only when it would actually have failed, so a valid
 * task alongside a template stays the intended override, not noise.
 *
 * Mutates `params` and returns the same object's outcome; no notice is a value.
 */
function applyTemplate(
	params: DelegateTaskParams,
	templates: readonly TaskTemplate[],
	deps: Pick<NormalizeDeps, "pi" | "log">,
): Outcome<void> {
	const { pi, log } = deps;
	if (!params.template) return { ok: true, value: undefined };

	const templateEntry = templates.find((t) => t.name === params.template);
	if (!templateEntry) {
		const available = templates.map((t) => t.name).join(", ") || "none";
		return {
			ok: false,
			result: {
				content: [
					{
						type: "text" as const,
						text: `Template '${params.template}' not found. Available: ${available}`,
					},
				],
				details: undefined,
				isError: true,
			},
		};
	}

	const resolved = resolveTemplate(templateEntry, params.params ?? {});
	if (!resolved.ok) {
		return {
			ok: false,
			result: {
				content: [
					{
						type: "text" as const,
						text: `Template '${params.template}' resolution failed: ${resolved.error}`,
					},
				],
				details: undefined,
				isError: true,
			},
		};
	}

	const tv = resolved.value;
	// Issue #175 review (fix 4): template-wins silently replaces a supplied
	// `task`. If that task would itself have failed sanitization (e.g.
	// over-length), the caller gets no signal — pre-#175 `dev` rejected it.
	// Warn (never reject — #99/#110 precedent, same pi.sendMessage channel as
	// the unknown-param warning) so both the LLM and the human see the ignored
	// task. Emitted ONLY when the supplied task actually fails sanitization: a
	// valid task alongside a template is the intended template-wins override
	// (issue #57), not noise.
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
	// UNCONDITIONAL — the resolved template task replaces any supplied `task`
	// (template-wins, issue #57); it is NOT a default the caller can override.
	// The fields below, by contrast, ARE defaults: an explicitly provided param
	// wins over the template's value.
	params.task = tv.task;
	if (tv.preset && !params.preset) params.preset = tv.preset;
	if (tv.thinkingLevel && !params.thinkingLevel) params.thinkingLevel = tv.thinkingLevel;
	if (tv.outputFile && !params.outputFile) params.outputFile = tv.outputFile;
	if (tv.timeout !== undefined && params.timeout === undefined) params.timeout = tv.timeout;
	if (tv.tools && !params.tools) params.tools = tv.tools;
	if (tv.excludeTools && !params.excludeTools) params.excludeTools = tv.excludeTools;
	if (tv.noBuiltinTools !== undefined && params.noBuiltinTools === undefined) params.noBuiltinTools = tv.noBuiltinTools;
	if (tv.inheritSystemPrompt !== undefined && params.inheritSystemPrompt === undefined) params.inheritSystemPrompt = tv.inheritSystemPrompt;
	return { ok: true, value: undefined };
}

/**
 * Seam A — resolve the dispatch inputs: unknown-param warning, template
 * resolution, retry restore (issue #430).
 *
 * ORDER IS THE CONTRACT. Template resolution MUST run first: it ASSIGNS
 * `params.task`, so the sanitizer in seam B validates the real resolved body
 * and mode detection sees a non-empty task (issue #175). The retry restore
 * MUST run after it: `resolveRetryParams` returns a fresh object that DROPS
 * `template`, so resolving first keeps a combined template + retryRunId call
 * from silently disabling template resolution (issue #175 review).
 *
 * RETURNS SYNCHRONOUSLY unless the retry needs the visibility bridge. The lazy
 * `import('./session-manager')` is the only asynchronous arm and is entered
 * only when the session store has no entry for the id — an unconditional
 * `async` here would suspend every dispatch a microtask earlier than it ran
 * before, which the S6 timing probe pins (issue #430 amendment 2).
 */
function normalizeInput(
	params: DelegateTaskParams,
	deps: NormalizeDeps,
): Outcome<NormalizedDispatch> | Promise<Outcome<NormalizedDispatch>> {
	const { state, ctx, pi, log, visibleRunsFor } = deps;

	// A1: the two pre-resolution notices (unknown keys, ignored task) and the
	// template application itself.
	warnUnknownParams(params, { pi, log });
	const templated = applyTemplate(params, state.config.templates, { pi, log });
	if (!templated.ok) return templated;

	// Handle retryRunId — MUST run after template resolution and before the
	// single-mode sanitize block. resolveRetryParams assigns params.task from
	// the recorded run, so the sanitizer must see the retried body (a
	// retry-only call has no task yet). It MUST run AFTER template resolution:
	// resolveRetryParams returns a fresh object that DROPS `template`, so
	// resolving templates first keeps a combined template + retryRunId call
	// from silently disabling template resolution (issue #175 review).
	if (!params.retryRunId) {
		return { ok: true, value: { params, retrySourceRun: undefined } };
	}

	const retryRunId = params.retryRunId;
	// Fix A: prefer the session spawn entry (it carries `originalParams`);
	// a run that exists ONLY in the durable registry after a fresh boot
	// resolves through the visibility bridge instead of being rejected as
	// not found — the id the boot notice names must resolve here.
	const sessionEntry = state.findSpawnRunById(ctx, retryRunId);
	if (sessionEntry) return resolveRetrySource(params, retryRunId, sessionEntry, log);

	// The one asynchronous arm. `then` keeps the continuation in the turn the
	// original `await import(...)` resumed in; only the caller's own `await`
	// of this promise adds a turn, and only on this path (the import already
	// suspends through the module loader, so that turn is inside an existing
	// suspension — see the S6 timing probe).
	return import("./session-manager").then(({ getAgent }) =>
		resolveRetrySource(
			params,
			retryRunId,
			resolveTerminalRunEntry(visibleRunsFor(ctx, getAgent), retryRunId),
			log,
		),
	);
}

/**
 * The tail of the retry restore, shared by the session hit and the visibility
 * bridge so the two cannot diverge on the not-found message (issue #98: a
 * silent no-op here made retries of background runs start as FRESH runs with
 * no signal to the caller).
 */
function resolveRetrySource(
	params: DelegateTaskParams,
	retryRunId: string,
	runEntry: SubagentRun | undefined,
	log: Logger,
): Outcome<NormalizedDispatch> {
	if (runEntry) {
		return {
			ok: true,
			value: {
				params: resolveRetryParams(params, runEntry) as DelegateTaskParams,
				retrySourceRun: runEntry,
			},
		};
	}
	log.warn("Retry run ID not found", { retryRunId });
	return {
		ok: false,
		result: {
			content: [{
				type: "text" as const,
				text: `Retry run ID not found: ${retryRunId}. The run may have been pruned, or it was a background run created before the run-entry fix. Pass the run's agent ID — for background runs the agent ID and run ID are now the same.`,
			}],
			details: undefined,
			isError: true,
		},
	};
}

/**
 * Seam B — sanitize the single-task body and classify the dispatch shape
 * (issue #430).
 *
 * Mutates `params.task` to the sanitizer's value and then reads that value for
 * `isSingle`, exactly as the inline block did: the sanitizer's trim/normalize
 * is what makes "   " a rejection rather than a single-task dispatch. The
 * shape flags stay the raw `params.chain/tasks/graph` truthiness tests; the
 * exactly-one check is what turns them into a dispatch.
 */
function resolveShape(
	params: DelegateTaskParams,
	log: Logger,
): Outcome<DispatchSelection> {
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
				ok: false,
				result: {
					content: [{ type: "text" as const, text: `Invalid task: ${taskResult.error}` }],
					details: undefined,
					isError: true,
				},
			};
		}
		params.task = taskResult.value;
	}

	// P1+P2+P10: Mode detection — graph > chain > parallel > single
	const isChain = Boolean(hasChain);
	const isParallel = Boolean(hasParallel);
	const isGraph = Boolean(hasGraph);
	const isSingle = typeof params.task === "string" && params.task.length > 0;

	const modeCount = [isChain, isParallel, isGraph, isSingle].filter(Boolean).length;
	if (modeCount !== 1) {
		return {
			ok: false,
			result: {
				content: [
					{
						type: "text" as const,
						text:
							"Provide exactly one of: task (single), chain (sequential), tasks (parallel), or graph (dependency graph).",
					},
				],
				details: undefined,
				isError: true,
			},
		};
	}

	const dispatchShape: DispatchShape = isChain
		? "chain"
		: isGraph
			? "graph"
			: isParallel
				? "parallel"
				: "single";

	return { ok: true, value: { params, isChain, isParallel, isGraph, dispatchShape } };
}

/** What seam C reads from its surroundings — the #412 pre-flight's inputs. */
interface ShapeDeps {
	state: SessionState;
	ctx: ExtensionContext;
	pi: ExtensionAPI;
	log: Logger;
}

/** Seam C's value: the routing decisions every downstream seam reads. */
interface ShapePreparation {
	/** Whether the dispatch runs detached (background) or blocks (foreground). */
	useBackground: boolean;
	/** The #434 unit-projection inputs the batch runners consume. */
	batchGuard: BatchGuardContext;
}

/**
 * Seam C — the dispatch pre-flight and the background default (issues #361,
 * #412, #415, #431, #434, #443) — plus the recorded background decision.
 *
 * This is the seam where the dispatch can be CHANGED (the #412 high-thinking
 * switch / #431 timeout drop) and REJECTED (a declared thinking level outside
 * the cap, an explicit `background: true` batch). The order is load-bearing:
 *
 *   1. `explicitBackground` is captured BEFORE the default is recorded on
 *      `params.background` — the batch guard judges what the caller asked for,
 *      not what the default made true;
 *   2. the switch is applied BEFORE `useBackground` resolves and before any
 *      run record exists, so the spawn, the retry snapshot and the pending-work
 *      record all see the switched shape;
 *   3. `useBackground` resolves ONCE (single + fan-out share it) from the
 *      EFFECTIVE approval mode, so the default can never route a run into a
 *      background context that needs an interactive gate;
 *   4. `batchGuard` closes over the switch outcome so a unit never re-announces
 *      a notice the dispatch already delivered.
 *
 * Effects: `log.*`, `pi.sendMessage` and `ctx.ui.notify` on the switch arms;
 * `params.background`/`params.timeout` mutations. Returns the caller's
 * rejection unchanged when a gate trips.
 */
function prepareShape(
	params: DelegateTaskParams,
	shape: Pick<DispatchSelection, "dispatchShape" | "isParallel">,
	deps: ShapeDeps,
): Outcome<ShapePreparation> {
	const { state, ctx, pi, log } = deps;
	const { dispatchShape, isParallel } = shape;

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
	if (declaredThinkingError) return { ok: false, result: declaredThinkingError };
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
			ok: false,
			result: {
				content: [
					{
						type: "text" as const,
						text: `background: true is not supported with ${batchMode} — batch modes run foreground and would block until every unit finishes. Remove background to run it foreground, or start each unit as its own single-task background call and sequence the dependencies yourself.`,
					},
				],
				details: undefined,
				isError: true,
			},
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

	return { ok: true, value: { useBackground, batchGuard } };
}

/** The injected entry points seam D routes to (the composition root's instances). */
type RouteRunners = Pick<
	DelegateHandlerDeps,
	"runChainMode" | "runParallelMode" | "runGraphMode" | "runBackgroundFanOut" | "spawnBackgroundRun"
>;

/** What seam D reads: the tool call's live arguments and the injected runners. */
interface RouteDeps {
	pi: ExtensionAPI;
	ctx: ExtensionContext;
	signal: AbortSignal | undefined;
	onUpdate: AgentToolUpdateCallback<DelegateTaskDetails> | undefined;
	/** The run a `retryRunId` resolved to — the background spawn's identity. */
	retrySourceRun: SubagentRun | undefined;
	runners: RouteRunners;
}

/**
 * Seam D's value. `returned` carries the injected runner's result — possibly a
 * PROMISE, which the caller returns as-is: awaiting it inside the seam would
 * add a settlement turn the inline call did not have. `foreground` means the
 * dispatch is a single foreground run, carrying the task it will block on.
 */
type RouteOutcome =
	| { kind: "returned"; result: ToolResult | Promise<ToolResult> }
	| { kind: "foreground"; singleTask: string };

/**
 * Seam D — route the dispatch to the one thing that runs it (issue #430).
 *
 * A selector, not an executor: every branch hands the call to an entry point
 * the composition root INJECTED (ADR 0027 D5) — never a locally built runner or
 * pipeline, whose second spawn queue / notice latch would be invisible to the
 * rest of the session. The two batch limits are checked here rather than in the
 * runners so every shape is rejected at the same seam.
 *
 * Single mode falls through to the foreground path and hands back the task.
 * `params.task` is a non-empty string by then (seam B's exactly-one check plus
 * the sanitizer); the assertion mirrors the `params.chain!`/`params.tasks!`
 * reads for the same reason — TS cannot narrow through the boolean count.
 */
function routeDispatch(
	params: DelegateTaskParams,
	selection: DispatchSelection,
	prepared: ShapePreparation,
	deps: RouteDeps,
): RouteOutcome {
	const { pi, ctx, signal, onUpdate, retrySourceRun, runners } = deps;
	const { isChain, isParallel, isGraph } = selection;
	const { useBackground, batchGuard } = prepared;

	if (isChain) {
		if (params.chain!.length > MAX_CHAIN_STEPS) {
			return {
				kind: "returned",
				result: {
					content: [
						{
							type: "text" as const,
							text: `Chain exceeds max ${MAX_CHAIN_STEPS} steps.`,
						},
					],
					details: undefined,
					isError: true,
				},
			};
		}
		return { kind: "returned", result: runners.runChainMode(params, signal, onUpdate, ctx, batchGuard) };
	}

	if (isParallel) {
		if (params.tasks!.length > MAX_PARALLEL_TASKS) {
			return {
				kind: "returned",
				result: {
					content: [
						{
							type: "text" as const,
							text: `Parallel exceeds max ${MAX_PARALLEL_TASKS} tasks.`,
						},
					],
					details: undefined,
					isError: true,
				},
			};
		}
		if (useBackground) {
			return { kind: "returned", result: runners.runBackgroundFanOut(pi, ctx, params, signal, batchGuard) };
		}
		return { kind: "returned", result: runners.runParallelMode(params, signal, onUpdate, ctx, batchGuard) };
	}

	if (isGraph) {
		return { kind: "returned", result: runners.runGraphMode(params, signal, onUpdate, ctx, batchGuard) };
	}

	// Single mode: isSingle is true (modeCount===1, none of chain/parallel/graph),
	// so params.task is a non-empty string. TS can't infer this through the
	// boolean-array filter — assert, mirroring params.chain!/params.tasks! above.
	const singleTask = params.task!; // non-empty (sanitizer guarantees; isSingle confirms)

	if (useBackground) {
		return {
			kind: "returned",
			result: runners.spawnBackgroundRun(pi, ctx, params, singleTask, retrySourceRun),
		};
	}

	return { kind: "foreground", singleTask };
}

/** What seam E reads — the three gates' surroundings (not the whole runtime). */
interface ForegroundDeps {
	state: SessionState;
	ctx: ExtensionContext;
	log: Logger;
}

/**
 * Seam E's value: every foreground input resolved ONCE, so no later seam can
 * re-derive one and drift (the failure mode #434's second `processChecks` read
 * demonstrated). Named fields, not a bag: a seam that needs the whole
 * `RuntimeContext` would be a seam with the wrong boundary.
 */
interface ForegroundPrepared {
	/** The sanitized single-task body the child runs. */
	task: string;
	label: string | undefined;
	inheritSP: boolean;
	customSP: string | undefined;
	/** The merged (preset/template-aware) deadline; undefined = no deadline. */
	timeout: number | undefined;
	thinkingLevel: ThinkingLevel;
	toolOptions: SubagentToolOptions | undefined;
	resolvedGitMode: GitMode;
	resolvedApprovalMode: ApprovalMode;
	resolvedPreset: SubagentPreset | undefined;
	autoRoutedPreset: SubagentPreset | undefined;
	autoRouteKeyword: string | undefined;
	/** The validated absolute cwd the child runs in. */
	resolvedCwd: string;
	/** The validated output file, or undefined when the caller set none. */
	resolvedOutputFile: string | undefined;
	/** The H1 warnings note appended to the returned text (empty when clean). */
	warningsNote: string;
	/** The resolved model — provider/id, precedence already applied. */
	subagentModel: { provider: string; id: string };
	/** The depth THIS dispatch sits at; the child runs at `currentDepth + 1`. */
	currentDepth: number;
}

/**
 * Seam E — foreground admission (issue #430).
 *
 * Every gate that must hold BEFORE a run exists: the session cost limit, the
 * recursion-depth cap, cwd + outputFile validation, the pi pre-flight, the H1
 * capability validation, and model resolution. Each rejection is returned
 * unchanged and NOTHING has been persisted — which is exactly why these gates
 * live above seam F's run record: a rejection here leaves no dangling row.
 *
 * FOREGROUND-ONLY, and it must stay that way: seam D routes batch/background
 * dispatches to their own runners before this runs, and those paths apply their
 * own cost/model policy (`runModePrologue`). Moving E above D would re-gate a
 * background dispatch the caller asked for.
 *
 * `force` degrades a capability error to a warning (B2's override) — the flag
 * is read off `params` here because it is a CALL-level decision, not a resolved
 * value; `cwd`/`noJev` likewise reach H1 straight from the dispatch.
 */
function prepareForeground(
	params: DelegateTaskParams,
	singleTask: string,
	deps: ForegroundDeps,
): Outcome<ForegroundPrepared> {
	const { state, ctx, log } = deps;

	// R5: Check session cost limit before spawning
	// Use a default per-task estimate of $0.05 if no perTaskCostEstimate is set
	const costError = gateSessionCost({
		state,
		ctx,
		log,
		units: 1,
		label: "Subagent delegation",
	});
	if (costError) return { ok: false, result: costError };

	// Reject delegation if recursion depth exceeds configured max.
	// This prevents subagents from spawning infinite sub-subagents while
	// still allowing other extensions to function normally in subprocesses.
	const currentDepth = getCurrentDepth();
	if (currentDepth >= state.config.maxSubagentDepth) {
		log.warn("Subagent delegation rejected: max depth reached", {
			currentDepth,
			maxDepth: state.config.maxSubagentDepth,
		});
		return { ok: false, result: depthLimitRejection(currentDepth, state.config.maxSubagentDepth) };
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
			ok: false,
			result: {
				content: [{ type: "text" as const, text: `Invalid cwd: ${cwdResult.error}` }],
				details: undefined,
				isError: true,
			},
		};
	}
	const resolvedCwd = cwdResult.value;

	// F1: Validate outputFile
	let resolvedOutputFile: string | undefined;
	if (outputFile) {
		const ofResult = validateOutputFile(outputFile, resolvedCwd);
		if (!ofResult.ok) {
			return {
				ok: false,
				result: {
					content: [
						{ type: "text" as const, text: `Invalid outputFile: ${ofResult.error}` },
					],
					details: undefined,
					isError: true,
				},
			};
		}
		resolvedOutputFile = ofResult.value;
	}

	// R3: Pre-flight checks — fail fast before consuming resources
	const pfResult = preflightCheck(resolvedCwd);
	if (!pfResult.ok) {
		log.warn("Pre-flight check failed", { error: pfResult.error });
		return {
			ok: false,
			result: {
				content: [{ type: "text" as const, text: `Pre-flight check failed: ${pfResult.error}` }],
				details: undefined,
				isError: true,
			},
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
			ok: false,
			result: {
				content: [{
					type: "text" as const,
					text: errText,
				}],
				details: undefined,
				isError: true,
			},
		};
	}
	// C: surface warnings in the returned result (not just the log) —
	// shared renderer so foreground/background wording stays identical.
	const warningsNote = formatValidationWarnings(validation.warnings);

	// Resolve model (per-call top-level model override beats preset)
	const modelResult = resolveSubagentModelPrecedence({
		state,
		ctx,
		log,
		preset: resolvedPreset,
		perCallModel: params.model,
	});
	if (!modelResult.ok) return { ok: false, result: modelResult.error };
	const subagentModel = modelResult.model;

	// R3: Verify resolved model provider+id is non-empty
	const modelStr = `${subagentModel.provider}/${subagentModel.id}`.trim();
	if (!modelStr || modelStr === "/") {
		log.warn("Model string is empty after resolution", { model: subagentModel });
		return { ok: false, result: modelNotConfiguredRejection() };
	}

	return {
		ok: true,
		value: {
			task,
			label,
			inheritSP,
			customSP,
			timeout,
			thinkingLevel,
			toolOptions,
			resolvedGitMode,
			resolvedApprovalMode,
			resolvedPreset,
			autoRoutedPreset,
			autoRouteKeyword,
			resolvedCwd,
			resolvedOutputFile,
			warningsNote,
			subagentModel,
			currentDepth,
		},
	};
}

/**
 * Build the `delegate_task` definition over one runtime context (ADR 0027 D1/D3).
 *
 * The destructures are the whole wrapper: they re-create, as locals, the three
 * names the moved bodies read from their old closure. `deps` is destructured too
 * so the four injected entry points read exactly as they did inline.
 */
export function createDelegateHandler(
	rt: RuntimeContext,
	deps: DelegateHandlerDeps,
): DelegateTaskTool {
	const { pi, log, state } = rt;
	const {
		runChainMode,
		runParallelMode,
		runGraphMode,
		runBackgroundFanOut,
		spawnBackgroundRun,
		visibleRunsFor,
	} = deps;

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

	return {
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
			// Seam A: unknown-param warning, template resolution, retry restore.
			// Synchronous unless the retry falls back through the visibility bridge.
			const normalized = normalizeInput(params, { state, ctx, pi, log, visibleRunsFor });
			const pre: Outcome<NormalizedDispatch> =
				normalized instanceof Promise ? await normalized : normalized;
			if (!pre.ok) return pre.result;
			params = pre.value.params;
			// Option B U1: the run the retryRunId resolved to (spawn entry).
			// Internal record identity — dispatchId/resumeOf/attempt are threaded
			// onto the new record, NOT through the delegate-param surface (D4).
			const retrySourceRun = pre.value.retrySourceRun;

			// Seam B: sanitize the single-task body, then classify the shape.
			const shape = resolveShape(params, log);
			if (!shape.ok) return shape.result;
			const { isChain, isParallel, isGraph, dispatchShape } = shape.value;

			// Seam C: the #412 pre-flight, the background default and the #434
			// unit-projection inputs — one resolution per dispatch.
			const prepared = prepareShape(params, shape.value, { state, ctx, pi, log });
			if (!prepared.ok) return prepared.result;
			const { useBackground, batchGuard } = prepared.value;

			// Seam D: hand the dispatch to the injected runner, or keep the single
			// foreground run below. The runner's own promise is RETURNED, never
			// awaited here — a seam that awaited it would add a settlement turn.
			const route = routeDispatch(params, shape.value, prepared.value, {
				pi,
				ctx,
				signal,
				onUpdate,
				retrySourceRun,
				runners: {
					runChainMode,
					runParallelMode,
					runGraphMode,
					runBackgroundFanOut,
					spawnBackgroundRun,
				},
			});
			if (route.kind === "returned") return route.result;
			const singleTask = route.singleTask;

			// Seam E: foreground admission — cost, depth, cwd/output, preflight,
			// capability validation, model resolution. No run record exists yet, so
			// every rejection here returns without persisting anything.
			const admitted = prepareForeground(params, singleTask, { state, ctx, log });
			if (!admitted.ok) return admitted.result;
			const {
				task,
				label,
				inheritSP,
				customSP,
				timeout,
				thinkingLevel,
				toolOptions,
				resolvedGitMode,
				resolvedApprovalMode,
				resolvedPreset,
				autoRoutedPreset,
				autoRouteKeyword,
				resolvedCwd,
				resolvedOutputFile,
				warningsNote,
				subagentModel,
				currentDepth,
			} = admitted.value;

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
					// Issue #474: the failure path reports the tree it may have left
					// behind. Appended LAST — the cause and its H1 warnings read
					// first, the residue after. This is the classified-failure exit
					// (no throw), the second foreground surface beside the crash seam.
					finalMsg = appendWorktreeState(finalMsg, resolvedCwd);

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
	};
}

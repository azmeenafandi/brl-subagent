// Purpose: Param resolution: per-call + preset merge, thinking caps, timeout normalization, tool and git/approval resolution, auto-routing.
/**
 * brl-subagent — Parameter Resolution (issue #59)
 *
 * resolveSubagentParams merges per-call params with the resolved preset,
 * then applies thinking-level caps, timeout normalization, the edit→write
 * tool fix, git mode / approval mode resolution, and E2 auto-routing.
 *
 * The function used to live as a closure inside src/index.ts's default
 * export, which forced the integration tests to replicate it — a copy that
 * silently drifted from the real behavior. Extracted here so the tests can
 * drive the REAL function (no more silent test drift).
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import type {
	ThinkingLevel,
	SubagentPreset,
	GitMode,
	ApprovalMode,
	SubagentToolOptions,
	ResolvedParams,
	SnapshotParams,
	DelegateTaskParams,
} from "./types";
import { resolveThinkingLevel } from "./types";
import { getAllPresets, getPreset } from "./presets";
import { classifyTask } from "./router";
import { normalizeTimeout } from "./validate";
import type { SessionState } from "./state";
import type { Logger } from "./logging";

// ---------------------------------------------------------------------------
// delegate_task known keys (issue #99)
// ---------------------------------------------------------------------------

/**
 * Keys the delegate_task schema declares. TypeBox's Type.Object allows
 * additional properties by default, so this set is the source of truth for
 * the unknown-param warn: any received key outside it is silently ignored
 * by execute and worth a warn.
 *
 * Single source of truth (review R1): index.ts imports this instead of
 * carrying a duplicate, and per-step-model.test.ts ratchets it against the
 * REAL registered schema (the #108-class drift that #99's fix targeted can
 * never silently return). Keep in sync with the schema's Type.Object({ ... })
 * block in index.ts.
 */
export const KNOWN_DELEGATE_KEYS = new Set([
	"task", "systemPrompt", "inheritSystemPrompt", "thinkingLevel",
	"outputFile", "label", "model", "timeout", "cwd", "tools",
	"excludeTools", "noBuiltinTools", "preset", "template", "params",
	"retryRunId", "gitMode", "retryOnTimeout", "approvalMode", "background",
	"priority", "chain", "tasks", "graph", "force", "noJev",
] as const);

/**
 * Issue #99: warn-worthy unknown keys in a delegate_task params object.
 * TypeBox's Type.Object allows additional properties by default and pi's
 * validateToolArguments returns validated args UNCHANGED — so unknown keys
 * survive to execute and are silently ignored. Comparing received keys
 * against the schema's known keys converts that silent class into a
 * visible one (warn-not-reject: never break a delegation).
 */
export function findUnknownParams(
	received: Record<string, unknown>,
	knownKeys: ReadonlySet<string>,
): string[] {
	return Object.keys(received).filter((k) => !knownKeys.has(k));
}

/**
 * Issue #108: snapshot the caller's raw delegate_task params onto a run
 * record's originalParams — single source of truth for the retry merge
 * (resolveRetryParams). The background and foreground run-record creation
 * sites previously duplicated this 12-field literal (priority added, issue
 * #114); a future param added to one and not the other would silently
 * degrade retries of that path.
 * NOTE: the schema's `params` (template slots) key is intentionally NOT
 * snapshotted — it is a template-resolution input, not a retry override.
 * The execution-shape keys (background, gitMode, approvalMode, force) ARE
 * snapshotted: omitting them is the known failure mode of this design, since
 * resolveRetryParams rebuilds a fresh literal and a key missing here is both
 * unrestored AND discarded when passed explicitly on a retry call. Records
 * written before this change simply lack the keys (additive, undefined-safe).
 *
 * Issue #381 (audit D5): the 16-field shape is declared once, as
 * `SnapshotParams` in types.ts, and shared with `SubagentRun["originalParams"]`;
 * this signature previously carried its own copy of the literal.
 */
export function snapshotOriginalParams(params: SnapshotParams): Record<string, unknown> {
	return {
		systemPrompt: params.systemPrompt,
		inheritSystemPrompt: params.inheritSystemPrompt,
		model: params.model,
		thinkingLevel: params.thinkingLevel,
		priority: params.priority,
		outputFile: params.outputFile,
		timeout: params.timeout,
		cwd: params.cwd,
		tools: params.tools,
		excludeTools: params.excludeTools,
		noBuiltinTools: params.noBuiltinTools,
		preset: params.preset,
		background: params.background,
		gitMode: params.gitMode,
		approvalMode: params.approvalMode,
		force: params.force,
	};
}

// ---------------------------------------------------------------------------
// Effective approval mode + the background default (issue #361)
// ---------------------------------------------------------------------------

/**
 * The approval mode that would actually apply to a child dispatched with these
 * params: per-call param > configured default.
 *
 * Single source of truth (issue #361): `resolveSubagentParams` resolves the
 * child's mode through this function, and the dispatch chokepoint uses it to
 * pick the background default, so the mode that decides "can this run
 * unattended?" is always the mode the child runs with. Presets declare no
 * `approvalMode` field today (see SubagentPreset), so there is no preset tier;
 * should one be added, it would slot in between the call param and the
 * configured default.
 */
export function resolveEffectiveApprovalMode(
	approvalMode: string | undefined,
	state: Pick<SessionState, "config">,
): ApprovalMode {
	return approvalMode === "auto" || approvalMode === "writes" || approvalMode === "always"
		? approvalMode
		: state.config.approvalMode;
}

/**
 * Dispatch shapes that can select a `background` default. `parallel` is the
 * `tasks` fan-out; `chain`/`graph` are batch modes that always block.
 */
export type DispatchShape = "single" | "parallel" | "chain" | "graph";

/**
 * Whether an EXPLICIT `background` value must be rejected for the dispatch
 * shape. Only `chain`/`graph` reject, and only an explicit `true` — an omitted
 * `background` (`undefined`) is not an explicit request and falls through to
 * `defaultBackgroundFor`, while an explicit `false` is always honoured. Pure
 * and separate from dispatch so the guard's strictness and its position ahead
 * of default resolution can be pinned independently (issue #361 review).
 */
export function shouldRejectBackgroundForBatch(
	shape: DispatchShape,
	explicit: boolean | undefined,
): boolean {
	return explicit === true && (shape === "chain" || shape === "graph");
}

/**
 * Issue #361: the CONDITIONAL default for `background` when the caller omits
 * it. Background wins only where it cannot weaken a gate:
 *
 *   - `chain`/`graph` stay foreground — they block by definition and an
 *     explicit `background: true` is still rejected at dispatch.
 *   - an effective approval mode that needs the interactive dialog
 *     (`always`) or gates on writes (`writes`) stays foreground — a
 *     background run has no dialog, so defaulting there would either break
 *     the run or silently auto-approve diffs the user asked to review.
 *   - everything else (single task, `tasks` fan-out, effective `auto`) is
 *     background: the tool returns an agent id immediately and the conductor
 *     is woken on terminal state.
 *
 * Explicit `true`/`false` always wins — callers spread `params.background ??
 * defaultBackgroundFor(...)`.
 */
export function defaultBackgroundFor(
	shape: DispatchShape,
	effectiveApprovalMode: ApprovalMode,
): boolean {
	if (shape === "chain" || shape === "graph") return false;
	return effectiveApprovalMode === "auto";
}

// ---------------------------------------------------------------------------
// The thinking-level dispatch-shape pre-flight (issue #412, rule 2)
// ---------------------------------------------------------------------------

/**
 * The notice the dispatch emits when it auto-switches the shape. The text
 * states the TRUE tool fact (why the shape matters), because that is the only
 * thing that makes the switch acceptable to the conductor that asked for
 * foreground: a foreground run has no transcript to resume, so a timeout there
 * loses the work, while a background run keeps its session and is retried on a
 * transport error.
 */
export const THINKING_SWITCH_NOTICE =
	"Dispatch pre-flight (no deadline means the durable path): a high/xhigh-thinking run was dispatched FOREGROUND with an explicit timeout. " +
	"The explicit timeout was dropped — foreground runs persist nothing, so a timeout there loses the run's whole context, while the 30-minute background deadline applies instead. " +
	"The run is now background; the conductor is woken on terminal state. Pass force: true to keep it foreground (state the reason in the task text).";

/** The pre-flight's verdict for one dispatch. */
export type ThinkingDispatchSwitch = "switch" | "forced" | "none";

/**
 * Issue #412 (rule 2: "no deadline ⇒ durable path") — should the pre-flight
 * change this dispatch's shape?
 *
 * The 2026-10-31 incident: a plan critique ran foreground under a 15-minute
 * timeout, was killed at ~14 minutes ("almost done"), and lost everything —
 * the background re-run then cost another 17 minutes. The decision was
 * conductor discretion; this predicate makes the durable shape the only one
 * for the runs where losing the context is expensive:
 *
 *   thinkingLevel high|xhigh
 *     + background EXPLICITLY false (the caller asked for foreground)
 *     + an explicit timeout (the deadline that would kill it)
 *     → switch to background and drop the timeout.
 *
 * Deliberately exempt:
 *   - `chain`/`graph` — they block by definition and `background: true` is
 *     rejected at dispatch; the decision cannot apply to them.
 *   - an omitted `background` — the #361 default already decided, and it knows
 *     about approval modes (a `writes`/`always` run must stay in front of the
 *     user); second-guessing it here would silently move a gated run into a
 *     context with no approval dialog.
 *   - no explicit timeout — there is no deadline to lose; the background
 *     default is a deadline too, so switching would not make the run safer.
 *   - `force: true` — the override, reported as `forced` (not `none`) so the
 *     caller can tell "kept foreground by request" from "never applied".
 *     `force` carries no reason field (ADR 0007): the dispatch text is the
 *     reason.
 *
 * `thinkingLevel` is the DECLARED level (per-call, else the named preset's),
 * not the capped one: `maxThinkingLevel` defaults to `off` for an unconfigured
 * session, so applying the cap here would disable the pre-flight exactly where
 * nobody configured anything — the drift this rule exists to remove.
 */
export function resolveThinkingDispatchSwitch(input: {
	thinkingLevel: ThinkingLevel | undefined;
	explicitBackground: boolean | undefined;
	timeout: number | undefined;
	force: boolean | undefined;
	shape: DispatchShape;
}): ThinkingDispatchSwitch {
	if (input.shape === "chain" || input.shape === "graph") return "none";
	if (input.thinkingLevel !== "high" && input.thinkingLevel !== "xhigh") return "none";
	if (input.explicitBackground !== false) return "none";
	if (input.timeout === undefined) return "none";
	return input.force === true ? "forced" : "switch";
}

/**
 * The resolver's input: the dispatch-param fields resolution actually reads,
 * derived from the registered schema (issue #379) instead of re-spelled here.
 *
 * `task` is OPTIONAL because the schema says so (`chain`/`tasks`/`graph`
 * dispatches carry no mode-level task) — batch call sites therefore pass the
 * registered params object through unchanged. The four `params as {…}`
 * assertions this replaces existed only to claim a `task` the schema never
 * required. `resolveSubagentParams` defaults it with `?? ""`, which every
 * reader of the field treats like `undefined` (see the `task` line below).
 *
 * Compile-time coverage of this key list is ratcheted in index.ts
 * (`_ResolveInputCoverage`) — a schema field the resolver forgets is silent at
 * runtime, so only the compiler can catch it.
 */
export type ResolveInputParams = Pick<
	DelegateTaskParams,
	| "task"
	| "label"
	| "preset"
	| "systemPrompt"
	| "inheritSystemPrompt"
	| "thinkingLevel"
	| "outputFile"
	| "timeout"
	| "cwd"
	| "tools"
	| "excludeTools"
	| "noBuiltinTools"
	| "gitMode"
	| "approvalMode"
	| "template"
	// Capability-block override: carried here so the validation call sites
	// (which receive the resolved params) can forward it to validatePreTask.
	// Resolution itself ignores it.
	| "force"
>;

/**
 * Issue #412: resolve the preset a dispatch will actually run with, INCLUDING
 * the auto-route decision. Extracted from `resolveSubagentParams` so the
 * dispatch pre-flight can ask "what thinking level will this run have?"
 * without re-spelling the routing condition — a second copy of that condition
 * is exactly the silent drift `_ResolveInputCoverage` and the KNOWN_DELEGATE_KEYS
 * ratchet exist to prevent.
 *
 * `name` is what the caller asked for (or the routed match); `preset` is the
 * resolved record, `undefined` when neither exists. `autoRouted` distinguishes
 * a routed match from an explicit request (the caller logs the evidence).
 */
export function resolveDispatchPreset(
	params: Pick<
		ResolveInputParams,
		"preset" | "template" | "tools" | "excludeTools" | "noBuiltinTools" | "task"
	>,
	state: Pick<SessionState, "builtinPresets" | "customPresets">,
): { name?: string; preset?: SubagentPreset; autoRouted: boolean; keyword?: string } {
	if (params.preset) {
		return { name: params.preset, preset: getPreset(params.preset, state.builtinPresets, state.customPresets), autoRouted: false };
	}
	// E2: an explicit template or tool preference is intent that must win over
	// keyword routing (issue #57) — unchanged from the resolver's rule.
	const hasExplicitToolPreference =
		params.tools !== undefined ||
		params.excludeTools !== undefined ||
		params.noBuiltinTools !== undefined;
	if (params.template || hasExplicitToolPreference) return { autoRouted: false };
	const matched = classifyTask(
		params.task ?? "",
		getAllPresets(state.builtinPresets, state.customPresets),
	);
	if (!matched) return { autoRouted: false };
	return {
		name: matched.preset,
		preset: getPreset(matched.preset, state.builtinPresets, state.customPresets),
		autoRouted: true,
		keyword: matched.keyword,
	};
}

export function resolveSubagentParams(
	params: ResolveInputParams,
	state: SessionState,
	ctx: ExtensionContext,
	log: Logger,
): ResolvedParams & {
	resolvedGitMode: GitMode;
	resolvedApprovalMode: ApprovalMode;
	resolvedPreset?: SubagentPreset;
	autoRoutedPreset?: SubagentPreset; // set only when autoRoutePreset chose it
	/** Set only when auto-route chose the preset: the keyword that matched —
	 * the evidence the dispatch result surfaces (auto-route transparency). */
	autoRouteKeyword?: string;
} {
	// E2: Auto-route to best preset only when the conductor expressed NO
	// explicit preference — an explicit preset, template, or tool parameters
	// (tools/excludeTools/noBuiltinTools) all count as intent that must win over
	// keyword-based routing (issue #57). The rule lives in `resolveDispatchPreset`
	// so the dispatch pre-flight (#412) resolves the SAME preset this merge does.
	const routed = resolveDispatchPreset(params, state);
	const resolvedPreset = routed.name;
	const wasAutoRouted = routed.autoRouted;
	const routeKeyword = routed.keyword;
	if (wasAutoRouted) {
		log.info("Auto-routed task to preset", { preset: resolvedPreset, keyword: routeKeyword });
	}

	const preset = resolvedPreset
		? getPreset(resolvedPreset, state.builtinPresets, state.customPresets)
		: undefined;
	const autoRoutedPreset = wasAutoRouted ? preset : undefined;

	const mergedThinkingLevel =
		(params.thinkingLevel as ThinkingLevel | undefined) ??
		(preset?.thinkingLevel as ThinkingLevel | undefined);
	const mergedSystemPrompt = params.systemPrompt ?? preset?.systemPrompt;
	const mergedInheritSP = params.inheritSystemPrompt ?? preset?.inheritSystemPrompt;
	const mergedOutputFile = params.outputFile ?? preset?.outputFile;
	const mergedTimeout = normalizeTimeout(params.timeout ?? preset?.timeout);
	const mergedTools = params.tools ?? preset?.tools;
	// Fix: edit depends on write in pi's tool system.
	// If edit is in the allowlist but write is not, all tools fail to resolve.
	const resolvedTools = mergedTools && mergedTools.includes("edit") && !mergedTools.includes("write")
		? [...mergedTools, "write"]
		: mergedTools;
	const mergedExcludeTools = params.excludeTools ?? preset?.excludeTools;
	const mergedNoBuiltinTools = params.noBuiltinTools ?? preset?.noBuiltinTools;

	// QUIRK (pre-existing, preserved from the original closure): gitMode merges
	// from preset?.NAME, not a preset gitMode field (SubagentPreset has none).
	// A preset literally named "branch"/"none" would silently set gitMode.
	// Deliberately NOT changed here — altering it is a behavior change beyond
	// issue #59's scope.
	const mergedGitMode = (params.gitMode as GitMode | undefined) ?? preset?.name;
	const resolvedGitMode: GitMode =
		mergedGitMode === "branch" || mergedGitMode === "none"
			? mergedGitMode
			: state.config.gitMode;

	// P4: Resolve approval mode: per-call param > state config > default "writes"
	// (shared with the dispatch chokepoint's background default, issue #361).
	const resolvedApprovalMode = resolveEffectiveApprovalMode(params.approvalMode, state);

	const thinkingLevel = resolveThinkingLevel(
		mergedThinkingLevel,
		state.config.maxThinkingLevel,
	);

	const toolOptions: SubagentToolOptions | undefined =
		resolvedTools || mergedExcludeTools || mergedNoBuiltinTools
			? {
					tools: resolvedTools,
					excludeTools: mergedExcludeTools,
					noBuiltinTools: mergedNoBuiltinTools,
				}
			: undefined;

	return {
		// "" ≡ undefined at all three readers of the field: mergeSubTaskParams
		// (`subTask.task || globalParams.task`), validatePreTask
		// (`config.task || ''`) and classifyTask (`if (!task …)`).
		task: params.task ?? "",
		label: params.label?.trim() || undefined,
		inheritSP: mergedInheritSP !== false,
		customSP: mergedSystemPrompt,
		outputFile: mergedOutputFile,
		timeout: mergedTimeout,
		effectiveCwd: params.cwd || ctx.cwd,
		thinkingLevel,
		toolOptions,
		resolvedGitMode,
		resolvedApprovalMode,
		resolvedPreset: preset,
		autoRoutedPreset,
		autoRouteKeyword: autoRoutedPreset ? routeKeyword : undefined,
	};
}

// Purpose: Entry point: tool/command registration, the delegate_task handlers, dispatch and single mode.
/**
 * brl-subagent — multi-agent orchestration for pi.
 * Entry point: tool registrations, command surface, dispatch (mode selection,
 * guard construction, single mode). The three batch-mode runners live in
 * `mode-runners.ts` (ADR 0027 S2) and the background pipeline (the fan-out,
 * the shared spawn tail and the single-background spawn) in
 * `background-pipeline.ts` (ADR 0027 S3).
 * See AGENT.md for the conductor-facing capability reference.
 */

import type { AgentToolResult, AgentToolUpdateCallback } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext, Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import * as path from "node:path";
import { Type } from "typebox";
import {
	declaredThinkingLevel,
	EMPTY_USAGE,
	getFinalOutput,
	isSubagentError,
	MAX_CHAIN_STEPS,
	MAX_PARALLEL_TASKS,
	DEFAULT_PRIORITY,
	type SubagentResult,
	type SubagentRun,
	type ThinkingLevel,
	type DelegateTaskDetails,
	type DelegateTaskParams,
	type Priority,
	type TaskTemplate,
	type SubagentEvent,
} from "./types";
import { createBackgroundPipeline } from "./background-pipeline";
import { createBootRecovery } from "./boot-recovery";
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
import { delegateTaskParamsSchema } from "./schema";
import { readProcessChecks } from "./project-flags";
import { buildSubagentPrompt, describePromptMode } from "./prompt";
import { runSubagent, cleanupTempDirs, reapActiveChildren } from "./runner";
import { currentProcessOwner, newDispatchIdentity } from "./recovery";
import { writeHeadState, clearHeadState, HEAD_STATE_VERSION } from "./headstate";
import { clearInflightRun } from "./run-registry";
import { acquireSlot, clearProgressLinger, releaseSlot, repaintStatus, stopProgressTicker } from "./concurrency";
import { transcriptDisplayPath } from "./transcript-path";
import { finalizeRunRecord, resolveRetryParams } from "./history";
import { computeSLAMetrics, computeDegradation } from "./metrics";
import {
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
import { formatBudgetLine, normalizeCompletionStatus } from "./notify-completion";
import { createTerminalNotifier } from "./terminal-notifier";
import { appendWorktreeState } from "./worktree-report";

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
	// ADR 0027 (S3): the background pipeline. The loader thunk is invoked only
	// inside `startBackgroundAgent`, so session-manager's lifecycle mutators stay
	// lazily imported from the one module allowed to reach them.
	const backgroundPipeline = createBackgroundPipeline(rt, {
		loadSessionManager: () => import("./session-manager"),
		resolveStepModel,
		applyUnitShapeGuard,
	});
	const { runBackgroundFanOut, startBackgroundAgent, spawnBackgroundRun } = backgroundPipeline;

	// Issue #147: the completion-push subscriber needs the session context to
	// resolve the run entry (state.getLogicalRunEntries(ctx)). The event-bus listener
	// receives no ctx, so capture it in session_start where it is available.
	let sessionCtx: ExtensionContext | undefined;

	// ADR 0027 (S4): the boot recovery cluster — the interrupted-run scan, the
	// head-state reconcile, the two boot notices and the abandon action, built
	// over this runtime. Its once-per-boot latch (`recoveryNoticeDelivered`) is
	// the factory's own (D5): a latch here would be shared by two runtimes.
	const {
		performBootRecovery,
		reconcileHeadStatesAtBoot,
		maybeSendHeadStateNotice,
		maybeSendRecoveryNotice,
		abandonProductionRun,
		visibleRunsFor,
		resetRecoveryNotice,
	} = createBootRecovery(rt);

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
			const modelResult = resolveSubagentModelPrecedence({
				state,
				ctx,
				log,
				preset: resolvedPreset,
				perCallModel: params.model,
			});
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
		// untouched. `releaseTerminalSubscriptions` is the notifier factory's own
		// `release` (ADR 0027 D5), built below at the position the subscription
		// block used to occupy — this handler body runs after init completes.
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
		// U3: a new session boot may notify again (the latch is the boot
		// factory's own — ADR 0027 D5, so the reset goes through it).
		resetRecoveryNotice();
	});

	// -------------------------------------------------------------------
	// Issue #147: completion-push wake — the terminal notifier (ADR 0027 S4)
	// -------------------------------------------------------------------
	// The notifier owns its three subscriptions AND their release latch (D5).
	// Created HERE, where the subscription block used to live, so the bus sees
	// the same registration order. Its one backward edge — the transport-retry
	// re-dispatch — reaches the S3 pipeline's spawn through this deps literal.
	const terminalNotifier = createTerminalNotifier(rt, {
		// ADR 0027 D2: `sessionCtx` stays a `let` here; the listener gets a getter.
		getSession: () => sessionCtx,
		spawnBackgroundRun,
	});
	// The shutdown hook keeps its old name and its position: `release` is
	// idempotent and removes only this instance's three listeners (#437).
	const releaseTerminalSubscriptions = terminalNotifier.release;

}

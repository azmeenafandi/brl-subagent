/**
 * brl-subagent Extension (v1.4.0)
 *
 * Enterprise-grade subagent extension for pi coding agent.
 * Delegates tasks to isolated pi processes with configurable models,
 * thinking levels, tool scoping, and personality presets.
 *
 * Architecture:
 *   types.ts       — Type definitions and constants
 *   sanitize.ts    — Input/output/env sanitization (F1-F3)
 *   presets.ts     — Preset loading, parsing, validation
 *   state.ts       — Session-bound state management (F5, F7, F9)
 *   prompt.ts      — System prompt construction
 *   runner.ts      — Process spawning and stdout parsing
 *   concurrency.ts — Concurrency queue and progress tracking (F8)
 *   history.ts     — Run record management and retry logic
 *   tui.ts         — All TUI rendering and UI interactions
 *   logging.ts     — Structured logging (F10)
 *
 * Usage:
 *   /brl-subagent        - Open configuration menu
 *   /brl-subagent model  - Open model selector directly
 *   /brl-subagent thinking - Open thinking level selector directly
 *   /brl-subagent reset  - Reset to defaults
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
	classifyError,
	MAX_CHAIN_STEPS,
	MAX_PARALLEL_TASKS,
	MAX_GRAPH_TASKS,
	PREVIOUS_OUTPUT_PLACEHOLDER,
	GRAPH_OUTPUT_PLACEHOLDER_RE,
	DEFAULT_PRIORITY,
	type GitMode,
	type BackgroundAgent,
} from "./types";
import { validateGraph, topologicalSort } from "./scheduler";
import { resolveTemplate, loadAllTemplates, loadBuiltinTemplates, validateTemplatePresetRefs, extractParamNames } from "./templates";

import { sanitizeTask, validateCwd, validateOutputFile, stripAnsi, capOutput, getCurrentDepth, sanitizeErrorMessage, buildCrashResult } from "./sanitize";
import {
	getCurrentBranch,
	hasUncommittedChanges,
	createWorkBranch,
	captureDiff,
	switchToBranch,
	deleteBranch,
	mergeWorkBranch,
} from "./git";
import { preflightCheck } from "./preflight";
import { loadBuiltinPresets, loadCustomPresets, getAllPresets, writePresetFile, formatPresetRestriction, formatToolRestriction } from "./presets";
import { modelIsAvailable } from "./model-availability";
import { validatePreTask, diagnoseFailure } from "./validate";
import { findUnknownParams, KNOWN_DELEGATE_KEYS, resolveSubagentParams, snapshotOriginalParams } from "./params";
import { createSessionState } from "./state";
import { makeLiveOnUpdate, createUnitRun, finalizeUnitRun, finalizeUnitRunCrash, pruneHistoryIfNeeded, registerLiveRun } from "./unit-run";
import { buildSubagentPrompt, describePromptMode } from "./prompt";
import { runSubagent, cleanupTempDirs } from "./runner";
import { acquireSlot, releaseSlot, updateStatus, updateProgressStatus } from "./concurrency";
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
	showPresetManager,
	showTemplateManager,
	showUpdateCheckToggle,
	showSLAConfig,
	showSLAStats,
	showConfigMenu,
	showRunHistory,
	showMonitor,
	showDashboard,
	showRetryMenu,
	renderDelegateCall,
	renderDelegateResult,
} from "./tui";
import { createLogger, type Logger } from "./logging";
import { Intercom } from "./messaging";
import { checkForUpdates } from "./update";
import { UPDATE_CHECK_INTERVAL_MS } from "./types";
import * as eventBus from "./event-bus";
import {
	buildCompletionMessage,
	resolveDelivery,
	sendCompletionNotification,
	markTerminalSeen,
	normalizeCompletionStatus,
	resolveRunEntry,
} from "./notify-completion";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Sanitize a text preview for markdown-rendered notifications: strip code
 * fences (``` and ~~~) and backticks, keep whole non-empty lines with
 * mid-line truncation for over-long lines, and never split surrogate pairs
 * at the boundary.
 */
function sanitizePreview(text: string, maxLen = 500): string {
  // Strip markdown fences and backticks
  const cleaned = text.replace(/```/g, '').replace(/~~~+/g, '').replace(/`/g, '');
  const lines = cleaned.split('\n').filter(l => l.trim());
  let out = '';
  for (const line of lines) {
    if (out.length + line.length + 1 > maxLen) {
      // Mid-line truncation: keep as much of this line as fits
      const remaining = maxLen - out.length - 1;
      if (remaining > 10) {
        out += line.slice(0, remaining - 3) + '...\n';
      }
      break;
    }
    out += line + '\n';
  }
  // Avoid splitting surrogate pairs at the boundary (reachable now via slice above)
  const safe = out.slice(0, maxLen);
  const lastChar = safe[safe.length - 1];
  const stripped = lastChar && /[\uD800-\uDBFF]/.test(lastChar) ? safe.slice(0, -1) : safe;
  return stripped.trimEnd();
}

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

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const log = createLogger("brl-subagent");

	// Read current version from package.json
	const currentVersion = (() => {
		try {
			const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf-8"));
			return pkg.version || "0.0.0";
		} catch {
			return "0.0.0";
		}
	})();

	// F7: Session-bound state — initialized per session
	let state = createSessionState(log);

	// Issue #147: the completion-push subscriber needs the session context to
	// resolve the run entry (state.getRunEntries(ctx)). The event-bus listener
	// receives no ctx, so capture it in session_start where it is available.
	let sessionCtx: ExtensionContext | undefined;

	// -------------------------------------------------------------------
	// Config change callback
	// -------------------------------------------------------------------

	function applyConfig(ctx: ExtensionContext, message: string) {
		updateStatus(state, ctx);
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
		updateStatus(state, ctx);
		state.persistState(pi);
		ctx.ui.notify("Subagent configuration reset", "info");
	}

	// -------------------------------------------------------------------
	// Parameter resolution (extracted to src/params.ts — issue #59)
	// -------------------------------------------------------------------

	/** Parse "provider/model-id" into {provider, id}. Returns null on bad format. */
	function parseModelString(s: string): { provider: string; id: string } | null {
		const trimmed = s.trim();
		const idx = trimmed.indexOf("/");
		if (idx <= 0 || idx === trimmed.length - 1) return null;
		return { provider: trimmed.slice(0, idx), id: trimmed.slice(idx + 1) };
	}

	function resolveSubagentModel(
		ctx: ExtensionContext,
		preset: SubagentPreset | undefined,
		perCallModel?: string, // NEW: top-level delegate_task model param (issue #96)
	):
		| { ok: true; model: { provider: string; id: string } }
		| { ok: false; error: ToolResult<SubagentResult | undefined> } {
		// Precedence: per-call model > preset.model > state.config.model > conductor model
		let subagentModel: { provider: string; id: string } | undefined;

		if (perCallModel) {
			const parsed = parseModelString(perCallModel);
			if (!parsed) {
				log.warn("Model override is not a valid provider/model-id, falling back", { model: perCallModel });
			} else if (modelIsAvailable(ctx.modelRegistry, parsed)) {
				log.info("Using per-call model override", { model: perCallModel });
				return { ok: true, model: parsed };
			} else {
				log.warn("Model override unavailable, falling back", { model: perCallModel });
			}
		}

		if (preset?.model) {
			const parsed = parseModelString(preset.model);
			if (parsed && modelIsAvailable(ctx.modelRegistry, parsed)) {
				subagentModel = parsed;
				log.info("Using preset model", { preset: preset.name, model: preset.model });
			} else {
				// Fallback: preset model unavailable → configured model
				log.warn("Preset model unavailable, falling back to configured model", {
					preset: preset.name,
					model: preset.model,
				});
			}
		}

		if (!subagentModel) {
			subagentModel =
				state.config.model ||
				(ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined);
		}

		if (!subagentModel) {
			return {
				ok: false,
				error: {
					content: [
						{
							type: "text" as const,
							text: "No model available. Configure API keys first, then use /brl-subagent to set a model.",
						},
					],
					details: undefined,
					isError: true,
				},
			};
		}

		return { ok: true, model: subagentModel };
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

	// -------------------------------------------------------------------
	// P1: runChainMode
	// -------------------------------------------------------------------

	async function runChainMode(
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<DelegateTaskDetails> | undefined,
		ctx: ExtensionContext,
	): Promise<ToolResult<SubagentResult | ChainDetails | undefined>> {
		const chainSteps = params.chain as SubTaskParams[];

		// Issue #133: dispatch-start timestamp — the aggregate run entry's
		// startedAt (captured once, at mode entry, not at completion).
		const chainModeStartedAt = new Date().toISOString();

		// R5: Check session cost limit before spawning
		const perTaskEstimate =
			state.config.perTaskCostEstimate > 0
				? state.config.perTaskCostEstimate
				: 0.05;
		if (state.checkCostLimit(perTaskEstimate * chainSteps.length, ctx)) {
			const currentTotal = state.getSessionTotalCost(ctx);
			const limit = state.config.sessionCostLimit;
			log.warn("Chain delegation rejected: session cost limit reached", {
				currentTotal,
				estimatedCost: perTaskEstimate * chainSteps.length,
				limit,
			});
			return {
				content: [
					{
						type: "text" as const,
						text:
							`Cannot delegate: session cost limit reached ` +
							`($${currentTotal.toFixed(4)} spent of $${limit.toFixed(2)} limit). ` +
							`Increase the limit via /brl-subagent costlimit or set to 0 for unlimited.`,
					},
				],
				details: undefined,
				isError: true,
			};
		}

		// Reject delegation if recursion depth exceeds configured max
		const currentDepth = getCurrentDepth();
		if (currentDepth >= state.config.maxSubagentDepth) {
			log.warn("Chain delegation rejected: max depth reached", {
				currentDepth,
				maxDepth: state.config.maxSubagentDepth,
			});
			return {
				content: [
					{
						type: "text" as const,
						text:
							`Cannot delegate further: subagent recursion depth limit reached ` +
							`(depth ${currentDepth}/${state.config.maxSubagentDepth}). ` +
							`Subagents can delegate up to ${state.config.maxSubagentDepth} levels deep (configurable via /brl-subagent depth). Complete the remaining work directly.`,
					},
				],
				details: undefined,
				isError: true,
			};
		}

		// Resolve global params once
		const globalParams = resolveSubagentParams(
			params as {
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
				gitMode?: string;
			},
			state,
			ctx,
			log,
		);

		// Validate CWD once
		const cwdResult = validateCwd(globalParams.effectiveCwd, ctx.cwd);
		if (!cwdResult.ok) {
			return {
				content: [
					{ type: "text" as const, text: `Invalid cwd: ${cwdResult.error}` },
				],
				details: undefined,
				isError: true,
			};
		}
		const resolvedCwd = cwdResult.value;

		// Pre-flight checks — fail fast before consuming resources
		const pfResult = preflightCheck(resolvedCwd);
		if (!pfResult.ok) {
			log.warn("Chain pre-flight check failed", { error: pfResult.error });
			return {
				content: [
					{
						type: "text" as const,
						text: `Pre-flight check failed: ${pfResult.error}`,
					},
				],
				details: undefined,
				isError: true,
			};
		}

		// H1: Pre-task validation at mode entry — deterministic check that
		// tools/thinking match the task (mirrors single/background modes, issue
		// #32). Chain top-level tasks are empty (modeCount forbids task+chain), so
		// keyword warnings skip on empty text and only the hard outputFile-vs-write
		// conflict applies (issue #34). The mode-level outputFile on globalParams is
		// the one validated; per-step outputFiles are future work (issue #3).
		const validation = validatePreTask({
			task: globalParams.task,
			toolOptions: globalParams.toolOptions,
			thinkingLevel: globalParams.thinkingLevel,
			gitMode: globalParams.resolvedGitMode,
			outputFile: globalParams.outputFile,
		});
		if (validation.warnings.length > 0) {
			log.warn("Chain pre-task validation warnings", { warnings: validation.warnings });
		}
		if (!validation.valid) {
			const errText = validation.errors.join("; ");
			log.warn("Chain pre-task validation failed", { errors: validation.errors });
			return {
				content: [{ type: "text" as const, text: errText }],
				details: undefined,
				isError: true,
			};
		}

		// Resolve model once (per-call top-level model override beats preset)
		const modelResult = resolveSubagentModel(ctx, globalParams.resolvedPreset, params.model as string | undefined);
		if (!modelResult.ok) return modelResult.error;
		const subagentModel = modelResult.model;

		const modelStr = `${subagentModel.provider}/${subagentModel.id}`.trim();
		if (!modelStr || modelStr === "/") {
			log.warn("Model string is empty after resolution", { model: subagentModel });
			return {
				content: [
					{
						type: "text" as const,
						text:
							"Subagent model is not configured. " +
							"Use /brl-subagent to set a model, or ensure your current session has a valid model.",
					},
				],
				details: undefined,
				isError: true,
			};
		}

		// R1: Circuit breaker check — reject if circuit is open
		const circuitCheck = state.checkCircuit();
		if (circuitCheck.isOpen) {
			return {
				content: [
					{ type: "text" as const, text: circuitCheck.message! },
				],
				details: undefined,
				isError: true,
			};
		}

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
				// per-step acquire/release calls updateProgressStatus while the
				// mode context is set. Call it directly here (mirrors how the
				// graph path's per-node slot operations trigger the render).
				updateProgressStatus(state, ctx);

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
				const { runId, run } = createUnitRun(merged, stepModel, chainPriority, globalParams.resolvedPreset?.name);
				state.persistRun(pi, run);

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
						resolvedCwd,
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
					);
				} catch (err) {
					// Issue #133 (mirrors the #119 R1/C1 discipline): finalize the
					// run entry as failed — crashOutput comes from the live entry's
					// last streamed output (the crash result itself has no
					// messages), and errorCategory is classified onto originalParams.
					finalizeUnitRunCrash(state, pi, run, err, "Chain step", resolvedCwd, log, {
						step: i + 1,
					});
				}

				// Issue #133: finalize the per-step run entry — status, duration,
				// cost, tokens and sanitized output land on the entry (mirrors
				// parallel's issue #119 finalize; result carries the SubagentResult
				// shape finalizeRunRecord expects, errorCategory included).
				finalizeUnitRun(state, pi, ctx, run, result, log);

				// Fill SubTaskResult
				subTaskResult.exitCode = result.exitCode;
				subTaskResult.messages = result.messages;
				subTaskResult.stderr = result.stderr;
				subTaskResult.usage = result.usage;
				subTaskResult.model = result.model;
				subTaskResult.stopReason = result.stopReason;
				subTaskResult.errorMessage = result.errorMessage;
				subTaskResult.errorCategory = classifyError(result);
				subTaskResult.gitBranch = result.gitBranch;
				subTaskResult.gitDiff = result.gitDiff;

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

			chainSuccess = chainResults.every((r) => r.exitCode === 0);

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

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(chainDetails, null, 2) },
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
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<DelegateTaskDetails> | undefined,
		ctx: ExtensionContext,
	): Promise<ToolResult<SubagentResult | ParallelDetails | undefined>> {
		const taskList = params.tasks as SubTaskParams[];

		// R5: Check session cost limit before spawning
		const perTaskEstimate =
			state.config.perTaskCostEstimate > 0
				? state.config.perTaskCostEstimate
				: 0.05;
		if (state.checkCostLimit(perTaskEstimate * taskList.length, ctx)) {
			const currentTotal = state.getSessionTotalCost(ctx);
			const limit = state.config.sessionCostLimit;
			log.warn("Parallel delegation rejected: session cost limit reached", {
				currentTotal,
				estimatedCost: perTaskEstimate * taskList.length,
				limit,
			});
			return {
				content: [
					{
						type: "text" as const,
						text:
							`Cannot delegate: session cost limit reached ` +
							`($${currentTotal.toFixed(4)} spent of $${limit.toFixed(2)} limit). ` +
							`Increase the limit via /brl-subagent costlimit or set to 0 for unlimited.`,
					},
				],
				details: undefined,
				isError: true,
			};
		}

		// Reject delegation if recursion depth exceeds configured max
		const currentDepth = getCurrentDepth();
		if (currentDepth >= state.config.maxSubagentDepth) {
			log.warn("Parallel delegation rejected: max depth reached", {
				currentDepth,
				maxDepth: state.config.maxSubagentDepth,
			});
			return {
				content: [
					{
						type: "text" as const,
						text:
							`Cannot delegate further: subagent recursion depth limit reached ` +
							`(depth ${currentDepth}/${state.config.maxSubagentDepth}). ` +
							`Subagents can delegate up to ${state.config.maxSubagentDepth} levels deep (configurable via /brl-subagent depth). Complete the remaining work directly.`,
					},
				],
				details: undefined,
				isError: true,
			};
		}

		// Resolve global params once
		const globalParams = resolveSubagentParams(
			params as {
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
				gitMode?: string;
			},
			state,
			ctx,
			log,
		);

		// Validate CWD once
		const cwdResult = validateCwd(globalParams.effectiveCwd, ctx.cwd);
		if (!cwdResult.ok) {
			return {
				content: [
					{ type: "text" as const, text: `Invalid cwd: ${cwdResult.error}` },
				],
				details: undefined,
				isError: true,
			};
		}
		const resolvedCwd = cwdResult.value;

		// Pre-flight checks — fail fast before consuming resources
		const pfResult = preflightCheck(resolvedCwd);
		if (!pfResult.ok) {
			log.warn("Parallel pre-flight check failed", { error: pfResult.error });
			return {
				content: [
					{
						type: "text" as const,
						text: `Pre-flight check failed: ${pfResult.error}`,
					},
				],
				details: undefined,
				isError: true,
			};
		}

		// H1: Pre-task validation at mode entry — deterministic check that
		// tools/thinking match the task (mirrors single/background modes, issue
		// #32). Parallel top-level tasks are empty (modeCount forbids task+tasks),
		// so keyword warnings skip on empty text and only the hard
		// outputFile-vs-write conflict applies (issue #34). The mode-level
		// outputFile on globalParams is the one validated; per-step outputFiles
		// are future work (issue #3).
		const validation = validatePreTask({
			task: globalParams.task,
			toolOptions: globalParams.toolOptions,
			thinkingLevel: globalParams.thinkingLevel,
			gitMode: globalParams.resolvedGitMode,
			outputFile: globalParams.outputFile,
		});
		if (validation.warnings.length > 0) {
			log.warn("Parallel pre-task validation warnings", { warnings: validation.warnings });
		}
		if (!validation.valid) {
			const errText = validation.errors.join("; ");
			log.warn("Parallel pre-task validation failed", { errors: validation.errors });
			return {
				content: [{ type: "text" as const, text: errText }],
				details: undefined,
				isError: true,
			};
		}

		// Resolve model once (per-call top-level model override beats preset)
		const modelResult = resolveSubagentModel(ctx, globalParams.resolvedPreset, params.model as string | undefined);
		if (!modelResult.ok) return modelResult.error;
		const subagentModel = modelResult.model;

		const modelStr = `${subagentModel.provider}/${subagentModel.id}`.trim();
		if (!modelStr || modelStr === "/") {
			log.warn("Model string is empty after resolution", { model: subagentModel });
			return {
				content: [
					{
						type: "text" as const,
						text:
							"Subagent model is not configured. " +
							"Use /brl-subagent to set a model, or ensure your current session has a valid model.",
					},
				],
				details: undefined,
				isError: true,
			};
		}

		// R1: Circuit breaker check — reject if circuit is open
		const circuitCheck = state.checkCircuit();
		if (circuitCheck.isOpen) {
			return {
				content: [
					{ type: "text" as const, text: circuitCheck.message! },
				],
				details: undefined,
				isError: true,
			};
		}

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
			const { runId, run } = createUnitRun(merged, stepModel, parallelPriority, globalParams.resolvedPreset?.name);
			state.persistRun(pi, run);

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
					resolvedCwd,
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
				);

				// Fill SubTaskResult
				subTaskResult.exitCode = result.exitCode;
				subTaskResult.messages = result.messages;
				subTaskResult.stderr = result.stderr;
				subTaskResult.usage = result.usage;
				subTaskResult.model = result.model;
				subTaskResult.stopReason = result.stopReason;
				subTaskResult.errorMessage = result.errorMessage;
				subTaskResult.errorCategory = classifyError(result);
				subTaskResult.gitBranch = result.gitBranch;
				subTaskResult.gitDiff = result.gitDiff;

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
				finalizeUnitRunCrash(state, pi, run, err, "Parallel subtask", resolvedCwd, log, {
					index,
				});
			}

			// Emit progress update
			const completed = results.filter(Boolean).length;
			const succeeded = results.filter(
				(r) => r && r.exitCode === 0,
			).length;
			const failed = completed - succeeded;

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
				taskSuccess = await runTask(index, merged);
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
		const succeeded = finalResults.filter((r) => r.exitCode === 0).length;
		const failed = finalResults.length - succeeded;

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

		return {
			content: [
				{ type: "text" as const, text: JSON.stringify(parallelDetails, null, 2) },
			],
			details: parallelDetails,
		};
	}

	// -------------------------------------------------------------------
	// P10: runGraphMode
	// -------------------------------------------------------------------

	async function runGraphMode(
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: AgentToolUpdateCallback<DelegateTaskDetails> | undefined,
		ctx: ExtensionContext,
	): Promise<ToolResult<SubagentResult | GraphDetails | undefined>> {
		const graphTasks = params.graph as GraphTask[];

		// Issue #133: dispatch-start timestamp — the aggregate run entry's
		// startedAt (captured once, at mode entry, not at completion).
		const graphModeStartedAt = new Date().toISOString();

		// Validate graph
		const errors = validateGraph(graphTasks);
		if (errors.length > 0) {
			return {
				content: [
					{
						type: "text" as const,
						text: `Graph validation failed:\n${errors.map((e) => `  - ${e}`).join("\n")}`,
					},
				],
				details: undefined,
				isError: true,
			};
		}

		// R5: Check session cost limit before spawning
		const perTaskEstimate =
			state.config.perTaskCostEstimate > 0
				? state.config.perTaskCostEstimate
				: 0.05;
		if (state.checkCostLimit(perTaskEstimate * graphTasks.length, ctx)) {
			const currentTotal = state.getSessionTotalCost(ctx);
			const limit = state.config.sessionCostLimit;
			log.warn("Graph delegation rejected: session cost limit reached", {
				currentTotal,
				estimatedCost: perTaskEstimate * graphTasks.length,
				limit,
			});
			return {
				content: [
					{
						type: "text" as const,
						text:
							`Cannot delegate: session cost limit reached ` +
							`($${currentTotal.toFixed(4)} spent of $${limit.toFixed(2)} limit). ` +
							`Increase the limit via /brl-subagent costlimit or set to 0 for unlimited.`,
					},
				],
				details: undefined,
				isError: true,
			};
		}

		// Reject delegation if recursion depth exceeds configured max
		const currentDepth = getCurrentDepth();
		if (currentDepth >= state.config.maxSubagentDepth) {
			log.warn("Graph delegation rejected: max depth reached", {
				currentDepth,
				maxDepth: state.config.maxSubagentDepth,
			});
			return {
				content: [
					{
						type: "text" as const,
						text:
							`Cannot delegate further: subagent recursion depth limit reached ` +
							`(depth ${currentDepth}/${state.config.maxSubagentDepth}). ` +
							`Subagents can delegate up to ${state.config.maxSubagentDepth} levels deep (configurable via /brl-subagent depth). Complete the remaining work directly.`,
					},
				],
				details: undefined,
				isError: true,
			};
		}

		// Resolve global params once
		const globalParams = resolveSubagentParams(
			params as {
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
				gitMode?: string;
				approvalMode?: string;
			},
			state,
			ctx,
			log,
		);

		// Validate CWD once
		const cwdResult = validateCwd(globalParams.effectiveCwd, ctx.cwd);
		if (!cwdResult.ok) {
			return {
				content: [
					{ type: "text" as const, text: `Invalid cwd: ${cwdResult.error}` },
				],
				details: undefined,
				isError: true,
			};
		}
		const resolvedCwd = cwdResult.value;

		// Pre-flight checks
		const pfResult = preflightCheck(resolvedCwd);
		if (!pfResult.ok) {
			log.warn("Graph pre-flight check failed", { error: pfResult.error });
			return {
				content: [
					{
						type: "text" as const,
						text: `Pre-flight check failed: ${pfResult.error}`,
					},
				],
				details: undefined,
				isError: true,
			};
		}

		// H1: Pre-task validation at mode entry — deterministic check that
		// tools/thinking match the task (mirrors single/background modes, issue
		// #32). Graph top-level tasks are empty (modeCount forbids task+graph),
		// so keyword warnings skip on empty text and only the hard
		// outputFile-vs-write conflict applies (issue #34). The mode-level
		// outputFile on globalParams is the one validated; per-step outputFiles
		// are future work (issue #3).
		const validation = validatePreTask({
			task: globalParams.task,
			toolOptions: globalParams.toolOptions,
			thinkingLevel: globalParams.thinkingLevel,
			gitMode: globalParams.resolvedGitMode,
			outputFile: globalParams.outputFile,
		});
		if (validation.warnings.length > 0) {
			log.warn("Graph pre-task validation warnings", { warnings: validation.warnings });
		}
		if (!validation.valid) {
			const errText = validation.errors.join("; ");
			log.warn("Graph pre-task validation failed", { errors: validation.errors });
			return {
				content: [{ type: "text" as const, text: errText }],
				details: undefined,
				isError: true,
			};
		}

		// Resolve model once (per-call top-level model override beats preset)
		const modelResult = resolveSubagentModel(ctx, globalParams.resolvedPreset, params.model as string | undefined);
		if (!modelResult.ok) return modelResult.error;
		const subagentModel = modelResult.model;

		const modelStr = `${subagentModel.provider}/${subagentModel.id}`.trim();
		if (!modelStr || modelStr === "/") {
			log.warn("Model string is empty after resolution", { model: subagentModel });
			return {
				content: [
					{
						type: "text" as const,
						text:
							"Subagent model is not configured. " +
							"Use /brl-subagent to set a model, or ensure your current session has a valid model.",
					},
				],
				details: undefined,
				isError: true,
			};
		}

		// R1: Circuit breaker check
		const circuitCheck = state.checkCircuit();
		if (circuitCheck.isOpen) {
			return {
				content: [
					{ type: "text" as const, text: circuitCheck.message! },
				],
				details: undefined,
				isError: true,
			};
		}

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
					const subTaskParams: SubTaskParams = {
						task: graphTask.task,
						label: graphTask.label,
						model: graphTask.model,
						thinkingLevel: graphTask.thinkingLevel,
						priority: graphTask.priority,
						cwd: graphTask.cwd,
						timeout: graphTask.timeout,
						outputFile: graphTask.outputFile,
						tools: graphTask.tools,
						excludeTools: graphTask.excludeTools,
						noBuiltinTools: graphTask.noBuiltinTools,
						systemPrompt: graphTask.systemPrompt,
						inheritSystemPrompt: graphTask.inheritSystemPrompt,
					};

					const merged = mergeSubTaskParams(globalParams, subTaskParams);

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
					const { runId, run } = createUnitRun(merged, stepModel, graphPriority, globalParams.resolvedPreset?.name);
					state.persistRun(pi, run);

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
							resolvedCwd,
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
						);

						const subTaskResult: SubTaskResult = {
							task: merged.task,
							label: merged.label,
							exitCode: result.exitCode,
							messages: result.messages,
							stderr: result.stderr,
							usage: result.usage,
							model: result.model,
							stopReason: result.stopReason,
							errorMessage: result.errorMessage,
							errorCategory: classifyError(result),
							gitBranch: result.gitBranch,
							gitDiff: result.gitDiff,
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
						finalizeUnitRunCrash(state, pi, run, err, "Graph node", resolvedCwd, log, {
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

			chainSuccess = allResults.every(
				(r) => r.exitCode === 0 && r.stopReason !== "error" && r.stopReason !== "aborted",
			);

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

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(graphDetails, null, 2) },
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
	// /brl-subagent command
	// -------------------------------------------------------------------

	pi.registerCommand("brl-subagent", {
		description: "Configure subagent model and thinking level",
		getArgumentCompletions: (prefix: string) => {
			const options = [
				"history", "historyentries", "monitor", "dashboard", "preset", "templates", "retry", "completionnotify",
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
				costlimit: () => showCostLimitInput(ctx, state, applyConfig),
				reset: () => resetState(ctx),
				history: () => showRunHistory(ctx, state, () => state.persistState(pi)),
				historyentries: () => showHistoryEntriesInput(ctx, state, applyConfig),
				monitor: () => showMonitor(ctx, state),
				dashboard: () => showDashboard(ctx, state),
				preset: () => showPresetManager(ctx, state),
				templates: () => showTemplateManager(ctx, state),
				retry: () => showRetryMenu(ctx, state),
			"update-check": () => showUpdateCheckToggle(ctx, state, applyConfig),
			sla: () => showSLAConfig(ctx, state, applyConfig),
			"sla-stats": () => showSLAStats(ctx, state),
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
	const registrationPresets = loadBuiltinPresets(path.join(__dirname, "..", "presets"));
	const presetRestrictionSummary = buildInventorySummary(registrationPresets, (p) => {
		const restricted = p.excludeTools?.length || p.tools?.length;
		if (!restricted) return p.name;
		return `${p.name} (${formatPresetRestriction(p)})`;
	});

	// B1b: Load built-in templates once at registration to expose the built-in
	// inventory (name + purpose + ${param} slots) to the conductor before any
	// delegate_task call. Custom/user templates can't be enumerated statically,
	// so the summary covers built-ins only and points at /brl-subagent templates.
	const registrationTemplates = loadBuiltinTemplates(path.join(__dirname, "..", "templates"));
	const templateSummary = buildInventorySummary(registrationTemplates, formatTemplateSummaryItem);

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
			"The authoritative capability reference for delegation is the extension's AGENT.md — read it at ~/.pi/agent/extensions/brl-subagent/AGENT.md, or ./AGENT.md in the project root when present, when planning delegation-heavy work.",
			"The subagent inherits your system prompt and runs with its own model (configurable via /brl-subagent). It reports what it did when done.",
			"You can customize per-call via inheritSystemPrompt and systemPrompt: set inheritSystemPrompt: false to save context, provide a systemPrompt for custom instructions, or use both to add instructions on top of inheritance.",
			"Set thinkingLevel per call to match task complexity. The level is capped at the user's configured maximum. Map tasks to levels using this heuristic: off = file listing, grep, simple read. minimal = file diff, syntax check, find-and-replace. low = refactoring, test generation, documentation. medium = default — code review, debugging, moderate analysis. high = security audit, architecture review, complex debugging. xhigh = multi-step causal reasoning, research, novel problem solving. Default to 'off' or 'minimal' for trivial tasks — do not waste the user's budget.",
			"Use outputFile to have the subagent write full findings to disk and return only a structured summary — saves context tokens for large investigations.",
			"Set timeout (in ms) to limit how long a subagent can run. Useful for tasks that might hang or get stuck.",
			"Set cwd to override the subagent's working directory. Defaults to the current project directory.",
			"Set label to give the subagent a human-readable name (e.g., 'security-audit' or 'docs-review'). Labels appear in the status bar and tool call display.",
			`Use preset to apply a delegation configuration (built-in or custom via /brl-subagent preset). Preset values are defaults — explicit parameters override them. IMPORTANT: some presets restrict tools — e.g. outputFile requires the subagent's write tool, which security-auditor and code-reviewer exclude. Built-in presets: ${presetRestrictionSummary}. Custom presets are NOT listed here — inspect them via /brl-subagent preset before combining with outputFile or tool-dependent work. When combining a preset with outputFile or tool-dependent work, verify the preset allows the required tools.`,
			buildTemplateGuideline(templateSummary),
			"To retry a failed subagent, pass its run ID as retryRunId. The retried run uses the same task and parameters as the original. Parallel-origin entries retry as a single-subtask run carrying that subtask's task, label, and priority. Explicit parameters on this call override the original's. Use /brl-subagent retry to browse failed runs and get their IDs.",
			"Set retryOnTimeout: true to automatically retry a subagent that times out. Only retries once — the second timeout is treated as a final failure.",
			"Set background: true to run the subagent in the background without blocking. The tool returns immediately with an agent ID. Background runs wake the conductor with a structured completion message when they finish — do not poll: polling is only correct when completion notifications are disabled (completionNotify \"off\"); one status check as a stall check is legitimate.",
			"",
			"## Conductor Guardrails",
			"",
			"Before delegating, verify the subagent configuration matches the task:",
			"",
			"2. **Thinking level**: Match thinking level to task complexity: off/minimal for trivial tasks (file listing, grep), low for refactoring/docs, medium for code review/debugging, high for security audits/complex debugging, xhigh for multi-step reasoning/novel problems.",
			"3. **Git mode**: Use gitMode='branch' for tasks that create commits or PRs. Use gitMode='none' for read-only tasks.",
			"4. **Tools**: Verify the subagent has the tools it needs. If the task writes files, ensure write and edit are not excluded. If the task runs commands, ensure bash is not excluded.",
			"5. **Timeout**: Set timeout based on task complexity. Simple: 30s. Medium: 60s. Complex: 120s+. xhigh thinking: at least 120s.",
			"",
			"These guardrails prevent common misconfigurations. The extension also validates configuration before spawning (H1): tool warnings are informational, but outputFile with the write tool excluded is a HARD error and the delegation is rejected. Getting it right the first time is faster and more efficient.",
			"",
			"Before delegating, evaluate existing presets to find the best match for the task: tech-writer (documentation), code-reviewer (code review), security-auditor (security analysis), test-engineer (test writing), debugger (debugging), refactorer (refactoring), data-analyst (data analysis), rapid-prototyper (quick prototypes). Use the preset parameter to apply the best match. If no preset fits, use dev-agent for general development tasks.",
			"The autoRoutePreset() function can automatically select the best preset based on task keywords. Consider using it for preset selection.",
			"Prefer a preset when the delegation matches a standard shape — review/audit/test/docs; override per-call deliberately.",
		],
		parameters: Type.Object({
			task: Type.Optional(Type.String({
				description: "Detailed description of the task for the subagent to complete (required for single mode, optional for chain/tasks/graph)",
			})),
			systemPrompt: Type.Optional(
				Type.String({
					description:
						"Custom system prompt or additional instructions for the subagent. " +
						"When inheritSystemPrompt is true (default), this is appended after the inherited prompt. " +
						"When inheritSystemPrompt is false, this replaces the inherited prompt entirely.",
				}),
			),
			inheritSystemPrompt: Type.Optional(
				Type.Boolean({
					description:
						"Whether to inherit the main agent's system prompt. " +
						"Default: true. Set to false to use only your custom systemPrompt, " +
						"or to avoid passing a large inherited prompt to the subagent.",
				}),
			),
			thinkingLevel: Type.Optional(
				Type.String({
					description:
						"Requested thinking level for this subagent call. " +
						"One of: off, minimal, low, medium, high, xhigh. " +
						"Capped at the user's configured maximum. If omitted, the user's configured level is used.",
				}),
			),
			outputFile: Type.Optional(
				Type.String({
					description:
						"Project-relative path where the subagent should write its full findings. " +
						"When provided, the subagent is instructed to write complete output to this file " +
						"and return only a structured summary.",
				}),
			),
			label: Type.Optional(
				Type.String({
					description:
						"Human-readable label for this subagent (e.g., 'security-audit', 'docs-review'). " +
						"Appears in the status bar and tool call display. " +
						"Omit to use the default anonymous counter.",
				}),
			),
			model: Type.Optional(Type.String({ description: "Model override (provider/model-id). Defaults to the global subagent model." })),
			timeout: Type.Optional(
				Type.Number({
					description:
						"Maximum time in milliseconds the subagent is allowed to run. " +
						"If exceeded, the subagent is killed and an error is returned.",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description:
						"Working directory for the subagent. Must be an existing directory. " +
						"Defaults to the conductor's current working directory.",
				}),
			),
			tools: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Explicit allowlist of tool names for the subagent. Maps to pi's --tools flag.",
				}),
			),
			excludeTools: Type.Optional(
				Type.Array(Type.String(), {
					description:
						"Tool names to disable for the subagent. Maps to pi's --exclude-tools flag.",
				}),
			),
			noBuiltinTools: Type.Optional(
				Type.Boolean({
					description:
						"Disable all built-in tools for the subagent. Maps to pi's --no-builtin-tools flag.",
				}),
			),
			preset: Type.Optional(
				Type.String({
					description:
						"Name of a saved delegation preset (created via /brl-subagent preset). " +
						"Preset values are used as defaults; explicit parameters on this call override them.",
				}),
			),
			template: Type.Optional(
				Type.String({
					description:
						"Name of a saved task template. Use with params to fill template slots. " +
						"Templates are file-backed: 9 builtin templates ship with the extension " +
						"(browse via /brl-subagent templates); override or add via .md files in " +
						"~/.pi/agent/brl-subagent/templates/ or .pi/brl-subagent/templates/ " +
						"(project-local wins over user-global over builtin).",
				}),
			),
			params: Type.Optional(
				Type.Record(Type.String(), Type.String(), {
					description:
						"Parameter values for template ${param} slots. " +
						"Keys are param names, values are the substitution text.",
				}),
			),
			retryRunId: Type.Optional(
				Type.String({
					description:
						"ID of a previously failed subagent run to retry. " +
						"The retried run uses the same task and parameters as the original. " +
						"Only works with runs that ended in failure (exitCode != 0, timeout, error, or abort). " +
						"Explicit parameters on this call override the original's.",
				}),
			),
			gitMode: Type.Optional(
				Type.String({
					description:
						"Git integration mode for this subagent call. " +
						"'branch' creates a work branch, captures the diff, and switches back. " +
						"'none' (default) does nothing. Falls back to the configured default.",
				}),
			),
			retryOnTimeout: Type.Optional(
				Type.Boolean({
					description:
						"If true and the subagent times out, automatically retry with the same parameters. " +
						"Only retries once — the second timeout is treated as a final failure.",
				}),
			),
			approvalMode: Type.Optional(
				Type.String({
					description:
						"Change approval mode: auto (never ask), writes (ask when files changed), " +
						"always (ask every time). Default is user config (/brl-subagent approval).",
				}),
			),
			background: Type.Optional(
				Type.Boolean({
					description:
						"Run the subagent in the background without blocking the conductor. " +
						"When true, the tool returns immediately with an agent ID. " +
						"The conductor is woken with a completion message; use get_subagent_result for post-wake retrieval and stall checks. " +
						"Default: false (blocking mode).",
				}),
			),
			priority: Type.Optional(
				Type.Union([
					Type.Literal("critical"),
					Type.Literal("high"),
					Type.Literal("normal"),
					Type.Literal("low"),
				], {
					description: "Concurrency priority for this delegation: critical, high, normal, or low. Higher-priority delegations queue ahead. Defaults to normal.",
				})
			),
			// Issue #114: NO per-step `priority` on chain[] — chain steps never
			// compete for concurrency slots (the chain holds ONE slot for its whole
			// duration); array order IS the priority.
			chain: Type.Optional(Type.Array(Type.Object({
				task: Type.String({ description: "Task description. Use {previous} to reference the previous step output." }),
				label: Type.Optional(Type.String({})),
				model: Type.Optional(Type.String({ description: "Model override for this step (provider/model-id). Defaults to the global subagent model." })),
				thinkingLevel: Type.Optional(Type.String({})),
				cwd: Type.Optional(Type.String({})),
				timeout: Type.Optional(Type.Number({})),
				outputFile: Type.Optional(Type.String({})),
				tools: Type.Optional(Type.Array(Type.String({}))),
				excludeTools: Type.Optional(Type.Array(Type.String({}))),
				noBuiltinTools: Type.Optional(Type.Boolean({})),
				systemPrompt: Type.Optional(Type.String({})),
				inheritSystemPrompt: Type.Optional(Type.Boolean({})),
			}), {
				description: "Sequential chain of tasks. Each step receives the previous step output via {previous} placeholder in the task string. Chain stops at the first failure. Max " + MAX_CHAIN_STEPS + " steps."
			})),
			tasks: Type.Optional(Type.Array(Type.Object({
				task: Type.String({ description: "Task description for this parallel subtask" }),
				label: Type.Optional(Type.String({})),
				model: Type.Optional(Type.String({ description: "Model override for this step (provider/model-id). Defaults to the global subagent model." })),
				thinkingLevel: Type.Optional(Type.String({})),
				priority: Type.Optional(
					Type.Union([
						Type.Literal("critical"),
						Type.Literal("high"),
						Type.Literal("normal"),
						Type.Literal("low"),
					], { description: "Concurrency priority for this subtask (overrides the call-level default)." })
				),
				cwd: Type.Optional(Type.String({})),
				timeout: Type.Optional(Type.Number({})),
				outputFile: Type.Optional(Type.String({})),
				tools: Type.Optional(Type.Array(Type.String({}))),
				excludeTools: Type.Optional(Type.Array(Type.String({}))),
				noBuiltinTools: Type.Optional(Type.Boolean({})),
				systemPrompt: Type.Optional(Type.String({})),
				inheritSystemPrompt: Type.Optional(Type.Boolean({})),
			}), {
				description: "Parallel tasks to execute concurrently. All tasks run regardless of individual failures. Max " + MAX_PARALLEL_TASKS + " tasks."
			})),
			graph: Type.Optional(Type.Array(Type.Object({
				id: Type.String({ description: "Unique identifier for this task node" }),
				task: Type.String({ description: "Task description. Use {otherId} to reference output from another task." }),
				label: Type.Optional(Type.String({})),
				model: Type.Optional(Type.String({ description: "Model override for this step (provider/model-id). Defaults to the global subagent model." })),
				dependsOn: Type.Optional(Type.Array(Type.String({}), { description: "IDs of tasks that must complete before this one starts" })),
				thinkingLevel: Type.Optional(Type.String({})),
				priority: Type.Optional(
					Type.Union([
						Type.Literal("critical"),
						Type.Literal("high"),
						Type.Literal("normal"),
						Type.Literal("low"),
					], { description: "Concurrency priority for this subtask (overrides the call-level default)." })
				),
				cwd: Type.Optional(Type.String({})),
				timeout: Type.Optional(Type.Number({})),
				outputFile: Type.Optional(Type.String({})),
				tools: Type.Optional(Type.Array(Type.String({}))),
				excludeTools: Type.Optional(Type.Array(Type.String({}))),
				noBuiltinTools: Type.Optional(Type.Boolean({})),
				systemPrompt: Type.Optional(Type.String({})),
				inheritSystemPrompt: Type.Optional(Type.Boolean({})),
			}), {
				description: "Declare tasks with dependencies. The scheduler parallelizes independent tasks and sequences dependent ones. Max " + MAX_GRAPH_TASKS + " tasks."
			})),
		}),

		async execute(
			_toolCallId: string,
			params: {
				// Schema registers task as Type.Optional — required for single mode only,
				// omitted by chain/tasks/graph calls. Aligned with Static<TParams>.
				task?: string;
				label?: string;
				model?: string;
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
				template?: string;
				params?: Record<string, string>;
				retryRunId?: string;
				retryOnTimeout?: boolean;
				background?: boolean;
				gitMode?: string;
				priority?: string;
				chain?: Array<{
					task: string;
					label?: string;
					model?: string;
					thinkingLevel?: string;
					cwd?: string;
					timeout?: number;
					outputFile?: string;
					tools?: string[];
					excludeTools?: string[];
					noBuiltinTools?: boolean;
					systemPrompt?: string;
					inheritSystemPrompt?: boolean;
				}>;
				tasks?: Array<{
					task: string;
					label?: string;
					model?: string;
					thinkingLevel?: string;
					priority?: string;
					cwd?: string;
					timeout?: number;
					outputFile?: string;
					tools?: string[];
					excludeTools?: string[];
					noBuiltinTools?: boolean;
					systemPrompt?: string;
					inheritSystemPrompt?: boolean;
				}>;
				graph?: Array<{
					id: string;
					task: string;
					label?: string;
					model?: string;
					dependsOn?: string[];
					thinkingLevel?: string;
					priority?: string;
					cwd?: string;
					timeout?: number;
					outputFile?: string;
					tools?: string[];
					excludeTools?: string[];
					noBuiltinTools?: boolean;
					systemPrompt?: string;
					inheritSystemPrompt?: boolean;
				}>;
			},
			signal: AbortSignal | undefined,
			onUpdate: AgentToolUpdateCallback<DelegateTaskDetails> | undefined,
			ctx: ExtensionContext,
		) {
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

			// F1: Sanitize task input — skip for chain/parallel modes
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

			// Handle retryRunId
			if (params.retryRunId) {
				const runEntry = state.findRunById(ctx, params.retryRunId);
				if (runEntry) {
					params = resolveRetryParams(params, runEntry);
				} else {
					// Issue #98: a silent no-op here made retries of background runs
					// (which previously never wrote run entries) start as FRESH runs
					// with no signal to the caller. Fail loudly instead.
					log.warn("Retry run ID not found", { retryRunId: params.retryRunId });
					return {
						content: [{
							type: "text" as const,
							text: `Retry run ID not found: ${params.retryRunId}. The run may have been pruned, or it was a background run created before the run-entry fix (issue #98). Pass the run's agent ID — for background runs the agent ID and run ID are now the same.`,
						}],
						details: undefined,
						isError: true,
					};
				}
			}

			// Handle template resolution
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
				// Use resolved template fields as defaults, explicitly provided params override
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
				return runParallelMode(params, signal, onUpdate, ctx);
			}

			if (isGraph) {
				return runGraphMode(params, signal, onUpdate, ctx);
			}

			// Single mode: isSingle is true (modeCount===1, none of chain/parallel/graph),
			// so params.task is a non-empty string. TS can't infer this through the
			// boolean-array filter — assert, mirroring params.chain!/params.tasks! above.
			const singleTask = params.task!; // non-empty (sanitizer guarantees; isSingle confirms)

			// Phase 6.5: Background execution — spawn session and return ID immediately.
			// Resolve the preset and its model BEFORE the background branch so the
			// preset's model (and system prompt) are honored in background mode.
			const bgResolved = resolveSubagentParams({ ...params, task: singleTask }, state, ctx, log);
			const { resolvedPreset: bgResolvedPreset, autoRoutedPreset: bgAutoRoutedPreset } = bgResolved;
			const bgModelResult = resolveSubagentModel(ctx, bgResolvedPreset, params.model);
			const bgModel = bgModelResult.ok
				? `${bgModelResult.model.provider}/${bgModelResult.model.id}`
				: undefined;

			if (params.background) {
				const { spawnBackgroundSession, setAgentFinalOutput, extractFinalOutput, updateAgentStatus } = await import('./session-manager');
				// Issue #31 (PR #76 review, DRY): extract final output from a
				// possibly-released ref — the poller may observe a terminal agent
				// whose ref was already nulled by the settlement path.
				const extractAgentFinalOutput = (a: BackgroundAgent): string =>
					extractFinalOutput(a._sessionRef ?? { messages: [] });
				
				try {
					// W5 (issue #28): approvalMode 'always' cannot work in background —
					// there is no interactive dialog to approve the diff. Reject loudly
					// instead of silently running unattended with write access.
					if (bgResolved.resolvedApprovalMode === 'always') {
						return {
							content: [{ type: "text" as const, text:
								`Cannot spawn background agent with approvalMode 'always': background agents run unattended ` +
								`and cannot present the approval dialog. Use approvalMode 'auto' (default) or 'writes'.`
							}],
							details: undefined,
							isError: true,
						};
					}
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
					const bgPerTaskEstimate = state.config.perTaskCostEstimate > 0
						? state.config.perTaskCostEstimate
						: 0.05;
					if (state.checkCostLimit(bgPerTaskEstimate, ctx)) {
						const bgLimit = state.config.sessionCostLimit;
						const bgCurrentTotal = state.getSessionTotalCost(ctx);
						log.warn("Background delegation rejected: session cost limit reached", {
							currentTotal: bgCurrentTotal,
							estimatedCost: bgPerTaskEstimate,
							limit: bgLimit,
						});
						return {
							content: [
								{
									type: "text" as const,
									text:
										`Cannot delegate: session cost limit reached ` +
										`($${bgCurrentTotal.toFixed(4)} spent of $${bgLimit.toFixed(2)} limit). ` +
										`Increase the limit via /brl-subagent costlimit or set to 0 for unlimited.`,
								},
							],
							details: undefined,
							isError: true,
						};
					}

					// F1: Validate cwd + outputFile the same way foreground single mode does —
					// an unvalidated outputFile would reach the prompt and could steer the
					// background agent's write tool outside the project root.
					const bgCwdResult = validateCwd(bgResolved.effectiveCwd, ctx.cwd);
					if (!bgCwdResult.ok) {
						return {
							content: [{ type: "text" as const, text: `Invalid cwd: ${bgCwdResult.error}` }],
							details: undefined,
							isError: true,
						};
					}
					let bgResolvedOutputFile: string | undefined;
					if (bgResolved.outputFile) {
						const ofResult = validateOutputFile(bgResolved.outputFile, bgCwdResult.value);
						if (!ofResult.ok) {
							return {
								content: [
									{ type: "text" as const, text: `Invalid outputFile: ${ofResult.error}` },
								],
								details: undefined,
								isError: true,
							};
						}
						bgResolvedOutputFile = ofResult.value;
					}

					// C: H1 validation for background mode — reject outputFile-vs-write
					// conflicts before spawning (loud failure, same as single mode).
					const bgValidation = validatePreTask({
						task: singleTask,
						toolOptions: bgResolved.toolOptions,
						thinkingLevel: bgResolved.thinkingLevel,
						gitMode: bgResolved.resolvedGitMode,
						outputFile: bgResolvedOutputFile,
					});
					if (bgValidation.warnings.length > 0) {
						log.warn("Background pre-task validation warnings", { warnings: bgValidation.warnings });
					}
					if (!bgValidation.valid) {
						const errText = bgValidation.errors.join("; ");
						log.warn("Background pre-task validation failed", { errors: bgValidation.errors });
						return {
							content: [{ type: "text" as const, text: errText }],
							details: undefined,
							isError: true,
						};
					}

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

					const agent = await spawnBackgroundSession(pi, ctx, {
						task: singleTask,
						type: params.preset || 'general-purpose',
						description: params.label,
						model: bgModel,
						thinkingLevel: bgResolved.thinkingLevel,
						// Issue #114: per-unit priority rides the spawn so the background
						// run entry + drill-in header carry it like foreground runs.
						priority: params.priority,
						systemPrompt: bgPrompt,
						cwd: bgCwdResult.value,
						toolOptions: bgResolved.toolOptions,
						timeout: bgResolved.timeout,
						gitMode: bgResolved.resolvedGitMode,
						// Issue #98: snapshot the caller's raw params on the run entry so a
						// retry of this background run restores them — single source of truth
						// snapshotOriginalParams (issue #108: no more duplicated 11-field literal).
						originalParams: snapshotOriginalParams(params),
					});
					
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
					updateProgressStatus(state, ctx);

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
								updateProgressStatus(state, ctx);
								pi.sendMessage({
									customType: "subagent-notification",
									content: `Background agent "${agent.description}" crashed.`,
									display: true,
									details: { agentId: agent.id }
								}, { deliverAs: "followUp" });
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
									updateProgressStatus(state, ctx);
									pi.sendMessage({
										customType: "subagent-notification",
										content: `Background agent "${agent.description}" failed.`,
										display: true,
										details: { agentId: agent.id }
									}, { deliverAs: "followUp" });
								} else if (agent.status === 'stopped') {
									// User-initiated stop (stop_subagent) or deadline abort
									// (timeout/hard cap) — not a failure.
									updateProgressStatus(state, ctx);
								} else {
									state.completedSubagents++;
									state.unseenSubagents++;
									updateProgressStatus(state, ctx);
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
								updateProgressStatus(state, ctx);
								pi.sendMessage({
									customType: "subagent-notification",
									content: `Background agent "${agent.description}" crashed: ${sanitizeErrorMessage((err as Error).message, bgResolved.effectiveCwd)}`,
									display: true,
									details: { agentId: agent.id }
								}, { deliverAs: "followUp" });
							}
						}
					}, 2000);
					
					// Hard cap: stop polling AND abort the session after the deadline.
					// W2 (issue #28): previously this only stopped the poller — the pi
					// session kept running forever (orphaned). Now it pre-sets
					// 'stopped' (so the .then keeps it, per W1) and aborts the
					// session. The cap honors a shorter per-agent timeout.
					const hardCapMs = Math.min(bgResolved.timeout ?? 30 * 60 * 1000, 30 * 60 * 1000);
					const hardCapHandle = setTimeout(() => {
						if (!completed && !agent.completedAt) {
							try {
								completed = true;
								clearInterval(pollInterval);
								// Pre-set stopped BEFORE aborting so the .then in
								// spawnBackgroundSession keeps the stopped state.
								updateAgentStatus(agent.id, 'stopped', `Timed out (${hardCapMs}ms hard cap)`);
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
								updateProgressStatus(state, ctx);
							} catch (err) {
								// Defensive: never let the hard-cap timer throw uncaught — that would
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
									updateAgentStatus(agent.id, 'stopped', `Timed out (${hardCapMs}ms hard cap)`);
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
								updateProgressStatus(state, ctx);
							}
						}
					}, hardCapMs);
					
					log.info("Background agent spawned", { agentId: agent.id, task: params.task, model: agent.model });

					// B2: Surface auto-route decisions in background spawn result too.
					// Derive the restriction from the RESOLVED toolOptions (which reflects
					// per-call overrides) rather than the preset's declared values.
					const bgAutoRouteNote = bgAutoRoutedPreset
						? `\n\n[auto-routed to preset '${bgAutoRoutedPreset.name}' — ${bgResolved.toolOptions ? formatToolRestriction(bgResolved.toolOptions) : formatPresetRestriction(bgAutoRoutedPreset)}]`
						: "";

					return {
						content: [{
							type: "text" as const,
							text: `Background agent started: ${agent.id}\n\n` +
								`Description: ${agent.description}\n` +
								`Task: ${agent.task}\n` +
								`Status: ${agent.status}\n\n` +
								`You'll be woken with a completion message when it finishes; use get_subagent_result({ agent_id: "${agent.id}" }) for retrieval and stall checks.` +
								bgAutoRouteNote,
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

			// R5: Check session cost limit before spawning
			// Use a default per-task estimate of $0.05 if no perTaskCostEstimate is set
			const perTaskEstimate = state.config.perTaskCostEstimate > 0
				? state.config.perTaskCostEstimate
				: 0.05;
			const currentTotal = state.getSessionTotalCost(ctx);
			if (state.checkCostLimit(perTaskEstimate, ctx)) {
				const limit = state.config.sessionCostLimit;
				log.warn("Subagent delegation rejected: session cost limit reached", {
					currentTotal,
					estimatedCost: perTaskEstimate,
					limit,
				});
				return {
					content: [
						{
							type: "text" as const,
							text:
								`Cannot delegate: session cost limit reached ` +
								`($${currentTotal.toFixed(4)} spent of $${limit.toFixed(2)} limit). ` +
								`Increase the limit via /brl-subagent costlimit or set to 0 for unlimited.`,
						},
					],
					details: undefined,
					isError: true,
				};
			}

			// Reject delegation if recursion depth exceeds configured max.
			// This prevents subagents from spawning infinite sub-subagents while
			// still allowing other extensions to function normally in subprocesses.
			const currentDepth = getCurrentDepth();
			if (currentDepth >= state.config.maxSubagentDepth) {
				log.warn("Subagent delegation rejected: max depth reached", {
					currentDepth,
					maxDepth: state.config.maxSubagentDepth,
				});
				return {
					content: [
						{
							type: "text" as const,
							text:
								`Cannot delegate further: subagent recursion depth limit reached ` +
								`(depth ${currentDepth}/${state.config.maxSubagentDepth}). ` +
								`Subagents can delegate up to ${state.config.maxSubagentDepth} levels deep (configurable via /brl-subagent depth). Complete the remaining work directly.`,
						},
					],
					details: undefined,
					isError: true,
				};
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
			const validation = validatePreTask({
				task,
				toolOptions,
				thinkingLevel,
				gitMode: resolvedGitMode,
				outputFile: resolvedOutputFile,
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

			// Resolve model (per-call top-level model override beats preset)
			const modelResult = resolveSubagentModel(ctx, resolvedPreset, params.model);
			if (!modelResult.ok) return modelResult.error;
			const subagentModel = modelResult.model;

			// R3: Verify resolved model provider+id is non-empty
			const modelStr = `${subagentModel.provider}/${subagentModel.id}`.trim();
			if (!modelStr || modelStr === "/") {
				log.warn("Model string is empty after resolution", { model: subagentModel });
				return {
					content: [
						{
							type: "text" as const,
							text:
								"Subagent model is not configured. " +
								"Use /brl-subagent to set a model, or ensure your current session has a valid model.",
						},
					],
					details: undefined,
					isError: true,
				};
			}

			// Create run record
			const runId = crypto.randomUUID();
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
			};
			state.persistRun(pi, run);

			// R2: Prune old run entries if history exceeds limit
			pruneHistoryIfNeeded(state, ctx, log);

			// Register for live monitor
			registerLiveRun(state, run, ctx);

			// P3: Git integration — set up work branch if gitMode is "branch"
			let originalBranch: string | undefined;
			let workBranchName: string | undefined;
			if (resolvedGitMode === "branch") {
				try {
					originalBranch = getCurrentBranch(resolvedCwd);

					if (hasUncommittedChanges(resolvedCwd)) {
						log.warn("Uncommitted changes detected; proceeding with branch-based workflow anyway", {
							cwd: resolvedCwd,
						});
					}

					const branchResult = createWorkBranch(resolvedCwd, originalBranch);
					if (branchResult.ok) {
						workBranchName = branchResult.branch;
						log.info("Created work branch for subagent", {
							branch: workBranchName,
							base: originalBranch,
						});
					} else {
						log.error("Failed to create work branch, falling back to 'none'", {
							error: branchResult.error,
						});
						originalBranch = undefined;
					}
				} catch (err) {
					log.warn("Not a git repository or git error; falling back to gitMode 'none'", {
						error: (err as Error).message,
					});
					originalBranch = undefined;
					workBranchName = undefined;
				}
			}

			// Helper to switch back to original branch and optionally delete work branch
			const cleanupGitBranch = () => {
				if (workBranchName && originalBranch) {
					try {
						switchToBranch(resolvedCwd, originalBranch);
						log.info("Switched back to original branch", { branch: originalBranch });
						// Attempt to delete the work branch (non-critical)
						deleteBranch(resolvedCwd, workBranchName);
					} catch {
						// Non-fatal: best-effort cleanup
					}
				}
			};

			// R1: Circuit breaker check — reject if circuit is open
			const circuitCheck = state.checkCircuit();
			if (circuitCheck.isOpen) {
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
				cleanupGitBranch();
				return {
					content: [
						{
							type: "text" as const,
							text: "Subagent cancelled while waiting for concurrency slot.",
						},
					],
					details: undefined,
					isError: true,
				};
			}

			let success = false;

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
					);
				}

				// F3: Sanitize and cap output
				let finalOutput = getFinalOutput(result.messages);
				finalOutput = stripAnsi(finalOutput);
				finalOutput = capOutput(finalOutput);

				// Attach label for display
				result.label = label;

				// P3: Capture git diff if we created a work branch
				if (workBranchName && originalBranch) {
					const diffResult = captureDiff(resolvedCwd, originalBranch);
					if (diffResult.ok) {
						result.gitBranch = workBranchName;
						result.gitDiff = diffResult.diff;
					}

					// Switch back to the original branch
					const switchResult = switchToBranch(resolvedCwd, originalBranch);
					if (switchResult.ok) {
						log.info("Switched back to original branch", { branch: originalBranch });

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
							deleteBranch(resolvedCwd, workBranchName);
							workBranchName = undefined;
						} else {
							// No changes — just delete the empty branch
							deleteBranch(resolvedCwd, workBranchName);
							workBranchName = undefined;
						}
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
				// sees which preset was applied and what it restricts. Derive the
				// restriction from the RESOLVED toolOptions (reflects per-call
				// overrides) rather than the preset's declared values.
				const autoRouteNote = autoRoutedPreset
					? `\n\n[auto-routed to preset '${autoRoutedPreset.name}' — ${toolOptions ? formatToolRestriction(toolOptions) : formatPresetRestriction(autoRoutedPreset)}]`
					: "";

				return {
					content: [
						{ type: "text" as const, text: (finalOutput || "(no output)") + autoRouteNote },
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
			args: {
				task?: string;
				label?: string;
				systemPrompt?: string;
				inheritSystemPrompt?: boolean;
				thinkingLevel?: string;
				outputFile?: string;
				timeout?: number;
				cwd?: string;
				tools?: string[];
				excludeTools?: string[];
				noBuiltinTools?: boolean;
			},
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
			"Returns the agent's status, result (if completed), and transcript path.",
		].join(" "),
		parameters: Type.Object({
			agent_id: Type.String({
				description: "The agent ID returned by delegate_task when background=true",
			}),
			wait: Type.Optional(
				Type.Boolean({
					description: "If true, wait for the agent to complete before returning. Default: false.",
				}),
			),
			verbose: Type.Optional(
				Type.Boolean({
					description: "If true, include the full conversation log. Default: false.",
				}),
			),
		}),
		execute: async (toolCallId, params) => {
			const { getAgent } = await import('./session-manager');
			const { getTranscript } = await import('./transcript');
			
			const agent = getAgent(params.agent_id);
			
			if (!agent) {
				return {
					content: [{ type: "text" as const, text: `Agent ${params.agent_id} not found` }],
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
				const transcript = getTranscript(params.agent_id);
				if (transcript.length > 0) {
					resultText += `\n\nTranscript (${transcript.length} entries):\n`;
					for (const entry of transcript.slice(-10)) { // Last 10 entries
						resultText += `[${new Date(entry.timestamp).toISOString()}] ${entry.type}: ${entry.content.slice(0, 100)}\n`;
					}
				}
			}
			
			// Include transcript path
			const { getTranscriptPath } = await import('./session-manager');
			resultText += `\nTranscript: ${getTranscriptPath(params.agent_id)}`;
			
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
			"The message interrupts after the current tool execution.",
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
				const agent = steerAgent(params.agent_id, params.message);
				
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
		// Load built-in presets
		const presetsDir = path.join(__dirname, "..", "presets");
		state.builtinPresets = loadBuiltinPresets(presetsDir, log);
		state.customPresets = loadCustomPresets(ctx.cwd, log);
		// Builtin templates + merged full stack (custom overrides builtin)
		const templatesDir = path.join(__dirname, "..", "templates");
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

		// Check for updates (non-blocking, once per 24h)
		if (state.config.updateCheckEnabled) {
			const now = Date.now();
			if (now - state.config.lastUpdateCheck > UPDATE_CHECK_INTERVAL_MS) {
				state.config.lastUpdateCheck = now;
				checkForUpdates(currentVersion, log).then((result) => {
					if (result?.available) {
						ctx.ui.notify(
							"brl-subagent " + result.version + " available (current: " + currentVersion + "). Visit " + result.url + " to update. /brl-subagent update-check to disable.",
							"info"
						);
						log.info("Update available", { current: currentVersion, latest: result.version });
					}
				}).catch(() => {}); // silently ignore errors
			}
		}

		updateStatus(state, ctx);
	});

	// F7: Clean up session-bound state on shutdown
	pi.on("session_shutdown", async (_event, _ctx) => {
		log.info("Session shutting down", {
			activeSubagents: state.activeSubagents,
		});

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
		// Clear pending queue
		state.pendingQueue.length = 0;
	});

	// -------------------------------------------------------------------
	// Issue #147: completion-push wake — subscribe to terminal event-bus events
	// -------------------------------------------------------------------
	// The event-bus is the complete terminal chokepoint (subagent:completed /
	// subagent:failed / subagent:stopped), so the conductor is woken via
	// pi.sendMessage + triggerTurn when a background run reaches a terminal state.
	// Delivery is always-on (minimum nextTurn); the completionNotify knob controls
	// the WAKE (D1+D2 — see notify-completion.ts). The dedupe set defends the
	// pathological double-emit path (first terminal event per id wins); it is
	// capped simply (cleared when it exceeds 200 entries).
	//
	// Stopped-run degradation — ACCEPTED BY DESIGN (review #2, adjudicated
	// 2026-09-01): subagent:stopped fires at stop time (updateAgentStatus) BEFORE
	// finalizeRunEntry stamps cost/duration/errorCategory and before finalOutput
	// is captured. So the stopped shape may lack those fields and the run entry
	// resolveRunEntry returns may be the pre-finalize spawn entry. The wake is
	// the point; details are best-effort — the notification must never throw or
	// block on their absence.
	const terminalSeen = new Set<string>();
	const terminalTypes = ["subagent:completed", "subagent:failed", "subagent:stopped"] as const;
	for (const type of terminalTypes) {
		eventBus.on(type, (event) => {
			void deliverCompletionAlert(event);
		});
	}

	async function deliverCompletionAlert(event: SubagentEvent): Promise<void> {
		const id = event.agentId;
		if (!markTerminalSeen(terminalSeen, id)) return;
		const ctx = sessionCtx;
		if (!ctx) return;
		try {
			const { getAgent } = await import("./session-manager");
			const agent = getAgent(id);
			if (!agent) return; // pruned or foreign id — nothing to notify
			const knob = state.config.completionNotify ?? "all";
			const run = resolveRunEntry(state.getRunEntries(ctx), id);
			const message = buildCompletionMessage(agent, run);
			const delivery = resolveDelivery(normalizeCompletionStatus(agent.status), knob);
			sendCompletionNotification(pi, message, delivery);
		} catch (err) {
			log.warn(`completion-push handler failed for ${id}`, {
				error: (err as Error).message,
			});
		}
	}
}

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
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type {
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
	AVAILABLE_BACKENDS,
	type GitMode,
} from "./types";
import { validateGraph, topologicalSort } from "./scheduler";
import { resolveTemplate } from "./templates";
import { Scheduler, type ScheduleConfig } from "./schedule";

import { sanitizeTask, validateCwd, validateOutputFile, stripAnsi, capOutput, getCurrentDepth } from "./sanitize";
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
import { loadBuiltinPresets, getAllPresets } from "./presets";
import { autoRoutePreset } from "./router";
import { validatePreTask, diagnoseFailure } from "./validate";
import { getPreset as getPresetFn } from "./tui";
import { createSessionState } from "./state";
import { buildSubagentPrompt, describePromptMode } from "./prompt";
import { runSubagent, cleanupTempDirs } from "./runner";
import { getBackend, type Backend, DEFAULT_BACKEND } from "./backend";
import { ProcessPool } from "./pool";
import { acquireSlot, releaseSlot, updateStatus, updateProgressStatus } from "./concurrency";
import {
	finalizeRunRecord,
	resolveRetryParams,
	createEmptyResult,
	pruneSessionRuns,
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
	showPresetManager,
	showTemplateManager,
	showBackendSelector,
	showPoolConfig,
	showUpdateCheckToggle,
	showDefaultPrioritySelector,
	showGitModeSelector,
	showSLAConfig,
	showSLAStats,
	showConfigMenu,
	showRunHistory,
	showMonitor,
	showDashboard,
	showRetryMenu,
	showScheduleManager,
	showAddSchedule,
	showRemoveSchedule,
	showScheduleList,
	renderDelegateCall,
	renderDelegateResult,
} from "./tui";
import { createLogger, type Logger } from "./logging";
import { Intercom } from "./messaging";
import { checkForUpdates } from "./update";
import { UPDATE_CHECK_INTERVAL_MS } from "./types";

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

	// E11: Process pool — created when poolEnabled, shared across delegate_task calls
	let pool: ProcessPool | undefined;

	// E9: Recurring task scheduler
	let scheduler: Scheduler | undefined;

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
		updateStatus(state, ctx);
		state.persistState(pi);
		ctx.ui.notify("Subagent configuration reset", "info");
	}

	// -------------------------------------------------------------------
	// Parameter resolution
	// -------------------------------------------------------------------

	function resolveSubagentParams(
		params: {
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
		ctx: ExtensionContext,
	): ResolvedParams & { resolvedGitMode: GitMode; resolvedApprovalMode: ApprovalMode } {
		// E2: Auto-route to best preset when neither preset nor template is specified
		let resolvedPreset = params.preset;
		if (!resolvedPreset && !params.template) {
			const allPresets = getAllPresets(state.builtinPresets, state.config.presets);
			const suggested = autoRoutePreset(params.task, allPresets);
			if (suggested) {
				resolvedPreset = suggested;
				log.info("Auto-routed task to preset", { preset: suggested });
			}
		}

		const preset = resolvedPreset
			? getPresetFn(resolvedPreset, state.builtinPresets, state.config.presets)
			: undefined;

		const mergedThinkingLevel =
			(params.thinkingLevel as ThinkingLevel | undefined) ?? preset?.thinkingLevel;
		const mergedSystemPrompt = params.systemPrompt ?? preset?.systemPrompt;
		const mergedInheritSP = params.inheritSystemPrompt ?? preset?.inheritSystemPrompt;
		const mergedOutputFile = params.outputFile ?? preset?.outputFile;
		const mergedTimeout = params.timeout ?? preset?.timeout;
		const mergedTools = params.tools ?? preset?.tools;
		// Fix: edit depends on write in pi's tool system.
		// If edit is in the allowlist but write is not, all tools fail to resolve.
		const resolvedTools = mergedTools && mergedTools.includes("edit") && !mergedTools.includes("write")
			? [...mergedTools, "write"]
			: mergedTools;
		const mergedExcludeTools = params.excludeTools ?? preset?.excludeTools;
		const mergedNoBuiltinTools = params.noBuiltinTools ?? preset?.noBuiltinTools;

		const mergedGitMode = (params.gitMode as GitMode | undefined) ?? preset?.name;
		const resolvedGitMode: GitMode =
			mergedGitMode === "branch" || mergedGitMode === "none"
				? mergedGitMode
				: state.config.gitMode;

		// P4: Resolve approval mode: per-call param > state config > default "writes"
		const mergedApprovalMode = params.approvalMode as ApprovalMode | undefined;
		const resolvedApprovalMode: ApprovalMode =
			mergedApprovalMode === "auto" || mergedApprovalMode === "writes" || mergedApprovalMode === "always"
				? mergedApprovalMode
				: state.config.approvalMode;

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
			task: params.task,
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
		};
	}

	function resolveSubagentModel(ctx: ExtensionContext):
		| { ok: true; model: { provider: string; id: string } }
		| { ok: false; error: AgentToolResult<SubagentResult> } {
		const subagentModel =
			state.config.model ||
			(ctx.model ? { provider: ctx.model.provider, id: ctx.model.id } : undefined);

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
					isError: true,
				},
			};
		}

		return { ok: true, model: subagentModel };
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
		inheritSP: boolean;
		customSP: string | undefined;
		outputFile: string | undefined;
		timeout: number | undefined;
		effectiveCwd: string;
		thinkingLevel: ThinkingLevel;
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
			inheritSP: subTask.inheritSystemPrompt ?? globalParams.inheritSP,
			customSP: subTask.systemPrompt ?? globalParams.customSP,
			outputFile: subTask.outputFile ?? globalParams.outputFile,
			timeout: subTask.timeout ?? globalParams.timeout,
			effectiveCwd: subTask.cwd ?? globalParams.effectiveCwd,
			thinkingLevel: mergedThinkingLevel,
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
		onUpdate:
			| ((partial: AgentToolResult<SubagentResult>) => void)
			| undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<Record<string, unknown>>> {
		const chainSteps = params.chain as SubTaskParams[];

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
			ctx,
		);

		// Validate CWD once
		const cwdResult = validateCwd(globalParams.effectiveCwd, ctx.cwd);
		if (!cwdResult.ok) {
			return {
				content: [
					{ type: "text" as const, text: `Invalid cwd: ${cwdResult.error}` },
				],
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
				isError: true,
			};
		}

		// Resolve model once
		const modelResult = resolveSubagentModel(ctx);
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
				isError: true,
			};
		}

		// Resolve priority
		const chainPriority: Priority = (
			params.priority && ["critical", "high", "normal", "low"].includes(params.priority)
				? (params.priority as Priority)
				: state.config.defaultPriority
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

				// Wrap onUpdate so live monitor (if any) sees per-step progress
				const stepOnUpdate = onUpdate
					? (partial: AgentToolResult<SubagentResult>) => {
							onUpdate(partial);
						}
					: undefined;

				// Run the subagent for this step
				const result = await runSubagent(
					resolvedCwd,
					subagentPrompt,
					subagentModel,
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

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(chainDetails, null, 2) },
				],
				details: chainDetails as unknown as SubagentResult,
			};
		} catch (err) {
			const errorMessage = (err as Error).message || String(err);
			log.error("Chain mode crashed", { error: errorMessage });
			return {
				content: [
					{
						type: "text" as const,
						text: `Chain mode crashed: ${errorMessage}`,
					},
				],
				details: {
					messages: [],
					usage: { ...EMPTY_USAGE },
					exitCode: 1,
					stderr: String(err),
					errorMessage,
				},
				isError: true,
			};
		} finally {
			releaseSlot(state, chainSuccess, ctx);
		}
	}

	// -------------------------------------------------------------------
	// P2: runParallelMode
	// -------------------------------------------------------------------

	async function runParallelMode(
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate:
			| ((partial: AgentToolResult<SubagentResult>) => void)
			| undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<Record<string, unknown>>> {
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
			ctx,
		);

		// Validate CWD once
		const cwdResult = validateCwd(globalParams.effectiveCwd, ctx.cwd);
		if (!cwdResult.ok) {
			return {
				content: [
					{ type: "text" as const, text: `Invalid cwd: ${cwdResult.error}` },
				],
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
				isError: true,
			};
		}

		// Resolve model once
		const modelResult = resolveSubagentModel(ctx);
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
		const runTask = async (index: number): Promise<void> => {
			const step = taskList[index];
			const merged = mergeSubTaskParams(globalParams, step);

			// Build system prompt for this task
			const subagentPrompt = buildSubagentPrompt(
				basePrompt,
				merged.inheritSP,
				merged.customSP,
				merged.outputFile,
				merged.toolOptions?.tools,
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

			// Wrap onUpdate for per-task progress
			const taskOnUpdate = onUpdate
				? (partial: AgentToolResult<SubagentResult>) => {
						onUpdate(partial);
					}
				: undefined;

			// Run subagent
			const result = await runSubagent(
				resolvedCwd,
				subagentPrompt,
				subagentModel,
				merged.thinkingLevel,
				merged.task,
				signal,
				taskOnUpdate,
				merged.toolOptions,
				merged.timeout,
				getFinalOutput,
				log,
				currentDepth + 1,
				undefined, // pool

				undefined, // intercom
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
		};

		// Resolve priority
		const parallelPriority: Priority = (
			params.priority && ["critical", "high", "normal", "low"].includes(params.priority)
				? (params.priority as Priority)
				: state.config.defaultPriority
		);

		// Launch all tasks concurrently using acquireSlot for natural concurrency limiting
		const promises = taskList.map(async (_, index) => {
			const acquired = await acquireSlot(state, ctx, signal, parallelPriority);
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
			try {
				await runTask(index);
			} finally {
				// Release slot — always mark success=false since we track success per-task
				releaseSlot(state, false, ctx);
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
			details: parallelDetails as unknown as SubagentResult,
		};
	}

	// -------------------------------------------------------------------
	// P10: runGraphMode
	// -------------------------------------------------------------------

	async function runGraphMode(
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate:
			| ((partial: AgentToolResult<SubagentResult>) => void)
			| undefined,
		ctx: ExtensionContext,
	): Promise<AgentToolResult<Record<string, unknown>>> {
		const graphTasks = params.graph as GraphTask[];

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
			ctx,
		);

		// Validate CWD once
		const cwdResult = validateCwd(globalParams.effectiveCwd, ctx.cwd);
		if (!cwdResult.ok) {
			return {
				content: [
					{ type: "text" as const, text: `Invalid cwd: ${cwdResult.error}` },
				],
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
				isError: true,
			};
		}

		// Resolve model once
		const modelResult = resolveSubagentModel(ctx);
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
				isError: true,
			};
		}

		// Resolve priority
		const graphPriority: Priority = (
			params.priority && ["critical", "high", "normal", "low"].includes(params.priority)
				? (params.priority as Priority)
				: state.config.defaultPriority
		);

		// Topological sort → execution waves
		const sortResult = topologicalSort(graphTasks);
		if (!sortResult.ok) {
			return {
				content: [
					{ type: "text" as const, text: `Graph scheduling failed: ${sortResult.error}` },
				],
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

		let chainSuccess = false;
		try {
			for (let w = 0; w < waves.length; w++) {
				const wave = waves[w];
				const waveIndex = w + 1;
				const isParallel = wave.length > 1;

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
				const wavePromises = wave.map(async (graphTask) => {
					const subTaskParams: SubTaskParams = {
						task: graphTask.task,
						label: graphTask.label,
						preset: graphTask.preset,
						thinkingLevel: graphTask.thinkingLevel,
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
					);

					// Acquire concurrency slot
					const acquired = await acquireSlot(state, ctx, signal, graphPriority);
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
					try {
						const stepOnUpdate = onUpdate
							? (partial: AgentToolResult<SubagentResult>) => {
								onUpdate(partial);
								}
							: undefined;

						const result = await runSubagent(
							resolvedCwd,
							subagentPrompt,
							subagentModel,
							merged.thinkingLevel,
							merged.task,
							signal,
							stepOnUpdate,
							merged.toolOptions,
							merged.timeout,
							getFinalOutput,
							log,
							currentDepth + 1,
							pool,
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

						return { id: graphTask.id, result: subTaskResult };
					} finally {
						releaseSlot(state, false, ctx);
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

			return {
				content: [
					{ type: "text" as const, text: JSON.stringify(graphDetails, null, 2) },
				],
				details: graphDetails as unknown as SubagentResult,
			};
		} catch (err) {
			const errorMessage = (err as Error).message || String(err);
			log.error("Graph mode crashed", { error: errorMessage });
			return {
				content: [
					{
						type: "text" as const,
						text: `Graph mode crashed: ${errorMessage}`,
					},
				],
				details: {
					messages: [],
					usage: { ...EMPTY_USAGE },
					exitCode: 1,
					stderr: String(err),
					errorMessage,
				},
				isError: true,
			};
		} finally {
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
				"history", "historyentries", "monitor", "dashboard", "preset", "templates", "retry", "pool", "schedule", "unschedule",
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
				priority: () => showDefaultPrioritySelector(ctx, state, applyConfig),
				gitmode: () => showGitModeSelector(ctx, state, applyConfig),
				approval: () => showApprovalModeSelector(ctx, state, applyConfig),
				backend: () => showBackendSelector(ctx, state, applyConfig),
				costlimit: () => showCostLimitInput(ctx, state, applyConfig),
				reset: () => resetState(ctx),
				history: () => showRunHistory(ctx, state, () => state.persistState(pi)),
				historyentries: () => showHistoryEntriesInput(ctx, state, applyConfig),
				monitor: () => showMonitor(ctx, state),
				dashboard: () => showDashboard(ctx, state),
				preset: () => showPresetManager(ctx, state, () => state.persistState(pi)),
				templates: () => showTemplateManager(ctx, state, () => state.persistState(pi)),
				retry: () => showRetryMenu(ctx, state),
				pool: () => showPoolConfig(ctx, state, applyConfig),
			"update-check": () => showUpdateCheckToggle(ctx, state, applyConfig),
			sla: () => showSLAConfig(ctx, state, applyConfig),
			"sla-stats": () => showSLAStats(ctx, state),
				schedule: async () => {
					if (!scheduler) {
						ctx.ui.notify("Scheduler not initialized.", "error");
						return;
					}
					await showScheduleManager(ctx, state, scheduler.getSchedules(), () => state.persistState(pi), {
						addSchedule: () => showAddSchedule(ctx, state, scheduler!.getSchedules(), () => state.persistState(pi), {
							addScheduleEntry: (config: ScheduleConfig) => scheduler!.addSchedule(config.name, config),
						}),
						removeSchedule: () => showRemoveSchedule(ctx, scheduler!.getSchedules(), () => state.persistState(pi), {
							removeScheduleEntry: (id: string) => scheduler!.removeSchedule(id),
						}),
						listSchedules: () => showScheduleList(ctx, scheduler!.getSchedules()),
					});
				},
				unschedule: async () => {
					if (!scheduler) {
						ctx.ui.notify("Scheduler not initialized.", "error");
						return;
					}
					await showRemoveSchedule(ctx, scheduler.getSchedules(), () => state.persistState(pi), {
						removeScheduleEntry: (id: string) => scheduler!.removeSchedule(id),
					});
				},
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

	// Register keyboard shortcut for live monitor
	pi.registerShortcut("ctrl+shift+o", {
		description: "Open subagent live monitor",
		handler: async (_input, ctx) => {
			await showMonitor(ctx, state);
		},
	});

	// -------------------------------------------------------------------
	// delegate_task tool
	// -------------------------------------------------------------------

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
			"The subagent inherits your system prompt and runs with its own model (configurable via /brl-subagent). It reports what it did when done.",
			"You can customize per-call via inheritSystemPrompt and systemPrompt: set inheritSystemPrompt: false to save context, provide a systemPrompt for custom instructions, or use both to add instructions on top of inheritance.",
			"Set thinkingLevel per call to match task complexity. The level is capped at the user's configured maximum. Map tasks to levels using this heuristic: off = file listing, grep, simple read. minimal = file diff, syntax check, find-and-replace. low = refactoring, test generation, documentation. medium = default — code review, debugging, moderate analysis. high = security audit, architecture review, complex debugging. xhigh = multi-step causal reasoning, research, novel problem solving. Default to 'off' or 'minimal' for trivial tasks — do not waste the user's budget.",
			"Use outputFile to have the subagent write full findings to disk and return only a structured summary — saves context tokens for large investigations.",
			"Set timeout (in ms) to limit how long a subagent can run. Useful for tasks that might hang or get stuck.",
			"Set cwd to override the subagent's working directory. Defaults to the current project directory.",
			"Set label to give the subagent a human-readable name (e.g., 'security-audit' or 'docs-review'). Labels appear in the status bar and tool call display.",
			"Use preset to apply a delegation configuration (built-in or custom via /brl-subagent preset). Preset values are defaults — explicit parameters override them. Built-in presets: code-reviewer, security-auditor, test-engineer, tech-writer, rapid-prototyper, debugger, refactorer, data-analyst.",
			"To retry a failed subagent, pass its run ID as retryRunId. The retried run uses the same task and parameters as the original. Explicit parameters on this call override the original's. Use /brl-subagent retry to browse failed runs and get their IDs.",
			"Set retryOnTimeout: true to automatically retry a subagent that times out. Only retries once — the second timeout is treated as a final failure.",
			"Set background: true to run the subagent in the background without blocking. The tool returns immediately with an agent ID. Use get_subagent_result to check status and retrieve results later.",
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
			"These guardrails prevent common misconfigurations. The extension also validates configuration before spawning (H1), but getting it right the first time is faster and more efficient.",
			"",
			"Before delegating, evaluate existing presets to find the best match for the task: tech-writer (documentation), code-reviewer (code review), security-auditor (security analysis), test-engineer (test writing), debugger (debugging), refactorer (refactoring), data-analyst (data analysis), rapid-prototyper (quick prototypes). Use the preset parameter to apply the best match. If no preset fits, use dev-agent for general development tasks.",
			"The autoRoutePreset() function can automatically select the best preset based on task keywords. Consider using it for preset selection.",
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
						"Templates are created via /brl-subagent templates.",
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
			backend: Type.Optional(Type.String({ description: "Subagent backend: pi (default, full tools) or direct-api (no tools, direct API call)." })),
			background: Type.Optional(
				Type.Boolean({
					description:
						"Run the subagent in the background without blocking the conductor. " +
						"When true, the tool returns immediately with an agent ID. " +
						"Use get_subagent_result to check status and retrieve results. " +
						"Default: false (blocking mode).",
				}),
			),
			chain: Type.Optional(Type.Array(Type.Object({
				task: Type.String({ description: "Task description. Use {previous} to reference the previous step output." }),
				label: Type.Optional(Type.String({})),
				preset: Type.Optional(Type.String({})),
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
				preset: Type.Optional(Type.String({})),
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
				description: "Parallel tasks to execute concurrently. All tasks run regardless of individual failures. Max " + MAX_PARALLEL_TASKS + " tasks."
			})),
			graph: Type.Optional(Type.Array(Type.Object({
				id: Type.String({ description: "Unique identifier for this task node" }),
				task: Type.String({ description: "Task description. Use {otherId} to reference output from another task." }),
				label: Type.Optional(Type.String({})),
				dependsOn: Type.Optional(Type.Array(Type.String({}), { description: "IDs of tasks that must complete before this one starts" })),
				preset: Type.Optional(Type.String({})),
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
				description: "Declare tasks with dependencies. The scheduler parallelizes independent tasks and sequences dependent ones. Max " + MAX_GRAPH_TASKS + " tasks."
			})),
		}),

		async execute(
			_toolCallId: string,
			params: {
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
				template?: string;
				params?: Record<string, string>;
				retryRunId?: string;
				retryOnTimeout?: boolean;
				gitMode?: string;
				priority?: string;
				backend?: string;
				chain?: Array<{
					task: string;
					label?: string;
					preset?: string;
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
					preset?: string;
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
			},
			signal: AbortSignal | undefined,
			onUpdate: ((partial: AgentToolResult<SubagentResult>) => void) | undefined,
			ctx: ExtensionContext,
		) {
			// F1: Sanitize task input — skip for chain/parallel modes
			const hasChain = params.chain && params.chain.length > 0;
			const hasParallel = params.tasks && params.tasks.length > 0;
			const hasGraph = params.graph && params.graph.length > 0;
			if (!hasChain && !hasParallel && !hasGraph) {
				const taskResult = sanitizeTask(params.task);
				if (!taskResult.ok) {
					log.warn("Task rejected by sanitizer", { error: taskResult.error });
					return {
						content: [{ type: "text" as const, text: `Invalid task: ${taskResult.error}` }],
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
					log.warn("Retry run ID not found", { retryRunId: params.retryRunId });
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
						isError: true,
					};
				}
				return runParallelMode(params, signal, onUpdate, ctx);
			}

			if (isGraph) {
				return runGraphMode(params, signal, onUpdate, ctx);
			}

			// Phase 6.5: Background execution — spawn session and return ID immediately
			if (params.background) {
				const { spawnBackgroundSession } = await import('./session-manager');
				
				try {
					const agent = await spawnBackgroundSession(pi, ctx, {
						task: params.task,
						type: params.preset || 'general-purpose',
						description: params.label,
						thinkingLevel: (params.thinkingLevel as ThinkingLevel) || 'medium',
						systemPrompt: params.systemPrompt,
						cwd: params.cwd,
					});
					
					log.info("Background agent spawned", { agentId: agent.id, task: params.task });
					
					return {
						content: [{
							type: "text" as const,
							text: `Background agent started: ${agent.id}\n\n` +
								`Description: ${agent.description}\n` +
								`Task: ${agent.task}\n` +
								`Status: ${agent.status}\n\n` +
								`Use get_subagent_result({ agent_id: "${agent.id}" }) to check status and retrieve results.`,
						}],
					};
				} catch (err) {
					const message = err instanceof Error ? err.message : String(err);
					log.error("Failed to spawn background agent", { error: message });
					return {
						content: [{ type: "text" as const, text: `Failed to spawn background agent: ${message}` }],
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
			} = resolveSubagentParams(params, ctx);

			// E8: Resolve backend: per-call param > state config default
			const resolvedBackendName: string =
				(params.backend && AVAILABLE_BACKENDS.includes(params.backend))
					? params.backend
					: state.config.defaultBackend;
			const resolvedBackend: Backend | undefined = getBackend(resolvedBackendName);

			// F1: Validate CWD
			const cwdResult = validateCwd(effectiveCwd, ctx.cwd);
			if (!cwdResult.ok) {
				return {
					content: [{ type: "text" as const, text: `Invalid cwd: ${cwdResult.error}` }],
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
					isError: true,
				};
			}

			// H1: Pre-task validation — deterministic check that tools/thinking match task
			const validation = validatePreTask({
				task,
				toolOptions,
				thinkingLevel,
				gitMode: resolvedGitMode,
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
					}],
					isError: true,
				};
			}

			// Resolve model
			const modelResult = resolveSubagentModel(ctx);
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
				startedAt: new Date().toISOString(),
				originalParams: {
					systemPrompt: params.systemPrompt,
					inheritSystemPrompt: params.inheritSystemPrompt,
					thinkingLevel: params.thinkingLevel,
					outputFile: params.outputFile,
					timeout: params.timeout,
					cwd: params.cwd,
					tools: params.tools,
					excludeTools: params.excludeTools,
					noBuiltinTools: params.noBuiltinTools,
					preset: params.preset,
				},
			};
			state.persistRun(pi, run);

			// R2: Prune old run entries if history exceeds limit
			if (state.config.maxHistoryEntries > 0) {
				const p = pruneSessionRuns(ctx, state.config.maxHistoryEntries);
				if (p > 0) log.debug("Run history pruned", { pruned: p });
			}

			// Register for live monitor
			state.registerLiveSubagent(runId, {
				id: runId,
				label,
				task,
				model: run.model,
				thinkingLevel,
				startedAt: Date.now(),
				ctx,
			});

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
					isError: true,
				};
			}

			// Acquire concurrency slot
			const acquired = await acquireSlot(state, ctx, signal);
			if (!acquired) {
				cleanupGitBranch();
				return {
					content: [
						{
							type: "text" as const,
							text: "Subagent cancelled while waiting for concurrency slot.",
						},
					],
					isError: true,
				};
			}

			let success = false;
			try {
				// Build system prompt
				const basePrompt = ctx.getSystemPrompt();
				const subagentPrompt = buildSubagentPrompt(
					basePrompt,
					inheritSP,
					customSP,
					resolvedOutputFile,
					toolOptions?.tools,
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
				const liveOnUpdate = onUpdate
					? (partial: AgentToolResult<SubagentResult>) => {
							onUpdate(partial);
							if (partial.details) {
								state.updateLiveSubagent(
									runId,
									getFinalOutput(partial.details.messages),
									partial.details.usage.input,
									partial.details.usage.output,
								);
							}
						}
					: undefined;

				const childDepth = currentDepth + 1;

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
					undefined, // pool
					undefined, // intercom
					undefined, // subagentId
					resolvedBackend,
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
						undefined, // pool
						undefined, // intercom
						undefined, // subagentId
						resolvedBackend,
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
				if (state.config.maxHistoryEntries > 0) {
					const p = pruneSessionRuns(ctx, state.config.maxHistoryEntries);
					if (p > 0) log.debug("Run history pruned", { pruned: p });
				}

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

					return {
						content: [
							{ type: "text" as const, text: finalMsg },
						],
						details: result,
						isError: true,
					};
				}

				success = true;
				log.info("Subagent completed successfully", {
					runId,
					tokensIn: result.usage.input,
					tokensOut: result.usage.output,
					cost: result.usage.cost,
					sessionTotalCost: state.getSessionTotalCost(ctx),
				});

				// R1: Record success in circuit breaker
				state.recordSuccess();

				return {
					content: [
						{ type: "text" as const, text: finalOutput || "(no output)" },
					],
					details: result,
				};
			} catch (err) {
				// P3: Clean up git branch on crash
				cleanupGitBranch();

				const errorMessage =
					(err as Error).message || String(err);
				log.error("Subagent crashed", { runId, error: errorMessage });
				return {
					content: [
						{
							type: "text" as const,
							text: `Subagent crashed: ${errorMessage}`,
						},
					],
					details: {
						messages: [],
						usage: { ...EMPTY_USAGE },
						exitCode: 1,
						stderr: String(err),
						errorMessage,
					},
					isError: true,
				};
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
			theme: {
				fg: (color: string, text: string) => string;
				bold: (text: string) => string;
			},
			_context: unknown,
		) {
			return renderDelegateCall(args, theme);
		},

		renderResult(
			result: {
				content: Array<{ type: string; text: string }>;
				details?: SubagentResult;
			},
			options: { expanded: boolean },
			theme: {
				fg: (color: string, text: string) => string;
				bold: (text: string) => string;
			},
			_context: unknown,
		) {
			return renderDelegateResult(result, options, theme);
		},
	});

	// -------------------------------------------------------------------
	// get_subagent_result tool — poll background agent status
	// -------------------------------------------------------------------

	pi.registerTool({
		name: "get_subagent_result",
		label: "Get Subagent Result",
		description: [
			"Check the status of a background agent and retrieve its result.",
			"Use this tool to poll background agents spawned with delegate_task's background parameter.",
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
		execute: async (toolCallId, params) => {
			const { steerAgent } = await import('./session-manager');
			
			try {
				const agent = steerAgent(params.agent_id, params.message);
				
				if (!agent) {
					return {
						content: [{ type: "text" as const, text: `Agent ${params.agent_id} not found` }],
						isError: true,
					};
				}
				
				return {
					content: [{
						type: "text" as const,
						text: `Steered agent ${params.agent_id}: "${params.message.slice(0, 50)}${params.message.length > 50 ? '...' : ''}"`,
					}],
				};
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				return {
					content: [{ type: "text" as const, text: `Failed to steer agent: ${message}` }],
					isError: true,
				};
			}
		},
	});

	// -------------------------------------------------------------------
	// Session lifecycle — F7: Session-bound state initialization
	// -------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		// Load built-in presets
		const presetsDir = path.join(__dirname, "..", "presets");
		state.builtinPresets = loadBuiltinPresets(presetsDir, log);

		// R2: Clean stale temp dirs from previous sessions
		cleanupTempDirs(ctx.cwd).then((count) => {
			if (count > 0) log.info("Cleaned stale temp directories", { count });
		});

		log.info("Session started", {
			builtinPresets: state.builtinPresets.length,
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

		// E9: Initialize scheduler with delegate_task executor
		scheduler = new Scheduler(pi, log, async (task, config) => {
			// Fire-and-forget: execute a scheduled task via delegate_task flow
			const toolEntry = (pi as unknown as { _tools?: Map<string, { execute: Function }> })._tools?.get("delegate_task");
			if (toolEntry) {
				const params: Record<string, unknown> = { task };
				if (config.preset) params.preset = config.preset;
				if (config.thinkingLevel) params.thinkingLevel = config.thinkingLevel;
				try {
					await toolEntry.execute("scheduled", params, undefined, undefined, ctx);
				} catch (err) {
					log.error("Scheduled task delegate_task failed", {
						task: task.slice(0, 60),
						error: (err as Error).message,
					});
				}
			} else {
				log.warn("delegate_task tool not available for scheduled execution", {
					task: task.slice(0, 60),
				});
			}
		});
		scheduler.start();

		// E11: Pre-warm process pool if enabled
		if (state.config.poolEnabled) {
			log.info("Pre-warming process pool", { size: state.config.poolSize });
			pool = new ProcessPool(state.config.poolSize, 120_000, log);
			const modelResult = resolveSubagentModel(ctx);
			if (modelResult.ok) {
				const modelStr = `${modelResult.model.provider}/${modelResult.model.id}`;
				pool.preWarm(state.config.poolSize, ctx.cwd, modelStr, state.config.maxThinkingLevel)
					.catch((err) => {
						log.warn("Pool pre-warm failed", { error: (err as Error).message });
					});
			}
		}

		updateStatus(state, ctx);
	});

	// F7: Clean up session-bound state on shutdown
	pi.on("session_shutdown", async (_event, _ctx) => {
		log.info("Session shutting down", {
			activeSubagents: state.activeSubagents,
		});

		// E9: Stop the scheduler
		scheduler?.stop();
		scheduler = undefined;

		// E11: Shut down process pool
		if (pool) {
			pool.shutdown();
			pool = undefined;
		}

		// Clear all live subagent sessions
		state.subagentSessions.clear();
		// Reset counters
		state.activeSubagents = 0;
		state.completedSubagents = 0;
		state.failedSubagents = 0;
		state.unseenSubagents = 0;
		// Clear pending queue
		state.pendingQueue.length = 0;
	});
}

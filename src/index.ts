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
	SubTaskParams,
	SubTaskResult,
	ChainDetails,
	ParallelDetails,
	MultiSubagentDetails,
} from "./types";
import {
	resolveThinkingLevel,
	EMPTY_USAGE,
	getFinalOutput,
	isSubagentError,
	classifyError,
	MAX_CHAIN_STEPS,
	MAX_PARALLEL_TASKS,
	PREVIOUS_OUTPUT_PLACEHOLDER,
	type GitMode,
} from "./types";

import { sanitizeTask, validateCwd, validateOutputFile, stripAnsi, capOutput, getCurrentDepth } from "./sanitize";
import {
	getCurrentBranch,
	hasUncommittedChanges,
	createWorkBranch,
	captureDiff,
	switchToBranch,
	deleteBranch,
} from "./git";
import { preflightCheck } from "./preflight";
import { loadBuiltinPresets } from "./presets";
import { getPreset as getPresetFn } from "./tui";
import { createSessionState } from "./state";
import { buildSubagentPrompt, describePromptMode } from "./prompt";
import { runSubagent, cleanupTempDirs } from "./runner";
import { acquireSlot, releaseSlot, updateStatus, updateProgressStatus } from "./concurrency";
import {
	finalizeRunRecord,
	resolveRetryParams,
	createEmptyResult,
	pruneSessionRuns,
} from "./history";
import {
	showSelectList,
	showModelSelector,
	showThinkingSelector,
	showConcurrencyInput,
	showDepthInput,
	showHistoryEntriesInput,
	showCostLimitInput,
	showPresetManager,
	showConfigMenu,
	showRunHistory,
	showMonitor,
	showRetryMenu,
	renderDelegateCall,
	renderDelegateResult,
} from "./tui";
import { createLogger, type Logger } from "./logging";

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const log = createLogger("brl-subagent");

	// F7: Session-bound state — initialized per session
	let state = createSessionState(log);

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
		},
		ctx: ExtensionContext,
	): ResolvedParams & { resolvedGitMode: GitMode } {
		const preset = params.preset
			? getPresetFn(params.preset, state.builtinPresets, state.config.presets)
			: undefined;

		const mergedThinkingLevel =
			(params.thinkingLevel as ThinkingLevel | undefined) ?? preset?.thinkingLevel;
		const mergedSystemPrompt = params.systemPrompt ?? preset?.systemPrompt;
		const mergedInheritSP = params.inheritSystemPrompt ?? preset?.inheritSystemPrompt;
		const mergedOutputFile = params.outputFile ?? preset?.outputFile;
		const mergedTimeout = params.timeout ?? preset?.timeout;
		const mergedTools = params.tools ?? preset?.tools;
		const mergedExcludeTools = params.excludeTools ?? preset?.excludeTools;
		const mergedNoBuiltinTools = params.noBuiltinTools ?? preset?.noBuiltinTools;

		const mergedGitMode = (params.gitMode as GitMode | undefined) ?? preset?.name;
		const resolvedGitMode: GitMode =
			mergedGitMode === "branch" || mergedGitMode === "none"
				? mergedGitMode
				: state.config.gitMode;

		const thinkingLevel = resolveThinkingLevel(
			mergedThinkingLevel,
			state.config.maxThinkingLevel,
		);

		const toolOptions: SubagentToolOptions | undefined =
			mergedTools || mergedExcludeTools || mergedNoBuiltinTools
				? {
						tools: mergedTools,
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
		globalParams: ResolvedParams & { resolvedGitMode: GitMode },
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
	} {
		const mergedThinkingLevel = subTask.thinkingLevel
			? resolveThinkingLevel(
					subTask.thinkingLevel as ThinkingLevel,
					state.config.maxThinkingLevel,
				)
			: globalParams.thinkingLevel;

		const mergedTools = subTask.tools ?? globalParams.toolOptions?.tools;
		const mergedExcludeTools = subTask.excludeTools ?? globalParams.toolOptions?.excludeTools;
		const mergedNoBuiltinTools =
			subTask.noBuiltinTools ?? globalParams.toolOptions?.noBuiltinTools;

		const mergedToolOptions: SubagentToolOptions | undefined =
			mergedTools || mergedExcludeTools || mergedNoBuiltinTools
				? {
						tools: mergedTools,
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
							`Complete the task directly or ask the user to increase the limit via /brl-subagent.`,
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

		// Acquire concurrency slot for the chain
		const acquired = await acquireSlot(state, ctx, signal);
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
							`Complete the task directly or ask the user to increase the limit via /brl-subagent.`,
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

		// Launch all tasks concurrently using acquireSlot for natural concurrency limiting
		const promises = taskList.map(async (_, index) => {
			const acquired = await acquireSlot(state, ctx, signal);
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
	// /brl-subagent command
	// -------------------------------------------------------------------

	pi.registerCommand("brl-subagent", {
		description: "Configure subagent model and thinking level",
		getArgumentCompletions: (prefix: string) => {
			const options = [
				"model", "thinking", "concurrency", "depth", "gitmode", "costlimit", "reset",
				"history", "historyentries", "monitor", "preset", "retry",
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
				gitmode: () => showGitModeSelector(ctx, state, applyConfig),
				costlimit: () => showCostLimitInput(ctx, state, applyConfig),
				reset: () => resetState(ctx),
				history: () => showRunHistory(ctx, state, () => state.persistState(pi)),
				historyentries: () => showHistoryEntriesInput(ctx, state, applyConfig),
				monitor: () => showMonitor(ctx, state),
				preset: () => showPresetManager(ctx, state, () => state.persistState(pi)),
				retry: () => showRetryMenu(ctx, state),
			};

			if (trimmed && trimmed in handlers) {
				await handlers[trimmed]();
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
		],
		parameters: Type.Object({
			task: Type.String({
				description: "Detailed description of the task for the subagent to complete",
			}),
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
				retryRunId?: string;
				retryOnTimeout?: boolean;
				gitMode?: string;
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
			if (!hasChain && !hasParallel) {
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

			// P1+P2: Mode detection — chain > parallel > single
			const isChain = hasChain;
			const isParallel = hasParallel;
			const isSingle = typeof params.task === "string" && params.task.length > 0;

			const modeCount = [isChain, isParallel, isSingle].filter(Boolean).length;
			if (modeCount !== 1) {
				return {
					content: [
						{
							type: "text" as const,
							text:
								"Provide exactly one of: task (single), chain (sequential), or tasks (parallel).",
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
								`Complete the task directly or ask the user to increase the limit via /brl-subagent.`,
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
			} = resolveSubagentParams(params, ctx);

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

				// Run the subagent
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
						// Best-effort delete work branch
						deleteBranch(resolvedCwd, workBranchName);
						workBranchName = undefined; // Prevent double-cleanup
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

					// R1: Record failure in circuit breaker
					state.recordFailure();

					return {
						content: [
							{ type: "text" as const, text: `Subagent failed: ${errorMsg}` },
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

		updateStatus(state, ctx);
	});

	// F7: Clean up session-bound state on shutdown
	pi.on("session_shutdown", async (_event, _ctx) => {
		log.info("Session shutting down", {
			activeSubagents: state.activeSubagents,
		});

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

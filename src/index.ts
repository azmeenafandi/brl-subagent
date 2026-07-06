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
} from "./types";
import {
	resolveThinkingLevel,
	EMPTY_USAGE,
	getFinalOutput,
	isSubagentError,
	classifyError,
} from "./types";

import { sanitizeTask, validateCwd, validateOutputFile, stripAnsi, capOutput, getCurrentDepth } from "./sanitize";
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
		},
		ctx: ExtensionContext,
	): ResolvedParams {
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
	// /brl-subagent command
	// -------------------------------------------------------------------

	pi.registerCommand("brl-subagent", {
		description: "Configure subagent model and thinking level",
		getArgumentCompletions: (prefix: string) => {
			const options = [
				"model", "thinking", "concurrency", "depth", "reset",
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
			retryOnTimeout: Type.Optional(
				Type.Boolean({
					description:
						"If true and the subagent times out, automatically retry with the same parameters. " +
						"Only retries once — the second timeout is treated as a final failure.",
				}),
			),
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
			},
			signal: AbortSignal | undefined,
			onUpdate: ((partial: AgentToolResult<SubagentResult>) => void) | undefined,
			ctx: ExtensionContext,
		) {
			// F1: Sanitize task input
			const taskResult = sanitizeTask(params.task);
			if (!taskResult.ok) {
				log.warn("Task rejected by sanitizer", { error: taskResult.error });
				return {
					content: [{ type: "text" as const, text: `Invalid task: ${taskResult.error}` }],
					isError: true,
				};
			}
			params.task = taskResult.value;

			// Handle retryRunId
			if (params.retryRunId) {
				const runEntry = state.findRunById(ctx, params.retryRunId);
				if (runEntry) {
					params = resolveRetryParams(params, runEntry);
				} else {
					log.warn("Retry run ID not found", { retryRunId: params.retryRunId });
				}
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

			// Resolve model
			const modelResult = resolveSubagentModel(ctx);
			if (!modelResult.ok) return modelResult.error;
			const subagentModel = modelResult.model;

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

			// Acquire concurrency slot
			const acquired = await acquireSlot(state, ctx, signal);
			if (!acquired) {
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
				});

				return {
					content: [
						{ type: "text" as const, text: finalOutput || "(no output)" },
					],
					details: result,
				};
			} catch (err) {
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

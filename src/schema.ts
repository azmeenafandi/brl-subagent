// Purpose: The registered `delegate_task` parameter schema — the single source of truth for its types.
/**
 * delegate_task parameter schema — the SINGLE source of truth (issue #239).
 * index.ts registers this object; DelegateTaskParams (types.ts) is
 * Static<typeof delegateTaskParamsSchema>, so schema and types cannot drift.
 */
import { Type } from "typebox";
import { MAX_CHAIN_STEPS, MAX_PARALLEL_TASKS, MAX_GRAPH_TASKS } from "./types";

export const delegateTaskParamsSchema = Type.Object({
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
						"If exceeded, the subagent is killed and an error is returned. " +
						"Background runs default to a 30-minute deadline when no timeout is given; an explicit timeout is honored as given (30 minutes is a default, not a ceiling). A raw value ≥ 2^31-1 normalizes to the default.",
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
						"The retry rebuilds the parameter object from a fixed field set, falling back to the " +
						"original run's recorded values, with explicit values on this call winning: task, label, " +
						"model, preset, systemPrompt, inheritSystemPrompt, thinkingLevel, priority, outputFile, " +
						"timeout, cwd, tools, excludeTools, noBuiltinTools, background, gitMode, approvalMode, force. " +
						"The execution-shape fields ARE restored: a retried background run stays background (with its " +
						"completion wake), and a retried branch-mode run keeps its work branch, its approvalMode " +
						"gating and its force override. Qualify that by the effective gitMode - when neither the record " +
						"nor this call carries one, the configured default applies, which may still be 'branch'. " +
						"Not restored: chain/tasks/graph and params, so a retried multi-step run silently degrades to a " +
						"single task - re-issue it fresh. retryOnTimeout is explicit-only: never restored, honoured when passed. " +
						"template is asymmetric: the original's template is NOT restored, but a template passed on the " +
						"retry call DOES take effect (it is resolved before the retry merge). " +
						"Fan-out units (parallel/chain/graph origin) record no background, so retrying one is a single " +
						"foreground run - pass background: true for a background retry. " +
						"Only works with runs that ended in failure (exitCode != 0, timeout, error, or abort).",
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
						"If true and a FOREGROUND subagent times out, automatically retry with the same parameters. " +
						"Only retries once — the second timeout is treated as a final failure. " +
						"Background runs are not auto-retried; re-dispatch with retryRunId.",
				}),
			),
			approvalMode: Type.Optional(
				Type.String({
					description:
						"Change approval mode: auto (never ask), writes (ask when files changed), " +
						"always (ask every time). Default is user config (/brl-subagent approval).",
				}),
			),
			force: Type.Optional(
				Type.Boolean({
					description:
						"Override for capability pre-flight errors (default false). A dispatch is blocked when the task clearly needs a capability the resolved toolset lacks — " +
						"a run/execute/test/compile/benchmark task with no bash, or an exploration task (search/grep/find/list/locate/glob) with none of find/ls/grep/bash. " +
						"Set force: true to dispatch anyway: the mismatch is then delivered as a warning in the result instead of rejecting the call. " +
						"Warnings are surfaced either way. force never suppresses outputFile-without-write conflicts.",
				}),
			),
			background: Type.Optional(
				Type.Boolean({
					description:
						"Run the subagent in the background without blocking the conductor. " +
						"When true, the tool returns immediately with an agent ID. " +
						"The conductor is woken with a completion message; use get_subagent_result for post-wake retrieval and stall checks. " +
						"Supports a single task or the tasks array (a fan-out that starts one background agent per task; with tasks the call returns one ID per task and the conductor is woken once per agent as each finishes); combining background with chain or graph is rejected. " +
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
				task: Type.String({ description: "Task description. Use {<nodeId>} to reference output from another task (the referenced node's own id, which must be a word-character id - letters, digits, underscore; ids like 'step-1' or 'node.a' are not matched and the braces are left as literal text)." }),
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
		});

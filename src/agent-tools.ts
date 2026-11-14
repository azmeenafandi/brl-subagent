// Purpose: The three agent-lifecycle tools (get_subagent_result, steer_subagent, stop_subagent) as definitions, returned to the composition root to register.
/**
 * brl-subagent — the agent tools (ADR 0027 S5, issue #483)
 *
 * The three `pi.registerTool({ … })` literals that let the conductor act on a
 * BACKGROUND run — read its result, steer it, stop it — move here. The
 * registrations do not (D7): `index.ts` iterates what this factory returns and
 * calls `pi.registerTool` on each, so `index.ts` remains the one place where the
 * tool surface is registered.
 *
 * **No context parameter.** Unlike `createCommands` and `createDelegateHandler`,
 * these three tools read nothing from the runtime: the session manager and the
 * transcript store are reached by dynamic `import(...)` inside each `execute`
 * (the timing that keeps session-manager's lifecycle mutators lazy), and the
 * status formatting comes from `notify-completion.ts` / `transcript-path.ts`.
 * An unused `rt` parameter would be a binding with no consumer — the rule
 * ADR 0027 F1 states for the runtime context, applied to the deps seam.
 *
 * Each definition goes through the module-local `defineTool` identity helper
 * rather than being annotated `ToolDefinition`: the annotation's `TParams`
 * defaults to `TSchema`, which widens `params` inside `execute` to `unknown` and
 * takes the `agent_id`/`message` access with it. The helper does what pi's
 * exported `defineTool` does — infer `TParams` from the inline `Type.Object` and
 * hand the definition back — but it is LOCAL because pi's is a RUNTIME import
 * from `@earendil-works/pi-coding-agent`, and this repo's suites stub that
 * package to the two symbols their renderer path needs. A runtime import of a
 * third symbol would make every one of those suites fail to collect. A
 * type-level annotation needs no import at all; a value-level identity function
 * needs one call site fewer than rewriting the schemas into named consts.
 */

import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type, type TSchema } from "typebox";
import { formatBudgetLine, normalizeCompletionStatus } from "./notify-completion";
import { sanitizeErrorMessage } from "./sanitize";
import { transcriptDisplayPath } from "./transcript-path";

/**
 * Identity helper over `ToolDefinition` that PRESERVES the schema's inference:
 * `TParams` comes from the `parameters` property, so `execute` keeps the params
 * object its inline `Type.Object` describes. See the header for why this is
 * local rather than pi's exported `defineTool`.
 */
function defineTool<TParams extends TSchema, TDetails = unknown>(
	tool: ToolDefinition<TParams, TDetails>,
): ToolDefinition<TParams, TDetails> {
	return tool;
}

/**
 * `ToolDefinition<any, any, any>` is pi's own `AnyToolDefinition` alias (not
 * exported from the package): the element type of a heterogeneous MANY-tool
 * list. Naming the three schema/details pairs instead would make the array
 * invariant per member — `renderCall`'s `Static<TParams>` is contravariant — so
 * the three definitions could not share one return type at all.
 */
/**
 * Build the three agent-tool definitions. Stateless and cheap: the factory is a
 * definition assembler, so it may be called per invocation without consequence
 * (the cost of the old inline literals, and nothing more).
 */
export function createAgentTools(): ToolDefinition<any, any, any>[] {
	const getSubagentResultTool = defineTool({
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

	const steerSubagentTool = defineTool({
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

	const stopSubagentTool = defineTool({
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
	return [getSubagentResultTool, steerSubagentTool, stopSubagentTool];
}

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

import type { StoppedAttempt } from "./stop-lineage";
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
			"Stop a background agent by aborting its session.",
			"A stop is DISPATCH-scoped: it stops the agent you name AND every automatic transport retry of the same dispatch that is still running, because a retried run continues the same work under a different id.",
			"A manual retry (one you started yourself) is never stopped by a stop aimed at another attempt — pass its own id to stop it.",
			"Accepts a full agent id or a unique 8-character id prefix; an ambiguous prefix stops nothing.",
			"The report names every attempt it acted on (id, attempt, cause) and discloses anything left running, an armed retry, or a truncated lineage scan.",
			"An already-terminal dispatch is a no-op success.",
		].join(" "),
		parameters: Type.Object({
			agent_id: Type.String({
				description: "The agent ID to stop",
			}),
		}),
		execute: async (toolCallId, params, _signal, _onUpdate, ctx) => {
			try {
				const report = await runDispatchStop(params.agent_id, ctx);
				return {
					content: [{ type: "text" as const, text: report.text }],
					details: undefined,
					...(report.isError ? { isError: true } : {}),
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

/**
 * Issue #616 — the stop contract, as one function: **resolve → plan → cancel an
 * armed retry → stop each live attempt → verify from the records → report**.
 *
 * Separated from the tool definition so the tool stays the adapter it is for the
 * other two lifecycle tools, and every step below is greppable by name.
 *
 * SCOPE (the brief's Contract): the requested id — always — plus every attempt of
 * the same dispatch whose recorded `retryCause` is `transport`. A `manual` retry
 * is disclosed residue, never stopped by scope; an attempt whose cause is ABSENT
 * is unknown and equally untouched. Naming a manual retry's own id DOES stop it
 * (it is the requested id, and `retryCause` is a filter, not an immunity).
 *
 * Never prints a universal claim over a partial answer: an armed retry, an
 * unknown cause, or a truncated lineage scan each get their own disclosure line
 * instead, and the claim itself is suppressed.
 */
async function runDispatchStop(
	rawId: string,
	ctx: { cwd?: string } | undefined,
): Promise<{ text: string; isError: boolean }> {
	const {
		getAgent,
		resolveAgentId,
		findRetryLineage,
		readAgentRecordFromDisk,
		stopAgent,
	} = await import('./session-manager');
	const { planDispatchStop, formatStopReport } = await import('./stop-lineage');
	const { readArmedRetry, cancelArmedRetry } = await import('./retry-armed');
	const { isTerminalAgentStatusValue } = await import('./types');

	// The notices render the first 8 hex characters of an id, and labels are
	// shared across attempts (that IS #616) — so resolve a prefix exactly as
	// `get_subagent_result` does, and fail closed on ambiguity: a guess here could
	// stop the wrong dispatch.
	const resolution = resolveAgentId(rawId);
	if (resolution.kind === 'ambiguous') {
		return {
			text: `Agent id prefix "${rawId}" is ambiguous — matches: ${resolution.matches.join(', ')}. Nothing was stopped.`,
			isError: true,
		};
	}
	if (resolution.kind === 'unresolved') return { text: `Agent ${rawId} not found`, isError: true };
	const agentId = resolution.id;

	// The record read is deliberately NOT windowed: the stop must act on a run
	// that exists, not on what the (bounded) lineage scan could see.
	const agent = getAgent(agentId);
	if (!agent) return { text: `Agent ${rawId} not found`, isError: true };

	const armedFor = (family: Array<{ id: string }>) => {
		const ids = new Set<string>([agentId, ...family.map((record) => record.id)]);
		return [...ids]
			.map((id) => readArmedRetry(id))
			.filter((marker): marker is NonNullable<typeof marker> => marker !== null);
	};

	// Plan 1 — computed BEFORE any cancel, so the armed markers are still there.
	const firstLineage = findRetryLineage(agentId, agent);
	let plan = planDispatchStop({
		targetId: agentId,
		lineage: firstLineage,
		armed: armedFor(firstLineage.family),
		nowMs: Date.now(),
	});

	const cancels: Array<{
		armed: (typeof plan.armed)[number];
		outcome: Awaited<ReturnType<typeof cancelArmedRetry>>;
	}> = [];
	for (const marker of plan.armed) {
		cancels.push({ armed: marker, outcome: cancelArmedRetry(marker.parentId, marker.attempt) });
	}

	// A cancel that found NO marker means the retry became durable between the read
	// and the cancel: the spawn's pre-prompt gate cleared the marker, so the retry
	// now HAS a record. Re-read the lineage ONCE and stop it like any other live
	// attempt rather than reporting an armed retry that no longer exists.
	if (cancels.some((cancel) => cancel.outcome === 'gone')) {
		const reLineage = findRetryLineage(agentId, agent);
		plan = planDispatchStop({
			targetId: agentId,
			lineage: reLineage,
			armed: armedFor(reLineage.family),
			nowMs: Date.now(),
		});
	}

	const stopped: StoppedAttempt[] = [];
	for (const record of plan.live) {
		let thrown: string | undefined;
		try {
			// SEQUENTIAL, one contained try per attempt: a throw must not hide the
			// next run's stop, nor the evidence the report is built from.
			await stopAgent(record.id);
		} catch (err) {
			thrown = sanitizeErrorMessage(err instanceof Error ? err.message : String(err), ctx?.cwd);
		}
		// THE VERDICT IS THE STORE'S, not the primitive's return value: `stopAgent`
		// returns a terminal record UNCHANGED, so "already dead" and "just stopped"
		// are the same answer — the record is what can tell them apart.
		const after = readAgentRecordFromDisk(record.id);
		const status = after.record?.status;
		const verified = status !== undefined && isTerminalAgentStatusValue(status);
		const storeState = after.record
			? `status ${after.record.status}`
			: after.exists
				? `record ${after.reason ?? 'unreadable'}`
				: 'no record';
		stopped.push({
			record,
			description: after.record?.description ?? getAgent(record.id)?.description,
			verifiedStatus: verified ? (status as NonNullable<typeof status>) : null,
			unverifiedState: verified
				? undefined
				: thrown
					? `${storeState}; stopAgent threw: ${thrown}`
					: storeState,
		});
	}

	return formatStopReport({ plan, stopped, cancels });
}

// Purpose: The terminal notifier — the terminal event-bus subscriptions, their per-instance release latch, and the completion alert with its transport auto-retry.
/**
 * brl-subagent — the terminal notifier (cycle S4, ADR 0027 D3/D5/D6)
 *
 * The `terminalTypes` table, the three event-bus subscriptions, their release
 * latch (`terminalSubscriptions` / `terminalSubscriptionsReleased` /
 * `releaseTerminalSubscriptions`), `scheduleTransportRetry`, its resume-preamble
 * builder and `deliverCompletionAlert` used to be closures inside
 * `src/index.ts`'s default export. They move here verbatim.
 *
 * D3: this module may import the `src/*.ts` modules it needs, and NOT the
 * composition root. The three bindings the moved bodies read from their old
 * closure (`pi`, `log`, `state`) arrive as the `RuntimeContext` argument, and the
 * two capabilities the moved bodies cannot reach from here arrive as `deps`:
 *
 *   - `getSession` is ADR 0027 D2. `sessionCtx` is written by `session_start` and
 *     stays a `let` in `index.ts`; the event-bus listener receives no ctx, so the
 *     composition root hands over a getter and every read site keeps its timing
 *     (the alert resolves the context AFTER the terminal claim, as before).
 *   - `spawnBackgroundRun` is the ONE backward edge (D6): the transport-retry path
 *     re-dispatches through the S3 background pipeline's spawn, which the
 *     composition root passes in. The field's signature mirrors
 *     `BackgroundPipeline["spawnBackgroundRun"]`; the wiring hands over that exact
 *     function, so a drift between the two is a compile error at the seam.
 *
 * D5: the subscription array and the released flag are factory-scoped, never
 * module-private. A module-private latch would be shared by two `initExtension`
 * instances, so one runtime's shutdown could unhook the other's listeners — or
 * mark them released and never unhook them at all (the two-factory blocker:
 * `a=1, b=0` where `b` should be 1).
 *
 * The move is verbatim. `createTerminalNotifier` destructures its context on its
 * first lines and the bodies carry their original indentation, so a body line that
 * differs from 91b286d is a bug in this commit, not a refactor. The three
 * non-verbatim pieces are named in the PR: the factory wrapper (`rt`/`deps`
 * destructure + the `return`), `getSession()` replacing the `sessionCtx` read, and
 * `buildRetryResumePreamble` moving with its only caller.
 *
 * Issue #511 (U3) edits the one exception to that verbatim rule, and says so: the
 * resume-preamble builder is no longer byte-identical to 91b286d (its bank path
 * became the run's own `<scratchDir>/bank.md`), and it was hoisted to module
 * scope — it reads no factory state — so the path logic could be unit-tested over
 * a disposable run directory instead of through a spawned child.
 */

import type { RuntimeContext } from "./runtime";
import type { DelegateTaskParams, SubagentEvent, SubagentEventListener, SubagentRun, ToolResult } from "./types";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import { isAbsolute, join } from "node:path";
import * as eventBus from "./event-bus";
import { resolveRetryParams } from "./history";
import {
	buildCompletionMessage,
	claimTerminalNotice,
	resolveDelivery,
	resolveRunEntry,
	sendCompletionNotification,
	withWorktreeState,
} from "./notify-completion";
import { bankPath, resolveRoot, RUNS_DIR, type RootOptions } from "./scratch-root";
import { isTransportRetryable, TRANSPORT_RETRY_TOAST } from "./transport-retry";
import { describeWorktreeState } from "./worktree-report";

/**
 * The capabilities the moved bodies cannot reach from this module. Function fields
 * only — no data crosses this seam (ADR 0027 D3/F2).
 */
interface TerminalNotifierDeps {
	/**
	 * ADR 0027 D2: `sessionCtx` stays a `let` in the composition root
	 * (`getSession: () => sessionCtx`). Read at the same spot the closure read the
	 * binding (`deliverCompletionAlert`), so the capture timing is unchanged.
	 */
	getSession: () => ExtensionContext | undefined;
	/**
	 * ADR 0027 D6: the ONE backward edge — the S3 pipeline's spawn, handed in by
	 * the composition root. Typed as that function so the wiring cannot pass a
	 * lookalike.
	 */
	spawnBackgroundRun: (
		pi: ExtensionAPI,
		ctx: ExtensionContext,
		params: (DelegateTaskParams & { noJev?: string }) | ReturnType<typeof resolveRetryParams>,
		singleTask: string,
		retrySourceRun?: SubagentRun,
		attemptContext?: string,
	) => Promise<ToolResult<undefined>>;
}

/**
 * What the composition root consumes: `release` is the shutdown hook (issue
 * #437). Declared (not exported) for the same reason as the background
 * pipeline's interface — the factory's return value IS the interface.
 */
interface TerminalNotifier {
	release: () => void;
}

/**
 * Where the bank pointer's two filesystem questions are answered, injected by
 * the tests: `exists` lets a unit test stand a run directory up somewhere
 * disposable, and `root` moves the resolver's layout off the real home. Neither
 * is needed in production, so both default to the real thing.
 */
export interface RetryPreambleOptions {
	/** Injectable existence probe; defaults to `fs.existsSync`. */
	exists?: (path: string) => boolean;
	/** Root-resolution inputs (`home` is the one that moves the layout); defaults to `resolveRoot()`. */
	root?: RootOptions;
}

/** A run id is ONE path segment — the resolver's id rule, restated where the path is joined. */
function isPathSegment(id: string): boolean {
	return id !== "" && id !== "." && id !== ".." && !id.includes("/") && !id.includes("\\");
}

/**
 * The run's own directory — the durable record's `scratchDir` when it has one,
 * otherwise `<root>/runs/<id>` recomputed. The crash-time in-flight registry
 * carries no `scratchDir` (U2 of #511), and the path is deterministic from the
 * run id, so a registry-only retry still names the right directory. The
 * fallback is a recomputation, never a system-temp path: a bank in `/tmp` is
 * the defect `scratch-root.ts` exists to remove.
 */
function runDirectoryOf(run: SubagentRun, options: RetryPreambleOptions): string | undefined {
	// A stored path is only usable if it is ABSOLUTE: the retry child can run in a
	// different cwd (worktree/branch mode), so a relative bank path would resolve
	// somewhere else — the same rule the recomputed half enforces on the id.
	if (run.scratchDir !== undefined) return isAbsolute(run.scratchDir) ? run.scratchDir : undefined;
	if (!isPathSegment(run.id)) return undefined;
	try {
		const resolved = resolveRoot(options.root);
		return resolved.ok ? join(resolved.root, RUNS_DIR, run.id) : undefined;
	} catch {
		// `resolveRoot` reports rather than throws; a host whose home cannot be read
		// at all (`os.homedir()` can raise) lands here. A prompt line is never worth a
		// throw, so the sentence is simply dropped.
		return undefined;
	}
}

/**
 * The bank's absolute path, or `undefined` when the run's directory is not
 * really there. The gate is the same one the retained-session pointer uses, for
 * the same reason: a legacy run (no `scratchDir`, no computed directory) and a
 * pruned run must get no bank sentence at all rather than a dead path.
 */
function bankPointer(run: SubagentRun, options: RetryPreambleOptions): string | undefined {
	const exists = options.exists ?? fs.existsSync;
	const runDir = runDirectoryOf(run, options);
	return runDir !== undefined && exists(runDir) ? bankPath(runDir) : undefined;
}

/**
 * Issue #401/#411: the resume preamble a transport auto-retry builds and delivers
 * as a `<resume-context>` section on the child's system prompt — never inside
 * the `<task>` fence. A dropped connection costs the child its context, not its
 * files: the retry spawns into the same directory, so the work it already did
 * (commits, written files, a bank) is still there. The preamble turns a blind
 * replay into a resume by naming what to inspect first.
 *
 * Issue #511 (U3): the bank is the run's OWN file — `<runDir>/bank.md` under the
 * shipped scratch root — named by its absolute path, and named only when the run
 * directory exists. The pre-#511 `/tmp/brl-<label>-bank.md` convention (and the
 * label sanitisation that existed only to build that filename) is gone: the path
 * is id-based, so a label cannot reach it, and nothing in this builder points at
 * a system temp directory.
 *
 * Kept bounded (5 lines max) and deliberately vetted for runtime vocabulary —
 * it is prompt text a user can see in the child's system prompt.
 *
 * Issue #404: it also names the retained SDK session directory when one exists.
 * That is the only artifact that holds attempt 1's CONVERSATION — the output log
 * is a start/steering stub — and the settle path retains it for exactly this
 * class of run. The pointer is absolute and computed conductor-side at build
 * time: the retry's child can run in a different cwd (worktree/branch mode), so
 * a relative path would point at the wrong tree. The exists gate is deliberate:
 * an attempt whose session was not retained (size floor, marker failure, a
 * legacy run) gets the bank-only preamble, never a dead path.
 *
 * A pure function at module scope on purpose: it reads no runtime context and no
 * factory state, which is what lets it be unit-tested over a disposable run
 * directory instead of through a spawned child.
 */
export function buildRetryResumePreamble(
	run: SubagentRun,
	nextAttempt: number,
	retainedSessionDir?: string,
	options: RetryPreambleOptions = {},
): string {
	const bank = bankPointer(run, options);
	const lines = [
		`[attempt ${nextAttempt} — the previous attempt (${run.id}) died on a transport failure.`,
		"This directory may already contain its uncommitted edits.",
		bank === undefined
			? "Before acting, inspect: `git status --short` and `git log --oneline -8`."
			: `Before acting, inspect: \`git status --short\`, \`git log --oneline -8\`, and the progress bank at ${bank} if it exists.`,
		"Continue from what exists; do NOT redo committed, written, or banked work.]",
	];
	if (retainedSessionDir) {
		// Insert before the closing line so the block still reads as one unit.
		lines.splice(
			lines.length - 1,
			0,
			`The previous attempt's session is retained at ${retainedSessionDir} — read the newest .jsonl inside (ISO-prefixed names sort lexicographically) to recover what it had worked out.`,
		);
	}
	return lines.join("\n");
}

/**
 * Build the terminal notifier over one runtime context (ADR 0027 D1/D3).
 *
 * Subscribing happens HERE, when the composition root calls this factory, which
 * is the same point in `initExtension` the closure subscribed at — the bus sees
 * the same registration order, and every subscription keeps its exact listener
 * identity so `release` can remove precisely this instance's three.
 */
export function createTerminalNotifier(rt: RuntimeContext, deps: TerminalNotifierDeps): TerminalNotifier {
	const { pi, log, state } = rt;
	const { getSession, spawnBackgroundRun } = deps;

	// -------------------------------------------------------------------
	// Issue #147: completion-push wake — subscribe to terminal event-bus events
	// -------------------------------------------------------------------
	// The event-bus is the complete terminal chokepoint (subagent:completed /
	// subagent:failed / subagent:stopped), so the conductor is woken via
	// pi.sendMessage + triggerTurn when a background run reaches a terminal state.
	// Delivery is always-on (minimum nextTurn); the completionNotify knob controls
	// the WAKE (D1+D2 — see notify-completion.ts). The shared terminal claim
	// (issue #315) defends the pathological double-emit path (first terminal
	// event or crash notice per id wins); it is capped simply (cleared when it
	// exceeds 200 entries).
	//
	// Stopped-run degradation — ACCEPTED BY DESIGN (review #2, adjudicated
	// 2026-09-01): subagent:stopped fires at stop time (updateAgentStatus) BEFORE
	// finalizeRunEntry stamps cost/duration/errorCategory and before finalOutput
	// is captured. So the stopped shape may lack those fields and the run entry
	// resolveRunEntry returns may be the pre-finalize spawn entry. The wake is
	// the point; details are best-effort — the notification must never throw or
	// block on their absence.
	const terminalTypes = ["subagent:completed", "subagent:failed", "subagent:stopped"] as const;

	// Issue #437: keep the EXACT listener references this factory instance owns.
	// Anonymous subscriptions could never be released, so a shut-down runtime's
	// listeners stayed on the shared bus forever. Ownership is per factory
	// invocation: the array and the released flag are this runtime's alone, so a
	// replacement's listeners are never in the removal set.
	const terminalSubscriptions: Array<{
		type: (typeof terminalTypes)[number];
		listener: SubagentEventListener;
	}> = [];
	let terminalSubscriptionsReleased = false;

	/**
	 * Issue #437: unsubscribe exactly the listeners registered above.
	 *
	 * Idempotent — a repeated/double `session_shutdown` (or a late one after the
	 * replacement runtime is already live) is a no-op. Synchronous, so it can run
	 * as the first statement of `session_shutdown`, before any await or fallible
	 * cleanup. Never touches another subscriber or another runtime's listeners.
	 */
	function releaseTerminalSubscriptions(): void {
		if (terminalSubscriptionsReleased) return;
		terminalSubscriptionsReleased = true;
		for (const { type, listener } of terminalSubscriptions) {
			eventBus.off(type, listener);
		}
		terminalSubscriptions.length = 0;
	}

	for (const type of terminalTypes) {
		const listener: SubagentEventListener = (event) => {
			void deliverCompletionAlert(event);
		};
		terminalSubscriptions.push({ type, listener });
		eventBus.on(type, listener);
	}

	/**
	 * Issue #365: re-dispatch a background run that settled with a transport-class
	 * failure, using the `retryRunId` machinery. `resolveRetryParams({}, run)`
	 * restores the recorded params and `spawnBackgroundRun(..., run)` mints the
	 * lineage (`resumeOf` + `attempt: 2`), so the retry re-runs the normal gates
	 * (cost, approval, pre-task) and is visible in the record.
	 *
	 * Issue #401/#411: the retry carries a resume preamble (`attemptContext`) that
	 * is injected into the child's system prompt only (as a `<resume-context>`
	 * section), never inside the `<task>` fence. The task handed to
	 * `resolveSubagentParams` stays the recorded original, so auto-routing, H1
	 * keyword warnings and the capability checks behave exactly as they did on
	 * attempt 1.
	 *
	 * Returns TRUE when the retry was actually spawned — the caller then SUPPRESSES
	 * the source run's completion notice, because the retry's own terminal settle
	 * is the wake. A gate rejection or a throwing spawn returns FALSE and the
	 * caller reports the original failure exactly as before (no silent drop).
	 *
	 * Issue #439: this reads only `isError`, and a retry whose post-spawn tail
	 * faulted is still a SUCCESSFUL spawn (`isError: false`, degraded monitoring).
	 * It therefore returns TRUE for it: the source notice stays suppressed and the
	 * degraded advisory is the signal that the retry started with degraded
	 * monitoring. Reading a contained tail failure as "did not start" would
	 * surface the source failure for a run that is live.
	 */
	async function scheduleTransportRetry(
		ctx: ExtensionContext,
		run: SubagentRun,
	): Promise<boolean> {
		const sourceAttempt = run.attempt ?? 1;
		try {
			const retryParams = resolveRetryParams({}, run);
			// Issue #404: point at the retained session ONLY when it is really
			// there. Resolve this conductor-side: the child may run in another cwd.
			// An invalid id cannot have a session dir (and `backgroundSessionDir`
			// throws on one) — no pointer, no throw.
			let retainedSessionDir: string | undefined;
			try {
				const { retainedSessionPointer } = await import('./session-manager');
				const candidate = retainedSessionPointer(run.id);
				if (fs.existsSync(candidate)) retainedSessionDir = candidate;
			} catch {
				retainedSessionDir = undefined;
			}
			const result = await spawnBackgroundRun(
				pi,
				ctx,
				retryParams,
				retryParams.task!,
				run,
				buildRetryResumePreamble(run, sourceAttempt + 1, retainedSessionDir),
			);
			if (result.isError) {
				log.warn("Transport auto-retry spawn rejected — surfacing the original failure", {
					sourceId: run.id,
					attempt: sourceAttempt,
					error: result.content[0]?.type === "text" ? result.content[0].text : undefined,
				});
				return false;
			}
		} catch (err) {
			log.warn("Transport auto-retry spawn failed — surfacing the original failure", {
				sourceId: run.id,
				attempt: sourceAttempt,
				error: (err as Error).message,
			});
			return false;
		}
		log.info("Background run settled — transport auto-retry scheduled", {
			sourceId: run.id,
			attempt: sourceAttempt + 1,
		});
		ctx.ui.notify(TRANSPORT_RETRY_TOAST, "warning");
		return true;
	}

	async function deliverCompletionAlert(event: SubagentEvent): Promise<void> {
		const id = event.agentId;
		if (!claimTerminalNotice(id)) return;
		const ctx = getSession();
		if (!ctx) return;
		try {
			const { getAgent } = await import("./session-manager");
			const agent = getAgent(id);
			if (!agent) return; // pruned or foreign id — nothing to notify
			const knob = state.config.completionNotify ?? "all";
			const run = resolveRunEntry(state.getLogicalRunEntries(ctx), id);
			// Issue #365: a transport-class background failure is re-dispatched once
			// and the source notice is suppressed (the retry's settle is the wake).
			// Every other terminal type — and every non-retryable failure — keeps the
			// existing path unchanged.
			if (event.type === "subagent:failed" && run && isTransportRetryable(run)) {
				const retried = await scheduleTransportRetry(ctx, run);
				if (retried) return;
			}
			const message = buildCompletionMessage(agent, run);
			// Issue #474: a settle that is not a success reports the worktree it may
			// have left. The CLASSIFIED status gates it (not `agent.status`), so the
			// #179 completed→failed downgrade carries the block too, and a genuinely
			// completed run stays noise-free. A record written before #474 has no
			// `agent.cwd`; its retry snapshot's cwd is used only when it is absolute
			// (describeWorktreeState refuses a relative one rather than resolving it
			// against this process's cwd).
			const settledMessage =
				message.details.status === "completed"
					? message
					: withWorktreeState(
							message,
							describeWorktreeState(agent.cwd ?? run?.originalParams?.cwd),
						);
			// Issue #179 (D2): resolve delivery from the CLASSIFIED notification
			// status, not the raw agent status — otherwise a run whose completion
			// the builder downgraded to failed would still be delivered as a success.
			const delivery = resolveDelivery(settledMessage.details.status, knob);
			sendCompletionNotification(pi, settledMessage, delivery);
		} catch (err) {
			log.warn(`completion-push handler failed for ${id}`, {
				error: (err as Error).message,
			});
		}
	}

	return { release: releaseTerminalSubscriptions };
}

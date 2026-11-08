// Purpose: Boot recovery — the interrupted-run scan, the boot head-state reconcile and the recovery notices, built over one runtime context.
/**
 * brl-subagent — the boot recovery cluster (cycle S4, ADR 0027 D3/D5/D6)
 *
 * `performBootRecovery`, `reconcileHeadStatesAtBoot` and the two notice surfaces
 * used to be closures inside `src/index.ts`'s default export, alongside the
 * head-state deps wiring and the visibility bridge they share (`headStateDeps`,
 * `visibleRunsFor`) and the abandon action the recovery notice offers
 * (`abandonProductionRun`). They move here verbatim.
 *
 * D3: this module may import the `src/*.ts` modules it needs, and NOT the
 * composition root — `architecture-rules` forbids a non-entry module importing
 * `index.ts`. The three bindings the moved bodies read from their old closure
 * (`pi`, `log`, `state`) arrive as the `RuntimeContext` argument; everything else
 * they touch was already a module import, so this factory takes no `deps`. The
 * session-manager reads inside the bodies stay `await import("./session-manager")`
 * at their original statement position: those are the lifecycle mutators
 * (`markAgentInterrupted`, `updateAgentStatus`, `pruneBackgroundSession`) the
 * reader-API rule keeps off non-entry modules' STATIC imports, and ADR 0027's
 * recorded limit is that the rule cannot see dynamic destructuring — so the lazy
 * load and its await position are preserved rather than converted to a static
 * import (which would hoist a load the boot path must not perform early).
 *
 * D5: `recoveryNoticeDelivered` is a `let` INSIDE this factory, never
 * module-private. Two `initExtension` instances must not share the once-per-boot
 * latch: one runtime's shutdown reset would otherwise re-arm (or silence) the
 * other's notice. `resetRecoveryNotice` is how the owning runtime re-arms it.
 *
 * The move is verbatim. `createBootRecovery` destructures its context on its
 * first lines and the bodies carry their original indentation, so a body line
 * that differs from 91b286d is a bug in this commit, not a refactor. The two
 * non-verbatim pieces are named in the PR: the factory wrapper itself
 * (`rt` destructure + the latch declaration) and `resetRecoveryNotice`.
 */

import type { RuntimeContext } from "./runtime";
import type { SubagentRun } from "./types";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { getHeadBranch, getRepoRoot, hasUncommittedChanges, listWorkBranches, restoreHead } from "./git";
import { buildHeadStateNotice, reconcileHeadStates, sweepHeadStates, type HeadStateDeps, type HeadStateOutcome } from "./headstate";
import { classifyOwner, defaultRecoveryDeps, recoverProduction } from "./recovery";
import {
	abandonInterruptedRun,
	buildRecoveryNotice,
	collectInterruptedRuns,
	offeredInterruptedRuns,
	resolveRecoveryNoticeDelivery,
	visibleRunEntriesForSession,
	type RecoveryAgentLookup,
} from "./recovery-surface";
import { clearInflightRun, listInflightRuns, markInterrupted } from "./run-registry";
import { resolveTerminalRunEntry } from "./state";
import { pruneHistoryIfNeeded } from "./unit-run";

/**
 * The boot cluster's returned capabilities. Declared (not exported) for the same
 * reason as the background pipeline's interface: the factory's return value IS
 * the interface the composition root consumes, so the returned object and this
 * declaration cannot drift.
 */
interface BootRecovery {
	performBootRecovery: () => Promise<void>;
	reconcileHeadStatesAtBoot: () => HeadStateOutcome[];
	maybeSendHeadStateNotice: (outcomes: HeadStateOutcome[]) => void;
	maybeSendRecoveryNotice: (ctx: ExtensionContext) => Promise<void>;
	abandonProductionRun: (ctx: ExtensionContext, id: string) => Promise<void>;
	/**
	 * Fix A's visibility bridge, shared with the composition root's `retryRunId`
	 * branch — the second consumer that resolves a run id (see `visibleRunsFor`).
	 */
	visibleRunsFor: (ctx: ExtensionContext, getAgent: RecoveryAgentLookup) => SubagentRun[];
	/**
	 * D5: re-arm the once-per-boot latch. The shutdown handler calls this where
	 * the closure used to assign `recoveryNoticeDelivered = false` inline — the
	 * latch belongs to this instance, so only its owner can reset it.
	 */
	resetRecoveryNotice: () => void;
}

/**
 * Build the boot recovery cluster over one runtime context (ADR 0027 D1/D3).
 *
 * The destructure re-creates, as locals, the names the bodies read from their old
 * closure, so every moved statement stays byte-identical.
 */
export function createBootRecovery(rt: RuntimeContext): BootRecovery {
	const { pi, log, state } = rt;

	// Option B U3 (D2): "one recovery notice per boot". The boot scan may be
	// followed by more session_starts in the same process (reload); without this
	// guard every one would re-list the same interrupted runs. Reset on shutdown
	// so a genuinely new session notifies again. ADR 0027 D5: per factory
	// instance — a module-private latch would be shared by two runtimes.
	let recoveryNoticeDelivered = false;

	// -------------------------------------------------------------------
	// Option B U1: boot recovery — identity/liveness detection + child reap
	// -------------------------------------------------------------------
	// Runs AFTER restoreFromSession so config is ready. Candidate runs come from
	// the DURABLE registry (`.pi/run-registry/`), NOT from this session's run
	// entries: a crashed session's foreground/unit records are invisible to a
	// default fresh startup, and the full `.pi/subagents/` store is too costly to
	// parse (only the one agent record a background entry names is read). For
	// each in-flight run whose owner is dead, its orphaned marker-verified child
	// is reaped and the record is marked: the registry entry always, plus the
	// agent record for background runs. The scan itself is SILENT in the UI —
	// U3's `maybeSendRecoveryNotice` (below) is the one notice surface.
	// Platforms without /proc skip the whole scan (one log line):
	// pid-only liveness cannot rule out pid reuse, so nothing is killed or
	// marked unverified.
	async function performBootRecovery(): Promise<void> {
		try {
			const { getAgent, markAgentInterrupted } = await import("./session-manager");
			// `recoverProduction` owns the /proc platform guard (nothing is marked or
			// killed without start-token verification) — see src/recovery.ts.
			const summary = await recoverProduction({
				log,
				// Read THAT ONE agent record by id — never the whole store.
				readAgentRecord: (id) => getAgent(id),
				mark(record, interruptedAt) {
					// Registry entry = the durable mark for every kind. Issue #304: its
					// boolean is the durable-write result — do NOT drop it, or the boot
					// summary would claim a mark that never landed. The scan counts a
					// `false` as `markFailures` and warns with the id.
					const durable = markInterrupted(record.id, interruptedAt);
					if (record.kind === "agent") markAgentInterrupted(record.id, interruptedAt);
					return durable;
				},
				// Issue #447: a dispatch whose acceptance marker is still `null` never
				// reached `session.prompt()`. It is finalized `failed` here — a
				// terminal write, so `persistRunRecord` retires the registry entry in
				// the same call and no interrupted/retry surface can pick it up.
				finalizeNeverStarted: (run) => {
					state.persistRun(pi, run);
				},
			});
			// Report the scan whenever it did anything durable OR attempted a mark
			// that failed — a failure-only boot must not be silent (issue #304).
			if (summary.marked > 0 || summary.markFailures > 0) {
				log.warn("Boot recovery marked interrupted runs", { ...summary });
			}
			// Issue #447: never-started dispatches are finalized, not marked — a
			// separate line so the two outcomes cannot be read as one another.
			if (summary.neverStarted > 0) {
				log.info("Boot recovery finalized never-started dispatches", {
					count: summary.neverStarted,
				});
			}
		} catch (err) {
			// Recovery is best-effort hygiene — it must never break session start.
			log.warn("Boot recovery scan failed", { error: (err as Error).message });
		}
	}

	/**
	 * Issue #466 (ADR 0026 D2): the git/process surface the head-state table
	 * reads, wired once so the boot step and its tests cannot drift apart.
	 */
	function headStateDeps(): HeadStateDeps {
		const procDeps = defaultRecoveryDeps();
		return {
			getRepoRoot,
			classifyOwner: (owner) => classifyOwner(owner, procDeps),
			getHeadBranch,
			restoreHead,
			hasUncommittedChanges,
			listWorkBranches,
		};
	}

	/**
	 * Issue #466: the boot's ONE git-mutating step, between the scan (which only
	 * marks records) and the notices. Best-effort like the scan — a failing store
	 * must never break session start — but every record still ends in exactly one
	 * LOGGED verdict (D5: silence is not a verdict).
	 *
	 * The repair itself is NEVER gated by `config.recovery`: a tree left on a dead
	 * run's branch is a correctness problem, not a recovery offer. Only the notice
	 * below is gated.
	 */
	function reconcileHeadStatesAtBoot(): HeadStateOutcome[] {
		try {
			const outcomes = reconcileHeadStates(headStateDeps());
			for (const outcome of outcomes) {
				log.info("Boot head-state verdict", { ...outcome });
			}
			// Housekeeping, never part of the repair contract: only a record whose
			// repository no longer resolves (or that cannot be parsed) is swept, so
			// a live orphan's base is never deleted by age.
			const swept = sweepHeadStates({
				repoGone: (record) => getRepoRoot(record.repoRoot) === undefined,
			});
			if (swept > 0) log.info("Swept stale head-state records", { count: swept });
			return outcomes;
		} catch (err) {
			log.warn("Boot head-state reconciliation failed", { error: (err as Error).message });
			return [];
		}
	}

	/**
	 * Issue #466 (D5): the repair and the needs-manual verdict reach the user
	 * once, on the same `nextTurn` channel as the recovery notice, and are gated
	 * by `config.recovery !== "off"` like every other boot surface.
	 */
	function maybeSendHeadStateNotice(outcomes: HeadStateOutcome[]): void {
		if (state.config.recovery === "off") return;
		const notice = buildHeadStateNotice(outcomes);
		if (!notice) return;
		try {
			pi.sendMessage(notice, resolveRecoveryNoticeDelivery());
			log.info("Head-state notice delivered", { count: notice.details.count });
		} catch (err) {
			// The notice is best-effort — it must never break session start.
			log.warn("Head-state notice failed", { error: (err as Error).message });
		}
	}

	/**
	 * Option B U3 Fix A: the recovery visibility bridge, wired for the two
	 * extension consumers that resolve a run id (the retryRunId branch and the
	 * abandon action). Session run entries UNIONED with synthetic durable
	 * interrupted records the session has never seen (a genuine fresh boot), so
	 * an id named by the boot notice resolves here instead of being rejected as
	 * not found. `getAgent` is injected because the callers already load it
	 * dynamically — this keeps the registry/agent reads in ONE place.
	 */
	function visibleRunsFor(
		ctx: ExtensionContext,
		getAgent: RecoveryAgentLookup,
	): SubagentRun[] {
		return visibleRunEntriesForSession(state.getLogicalRunEntries(ctx), getAgent);
	}

	/**
	 * Option B U3 (D2): after the boot scan, send ONE notice at the next turn
	 * boundary listing every unresolved interrupted run whose dispatch snapshot
	 * (and the session posture) says "offer". Delivery is `nextTurn` — the notice
	 * can never steer or arrive mid-turn (see `resolveRecoveryNoticeDelivery`).
	 * Silent when there is nothing to offer; at most once per session start.
	 */
	async function maybeSendRecoveryNotice(ctx: ExtensionContext): Promise<void> {
		if (recoveryNoticeDelivered) return;
		recoveryNoticeDelivered = true;
		// Session posture off silences the whole surface, regardless of per-run
		// snapshots (a user opting out expects quiet).
		if (state.config.recovery === "off") return;
		try {
			const { getAgent } = await import("./session-manager");
			const offered = offeredInterruptedRuns(
				collectInterruptedRuns({
					listInflight: () => listInflightRuns(),
					getAgent: (id) => getAgent(id),
					findRun: (id) => state.findTerminalRunById(ctx, id),
				}),
			);
			if (offered.length === 0) return;
			pi.sendMessage(buildRecoveryNotice(offered), resolveRecoveryNoticeDelivery());
			log.info("Recovery notice delivered", { count: offered.length });
		} catch (err) {
			// The notice is best-effort — it must never break session start.
			log.warn("Recovery notice failed", { error: (err as Error).message });
		}
	}

	/**
	 * Option B U3 (D5): finalize ONE interrupted run as the existing terminal
	 * `stopped` outcome and prune its U2 session dir. Wired through injected deps
	 * so the pure core (`recovery-surface.ts`) stays testable; the run record is
	 * written terminal (the run store's `status` union has no `stopped` — a
	 * stopped outcome is represented as `failed` + `errorCategory: "aborted"`,
	 * exactly as every other stop path does) and the background agent record is
	 * flipped to `stopped`.
	 */
	async function abandonProductionRun(ctx: ExtensionContext, id: string): Promise<void> {
		const { updateAgentStatus, pruneBackgroundSession, getAgent } = await import("./session-manager");
		// Fix A: the abandon lookup routes through the visibility bridge, so a run
		// that exists ONLY in the durable registry after a fresh boot is
		// abandonable instead of resolving to undefined (the silent `false`).
		const visible = visibleRunsFor(ctx, getAgent);
		abandonInterruptedRun(id, {
			getRun: (runId) => resolveTerminalRunEntry(visible, runId),
			writeRun: (run) => {
				state.persistRun(pi, run);
				pruneHistoryIfNeeded(state, ctx, log);
			},
			markAgentStopped: (agentId) => {
				const agent = updateAgentStatus(agentId, "stopped");
				if (agent) log.info("Abandoned background agent record", { agentId });
			},
			retireRegistry: (runId) => clearInflightRun(runId),
			pruneSession: (runId) => pruneBackgroundSession(runId),
		});
	}
	/**
	 * Issue #437-adjacent (ADR 0027 D5): the shutdown re-arm the closure performed
	 * inline. `session_shutdown` still runs it at the same position in the handler
	 * sequence, so a later boot in the same runtime notifies again.
	 */
	function resetRecoveryNotice(): void {
		recoveryNoticeDelivered = false;
	}

	return {
		performBootRecovery,
		reconcileHeadStatesAtBoot,
		maybeSendHeadStateNotice,
		maybeSendRecoveryNotice,
		abandonProductionRun,
		visibleRunsFor,
		resetRecoveryNotice,
	};
}

// Purpose: Pure recovery decision engine — identity, owner liveness classification, and the boot-scan plan over injected process deps.
/**
 * Option B U1 — recovery decision engine (pure over `RecoveryDeps`).
 *
 * The engine decides, for one persisted `running` record, whether its
 * conductor is still live, whether to reject ownership, and whether to reap a
 * marker-verified orphan child. It performs NO process work itself: every
 * effect goes through the injected `RecoveryDeps`, so the full matrix is
 * unit-testable without spawning processes. The boot orchestration lives in
 * `src/recovery.ts`; the production `/proc` wiring in `src/proc.ts`.
 *
 * Decision order (`decideRecovery`):
 *   - status not "running" → skip
 *   - `interruptedAt` already set → never re-mark, but re-check for a leftover
 *     live marker child and reap it again (B2 revisit)
 *   - absent owner → skip (`no-owner`)
 *   - owner present but unparsable → mark-only (`owner-unverifiable`), no kill
 *   - owner alive (pid + start token match) → leave untouched
 *   - owner alive but token unreadable → skip (`ownership-unverifiable`)
 *   - owner dead → reap marker-verified orphan children, then mark
 *
 * Reaping is the ONE `escalateKill` sequence (src/kill-escalation.ts): SIGTERM
 * every pid, wait one grace window, SIGKILL any survivor.
 */

import type { ProcessOwner, SubagentRun } from "./types";
import { resolveTerminalRunEntry } from "./state";
import { escalateKill, processTarget, type SignalGuard, type SignalPhase } from "./kill-escalation";
import type { Logger } from "./logging";

// ---------------------------------------------------------------------------
// Dependency injection surface
// ---------------------------------------------------------------------------

/** The process primitives the decision engine needs (injected for testability). */
export interface RecoveryDeps {
	/** True when the pid exists (SIGCONT/`kill -0` semantics; EPERM counts as alive). */
	pidAlive(pid: number): boolean;
	/** The process start-time token, or undefined when /proc is unavailable/unreadable. */
	startTokenOf(pid: number): string | undefined;
	/** Pids whose environment carries `CHILD_MARKER_ENV_KEY=<marker>`; [] when /proc is unavailable. */
	findByMarker(marker: string): number[];
	/** Send a signal to a pid (may throw when the pid is already gone). */
	kill(pid: number, signal: NodeJS.Signals): void;
	/**
	 * #299 D4: best-effort process-group signal (`kill(-pgid, sig)`; ESRCH
	 * tolerated). Present only where POSIX process groups exist — the effect is
	 * that `reapPids` targets become group-reaching (verified marker pids signal
	 * their group as well as the pid). When absent (Windows, D6) `reapPids`
	 * falls back to direct pid targets, exactly today's behavior.
	 */
	killGroup?(pgid: number, signal: NodeJS.Signals): void;
	/**
	 * #299 review Major 2: true when process group `pgid` still has a LIVE member.
	 * Threaded into the group target's `verifyDeath` so a leader that exits
	 * promptly no longer reads as "group empty" — the escalation then honours the
	 * grace window for a member's cleanup. Absent/false on a platform without
	 * /proc → leader-only fallback (documented boundary).
	 */
	groupHasMembers?(pgid: number): boolean;
	/**
	 * #299 review Major 1: signal-time marker re-check — true when the LIVE `pid`
	 * still carries `CHILD_MARKER_ENV_KEY=<marker>`. Threaded into the marker
	 * targets' signal guard so a pid that exited and was reused by a foreign
	 * process is never signaled. Absent → no signal-time gate (tests without /proc
	 * wiring); production always provides it via `defaultRecoveryDeps`.
	 */
	verifyMarker?(pid: number, marker: string): boolean;
	/**
	 * #299 review Major 1: true when the pid is gone — reaped OR a not-yet-reaped
	 * zombie. The signal guard uses this to separate a REUSED pid from a merely
	 * dead/zombie one, so a zombie leader's pgid is still signaled (D5). Absent →
	 * `!pidAlive` (no zombie distinction).
	 */
	pidGone?(pid: number): boolean;
	/** Sleep between SIGTERM and SIGKILL. */
	sleep(ms: number): Promise<void>;
	/** Grace period in ms between SIGTERM and SIGKILL. */
	graceMs: number;
	/**
	 * Poll interval for the early-exit wait (B4/Item 4): when > 0 the reap returns
	 * as soon as every target verifies dead, bounded by `graceMs`. Omitted/0 keeps
	 * the historical wait-the-full-grace-once shape.
	 */
	pollMs?: number;
}

/** Which persisted store a candidate record came from. */
export type RecoveryKind = "run" | "agent";

/** A persisted `running` record projected into the shape the engine reasons over. */
export interface RecoveryRecord {
	id: string;
	kind: RecoveryKind;
	status: string;
	interruptedAt?: string;
	owner?: ProcessOwner;
	childMarker?: string;
	/** Original record for the caller's write-back; opaque to this module. */
	source?: unknown;
}

export type RecoverySkipReason =
	| "not-running"
	| "already-interrupted"
	| "no-owner"
	| "owner-alive"
	| "ownership-unverifiable";

export type RecoveryMarkReason = "owner-dead" | "child-orphaned" | "owner-unverifiable";

/** What the engine decided to do with one record (before any process work). */
export type RecoveryPlan =
	| { decision: "skip"; reason: RecoverySkipReason }
	| { decision: "mark"; reason: RecoveryMarkReason; reap: number[] }
	/** Already-marked record re-checked this boot: reap leftovers, never re-mark. */
	| { decision: "reap"; reason: "revisit-interrupted"; reap: number[] };

/** The engine's verdict on an owner identity. */
export type OwnerState = "alive" | "dead" | "unknown";

/** The result of applying a plan (kills performed, survivors logged). */
export interface RecoveryOutcome {
	id: string;
	kind: RecoveryKind;
	decision: "skip" | "mark" | "reap";
	reason: string;
	reaped: number[];
	survived: number[];
}

// ---------------------------------------------------------------------------
// Candidate projection
// ---------------------------------------------------------------------------

/**
 * Durability identity for a newly dispatched run record. A retry inherits the
 * original's dispatchId and records `resumeOf`/`attempt`; a fresh dispatch
 * mints a new dispatchId with attempt 1. These are RECORD fields, not
 * delegate_task params (D4).
 */
export function newDispatchIdentity(source: SubagentRun | undefined): {
	dispatchId: string;
	resumeOf?: string;
	attempt: number;
} {
	return {
		dispatchId: source?.dispatchId ?? crypto.randomUUID(),
		resumeOf: source?.id,
		attempt: source ? (source.attempt ?? 1) + 1 : 1,
	};
}

/**
 * Collapse run entries to ONE per id before the scan, using the ONE shared
 * preference rule (`resolveTerminalRunEntry`, src/state.ts): terminal-first;
 * among non-terminal entries the D3 `interruptedAt` mark wins over the
 * original spawn entry; otherwise the first entry seen. Ids keep their
 * first-seen order. Delegating keeps the recovery scan and U3's display/retry
 * lookup from diverging (the historical duplicate rule picked the marked clone
 * while the resolver picked the unmarked spawn).
 */
export function dedupeRunEntriesById(runs: SubagentRun[]): SubagentRun[] {
	const ids: string[] = [];
	const seen = new Set<string>();
	for (const run of runs) {
		if (seen.has(run.id)) continue;
		seen.add(run.id);
		ids.push(run.id);
	}
	const collapsed: SubagentRun[] = [];
	for (const id of ids) {
		const resolved = resolveTerminalRunEntry(runs, id);
		if (resolved) collapsed.push(resolved);
	}
	return collapsed;
}

// ---------------------------------------------------------------------------
// The decision engine (pure over RecoveryDeps)
// ---------------------------------------------------------------------------

/**
 * Classify the recorded owner's liveness. `unknown` means the pid is alive but
 * the start token could not be read, so pid reuse cannot be excluded — the
 * caller must not act on it.
 */
export function classifyOwner(owner: ProcessOwner, deps: RecoveryDeps): OwnerState {
	if (!deps.pidAlive(owner.pid)) return "dead";
	// An empty recorded token means the WRITER could not read one (non-/proc
	// platform). Even on a host that can read tokens now, the record's identity
	// is unverifiable — never act on it.
	if (!owner.start) return "unknown";
	const token = deps.startTokenOf(owner.pid);
	if (token === undefined) return "unknown";
	return token === owner.start ? "alive" : "dead";
}

/**
 * True when an owner carries a usable pid (positive integer). Anything else —
 * a missing pid, a string, 0, a negative, NaN, a fraction — is UNPARSABLE
 * ownership: the record is marked but the kill path is never touched.
 */
function hasParsableOwnerPid(owner: ProcessOwner): boolean {
	return Number.isInteger(owner.pid) && owner.pid > 0;
}

/**
 * Decide what to do with one persisted record. Pure — no process is touched.
 * Reaping pids come ONLY from a marker scan: without a verified marker match
 * the engine never proposes a kill. An unparsable owner is mark-only (see the
 * module header's three-way owner policy): interrupt is certain, ownership is
 * not, so `reap` is empty and the kill path stays untouched.
 */
export function decideRecovery(record: RecoveryRecord, deps: RecoveryDeps): RecoveryPlan {
	if (record.status !== "running") return { decision: "skip", reason: "not-running" };
	if (record.interruptedAt) {
		// Already marked: NEVER re-mark (idempotent), but a SIGKILL survivor or a
		// child whose marker was unreadable at mark time must stay revisitable.
		// The registry entry is retained, so every later boot re-checks it.
		const reap = record.childMarker ? deps.findByMarker(record.childMarker) : [];
		return reap.length > 0
			? { decision: "reap", reason: "revisit-interrupted", reap }
			: { decision: "skip", reason: "already-interrupted" };
	}
	if (!record.owner) return { decision: "skip", reason: "no-owner" };
	if (!hasParsableOwnerPid(record.owner)) {
		return { decision: "mark", reason: "owner-unverifiable", reap: [] };
	}

	const ownerState = classifyOwner(record.owner, deps);
	if (ownerState === "alive") return { decision: "skip", reason: "owner-alive" };
	if (ownerState === "unknown") return { decision: "skip", reason: "ownership-unverifiable" };

	const reap = record.childMarker ? deps.findByMarker(record.childMarker) : [];
	return {
		decision: "mark",
		reason: reap.length > 0 ? "child-orphaned" : "owner-dead",
		reap,
	};
}

/**
 * Escalate a set of pids together: SIGTERM every one, wait (with `deps.pollMs`,
 * at most) ONE grace window returning as soon as all are dead, then SIGKILL any
 * survivor. Returns the pids still alive afterwards. Thin
 * adapter over the shared `escalateKill` helper (src/kill-escalation.ts), which
 * `recoverRecord` (one record) and `runBootScan` (the whole scan) both call, so
 * a boot with N orphans waits one grace period total, never N.
 *
 * #299 review Major 1: `markerOfPid` resolves the marker that verified a pid at
 * scan time; when `deps.verifyMarker` is also wired (production), every signal
 * on that pid is gated on an immediate re-read of the live marker (`SignalGuard`),
 * so a pid reused by a foreign process is skipped, never signaled unverified.
 * `onSkip` records a refused signal. Both are optional so direct `reapPids`
 * callers without /proc wiring keep the historical unconditional behavior.
 */
export async function reapPids(
	pids: number[],
	deps: RecoveryDeps,
	markerOfPid?: (pid: number) => string | undefined,
	onSkip?: (pid: number, signal: NodeJS.Signals, phase: SignalPhase) => void,
): Promise<number[]> {
	const unique = [...new Set(pids)];
	const isGone = deps.pidGone ?? ((pid: number) => !deps.pidAlive(pid));
	const targets = unique.map((pid) => {
		const marker = markerOfPid?.(pid);
		const guard: SignalGuard | undefined =
			marker && deps.verifyMarker
				? {
						isOwn: (targetPid) => deps.verifyMarker!(targetPid, marker),
						isGone,
						onSkip,
					}
				: undefined;
		return processTarget(
			pid,
			deps.kill,
			deps.pidAlive,
			deps.killGroup,
			deps.groupHasMembers,
			guard,
		);
	});
	const survivors = await escalateKill(targets, {
		graceMs: deps.graceMs,
		pollMs: deps.pollMs,
		sleep: deps.sleep,
	});
	const survivedSet = new Set(survivors);
	return unique.filter((_, index) => survivedSet.has(targets[index]));
}

/**
 * Apply a record's plan: SIGTERM every marker-verified orphan, wait the grace
 * period, SIGKILL any survivor, then report. Never throws on a vanished pid.
 *
 * #299 review Major 1: every signal on this record's marker-verified pids is
 * re-checked against the live marker at signal time; a refused signal is logged
 * when `log` is supplied.
 */
export async function recoverRecord(
	record: RecoveryRecord,
	deps: RecoveryDeps,
	log?: Pick<Logger, "warn">,
): Promise<RecoveryOutcome> {
	const plan = decideRecovery(record, deps);
	if (plan.decision === "skip") {
		return {
			id: record.id,
			kind: record.kind,
			decision: "skip",
			reason: plan.reason,
			reaped: [],
			survived: [],
		};
	}

	const reaped = [...new Set(plan.reap)];
	const marker = record.childMarker;
	const survived = await reapPids(
		reaped,
		deps,
		marker ? () => marker : undefined,
		(pid, signal, phase) =>
			log?.warn("Recovery: skipped a marker signal (pid no longer carries the run marker)", {
				id: record.id,
				pid,
				signal,
				phase,
				marker,
			}),
	);

	return {
		id: record.id,
		kind: record.kind,
		decision: plan.decision,
		reason: plan.reason,
		reaped,
		survived,
	};
}

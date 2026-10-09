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
import { escalateKill, type EscalationTarget } from "./kill-escalation";

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
	/** Sleep between SIGTERM and SIGKILL. */
	sleep(ms: number): Promise<void>;
	/** Grace period in ms between SIGTERM and SIGKILL. */
	graceMs: number;
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
 * Escalate a set of pids together: SIGTERM every one, wait ONE grace window,
 * then SIGKILL any survivor. Returns the pids still alive afterwards. Thin
 * adapter over the shared `escalateKill` helper (src/kill-escalation.ts), which
 * `recoverRecord` (one record) and `runBootScan` (the whole scan) both call, so
 * a boot with N orphans waits one grace period total, never N.
 */
export async function reapPids(pids: number[], deps: RecoveryDeps): Promise<number[]> {
	const unique = [...new Set(pids)];
	const targets: EscalationTarget[] = unique.map((pid) => ({
		terminate: () => {
			deps.kill(pid, "SIGTERM");
		},
		forceKill: () => {
			deps.kill(pid, "SIGKILL");
		},
		verifyDeath: () => !deps.pidAlive(pid),
	}));
	const survivors = await escalateKill(targets, {
		graceMs: deps.graceMs,
		sleep: deps.sleep,
	});
	const survivedSet = new Set(survivors);
	return unique.filter((_, index) => survivedSet.has(targets[index]));
}

/**
 * Apply a record's plan: SIGTERM every marker-verified orphan, wait the grace
 * period, SIGKILL any survivor, then report. Never throws on a vanished pid.
 */
export async function recoverRecord(
	record: RecoveryRecord,
	deps: RecoveryDeps,
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
	const survived = await reapPids(reaped, deps);

	return {
		id: record.id,
		kind: record.kind,
		decision: plan.decision,
		reason: plan.reason,
		reaped,
		survived,
	};
}

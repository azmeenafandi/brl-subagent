// Purpose: Boot-time recovery scan — decides whether a persisted running record is live, reaps orphaned children, and marks interrupted records.
/**
 * Option B U1 — recovery: identity, liveness, detection engine, child reap.
 *
 * A run record is written BEFORE its effect (the spawn), so a crashed
 * conductor leaves `running` records and — on the foreground path — an
 * orphaned child process. This module is the boot-time scan that decides, in a
 * FRESH process, which of those records are genuinely live:
 *
 *   - `interruptedAt` already set  → skip (idempotent)
 *   - owner alive (pid + start token match) → leave untouched
 *   - owner dead → reap a marker-verified orphan child (SIGTERM → grace →
 *     SIGKILL), then mark `interruptedAt` on the record
 *
 * The decision logic is a pure function over injected dependencies
 * (`decideRecovery` / `recoverRecord` / `runBootScan`), so the full matrix is
 * unit-testable without spawning processes; the production wiring is
 * `defaultRecoveryDeps`.
 *
 * PLATFORM BOUNDARY (required): the start-time token (`/proc/<pid>/stat` field
 * 22) and the child-marker scan (`/proc/<pid>/environ`) are Linux/POSIX reads.
 * `isProcAvailable()` feature-detects them. Where they are unavailable, the
 * production scan is SKIPPED with one clear log line: `process.kill(pid, 0)`
 * liveness still works cross-platform, but on its own it cannot rule out pid
 * reuse, so we NEVER kill an unverified process and NEVER mark a record as
 * interrupted when ownership cannot be verified. On a capable platform a
 * record that is alive but whose start token cannot be read is likewise left
 * untouched (reason `ownership-unverifiable`).
 *
 * A record with no `owner` at all is also left untouched (reason `no-owner`):
 * ownership cannot be checked, so the safe choice is to do nothing. (This is
 * the conservative reading of the plan's "missing owner is treated as
 * interrupted" line — see the U1 report for the recorded deviation.)
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProcessOwner, SubagentRun } from "./types";
import { SIGKILL_GRACE_MS } from "./types";
import { CHILD_MARKER_ENV_KEY } from "./sanitize";
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

export type RecoveryMarkReason = "owner-dead" | "child-orphaned";

/** What the engine decided to do with one record (before any process work). */
export type RecoveryPlan =
	| { decision: "skip"; reason: RecoverySkipReason }
	| { decision: "mark"; reason: RecoveryMarkReason; reap: number[] };

/** The engine's verdict on an owner identity. */
export type OwnerState = "alive" | "dead" | "unknown";

/** The result of applying a plan (kills performed, survivors logged). */
export interface RecoveryOutcome {
	id: string;
	kind: RecoveryKind;
	decision: "skip" | "mark";
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
 * Collapse run entries to ONE per id before the scan. Preference order:
 *
 *   1. a TERMINAL entry (status !== "running") — the run is resolved, so the
 *      stale spawn entry sharing its id must never be re-marked as interrupted;
 *   2. an entry that already carries the D3 `interruptedAt` mark — append-only
 *      stores keep the original spawn entry forever, so the marked clone is the
 *      authoritative one (otherwise every boot re-marks the spawn entry);
 *   3. otherwise the first entry seen.
 */
export function dedupeRunEntriesById(runs: SubagentRun[]): SubagentRun[] {
	const byId = new Map<string, SubagentRun>();
	for (const run of runs) {
		const existing = byId.get(run.id);
		if (!existing) {
			byId.set(run.id, run);
			continue;
		}
		const existingTerminal = existing.status !== "running";
		const runTerminal = run.status !== "running";
		if (!existingTerminal && runTerminal) {
			byId.set(run.id, run);
			continue;
		}
		if (existingTerminal && !runTerminal) continue;
		if (!existing.interruptedAt && run.interruptedAt) byId.set(run.id, run);
	}
	return [...byId.values()];
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
 * Decide what to do with one persisted record. Pure — no process is touched.
 * Reaping pids come ONLY from a marker scan: without a verified marker match
 * the engine never proposes a kill.
 */
export function decideRecovery(record: RecoveryRecord, deps: RecoveryDeps): RecoveryPlan {
	if (record.status !== "running") return { decision: "skip", reason: "not-running" };
	if (record.interruptedAt) return { decision: "skip", reason: "already-interrupted" };
	if (!record.owner) return { decision: "skip", reason: "no-owner" };

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
	for (const pid of reaped) {
		try {
			deps.kill(pid, "SIGTERM");
		} catch {
			// Already gone — the desired end state.
		}
	}
	if (reaped.length > 0) {
		await deps.sleep(deps.graceMs);
	}
	const survived: number[] = [];
	for (const pid of reaped) {
		if (!deps.pidAlive(pid)) continue;
		try {
			deps.kill(pid, "SIGKILL");
		} catch {
			// Race: it exited between the liveness check and the signal.
		}
		if (deps.pidAlive(pid)) survived.push(pid);
	}

	return {
		id: record.id,
		kind: record.kind,
		decision: "mark",
		reason: plan.reason,
		reaped,
		survived,
	};
}

// ---------------------------------------------------------------------------
// Boot scan orchestration
// ---------------------------------------------------------------------------

/** Aggregate counts from one boot scan (also the shape the log line carries). */
export interface BootScanSummary {
	scanned: number;
	skipped: number;
	marked: number;
	reaped: number;
	skippedUnverifiable: number;
	skippedNoOwner: number;
}

export interface BootScanOptions {
	records: RecoveryRecord[];
	deps: RecoveryDeps;
	/** Persist the D3 mark for this record (agent RMW / run-entry append). */
	mark(record: RecoveryRecord, interruptedAt: string): void;
	now?: () => Date;
	log?: Pick<Logger, "debug" | "info" | "warn">;
}

/**
 * Run the decision engine over every candidate, reap markers, and mark the
 * records whose conductor is dead. Every decision is logged; the UI is
 * deliberately silent (the notice/offer surface lands in U3).
 *
 * Idempotent: a marked record has `interruptedAt` set in memory before the
 * next iteration, so a second scan over the same array is a no-op.
 */
export async function runBootScan(options: BootScanOptions): Promise<BootScanSummary> {
	const { records, deps, mark } = options;
	const nowIso = (options.now?.() ?? new Date()).toISOString();
	const summary: BootScanSummary = {
		scanned: records.length,
		skipped: 0,
		marked: 0,
		reaped: 0,
		skippedUnverifiable: 0,
		skippedNoOwner: 0,
	};

	for (const record of records) {
		const outcome = await recoverRecord(record, deps);
		if (outcome.decision === "mark") {
			mark(record, nowIso);
			// In-memory mark first: guarantees the scan is idempotent even when
			// the caller's write-back is append-only (run entries) or deferred.
			record.interruptedAt = nowIso;
			summary.marked++;
			summary.reaped += outcome.reaped.length;
			options.log?.warn("Recovery: marked interrupted record", {
				id: record.id,
				kind: record.kind,
				reason: outcome.reason,
				reaped: outcome.reaped,
				survived: outcome.survived,
			});
		} else {
			summary.skipped++;
			if (outcome.reason === "ownership-unverifiable") summary.skippedUnverifiable++;
			if (outcome.reason === "no-owner") summary.skippedNoOwner++;
			options.log?.debug("Recovery: left record untouched", {
				id: record.id,
				kind: record.kind,
				reason: outcome.reason,
			});
		}
	}

	return summary;
}

// ---------------------------------------------------------------------------
// Production wiring (Linux/POSIX /proc reads, feature-detected)
// ---------------------------------------------------------------------------

const PROC_ROOT = "/proc";

let procAvailable: boolean | undefined;

/**
 * Feature-detect the Linux/POSIX `/proc` surface this module needs. Cached:
 * the answer cannot change mid-process. Exported so the entry point can skip
 * the whole scan with one log line on platforms without /proc.
 */
export function isProcAvailable(): boolean {
	if (procAvailable === undefined) {
		try {
			procAvailable = fs.existsSync(path.join(PROC_ROOT, "self", "stat"));
		} catch {
			procAvailable = false;
		}
	}
	return procAvailable;
}

/**
 * Read a process's start-time token — `/proc/<pid>/stat` field 22 (1-indexed),
 * i.e. index 19 of the whitespace-split fields AFTER the `(comm)` field. The
 * comm field is skipped by slicing at the LAST `)` so a name containing spaces
 * or parens cannot shift the parse. Returns undefined when /proc is
 * unavailable, the pid is invalid, or the process vanished.
 */
export function readStartToken(pid: number): string | undefined {
	if (!isProcAvailable() || !Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		const stat = fs.readFileSync(path.join(PROC_ROOT, String(pid), "stat"), "utf-8");
		const close = stat.lastIndexOf(")");
		if (close < 0) return undefined;
		const rest = stat.slice(close + 1).trim();
		if (!rest) return undefined;
		const fields = rest.split(/\s+/);
		const token = fields[19];
		return token && /^\d+$/.test(token) ? token : undefined;
	} catch {
		return undefined;
	}
}

/** The CURRENT process's owner identity (pid + start token; empty string when unavailable). */
export function currentProcessOwner(): ProcessOwner {
	return { pid: process.pid, start: readStartToken(process.pid) ?? "" };
}

/** Cross-platform pid liveness (`kill -0`). EPERM means the process exists. */
export function pidAlive(pid: number): boolean {
	if (!Number.isInteger(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch (err) {
		return (err as NodeJS.ErrnoException).code === "EPERM";
	}
}

/**
 * Pids whose environment carries the marker. Scans `/proc/<pid>/environ` (NUL
 * separated). Skips this process; unreadable/vanished processes are ignored.
 * Returns [] — never a kill — when /proc is unavailable.
 */
export function findByMarker(marker: string): number[] {
	if (!marker || !isProcAvailable()) return [];
	const needle = `${CHILD_MARKER_ENV_KEY}=${marker}`;
	const found: number[] = [];
	let entries: string[];
	try {
		entries = fs.readdirSync(PROC_ROOT);
	} catch {
		return [];
	}
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number(entry);
		if (pid === process.pid) continue;
		try {
			const environ = fs.readFileSync(path.join(PROC_ROOT, entry, "environ"), "utf-8");
			if (environ.split("\0").includes(needle)) found.push(pid);
		} catch {
			// Vanished or not readable by this user — not a verified match.
		}
	}
	return found;
}

/** The real production dependencies (Linux/POSIX /proc reads + process signals). */
export function defaultRecoveryDeps(): RecoveryDeps {
	return {
		pidAlive,
		startTokenOf: readStartToken,
		findByMarker,
		kill: (pid, signal) => {
			process.kill(pid, signal);
		},
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		graceMs: SIGKILL_GRACE_MS,
	};
}

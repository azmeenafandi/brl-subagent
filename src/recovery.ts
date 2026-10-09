// Purpose: Boot-time recovery scan — decides whether a persisted running record is live, reaps orphaned children, and marks interrupted records.
/**
 * Option B U1 — recovery boot orchestration.
 *
 * A run record is written BEFORE its effect (the spawn), so a crashed
 * conductor leaves `running` records and — on the foreground path — an
 * orphaned child process. This module runs the boot-time scan that decides, in
 * a FRESH process, which of those records are genuinely live:
 *
 *   - `interruptedAt` already set  → never re-mark, but re-check for a leftover
 *     live marker child and reap it again (B2 revisit)
 *   - owner alive (pid + start token match) → leave untouched
 *   - owner dead → reap a marker-verified orphan child (SIGTERM → grace →
 *     SIGKILL), then mark `interruptedAt` on the record
 *
 * The decision logic itself is the pure engine in `src/recovery-engine.ts`
 * (type/external surface unchanged); this module owns candidate sourcing and
 * the scan loop. `recoverInflightRuns` sources candidates from the durable
 * registry (`src/run-registry.ts`) — NOT from the current session's run
 * entries, which a fresh process cannot see after a crash — and
 * `recoverProduction` is the entry point that also enforces the platform guard.
 *
 * Reaping waits ONE grace window for the whole scan (`runBootScan` collects
 * every orphan pid and escalates them together), so N orphans cost one grace
 * period, not N.
 *
 * PLATFORM BOUNDARY (required): the `/proc` reads live in `src/proc.ts`.
 * Where `/proc` is unavailable, `recoverProduction` SKIPS the whole scan with
 * one log line — `process.kill(pid, 0)` liveness alone cannot rule out pid
 * reuse, so we NEVER kill an unverified process and NEVER mark a record when
 * ownership cannot be verified.
 */

import { listInflightRuns } from "./run-registry";
import { isProcAvailable, defaultRecoveryDeps } from "./proc";
import { decideRecovery, reapPids, type RecoveryDeps, type RecoveryRecord } from "./recovery-engine";
import type { Logger } from "./logging";

// Re-export the pure engine and the production wiring so existing importers
// (`index.ts`, the recovery/registry suites) keep their single entry point.
export * from "./recovery-engine";
export * from "./proc";

// ---------------------------------------------------------------------------
// Boot scan orchestration
// ---------------------------------------------------------------------------

/** Aggregate counts from one boot scan (also the shape the log line carries). */
export interface BootScanSummary {
	scanned: number;
	skipped: number;
	marked: number;
	reaped: number;
	/** Already-marked records that had leftover children reaped again this boot. */
	revisited: number;
	skippedUnverifiable: number;
	skippedNoOwner: number;
}

/** The all-zero summary (a skipped scan / an empty registry). */
export function emptyBootScanSummary(): BootScanSummary {
	return {
		scanned: 0,
		skipped: 0,
		marked: 0,
		reaped: 0,
		revisited: 0,
		skippedUnverifiable: 0,
		skippedNoOwner: 0,
	};
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
 *
 * Wait-once: every orphan pid across every record is reaped in ONE
 * SIGTERM → grace → SIGKILL window (the `reapActiveChildren` shape), so a boot
 * with N orphans is not an N × graceMs stall.
 */
export async function runBootScan(options: BootScanOptions): Promise<BootScanSummary> {
	const { records, deps, mark } = options;
	const nowIso = (options.now?.() ?? new Date()).toISOString();
	const summary = emptyBootScanSummary();
	summary.scanned = records.length;

	// Plan every record first (pure), then reap ALL proposed pids together —
	// including leftovers of already-marked records (never re-marked).
	const planned = records.map((record) => ({ record, plan: decideRecovery(record, deps) }));
	const allReaps = planned.flatMap(({ plan }) =>
		plan.decision === "mark" || plan.decision === "reap" ? plan.reap : [],
	);
	const survived = new Set(await reapPids(allReaps, deps));

	for (const { record, plan } of planned) {
		if (plan.decision === "mark") {
			mark(record, nowIso);
			// In-memory mark first: guarantees the scan is idempotent even when
			// the caller's write-back is append-only (run entries) or deferred.
			record.interruptedAt = nowIso;
			summary.marked++;
			const reaped = [...new Set(plan.reap)];
			summary.reaped += reaped.length;
			options.log?.warn("Recovery: marked interrupted record", {
				id: record.id,
				kind: record.kind,
				reason: plan.reason,
				reaped,
				survived: reaped.filter((pid) => survived.has(pid)),
			});
		} else if (plan.decision === "reap") {
			// B2 revisit: the record was already marked (so it is never re-marked),
			// but it still carried a live marker child — reap it again this boot.
			const reaped = [...new Set(plan.reap)];
			summary.revisited++;
			summary.reaped += reaped.length;
			options.log?.warn("Recovery: reaped a leftover child of an interrupted record", {
				id: record.id,
				kind: record.kind,
				reaped,
				survived: reaped.filter((pid) => survived.has(pid)),
			});
		} else {
			summary.skipped++;
			if (plan.reason === "ownership-unverifiable") summary.skippedUnverifiable++;
			if (plan.reason === "no-owner") summary.skippedNoOwner++;
			options.log?.debug("Recovery: left record untouched", {
				id: record.id,
				kind: record.kind,
				reason: plan.reason,
			});
		}
	}

	return summary;
}

// ---------------------------------------------------------------------------
// Registry-sourced scan (the production candidate source)
// ---------------------------------------------------------------------------

/** The subset of a persisted background agent record the scan reasons over. */
export interface PersistedAgentLike {
	status: string;
	interruptedAt?: string;
	owner?: RecoveryRecord["owner"];
	childMarker?: string;
}

export interface RegistryScanOptions {
	deps: RecoveryDeps;
	/** Persist the D3 mark for this record (registry entry; agent record for background). */
	mark(record: RecoveryRecord, interruptedAt: string): void;
	/**
	 * Read ONE background run's agent record by id (never the whole store).
	 * Returns null when the record is absent; absent defaults to an in-flight
	 * entry so a registry without an agent file is still marked, not skipped.
	 */
	readAgentRecord?(id: string): PersistedAgentLike | null;
	now?: () => Date;
	log?: Pick<Logger, "debug" | "info" | "warn">;
}

/**
 * The production boot scan: candidate runs come from the durable registry
 * (`listInflightRuns`), NOT from the current session's entries and NOT from a
 * full parse of `.pi/subagents/`. This is what makes detection work on pi's
 * default fresh startup after a conductor crash.
 *
 * Foreground/unit entries become `kind: "run"` candidates straight from the
 * registry; background entries become `kind: "agent"` candidates enriched by
 * reading THAT ONE agent file (so a stale registry entry whose agent record is
 * already terminal is dropped). Legacy records with no registry entry are
 * invisible here — consistent with the maintained `no-owner` policy (don't act
 * on what we cannot verify).
 */
export async function recoverInflightRuns(options: RegistryScanOptions): Promise<BootScanSummary> {
	const records: RecoveryRecord[] = [];
	for (const entry of listInflightRuns()) {
		if (entry.kind === "background") {
			const agent = options.readAgentRecord?.(entry.id) ?? null;
			if (agent && agent.status !== "running") continue;
			records.push({
				id: entry.id,
				kind: "agent",
				status: "running",
				interruptedAt: agent?.interruptedAt ?? entry.interruptedAt,
				owner: agent?.owner ?? entry.owner,
				childMarker: agent?.childMarker ?? entry.childMarker,
				source: entry,
			});
		} else {
			records.push({
				id: entry.id,
				kind: "run",
				status: "running",
				interruptedAt: entry.interruptedAt,
				owner: entry.owner,
				childMarker: entry.childMarker,
				source: entry,
			});
		}
	}
	return runBootScan({
		records,
		deps: options.deps,
		mark: options.mark,
		now: options.now,
		log: options.log,
	});
}

// ---------------------------------------------------------------------------
// Production entry (owns the /proc platform guard)
// ---------------------------------------------------------------------------

export interface ProductionRecoveryOptions {
	/** Process deps; defaults to the real /proc wiring (`defaultRecoveryDeps`). */
	deps?: RecoveryDeps;
	/** Persist the D3 mark for this record. */
	mark(record: RecoveryRecord, interruptedAt: string): void;
	readAgentRecord?(id: string): PersistedAgentLike | null;
	now?: () => Date;
	log?: Pick<Logger, "debug" | "info" | "warn">;
}

/**
 * The production boot-recovery entry. It owns the `/proc` platform guard so the
 * guarantee "nothing is marked or killed without /proc ownership verification"
 * is enforced — and testable — BELOW the extension entry point: on a platform
 * without `/proc` it returns an empty summary without scanning, instead of
 * relying on the caller's early return.
 */
export async function recoverProduction(options: ProductionRecoveryOptions): Promise<BootScanSummary> {
	if (!isProcAvailable()) {
		options.log?.info(
			"Boot recovery skipped: /proc start-token verification unavailable on this platform",
		);
		return emptyBootScanSummary();
	}
	return recoverInflightRuns({
		deps: options.deps ?? defaultRecoveryDeps(),
		mark: options.mark,
		readAgentRecord: options.readAgentRecord,
		now: options.now,
		log: options.log,
	});
}

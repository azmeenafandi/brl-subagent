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

import { listInflightRuns, type InflightRun } from "./run-registry";
import { assertSafeAgentId } from "./sanitize";
import { isProcAvailable, defaultRecoveryDeps } from "./proc";
import { decideRecovery, classifyOwner, reapPids, type RecoveryDeps, type RecoveryRecord } from "./recovery-engine";
import type { Logger } from "./logging";
import type { SubagentRun } from "./types";
import { PROMPT_NEVER_ISSUED_MESSAGE } from "./types";

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
	/** Records whose interruption mark was DURABLY written (issue #304). */
	marked: number;
	/** Records whose mark the engine decided but whose durable write failed (#304). */
	markFailures: number;
	reaped: number;
	/** Already-marked records that had leftover children reaped again this boot. */
	revisited: number;
	skippedUnverifiable: number;
	skippedNoOwner: number;
	/** Registry entries skipped fail-closed because their id failed the write guard. */
	skippedUnsafeIds: number;
	/**
	 * Issue #447: registry entries classified NEVER STARTED (`acceptedAt:
	 * null`) and settled `failed` instead of being offered as an interrupted,
	 * retryable run. Counted per FINALIZE attempt: an entry held back because its
	 * owner is still live (or unverifiable) is not counted, and a failed terminal
	 * write is warned — either way the entry stays out of the interrupted class.
	 */
	neverStarted: number;
}

/** The all-zero summary (a skipped scan / an empty registry). */
export function emptyBootScanSummary(): BootScanSummary {
	return {
		scanned: 0,
		skipped: 0,
		marked: 0,
		markFailures: 0,
		reaped: 0,
		revisited: 0,
		skippedUnverifiable: 0,
		skippedNoOwner: 0,
		skippedUnsafeIds: 0,
		neverStarted: 0,
	};
}

export interface BootScanOptions {
	records: RecoveryRecord[];
	deps: RecoveryDeps;
	/**
	 * Persist the D3 mark for this record (registry entry; agent record for
	 * background). Returns `false` when the durable write did NOT land — the scan
	 * then counts a `markFailure` instead of claiming `marked` (issue #304). A
	 * `void` return keeps the historical assume-success contract.
	 */
	mark(record: RecoveryRecord, interruptedAt: string): boolean | void;
	now?: () => Date;
	log?: Pick<Logger, "debug" | "info" | "warn">;
}

/**
 * The warning context shared by the two mark outcomes (issue #306 nit 3): the
 * record identity, why it was marked, which orphan pids were reaped, and which
 * of those survived the escalation. One construction so the "marked" and
 * "mark failed" warnings cannot drift apart.
 */
function markWarningPayload(
	record: RecoveryRecord,
	reason: string,
	reaped: number[],
	survived: ReadonlySet<number>,
): { id: string; kind: RecoveryRecord["kind"]; reason: string; reaped: number[]; survived: number[] } {
	return {
		id: record.id,
		kind: record.kind,
		reason,
		reaped,
		survived: reaped.filter((pid) => survived.has(pid)),
	};
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
	// #299 review Major 1: resolve each scanned pid back to the marker that
	// verified it, so the signal-time guard can re-read that marker before every
	// signal. First writer wins (a pid found by two records is still one identity).
	const markerByPid = new Map<number, string>();
	for (const { record, plan } of planned) {
		if (plan.decision !== "mark" && plan.decision !== "reap") continue;
		if (!record.childMarker) continue;
		for (const pid of plan.reap) if (!markerByPid.has(pid)) markerByPid.set(pid, record.childMarker);
	}
	const survived = new Set(
		await reapPids(allReaps, deps, (pid) => markerByPid.get(pid), (pid, signal, phase) =>
			options.log?.warn("Recovery: skipped a marker signal (pid no longer carries the run marker)", {
				pid,
				signal,
				phase,
				marker: markerByPid.get(pid),
			}),
		),
	);

	for (const { record, plan } of planned) {
		if (plan.decision === "mark") {
			const durable = mark(record, nowIso) !== false;
			// In-memory mark first: guarantees the scan is idempotent even when
			// the caller's write-back is append-only (run entries) or deferred.
			record.interruptedAt = nowIso;
			const reaped = [...new Set(plan.reap)];
			summary.reaped += reaped.length;
			const markWarning = markWarningPayload(record, plan.reason, reaped, survived);
			if (durable) {
				summary.marked++;
				options.log?.warn("Recovery: marked interrupted record", markWarning);
			} else {
				// Issue #304: the mark did NOT land. Count the failure and warn with
				// the id — this must be visible even when nothing was marked, so it
				// does not hide behind the caller's `summary.marked > 0` gate.
				summary.markFailures++;
				options.log?.warn("Recovery: registry mark failed", markWarning);
			}
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
	/**
	 * Issue #447: the acceptance marker, when the record carries one. Only the
	 * registry entry and the run entry write it today; this read keeps a record
	 * that DOES carry it authoritative (the entry is the fallback, not the
	 * override) — see `acceptanceState`.
	 */
	acceptedAt?: string | null;
	owner?: RecoveryRecord["owner"];
	childMarker?: string;
}

/**
 * Issue #447: the tri-state read of the acceptance marker. `undefined` is the
 * LEGACY/untracked state, and it must stay distinguishable from `null` (never
 * started) — which is why this is an explicit `!== undefined` probe and never
 * `??` (`null ?? agent` would silently reclassify every never-started entry as
 * accepted and bring the false positive straight back).
 */
function acceptanceState(
	entry: InflightRun,
	agent: PersistedAgentLike | null,
): string | null | undefined {
	if (entry.acceptedAt !== undefined) return entry.acceptedAt;
	return agent?.acceptedAt;
}

/**
 * The terminal `failed` record written for a dispatch that never reached the
 * prompt: the durable summary the entry already holds, stamped with the honest
 * reason. Projected here (next to the classification that decides it) so the
 * caller only has to persist what it is handed. Deliberately does NOT carry
 * `interruptedAt` — a never-started run is not an interrupted run, and the
 * recovery surface keys on that mark alone.
 */
export function neverStartedRunRecord(
	entry: InflightRun,
	finishedAt: string,
	reason: string = PROMPT_NEVER_ISSUED_MESSAGE,
): SubagentRun {
	return {
		id: entry.id,
		task: entry.task ?? "",
		...(entry.label !== undefined ? { label: entry.label } : {}),
		...(entry.dispatchId !== undefined ? { dispatchId: entry.dispatchId } : {}),
		...(entry.attempt !== undefined ? { attempt: entry.attempt } : {}),
		status: "failed",
		model: entry.model ?? "unknown",
		thinkingLevel: entry.thinkingLevel ?? "unknown",
		startedAt: entry.startedAt,
		finishedAt,
		errorCategory: "unknown",
		errorMessage: reason,
		...(entry.recoveryPosture !== undefined ? { recoveryPosture: entry.recoveryPosture } : {}),
		...(entry.originalParams !== undefined ? { originalParams: entry.originalParams } : {}),
		// The marker stays `null` on the terminal record: this run never accepted
		// the prompt, and the record must not claim otherwise after the fact.
		acceptedAt: null,
	};
}

export interface RegistryScanOptions {
	deps: RecoveryDeps;
	/**
	 * Persist the D3 mark for this record (registry entry; agent record for
	 * background). Returns `false` when the durable write did not land.
	 */
	mark(record: RecoveryRecord, interruptedAt: string): boolean | void;
	/**
	 * Issue #447: persist the terminal record of a dispatch that never reached
	 * the prompt (`acceptedAt: null`). Absent ⇒ the entry is left untouched —
	 * it is still never offered as interrupted, so the fail-closed direction is
	 * "no write", never "offer a retry".
	 */
	finalizeNeverStarted?(run: SubagentRun, reason: string): boolean | void;
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
	// Issue #304 read/write asymmetry, fail-closed: `listInflightRuns` accepts
	// any string id, but every write (and `markInterrupted`) resolves through
	// `assertSafeAgentId`. Acting on an entry the writer could never have
	// produced is unsafe, so SKIP those here — counted and reported in ONE log
	// line — instead of attempting a mark that would silently no-op.
	const addressable: InflightRun[] = [];
	const unsafeIds: string[] = [];
	for (const entry of listInflightRuns()) {
		try {
			assertSafeAgentId(entry.id);
			addressable.push(entry);
		} catch {
			unsafeIds.push(entry.id);
		}
	}
	if (unsafeIds.length > 0) {
		options.log?.warn("Recovery: skipped registry entries whose id fails the UUID guard", {
			count: unsafeIds.length,
			ids: unsafeIds,
		});
	}

	const records: RecoveryRecord[] = [];
	// Issue #447: `acceptedAt: null` = tracked but the prompt was never issued.
	// Such an entry is NOT a recovery candidate: nothing was started, so there
	// is nothing to reap, nothing to interrupt, and nothing to retry. It is
	// finalized `failed` below instead of being handed to the decision engine.
	const neverStarted: InflightRun[] = [];
	for (const entry of addressable) {
		const isBackground = entry.kind === "background";
		// Only a background entry has an agent record to enrich from (and to drop
		// a stale entry by); the read is that ONE file, never the whole store.
		const agent = isBackground ? (options.readAgentRecord?.(entry.id) ?? null) : null;
		if (agent && agent.status !== "running") continue;
		// Issue #447: ONE tri-state read for both kinds, so the `null` rule cannot
		// drift between the background and run branches.
		if (acceptanceState(entry, agent) === null) {
			neverStarted.push(entry);
			continue;
		}
		records.push({
			id: entry.id,
			kind: isBackground ? "agent" : "run",
			status: "running",
			interruptedAt: agent?.interruptedAt ?? entry.interruptedAt,
			owner: agent?.owner ?? entry.owner,
			childMarker: agent?.childMarker ?? entry.childMarker,
			source: entry,
		});
	}

	const now = options.now?.() ?? new Date();
	/** Entries this scan actually SETTLED (see `BootScanSummary.neverStarted`). */
	let settledNeverStarted = 0;
	for (const entry of neverStarted) {
		if (!options.finalizeNeverStarted) {
			options.log?.debug("Recovery: left a never-started dispatch untouched (no finalizer wired)", {
				id: entry.id,
				kind: entry.kind,
			});
			continue;
		}
		// A never-started entry is acted on ONLY when its owner is provably dead,
		// the same ownership rule the decision engine applies before it marks
		// anything. A LIVE owner may still be inside its own pre-start window (the
		// git-branch lock, a slow transcript start) and will write its acceptance
		// marker momentarily — finalizing it here would stamp a false `failed`
		// terminal record the run's real terminal entry could not outrank (the
		// store keeps the earlier entry, and readers prefer the LAST one). No owner or
		// an unverifiable one ⇒ no write, exactly as for the mark path.
		const owner = entry.owner;
		const ownerDead =
			!!owner &&
			Number.isInteger(owner.pid) &&
			owner.pid > 0 &&
			classifyOwner(owner, options.deps) === "dead";
		if (!ownerDead) {
			options.log?.debug("Recovery: left a never-started dispatch with a live/unverified owner", {
				id: entry.id,
				kind: entry.kind,
			});
			continue;
		}
		settledNeverStarted++;
		try {
			options.finalizeNeverStarted(
				neverStartedRunRecord(entry, now.toISOString()),
				PROMPT_NEVER_ISSUED_MESSAGE,
			);
			options.log?.info("Recovery: finalized a never-started dispatch as failed", {
				id: entry.id,
				kind: entry.kind,
			});
		} catch (err) {
			// Best-effort, exactly like the mark path: a failed finalize must not
			// abort the scan for the OTHER candidates. The registry entry is cleared
			// before the append lands (`persistRunRecord`), so the residue is gone
			// even when the terminal entry cannot be written.
			options.log?.warn("Recovery: never-started finalize failed", {
				id: entry.id,
				kind: entry.kind,
				error: (err as Error).message,
			});
		}
	}

	const summary = await runBootScan({
		records,
		deps: options.deps,
		mark: options.mark,
		now: options.now,
		log: options.log,
	});
	summary.skippedUnsafeIds = unsafeIds.length;
	summary.neverStarted = settledNeverStarted;
	return summary;
}

// ---------------------------------------------------------------------------
// Production entry (owns the /proc platform guard)
// ---------------------------------------------------------------------------

export interface ProductionRecoveryOptions {
	/** Process deps; defaults to the real /proc wiring (`defaultRecoveryDeps`). */
	deps?: RecoveryDeps;
	/** Persist the D3 mark for this record; `false` = the durable write failed. */
	mark(record: RecoveryRecord, interruptedAt: string): boolean | void;
	/** Issue #447: persist the terminal record of a never-started dispatch. */
	finalizeNeverStarted?(run: SubagentRun, reason: string): boolean | void;
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
		finalizeNeverStarted: options.finalizeNeverStarted,
		readAgentRecord: options.readAgentRecord,
		now: options.now,
		log: options.log,
	});
}

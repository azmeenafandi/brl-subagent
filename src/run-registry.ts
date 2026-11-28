// Purpose: Durable per-run in-flight registry + the single run-record persist choke point that mirrors into it.
/**
 * Option B U1 — durable in-flight run registry.
 *
 * A foreground/chain/parallel/graph run's `SubagentRun` record lives ONLY as a
 * session custom entry, so after a conductor crash a fresh process (pi's
 * default `SessionManager.create` startup) cannot see it at all. The agent
 * store (`.pi/subagents/<id>.json`) covers background runs only. This module
 * closes that gap: one small JSON per IN-FLIGHT run at the cwd-relative path
 * `.pi/run-registry/<runId>.json`, written before the run's effect and cleared
 * when it reaches a terminal state.
 *
 * `persistRunRecord` is the single choke point every run-record write goes
 * through (`state.persistRun` delegates here; the background path in
 * session-manager calls it directly). It mirrors the record into the registry:
 * a `running` record with a kind REGISTERS (or refreshes) an entry; a terminal
 * record CLEARS it; a `running` record without a kind is left alone (the boot
 * scan's `interruptedAt` mark is written through `markInterrupted`).
 *
 * WHERE THE INTERRUPTION MARK LIVES (commitment for U3): for foreground/unit
 * runs the registry entry IS the durable interruption mark — the boot scan
 * writes `interruptedAt` there, not into a session entry it cannot reach.
 * Background runs additionally mark their `.pi/subagents/<id>.json` agent
 * record (the existing double-mark). U3's interrupted-run surfacing reads the
 * registry.
 *
 * Reads are parse-tolerant and never throw on a malformed or vanished entry;
 * writes are atomic (temp file + rename) and owner-only (0o600), mirroring the
 * agent store's F6 discipline.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";
import {
	CUSTOM_ENTRY_TYPES,
	RECOVERY_MODES,
	RETRY_CAUSES,
	type ProcessOwner,
	type RecoveryMode,
	type RetryCause,
	type SubagentRun,
} from "./types";
import { assertSafeAgentId } from "./sanitize";
import { ensureOwnerOnlyDir } from "./store-permissions";

/** Which execution path owns an in-flight run (drives the boot scan's mark). */
export type InflightRunKind = "foreground" | "unit" | "background";

/**
 * The terminal status a `recordFlipPending` marker names (issue #546). This is
 * the AGENT-record vocabulary, not the run record's: a settled `done` run maps to
 * `completed` on the record. Only `failed` is written today (the pre-start path is
 * the one writer), and both values are validated on read.
 */
export type RecordFlipStatus = "failed" | "completed";

/**
 * Issue #546: the terminal status the dispatch was about to write onto its
 * agent record. Written into the registry entry BEFORE that entry is retired,
 * because retirement is an unlink — after it there is nothing left for a fresh
 * process to find, and the crash residue is a `running` agent record that no
 * boot scan can source a candidate for. The record flip ends the marker's
 * useful life: the entry is retired only once the flip is durable, so a marker
 * that outlives its entry means the flip did not land.
 *
 * Read fail-open: a marker that fails validation is dropped (normalizeEnrichment),
 * which degrades to the pre-#546 behaviour rather than inventing a flip.
 */
export interface RecordFlipPending {
	status: RecordFlipStatus;
	/** The error the flip was going to stamp (already sanitised by the caller). */
	error?: string;
	/** ISO stamp of the marker write (diagnostics only; ordering is the entry's). */
	at: string;
}

/** The durable per-run registry entry (one small JSON file per run id). */
export interface InflightRun {
	id: string;
	dispatchId?: string;
	attempt?: number;
	/**
	 * Issue #616: why this attempt exists (`transport` auto-retry vs a manual
	 * `retryRunId` retry). Mirrored from the run record so a stop that must
	 * resolve a retry from the registry alone (no agent record yet) can still
	 * scope itself. Absent = unknown, never `transport`.
	 */
	retryCause?: RetryCause;
	kind: InflightRunKind;
	owner?: ProcessOwner;
	childMarker?: string;
	// Option B U3 (D4): the recovery posture at dispatch, mirrored from the run
	// record so the durable mark and the boot notice agree. Additive (absent ⇒
	// "offer" on read).
	recoveryPosture?: RecoveryMode;
	// Foreground task persistence (O3): the run summary the U3 bridge restores
	// after a crash + fresh boot, when neither a session run entry nor a
	// background agent record exists. Additive — an entry written before this
	// lacks them and reads as absent (the notice's "(task unavailable)" path).
	task?: string;
	label?: string;
	model?: string;
	thinkingLevel?: string;
	// The exact `originalParams` snapshot `snapshotOriginalParams` put on the
	// run record, so a post-crash retry restores the same 17-field shape a
	// same-session retry does (including `force`; decision 2026-10-11).
	originalParams?: SubagentRun["originalParams"];
	/**
	 * Issue #546: the terminal flip this process had not yet written when it
	 * died. Absent on every terminal entry the live path retires normally; present
	 * only between the terminal run-entry write and the agent-record flip.
	 */
	recordFlipPending?: RecordFlipPending;
	/**
	 * Issue #447: the acceptance marker, mirrored from the run record.
	 * `null` = tracked but never accepted (never reached `session.prompt()`),
	 * ISO string = accepted, absent = legacy entry written before the field.
	 * The boot scan classifies on this tri-state (`recoverInflightRuns`).
	 */
	acceptedAt?: string | null;
	startedAt: string;
	cwd: string;
	interruptedAt?: string;
}

/** Fields accepted when registering/updating an entry (cwd defaults to the process cwd). */
export interface InflightRunInput {
	id: string;
	dispatchId?: string;
	attempt?: number;
	retryCause?: RetryCause;
	kind: InflightRunKind;
	owner?: ProcessOwner;
	childMarker?: string;
	recoveryPosture?: RecoveryMode;
	task?: string;
	label?: string;
	model?: string;
	thinkingLevel?: string;
	originalParams?: SubagentRun["originalParams"];
	acceptedAt?: string | null;
	/** Issue #546: a marker to write, or `null` to clear one (never `undefined`-clobbered). */
	recordFlipPending?: RecordFlipPending | null;
	startedAt: string;
	cwd?: string;
}

// ---------------------------------------------------------------------------
// Storage location
// ---------------------------------------------------------------------------

/**
 * Registry directory, cwd-relative like the agent store (`.pi/subagents`).
 * Test-only override, mirroring `__setStorageDir` — the shared temp-lifecycle
 * fixture points it at a throwaway dir.
 */
let REGISTRY_DIR = ".pi/run-registry";

/** TEST-ONLY: point the registry at an alternate directory. */
export function __setRegistryDir(dir: string): void {
	REGISTRY_DIR = dir;
}

/** The active registry directory (absolute or cwd-relative as configured). */
export function registryDir(): string {
	return REGISTRY_DIR;
}

// ---------------------------------------------------------------------------
// Paths + atomic IO
// ---------------------------------------------------------------------------

/**
 * Resolve an entry's file path, refusing anything that is not a safe UUID —
 * ids reach this module from records loaded off disk, and `path.join` does not
 * sanitize traversal segments (same F24 rule as the agent store).
 */
function resolvePath(id: string): string | null {
	try {
		assertSafeAgentId(id);
	} catch {
		return null;
	}
	return path.join(REGISTRY_DIR, `${id}.json`);
}

function ensureDir(): void {
	// Issue #408: `mode` only applies on CREATE — repair a pre-existing registry
	// dir on every write so the entries stay untraversable by other local users.
	ensureOwnerOnlyDir(REGISTRY_DIR);
}

/** True when `value` looks like a registry entry (id + kind + startedAt). */
function isInflightRun(value: unknown): value is InflightRun {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "string" || typeof v.startedAt !== "string") return false;
	if (v.recoveryPosture !== undefined) {
		if (!RECOVERY_MODES.includes(v.recoveryPosture as RecoveryMode)) return false;
	}
	return v.kind === "foreground" || v.kind === "unit" || v.kind === "background";
}

/** True when `value` is a well-formed `recordFlipPending` marker. */
function normalizeRecordFlipPending(value: unknown): RecordFlipPending | null {
	if (!value || typeof value !== "object") return null;
	const v = value as Record<string, unknown>;
	if (v.status !== "failed" && v.status !== "completed") return null;
	if (typeof v.at !== "string" || v.at === "") return null;
	if (v.error !== undefined && typeof v.error !== "string") return null;
	return {
		status: v.status,
		...(typeof v.error === "string" ? { error: v.error } : {}),
		at: v.at,
	};
}

/**
 * Normalize the additive enrichment fields leniently. A wrong-typed field
 * degrades to ABSENT on the parsed entry; the entry itself is never rejected
 * wholesale — dropping it would lose the interruption mark. This is the
 * deliberate opposite trade from the strict `recoveryPosture` check above
 * (a bad posture is semantically safe to drop; a bad task is not).
 */
function normalizeEnrichment(value: InflightRun, raw: Record<string, unknown>): InflightRun {
	const entry: InflightRun = { ...value };
	for (const field of ["task", "label", "model", "thinkingLevel"] as const) {
		if (typeof raw[field] === "string") entry[field] = raw[field] as string;
		else delete entry[field];
	}
	if (raw.originalParams && typeof raw.originalParams === "object" && !Array.isArray(raw.originalParams)) {
		entry.originalParams = raw.originalParams as SubagentRun["originalParams"];
	} else {
		delete entry.originalParams;
	}
	// Issue #616: same lenient rule — a cause we cannot trust is DROPPED (absent ⇒
	// unknown ⇒ never auto-stopped), never coerced to the stop-scoped value.
	if (typeof raw.retryCause === "string" && (RETRY_CAUSES as readonly string[]).includes(raw.retryCause)) {
		entry.retryCause = raw.retryCause as RetryCause;
	} else {
		delete entry.retryCause;
	}
	// Issue #447: keep the tri-state intact and treat anything else as LEGACY
	// (absent) rather than inventing a fourth state. A mistyped marker must
	// never downgrade a real run into the never-started class.
	if (raw.acceptedAt === null || typeof raw.acceptedAt === "string") {
		entry.acceptedAt = raw.acceptedAt;
	} else {
		delete entry.acceptedAt;
	}
	// Issue #546: same lenient rule as the fields above — a mistyped marker is
	// dropped, never invented. Dropping it degrades to the pre-#546 residue (a
	// stale `running` record), which is strictly safer than flipping a record on
	// a marker we cannot trust.
	const flip = normalizeRecordFlipPending(raw.recordFlipPending);
	if (flip) entry.recordFlipPending = flip;
	else delete entry.recordFlipPending;
	return entry;
}

/** Parse one entry file; null on missing/corrupt/malformed. */
function readEntry(file: string): InflightRun | null {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
		if (!isInflightRun(parsed)) return null;
		// `isInflightRun` narrows to InflightRun, but the raw object may carry
		// extra/mistyped additive fields — read them through a record view.
		return normalizeEnrichment(parsed, parsed as unknown as Record<string, unknown>);
	} catch {
		return null;
	}
}

/** Atomic, owner-only write: temp file in the same directory, then rename. */
function writeAtomic(file: string, entry: InflightRun): boolean {
	try {
		ensureDir();
		const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		fs.writeFileSync(tmp, JSON.stringify(entry, null, 2), { encoding: "utf-8", mode: 0o600 });
		fs.renameSync(tmp, file);
		return true;
	} catch {
		return false;
	}
}

/** Copy only defined fields from an input onto an entry (never clobber with undefined). */
function mergeInput(base: InflightRun, input: InflightRunInput): InflightRun {
	const next: InflightRun = { ...base, id: input.id, kind: input.kind };
	if (input.dispatchId !== undefined) next.dispatchId = input.dispatchId;
	if (input.attempt !== undefined) next.attempt = input.attempt;
	if (input.retryCause !== undefined) next.retryCause = input.retryCause;
	if (input.recoveryPosture !== undefined) next.recoveryPosture = input.recoveryPosture;
	if (input.owner !== undefined) next.owner = input.owner;
	if (input.childMarker !== undefined) next.childMarker = input.childMarker;
	if (input.startedAt) next.startedAt = input.startedAt;
	if (input.cwd !== undefined) next.cwd = input.cwd;
	if (input.task !== undefined) next.task = input.task;
	if (input.label !== undefined) next.label = input.label;
	if (input.model !== undefined) next.model = input.model;
	if (input.thinkingLevel !== undefined) next.thinkingLevel = input.thinkingLevel;
	if (input.originalParams !== undefined) next.originalParams = input.originalParams;
	// Issue #447: `null` MUST copy (it is the never-started sentinel); only
	// `undefined` is skipped, so a refresh without the marker cannot erase it.
	if (input.acceptedAt !== undefined) next.acceptedAt = input.acceptedAt;
	// Issue #546: `null` is the explicit CLEAR (mirroring `acceptedAt`); only
	// `undefined` is skipped, so a refresh cannot erase a live marker.
	if (input.recordFlipPending === null) delete next.recordFlipPending;
	else if (input.recordFlipPending !== undefined) next.recordFlipPending = input.recordFlipPending;
	return next;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Register (or refresh) an in-flight run. A re-register preserves an existing
 * `interruptedAt` so a later write cannot erase a boot-scan mark.
 */
export function registerInflightRun(input: InflightRunInput): boolean {
	const file = resolvePath(input.id);
	if (!file) return false;
	const existing = readEntry(file);
	const entry: InflightRun = {
		...mergeInput(existing ?? { id: input.id, kind: input.kind, startedAt: input.startedAt, cwd: input.cwd ?? process.cwd() }, input),
	};
	return writeAtomic(file, entry);
}

/**
 * Merge a defined-field patch into an existing entry. A missing entry is left
 * missing (registration is `registerInflightRun`'s job, so a stray update can
 * never resurrect a cleared run).
 */
export function updateInflightRun(input: InflightRunInput): boolean {
	const file = resolvePath(input.id);
	if (!file) return false;
	const existing = readEntry(file);
	if (!existing) return false;
	return writeAtomic(file, mergeInput(existing, input));
}

/**
 * Remove an entry (terminal finalize). Missing file is a no-op.
 *
 * Issue #546 (major 4): returns whether the DESIRED END STATE holds — `true`
 * when the file is gone (unlinked now, or never there), `false` when it still
 * exists after the attempt (`EACCES`/`EPERM`/`EBUSY`, or a racing writer that
 * re-created it). Existing callers ignore the value; the boot applier does not:
 * an unverified retirement would report a settled marker while the marker is
 * still on disk, so `false` is counted as a flip failure and the entry is kept.
 */
export function clearInflightRun(id: string): boolean {
	const file = resolvePath(id);
	if (!file) return true; // nothing addressable to remove
	try {
		fs.unlinkSync(file);
		return true;
	} catch (err) {
		// Only ENOENT proves the desired end state. Any OTHER error (EACCES on the
		// file or on an untraversable parent, EPERM, EBUSY, EROFS) does not — an
		// `existsSync` here returns false for both "gone" and "cannot look", which
		// is how a failed unlink was reported as a settlement (r2 major 1).
		if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;
		try {
			fs.statSync(file);
			return false; // confirmed: the entry is still there
		} catch (statErr) {
			// An untraversable parent is UNCERTAIN, not absent: fail closed so the
			// caller keeps the marker for a boot that can actually look.
			return (statErr as NodeJS.ErrnoException).code === "ENOENT";
		}
	}
}

/** Every parseable in-flight entry; [] when the registry is absent. */
export function listInflightRuns(): InflightRun[] {
	let files: string[];
	try {
		files = fs.readdirSync(REGISTRY_DIR);
	} catch {
		return [];
	}
	const entries: InflightRun[] = [];
	for (const file of files) {
		if (!file.endsWith(".json")) continue;
		const entry = readEntry(path.join(REGISTRY_DIR, file));
		if (entry) entries.push(entry);
	}
	return entries;
}

/**
 * Write the D3 `interruptedAt` mark onto an existing entry. Idempotent; returns
 * false when the entry is absent, its id fails the write guard, or the write
 * fails. Issue #304: this MUST never throw — the boot scan treats a false as a
 * durable-write failure and counts it, whereas a thrown FS error would abort
 * the whole scan via `performBootRecovery`'s catch-all. The boolean is the
 * only truthful success signal, so callers must not assume the mark landed.
 */
export function markInterrupted(id: string, interruptedAt: string): boolean {
	try {
		const file = resolvePath(id);
		if (!file) return false;
		const existing = readEntry(file);
		if (!existing) return false;
		if (existing.interruptedAt) return true;
		return writeAtomic(file, { ...existing, interruptedAt });
	} catch {
		// Belt-and-braces: the inner read/write helpers already swallow FS errors,
		// but the scan's no-throw contract must not depend on that staying true.
		return false;
	}
}

/**
 * Issue #546: write the terminal-flip marker onto an EXISTING entry — the call
 * that has to happen before the entry is retired, because retirement is an
 * unlink and the marker must survive it.
 *
 * Idempotent and total, with the same contract as `markInterrupted`: a missing
 * entry, an id that fails the write guard, or a failed write returns `false` and
 * never throws (a throwing pre-start cleanup would replace the caller's original
 * spawn error). `false` is the only truthful signal, so callers must not assume
 * the marker landed.
 */
export function markRecordFlipPending(id: string, flip: RecordFlipPending): boolean {
	try {
		const file = resolvePath(id);
		if (!file) return false;
		const existing = readEntry(file);
		if (!existing) return false;
		if (existing.recordFlipPending) return true;
		return writeAtomic(file, { ...existing, recordFlipPending: flip });
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// The persistence choke point
// ---------------------------------------------------------------------------

/** Project a run record into the registry input shape. */
function toRegistryInput(run: SubagentRun, kind: InflightRunKind): InflightRunInput {
	return {
		id: run.id,
		dispatchId: run.dispatchId,
		attempt: run.attempt,
		retryCause: run.retryCause,
		kind,
		recoveryPosture: run.recoveryPosture,
		owner: run.owner,
		childMarker: run.childMarker,
		task: run.task,
		label: run.label,
		model: run.model,
		thinkingLevel: run.thinkingLevel,
		originalParams: run.originalParams,
		acceptedAt: run.acceptedAt,
		startedAt: run.startedAt,
		cwd: process.cwd(),
	};
}

/**
 * The ONE run-record writer: append the session entry AND keep the registry in
 * lockstep. `state.persistRun` delegates here and the background path calls it
 * directly, so every write site is mirrored by construction.
 *
 * `kind` is required only at dispatch (`running`); terminal writes clear the
 * registry and ignore it. A `running` write without a kind is a refresh with
 * nothing to register — the boot scan's mark is a separate `markInterrupted`.
 */
export interface PersistRunRecordOptions {
	/**
	 * Issue #546: leave the registry entry in place and make the CALLER its owner
	 * (it retires with `clearInflightRun` once the agent-record flip is durable).
	 * Retirement-before-append is what makes a crash inside this function leave a
	 * residue no boot scan can source a candidate for; the pre-start terminal path
	 * is the one caller that must not take it, and it is the only caller that
	 * passes this flag. Every other writer keeps the historical order.
	 */
	deferRetire?: boolean;
}

export function persistRunRecord(
	pi: ExtensionAPI,
	run: SubagentRun,
	kind?: InflightRunKind,
	options?: PersistRunRecordOptions,
): void {
	if (run.status !== "running") {
		if (!options?.deferRetire) clearInflightRun(run.id);
	} else if (kind) {
		registerInflightRun(toRegistryInput(run, kind));
	}
	pi.appendEntry(CUSTOM_ENTRY_TYPES.run, run);
}

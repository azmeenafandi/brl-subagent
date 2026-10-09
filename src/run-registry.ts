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

import * as fs from "node:fs";
import * as path from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { ProcessOwner, SubagentRun } from "./types";
import { CUSTOM_ENTRY_TYPES } from "./types";
import { assertSafeAgentId } from "./sanitize";

/** Which execution path owns an in-flight run (drives the boot scan's mark). */
export type InflightRunKind = "foreground" | "unit" | "background";

/** The durable per-run registry entry (one small JSON file per run id). */
export interface InflightRun {
	id: string;
	dispatchId?: string;
	attempt?: number;
	kind: InflightRunKind;
	owner?: ProcessOwner;
	childMarker?: string;
	startedAt: string;
	cwd: string;
	interruptedAt?: string;
}

/** Fields accepted when registering/updating an entry (cwd defaults to the process cwd). */
export interface InflightRunInput {
	id: string;
	dispatchId?: string;
	attempt?: number;
	kind: InflightRunKind;
	owner?: ProcessOwner;
	childMarker?: string;
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
	fs.mkdirSync(REGISTRY_DIR, { recursive: true, mode: 0o700 });
}

/** True when `value` looks like a registry entry (id + kind + startedAt). */
function isInflightRun(value: unknown): value is InflightRun {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "string" || typeof v.startedAt !== "string") return false;
	return v.kind === "foreground" || v.kind === "unit" || v.kind === "background";
}

/** Parse one entry file; null on missing/corrupt/malformed. */
function readEntry(file: string): InflightRun | null {
	try {
		const parsed: unknown = JSON.parse(fs.readFileSync(file, "utf-8"));
		return isInflightRun(parsed) ? parsed : null;
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
	if (input.owner !== undefined) next.owner = input.owner;
	if (input.childMarker !== undefined) next.childMarker = input.childMarker;
	if (input.startedAt) next.startedAt = input.startedAt;
	if (input.cwd !== undefined) next.cwd = input.cwd;
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

/** Remove an entry (terminal finalize). Missing file is a no-op. */
export function clearInflightRun(id: string): void {
	const file = resolvePath(id);
	if (!file) return;
	try {
		fs.unlinkSync(file);
	} catch {
		// Already cleared (or never registered) — the desired end state.
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

// ---------------------------------------------------------------------------
// The persistence choke point
// ---------------------------------------------------------------------------

/** Project a run record into the registry input shape. */
function toRegistryInput(run: SubagentRun, kind: InflightRunKind): InflightRunInput {
	return {
		id: run.id,
		dispatchId: run.dispatchId,
		attempt: run.attempt,
		kind,
		owner: run.owner,
		childMarker: run.childMarker,
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
export function persistRunRecord(pi: ExtensionAPI, run: SubagentRun, kind?: InflightRunKind): void {
	if (run.status !== "running") {
		clearInflightRun(run.id);
	} else if (kind) {
		registerInflightRun(toRegistryInput(run, kind));
	}
	pi.appendEntry(CUSTOM_ENTRY_TYPES.run, run);
}

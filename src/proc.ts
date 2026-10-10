// Purpose: Production process primitives — Linux/POSIX /proc reads, feature detection, and the default recovery deps.
/**
 * Option B U1 — production process wiring for the recovery engine.
 *
 * The recovery decision engine (`src/recovery-engine.ts`) is pure over the
 * injected `RecoveryDeps`. This module supplies the REAL deps: the Linux/POSIX
 * `/proc` start-time token (`/proc/<pid>/stat` field 22), the child-marker scan
 * (`/proc/<pid>/environ`), cross-platform pid liveness, and the default
 * `RecoveryDeps` assembly.
 *
 * PLATFORM BOUNDARY (required): the start token and marker scan are Linux/POSIX
 * reads. `isProcAvailable()` feature-detects them (cached; the answer cannot
 * change mid-process). Where they are unavailable, `pidAlive` still works but
 * on its own cannot rule out pid reuse — so the boot scan skips entirely and
 * nothing is killed or marked unverified (`recoverProduction`, src/recovery.ts).
 *
 * `__setProcAvailableForTest` is the injectable seam that lets a test exercise
 * that platform guard without mocking `node:fs` module-wide.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { ProcessOwner } from "./types";
import { SIGKILL_GRACE_MS, SIGKILL_POLL_MS } from "./types";
import { CHILD_MARKER_ENV_KEY } from "./sanitize";
import type { RecoveryDeps } from "./recovery-engine";
import { supportsProcessGroupKill } from "./kill-escalation";

const PROC_ROOT = "/proc";

let procAvailable: boolean | undefined;
let procAvailableOverride: boolean | undefined;

/**
 * TEST-ONLY: force the `/proc` feature-detection answer (undefined restores the
 * real detection and clears the cache). The production scan consults this
 * through `isProcAvailable`, so the platform guard is exercisable in-repo.
 */
export function __setProcAvailableForTest(value: boolean | undefined): void {
	procAvailableOverride = value;
	procAvailable = undefined;
}

/**
 * Feature-detect the Linux/POSIX `/proc` surface this module needs. Cached:
 * the answer cannot change mid-process. Exported so the entry point can skip
 * the whole scan with one log line on platforms without /proc.
 */
export function isProcAvailable(): boolean {
	if (procAvailableOverride !== undefined) return procAvailableOverride;
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
 * The whitespace-split `/proc/<pid>/stat` fields AFTER the `(comm)` field, or
 * undefined when /proc is unavailable, the pid is invalid, or the process
 * vanished. Shared by the start-token, process-group and group-liveness readers.
 * The comm field is skipped by slicing at the LAST `)` so a name containing
 * spaces or parens cannot shift the parse.
 */
function readStatFields(pid: number): string[] | undefined {
	if (!isProcAvailable() || !Number.isInteger(pid) || pid <= 0) return undefined;
	try {
		const stat = fs.readFileSync(path.join(PROC_ROOT, String(pid), "stat"), "utf-8");
		const close = stat.lastIndexOf(")");
		if (close < 0) return undefined;
		const rest = stat.slice(close + 1).trim();
		if (!rest) return undefined;
		return rest.split(/\s+/);
	} catch {
		return undefined;
	}
}

/**
 * Read a process's start-time token — `/proc/<pid>/stat` field 22 (1-indexed),
 * i.e. index 19 of the whitespace-split fields AFTER the `(comm)` field.
 * Returns undefined when /proc is unavailable, the pid is invalid, or the
 * process vanished.
 */
export function readStartToken(pid: number): string | undefined {
	const token = readStatFields(pid)?.[19];
	return token && /^\d+$/.test(token) ? token : undefined;
}

/**
 * Read a process's process-group id — `/proc/<pid>/stat` field 5 (index 2 after
 * `(comm)`). Returns undefined when /proc is unavailable, the pid is invalid, or
 * the process vanished.
 */
export function readProcessGroup(pid: number): number | undefined {
	const pgid = Number(readStatFields(pid)?.[2]);
	return Number.isInteger(pgid) && pgid > 0 ? pgid : undefined;
}

/**
 * #299 review Major 2 — does the process group `pgid` still have a LIVE member?
 * Scans `/proc` for processes whose pgrp (field 5) equals `pgid`, skipping the
 * leader itself and zombies (`Z`/`X` state — an unreaped corpse is not a live
 * member and must not hold the group non-empty). A group's leader exiting does
 * NOT empty the group, so this is what lets `escalateKill` keep waiting for a
 * member's cleanup window. Returns false when /proc is unavailable — callers
 * then fall back to leader liveness (the documented non-Linux boundary).
 */
export function groupHasMembers(pgid: number): boolean {
	if (!Number.isInteger(pgid) || pgid <= 0 || !isProcAvailable()) return false;
	let entries: string[];
	try {
		entries = fs.readdirSync(PROC_ROOT);
	} catch {
		return false;
	}
	for (const entry of entries) {
		if (!/^\d+$/.test(entry)) continue;
		const pid = Number(entry);
		if (pid === pgid) continue; // the leader (possibly a zombie) is not a member
		const fields = readStatFields(pid);
		if (!fields) continue;
		if (fields[0] === "Z" || fields[0] === "X") continue;
		if (Number(fields[2]) === pgid) return true;
	}
	return false;
}

/**
 * #299 review Major 1 — signal-time identity re-check. True only when the LIVE
 * process `pid` carries `CHILD_MARKER_ENV_KEY=<marker>` in its environment.
 * `findByMarker` proves the pid was ours at SCAN time; this proves it is ours at
 * the SIGNAL time, closing the scan→signal pid-reuse window (a pid that exited
 * and was reused by a foreign process no longer carries the marker). Returns
 * false when /proc is unavailable, the pid is invalid, or the process vanished.
 *
 * RESIDUAL: this narrows the reuse window to the read→`kill` syscall boundary —
 * the same exposure the direct signals have carried since Option A. It does NOT
 * eliminate it (the kernel may reuse the pid between this read and the signal).
 */
export function pidHasMarker(pid: number, marker: string): boolean {
	if (!marker || !isProcAvailable() || !Number.isInteger(pid) || pid <= 0) return false;
	const needle = `${CHILD_MARKER_ENV_KEY}=${marker}`;
	try {
		const environ = fs.readFileSync(path.join(PROC_ROOT, String(pid), "environ"), "utf-8");
		return environ.split("\0").includes(needle);
	} catch {
		return false;
	}
}

/** The CURRENT process's owner identity (pid + start token; empty string when unavailable). */
export function currentProcessOwner(): ProcessOwner {
	return { pid: process.pid, start: readStartToken(process.pid) ?? "" };
}

/**
 * #299 D4: best-effort process-group signal (`kill(-pgid, sig)`). ESRCH means
 * the group is already empty — the desired end state, so it is swallowed. On a
 * platform without process groups the caller does not wire this in at all
 * (`defaultRecoveryDeps`).
 */
export function killProcessGroup(pgid: number, signal: NodeJS.Signals): void {
	try {
		process.kill(-pgid, signal);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
	}
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
 * #299 review Major 1: true when the pid is GONE — it no longer exists OR is a
 * not-yet-reaped zombie (`Z`/`X`), which `pidAlive` (kill -0) still reports as
 * alive. The signal-time guard uses this to separate a REUSED pid (alive, marker
 * gone) from a merely dead/zombie one, so a zombie leader's pgid is still
 * signaled to reach its surviving members (D5). Without /proc the zombie
 * distinction is unavailable and this degrades to `!pidAlive`.
 */
export function pidGone(pid: number): boolean {
	if (!pidAlive(pid)) return true;
	const state = readStatFields(pid)?.[0];
	return state === "Z" || state === "X";
}

/**
 * Pids whose environment carries the marker. Scans `/proc/<pid>/environ` (NUL
 * separated). Skips this process; unreadable/vanished processes are ignored.
 * Returns [] — never a kill — when /proc is unavailable.
 */
export function findByMarker(marker: string): number[] {
	if (!marker || !isProcAvailable()) return [];
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
		if (pidHasMarker(pid, marker)) found.push(pid);
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
		// D4 (#299): group-reaching targets on POSIX. The marker identifies the
		// orphan tree; the process group is only the kill mechanism that reaches
		// env-scrubbed descendants. Omitted on Windows (D6) so `reapPids` keeps
		// today's direct pid targets.
		killGroup: supportsProcessGroupKill() ? killProcessGroup : undefined,
		// #299 review Major 2: a group's leader exiting does not empty the group,
		// so the group target's death check counts live members.
		groupHasMembers,
		// #299 review Major 1: signal-time marker re-check for marker-derived
		// targets (closes the scan→signal pid-reuse window).
		verifyMarker: pidHasMarker,
		// #299 review Major 1: the guard separates a reused pid (alive, marker
		// gone) from a dead/zombie one, so a zombie leader's group is still killed.
		pidGone,
		sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
		graceMs: SIGKILL_GRACE_MS,
		// Item 4 (#299): poll so the boot scan returns as soon as its orphans die
		// instead of always blocking the full grace window (a ~5 s session_start).
		pollMs: SIGKILL_POLL_MS,
	};
}

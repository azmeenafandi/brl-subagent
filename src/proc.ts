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
import { SIGKILL_GRACE_MS } from "./types";
import { CHILD_MARKER_ENV_KEY } from "./sanitize";
import type { RecoveryDeps } from "./recovery-engine";

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

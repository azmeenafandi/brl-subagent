// Purpose: The one SIGTERM → grace → SIGKILL escalation shared by foreground reap, abort/timeout, and boot recovery.
/**
 * Process kill escalation (Option B U1, review items B4 + B7).
 *
 * The SIGTERM → grace → SIGKILL sequence was duplicated four times with
 * inconsistent wait semantics. This module owns the ONE sequence; each site
 * supplies its own targets and death check:
 *
 *   - `runner.ts` `reapActiveChildren` — every tracked foreground child at once
 *   - `runner.ts` abort handler          — one child
 *   - `runner.ts` timeout handler        — one child
 *   - `recovery.ts` `reapPids`           — every marker-verified orphan at once
 *
 * Order is terminate → wait → force-kill. With `pollMs` set the wait ends as
 * soon as every target verifies dead (B4: the shutdown reap no longer blocks
 * the full 5 s when children exit promptly), bounded by `graceMs`; without it
 * the helper waits the full grace once (the boot scan's wait-once shape).
 *
 * `verifyDeath` is supplied per site but must always answer "is the process
 * REALLY dead" — for a child, `exitCode`/`signalCode`; for a pid, `kill -0`
 * liveness. It must never be a "a signal was delivered" check: `child.killed`
 * flips when SIGTERM is SENT, so gating SIGKILL on it skips escalation for a
 * SIGTERM-ignoring child (issue #303). What is shared is the
 * terminate-then-escalate order and the no-throw-on-vanished discipline.
 *
 * #299 Option B adds two target shapes and one sequence addition:
 *   - `groupTarget` signals the process GROUP best-effort AND the pid directly
 *     (D2/D3) — the group catches env-scrubbed descendants the marker cannot;
 *     the direct signal is never replaced (a `#322` non-detached child has no
 *     group of its own, so `-pid` is ESRCH while the direct signal still lands).
 *   - `processTarget` picks the group shape when a `killGroup` primitive is
 *     supplied (POSIX; D4), else the direct-only `pidTarget` (Windows; D6).
 *   - after the grace window `escalateKill` calls an optional `forceKillGroup`
 *     UNCONDITIONALLY (D5), so a TERM-stubborn member survives neither the
 *     leader exiting early nor the leader-based survivor check.
 */

/** A process handle the escalation helper can signal and liveness-check. */
export interface EscalationTarget {
	/** Send SIGTERM; may throw when the target is already gone. */
	terminate(): void;
	/** Send SIGKILL; may throw when the target is already gone. */
	forceKill(): void;
	/** True when the target is confirmed dead (so no SIGKILL is needed). */
	verifyDeath(): boolean;
	/**
	 * #299 Option B D5: optional UNCONDITIONAL final group SIGKILL, called for
	 * every target after the grace window even when `verifyDeath()` reports the
	 * leader dead. A group target's `verifyDeath` is leader-based, so a
	 * TERM-stubborn member whose group leader already exited would otherwise
	 * never be force-killed. Must tolerate ESRCH (a vanished/empty group is the
	 * desired end state). Absent on direct-only pid targets.
	 */
	forceKillGroup?(): void;
}

/**
 * True when the platform offers POSIX process groups: `detached: true` makes a
 * child a session/group leader and `kill(-pgid)` signals the whole group.
 * Windows has neither, so every group path falls back to direct signals (D6).
 *
 * `__setProcessGroupKillSupportedForTest` is the injectable seam that lets a
 * test prove the Windows fallback without running on Windows.
 */
let processGroupKillOverride: boolean | undefined;

export function supportsProcessGroupKill(): boolean {
	if (processGroupKillOverride !== undefined) return processGroupKillOverride;
	return process.platform !== "win32";
}

/**
 * TEST-ONLY: force the process-group capability answer (undefined restores real
 * platform detection), mirroring `__setProcAvailableForTest` in `src/proc.ts`.
 */
export function __setProcessGroupKillSupportedForTest(value: boolean | undefined): void {
	processGroupKillOverride = value;
}

/**
 * Build the `EscalationTarget` for ONE pid from injected kill/liveness
 * primitives. Shared by the boot-scan reap (`reapPids`) and the marker sweeps
 * (`reapActiveChildren`, the run-exit sweep) so the pid-target shape —
 * SIGTERM, SIGKILL, `verifyDeath` = pid-not-alive — cannot drift between sites.
 */
export function pidTarget(
	pid: number,
	kill: (pid: number, signal: NodeJS.Signals) => void,
	pidAlive: (pid: number) => boolean,
): EscalationTarget {
	return {
		terminate: () => {
			kill(pid, "SIGTERM");
		},
		forceKill: () => {
			kill(pid, "SIGKILL");
		},
		verifyDeath: () => !pidAlive(pid),
	};
}

/** Best-effort group signal: a vanished/empty group (ESRCH) is success. */
function bestEffortGroupKill(
	killGroup: (pgid: number, signal: NodeJS.Signals) => void,
	pgid: number,
	signal: NodeJS.Signals,
): void {
	try {
		killGroup(pgid, signal);
	} catch {
		// Best-effort per D2/D3: the group may not exist (a non-detached target,
		// or a leader that already exited). The direct signal is never skipped.
	}
}

/**
 * #299 Option B D2/D3: build a GROUP-reaching target for one pid — signal the
 * process group (`kill(-pid)`) best-effort AND the pid directly. The direct
 * signal is never replaced: a `#322` test-seam child may not be a group leader,
 * so `-pid` names no group (ESRCH) while the direct signal still lands.
 *
 * `verifyDeath` stays pid-based (the leader/child the caller tracks); the
 * unconditional `forceKillGroup` below is what catches a stubborn GROUP member
 * after the leader is gone (D5).
 */
export function groupTarget(
	pid: number,
	kill: (pid: number, signal: NodeJS.Signals) => void,
	killGroup: (pgid: number, signal: NodeJS.Signals) => void,
	pidAlive: (pid: number) => boolean,
): EscalationTarget {
	return {
		terminate: () => {
			bestEffortGroupKill(killGroup, pid, "SIGTERM");
			kill(pid, "SIGTERM");
		},
		forceKill: () => {
			bestEffortGroupKill(killGroup, pid, "SIGKILL");
			kill(pid, "SIGKILL");
		},
		verifyDeath: () => !pidAlive(pid),
		forceKillGroup: () => {
			bestEffortGroupKill(killGroup, pid, "SIGKILL");
		},
	};
}

/**
 * Choose the group-reaching target when a group primitive is available (POSIX;
 * D4), else the direct-only `pidTarget` (Windows fallback; D6). The presence of
 * `killGroup` IS the capability gate — callers pass it only where supported.
 */
export function processTarget(
	pid: number,
	kill: (pid: number, signal: NodeJS.Signals) => void,
	pidAlive: (pid: number) => boolean,
	killGroup?: (pgid: number, signal: NodeJS.Signals) => void,
): EscalationTarget {
	return killGroup ? groupTarget(pid, kill, killGroup, pidAlive) : pidTarget(pid, kill, pidAlive);
}

export interface EscalationOptions {
	/** Grace window between SIGTERM and SIGKILL (ms). */
	graceMs: number;
	/** Sleep between SIGTERM and the liveness re-check (injectable). */
	sleep(ms: number): Promise<void>;
	/**
	 * Poll interval for the early-exit wait (B4). When > 0 the helper returns as
	 * soon as every target verifies dead, bounded by `graceMs`; when omitted the
	 * helper waits the full `graceMs` once.
	 */
	pollMs?: number;
	/** Injectable clock for the deadline (defaults to Date.now). */
	now?(): number;
}

/**
 * Escalate every target together: SIGTERM all, wait (at most) one grace window,
 * then SIGKILL every target that still verifies alive. Returns the survivors.
 * Never throws on a target that vanished mid-sequence.
 */
export async function escalateKill(
	targets: EscalationTarget[],
	options: EscalationOptions,
): Promise<EscalationTarget[]> {
	for (const target of targets) {
		try {
			target.terminate();
		} catch {
			// Already gone — the desired end state.
		}
	}

	if (targets.length > 0) {
		const pollMs = options.pollMs ?? 0;
		if (pollMs > 0) {
			const now = options.now ?? Date.now;
			const deadline = now() + options.graceMs;
			while (now() < deadline && !targets.every((target) => target.verifyDeath())) {
				const remaining = Math.max(deadline - now(), 1);
				await options.sleep(Math.min(pollMs, remaining));
			}
		} else {
			await options.sleep(options.graceMs);
		}
	}

	const survivors: EscalationTarget[] = [];
	for (const target of targets) {
		if (target.verifyDeath()) continue;
		try {
			target.forceKill();
		} catch {
			// Exited between the liveness check and the signal.
		}
		if (!target.verifyDeath()) survivors.push(target);
	}

	// D5 (option b): the final GROUP SIGKILL is UNCONDITIONAL. A group target's
	// `verifyDeath` is leader-based, so a TERM-stubborn member whose leader has
	// already exited would otherwise never reach SIGKILL. Group targets swallow
	// ESRCH; pid targets have no `forceKillGroup` and are untouched.
	for (const target of targets) {
		if (!target.forceKillGroup) continue;
		try {
			target.forceKillGroup();
		} catch {
			// Vanished group — the desired end state.
		}
	}
	return survivors;
}

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
 *
 * #299 REVIEW FIX (review round on `62e2537`) closes the two majors:
 *   - Major 1 (pid reuse): a marker pid verified by a `/proc` scan at SCAN time
 *     may exit and be reused before the signal. `SignalGuard` re-reads the live
 *     marker IMMEDIATELY before every marker-derived signal; a pid that is alive
 *     but no longer carries the marker (the reuse case) is never signaled, group
 *     or direct. The residual read→`kill` window is documented on the guard.
 *   - Major 2 (grace bypassed): a group target's `verifyDeath` is now LEADER DEAD
 *     **AND** GROUP EMPTY (`groupHasMembers`), so a dead leader no longer reads
 *     as "all dead" and the escalation honours the grace window for a member's
 *     cleanup. The unconditional `forceKillGroup` still ends a TERM-stubborn
 *     member, but only after the grace window. `verifyProcessAlive` keeps the
 *     direct `forceKill` (and the survivor report) honest for a group target
 *     whose leader already exited, so the final group SIGKILL stays the sole
 *     mechanism for that case (the D5 tripwire).
 */

/** A process handle the escalation helper can signal and liveness-check. */
export interface EscalationTarget {
	/** Send SIGTERM; may throw when the target is already gone. */
	terminate(): void;
	/** Send SIGKILL; may throw when the target is already gone. */
	forceKill(): void;
	/** True when the target is confirmed dead (group-empty for a group target). */
	verifyDeath(): boolean;
	/**
	 * #299 review Major 2: true when the DIRECT process the target names is still
	 * alive. A group target's `verifyDeath` is group-empty (a dead leader with a
	 * live member is NOT dead), but `forceKill` signals the leader directly; the
	 * escalation consults this so it never force-kills an already-exited leader.
	 * Such a group is ended by the unconditional `forceKillGroup` instead, which
	 * keeps D5's tripwire honest. Absent = treat as alive (direct-only targets).
	 */
	verifyProcessAlive?(): boolean;
	/**
	 * #299 Option B D5: optional UNCONDITIONAL final group SIGKILL, called for
	 * every target after the grace window even when `verifyDeath()` reports the
	 * leader dead. A group target's `verifyDeath` is group-empty, so a
	 * TERM-stubborn member whose group leader already exited would otherwise never
	 * be force-killed. Must tolerate ESRCH (a vanished/empty group is the desired
	 * end state). Absent on direct-only pid targets.
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
 * #299 review Major 1 — signal-time identity guard for MARKER-DERIVED targets.
 *
 * A marker pid comes from a `/proc` scan at SCAN time; between that scan and the
 * signal the pid may exit and be reused by an unrelated process. Every signal
 * derived from a marker pid must therefore be preceded by an immediate
 * re-verification that the pid is still OURS. `isOwn(pid)` performs that read
 * (the LIVE `/proc/<pid>/environ` marker) and is consulted at each dispatch:
 *
 *   - direct pid signal — allowed only when `isOwn(pid)` is true;
 *   - group signal — allowed when `isOwn(pid)` is true OR the pid is confirmed
 *     GONE (`!pidAlive(pid)`). A dead leader's pgid cannot have been reused by a
 *     LIVE foreign leader, so `kill(-pgid)` can only reach our surviving members
 *     (this keeps D5's group SIGKILL for a TERM-stubborn member working after the
 *     leader exits). An ALIVE pid that no longer carries the marker IS the
 *     review's reused-pid case: EVERY signal is skipped, never unverified.
 *
 * `onSkip` records a refused signal. A skipped signal is never retried
 * unverified.
 *
 * `isGone(pid)` separates a REUSED pid from a merely GONE one: a zombie (not yet
 * reaped) and a reaped pid are both "gone", while an alive process that no
 * longer carries the marker is the reuse case. The group signal is skipped ONLY
 * for the alive-foreign case — a gone/zombie leader's pgid must still be signaled
 * so its surviving members (D5) are reached.
 *
 * RESIDUAL (documented at the call sites too): the re-check narrows the reuse
 * window to the read→`kill` syscall boundary — the same exposure the direct
 * signals have carried since Option A. It is narrowed, not eliminated.
 */
export interface SignalGuard {
	/** True when `pid` still carries OUR marker at this instant. */
	isOwn(pid: number): boolean;
	/** True when `pid` is gone: reaped OR a not-yet-reaped zombie. */
	isGone(pid: number): boolean;
	/** Called when a signal is refused (verification failed). */
	onSkip?(pid: number, signal: NodeJS.Signals, phase: SignalPhase): void;
}

/** Which dispatch attempt a guard check precedes (for skip logging). */
export type SignalPhase = "terminate" | "forceKill" | "forceKillGroup";

/**
 * Build the `EscalationTarget` for ONE pid from injected kill/liveness
 * primitives. Shared by the boot-scan reap (`reapPids`) and the marker sweeps
 * (`reapActiveChildren`, the run-exit sweep) so the pid-target shape —
 * SIGTERM, SIGKILL, `verifyDeath` = pid-not-alive — cannot drift between sites.
 *
 * `guard` (optional) re-verifies a marker-derived pid at signal time (Major 1);
 * an absent guard leaves the historical unconditional direct target.
 */
export function pidTarget(
	pid: number,
	kill: (pid: number, signal: NodeJS.Signals) => void,
	pidAlive: (pid: number) => boolean,
	guard?: SignalGuard,
): EscalationTarget {
	const dispatch = (signal: NodeJS.Signals, phase: SignalPhase, run: () => void): void => {
		if (guard && !guard.isOwn(pid)) {
			guard.onSkip?.(pid, signal, phase);
			return;
		}
		run();
	};
	return {
		terminate: () => dispatch("SIGTERM", "terminate", () => kill(pid, "SIGTERM")),
		forceKill: () => dispatch("SIGKILL", "forceKill", () => kill(pid, "SIGKILL")),
		verifyDeath: () => {
			if (guard) return guard.isGone(pid) || !guard.isOwn(pid);
			return !pidAlive(pid);
		},
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
 * #299 review Major 2: `verifyDeath` is LEADER DEAD **AND** GROUP EMPTY — a
 * leader exiting does not empty the group, so the escalation waits out the grace
 * for a member's cleanup. `groupHasMembers` is the injected /proc reader; when
 * absent/false (no /proc) it degrades to leader liveness (documented boundary).
 * `verifyProcessAlive` exposes the DIRECT leader liveness so `forceKill` is never
 * sent to an already-exited leader — the unconditional `forceKillGroup` below
 * remains the sole end for a stubborn GROUP member after the leader is gone
 * (D5).
 *
 * `guard` (optional) re-verifies a marker-derived pid at signal time (Major 1).
 */
export function groupTarget(
	pid: number,
	kill: (pid: number, signal: NodeJS.Signals) => void,
	killGroup: (pgid: number, signal: NodeJS.Signals) => void,
	pidAlive: (pid: number) => boolean,
	groupHasMembers?: (pgid: number) => boolean,
	guard?: SignalGuard,
): EscalationTarget {
	const dispatchDirect = (signal: NodeJS.Signals, phase: SignalPhase, run: () => void): void => {
		if (guard && !guard.isOwn(pid)) {
			guard.onSkip?.(pid, signal, phase);
			return;
		}
		run();
	};
	// A group signal is skipped ONLY for a live pid that is no longer ours (the
	// reused-pid case). A gone/zombie leader's pgid can only name our surviving
	// members, so the group signal must still land (D5).
	const dispatchGroup = (signal: NodeJS.Signals, phase: SignalPhase, run: () => void): void => {
		if (guard && !guard.isOwn(pid) && !guard.isGone(pid)) {
			guard.onSkip?.(pid, signal, phase);
			return;
		}
		run();
	};
	return {
		terminate: () => {
			dispatchGroup("SIGTERM", "terminate", () => bestEffortGroupKill(killGroup, pid, "SIGTERM"));
			dispatchDirect("SIGTERM", "terminate", () => kill(pid, "SIGTERM"));
		},
		forceKill: () => {
			dispatchGroup("SIGKILL", "forceKill", () => bestEffortGroupKill(killGroup, pid, "SIGKILL"));
			dispatchDirect("SIGKILL", "forceKill", () => kill(pid, "SIGKILL"));
		},
		verifyProcessAlive: () => (guard ? !guard.isGone(pid) && guard.isOwn(pid) : pidAlive(pid)),
		verifyDeath: () => {
			// A live member keeps the group (and so the target) alive even after the
			// leader is gone — including a not-yet-reaped ZOMBIE leader, which
			// `pidAlive` still reports as alive (Major 2).
			if (groupHasMembers?.(pid)) return false;
			if (guard) return guard.isGone(pid) || !guard.isOwn(pid);
			return !pidAlive(pid); // no guard: leader-only fallback
		},
		forceKillGroup: () => {
			dispatchGroup("SIGKILL", "forceKillGroup", () => bestEffortGroupKill(killGroup, pid, "SIGKILL"));
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
	groupHasMembers?: (pgid: number) => boolean,
	guard?: SignalGuard,
): EscalationTarget {
	return killGroup
		? groupTarget(pid, kill, killGroup, pidAlive, groupHasMembers, guard)
		: pidTarget(pid, kill, pidAlive, guard);
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
 * then SIGKILL every target that still verifies alive (direct), then the
 * unconditional final group SIGKILL, then report survivors. Never throws on a
 * target that vanished mid-sequence.
 *
 * #299 review Major 2: the wait uses `verifyDeath`, which for a group target is
 * LEADER DEAD **AND** GROUP EMPTY, so a leader that dies promptly no longer
 * short-circuits the grace window for a member still doing cleanup. The direct
 * `forceKill` (and the survivor report) consult `verifyProcessAlive` so a group
 * whose leader already exited is not direct-signaled — its surviving member is
 * ended by the unconditional `forceKillGroup` below (the D5 mechanism).
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
		// Only force-kill the DIRECT process while it is still alive; a group whose
		// leader already exited is ended by the unconditional group SIGKILL below.
		if (target.verifyProcessAlive?.() ?? true) {
			try {
				target.forceKill();
			} catch {
				// Exited between the liveness check and the signal.
			}
		}
		if (!target.verifyDeath() && (target.verifyProcessAlive?.() ?? true)) survivors.push(target);
	}

	// D5 (option b): the final GROUP SIGKILL is UNCONDITIONAL. `verifyDeath` is
	// group-empty (Major 2), so the escalation may reach here while a group is
	// still non-empty; a TERM-stubborn member whose leader has already exited must
	// still be killed, and this is the only signal that reaches it. Group targets
	// swallow ESRCH; pid targets have no `forceKillGroup` and are untouched.
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

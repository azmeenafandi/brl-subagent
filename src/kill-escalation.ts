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
 */

/** A process handle the escalation helper can signal and liveness-check. */
export interface EscalationTarget {
	/** Send SIGTERM; may throw when the target is already gone. */
	terminate(): void;
	/** Send SIGKILL; may throw when the target is already gone. */
	forceKill(): void;
	/** True when the target is confirmed dead (so no SIGKILL is needed). */
	verifyDeath(): boolean;
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
	return survivors;
}

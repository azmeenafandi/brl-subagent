/**
 * Unit tests for the shared SIGTERM → grace → SIGKILL escalation helper (B4/B7).
 *
 * These pin the ONE sequence every kill site now shares: terminate all, wait
 * (full grace, or poll until all dead when `pollMs` is set, bounded by grace),
 * then force-kill the targets that still verify alive. The per-site liveness
 * checks live in the callers; here the targets are fakes with a controllable
 * clock so no real process is touched.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
	escalateKill,
	groupTarget,
	pidTarget,
	processTarget,
	supportsProcessGroupKill,
	__setProcessGroupKillSupportedForTest,
	type EscalationTarget,
	type SignalGuard,
} from "../kill-escalation";

afterEach(() => {
	__setProcessGroupKillSupportedForTest(undefined);
});

interface FakeTarget extends EscalationTarget {
	calls: string[];
}

function fakeTarget(overrides: Partial<EscalationTarget> = {}): FakeTarget {
	const calls: string[] = [];
	return {
		calls,
		terminate: () => {
			calls.push("TERM");
		},
		forceKill: () => {
			calls.push("KILL");
		},
		verifyDeath: () => true,
		...overrides,
	};
}

describe("escalateKill (one SIGTERM → grace → SIGKILL sequence)", () => {
	it("wait-once: SIGTERMs all, waits one grace, SIGKILLs only survivors", async () => {
		const sleeps: number[] = [];
		const survivor = fakeTarget({ verifyDeath: () => false });
		const exits = fakeTarget({ verifyDeath: () => true });

		const result = await escalateKill([survivor, exits], {
			graceMs: 5000,
			sleep: async (ms) => {
				sleeps.push(ms);
			},
		});

		expect(survivor.calls).toEqual(["TERM", "KILL"]);
		expect(exits.calls).toEqual(["TERM"]);
		expect(sleeps).toEqual([5000]); // exactly one grace window
		expect(result).toEqual([survivor]);
	});

	it("pollMs: returns as soon as every target is dead (B4 early exit)", async () => {
		let now = 0;
		const sleeps: number[] = [];
		let polls = 0;
		const target = fakeTarget({
			verifyDeath: () => {
				polls++;
				return polls > 3; // dies on the 4th liveness check
			},
		});

		const result = await escalateKill([target], {
			graceMs: 5000,
			pollMs: 100,
			now: () => now,
			sleep: async (ms) => {
				sleeps.push(ms);
				now += ms;
			},
		});

		expect(result).toEqual([]);
		expect(target.calls).toEqual(["TERM"]); // no SIGKILL needed
		expect(sleeps).toEqual([100, 100, 100]);
		expect(now).toBeLessThan(5000); // returned well inside the grace cap
	});

	it("pollMs: a never-dying target is SIGKILLed at the grace deadline", async () => {
		let now = 0;
		const sleeps: number[] = [];
		const target = fakeTarget({ verifyDeath: () => false });

		const result = await escalateKill([target], {
			graceMs: 300,
			pollMs: 100,
			now: () => now,
			sleep: async (ms) => {
				sleeps.push(ms);
				now += ms;
			},
		});

		expect(target.calls).toEqual(["TERM", "KILL"]);
		expect(result).toEqual([target]);
		expect(now).toBeGreaterThanOrEqual(300);
	});

	it("is a no-op (no sleep, no signals) with no targets", async () => {
		const sleep = vi.fn(async () => {});
		expect(await escalateKill([], { graceMs: 5000, pollMs: 10, sleep })).toEqual([]);
		expect(sleep).not.toHaveBeenCalled();
	});

	it("never throws when a target vanishes mid-sequence", async () => {
		const target = fakeTarget({
			terminate: () => {
				throw new Error("already gone");
			},
			forceKill: () => {
				throw new Error("already gone");
			},
			verifyDeath: () => false,
		});
		const result = await escalateKill([target], { graceMs: 0, sleep: async () => {} });
		expect(result).toEqual([target]);
	});
});

// ---------------------------------------------------------------------------
// #299 Option B — group targets and the unconditional final group SIGKILL (D5)
// ---------------------------------------------------------------------------

describe("group-capable targets (#299 Option B)", () => {
	it("groupTarget signals the group best-effort AND the pid directly", () => {
		const calls: Array<[string, number, string]> = [];
		const target = groupTarget(
			4242,
			(pid, signal) => calls.push(["direct", pid, signal]),
			(pgid, signal) => calls.push(["group", pgid, signal]),
			() => true,
		);
		target.terminate();
		target.forceKill();
		target.forceKillGroup?.();
		expect(calls).toEqual([
			["group", 4242, "SIGTERM"],
			["direct", 4242, "SIGTERM"],
			["group", 4242, "SIGKILL"],
			["direct", 4242, "SIGKILL"],
			["group", 4242, "SIGKILL"],
		]);
	});

	it("a vanished group (ESRCH) never blocks the direct signal", () => {
		const direct: string[] = [];
		const target = groupTarget(
			4242,
			(_pid, signal) => direct.push(signal),
			() => {
				const err = new Error("no such process") as NodeJS.ErrnoException;
				err.code = "ESRCH";
				throw err;
			},
			() => false,
		);
		expect(() => target.terminate()).not.toThrow();
		expect(direct).toEqual(["SIGTERM"]);
	});

	it("escalateKill sends the final group SIGKILL even when the leader verifies dead", async () => {
		const calls: string[] = [];
		const target: EscalationTarget = {
			terminate: () => calls.push("TERM"),
			forceKill: () => calls.push("KILL"),
			verifyDeath: () => true, // leader already gone
			forceKillGroup: () => calls.push("GROUP_KILL"),
		};
		const result = await escalateKill([target], { graceMs: 0, sleep: async () => {} });
		expect(result).toEqual([]);
		expect(calls).toEqual(["TERM", "GROUP_KILL"]);
	});

	it("processTarget picks the group shape only when a group primitive is supplied", () => {
		const noGroup = processTarget(7, () => {}, () => true);
		expect(noGroup.forceKillGroup).toBeUndefined();
		expect(noGroup.verifyDeath()).toBe(false);
		const withGroup = processTarget(7, () => {}, () => true, () => {});
		expect(typeof withGroup.forceKillGroup).toBe("function");
		// With no group primitive the target is exactly the direct-only `pidTarget`.
		expect(Object.keys(noGroup).sort()).toEqual(Object.keys(pidTarget(7, () => {}, () => true)).sort());
	});

	it("supportsProcessGroupKill reflects the platform and the test override", () => {
		expect(supportsProcessGroupKill()).toBe(process.platform !== "win32");
		__setProcessGroupKillSupportedForTest(false);
		expect(supportsProcessGroupKill()).toBe(false);
		__setProcessGroupKillSupportedForTest(true);
		expect(supportsProcessGroupKill()).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// #299 review fix — signal-time marker guard (Major 1)
// ---------------------------------------------------------------------------

describe("signal-time marker guard (#299 review Major 1)", () => {
	it("sends group + direct signals while the marker pid is still ours", () => {
		const calls: string[] = [];
		const guard: SignalGuard = { isOwn: () => true };
		const target = processTarget(
			9,
			(_pid, signal) => calls.push(`direct:${signal}`),
			() => true,
			(_pgid, signal) => calls.push(`group:${signal}`),
			undefined,
			guard,
		);
		target.terminate();
		target.forceKill();
		target.forceKillGroup?.();
		expect(calls).toEqual([
			"group:SIGTERM",
			"direct:SIGTERM",
			"group:SIGKILL",
			"direct:SIGKILL",
			"group:SIGKILL",
		]);
	});

	it("skips BOTH signals (and records each) for a pid reused by a foreign process", () => {
		// Alive but no longer carrying our marker is the reviewer's reuse case: the
		// stale pid now names a foreign process, so NO signal is sent unverified.
		const calls: string[] = [];
		const skips: string[] = [];
		const guard: SignalGuard = {
			isOwn: () => false,
			onSkip: (_pid, signal, phase) => skips.push(`${phase}:${signal}`),
		};
		const target = processTarget(
			9,
			(_pid, signal) => calls.push(`direct:${signal}`),
			() => true,
			(_pgid, signal) => calls.push(`group:${signal}`),
			undefined,
			guard,
		);
		target.terminate();
		target.forceKill();
		target.forceKillGroup?.();
		expect(calls).toEqual([]);
		expect(skips).toEqual([
			"terminate:SIGTERM",
			"terminate:SIGTERM",
			"forceKill:SIGKILL",
			"forceKill:SIGKILL",
			"forceKillGroup:SIGKILL",
		]);
	});

	it("still groups-signals a confirmed-gone leader (D5 survival of its members)", () => {
		// The leader exited (not reused): its pgid cannot name a live foreign
		// leader, so the GROUP signal is safe and reaches our surviving members.
		const calls: string[] = [];
		const guard: SignalGuard = { isOwn: () => false };
		const target = processTarget(
			9,
			(_pid, signal) => calls.push(`direct:${signal}`),
			() => false,
			(_pgid, signal) => calls.push(`group:${signal}`),
			undefined,
			guard,
		);
		target.terminate();
		target.forceKill();
		target.forceKillGroup?.();
		expect(calls).toEqual(["group:SIGTERM", "group:SIGKILL", "group:SIGKILL"]);
	});

	it("a direct-only target with a guard skips a reused pid and reads as dead-to-us", () => {
		const calls: string[] = [];
		const target = pidTarget(
			9,
			(_pid, signal) => calls.push(signal),
			() => true,
			{ isOwn: () => false },
		);
		target.terminate();
		target.forceKill();
		expect(calls).toEqual([]);
		// Alive but not ours = our target identity is gone (do not report a survivor).
		expect(target.verifyDeath()).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// #299 review fix — group-empty death check (Major 2)
// ---------------------------------------------------------------------------

describe("group-empty verifyDeath (#299 review Major 2)", () => {
	it("a dead leader with a live member is NOT dead (grace is honoured)", () => {
		const target = groupTarget(9, () => {}, () => {}, () => false, () => true);
		expect(target.verifyDeath()).toBe(false);
		expect(target.verifyProcessAlive?.()).toBe(false);
	});

	it("a dead leader with no members IS dead", () => {
		const target = groupTarget(9, () => {}, () => {}, () => false, () => false);
		expect(target.verifyDeath()).toBe(true);
	});

	it("degrades to leader liveness when no /proc group reader is supplied", () => {
		const target = groupTarget(9, () => {}, () => {}, () => false);
		expect(target.verifyDeath()).toBe(true); // leader dead → no reader → dead
	});

	it("a group whose leader exited is ended by forceKillGroup, not forceKill (D5 tripwire)", async () => {
		const calls: string[] = [];
		const target: EscalationTarget = {
			terminate: () => calls.push("TERM"),
			forceKill: () => calls.push("KILL"),
			verifyDeath: () => false, // group still non-empty
			verifyProcessAlive: () => false, // but the leader is gone
			forceKillGroup: () => calls.push("GROUP_KILL"),
		};
		const survivors = await escalateKill([target], { graceMs: 0, sleep: async () => {} });
		expect(calls).toEqual(["TERM", "GROUP_KILL"]);
		expect(survivors).toEqual([]);
	});
});

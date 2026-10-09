/**
 * Unit tests for the shared SIGTERM → grace → SIGKILL escalation helper (B4/B7).
 *
 * These pin the ONE sequence every kill site now shares: terminate all, wait
 * (full grace, or poll until all dead when `pollMs` is set, bounded by grace),
 * then force-kill the targets that still verify alive. The per-site liveness
 * checks live in the callers; here the targets are fakes with a controllable
 * clock so no real process is touched.
 */

import { describe, it, expect, vi } from "vitest";
import { escalateKill, type EscalationTarget } from "../kill-escalation";

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

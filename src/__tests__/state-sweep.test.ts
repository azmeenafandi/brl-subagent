/**
 * Live-monitor staleness sweep (issue #52 part 2).
 *
 * The live monitor renders from state.subagentSessions; entries are removed
 * only by the background poller's completion/crash paths or session_shutdown.
 * If the poller dies mid-run (extension reload, process kill, hard-cap crash),
 * the map entry survives and the monitor shows "running" for an agent whose
 * disk record is terminal. sweepStaleLiveSubagents is the monitor-side
 * self-heal: it finalizes every entry that is provably terminal.
 *
 * These tests exercise the sweep with dependency-injected lookups:
 *  - getAgent fakes the session-manager record lookup;
 *  - the run-entry lookup goes through state.getRunEntries(session.ctx),
 *    so foreground fixtures plant a fake sessionManager (same shape as
 *    cost.test.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createSessionState, sweepStaleLiveSubagents, STALE_FINALIZE_GRACE_MS, FINALIZE_RESET_WINDOW_MS } from "../state";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LiveSubagent, SubagentRun } from "../types";
import { CUSTOM_ENTRY_TYPES } from "../types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Fake ctx whose sessionManager serves the given run entries (foreground runs). */
function createMockContext(runs: SubagentRun[]): ExtensionContext {
	return {
		sessionManager: {
			getEntries: () =>
				runs.map((r) => ({
					type: "custom",
					customType: CUSTOM_ENTRY_TYPES.run,
					data: r,
				})),
		},
	} as unknown as ExtensionContext;
}

function makeLiveEntry(id: string, ctx: ExtensionContext): LiveSubagent {
	return {
		id,
		label: `agent-${id}`,
		task: `task ${id}`,
		model: "provider/model",
		thinkingLevel: "medium",
		startedAt: Date.now(),
		liveOutput: "",
		usage: { input: 0, output: 0 },
		ctx,
	};
}

function makeRun(id: string, status: SubagentRun["status"]): SubagentRun {
	return {
		id,
		task: `task ${id}`,
		status,
		startedAt: new Date().toISOString(),
	} as SubagentRun;
}

/** getAgent fake: returns the planted record, or null when absent. */
function fakeGetAgent(records: Map<string, { completedAt?: number } | null>) {
	return (id: string) => records.get(id) ?? null;
}

const OLD = () => Date.now() - STALE_FINALIZE_GRACE_MS - 10_000;

// ---------------------------------------------------------------------------
// Sweep behavior
// ---------------------------------------------------------------------------

describe("sweepStaleLiveSubagents — background agent records", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("finalizes a stale entry whose agent record is terminal (completedAt set)", () => {
		const state = createSessionState();
		state.activeSubagents = 1;
		state.registerLiveSubagent("bg-1", makeLiveEntry("bg-1", {} as ExtensionContext));
		const getAgent = fakeGetAgent(new Map([["bg-1", { completedAt: OLD() }]]));

		const finalized = sweepStaleLiveSubagents(state, getAgent);

		expect(finalized).toBe(1);
		expect(state.subagentSessions.has("bg-1")).toBe(false);
		expect(state.activeSubagents).toBe(0);
	});

	it("leaves a genuinely live background entry (record exists, no completedAt) untouched", () => {
		const state = createSessionState();
		state.activeSubagents = 1;
		state.registerLiveSubagent("bg-1", makeLiveEntry("bg-1", {} as ExtensionContext));
		const getAgent = fakeGetAgent(new Map([["bg-1", {}]])); // 'running'/'steered' — live

		const finalized = sweepStaleLiveSubagents(state, getAgent);

		expect(finalized).toBe(0);
		expect(state.subagentSessions.has("bg-1")).toBe(true);
		expect(state.activeSubagents).toBe(1);
	});

	it("adjusts activeSubagents exactly like the poller (decrement + clamp at 0)", () => {
		const state = createSessionState();
		state.activeSubagents = 2;
		state.registerLiveSubagent("bg-1", makeLiveEntry("bg-1", {} as ExtensionContext));
		state.registerLiveSubagent("bg-2", makeLiveEntry("bg-2", {} as ExtensionContext));
		const getAgent = fakeGetAgent(
			new Map([
				["bg-1", { completedAt: OLD() }], // stale → decrement
				["bg-2", {}], // live → keep
			]),
		);

		sweepStaleLiveSubagents(state, getAgent);

		expect(state.subagentSessions.has("bg-1")).toBe(false);
		expect(state.subagentSessions.has("bg-2")).toBe(true);
		expect(state.activeSubagents).toBe(1);
	});

	it("clamps activeSubagents at 0 (poller bookkeeping mirror)", () => {
		const state = createSessionState();
		state.activeSubagents = 0; // e.g. counter already reconciled by a prior sweep
		state.registerLiveSubagent("bg-1", makeLiveEntry("bg-1", {} as ExtensionContext));
		const getAgent = fakeGetAgent(new Map([["bg-1", { completedAt: OLD() }]]));

		sweepStaleLiveSubagents(state, getAgent);

		expect(state.activeSubagents).toBe(0);
	});
});

describe("sweepStaleLiveSubagents — no agent record (foreground runs / removed records)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("finalizes a null-record entry with no run entry (record removed out-of-band)", () => {
		const state = createSessionState();
		state.activeSubagents = 0; // foreground entries are never counted
		state.registerLiveSubagent("x-1", makeLiveEntry("x-1", createMockContext([])));
		const getAgent = fakeGetAgent(new Map());

		const finalized = sweepStaleLiveSubagents(state, getAgent);

		expect(finalized).toBe(1);
		expect(state.subagentSessions.has("x-1")).toBe(false);
		// Foreground entries never increment activeSubagents → no decrement.
		expect(state.activeSubagents).toBe(0);
	});

	it("finalizes a null-record entry whose run entry is terminal (stale foreground)", () => {
		const ctx = createMockContext([makeRun("fg-1", "done")]);
		const state = createSessionState();
		state.registerLiveSubagent("fg-1", makeLiveEntry("fg-1", ctx));
		const getAgent = fakeGetAgent(new Map());

		const finalized = sweepStaleLiveSubagents(state, getAgent);

		expect(finalized).toBe(1);
		expect(state.subagentSessions.has("fg-1")).toBe(false);
		expect(state.activeSubagents).toBe(0);
	});

	it("leaves a null-record entry whose run entry is still 'running' (live foreground)", () => {
		const ctx = createMockContext([makeRun("fg-1", "running")]);
		const state = createSessionState();
		state.registerLiveSubagent("fg-1", makeLiveEntry("fg-1", ctx));
		const getAgent = fakeGetAgent(new Map());

		const finalized = sweepStaleLiveSubagents(state, getAgent);

		expect(finalized).toBe(0);
		expect(state.subagentSessions.has("fg-1")).toBe(true);
	});
});

describe("sweepStaleLiveSubagents — idempotency and poller racing", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("does not double-finalize across consecutive sweep passes", () => {
		const state = createSessionState();
		state.activeSubagents = 1;
		state.registerLiveSubagent("bg-1", makeLiveEntry("bg-1", {} as ExtensionContext));
		const getAgent = fakeGetAgent(new Map([["bg-1", { completedAt: OLD() }]]));

		expect(sweepStaleLiveSubagents(state, getAgent)).toBe(1);
		expect(state.activeSubagents).toBe(0);
		// Second pass: nothing left to claim → no extra finalize, no re-decrement.
		expect(sweepStaleLiveSubagents(state, getAgent)).toBe(0);
		expect(state.activeSubagents).toBe(0);
	});

	it("skips a too-fresh terminal record (live poller may still finalize it), then claims it after the grace window", () => {
		vi.useFakeTimers();
		const state = createSessionState();
		state.activeSubagents = 1;
		state.registerLiveSubagent("bg-1", makeLiveEntry("bg-1", {} as ExtensionContext));
		// completedAt now — the poller's next tick (≤2s) would still finalize it.
		const getAgent = fakeGetAgent(new Map([["bg-1", { completedAt: Date.now() }]]));

		expect(sweepStaleLiveSubagents(state, getAgent)).toBe(0);
		expect(state.subagentSessions.has("bg-1")).toBe(true);
		expect(state.activeSubagents).toBe(1);

		// Past the grace window the poller provably can't fire → sweep claims it.
		vi.advanceTimersByTime(STALE_FINALIZE_GRACE_MS + 1);
		expect(sweepStaleLiveSubagents(state, getAgent)).toBe(1);
		expect(state.subagentSessions.has("bg-1")).toBe(false);
		expect(state.activeSubagents).toBe(0);
	});

	it("does not touch an entry the poller already finalized (no double decrement)", () => {
		const state = createSessionState();
		state.activeSubagents = 1;
		state.registerLiveSubagent("bg-1", makeLiveEntry("bg-1", {} as ExtensionContext));

		// The live poller won the race: finalized + decremented already.
		state.finalizeLiveSubagent("bg-1");
		state.activeSubagents--;
		expect(state.activeSubagents).toBe(0);

		// The sweep must not re-finalize or re-decrement the lingering entry.
		const getAgent = fakeGetAgent(new Map([["bg-1", { completedAt: OLD() }]]));
		expect(sweepStaleLiveSubagents(state, getAgent)).toBe(0);
		expect(state.activeSubagents).toBe(0);
		expect(state.subagentSessions.has("bg-1")).toBe(true); // still in reset window
	});

	it("finalizeLiveSubagent is idempotent (first call claims, repeat returns false)", () => {
		vi.useFakeTimers();
		const state = createSessionState();
		state.registerLiveSubagent("bg-1", makeLiveEntry("bg-1", {} as ExtensionContext));

		expect(state.finalizeLiveSubagent("bg-1")).toBe(true); // THIS call claimed the finalize
		expect(state.finalizeLiveSubagent("bg-1")).toBe(false); // repeat — no-op

		expect(state.subagentSessions.has("bg-1")).toBe(true); // reset window
		vi.advanceTimersByTime(FINALIZE_RESET_WINDOW_MS + 1);
		expect(state.subagentSessions.has("bg-1")).toBe(false);
	});

	it("double-decrement race: sweep claims first, a delayed poller finalize returns false (PR #71 review)", () => {
		vi.useFakeTimers();
		const state = createSessionState();
		state.activeSubagents = 1;
		state.registerLiveSubagent("bg-1", makeLiveEntry("bg-1", {} as ExtensionContext));
		const getAgent = fakeGetAgent(new Map([["bg-1", { completedAt: OLD() }]]));

		// The stale sweep wins the race (grace expired): it claims the finalize
		// and mirrors the poller's decrement — exactly once.
		expect(sweepStaleLiveSubagents(state, getAgent)).toBe(1);
		expect(state.activeSubagents).toBe(0);
		expect(state.finalizeStaleLiveSubagent("bg-1", OLD())).toBe(false); // second sweep pass: no re-claim

		// The delayed poller tick finally fires (agent completedAt → terminal):
		// finalizeLiveSubagent must return FALSE — the sweep claimed the id — so
		// the caller (index.ts) skips its activeSubagents--. Without this, the
		// poller would double-decrement (counter drift, clamp hides it).
		expect(state.finalizeLiveSubagent("bg-1")).toBe(false);
		expect(state.activeSubagents).toBe(0); // no double decrement
	});

	it("resetLiveFinalizeClaims drops pending claims (previously-claimed id claimable again)", () => {
		vi.useFakeTimers();
		const state = createSessionState();
		state.registerLiveSubagent("bg-1", makeLiveEntry("bg-1", {} as ExtensionContext));

		expect(state.finalizeLiveSubagent("bg-1")).toBe(true);
		expect(state.finalizeLiveSubagent("bg-1")).toBe(false); // claim held

		// session_shutdown hygiene: claims are cleared alongside the live map.
		state.resetLiveFinalizeClaims();
		expect(state.finalizeLiveSubagent("bg-1")).toBe(true); // claimable again — not sticky

		// The re-claimed entry still gets the deferred cleanup.
		vi.advanceTimersByTime(FINALIZE_RESET_WINDOW_MS + 1);
		expect(state.subagentSessions.has("bg-1")).toBe(false);
	});
});

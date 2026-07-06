/**
 * Tests for cost governance (R5) — getSessionTotalCost and checkCostLimit.
 */

import { describe, it, expect, vi } from "vitest";
import { SessionState } from "../state";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { SubagentRun } from "../types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRun(id: string, cost?: number): SubagentRun {
	return {
		id,
		task: `task-${id}`,
		status: cost !== undefined ? "done" : "running",
		model: "test/provider",
		thinkingLevel: "medium",
		startedAt: new Date().toISOString(),
		cost,
	};
}

function createMockContext(runs: SubagentRun[]): ExtensionContext {
	return {
		sessionManager: {
			getEntries: () =>
				runs.map((r) => ({
					type: "custom",
					customType: "brl-subagent-run",
					data: r,
				})),
		},
	} as unknown as ExtensionContext;
}

// ---------------------------------------------------------------------------
// getSessionTotalCost
// ---------------------------------------------------------------------------

describe("getSessionTotalCost", () => {
	it("returns 0 when there are no run entries", () => {
		const state = new SessionState();
		const ctx = createMockContext([]);
		expect(state.getSessionTotalCost(ctx)).toBe(0);
	});

	it("returns 0 when all runs have no cost", () => {
		const state = new SessionState();
		const ctx = createMockContext([
			makeRun("a"),
			makeRun("b"),
		]);
		expect(state.getSessionTotalCost(ctx)).toBe(0);
	});

	it("sums costs from all runs", () => {
		const state = new SessionState();
		const ctx = createMockContext([
			makeRun("a", 0.01),
			makeRun("b", 0.02),
			makeRun("c", 0.03),
		]);
		expect(state.getSessionTotalCost(ctx)).toBeCloseTo(0.06, 6);
	});

	it("handles runs with and without cost mixed", () => {
		const state = new SessionState();
		const ctx = createMockContext([
			makeRun("a", 0.05),
			makeRun("b"),
			makeRun("c", 0.1),
		]);
		expect(state.getSessionTotalCost(ctx)).toBeCloseTo(0.15, 6);
	});

	it("handles large numbers", () => {
		const state = new SessionState();
		const ctx = createMockContext([
			makeRun("a", 1.234),
			makeRun("b", 5.678),
		]);
		expect(state.getSessionTotalCost(ctx)).toBeCloseTo(6.912, 4);
	});
});

// ---------------------------------------------------------------------------
// checkCostLimit
// ---------------------------------------------------------------------------

describe("checkCostLimit", () => {
	it("returns false when sessionCostLimit is 0 (unlimited)", () => {
		const state = new SessionState();
		state.config.sessionCostLimit = 0;
		const ctx = createMockContext([
			makeRun("a", 100), // already $100 spent
		]);
		expect(state.checkCostLimit(999, ctx)).toBe(false);
	});

	it("returns false when new total is within budget", () => {
		const state = new SessionState();
		state.config.sessionCostLimit = 1.0;
		const ctx = createMockContext([
			makeRun("a", 0.20),
			makeRun("b", 0.30),
		]);
		// Current total 0.50 + 0.20 = 0.70 <= 1.00
		expect(state.checkCostLimit(0.20, ctx)).toBe(false);
	});

	it("returns true when new total would exceed the limit", () => {
		const state = new SessionState();
		state.config.sessionCostLimit = 1.0;
		const ctx = createMockContext([
			makeRun("a", 0.80),
			makeRun("b", 0.25),
		]);
		// Current total 1.05 (already over), adding 0.10 would make it worse
		expect(state.checkCostLimit(0.10, ctx)).toBe(true);
	});

	it("returns false at exact boundary (current + cost === limit)", () => {
		const state = new SessionState();
		state.config.sessionCostLimit = 1.0;
		const ctx = createMockContext([
			makeRun("a", 0.60),
		]);
		// Current total 0.60 + 0.40 == 1.00, not over
		expect(state.checkCostLimit(0.40, ctx)).toBe(false);
	});

	it("returns true when current total alone exceeds the limit", () => {
		const state = new SessionState();
		state.config.sessionCostLimit = 0.50;
		const ctx = createMockContext([
			makeRun("a", 0.60),
		]);
		expect(state.checkCostLimit(0, ctx)).toBe(true);
	});

	it("respects the limit after reset", () => {
		const state = new SessionState();
		state.config.sessionCostLimit = 0.50;

		const ctx1 = createMockContext([makeRun("a", 0.40)]);
		expect(state.checkCostLimit(0.20, ctx1)).toBe(true);

		// Reset cost limit
		state.config.sessionCostLimit = 2.0;
		expect(state.checkCostLimit(0.20, ctx1)).toBe(false);
	});
});

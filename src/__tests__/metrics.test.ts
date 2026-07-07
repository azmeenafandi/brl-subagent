/**
 * Tests for metrics.ts — SLA metric computation and degradation detection.
 */

import { describe, it, expect } from "vitest";
import { computeSLAMetrics, computeDegradation } from "../metrics";
import type { SubagentRun, SLAMetrics } from "../types";

// ---------------------------------------------------------------------------
// Helper to create a SubagentRun with defaults
// ---------------------------------------------------------------------------

function makeRun(overrides: Partial<SubagentRun> & { id: string }): SubagentRun {
	return {
		task: `task-${overrides.id}`,
		status: "done",
		model: "test/provider",
		thinkingLevel: "medium",
		startedAt: "2024-01-01T00:00:00Z",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// computeSLAMetrics
// ---------------------------------------------------------------------------

describe("computeSLAMetrics", () => {
	it("returns all zeros and successRate 0 for empty runs array", () => {
		const metrics = computeSLAMetrics([]);
		expect(metrics.totalRuns).toBe(0);
		expect(metrics.successRate).toBe(0);
		expect(metrics.failureRate).toBe(0);
		expect(metrics.averageDurationMs).toBe(0);
		expect(metrics.p50DurationMs).toBe(0);
		expect(metrics.p95DurationMs).toBe(0);
		expect(metrics.p99DurationMs).toBe(0);
		expect(metrics.totalCost).toBe(0);
		expect(metrics.averageCost).toBe(0);
		expect(metrics.errorCategoryBreakdown).toEqual({});
		expect(metrics.roleBreakdown).toEqual({});
	});

	it("returns successRate 1.0 for a single successful run", () => {
		const runs = [
			makeRun({ id: "1", status: "done", durationMs: 5000, cost: 0.05 }),
		];
		const metrics = computeSLAMetrics(runs);
		expect(metrics.totalRuns).toBe(1);
		expect(metrics.successRate).toBe(1);
		expect(metrics.failureRate).toBe(0);
		expect(metrics.averageDurationMs).toBe(5000);
		expect(metrics.p50DurationMs).toBe(5000);
		expect(metrics.p95DurationMs).toBe(5000);
		expect(metrics.p99DurationMs).toBe(5000);
		expect(metrics.totalCost).toBe(0.05);
		expect(metrics.averageCost).toBe(0.05);
	});

	it("computes correct rates for mixed success/failure", () => {
		const runs = [
			makeRun({ id: "1", status: "done", durationMs: 1000 }),
			makeRun({ id: "2", status: "done", durationMs: 2000 }),
			makeRun({ id: "3", status: "failed", durationMs: 3000 }),
			makeRun({ id: "4", status: "done", durationMs: 4000 }),
			makeRun({ id: "5", status: "failed", durationMs: 5000 }),
		];
		const metrics = computeSLAMetrics(runs);
		expect(metrics.totalRuns).toBe(5);
		expect(metrics.successRate).toBeCloseTo(0.6); // 3/5
		expect(metrics.failureRate).toBeCloseTo(0.4); // 2/5
	});

	it("computes correct duration percentiles", () => {
		// Create 100 runs with durations 1-100
		const runs = Array.from({ length: 100 }, (_, i) =>
			makeRun({ id: String(i), status: "done", durationMs: (i + 1) * 100 }),
		);
		const metrics = computeSLAMetrics(runs);
		// p50 should be ~5000 (50th percentile of 100 values)
		expect(metrics.p50DurationMs).toBeCloseTo(5050, -1); // linear interpolation between index 49 (5000) and 50 (5100)
		// p95 should be > p50
		expect(metrics.p95DurationMs).toBeGreaterThan(metrics.p50DurationMs);
		// p99 should be >= p95
		expect(metrics.p99DurationMs).toBeGreaterThanOrEqual(metrics.p95DurationMs);
	});

	it("counts error categories correctly", () => {
		const runs = [
			makeRun({
				id: "1",
				status: "failed",
				durationMs: 1000,
				originalParams: { errorCategory: "timeout" },
			}),
			makeRun({
				id: "2",
				status: "failed",
				durationMs: 1000,
				originalParams: { errorCategory: "timeout" },
			}),
			makeRun({
				id: "3",
				status: "failed",
				durationMs: 1000,
				originalParams: { errorCategory: "crash" },
			}),
			makeRun({
				id: "4",
				status: "done",
				durationMs: 1000,
			}),
		];
		const metrics = computeSLAMetrics(runs);
		expect(metrics.errorCategoryBreakdown).toEqual({ timeout: 2, crash: 1 });
	});

	it("counts roles correctly", () => {
		const runs = [
			makeRun({
				id: "1",
				status: "done",
				durationMs: 1000,
				originalParams: { preset: "test" },
			}),
			makeRun({
				id: "2",
				status: "done",
				durationMs: 1000,
				originalParams: { preset: "test" },
			}),
			makeRun({
				id: "3",
				status: "done",
				durationMs: 1000,
				originalParams: {},
			}),
		];
		// Note: role is read from (originalParams as Record).role
		// Since SubagentRun.originalParams doesn't have role by default,
		// we need to set it manually
		const runsWithRoles = runs.map((r) => ({
			...r,
			originalParams: { ...r.originalParams, role: r.id === "3" ? "reviewer" : "developer" },
		}));
		const metrics = computeSLAMetrics(runsWithRoles);
		expect(metrics.roleBreakdown).toEqual({ developer: 2, reviewer: 1 });
	});

	it("excludes running-status runs from duration stats but counts in totalRuns", () => {
		const runs = [
			makeRun({ id: "1", status: "done", durationMs: 1000 }),
			makeRun({ id: "2", status: "running" }), // no durationMs
			makeRun({ id: "3", status: "done", durationMs: 3000 }),
		];
		const metrics = computeSLAMetrics(runs);
		expect(metrics.totalRuns).toBe(3);
		// Only runs with durationMs should be counted
		expect(metrics.averageDurationMs).toBe(2000); // (1000 + 3000) / 2
		expect(metrics.p50DurationMs).toBe(2000); // median of [1000, 3000]
	});

	it("handles multiple runs with same duration (stable percentiles)", () => {
		const runs = Array.from({ length: 10 }, (_, i) =>
			makeRun({ id: String(i), status: "done", durationMs: 5000 }),
		);
		const metrics = computeSLAMetrics(runs);
		expect(metrics.p50DurationMs).toBe(5000);
		expect(metrics.p95DurationMs).toBe(5000);
		expect(metrics.p99DurationMs).toBe(5000);
	});
});

// ---------------------------------------------------------------------------
// computeDegradation
// ---------------------------------------------------------------------------

describe("computeDegradation", () => {
	const baseline: SLAMetrics = {
		totalRuns: 100,
		successRate: 0.95,
		failureRate: 0.05,
		averageDurationMs: 5000,
		p50DurationMs: 4000,
		p95DurationMs: 10000,
		p99DurationMs: 15000,
		totalCost: 5.0,
		averageCost: 0.05,
		errorCategoryBreakdown: {},
		roleBreakdown: {},
	};

	it("reports no degradation for similar metrics", () => {
		const current: SLAMetrics = {
			...baseline,
			successRate: 0.93, // within 10% of baseline
			p95DurationMs: 11000, // within 2x of baseline
		};
		const report = computeDegradation(current, baseline);
		expect(report.degraded).toBe(false);
		expect(report.successRateChange).toBeCloseTo(-2); // -2 percentage points
		expect(report.p95Change).toBeCloseTo(1.1); // 1.1x
		expect(report.recommendations.length).toBe(1); // "No significant degradation"
	});

	it("detects degradation when success rate drops > 10%", () => {
		const current: SLAMetrics = {
			...baseline,
			successRate: 0.80, // 15% drop from 0.95 → degraded
			p95DurationMs: 11000,
		};
		const report = computeDegradation(current, baseline);
		expect(report.degraded).toBe(true);
		expect(report.successRateChange).toBeCloseTo(-15); // -15 percentage points
	});

	it("detects degradation when p95 latency increases > 2x", () => {
		const current: SLAMetrics = {
			...baseline,
			successRate: 0.94, // within 10%, not degraded on success
			p95DurationMs: 25000, // 2.5x of 10000 → degraded
		};
		const report = computeDegradation(current, baseline);
		expect(report.degraded).toBe(true);
		expect(report.p95Change).toBeCloseTo(2.5);
	});

	it("reports degradation with both success rate and latency issues", () => {
		const current: SLAMetrics = {
			...baseline,
			successRate: 0.75, // 20% drop
			p95DurationMs: 30000, // 3x increase
		};
		const report = computeDegradation(current, baseline);
		expect(report.degraded).toBe(true);
		expect(report.successRateChange).toBeCloseTo(-20);
		expect(report.p95Change).toBeCloseTo(3);
		expect(report.recommendations.length).toBe(2); // both recommendations
	});

	it("handles edge case: baseline has zero success rate", () => {
		const baselineZero: SLAMetrics = { ...baseline, successRate: 0 };
		const current: SLAMetrics = { ...baseline, successRate: 0.5 };
		const report = computeDegradation(current, baselineZero);
		expect(report.successRateChange).toBe(0); // no change computed
		expect(report.degraded).toBe(false);
	});

	it("handles edge case: baseline has zero p95 latency", () => {
		const baselineZero: SLAMetrics = { ...baseline, p95DurationMs: 0 };
		const current: SLAMetrics = { ...baseline, p95DurationMs: 5000 };
		const report = computeDegradation(current, baselineZero);
		expect(report.p95Change).toBe(Infinity); // infinite increase
		expect(report.degraded).toBe(true); // latency degraded
	});

	it("handles edge case: both current and baseline have zero p95", () => {
		const baselineZero: SLAMetrics = { ...baseline, p95DurationMs: 0 };
		const current: SLAMetrics = { ...baseline, p95DurationMs: 0 };
		const report = computeDegradation(current, baselineZero);
		expect(report.p95Change).toBe(0);
		expect(report.degraded).toBe(false);
	});
});

/**
 * brl-subagent — SLA Metrics (E4)
 *
 * Computes performance metrics from run history and detects degradation
 * against a baseline.
 */

import type { SubagentRun, SLAMetrics, DegradationReport, ErrorCategory } from "./types";

// ---------------------------------------------------------------------------
// Percentile helper
// ---------------------------------------------------------------------------

/**
 * Compute the p-th percentile of a sorted numeric array (0-100).
 * Uses linear interpolation between ranks for accuracy.
 */
function percentile(sorted: number[], p: number): number {
	if (sorted.length === 0) return 0;
	if (sorted.length === 1) return sorted[0];
	const rank = (p / 100) * (sorted.length - 1);
	const lower = Math.floor(rank);
	const upper = Math.ceil(rank);
	if (lower === upper) return sorted[lower];
	const weight = rank - lower;
	return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

// ---------------------------------------------------------------------------
// SLA metric computation
// ---------------------------------------------------------------------------

/**
 * Compute SLA metrics from a list of SubagentRun records.
 *
 * Duration calculations use only runs that have finishedAt and durationMs set.
 * Runs with status "running" are excluded from duration stats but counted in totalRuns.
 *
 * @param runs - Array of SubagentRun records (most recent first is fine; sorting happens internally)
 * @returns Computed SLAMetrics
 */
export function computeSLAMetrics(runs: SubagentRun[]): SLAMetrics {
	const totalRuns = runs.length;

	if (totalRuns === 0) {
		return {
			totalRuns: 0,
			successRate: 0,
			failureRate: 0,
			averageDurationMs: 0,
			p50DurationMs: 0,
			p95DurationMs: 0,
			p99DurationMs: 0,
			totalCost: 0,
			averageCost: 0,
			errorCategoryBreakdown: {},
		};
	}

	// Count successes and failures (running runs are neither)
	const succeeded = runs.filter((r) => r.status === "done").length;
	const failed = runs.filter((r) => r.status === "failed").length;
	const finishedRuns = succeeded + failed;

	const successRate = finishedRuns > 0 ? succeeded / finishedRuns : 0;
	const failureRate = finishedRuns > 0 ? failed / finishedRuns : 0;

	// Duration stats — only runs with durationMs set
	const durations = runs
		.filter((r) => r.durationMs !== undefined && r.durationMs !== null)
		.map((r) => r.durationMs!);

	const sortedDurations = [...durations].sort((a, b) => a - b);

	const averageDurationMs =
		durations.length > 0
			? durations.reduce((sum, d) => sum + d, 0) / durations.length
			: 0;

	const p50DurationMs = percentile(sortedDurations, 50);
	const p95DurationMs = percentile(sortedDurations, 95);
	const p99DurationMs = percentile(sortedDurations, 99);

	// Cost stats
	const costs = runs.map((r) => r.cost ?? 0);
	const totalCost = costs.reduce((sum, c) => sum + c, 0);
	const averageCost = totalRuns > 0 ? totalCost / totalRuns : 0;

	// Error category breakdown
	const errorCategoryBreakdown: Record<string, number> = {};
	for (const run of runs) {
		const cat = run.originalParams?.errorCategory as ErrorCategory | undefined;
		if (cat) {
			errorCategoryBreakdown[cat] = (errorCategoryBreakdown[cat] ?? 0) + 1;
		}
	}

	return {
		totalRuns,
		successRate,
		failureRate,
		averageDurationMs,
		p50DurationMs,
		p95DurationMs,
		p99DurationMs,
		totalCost,
		averageCost,
		errorCategoryBreakdown,
	};
}

// ---------------------------------------------------------------------------
// Degradation detection
// ---------------------------------------------------------------------------

/**
 * Compare current SLA metrics against a baseline to detect degradation.
 *
 * Degradation is flagged if:
 * - Success rate dropped by more than 10 percentage points, OR
 * - P95 latency increased by more than 2x
 *
 * @param current - Current SLA metrics
 * @param baseline - Baseline SLA metrics to compare against
 * @returns DegradationReport with comparison results and recommendations
 */
// ---------------------------------------------------------------------------
// Cost trend & sparkline (E1: Dashboard)
// ---------------------------------------------------------------------------

/**
 * Return the last N run costs as an array of numbers, most recent last.
 * Filters to runs that have a cost field set.
 */
export function computeCostTrend(runs: SubagentRun[], count: number): number[] {
	return runs
		.filter((r) => r.cost !== undefined && r.cost !== null)
		.slice(-count)
		.map((r) => r.cost!);
}

/**
 * Unicode sparkline characters, ordered from lowest to highest.
 */
const SPARKLINE_CHARS = ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588'];

/**
 * Convert an array of numbers to a Unicode sparkline string.
 * Values are scaled to the 8-character range. Empty array returns empty string.
 */
export function formatSparkline(values: number[]): string {
	if (values.length === 0) return '';
	const min = Math.min(...values);
	const max = Math.max(...values);
	const range = max - min;
	if (range === 0) {
		// All values equal — show middle character
		return values.map(() => SPARKLINE_CHARS[3]).join('');
	}
	return values
		.map((v) => {
			const normalized = (v - min) / range;
			const index = Math.min(Math.floor(normalized * SPARKLINE_CHARS.length), SPARKLINE_CHARS.length - 1);
			return SPARKLINE_CHARS[index];
		})
		.join('');
}

export function computeDegradation(
	current: SLAMetrics,
	baseline: SLAMetrics,
): DegradationReport {
	const recommendations: string[] = [];

	// Success rate change (percentage points, negative = drop)
	const successRateChange =
		baseline.successRate > 0
			? (current.successRate - baseline.successRate) * 100
			: 0;

	// P95 latency change (ratio: current / baseline)
	const p95Change =
		baseline.p95DurationMs > 0
			? current.p95DurationMs / baseline.p95DurationMs
			: current.p95DurationMs > 0
				? Infinity
				: 0;

	// Degradation criteria
	const successRateDegraded = successRateChange < -10;
	const p95Degraded = p95Change > 2;
	const degraded = successRateDegraded || p95Degraded;

	// Generate recommendations
	if (successRateDegraded) {
		recommendations.push(
			`Success rate dropped by ${Math.abs(successRateChange).toFixed(1)}% ` +
			`(from ${(baseline.successRate * 100).toFixed(1)}% to ${(current.successRate * 100).toFixed(1)}%). ` +
			`Check error category breakdown for root cause.`,
		);
	}

	if (p95Degraded) {
		recommendations.push(
			`P95 latency increased ${p95Change.toFixed(1)}x ` +
			`(from ${baseline.p95DurationMs.toFixed(0)}ms to ${current.p95DurationMs.toFixed(0)}ms). ` +
			`Consider increasing timeout or reducing task complexity.`,
		);
	}

	if (!degraded) {
		recommendations.push("No significant degradation detected. Metrics are within normal range.");
	}

	return {
		degraded,
		successRateChange,
		p95Change,
		recommendations,
	};
}

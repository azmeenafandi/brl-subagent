/**
 * Tests for history.ts — cleanupRuns and run management.
 */

import { describe, it, expect } from "vitest";
import { createEmptyResult, cleanupRuns } from "../history";
import type { SubagentRun } from "../types";

// ---------------------------------------------------------------------------
// cleanupRuns
// ---------------------------------------------------------------------------

function makeRun(id: string, startedAt: string): SubagentRun {
	return {
		id,
		task: `task-${id}`,
		status: "done",
		model: "test/provider",
		thinkingLevel: "medium",
		startedAt,
	};
}

describe("cleanupRuns", () => {
	it("returns all runs when maxEntries is 0 (unlimited)", () => {
		const runs = [makeRun("1", "2024-01-01T00:00:00Z"), makeRun("2", "2024-01-02T00:00:00Z")];
		const result = cleanupRuns(runs, 0);
		expect(result).toHaveLength(2);
	});

	it("returns all runs when count is <= maxEntries", () => {
		const runs = [makeRun("1", "2024-01-01T00:00:00Z"), makeRun("2", "2024-01-02T00:00:00Z")];
		const result = cleanupRuns(runs, 5);
		expect(result).toHaveLength(2);
	});

	it("keeps newest entries when count exceeds maxEntries", () => {
		const runs = [
			makeRun("old", "2024-01-01T00:00:00Z"),
			makeRun("mid", "2024-01-02T00:00:00Z"),
			makeRun("new", "2024-01-03T00:00:00Z"),
		];
		const result = cleanupRuns(runs, 2);
		expect(result).toHaveLength(2);
		expect(result[0].id).toBe("new");
		expect(result[1].id).toBe("mid");
	});

	it("sorts by startedAt descending", () => {
		const runs = [
			makeRun("a", "2024-01-03T00:00:00Z"),
			makeRun("b", "2024-01-01T00:00:00Z"),
			makeRun("c", "2024-01-02T00:00:00Z"),
		];
		const result = cleanupRuns(runs, 3);
		expect(result.map((r) => r.id)).toEqual(["a", "c", "b"]);
	});

	it("does not mutate the input array", () => {
		const runs = [
			makeRun("a", "2024-01-01T00:00:00Z"),
			makeRun("b", "2024-01-02T00:00:00Z"),
			makeRun("c", "2024-01-03T00:00:00Z"),
		];
		const original = [...runs];
		cleanupRuns(runs, 1);
		expect(runs).toEqual(original);
	});

	it("uses default MAX_RUN_HISTORY_ENTRIES when maxEntries omitted", () => {
		// Generate 600 runs with sequential timestamps
		const base = new Date("2024-01-01T00:00:00Z").getTime();
		const runs = Array.from({ length: 600 }, (_, i) =>
			makeRun(String(i), new Date(base + i * 1000).toISOString()),
		);
		const result = cleanupRuns(runs);
		expect(result).toHaveLength(500);
		// Newest 500 should be kept (ids 100-599, newer = higher id)
		expect(result[0].id).toBe("599");
		expect(result[result.length - 1].id).toBe("100");
	});

	it("returns empty array for empty input", () => {
		const result = cleanupRuns([], 10);
		expect(result).toEqual([]);
	});

	it("handles runs with same startedAt (stable within same timestamp)", () => {
		const runs = [
			makeRun("a", "2024-01-01T00:00:00Z"),
			makeRun("b", "2024-01-01T00:00:00Z"),
			makeRun("c", "2024-01-01T00:00:00Z"),
		];
		const result = cleanupRuns(runs, 2);
		expect(result).toHaveLength(2);
	});
});

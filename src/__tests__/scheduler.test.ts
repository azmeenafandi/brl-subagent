/**
 * Tests for P10: Dependency Graph Scheduler
 *
 * Covers topologicalSort (Kahn's algorithm), detectCycle (DFS),
 * and validateGraph — the three core scheduler functions.
 */

import { describe, it, expect } from "vitest";
import { topologicalSort, detectCycle, validateGraph } from "../scheduler";
import { MAX_GRAPH_TASKS } from "../types";
import type { GraphTask } from "../types";

// =========================================================================
// Helper: build a GraphTask with defaults
// =========================================================================

function makeTask(
	id: string,
	dependsOn: string[] = [],
	task?: string,
): GraphTask {
	return {
		id,
		task: task || `Task ${id}`,
		dependsOn,
	};
}

// =========================================================================
// topologicalSort — Kahn's algorithm → execution waves
// =========================================================================

describe("topologicalSort", () => {
	// 1. Linear chain A,B,C: A depends on nothing, B depends on A, C depends on B = 3 waves
	it("linear chain A→B→C produces 3 waves", () => {
		const tasks = [
			makeTask("A"),
			makeTask("B", ["A"]),
			makeTask("C", ["B"]),
		];
		const result = topologicalSort(tasks);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.waves).toHaveLength(3);
		expect(result.waves[0].map((t) => t.id)).toEqual(["A"]);
		expect(result.waves[1].map((t) => t.id)).toEqual(["B"]);
		expect(result.waves[2].map((t) => t.id)).toEqual(["C"]);
	});

	// 2. Diamond: A no deps, B depends on A, C depends on A, D depends on B,C = 3 waves
	it("diamond graph produces 3 waves (A, B+C parallel, D)", () => {
		const tasks = [
			makeTask("A"),
			makeTask("B", ["A"]),
			makeTask("C", ["A"]),
			makeTask("D", ["B", "C"]),
		];
		const result = topologicalSort(tasks);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.waves).toHaveLength(3);
		expect(result.waves[0].map((t) => t.id)).toEqual(["A"]);
		// B and C should be in wave 2 (sorted alphabetically within wave)
		expect(result.waves[1].map((t) => t.id).sort()).toEqual(["B", "C"]);
		expect(result.waves[2].map((t) => t.id)).toEqual(["D"]);
	});

	// 3. Independent tasks A,B,C no deps = 1 wave with 3 parallel
	it("independent tasks produce 1 wave", () => {
		const tasks = [makeTask("A"), makeTask("B"), makeTask("C")];
		const result = topologicalSort(tasks);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.waves).toHaveLength(1);
		expect(result.waves[0]).toHaveLength(3);
		expect(result.waves[0].map((t) => t.id).sort()).toEqual(["A", "B", "C"]);
	});

	// 4. Mixed: A no deps, B depends on A, C no deps = 2 waves (A,C parallel, B)
	it("mixed deps produce 2 waves (A+C parallel, B)", () => {
		const tasks = [makeTask("A"), makeTask("B", ["A"]), makeTask("C")];
		const result = topologicalSort(tasks);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.waves).toHaveLength(2);
		// Wave 1: A and C (no deps) — sorted alphabetically
		expect(result.waves[0].map((t) => t.id).sort()).toEqual(["A", "C"]);
		// Wave 2: B (depends on A)
		expect(result.waves[1].map((t) => t.id)).toEqual(["B"]);
	});

	// 5. Single task no deps = 1 wave
	it("single task produces 1 wave", () => {
		const tasks = [makeTask("X")];
		const result = topologicalSort(tasks);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.waves).toHaveLength(1);
		expect(result.waves[0]).toHaveLength(1);
		expect(result.waves[0][0].id).toBe("X");
	});

	// 6. Reverse topological order: tasks already in dep order stay in order
	it("handles tasks already in topological order", () => {
		const tasks = [
			makeTask("A"),
			makeTask("B", ["A"]),
			makeTask("C", ["B"]),
			makeTask("D", ["C"]),
		];
		const result = topologicalSort(tasks);
		expect(result.ok).toBe(true);
		if (!result.ok) return;

		expect(result.waves).toHaveLength(4);
		for (let i = 0; i < 4; i++) {
			expect(result.waves[i].map((t) => t.id)).toEqual(
				[String.fromCharCode(65 + i)], // A, B, C, D
			);
		}
	});
});

// =========================================================================
// detectCycle — three-color DFS
// =========================================================================

describe("detectCycle", () => {
	// 7. Self-loop: A depends on A = cycle with ["A"]
	it("detects self-loop (A→A)", () => {
		const tasks = [makeTask("A", ["A"])];
		const cycle = detectCycle(tasks);
		expect(cycle).not.toBeNull();
		expect(cycle).toContain("A");
	});

	// 8. A depends on B, B depends on A = cycle
	// Note: detectCycle's DFS follows dependsOn edges. Since A→B→A, the cycle should be detected.
	it("detects mutual dependency (A↔B)", () => {
		const tasks = [makeTask("A", ["B"]), makeTask("B", ["A"])];
		const cycle = detectCycle(tasks);
		expect(cycle).not.toBeNull();
		expect(cycle!.length).toBeGreaterThanOrEqual(2);
		// Both A and B should be in the cycle
		expect(cycle).toContain("A");
		expect(cycle).toContain("B");
	});

	// 9. Valid DAG = null (no cycle)
	it("returns null for valid DAG", () => {
		const tasks = [
			makeTask("A"),
			makeTask("B", ["A"]),
			makeTask("C", ["A"]),
			makeTask("D", ["B", "C"]),
		];
		const cycle = detectCycle(tasks);
		expect(cycle).toBeNull();
	});
});

// =========================================================================
// validateGraph
// =========================================================================

describe("validateGraph", () => {
	// 10. Empty graph = error
	it("returns error for empty graph", () => {
		const errors = validateGraph([]);
		expect(errors).toHaveLength(1);
		expect(errors[0]).toContain("empty");
	});

	// 11. Duplicate IDs = error
	it("returns error for duplicate task IDs", () => {
		const tasks = [makeTask("A"), makeTask("A")];
		const errors = validateGraph(tasks);
		expect(errors.some((e) => e.includes("Duplicate"))).toBe(true);
	});

	// 12. DependsOn references non-existent ID = error
	it("returns error for missing dependency reference", () => {
		const tasks = [makeTask("A", ["nonexistent"])];
		const errors = validateGraph(tasks);
		expect(errors.some((e) => e.includes("non-existent"))).toBe(true);
		expect(errors.some((e) => e.includes("nonexistent"))).toBe(true);
	});

	// 13. Exceeds MAX_GRAPH_TASKS (13 tasks) = error
	it("returns error when exceeding MAX_GRAPH_TASKS", () => {
		const tasks: GraphTask[] = [];
		for (let i = 0; i < MAX_GRAPH_TASKS + 1; i++) {
			tasks.push(makeTask(`task-${i}`));
		}
		const errors = validateGraph(tasks);
		expect(errors.some((e) => e.includes("exceeds"))).toBe(true);
	});

	// 14. Valid graph at MAX_GRAPH_TASKS (12 tasks) = empty errors
	it("accepts graph at exactly MAX_GRAPH_TASKS", () => {
		const tasks: GraphTask[] = [];
		for (let i = 0; i < MAX_GRAPH_TASKS; i++) {
			tasks.push(makeTask(`task-${i}`));
		}
		const errors = validateGraph(tasks);
		expect(errors).toHaveLength(0);
	});

	// 15. Valid small graph = empty errors
	it("returns empty errors for valid small graph", () => {
		const tasks = [
			makeTask("A"),
			makeTask("B", ["A"]),
			makeTask("C", ["A"]),
		];
		const errors = validateGraph(tasks);
		expect(errors).toHaveLength(0);
	});
});

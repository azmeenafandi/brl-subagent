/**
 * brl-subagent — Dependency Graph Scheduler
 *
 * Cycle detection (DFS), topological sort (Kahn's algorithm),
 * and graph validation for P10 dependency graph mode.
 */

import type { GraphTask } from "./types";
import { MAX_GRAPH_TASKS } from "./types";

// ---------------------------------------------------------------------------
// Cycle detection — three-color DFS
// ---------------------------------------------------------------------------

/**
 * Detect cycles in the dependency graph.
 * Returns the task IDs forming the cycle if found, or null if acyclic.
 */
export function detectCycle(tasks: GraphTask[]): string[] | null {
	const byId = new Map<string, GraphTask>();
	for (const t of tasks) byId.set(t.id, t);

	// 0 = white (unvisited), 1 = gray (in current path), 2 = black (done)
	const color = new Map<string, number>();
	for (const t of tasks) color.set(t.id, 0);

	const path: string[] = [];

	function dfs(nodeId: string): boolean {
		color.set(nodeId, 1);
		path.push(nodeId);

		const task = byId.get(nodeId);
		if (task) {
			for (const dep of task.dependsOn) {
				const depColor = color.get(dep);
				if (depColor === undefined) continue; // reference to non-existent id (validated elsewhere)
				if (depColor === 1) {
					// Found cycle — extract cycle path
					const cycleStart = path.indexOf(dep);
					path.push(dep);
					return true;
				}
				if (depColor === 0 && dfs(dep)) {
					return true;
				}
			}
		}

		path.pop();
		color.set(nodeId, 2);
		return false;
	}

	for (const t of tasks) {
		if (color.get(t.id) === 0) {
			if (dfs(t.id)) {
				return [...path];
			}
		}
	}

	return null;
}

// ---------------------------------------------------------------------------
// Topological sort — Kahn's algorithm → execution waves
// ---------------------------------------------------------------------------

/**
 * Perform topological sort returning execution waves.
 * Each wave contains tasks whose all dependencies are satisfied by previous waves.
 * Tasks within a wave have no dependencies on each other and can run in parallel.
 */
export function topologicalSort(tasks: GraphTask[]):
	| { ok: true; waves: GraphTask[][] }
	| { ok: false; error: string } {
	// Check for cycle first
	const cycle = detectCycle(tasks);
	if (cycle) {
		return {
			ok: false,
			error: `Dependency cycle detected: ${cycle.join(" → ")}`,
		};
	}

	const byId = new Map<string, GraphTask>();
	for (const t of tasks) byId.set(t.id, t);

	// Count incoming edges (dependsOn)
	const inDegree = new Map<string, number>();
	for (const t of tasks) {
		inDegree.set(t.id, 0);
	}
	for (const t of tasks) {
		for (const dep of t.dependsOn) {
			if (byId.has(dep)) {
				inDegree.set(t.id, (inDegree.get(t.id) ?? 0) + 1);
			}
		}
	}

	// Build adjacency: dep → dependent tasks
	const dependents = new Map<string, string[]>();
	for (const t of tasks) {
		for (const dep of t.dependsOn) {
			if (byId.has(dep)) {
				if (!dependents.has(dep)) dependents.set(dep, []);
				dependents.get(dep)!.push(t.id);
			}
		}
	}

	const waves: GraphTask[][] = [];
	const processed = new Set<string>();

	// Initial wave: tasks with in-degree 0
	let currentWave = tasks
		.filter((t) => (inDegree.get(t.id) ?? 0) === 0)
		.sort((a, b) => a.id.localeCompare(b.id));

	while (currentWave.length > 0) {
		waves.push(currentWave);

		const nextWave: GraphTask[] = [];
		for (const task of currentWave) {
			processed.add(task.id);
			const deps = dependents.get(task.id) ?? [];
			for (const depId of deps) {
				if (processed.has(depId)) continue;
				const newDegree = (inDegree.get(depId) ?? 1) - 1;
				inDegree.set(depId, newDegree);
				if (newDegree === 0) {
					const depTask = byId.get(depId);
					if (depTask) nextWave.push(depTask);
				}
			}
		}

		currentWave = nextWave.sort((a, b) => a.id.localeCompare(b.id));
	}

	return { ok: true, waves };
}

// ---------------------------------------------------------------------------
// Graph validation
// ---------------------------------------------------------------------------

/**
 * Validate the graph before scheduling.
 * Returns array of error strings (empty = valid).
 */
export function validateGraph(tasks: GraphTask[]): string[] {
	const errors: string[] = [];

	if (tasks.length === 0) {
		errors.push("Graph is empty — provide at least one task");
		return errors;
	}

	if (tasks.length > MAX_GRAPH_TASKS) {
		errors.push(
			`Graph exceeds maximum of ${MAX_GRAPH_TASKS} tasks (${tasks.length} provided)`,
		);
	}

	const ids = new Set<string>();
	for (const t of tasks) {
		if (ids.has(t.id)) {
			errors.push(`Duplicate task ID: "${t.id}"`);
		}
		ids.add(t.id);
	}

	for (const t of tasks) {
		for (const dep of t.dependsOn) {
			if (!ids.has(dep)) {
				errors.push(
					`Task "${t.id}" depends on non-existent task "${dep}"`,
				);
			}
		}
	}

	return errors;
}

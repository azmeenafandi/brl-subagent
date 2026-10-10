/**
 * Run-history display projection (issue #259).
 *
 * Each run appends TWO custom entries sharing its id: a spawn entry
 * (status "running", carrying `originalParams`) first, then the terminal entry
 * (done/failed) at settle. `collapseRunsForHistory` is the read-time
 * projection that turns that raw entry stream into ONE display record per
 * settled run, so the history list no longer renders every run twice (nor
 * shows a stale "running…" row forever). In-flight runs are omitted — the
 * live monitor owns running state.
 *
 * Ordering is preserved from the input, which callers take from
 * `getRunEntries` (newest-first via `cleanupRuns`) — the helper re-sorts
 * nothing.
 */
import { describe, expect, it } from "vitest";
import { collapseRunsForHistory } from "../state";
import type { SubagentRun } from "../types";

const T_NEW = "2026-01-02T00:00:00.000Z";
const T_OLD = "2026-01-01T00:00:00.000Z";

function run(
	id: string,
	status: SubagentRun["status"],
	overrides: Partial<SubagentRun> = {},
): SubagentRun {
	return {
		id,
		task: `task ${id}`,
		status,
		model: "provider/model",
		thinkingLevel: "medium",
		startedAt: T_OLD,
		...overrides,
	};
}

describe("collapseRunsForHistory (issue #259)", () => {
	it("returns an empty list for no entries", () => {
		expect(collapseRunsForHistory([])).toEqual([]);
	});

	it("omits an in-flight run (spawn entry with no terminal entry yet)", () => {
		const spawn = run("run-a", "running", { originalParams: { model: "provider/original" } });

		expect(collapseRunsForHistory([spawn])).toEqual([]);
	});

	it("keeps a terminal-only run unchanged", () => {
		const terminal = run("run-a", "done", { cost: 0.01, finishedAt: T_NEW });

		expect(collapseRunsForHistory([terminal])).toEqual([terminal]);
	});

	it("collapses a spawn+terminal pair to one row", () => {
		const spawn = run("run-a", "running", { originalParams: { model: "provider/original" } });
		const terminal = run("run-a", "done", { cost: 0.02, finishedAt: T_NEW });

		const rows = collapseRunsForHistory([spawn, terminal]);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toBe(terminal);
	});

	it("prefers the terminal entry regardless of append order", () => {
		const terminal = run("run-a", "failed", { errorMessage: "boom" });
		const spawn = run("run-a", "running");

		const rows = collapseRunsForHistory([terminal, spawn]);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toBe(terminal);
	});

	it("emits one row even when a run has multiple terminal entries (defensive)", () => {
		const firstTerminal = run("run-a", "done", { cost: 0.01 });
		const secondTerminal = run("run-a", "failed", { errorMessage: "late failure" });

		const rows = collapseRunsForHistory([firstTerminal, secondTerminal]);

		expect(rows).toHaveLength(1);
		expect(rows[0]).toBe(firstTerminal);
	});

	it("preserves the source's newest-first ordering and drops in-flight runs in place", () => {
		// getRunEntries emits newest-first (cleanupRuns sorts by startedAt desc).
		const newest = run("run-new", "done", { startedAt: T_NEW, finishedAt: T_NEW });
		const inFlight = run("run-live", "running", { startedAt: T_NEW });
		const oldest = run("run-old", "failed", { startedAt: T_OLD });

		const rows = collapseRunsForHistory([newest, inFlight, oldest]);

		expect(rows.map((r) => r.id)).toEqual(["run-new", "run-old"]);
	});

	it("does not mutate the input entries", () => {
		const spawn = run("run-a", "running");
		const terminal = run("run-a", "done");
		const entries = [spawn, terminal];

		collapseRunsForHistory(entries);

		expect(entries).toEqual([spawn, terminal]);
	});
});

/**
 * Issue #453 (ADR 0023, decision 4) — ONE logical run per id in every reader.
 *
 * A deadline-stopped run has THREE entries sharing its id: the spawn record
 * (`running`), the deadline's classification snapshot (`failed` + `timeout`) and
 * the late settle's payload AMENDMENT (same classification, real cost/usage/
 * output). Two consumers shapes break on that:
 *
 *   1. `resolveTerminalRunEntry` — the single-id selector — must take the LAST
 *      non-running entry (the amendment), not the first (the snapshot, whose
 *      cost/tokens/output are the values at the deadline: usually 0).
 *   2. every RAW-entry aggregate (SLA metrics, cost accounting, history, the
 *      reports, the dashboard, the SLA window) must project first, or it counts
 *      the run two or three times and sums two full payloads.
 *
 * Measured before the projection: three entries of one run read as 3 runs and
 * $5 for a $2 snapshot + $3 amendment pair. The amendment carries the run's FULL
 * payload (ADR 0023 decision 4 — not a delta), so the one logical run's cost is
 * the amendment's $3 and the snapshot's $2 is SUPERSEDED, not added.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	CUSTOM_ENTRY_TYPES,
	type SubagentRun,
} from "../types";
import {
	collapseRunsForHistory,
	createSessionState,
	projectLogicalRuns,
	resolveTerminalRunEntry,
	type SessionState,
} from "../state";
import { computeSLAMetrics } from "../metrics";

// ---------------------------------------------------------------------------
// Fixtures — the three entries of ONE deadline-stopped, late-settled run
// ---------------------------------------------------------------------------

const STARTED_AT = "2026-11-07T10:00:00.000Z";

function spawnEntry(id: string, overrides: Partial<SubagentRun> = {}): SubagentRun {
	return {
		id,
		task: `task ${id}`,
		label: `label ${id}`,
		status: "running",
		model: "test/model",
		thinkingLevel: "medium",
		startedAt: STARTED_AT,
		acceptedAt: STARTED_AT,
		originalParams: { background: true },
		...overrides,
	};
}

function snapshotEntry(id: string, cost: number, overrides: Partial<SubagentRun> = {}): SubagentRun {
	return {
		...spawnEntry(id),
		status: "failed",
		stopReason: "aborted",
		errorCategory: "timeout",
		errorMessage: "Timed out after 5000ms",
		finishedAt: "2026-11-07T10:00:05.000Z",
		durationMs: 5000,
		turns: 0,
		cost,
		tokensIn: 0,
		tokensOut: 0,
		outputSummary: "",
		...overrides,
	};
}

function amendmentEntry(id: string, cost: number, overrides: Partial<SubagentRun> = {}): SubagentRun {
	return {
		...snapshotEntry(id, cost),
		finishedAt: "2026-11-07T10:00:09.000Z",
		durationMs: 9000,
		turns: 3,
		tokensIn: 100,
		tokensOut: 250,
		outputSummary: "the late answer",
		fullOutput: "the late answer, in full",
		...overrides,
	};
}

function terminalEntry(id: string, overrides: Partial<SubagentRun> = {}): SubagentRun {
	return {
		...spawnEntry(id),
		status: "done",
		stopReason: "stop",
		finishedAt: "2026-11-07T10:00:03.000Z",
		durationMs: 3000,
		turns: 2,
		cost: 1,
		tokensIn: 10,
		tokensOut: 20,
		outputSummary: "done",
		...overrides,
	};
}

/**
 * A real `SessionState` whose run-entry store is the given list. `state.ts` reads
 * the store through `ctx.sessionManager.getEntries()` only, so that is the one
 * collaborator the fixture provides.
 */
function stateOverFor(entries: SubagentRun[]): {
	state: SessionState;
	ctx: { sessionManager: { getEntries: () => unknown[] } };
} {
	const state = createSessionState();
	const ctx = {
		sessionManager: {
			getEntries: () =>
				entries.map((data) => ({
					type: "custom",
					customType: CUSTOM_ENTRY_TYPES.run,
					data,
				})),
		},
	};
	return { state, ctx: ctx as never };
}

// ---------------------------------------------------------------------------
// 1. The projection itself
// ---------------------------------------------------------------------------

describe("projectLogicalRuns (#453 [c 3])", () => {
	it("leaves a two-entry run unchanged: one row, the terminal entry", () => {
		const spawn = spawnEntry("run-a");
		const terminal = terminalEntry("run-a");

		const projected = projectLogicalRuns([spawn, terminal]);

		expect(projected).toHaveLength(1);
		expect(projected[0]).toBe(terminal);
	});

	it("projects a snapshot + amendment pair to ONE row carrying the amendment", () => {
		const spawn = spawnEntry("run-a");
		const snapshot = snapshotEntry("run-a", 2);
		const amendment = amendmentEntry("run-a", 3);

		const projected = projectLogicalRuns([spawn, snapshot, amendment]);

		expect(projected).toHaveLength(1);
		expect(projected[0]).toBe(amendment);
		// The payload the readers see is the post-settle one, not the deadline's.
		expect(projected[0].cost).toBe(3);
		expect(projected[0].tokensOut).toBe(250);
		expect(projected[0].fullOutput).toBe("the late answer, in full");
	});

	it("keeps distinct runs distinct and preserves their first-seen order", () => {
		const entries = [
			spawnEntry("run-a"),
			spawnEntry("run-b"),
			snapshotEntry("run-a", 2),
			terminalEntry("run-b"),
			amendmentEntry("run-a", 3),
		];

		expect(projectLogicalRuns(entries).map((run) => run.id)).toEqual(["run-a", "run-b"]);
	});

	it("is a no-op on an empty list", () => {
		expect(projectLogicalRuns([])).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 2. The single-id selector: LAST non-running entry
// ---------------------------------------------------------------------------

describe("resolveTerminalRunEntry with an amendment (#453, mutant M5)", () => {
	it("picks the amendment out of three entries", () => {
		const entries = [spawnEntry("run-a"), snapshotEntry("run-a", 2), amendmentEntry("run-a", 3)];

		const resolved = resolveTerminalRunEntry(entries, "run-a");

		expect(resolved?.cost).toBe(3);
		expect(resolved?.fullOutput).toBe("the late answer, in full");
	});

	it("still picks the terminal entry out of two (no amendment)", () => {
		const terminal = terminalEntry("run-a");
		expect(resolveTerminalRunEntry([spawnEntry("run-a"), terminal], "run-a")).toBe(terminal);
	});

	it("falls back to the spawn entry when nothing settled", () => {
		const spawn = spawnEntry("run-a");
		expect(resolveTerminalRunEntry([spawn], "run-a")).toBe(spawn);
	});

	it("prefers an interrupted mark over the spawn entry when no settle exists", () => {
		const spawn = spawnEntry("run-a");
		const interrupted = { ...spawnEntry("run-a"), interruptedAt: STARTED_AT };
		expect(resolveTerminalRunEntry([spawn, interrupted], "run-a")).toBe(interrupted);
	});
});

// ---------------------------------------------------------------------------
// 3. Every aggregate reader sees one run (mutant M6)
// ---------------------------------------------------------------------------

describe("one logical run for the raw-entry consumers (#453 [c 3])", () => {
	/** One deadline-stopped + late-settled run: snapshot $2, amendment $3. */
	const amended = [spawnEntry("run-a"), snapshotEntry("run-a", 2), amendmentEntry("run-a", 3)];

	it("metrics: ONE run at the amendment's cost, not 3 runs at $5", () => {
		const raw = computeSLAMetrics(amended);
		const projected = computeSLAMetrics(projectLogicalRuns(amended));

		// The measured defect this projection removes: every entry is a "run".
		expect(raw.totalRuns).toBe(3);
		expect(raw.totalCost).toBe(5);
		expect(projected.totalRuns).toBe(1);
		expect(projected.totalCost).toBe(3);
	});

	it("cost governance: the session total is the amendment's cost", () => {
		const over = stateOverFor(amended);
		expect(over.state.getSessionTotalCost(over.ctx)).toBe(3);
	});

	it("history: one row, and it is the amendment", () => {
		const rows = collapseRunsForHistory(projectLogicalRuns(amended));
		expect(rows).toHaveLength(1);
		expect(rows[0].cost).toBe(3);
		expect(rows[0].status).toBe("failed");
		expect(rows[0].errorCategory).toBe("timeout");
	});

	it("a window applied before the projection double-counts; after it, it cannot", () => {
		// A 2-entry SLA window over raw entries: the amendment and the snapshot of
		// the SAME run — two rows for one run.
		expect(computeSLAMetrics(amended.slice(0, 2)).totalRuns).toBe(2);
		// Projected first, the same window is one run.
		expect(computeSLAMetrics(projectLogicalRuns(amended).slice(0, 2)).totalRuns).toBe(1);
	});

	it("the classification survives the projection unchanged (the amendment adds no claim)", () => {
		const [logical] = projectLogicalRuns(amended);
		const snapshot = amended[1];
		expect(logical.status).toBe(snapshot.status);
		expect(logical.errorCategory).toBe(snapshot.errorCategory);
		expect(logical.stopReason).toBe(snapshot.stopReason);
		expect(logical.errorMessage).toBe(snapshot.errorMessage);
	});
});

describe("the history cap counts RUNS, so an amendment cannot be orphaned (#453)", () => {
	const amended = [spawnEntry("run-a"), snapshotEntry("run-a", 2), amendmentEntry("run-a", 3)];

	it("a 2-entry cap on the raw store already splits the run; the logical cap keeps it whole", () => {
		const raw = stateOverFor(amended);
		raw.state.config.maxHistoryEntries = 2;
		// Raw: the cap is per ENTRY, so it keeps the newest two of three.
		expect(raw.state.getRunEntries(raw.ctx)).toHaveLength(2);
		// Logical: the cap is per RUN — one run is one slot, however many entries.
		const logical = raw.state.getLogicalRunEntries(raw.ctx);
		expect(logical).toHaveLength(1);
		expect(logical[0].cost).toBe(3);
	});

	it("a 1-run cap keeps the newest run whole", () => {
		// run-b is NEWER, so it is the one a 1-run cap must keep.
		const later = { startedAt: "2026-11-07T11:00:00.000Z" };
		const entries = [
			...amended,
			spawnEntry("run-b", later),
			terminalEntry("run-b", later),
		];
		const over = stateOverFor(entries);
		over.state.config.maxHistoryEntries = 1;

		const logical = over.state.getLogicalRunEntries(over.ctx);

		expect(logical).toHaveLength(1);
		expect(logical[0].id).toBe("run-b");
		expect(logical[0].status).toBe("done");
	});
});

// ---------------------------------------------------------------------------
// 4. The call sites: no display/aggregate surface reads RAW entries
// ---------------------------------------------------------------------------

describe("no raw-entry consumer is left behind (#453 [c 3])", () => {
	/**
	 * A source scan (precedent: status-chokepoint.test.ts). The projection is one
	 * helper, but nothing in the type system stops a new call site from reading
	 * `getRunEntries` — which is the store's RAW view, still needed by
	 * `findSpawnRunById` (it wants the spawn record's `originalParams`). This pins
	 * the two display/aggregate modules to the logical view.
	 */
	it("tui.ts and index.ts read the LOGICAL run list, never the raw one", () => {
		for (const file of ["tui.ts", "index.ts"]) {
			const source = readFileSync(join(process.cwd(), "src", file), "utf8");
			expect(source, `${file} still reads raw run entries`).not.toContain("getRunEntries(");
		}
	});
});


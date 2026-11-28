/**
 * Issue #606 — the evidence table's own regression test.
 *
 * `scripts/verify-dispatch-header.mjs` is the executable form of the spec's
 * §Evidence table, so it needs the same two guards every other rule here has:
 * a floor that the table is not silently emptied (every row P1-P13 has a case),
 * and a real run proving the cases actually execute assertions rather than
 * printing PASS. A case's PASS that no mutant could turn red is a certificate,
 * not evidence — the mutation receipts in the PR are the other half.
 */

import { describe, expect, it } from "vitest";

import { CASES, main, runCase } from "../verify-dispatch-header.mjs";

/** Every row of the spec's §Evidence table that this tree can run. The routing
 * row (P9) and the template rows (P10/P13) land with their code — a row pinned
 * before it exists would be a red test, and a row dropped after it exists is
 * what this list exists to catch. */
const REQUIRED_ROWS = [
	"P1",
	"P2",
	"P3",
	"P4",
	"P5",
	"P6",
	"P7",
	"P8",
	"P8 (control)",
	"P9",
	"P10",
	"P11",
	"P12",
	"P13",
];

describe("the evidence table", () => {
	it("has at least one case for every §Evidence row", () => {
		const rows = new Set(Object.values(CASES).map((entry) => entry.row));
		const missing = REQUIRED_ROWS.filter((row) => !rows.has(row));
		expect(missing, `rows with no case: ${missing.join(", ")}`).toEqual([]);
	});

	it("names, for every case, the fail state it rules out", () => {
		for (const [name, entry] of Object.entries(CASES)) {
			expect(entry.rulesOut, `${name} must state what it rules out`).toMatch(/\S/);
		}
	});

	it("runs a real case end to end and reports PASS", async () => {
		// The whole point is that these cases drive the real validator, so this
		// asserts the observable verdict rather than trusting the printer.
		expect(await runCase("title-first")).toBe("pass");
	});

	it("refuses an unknown case (usage, never a silent pass)", async () => {
		expect(await runCase("no-such-case")).toBe("missing");
	});

	it("usage: no arguments exits 2 with the usage lines", async () => {
		expect(await main([])).toBe(2);
	});
});

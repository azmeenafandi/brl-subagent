/**
 * Tests for the README test-count guard (issues #166, #469).
 *
 * The guard carries two invariants that belong at different seams, and this file pins the seam
 * rather than the number: TRUTH (the claim may never overstate the run) fails on every branch,
 * FRESHNESS (the claim may trail by at most DRIFT_LIMIT) is opt-in via `--strict` because a task PR
 * based on `dev` cannot satisfy a property of the merged tree. A mutant that runs freshness in the
 * default arm reddens the "a stale claim is not a truth failure" case; a mutant that drops the truth
 * check reddens the overstatement case.
 *
 * `--bump` is a command, not a hand edit, so its arithmetic is pinned here: floor to the hundred,
 * idempotent, warn on a shrink, refuse a target under one step.
 *
 * THE REPORT IS VALIDATED (#583). The guard reads through `scripts/lib/suite-report.mjs`, so a report
 * that is not a suite — a count with no results behind it (#F06 passed `--strict` with one), a count that
 * contradicts its own results — is exit 2 in EVERY mode. The fixtures below are therefore full-shaped
 * vitest reports, and the old count-only shape is pinned as a REFUSAL rather than as acceptance.
 *
 * The module is imported (not spawned): issue #490's floor check requires every gate script to be
 * imported by a test — a script that exits 2 at import time has no test that can import it.
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { BUMP_STEP, DRIFT_LIMIT, USAGE, bumpedClaim, main, readClaim } from "../check-readme-test-count.mjs";

const TMP = mkdtempSync(join(tmpdir(), "brl-readme-count-"));

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
});

/**
 * A report that IS a suite (#583): the README guard now reads through `readSuiteReport`, so a count-only
 * JSON object is refused — the fixture has to be shaped like vitest's own output, with the derivation
 * (`passed + failed + skipped`) agreeing with every stated top-level count.
 */
function suite(total: number, { failed = 0, skipped = 0 }: { failed?: number; skipped?: number } = {}) {
	const statuses = [
		...Array<string>(total - failed - skipped).fill("passed"),
		...Array<string>(failed).fill("failed"),
		...Array<string>(skipped).fill("skipped"),
	];
	return {
		numTotalTests: total,
		numPassedTests: total - failed - skipped,
		numFailedTests: failed,
		numPendingTests: skipped,
		success: failed === 0,
		testResults: [
			{
				status: failed === 0 ? "passed" : "failed",
				assertionResults: statuses.map((status, index) => ({ fullName: `t${index}`, status })),
			},
		],
	};
}

/** A fixture project: `README.md` carrying `claim` (or no greppable claim) plus a JSON report. */
function fixture(name: string, claim: string | undefined, report: unknown, reportName = "report.json"): string {
	const root = join(TMP, name);
	mkdirSync(root, { recursive: true });
	const line = claim === undefined ? "A test suite." : `A ${claim}+ test suite.`;
	writeFileSync(join(root, "README.md"), `# x\n\n- **Safety by default** — ${line}\n`);
	writeFileSync(join(root, reportName), JSON.stringify(report));
	return root;
}

function run(root: string, argv: string[]) {
	const out: string[] = [];
	const err: string[] = [];
	const warn: string[] = [];
	const code = main(argv, {
		root,
		log: (line: string) => out.push(line),
		warn: (line: string) => warn.push(line),
		error: (line: string) => err.push(line),
	});
	return { code, out, err, warn };
}

describe("readClaim — the claim's shape and its anchor", () => {
	it("reads a comma-grouped claim and keeps the text the bump rewrites", () => {
		expect(readClaim("a 2,400+ test suite")).toEqual({ claimed: 2400, text: "2,400+ test suite", rawNumber: "2,400", index: 2 });
	});

	it("is null when the claim is not greppable — a silent pass would be the bug", () => {
		expect(readClaim("a large test suite")).toBeNull();
	});
});

describe("bumpedClaim — a floor, never an overstatement", () => {
	it("floors to the hundred", () => {
		expect(bumpedClaim(2_604)).toBe(2_600);
		expect(bumpedClaim(2_600)).toBe(2_600);
		expect(bumpedClaim(99)).toBe(0);
		expect(bumpedClaim(BUMP_STEP)).toBe(BUMP_STEP);
	});
});

describe("truth — the default arm", () => {
	it("passes a claim that trails the run, however far", () => {
		const { code, out } = run(fixture("truth-lag", "1,000", suite(2_604)), ["report.json"]);
		expect(code).toBe(0);
		expect(out).toEqual(["readme-test-count: README says 1000+, suite ran 2604 — OK (truth only; freshness runs at the release seam)."]);
	});

	it("fails a claim that overstates the run", () => {
		const { code, err } = run(fixture("truth-overstated", "2,700", suite(2_604)), ["report.json"]);
		expect(code).toBe(1);
		expect(err).toEqual(["README claims 2700+ tests but only 2604 ran — the claim overstates reality."]);
	});

	it("fails a missing claim rather than passing vacuously", () => {
		const { code, err } = run(fixture("truth-missing", undefined, suite(2_604)), ["report.json"]);
		expect(code).toBe(1);
		expect(err[0]).toContain('README.md: no "<N>+ test suite" claim found');
	});
});

describe("freshness — the release-seam arm", () => {
	it("allows drift exactly at the limit and fails one past it", () => {
		const atLimit = run(fixture("strict-at-limit", "2,504", suite(2_604)), ["report.json", "--strict"]);
		expect(atLimit.code).toBe(0);
		expect(atLimit.out[0]).toContain(`OK (drift ${DRIFT_LIMIT} of limit ${DRIFT_LIMIT})`);
		const past = run(fixture("strict-past-limit", "2,503", suite(2_604)), ["report.json", "--strict"]);
		expect(past.code).toBe(1);
		expect(past.err[0]).toContain(`drift ${DRIFT_LIMIT + 1}, limit ${DRIFT_LIMIT}`);
	});
});

describe("--bump — the release ritual's step 5", () => {
	it("rewrites the claim in place and is idempotent", () => {
		const root = fixture("bump", "2,400", suite(2_604));
		const first = run(root, ["report.json", "--bump"]);
		expect(first.code).toBe(0);
		expect(first.out).toEqual(["readme-test-count: bump 2400+ → 2600+ (2604 tests ran)."]);
		expect(readFileSync(join(root, "README.md"), "utf8")).toContain("A 2600+ test suite.");
		const second = run(root, ["report.json", "--bump"]);
		expect(second.code).toBe(0);
		expect(second.out).toEqual(["readme-test-count: README already says 2600+ for 2604 ran — nothing to bump."]);
	});

	it("warns when the suite shrank — the claim moves down, not up", () => {
		const root = fixture("bump-shrink", "3,500", suite(2_604));
		const { code, warn, out } = run(root, ["report.json", "--bump"]);
		expect(code).toBe(0);
		expect(warn[0]).toContain("the suite SHRANK — 3500+ was correct for a bigger run");
		expect(out[0]).toBe("readme-test-count: bump 3500+ → 2600+ (2604 tests ran).");
	});

	it("refuses a run too small to state a floor", () => {
		const { code, err } = run(fixture("bump-small", "2,400", suite(60)), ["report.json", "--bump"]);
		expect(code).toBe(2);
		expect(err[0]).toContain(`refusing to bump: 60 tests floors to 0+ (under ${BUMP_STEP})`);
	});
});

describe("usage and unreadable input — exit 2, never 1", () => {
	it("rejects a missing report path, an unknown flag and mutually exclusive modes", () => {
		const root = fixture("usage", "2,400", { numTotalTests: 2_604 });
		expect(run(root, [])).toEqual({ code: 2, out: [], err: [USAGE], warn: [] });
		expect(run(root, ["--nope"]).err).toEqual([`${USAGE}\nunknown flag: --nope`]);
		expect(run(root, ["report.json", "--strict", "--bump"]).err[0]).toContain("mutually exclusive");
	});

	it("rejects an unreadable report, a hollow one and one without a total — exit 2, never 1", () => {
		const root = fixture("bad-report", "2,400", suite(2_604));
		// #583: the fixture is a VALID report so the directory exists and the cases below are about the
		// report they name, not about a missing README. Every one of these used to exit 0.
		writeFileSync(join(root, "hollow.json"), JSON.stringify({ numTotalTests: 3_100, testResults: [] }));
		writeFileSync(join(root, "no-results.json"), JSON.stringify({ numTotalTests: 3_100 }));
		writeFileSync(join(root, "no-total.json"), JSON.stringify({ ...suite(2_604), numTotalTests: undefined }));
		writeFileSync(join(root, "torn.json"), JSON.stringify({ ...suite(2_604), numFailedTests: 1 }));
		writeFileSync(join(root, "unknown.json"), JSON.stringify({ ...suite(2_604), testResults: [{ assertionResults: [{ status: "weird" }] }] }));
		writeFileSync(join(root, "garbage.json"), "{ not json");

		const hollow = run(root, ["hollow.json"]);
		expect(hollow.code).toBe(2);
		expect(hollow.err[0]).toContain("hollow.json: empty-results");

		const noResults = run(root, ["no-results.json"]);
		expect(noResults.code).toBe(2);
		expect(noResults.err[0]).toContain("no-results.json: empty-results");

		// A report WITH results but no total: the validator accepts this shape, so the guard's own
		// requirement is what refuses it — named field, exit 2.
		const noTotal = run(root, ["no-total.json"]);
		expect(noTotal.code).toBe(2);
		expect(noTotal.err[0]).toContain("no numTotalTests");

		const torn = run(root, ["torn.json"]);
		expect(torn.code).toBe(2);
		expect(torn.err[0]).toContain("count-mismatch");
		expect(torn.err[0]).toContain("numFailedTests 1");

		const unknown = run(root, ["unknown.json"]);
		expect(unknown.code).toBe(2);
		expect(unknown.err[0]).toContain("unknown-status");

		const garbage = run(root, ["garbage.json"]);
		expect(garbage.code).toBe(2);
		expect(garbage.err[0]).toContain("not-json");

		const missing = run(root, ["absent.json"]);
		expect(missing.code).toBe(2);
		expect(missing.err[0]).toContain("absent.json: unreadable");
	});

	/** The invalid report, in every mode: a bump from a hollow report would move a public claim. */
	it("refuses a hollow report in --strict and in --bump, and writes nothing", () => {
		const root = fixture("modes-hollow", "2,400", { numTotalTests: 3_100, testResults: [] });
		const before = readFileSync(join(root, "README.md"), "utf8");
		for (const mode of [[], ["--strict"], ["--bump"]]) {
			const result = run(root, ["report.json", ...mode]);
			expect(result.code, mode.join(" ") || "default").toBe(2);
			expect(result.err[0]).toContain("report.json: empty-results");
		}
		expect(readFileSync(join(root, "README.md"), "utf8")).toBe(before);
	});
});

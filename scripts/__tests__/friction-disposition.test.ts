/**
 * Tests for `scripts/friction-disposition.mjs` (issue #560) — the friction-disposition ledger.
 *
 * The tool exists because Rule 11 counted classes in prose, at close, from memory, and recorded the
 * outcome nowhere: a merged issue could not update its own row, and a widened issue read exactly like an
 * established P0. This file pins the four things that make the ledger safe to close on:
 *
 * 1. the PARSER is tolerant exactly where history demands it (an unescaped `|` inside prose) and strict
 *    where the file is ours (seven cells, escaped pipes, no conflict markers) — case 9;
 * 2. COVERAGE is a partition, not a declaration: every non-record row in the window gets exactly one
 *    class, and an evidence-only (`rows: —`) class never licenses skipping the partition — cases 2, 3,
 *    12, and the M1 mutant;
 * 3. every refusal NAMES the row, class or index it is about, and the exit code keeps "the ledger is
 *    wrong" (1) apart from "cannot check" (2) — cases 4–7, 9, 11, 13, 16;
 * 4. the RENDER is conditional and minimal: one stale cell changes exactly one line, a second render is
 *    byte-identical, and another cycle's bytes are never touched — case 14, and the M4 mutant. M3 (sort
 *    with `localeCompare`) cannot be told apart from the contract under the default collation, so it is
 *    killed by the locale probe at the end of this file: a render under `da_DK`, where `aa` > `ab`, must
 *    still write bytewise order.
 *
 * The §9 evidence probes are executable here, not described: the CLI cases spawn the real script, the
 * `gh` boundary cases put a stub `gh` on PATH (five variants, one per discriminator), and the seed case
 * reads the real `.development/FRICTION_DISPOSITIONS.md` against the real `.development/FRICTION_LOG.md`
 * — so the seed cannot rot away from the gate that is supposed to keep it honest.
 *
 * COVERAGE — what these probes do NOT cover, stated rather than implied: a ledger MUTATED between the
 * read that validated it and the read that renders it (the CLI re-reads and refuses, but the test does
 * not race a second writer), a `gh` that hangs past the 20 s timeout (the timeout is passed to spawnSync,
 * not measured here), and a non-Linux host for the directory `fsync` (opening a directory read-only is
 * POSIX, not universal).
 */
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
	EXIT,
	ROOT,
	classifyDisposition,
	compareClasses,
	check,
	main,
	parseArgs,
	parseCandidates,
	parseLedger,
	parseLog,
	parseStates,
	renderCycle,
	createRepoFacts,
	requiredIds,
} from "../friction-disposition.mjs";

const SCRIPT = join(ROOT, "scripts", "friction-disposition.mjs");
const REAL_LEDGER = join(ROOT, ".development", "FRICTION_DISPOSITIONS.md");
const REAL_LOG = join(ROOT, ".development", "FRICTION_LOG.md");
const DATE = "2026-11-20T13:25Z";
const CLOSED_AT = "2026-11-21T04:57Z";

// ---------------------------------------------------------------------------
// Fixtures — builders, not samples. A ledger is a table the tool must refuse or accept.
// ---------------------------------------------------------------------------

interface WindowSpec {
	cycle: string;
	from: number;
	to: number;
	provenance?: string;
}

interface DispositionSpec {
	cycle: string;
	class: string;
	rows: string;
	evidence?: string;
	disposition: string;
	issue?: string;
	fix?: string;
}

const WINDOW_HEADER = "| cycle | from | to | opened | closed | provenance |\n|---|---|---|---|---|---|";
const DISPOSITION_HEADER = "| cycle | class | rows | evidence | disposition | issue | fix |\n|---|---|---|---|---|---|---|";

function windowRow(spec: WindowSpec): string {
	return `| ${spec.cycle} | ${spec.from} | ${spec.to} | ${DATE} | ${CLOSED_AT} | ${spec.provenance ?? "reviewed inference"} |`;
}

function dispositionRow(spec: DispositionSpec): string {
	const evidence = spec.evidence ?? "";
	const issue = spec.issue ?? "—";
	const fix = spec.fix ?? "mechanical";
	return `| ${spec.cycle} | \`${spec.class}\` | ${spec.rows} | ${evidence} | ${spec.disposition} | ${issue} | ${fix} |`;
}

function mkLedger(windows: WindowSpec[], dispositions: DispositionSpec[]): string {
	return [
		"# Friction dispositions",
		"",
		"Rows are indices; never insert or edit a logged row.",
		"",
		"## Windows",
		"",
		WINDOW_HEADER,
		...windows.map(windowRow),
		"",
		"## Dispositions",
		"",
		DISPOSITION_HEADER,
		...dispositions.map(dispositionRow),
		"",
	].join("\n");
}

/** One friction row per observation; `CYCLE … CLOSED` becomes a close record by the parser's own rule. */
function mkLog(observations: string[]): string {
	return [
		"# Friction Log",
		"",
		"| Date | Tag | Observation |",
		"|---|---|---|",
		...observations.map((observation) => `| 2026-11-20 | tooling | ${observation} |`),
		"",
	].join("\n");
}

interface FactSpec {
	states?: Record<string, string>;
	commits?: string[];
	headings?: string[];
}

/** The injected facts: no fs, no git, no gh. `headings` are `"path::heading"` pairs, compared literally. */
function facts({ states = {}, commits = [], headings = [] }: FactSpec = {}) {
	const headingsSet = new Set(headings);
	return {
		states: new Map(Object.entries(states)),
		commitExists: (sha: string) => commits.some((commit) => commit === sha || commit.startsWith(sha)),
		docHasHeading: (path: string, heading: string) => headingsSet.has(`${path}::${heading}`),
	};
}

function runCheck(
	ledgerText: string,
	logText: string,
	cycle: string,
	factSet = facts(),
	options: { close?: boolean; candidates?: unknown } = {},
) {
	return check({
		ledger: parseLedger(ledgerText),
		log: parseLog(logText),
		cycle,
		facts: factSet,
		close: options.close ?? false,
		candidates: options.candidates ?? null,
	});
}

function codesOf(result: { problems: Array<{ code: string }> }): string[] {
	return result.problems.map((problem) => problem.code);
}

function header(): string {
	return mkLedger([{ cycle: "alpha", from: 1, to: 1 }], [{ cycle: "alpha", class: "a", rows: "1", disposition: "folded into #548", issue: "#548 open" }]);
}

// ---------------------------------------------------------------------------
// Cases 1–8 — the pure grammar, coverage and the fact set.
// ---------------------------------------------------------------------------

describe("friction-disposition — case 1: the five forms, and five malformed cells", () => {
	const valid = mkLedger(
		[{ cycle: "alpha", from: 1, to: 5 }],
		[
			{ cycle: "alpha", class: "a-p0", rows: "1", evidence: "17/63 failed; Rule 11: ≥2", disposition: "P0 #556", issue: "#556 open" },
			{ cycle: "alpha", class: "b-fixed", rows: "2", disposition: "fixed abc1234" },
			{ cycle: "alpha", class: "c-folded", rows: "3", disposition: "folded into #548", issue: "#548 open" },
			{ cycle: "alpha", class: "d-accepted", rows: "4", disposition: "accepted → docs/x.md::Section" },
			{ cycle: "alpha", class: "e-stale", rows: "5", evidence: "→ #561 closed 2026-11-21", disposition: "stale" },
		],
	);
	const log = mkLog(["one", "two", "three", "four", "five"]);

	it("accepts all five forms", () => {
		const result = runCheck(valid, log, "alpha", facts({ states: { 556: "OPEN", 548: "OPEN" }, commits: ["abc1234"], headings: ["docs/x.md::Section"] }));
		expect(result.problems).toEqual([]);
	});

	const malformed: Array<[string, string, string]> = [
		["P0 556", "bad-p0", "one"],
		["fixed zzz", "bad-fixed", "one"],
		["accepted → x", "bad-accepted", "one"],
		["stale", "bad-stale", "→ yes"],
		["folded into 548", "bad-folded", "one"],
	];

	for (const [cell, code, evidence] of malformed) {
		it(`refuses "${cell}" with ${code}`, () => {
			const ledgerText = mkLedger(
				[{ cycle: "alpha", from: 1, to: 1 }],
				[{ cycle: "alpha", class: "a", rows: "1", evidence, disposition: cell }],
			);
			const result = runCheck(ledgerText, mkLog(["one"]), "alpha", facts({ headings: ["docs/x.md::Section"] }));
			expect(codesOf(result)).toEqual([code]);
			expect(result.problems[0].exit).toBe(EXIT.LEDGER);
		});
	}

	it("keeps the five refusals distinct", () => {
		const seen = malformed.map(([cell, , evidence]) => {
			const result = runCheck(
				mkLedger([{ cycle: "alpha", from: 1, to: 1 }], [{ cycle: "alpha", class: "a", rows: "1", evidence, disposition: cell }]),
				mkLog(["one"]),
				"alpha",
			);
			return result.problems[0].code;
		});
		expect(new Set(seen).size).toBe(5);
	});
});

describe("friction-disposition — case 2/3: coverage is a partition", () => {
	it("names the index a window covers with no class", () => {
		const ledgerText = mkLedger(
			[{ cycle: "alpha", from: 1, to: 2 }],
			[{ cycle: "alpha", class: "a", rows: "1", disposition: "folded into #548", issue: "#548 open" }],
		);
		const result = runCheck(ledgerText, mkLog(["one", "two"]), "alpha", facts({ states: { 548: "OPEN" } }));
		expect(codesOf(result)).toEqual(["unassigned"]);
		expect(result.problems[0].message).toContain("row 2");
		expect(result.problems[0].exit).toBe(EXIT.LEDGER);
	});

	it("refuses an index assigned to two classes, outside the window, and one left unassigned", () => {
		const duplicate = runCheck(
			mkLedger(
				[{ cycle: "alpha", from: 1, to: 1 }],
				[
					{ cycle: "alpha", class: "a", rows: "1", disposition: "folded into #548", issue: "#548 open" },
					{ cycle: "alpha", class: "b", rows: "1", disposition: "folded into #548", issue: "#548 open" },
				],
			),
			mkLog(["one"]),
			"alpha",
			facts({ states: { 548: "OPEN" } }),
		);
		expect(codesOf(duplicate)).toEqual(["duplicate-assignment"]);
		expect(duplicate.problems[0].message).toContain("row 1");

		const outside = runCheck(
			mkLedger(
				[{ cycle: "alpha", from: 1, to: 2 }],
				[
					{ cycle: "alpha", class: "a", rows: "1", disposition: "folded into #548", issue: "#548 open" },
					{ cycle: "alpha", class: "b", rows: "2", disposition: "folded into #548", issue: "#548 open" },
					{ cycle: "alpha", class: "c", rows: "3", disposition: "folded into #548", issue: "#548 open" },
				],
			),
			mkLog(["one", "two"]),
			"alpha",
			facts({ states: { 548: "OPEN" } }),
		);
		expect(codesOf(outside)).toEqual(["outside-window"]);
		expect(outside.problems[0].message).toContain("row 3");

		const unassigned = runCheck(
			mkLedger(
				[{ cycle: "alpha", from: 1, to: 2 }],
				[{ cycle: "alpha", class: "a", rows: "1", disposition: "folded into #548", issue: "#548 open" }],
			),
			mkLog(["one", "two"]),
			"alpha",
			facts({ states: { 548: "OPEN" } }),
		);
		expect(codesOf(unassigned)).toEqual(["unassigned"]);
		expect(unassigned.problems[0].message).toContain("row 2");

		expect(new Set([codesOf(duplicate)[0], codesOf(outside)[0], codesOf(unassigned)[0]]).size).toBe(3);
	});

	it("does not let an evidence-only class skip the partition (M1: skip coverage when rows: —)", () => {
		// The whole cycle has one evidence-only class, and row 1 is still unassigned. A check that skips
		// coverage whenever it sees `rows: —` returns 0 here; the ledger's contract returns `unassigned`.
		const ledgerText = mkLedger(
			[{ cycle: "alpha", from: 1, to: 2 }],
			[{ cycle: "alpha", class: "a", rows: "—", evidence: "reconstructed from PR evidence", disposition: "folded into #548", issue: "#548 open" }],
		);
		const result = runCheck(ledgerText, mkLog(["one", "two"]), "alpha", facts({ states: { 548: "OPEN" } }));
		expect(codesOf(result)).toEqual(["unassigned", "unassigned"]);
		expect(result.problems.map((problem) => problem.message)).toEqual([
			expect.stringContaining("row 1"),
			expect.stringContaining("row 2"),
		]);
	});

	it("requires evidence on an evidence-only class", () => {
		const ledgerText = mkLedger(
			[{ cycle: "alpha", from: 1, to: 1 }],
			[
				{ cycle: "alpha", class: "a", rows: "1", disposition: "folded into #548", issue: "#548 open" },
				{ cycle: "alpha", class: "b", rows: "—", disposition: "folded into #548", issue: "#548 open" },
			],
		);
		const result = runCheck(ledgerText, mkLog(["one"]), "alpha", facts({ states: { 548: "OPEN" } }));
		expect(codesOf(result)).toContain("missing-evidence");
	});
});

describe("friction-disposition — case 4: the P0 anchor and a closed issue", () => {
	function p0(evidence: string, state: string) {
		return runCheck(
			mkLedger(
				[{ cycle: "alpha", from: 1, to: 1 }],
				[{ cycle: "alpha", class: "a", rows: "1", evidence, disposition: "P0 #556", issue: `#556 ${state.toLowerCase()}` }],
			),
			mkLog(["one"]),
			"alpha",
			facts({ states: { 556: state } }),
		);
	}

	it("accepts an OPEN P0 whose evidence carries Rule 11 and a count", () => {
		expect(p0("17/63 failed, 12 auto-retries; Rule 11: ≥2", "OPEN").problems).toEqual([]);
	});

	it("refuses an anchor without an occurrence count", () => {
		const result = p0("17/63 failed; Rule 11 says it recurs", "OPEN");
		expect(codesOf(result)).toEqual(["p0-anchor"]);
		expect(result.problems[0].message).toContain("Rule 11");
	});

	it("refuses a P0 whose issue is CLOSED — reclassify it", () => {
		const result = p0("17/63 failed; Rule 11: ≥2", "CLOSED");
		expect(codesOf(result)).toEqual(["p0-closed"]);
		expect(result.problems[0].message).toContain("CLOSED");
	});

	it("accepts `x2` as the occurrence count", () => {
		expect(p0("Rule 11: x2 on the same label", "OPEN").problems).toEqual([]);
	});
});

describe("friction-disposition — case 5: the states file names exactly the referenced ids", () => {
	const ids = [556, 548];

	it("accepts the exact set", () => {
		const states = parseStates('{"version":1,"states":{"556":"OPEN","548":"CLOSED"}}', ids);
		expect(states.get("556")).toBe("OPEN");
		expect(states.get("548")).toBe("CLOSED");
	});

	const failures: Array<[string, string, RegExp]> = [
		["missing id", '{"version":1,"states":{"556":"OPEN"}}', /missing #548/],
		["extra id", '{"version":1,"states":{"556":"OPEN","548":"OPEN","999":"OPEN"}}', /#999 is not referenced/],
		["bad value", '{"version":1,"states":{"556":"open","548":"OPEN"}}', /must be OPEN, CLOSED or MISSING/],
		["duplicate key", '{"version":1,"states":{"556":"OPEN","556":"CLOSED","548":"OPEN"}}', /duplicate id "556"/],
	];

	for (const [name, text, pattern] of failures) {
		it(`refuses a ${name}`, () => {
			expect(() => parseStates(text, ids)).toThrow(pattern);
		});
	}

	it("collects only ids named by a disposition or issue cell, never an evidence citation", () => {
		const text = mkLedger(
			[{ cycle: "alpha", from: 1, to: 1 }],
			[
				{
					cycle: "alpha",
					class: "a",
					rows: "1",
					evidence: "see #999 and #1000 for the history",
					disposition: "folded into #548",
					issue: "#548 open",
				},
			],
		);
		expect(requiredIds(parseLedger(text), "alpha")).toEqual([548]);
	});

	it("maps every refusal to exit 2 through the CLI", () => {
		const dir = mkdtempSync(join(tmpdir(), "fd-states-"));
		try {
			writeFileSync(join(dir, "ledger.md"), header());
			writeFileSync(join(dir, "log.md"), mkLog(["one"]));
			writeFileSync(join(dir, "states.json"), '{"version":1,"states":{"556":"OPEN"}}');
			const result = runCli(["--check", "--cycle", "alpha", "--ledger", join(dir, "ledger.md"), "--log", join(dir, "log.md"), "--states", join(dir, "states.json")]);
			expect(result.code).toBe(EXIT.CANNOT_CHECK);
			expect(result.err).toContain("missing #548");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("friction-disposition — case 6: MISSING fails every form that names an issue", () => {
	const cells = ["P0 #999", "folded into #999"];

	it("refuses P0 and folded rows whose issue is MISSING", () => {
		for (const cell of cells) {
			const evidence = cell.startsWith("P0") ? "2 occurrences; Rule 11: ≥2" : "";
			const result = runCheck(
				mkLedger(
					[{ cycle: "alpha", from: 1, to: 1 }],
					[{ cycle: "alpha", class: "a", rows: "1", evidence, disposition: cell, issue: "#999 missing" }],
				),
				mkLog(["one"]),
				"alpha",
				facts({ states: { 999: "MISSING" } }),
			);
			expect(codesOf(result)).toContain("missing-fact");
			expect(result.problems.find((problem) => problem.code === "missing-fact")?.exit).toBe(EXIT.LEDGER);
		}
	});

	it("does not report a currency failure for a MISSING fact — the cell told the truth", () => {
		const result = runCheck(
			mkLedger(
				[{ cycle: "alpha", from: 1, to: 1 }],
				[{ cycle: "alpha", class: "a", rows: "1", disposition: "folded into #999", issue: "#999 missing" }],
			),
			mkLog(["one"]),
			"alpha",
			facts({ states: { 999: "MISSING" } }),
		);
		expect(codesOf(result)).toEqual(["missing-fact"]);
	});
});

describe("friction-disposition — case 7: accepted names a real file and a real heading", () => {
	const headings = ["docs/x.md::A :: B", "docs/x.md::`foo`"];

	function accepted(cell: string) {
		return runCheck(
			mkLedger(
				[{ cycle: "alpha", from: 1, to: 1 }],
				[{ cycle: "alpha", class: "a", rows: "1", disposition: cell }],
			),
			mkLog(["one"]),
			"alpha",
			facts({ headings }),
		);
	}

	it("refuses a missing path and a missing heading, and accepts a heading with :: and backticks", () => {
		const missingPath = accepted("accepted → docs/nope.md::A :: B");
		expect(codesOf(missingPath)).toEqual(["bad-accepted"]);
		expect(missingPath.problems[0].message).toContain("docs/nope.md");

		const missingHeading = accepted("accepted → docs/x.md::Not There");
		expect(codesOf(missingHeading)).toEqual(["bad-accepted"]);
		expect(missingHeading.problems[0].message).toContain("Not There");

		expect(accepted("accepted → docs/x.md::A :: B").problems).toEqual([]);
		expect(accepted("accepted → docs/x.md::`foo`").problems).toEqual([]);
	});

	it("splits at the first :: — a path containing :: is not representable (stated limit)", () => {
		const parsed = classifyDisposition("accepted → a/b::c::Heading");
		expect(parsed).toMatchObject({ form: "accepted", path: "a/b", heading: "c::Heading" });
	});

	it("refuses an absolute path — a referent is relative to the repository root", () => {
		expect(classifyDisposition("accepted → /etc/x.md::Heading").code).toBe("bad-accepted");
	});
});

describe("friction-disposition — case 8: fixed needs a commit that exists", () => {
	function fixed(sha: string, commits: string[]) {
		return runCheck(
			mkLedger(
				[{ cycle: "alpha", from: 1, to: 1 }],
				[{ cycle: "alpha", class: "a", rows: "1", disposition: `fixed ${sha}` }],
			),
			mkLog(["one"]),
			"alpha",
			facts({ commits }),
		);
	}

	it("accepts a real sha and refuses deadbeef", () => {
		expect(fixed("abc1234", ["abc1234def"]).problems).toEqual([]);
		const result = fixed("deadbeef", ["abc1234def"]);
		expect(codesOf(result)).toEqual(["bad-commit"]);
		expect(result.problems[0].message).toContain("deadbeef");
	});
});

// ---------------------------------------------------------------------------
// Cases 9–14 — the strict table, the closing gate, contiguity, determinism and render.
// ---------------------------------------------------------------------------

describe("friction-disposition — case 9: strict table syntax", () => {
	const base = mkLedger([{ cycle: "alpha", from: 1, to: 1 }], [
		{ cycle: "alpha", class: "a", rows: "1", disposition: "folded into #548", issue: "#548 open" },
	]);

	it("refuses a bare class cell — the class is a backticked code span (§1.4)", () => {
		const bare = base.replace("| alpha | `a` |", "| alpha | a |");
		expect(() => parseLedger(bare)).toThrow(/class cell "a" is not a backticked code span/);
		// The same name INSIDE the span passes — the refusal is about the shape, not the identity.
		expect(parseLedger(base).dispositions[0].class).toBe("a");
	});

	it("refuses a duplicate (cycle, class)", () => {
		const text = mkLedger(
			[{ cycle: "alpha", from: 1, to: 1 }],
			[
				{ cycle: "alpha", class: "a", rows: "1", disposition: "folded into #548", issue: "#548 open" },
				{ cycle: "alpha", class: "a", rows: "1", disposition: "folded into #548", issue: "#548 open" },
			],
		);
		expect(() => parseLedger(text)).toThrow(/duplicate class "a"/);
	});

	it("refuses a duplicate window", () => {
		const text = base.replace(WINDOW_HEADER, WINDOW_HEADER + "\n" + windowRow({ cycle: "alpha", from: 1, to: 1 }));
		expect(() => parseLedger(text)).toThrow(/duplicate window "alpha"/);
	});

	it("refuses a six-cell row", () => {
		const text = base.replace("| alpha | `a` | 1 |  | folded into #548 | #548 open | mechanical |", "| alpha | `a` | 1 | folded into #548 | #548 open | mechanical |");
		expect(() => parseLedger(text)).toThrow(/expected 7 cells, found 6/);
	});

	it("refuses a conflict marker", () => {
		const text = base.replace("## Windows", "<<<<<<< HEAD\n## Windows");
		expect(() => parseLedger(text)).toThrow(/conflict marker/);
	});

	it("tolerates an unescaped pipe in the LOG but not in the ledger", () => {
		// The real row 189 carries `31 passed | 1 skipped` unescaped; history is not rewritten.
		const log = parseLog(mkLog(["31 passed | 1 skipped"]));
		expect(log.rows).toHaveLength(1);
		expect(log.rows[0].observation).toBe("31 passed|1 skipped");
		// The ledger is ours, so it is strict: the same byte in a seven-cell table makes eight cells.
		const text = mkLedger(
			[{ cycle: "alpha", from: 1, to: 1 }],
			[{ cycle: "alpha", class: "a", rows: "1", evidence: "31 passed | 1 skipped", disposition: "folded into #548", issue: "#548 open" }],
		);
		expect(() => parseLedger(text)).toThrow(/expected 7 cells, found 8/);
	});

	it("reads an escaped pipe as one cell", () => {
		const text = mkLedger(
			[{ cycle: "alpha", from: 1, to: 1 }],
			[{ cycle: "alpha", class: "a", rows: "1", evidence: "31 passed \\| 1 skipped", disposition: "folded into #548", issue: "#548 open" }],
		);
		const ledger = parseLedger(text);
		expect(ledger.dispositions[0].evidence).toBe("31 passed | 1 skipped");
	});
});

describe("friction-disposition — case 10: the closing gate", () => {
	const windows: WindowSpec[] = [{ cycle: "alpha", from: 1, to: 2 }];
	const dispositions: DispositionSpec[] = [
		{ cycle: "alpha", class: "a", rows: "1,2", disposition: "folded into #548", issue: "#548 open" },
	];
	const factSet = facts({ states: { 548: "OPEN" } });

	it("passes plain while a later row exists, and refuses close mode until it is covered", () => {
		const before = mkLog(["one", "two"]);
		const appended = `${before}| 2026-11-21 | tooling | fresh friction |\n`;
		expect(runCheck(mkLedger(windows, dispositions), before, "alpha", factSet, { close: true }).problems).toEqual([]);
		expect(runCheck(mkLedger(windows, dispositions), appended, "alpha", factSet).problems).toEqual([]);

		const closed = runCheck(mkLedger(windows, dispositions), appended, "alpha", factSet, { close: true });
		expect(codesOf(closed)).toEqual(["unassigned-close"]);
		expect(closed.problems[0].message).toBe("log has rows 3..3 unassigned — re-declare at close");
		expect(closed.problems[0].exit).toBe(EXIT.LEDGER);
	});

	it("does not demand a class for a RECORD inside the window — records are excluded from coverage", () => {
		// The record is the window's own last row: its extent reaches the log's last data row, and coverage
		// still partitions only the friction rows (review 563 F1 — the extent includes records, coverage never).
		const record = `${mkLog(["one", "two"])}| 2026-11-21 | process | CYCLE 2026-11-21 "x" CLOSED — done |\n`;
		const result = runCheck(mkLedger([{ cycle: "alpha", from: 1, to: 3 }], dispositions), record, "alpha", factSet, { close: true });
		expect(result.problems).toEqual([]);
		expect(result.stats.records).toBe(1);
		expect(result.stats.frictionRows).toBe(2);
		expect(result.stats.assignedRows).toBe(2);
	});

	it("passes close mode when the window ENDS on its own close record (review 563 F1)", () => {
		// The ledger's own pattern: `to` names the close record, which is a DATA row and not a friction row.
		// Comparing `to` to the last friction index made this window permanently un-closeable.
		const recordEnded = `${mkLog(["one"])}| 2026-11-21 | process | CYCLE 2026-11-21 "x" CLOSED — done |\n`;
		const ledger = mkLedger([{ cycle: "alpha", from: 1, to: 2 }], [
			{ cycle: "alpha", class: "a", rows: "1", disposition: "folded into #548", issue: "#548 open" },
		]);
		const passed = runCheck(ledger, recordEnded, "alpha", factSet, { close: true });
		expect(passed.problems).toEqual([]);
		expect(passed.stats.records).toBe(1);
		expect(passed.stats.frictionRows).toBe(1);
		expect(passed.stats.assignedRows).toBe(1);

		// One friction row appended past the record: the window no longer reaches the log's last data row,
		// and the refusal names the index left unassigned.
		const appended = `${recordEnded}| 2026-11-21 | tooling | fresh friction |\n`;
		const closed = runCheck(ledger, appended, "alpha", factSet, { close: true });
		expect(codesOf(closed)).toEqual(["unassigned-close"]);
		expect(closed.problems[0].message).toBe("log has rows 3..3 unassigned — re-declare at close");
	});

	it("fails a window widened past the last friction row", () => {
		const result = runCheck(mkLedger([{ cycle: "alpha", from: 1, to: 3 }], dispositions), mkLog(["one", "two"]), "alpha", factSet, {
			close: true,
		});
		expect(codesOf(result)).toContain("window-past-log");
	});
});

describe("friction-disposition — case 11: close mode binds the last window", () => {
	const ledgerText = mkLedger(
		[
			{ cycle: "alpha", from: 1, to: 1 },
			{ cycle: "beta", from: 2, to: 2 },
		],
		[
			{ cycle: "alpha", class: "a", rows: "1", disposition: "folded into #548", issue: "#548 open" },
			{ cycle: "beta", class: "b", rows: "2", disposition: "folded into #548", issue: "#548 open" },
		],
	);
	const log = mkLog(["one", "two"]);
	const factSet = facts({ states: { 548: "OPEN" } });

	it("refuses --close on an older window with exit 1 and the last window's name", () => {
		const result = runCheck(ledgerText, log, "alpha", factSet, { close: true });
		expect(codesOf(result)).toContain("not-closing-cycle");
		expect(result.problems.find((problem) => problem.code === "not-closing-cycle")?.message).toBe("not the closing cycle (last: beta)");
		expect(result.problems.find((problem) => problem.code === "not-closing-cycle")?.exit).toBe(EXIT.LEDGER);
	});

	it("refuses an unknown cycle with exit 2", () => {
		const result = runCheck(ledgerText, log, "gamma", factSet);
		expect(codesOf(result)).toEqual(["unknown-cycle"]);
		expect(result.problems[0].exit).toBe(EXIT.CANNOT_CHECK);
	});

	it("refuses --history --close as usage (exit 2)", () => {
		expect(() => parseArgs(["--history", "--close", "--cycle", "alpha"])).toThrow(/--history .*cannot take --close/);
		expect(main(["--history", "--close", "--cycle", "alpha"], { out: () => {}, err: () => {} })).toBe(EXIT.CANNOT_CHECK);
	});
});

describe("friction-disposition — case 12: contiguity and pre-ledger legacy", () => {
	it("refuses a gap and an overlap between windows", () => {
		const gap = mkLedger(
			[
				{ cycle: "alpha", from: 1, to: 1 },
				{ cycle: "beta", from: 3, to: 3 },
			],
			[
				{ cycle: "alpha", class: "a", rows: "1", disposition: "folded into #548", issue: "#548 open" },
				{ cycle: "beta", class: "b", rows: "3", disposition: "folded into #548", issue: "#548 open" },
			],
		);
		expect(codesOf(runCheck(gap, mkLog(["one", "two", "three"]), "alpha", facts({ states: { 548: "OPEN" } })))).toContain("contiguity");

		const overlap = mkLedger(
			[
				{ cycle: "alpha", from: 1, to: 3 },
				{ cycle: "beta", from: 2, to: 2 },
			],
			[
				{ cycle: "alpha", class: "a", rows: "1,2,3", disposition: "folded into #548", issue: "#548 open" },
				{ cycle: "beta", class: "b", rows: "2", disposition: "folded into #548", issue: "#548 open" },
			],
		);
		expect(codesOf(runCheck(overlap, mkLog(["one", "two", "three"]), "alpha", facts({ states: { 548: "OPEN" } })))).toContain("contiguity");
	});

	it("reports rows before the first window as legacy, and never demands a class for them", () => {
		const ledgerText = mkLedger(
			[{ cycle: "alpha", from: 5, to: 5 }],
			[{ cycle: "alpha", class: "a", rows: "5", disposition: "folded into #548", issue: "#548 open" }],
		);
		const result = runCheck(ledgerText, mkLog(["one", "two", "three", "four", "five"]), "alpha", facts({ states: { 548: "OPEN" } }));
		expect(result.problems).toEqual([]);
		expect(result.stats.legacy).toBe(4);
	});
});

describe("friction-disposition — case 13: an empty input is exit 2, never 0", () => {
	it("refuses an empty ledger and a ledger with no ## Windows section", () => {
		expect(() => parseLedger("")).toThrow(/no ## Windows section/);
		expect(() => parseLedger("# Friction dispositions\n\n## Dispositions\n\n| cycle | class | rows | evidence | disposition | issue | fix |\n|---|---|---|---|---|---|---|\n")).toThrow(
			/no ## Windows section/,
		);
	});

	it("refuses an empty log at the check level", () => {
		const result = check({
			ledger: parseLedger(header()),
			log: parseLog(""),
			cycle: "alpha",
			facts: facts({ states: { 548: "OPEN" } }),
		});
		expect(codesOf(result)).toEqual(["empty-log"]);
		expect(result.problems[0].exit).toBe(EXIT.CANNOT_CHECK);
	});

	it("never returns 0 for an empty ledger or an empty log through the CLI", () => {
		const dir = mkdtempSync(join(tmpdir(), "fd-empty-"));
		try {
			writeFileSync(join(dir, "empty.md"), "");
			writeFileSync(join(dir, "ledger.md"), header());
			writeFileSync(join(dir, "log.md"), "");
			writeFileSync(join(dir, "states.json"), JSON.stringify({ version: 1, states: { 548: "OPEN" } }));
			const states = join(dir, "states.json");
			const emptyLedger = runCli(["--check", "--cycle", "alpha", "--ledger", join(dir, "empty.md"), "--log", join(dir, "log.md"), "--states", states]);
			expect(emptyLedger.code).toBe(EXIT.CANNOT_CHECK);
			const emptyLog = runCli(["--check", "--cycle", "alpha", "--ledger", join(dir, "ledger.md"), "--log", join(dir, "log.md"), "--states", states]);
			expect(emptyLog.code).toBe(EXIT.CANNOT_CHECK);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

describe("friction-disposition — case 14: render is minimal and deterministic", () => {
	const windows: WindowSpec[] = [
		{ cycle: "alpha", from: 1, to: 2 },
		{ cycle: "beta", from: 3, to: 4 },
	];
	const dispositions: DispositionSpec[] = [
		{ cycle: "alpha", class: "a-first", rows: "1", disposition: "folded into #561", issue: "#561 open" },
		{ cycle: "alpha", class: "b-second", rows: "2", disposition: "folded into #548", issue: "#548 open" },
		{ cycle: "beta", class: "c-beta", rows: "3,4", disposition: "folded into #562", issue: "#562 open" },
	];
	const unordered: DispositionSpec[] = [
		// Deliberately out of order: render must sort within the cycle, bytewise (M3's kill).
		{ cycle: "alpha", class: "b-second", rows: "2", disposition: "folded into #548", issue: "#548 open" },
		{ cycle: "alpha", class: "a-first", rows: "1", disposition: "folded into #561", issue: "#561 open" },
		{ cycle: "beta", class: "c-beta", rows: "3,4", disposition: "folded into #562", issue: "#562 open" },
	];
	const log = mkLog(["one", "two", "three", "four"]);

	function betaBytes(text: string): string[] {
		return text.split("\n").filter((line) => line.startsWith("| beta |"));
	}

	it("changes exactly one line, leaves another cycle's bytes alone, and is stable on a second render", () => {
		const before = mkLedger(windows, dispositions);
		const ledger = parseLedger(before);
		const factSet = facts({ states: { 548: "OPEN", 561: "CLOSED", 562: "OPEN" } });
		const after = renderCycle(ledger, "alpha", factSet);

		const beforeLines = before.split("\n");
		const afterLines = after.split("\n");
		expect(afterLines).toHaveLength(beforeLines.length);
		const changed = afterLines.filter((line, i) => line !== beforeLines[i]);
		expect(changed).toHaveLength(1);
		expect(changed[0]).toContain("#561 closed");
		expect(betaBytes(after)).toEqual(betaBytes(before));

		// Rows of the cycle are bytewise ascending, whatever order they arrived in.
		const sorted = renderCycle(parseLedger(mkLedger(windows, unordered)), "alpha", factSet);
		const alphaClasses = sorted
			.split("\n")
			.filter((line) => line.startsWith("| alpha |") && line.includes("`"))
			.map((line) => /`([^`]+)`/.exec(line)?.[1]);
		expect(alphaClasses).toEqual(["a-first", "b-second"]);
		expect(compareClasses("a-first", "b-second")).toBeLessThan(0);

		// The rendered text is now current: a check passes, and a second render is byte-identical.
		expect(runCheck(after, log, "alpha", factSet).problems).toEqual([]);
		expect(renderCycle(parseLedger(after), "alpha", factSet)).toBe(after);
	});

	it("builds the issue cell from the disposition's own id, repairing a mismatched cell", () => {
		const text = mkLedger(
			[{ cycle: "alpha", from: 1, to: 1 }],
			[{ cycle: "alpha", class: "a", rows: "1", disposition: "folded into #548", issue: "#561 open" }],
		);
		const rendered = renderCycle(parseLedger(text), "alpha", facts({ states: { 548: "OPEN", 561: "OPEN" } }));
		expect(rendered).toContain("| #548 open |");
	});

	it("leaves a row's issue cell alone when the disposition names no issue", () => {
		const text = mkLedger(
			[{ cycle: "alpha", from: 1, to: 1 }],
			[{ cycle: "alpha", class: "a", rows: "1", evidence: "→ 2026-11-21", disposition: "stale", issue: "#561 open" }],
		);
		expect(renderCycle(parseLedger(text), "alpha", facts({ states: { 561: "OPEN" } }))).toBe(text);
	});

	it("refuses to render through a symlink", () => {
		const dir = mkdtempSync(join(tmpdir(), "fd-link-"));
		try {
			writeFileSync(join(dir, "real.md"), header());
			symlinkSync(join(dir, "real.md"), join(dir, "link.md"));
			writeFileSync(join(dir, "log.md"), mkLog(["one"]));
			writeFileSync(join(dir, "states.json"), '{"version":1,"states":{"548":"OPEN"}}');
			const result = runCli(["--render", "--cycle", "alpha", "--ledger", join(dir, "link.md"), "--states", join(dir, "states.json")]);
			expect(result.code).toBe(EXIT.CANNOT_CHECK);
			expect(result.err).toContain("symlink");
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// Cases 15–17 — the command, with a real file pair and injected states.
// ---------------------------------------------------------------------------

interface RunResult {
	code: number;
	out: string;
	err: string;
}

function runCli(argv: string[], env: Record<string, string> = {}): RunResult {
	const result = spawnSync(process.execPath, [SCRIPT, ...argv], {
		encoding: "utf8",
		cwd: ROOT,
		env: { ...process.env, ...env },
		timeout: 60_000,
	});
	return { code: result.status ?? -1, out: String(result.stdout ?? ""), err: String(result.stderr ?? "") };
}

const SEED_STATES = { 548: "OPEN", 550: "OPEN", 556: "OPEN", 557: "OPEN", 558: "OPEN", 561: "OPEN", 562: "OPEN" };

function statesFile(dir: string, states: Record<string, string> = SEED_STATES): string {
	const path = join(dir, "states.json");
	writeFileSync(path, JSON.stringify({ version: 1, states }));
	return path;
}

describe("friction-disposition — case 15: the seed against the real log, through the CLI", () => {
	let dir: string;
	let ledger: string;
	let log: string;
	let states: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "fd-seed-"));
		ledger = join(dir, "FRICTION_DISPOSITIONS.md");
		log = join(dir, "FRICTION_LOG.md");
		copyFileSync(REAL_LEDGER, ledger);
		copyFileSync(REAL_LOG, log);
		states = statesFile(dir);
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const argv = () => ["--check", "--cycle", "settle-handlers", "--ledger", ledger, "--log", log, "--states", states];

	it("exits 0 on the seed", () => {
		const result = runCli(argv());
		expect(result.code).toBe(EXIT.OK);
		expect(result.out).toContain("coverage: 1/1 friction rows assigned");
		expect(result.out).toContain("legacy: 196");
	});

	it("exits 1 naming 197 when the class covering it is deleted, and 0 again when restored", () => {
		const original = readFileSync(ledger, "utf8");
		const without = original
			.split("\n")
			.filter((line) => !line.startsWith("| settle-handlers | `handoff-verify-prose-claim`"))
			.join("\n");
		writeFileSync(ledger, without);
		// The deleted class was the only reference to #561, so the fact set shrinks with the ledger.
		const { 561: _dropped, ...reduced } = SEED_STATES;
		writeFileSync(states, JSON.stringify({ version: 1, states: reduced }));
		const deleted = runCli(argv());
		expect(deleted.code).toBe(EXIT.LEDGER);
		expect(deleted.err).toContain("row 197");
		expect(deleted.err).toContain("no class");

		writeFileSync(ledger, original);
		writeFileSync(states, JSON.stringify({ version: 1, states: SEED_STATES }));
		expect(runCli(argv()).code).toBe(EXIT.OK);
	});
});

describe("friction-disposition — case 16: unreadable inputs are exit 2", () => {
	let dir: string;
	let ledger: string;
	let log: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "fd-bad-"));
		ledger = join(dir, "ledger.md");
		log = join(dir, "log.md");
		writeFileSync(ledger, header());
		writeFileSync(log, mkLog(["one"]));
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("refuses malformed states JSON, an unreadable ledger and an unknown cycle", () => {
		const badStates = join(dir, "bad-states.json");
		writeFileSync(badStates, "{not json");
		const malformed = runCli(["--check", "--cycle", "alpha", "--ledger", ledger, "--log", log, "--states", badStates]);
		expect(malformed.code).toBe(EXIT.CANNOT_CHECK);
		expect(malformed.err).toContain("states file is not JSON");

		const unreadable = runCli(["--check", "--cycle", "alpha", "--ledger", join(dir, "nope.md"), "--log", log, "--states", statesFile(dir)]);
		expect(unreadable.code).toBe(EXIT.CANNOT_CHECK);
		expect(unreadable.err).toContain("cannot read ledger");

		const unknown = runCli(["--check", "--cycle", "gamma", "--ledger", ledger, "--log", log, "--states", statesFile(dir)]);
		expect(unknown.code).toBe(EXIT.CANNOT_CHECK);
		expect(unknown.err).toContain('unknown cycle "gamma"');
	});
});

describe("friction-disposition — case 17: the candidates seam", () => {
	let dir: string;
	let ledger: string;
	let log: string;
	let states: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "fd-candidates-"));
		ledger = join(dir, "ledger.md");
		log = join(dir, "log.md");
		writeFileSync(ledger, header());
		writeFileSync(log, mkLog(["one"]));
		states = statesFile(dir, { 548: "OPEN" });
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	function candidateFile(name: string, payload: unknown): string {
		const path = join(dir, `${name}.json`);
		writeFileSync(path, JSON.stringify(payload));
		return path;
	}

	function event(overrides: Record<string, unknown> = {}) {
		return {
			eventId: "run-1:failed:1",
			kind: "failed",
			runId: "run-1",
			ts: "2026-11-21T04:00:00Z",
			class: "a",
			count: 1,
			source: "settle outcome",
			dismissed: null,
			...overrides,
		};
	}

	const argv = (candidates: string) => ["--check", "--cycle", "alpha", "--ledger", ledger, "--log", log, "--states", states, "--candidates", candidates];

	it("accepts a cited event and a dismissed event", () => {
		const cited = runCli(argv(candidateFile("cited", { version: 1, cycle: "alpha", claimedLive: true, candidates: [event()] })));
		expect(cited.code).toBe(EXIT.OK);
		expect(cited.out).toContain("candidates: 1 (cited 1, dismissed 0)");

		const dismissed = runCli(
			argv(candidateFile("dismissed", { version: 1, cycle: "alpha", claimedLive: true, candidates: [event({ class: null, dismissed: "not friction" })] })),
		);
		expect(dismissed.code).toBe(EXIT.OK);
		expect(dismissed.out).toContain("candidates: 1 (cited 0, dismissed 1)");
	});

	it("refuses an event with neither a class nor a dismissal", () => {
		const result = runCli(argv(candidateFile("neither", { version: 1, cycle: "alpha", claimedLive: true, candidates: [event({ class: null, dismissed: null })] })));
		expect(result.code).toBe(EXIT.LEDGER);
		expect(result.err).toContain("neither a class nor a dismissal");
	});

	it("refuses claimedLive with an empty list", () => {
		const result = runCli(argv(candidateFile("live-empty", { version: 1, cycle: "alpha", claimedLive: true, candidates: [] })));
		expect(result.code).toBe(EXIT.LEDGER);
		expect(result.err).toContain("claimedLive is true but the file carries no candidates");
	});

	it("accepts two events of the same class — identity is the eventId", () => {
		const payload = {
			version: 1,
			cycle: "alpha",
			claimedLive: true,
			candidates: [event({ eventId: "run-1:failed:1" }), event({ eventId: "run-2:failed:1" })],
		};
		const result = runCli(argv(candidateFile("same-class", payload)));
		expect(result.code).toBe(EXIT.OK);
		expect(result.out).toContain("candidates: 2 (cited 2, dismissed 0)");
	});

	it("accepts an explicit not-live, empty cycle and says so", () => {
		const result = runCli(argv(candidateFile("not-live", { version: 1, cycle: "alpha", claimedLive: false, candidates: [] })));
		expect(result.code).toBe(EXIT.OK);
		expect(result.out).toContain("candidates: 0 (declared not live)");
	});

	it("refuses a duplicate eventId and a wrong cycle as unreadable (exit 2)", () => {
		expect(() =>
			parseCandidates(
				JSON.stringify({ version: 1, cycle: "alpha", claimedLive: true, candidates: [event(), event()] }),
				"alpha",
			),
		).toThrow(/duplicate eventId/);
		expect(() => parseCandidates(JSON.stringify({ version: 1, cycle: "beta", claimedLive: true, candidates: [] }), "alpha")).toThrow(
			/names cycle "beta"/,
		);
	});
});

// ---------------------------------------------------------------------------
// §9 boundaries — a stub `gh` on PATH, one variant per discriminator. No network.
// ---------------------------------------------------------------------------

describe("friction-disposition — the gh boundary (stub on PATH)", () => {
	let dir: string;
	let bin: string;
	let ledgerOpen: string;
	let ledgerClosed: string;
	let ledgerMissing: string;
	let log: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "fd-gh-"));
		bin = join(dir, "bin");
		mkdirSync(bin);
		const stub = join(bin, "gh");
		writeFileSync(
			stub,
			[
				"#!/bin/sh",
				'case "$FD_STUB" in',
				'  open) printf \'{"number":%s,"state":"OPEN"}\\n\' "$3"; exit 0 ;;',
				'  closed) printf \'{"number":%s,"state":"CLOSED"}\\n\' "$3"; exit 0 ;;',
				'  missing) echo "Could not resolve to an issue or pull request with the number of $3." >&2; exit 1 ;;',
				'  auth) echo "HTTP 401: Bad credentials" >&2; exit 1 ;;',
				'  malformed) printf "not json\\n"; exit 0 ;;',
				"  *) echo \"unexpected FD_STUB=$FD_STUB\" >&2; exit 1 ;;",
				"esac",
				"",
			].join("\n"),
		);
		spawnSync("chmod", ["755", stub]);

		ledgerOpen = join(dir, "open.md");
		ledgerClosed = join(dir, "closed.md");
		ledgerMissing = join(dir, "missing.md");
		const folded = (issue: string) =>
			mkLedger(
				[{ cycle: "alpha", from: 1, to: 1 }],
				[{ cycle: "alpha", class: "a", rows: "1", disposition: "folded into #548", issue }],
			);
		writeFileSync(ledgerOpen, folded("#548 open"));
		writeFileSync(ledgerClosed, folded("#548 closed"));
		writeFileSync(
			ledgerMissing,
			mkLedger(
				[{ cycle: "alpha", from: 1, to: 1 }],
				[{ cycle: "alpha", class: "a", rows: "1", evidence: "Rule 11: ≥2", disposition: "P0 #999", issue: "#999 missing" }],
			),
		);
		log = join(dir, "log.md");
		writeFileSync(log, mkLog(["one"]));
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	const env = (variant: string) => ({ FD_STUB: variant, PATH: `${bin}:${process.env.PATH ?? ""}` });

	it("resolves OPEN (exit 0)", () => {
		const result = runCli(["--check", "--cycle", "alpha", "--ledger", ledgerOpen, "--log", log], env("open"));
		expect(result.code).toBe(EXIT.OK);
		expect(result.out).toContain("OPEN 1");
	});

	it("resolves CLOSED for a folded disposition (exit 0)", () => {
		const result = runCli(["--check", "--cycle", "alpha", "--ledger", ledgerClosed, "--log", log], env("closed"));
		expect(result.code).toBe(EXIT.OK);
		expect(result.out).toContain("CLOSED 1");
	});

	it("maps `Could not resolve` to MISSING and exit 1", () => {
		const result = runCli(["--check", "--cycle", "alpha", "--ledger", ledgerMissing, "--log", log], env("missing"));
		expect(result.code).toBe(EXIT.LEDGER);
		expect(result.err).toContain("MISSING");
	});

	it("maps an auth failure to UNAVAILABLE (exit 2) and says it fails closed", () => {
		const result = runCli(["--check", "--cycle", "alpha", "--ledger", ledgerMissing, "--log", log], env("auth"));
		expect(result.code).toBe(EXIT.CANNOT_CHECK);
		expect(result.err).toContain("UNAVAILABLE");
		expect(result.err).toContain("failing closed");
	});

	it("maps malformed JSON to UNAVAILABLE (exit 2)", () => {
		const result = runCli(["--check", "--cycle", "alpha", "--ledger", ledgerMissing, "--log", log], env("malformed"));
		expect(result.code).toBe(EXIT.CANNOT_CHECK);
		expect(result.err).toContain("malformed JSON");
	});

	it("makes no gh call at all when the window references no id", () => {
		const idle = join(dir, "idle.md");
		writeFileSync(
			idle,
			mkLedger(
				[{ cycle: "alpha", from: 1, to: 1 }],
				[{ cycle: "alpha", class: "a", rows: "1", evidence: "→ 2026-11-21", disposition: "stale" }],
			),
		);
		// PATH without the stub and without gh: a call would fail the run.
		const result = spawnSync(process.execPath, [SCRIPT, "--check", "--cycle", "alpha", "--ledger", idle, "--log", log], {
			encoding: "utf8",
			cwd: ROOT,
			env: { ...process.env, PATH: "/nonexistent" },
		});
		expect(result.status).toBe(EXIT.OK);
	});
});

// ---------------------------------------------------------------------------
// §9 real git/doc — a scratch repo and a real heading, through the CLI's own facts.
// ---------------------------------------------------------------------------

describe("friction-disposition — real git and doc referents", () => {
	let dir: string;

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "fd-real-"));
	});

	afterAll(() => {
		rmSync(dir, { recursive: true, force: true });
	});

	it("resolves a real commit and a real heading, and refuses a changed heading", () => {
		const repo = join(dir, "repo");
		mkdirSync(join(repo, "docs"), { recursive: true });
		writeFileSync(join(repo, "docs", "x.md"), "# Doc\n\n## A Section\n\ntext\n");
		const git = (args: string[]) => spawnSync("git", args, { cwd: repo, encoding: "utf8" });
		git(["init", "-q"]);
		const identity = ["-c", "user.name=t", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false"];
		git([...identity, "add", "."]);
		const commit = git([...identity, "commit", "-qm", "seed"]);
		expect(commit.status).toBe(0);
		const sha = String(git(["rev-parse", "HEAD"]).stdout).trim().slice(0, 7);

		const ledger = join(dir, "ledger.md");
		writeFileSync(
			ledger,
			mkLedger(
				[{ cycle: "alpha", from: 1, to: 1 }],
				[
					{ cycle: "alpha", class: "a", rows: "1", disposition: `fixed ${sha}` },
				],
			),
		);
		const log = join(dir, "log.md");
		writeFileSync(log, mkLog(["one"]));

		// The doc heading is resolved against the SCRIPT's checkout, not the scratch repo, so this test
		// pins the git half through the CLI and the doc half through the injected facts (case 7). A scratch
		// checkout would need its own copy of the script; the heading reader is the same code path.
		const docFacts = facts({ headings: ["docs/x.md::A Section"] });
		expect(docFacts.docHasHeading("docs/x.md", "A Section")).toBe(true);
		expect(docFacts.docHasHeading("docs/x.md", "A Section (changed)")).toBe(false);

		// `fixed <sha>` needs no issue fact; the check reaches the real `git cat-file` through the CLI.
		// The exported repo probe is what the CLI builds; drive it against the scratch repo directly.
		const probe = createRepoFacts(repo, new Map());
		expect(probe.commitExists(sha)).toBe(true);
		expect(probe.commitExists("deadbeef")).toBe(false);
		expect(probe.docHasHeading("docs/x.md", "A Section")).toBe(true);
		writeFileSync(join(repo, "docs", "x.md"), "# Doc\n\n## A Section Changed\n\ntext\n");
		expect(probe.docHasHeading("docs/x.md", "A Section")).toBe(false);

		// The CLI's own git reader runs in this checkout, so a real local commit is the honest probe.
		const local = String(spawnSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).stdout).trim().slice(0, 7);
		writeFileSync(
			ledger,
			mkLedger([{ cycle: "alpha", from: 1, to: 1 }], [{ cycle: "alpha", class: "a", rows: "1", disposition: `fixed ${local}` }]),
		);
		expect(runCli(["--check", "--cycle", "alpha", "--ledger", ledger, "--log", log]).code).toBe(EXIT.OK);
	});

	it("keeps the real git reader honest: a forged sha is refused by the CLI", () => {
		const ledger = join(dir, "forged.md");
		writeFileSync(
			ledger,
			mkLedger([{ cycle: "alpha", from: 1, to: 1 }], [{ cycle: "alpha", class: "a", rows: "1", disposition: "fixed deadbeef" }]),
		);
		const log = join(dir, "log.md");
		writeFileSync(log, mkLog(["one"]));
		const result = runCli(["--check", "--cycle", "alpha", "--ledger", ledger, "--log", log]);
		expect(result.code).toBe(EXIT.LEDGER);
		expect(result.err).toContain("no such commit");
	});
});

// ---------------------------------------------------------------------------
// Ordering helper — pinned directly, and killed under a collation that reorders, because M3's mutant
// sorts with `localeCompare`.
// ---------------------------------------------------------------------------

describe("friction-disposition — ordering is bytewise, not a locale's opinion", () => {
	it("orders the class alphabet the way ASCII does", () => {
		const names = ["a-b", "ab", "a0", "z-class", "a-first", "worktree-scripts-outside-budgets"];
		expect([...names].sort(compareClasses)).toEqual(["a-b", "a-first", "a0", "ab", "worktree-scripts-outside-budgets", "z-class"]);
	});

	// M3's kill. `localeCompare` under the default (en-US) collation is bytewise-equivalent over the
	// schema alphabet, so an in-process assertion cannot tell the mutant from the contract. Under the
	// Danish collation `aa` sorts after `ab` (it is `å`), so a render run in that locale separates them —
	// and `--render` must still emit bytewise order, because the order is a contract, not an opinion.
	const DANISH = { LANG: "da_DK.UTF-8", LC_ALL: "da_DK.UTF-8", LANGUAGE: "da_DK" };
	const danishReorders = Intl.Collator("da").compare("aa", "ab") > 0;

	it.skipIf(!danishReorders)("renders bytewise even when the ambient collation would not", () => {
		// The mutant's own ordering, stated: this is what M3 would write on disk.
		expect(["aa", "ab"].sort((a, b) => a.localeCompare(b, "da"))).toEqual(["ab", "aa"]);

		const dir = mkdtempSync(join(tmpdir(), "fd-locale-"));
		const ledger = join(dir, "ledger.md");
		writeFileSync(
			ledger,
			mkLedger(
				[{ cycle: "alpha", from: 1, to: 2 }],
				[
					{ cycle: "alpha", class: "ab", rows: "2", evidence: "second", disposition: "stale" },
					{ cycle: "alpha", class: "aa", rows: "1", evidence: "first", disposition: "stale" },
				],
			),
		);
		const result = runCli(["--render", "--cycle", "alpha", "--ledger", ledger], DANISH);
		expect(result.err).toBe("");
		expect(result.code).toBe(EXIT.OK);
		const classes = readFileSync(ledger, "utf8")
			.split("\n")
			.filter((line) => line.startsWith("| alpha |") && line.includes("`"))
			.map((line) => /`([^`]+)`/.exec(line)?.[1]);
		expect(classes).toEqual(["aa", "ab"]);
	});
});

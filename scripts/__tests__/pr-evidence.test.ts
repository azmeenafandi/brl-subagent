/**
 * Tests for `scripts/pr-evidence.mjs` + `scripts/lib/pr-evidence.mjs` (issue #488) — the PR body's
 * numbers are generated and recomputed, not transcribed.
 *
 * Three bodies in one cycle carried counts that did not match the tree (S5's `landed at 338` for 353,
 * S6's `44 seam tests` for 84, S6's `stays at 24` for a brand-new helper). Each was caught only because
 * a reviewer happened to check. This file pins the four things that make the replacement safe:
 *
 * 1. the BLOCK is a parser/renderer pair: `renderBlock` → `parseBlock` round-trips, the output is
 *    byte-identical between runs, and every count line must name its command (#488's own rule);
 * 2. the VERDICT names one code per drift, and every fixture under `fixtures/pr-evidence/` fails with
 *    its own code and exit — including the three historical claims, each of which is either caught
 *    (`unattributed-count`) or documented as out of the mechanical set;
 * 3. the BAN LIST is exact: a prose count drifts, the same count inside a fence or a blockquote does
 *    not, and a docs body with no count and no block passes;
 * 4. NOTHING FROM THE BODY IS EVER EXECUTED — a body whose `←` half is a shell command is checked and
 *    the command does not run. That is the non-goal, so it gets a behavioural test, not a comment.
 *
 * `clean.md` is the contract: its block IS the stub fact set, and the other fixtures are mutations of
 * it. One definition of "clean" means a fixture cannot drift from the facts the verdict compares against.
 *
 * The git seam is exercised for real in a throwaway repo (head resolution, the diff counts, and the
 * `src-diff-lines: 0` landmine), while `gh` is replaced by a plain object — the suite needs no network.
 *
 * The suite report is read through `scripts/lib/suite-report.mjs` (#513) with THIS tree's head as the
 * expected provenance, so the cases here pin the wiring rather than the validator: a hollow report
 * cannot become a `suite:` line, `--report` beats `--report-dir`, and a report captured at another
 * commit is refused. The validator's own cases live in `suite-report.test.ts`.
 *
 * COVERAGE — what these probes do NOT cover, stated rather than implied: a report mutated between
 * validation and use (the values are read once and never re-read), and non-Linux paths (the `tmpfs`
 * clause of the private root is not portable, so a root Linux would refuse is unexamined there).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { EXIT, countPaths, createEvidenceProbe, main, parseArgs, ROOT, sumNumstat } from "../pr-evidence.mjs";
import {
	ARROW,
	BLOCK,
	CODES,
	checkBody,
	formatRatio,
	parseBlock,
	renderBlock,
	sameHead,
	scanBlocks,
	unattributedCounts,
	upsertBlock,
} from "../lib/pr-evidence.mjs";

const FIXTURES = join(ROOT, "scripts", "__tests__", "fixtures", "pr-evidence");
const HEAD = "8e7f6a5c4b3a2918171615141312111009080706";
const OTHER = "4c1d9ab2f1e0c3d4e5f60718293a4b5c6d7e8f90";

/** `n` passed assertions — the only shape that makes a report evidence (#513). */
function assertions(n: number): { fullName: string; status: string }[] {
	return Array.from({ length: n }, (_unused, index) => ({ fullName: `t${index}`, status: "passed" }));
}

/** A green report body of `tests` assertions in `files` result entries. */
function suiteBody(files: number, tests: number): unknown {
	return {
		numTotalTests: tests,
		numPassedTests: tests,
		testResults: Array.from({ length: files }, (_unused, index) => ({
			assertionResults: assertions(index === 0 ? tests - (files - 1) : 1),
		})),
	};
}

function text(name: string): string {
	return readFileSync(join(FIXTURES, `${name}.md`), "utf8");
}

/**
 * The measured facts, read out of `clean.md`'s own block: the fixture IS the contract, so a fixture can
 * never be "clean" against facts that were typed somewhere else.
 */
const CONTRACT = parseBlock(text("clean").split("\n"), scanBlocks(text("clean").split("\n")).ranges[0]).values;

const ACTUAL = {
	head: String(CONTRACT.head),
	changedFiles: Number(CONTRACT["changed-files"]),
	srcDiffLines: Number(CONTRACT["src-diff-lines"]),
	suite: CONTRACT.suite as { files: number; tests: number },
	budget: CONTRACT.budget as { src: string; scripts: string },
};

/** The verdict over one fixture, against the contract facts. */
function verdict(name: string) {
	return checkBody(text(name), ACTUAL);
}

/**
 * Fixture → expected exit and codes. Every fixture in the directory must appear here: a fixture nobody
 * asserts is a fixture that silently stops meaning anything.
 */
const CASES: Array<[string, number, string[]]> = [
	["clean", EXIT.OK, []],
	["stale-head", EXIT.DRIFT, [CODES.staleHead]],
	["stale-suite", EXIT.DRIFT, [CODES.staleSuite]],
	["stale-changed-files", EXIT.DRIFT, [CODES.staleChangedFiles]],
	["stale-src-diff", EXIT.DRIFT, [CODES.staleSrcDiff]],
	["stale-budget", EXIT.DRIFT, [CODES.staleBudget]],
	["two-blocks", EXIT.DRIFT, [CODES.multipleBlocks]],
	["no-block", EXIT.USAGE, [CODES.missingBlock]],
	["unattributed", EXIT.DRIFT, [CODES.unattributedCount]],
	["fenced-count", EXIT.OK, []],
	["fence-length", EXIT.OK, []],
	["docs-only", EXIT.OK, []],
	// The three historical claims (#488): caught, or out of the mechanical set and said so.
	["historical-s5-338", EXIT.OK, []],
	["historical-s6-suite", EXIT.DRIFT, [CODES.unattributedCount]],
	["historical-s6-complexity", EXIT.OK, []],
];

describe("pr-evidence — the block", () => {
	it("renders the five keys in order, each count naming its command", async () => {
		const block = renderBlock(ACTUAL, { base: "dev" });
		const lines = block.split("\n");
		expect(lines[0]).toBe(BLOCK.begin);
		expect(lines[lines.length - 1]).toBe(BLOCK.end);
		expect(lines.slice(1, -1).map((line) => line.slice(0, line.indexOf(":")))).toEqual([
			"head",
			"changed-files",
			"src-diff-lines",
			"suite",
			"budget",
		]);
		for (const line of lines.slice(2, -1)) expect(line).toContain(`${ARROW} `);
		// The arrow text is documentation: the scope it names is the base and the resolved head.
		expect(block).toContain(`git diff --name-only dev...${HEAD} | wc -l`);
	});

	it("round-trips: render → parse gives back the values it was given", async () => {
		const block = renderBlock(ACTUAL, { base: "dev" });
		const lines = block.split("\n");
		const parsed = parseBlock(lines, scanBlocks(lines).ranges[0]);
		expect(parsed.values).toEqual({
			head: HEAD,
			"changed-files": ACTUAL.changedFiles,
			"src-diff-lines": ACTUAL.srcDiffLines,
			suite: ACTUAL.suite,
			budget: ACTUAL.budget,
		});
		expect(parsed.commands["src-diff-lines"]).toContain("git diff --numstat");
	});

	it("is deterministic: two renders of one measurement are byte-identical, and carry no timestamp", async () => {
		const first = renderBlock({ ...ACTUAL, budget: { src: 1.9904, scripts: 0.6149 } }, { base: "dev" });
		const second = renderBlock({ ...ACTUAL, budget: { src: 1.9904, scripts: 0.6149 } }, { base: "dev" });
		expect(second).toBe(first);
		expect(first).not.toMatch(/\d{4}-\d{2}-\d{2}/);
		// Ratios are the guard's own two-decimal spelling, never a longer float.
		expect(first).toContain(`budget: src ${formatRatio(1.9904)} · scripts ${formatRatio(0.6149)} `);
	});

	it("reports a missing key by name rather than silently comparing nothing", async () => {
		const body = text("clean").replace(/^suite:.*\n/m, "");
		const result = checkBody(body, ACTUAL);
		expect(result.exit).toBe(EXIT.DRIFT);
		expect(result.findings.map((finding: { code: string }) => finding.code)).toEqual([CODES.missingKey]);
	});

	it("reports a count with no command as missing-command (#488's rule inside the block)", async () => {
		const body = text("clean").replace(/^changed-files: 5 .*\n/m, "changed-files: 5\n");
		const codes = checkBody(body, ACTUAL).findings.map((finding: { code: string }) => finding.code);
		expect(codes).toEqual([CODES.missingCommand]);
	});

	it("tolerates a HEAD line with no command — the spec's own block shape has none there", async () => {
		const body = text("clean").replace(/^head: .*\n/m, `head: ${HEAD}\n`);
		expect(checkBody(body, ACTUAL).exit).toBe(EXIT.OK);
	});
});

describe("pr-evidence — the three historical claims (#488)", () => {
	it("S5's `landed at 338` is out of the mechanical set, and says why", async () => {
		// No unit noun ⇒ the ban list (number + files/tests/lines) cannot see it, and the block has no
		// per-file line-count key. A check that guessed "338 is a line count" would fail closed on prose.
		expect(verdict("historical-s5-338")).toEqual({ exit: EXIT.OK, blocks: 1, findings: [] });
		// The same stale number, worded with a unit, IS caught — the boundary is the wording, not the value.
		const reworded = text("historical-s5-338").replace("landed at 338", "landed at 338 lines");
		expect(checkBody(reworded, ACTUAL).findings.map((finding: { code: string }) => finding.code)).toEqual([
			CODES.unattributedCount,
		]);
	});

	it("S6's `44 seam tests` is caught as an unattributed count", async () => {
		const [finding] = verdict("historical-s6-suite").findings;
		expect(finding.code).toBe(CODES.unattributedCount);
		expect(finding.text).toBe("The two new files add 44 seam tests.");
	});

	it("S6's `stays at complexity 24` is out of the mechanical set — stated, not guessed at", async () => {
		// A complexity is not one of the five keys, and "24" has no unit noun. `docs-arch` owns complexity;
		// inventing an AST heuristic here would fail closed on a legitimate rewrite of the sentence.
		expect(verdict("historical-s6-complexity")).toEqual({ exit: EXIT.OK, blocks: 1, findings: [] });
	});
});

describe("pr-evidence — the ban list", () => {
	it("takes every fixture's verdict, one named code per finding", async () => {
		for (const [name, exit, codes] of CASES) {
			const result = verdict(name);
			expect([name, result.exit, result.findings.map((finding: { code: string }) => finding.code)]).toEqual([name, exit, codes]);
		}
	});

	it("covers every fixture on disk", async () => {
		const { readdirSync } = await import("node:fs");
		const files = readdirSync(FIXTURES)
			.filter((file) => file.endsWith(".md"))
			.map((file) => file.replace(/\.md$/, ""))
			.sort();
		expect(CASES.map(([name]) => name).sort()).toEqual(files);
	});

	it("exempts a blockquote — quoting an old value is legitimate", async () => {
		const body = `${text("clean")}\n\n> The previous body said 44 seam tests.\n`;
		expect(checkBody(body, ACTUAL).exit).toBe(EXIT.OK);
	});

	it("counts a line once, with the line's own number and text", async () => {
		const body = `${text("clean")}\n\nIt runs 44 tests, touching 3 files.\n`;
		const findings = checkBody(body, ACTUAL).findings;
		expect(findings).toHaveLength(1);
		expect(findings[0]).toMatchObject({
			code: CODES.unattributedCount,
			line: text("clean").split("\n").length + 2,
			text: "It runs 44 tests, touching 3 files.",
		});
	});

	it("ignores digits that are not a count", async () => {
		const lines = ["Fixed in #488.", "C2 · worktree y", "Rule 11 escalation", "100% of it", "2.0 is the ceiling"];
		expect(unattributedCounts(lines, [])).toEqual([]);
	});
});

describe("pr-evidence — no block, or the wrong number of them", () => {
	it("passes a docs body with no counts and no block", async () => {
		expect(verdict("docs-only")).toEqual({ exit: EXIT.OK, blocks: 0, findings: [] });
	});

	it("is exit 2 — not a drift — when a count has no block to live in", async () => {
		const result = verdict("no-block");
		expect(result.exit).toBe(EXIT.USAGE);
		expect(result.findings[0].detail).toContain("a block is required");
	});

	it("names an unclosed block instead of reading it as clean", async () => {
		const result = checkBody(`${BLOCK.begin}\nhead: ${HEAD}\n`, ACTUAL);
		expect(result.exit).toBe(EXIT.USAGE);
		expect(result.findings[0].code).toBe(CODES.missingBlock);
	});

	it("collapses two blocks when --apply rewrites the body", async () => {
		const block = renderBlock(ACTUAL, { base: "dev" });
		const once = upsertBlock(text("two-blocks"), block);
		expect(scanBlocks(once.split("\n")).ranges).toHaveLength(1);
		// Idempotent: the rewrite of the rewrite is the same bytes.
		expect(upsertBlock(once, block)).toBe(once);
		expect(checkBody(once, ACTUAL).exit).toBe(EXIT.OK);
	});

	it("appends the block to a body that has none", async () => {
		const block = renderBlock(ACTUAL, { base: "dev" });
		const applied = upsertBlock(text("docs-only"), block);
		expect(applied.endsWith(`${block}\n`)).toBe(true);
		expect(checkBody(applied, ACTUAL).exit).toBe(EXIT.OK);
	});
});

describe("pr-evidence — nothing read from a body is executed", () => {
	it("checks a body whose ← half is a shell command without running it", async () => {
		const dir = mkdtempSync(join(tmpdir(), "brl-pr-evidence-exec-"));
		const canary = join(dir, "pwned");
		try {
			const body = text("clean").replace(
				/^changed-files: 5 .*\n/m,
				`changed-files: 5 ${ARROW} : > ${canary}\n`,
			);
			const result = checkBody(body, ACTUAL);
			// The command half is documentation: it is neither validated nor run, so a shell command there is
			// inert text. The canary is the point — a checker that shelled out would create it.
			expect(result).toEqual({ exit: EXIT.OK, blocks: 1, findings: [] });
			expect(existsSync(canary)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("runs no body text through the CLI either, even with the real probe", async () => {
		const dir = mkdtempSync(join(tmpdir(), "brl-pr-evidence-cli-"));
		const canary = join(dir, "pwned");
		const bodyPath = join(dir, "body.md");
		try {
			writeFileSync(bodyPath, text("clean").replace(/^budget: src .*\n/m, `budget: src 1.99 · scripts 0.61 ${ARROW} sh -c ": > ${canary}"\n`));
			const code = main(["--check", "--body", bodyPath], { probe: stubProbe(), out: () => {}, err: () => {} });
			expect(code).toBe(EXIT.OK);
			expect(existsSync(canary)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// The CLI — probes in, exit codes out.
// ---------------------------------------------------------------------------

interface Run {
	code: number;
	out: string;
	err: string;
}

/** The repo side, stubbed: no git, no `gh`, no report. The values are `ACTUAL`. */
function stubProbe(overrides: Record<string, unknown> = {}) {
	return {
		root: "/repo",
		resolveHead: () => HEAD,
		changedFiles: () => ACTUAL.changedFiles,
		srcDiffLines: () => ACTUAL.srcDiffLines,
		suite: () => ({ files: ACTUAL.suite.files, tests: ACTUAL.suite.tests, path: "/tmp/vitest-report.json" }),
		budget: () => ({ src: Number(ACTUAL.budget.src), scripts: Number(ACTUAL.budget.scripts) }),
		prView: () => ({ head: HEAD, body: text("clean") }),
		prEdit: () => undefined,
		...overrides,
	};
}

function run(argv: string[], probe = stubProbe()): Run {
	const out: string[] = [];
	const err: string[] = [];
	const code = main(argv, { probe, out: (line: string) => void out.push(line), err: (line: string) => void err.push(line) });
	return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("pr-evidence — the CLI", () => {
	it("--emit prints the block, and its JSON carries the same values", async () => {
		const emitted = run(["--emit"]);
		expect(emitted.code).toBe(EXIT.OK);
		expect(emitted.out).toBe(renderBlock(ACTUAL, { base: "dev" }));
		expect(emitted.err).toContain("/tmp/vitest-report.json");

		const json = run(["--emit", "--json"]);
		expect(JSON.parse(json.out)).toMatchObject({ ok: true, base: "dev", block: emitted.out });
		expect(JSON.parse(json.out).evidence.suite).toEqual(ACTUAL.suite);
	});

	it("prints the report's path AND its provenance on stderr, never inside the block", async () => {
		const labelled = run(["--emit"], stubProbe({ suite: () => ({ files: ACTUAL.suite.files, tests: ACTUAL.suite.tests, path: "/reports/head.json", label: "unattributed (dirty tree)" }) }));
		expect(labelled.code).toBe(EXIT.OK);
		expect(labelled.err).toContain("/reports/head.json (unattributed (dirty tree))");
		// Determinism: the path and the label are provenance, not block content.
		expect(labelled.out).not.toContain("/reports/head.json");
		expect(labelled.out).not.toContain("dirty tree");
	});

	it("--emit is byte-identical between runs", async () => {
		expect(run(["--emit"]).out).toBe(run(["--emit"]).out);
	});

	it("--emit honours --base and --head", async () => {
		const emitted = run(["--emit", "--base", "dev", "--head", OTHER]);
		expect(emitted.err).not.toBe("");
		expect(emitted.out).toContain(`git rev-parse ${OTHER}`);
	});

	it("--check --body passes a clean body and fails a hand-typed stale one (exit 1)", async () => {
		const dir = mkdtempSync(join(tmpdir(), "brl-pr-evidence-check-"));
		try {
			const clean = join(dir, "clean.md");
			writeFileSync(clean, text("clean"));
			expect(run(["--check", "--body", clean]).code).toBe(EXIT.OK);

			// A hand-typed stale suite count — the S6 failure mode, mechanically.
			const stale = join(dir, "stale.md");
			writeFileSync(stale, text("stale-suite"));
			const checked = run(["--check", "--body", stale]);
			expect(checked.code).toBe(EXIT.DRIFT);
			expect(checked.out).toContain(CODES.staleSuite);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("--check --json is machine-readable and exit-coded", async () => {
		const dir = mkdtempSync(join(tmpdir(), "brl-pr-evidence-json-"));
		try {
			const stale = join(dir, "stale.md");
			writeFileSync(stale, text("stale-head"));
			const checked = run(["--check", "--body", stale, "--json"]);
			const payload = JSON.parse(checked.out);
			expect(checked.code).toBe(EXIT.DRIFT);
			expect(payload).toMatchObject({ ok: false, exit: EXIT.DRIFT, blocks: 1 });
			expect(payload.findings[0].code).toBe(CODES.staleHead);
			expect(payload.findings[0].line).toBeGreaterThan(0);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it("--check --pr takes the body and head from gh", async () => {
		expect(run(["--check", "--pr", "488"]).code).toBe(EXIT.OK);
	});

	it("refuses to check a PR head that is not the tree it measures (exit 2)", async () => {
		const checked = run(["--check", "--pr", "488"], stubProbe({ prView: () => ({ head: OTHER, body: text("clean") }) }));
		expect(checked.code).toBe(EXIT.USAGE);
		expect(checked.err).toContain("is not checked out here");
	});

	it("--apply rewrites the block through gh, and the rewritten body checks clean", async () => {
		const edits: Array<{ pr: string; body: string }> = [];
		const probe = stubProbe({ prEdit: (pr: string, body: string) => void edits.push({ pr, body }) });
		const applied = run(["--apply", "--pr", "488"], probe);
		expect(applied.code).toBe(EXIT.OK);
		expect(edits).toHaveLength(1);
		expect(edits[0].pr).toBe("488");
		expect(checkBody(edits[0].body, ACTUAL).exit).toBe(EXIT.OK);
	});

	it("is usage (exit 2) for every malformed invocation", async () => {
		const invocations = [
			[],
			["--check"],
			["--check", "--body", "a.md", "--pr", "1"],
			["--emit", "--pr", "1"],
			["--apply"],
			["--apply", "--pr", "1", "--body", "a.md"],
			["--check", "--body", "a.md", "--head", HEAD],
			["--pr", "abc", "--check"],
			["--base"],
			["--wat"],
		];
		for (const argv of invocations) expect([argv.join(" "), run(argv).code]).toEqual([argv.join(" "), EXIT.USAGE]);
	});

	it("reports an unreadable body as exit 2, not a drift", async () => {
		expect(run(["--check", "--body", "/no/such/body.md"]).code).toBe(EXIT.USAGE);
	});

	it("parseArgs accepts the three modes, --report-dir, and rejects a second mode", () => {
		expect(parseArgs(["--emit"])).toMatchObject({ ok: true, options: { mode: "emit", base: "" } });
		expect(parseArgs(["--check", "--body", "b.md", "--report-dir", "d"]).options).toMatchObject({ mode: "check", reportDir: "d" });
		expect(parseArgs(["--check", "--body", "b.md"]).ok).toBe(true);
		expect(parseArgs(["--apply", "--pr", "9"]).ok).toBe(true);
		expect(parseArgs(["--emit", "--check"])).toMatchObject({ ok: false, message: "one mode at a time" });
	});
});

// ---------------------------------------------------------------------------
// The git seam — real commands in a throwaway repo.
// ---------------------------------------------------------------------------

const TMP = mkdtempSync(join(tmpdir(), "brl-pr-evidence-git-"));

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
});

function git_(cwd: string, ...args: string[]): string {
	const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
	if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
	return result.stdout.trim();
}

/** A repo with a `dev` base, then a commit that changes `src/` and one that does not. */
function repo(name: string) {
	const dir = join(TMP, name);
	mkdirSync(dir, { recursive: true });
	git_(dir, "init", "-q", "-b", "dev");
	writeFileSync(join(dir, "README.md"), "base\n");
	git_(dir, "add", ".");
	git_(dir, "commit", "-q", "-m", "base");
	return { dir, base: git_(dir, "rev-parse", "HEAD") };
}

describe("pr-evidence — the git seam (real git, no gh)", () => {
	it("counts changed paths and src diff lines, and prints 0 for a PR with no src change", async () => {
		const { dir, base } = repo("counts");
		git_(dir, "checkout", "-q", "-b", "work");
		mkdirSync(join(dir, "src"));
		writeFileSync(join(dir, "src", "a.ts"), "one\ntwo\nthree\n");
		writeFileSync(join(dir, "notes.md"), "notes\n");
		git_(dir, "add", ".");
		git_(dir, "commit", "-q", "-m", "src + docs");
		const probe = createEvidenceProbe(dir);
		const withSrc = probe.resolveHead("HEAD");

		expect(withSrc).toMatch(/^[0-9a-f]{40}$/);
		expect(probe.changedFiles(base, withSrc)).toBe(2);
		expect(probe.srcDiffLines(base, withSrc)).toBe(3);

		// A later commit that touches no `src/` path must print 0 — never an empty value.
		writeFileSync(join(dir, "notes.md"), "notes\nmore\n");
		git_(dir, "add", ".");
		git_(dir, "commit", "-q", "-m", "docs only");
		const docsOnly = probe.resolveHead("HEAD");
		expect(probe.changedFiles(withSrc, docsOnly)).toBe(1);
		expect(probe.srcDiffLines(withSrc, docsOnly)).toBe(0);
	});

	it("measures both budget surfaces from the tree, through the guard's own rules", async () => {
		const { dir } = repo("budget");
		mkdirSync(join(dir, "src"), { recursive: true });
		mkdirSync(join(dir, "scripts"), { recursive: true });
		writeFileSync(join(dir, "src", "a.ts"), "one\ntwo\nthree\nfour\n");
		writeFileSync(join(dir, "scripts", "g.mjs"), "one\ntwo\n");
		const budget = createEvidenceProbe(dir).budget();
		expect(budget).toEqual({ src: 0, scripts: 0 });
	});

	it("refuses an unreadable head or base as exit 2 rather than reporting a drift", async () => {
		const { dir } = repo("missing");
		expect(() => createEvidenceProbe(dir).resolveHead("no-such-ref")).toThrow(/no-such-ref/);
	});

	it("reads a suite report and refuses to invent one", async () => {
		const { dir } = repo("report");
		const report = join(dir, "report.json");
		writeFileSync(report, JSON.stringify({ numPassedTests: 7, testResults: [{ assertionResults: assertions(3) }, { assertionResults: assertions(4) }] }));
		expect(createEvidenceProbe(dir, { report }).suite()).toMatchObject({ files: 2, tests: 7, path: report, label: "provenance: absent" });
		expect(() => createEvidenceProbe(dir, { report: join(dir, "nope.json") }).suite()).toThrow(/cannot read/);
	});

	it("refuses a hollow report, so a pass count with nothing behind it cannot become a suite line", async () => {
		const { dir } = repo("hollow");
		const report = join(dir, "hollow.json");
		writeFileSync(report, JSON.stringify({ numPassedTests: 9999, testResults: [{}] }));
		expect(() => createEvidenceProbe(dir, { report }).suite()).toThrow(/hollow-report/);
	});

	it("resolves --report-dir against the head the numbers describe, and never ranks candidates", async () => {
		const { dir } = repo("report-dir");
		const reports = join(dir, "reports");
		mkdirSync(reports);
		const mine = join(reports, "mine.json");
		const theirs = join(reports, "theirs.json");
		writeFileSync(mine, JSON.stringify(suiteBody(2, 7)));
		writeFileSync(theirs, JSON.stringify(suiteBody(2, 11)));
		const writeSidecar = (report: string, head: string) =>
			writeFileSync(`${report}.provenance.json`, JSON.stringify({ head, dirty: false, capturedAt: "2026-11-11T00:00:00.000Z" }));
		writeSidecar(mine, HEAD);
		writeSidecar(theirs, OTHER);
		expect(createEvidenceProbe(dir, { reportDir: reports }).suite(HEAD)).toMatchObject({ path: mine, tests: 7 });
		// Without a head, two candidates are a refusal naming both — never "the newest".
		expect(() => createEvidenceProbe(dir, { reportDir: reports }).suite()).toThrow(/ambiguous-reports/);
		// A report captured at another tree is not evidence about this one.
		expect(() => createEvidenceProbe(dir, { report: theirs }).suite(HEAD)).toThrow(/provenance-mismatch/);
	});

	it("sums numstat text without turning a binary diff into NaN", async () => {
		expect(sumNumstat("")).toBe(0);
		expect(sumNumstat("3\t2\tsrc/a.ts\n")).toBe(5);
		expect(sumNumstat("-\t-\tassets/logo.png\n4\t0\tsrc/b.ts\n")).toBe(4);
		expect(countPaths("")).toBe(0);
		expect(countPaths("a\nb\n")).toBe(2);
		expect(sameHead(HEAD.slice(0, 7), HEAD)).toBe(true);
		expect(sameHead(OTHER, HEAD)).toBe(false);
	});
});

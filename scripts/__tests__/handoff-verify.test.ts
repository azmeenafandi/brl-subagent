/**
 * Tests for `scripts/handoff-verify.mjs` (issue #495) and the index it checks (#607) — one command that
 * diffs the handoff against the repo.
 *
 * TWO SUBJECTS since #607, and this file pins both: `.development/HANDOFF.md` is an INDEX (four §STATE
 * lines, bounded sections, no counts) and `.development/handoff/state.md` is the PAGE that carries the
 * mechanical claims. `parseClaims` is byte-unchanged, so the page's grammar is the grammar the previous
 * handoff promised; the index has no claim grammar at all, which is what makes it small.
 *
 * The tool exists because every reconciliation at U1 was mechanical: a stale suite count, a closed issue
 * still in `Open:`, a stale dev sha. Prose cannot hold a number, so the number is checked. This file pins
 * the five things that make that safe:
 *
 * 1. the PARSER reads the STATE's fixed shapes — and only those: a historical shape (`**2,006 → 353**`,
 *    `(1,429)`), a quoted field name ("the `Open:` list") and the `PR #402` non-issue are all *not*
 *    claims. The live `.development/handoff/state.md` is parsed as the anti-rot case;
 * 2. the VERDICT names one code per drift, and every fixture fails with its own code and exit 1 — three of
 *    them are the shapes that drifted in the wild at U1;
 * 3. the INDEX is checked for STRUCTURE, not meaning: the H2 set, four §STATE fields, section bounds, the
 *    byte budget, page/link set relations, citation liveness, no counts in prose, one open next action.
 *    Every one of those has a fixture that is `correct.md` with exactly one violation seeded;
 * 4. the SEAMS hold: the git range (`Verified..dev`, renames included), the report resolution and the
 *    injected issue list are exercised for real in a throwaway repo, while `gh`, the network and the page
 *    directory are replaced by a plain object, so the suite needs neither. The report reader itself lives
 *    in `scripts/lib/suite-report.mjs` (#513) and is pinned by `suite-report.test.ts`; this file pins the
 *    fact that this tool keeps no second definition of it — and (#520) that the INDEX's `Verified:` sha is
 *    what reaches that resolver, because the lazily-resolved report is the half that was missing;
 * 5. a SKIP is said out loud (`--no-network`), never silently counted as a pass.
 *
 * The fixtures are `.md` (and one `.json` report) under `fixtures/handoffs/` — invisible to the `scripts`
 * surface's LOC ceiling, and grep-able when a shape costs a handover. The index fixtures live one directory
 * deeper, `fixtures/handoffs/index/`, one file per seeded violation.
 *
 * COVERAGE — what these probes do NOT cover, stated rather than implied: a report MUTATED between the
 * read that validated it and the read that uses it (the tool consumes the validated snapshot and never
 * re-opens the path), non-Linux hosts (the private root's `tmpfs` clause is Linux-only, so a root that
 * Linux refuses may be accepted where the mount type cannot be read), and the MEANING of the index's
 * prose — a bounded line can still hold a sentence, which is the residual #607 states rather than proving
 * away.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { createRepoProbe, EXIT, main, parseArgs, parseRangeLog, readIssues, resolveModulePath, ROOT } from "../handoff-verify.mjs";
import { LABELS, readSuiteReport } from "../lib/suite-report.mjs";
import { collectDecisions } from "../docs-decisions.mjs";
import { collectModules } from "../docs-arch.mjs";
import {
	CODES,
	INDEX_HEADINGS,
	INDEX_LIMITS,
	InputError,
	evaluateIndex,
	evaluateStatePage,
	isHandoffOwnCommit,
	isHandoffOwnPath,
	maskFences,
	parseClaims,
	parseIndex,
	sameRevision,
	scanHeadings,
	stateSection,
} from "../lib/handoff-claims.mjs";

const FIXTURES = join(ROOT, "scripts", "__tests__", "fixtures", "handoffs");
/** The index fixtures — one file per seeded violation, plus `correct.md`. */
const INDEXES = join(FIXTURES, "index");
/** The live documents: the index the extension injects from, and the page that carries the claims. */
const LIVE_INDEX = join(ROOT, ".development", "HANDOFF.md");
const LIVE_PAGE = join(ROOT, ".development", "handoff", "state.md");
const REPORT = join(FIXTURES, "suite-report.json");
const DEV = "4c1d9ab2f1e0c3d4e5f60718293a4b5c6d7e8f90";
const HEAD = "8e7f6a5c4b3a2918171615141312111009080706";
const MISSING_PATH = "/no/such/brl-checkout";

/**
 * The fixture line counts the stubbed probe reports; anything else is a missing file. `gamma.mjs` is a
 * BARE name that resolves under `scripts/` — the #583 case: before the size regex saw `.mjs`, a row
 * naming a script was invisible to the parser and the resolver dropped it, so nothing checked it.
 */
const SIZES: Record<string, { path: string; lines: number }> = {
	"alpha.ts": { path: "/repo/src/alpha.ts", lines: 10 },
	"beta.ts": { path: "/repo/src/beta.ts", lines: 3 },
	"gamma.mjs": { path: "/repo/scripts/gamma.mjs", lines: 7 },
};

/**
 * The suite report the stub returns: the SHAPE `readSuiteReport` returns, because `checkSuite` reads the
 * derived counts (`passed`/`failed`/`skipped`/`failedSuites`/`success`) and not just the totals (#583).
 */
function snapshot(overrides: Record<string, unknown> = {}) {
	return {
		path: REPORT,
		files: 2,
		tests: 12,
		passed: 12,
		failed: 0,
		skipped: 0,
		failedSuites: 0,
		firstFailure: "",
		success: true,
		hasTotal: true,
		...overrides,
	};
}

/**
 * The repo side of every check, stubbed: no git, no `gh`, no network, no real report. `correct.md`'s
 * claims are exactly these facts, which is why the fixture is a contract rather than a sample.
 *
 * `devClaimSha` FOLLOWS `devSha` unless a test states it separately: in the repo the claim is derived from
 * the ref (`resolveDevClaim`), so a stub that moved one and not the other would be a repo that cannot exist.
 */
function stub(overrides: Record<string, unknown> = {}) {
	const probe = {
		root: "/repo",
		indexDir: "/repo/.development",
		headSha: () => HEAD,
		devSha: () => DEV,
		isAncestor: (sha: string) => DEV.startsWith(sha),
		// A cited sha is checked against `dev`, not HEAD (#607): the index describes the branch.
		isAncestorOfDev: () => true,
		commitsAfter: () => [],
		exists: (path: string) => path !== MISSING_PATH,
		// The page directory: one page, which the fixture index links. A test that seeds an unindexed
		// page overrides this instead of adding a fixture nobody else needs.
		pages: () => ["state.md"],
		pointerExists: () => true,
		issueState: () => "open",
		lineCount: (name: string) => SIZES[name] ?? null,
		modules: () => 58,
		adrs: () => 27,
		openIssues: () => [426, 450],
		report: () => snapshot(),
		...overrides,
	};
	return { ...probe, devClaimSha: overrides.devClaimSha ?? probe.devSha };
}

/** A page fixture's text — the mechanical claims, in the grammar `parseClaims` has always read. */
function text(name: string): string {
	return readFileSync(join(FIXTURES, `${name}.md`), "utf8");
}

/** An index fixture's text — the bounded front page (#607). */
function indexText(name: string): string {
	return readFileSync(join(INDEXES, `${name}.md`), "utf8");
}

function claimsOf(name: string) {
	return parseClaims(text(name));
}

function indexOf(name: string) {
	return parseIndex(indexText(name));
}

/** The page pass on a page fixture (#607: checks 2–7, plus the page's own one-§STATE structure guard). */
function pageVerdicts(name: string, probe = stub(), options = {}) {
	return evaluateStatePage(claimsOf(name), probe, options);
}

/** The index pass on an index fixture — seven check families over the parsed front page. */
function indexVerdicts(name: string, probe = stub(), options = {}) {
	return evaluateIndex(indexOf(name), probe, options);
}

/**
 * A real index + page pair on disk, because `--file` names the INDEX and the page is derived from its
 * directory (`.development/handoff/state.md`). Built in a scratch directory so a CLI test can drift one
 * document without touching any other copy.
 */
function pair(page: string, index = "correct"): string {
	const dir = mkdtempSync(join(tmpdir(), "brl-handoff-pair-"));
	mkdirSync(join(dir, "handoff"), { recursive: true });
	writeFileSync(join(dir, "handoff", "state.md"), page.includes("\n") ? page : text(page));
	const indexFile = join(dir, "index.md");
	writeFileSync(indexFile, index.includes("\n") ? index : indexText(index));
	return indexFile;
}

/** The correct pair, built once: most CLI rows read it and drift one fact through the probe instead. */
let correctPair: string | null = null;
function correctIndex(): string {
	if (correctPair === null) correctPair = pair("correct");
	return correctPair;
}

interface Run {
	code: number;
	out: string;
	err: string;
}

function run(argv: string[], probe = stub()): Run {
	const out: string[] = [];
	const err: string[] = [];
	const code = main(argv, {
		probe,
		out: (line: string) => void out.push(line),
		err: (line: string) => void err.push(line),
	});
	return { code, out: out.join("\n"), err: err.join("\n") };
}

/** `correct.md` with one claim removed — for the "a claim vanished" codes. */
function without(needle: string): string {
	return text("correct").replace(needle, "");
}

function resultFor(results: { code?: string }[], code: string) {
	return results.filter((result) => result.code === code);
}

describe("handoff-verify — the parser", () => {
	it("reads every mechanical claim out of the correct fixture", () => {
		const claims = claimsOf("correct");
		// The PAGE carries no `Verified:` (#607 D3): the index owns it, so a page that copied it would be a
		// second source for one sha. `parseClaims` still parses one if a document has it — the grammar is
		// unchanged — but the shipped page does not.
		expect(claims.verified).toBeNull();
		expect(claims.dev).toEqual(["4c1d9ab"]);
		expect(claims.install?.sha).toBe("4c1d9ab");
		expect(claims.install?.path).toEqual({ kind: "repo" });
		expect(claims.open).toEqual([426, 450]);
		expect(claims.suite).toEqual({ files: 2, tests: 12, passed: 12, failed: 0, skipped: 0 });
		expect(claims.modules).toEqual([58]);
		expect(claims.adrs).toEqual([27]);
		expect(claims.sizes).toEqual([
			{ name: "alpha.ts", lines: 10 },
			{ name: "beta.ts", lines: 3 },
			{ name: "gamma.mjs", lines: 7 },
		]);
	});

	it("parses the live page as one document — the anti-rot case", () => {
		const claims = parseClaims(readFileSync(LIVE_PAGE, "utf8"));
		expect(claims.state).not.toBeNull();
		expect(claims.verified).toBeNull();
		expect(claims.dev).toHaveLength(1);
		expect(claims.dev[0]).toMatch(/^[0-9a-f]{7,40}$/);
		expect(claims.install).not.toBeNull();
		expect(claims.open?.length).toBeGreaterThan(0);
		expect(claims.suite?.files).toBeGreaterThan(0);
		expect(claims.suite?.tests).toBeGreaterThan(0);
		expect(claims.modules).toHaveLength(1);
		expect(claims.modules[0]).toBeGreaterThan(0);
		expect(claims.adrs).toHaveLength(1);
		expect(claims.adrs[0]).toBeGreaterThan(0);
		expect(claims.sizes.length).toBeGreaterThan(0);
		// Every size claim names a file this checkout really has, resolved the way the check resolves it.
		for (const size of claims.sizes) expect(resolveModulePath(ROOT, size.name)).not.toBeNull();
	});

	it("never reads a historical shape as a current size claim", () => {
		const claims = claimsOf("correct");
		const names = claims.sizes.map((size: { name: string }) => size.name);
		// `alpha.ts` **20 → 10**, `beta.ts` (9), `alpha.ts` 2,249 vs/versus 2,248 and `alpha.ts`
		// 5+/2− live in `### Since the last handover`, and only the current size (`10`, `3`, `7`) is a claim.
		expect(claims.sizes).toEqual([
			{ name: "alpha.ts", lines: 10 },
			{ name: "beta.ts", lines: 3 },
			{ name: "gamma.mjs", lines: 7 },
		]);
		expect(names).toHaveLength(3);
	});

	it("keeps a bare number, a comma and a closing backtick as claims", () => {
		// The other half of the #505 pin: the exclusions must not swallow a present claim.
		const claims = parseClaims(
			[
				"## STATE",
				"Verified: 4c1d9ab",
				"- **dev** @ `4c1d9ab`.",
				"`alpha.ts` 2,249, and `beta.ts` 10.",
			].join("\n"),
		);
		expect(claims.sizes).toEqual([
			{ name: "alpha.ts", lines: 2249 },
			{ name: "beta.ts", lines: 10 },
		]);
	});

	/** A `## STATE` document — the only surface `parseClaims` scans, so no probe runs over a whole file. */
	function state(body: string) {
		return parseClaims(["## STATE", "Verified: 4c1d9ab", body].join("\n"));
	}

	it("a prose number after a path is not a size claim", () => {
		// D1: `2 call sites` is prose, not a line count. The old regex claimed it for `src/tui.ts`.
		expect(state("- the `src/tui.ts` 2 call sites changed").sizes).toEqual([]);
	});

	it("a comma is not a number", () => {
		// D2: the issue's 0-line claim. `[\d,]+` accepted a bare comma and `parseCount(",")` is 0.
		expect(state("- `src/tui.ts`, changed").sizes).toEqual([]);
		expect(state("- `src/tui.ts`,").sizes).toEqual([]);
	});

	it("a grouped number followed by prose is not a claim", () => {
		// D3: a terminator without an indivisible token backtracks to `3`.
		expect(state("- `a.ts` 3,240 tests were added").sizes).toEqual([]);
	});

	it("a terminated number still claims", () => {
		// The other half: the strict grammar must not swallow a present claim — every terminator, and
		// the comma/list and bold shapes among them.
		const claims = state(
			[
				"- `a.ts` 356; `b.ts` is 3,240",
				"- `c.ts` 12, `d.ts` 3",
				"- `e.ts` 3,240 lines",
				"- `f.ts` is **3,240**",
			].join("\n"),
		);
		expect(claims.sizes).toEqual([
			{ name: "a.ts", lines: 356 },
			{ name: "b.ts", lines: 3240 },
			{ name: "c.ts", lines: 12 },
			{ name: "d.ts", lines: 3 },
			{ name: "e.ts", lines: 3240 },
			{ name: "f.ts", lines: 3240 },
		]);
	});

	it("ungrouped integers are claims", () => {
		// `\d{1,3}(?:,\d{3})*` would read `3240` as `324` and drop the claim; grouping is optional.
		expect(state("- `a.ts` 3240\n- `b.ts` 1000;\n- `c.ts` is 999.").sizes).toEqual([
			{ name: "a.ts", lines: 3240 },
			{ name: "b.ts", lines: 1000 },
			{ name: "c.ts", lines: 999 },
		]);
	});

	it("still drifts on a present claim stated with `is`", () => {
		const present = parseClaims(text("correct").replace("`alpha.ts` is **10**", "`alpha.ts` is 2,249"));
		expect(present.sizes).toContainEqual({ name: "alpha.ts", lines: 2249 });
		const { drifts } = evaluateStatePage(present, stub());
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.fileSizeDrift]);
		expect(drifts[0].actual).toBe("2249 lines");
	});

	it("ignores a quoted field name — a mention is not a claim", () => {
		// `### Next actions` says "The `Open:` list is checked against the board"; the board claim is the
		// earlier line. A backticked `Open:` must not win.
		expect(claimsOf("correct").open).toEqual([426, 450]);
	});

	it("keeps a pull request out of the issue set, and splits a slash pair", () => {
		// `PR #402 held` is a PR, not an issue; `#488/#489` is two issues.
		const claims = parseClaims(["## STATE", "Verified: 4c1d9ab", "- **dev** @ `4c1d9ab`.", "Open: **#488/#489**, PR #402 held."].join("\n"));
		expect(claims.open).toEqual([488, 489]);
	});

	it("collects a repeated single-value claim instead of silently taking the first", () => {
		// The shape an edit leaves when it ADDS a line instead of replacing one: dev, modules and ADRs are
		// collected like the size claims, so the second value is checked instead of being dropped.
		const agreeing = parseClaims(
			[
				"## STATE",
				"Verified: 4c1d9ab",
				"- **dev** @ `4c1d9ab`.",
				"- **dev** @ `4c1d9ab`.",
				"**58 modules**, **58 modules**, **27 ADRs**, **27 ADRs**",
			].join("\n"),
		);
		expect(agreeing.dev).toEqual(["4c1d9ab", "4c1d9ab"]);
		expect(agreeing.modules).toEqual([58, 58]);
		expect(agreeing.adrs).toEqual([27, 27]);
		const disagreeing = parseClaims(
			[
				"## STATE",
				"Verified: 4c1d9ab",
				"- **dev** @ `4c1d9ab`.",
				"- **dev** @ `deadbee1`.",
				"**58 modules**, **59 modules**, **27 ADRs**, **28 ADRs**",
			].join("\n"),
		);
		expect(disagreeing.dev).toEqual(["4c1d9ab", "deadbee1"]);
		expect(disagreeing.modules).toEqual([58, 59]);
		expect(disagreeing.adrs).toEqual([27, 28]);
	});

	it("never reads a divided number as a modules/ADRs claim", () => {
		// `18/48 modules` states a ratio (how many modules import a specifier twice), not a module count. A
		// collect-all regex that ignored the `/` would drift on that historical bullet.
		const claims = parseClaims(
			["## STATE", "Verified: 4c1d9ab", "- **dev** @ `4c1d9ab`.", "**58 modules**, **27 ADRs**", "18/48 modules import `./types` twice."].join("\n"),
		);
		expect(claims.modules).toEqual([58]);
		expect(claims.adrs).toEqual([27]);
	});

	it("stops the STATE section at the next level-2 heading", () => {
		const section = stateSection(text("correct"));
		expect(section).toContain("**dev**");
		expect(section).not.toContain("## Open items");
		expect(stateSection("# Handoff\n\ntext only\n")).toBeNull();
	});

	/**
	 * The structural scan (#579). The recurrence: a slice-replace re-appended a whole `## STATE … ## Open
	 * items` block and the checker read the first `## STATE` only — 0 drift, 22-claim green. These rows pin
	 * the ONE scanner that now answers both questions (which headings exist, where the STATE body ends), so
	 * the section read and the headings counted cannot disagree.
	 */
	it("a duplicated STATE block is a state-drift", () => {
		// Exactly two results, in document order, one per distinct heading — not one generic bullet and not
		// one per occurrence. The claims stay the FIRST block's: the duplicate is a structure fault.
		const correct = text("correct");
		const stateBlock = correct.slice(correct.indexOf("## STATE"), correct.indexOf("## Open items"));
		const openBlock = correct.slice(correct.indexOf("## Open items"), correct.indexOf("## Pointers"));
		const doubled = `${stateBlock}${openBlock}\n${stateBlock}${openBlock}`;
		const claims = parseClaims(doubled);
		expect(claims.structure.duplicates.map((duplicate: { text: string }) => duplicate.text)).toEqual(["STATE", "Open items"]);
		const { results, drifts } = evaluateStatePage(claims, stub());
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.stateDrift, CODES.stateDrift]);
		expect(drifts.map((drift) => drift.claim)).toEqual(["STATE 2", "Open items 2"]);
		expect(results.filter((result: { ok: boolean }) => !result.ok)).toHaveLength(2);
		// The CLI is where the old head printed `0 drift(s)` for this document: exit 1, and the first `✗`
		// line names the claim. The doubled document is the PAGE, so the run needs an index beside it —
		// the shape a real checkout has, and the seam a `--file <page>` would not exercise.
		const file = pair(doubled);
		const result = run(["--file", file]);
		expect(result.code).toBe(EXIT.DRIFT);
		expect(result.out.split("\n").filter((line) => line.startsWith("✗"))[0]).toContain("✗ state-drift: STATE 2");
	});

	it("a duplicated other heading names its lines", () => {
		// `## Pointers` is not a mandatory heading, but any H2 stated twice is the same fault; the detail
		// names both lines so the reader does not have to grep for the second copy.
		const document = text("correct").replace("## Pointers", "## Notes\n\none\n\n## Notes\n\ntwo\n\n## Pointers");
		const notesLines = document
			.split("\n")
			.flatMap((line, index) => (line === "## Notes" ? [index + 1] : []));
		expect(notesLines).toHaveLength(2);
		const { results, drifts } = evaluateStatePage(parseClaims(document), stub());
		expect(drifts.map((drift) => drift.claim)).toEqual(["Notes 2"]);
		expect(drifts[0].actual).toBe(`2 at lines ${notesLines.join(", ")}`);
		const failure = results.find((result: { ok: boolean }) => !result.ok);
		expect(failure.line).toContain(`at lines ${notesLines.join(", ")}`);
	});

	it("a fenced heading is not a heading", () => {
		// r1's finding: the old `stateSection` ignored fences, so a fenced `## STATE` could BE the section
		// read while a fence-aware duplicate scan certified "one STATE". The scan now reports the boundary
		// it counted, and the claim is the real block's — both assertions are load-bearing.
		const document = ["```", "## STATE", "Verified: deadbee", "```", "## STATE", "Verified: 4c1d9ab", "", "## Open items", "- nothing"].join("\n");
		expect(scanHeadings(document)).toEqual({
			headings: [
				{ text: "STATE", line: 5 },
				{ text: "Open items", line: 8 },
			],
			duplicates: [],
		});
		expect(parseClaims(document).verified).toEqual({ sha: "4c1d9ab" });
	});

	it("a fenced line inside STATE is not a claim", () => {
		// r2's regression: a fence-aware boundary WITHOUT masking reads the fenced `Verified: deadbee` —
		// the old truncation that hid the fence was wrong but safe. Masking keeps the intent.
		const document = ["## STATE", "```", "## Notes", "Verified: deadbee", "```", "Verified: 4c1d9ab", "`alpha.ts` 4", "", "## Open items", "- nothing"].join("\n");
		const claims = parseClaims(document);
		expect(claims.verified).toEqual({ sha: "4c1d9ab" });
		// A claim AFTER the fence still parses: masking blanks the fenced lines, it does not truncate.
		expect(claims.sizes).toEqual([{ name: "alpha.ts", lines: 4 }]);
		// The fenced `## Notes` is not a heading, so it neither ends the section nor duplicates.
		expect(claims.structure.headings.map((heading: { text: string }) => heading.text)).toEqual(["STATE", "Open items"]);
		expect(claims.structure.duplicates).toEqual([]);
		expect(maskFences("a\n```\nb\n```\nc")).toBe("a\n\n\n\nc");
	});

	it("tabs and tildes are headings and fences too", () => {
		// `##\tSTATE` was accepted by `stateSection` but not by `/^## /` (r1 Major 6): one grammar, tabs
		// included, so a tab heading is neither missed nor a duplicate that never was.
		const tabs = ["## STATE", "Verified: 4c1d9ab", "##\tNotes", "one", "##\tNotes", "two", "## Open items", "- nothing"].join("\n");
		expect(scanHeadings(tabs).duplicates).toEqual([{ text: "Notes", lines: [3, 5] }]);

		// A tilde fence is a fence: the `## STATE` inside it is not a heading.
		const tildes = ["~~~", "## STATE", "~~~", "## STATE", "Verified: 4c1d9ab", "## Open items", "- nothing"].join("\n");
		expect(scanHeadings(tildes).headings.map((heading: { text: string }) => heading.text)).toEqual(["STATE", "Open items"]);

		// A four-backtick opener is NOT closed by a three-backtick line, so the heading between them is content.
		const nested = ["````", "```", "## Hidden", "````", "## STATE", "Verified: 4c1d9ab", "## Open items", "- nothing"].join("\n");
		expect(scanHeadings(nested).headings.map((heading: { text: string }) => heading.text)).toEqual(["STATE", "Open items"]);

		// An INFO string never closes (r3's major): ```js is closed by a bare ```, not by another ```js — so
		// a code example cannot swallow the real headings, and masking cannot blank the real claim.
		const info = ["```js", "## Hidden", "```js", "## Still hidden", "```", "## STATE", "Verified: 4c1d9ab", "## Open items", "- nothing"].join("\n");
		expect(scanHeadings(info).headings.map((heading: { text: string }) => heading.text)).toEqual(["STATE", "Open items"]);
		expect(parseClaims(info).verified).toEqual({ sha: "4c1d9ab" });
	});

	it("parses the install line's three shapes", () => {
		expect(claimsOf("correct").install?.path).toEqual({ kind: "repo" });
		expect(claimsOf("install-missing").install?.path).toEqual({ kind: "path", value: MISSING_PATH });
		const npm = parseClaims(
			[
				"## STATE",
				"Verified: 4c1d9ab",
				"- **dev** @ `4c1d9ab`.",
				"Running install: **npm** (`pi install npm:brl-subagent`), then `/reload`.",
			].join("\n"),
		);
		expect(npm.install?.path).toBeNull();
		expect(npm.install?.package).toBe("brl-subagent");
		// `~` is expanded so the existence check is handed a real path; `/reload` is a command, not a path.
		const home = parseClaims(
			["## STATE", "Verified: 4c1d9ab", "- **dev** @ `4c1d9ab`.", "Running install: the `~/brl-subagent` checkout."].join("\n"),
		);
		expect(home.install?.path).toEqual({ kind: "path", value: `${process.env.HOME}/brl-subagent` });
	});

	it("matches a short sha against a full one either way", () => {
		expect(sameRevision("4c1d9ab", DEV)).toBe(true);
		expect(sameRevision(DEV, "4c1d9ab")).toBe(true);
		expect(sameRevision("4c1d9ab", "deadbee1")).toBe(false);
		expect(sameRevision("", DEV)).toBe(false);
	});
});

describe("handoff-verify — the verdict, check by check", () => {
	function verdicts(name: string, probe = stub(), options = {}) {
		return evaluateStatePage(claimsOf(name), probe, options);
	}

	it("holds on the correct fixture", () => {
		const { results, drifts } = verdicts("correct");
		expect(drifts).toEqual([]);
		expect(results.every((result: { ok: boolean }) => result.ok)).toBe(true);
		// structure emits NOTHING on a clean document, then dev, install, open, suite, modules, adrs, then
		// the THREE size claims (#583 added the `.mjs` row). Nine, not ten: `Verified:` moved to the index
		// with #607, and the page pass runs checks 2–7 only.
		expect(results).toHaveLength(9);
	});

	it("the live page is structurally clean and its claims hold", () => {
		// The recurrence's whole point: the real page states one `## STATE`. The probe answers with the
		// document's OWN claims, so this row can fail only on the structure the page states — a stale copy
		// appended to it would be a red suite, which is the alarm (#579).
		const live = parseClaims(readFileSync(LIVE_PAGE, "utf8"));
		expect(live.structure.duplicates).toEqual([]);
		expect(live.structure.headings.map((heading: { text: string }) => heading.text)).toEqual(["STATE", "Open items"]);
		const probe = stub({
			// The document's own claims, not a stub's shas: this row measures STRUCTURE, and the fact-equal
			// probe is what makes every other check answer instead of failing for an unrelated reason.
			isAncestor: () => true,
			devSha: () => live.dev.at(-1),
			devClaimSha: () => live.dev.at(-1),
			lineCount: (name: string) => {
				const size = live.sizes.find((entry: { name: string }) => entry.name === name);
				return size === undefined ? null : { path: name, lines: size.lines };
			},
			modules: () => live.modules.at(-1),
			adrs: () => live.adrs.at(-1),
			openIssues: () => live.open,
			report: () =>
				snapshot({
					files: live.suite?.files,
					tests: live.suite?.tests,
					passed: live.suite?.passed ?? live.suite?.tests,
					skipped: live.suite?.skipped ?? 0,
				}),
		});
		const { results, drifts } = evaluateStatePage(live, probe, { noNetwork: true, expectHead: "4c1d9ab" });
		expect(drifts).toEqual([]);
		expect(results.filter((result: { line: string }) => result.line.includes(CODES.stateDrift))).toEqual([]);
		// Six single-value checks plus one result per size claim: the count follows the document, not a
		// literal, so a legitimate size row added to the page does not redden this pin.
		expect(results).toHaveLength(6 + live.sizes.length);
	});

	it("names the two handoff paths, the pages, and nothing else", () => {
		expect(isHandoffOwnPath(".development/HANDOFF.md")).toBe(true);
		expect(isHandoffOwnPath(".development/HANDOFF-ARCHIVE-2026-11-08.md")).toBe(true);
		// #607: the pages are the handoff's own too — `Verified:` cannot name the commit that writes them.
		expect(isHandoffOwnPath(".development/handoff/state.md")).toBe(true);
		expect(isHandoffOwnPath(".development/handoff/invariants.md")).toBe(true);
		expect(isHandoffOwnPath(".development/handoff/state.md ")).toBe(false);
		expect(isHandoffOwnPath(".development/handoff/nested/state.md")).toBe(false);
		expect(isHandoffOwnPath(".development/handoff/state.txt")).toBe(false);
		expect(isHandoffOwnPath(".development/HANDOFF.md ")).toBe(false);
		expect(isHandoffOwnPath("src/index.ts")).toBe(false);
	});

	it("names dev-sha-drift for a dev line from another day", () => {
		const { drifts } = verdicts("dev-sha-drift");
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.devShaDrift]);
		expect(drifts[0].expected).toBe(DEV);
		expect(drifts[0].actual).toBe("deadbee1");
	});

	it("passes a duplicate dev line that agrees and names the one that disagrees", () => {
		// The crafted STATE the review used: `4c1d9ab` then `deadbee1`. First-wins parsed the good line and
		// reported only an unrelated drift, which is why the second value has to be checked.
		const dupe = (name: string, from: string, to: string) => parseClaims(text(name).replace(from, to));
		const agreeing = evaluateStatePage(dupe("correct", "- **dev** @ `4c1d9ab`.", "- **dev** @ `4c1d9ab`.\n- **dev** @ `4c1d9ab`."), stub());
		expect(agreeing.drifts).toEqual([]);
		const disagreeing = evaluateStatePage(dupe("correct", "- **dev** @ `4c1d9ab`.", "- **dev** @ `4c1d9ab`.\n- **dev** @ `deadbee1`."), stub());
		expect(disagreeing.drifts.map((drift) => drift.code)).toEqual([CODES.devShaDrift]);
		expect(disagreeing.drifts[0].expected).toBe(DEV);
		expect(disagreeing.drifts[0].actual).toBe("deadbee1");
		expect(disagreeing.results.find((result: { ok: boolean }) => !result.ok).line).toContain("states 4c1d9ab and deadbee1");
	});

	it("treats a repeated modules/ADRs count the same way: agreeing is no drift, disagreeing is named", () => {
		const withExtra = (extra: string) => parseClaims(text("correct").replace("**58 modules**, **27 ADRs**", `**58 modules**, **27 ADRs**, ${extra}`));
		expect(evaluateStatePage(withExtra("**58 modules**"), stub()).drifts).toEqual([]);
		expect(evaluateStatePage(withExtra("**27 ADRs**"), stub()).drifts).toEqual([]);
		const modules = evaluateStatePage(withExtra("**59 modules**"), stub()).drifts;
		expect(modules.map((drift) => drift.code)).toEqual([CODES.modulesDrift]);
		expect(modules[0].actual).toBe("59");
		const adrs = evaluateStatePage(withExtra("**28 ADRs**"), stub()).drifts;
		expect(adrs.map((drift) => drift.code)).toEqual([CODES.adrsDrift]);
		expect(adrs[0].actual).toBe("28");
	});

	it("names install-missing for a recipe pointing at a tree that is gone", () => {
		const { drifts } = verdicts("install-missing");
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.installMissing]);
		expect(drifts[0].claim).toBe(`Running install: ${MISSING_PATH}`);
	});

	it("names install-sha-drift when the install line names another tip", () => {
		const probe = stub({ devSha: () => "deadbee1c0ffee" });
		const codes = verdicts("correct", probe).drifts.map((drift) => drift.code);
		expect(codes).toContain(CODES.installShaDrift);
		expect(codes).toContain(CODES.devShaDrift);
	});

	it("names open-set-drift for a closed issue still in Open:", () => {
		const { drifts } = verdicts("open-set-drift");
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.openSetDrift]);
		expect(drifts[0].expected).toBe("#426, #450");
		expect(drifts[0].actual).toBe("#426, #430, #450");
	});

	it("names open-set-drift for an open issue the STATE never claims", () => {
		const probe = stub({ openIssues: () => [426, 450, 495] });
		const { drifts } = verdicts("correct", probe);
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.openSetDrift]);
		expect(drifts[0].actual).toBe("#426, #450");
	});

	it("names suite-count-drift against the report it read", () => {
		const { drifts } = verdicts("suite-count-drift");
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.suiteCountDrift]);
		expect(drifts[0].actual).toBe("2 files / 40 tests");
	});

	it("names file-size-drift for a count one line off", () => {
		const { drifts } = verdicts("file-size-drift");
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.fileSizeDrift]);
		expect(drifts[0].claim).toBe("alpha.ts 11");
		expect(drifts[0].expected).toBe("10 lines");
	});

	it("names file-missing when the claimed file is not in the tree", () => {
		const probe = stub({ lineCount: () => null });
		const { drifts } = verdicts("correct", probe);
		// Three size claims in `correct.md` (#583 added the `.mjs` row), so three named misses.
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.fileMissing, CODES.fileMissing, CODES.fileMissing]);
	});

	it("names modules-drift and adrs-drift against the repo's own counters", () => {
		const probe = stub({ modules: () => 59, adrs: () => 28 });
		expect(verdicts("correct", probe).drifts.map((drift) => drift.code)).toEqual([CODES.modulesDrift, CODES.adrsDrift]);
	});

	it("names a missing claim instead of passing silently", () => {
		const cases: [string, string][] = [
			["**dev** @ `4c1d9ab`", CODES.devClaimMissing],
			["Running install:", CODES.installClaimMissing],
			["Open: **#426**, **#450**", CODES.openClaimMissing],
			["Suite:", CODES.suiteClaimMissing],
			["**58 modules**, ", CODES.modulesMissing],
			["**27 ADRs**", CODES.adrsMissing],
		];
		for (const [needle, code] of cases) {
			const { drifts } = evaluateStatePage(parseClaims(without(needle)), stub());
			expect(drifts.map((drift) => drift.code)).toEqual([code]);
		}
	});

	it("skips the open set under --no-network without touching the board", () => {
		const probe = stub({
			openIssues: () => {
				throw new Error("the board must not be read under --no-network");
			},
		});
		const { results, drifts } = evaluateStatePage(claimsOf("correct"), probe, { noNetwork: true });
		expect(drifts).toEqual([]);
		const skipped = results.filter((result: { skipped: boolean }) => result.skipped);
		expect(skipped).toHaveLength(1);
		expect(skipped[0].line).toContain("skipped (--no-network");
	});

	it("runs the open-set check when --issues injects the board, whatever --no-network says", () => {
		const probe = stub({ openIssues: () => [426, 450] });
		const { results } = evaluateStatePage(claimsOf("correct"), probe, { noNetwork: true, issuesInjected: true });
		expect(results.filter((result: { skipped: boolean }) => result.skipped)).toHaveLength(0);
	});
});

/**
 * #583 — a RED report cannot certify a green snapshot, and the red predicate has three terms because
 * vitest has three shapes of red. Each fixture makes exactly ONE term true, so deleting that term in
 * `scripts/lib/handoff-claims.mjs` kills its own case and only its own (spec v4 §B):
 *
 *   red-assertions  failed: 1, failedSuites: 0, success: true    → `failed > 0` alone
 *   red-suitesonly  failed: 0, failedSuites: 1, success: TRUE    → `failedSuites > 0` alone
 *                   (synthetic: vitest cannot produce it, and the predicate must not depend on
 *                    vitest's `success` agreeing with its own suite count)
 *   red-load        failed: 0, failedSuites: 0, success: false   → `success === false` alone
 *                   (what a load error looks like: a failed FILE and no failed assertion)
 */
describe("handoff-verify — a red report certifies nothing (#583)", () => {
	const dir = mkdtempSync(join(tmpdir(), "brl-red-report-"));

	/** A synthetic report on disk, read back through the one validator, so the snapshot is a real one. */
	function snapshotOf(name: string, body: unknown) {
		const path = join(dir, name);
		writeFileSync(path, JSON.stringify(body));
		return readSuiteReport(path);
	}

	const green = {
		numTotalTests: 12,
		numPassedTests: 12,
		numFailedTests: 0,
		success: true,
		testResults: [
			{ name: "/repo/a.test.ts", status: "passed", assertionResults: Array.from({ length: 6 }, () => ({ status: "passed" })) },
			{ name: "/repo/b.test.ts", status: "passed", assertionResults: Array.from({ length: 6 }, () => ({ status: "passed" })) },
		],
	};

	it("clears a green report — the control that makes the three red cases meaningful", () => {
		const report = snapshotOf("green.json", green);
		expect(evaluateStatePage(claimsOf("correct"), stub({ report: () => report })).drifts).toEqual([]);
	});

	it("red-assertions: one failed assertion is suite-red, whatever the totals say", () => {
		const report = snapshotOf("red-assertions.json", {
			numTotalTests: 2,
			numPassedTests: 1,
			numFailedTests: 1,
			numFailedTestSuites: 0,
			success: true,
			testResults: [{ name: join(ROOT, "scripts", "__tests__", "red-assertions.test.ts"), status: "failed", assertionResults: [{ status: "passed" }, { status: "failed" }] }],
		});
		const { drifts, results } = evaluateStatePage(claimsOf("correct"), stub({ report: () => report }));
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.suiteRed]);
		expect(CODES.suiteRed).toBe("suite-red");
		expect(drifts[0].actual).toBe("1 failed test(s) in 0 file(s)");
		const line = results.find((result: { ok: boolean }) => !result.ok).line;
		expect(line).toContain("1 failed test(s)");
		expect(line).toContain("scripts/__tests__/red-assertions.test.ts");
		expect(line).toContain("capture a green run");
	});

	it("red-suitesonly: a failed FILE with success:true is suite-red — the failedSuites term alone", () => {
		const report = snapshotOf("red-suitesonly.json", {
			numTotalTests: 2,
			numPassedTests: 2,
			numFailedTests: 0,
			numFailedTestSuites: 1,
			// Synthetic on purpose: vitest writes success:false here, and the predicate must not depend
			// on vitest agreeing with itself — `failed` is 0 and `success` is true, so ONLY the suite
			// count can make this red.
			success: true,
			testResults: [{ name: "/repo/b.test.ts", status: "passed", assertionResults: [{ status: "passed" }, { status: "passed" }] }],
		});
		expect(report).toMatchObject({ failed: 0, failedSuites: 1, success: true });
		const { drifts } = evaluateStatePage(claimsOf("correct"), stub({ report: () => report }));
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.suiteRed]);
		expect(drifts[0].actual).toBe("0 failed test(s) in 1 file(s)");
	});

	it("red-load: a load error is suite-red with zero failed assertions — the success term alone", () => {
		const report = snapshotOf("red-load.json", {
			numTotalTests: 1,
			numPassedTests: 1,
			numFailedTests: 0,
			numFailedTestSuites: 0,
			success: false,
			testResults: [{ name: "/repo/broken.test.ts", status: "failed", assertionResults: [{ status: "passed" }] }],
		});
		expect(report).toMatchObject({ failed: 0, failedSuites: 0, success: false });
		const { drifts, results } = evaluateStatePage(claimsOf("correct"), stub({ report: () => report }));
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.suiteRed]);
		expect(results.find((result: { ok: boolean }) => !result.ok).line).toContain(`the vitest report at ${report.path}`);
	});

	it("names the count and the first failing file in the CLI's own output", () => {
		const report = snapshotOf("red-cli.json", {
			numTotalTests: 2,
			numPassedTests: 1,
			numFailedTests: 1,
			success: false,
			testResults: [{ name: join(ROOT, "scripts", "__tests__", "cli-red.test.ts"), status: "failed", assertionResults: [{ status: "passed" }, { status: "failed" }] }],
		});
		const result = run(["--file", correctIndex(), "--no-network"], stub({ report: () => report }));
		expect(result.code).toBe(EXIT.DRIFT);
		expect(result.out).toContain("✗ suite-red: ");
		expect(result.out).toContain("is RED — 1 failed test(s) in 0 file(s)");
		expect(result.out).toContain("first: scripts/__tests__/cli-red.test.ts");
		expect(result.out).toContain("capture a green run");
	});
});

/**
 * #583 — the breakdown suffix `(N passed, M failed, K skipped)` is a claim, compared field by field.
 * Each number moves on its own, so a comparison that reads only the total cannot pass them.
 */
describe("handoff-verify — the stated breakdown is compared (#583)", () => {
	const mutated = (suffix: string) => parseClaims(text("correct").replace("(12 passed, 0 failed, 0 skipped)", suffix));

	it("drifts when passed disagrees", () => {
		const { drifts } = evaluateStatePage(mutated("(99 passed, 0 failed, 0 skipped)"), stub());
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.suiteCountDrift]);
		expect(drifts[0].claim).toBe("Suite: 2 files / 12 tests");
		// The breakdown the report actually derived is in the drift's `expected`, so a reader sees both sides.
		expect(drifts[0].expected).toBe("2 files / 12 tests (12 passed, 0 failed, 0 skipped)");
	});

	it("names the field that disagrees, for each of the three numbers", () => {
		const cases: [string, string][] = [
			["(99 passed, 0 failed, 0 skipped)", "passed 99"],
			["(12 passed, 1 failed, 0 skipped)", "failed 1"],
			["(12 passed, 0 failed, 1 skipped)", "skipped 1"],
		];
		for (const [suffix, field] of cases) {
			const { results } = evaluateStatePage(mutated(suffix), stub());
			const failure = results.find((result: { ok: boolean }) => !result.ok);
			expect(failure.line, suffix).toContain(CODES.suiteCountDrift);
			expect(failure.line, suffix).toContain(field);
		}
	});

	it("reads a line with no suffix as totals only — archived handoffs keep verifying", () => {
		const totalsOnly = parseClaims(text("correct").replace("(12 passed, 0 failed, 0 skipped)", ""));
		expect(totalsOnly.suite).toEqual({ files: 2, tests: 12 });
		expect(evaluateStatePage(totalsOnly, stub()).drifts).toEqual([]);
	});

	it("does not read the retired prose form as a breakdown claim", () => {
		const prose = parseClaims(text("correct").replace("(12 passed, 0 failed, 0 skipped)", "(12 passed + 0 skipped, **0 failed** — the counts read from the report)"));
		expect(prose.suite).toEqual({ files: 2, tests: 12 });
	});
});

/**
 * #583 — the size claim sees the files it names. `SIZE_RE` now accepts `.mjs` (and `.sh`, `.py`), and a
 * bare name resolves under `scripts/` after `src/`. Both halves are load-bearing: the regex without the
 * resolver parses a claim it cannot check, and the resolver without the regex checks nothing.
 */
describe("handoff-verify — the size claim sees scripts (#583)", () => {
	it("drifts on a `.mjs` row one line off, naming the file", () => {
		const claims = parseClaims(text("correct").replace("`gamma.mjs` is **7**", "`gamma.mjs` is **8**"));
		expect(claims.sizes).toContainEqual({ name: "gamma.mjs", lines: 8 });
		const { drifts } = evaluateStatePage(claims, stub());
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.fileSizeDrift]);
		expect(drifts[0].claim).toBe("gamma.mjs 8");
		expect(drifts[0].expected).toBe("7 lines");
	});

	it("resolves a bare name under scripts/, and src/ still wins when both exist", () => {
		expect(resolveModulePath(ROOT, "friction-disposition.mjs")).toBe(join(ROOT, "scripts", "friction-disposition.mjs"));
		const dir = mkdtempSync(join(tmpdir(), "brl-resolve-"));
		mkdirSync(join(dir, "src"));
		mkdirSync(join(dir, "scripts"));
		writeFileSync(join(dir, "scripts", "only.mjs"), "x\n");
		expect(resolveModulePath(dir, "only.mjs")).toBe(join(dir, "scripts", "only.mjs"));
		writeFileSync(join(dir, "src", "both.ts"), "x\n");
		writeFileSync(join(dir, "scripts", "both.ts"), "x\n");
		expect(resolveModulePath(dir, "both.ts")).toBe(join(dir, "src", "both.ts"));
		expect(resolveModulePath(dir, "absent.py")).toBeNull();
	});

	it("parses `.sh` and `.py` rows too — the alternation is not `.mjs`-only", () => {
		const claims = parseClaims(
			["## STATE", "Verified: 4c1d9ab", "- **dev** @ `4c1d9ab`.", "`run.sh` 120; `tool.py` is **2,006**; `a.ts` 3"].join("\n"),
		);
		expect(claims.sizes).toEqual([
			{ name: "run.sh", lines: 120 },
			{ name: "tool.py", lines: 2006 },
			{ name: "a.ts", lines: 3 },
		]);
	});
});

/**
 * #583 / spec v4 §A — the handoff's `Suite:` line carries FOUR claim families on one line (totals +
 * breakdown, the module count, the ADR count and 14 file sizes). A migration test that only looked at
 * the suite fields would pass while the line lost the other three, so all four are asserted here.
 */
describe("handoff-verify — the migrated page line loses no claim (#583)", () => {
	const live = parseClaims(readFileSync(LIVE_PAGE, "utf8"));

	it("reads the suite line's totals AND its breakdown", () => {
		// The INVARIANT, not the literals: this test reads the live handoff, so pinning its numbers
		// would redden the suite on every legitimate suite change — the same brittleness as the
		// real-tree LOC pin (#585's audit finding F07). What must hold: all six fields parsed, and
		// the breakdown accounting for the total exactly.
		for (const field of ["files", "tests", "passed", "failed", "skipped"] as const) {
			expect(typeof live.suite?.[field], `suite.${field} parsed from the live line`).toBe("number");
		}
		expect(live.suite!.files).toBeGreaterThan(0);
		expect(live.suite!.tests).toBeGreaterThan(0);
		expect(live.suite!.passed! + live.suite!.failed! + live.suite!.skipped!).toBe(live.suite!.tests);
		expect(live.suite!.failed).toBe(0);
	});

	it("keeps the module, ADR and size claims on the same line", () => {
		expect(live.modules.length).toBeGreaterThan(0);
		expect(live.adrs.length).toBeGreaterThan(0);
		expect(live.modules.every((n) => Number.isInteger(n) && n > 0)).toBe(true);
		// 15, not the 14 the audit measured at 3ae8c55: the `.mjs` claim was invisible to the old SIZE_RE,
		// and making it visible is the point of the unit (spec v2 §1.3).
		// Same rule: the CLAIM FAMILIES, not their current values. The `.mjs` entry is the one the
		// unit made visible, so it is the falsifier for SIZE_RE's extension set.
		expect(live.sizes.length).toBeGreaterThanOrEqual(10);
		expect(live.sizes.some((entry) => entry.name.endsWith(".mjs"))).toBe(true);
		expect(live.sizes.some((entry) => entry.name.endsWith(".ts"))).toBe(true);
		expect(live.sizes.every((entry) => entry.lines > 0)).toBe(true);
	});
});

/**
 * The INDEX pass (#607). `.development/HANDOFF.md` is a front page: four §STATE lines, a fixed H2 set, a
 * bound on every section, a byte budget, page/link set relations, live citations, no counts in prose, and
 * one open next action. Each row below seeds ONE violation and names the code it must turn red — the
 * spec's falsifier table, one test per row. A green suite with zero executed #607 rows, or a seeded
 * violation that stays green, fails the spec's own acceptance (6).
 */
describe("handoff-verify — the index (#607)", () => {
	it("reads the front page's shape, sections and citations", () => {
		const index = indexOf("correct");
		expect(index.structure.headings.map((heading: { text: string }) => heading.text)).toEqual([...INDEX_HEADINGS]);
		expect(index.h3).toEqual([]);
		// §STATE is exactly the four fields, in order, with `Verified:` carrying the sha.
		expect(index.stateLines.map((entry: { line: string }) => entry.line.split(":")[0])).toEqual([
			"Verified",
			"In flight",
			"Next action",
			"Index",
		]);
		expect(index.verified).toEqual({ sha: "4c1d9ab" });
		expect(index.preamble).toHaveLength(2);
		expect(index.invariants).toHaveLength(2);
		expect(index.pointers).toHaveLength(3); // header + separator + one page row
		expect(index.resume).toHaveLength(2);
		// A page link is a set relation (check 3); the other kinds are liveness citations (check 4).
		expect(index.pointerLinks.map((link: { page: string | null }) => link.page)).toEqual(["state.md"]);
		expect(index.citations).toEqual([{ number: 426, state: "open", line: 9 }]);
		expect(index.shas).toEqual([{ sha: "4c1d9ab", line: 14 }]);
		expect(index.counts).toEqual([]);
	});

	it("the live index is inside every bound and holds no count", () => {
		// The anti-rot row, and the receipt the spec measures: §STATE ≤ 2,000 bytes, the whole index ≤ 8 KB
		// and ≤ 80 lines, no H3, no count in prose. It reads the SHIPPED file, so a future handover that
		// grows a section or pastes a suite total reddens the suite instead of the next session.
		const live = parseIndex(readFileSync(LIVE_INDEX, "utf8"));
		expect(live.structure.headings.map((heading: { text: string }) => heading.text)).toEqual([...INDEX_HEADINGS]);
		expect(live.h3).toEqual([]);
		expect(live.stateLines).toHaveLength(4);
		expect(live.lineCount).toBeLessThanOrEqual(80);
		expect(live.bytes).toBeLessThanOrEqual(8192);
		expect(live.counts).toEqual([]);
		// The §STATE receipt (spec acceptance 1): what a session is injected with, measured.
		expect(Buffer.byteLength(live.stateLines.map((entry: { line: string }) => entry.line).join("\n"), "utf8")).toBeLessThanOrEqual(2000);
		// Every line is inside the per-line bound, and every pointer target exists in this checkout.
		for (const line of live.lines) expect(line.length).toBeLessThanOrEqual(160);
		const probe = stub({
			pages: () => ["state.md", "invariants.md"],
			issueState: () => "open",
			// The live `Verified:` is this checkout's dev tip, not the stub's HEAD: reachability and dev
			// ancestry both answer TRUE, because this row measures the DOCUMENT's bounds, not git.
			isAncestor: () => true,
			isAncestorOfDev: () => true,
		});
		const { drifts } = evaluateIndex(live, probe, { noNetwork: true });
		expect(drifts).toEqual([]);
	});

	it("the live page is the index's page — one command, two passes, no drift", () => {
		// The end-to-end shape a session runs: the index's `Verified:` is the head the suite report must
		// match, and the page's claims are checked against the same repo facts. The stub answers with the
		// documents' OWN values, so a document that contradicts itself fails here and nothing else.
		const live = parseClaims(readFileSync(LIVE_PAGE, "utf8"));
		const index = parseIndex(readFileSync(LIVE_INDEX, "utf8"));
		const probe = stub({
			devSha: () => live.dev.at(-1),
			devClaimSha: () => live.dev.at(-1),
			lineCount: (name: string) => {
				const size = live.sizes.find((entry: { name: string }) => entry.name === name);
				return size === undefined ? null : { path: name, lines: size.lines };
			},
			modules: () => live.modules.at(-1),
			adrs: () => live.adrs.at(-1),
			openIssues: () => live.open,
			report: () =>
				snapshot({
					files: live.suite?.files,
					tests: live.suite?.tests,
					passed: live.suite?.passed ?? live.suite?.tests,
					skipped: live.suite?.skipped ?? 0,
				}),
		});
		const heads: string[] = [];
		const measured = { ...probe, report: (expectHead: string) => (heads.push(expectHead), probe.report()) };
		expect(evaluateStatePage(live, measured, { noNetwork: true, expectHead: index.verified?.sha }).drifts).toEqual([]);
		// The index's Verified sha REACHED the suite check: the page carries none of its own (#607 D3).
		expect(heads).toEqual([index.verified?.sha]);
	});

	it("names over-budget on the line arm, and on the byte arm alone", () => {
		// The literal 80, not `INDEX_LIMITS.lines`: a threshold derived from the constant under test cannot
		// kill a mutation of that constant (the number moves with it). The contract's numbers are pinned
		// HERE, and the seed is an index of 81+ lines whatever the constant says.
		expect(INDEX_LIMITS).toEqual({ lines: 80, bytes: 8192, lineChars: 160, preamble: 2, invariants: 8, pointers: 12, resume: 3 });
		const padded = parseIndex(`${indexText("correct")}${"\n".repeat(81)}`);
		expect(padded.lineCount).toBeGreaterThan(80);
		const lines = evaluateIndex(padded, stub()).drifts;
		expect(lines.map((drift) => drift.code)).toEqual([CODES.overBudget]);
		expect(lines[0].claim).toContain("lines");
		// The byte arm on its own: the line arm and the byte arm are separate conditions, so each one is
		// shown to be load-bearing. Constructed because a real >8 KB file that is still ≤80 lines needs
		// 100+ characters per line, which the per-line bound forbids — the two rules interlock by design.
		const heavy = { ...parseIndex(indexText("correct")), bytes: INDEX_LIMITS.bytes + 1 };
		const bytes = evaluateIndex(heavy, stub()).drifts;
		expect(bytes.map((drift) => drift.code)).toEqual([CODES.overBudget]);
		expect(bytes[0].claim).toContain("bytes");
	});

	it("names unindexed-page for a page no pointer row links", () => {
		const probe = stub({ pages: () => ["state.md", "invariants.md"] });
		const { drifts, results } = evaluateIndex(indexOf("correct"), probe);
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.unindexedPage]);
		expect(drifts[0].claim).toBe("handoff/invariants.md");
		expect(results.find((result: { ok: boolean }) => !result.ok).line).toContain("nobody opens");
	});

	it("names state-shape for a line over the bound, naming the line", () => {
		const long = indexText("correct").replace(
			"- a page holds the mechanical claims, so the index holds none",
			`- a page holds the mechanical claims, so the index holds none ${"x".repeat(160)}`,
		);
		const { drifts } = evaluateIndex(parseIndex(long), stub());
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.stateShape]);
		expect(drifts[0].claim).toBe("line 13");
		expect(drifts[0].expected).toBe("at most 160 characters");
	});

	it("names state-shape when §STATE grows history — the 20-line case", () => {
		// The spec's seeded violation (a): twenty lines of history inside §STATE. The rule that catches it is
		// the FIELD COUNT, not a keyword list — a §STATE that is a paragraph is drift whatever it says.
		const history = Array.from({ length: 20 }, (_unused, at) => `- history line ${at}`).join("\n");
		const bloated = indexText("correct").replace("In flight: nothing", `In flight: nothing\n${history}`);
		const { drifts } = evaluateIndex(parseIndex(bloated), stub());
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.stateShape]);
		expect(drifts[0].claim).toBe("STATE 24");
	});

	it("names section-over-bound for §Pointers, the arm the fixture does not seed", () => {
		// Thirteen explicit rows against a bound of twelve — literals, for the reason the budget row gives.
		const rows = Array.from({ length: 13 }, (_unused, at) => `| [p${at}](handoff/state.md) | row ${at} |`).join("\n");
		const bloated = indexText("correct").replace("|---|---|\n", `|---|---|\n${rows}\n`);
		const { drifts } = evaluateIndex(parseIndex(bloated), stub());
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.sectionOverBound]);
		// Header + separator + 13 rows = 16 `|` lines, four over the bound of 12.
		expect(drifts[0].claim).toBe("## Pointers 16");
	});

	it("names verified-missing when the index has no usable Verified: line", () => {
		// The page cannot answer this any more (#607 D3): a `Verified:` that is not a sha is both a shape
		// fault and a missing claim — two results, because a reader needs both facts.
		const { drifts } = evaluateIndex(parseIndex(indexText("correct").replace("Verified: 4c1d9ab", "Verified: pending")), stub());
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.stateShape, CODES.verifiedMissing]);
	});

	it("names issue-state-drift in both directions, and lets a closed next action be caught either way", () => {
		// (open) label, closed issue: the citation is stale.
		const closed = evaluateIndex(indexOf("correct"), stub({ issueState: () => "closed" })).drifts;
		expect(closed.map((drift) => drift.code)).toEqual([CODES.issueStateDrift]);
		expect(closed[0].claim).toBe("#426 (open)");
		expect(closed[0].expected).toBe("closed");

		// (closed) label, open issue: the next action is not open AND the label is wrong — the spec's "caught
		// either way", measured rather than argued.
		const wrongState = indexText("correct").replace("Next action: #426 (open)", "Next action: #426 (closed)");
		const drifts = evaluateIndex(parseIndex(wrongState), stub()).drifts;
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.issueStateDrift, CODES.nextActionStateMissing]);
	});

	it("skips the citation check under --no-network, and says so", () => {
		const { results, drifts } = evaluateIndex(indexOf("correct"), stub(), { noNetwork: true });
		expect(drifts).toEqual([]);
		const skipped = results.filter((result: { skipped: boolean }) => result.skipped);
		expect(skipped).toHaveLength(1);
		expect(skipped[0].line).toContain("skipped (--no-network");
		// The sha and the page link are LOCAL checks: `--no-network` never silences them.
		expect(results.filter((result: { line: string }) => result.line.includes("— on dev"))).toHaveLength(1);
	});

	it("exits 2 — state-page-missing — when the index's page is not there", () => {
		// The page path is DERIVED from the index (#607 D1), so a missing page is "cannot check": there is
		// nothing to compare a claim against, and a named fault is loud where a drift would be misleading.
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-no-page-"));
		const indexFile = join(dir, "HANDOFF.md");
		writeFileSync(indexFile, indexText("correct"));
		const result = run(["--file", indexFile]);
		expect(result.code).toBe(EXIT.USAGE);
		expect(result.err).toContain("state-page-missing");
		expect(result.err).toContain(join(dir, "handoff", "state.md"));
		expect(result.out).not.toContain("drift(s)");
	});

	it("reads the page from the index's own directory, whatever --file names", () => {
		// Two directories, two pages: the index in `a/` must read `a/handoff/state.md` and never `b/`'s.
		const a = pair("correct");
		const b = pair("dev-sha-drift");
		expect(run(["--file", a]).code).toBe(EXIT.OK);
		const drifted = run(["--file", b]);
		expect(drifted.code).toBe(EXIT.DRIFT);
		expect(drifted.out).toContain(CODES.devShaDrift);
	});
});

describe("handoff-verify — the command", () => {
	/** Page drifts: the claim is in the page, the index is the correct fixture. */
	const pageDrift: [string, string][] = [
		["dev-sha-drift", CODES.devShaDrift],
		["open-set-drift", CODES.openSetDrift],
		["suite-count-drift", CODES.suiteCountDrift],
		["file-size-drift", CODES.fileSizeDrift],
		["install-missing", CODES.installMissing],
	];
	/** Index drifts: the index is the drifted fixture, the page is the correct one. */
	const indexDrift: [string, string][] = [
		["verified-not-ancestor", CODES.verifiedNotAncestor],
		["state-drift-heading", CODES.stateDrift],
		["state-drift-h3", CODES.stateDrift],
		["state-shape-fields", CODES.stateShape],
		// Four lines, one wrong NAME: the count arm cannot see this, so it is the per-field loop's killer.
		["state-shape-field", CODES.stateShape],
		["section-over-bound", CODES.sectionOverBound],
		["dead-link", CODES.deadLink],
		["sha-not-ancestor", CODES.shaNotAncestor],
		["path-missing", CODES.pathMissing],
		["unattributed-count", CODES.unattributedCount],
		["next-action-ambiguous", CODES.nextActionAmbiguous],
		["next-action-issue-missing", CODES.nextActionIssueMissing],
		["next-action-state-missing", CODES.nextActionStateMissing],
	];
	/** The pair a drifting row names: `(fixture, which side it drifts, a probe that makes it drift)` — one
	 * file per seeded violation, and the two fact-shaped ones (a missing path, a sha off dev) are made true
	 * by the probe: the fixture states the citation, a real `## Pointers` target, and the check is what
	 * resolves it. */
	const drifting: [string, string, string, Record<string, unknown>][] = [
		...pageDrift.map(([name, code]): [string, string, string, Record<string, unknown>] => [name, code, "page", {}]),
		...indexDrift.map(([name, code]): [string, string, string, Record<string, unknown>] => [
			name,
			code,
			"index",
			// The two fact-shaped rows need the FACT to disagree: the fixture already names a nonexistent file
			// and a sha that is not on dev, so the stub is what a real checkout would answer.
			name === "path-missing" ? { pointerExists: () => false } : name === "sha-not-ancestor" ? { isAncestorOfDev: () => false } : {},
		]),
	];

	it("exits 0 and prints one ✓ per claim on the correct pair", () => {
		const result = run(["--file", correctIndex()]);
		expect(result.code).toBe(EXIT.OK);
		// Fourteen ✓ lines plus two printed SKIPs (`--no-network` is not passed here, but the stub answers the
		// board and the citation, so both resolve): the seven index families that emit a line — verified,
		// budget, completeness, the citation, the cited sha, the counts, the next action — and the page's
		// nine (dev, install, open, suite, modules, adrs, three sizes). Structure/shape/bounds emit nothing.
		expect(result.out.split("\n").filter((line) => line.startsWith("✓"))).toHaveLength(16);
		expect(result.out.split("\n").filter((line) => line.startsWith("✗"))).toHaveLength(0);
		expect(result.out.split("\n").at(-1)).toBe("handoff-verify: 0 drift(s)");
	});

	it("the correct pair is nine page claims plus seven index families", () => {
		// The compatibility pin (#579): the structural check emits NO pass line, so a clean document prints
		// only its claims. The page pass is checks 2–7 (#607), so nine — `Verified:` moved to the index.
		const page = evaluateStatePage(claimsOf("correct"), stub());
		expect(page.drifts).toEqual([]);
		expect(page.results).toHaveLength(9);
		expect(page.results.every((result: { ok: boolean; skipped: boolean }) => result.ok && !result.skipped)).toBe(true);
		const index = evaluateIndex(indexOf("correct"), stub());
		expect(index.drifts).toEqual([]);
		expect(index.results).toHaveLength(7);
		const result = run(["--file", correctIndex()]);
		expect(result.code).toBe(EXIT.OK);
		expect(result.out).not.toContain(CODES.stateDrift);
		expect(result.out).not.toContain(CODES.stateShape);
	});

	it("a missing STATE is still a usage error", () => {
		// Zero STATE exits in `main()` BEFORE `evaluate`, which is louder than a drift and already pinned:
		// even a document with duplicated other headings is refused as a usage fault, never as state-drift.
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-no-state-"));
		const file = join(dir, "HANDOFF.md");
		writeFileSync(file, ["# Handoff", "", "## Open items", "- nothing", "", "## Notes", "one", "", "## Notes", "two", ""].join("\n"));
		const result = run(["--file", file]);
		expect(result.code).toBe(EXIT.USAGE);
		expect(result.err).toContain('has no "## STATE" section');
		expect(result.out).not.toContain(CODES.stateDrift);
		expect(result.err).not.toContain(CODES.stateDrift);
	});

	it("emits `{ok, drifts}` under --json", () => {
		const result = run(["--file", correctIndex(), "--json"]);
		expect(result.code).toBe(EXIT.OK);
		expect(JSON.parse(result.out)).toEqual({ ok: true, drifts: [] });
	});

	for (const [name, code, side, probe] of drifting) {
		it(`fails ${name} (${side}) with ${code} and exit 1`, () => {
			// One file per seeded violation: the index fixture is `correct` with one index rule broken, or the
			// page fixture is `correct` with one claim broken, and the OTHER side is the clean fixture.
			const file = side === "index" ? pair("correct", name) : pair(name, "correct");
			const result = run(["--file", file], stub(probe));
			expect(result.code).toBe(EXIT.DRIFT);
			const failures = result.out.split("\n").filter((line) => line.startsWith("✗"));
			expect(failures).toHaveLength(1);
			expect(failures[0].startsWith(`✗ ${code}: `)).toBe(true);
			expect(result.out.split("\n").at(-1)).toBe("handoff-verify: 1 drift(s)");
		});

		it(`reports ${name} (${side}) as structured drift under --json`, () => {
			const file = side === "index" ? pair("correct", name) : pair(name, "correct");
			const result = run(["--file", file, "--json"], stub(probe));
			expect(result.code).toBe(EXIT.DRIFT);
			const payload = JSON.parse(result.out);
			expect(payload.ok).toBe(false);
			expect(payload.drifts).toHaveLength(1);
			expect(payload.drifts[0].code).toBe(code);
			expect(Object.keys(payload.drifts[0])).toEqual(["code", "claim", "expected", "actual"]);
			for (const value of Object.values(payload.drifts[0])) expect(typeof value).toBe("string");
		});
	}

	it("says out loud that --no-network skipped the open set", () => {
		const result = run(["--file", correctIndex(), "--no-network"]);
		expect(result.code).toBe(EXIT.OK);
		expect(result.out).toContain(`- Open: #426, #450 — skipped (--no-network:`);
		expect(result.out.split("\n").at(-1)).toBe("handoff-verify: 0 drift(s)");
	});

	it("keeps the skip notice off stdout under --json, so the machine reads JSON", () => {
		const result = run(["--file", correctIndex(), "--no-network", "--json"]);
		expect(() => JSON.parse(result.out)).not.toThrow();
		expect(result.err).toContain("skipped (--no-network:");
	});

	it("is deterministic, and reports in document order", () => {
		const argv = ["--file", pair("file-size-drift"), "--no-network"];
		expect(run(argv).out).toBe(run(argv).out);
		// Order is fixed by the CHECK, never by the map iteration or the filesystem.
		const probe = stub({ devSha: () => "deadbee1c0ffee", modules: () => 59, adrs: () => 28 });
		const { drifts } = evaluateStatePage(claimsOf("correct"), probe, { noNetwork: true });
		expect(drifts.map((drift) => drift.code)).toEqual([
			CODES.devShaDrift,
			CODES.installShaDrift,
			CODES.modulesDrift,
			CODES.adrsDrift,
		]);
	});

	it("exits 2 on a usage fault, never 1", () => {
		expect(run(["--nope"]).code).toBe(EXIT.USAGE);
		expect(run(["--file"]).code).toBe(EXIT.USAGE);
		expect(run(["handoff.md"]).code).toBe(EXIT.USAGE);
		expect(run(["--file", join(FIXTURES, "no-such.md")]).code).toBe(EXIT.USAGE);
	});

	it("exits 2 on a file with no ## STATE section", () => {
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-verify-"));
		const file = join(dir, "HANDOFF.md");
		writeFileSync(file, "# Handoff\n\nno state here\n");
		const result = run(["--file", file]);
		expect(result.code).toBe(EXIT.USAGE);
		expect(result.err).toContain('has no "## STATE" section');
	});

	it("exits 2 when the report or the board cannot be read — an unanswerable check is not a pass", () => {
		const noReport = run(["--file", correctIndex()], stub({ report: () => null }));
		expect(noReport.code).toBe(EXIT.USAGE);
		expect(noReport.err).toContain("vitest JSON report");
		const noIssues = run(
			["--file", correctIndex()],
			stub({
				openIssues: () => {
					throw new InputError("gh issue list failed (not logged in)");
				},
			}),
		);
		expect(noIssues.code).toBe(EXIT.USAGE);
		expect(noIssues.err).toContain("not logged in");
	});

	it("parses the documented flags", () => {
		expect(
			parseArgs(["--file", "a.md", "--report", "r.json", "--report-dir", "d", "--issues", "i.json", "--no-network", "--json"]),
		).toEqual({
			ok: true,
			options: { root: "", file: "a.md", report: "r.json", reportDir: "d", issues: "i.json", noNetwork: true, json: true },
		});
		// `--root` is INITIALISED, not merely mapped: an absent flag must resolve to this checkout, and a
		// `resolve(undefined)` on the way would throw before any check ran (#548).
		expect(parseArgs([]).ok).toBe(true);
		const parsed = parseArgs(["--root", "/elsewhere"]);
		expect(parsed.ok && parsed.options.root).toBe("/elsewhere");
		expect(parseArgs(["--json", "--json"]).ok).toBe(true);
	});
});

describe("handoff-verify — the seams", () => {
	it("reads reports through the shared lib, and keeps no competing definition (#513)", async () => {
		// The defect #513 removes is a SECOND definition: the handoff's suite check and the PR body's
		// `suite:` key both read ~/scripts/handoff-verify.mjs, so a fix in one place was not a fix.
		const handoffVerify = await import("../handoff-verify.mjs");
		expect(handoffVerify).not.toHaveProperty("readSuiteReport");
		expect(handoffVerify).not.toHaveProperty("findNewestReport");
		expect(readSuiteReport(REPORT)).toMatchObject({ path: REPORT, files: 2, tests: 12 });
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-verify-"));
		const notReport = join(dir, "vitest-config.json");
		writeFileSync(notReport, JSON.stringify({ testResults: [] }));
		expect(() => readSuiteReport(notReport)).toThrow(/no testResults/);
	});

	it("refuses a hollow report in --report-dir instead of using it as a baseline", () => {
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-verify-"));
		const reports = join(dir, "reports");
		mkdirSync(reports);
		writeFileSync(join(reports, "hollow.json"), JSON.stringify({ numPassedTests: 9999, testResults: [{}] }));
		const probe = createRepoProbe(dir, { reportDir: reports });
		expect(() => probe.report()).toThrow(/hollow-report/);
		expect(() => probe.report()).toThrow(/hollow\.json/);
		// The CLI answers "cannot check" (2), never a drift (1): a hollow report is an input that cannot
		// answer, not evidence that the claim is wrong.
		const result = run(["--file", correctIndex(), "--no-network"], stub({ report: () => probe.report() }));
		expect(result.code).toBe(EXIT.USAGE);
		expect(result.err).toContain("hollow-report");
	});

	it("refuses two reports under --report-dir by naming both, never selecting one", () => {
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-verify-"));
		const older = join(dir, "older.json");
		const newer = join(dir, "newer.json");
		writeFileSync(older, readFileSync(REPORT, "utf8"));
		writeFileSync(newer, readFileSync(REPORT, "utf8"));
		utimesSync(older, new Date(1000), new Date(1000));
		utimesSync(newer, new Date(2000), new Date(2000));
		const probe = createRepoProbe(dir, { reportDir: dir });
		expect(() => probe.report()).toThrow(/ambiguous-reports/);
		try {
			probe.report();
		} catch (error) {
			// Both paths, not just the one mtime would have preferred.
			expect((error as Error).message).toContain(older);
			expect((error as Error).message).toContain(newer);
		}
	});

	/**
	 * #520 — the handoff's `Verified:` sha must REACH the resolver, and it must be read from the handoff being
	 * checked (the resolver is what makes one capture-per-head a working default). Reading `Verified:` first
	 * and resolving second is the whole fix; the stub records the argument so a lazy probe that resolves
	 * before the STATE is parsed fails here.
	 */
	it("hands the handoff's Verified sha to the report resolver (#520)", () => {
		const seen: string[] = [];
		const probe = stub({
			report: (expectHead: string) => {
				seen.push(expectHead);
				return snapshot();
			},
		});
		const result = run(["--file", correctIndex(), "--no-network"], probe);
		expect(result.code).toBe(EXIT.OK);
		expect(seen).toEqual(["4c1d9ab"]);
	});

	it("carries the report's provenance and the derived counts in the suite line", () => {
		const dirty = run(["--file", correctIndex(), "--no-network"], stub({ report: () => snapshot({ label: LABELS.DIRTY }) }));
		expect(dirty.out).toContain(LABELS.DIRTY);
		const clean = run(["--file", correctIndex(), "--no-network"]);
		// The stub without a label prints no parenthesised claim rather than "undefined".
		expect(clean.out).not.toContain("undefined");
		// #583: the pass line states the breakdown the report DERIVED, so a green total cannot hide a red run.
		expect(clean.out).toContain(`✓ Suite: 2 files / 12 tests — the vitest report at ${REPORT}; 12 passed, 0 failed, 0 skipped`);
	});

	it("reads an injected issue list, numbers or objects", () => {
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-verify-"));
		const file = join(dir, "issues.json");
		writeFileSync(file, JSON.stringify([{ number: 426 }, { number: 450 }]));
		expect(readIssues({ root: dir, issues: file })).toEqual([426, 450]);
		writeFileSync(file, JSON.stringify([450, 426]));
		expect(readIssues({ root: dir, issues: file })).toEqual([450, 426]);
		writeFileSync(file, JSON.stringify({ not: "an array" }));
		expect(() => readIssues({ root: dir, issues: file })).toThrow(InputError);
	});

	it("parses a git range log, keeping both sides of a rename", () => {
		const raw =
			"\u0001aaaaaaa1111\u0000\nM\u0000.development/HANDOFF.md\u0000" +
			"\u0001bbbbbbb2222\u0000\nR100\u0000foreign.txt\u0000.development/HANDOFF-ARCHIVE-2026-11-08.md\u0000" +
			"\u0001ccccccc3333\u0000\nA\u0000src/index.ts\u0000";
		expect(parseRangeLog(raw)).toEqual([
			{ sha: "aaaaaaa1111", paths: [".development/HANDOFF.md"] },
			{ sha: "bbbbbbb2222", paths: ["foreign.txt", ".development/HANDOFF-ARCHIVE-2026-11-08.md"] },
			{ sha: "ccccccc3333", paths: ["src/index.ts"] },
		]);
		expect(isHandoffOwnCommit(parseRangeLog(raw)[1])).toBe(false);
	});

	it("reads a real git repo: dev, ancestry, and the paths each commit touched", () => {
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-verify-"));
		const git = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
		expect(git("init", "-q", "-b", "dev").status).toBe(0);
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Test");
		writeFileSync(join(dir, "a.txt"), "a\n");
		// The counters read the SELECTED root (#548): a repo with no `src/` and no decisions would be "cannot
		// check", so the fixture carries one of each and the modules/ADRs claims below drift as ordinary values.
		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "one.ts"), "// Purpose: the only module of the scratch repo.\nexport {};\n");
		mkdirSync(join(dir, ".development", "decisions"), { recursive: true });
		writeFileSync(join(dir, ".development", "decisions", "0001-scratch.md"), "# 0001. A scratch decision\n\n- **Status:** Accepted\n- **Date:** 2026-11-08\n");
		git("add", ".");
		git("commit", "-qm", "first");
		const base = git("rev-parse", "HEAD").stdout.trim();
		mkdirSync(join(dir, ".development"), { recursive: true });
		writeFileSync(join(dir, ".development", "HANDOFF.md"), "state\n");
		git("add", ".");
		git("commit", "-qm", "handoff");
		const handoffSha = git("rev-parse", "HEAD").stdout.trim();

		const probe = createRepoProbe(dir, { report: REPORT });
		expect(probe.devSha()).toBe(handoffSha);
		expect(probe.headSha()).toBe(handoffSha);
		expect(probe.isAncestor(base)).toBe(true);
		expect(probe.isAncestor("9999999")).toBe(false);
		expect(probe.commitsAfter(base)).toEqual([{ sha: handoffSha, paths: [".development/HANDOFF.md"] }]);

		// One foreign commit after Verified is drift, and the message names it.
		writeFileSync(join(dir, "src.ts"), "export {};\n");
		git("add", ".");
		git("commit", "-qm", "foreign");
		const foreignSha = git("rev-parse", "HEAD").stdout.trim();
		const verified = parseIndex(indexText("correct").replace("4c1d9ab (2026-11-08)", `${base} (2026-11-08)`));
		// #607: `Verified:` is the INDEX's claim, so this arm is the index pass's. The probe is the real one.
		const { drifts } = evaluateIndex(verified, probe, { noNetwork: true });
		expect(drifts.map((drift) => drift.code)).toContain(CODES.verifiedDrift);
		expect(drifts.find((drift) => drift.code === CODES.verifiedDrift).actual).toBe("1 such commit(s)");

		// A foreign file RENAMED to a handoff archive touches a foreign path on both sides.
		writeFileSync(join(dir, "foreign.txt"), "f\n");
		git("add", ".");
		git("commit", "-qm", "foreign file");
		git("mv", "foreign.txt", join(".development", "HANDOFF-ARCHIVE-2026-11-08.md"));
		git("commit", "-qm", "rename");
		const renameSha = git("rev-parse", "HEAD").stdout.trim();
		const rename = probe.commitsAfter(base).find((commit: { sha: string }) => commit.sha === renameSha);
		expect(rename.paths).toContain("foreign.txt");
		expect(isHandoffOwnCommit(rename)).toBe(false);
		expect(foreignSha).not.toBe(renameSha);
	});
});

/**
 * The dev claim (#497) — the false alarm the tool shipped with. A commit that touches only the handoff moves
 * `git rev-parse dev` but NOT the claim §STATE records: the repo's convention is that the claim is the last
 * non-handoff commit (the merge), with the handoff on top. On the pre-fix head every one of these reports a
 * `dev-sha-drift` for a handoff that is correct, which is the failure mode the tool exists to prevent.
 */
describe("handoff-verify — the dev claim ignores the handoff's own commit (#497)", () => {
	/** A throwaway repo: one code commit on `dev`, the handoff commit on top. The claim is the code commit. */
	function scratch() {
		const dir = mkdtempSync(join(tmpdir(), "brl-dev-claim-"));
		const git = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
		git("init", "-q", "-b", "dev");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Test");
		writeFileSync(join(dir, "code.ts"), "export {};\n");
		git("add", ".");
		git("commit", "-qm", "code");
		const devClaim = git("rev-parse", "HEAD").stdout.trim();
		mkdirSync(join(dir, ".development"), { recursive: true });
		writeFileSync(join(dir, ".development", "HANDOFF.md"), `- **dev** @ \`${devClaim}\`.\n`);
		git("add", ".");
		git("commit", "-qm", "handoff");
		return { dir, git, devClaim, handoff: git("rev-parse", "HEAD").stdout.trim() };
	}

	/** The real git facts for the dev checks, the stub for everything else (board, suite, sizes). */
	function probeFor(dir: string, commitsAfter: () => { sha: string; paths: string[] }[]) {
		const repo = createRepoProbe(dir, { report: REPORT });
		return { ...stub(), devSha: repo.devSha, devClaimSha: repo.devClaimSha, isAncestor: () => true, commitsAfter };
	}

	/** `correct.md` with its dev claim moved onto a real sha of the scratch repo. */
	function claimsAt(sha: string) {
		return parseClaims(text("correct").replace(/4c1d9ab/g, sha));
	}

	it("resolves dev past the handoff commit, so the claim still holds", () => {
		const { dir, devClaim, handoff } = scratch();
		const probe = probeFor(dir, () => [{ sha: handoff, paths: [".development/HANDOFF.md"] }]);
		expect(probe.devSha()).toBe(handoff); // the ref IS the handoff commit
		expect(probe.devClaimSha()).toBe(devClaim); // the claim is the last non-handoff commit
		expect(evaluateStatePage(claimsAt(devClaim), probe).drifts).toEqual([]);
	});

	it("still names dev-sha-drift when a code commit lands on top — the rule swallows no real drift", () => {
		const { dir, git, devClaim, handoff } = scratch();
		writeFileSync(join(dir, "later.ts"), "export {};\n");
		git("add", ".");
		git("commit", "-qm", "code after the handoff");
		const tip = git("rev-parse", "HEAD").stdout.trim();
		const probe = probeFor(dir, () => [{ sha: handoff, paths: [".development/HANDOFF.md"] }]);
		expect(probe.devClaimSha()).toBe(tip);
		const { drifts, results } = evaluateStatePage(claimsAt(devClaim), probe);
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.devShaDrift, CODES.installShaDrift]);
		for (const drift of drifts) {
			expect(drift.expected).toBe(tip);
			expect(drift.actual).toBe(devClaim);
		}
		for (const failure of results.filter((result: { ok: boolean }) => !result.ok)) {
			// Here the claim IS the raw ref (the code commit is the tip), so the ref is the honest phrase.
			expect(failure.line).toContain(`git rev-parse dev is ${tip}`);
		}
	});

	it("compares the install line against the same claim, never the raw ref", () => {
		const { dir, devClaim, handoff } = scratch();
		const probe = probeFor(dir, () => [{ sha: handoff, paths: [".development/HANDOFF.md"] }]);
		// The install line names the handoff commit — drift, and the message names the claim's own rule.
		const claims = parseClaims(
			text("correct")
				.replace(/4c1d9ab/g, devClaim)
				.replace(`this repo, \`dev @ ${devClaim}\``, `this repo, \`dev @ ${handoff}\``),
		);
		const { drifts, results } = evaluateStatePage(claims, probe);
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.installShaDrift]);
		expect(drifts[0].claim).toBe(`Running install: dev @ ${handoff}`);
		expect(drifts[0].expected).toBe(devClaim);
		expect(results.find((result: { ok: boolean }) => !result.ok).line).toContain("the last non-handoff commit on dev is");
	});

	it("refuses to guess when the walk cannot terminate — a fault, never a drift", () => {
		const dir = mkdtempSync(join(tmpdir(), "brl-dev-claim-"));
		const git = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
		git("init", "-q", "-b", "dev");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Test");
		mkdirSync(join(dir, ".development"), { recursive: true });
		writeFileSync(join(dir, ".development", "HANDOFF.md"), "state\n");
		git("add", ".");
		git("commit", "-qm", "handoff only");
		expect(() => createRepoProbe(dir).devClaimSha()).toThrow(/cannot resolve the dev claim/);
	});
});

/**
 * The CLI seam — a REAL process, because that is the gap the review found: `--report` and `--issues` were
 * parsed, then dropped between `main` and `createRepoProbe` (the two sides named the options differently),
 * and every test above passed because `main`'s probe was a stub. A test through `io.probe` cannot see a
 * flag that never reaches the probe, so these spawn the script itself.
 */
describe("handoff-verify — the CLI seam", () => {
	const SCRIPT = join(ROOT, "scripts", "handoff-verify.mjs");

	interface ScratchRepo {
		dir: string;
		git: (...args: string[]) => { stdout: string | null; status: number | null };
		/** An EARLIER commit than `code` — a real stale candidate for the capture-resolution case (#520). */
		seed: string;
		/** The commit the STATE describes: the last non-handoff commit, so it IS the dev claim. */
		code: string;
		handoffSha: string;
	}

	/**
	 * A throwaway checkout with four commits, every collector input committed before the handoff-only commit:
	 * seed (`src/seed.ts`, the earlier stale candidate) → the collectors' inputs (`src/` as the two modules and
	 * one ADR, so the counters read 2 and 1) → code (`src/code.ts`, the tree the STATE describes) → the handoff.
	 *
	 * The ORDER is load-bearing: `devClaimSha()` walks back only handoff-only commits, so the last non-handoff
	 * commit is the dev claim. That is why the collector commit sits BEFORE the code commit — on top of it, the
	 * claim would become a commit the STATE does not describe and every run here would drift on its own
	 * `Verified:` line. `git init -b dev` because the tool resolves `dev` (there is no `main` in a scratch repo).
	 */
	function scratchRepo(): ScratchRepo {
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-root-"));
		const git = (...args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
		const commit = (message: string) => {
			git("add", "-A");
			git("commit", "-qm", message);
			return git("rev-parse", "HEAD").stdout.trim();
		};
		git("init", "-q", "-b", "dev");
		git("config", "user.email", "test@example.com");
		git("config", "user.name", "Test");

		mkdirSync(join(dir, "src"), { recursive: true });
		writeFileSync(join(dir, "src", "seed.ts"), "// Purpose: the first scratch module.\nexport const seed = 1;\n");
		const seed = commit("seed");

		// The decision counter reads `.development/decisions/NNNN-*.md`; the module counter reads every top-level
		// `src/*.ts`, so both modules carry the purpose header the generator requires.
		mkdirSync(join(dir, ".development", "decisions"), { recursive: true });
		writeFileSync(
			join(dir, ".development", "decisions", "0001-scratch.md"),
			"# 0001. A scratch decision\n\n- **Status:** Accepted\n- **Date:** 2026-11-08\n",
		);
		commit("decisions");

		writeFileSync(join(dir, "src", "code.ts"), "// Purpose: the second scratch module, and the tree the handoff describes.\nexport const code = 1;\n");
		const code = commit("code");

		// The handoff-only commit: nothing but `.development/HANDOFF.md`, which is what keeps the claim at `code`.
		writeFileSync(join(dir, ".development", "HANDOFF.md"), `## STATE\nVerified: ${code} (2026-11-08)\n`);
		const handoffSha = commit("handoff");
		return { dir, git, seed, code, handoffSha };
	}

	function runCli(argv: string[], env: Record<string, string> = {}): Run {
		const result = spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: "utf8", env: { ...process.env, ...env } });
		return { code: result.status ?? -1, out: result.stdout ?? "", err: result.stderr ?? "" };
	}

	/**
	 * A handoff that is TRUE of the checkout it names (#548). It used to be `liveHandoff()` — the live dev tip and
	 * the counts this repo's generators report — which made every CLI test depend on THIS checkout's history: in a
	 * worktree whose base is older than `dev`, the `Verified:` arm and the `Verified..dev` arm cannot both hold,
	 * so three tests went red with the branch unchanged. A scratch checkout makes them hermetic instead, and
	 * `--root` is what lets a real CLI run read it.
	 *
	 * The STATE is built from the SCRATCH repo's `devClaimSha()`, so the fixture cannot drift from the tree it
	 * describes: an absent `--root` here would evaluate this checkout against a foreign STATE and print drift.
	 * `modules`/`adrs` default to what that checkout's own generators report, and stay parameters so a test can
	 * state counts the checkout does not have.
	 *
	 * TWO FILES since #607: the INDEX goes to `<dir>/HANDOFF.md` (the `--file` subject) and the PAGE to
	 * `<dir>/handoff/state.md` (derived from the index's own directory). `next` is the index's next action —
	 * a parameter because a test that injects the board (`--issues`) has to cite an issue that board holds.
	 */
	function writeHandoff(
		dir: string,
		repo: ScratchRepo,
		{
			suite,
			open,
			modules = collectModules(repo.dir).length,
			adrs = collectDecisions(repo.dir).length,
			next = 426,
		}: { suite: string; open: string; modules?: number; adrs?: number; next?: number },
	): string {
		// The dev CLAIM, not the raw ref: the convention is that the claim names the last non-handoff commit
		// (#497), so the handoff commit sitting on `dev` must not make this fixture drift on its own.
		const dev = createRepoProbe(repo.dir).devClaimSha();
		mkdirSync(join(dir, "handoff"), { recursive: true });
		writeFileSync(
			join(dir, "handoff", "state.md"),
			[
				"## STATE",
				`- **dev** @ \`${dev}\`. The scratch dev tip.`,
				`- **Running install:** this repo (\`dev @ ${dev}\`) — the scratch checkout.`,
				`- **Board:** Open: ${open}, PR #402 held.`,
				`- **Suite:** ${suite} green on dev; docs guards current (**${modules} modules**, **${adrs} ADRs**).`,
				// The page's own structural guard (#579): one `## STATE`. A clean fixture is a clean document.
				"",
				"## Open items",
				`- ${open}.`,
			].join("\n"),
		);
		// The index: four §STATE lines, a bounded section set, and one pointer row at the page `pages()` finds.
		const indexFile = join(dir, "HANDOFF.md");
		writeFileSync(
			indexFile,
			[
				"# Handoff — scratch fixture",
				"",
				"> A throwaway checkout, not this one.",
				"",
				"## STATE",
				`Verified: ${dev} (2026-11-08)`,
				"In flight: nothing",
				`Next action: #${next} (open) — the scratch action`,
				"Index: verify `node scripts/handoff-verify.mjs` (0 drift) before acting → handoff/state.md",
				"",
				"## Invariants",
				"- the page holds every mechanical claim",
				"",
				"## Pointers",
				"| Page | Holds |",
				"|---|---|",
				"| [state](handoff/state.md) | the scratch snapshot |",
				"",
				"## Resume protocol",
				"node scripts/handoff-verify.mjs     # 0 drift",
			].join("\n"),
		);
		return indexFile;
	}

	/** Only the `✗` lines — a drift test that counted `✓` too would pass on a clean run. */
	function failures(result: Run): string[] {
		return result.out.split("\n").filter((line) => line.startsWith("✗"));
	}

	/** A report body that IS evidence: `files` result entries holding `tests` assertions in total. */
	function suiteBody(files: number, tests: number): unknown {
		const perFile = (index: number) => ({
			assertionResults: Array.from({ length: index === 0 ? tests - (files - 1) : 1 }, (_unused, at) => ({ fullName: `f${index}-${at}`, status: "passed" })),
		});
		return { numTotalTests: tests, numPassedTests: tests, testResults: Array.from({ length: files }, (_unused, index) => perFile(index)) };
	}

	it("honours --report over --report-dir, and fails with the INJECTED counts", () => {
		const repo = scratchRepo();
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-cli-"));
		const injected = join(dir, "injected.json");
		// 3 files / 7 tests — nothing under the scanned directory looks like this, which is the point.
		writeFileSync(injected, JSON.stringify(suiteBody(3, 7)));
		// A report at the scanned location with DIFFERENT counts: the value `--report` would lose to if the
		// two were not explicitly ordered. No mtime is involved — --report simply wins.
		const scanned = join(dir, "scanned");
		mkdirSync(scanned);
		writeFileSync(join(scanned, "planted.json"), JSON.stringify(suiteBody(11, 99)));
		const handoff = writeHandoff(dir, repo, { suite: "2 files / 40 tests", open: "#426, #450" });
		const result = runCli(["--root", repo.dir, "--file", handoff, "--report", injected, "--report-dir", scanned, "--no-network"]);
		expect(result.code).toBe(EXIT.DRIFT);
		expect(failures(result)).toHaveLength(1);
		expect(failures(result)[0]).toContain(CODES.suiteCountDrift);
		expect(failures(result)[0]).toContain("3 files / 7 tests");
		expect(failures(result)[0]).toContain(`the vitest report at ${injected}`);
		expect(failures(result)[0]).not.toContain(join(scanned, "planted.json"));
	});

	it("exits 2 on several unmarked --report-dir candidates, naming every one and its absent provenance", () => {
		// #520: with a `Verified:` head to match against, two reports that carry NO sidecar cannot be ranked —
		// not by age and not by the head — so the refusal names `no-provenance-match` rather than the generic
		// `ambiguous-reports`. The paths and the provenance are both in the message, because a reader picking
		// one by hand needs to know that neither claims a tree.
		const repo = scratchRepo();
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-cli-"));
		const reports = join(dir, "reports");
		mkdirSync(reports);
		writeFileSync(join(reports, "a.json"), JSON.stringify(suiteBody(2, 40)));
		writeFileSync(join(reports, "b.json"), JSON.stringify(suiteBody(2, 40)));
		const handoff = writeHandoff(dir, repo, { suite: "2 files / 40 tests", open: "#426, #450" });
		const result = runCli(["--root", repo.dir, "--file", handoff, "--report-dir", reports, "--no-network"]);
		expect(result.code).toBe(EXIT.USAGE);
		expect(result.err).toContain("no-provenance-match");
		expect(result.err).toContain(join(reports, "a.json"));
		expect(result.err).toContain(join(reports, "b.json"));
		expect(result.err).toContain(LABELS.ABSENT);
	});

	/**
	 * The documented default, with the state a SECOND `--capture` produces: one report per head, never pruned.
	 * Before #520 the handoff-verify probe passed no expected head, so this state was `ambiguous-reports` —
	 * the tool's own documented path refused to run after the second capture. The `Verified:` line is the
	 * disambiguator, and the report it selects is the one whose counts the suite check reads.
	 */
	it("resolves several captures by the handoff's Verified head (#520)", () => {
		const repo = scratchRepo();
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-verified-"));
		const reports = join(dir, "reports");
		mkdirSync(reports);
		const head = createRepoProbe(repo.dir).devClaimSha();
		// A REAL earlier commit of the same checkout, not a made-up sha: the stale report belongs to a tree this
		// repo actually had, which is what "one report per head, never pruned" looks like one capture later.
		const other = repo.seed;
		// The report of ANOTHER tree carries counts that would drift; the report of the verified tree matches.
		const stale = join(reports, `${other}.json`);
		writeFileSync(stale, JSON.stringify(suiteBody(11, 99)));
		writeFileSync(`${stale}.provenance.json`, JSON.stringify({ head: other, dirty: false, capturedAt: "2026-11-08T00:00:00.000Z" }));
		const mine = join(reports, `${head}.json`);
		writeFileSync(mine, JSON.stringify(suiteBody(2, 40)));
		writeFileSync(`${mine}.provenance.json`, JSON.stringify({ head, dirty: false, capturedAt: "2026-11-08T00:00:01.000Z" }));
		const handoff = writeHandoff(dir, repo, { suite: "2 files / 40 tests", open: "#426, #450" });
		const result = runCli(["--root", repo.dir, "--file", handoff, "--report-dir", reports, "--no-network"]);
		expect(result.err).not.toContain("ambiguous-reports");
		expect(result.code).toBe(EXIT.OK);
		// Exit 0 alone could be a run that read neither report; the selected head and the matching suite line
		// are the two halves that prove resolution happened.
		expect(result.out).toContain(`head ${head}`);
		expect(result.out).toContain("✓ Suite: 2 files / 40 tests");
		expect(result.out).not.toContain("11 files / 99 tests");
	});

	/**
	 * Two marked reports of the SAME head are a duplicate, not a tie: `--capture` cannot produce this (one
	 * file per head), so it is a hand-copied report — and the message has to say which shape it is, because
	 * "pass --report" is the wrong instruction for two files that describe one tree.
	 */
	it("names a duplicate copy of one head instead of calling it a tie (#520)", () => {
		const repo = scratchRepo();
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-dupe-"));
		const reports = join(dir, "reports");
		mkdirSync(reports);
		const head = createRepoProbe(repo.dir).devClaimSha();
		for (const name of ["copy.json", `${head}.json`]) {
			const path = join(reports, name);
			writeFileSync(path, JSON.stringify(suiteBody(2, 40)));
			writeFileSync(`${path}.provenance.json`, JSON.stringify({ head, dirty: false, capturedAt: "2026-11-08T00:00:00.000Z" }));
		}
		const handoff = writeHandoff(dir, repo, { suite: "2 files / 40 tests", open: "#426, #450" });
		const result = runCli(["--root", repo.dir, "--file", handoff, "--report-dir", reports, "--no-network"]);
		expect(result.code).toBe(EXIT.USAGE);
		expect(result.err).toContain("ambiguous-reports");
		expect(result.err).toContain(`SAME head ${head}`);
		expect(result.err).toContain("duplicate copy");
	});

	it("honours --issues without ever invoking gh, and fails with the INJECTED board", () => {
		const repo = scratchRepo();
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-cli-"));
		// A board that matches no live issue list, so a run that reached `gh` could not print it.
		const issues = join(dir, "issues.json");
		writeFileSync(issues, JSON.stringify([{ number: 777 }, { number: 778 }]));
		// `gh` on PATH is a shim that leaves a mark: the proof is the absent marker, not the exit code.
		const bin = join(dir, "bin");
		mkdirSync(bin);
		const marker = join(dir, "gh-was-called");
		writeFileSync(join(bin, "gh"), `#!/bin/sh\necho "$@" >> "${marker}"\nexit 1\n`, { mode: 0o755 });
		const report = join(dir, "suite.json");
		writeFileSync(report, JSON.stringify(suiteBody(2, 40)));
		const handoff = writeHandoff(dir, repo, { suite: "2 files / 40 tests", open: "#426, #450", next: 777 });

		const result = runCli(["--root", repo.dir, "--file", handoff, "--report", report, "--issues", issues], { PATH: `${bin}:${process.env.PATH ?? ""}` });
		expect(existsSync(marker)).toBe(false);
		expect(result.code).toBe(EXIT.DRIFT);
		expect(failures(result)).toHaveLength(1);
		expect(failures(result)[0]).toContain(CODES.openSetDrift);
		expect(failures(result)[0]).toContain("#777, #778");
	});

	it("answers an (open) citation from the injected board, and refuses a (closed) one as unanswerable", () => {
		// #607 D7: `--issues` injects `gh issue list --state open`. It can answer "open" and "not open"; a
		// `(closed|merged)` claim it cannot answer is exit 2 — a guess here would be the vacuous proof the
		// whole unit exists to remove.
		const repo = scratchRepo();
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-issues-"));
		const issues = join(dir, "issues.json");
		writeFileSync(issues, JSON.stringify([{ number: 426 }, { number: 450 }]));
		const report = join(dir, "suite.json");
		writeFileSync(report, JSON.stringify(suiteBody(2, 40)));

		const open = writeHandoff(dir, repo, { suite: "2 files / 40 tests", open: "#426, #450" });
		const cited = runCli(["--root", repo.dir, "--file", open, "--report", report, "--issues", issues]);
		expect(cited.code).toBe(EXIT.OK);
		expect(cited.out).toContain("✓ #426 (open)");

		// A citation the injected board does NOT hold: open-set drift is about the page's `Open:` set, so this
		// row is about the INDEX's citation — one drift, named for the citation.
		const wrong = writeHandoff(dir, repo, { suite: "2 files / 40 tests", open: "#426, #450", next: 999 });
		const drifted = runCli(["--root", repo.dir, "--file", wrong, "--report", report, "--issues", issues, "--json"]);
		expect(drifted.code).toBe(EXIT.DRIFT);
		expect(JSON.parse(drifted.out).drifts.map((drift: { code: string }) => drift.code)).toEqual([CODES.issueStateDrift]);

		// A `(closed)` citation against an injected OPEN list: cannot check → 2, never 1.
		const closedIndex = writeHandoff(dir, repo, { suite: "2 files / 40 tests", open: "#426, #450" });
		writeFileSync(closedIndex, readFileSync(closedIndex, "utf8").replace("Next action: #426 (open)", "Next action: #426 (closed)"));
		const unanswerable = runCli(["--root", repo.dir, "--file", closedIndex, "--report", report, "--issues", issues]);
		expect(unanswerable.code).toBe(EXIT.USAGE);
		expect(unanswerable.err).toContain("injects the OPEN set only");
	});

	/**
	 * #579 (C9) — the SUBJECT. r3's finding: comparing `parseClaims(dup)` with `parseClaims(read(target))`
	 * never exercises CLI subject RESOLUTION, so a CLI reading structure from one document and claims from
	 * another passed. This drives the real seam against the repo's own `scratchRepo()`: the DEFAULT document
	 * under `--root`, and `--file` naming another one, with conflicting documents on purpose.
	 *
	 * #607 moved the sub-section-shape fault to the INDEX (an extra H2 is `state-drift` there), so the
	 * duplicate the CLI must tell apart is a second `## STATE` in the index rather than in the page.
	 *
	 * DEVIATION FROM THE SPEC'S LITERAL COMMAND, stated: `--report` is injected. Without a report the suite
	 * check is a named "cannot check" (exit 2) for a scratch checkout's counts — r2 measured exactly that —
	 * so a matching report is what makes both rows answerable; every other fact still follows `--root`.
	 */
	it("the scanner follows the resolved subject", () => {
		const repo = scratchRepo();
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-subject-"));
		const report = join(dir, "suite.json");
		writeFileSync(report, JSON.stringify(suiteBody(2, 40)));
		const handoff = writeHandoff(join(repo.dir, ".development"), repo, { suite: "2 files / 40 tests", open: "#426, #450" });
		expect(handoff).toBe(join(repo.dir, ".development", "HANDOFF.md"));
		const clean = readFileSync(handoff, "utf8");
		const duplicate = `${clean}\n## STATE\nVerified: ${createRepoProbe(repo.dir).devClaimSha()} (2026-11-08)\n`;
		// The two documents the CLI must tell apart: a clean index and one with a second §STATE heading.
		// `--file` points at a COPY in the same directory, so it shares the page the default document uses.
		const cleanFile = join(repo.dir, ".development", "CLEAN.md");
		const duplicateFile = join(repo.dir, ".development", "DUPLICATE.md");
		writeFileSync(cleanFile, clean);
		writeFileSync(duplicateFile, duplicate);

		// The resolved subject is the checkout's own handoff: clean → 0.
		const cleanRun = runCli(["--root", repo.dir, "--report", report, "--no-network"]);
		expect(cleanRun.code).toBe(EXIT.OK);
		expect(cleanRun.out).not.toContain(CODES.stateDrift);

		// A second `## STATE` appended to that same default document → exit 1, and the drift is the FIRST line.
		writeFileSync(handoff, duplicate);
		const drifted = runCli(["--root", repo.dir, "--report", report, "--no-network"]);
		expect(drifted.code).toBe(EXIT.DRIFT);
		expect(failures(drifted)[0]).toContain("✗ state-drift: H2 ");		// The structured half (r3): exit 1 alone would also pass a run that drifted for another reason, so
		// the JSON must name exactly this code and no other — the duplicated heading is the ONLY fault here.
		const json = runCli(["--root", repo.dir, "--report", report, "--no-network", "--json"]);
		expect(json.code).toBe(EXIT.DRIFT);
		expect(JSON.parse(json.out).drifts.map((drift: { code: string }) => drift.code)).toEqual([CODES.stateDrift]);

		// `--file` names ANOTHER subject: the clean copy stays green while the duplicated one reddens, so the
		// scan follows the document the CLI resolved and never a module-level cached one.
		const viaFileClean = runCli(["--root", repo.dir, "--file", cleanFile, "--report", report, "--no-network"]);
		expect(viaFileClean.code).toBe(EXIT.OK);
		const viaFileDuplicate = runCli(["--root", repo.dir, "--file", duplicateFile, "--report", report, "--no-network"]);
		expect(viaFileDuplicate.code).toBe(EXIT.DRIFT);
		expect(failures(viaFileDuplicate)[0]).toContain("✗ state-drift: H2 ");
	});

	it("exits 2 on a malformed --report or --issues, never 1", () => {
		const repo = scratchRepo();
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-cli-"));
		const handoff = writeHandoff(dir, repo, { suite: "2 files / 40 tests", open: "#426, #450" });
		const garbage = join(dir, "garbage.json");
		writeFileSync(garbage, "{ not json");

		const report = runCli(["--root", repo.dir, "--file", handoff, "--report", garbage, "--no-network"]);
		expect(report.code).toBe(EXIT.USAGE);
		expect(report.err).toContain("not JSON");

		const missing = runCli(["--root", repo.dir, "--file", handoff, "--issues", join(dir, "no-such-issues.json")]);
		expect(missing.code).toBe(EXIT.USAGE);
		expect(missing.err).toContain("cannot read the issue list");

		const shape = join(dir, "issues.json");
		writeFileSync(shape, JSON.stringify({ number: 495 }));
		const notArray = runCli(["--root", repo.dir, "--file", handoff, "--issues", shape]);
		expect(notArray.code).toBe(EXIT.USAGE);
		expect(notArray.err).toContain("expected an array of issues");
	});

	/**
	 * #548 — `--root` selects WHICH checkout every repo fact comes from. Before it, the only way to reach a
	 * scratch repo was to stub `io.probe`, so nothing here could be exercised through the CLI. Each probe below
	 * is able to fail: a root that silently resolved to a PARENT (what `git -C <subdir> rev-parse` answers) or
	 * to this checkout would print an unrelated verdict instead of the named fault.
	 */
	describe("--root selects the checkout, never a parent (#548)", () => {
		it("evaluates a foreign checkout, and the verdict names the resolved root", () => {
			const repo = scratchRepo();
			const dir = mkdtempSync(join(tmpdir(), "brl-handoff-root-"));
			const handoff = writeHandoff(dir, repo, { suite: "2 files / 40 tests", open: "#426, #450" });
			const report = join(dir, "suite.json");
			writeFileSync(report, JSON.stringify(suiteBody(2, 40)));

			const result = runCli(["--root", repo.dir, "--file", handoff, "--report", report, "--no-network"]);
			expect(result.code).toBe(EXIT.OK);
			// The counts are the SCRATCH checkout's, not this repo's: 2 modules and 1 ADR.
			expect(result.out).toContain("✓ 2 modules — docs-arch");
			expect(result.out).toContain("✓ 1 ADRs — docs-decisions");
			// Self-identifying: a run against another checkout says which tree it read.
			expect(result.out).toContain(`Running install: this repo (${realpathSync(repo.dir)})`);
		});

		it("names verified-drift when Verified is one non-handoff commit behind dev", () => {
			const repo = scratchRepo();
			// The fixture's own invariant, restated because this case leans on it: the handoff commit is the dev
			// tip and the CLAIM is the code commit, which is why an extra commit on top is drift and not a rebase.
			expect(repo.git("rev-parse", "dev").stdout.trim()).toBe(repo.handoffSha);
			expect(createRepoProbe(repo.dir).devClaimSha()).toBe(repo.code);
			const dir = mkdtempSync(join(tmpdir(), "brl-handoff-root-"));
			const handoff = writeHandoff(dir, repo, { suite: "2 files / 40 tests", open: "#426, #450" });
			const report = join(dir, "suite.json");
			writeFileSync(report, JSON.stringify(suiteBody(2, 40)));
			// A non-handoff commit AFTER the tree the STATE describes: `Verified` IS an ancestor of HEAD here, so
			// only the `Verified..dev` arm can fail — the two arms of check 1 are distinct findings.
			writeFileSync(join(repo.dir, "notes.md"), "later\n");
			repo.git("add", "-A");
			repo.git("commit", "-qm", "later: a foreign commit");
			const later = repo.git("rev-parse", "HEAD").stdout.trim();
			expect(later).not.toBe(repo.code);

			const result = runCli(["--root", repo.dir, "--file", handoff, "--report", report, "--no-network"]);
			expect(result.code).toBe(EXIT.DRIFT);
			const codes = failures(result).map((line) => /^✗ ([a-z-]+):/.exec(line)?.[1]);
			expect(codes).toEqual([CODES.verifiedDrift, CODES.devShaDrift, CODES.installShaDrift]);
			expect(failures(result)[0]).toContain("touching notes.md");
			expect(result.out).not.toContain(CODES.verifiedNotAncestor);
		});

		it("refuses a nested root instead of evaluating its parent", () => {
			const repo = scratchRepo();
			const result = runCli(["--root", join(repo.dir, "src"), "--no-network"]);
			expect(result.code).toBe(EXIT.USAGE);
			expect(result.err).toContain("not a git worktree top-level");
			// The parent it would have silently used is named, so the fault is diagnosable from the message alone.
			expect(result.err).toContain(`resolved root is ${realpathSync(repo.dir)}`);
		});

		it("refuses a directory that is not a git worktree", () => {
			const dir = mkdtempSync(join(tmpdir(), "brl-handoff-plain-"));
			const result = runCli(["--root", dir, "--no-network"]);
			expect(result.code).toBe(EXIT.USAGE);
			expect(result.err).toContain("not a git worktree top-level");
			expect(result.err).toContain("resolved root is none");
		});

		it("refuses a missing path, and a path that is not a directory", () => {
			const missing = runCli(["--root", join(tmpdir(), "no-such-brl-checkout-548"), "--no-network"]);
			expect(missing.code).toBe(EXIT.USAGE);
			expect(missing.err).toContain("not a directory");

			const dir = mkdtempSync(join(tmpdir(), "brl-handoff-file-"));
			const file = join(dir, "HANDOFF.md");
			writeFileSync(file, "## STATE\n");
			const notDir = runCli(["--root", file, "--no-network"]);
			expect(notDir.code).toBe(EXIT.USAGE);
			expect(notDir.err).toContain("not a directory");
		});

		it("accepts a relative root and a symlinked alias as the same checkout", () => {
			const repo = scratchRepo();
			const dir = mkdtempSync(join(tmpdir(), "brl-handoff-root-"));
			const handoff = writeHandoff(dir, repo, { suite: "2 files / 40 tests", open: "#426, #450" });
			const report = join(dir, "suite.json");
			writeFileSync(report, JSON.stringify(suiteBody(2, 40)));

			const argv = (root: string) => ["--root", root, "--file", handoff, "--report", report, "--no-network"];
			const absolute = runCli(argv(repo.dir));
			const rel = runCli(argv(relative(process.cwd(), repo.dir)));
			const link = join(mkdtempSync(join(tmpdir(), "brl-handoff-link-")), "alias");
			symlinkSync(repo.dir, link);
			const symlinked = runCli(argv(link));
			const canonical = realpathSync(repo.dir);
			for (const result of [absolute, rel, symlinked]) {
				expect(result.code).toBe(EXIT.OK);
				// Canonicalised both sides: `resolve()` alone keeps the symlink and would print the alias.
				expect(result.out).toContain(`this repo (${canonical})`);
			}
			expect(rel.out).toBe(absolute.out);
			expect(symlinked.out).toBe(absolute.out);
		});

		it("counts the scratch checkout's own modules and ADRs, which is what a root-blind probe could not", () => {
			const repo = scratchRepo();
			expect(collectModules(repo.dir)).toHaveLength(2);
			expect(collectDecisions(repo.dir)).toHaveLength(1);
			// The live counts differ deliberately: a probe that ignored the root would still report these.
			expect(collectModules().length).not.toBe(2);
			expect(collectDecisions().length).not.toBe(1);
		});
	});

	it("declares its residual scope in its own output", () => {
		// #607 replaced the narrative-claims scope with the residual one: the index is checked for SHAPE, and
		// a bounded line can still hold a sentence. The declaration is printed, so the reader knows what a
		// green run does not promise.
		const result = run(["--file", correctIndex(), "--no-network"]);
		expect(result.out).toContain("out of scope by design: the MEANING of the index's prose");
		expect(result.out).toContain("a bounded line can still hold a sentence");
		expect(result.out).toContain("a page is opened on demand");
		// stdout stays JSON under --json, so the declaration moves to stderr instead of vanishing.
		const json = run(["--file", correctIndex(), "--no-network", "--json"]);
		expect(() => JSON.parse(json.out)).not.toThrow();
		expect(json.err).toContain("out of scope by design: the MEANING of the index's prose");
	});
});

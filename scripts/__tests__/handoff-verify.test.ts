/**
 * Tests for `scripts/handoff-verify.mjs` (issue #495) — one command that diffs the handoff STATE's
 * mechanical claims against the repo.
 *
 * The tool exists because every reconciliation at U1 was mechanical: a stale suite count, a closed issue
 * still in `Open:`, a stale dev sha. Prose cannot hold a number, so the number is checked. This file pins
 * the four things that make that safe:
 *
 * 1. the PARSER reads the STATE's fixed shapes — and only those: a historical shape (`**2,006 → 353**`,
 *    `(1,429)`), a quoted field name ("the `Open:` list") and the `PR #402` non-issue are all *not*
 *    claims. The real `.development/HANDOFF.md` is parsed as the anti-rot case;
 * 2. the VERDICT names one code per drift, and every fixture in `fixtures/handoffs/` fails with its own
 *    code and exit 1 — three of them are the shapes that drifted in the wild at U1;
 * 3. the SEAMS hold: the git range (`Verified..dev`, renames included), the vitest report reader and the
 *    injected issue list are exercised for real in a throwaway repo, while `gh` and the network are
 *    replaced by a plain object, so the suite needs neither;
 * 4. a SKIP is said out loud (`--no-network`), never silently counted as a pass.
 *
 * The fixtures are `.md` (and one `.json` report) under `fixtures/handoffs/` — invisible to the `scripts`
 * surface's LOC ceiling, and grep-able when a shape costs a handover.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createRepoProbe, EXIT, findNewestReport, main, parseArgs, parseRangeLog, readIssues, readSuiteReport, resolveModulePath, ROOT } from "../handoff-verify.mjs";
import {
	CODES,
	InputError,
	evaluate,
	isHandoffOwnCommit,
	isHandoffOwnPath,
	parseClaims,
	sameRevision,
	stateSection,
} from "../lib/handoff-claims.mjs";

const FIXTURES = join(ROOT, "scripts", "__tests__", "fixtures", "handoffs");
const REPORT = join(FIXTURES, "suite-report.json");
const DEV = "4c1d9ab2f1e0c3d4e5f60718293a4b5c6d7e8f90";
const HEAD = "8e7f6a5c4b3a2918171615141312111009080706";
const MISSING_PATH = "/no/such/brl-checkout";

/** The fixture line counts the stubbed probe reports; anything else is a missing file. */
const SIZES: Record<string, { path: string; lines: number }> = {
	"alpha.ts": { path: "/repo/src/alpha.ts", lines: 10 },
	"beta.ts": { path: "/repo/src/beta.ts", lines: 3 },
};

/**
 * The repo side of every check, stubbed: no git, no `gh`, no network, no real report. `correct.md`'s
 * claims are exactly these facts, which is why the fixture is a contract rather than a sample.
 */
function stub(overrides: Record<string, unknown> = {}) {
	return {
		root: "/repo",
		headSha: () => HEAD,
		devSha: () => DEV,
		isAncestor: (sha: string) => DEV.startsWith(sha),
		commitsAfter: () => [],
		exists: (path: string) => path !== MISSING_PATH,
		lineCount: (name: string) => SIZES[name] ?? null,
		modules: () => 58,
		adrs: () => 27,
		openIssues: () => [426, 450],
		report: () => ({ path: REPORT, files: 2, tests: 12 }),
		...overrides,
	};
}

function text(name: string): string {
	return readFileSync(join(FIXTURES, `${name}.md`), "utf8");
}

function claimsOf(name: string) {
	return parseClaims(text(name));
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
		expect(claims.verified).toEqual({ sha: "4c1d9ab" });
		expect(claims.dev).toEqual({ sha: "4c1d9ab" });
		expect(claims.install?.sha).toBe("4c1d9ab");
		expect(claims.install?.path).toEqual({ kind: "repo" });
		expect(claims.open).toEqual([426, 450]);
		expect(claims.suite).toEqual({ files: 2, tests: 12 });
		expect(claims.modules).toBe(58);
		expect(claims.adrs).toBe(27);
		expect(claims.sizes).toEqual([
			{ name: "alpha.ts", lines: 10 },
			{ name: "beta.ts", lines: 3 },
		]);
	});

	it("parses the real handoff — the anti-rot case", () => {
		const claims = parseClaims(readFileSync(join(ROOT, ".development", "HANDOFF.md"), "utf8"));
		expect(claims.state).not.toBeNull();
		expect(claims.verified?.sha).toMatch(/^[0-9a-f]{7,40}$/);
		expect(claims.dev?.sha).toMatch(/^[0-9a-f]{7,40}$/);
		expect(claims.install).not.toBeNull();
		expect(claims.open?.length).toBeGreaterThan(0);
		expect(claims.suite?.files).toBeGreaterThan(0);
		expect(claims.suite?.tests).toBeGreaterThan(0);
		expect(claims.modules).toBeGreaterThan(0);
		expect(claims.adrs).toBeGreaterThan(0);
		expect(claims.sizes.length).toBeGreaterThan(0);
		// Every size claim names a file this checkout really has, resolved the way the check resolves it.
		for (const size of claims.sizes) expect(resolveModulePath(ROOT, size.name)).not.toBeNull();
	});

	it("never reads a historical shape as a current size claim", () => {
		const claims = claimsOf("correct");
		const names = claims.sizes.map((size: { name: string }) => size.name);
		// `alpha.ts` **20 → 10** and `beta.ts` (9) live in `### Since the last handover`, and only the
		// current size (`10`, `3`) is a claim.
		expect(claims.sizes).toEqual([
			{ name: "alpha.ts", lines: 10 },
			{ name: "beta.ts", lines: 3 },
		]);
		expect(names).toHaveLength(2);
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

	it("stops the STATE section at the next level-2 heading", () => {
		const section = stateSection(text("correct"));
		expect(section).toContain("Verified:");
		expect(section).not.toContain("## Open items");
		expect(stateSection("# Handoff\n\ntext only\n")).toBeNull();
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
		return evaluate(claimsOf(name), probe, options);
	}

	it("holds on the correct fixture", () => {
		const { results, drifts } = verdicts("correct");
		expect(drifts).toEqual([]);
		expect(results.every((result: { ok: boolean }) => result.ok)).toBe(true);
		// verified, dev, install, open, suite, modules, adrs, then the two size claims.
		expect(results).toHaveLength(9);
	});

	it("names verified-not-ancestor for a commit HEAD does not contain", () => {
		const { drifts } = verdicts("verified-not-ancestor");
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.verifiedNotAncestor]);
	});

	it("tolerates a commit that touches only the handoff and its archives", () => {
		const probe = stub({
			commitsAfter: () => [
				{ sha: "1111111", paths: [".development/HANDOFF.md"] },
				{ sha: "2222222", paths: [".development/HANDOFF-ARCHIVE-2026-11-08.md"] },
			],
		});
		expect(verdicts("correct", probe).drifts).toEqual([]);
	});

	it("names verified-drift when a commit after Verified touches anything else", () => {
		const probe = stub({ commitsAfter: () => [{ sha: "3333333aaaa", paths: ["src/index.ts"] }] });
		const { drifts } = verdicts("correct", probe);
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.verifiedDrift]);
		expect(drifts[0].claim).toBe("Verified: 4c1d9ab");
		expect(drifts[0].actual).toBe("1 such commit(s)");
	});

	it("treats a commit with no path list as drift, never as handoff-only", () => {
		// The extension's rule: an empty list is also what a failed diff looks like.
		expect(isHandoffOwnCommit({ sha: "4444444", paths: [] })).toBe(false);
		const probe = stub({ commitsAfter: () => [{ sha: "4444444bbb", paths: [] }] });
		expect(verdicts("correct", probe).drifts.map((drift) => drift.code)).toEqual([CODES.verifiedDrift]);
	});

	it("names the two handoff paths and nothing else", () => {
		expect(isHandoffOwnPath(".development/HANDOFF.md")).toBe(true);
		expect(isHandoffOwnPath(".development/HANDOFF-ARCHIVE-2026-11-08.md")).toBe(true);
		expect(isHandoffOwnPath(".development/HANDOFF.md ")).toBe(false);
		expect(isHandoffOwnPath("src/index.ts")).toBe(false);
	});

	it("names dev-sha-drift for a dev line from another day", () => {
		const { drifts } = verdicts("dev-sha-drift");
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.devShaDrift]);
		expect(drifts[0].expected).toBe(DEV);
		expect(drifts[0].actual).toBe("deadbee1");
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
		expect(drifts.map((drift) => drift.code)).toEqual([CODES.fileMissing, CODES.fileMissing]);
	});

	it("names modules-drift and adrs-drift against the repo's own counters", () => {
		const probe = stub({ modules: () => 59, adrs: () => 28 });
		expect(verdicts("correct", probe).drifts.map((drift) => drift.code)).toEqual([CODES.modulesDrift, CODES.adrsDrift]);
	});

	it("names a missing claim instead of passing silently", () => {
		const cases: [string, string][] = [
			["Verified: 4c1d9ab", CODES.verifiedMissing],
			["**dev** @ `4c1d9ab`", CODES.devClaimMissing],
			["Running install:", CODES.installClaimMissing],
			["Open: **#426**, **#450**", CODES.openClaimMissing],
			["Suite:", CODES.suiteClaimMissing],
			["**58 modules**, ", CODES.modulesMissing],
			["**27 ADRs**", CODES.adrsMissing],
		];
		for (const [needle, code] of cases) {
			const { drifts } = evaluate(parseClaims(without(needle)), stub());
			expect(drifts.map((drift) => drift.code)).toEqual([code]);
		}
	});

	it("skips the open set under --no-network without touching the board", () => {
		const probe = stub({
			openIssues: () => {
				throw new Error("the board must not be read under --no-network");
			},
		});
		const { results, drifts } = evaluate(claimsOf("correct"), probe, { noNetwork: true });
		expect(drifts).toEqual([]);
		const skipped = results.filter((result: { skipped: boolean }) => result.skipped);
		expect(skipped).toHaveLength(1);
		expect(skipped[0].line).toContain("skipped (--no-network");
	});

	it("runs the open-set check when --issues injects the board, whatever --no-network says", () => {
		const probe = stub({ openIssues: () => [426, 450] });
		const { results } = evaluate(claimsOf("correct"), probe, { noNetwork: true, issuesInjected: true });
		expect(results.filter((result: { skipped: boolean }) => result.skipped)).toHaveLength(0);
	});
});

describe("handoff-verify — the command", () => {
	const drifting: [string, string][] = [
		["dev-sha-drift", CODES.devShaDrift],
		["open-set-drift", CODES.openSetDrift],
		["suite-count-drift", CODES.suiteCountDrift],
		["file-size-drift", CODES.fileSizeDrift],
		["verified-not-ancestor", CODES.verifiedNotAncestor],
		["install-missing", CODES.installMissing],
	];

	it("exits 0 and prints one ✓ per claim on the correct fixture", () => {
		const result = run(["--file", join(FIXTURES, "correct.md")]);
		expect(result.code).toBe(EXIT.OK);
		expect(result.out.split("\n").filter((line) => line.startsWith("✓"))).toHaveLength(9);
		expect(result.out.split("\n").filter((line) => line.startsWith("✗"))).toHaveLength(0);
		expect(result.out.split("\n").at(-1)).toBe("handoff-verify: 0 drift(s)");
	});

	it("emits `{ok, drifts}` under --json", () => {
		const result = run(["--file", join(FIXTURES, "correct.md"), "--json"]);
		expect(result.code).toBe(EXIT.OK);
		expect(JSON.parse(result.out)).toEqual({ ok: true, drifts: [] });
	});

	for (const [name, code] of drifting) {
		it(`fails ${name}.md with ${code} and exit 1`, () => {
			const result = run(["--file", join(FIXTURES, `${name}.md`)]);
			expect(result.code).toBe(EXIT.DRIFT);
			const failures = result.out.split("\n").filter((line) => line.startsWith("✗"));
			expect(failures).toHaveLength(1);
			expect(failures[0].startsWith(`✗ ${code}: `)).toBe(true);
			expect(result.out.split("\n").at(-1)).toBe("handoff-verify: 1 drift(s)");
		});

		it(`reports ${name}.md as structured drift under --json`, () => {
			const result = run(["--file", join(FIXTURES, `${name}.md`), "--json"]);
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
		const result = run(["--file", join(FIXTURES, "correct.md"), "--no-network"]);
		expect(result.code).toBe(EXIT.OK);
		expect(result.out).toContain(`- Open: #426, #450 — skipped (--no-network:`);
		expect(result.out.split("\n").at(-1)).toBe("handoff-verify: 0 drift(s)");
	});

	it("keeps the skip notice off stdout under --json, so the machine reads JSON", () => {
		const result = run(["--file", join(FIXTURES, "correct.md"), "--no-network", "--json"]);
		expect(() => JSON.parse(result.out)).not.toThrow();
		expect(result.err).toContain("skipped (--no-network:");
	});

	it("is deterministic, and reports in document order", () => {
		const argv = ["--file", join(FIXTURES, "file-size-drift.md"), "--no-network"];
		expect(run(argv).out).toBe(run(argv).out);
		// Order is fixed by the CHECK, never by the map iteration or the filesystem.
		const probe = stub({ devSha: () => "deadbee1c0ffee", modules: () => 59, adrs: () => 28 });
		const { drifts } = evaluate(claimsOf("correct"), probe, { noNetwork: true });
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
		const noReport = run(["--file", join(FIXTURES, "correct.md")], stub({ report: () => null }));
		expect(noReport.code).toBe(EXIT.USAGE);
		expect(noReport.err).toContain("vitest JSON report");
		const noIssues = run(
			["--file", join(FIXTURES, "correct.md")],
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
		expect(parseArgs(["--file", "a.md", "--report", "r.json", "--issues", "i.json", "--no-network", "--json"])).toEqual({
			ok: true,
			options: { file: "a.md", report: "r.json", issues: "i.json", noNetwork: true, json: true },
		});
		expect(parseArgs([]).ok).toBe(true);
		expect(parseArgs(["--json", "--json"]).ok).toBe(true);
	});
});

describe("handoff-verify — the seams", () => {
	it("reads a vitest report: one count per file, and the PASSED tests", () => {
		expect(readSuiteReport(REPORT)).toEqual({ path: REPORT, files: 2, tests: 12 });
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-verify-"));
		const broken = join(dir, "broken.json");
		writeFileSync(broken, "{ not json");
		expect(() => readSuiteReport(broken)).toThrow(InputError);
		const notReport = join(dir, "vitest-config.json");
		writeFileSync(notReport, JSON.stringify({ testResults: [] }));
		expect(() => readSuiteReport(notReport)).toThrow(/no testResults/);
	});

	it("finds the newest report that IS a vitest report", () => {
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-verify-"));
		const older = join(dir, "vitest-older.json");
		const newer = join(dir, "unrelated.json");
		writeFileSync(older, readFileSync(REPORT, "utf8"));
		writeFileSync(newer, JSON.stringify({ hello: "world" }));
		utimesSync(older, new Date(1000), new Date(1000));
		utimesSync(newer, new Date(2000), new Date(2000));
		expect(findNewestReport(dir)?.path).toBe(older);
	});

	it("reads an injected issue list, numbers or objects", () => {
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-verify-"));
		const file = join(dir, "issues.json");
		writeFileSync(file, JSON.stringify([{ number: 426 }, { number: 450 }]));
		expect(readIssues({ root: dir, issuesPath: file })).toEqual([426, 450]);
		writeFileSync(file, JSON.stringify([450, 426]));
		expect(readIssues({ root: dir, issuesPath: file })).toEqual([450, 426]);
		writeFileSync(file, JSON.stringify({ not: "an array" }));
		expect(() => readIssues({ root: dir, issuesPath: file })).toThrow(InputError);
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
		git("add", ".");
		git("commit", "-qm", "first");
		const base = git("rev-parse", "HEAD").stdout.trim();
		mkdirSync(join(dir, ".development"), { recursive: true });
		writeFileSync(join(dir, ".development", "HANDOFF.md"), "state\n");
		git("add", ".");
		git("commit", "-qm", "handoff");
		const handoffSha = git("rev-parse", "HEAD").stdout.trim();

		const probe = createRepoProbe(dir, { reportPath: REPORT });
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
		const verified = parseClaims(text("correct").replace("4c1d9ab (2026-11-08)", `${base} (2026-11-08)`));
		const { drifts } = evaluate(verified, probe, { noNetwork: true });
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

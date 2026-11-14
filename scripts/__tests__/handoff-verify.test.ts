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
 * 3. the SEAMS hold: the git range (`Verified..dev`, renames included), the report resolution and the
 *    injected issue list are exercised for real in a throwaway repo, while `gh` and the network are
 *    replaced by a plain object, so the suite needs neither. The report reader itself lives in
 *    `scripts/lib/suite-report.mjs` (#513) and is pinned by `suite-report.test.ts`; this file pins the
 *    fact that this tool keeps no second definition of it — and (#520) that the handoff's `Verified:`
 *    sha is what reaches that resolver, because the lazily-resolved report is the half that was missing;
 * 4. a SKIP is said out loud (`--no-network`), never silently counted as a pass.
 *
 * The fixtures are `.md` (and one `.json` report) under `fixtures/handoffs/` — invisible to the `scripts`
 * surface's LOC ceiling, and grep-able when a shape costs a handover.
 *
 * COVERAGE — what these probes do NOT cover, stated rather than implied: a report MUTATED between the
 * read that validated it and the read that uses it (the tool consumes the validated snapshot and never
 * re-opens the path), and non-Linux hosts (the private root's `tmpfs` clause is Linux-only, so a root
 * that Linux refuses may be accepted where the mount type cannot be read).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createRepoProbe, EXIT, main, parseArgs, parseRangeLog, readIssues, resolveModulePath, ROOT } from "../handoff-verify.mjs";
import { LABELS, readSuiteReport } from "../lib/suite-report.mjs";
import { collectDecisions } from "../docs-decisions.mjs";
import { collectModules } from "../docs-arch.mjs";
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
 *
 * `devClaimSha` FOLLOWS `devSha` unless a test states it separately: in the repo the claim is derived from
 * the ref (`resolveDevClaim`), so a stub that moved one and not the other would be a repo that cannot exist.
 */
function stub(overrides: Record<string, unknown> = {}) {
	const probe = {
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
	return { ...probe, devClaimSha: overrides.devClaimSha ?? probe.devSha };
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
		expect(claims.dev).toEqual(["4c1d9ab"]);
		expect(claims.install?.sha).toBe("4c1d9ab");
		expect(claims.install?.path).toEqual({ kind: "repo" });
		expect(claims.open).toEqual([426, 450]);
		expect(claims.suite).toEqual({ files: 2, tests: 12 });
		expect(claims.modules).toEqual([58]);
		expect(claims.adrs).toEqual([27]);
		expect(claims.sizes).toEqual([
			{ name: "alpha.ts", lines: 10 },
			{ name: "beta.ts", lines: 3 },
		]);
	});

	it("parses the real handoff — the anti-rot case", () => {
		const claims = parseClaims(readFileSync(join(ROOT, ".development", "HANDOFF.md"), "utf8"));
		expect(claims.state).not.toBeNull();
		expect(claims.verified?.sha).toMatch(/^[0-9a-f]{7,40}$/);
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
		// 5+/2− live in `### Since the last handover`, and only the current size (`10`, `3`) is a claim.
		expect(claims.sizes).toEqual([
			{ name: "alpha.ts", lines: 10 },
			{ name: "beta.ts", lines: 3 },
		]);
		expect(names).toHaveLength(2);
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

	it("still drifts on a present claim stated with `is`", () => {
		const present = parseClaims(text("correct").replace("`alpha.ts` is **10**", "`alpha.ts` is 2,249"));
		expect(present.sizes).toContainEqual({ name: "alpha.ts", lines: 2249 });
		const { drifts } = evaluate(present, stub());
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

	it("passes a duplicate dev line that agrees and names the one that disagrees", () => {
		// The crafted STATE the review used: `4c1d9ab` then `deadbee1`. First-wins parsed the good line and
		// reported only an unrelated drift, which is why the second value has to be checked.
		const dupe = (name: string, from: string, to: string) => parseClaims(text(name).replace(from, to));
		const agreeing = evaluate(dupe("correct", "- **dev** @ `4c1d9ab`.", "- **dev** @ `4c1d9ab`.\n- **dev** @ `4c1d9ab`."), stub());
		expect(agreeing.drifts).toEqual([]);
		const disagreeing = evaluate(dupe("correct", "- **dev** @ `4c1d9ab`.", "- **dev** @ `4c1d9ab`.\n- **dev** @ `deadbee1`."), stub());
		expect(disagreeing.drifts.map((drift) => drift.code)).toEqual([CODES.devShaDrift]);
		expect(disagreeing.drifts[0].expected).toBe(DEV);
		expect(disagreeing.drifts[0].actual).toBe("deadbee1");
		expect(disagreeing.results.find((result: { ok: boolean }) => !result.ok).line).toContain("states 4c1d9ab and deadbee1");
	});

	it("treats a repeated modules/ADRs count the same way: agreeing is no drift, disagreeing is named", () => {
		const withExtra = (extra: string) => parseClaims(text("correct").replace("**58 modules**, **27 ADRs**", `**58 modules**, **27 ADRs**, ${extra}`));
		expect(evaluate(withExtra("**58 modules**"), stub()).drifts).toEqual([]);
		expect(evaluate(withExtra("**27 ADRs**"), stub()).drifts).toEqual([]);
		const modules = evaluate(withExtra("**59 modules**"), stub()).drifts;
		expect(modules.map((drift) => drift.code)).toEqual([CODES.modulesDrift]);
		expect(modules[0].actual).toBe("59");
		const adrs = evaluate(withExtra("**28 ADRs**"), stub()).drifts;
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
		expect(
			parseArgs(["--file", "a.md", "--report", "r.json", "--report-dir", "d", "--issues", "i.json", "--no-network", "--json"]),
		).toEqual({
			ok: true,
			options: { file: "a.md", report: "r.json", reportDir: "d", issues: "i.json", noNetwork: true, json: true },
		});
		expect(parseArgs([]).ok).toBe(true);
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
		const result = run(["--file", join(FIXTURES, "correct.md"), "--no-network"], stub({ report: () => probe.report() }));
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
				return { path: REPORT, files: 2, tests: 12 };
			},
		});
		const result = run(["--file", join(FIXTURES, "correct.md"), "--no-network"], probe);
		expect(result.code).toBe(EXIT.OK);
		expect(seen).toEqual(["4c1d9ab"]);
	});

	it("carries the report's provenance in the suite line", () => {
		const dirty = run(["--file", join(FIXTURES, "correct.md"), "--no-network"], stub({ report: () => ({ path: REPORT, files: 2, tests: 12, label: LABELS.DIRTY }) }));
		expect(dirty.out).toContain(LABELS.DIRTY);
		const clean = run(["--file", join(FIXTURES, "correct.md"), "--no-network"]);
		// The stub without a label prints no parenthesised claim rather than "undefined".
		expect(clean.out).not.toContain("undefined");
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
		expect(evaluate(claimsAt(devClaim), probe).drifts).toEqual([]);
	});

	it("still names dev-sha-drift when a code commit lands on top — the rule swallows no real drift", () => {
		const { dir, git, devClaim, handoff } = scratch();
		writeFileSync(join(dir, "later.ts"), "export {};\n");
		git("add", ".");
		git("commit", "-qm", "code after the handoff");
		const tip = git("rev-parse", "HEAD").stdout.trim();
		const probe = probeFor(dir, () => [{ sha: handoff, paths: [".development/HANDOFF.md"] }]);
		expect(probe.devClaimSha()).toBe(tip);
		const { drifts, results } = evaluate(claimsAt(devClaim), probe);
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
		const { drifts, results } = evaluate(claims, probe);
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

	// CI checks out a single ref: `dev` may not exist as a local branch there, and every CLI run resolves it.
	// Create it once at HEAD when absent (a no-op in the cockpit and in any worktree, where `dev` exists).
	beforeAll(() => {
		const has = spawnSync("git", ["-C", ROOT, "rev-parse", "--verify", "--quiet", "dev"], { encoding: "utf8" });
		if (has.status !== 0) spawnSync("git", ["-C", ROOT, "branch", "dev", "HEAD"], { encoding: "utf8" });
	});

	function runCli(argv: string[], env: Record<string, string> = {}): Run {
		const result = spawnSync(process.execPath, [SCRIPT, ...argv], { encoding: "utf8", env: { ...process.env, ...env } });
		return { code: result.status ?? -1, out: result.stdout ?? "", err: result.stderr ?? "" };
	}

	/**
	 * A handoff that is TRUE of THIS checkout — the live dev tip and the counts the repo's own generators
	 * report — so the only drift a CLI run can print is the one a test injects. A fixture would drift on its
	 * own stale values and the assertion could not tell the injected fact from them.
	 */
	function liveHandoff({ suite, open }: { suite: string; open: string }): string {
		// The dev CLAIM, not the raw ref: the convention is that the claim names the last non-handoff commit
		// (#497), so a handoff commit sitting on `dev` must not make this fixture drift on its own.
		const dev = createRepoProbe(ROOT).devClaimSha();
		const modules = collectModules().length;
		const adrs = collectDecisions().length;
		return [
			"## STATE",
			`Verified: ${dev} (2026-11-08)`,
			"Cycle: fixture cycle.",
			"",
			`- **dev** @ \`${dev}\`. The live dev tip.`,
			`- **Released:** nothing. Running install: **local-path dev checkout** (this repo, \`dev @ ${dev}\`).`,
			`- **Board:** Open: ${open}, PR #402 held.`,
			`- **Suite:** ${suite} green on dev; docs guards current (**${modules} modules**, **${adrs} ADRs**).`,
		].join("\n");
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
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-cli-"));
		const injected = join(dir, "injected.json");
		// 3 files / 7 tests — nothing under the scanned directory looks like this, which is the point.
		writeFileSync(injected, JSON.stringify(suiteBody(3, 7)));
		// A report at the scanned location with DIFFERENT counts: the value `--report` would lose to if the
		// two were not explicitly ordered. No mtime is involved — --report simply wins.
		const scanned = join(dir, "scanned");
		mkdirSync(scanned);
		writeFileSync(join(scanned, "planted.json"), JSON.stringify(suiteBody(11, 99)));
		const handoff = join(dir, "HANDOFF.md");
		writeFileSync(handoff, liveHandoff({ suite: "2 files / 40 tests", open: "#426, #450" }));
		const result = runCli(["--file", handoff, "--report", injected, "--report-dir", scanned, "--no-network"]);
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
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-cli-"));
		const reports = join(dir, "reports");
		mkdirSync(reports);
		writeFileSync(join(reports, "a.json"), JSON.stringify(suiteBody(2, 40)));
		writeFileSync(join(reports, "b.json"), JSON.stringify(suiteBody(2, 40)));
		const handoff = join(dir, "HANDOFF.md");
		writeFileSync(handoff, liveHandoff({ suite: "2 files / 40 tests", open: "#426, #450" }));
		const result = runCli(["--file", handoff, "--report-dir", reports, "--no-network"]);
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
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-verified-"));
		const reports = join(dir, "reports");
		mkdirSync(reports);
		const head = createRepoProbe(ROOT).devClaimSha();
		const other = "0123456789abcdef0123456789abcdef01234567";
		// The report of ANOTHER tree carries counts that would drift; the report of the verified tree matches.
		const stale = join(reports, `${other}.json`);
		writeFileSync(stale, JSON.stringify(suiteBody(11, 99)));
		writeFileSync(`${stale}.provenance.json`, JSON.stringify({ head: other, dirty: false, capturedAt: "2026-11-08T00:00:00.000Z" }));
		const mine = join(reports, `${head}.json`);
		writeFileSync(mine, JSON.stringify(suiteBody(2, 40)));
		writeFileSync(`${mine}.provenance.json`, JSON.stringify({ head, dirty: false, capturedAt: "2026-11-08T00:00:01.000Z" }));
		const handoff = join(dir, "HANDOFF.md");
		writeFileSync(handoff, liveHandoff({ suite: "2 files / 40 tests", open: "#426, #450" }));
		const result = runCli(["--file", handoff, "--report-dir", reports, "--no-network"]);
		expect(result.err).not.toContain("ambiguous-reports");
		expect(result.out).toContain(`head ${head}`);
		expect(result.code).toBe(EXIT.OK);
	});

	/**
	 * Two marked reports of the SAME head are a duplicate, not a tie: `--capture` cannot produce this (one
	 * file per head), so it is a hand-copied report — and the message has to say which shape it is, because
	 * "pass --report" is the wrong instruction for two files that describe one tree.
	 */
	it("names a duplicate copy of one head instead of calling it a tie (#520)", () => {
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-dupe-"));
		const reports = join(dir, "reports");
		mkdirSync(reports);
		const head = createRepoProbe(ROOT).devClaimSha();
		for (const name of ["copy.json", `${head}.json`]) {
			const path = join(reports, name);
			writeFileSync(path, JSON.stringify(suiteBody(2, 40)));
			writeFileSync(`${path}.provenance.json`, JSON.stringify({ head, dirty: false, capturedAt: "2026-11-08T00:00:00.000Z" }));
		}
		const handoff = join(dir, "HANDOFF.md");
		writeFileSync(handoff, liveHandoff({ suite: "2 files / 40 tests", open: "#426, #450" }));
		const result = runCli(["--file", handoff, "--report-dir", reports, "--no-network"]);
		expect(result.code).toBe(EXIT.USAGE);
		expect(result.err).toContain("ambiguous-reports");
		expect(result.err).toContain(`SAME head ${head}`);
		expect(result.err).toContain("duplicate copy");
	});

	it("honours --issues without ever invoking gh, and fails with the INJECTED board", () => {
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
		const handoff = join(dir, "HANDOFF.md");
		writeFileSync(handoff, liveHandoff({ suite: "2 files / 40 tests", open: "#426, #450" }));

		const result = runCli(["--file", handoff, "--report", report, "--issues", issues], { PATH: `${bin}:${process.env.PATH ?? ""}` });
		expect(existsSync(marker)).toBe(false);
		expect(result.code).toBe(EXIT.DRIFT);
		expect(failures(result)).toHaveLength(1);
		expect(failures(result)[0]).toContain(CODES.openSetDrift);
		expect(failures(result)[0]).toContain("#777, #778");
	});

	it("exits 2 on a malformed --report or --issues, never 1", () => {
		const dir = mkdtempSync(join(tmpdir(), "brl-handoff-cli-"));
		const handoff = join(dir, "HANDOFF.md");
		writeFileSync(handoff, liveHandoff({ suite: "2 files / 40 tests", open: "#426, #450" }));
		const garbage = join(dir, "garbage.json");
		writeFileSync(garbage, "{ not json");

		const report = runCli(["--file", handoff, "--report", garbage, "--no-network"]);
		expect(report.code).toBe(EXIT.USAGE);
		expect(report.err).toContain("not JSON");

		const missing = runCli(["--file", handoff, "--issues", join(dir, "no-such-issues.json")]);
		expect(missing.code).toBe(EXIT.USAGE);
		expect(missing.err).toContain("cannot read the issue list");

		const shape = join(dir, "issues.json");
		writeFileSync(shape, JSON.stringify({ number: 495 }));
		const notArray = runCli(["--file", handoff, "--issues", shape]);
		expect(notArray.code).toBe(EXIT.USAGE);
		expect(notArray.err).toContain("expected an array of issues");
	});

	it("declares the narrative claims out of scope in its own output", () => {
		const result = run(["--file", join(FIXTURES, "correct.md"), "--no-network"]);
		expect(result.out).toContain("out of scope by design: narrative claims");
		expect(result.out).toContain("cycle queue");
		expect(result.out).toContain("would fail closed on a legitimate rewrite");
		// stdout stays JSON under --json, so the declaration moves to stderr instead of vanishing.
		const json = run(["--file", join(FIXTURES, "correct.md"), "--no-network", "--json"]);
		expect(() => JSON.parse(json.out)).not.toThrow();
		expect(json.err).toContain("out of scope by design: narrative claims");
	});
});

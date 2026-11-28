/**
 * Tests for the test-budget guard (issues #368, #490, and the policy-v2 unit) — the executable half of
 * the two-surface rule.
 *
 * Five layers, each killing a specific mutant:
 *
 * 1. measurement (`measureSurface`, `countLines`) — a `__tests__` path segment classifies a file as
 *    a test, never the extension, because on the `scripts` surface tests are `.ts` and sources are
 *    `.mjs`. Fixtures include a `.d.mts` (neither surface) and a non-`__tests__` `.ts` on the
 *    scripts surface (neither surface) so a classifier that keys off the extension alone fails here.
 * 2. the ratio report (`evaluate`) — the ratio produces a WARNING, never a finding (policy v2), the
 *    band is non-failing, and the wall ceiling is still a finding.
 * 3. the FLOOR (`measureFloor`) — reachability, not a direct import: a module reached only through
 *    another module a test imports is covered; a comment, a string, `import type … from`, `export
 *    type … from` and `export … from` are not edges. Each of those is its own fixture, because each
 *    one used to satisfy the old floor or would satisfy a naive one.
 * 4. the FLOW rule (`main --flow`, in a throwaway git repo) — net deltas, the per-surface allowance,
 *    the two accepted limits (+120 per test-only PR, replacement measures zero) and the three
 *    fail-closed exits (unknown head, already-merged, usage).
 * 5. the two CLI contracts (`main`, plus one real spawn) — exit 0 within / 1 a floor or wall finding
 *    / 2 usage or unreadable input, output identical between runs.
 *
 * Fixtures are written to a temp directory, never into `scripts/__tests__/`: a fixture counted as a
 * test line would inflate the very ratio this guard reports (and the `scripts` reference is 1.0).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	FLOOR,
	SURFACES,
	WALL_CEILING_MS,
	countLines,
	evaluate,
	findTestBudgetDeclaration,
	formatSurface,
	importSpecifiers,
	main,
	measureFloor,
	measureFloors,
	measureSurface,
	parseArgs,
	parseFlowArgs,
	readWallMs,
	reachabilitySpecifiers,
} from "../check-test-budget.mjs";
import { computeFlow, formatFlowLine } from "../lib/test-budget-flow.mjs";

const ROOT = process.cwd();
const SCRIPT = join(ROOT, "scripts", "check-test-budget.mjs");
const TMP = mkdtempSync(join(tmpdir(), "brl-budget-"));

afterAll(() => {
	rmSync(TMP, { recursive: true, force: true });
});

/** A surface definition by name — the tests name surfaces, never their index. */
function surface(name: string) {
	const found = SURFACES.find((entry: { name: string }) => entry.name === name);
	if (!found) throw new Error(`no "${name}" surface in SURFACES`);
	return found;
}

/** Write `files` under a fresh fixture root. A number writes that many fixture lines; an array
 *  writes its lines verbatim (so a fixture can hold a real import statement). Every root also gets
 *  the `skills` surface's one stub script: the third surface is measured on EVERY report, so a root
 *  without `.pi/skills/worktree` would read as a `cannot read the tree` fault (#558). */
function tree(name: string, files: Record<string, number | string[]>): string {
	const root = join(TMP, name);
	for (const [path, content] of Object.entries({ ".pi/skills/worktree/probe.sh": 5, ...files })) {
		const full = join(root, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, Array.isArray(content) ? `${content.join("\n")}\n` : "// fixture\n".repeat(content));
	}
	return root;
}

/** An import plus filler: an exact line count whose first line is a real module request. */
function importerOf(path: string, lines: number): string[] {
	return [`import { value } from "${path}";`, ...Array.from({ length: lines - 1 }, () => "// filler")];
}

/** A `scripts/__tests__` file that imports the fixture guard — the floor's edge, plus filler lines. */
function importer(lines: number): string[] {
	return importerOf("../guard.mjs", lines);
}

/** A vitest-shaped report whose run lasted `wallMs`, written to a temp path. */
function report(name: string, wallMs: number): string {
	mkdirSync(join(TMP, "reports"), { recursive: true });
	const path = join(TMP, "reports", `${name}.json`);
	writeFileSync(path, JSON.stringify({ startTime: 0, testResults: [{ endTime: wallMs }] }));
	return path;
}

/** `main` with captured output — the guard's whole contract is its exit code and its two streams. */
function run(argv: string[], root: string) {
	const out: string[] = [];
	const err: string[] = [];
	const code = main(argv, { root, out: (line: string) => out.push(line), err: (line: string) => err.push(line) });
	return { code, out, err };
}

/** The single `src` surface line's ratio, read back from the guard's own output. */
function ratioIn(lines: string[], name: string): number {
	const line = lines.find((entry) => entry.startsWith(`test-budget: ${name} `));
	if (line === undefined) throw new Error(`no ${name} line in:\n${lines.join("\n")}`);
	return Number(/(\d+\.\d\d) \(/.exec(line)?.[1]);
}

/** A throwaway git repo: `write` a tree, `commit` it, and read the sha back. */
function scratch(name: string) {
	const root = join(TMP, name);
	mkdirSync(root, { recursive: true });
	const git = (...args: string[]) => {
		const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
		if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
		return result.stdout.trim();
	};
	git("init", "-q", "-b", "dev");
	git("config", "user.email", "test@example.com");
	git("config", "user.name", "Test");
	git("config", "commit.gpgsign", "false");
	const write = (files: Record<string, number | string[]>) => {
		for (const [path, content] of Object.entries(files)) {
			const full = join(root, path);
			mkdirSync(dirname(full), { recursive: true });
			writeFileSync(full, Array.isArray(content) ? `${content.join("\n")}\n` : "// fixture\n".repeat(content));
		}
	};
	const commit = (message: string) => {
		git("add", "-A");
		git("commit", "-qm", message);
		return git("rev-parse", "HEAD");
	};
	/** `main --flow` against this repo, measured from `dev`. */
	/** Leave `dev` for a feature branch: a flow needs a head that is NOT an ancestor of the base. */
	const branch = (name: string) => git("checkout", "-q", "-b", name);
	const flow = (head: string, base = "dev") => run(["--flow", "--base", base, "--head", head], root);
	return { root, git, write, commit, branch, flow };
}

describe("measureSurface — a `__tests__` segment classifies, not the extension", () => {
	it("splits source from tests on each surface's own extensions", () => {
		const root = tree("classify", {
			"scripts/guard.mjs": 5,
			"scripts/guard.d.mts": 7,
			"scripts/helper.ts": 3,
			"scripts/__tests__/guard.test.ts": 4,
			"scripts/__tests__/deep/nested.test.ts": 6,
		});
		const measured = measureSurface(surface("scripts"), root);
		expect(measured.sourceFiles.map((file: string) => file.slice(root.length + 1))).toEqual(["scripts/guard.mjs"]);
		expect(measured.testFiles.map((file: string) => file.slice(root.length + 1))).toEqual([
			"scripts/__tests__/deep/nested.test.ts",
			"scripts/__tests__/guard.test.ts",
		]);
		expect(measured.sourceLoc).toBe(5);
		expect(measured.testLoc).toBe(10);
		expect(measured.ratio).toBe(2);
	});

	it("counts physical lines like `wc -l` — a missing trailing newline starts no line", () => {
		const root = join(TMP, "physical");
		mkdirSync(join(root, "src"), { recursive: true });
		const file = join(root, "src", "no-trailing-newline.ts");
		writeFileSync(file, "one\ntwo\nthree");
		expect(countLines(file)).toBe(2);
	});

	it("refuses to compute a ratio from an unreadable or empty tree", () => {
		expect(() => measureSurface(surface("src"), join(TMP, "absent"))).toThrow(/src: cannot read the tree/);
		const root = tree("empty-src", { "scripts/guard.mjs": 1 });
		mkdirSync(join(root, "src"), { recursive: true });
		expect(() => measureSurface(surface("src"), root)).toThrow(/src: no source \(\.ts outside __tests__\)/);
	});

	it("renders one line per surface, with a reference ratio and the band where one exists", () => {
		const root = tree("format", {
			"scripts/guard.mjs": 10,
			"scripts/__tests__/guard.test.ts": 5,
			"src/module.ts": 10,
			"src/__tests__/module.test.ts": 15,
		});
		expect(formatSurface(measureSurface(surface("scripts"), root))).toBe(
			"test-budget: scripts 0.50 (5 test / 10 source LOC, reference 1.0)",
		);
		expect(formatSurface(measureSurface(surface("src"), root))).toBe(
			"test-budget: src 1.50 (15 test / 10 source LOC, reference 2.0, warn at 1.95)",
		);
		// A reference-less surface says so instead of printing a target it does not have: the flow rule
		// is its gate, and `reference none (flow-gated)` is the line that says which gate that is.
		expect(formatSurface(measureSurface(surface("skills"), root))).toBe(
			"test-budget: skills 0.00 (0 test / 5 source LOC, reference none (flow-gated))",
		);
	});

	it("classifies the skills surface by LIST membership: `.sh`, `.py` and `.mjs`, never the extension alone", () => {
		const root = tree("skills-ext", {
			".pi/skills/worktree/guard.sh": 4,
			".pi/skills/worktree/metrics.py": 3,
			".pi/skills/worktree/log.mjs": 3,
			".pi/skills/worktree/lib/helper.sh": 2,
			".pi/skills/worktree/notes.md": 9,
			".pi/skills/worktree/__pycache__/metrics.pyc": 9,
			".pi/skills/worktree/__tests__/guard.test.ts": 12,
			".pi/skills/worktree/__tests__/fixtures/body.md": 9,
		});
		rmSync(join(root, ".pi/skills/worktree", "probe.sh"));
		const measured = measureSurface(surface("skills"), root);
		expect(measured.sourceFiles.map((file: string) => file.slice(root.length + 1))).toEqual([
			".pi/skills/worktree/guard.sh",
			".pi/skills/worktree/lib/helper.sh",
			".pi/skills/worktree/log.mjs",
			".pi/skills/worktree/metrics.py",
		]);
		// A `__tests__` segment makes it a test whatever the extension, and only a test extension counts.
		expect(measured.testFiles.map((file: string) => file.slice(root.length + 1))).toEqual([
			".pi/skills/worktree/__tests__/guard.test.ts",
		]);
		expect(measured.sourceLoc).toBe(12);
		expect(measured.testLoc).toBe(12);
	});

	it("names every source extension in its refusal, never a JSON array", () => {
		const root = tree("skills-empty", { ".pi/skills/worktree/notes.md": 3 });
		rmSync(join(root, ".pi/skills/worktree", "probe.sh"));
		expect(() => measureSurface(surface("skills"), root)).toThrow(/\.sh\|\.py\|\.mjs outside __tests__/);
	});
});

describe("evaluate — the ratio reports, the wall and the floors still fail", () => {
	const measured = (name: string, sourceLoc: number, testLoc: number) => ({
		name,
		sourceFiles: [],
		testFiles: [],
		sourceLoc,
		testLoc,
		ratio: testLoc / sourceLoc,
		reference: surface(name).reference,
		warnAt: surface(name).warnAt,
	});

	const verdict = (surfaces: ReturnType<typeof measured>[], wallMs = 1_000) =>
		evaluate({ reportPath: "report.json", wallMs, surfaces });

	it("passes a ratio exactly at the reference — the band starts there, and it is not a finding", () => {
		const { findings, warnings } = verdict([measured("src", 100, 200), measured("scripts", 100, 100)]);
		expect(findings).toEqual([]);
		// 200/100 is at the 2.0 reference and inside the band: a warning with zero headroom, not a finding.
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("0 test lines of headroom");
	});

	it("warms above the reference as a WARNING and does not fail the run (policy v2)", () => {
		const { findings, warnings } = verdict([measured("src", 100, 150), measured("scripts", 100, 101)]);
		expect(findings).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('surface "scripts" test:source LOC ratio 1.01 (101 test / 100 source)');
		expect(warnings[0]).toContain("is above the 1.0 reference by 1 test line");
		expect(warnings[0]).toContain("reported, not enforced");
	});

	it("states the overage in whole lines, so a rounded ratio cannot read as equal", () => {
		// 56198/28097 = 2.0004: two decimals print "2.00", so the warning must carry the line count.
		const { warnings } = verdict([measured("src", 28_097, 56_198)]);
		expect(warnings[0]).toContain("ratio 2.00 (56198 test / 28097 source)");
		expect(warnings[0]).toContain("is above the 2.0 reference by 4 test lines");
	});

	it("names the src surface and its 2.0 reference, never the scripts one", () => {
		const { findings, warnings } = verdict([measured("src", 100, 201), measured("scripts", 100, 50)]);
		expect(findings).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain('surface "src" test:source LOC ratio 2.01 (201 test / 100 source)');
		expect(warnings[0]).toContain("is above the 2.0 reference by 1 test line");
	});

	it("reports both surfaces in one run rather than the first one found", () => {
		const { warnings } = verdict([measured("src", 10, 21), measured("scripts", 10, 11)]);
		expect(warnings).toHaveLength(2);
		expect(warnings.join("\n")).toContain('surface "scripts"');
		expect(warnings.join("\n")).toContain('surface "src"');
	});

	it("warns inside the band without failing, and is silent below it", () => {
		const band = verdict([measured("src", 100, 195)]);
		expect(band.findings).toEqual([]);
		expect(band.warnings).toHaveLength(1);
		expect(band.warnings[0]).toContain("inside the 1.95 warning band");
		expect(band.warnings[0]).toContain("5 test lines of headroom");
		expect(verdict([measured("src", 100, 194)]).warnings).toEqual([]);
	});

	it("has no band on the scripts surface — a surface without warnAt never warns at the reference", () => {
		const { findings, warnings } = verdict([measured("scripts", 100, 99)]);
		expect(findings).toEqual([]);
		expect(warnings).toEqual([]);
		// Exactly at the reference is not a crossing: the breach test is `>`, so there is nothing to say.
		expect(verdict([measured("scripts", 100, 100)]).warnings).toEqual([]);
		expect(verdict([measured("scripts", 100, 101)]).warnings).toHaveLength(1);
	});

	it("fails the wall ceiling above 90 s and passes it at exactly 90 s", () => {
		expect(verdict([measured("src", 10, 10)], WALL_CEILING_MS + 10).findings[0]).toContain(
			"wall time 90.01s exceeds the 90.00s ceiling by 10 ms",
		);
		expect(verdict([measured("src", 10, 10)], WALL_CEILING_MS).findings).toEqual([]);
	});

	it("says nothing about a reference-less surface, even with a positive ratio (#558)", () => {
		// `ratio > null` is a coercion, not a judgement. The skills surface declares no target, so a
		// ratio of any size is silent: the flow rule gates it, and this report only prices it.
		const { findings, warnings } = verdict([measured("skills", 10, 50)]);
		expect(findings).toEqual([]);
		expect(warnings).toEqual([]);
	});

	it("a band without a reference does not throw", () => {
		// A band with no reference is a contradiction the report must survive rather than crash on
		// (#569): the band branch read `surface.reference.toFixed(1)`, which threw on null.
		const hand = { name: "skills", sourceFiles: [], testFiles: [], sourceLoc: 100, testLoc: 90, ratio: 0.9, reference: null, warnAt: 0.5 };
		expect(() => evaluate({ reportPath: "report.json", wallMs: 1_000, surfaces: [hand] })).not.toThrow();
	});

	it("a reference-less band stays silent and a referenced one warns", () => {
		// The pair is the pass/fail verdict: no reference means no target to sit under, so the band has
		// nothing to price and the flow rule is the gate; the same ratio with a reference DOES warn.
		const silent = { name: "skills", sourceFiles: [], testFiles: [], sourceLoc: 100, testLoc: 90, ratio: 0.9, reference: null, warnAt: 0.5 };
		expect(evaluate({ reportPath: "report.json", wallMs: 1_000, surfaces: [silent] })).toEqual({ findings: [], warnings: [] });

		const { findings, warnings } = evaluate({ reportPath: "report.json", wallMs: 1_000, surfaces: [{ ...silent, reference: 2.0 }] });
		expect(findings).toEqual([]);
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("inside the 0.50 warning band");
		expect(warnings[0]).toContain("110 test lines of headroom under the 2.0 reference");
	});

	it("fails a floor finding that names the unreachable modules and their surface", () => {
		const { findings, warnings } = evaluate({
			reportPath: "report.json",
			wallMs: 1_000,
			surfaces: [measured("src", 10, 10)],
			floors: [{ name: "src", total: 58, reached: 56, unreachable: ["src/orphan.ts", "src/lonely.ts"] }],
		});
		expect(warnings).toEqual([]);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toBe(
			"src floor: 2 of 58 source modules are unreachable from any .test.ts — src/orphan.ts, src/lonely.ts " +
				"(a test must import it, directly or through a module a test imports; a comment, a string, " +
				"`import type` and a re-export are not edges).",
		);
	});
});

describe("readWallMs — the report's own timestamps", () => {
	it("measures start to the last file end across workers", () => {
		const path = join(TMP, "reports", "spread.json");
		mkdirSync(join(TMP, "reports"), { recursive: true });
		writeFileSync(path, JSON.stringify({ startTime: 1_000, testResults: [{ endTime: 4_000 }, { endTime: 9_500 }] }));
		expect(readWallMs(path)).toBe(8_500);
	});

	it("refuses anything that is not vitest's json reporter output", () => {
		const path = join(TMP, "reports", "bad.json");
		mkdirSync(join(TMP, "reports"), { recursive: true });
		expect(() => readWallMs(join(TMP, "absent.json"))).toThrow(/cannot read the vitest JSON report/);
		writeFileSync(path, "not json");
		expect(() => readWallMs(path)).toThrow(/not JSON/);
		writeFileSync(path, JSON.stringify({ startTime: 0, testResults: [] }));
		expect(() => readWallMs(path)).toThrow(/no startTime\/testResults/);
		writeFileSync(path, JSON.stringify({ startTime: 0, testResults: [{ endTime: "soon" }] }));
		expect(() => readWallMs(path)).toThrow(/carry no endTime/);
	});
});

describe("parseArgs — positional or --report, no surprises", () => {
	it("accepts both spellings and rejects everything else", () => {
		expect(parseArgs(["report.json"])).toEqual({ ok: true, reportPath: "report.json" });
		expect(parseArgs(["--report", "report.json"])).toEqual({ ok: true, reportPath: "report.json" });
		expect(parseArgs([])).toEqual({ ok: false, message: "missing the vitest JSON report path" });
		expect(parseArgs(["--report"])).toEqual({ ok: false, message: "--report needs a path" });
		expect(parseArgs(["--report", "--strict"])).toEqual({ ok: false, message: "--report needs a path" });
		expect(parseArgs(["--nope"])).toEqual({ ok: false, message: "unknown flag: --nope" });
		expect(parseArgs(["a.json", "b.json"])).toEqual({ ok: false, message: "unexpected argument: b.json" });
	});
});

describe("parseFlowArgs — the flow mode's own arguments", () => {
	it("defaults the base to dev and requires a head", () => {
		expect(parseFlowArgs(["--flow", "--head", "abc123"])).toEqual({ ok: true, base: "dev", head: "abc123", json: false });
		expect(parseFlowArgs(["--head", "abc123", "--base", "main", "--json"])).toEqual({
			ok: true,
			base: "main",
			head: "abc123",
			json: true,
		});
		expect(parseFlowArgs(["--flow"])).toEqual({ ok: false, message: "--head needs a sha (the PR head, which need not be checked out)" });
		expect(parseFlowArgs(["--flow", "--head"])).toEqual({ ok: false, message: "--head needs a value" });
		expect(parseFlowArgs(["--flow", "--head", "abc", "extra"])).toEqual({ ok: false, message: "unknown flow argument: extra" });
	});
});

describe("importSpecifiers — module requests, read from code only", () => {
	it("reads the four runtime forms and drops the type-only ones", () => {
		const text = [
			'import a from "./a";',
			'import "./b";',
			'const c = await import("./c");',
			'const d = require("./d");',
			'import type E from "./e";',
			'export type { F } from "./f";',
			'export { G } from "./g";',
			'import { h, type H } from "./h";',
		].join("\n");
		// A value import with an INLINE `type` modifier is still a runtime import (`h` is a value here).
		expect(importSpecifiers(text)).toEqual(["./a", "./b", "./c", "./d", "./g", "./h"]);
		expect(reachabilitySpecifiers(text)).toEqual(["./a", "./b", "./c", "./d", "./h"]);
	});

	it("ignores a path named in a comment or in a string", () => {
		const text = ['import { a } from "../x.mjs";', "// ../comment.mjs", "/* ../block.mjs */", 'const s = "../string.mjs";'].join("\n");
		expect(importSpecifiers(text)).toEqual(["../x.mjs"]);
	});

	it("ignores a request inside a template literal, and inside a template's interpolation too", () => {
		const text = ["const t = `import a from \"../t.mjs\"`;", "const u = `${'../i.mjs'}`;", 'import { b } from "../real.mjs";'].join("\n");
		expect(importSpecifiers(text)).toEqual(["../real.mjs"]);
	});

	it("fail-closed on a regex literal carrying a quote: the swallowed region yields NO specifier", () => {
		// A regex literal is not a JavaScript construct this scanner parses (`["']` opens what looks
		// like a string). The real import after it is LOST — a module then reads as unreachable and
		// the floor fires. The forbidden direction is the other one: a specifier invented out of
		// swallowed text would make an untested module read as covered.
		const text = ["const QUOTE = /[\"']/;", 'import { a } from "../real.mjs";'].join("\n");
		expect(importSpecifiers(text)).toEqual([]);
		expect(importSpecifiers(text).every((specifier: string) => specifier.endsWith(".mjs"))).toBe(true);
	});
});

describe("measureFloor — reachability, not a mention and not a barrel", () => {
	it("accepts a real import, and follows the edges a reached module carries", () => {
		const root = tree("floor-real", {
			"src/module.ts": 10,
			"src/helper.ts": ['import { deep } from "./deep";'],
			"src/deep.ts": 3,
			"src/__tests__/module.test.ts": ['import { module } from "../module";', 'import { helper } from "../helper";'],
		});
		const measured = measureFloor(surface("src"), root);
		expect(measured.unreachable).toEqual([]);
		expect(measured.reached).toBe(measured.total);
	});

	it("names every module no test reaches, sorted", () => {
		const root = tree("floor-transitive", {
			"src/module.ts": 10,
			"src/helper.ts": 3,
			"src/lonely.ts": 3,
			"src/__tests__/module.test.ts": ['import { helper } from "../helper";'],
		});
		expect(measureFloor(surface("src"), root).unreachable).toEqual(["src/lonely.ts", "src/module.ts"]);
	});

	it("does NOT count a comment-only or string-only mention as an edge", () => {
		const root = tree("floor-mention", {
			"src/module.ts": 10,
			"src/orphan.ts": 3,
			"src/__tests__/module.test.ts": [
				'import { module } from "../module";',
				"// ../orphan",
				'const path = "../orphan.ts";',
				'/* import { orphan } from "../orphan"; */',
			],
		});
		expect(measureFloor(surface("src"), root).unreachable).toEqual(["src/orphan.ts"]);
	});

	it("does NOT count `import type … from` as an edge", () => {
		const root = tree("floor-type", {
			"src/module.ts": 10,
			"src/only-types.ts": 3,
			"src/__tests__/module.test.ts": [
				'import { module } from "../module";',
				'import type { Shape } from "../only-types";',
				"export type { Other } from \"../only-types\";",
			],
		});
		expect(measureFloor(surface("src"), root).unreachable).toEqual(["src/only-types.ts"]);
	});

	it("does NOT count `export … from` as an edge — a barrel would cover everything", () => {
		const root = tree("floor-barrel", {
			"src/module.ts": 10,
			"src/buried.ts": 3,
			"src/__tests__/module.test.ts": ['import { module } from "../module";', 'export * from "../buried";'],
		});
		expect(measureFloor(surface("src"), root).unreachable).toEqual(["src/buried.ts"]);
	});

	it("treats a missing test file as nothing reached, and names every module", () => {
		const root = tree("floor-absent", { "src/module.ts": 10, "src/other.ts": 3 });
		const measured = measureFloor(surface("src"), root);
		expect(measured.testFiles).toBe(0);
		expect(measured.unreachable).toEqual(["src/module.ts", "src/other.ts"]);
	});

	it("resolves `.js` to `.ts` and a directory to its index, as a bundler would", () => {
		const root = tree("floor-resolve", {
			"src/module.ts": 10,
			"src/typed.ts": 3,
			"src/index.ts": 3,
			"src/__tests__/module.test.ts": [
				'import { module } from "../module";',
				'import { typed } from "../typed.js";',
				'import { entry } from "..";',
			],
		});
		expect(measureFloor(surface("src"), root).unreachable).toEqual([]);
	});

	it("resolves the specifier, so a lookalike basename in a fixture directory proves nothing", () => {
		const root = tree("floor-basename", {
			"scripts/guard.mjs": 1,
			"scripts/__tests__/fixtures/guard.mjs": 1,
			"scripts/__tests__/fixture.test.ts": ['import "./fixtures/guard.mjs";'],
		});
		expect(measureFloor(surface("scripts"), root).unreachable).toEqual(["scripts/guard.mjs"]);
	});

	it("judges the `scripts` surface's top-level entry scripts, not its lib internals", () => {
		const root = tree("floor-scripts", {
			"scripts/guard.mjs": ['import { used } from "./lib/used.mjs";'],
			"scripts/lib/used.mjs": 3,
			"scripts/lib/forgotten.mjs": 3,
			"scripts/__tests__/guard.test.ts": importer(2),
		});
		// The entry script is judged; `lib/forgotten.mjs` is outside the corpus (a stated limit of this
		// unit), and the reached lib module is traversed through the entry script's own edge.
		expect(measureFloor(surface("scripts"), root).unreachable).toEqual([]);
		expect(measureFloor(surface("scripts"), root).total).toBe(1);
		expect(FLOOR.testSuffix).toBe(".test.ts");
	});

	it("opts the skills surface out of the floor — a `.sh` has no import edges to follow", () => {
		// `floorCorpus: null` is the explicit opt-out: `0/11 reachable` would be a false red, and the
		// surface's gate is the flow rule (its report line says `reference none (flow-gated)`).
		expect(measureFloor(surface("skills"), ROOT)).toBeNull();
		expect(measureFloors(ROOT).map((floor: { name: string }) => floor.name)).toEqual(["src", "scripts"]);
	});

	it("reads the opt-out BEFORE the tree, so an absent skills directory is skipped, never read", () => {
		// A late skip — filtering the measured rows instead of the surfaces — reads the directory first
		// and throws `cannot read the tree` on a root that simply has no worktree skill.
		const root = tree("floor-no-skills", {
			"src/module.ts": 10,
			"src/__tests__/module.test.ts": importerOf("../module", 2),
			"scripts/guard.mjs": 1,
			"scripts/__tests__/guard.test.ts": importer(2),
		});
		rmSync(join(root, ".pi"), { recursive: true, force: true });
		expect(measureFloors(root).map((floor: { name: string }) => floor.name)).toEqual(["src", "scripts"]);
	});
});

describe("findTestBudgetDeclaration — one line authorises an over-allowance flow", () => {
	it("finds a line-start declaration and ignores decoration-free prose", () => {
		const body = ["## Summary", "", "Test budget: +180 test lines for the new recovery matrix.", ""].join("\n");
		expect(findTestBudgetDeclaration(body)).toBe("Test budget: +180 test lines for the new recovery matrix.");
		expect(findTestBudgetDeclaration("## Summary\n\nNo declaration here.\n")).toBeNull();
	});

	it("is not satisfied by a heading whose reason is on the next line", () => {
		expect(findTestBudgetDeclaration("Test budget:\n\nBecause the matrix is big.\n")).toBeNull();
		expect(findTestBudgetDeclaration("Test budget:   \n")).toBeNull();
	});

	it("ignores a declaration inside a fence, a blockquote or the pr-evidence block", () => {
		const fenced = ["```md", "Test budget: +900", "```"].join("\n");
		expect(findTestBudgetDeclaration(fenced)).toBeNull();
		expect(findTestBudgetDeclaration("> Test budget: +900 quoted from an old PR")).toBeNull();
		const blocked = ["<!-- pr-evidence:begin -->", "Test budget: +900", "<!-- pr-evidence:end -->"].join("\n");
		expect(findTestBudgetDeclaration(blocked)).toBeNull();
	});
});

describe("computeFlow — net deltas and the per-surface allowance", () => {
	const flowOf = (numstat: string) => computeFlow(numstat, { surfaces: SURFACES, testDirName: "__tests__" });

	it("counts a surface's own extensions and ignores fixtures and declaration files", () => {
		const numstat = [
			"500\t0\tsrc/__tests__/module.test.ts",
			"250\t0\tsrc/module.ts",
			"40\t0\tscripts/__tests__/guard.test.ts",
			"60\t0\tscripts/guard.mjs",
			"9\t0\tscripts/__tests__/fixtures/body.json",
			"9\t0\tscripts/check-imports.d.mts",
			"9\t0\tREADME.md",
		].join("\n");
		const flow = flowOf(numstat);
		expect(flow.rows).toEqual([
			{ name: "src", source: 250, test: 500, allowance: 620, verdict: "within" },
			{ name: "scripts", source: 60, test: 40, allowance: 240, verdict: "within" },
		]);
		expect(flow.verdict).toBe("within");
	});

	it("measures NET lines, so a replacement of the same size is zero", () => {
		const flow = flowOf(["120\t120\tsrc/__tests__/module.test.ts", "10\t10\tsrc/module.ts"].join("\n"));
		expect(flow.rows).toEqual([]);
		expect(flow.verdict).toBe("within");
		expect(formatFlowLine(flow, "abcdef1234")).toBe("test-flow: no source or test change — within (base abcdef1)");
	});

	it("sees a skills-only change, and a zero-net one stays silent (#558, the accepted limit)", () => {
		// The surface #558 was filed for: five added lines in a worktree script used to read as no
		// change at all, because `classifyPath` knew only `src/` and `scripts/`.
		const grew = flowOf(["0\t0\tREADME.md", "5\t0\t.pi/skills/worktree/merge-guard.sh"].join("\n"));
		expect(grew.rows).toEqual([{ name: "skills", source: 5, test: 0, allowance: 130, verdict: "within" }]);
		expect(formatFlowLine(grew, "892d4fb1234")).toBe(
			"test-flow: 0/+5 skills (allowance 130) — within (base 892d4fb)",
		);
		// The falsifier, pinned: the rule measures NET deltas, so a same-size replacement buys nothing
		// and prints nothing. If this ever reports a clause, the accepted limit is no longer true.
		const replaced = flowOf(["5\t5\t.pi/skills/worktree/merge-guard.sh"].join("\n"));
		expect(replaced.rows).toEqual([]);
		expect(replaced.verdict).toBe("within");
	});

	it("counts the worktree's three source languages and its `__tests__` tests, nothing else", () => {
		const flow = flowOf(
			[
				"9\t0\t.pi/skills/worktree/lib/version-skew.sh",
				"9\t0\t.pi/skills/worktree/codegraph-check.py",
				"9\t0\t.pi/skills/worktree/jev-check.mjs",
				"9\t0\t.pi/skills/worktree/SKILL.md",
				"9\t0\t.pi/skills/worktree/references/spec-evidence.md",
				"9\t0\t.pi/skills/worktree/__tests__/script-guards.test.ts",
				"9\t0\t.pi/skills/notify/SKILL.md",
			].join("\n"),
		);
		expect(flow.rows).toEqual([{ name: "skills", source: 27, test: 9, allowance: 174, verdict: "within" }]);
	});

	it("prices source growth at 2 test lines per added line, and a shrink at nothing", () => {
		const grown = flowOf(["700\t0\tsrc/__tests__/m.test.ts", "300\t0\tsrc/m.ts"].join("\n"));
		expect(grown.rows[0]).toEqual({ name: "src", source: 300, test: 700, allowance: 720, verdict: "within" });
		const shrunk = flowOf(["121\t0\tsrc/__tests__/m.test.ts", "0\t300\tsrc/m.ts"].join("\n"));
		expect(shrunk.rows[0]).toEqual({ name: "src", source: -300, test: 121, allowance: 120, verdict: "over" });
	});

	it("is over when ANY changed surface is over, and only prints the changed surfaces", () => {
		const flow = flowOf(["900\t0\tsrc/__tests__/m.test.ts", "40\t0\tscripts/__tests__/g.test.ts", "0\t10\tscripts/g.mjs"].join("\n"));
		expect(flow.rows.map((row: { name: string }) => row.name)).toEqual(["src", "scripts"]);
		expect(flow.verdict).toBe("over");
	});

	it("renders the contract line, provenance beside the numbers", () => {
		const flow = flowOf(["500\t0\tsrc/__tests__/m.test.ts", "250\t0\tsrc/m.ts", "40\t0\tscripts/__tests__/g.test.ts", "60\t0\tscripts/g.mjs"].join("\n"));
		expect(formatFlowLine(flow, "444454b1b5b81866d4f582c4f492786acc3b1743")).toBe(
			"test-flow: +500/+250 src (allowance 620) — within · +40/+60 scripts (allowance 240) — within (base 444454b)",
		);
	});
});

describe("main --flow — the rule over a real git range", () => {
	it("prints within and exits 0 when the test growth fits the allowance", () => {
		const repo = scratch("flow-within");
		repo.write({ "src/module.ts": 100 });
		repo.commit("base");
		repo.branch("feat");
		repo.write({ "src/module.ts": 350, "src/__tests__/module.test.ts": 500 });
		const head = repo.commit("grow");
		const { code, out, err } = repo.flow(head);
		expect(err).toEqual([]);
		expect(code).toBe(0);
		expect(out[0]).toMatch(/^test-flow: \+500\/\+250 src \(allowance 620\) — within \(base [0-9a-f]{7}\)$/);
	});

	it("exits 1 when the tests outgrow the allowance bought by the source", () => {
		const repo = scratch("flow-over");
		repo.write({ "src/module.ts": 100 });
		repo.commit("base");
		repo.branch("feat");
		repo.write({ "src/module.ts": 110, "src/__tests__/module.test.ts": 1000 });
		const head = repo.commit("grow");
		const { code, out } = repo.flow(head);
		expect(code).toBe(1);
		expect(out[0]).toMatch(/^test-flow: \+1000\/\+10 src \(allowance 140\) — over \(base [0-9a-f]{7}\)$/);
	});

	it("exits 1 for a test-only PR of +500 — the fixed 120 is all it has", () => {
		const repo = scratch("flow-test-only");
		repo.write({ "src/module.ts": 100, "src/__tests__/module.test.ts": 10 });
		repo.commit("base");
		repo.branch("feat");
		repo.write({ "src/__tests__/module.test.ts": 510 });
		const head = repo.commit("grow");
		const { code, out } = repo.flow(head);
		expect(code).toBe(1);
		expect(out[0]).toContain("+500/0 src (allowance 120) — over");
	});

	it("shrinking source buys no allowance: −100 source still allows 120 test lines", () => {
		const repo = scratch("flow-shrink");
		repo.write({ "src/module.ts": 200 });
		repo.commit("base");
		repo.branch("feat");
		repo.write({ "src/module.ts": 100, "src/__tests__/module.test.ts": 120 });
		const head = repo.commit("shrink and add");
		expect(repo.flow(head)).toMatchObject({ code: 0 });
		expect(repo.flow(head).out[0]).toContain("+120/-100 src (allowance 120) — within");
		repo.write({ "src/__tests__/module.test.ts": 121 });
		const oneMore = repo.commit("one more line");
		expect(repo.flow(oneMore).code).toBe(1);
		expect(repo.flow(oneMore).out[0]).toContain("+121/-100 src (allowance 120) — over");
	});

	it("says so when the PR touches neither surface", () => {
		const repo = scratch("flow-docs");
		repo.write({ "src/module.ts": 100 });
		repo.commit("base");
		repo.branch("feat");
		repo.write({ "README.md": ["# docs"] });
		const head = repo.commit("docs");
		const { code, out } = repo.flow(head);
		expect(code).toBe(0);
		expect(out[0]).toMatch(/^test-flow: no source or test change — within \(base [0-9a-f]{7}\)$/);
	});

	it("shows a source↔test move as a reclassification (`--no-renames`)", () => {
		const repo = scratch("flow-rename");
		repo.write({ "src/moved.ts": 50 });
		repo.commit("base");
		repo.branch("feat");
		mkdirSync(join(repo.root, "src", "__tests__"), { recursive: true });
		repo.git("mv", "src/moved.ts", "src/__tests__/moved.test.ts");
		const head = repo.commit("move");
		const { code, out } = repo.flow(head);
		expect(code).toBe(0);
		expect(out[0]).toContain("+50/-50 src (allowance 120) — within");
	});

	it("measures a skills-only change in the flow — the surface #558 was filed for", () => {
		const repo = scratch("flow-skills");
		repo.write({ "src/module.ts": 100, ".pi/skills/worktree/merge-guard.sh": 10 });
		repo.commit("base");
		repo.branch("feat");
		repo.write({ ".pi/skills/worktree/merge-guard.sh": 15 });
		const head = repo.commit("guard docs");
		const { code, out } = repo.flow(head);
		expect(code).toBe(0);
		expect(out[0]).toMatch(/^test-flow: 0\/\+5 skills \(allowance 130\) — within \(base [0-9a-f]{7}\)$/);
	});

	it("fails closed with `already-merged` when the merge base IS the head", () => {
		const repo = scratch("flow-merged");
		repo.write({ "src/module.ts": 100 });
		const head = repo.commit("only commit");
		const { code, out, err } = repo.flow(head);
		expect(code).toBe(2);
		expect(out).toEqual([]);
		expect(err.join("\n")).toContain("already-merged");
		expect(err.join("\n")).toContain("post-merge replay");
	});

	it("fails closed with `unknown-head` when the head names no commit", () => {
		const repo = scratch("flow-unknown");
		repo.write({ "src/module.ts": 100 });
		repo.commit("base");
		const { code, err } = repo.flow("0000000000000000000000000000000000000000");
		expect(code).toBe(2);
		expect(err.join("\n")).toContain("unknown-head");
	});

	it("fails closed on a missing --head with the usage line", () => {
		const repo = scratch("flow-usage");
		repo.write({ "src/module.ts": 100 });
		repo.commit("base");
		const { code, err } = run(["--flow"], repo.root);
		expect(code).toBe(2);
		expect(err.join("\n")).toContain("usage");
		expect(err.join("\n")).toContain("--head needs a sha");
	});

	it("measures a head that is not checked out, and emits --json on request", () => {
		const repo = scratch("flow-detached");
		repo.write({ "src/module.ts": 100 });
		repo.commit("base");
		repo.branch("feat");
		repo.write({ "src/__tests__/module.test.ts": 20 });
		const head = repo.commit("test only");
		repo.git("checkout", "-q", "--detach", "HEAD~1");
		const { code, out } = run(["--flow", "--base", "dev", "--head", head, "--json"], repo.root);
		expect(code).toBe(0);
		const parsed = JSON.parse(out[0]);
		expect(parsed.head).toBe(head);
		expect(parsed.verdict).toBe("within");
		expect(parsed.rows).toEqual([{ name: "src", source: 0, test: 20, allowance: 120, verdict: "within" }]);
	});
});

describe("main — the two streams and the exit codes", () => {
	it("reports both surfaces every run, in name order, then the floors, and exits 0", () => {
		const root = tree("cli-ok", {
			"scripts/guard.mjs": 10,
			"scripts/__tests__/guard.test.ts": importer(9),
			"src/module.ts": 10,
			"src/__tests__/module.test.ts": importerOf("../module", 15),
		});
		const path = report("ok", 1_000);
		const { code, out, err } = run([path], root);
		expect(code).toBe(0);
		expect(err).toEqual([]);
		// Six lines: the wall, the THREE surfaces in name order (`scripts`, `skills`, `src`), the floors
		// — which still name exactly the two surfaces that declare one — and the verdict.
		expect(out).toEqual([
			`test-budget: wall 1.00s (<= 90.00s, report: ${path})`,
			"test-budget: scripts 0.90 (9 test / 10 source LOC, reference 1.0)",
			"test-budget: skills 0.00 (0 test / 5 source LOC, reference none (flow-gated))",
			"test-budget: src 1.50 (15 test / 10 source LOC, reference 2.0, warn at 1.95)",
			"test-budget: floors — src 1/1 reachable · scripts 1/1 reachable",
			"test-budget: OK.",
		]);
	});

	it("warns on a scripts ratio above its reference and STILL exits 0 (policy v2)", () => {
		const root = tree("cli-scripts-over", {
			"scripts/guard.mjs": 10,
			"scripts/__tests__/guard.test.ts": importer(20),
			"src/module.ts": 10,
			"src/__tests__/module.test.ts": importerOf("../module", 15),
		});
		const { code, out, err } = run([report("scripts-over", 1_000)], root);
		expect(code).toBe(0);
		expect(err).toHaveLength(1);
		expect(err[0]).toContain('surface "scripts" test:source LOC ratio 2.00 (20 test / 10 source)');
		expect(err[0]).toContain("reported, not enforced");
		expect(out.some((line) => line.startsWith("test-budget: src "))).toBe(true);
		expect(out).toContain("test-budget: OK.");
	});

	it("keeps the band non-failing on the src surface", () => {
		const root = tree("cli-band", {
			"scripts/guard.mjs": 10,
			"scripts/__tests__/guard.test.ts": importer(5),
			"src/module.ts": 100,
			"src/__tests__/module.test.ts": importerOf("../module", 196),
		});
		const { code, err } = run([report("band", 1_000)], root);
		expect(code).toBe(0);
		expect(err).toHaveLength(1);
		expect(err[0]).toMatch(/^test-budget: warning: surface "src" test:source LOC ratio 1\.96/);
	});

	it("fails the wall ceiling with the report path named", () => {
		const root = tree("cli-wall", {
			"scripts/guard.mjs": 10,
			"scripts/__tests__/guard.test.ts": importer(5),
			"src/module.ts": 10,
			"src/__tests__/module.test.ts": importerOf("../module", 5),
		});
		const path = report("wall", WALL_CEILING_MS + 10);
		const { code, err } = run([path], root);
		expect(code).toBe(1);
		expect(err.join("\n")).toContain(`wall time 90.01s exceeds the 90.00s ceiling by 10 ms (report: ${path}`);
	});

	it("fails the floor when a source module is unreachable, naming every module", () => {
		const root = tree("cli-floor", {
			"scripts/guard.mjs": 10,
			"scripts/orphan.mjs": 10,
			"scripts/__tests__/guard.test.ts": importer(5),
			"src/module.ts": 10,
			"src/__tests__/module.test.ts": importerOf("../module", 5),
		});
		const { code, out, err } = run([report("floor", 1_000)], root);
		expect(code).toBe(1);
		expect(out).toContain("test-budget: floors — src 1/1 reachable · scripts 1/2 reachable");
		expect(err).toEqual([
			"test-budget: scripts floor: 1 of 2 source modules are unreachable from any .test.ts — scripts/orphan.mjs " +
				"(a test must import it, directly or through a module a test imports; a comment, a string, `import type` " +
				"and a re-export are not edges).",
		]);
		expect(out).not.toContain("test-budget: OK.");
	});

	it("exits 2 on usage and on an unreadable input, not 1", () => {
		const root = tree("cli-usage", { "src/module.ts": 1 });
		expect(run([], root).code).toBe(2);
		expect(run(["--nope"], root).code).toBe(2);
		const unreadable = run([join(TMP, "absent.json")], root);
		expect(unreadable.code).toBe(2);
		expect(unreadable.err[0]).toContain("cannot read the vitest JSON report");
	});

	it("produces identical output on repeated runs", () => {
		const root = tree("cli-deterministic", {
			"scripts/guard.mjs": 10,
			"scripts/__tests__/guard.test.ts": importer(5),
			"src/module.ts": 10,
			"src/__tests__/module.test.ts": importerOf("../module", 5),
		});
		const path = report("deterministic", 1_000);
		expect(run([path], root).out).toEqual(run([path], root).out);
	});

	it("passes against the real tree — the ratchet and both floors, on the committed sources", () => {
		// The committed tree is the thing this guard measures in CI; a red result here means the
		// repository breached its own wall or lost a floor, not that a fixture is wrong. The ratio is
		// REPORTED (policy v2): it may warn, and it may never fail this run.
		const { code, out } = run([report("real", 1_000)], ROOT);
		expect(code).toBe(0);
		expect(ratioIn(out, "scripts")).toBeLessThanOrEqual(1);
		expect(ratioIn(out, "src")).toBeLessThanOrEqual(2.05);
		const floors = out.find((line: string) => line.startsWith("test-budget: floors"));
		expect(floors).toBeDefined();
		// Re-pointed with the commit that adds a src module (`scratch-root.ts`, issue #511 U1;
		// `scratch-spawn.ts`, issue #511 U2) — the floor is "every module reachable", so its
		// total tracks the tree, never a scan that silently stopped matching. Re-pointed again for the
		// scripts surface by `check-contract-tracking.mjs` (issue #514): a new module joins the floor only
		// with the test that reaches it, which is why 12 becomes 13 rather than the floor being relaxed.
		// Re-pointed once more by `friction-disposition.mjs` (issue #560): a sourced module with its own
		// test reaches the floor, so 13 becomes 14 for the same reason — never a relaxed floor.
		// Re-pointed by #606 (Unit 1): `dispatch-header.ts` + `brief.ts`, each reached by its own test,
		// so the src floor follows the tree 61 → 63 for the same reason.
		expect(/\bsrc (\d+)\/(\d+)/.exec(floors)!.slice(1, 3)).toEqual(["63", "63"]);
		// Re-pointed by #591: `scripts/require-executed.mjs` is a new source module, and the floor is
		// "every module reachable" — its test imports it, so 14 becomes 15 rather than the floor relaxing.
		// Re-pointed by #606 (Unit 1): `verify-dispatch-header.mjs` joins the scripts surface and its test
		// imports it, so 15 becomes 16 — the same rule, never a relaxed floor.
		// Re-pointed by #606 (Unit 3): `check-vocabulary.mjs` joins the same surface, and its test imports
		// it, so 16 becomes 17 — the floor follows the tree; it is never relaxed.
		expect(/\bscripts (\d+)\/(\d+)/.exec(floors)!.slice(1, 3)).toEqual(["17", "17"]);
		expect(measureFloors(ROOT).every((floor) => floor.unreachable.length === 0)).toBe(true);
	});

	it("measures the skills surface on the real tree — no reference, no floor, the flow is the gate", () => {
		// The corpus is the issue's own enumeration (7 entry `.sh` + `lib/version-skew.sh`, 2 `.py`,
		// 1 `.mjs`). A new worktree script joins this number; a test file does not move it.
		// Re-pointed by the friction-candidates reader (issue #574): `sprint-metrics.py` grew by the
		// derivation and its self-test, and the surface is measured, so the pin follows the file.
		// Re-pointed by the PR #575 review fixes (issue #574): the causal-window filter for terminal
		// runs, the named output-path error, microsecond ownership and their self-test cases.
		// Re-pointed by #581: `check-repo.sh` §6 counts brl-subagent installs (+32 source lines).
		// Re-pointed by #583: merge-guard's (d) is a LINE with the head and evidence (+202 source lines —
		// the two readers, the marker's evidence rule, and the U2-1…U2-9 matrix in `--selftest`).
		// Re-pointed by #589: `assertResponseEnvelope` at both arms, its selftest cases and the doc
		// clauses (+200 source lines).
		// Re-pointed by #591: `sprint-metrics.py` grew by the whole-file result read, the pre-flight
		// refusal dialect, the refused / failed-after-spawn / unresolved / duplicate clauses and
		// eight self-test cases; both units' additions are disjoint files, so the pin is their sum.
		// Re-pointed by #572: the transport-death reader (records store, runtime signature parse,
		// the default report's one line, `--transport`) and its eight self-test cases (+477).
		// Re-pointed by #596: the provenance ledger's grammar moved verbatim out of `jev-check.mjs`
		// into `scripts/lib/provenance-ledger.mjs` and the merged block went into the gate's own
		// `--match-row` call and its structural-failure message here, so the skills surface is
		// 8812 - 150 + 19. A move is not a rewrite: the scripts surface grows by what this one lost.
		// Re-pointed again by #596 U1: `merge-guard.sh --check-record` forwards `--provenance` and
		// `--shape-only` with the two mode guards, and `run.sh`'s risk-weaker replay passes the ledger
		// fixture instead of `--recheck` (+28 source lines in all); the JS surface is unchanged (the
		// resolver lives in `scripts/`).
		// Re-pointed by #616: the settle row's two optional keyed columns (`--attempt`/`--cause`), the
		// reader that parses them back, and eight `--selftest` cases (+389 source lines) — the store is
		// still one `.mjs` entry, so only the LOC pin moves.
		const SKILLS_SOURCE_LOC = 9098;
		const measured = measureSurface(surface("skills"), ROOT);
		expect(measured.sourceLoc).toBe(SKILLS_SOURCE_LOC);
		expect(measured.reference).toBeNull();
		expect(measured.warnAt).toBeNull();
		// The EXACT line, so a formatted ratio cannot be a constant: `testLoc / 7583`, two decimals.
		expect(formatSurface(measured)).toBe(
			`test-budget: skills ${(measured.testLoc / SKILLS_SOURCE_LOC).toFixed(2)} ` +
				`(${measured.testLoc} test / ${SKILLS_SOURCE_LOC} source LOC, reference none (flow-gated))`,
		);
	});

	it("keeps a positive ratio on a reference-less surface silent and unformatted-away", () => {
		// E2b's second half: a hand-built surface with `reference: null` and a POSITIVE ratio neither
		// throws nor warns, and its line carries that ratio — never a hardcoded `0.00`.
		const hand = { name: "skills", sourceFiles: [], testFiles: [], sourceLoc: 200, testLoc: 10, ratio: 0.05, reference: null, warnAt: null };
		expect(formatSurface(hand)).toBe("test-budget: skills 0.05 (10 test / 200 source LOC, reference none (flow-gated))");
		expect(evaluate({ reportPath: "report.json", wallMs: 1_000, surfaces: [hand] })).toEqual({ findings: [], warnings: [] });
	});
});

describe("the CLI as CI runs it", () => {
	it("exits 0 with the reference warning on stderr when spawned as a real process", () => {
		const root = tree("spawn", {
			"scripts/guard.mjs": 10,
			"scripts/__tests__/guard.test.ts": importer(20),
			"src/module.ts": 10,
			"src/__tests__/module.test.ts": importerOf("../module", 5),
		});
		const result = spawnSync(process.execPath, [SCRIPT, report("spawn", 1_000)], { cwd: root, encoding: "utf8" });
		expect(result.status).toBe(0);
		expect(result.stdout).toContain("test-budget: scripts 2.00 (20 test / 10 source LOC, reference 1.0)");
		expect(result.stderr).toContain("is above the 1.0 reference by 10 test lines");
	});

	it("exits 1 as a real process when a floor is lost", () => {
		const root = tree("spawn-floor", {
			"scripts/guard.mjs": 10,
			"scripts/orphan.mjs": 10,
			"scripts/__tests__/guard.test.ts": importer(2),
			"src/module.ts": 10,
			"src/__tests__/module.test.ts": importerOf("../module", 2),
		});
		const result = spawnSync(process.execPath, [SCRIPT, report("spawn-floor", 1_000)], { cwd: root, encoding: "utf8" });
		expect(result.status).toBe(1);
		expect(result.stderr).toContain("scripts/orphan.mjs");
	});
});

/**
 * Tests for the test-budget guard (issues #368, #490) — the executable half of the two-surface rule.
 *
 * Three layers, each killing a specific mutant:
 *
 * 1. measurement (`measureSurface`, `countLines`) — a `__tests__` path segment classifies a file as
 *    a test, never the extension, because on the `scripts` surface tests are `.ts` and sources are
 *    `.mjs`. Fixtures include a `.d.mts` (neither surface) and a non-`__tests__` `.ts` on the
 *    scripts surface (neither surface) so a classifier that keys off the extension alone fails here.
 * 2. verdict (`evaluate`) — every surface is judged against its OWN ceiling, `>` and not `>=` is the
 *    breach, the warning band is non-failing and only exists where a surface declares one.
 * 3. the CLI contract (`main`, plus one real spawn) — exit 0 within budget / 1 a finding / 2 usage
 *    or unreadable input, both surfaces printed on every run, output identical between runs.
 *
 * Fixtures are written to a temp directory, never into `scripts/__tests__/`: a fixture counted as a
 * test line would inflate the very ratio this guard enforces (and the `scripts` ceiling is 1.0).
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
	SURFACES,
	WALL_CEILING_MS,
	countLines,
	evaluate,
	findUntestedScripts,
	formatSurface,
	importSpecifiers,
	main,
	measureSurface,
	parseArgs,
	readWallMs,
} from "../check-test-budget.mjs";

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
 *  writes its lines verbatim (so a fixture can hold a real import statement). */
function tree(name: string, files: Record<string, number | string[]>): string {
	const root = join(TMP, name);
	for (const [path, content] of Object.entries(files)) {
		const full = join(root, path);
		mkdirSync(dirname(full), { recursive: true });
		writeFileSync(full, Array.isArray(content) ? `${content.join("\n")}\n` : "// fixture\n".repeat(content));
	}
	return root;
}

/** A `scripts/__tests__` file that imports the fixture guard — the floor's import, plus filler lines. */
function importer(lines: number): string[] {
	return ['import { guard } from "../guard.mjs";', ...Array.from({ length: lines - 1 }, () => "// filler")];
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

	it("renders one line per surface, with the band only where a surface declares one", () => {
		const root = tree("format", {
			"scripts/guard.mjs": 10,
			"scripts/__tests__/guard.test.ts": 5,
			"src/module.ts": 10,
			"src/__tests__/module.test.ts": 15,
		});
		expect(formatSurface(measureSurface(surface("scripts"), root))).toBe(
			"test-budget: scripts 0.50 (5 test / 10 source LOC, ceiling 1.0)",
		);
		expect(formatSurface(measureSurface(surface("src"), root))).toBe(
			"test-budget: src 1.50 (15 test / 10 source LOC, ceiling 2.0, warn at 1.95)",
		);
	});
});

describe("evaluate — each surface against its own ceiling", () => {
	const measured = (name: string, sourceLoc: number, testLoc: number) => ({
		name,
		sourceFiles: [],
		testFiles: [],
		sourceLoc,
		testLoc,
		ratio: testLoc / sourceLoc,
		ceiling: surface(name).ceiling,
		warnAt: surface(name).warnAt,
	});

	const verdict = (surfaces: ReturnType<typeof measured>[], wallMs = 1_000) =>
		evaluate({ reportPath: "report.json", wallMs, surfaces });

	it("passes a ratio exactly at the ceiling — the breach is `>`, not `>=`", () => {
		const { findings, warnings } = verdict([measured("src", 100, 200), measured("scripts", 100, 100)]);
		expect(findings).toEqual([]);
		// 200/100 is at the 2.0 ceiling and inside the band: a warning with zero headroom, not a finding.
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("0 test lines of headroom");
	});

	it("names the surface it breaches — scripts first, its own ceiling", () => {
		const { findings } = verdict([measured("src", 100, 150), measured("scripts", 100, 101)]);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toContain('surface "scripts" test:source LOC ratio 1.01 (101 test / 100 source)');
		expect(findings[0]).toContain("the 1.0 ceiling");
	});

	it("names the src surface and its 2.0 ceiling, never the scripts one", () => {
		const { findings } = verdict([measured("src", 100, 201), measured("scripts", 100, 50)]);
		expect(findings).toHaveLength(1);
		expect(findings[0]).toContain('surface "src" test:source LOC ratio 2.01 (201 test / 100 source)');
		expect(findings[0]).toContain("the 2.0 ceiling");
	});

	it("reports both breaches in one run rather than the first one found", () => {
		const { findings } = verdict([measured("src", 10, 21), measured("scripts", 10, 11)]);
		expect(findings).toHaveLength(2);
		expect(findings.join("\n")).toContain('surface "scripts"');
		expect(findings.join("\n")).toContain('surface "src"');
	});

	it("warns inside the band without failing, and is silent below it", () => {
		const band = verdict([measured("src", 100, 195)]);
		expect(band.findings).toEqual([]);
		expect(band.warnings).toHaveLength(1);
		expect(band.warnings[0]).toContain("inside the 1.95 warning band");
		expect(band.warnings[0]).toContain("5 test lines of headroom");
		expect(verdict([measured("src", 100, 194)]).warnings).toEqual([]);
	});

	it("has no band on the scripts surface — a surface without warnAt never warns", () => {
		const { findings, warnings } = verdict([measured("scripts", 100, 99)]);
		expect(findings).toEqual([]);
		expect(warnings).toEqual([]);
	});

	it("fails the wall ceiling above 60 s and passes it at exactly 60 s", () => {
		expect(verdict([measured("src", 10, 10)], WALL_CEILING_MS + 10).findings[0]).toContain(
			"wall time 60.01s exceeds the 60.00s ceiling",
		);
		expect(verdict([measured("src", 10, 10)], WALL_CEILING_MS).findings).toEqual([]);
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

describe("findUntestedScripts — an import, not a mention", () => {
	it("names a script that only a comment or a string mentions", () => {
		const root = tree("floor-mention", {
			"scripts/guard.mjs": 1,
			"scripts/orphan.mjs": 1,
			"scripts/__tests__/guard.test.ts": ['import "../guard.mjs";', "// see ../orphan.mjs", 'const path = "../orphan.mjs";'],
		});
		expect(findUntestedScripts(root)).toEqual(["orphan.mjs"]);
	});

	it("reads require/import/dynamic import in nested test files, and ignores non-test helpers", () => {
		const root = tree("floor-forms", {
			"scripts/a.mjs": 1,
			"scripts/b.mjs": 1,
			"scripts/c.mjs": 1,
			"scripts/__tests__/deep/nested.test.ts": ['const a = require("../../a.mjs");'],
			"scripts/__tests__/helpers.ts": ['import "../b.mjs";', 'import "../c.mjs";'],
			"scripts/__tests__/c.test.ts": ['void import("../c.mjs");'],
		});
		// `helpers.ts` is not a `*.test.ts`: a helper importing a script proves nothing.
		expect(findUntestedScripts(root)).toEqual(["b.mjs"]);
	});

	it("treats a missing test directory as nothing imported", () => {
		expect(findUntestedScripts(tree("floor-absent", { "scripts/guard.mjs": 1 }))).toEqual(["guard.mjs"]);
	});

	it("reads only module requests, never a prose mention", () => {
		expect(importSpecifiers('import { a } from "../x.mjs";\n// ../comment.mjs\nconst s = "../string.mjs";')).toEqual(["../x.mjs"]);
	});
});

describe("main — the two streams and the exit codes", () => {
	it("reports both surfaces every run, in name order, and exits 0", () => {
		const root = tree("cli-ok", {
			"scripts/guard.mjs": 10,
			"scripts/__tests__/guard.test.ts": importer(9),
			"src/module.ts": 10,
			"src/__tests__/module.test.ts": 15,
		});
		const path = report("ok", 1_000);
		const { code, out, err } = run([path], root);
		expect(code).toBe(0);
		expect(err).toEqual([]);
		expect(out).toEqual([
			`test-budget: wall 1.00s (<= 60.00s, report: ${path})`,
			"test-budget: scripts 0.90 (9 test / 10 source LOC, ceiling 1.0)",
			"test-budget: src 1.50 (15 test / 10 source LOC, ceiling 2.0, warn at 1.95)",
			"test-budget: OK.",
		]);
	});

	it("fails on a scripts breach but still prints the src surface", () => {
		const root = tree("cli-scripts-breach", {
			"scripts/guard.mjs": 10,
			"scripts/__tests__/guard.test.ts": importer(11),
			"src/module.ts": 10,
			"src/__tests__/module.test.ts": 15,
		});
		const { code, out, err } = run([report("breach", 1_000)], root);
		expect(code).toBe(1);
		expect(err).toHaveLength(1);
		expect(err[0]).toContain('surface "scripts"');
		expect(out.some((line) => line.startsWith("test-budget: src "))).toBe(true);
		expect(out).not.toContain("test-budget: OK.");
	});

	it("keeps the band non-failing on the src surface", () => {
		const root = tree("cli-band", {
			"scripts/guard.mjs": 10,
			"scripts/__tests__/guard.test.ts": importer(5),
			"src/module.ts": 100,
			"src/__tests__/module.test.ts": 196,
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
			"src/__tests__/module.test.ts": 5,
		});
		const path = report("wall", WALL_CEILING_MS + 10);
		const { code, err } = run([path], root);
		expect(code).toBe(1);
		expect(err.join("\n")).toContain(`wall time 60.01s exceeds the 60.00s ceiling (report: ${path}`);
	});

	it("fails the floor when a gate script has no importer, naming the script", () => {
		const root = tree("cli-floor", {
			"scripts/guard.mjs": 10,
			"scripts/orphan.mjs": 10,
			"scripts/__tests__/guard.test.ts": importer(5),
			"src/module.ts": 10,
			"src/__tests__/module.test.ts": 5,
		});
		const { code, err } = run([report("floor", 1_000)], root);
		expect(code).toBe(1);
		expect(err).toEqual([
			"test-budget: scripts floor: no test under scripts/__tests__ imports orphan.mjs — " +
				"a gate script without a test is the gap the ratio cannot see (an import, not a mention).",
		]);
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
			"src/__tests__/module.test.ts": 5,
		});
		const path = report("deterministic", 1_000);
		expect(run([path], root).out).toEqual(run([path], root).out);
	});

	it("passes against the real tree — the ratchet, on the committed sources", () => {
		// The committed tree is the thing this guard measures in CI; a red result here means the
		// repository breached its own budget, not that a fixture is wrong.
		const { code, out } = run([report("real", 1_000)], ROOT);
		expect(code).toBe(0);
		expect(ratioIn(out, "scripts")).toBeLessThanOrEqual(1);
		expect(ratioIn(out, "src")).toBeLessThanOrEqual(2);
	});
});

describe("the CLI as CI runs it", () => {
	it("exits 1 and names the surface when spawned as a real process", () => {
		const root = tree("spawn", {
			"scripts/guard.mjs": 10,
			"scripts/__tests__/guard.test.ts": importer(20),
			"src/module.ts": 10,
			"src/__tests__/module.test.ts": 5,
		});
		const result = spawnSync(process.execPath, [SCRIPT, report("spawn", 1_000)], { cwd: root, encoding: "utf8" });
		expect(result.status).toBe(1);
		expect(result.stdout).toContain("test-budget: scripts 2.00 (20 test / 10 source LOC, ceiling 1.0)");
		expect(result.stderr).toContain('surface "scripts"');
	});
});

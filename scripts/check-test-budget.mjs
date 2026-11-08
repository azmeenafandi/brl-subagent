#!/usr/bin/env node
// Purpose: Pins the suite's wall time and each surface's test:source LOC ratio to a ceiling (issues #368, #490).
//
// The suite reached 82 files / 1701 tests with a ~15 s local wall; test LOC was 1.62x source LOC.
// This guard reads the JSON reporter output CI already produces and fails when a budget is exceeded,
// so growth needs a reason.
//
// TWO SURFACES since #490. 2.0 was always meant for `src/__tests__`; the cycle's tooling lives in
// `scripts/**/*.mjs`, which the old single-surface guard could not see (and whose tests would have
// landed in `src/__tests__` and breached the ceiling on the first unit). So each surface is measured
// and reported on its own:
//
//   src      source `src/**/*.ts` minus `__tests__`; tests `src/**/__tests__/**/*.ts`; ceiling 2.0
//   scripts  source `scripts/**/*.mjs` minus `__tests__`; tests `scripts/__tests__/**/*.ts`; ceiling 1.0
//
// A `__tests__` path segment is the classifier — never the extension — because on the `scripts`
// surface tests are `.ts` and sources are `.mjs`. Every surface is reported on every run, even when
// another one breaches; either breach fails the run.
//
// A WARNING BAND (`src` at ratio >= 1.95) exists because 2.0 is a cliff: growth inside the last 2.5%
// prints on stderr and still exits 0, so the next breach is visible before it happens. The band is
// non-failing by design — it is a signal, not a second ceiling.
//
// A FLOOR CHECK covers the gap no ratio can see: a gate script nobody tests adds source, which
// IMPROVES the ratio. So every top-level `scripts/*.mjs` must be imported by a test file under
// `scripts/__tests__/**.test.ts` — an import statement, not a mention, because a path named in a
// comment proves nothing.
//
// The limits are CEILINGS, not targets: shrinking is always allowed. The wall is read from the
// report's own timestamps (start -> last file end), not measured by this script, so it reflects
// vitest's run and not this check; CI runner speed still varies, which is why the 60 s ceiling keeps
// margin over the ~18 s local wall. The wall ceiling stays GLOBAL — it is one suite on one runner.
//
// Output is deterministic: surfaces are reported in name order, and no timestamp or duration of this
// check appears anywhere. Counts are read from disk (the real tree), never hardcoded.
//
// Usage: node scripts/check-test-budget.mjs <vitest-json-report>
//        node scripts/check-test-budget.mjs --report <vitest-json-report>
//   CI: npx vitest run --reporter=default --reporter=json --outputFile=vitest-report.json
// Exit: 0 within budget (warnings allowed) · 1 a finding · 2 usage, unreadable report or tree.
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { basename, extname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** Local suite wall-time ceiling (ms). Current local wall: ~18 s. Global to every surface. */
export const WALL_CEILING_MS = 60_000;

/** The path segment that classifies a file as a test. Shared by every surface. */
export const TEST_DIR_NAME = "__tests__";

/**
 * The measured surfaces, in report order (sorted by name at report time, so this order is not load
 * bearing). `sourceExtension` / `testExtension` are exact extensions: `scripts/check-imports.d.mts`
 * is `.mts` and belongs to neither surface — declared type files carry no logic to test.
 */
export const SURFACES = Object.freeze([
	Object.freeze({
		name: "scripts",
		dir: "scripts",
		sourceExtension: ".mjs",
		testExtension: ".ts",
		ceiling: 1.0,
		warnAt: null,
	}),
	Object.freeze({
		name: "src",
		dir: "src",
		sourceExtension: ".ts",
		testExtension: ".ts",
		ceiling: 2.0,
		warnAt: 1.95,
	}),
]);

export const USAGE = "usage: check-test-budget.mjs <vitest-json-report> | --report <vitest-json-report>";

/**
 * The floor check's corpus: every top-level `scripts/*.mjs` must be imported by a `*.test.ts` under
 * `scripts/__tests__/`. Constants rather than re-typed paths, so the guard and its message cannot
 * disagree about which directory they mean.
 */
export const FLOOR = Object.freeze({
	dir: "scripts",
	testDir: join("scripts", TEST_DIR_NAME),
	scriptExtension: ".mjs",
	testSuffix: ".test.ts",
});

function message(error) {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Report — wall time from the JSON reporter, start to the last file end.
// ---------------------------------------------------------------------------

/** Wall time of the run the report describes, in ms. Throws on anything that is not that report. */
export function readWallMs(reportPath) {
	let text;
	try {
		text = readFileSync(reportPath, "utf8");
	} catch (error) {
		throw new Error(`${reportPath}: cannot read the vitest JSON report (${message(error)}).`);
	}
	let report;
	try {
		report = JSON.parse(text);
	} catch (error) {
		throw new Error(`${reportPath}: not JSON (${message(error)}).`);
	}
	const results = report?.testResults;
	if (typeof report?.startTime !== "number" || !Array.isArray(results) || results.length === 0) {
		throw new Error(`${reportPath}: no startTime/testResults — is this vitest's json reporter output?`);
	}
	const endTimes = results.map((result) => result?.endTime).filter((value) => typeof value === "number" && Number.isFinite(value));
	if (endTimes.length === 0) {
		throw new Error(`${reportPath}: testResults carry no endTime — is this vitest's json reporter output?`);
	}
	return Math.max(...endTimes) - report.startTime;
}

// ---------------------------------------------------------------------------
// Surfaces — counted from disk (the real tree), never hardcoded.
// ---------------------------------------------------------------------------

/** Every file under `dir`, recursively, as sorted `join(dir, …)` paths. */
export function collectFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...collectFiles(full));
		else if (entry.isFile()) files.push(full);
	}
	return files.sort();
}

/** Physical lines, matching `wc -l` (a trailing newline starts no extra line). */
export function countLines(file) {
	const text = readFileSync(file, "utf8");
	const newlines = text.match(/\n/g);
	return newlines ? newlines.length : 0;
}

/**
 * Measure one surface under `root`: its source and test files (both sorted) and their LOC.
 * Throws when the tree is unreadable or holds no source — an empty numerator would make the ratio
 * a meaningless pass, so the guard refuses to compute it.
 */
export function measureSurface(surface, root = process.cwd()) {
	let files;
	try {
		files = collectFiles(join(root, surface.dir));
	} catch (error) {
		throw new Error(`${surface.dir}: cannot read the tree (${message(error)}).`);
	}
	const sourceFiles = [];
	const testFiles = [];
	for (const file of files) {
		const extension = extname(file);
		if (file.split(/[\\/]/).includes(TEST_DIR_NAME)) {
			if (extension === surface.testExtension) testFiles.push(file);
		} else if (extension === surface.sourceExtension) {
			sourceFiles.push(file);
		}
	}
	const sourceLoc = sourceFiles.reduce((total, file) => total + countLines(file), 0);
	if (sourceLoc === 0) {
		throw new Error(`${surface.dir}: no source (${surface.sourceExtension} outside ${TEST_DIR_NAME}) lines found — cannot compute the ratio.`);
	}
	const testLoc = testFiles.reduce((total, file) => total + countLines(file), 0);
	return {
		name: surface.name,
		sourceFiles,
		testFiles,
		sourceLoc,
		testLoc,
		ratio: testLoc / sourceLoc,
		ceiling: surface.ceiling,
		warnAt: surface.warnAt,
	};
}

/** One line per surface: numerator, denominator, ceiling, and the band when the surface has one. */
export function formatSurface(surface) {
	const band = surface.warnAt === null ? "" : `, warn at ${surface.warnAt.toFixed(2)}`;
	return (
		`test-budget: ${surface.name} ${surface.ratio.toFixed(2)} ` +
		`(${surface.testLoc} test / ${surface.sourceLoc} source LOC, ceiling ${surface.ceiling.toFixed(1)}${band})`
	);
}

function formatMs(ms) {
	return `${(ms / 1000).toFixed(2)}s`;
}

// ---------------------------------------------------------------------------
// Floor — a gate script nobody imports is a gate nobody runs.
// ---------------------------------------------------------------------------

/**
 * The module specifiers a source text imports or requires: `from "x"`, a side-effect `import "x"`,
 * a dynamic `import("x")` and `require("x")`. A path merely named in a comment or a string carries
 * none of those keywords and is never matched — the floor is an import, not a mention.
 */
export function importSpecifiers(text) {
	return [...text.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\brequire\s*\(\s*|\bimport\s+)(["'])([^"'\n]+)\1/g)].map(
		(match) => match[2],
	);
}

/**
 * Top-level `scripts/*.mjs` files that no `scripts/__tests__/**.test.ts` imports, sorted.
 * A missing test directory is a floor failure (nothing imports anything), not an IO failure.
 */
export function findUntestedScripts(root = process.cwd()) {
	let scriptNames;
	try {
		scriptNames = readdirSync(join(root, FLOOR.dir), { withFileTypes: true })
			.filter((entry) => entry.isFile() && entry.name.endsWith(FLOOR.scriptExtension))
			.map((entry) => entry.name)
			.sort();
	} catch (error) {
		throw new Error(`${FLOOR.dir}: cannot read the tree (${message(error)}).`);
	}

	const testsDir = join(root, FLOOR.testDir);
	const testFiles = existsSync(testsDir) ? collectFiles(testsDir).filter((file) => file.endsWith(FLOOR.testSuffix)) : [];

	const imported = new Set();
	for (const file of testFiles) {
		for (const specifier of importSpecifiers(readFileSync(file, "utf8"))) {
			// A relative specifier is a file in this repo; a bare one is a package, never a script.
			if (specifier.startsWith(".")) imported.add(basename(specifier));
		}
	}
	return scriptNames.filter((name) => !imported.has(name));
}

// ---------------------------------------------------------------------------
// Verdict — report every breach, then one summary. Pure: no IO, no exits.
// ---------------------------------------------------------------------------

/** Test lines still available before the surface breaches (a ratio of exactly the ceiling is allowed). */
function headroom(surface) {
	return Math.max(0, Math.floor(surface.ceiling * surface.sourceLoc) - surface.testLoc);
}

function lines(count) {
	return `${count} test line${count === 1 ? "" : "s"}`;
}

export function evaluate({ reportPath, wallMs, wallCeilingMs = WALL_CEILING_MS, surfaces, untested = [] }) {
	const findings = [];
	const warnings = [];
	if (wallMs > wallCeilingMs) {
		findings.push(
			`wall time ${formatMs(wallMs)} exceeds the ${formatMs(wallCeilingMs)} ceiling by ${wallMs - wallCeilingMs} ms ` +
				`(report: ${reportPath}; the ceiling is a limit, not a target).`,
		);
	}
	for (const surface of surfaces) {
		if (surface.ratio > surface.ceiling) {
			// The overage is stated in whole lines: a ratio printed to two decimals can round to the
			// ceiling it just breached (56198/28097 = 2.0004 prints as 2.00), and "2.00 exceeds 2.0"
			// reads as a bug in the guard. The exact line count cannot round away.
			findings.push(
				`surface "${surface.name}" test:source LOC ratio ${surface.ratio.toFixed(2)} ` +
					`(${surface.testLoc} test / ${surface.sourceLoc} source) exceeds the ${surface.ceiling.toFixed(1)} ceiling ` +
					`by ${lines(surface.testLoc - Math.floor(surface.ceiling * surface.sourceLoc))} ` +
					`(report: ${reportPath}; the ceiling is a limit, not a target).`,
			);
		} else if (surface.warnAt !== null && surface.ratio >= surface.warnAt) {
			warnings.push(
				`surface "${surface.name}" test:source LOC ratio ${surface.ratio.toFixed(2)} ` +
					`(${surface.testLoc} test / ${surface.sourceLoc} source) is inside the ${surface.warnAt.toFixed(2)} warning band — ` +
					`${headroom(surface)} test lines of headroom under the ${surface.ceiling.toFixed(1)} ceiling.`,
			);
		}
	}
	if (untested.length > 0) {
		findings.push(
			`scripts floor: no test under ${FLOOR.testDir} imports ${untested.join(", ")} — ` +
				"a gate script without a test is the gap the ratio cannot see (an import, not a mention).",
		);
	}
	return { findings, warnings };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

/** `{ ok: true, reportPath }` or `{ ok: false, message }` — never throws, never exits. */
export function parseArgs(argv) {
	let reportPath;
	const takePath = (value) => {
		if (value === undefined || value.startsWith("--")) return "--report needs a path";
		if (reportPath !== undefined) return `unexpected argument: ${value}`;
		reportPath = value;
		return undefined;
	};
	for (let index = 0; index < argv.length; index += 1) {
		const arg = argv[index];
		if (arg === "--report") {
			const error = takePath(argv[index + 1]);
			if (error !== undefined) return { ok: false, message: error };
			index += 1;
		} else if (arg.startsWith("--")) {
			return { ok: false, message: `unknown flag: ${arg}` };
		} else {
			const error = takePath(arg);
			if (error !== undefined) return { ok: false, message: error };
		}
	}
	if (reportPath === undefined) return { ok: false, message: "missing the vitest JSON report path" };
	return { ok: true, reportPath };
}

/** Run the guard. Returns the exit code; every line of output goes through `out` / `err`. */
export function main(argv = process.argv.slice(2), { root = process.cwd(), out = console.log, err = console.error } = {}) {
	const parsed = parseArgs(argv);
	if (!parsed.ok) {
		err(`${USAGE}\n${parsed.message}`);
		return 2;
	}
	const { reportPath } = parsed;

	let wallMs;
	let surfaces;
	let untested;
	try {
		wallMs = readWallMs(reportPath);
		surfaces = [...SURFACES].sort((a, b) => (a.name < b.name ? -1 : 1)).map((surface) => measureSurface(surface, root));
		untested = findUntestedScripts(root);
	} catch (error) {
		err(`test-budget: ${message(error)}`);
		return 2;
	}

	const { findings, warnings } = evaluate({ reportPath, wallMs, surfaces, untested });

	out(`test-budget: wall ${formatMs(wallMs)} (<= ${formatMs(WALL_CEILING_MS)}, report: ${reportPath})`);
	for (const surface of surfaces) out(formatSurface(surface));
	for (const warning of warnings) err(`test-budget: warning: ${warning}`);
	for (const finding of findings) err(`test-budget: ${finding}`);
	if (findings.length > 0) return 1;
	out("test-budget: OK.");
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main());

#!/usr/bin/env node
// Purpose: Pins the test suite's wall-time and test:source LOC ratio to ceilings (issue #368).
//
// The suite reached 82 files / 1701 tests with a ~15 s local wall; test LOC (34,433)
// was 1.62x source LOC (21,238). This guard reads the JSON reporter output CI already
// produces and fails when either budget is exceeded, so growth needs a reason.
//
// The limits are CEILINGS, not targets: shrinking is always allowed. The wall is read
// from the report's own timestamps (start -> last file end), not measured by this
// script, so it reflects vitest's run and not this check; CI runner speed still varies,
// which is why the 60 s ceiling keeps margin over the ~15 s local wall.
//
// Usage: node scripts/check-test-budget.mjs <vitest-json-report>
//   CI: npx vitest run --reporter=default --reporter=json --outputFile=vitest-report.json
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Local suite wall-time ceiling (ms). Current local wall: ~15 s. */
const WALL_CEILING_MS = 60_000;

/** Test lines / source lines ceiling. Current ratio: 1.62. */
const LOC_RATIO_CEILING = 2.0;

/** Source tree measured from disk; paths under a `__tests__` segment are tests. */
const SOURCE_ROOT = "src";
const TEST_DIR_NAME = "__tests__";

const [, , reportPath] = process.argv;
if (!reportPath) {
	console.error("usage: check-test-budget.mjs <vitest-json-report>");
	process.exit(2);
}

function fail(message) {
	console.error(`test-budget: ${message}`);
}

// ---------------------------------------------------------------------------
// Wall time — the report's own start plus the last file's end across workers.
// ---------------------------------------------------------------------------

let report;
try {
	report = JSON.parse(readFileSync(reportPath, "utf8"));
} catch (error) {
	console.error(`${reportPath}: cannot read the vitest JSON report (${error instanceof Error ? error.message : error}).`);
	process.exit(2);
}

const results = report?.testResults;
if (typeof report?.startTime !== "number" || !Array.isArray(results) || results.length === 0) {
	console.error(`${reportPath}: no startTime/testResults — is this vitest's json reporter output?`);
	process.exit(2);
}

const endTimes = results.map((result) => result?.endTime).filter((value) => typeof value === "number" && Number.isFinite(value));
if (endTimes.length === 0) {
	console.error(`${reportPath}: testResults carry no endTime — is this vitest's json reporter output?`);
	process.exit(2);
}

const wallMs = Math.max(...endTimes) - report.startTime;

// ---------------------------------------------------------------------------
// LOC ratio — counted from disk (the real tree), never hardcoded.
// ---------------------------------------------------------------------------

/** Every `.ts` file under `dir`, recursively. */
function collectTypeScriptFiles(dir) {
	const files = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) files.push(...collectTypeScriptFiles(full));
		else if (entry.isFile() && entry.name.endsWith(".ts")) files.push(full);
	}
	return files;
}

/** Physical lines, matching `wc -l` (a trailing newline starts no extra line). */
function countLines(file) {
	const text = readFileSync(file, "utf8");
	const newlines = text.match(/\n/g);
	return newlines ? newlines.length : 0;
}

let files;
try {
	files = collectTypeScriptFiles(SOURCE_ROOT);
} catch (error) {
	console.error(`${SOURCE_ROOT}: cannot read the source tree (${error instanceof Error ? error.message : error}).`);
	process.exit(2);
}

let testLoc = 0;
let sourceLoc = 0;
for (const file of files) {
	const isTest = file.split(/[\\/]/).includes(TEST_DIR_NAME);
	if (isTest) testLoc += countLines(file);
	else sourceLoc += countLines(file);
}

if (sourceLoc === 0) {
	console.error(`${SOURCE_ROOT}: no source (non-__tests__) TypeScript lines found — cannot compute the ratio.`);
	process.exit(2);
}

const locRatio = testLoc / sourceLoc;

// ---------------------------------------------------------------------------
// Verdict — report every breach, then one summary.
// ---------------------------------------------------------------------------

let failed = false;
if (wallMs > WALL_CEILING_MS) {
	fail(
		`wall time ${formatMs(wallMs)} exceeds the ${formatMs(WALL_CEILING_MS)} ceiling ` +
			`(report: ${reportPath}; the ceiling is a limit, not a target).`,
	);
	failed = true;
}
if (locRatio > LOC_RATIO_CEILING) {
	fail(
		`test:source LOC ratio ${locRatio.toFixed(2)} (${testLoc} test / ${sourceLoc} source) ` +
			`exceeds the ${LOC_RATIO_CEILING.toFixed(1)} ceiling (the ceiling is a limit, not a target).`,
	);
	failed = true;
}

if (failed) process.exit(1);

console.log(
	`test-budget: wall ${formatMs(wallMs)} (<= ${formatMs(WALL_CEILING_MS)}), ` +
		`LOC ratio ${locRatio.toFixed(2)} (${testLoc} test / ${sourceLoc} source, <= ${LOC_RATIO_CEILING.toFixed(1)}) — OK.`,
);

function formatMs(ms) {
	return `${(ms / 1000).toFixed(2)}s`;
}

#!/usr/bin/env node
// Purpose: Pins the README's "<N>+ test suite" claim to the real test count (docs-pinning class, issue #166).
//
// The claim had drifted ~240 tests stale (975+ against 1212 real) because nothing checked it. This
// script runs in CI right after the suite: it reads the JSON reporter output and fails when the
// README overstates the count, or trails it by more than DRIFT_LIMIT (so the claim stays fresh
// without demanding an edit on every test added).
//
// Usage: node scripts/check-readme-test-count.mjs <vitest-json-report>
//   CI: npx vitest run --reporter=default --reporter=json --outputFile=vitest-report.json
import { readFileSync } from "node:fs";

/** How far the claimed floor may trail the real count before the claim is considered stale. */
const DRIFT_LIMIT = 100;

const [, , reportPath] = process.argv;
if (!reportPath) {
	console.error("usage: check-readme-test-count.mjs <vitest-json-report>");
	process.exit(2);
}

const claim = /(\d[\d,]*)\+\s+test suite/.exec(readFileSync("README.md", "utf8"));
if (!claim) {
	console.error('README.md: no "<N>+ test suite" claim found — keep the claim greppable (e.g. "a 1200+ test suite").');
	process.exit(1);
}
const claimed = Number(claim[1].replace(/,/g, ""));

const actual = JSON.parse(readFileSync(reportPath, "utf8")).numTotalTests;
if (typeof actual !== "number") {
	console.error(`${reportPath}: no numTotalTests — is this vitest's json reporter output?`);
	process.exit(2);
}

if (claimed > actual) {
	console.error(`README claims ${claimed}+ tests but only ${actual} ran — the claim overstates reality.`);
	process.exit(1);
}
if (actual - claimed > DRIFT_LIMIT) {
	console.error(
		`README claims ${claimed}+ tests but ${actual} ran — update the claim in README.md (drift limit: ${DRIFT_LIMIT}).`,
	);
	process.exit(1);
}
console.log(`readme-test-count: README says ${claimed}+, suite ran ${actual} — OK (drift limit ${DRIFT_LIMIT}).`);

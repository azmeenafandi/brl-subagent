#!/usr/bin/env node
// Purpose: Pins the README's "<N>+ test suite" claim to the real test count (docs-pinning class, issue #166).
//
// The claim had drifted ~240 tests stale (975+ against 1212 real) because nothing checked it. This
// script runs in CI right after the suite and checks two different invariants against the JSON
// reporter output (issue #469 split them apart, because they belong at different seams):
//
//   truth (always)      the claim must never overstate reality — `claimed > actual` fails. This is a
//                       property of the branch, so it runs on every PR and every push.
//   freshness (--strict) the claim may trail the real count by at most DRIFT_LIMIT. That is a
//                       property of the *merged tree*, so a task PR based on `dev` cannot satisfy it
//                       (the merge-ref race cost #459 a cycle). Freshness is enforced at the release
//                       seam only — the release PR (base `main`) and the push that lands it.
//
// --bump rewrites the claim mechanically (the release ritual's step 5), so freshness is a command,
// not a hand edit.
//
// Usage: node scripts/check-readme-test-count.mjs <vitest-json-report> [--strict | --bump]
//   CI: npx vitest run --reporter=default --reporter=json --outputFile=vitest-report.json
//   exit 1 = the claim is wrong (overstated, stale, or missing); exit 2 = usage / unreadable report.
import { readFileSync, writeFileSync } from "node:fs";

/** How far the claimed floor may trail the real count before the claim is considered stale. */
const DRIFT_LIMIT = 100;

/** The claim's shape — greppable, and the anchor the bump rewrites. */
const CLAIM_RE = /(\d[\d,]*)\+\s+test suite/;

/** `--bump` floors to the hundred: 2358 -> 2300, so the claim is a floor, never an overstatement. */
const BUMP_STEP = 100;

const USAGE = "usage: check-readme-test-count.mjs <vitest-json-report> [--strict | --bump]";

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith("--"));
const positional = args.filter((a) => !a.startsWith("--"));

const unknown = flags.filter((f) => f !== "--strict" && f !== "--bump");
if (unknown.length > 0) {
	console.error(`${USAGE}\nunknown flag: ${unknown.join(" ")}`);
	process.exit(2);
}
if (flags.includes("--strict") && flags.includes("--bump")) {
	console.error(`${USAGE}\n--strict and --bump are mutually exclusive — run --bump, then --strict.`);
	process.exit(2);
}
const strict = flags.includes("--strict");
const bump = flags.includes("--bump");

const [reportPath] = positional;
if (!reportPath) {
	console.error(USAGE);
	process.exit(2);
}

const readme = readFileSync("README.md", "utf8");
const claim = CLAIM_RE.exec(readme);
if (!claim) {
	console.error('README.md: no "<N>+ test suite" claim found — keep the claim greppable (e.g. "a 1200+ test suite").');
	process.exit(1);
}
const claimed = Number(claim[1].replace(/,/g, ""));

let actual;
try {
	actual = JSON.parse(readFileSync(reportPath, "utf8")).numTotalTests;
} catch (error) {
	console.error(`${reportPath}: could not read the report — ${error.message}`);
	process.exit(2);
}
if (typeof actual !== "number") {
	console.error(`${reportPath}: no numTotalTests — is this vitest's json reporter output?`);
	process.exit(2);
}

if (bump) {
	const target = Math.floor(actual / BUMP_STEP) * BUMP_STEP;
	if (target < BUMP_STEP) {
		console.error(
			`refusing to bump: ${actual} tests floors to ${target}+ (under ${BUMP_STEP}) — a lower claim is worse than a stale one.`,
		);
		process.exit(2);
	}
	if (target === claimed) {
		console.log(`readme-test-count: README already says ${claimed}+ for ${actual} ran — nothing to bump.`);
		process.exit(0);
	}
	const line = claim[0].replace(claim[1], String(target));
	writeFileSync("README.md", readme.slice(0, claim.index) + line + readme.slice(claim.index + claim[0].length));
	if (target < claimed) {
		console.warn(
			`readme-test-count: the suite SHRANK — ${claimed}+ was correct for a bigger run; the claim moves DOWN to ${target}+ for ${actual} ran.`,
		);
	}
	console.log(`readme-test-count: bump ${claimed}+ → ${target}+ (${actual} tests ran).`);
	process.exit(0);
}

if (claimed > actual) {
	console.error(`README claims ${claimed}+ tests but only ${actual} ran — the claim overstates reality.`);
	process.exit(1);
}
if (strict && actual - claimed > DRIFT_LIMIT) {
	console.error(
		`README claims ${claimed}+ tests but ${actual} ran — update the claim in README.md (drift ${actual - claimed}, limit ${DRIFT_LIMIT}).`,
	);
	process.exit(1);
}
if (strict) {
	console.log(
		`readme-test-count: README says ${claimed}+, suite ran ${actual} — OK (drift ${actual - claimed} of limit ${DRIFT_LIMIT}).`,
	);
} else {
	console.log(
		`readme-test-count: README says ${claimed}+, suite ran ${actual} — OK (truth only; freshness runs at the release seam).`,
	);
}

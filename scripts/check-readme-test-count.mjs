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
// Shape (issue #490): the body lives in `main`, which takes its argv and returns its exit code, and
// the two pure decisions (`readClaim`, `bumpedClaim`) are exported. Nothing runs at import time, so
// `scripts/__tests__/` can import this file — the test-budget floor check requires an import, and a
// module that exits 2 on import has no test that can import it.
//
// Usage: node scripts/check-readme-test-count.mjs <vitest-json-report> [--strict | --bump]
//   CI: npx vitest run --reporter=default --reporter=json --outputFile=vitest-report.json
//   exit 1 = the claim is wrong (overstated, stale, or missing); exit 2 = usage / unreadable report.
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/** How far the claimed floor may trail the real count before the claim is considered stale. */
export const DRIFT_LIMIT = 100;

/** The claim's shape — greppable, and the anchor the bump rewrites. */
export const CLAIM_RE = /(\d[\d,]*)\+\s+test suite/;

/** `--bump` floors to the hundred: 2358 -> 2300, so the claim is a floor, never an overstatement. */
export const BUMP_STEP = 100;

export const USAGE = "usage: check-readme-test-count.mjs <vitest-json-report> [--strict | --bump]";

/**
 * The claim as the README states it: the value, the matched text and its offset (the bump's anchor),
 * or `null` when the README holds no greppable claim.
 */
export function readClaim(readme) {
	const match = CLAIM_RE.exec(readme);
	if (match === null) return null;
	return { claimed: Number(match[1].replace(/,/g, "")), text: match[0], rawNumber: match[1], index: match.index };
}

/** Where `--bump` moves the claim: floored to the hundred, so it stays a floor. */
export function bumpedClaim(actual) {
	return Math.floor(actual / BUMP_STEP) * BUMP_STEP;
}

/** Run the guard. Returns the exit code; README.md and a relative report path resolve under `root`. */
export function main(argv = process.argv.slice(2), { root = process.cwd(), log = console.log, warn = console.warn, error = console.error } = {}) {
	const flags = argv.filter((a) => a.startsWith("--"));
	const positional = argv.filter((a) => !a.startsWith("--"));

	const unknown = flags.filter((f) => f !== "--strict" && f !== "--bump");
	if (unknown.length > 0) {
		error(`${USAGE}\nunknown flag: ${unknown.join(" ")}`);
		return 2;
	}
	if (flags.includes("--strict") && flags.includes("--bump")) {
		error(`${USAGE}\n--strict and --bump are mutually exclusive — run --bump, then --strict.`);
		return 2;
	}
	const strict = flags.includes("--strict");
	const bump = flags.includes("--bump");

	const [reportPath] = positional;
	if (!reportPath) {
		error(USAGE);
		return 2;
	}

	const readmePath = join(root, "README.md");
	const readme = readFileSync(readmePath, "utf8");
	const claim = readClaim(readme);
	if (claim === null) {
		error('README.md: no "<N>+ test suite" claim found — keep the claim greppable (e.g. "a 1200+ test suite").');
		return 1;
	}
	const { claimed } = claim;

	let actual;
	try {
		actual = JSON.parse(readFileSync(resolve(root, reportPath), "utf8")).numTotalTests;
	} catch (failure) {
		error(`${reportPath}: could not read the report — ${failure instanceof Error ? failure.message : String(failure)}`);
		return 2;
	}
	if (typeof actual !== "number") {
		error(`${reportPath}: no numTotalTests — is this vitest's json reporter output?`);
		return 2;
	}

	if (bump) {
		const target = bumpedClaim(actual);
		if (target < BUMP_STEP) {
			error(
				`refusing to bump: ${actual} tests floors to ${target}+ (under ${BUMP_STEP}) — a lower claim is worse than a stale one.`,
			);
			return 2;
		}
		if (target === claimed) {
			log(`readme-test-count: README already says ${claimed}+ for ${actual} ran — nothing to bump.`);
			return 0;
		}
		const line = claim.text.replace(claim.rawNumber, String(target));
		writeFileSync(readmePath, readme.slice(0, claim.index) + line + readme.slice(claim.index + claim.text.length));
		if (target < claimed) {
			warn(
				`readme-test-count: the suite SHRANK — ${claimed}+ was correct for a bigger run; the claim moves DOWN to ${target}+ for ${actual} ran.`,
			);
		}
		log(`readme-test-count: bump ${claimed}+ → ${target}+ (${actual} tests ran).`);
		return 0;
	}

	if (claimed > actual) {
		error(`README claims ${claimed}+ tests but only ${actual} ran — the claim overstates reality.`);
		return 1;
	}
	if (strict && actual - claimed > DRIFT_LIMIT) {
		error(
			`README claims ${claimed}+ tests but ${actual} ran — update the claim in README.md (drift ${actual - claimed}, limit ${DRIFT_LIMIT}).`,
		);
		return 1;
	}
	if (strict) {
		log(`readme-test-count: README says ${claimed}+, suite ran ${actual} — OK (drift ${actual - claimed} of limit ${DRIFT_LIMIT}).`);
	} else {
		log(`readme-test-count: README says ${claimed}+, suite ran ${actual} — OK (truth only; freshness runs at the release seam).`);
	}
	return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main());

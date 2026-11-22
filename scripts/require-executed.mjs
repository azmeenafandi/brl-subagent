#!/usr/bin/env node
// Purpose: a filtered vitest run must have EXECUTED a test before its green means anything (issue #591).
//
// Why a wrapper and not a note in a skill: `npx vitest run <file> -t "<title>"` exits 0 when the title
// matches nothing. Measured at vitest 5.1.0 / node 24:
//
//   npx vitest run scripts/__tests__/pr-evidence.test.ts -t "a title that does not exist zzz"
//   → Tests 44 skipped (44), exit 0, JSON report {passed 0, failed 0, pending 44, success true}
//
// A receipt that says `success: true` for a run that ran nothing is the defect class #591 files: the
// row it is pasted under claims a filtered probe passed. The guard is arithmetic, not policy —
// `executed = passed + failed`, and `executed === 0` is a failure no matter what the process exited.
//
//   node scripts/require-executed.mjs [--verbose] -- <vitest args…>
//
// THE PREDICATE IS DELIBERATELY FLAT — one early return, then the failure check, then success:
//
//   const executed = report.numPassedTests + report.numFailedTests;   // skipped is NOT executed
//   if (executed === 0) return fail("0 tests executed — the filter matched nothing")
//   if (failed)         return fail("… executed / … failed")
//   return ok("require-executed: … executed / … passed")
//
// A second, separate "zero executed" branch ABOVE this one would make the predicate unreachable to a
// mutation of `executed === 0` — the mutant would be killed by the branch above it, and the regression
// test would prove nothing (the review of the first draft measured exactly that). One branch, so the
// mutant has somewhere to land.
//
// Exit contract, in order (each case measured, not assumed):
//   1. no `--` → 2 (`usage: require-executed -- <vitest args>`) — a caller error, not a finding;
//   2. vitest's own non-zero exit → PROPAGATED as-is, after the report is read:
//        `/no/such.test.ts`  vitest 1, report present but empty → `0 executed — the run failed before
//                            collecting (1)`
//        a failing fixture   vitest 1, report {failed 1}       → `1 executed / 1 failed (…)`
//        `--reporter=bogus`  vitest 1, NO report               → the vitest code, named as such
//   3. a MISSING or UNPARSABLE report after a ZERO exit → 2 — a broken harness, not a finding about the
//      suite, and never a silent pass;
//   4. then the predicate above.
//
// `--verbose` passes vitest's own stdout/stderr through. By default one line is printed: the summary on
// success, the reason on stderr otherwise.
//
// This file is a CLI, not a library: `verdict()` is exported so its three branches can be exercised
// without a subprocess, and the regression test (`scripts/__tests__/require-executed.test.ts`) drives
// the real CLI against real fixtures — a filter that matches nothing must be RED in CI, and today it is
// the only thing that would be.
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The checkout this script lives in — vitest runs here, so a relative filter resolves like a bare run. */
export const ROOT = join(HERE, "..");

export const EXIT = Object.freeze({ OK: 0, REFUSED: 1, USAGE: 2 });

export const USAGE = `usage: require-executed -- <vitest args…>

  Runs \`vitest run\` with a JSON reporter and refuses a run that executed no test:
    executed = numPassedTests + numFailedTests      (skipped is not executed)
    executed === 0                                  → exit 1, "0 tests executed"
    a failure, or a non-zero vitest exit            → that code, propagated
    a missing/unparsable report after a zero exit    → exit 2 (a broken harness)
  --verbose   pass vitest's own output through (default: one summary line)
  exit 0 ok · 1 the suite/selection failed · 2 usage or a broken harness`;

/** `{ ok: true, options }` or `{ ok: false, message }` — never throws, never exits. */
export function parseArgs(argv) {
	const options = { verbose: false, extra: [] };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--") {
			options.extra = argv.slice(index + 1);
			return options.extra.length === 0
				? { ok: false, message: "no vitest arguments after `--`" }
				: { ok: true, options };
		}
		if (argument === "--verbose") {
			options.verbose = true;
			continue;
		}
		// Anything else before `--` is a caller error: this tool's own flags are one, and a vitest flag outside
		// the `--` arm would be silently swallowed by the wrapper instead of reaching vitest.
		return { ok: false, message: `unknown flag before \`--\`: ${argument} — vitest arguments go after \`--\`` };
	}
	return { ok: false, message: "a vitest command must follow `--`" };
}

/** The report's four counters, or `null` when the file is absent, unparsable, or not a report. */
export function readReport(path) {
	let parsed;
	try {
		parsed = JSON.parse(readFileSync(path, "utf8"));
	} catch {
		return null;
	}
	const counters = ["numPassedTests", "numFailedTests", "numTotalTests"];
	if (counters.some((key) => typeof parsed?.[key] !== "number")) return null;
	return {
		passed: parsed.numPassedTests,
		failed: parsed.numFailedTests,
		total: parsed.numTotalTests,
	};
}

/**
 * The predicate, in one place and in one shape: the zero-executed branch is the ONLY early return before
 * the failure check, so a mutation of its condition changes the outcome of an all-skipped run.
 *
 * `runExit` is vitest's own status — a non-zero run is a failure even when the counters look clean (a
 * collection error after a passing file), and its code wins because the caller reads exit codes.
 */
export function verdict(report, runExit, where) {
	const executed = report.passed + report.failed; // skipped is NOT executed
	const failed = runExit !== 0 || report.failed > 0;
	const code = failed ? (runExit !== 0 ? runExit : EXIT.REFUSED) : EXIT.OK;
	if (executed === 0) {
		return failed
			? { code: code || EXIT.REFUSED, message: `0 executed — the run failed before collecting (${runExit})` }
			: { code: EXIT.REFUSED, message: `0 tests executed — the filter matched nothing (${where})` };
	}
	if (failed) {
		return {
			code,
			message: report.failed > 0
				? `${executed} executed / ${report.failed} failed (${where})`
				: `${executed} executed, but the run exited ${runExit} (${where})`,
		};
	}
	return { code: EXIT.OK, message: `require-executed: ${executed} executed / ${report.passed} passed — ${where}` };
}

/** The `where` clause every message ends with: the vitest arguments, or the whole suite when there are none. */
export function whereFrom(extra) {
	return extra.length === 0 ? "the whole suite" : extra.join(" ");
}

/**
 * Run vitest into a throwaway JSON report. The report lives in a temp directory, not the tree: it is a
 * transient, not evidence — `scripts/suite-report.mjs` is the producer for a report that is evidence.
 */
export function runVitest(extra, options = {}) {
	const { verbose = false, cwd = ROOT } = options;
	const dir = mkdtempSync(join(tmpdir(), "require-executed-"));
	const reportPath = join(dir, "report.json");
	try {
		const result = spawnSync(
			"npx",
			["vitest", "run", "--reporter=json", `--outputFile=${reportPath}`, ...extra],
			{ cwd, encoding: "utf8", stdio: verbose ? "inherit" : "pipe" },
		);
		// A signal instead of a status is still a failure, and `null` is not a number to propagate.
		const status = typeof result.status === "number" ? result.status : 1;
		return { status, report: readReport(reportPath), reportPath, stderr: result.stderr ?? "" };
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

export function main(argv = process.argv.slice(2), io = {}) {
	const out = io.out ?? console.log;
	const err = io.err ?? console.error;
	const parsed = parseArgs(argv);
	if (!parsed.ok) {
		err(`${USAGE}\n${parsed.message}`);
		return EXIT.USAGE;
	}
	const { verbose, extra } = parsed.options;
	const result = io.run === undefined ? runVitest(extra, { verbose }) : io.run(extra, { verbose });
	if (result.report === null) {
		// A zero exit with no report is a harness fault: the run claims to have finished, and the one
		// artifact that says what it did is not there. That is exit 2, never a pass (#591 §1 rule 3).
		if (result.status === 0) {
			err(`require-executed: the JSON report was missing or unparsable after a clean exit (${result.reportPath}) — the harness is broken, not the suite`);
			return EXIT.USAGE;
		}
		err(`require-executed: no usable JSON report and vitest exited ${result.status} — the run failed before writing one`);
		return result.status;
	}
	const judged = verdict(result.report, result.status, whereFrom(extra));
	(judged.code === EXIT.OK ? out : err)(judged.message);
	return judged.code;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main());

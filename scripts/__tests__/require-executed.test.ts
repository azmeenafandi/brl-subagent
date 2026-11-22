/**
 * Tests for `scripts/require-executed.mjs` (issue #591) — a filtered vitest run must have EXECUTED a test
 * before its green means anything.
 *
 * The defect this pins, measured at vitest 5.1.0 / node 24: `vitest run <file> -t "<absent title>"` exits 0
 * with every test SKIPPED, and its JSON report says `passed 0 / failed 0 / pending 44 / success true`. A
 * receipt pasted under a "the filtered probe passes" row is therefore true of a run that ran nothing.
 *
 * WHAT MAKES THIS TEST ABLE TO FAIL (the point of the file, not a formality): each case drives the REAL
 * CLI as a subprocess against a REAL vitest run, so the assertions are about exit codes and the printed
 * summary, not about a branch reached in a mock. The controls the review of the first draft demanded are
 * named in the PR: M1 (the zero-executed predicate widened to `numTotalTests === 0`) turns the absent-title
 * case green with exit 0, and M2 (the failure return deleted) turns the failing-fixture case green with
 * exit 0. Both were measured on a scratch copy, not asserted here.
 *
 * WHERE THE FIXTURES LIVE, and why it matters: a fixture in `os.tmpdir()` is NOT collectable — vitest
 * resolves its root and its include patterns relative to the project, so a `/tmp` fixture either matches
 * nothing (a "failing" case that never ran) or cannot resolve `vitest` at all. The fixture directory is
 * therefore created INSIDE `scripts/__tests__/` with `mkdtemp`, so the checkout's `node_modules` resolves
 * from it, and it is removed in `afterAll`.
 *
 * Measured, not guessed: `--root <fixture> --dir <fixture>` alone collects the fixtures — no
 * `vitest.config.ts` is written into the fixture, because the root flag was enough (the spec's fallback).
 *
 * The fixture files are `.test.mjs`, deliberately NOT `.test.ts`: the shipped `vitest.config.ts` includes
 * `scripts/__tests__/**\/*.test.ts`, so a `.test.ts` fixture would be collected by the outer suite and a
 * failing fixture would turn the whole suite red. `.mjs` is inside vitest's default include for the
 * fixture root and outside the repository's `include`.
 */
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { EXIT } from "../require-executed.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The checkout under test — the CLI and its fixture root both resolve from here. */
const ROOT = join(HERE, "..", "..");
const CLI = join(ROOT, "scripts", "require-executed.mjs");

/** A fixture root inside the project, so `node_modules` resolves from a directory vitest can collect. */
let fixture = "";

/**
 * The child's environment minus vitest's own worker variables: a nested run that inherits `VITEST_*` can
 * believe it is a worker of the outer pool instead of a run of its own.
 */
function childEnv(): NodeJS.ProcessEnv {
	const env: NodeJS.ProcessEnv = { ...process.env };
	for (const key of Object.keys(env)) if (key.startsWith("VITEST")) delete env[key];
	return env;
}

/** One CLI invocation; `output` folds both streams so a message can be asserted wherever it landed. */
function runCli(args: string[]): { status: number | null; output: string } {
	const result = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: "utf8", env: childEnv() });
	return { status: result.status, output: `${result.stdout ?? ""}${result.stderr ?? ""}` };
}

beforeAll(() => {
	fixture = mkdtempSync(join(HERE, "fx-"));
	writeFileSync(join(fixture, "pass.test.mjs"), 'import { expect, it } from "vitest";\nit("passes", () => { expect(1).toBe(1); });\n');
	writeFileSync(join(fixture, "fail.test.mjs"), 'import { expect, it } from "vitest";\nit("fails", () => { expect(1).toBe(2); });\n');
});

afterAll(() => {
	rmSync(fixture, { recursive: true, force: true });
});

/** The fixture-root invocation: the root flags first, then the file filter the wrapper forwards. */
function fixtureArgs(file: string, ...extra: string[]): string[] {
	return ["--", "--root", fixture, "--dir", fixture, ...extra, join(fixture, file)];
}

describe("require-executed: the executed-test predicate (#591)", () => {
	it("the exit contract this file asserts is the module's own (#591 §1)", () => {
		// The three codes are quoted in the spec and in the CLI's docstring; a test that hardcoded
		// different literals could drift from the contract while still passing.
		expect(EXIT).toEqual({ OK: 0, REFUSED: 1, USAGE: 2 });
	});

	it("a passing fixture is green: exit 0, one executed, one passed", () => {
		const { status, output } = runCli(fixtureArgs("pass.test.mjs"));
		expect(output).toContain("require-executed: 1 executed / 1 passed — ");
		expect(status).toBe(EXIT.OK);
	});

	it("a failing fixture is red: vitest's own code, and the failure is named", () => {
		const { status, output } = runCli(fixtureArgs("fail.test.mjs"));
		expect(output).toContain("1 executed / 1 failed");
		expect(status).toBe(EXIT.REFUSED);
	});

	it("a filter that matches nothing is RED, not a green run of zero tests", () => {
		// The defect itself: vitest exits 0 here, so only the executed count can catch it.
		const { status, output } = runCli(fixtureArgs("pass.test.mjs", "-t", "a title that does not exist zzz"));
		expect(output).toContain("0 tests executed — the filter matched nothing");
		expect(status).toBe(EXIT.REFUSED);
	});

	it("a path that does not exist propagates vitest's code and names the pre-collection failure", () => {
		const { status, output } = runCli(["--", "/no/such.test.ts"]);
		expect(output).toContain("0 executed — the run failed before collecting");
		expect(status).toBe(1);
	});

	it("no `--` is a usage error: exit 2 and the usage line", () => {
		const { status, output } = runCli([]);
		expect(output).toContain("usage: require-executed -- <vitest args");
		expect(status).toBe(EXIT.USAGE);
	});
});

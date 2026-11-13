/**
 * Issue #511 (U2) — the scratch root at the spawn seam.
 *
 * The contract under test, in the order the brief states it:
 *
 *   1. ONE seam per surface. The foreground seam is `runSubagent` (the
 *      chokepoint single/chain/parallel/graph/retry all pass through); the
 *      background seam is `spawnBackgroundSession` (covered in
 *      `background-session-persistence.test.ts`, which already drives the real
 *      SDK). This file owns the foreground half and the module itself.
 *   2. `$BRL_SCRATCH` is AUTHORITATIVE: set as an `envOverrides` entry (applied
 *      last by `getSafeEnv`), replaced rather than inherited, never allowlisted.
 *   3. The resolver never reads it: a child cannot steer its own root, and a
 *      nested child resolves a DIFFERENT run.
 *   4. Failure is named and PRE-SPAWN: no child starts.
 *   5. Settle writes `.done`; prune removes only settled, aged runs.
 *   6. The tmpfs advisory is one line per process, not one per run.
 *
 * Fixtures live under the repository's gitignored `.tmp/` chain: the shipped
 * resolver refuses an ancestor-writable parent, and `os.tmpdir()` is exactly
 * that on a normal Linux host.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock spawn so the foreground seam never launches a real process — and so the
// test can observe the filesystem AT the instant the child would start.
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", () => ({ spawn: mocks.spawn }));

import { __resetScratchWarning, __setScratchRoot, markSettled, prepareRunScratch, SCRATCH_ENV_KEY } from "../scratch-spawn";
import { DONE_MARKER, TMPFS_MAGIC } from "../scratch-root";
import { runSubagent } from "../runner";
import { finalizeRunRecord } from "../history";
import { createUnitRun } from "../unit-run";
import { getSafeEnv } from "../sanitize";
import { EMPTY_USAGE, isSubagentError, type SubagentResult, type SubagentRun } from "../types";
import type { Logger } from "../logging";

const REPO = process.cwd();
const BASE = join(REPO, ".tmp");
mkdirSync(BASE, { recursive: true });
const WORK = mkdtempSync(join(BASE, "scratch-spawn-"));

/** A `tmpfs`-free mount probe: the advisory path is asserted by injection only. */
const EXT4 = () => ({ type: 0xef53 });

let counter = 0;

/** One throwaway `$HOME` per test, 0700, inside the safe `.tmp` chain. */
function sandbox(): string {
	const dir = join(WORK, `home-${(counter += 1)}`);
	mkdirSync(dir, { mode: 0o700 });
	return dir;
}

/** The Linux layout for an injected home. */
function rootOf(home: string): string {
	return join(home, ".cache", "brl-subagent");
}

/** A logger that records instead of writing: the seam's only outbound channel. */
function recorder(): { log: Logger; warns: string[]; debugs: string[] } {
	const warns: string[] = [];
	const debugs: string[] = [];
	const log: Logger = {
		debug: (m) => void debugs.push(m),
		info: () => {},
		warn: (m) => void warns.push(m),
		error: () => {},
	};
	return { log, warns, debugs };
}

/** A fake child that closes cleanly, so `runSubagent` resolves. */
function fakeProc() {
	const proc = {
		stdout: { on: vi.fn() },
		stderr: { on: vi.fn() },
		on: vi.fn((event: string, cb: (code?: number) => void) => {
			if (event === "close") cb(0);
			return proc;
		}),
		kill: vi.fn(),
		pid: 4242,
	};
	return proc as never;
}

/** The env `runSubagent` handed the child. */
function spawnedEnv(): Record<string, string> {
	return (mocks.spawn.mock.calls[0][2] as { env: Record<string, string> }).env;
}

/** A minimal successful result for the settle-marker tests. */
function result(overrides: Partial<SubagentResult> = {}): SubagentResult {
	return { messages: [], usage: { ...EMPTY_USAGE }, exitCode: 0, stderr: "", ...overrides };
}

/** A run record whose only interesting field is the scratch directory. */
function runRecord(scratchDir?: string): SubagentRun {
	return {
		id: "run-settle",
		task: "settle",
		status: "running",
		model: "test/model",
		thinkingLevel: "medium",
		startedAt: new Date().toISOString(),
		scratchDir,
	};
}

/** A scratch root that already exists at 0700 beneath an injected home. */
function preparedRoot(home: string): string {
	const root = rootOf(home);
	mkdirSync(root, { recursive: true, mode: 0o700 });
	return root;
}

beforeEach(() => {
	mocks.spawn.mockReset();
	mocks.spawn.mockReturnValue(fakeProc());
	__resetScratchWarning();
});

afterEach(() => {
	__setScratchRoot(join(BASE, `scratch-vitest-${process.pid}`));
	delete process.env.BRL_SCRATCH;
});

afterAll(() => {
	rmSync(WORK, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The seam itself
// ---------------------------------------------------------------------------

describe("prepareRunScratch — resolve, create, prune", () => {
	it("creates `<root>/runs/<id>` at 0700 and reports the root", () => {
		const home = sandbox();
		const prepared = prepareRunScratch("run-a", { root: { platform: "linux", env: {}, home, statfs: EXT4 } });

		expect(prepared).toEqual({ ok: true, root: rootOf(home), runDir: join(rootOf(home), "runs", "run-a") });
		// The mode is the confidentiality boundary, and `mkdir`'s mode is masked
		// by the umask — so the on-disk mode is the assertion, not the argument.
		expect(statSync(prepared.ok && prepared.runDir).mode & 0o777).toBe(0o700);
		expect(statSync(rootOf(home)).mode & 0o777).toBe(0o700);
	});

	it("names an unresolvable root and creates NOTHING", () => {
		const home = sandbox();
		const prepared = prepareRunScratch("run-b", { root: { platform: "linux", env: {}, home: "", statfs: EXT4 } });

		expect(prepared).toMatchObject({ ok: false, code: "home-unresolvable" });
		expect(existsSync(rootOf(home))).toBe(false);
	});

	it("names a creation refusal (a root that is not a directory) and starts nothing", () => {
		const home = sandbox();
		const root = rootOf(home);
		mkdirSync(join(home, ".cache"), { recursive: true, mode: 0o700 });
		writeFileSync(root, "not a directory");

		const prepared = prepareRunScratch("run-c", { root: { platform: "linux", env: {}, home, statfs: EXT4 } });
		expect(prepared).toMatchObject({ ok: false, code: "root-not-dir" });
	});

	it("prunes an aged settled run, keeps an unmarked one, and never prunes the current run", () => {
		const home = sandbox();
		const root = preparedRoot(home);
		const runs = join(root, "runs");
		const aged = join(runs, "aged-done");
		const unmarked = join(runs, "old-unmarked");
		mkdirSync(aged, { recursive: true, mode: 0o700 });
		mkdirSync(unmarked, { recursive: true, mode: 0o700 });
		writeFileSync(join(aged, DONE_MARKER), "");
		// The retention clock is the MARKER's mtime, so age the marker, not the dir.
		const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		utimesSync(join(aged, DONE_MARKER), old, old);

		const prepared = prepareRunScratch("current", { root: { platform: "linux", env: {}, home, statfs: EXT4 } });
		expect(prepared.ok).toBe(true);

		expect(existsSync(aged)).toBe(false);
		// "No marker" is not evidence of death: a live or crashed run keeps its bank.
		expect(existsSync(unmarked)).toBe(true);
		expect(existsSync(join(runs, "current"))).toBe(true);
	});

	it("surfaces the tmpfs advisory ONCE per process, not once per run", () => {
		const home = sandbox();
		const sink = recorder();
		const tmpfs = () => ({ type: TMPFS_MAGIC });
		const root = { platform: "linux" as const, env: {}, home, statfs: tmpfs };

		expect(prepareRunScratch("run-1", { root, log: sink.log }).ok).toBe(true);
		expect(prepareRunScratch("run-2", { root, log: sink.log }).ok).toBe(true);

		expect(sink.warns.filter((m) => m.includes("tmpfs"))).toHaveLength(1);
	});

	it("a THROWING prune never fails the spawn — it is logged and the directory stands", () => {
		const home = sandbox();
		const sink = recorder();
		const prepared = prepareRunScratch("run-prune", {
			root: { platform: "linux", env: {}, home, statfs: EXT4 },
			log: sink.log,
			// A sweep that throws is the worst case the containment exists for.
			prune: () => {
				throw new Error("sweep exploded");
			},
		});

		expect(prepared.ok).toBe(true);
		expect(existsSync(join(rootOf(home), "runs", "run-prune"))).toBe(true);
		expect(sink.warns.some((m) => m.includes("prune failed"))).toBe(true);
	});

	it("excludes the current run from its own sweep — a re-prepared run keeps its directory", () => {
		// The re-prepare is real, not hypothetical: the foreground record site and the
		// spawn seam both prepare, and a retry re-enters with the same id. Age and mark
		// the directory so ONLY the exclusion can save it — without it, the sweep
		// deletes the very directory the spawn is about to use.
		const home = sandbox();
		const root = { platform: "linux" as const, env: {}, home, statfs: EXT4 };
		const first = prepareRunScratch("same-id", { root });
		if (!first.ok) throw new Error(first.message);
		writeFileSync(join(first.runDir, DONE_MARKER), "");
		const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		utimesSync(join(first.runDir, DONE_MARKER), old, old);

		const second = prepareRunScratch("same-id", { root });
		expect(second.ok).toBe(true);
		expect(existsSync(first.runDir)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// The foreground seam
// ---------------------------------------------------------------------------

describe("runSubagent — the foreground scratch seam", () => {
	/** A dispatch cwd that carries no `package.json`, so no engineering bar is read. */
	function dispatchCwd(): string {
		return mkdtempSync(join(WORK, "cwd-"));
	}

	/** `runSubagent`'s argument list, in its declared order. */
	function callForeground(cwd: string, runId: string | undefined): Promise<SubagentResult> {
		return runSubagent(
			cwd,
			"",
			{ provider: "test", id: "model" },
			"medium",
			"Review the auth flow",
			undefined,
			undefined,
			undefined,
			undefined,
			() => "",
			undefined,
			undefined,
			undefined,
			undefined,
			undefined,
			runId,
		);
	}

	it("creates the run directory BEFORE the child starts and passes it as BRL_SCRATCH", async () => {
		const cwd = dispatchCwd();
		const runId = "11111111-1111-4111-8111-111111111111";
		const expected = join(BASE, `scratch-vitest-${process.pid}`, "runs", runId);

		let atSpawn: { exists: boolean; mode: number } | undefined;
		mocks.spawn.mockImplementation(() => {
			atSpawn = { exists: existsSync(expected), mode: existsSync(expected) ? statSync(expected).mode & 0o777 : 0 };
			return fakeProc();
		});

		await callForeground(cwd, runId);

		// The invariant is about the instant the child starts, not about what the
		// call left behind: a dir created after `spawn` would fail here.
		expect(atSpawn).toEqual({ exists: true, mode: 0o700 });
		expect(spawnedEnv()[SCRATCH_ENV_KEY]).toBe(expected);
	});

	it("REPLACES an inherited BRL_SCRATCH instead of trusting it", async () => {
		const cwd = dispatchCwd();
		const runId = "22222222-2222-4222-8222-222222222222";
		const expected = join(BASE, `scratch-vitest-${process.pid}`, "runs", runId);

		// A hijack value in the parent's environment: the child must not see it.
		process.env.BRL_SCRATCH = "/tmp/hijack";

		await callForeground(cwd, runId);

		expect(spawnedEnv()[SCRATCH_ENV_KEY]).toBe(expected);
		expect(spawnedEnv()[SCRATCH_ENV_KEY]).not.toBe("/tmp/hijack");
		// Belt: the key is not on the allowlist either, so nothing inherits it.
		expect(getSafeEnv()[SCRATCH_ENV_KEY]).toBeUndefined();
	});

	it("a nested run resolves a DIFFERENT directory — a parent's value is never its root", () => {
		const first = prepareRunScratch("parent-run");
		// The grandchild would inherit the parent's env; the resolver ignores it.
		process.env.BRL_SCRATCH = first.ok ? first.runDir : "/tmp/hijack";
		const second = prepareRunScratch("child-run");

		expect(first.ok && second.ok).toBe(true);
		expect(second.ok && second.runDir).not.toBe(first.ok && first.runDir);
		// Both live under the SAME root and name different runs.
		expect(second.ok && second.root).toBe(first.ok && first.root);
		expect(second.ok && second.runDir).toBe(join(second.ok ? second.root : "", "runs", "child-run"));
	});

	it("a refused root returns an error result and starts NO child", async () => {
		const cwd = dispatchCwd();
		// A root that cannot be a directory: the resolver's own clause refuses it.
		const notARoot = join(WORK, "not-a-root");
		writeFileSync(notARoot, "");
		__setScratchRoot(notARoot);

		const refused = await callForeground(cwd, "33333333-3333-4333-8333-333333333333");

		expect(mocks.spawn).not.toHaveBeenCalled();
		expect(isSubagentError(refused)).toBe(true);
		expect(refused.errorMessage).toContain("scratch root unavailable (root-not-dir)");
		expect(refused.exitCode).not.toBe(0);
	});

	it("no run id means no scratch directory (the non-dispatch callers)", async () => {
		const cwd = dispatchCwd();
		await callForeground(cwd, undefined);
		expect(spawnedEnv()[SCRATCH_ENV_KEY]).toBeUndefined();
	});
});

/**
 * The optional `runId` parameter above is a hole if a DISPATCH call site omits
 * it: the child would silently start with no scratch directory. TypeScript
 * cannot enforce it (optional by necessity — the non-dispatch callers and these
 * tests pass none), so the guard is structural: every `runSubagent(` call in the
 * two dispatch modules must pass a run id.
 */
describe("every dispatch call site passes a run id", () => {
	/** The argument text of each `runSubagent(...)` call, by balanced parens. */
	function callArguments(source: string): string[] {
		const calls: string[] = [];
		for (let at = source.indexOf("runSubagent("); at !== -1; at = source.indexOf("runSubagent(", at + 1)) {
			let depth = 0;
			for (let index = at + "runSubagent".length; index < source.length; index += 1) {
				const char = source[index];
				if (char === "(") depth += 1;
				if (char === ")") {
					depth -= 1;
					if (depth === 0) {
						calls.push(source.slice(at, index + 1));
						break;
					}
				}
			}
		}
		return calls;
	}

	it.each(["delegate-handler.ts", "mode-runners.ts"])("%s passes the run record's id", (file) => {
		const source = readFileSync(join(REPO, "src", file), "utf8");
		const calls = callArguments(source);
		expect(calls.length).toBeGreaterThan(0);
		for (const call of calls) {
			expect(call).toMatch(/run\.id,/);
			expect(call).toMatch(/run\.childMarker,/);
		}
	});
});

// ---------------------------------------------------------------------------
// The record and the settle marker
// ---------------------------------------------------------------------------

describe("the run record carries scratchDir", () => {
	beforeEach(() => {
		__setScratchRoot(join(BASE, `scratch-vitest-${process.pid}`));
	});

	it("createUnitRun creates the directory and stamps it on the record", () => {
		const source = {
			task: "unit task",
			inheritSP: false,
			thinkingLevel: "medium",
			effectiveCwd: WORK,
		};
		const { runId, run } = createUnitRun(source, { provider: "test", id: "model" }, "normal");

		expect(run.scratchDir).toBe(join(BASE, `scratch-vitest-${process.pid}`, "runs", runId));
		expect(existsSync(run.scratchDir!)).toBe(true);
		expect(statSync(run.scratchDir!).mode & 0o777).toBe(0o700);
	});
});

describe("markSettled — the terminal marker", () => {
	it("writes `.done` on a DONE run and on a FAILED run", () => {
		const home = sandbox();
		const prepared = prepareRunScratch("run-done", { root: { platform: "linux", env: {}, home, statfs: EXT4 } });
		expect(prepared.ok).toBe(true);
		const run = runRecord(prepared.ok ? prepared.runDir : undefined);

		finalizeRunRecord(run, result(), "ok", Date.now());
		expect(existsSync(join(run.scratchDir!, DONE_MARKER))).toBe(true);
		expect(run.status).toBe("done");

		finalizeRunRecord(run, result({ exitCode: 1, errorMessage: "boom" }), "", Date.now());
		expect(existsSync(join(run.scratchDir!, DONE_MARKER))).toBe(true);
		expect(run.status).toBe("failed");
	});

	it("is a no-op for a run with no scratch directory", () => {
		const run = runRecord(undefined);
		expect(() => finalizeRunRecord(run, result(), "", Date.now())).not.toThrow();
	});

	it("logs a marker failure and never throws — the run's outcome is unchanged", () => {
		const sink = recorder();
		const missing = join(WORK, `gone-${(counter += 1)}`);
		expect(() => markSettled({ id: "run-gone", scratchDir: join(missing, "runs", "run-gone") }, sink.log)).not.toThrow();
		expect(sink.warns).toHaveLength(1);
		expect(sink.warns[0]).toContain("settle marker");
	});
});

/** The retained directory of a run is only reaped once it says it is finished. */
describe("the marker and the sweep agree", () => {
	it("a settled run's directory is prune-eligible; an unmarked one never is", () => {
		const home = sandbox();
		const root = preparedRoot(home);
		const runs = join(root, "runs");
		const settled = join(runs, "settled");
		mkdirSync(settled, { recursive: true, mode: 0o700 });

		markSettled({ id: "settled", scratchDir: settled });
		expect(readdirSync(settled)).toContain(DONE_MARKER);

		const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
		utimesSync(join(settled, DONE_MARKER), old, old);
		prepareRunScratch("next", { root: { platform: "linux", env: {}, home, statfs: EXT4 } });

		expect(existsSync(settled)).toBe(false);
	});
});

/**
 * Issue #474 — the failure path reports the worktree state (S1: the formatter).
 *
 * Rule 11 escalated `connection-drop` after three cycle hits, two of them leaving
 * a mutant applied in a worktree: every death cost the conductor a manual state
 * audit. The block this file pins is what removes that step.
 *
 * These tests run REAL git against scratch repos (precedent: git-real.test.ts),
 * because the assertions are filesystem truths a mock cannot produce: the index
 * mtime after a read, a rename's `-z` record shape, `-uall` expanding an
 * untracked directory. The three failure classes a live environment cannot stage
 * deterministically (missing git, a git timeout, a read that fails AFTER the
 * repo root resolved) are injected at the `execFileSync` seam — and ONLY those:
 * the wrapper delegates every other call to the real binary, so the repo cases
 * stay real.
 *
 * Mutants and their killers:
 *   - drop `GIT_OPTIONAL_LOCKS=0` → W6 (the index mtime moves)
 *   - drop `-uall` → W7 (an untracked dir counts 1 instead of 2)
 *   - count a rename's source record → W7 (the rename counts 2)
 *   - emit the caution line unconditionally → W1
 *   - report the branch but not the dirt → W2
 *   - let a git failure throw / reuse getRepoRoot's catch-all → W3/W4/W8
 *   - treat `rev-parse` as the only fallible read → W8 (a post-root failure)
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import { mkdir, mkdtemp, rm, writeFile, stat, readFile } from "node:fs/promises";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createTempGitRepo, gitRun } from "./fixtures/temp-git-repo";
import { describeWorktreeState } from "../worktree-report";

// ---------------------------------------------------------------------------
// Fault injection at the execFileSync seam (pass-through by default)
// ---------------------------------------------------------------------------

const faults = vi.hoisted(() => ({
	/** Injected failures, matched against `git <args>`; empty = full pass-through. */
	active: [] as Array<{ match: RegExp; error: Error }>,
}));

vi.mock("node:child_process", async (importOriginal) => {
	const actual = await importOriginal<typeof import("node:child_process")>();
	return {
		...actual,
		execFileSync: ((file: string, args: readonly string[] | undefined, opts: unknown) => {
			const line = `${file} ${(args ?? []).join(" ")}`;
			const fault = faults.active.find((entry) => entry.match.test(line));
			if (fault) throw fault.error;
			return (actual.execFileSync as unknown as (...a: unknown[]) => unknown)(file, args, opts);
		}) as typeof actual.execFileSync,
	};
});

/** A staged-spawn failure the way node reports it (measured: empty stderr, a code). */
function spawnError(message: string, code: string): Error {
	return Object.assign(new Error(message), { code, stderr: "", status: null });
}

function faultOn(match: RegExp, error: Error): void {
	faults.active.push({ match, error });
}

function gitAvailable(): boolean {
	try {
		execFileSync("git", ["--version"], { encoding: "utf-8" });
		return true;
	} catch {
		return false;
	}
}

const GIT_OK = gitAvailable();

/** The heading every block opens with — the one spelling callers can look for. */
const HEADING = "Worktree state (git, at failure):";

describe("describeWorktreeState (issue #474)", () => {
	const scratch: string[] = [];

	beforeEach(() => {
		faults.active = [];
	});

	afterAll(async () => {
		for (const dir of scratch) await rm(dir, { recursive: true, force: true });
	});

	async function repo(): Promise<string> {
		const dir = await createTempGitRepo("brl-474-report-");
		scratch.push(dir);
		return dir;
	}

	describe.skipIf(!GIT_OK)("real repositories", () => {
		it("W1 — a clean repo reports the branch and zero counts, with NO caution line", async () => {
			const dir = await repo();

			// Mutant killed: emitting the caution line unconditionally would make
			// every clean failure warn about uncommitted work that is not there.
			expect(describeWorktreeState(dir)).toBe(
				[
					HEADING,
					"  branch: main",
					"  dirty:  0 files",
					"  staged: 0",
				].join("\n"),
			);
		});

		it("W2 — a dirty repo reports the real counts AND the caution line", async () => {
			const dir = await repo();
			// One tracked file modified in the worktree (one line replaced by two),
			// one untracked file, one staged addition: dirty = 2 (modified +
			// untracked), staged = 1.
			await writeFile(join(dir, "base.txt"), "edited\nsecond line\n");
			await writeFile(join(dir, "untracked.txt"), "new\n");
			await writeFile(join(dir, "staged.txt"), "staged\n");
			gitRun(dir, ["add", "staged.txt"]);

			const block = describeWorktreeState(dir);
			expect(block.split("\n")).toEqual([
				HEADING,
				"  branch: main",
				"  dirty:  2 files (+2/−1)",
				"  staged: 1",
				"  — uncommitted work may be a partially applied edit or a mutant; inspect before reusing.",
			]);
		});

		it("W3 — a non-git temp dir is a classified value, never a throw", async () => {
			const dir = await mkdtemp(join(tmpdir(), "brl-474-plain-"));
			scratch.push(dir);

			// Mutant killed: letting the probe's first git call escape (or reusing
			// getRepoRoot's catch-all, which cannot tell "not a repo" from "hung").
			expect(describeWorktreeState(dir)).toBe(`${HEADING}\n  state: unavailable (not a git repository)`);
		});

		it("W4 — no cwd, a relative cwd and a deleted cwd all report unavailable", async () => {
			expect(describeWorktreeState(undefined)).toBe(`${HEADING}\n  state: unavailable (no cwd)`);
			// A pre-#474 background record may hold the relative value the caller
			// passed. Resolving it against the CONDUCTOR's process cwd would report a
			// tree nobody ran in — refused, not guessed.
			expect(describeWorktreeState("relative/path")).toBe(
				`${HEADING}\n  state: unavailable (no recorded cwd)`,
			);

			const dir = await repo();
			await rm(dir, { recursive: true, force: true });
			expect(describeWorktreeState(dir)).toBe(`${HEADING}\n  state: unavailable (cwd does not exist)`);
		});

		it("W5 — detached and unborn HEADs render distinctly", async () => {
			const detached = await repo();
			gitRun(detached, ["checkout", "-q", "--detach", "HEAD"]);
			expect(describeWorktreeState(detached).split("\n")[1]).toBe("  branch: (detached)");

			const unborn = await repo();
			gitRun(unborn, ["checkout", "-q", "--orphan", "unborn-branch"]);
			expect(describeWorktreeState(unborn).split("\n")[1]).toBe("  branch: unborn-branch (unborn)");
		});

		it("W6 — the probe does not write: .git/index bytes AND mtime are unchanged", async () => {
			const dir = await repo();
			// A MODIFIED tracked file makes the index stat-cache stale, which is
			// exactly when `git status` refreshes it — the write this test forbids.
			await writeFile(join(dir, "base.txt"), "base\nchanged\n");
			const indexPath = join(dir, ".git", "index");
			const before = { bytes: await readFile(indexPath), mtimeMs: (await stat(indexPath)).mtimeMs };

			describeWorktreeState(dir);

			const after = { bytes: await readFile(indexPath), mtimeMs: (await stat(indexPath)).mtimeMs };
			// Mutant killed: dropping GIT_OPTIONAL_LOCKS=0 lets the read refresh the
			// index. Measured on this tree: the mtime moves (and the bytes may too).
			expect(after.mtimeMs).toBe(before.mtimeMs);
			expect(Buffer.compare(after.bytes, before.bytes)).toBe(0);
		});

		it("W7 — a rename counts once, and -uall expands an untracked directory", async () => {
			const dir = await repo();
			gitRun(dir, ["mv", "base.txt", "renamed.txt"]);
			// The `-z` rename shape is `R  <new>\0<old>`: counting NUL fields
			// would report 2 files for one rename.
			expect(describeWorktreeState(dir).split("\n").slice(1, 4)).toEqual([
				"  branch: main",
				"  dirty:  0 files",
				"  staged: 1",
			]);

			gitRun(dir, ["reset", "-q", "--hard", "HEAD"]);
			// A DIRECTORY of untracked files: without -uall git collapses it to one
			// `?? newdir/` row, so the count would read 1 instead of 2.
			await mkdir(join(dir, "newdir"));
			await writeFile(join(dir, "newdir", "a.txt"), "a\n");
			await writeFile(join(dir, "newdir", "b.txt"), "b\n");
			expect(describeWorktreeState(dir)).toContain("  dirty:  2 files");
		});

		it("W7b — an embedded repository (what a submodule looks like here) is ONE entry", async () => {
			const dir = await repo();
			// git refuses to descend into another repository, so -uall cannot expand
			// it — the honest count is one row, and it must not be zero.
			gitRun(dir, ["init", "-q", "nested"]);
			const block = describeWorktreeState(dir);
			expect(block).toContain("  dirty:  1 file\n");
			expect(block).toContain("  staged: 0");
		});

		it("W7c — a staged-only change is staged, not dirty, and carries no line counts", async () => {
			const dir = await repo();
			await writeFile(join(dir, "added.txt"), "a\nb\n");
			gitRun(dir, ["add", "added.txt"]);

			const block = describeWorktreeState(dir);
			expect(block).toContain("  dirty:  0 files\n"); // no `(+i/−d)`: nothing unstaged
			expect(block).toContain("  staged: 1");
			// The caution is about UNCOMMITTED work, staged or not.
			expect(block).toContain("inspect before reusing.");
		});

		it("W8 — a read that fails AFTER the repo root resolved is unavailable, not not-repo", async () => {
			const dir = await repo();
			// `rev-parse --is-inside-work-tree` succeeds for real (the probe is
			// inside a repo); the status read then fails. Mutant killed: a probe
			// that only guards its first call throws here, and one that maps any
			// failure to "not a git repository" misreports the repo it just proved.
			faultOn(
				/^git status/,
				Object.assign(new Error("Command failed: git status"), {
					status: 128,
					stderr: "fatal: unable to read tree 0000\n",
				}),
			);
			expect(describeWorktreeState(dir)).toBe(
				`${HEADING}\n  state: unavailable (fatal: unable to read tree 0000)`,
			);
		});

		it("W9 — a missing git and a git timeout classify apart", async () => {
			const dir = await repo();
			faultOn(/^git /, spawnError("spawnSync git ENOENT", "ENOENT"));
			expect(describeWorktreeState(dir)).toBe(`${HEADING}\n  state: unavailable (git is not installed)`);

			faults.active = [];
			faultOn(/^git /, spawnError("spawnSync git ETIMEDOUT", "ETIMEDOUT"));
			expect(describeWorktreeState(dir)).toBe(`${HEADING}\n  state: unavailable (git timed out)`);
		});
	});

	describe("cold git facts (no repo needed)", () => {
		it("W10 — an undefined cwd never reaches git and never throws", () => {
			expect(() => describeWorktreeState(undefined)).not.toThrow();
			expect(describeWorktreeState(undefined)).toContain("state: unavailable (no cwd)");
		});
	});
});

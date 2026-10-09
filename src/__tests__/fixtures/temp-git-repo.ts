/**
 * Shared scratch-git-repo helpers for real-git test suites (Gate A).
 *
 * Git integration tests need a throwaway repository in the OS temp dir that is
 * initialized with a deterministic identity and one base commit. The helpers
 * here are the single definition of that setup; suites import them instead of
 * copy-pasting the same `init`/`config`/`commit` incantations.
 *
 * These helpers run REAL git and therefore throw on failure — callers guard
 * with a git-availability check (see git-real.test.ts `GIT_OK`) before use.
 */
import { execFileSync } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** Run a git command in `cwd`, returning trimmed stdout. Throws on failure. */
export function gitRun(cwd: string, args: string[]): string {
	return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

/**
 * `git init` a repo with a deterministic identity on a `main` branch.
 * Uses `checkout -b main` instead of `init -b main` for portability with
 * git < 2.28.
 */
export function initRepo(dir: string): void {
	gitRun(dir, ["init", "-q"]);
	gitRun(dir, ["checkout", "-q", "-b", "main"]);
	gitRun(dir, ["config", "user.email", "gate-a@test.local"]);
	gitRun(dir, ["config", "user.name", "Gate A"]);
}

/** Write `content` to `name` in `dir` and commit it with message `msg`. */
export async function commitFile(
	dir: string,
	name: string,
	content: string,
	msg: string,
): Promise<void> {
	await writeFile(join(dir, name), content);
	gitRun(dir, ["add", name]);
	gitRun(dir, ["commit", "-q", "-m", msg]);
}

/**
 * Create a fresh throwaway repo in the OS temp dir, initialized on `main`
 * with a single `base.txt` commit. Returns the repo path; the caller owns
 * cleanup (e.g. `rm(dir, { recursive: true, force: true })`).
 */
export async function createTempGitRepo(prefix = "brl-git-"): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	initRepo(dir);
	await commitFile(dir, "base.txt", "base\n", "base commit");
	return dir;
}

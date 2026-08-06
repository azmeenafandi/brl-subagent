/**
 * GATE A — real-tool integration tests (sprint-end agreement 2026-08-05).
 *
 * The git unit tests (git.test.ts) mock node:child_process and can therefore
 * only verify the SHAPE of the calls — they cannot see the truth of the
 * filesystem. The review of PR #50 caught two criticals (C1: `git diff
 * base...HEAD` is empty for uncommitted work; C2: concurrent branch-mode
 * spawns corrupt each other) that mocked tests encoded as the expectation.
 *
 * These tests run REAL git against scratch repos in the OS temp dir and pin
 * the behaviors the background gitMode=branch lifecycle depends on. They are
 * skipped when git/subprocess tests are unavailable (canRunSubprocessTests),
 * and run in CI (ubuntu has git) and the worktree smoke test.
 *
 * The conventions:
 *   - File: *-real.test.ts
 *   - Guard: canRunSubprocessTests() → describe.skip
 *   - Scratch state lives in mkdtemp dirs, cleaned in afterAll
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import {
	getCurrentBranch,
	hasUncommittedChanges,
	createWorkBranch,
	captureDiff,
	switchToBranch,
	deleteBranch,
	commitAll,
	captureWorkingDiff,
} from "../git";

/** Gate A guard: skip when real git is unavailable (CI has it; minimal envs may not). */
function gitAvailable(): boolean {
	try {
		execFileSync("git", ["--version"], { encoding: "utf-8" });
		return true;
	} catch {
		return false;
	}
}

const GIT_OK = gitAvailable();

const run = (cwd: string, args: string[]) =>
	execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();

const gitOpts = (cwd: string) => ({ cwd, encoding: "utf-8" });

function initRepo(dir: string): void {
	run(dir, ["init", "-q", "-b", "main"]);
	run(dir, ["config", "user.email", "gate-a@test.local"]);
	run(dir, ["config", "user.name", "Gate A"]);
}

async function commitFile(dir: string, name: string, content: string, msg: string): Promise<void> {
	await writeFile(join(dir, name), content);
	run(dir, ["add", name]);
	run(dir, ["commit", "-q", "-m", msg]);
}

describe("git.ts real-git behavior (Gate A)", () => {
	const scratchDirs: string[] = [];
	let repo: string;

	beforeAll(async () => {
		if (!GIT_OK) return;
		repo = await mkdtemp(join(tmpdir(), "brl-gate-a-"));
		scratchDirs.push(repo);
		initRepo(repo);
		await commitFile(repo, "base.txt", "base\n", "base commit");
	});

	afterAll(async () => {
		for (const dir of scratchDirs) {
			await rm(dir, { recursive: true, force: true });
		}
	});

	describe.skipIf(!GIT_OK)("C1 regression — uncommitted work", () => {
		it("captureDiff(base...HEAD) is EMPTY for uncommitted changes (the C1 trap)", async () => {
			// The reviewer's empirical finding: agents never commit, so
			// base...HEAD sees nothing. This is the behavior the background
			// lifecycle must compensate for (commitAll before capture).
			const branch = createWorkBranch(repo, "main");
			expect(branch.ok).toBe(true);
			const workBranch = branch.ok ? branch.branch : "";
			await writeFile(join(repo, "agent.txt"), "agent work\n");
			run(repo, ["add", "agent.txt"]);

			const diff = captureDiff(repo, "main");
			expect(diff.ok).toBe(true);
			expect(diff.ok ? diff.diff : "").toBe("");

			// Cleanup: back to main, delete branch.
			switchToBranch(repo, "main");
			deleteBranch(repo, workBranch);
		});

		it("checkout carries uncommitted edits into the base working tree (C1 leak)", async () => {
			const branch = createWorkBranch(repo, "main");
			expect(branch.ok).toBe(true);
			const workBranch = branch.ok ? branch.branch : "";
			await writeFile(join(repo, "agent.txt"), "agent edit\n");

			// The naive switch: dirty edits ride along onto main.
			switchToBranch(repo, "main");
			const leaked = await import("node:fs/promises").then(fs =>
				fs.readFile(join(repo, "agent.txt"), "utf-8").catch(() => "MISSING")
			);
			expect(leaked).toBe("agent edit\n"); // the leak C1 warned about
			await rm(join(repo, "agent.txt"), { force: true });
			deleteBranch(repo, workBranch);
		});

		it("commitAll makes the diff real and the switch clean (the C1 fix)", async () => {
			const branch = createWorkBranch(repo, "main");
			expect(branch.ok).toBe(true);
			const workBranch = branch.ok ? branch.branch : "";
			await writeFile(join(repo, "agent.txt"), "agent work\n");

			const commit = commitAll(repo, "brl-subagent work");
			expect(commit.ok).toBe(true);

			const diff = captureDiff(repo, "main");
			expect(diff.ok).toBe(true);
			expect(diff.ok ? diff.diff : "").toContain("agent.txt");

			// After commit, the tree is clean — switch is safe, no leak.
			switchToBranch(repo, "main");
			const after = await import("node:fs/promises").then(fs =>
				fs.readFile(join(repo, "agent.txt"), "utf-8").catch(() => "MISSING")
			);
			expect(after).toBe("MISSING"); // work stayed on the branch
			deleteBranch(repo, workBranch);
		});

		it("captureWorkingDiff sees unstaged + staged changes", async () => {
			await writeFile(join(repo, "u.txt"), "unstaged\n");
			await writeFile(join(repo, "s.txt"), "staged\n");
			run(repo, ["add", "s.txt"]);

			const diff = captureWorkingDiff(repo);
			expect(diff).toBeDefined();
			expect(diff).toContain("u.txt");
			expect(diff).toContain("s.txt");

			await rm(join(repo, "u.txt"), { force: true });
			await rm(join(repo, "s.txt"), { force: true });
			run(repo, ["checkout", "-q", "--", "."]);
		});
	});

	describe.skipIf(!GIT_OK)("C2 regression — branch lifecycle", () => {
		it("deleteBranch fails when the branch is checked out (the stranding mechanism)", async () => {
			const branch = createWorkBranch(repo, "main");
			expect(branch.ok).toBe(true);
			const workBranch = branch.ok ? branch.branch : "";

			// Still checked out → delete must fail (the reviewer's C2 end state).
			const del = deleteBranch(repo, workBranch);
			expect(del.ok).toBe(false);

			switchToBranch(repo, "main");
			const del2 = deleteBranch(repo, workBranch);
			expect(del2.ok).toBe(true);
		});

		it("a second branch created while the first is live inherits it (C2 setup)", async () => {
			const b1 = createWorkBranch(repo, "main");
			expect(b1.ok).toBe(true);
			const branch1 = b1.ok ? b1.branch : "";
			await writeFile(join(repo, "live.txt"), "from branch1\n");

			// Concurrent spawn B: getCurrentBranch reads branch1, not main.
			const current = getCurrentBranch(repo);
			expect(current).toBe(branch1);

			// B branches FROM A — inheriting A's uncommitted work (C2 bug).
			const b2 = createWorkBranch(repo, current);
			expect(b2.ok).toBe(true);
			const branch2 = b2.ok ? b2.branch : "";
			const inherited = await import("node:fs/promises").then(fs =>
				fs.readFile(join(repo, "live.txt"), "utf-8").catch(() => "MISSING")
			);
			expect(inherited).toBe("from branch1\n");

			// Cleanup: switch to branch1, delete branch2, then main, delete branch1.
			switchToBranch(repo, branch1);
			deleteBranch(repo, branch2);
			switchToBranch(repo, "main");
			deleteBranch(repo, branch1);
			await rm(join(repo, "live.txt"), { force: true });
		});

		it("sequential lifecycle is clean: branch → commit → switch → delete", async () => {
			const b1 = createWorkBranch(repo, "main");
			expect(b1.ok).toBe(true);
			const branch1 = b1.ok ? b1.branch : "";
			await writeFile(join(repo, "seq.txt"), "seq\n");
			commitAll(repo, "seq work");
			switchToBranch(repo, "main");
			expect(deleteBranch(repo, branch1).ok).toBe(true);

			// Second sequential spawn reads main fresh.
			const b2 = createWorkBranch(repo, "main");
			expect(b2.ok).toBe(true);
			const branch2 = b2.ok ? b2.branch : "";
			expect(getCurrentBranch(repo)).toBe(branch2);
			switchToBranch(repo, "main");
			deleteBranch(repo, branch2);
			await rm(join(repo, "seq.txt"), { force: true });
		});
	});
});

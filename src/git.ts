/**
 * brl-subagent — Git Integration (P3)
 *
 * Branch-based git workflow for subagent isolation.
 * All git commands use execSync with a 10-second timeout.
 */

import { execSync } from "node:child_process";

// ---------------------------------------------------------------------------
// Options for git commands
// ---------------------------------------------------------------------------

function gitOpts(cwd: string) {
	return {
		cwd,
		encoding: "utf-8" as const,
		timeout: 10_000,
	};
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Get the current branch name.
 * Throws if the cwd is not a git repository.
 */
export function getCurrentBranch(cwd: string): string {
	const output = execSync("git rev-parse --abbrev-ref HEAD", gitOpts(cwd));
	return output.trim();
}

/**
 * Check if there are uncommitted changes in the working tree.
 */
export function hasUncommittedChanges(cwd: string): boolean {
	const output = execSync("git status --porcelain", gitOpts(cwd));
	return output.trim().length > 0;
}

/**
 * Create a work branch from the given base branch.
 * Returns { ok: true, branch } on success, { ok: false, error } on failure.
 */
export function createWorkBranch(
	cwd: string,
	baseBranch: string,
): { ok: true; branch: string } | { ok: false; error: string } {
	try {
		const branch = "brl-subagent-" + crypto.randomUUID().slice(0, 8);
		execSync(`git checkout -b ${branch} ${baseBranch}`, gitOpts(cwd));
		return { ok: true, branch };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

/**
 * Capture the unified diff between baseBranch and HEAD.
 * Returns { ok: true, diff } on success, { ok: false, error } on failure.
 */
export function captureDiff(
	cwd: string,
	baseBranch: string,
): { ok: true; diff: string } | { ok: false; error: string } {
	try {
		const output = execSync(`git diff ${baseBranch}...HEAD`, gitOpts(cwd));
		return { ok: true, diff: output };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

/**
 * Switch to an existing branch.
 * Returns { ok: true } on success, { ok: false, error } on failure.
 */
export function switchToBranch(
	cwd: string,
	branch: string,
): { ok: true } | { ok: false; error: string } {
	try {
		execSync(`git checkout ${branch}`, gitOpts(cwd));
		return { ok: true };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

/**
 * Delete a branch.
 * Returns { ok: true } on success, { ok: false, error } on failure.
 */
export function deleteBranch(
	cwd: string,
	branch: string,
): { ok: true } | { ok: false; error: string } {
	try {
		execSync(`git branch -D ${branch}`, gitOpts(cwd));
		return { ok: true };
	} catch (err) {
		return { ok: false, error: (err as Error).message };
	}
}

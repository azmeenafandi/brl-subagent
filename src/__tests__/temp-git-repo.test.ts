/**
 * createTempGitRepo setup-failure hygiene (#302 review finding D).
 *
 * Callers only learn the repo path AFTER createTempGitRepo resolves, so a
 * setup failure (git unavailable, init/commit error) between `mkdtemp` and the
 * return would leak a half-initialized temp dir with no one able to clean it
 * up. The helper must remove it itself and rethrow.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// gitRun (used by initRepo/commitFile) must fail deterministically.
const { mockExecFileSync } = vi.hoisted(() => ({ mockExecFileSync: vi.fn() }));
vi.mock("node:child_process", () => ({
	execFileSync: mockExecFileSync,
}));

import { createTempGitRepo } from "./fixtures/temp-git-repo";

const PREFIX = "brl-failclean-";

async function matchingDirs(): Promise<string[]> {
	const names = await fs.readdir(os.tmpdir());
	return names.filter((n) => n.startsWith(PREFIX)).sort();
}

describe("createTempGitRepo setup-failure cleanup", () => {
	beforeEach(() => {
		mockExecFileSync.mockReset();
	});

	it("removes the mkdtemp dir and rethrows when init fails", async () => {
		mockExecFileSync.mockImplementation(() => {
			throw new Error("git exploded");
		});
		const before = await matchingDirs();

		await expect(createTempGitRepo(PREFIX)).rejects.toThrow("git exploded");

		expect(await matchingDirs()).toEqual(before);
	});

	it("removes the mkdtemp dir and rethrows when a later setup step fails", async () => {
		// `git init`/checkout/config succeed; the next git call (staging the base
		// commit) fails.
		mockExecFileSync
			.mockReturnValueOnce("") // git init -q
			.mockReturnValueOnce("") // git checkout -q -b main
			.mockReturnValueOnce("") // git config user.email
			.mockReturnValueOnce(""); // git config user.name
		mockExecFileSync.mockImplementationOnce(() => {
			throw new Error("git add exploded");
		});
		const before = await matchingDirs();

		await expect(createTempGitRepo(PREFIX)).rejects.toThrow("git add exploded");

		expect(await matchingDirs()).toEqual(before);
	});
});

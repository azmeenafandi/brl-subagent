/**
 * Tests for git.ts — Git integration module.
 *
 * Uses vi.mock("node:child_process") to mock execSync.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock execSync before importing the module under test
const mockExecSync = vi.fn();
vi.mock("node:child_process", () => ({
	execSync: mockExecSync,
}));

// Import after mocks are set up
const {
	getCurrentBranch,
	hasUncommittedChanges,
	createWorkBranch,
	captureDiff,
	switchToBranch,
	deleteBranch,
} = await import("../git");

// Reusable { ok, error } failure helper
function expectOk<T extends { ok: false }>(result: T): void {
	expect(result.ok).toBe(false);
	expect(typeof result.error).toBe("string");
}

// ---------------------------------------------------------------------------
// getCurrentBranch
// ---------------------------------------------------------------------------

describe("getCurrentBranch", () => {
	beforeEach(() => {
		mockExecSync.mockReset();
	});

	it("returns the trimmed branch name", () => {
		mockExecSync.mockReturnValue("main\n");
		const branch = getCurrentBranch("/some/project");
		expect(branch).toBe("main");
		expect(mockExecSync).toHaveBeenCalledWith(
			"git rev-parse --abbrev-ref HEAD",
			expect.objectContaining({ cwd: "/some/project", encoding: "utf-8", timeout: 10000 }),
		);
	});

	it("throws when not in a git repository", () => {
		mockExecSync.mockImplementation(() => {
			throw new Error("fatal: not a git repository");
		});
		expect(() => getCurrentBranch("/not/a/repo")).toThrow("not a git repository");
	});
});

// ---------------------------------------------------------------------------
// hasUncommittedChanges
// ---------------------------------------------------------------------------

describe("hasUncommittedChanges", () => {
	beforeEach(() => {
		mockExecSync.mockReset();
	});

	it("returns false when git status is clean", () => {
		mockExecSync.mockReturnValue("");
		expect(hasUncommittedChanges("/repo")).toBe(false);
	});

	it("returns true when there are uncommitted changes", () => {
		mockExecSync.mockReturnValue(" M file.ts\n");
		expect(hasUncommittedChanges("/repo")).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// createWorkBranch
// ---------------------------------------------------------------------------

describe("createWorkBranch", () => {
	beforeEach(() => {
		mockExecSync.mockReset();
	});

	it("returns ok with a branch name prefixed with 'brl-subagent-'", () => {
		mockExecSync.mockReturnValue("");
		const result = createWorkBranch("/repo", "main");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.branch).toMatch(/^brl-subagent-[a-f0-9]{8}$/);
		}
		expect(mockExecSync).toHaveBeenCalledWith(
			expect.stringMatching(/^git checkout -b brl-subagent-[a-f0-9]{8} main$/),
			expect.objectContaining({ cwd: "/repo" }),
		);
	});

	it("returns { ok: false, error } when git command fails", () => {
		mockExecSync.mockImplementation(() => {
			throw new Error("fatal: not a valid object name");
		});
		const result = createWorkBranch("/repo", "nonexistent");
		expectOk(result);
		if (!result.ok) {
			expect(result.error).toContain("not a valid object name");
		}
	});
});

// ---------------------------------------------------------------------------
// captureDiff
// ---------------------------------------------------------------------------

describe("captureDiff", () => {
	beforeEach(() => {
		mockExecSync.mockReset();
	});

	it("returns ok with unified diff output", () => {
		const diffContent = "diff --git a/file.ts b/file.ts\nindex abc..def 100644\n--- a/file.ts\n+++ b/file.ts\n@@ -1,3 +1,4 @@\n+// new line\n const x = 1;\n";
		mockExecSync.mockReturnValue(diffContent);
		const result = captureDiff("/repo", "main");
		expect(result.ok).toBe(true);
		if (result.ok) {
			expect(result.diff).toBe(diffContent);
			expect(result.diff).toContain("diff --git");
		}
	});

	it("returns { ok: false, error } on failure", () => {
		mockExecSync.mockImplementation(() => {
			throw new Error("fatal: ambiguous argument 'main...HEAD'");
		});
		const result = captureDiff("/repo", "main");
		expectOk(result);
	});
});

// ---------------------------------------------------------------------------
// switchToBranch
// ---------------------------------------------------------------------------

describe("switchToBranch", () => {
	beforeEach(() => {
		mockExecSync.mockReset();
	});

	it("returns ok on success", () => {
		mockExecSync.mockReturnValue("");
		const result = switchToBranch("/repo", "main");
		expect(result.ok).toBe(true);
		expect(mockExecSync).toHaveBeenCalledWith(
			"git checkout main",
			expect.objectContaining({ cwd: "/repo" }),
		);
	});

	it("returns { ok: false, error } on failure", () => {
		mockExecSync.mockImplementation(() => {
			throw new Error("error: pathspec 'nope' did not match any file(s) known to git");
		});
		const result = switchToBranch("/repo", "nope");
		expectOk(result);
	});
});

// ---------------------------------------------------------------------------
// deleteBranch
// ---------------------------------------------------------------------------

describe("deleteBranch", () => {
	beforeEach(() => {
		mockExecSync.mockReset();
	});

	it("returns ok on success", () => {
		mockExecSync.mockReturnValue("");
		const result = deleteBranch("/repo", "brl-subagent-abc12345");
		expect(result.ok).toBe(true);
		expect(mockExecSync).toHaveBeenCalledWith(
			"git branch -D brl-subagent-abc12345",
			expect.objectContaining({ cwd: "/repo" }),
		);
	});

	it("returns { ok: false, error } on failure", () => {
		mockExecSync.mockImplementation(() => {
			throw new Error("error: branch 'brl-subagent-unknown' not found.");
		});
		const result = deleteBranch("/repo", "brl-subagent-unknown");
		expectOk(result);
	});
});

// ---------------------------------------------------------------------------
// Error handling consistency
// ---------------------------------------------------------------------------

describe("error handling consistency", () => {
	beforeEach(() => {
		mockExecSync.mockReset();
	});

	it("all guarded functions return the same { ok: false, error } shape on error", () => {
		const errorMsg = "fatal: some git error";
		mockExecSync.mockImplementation(() => {
			throw new Error(errorMsg);
		});

		const createResult = createWorkBranch("/r", "main");
		expectOk(createResult);
		if (!createResult.ok) expect(createResult.error).toBe(errorMsg);

		const diffResult = captureDiff("/r", "main");
		expectOk(diffResult);
		if (!diffResult.ok) expect(diffResult.error).toBe(errorMsg);

		const switchResult = switchToBranch("/r", "main");
		expectOk(switchResult);
		if (!switchResult.ok) expect(switchResult.error).toBe(errorMsg);

		const deleteResult = deleteBranch("/r", "b");
		expectOk(deleteResult);
		if (!deleteResult.ok) expect(deleteResult.error).toBe(errorMsg);
	});
});

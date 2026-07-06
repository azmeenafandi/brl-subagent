/**
 * Tests for diff.ts — Git diff parser (P5).
 */

import { describe, it, expect } from "vitest";
import { parseDiff } from "../diff";
import { MAX_HUNKS_PER_FILE } from "../types";

// Helper to build a single-file diff
function singleFileDiff(
	path: string,
	hunks: string[],
	headerLines?: string[],
): string {
	const header = (headerLines ?? []).join("\n");
	const hunkStr = hunks.join("\n");
	return [
		`diff --git a/${path} b/${path}`,
		`index abc123..def456 100644`,
		`--- a/${path}`,
		`+++ b/${path}`,
		hunkStr,
	].filter(Boolean).join("\n");
}

// Sample diff strings
const SINGLE_FILE_DIFF = [
	`diff --git a/src/file.ts b/src/file.ts`,
	`index abc123..def456 100644`,
	`--- a/src/file.ts`,
	`+++ b/src/file.ts`,
	`@@ -1,3 +1,4 @@`,
	` const x = 1;`,
	`+const y = 2;`,
	`-const z = 3;`,
	` const w = 4;`,
].join("\n");

const MULTI_FILE_DIFF = [
	`diff --git a/src/a.ts b/src/a.ts`,
	`index abc..def 100644`,
	`--- a/src/a.ts`,
	`+++ b/src/a.ts`,
	`@@ -1,1 +1,2 @@`,
	` line1`,
	`+line2`,
	`diff --git a/src/b.ts b/src/b.ts`,
	`index 123..456 100644`,
	`--- a/src/b.ts`,
	`+++ b/src/b.ts`,
	`@@ -1,1 +0,0 @@`,
	`-lineX`,
].join("\n");

const ONLY_ADDITIONS_DIFF = [
	`diff --git a/src/new.ts b/src/new.ts`,
	`index 000..abc 100644`,
	`--- /dev/null`,
	`+++ b/src/new.ts`,
	`@@ -0,0 +1,3 @@`,
	`+line1`,
	`+line2`,
	`+line3`,
].join("\n");

const ONLY_DELETIONS_DIFF = [
	`diff --git a/src/old.ts b/src/old.ts`,
	`index abc..000 100644`,
	`--- a/src/old.ts`,
	`+++ /dev/null`,
	`@@ -1,3 +0,0 @@`,
	`-line1`,
	`-line2`,
	`-line3`,
].join("\n");

const BINARY_FILE_DIFF = [
	`diff --git a/image.png b/image.png`,
	`index abc..def 100644`,
	`Binary files a/image.png and b/image.png differ`,
].join("\n");

// ---------------------------------------------------------------------------
// parseDiff
// ---------------------------------------------------------------------------

describe("parseDiff", () => {
	it("parses a single-file diff with correct path, counts, and hunks", () => {
		const files = parseDiff(SINGLE_FILE_DIFF);
		expect(files).toHaveLength(1);
		expect(files[0].path).toBe("src/file.ts");
		expect(files[0].additions).toBe(1);
		expect(files[0].deletions).toBe(1);
		expect(files[0].hunks).toHaveLength(1);
		expect(files[0].totalHunks).toBe(1);
		const hunk = files[0].hunks[0];
		expect(hunk).toContain("@@ -1,3 +1,4 @@");
		expect(hunk).toContain("+const y = 2;");
		expect(hunk).toContain("-const z = 3;");
		expect(hunk).toContain(" const x = 1;");
		expect(hunk).toContain(" const w = 4;");
	});

	it("parses a multi-file diff with correct file count, sorted by path", () => {
		const files = parseDiff(MULTI_FILE_DIFF);
		expect(files).toHaveLength(2);
		// Sorted alphabetically: a.ts before b.ts
		expect(files[0].path).toBe("src/a.ts");
		expect(files[1].path).toBe("src/b.ts");
		// a.ts: 1 addition, 0 deletions
		expect(files[0].additions).toBe(1);
		expect(files[0].deletions).toBe(0);
		// b.ts: 0 additions, 1 deletion
		expect(files[1].additions).toBe(0);
		expect(files[1].deletions).toBe(1);
	});

	it("returns empty array for empty string", () => {
		expect(parseDiff("")).toEqual([]);
	});

	it("caps hunks when exceeding MAX_HUNKS_PER_FILE", () => {
		// Build a diff with 12 hunks for one file
		const hunks: string[] = [];
		for (let i = 1; i <= 12; i++) {
			hunks.push(`@@ -${i},1 +${i},1 @@\n+added${i}\n-removed${i}`);
		}
		const diff = singleFileDiff("src/big.ts", hunks);
		const files = parseDiff(diff);
		expect(files).toHaveLength(1);
		expect(files[0].path).toBe("src/big.ts");
		expect(files[0].hunks).toHaveLength(MAX_HUNKS_PER_FILE); // 10
		expect(files[0].totalHunks).toBe(12);
		// Verify first and last hunk in the capped list
		expect(files[0].hunks[0]).toContain("@@ -1,1 +1,1 @@");
		expect(files[0].hunks[MAX_HUNKS_PER_FILE - 1]).toContain("@@ -10,1 +10,1 @@");
	});

	it("returns empty array for whitespace-only input", () => {
		expect(parseDiff("   ")).toEqual([]);
		expect(parseDiff("\n\n\n")).toEqual([]);
		expect(parseDiff("\t")).toEqual([]);
	});

	it("parses a file with only additions (no deletions)", () => {
		const files = parseDiff(ONLY_ADDITIONS_DIFF);
		expect(files).toHaveLength(1);
		expect(files[0].path).toBe("src/new.ts");
		expect(files[0].additions).toBe(3);
		expect(files[0].deletions).toBe(0);
	});

	it("parses a file with only deletions (no additions)", () => {
		const files = parseDiff(ONLY_DELETIONS_DIFF);
		expect(files).toHaveLength(1);
		expect(files[0].path).toBe("src/old.ts");
		expect(files[0].additions).toBe(0);
		expect(files[0].deletions).toBe(3);
	});

	it("handles binary file gracefully (no hunks, zero counts)", () => {
		const files = parseDiff(BINARY_FILE_DIFF);
		expect(files).toHaveLength(1);
		expect(files[0].path).toBe("image.png");
		expect(files[0].additions).toBe(0);
		expect(files[0].deletions).toBe(0);
		expect(files[0].hunks).toHaveLength(0);
		expect(files[0].totalHunks).toBe(0);
	});
});

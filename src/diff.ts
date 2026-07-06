/**
 * brl-subagent — Git Diff Parser (P5)
 *
 * Parses standard git unified diff output into structured file-level summaries.
 */

import { MAX_HUNKS_PER_FILE, type FileDiff } from "./types";

/**
 * Parse standard git unified diff output.
 *
 * For each file in the diff:
 * 1. Extract file path from the "diff --git" line
 * 2. Count lines starting with - (deletions) and + (additions)
 * 3. Collect hunk strings: each hunk is the full text from @@ to the next @@ or next file
 *
 * Limit: caps hunks per file to MAX_HUNKS_PER_FILE (10). totalHunks stores the real count.
 *
 * Returns an array sorted by path name (alphabetical, stable).
 * Returns empty array for empty or whitespace-only input.
 */
export function parseDiff(rawDiff: string): FileDiff[] {
	if (!rawDiff || !rawDiff.trim()) return [];

	const lines = rawDiff.split("\n");
	const files: FileDiff[] = [];

	let currentPath = "";
	let currentHunks: string[] = [];
	let currentAdditions = 0;
	let currentDeletions = 0;
	let hunkLines: string[] | null = null; // null = not inside a hunk

	function saveCurrentFile(): void {
		if (!currentPath) return;
		if (hunkLines && hunkLines.length > 0) {
			currentHunks.push(hunkLines.join("\n"));
		}
		files.push({
			path: currentPath,
			additions: currentAdditions,
			deletions: currentDeletions,
			hunks: currentHunks.slice(0, MAX_HUNKS_PER_FILE),
			totalHunks: currentHunks.length,
		});
	}

	function resetFileState(): void {
		currentPath = "";
		currentHunks = [];
		currentAdditions = 0;
		currentDeletions = 0;
		hunkLines = null;
	}

	for (const line of lines) {
		// New file starts
		if (line.startsWith("diff --git ")) {
			saveCurrentFile();
			resetFileState();
			const m = line.match(/^diff --git a\/(.+) b\/(.+)$/);
			currentPath = m ? m[2] : "unknown";
			continue;
		}

		// Hunk header
		if (line.startsWith("@@")) {
			if (hunkLines && hunkLines.length > 0) {
				currentHunks.push(hunkLines.join("\n"));
			}
			hunkLines = [line];
			continue;
		}

		// Track additions (skip +++ header)
		if (line.startsWith("+") && !line.startsWith("+++")) {
			currentAdditions++;
			if (hunkLines !== null) hunkLines.push(line);
			continue;
		}

		// Track deletions (skip --- header)
		if (line.startsWith("-") && !line.startsWith("---")) {
			currentDeletions++;
			if (hunkLines !== null) hunkLines.push(line);
			continue;
		}

		// Context line inside a hunk
		if (hunkLines !== null) {
			hunkLines.push(line);
		}
	}

	// Last file
	saveCurrentFile();

	// Sort by path (alphabetical, stable — plain localeCompare suffices for git paths)
	files.sort((a, b) => a.path.localeCompare(b.path));

	return files;
}

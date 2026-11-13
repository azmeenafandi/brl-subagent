/**
 * Issue #511 (U3) — the retry preamble names the DURABLE bank path.
 *
 * The transport auto-retry's resume preamble used to tell the child to inspect
 * `/tmp/brl-<label>-bank.md`: a world-writable path, ambiguous about who wrote
 * it, and on most Linux hosts a `tmpfs` — the one property a progress bank
 * exists to defeat. Since U1/U2 the bank lives at `<root>/runs/<id>/bank.md`
 * under the shipped scratch root, so the sentence must name THAT file.
 *
 * Three rules are pinned here, and the fourth is a property of the whole builder:
 *
 *   1. PATH SOURCE — the durable record's `scratchDir` when present, otherwise
 *      `<root>/runs/<id>` recomputed, because the crash-time in-flight registry
 *      carries no `scratchDir` (U2) and the path is deterministic from the id.
 *      A root that cannot be resolved drops the sentence; it never throws and
 *      never falls back to a system temp directory.
 *   2. EXISTENCE GATE — the sentence appears only when the run directory really
 *      exists. A legacy run (no `scratchDir`, no directory) and a pruned run get
 *      no bank line at all rather than a dead path.
 *   3. LABEL IRRELEVANCE — the path is id-based, so the label cannot reach it.
 *      The sanitisation that only existed to build `/tmp/brl-<label>-bank.md` is
 *      gone with the name it sanitised for.
 *   4. BOUNDED — ≤ 5 lines, with the retained-session pointer present or absent.
 *
 * Every filesystem question goes through the builder's own seam (`exists`) and
 * its resolution inputs (`root`), so no test here reads the developer's real
 * home or writes into it.
 */
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { BANK_FILENAME, RUNS_DIR, ensureRunDir, resolveRoot } from "../scratch-root";
import { buildRetryResumePreamble } from "../terminal-notifier";
import type { SubagentRun } from "../types";

const RUN_ID = "9a1e2d3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";

/** A settled background run — the shape the retry builder reads. */
function run(overrides: Partial<SubagentRun> = {}): SubagentRun {
	return {
		id: RUN_ID,
		task: "review the docs",
		label: "review-docs",
		status: "failed",
		model: "test/test-model",
		thinkingLevel: "medium",
		startedAt: "2026-11-13T10:00:00.000Z",
		errorCategory: "exit_error",
		errorMessage: "Connection error.",
		attempt: 1,
		originalParams: { background: true, model: "test/test-model" },
		...overrides,
	};
}

/** Everything this file creates, removed after each case. */
const created: string[] = [];

/**
 * A throwaway directory inside the repository's gitignored `.tmp/` chain — never
 * `os.tmpdir()`, because the shipped resolver refuses an ancestor-writable root
 * and `/tmp` is exactly that on a normal Linux host.
 */
function makeTempDir(name: string): string {
	const dir = mkdtempSync(join(process.cwd(), ".tmp", `${name}-`));
	chmodSync(dir, 0o700);
	created.push(dir);
	return dir;
}

/** A home whose scratch root and `<runs>/<id>` directory really exist (created at 0700). */
function homeWithRunDir(runId: string): { home: string; runDir: string } {
	const home = makeTempDir("u3-home");
	const resolved = resolveRoot({ home });
	expect(resolved.ok).toBe(true);
	if (!resolved.ok) throw new Error(resolved.message);
	const made = ensureRunDir(resolved.root, runId);
	expect(made.ok).toBe(true);
	if (!made.ok) throw new Error(made.message);
	return { home, runDir: made.runDir };
}

/** The bank sentence, or `undefined` when the preamble carries none. */
function bankLine(preamble: string): string | undefined {
	return preamble.split("\n").find((line) => line.includes("progress bank"));
}

afterEach(() => {
	for (const dir of created.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("retry preamble — the durable bank path (issue #511 U3)", () => {
	it("names the run's own absolute bank when scratchDir exists on disk", () => {
		const runDir = makeTempDir("u3-scratch");
		const preamble = buildRetryResumePreamble(run({ scratchDir: runDir }), 2);

		const line = bankLine(preamble);
		expect(line).toBeDefined();
		expect(line).toContain(join(runDir, BANK_FILENAME));
		// ABSOLUTE: the retry's child can run in a different cwd.
		expect(join(runDir, BANK_FILENAME).startsWith("/")).toBe(true);
		expect(line).toContain("if it exists.");
		// No system-temp path survives anywhere in the builder's own text, and the
		// label no longer has a filename to occupy.
		expect(preamble).not.toContain("/tmp");
		expect(preamble).not.toContain("review-docs");
	});

	it("drops the bank sentence when scratchDir does not exist, keeping the rest intact", () => {
		const missing = join(makeTempDir("u3-gone"), "runs", RUN_ID);
		const preamble = buildRetryResumePreamble(run({ scratchDir: missing }), 2);

		expect(bankLine(preamble)).toBeUndefined();
		expect(preamble).not.toContain("/tmp");
		// The preamble is still a resume block, in the same order and length.
		expect(preamble.split("\n")).toEqual([
			`[attempt 2 — the previous attempt (${RUN_ID}) died on a transport failure.`,
			"This directory may already contain its uncommitted edits.",
			"Before acting, inspect: `git status --short` and `git log --oneline -8`.",
			"Continue from what exists; do NOT redo committed, written, or banked work.]",
		]);
	});

	it("drops the sentence for a legacy run (no scratchDir, no computed directory) and does not throw", () => {
		// A resolvable home with no run directory under its root: exactly what a
		// pre-U2 record leaves behind. The resolver SUCCEEDS here (otherwise this
		// case would be indistinguishable from a refusal), and the recomputed
		// directory simply is not there.
		const home = makeTempDir("u3-legacy");
		expect(resolveRoot({ home }).ok).toBe(true);
		expect(() =>
			buildRetryResumePreamble(run({ scratchDir: undefined }), 2, undefined, { root: { home } }),
		).not.toThrow();

		const preamble = buildRetryResumePreamble(run({ scratchDir: undefined }), 2, undefined, {
			root: { home },
		});
		expect(bankLine(preamble)).toBeUndefined();
		expect(preamble).not.toContain(join(home, ".cache"));
	});

	it("names the recomputed directory for a registry-only run (no scratchDir) when it exists", () => {
		const { home, runDir } = homeWithRunDir(RUN_ID);
		// The crash-time in-flight registry carries no `scratchDir`; the path is
		// deterministic from the run id, so the sentence must still be right.
		const preamble = buildRetryResumePreamble(run({ scratchDir: undefined }), 2, undefined, {
			root: { home },
		});

		expect(bankLine(preamble)).toContain(join(runDir, BANK_FILENAME));
		expect(bankLine(preamble)).toContain(join(RUNS_DIR, RUN_ID));
		expect(preamble).not.toContain("/tmp");
	});

	it("does not join an id that is not one path segment onto the root", () => {
		const { home } = homeWithRunDir(RUN_ID);
		// A record whose id names a path is not a run directory: `join` would happily
		// walk it out of the root, so it is refused before the root is even consulted.
		for (const id of ["../etc", "a/b", "..", ""]) {
			const preamble = buildRetryResumePreamble(run({ id, scratchDir: undefined }), 2, undefined, {
				root: { home },
			});
			expect(bankLine(preamble)).toBeUndefined();
		}
	});

	it("drops the sentence when the root cannot be resolved — and never throws", () => {
		// An empty home is the resolver's own `home-unresolvable` refusal: the one
		// case where there is no root to recompute from at all.
		const refused = resolveRoot({ home: "" });
		expect(refused.ok).toBe(false);

		let preamble = "";
		expect(() => {
			preamble = buildRetryResumePreamble(run({ scratchDir: undefined }), 2, undefined, {
				root: { home: "" },
			});
		}).not.toThrow();
		expect(bankLine(preamble)).toBeUndefined();
		expect(preamble).toContain("git status --short");
	});

	it("keeps the retained-session pointer beside the bank line inside the 5-line bound", () => {
		const runDir = makeTempDir("u3-both");
		const sessionDir = makeTempDir("u3-session");
		const preamble = buildRetryResumePreamble(run({ scratchDir: runDir }), 2, sessionDir);

		const lines = preamble.split("\n");
		expect(lines).toHaveLength(5);
		expect(bankLine(preamble)).toContain(join(runDir, BANK_FILENAME));
		expect(preamble).toContain(`retained at ${sessionDir}`);
		// The block still opens with the marker and closes with the instruction.
		expect(lines[0]).toContain("[attempt 2 — ");
		expect(lines[lines.length - 1]).toBe(
			"Continue from what exists; do NOT redo committed, written, or banked work.]",
		);
	});

	it("a label cannot reach the path — separators, spaces and absence are all irrelevant", () => {
		const runDir = makeTempDir("u3-label");
		const preambles = [
			buildRetryResumePreamble(run({ scratchDir: runDir, label: "---" }), 2),
			buildRetryResumePreamble(run({ scratchDir: runDir, label: "a/b c;d" }), 2),
			buildRetryResumePreamble(run({ scratchDir: runDir, label: undefined }), 2),
			buildRetryResumePreamble(run({ scratchDir: runDir, label: "review-docs" }), 2),
		];
		for (const preamble of preambles) {
			expect(bankLine(preamble)).toContain(join(runDir, BANK_FILENAME));
			expect(preamble).not.toContain("/tmp");
			expect(preamble).not.toContain("brl----");
		}
		// Byte-identical: nothing about the label reaches the composed block.
		expect(new Set(preambles).size).toBe(1);
	});
});

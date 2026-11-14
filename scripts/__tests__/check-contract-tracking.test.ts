/**
 * Tests for `scripts/check-contract-tracking.mjs` (issue #514) — the "never silently untracked" clause.
 *
 * The ten tracked presets and templates are only a reproducible contract while the NEXT file added to
 * `.pi/brl-subagent/` is a decision rather than an accident: the loader resolves that directory BEFORE the
 * shipped copies, so an untracked file there silently changes what a dispatch receives on one machine.
 * This file pins the three arms that make the check meaningful:
 *
 *  - the walk is the whole directory, RECURSIVELY and including the parent README — a check that scanned
 *    only `presets/` and `templates/` would miss the README and (with the tracked set as wide as it is)
 *    report it as missing from disk instead. The clean fixture therefore carries a parent `README.md` and
 *    a nested `templates/deep/two.md`, and both are tracked and counted;
 *  - the comparison is SYMMETRIC: an untracked `*.md` fails, and so does a tracked one deleted from disk —
 *    one line each, naming the file, because the two fixes are different (commit it vs restore it);
 *  - a check that cannot compare is not a pass: a missing contract directory or a non-git root is a usage
 *    fault (exit 2), never a silent clean.
 *
 * The git seam is exercised for real: every fixture is a throwaway `git init` repository under the
 * repository's own gitignored `.tmp/`, so the suite needs no network and creates nothing outside it. The
 * "not a git checkout" case is a directory carrying an invalid `.git` file, which makes git refuse with
 * its own error (128) instead of walking up into this repository — the same shape a caller sees when the
 * root is wrong.
 *
 * COVERAGE — what these probes do NOT cover, stated rather than implied: a `.md` staged but never
 * committed (the index is the comparison here, and CI checks out a commit); case-only renames on a
 * case-insensitive filesystem (the on-disk walk and git's index agree there by construction); and a
 * tracked file whose CONTENT drifted, which is not this check's subject.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { CONTRACT_DIR, EXIT, ROOT, checkContractTracking, main, trackedContractFiles } from "../check-contract-tracking.mjs";

const BASE = join(ROOT, ".tmp");
mkdirSync(BASE, { recursive: true });
const WORK = mkdtempSync(join(BASE, "contract-tracking-"));
let counter = 0;

afterAll(() => {
	rmSync(WORK, { recursive: true, force: true });
});

/**
 * The tracked set a clean fixture has: a PARENT `README.md`, a preset, and a NESTED template. The parent
 * and the nesting are both load-bearing — they are what a `presets/`+`templates/`-only walk would miss
 * (mutation MC3), and they are counted in the clean verdict.
 */
const CLEAN: Record<string, string> = {
	[join(CONTRACT_DIR, "README.md")]: "# The tracked contract\n",
	[join(CONTRACT_DIR, "presets", "one.md")]: "# One\n",
	[join(CONTRACT_DIR, "templates", "deep", "two.md")]: "# Two\n",
};

function write(root: string, path: string, body: string): void {
	const target = join(root, path);
	mkdirSync(dirname(target), { recursive: true });
	writeFileSync(target, body);
}

function git_(cwd: string, ...args: string[]): void {
	execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.com", ...args], { cwd, encoding: "utf8" });
}

/** A real `git init` checkout under `.tmp/`, with `files` written; `track` decides what git knows about. */
function repo(name: string, files: Record<string, string> = CLEAN, track: readonly string[] = Object.keys(CLEAN)): string {
	const root = join(WORK, `${name}-${(counter += 1)}`);
	mkdirSync(root, { recursive: true });
	git_(root, "init", "-q");
	for (const [path, body] of Object.entries(files)) write(root, path, body);
	for (const path of track) git_(root, "add", path);
	return root;
}

function run(root: string) {
	const out: string[] = [];
	const err: string[] = [];
	const code = main(root, { out: (line: string) => void out.push(line), err: (line: string) => void err.push(line) });
	return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("contract tracking — the directory is tracked, both ways", () => {
	it("reports a clean contract directory, counting the parent README and the nested file", () => {
		const root = repo("clean");
		const result = run(root);
		expect(result.code).toBe(EXIT.OK);
		expect(result.out).toBe("contract-tracking: 3 tracked file(s), clean");
		expect(result.out).not.toContain("untracked");
		expect(trackedContractFiles(root)).toEqual([
			join(CONTRACT_DIR, "README.md"),
			join(CONTRACT_DIR, "presets", "one.md"),
			join(CONTRACT_DIR, "templates", "deep", "two.md"),
		]);
	});

	it("fails an untracked contract file, one line, naming it and the two fixes", () => {
		const untracked = join(CONTRACT_DIR, "presets", "three.md");
		const root = repo("untracked", { ...CLEAN, [untracked]: "# Three\n" });
		const result = run(root);
		expect(result.code).toBe(EXIT.DRIFT);
		expect(result.out).toBe(
			`untracked contract file: ${untracked} — commit it (or move it to ~/.pi/agent/brl-subagent/ for a personal variant)`,
		);
	});

	it("catches an untracked PARENT README and an untracked NESTED file — the walk is the whole directory", () => {
		// MC3's fixture: a check scoped to `presets/`+`templates/` reports the parent README as tracked-but-
		// missing, so this pair fails on either scoping mistake, not just on the untracked file.
		const nested = join(CONTRACT_DIR, "templates", "deep", "deeper", "three.md");
		const root = repo("scoping", { ...CLEAN, [nested]: "# Deeper\n" }, [
			join(CONTRACT_DIR, "presets", "one.md"),
			join(CONTRACT_DIR, "templates", "deep", "two.md"),
		]);
		const result = run(root);
		expect(result.code).toBe(EXIT.DRIFT);
		expect(result.out).toContain(`untracked contract file: ${join(CONTRACT_DIR, "README.md")}`);
		expect(result.out).toContain(`untracked contract file: ${nested}`);
		expect(result.out.split("\n")).toHaveLength(2);
	});

	it("fails a tracked file that is missing from disk, naming it — the other direction of the same drift", () => {
		const root = repo("deleted");
		const gone = join(root, CONTRACT_DIR, "presets", "one.md");
		unlinkSync(gone);
		const result = run(root);
		expect(result.code).toBe(EXIT.DRIFT);
		expect(result.out).toBe(`tracked contract file is missing from disk: ${join(CONTRACT_DIR, "presets", "one.md")}`);
	});

	it("reports both directions in one run, in a stable order", () => {
		const untracked = join(CONTRACT_DIR, "templates", "three.md");
		const root = repo("both", { ...CLEAN, [untracked]: "# Three\n" });
		unlinkSync(join(root, CONTRACT_DIR, "README.md"));
		const result = run(root);
		expect(result.code).toBe(EXIT.DRIFT);
		const lines = result.out.split("\n");
		// Untracked first (sorted), then missing — the two fixes are different, so they never merge.
		expect(lines[0]).toContain(`untracked contract file: ${untracked}`);
		expect(lines[1]).toBe(`tracked contract file is missing from disk: ${join(CONTRACT_DIR, "README.md")}`);
	});

	it("ignores extension state — only *.md is the contract, so an untracked state.json is clean", () => {
		const root = repo("state", { ...CLEAN, [join(CONTRACT_DIR, "state.json")]: "{}\n" });
		const result = run(root);
		expect(result.code).toBe(EXIT.OK);
		expect(result.out).toBe("contract-tracking: 3 tracked file(s), clean");
	});

	it("never stages, commits or edits what it reports", () => {
		const untracked = join(CONTRACT_DIR, "presets", "three.md");
		const root = repo("readonly", { ...CLEAN, [untracked]: "# Three\n" });
		run(root);
		const stagedAfter = execFileSync("git", ["ls-files", "-z", "--", CONTRACT_DIR], { cwd: root, encoding: "utf8" });
		expect(stagedAfter.split("\0").filter(Boolean)).toHaveLength(3);
		// The file is still on disk, unmodified: the fix is a decision, not this tool's.
		expect(checkContractTracking({ root }).untracked).toEqual([untracked]);
	});
});

describe("contract tracking — a check that cannot compare is not a pass", () => {
	it("refuses a checkout with no contract directory as usage, exit 2", () => {
		const root = repo("no-dir", {}, []);
		const result = run(root);
		expect(result.code).toBe(EXIT.USAGE);
		expect(result.err).toContain("cannot read the contract directory");
		expect(result.out).toBe("");
	});

	it("refuses a root that is not a git checkout instead of calling every file untracked", () => {
		const root = join(WORK, `not-git-${(counter += 1)}`);
		mkdirSync(root, { recursive: true });
		// An invalid `.git` file stops git walking up into this repository and makes it exit 128.
		writeFileSync(join(root, ".git"), "not a gitfile\n");
		write(root, join(CONTRACT_DIR, "README.md"), "# Contract\n");
		const result = run(root);
		expect(result.code).toBe(EXIT.USAGE);
		expect(result.err).toContain("is it a git checkout?");
		expect(result.out).toBe("");
	});
});

describe("contract tracking — this repository", () => {
	it("counts the ten tracked contract files and the README, and is clean", () => {
		// The acceptance the issue is about: the exact files a dispatch receives, reproducible from a clean
		// checkout. Names, not just a count — a count of 11 with the wrong eleven would pass a number.
		const tracked = trackedContractFiles(ROOT);
		for (const name of ["project-docs", "project-implementer", "project-plan-critic", "project-proposer", "project-reviewer"]) {
			expect(tracked).toContain(join(CONTRACT_DIR, "presets", `${name}.md`));
		}
		for (const name of ["adversarial-review", "debug-task", "design-proposal", "focused-review", "plan-critique"]) {
			expect(tracked).toContain(join(CONTRACT_DIR, "templates", `${name}.md`));
		}
		expect(tracked).toContain(join(CONTRACT_DIR, "README.md"));
		expect(tracked.length).toBeGreaterThanOrEqual(11);

		const result = run(ROOT);
		expect(result.code).toBe(EXIT.OK);
		expect(result.out).toMatch(/^contract-tracking: \d+ tracked file\(s\), clean$/);
		expect(result.out).not.toContain("untracked");
	});
});

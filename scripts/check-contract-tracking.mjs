#!/usr/bin/env node
// Purpose: the "never silently untracked" clause of the dispatch contract (#514) — every `*.md` under
// `.pi/brl-subagent` is in version control, and every tracked one exists on disk.
//
// WHY. `.pi/brl-subagent/{presets,templates}` is the PROJECT-LOCAL tier of the dispatch contract, and the
// loader resolves it BEFORE the shipped copies (`src/presets.ts`, `src/templates.ts`). #514 tracked the ten
// files for exactly that reason: while they were gitignored, the contract a dispatched reviewer received
// lived on one machine, and the 2026-11-08 `- Verdict:` incident is the precedent — the preset template
// itself taught the malformed field, the fix went to the local copy, and nothing in the repository
// recorded it. Tracking them once is not the fix; the fix is that the NEXT contract file cannot be added
// silently. A new `*.md` here is either committed (the project's contract) or a personal variant
// (`~/.pi/agent/brl-subagent/`), and this check is what makes that a decision instead of an accident.
//
// SYMMETRIC ON PURPOSE. "Tracked but missing from disk" is the other half of the same drift — a rename or
// a delete that did not reach git leaves a clean checkout dispatching a file the working tree does not
// have, and a check that only looked for untracked files would call that clean. Both directions exit 1,
// one line each, because the fix differs and the reader should not have to guess which way the drift
// runs.
//
// THE COMPARISON. On-disk: every `*.md` below the directory, recursively (`collectMarkdown`, the same walk
// the audit uses, so "the contract corpus" has one definition). Tracked: `git ls-files -z -- .pi/brl-subagent`
// run with `cwd: root` through `execFileSync` — no shell, so no path here is ever word-split or
// interpreted. In a clean checkout the index equals HEAD, so "tracked" here means "in the tree a fresh
// clone gets"; the check is not a substitute for `git status` on the rest of the repository.
//
// NOT COVERED, stated rather than implied: a tracked file whose CONTENT drifted from what a dispatch read
// (that is the audit's business for temp paths, and a review's for anything else), a `.md` added to the
// git index but never committed (the index is the comparison, and CI checks out a commit), and case-only
// renames on a case-insensitive filesystem (the on-disk walk and git's index agree there by construction).
//
// Exit: 0 clean · 1 drift, named one line per file · 2 usage — the contract directory is missing or
// unreadable, or `root` is not a git checkout (a check that cannot compare is not a pass).
import { execFileSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectMarkdown } from "./audit-scratch-instructions.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The checkout this script lives in — the CLI's root, never a path typed by a caller. */
export const ROOT = join(HERE, "..");

/** The tracked project-local dispatch contract: the ten presets and templates, the README and whatever
 * the next unit adds. One constant, so the check and the ignore rules cannot name different directories. */
export const CONTRACT_DIR = join(".pi", "brl-subagent");

export const EXIT = Object.freeze({ OK: 0, DRIFT: 1, USAGE: 2 });

/** The fix each untracked file carries — commit it, or move it to the tier that is nobody else's. */
const UNTRACKED_HINT = "commit it (or move it to ~/.pi/agent/brl-subagent/ for a personal variant)";

function describe(error) {
	return error instanceof Error ? error.message.replace(/\s*\n\s*/g, " ") : String(error);
}

/**
 * Every `*.md` git has under `CONTRACT_DIR`, repo-relative and sorted. `-z` so a path with a space or a
 * newline survives, and `execFileSync` (never a shell string) so nothing in a path can become argv.
 */
export function trackedContractFiles(root) {
	// stderr is captured rather than inherited: the caller reports the failure as one line, and git's own
	// diagnostic travels inside the thrown error (so a broken checkout still says WHY it is broken).
	const listed = execFileSync("git", ["ls-files", "-z", "--", CONTRACT_DIR], {
		cwd: root,
		encoding: "utf8",
		stdio: ["ignore", "pipe", "pipe"],
	});
	return listed
		.split("\0")
		.filter((path) => path !== "" && path.endsWith(".md"))
		.sort();
}

/**
 * The verdict: `{ ok, exit, lines, tracked, untracked, missing }`. Reads only — it never stages, commits
 * or edits, because the fix for an untracked contract file is a decision about which tier it belongs to.
 */
export function checkContractTracking({ root = ROOT } = {}) {
	const base = resolve(root);
	const absolute = join(base, CONTRACT_DIR);
	let onDisk;
	try {
		onDisk = collectMarkdown(absolute).map((path) => relative(base, path));
	} catch (error) {
		return {
			ok: false,
			exit: EXIT.USAGE,
			lines: [`contract-tracking: ${absolute}: cannot read the contract directory (${describe(error)})`],
			tracked: [],
			untracked: [],
			missing: [],
		};
	}
	let tracked;
	try {
		tracked = trackedContractFiles(base);
	} catch (error) {
		return {
			ok: false,
			exit: EXIT.USAGE,
			lines: [`contract-tracking: ${base}: cannot list tracked files under ${CONTRACT_DIR} — is it a git checkout? (${describe(error)})`],
			tracked: [],
			untracked: [],
			missing: [],
		};
	}
	const trackedSet = new Set(tracked);
	const diskSet = new Set(onDisk);
	const untracked = onDisk.filter((path) => !trackedSet.has(path));
	const missing = tracked.filter((path) => !diskSet.has(path));
	const lines = [
		...untracked.map((path) => `untracked contract file: ${path} — ${UNTRACKED_HINT}`),
		...missing.map((path) => `tracked contract file is missing from disk: ${path}`),
	];
	const clean = lines.length === 0;
	if (clean) lines.push(`contract-tracking: ${tracked.length} tracked file(s), clean`);
	return { ok: clean, exit: clean ? EXIT.OK : EXIT.DRIFT, lines, tracked, untracked, missing };
}

/** Run the check against `root` (the CLI passes ROOT, resolved from `import.meta.url`). */
export function main(root = ROOT, io = {}) {
	const out = io.out ?? console.log;
	const err = io.err ?? console.error;
	const result = checkContractTracking({ root });
	const sink = result.exit === EXIT.USAGE ? err : out;
	for (const line of result.lines) sink(line);
	return result.exit;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main());

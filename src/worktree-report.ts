// Purpose: Formats the read-only worktree state a failed or stopped run may have left behind (issue #474).
/**
 * brl-subagent — failure-path worktree state (issue #474)
 *
 * Rule 11 escalated `connection-drop` after three hits in one cycle: six of
 * ~28 sweep dispatches ended without their unit, two leaving a **mutant applied**
 * in a worktree. The mitigations (auto-retry, `/tmp` banking, transcript
 * retention) worked, but every death still cost the conductor a manual state
 * audit — memory, not mechanism. Three dispatches measured the same gap: a
 * settled failure reported the failure and nothing about the tree.
 *
 * This module is the FORMATTING half. `probeWorktree` (git.ts) does the reading,
 * and the split is deliberate: execution stays where `architecture-rules`
 * confines it, and this module never throws, never classifies a run and never
 * decides whether the tree is safe — it reports. The decision stays with the
 * conductor (rule-notes: a killed agent's worktree is hostile until read).
 *
 * It imports `./git` and `node:path` only. That is a hard constraint, not a
 * preference: `sanitize.ts` imports THIS module for the one crash seam, so any
 * edge back into `sanitize.ts` (or into a module that imports it) would close a
 * runtime cycle.
 */

import * as path from "node:path";

import { probeWorktree } from "./git";

/** The block's first line. One spelling, so a reader (and a test) can find it. */
const HEADING = "Worktree state (git, at failure):";

/**
 * The caution line's job is to stop a conductor from reusing a tree it did not
 * inspect. It carries no verdict — "may be" is the whole claim.
 */
const CAUTION =
	"  — uncommitted work may be a partially applied edit or a mutant; inspect before reusing.";

/** The property a rethrown unit crash carries its own block on (`finalizeUnitRunCrash`). */
export interface WorktreeStateCarrier {
	worktreeState?: string;
}

/** An unavailable report — the block's whole body when the probe could not look. */
function unavailable(reason: string): string {
	return `${HEADING}\n  state: unavailable (${reason})`;
}

/** `1 file` / `2 files` — a count that reads as English in the report line. */
function fileCount(n: number): string {
	return `${n} file${n === 1 ? "" : "s"}`;
}

/** Render a successful probe as the block. */
function renderProbe(probe: Extract<ReturnType<typeof probeWorktree>, { kind: "ok" }>): string {
	const branch = probe.detached
		? "(detached)"
		: probe.unborn
			? `${probe.branch ?? "(unborn)"} (unborn)`
			: (probe.branch ?? "(unknown)");
	const lineCounts =
		probe.insertions === undefined ? "" : ` (+${probe.insertions}/−${probe.deletions ?? 0})`;
	const lines = [
		HEADING,
		`  branch: ${branch}`,
		`  dirty:  ${fileCount(probe.dirtyFiles)}${lineCounts}`,
		`  staged: ${probe.stagedFiles}`,
	];
	// Only an unclean tree earns the caution: a clean failure has nothing to warn
	// about, and a warning on every failure is a warning nobody reads.
	if (probe.dirtyFiles + probe.stagedFiles > 0) lines.push(CAUTION);
	return lines.join("\n");
}

/**
 * The worktree-state block for `cwd`. ALWAYS returns text (never throws, never
 * returns ""), because its callers append it to a message they must still
 * deliver:
 *
 * - no cwd → `state: unavailable (no cwd)`;
 * - a RELATIVE cwd → `state: unavailable (no recorded cwd)`. A background
 *   record written before #474 stamped `cwd` may hold the relative value the
 *   caller passed; resolving it against the conductor's process cwd would
 *   report a tree nobody ran in, so it is refused rather than guessed;
 * - not a repo → `state: unavailable (not a git repository)`;
 * - any read failure → `state: unavailable (<git's own reason>)`.
 *
 * The outer catch is belt-and-braces: `probeWorktree` classifies its own
 * failures, and this one makes "never throws" a property of the formatter even
 * if a future edit breaks that.
 */
export function describeWorktreeState(cwd: string | undefined): string {
	if (cwd === undefined || cwd.length === 0) return unavailable("no cwd");
	if (!path.isAbsolute(cwd)) return unavailable("no recorded cwd");
	try {
		const probe = probeWorktree(cwd);
		if (probe.kind === "not-repo") return unavailable("not a git repository");
		if (probe.kind === "unavailable") return unavailable(probe.reason);
		return renderProbe(probe);
	} catch (err) {
		return unavailable(err instanceof Error ? err.message : String(err));
	}
}

/**
 * The block an error already carries, when a unit crash attached its OWN tree.
 * A mode runner's outer catch only knows the dispatch cwd; `finalizeUnitRunCrash`
 * attaches the crashing unit's block to the rethrown error so the mode-level
 * crash reports the unit's worktree rather than a sibling's (issue #474).
 */
export function attachedWorktreeState(err: unknown): string | undefined {
	if (typeof err !== "object" || err === null) return undefined;
	const carried = (err as WorktreeStateCarrier).worktreeState;
	return typeof carried === "string" && carried.length > 0 ? carried : undefined;
}

/**
 * Attach the block for `cwd` to a rethrown error, best-effort.
 *
 * A thrown NON-OBJECT (a bare string) cannot carry anything, so the mode catch
 * falls back to the dispatch cwd — a stated limit, not a silent one: real
 * runner crashes throw `Error` instances.
 */
export function attachWorktreeState(err: unknown, cwd: string | undefined): void {
	if (typeof err !== "object" || err === null) return;
	(err as WorktreeStateCarrier).worktreeState = describeWorktreeState(cwd);
}

/**
 * Append the worktree block to failure text, separated by a blank line.
 *
 * The block goes LAST (issue #474 v3): the crash envelope, the classified-failure
 * message and its H1 warnings note are the reason, and a report of the residue
 * belongs after the cause — never spliced into it.
 *
 * `err` is optional and only for the crash seam: when a unit crash carried its
 * own block, that block wins over `cwd`, which the mode-level caller only knows
 * as the dispatch cwd.
 */
export function appendWorktreeState(text: string, cwd: string | undefined, err?: unknown): string {
	const block = attachedWorktreeState(err) ?? describeWorktreeState(cwd);
	return `${text}\n\n${block}`;
}

// Purpose: Durable per-repository head state (ADR 0026): the record a branch run writes before its branch exists, the guarded boot reconciliation, and the age sweep.
/**
 * Issue #466 — the durable head state, and the one boot step allowed to move git.
 *
 * A branch-mode run creates `brl-subagent-<8hex>` and, before this module, the
 * starting HEAD lived only in a local variable: a crash left the tree on the
 * orphan branch with nothing durable naming the base, and the next dispatch read
 * the orphan as its own base (its diff window then started at the orphan's tip).
 * ADR 0026 fixes that with ONE small record per repository, at
 * `.pi/head-state/<sha256(repoRoot)[0:16]>.json`, written BEFORE the branch
 * exists so a crash inside `createWorkBranch` is recoverable.
 *
 * Three parts, in the order the boot uses them:
 *   1. the store — `writeHeadState` / `readHeadState` / `clearHeadState` /
 *      `listHeadStates`, atomic (temp + rename) and owner-only, keyed by the
 *      resolved repository root (never `process.cwd()`: a run dispatched with
 *      `cwd` inside another repo must record THAT repo);
 *   2. `reconcileHeadStates` — the policy table of dossier §4, executed in its
 *      fixed order: parse → root resolves → owner PROVABLY dead → HEAD is
 *      EXACTLY the recorded work branch → (unborn HEAD restores, before the
 *      dirty row) → tree clean → restore, verify, clear. Any other row leaves
 *      the tree alone, keeps the record, and names what it could not repair.
 *      It touches git ONLY through injected deps, so all seven verdicts are
 *      unit-testable without a repository;
 *   3. `buildHeadStateNotice` + `sweepHeadStates` — one message at the next turn
 *      boundary (D5: silence is not a verdict), and 30-day housekeeping for a
 *      record whose repository is gone (precedent: `cleanupTempDirs`).
 *
 * What this module must NEVER do (ADR 0026 D3): delete a work branch, force a
 * checkout, or reset a tree. After a crash the work branch is the ONLY copy of
 * the run's work — the diff was captured in memory and lost — so the repair
 * restores the recorded base and keeps the branch.
 */

import type { HeadState } from "./git";
import type { OwnerState } from "./recovery-engine";
import type { ProcessOwner } from "./types";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { ensureOwnerOnlyDir } from "./store-permissions";

/** On-disk record version. A record with any other value is `skip-record`. */
export const HEAD_STATE_VERSION = 1;

/** Housekeeping age for a record whose repository no longer resolves. */
export const HEAD_STATE_SWEEP_AGE_MS = 30 * 24 * 60 * 60 * 1000;

/** Custom-entry type of the one-per-boot head-state notice. */
export const HEAD_STATE_NOTICE_CUSTOM_TYPE = "subagent-head-state";

/**
 * The durable record. `base` is the verbatim `getHeadState` capture, so the
 * repair replays the recorded branch or detached sha — the policy never
 * CHOOSES a branch.
 */
export interface HeadStateRecord {
	version: number;
	/** Canonical absolute repository root: the record's identity. */
	repoRoot: string;
	/** The agent id, so the notice names the interrupted run's owner. */
	runId: string;
	kind: "background" | "foreground";
	base: HeadState;
	/** Known BEFORE the branch exists (hence `newWorkBranchName` at the caller). */
	workBranch: string;
	owner: ProcessOwner;
	createdAt: string;
}

// ---------------------------------------------------------------------------
// Storage location + keying
// ---------------------------------------------------------------------------

/** Store directory, cwd-relative like the agent store (`.pi/subagents`). */
let HEAD_STATE_DIR = ".pi/head-state";

/** TEST-ONLY: point the store at an alternate directory (mirrors `__setRegistryDir`). */
export function __setHeadStateDir(dir: string): void {
	HEAD_STATE_DIR = dir;
}

/** The active store directory. */
export function headStateDir(): string {
	return HEAD_STATE_DIR;
}

/**
 * The record path for a repository. The key is `sha256(root)[0:16]` — one file
 * per repository, which is sufficient because `gitBranchLocks` already
 * serializes the whole branch lifecycle per repo root.
 */
export function headStatePath(repoRoot: string): string {
	const key = createHash("sha256").update(resolve(repoRoot)).digest("hex").slice(0, 16);
	return join(HEAD_STATE_DIR, `${key}.json`);
}

// ---------------------------------------------------------------------------
// Shape + IO
// ---------------------------------------------------------------------------

/** True when `value` is a record this code can act on (row 1 of the table). */
function isHeadStateRecord(value: unknown): value is HeadStateRecord {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (v.version !== HEAD_STATE_VERSION) return false;
	if (typeof v.repoRoot !== "string" || typeof v.runId !== "string") return false;
	if (typeof v.workBranch !== "string" || typeof v.createdAt !== "string") return false;
	if (v.kind !== "background" && v.kind !== "foreground") return false;
	const base = v.base as Record<string, unknown> | undefined;
	if (!base || typeof base !== "object") return false;
	if (typeof base.sha !== "string" || typeof base.branch !== "string") return false;
	if (typeof base.detached !== "boolean") return false;
	const owner = v.owner as Record<string, unknown> | undefined;
	if (!owner || typeof owner !== "object") return false;
	return typeof owner.pid === "number" && typeof owner.start === "string";
}

/** A record read: absent and corrupt are DISTINCT (L1 warns, absent is silent). */
export type HeadStateRead =
	| { state: "ok"; record: HeadStateRecord }
	| { state: "absent" }
	| { state: "corrupt" };

/** One enumerated state file and what it parsed to. */
export interface HeadStateEntry {
	file: string;
	read: HeadStateRead;
}

function readStateFile(file: string): HeadStateRead {
	let text: string;
	try {
		text = readFileSync(file, "utf-8");
	} catch {
		// Present-but-unreadable is a record we cannot trust, not an absent one.
		return existsSync(file) ? { state: "corrupt" } : { state: "absent" };
	}
	try {
		const parsed: unknown = JSON.parse(text);
		return isHeadStateRecord(parsed) ? { state: "ok", record: parsed } : { state: "corrupt" };
	} catch {
		return { state: "corrupt" };
	}
}

/** Read the record for one repository. Never throws. */
export function readHeadState(repoRoot: string): HeadStateRead {
	return readStateFile(headStatePath(repoRoot));
}

/**
 * Write (or replace) a repository's record. Atomic — temp file in the same
 * directory, then `rename` — and owner-only, so a reader never sees a torn
 * record. Best-effort: returns false rather than throwing, because it runs in
 * the spawn's critical section where a store failure must not refuse the run.
 */
export function writeHeadState(record: HeadStateRecord): boolean {
	const file = headStatePath(record.repoRoot);
	try {
		ensureOwnerOnlyDir(HEAD_STATE_DIR);
		const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
		writeFileSync(tmp, JSON.stringify(record, null, 2), { encoding: "utf-8", mode: 0o600 });
		renameSync(tmp, file);
		return true;
	} catch {
		return false;
	}
}

/**
 * Remove a repository's record. Only ever called where the tree is VERIFIED off
 * the work branch (or nothing was created) — a missing file is a no-op.
 */
export function clearHeadState(repoRoot: string): void {
	try {
		unlinkSync(headStatePath(repoRoot));
	} catch {
		// Already cleared (or never written) — the desired end state.
	}
}

/** Every state file in the store, parse result included (tolerant scan). */
export function listHeadStateEntries(): HeadStateEntry[] {
	let names: string[];
	try {
		names = readdirSync(HEAD_STATE_DIR).sort();
	} catch {
		return [];
	}
	const entries: HeadStateEntry[] = [];
	for (const name of names) {
		if (!name.endsWith(".json")) continue;
		const file = join(HEAD_STATE_DIR, name);
		entries.push({ file, read: readStateFile(file) });
	}
	return entries;
}

/** Every parseable record; [] when the store is absent. */
export function listHeadStates(): HeadStateRecord[] {
	const records: HeadStateRecord[] = [];
	for (const entry of listHeadStateEntries()) {
		if (entry.read.state === "ok") records.push(entry.read.record);
	}
	return records;
}

// ---------------------------------------------------------------------------
// The boot reconciliation (dossier §4's table, in its fixed order)
// ---------------------------------------------------------------------------

/** The git/process surface the table reads (injected: no repository needed to test it). */
export interface HeadStateDeps {
	/** Resolved repository root for a path, or undefined when it is gone/not a repo. */
	getRepoRoot(dir: string): string | undefined;
	/** Owner liveness; only "dead" may be acted on. */
	classifyOwner(owner: ProcessOwner): OwnerState;
	/** HEAD's branch (undefined when detached) and whether it has a commit yet. */
	getHeadBranch(cwd: string): { branch: string | undefined; unborn: boolean };
	/** The settled path's own restore primitive — no forcing, no resetting. */
	restoreHead(cwd: string, base: HeadState): { ok: true } | { ok: false; error: string };
	hasUncommittedChanges(cwd: string): boolean;
	/** Optional: present work branches, for the leaked-orphan count in the notice. */
	listWorkBranches?(cwd: string): string[];
}

/** One row's verdict, using the dossier's names. */
export type HeadStateVerdict =
	/** Repaired: the base was restored and the work branch kept. */
	| "restore"
	/** Repaired from an unborn HEAD (the branch had been deleted while checked out). */
	| "no-branch"
	/** HEAD is not on the recorded branch: nothing to repair, the record is cleared. */
	| "already-off"
	/** Left alone; a human must finish (dirty tree, or an unexpected failure). */
	| "needs-manual"
	/** `restoreHead` failed or did not land: the record is KEPT for the next boot. */
	| "restore-failed"
	/** Unparseable/unversioned record: no git command runs, the record is kept. */
	| "skip-record"
	/** The record's repository no longer resolves: kept (may be unmounted). */
	| "skip-missing"
	/** The owner is not provably dead: untouched, and NOT refused. */
	| "skip-owner";

/** What the boot decided about one record, and everything the user may need. */
export interface HeadStateOutcome {
	verdict: HeadStateVerdict;
	repoRoot?: string;
	workBranch?: string;
	base?: HeadState;
	/** A restore error, or why the tree needs a human. */
	detail?: string;
	/** `brl-subagent-*` branches still present, when more than the recorded one. */
	orphans?: number;
}

function countOrphans(deps: HeadStateDeps, cwd: string): number | undefined {
	if (!deps.listWorkBranches) return undefined;
	try {
		const count = deps.listWorkBranches(cwd).length;
		return count > 1 ? count : undefined;
	} catch {
		return undefined;
	}
}

/** One record through the table. Throws only on an unexpected dep failure. */
function reconcileEntry(entry: HeadStateEntry, deps: HeadStateDeps): HeadStateOutcome {
	if (entry.read.state !== "ok") {
		// Row 1 — no `version`: not written by this code, so its `base` cannot be
		// trusted. Fail closed by NOT ACTING (never by refusing the repository).
		return { verdict: "skip-record", detail: entry.file };
	}
	const record = entry.read.record;
	const identity = { repoRoot: record.repoRoot, workBranch: record.workBranch, base: record.base };
	// Row 2 — the repository may be temporarily unmounted: keep, never delete.
	const repoRoot = deps.getRepoRoot(record.repoRoot);
	if (!repoRoot) return { ...identity, verdict: "skip-missing" };
	const orphans = countOrphans(deps, repoRoot);
	// Row 3 — ONLY a provably dead owner may be repaired. A live one belongs to
	// another process (or the #465 case) and is not refused here either.
	if (deps.classifyOwner(record.owner) !== "dead") return { ...identity, verdict: "skip-owner" };
	const head = deps.getHeadBranch(repoRoot);
	// Row 4 — HEAD must be EXACTLY the recorded work branch. A tree moved by hand
	// is never switched: the policy replays a recorded base, it never chooses one.
	if (head.branch !== record.workBranch) {
		clearHeadState(record.repoRoot);
		return { ...identity, verdict: "already-off" };
	}
	// Row 5 — the branch was deleted while checked out (unborn HEAD). It is a
	// REPAIR row, not a refusal: `git checkout <base>` works there, and `status`
	// reads dirty for the wrong reason — so this row precedes the dirty check.
	if (!head.unborn && deps.hasUncommittedChanges(repoRoot)) {
		// Row 6 — the interrupted run's uncommitted work is the only copy: leave.
		return { ...identity, verdict: "needs-manual", detail: "uncommitted changes in the working tree", orphans };
	}
	// Row 7 — restore the RECORDED base (never a guessed branch), verify, clear.
	const restored = deps.restoreHead(repoRoot, record.base);
	if (!restored.ok) {
		return { ...identity, verdict: "restore-failed", detail: restored.error, orphans };
	}
	const landed = deps.getHeadBranch(repoRoot);
	const wanted = record.base.detached ? undefined : record.base.branch;
	if (landed.branch !== wanted) {
		return {
			...identity,
			verdict: "restore-failed",
			detail: `restore did not land on ${wanted ?? "the recorded detached HEAD"}`,
			orphans,
		};
	}
	clearHeadState(record.repoRoot);
	return { ...identity, verdict: head.unborn ? "no-branch" : "restore", orphans };
}

/**
 * Run the table over EVERY record in the store (not just this cwd's repository:
 * the payload carries the absolute root, so a boot started in repo A repairs
 * repo B). Each record is isolated: one unreadable repository can never abort
 * the rest of the boot.
 */
export function reconcileHeadStates(deps: HeadStateDeps): HeadStateOutcome[] {
	const outcomes: HeadStateOutcome[] = [];
	for (const entry of listHeadStateEntries()) {
		try {
			outcomes.push(reconcileEntry(entry, deps));
		} catch (err) {
			// A dep threw mid-table (the repository vanished under us): keep the
			// record and NAME it — silence is not a verdict (D5).
			outcomes.push({
				verdict: "needs-manual",
				detail: err instanceof Error ? err.message : String(err),
			});
		}
	}
	return outcomes;
}

/** The verdicts the user is told about (the rest are log-level detail). */
export function isReportable(outcome: HeadStateOutcome): boolean {
	return outcome.verdict !== "already-off" && outcome.verdict !== "skip-owner";
}

// ---------------------------------------------------------------------------
// The notice (one nextTurn message) + the sweep
// ---------------------------------------------------------------------------

/** The recorded base, as a human names it. */
function baseLabel(base: HeadState | undefined): string {
	if (!base) return "the recorded base";
	return base.detached ? `detached ${base.sha.slice(0, 8)}` : base.branch;
}

/** The exact command that returns the tree to the recorded base (§6). */
function baseCheckoutCommand(base: HeadState | undefined): string {
	if (!base) return "git checkout <base-branch>";
	return base.detached ? `git checkout --detach ${base.sha}` : `git checkout ${base.branch}`;
}

function describeOutcome(outcome: HeadStateOutcome): string[] {
	const repo = outcome.repoRoot ? basename(outcome.repoRoot) : "an unknown repository";
	const work = outcome.workBranch ?? "the work branch";
	const base = baseLabel(outcome.base);
	const orphanNote = outcome.orphans
		? `\n    ${outcome.orphans} brl-subagent-* branches exist; none is deleted at boot \u2014 their diffs were never captured, so a human decides.`
		: "";
	switch (outcome.verdict) {
		case "restore":
		case "no-branch": {
			const how =
				outcome.verdict === "no-branch"
					? "its branch had been deleted while checked out"
					: "an interrupted run left the tree on it";
			return [
				`  \u2022 ${repo} \u00b7 RESTORED ${base} \u00b7 ${work} was KEPT with the run's commits (${how}).${orphanNote}`,
			];
		}
		case "needs-manual":
		case "restore-failed":
			return [
				`  \u2022 ${repo} \u00b7 NEEDS A MANUAL REPAIR \u00b7 ${base} could not be restored (${outcome.detail ?? "unknown reason"}).`,
				`    The tree is still on ${work}. Inspect it with \`git status\`, then:`,
				`      git stash push -u -m "brl-subagent interrupted work"`,
				`      ${baseCheckoutCommand(outcome.base)}`,
				`    Keep ${work} until its work is reviewed — it is the only copy.${orphanNote}`,
			];
		case "skip-record":
			return [
				`  \u2022 an unreadable head-state record was left in place (${outcome.detail ?? "unknown file"}).`,
				`    No git command was run. If a branch run was interrupted, restore the base by hand: \`git status\`, then \`git checkout <base-branch>\`.`,
			];
		case "skip-missing":
			return [
				`  \u2022 ${repo} \u00b7 SKIPPED \u00b7 its repository no longer resolves (${outcome.repoRoot}).`,
				`    The record was kept; it is swept after ${Math.round(HEAD_STATE_SWEEP_AGE_MS / 86_400_000)} days.`,
			];
		default:
			return [];
	}
}

/**
 * PURE builder — the ONE turn-boundary message for the boot's head-state work.
 * Returns undefined when there is nothing the user must act on or know about,
 * so the caller can skip `sendMessage` entirely.
 */
export function buildHeadStateNotice(
	outcomes: HeadStateOutcome[],
): { customType: string; content: string; display: boolean; details: Record<string, unknown> } | undefined {
	const reportable = outcomes.filter(isReportable);
	if (reportable.length === 0) return undefined;
	const lines = reportable.flatMap(describeOutcome);
	const content =
		`Branch isolation left state that this boot had to look at (${reportable.length}):\n\n` +
		`${lines.join("\n")}\n\n` +
		`ADR 0026: the boot restores the recorded base only when the owning process is provably dead, ` +
		`HEAD is exactly the recorded work branch, and the working tree is clean. Anything else is left alone ` +
		`and named here.`;
	return {
		customType: HEAD_STATE_NOTICE_CUSTOM_TYPE,
		content,
		display: true,
		details: { count: reportable.length, verdicts: reportable.map((o) => o.verdict) },
	};
}

/** Options for `sweepHeadStates`. */
export interface HeadStateSweepOptions {
	/** Age past which an unreachable record is housekeeping (default 30 days). */
	maxAgeMs?: number;
	/** Injectable clock (tests). */
	now?: number;
	/**
	 * True when the record's repository no longer resolves. Injected because this
	 * module never runs git — and because it is what keeps the sweep honest: a
	 * LIVE repository's record is never swept, however old it is.
	 */
	repoGone(record: HeadStateRecord): boolean;
}

/**
 * Bounded, boot-time housekeeping (precedent: `cleanupTempDirs`): delete the
 * records that can never be acted on — the repository is gone, or the file
 * cannot be parsed (it names no repository, so it is judged by its own age).
 * Returns the number removed. Never throws.
 */
export function sweepHeadStates(options: HeadStateSweepOptions): number {
	const maxAgeMs = options.maxAgeMs ?? HEAD_STATE_SWEEP_AGE_MS;
	const now = options.now ?? Date.now();
	let removed = 0;
	for (const entry of listHeadStateEntries()) {
		try {
			if (entry.read.state === "ok") {
				const age = now - Date.parse(entry.read.record.createdAt);
				// NaN (a bad timestamp) is NOT old: keep it, never sweep on a parse failure.
				if (!(age > maxAgeMs) || !options.repoGone(entry.read.record)) continue;
			} else if (entry.read.state === "corrupt") {
				if (!(now - statSync(entry.file).mtimeMs > maxAgeMs)) continue;
			} else {
				continue;
			}
			unlinkSync(entry.file);
			removed++;
		} catch {
			// A record that vanished mid-scan is already the desired end state.
		}
	}
	return removed;
}

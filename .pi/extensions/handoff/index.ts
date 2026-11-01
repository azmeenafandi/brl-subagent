/**
 * handoff — inject the `.development/HANDOFF.md` §STATE snapshot into a session.
 *
 * INTERNAL dev-process tooling for the brl-subagent repo. It lives in
 * `.pi/extensions/` (pi project-local auto-discovery, TRACKED since #247) and is
 * NOT part of the shipped `brl-subagent` extension — zero public surface.
 *
 * Why: HANDOFF.md is load-bearing across compaction but has no trigger, and the
 * compaction summary cannot be trusted to carry it (a summary is lossy). The
 * extension re-injects the §STATE snapshot when a session starts and after every
 * compaction, prefixed with a `Verified:` staleness line compared to dev HEAD.
 * The comparison ignores a delta made only of the handoff's own commits (#393):
 * `Verified:` can never name the commit that writes it, so that one-commit lag
 * is not drift. A commit is judged by its diff against its FIRST parent (merges
 * and renames both count, #395), and any commit whose paths are empty or
 * unparseable is drift — the delta never matches vacuously.
 *
 * Deliberate boundaries:
 *  - No `session_before_compact` handler. pi-vcc owns that event and the runner
 *    keeps the LAST non-null result; a cancel here could interfere or loop.
 *    Staleness is surfaced by comparison, never by blocking a compaction.
 *  - Read-only with respect to the handoff, except `/handoff mark`, which
 *    touches only the `Verified:` line inside §STATE.
 *  - Inert in subagents, worktrees, non-`dev` branches and non-project cwds.
 *    Inertness is the safety property: a child subagent or a worktree must never
 *    receive this snapshot (children DO load project extensions).
 *
 * Contract: `.pi/skills/handoff/references/handoff.md`.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildInjection,
	buildStaleness,
	dedupeKey,
	extractStateSection,
	hasInjected,
	isHandoffOwnCommit,
	isSubagent,
	parseDiffPaths,
	parseRevList,
	parseVerified,
	replaceVerified,
	sameRevision,
	shouldInject,
	shortSha,
	VERIFY_COMMANDS,
	type RangeCommit,
	type RangeDelta,
	type Staleness,
} from "./lib";

const HANDOFF_REL = join(".development", "HANDOFF.md");

/** Session-log entry type for the shutdown staleness line (not model context). */
const SHUTDOWN_LOG_TYPE = "handoff-state-shutdown";

interface Snapshot {
	path: string;
	raw: string;
	state: string;
	verified: string | null;
	head: string | null;
	staleness: Staleness;
}

type Probe = { ok: true; snapshot: Snapshot } | { ok: false; reason: string };

/** One git invocation, or null when the spawn itself failed. Never throws. */
async function gitRun(
	pi: ExtensionAPI,
	cwd: string,
	args: string[],
): Promise<{ code: number; stdout: string } | null> {
	try {
		const result = await pi.exec("git", args, { cwd, timeout: 5_000 });
		return { code: result.code, stdout: result.stdout };
	} catch {
		return null;
	}
}

/** One git line, or null when git fails / prints nothing. */
async function gitLine(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string | null> {
	const result = await gitRun(pi, cwd, args);
	if (result === null || result.code !== 0) return null;
	const line = result.stdout.trim();
	return line === "" ? null : line;
}

/**
 * One commit's paths, from its diff against its FIRST parent.
 *
 * `git log --name-only` prints NO paths for a merge commit, so a merge whose
 * resolution introduced a foreign file read as handoff-only (a vacuous
 * `every()` over an empty list). The first-parent diff is exactly the
 * resolution's changes — `--cc`/`-c` can omit, so they are not used. `-M` folds
 * a rename into one record, and `parseDiffPaths` keeps BOTH of its paths, so
 * neither a foreign file renamed to `HANDOFF.md` nor the reverse can hide the
 * foreign side. A root commit has no `<sha>^`, hence `diff-tree --root`.
 *
 * `null` when git failed or the output did not parse — the caller reports an
 * empty path list, which reads as foreign (never a vacuous match).
 */
async function commitPaths(
	pi: ExtensionAPI,
	cwd: string,
	sha: string,
	isRoot: boolean,
): Promise<string[] | null> {
	const args = isRoot
		? ["diff-tree", "--root", "-r", "--no-commit-id", "--name-status", "-M", "-z", sha]
		: ["diff", "--name-status", "-M", "-z", `${sha}^`, sha];
	const result = await gitRun(pi, cwd, args);
	if (result === null || result.code !== 0) return null;
	return parseDiffPaths(result.stdout);
}

/**
 * The `Verified..HEAD` delta, for the self-commit lag (#393). Only called when
 * the shas already disagree: `Verified: <sha>` can never equal the sha of the
 * commit that writes it, so the handoff's own commit must not read as drift.
 *
 * Ancestor check first — a `Verified:` that is not an ancestor of HEAD is real
 * drift (rebase, amend, another branch), never the handoff's own commit. `null`
 * means the range could not be resolved: the caller keeps today's RECONCILE.
 *
 * Paths are collected per commit (see `commitPaths`), not from one `git log`
 * pass: the log omits merge diffs and cannot tell a rename's two sides apart.
 * The walk stops at the first commit that is not the handoff's own — the verdict
 * cannot improve after it, so a long drifted range costs a couple of diffs.
 */
async function resolveDelta(pi: ExtensionAPI, cwd: string, verified: string): Promise<RangeDelta | null> {
	// `merge-base --is-ancestor` prints nothing: 0 = ancestor, 1 = not, else unknown.
	const ancestor = await gitRun(pi, cwd, ["merge-base", "--is-ancestor", verified, "HEAD"]);
	if (ancestor === null || ancestor.code > 1) return null;
	if (ancestor.code === 1) return { ancestor: false, commits: [] };
	// One call for the range: each commit's sha, then its parents (none = root).
	const listing = await gitRun(pi, cwd, ["rev-list", "--parents", `${verified}..HEAD`]);
	if (listing === null || listing.code !== 0) return null;
	const entries = parseRevList(listing.stdout);
	// Verified is an ancestor whose sha differs from HEAD, so the range cannot be
	// empty: an empty listing means the output was lost, not a match.
	if (entries.length === 0) return null;
	const commits: RangeCommit[] = [];
	for (const entry of entries) {
		const paths = await commitPaths(pi, cwd, entry.sha, entry.parents.length === 0);
		const commit: RangeCommit = { sha: entry.sha, paths: paths ?? [] };
		commits.push(commit);
		if (!isHandoffOwnCommit(commit)) break;
	}
	return { ancestor: true, commits };
}

/**
 * Resolve the snapshot, or a reason the extension is inert here.
 *
 * The subagent check runs BEFORE any fs/git work: a child must see no reads and
 * no commands. The branch check runs before the file read, so a worktree (its
 * own toplevel, branch != dev) exits on one `rev-parse`.
 */
async function probe(pi: ExtensionAPI, ctx: ExtensionContext): Promise<Probe> {
	if (isSubagent(process.env)) return { ok: false, reason: "running inside a subagent" };
	const cwd = ctx.cwd || process.cwd();
	const root = await gitLine(pi, cwd, ["rev-parse", "--show-toplevel"]);
	if (root === null) return { ok: false, reason: "cwd is not a git checkout" };
	const branch = await gitLine(pi, cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
	const path = join(root, HANDOFF_REL);
	const hasFile = existsSync(path);
	if (!shouldInject(process.env, branch, hasFile)) {
		const reason =
			branch !== "dev" ? `not the cockpit on dev (branch ${branch ?? "unknown"})` : `no ${HANDOFF_REL}`;
		return { ok: false, reason };
	}
	let raw: string;
	try {
		raw = readFileSync(path, "utf8");
	} catch {
		return { ok: false, reason: `${HANDOFF_REL} is unreadable` };
	}
	const state = extractStateSection(raw);
	if (state === null) return { ok: false, reason: `${HANDOFF_REL} has no §STATE section` };
	const head = await gitLine(pi, cwd, ["rev-parse", "HEAD"]);
	const verified = parseVerified(state);
	// Only resolve the range when the shas disagree — the common case is one
	// extra pair of git calls per injection, and never more than that.
	const delta =
		verified !== null && head !== null && !sameRevision(verified, head)
			? await resolveDelta(pi, cwd, verified)
			: null;
	return {
		ok: true,
		snapshot: { path, raw, state, verified, head, staleness: buildStaleness(verified, head, delta) },
	};
}

/**
 * Inject the snapshot. `dedupe` is on for session_start (a reload or resume whose
 * context already carries the identical snapshot must not duplicate it) and off
 * for session_compact (a compaction is a context reset — always re-inject).
 */
async function inject(pi: ExtensionAPI, ctx: ExtensionContext, dedupe: boolean): Promise<void> {
	const result = await probe(pi, ctx);
	if (!result.ok) return;
	const { snapshot } = result;
	const content = buildInjection(snapshot.staleness, snapshot.state);
	if (dedupe && hasInjected(ctx.sessionManager.getBranch(), content)) return;
	// Passive context: no triggerTurn (a snapshot is not a run). `display` is a
	// boolean in the SDK's CustomMessage — the snapshot renders in the transcript.
	pi.sendMessage({ customType: dedupeKey(), content, display: true }, { deliverAs: "nextTurn" });
}

/** `/handoff` — show the snapshot, or rewrite `Verified:` with `/handoff mark`. */
async function show(ctx: ExtensionContext, snapshot: Snapshot): Promise<void> {
	const report = [
		snapshot.staleness.line,
		"",
		snapshot.state,
		"",
		"Verify commands:",
		...VERIFY_COMMANDS.map((command) => `  ${command}`),
	].join("\n");
	if (ctx.hasUI) {
		// A multi-line view; the returned text is ignored (Esc closes).
		await ctx.ui.editor("HANDOFF §STATE — view (edits are discarded)", report);
		return;
	}
	ctx.ui.notify(report, "info");
}

function mark(ctx: ExtensionContext, snapshot: Snapshot): void {
	if (snapshot.head === null) {
		ctx.ui.notify("handoff: HEAD could not be read — nothing marked.", "error");
		return;
	}
	const date = new Date().toISOString().slice(0, 10);
	const updated = replaceVerified(snapshot.raw, snapshot.head, date);
	if (updated === null) {
		ctx.ui.notify(`handoff: ${HANDOFF_REL} has no §STATE section — nothing marked.`, "error");
		return;
	}
	if (updated === snapshot.raw) {
		ctx.ui.notify(`handoff: Verified already points at ${shortSha(snapshot.head)} (${date}).`, "info");
		return;
	}
	try {
		writeFileSync(snapshot.path, updated, "utf8");
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		ctx.ui.notify(`handoff: could not rewrite ${HANDOFF_REL} — ${message}`, "error");
		return;
	}
	ctx.ui.notify(
		`handoff: Verified → ${shortSha(snapshot.head)} (${date}). The CONTENT is still yours to reconcile.`,
		"info",
	);
}

export default function initHandoff(pi: ExtensionAPI) {
	pi.on("session_start", async (_event, ctx) => {
		await inject(pi, ctx, true);
	});

	// Post-compaction: the summary is lossy, the snapshot is not. Always inject.
	pi.on("session_compact", async (_event, ctx) => {
		await inject(pi, ctx, false);
	});

	// Log-only: the staleness line lands in the session log (a custom entry —
	// persisted, excluded from model context). No UI, no message.
	pi.on("session_shutdown", async (_event, ctx) => {
		const result = await probe(pi, ctx);
		if (!result.ok) return;
		pi.appendEntry(SHUTDOWN_LOG_TYPE, {
			staleness: result.snapshot.staleness.line,
			verified: result.snapshot.verified,
			head: result.snapshot.head,
		});
	});

	pi.registerCommand("handoff", {
		description: "Show the HANDOFF §STATE snapshot + staleness + verify commands; `/handoff mark` sets Verified to HEAD",
		getArgumentCompletions: (prefix) =>
			"mark".startsWith(prefix.trim()) ? [{ value: "mark", label: "mark — rewrite Verified to HEAD" }] : null,
		handler: async (args, ctx) => {
			const command = args.trim();
			if (command !== "" && command !== "mark") {
				ctx.ui.notify("handoff: usage — /handoff (show) | /handoff mark (rewrite Verified to HEAD)", "warning");
				return;
			}
			const result = await probe(pi, ctx);
			if (!result.ok) {
				ctx.ui.notify(`handoff: inert here — ${result.reason}.`, "info");
				return;
			}
			if (command === "mark") mark(ctx, result.snapshot);
			else await show(ctx, result.snapshot);
		},
	});
}

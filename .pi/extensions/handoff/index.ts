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
	isSubagent,
	parseVerified,
	replaceVerified,
	shouldInject,
	shortSha,
	VERIFY_COMMANDS,
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

/** One git line, or null when git fails / prints nothing. Never throws. */
async function gitLine(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string | null> {
	try {
		const result = await pi.exec("git", args, { cwd, timeout: 5_000 });
		if (result.code !== 0) return null;
		const line = result.stdout.trim();
		return line === "" ? null : line;
	} catch {
		return null;
	}
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
	return { ok: true, snapshot: { path, raw, state, verified, head, staleness: buildStaleness(verified, head) } };
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

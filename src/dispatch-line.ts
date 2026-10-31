// Purpose: Parse and validate the Rule 22 dispatch line, plus the project-local opt-in that makes it required.
/**
 * The Jev dispatch line — parse side (issue #412, absorbing #407).
 *
 * A dispatch task carries one classifier line:
 *
 *     jev: medium (0.84) · C2 · worktree y
 *
 * `.pi/skills/worktree/jev-check.mjs` already PARSES that line for the audit
 * (`--log`, `--ledger`) and FORMATS it (`--line`). This module is the
 * dispatch-time half: the pre-flight needs the verdict before a spawn, and
 * `.pi/` is not shipped (it is dev process tooling), so the extension cannot
 * import the script. A second implementation is a second source of truth —
 * which is why `dispatch-line.test.ts` shells the real script and requires
 * accept/reject agreement on a vector set, and why the two patterns below are
 * kept byte-comparable with the script's (`DISPATCH_LINE_PATTERN`,
 * `BARE_DISPATCH_LINE_PATTERN`, `GAP_MARKERS`). Change one, change both.
 *
 * The check is OPT-IN per project: `package.json` carries
 * `{"brl-subagent": {"requireJevLine": true}}`. Absent (every user's project)
 * → no check, ever: this is our process, not a product requirement (ADR 0018).
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The exact form a dispatch task must carry — quoted verbatim in every
 * rejection so the conductor never has to guess. Kept identical to
 * `REQUIRED_DISPATCH_FORM` in `jev-check.mjs`.
 */
export const DISPATCH_LINE_FORM = "jev: <level> (<0.xx>) · C<1|2|3> · worktree <y|n>";

/**
 * The sanctioned escape when the classifier did not run (SKILL.md: "record
 * `jev: unavailable` and proceed — never block a dispatch on the classifier").
 * It is a RECORDED gap, not a silent one, and it is accepted by both this
 * parser and the script's audit.
 */
export const JEV_UNAVAILABLE = "jev: unavailable";

const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"] as const;
const RISKS = ["C1", "C2", "C3"] as const;

/**
 * The line as it appears inside a dispatch task. Mirrors `jev-check.mjs`'s
 * `DISPATCH_LINE_PATTERN`: the confidence group is OPTIONAL so a bare level
 * can be reported as such (the skip's exact form) instead of a generic
 * "invalid". The worktree token is a word because the script's normalizer
 * accepts y|yes|true / n|no|false.
 */
const DISPATCH_LINE_PATTERN =
	/jev:\s*([A-Za-z]+)\s*(?:\(\s*([0-9.]+)\s*\))?\s*·\s*(C\d)\s*·\s*worktree\s*([A-Za-z]+)/i;

/** A line that at least TRIED to be a dispatch line — tells "bare level" from "missing". */
const BARE_DISPATCH_LINE_PATTERN = /jev:\s*(?:off|minimal|low|medium|high|xhigh)\b/i;

/**
 * Explicit "the classifier did not run" markers. Mirrors `GAP_MARKERS` in
 * `jev-check.mjs`, anchored to the `jev:` prefix so prose that merely contains
 * the word "unavailable" cannot pass as a classification.
 */
const GAP_MARKER_PATTERN = /^jev:\s*(?:unavailable|not classified|n\/a|ritual gap)\b/i;

export type DispatchLineVerdict =
	| { ok: true; line: string }
	| { ok: false; reason: string };

/** Keep a refusal reason to one readable line (mirrors the script's `clip`). */
function clip(text: string, limit = 110): string {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

function normalizeWorktree(value: string): "y" | "n" | undefined {
	const normalized = value.trim().toLowerCase();
	if (normalized === "y" || normalized === "yes" || normalized === "true") return "y";
	if (normalized === "n" || normalized === "no" || normalized === "false") return "n";
	return undefined;
}

/**
 * Parse a dispatch task for the Rule 22 line. Any line may satisfy it (the
 * script audits per line and accepts the first valid one), and the returned
 * `line` is the matched canonical text — not the whole raw line, which may
 * carry a recorded reason after it.
 *
 * The reason strings mirror the script's, because the same wording is what
 * closes the loop for the conductor: a bare level names the confidence as the
 * missing piece, and a missing line names the exact form.
 */
export function parseDispatchLine(task: string): DispatchLineVerdict {
	const attempts: string[] = [];
	for (const raw of String(task).split(/\r?\n/)) {
		if (!/jev:/i.test(raw)) continue;
		const line = raw.trim();
		if (GAP_MARKER_PATTERN.test(line)) return { ok: true, line };

		const match = DISPATCH_LINE_PATTERN.exec(line);
		if (match === null) {
			attempts.push(
				BARE_DISPATCH_LINE_PATTERN.test(line)
					? `bare level without its classifier confidence — ${clip(line)}`
					: `unparseable dispatch line — ${clip(line)}`,
			);
			continue;
		}

		const [, levelText, confidenceText, riskText, worktreeText] = match;
		// The regex accepts a confidence-less line on purpose: naming the
		// missing confidence is what makes the rejection actionable.
		if (confidenceText === undefined) {
			attempts.push(`bare level without its classifier confidence — ${clip(line)}`);
			continue;
		}

		const level = levelText.toLowerCase();
		if (!(LEVELS as readonly string[]).includes(level)) {
			attempts.push(`unknown thinking level "${levelText}" — ${clip(line)}`);
			continue;
		}
		const risk = riskText.toUpperCase();
		if (!(RISKS as readonly string[]).includes(risk)) {
			attempts.push(`unknown risk class "${riskText}" — ${clip(line)}`);
			continue;
		}
		const confidence = Number(confidenceText);
		if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) {
			attempts.push(`confidence out of range "${confidenceText}" — ${clip(line)}`);
			continue;
		}
		const worktree = normalizeWorktree(worktreeText);
		if (worktree === undefined) {
			attempts.push(`invalid workspace answer "${worktreeText}" — ${clip(line)}`);
			continue;
		}
		return { ok: true, line: match[0] };
	}

	if (attempts.length === 0) {
		return { ok: false, reason: `missing Jev dispatch line (${DISPATCH_LINE_FORM})` };
	}
	return { ok: false, reason: attempts[0] };
}

/**
 * Whether the project at `cwd` opted in. Read from the project's OWN
 * `package.json` — tracked, so it exists in every worktree (worktrees share
 * the repo's manifest), unlike a gitignored marker under `.pi/`.
 *
 * A missing, unreadable or malformed manifest is OFF, never an error: the
 * check must never turn a project's packaging mistake into a rejected
 * dispatch (and a user's project has no such field at all).
 */
export function isJevLineRequired(cwd: string | undefined): boolean {
	if (cwd === undefined || cwd === "") return false;
	try {
		const manifest = JSON.parse(readFileSync(join(cwd, "package.json"), "utf8")) as {
			"brl-subagent"?: { requireJevLine?: unknown };
		};
		return manifest["brl-subagent"]?.requireJevLine === true;
	} catch {
		return false;
	}
}

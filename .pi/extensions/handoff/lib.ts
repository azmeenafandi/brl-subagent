/**
 * Pure helpers for the handoff extension — no fs, no git, no pi API.
 *
 * The extension injects the `.development/HANDOFF.md` §STATE snapshot at session
 * start and after every compaction. Everything that decides WHAT the snapshot
 * says lives here so it can be tested from a plain `node` script
 * (`handoff.test.cjs`, the worktree-guard pattern); reads, git calls and
 * `pi.sendMessage` stay in `index.ts`.
 *
 * Contract: `.pi/skills/handoff/references/handoff.md`.
 */

/** Custom message type for an injected snapshot — also the dedupe key. */
export const HANDOFF_CUSTOM_TYPE = "handoff-state";

export type StalenessStatus = "current" | "stale" | "unverified";

export interface Staleness {
	status: StalenessStatus;
	/** One-line banner prepended to the injected snapshot. */
	line: string;
}

/**
 * Verify commands, mirrored from `.pi/skills/handoff/references/handoff.md`
 * (the reference is the source of truth; `handoff.test.cjs` pins the two in
 * sync). Every §STATE claim names one of these (or is marked unverified).
 */
export const VERIFY_COMMANDS = [
	"tips     git log -1 --oneline dev",
	"install  pi list",
	"board    gh issue list",
	"release  gh release list",
	"deps     cat package.json   (pi/* + typebox pins)",
	"suite    npx vitest run",
	"hygiene  npx tsc --noEmit · node scripts/docs-arch.mjs · node scripts/docs-decisions.mjs",
];

/** §STATE heading — tolerates a trailing qualifier (`## STATE (2026-10-16, post-compaction)`). */
const STATE_HEADING = /^\s*##\s+STATE(?=[\s(]|$)/i;

/** Any other level-2 heading: the §STATE section ends here. */
const ANY_H2_HEADING = /^\s*##\s+\S/;

/** The `Verified:` marker line inside §STATE. */
const VERIFIED_MARKER = /^\s*Verified:\s*(.+)$/i;

/** A git sha: 7–40 hex chars, optionally backticked, followed by a word boundary. */
const SHA = /^(`?)([0-9a-f]{7,40})\1(?=$|\s)/i;

/** Short-sha length used in the staleness line. */
const SHORT_SHA = 7;

/**
 * True when the process is a delegated subagent (pi's depth marker is set).
 *
 * Subagent children load project extensions (the runner passes no
 * `--no-extensions`), so this guard is the inertness boundary — the extension
 * must do nothing in a child, not even read a file.
 */
export function isSubagent(env: Record<string, string | undefined>): boolean {
	const depth = env.BRL_SUBAGENT_DEPTH;
	return typeof depth === "string" && depth.trim() !== "";
}

/**
 * The injection gate: the cockpit on `dev`, with the handoff file present, in a
 * normal (non-subagent) process. All three must pass; anything else is inert.
 */
export function shouldInject(
	env: Record<string, string | undefined>,
	branch: string | null,
	hasFile: boolean,
): boolean {
	if (isSubagent(env)) return false;
	if (branch !== "dev") return false;
	return hasFile;
}

/** The §STATE line span of a document, or null when it has no §STATE heading. */
interface StateRange {
	/** The document, split on CRLF or LF. */
	lines: string[];
	/** Index of the `## STATE` heading line (always included in the section). */
	start: number;
	/** Index one past the section: the next `## ` heading, or EOF. */
	end: number;
}

/**
 * Locate §STATE: from the `## STATE` heading to the next `## ` heading (or EOF
 * when the file is truncated). Single source of truth for the range scan — the
 * extraction and the `Verified:` rewrite must agree on what §STATE is.
 */
function findStateRange(raw: string): StateRange | null {
	const lines = raw.split(/\r?\n/);
	const start = lines.findIndex((line) => STATE_HEADING.test(line));
	if (start === -1) return null;
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i += 1) {
		if (ANY_H2_HEADING.test(lines[i])) {
			end = i;
			break;
		}
	}
	return { lines, start, end };
}

/**
 * The §STATE section text. Returns null when no §STATE heading exists. Trailing
 * blank lines are dropped; the heading itself is kept.
 */
export function extractStateSection(raw: string): string | null {
	const range = findStateRange(raw);
	if (range === null) return null;
	const { lines, start, end } = range;
	const section = lines.slice(start, end);
	while (section.length > 1 && section[section.length - 1].trim() === "") section.pop();
	return section.join("\n");
}

/**
 * The sha from the first `Verified: <sha>` line, lowercased; null when the line
 * is absent or malformed. Accepts a date suffix (`Verified: abc1234 (2026-10-17)`)
 * and backticks. The first marker line decides — a malformed line is NOT
 * skipped in favour of a later one, so a typo cannot silently pass.
 */
export function parseVerified(raw: string): string | null {
	for (const line of raw.split(/\r?\n/)) {
		const marker = VERIFIED_MARKER.exec(line);
		if (!marker) continue;
		const sha = SHA.exec(marker[1].trim());
		return sha ? sha[2].toLowerCase() : null;
	}
	return null;
}

/** First `SHORT_SHA` chars of a sha (unchanged when already shorter). */
export function shortSha(sha: string): string {
	return sha.length > SHORT_SHA ? sha.slice(0, SHORT_SHA) : sha;
}

/**
 * True when the recorded sha and HEAD name the same revision — one is a prefix
 * of the other, since `Verified:` may be short (7) or full (40).
 */
export function sameRevision(verified: string | null, head: string | null): boolean {
	if (verified === null || verified === "") return false;
	const recorded = verified.toLowerCase();
	const current = (head ?? "").toLowerCase();
	if (current === "") return false;
	return current.startsWith(recorded) || recorded.startsWith(current);
}

/**
 * The handoff's own paths: the snapshot file and its archives. A commit that
 * touches only these cannot have changed the tree `Verified:` describes.
 */
const HANDOFF_OWN_PATH = /^\.development\/HANDOFF(?:\.md|-ARCHIVE-[^/]+\.md)$/;

/** True when `path` is the handoff file or one of its archives. */
export function isHandoffOwnPath(path: string): boolean {
	return HANDOFF_OWN_PATH.test(path.trim());
}

/** One commit in the `Verified..HEAD` range, with the paths it touched. */
export interface RangeCommit {
	sha: string;
	paths: readonly string[];
}

/**
 * The `Verified..HEAD` delta, resolved by the caller — git stays in `index.ts`.
 *
 * `ancestor: false` means `Verified:` is not an ancestor of HEAD: real drift
 * (rebase, amend, another branch), never the handoff's own commit.
 */
export interface RangeDelta {
	ancestor: boolean;
	commits: readonly RangeCommit[];
}

/**
 * Parse `git log --format=%x00%H --name-only <verified>..HEAD` into commits.
 *
 * The NUL prefix delimits commits (a path never contains one); the blank line
 * git prints between the header and the file list is dropped. A commit with no
 * paths is legal — git prints no diff for a merge commit, and the commits it
 * merges are listed individually, so such a commit touched nothing of its own.
 */
export function parseRangeLog(raw: string): RangeCommit[] {
	const commits: RangeCommit[] = [];
	for (const chunk of raw.split("\u0000")) {
		const lines = chunk.split(/\r?\n/);
		const sha = (lines.shift() ?? "").trim();
		if (sha === "") continue;
		const paths = lines.map((line) => line.trim()).filter((line) => line !== "");
		commits.push({ sha, paths });
	}
	return commits;
}

/** A commit whose every path belongs to the handoff itself. */
function isHandoffOwnCommit(commit: RangeCommit): boolean {
	return commit.paths.every((path) => isHandoffOwnPath(path));
}

/**
 * The staleness verdict, compared against the cockpit's HEAD.
 *
 * - `current` — the recorded sha is a prefix of HEAD (or vice versa); or every
 *   commit from `Verified:` to HEAD touches only the handoff itself (`delta`).
 * - `stale` — both known, and they disagree: §STATE may describe another tree.
 *   Includes a `Verified:` that is not an ancestor of HEAD, and a range with any
 *   commit outside the handoff (interleaved ranges are real drift).
 * - `unverified` — no `Verified:` line, or HEAD could not be read.
 *
 * `delta` is optional: without it the comparison is sha-only (today's behaviour
 * for callers that never resolved the range). The self-reference problem it
 * solves: `Verified: <sha>` can never equal the sha of the commit that writes it,
 * so a handoff-only delta of one commit would otherwise print RECONCILE forever.
 */
export function buildStaleness(
	verified: string | null,
	head: string | null,
	delta?: RangeDelta | null,
): Staleness {
	if (verified === null || verified === "") {
		return {
			status: "unverified",
			line: "Handoff has no Verified: line — verify §STATE against the repo before trusting it.",
		};
	}
	const recorded = verified.toLowerCase();
	const current = (head ?? "").toLowerCase();
	if (current === "") {
		return {
			status: "unverified",
			line: `Handoff verified at ${shortSha(recorded)} but HEAD could not be read — verify §STATE against the repo before trusting it.`,
		};
	}
	if (sameRevision(recorded, current)) {
		return { status: "current", line: `Handoff verified at ${shortSha(recorded)} — matches HEAD.` };
	}
	if (delta && delta.ancestor && delta.commits.length > 0 && delta.commits.every(isHandoffOwnCommit)) {
		return {
			status: "current",
			line: `Handoff verified at ${shortSha(recorded)} — matches HEAD (ignoring the handoff's own commit).`,
		};
	}
	return {
		status: "stale",
		line: `Handoff verified at ${shortSha(recorded)} but HEAD is ${shortSha(current)} — RECONCILE before trusting §STATE.`,
	};
}

/** The injected content: the staleness banner, a blank line, then §STATE. */
export function buildInjection(staleness: Staleness, state: string): string {
	return `${staleness.line}\n\n${state}`;
}

/** The dedupe key for injected snapshots (one source of truth for send + scan). */
export function dedupeKey(): string {
	return HANDOFF_CUSTOM_TYPE;
}

/** Text of a session entry's content (string, or the text parts of an array). */
export function messageText(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts: string[] = [];
	for (const part of content) {
		if (part && typeof part === "object") {
			const block = part as { type?: unknown; text?: unknown };
			if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
		}
	}
	return parts.join("\n");
}

/**
 * Dedupe against the current branch.
 *
 * Without `content`: true when any `handoff-state` message exists. With
 * `content`: true only when the MOST RECENT injected snapshot is byte-identical
 * to what would be injected now. Content comparison is deliberate — a reload
 * after a doc commit must surface the new staleness line (live check 2), while
 * a reload with nothing changed must not duplicate the snapshot in context.
 */
export function hasInjected(branchEntries: ReadonlyArray<unknown>, content?: string): boolean {
	let last: string | null = null;
	for (const entry of branchEntries) {
		if (!entry || typeof entry !== "object") continue;
		const candidate = entry as { type?: unknown; customType?: unknown; content?: unknown };
		if (candidate.type !== "custom_message" || candidate.customType !== dedupeKey()) continue;
		if (content === undefined) return true;
		last = messageText(candidate.content);
	}
	return last !== null && last === content;
}

/**
 * Rewrite the `Verified:` line inside §STATE to `Verified: <sha> (<date>)`.
 * When §STATE has no such line yet, insert one directly under the heading.
 * Returns null when the document has no §STATE section — the caller reports,
 * never guesses. A `Verified:` line OUTSIDE §STATE is left untouched.
 */
export function replaceVerified(raw: string, sha: string, date: string): string | null {
	const range = findStateRange(raw);
	if (range === null) return null;
	const { lines, start, end } = range;
	const replacement = `Verified: ${sha.toLowerCase()} (${date})`;
	for (let i = start + 1; i < end; i += 1) {
		if (VERIFIED_MARKER.test(lines[i])) {
			lines[i] = replacement;
			return lines.join("\n");
		}
	}
	const insertAt = start + 1;
	lines.splice(insertAt, 0, replacement);
	return lines.join("\n");
}

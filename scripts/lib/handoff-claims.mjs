// Purpose: The handoff's claim grammars and the drift verdict — pure, so the verdict is testable
// without a repo, a network or a subprocess (issue #495, and #607 for the index).
//
// TWO DOCUMENTS since #607. `.development/HANDOFF.md` is an INDEX: a section-bounded front page whose
// §STATE is four lines (Verified · In flight · Next action · Index) and whose §Invariants/§Pointers/
// §Resume protocol are bounded lists. The mechanical claims — dev sha, install, `Open:`, `Suite:`,
// modules, ADRs, file sizes — live in a PAGE, `.development/handoff/state.md`, in the grammar this module
// has always parsed. `parseClaims` is unchanged byte for byte: the page is read by the same function, so
// the grammar the previous handoff promised is the grammar the page keeps.
//
// The split is what makes the index small: §STATE carries no counts, so nothing in the injected snapshot
// can go stale in the way a suite total does, and the counts have a page that is opened on demand.
//
// Why the handoff is checked at all: §STATE is injected into every session and after every compaction, so
// a stale claim is not a doc nit — it is a wrong premise the next session starts from. Every
// reconciliation at U1 was mechanical (a stale suite count, a closed issue still in `Open:`, a stale dev
// sha), and a mechanical error belongs to a script, not to prose that the next rewrite can drop again.
//
// This module is the mechanical half: it reads the shapes §STATE promises (and nothing else), compares
// them against facts the caller supplies, and names each drift. It never reads a file, never shells out
// and never writes — `scripts/handoff-verify.mjs` supplies the repo facts behind one probe object, and
// `scripts/__tests__/handoff-verify.test.ts` supplies a stub.
//
// Seven CLAIM checks (the PAGE pass, `evaluateStatePage`), all inside `## STATE` (so prose elsewhere in
// the page is never parsed as a claim) — plus one STRUCTURAL check that reads the whole document and
// runs first:
//   structure       exactly one `## STATE` and one `## Open items`, and no H2 repeated. §STATE is the
//                   crash-resume point, so a document holding two copies of it has no single answer;
//                   a slice-replace that re-appended a whole block is the recurrence (#579).
//   1 verified      `Verified:` is an ancestor of HEAD, and every commit after it touches only the handoff
//                   and its archives — the extension's own rule (`.pi/extensions/handoff/lib.ts`), so the
//                   staleness banner and this check agree by construction.
//   2 dev-sha       `dev @ <sha>` equals the dev CLAIM — `git rev-parse dev` with its trailing handoff commits
//                   walked back (#497), so the handoff commit on top of the merge is not drift (short or full
//                   form, prefix either way).
//   3 install       the `Running install:` path exists; a `dev @ <sha>` on that line equals the same claim.
//   4 open-set      the `Open:` issue set equals `gh issue list --state open` (a `PR #402` mention is not
//                   an issue). `--no-network` skips it — a SKIP is printed, never counted as a pass.
//   5 suite-count   `Suite: N files / M tests` equals the counts in a vitest JSON report, and the
//                   optional `(N passed, M failed, K skipped)` suffix equals the derived breakdown. A RED
//                   report certifies nothing, whatever the totals say: `failed > 0`, `failedSuites > 0`
//                   (a load error fails a file, not an assertion) or `success === false` is `suite-red`.
//   6 modules/adrs  `<n> modules` / `<n> ADRs` equal the repo's own counters (`docs-arch`,
//                   `docs-decisions`).
//   7 file-size     every `` `name.ts` <n> `` claim in STATE equals `wc -l` of that file.
//
// A single-value claim (dev, modules, ADRs) may be STATED MORE THAN ONCE — the shape an edit leaves when
// it adds a line instead of replacing one. Every occurrence is a claim, exactly as for file sizes, so a
// duplicate that agrees is one ✓ and a duplicate that DISAGREES is a named drift, never a silent
// first-wins. (`Open:` is last-wins by the record-fields convention; `Verified:`, the install line and
// `Suite:` are single-line fields.)
//
// OUT OF SCOPE BY DESIGN: narrative claims — the cycle queue, `### Next actions` and the
// `### Since the last handover` bullets. They are prose, and the only mechanical reading of them is a
// guess at which queue item is "current"; a heuristic there would fail closed on a legitimate rewrite,
// which is a worse trade than a human reading three lines. The spec's non-goals say the same.
//
// The INDEX pass (`evaluateIndex`, #607) runs on `.development/HANDOFF.md` and is what makes "no
// history, no counts" mechanical rather than editorial: its contribution is STRUCTURE (the H2 set and
// the absence of H3), FORM (four §STATE fields, every line bounded), SIZE (the per-session budget), SET
// RELATIONS (every page indexed, every indexed page present), LIVENESS (an issue/sha/path citation is
// still true) and the ONE next action. It never parses a claim grammar: there are no claims in the
// index, which is the point. Residual, stated: this is structural smallness, not a proof that no prose
// can ever be smuggled into a bounded line.
//
// The drift codes, one per failure mode (the fixtures pin them):
//   state-drift  (a duplicated/missing `STATE`/`Open items`, and — the index — a wrong H2 set or any H3)
//   state-shape · section-over-bound · over-budget · unindexed-page · dead-link · issue-state-drift
//   sha-not-ancestor · path-missing · unattributed-count · next-action-ambiguous
//   next-action-issue-missing · next-action-state-missing
//   verified-missing · verified-not-ancestor · verified-drift
//   dev-claim-missing · dev-sha-drift
//   install-claim-missing · install-missing · install-sha-drift
//   open-claim-missing · open-set-drift
//   suite-claim-missing · suite-count-drift · suite-red
//   modules-missing · modules-drift · adrs-missing · adrs-drift
//   file-missing · file-size-drift

/** "Cannot check" — no report, no `dev` ref, `gh` unavailable, an unreadable input. Exit 2, never drift. */
export class InputError extends Error {}

/** The drift codes, one per failure mode. A test asserts each one is reachable from a fixture. */
export const CODES = Object.freeze({
	verifiedMissing: "verified-missing",
	verifiedNotAncestor: "verified-not-ancestor",
	verifiedDrift: "verified-drift",
	devClaimMissing: "dev-claim-missing",
	devShaDrift: "dev-sha-drift",
	installClaimMissing: "install-claim-missing",
	installMissing: "install-missing",
	installShaDrift: "install-sha-drift",
	openClaimMissing: "open-claim-missing",
	openSetDrift: "open-set-drift",
	suiteClaimMissing: "suite-claim-missing",
	suiteCountDrift: "suite-count-drift",
	suiteRed: "suite-red",
	modulesMissing: "modules-missing",
	modulesDrift: "modules-drift",
	adrsMissing: "adrs-missing",
	adrsDrift: "adrs-drift",
	fileMissing: "file-missing",
	fileSizeDrift: "file-size-drift",
	stateDrift: "state-drift",
	// #607 — the index's own failure modes. One code per seeded violation; `parseClaims` knows none of
	// them, which is how the page's grammar stays unchanged.
	stateShape: "state-shape",
	sectionOverBound: "section-over-bound",
	overBudget: "over-budget",
	unindexedPage: "unindexed-page",
	deadLink: "dead-link",
	issueStateDrift: "issue-state-drift",
	shaNotAncestor: "sha-not-ancestor",
	pathMissing: "path-missing",
	unattributedCount: "unattributed-count",
	nextActionAmbiguous: "next-action-ambiguous",
	nextActionIssueMissing: "next-action-issue-missing",
	nextActionStateMissing: "next-action-state-missing",
});

const SHA = "[0-9a-f]{7,40}";

/** Two shas name the same commit when one is a prefix of the other — `Verified:` may be short. */
export function sameRevision(left, right) {
	const a = String(left ?? "").toLowerCase();
	const b = String(right ?? "").toLowerCase();
	if (a === "" || b === "") return false;
	return a === b || b.startsWith(a) || a.startsWith(b);
}

/**
 * The paths a commit may touch without moving the tree §STATE describes: the index, its archives and the
 * pages under `.development/handoff/` — byte-for-byte the extension's `HANDOFF_OWN_PATH`
 * (`.pi/extensions/handoff/lib.ts`). No trimming: a path is matched exactly as git reports it, so
 * `.development/HANDOFF.md ` (trailing space) stays foreign.
 *
 * The pages joined the list with the index (#607): `Verified:` cannot name the commit that writes the
 * page it points at either, so a page-only commit is the handoff's own work — the same rule that keeps the
 * extension's banner from printing RECONCILE after every handoff commit.
 */
export function isHandoffOwnPath(path) {
	return /^\.development\/(?:HANDOFF(?:\.md|-ARCHIVE-[^/]+\.md)|handoff\/[^/]+\.md)$/.test(path);
}

/**
 * A commit whose every path belongs to the handoff. A commit with NO paths is NOT handoff-only: an empty
 * list is also what a failed diff looks like, and a vacuous `every()` would report a merge that introduced
 * a foreign file as handoff-only. Same rule as the extension's `isHandoffOwnCommit`.
 */
export function isHandoffOwnCommit(commit) {
	return Array.isArray(commit.paths) && commit.paths.length > 0 && commit.paths.every(isHandoffOwnPath);
}

// ---------------------------------------------------------------------------
// Structure — the document's H2 headings, read outside fenced code blocks.
//
// The recurrence (#579): a slice-replace re-appended a whole `## STATE … ## Open items` block, and the
// checker read the first `## STATE` only, so the stale copy was invisible — 0 drift, and the only
// detector was `grep -c '^## STATE'`. ONE scanner answers both questions: which headings exist (a
// duplicate is named) and where the STATE body ends (the claims are read from the section the scan
// reported). Two parsers could disagree — the old one ignored fences, so a fenced `## STATE` could be
// the section read while a fence-aware scan certified "one STATE".
//
// The fence grammar is a STATED CommonMark subset, not "fenced code" in general:
//   opener  ^ {0,3}(`{3,}|~{3,})(info)$     indented at most 3; a backtick info string may not contain `
//   closer  ^ {0,3}(same char){n} [ \t]*$   n >= the opener's length, and WHITESPACE ONLY after the run
// A closer cannot carry an info string, so a ```js line inside a block is CONTENT; an opener left open
// masks to EOF. ACCEPTED RESIDUALS (spec §5): an unclosed fence masks to EOF (R4 — the safer direction,
// no claim is invented), and a heading inside an HTML comment counts as a second heading (R2 — comments
// are not parsed).
// ---------------------------------------------------------------------------

/** `^##[ \t]+` — the grammar `stateSection` always accepted, tabs included; `### ` is not an H2. */
const HEADING_RE = /^##[ \t]+(\S.*)$/;
/** An opener: at most three spaces, then a run of three or more backticks or tildes, then the info string. */
const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})(.*)$/;
/** A closer: the same character, at least the opener's length, then WHITESPACE ONLY. */
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

/** A line without its `\r`, so a CRLF document fences and headings like an LF one. */
function withoutCr(line) {
	return line.endsWith("\r") ? line.slice(0, -1) : line;
}

/** The fence a line OPENS, or `null`. A backtick info string may not contain a backtick (CommonMark). */
function openedFence(line) {
	const match = FENCE_OPEN_RE.exec(line);
	if (match === null) return null;
	if (match[1][0] === "`" && match[2].includes("`")) return null;
	return { char: match[1][0], length: match[1].length };
}

/** Whether a line CLOSES `fence` — same character, at least as long, nothing but whitespace after. */
function closesFence(line, fence) {
	const match = FENCE_CLOSE_RE.exec(line);
	if (match === null) return false;
	return match[1][0] === fence.char && match[1].length >= fence.length;
}

/**
 * Every line, with the one fence rule already applied: `fenced` is true for the opener, the content and
 * the closer. Both public helpers walk THIS, so the scanner and the masker cannot drift apart (DRY).
 */
function* fenceLines(text) {
	let fence = null;
	for (const [index, raw] of String(text).split("\n").entries()) {
		const line = withoutCr(raw);
		if (fence !== null) {
			if (closesFence(line, fence)) fence = null;
			yield { index, raw, line, fenced: true };
		} else {
			const opened = openedFence(line);
			if (opened !== null) fence = opened;
			yield { index, raw, line, fenced: opened !== null };
		}
	}
}

/** The headings grouped by text, keyed in document order of the first occurrence (Map insertion order). */
function headingsByText(headings) {
	const byText = new Map();
	for (const heading of headings) {
		const lines = byText.get(heading.text);
		if (lines === undefined) byText.set(heading.text, [heading.line]);
		else lines.push(heading.line);
	}
	return byText;
}

/**
 * Every H2 heading in document order, outside fenced code blocks, plus the texts that repeat. `line` is
 * ONE-BASED (a reader's line number, which is what a drift detail names); trailing whitespace is not part
 * of the text, so `## STATE  ` and `## STATE` are the same heading.
 */
export function scanHeadings(text) {
	const headings = [];
	for (const { index, line, fenced } of fenceLines(text)) {
		if (fenced) continue;
		const match = HEADING_RE.exec(line);
		if (match !== null) headings.push({ text: match[1].trimEnd(), line: index + 1 });
	}
	const duplicates = [...headingsByText(headings)]
		.filter(([, lines]) => lines.length > 1)
		.map(([text, lines]) => ({ text, lines }));
	return { headings, duplicates };
}

/**
 * The same fence rule applied to a BODY: every fenced line becomes an empty line, offsets preserved — so
 * a claim regex run over the result keeps the line positions of the original (and a fenced example can
 * never supply the mechanical claim). An unclosed fence masks to EOF.
 */
export function maskFences(text) {
	return [...fenceLines(text)]
		.map(({ raw, fenced }) => (fenced ? "" : raw))
		.join("\n");
}

/** The section body given the headings already scanned — `parseClaims` scans once and passes them in. */
function sectionBody(text, headings) {
	const lines = String(text).split("\n");
	const start = headings.find((heading) => heading.text === "STATE");
	if (start === undefined) return null;
	const next = headings.find((heading) => heading.line > start.line);
	const end = next === undefined ? lines.length : next.line - 1;
	return lines.slice(start.line, end).join("\n");
}

/**
 * The `## STATE` section's body: from the first `## STATE` heading to the line before the NEXT heading the
 * scan reports (or EOF). `null` when the file has no such section, which is a usage fault, not a drift
 * (there is nothing to check). The boundary is the SCANNER's, so the section read and the headings counted
 * cannot disagree — and a fenced `## STATE` is a heading to neither.
 */
export function stateSection(text) {
	return sectionBody(text, scanHeadings(text).headings);
}

// ---------------------------------------------------------------------------
// Parsing — the STATE's fixed shapes, and nothing else.
// ---------------------------------------------------------------------------

const VERIFIED_RE = new RegExp(`^Verified:[ \\t]*(${SHA})\\b`, "m");
// `dev @ <sha>` at line start, after an optional bullet — the shape of the STATE's dev line. The install
// line's own `dev @ <sha>` is mid-line, so it can never be mistaken for this one.
const DEV_RE = new RegExp(`^[ \\t]*[-*][ \\t]+\\**dev\\**[ \\t]*@[ \\t]*\`?(${SHA})`, "gm");
const INSTALL_LINE_RE = /Running install:/g;
const INSTALL_SHA_RE = new RegExp(`dev[ \\t]*@[ \\t]*\`?(${SHA})`);
// `Open:` as a CLAIM, not as a mention: the write-side vocabulary quotes the field ("the `Open:` list
// against `gh issue list`"), and a backticked field name in prose is not a board claim. Last claim wins,
// the record-fields convention.
const OPEN_RE = /(?<!`)\bOpen:[ \t]*(.+)$/gm;
const SUITE_RE = new RegExp(`\\bSuite:[ \\t]*\\**\\s*(\\d+)[ \\t]+files?[ \\t]*/[ \\t]*\\**\\s*([\\d,]+)`);
// The canonical breakdown suffix — `(N passed, M failed, K skipped)`, immediately after the totals, ASCII
// parentheses, comma+space, in that order (spec v4 §A). `\*{0,2}` tolerates the bold-close `**` of a
// `**3296**` line, the same tolerance SUITE_RE already gives the bold-open, and nothing else: the retired
// prose form `(3295 passed + 1 skipped, **0 failed** — …)` is NOT a claim after this change, so a handoff
// still carrying it is verified by totals only (archived handoffs, `--root <other checkout>`).
const SUITE_BREAKDOWN_RE = /^[ \t]*\*{0,2}[ \t]*\((\d[\d,]*) passed,[ \t]*(\d[\d,]*) failed,[ \t]*(\d[\d,]*) skipped\)/;
// Every occurrence is a claim, so a historical mention must not be one: `18/48 modules import the same
// specifier twice` states a ratio, not a module count, and the `/` before the number is what says so — the
// same exclusions the size regex makes by lookahead.
const MODULES_RE = /(?<![\d/])\b(\d+)[ \t]+modules\b/g;
const ADRS_RE = /(?<![\d/])\b(\d+)[ \t]+ADRs\b/g;
// `` `name.ts` (is) **N** ``, but never a historical shape: `**2,006 → 353**`, `5+/2−`, `(1,429)`
// (a parenthesis breaks the immediate-number rule), or a comparison (`2,249 vs 2,248`, #505). The
// lookahead is what keeps history out of a current-size check. `.ts|.mjs|.sh|.py` because the claim names
// `scripts/` files too — a `.mjs` row the old alternation could not see is a row nothing checked (#583).
// A size claim must CLAIM (#561). Three load-bearing pieces, each measured:
//   - digit-led: `(\d+(?:,\d{3})*)` — a bare comma is not a number (`parseCount(",")` was 0), and an
//     ungrouped integer (`3240`) is still a claim, so grouping is optional but never partial;
//   - indivisible: `(?!\d)(?!,\d)` — no digit and no `,`+digit may follow the token. Without it a
//     terminator lets the token backtrack and `3,240 tests` becomes the claim `3`;
//   - terminated: the number ends the line/section, or is followed by `;` `,` `)` `.` or `lines` — a
//     letter right after it disqualifies it (`2 call sites`, `3,240 tests`).
// Accepted residual (spec §4 R1): a comma or `lines` after a number still claims, so
// `` `a.ts` 3 lines changed `` is read as a size claim — indistinguishable from the legitimate forms.
const SIZE_RE = new RegExp(
	"`((?:[\\w.-]+/)*[\\w.-]+\\.(?:ts|mjs|sh|py))`(?:[ \\t]+is)?[ \\t]*\\*{0,2}(\\d+(?:,\\d{3})*)(?!\\d)(?!,\\d)\\*{0,2}" +
		"(?![\\d,]*[ \\t]*(?:→|->|\\+|/|versus\\b|vs\\b))" +
		"(?=[ \\t]*(?:\\r?\\n|$|[;,).]|lines\\b))",
	"g",
);

/** A number token in the handoff is prose: `2,249` is two thousand two hundred and forty-nine. */
function parseCount(text) {
	return Number(String(text).replace(/,/g, ""));
}

function lastMatch(re, text) {
	let found = null;
	for (const match of text.matchAll(re)) found = match;
	return found;
}

/** Every occurrence of a repeatable claim, in document order — the list a check iterates one by one. */
function allMatches(re, text) {
	return [...text.matchAll(re)].map((match) => match[1]);
}

/**
 * The `Running install:` claim: the line's text, the `<sha>` it states, its path (if any) and its package
 * (if any). A path is an explicit `/…/…`, `~/…/…` or `./…` token — `/reload` is a command, not a path,
 * which is why a token needs a second slash. "this repo" is the checkout the handoff lives in. The
 * `<dev path>` placeholder in the revert recipe names nothing to stat, so it is not a path either.
 */
export function parseInstall(section) {
	const match = lastMatch(INSTALL_LINE_RE, section);
	if (match === null) return null;
	const line = section.slice(match.index).split("\n")[0];
	const shaMatch = INSTALL_SHA_RE.exec(line);
	const packageMatch = /npm:([^\s`]+)/.exec(line);
	let path = null;
	if (/(^|[^\w])this repo\b/.test(line)) {
		path = { kind: "repo" };
	} else {
		for (const token of [...line.matchAll(/`([^`]+)`/g)].map((found) => found[1])) {
			// An absolute token needs a second slash (`/reload` is a command, `/home/x` is a path); `~/` and `./`
			// are paths on their own.
			const slashes = (token.match(/\//g) ?? []).length;
			const pathish = token.startsWith("/") ? slashes >= 2 : /^(?:~\/|\.\/)/.test(token) && slashes >= 1;
			if (pathish && !token.includes("<")) {
				// `~` is expanded here — the module's one ambient read — so `exists()` is handed a path a shell
				// would resolve, instead of reporting a live tree as missing.
				path = { kind: "path", value: token.replace(/^~\//, `${process.env.HOME ?? "~"}/`) };
				break;
			}
		}
	}
	return {
		line,
		sha: shaMatch === null ? null : shaMatch[1],
		path,
		package: packageMatch === null ? null : packageMatch[1],
	};
}

/** The `Open:` issue numbers: `PR #402` is a pull request, not an issue, and is not part of the set. */
export function parseOpen(section) {
	const match = lastMatch(OPEN_RE, section);
	if (match === null) return null;
	const text = match[1].replace(/\bPR[ \t]*#\d+/g, "");
	const numbers = [...text.matchAll(/#(\d+)/g)].map((found) => Number(found[1]));
	return [...new Set(numbers)].sort((left, right) => left - right);
}

/**
 * The `Suite:` claim: the totals always, the breakdown only when the canonical suffix is present. A line
 * with no suffix is a totals-only claim — the shape every archived handoff has — so history keeps
 * verifying; a line with the retired prose form reads the same way, because it is not a claim.
 */
function parseSuite(section, match) {
	const totals = { files: Number(match[1]), tests: parseCount(match[2]) };
	const breakdown = SUITE_BREAKDOWN_RE.exec(section.slice(match.index + match[0].length));
	if (breakdown === null) return totals;
	return {
		...totals,
		passed: parseCount(breakdown[1]),
		failed: parseCount(breakdown[2]),
		skipped: parseCount(breakdown[3]),
	};
}

/**
 * Every mechanical claim §STATE makes, in one pass. An absent claim is `null` — or `[]` for the
 * repeatable ones (`dev`, `modules`, `adrs`, `sizes`), which is a drift too: a mechanical claim that
 * vanished is a claim the next session cannot check. Not an error — the caller decides.
 */
export function parseClaims(text) {
	// The structure is the whole DOCUMENT's, so it is read even when there is no STATE to check (the
	// caller still needs the headings to name a `STATE 0` / a duplicate).
	const structure = scanHeadings(text);
	const section = sectionBody(text, structure.headings);
	if (section === null) {
		return { state: null, verified: null, dev: [], install: null, open: null, suite: null, modules: [], adrs: [], sizes: [], structure };
	}
	// Every claim is read OUTSIDE fenced blocks: a fence inside §STATE is an example, not a claim. Without
	// this the fence-aware boundary above would expose a fenced `Verified:` as the claim (a truncation that
	// was wrong but hid it is not made safe by removing the truncation).
	const masked = maskFences(section);
	const verified = VERIFIED_RE.exec(masked);
	const suiteMatch = SUITE_RE.exec(masked);
	const sizes = [];
	for (const match of masked.matchAll(SIZE_RE)) sizes.push({ name: match[1], lines: parseCount(match[2]) });
	return {
		// The section BODY as written; `state === null` is the caller's "no §STATE" usage fault.
		state: section,
		verified: verified === null ? null : { sha: verified[1] },
		dev: allMatches(DEV_RE, masked),
		install: parseInstall(masked),
		open: parseOpen(masked),
		suite: suiteMatch === null ? null : parseSuite(masked, suiteMatch),
		modules: allMatches(MODULES_RE, masked).map(Number),
		adrs: allMatches(ADRS_RE, masked).map(Number),
		sizes,
		structure,
	};
}

// ---------------------------------------------------------------------------
// Verdict — claims and facts in, named results out. No IO, no exits.
//
// The probe is the seam the caller fills in:
//   headSha() devSha() devClaimSha() · isAncestor(sha) · commitsAfter(sha) -> [{sha, paths}] · exists(path)
//   lineCount(name) -> {path, lines} | null · modules() · adrs() · openIssues() -> number[]
//   report(expectHead) -> the validated snapshot from scripts/lib/suite-report.mjs | null · root
// `expectHead` is the `Verified:` sha of the handoff being checked — the report that proves a suite claim
// is the one captured at the tree the claim describes, so it is passed in rather than guessed at. The
// snapshot is `{path, files, tests, passed, failed, skipped, failedSuites, firstFailure, success, …}`,
// derived once from the assertion results: check 5 compares it and never re-derives anything.
// Every fact is a function so an unanswerable check fails at its own check, with its own message.
// ---------------------------------------------------------------------------

function pass(claim, detail) {
	return { ok: true, skipped: false, claim, line: `✓ ${detail}` };
}

function drift(code, claim, expected, actual, message) {
	return { ok: false, skipped: false, code, claim, expected, actual, line: `✗ ${code}: ${message}` };
}

function skip(claim, reason) {
	return { ok: true, skipped: true, claim, reason, line: `- ${claim} — skipped (${reason})` };
}

const list = (numbers) => numbers.map((number) => `#${number}`).join(", ");

/**
 * The headings a document promises exactly once. The PAGE promises ONE `## STATE` — `## Open items` is
 * optional there — while the index promises its whole H2 set and is checked by `checkIndexStructure`. A
 * parameter rather than a constant per document, because the rule is "these texts, once each" and the
 * texts are the only thing that differs.
 */
const PAGE_MANDATORY_HEADINGS = ["STATE"];

/**
 * Check 0, the structural one — and it reads the DOCUMENT, not §STATE. A second `## STATE` is the
 * slice-replace recurrence: the checker reads the first block, so a stale copy is invisible unless the
 * heading count is what fails. One result per DISTINCT violating heading, in document order of its first
 * occurrence (a heading that is absent altogether sorts last, and the mandatory order breaks that tie):
 *   `STATE`/`Open items` must appear exactly once (`STATE 2`, `Open items 0`);
 *   any other H2 text must not repeat (`Notes 2`).
 * `mandatory` is the set that must appear exactly once (#607: the page's is `STATE` alone — the index
 * pass checks its own set), which keeps #579's alarm — a duplicated block is still `STATE 2` — on the
 * page, where a slice-replace can still append a second copy.
 * The detail names the line numbers, because "a duplicate" without them is a grep the reader re-runs.
 * Uniqueness is NOT freshness (spec §5 R1): one STATE that is the stale copy passes — freshness is
 * `Verified:` plus the claim checks below.
 */
function checkStructure(claims, mandatory) {
	const byText = headingsByText(claims.structure.headings);
	const violations = [];
	for (const text of mandatory) {
		const lines = byText.get(text) ?? [];
		if (lines.length !== 1) violations.push({ text, lines });
	}
	for (const [text, lines] of byText) {
		if (!mandatory.includes(text) && lines.length > 1) violations.push({ text, lines });
	}
	// `sort` is stable, so the absent-heading entries (Infinity) keep the mandatory order.
	violations.sort((left, right) => (left.lines[0] ?? Infinity) - (right.lines[0] ?? Infinity));
	return violations.map(({ text, lines }) => {
		const count = lines.length;
		const claim = `${text} ${count}`;
		const at = count === 0 ? "none" : `${count} at line${count === 1 ? "" : "s"} ${lines.join(", ")}`;
		// The message LEADS with the claim (`✗ state-drift: STATE 2 — …`), so the one-line output names the
		// finding without the reader parsing the prose after it.
		return drift(
			CODES.stateDrift,
			claim,
			`exactly one \`## ${text}\` heading`,
			at,
			count === 0
				? `${claim} — the document has no \`## ${text}\` heading: the handoff contract promises exactly one`
				: `${claim} — \`## ${text}\` appears ${count} times, at lines ${lines.join(", ")}: one copy is the section, the rest are stale blocks`,
		);
	});
}

function short(sha) {
	return String(sha).slice(0, 7);
}

function checkVerified(claims, probe) {
	if (claims.verified === null) {
		return drift(
			CODES.verifiedMissing,
			"Verified: <sha>",
			"a `Verified:` line as the first line of ## STATE",
			"none",
			"the STATE has no `Verified:` line, so §STATE names no tree it describes",
		);
	}
	const { sha } = claims.verified;
	const head = probe.headSha();
	if (!probe.isAncestor(sha)) {
		return drift(
			CODES.verifiedNotAncestor,
			`Verified: ${sha}`,
			`an ancestor of HEAD (${short(head)})`,
			sha,
			`Verified: ${sha} is not an ancestor of HEAD (${short(head)}) — a rebase, an amend or another branch; the extension prints RECONCILE here`,
		);
	}
	const foreign = probe.commitsAfter(sha).filter((commit) => !isHandoffOwnCommit(commit));
	if (foreign.length > 0) {
		const first = foreign[0];
		return drift(
			CODES.verifiedDrift,
			`Verified: ${sha}`,
			`no non-handoff commit on dev after ${sha}`,
			`${foreign.length} such commit(s)`,
			`${short(sha)}..dev has ${foreign.length} commit(s) outside the handoff, first ${short(first.sha)} touching ${first.paths[0] ?? "no path"} — §STATE describes another tree`,
		);
	}
	return pass(`Verified: ${sha}`, `Verified: ${sha} — an ancestor of HEAD; no non-handoff commit on dev after it`);
}

/**
 * A claim stated more than once, appended to the drift sentence: `(the STATE states 58 and 59)`. Without
 * it a disagreeing duplicate would read as a plain mismatch and hide the second line that caused it.
 */
function repeated(values) {
	return values.length < 2 ? "" : ` (the STATE states ${values.join(" and ")})`;
}

/**
 * The dev tip as the two facts checks 2 and 3 need, read ONCE: the ref itself (`devSha`) and the claim
 * resolved from it (`devClaimSha` — the last non-handoff commit, #497). One resolution for both checks, so a
 * `dev @` line and the install line can never be compared against two different tips.
 */
function devTip(probe) {
	return { raw: probe.devSha(), sha: probe.devClaimSha() };
}

/**
 * How a message names the dev tip it compared against. `git rev-parse dev` is a WRONG phrase once a handoff
 * commit sits on top of the merge the claim names — that phrasing was #497's false drift — so the raw ref is
 * only ever named when the two agree.
 */
function devPhrase({ raw, sha }) {
	return raw === sha ? `git rev-parse dev is ${sha}` : `the last non-handoff commit on dev is ${sha}`;
}

/** One result per `dev @ <sha>` line: a duplicate that agrees passes twice, one that disagrees drifts. */
function checkDev(claims, dev) {
	if (claims.dev.length === 0) {
		return [
			drift(
				CODES.devClaimMissing,
				"dev @ <sha>",
				`a dev line naming ${short(dev.sha)}`,
				"none",
				"the STATE has no `dev @ <sha>` line, so the snapshot names no dev tip",
			),
		];
	}
	return claims.dev.map((sha) =>
		sameRevision(sha, dev.sha)
			? pass(`dev @ ${sha}`, `dev @ ${sha} — ${devPhrase(dev)}`)
			: drift(
					CODES.devShaDrift,
					`dev @ ${sha}`,
					dev.sha,
					sha,
					`the STATE claims dev @ ${sha} but ${devPhrase(dev)} — the dev line is a snapshot of another tip${repeated(claims.dev)}`,
				),
	);
}

function checkInstall(claims, probe, dev) {
	if (claims.install === null) {
		return drift(
			CODES.installClaimMissing,
			"Running install: <path>",
			"a `Running install:` line",
			"none",
			"the STATE has no `Running install:` line, so the snapshot names no running install",
		);
	}
	const { install } = claims;
	if (install.path !== null && install.path.kind === "path" && !probe.exists(install.path.value)) {
		return drift(
			CODES.installMissing,
			`Running install: ${install.path.value}`,
			"an existing install path",
			install.path.value,
			`the Running install: path ${install.path.value} does not exist — the install recipe points at a tree that is gone`,
		);
	}
	if (install.sha !== null && !sameRevision(install.sha, dev.sha)) {
		return drift(
			CODES.installShaDrift,
			`Running install: dev @ ${install.sha}`,
			dev.sha,
			install.sha,
			`the Running install: line names dev @ ${install.sha} but ${devPhrase(dev)}`,
		);
	}
	const where =
		install.path === null
			? install.package === null
				? "no path named"
				: `npm:${install.package} (no local path)`
			: install.path.kind === "repo"
				? `this repo (${probe.root})`
				: install.path.value;
	return pass(
		`Running install: ${where}`,
		`Running install: ${where}${install.sha === null ? "" : ` — dev @ ${install.sha}`}`,
	);
}

function checkOpenSet(claims, probe, { noNetwork, injected }) {
	if (claims.open === null) {
		return drift(
			CODES.openClaimMissing,
			"Open: <issues>",
			"an `Open:` line naming the open issues",
			"none",
			"the STATE has no `Open:` line, so the board claim has nowhere to live",
		);
	}
	const claim = `Open: ${list(claims.open)}`;
	if (noNetwork && !injected) return skip(claim, "--no-network: the gh lookup is the only network check");
	const actual = [...new Set(probe.openIssues())].sort((left, right) => left - right);
	const missing = actual.filter((number) => !claims.open.includes(number));
	const extra = claims.open.filter((number) => !actual.includes(number));
	if (missing.length === 0 && extra.length === 0) {
		return pass(claim, `${claim} — ${actual.length} open issue${actual.length === 1 ? "" : "s"} on the board`);
	}
	const reasons = [];
	if (missing.length > 0) reasons.push(`${list(missing)} open and unclaimed`);
	if (extra.length > 0) reasons.push(`${list(extra)} claimed but closed`);
	return drift(
		CODES.openSetDrift,
		claim,
		list(actual),
		list(claims.open),
		`the STATE's ${claim} does not match the board (${list(actual) || "none open"}) — ${reasons.join("; ")}`,
	);
}

/**
 * Check 5. The probe returns the validated snapshot from `scripts/lib/suite-report.mjs`, so every count it
 * needs (`passed`, `failed`, `skipped`, `failedSuites`, `firstFailure`, `success`) is already derived from
 * the assertion results — this function compares, it never re-reads or re-derives.
 *
 * The red predicate is the reason: a report whose results contain a failure, whose FILE failed (a load
 * error writes `success: false`, `numFailedTests: 0` and no failed assertion), or whose own `success` is
 * false cannot certify a green snapshot at ANY total. Only then are the numbers compared, and only then
 * does the claim's optional breakdown get checked — a green report with a wrong breakdown is drift too.
 */
function checkSuite(claims, probe, expectHead = claims.verified === null ? "" : claims.verified.sha) {
	if (claims.suite === null) {
		return drift(
			CODES.suiteClaimMissing,
			"Suite: <n> files / <n> tests",
			"a `Suite:` line with file and test counts",
			"none",
			"the STATE has no `Suite: N files / M tests` line, so the snapshot names no suite",
		);
	}
	const report = probe.report(expectHead);
	if (report === null) {
		// "Cannot check" is never a pass: no report means the count has no evidence this run.
		throw new InputError(
			"no vitest JSON report found — capture one with `node scripts/suite-report.mjs --capture`, or pass --report <path>",
		);
	}
	// The provenance travels with the count (#513): a pass line that names only a path lets a report of
	// another tree, or of a dirty one, read as if it were this tree's.
	const provenance = typeof report.label === "string" && report.label !== "" ? ` (${report.label})` : "";
	const breakdown = `${report.passed} passed, ${report.failed} failed, ${report.skipped} skipped`;
	const expected = `${report.files} file${report.files === 1 ? "" : "s"} / ${report.tests} test${report.tests === 1 ? "" : "s"}`;
	const claim = `Suite: ${claims.suite.files} files / ${claims.suite.tests} tests`;
	// A red run is never evidence of a green snapshot, whatever the totals say. The predicate is THREE
	// terms because vitest has three shapes of red: failed assertions, a failed FILE, and its own verdict
	// (a load error produces no failed assertion at all).
	if (report.failed > 0 || report.failedSuites > 0 || report.success === false) {
		const first = report.firstFailure === "" ? "(none recorded)" : report.firstFailure;
		return drift(
			CODES.suiteRed,
			claim,
			"a green vitest report",
			`${report.failed} failed test(s) in ${report.failedSuites} file(s)`,
			`the vitest report at ${report.path}${provenance} is RED — ${report.failed} failed test(s) in ${report.failedSuites} file(s), first: ${first}; capture a green run`,
		);
	}
	if (report.files === claims.suite.files && report.tests === claims.suite.tests) {
		// The canonical suffix is compared field by field, so a breakdown naming another run is drift even
		// when the totals happen to agree (#583). No suffix → totals only, and no breakdown claim.
		const stated = [
			["passed", claims.suite.passed, report.passed],
			["failed", claims.suite.failed, report.failed],
			["skipped", claims.suite.skipped, report.skipped],
		].filter(([, claimed]) => typeof claimed === "number");
		const disagreed = stated.find(([, claimed, actual]) => claimed !== actual);
		if (disagreed !== undefined) {
			const [field, claimed, actual] = disagreed;
			return drift(
				CODES.suiteCountDrift,
				claim,
				`${expected} (${breakdown})`,
				`${claims.suite.passed} passed, ${claims.suite.failed} failed, ${claims.suite.skipped} skipped`,
				`the STATE's breakdown claims ${field} ${claimed} but the vitest report at ${report.path}${provenance} has ${field} ${actual} — the breakdown names a different run`,
			);
		}
		return pass(claim, `${claim} — the vitest report at ${report.path}${provenance}; ${breakdown}`);
	}
	return drift(
		CODES.suiteCountDrift,
		claim,
		expected,
		`${claims.suite.files} files / ${claims.suite.tests} tests`,
		`the STATE claims ${claims.suite.files} files / ${claims.suite.tests} tests but the vitest report at ${report.path}${provenance} has ${expected}`,
	);
}

/**
 * The shared half of checks 6: each claimed count against the repo's own counter, one named reason each —
 * one result per occurrence, so a repeated claim is checked rather than silently first-wins.
 */
function compareCount(claimed, actual, { label, missingCode, driftCode, source }) {
	if (claimed.length === 0) {
		return [
			drift(
				missingCode,
				`${label}: <n>`,
				`a "${label}" count`,
				"none",
				`the STATE states no ${label} count, so the snapshot names no ${label} total`,
			),
		];
	}
	return claimed.map((value) =>
		value === actual
			? pass(`${value} ${label}`, `${value} ${label} — ${source}`)
			: drift(
					driftCode,
					`${value} ${label}`,
					String(actual),
					String(value),
					`the STATE claims ${value} ${label} but ${source} counts ${actual}${repeated(claimed)}`,
				),
	);
}

function checkModules(claims, probe) {
	return compareCount(claims.modules, probe.modules(), {
		label: "modules",
		missingCode: CODES.modulesMissing,
		driftCode: CODES.modulesDrift,
		source: "docs-arch",
	});
}

function checkAdrs(claims, probe) {
	return compareCount(claims.adrs, probe.adrs(), {
		label: "ADRs",
		missingCode: CODES.adrsMissing,
		driftCode: CODES.adrsDrift,
		source: "docs-decisions",
	});
}

function checkSizes(claims, probe) {
	return claims.sizes.map((size) => {
		const found = probe.lineCount(size.name);
		if (found === null) {
			return drift(
				CODES.fileMissing,
				`${size.name} ${size.lines}`,
				"an existing file",
				`${size.name} not found`,
				`the STATE gives ${size.name} as ${size.lines} lines but there is no such file under src/, scripts/ or the repo root`,
			);
		}
		const claim = `${size.name} ${size.lines}`;
		if (found.lines === size.lines) return pass(claim, `${claim} lines — wc -l ${found.path}`);
		return drift(
			CODES.fileSizeDrift,
			claim,
			`${found.lines} lines`,
			`${size.lines} lines`,
			`the STATE gives ${size.name} as ${size.lines} lines but wc -l ${found.path} is ${found.lines}`,
		);
	});
}

/**
 * Every PAGE check, in a fixed order — structure (one §STATE), then dev, install, open, suite, modules,
 * adrs, and each file-size claim in the order STATE states them. The order is what makes two runs print
 * the same bytes, and structure is first because a document whose §STATE is duplicated has no single
 * subject for the checks after it to disagree with.
 *
 * `Verified:` is NOT here (#607): it lives in the index, so the page pass takes its sha as `expectHead`
 * and hands it to the suite check — the report that proves a page's `Suite:` line is the one captured at
 * the tree the INDEX describes. A page that carried a `Verified:` of its own would be a second source.
 */
export function evaluateStatePage(claims, probe, options = {}) {
	const context = {
		noNetwork: options.noNetwork === true,
		injected: options.issuesInjected === true,
		expectHead: typeof options.expectHead === "string" ? options.expectHead : "",
	};
	// §STATE is the crash-resume point: one copy, or there is no single subject for the checks below.
	const structure = checkStructure(claims, PAGE_MANDATORY_HEADINGS);
	// One resolution for both dev checks: resolving twice would let a `dev @` line and the install line be
	// compared against tips that moved between them (#497).
	const dev = devTip(probe);
	const results = [
		...structure,
		...checkDev(claims, dev),
		checkInstall(claims, probe, dev),
		checkOpenSet(claims, probe, context),
		checkSuite(claims, probe, context.expectHead),
		...checkModules(claims, probe),
		...checkAdrs(claims, probe),
		...checkSizes(claims, probe),
	];
	const drifts = results
		.filter((result) => !result.ok)
		.map(({ code, claim, expected, actual }) => ({ code, claim, expected, actual }));
	return { results, drifts };
}

// ---------------------------------------------------------------------------
// The index (#607) — `.development/HANDOFF.md` is a front page, not a record.
//
// The measurement that produced this: 62% of the old handoff was the `Since the last handover` chain —
// loaded on every resume, at every compaction, and never acted on. Deleting it by hand would regrow, so
// the guarantee is STRUCTURAL: a fixed H2 set, four §STATE lines, a bound on every section, a byte
// budget, no counts in prose, and every citation still true. Each rule has a named code, so the failure
// mode is a red check rather than a judgement call about whether a paragraph is "history".
//
// What is deliberately NOT here: the mechanical claims. `dev @`, `Open:`, `Suite:`, modules, ADRs and
// file sizes live in `.development/handoff/state.md` and are read by `parseClaims` — unchanged — through
// `evaluateStatePage`. The index holds no count, which is why the injected snapshot cannot go stale the
// way a suite total does.
//
// ACCEPTED RESIDUAL (spec §1, stated broadly): bounded lines can still carry prose, including
// count-bearing narrative that avoids the unit list. The mechanical guarantee is smallness with a named
// shape, not a proof that no sentence can be smuggled in — the falsifier is the measured receipt (a fresh
// session reaches the next action in a command or two), not an impossible proof.
// ---------------------------------------------------------------------------

/** The index's H2 headings, in the order the contract states them. A set, not a prefix: all four, once. */
export const INDEX_HEADINGS = Object.freeze(["STATE", "Invariants", "Pointers", "Resume protocol"]);

/**
 * The index's limits. `lines`/`bytes` are the per-session tax (spec D10: the index only); the rest bound
 * a SECTION, so a section cannot grow into the place history used to live.
 */
export const INDEX_LIMITS = Object.freeze({
	lines: 80,
	bytes: 8192,
	lineChars: 160,
	preamble: 2,
	invariants: 8,
	pointers: 12,
	resume: 3,
});

/** `### text` — a sub-section. The index has none: a sub-section is where narrative grows back. */
const H3_RE = /^###[ \t]+(\S.*)$/;
/** `](#target)` — the markdown link a `## Pointers` row uses. A space cannot appear unescaped in one. */
const LINK_RE = /\[[^\]]*\]\(([^)\s]+)\)/g;
/** A link into the page directory, relative to the index (`.development/`): `handoff/state.md`. */
const PAGE_LINK_RE = /^(?:\.\/)?handoff\/([\w.-]+\.md)$/;
/** A scheme, a protocol-relative URL or a fragment — not a filesystem path, so there is nothing to stat. */
const EXTERNAL_LINK_RE = /^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/i;
/** `#607 (open)` — a citation states the issue's state, which is what makes it checkable. */
const CITATION_RE = /#(\d+)[ \t]*\(([A-Za-z]+)\)/g;
const CITED_STATES = Object.freeze(["open", "closed", "merged"]);
/** A sha citation is BACKTICKED, so prose hex (`deadbeef` in a sentence) is not one. */
const BACKTICK_SHA_RE = /`([0-9a-f]{7,40})`/g;
/**
 * The units the index may never carry a bare count for (spec D9) — the handoff's own vocabulary. A
 * blockquote is NOT skipped: `> Suite: 150 files` is still a count in the file the session loads.
 */
const COUNT_UNIT_RE =
	/(?<![\w#.,/-])\d[\d,]*(?!\d)[ \t]*(?:files?|tests?|lines?|modules?|ADRs?|issues?|commands?|dispatches?|spawns?)\b/g;

/** The four §STATE fields, in order. `Verified:` carries a sha; the other three carry text. */
const STATE_FIELD_RES = Object.freeze([
	{ name: "Verified", re: new RegExp(`^Verified:[ \\t]*(${SHA})\\b`) },
	{ name: "In flight", re: /^In flight:[ \t]*(.+)$/ },
	{ name: "Next action", re: /^Next action:[ \t]*(.+)$/ },
	{ name: "Index", re: /^Index:[ \t]*(.+)$/ },
]);

/** Every `### text` heading, outside fenced code blocks — the same fence rule as `scanHeadings`. */
function scanH3(text) {
	const found = [];
	for (const { index, line, fenced } of fenceLines(text)) {
		if (fenced) continue;
		const match = H3_RE.exec(line);
		if (match !== null) found.push({ text: match[1].trimEnd(), line: index + 1 });
	}
	return found;
}

/**
 * A section's body span: the heading line's own 0-based index through the line before the NEXT heading of
 * any level. H3 counts as a boundary, so a section cannot end "at the next H2" and quietly swallow a
 * sub-section — the same mistake `stateSection` was fixed for (#579).
 */
function bodySpan(lines, boundaries, name) {
	const heading = boundaries.find((entry) => entry.level === 2 && entry.text === name);
	if (heading === undefined) return null;
	const next = boundaries.find((entry) => entry.line > heading.line);
	return { from: heading.line, to: next === undefined ? lines.length : next.line - 1 };
}

/** The line numbers a physical-line count sees — `wc -l` semantics, so the budget is the reader's line. */
function physicalLines(lines) {
	return lines.length > 0 && lines[lines.length - 1] === "" ? lines.length - 1 : lines.length;
}

/** A body span as `{line, number}` entries, so every finding names the line the reader must open. */
function numberedLines(lines, spanOf) {
	if (spanOf === null) return [];
	const out = [];
	for (let index = spanOf.from; index < spanOf.to && index < lines.length; index += 1) {
		out.push({ line: lines[index], number: index + 1 });
	}
	return out;
}

/**
 * The index as the checks need it: headings (H2 and H3), the four §STATE lines, the bounded sections,
 * the `## Pointers` links, and the citations the liveness check resolves. Pure parsing — no fact is
 * fetched here, so a fixture can pin the grammar without a repo.
 */
export function parseIndex(text) {
	const raw = String(text);
	const lines = raw.split("\n").map(withoutCr);
	const structure = scanHeadings(raw);
	const h3 = scanH3(raw);
	const boundaries = [
		...structure.headings.map((heading) => ({ ...heading, level: 2 })),
		...h3.map((heading) => ({ ...heading, level: 3 })),
	].sort((left, right) => left.line - right.line);
	const numbered = (name) => numberedLines(lines, bodySpan(lines, boundaries, name));
	const stateLines = numbered("STATE").filter((entry) => entry.line.trim() !== "");
	const verifiedField = stateLines.length > 0 ? STATE_FIELD_RES[0].re.exec(stateLines[0].line) : null;
	const firstH2 = structure.headings.length === 0 ? lines.length : structure.headings[0].line - 1;
	const pointerRows = numbered("Pointers").filter((entry) => /^\|/.test(entry.line));
	const pointerLinks = [];
	for (const row of pointerRows) {
		for (const match of row.line.matchAll(LINK_RE)) {
			const target = match[1];
			const page = PAGE_LINK_RE.exec(target);
			pointerLinks.push({
				line: row.number,
				target,
				page: page === null ? null : page[1],
				external: EXTERNAL_LINK_RE.test(target),
			});
		}
	}
	// The citations are read over the WHOLE document, outside fences: a link in the preamble or a number in
	// the resume protocol is as much a claim as one in §STATE.
	const citations = [];
	const shas = [];
	const counts = [];
	const nextActions = [];
	for (const { index, line, fenced } of fenceLines(raw)) {
		if (fenced) continue;
		const number = index + 1;
		if (/^[ \t]*Next action:/.test(line)) nextActions.push({ line: line.trim(), number });
		for (const match of line.matchAll(CITATION_RE)) {
			const state = match[2].toLowerCase();
			if (CITED_STATES.includes(state)) citations.push({ number: Number(match[1]), state, line: number });
		}
		// `Verified:` is the index's own head — an ancestor check on it is check 1's job, not a citation.
		if (!/^[ \t]*Verified:/.test(line)) {
			for (const match of line.matchAll(BACKTICK_SHA_RE)) shas.push({ sha: match[1], line: number });
		}
		for (const match of line.matchAll(COUNT_UNIT_RE)) counts.push({ text: match[0], line: number });
	}
	return {
		text: raw,
		lines,
		lineCount: physicalLines(lines),
		bytes: new TextEncoder().encode(raw).length,
		structure,
		h3,
		stateLines,
		verified: verifiedField === null ? null : { sha: verifiedField[1] },
		preamble: lines.slice(0, firstH2).filter((line) => line.trimStart().startsWith(">")),
		invariants: numbered("Invariants").filter((entry) => /^- /.test(entry.line)),
		pointers: pointerRows,
		pointerLinks,
		resume: numbered("Resume protocol").filter((entry) => entry.line.trim() !== ""),
		nextActions,
		citations,
		shas,
		counts,
	};
}

/**
 * Check 0a — the H2 set and the absence of H3s (`state-drift`). Both are the same failure: the document
 * grew a section, or grew a sub-section inside one, which is where history reappears.
 */
function checkIndexStructure(index) {
	const results = [];
	const present = index.structure.headings.map((heading) => heading.text);
	const missing = INDEX_HEADINGS.filter((text) => !present.includes(text));
	const extra = present.filter((text) => !INDEX_HEADINGS.includes(text));
	const repeated = index.structure.duplicates.map((entry) => entry.text);
	if (missing.length > 0 || extra.length > 0 || repeated.length > 0) {
		const reasons = [];
		if (missing.length > 0) reasons.push(`missing ${missing.map((text) => `## ${text}`).join(", ")}`);
		if (extra.length > 0) reasons.push(`extra ${extra.map((text) => `## ${text}`).join(", ")}`);
		if (repeated.length > 0) reasons.push(`${repeated.map((text) => `## ${text}`).join(", ")} repeated`);
		results.push(
			drift(
				CODES.stateDrift,
				`H2 ${present.join(" · ") || "(none)"}`,
				`exactly ${INDEX_HEADINGS.map((text) => `## ${text}`).join(" · ")}`,
				`${present.length} heading(s)`,
				`${present.length === 0 ? "no H2 heading" : `H2 ${present.join(" · ")}`} — the H2 set is not the contract's (${reasons.join("; ")}); a section the contract does not name is where history grows back`,
			),
		);
	}
	if (index.h3.length > 0) {
		const at = index.h3.map((heading) => `line ${heading.line} (${heading.text})`);
		results.push(
			drift(
				CODES.stateDrift,
				`H3 ${index.h3.length}`,
				"no `### ` heading",
				at.join(", "),
				`H3 ${index.h3.length} — a level-3 heading at ${at.join(", ")}: a sub-section is a page's job, not the index's`,
			),
		);
	}
	return results;
}

/**
 * Check 0b — the four §STATE lines, in order, and a bound on every line (`state-shape`). The four fields
 * are what makes the injection self-sufficient: a session that sees only §STATE knows the tree, what is
 * running, what is next, and where the pages are.
 */
function checkIndexShape(index) {
	const results = [];
	const fields = index.stateLines;
	if (fields.length !== 4) {
		const names = STATE_FIELD_RES.map((field) => field.name).join(" · ");
		results.push(
			drift(
				CODES.stateShape,
				`STATE ${fields.length}`,
				`exactly ${names}`,
				`${fields.length} non-blank line(s)`,
				`STATE ${fields.length} — §STATE has ${fields.length} non-blank line(s) and the contract is exactly the four lines ${names}, in that order; a snapshot that grew a paragraph is the shape #607 replaces`,
			),
		);
	} else {
		for (const [at, field] of STATE_FIELD_RES.entries()) {
			if (field.re.test(fields[at].line)) continue;
			results.push(
				drift(
					CODES.stateShape,
					`STATE line ${fields[at].number}`,
					`the \`${field.name}:\` line`,
					fields[at].line.slice(0, 80),
					`STATE line ${fields[at].number} — not the \`${field.name}:\` line; the four fields are ordered, so a missing or reordered one is drift at the line that holds it`,
				),
			);
		}
	}
	for (const [at, line] of index.lines.entries()) {
		if (line.length <= INDEX_LIMITS.lineChars) continue;
		results.push(
			drift(
				CODES.stateShape,
				`line ${at + 1}`,
				`at most ${INDEX_LIMITS.lineChars} characters`,
				`${line.length} characters`,
				`line ${at + 1} — ${line.length} characters, over the bound of ${INDEX_LIMITS.lineChars}; a bounded line is the mechanical half of "no history", so split it or move it to a page`,
			),
		);
	}
	return results;
}

/** Check 0c — a section that outgrew its bound (`section-over-bound`). Preamble, Invariants, Pointers, Resume. */
function checkIndexBounds(index) {
	const bounds = [
		{ section: "the preamble", count: index.preamble.length, limit: INDEX_LIMITS.preamble, unit: "`>` line" },
		{ section: "## Invariants", count: index.invariants.length, limit: INDEX_LIMITS.invariants, unit: "`- ` bullet" },
		{ section: "## Pointers", count: index.pointers.length, limit: INDEX_LIMITS.pointers, unit: "`|` row" },
		{ section: "## Resume protocol", count: index.resume.length, limit: INDEX_LIMITS.resume, unit: "command line" },
	];
	const results = [];
	for (const bound of bounds) {
		if (bound.count <= bound.limit) continue;
		results.push(
			drift(
				CODES.sectionOverBound,
				`${bound.section} ${bound.count}`,
				`at most ${bound.limit} ${bound.unit}(s)`,
				`${bound.count}`,
				`${bound.section} ${bound.count} — one over the bound of ${bound.limit} ${bound.unit}(s); a section with room to grow is a section that grows`,
			),
		);
	}
	return results;
}

/** Check 2 — the per-session budget (`over-budget`). Lines and UTF-8 bytes: the reader pays both. */
function checkIndexBudget(index) {
	const over = [];
	if (index.lineCount > INDEX_LIMITS.lines) over.push(`${index.lineCount} lines (limit ${INDEX_LIMITS.lines})`);
	if (index.bytes > INDEX_LIMITS.bytes) over.push(`${index.bytes} bytes (limit ${INDEX_LIMITS.bytes})`);
	if (over.length === 0) {
		return pass(
			`Index ${index.lineCount} lines / ${index.bytes} bytes`,
			`Index ${index.lineCount} lines / ${index.bytes} bytes — inside the ${INDEX_LIMITS.lines}-line / ${INDEX_LIMITS.bytes}-byte budget`,
		);
	}
	return drift(
		CODES.overBudget,
		`Index ${index.lineCount} lines / ${index.bytes} bytes`,
		`at most ${INDEX_LIMITS.lines} lines and ${INDEX_LIMITS.bytes} bytes`,
		over.join(" and "),
		`Index ${over.join(" and ")} — injected into every session, so its size is the one cost that recurs`,
	);
}

/**
 * Check 3 — every page is indexed and every indexed page exists (`unindexed-page` / `dead-link`). The set
 * is the `handoff/*.md` directory the index's own directory holds, so a page cannot be added and forgotten
 * — the failure mode a hand-maintained link list would have.
 */
function checkIndexCompleteness(index, probe) {
	const pages = [...probe.pages()].sort();
	const linked = new Set(index.pointerLinks.filter((link) => link.page !== null).map((link) => link.page));
	const results = [];
	for (const page of pages) {
		if (linked.has(page)) continue;
		results.push(
			drift(
				CODES.unindexedPage,
				`handoff/${page}`,
				"a `## Pointers` row linking it",
				"not linked",
				`handoff/${page} — the page exists but no \`## Pointers\` row links it: a page nobody can find is a page nobody opens`,
			),
		);
	}
	const known = new Set(pages);
	for (const link of index.pointerLinks) {
		if (link.page === null || known.has(link.page)) continue;
		results.push(
			drift(
				CODES.deadLink,
				`handoff/${link.page}`,
				"an existing page",
				`missing (line ${link.line})`,
				`handoff/${link.page} — line ${link.line} links it and no such page exists; a dead pointer is worse than no pointer, because it reads as a page that was written`,
			),
		);
	}
	if (results.length === 0) {
		results.push(pass(`handoff/ ${pages.length} page(s)`, `handoff/ — ${pages.length} page(s), every one linked and present`));
	}
	return results;
}

/**
 * Check 4 — citations are still true. Three kinds, three scopes (spec D4/D5):
 *   - `#<n> (open|closed|merged)` anywhere outside a fence, against `gh issue view <n>`;
 *   - a backticked sha, against `dev` (the branch the index describes), excluding `Verified:`;
 *   - a `## Pointers` LINK TARGET, against the filesystem. Prose backticks, globs and gitignored paths are
 *     never stat'ed: `handoff/state.md` in a sentence is an illustration, a link is a promise.
 * Page links are the completeness check's (they are a set relation); every other pointer target is here.
 */
function checkIndexLiveness(index, probe, context) {
	const results = [];
	if (index.citations.length > 0) {
		if (context.noNetwork && !context.injected) {
			const claimed = index.citations.map((citation) => `#${citation.number} (${citation.state})`).join(", ");
			results.push(skip(claimed, "--no-network: the gh lookup is the only network check"));
		} else {
			const board = context.injected ? probe.openIssues() : null;
			for (const citation of index.citations) {
				const claim = `#${citation.number} (${citation.state})`;
				let actual;
				if (context.injected) {
					// The injected list is `gh issue list --state open`: it can answer "open" and "not open", and
					// nothing else. A `(closed|merged)` claim against it is unanswerable — exit 2, never a guess.
					if (citation.state !== "open") {
						throw new InputError(
							`${claim} at line ${citation.line}: --issues injects the OPEN set only, so a ${citation.state} claim cannot be checked — drop --issues to answer it from gh`,
						);
					}
					actual = board.includes(citation.number) ? "open" : "closed";
				} else {
					actual = probe.issueState(citation.number);
				}
				results.push(
					actual === citation.state
						? pass(claim, `${claim} — the issue is ${actual} on the board`)
						: drift(
								CODES.issueStateDrift,
								claim,
								actual,
								citation.state,
								`${claim} — line ${citation.line} says so but the issue is ${actual}; a citation is a claim about the board, so a wrong one drifts`,
							),
				);
			}
		}
	}
	for (const cited of index.shas) {
		if (probe.isAncestorOfDev(cited.sha)) {
			results.push(pass(`\`${cited.sha}\``, `\`${cited.sha}\` — on dev`));
			continue;
		}
		results.push(
			drift(
				CODES.shaNotAncestor,
				`\`${cited.sha}\``,
				"a commit on dev",
				`not on dev (line ${cited.line})`,
				`\`${cited.sha}\` — line ${cited.line} cites it and it is not an ancestor of dev; a citation of a commit the branch never had is a claim from another tree`,
			),
		);
	}
	for (const link of index.pointerLinks) {
		if (link.page !== null || link.external) continue;
		if (probe.pointerExists(link.target)) {
			results.push(pass(link.target, `${link.target} — exists`));
			continue;
		}
		results.push(
			drift(
				CODES.pathMissing,
				link.target,
				"an existing path",
				`missing (line ${link.line})`,
				`${link.target} — line ${link.line} points at it and it does not exist; a pointer's whole job is to be openable`,
			),
		);
	}
	return results;
}

/** Check 5 — no count in the index's prose (`unattributed-count`). A count belongs in the page. */
function checkIndexCounts(index) {
	const results = index.counts.map((count) =>
		drift(
			CODES.unattributedCount,
			`line ${count.line}`,
			"no count in the index's prose",
			count.text,
			`line ${count.line} — states "${count.text}"; the index carries no count, so a count lives in handoff/state.md, where \`handoff-verify\` recomputes it`,
		),
	);
	if (results.length === 0) results.push(pass("no counts", "no count in the index's prose — every count lives in the page"));
	return results;
}

/**
 * Check 6 — exactly ONE next action, naming an issue, in the state `(open)` (`next-action-ambiguous` /
 * `next-action-issue-missing` / `next-action-state-missing`). A next action is open by definition, so a
 * closed one is drift either way: the field is wrong, or the citation is (check 4 compares it to gh).
 */
function checkNextAction(index) {
	const actions = index.nextActions;
	if (actions.length !== 1) {
		const where = actions.map((action) => `line ${action.number}`).join(", ") || "none";
		return [
			drift(
				CODES.nextActionAmbiguous,
				`Next action: ${actions.length}`,
				"exactly one `Next action:` line",
				where,
				`Next action: ${actions.length} — the index states ${actions.length} such line(s) (${where}); one work item is the contract and a queue belongs in the board`,
			),
		];
	}
	const [action] = actions;
	const issue = /#(\d+)/.exec(action.line);
	if (issue === null) {
		return [
			drift(
				CODES.nextActionIssueMissing,
				action.line.slice(0, 80),
				"`Next action: #<n> …`",
				"no issue number",
				`line ${action.number} states a next action with no \`#<n>\` — an action nobody can open is an action nobody can start`,
			),
		];
	}
	const state = new RegExp(`#${issue[1]}[ \\t]*\\(([A-Za-z]+)\\)`).exec(action.line);
	const actual = state === null ? "no state" : state[1].toLowerCase();
	if (actual !== "open") {
		return [
			drift(
				CODES.nextActionStateMissing,
				`#${issue[1]} (${actual})`,
				`#${issue[1]} (open)`,
				actual,
				`${issue[1] ? `#${issue[1]} (${actual})` : actual} — line ${action.number} states ${actual === "no state" ? "no state" : `(${actual})`}; a next action is by definition open, and (4) then checks the label against gh`,
			),
		];
	}
	return [pass(`Next action: #${issue[1]} (open)`, `Next action: #${issue[1]} (open) — one action, open, and the citation is resolved by (4)`)];
}

/**
 * The index pass, in the spec's fixed order: structure/shape, verified, budget, completeness, liveness,
 * counts, next action. `Verified:` is checked here (and only here) because the index owns it: the page
 * takes its sha as the head the suite report must match.
 */
export function evaluateIndex(index, probe, options = {}) {
	const context = { noNetwork: options.noNetwork === true, injected: options.issuesInjected === true };
	const shape = [...checkIndexStructure(index), ...checkIndexShape(index), ...checkIndexBounds(index)];
	const results = [
		...shape,
		checkVerified({ verified: index.verified }, probe),
		checkIndexBudget(index),
		...checkIndexCompleteness(index, probe),
		...checkIndexLiveness(index, probe, context),
		...checkIndexCounts(index),
		...checkNextAction(index),
	];
	const drifts = results
		.filter((result) => !result.ok)
		.map(({ code, claim, expected, actual }) => ({ code, claim, expected, actual }));
	return { results, drifts };
}

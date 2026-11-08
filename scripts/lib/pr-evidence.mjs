// Purpose: The PR body's evidence block — parse, compare against measured facts, render — pure, so the
// verdict is testable without a repo, a network or a subprocess (issue #488).
//
// The problem this replaces: three PR bodies in one cycle carried counts that did not match the tree
// (S5's "landed at 338" for a file at 353, S6's "44 seam tests" for 84, a "stays at 24" that was new
// code). #488 asked for `value ← command`; that still permits a stale paste, because the command is
// text and nothing proves it was re-run. So the numbers are GENERATED (`pr-evidence --emit`) and
// CHECKED by recomputation (`--check`): the block is the only place a count may live, and every count
// line carries the canonical command as documentation for a human.
//
// HARD RULE, and the reason this file is pure: **nothing read from a PR body is ever executed.** A
// body is untrusted input — it can be written by anyone with a fork — so the text after `←` is inert
// documentation here. There is no fs, no subprocess and no eval in this module; the CLI
// (`scripts/pr-evidence.mjs`) is the only place a process is started, and its argv is built from
// fixed strings plus a validated PR number, never from body text.
//
// THE BLOCK — five keys, in this order, exactly:
//
//   <!-- pr-evidence:begin -->
//   head: <sha>                                  ← git rev-parse HEAD
//   changed-files: <n>                           ← git diff --name-only <base>...<head> | wc -l
//   src-diff-lines: <n>                          ← git diff --numstat <base>...<head> -- src | awk …
//   suite: <N> files / <M> tests                 ← npx vitest run --reporter=json … (testResults / numPassedTests)
//   budget: src <r> · scripts <r>                ← node scripts/check-test-budget.mjs --report …
//   <!-- pr-evidence:end -->
//
// The four count lines MUST carry `← <command>` (#488's rule). `head:` may omit the arrow — the spec's
// own block shape has no command there, and a sha is not a count. Emit writes the arrow on all five.
//
// A count OUTSIDE the block drifts as `unattributed-count` (`N files`, `N tests`, `N lines`,
// case-insensitive) — except inside a fenced code block or a blockquote, where quoting an old value is
// legitimate. One finding per offending line, carrying the line's number and text.
//
// NO BLOCK IS NOT ALWAYS A FAULT. A docs PR with no counts has nothing to attribute and passes; a body
// that states a count with no block is exit 2 (`missing-block`) — "a block is required" is exactly the
// case where a number is present and unattributable. The two are told apart by the ban list, not by a
// flag.
//
// WHAT IS NOT MECHANICAL, said out loud so no one thinks the tool covers it: a count with no unit noun
// (`landed at 338`), and any number that is not one of the five keys (a cyclomatic complexity, a
// per-file line count). The ban list matches a COUNT + UNIT, so it cannot see "338" alone; inventing a
// check that guessed would fail closed on legitimate prose. See `SCOPE`.
//
// Drift codes (one per failure mode; the fixtures pin them):
//   missing-block · multiple-blocks · missing-key · missing-command
//   stale-head · stale-changed-files · stale-src-diff · stale-suite · stale-budget
//   unattributed-count
import { InputError } from "./handoff-claims.mjs";

/** The block's delimiters, byte-for-byte what `--emit` writes and `--check` looks for. */
export const BLOCK = Object.freeze({
	begin: "<!-- pr-evidence:begin -->",
	end: "<!-- pr-evidence:end -->",
});

/** The arrow that separates a count from the command that produces it. Documentation, never executed. */
export const ARROW = "←";

/** The block's keys, in the order they are written and checked. */
export const KEYS = Object.freeze(["head", "changed-files", "src-diff-lines", "suite", "budget"]);

/** The keys that carry a COUNT — every one of them must name its command (#488). */
export const COUNT_KEYS = Object.freeze(["changed-files", "src-diff-lines", "suite", "budget"]);

/** Exit codes, named so the docs, the fixtures and the CLI cannot disagree. */
export const EXIT = Object.freeze({ OK: 0, DRIFT: 1, USAGE: 2 });

/**
 * The claims this tool refuses to check, printed with every verdict: a scope nobody states is a scope
 * the reader fills in with their own guess.
 */
export const SCOPE =
	"out of scope by design: a count with no unit noun (`landed at 338`) and any number outside the block's five keys (a complexity, a per-file line count) are not mechanical";

export const CODES = Object.freeze({
	missingBlock: "missing-block",
	multipleBlocks: "multiple-blocks",
	missingKey: "missing-key",
	missingCommand: "missing-command",
	staleHead: "stale-head",
	staleChangedFiles: "stale-changed-files",
	staleSrcDiff: "stale-src-diff",
	staleSuite: "stale-suite",
	staleBudget: "stale-budget",
	unattributedCount: "unattributed-count",
});

/** The shape each key must have in the block — used in a `missing-key` reason so the fix is spelled. */
export const SHAPE = Object.freeze({
	head: "head: <sha>",
	"changed-files": "changed-files: <n>",
	"src-diff-lines": "src-diff-lines: <n>",
	suite: "suite: <N> files / <M> tests",
	budget: "budget: src <r> · scripts <r>",
});

// The value half of each key line: everything before the arrow. Anchored, so prose that merely contains
// a colon cannot be read as a key. `budget`'s separator is the middle dot emit writes.
const FIELDS = Object.freeze({
	head: /^head:[ \t]*([0-9a-f]{7,40})\b/i,
	"changed-files": /^changed-files:[ \t]*([\d,]+)\b/,
	"src-diff-lines": /^src-diff-lines:[ \t]*([\d,]+)\b/,
	suite: /^suite:[ \t]*([\d,]+)[ \t]+files?[ \t]*\/[ \t]*([\d,]+)[ \t]+tests?\b/i,
	budget: /^budget:[ \t]*src[ \t]+([\d.]+)[ \t]*·[ \t]*scripts[ \t]+([\d.]+)/i,
});

/**
 * A count outside the block: a number, up to two intervening words, then one of the units a gate counts.
 *
 * The spec's regex is `\b\d[\d,]*\s+(files?|tests?|lines?)\b`, which cannot see S6's own claim —
 * "44 seam tests" puts an adjective between the number and the unit. A ban list that misses the very
 * claim it was written for is a rule about spelling, not about counts, so the gap allows up to two
 * words (`44 seam tests`, `5 passing lines`). The lookbehind keeps `2.0` from matching as `0`.
 */
const COUNT_RE = /(?<![\w.])[\d][\d,]*[ \t]+(?:[\w'-]+[ \t]+){0,2}(?:files?|tests?|lines?)\b/gi;

const FENCE_RE = /^(```|~~~)/;

/** A number token in a body is prose: `1,024` is one thousand and twenty-four. */
function parseCount(text) {
	return Number(String(text).replace(/,/g, ""));
}

/**
 * A ratio as the block states it: measured numbers are formatted to 2 dp exactly like
 * `check-test-budget.mjs` formats them, so the tool and the guard can never print two spellings of one
 * measurement. A string is already the block's text and passes through untouched.
 */
export function formatRatio(value) {
	return typeof value === "number" ? value.toFixed(2) : String(value);
}

// ---------------------------------------------------------------------------
// Blocks — where they are, and what they say.
// ---------------------------------------------------------------------------

/**
 * Every block in the body: `ranges` of `{ begin, end }` line indices (inclusive), and `unclosed` — the
 * index of a `begin` marker with no `end`, or -1. A marker is matched as a whole line after trimming,
 * wherever it appears: a body that quotes the block inside a fence is quoting a block, and the fix is
 * to not do that rather than to make the scanner guess.
 */
export function scanBlocks(lines) {
	const ranges = [];
	let begin = -1;
	for (let index = 0; index < lines.length; index += 1) {
		const trimmed = lines[index].trim();
		if (trimmed === BLOCK.begin) {
			if (begin === -1) begin = index;
		} else if (trimmed === BLOCK.end && begin !== -1) {
			ranges.push({ begin, end: index });
			begin = -1;
		}
	}
	return { ranges, unclosed: begin };
}

/**
 * One block's claims: `values` (a key absent from `values` is a missing claim), `commands` (`""` when
 * the line carries no arrow) and `lineOf` (1-based body line, for a reason a human can find).
 *
 * Last line wins for a repeated key — the record-fields convention, so a rewrite that adds a line
 * instead of replacing one still has one authoritative value per key.
 */
export function parseBlock(lines, range) {
	const values = {};
	const commands = {};
	const lineOf = {};
	for (let index = range.begin + 1; index < range.end; index += 1) {
		const raw = lines[index];
		const text = raw.replace(/[ \t]+$/, "");
		const arrowAt = text.indexOf(ARROW);
		const claim = arrowAt === -1 ? text : text.slice(0, arrowAt);
		const command = arrowAt === -1 ? "" : text.slice(arrowAt + ARROW.length).trim();
		for (const key of KEYS) {
			const match = FIELDS[key].exec(claim);
			if (match === null) continue;
			values[key] =
				key === "suite"
					? { files: parseCount(match[1]), tests: parseCount(match[2]) }
					: key === "budget"
						? { src: match[1], scripts: match[2] }
						: key === "head"
							? match[1].toLowerCase()
							: parseCount(match[1]);
			commands[key] = command;
			lineOf[key] = index + 1;
			break;
		}
	}
	return { values, commands, lineOf };
}

/** The block text for measured `evidence`, one line per key plus the delimiters. */
export function renderBlock(evidence, { base = "dev", headRef = "HEAD" } = {}) {
	const head = String(evidence.head);
	const scope = `${base}...${head}`;
	return [
		BLOCK.begin,
		`head: ${head} ${ARROW} git rev-parse ${headRef}`,
		`changed-files: ${evidence.changedFiles} ${ARROW} git diff --name-only ${scope} | wc -l`,
		`src-diff-lines: ${evidence.srcDiffLines} ${ARROW} git diff --numstat ${scope} -- src | awk '{s+=$1+$2} END {print s+0}'`,
		`suite: ${evidence.suite.files} files / ${evidence.suite.tests} tests ${ARROW} npx vitest run --reporter=json --outputFile=vitest-report.json (testResults / numPassedTests)`,
		`budget: src ${formatRatio(evidence.budget.src)} · scripts ${formatRatio(evidence.budget.scripts)} ${ARROW} node scripts/check-test-budget.mjs --report vitest-report.json`,
		BLOCK.end,
	].join("\n");
}

/**
 * `body` with its block replaced by `block` — or `block` appended when there is none. Every further
 * block is removed: `--apply` produces the one-block shape `--check` requires, so a second run is a
 * no-op on the body's shape (and byte-identical, which is what makes the rewrite safe to repeat).
 */
export function upsertBlock(body, block) {
	const lines = String(body).split("\n");
	const { ranges } = scanBlocks(lines);
	const blockLines = block.split("\n");
	const skip = new Set();
	for (const range of ranges) for (let index = range.begin; index <= range.end; index += 1) skip.add(index);
	const out = [];
	let inserted = false;
	for (let index = 0; index < lines.length; index += 1) {
		if (!skip.has(index)) {
			out.push(lines[index]);
			continue;
		}
		if (!inserted) {
			out.push(...blockLines);
			inserted = true;
		}
	}
	while (out.length > 0 && out[out.length - 1].trim() === "") out.pop();
	if (!inserted) out.push(...(out.length === 0 ? [] : [""]), ...blockLines);
	return `${out.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// The ban list — a count outside the block is a count nobody can recompute.
// ---------------------------------------------------------------------------

/**
 * Every line outside the block that states a count, skipping fenced code blocks (` ``` ` / `~~~`,
 * marker lines included) and blockquotes (a quoted old value is legitimate). One finding per line,
 * carrying the line number, the line's text and the token that tripped it.
 */
export function unattributedCounts(lines, ranges) {
	const inside = new Set();
	for (const range of ranges) for (let index = range.begin; index <= range.end; index += 1) inside.add(index);
	const findings = [];
	let fence = "";
	for (let index = 0; index < lines.length; index += 1) {
		const line = lines[index];
		const trimmed = line.trim();
		const marker = FENCE_RE.exec(trimmed);
		if (fence !== "") {
			if (marker !== null && marker[1] === fence) fence = "";
			continue;
		}
		if (marker !== null) {
			fence = marker[1];
			continue;
		}
		if (inside.has(index) || trimmed.startsWith(">")) continue;
		const matches = line.match(COUNT_RE);
		if (matches === null) continue;
		findings.push({
			code: CODES.unattributedCount,
			line: index + 1,
			text: trimmed,
			detail: `states "${matches[0]}" outside the block — a count belongs in the pr-evidence block, where --check recomputes it (#488)`,
		});
	}
	return findings;
}

// ---------------------------------------------------------------------------
// The verdict — recomputed facts in, named findings out.
// ---------------------------------------------------------------------------

/**
 * One finding per mismatched key, comparing `block` (as parsed) against `actual` (as measured). The
 * order is the block's own key order, so two runs over one body print the same lines.
 *
 * `actual` is the CLI's probe output: `{ head, changedFiles, srcDiffLines, suite: { files, tests },
 * budget: { src, scripts } }`, where the budget ratios may be numbers (measured) or strings (already
 * formatted). A head is compared prefix-tolerantly, exactly like the handoff's `Verified:` — a short sha
 * names one commit.
 */
export function compare(block, actual) {
	const findings = [];
	for (const key of KEYS) {
		const value = block.values[key];
		if (value === undefined) {
			findings.push({
				code: CODES.missingKey,
				detail: `the block has no "${key}:" line — expected \`${SHAPE[key]}\``,
			});
			continue;
		}
		if (COUNT_KEYS.includes(key) && block.commands[key] === "") {
			findings.push({
				code: CODES.missingCommand,
				line: block.lineOf[key],
				detail: `"${key}:" states a count with no ${ARROW} <command> — every count names the command that produced it (#488)`,
			});
		}
		const drift = driftFor(key, value, actual);
		if (drift !== null) findings.push({ code: drift.code, line: block.lineOf[key], detail: drift.detail });
	}
	return findings;
}

function driftFor(key, value, actual) {
	if (key === "head") {
		return sameHead(value, actual.head) ? null : { code: CODES.staleHead, detail: `block ${value} · repo ${actual.head}` };
	}
	if (key === "changed-files") {
		return value === actual.changedFiles
			? null
			: { code: CODES.staleChangedFiles, detail: `block ${value} · repo ${actual.changedFiles}` };
	}
	if (key === "src-diff-lines") {
		return value === actual.srcDiffLines ? null : { code: CODES.staleSrcDiff, detail: `block ${value} · repo ${actual.srcDiffLines}` };
	}
	if (key === "suite") {
		const measured = actual.suite;
		return value.files === measured.files && value.tests === measured.tests
			? null
			: {
					code: CODES.staleSuite,
					detail: `block ${value.files} files / ${value.tests} tests · repo ${measured.files} files / ${measured.tests} tests`,
				};
	}
	const measured = { src: formatRatio(actual.budget.src), scripts: formatRatio(actual.budget.scripts) };
	return value.src === measured.src && value.scripts === measured.scripts
		? null
		: { code: CODES.staleBudget, detail: `block src ${value.src} · scripts ${value.scripts} · repo src ${measured.src} · scripts ${measured.scripts}` };
}

/** Two shas name one commit when they are equal or one is a prefix of the other; case-insensitive. */
export function sameHead(left, right) {
	const a = String(left ?? "").toLowerCase();
	const b = String(right ?? "").toLowerCase();
	if (a === "" || b === "") return false;
	return a === b || b.startsWith(a) || a.startsWith(b);
}

/**
 * The whole `--check` contract over one body: `{ exit, findings, blocks }`.
 *
 *   0 blocks, no count  → clean: nothing to attribute, and a docs PR must not need a block
 *   0 blocks, a count   → exit 2 `missing-block` — the block is REQUIRED precisely because a number is
 *                         present and nothing recomputes it
 *   2+ blocks           → drift `multiple-blocks`; the values cannot be compared against two blocks, so
 *                         the duplicate is the finding (and `--apply` collapses it)
 *   exactly 1 block     → every key compared, then the ban list over the text outside it
 */
export function checkBody(body, actual) {
	const lines = String(body).split("\n");
	const { ranges, unclosed } = scanBlocks(lines);
	if (unclosed !== -1) {
		return {
			exit: EXIT.USAGE,
			blocks: 0,
			findings: [
				{
					code: CODES.missingBlock,
					line: unclosed + 1,
					detail: `the block opened at line ${unclosed + 1} is never closed by ${BLOCK.end}`,
				},
			],
		};
	}
	const outside = unattributedCounts(lines, ranges);
	if (ranges.length === 0) {
		if (outside.length === 0) return { exit: EXIT.OK, blocks: 0, findings: [] };
		return {
			exit: EXIT.USAGE,
			blocks: 0,
			findings: [
				{
					code: CODES.missingBlock,
					line: outside[0].line,
					detail: `no ${BLOCK.begin} block, but line ${outside[0].line} states a count — a block is required once the body states one`,
				},
			],
		};
	}
	if (ranges.length > 1) {
		return {
			exit: EXIT.DRIFT,
			blocks: ranges.length,
			findings: [
				{
					code: CODES.multipleBlocks,
					line: ranges[1].begin + 1,
					detail: `${ranges.length} pr-evidence blocks — exactly one may state the numbers (first at line ${ranges[0].begin + 1}, second at line ${ranges[1].begin + 1})`,
				},
				...outside,
			],
		};
	}
	const findings = [...compare(parseBlock(lines, ranges[0]), actual), ...outside];
	return { exit: findings.length === 0 ? EXIT.OK : EXIT.DRIFT, blocks: 1, findings };
}

/** Re-exported so the CLI and its tests share one "cannot check" type: exit 2, never a drift. */
export { InputError };

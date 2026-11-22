#!/usr/bin/env node
// Purpose: the friction-disposition ledger — one table where every friction row and every class in a
// cycle's window carries exactly one disposition, rendered and gated by one command (issue #560).
//
// WHY. The friction log measures its own gaps: no disposition record (2 rows carried `→ #N`), 118 classes
// for 205 rows, and 96 singleton rows Rule 11's ≥2 rule never touches. Rule 11 counted classes in prose,
// at close, from memory — and the outcome was recorded nowhere, so a merged issue could not update its
// own row and a widened issue read exactly like an established P0. The ledger is the receipt; `--check`
// is the refusal. The cycle is not closed until it exits 0.
//
// THE MODEL. Rows are identified by their 1-based DATA-ROW index in `.development/FRICTION_LOG.md` (row 1
// = the first `| 2026-… |` line). A window is an inclusive `from..to` range over those indices; the
// windows must tile the log from the first one onward (later windows start at the previous `to + 1`) and
// rows before the first window are pre-ledger legacy, reported and never silently "covered". A data row
// whose observation matches `^CYCLE .*CLOSED` is a CLOSE RECORD, not a friction row: it is counted,
// reported, and excluded from coverage. Coverage is therefore a partition of the window's non-record
// rows across that cycle's classes — every index exactly once, and a `rows: —` class is evidence-only.
//
// EXITS (one meaning each):
//   0  clean
//   1  the ledger is wrong — coverage, grammar, referents, currency, the closing gate
//   2  CANNOT CHECK — unreadable file, malformed table/JSON, unknown cycle, UNAVAILABLE facts, usage.
//      A valid ledger whose `--cycle` is not the last window under `--close` is 1 (not 2): the ledger
//      is well-formed, the mode is wrong. When one input has both classes of defect the exit is 2 —
//      the malformed check runs first, because a table that cannot be read cannot be judged.
//
// TOLERANT LOG, STRICT LEDGER. The log's splitter takes cell 0 as the date, cell 1 as the tag and joins
// cells 2..n with `|`, so the real row 189 (`31 passed | 1 skipped`, unescaped) parses without rewriting
// history. The ledger requires escaped `\|` and exactly seven cells: it is ours, so it can be strict.
//
// FACTS ARE INJECTED. The pure exports (`parseLog`, `parseLedger`, `renderCycle`, `check`) never touch
// fs/git/gh: they take `facts = {states: Map, commitExists(sha), docHasHeading(path, heading)}`. All I/O
// lives in the CLI, which resolves issue states per id (`gh issue view <n> --json number,state`, ≤ 12
// refs, 20 s, no retry) or reads them from `--states` for an offline run. Discriminators, in one place:
// exit 1 + stderr `Could not resolve to an issue` → MISSING; a successful answer whose `number` is not
// the id, or whose state is outside `{OPEN, CLOSED}`, → 2; any other failure → 2 (UNAVAILABLE). A
// permission-hidden issue produces the same error as a nonexistent one, so ambiguity resolves as
// UNAVAILABLE and fails closed; the refusal says so.
//
// THE CLOSING GATE binds only in close mode: `--check --cycle <name> --close` requires `<name>` to be the
// last window AND that window's `to` to equal the log's last DATA row — records included, because a window
// ends on its own close record (§1.1); records stay excluded from COVERAGE, never from the extent.
// `--check --cycle <name>` without `--close` audits one window while later rows exist — that is how the
// seed (an earlier cycle) is
// checked against the live log, and `--history` is that same plain check under its older name (it refuses
// `--close`, so the two modes cannot be confused). Plain check is NOT a lax check: coverage inside the
// window is still a partition.
//
// RENDER IS CONDITIONAL AND ATOMIC. `--render --cycle <name>` rewrites only that cycle's `issue` cells and
// never another cycle's bytes: read+hash → build → re-read+hash → if the hash moved, retry once, then
// refuse (`ledger changed during render; re-run`). The write is a temp file in the same directory, fsync,
// chmod to the file's existing mode (0644 by default), rename, fsync the directory; a symlink is refused
// rather than followed. There is no lock daemon — the contract, stated in the ledger header, is one
// writer at a time.
//
// STATED LIMITS (not gaps to discover in review):
//   • A row EDITED IN PLACE is undetectable from the log alone; `--check` detects a row that stops
//     parsing only through the arithmetic the closing gate pins. The ledger header and the ritual both
//     say "never insert or edit a logged row" — this is a human-review obligation, declared.
//   • A path containing `::` is not representable in `accepted → <path>::<heading>`; the split is at the
//     FIRST `::`, which keeps a heading containing `::` intact.
//   • Priority (`P0 #N`) is a human judgement; the check validates the anchor (literal `Rule 11` plus an
//     occurrence count) and the issue's state, never the truth of the priority.
//   • The candidates file (#533's seam) is provisional. Its KIND set is the producer's five (#574:
//     `failed`, `deadline`, `retry`, `stop`, `steer`) and `via` is a retry's provenance — `transport` or
//     `explicit`, refused anywhere else (`candidate-via-kind`), because a stop carrying a retry's route is
//     a producer bug, not a shape this tool should guess at.
//   • A citation's evidence resolving (#533) proves the CITED BYTES still exist; it does not prove the
//     candidate was machine-generated or that the line says what the candidate claims. A hand-edited
//     candidates file can cite an unrelated real line and carry that line's true digest — drift
//     protection, not forgery protection. Re-generating the payload at close and diffing it is a
//     follow-up, not claimed here.
//
// CITATIONS RESOLVE, AND `check` STAYS PURE (#533). `--source-root <dir>` (repeatable) turns resolution
// on: the CLI lists the roots, finds each cited candidate's rotation family, hashes the cited line's raw
// bytes and hands `check` a `{eventId: {status, tried[]}}` map. Without the flag there is no resolution
// and the output is byte-identical to the pre-#533 tool — the ritual always passes it. The precedence is
// fail-closed: an incomplete search (a root or file that cannot be listed or read) is exit 2 even when a
// match was found; then malformed input (2); then no evidence (1); then match (0); then absent, short and
// drift (1 each). A dismissal is exempt from all of it.
//
//   node scripts/friction-disposition.mjs --check --cycle <name> [--close] [--ledger <p>] [--log <p>]
//                                         [--states <file>] [--candidates <file>] [--source-root <dir>]...
//   node scripts/friction-disposition.mjs --render --cycle <name> [--ledger <p>] [--states <file>]
//   node scripts/friction-disposition.mjs --history --cycle <name> [--ledger <p>] [--log <p>] [--states <file>]
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	existsSync,
	fsyncSync,
	lstatSync,
	openSync,
	readFileSync,
	readdirSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The checkout this script lives in — the default paths and every relative referent resolve here. */
export const ROOT = join(HERE, "..");

export const DEFAULT_LEDGER = join(ROOT, ".development", "FRICTION_DISPOSITIONS.md");
export const DEFAULT_LOG = join(ROOT, ".development", "FRICTION_LOG.md");

export const USAGE =
	"usage: friction-disposition.mjs --check --cycle <name> [--close] [--ledger <p>] [--log <p>] [--states <file>] [--candidates <file>] [--source-root <dir>]...\n" +
	"       friction-disposition.mjs --render --cycle <name> [--ledger <p>] [--states <file>]\n" +
	"       friction-disposition.mjs --history --cycle <name> [--ledger <p>] [--log <p>] [--states <file>]";

/** Exit codes, named so the docs, the tests and the ledger header cannot drift from the script. */
export const EXIT = Object.freeze({ OK: 0, LEDGER: 1, CANNOT_CHECK: 2 });

/** The form grammar, quoted in refusals so a reader is never told "invalid" without the list. */
export const FORM_LIST = "P0 #N | fixed <sha> | folded into #N | accepted → <path>::<heading> | stale";

/** The states a fact may carry. `MISSING` is a resolved answer ("no such issue"), never an error. */
export const STATES = Object.freeze(["OPEN", "CLOSED", "MISSING"]);

const CLASS_RE = /^[a-z0-9][a-z0-9-]*$/;
const ISSUE_CELL_RE = /^#([0-9]+) (open|closed|missing)$/;
const LOG_ROW_RE = /^\|\s*(\d{4}-\d{2}-\d{2})\s*\|/;
const HEADING_RE = /^#{1,6}\s+(.*)$/;
const SHA_RE = /^[0-9a-f]{7,40}$/;
const ANCHOR_RE = /Rule 11/;
const ANCHOR_COUNT_RE = /(?:≥\s*2|\bx2\b)/;
const RECORD_RE = /^CYCLE\b[\s\S]*\bCLOSED\b/;
const STALE_REASON_RE = /\d{4}-\d{2}-\d{2}|#\d+|\b[0-9a-f]{7,40}\b/;

/**
 * An input the tool cannot read confidently. Always exit 2 (`CANNOT_CHECK`) — never a drift, never a
 * pass. The class is local on purpose: this tool owns its refusal grammar and imports no sibling script's
 * error type, so #495's module can change without silently changing this one's contract.
 */
export class InputError extends Error {
	constructor(message, code = null) {
		super(message);
		this.name = "InputError";
		/** A stable refusal code (`candidate-via-kind`), so a caller can branch without parsing prose. */
		this.code = code;
	}
}

function problem(code, message, exit) {
	return { code, message, exit };
}

function describeError(error) {
	return error instanceof Error ? error.message : String(error);
}

/** Bytewise (ASCII) order — §1.4. Never `localeCompare`: collation is a locale's opinion, not a contract. */
export function compareClasses(a, b) {
	return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Split one table line into trimmed cells, honouring `\|` as a literal pipe. Returns `null` when the
 * line is not a table row at all. A trailing pipe is optional; an unescaped pipe is a separator, which is
 * exactly why a ledger row with one becomes an extra cell and fails the strict count.
 */
export function splitCells(line) {
	const trimmed = line.trim();
	if (!trimmed.startsWith("|")) return null;
	const cells = [];
	let buf = "";
	for (let i = 1; i < trimmed.length; i++) {
		const ch = trimmed[i];
		if (ch === "\\" && trimmed[i + 1] === "|") {
			buf += "|";
			i++;
			continue;
		}
		if (ch === "|") {
			cells.push(buf.trim());
			buf = "";
			continue;
		}
		buf += ch;
	}
	if (buf.trim() !== "") cells.push(buf.trim());
	return cells;
}

/** Render one cell back into a line, escaping a literal pipe so the strict reader still sees one cell. */
function formatCell(value) {
	return value.replaceAll("|", "\\|");
}

/**
 * Replace cell `index` of a raw table line, keeping every other byte (spacing, escapes, order) intact.
 * `renderCycle` depends on this: a render that normalized anything else would fail "only that cell
 * changed" and would silently rewrite a human's table.
 */
function withCell(line, index, value) {
	const cells = splitCells(line);
	if (!cells) throw new InputError(`not a table row: ${line}`);
	const parts = [];
	let buf = "";
	for (let i = 0; i < line.length; i++) {
		const ch = line[i];
		if (ch === "\\" && line[i + 1] === "|") {
			buf += "\\|";
			i++;
			continue;
		}
		if (ch === "|") {
			parts.push(buf);
			buf = "";
			continue;
		}
		buf += ch;
	}
	parts.push(buf);
	// parts[0] is the text before the leading pipe (empty for a table row); cell i is parts[i + 1].
	parts[index + 1] = ` ${formatCell(value)} `;
	return parts.join("|");
}

/**
 * `parseLog` — tolerant by contract. Cell 0 is the date, cell 1 the tag; cells 2..n are joined with `|`
 * as the observation, so an unescaped pipe inside prose (real row 189) does not hide a row.
 *
 * A line counts as a DATA ROW when it starts with `| <date> |` and has at least two cells (date, tag).
 * Anything else is prose, a separator or a malformed line that does not claim to be a row.
 */
export function parseLog(text) {
	const rows = [];
	const lines = String(text).split("\n");
	let index = 0;
	for (let at = 0; at < lines.length; at++) {
		if (!LOG_ROW_RE.test(lines[at])) continue;
		const cells = splitCells(lines[at]);
		if (!cells || cells.length < 2) continue;
		index += 1;
		const observation = cells.slice(2).join("|").trim();
		rows.push({
			index,
			date: cells[0],
			tag: cells[1],
			observation,
			record: RECORD_RE.test(observation),
			line: at + 1,
		});
	}
	const records = rows.filter((row) => row.record).length;
	return { rows, records, frictionCount: rows.length - records };
}

const WINDOW_HEADER = ["cycle", "from", "to", "opened", "closed", "provenance"];
const DISPOSITION_HEADER = ["cycle", "class", "rows", "evidence", "disposition", "issue", "fix"];

/**
 * Read one table inside `[start, end)`: the first table line is the header, the second must be a
 * separator, then data rows continue until a line that is not a table row. Strict — wrong header,
 * wrong separator, wrong cell count, or a conflict marker anywhere is exit 2.
 */
function readTable(lines, start, end, expectedHeader, where) {
	let at = start;
	while (at < end && splitCells(lines[at]) === null) at++;
	if (at >= end) throw new InputError(`${where}: no table found`);
	const header = splitCells(lines[at]);
	if (header.length !== expectedHeader.length || header.some((cell, i) => cell !== expectedHeader[i])) {
		throw new InputError(
			`${where}: expected the header | ${expectedHeader.join(" | ")} |, found | ${header.join(" | ")} |`,
		);
	}
	const separator = splitCells(lines[at + 1] ?? "");
	if (!separator || separator.length !== expectedHeader.length || separator.some((cell) => !/^:?-{3,}:?$/.test(cell))) {
		throw new InputError(`${where} line ${at + 2}: expected a ${expectedHeader.length}-cell separator row`);
	}
	const rows = [];
	for (let i = at + 2; i < end; i++) {
		const cells = splitCells(lines[i]);
		if (cells === null) break;
		if (cells.length !== expectedHeader.length) {
			throw new InputError(
				`${where} line ${i + 1}: expected ${expectedHeader.length} cells, found ${cells.length} — escape a literal pipe as \\|`,
			);
		}
		rows.push({ cells, line: i + 1, at: i });
	}
	return rows;
}

/**
 * `parseLedger` — strict by contract: escaped `\|`, exactly seven cells, no conflict markers, no
 * duplicate `(cycle, class)`, unique well-formed windows. Anything unreadable is `InputError` (exit 2);
 * anything read but wrong (coverage, order, grammar, currency) belongs to `check` (exit 1).
 *
 * The returned object also carries `text`, `lines` and each row's 0-based `at`, so `renderCycle` can
 * rewrite one cell without rebuilding a table and re-formatting a human's row.
 */
export function parseLedger(text) {
	const source = String(text);
	const lines = source.split("\n");
	for (let i = 0; i < lines.length; i++) {
		if (/^(<<<<<<<|=======|>>>>>>>)/.test(lines[i].trimStart())) {
			throw new InputError(`ledger line ${i + 1}: unresolved conflict marker "${lines[i].trim()}"`);
		}
	}
	const headings = [];
	for (let i = 0; i < lines.length; i++) {
		const match = /^##\s+(.*)$/.exec(lines[i]);
		if (match) headings.push({ name: match[1].trim(), line: i });
	}
	const section = (name) => {
		const at = headings.findIndex((heading) => heading.name === name);
		if (at < 0) return null;
		const start = headings[at].line + 1;
		const end = at + 1 < headings.length ? headings[at + 1].line : lines.length;
		return { start, end };
	};
	const windowSection = section("Windows");
	if (!windowSection) throw new InputError("ledger has no ## Windows section");
	const dispositionSection = section("Dispositions");
	if (!dispositionSection) throw new InputError("ledger has no ## Dispositions section");

	const windows = [];
	for (const row of readTable(lines, windowSection.start, windowSection.end, WINDOW_HEADER, "windows")) {
		const [cycle, from, to, opened, closed, provenance] = row.cells;
		if (!cycle) throw new InputError(`windows line ${row.line}: empty cycle`);
		for (const [name, value] of [
			["from", from],
			["to", to],
		]) {
			if (!/^\d+$/.test(value)) throw new InputError(`windows line ${row.line}: ${name} "${value}" is not a decimal index`);
		}
		const fromIndex = Number(from);
		const toIndex = Number(to);
		if (fromIndex > toIndex) {
			throw new InputError(`windows line ${row.line}: from ${fromIndex} is after to ${toIndex} (ranges are inclusive and ascending)`);
		}
		for (const [name, value] of [
			["opened", opened],
			["closed", closed],
		]) {
			if (Number.isNaN(Date.parse(value))) throw new InputError(`windows line ${row.line}: ${name} "${value}" is not a real date`);
		}
		if (Date.parse(opened) > Date.parse(closed)) {
			throw new InputError(`windows line ${row.line}: opened ${opened} is after closed ${closed}`);
		}
		if (windows.some((window) => window.cycle === cycle)) {
			throw new InputError(`windows line ${row.line}: duplicate window "${cycle}"`);
		}
		windows.push({ cycle, from: fromIndex, to: toIndex, opened, closed, provenance, line: row.line, at: row.at });
	}

	const dispositions = [];
	for (const row of readTable(lines, dispositionSection.start, dispositionSection.end, DISPOSITION_HEADER, "dispositions")) {
		const [cycle, classCell, rowsCell, evidence, disposition, issue, fix] = row.cells;
		// The class cell is a backticked code span (§1.4) — one shape, so a class is distinguishable from prose
		// at a glance. The NAME inside it is what the regex governs; a bare name is refused, not accepted as an
		// alternative rendering.
		const className = /^`([^`]+)`$/.exec(classCell)?.[1];
		if (className === undefined) {
			throw new InputError(
				`dispositions line ${row.line}: class cell "${classCell}" is not a backticked code span — write it as \`${classCell}\` (§1.4)`,
			);
		}
		if (!CLASS_RE.test(className)) {
			throw new InputError(`dispositions line ${row.line}: class "${className}" must match ^[a-z0-9][a-z0-9-]*$ (in a backticked code span)`);
		}
		let indices = null;
		if (rowsCell !== "—") {
			if (rowsCell === "" || !/^[0-9]+(\s*,\s*[0-9]+)*$/.test(rowsCell)) {
				throw new InputError(`dispositions line ${row.line}: rows "${rowsCell}" must be "—" or a comma list of indices`);
			}
			indices = rowsCell.split(",").map((part) => Number(part.trim()));
		}
		if (fix !== "mechanical" && fix !== "judgement") {
			throw new InputError(`dispositions line ${row.line}: fix "${fix}" must be mechanical or judgement`);
		}
		if (fix === "judgement" && evidence === "") {
			throw new InputError(`dispositions line ${row.line}: fix judgement requires a reason in evidence`);
		}
		let issueId = null;
		let issueState = null;
		if (issue !== "—") {
			const match = ISSUE_CELL_RE.exec(issue);
			if (!match) {
				throw new InputError(
					`dispositions line ${row.line}: issue "${issue}" must be "—" or "#<n> open|closed|missing"`,
				);
			}
			issueId = Number(match[1]);
			issueState = match[2];
		}
		if (dispositions.some((entry) => entry.cycle === cycle && entry.class === className)) {
			throw new InputError(`dispositions line ${row.line}: duplicate class "${className}" for cycle "${cycle}"`);
		}
		dispositions.push({
			cycle,
			class: className,
			rowsRaw: rowsCell,
			indices,
			evidence,
			disposition,
			issueRaw: issue,
			issueId,
			issueState,
			fix,
			line: row.line,
			at: row.at,
		});
	}

	if (windows.length === 0) throw new InputError("ledger has no windows — the ## Windows table is empty");
	return { text: source, lines, windows, dispositions };
}

// ---------------------------------------------------------------------------
// Grammar — §2, one function, so the check and the refusal cannot disagree.
// ---------------------------------------------------------------------------

/** The five forms, classified. A malformed cell returns `{code, message}` and never guesses a form. */
export function classifyDisposition(cell) {
	const text = cell.trim();
	if (/^P0\b/.test(text)) {
		const match = /^P0 #([0-9]+)$/.exec(text);
		return match ? { form: "p0", id: Number(match[1]) } : { code: "bad-p0", message: `is not "P0 #<n>"` };
	}
	if (/^fixed\b/.test(text)) {
		const match = /^fixed (\S+)$/.exec(text);
		if (!match || !SHA_RE.test(match[1])) {
			return { code: "bad-fixed", message: `is not "fixed <sha>" (7–40 lowercase hex)` };
		}
		return { form: "fixed", sha: match[1] };
	}
	if (/^folded\b/.test(text)) {
		const match = /^folded into #([0-9]+)$/.exec(text);
		return match ? { form: "folded", id: Number(match[1]) } : { code: "bad-folded", message: `is not "folded into #<n>"` };
	}
	if (/^accepted\b/.test(text)) {
		const match = /^accepted → (.+)$/.exec(text);
		if (!match) return { code: "bad-accepted", message: `needs "accepted → <path>::<heading>"` };
		const body = match[1];
		const split = body.indexOf("::");
		if (split < 0) return { code: "bad-accepted", message: `needs "<path>::<heading>" — no "::" found` };
		const path = body.slice(0, split).trim();
		const heading = body.slice(split + 2).trim();
		if (!path || !heading) {
			return { code: "bad-accepted", message: `needs a non-empty path and heading either side of "::"` };
		}
		if (isAbsolute(path) || /^[A-Za-z]:[\\/]/.test(path)) {
			return { code: "bad-accepted", message: `path "${path}" must be relative to the repository root` };
		}
		return { form: "accepted", path, heading };
	}
	if (text === "stale") return { form: "stale" };
	if (/^stale\b/.test(text)) return { code: "bad-stale", message: `is not exactly "stale"` };
	return { code: "bad-form", message: `is none of: ${FORM_LIST}` };
}

/** The `stale` evidence rule: `→` followed by a reason naming a date, an issue or a sha. */
function staleReason(evidence) {
	const at = evidence.indexOf("→");
	if (at < 0) return null;
	const reason = evidence.slice(at + 1).trim();
	return reason && STALE_REASON_RE.test(reason) ? reason : null;
}

function stateOf(facts, id) {
	const states = facts?.states;
	if (states instanceof Map) return states.get(String(id));
	if (states && typeof states === "object") return states[String(id)];
	return undefined;
}

/**
 * Every id whose state the check must know: the ids named by a window's DISPOSITION and ISSUE cells.
 * Numbers merely cited in `evidence` are deliberately excluded (§3, r3 check 4) — prose is not a fact
 * dependency, and a citation-heavy evidence cell must not fan out into a dozen `gh` calls.
 */
export function requiredIds(ledger, cycle) {
	const window = ledger.windows.find((entry) => entry.cycle === cycle);
	if (!window) throw new InputError(`unknown cycle "${cycle}"`);
	const ids = new Set();
	for (const entry of ledger.dispositions) {
		if (entry.cycle !== cycle) continue;
		const classified = classifyDisposition(entry.disposition);
		if (classified.id !== undefined) ids.add(classified.id);
		if (entry.issueId !== null) ids.add(entry.issueId);
	}
	return [...ids].sort((a, b) => a - b);
}

// ---------------------------------------------------------------------------
// check — pure. Every rule names the row, the class or the index it is about.
// ---------------------------------------------------------------------------

/**
 * `check({ledger, log, cycle, facts, close, candidates}) → {problems, stats}`
 *
 * `ledger` / `log` are the parsed objects from `parseLedger` / `parseLog`. Each problem is
 * `{code, message, exit}`; the exit is 2 whenever any input could not be read confidently, so a caller's
 * exit code is `problems.some(p => p.exit === 2) ? 2 : problems.length ? 1 : 0`.
 */
/** A blank stats record, so even a refusal prints a shape a reader can compare across cycles. */
function blankStats(cycle) {
	return {
		cycle,
		window: null,
		frictionRows: 0,
		assignedRows: 0,
		classes: 0,
		records: 0,
		legacy: 0,
		facts: { ids: [], open: 0, closed: 0, missing: 0 },
		candidates: null,
	};
}

/** A disposition row for a cycle with no window breaks the model the ledger is built on. */
function checkDeclaredCycles(ledger, problems) {
	const windowNames = new Set(ledger.windows.map((window) => window.cycle));
	for (const entry of ledger.dispositions) {
		if (!windowNames.has(entry.cycle)) {
			problems.push(
				problem(
					"undeclared-cycle",
					`dispositions line ${entry.line}: class \`${entry.class}\` names cycle "${entry.cycle}", which has no window`,
					1,
				),
			);
		}
	}
}

/** Windows tile the log from the first one onward: a gap or an overlap fails. */
function checkContiguity(ledger, problems) {
	for (let i = 1; i < ledger.windows.length; i++) {
		const previous = ledger.windows[i - 1];
		const window = ledger.windows[i];
		if (window.from !== previous.to + 1) {
			problems.push(
				problem(
					"contiguity",
					`window "${window.cycle}" starts at row ${window.from} but "${previous.cycle}" ends at ${previous.to} — gap or overlap (later windows start at the previous to + 1)`,
					1,
				),
			);
		}
	}
}

/** The log's last data-row index — the window extent's ceiling. Records are data rows: only coverage skips them. */
function lastDataIndex(log) {
	return log.rows[log.rows.length - 1].index;
}

/** A window that ends past the log's last data row claims an index that names nothing. */
function checkWindowBounds({ log, window, cycle }, problems) {
	const lastIndex = lastDataIndex(log);
	if (window.to > lastIndex) {
		problems.push(
			problem(
				"window-past-log",
				`window "${cycle}" (${window.from}..${window.to}) extends past the log's last data row ${lastIndex} — the index no longer names a row`,
				1,
			),
		);
	}
}

/**
 * The closing gate — close mode only. A plain check audits an earlier window while later rows exist;
 * close mode binds `--cycle` to the last window and that window's `to` to the log's last DATA row, so a
 * fresh friction row cannot be left for "the next cycle" at the close it belongs to.
 *
 * The comparison is against the last data row, records included: a window ends on its own close record
 * (§1.1), so comparing to the last FRICTION row would make the ledger's own window pattern permanently
 * un-closeable (review 563 F1). Records stay excluded from coverage — never from the window's extent.
 * The over-run direction (`to` past the log) is already a single failure, `window-past-log` from
 * `checkWindowBounds`; the gate does not restate it.
 */
function checkClosingGate({ log, ledger, window, cycle }, problems) {
	const last = ledger.windows[ledger.windows.length - 1];
	if (last.cycle !== cycle) {
		problems.push(problem("not-closing-cycle", `not the closing cycle (last: ${last.cycle})`, 1));
		return;
	}
	const lastDataRow = lastDataIndex(log);
	if (window.to < lastDataRow) {
		problems.push(
			problem("unassigned-close", `log has rows ${window.to + 1}..${lastDataRow} unassigned — re-declare at close`, 1),
		);
	}
}

/**
 * Coverage is a partition: every non-record index in the window assigned exactly once, no index outside
 * it, and an evidence-only (`rows: —`) class carrying the evidence that justifies its existence. The
 * `rows: —` skip is scoped to that class's ASSIGNMENTS — never to the partition itself.
 */
function checkCoverage({ log, window, cycleRows }, problems, stats) {
	const inWindow = log.rows.filter((row) => row.index >= window.from && row.index <= window.to);
	const assigned = new Map();
	for (const entry of cycleRows) {
		if (entry.indices === null) {
			if (entry.evidence.trim() === "") {
				problems.push(
					problem(
						"missing-evidence",
						`class \`${entry.class}\`: rows is "—" but evidence is empty — an evidence-only class must say what it observed`,
						1,
					),
				);
			}
			continue;
		}
		for (const index of entry.indices) {
			if (index < window.from || index > window.to) {
				problems.push(
					problem("outside-window", `class \`${entry.class}\` assigns row ${index}, outside window ${window.from}..${window.to}`, 1),
				);
				continue;
			}
			const row = log.rows.find((candidate) => candidate.index === index);
			if (row?.record) {
				problems.push(
					problem(
						"record-assigned",
						`class \`${entry.class}\` assigns row ${index}, which is a close record — records are excluded from coverage`,
						1,
					),
				);
				continue;
			}
			const holders = assigned.get(index) ?? [];
			if (holders.includes(entry.class)) {
				problems.push(
					problem("duplicate-assignment", `row ${index} is assigned twice in class \`${entry.class}\` — exactly one assignment per row`, 1),
				);
				continue;
			}
			holders.push(entry.class);
			assigned.set(index, holders);
		}
	}
	for (const [index, holders] of [...assigned.entries()].sort((a, b) => a[0] - b[0])) {
		if (holders.length > 1) {
			problems.push(
				problem(
					"duplicate-assignment",
					`row ${index} is assigned to ${holders.length} classes (${holders.map((name) => `\`${name}\``).join(", ")}) — exactly one is required`,
					1,
				),
			);
		}
	}
	for (const row of inWindow) {
		if (row.record) continue;
		if (!assigned.has(row.index)) {
			problems.push(
				problem(
					"unassigned",
					`row ${row.index} (${row.date}, ${row.tag}) is in window ${window.from}..${window.to} with no class — every friction row needs exactly one disposition`,
					1,
				),
			);
		}
	}
	stats.frictionRows = inWindow.filter((row) => !row.record).length;
	stats.assignedRows = [...assigned.keys()].filter((index) => !log.rows.find((row) => row.index === index)?.record).length;
	stats.classes = cycleRows.length;
}

/** Window order, then class bytewise ascending (ASCII) — the order `renderCycle` depends on. */
function checkOrder(cycleRows, problems) {
	for (let i = 1; i < cycleRows.length; i++) {
		if (compareClasses(cycleRows[i - 1].class, cycleRows[i].class) > 0) {
			problems.push(
				problem("order", `class \`${cycleRows[i].class}\` follows \`${cycleRows[i - 1].class}\` — classes render bytewise ascending`, 1),
			);
			return;
		}
	}
}

/** §2's grammar, its anchors and its referents. Returns the issue ids the forms name. */
function checkGrammar({ cycleRows, facts }, problems) {
	const ids = new Set();
	const docCache = new Map();
	for (const entry of cycleRows) {
		const cell = entry.disposition.trim();
		const classified = classifyDisposition(cell);
		if (classified.code) {
			problems.push(problem(classified.code, `class \`${entry.class}\`: disposition "${cell}" ${classified.message}`, 1));
		} else if (classified.form === "p0") {
			ids.add(classified.id);
			const fact = stateOf(facts, classified.id);
			if (!ANCHOR_RE.test(entry.evidence) || !ANCHOR_COUNT_RE.test(entry.evidence)) {
				problems.push(
					problem(
						"p0-anchor",
						`class \`${entry.class}\`: P0 #${classified.id} needs evidence carrying the literal "Rule 11" and an occurrence count (≥2 or x2) — got "${entry.evidence}"`,
						1,
					),
				);
			}
			if (fact === "MISSING") {
				problems.push(problem("missing-fact", `class \`${entry.class}\`: #${classified.id} is MISSING — every form needs a resolvable issue; reclassify`, 1));
			} else if (fact === "CLOSED") {
				problems.push(problem("p0-closed", `class \`${entry.class}\`: P0 #${classified.id} names a CLOSED issue — reclassify as fixed or folded`, 1));
			}
		} else if (classified.form === "folded") {
			ids.add(classified.id);
			if (stateOf(facts, classified.id) === "MISSING") {
				problems.push(problem("missing-fact", `class \`${entry.class}\`: #${classified.id} is MISSING — every form needs a resolvable issue; reclassify`, 1));
			}
		} else if (classified.form === "fixed") {
			if (typeof facts?.commitExists === "function" && !facts.commitExists(classified.sha)) {
				problems.push(problem("bad-commit", `class \`${entry.class}\`: fixed ${classified.sha} — no such commit in this repository`, 1));
			}
		} else if (classified.form === "accepted") {
			const key = `${classified.path}\u0000${classified.heading}`;
			if (!docCache.has(key)) {
				docCache.set(
					key,
					typeof facts?.docHasHeading === "function" ? facts.docHasHeading(classified.path, classified.heading) : false,
				);
			}
			if (!docCache.get(key)) {
				problems.push(
					problem(
						"bad-accepted",
						`class \`${entry.class}\`: accepted → ${classified.path}::${classified.heading} — no heading "${classified.heading}" in ${classified.path}`,
						1,
					),
				);
			}
		} else if (classified.form === "stale") {
			if (!staleReason(entry.evidence)) {
				problems.push(
					problem(
						"bad-stale",
						`class \`${entry.class}\`: stale needs "→ <reason>" naming a date, an issue or a sha — got "${entry.evidence}"`,
						1,
					),
				);
			}
		}

		// Forms 1 and 3 name the same issue as the issue cell; 2, 4 and 5 name no issue at all.
		if (classified.id !== undefined) {
			if (entry.issueId === null) {
				problems.push(
					problem("issue-mismatch", `class \`${entry.class}\`: disposition "${cell}" names #${classified.id} but the issue cell is "—"`, 1),
				);
			} else if (entry.issueId !== classified.id) {
				problems.push(
					problem("issue-mismatch", `class \`${entry.class}\`: disposition "${cell}" names #${classified.id} but the issue cell names #${entry.issueId}`, 1),
				);
			}
		} else if (entry.issueId !== null) {
			problems.push(
				problem(
					"issue-mismatch",
					`class \`${entry.class}\`: disposition "${cell}" names no issue but the issue cell is "${entry.issueRaw}" — use "—"`,
					1,
				),
			);
		}
	}
	return ids;
}

/**
 * Currency — the issue cell IS the fact, and a rendered fact goes stale when the issue moves. A MISSING
 * fact is not a currency failure (the cell says `missing` and tells the truth); it is the grammar's
 * refusal to accept a disposition whose referent does not exist.
 */
function checkCurrency({ cycleRows, facts }, problems) {
	const ids = new Set();
	for (const entry of cycleRows) {
		if (entry.issueId === null) continue;
		ids.add(entry.issueId);
		const fact = stateOf(facts, entry.issueId);
		if (fact === undefined) {
			problems.push(
				problem(
					"no-fact",
					`class \`${entry.class}\`: no state fact for #${entry.issueId} — the fact set must name exactly the window's referenced ids`,
					2,
				),
			);
			continue;
		}
		if (entry.issueState !== String(fact).toLowerCase()) {
			problems.push(
				problem(
					"stale-state",
					`class \`${entry.class}\`: issue #${entry.issueId} is rendered "${entry.issueState}" but the fact is ${fact} — re-run --render`,
					1,
				),
			);
		}
	}
	return ids;
}

function factCounts(ids, facts) {
	const counts = { ids: [...ids].sort((a, b) => a - b), open: 0, closed: 0, missing: 0 };
	for (const id of counts.ids) {
		const fact = stateOf(facts, id);
		if (fact === "OPEN") counts.open += 1;
		else if (fact === "CLOSED") counts.closed += 1;
		else if (fact === "MISSING") counts.missing += 1;
	}
	return counts;
}

/**
 * One cited candidate's problem, or `null` when the citation resolved. The MESSAGE lives here; the
 * DECISION (status, tried[]) was made by the CLI's resolver, so `check` stays pure.
 */
function citationProblem(entry, eventId, record) {
	const status = record?.status;
	if (status === RESOLVED) return null;
	// A status a caller invented is not a status this table knows: it fails closed under the
	// unreadable name rather than inventing a sixth outcome.
	const label = CITATION[status] ? status : "source-unreadable";
	const exit = CITATION[status]?.exit ?? 2;
	const tried = Array.isArray(record?.tried) ? [...record.tried].sort(compareClasses) : [];
	const where = `candidate ${eventId}: ${label} —`;
	const line = parseSource(entry?.source)?.line;
	if (status === "invalid-source") {
		return problem(
			"invalid-source",
			`${where} source ${JSON.stringify(entry?.source)} is not "<session-log|spawn-log>:<basename>:<line>" — basename [A-Za-z0-9._-]+ (no path separator), line a positive safe integer`,
			exit,
		);
	}
	if (status === "invalid-digest") {
		return problem("invalid-digest", `${where} digest ${JSON.stringify(entry?.digest)} is not 16 lowercase hex characters`, exit);
	}
	if (status === "missing-digest") {
		return problem("missing-digest", `${where} no digest — a cited candidate must carry the 16-hex digest of its cited line`, exit);
	}
	if (status === "unresolvable-source") {
		const hint = typeof record?.hint === "string" && record.hint !== "" ? ` — ${record.hint}` : "";
		return problem(
			"unresolvable-source",
			`${where} ${familyLabel(entry?.source)} exists under no --source-root — the evidence is retired; dismiss the candidate or cite a line that still exists${hint}`,
			exit,
		);
	}
	if (status === "missing-line") {
		return problem("missing-line", `${where} source line ${line} is past the last line of every tried file (${tried.join(", ")})`, exit);
	}
	if (status === "stale-source") {
		return problem("stale-source", `${where} source line ${line} of every tried file hashes to something else — tried ${tried.join(", ")}`, exit);
	}
	// `source-unreadable`, and any status this table does not know: both fail closed. An incomplete or
	// unreadable search must never read as a match, and it must never read as absence either.
	return problem(
		"source-unreadable",
		`${where} ${tried.join(", ") || "no path recorded"} could not be listed or read; an incomplete search fails closed`,
		exit,
	);
}

/**
 * #533's seam: refuse to lose an event's identity or a dismissal, and — when `resolutions` is given —
 * refuse a cited candidate whose evidence no longer resolves. Two candidates may share a class —
 * identity is the `eventId` — and an empty live cycle must say so.
 */
function checkCandidateSeam({ ledger, candidates, resolutions }, problems, stats) {
	const list = Array.isArray(candidates.candidates) ? candidates.candidates : [];
	const ledgerClasses = new Set(ledger.dispositions.map((entry) => entry.class));
	let cited = 0;
	let dismissed = 0;
	const counts = {};
	for (const key of RESOLUTION_KEYS) counts[key] = 0;
	const found = [];
	if (candidates.claimedLive === true && list.length === 0) {
		found.push({
			eventId: "",
			entry: problem(
				"claimed-live-empty",
				"candidates: claimedLive is true but the file carries no candidates — a live cycle that logged nothing says claimedLive: false",
				1,
			),
		});
	}
	for (const entry of list) {
		const { eventId, hasClass, hasDismissal } = candidateShape(entry);
		if (hasClass && hasDismissal) {
			found.push({ eventId, entry: problem("candidate-both", `candidate ${eventId}: name a class or a dismissal, not both`, 1) });
		} else if (!hasClass && !hasDismissal) {
			found.push({
				eventId,
				entry: problem(
					"candidate-neither",
					`candidate ${eventId}: neither a class nor a dismissal — an event without a disposition is the gap this seam exists to refuse`,
					1,
				),
			});
		} else if (hasClass) {
			if (!ledgerClasses.has(entry.class)) {
				found.push({ eventId, entry: problem("candidate-unknown-class", `candidate ${eventId}: class "${entry.class}" is not in the ledger`, 1) });
			}
			cited += 1;
			if (resolutions) {
				const record = resolutions[eventId];
				const failure = citationProblem(entry, eventId, record);
				if (failure) found.push({ eventId, entry: failure });
				const bucket = record?.status === RESOLVED ? "resolved" : CITATION[record?.status]?.bucket;
				counts[bucket ?? "sourceUnreadable"] += 1;
			}
		} else {
			dismissed += 1;
		}
	}
	// Problems are sorted by eventId (bytewise) only once a resolution pass ran: then a refusal list is
	// a function of the file's content and never of the order its lines happen to sit in. Without
	// `--source-root` the RESOLVED problems stay in file order, so stderr remains byte-identical to the
	// pre-#533 tool. `sort` is stable: two problems on one event keep the order their rules fired in.
	const ordered = resolutions ? found.sort((a, b) => compareClasses(a.eventId, b.eventId)) : found;
	for (const item of ordered) problems.push(item.entry);
	stats.candidates = { total: list.length, cited, dismissed, claimedLive: candidates.claimedLive === true };
	if (resolutions) Object.assign(stats.candidates, counts);
}

/**
 * `check({ledger, log, cycle, facts, close, candidates, resolutions}) → {problems, stats}`
 *
 * `ledger` / `log` are the parsed objects from `parseLedger` / `parseLog`; `resolutions` is the CLI's
 * `{eventId: {status, tried[]}}` map (absent means no resolution pass ran). Each problem is
 * `{code, message, exit}`; the exit is 2 whenever any input could not be read confidently, so a caller's
 * exit code is `problems.some(p => p.exit === 2) ? 2 : problems.length ? 1 : 0`.
 */
export function check({ ledger, log, cycle, facts, close = false, candidates = null, resolutions = null }) {
	const problems = [];
	const stats = blankStats(cycle);
	if (!log || !Array.isArray(log.rows) || log.rows.length === 0) {
		return {
			problems: [problem("empty-log", "the log has no data rows — nothing can be checked (append a row or point --log at the log)", 2)],
			stats,
		};
	}
	if (!ledger || !Array.isArray(ledger.windows) || ledger.windows.length === 0) {
		return { problems: [problem("no-windows", "the ledger declares no windows — the ## Windows table is empty", 2)], stats };
	}
	stats.records = log.records;
	stats.legacy = Math.max(0, ledger.windows[0].from - 1);

	checkDeclaredCycles(ledger, problems);
	checkContiguity(ledger, problems);

	const window = ledger.windows.find((entry) => entry.cycle === cycle);
	if (!window) {
		const declared = ledger.windows.map((entry) => `"${entry.cycle}"`).join(", ");
		problems.push(problem("unknown-cycle", `unknown cycle "${cycle}" — the ledger declares ${declared}`, 2));
		return { problems, stats };
	}
	stats.window = { from: window.from, to: window.to };
	const cycleRows = ledger.dispositions.filter((entry) => entry.cycle === cycle);

	checkWindowBounds({ log, window, cycle }, problems);
	if (close) checkClosingGate({ log, ledger, window, cycle }, problems);
	checkCoverage({ log, window, cycleRows }, problems, stats);
	checkOrder(cycleRows, problems);
	const ids = checkGrammar({ cycleRows, facts }, problems);
	for (const id of checkCurrency({ cycleRows, facts }, problems)) ids.add(id);
	stats.facts = factCounts(ids, facts);
	if (candidates) checkCandidateSeam({ ledger, candidates, resolutions }, problems, stats);

	return { problems, stats };
}

// renderCycle — pure. One cycle's issue cells; every other byte survives.
// ---------------------------------------------------------------------------

/**
 * `renderCycle(ledger, cycle, facts) → text`
 *
 * Rows are sorted by class (bytewise) and the cycle's block is rebuilt in place; each row is its own
 * original line with only cell 5 replaced, so a human's spacing, escaping and evidence text survive a
 * render byte-for-byte. A row whose disposition names no issue keeps its issue cell untouched: wiping it
 * would destroy the only record that a human still has to look at it.
 */
export function renderCycle(ledger, cycle, facts) {
	const window = ledger.windows.find((entry) => entry.cycle === cycle);
	if (!window) throw new InputError(`unknown cycle "${cycle}"`);
	const rows = ledger.dispositions.filter((entry) => entry.cycle === cycle).sort((a, b) => compareClasses(a.class, b.class));
	if (rows.length === 0) return ledger.text;
	const lines = ledger.lines ?? ledger.text.split("\n");
	const target = new Set(rows.map((row) => row.at));
	const first = Math.min(...rows.map((row) => row.at));
	const cellFor = (row) => {
		const classified = classifyDisposition(row.disposition);
		if (classified.id === undefined) return row.issueRaw;
		const state = stateOf(facts, classified.id);
		if (state === undefined) throw new InputError(`no state fact for #${classified.id} (class \`${row.class}\`)`);
		return `#${classified.id} ${String(state).toLowerCase()}`;
	};
	const out = [];
	for (let at = 0; at < lines.length; at++) {
		if (at === first) {
			for (const row of rows) out.push(withCell(lines[row.at], 5, cellFor(row)));
		}
		if (target.has(at)) continue;
		out.push(lines[at]);
	}
	return out.join("\n");
}

// ---------------------------------------------------------------------------
// Fact files — pure text readers, so the offline path is testable without a subprocess.
// ---------------------------------------------------------------------------

/**
 * `parseStates(text, ids)` → `Map<string, "OPEN"|"CLOSED"|"MISSING">`
 *
 * Exactly the ids the checked window references: a missing id, an extra id, an invalid value, a duplicate
 * key or a wrong version is exit 2. Duplicate detection scans the raw text because `JSON.parse` silently
 * keeps the last of two identical keys — a duplicate here would otherwise be an invisible override.
 */
export function parseStates(text, ids = []) {
	let payload;
	try {
		payload = JSON.parse(String(text));
	} catch (error) {
		throw new InputError(`states file is not JSON: ${describeError(error)}`);
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new InputError("states file must be a JSON object");
	if (payload.version !== 1) throw new InputError(`states file: version must be 1 (got ${JSON.stringify(payload.version)})`);
	if (!payload.states || typeof payload.states !== "object" || Array.isArray(payload.states)) {
		throw new InputError("states file: states must be an object of id → state");
	}
	const seen = new Set();
	for (const match of String(text).matchAll(/"([0-9]+)"\s*:/g)) {
		if (seen.has(match[1])) throw new InputError(`states file has a duplicate id "${match[1]}" — a duplicate key is an invisible override`);
		seen.add(match[1]);
	}
	const expected = new Set(ids.map(String));
	for (const id of expected) {
		if (!(id in payload.states)) throw new InputError(`states file: missing #${id}, which this cycle references`);
	}
	const states = new Map();
	for (const [key, value] of Object.entries(payload.states)) {
		if (!/^[0-9]+$/.test(key)) throw new InputError(`states file: id "${key}" is not a decimal issue number`);
		if (!STATES.includes(value)) {
			throw new InputError(`states file: #${key} has "${value}" — must be OPEN, CLOSED or MISSING`);
		}
		if (!expected.has(key)) throw new InputError(`states file: #${key} is not referenced by this cycle (referenced: ${[...expected].join(", ") || "none"})`);
		states.set(key, value);
	}
	return states;
}

/** The producer's five kinds (#574) and a retry's two provenances — one source for both the guard and its message. */
export const CANDIDATE_KINDS = ["failed", "deadline", "retry", "stop", "steer"];
export const CANDIDATE_VIAS = ["transport", "explicit"];

/**
 * `parseCandidates(text)` → the parsed file, or exit 2. Shape only: a candidate's CONTENT judgement
 * (class or dismissal, claimedLive) lives in `check`, where it is a ledger defect (exit 1), not an
 * unreadable input.
 */
export function parseCandidates(text, cycle) {
	let payload;
	try {
		payload = JSON.parse(String(text));
	} catch (error) {
		throw new InputError(`candidates file is not JSON: ${describeError(error)}`);
	}
	if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new InputError("candidates file must be a JSON object");
	if (payload.version !== 1) throw new InputError(`candidates file: version must be 1 (got ${JSON.stringify(payload.version)})`);
	if (payload.cycle !== cycle) throw new InputError(`candidates file names cycle "${payload.cycle}", not "${cycle}"`);
	if (!Array.isArray(payload.candidates)) throw new InputError("candidates file: candidates must be an array");
	const seen = new Set();
	for (const [at, entry] of payload.candidates.entries()) {
		const where = `candidates[${at}]`;
		if (!entry || typeof entry !== "object") throw new InputError(`${where}: must be an object`);
		if (typeof entry.eventId !== "string" || entry.eventId === "") throw new InputError(`${where}: eventId must be a non-empty string`);
		if (seen.has(entry.eventId)) throw new InputError(`candidates[${at}]: duplicate eventId "${entry.eventId}" — identity is the event, not the class`);
		seen.add(entry.eventId);
		if (!CANDIDATE_KINDS.includes(entry.kind)) {
			throw new InputError(`${where}: kind "${entry.kind}" must be one of ${CANDIDATE_KINDS.join(", ")}`);
		}
		if (entry.via !== undefined) {
			// `via` is a retry's provenance and nothing else's: it says WHICH mechanism re-spawned the
			// run, so on a failed run or a stop it has no meaning to validate — it is a producer bug.
			if (entry.kind !== "retry") {
				throw new InputError(`${where}: via "${entry.via}" is only meaningful on a retry (kind "${entry.kind}")`, "candidate-via-kind");
			}
			if (!CANDIDATE_VIAS.includes(entry.via)) {
				throw new InputError(`${where}: via "${entry.via}" must be ${CANDIDATE_VIAS.join(" or ")}`, "candidate-via-kind");
			}
		}
		if (typeof entry.ts !== "string" || Number.isNaN(Date.parse(entry.ts))) throw new InputError(`${where}: ts "${entry.ts}" is not a real ISO instant`);
		if (!Number.isInteger(entry.count) || entry.count <= 0) throw new InputError(`${where}: count must be a positive integer`);
	}
	return { version: payload.version, cycle: payload.cycle, claimedLive: payload.claimedLive === true, candidates: payload.candidates };
}

// ---------------------------------------------------------------------------
// Citations (#533) — a cited candidate names a source line whose bytes must still hash to its digest.
// The grammar and the file search live here; the DECISION lives in `check`, which never touches fs.
// ---------------------------------------------------------------------------

/** §1.1's grammar, in one place: prefix, basename (no separator), line. */
const SOURCE_RE = /^(session-log|spawn-log):([A-Za-z0-9._-]+):([1-9][0-9]*)$/;
const DIGEST_RE = /^[0-9a-f]{16}$/;
/**
 * `src/logging.ts` keeps the live file plus FOUR backups (it unlinks `.4` and shifts `.3`→`.4`); `.5` is
 * searched only in case an older install left one.
 */
const BACKUP_COUNT = 5;

/** The one status that needs no problem: the cited line resolved. */
export const RESOLVED = "ok";

/**
 * A citation status → its `stats.candidates` bucket (§1.4) and its exit. One table, so a status can
 * never gain a count nobody prints or an exit nobody returns.
 */
const CITATION = Object.freeze({
	"stale-source": { bucket: "staleSource", exit: 1 },
	"unresolvable-source": { bucket: "unresolvable", exit: 1 },
	"missing-line": { bucket: "missingLine", exit: 1 },
	"missing-digest": { bucket: "missingDigest", exit: 1 },
	"invalid-source": { bucket: "invalidInput", exit: 2 },
	"invalid-digest": { bucket: "invalidInput", exit: 2 },
	"source-unreadable": { bucket: "sourceUnreadable", exit: 2 },
});

/** `stats.candidates`' resolution keys, in the order the CLI prints them. */
export const RESOLUTION_KEYS = Object.freeze([
	"resolved",
	"staleSource",
	"unresolvable",
	"missingLine",
	"missingDigest",
	"invalidInput",
	"sourceUnreadable",
]);

/**
 * `parseSource(source)` → `{prefix, basename, line}` or `null`.
 *
 * Strict on purpose (§1.1): `1e3`, `abc`, `0`, `-1`, `007` and an overflow are all `null`, never a best
 * guess. `Number.isSafeInteger` is what refuses the overflow — `[1-9][0-9]*` alone would accept
 * `9007199254740992` and silently read a different line.
 */
export function parseSource(source) {
	const match = typeof source === "string" ? SOURCE_RE.exec(source) : null;
	if (!match) return null;
	const line = Number(match[3]);
	if (!Number.isSafeInteger(line)) return null;
	return { prefix: match[1], basename: match[2], line };
}

/** §1.2 step 1: `brl-subagent.log.3` → `brl-subagent.log`, so a rotated citation searches its family. */
export function stemOf(basename) {
	return String(basename).replace(/\.[0-9]+$/, "");
}

/** §1.2 step 2: the live name and its four rotations (plus `.5`) — one list, so search and message agree. */
export function familyNames(stem) {
	const names = [stem];
	for (let n = 1; n <= BACKUP_COUNT; n++) names.push(`${stem}.${n}`);
	return names;
}

/** Trailing CR/LF, stripped from the END only — Python's `bytes.rstrip(b"\r\n")`, byte for byte. */
function stripTrailingNewlines(buffer) {
	let end = buffer.length;
	while (end > 0 && (buffer[end - 1] === 0x0d || buffer[end - 1] === 0x0a)) end--;
	return buffer.subarray(0, end);
}

/**
 * `lineDigest(raw)` — the first 16 hex of the line's sha256, computed over the RAW BYTES with trailing
 * CR/LF stripped: the generator's `_line_digest` in Python (`sprint-metrics.py`). Bytes, not text, so a
 * CRLF line and an invalid-UTF-8 line hash the same on both sides of the contract.
 */
export function lineDigest(raw) {
	return createHash("sha256").update(stripTrailingNewlines(raw)).digest("hex").slice(0, 16);
}

/**
 * Line `lineNo` (1-based) of a file's bytes, or `null` when the file is shorter.
 *
 * Splits on `\n` exactly as Python's binary line iteration does — a trailing newline still yields a
 * final empty line, which is why the digest of the last line and of an empty tail cannot be confused.
 */
function lineAt(body, lineNo) {
	let start = 0;
	let index = 1;
	for (let at = 0; at <= body.length; at++) {
		if (at !== body.length && body[at] !== 0x0a) continue;
		if (index === lineNo) return body.subarray(start, at);
		index += 1;
		start = at + 1;
	}
	return null;
}

/** The family a citation searched, named for a refusal: `brl-subagent.log, brl-subagent.log.1..5`. */
function familyLabel(source) {
	const parsed = parseSource(source);
	if (!parsed) return `source ${JSON.stringify(source)}`;
	const stem = stemOf(parsed.basename);
	return `family ${stem}, ${stem}.1..${stem}.${BACKUP_COUNT}`;
}

/**
 * `resolveCandidates(candidates, roots)` → `{eventId: {status, tried[]}}` — the CLI's I/O half (§1.2).
 *
 * Every root is listed ONCE, and a root that cannot be listed fails closed for every candidate that
 * would search it: an incomplete search must never read as a match or as absence (§1.3, first row).
 * `tried` holds the paths examined, bytewise ascending, except when the status is `source-unreadable` —
 * then it names the path(s) that could not be listed or read.
 *
 * A dismissed candidate is exempt and gets no record; neither does one with neither a class nor a
 * dismissal (the seam already names that defect, and resolving it would double-report).
 */
export function resolveCandidates(candidates, roots) {
	const list = Array.isArray(candidates?.candidates) ? candidates.candidates : [];
	const resolutions = {};
	const listings = [];
	for (const root of roots) {
		try {
			listings.push({ root, names: new Set(readdirSync(root)), error: null });
		} catch (error) {
			listings.push({ root, names: null, error: describeError(error) });
		}
	}
	const parentHint = sessionStoreParentHint(listings);
	for (const entry of list) {
		const { eventId, hasClass, hasDismissal } = candidateShape(entry);
		if (!hasClass || hasDismissal) continue;
		const resolution = resolveOne(entry, listings);
		// Only an absence can be a wrong root. A match, a stale hash or an unreadable search already
		// says what it means: the root found the family, so no parent hint applies (#578).
		if (resolution.status === "unresolvable-source" && parentHint !== null) resolution.hint = parentHint;
		resolutions[eventId] = resolution;
	}
	return resolutions;
}

/**
 * #578: the session store is project-scoped, so `~/.pi/agent/sessions` holds one `--<escaped-path>--`
 * directory per project and no `.jsonl` of its own. Searching that parent finds nothing, and the refusal
 * then blames the evidence ("the evidence is retired") when the root is simply one level too high. Name
 * it, but only when the shape is unmistakable: no session file at this level, and project-store names.
 */
export function sessionStoreParentHint(listings) {
	for (const listing of listings) {
		if (listing.error !== null || !(listing.names instanceof Set)) continue;
		const names = [...listing.names];
		const holdsSessions = names.some((name) => name.endsWith(".jsonl"));
		const holdsProjectStores = names.some((name) => name.startsWith("--") && name.endsWith("--"));
		if (!holdsSessions && holdsProjectStores) {
			return `${listing.root} holds per-project session stores, not session files — pass the project's own directory under it (--<project-path-with-slashes-as-dashes>--), not its parent (see the close protocol)`;
		}
	}
	return null;
}

/** One cited candidate's status. The order of the branches IS §1.3's precedence, fail-closed first. */
function resolveOne(entry, listings) {
	const failed = listings.filter((listing) => listing.error !== null).map((listing) => listing.root);
	if (failed.length > 0) return { status: "source-unreadable", tried: failed.sort(compareClasses) };

	const source = entry?.source;
	const parsed = parseSource(source);
	if (!parsed) return { status: "invalid-source", tried: [] };
	// Only an absent key is missing. `""` is a PRESENT, malformed digest and goes through the grammar
	// below to `invalid-digest` — a candidate that names an empty digest has malformed evidence.
	if (entry.digest === undefined || entry.digest === null) {
		return { status: "missing-digest", tried: [] };
	}
	if (typeof entry.digest !== "string" || !DIGEST_RE.test(entry.digest)) return { status: "invalid-digest", tried: [] };

	const names = new Set(familyNames(stemOf(parsed.basename)));
	const candidates = [];
	for (const listing of listings) {
		for (const name of listing.names) if (names.has(name)) candidates.push(join(listing.root, name));
	}
	const files = [];
	for (const path of candidates.sort(compareClasses)) {
		let stat;
		try {
			stat = statSync(path);
		} catch (error) {
			// ENOENT means there is no file here to read — a broken symlink resolves to no regular file,
			// exactly like a directory, so it is not a candidate for the family (§1.2 step 2). Every other
			// stat error (EACCES, ELOOP, ENOTDIR…) is an incomplete search and fails closed.
			if (error?.code === "ENOENT") continue;
			return { status: "source-unreadable", tried: [path] };
		}
		// A symlink is followed (statSync) only when it resolves to a regular file; a directory is not a file.
		if (stat.isFile()) files.push(path);
	}
	if (files.length === 0) return { status: "unresolvable-source", tried: [] };

	// Every collected file is READ before the verdict, even after a match: a close must not pass on a
	// partial search, so an unreadable later family file turns a would-be pass into `source-unreadable`.
	// Reading more than the match needs is the correct trade (§1.3/G2).
	const tried = [];
	const unreadable = [];
	let sawLine = false;
	let matched = false;
	for (const path of files) {
		let body;
		try {
			body = readFileSync(path);
		} catch (error) {
			unreadable.push(path);
			continue;
		}
		tried.push(path);
		const line = lineAt(body, parsed.line);
		if (line === null) continue;
		sawLine = true;
		if (lineDigest(line) === entry.digest) matched = true;
	}
	if (unreadable.length > 0) return { status: "source-unreadable", tried: unreadable.sort(compareClasses) };
	if (matched) return { status: RESOLVED, tried };
	return { status: sawLine ? "stale-source" : "missing-line", tried };
}

/**
 * One candidate's disposition shape — the single reader of "cited" versus "dismissed".
 *
 * The seam and the resolver must agree on which candidates are cited: if they each decided, a dismissed
 * candidate could be exempted by one and resolved by the other, and the exemption would be a fiction.
 */
function candidateShape(entry) {
	const eventId = typeof entry?.eventId === "string" ? entry.eventId : JSON.stringify(entry?.eventId);
	const hasClass = entry?.class !== null && entry?.class !== undefined;
	const hasDismissal = typeof entry?.dismissed === "string" && entry.dismissed.trim() !== "";
	return { eventId, hasClass, hasDismissal };
}

// ---------------------------------------------------------------------------
// CLI — argument parsing, facts, and the atomic conditional render. All I/O lives here.
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
	const args = {
		mode: null,
		cycle: null,
		close: false,
		ledger: DEFAULT_LEDGER,
		log: DEFAULT_LOG,
		states: null,
		candidates: null,
		sourceRoots: [],
	};
	const modes = [];
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i];
		const value = () => {
			const next = argv[++i];
			if (next === undefined || next.startsWith("--")) throw new InputError(`${flag} needs a value`);
			return next;
		};
		if (flag === "--check") modes.push("check");
		else if (flag === "--history") modes.push("history");
		else if (flag === "--render") modes.push("render");
		else if (flag === "--close") args.close = true;
		else if (flag === "--cycle") args.cycle = value();
		else if (flag === "--ledger") args.ledger = value();
		else if (flag === "--log") args.log = value();
		else if (flag === "--states") args.states = value();
		else if (flag === "--candidates") args.candidates = value();
		else if (flag === "--source-root") args.sourceRoots.push(value());
		else if (flag === "--help" || flag === "-h") args.mode = "help";
		else throw new InputError(`unknown argument "${flag}"`);
	}
	if (args.mode === "help") return args;
	if (modes.length === 0) throw new InputError(`no mode given — one of --check, --render or --history is required`);
	if (modes.length > 1) throw new InputError(`modes are exclusive — got ${modes.map((mode) => `--${mode}`).join(", ")}`);
	args.mode = modes[0] === "history" ? "check" : modes[0];
	if (!args.cycle) throw new InputError("--cycle <name> is required");
	if (args.mode === "check" && modes[0] === "history" && args.close) {
		throw new InputError("--history is the plain check under its older name and cannot take --close — use --check --close for the closing gate");
	}
	if (args.mode === "render") {
		if (args.close) throw new InputError("--close belongs to --check; --render takes --cycle, --ledger and --states");
		if (args.candidates) throw new InputError("--candidates belongs to --check; --render only refreshes issue cells");
		if (args.sourceRoots.length > 0) throw new InputError("--source-root belongs to --check; --render only refreshes issue cells");
		if (args.log !== DEFAULT_LOG) throw new InputError("--log belongs to --check; --render reads only the ledger");
	}
	if (args.sourceRoots.length > 0 && !args.candidates) {
		throw new InputError("--source-root resolves the citations of --candidates; give --candidates too");
	}
	return args;
}

/** A stub-able `gh`: one call per id, 20 s, no retry, and the four discriminators stated in the header. */
function resolveLiveStates(ids, { spawn = spawnSync } = {}) {
	const states = new Map();
	for (const id of ids) {
		const result = spawn("gh", ["issue", "view", String(id), "--json", "number,state"], {
			encoding: "utf8",
			timeout: 20_000,
		});
		if (result.error) {
			throw new InputError(`cannot resolve #${id}: ${result.error.message} — UNAVAILABLE (a permission-hidden issue is indistinguishable from a missing one; failing closed)`);
		}
		const stderr = String(result.stderr ?? "");
		if (result.status === 1 && /Could not resolve to an issue/.test(stderr)) {
			states.set(String(id), "MISSING");
			continue;
		}
		if (result.status !== 0) {
			throw new InputError(
				`cannot resolve #${id}: gh exited ${result.status} — UNAVAILABLE (a permission-hidden issue is indistinguishable from a missing one; failing closed): ${stderr.trim().split("\n")[0]}`,
			);
		}
		let payload;
		try {
			payload = JSON.parse(String(result.stdout));
		} catch {
			throw new InputError(`cannot resolve #${id}: gh returned malformed JSON — UNAVAILABLE`);
		}
		if (Number(payload?.number) !== id) {
			throw new InputError(`cannot resolve #${id}: gh answered #${payload?.number} — UNAVAILABLE`);
		}
		if (payload.state !== "OPEN" && payload.state !== "CLOSED") {
			throw new InputError(`cannot resolve #${id}: gh answered state "${payload.state}" — UNAVAILABLE (expected OPEN or CLOSED)`);
		}
		states.set(String(id), payload.state);
	}
	return states;
}

/** The repo-side facts: a real commit, and a heading read literally (trimmed, never a regex). */
export function createRepoFacts(root, states) {
	return {
		states,
		commitExists(sha) {
			const result = spawnSync("git", ["cat-file", "-e", `${sha}^{commit}`], { cwd: root, encoding: "utf8" });
			return result.status === 0;
		},
		docHasHeading(path, heading) {
			const target = resolve(root, path);
			if (!existsSync(target)) return false;
			let text;
			try {
				text = readFileSync(target, "utf8");
			} catch {
				return false;
			}
			return text.split("\n").some((line) => {
				const match = HEADING_RE.exec(line);
				return match !== null && match[1].trim() === heading;
			});
		},
	};
}

/** A file argument: absolute stays absolute, relative resolves against the caller's cwd. */
function fileArg(path) {
	return isAbsolute(path) ? path : resolve(process.cwd(), path);
}

/** Read and parse the ledger. */
function readLedger(args) {
	const ledgerPath = fileArg(args.ledger);
	let text;
	try {
		text = readFileSync(ledgerPath, "utf8");
	} catch (error) {
		throw new InputError(`cannot read ledger ${ledgerPath}: ${describeError(error)}`);
	}
	return { ledger: parseLedger(text), ledgerPath, text };
}

/**
 * The state facts for one cycle: the injected file when `--states` is given, else one `gh` call per id.
 * Zero referenced ids means no network at all — an evidence-only window must check offline.
 */
function resolveStates(args, ids, { spawn = spawnSync } = {}) {
	if (args.states) {
		const path = fileArg(args.states);
		let statesText;
		try {
			statesText = readFileSync(path, "utf8");
		} catch (error) {
			throw new InputError(`cannot read states file ${path}: ${describeError(error)}`);
		}
		return parseStates(statesText, ids);
	}
	return ids.length === 0 ? new Map() : resolveLiveStates(ids, { spawn });
}

function sha256(text) {
	return createHash("sha256").update(text).digest("hex");
}

/**
 * The conditional, atomic render. Read+hash → build → re-read+hash: a hash that moved between the two
 * reads means another writer touched the ledger, so the build is thrown away and retried ONCE; a second
 * movement is exit 2. A symlink is refused rather than followed — the rename would otherwise replace the
 * link and leave the real ledger behind, which looks like a successful render and is a lost update.
 */
function renderFile({ ledgerPath, cycle, facts }) {
	for (let attempt = 0; attempt < 2; attempt++) {
		let before;
		try {
			if (lstatSync(ledgerPath).isSymbolicLink()) {
				throw new InputError(`refusing to render through a symlink: ${ledgerPath} (rename would replace the link, not the ledger)`);
			}
			before = readFileSync(ledgerPath, "utf8");
		} catch (error) {
			if (error instanceof InputError) throw error;
			throw new InputError(`cannot read ledger ${ledgerPath}: ${describeError(error)}`);
		}
		const hashBefore = sha256(before);
		const ledger = parseLedger(before);
		const next = renderCycle(ledger, cycle, facts);
		let again;
		try {
			again = readFileSync(ledgerPath, "utf8");
		} catch (error) {
			throw new InputError(`cannot re-read ledger ${ledgerPath}: ${describeError(error)}`);
		}
		if (sha256(again) !== hashBefore) {
			if (attempt === 0) continue;
			throw new InputError("ledger changed during render; re-run");
		}
		const changed = countChangedLines(before, next);
		if (next !== before) writeAtomic(ledgerPath, next);
		return { changed };
	}
	throw new InputError("ledger changed during render; re-run");
}

function countChangedLines(before, next) {
	const a = before.split("\n");
	const b = next.split("\n");
	if (a.length !== b.length) return Math.max(a.length, b.length);
	let changed = 0;
	for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) changed += 1;
	return changed;
}

/** Temp file in the same directory, fsync, mode preserved, rename, fsync the directory. One writer. */
function writeAtomic(path, text) {
	const directory = dirname(path);
	let mode = 0o644;
	try {
		mode = statSync(path).mode & 0o777;
	} catch {
		// A brand-new ledger is 0644; an existing one keeps its mode.
	}
	const temp = join(directory, `.friction-disposition.${process.pid}.${randomBytes(6).toString("hex")}.tmp`);
	const fd = openSync(temp, "wx", mode);
	try {
		writeFileSync(fd, text);
		fsyncSync(fd);
	} finally {
		closeSync(fd);
	}
	renameSync(temp, path);
	const directoryFd = openSync(directory, "r");
	try {
		fsyncSync(directoryFd);
	} finally {
		closeSync(directoryFd);
	}
}

/**
 * The candidate counts — printed on SUCCESS and, when a resolution pass ran, on FAILURE too (§1.4): a
 * close that is failing because of citations must be able to see them without re-running. Without
 * `--source-root` there are no resolution fields, and nothing extra is printed (the byte-identical
 * compatibility contract, §1.5).
 */
const RESOLUTION_LABELS = Object.freeze({
	resolved: "resolved",
	staleSource: "stale-source",
	unresolvable: "unresolvable",
	missingLine: "missing-line",
	missingDigest: "missing-digest",
	invalidInput: "invalid",
	sourceUnreadable: "source-unreadable",
});

function printCandidates(stats, out) {
	const candidates = stats.candidates;
	if (!candidates) return;
	out(
		candidates.total === 0 && candidates.claimedLive === false
			? "candidates: 0 (declared not live)"
			: `candidates: ${candidates.total} (cited ${candidates.cited}, dismissed ${candidates.dismissed})`,
	);
	if (typeof candidates.resolved !== "number") return;
	out(`resolutions: ${RESOLUTION_KEYS.map((key) => `${candidates[key]} ${RESOLUTION_LABELS[key]}`).join(", ")}`);
}

function printStats(stats, out) {
	out(`✓ ${stats.cycle}: window ${stats.window.from}..${stats.window.to}`);
	out(`records: ${stats.records}`);
	out(`legacy: ${stats.legacy}`);
	out(`coverage: ${stats.assignedRows}/${stats.frictionRows} friction rows assigned, ${stats.classes} classes`);
	const facts = stats.facts;
	out(`facts: ${facts.ids.length} id(s) (OPEN ${facts.open}, CLOSED ${facts.closed}, MISSING ${facts.missing})`);
	printCandidates(stats, out);
}

/**
 * `main(argv, {out, err, spawn})` → exit code. The injectable `spawn` exists for the stub-`gh` boundary
 * tests; production passes nothing and reaches `spawnSync`.
 */
export function main(argv, { out = (line) => process.stdout.write(`${line}\n`), err = (line) => process.stderr.write(`${line}\n`), spawn = spawnSync } = {}) {
	let args;
	try {
		args = parseArgs(argv);
	} catch (error) {
		err(`✗ ${describeError(error)}`);
		err(USAGE);
		return EXIT.CANNOT_CHECK;
	}
	if (args.mode === "help") {
		out(USAGE);
		return EXIT.OK;
	}
	try {
		const { ledger, ledgerPath } = readLedger(args);
		const ids = requiredIds(ledger, args.cycle);
		const facts = createRepoFacts(ROOT, resolveStates(args, ids, { spawn }));
		if (args.mode === "render") {
			const { changed } = renderFile({ ledgerPath, cycle: args.cycle, facts });
			out(`✓ rendered ${args.cycle}: ${ids.length} referenced id(s), ${changed} line(s) changed`);
			return EXIT.OK;
		}

		const logPath = fileArg(args.log);
		let logText;
		try {
			logText = readFileSync(logPath, "utf8");
		} catch (error) {
			throw new InputError(`cannot read log ${logPath}: ${describeError(error)}`);
		}
		const candidates = readCandidates(args);
		// Resolution is the ONLY new I/O, and it is opt-in: no `--source-root` means no map, no problems,
		// and output byte-identical to the pre-#533 tool (§1.5).
		const sourceRoots = args.sourceRoots.map(fileArg);
		const resolutions = candidates && sourceRoots.length > 0 ? resolveCandidates(candidates, sourceRoots) : null;
		const { problems, stats } = check({ ledger, log: parseLog(logText), cycle: args.cycle, facts, close: args.close, candidates, resolutions });
		if (problems.length === 0) {
			printStats(stats, out);
			return EXIT.OK;
		}
		for (const entry of problems) err(`✗ ${entry.message}`);
		// §1.4: the counts print on failure too — but only when a resolution pass ran, which is what
		// keeps the no-`--source-root` output identical to the old head (§1.5).
		if (resolutions) printCandidates(stats, out);
		return problems.some((entry) => entry.exit === 2) ? EXIT.CANNOT_CHECK : EXIT.LEDGER;
	} catch (error) {
		if (error instanceof InputError) {
			err(`✗ ${error.message}`);
			return EXIT.CANNOT_CHECK;
		}
		err(`✗ ${describeError(error)}`);
		return EXIT.CANNOT_CHECK;
	}
}

function readCandidates(args) {
	if (!args.candidates) return null;
	const path = fileArg(args.candidates);
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new InputError(`cannot read candidates file ${path}: ${describeError(error)}`);
	}
	return parseCandidates(text, args.cycle);
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

const invokedDirectly = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
	process.exitCode = main(process.argv.slice(2));
}

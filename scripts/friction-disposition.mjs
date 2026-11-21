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
// last window AND that window's `to` to equal the log's last friction index. `--check --cycle <name>`
// without `--close` audits one window while later rows exist — that is how the seed (an earlier cycle) is
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
//   • The candidates file (#533's seam) is provisional: this unit refuses to lose an event's identity or
//     a dismissal, nothing more.
//
//   node scripts/friction-disposition.mjs --check --cycle <name> [--close] [--ledger <p>] [--log <p>]
//                                         [--states <file>] [--candidates <file>]
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
	"usage: friction-disposition.mjs --check --cycle <name> [--close] [--ledger <p>] [--log <p>] [--states <file>] [--candidates <file>]\n" +
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
	constructor(message) {
		super(message);
		this.name = "InputError";
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
		// The class is rendered as a backticked code span (§1.4); the NAME is what the regex governs. A bare
		// name is accepted too — the code span is a rendering choice, not a second identity.
		const className = /^`([^`]+)`$/.exec(classCell)?.[1] ?? classCell;
		if (!CLASS_RE.test(className)) {
			throw new InputError(`dispositions line ${row.line}: class "${classCell}" must match ^[a-z0-9][a-z0-9-]*$ (rendered as a backticked code span)`);
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

/** A window that ends past the log's last data row claims an index that names nothing. */
function checkWindowBounds({ log, window, cycle }, problems) {
	const lastIndex = log.rows[log.rows.length - 1].index;
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
 * close mode binds `--cycle` to the last window and its `to` to the log's last friction index, so a
 * fresh friction row cannot be left for "the next cycle" at the close it belongs to.
 */
function checkClosingGate({ log, ledger, window, cycle }, problems) {
	const last = ledger.windows[ledger.windows.length - 1];
	if (last.cycle !== cycle) {
		problems.push(problem("not-closing-cycle", `not the closing cycle (last: ${last.cycle})`, 1));
		return;
	}
	let lastFriction = 0;
	for (const row of log.rows) if (!row.record) lastFriction = row.index;
	if (window.to < lastFriction) {
		problems.push(
			problem("unassigned-close", `log has rows ${window.to + 1}..${lastFriction} unassigned — re-declare at close`, 1),
		);
	} else if (window.to > lastFriction) {
		problems.push(
			problem(
				"window-past-friction",
				`window "${cycle}" ends at ${window.to} but the log's last friction row is ${lastFriction} — a window cannot claim close records or absent rows`,
				1,
			),
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
 * #533's provisional seam: refuse to lose an event's identity or a dismissal, nothing more. Two
 * candidates may share a class — identity is the `eventId` — and an empty live cycle must say so.
 */
function checkCandidateSeam({ ledger, candidates }, problems, stats) {
	const list = Array.isArray(candidates.candidates) ? candidates.candidates : [];
	const ledgerClasses = new Set(ledger.dispositions.map((entry) => entry.class));
	let cited = 0;
	let dismissed = 0;
	if (candidates.claimedLive === true && list.length === 0) {
		problems.push(
			problem(
				"claimed-live-empty",
				"candidates: claimedLive is true but the file carries no candidates — a live cycle that logged nothing says claimedLive: false",
				1,
			),
		);
	}
	for (const entry of list) {
		const eventId = typeof entry?.eventId === "string" ? entry.eventId : JSON.stringify(entry?.eventId);
		const hasClass = entry?.class !== null && entry?.class !== undefined;
		const hasDismissal = typeof entry?.dismissed === "string" && entry.dismissed.trim() !== "";
		if (hasClass && hasDismissal) {
			problems.push(problem("candidate-both", `candidate ${eventId}: name a class or a dismissal, not both`, 1));
		} else if (!hasClass && !hasDismissal) {
			problems.push(
				problem(
					"candidate-neither",
					`candidate ${eventId}: neither a class nor a dismissal — an event without a disposition is the gap this seam exists to refuse`,
					1,
				),
			);
		} else if (hasClass) {
			if (!ledgerClasses.has(entry.class)) {
				problems.push(problem("candidate-unknown-class", `candidate ${eventId}: class "${entry.class}" is not in the ledger`, 1));
			}
			cited += 1;
		} else {
			dismissed += 1;
		}
	}
	stats.candidates = { total: list.length, cited, dismissed, claimedLive: candidates.claimedLive === true };
}

/**
 * `check({ledger, log, cycle, facts, close, candidates}) → {problems, stats}`
 *
 * `ledger` / `log` are the parsed objects from `parseLedger` / `parseLog`. Each problem is
 * `{code, message, exit}`; the exit is 2 whenever any input could not be read confidently, so a caller's
 * exit code is `problems.some(p => p.exit === 2) ? 2 : problems.length ? 1 : 0`.
 */
export function check({ ledger, log, cycle, facts, close = false, candidates = null }) {
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
	if (candidates) checkCandidateSeam({ ledger, candidates }, problems, stats);

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
		if (!["failed", "retry", "stop", "steer"].includes(entry.kind)) {
			throw new InputError(`${where}: kind "${entry.kind}" must be failed, retry, stop or steer`);
		}
		if (typeof entry.ts !== "string" || Number.isNaN(Date.parse(entry.ts))) throw new InputError(`${where}: ts "${entry.ts}" is not a real ISO instant`);
		if (!Number.isInteger(entry.count) || entry.count <= 0) throw new InputError(`${where}: count must be a positive integer`);
	}
	return { version: payload.version, cycle: payload.cycle, claimedLive: payload.claimedLive === true, candidates: payload.candidates };
}

// ---------------------------------------------------------------------------
// CLI — argument parsing, facts, and the atomic conditional render. All I/O lives here.
// ---------------------------------------------------------------------------

export function parseArgs(argv) {
	const args = { mode: null, cycle: null, close: false, ledger: DEFAULT_LEDGER, log: DEFAULT_LOG, states: null, candidates: null };
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
		if (args.log !== DEFAULT_LOG) throw new InputError("--log belongs to --check; --render reads only the ledger");
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

function printStats(stats, out) {
	out(`✓ ${stats.cycle}: window ${stats.window.from}..${stats.window.to}`);
	out(`records: ${stats.records}`);
	out(`legacy: ${stats.legacy}`);
	out(`coverage: ${stats.assignedRows}/${stats.frictionRows} friction rows assigned, ${stats.classes} classes`);
	const facts = stats.facts;
	out(`facts: ${facts.ids.length} id(s) (OPEN ${facts.open}, CLOSED ${facts.closed}, MISSING ${facts.missing})`);
	if (stats.candidates) {
		const summary =
			stats.candidates.total === 0 && stats.candidates.claimedLive === false
				? "candidates: 0 (declared not live)"
				: `candidates: ${stats.candidates.total} (cited ${stats.candidates.cited}, dismissed ${stats.candidates.dismissed})`;
		out(summary);
	}
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
		const { problems, stats } = check({ ledger, log: parseLog(logText), cycle: args.cycle, facts, close: args.close, candidates });
		if (problems.length === 0) {
			printStats(stats, out);
			return EXIT.OK;
		}
		for (const entry of problems) err(`✗ ${entry.message}`);
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

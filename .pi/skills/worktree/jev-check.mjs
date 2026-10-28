#!/usr/bin/env node
// Purpose: makes the Rule 22 Jev ritual checkable — the dispatch line and the ledger audit (issue #366).
//
// Rule 22 (strict Jev) was skipped twice (2026-10-13, 2026-10-23) while the classifier was available
// the whole time: the gap was a memory item, not a tool. The query itself stays in `codemode` (the
// provider/auth wiring is host-side, so a standalone script cannot run it reliably), so the mechanical
// gate goes on the ARTIFACT every dispatch already records — the `jev: level (confidence) · risk Cx ·
// worktree y` line in the spec/dispatch and the row in the calibration log. A skipped query shows up
// as a BARE LEVEL (no confidence) or a missing line; both are checkable here, and in CI.
//
// Modes:
//   --line '<classifier-json>'  validate {level, conf, risk, worktree} and print the exact dispatch
//                               line. A missing/invalid confidence is rejected (exit 1) — that is the
//                               skipped form this check exists to kill.
//   --ledger [path]             audit the calibration log (default below): every row dated on/after
//                               STRICT_JEV_CUTOFF must carry a confidence `(0.xx)` in the Jev cell OR
//                               an explicit gap marker. Offenders print date + dispatch + cell, exit 1.
//                               Zero parsed rows is a hard error (exit 2) — never a silent pass.
//   --log [path] [--since D]    audit the DISPATCH ARTIFACT: the JSONL subagent log (default
//                               below) records every `Background agent spawned` event with its
//                               task payload. Every such event dated on/after STRICT_DISPATCH_CUTOFF
//                               (or `--since`) must carry a valid Rule-22 line in `data.task`;
//                               offenders print timestamp + task head + reason, exit 1. Zero parsed
//                               dispatch events is a hard error (exit 2) — never a silent pass.
//                               This is the check `--ledger` structurally cannot be: ledger rows are
//                               written AFTER a dispatch closes, so a skipped pre-dispatch query still
//                               passes the ledger. CONDUCTOR/MERGE-TIME ONLY — the log lives under the
//                               local `.pi/` (gitignored), so it is NOT CI-visible; CI keeps running
//                               `--selftest` + `--ledger`.
//   --selftest                  fixture proof of every mode (CI-wired), deterministic, no network.
//
// CI:
//   node .pi/skills/worktree/jev-check.mjs --selftest
//   node .pi/skills/worktree/jev-check.mjs --ledger .development/investigations/jev-calibration-log.md
import { readFileSync } from "node:fs";

// ---------------------------------------------------------------------------
// Policy — the vocabulary Rule 22 and the ledger speak.
// ---------------------------------------------------------------------------

/** Thinking levels the classifier answers with, low → high. */
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

/** Risk classes (SKILL.md's C1/C2/C3 table). */
const RISKS = ["C1", "C2", "C3"];

/** Strict Jev was ratified on this date; rows from here on must carry a confidence. */
const STRICT_JEV_CUTOFF = "2026-10-12";

/**
 * The dispatch-artifact cutoff (2026-10-28). Dispatch events before this date are grandfathered —
 * the log is a historical record and is never edited. From here on every `Background agent spawned`
 * task must carry the Rule-22 line: the 2026-10-13 / 2026-10-23 / 2026-10-27 skips all show up here.
 */
const STRICT_DISPATCH_CUTOFF = "2026-10-28";

/** The exact form a dispatch task must carry (Rule 22) — quoted verbatim in every failure. */
const REQUIRED_DISPATCH_FORM = "jev: <level> (<0.xx>) · C<1|2|3> · worktree <y|n>";

/** Default subagent log (repo-root relative; run from the repo/cockpit root). */
const DEFAULT_SUBAGENT_LOG = ".pi/subagent-logs/brl-subagent.log";

/** The one spawn event that carries the dispatch payload (the `warn` variants duplicate it). */
const DISPATCH_EVENT_MESSAGE = "Background agent spawned";

/** Explicit "the classifier did not run" markers — recorded, not silent (Rule 22). */
const GAP_MARKERS = ["unavailable", "not classified", "n/a", "ritual gap"];

/** A confidence in the Jev cell: any decimal with a leading digit (0.84, 1.0) — `.5` is not matched. */
const CONFIDENCE_IN_CELL = /\d\.\d/;

const DEFAULT_LEDGER = ".development/investigations/jev-calibration-log.md";

/** Ledger table: `| Date | Dispatch | Class | Jev | Chosen | Delta / reason | Outcome | Calibrated? |`. */
const JEV_COLUMN_INDEX = 3;
const MIN_ROW_CELLS = JEV_COLUMN_INDEX + 1;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const HEADER_FIRST_CELL = "date";
const SEPARATOR_CELL = /^:?-{2,}:?$/;

// ---------------------------------------------------------------------------
// Errors — the exit code names the class of failure.
// ---------------------------------------------------------------------------

/** The skipped form: a payload with no usable confidence. Exit 1 — a finding. */
class SkippedFormError extends Error {}

/** Broken input (unparseable JSON, unreadable/empty table). Exit 2 — cannot check, never pass. */
class StructuralError extends Error {}

function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

// ---------------------------------------------------------------------------
// Mode 1 — the dispatch line.
// ---------------------------------------------------------------------------

/**
 * Render the exact dispatch line. Throws SkippedFormError when the answer lacks a usable
 * confidence (or any other required field): a bare level is the failure this mode catches.
 */
function formatDispatchLine(payload) {
	if (payload === null || typeof payload !== "object" || Array.isArray(payload)) {
		throw new SkippedFormError(
			'expected a JSON object {level, conf, risk, worktree} — the classifier snippet returns exactly that shape',
		);
	}
	const level = normalizeChoice(payload.level, LEVELS, "level", (value) => value.toLowerCase());
	const risk = normalizeChoice(payload.risk, RISKS, "risk", (value) => value.toUpperCase());
	const confidence = normalizeConfidence(payload.conf);
	const worktree = normalizeWorktree(payload.worktree);
	return `jev: ${level} (${formatConfidence(confidence)}) · ${risk} · worktree ${worktree}`;
}

function normalizeChoice(value, allowed, field, transform) {
	if (typeof value !== "string" || value.trim() === "") {
		throw new SkippedFormError(
			`missing "${field}" — the classifier answer must carry all four fields {level, conf, risk, worktree}`,
		);
	}
	const normalized = transform(value.trim());
	if (!allowed.includes(normalized)) {
		throw new SkippedFormError(`invalid "${field}" ${JSON.stringify(value)} — expected one of ${allowed.join(" | ")}`);
	}
	return normalized;
}

/** A confidence is required and must be a probability in [0, 1]; anything else is the skipped form. */
function normalizeConfidence(value) {
	const absent = value === undefined || value === null || (typeof value === "string" && value.trim() === "");
	let parsed = Number.NaN;
	if (!absent && typeof value === "number") parsed = value;
	else if (!absent && typeof value === "string") parsed = Number(value);
	if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
		const detail = absent ? 'missing "conf"' : `invalid "conf" ${JSON.stringify(value)}`;
		throw new SkippedFormError(
			`${detail} — a level without its classifier confidence is the skipped form (#366); ` +
				"re-run the codemode query and pass {level, conf, risk, worktree}",
		);
	}
	return parsed;
}

function normalizeWorktree(value) {
	if (typeof value === "boolean") return value ? "y" : "n";
	if (typeof value === "string") {
		const normalized = value.trim().toLowerCase();
		if (normalized === "y" || normalized === "yes" || normalized === "true") return "y";
		if (normalized === "n" || normalized === "no" || normalized === "false") return "n";
	}
	throw new SkippedFormError(
		`missing/invalid "worktree" ${JSON.stringify(value)} — expected true|false (the classifier's probability > 0.5)`,
	);
}

/** `0.84` → "0.84", `0.9` → "0.9", `1` → "1.0" — the log's own style, never a trailing-zero artifact. */
function formatConfidence(confidence) {
	const text = (Math.round(confidence * 100) / 100).toFixed(2).replace(/0+$/, "");
	return text.endsWith(".") ? `${text}0` : text;
}

// ---------------------------------------------------------------------------
// Mode 2 — the ledger audit.
// ---------------------------------------------------------------------------

function splitTableRow(line) {
	const body = line.replace(/^\|/, "").replace(/\|$/, "");
	return body.split("|").map((cell) => cell.trim());
}

/**
 * Parse the calibration table into rows, plus any pipe line that is neither the header, the
 * separator, nor a dated row (drift evidence — advisory when rows still parse, fatal when none do).
 */
function parseLedgerRows(text) {
	const rows = [];
	const unparsed = [];
	text.split(/\r?\n/).forEach((raw, index) => {
		const line = raw.trim();
		if (!line.startsWith("|")) return;
		const cells = splitTableRow(line);
		if (cells[0].toLowerCase() === HEADER_FIRST_CELL) return;
		if (cells.length > 0 && cells.every((cell) => SEPARATOR_CELL.test(cell))) return;
		const lineNumber = index + 1;
		if (!DATE_PATTERN.test(cells[0]) || cells.length < MIN_ROW_CELLS) {
			unparsed.push({ lineNumber, text: line });
			return;
		}
		rows.push({
			lineNumber,
			date: cells[0],
			dispatch: cells[1],
			jevCell: cells[JEV_COLUMN_INDEX],
		});
	});
	return { rows, unparsed };
}

/** Does the Jev cell carry the query's confidence, or an explicit "did not run" marker? */
function jevCellIsClassified(cell) {
	const lowered = cell.toLowerCase();
	if (CONFIDENCE_IN_CELL.test(cell)) return true;
	return GAP_MARKERS.some((marker) => lowered.includes(marker));
}

/**
 * Audit the ledger text. Throws StructuralError when the table yields no rows at all: an
 * unparsed file must fail loudly, never pass (the silence this check exists to remove).
 */
function analyzeLedger(text) {
	const { rows, unparsed } = parseLedgerRows(text);
	if (rows.length === 0) {
		throw new StructuralError(
			"no ledger rows parsed — the table is empty or its shape changed " +
				"(expected `| Date | Dispatch | Class | Jev | ... |`); refusing to pass an unparsed file",
		);
	}
	const relevant = rows.filter((row) => row.date >= STRICT_JEV_CUTOFF);
	const offenders = relevant.filter((row) => !jevCellIsClassified(row.jevCell));
	return { rows, relevant, offenders, unparsed };
}

function reportLedger(path) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new StructuralError(`${path}: cannot read the ledger (${describe(error)})`);
	}
	const { rows, relevant, offenders, unparsed } = analyzeLedger(text);

	for (const row of unparsed) {
		console.error(`jev-check: ${path}:${row.lineNumber}: unparsed table line (skipped) — ${row.text}`);
	}

	if (offenders.length > 0) {
		console.error(
			`jev-check: ${offenders.length} of ${relevant.length} row(s) dated >= ${STRICT_JEV_CUTOFF} ` +
				"carry a bare Jev level — no confidence and no gap marker:",
		);
		for (const row of offenders) {
			console.error(`  ${path}:${row.lineNumber}: ${row.date} ${row.dispatch} — Jev cell "${row.jevCell}"`);
		}
		console.error(
			"jev-check: record the queried line (`jev: <level> (<confidence>) · Cx · worktree y`) or an explicit " +
				`gap marker (${GAP_MARKERS.join(" / ")}).`,
		);
		return 1;
	}

	console.log(
		`jev-check: ${rows.length} ledger rows parsed, ${relevant.length} since ${STRICT_JEV_CUTOFF} — ` +
			"every Jev cell carries a confidence or an explicit gap marker.",
	);
	return 0;
}

// ---------------------------------------------------------------------------
// Mode 3 — the dispatch-artifact audit (`--log`).
//
// The ledger audit sees the RECORD of a dispatch; this mode sees the DISPATCH itself. Ledger rows
// are appended when a run closes, so a skipped pre-dispatch query (`jev: medium · C2`, no confidence)
// still produces a passing `(0.84)` row written afterwards. The subagent log's
// `Background agent spawned` event carries the task payload verbatim — that is the artifact a skip
// leaves behind, and it is checkable.
// ---------------------------------------------------------------------------

/**
 * The Rule-22 line as it appears inside a dispatch task:
 * `jev: medium (0.84) · C2 · worktree y`. Placeholders (`jev: <level> (<conf>) …`) never match,
 * which is what keeps a quoted template from passing the audit.
 */
const DISPATCH_LINE_PATTERN = /jev:\s*([A-Za-z]+)\s*(?:\(\s*([0-9.]+)\s*\))?\s*·\s*(C\d)\s*·\s*worktree\s*([A-Za-z]+)/i;

/** A line that at least TRIED to be a dispatch line — used to tell "bare level" from "missing". */
const BARE_DISPATCH_LINE_PATTERN = /jev:\s*(?:off|minimal|low|medium|high|xhigh)\b/i;

/** Keep offender output to one readable line per dispatch. */
function clip(text, limit = 110) {
	const flat = text.replace(/\s+/g, " ").trim();
	return flat.length > limit ? `${flat.slice(0, limit - 1)}…` : flat;
}

/**
 * Audit one task payload for the Rule 22 line. Returns `{ok: true}` when a valid line is found,
 * otherwise `{ok: false, reason}` naming what is wrong. A bare level is reported as such — it is
 * the exact form the skips took, and the reason must not be a generic "invalid".
 */
function auditDispatchTask(task) {
	const attempts = [];
	for (const raw of String(task).split(/\r?\n/)) {
		if (!/jev:/i.test(raw)) continue;
		const line = raw.trim();
		const match = DISPATCH_LINE_PATTERN.exec(line);
		if (match === null) {
			const reason = BARE_DISPATCH_LINE_PATTERN.test(line)
				? `bare level without its classifier confidence — ${clip(line)}`
				: `unparseable Rule 22 line — ${clip(line)}`;
			attempts.push(reason);
			continue;
		}
		const [, level, conf, risk, worktree] = match;
		if (conf === undefined) {
			// The regex accepts a confidence-less line so the reason can name it precisely — this
			// is the skip's exact form, and "invalid" would hide the fix.
			attempts.push(`bare level without its classifier confidence — ${clip(line)}`);
			continue;
		}
		try {
			formatDispatchLine({ level, conf, risk, worktree });
			return { ok: true };
		} catch (error) {
			attempts.push(`${describe(error)} — ${clip(line)}`);
		}
	}
	if (attempts.length === 0) return { ok: false, reason: `missing Rule 22 line (${REQUIRED_DISPATCH_FORM})` };
	return { ok: false, reason: attempts[0] };
}

/**
 * Parse JSONL dispatch events. Reads the message field (not a substring) and keeps only the
 * `Background agent spawned` event — the `warn` variants repeat the same task and would double-count.
 * A spawn event with no task payload is a finding, not a skip: it cannot be audited.
 */
function parseDispatchEvents(text) {
	const events = [];
	const unparsed = [];
	text.split(/\r?\n/).forEach((raw, index) => {
		const line = raw.trim();
		if (line === "") return;
		let entry;
		try {
			entry = JSON.parse(line);
		} catch {
			unparsed.push(index + 1);
			return;
		}
		if (entry === null || typeof entry !== "object" || entry.message !== DISPATCH_EVENT_MESSAGE) return;
		const timestamp = typeof entry.timestamp === "string" ? entry.timestamp : "";
		const task = entry.data?.task;
		events.push({
			lineNumber: index + 1,
			timestamp,
			task: typeof task === "string" ? task : null,
		});
	});
	return { events, unparsed };
}

/**
 * `YYYY-MM-DD` part of an ISO timestamp. A missing/unrecognisable timestamp sorts LAST (it can
 * never be grandfathered by the cutoff) — an undateable dispatch is audited, not skipped.
 */
function eventDate(timestamp) {
	if (DATE_PATTERN.test(timestamp.slice(0, 10))) return timestamp.slice(0, 10);
	return "9999-12-31";
}

/**
 * Audit the dispatch log text. Throws StructuralError when no dispatch event parses at all: an
 * empty/rotated/unreadable log must fail loudly, never read as "every dispatch was clean".
 */
function analyzeDispatchLog(text, cutoff) {
	const { events, unparsed } = parseDispatchEvents(text);
	if (events.length === 0) {
		throw new StructuralError(
			`no dispatch events parsed — expected JSONL lines with message "${DISPATCH_EVENT_MESSAGE}"; ` +
				"refusing to pass an empty/unreadable log (is this the subagent log path?)",
		);
	}
	const relevant = events.filter((event) => eventDate(event.timestamp) >= cutoff);
	const offenders = [];
	for (const event of relevant) {
		const audit = event.task === null ? { ok: false, reason: "spawn event carries no task payload — cannot audit" } : auditDispatchTask(event.task);
		if (!audit.ok) offenders.push({ ...event, reason: audit.reason });
	}
	return { events, relevant, offenders, unparsed };
}

/** Validate a `--since` value: a plain date, comparable to the ISO timestamps' date prefix. */
function normalizeSince(value) {
	if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
		throw new StructuralError(`--since needs a YYYY-MM-DD date (got ${JSON.stringify(value)})`);
	}
	return value;
}

function reportDispatchLog(path, since) {
	const cutoff = since === undefined ? STRICT_DISPATCH_CUTOFF : normalizeSince(since);
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new StructuralError(`${path}: cannot read the subagent log (${describe(error)})`);
	}
	const { events, relevant, offenders, unparsed } = analyzeDispatchLog(text, cutoff);

	if (unparsed.length > 0) {
		console.error(`jev-check: ${path}: ${unparsed.length} unparsed JSONL line(s) skipped (line ${unparsed[0]}…).`);
	}

	if (offenders.length > 0) {
		console.error(
			`jev-check: ${offenders.length} of ${relevant.length} dispatch(es) dated >= ${cutoff} carry no valid Rule 22 line:`,
		);
		for (const event of offenders) {
			console.error(`  ${event.timestamp || `(no timestamp, line ${event.lineNumber})`}  ${clip(event.task ?? "", 90)}  — ${event.reason}`);
		}
		console.error(`jev-check: every dispatch task must carry exactly: ${REQUIRED_DISPATCH_FORM}`);
		console.error(
			"jev-check: format it with `--line '<classifier-json>'` and paste it into the dispatch task " +
				"(a bare level without its confidence is the skip — #366, friction log 2026-10-13/23/27).",
		);
		return 1;
	}

	const skipped = events.length - relevant.length;
	console.log(
		`jev-check: ${events.length} dispatch event(s) parsed, ${relevant.length} since ${cutoff} — ` +
			`every task carries a valid Rule 22 line${skipped > 0 ? ` (${skipped} pre-cutoff grandfathered)` : ""}.`,
	);
	return 0;
}

function reportLine(raw) {
	if (raw.trim() === "") {
		throw new StructuralError(
			`--line needs the classifier JSON, e.g. --line '{"level":"medium","conf":0.84,"risk":"C2","worktree":true}'`,
		);
	}
	let payload;
	try {
		payload = JSON.parse(raw);
	} catch (error) {
		throw new StructuralError(`--line: the argument is not JSON (${describe(error)})`);
	}
	console.log(formatDispatchLine(payload));
	return 0;
}

// ---------------------------------------------------------------------------
// Mode 3 — selftest (fixtures, no network, no repo state).
// ---------------------------------------------------------------------------

const LEDGER_HEADER = [
	"| Date | Dispatch | Class | Jev | Chosen | Delta / reason | Outcome | Calibrated? |",
	"|---|---|---|---|---|---|---|---|",
];

function ledgerFixture(...rows) {
	return [...LEDGER_HEADER, ...rows].join("\n");
}

function ledgerRow(date, dispatch, jevCell) {
	return `| ${date} | \`${dispatch}\` | impl | ${jevCell} | medium | 0 | fixture | pending |`;
}

/** One JSONL `Background agent spawned` event, shaped like the real subagent log. */
function dispatchEvent(timestamp, task, message = DISPATCH_EVENT_MESSAGE) {
	return JSON.stringify({
		timestamp,
		level: "info",
		prefix: "brl-subagent",
		message,
		data: { agentId: "fixture-agent", task, model: "fixture/model" },
	});
}

function dispatchLogFixture(...lines) {
	return lines.join("\n");
}

function assertEqual(actual, expected, label) {
	if (actual !== expected) {
		throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
	}
}

function assertRejects(run, messagePattern, label) {
	try {
		run();
	} catch (error) {
		if (!(error instanceof Error)) throw new Error(`${label}: threw a non-Error (${String(error)})`);
		if (!messagePattern.test(error.message)) {
			throw new Error(`${label}: message ${JSON.stringify(error.message)} does not match ${messagePattern}`);
		}
		return error;
	}
	throw new Error(`${label}: expected a rejection, got a result`);
}

const SELFTEST_CASES = [
	// --- --line -------------------------------------------------------------
	{
		name: "--line: a confident answer prints the exact dispatch line",
		run() {
			const line = formatDispatchLine({ level: "medium", conf: 0.84, risk: "C2", worktree: true });
			assertEqual(line, "jev: medium (0.84) · C2 · worktree y", "dispatch line");
		},
	},
	{
		name: "--line: worktree false renders `n`, confidence 0.9 stays `0.9`",
		run() {
			const line = formatDispatchLine({ level: "low", conf: 0.9, risk: "C3", worktree: false });
			assertEqual(line, "jev: low (0.9) · C3 · worktree n", "dispatch line");
		},
	},
	{
		name: "--line: confidence 1 renders `1.0` (no bare dot, no `1.00`)",
		run() {
			const line = formatDispatchLine({ level: "xhigh", conf: 1, risk: "C1", worktree: true });
			assertEqual(line, "jev: xhigh (1.0) · C1 · worktree y", "dispatch line");
		},
	},
	{
		name: "--line: a BARE LEVEL (missing conf) is rejected",
		run() {
			assertRejects(() => formatDispatchLine({ level: "medium", risk: "C2", worktree: true }), /missing "conf"/, "bare level");
		},
	},
	{
		name: "--line: a non-numeric confidence is rejected",
		run() {
			assertRejects(() => formatDispatchLine({ level: "medium", conf: "high", risk: "C2", worktree: true }), /invalid "conf"/, "conf=high");
		},
	},
	{
		name: "--line: an out-of-range confidence is rejected",
		run() {
			assertRejects(() => formatDispatchLine({ level: "medium", conf: 1.4, risk: "C2", worktree: true }), /invalid "conf"/, "conf=1.4");
		},
	},
	{
		name: "--line: a missing level is rejected",
		run() {
			assertRejects(() => formatDispatchLine({ conf: 0.84, risk: "C2", worktree: true }), /missing "level"/, "no level");
		},
	},
	{
		name: "--line: an unknown risk class is rejected",
		run() {
			assertRejects(() => formatDispatchLine({ level: "medium", conf: 0.84, risk: "C4", worktree: true }), /invalid "risk"/, "risk=C4");
		},
	},
	{
		name: "--line: a missing worktree answer is rejected",
		run() {
			assertRejects(() => formatDispatchLine({ level: "medium", conf: 0.84, risk: "C2" }), /"worktree"/, "no worktree");
		},
	},
	{
		name: "--line: a non-object payload is rejected",
		run() {
			assertRejects(() => formatDispatchLine("medium (0.84) · C2"), /JSON object/, "string payload");
		},
	},

	// --- --ledger -----------------------------------------------------------
	{
		name: "--ledger: a confident row passes",
		run() {
			const { rows, offenders } = analyzeLedger(ledgerFixture(ledgerRow("2026-10-13", "impl-ok", "medium (0.84) · C2")));
			assertEqual(offenders.length, 0, "offenders");
			assertEqual(rows.length, 1, "parsed rows");
		},
	},
	{
		name: "--ledger: a BARE LEVEL is a finding",
		run() {
			const { offenders } = analyzeLedger(ledgerFixture(ledgerRow("2026-10-13", "impl-bare", "medium · C2")));
			assertEqual(offenders.length, 1, "offenders");
			assertEqual(offenders[0].dispatch, "`impl-bare`", "offender dispatch");
			assertEqual(offenders[0].date, "2026-10-13", "offender date");
			assertEqual(offenders[0].jevCell, "medium · C2", "offender cell");
		},
	},
	{
		name: "--ledger: each gap marker passes (unavailable / not classified / n/a / ritual gap)",
		run() {
			const { rows, offenders } = analyzeLedger(
				ledgerFixture(
					ledgerRow("2026-10-12", "impl-a", "unavailable"),
					ledgerRow("2026-10-12", "review-b", "not classified — ritual gap"),
					ledgerRow("2026-10-12", "impl-c", "n/a"),
					ledgerRow("2026-10-12", "impl-d", "**ritual gap** (review floor used)"),
				),
			);
			assertEqual(rows.length, 4, "parsed rows");
			assertEqual(offenders.length, 0, "offenders");
		},
	},
	{
		name: "--ledger: a pre-cutoff bare row is ignored (historian rows are not edited)",
		run() {
			const { rows, relevant, offenders } = analyzeLedger(
				ledgerFixture(
					ledgerRow("2026-10-11", "impl-old", "medium · C2"),
					ledgerRow("2026-10-13", "impl-new", "medium (0.72) · C2"),
				),
			);
			assertEqual(rows.length, 2, "parsed rows");
			assertEqual(relevant.length, 1, "rows since the cutoff");
			assertEqual(offenders.length, 0, "offenders");
		},
	},
	{
		name: `--ledger: the cutoff (${STRICT_JEV_CUTOFF}) is inclusive`,
		run() {
			const { offenders } = analyzeLedger(ledgerFixture(ledgerRow(STRICT_JEV_CUTOFF, "impl-edge", "medium · C2")));
			assertEqual(offenders.length, 1, "offenders");
		},
	},
	{
		name: "--ledger: an empty file is an error, not a pass",
		run() {
			assertRejects(() => analyzeLedger(""), /no ledger rows parsed/, "empty");
		},
	},
	{
		name: "--ledger: a header-only table is an error, not a pass",
		run() {
			assertRejects(() => analyzeLedger(ledgerFixture()), /no ledger rows parsed/, "header-only");
		},
	},
	{
		name: "--ledger: a malformed table (no header, no dates) is an error, not a pass",
		run() {
			assertRejects(
				() => analyzeLedger("| Dispatch | Jev |\n| `impl-x` | medium · C2 |\n"),
				/no ledger rows parsed/,
				"malformed",
			);
		},
	},

	// --- --log --------------------------------------------------------------
	{
		name: "--log: a MISSING Rule 22 line is an offender (timestamp + task head + reason)",
		run() {
			const {
				events,
				relevant,
				offenders,
			} = analyzeDispatchLog(
				dispatchLogFixture(dispatchEvent("2026-10-28T09:00:00.000Z", "Implement the thing. No classification here.")),
				STRICT_DISPATCH_CUTOFF,
			);
			assertEqual(events.length, 1, "dispatch events");
			assertEqual(relevant.length, 1, "events since the cutoff");
			assertEqual(offenders.length, 1, "offenders");
			assertEqual(offenders[0].timestamp, "2026-10-28T09:00:00.000Z", "offender timestamp");
			if (!/missing Rule 22 line/.test(offenders[0].reason)) {
				throw new Error(`offender reason: expected /missing Rule 22 line/, got ${JSON.stringify(offenders[0].reason)}`);
			}
		},
	},
	{
		name: "--log: a BARE LEVEL (no confidence) is an offender, named as such",
		run() {
			const { offenders } = analyzeDispatchLog(
				dispatchLogFixture(
					dispatchEvent("2026-10-28T09:00:00.000Z", "Task text.\n\njev: medium · C2 · worktree y"),
				),
				STRICT_DISPATCH_CUTOFF,
			);
			assertEqual(offenders.length, 1, "offenders");
			if (!/bare level without its classifier confidence/.test(offenders[0].reason)) {
				throw new Error(`offender reason: expected /bare level/, got ${JSON.stringify(offenders[0].reason)}`);
			}
		},
	},
	{
		name: "--log: a valid Rule 22 line passes",
		run() {
			const { relevant, offenders } = analyzeDispatchLog(
				dispatchLogFixture(
					dispatchEvent(
						"2026-10-28T09:00:00.000Z",
						"Task text.\n\njev: medium (0.88) · C2 · worktree y (classifier says n — reason recorded).",
					),
				),
				STRICT_DISPATCH_CUTOFF,
			);
			assertEqual(relevant.length, 1, "events since the cutoff");
			assertEqual(offenders.length, 0, "offenders");
		},
	},
	{
		name: "--log: a pre-cutoff dispatch is grandfathered (the log is never edited)",
		run() {
			const { events, relevant, offenders } = analyzeDispatchLog(
				dispatchLogFixture(
					dispatchEvent("2026-10-27T11:10:25.194Z", "Legacy dispatch — no jev line."),
					dispatchEvent("2026-10-28T09:00:00.000Z", "New dispatch.\n\njev: low (0.71) · C3 · worktree n"),
				),
				STRICT_DISPATCH_CUTOFF,
			);
			assertEqual(events.length, 2, "dispatch events");
			assertEqual(relevant.length, 1, "events since the cutoff");
			assertEqual(offenders.length, 0, "offenders");
		},
	},
	{
		name: `--log: the cutoff (${STRICT_DISPATCH_CUTOFF}) is inclusive`,
		run() {
			const { offenders } = analyzeDispatchLog(
				dispatchLogFixture(dispatchEvent(`${STRICT_DISPATCH_CUTOFF}T00:00:00.000Z`, "Edge dispatch — no jev line.")),
				STRICT_DISPATCH_CUTOFF,
			);
			assertEqual(offenders.length, 1, "offenders");
		},
	},
	{
		name: "--log: zero dispatch events is an error, never a silent pass",
		run() {
			assertRejects(() => analyzeDispatchLog("", STRICT_DISPATCH_CUTOFF), /no dispatch events parsed/, "empty log");
			assertRejects(
				() => analyzeDispatchLog('{"message":"Session started"}\nnot json\n', STRICT_DISPATCH_CUTOFF),
				/no dispatch events parsed/,
				"no spawn events",
			);
		},
	},
	{
		name: "--log: the `warn` spawn variant does not double-count the same dispatch",
		run() {
			const task = "Task text.\n\njev: medium (0.88) · C2 · worktree y";
			const { events, offenders } = analyzeDispatchLog(
				dispatchLogFixture(
					dispatchEvent("2026-10-28T09:00:00.000Z", task, "Background agent spawned with approvalMode 'writes' — auto-approving (no dialog in background)"),
					dispatchEvent("2026-10-28T09:00:00.000Z", task),
				),
				STRICT_DISPATCH_CUTOFF,
			);
			assertEqual(events.length, 1, "dispatch events");
			assertEqual(offenders.length, 0, "offenders");
		},
	},
	{
		name: "--log: a quoted PLACEHOLDER template is not a real line (offender)",
		run() {
			const { offenders } = analyzeDispatchLog(
				dispatchLogFixture(
					dispatchEvent("2026-10-28T09:00:00.000Z", "Carry exactly `jev: <level> (<conf>) · Cx · worktree y|n` in the task."),
				),
				STRICT_DISPATCH_CUTOFF,
			);
			assertEqual(offenders.length, 1, "offenders");
		},
	},
	{
		name: "--log: an out-of-range confidence is an offender (validated by --line's own parser)",
		run() {
			const { offenders } = analyzeDispatchLog(
				dispatchLogFixture(dispatchEvent("2026-10-28T09:00:00.000Z", "Task.\n\njev: medium (1.4) · C2 · worktree y")),
				STRICT_DISPATCH_CUTOFF,
			);
			assertEqual(offenders.length, 1, "offenders");
			if (!/invalid "conf"/.test(offenders[0].reason)) {
				throw new Error(`offender reason: expected /invalid "conf"/, got ${JSON.stringify(offenders[0].reason)}`);
			}
		},
	},
	{
		name: "--log: a spawn event with no task payload is a finding, not a skip",
		run() {
			const { offenders } = analyzeDispatchLog(
				dispatchLogFixture(
					JSON.stringify({ timestamp: "2026-10-28T09:00:00.000Z", message: DISPATCH_EVENT_MESSAGE, data: { agentId: "x" } }),
				),
				STRICT_DISPATCH_CUTOFF,
			);
			assertEqual(offenders.length, 1, "offenders");
		},
	},
];

function runSelftest() {
	console.log(`jev-check --selftest: ${SELFTEST_CASES.length} cases`);
	let failures = 0;
	for (const { name, run } of SELFTEST_CASES) {
		try {
			run();
			console.log(`  ✓ ${name}`);
		} catch (error) {
			failures += 1;
			console.log(`  ✗ ${name}: ${describe(error)}`);
		}
	}
	const passed = SELFTEST_CASES.length - failures;
	console.log(`jev-check --selftest: ${passed}/${SELFTEST_CASES.length} passed — ${failures === 0 ? "PASS" : "FAIL"}`);
	return failures === 0 ? 0 : 1;
}

// ---------------------------------------------------------------------------
// CLI.
// ---------------------------------------------------------------------------

const USAGE = [
	"usage: jev-check.mjs --line '<classifier-json>' | --ledger [path] | --log [path] [--since YYYY-MM-DD] | --selftest",
	"",
	"  --line '<json>'   validate {level, conf, risk, worktree} and print",
	'                    `jev: <level> (<conf>) · <Cx> · worktree <y|n>`',
	`  --ledger [path]   audit the Jev calibration log (default: ${DEFAULT_LEDGER})`,
	`  --log [path]      audit dispatch payloads in the subagent log (default: ${DEFAULT_SUBAGENT_LOG});`,
	`                    every \`${DISPATCH_EVENT_MESSAGE}\` event dated >= ${STRICT_DISPATCH_CUTOFF}`,
	"                    must carry a valid Rule 22 line. Conductor/merge-time (local log).",
	"  --since YYYY-MM-DD  with --log: override the dispatch cutoff (legacy audit)",
	"  --selftest        fixture proof of every mode (CI-wired)",
].join("\n");

/** Parse `--log [path] [--since YYYY-MM-DD]` in either order; a second path is a usage error. */
function parseLogArgs(args) {
	let path;
	let since;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--since") {
			if (index + 1 >= args.length) throw new StructuralError("--since needs a YYYY-MM-DD date");
			since = args[index + 1];
			index += 1;
		} else if (arg.startsWith("--")) {
			throw new StructuralError(`unknown --log option ${JSON.stringify(arg)}\n\n${USAGE}`);
		} else if (path === undefined) {
			path = arg;
		} else {
			throw new StructuralError(`--log takes at most one path (got ${JSON.stringify(path)} and ${JSON.stringify(arg)})`);
		}
	}
	return { path: path ?? DEFAULT_SUBAGENT_LOG, since };
}

function main(argv) {
	const [mode, ...rest] = argv;
	try {
		if (mode === "--line") return reportLine(rest.join(" "));
		if (mode === "--ledger") {
			if (rest.length > 1) throw new StructuralError(`--ledger takes at most one path (got ${rest.length})`);
			return reportLedger(rest[0] ?? DEFAULT_LEDGER);
		}
		if (mode === "--log") {
			const { path, since } = parseLogArgs(rest);
			return reportDispatchLog(path, since);
		}
		if (mode === "--selftest") return runSelftest();
		if (mode === "--help" || mode === "-h") {
			console.log(USAGE);
			return 0;
		}
		throw new StructuralError(mode === undefined ? USAGE : `unknown mode ${JSON.stringify(mode)}\n\n${USAGE}`);
	} catch (error) {
		if (error instanceof SkippedFormError) {
			console.error(`jev-check: ${error.message}`);
			return 1;
		}
		if (error instanceof StructuralError) {
			console.error(`jev-check: ${error.message}`);
			return 2;
		}
		throw error;
	}
}

process.exitCode = main(process.argv.slice(2));

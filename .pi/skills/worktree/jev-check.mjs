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
//   --selftest                  fixture proof of both modes (CI-wired), deterministic, no network.
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
	"usage: jev-check.mjs --line '<classifier-json>' | --ledger [path] | --selftest",
	"",
	"  --line '<json>'   validate {level, conf, risk, worktree} and print",
	'                    `jev: <level> (<conf>) · <Cx> · worktree <y|n>`',
	`  --ledger [path]   audit the Jev calibration log (default: ${DEFAULT_LEDGER})`,
	"  --selftest        fixture proof of both modes (CI-wired)",
].join("\n");

function main(argv) {
	const [mode, ...rest] = argv;
	try {
		if (mode === "--line") return reportLine(rest.join(" "));
		if (mode === "--ledger") {
			if (rest.length > 1) throw new StructuralError(`--ledger takes at most one path (got ${rest.length})`);
			return reportLedger(rest[0] ?? DEFAULT_LEDGER);
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

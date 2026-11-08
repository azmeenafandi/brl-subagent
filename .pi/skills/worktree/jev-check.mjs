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
//   --classifier '<raw-answers>'  THE HONEST PATH: paste the classifier's raw response
//                               ({"answers":{level:{choice,confidence},risk:{choice},worktree:{probability}}})
//                               and derive the dispatch line from it. The answer object cannot be
//                               "a level I chose" without also inventing the rest of the response.
//   --line '<json>'             validate {level, conf, risk, worktree} and print the exact dispatch
//                               line. Format-only: a conductor-assigned JSON passes, so `--label`
//                               with `--line` now REQUIRES `--legacy-line` to acknowledge it. A
//                               missing/invalid confidence is rejected (exit 1) — the skipped form.
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
//   --line ... --legacy-line --label <name>
//                               prints the line and writes NO provenance row. A conductor-assigned
//                               line must never mint the row that proves a classifier produced it
//                               (2026-11-07: it could, so a `retro:` exception cited spoofed evidence).
//   --classifier ... --label <name>  the ONLY provenance writer:
//                               `<iso>\t<label>\t<line>`. This is what makes the line
//                               MACHINE-PRODUCED — the 2026-10-31 gap was a hand-typed `medium (0.70)`
//                               line whose classifier answer was actually `high (0.32)`, and a
//                               format-only check passes an invented confidence (Goodhart).
//                               Optional keyed columns follow the line, any subset, any order:
//                               `stated:worktree` (#456), `model:<provider>/<id>` and
//                               `level-model:<level> (<conf>)` (#468 — the model that will run it
//                               and the model-aware arm's answer).
//   --classifier ... --model <provider>/<id> --classifier-model-aware '<raw answers>'
//                               the model-aware arm (#468): the same task plus one model stanza.
//                               It prints ONE pasteable line (the blind arm's) and records the
//                               aware answer as `level-model:`; an arm-2 failure falls back to
//                               blind-only, because a measurement must never block a dispatch.
//   --settle <label> --kind impl|review|probe --outcome done|failed|stopped|unknown
//              [--verdict approve|approve-with-nits|changes-requested] [--nits N] [--model-ran <id>]
//                               append `.pi/jev-outcomes.log` with what HAPPENED, keyed by label.
//                               A sidecar, not a second provenance row: the exact-text match stays
//                               untouched. `--model-ran` corrects the model for a transport retry or
//                               a fallback — a manual correction, never runtime detection.
//   --calibrate                 read the sidecar against the provenance log: eligible impl rows,
//                               both arms' agreement with the DISPATCHED level, and the delta. Below
//                               20 eligible rows it prints counts and NO conclusion. It never ranks.
//   --log ... --require-provenance
//                               additionally require every audited dispatch line (since the
//                               provenance log's own cutoff) to have a provenance entry. A line with
//                               none was NOT printed by --line: it was typed, invented, or copied.
//                               Missing provenance log = exit 2 (fail-closed, never a silent pass).
//                               A provenance miss can be ACKNOWLEDGED (never laundered) by an
//                               exceptions-file entry whose reason carries `retro:<label>` naming a
//                               real provenance row: the conductor's error stays visible in the same
//                               report, and the retrospective classification is the evidence. An
//                               exception without a usable `retro:` label leaves the dispatch an
//                               offender — the excuse must point at a row, not at prose.
//   --selftest                  fixture proof of every mode (CI-wired), deterministic, no network.
//
// CI:
//   node .pi/skills/worktree/jev-check.mjs --selftest
//   node .pi/skills/worktree/jev-check.mjs --ledger .development/investigations/jev-calibration-log.md
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

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

/**
 * Recorded dispatch-line exceptions (Rule 22). A HISTORICAL miss can never be edited into the log,
 * so without this the `--log` audit would block every merge forever. One exception per line:
 * `<agent-id-prefix>  <reason>`; `#` lines are comments. Matching offenders are reported as
 * acknowledged (with the reason), never as clean and never as failing. Local (`.pi/` is gitignored).
 */
const DISPATCH_EXCEPTIONS_DEFAULT = ".pi/jev-dispatch-exceptions.txt";

/** The exact form a dispatch task must carry (Rule 22) — quoted verbatim in every failure. */
const REQUIRED_DISPATCH_FORM = "jev: <level> (<0.xx>) · C<1|2|3> · worktree <y|n>";

/** Default subagent log (repo-root relative; run from the repo/cockpit root). */
const DEFAULT_SUBAGENT_LOG = ".pi/subagent-logs/brl-subagent.log";

/** The one spawn event that carries the dispatch payload (the `warn` variants duplicate it). */
const DISPATCH_EVENT_MESSAGE = "Background agent spawned";

/** Default provenance log (repo-root relative, gitignored — `.pi/*`). */
const DEFAULT_PROVENANCE_LOG = ".pi/jev-lines.log";

/**
 * The outcome SIDECAR (#468), keyed by the dispatch label. It is not a second row type in the
 * provenance log: the provenance row stays the exact-text artifact `--require-provenance` matches,
 * and "what happened" is a fact recorded later, by a different command, about a different thing.
 */
const DEFAULT_OUTCOMES_LOG = ".pi/jev-outcomes.log";
const OUTCOMES_CUTOFF_PREFIX = "# jev-outcomes — cutoff ";

/** Settle vocabulary. `--kind` is REQUIRED: reviews are excluded from level calibration. */
const OUTCOME_KINDS = ["impl", "review", "probe"];
const OUTCOME_VALUES = ["done", "failed", "stopped", "unknown"];
const OUTCOME_VERDICTS = ["approve", "approve-with-nits", "changes-requested"];
const OUTCOMES_ROW_COLUMNS = 7;
/** The explicit "nothing recorded" cell — a literal, never an empty column that reads as a value. */
const OUTCOME_NULL = "null";

/** Rows with no recorded model, printed and never hidden: the legacy log predates the column. */
const MODEL_UNSTATED = "(unstated)";

/**
 * The calibration floor. Below this many eligible implementation rows nothing is compared and no
 * conclusion is printed — a table that ranks on six rows is the same theatre in a new costume.
 * The falsifier (ADR 0025) is decided against this cohort at N >= 20.
 */
const CALIBRATION_MIN_ROWS = 20;

/**
 * The provenance log's header records the cutoff: entries can only exist from the moment the log
 * was created, so dispatches dated BEFORE it are exempt (a historical dispatch cannot have a
 * provenance entry — the log did not exist). Recorded in the file, not in code, so the cutoff is
 * the deployment moment rather than an arbitrary constant.
 */
const PROVENANCE_CUTOFF_PREFIX = "# jev-lines provenance — cutoff ";

/** Explicit "the classifier did not run" markers — recorded, not silent (Rule 22). */
const GAP_MARKERS = ["unavailable", "not classified", "n/a", "ritual gap"];

/**
 * A model id: `<provider>/<id>`. At least one slash, and MULTIPLE are legal — the real ids this
 * repository dispatches include `openrouter/meta/muse-spark-1.3-contributor` and
 * `openrouter/~typesafe/jev-latest` (a single-slash pattern rejected both, measured 2026-11-08).
 */
const MODEL_ID_PATTERN = /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)+$/;

/** `<level> (<conf>)` in the aware column. The numeric RANGE is checked separately (rejects `1.5`). */
const LEVEL_MODEL_SHAPE = /^level-model:([A-Za-z]+) \((\d+(?:\.\d+)?)\)$/;

/** A provenance row: 3 positional columns plus up to 3 keyed ones. */
const PROVENANCE_ROW_BASE_COLUMNS = 3;
const PROVENANCE_ROW_MAX_COLUMNS = 6;

/** Anything shaped like a keyed column — used to reject one placed before the line column. */
const KEYED_COLUMN_PREFIX = /^(?:stated|model|level-model):/;

const PROVENANCE_COLUMN_HELP =
	"expected <iso>\\t<label>\\t<line> then any of stated:worktree, model:<provider>/<id>, " +
	"level-model:<level> (<conf>)";

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

/**
 * The sanctioned escape, in line form: `jev: unavailable` (SKILL's Rule 22 text: "record
 * `jev: unavailable` and proceed — never block a dispatch on the classifier"). Anchored to the
 * `jev:` prefix so prose that merely contains the word cannot pass as a classification, and
 * derived from GAP_MARKERS so the ledger and the log audits cannot drift apart.
 */
const DISPATCH_GAP_LINE_PATTERN = new RegExp(
	`^jev:\\s*(?:${GAP_MARKERS.map((marker) => marker.replace(/[/\\^$.*+?()[\]{}|]/g, "\\$&")).join("|")})\\b`,
	"i",
);

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
		// A recorded gap is accepted: `jev: unavailable` is the sanctioned form when the classifier
		// did not run. It is a RECORD, not a silent skip — the audit still reports how many.
		if (DISPATCH_GAP_LINE_PATTERN.test(line)) return { ok: true, gap: true, line };
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
			// The CANONICAL rendering is what provenance stores, so an accepted line is
			// normalized here too (a hand-typed `0.80` matches the printer's `0.8`).
			return { ok: true, line: formatDispatchLine({ level, conf, risk, worktree }) };
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
			agentId: typeof entry.data?.agentId === "string" ? entry.data.agentId : "",
		});
	});
	return { events, unparsed };
}

/**
 * A provenance exception must name the retrospective row: `retro:<label>`, where `<label>` is a
 * label that exists in the provenance log. Prose alone is not evidence — an invented confidence
 * plus a persuasive sentence would otherwise clear the gate (#449: a hand-typed `high (0.62)` when
 * the classifier answers `xhigh (0.63)`).
 */
function parseProvenanceExceptionMarker(reason) {
	const match = /\bretro:([A-Za-z0-9][A-Za-z0-9._:-]*)/.exec(reason);
	return match === null ? null : match[1];
}

/** Parse the exceptions file: `<agent-id-prefix>  <reason>`. A missing file means no exceptions. */
function loadDispatchExceptions(path) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch {
		return [];
	}
	const exceptions = [];
	for (const raw of text.split("\n")) {
		const line = raw.trim();
		if (line === "" || line.startsWith("#")) continue;
		const [prefix, ...rest] = line.split(/\s+/);
		if (prefix.length < 7) {
			console.error(`jev-check: exceptions: prefix ${JSON.stringify(prefix)} is shorter than 7 chars — it can match unrelated dispatches`);
		}
		const reason = rest.join(" ").trim() || "(no reason recorded)";
		exceptions.push({ prefix: prefix.toLowerCase(), reason, retro: parseProvenanceExceptionMarker(reason) });
	}
	return exceptions;
}

// ---------------------------------------------------------------------------
// Provenance — the line must come from the classifier, not from the conductor's memory.
// ---------------------------------------------------------------------------

/**
 * One provenance row: `<iso>\t<label>\t<canonical line>` followed by optional KEYED columns
 * (`stated:worktree`, `model:<id>`, `level-model:<level> (<conf>)`). Tabs, because a task label or
 * a line can contain anything else (the middle dot is not a separator risk; a tab cannot appear in
 * a shell label without quoting).
 *
 * The keyed columns are FACTS ABOUT THE RUN, never part of the matched line: the printed `jev:`
 * line is what `--require-provenance` compares exactly, so a new column can never invalidate a row
 * that was already printed, and 3-, 4-, 5- and 6-column rows coexist in one log.
 *
 * `fields`: `{ stated?: string, model?: string, levelModel?: { level, conf } }`.
 */
function formatProvenanceEntry(line, label, now, fields = {}) {
	const columns = [now.toISOString(), label, line];
	// #456: a field the classifier answered was STATED by the conductor (`worktree`, a process
	// fact under Rule 5). Absent = all model answers.
	if (fields.stated) columns.push(`stated:${fields.stated}`);
	// #468: the model that will run the dispatch, and the model-aware arm's answer. These are the
	// two facts the ledger never had — which is why it could never answer "was this level right
	// for this model". Absent when unrecorded: never a guess, never a padded `model:unstated`.
	if (fields.model) columns.push(`model:${fields.model}`);
	if (fields.levelModel) {
		columns.push(`level-model:${fields.levelModel.level} (${formatConfidence(fields.levelModel.conf)})`);
	}
	return columns.join("\t");
}

/**
 * Parse the provenance log. Returns `{ cutoff, entries }`, where `cutoff` is the `YYYY-MM-DD` from
 * the header (null when the file predates headers). A non-comment row that is not exactly three
 * tab-separated fields is a StructuralError — a corrupted provenance log must never read as
 * "no entries", which would silently fail every dispatch or, worse, silently pass none.
 */
function parseProvenanceLog(text) {
	let cutoff = null;
	const entries = [];
	const rows = text.split(/\r?\n/);
	for (let index = 0; index < rows.length; index += 1) {
		const raw = rows[index];
		if (raw.trim() === "") continue;
		if (raw.trimStart().startsWith("#")) {
			const trimmed = raw.trim();
			// The cutoff is the log's creation INSTANT, not its date: a date-only cutoff
			// treats every same-day dispatch as "since the cutoff", which would flag the
			// dispatches that predate the log (the 2026-10-31 live case). No released log
			// predates this feature, so a date-only header is a structural error rather
			// than a silently weaker comparison.
			if (/\bcutoff\s+\d{4}-\d{2}-\d{2}\s*$/.test(trimmed)) {
				throw new StructuralError(
					`${PROVENANCE_CUTOFF_PREFIX.trim()} is date-only — the cutoff must be a full ISO instant ` +
						"(YYYY-MM-DDThh:mm:ss.sssZ); delete the log and reprint the next line with --label",
				);
			}
			const match = /^#.*\bcutoff\s+(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\s*$/.exec(trimmed);
			if (match !== null) cutoff = match[1];
			continue;
		}
		entries.push(parseProvenanceRow(raw, index + 1));
	}
	return { cutoff, entries };
}

/**
 * Parse ONE provenance row. The base is three positional columns (`<iso>`, `<label>`, `<line>`);
 * everything after is keyed, optional, any order, each at most once (#468).
 *
 * Fail-closed on every deviation a hand-edit can produce: an unknown key, a duplicate key, a
 * malformed value, a tab inside a value (which arrives as an extra column — the reason keyed
 * columns exist at all), a truncated row, or a keyed column before the line column. A corrupted
 * log must never read as "no entries".
 */
function parseProvenanceRow(raw, lineNumber) {
	const malformed = (why) =>
		new StructuralError(`provenance log line ${lineNumber} is malformed — ${why}; ${PROVENANCE_COLUMN_HELP}`);
	const parts = raw.split("\t");
	if (parts.length < PROVENANCE_ROW_BASE_COLUMNS) {
		throw malformed(`only ${parts.length} tab-separated column(s), and <iso>, <label>, <line> are required`);
	}
	if (parts.length > PROVENANCE_ROW_MAX_COLUMNS) {
		throw malformed(`${parts.length} columns — at most ${PROVENANCE_ROW_MAX_COLUMNS} (the base 3 plus 3 keyed)`);
	}
	const at = parts[0].trim();
	const label = parts[1].trim();
	const line = parts[2].trim();
	if (label === "" || line === "") throw malformed("the label or the line column is empty");
	if (KEYED_COLUMN_PREFIX.test(at) || KEYED_COLUMN_PREFIX.test(label)) {
		throw malformed(`the keyed column ${JSON.stringify(KEYED_COLUMN_PREFIX.test(at) ? at : label)} appears before the line column`);
	}
	const entry = { at, label, line, stated: null, model: null, levelModel: null };
	const seen = new Set();
	for (const column of parts.slice(PROVENANCE_ROW_BASE_COLUMNS)) {
		applyProvenanceColumn(entry, column.trim(), seen, malformed);
	}
	return entry;
}

/** Apply one keyed column to `entry`; `malformed(why)` builds the StructuralError to throw. */
function applyProvenanceColumn(entry, column, seen, malformed) {
	if (column === "stated:worktree") {
		if (seen.has("stated")) throw malformed("duplicate `stated:` column");
		seen.add("stated");
		entry.stated = "worktree";
		return;
	}
	if (column.startsWith("model:")) {
		if (seen.has("model")) throw malformed("duplicate `model:` column");
		const id = column.slice("model:".length);
		if (!MODEL_ID_PATTERN.test(id)) {
			throw malformed(`model id ${JSON.stringify(id)} is not <provider>/<id> (no spaces, at least one "/")`);
		}
		seen.add("model");
		entry.model = id;
		return;
	}
	const aware = LEVEL_MODEL_SHAPE.exec(column);
	if (aware !== null) {
		if (seen.has("level-model")) throw malformed("duplicate `level-model:` column");
		const [, level, confText] = aware;
		if (!LEVELS.includes(level)) throw malformed(`level ${JSON.stringify(level)} is not one of ${LEVELS.join(" | ")}`);
		const conf = Number(confText);
		if (!Number.isFinite(conf) || conf < 0 || conf > 1) {
			throw malformed(`confidence ${confText} is outside [0, 1]`);
		}
		seen.add("level-model");
		entry.levelModel = { level, conf };
		return;
	}
	// Only `worktree` can be stated today; a hand-crafted row claiming any other field was stated
	// is rejected rather than silently accepted.
	if (column.startsWith("stated:")) {
		throw malformed(`the stated column ${JSON.stringify(column)} is not supported — only stated:worktree is`);
	}
	if (column.startsWith("level-model:")) {
		throw malformed(`the level-model column ${JSON.stringify(column)} is not "<level> (<0..1 conf>)"`);
	}
	throw malformed(`unknown column ${JSON.stringify(column)}`);
}

/**
 * Append one provenance row, creating the file (and its cutoff header) on first use. The cutoff is
 * the creation DATE, which is what exempts every dispatch that predates the log.
 */
function appendProvenanceEntry(path, line, label, now = new Date(), fields = {}) {
	let existing = "";
	try {
		existing = readFileSync(path, "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw new StructuralError(`${path}: cannot read the provenance log (${describe(error)})`);
	}
	const header = existing.trim() === "" ? `${PROVENANCE_CUTOFF_PREFIX}${now.toISOString()}\n` : "";
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${header}${formatProvenanceEntry(line, label, now, fields)}\n`);
}

/** Read the provenance log, fail-closed: a missing/empty log cannot verify anything. */
function loadProvenance(path) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new StructuralError(
			`${path}: cannot read the provenance log (${describe(error)}) — --require-provenance is fail-closed; ` +
				"print every dispatch line with `--line '<json>' --label <name>`",
		);
	}
	const parsed = parseProvenanceLog(text);
	if (parsed.entries.length === 0) {
		throw new StructuralError(
			`${path}: no provenance entries — --require-provenance cannot verify a dispatch line it never saw printed`,
		);
	}
	return parsed;
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
function analyzeDispatchLog(text, cutoff, exceptions = [], provenance = null) {
	const { events, unparsed } = parseDispatchEvents(text);
	if (events.length === 0) {
		throw new StructuralError(
			`no dispatch events parsed — expected JSONL lines with message "${DISPATCH_EVENT_MESSAGE}"; ` +
				"refusing to pass an empty/unreadable log (is this the subagent log path?)",
		);
	}
	const relevant = events.filter((event) => eventDate(event.timestamp) >= cutoff);
	const offenders = [];
	const excepted = [];
	for (const event of relevant) {
		const audit = event.task === null ? { ok: false, reason: "spawn event carries no task payload — cannot audit" } : auditDispatchTask(event.task);
		if (audit.ok) {
			// Provenance (the Goodhart fix): a line in the right FORMAT can be invented. Only a
			// line that `--line --label` printed has a row here. Gap lines are exempt — they
			// record that the classifier did NOT run, so there is nothing to prove.
			const eventAt = Date.parse(event.timestamp);
			const cutoffAt = provenance !== null && provenance.cutoff !== null ? Date.parse(provenance.cutoff) : NaN;
			const sinceCutoff = Number.isFinite(cutoffAt) && (!Number.isFinite(eventAt) || eventAt >= cutoffAt);
			if (provenance !== null && !audit.gap && sinceCutoff) {
				if (!provenance.lines.has(audit.line)) {
					// A provenance miss is the one offence an invented line cannot hide: the dispatch
					// went out with a line the classifier never printed. It may be ACKNOWLEDGED, but only
					// by an exception that names a real retrospective provenance row (`retro:<label>`) —
					// the error stays in the same report and the evidence is the row, not the prose.
					const exception = exceptions.find((entry) =>
						event.agentId !== "" && event.agentId.toLowerCase().startsWith(entry.prefix),
					);
					const retroUsable =
						exception !== undefined &&
						exception.retro !== null &&
						provenance.labels !== undefined &&
						provenance.labels.has(exception.retro);
					if (retroUsable) {
						excepted.push({ ...event, kind: "provenance", reason: "no classifier provenance", exception: exception.reason });
					} else if (exception !== undefined) {
						const unusable =
							exception.retro === null
								? "it carries no retro:<label> naming a provenance row"
								: "retro:" + exception.retro + " is not a provenance label";
						offenders.push({
							...event,
							reason:
								'no classifier provenance for "' + audit.line + '" — that line was not printed by ' +
								"`--line --label` (an invented or copied confidence passes a format-only check). " +
								"The recorded exception is not usable: " + unusable +
								" — print the retrospective classification with --classifier … --label <name> and name it.",
						});
					} else {
						offenders.push({
							...event,
							reason:
								`no classifier provenance for "${audit.line}" — that line was not printed by ` +
								"`--line --label` (an invented or copied confidence passes a format-only check)",
						});
					}
				}
			}
			continue;
		}
		const exception = exceptions.find((entry) => event.agentId.toLowerCase().startsWith(entry.prefix));
		if (exception) {
			excepted.push({ ...event, reason: audit.reason, exception: exception.reason });
		} else {
			offenders.push({ ...event, reason: audit.reason });
		}
	}
	return { events, relevant, offenders, excepted, unparsed };
}

/** Validate a `--since` value: a plain date, comparable to the ISO timestamps' date prefix. */
function normalizeSince(value) {
	if (typeof value !== "string" || !DATE_PATTERN.test(value)) {
		throw new StructuralError(`--since needs a YYYY-MM-DD date (got ${JSON.stringify(value)})`);
	}
	return value;
}

function reportDispatchLog(path, since, exceptionsPath, requireProvenance = false) {
	const cutoff = since === undefined ? STRICT_DISPATCH_CUTOFF : normalizeSince(since);
	const exceptions = loadDispatchExceptions(exceptionsPath ?? DISPATCH_EXCEPTIONS_DEFAULT);
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		throw new StructuralError(`${path}: cannot read the subagent log (${describe(error)})`);
	}
	let provenance = null;
	if (requireProvenance) {
		const loaded = loadProvenance(DEFAULT_PROVENANCE_LOG);
		provenance = {
			cutoff: loaded.cutoff,
			lines: new Set(loaded.entries.map((entry) => entry.line)),
			labels: new Set(loaded.entries.map((entry) => entry.label)),
		};
	}
	const { events, relevant, offenders, excepted, unparsed } = analyzeDispatchLog(text, cutoff, exceptions, provenance);

	if (excepted.length > 0) {
		console.error(`jev-check: ${excepted.length} offending dispatch(es) carry a RECORDED exception:`);
		for (const event of excepted) {
			const kind = event.kind === "provenance" ? " [provenance miss]" : "";
			console.error(`  ${event.timestamp || `(no timestamp, line ${event.lineNumber})`}  ${clip(event.task ?? "", 60)}${kind}  — acknowledged: ${event.exception}`);
		}
	}

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
			`every task carries a valid Rule 22 line${excepted.length > 0 ? ` (${excepted.length} recorded exception(s))` : ""}` +
			`${skipped > 0 ? ` (${skipped} pre-cutoff grandfathered)` : ""}.`,
	);
	return 0;
}

/**
 * Parse `--line '<json>' [--label <name>]`: the JSON is everything that is not an option (a shell
 * already removed the quoting), and `--label` names the dispatch so a provenance row is readable.
 * An unusable `--label` is a usage error rather than a silent unlabeled row.
 */
function parseLineArgs(args) {
	let raw;
	let label;
	let legacy = false;
	let worktree;
	let model;
	let awareRaw;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--legacy-line") {
			legacy = true;
		} else if (arg === "--model") {
			if (index + 1 >= args.length) throw new StructuralError("--model needs a model id (<provider>/<id>)");
			model = normalizeModelId(args[index + 1], "--model");
			index += 1;
		} else if (arg === "--classifier-model-aware") {
			if (index + 1 >= args.length) {
				throw new StructuralError("--classifier-model-aware needs the model-aware arm's raw answers JSON as one argument");
			}
			awareRaw = args[index + 1];
			index += 1;
		} else if (arg === "--worktree") {
			if (index + 1 >= args.length) throw new StructuralError("--worktree needs y or n");
			const value = args[index + 1];
			if (value !== "y" && value !== "n") {
				throw new StructuralError(`--worktree must be y or n (got ${JSON.stringify(value)})`);
			}
			worktree = value === "y";
			index += 1;
		} else if (arg === "--label") {
			if (index + 1 >= args.length) throw new StructuralError("--label needs a dispatch name");
			label = args[index + 1];
			index += 1;
		} else if (arg.startsWith("--") && raw !== undefined) {
			throw new StructuralError(`unknown option ${JSON.stringify(arg)}\n\n${USAGE}`);
		} else if (raw === undefined) {
			raw = arg;
		} else {
			raw = `${raw} ${arg}`;
		}
	}
	return { raw: raw ?? "", label, legacy, worktree, model, awareRaw };
}

function reportLine(raw, label, legacy = false) {
	if (raw.trim() === "") {
		throw new StructuralError(
			`--line needs the classifier JSON, e.g. --line '{"level":"medium","conf":0.84,"risk":"C2","worktree":true}' --label <name>`,
		);
	}
	let payload;
	try {
		payload = JSON.parse(raw);
	} catch (error) {
		throw new StructuralError(`--line: the argument is not JSON (${describe(error)})`);
	}
	const line = formatDispatchLine(payload);
	if (label !== undefined && !legacy) {
		throw new StructuralError(
			"--line is format-only: it accepts a conductor-assigned JSON, so a provenance row would " +
				"claim a classifier that never ran (2026-10-31, 2026-11-04). Use --classifier '<raw answers>' " +
				"--label <name>; add --legacy-line only to acknowledge a conductor-assigned line.",
		);
	}
	console.log(line);
	// `--line` NEVER writes provenance. The throw above means a labeled call reaching here is
	// always a legacy one, so there is no append branch at all — a conductor-assigned line cannot
	// be its own evidence (2026-11-07: it could, and a `retro:` exception cited the spoofed row).
	if (label !== undefined) {
		console.error(
			"jev-check: --legacy-line does NOT write provenance — a conductor-assigned line cannot be " +
				"its own evidence. Run the classifier for a row (`--classifier '<raw answers>' --label <name>`).",
		);
	}
	return 0;
}

/**
 * Derive the dispatch line from the classifier's RAW response. This is the only
 * mode whose input is a classifier output rather than a hand-chosen summary:
 * the shape check is the point, not decoration.
 */
function classifierPayloadToLine(raw, worktreeOverride) {
	if (raw.trim() === "") {
		throw new StructuralError(
			"--classifier needs the raw answers JSON: " +
				`'{"answers":{"level":{"choice":"medium","confidence":0.84},"risk":{"choice":"C2"},"worktree":{"probability":0.9}}}'`,
		);
	}
	let payload;
	try {
		payload = JSON.parse(raw);
	} catch (error) {
		throw new StructuralError(`--classifier: the argument is not JSON (${describe(error)})`);
	}
	const answers = payload && typeof payload === "object" ? payload.answers : undefined;
	if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
		throw new SkippedFormError(
			"--classifier: expected the raw classifier response object with an \"answers\" key — " +
				"the level/conf/risk/worktree summary is NOT this input (use --line --legacy-line to acknowledge that)",
		);
	}
	const probability = answers.worktree && answers.worktree.probability;
	if (typeof probability !== "number" || Number.isNaN(probability)) {
		throw new SkippedFormError("--classifier: answers.worktree.probability is missing or not a number");
	}
	const classified = probability > 0.5;
	if (worktreeOverride !== undefined && worktreeOverride !== classified) {
		console.error(
			`jev-check: worktree ${worktreeOverride ? "y" : "n"} STATED by the conductor ` +
				`(the classifier said ${classified ? "y" : "n"}, p=${probability}) — recorded as stated, ` +
				"not as a model answer",
		);
	}
	return formatDispatchLine({
		level: answers.level && answers.level.choice,
		conf: answers.level && answers.level.confidence,
		risk: answers.risk && answers.risk.choice,
		worktree: worktreeOverride === undefined ? classified : worktreeOverride,
	});
}

function reportClassifier(raw, label, provenancePath = DEFAULT_PROVENANCE_LOG, worktreeOverride, options = {}) {
	const { model, awareRaw } = options;
	if (awareRaw !== undefined && model === undefined) {
		throw new StructuralError(
			"--classifier-model-aware requires --model <provider>/<id> — the aware arm is only meaningful " +
			"beside the model that will actually run the dispatch (record them together or not at all)",
		);
	}
	const line = classifierPayloadToLine(raw, worktreeOverride);
	// Exactly ONE pasteable line on stdout. The aware arm is a diagnostic and a record column: a
	// second `jev:` line would let a reader paste the wrong arm into the dispatch.
	console.log(line);
	const levelModel = awareRaw === undefined ? null : awareArmLevelModel(awareRaw);
	if (levelModel !== null) {
		console.error(
			`jev-check: aware arm ${levelModel.level} (${formatConfidence(levelModel.conf)}) — recorded as ` +
				`level-model, never printed: the blind line above is the dispatch line`,
		);
	}
	if (label !== undefined) {
		appendProvenanceEntry(provenancePath, line, label, new Date(), {
			stated: worktreeOverride === undefined ? null : "worktree",
			model: model ?? null,
			levelModel,
		});
		console.error(
			`jev-check: provenance row appended to ${provenancePath} (label ${JSON.stringify(label)}` +
				`${model === undefined ? "" : `, model ${model}`}${levelModel === null ? "" : ", aware arm recorded"})`,
		);
	}
	return 0;
}

/**
 * The second, model-aware arm (#468): the same task text plus one model stanza — the only
 * difference, so the delta is attributable. It is a MEASUREMENT: its answer is recorded in the
 * `level-model:` column and never becomes the dispatch line, and an arm-2 failure (bad JSON, a
 * missing answer) falls back to blind-only, because a measurement must never block a dispatch.
 *
 * Returns `{ level, conf }`, or null when the arm's answer is unusable.
 */
function awareArmLevelModel(raw) {
	try {
		const payload = JSON.parse(raw);
		const answers = payload === null || typeof payload !== "object" ? undefined : payload.answers;
		if (answers === null || typeof answers !== "object" || Array.isArray(answers)) {
			throw new Error('expected the raw classifier response with an "answers" key');
		}
		const level = normalizeChoice(answers.level?.choice, LEVELS, "level", (value) => value.toLowerCase());
		const conf = normalizeConfidence(answers.level?.confidence);
		return { level, conf };
	} catch (error) {
		console.error(
			`jev-check: aware arm ignored — ${describe(error)}. Arm 2 is a measurement; the blind line stands ` +
				"and the dispatch is unaffected.",
		);
		return null;
	}
}

/** A model id is `<provider>/<id>`; anything else is a usage error, never a guessed column. */
function normalizeModelId(value, flag) {
	const id = typeof value === "string" ? value.trim() : "";
	if (!MODEL_ID_PATTERN.test(id)) {
		throw new StructuralError(
			`${flag} needs a model id shaped <provider>/<id> (e.g. openrouter/meta/muse-spark-1.3-contributor, ` +
				`deepseek/deepseek-flash) — got ${JSON.stringify(value)}`,
		);
	}
	return id;
}

// ---------------------------------------------------------------------------
// Mode 4 — settle (`--settle`) and calibration (`--calibrate`).
//
// The provenance row records what the classifier ANSWERED. It can never record what HAPPENED, so
// the apparatus was structurally unable to answer "was this level right for this model". The
// outcome log is that missing half, and it is a SIDECAR keyed by label: a run's result lands on its
// own line, the provenance row stays the exact-text artifact `--require-provenance` matches, and a
// settle can never invalidate a dispatch that already merged.
// ---------------------------------------------------------------------------

/** One sidecar row: `<ts>\t<label>\t<kind>\t<outcome>\t<verdict|null>\t<nits|null>\t<model-ran|null>`. */
function formatOutcomeRow(row) {
	const cell = (value) => (value === null || value === undefined ? OUTCOME_NULL : String(value));
	return [row.at, row.label, row.kind, row.outcome, cell(row.verdict), cell(row.nits), cell(row.modelRan)].join("\t");
}

/**
 * Parse the outcome log. The header carries the cutoff INSTANT for the same reason the provenance
 * log's does: a date-only cutoff treats every same-day run as "since the cutoff".
 */
function parseOutcomesLog(text, path = DEFAULT_OUTCOMES_LOG) {
	let cutoff = null;
	const rows = [];
	const lines = text.split(/\r?\n/);
	for (let index = 0; index < lines.length; index += 1) {
		const raw = lines[index];
		if (raw.trim() === "") continue;
		if (raw.trimStart().startsWith("#")) {
			const trimmed = raw.trim();
			const expected = "the cutoff must be a full ISO instant (YYYY-MM-DDThh:mm:ss.sssZ)";
			if (/\bcutoff\s+\d{4}-\d{2}-\d{2}\s*$/.test(trimmed)) {
				throw new StructuralError(
					`${path}: the "${OUTCOMES_CUTOFF_PREFIX.trim()}" header is date-only — ${expected}; ` +
						`delete ${path} to re-initialize`,
				);
			}
			if (!/\bcutoff\b/.test(trimmed)) continue;
			const match = /\bcutoff\s+(\d{4}-\d{2}-\d{2}T[0-9:.]+Z)\s*$/.exec(trimmed);
			if (match === null) {
				throw new StructuralError(
					`${path}: malformed header ${JSON.stringify(trimmed)} — expected "${OUTCOMES_CUTOFF_PREFIX.trim()}<instant>", ${expected}`,
				);
			}
			cutoff = match[1];
			continue;
		}
		rows.push(parseOutcomeRow(raw, index + 1, path));
	}
	if (rows.length > 0 && cutoff === null) {
		throw new StructuralError(
			`${path}: no "${OUTCOMES_CUTOFF_PREFIX.trim()}" header — the cutoff must be a full ISO instant ` +
				"(YYYY-MM-DDThh:mm:ss.sssZ)",
		);
	}
	return { cutoff, rows };
}

/** Parse one outcome row, fail-closed on every deviation a hand-edit can produce. */
function parseOutcomeRow(raw, lineNumber, path = DEFAULT_OUTCOMES_LOG) {
	const malformed = (why) =>
		new StructuralError(
			`${path}: outcome row at line ${lineNumber} is malformed — ${why}; expected ` +
				"<ts>\\t<label>\\t<kind>\\t<outcome>\\t<verdict|null>\\t<nits|null>\\t<model-ran|null>",
		);
	const parts = raw.split("\t").map((part) => part.trim());
	if (parts.length !== OUTCOMES_ROW_COLUMNS) {
		throw malformed(`${parts.length} tab-separated column(s), expected ${OUTCOMES_ROW_COLUMNS}`);
	}
	const [at, label, kind, outcome, verdict, nits, modelRan] = parts;
	if (at === "" || label === "") throw malformed("the timestamp or the label column is empty");
	if (!OUTCOME_KINDS.includes(kind)) throw malformed(`kind ${JSON.stringify(kind)} is not one of ${OUTCOME_KINDS.join(" | ")}`);
	if (!OUTCOME_VALUES.includes(outcome)) {
		throw malformed(`outcome ${JSON.stringify(outcome)} is not one of ${OUTCOME_VALUES.join(" | ")}`);
	}
	if (verdict !== OUTCOME_NULL && !OUTCOME_VERDICTS.includes(verdict)) {
		throw malformed(`verdict ${JSON.stringify(verdict)} is not one of ${OUTCOME_VERDICTS.join(" | ")} or null`);
	}
	if (nits !== OUTCOME_NULL && !/^\d+$/.test(nits)) {
		throw malformed(`nits ${JSON.stringify(nits)} is not a non-negative integer or null`);
	}
	if (modelRan !== OUTCOME_NULL && !MODEL_ID_PATTERN.test(modelRan)) {
		throw malformed(`model-ran ${JSON.stringify(modelRan)} is not <provider>/<id> or null`);
	}
	return {
		at,
		label,
		kind,
		outcome,
		verdict: verdict === OUTCOME_NULL ? null : verdict,
		nits: nits === OUTCOME_NULL ? null : Number(nits),
		modelRan: modelRan === OUTCOME_NULL ? null : modelRan,
	};
}

/**
 * Read the outcome log. ENOENT is NOT an error — it means "never settled" and the caller says so in
 * one line, with no comparison (case 2 of the no-data matrix). A 0-byte file is the opposite: it is
 * a truncated write, and reading it as "zero settles" would silently erase the cohort.
 */
function loadOutcomes(path = DEFAULT_OUTCOMES_LOG) {
	let text;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return { absent: true, cutoff: null, rows: [] };
		throw new StructuralError(`${path}: cannot read the outcome log (${describe(error)})`);
	}
	if (text.trim() === "") {
		throw new StructuralError(
			`${path}: empty outcome file — delete it to re-initialize (a 0-byte file is a truncated write, ` +
				"not \"zero settles\")",
		);
	}
	return parseOutcomesLog(text, path);
}

/** Append one outcome row, creating the file and its cutoff header on first use. */
function appendOutcomeEntry(path, row, now = new Date()) {
	let existing = null;
	try {
		existing = readFileSync(path, "utf8");
	} catch (error) {
		if (error.code !== "ENOENT") throw new StructuralError(`${path}: cannot read the outcome log (${describe(error)})`);
	}
	if (existing !== null && existing.trim() === "") {
		throw new StructuralError(`${path}: empty outcome file — delete it to re-initialize (refusing to append into a truncated file)`);
	}
	const header = existing === null ? `${OUTCOMES_CUTOFF_PREFIX}${now.toISOString()}\n` : "";
	mkdirSync(dirname(path), { recursive: true });
	appendFileSync(path, `${header}${formatOutcomeRow({ ...row, at: now.toISOString() })}\n`);
}

/**
 * Settle one dispatch: append what happened, keyed by the label its provenance row carries.
 *
 * Every refusal is a StructuralError (exit 2) rather than a repaired row: an unknown label, a
 * duplicate settle, an unknown kind/outcome/verdict, `--nits` without a verdict or a non-integer,
 * and a malformed `--model-ran`. A settle that guessed would poison the only ground truth there is.
 */
function reportSettle(label, options = {}, outcomesPath = DEFAULT_OUTCOMES_LOG, provenancePath = DEFAULT_PROVENANCE_LOG) {
	const { kind, outcome, verdict = null, nits = null, modelRan = null } = options;
	if (typeof label !== "string" || label.trim() === "") {
		throw new StructuralError("--settle needs the dispatch label — the same one the provenance row carries");
	}
	const name = label.trim();
	if (!OUTCOME_KINDS.includes(kind)) {
		throw new StructuralError(
			`--settle needs --kind ${OUTCOME_KINDS.join("|")} (got ${JSON.stringify(kind)}) — reviews are recorded ` +
				"but excluded from level calibration: a changes-requested review is a GOOD review, not a level failure",
		);
	}
	if (!OUTCOME_VALUES.includes(outcome)) {
		throw new StructuralError(`--settle needs --outcome ${OUTCOME_VALUES.join("|")} (got ${JSON.stringify(outcome)})`);
	}
	if (verdict !== null && !OUTCOME_VERDICTS.includes(verdict)) {
		throw new StructuralError(
			`--settle --verdict must be ${OUTCOME_VERDICTS.join("|")} (got ${JSON.stringify(verdict)})`,
		);
	}
	if (nits !== null && verdict === null) {
		throw new StructuralError("--settle --nits needs --verdict — a nit count without a verdict names no review");
	}
	if (nits !== null && !Number.isInteger(nits)) {
		throw new StructuralError(`--settle --nits must be a non-negative integer (got ${JSON.stringify(nits)})`);
	}
	if (modelRan !== null) normalizeModelId(modelRan, "--settle --model-ran");
	const provenance = loadProvenance(provenancePath);
	if (!provenance.entries.some((entry) => entry.label === name)) {
		throw new StructuralError(
			`${provenancePath}: no provenance row labels ${JSON.stringify(name)} — a settle joins the classification it ` +
				`settles; print the dispatch line with --classifier … --label ${name} first`,
		);
	}
	const previous = loadOutcomes(outcomesPath).rows.find((row) => row.label === name);
	if (previous !== undefined) {
		throw new StructuralError(
			`${outcomesPath}: ${JSON.stringify(name)} is already settled (${previous.outcome} at ${previous.at}) — a settle ` +
				"is append-only and is never overwritten; correct the line in place if it is wrong",
		);
	}
	appendOutcomeEntry(outcomesPath, { label: name, kind, outcome, verdict, nits, modelRan });
	console.log(
		`jev-check: settled ${JSON.stringify(name)} — ${kind} ${outcome}` +
			`${verdict === null ? "" : ` ${verdict}`}${nits === null ? "" : ` (${nits} nit(s))`}` +
			`${modelRan === null ? "" : ` ran ${modelRan}`} → ${outcomesPath}`,
	);
	return 0;
}

/**
 * The eligible cohort: implementation dispatches with a terminal-ish outcome, and a verdict for
 * `done`. `unknown`/`stopped` are gaps (never inferred), and `review`/`probe` are a different
 * question — a review's verdict grades the change, not the reviewer's thinking level.
 */
function isCalibrationEligible(row) {
	if (row.kind !== "impl") return false;
	if (row.outcome !== "done" && row.outcome !== "failed") return false;
	return row.outcome !== "done" || row.verdict !== null;
}

/** The observed-sufficient set: a `done` implementation that came back approve/approve-with-nits. */
function isObservedSufficient(row) {
	return row.outcome === "done" && (row.verdict === "approve" || row.verdict === "approve-with-nits");
}

/** The level of a recorded dispatch line, or null when the line is unparseable. */
function levelOfDispatchLine(line) {
	const match = DISPATCH_LINE_PATTERN.exec(line);
	return match === null ? null : match[1].toLowerCase();
}

/** One line per model bucket: counts, both arms' agreement, and the delta the aware arm moved. */
function formatCalibrationRow(bucket) {
	const aware = bucket.awareN === 0 ? "——" : `${bucket.awareAgree}/${bucket.awareN}`;
	const delta =
		bucket.awareN === 0
			? "——"
			: `above ${bucket.delta.above} · below ${bucket.delta.below} · equal ${bucket.delta.equal}`;
	return (
		bucket.model.padEnd(42) +
		String(bucket.n).padStart(3) +
		String(bucket.sufficient).padStart(6) +
		`${bucket.blindAgree}/${bucket.n}`.padStart(13) +
		aware.padStart(12) +
		`  ${delta}`
	);
}

/** The empty accumulators for one model bucket (and for the totals row — same shape, one source). */
function emptyBucket(model) {
	return { model, n: 0, sufficient: 0, blindAgree: 0, awareN: 0, awareAgree: 0, delta: { above: 0, below: 0, equal: 0 } };
}

/**
 * Fold the eligible rows into per-model buckets: counts, the observed-sufficient count, both arms'
 * agreement with the DISPATCHED level, and the direction the aware arm moved. Rows whose model is
 * recorded nowhere land in `(unstated)` — legacy rows are shown, never hidden.
 */
function collectCalibrationBuckets(eligible, byLabel) {
	const rank = new Map(LEVELS.map((level, index) => [level, index]));
	const buckets = new Map();
	for (const row of eligible) {
		const entry = byLabel.get(row.label);
		const dispatched = levelOfDispatchLine(entry.line);
		const aware = entry.levelModel === null ? null : entry.levelModel.level;
		const model = row.modelRan ?? entry.model ?? MODEL_UNSTATED;
		if (!buckets.has(model)) buckets.set(model, emptyBucket(model));
		const bucket = buckets.get(model);
		bucket.n += 1;
		if (isObservedSufficient(row)) bucket.sufficient += 1;
		// The blind arm's answer IS the recorded line, so this compares it with the dispatched level
		// literally — tautological by construction, which is why the output says so out loud.
		const blind = dispatched;
		if (blind === dispatched) bucket.blindAgree += 1;
		if (aware !== null) {
			bucket.awareN += 1;
			if (aware === dispatched) bucket.awareAgree += 1;
			const delta = rank.get(aware) - rank.get(dispatched);
			if (delta > 0) bucket.delta.above += 1;
			else if (delta < 0) bucket.delta.below += 1;
			else bucket.delta.equal += 1;
		}
	}
	const totals = emptyBucket("total");
	for (const bucket of buckets.values()) {
		totals.n += bucket.n;
		totals.sufficient += bucket.sufficient;
		totals.blindAgree += bucket.blindAgree;
		totals.awareN += bucket.awareN;
		totals.awareAgree += bucket.awareAgree;
		totals.delta.above += bucket.delta.above;
		totals.delta.below += bucket.delta.below;
		totals.delta.equal += bucket.delta.equal;
	}
	const sorted = [...buckets.values()].sort((a, b) => b.n - a.n || a.model.localeCompare(b.model));
	return { sorted, totals, unstated: (buckets.get(MODEL_UNSTATED) ?? { n: 0 }).n };
}

/**
 * `--calibrate`: join the sidecar to the provenance log and print a comparison — never a ranking.
 *
 * No-data precedence is deliberate: the PROVENANCE log is checked first (a missing classification
 * log makes every join meaningless), then the sidecar's absence/emptiness/header/rows, then the
 * join, then the cohort. Each case has its own exit code and message; none of them is a silent pass.
 */
function reportCalibration(provenancePath = DEFAULT_PROVENANCE_LOG, outcomesPath = DEFAULT_OUTCOMES_LOG) {
	const provenance = loadProvenance(provenancePath);
	const outcomes = loadOutcomes(outcomesPath);
	if (outcomes.absent) {
		console.log(
			`jev-check: --calibrate: no settle data yet (${outcomesPath} does not exist) — nothing to compare; ` +
				"settle a closed dispatch with --settle <label> --kind impl --outcome done --verdict <verdict>",
		);
		return 0;
	}
	const byLabel = new Map(provenance.entries.map((entry) => [entry.label, entry]));
	for (const row of outcomes.rows) {
		const entry = byLabel.get(row.label);
		if (entry === undefined) {
			throw new StructuralError(
				`${outcomesPath}: the settle row for ${JSON.stringify(row.label)} has no provenance row in ${provenancePath} — ` +
					"an orphan settle cannot be joined to a classification",
			);
		}
		if (levelOfDispatchLine(entry.line) === null) {
			throw new StructuralError(
				`${provenancePath}: the provenance row for ${JSON.stringify(row.label)} carries no parseable ` +
					`jev: line — ${JSON.stringify(entry.line)}`,
			);
		}
	}
	const eligible = outcomes.rows.filter(isCalibrationEligible);
	const withModel = eligible.filter((row) => (row.modelRan ?? byLabel.get(row.label).model) !== null).length;
	console.log(
		`jev-check: --calibrate: eligible ${eligible.length} / settled ${outcomes.rows.length} / with-model ${withModel}`,
	);
	console.log(
		"jev-check: cohort = kind=impl, outcome done|failed, and a verdict for done — reviews, probes, unknown " +
			"and stopped are not eligible",
	);
	if (outcomes.rows.length === 0) {
		console.log("jev-check: 0 settled — the header exists and carries no rows yet; nothing to compare.");
		return 0;
	}
	if (eligible.length === 0) {
		console.log("jev-check: no eligible implementation dispatches (N=0) — nothing to compare.");
		return 0;
	}
	if (eligible.length < CALIBRATION_MIN_ROWS) {
		console.log(
			`jev-check: no conclusion (N<20) — ${eligible.length} eligible row(s); the comparison needs ` +
				`${CALIBRATION_MIN_ROWS}, because a table that ranks on a handful of rows is the same theatre in a new costume.`,
		);
		return 0;
	}

	const { sorted, totals, unstated } = collectCalibrationBuckets(eligible, byLabel);
	console.log(
		"jev-check: bias: both arms are scored against the conductor's DISPATCHED level — which is the blind " +
			"line as recorded, so blind agreement is 100% by construction — over runs that worked. That is a " +
			"comparison, not ground truth.",
	);
	console.log(
		"jev-check: observed-sufficient = the dispatched level of a done + approve/approve-with-nits row; " +
			"limit: levels are as REQUESTED, not as capped",
	);
	console.log("");
	console.log(
		"model".padEnd(42) +
			"N".padStart(3) +
			"suff".padStart(6) +
			"blind=disp".padStart(13) +
			"aware=disp".padStart(12) +
			"  delta (aware vs disp)",
	);
	for (const bucket of sorted) console.log(formatCalibrationRow(bucket));
	console.log(formatCalibrationRow(totals));
	console.log(
		`jev-check: ${sorted.length} model bucket(s), ${withModel}/${eligible.length} eligible row(s) record a model — ` +
			`${eligible.length - unstated} with an id, ${unstated} ${MODEL_UNSTATED}`,
	);
	console.log(
		"jev-check: no ranking — this names no winner. The falsifier (ADR 0025) is decided on this cohort at " +
			`N >= ${CALIBRATION_MIN_ROWS}: if the aware arm is no better than blind, the model input is deleted and the ` +
			"ledger and settle lines stay.",
	);
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
function dispatchEvent(timestamp, task, message = DISPATCH_EVENT_MESSAGE, agentId = "fixture-agent") {
	return JSON.stringify({
		timestamp,
		level: "info",
		prefix: "brl-subagent",
		message,
		data: { agentId, task, model: "fixture/model" },
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

/** Assert a refusal is the exit-2 class (a StructuralError), not the exit-1 finding class. */
function assertStructural(run, messagePattern, label) {
	const error = assertRejects(run, messagePattern, label);
	if (!(error instanceof StructuralError)) {
		throw new Error(`${label}: expected a StructuralError (exit 2), got ${error.constructor.name}`);
	}
	return error;
}

/** Run a mode, capture its stdout/stderr, and restore the console — a case can then assert messages. */
function captureConsole(run) {
	const out = [];
	const err = [];
	const original = { log: console.log, error: console.error };
	console.log = (...args) => out.push(args.join(" "));
	console.error = (...args) => err.push(args.join(" "));
	try {
		const code = run();
		return { code, out: out.join("\n"), err: err.join("\n") };
	} finally {
		console.log = original.log;
		console.error = original.error;
	}
}

const PROVENANCE_HEADER = "# jev-lines provenance — cutoff 2026-11-01T00:00:00.000Z";
const OUTCOMES_HEADER = "# jev-outcomes — cutoff 2026-11-01T00:00:00.000Z";
const FIXTURE_LINE = "jev: medium (0.84) · C2 · worktree y";

/** One provenance row; `extra` columns are appended verbatim as keyed columns. */
function provenanceRow(label, line, ...extra) {
	return ["2026-11-08T01:00:00.000Z", label, line, ...extra].join("\t");
}

function provenanceLogFixture(...rows) {
	return [PROVENANCE_HEADER, ...rows].join("\n");
}

function outcomeRow(label, kind, outcome, verdict = null, nits = null, modelRan = null) {
	const cell = (value) => (value === null ? "null" : String(value));
	return ["2026-11-08T02:00:00.000Z", label, kind, outcome, cell(verdict), cell(nits), cell(modelRan)].join("\t");
}

function outcomesLogFixture(...rows) {
	return [OUTCOMES_HEADER, ...rows].join("\n");
}

/** Read a file, or null when it does not exist — a refusal must not create state. */
function readIfExists(path) {
	try {
		return readFileSync(path, "utf8");
	} catch (error) {
		if (error.code === "ENOENT") return null;
		throw error;
	}
}

/** Run a case against a scratch provenance/outcome pair, cleaned up even when it throws. */
function withTempPair(write, run) {
	const dir = mkdtempSync(join(tmpdir(), "jev-468-"));
	try {
		const paths = { provenance: join(dir, "jev-lines.log"), outcomes: join(dir, "jev-outcomes.log") };
		write(paths);
		return run(paths);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/**
 * The `N >= 20` fixture: 24 eligible rows, three model buckets, both arms, `--model-ran` overriding
 * the provenance model for rows 12–19, and four `done` + `changes-requested` rows that must NOT
 * count as observed-sufficient. Expectations are counted BY HAND here, never derived from the code
 * under test: muse 12 (aware 6/12 — 6 equal, 6 below) · deepseek 8 (aware 0/8 — 8 above) ·
 * (unstated) 4 (no aware column). Totals: 24 eligible, sufficient 20, blind 24/24, aware 6/20
 * (only rows 0–19 carry an aware answer), delta above 8 · below 6 · equal 6.
 */
function writeCalibrationPair(paths, { rows = 24, withAware = true } = {}) {
	const provenance = [PROVENANCE_HEADER];
	const settled = [OUTCOMES_HEADER];
	for (let index = 0; index < rows; index += 1) {
		const label = `impl-c${index}`;
		const columns = [];
		if (index < 20) columns.push("model:openrouter/meta/muse-spark-1.3-contributor");
		if (withAware && index < 6) columns.push("level-model:minimal (0.6)");
		else if (withAware && index >= 6 && index < 12) columns.push("level-model:medium (0.5)");
		else if (withAware && index >= 12 && index < 20) columns.push("level-model:high (0.7)");
		provenance.push(provenanceRow(label, FIXTURE_LINE, ...columns));
		const verdict = index >= 20 ? "changes-requested" : "approve";
		const modelRan = index >= 12 && index < 20 ? "deepseek/deepseek-flash" : null;
		settled.push(outcomeRow(label, "impl", "done", verdict, null, modelRan));
	}
	writeFileSync(paths.provenance, `${provenance.join("\n")}\n`);
	writeFileSync(paths.outcomes, `${settled.join("\n")}\n`);
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
		name: "--log: a recorded exception acknowledges an offender without hiding it",
		run() {
			const { offenders, excepted } = analyzeDispatchLog(
				dispatchLogFixture(
					dispatchEvent("2026-10-28T09:00:00.000Z", "Legacy dispatch — no jev line.", DISPATCH_EVENT_MESSAGE, "a49e6e4f-ec0f-4540-b98c-b4aae0a197a5"),
				),
				STRICT_DISPATCH_CUTOFF,
				[{ prefix: "a49e6e4f", reason: "classified high (0.39), line not pasted — conductor error" }],
			);
			assertEqual(offenders.length, 0, "offenders");
			assertEqual(excepted.length, 1, "excepted");
			if (!/line not pasted/.test(excepted[0].exception)) {
				throw new Error(`excepted reason: got ${JSON.stringify(excepted[0].exception)}`);
			}
		},
	},
	{
		name: "--log: a non-matching exception does not hide an offender (prefix match, case-insensitive)",
		run() {
			const { offenders, excepted } = analyzeDispatchLog(
				dispatchLogFixture(
					dispatchEvent("2026-10-28T09:00:00.000Z", "No line here.", DISPATCH_EVENT_MESSAGE, "bbbbbbbb-0000-0000-0000-000000000000"),
				),
				STRICT_DISPATCH_CUTOFF,
				[{ prefix: "aaaaaaaa", reason: "some other dispatch" }],
			);
			assertEqual(offenders.length, 1, "offenders");
			assertEqual(excepted.length, 0, "excepted");

			const upper = analyzeDispatchLog(
				dispatchLogFixture(
					dispatchEvent("2026-10-28T09:00:00.000Z", "No line here.", DISPATCH_EVENT_MESSAGE, "ABCDEF12-0000-0000-0000-000000000000"),
				),
				STRICT_DISPATCH_CUTOFF,
				[{ prefix: "abcdef12", reason: "case-insensitive prefix" }],
			);
			assertEqual(upper.offenders.length, 0, "case-insensitive offenders");
			assertEqual(upper.excepted.length, 1, "case-insensitive excepted");
		},
	},
	{
		name: "--log: an exception prefix matching MID-STRING does not except (startsWith, not includes)",
		run() {
			const { offenders, excepted } = analyzeDispatchLog(
				dispatchLogFixture(
					dispatchEvent("2026-10-28T09:00:00.000Z", "No line here.", DISPATCH_EVENT_MESSAGE, "aaaabbbb-cccc-dddd-eeee-ffffffffffff"),
				),
				STRICT_DISPATCH_CUTOFF,
				[{ prefix: "bbbb", reason: "matches only mid-string" }],
			);
			assertEqual(offenders.length, 1, "mid-string offenders");
			assertEqual(excepted.length, 0, "mid-string excepted");
		},
	},

	{
		name: "--log: a valid line is never excepted (exceptions do not launder a clean dispatch)",
		run() {
			const { offenders, excepted } = analyzeDispatchLog(
				dispatchLogFixture(
					dispatchEvent("2026-10-28T09:00:00.000Z", "Task.\n\njev: medium (0.88) · C2 · worktree y", DISPATCH_EVENT_MESSAGE, "a49e6e4f-0000-0000-0000-000000000000"),
				),
				STRICT_DISPATCH_CUTOFF,
				[{ prefix: "a49e6e4f", reason: "unused" }],
			);
			assertEqual(offenders.length, 0, "offenders");
			assertEqual(excepted.length, 0, "excepted");
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
	// --- provenance --------------------------------------------------------
	{
		name: "--line --label: the printed line is appended with a cutoff header",
		run() {
			const dir = mkdtempSync(join(tmpdir(), "jev-provenance-"));
			try {
				const path = join(dir, "jev-lines.log");
				const now = new Date("2026-11-02T10:00:00.000Z");
				appendProvenanceEntry(path, "jev: medium (0.84) · C2 · worktree y", "impl", now);
				appendProvenanceEntry(path, "jev: high (0.44) · C1 · worktree n", "review", now);
				const text = readFileSync(path, "utf8");
				const parsed = parseProvenanceLog(text);
				assertEqual(parsed.cutoff, "2026-11-02T10:00:00.000Z", "cutoff from the header (full instant)");
				assertEqual(parsed.entries.length, 2, "entries");
				assertEqual(parsed.entries[0].label, "impl", "label");
				assertEqual(parsed.entries[0].line, "jev: medium (0.84) · C2 · worktree y", "line");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	},
	{
		name: "--line --label parsing: the label is optional and detached from the JSON",
		run() {
			const withLabel = parseLineArgs(['{"level":"medium","conf":0.84,"risk":"C2","worktree":true}', "--label", "impl"]);
			assertEqual(withLabel.label, "impl", "label");
			assertEqual(JSON.parse(withLabel.raw).level, "medium", "raw json");
			const withoutLabel = parseLineArgs(['{"level":"medium","conf":0.84,"risk":"C2","worktree":true}']);
			assertEqual(withoutLabel.label, undefined, "no label");
		},
	},
	{
		name: "--classifier: derives the line from the raw answers object",
		run() {
			const line = classifierPayloadToLine(
				JSON.stringify({
					answers: {
						level: { choice: "medium", confidence: 0.63 },
						risk: { choice: "C1" },
						worktree: { probability: 0.85 },
					},
				}),
			);
			assertEqual(line, "jev: medium (0.63) \u00b7 C1 \u00b7 worktree y", "derived line");
		},
	},
	{
		name: "--classifier --worktree: a stated process fact wins over the probability (#456)",
		run() {
			const raw = JSON.stringify({
				answers: {
					level: { choice: "medium", confidence: 0.64 },
					risk: { choice: "C2" },
					worktree: { probability: 0.14 },
				},
			});
			// The classifier says n (p=0.14); Rule 5 says a src change runs in a worktree.
			assertEqual(
				classifierPayloadToLine(raw, true),
				"jev: medium (0.64) \u00b7 C2 \u00b7 worktree y",
				"stated y wins",
			);
			// No override = the model answer, unchanged.
			assertEqual(
				classifierPayloadToLine(raw, undefined),
				"jev: medium (0.64) \u00b7 C2 \u00b7 worktree n",
				"no override",
			);
			// A stated value that AGREES is still recorded as stated (it is the conductor's claim).
			assertEqual(
				classifierPayloadToLine(raw, false),
				"jev: medium (0.64) \u00b7 C2 \u00b7 worktree n",
				"stated n",
			);
		},
	},
	{
		name: "--classifier --worktree: the provenance row marks the field as STATED, line unchanged",
		run() {
			const dir = mkdtempSync(join(tmpdir(), "jev-stated-"));
			try {
				const path = join(dir, "prov.log");
				const raw = JSON.stringify({
					answers: {
						level: { choice: "high", confidence: 0.71 },
						risk: { choice: "C1" },
						worktree: { probability: 0.22 },
					},
				});
				const line = classifierPayloadToLine(raw, true);
				appendProvenanceEntry(path, line, "impl-456", new Date("2026-11-07T13:00:00.000Z"), { stated: "worktree" });
				const text = readFileSync(path, "utf8");
				const row = text.split("\n").find((l) => l.includes("impl-456"));
				assertEqual(
					row,
					"2026-11-07T13:00:00.000Z\timpl-456\tjev: high (0.71) \u00b7 C1 \u00b7 worktree y\tstated:worktree",
					"row carries the stated marker",
				);
				const parsed = parseProvenanceLog(text);
				assertEqual(parsed.entries.length, 1, "row parses");
				assertEqual(parsed.entries[0].line, line, "parsed line is the exact printed line");
				assertEqual(parsed.entries[0].stated, "worktree", "stated field recorded");
			} finally {
				rmSync(dir, { recursive: true, force: true });
			}
		},
	},
	{
		name: "--worktree: only y|n is accepted, and --line refuses it",
		run() {
			let rejected = false;
			try {
				parseLineArgs(["{}", "--worktree", "maybe"]);
			} catch (error) {
				rejected = /must be y or n/.test(error.message);
			}
			assertEqual(rejected, true, "invalid value rejected");
			// A provenance row without the marker still parses (backwards compatible).
			const parsed = parseProvenanceLog("2026-11-07T13:00:00.000Z\timpl\tjev: low (0.9) \u00b7 C2 \u00b7 worktree n\n");
			assertEqual(parsed.entries[0].stated, null, "no marker = null");
			// Garbage in the fourth column is still fail-closed.
			let malformed = false;
			try {
				parseProvenanceLog("2026-11-07T13:00:00.000Z\timpl\tjev: low (0.9) \u00b7 C2 \u00b7 worktree n\tnonsense\n");
			} catch (error) {
				malformed = /malformed/.test(error.message);
			}
			assertEqual(malformed, true, "garbage fourth column rejected");
		},
	},
	{
		name: "--classifier: a summary object (not the raw answers) is the skipped form",
		run() {
			let message = "";
			try {
				classifierPayloadToLine('{"level":"medium","conf":0.63,"risk":"C1","worktree":true}');
			} catch (error) {
				message = error.message;
			}
			if (!/raw classifier response/.test(message)) {
				throw new Error(`expected a raw-response rejection, got ${JSON.stringify(message)}`);
			}
		},
	},
	{
		name: "--classifier: a missing worktree probability is rejected",
		run() {
			let message = "";
			try {
				classifierPayloadToLine('{"answers":{"level":{"choice":"medium","confidence":0.63},"risk":{"choice":"C1"}}}');
			} catch (error) {
				message = error.message;
			}
			if (!/answers\.worktree\.probability/.test(message)) {
				throw new Error(`expected a probability rejection, got ${JSON.stringify(message)}`);
			}
		},
	},
	{
		name: "--line --label without --legacy-line is refused (format-only cannot claim a classifier)",
		run() {
			let message = "";
			try {
				reportLine('{"level":"medium","conf":0.63,"risk":"C1","worktree":true}', "impl", false);
			} catch (error) {
				message = error.message;
			}
			if (!/format-only/.test(message)) {
				throw new Error(`expected the format-only refusal, got ${JSON.stringify(message)}`);
			}
			const parsed = parseLineArgs(['{"level":"medium","conf":0.63,"risk":"C1","worktree":true}', "--label", "impl", "--legacy-line"]);
			assertEqual(parsed.legacy, true, "legacy acknowledged");
		},
	},
	{
		name: "--line --legacy-line --label writes NO provenance row (#452: a line cannot be its own evidence)",
		run() {
			const dir = mkdtempSync(join(tmpdir(), "jev-legacy-"));
			const path = join(dir, "jev-lines.log");
			const read = () => {
				try {
					return readFileSync(path, "utf8");
				} catch {
					return "";
				}
			};
			const payload = '{"level":"high","conf":0.62,"risk":"C2","worktree":false}';
			reportLine(payload, "spoofed", true);
			assertEqual(read(), "", "a legacy line must not mint a row");
			// Control: the CLASSIFIER path DOES write one, so the assertion above discriminates.
			reportClassifier(
				JSON.stringify({ answers: { level: { choice: "high", confidence: 0.62 }, risk: { choice: "C2" }, worktree: { probability: 0.2 } } }),
				"legit",
				path,
			);
			if (!/\tlegit\t/.test(read())) {
				throw new Error("the control row was not written — the assertion above proves nothing");
			}
			rmSync(dir, { recursive: true, force: true });
		},
	},
	{
		name: "--require-provenance: a formatted line with NO provenance row is an offender",
		run() {
			const { offenders } = analyzeDispatchLog(
				dispatchLogFixture(dispatchEvent("2026-11-02T09:00:00.000Z", "Task.\n\njev: medium (0.84) · C2 · worktree y")),
				STRICT_DISPATCH_CUTOFF,
				[],
				{ cutoff: "2026-11-01T00:00:00.000Z", lines: new Set() },
			);
			assertEqual(offenders.length, 1, "offenders");
			if (!/no classifier provenance/.test(offenders[0].reason)) {
				throw new Error(`offender reason: expected /no classifier provenance/, got ${JSON.stringify(offenders[0].reason)}`);
			}
		},
	},
	{
		name: "--require-provenance: a provenance miss carrying retro:<label> is ACKNOWLEDGED, never clean",
		run() {
			// The 2026-11-07 case: a hand-typed line, no provenance row. The exception names the
			// retrospective row; the dispatch is still reported as an offender that was excused.
			const { offenders, excepted } = analyzeDispatchLog(
				dispatchLogFixture(dispatchEvent("2026-11-02T09:00:00.000Z", "Triage.\n\njev: high (0.62) · C2 · worktree n")),
				STRICT_DISPATCH_CUTOFF,
				[
					{
						prefix: "fixture-agent",
						reason: "hand-typed line, no classifier run — conductor error; retrospective row retro:retro-triage",
						retro: "retro-triage",
					},
				],
				{ cutoff: "2026-11-01T00:00:00.000Z", lines: new Set(), labels: new Set(["retro-triage"]) },
			);
			assertEqual(offenders.length, 0, "offenders");
			assertEqual(excepted.length, 1, "excepted");
			assertEqual(excepted[0].kind, "provenance", "excepted kind");
			if (!/retro-triage/.test(excepted[0].exception)) {
				throw new Error(`excepted reason must keep the evidence: ${JSON.stringify(excepted[0].exception)}`);
			}
		},
	},
	{
		name: "--require-provenance: a retro exception naming a NON-EXISTENT label stays an offender",
		run() {
			const { offenders, excepted } = analyzeDispatchLog(
				dispatchLogFixture(dispatchEvent("2026-11-02T09:00:00.000Z", "Triage.\n\njev: high (0.62) · C2 · worktree n")),
				STRICT_DISPATCH_CUTOFF,
				[{ prefix: "fixture-agent", reason: "sorry — retro:does-not-exist", retro: "does-not-exist" }],
				{ cutoff: "2026-11-01T00:00:00.000Z", lines: new Set(), labels: new Set(["retro-triage"]) },
			);
			assertEqual(offenders.length, 1, "offenders");
			assertEqual(excepted.length, 0, "nothing excused on an unusable excuse");
			if (!/not usable/.test(offenders[0].reason)) {
				throw new Error(`offender must say why the excuse failed: ${JSON.stringify(offenders[0].reason)}`);
			}
		},
	},
	{
		name: "--require-provenance: a PROSE-ONLY exception (no retro: label) stays an offender",
		run() {
			const { offenders, excepted } = analyzeDispatchLog(
				dispatchLogFixture(dispatchEvent("2026-11-02T09:00:00.000Z", "Triage.\n\njev: high (0.62) · C2 · worktree n")),
				STRICT_DISPATCH_CUTOFF,
				[{ prefix: "fixture-agent", reason: "I promise this was classified, sorry", retro: null }],
				{ cutoff: "2026-11-01T00:00:00.000Z", lines: new Set(), labels: new Set(["retro-triage"]) },
			);
			assertEqual(offenders.length, 1, "offenders");
			assertEqual(excepted.length, 0, "prose alone never excuses");
			if (!/no retro:<label>/.test(offenders[0].reason)) {
				throw new Error(`offender must name the missing marker: ${JSON.stringify(offenders[0].reason)}`);
			}
		},
	},
	{
		name: "--require-provenance: an exception cannot launder a dispatch whose line HAS provenance",
		run() {
			const line = "jev: medium (0.84) · C2 · worktree y";
			const { offenders, excepted } = analyzeDispatchLog(
				dispatchLogFixture(dispatchEvent("2026-11-02T09:00:00.000Z", `Task.\n\n${line}`)),
				STRICT_DISPATCH_CUTOFF,
				[{ prefix: "fixture-agent", reason: "claimed error — retro:retro-triage", retro: "retro-triage" }],
				{ cutoff: "2026-11-01T00:00:00.000Z", lines: new Set([line]), labels: new Set(["retro-triage"]) },
			);
			assertEqual(offenders.length, 0, "offenders");
			assertEqual(excepted.length, 0, "a clean dispatch is never excepted");
		},
	},
	{
		name: "--require-provenance: `retro:` in prose is parsed, but only a real label excuses",
		run() {
			const parsed = loadDispatchExceptions(join(tmpdir(), "jev-retro-parser", "missing"));
			assertEqual(parsed.length, 0, "missing file means no exceptions");
			const marker = parseProvenanceExceptionMarker("no classifier run; retrospective row retro:retro-triage-449 end");
			assertEqual(marker, "retro-triage-449", "marker extraction");
			assertEqual(parseProvenanceExceptionMarker("no marker here"), null, "absent marker");
		},
	},
	{
		name: "--require-provenance: a line printed by --line passes",
		run() {
			const { offenders } = analyzeDispatchLog(
				dispatchLogFixture(dispatchEvent("2026-11-02T09:00:00.000Z", "Task.\n\njev: medium (0.84) · C2 · worktree y")),
				STRICT_DISPATCH_CUTOFF,
				[],
				{ cutoff: "2026-11-01T00:00:00.000Z", lines: new Set(["jev: medium (0.84) · C2 · worktree y"]) },
			);
			assertEqual(offenders.length, 0, "offenders");
		},
	},
	{
		name: "--require-provenance: the hand-typed 0.70 line is caught (2026-10-31 fixture)",
		run() {
			// The live case: a dispatch carried `medium (0.70)`; the classifier had answered high (0.32).
			const { offenders } = analyzeDispatchLog(
				dispatchLogFixture(dispatchEvent("2026-11-02T09:00:00.000Z", "Critique the plan.\n\njev: medium (0.7) · C2 · worktree n")),
				STRICT_DISPATCH_CUTOFF,
				[],
				{ cutoff: "2026-11-01T00:00:00.000Z", lines: new Set(["jev: high (0.32) · C2 · worktree n"]) },
			);
			assertEqual(offenders.length, 1, "offenders");
		},
	},
	{
		name: "--require-provenance: `jev: unavailable` is exempt (a gap has nothing to prove)",
		run() {
			const { offenders } = analyzeDispatchLog(
				dispatchLogFixture(dispatchEvent("2026-11-02T09:00:00.000Z", "Task.\n\njev: unavailable")),
				STRICT_DISPATCH_CUTOFF,
				[],
				{ cutoff: "2026-11-01T00:00:00.000Z", lines: new Set() },
			);
			assertEqual(offenders.length, 0, "offenders");
		},
	},
	{
		name: "--require-provenance: a SAME-DAY dispatch before the log's creation instant is exempt (2026-10-31 live case)",
		run() {
			// The live bug: the header carried a DATE, so every dispatch earlier that day was
			// treated as "since the cutoff" and flagged. The cutoff is the creation instant.
			const { offenders } = analyzeDispatchLog(
				dispatchLogFixture(dispatchEvent("2026-10-31T04:55:14.181Z", "Task.\n\njev: medium (0.72) · C1 · worktree y")),
				STRICT_DISPATCH_CUTOFF,
				[],
				{ cutoff: "2026-10-31T07:54:32.046Z", lines: new Set() },
			);
			assertEqual(offenders.length, 0, "offenders");
		},
	},
	{
		name: "--require-provenance: a SAME-DAY dispatch after the log's creation instant needs a row",
		run() {
			const { offenders } = analyzeDispatchLog(
				dispatchLogFixture(dispatchEvent("2026-10-31T08:10:00.000Z", "Task.\n\njev: medium (0.76) · C2 · worktree y")),
				STRICT_DISPATCH_CUTOFF,
				[],
				{ cutoff: "2026-10-31T07:54:32.046Z", lines: new Set() },
			);
			assertEqual(offenders.length, 1, "offenders");
		},
	},
	{
		name: "--require-provenance: a DATE-ONLY cutoff header is a structural error (fail-closed)",
		run() {
			assertRejects(
				() => parseProvenanceLog("# jev-lines provenance — cutoff 2026-10-31\n2026-10-31T07:54:32.046Z\tc1\tjev: high (0.46) · C1 · worktree n\n"),
				/date-only/,
				"date-only cutoff",
			);
		},
	},
	{
		name: "--require-provenance: dispatches BEFORE the provenance cutoff are exempt",
		run() {
			const { offenders } = analyzeDispatchLog(
				dispatchLogFixture(dispatchEvent("2026-10-31T09:00:00.000Z", "Task.\n\njev: medium (0.84) · C2 · worktree y")),
				STRICT_DISPATCH_CUTOFF,
				[],
				{ cutoff: "2026-11-01T00:00:00.000Z", lines: new Set() },
			);
			assertEqual(offenders.length, 0, "offenders");
		},
	},
	{
		name: "--require-provenance: a MISSING provenance log is fail-closed (exit 2 class)",
		run() {
			assertRejects(
				() => loadProvenance(join(tmpdir(), "jev-provenance-does-not-exist", "jev-lines.log")),
				/cannot read the provenance log/,
				"missing provenance log",
			);
		},
	},
	{
		name: "--require-provenance: a malformed provenance row is a structural error",
		run() {
			assertRejects(() => parseProvenanceLog("no tabs here\n"), /malformed/, "malformed row");
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

	// --- #468: the provenance row grammar ----------------------------------
	{
		name: "grammar: 3, 4, 5 and 6 columns parse, and the key order is free",
		run() {
			const three = parseProvenanceLog(provenanceRow("impl-3", FIXTURE_LINE));
			assertEqual(three.entries[0].stated, null, "3-col stated");
			assertEqual(three.entries[0].model, null, "3-col model");
			assertEqual(three.entries[0].levelModel, null, "3-col aware");

			const four = parseProvenanceLog(provenanceRow("impl-4", FIXTURE_LINE, "stated:worktree"));
			assertEqual(four.entries[0].stated, "worktree", "4-col stated (the legacy #456 row)");

			const five = parseProvenanceLog(
				provenanceRow("impl-5", FIXTURE_LINE, "model:deepseek/deepseek-flash", "level-model:minimal (0.6)"),
			);
			assertEqual(five.entries[0].model, "deepseek/deepseek-flash", "5-col model");
			assertEqual(five.entries[0].levelModel.level, "minimal", "5-col aware level");
			assertEqual(five.entries[0].levelModel.conf, 0.6, "5-col aware conf");

			const six = parseProvenanceLog(
				provenanceRow(
					"impl-6",
					FIXTURE_LINE,
					"stated:worktree",
					"model:openrouter/meta/muse-spark-1.3-contributor",
					"level-model:high (1)",
				),
			);
			assertEqual(six.entries[0].stated, "worktree", "6-col stated");
			assertEqual(six.entries[0].model, "openrouter/meta/muse-spark-1.3-contributor", "6-col model");
			assertEqual(six.entries[0].levelModel.conf, 1, "6-col conf 1 parses");

			// Same three keyed facts, different order — same entry.
			const orderA = parseProvenanceLog(
				provenanceRow("a", FIXTURE_LINE, "stated:worktree", "model:deepseek/deepseek-flash", "level-model:low (0.4)"),
			).entries[0];
			const orderB = parseProvenanceLog(
				provenanceRow("a", FIXTURE_LINE, "level-model:low (0.4)", "model:deepseek/deepseek-flash", "stated:worktree"),
			).entries[0];
			assertEqual(JSON.stringify(orderA), JSON.stringify(orderB), "key order is free");
		},
	},
	{
		name: "grammar: the four REAL model ids parse (multi-slash included) — and a slashless one does not",
		run() {
			const ids = [
				"openrouter/meta/muse-spark-1.3-contributor",
				"openrouter/~typesafe/jev-latest",
				"deepseek/deepseek-flash",
				"~typesafe/jev-latest",
			];
			for (const id of ids) {
				const parsed = parseProvenanceLog(provenanceRow("impl-model", FIXTURE_LINE, `model:${id}`));
				assertEqual(parsed.entries[0].model, id, `model column ${id}`);
				assertEqual(normalizeModelId(id, "--model"), id, `--model accepts ${id}`);
			}
			// A single-slash-only regex rejects the two multi-slash ids above; this is the other half:
			// a value with no slash at all is not a provider/model id.
			assertStructural(
				() => parseProvenanceLog(provenanceRow("impl-bad", FIXTURE_LINE, "model:jev-latest")),
				/malformed/,
				"slashless model id",
			);
		},
	},
	{
		name: "grammar: unknown key, duplicate key, malformed values are fail-closed",
		run() {
			assertStructural(
				() => parseProvenanceLog(provenanceRow("impl-u", FIXTURE_LINE, "colour:blue")),
				/unknown column/,
				"unknown key",
			);
			assertStructural(
				() =>
					parseProvenanceLog(
						provenanceRow("impl-d", FIXTURE_LINE, "model:deepseek/deepseek-flash", "model:deepseek/deepseek-v4-pro"),
					),
				/duplicate `model:`/,
				"duplicate model",
			);
			assertStructural(
				() => parseProvenanceLog(provenanceRow("impl-d", FIXTURE_LINE, "stated:worktree", "stated:worktree")),
				/duplicate `stated:`/,
				"duplicate stated",
			);
			assertStructural(
				() => parseProvenanceLog(provenanceRow("impl-d", FIXTURE_LINE, "level-model:medium (0.5)", "level-model:low (0.4)")),
				/duplicate `level-model:`/,
				"duplicate aware",
			);
			assertStructural(
				() => parseProvenanceLog(provenanceRow("impl-s", FIXTURE_LINE, "stated:risk")),
				/only stated:worktree/,
				"unsupported stated field",
			);
			assertStructural(
				() => parseProvenanceLog(provenanceRow("impl-lm", FIXTURE_LINE, "level-model:medium")),
				/level-model column/,
				"aware without a confidence",
			);
			assertStructural(
				() => parseProvenanceLog(provenanceRow("impl-lm", FIXTURE_LINE, "level-model:ultra (0.5)")),
				/is not one of/,
				"unknown aware level",
			);
		},
	},
	{
		name: "grammar: conf 1.5 is malformed (the shape matches, the RANGE does not)",
		run() {
			const error = assertStructural(
				() => parseProvenanceLog(provenanceRow("impl-conf", FIXTURE_LINE, "level-model:medium (1.5)")),
				/outside \[0, 1\]/,
				"conf 1.5",
			);
			if (!/malformed/.test(error.message)) throw new Error(`the refusal must read as malformed: ${error.message}`);
			// 0 and 1 are in range and must keep parsing (the range is [0, 1], inclusive).
			assertEqual(
				parseProvenanceLog(provenanceRow("impl-conf", FIXTURE_LINE, "level-model:off (0)")).entries[0].levelModel.conf,
				0,
				"conf 0 parses",
			);
		},
	},
	{
		name: "grammar: a tab in a value, a truncated row and a key before the line are fail-closed",
		run() {
			// A value containing a tab arrives as an EXTRA COLUMN — the structural reason keyed
			// columns exist. It must be refused, not silently re-read as a key.
			assertStructural(
				() => parseProvenanceLog(["2026-11-08T01:00:00.000Z", "impl-tab", "jev: medium", "(0.84) · C2 · worktree y"].join("\t")),
				/unknown column/,
				"tab in a value",
			);
			assertStructural(
				() => parseProvenanceLog("2026-11-08T01:00:00.000Z\timpl-trunc\n"),
				/only 2 tab-separated column/,
				"truncated row",
			);
			assertStructural(
				() => parseProvenanceLog(["2026-11-08T01:00:00.000Z", "impl", FIXTURE_LINE, "stated:worktree", "model:deepseek/deepseek-flash", "level-model:low (0.4)", "model:deepseek/deepseek-flash"].join("\t")),
				/at most 6/,
				"too many columns",
			);
			assertStructural(
				() => parseProvenanceLog(["2026-11-08T01:00:00.000Z", "model:deepseek/deepseek-flash", FIXTURE_LINE].join("\t")),
				/before the line column/,
				"key before the line",
			);
		},
	},

	// --- #468: the CLI arms ------------------------------------------------
	{
		name: "--model: writes the model column and prints exactly ONE pasteable line",
		run() {
			withTempPair(
				() => {},
				({ provenance }) => {
					const raw = JSON.stringify({
						answers: { level: { choice: "medium", confidence: 0.72 }, risk: { choice: "C2" }, worktree: { probability: 0.9 } },
					});
					const result = captureConsole(() =>
						reportClassifier(raw, "impl-468", provenance, undefined, { model: "deepseek/deepseek-flash" }),
					);
					assertEqual(result.code, 0, "exit code");
					assertEqual(result.out, "jev: medium (0.72) · C2 · worktree y", "stdout is exactly one line");
					const text = readFileSync(provenance, "utf8");
					const row = text.split("\n").find((line) => line.includes("impl-468"));
					assertEqual(row.endsWith("\tmodel:deepseek/deepseek-flash"), true, "model column appended");
					assertEqual(parseProvenanceLog(text).entries[0].model, "deepseek/deepseek-flash", "round-trips");
				},
			);
		},
	},
	{
		name: "--model: a malformed id is refused, and --line refuses it outright",
		run() {
			const raw = JSON.stringify({ answers: { level: { choice: "low", confidence: 0.5 }, risk: { choice: "C3" }, worktree: { probability: 0.2 } } });
			assertStructural(
				() => parseLineArgs([raw, "--model", "claude"]),
				/needs a model id shaped/,
				"slashless --model",
			);
			const parsed = parseLineArgs([raw, "--model", "openrouter/~typesafe/jev-latest"]);
			assertEqual(parsed.model, "openrouter/~typesafe/jev-latest", "multi-slash --model parses");
		},
	},
	{
		name: "--classifier-model-aware without --model exits 2",
		run() {
			const raw = JSON.stringify({ answers: { level: { choice: "medium", confidence: 0.72 }, risk: { choice: "C2" }, worktree: { probability: 0.9 } } });
			withTempPair(
				() => {},
				({ provenance }) => {
					assertStructural(
						() => reportClassifier(raw, "impl-468", provenance, undefined, { awareRaw: raw }),
						/requires --model/,
						"aware without --model",
					);
					// Refused BEFORE anything is written: a half-recorded arm is worse than none.
					assertEqual(readIfExists(provenance), null, "no provenance row was written");
				},
			);
		},
	},
	{
		name: "--classifier-model-aware: records level-model, prints ONE line (the blind arm's)",
		run() {
			const raw = JSON.stringify({ answers: { level: { choice: "medium", confidence: 0.72 }, risk: { choice: "C2" }, worktree: { probability: 0.9 } } });
			const aware = JSON.stringify({ answers: { level: { choice: "minimal", confidence: 0.61 }, risk: { choice: "C2" }, worktree: { probability: 0.9 } } });
			withTempPair(
				() => {},
				({ provenance }) => {
					const result = captureConsole(() =>
						reportClassifier(raw, "impl-468", provenance, undefined, {
							model: "openrouter/meta/muse-spark-1.3-contributor",
							awareRaw: aware,
						}),
					);
					assertEqual(result.code, 0, "exit code");
					assertEqual(result.out, "jev: medium (0.72) · C2 · worktree y", "one line, the blind arm's level");
					assertEqual(result.out.split("\n").length, 1, "no second jev: line");
					if (!/aware arm minimal \(0\.61\)/.test(result.err)) {
						throw new Error(`expected the aware diagnostic, got ${JSON.stringify(result.err)}`);
					}
					const text = readFileSync(provenance, "utf8");
					const row = text.split("\n").find((line) => line.includes("impl-468"));
					assertEqual(row.endsWith("level-model:minimal (0.61)"), true, "aware column appended");
					const entry = parseProvenanceLog(text).entries[0];
					assertEqual(entry.line, "jev: medium (0.72) · C2 · worktree y", "the recorded line is the blind one");
					assertEqual(entry.levelModel.level, "minimal", "aware level recorded");
				},
			);
		},
	},
	{
		name: "blind isolation: the printed line is byte-identical with and without model/aware data",
		run() {
			const raw = JSON.stringify({ answers: { level: { choice: "high", confidence: 0.53 }, risk: { choice: "C1" }, worktree: { probability: 0.7 } } });
			const aware = JSON.stringify({ answers: { level: { choice: "xhigh", confidence: 0.44 }, risk: { choice: "C1" }, worktree: { probability: 0.7 } } });
			const plain = captureConsole(() => reportClassifier(raw)).out;
			const withModel = captureConsole(() => reportClassifier(raw, undefined, undefined, undefined, { model: "deepseek/deepseek-flash" })).out;
			const withAware = captureConsole(() =>
				reportClassifier(raw, undefined, undefined, undefined, { model: "deepseek/deepseek-flash", awareRaw: aware }),
			).out;
			assertEqual(withModel, plain, "--model must not leak into the line");
			assertEqual(withAware, plain, "the aware arm must not leak into the line");
			assertEqual(plain, "jev: high (0.53) · C1 · worktree y", "the blind line itself");
		},
	},
	{
		name: "arm 2 failure falls back to blind-only (a measurement never blocks a dispatch)",
		run() {
			const raw = JSON.stringify({ answers: { level: { choice: "medium", confidence: 0.72 }, risk: { choice: "C2" }, worktree: { probability: 0.9 } } });
			withTempPair(
				() => {},
				({ provenance }) => {
					const result = captureConsole(() =>
						reportClassifier(raw, "impl-468", provenance, undefined, { model: "deepseek/deepseek-flash", awareRaw: "not json" }),
					);
					assertEqual(result.code, 0, "exit code stays 0");
					assertEqual(result.out, "jev: medium (0.72) · C2 · worktree y", "the blind line stands");
					if (!/aware arm ignored/.test(result.err)) throw new Error(`expected the fallback notice, got ${JSON.stringify(result.err)}`);
					const entry = parseProvenanceLog(readFileSync(provenance, "utf8")).entries[0];
					assertEqual(entry.levelModel, null, "no aware column on a failed arm 2");
					assertEqual(entry.model, "deepseek/deepseek-flash", "the model is still recorded");
				},
			);
		},
	},

	// --- #468: --settle -----------------------------------------------------
	{
		name: "--settle: writes the instant cutoff header and one 7-column row",
		run() {
			withTempPair(
				({ provenance }) => {
					writeFileSync(provenance, `${provenanceLogFixture(provenanceRow("impl-468", FIXTURE_LINE))}\n`);
				},
				({ provenance, outcomes }) => {
					const result = captureConsole(() =>
						reportSettle(
							"impl-468",
							{ kind: "impl", outcome: "done", verdict: "approve-with-nits", nits: 2, modelRan: "deepseek/deepseek-v4-pro" },
							outcomes,
							provenance,
						),
					);
					assertEqual(result.code, 0, "exit code");
					const lines = readFileSync(outcomes, "utf8").trimEnd().split("\n");
					if (!/^# jev-outcomes — cutoff \d{4}-\d{2}-\d{2}T[0-9:.]+Z$/.test(lines[0])) {
						throw new Error(`header must carry the creation INSTANT, got ${JSON.stringify(lines[0])}`);
					}
					assertEqual(lines.length, 2, "header + one row");
					assertEqual(lines[1].split("\t").length, OUTCOMES_ROW_COLUMNS, "7 columns");
					const parsed = parseOutcomesLog(readFileSync(outcomes, "utf8"), outcomes);
					assertEqual(parsed.rows[0].verdict, "approve-with-nits", "verdict round-trips");
					assertEqual(parsed.rows[0].nits, 2, "nits round-trip");
					assertEqual(parsed.rows[0].modelRan, "deepseek/deepseek-v4-pro", "model-ran round-trips");
				},
			);
		},
	},
	{
		name: "--settle: an unknown label is refused and creates nothing",
		run() {
			withTempPair(
				({ provenance }) => {
					writeFileSync(provenance, `${provenanceLogFixture(provenanceRow("impl-468", FIXTURE_LINE))}\n`);
				},
				({ provenance, outcomes }) => {
					assertStructural(
						() => reportSettle("impl-nope", { kind: "impl", outcome: "done", verdict: "approve" }, outcomes, provenance),
						/no provenance row labels "impl-nope"/,
						"unknown label",
					);
					assertEqual(readIfExists(outcomes), null, "no outcome file was created");
				},
			);
		},
	},
	{
		name: "--settle: a duplicate is refused and the file is byte-identical afterwards",
		run() {
			withTempPair(
				({ provenance }) => {
					writeFileSync(provenance, `${provenanceLogFixture(provenanceRow("impl-468", FIXTURE_LINE))}\n`);
				},
				({ provenance, outcomes }) => {
					captureConsole(() => reportSettle("impl-468", { kind: "impl", outcome: "done", verdict: "approve" }, outcomes, provenance));
					const before = readFileSync(outcomes, "utf8");
					assertStructural(
						() => reportSettle("impl-468", { kind: "impl", outcome: "failed" }, outcomes, provenance),
						/already settled/,
						"duplicate settle",
					);
					assertEqual(readFileSync(outcomes, "utf8"), before, "a refusal never rewrites the log");
					assertEqual(parseOutcomesLog(before, outcomes).rows.length, 1, "still one row");
				},
			);
		},
	},
	{
		name: "--settle: unknown kind/outcome/verdict, --nits rules and a malformed --model-ran are refused",
		run() {
			withTempPair(
				({ provenance }) => {
					writeFileSync(provenance, `${provenanceLogFixture(provenanceRow("impl-468", FIXTURE_LINE))}\n`);
				},
				({ provenance, outcomes }) => {
					assertStructural(
						() => reportSettle("impl-468", { kind: "impl-ish", outcome: "done" }, outcomes, provenance),
						/--settle needs --kind/,
						"unknown kind",
					);
					assertStructural(
						() => reportSettle("impl-468", { kind: "impl", outcome: "merged" }, outcomes, provenance),
						/--settle needs --outcome/,
						"unknown outcome",
					);
					assertStructural(
						() => reportSettle("impl-468", { kind: "impl", outcome: "done", verdict: "lgtm" }, outcomes, provenance),
						/--settle --verdict must be/,
						"unknown verdict",
					);
					assertStructural(
						() => reportSettle("impl-468", { kind: "impl", outcome: "done", nits: 2 }, outcomes, provenance),
						/--nits needs --verdict/,
						"nits without a verdict",
					);
					assertStructural(
						() => parseSettleArgs(["impl-468", "--kind", "impl", "--outcome", "done", "--verdict", "approve", "--nits", "two"]),
						/non-negative integer/,
						"non-integer --nits",
					);
					assertStructural(
						() => parseSettleArgs(["impl-468", "--kind", "impl", "--outcome", "done", "--model-ran", "muse"]),
						/needs a model id shaped/,
						"malformed --model-ran",
					);
					assertEqual(readIfExists(outcomes), null, "no refusal created a file");
				},
			);
		},
	},
	{
		name: "--settle: an empty (truncated) outcome file is refused, not re-initialized",
		run() {
			withTempPair(
				({ provenance, outcomes }) => {
					writeFileSync(provenance, `${provenanceLogFixture(provenanceRow("impl-468", FIXTURE_LINE))}\n`);
					writeFileSync(outcomes, "");
				},
				({ provenance, outcomes }) => {
					assertStructural(() => loadOutcomes(outcomes), /empty outcome file — delete it to re-initialize/, "read path");
					assertStructural(
						() => reportSettle("impl-468", { kind: "impl", outcome: "done", verdict: "approve" }, outcomes, provenance),
						/empty outcome file/,
						"write path",
					);
				},
			);
		},
	},

	// --- #468: --calibrate (the eight-case no-data matrix + the cohort) ------
	{
		name: "--calibrate case 1: a missing or empty provenance log is exit 2 (fail-closed, checked FIRST)",
		run() {
			withTempPair(
				({ provenance }) => {
					writeFileSync(provenance, "");
				},
				({ provenance, outcomes }) => {
					writeFileSync(outcomes, `${outcomesLogFixture()}\n`);
					assertStructural(() => reportCalibration(provenance, outcomes), /no provenance entries/, "empty provenance");
					assertStructural(
						() => reportCalibration(join(provenance, "does-not-exist.log"), outcomes),
						/does-not-exist\.log: cannot read the provenance log/,
						"missing provenance",
					);
				},
			);
		},
	},
	{
		name: "--calibrate case 2: a never-initialized sidecar exits 0 with \"no settle data yet\" and no comparison",
		run() {
			withTempPair(
				({ provenance }) => {
					writeFileSync(provenance, `${provenanceLogFixture(provenanceRow("impl-468", FIXTURE_LINE))}\n`);
				},
				({ provenance, outcomes }) => {
					const result = captureConsole(() => reportCalibration(provenance, outcomes));
					assertEqual(result.code, 0, "exit code");
					if (!/no settle data yet/.test(result.out)) throw new Error(`expected the no-data message, got ${JSON.stringify(result.out)}`);
					if (/blind=disp/.test(result.out)) throw new Error("a missing file must never reach the comparison");
				},
			);
		},
	},
	{
		name: "--calibrate case 3: a 0-byte sidecar is exit 2, not \"zero settled\"",
		run() {
			withTempPair(
				({ provenance, outcomes }) => {
					writeFileSync(provenance, `${provenanceLogFixture(provenanceRow("impl-468", FIXTURE_LINE))}\n`);
					writeFileSync(outcomes, "");
				},
				({ provenance, outcomes }) => {
					assertStructural(() => reportCalibration(provenance, outcomes), /empty outcome file — delete it to re-initialize/, "empty sidecar");
				},
			);
		},
	},
	{
		name: "--calibrate case 4: a date-only or malformed header is exit 2 and names the full instant",
		run() {
			withTempPair(
				({ provenance, outcomes }) => {
					writeFileSync(provenance, `${provenanceLogFixture(provenanceRow("impl-468", FIXTURE_LINE))}\n`);
					writeFileSync(outcomes, "# jev-outcomes — cutoff 2026-11-01\n");
				},
				({ provenance, outcomes }) => {
					const error = assertStructural(() => reportCalibration(provenance, outcomes), /date-only/, "date-only header");
					if (!/full ISO instant/.test(error.message)) throw new Error(`must name the expected shape: ${error.message}`);
					writeFileSync(outcomes, "# jev-outcomes — cutoff yesterday\n");
					assertStructural(() => reportCalibration(provenance, outcomes), /malformed header/, "malformed header");
					writeFileSync(outcomes, `${outcomeRow("impl-468", "impl", "done", "approve")}\n`);
					assertStructural(() => reportCalibration(provenance, outcomes), /no "# jev-outcomes — cutoff"/, "missing header");
				},
			);
		},
	},
	{
		name: "--calibrate case 5: a valid header with zero data rows exits 0 and says \"0 settled\"",
		run() {
			withTempPair(
				({ provenance, outcomes }) => {
					writeFileSync(provenance, `${provenanceLogFixture(provenanceRow("impl-468", FIXTURE_LINE))}\n`);
					writeFileSync(outcomes, `${OUTCOMES_HEADER}\n`);
				},
				({ provenance, outcomes }) => {
					const result = captureConsole(() => reportCalibration(provenance, outcomes));
					assertEqual(result.code, 0, "exit code");
					if (!/0 settled/.test(result.out)) throw new Error(`expected "0 settled", got ${JSON.stringify(result.out)}`);
					if (/blind=disp/.test(result.out)) throw new Error("zero rows must never reach the comparison");
				},
			);
		},
	},
	{
		name: "--calibrate case 6: a malformed or truncated outcome row is exit 2 and names the row",
		run() {
			withTempPair(
				({ provenance, outcomes }) => {
					writeFileSync(provenance, `${provenanceLogFixture(provenanceRow("impl-468", FIXTURE_LINE))}\n`);
					writeFileSync(outcomes, `${outcomesLogFixture(["2026-11-08T02:00:00.000Z", "impl-468", "impl"].join("\t"))}\n`);
				},
				({ provenance, outcomes }) => {
					assertStructural(() => reportCalibration(provenance, outcomes), /outcome row at line 2 is malformed/, "truncated row");
					writeFileSync(outcomes, `${outcomesLogFixture(outcomeRow("impl-468", "impl", "done", "looks-fine"))}\n`);
					assertStructural(() => reportCalibration(provenance, outcomes), /line 2 .*verdict/, "bad verdict cell");
				},
			);
		},
	},
	{
		name: "--calibrate case 7: an orphan settle (label absent from provenance) is exit 2 and names it",
		run() {
			withTempPair(
				({ provenance, outcomes }) => {
					writeFileSync(provenance, `${provenanceLogFixture(provenanceRow("impl-468", FIXTURE_LINE))}\n`);
					writeFileSync(outcomes, `${outcomesLogFixture(outcomeRow("impl-orphan", "impl", "done", "approve"))}\n`);
				},
				({ provenance, outcomes }) => {
					assertStructural(() => reportCalibration(provenance, outcomes), /"impl-orphan" has no provenance row/, "orphan join");
				},
			);
		},
	},
		{
		name: "--calibrate case 8: zero eligible rows exits 0 with N=0 and no comparison",
		run() {
			withTempPair(
				({ provenance, outcomes }) => {
					writeFileSync(
						provenance,
						`${provenanceLogFixture(provenanceRow("review-468", FIXTURE_LINE), provenanceRow("impl-gap", FIXTURE_LINE))}\n`,
					);
					// A review row and an `unknown` impl row: recorded, never eligible.
					writeFileSync(
						outcomes,
						`${outcomesLogFixture(
							outcomeRow("review-468", "review", "done", "changes-requested"),
							outcomeRow("impl-gap", "impl", "unknown"),
						)}\n`,
					);
				},
				({ provenance, outcomes }) => {
					const result = captureConsole(() => reportCalibration(provenance, outcomes));
					assertEqual(result.code, 0, "exit code");
					if (!/no eligible implementation dispatches \(N=0\)/.test(result.out)) {
						throw new Error(`expected the N=0 message, got ${JSON.stringify(result.out)}`);
					}
					if (/blind=disp/.test(result.out)) throw new Error("an empty cohort must never reach the comparison");
				},
			);
		},
	},
	{
		name: "--calibrate: below 20 eligible rows it prints counts only, with \"no conclusion (N<20)\"",
		run() {
			withTempPair(
				(paths) => writeCalibrationPair(paths, { rows: 3 }),
				({ provenance, outcomes }) => {
					const result = captureConsole(() => reportCalibration(provenance, outcomes));
					assertEqual(result.code, 0, "exit code");
					if (!/eligible 3 \/ settled 3 \/ with-model 3/.test(result.out)) throw new Error(`counts: ${JSON.stringify(result.out)}`);
					if (!/no conclusion \(N<20\)/.test(result.out)) throw new Error(`no-conclusion line: ${JSON.stringify(result.out)}`);
					if (/blind=disp/.test(result.out)) throw new Error("a table below N=20 is the theatre this floor exists to prevent");
				},
			);
		},
	},
	{
		name: "--calibrate at N>=20: per-model table incl (unstated), both agreements, the delta, no winner",
		run() {
			withTempPair(
				(paths) => writeCalibrationPair(paths),
				({ provenance, outcomes }) => {
					const result = captureConsole(() => reportCalibration(provenance, outcomes));
					assertEqual(result.code, 0, "exit code");
					const out = result.out;
					if (!/eligible 24 \/ settled 24 \/ with-model 20/.test(out)) throw new Error(`counts: ${JSON.stringify(out)}`);
					if (!/blind=disp/.test(out)) throw new Error(`table header: ${JSON.stringify(out)}`);
					if (!/openrouter\/meta\/muse-spark-1\.3-contributor/.test(out)) throw new Error(`muse bucket: ${JSON.stringify(out)}`);
					if (!/\(unstated\)/.test(out)) throw new Error(`the legacy bucket must be visible: ${JSON.stringify(out)}`);
					// Hand-counted from the fixture: 24 eligible, 20 observed-sufficient (the four
					// `changes-requested` rows are eligible but NOT sufficient), blind 24/24, aware 6/20
					// (rows 0–19 carry an aware answer), delta above 8 · below 6 · equal 6.
					const totals = out.split("\n").find((line) => line.startsWith("total"));
					if (!/^total\s+24\s+20\s+24\/24\s+6\/20\s+above 8 · below 6 · equal 6$/.test(totals ?? "")) {
						throw new Error(`totals row: ${JSON.stringify(totals)}`);
					}
					if (!/no ranking/.test(out) || !/names no winner/.test(out)) throw new Error(`the no-winner line: ${JSON.stringify(out)}`);
					if (/the winner is|best arm|winner:|ranks as/.test(out)) throw new Error(`a ranking leaked into the output: ${JSON.stringify(out)}`);
				},
			);
		},
	},
	{
		name: "--calibrate: --model-ran overrides the provenance model for the bucket (a fallback is corrected)",
		run() {
			withTempPair(
				(paths) => writeCalibrationPair(paths),
				({ provenance, outcomes }) => {
					const out = captureConsole(() => reportCalibration(provenance, outcomes)).out;
					// Every row 0–19 carries `model:openrouter/meta/muse-spark-1.3-contributor`; rows 12–19
					// settle with `--model-ran deepseek/deepseek-flash`. Ignoring the override would leave
					// muse at 20 rows and no deepseek bucket at all.
					const muse = out.split("\n").find((line) => line.startsWith("openrouter/meta/muse-spark"));
					const deepseek = out.split("\n").find((line) => line.startsWith("deepseek/deepseek-flash"));
					if (!/^openrouter\/meta\/muse-spark-1\.3-contributor\s+12\s/.test(muse ?? "")) throw new Error(`muse bucket: ${JSON.stringify(muse)}`);
					if (!/^deepseek\/deepseek-flash\s+8\s/.test(deepseek ?? "")) throw new Error(`deepseek bucket: ${JSON.stringify(deepseek)}`);
				},
			);
		},
	},
	{
		name: "--calibrate: `changes-requested` is eligible but never observed-sufficient",
		run() {
			assertEqual(isCalibrationEligible({ kind: "impl", outcome: "done", verdict: "changes-requested", nits: 3 }), true, "eligible");
			assertEqual(isObservedSufficient({ kind: "impl", outcome: "done", verdict: "changes-requested", nits: 3 }), false, "not sufficient");
			assertEqual(isObservedSufficient({ kind: "impl", outcome: "failed", verdict: null }), false, "a failed run is not sufficient");
			assertEqual(isObservedSufficient({ kind: "impl", outcome: "done", verdict: "approve-with-nits" }), true, "approve-with-nits is sufficient");
			// The other half of the cohort: reviews, probes, unknown and stopped are not eligible, and a
			// `done` without a verdict cannot be judged.
			assertEqual(isCalibrationEligible({ kind: "review", outcome: "done", verdict: "approve" }), false, "review");
			assertEqual(isCalibrationEligible({ kind: "probe", outcome: "done", verdict: "approve" }), false, "probe");
			assertEqual(isCalibrationEligible({ kind: "impl", outcome: "unknown", verdict: null }), false, "unknown");
			assertEqual(isCalibrationEligible({ kind: "impl", outcome: "stopped", verdict: null }), false, "stopped");
			assertEqual(isCalibrationEligible({ kind: "impl", outcome: "done", verdict: null }), false, "done without a verdict");
			assertEqual(isCalibrationEligible({ kind: "impl", outcome: "failed", verdict: null }), true, "failed without a verdict");
		},
	},

	// --- #468: the B regression pins (the level is an observation) ----------
	{
		name: "B pin: a WRONG but provenanced level passes --log --require-provenance; without the row it fails",
		run() {
			// The gate is provenance + risk + worktree. `minimal` on a C1 src change is demonstrably
			// the wrong level, and it must still merge when the row proves the classifier printed it.
			const line = "jev: minimal (0.72) · C1 · worktree y";
			const log = dispatchLogFixture(dispatchEvent("2026-11-08T01:00:00.000Z", `Implement it.\n\n${line}`));
			const withRow = analyzeDispatchLog(log, STRICT_DISPATCH_CUTOFF, [], {
				cutoff: "2026-11-01T00:00:00.000Z",
				lines: new Set([line]),
			});
			assertEqual(withRow.offenders.length, 0, "a wrong-but-provenanced level passes");
			const withoutRow = analyzeDispatchLog(log, STRICT_DISPATCH_CUTOFF, [], {
				cutoff: "2026-11-01T00:00:00.000Z",
				lines: new Set(),
			});
			assertEqual(withoutRow.offenders.length, 1, "without the row it still fails");
			// And the rest of the gate is untouched: no risk class is still an offender.
			const noRisk = analyzeDispatchLog(
				dispatchLogFixture(dispatchEvent("2026-11-08T01:00:00.000Z", "Implement it.\n\njev: minimal (0.72) · worktree y")),
				STRICT_DISPATCH_CUTOFF,
				[],
				{ cutoff: "2026-11-01T00:00:00.000Z", lines: new Set(["jev: minimal (0.72) · worktree y"]) },
			);
			assertEqual(noRisk.offenders.length, 1, "a line missing the risk class still blocks");
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
	"usage: jev-check.mjs --classifier '<raw-answers>' [--model <id>] [--classifier-model-aware '<raw-answers>'] [--label <name>] | --line '<json>' [--label <name>] [--legacy-line] | --ledger [path] | --log [path] [--since YYYY-MM-DD] [--require-provenance] | --settle <label> --kind <k> --outcome <o> [--verdict <v>] [--nits N] [--model-ran <id>] | --calibrate | --selftest",
	"",
	"  --line '<json>'   validate {level, conf, risk, worktree} and print",
	'                    `jev: <level> (<conf>) · <Cx> · worktree <y|n>`',
	`  --ledger [path]   audit the Jev calibration log (default: ${DEFAULT_LEDGER})`,
	`  --log [path]      audit dispatch payloads in the subagent log (default: ${DEFAULT_SUBAGENT_LOG});`,
	`                    every \`${DISPATCH_EVENT_MESSAGE}\` event dated >= ${STRICT_DISPATCH_CUTOFF}`,
	"                    must carry a valid Rule 22 line. Conductor/merge-time (local log).",
	"  --since YYYY-MM-DD  with --log: override the dispatch cutoff (legacy audit)",
	"  --classifier '<raw answers JSON>'  derive the line from the classifier response (the honest path)",
	"  --worktree y|n     with --classifier: STATE the worktree field as a process fact (#456); the",
	"                     provenance row records it as stated instead of a model answer",
	"  --model <provider>/<id>  with --classifier: record the model that will run the dispatch as a",
	"                     `model:<id>` column (#468). Omitted = no column, never a guess",
	"  --classifier-model-aware '<raw answers JSON>'  with --classifier: the SECOND, model-aware arm's",
	"                     answer. Recorded as `level-model:<level> (<conf>)`; requires --model (exit 2).",
	"                     It is a measurement: ONE pasteable line is printed (the blind arm's), and an",
	"                     unusable arm 2 falls back to blind-only rather than blocking the dispatch",
	"  --legacy-line     with --line --label: acknowledge a conductor-assigned (non-classified) line",
	"  --label <name>    with --classifier/--line: append the printed line to the provenance log",
	`                    (${DEFAULT_PROVENANCE_LOG}) so the dispatch line is machine-produced`,
	"  --require-provenance  with --log: every dispatch line since the provenance cutoff must",
	"                    have a provenance row. Fail-closed (exit 2) when the log is missing.",
	`  --exceptions [path]  with --log: recorded-exception list (default: ${DISPATCH_EXCEPTIONS_DEFAULT});`,
	"                    a matching offender prints as acknowledged, never as clean or failing",
	`  --settle <label> --kind impl|review|probe --outcome done|failed|stopped|unknown`,
	"                    [--verdict approve|approve-with-nits|changes-requested] [--nits N] [--model-ran <id>]",
	`                    append what HAPPENED to the sidecar ${DEFAULT_OUTCOMES_LOG} (keyed by label).`,
	"                    Every refusal (unknown label, duplicate settle, bad vocabulary, --nits without a",
	"                    verdict) is exit 2 — a guessed settle poisons the only ground truth there is",
	`  --calibrate       read the sidecar against the provenance log: eligible impl rows, both arms'`,
	"                    agreement with the DISPATCHED level, and the delta. Below 20 eligible rows it",
	"                    prints counts and NO conclusion; it never names a winner",
	"  --selftest        fixture proof of every mode (CI-wired)",
].join("\n");

/** Parse `--log [path] [--since YYYY-MM-DD]` in either order; a second path is a usage error. */
function parseLogArgs(args) {
	let path;
	let since;
	let exceptions;
	let requireProvenance = false;
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		if (arg === "--require-provenance") {
			requireProvenance = true;
		} else if (arg === "--exceptions") {
			if (index + 1 >= args.length) throw new StructuralError("--exceptions needs a path");
			exceptions = args[index + 1];
			index += 1;
		} else if (arg === "--since") {
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
	return { path: path ?? DEFAULT_SUBAGENT_LOG, since, exceptions, requireProvenance };
}

/** Parse `--settle <label> --kind <k> --outcome <o> [--verdict <v>] [--nits N] [--model-ran <id>]`. */
function parseSettleArgs(args) {
	let label;
	const options = { kind: null, outcome: null, verdict: null, nits: null, modelRan: null };
	for (let index = 0; index < args.length; index += 1) {
		const arg = args[index];
		const value = () => {
			if (index + 1 >= args.length) throw new StructuralError(`${arg} needs a value`);
			index += 1;
			return args[index];
		};
		if (arg === "--kind") {
			options.kind = value();
		} else if (arg === "--outcome") {
			options.outcome = value();
		} else if (arg === "--verdict") {
			options.verdict = value();
		} else if (arg === "--nits") {
			const raw = value();
			if (!/^\d+$/.test(raw)) throw new StructuralError(`--nits must be a non-negative integer (got ${JSON.stringify(raw)})`);
			options.nits = Number(raw);
		} else if (arg === "--model-ran") {
			options.modelRan = normalizeModelId(value(), "--model-ran");
		} else if (arg.startsWith("--")) {
			throw new StructuralError(`unknown --settle option ${JSON.stringify(arg)}\n\n${USAGE}`);
		} else if (label === undefined) {
			label = arg;
		} else {
			throw new StructuralError(`--settle takes one label (got ${JSON.stringify(label)} and ${JSON.stringify(arg)})`);
		}
	}
	return { label, options };
}

function main(argv) {
	const [mode, ...rest] = argv;
	try {		if (mode === "--classifier") {
			const { raw, label, worktree, model, awareRaw } = parseLineArgs(rest);
			return reportClassifier(raw, label, DEFAULT_PROVENANCE_LOG, worktree, { model, awareRaw });
		}
		if (mode === "--line") {
			const { raw, label, legacy, worktree, model, awareRaw } = parseLineArgs(rest);
			if (worktree !== undefined) {
				throw new StructuralError(
					"--worktree is a --classifier option: --line takes the worktree field you already decided, " +
						"so stating it twice would have no source of truth",
				);
			}
			if (model !== undefined || awareRaw !== undefined) {
				throw new StructuralError(
					"--model/--classifier-model-aware are --classifier options: --line formats a decision you already " +
						"made, so a row it wrote would claim a model and an arm that never ran",
				);
			}
			return reportLine(raw, label, legacy);
		}
		if (mode === "--ledger") {
			if (rest.length > 1) throw new StructuralError(`--ledger takes at most one path (got ${rest.length})`);
			return reportLedger(rest[0] ?? DEFAULT_LEDGER);
		}
		if (mode === "--log") {
			const { path, since, exceptions, requireProvenance } = parseLogArgs(rest);
			return reportDispatchLog(path, since, exceptions, requireProvenance);
		}
		if (mode === "--settle") {
			const { label, options } = parseSettleArgs(rest);
			return reportSettle(label, options);
		}
		if (mode === "--calibrate") {
			if (rest.length > 0) throw new StructuralError(`--calibrate takes no arguments (got ${JSON.stringify(rest[0])})\n\n${USAGE}`);
			return reportCalibration();
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

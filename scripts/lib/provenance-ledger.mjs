#!/usr/bin/env node
// Purpose: the provenance ledger's ONE reader, writer and row predicate (issue #596).
//
// Rule 22's evidence is a row in `.pi/jev-lines.log`: `<iso>\t<label>\t<jev: line>` plus optional
// keyed columns. That grammar had TWO implementations — the merge gate's raw `awk` and this
// repository's `jev-check.mjs` — and a third was about to be added by the review-record work, so
// most of the critique rounds were arguments about whether two readers agree. There is one reader
// now, and it lives here: the gate asks `matchRow`, the audits ask `parseProvenanceLog`, the writers
// ask `appendProvenanceEntry`.
//
// `matchRow` is a second QUESTION, not a second implementation of the reader's: the parser answers
// "read this ledger" (fail-closed, keyed columns, cutoff), `matchRow` answers "do these exact bytes
// appear for this label" — the gate's existential predicate, which deliberately shares none of the
// parser's tolerance. A `#` line carrying three tabs matches it (the gate's awk matched it too), a
// CRLF row does not (its third column ends in `\r`), and nothing is trimmed on either side.
//
// Everything below is MOVED from `.pi/skills/worktree/jev-check.mjs` unchanged, comments included;
// only the `export` prefixes are new. The five shared symbols jev-check imports back (LEVELS,
// MODEL_ID_PATTERN, StructuralError, describe, formatConfidence) are the vocabulary and the error
// class the moved functions call: a copied error class would stop being recognised as structural
// (exit 2 would silently become exit 1), and a copied confidence formatter would print a line that
// no longer matches the row that proves it. They are exported because they are part of the move.

import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

// ---------------------------------------------------------------------------
// Vocabulary — the ledger grammar, and the dispatch vocabulary it validates.
// ---------------------------------------------------------------------------

/** Thinking levels the classifier answers with, low → high. */
export const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

/**
 * The provenance log's header records the cutoff: entries can only exist from the moment the log
 * was created, so dispatches dated BEFORE it are exempt (a historical dispatch cannot have a
 * provenance entry — the log did not exist). Recorded in the file, not in code, so the cutoff is
 * the deployment moment rather than an arbitrary constant.
 */
export const PROVENANCE_CUTOFF_PREFIX = "# jev-lines provenance — cutoff ";

/**
 * A model id: `<provider>/<id>`. At least one slash, and MULTIPLE are legal — the real ids this
 * repository dispatches include `openrouter/meta/muse-spark-1.3-contributor` and
 * `openrouter/~typesafe/jev-latest` (a single-slash pattern rejected both, measured 2026-11-08).
 */
export const MODEL_ID_PATTERN = /^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)+$/;

/** `<level> (<conf>)` in the aware column. The numeric RANGE is checked separately (rejects `1.5`). */
const LEVEL_MODEL_SHAPE = /^level-model:([A-Za-z]+) \((\d+(?:\.\d+)?)\)$/;

/** A provenance row: 3 positional columns plus up to 3 keyed ones. */
const PROVENANCE_ROW_BASE_COLUMNS = 3;
const PROVENANCE_ROW_MAX_COLUMNS = 6;

/** Anything shaped like a keyed column — used to reject one placed before the line column. */
const KEYED_COLUMN_PREFIX = /^(?:stated|model|level-model):/;

export const PROVENANCE_COLUMN_HELP =
	"expected <iso>\\t<label>\\t<line> then any of stated:worktree, model:<provider>/<id>, " +
	"level-model:<level> (<conf>)";

// ---------------------------------------------------------------------------
// Errors — the exit code names the class of failure.
// ---------------------------------------------------------------------------

/** Broken input (unparseable JSON, unreadable/empty table). Exit 2 — cannot check, never pass. */
export class StructuralError extends Error {}

export function describe(error) {
	return error instanceof Error ? error.message : String(error);
}

/** `0.84` → "0.84", `0.9` → "0.9", `1` → "1.0" — the log's own style, never a trailing-zero artifact. */
export function formatConfidence(confidence) {
	const text = (Math.round(confidence * 100) / 100).toFixed(2).replace(/0+$/, "");
	return text.endsWith(".") ? `${text}0` : text;
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
export function formatProvenanceEntry(line, label, now, fields = {}) {
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
export function parseProvenanceLog(text) {
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
export function parseProvenanceRow(raw, lineNumber) {
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
export function appendProvenanceEntry(path, line, label, now = new Date(), fields = {}) {
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
export function loadProvenance(path) {
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
 * The GATE's row predicate (issue #596): does any line carry exactly this label and this line?
 *
 * Deliberately NOT `parseProvenanceRow`: the gate's question is existential over the file's bytes,
 * and it must agree with the `awk -F'\t' 'NF >= 3 && $2 == label && $3 == want'` it replaces. So
 * there is no trim, no `\r` strip and no `#` skip — a `#` line with three tabs matches (awk matched
 * it), a CRLF row does not (awk's `$3` kept the `\r`), and a trailing space on either side makes the
 * row a different row. Reading the ledger is `parseProvenanceLog`'s job; this answers one question
 * about bytes that are already in hand.
 *
 * `lines` is the ledger's text split on `"\n"` alone — the same record separator awk used.
 */
export function matchRow(lines, label, wanted) {
	for (const line of lines) {
		const parts = line.split("\t");
		if (parts.length >= 3 && parts[1] === label && parts[2] === wanted) return true;
	}
	return false;
}

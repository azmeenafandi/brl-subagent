#!/usr/bin/env node
// Purpose: guard the factory vocabulary (#606 Unit 3) — validate `.development/VOCABULARY.md` and fail a
// banned synonym in the living prose it governs.
//
// THE MECHANISM, NOT A LEXICON. The vocabulary is a naming layer: four concepts the code already uses
// (`dispatch`, `spawn`, `run`, `subagent`) and one enforced ban (`worker → subagent`). The data file is the
// single source of truth, so extending the vocabulary is a table row — this script never hard-codes a term.
// Validating the data file is therefore half the job: a typo'd ban that bans nothing is worse than no ban,
// because the file still *claims* the word is policed.
//
// TWO JOBS, TWO EXIT CODES THAT MUST NOT MERGE:
//   a. shape   the data file's own rules — a duplicate concept, a term canonical in one row and banned in
//              another, a `status` outside the enum, an empty `canonical`, two rows sharing one canonical
//              term. These are exit 1 (violations), because the file is readable and the file is wrong.
//   b. prose   every banned term in the corpus, reported as `path:line: banned term … — use … instead`,
//              plus the dead-row rule (Q15): a canonical term used nowhere is a violation, unless the row
//              is marked `forward` (deliberately defined ahead of its first use).
// A file that cannot be read, or a table that cannot be parsed, is exit 2 — "cannot check" is not "found a
// violation", and collapsing the two would let a broken data file pass as a clean tree.
//
// THE CORPUS IS STATED, NOT IMPLIED. Living normative prose, `*.md` only: `AGENT.md`, `README.md`,
// `.pi/skills/**/*.md`, `presets/**/*.md`, `templates/**/*.md`. `.development/**` is history and
// investigations (a closed critique is never rewritten to match a later rule), `CHANGELOG.md` is history,
// `src/**` holds identifiers that legitimately keep their names, and scripts/tests/fixtures are machinery —
// all printed as exclusions with a reason, so a corpus nobody states is never filled in by the reader.
//
// WHAT IS PROSE (Q6). Fenced code blocks, inline code spans, URLs and path-like tokens are exempt: under the
// naming layer, naming a `worker`-style identifier in backticks is correct prose, and masking the fence is
// the same rule `handoff-verify` applies. Blockquotes are NOT exempt — the fence rule skips fences, not
// blockquotes. THE ACCEPTED HOLE, documented rather than hidden: backticking a banned word is a trivial
// escape. The guard catches a synonym creeping into narrative prose, not a determined author.
//
// Exit: 0 clean · 1 violation(s) in the data file or the prose · 2 usage, or a data file/corpus that cannot
// be read or parsed (a scan of nothing is not a pass).
import { readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { collectMarkdown } from "./audit-scratch-instructions.mjs";
import { maskFences } from "./lib/handoff-claims.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
/** The checkout this script lives in — every path below is relative to it, never absolute. */
export const ROOT = join(HERE, "..");

export const EXIT = Object.freeze({ OK: 0, VIOLATIONS: 1, USAGE: 2 });

/** The data file: the single place a concept is registered (F13 — adding a row is the whole cost). */
export const DATA_PATH = join(".development", "VOCABULARY.md");

/** The table's columns, in order. A header that does not match is a malformed file, not a violation. */
export const COLUMNS = Object.freeze(["concept", "canonical", "banned", "status", "notes"]);

/** `forward` is the marked-forward exception (Q15): a definition deliberately ahead of its first use. */
export const STATUSES = Object.freeze(["canonical", "forward"]);

/**
 * The corpus: two files named outright and three directories walked for `.md`. `presets/` and `templates/`
 * are published contract text, and `.pi/skills/` is the dispatch contract a conductor reads.
 */
export const CORPUS = Object.freeze(["AGENT.md", "README.md", join(".pi", "skills"), "presets", "templates"]);

/** The paths a repository-wide scan would catch and this guard deliberately does not. Printed every run. */
export const EXCLUSIONS = Object.freeze([
	Object.freeze({ path: ".development/**", why: "history and investigations — never rewritten to match a later rule" }),
	Object.freeze({ path: "CHANGELOG.md", why: "history — a released entry is a record, not an instruction" }),
	Object.freeze({ path: "src/**", why: "identifiers keep their names; the vocabulary is a naming layer over code" }),
	Object.freeze({ path: "scripts/**, **/*.test.ts, fixtures/**, *.json, *.log", why: "machinery and planted strings" }),
]);

/** A line that opens a table row. A blank line or any other text ends the table body. */
const TABLE_ROW = /^\s*\|/;
/** A Markdown separator cell: three or more dashes, optionally colon-aligned. */
const SEPARATOR_CELL = /^:?-{3,}:?$/;
/** An inline code span: one or more backticks, the content, the same run. Applied per line. */
const INLINE_CODE = /(`+)(.*?)\1/g;
/** A URL — masked because the token inside a link is not a word of the prose. */
const URL_TOKEN = /\b(?:https?|ftp):\/\/\S+/gi;
/** A path-like token: any word with a `/` or `\` separator, so `src/worker.ts` is not a statement. */
const PATH_TOKEN = /(?<![\w])(?:\.{0,2}[/\\])?[A-Za-z0-9_.@~+-]+(?:[/\\][A-Za-z0-9_.@~+-]+)+/g;

function describeError(error) {
	return error instanceof Error ? error.message : String(error);
}

function escapeRegExp(text) {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * The spellings a term must match: itself, its `-s` plural, and `-es` when the ending takes one. A term with
 * whitespace ("ticket tracker") inflects as a phrase, so only the literal is matched — the data file states
 * the term it wants policed, and this does not invent forms it did not name.
 */
export function termForms(term) {
	const forms = [term];
	if (!/\s/.test(term)) {
		forms.push(`${term}s`);
		if (/(?:s|x|z|ch|sh)$/i.test(term)) forms.push(`${term}es`);
	}
	return forms;
}

/** A whole-word, case-insensitive pattern for a term and its inflections — global, for counting. */
export function termPattern(term) {
	return new RegExp(`\\b(?:${termForms(term).map(escapeRegExp).join("|")})\\b`, "giu");
}

/** The cells of a table row, trailing pipe optional. `null` when the line is not a table row. */
function rowCells(line) {
	const trimmed = line.trim();
	if (!TABLE_ROW.test(trimmed)) return null;
	const inner = trimmed.endsWith("|") ? trimmed.slice(1, -1) : trimmed.slice(1);
	return inner.split("|").map((cell) => cell.trim());
}

/**
 * Parse the data file into `{ error, rows }`. `error` is a malformed-file message (exit 2), not a shape
 * violation: a file with no header, no separator, a row of the wrong width, or no rows at all cannot be
 * checked, and pretending it is a clean vocabulary is the failure mode this distinction exists to prevent.
 * `rows[].banned` is a list so one row can police more than one synonym.
 */
export function parseVocabulary(text) {
	const lines = String(text).split("\n");
	const headerIndex = lines.findIndex((line) => {
		const cells = rowCells(line);
		return cells !== null && cells.length === COLUMNS.length && cells.every((cell, index) => cell === COLUMNS[index]);
	});
	if (headerIndex === -1) {
		return { error: `no table header — expected "| ${COLUMNS.join(" | ")} |"`, rows: [] };
	}
	const separator = rowCells(lines[headerIndex + 1] ?? "");
	if (separator === null || separator.length !== COLUMNS.length || !separator.every((cell) => SEPARATOR_CELL.test(cell))) {
		return { error: `line ${headerIndex + 2}: the header is not followed by a ${COLUMNS.length}-column separator`, rows: [] };
	}
	const rows = [];
	for (let index = headerIndex + 2; index < lines.length; index += 1) {
		const cells = rowCells(lines[index]);
		if (cells === null) break;
		if (cells.length !== COLUMNS.length) {
			return { error: `line ${index + 1}: expected ${COLUMNS.length} columns, found ${cells.length}`, rows: [] };
		}
		const [concept, canonical, banned, status, notes] = cells;
		rows.push({
			line: index + 1,
			concept,
			canonical,
			banned: banned === "" ? [] : banned.split(",").map((term) => term.trim()).filter((term) => term !== ""),
			status,
			notes,
		});
	}
	if (rows.length === 0) return { error: "the table has no rows — an empty vocabulary bans nothing", rows: [] };
	return { error: null, rows };
}

/**
 * The data file's own rules. Each violation carries `path`, `line` and a message, because the data file is
 * the thing to fix and the line is the fix's address. Comparisons are case-insensitive: `Run` and `run` are
 * the same term to a reader, and a vocabulary that treats them as two is a vocabulary with a hole.
 */
export function validateRows(rows) {
	const violations = [];
	const concepts = new Map();
	const canonicals = new Map();
	for (const row of rows) {
		const where = { path: DATA_PATH, line: row.line };
		if (!STATUSES.includes(row.status)) {
			violations.push({ ...where, message: `status "${row.status}" is not ${STATUSES.join(" or ")}` });
		}
		if (row.concept === "") violations.push({ ...where, message: "empty concept" });
		else if (concepts.has(row.concept.toLowerCase())) {
			violations.push({ ...where, message: `concept "${row.concept}" is declared twice (first at line ${concepts.get(row.concept.toLowerCase())})` });
		} else concepts.set(row.concept.toLowerCase(), row.line);
		if (row.canonical === "") violations.push({ ...where, message: `empty canonical term for concept "${row.concept}"` });
		else if (canonicals.has(row.canonical.toLowerCase())) {
			violations.push({ ...where, message: `canonical "${row.canonical}" is declared in two rows (first at line ${canonicals.get(row.canonical.toLowerCase())})` });
		} else canonicals.set(row.canonical.toLowerCase(), row.line);
	}
	for (const row of rows) {
		for (const term of row.banned) {
			if (canonicals.has(term.toLowerCase())) {
				violations.push({
					path: DATA_PATH,
					line: row.line,
					message: `"${term}" is canonical in one row and banned in another`,
				});
			}
		}
	}
	return violations;
}

/**
 * Every line with the prose-only exemptions already applied: fenced blocks (via the shared CommonMark-subset
 * fencer), inline code spans, URLs and path-like tokens. Line structure is preserved, so a hit's line number
 * is the reader's line number. Blockquotes are deliberately NOT masked: the rule skips fences, not quotes.
 */
export function maskProse(text) {
	return maskFences(text)
		.split("\n")
		.map((line) => line.replace(INLINE_CODE, " ").replace(URL_TOKEN, " ").replace(PATH_TOKEN, " "))
		.join("\n");
}

/** The corpus on disk: `{ files, errors }`. A missing file/directory or an empty one is an error (exit 2). */
export function collectCorpus(root = ROOT) {
	const files = [];
	const errors = [];
	for (const entry of CORPUS) {
		const absolute = resolve(root, entry);
		if (entry.endsWith(".md")) {
			try {
				if (!statSync(absolute).isFile()) throw new Error("not a file");
				files.push(entry);
			} catch (error) {
				errors.push(`${entry}: cannot read the corpus file (${describeError(error)})`);
			}
			continue;
		}
		let found;
		try {
			found = collectMarkdown(absolute);
		} catch (error) {
			errors.push(`${entry}: cannot read the corpus directory (${describeError(error)})`);
			continue;
		}
		if (found.length === 0) {
			errors.push(`${entry}: no .md files — an empty corpus answers nothing, and a scan of nothing is not a pass`);
			continue;
		}
		for (const path of found) files.push(relative(root, path));
	}
	return { files: files.sort(), errors };
}

/**
 * The corpus pass: banned terms and dead rows. `violations` are exit 1; `errors` (a file that stopped being
 * readable between collection and scan) are exit 2. A `forward` row skips the dead-row check — that is the
 * whole meaning of the status.
 */
export function scanCorpus(files, rows, root = ROOT) {
	const violations = [];
	const errors = [];
	const banned = rows.flatMap((row) => row.banned.map((term) => ({ term, canonical: row.canonical, pattern: termPattern(term) })));
	const alive = new Map(rows.filter((row) => row.canonical !== "").map((row) => [row.canonical.toLowerCase(), 0]));
	const canonicalPatterns = new Map(
		rows
			.filter((row) => row.canonical !== "")
			.flatMap((row) => (row.status === "forward" ? [] : [[row.canonical.toLowerCase(), termPattern(row.canonical)]])),
	);
	for (const path of files) {
		let text;
		try {
			text = readFileSync(resolve(root, path), "utf8");
		} catch (error) {
			errors.push(`${path}: cannot be read (${describeError(error)})`);
			continue;
		}
		const lines = maskProse(text).split("\n");
		for (let index = 0; index < lines.length; index += 1) {
			const line = lines[index];
			for (const { term, canonical, pattern } of banned) {
				if (line.match(pattern) === null) continue;
				violations.push({ path, line: index + 1, message: `banned term "${term}" — use "${canonical}" instead` });
			}
			for (const [key, pattern] of canonicalPatterns) {
				alive.set(key, (alive.get(key) ?? 0) + [...line.matchAll(pattern)].length);
			}
		}
	}
	if (errors.length === 0) {
		for (const row of rows) {
			if (row.canonical === "" || row.status === "forward") continue;
			if ((alive.get(row.canonical.toLowerCase()) ?? 0) === 0) {
				violations.push({
					path: DATA_PATH,
					line: row.line,
					message: `canonical "${row.canonical}" appears nowhere in the corpus — use it, or mark the row forward`,
				});
			}
		}
	}
	return { violations, errors };
}

/** The whole check: data file → shape rules → corpus → prose rules. Returns exit facts, never exits. */
export function audit({ root = ROOT } = {}) {
	const unreadable = (message) => ({ files: [], rows: [], violations: [], errors: [message] });
	let text;
	try {
		text = readFileSync(resolve(root, DATA_PATH), "utf8");
	} catch (error) {
		return unreadable(`${DATA_PATH}: cannot read the data file (${describeError(error)})`);
	}
	const parsed = parseVocabulary(text);
	if (parsed.error !== null) return unreadable(`${DATA_PATH}: ${parsed.error}`);
	const violations = validateRows(parsed.rows);
	const corpus = collectCorpus(root);
	const errors = [...corpus.errors];
	// Scan what WAS readable even when part of the corpus could not be: an unreadable directory must not
	// suppress a real violation in a file that was read. The exit code is still 2 — "cannot check"
	// dominates a finding — but the finding is reported rather than swallowed.
	const scanned = scanCorpus(corpus.files, parsed.rows, root);
	violations.push(...scanned.violations);
	errors.push(...scanned.errors);
	return { files: corpus.files, rows: parsed.rows, violations, errors };
}

/** The corpus as printed: a file by name, a directory as its recursive Markdown glob. */
function describeEntry(entry) {
	return entry.endsWith(".md") ? entry : `${entry}/**/*.md`;
}

/** The rendered report: corpus, exclusions, vocabulary, violations, verdict. */
export function renderReport({ files, rows, violations, errors = [] }) {
	const lines = [];
	lines.push(`corpus: ${CORPUS.map(describeEntry).join(", ")} (${files.length} file(s))`);
	lines.push("  living normative prose, *.md only — fenced blocks, inline code, URLs and paths are not prose");
	lines.push(`not in the corpus, and why: ${EXCLUSIONS.map((entry) => `${entry.path} (${entry.why})`).join(" · ")}`);
	lines.push(`data: ${DATA_PATH} (${rows.length} row(s))`);
	const bans = rows.flatMap((row) => row.banned.map((term) => `${term} → ${row.canonical}`));
	lines.push(`vocabulary: ${rows.map((row) => row.canonical || "(empty)").join(", ")} · banned: ${bans.length === 0 ? "none" : bans.join(", ")}`);
	for (const violation of violations) lines.push(`violation: ${violation.path}:${violation.line}: ${violation.message}`);
	// Never call a run "clean" when part of it could not be read: that is the one word a reader trusts
	// before the exit code reaches them (#606 Unit 3, found in review).
	const verdict =
		errors.length > 0
			? `cannot check (${errors.length} unreadable input(s))`
			: violations.length === 0
				? "clean"
				: "fix the data file or the prose";
	lines.push(`vocabulary: ${violations.length} violation(s) in ${files.length} file(s) — ${verdict}`);
	return lines;
}

/** `{ ok: true, options }` or `{ ok: false, message }` — never throws, never exits. */
export function parseArgs(argv) {
	const options = { root: ROOT };
	for (let index = 0; index < argv.length; index += 1) {
		const argument = argv[index];
		if (argument === "--root") {
			const value = argv[index + 1];
			if (value === undefined || value === "") return { ok: false, message: "--root needs a path" };
			options.root = value;
			index += 1;
			continue;
		}
		return { ok: false, message: argument.startsWith("--") ? `unknown flag: ${argument}` : `unexpected argument: ${argument}` };
	}
	return { ok: true, options };
}

export const USAGE = `usage: check-vocabulary.mjs [--root <dir>]

  Validates ${DATA_PATH}, then scans the living prose —
  ${CORPUS.map(describeEntry).join(", ")} — for a banned synonym.
  --root  the checkout to scan (default: this one)

exit 0 clean · 1 violation(s) in the data file or the prose · 2 usage, or input that cannot be read/parsed`;

/** Run the check. Returns the exit code; `io.out`/`io.err` are the only sinks. */
export function main(argv = process.argv.slice(2), io = {}) {
	const out = io.out ?? console.log;
	const err = io.err ?? console.error;
	const parsed = parseArgs(argv);
	if (!parsed.ok) {
		err(`${USAGE}\n${parsed.message}`);
		return EXIT.USAGE;
	}
	const report = audit({ root: parsed.options.root });
	for (const line of renderReport(report)) out(line);
	if (report.errors.length > 0) {
		for (const message of report.errors) err(`check-vocabulary: ${message}`);
		return EXIT.USAGE;
	}
	return report.violations.length === 0 ? EXIT.OK : EXIT.VIOLATIONS;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main());

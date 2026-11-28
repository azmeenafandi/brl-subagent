// Purpose: The signed-brief contract (issue #606 §2): fence-aware section predicates over briefs/<slug>.md.
/**
 * A signed brief is the record of what the human agreed before any code was
 * written. The predicate is deliberately content-based, because a heading and a
 * marker are trivial to emit and prove nothing:
 *
 *   1. `## Want` — at least one section-body line outside fences that contains
 *      non-whitespace, is not a heading, and is NOT the confirmation marker.
 *   2. `## Settled decisions` — either one table row outside fences (excluding
 *      the header row and the `|---` separator) whose decision cell AND answer
 *      cell are both non-blank, or the explicit zero-decision form
 *      `none — <why>` (the points the human chose not to settle).
 *   3. `confirmed: <YYYY-MM-DD> by <name>` — the last non-blank line outside
 *      fences, with no unfilled `<…>` placeholder left in it.
 *
 * FENCES AND SECTIONS ARE DEFINED ONCE, here, and applied to every predicate:
 * a line inside a ``` fence is not a heading, not a body line and not a table
 * row. `^## ` headings OUTSIDE fences delimit sections; a body runs to the next
 * such heading or to EOF. That single rule is what makes the four shapes below
 * have defined outcomes instead of accidents of whichever predicate an
 * implementer picked: a marker-only file fails (1), a fenced-only Want fails
 * (1), a row with an empty answer cell fails (2), and an honest confirmed want
 * with no decisions passes (2) through the zero-decision form.
 *
 * THE MARKER IS A RECORD, NOT AUTHENTICATION. Nothing here proves the human
 * typed the line; the gate records that a brief claims to be confirmed, the way
 * a commit message records intent. Treat it as evidence to audit, never as a
 * signature to trust.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

/** The directory holding briefs, relative to the dispatch cwd. */
export const BRIEF_DIR = "briefs";

/** The confirmation marker's shape — `confirmed: 2026-11-28 by azmeen`. */
const CONFIRMATION_RE = /^confirmed:\s*(\d{4}-\d{2}-\d{2})\s+by\s+(\S.*)$/;

/** An unfilled template slot: `<date>`, `<name>`, `<…>`. */
const PLACEHOLDER_RE = /<[^>]*>/;

/** The zero-decision form: the em dash AND a non-blank reason. */
const ZERO_DECISION_RE = /^none\s*—\s*\S/;

/** The line that ends the zero-decision form and every Want body. */
const MARKER_LINE_RE = /^confirmed:/i;

/** A section heading, outside fences only — `^## ` delimits sections (spec §2). */
const SECTION_HEADING_RE = /^## /;

/**
 * Any heading at all, for predicate 1's "(b) is not a heading": `### Sub` inside
 * a Want body is a sub-heading, not the human's words, and it must not be able
 * to fill an otherwise empty section.
 */
const ANY_HEADING_RE = /^#{1,6}\s/;

/** One source line, tagged with whether a code fence encloses it. */
interface BriefLine {
	text: string;
	inFence: boolean;
}

export interface BriefVerdict {
	ok: boolean;
	/** Which predicate failed, in prose an author can act on ('' when ok). */
	reason: string;
}

export const BRIEF_OK: BriefVerdict = Object.freeze({ ok: true, reason: "" });

function fail(reason: string): BriefVerdict {
	return { ok: false, reason };
}

/**
 * Tag every line with its fence state. A fence marker line is itself fenced
 * (so it is not a heading and not a body line); a fence left unclosed fences
 * everything after it, which is the fail-closed reading: an unparsable brief is
 * not a signed brief.
 */
function classifyLines(text: string): BriefLine[] {
	const lines: BriefLine[] = [];
	let inFence = false;
	for (const raw of text.split(/\r?\n/)) {
		const isMarker = raw.trim().startsWith("```");
		lines.push({ text: raw, inFence: isMarker || inFence });
		if (isMarker) inFence = !inFence;
	}
	return lines;
}

function isContentLine(line: BriefLine): boolean {
	return !line.inFence && !ANY_HEADING_RE.test(line.text) && line.text.trim() !== "";
}

/**
 * Split fenced-outside lines into sections keyed by their `## ` heading. The
 * heading line itself is dropped; the body runs to the next heading or EOF.
 */
function sections(lines: readonly BriefLine[]): Map<string, BriefLine[]> {
	const map = new Map<string, BriefLine[]>();
	let current: string | undefined;
	for (const line of lines) {
		if (!line.inFence && SECTION_HEADING_RE.test(line.text)) {
			const title = line.text.slice(3).trim();
			current = title;
			if (!map.has(title)) map.set(title, []);
			continue;
		}
		if (current !== undefined) map.get(current)!.push(line);
	}
	return map;
}

/** §2 predicate 1 — a Want section with the human's own words in it. */
function wantProblem(body: readonly BriefLine[] | undefined): string | undefined {
	if (body === undefined) return "`## Want` is missing — state what the human wants, in their words.";
	const filled = body.some(
		(line) => isContentLine(line) && !MARKER_LINE_RE.test(line.text.trim()),
	);
	return filled
		? undefined
		: "`## Want` is empty — the section needs at least one non-blank line of the human's words. " +
				"A fence, a heading and the `confirmed:` marker do not count.";
}

/** §2 predicate 2 — one decision with an answer, or the stated zero-decision form. */
function decisionsProblem(body: readonly BriefLine[] | undefined): string | undefined {
	if (body === undefined) {
		return "`## Settled decisions` is missing — record each settled decision, or write `none — <why>`.";
	}
	const hasRow = body.some((line) => isDecisionRow(line));
	const hasZeroForm = body.some(
		(line) => isContentLine(line) && !MARKER_LINE_RE.test(line.text.trim()) && ZERO_DECISION_RE.test(line.text.trim()),
	);
	if (hasRow || hasZeroForm) return undefined;
	return (
		"`## Settled decisions` is empty — a row needs a non-blank decision cell AND a non-blank answer cell, " +
		"or write the zero-decision form `none — <why>`."
	);
}

/**
 * A table row that settles a decision: decision cell (between the 1st and 2nd
 * `|`) and answer cell (between the 2nd and 3rd `|`) both non-blank. The header
 * row and the `|---` separator are not decisions.
 */
function isDecisionRow(line: BriefLine): boolean {
	if (line.inFence) return false;
	const trimmed = line.text.trim();
	if (!trimmed.startsWith("|")) return false;
	const cells = trimmed.split("|").slice(1, 4);
	if (cells.length < 2) return false;
	const decision = cells[0].trim();
	const answer = cells[1].trim();
	if (decision === "" && answer === "") return false;
	// The `|---|:--|` separator row.
	if (/^[\s:-]+$/.test(decision)) return false;
	// The header row (`| Decision | Answer | …`).
	if (/^decision$/i.test(decision)) return false;
	return decision !== "" && answer !== "";
}

/** §2 predicate 3 — the confirmation marker, last, with no unfilled slot. */
function confirmationProblem(lines: readonly BriefLine[]): string | undefined {
	const outside = lines.filter((line) => !line.inFence);
	let index = outside.length - 1;
	while (index >= 0 && outside[index].text.trim() === "") index--;
	if (index < 0) {
		return "the brief has no confirmation marker — the last non-blank line must be `confirmed: <YYYY-MM-DD> by <name>`.";
	}
	const last = outside[index].text.trim();
	if (PLACEHOLDER_RE.test(last)) {
		return `the confirmation marker still holds an unfilled placeholder — replace it with the date and the human's name: ${last}`;
	}
	if (!CONFIRMATION_RE.test(last)) {
		return `the last non-blank line must be the confirmation marker \`confirmed: <YYYY-MM-DD> by <name>\` — found: ${last}`;
	}
	return undefined;
}

/**
 * Check a brief's TEXT against §2. Predicates are checked in document order so
 * a file that fails several names the first one an author would fix.
 */
export function validateBriefText(text: string): BriefVerdict {
	const lines = classifyLines(String(text ?? ""));
	const bySection = sections(lines);
	for (const problem of [
		wantProblem(bySection.get("Want")),
		decisionsProblem(bySection.get("Settled decisions")),
		confirmationProblem(lines),
	]) {
		if (problem !== undefined) return fail(problem);
	}
	return BRIEF_OK;
}

/** The brief's path for a slug — one `join`, never a slug that skipped the grammar. */
export function briefPath(cwd: string, slug: string): string {
	return join(cwd, BRIEF_DIR, `${slug}.md`);
}

/**
 * Check the brief file at `cwd/briefs/<slug>.md`. Fail-closed in every failure
 * mode: a missing brief is the refusal the gate exists for, and an unreadable
 * one is not evidence of anything.
 */
export function validateBriefFile(cwd: string, slug: string): BriefVerdict {
	const path = briefPath(cwd, slug);
	let text: string;
	try {
		text = readFileSync(path, "utf8");
	} catch (error) {
		const code = (error as NodeJS.ErrnoException).code;
		if (code === "ENOENT") {
			return fail(
				`brief "${slug}" not found at ${path} — the dispatch cwd's tree carries no such brief. ` +
					"Commit the brief before dispatching from this tree, or rebase the tree onto the commit that added it.",
			);
		}
		return fail(`brief "${slug}" at ${path} could not be read (${code ?? "unknown error"}) — an unreadable brief is not a signed brief.`);
	}
	const verdict = validateBriefText(text);
	return verdict.ok ? BRIEF_OK : fail(`brief "${slug}" at ${path} does not satisfy the brief contract: ${verdict.reason}`);
}

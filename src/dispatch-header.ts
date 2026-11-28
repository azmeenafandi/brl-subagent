// Purpose: The mandatory dispatch header (issue #606): split it from the task body and parse it.
/**
 * The dispatch header — one definition, two consumers (issue #606, Unit 1).
 *
 * Every dispatch task must open with a block:
 *
 *     dispatch: impl | review | probe | docs
 *     brief: <slug>             (required when dispatch: impl)
 *     brief: none — <reason>    (the stated escape; reason non-empty)
 *
 * Two consumers, never two parsers:
 *   - `parseDispatchHeader` — the validator's gate (src/validate.ts). It reads
 *     the leading BLOCK only, so a task that merely quotes `dispatch: impl` in
 *     its prose (inline or fenced) stays valid (T3).
 *   - `splitDispatchHeader` — the router's seam (src/params.ts keeps the header
 *     out of `classifyTask`). A header would otherwise re-route a dispatch:
 *     `dispatch: review` matches the code-reviewer rule before the body's own
 *     "write tests" ever reaches the test-engineer rule (spec §3b).
 *
 * BOUNDARY, stated once so CRLF/BOM/blank-separator cases have one answer:
 * the block starts at the first non-blank line and consumes consecutive lines
 * matching `^(dispatch|brief|jev):`, ending at the first line that does not
 * match (a blank line ends it too). The task is `\r?\n`-split and a leading BOM
 * is stripped before the first line is read. A title (`# Task`) before the block
 * ends it — that is a refusal, not a tolerance, because a silent tolerance would
 * let a quoted example at the top of a task become the declaration.
 *
 * The Jev line may still appear ANYWHERE (src/dispatch-line.ts scans every line
 * and takes the first valid one), which is why `jev:` is a block-continuation
 * line here but does not have to be inside the block.
 */

/** The four dispatch kinds. `impl` is the gated class: it needs a brief. */
export const DISPATCH_KINDS = ["impl", "review", "probe", "docs"] as const;
export type DispatchKind = (typeof DISPATCH_KINDS)[number];

/** The kinds as one comma-separated list, quoted verbatim in every refusal. */
export const DISPATCH_KIND_LIST = DISPATCH_KINDS.join(", ");

/**
 * The three accepted forms, quoted VERBATIM in every refusal so the conductor
 * never has to guess. Kept as one constant: a second copy is a second truth.
 */
export const DISPATCH_HEADER_FORMS = [
	"dispatch: impl | review | probe | docs",
	"brief: <slug>             (required when dispatch: impl)",
	"brief: none — <reason>    (the stated escape; reason non-empty)",
].join("\n");

/**
 * A brief slug: one path component, lowercase alphanumeric plus interior
 * hyphens, 1-64 characters. `none` is reserved for the escape and is therefore
 * rejected as a slug. Separators, dots and traversal are all refused by this
 * pattern — never join a slug that has not matched it.
 */
export const BRIEF_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

/** The reserved escape token (`brief: none — <reason>`). */
export const BRIEF_ESCAPE_TOKEN = "none";

/** A line that belongs to the leading block. Anchored: an indented copy does not. */
const BLOCK_LINE_RE = /^(dispatch|brief|jev):/;

const DISPATCH_PREFIX = "dispatch:";
const BRIEF_PREFIX = "brief:";
const EM_DASH = "—";

/** The token is reserved only when it STANDS ALONE — `none-extra` is a legal slug. */
const ESCAPE_PREFIX_RE = new RegExp(`^${BRIEF_ESCAPE_TOKEN}(?:\\s|$)`);
const ESCAPE_VALUE_RE = new RegExp(`^${BRIEF_ESCAPE_TOKEN}\\s*${EM_DASH}\\s*(.*)$`);

export interface DispatchHeaderSplit {
	/** The consumed block, `\n`-joined (empty when the task does not open with one). */
	header: string;
	/** Everything after the block. */
	body: string;
}

/** A brief reference: a signed brief's slug, or the stated escape and its reason. */
export type BriefDeclaration =
	| { kind: "slug"; slug: string }
	| { kind: "none"; reason: string };

export type DispatchHeaderVerdict =
	| { ok: true; kind: DispatchKind; brief: BriefDeclaration | undefined }
	| { ok: false; reason: string };

/**
 * Split a task into its leading dispatch block and the body that follows.
 *
 * Pure and total: any string maps to a pair, and `header + "\n" + body`
 * reconstructs the task apart from the leading blank lines the block start
 * consumes. Never throws — the validator and the router both call it on
 * conductor-supplied text.
 */
export function splitDispatchHeader(task: string): DispatchHeaderSplit {
	const text = String(task ?? "").replace(/^\uFEFF/, "");
	const lines = text.split(/\r?\n/);

	let start = 0;
	while (start < lines.length && lines[start].trim() === "") start++;

	let end = start;
	while (end < lines.length && BLOCK_LINE_RE.test(lines[end])) end++;

	return {
		header: lines.slice(start, end).join("\n"),
		body: lines.slice(end).join("\n"),
	};
}

/** One refusal shape: the finding first, then the three accepted forms verbatim. */
function refuse(detail: string): DispatchHeaderVerdict {
	return { ok: false, reason: `${detail} The accepted dispatch block is:\n${DISPATCH_HEADER_FORMS}` };
}

/** The block's value for one prefix (`undefined` when the line carries none). */
function lineValue(line: string, prefix: string): string {
	return line.slice(prefix.length).trim();
}

/** Parse one `brief:` value into its declaration, or the reason it is not one. */
function parseBriefValue(value: string): BriefDeclaration | { error: string } {
	if (value === "") {
		return { error: "the brief line needs a value — a slug, or the stated escape." };
	}
	// The escape is `none — <reason>` with an EM DASH. The bare token is judged
	// here so `brief: none` cannot slide through as a slug.
	if (ESCAPE_PREFIX_RE.test(value)) {
		const match = ESCAPE_VALUE_RE.exec(value);
		if (match === null) {
			return {
				error: `the brief escape is \`brief: ${BRIEF_ESCAPE_TOKEN} ${EM_DASH} <reason>\` — the em dash and the reason are both required.`,
			};
		}
		const reason = match[1].trim();
		if (reason === "") {
			return { error: "the brief escape's reason is empty — say why no brief was agreed." };
		}
		return { kind: "none", reason };
	}
	if (value === BRIEF_ESCAPE_TOKEN || !BRIEF_SLUG_PATTERN.test(value)) {
		return {
			error:
				`invalid brief slug "${value}": a slug matches ${BRIEF_SLUG_PATTERN.source}, ` +
				`is a single path component (no "/", no ".", no ".."), and "${BRIEF_ESCAPE_TOKEN}" is reserved for the escape.`,
		};
	}
	return { kind: "slug", slug: value };
}

/**
 * Parse the leading dispatch block. Refusals quote the three accepted forms
 * verbatim (§3); success returns the kind and, when one was declared, the brief.
 *
 * A task that does NOT open with a block is refused, and the reason says which:
 * a stray `dispatch:` line later in the text gets "the block must be the first
 * content" (P12), because that is the mistake an author actually makes.
 */
export function parseDispatchHeader(task: string): DispatchHeaderVerdict {
	const { header, body } = splitDispatchHeader(task);
	const blockLines = header === "" ? [] : header.split("\n");

	const dispatchLines = blockLines.filter((line) => line.startsWith(DISPATCH_PREFIX));
	if (dispatchLines.length === 0) {
		const strayDeclaration = body.split(/\r?\n/).some((line) => line.startsWith(DISPATCH_PREFIX));
		return refuse(
			strayDeclaration
				? "missing dispatch header: the block must be the first content — the task's first non-blank line " +
						"is not one of `dispatch:`/`brief:`/`jev:`, so a later declaration is outside the block. " +
						"Move the block to the top of the task."
				: "missing dispatch header: the task's first non-blank line must declare the kind.",
		);
	}
	if (dispatchLines.length > 1) {
		return refuse("more than one `dispatch:` line in the leading block — declare the kind exactly once.");
	}

	const dispatchRest = lineValue(dispatchLines[0], DISPATCH_PREFIX);
	if (dispatchRest === "") {
		return refuse("the dispatch line has no kind — name exactly one.");
	}
	// The one-token rule: no trailing comment, no extra words. `dispatch: impl #
	// note` is ambiguous, and an ambiguous declaration is not a declaration.
	if (/\s/.test(dispatchRest)) {
		return refuse(
			`the dispatch line takes exactly one token — no trailing comment or extra words after "${dispatchRest.split(/\s+/)[0]}".`,
		);
	}
	if (!(DISPATCH_KINDS as readonly string[]).includes(dispatchRest)) {
		return refuse(`unknown dispatch kind "${dispatchRest}" — must be one of: ${DISPATCH_KIND_LIST}.`);
	}
	const kind = dispatchRest as DispatchKind;

	const briefLines = blockLines.filter((line) => line.startsWith(BRIEF_PREFIX));
	if (briefLines.length > 1) {
		return refuse("more than one `brief:` line in the leading block — declare the brief exactly once.");
	}

	let brief: BriefDeclaration | undefined;
	if (briefLines.length === 1) {
		const parsed = parseBriefValue(lineValue(briefLines[0], BRIEF_PREFIX));
		if ("error" in parsed) return refuse(parsed.error);
		brief = parsed;
	}

	if (kind === "impl" && brief === undefined) {
		return refuse(
			"`dispatch: impl` requires a brief — add `brief: <slug>` (the file is briefs/<slug>.md) " +
				`or \`brief: ${BRIEF_ESCAPE_TOKEN} ${EM_DASH} <reason>\` for the stated escape.`,
		);
	}

	return { ok: true, kind, brief };
}

/**
 * The frontmatter `dispatch:` field's problem, or `undefined` when it is absent
 * or one of the four kinds. Shared by the template's load-time validation and
 * its render-time check: an unknown or misspelled value must be an error naming
 * the field and the allowed set, never a silently ignored key (spec §3a).
 */
export function dispatchFieldProblem(value: unknown): string | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "string" || !(DISPATCH_KINDS as readonly string[]).includes(value)) {
		const shown = typeof value === "string" ? `"${value}"` : JSON.stringify(value);
		return `invalid "dispatch" value ${shown} — must be one of: ${DISPATCH_KIND_LIST}.`;
	}
	return undefined;
}

/**
 * Issue #606 (Unit 1) — the dispatch header's parser and boundary rules.
 *
 * T1: the four kinds, and the three refusals that are not about the brief.
 * T3: reading the BLOCK, not the whole text — a quoted `dispatch: impl` in a
 *     review task's prose (inline or fenced) must not become the declaration.
 * T4: the slug grammar, one component, `none` reserved.
 * T5: the §2 content predicates — a marker is not a Want, a row needs an answer.
 * T13 (parse half): a comment on the line, and a title before the block.
 */

import { describe, expect, it } from "vitest";

import {
	BRIEF_SLUG_PATTERN,
	DISPATCH_HEADER_FORMS,
	DISPATCH_KINDS,
	dispatchFieldProblem,
	parseDispatchHeader,
	splitDispatchHeader,
} from "../dispatch-header";
import { validateBriefText, type BriefVerdict } from "../brief";

/** Every refusal quotes the three accepted forms verbatim (spec §3). */
function expectFormsQuoted(verdict: { ok: boolean; reason?: string }): void {
	expect(verdict.ok).toBe(false);
	expect(verdict.reason).toContain(DISPATCH_HEADER_FORMS);
}

// ---------------------------------------------------------------------------
// T1 — the parser
// ---------------------------------------------------------------------------

describe("T1 — parseDispatchHeader accepts the four kinds", () => {
	for (const kind of DISPATCH_KINDS) {
		it(`T1 — dispatch: ${kind} parses`, () => {
			const task = kind === "impl" ? `dispatch: impl\nbrief: consider-tax\n\nDo the work.` : `dispatch: ${kind}\n\nDo the work.`;
			const verdict = parseDispatchHeader(task);
			expect(verdict.ok).toBe(true);
			if (!verdict.ok) return;
			expect(verdict.kind).toBe(kind);
		});
	}

	it("T1 — a missing dispatch line is refused, naming the form", () => {
		const verdict = parseDispatchHeader("jev: high (0.4) · C2 · worktree n\n\nDo the work.");
		expectFormsQuoted(verdict);
		expect(verdict.reason).toContain("missing dispatch header");
	});

	it("T1 — an unknown kind is refused, naming the allowed set", () => {
		const verdict = parseDispatchHeader("dispatch: reveiw\n\nDo the work.");
		expectFormsQuoted(verdict);
		expect(verdict.reason).toContain('unknown dispatch kind "reveiw"');
		expect(verdict.reason).toContain(DISPATCH_KINDS.join(", "));
	});

	it("T1 — an empty escape reason is refused (bare `none` and `none —  `)", () => {
		for (const value of ["none", "none —", "none —   "]) {
			const verdict = parseDispatchHeader(`dispatch: impl\nbrief: ${value}\n\nDo the work.`);
			expectFormsQuoted(verdict);
			expect(verdict.reason).toMatch(/reason/);
		}
	});

	it("T1 — an impl without a brief line is refused, naming the missing line", () => {
		const verdict = parseDispatchHeader("dispatch: impl\n\nDo the work.");
		expectFormsQuoted(verdict);
		expect(verdict.reason).toContain("`dispatch: impl` requires a brief");
		expect(verdict.reason).toContain("brief: <slug>");
	});

	it("T1 — the escape parses as a reason-bearing declaration", () => {
		const verdict = parseDispatchHeader("dispatch: impl\nbrief: none — the conductor could not reach the human\n\nDo it.");
		expect(verdict.ok).toBe(true);
		if (!verdict.ok) return;
		expect(verdict.brief).toEqual({ kind: "none", reason: "the conductor could not reach the human" });
	});
});

// ---------------------------------------------------------------------------
// T3 — the block, never the whole text
// ---------------------------------------------------------------------------

describe("T3 — a review task quoting `dispatch: impl` stays valid", () => {
	it("T3 — an inline quote of the forms does not become the declaration", () => {
		const task = [
			"dispatch: review",
			"jev: medium (0.58) · C2 · worktree y",
			"",
			"Review the gate. It refuses a task whose block says `dispatch: impl` and carries no `brief: <slug>`.",
		].join("\n");
		const verdict = parseDispatchHeader(task);
		expect(verdict.ok).toBe(true);
		if (!verdict.ok) return;
		expect(verdict.kind).toBe("review");
		expect(verdict.brief).toBeUndefined();
	});

	it("T3 — a fenced example of the block does not become the declaration", () => {
		const task = [
			"dispatch: review",
			"jev: medium (0.58) · C2 · worktree y",
			"",
			"Review this body. The example it must accept:",
			"```",
			"dispatch: impl",
			"brief: some-slug",
			"```",
		].join("\n");
		const verdict = parseDispatchHeader(task);
		expect(verdict.ok).toBe(true);
		if (!verdict.ok) return;
		expect(verdict.kind).toBe("review");
	});
});

// ---------------------------------------------------------------------------
// T4 — the slug grammar
// ---------------------------------------------------------------------------

describe("T4 — brief slugs are one lowercase component", () => {
	it("T4 — traversal, separators, uppercase, `none` and an empty value are refused", () => {
		for (const value of ["../x", "a/b", "none", "A", "", "a.b", "-lead", "x".repeat(65)]) {
			const verdict = parseDispatchHeader(`dispatch: impl\nbrief: ${value}\n\nDo the work.`);
			expectFormsQuoted(verdict);
			expect(verdict.reason).toMatch(/brief/);
		}
	});

	it("T4 — `consider-tax` is accepted", () => {
		const verdict = parseDispatchHeader("dispatch: impl\nbrief: consider-tax\n\nDo the work.");
		expect(verdict.ok).toBe(true);
		if (!verdict.ok) return;
		expect(verdict.brief).toEqual({ kind: "slug", slug: "consider-tax" });
	});

	it("T4 — the pattern is the published one", () => {
		expect(BRIEF_SLUG_PATTERN.source).toBe("^[a-z0-9][a-z0-9-]{0,63}$");
	});
});

// ---------------------------------------------------------------------------
// T13 (parse half) — the boundary
// ---------------------------------------------------------------------------

describe("T13 — the block's boundary", () => {
	it("T13 — a trailing comment on the dispatch line is refused (the one-token rule)", () => {
		const verdict = parseDispatchHeader("dispatch: impl   # note\n\nDo the work.");
		expectFormsQuoted(verdict);
		expect(verdict.reason).toMatch(/exactly one token/);
	});

	it("T13 — a title before the block is refused, naming the first-content rule", () => {
		const verdict = parseDispatchHeader("# Task\n\ndispatch: probe\n\nDo the work.");
		expectFormsQuoted(verdict);
		expect(verdict.reason).toContain("the block must be the first content");
	});

	it("T13 — a blank line ends the block (a later `brief:` is body text)", () => {
		const { header, body } = splitDispatchHeader("dispatch: impl\n\nbrief: consider-tax\n\nDo it.");
		expect(header).toBe("dispatch: impl");
		expect(body).toContain("brief: consider-tax");
		// And the block itself is refused for the missing brief — the blank line
		// did not smuggle one in.
		expect(parseDispatchHeader("dispatch: impl\n\nbrief: consider-tax\n\nDo it.").ok).toBe(false);
	});

	it("T13 — a leading BOM and leading blank lines do not hide the block", () => {
		const { header } = splitDispatchHeader("\uFEFF\n\ndispatch: probe\njev: low (0.2) · C1 · worktree n\n\nDo it.");
		expect(header).toBe("dispatch: probe\njev: low (0.2) · C1 · worktree n");
		expect(parseDispatchHeader("\uFEFF\n\ndispatch: probe\n\nDo it.").ok).toBe(true);
	});

	it("T13 — CRLF task text splits the same way", () => {
		const { header, body } = splitDispatchHeader("dispatch: probe\r\njev: low (0.2) · C1 · worktree n\r\n\r\nDo it.");
		expect(header).toBe("dispatch: probe\njev: low (0.2) · C1 · worktree n");
		// The blank separator ENDS the block, so it is the body's first line.
		expect(body).toBe("\nDo it.");
	});

	it("T13 — two dispatch lines in the block are refused as ambiguous", () => {
		const verdict = parseDispatchHeader("dispatch: probe\ndispatch: review\n\nDo it.");
		expect(verdict.ok).toBe(false);
		expect(verdict.reason).toContain("more than one");
	});
});

// ---------------------------------------------------------------------------
// T5 — the §2 content predicates
// ---------------------------------------------------------------------------

const VALID_BRIEF = [
	"## Want",
	"",
	"Make the factory's front door enforceable.",
	"",
	"## Facts",
	"",
	"- src/validate.ts is the pre-spawn seam.",
	"",
	"## Settled decisions",
	"",
	"| Decision | Answer | Rationale |",
	"| --- | --- | --- |",
	"| Gate scope | the code-writing dispatch | boundary A |",
	"",
	"confirmed: 2026-11-28 by azmeen",
].join("\n");

/** `ok` is asserted through the reason so a refactor cannot pass silently. */
function expectRefused(verdict: BriefVerdict, matching: RegExp): void {
	expect(verdict.ok, `expected a refusal matching ${matching}, got ok`).toBe(false);
	expect(verdict.reason).toMatch(matching);
}

describe("T5 — a brief must carry content, not decoration", () => {
	it("T5 — a marker-only file is refused (the marker is not Want content)", () => {
		expectRefused(validateBriefText("confirmed: 2026-11-28 by azmeen"), /## Want. (is empty|is missing)/);
	});

	it("T5 — a hollow table row (empty answer cell) is refused", () => {
		const hollow = VALID_BRIEF.replace("| Gate scope | the code-writing dispatch | boundary A |", "| Gate scope | | boundary A |");
		expectRefused(validateBriefText(hollow), /## Settled decisions. is empty/);
	});

	it("T5 — `none — <why>` is accepted as the zero-decision form", () => {
		const zero = VALID_BRIEF.replace(
			["| Decision | Answer | Rationale |", "| --- | --- | --- |", "| Gate scope | the code-writing dispatch | boundary A |"].join("\n"),
			"none — nothing needed settling beyond the want.",
		);
		expect(validateBriefText(zero).ok).toBe(true);
	});

	it("T5 — a filled Want, a filled row and the marker are accepted", () => {
		expect(validateBriefText(VALID_BRIEF)).toEqual({ ok: true, reason: "" });
	});

	it("T5 — an unsigued brief is refused naming the marker", () => {
		expectRefused(validateBriefText(VALID_BRIEF.replace("confirmed: 2026-11-28 by azmeen", "")), /confirmed: <YYYY-MM-DD> by <name>/);
	});

	it("T5 — an unfilled placeholder in the marker is refused", () => {
		expectRefused(
			validateBriefText(VALID_BRIEF.replace("confirmed: 2026-11-28 by azmeen", "confirmed: <date> by <name>")),
			/unfilled placeholder/,
		);
	});
});

// ---------------------------------------------------------------------------
// The template field's enum — the shared helper (§3a)
// ---------------------------------------------------------------------------

describe("dispatchFieldProblem — the frontmatter enum", () => {
	it("accepts absence and the four kinds", () => {
		expect(dispatchFieldProblem(undefined)).toBeUndefined();
		for (const kind of DISPATCH_KINDS) expect(dispatchFieldProblem(kind)).toBeUndefined();
	});

	it("names the field and the allowed set for anything else", () => {
		for (const value of ["reveiw", "IMPL", "", 7, null]) {
			const problem = dispatchFieldProblem(value);
			expect(problem, String(value)).toContain('"dispatch"');
			expect(problem).toContain(DISPATCH_KINDS.join(", "));
		}
	});
});

/**
 * Issue #606 (Unit 1) — the gate at the validator seam, and the brief fixtures.
 *
 * T2: `impl` with no brief is refused, and the message names the missing form.
 * T6: the opt-in boundary in BOTH directions — an opted-in tree refuses a stale
 *     brief, a tree with no manifest performs no check (the fail-open contract).
 * T12a-T12e: five brief shapes, each with the fixture that makes its predicate
 *     the one that fails — the marker is not a Want, a fence is not body text,
 *     an empty answer cell is not a decision, the zero-decision form is valid,
 *     and an empty escape reason is not a reason.
 * T13 (validator half): a `jev:` line LATER in the body still satisfies the
 *     existing Jev check — the block does not have to contain it.
 */

import { afterEach, describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { validatePreTask } from "../validate";

const dirs: string[] = [];

/** An opted-in project root, plus `briefs/<slug>.md` for each fixture brief. */
function project(briefs: Record<string, string> = {}, optedIn = true): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brl-606-gate-"));
	dirs.push(dir);
	if (optedIn) {
		fs.writeFileSync(
			path.join(dir, "package.json"),
			JSON.stringify({ name: "fixture", "brl-subagent": { processChecks: true } }),
			"utf8",
		);
	}
	for (const [slug, text] of Object.entries(briefs)) {
		fs.mkdirSync(path.join(dir, "briefs"), { recursive: true });
		fs.writeFileSync(path.join(dir, "briefs", `${slug}.md`), text, "utf8");
	}
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

const JEV = "jev: medium (0.58) · C2 · worktree y";

/** The brief shape the contract accepts — the baseline every fixture perturbs. */
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

function gate(task: string, cwd: string) {
	return validatePreTask({ task, cwd });
}

// ---------------------------------------------------------------------------
// T2 — impl without a brief
// ---------------------------------------------------------------------------

describe("T2 — `dispatch: impl` requires a brief", () => {
	it("T2 — impl with no brief line is refused, naming the missing form", () => {
		const result = gate(`dispatch: impl\n${JEV}\n\nImplement the thing.`, project());
		expect(result.valid).toBe(false);
		const text = result.errors.join("\n");
		expect(text).toContain("`dispatch: impl` requires a brief");
		expect(text).toContain("brief: <slug>");
		expect(text).toContain("brief: none — <reason>");
	});

	it("T2 — a review dispatch needs no brief at all", () => {
		const result = gate(`dispatch: review\n${JEV}\n\nReview the change.`, project());
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// T6 — the opt-in boundary, both directions
// ---------------------------------------------------------------------------

describe("T6 — the check follows the dispatch cwd's manifest", () => {
	it("T6 — an opted-in tree refuses a brief the tree does not carry", () => {
		const stale = project();
		const result = gate(`dispatch: impl\nbrief: consider-tax\n${JEV}\n\nImplement it.`, stale);
		expect(result.valid).toBe(false);
		const text = result.errors.join("\n");
		expect(text).toContain(path.join(stale, "briefs", "consider-tax.md"));
		expect(text).toMatch(/not found/);
	});

	it("T6 — a tree with no manifest performs no check at all", () => {
		const plain = project({}, false);
		const result = gate("Implement the thing.", plain);
		expect(result.errors).toEqual([]);
		expect(result.warnings).toEqual([]);
		expect(result.valid).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// T12a-T12e — the brief fixtures
// ---------------------------------------------------------------------------

describe("T12 — the brief's content predicates, one fixture per shape", () => {
	it("T12a — `hollow-marker` is refused: the marker is not Want content", () => {
		// Want exists, but its only line is the confirmation marker. Everything
		// else is valid, so the Want predicate is the one that must fail.
		const hollow = VALID_BRIEF.replace("Make the factory's front door enforceable.\n", "");
		const result = gate(`dispatch: impl\nbrief: hollow-marker\n${JEV}\n\nImplement it.`, project({ "hollow-marker": hollow }));
		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("`## Want` is empty");
	});

	it("T12b — `fenced-only` is refused: a fence is not body text", () => {
		// The `## Want` heading is UNFENCED with only fenced content beneath it,
		// and the decisions + marker are valid — so the fence rule is what fails.
		const fenced = VALID_BRIEF.replace(
			"Make the factory's front door enforceable.",
			["```", "Make the factory's front door enforceable.", "```"].join("\n"),
		);
		const result = gate(`dispatch: impl\nbrief: fenced-only\n${JEV}\n\nImplement it.`, project({ "fenced-only": fenced }));
		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("`## Want` is empty");
	});

	it("T12c — `empty-cell` is refused: the answer cell must be non-whitespace", () => {
		const emptyCell = VALID_BRIEF.replace("| Gate scope | the code-writing dispatch | boundary A |", "| Gate scope |   | boundary A |");
		const result = gate(`dispatch: impl\nbrief: empty-cell\n${JEV}\n\nImplement it.`, project({ "empty-cell": emptyCell }));
		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toContain("`## Settled decisions` is empty");
	});

	it("T12d — `zero-decision-last` is accepted: `none — …` then the marker, decisions last", () => {
		const zeroDecision = [
			"## Want",
			"",
			"Make the factory's front door enforceable.",
			"",
			"## Settled decisions",
			"none — nothing needed settling beyond the want.",
			"",
			"confirmed: 2026-11-28 by azmeen",
		].join("\n");
		const result = gate(
			`dispatch: impl\nbrief: zero-decision-last\n${JEV}\n\nImplement it.`,
			project({ "zero-decision-last": zeroDecision }),
		);
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
	});

	it("T12e — `zero-decision-empty-reason` is refused (both `none —` and `none —   `)", () => {
		for (const value of ["none —", "none —   "]) {
			const emptyReason = [
				"## Want",
				"",
				"Make the factory's front door enforceable.",
				"",
				"## Settled decisions",
				value,
				"",
				"confirmed: 2026-11-28 by azmeen",
			].join("\n");
			const result = gate(
				`dispatch: impl\nbrief: zero-decision-empty-reason\n${JEV}\n\nImplement it.`,
				project({ "zero-decision-empty-reason": emptyReason }),
			);
			expect(result.valid, `fixture value ${JSON.stringify(value)}`).toBe(false);
			expect(result.errors.join("\n")).toContain("`## Settled decisions` is empty");
		}
	});

	it("T12 — a signed brief in the tree passes", () => {
		const result = gate(
			`dispatch: impl\nbrief: consider-tax\n${JEV}\n\nImplement it.`,
			project({ "consider-tax": VALID_BRIEF }),
		);
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// The brief's path, in the refusal (§3 rule 3)
// ---------------------------------------------------------------------------

describe("a missing brief names the path and the fix", () => {
	it("names the exact path, and says how to bring the brief in", () => {
		const root = project();
		const result = gate(`dispatch: impl\nbrief: consider-tax\n${JEV}\n\nImplement it.`, root);
		const text = result.errors.join("\n");
		expect(text).toContain(path.join(root, "briefs", "consider-tax.md"));
		expect(text).toMatch(/commit the brief/i);
	});
});

// ---------------------------------------------------------------------------
// T13 (validator half) — the Jev line may live later in the body
// ---------------------------------------------------------------------------

describe("T13 — the block and the Jev line are independent", () => {
	it("T13 — a `jev:` line later in the body still satisfies the existing Jev check", () => {
		const task = [`dispatch: probe`, "", "Do the work.", "", JEV].join("\n");
		const result = gate(task, project());
		expect(result.errors).toEqual([]);
		expect(result.valid).toBe(true);
	});
});

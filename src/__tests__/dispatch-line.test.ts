/**
 * Issue #412 (absorbs #407) — the dispatch pre-flight's Jev-line check, part 1:
 * the parser, the project-local opt-in, and the conformance pin against the
 * skill's own formatter.
 *
 * Why a parser in `src/` at all: `.pi/` is NOT shipped (it is the dev process
 * tooling), so the extension cannot import `jev-check.mjs`. A second
 * implementation is a second source of truth — which is why the CONFORMANCE
 * test below shells the real script and requires accept/reject agreement on
 * every vector. Mutate either pattern (ours or the script's) and the vector
 * that covers it flips.
 *
 * The check is OPT-IN, per project: `package.json` carries
 * `{"brl-subagent":{"processChecks":true}}` (the umbrella flag, issue #415).
 * Absent → no check (a user's dispatch is never rejected for our process).
 * Both directions are pinned here.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	DISPATCH_LINE_FORM,
	JEV_UNAVAILABLE,
	parseDispatchLine,
} from "../dispatch-line";
import { delegateTaskParamsSchema } from "../schema";
import { KNOWN_DELEGATE_KEYS } from "../params";
import { validatePreTask } from "../validate";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const JEV_CHECK = path.join(REPO_ROOT, ".pi", "skills", "worktree", "jev-check.mjs");

function tempProject(manifest: unknown | null): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "brl-jev-project-"));
	if (manifest !== null) {
		fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify(manifest), "utf8");
	}
	return dir;
}

/** A project that opted in, and one that did not — the two directions. */
const OPTED_IN = tempProject({ name: "opted-in", "brl-subagent": { processChecks: true } });
const OPTED_OUT = tempProject({ name: "opted-out" });

// ---------------------------------------------------------------------------
// The parser
// ---------------------------------------------------------------------------

describe("parseDispatchLine — the accepted form", () => {
	it("accepts the canonical line", () => {
		const verdict = parseDispatchLine("Plan the work.\n\njev: medium (0.84) · C2 · worktree y");
		expect(verdict.ok).toBe(true);
		if (verdict.ok) expect(verdict.line).toBe("jev: medium (0.84) · C2 · worktree y");
	});

	it("accepts a line followed by a recorded reason on the same line", () => {
		expect(
			parseDispatchLine("Task.\n\njev: high (0.91) · C1 · worktree y (deviation: repo-tracked code).").ok,
		).toBe(true);
	});

	it("accepts `jev: unavailable` — the sanctioned escape when the classifier did not run", () => {
		const verdict = parseDispatchLine("Task.\n\njev: unavailable");
		expect(verdict.ok).toBe(true);
		if (verdict.ok) expect(verdict.line).toBe(JEV_UNAVAILABLE);
	});

	it("accepts a second valid line when the first attempt is bare (any valid line satisfies the form)", () => {
		expect(
			parseDispatchLine("jev: medium · C2\njev: medium (0.72) · C2 · worktree y").ok,
		).toBe(true);
	});
});

describe("parseDispatchLine — the refused forms", () => {
	it("refuses a missing line and names the exact form", () => {
		const verdict = parseDispatchLine("Implement the thing. No classification here.");
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) {
			expect(verdict.reason).toMatch(/missing Jev dispatch line/);
			expect(verdict.reason).toContain(DISPATCH_LINE_FORM);
		}
	});

	it("refuses the bare level — the exact form the 2026-10-13/23/27/31 skips took", () => {
		const verdict = parseDispatchLine("Task.\n\njev: medium · C2 · worktree y");
		expect(verdict.ok).toBe(false);
		if (!verdict.ok) expect(verdict.reason).toMatch(/bare level without its classifier confidence/);
	});

	it("refuses an out-of-range confidence", () => {
		expect(parseDispatchLine("jev: medium (1.4) · C2 · worktree y").ok).toBe(false);
	});

	it("refuses an unknown risk class", () => {
		expect(parseDispatchLine("jev: medium (0.84) · C4 · worktree y").ok).toBe(false);
	});

	it("refuses an unknown level", () => {
		expect(parseDispatchLine("jev: banana (0.84) · C2 · worktree y").ok).toBe(false);
	});

	it("refuses a missing worktree answer", () => {
		expect(parseDispatchLine("jev: medium (0.84) · C2").ok).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Conformance — our parser vs the skill's own `--line` formatter
//
// `.pi/` is not shipped, so the script is SHELLED, not imported. Each vector is
// an answer; the CLI decides whether it is a usable classification. When it is,
// the CLI's own printed line must be accepted by our parser (and returned
// verbatim). When it is not, the hand-written line that corresponds to the
// refused answer must be refused by ours too.
//
// Mutation check (Rule 20, run once when this landed): widen ours
// (`(?:\(\s*([0-9.]+)\s*\))?`) → the bare-level vector flips to accept;
// narrow the worktree token to `y` → the "worktree n" vector flips to reject.
// Both were observed failing before the patterns settled.
// ---------------------------------------------------------------------------

interface Vector {
	answer: Record<string, unknown>;
	/** The textual line used when `--line` REFUSES the answer. */
	text?: string;
}

const CONFORMANCE_VECTORS: Vector[] = [
	{ answer: { level: "medium", conf: 0.84, risk: "C2", worktree: true } },
	{ answer: { level: "low", conf: 0.9, risk: "C3", worktree: false } },
	{ answer: { level: "xhigh", conf: 1, risk: "C1", worktree: true } },
	{ answer: { level: "medium", conf: 0.84, risk: "C2", worktree: "yes" } },
	{ answer: { level: "medium", risk: "C2", worktree: true }, text: "jev: medium · C2 · worktree y" },
	{ answer: { level: "medium", conf: "high", risk: "C2", worktree: true }, text: "jev: medium (high) · C2 · worktree y" },
	{ answer: { level: "medium", conf: 1.4, risk: "C2", worktree: true }, text: "jev: medium (1.4) · C2 · worktree y" },
	{ answer: { level: "medium", conf: 0.84, risk: "C4", worktree: true }, text: "jev: medium (0.84) · C4 · worktree y" },
	{ answer: { level: "medium", conf: 0.84, risk: "C2" }, text: "jev: medium (0.84) · C2" },
	{ answer: { level: "banana", conf: 0.84, risk: "C2", worktree: true }, text: "jev: banana (0.84) · C2 · worktree y" },
	{ answer: { level: "medium", conf: 0.84, risk: "C2", worktree: "maybe" }, text: "jev: medium (0.84) · C2 · worktree maybe" },
	{ answer: { level: "medium", conf: 0.5, risk: "C1", worktree: false }, text: "jev: medium (0.5) · C1 · worktree n" },
];

function runLine(answer: Record<string, unknown>) {
	return spawnSync(process.execPath, [JEV_CHECK, "--line", JSON.stringify(answer)], {
		encoding: "utf8",
	});
}

describe("conformance: jev-check.mjs --line and parseDispatchLine agree", () => {
	it("the script is present (it is tracked; a missing script is a hard failure, not a skip)", () => {
		expect(fs.existsSync(JEV_CHECK), `${JEV_CHECK} must exist`).toBe(true);
	});

	for (const vector of CONFORMANCE_VECTORS) {
		const label = JSON.stringify(vector.answer);
		it(`agrees on ${label}`, () => {
			const cli = runLine(vector.answer);
			const cliAccepts = cli.status === 0;
			const text = cliAccepts ? cli.stdout.trim() : vector.text;
			expect(text, `no textual line for a refused answer (${label})`).toBeDefined();

			const ours = parseDispatchLine(text!);
			expect(
				ours.ok,
				`parser disagreed with the script for ${JSON.stringify(text)}: ` +
					`script=${cliAccepts ? "accept" : "reject"}(${cli.status}) ours=${ours.ok ? "accept" : "reject"}`,
			).toBe(cliAccepts);

			if (cliAccepts && ours.ok) expect(ours.line).toBe(cli.stdout.trim());
		});
	}

	it("agrees that `jev: unavailable` passes a dispatch audit (the sanctioned escape)", () => {
		const logFile = path.join(tempProject(null), "subagent.log");
		const task = "Investigate the thing.\n\njev: unavailable";
		fs.writeFileSync(
			logFile,
			JSON.stringify({
				timestamp: "2026-11-02T00:00:00.000Z",
				message: "Background agent spawned",
				data: { agentId: "ffffffff-0000-0000-0000-000000000000", task },
			}) + "\n",
			"utf8",
		);
		const cli = spawnSync(process.execPath, [JEV_CHECK, "--log", logFile], { encoding: "utf8" });
		expect(cli.status, `jev-check --log output: ${cli.stdout}${cli.stderr}`).toBe(0);
		expect(parseDispatchLine(task).ok).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// The opt-in — both directions
//
// The reader itself lives in src/project-flags.ts and is pinned by
// project-flags.test.ts (the single-reader ratchet); here the flag is exercised
// through the validator that every pre-spawn path shares.
// ---------------------------------------------------------------------------

describe("the project-local opt-in", () => {
	it("is ON for a project whose package.json opts in", () => {
		expect(validatePreTask({ task: "Implement the thing.", cwd: OPTED_IN }).valid).toBe(false);
	});

	it("is OFF for a project with no opt-in field (a user's dispatch is never rejected)", () => {
		expect(validatePreTask({ task: "Implement the thing.", cwd: OPTED_OUT }).valid).toBe(true);
	});
});

describe("validatePreTask — the line check inside the one shared validator", () => {
	it("rejects a task with no line when the project opted in", () => {
		const result = validatePreTask({ task: "Implement the thing.", cwd: OPTED_IN });
		expect(result.valid).toBe(false);
		expect(result.errors.join(" ")).toMatch(/missing Jev dispatch line/);
		expect(result.errors.join(" ")).toContain(DISPATCH_LINE_FORM);
	});

	it("accepts the same task when the project did not opt in", () => {
		const result = validatePreTask({ task: "Implement the thing.", cwd: OPTED_OUT });
		expect(result.valid).toBe(true);
	});

	it("accepts a task carrying the canonical line (opt-in on)", () => {
		const result = validatePreTask({
			task: "Implement the thing.\n\njev: medium (0.77) · C2 · worktree y",
			cwd: OPTED_IN,
		});
		expect(result.valid).toBe(true);
	});

	it("accepts `jev: unavailable` (opt-in on)", () => {
		const result = validatePreTask({ task: "Implement the thing.\n\njev: unavailable", cwd: OPTED_IN });
		expect(result.valid).toBe(true);
	});

	it("noJev downgrades the rejection to a WARNING that names the reason", () => {
		const result = validatePreTask({
			task: "Implement the thing.",
			cwd: OPTED_IN,
			noJev: "classifier was down; maintainer approved proceeding",
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
		const warning = result.warnings.find((w) => w.includes("noJev"));
		expect(warning).toBeDefined();
		expect(warning).toContain("classifier was down; maintainer approved proceeding");
	});

	it("an absent cwd performs no project check (unit callers that never resolve a project)", () => {
		expect(validatePreTask({ task: "Implement the thing." }).valid).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// The HANDLER's guard — a stated reason must actually BE a reason (issue #419)
// ---------------------------------------------------------------------------

/*
 * Why these live at the handler and not the schema (ADR 0020): the harness
 * validates tool arguments with `compile(schema, { coerce: true })`, and
 * pi-schema's string rule stringifies booleans and numbers BEFORE the handler
 * is called. So `noJev: true` arrives as the string `"true"` — it satisfies
 * `Type.String({ minLength: 1 })` and the schema can never refuse it. The
 * values below are exactly what the handler receives after that coercion, so
 * each case is written from the handler's point of view, not the model's.
 */
describe("noJev — the handler refuses a bypass whose reason is not a reason", () => {
	/** Dispatch a task with no line and the supplied noJev, against the opted-in project. */
	function dispatch(noJev: unknown) {
		return validatePreTask({
			task: "Implement the thing.",
			cwd: OPTED_IN,
			noJev: noJev as string | undefined,
		});
	}

	/** The bypass never applies: the normal missing-line ERROR, and no noJev warning. */
	function expectRefused(result: ReturnType<typeof validatePreTask>) {
		expect(result.valid).toBe(false);
		expect(result.errors.some((e) => e.includes("missing Jev dispatch line"))).toBe(true);
		expect(result.warnings.some((w) => w.includes("noJev"))).toBe(false);
	}

	it.each([
		["true", "a coerced boolean true"],
		["false", "a coerced boolean false"],
		["42", "a coerced number"],
		["-1.5", "a coerced negative decimal"],
		["", "an empty reason"],
		["   \t ", "a whitespace-only reason"],
	])("refuses %j (%s) instead of downgrading to a warning", (noJev) => {
		expectRefused(dispatch(noJev));
	});

	it("refuses a value the schema could never coerce, without throwing (no .trim on a non-string)", () => {
		for (const raw of [{}, ["captured from the rollout"], 42, true]) {
			expect(() => dispatch(raw), `noJev: ${JSON.stringify(raw)} must not throw`).not.toThrow();
			expectRefused(dispatch(raw));
		}
	});

	it("names the reason when it is a genuine one (the bypass still works)", () => {
		const result = dispatch("captured from the #412 rollout");
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
		expect(result.warnings.some((w) => w.includes("captured from the #412 rollout"))).toBe(true);
	});

	it("keeps the opt-in: with no processChecks the same coerced value is inert", () => {
		const result = validatePreTask({
			task: "Implement the thing.",
			cwd: OPTED_OUT,
			noJev: "true" as string | undefined,
		});
		expect(result.valid).toBe(true);
		expect(result.errors).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Schema pins — the DECLARED shape, and the coercion that defeats it at runtime
// ---------------------------------------------------------------------------

describe("delegate_task schema: noJev is DECLARED a non-empty string", () => {
	it("declares `noJev` as Type.String({ minLength: 1 })", () => {
		const noJev = (delegateTaskParamsSchema.properties as Record<string, Record<string, unknown>>).noJev;
		expect(noJev, "the schema must declare noJev").toBeDefined();
		// This pins the DECLARATION only. It is NOT the guarantee: pi's validator
		// compiles with `coerce: true`, so a boolean/number reason is stringified
		// before the handler runs and never trips this rule (see the coercion pin
		// below and ADR 0020). The stated-reason property is enforced in
		// `validatePreTask`.
		expect(noJev.type).toBe("string");
		expect(noJev.minLength).toBe(1);
	});

	it("registers noJev as a known delegate key (the unknown-param warn must not fire)", () => {
		expect([...KNOWN_DELEGATE_KEYS]).toContain("noJev");
	});
});

describe("harness coercion — the real validator stringifies a boolean/number reason", () => {
	/**
	 * The REAL pi validator (`@earendil-works/pi-ai` → pi-schema `parse()` with
	 * `{ coerce: true }`), imported lazily so this file's other tests do not pay
	 * for loading the SDK. If the module ever stops being importable here, this
	 * pin must not be deleted silently — the reason it cannot run gets recorded
	 * in its place.
	 */
	async function runValidator(noJev: unknown): Promise<any> {
		const { validateToolArguments } = await import("@earendil-works/pi-ai");
		const tool = { name: "delegate_task", parameters: delegateTaskParamsSchema } as any;
		const call = { name: "delegate_task", arguments: { task: "Implement the thing.", noJev } } as any;
		return validateToolArguments(tool, call);
	}

	it("coerces true / false / 42 into their text — so the schema accepts them (issue #419)", async () => {
		expect((await runValidator(true)).noJev).toBe("true");
		expect((await runValidator(false)).noJev).toBe("false");
		expect((await runValidator(42)).noJev).toBe("42");
	});

	it("still refuses \"\" and values it cannot stringify (the half ADR 0018 got right)", async () => {
		for (const raw of ["", {}, ["a reason"]]) {
			await expect(runValidator(raw), `noJev: ${JSON.stringify(raw)}`).rejects.toThrow(/noJev/);
		}
	});

	it("pins the whole path: a coerced boolean reaches the handler as the string that must be refused", async () => {
		const coerced = (await runValidator(true)).noJev;
		expect(coerced).toBe("true");
		const result = validatePreTask({ task: "Implement the thing.", cwd: OPTED_IN, noJev: coerced });
		expect(result.valid).toBe(false);
		expect(result.warnings.some((w) => w.includes("noJev"))).toBe(false);
	});
});

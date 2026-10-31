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
 * `{"brl-subagent":{"requireJevLine":true}}`. Absent → no check (a user's
 * dispatch is never rejected for our process). Both directions are pinned here.
 */

import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
	DISPATCH_LINE_FORM,
	JEV_UNAVAILABLE,
	isJevLineRequired,
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
const OPTED_IN = tempProject({ name: "opted-in", "brl-subagent": { requireJevLine: true } });
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
// ---------------------------------------------------------------------------

describe("isJevLineRequired — the project-local opt-in", () => {
	it("is ON for a project whose package.json opts in", () => {
		expect(isJevLineRequired(OPTED_IN)).toBe(true);
	});

	it("is OFF for a project with no opt-in field (a user's dispatch is never rejected)", () => {
		expect(isJevLineRequired(OPTED_OUT)).toBe(false);
		expect(isJevLineRequired(tempProject({ "brl-subagent": { requireJevLine: false } }))).toBe(false);
	});

	it("is OFF (never throws) when package.json is absent or malformed", () => {
		expect(isJevLineRequired(path.join(os.tmpdir(), "brl-does-not-exist-412"))).toBe(false);
		const broken = tempProject(null);
		fs.writeFileSync(path.join(broken, "package.json"), "{not json", "utf8");
		expect(isJevLineRequired(broken)).toBe(false);
	});

	it("reads the manifest of the DISPATCH cwd, not the conductor's", () => {
		expect(isJevLineRequired(OPTED_IN)).toBe(true);
		expect(isJevLineRequired(OPTED_OUT)).toBe(false);
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
// Schema pins — the bypass reason is a non-empty string, never a boolean
// ---------------------------------------------------------------------------

describe("delegate_task schema: noJev is a non-empty string (refused forms are schema errors)", () => {
	it("declares `noJev` as Type.String({ minLength: 1 })", () => {
		const noJev = (delegateTaskParamsSchema.properties as Record<string, Record<string, unknown>>).noJev;
		expect(noJev, "the schema must declare noJev").toBeDefined();
		// pi's own argument validator enforces this JSON Schema before execute()
		// runs, so `noJev: true` (wrong type) and `noJev: ""` (shorter than
		// minLength) never reach the handler.
		expect(noJev.type).toBe("string");
		expect(noJev.minLength).toBe(1);
	});

	it("registers noJev as a known delegate key (the unknown-param warn must not fire)", () => {
		expect([...KNOWN_DELEGATE_KEYS]).toContain("noJev");
	});
});

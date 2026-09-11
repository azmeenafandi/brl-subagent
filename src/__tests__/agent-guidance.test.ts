import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadBuiltinTemplates } from "../templates";
import {
	buildInventorySummary,
	buildTemplateGuideline,
	formatTemplateSummaryItem,
} from "../index";

// ---------------------------------------------------------------------------
// Issue #154: pin the LLM-facing delegation guidance against the wake contract.
//
// A schema-only conductor has no helpful history — the `delegate_task` tool
// schema is its only standing knowledge channel. #147 added the completion-push
// wake (a background run wakes the conductor with a structured message on a
// terminal state), so the schema must teach "wait for the wake, don't poll"
// rather than the pre-#147 poll anti-pattern. The readme-commands.test.ts
// pattern: read the real source and assert the always-visible schema text is
// present, so a behavioral feature can't ship without its LLM-facing guidance.
// ---------------------------------------------------------------------------

const repoRoot = join(__dirname, "..", "..");
const indexSource = readFileSync(join(repoRoot, "src", "index.ts"), "utf8");

describe("delegate_task prompt guidelines vs. the wake contract (issue #154)", () => {
	it("teaches the wake contract — do not poll (the #147 completion wake)", () => {
		expect(indexSource).toContain("do not poll");
	});

	it("names the structured completion message the conductor is woken with", () => {
		expect(indexSource).toContain("wake the conductor with a structured completion message");
	});

	it("states the completionNotify knob dependency — polling correct only under \"off\"", () => {
		expect(indexSource).toContain("completionNotify");
		expect(indexSource).toContain("polling is only correct");
	});

	it("points the conductor at the authoritative AGENT.md capability reference", () => {
		// Issue #162: a bare toContain("AGENT.md") is trivially satisfied by any
		// mention of the filename, so it stayed green even when the guideline
		// reverted to a hardcoded path (#158 regression class). Pin the CONTRACT
		// instead: the guideline must interpolate the computed helper result, and
		// the retired hardcoded path must be unable to return.
		expect(indexSource).toContain("AGENT.md");
		// The helper is actually used to resolve the shipped reference.
		expect(indexSource).toContain('pkgPath("AGENT.md")');
		// The guideline interpolates the COMPUTED variable. Written as a plain
		// quoted string so it matches the literal source characters — a template
		// literal here would interpolate ${agentMdPath} away instead of matching.
		expect(indexSource).toContain("${agentMdPath}");
		// The pre-#158 hardcoded sync-copy destination cannot return.
		expect(indexSource).not.toContain("extensions/brl-subagent/AGENT.md");
	});

	it("renders the templateSummary into the built guideline (no literal placeholder, real names)", () => {
		// Reconstruct the exact summary the registration path computes, then render
		// the guideline through the production builder. A double-quoted string (the
		// #154 review defect) would leave the literal ${templateSummary} placeholder
		// in the rendered text, so asserting the rendered output catches it — a
		// source-level toContain("${templateSummary}") would instead go green on
		// the very placeholder that broke the feature.
		const builtinTemplates = loadBuiltinTemplates(join(repoRoot, "templates"));
		const templateSummary = buildInventorySummary(builtinTemplates, formatTemplateSummaryItem);
		const rendered = buildTemplateGuideline(templateSummary);

		expect(rendered).not.toContain("${templateSummary}");
		// A real built-in template name must survive into the rendered guidance
		// (so the summary is genuinely interpolated, not merely absent).
		expect(rendered).toContain("analyze-data");
	});
});

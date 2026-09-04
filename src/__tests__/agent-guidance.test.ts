import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

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
		expect(indexSource).toContain("AGENT.md");
	});

	it("includes the generated templateSummary in the guidelines", () => {
		expect(indexSource).toContain("${templateSummary}");
	});
});

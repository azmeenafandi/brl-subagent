/**
 * Tests for H4: Conductor Guardrails
 *
 * Verifies that behavior rules are embedded in promptGuidelines (delegate_task tool)
 * and SUBAGENT_INSTRUCTIONS (subagent system prompt).
 */

import { describe, it, expect } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { SUBAGENT_INSTRUCTIONS } from "../prompt";
import { loadBuiltinPresets, formatPresetRestriction } from "../presets";

// Read source files for static analysis
const INDEX_SRC = fs.readFileSync(
	path.resolve(__dirname, "..", "index.ts"),
	"utf-8",
);

// ---------------------------------------------------------------------------
// promptGuidelines — conductor guardrails
// ---------------------------------------------------------------------------

describe("promptGuidelines — conductor guardrails", () => {
	it("contains the Conductor Guardrails section header", () => {
		expect(INDEX_SRC).toContain("## Conductor Guardrails");
	});

	it("includes thinking level guidance", () => {
		expect(INDEX_SRC).toContain("Match thinking level to task complexity");
	});

	it("includes git mode guidance", () => {
		expect(INDEX_SRC).toContain("gitMode='branch'");
		expect(INDEX_SRC).toContain("gitMode='none'");
	});

	it("includes tools verification guidance", () => {
		expect(INDEX_SRC).toContain("Verify the subagent has the tools it needs");
	});

	it("includes timeout guidance", () => {
		expect(INDEX_SRC).toContain("Set timeout based on task complexity");
	});

	it("references H1 validation in guardrails context", () => {
		// The guardrails should mention that H1 also validates, for context
		expect(INDEX_SRC).toContain("validates configuration before spawning");
	});

	it("exposes preset tool restrictions in the tool description (B1)", () => {
		// Issue #32 part B1: the conductor must see preset restrictions before
		// calling delegate_task, so a preset+outputFile combination can't fail
		// silently. The restriction summary is computed at registration from the
		// real shipped preset files — assert the RENDERED summary, not just that
		// the source contains some strings (a broken interpolation or an empty
		// loadBuiltinPresets result would fail this).
		const presetsDir = path.resolve(__dirname, "..", "..", "presets");
		const builtins = loadBuiltinPresets(presetsDir);
		const summary = builtins
			.map((p: { name: string; excludeTools?: string[]; tools?: string[] }) =>
				p.excludeTools?.length || p.tools?.length
					? `${p.name} (${formatPresetRestriction(p)})`
					: p.name,
			)
			.join(", ");

		// The shipped security-auditor preset is read-only — this is the exact
		// scenario from issue #32 (outputFile silently failed).
		expect(summary).toContain("security-auditor (read-only: excludes write, edit, bash)");
		expect(summary).toContain("code-reviewer (read-only: excludes write, edit, bash)");
		// And the guideline text references the computed summary + the warning.
		expect(INDEX_SRC).toContain("IMPORTANT: some presets restrict tools");
		expect(INDEX_SRC).toContain("outputFile requires the subagent's write tool");
	});
});

// ---------------------------------------------------------------------------
// SUBAGENT_INSTRUCTIONS — configuration detection
// ---------------------------------------------------------------------------

describe("SUBAGENT_INSTRUCTIONS — configuration detection", () => {
	it("includes configuration detection section header", () => {
		expect(SUBAGENT_INSTRUCTIONS).toContain("## Configuration Detection");
	});

	it("includes guidance for missing write tools", () => {
		expect(SUBAGENT_INSTRUCTIONS).toContain(
			"ERROR: Write tools are not available",
		);
	});

	it("includes guidance for missing bash tool", () => {
		expect(SUBAGENT_INSTRUCTIONS).toContain(
			"ERROR: Bash tool is not available",
		);
	});

	it("includes guidance for insufficient thinking level", () => {
		expect(SUBAGENT_INSTRUCTIONS).toContain(
			"NOTE: Thinking level may be insufficient",
		);
	});

	it("does not break existing instructions content", () => {
		// Verify core instructions are still present
		expect(SUBAGENT_INSTRUCTIONS).toContain(
			"Complete the assigned task thoroughly",
		);
		expect(SUBAGENT_INSTRUCTIONS).toContain("## Completion Status");
		expect(SUBAGENT_INSTRUCTIONS).toContain("## Blockers");
		expect(SUBAGENT_INSTRUCTIONS).toContain("delegate_task");
		expect(SUBAGENT_INSTRUCTIONS).toContain("[TO:subagent-id]");
	});
});

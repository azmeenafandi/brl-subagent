/**
 * Tests for prompt.ts — system prompt construction.
 */

import { describe, it, expect } from "vitest";
import {
	buildSubagentPrompt,
	describePromptMode,
	SUBAGENT_INSTRUCTIONS,
} from "../prompt";

// ---------------------------------------------------------------------------
// buildSubagentPrompt
// ---------------------------------------------------------------------------

describe("buildSubagentPrompt", () => {
	const basePrompt = "You are a helpful coding assistant.";

	it("includes base prompt when inherit is true", () => {
		const result = buildSubagentPrompt(basePrompt, true, undefined);
		expect(result).toContain(basePrompt);
		expect(result).toContain(SUBAGENT_INSTRUCTIONS);
	});

	it("excludes base prompt when inherit is false", () => {
		const result = buildSubagentPrompt(basePrompt, false, undefined);
		expect(result).not.toContain(basePrompt);
		expect(result).toContain(SUBAGENT_INSTRUCTIONS);
	});

	it("appends custom prompt after base prompt", () => {
		const custom = "Focus on security issues only.";
		const result = buildSubagentPrompt(basePrompt, true, custom);

		const baseIdx = result.indexOf(basePrompt);
		const customIdx = result.indexOf(custom);
		const instrIdx = result.indexOf(SUBAGENT_INSTRUCTIONS);

		expect(baseIdx).toBeGreaterThanOrEqual(0);
		expect(customIdx).toBeGreaterThan(baseIdx);
		expect(instrIdx).toBeGreaterThan(customIdx);
	});

	it("uses custom prompt as only content when no inheritance", () => {
		const custom = "You are a security auditor.";
		const result = buildSubagentPrompt(basePrompt, false, custom);

		expect(result).not.toContain(basePrompt);
		expect(result).toContain(custom);
		expect(result).toContain(SUBAGENT_INSTRUCTIONS);
	});

	it("includes output block when outputFile is set", () => {
		const result = buildSubagentPrompt(basePrompt, true, undefined, "/tmp/output.md");

		expect(result).toContain("Output Instructions");
		expect(result).toContain("/tmp/output.md");
	});

	it("returns only instructions when both inherit and custom are empty", () => {
		const result = buildSubagentPrompt(basePrompt, false, undefined);
		expect(result).toBe(SUBAGENT_INSTRUCTIONS);
	});

	it("joins sections with double newlines", () => {
		const custom = "Custom instructions.";
		const result = buildSubagentPrompt(basePrompt, true, custom);
		expect(result).toContain("\n\n");
	});
});

// ---------------------------------------------------------------------------
// describePromptMode
// ---------------------------------------------------------------------------

describe("describePromptMode", () => {
	it('returns "inherit + custom instructions" for both', () => {
		expect(describePromptMode(true, true)).toBe("inherit + custom instructions");
	});

	it('returns "inherit" for inherit only', () => {
		expect(describePromptMode(true, false)).toBe("inherit");
	});

	it('returns "custom prompt" for custom only', () => {
		expect(describePromptMode(false, true)).toBe("custom prompt");
	});

	it('returns "default (no inheritance)" for neither', () => {
		expect(describePromptMode(false, false)).toBe("default (no inheritance)");
	});
});

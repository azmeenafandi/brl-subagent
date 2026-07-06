/**
 * Tests for presets.ts — frontmatter parsing, validation, loading.
 */

import { describe, it, expect } from "vitest";
import { parseFrontmatter, validatePreset, validateAllPresets } from "../presets";
import type { SubagentPreset } from "../types";

// ---------------------------------------------------------------------------
// parseFrontmatter
// ---------------------------------------------------------------------------

describe("parseFrontmatter", () => {
	it("returns empty meta and full body when no frontmatter", () => {
		const content = "Just a regular markdown file\n\nWith some content.";
		const result = parseFrontmatter(content);
		expect(result.meta).toEqual({});
		expect(result.body).toBe(content);
	});

	it("parses simple key-value frontmatter", () => {
		const content = [
			"---",
			"name: test-agent",
			"description: A test agent",
			"thinkingLevel: medium",
			"---",
			"",
			"# Test Agent",
			"",
			"You are a test agent.",
		].join("\n");

		const result = parseFrontmatter(content);
		expect(result.meta.name).toBe("test-agent");
		expect(result.meta.description).toBe("A test agent");
		expect(result.meta.thinkingLevel).toBe("medium");
		expect(result.body).toContain("# Test Agent");
	});

	it("parses array values in frontmatter", () => {
		const content = [
			"---",
			"name: reviewer",
			"tools:",
			"  - read",
			"  - grep",
			"  - find",
			"excludeTools:",
			"  - write",
			"  - edit",
			"---",
			"",
			"Review instructions.",
		].join("\n");

		const result = parseFrontmatter(content);
		expect(result.meta.name).toBe("reviewer");
		expect(result.meta.tools).toEqual(["read", "grep", "find"]);
		expect(result.meta.excludeTools).toEqual(["write", "edit"]);
	});

	it("parses boolean-like string values", () => {
		const content = [
			"---",
			"name: agent",
			"inheritSystemPrompt: false",
			"noBuiltinTools: true",
			"---",
			"",
			"Body.",
		].join("\n");

		const result = parseFrontmatter(content);
		expect(result.meta.inheritSystemPrompt).toBe("false");
		expect(result.meta.noBuiltinTools).toBe("true");
	});

	it("strips quotes from string values", () => {
		const content = [
			"---",
			'name: "quoted-agent"',
			"description: 'with single quotes'",
			"---",
			"",
			"Body.",
		].join("\n");

		const result = parseFrontmatter(content);
		expect(result.meta.name).toBe("quoted-agent");
		expect(result.meta.description).toBe("with single quotes");
	});

	it("handles empty frontmatter block", () => {
		// Empty frontmatter with only separators and content
		const content = ["---", "", "---", "", "Body."].join("\n");
		const result = parseFrontmatter(content);
		expect(result.meta).toEqual({});
		expect(result.body).toBe("Body.");
	});

	it("handles frontmatter with empty values", () => {
		// Empty value after key starts array mode; the next separator closes it
		// resulting in an empty array for that key
		const content = ["---", "name: empty-agent", "description:", "---", "", "Body."].join(
			"\n",
		);

		const result = parseFrontmatter(content);
		expect(result.meta.name).toBe("empty-agent");
		expect(result.meta.description).toEqual([]);
	});

	it("handles single key followed by array", () => {
		const content = [
			"---",
			"name: multi-tool",
			"tools:",
			"  - bash",
			"  - read",
			"description: Has many tools",
			"---",
			"",
			"Body.",
		].join("\n");

		const result = parseFrontmatter(content);
		expect(result.meta.name).toBe("multi-tool");
		expect(result.meta.tools).toEqual(["bash", "read"]);
		expect(result.meta.description).toBe("Has many tools");
	});
});

// ---------------------------------------------------------------------------
// validatePreset
// ---------------------------------------------------------------------------

describe("validatePreset", () => {
	it("returns error for missing name", () => {
		const errors = validatePreset({}, "test.md");
		expect(errors.length).toBeGreaterThan(0);
		expect(errors[0]).toContain("missing required");
	});

	it("accepts valid preset with name only", () => {
		expect(validatePreset({ name: "my-agent" }, "test.md")).toEqual([]);
	});

	it("accepts valid thinking level", () => {
		expect(
			validatePreset({ name: "agent", thinkingLevel: "high" }, "test.md"),
		).toEqual([]);
	});

	it("rejects invalid thinking level", () => {
		const errors = validatePreset(
			{ name: "agent", thinkingLevel: "extreme" },
			"test.md",
		);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("invalid thinkingLevel");
	});

	it("rejects invalid inheritSystemPrompt value", () => {
		const errors = validatePreset(
			{ name: "agent", inheritSystemPrompt: "yes" },
			"test.md",
		);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("inheritSystemPrompt");
	});

	it("rejects invalid noBuiltinTools value", () => {
		const errors = validatePreset(
			{ name: "agent", noBuiltinTools: "yes" },
			"test.md",
		);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("noBuiltinTools");
	});

	it("accepts valid boolean string values", () => {
		expect(
			validatePreset(
				{
					name: "agent",
					inheritSystemPrompt: "true",
					noBuiltinTools: "false",
				},
				"test.md",
			),
		).toEqual([]);
		expect(
			validatePreset(
				{
					name: "agent",
					inheritSystemPrompt: "false",
					noBuiltinTools: "true",
				},
				"test.md",
			),
		).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// validateAllPresets
// ---------------------------------------------------------------------------

describe("validateAllPresets", () => {
	it("valid preset array returns empty errors", () => {
		const presets: SubagentPreset[] = [
			{ name: "agent1", thinkingLevel: "high", tools: ["read", "grep"] },
			{ name: "agent2", thinkingLevel: "low" },
		];
		expect(validateAllPresets(presets)).toEqual([]);
	});

	it("invalid preset (empty name) returns error", () => {
		const errors = validateAllPresets([{ name: "" }]);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("empty or missing name");
	});

	it("multiple presets, some valid some not, returns only the invalid error", () => {
		const presets: SubagentPreset[] = [
			{ name: "valid-agent", thinkingLevel: "high" },
			{ name: "" },
			{ name: "another-valid" },
		];
		const errors = validateAllPresets(presets);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("empty or missing name");
	});

	it("invalid thinkingLevel returns error", () => {
		const errors = validateAllPresets([{ name: "agent", thinkingLevel: "extreme" }]);
		expect(errors.length).toBe(1);
		expect(errors[0]).toContain("invalid thinkingLevel");
	});

	it("empty preset array returns empty errors", () => {
		expect(validateAllPresets([])).toEqual([]);
	});
});

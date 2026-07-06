/**
 * Tests for templates.ts — resolveTemplate and extractParamNames.
 */

import { describe, it, expect } from "vitest";
import { resolveTemplate, extractParamNames } from "../templates";
import type { TaskTemplate } from "../types";

// ---------------------------------------------------------------------------
// extractParamNames
// ---------------------------------------------------------------------------

describe("extractParamNames", () => {
	it("extracts a single param", () => {
		expect(extractParamNames("Audit ${file} for issues")).toEqual(["file"]);
	});

	it("extracts multiple params and deduplicates", () => {
		expect(
			extractParamNames("Review ${file} and ${file} and ${reviewer}"),
		).toEqual(["file", "reviewer"]);
	});

	it("returns empty array when no params", () => {
		expect(extractParamNames("Just some plain text")).toEqual([]);
	});

	it("returns empty array for empty string", () => {
		expect(extractParamNames("")).toEqual([]);
	});

	it("handles alphanumeric param names", () => {
		expect(
			extractParamNames("${foo} ${bar123} ${baz}"),
		).toEqual(["bar123", "baz", "foo"]);
	});

	it("returns sorted param names", () => {
		expect(
			extractParamNames("${z} ${a} ${m}"),
		).toEqual(["a", "m", "z"]);
	});
});

// ---------------------------------------------------------------------------
// resolveTemplate
// ---------------------------------------------------------------------------

describe("resolveTemplate", () => {
	it("simple substitution: ${file} replaced with provided value", () => {
		const template: TaskTemplate = {
			name: "test",
			task: "Audit ${file} for security issues",
		};
		const result = resolveTemplate(template, { file: "src/main.ts" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.task).toBe("Audit src/main.ts for security issues");
	});

	it("multiple params: ${a} and ${b} both replaced", () => {
		const template: TaskTemplate = {
			name: "test",
			task: "Compare ${a} with ${b}",
		};
		const result = resolveTemplate(template, { a: "foo", b: "bar" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.task).toBe("Compare foo with bar");
	});

	it("missing param returns error with param name", () => {
		const template: TaskTemplate = {
			name: "test",
			task: "Audit ${file} for issues",
		};
		const result = resolveTemplate(template, {});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("file");
	});

	it("extra params ignored (no error)", () => {
		const template: TaskTemplate = {
			name: "test",
			task: "Audit ${file}",
		};
		const result = resolveTemplate(template, { file: "x.ts", extra: "ignored" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.task).toBe("Audit x.ts");
	});

	it("no params in template, empty params object: returns template unchanged", () => {
		const template: TaskTemplate = {
			name: "test",
			task: "Just a plain task",
		};
		const result = resolveTemplate(template, {});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.task).toBe("Just a plain task");
		expect(result.value.name).toBe("test");
	});

	it("param used in both task and outputFile: both substituted", () => {
		const template: TaskTemplate = {
			name: "test",
			task: "Audit ${file}",
			outputFile: "audit-${file}.md",
		};
		const result = resolveTemplate(template, { file: "main.ts" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.task).toBe("Audit main.ts");
		expect(result.value.outputFile).toBe("audit-main.ts.md");
	});

	it("multiple occurrences of same param: all replaced", () => {
		const template: TaskTemplate = {
			name: "test",
			task: "Check ${file} and ${file} again",
		};
		const result = resolveTemplate(template, { file: "x.ts" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.task).toBe("Check x.ts and x.ts again");
	});

	it("empty string param value: replaced with empty string (no error)", () => {
		const template: TaskTemplate = {
			name: "test",
			task: "Look at ${file}",
		};
		const result = resolveTemplate(template, { file: "" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.task).toBe("Look at ");
	});

	it("multiple missing params reports all missing names", () => {
		const template: TaskTemplate = {
			name: "test",
			task: "Check ${xyz}, ${abc}, and ${def}",
		};
		const result = resolveTemplate(template, { xyz: "x" });
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error).toContain("abc");
		expect(result.error).toContain("def");
		expect(result.error).not.toContain("xyz");
	});

	it("preserves other fields not affected by substitution", () => {
		const template: TaskTemplate = {
			name: "my-template",
			description: "A test",
			task: "Audit ${file}",
			preset: "security-auditor",
			thinkingLevel: "high",
			timeout: 60000,
			inheritSystemPrompt: false,
		};
		const result = resolveTemplate(template, { file: "main.ts" });
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.name).toBe("my-template");
		expect(result.value.description).toBe("A test");
		expect(result.value.preset).toBe("security-auditor");
		expect(result.value.thinkingLevel).toBe("high");
		expect(result.value.timeout).toBe(60000);
		expect(result.value.inheritSystemPrompt).toBe(false);
	});

	it("params object is empty but template has no placeholders: no error", () => {
		const template: TaskTemplate = {
			name: "test",
			task: "Static task with no placeholders",
		};
		const result = resolveTemplate(template, {});
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.value.task).toBe("Static task with no placeholders");
	});
});

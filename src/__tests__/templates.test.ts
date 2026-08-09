/**
 * Tests for templates.ts — resolveTemplate and extractParamNames.
 */

import { describe, it, expect, vi } from "vitest";
import { resolveTemplate, extractParamNames, validateTemplatePresetRefs } from "../templates";
import type { TaskTemplate, SubagentPreset } from "../types";
import type { Logger } from "../logging";

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

// ---------------------------------------------------------------------------
// validateTemplatePresetRefs (issue #81 — load-time cross-check)
// ---------------------------------------------------------------------------

describe("validateTemplatePresetRefs", () => {
	const makePreset = (name: string): SubagentPreset => ({ name });
	const makeTemplate = (name: string, preset?: string): TaskTemplate => ({
		name,
		task: "Do the thing",
		...(preset ? { preset } : {}),
	});

	it("warns for a template whose preset: names a nonexistent preset and returns count 1", () => {
		const log = { warn: vi.fn() } as unknown as Logger;
		const templates = [makeTemplate("code-review", "typo-preset")];
		const allPresets = [makePreset("code-reviewer")];

		const count = validateTemplatePresetRefs(templates, allPresets, log);

		expect(count).toBe(1);
		expect(log.warn).toHaveBeenCalledTimes(1);
		expect(log.warn).toHaveBeenCalledWith(
			expect.stringContaining('Template "code-review"'),
			expect.objectContaining({ template: "code-review", preset: "typo-preset" }),
		);
		expect(log.warn.mock.calls[0][0]).toContain('preset "typo-preset"');
		expect(log.warn.mock.calls[0][0]).toContain("preset-less with auto-route suppressed");
	});

	it("counts multiple dangling references (one warn per template)", () => {
		const log = { warn: vi.fn() } as unknown as Logger;
		const templates = [
			makeTemplate("a", "missing-a"),
			makeTemplate("b", "missing-b"),
			makeTemplate("c", "exists"),
		];
		const allPresets = [makePreset("exists")];

		const count = validateTemplatePresetRefs(templates, allPresets, log);

		expect(count).toBe(2);
		expect(log.warn).toHaveBeenCalledTimes(2);
	});

	it("no warning when all preset: refs resolve (builtin + custom preset names), returns 0", () => {
		const log = { warn: vi.fn() } as unknown as Logger;
		const templates = [
			makeTemplate("builtin-ref", "security-auditor"),
			makeTemplate("custom-ref", "my-custom"),
		];
		const allPresets = [makePreset("my-custom"), makePreset("security-auditor")];

		const count = validateTemplatePresetRefs(templates, allPresets, log);

		expect(count).toBe(0);
		expect(log.warn).not.toHaveBeenCalled();
	});

	it("no warning for templates WITHOUT a preset field, returns 0", () => {
		const log = { warn: vi.fn() } as unknown as Logger;
		const templates = [makeTemplate("plain-a"), makeTemplate("plain-b")];

		const count = validateTemplatePresetRefs(templates, [], log);

		expect(count).toBe(0);
		expect(log.warn).not.toHaveBeenCalled();
	});

	it("is order-independent: presets may be empty while templates reference them", () => {
		// The function takes both universes as parameters and only reads them,
		// so it behaves identically regardless of load order — including when
		// the preset universe is empty.
		const log = { warn: vi.fn() } as unknown as Logger;
		const templates = [makeTemplate("orphan", "ghost-preset")];

		const count = validateTemplatePresetRefs(templates, [], log);

		expect(count).toBe(1);
		expect(log.warn).toHaveBeenCalledTimes(1);
	});

	it("returns the count even when log is omitted (warn is a no-op)", () => {
		const templates = [makeTemplate("dangling", "ghost-preset")];

		const count = validateTemplatePresetRefs(templates, []);

		expect(count).toBe(1);
	});
});

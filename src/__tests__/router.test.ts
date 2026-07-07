/**
 * Tests for router.ts — skill-based routing and auto-preset classification.
 */

import { describe, it, expect } from "vitest";
import { autoRoutePreset } from "../router";
import { getAllPresets } from "../presets";
import type { SubagentPreset } from "../types";

// ---------------------------------------------------------------------------
// Helper: create a minimal preset array with all builtin names
// ---------------------------------------------------------------------------

const ALL_PRESET_NAMES = [
	"security-auditor",
	"code-reviewer",
	"test-engineer",
	"tech-writer",
	"debugger",
	"refactorer",
	"data-analyst",
	"rapid-prototyper",
	"dev-agent",
];

const ALL_PRESETS: SubagentPreset[] = ALL_PRESET_NAMES.map((name) => ({ name }));

// ---------------------------------------------------------------------------
// autoRoutePreset — classification tests
// ---------------------------------------------------------------------------

describe("autoRoutePreset", () => {
	it("classifies security task → security-auditor", () => {
		expect(autoRoutePreset("audit src/ for security issues", ALL_PRESETS)).toBe("security-auditor");
	});

	it("classifies code review task → code-reviewer", () => {
		expect(autoRoutePreset("review this PR for code quality", ALL_PRESETS)).toBe("code-reviewer");
	});

	it("classifies test task → test-engineer", () => {
		expect(autoRoutePreset("write unit tests for auth module", ALL_PRESETS)).toBe("test-engineer");
	});

	it("classifies documentation task → tech-writer", () => {
		expect(autoRoutePreset("document the API endpoints", ALL_PRESETS)).toBe("tech-writer");
	});

	it("classifies debug task → debugger", () => {
		expect(autoRoutePreset("debug the login crash", ALL_PRESETS)).toBe("debugger");
	});

	it("classifies refactor task → refactorer", () => {
		expect(autoRoutePreset("refactor the user service", ALL_PRESETS)).toBe("refactorer");
	});

	it("classifies data analysis task → data-analyst", () => {
		expect(autoRoutePreset("analyze performance data", ALL_PRESETS)).toBe("data-analyst");
	});

	it("classifies prototype task → rapid-prototyper", () => {
		expect(autoRoutePreset("quick prototype of the new feature", ALL_PRESETS)).toBe("rapid-prototyper");
	});

	it("classifies implementation task → dev-agent", () => {
		expect(autoRoutePreset("implement the payment module", ALL_PRESETS)).toBe("dev-agent");
	});

	it("returns undefined for unrecognized task", () => {
		expect(autoRoutePreset("hello world", ALL_PRESETS)).toBeUndefined();
	});

	it("returns undefined for empty string", () => {
		expect(autoRoutePreset("", ALL_PRESETS)).toBeUndefined();
	});

	it("first match wins when multiple categories match", () => {
		// "audit" matches security-auditor, "review" matches code-reviewer
		// security-auditor is checked first
		expect(autoRoutePreset("audit and review the code", ALL_PRESETS)).toBe("security-auditor");
	});

	it("is case-insensitive", () => {
		expect(autoRoutePreset("SECURITY audit of the app", ALL_PRESETS)).toBe("security-auditor");
		expect(autoRoutePreset("Debug The Login Crash", ALL_PRESETS)).toBe("debugger");
	});

	it("returns undefined when matching preset is not in available list", () => {
		const limitedPresets: SubagentPreset[] = [{ name: "dev-agent" }];
		// "vulnerability" matches security-auditor (not available)
		expect(autoRoutePreset("check for vulnerability", limitedPresets)).toBeUndefined();
		expect(autoRoutePreset("implement the payment module", limitedPresets)).toBe("dev-agent");
	});
});

// ---------------------------------------------------------------------------
// getAllPresets
// ---------------------------------------------------------------------------

describe("getAllPresets", () => {
	it("returns combined unique list of builtins + customs", () => {
		const builtins: SubagentPreset[] = [
			{ name: "code-reviewer" },
			{ name: "debugger" },
		];
		const customs: SubagentPreset[] = [
			{ name: "my-custom" },
			{ name: "another-custom" },
		];
		const result = getAllPresets(builtins, customs);
		expect(result).toEqual([
			{ name: "code-reviewer" },
			{ name: "debugger" },
			{ name: "my-custom" },
			{ name: "another-custom" },
		]);
	});

	it("empty customs returns just builtins", () => {
		const builtins: SubagentPreset[] = [{ name: "test-engineer" }];
		const result = getAllPresets(builtins, []);
		expect(result).toEqual([{ name: "test-engineer" }]);
	});

	it("empty builtins returns just customs", () => {
		const customs: SubagentPreset[] = [{ name: "my-custom" }];
		const result = getAllPresets([], customs);
		expect(result).toEqual([{ name: "my-custom" }]);
	});

	it("returns empty array when both are empty", () => {
		expect(getAllPresets([], [])).toEqual([]);
	});

	it("preserves order: builtins first, then customs", () => {
		const builtins: SubagentPreset[] = [{ name: "a" }, { name: "b" }];
		const customs: SubagentPreset[] = [{ name: "c" }];
		const result = getAllPresets(builtins, customs);
		expect(result.map((p) => p.name)).toEqual(["a", "b", "c"]);
	});
});

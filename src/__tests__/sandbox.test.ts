/**
 * Tests for P7 — Subagent Sandboxing.
 *
 * Tests the sandbox resolution logic, constants, and type guards.
 */

import { describe, it, expect } from "vitest";
import type { SandboxLevel, SubagentToolOptions } from "../types";
import { SANDBOX_TOOLS, SANDBOX_EXCLUDE, isSubagentStateShape } from "../types";

// ---------------------------------------------------------------------------
// SANDBOX_TOOLS and SANDBOX_EXCLUDE constants
// ---------------------------------------------------------------------------

describe("SANDBOX_TOOLS", () => {
	it("none level returns undefined", () => {
		expect(SANDBOX_TOOLS.none).toBeUndefined();
	});

	it("readonly level returns read, grep, find, ls", () => {
		expect(SANDBOX_TOOLS.readonly).toEqual(["read", "grep", "find", "ls"]);
	});

	it("safe level returns read, grep, find, ls, bash", () => {
		expect(SANDBOX_TOOLS.safe).toEqual(["read", "grep", "find", "ls", "bash"]);
	});
});

describe("SANDBOX_EXCLUDE", () => {
	it("none level returns undefined", () => {
		expect(SANDBOX_EXCLUDE.none).toBeUndefined();
	});

	it("readonly level excludes write, edit, bash", () => {
		expect(SANDBOX_EXCLUDE.readonly).toEqual(["write", "edit", "bash"]);
	});

	it("safe level excludes write, edit", () => {
		expect(SANDBOX_EXCLUDE.safe).toEqual(["write", "edit"]);
	});
});

// ---------------------------------------------------------------------------
// Sandbox resolution logic (inline merge function replicating index.ts)
// ---------------------------------------------------------------------------

/**
 * Replicates the sandbox resolution logic from resolveSubagentParams.
 *
 * Resolution order:
 *   1. If sandboxLevel is "none", tools and excludes pass through unchanged
 *   2. If sandboxLevel is not "none", apply sandbox defaults
 *   3. Explicit per-call user tools/excludeTools override sandbox defaults
 *
 * Note: This function only handles the sandbox application part.
 * The full resolveSubagentParams also handles preset merging before this step.
 */
function applySandbox(
	sandboxLevel: SandboxLevel,
	mergedTools: string[] | undefined,
	mergedExcludeTools: string[] | undefined,
	mergedNoBuiltinTools: boolean | undefined,
	userExplicitTools?: string[],
	userExplicitExcludeTools?: string[],
): SubagentToolOptions | undefined {
	let finalTools = mergedTools;
	let finalExcludeTools = mergedExcludeTools;
	let finalNoBuiltinTools = mergedNoBuiltinTools;

	if (sandboxLevel !== "none") {
		const sandboxToolsList = SANDBOX_TOOLS[sandboxLevel];
		const sandboxExcludeList = SANDBOX_EXCLUDE[sandboxLevel];

		// Use explicit user overrides if provided, otherwise use sandbox defaults
		finalTools = userExplicitTools ?? sandboxToolsList;
		finalExcludeTools = userExplicitExcludeTools ?? sandboxExcludeList;
	}

	return finalTools || finalExcludeTools || finalNoBuiltinTools
		? {
				tools: finalTools,
				excludeTools: finalExcludeTools,
				noBuiltinTools: finalNoBuiltinTools,
			}
		: undefined;
}

describe("sandbox resolution logic", () => {
	it("none level: tools and excludeTools pass through unchanged", () => {
		const result = applySandbox(
			"none",
			["read", "write"],
			["bash"],
			undefined,
		);
		expect(result).toEqual({
			tools: ["read", "write"],
			excludeTools: ["bash"],
			noBuiltinTools: undefined,
		});
	});

	it("none level: undefined tools pass through as undefined", () => {
		const result = applySandbox("none", undefined, undefined, undefined);
		expect(result).toBeUndefined();
	});

	it("readonly level: sets tools to read, grep, find, ls", () => {
		const result = applySandbox(
			"readonly",
			undefined,
			undefined,
			undefined,
		);
		expect(result).toEqual({
			tools: ["read", "grep", "find", "ls"],
			excludeTools: ["write", "edit", "bash"],
			noBuiltinTools: undefined,
		});
	});

	it("safe level: sets tools to read, grep, find, ls, bash", () => {
		const result = applySandbox(
			"safe",
			undefined,
			undefined,
			undefined,
		);
		expect(result).toEqual({
			tools: ["read", "grep", "find", "ls", "bash"],
			excludeTools: ["write", "edit"],
			noBuiltinTools: undefined,
		});
	});

	it("readonly level with explicit tools override: uses user's tools instead of sandbox defaults", () => {
		const result = applySandbox(
			"readonly",
			undefined, // mergedTools (preset didn't set tools)
			undefined,
			undefined,
			["read", "grep"], // userExplicitTools
		);
		expect(result).toEqual({
			tools: ["read", "grep"],
			excludeTools: ["write", "edit", "bash"], // sandbox default exclude
			noBuiltinTools: undefined,
		});
	});

	it("readonly level with explicit excludeTools override: uses user's excludes instead of sandbox defaults", () => {
		const result = applySandbox(
			"readonly",
			undefined,
			undefined,
			undefined,
			undefined,
			["write", "edit", "bash", "custom-tool"], // userExplicitExcludeTools
		);
		expect(result).toEqual({
			tools: ["read", "grep", "find", "ls"], // sandbox default tools
			excludeTools: ["write", "edit", "bash", "custom-tool"],
			noBuiltinTools: undefined,
		});
	});

	it("readonly level with BOTH explicit tools and excludes: both override sandbox", () => {
		const result = applySandbox(
			"readonly",
			undefined,
			undefined,
			undefined,
			["read", "grep", "bash"], // userExplicitTools
			["write"], // userExplicitExcludeTools
		);
		expect(result).toEqual({
			tools: ["read", "grep", "bash"],
			excludeTools: ["write"],
			noBuiltinTools: undefined,
		});
	});

	it("safe level with explicit tools override: uses user's tools", () => {
		const result = applySandbox(
			"safe",
			undefined,
			undefined,
			undefined,
			["read", "ls", "bash", "edit"], // userExplicitTools — user wants edit too
		);
		expect(result).toEqual({
			tools: ["read", "ls", "bash", "edit"],
			excludeTools: ["write", "edit"], // sandbox default exclude still applies
			noBuiltinTools: undefined,
		});
	});

	it("none level ignores explicit overrides (sandbox not active)", () => {
		// When sandbox is "none", user's explicit params are already in mergedTools
		// So we don't re-apply them
		const result = applySandbox(
			"none",
			["read", "write"], // already merged from user param
			undefined,
			undefined,
			["should", "not", "override"], // userExplicitTools (not used for "none")
		);
		expect(result).toEqual({
			tools: ["read", "write"],
			excludeTools: undefined,
			noBuiltinTools: undefined,
		});
	});
});

// ---------------------------------------------------------------------------
// isSubagentStateShape with defaultSandboxLevel
// ---------------------------------------------------------------------------

describe("isSubagentStateShape with defaultSandboxLevel", () => {
	it("accepts valid defaultSandboxLevel 'none'", () => {
		expect(
			isSubagentStateShape({
				maxThinkingLevel: "off",
				maxParallel: 0,
				defaultSandboxLevel: "none",
			}),
		).toBe(true);
	});

	it("accepts valid defaultSandboxLevel 'readonly'", () => {
		expect(
			isSubagentStateShape({
				maxThinkingLevel: "off",
				maxParallel: 0,
				defaultSandboxLevel: "readonly",
			}),
		).toBe(true);
	});

	it("accepts valid defaultSandboxLevel 'safe'", () => {
		expect(
			isSubagentStateShape({
				maxThinkingLevel: "off",
				maxParallel: 0,
				defaultSandboxLevel: "safe",
			}),
		).toBe(true);
	});

	it("rejects invalid defaultSandboxLevel", () => {
		expect(
			isSubagentStateShape({
				maxThinkingLevel: "off",
				maxParallel: 0,
				defaultSandboxLevel: "invalid",
			}),
		).toBe(false);
	});

	it("accepts state without defaultSandboxLevel (optional)", () => {
		expect(
			isSubagentStateShape({
				maxThinkingLevel: "off",
				maxParallel: 0,
			}),
		).toBe(true);
	});
});

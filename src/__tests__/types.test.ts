/**
 * Tests for types.ts — type guards, helpers, and constants.
 */

import { describe, it, expect } from "vitest";
import {
	THINKING_LEVELS,
	resolveThinkingLevel,
	formatTokens,
	formatUsageStats,
	getFinalOutput,
	isSubagentError,
	formatModel,
	formatMaxParallel,
	isSubagentStateShape,
	isSubagentRunShape,
	EMPTY_USAGE,
} from "../types";

// ---------------------------------------------------------------------------
// resolveThinkingLevel
// ---------------------------------------------------------------------------

describe("resolveThinkingLevel", () => {
	it("returns maxAllowed when requested is undefined", () => {
		expect(resolveThinkingLevel(undefined, "high")).toBe("high");
		expect(resolveThinkingLevel(undefined, "off")).toBe("off");
	});

	it("returns the requested level when <= max", () => {
		expect(resolveThinkingLevel("low", "high")).toBe("low");
		expect(resolveThinkingLevel("medium", "medium")).toBe("medium");
		expect(resolveThinkingLevel("off", "off")).toBe("off");
	});

	it("caps at maxAllowed when requested > max", () => {
		expect(resolveThinkingLevel("xhigh", "low")).toBe("low");
		expect(resolveThinkingLevel("high", "off")).toBe("off");
		expect(resolveThinkingLevel("xhigh", "minimal")).toBe("minimal");
	});

	it("handles all valid thinking levels", () => {
		for (const max of THINKING_LEVELS) {
			for (const req of THINKING_LEVELS) {
				const result = resolveThinkingLevel(req, max);
				const maxIdx = THINKING_LEVELS.indexOf(max);
				const reqIdx = THINKING_LEVELS.indexOf(req);
				const expectedIdx = Math.min(reqIdx, maxIdx);
				expect(result).toBe(THINKING_LEVELS[expectedIdx]);
			}
		}
	});
});

// ---------------------------------------------------------------------------
// formatTokens
// ---------------------------------------------------------------------------

describe("formatTokens", () => {
	it("returns raw count for values < 1000", () => {
		expect(formatTokens(0)).toBe("0");
		expect(formatTokens(42)).toBe("42");
		expect(formatTokens(999)).toBe("999");
	});

	it("formats with one decimal for values 1k-10k", () => {
		expect(formatTokens(1000)).toBe("1.0k");
		expect(formatTokens(1500)).toBe("1.5k");
		expect(formatTokens(9999)).toBe("10.0k");
	});

	it("rounds to nearest k for values 10k-1M", () => {
		expect(formatTokens(10000)).toBe("10k");
		expect(formatTokens(45678)).toBe("46k");
		expect(formatTokens(999999)).toBe("1000k");
	});

	it("formats millions with one decimal", () => {
		expect(formatTokens(1000000)).toBe("1.0M");
		expect(formatTokens(2500000)).toBe("2.5M");
	});
});

// ---------------------------------------------------------------------------
// formatUsageStats
// ---------------------------------------------------------------------------

describe("formatUsageStats", () => {
	it("returns empty string for zero usage", () => {
		const usage = { ...EMPTY_USAGE };
		expect(formatUsageStats(usage)).toBe("");
	});

	it("includes turn count", () => {
		expect(formatUsageStats({ ...EMPTY_USAGE, turns: 1 })).toContain("1 turn");
		expect(formatUsageStats({ ...EMPTY_USAGE, turns: 5 })).toContain("5 turns");
	});

	it("includes input/output tokens", () => {
		const usage = { ...EMPTY_USAGE, input: 500, output: 200 };
		const result = formatUsageStats(usage);
		expect(result).toContain("↑500");
		expect(result).toContain("↓200");
	});

	it("includes cost with 4 decimal places", () => {
		const usage = { ...EMPTY_USAGE, cost: 0.0234 };
		expect(formatUsageStats(usage)).toContain("$0.0234");
	});

	it("includes cache read/write", () => {
		const usage = { ...EMPTY_USAGE, cacheRead: 1000, cacheWrite: 500 };
		const result = formatUsageStats(usage);
		expect(result).toContain("R1.0k");
		expect(result).toContain("W500");
	});

	it("appends model name when provided", () => {
		const result = formatUsageStats({ ...EMPTY_USAGE }, "openai/gpt-4");
		expect(result).toContain("openai/gpt-4");
	});
});

// ---------------------------------------------------------------------------
// getFinalOutput
// ---------------------------------------------------------------------------

describe("getFinalOutput", () => {
	it("returns empty string for no messages", () => {
		expect(getFinalOutput([])).toBe("");
	});

	it("returns text from last assistant message", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			{
				role: "assistant",
				content: [
					{ type: "text", text: "First response" },
					{ type: "toolCall", name: "read", arguments: {} },
				],
			},
			{
				role: "assistant",
				content: [{ type: "text", text: "Final response" }],
			},
		];
		expect(getFinalOutput(messages)).toBe("Final response");
	});

	it("skips non-text content blocks", () => {
		const messages = [
			{
				role: "assistant",
				content: [
					{ type: "toolCall", name: "read", arguments: {} },
					{ type: "text", text: "After tool call" },
				],
			},
		];
		expect(getFinalOutput(messages)).toBe("After tool call");
	});

	it("returns empty string if no assistant text found", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "query" }] },
		];
		expect(getFinalOutput(messages)).toBe("");
	});
});

// ---------------------------------------------------------------------------
// isSubagentError
// ---------------------------------------------------------------------------

describe("isSubagentError", () => {
	function makeResult(overrides: Partial<import("../types").SubagentResult> = {}) {
		return {
			messages: [],
			usage: { ...EMPTY_USAGE },
			exitCode: 0,
			stderr: "",
			...overrides,
		};
	}

	it("returns false for successful exit", () => {
		expect(isSubagentError(makeResult({ exitCode: 0 }))).toBe(false);
	});

	it("returns true for non-zero exit code", () => {
		expect(isSubagentError(makeResult({ exitCode: 1 }))).toBe(true);
	});

	it("returns true for error stop reason", () => {
		expect(isSubagentError(makeResult({ stopReason: "error" }))).toBe(true);
	});

	it("returns true for aborted stop reason", () => {
		expect(isSubagentError(makeResult({ stopReason: "aborted" }))).toBe(true);
	});

	it("returns false for normal stop reason", () => {
		expect(isSubagentError(makeResult({ stopReason: "end" }))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// formatModel / formatMaxParallel
// ---------------------------------------------------------------------------

describe("formatModel", () => {
	it("formats model with provider/id", () => {
		expect(formatModel({ provider: "openai", id: "gpt-4" })).toBe("openai/gpt-4");
	});

	it("returns fallback for undefined", () => {
		expect(formatModel(undefined)).toContain("Not set");
	});
});

describe("formatMaxParallel", () => {
	it('returns "unlimited" for 0', () => {
		expect(formatMaxParallel(0)).toBe("unlimited");
	});

	it("returns string number for positive values", () => {
		expect(formatMaxParallel(3)).toBe("3");
		expect(formatMaxParallel(10)).toBe("10");
	});
});

// ---------------------------------------------------------------------------
// isSubagentStateShape (F5: Type guard)
// ---------------------------------------------------------------------------

describe("isSubagentStateShape", () => {
	it("rejects null/undefined", () => {
		expect(isSubagentStateShape(null)).toBe(false);
		expect(isSubagentStateShape(undefined)).toBe(false);
	});

	it("rejects non-objects", () => {
		expect(isSubagentStateShape("string")).toBe(false);
		expect(isSubagentStateShape(42)).toBe(false);
	});

	it("accepts empty valid state", () => {
		expect(isSubagentStateShape({ maxThinkingLevel: "off", maxParallel: 0 })).toBe(true);
	});

	it("accepts full valid state", () => {
		expect(
			isSubagentStateShape({
				model: { provider: "openai", id: "gpt-4" },
				maxThinkingLevel: "medium",
				maxParallel: 4,
				seenRunIds: ["abc", "def"],
				presets: [],
			}),
		).toBe(true);
	});

	it("rejects invalid thinking level", () => {
		expect(
			isSubagentStateShape({ maxThinkingLevel: "super_high", maxParallel: 0 }),
		).toBe(false);
	});

	it("rejects negative maxParallel", () => {
		expect(
			isSubagentStateShape({ maxThinkingLevel: "off", maxParallel: -1 }),
		).toBe(false);
	});

	it("rejects negative maxSubagentDepth", () => {
		expect(
			isSubagentStateShape({ maxThinkingLevel: "off", maxSubagentDepth: -1 }),
		).toBe(false);
	});

	it("accepts valid maxSubagentDepth", () => {
		expect(
			isSubagentStateShape({ maxThinkingLevel: "off", maxSubagentDepth: 0 }),
		).toBe(true);
		expect(
			isSubagentStateShape({ maxThinkingLevel: "off", maxSubagentDepth: 5 }),
		).toBe(true);
	});

	it("rejects invalid model shape", () => {
		expect(
			isSubagentStateShape({
				model: { provider: 123, id: "gpt-4" },
				maxThinkingLevel: "off",
				maxParallel: 0,
			}),
		).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// isSubagentRunShape (F5: Type guard)
// ---------------------------------------------------------------------------

describe("isSubagentRunShape", () => {
	it("rejects null/undefined", () => {
		expect(isSubagentRunShape(null)).toBe(false);
	});

	it("accepts valid run shape", () => {
		expect(
			isSubagentRunShape({
				id: "abc-123",
				task: "Audit src/",
				status: "running",
				model: "openai/gpt-4",
				thinkingLevel: "high",
				startedAt: new Date().toISOString(),
			}),
		).toBe(true);
	});

	it("rejects invalid status", () => {
		expect(
			isSubagentRunShape({
				id: "abc",
				task: "test",
				status: "completed",
			}),
		).toBe(false);
	});

	it("rejects missing required fields", () => {
		expect(isSubagentRunShape({ status: "done" })).toBe(false);
		expect(isSubagentRunShape({ id: "abc", status: "done" })).toBe(false);
	});
});

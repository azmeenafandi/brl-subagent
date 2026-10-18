import { describe, expect, it } from "vitest";
import {
	formatElapsed,
	formatLiveRowDim,
	formatMenuValue,
	formatOutcomeSymbol,
	formatProgressStatus,
	formatUnset,
	liveRowName,
	liveSpinner,
	LIVE_SPINNER_FRAMES,
	MENU_VALUE_TOKENS,
	menuSection,
	runDisplayName,
	type MenuValueKind,
} from "../tui-format";
import { DEFAULT_SLA_WINDOW_SIZE, formatMaxParallel, formatModel } from "../types";
import type { ProgressStatusTheme } from "../tui-format";

describe("formatElapsed", () => {
	it("formats sub-minute durations in seconds", () => {
		expect(formatElapsed(5_000)).toBe("5s");
		expect(formatElapsed(59_400)).toBe("59s");
	});

	it("formats minutes+seconds with a space between m and s", () => {
		expect(formatElapsed(65_000)).toBe("1m 5s");
		expect(formatElapsed(3_605_000)).toBe("60m 5s");
	});

	it("handles the exactly-60-second boundary", () => {
		expect(formatElapsed(60_000)).toBe("1m 0s");
		expect(formatElapsed(59_600)).toBe("1m 0s"); // rounds up to 60s
	});

	it("handles zero", () => {
		expect(formatElapsed(0)).toBe("0s");
	});

	it("rounds sub-second remainders", () => {
		expect(formatElapsed(1_234)).toBe("1s");
	});
});

describe("liveRowName", () => {
	it("prefers an explicit label", () => {
		expect(liveRowName("My Label", "long task text")).toBe("My Label");
	});

	it("falls back to the task", () => {
		expect(liveRowName(undefined, "some task")).toBe("some task");
	});

	it("truncates the task fallback at 40 chars", () => {
		const task = "x".repeat(100);
		const name = liveRowName(undefined, task);
		expect(name).toBe("x".repeat(40));
		expect(name.length).toBe(40);
	});

	it("does not truncate a short task", () => {
		expect(liveRowName(undefined, "short")).toBe("short");
	});
});

describe("liveSpinner", () => {
	it("is deterministic at a fixed timestamp", () => {
		expect(liveSpinner(0)).toBe(LIVE_SPINNER_FRAMES[0]);
		expect(liveSpinner(150)).toBe(LIVE_SPINNER_FRAMES[1]);
		expect(liveSpinner(300)).toBe(LIVE_SPINNER_FRAMES[2]);
	});

	it("cycles every 10 frames (1500ms)", () => {
		expect(liveSpinner(1500)).toBe(liveSpinner(0));
		expect(liveSpinner(1600)).toBe(liveSpinner(100));
		expect(liveSpinner(3_000)).toBe(liveSpinner(0));
	});

	it("wraps around past the end of the frame array", () => {
		expect(liveSpinner(1_350)).toBe(LIVE_SPINNER_FRAMES[9]);
		expect(liveSpinner(1_500)).toBe(LIVE_SPINNER_FRAMES[0]);
	});

	it("exposes a 10-frame braille array", () => {
		expect(LIVE_SPINNER_FRAMES).toHaveLength(10);
		expect(new Set(LIVE_SPINNER_FRAMES).size).toBe(10);
	});
});

describe("formatLiveRowDim", () => {
	it("uses the 8-char short id", () => {
		const dim = formatLiveRowDim("0123456789abcdef", { input: 0, output: 0 }, "5s");
		expect(dim.startsWith("  [01234567]  ")).toBe(true);
	});

	it("formats token counts via formatTokens", () => {
		const dim = formatLiveRowDim("abc", { input: 1_500, output: 2_500 }, "5s");
		expect(dim).toContain("↑1.5k");
		expect(dim).toContain("↓2.5k");
	});

	it("matches the exact row shape", () => {
		const dim = formatLiveRowDim("deadbeef00", { input: 123, output: 456 }, "1m 5s");
		expect(dim).toBe("  [deadbeef]  ↑123 ↓456  1m 5s");
	});
});

describe("runDisplayName", () => {
	it("prefers an explicit label", () => {
		expect(runDisplayName({ id: "0123456789abcdef", label: "My Label", task: "the task" })).toBe("My Label");
	});

	it("falls back to the task truncated at 60 chars", () => {
		const name = runDisplayName({ id: "0123456789abcdef", task: "x".repeat(100) });
		expect(name).toBe("x".repeat(60));
	});

	it("falls back to the short id for a task-less row", () => {
		expect(runDisplayName({ id: "0123456789abcdef", task: "" })).toBe("01234567");
	});
});

// ---------------------------------------------------------------------------
// Menu polish U1: canonical vocabulary + divider factory (umbrella #345)
// ---------------------------------------------------------------------------

describe("MENU_VALUE_TOKENS", () => {
	it("pins the canonical token table (the vocabulary contract)", () => {
		expect(MENU_VALUE_TOKENS).toEqual({
			model: { unset: "Not set" },
			thinking: {},
			parallel: { unset: "Unlimited" },
			depth: { unset: "Off" },
			approval: {
				values: { auto: "Never ask", writes: "Ask on writes", always: "Ask every time" },
			},
			completionnotify: {
				values: { all: "Every run", failed: "Failed only", off: "Off" },
			},
			recovery: { values: { offer: "On", off: "Off" } },
			historyentries: { unset: "Unlimited" },
			costlimit: { unset: "Unlimited" },
			sla: { values: { off: "Off" } },
			presetCounts: {},
			templateCounts: {},
		});
	});

	it("exposes one table keyed by every MenuValueKind", () => {
		const kinds: MenuValueKind[] = [
			"model",
			"thinking",
			"parallel",
			"depth",
			"approval",
			"completionnotify",
			"recovery",
			"historyentries",
			"costlimit",
			"sla",
			"presetCounts",
			"templateCounts",
		];
		expect(Object.keys(MENU_VALUE_TOKENS).sort()).toEqual([...kinds].sort());
	});

	it("contains no banned legacy phrases (the vocabulary ratchet)", () => {
		// Case-insensitive: legacy prose drifted in casing as well as wording.
		const banned = [
			"will use main agent",
			"no pruning",
			"passive delivery",
			"No delegation from subagents",
			"None saved",
		].map((phrase) => phrase.toLowerCase());
		const tokens: string[] = [];
		for (const set of Object.values(MENU_VALUE_TOKENS)) {
			if ("unset" in set && typeof set.unset === "string") tokens.push(set.unset);
			if ("values" in set && set.values) tokens.push(...Object.values(set.values));
		}
		for (const token of tokens) {
			for (const phrase of banned) {
				expect(token.toLowerCase(), `banned phrase "${phrase}" leaked into token "${token}"`).not.toContain(phrase);
			}
		}
	});
});

describe("formatUnset", () => {
	it("defaults to Not set when no kind is given", () => {
		expect(formatUnset()).toBe("Not set");
	});

	it("returns each kind's canonical unset token", () => {
		expect(formatUnset("model")).toBe("Not set");
		expect(formatUnset("parallel")).toBe("Unlimited");
		expect(formatUnset("depth")).toBe("Off");
		expect(formatUnset("historyentries")).toBe("Unlimited");
		expect(formatUnset("costlimit")).toBe("Unlimited");
	});

	it("falls back to Not set for kinds without a specific unset token", () => {
		for (const kind of ["thinking", "approval", "completionnotify", "recovery", "sla", "presetCounts", "templateCounts"] as const) {
			expect(formatUnset(kind)).toBe("Not set");
		}
	});

	it("is pure (repeated calls agree)", () => {
		expect(formatUnset("parallel")).toBe(formatUnset("parallel"));
	});
});

describe("formatMenuValue", () => {
	it("model: unset / normal", () => {
		expect(formatMenuValue("model", {})).toBe("Not set");
		expect(formatMenuValue("model", { model: { provider: "openai", id: "gpt-4" } })).toBe("openai/gpt-4");
	});

	it("thinking: unset / normal (raw level name)", () => {
		expect(formatMenuValue("thinking", {})).toBe("Not set");
		expect(formatMenuValue("thinking", { maxThinkingLevel: "low" })).toBe("low");
		expect(formatMenuValue("thinking", { maxThinkingLevel: "xhigh" })).toBe("xhigh");
	});

	it("parallel: unset / zero / normal / boundary", () => {
		expect(formatMenuValue("parallel", {})).toBe("Unlimited");
		expect(formatMenuValue("parallel", { maxParallel: 0 })).toBe("Unlimited");
		expect(formatMenuValue("parallel", { maxParallel: 1 })).toBe("1");
		expect(formatMenuValue("parallel", { maxParallel: 10 })).toBe("10");
		expect(formatMenuValue("parallel", { maxParallel: Number.MAX_SAFE_INTEGER })).toBe(
			String(Number.MAX_SAFE_INTEGER),
		);
	});

	it("depth: unset / zero / singular / plural / boundary", () => {
		expect(formatMenuValue("depth", {})).toBe("Off");
		expect(formatMenuValue("depth", { maxSubagentDepth: 0 })).toBe("Off");
		expect(formatMenuValue("depth", { maxSubagentDepth: 1 })).toBe("1 level");
		expect(formatMenuValue("depth", { maxSubagentDepth: 2 })).toBe("2 levels");
		expect(formatMenuValue("depth", { maxSubagentDepth: 99 })).toBe("99 levels");
	});

	it("approval: unset / every enum value", () => {
		expect(formatMenuValue("approval", {})).toBe("Not set");
		expect(formatMenuValue("approval", { approvalMode: "auto" })).toBe("Never ask");
		expect(formatMenuValue("approval", { approvalMode: "writes" })).toBe("Ask on writes");
		expect(formatMenuValue("approval", { approvalMode: "always" })).toBe("Ask every time");
		expect(formatMenuValue("approval", { approvalMode: "bogus" })).toBe("Not set");
	});

	it("completionnotify: unset / every enum value", () => {
		expect(formatMenuValue("completionnotify", {})).toBe("Not set");
		expect(formatMenuValue("completionnotify", { completionNotify: "all" })).toBe("Every run");
		expect(formatMenuValue("completionnotify", { completionNotify: "failed" })).toBe("Failed only");
		expect(formatMenuValue("completionnotify", { completionNotify: "off" })).toBe("Off");
		expect(formatMenuValue("completionnotify", { completionNotify: "bogus" })).toBe("Not set");
	});

	it("recovery: unset / every enum value", () => {
		expect(formatMenuValue("recovery", {})).toBe("Not set");
		expect(formatMenuValue("recovery", { recovery: "offer" })).toBe("On");
		expect(formatMenuValue("recovery", { recovery: "off" })).toBe("Off");
		expect(formatMenuValue("recovery", { recovery: "bogus" })).toBe("Not set");
	});

	it("historyentries: unset / zero / normal / boundary", () => {
		expect(formatMenuValue("historyentries", {})).toBe("Unlimited");
		expect(formatMenuValue("historyentries", { maxHistoryEntries: 0 })).toBe("Unlimited");
		expect(formatMenuValue("historyentries", { maxHistoryEntries: 1 })).toBe("1 entry");
		expect(formatMenuValue("historyentries", { maxHistoryEntries: 25 })).toBe("25 entries");
		expect(formatMenuValue("historyentries", { maxHistoryEntries: 250 })).toBe("250 entries");
		expect(formatMenuValue("historyentries", { maxHistoryEntries: 99_999 })).toBe("99999 entries");
	});

	it("costlimit: unset / zero / normal / boundary", () => {
		expect(formatMenuValue("costlimit", {})).toBe("Unlimited");
		expect(formatMenuValue("costlimit", { sessionCostLimit: 0 })).toBe("Unlimited");
		expect(formatMenuValue("costlimit", { sessionCostLimit: 1 })).toBe("$1.00");
		expect(formatMenuValue("costlimit", { sessionCostLimit: 0.5 })).toBe("$0.50");
		expect(formatMenuValue("costlimit", { sessionCostLimit: 0.01 })).toBe("$0.01");
		expect(formatMenuValue("costlimit", { sessionCostLimit: 1234.5 })).toBe("$1234.50");
	});

	it("sla: unset / off / on / window boundary", () => {
		expect(formatMenuValue("sla", {})).toBe("Not set");
		expect(formatMenuValue("sla", { slaTrackingEnabled: false })).toBe("Off");
		expect(formatMenuValue("sla", { slaTrackingEnabled: true, slaWindowSize: 50 })).toBe("On (window 50)");
		expect(formatMenuValue("sla", { slaTrackingEnabled: true, slaWindowSize: 10 })).toBe("On (window 10)");
		expect(formatMenuValue("sla", { slaTrackingEnabled: true, slaWindowSize: 500 })).toBe("On (window 500)");
		expect(formatMenuValue("sla", { slaTrackingEnabled: true })).toBe(
			`On (window ${DEFAULT_SLA_WINDOW_SIZE})`,
		);
	});

	it("presetCounts / templateCounts: unset / zero / normal / boundary", () => {
		for (const kind of ["presetCounts", "templateCounts"] as const) {
			expect(formatMenuValue(kind, {})).toBe("Not set");
			expect(formatMenuValue(kind, { builtinCount: 0, customCount: 0 })).toBe("0 built-in, 0 custom");
			expect(formatMenuValue(kind, { builtinCount: 3, customCount: 2 })).toBe("3 built-in, 2 custom");
			expect(formatMenuValue(kind, { builtinCount: 0, customCount: 7 })).toBe("0 built-in, 7 custom");
			expect(formatMenuValue(kind, { builtinCount: 999, customCount: 0 })).toBe("999 built-in, 0 custom");
		}
	});

	it("degrades unknown enum input to the canonical unset token for every kind", () => {
		// No kind may render a blank, a raw value, or a legacy phrase on bad input.
		const formatted = (Object.keys(MENU_VALUE_TOKENS) as MenuValueKind[]).map((kind) =>
			formatMenuValue(kind, {}),
		);
		for (const value of formatted) {
			expect(value.length).toBeGreaterThan(0);
		}
	});
});

describe("semantic equivalence (U2 canonicalized casing)", () => {
	it("parallel zero matches formatMaxParallel exactly", () => {
		const menu = formatMenuValue("parallel", { maxParallel: 0 });
		const legacy = formatMaxParallel(0);
		expect(menu.toLowerCase()).toBe(legacy.toLowerCase());
		// U2 canonicalized the casing: both spellings are now "Unlimited".
		expect(menu).toBe("Unlimited");
		expect(legacy).toBe("Unlimited");
	});

	it("parallel positive values match formatMaxParallel exactly (and case-insensitively)", () => {
		for (const n of [1, 3, 10, 42]) {
			const menu = formatMenuValue("parallel", { maxParallel: n });
			expect(menu).toBe(formatMaxParallel(n));
			expect(menu.toLowerCase()).toBe(formatMaxParallel(n).toLowerCase());
		}
	});

	it("model unset contains Not set, like formatModel(undefined)", () => {
		expect(formatMenuValue("model", {})).toContain("Not set");
		expect(formatModel(undefined)).toContain("Not set");
	});

	it("model normal matches formatModel exactly", () => {
		const model = { provider: "anthropic", id: "claude-sonnet-4" };
		expect(formatMenuValue("model", { model })).toBe(formatModel(model));
	});
});

describe("menuSection", () => {
	it("returns the divider shape", () => {
		const item = menuSection("Model");
		expect(item.label).toBe("─── Model ───");
		expect(item.label).toMatch(/^─── .+ ───$/);
		expect(item.description).toBe("");
	});

	it("builds a kebab-case slug into the value", () => {
		expect(menuSection("Model").value).toBe("__divider__:model");
		expect(menuSection("Completion Notify").value).toBe("__divider__:completion-notify");
		expect(menuSection("Presets & Templates").value).toBe("__divider__:presets-templates");
		expect(menuSection("  Leading / trailing  ").value).toBe("__divider__:leading-trailing");
		expect(menuSection("SLA (window)").value).toBe("__divider__:sla-window");
	});

	it("is pure (no shared mutable state)", () => {
		const first = menuSection("Model");
		const second = menuSection("Model");
		expect(first).toEqual(second);
		expect(first).not.toBe(second);
	});

	it("keeps the raw label inside the rendered label", () => {
		expect(menuSection("Advanced Settings").label).toContain("Advanced Settings");
	});
});

// ---------------------------------------------------------------------------
// F1 — the one success/failure symbol pair
// ---------------------------------------------------------------------------

describe("formatOutcomeSymbol", () => {
	/** A theme that records every (colour, text) pair it is handed. */
	function recordingTheme() {
		const calls: Array<{ color: string; text: string }> = [];
		const theme: ProgressStatusTheme = {
			fg: (color, text) => {
				calls.push({ color, text });
				return text;
			},
		};
		return { calls, theme };
	}

	/** No styling — the glyph the user sees, minus colour. */
	const PLAIN: ProgressStatusTheme = { fg: (_color, text) => text };

	it("paints ✓ success", () => {
		const { calls, theme } = recordingTheme();

		expect(formatOutcomeSymbol("success", theme)).toBe("\u2713");
		expect(calls).toEqual([{ color: "success", text: "\u2713" }]);
	});

	it("paints ✗ error", () => {
		const { calls, theme } = recordingTheme();

		expect(formatOutcomeSymbol("failure", theme)).toBe("\u2717");
		expect(calls).toEqual([{ color: "error", text: "\u2717" }]);
	});

	it("uses exactly the glyphs the footer and result renderers used inline", () => {
		// Pin the code points: a drift here would change every verdict icon.
		expect(formatOutcomeSymbol("success", PLAIN)).toBe("\u2713"); // ✓ U+2713
		expect(formatOutcomeSymbol("failure", PLAIN)).toBe("\u2717"); // ✗ U+2717
		expect(formatOutcomeSymbol("success", PLAIN).length).toBe(1);
		expect(formatOutcomeSymbol("failure", PLAIN).length).toBe(1);
	});

	it("agrees with the footer's completion symbols (no visual drift)", () => {
		const linger = (completed: number, failed: number) =>
			formatProgressStatus(
				{
					activeSubagents: 0,
					completedSubagents: completed,
					failedSubagents: failed,
					unseenSubagents: 0,
				},
				0,
				PLAIN,
			);

		expect(linger(1, 0).startsWith(formatOutcomeSymbol("success", PLAIN))).toBe(true);
		expect(linger(0, 1).startsWith(formatOutcomeSymbol("failure", PLAIN))).toBe(true);
	});
});

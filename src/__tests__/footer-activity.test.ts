/**
 * Issue #354 — the footer activity indicator.
 *
 * The formatter half (`src/tui-format.ts`) is pure: spinner frame from `now`,
 * `formatElapsed` for the suffix, the per-outcome colour of the completion
 * segment (painted as one unit, symbols included), segment omission, and the
 * unseen count inside the segment.
 */

import { describe, expect, it } from "vitest";
import {
	LIVE_SPINNER_FRAME_MS,
	LIVE_SPINNER_FRAMES,
	formatProgressSegments,
	formatProgressStatus,
	progressCompletionColor,
	type ProgressStatusInput,
	type ProgressStatusTheme,
} from "../tui-format";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** A theme that returns the text unchanged, with the colours it was asked for. */
function recordingTheme() {
	const calls: Array<{ color: string; text: string }> = [];
	const theme: ProgressStatusTheme = {
		fg: (color: string, text: string) => {
			calls.push({ color, text });
			return text;
		},
	};
	return { calls, theme };
}

/** The composed line with no styling — what the user sees, minus colour. */
const PLAIN: ProgressStatusTheme = { fg: (_color, text) => text };

/** Base counters: one active run, no completions. */
function input(overrides: Partial<ProgressStatusInput> = {}): ProgressStatusInput {
	return {
		activeSubagents: 1,
		completedSubagents: 0,
		failedSubagents: 0,
		unseenSubagents: 0,
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// Formatter — shape and text
// ---------------------------------------------------------------------------

describe("formatProgressStatus — active line (issue #354)", () => {
	it("renders spinner, prefix, counts and elapsed in the agreed shape", () => {
		const state = input({
			activeSubagents: 2,
			completedSubagents: 1,
			failedSubagents: 1,
			activeSinceMs: 1_000,
		});

		// 75_000 = frame 0 of the cycle, 74 s of elapsed.
		expect(formatProgressStatus(state, 75_000, PLAIN)).toBe(
			`${LIVE_SPINNER_FRAMES[0]} brl: 2 running, \u2713 1 done, \u2717 1 failed \u00b7 1m 14s`,
		);
	});

	it("selects the spinner frame from `now` at 150 ms per frame, wrapping the cycle", () => {
		const state = input();
		const cycle = LIVE_SPINNER_FRAMES.length * LIVE_SPINNER_FRAME_MS;

		LIVE_SPINNER_FRAMES.forEach((frame, index) => {
			expect(
				formatProgressStatus(state, index * LIVE_SPINNER_FRAME_MS, PLAIN).startsWith(frame),
			).toBe(true);
		});
		expect(formatProgressStatus(state, cycle, PLAIN)).toBe(
			formatProgressStatus(state, 0, PLAIN),
		);
	});

	it("derives the elapsed suffix from formatElapsed (sub-minute and multi-minute)", () => {
		const state = input({ activeSinceMs: 0 });

		expect(formatProgressStatus(state, 7_000, PLAIN)).toContain(` \u00b7 7s`);
		expect(formatProgressStatus(state, 74_000, PLAIN)).toContain(` \u00b7 1m 14s`);
		expect(formatProgressStatus(state, 3_605_000, PLAIN)).toContain(` \u00b7 60m 5s`);
	});

	it("clamps a backwards clock jump at 0s instead of printing a negative age", () => {
		const state = input({ activeSinceMs: 10_000 });

		expect(formatProgressStatus(state, 4_000, PLAIN)).toContain(` \u00b7 0s`);
	});

	it("omits the elapsed suffix when no anchor is known", () => {
		const state = input({ activeSinceMs: undefined });

		const text = formatProgressStatus(state, 0, PLAIN);

		expect(text).toBe(`${LIVE_SPINNER_FRAMES[0]} brl: 1 running`);
		expect(text).not.toContain("\u00b7");
	});

	it("keeps the mode breakdown in front of the active count", () => {
		const state = input({
			activeSubagents: 2,
			modeContext: { kind: "graph", wave: 1, totalWaves: 2, node: 2, totalNodes: 3 },
			activeSinceMs: 0,
		});

		expect(formatProgressStatus(state, 0, PLAIN)).toBe(
			`${LIVE_SPINNER_FRAMES[0]} brl: graph wave 1/2 \u00b7 node 2/3, 2 running \u00b7 0s`,
		);
	});
});

describe("formatProgressStatus — completion segment (issue #354)", () => {
	it("carries the unseen count inside the segment", () => {
		const state = input({
			activeSubagents: 2,
			completedSubagents: 2,
			unseenSubagents: 1,
			activeSinceMs: 0,
		});

		expect(formatProgressStatus(state, 0, PLAIN)).toBe(
			`${LIVE_SPINNER_FRAMES[0]} brl: 2 running, \u2713 2 done (1 unseen) \u00b7 0s`,
		);
	});

	it("omits the unseen parenthesis when nothing is unseen", () => {
		const state = input({ activeSubagents: 1, completedSubagents: 1, unseenSubagents: 0 });

		expect(formatProgressStatus(state, 0, PLAIN)).toContain("\u2713 1 done");
		expect(formatProgressStatus(state, 0, PLAIN)).not.toContain("unseen");
	});

	it("is omitted entirely when nothing has completed or failed", () => {
		const state = input({ activeSubagents: 3, activeSinceMs: 0 });

		const text = formatProgressStatus(state, 0, PLAIN);

		expect(text).not.toContain("\u2713");
		expect(text).not.toContain("\u2717");
		expect(text).toBe(`${LIVE_SPINNER_FRAMES[0]} brl: 3 running \u00b7 0s`);
	});

	it("lingers without spinner and elapsed once every run has settled", () => {
		const state = input({
			activeSubagents: 0,
			completedSubagents: 3,
			unseenSubagents: 1,
			activeSinceMs: undefined,
		});

		const text = formatProgressStatus(state, 123_456, PLAIN);

		expect(text).toBe("\u2713 brl: 3 done (1 unseen)");
		// No spinner: the same line at any `now` is identical.
		expect(formatProgressStatus(state, 999_999, PLAIN)).toBe(text);
	});

	it("keeps the prefix inside the segment on a mixed linger line", () => {
		const state = input({ activeSubagents: 0, completedSubagents: 1, failedSubagents: 1 });

		expect(formatProgressStatus(state, 0, PLAIN)).toBe(
			"\u2713 brl: 1 done, \u2717 1 failed",
		);
	});
});

// ---------------------------------------------------------------------------
// Formatter — colour paths
// ---------------------------------------------------------------------------

describe("progressCompletionColor — outcome wins the segment colour (issue #354)", () => {
	it("all success → success", () => {
		expect(progressCompletionColor(3, 0)).toBe("success");
	});

	it("mixed → warning", () => {
		expect(progressCompletionColor(2, 1)).toBe("warning");
		expect(progressCompletionColor(1, 0)).toBe("success"); // guard: failed=0 is not mixed
	});

	it("failure only → error", () => {
		expect(progressCompletionColor(0, 2)).toBe("error");
	});
});

describe("formatProgressStatus — themed segments (issue #354)", () => {
	it("paints the active segment accent and the elapsed suffix muted", () => {
		const { calls, theme } = recordingTheme();

		formatProgressStatus(
			input({ activeSubagents: 2, completedSubagents: 1, activeSinceMs: 1_000 }),
			75_000,
			theme,
		);

		expect(calls).toEqual([
			{ color: "accent", text: `${LIVE_SPINNER_FRAMES[0]} brl: 2 running, ` },
			{ color: "success", text: "\u2713 1 done" },
			{ color: "muted", text: " \u00b7 1m 14s" },
		]);
	});

	it("paints a mixed completion segment warning as one unit (symbols included)", () => {
		const { calls, theme } = recordingTheme();

		formatProgressStatus(
			input({ activeSubagents: 1, completedSubagents: 1, failedSubagents: 1 }),
			0,
			theme,
		);

		expect(calls[1]).toEqual({ color: "warning", text: "\u2713 1 done, \u2717 1 failed" });
	});

	it("paints a failure-only completion segment error", () => {
		const { calls, theme } = recordingTheme();

		const text = formatProgressStatus(
			input({ activeSubagents: 0, failedSubagents: 2 }),
			0,
			theme,
		);

		expect(calls).toEqual([{ color: "error", text: "\u2717 brl: 2 failed" }]);
		expect(text).toBe("\u2717 brl: 2 failed");
	});

	it("paints a success-only linger line success", () => {
		const { calls, theme } = recordingTheme();

		formatProgressStatus(
			input({ activeSubagents: 0, completedSubagents: 2, unseenSubagents: 2 }),
			0,
			theme,
		);

		expect(calls).toEqual([{ color: "success", text: "\u2713 brl: 2 done (2 unseen)" }]);
	});
});

describe("formatProgressSegments — composition (issue #354)", () => {
	it("keeps the completion group contiguous and the separators with their segment", () => {
		const segments = formatProgressSegments(
			input({
				activeSubagents: 1,
				completedSubagents: 1,
				failedSubagents: 1,
				activeSinceMs: 0,
			}),
			0,
		);

		expect(segments.map((s) => s.color)).toEqual(["accent", "warning", "muted"]);
		expect(segments[0].text.endsWith(", ")).toBe(true);
		expect(segments[2].text.startsWith(" \u00b7 ")).toBe(true);
	});

	it("emits no segment for a state with nothing to report", () => {
		expect(formatProgressSegments(input({ activeSubagents: 0 }), 0)).toEqual([]);
	});
});

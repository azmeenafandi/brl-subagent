/**
 * Issue #354 — the footer activity indicator.
 *
 * Two halves, both pinned here:
 *  1. FORMATTER (`src/tui-format.ts`) — pure: spinner frame from `now`,
 *     `formatElapsed` for the suffix, the per-outcome colour of the completion
 *     segment (painted as one unit, symbols included), segment omission, and
 *     the unseen count inside the segment.
 *  2. TICKER (`src/concurrency.ts`) — one interval: started by the first
 *     active run, stopped when the last one settles or the session shuts down,
 *     never mutating the counters and never replacing the 3 s linger/reset.
 *  3. LINGER TIMER (F2) — ONE `setTimeout` on the session, edge-triggered on
 *     the transition into `active === 0`, so repeated renders cannot stack.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	LIVE_SPINNER_FRAME_MS,
	LIVE_SPINNER_FRAMES,
	formatProgressSegments,
	formatProgressStatus,
	progressCompletionColor,
	type ProgressStatusInput,
	type ProgressStatusTheme,
} from "../tui-format";
import {
	clearProgressLinger,
	stopProgressTicker,
	syncProgressLinger,
	updateProgressStatus,
} from "../concurrency";
import { createSessionState } from "../state";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

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

function mockCtx() {
	const setStatus = vi.fn();
	const ctx = {
		ui: {
			setStatus,
			theme: { fg: (_c: string, t: string) => t },
		},
	} as unknown as ExtensionContext;
	return { ctx, setStatus };
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

// ---------------------------------------------------------------------------
// Ticker lifecycle
// ---------------------------------------------------------------------------

describe("footer ticker lifecycle (issue #354)", () => {
	let setIntervalSpy: ReturnType<typeof vi.spyOn>;
	let clearIntervalSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		setIntervalSpy = vi.spyOn(globalThis, "setInterval");
		clearIntervalSpy = vi.spyOn(globalThis, "clearInterval");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	it("starts exactly one interval at the spinner frame rate on first activity", () => {
		const state = createSessionState();
		const { ctx } = mockCtx();

		state.activeSubagents = 1;
		updateProgressStatus(state, ctx);
		updateProgressStatus(state, ctx);

		expect(setIntervalSpy).toHaveBeenCalledTimes(1);
		expect(setIntervalSpy).toHaveBeenCalledWith(expect.any(Function), LIVE_SPINNER_FRAME_MS);
		expect(state.statusTicker).toBeDefined();
		stopProgressTicker(state); // hygiene for the timer object itself
	});

	it("repaints with a new frame every tick and leaves the counters alone", () => {
		const state = createSessionState();
		const { ctx, setStatus } = mockCtx();
		state.activeSubagents = 2;
		state.completedSubagents = 1;
		state.unseenSubagents = 1;

		updateProgressStatus(state, ctx);
		const firstLine = setStatus.mock.calls.at(-1)?.[1];

		vi.advanceTimersByTime(LIVE_SPINNER_FRAME_MS);
		const secondLine = setStatus.mock.calls.at(-1)?.[1];

		expect(secondLine).not.toBe(firstLine);
		expect(String(secondLine)).toContain(LIVE_SPINNER_FRAMES[1]);
		expect(state.activeSubagents).toBe(2);
		expect(state.completedSubagents).toBe(1);
		expect(state.failedSubagents).toBe(0);
		expect(state.unseenSubagents).toBe(1);
		stopProgressTicker(state);
	});

	it("counts elapsed from the first active run and keeps it across the ticker", () => {
		const state = createSessionState();
		const { ctx, setStatus } = mockCtx();
		state.activeSubagents = 1;

		updateProgressStatus(state, ctx);
		vi.advanceTimersByTime(65_000);

		expect(String(setStatus.mock.calls.at(-1)?.[1])).toContain(" \u00b7 1m 5s");
		stopProgressTicker(state);
	});

	it("stops when the last run settles, leaving a static linger line", () => {
		const state = createSessionState();
		const { ctx, setStatus } = mockCtx();
		state.activeSubagents = 1;
		updateProgressStatus(state, ctx);

		state.activeSubagents = 0;
		state.completedSubagents = 1;
		state.unseenSubagents = 1;
		updateProgressStatus(state, ctx);

		expect(clearIntervalSpy).toHaveBeenCalled();
		expect(state.statusTicker).toBeUndefined();

		const lingerLine = setStatus.mock.calls.at(-1)?.[1];
		expect(lingerLine).toBe("\u2713 brl: 1 done (1 unseen)");
		expect(state.activeSinceMs).toBeUndefined();

		// The linger window is static: no tick rewrites the line, and the 3 s
		// reset still hands back the idle config line.
		const callsBefore = setStatus.mock.calls.length;
		vi.advanceTimersByTime(2_000);
		expect(setStatus.mock.calls.length).toBe(callsBefore);

		vi.advanceTimersByTime(1_001);
		expect(String(setStatus.mock.calls.at(-1)?.[1])).toContain("use /brl-subagent to configure");
		expect(setStatus.mock.calls.length).toBe(callsBefore + 1);
	});

	it("never leaves a timer behind on session shutdown", () => {
		const state = createSessionState();
		const { ctx, setStatus } = mockCtx();
		state.activeSubagents = 1;
		updateProgressStatus(state, ctx);

		// Mirrors the session_shutdown handler in src/index.ts.
		state.activeSubagents = 0;
		state.completedSubagents = 0;
		state.failedSubagents = 0;
		state.unseenSubagents = 0;
		stopProgressTicker(state);

		expect(state.statusTicker).toBeUndefined();
		const callsAfterShutdown = setStatus.mock.calls.length;
		vi.advanceTimersByTime(10_000);
		expect(setStatus.mock.calls.length).toBe(callsAfterShutdown);
	});

	it("does not start a ticker while nothing is active", () => {
		const state = createSessionState();
		const { ctx } = mockCtx();
		state.completedSubagents = 1;

		updateProgressStatus(state, ctx);

		expect(setIntervalSpy).not.toHaveBeenCalled();
		expect(state.statusTicker).toBeUndefined();
	});

	it("starts a fresh interval and a fresh elapsed anchor for the next burst", () => {
		const state = createSessionState();
		const { ctx } = mockCtx();
		state.activeSubagents = 1;
		updateProgressStatus(state, ctx);
		state.activeSubagents = 0;
		updateProgressStatus(state, ctx);

		vi.advanceTimersByTime(30_000);
		state.activeSubagents = 1;
		state.completedSubagents = 0;
		state.unseenSubagents = 0;
		updateProgressStatus(state, ctx);

		expect(setIntervalSpy).toHaveBeenCalledTimes(2);
		expect(state.activeSinceMs).toBe(Date.now());

		stopProgressTicker(state);
	});
});

// ---------------------------------------------------------------------------
// F2 — the linger/reset timer is one handle, not one per render
// ---------------------------------------------------------------------------

describe("footer linger reset timer (F2)", () => {
	const DELAY_MS = 3000;

	let setTimeoutSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(0);
		setTimeoutSpy = vi.spyOn(globalThis, "setTimeout");
	});

	afterEach(() => {
		vi.useRealTimers();
		vi.restoreAllMocks();
	});

	/** A session with one run that has just settled. */
	function settledState(completed = 1, failed = 0) {
		const state = createSessionState();
		state.completedSubagents = completed;
		state.failedSubagents = failed;
		state.unseenSubagents = completed;
		return state;
	}

	it("arms exactly one timer no matter how many renders occur while idle", () => {
		const state = settledState();
		const { ctx } = mockCtx();

		updateProgressStatus(state, ctx);
		updateProgressStatus(state, ctx);
		updateProgressStatus(state, ctx);

		expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
		expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), DELAY_MS);
		expect(state.statusResetTimer).toBeDefined();
		expect(vi.getTimerCount()).toBe(1);
	});

	it("still arms only once when the linger line changes between renders", () => {
		const state = settledState(1, 0);
		const { ctx } = mockCtx();
		updateProgressStatus(state, ctx);

		// A sibling settles inside the linger window: same burst, same timer.
		state.completedSubagents = 2;
		state.unseenSubagents = 2;
		updateProgressStatus(state, ctx);

		expect(setTimeoutSpy).toHaveBeenCalledTimes(1);
		vi.advanceTimersByTime(DELAY_MS);
		expect(vi.getTimerCount()).toBe(0);
		expect(state.completedSubagents).toBe(0);
		expect(state.failedSubagents).toBe(0);
	});

	it("fires once: resets the counters, repaints idle, and leaves nothing armed", () => {
		const state = settledState(2, 1);
		const { ctx, setStatus } = mockCtx();
		updateProgressStatus(state, ctx);

		const lingerCalls = setStatus.mock.calls.length;
		vi.advanceTimersByTime(DELAY_MS - 1);
		expect(state.completedSubagents).toBe(2); // not yet
		expect(setStatus.mock.calls.length).toBe(lingerCalls);

		vi.advanceTimersByTime(1);
		expect(state.completedSubagents).toBe(0);
		expect(state.failedSubagents).toBe(0);
		expect(state.unseenSubagents).toBe(0);
		expect(state.statusResetTimer).toBeUndefined();
		expect(String(setStatus.mock.calls.at(-1)?.[1])).toContain("use /brl-subagent to configure");
		expect(vi.getTimerCount()).toBe(0); // no leak

		// Firing twice is impossible: nothing is left to fire.
		const callsAfterReset = setStatus.mock.calls.length;
		vi.advanceTimersByTime(DELAY_MS * 4);
		expect(setStatus.mock.calls.length).toBe(callsAfterReset);
	});

	it("a new dispatch cancels the armed reset", () => {
		const state = settledState(1, 0);
		const { ctx, setStatus } = mockCtx();
		updateProgressStatus(state, ctx);
		expect(state.statusResetTimer).toBeDefined();

		// Next run becomes active — the linger window is over.
		state.activeSubagents = 1;
		updateProgressStatus(state, ctx);

		expect(state.statusResetTimer).toBeUndefined();
		const callsAfterDispatch = setStatus.mock.calls.length;
		vi.advanceTimersByTime(DELAY_MS * 3);

		// The old timer must not have reset the counters behind the live run.
		expect(state.completedSubagents).toBe(1);
		expect(state.activeSubagents).toBe(1);
		expect(setStatus.mock.calls.length).toBeGreaterThan(callsAfterDispatch); // the ticker, not the reset
		stopProgressTicker(state);
	});

	it("re-arms for the next burst after a cancelled window", () => {
		const state = settledState(1, 0);
		const { ctx } = mockCtx();
		updateProgressStatus(state, ctx);

		state.activeSubagents = 1;
		updateProgressStatus(state, ctx); // cancels
		expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

		state.activeSubagents = 0;
		state.completedSubagents = 2;
		updateProgressStatus(state, ctx); // fresh burst settles → re-arm

		expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
		expect(state.statusResetTimer).toBeDefined();
		vi.advanceTimersByTime(DELAY_MS);
		expect(state.completedSubagents).toBe(0);
	});

	it("session shutdown clears the armed reset and leaves no timer behind", () => {
		const state = settledState(1, 1);
		const { ctx, setStatus } = mockCtx();
		updateProgressStatus(state, ctx);
		expect(state.statusResetTimer).toBeDefined();

		// Mirrors the session_shutdown handler in src/index.ts.
		state.activeSubagents = 0;
		state.completedSubagents = 0;
		state.failedSubagents = 0;
		state.unseenSubagents = 0;
		stopProgressTicker(state);
		clearProgressLinger(state);

		expect(state.statusResetTimer).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);

		const callsAfterShutdown = setStatus.mock.calls.length;
		vi.advanceTimersByTime(DELAY_MS * 4);
		expect(setStatus.mock.calls.length).toBe(callsAfterShutdown);
	});

	it("clears rather than arms when nothing has settled", () => {
		const state = createSessionState();
		const { ctx } = mockCtx();

		updateProgressStatus(state, ctx);

		expect(setTimeoutSpy).not.toHaveBeenCalled();
		expect(state.statusResetTimer).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);
	});

	it("syncProgressLinger is idempotent in all three directions", () => {
		const state = settledState(1, 0);
		const { ctx } = mockCtx();

		syncProgressLinger(state, ctx);
		syncProgressLinger(state, ctx);
		expect(setTimeoutSpy).toHaveBeenCalledTimes(1);

		state.activeSubagents = 1;
		syncProgressLinger(state, ctx);
		syncProgressLinger(state, ctx);
		expect(state.statusResetTimer).toBeUndefined();
		expect(vi.getTimerCount()).toBe(0);

		state.activeSubagents = 0;
		syncProgressLinger(state, ctx);
		expect(setTimeoutSpy).toHaveBeenCalledTimes(2);
		vi.advanceTimersByTime(DELAY_MS);
		expect(vi.getTimerCount()).toBe(0);
	});
});

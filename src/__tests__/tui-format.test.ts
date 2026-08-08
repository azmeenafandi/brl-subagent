import { describe, expect, it } from "vitest";
import {
	formatElapsed,
	formatLiveRowDim,
	liveRowName,
	liveSpinner,
	LIVE_SPINNER_FRAMES,
} from "../tui-format";

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

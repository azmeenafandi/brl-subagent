// Purpose: the ONE frozen-clock deadline-arm census shared by the deadline suites (#453 review).
//
// A run has several timers (poller, footer, deadline), so "count the timers" proves nothing.
// This records the delays passed to `setTimeout` and restores the real scheduler; suites then
// assert on the DELAYS (the deadline budget appears exactly once per arm site).

import { vi } from "vitest";

/** Record every `setTimeout` delay while active. `restore()` MUST run (afterEach/finally). */
export function recordTimeoutDelays(): { delays: number[]; restore: () => void } {
	const delays: number[] = [];
	const realSetTimeout = globalThis.setTimeout;
	const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(((fn: () => void, ms?: number) => {
		delays.push(ms ?? 0);
		return realSetTimeout(fn, ms as never);
	}) as unknown as typeof setTimeout);
	return { delays, restore: () => spy.mockRestore() };
}

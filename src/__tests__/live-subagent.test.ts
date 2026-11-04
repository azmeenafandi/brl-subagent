/**
 * Live-subagent lifecycle at the SessionState level — register → update →
 * finalize (issue #130).
 *
 * Graph and chain runs now register each node/step with the live monitor
 * through the exact lifecycle parallel mode uses (issue #119): a fresh uuid
 * per unit, registerLiveSubagent at spawn, updateLiveSubagent on every
 * progress partial, finalizeLiveSubagent on completion OR crash. This suite
 * pins the SessionState contract those callers depend on:
 *
 *  - registration seeds the map with empty output/usage;
 *  - updateLiveSubagent records progress (transcript stored by reference);
 *  - finalizeLiveSubagent keeps the entry visible for the
 *    FINALIZE_RESET_WINDOW_MS reset window before the deferred delete — no
 *    ghost can outlive a run, but the drill-in stays readable through the
 *    window.
 *
 * The end-to-end wiring (fresh-uuid registration + crash-protected finalize in
 * the graph/chain execute paths) is covered in per-step-model.test.ts; this
 * file pins the state API those paths call, in the fixture style of
 * state-sweep.test.ts.
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { createSessionState, FINALIZE_RESET_WINDOW_MS } from "../state";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { LiveSubagent, TranscriptMessage } from "../types";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLiveEntry(id: string, ctx: ExtensionContext): LiveSubagent {
	return {
		id,
		label: `agent-${id}`,
		task: `task ${id}`,
		model: "provider/model",
		thinkingLevel: "medium",
		priority: "high",
		startedAt: Date.now(),
		liveOutput: "",
		usage: { input: 0, output: 0 },
		ctx,
	};
}

// ---------------------------------------------------------------------------
// Lifecycle behavior
// ---------------------------------------------------------------------------

describe("live subagent lifecycle — register → update → finalize (issue #130)", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("registerLiveSubagent seeds the map with empty output/usage", () => {
		const state = createSessionState();
		state.registerLiveSubagent("graph-node-1", makeLiveEntry("graph-node-1", {} as ExtensionContext));

		const entry = state.subagentSessions.get("graph-node-1");
		expect(entry).toBeDefined();
		expect(entry?.label).toBe("agent-graph-node-1");
		expect(entry?.liveOutput).toBe("");
		expect(entry?.usage).toEqual({ input: 0, output: 0 });
	});

	it("updateLiveSubagent records output + usage (transcript stored by reference)", () => {
		const state = createSessionState();
		state.registerLiveSubagent("chain-step-1", makeLiveEntry("chain-step-1", {} as ExtensionContext));

		const transcript: TranscriptMessage[] = [
			{ role: "assistant", content: [{ type: "text", text: "hi" }] },
		];
		state.updateLiveSubagent("chain-step-1", "partial output", 12, 7, transcript);

		const entry = state.subagentSessions.get("chain-step-1");
		expect(entry?.liveOutput).toBe("partial output");
		expect(entry?.usage).toEqual({ input: 12, output: 7 });
		expect(entry?.transcript).toBe(transcript);
	});

	it("updateLiveSubagent is a no-op for an unknown id (no throw, no map write)", () => {
		const state = createSessionState();
		expect(() => state.updateLiveSubagent("ghost", "out", 1, 2)).not.toThrow();
		expect(state.subagentSessions.has("ghost")).toBe(false);
	});

	it("finalizeLiveSubagent keeps the entry for the reset window, then deletes it (FINALIZE_RESET_WINDOW_MS)", () => {
		vi.useFakeTimers();
		const state = createSessionState();
		state.registerLiveSubagent("graph-node-9", makeLiveEntry("graph-node-9", {} as ExtensionContext));

		expect(state.finalizeLiveSubagent("graph-node-9")).toBe(true);
		// Deferred delete: the drill-in stays readable for the reset window.
		expect(state.subagentSessions.has("graph-node-9")).toBe(true);

		vi.advanceTimersByTime(FINALIZE_RESET_WINDOW_MS + 1);
		expect(state.subagentSessions.has("graph-node-9")).toBe(false);
	});

	it("the register → update → finalize cycle leaves no ghost entry behind", () => {
		vi.useFakeTimers();
		const state = createSessionState();
		state.registerLiveSubagent("chain-step-2", makeLiveEntry("chain-step-2", {} as ExtensionContext));
		state.updateLiveSubagent("chain-step-2", "done", 5, 3);
		state.finalizeLiveSubagent("chain-step-2");

		vi.advanceTimersByTime(FINALIZE_RESET_WINDOW_MS + 1);
		expect(state.subagentSessions.size).toBe(0);
	});

	// Issue #423: a retry inside the linger window re-registers the SAME id. Every
	// display surface filters finalized ids, so a re-registration must clear the
	// claim — and cancel the pending delete, or the fresh row is evicted 3 s later.
	it("re-registering a finalized id clears the claim and survives the reset window", () => {
		vi.useFakeTimers();
		const state = createSessionState();
		state.registerLiveSubagent("retry-1", makeLiveEntry("retry-1", {} as ExtensionContext));
		state.finalizeLiveSubagent("retry-1");
		expect(state.isLiveEntryFinalized("retry-1")).toBe(true);

		state.registerLiveSubagent("retry-1", {
			...makeLiveEntry("retry-1", {} as ExtensionContext),
			label: "attempt-2",
			startedAt: Date.now(),
			deadlineAt: Date.now() + 60_000,
		});

		expect(state.isLiveEntryFinalized("retry-1")).toBe(false);

		// The pre-registration delete timer must be gone: the row is live again.
		vi.advanceTimersByTime(FINALIZE_RESET_WINDOW_MS + 1);
		const entry = state.subagentSessions.get("retry-1");
		expect(entry).toBeDefined();
		expect(entry?.label).toBe("attempt-2");
		expect(entry?.deadlineAt).toBeDefined();

		// And it can still be finalized normally afterwards.
		expect(state.finalizeLiveSubagent("retry-1")).toBe(true);
	});
});

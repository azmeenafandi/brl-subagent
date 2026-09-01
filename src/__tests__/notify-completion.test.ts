/**
 * Direct unit tests for the completion-push builder helpers in
 * src/notify-completion.ts (issue #147): buildCompletionMessage, resolveDelivery,
 * markTerminalSeen and the completionNotify config default.
 *
 * These exercise the helpers in isolation — no pi SDK mock, no runner mock.
 * The thin sendCompletionNotification sender is intentionally NOT unit-tested
 * (it is a one-line pi.sendMessage delegate; covered by the live probe per the
 * issue's D6 test plan).
 */
import { describe, it, expect, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createSessionState } from "../state";
import type { Logger } from "../logging";
import type {
	BackgroundAgent,
	SubagentRun,
	CompletionNotifyMode,
} from "../types";
import { DEFAULT_COMPLETION_NOTIFY, CUSTOM_ENTRY_TYPES } from "../types";
import {
	buildCompletionMessage,
	resolveDelivery,
	markTerminalSeen,
	normalizeCompletionStatus,
	resolveRunEntry,
} from "../notify-completion";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeLog(): Logger {
	return {
		debug: vi.fn(),
		info: vi.fn(),
		warn: vi.fn(),
		error: vi.fn(),
	};
}

function makeAgent(overrides: Partial<BackgroundAgent> = {}): BackgroundAgent {
	return {
		id: "run-123",
		sessionId: "sess-1",
		type: "general-purpose",
		description: "review-the-docs",
		status: "completed",
		startedAt: 1_000,
		task: "review the docs",
		model: "provider/model",
		thinkingLevel: "medium",
		finalOutput: [
			"line01", "line02", "line03", "line04", "line05", "line06", "line07",
			"line08", "line09", "line10", "line11", "line12", "line13", "line14",
			"line15", "line16", "line17",
		].join("\n"),
		...overrides,
	};
}

function makeRun(overrides: Partial<SubagentRun> = {}): SubagentRun {
	return {
		id: "run-123",
		task: "review the docs",
		description: "review-the-docs",
		label: "review-the-docs",
		status: "done",
		model: "provider/model",
		thinkingLevel: "medium",
		startedAt: "2026-01-01T00:00:00.000Z",
		durationMs: 42_000,
		cost: 0.02,
		tokensIn: 1_000,
		tokensOut: 500,
		...overrides,
	};
}

/**
 * The SPAWN-shaped production entry: created by createUnitRun / the background
 * spawn path (index.ts) BEFORE finalization. status "running", no
 * cost/tokens/duration, no originalParams.errorCategory yet.
 */
function makeSpawnRun(overrides: Partial<SubagentRun> = {}): SubagentRun {
	return {
		id: "run-123",
		task: "review the docs",
		description: "review-the-docs",
		status: "running",
		model: "provider/model",
		thinkingLevel: "medium",
		startedAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

/**
 * The FINALIZED-shaped production entry: stamped by finalizeRunRecord — status
 * done/failed, durationMs/cost/tokens filled, errorCategory on originalParams.
 * Shares id + startedAt with the spawn entry (the two-entry per-run shape).
 */
function makeFinalRun(status: "done" | "failed", overrides: Partial<SubagentRun> = {}): SubagentRun {
	return {
		id: "run-123",
		task: "review the docs",
		description: "review-the-docs",
		status,
		model: "provider/model",
		thinkingLevel: "medium",
		startedAt: "2026-01-01T00:00:00.000Z",
		durationMs: 42_000,
		cost: 0.02,
		tokensIn: 1_000,
		tokensOut: 500,
		errorMessage: "boom",
		...overrides,
	};
}

// ---------------------------------------------------------------------------
// buildCompletionMessage
// ---------------------------------------------------------------------------

describe("buildCompletionMessage", () => {
	it("builds the summary line from description, id, status, duration, cost, category", () => {
		const agent = makeAgent({ status: "completed" });
		const run = makeRun({ durationMs: 42_000, cost: 0.02 });
		const msg = buildCompletionMessage(agent, run);

		expect(msg.customType).toBe("subagent-completion");
		expect(msg.display).toBe(true);
		expect(msg.content).toContain(
			'Background agent "review-the-docs" (run-123) — completed in 42.0s · $0.02 · category: success',
		);
	});

	it("appends the soft directive paragraph", () => {
		const msg = buildCompletionMessage(makeAgent({ status: "failed" }), makeRun());
		expect(msg.content).toContain("Process this completion silently unless action is needed.");
		expect(msg.content).toContain("Rule 18 governs terminations");
	});

	it("truncates the output tail via truncateTail with the marker", () => {
		// 17 lines: last 15 kept, first 2 dropped, marker prepended.
		const msg = buildCompletionMessage(makeAgent(), makeRun());
		expect(msg.content).toContain("… (truncated)");
		expect(msg.content).toContain("line17");
		expect(msg.content).not.toContain("line01");
	});

	it("maps cost/tokens/duration/errorCategory from the run entry into details", () => {
		const agent = makeAgent({ status: "failed" });
		const run = makeRun({
			status: "failed",
			durationMs: 42_000,
			cost: 0.02,
			tokensIn: 1_000,
			tokensOut: 500,
			errorMessage: "boom",
			originalParams: { errorCategory: "timeout" },
		});
		const msg = buildCompletionMessage(agent, run);

		expect(msg.details).toEqual({
			id: "run-123",
			status: "failed",
			errorCategory: "timeout",
			errorMessage: "boom",
			costUsd: 0.02,
			tokensIn: 1_000,
			tokensOut: 500,
			durationMs: 42_000,
			label: "review-the-docs",
		});
	});

	it("classifies a completed run with category 'success' and no errorMessage", () => {
		const msg = buildCompletionMessage(
			makeAgent({ status: "completed" }),
			makeRun({ errorMessage: "stale" }),
		);
		expect(msg.details.errorCategory).toBe("success");
		expect(msg.details.errorMessage).toBeUndefined();
	});

	it("degrades gracefully when the run entry is absent (cost fields omitted, never throws)", () => {
		const agent = makeAgent({ status: "completed", finalOutput: "done" });
		const msg = buildCompletionMessage(agent, undefined);

		expect(msg.details.costUsd).toBeUndefined();
		expect(msg.details.tokensIn).toBeUndefined();
		expect(msg.details.tokensOut).toBeUndefined();
		expect(msg.details.durationMs).toBeUndefined();
		expect(msg.details.errorCategory).toBe("success");
		// Summary tail omits the cost/duration segments.
		expect(msg.content).toContain('Background agent "review-the-docs" (run-123) — completed');
		expect(msg.content).not.toContain("$0.02");
		expect(msg.content).not.toContain(" in 42");
	});

	// Honest stopped-run shape (review #1, #2): the run entry passed in is the
	// PRE-finalize spawn entry — status "running", no cost/tokens/duration, no
	// errorCategory. The agent status is still terminal (failed) because the
	// subscriber only fires on terminal events; the builder must omit every
	// unstamped field and never throw.
	it("degrades gracefully on the real spawn shape (status running, no cost/tokens/duration/category)", () => {
		const agent = makeAgent({ status: "failed" });
		const run = makeSpawnRun(); // status "running" — the honest stopped-run shape
		const msg = buildCompletionMessage(agent, run);

		expect(msg.customType).toBe("subagent-completion");
		expect(msg.details.status).toBe("failed");
		expect(msg.details.errorCategory).toBe("unknown");
		expect(msg.details.costUsd).toBeUndefined();
		expect(msg.details.tokensIn).toBeUndefined();
		expect(msg.details.tokensOut).toBeUndefined();
		expect(msg.details.durationMs).toBeUndefined();
		// Summary omits the cost/duration segments.
		expect(msg.content).toContain('Background agent "review-the-docs" (run-123) — failed');
		expect(msg.content).not.toContain("$0.02");
		expect(msg.content).not.toContain(" in 42");
	});

	it("reads cost/tokens/duration/errorCategory from the finalized-shape run entry", () => {
		const agent = makeAgent({ status: "failed" });
		const run = makeFinalRun("failed", { originalParams: { errorCategory: "timeout" } });
		const msg = buildCompletionMessage(agent, run);

		expect(msg.details.status).toBe("failed");
		expect(msg.details.errorCategory).toBe("timeout");
		expect(msg.details.costUsd).toBe(0.02);
		expect(msg.details.tokensIn).toBe(1_000);
		expect(msg.details.tokensOut).toBe(500);
		expect(msg.details.durationMs).toBe(42_000);
		expect(msg.content).toContain("$0.02");
	});
});

// ---------------------------------------------------------------------------
// resolveRunEntry — terminal-entry preference against the REAL entry order
// ---------------------------------------------------------------------------

describe("resolveRunEntry", () => {
	it("prefers the terminal entry when spawn+final share id+startedAt with spawn FIRST", () => {
		const spawn = makeSpawnRun();
		const final = makeFinalRun("failed", { originalParams: { errorCategory: "timeout" } });
		// The raw getEntries order (verified empirically): spawn appended first.
		const entries = [spawn, final];

		const resolved = resolveRunEntry(entries, "run-123");

		expect(resolved).toBe(final);
		expect(resolved?.status).toBe("failed");
		expect(resolved?.durationMs).toBe(42_000);
		expect(resolved?.originalParams?.errorCategory).toBe("timeout");
	});

	it("falls back to the lone spawn entry (pre-finalize stopped-run shape)", () => {
		const spawn = makeSpawnRun();
		const resolved = resolveRunEntry([spawn], "run-123");

		expect(resolved).toBe(spawn);
		expect(resolved?.status).toBe("running");
		expect(resolved?.cost).toBeUndefined();
	});

	it("returns undefined when no entry matches the id", () => {
		expect(resolveRunEntry([makeSpawnRun()], "missing")).toBeUndefined();
		expect(resolveRunEntry([], "missing")).toBeUndefined();
	});

	it("resolves only the right id among interleaved runs", () => {
		const aSpawn = makeSpawnRun({ id: "run-a" });
		const bSpawn = makeSpawnRun({ id: "run-b" });
		const bFinal = makeFinalRun("done", { id: "run-b" });
		const aFinal = makeFinalRun("failed", { id: "run-a", originalParams: { errorCategory: "timeout" } });
		const entries = [aSpawn, bSpawn, bFinal, aFinal];

		expect(resolveRunEntry(entries, "run-a")).toBe(aFinal);
		expect(resolveRunEntry(entries, "run-b")).toBe(bFinal);
	});
});

// ---------------------------------------------------------------------------
// normalizeCompletionStatus
// ---------------------------------------------------------------------------

describe("normalizeCompletionStatus", () => {
	it("maps terminal agent statuses through unchanged", () => {
		expect(normalizeCompletionStatus("completed")).toBe("completed");
		expect(normalizeCompletionStatus("failed")).toBe("failed");
		expect(normalizeCompletionStatus("stopped")).toBe("stopped");
	});

	it("maps a non-terminal status to 'completed' rather than throwing", () => {
		expect(normalizeCompletionStatus("running")).toBe("completed");
		expect(normalizeCompletionStatus("pending")).toBe("completed");
		expect(normalizeCompletionStatus("steered")).toBe("completed");
	});
});

// ---------------------------------------------------------------------------
// resolveDelivery — the D1 + D2 matrix
// ---------------------------------------------------------------------------

describe("resolveDelivery", () => {
	const matrix: Array<["completed" | "failed" | "stopped", CompletionNotifyMode, "steer" | "followUp" | "nextTurn", boolean]> = [
		// status       knob        deliverAs     triggerTurn
		["completed", "all", "followUp", true],
		["completed", "failed", "nextTurn", false],
		["completed", "off", "nextTurn", false],
		["failed", "all", "steer", true],
		["failed", "failed", "steer", true],
		["failed", "off", "nextTurn", false],
		["stopped", "all", "steer", true],
		["stopped", "failed", "steer", true],
		["stopped", "off", "nextTurn", false],
	];

	it.each(matrix)(
		"status %s with knob %s → deliverAs %s, triggerTurn %s",
		(status, knob, deliverAs, triggerTurn) => {
			const delivery = resolveDelivery(status, knob);
			expect(delivery.deliverAs).toBe(deliverAs);
			expect(delivery.triggerTurn).toBe(triggerTurn);
		},
	);
});

// ---------------------------------------------------------------------------
// markTerminalSeen — dedupe
// ---------------------------------------------------------------------------

describe("markTerminalSeen", () => {
	it("delivers on the first terminal event per id and dedupes repeats", () => {
		const seen = new Set<string>();
		expect(markTerminalSeen(seen, "run-1")).toBe(true);
		expect(markTerminalSeen(seen, "run-1")).toBe(false); // duplicate → skipped
		expect(markTerminalSeen(seen, "run-2")).toBe(true); // new id → delivered
	});

	it("caps the set by clearing when it exceeds the default cap", () => {
		const seen = new Set<string>();
		for (let i = 0; i < 200; i++) seen.add(`id-${i}`);
		// Adding one more crosses the 200 cap → cleared, still returns true.
		expect(markTerminalSeen(seen, "new-id")).toBe(true);
		expect(seen.size).toBeLessThanOrEqual(200);
	});
});

// ---------------------------------------------------------------------------
// Config default
// ---------------------------------------------------------------------------

describe("completionNotify config default", () => {
	it("defaults the knob to 'all'", () => {
		expect(DEFAULT_COMPLETION_NOTIFY).toBe("all");
		const state = createSessionState(makeLog());
		expect(state.config.completionNotify).toBe("all");
	});

	it("restores a persisted knob and falls back to 'all' on an invalid value", () => {
		const restoreCtx = (data: unknown): ExtensionContext =>
			({
				sessionManager: {
					getEntries: () => [
						{ type: "custom", customType: CUSTOM_ENTRY_TYPES.state, data },
					],
				},
			} as unknown as ExtensionContext);

		const s1 = createSessionState(makeLog());
		expect(s1.restoreFromSession(restoreCtx({ completionNotify: "failed" }))).toBe(true);
		expect(s1.config.completionNotify).toBe("failed");

		const s2 = createSessionState(makeLog());
		// An invalid value makes the whole state shape invalid → restore rejected.
		expect(s2.restoreFromSession(restoreCtx({ completionNotify: "bogus" }))).toBe(false);
		expect(s2.config.completionNotify).toBe("all");
	});
});

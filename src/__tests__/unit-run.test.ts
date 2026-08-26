/**
 * Direct unit tests for the per-unit run-entry helpers extracted into
 * src/unit-run.ts (issue #132): makeLiveOnUpdate, createUnitRun, finalizeUnitRun.
 *
 * These exercise the helpers in isolation (no runner mock, no real extension
 * execute handler) — they construct a real SessionState like state-sweep.test.ts
 * and assert behavior on the helper boundaries:
 *   - makeLiveOnUpdate: forwards partials and streams into the live monitor.
 *   - createUnitRun: field mapping, priority floor fallback, fresh uuids.
 *   - finalizeUnitRun: status/cost/tokens/outputSummary, persistRun effect,
 *     history prune when maxHistoryEntries > 0, finalizeLiveSubagent claim.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { createSessionState } from "../state";
import type { Logger } from "../logging";
import type { SubagentResult, SubagentRun, Priority, TranscriptMessage } from "../types";
import { CUSTOM_ENTRY_TYPES, EMPTY_USAGE, getFinalOutput } from "../types";
import { makeLiveOnUpdate, createUnitRun, finalizeUnitRun, type UnitRunSource } from "../unit-run";

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

/** Fake pi whose appendEntry records writes (persistRun effect). */
function makeFakePi(recorded: Array<{ type: string; data: unknown }> = []) {
	const appendEntry = vi.fn((type: string, data: unknown) => {
		recorded.push({ type, data });
	});
	return { appendEntry } as unknown as ExtensionAPI;
}

/**
 * Fake ctx whose sessionManager serves the planted + recorded run entries
 * (the same faked session-manager shape as cost.test.ts / state-sweep.test.ts).
 */
function createMockContext(
	planted: SubagentRun[] = [],
	recorded: Array<{ type: string; data: unknown }> = [],
): ExtensionContext {
	return {
		sessionManager: {
			getEntries: () => [
				...planted.map((r) => ({ type: "custom", customType: CUSTOM_ENTRY_TYPES.run, data: r })),
				...recorded.map(({ type, data }) => ({ type: "custom", customType: type, data })),
			],
			appendCustomEntry: vi.fn(),
		},
	} as unknown as ExtensionContext;
}

function registerLive(state: ReturnType<typeof createSessionState>, id: string): void {
	state.registerLiveSubagent(id, {
		id,
		label: `l-${id}`,
		task: `t-${id}`,
		model: "provider/model",
		thinkingLevel: "medium",
		startedAt: Date.now(),
		ctx: {} as ExtensionContext,
	});
}

function makeRun(id: string, status: SubagentRun["status"]): SubagentRun {
	return {
		id,
		task: `task-${id}`,
		status,
		model: "provider/model",
		thinkingLevel: "medium",
		startedAt: new Date().toISOString(),
		originalParams: {},
	};
}

function makeSuccessResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
	return {
		messages: [{ role: "assistant", content: [{ type: "text", text: "unit done" }] }],
		usage: { ...EMPTY_USAGE, cost: 0.05, input: 10, output: 20 },
		exitCode: 0,
		stderr: "",
		...overrides,
	};
}

function makeErrorResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
	return {
		messages: [{ role: "assistant", content: [{ type: "text", text: "unit failed" }] }],
		usage: { ...EMPTY_USAGE, cost: 0.02, input: 3, output: 4 },
		exitCode: 1,
		stderr: "boom",
		errorMessage: "unit boom",
		errorCategory: "tool_error",
		...overrides,
	};
}

const STEP_MODEL = { provider: "anthropic", id: "claude-opus-4-6" };
const TRANSCRIPT: TranscriptMessage[] = [{ role: "assistant", content: "hello" }];

// ---------------------------------------------------------------------------
// makeLiveOnUpdate
// ---------------------------------------------------------------------------

describe("makeLiveOnUpdate", () => {
	let state: ReturnType<typeof createSessionState>;

	beforeEach(() => {
		state = createSessionState();
	});

	it("forwards the partial and streams details into the live monitor", () => {
		const runId = "live-1";
		registerLive(state, runId);
		const onUpdate = vi.fn();
		const cb = makeLiveOnUpdate(state, runId, onUpdate);
		expect(cb).toBeDefined();

		const messages = [{ role: "assistant", content: [{ type: "text", text: "hello world" }] }];
		const partial: AgentToolResult<SubagentResult> = {
			content: [],
			details: {
				messages,
				usage: { ...EMPTY_USAGE, input: 5, output: 7 },
				exitCode: 0,
				stderr: "",
				liveTranscript: TRANSCRIPT,
			},
		};

		cb!(partial);

		expect(onUpdate).toHaveBeenCalledTimes(1);
		expect(onUpdate).toHaveBeenCalledWith(partial);
		const live = state.subagentSessions.get(runId)!;
		expect(live.liveOutput).toBe(getFinalOutput(messages));
		expect(live.usage).toEqual({ input: 5, output: 7 });
		expect(live.transcript).toBe(TRANSCRIPT);
	});

	it("only forwards the partial when details are absent", () => {
		const runId = "live-2";
		registerLive(state, runId);
		const onUpdate = vi.fn();
		const cb = makeLiveOnUpdate(state, runId, onUpdate);
		const partial = { content: [] };

		cb!(partial as AgentToolResult<SubagentResult>);

		expect(onUpdate).toHaveBeenCalledTimes(1);
		expect(onUpdate).toHaveBeenCalledWith(partial);
		const live = state.subagentSessions.get(runId)!;
		expect(live.liveOutput).toBe("");
		expect(live.usage).toEqual({ input: 0, output: 0 });
	});

	it("returns undefined when onUpdate is undefined", () => {
		expect(makeLiveOnUpdate(state, "live-3", undefined)).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// createUnitRun
// ---------------------------------------------------------------------------

describe("createUnitRun", () => {
	const source: UnitRunSource = {
		task: "do the thing",
		label: "unit-1",
		customSP: "custom-system-prompt",
		inheritSP: true,
		model: "model-x",
		thinkingLevel: "high",
		priority: "critical" as Priority,
		outputFile: "out.txt",
		timeout: 30,
		effectiveCwd: "/tmp/work",
		toolOptions: {
			tools: ["read", "write"],
			excludeTools: ["delete"],
			noBuiltinTools: false,
		},
	};

	it("maps every field onto the run entry and snapshot", () => {
		const { runId, run } = createUnitRun(source, STEP_MODEL, "normal" as Priority, "my-preset");

		expect(runId).toBe(run.id);
		expect(run.task).toBe("do the thing");
		expect(run.label).toBe("unit-1");
		expect(run.description).toBe("unit-1"); // #98 symmetry
		expect(run.status).toBe("running");
		expect(run.model).toBe("anthropic/claude-opus-4-6");
		expect(run.thinkingLevel).toBe("high");
		// source.priority wins over the floor
		expect(run.priority).toBe("critical");
		expect(run.startedAt).toBeTruthy();
		expect(run.originalParams).toEqual({
			systemPrompt: "custom-system-prompt",
			inheritSystemPrompt: true,
			model: "model-x",
			thinkingLevel: "high",
			priority: "critical",
			outputFile: "out.txt",
			timeout: 30,
			cwd: "/tmp/work",
			tools: ["read", "write"],
			excludeTools: ["delete"],
			noBuiltinTools: false,
			preset: "my-preset",
		});
	});

	it("falls back to the priority floor when the source declares none", () => {
		const sourceNoPriority: UnitRunSource = {
			task: "t",
			label: "u",
			inheritSP: false,
			thinkingLevel: "low",
			effectiveCwd: "/x",
		};

		const { run } = createUnitRun(sourceNoPriority, STEP_MODEL, "high" as Priority);

		expect(run.priority).toBe("high");
		expect(run.originalParams?.priority).toBe("high");
		expect(run.originalParams?.inheritSystemPrompt).toBe(false);
		expect(run.originalParams?.preset).toBeUndefined();
	});

	it("generates a fresh uuid per call and returns the matching runId", () => {
		const a = createUnitRun(source, STEP_MODEL, "normal" as Priority);
		const b = createUnitRun(source, STEP_MODEL, "normal" as Priority);

		expect(a.runId).toBe(a.run.id);
		expect(b.runId).toBe(b.run.id);
		expect(a.runId).not.toBe(b.runId);
	});
});

// ---------------------------------------------------------------------------
// finalizeUnitRun
// ---------------------------------------------------------------------------

describe("finalizeUnitRun", () => {
	const runId = "unit-finalize-1";

	afterEach(() => {
		vi.useRealTimers();
	});

	it("finalizes a successful result as done with cost/tokens/outputSummary", () => {
		const state = createSessionState();
		registerLive(state, runId);
		const recorded: Array<{ type: string; data: unknown }> = [];
		const pi = makeFakePi(recorded);
		const ctx = createMockContext([], recorded);
		const run = makeRun(runId, "running");
		const log = makeLog();

		finalizeUnitRun(state, pi, ctx, run, makeSuccessResult(), log);

		expect(run.status).toBe("done");
		expect(run.cost).toBe(0.05);
		expect(run.tokensIn).toBe(10);
		expect(run.tokensOut).toBe(20);
		expect(run.outputSummary).toBeDefined();
		// persisted via persistRun (appendEntry) and visible through getRunEntries
		expect(pi.appendEntry).toHaveBeenCalledWith(CUSTOM_ENTRY_TYPES.run, run);
		expect(state.getRunEntries(ctx).map((r) => r.id)).toContain(runId);
		// live entry claimed
		expect(state.isLiveEntryFinalized(runId)).toBe(true);
		expect(log.debug).toHaveBeenCalledWith("Unit run finalized", { runId, status: "done" });
	});

	it("finalizes an error result as failed and classifies the errorCategory", () => {
		const state = createSessionState();
		registerLive(state, runId);
		const recorded: Array<{ type: string; data: unknown }> = [];
		const pi = makeFakePi(recorded);
		const ctx = createMockContext([], recorded);
		const run = makeRun(runId, "running");
		const log = makeLog();

		finalizeUnitRun(state, pi, ctx, run, makeErrorResult(), log);

		expect(run.status).toBe("failed");
		expect(run.errorMessage).toBe("unit boom");
		expect(run.originalParams?.errorCategory).toBe("tool_error");
		expect(state.isLiveEntryFinalized(runId)).toBe(true);
		expect(log.debug).toHaveBeenCalledWith("Unit run finalized", { runId, status: "failed" });
	});

	it("prunes run history when maxHistoryEntries > 0", () => {
		const state = createSessionState();
		state.config.maxHistoryEntries = 2;
		const planted = ["a", "b", "c", "d", "e"].map((id) => makeRun(id, "done"));
		const ctx = createMockContext(planted);
		const pi = makeFakePi();
		const run = makeRun("f", "running");
		const log = makeLog();

		finalizeUnitRun(state, pi, ctx, run, makeSuccessResult(), log);

		expect(log.debug).toHaveBeenCalledWith(
			"Run history pruned",
			expect.objectContaining({ pruned: expect.any(Number) }),
		);
	});

	it("does not prune when maxHistoryEntries <= 0", () => {
		const state = createSessionState();
		state.config.maxHistoryEntries = 0;
		const ctx = createMockContext([]);
		const pi = makeFakePi();
		const run = makeRun(runId, "running");
		const log = makeLog();

		finalizeUnitRun(state, pi, ctx, run, makeSuccessResult(), log);

		expect(log.debug).not.toHaveBeenCalledWith(
			"Run history pruned",
			expect.anything(),
		);
	});
});

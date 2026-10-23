/**
 * Issue #361 — `background` is the CONDITIONAL default for delegate_task.
 *
 * When the caller omits `background`, dispatch resolves it once from the
 * EFFECTIVE approval mode (per-call param > config — the same value the child
 * runs with) and the call shape:
 *
 *   | shape                            | default      |
 *   | single / tasks fan-out, `auto`   | background   |
 *   | `chain` / `graph`                | foreground   |
 *   | effective `always` / `writes`    | foreground   |
 *   | explicit `true` / `false`        | as given     |
 *
 * Why conditional rather than unconditional: a background run has no approval
 * dialog, so defaulting the gated modes there would either reject the call
 * (`always`) or silently auto-approve a diff the user asked to review
 * (`writes`). The default must never weaken a gate.
 *
 * These tests drive the REAL delegate_task execute handler (with `../runner`
 * and `spawnBackgroundSession` stubbed, so no real pi subprocess spawns) and
 * pin the whole matrix, including the two rejections that must NOT have moved:
 * an explicit `background: true` with chain/graph keeps its verbatim message,
 * and `background: true` + `approvalMode: 'always'` is still refused.
 *
 * Harness cloned from retry-pins.test.ts: hoisted `../runner` mock; partial
 * `../session-manager` mock stubbing ONLY spawnBackgroundSession; tui module
 * mocks; temp dirs + output/storage redirects + log-cwd clearing from the
 * shared lifecycle helper; fake-timer wrapper around background dispatches
 * (a successful spawn arms a 2s poller + the 30-minute deadline timer).
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the extension
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
	runSubagent: vi.fn(),
	cleanupTempDirs: vi.fn().mockResolvedValue(0),
	getPiInvocation: vi.fn(),
	accumulateUsage: vi.fn(),
	parseSubagentLine: vi.fn(),
	spawnBackgroundSession: vi.fn(),
}));

vi.mock("../runner", () => ({
	runSubagent: h.runSubagent,
	cleanupTempDirs: h.cleanupTempDirs,
	getPiInvocation: h.getPiInvocation,
	accumulateUsage: h.accumulateUsage,
	parseSubagentLine: h.parseSubagentLine,
}));

// Partial session-manager mock: stub ONLY the spawn; state/session helpers stay
// real (the output/storage redirects + log-cwd clearing come from the shared
// lifecycle helper in src/__tests__/fixtures/temp-lifecycle.ts).
vi.mock("../session-manager", async (importOriginal) => ({
	...(await importOriginal<typeof import("../session-manager")>()),
	spawnBackgroundSession: h.spawnBackgroundSession,
}));

vi.mock("@earendil-works/pi-coding-agent", () => {
	class DynamicBorder {}
	const getMarkdownTheme = () => ({});
	return { DynamicBorder, getMarkdownTheme };
});

vi.mock("@earendil-works/pi-tui", () => {
	class Container {}
	class SelectList {}
	class Spacer {}
	class Text {}
	class Markdown {}
	return { Container, SelectList, Spacer, Text, Markdown };
});

import initExtension from "../index";
import {
	defaultBackgroundFor,
	resolveEffectiveApprovalMode,
	shouldRejectBackgroundForBatch,
} from "../params";
import { CUSTOM_ENTRY_TYPES } from "../types";
import type { ApprovalMode, SubagentResult } from "../types";
import type { SessionState } from "../state";
import { createTempEnv } from "./fixtures/temp-lifecycle";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_MODEL = { provider: "test", id: "test/model" };

interface SpawnParams {
	task?: string;
	description?: string;
	originalParams?: Record<string, unknown>;
}

let spawnSeq = 0;

function makeFakeAgent(p: SpawnParams): Record<string, unknown> {
	spawnSeq += 1;
	return {
		id: `bg-default-${spawnSeq}`,
		sessionId: `sess-bg-default-${spawnSeq}`,
		description: p.description ?? "",
		status: "running",
		startedAt: 1700000000000 + spawnSeq,
		task: p.task ?? "",
		model: `${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`,
		thinkingLevel: "medium",
	};
}

function makeResult(modelStr: string): SubagentResult {
	return {
		messages: [
			{ role: "assistant", content: [{ type: "text", text: "done" }], model: modelStr },
		],
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 0, turns: 1 },
		exitCode: 0,
		stderr: "",
		model: modelStr,
		stopReason: "end_turn",
		errorCategory: "unknown",
	};
}

interface ToolEntry {
	name: string;
	execute: (
		callId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details?: unknown;
		isError?: boolean;
	}>;
}

let tool: ToolEntry;
let sessionStartHandler:
	| ((_event: unknown, ctx: Record<string, unknown>) => Promise<void>)
	| undefined;
const env = createTempEnv("brl-bg-default");

function setupExtension(): ToolEntry {
	const registeredTools = new Map<string, ToolEntry>();
	const mockPi = {
		registerTool: (t: ToolEntry) => registeredTools.set(t.name, t),
		registerCommand: () => {},
		registerShortcut: () => {},
		on: (event: string, handler: (_event: unknown, ctx: Record<string, unknown>) => Promise<void>) => {
			if (event === "session_start") sessionStartHandler = handler;
		},
		appendEntry: () => {},
		sendMessage: () => {},
		ctx: {
			getState: () => undefined,
			setState: () => {},
		},
	};
	initExtension(mockPi as never);
	const toolEntry = registeredTools.get("delegate_task");
	if (!toolEntry) throw new Error("delegate_task tool not registered");
	return toolEntry;
}

function makeRegistry(available: string[]) {
	return {
		find: (provider: string, id: string) =>
			available.includes(`${provider}/${id}`) ? { provider, id } : undefined,
		hasConfiguredAuth: (model: { provider: string; id: string }) =>
			available.includes(`${model.provider}/${model.id}`),
	};
}

function makeCtx(): Record<string, unknown> {
	return {
		cwd: env.testCwd,
		model: GLOBAL_MODEL,
		modelRegistry: makeRegistry([`${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`]),
		getSystemPrompt: () => "You are a helpful assistant.",
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: {
			getEntries: () => [] as unknown[],
			appendCustomEntry: () => {},
		},
		hasUI: false,
	};
}

type Ctx = ReturnType<typeof makeCtx>;

/**
 * Seed the session-persisted config (the session_start restore path) so the
 * dispatch sees a configured `approvalMode` — the "config" tier of the
 * effective-mode resolution.
 */
async function seedConfig(ctx: Ctx, data: Record<string, unknown>): Promise<void> {
	(ctx.sessionManager as { getEntries: () => unknown[] }).getEntries = () => [
		{ type: "custom", customType: CUSTOM_ENTRY_TYPES.state, data },
	];
	if (sessionStartHandler) await sessionStartHandler({}, ctx as never);
}

/**
 * Run a dispatch under fake timers: a successful background spawn arms a 2s
 * poller + the 30-minute deadline per agent — clear both afterwards so vitest
 * exits with no open handles.
 */
async function dispatch(
	params: Record<string, unknown>,
	ctx: Ctx = makeCtx(),
): Promise<Awaited<ReturnType<ToolEntry["execute"]>>> {
	vi.useFakeTimers();
	try {
		return await tool.execute("call-361", params, undefined, undefined, ctx);
	} finally {
		vi.clearAllTimers();
		vi.useRealTimers();
	}
}

/** The originalParams the REAL spawn site recorded, as handed to the stub. */
function capturedOriginalParams(call = 0): Record<string, unknown> {
	const spawnArg = h.spawnBackgroundSession.mock.calls[call]?.[2] as SpawnParams | undefined;
	const recorded = spawnArg?.originalParams;
	if (!recorded) throw new Error("no spawn call captured an originalParams snapshot");
	return recorded;
}

beforeEach(() => {
	env.setUp();
	h.runSubagent.mockReset();
	h.runSubagent.mockImplementation(
		async (_cwd: string, _prompt: string, model: { provider: string; id: string }) =>
			makeResult(`${model.provider}/${model.id}`),
	);
	h.getPiInvocation.mockReset();
	h.getPiInvocation.mockReturnValue({ command: process.execPath, args: [] });
	h.spawnBackgroundSession.mockReset();
	spawnSeq = 0;
	h.spawnBackgroundSession.mockImplementation(
		async (_pi: unknown, _ctx: unknown, p: SpawnParams) => makeFakeAgent(p),
	);
	sessionStartHandler = undefined;
	tool = setupExtension();
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

afterAll(async () => {
	await env.tearDown();
});

// ---------------------------------------------------------------------------
// The matrix itself — the pure resolution helpers
// ---------------------------------------------------------------------------

describe("background default matrix (issue #361)", () => {
	it("defaults single and tasks fan-out to background only under an effective 'auto'", () => {
		expect(defaultBackgroundFor("single", "auto")).toBe(true);
		expect(defaultBackgroundFor("parallel", "auto")).toBe(true);
		// Gated modes keep the dialog in front of the user.
		expect(defaultBackgroundFor("single", "writes")).toBe(false);
		expect(defaultBackgroundFor("single", "always")).toBe(false);
		expect(defaultBackgroundFor("parallel", "writes")).toBe(false);
		expect(defaultBackgroundFor("parallel", "always")).toBe(false);
		// Batch modes block by definition.
		expect(defaultBackgroundFor("chain", "auto")).toBe(false);
		expect(defaultBackgroundFor("graph", "auto")).toBe(false);
	});

	it("resolves the EFFECTIVE approval mode: call param > config", () => {
		const state = { config: { approvalMode: "writes" } } as unknown as SessionState;
		expect(resolveEffectiveApprovalMode("auto", state)).toBe("auto");
		expect(resolveEffectiveApprovalMode("always", state)).toBe("always");
		expect(resolveEffectiveApprovalMode(undefined, state)).toBe("writes");
		// An invalid/unknown value falls through to the configured default
		// (the same rule resolveSubagentParams has always applied).
		expect(resolveEffectiveApprovalMode("banana", state)).toBe("writes");
	});

	it("rejects an explicit background: true on chain/graph only (strict === true)", () => {
		// The guard's exact predicate, pinned independently of the default: only
		// an explicit `true` on a batch shape trips it. `undefined` is not an
		// explicit request (it falls through to the default), and `false` is
		// always honoured.
		for (const shape of ["chain", "graph"] as const) {
			expect(shouldRejectBackgroundForBatch(shape, true)).toBe(true);
			expect(shouldRejectBackgroundForBatch(shape, undefined)).toBe(false);
			expect(shouldRejectBackgroundForBatch(shape, false)).toBe(false);
		}
		// Non-batch shapes never reject, even with an explicit true.
		expect(shouldRejectBackgroundForBatch("single", true)).toBe(false);
		expect(shouldRejectBackgroundForBatch("parallel", true)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Omitted + effective auto → background
// ---------------------------------------------------------------------------

describe("omitted background under effective 'auto'", () => {
	it("single task runs in the background and returns an agent id (completion path)", async () => {
		const ctx = makeCtx();
		await seedConfig(ctx, { approvalMode: "auto" satisfies ApprovalMode });

		const result = await dispatch({ task: "probe the thing" }, ctx);

		expect(result.isError).toBeFalsy();
		expect(result.details).toBeUndefined();
		const text = result.content[0].text;
		expect(text).toContain("Background agent started: bg-default-1");
		// The completion contract the conductor acts on.
		expect(text).toContain("You'll be woken with a completion message");
		expect(text).toContain("get_subagent_result({ agent_id: \"bg-default-1\" })");

		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
		expect(h.runSubagent).not.toHaveBeenCalled();
		// The EFFECTIVE value is what the run records, so a retry restores the
		// shape the run actually had rather than re-deriving the default.
		expect(capturedOriginalParams().background).toBe(true);
		// Returned at spawn time, not after the run: the inline result body the
		// stub runner produces never reaches this (non-blocking) result.
		expect(text).not.toContain("done");
	});

	it("a per-call approvalMode 'auto' also selects background (param beats config)", async () => {
		// Config default in the harness is 'writes'; the call param wins.
		const result = await dispatch({ task: "probe the thing", approvalMode: "auto" });

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain("Background agent started: bg-default-1");
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
		expect(h.runSubagent).not.toHaveBeenCalled();
	});

	it("tasks fan-out runs in the background (one agent per task, ids in order)", async () => {
		const ctx = makeCtx();
		await seedConfig(ctx, { approvalMode: "auto" });

		const result = await dispatch(
			{
				tasks: [
					{ task: "unit one", label: "alpha" },
					{ task: "unit two", label: "beta" },
				],
			},
			ctx,
		);

		expect(result.isError).toBeFalsy();
		const text = result.content[0].text;
		expect(text).toContain("Background agents started: 2");
		expect(text).toContain(`1. "alpha" — bg-default-1`);
		expect(text).toContain(`2. "beta" — bg-default-2`);
		expect(text).toContain("You'll be woken with a completion message as each finishes");
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(2);
		expect(h.runSubagent).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Omitted + chain/graph → foreground, NOT rejected
// ---------------------------------------------------------------------------

describe("omitted background on batch modes stays foreground", () => {
	it("chain runs foreground (no rejection, no spawn)", async () => {
		const ctx = makeCtx();
		await seedConfig(ctx, { approvalMode: "auto" });

		const result = await dispatch(
			{ chain: [{ task: "step one" }, { task: "step two uses {previous}" }] },
			ctx,
		);

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).not.toContain("not supported with chain");
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
		expect(h.runSubagent).toHaveBeenCalledTimes(2);
	});

	it("graph runs foreground (no rejection, no spawn)", async () => {
		const ctx = makeCtx();
		await seedConfig(ctx, { approvalMode: "auto" });

		const result = await dispatch(
			{ graph: [{ id: "a", task: "graph unit" }] },
			ctx,
		);

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).not.toContain("not supported with graph");
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// Omitted + effective always/writes → foreground
// ---------------------------------------------------------------------------

describe("omitted background under gated approval modes stays foreground", () => {
	it("configured 'always' runs foreground", async () => {
		const ctx = makeCtx();
		await seedConfig(ctx, { approvalMode: "always" });

		const result = await dispatch({ task: "gated unit" }, ctx);

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).not.toContain("Background agent started");
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
	});

	it("configured 'writes' runs foreground", async () => {
		const ctx = makeCtx();
		await seedConfig(ctx, { approvalMode: "writes" });

		const result = await dispatch({ task: "gated unit" }, ctx);

		expect(result.isError).toBeFalsy();
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
	});

	it("a per-call approvalMode 'writes' keeps a tasks batch foreground", async () => {
		const result = await dispatch({
			approvalMode: "writes",
			tasks: [{ task: "unit one" }, { task: "unit two" }],
		});

		expect(result.isError).toBeFalsy();
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
		expect(h.runSubagent).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// Explicit values keep their exact current semantics
// ---------------------------------------------------------------------------

describe("explicit background keeps today's semantics", () => {
	it("explicit true + chain is rejected with the existing message", async () => {
		const result = await dispatch({
			background: true,
			chain: [{ task: "step one" }],
		});

		expect(result.isError).toBe(true);
		expect(result.details).toBeUndefined();
		expect(result.content[0].text).toContain("background: true is not supported with chain");
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
		expect(h.runSubagent).not.toHaveBeenCalled();
	});

	it("explicit true + graph is rejected with the existing message", async () => {
		const result = await dispatch({
			background: true,
			graph: [{ id: "a", task: "graph unit" }],
		});

		expect(result.isError).toBe(true);
		expect(result.details).toBeUndefined();
		expect(result.content[0].text).toContain("background: true is not supported with graph");
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
	});

	it("explicit false + auto runs foreground", async () => {
		const ctx = makeCtx();
		await seedConfig(ctx, { approvalMode: "auto" });

		const result = await dispatch({ task: "inline probe", background: false }, ctx);

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).not.toContain("Background agent started");
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
	});

	it("explicit true + approvalMode 'always' is still rejected", async () => {
		const result = await dispatch({
			background: true,
			approvalMode: "always",
			task: "unattended write",
		});

		expect(result.isError).toBe(true);
		expect(result.details).toBeUndefined();
		// The pre-existing W5 rejection (src/prelude.ts), verbatim.
		expect(result.content[0].text).toContain("Cannot spawn background agent with approvalMode 'always'");
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Guard ordering: the explicit value is judged before the default is recorded
// ---------------------------------------------------------------------------

describe("batch guard ordering (issue #361 review)", () => {
	it("judges the caller's explicit value, not the value the default records", async () => {
		// Make the default say "background" for chain, so a guard that read the
		// RECORDED value (after `params.background ??= ...`) would see `true` and
		// reject. The caller omitted the param, so the real ordering — capture
		// the explicit value and guard BEFORE recording — must not reject.
		vi.resetModules();
		vi.doMock("../params", async (importOriginal) => {
			const actual = await importOriginal<typeof import("../params")>();
			return {
				...actual,
				defaultBackgroundFor: (...args: Parameters<typeof actual.defaultBackgroundFor>) =>
					args[0] === "chain" || args[0] === "graph"
						? true
						: actual.defaultBackgroundFor(...args),
			};
		});
		try {
			const { default: initFresh } = await import("../index");
			const registered = new Map<string, ToolEntry>();
			initFresh({
				registerTool: (t: ToolEntry) => registered.set(t.name, t),
				registerCommand: () => {},
				registerShortcut: () => {},
				on: () => {},
				appendEntry: () => {},
				sendMessage: () => {},
				ctx: { getState: () => undefined, setState: () => {} },
			} as never);
			const freshTool = registered.get("delegate_task");
			if (!freshTool) throw new Error("delegate_task tool not registered");

			vi.useFakeTimers();
			const result = await freshTool.execute(
				"call-guard-order",
				{ chain: [{ task: "step one" }] },
				undefined,
				undefined,
				makeCtx(),
			);
			vi.clearAllTimers();
			vi.useRealTimers();

			expect(result.isError).toBeFalsy();
			expect(result.content[0].text).not.toContain("not supported with chain");
			expect(h.runSubagent).toHaveBeenCalledTimes(1);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
			vi.doUnmock("../params");
			vi.resetModules();
		}
	});
});

/**
 * Issue #442 — propagation: an empty allowlist is never erased, converted to
 * "omitted", or re-enabled on the way to a spawn.
 *
 * Every shape that can reach a child is driven through its REAL chokepoint, and
 * the assertion is always the same two-step chain: the tool options the
 * chokepoint received, then the ARGUMENTS that reach pi (`buildSubagentArgs`, the
 * foreground terminal boundary).
 *
 *   - single foreground / chain / parallel / graph → `runSubagent` (mocked only
 *     as a spy: the real handler, the real resolver and the real per-unit merge
 *     are exercised)
 *   - single background → `spawnBackgroundSession` (spy)
 *   - retry → `resolveRetryParams` (real: a recorded `tools: []` must survive
 *     the rebuild, not fall back to "omitted")
 *   - `force: true` → capability-only; it must not touch tool options
 *
 * The real-CHILD proofs live in `empty-tools-child-442.test.ts` (foreground pi
 * subprocess) and `empty-tools-background-442.test.ts` (real SDK session).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Mocks — set up before the extension is imported
// ---------------------------------------------------------------------------

const runnerMocks = vi.hoisted(() => ({
	runSubagent: vi.fn(),
	cleanupTempDirs: vi.fn().mockResolvedValue(0),
	getPiInvocation: vi.fn(),
	accumulateUsage: vi.fn(),
	parseSubagentLine: vi.fn(),
}));

vi.mock("../runner", async (importOriginal) => {
	// Keep the REAL argument builder (the terminal boundary under test) and stub
	// only the spawn itself.
	const actual = await importOriginal<typeof import("../runner")>();
	return {
		...actual,
		runSubagent: runnerMocks.runSubagent,
		cleanupTempDirs: runnerMocks.cleanupTempDirs,
		getPiInvocation: runnerMocks.getPiInvocation,
		accumulateUsage: runnerMocks.accumulateUsage,
		parseSubagentLine: runnerMocks.parseSubagentLine,
	};
});

const sessionMocks = vi.hoisted(() => ({ spawnBackgroundSession: vi.fn() }));

vi.mock("../session-manager", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../session-manager")>();
	return { ...actual, spawnBackgroundSession: sessionMocks.spawnBackgroundSession };
});

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
import { buildSubagentArgs } from "../runner";
import { resolveRetryParams } from "../history";
import { resolveSubagentParams } from "../params";
import { createTempEnv } from "./fixtures/temp-lifecycle";
import { SessionState } from "../state";
import type { Logger } from "../logging";
import type { SubagentResult, SubagentRun, SubagentToolOptions } from "../types";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

interface ToolEntry {
	name: string;
	execute: (
		callId: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown }>;
}

const GLOBAL_MODEL = { provider: "test", id: "test-model" };
const env = createTempEnv("brl-442-prop");

let tool: ToolEntry;
let sessionStartHandler: ((_event: unknown, ctx: Record<string, unknown>) => Promise<void>) | undefined;

function makeCtx() {
	return {
		cwd: env.testCwd,
		model: GLOBAL_MODEL,
		modelRegistry: {
			find: () => GLOBAL_MODEL,
			hasConfiguredAuth: () => true,
			getAvailable: async () => [GLOBAL_MODEL],
		},
		getSystemPrompt: () => "You are a helpful assistant.",
		ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t } },
		sessionManager: { getEntries: () => [] as unknown[], appendCustomEntry: () => {} },
		hasUI: false,
	};
}

function makeResult(output = "ok"): SubagentResult {
	return { messages: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0, contextTokens: 0 }, exitCode: 0, stderr: "", output } as unknown as SubagentResult;
}

/** `runSubagent`'s toolOptions argument (7th positional, index 7). */
function toolOptionsOf(call: number): SubagentToolOptions | undefined {
	return runnerMocks.runSubagent.mock.calls[call]?.[7] as SubagentToolOptions | undefined;
}

/** The pi argv the FOREGROUND terminal boundary would produce for those options. */
function argsFor(call: number): string[] {
	return buildSubagentArgs(GLOBAL_MODEL, "medium", toolOptionsOf(call));
}

const silentLog: Logger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };

beforeEach(async () => {
	env.setUp();
	runnerMocks.runSubagent.mockReset();
	runnerMocks.runSubagent.mockResolvedValue(makeResult());
	runnerMocks.getPiInvocation.mockReset();
	runnerMocks.getPiInvocation.mockReturnValue({ command: process.execPath, args: [] });
	sessionMocks.spawnBackgroundSession.mockReset();
	sessionMocks.spawnBackgroundSession.mockResolvedValue({ id: "bg-442", status: "running" });

	// Boot the extension once so the builtin presets exist and the handler is
	// registered with real session state.
	if (!tool) {
		const tools = new Map<string, ToolEntry>();
		const pi = {
			registerTool: (t: ToolEntry) => tools.set(t.name, t),
			registerCommand: () => {},
			registerShortcut: () => {},
			on: (event: string, handler: (_event: unknown, ctx: Record<string, unknown>) => Promise<void>) => {
				if (event === "session_start") sessionStartHandler = handler;
			},
			appendEntry: () => {},
			sendMessage: () => {},
			ctx: { getState: () => undefined, setState: () => {} },
		};
		initExtension(pi as never);
		tool = tools.get("delegate_task") as ToolEntry;
		expect(tool).toBeDefined();
		await sessionStartHandler?.({}, makeCtx() as never);
	}
});

afterEach(async () => {
	// Must be awaited: `tearDown` defers the actual removal behind a
	// `setImmediate`, so a fire-and-forget call races the next test's `setUp`
	// and can delete the dirs that setUp just created.
	await env.tearDown();
});

function dispatch(params: Record<string, unknown>) {
	return tool.execute("call-442", params, undefined, undefined, makeCtx());
}

// ---------------------------------------------------------------------------
// Single foreground
// ---------------------------------------------------------------------------

describe("issue #442 — single foreground dispatch", () => {
	it("P1 tools: [] reaches runSubagent as [] and pi's argv carries --no-tools", async () => {
		await dispatch({ task: "say hello", tools: [], background: false });
		expect(toolOptionsOf(0)?.tools).toEqual([]);
		expect(argsFor(0)).toContain("--no-tools");
		expect(argsFor(0)).not.toContain("--no-builtin-tools");
	});

	it("P2 omitting tools still produces NO restriction flag (unchanged default)", async () => {
		await dispatch({ task: "say hello", background: false });
		expect(toolOptionsOf(0)?.tools).toBeUndefined();
		expect(argsFor(0).filter((a) => a === "--no-tools" || a === "--tools")).toEqual([]);
	});

	it("P3 force: true does not re-enable tools on an empty allowlist", async () => {
		// A capability-shaped task the pre-flight would block without force, so the
		// dispatch actually takes the forced path — and must still carry [].
		await dispatch({ task: "run the test suite", tools: [], force: true, background: false });
		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
		expect(toolOptionsOf(0)?.tools).toEqual([]);
		expect(argsFor(0)).toContain("--no-tools");
	});
});

// ---------------------------------------------------------------------------
// chain / parallel / graph — per-unit merges
// ---------------------------------------------------------------------------

describe("issue #442 — per-unit merges keep an empty allowlist", () => {
	it("P4 chain: a step's tools: [] wins over a non-empty global list", async () => {
		await dispatch({
			tools: ["read"],
			chain: [{ task: "say hello" }, { task: "say goodbye", tools: [] }],
			background: false,
		});
		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(2);
		expect(toolOptionsOf(0)?.tools).toEqual(["read"]);
		expect(argsFor(0)).toContain("--tools");
		expect(toolOptionsOf(1)?.tools).toEqual([]);
		expect(argsFor(1)).toContain("--no-tools");
	});

	it("P5 parallel: one task's tools: [] is not merged upward into the batch", async () => {
		await dispatch({
			tools: ["read"],
			tasks: [{ task: "say hello" }, { task: "say goodbye", tools: [] }],
			background: false,
		});
		const empties = runnerMocks.runSubagent.mock.calls
			.map((_c, i) => toolOptionsOf(i)?.tools)
			.filter((tools) => Array.isArray(tools) && tools.length === 0);
		expect(empties).toHaveLength(1);
		expect(runnerMocks.runSubagent.mock.calls.some((_c, i) => argsFor(i).includes("--no-tools"))).toBe(true);
	});

	it("P6 graph: a node's tools: [] reaches the node's spawn with --no-tools", async () => {
		await dispatch({
			tools: ["read"],
			graph: [{ id: "first", task: "say hello" }, { id: "second", task: "say goodbye using {first}", tools: [] }],
			background: false,
		});
		const calls = runnerMocks.runSubagent.mock.calls.length;
		expect(calls).toBe(2);
		const emptyIndex = [0, 1].find((i) => toolOptionsOf(i)?.tools?.length === 0);
		expect(emptyIndex).toBeDefined();
		expect(argsFor(emptyIndex as number)).toContain("--no-tools");
	});
});

// ---------------------------------------------------------------------------
// Background single
// ---------------------------------------------------------------------------

describe("issue #442 — background dispatch keeps the empty allowlist", () => {
	it("P7 spawnBackgroundSession receives toolOptions.tools === [] (not undefined)", async () => {
		await dispatch({ task: "say hello", tools: [], background: true });
		expect(sessionMocks.spawnBackgroundSession).toHaveBeenCalledTimes(1);
		const spawnParams = sessionMocks.spawnBackgroundSession.mock.calls[0]?.[2] as
			| { toolOptions?: SubagentToolOptions }
			| undefined;
		expect(spawnParams?.toolOptions?.tools).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// Retry
// ---------------------------------------------------------------------------

describe("issue #442 — a retry restores an empty allowlist", () => {
	const recordedRun = {
		id: "run-442",
		task: "say hello",
		status: "failed",
		startedAt: new Date().toISOString(),
		originalParams: { task: "say hello", tools: [] },
	} as unknown as SubagentRun;

	it("P9 resolveRetryParams restores tools: [] instead of treating it as absent", () => {
		const params = resolveRetryParams({ retryRunId: "run-442" }, recordedRun);
		expect(params.tools).toEqual([]);
		// ...and an explicit non-empty value on the retry call still wins.
		expect(resolveRetryParams({ retryRunId: "run-442", tools: ["read"] }, recordedRun).tools).toEqual(["read"]);
	});

	it("P10 the restored empty list resolves to --no-tools (no force re-enable)", () => {
		const params = resolveRetryParams({ retryRunId: "run-442" }, recordedRun);
		const state = new SessionState();
		state.builtinPresets = [];
		state.customPresets = [];
		const ctx = { cwd: env.testCwd } as unknown as ExtensionContext;
		const resolved = resolveSubagentParams(
			{ task: params.task, tools: params.tools, force: params.force },
			state,
			ctx,
			silentLog,
		);
		expect(resolved.toolOptions?.tools).toEqual([]);
		expect(buildSubagentArgs(GLOBAL_MODEL, "medium", resolved.toolOptions)).toContain("--no-tools");
	});
});

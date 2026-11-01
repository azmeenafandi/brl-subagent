/**
 * Mode-prologue gate order (#379, commit 2) — pins the ORDER of the dispatch
 * gates and the two background paths' asymmetric sequences against the
 * CURRENT code, before any dedupe refactor moves a gate.
 *
 * The design note (`.development/investigations/mode-prologue-design-2026-10-25.md`
 * §3/§6) found that no test drives the REAL handler and asserts which gate wins
 * when two trip at once, or in what order the prologue's steps run. This suite
 * closes that gap with two kinds of pins:
 *
 *   1. an ORDER LOG — the gate functions are wrapped (real implementations
 *      still run) and each call is recorded. A refactor that swaps two blocks
 *      changes the recorded sequence and fails the corresponding assertion;
 *   2. REJECTION PRECEDENCE — two gates are tripped at once and the test
 *      asserts which rejection the caller actually sees.
 *
 * Covered contract:
 *   - chain / parallel / graph: cost → depth → resolve → targets → preflight →
 *     H1 (and, for graph, DAG validation before cost);
 *   - fan-out: cost → resolve → model → approval → per-unit targets → H1,
 *     with NO depth gate and NO preflight;
 *   - spawnBackgroundRun: resolve → model → approval → cost → targets → H1 —
 *     the design note's finding 1, the cost gate runs AFTER approval there;
 *   - the depth gate really trips at the depth limit on the batch/single
 *     paths, and really does NOT exist on either background path;
 *   - per-unit warnings surface after the JSON payload and in unit order;
 *   - `displayTaskName` renders `Step 1 ("")` for an empty task text instead
 *     of throwing (commit 1's `?? ""` normalisation).
 *
 * Harness mirrors dispatch-capability-guards.test.ts / per-step-cwd.test.ts:
 * the REAL delegate_task execute handler with ../runner mocked, temp dirs
 * redirected, and the background spawn stubbed.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

// ---------------------------------------------------------------------------
// Gate-order recorder. `vi.hoisted` so the vi.mock factories below can see it.
// ---------------------------------------------------------------------------

const gateLog = vi.hoisted(() => ({ order: [] as string[] }));

// Wrap the gate helpers, keeping the real implementation. Each wrapper records
// the gate name at call time, so the recorded sequence IS the prologue order.
vi.mock("../prelude", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../prelude")>();
	return {
		...actual,
		gateSessionCost: (input: Parameters<typeof actual.gateSessionCost>[0]) => {
			gateLog.order.push("cost");
			return actual.gateSessionCost(input);
		},
		rejectApprovalAlwaysInBackground: (
			mode: Parameters<typeof actual.rejectApprovalAlwaysInBackground>[0],
		) => {
			gateLog.order.push("approval");
			return actual.rejectApprovalAlwaysInBackground(mode);
		},
		validateDelegationTargets: (
			input: Parameters<typeof actual.validateDelegationTargets>[0],
		) => {
			gateLog.order.push("targets");
			return actual.validateDelegationTargets(input);
		},
	};
});

// H1 is called directly by chain/graph and through prelude's
// runPreTaskValidation by parallel/fan-out/background — wrapping the one
// validatePreTask implementation logs every H1 site exactly once.
vi.mock("../validate", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../validate")>();
	return {
		...actual,
		validatePreTask: (input: Parameters<typeof actual.validatePreTask>[0]) => {
			gateLog.order.push("h1");
			return actual.validatePreTask(input);
		},
	};
});

vi.mock("../params", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../params")>();
	return {
		...actual,
		resolveSubagentParams: (
			...args: Parameters<typeof actual.resolveSubagentParams>
		) => {
			gateLog.order.push("resolve");
			return actual.resolveSubagentParams(...args);
		},
	};
});

vi.mock("../sanitize", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../sanitize")>();
	return {
		...actual,
		getCurrentDepth: () => {
			gateLog.order.push("depth");
			return actual.getCurrentDepth();
		},
		// chain/graph/single validate the mode-level cwd inline via validateCwd;
		// parallel and the per-unit passes use validateDelegationTargets, whose
		// own cwd check records this same event. Recording both makes the
		// validation position visible in every mode.
		validateCwd: (...args: Parameters<typeof actual.validateCwd>) => {
			gateLog.order.push("cwd");
			return actual.validateCwd(...args);
		},
	};
});

vi.mock("../preflight", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../preflight")>();
	return {
		...actual,
		preflightCheck: (cwd: Parameters<typeof actual.preflightCheck>[0]) => {
			gateLog.order.push("preflight");
			return actual.preflightCheck(cwd);
		},
	};
});

vi.mock("../model-availability", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../model-availability")>();
	return {
		...actual,
		modelIsAvailable: (
			...args: Parameters<typeof actual.modelIsAvailable>
		) => {
			gateLog.order.push("model");
			return actual.modelIsAvailable(...args);
		},
	};
});

vi.mock("../scheduler", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../scheduler")>();
	return {
		...actual,
		validateGraph: (...args: Parameters<typeof actual.validateGraph>) => {
			gateLog.order.push("dag");
			return actual.validateGraph(...args);
		},
		topologicalSort: (...args: Parameters<typeof actual.topologicalSort>) => {
			gateLog.order.push("sort");
			return actual.topologicalSort(...args);
		},
	};
});

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
import { createTempEnv } from "./fixtures/temp-lifecycle";
import type { SubagentResult } from "../types";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_MODEL = { provider: "test", id: "test-model" };
const MODEL_STR = `${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`;

interface SpawnParams {
	task?: string;
	description?: string;
}

let spawnSeq = 0;

function makeFakeAgent(p: SpawnParams): Record<string, unknown> {
	spawnSeq += 1;
	return {
		id: `bg-order-${spawnSeq}`,
		sessionId: `sess-bg-order-${spawnSeq}`,
		description: p.description ?? "",
		status: "running",
		startedAt: 1700000000000 + spawnSeq,
		task: p.task ?? "",
		model: MODEL_STR,
		thinkingLevel: "medium",
	};
}

function makeResult(modelStr: string): SubagentResult {
	return {
		messages: [
			{ role: "assistant", content: [{ type: "text", text: "done" }], model: modelStr },
		],
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.001,
			contextTokens: 0,
			turns: 1,
		},
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
const env = createTempEnv("brl-mode-prologue");

function setupExtension(): ToolEntry {
	const registeredTools = new Map<string, ToolEntry>();
	const mockPi = {
		registerTool: (t: ToolEntry) => registeredTools.set(t.name, t),
		registerCommand: () => {},
		registerShortcut: () => {},
		on: (
			event: string,
			handler: (_event: unknown, ctx: Record<string, unknown>) => Promise<void>,
		) => {
			if (event === "session_start") sessionStartHandler = handler;
		},
		appendEntry: () => {},
		sendMessage: () => {},
		ctx: { getState: () => undefined, setState: () => {} },
	};
	initExtension(mockPi as never);
	const toolEntry = registeredTools.get("delegate_task");
	if (!toolEntry) throw new Error("delegate_task tool not registered");
	return toolEntry;
}

type Ctx = ReturnType<typeof makeCtx>;

function makeCtx(options: { model?: boolean } = {}) {
	const model = options.model === false ? undefined : GLOBAL_MODEL;
	return {
		cwd: env.testCwd,
		model,
		modelRegistry: {
			find: (provider: string, id: string) =>
				`${provider}/${id}` === MODEL_STR ? { provider, id } : undefined,
			hasConfiguredAuth: () => true,
		},
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

/**
 * Seed config through the real session_start restore path. Every extension
 * init gets a fresh SessionState, so this is per-test isolation.
 */
async function startSession(
	config: Record<string, unknown>,
	ctx: Ctx = makeCtx(),
): Promise<void> {
	ctx.sessionManager = {
		getEntries: () => [
			{ type: "custom", customType: "brl-subagent-state", data: config },
		],
		appendCustomEntry: () => {},
	};
	if (sessionStartHandler) await sessionStartHandler({}, ctx as never);
}

async function execute(
	params: Record<string, unknown>,
	ctx: Ctx = makeCtx(),
): Promise<Awaited<ReturnType<ToolEntry["execute"]>>> {
	return tool.execute("call-379", params, undefined, undefined, ctx);
}

/** A background spawn arms a 2s poller + hard-cap timer — clear them. */
async function executeWithSpawn(
	params: Record<string, unknown>,
	ctx: Ctx = makeCtx(),
): Promise<Awaited<ReturnType<ToolEntry["execute"]>>> {
	vi.useFakeTimers();
	try {
		return await execute(params, ctx);
	} finally {
		vi.clearAllTimers();
		vi.useRealTimers();
	}
}

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
	return result.content.map((c) => c.text).join("\n");
}

/** Assert every named event appears, in this order, in the recorded log. */
/**
 * First-occurrence matching: `expectOrder` records each gate's FIRST event, so a
 * mode-level and a per-unit gate of the same kind cannot be distinguished here.
 * The IN8 precedence/position tests cover that gap (issue #379 review, advisory).
 */
function expectOrder(...names: string[]): void {
	const positions = names.map((name) => {
		const index = gateLog.order.indexOf(name);
		expect(index, `gate sequence ${JSON.stringify(gateLog.order)} is missing "${name}"`).toBeGreaterThanOrEqual(0);
		return index;
	});
	for (let i = 1; i < positions.length; i++) {
		expect(
			positions[i],
			`expected ${names[i - 1]} before ${names[i]} — recorded ${JSON.stringify(gateLog.order)}`,
		).toBeGreaterThan(positions[i - 1]);
	}
}

beforeEach(() => {
	env.setUp();
	gateLog.order = [];
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
	delete process.env.BRL_SUBAGENT_DEPTH;
	vi.clearAllTimers();
	vi.useRealTimers();
});

afterAll(async () => {
	await env.tearDown();
});

// ---------------------------------------------------------------------------
// 1. Batch-family gate order (cost → depth → resolve → targets → preflight → H1)
// ---------------------------------------------------------------------------

describe("batch mode prologue order (#379 IN1/IN3/IN4/IN5/IN6/IN7)", () => {
	it("chain runs cost → depth → resolve → targets → preflight → H1", async () => {
		const result = await execute({
			chain: [{ task: "first step" }],
			background: false,
			model: MODEL_STR,
		});
		expect(result.isError).toBeFalsy();
		// Chain validates the mode-level cwd inline (validateCwd), not through
		// validateDelegationTargets — the note's IN5 spelling difference.
		expectOrder("cost", "depth", "resolve", "cwd", "preflight", "h1");
	});

	it("parallel runs cost → depth → resolve → targets → preflight → H1", async () => {
		const result = await execute({
			tasks: [{ task: "one task", label: "one" }],
			background: false,
			model: MODEL_STR,
		});
		expect(result.isError).toBeFalsy();
		expectOrder("cost", "depth", "resolve", "targets", "preflight", "h1");
	});

	it("graph validates the DAG first, then cost → depth → resolve → targets → preflight → H1", async () => {
		const result = await execute({
			graph: [{ id: "n1", task: "one node" }],
			model: MODEL_STR,
		});
		expect(result.isError).toBeFalsy();
		// IN1 boundary: the DAG check precedes the cost gate in graph mode.
		// Graph validates the mode-level cwd inline, like chain.
		expectOrder("dag", "cost", "depth", "resolve", "cwd", "preflight", "h1");
	});

	it("the single foreground path keeps the same cost → depth → resolve → … order", async () => {
		const result = await execute({
			task: "a single task",
			background: false,
			model: MODEL_STR,
		});
		expect(result.isError).toBeFalsy();
		// Single mode validates cwd inline (validateCwd, not the helper).
		expectOrder("cost", "depth", "resolve", "cwd", "preflight", "h1");
	});
});

// ---------------------------------------------------------------------------
// 1b. Two gates tripped at once — which rejection wins
// ---------------------------------------------------------------------------

describe("batch gate precedence when two gates trip (#379 IN1/IN3/IN7)", () => {
	it("chain: cost over limit + depth exhausted → the cost rejection", async () => {
		await startSession({ sessionCostLimit: 0.01, maxSubagentDepth: 0 });
		const result = await execute({ chain: [{ task: "step" }] });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("session cost limit reached");
		expect(textOf(result)).not.toContain("Cannot delegate further");
	});

	it("chain: depth exhausted + invalid cwd → the depth rejection", async () => {
		await startSession({ maxSubagentDepth: 0 });
		const result = await execute({
			cwd: "/nonexistent/depth-vs-cwd",
			chain: [{ task: "step" }],
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Cannot delegate further");
		expect(textOf(result)).not.toContain("Invalid cwd");
	});

	it("chain: invalid cwd + unconfigured model → the cwd rejection", async () => {
		const result = await execute(
			{ cwd: "/nonexistent/cwd-vs-model", chain: [{ task: "step" }] },
			makeCtx({ model: false }),
		);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Invalid cwd");
		expect(textOf(result)).not.toContain("No model available");
	});

	it("graph: an invalid DAG (duplicate id) + cost over limit → the graph validation rejection", async () => {
		await startSession({ sessionCostLimit: 0.01 });
		// validateGraph's own errors (duplicate id / missing dependency / empty /
		// over-limit) are the ones that run BEFORE the cost gate. A dependency
		// CYCLE is only caught later by topologicalSort, so it would NOT win here
		// (see the report of this commit) — use a validateGraph-detected error.
		const result = await execute({
			graph: [
				{ id: "dup", task: "first" },
				{ id: "dup", task: "second" },
			],
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Graph validation failed");
		expect(textOf(result)).not.toContain("session cost limit reached");
	});

	it("parallel: mode-level outputFile conflict + invalid per-task cwd → the H1 rejection", async () => {
		const result = await execute({
			background: false,
			outputFile: "out.md",
			tools: ["read"],
			tasks: [{ task: "one task", cwd: "/nonexistent/unit-cwd" }],
		});
		expect(result.isError).toBe(true);
		const text = textOf(result);
		expect(text).toContain("outputFile is set but the 'write' tool is not available");
		expect(text).not.toContain("Invalid cwd");
		expect(h.runSubagent).not.toHaveBeenCalled();
	});

	it("single foreground: cost over limit + depth exhausted → the cost rejection", async () => {
		await startSession({ sessionCostLimit: 0.01, maxSubagentDepth: 0 });
		const result = await execute({ task: "a single task", background: false });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("session cost limit reached");
		expect(textOf(result)).not.toContain("Cannot delegate further");
	});
});

// ---------------------------------------------------------------------------
// 2. The depth gate: real on the batch/single paths, absent in background
// ---------------------------------------------------------------------------

describe("depth gate asymmetry (#379 IN3)", () => {
	it("chain, parallel, graph and single reject at the depth limit", async () => {
		await startSession({ maxSubagentDepth: 1 });
		process.env.BRL_SUBAGENT_DEPTH = "1";

		for (const params of [
			{ chain: [{ task: "step" }] },
			{ tasks: [{ task: "a task" }], background: false },
			{ graph: [{ id: "n1", task: "node" }] },
			{ task: "single", background: false },
		]) {
			const result = await execute(params);
			expect(result.isError, JSON.stringify(params)).toBe(true);
			expect(textOf(result)).toContain("Cannot delegate further");
			expect(h.runSubagent).not.toHaveBeenCalled();
		}
	});

	it("neither background path has a depth gate", async () => {
		await startSession({ maxSubagentDepth: 1 });
		process.env.BRL_SUBAGENT_DEPTH = "1";

		const fanOut = await executeWithSpawn({
			background: true,
			tasks: [{ task: "a task", label: "one" }],
		});
		expect(fanOut.isError).toBeFalsy();
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);

		const single = await executeWithSpawn({ task: "a single task", background: true });
		expect(single.isError).toBeFalsy();
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(2);
	});
});

// ---------------------------------------------------------------------------
// 3. The two background paths' differing sequences
// ---------------------------------------------------------------------------

describe("background prologue sequences (#379 IN1/IN3/IN6)", () => {
	it("fan-out runs cost → resolve → model → approval, with no depth/preflight", async () => {
		const result = await executeWithSpawn({
			background: true,
			tasks: [{ task: "one", label: "one" }],
			model: MODEL_STR,
		});
		expect(result.isError).toBeFalsy();
		expectOrder("cost", "resolve", "model", "approval");
		expect(gateLog.order).not.toContain("depth");
		expect(gateLog.order).not.toContain("preflight");
		// Per-unit target/H1 validation runs after all mode-level gates.
		expectOrder("approval", "targets", "h1");
	});

	it("fan-out: approval 'always' + cost over limit → the cost rejection (cost is first)", async () => {
		await startSession({ sessionCostLimit: 0.01 });
		const result = await executeWithSpawn({
			background: true,
			approvalMode: "always",
			tasks: [{ task: "one", label: "one" }],
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("session cost limit reached");
		expect(textOf(result)).not.toContain("approvalMode 'always'");
	});

	it("spawnBackgroundRun runs resolve → model → approval → cost → targets → H1", async () => {
		const result = await executeWithSpawn({
			background: true,
			task: "a single background task",
			model: MODEL_STR,
		});
		expect(result.isError).toBeFalsy();
		// Finding 1: in this path the cost gate is NOT first — it runs after
		// resolve + model + approval. Pin the current contract.
		expectOrder("resolve", "model", "approval", "cost", "targets", "h1");
		expect(gateLog.order).not.toContain("depth");
		expect(gateLog.order).not.toContain("preflight");
	});

	it("spawnBackgroundRun: approval 'always' + cost over limit → the approval rejection", async () => {
		await startSession({ sessionCostLimit: 0.01 });
		const result = await executeWithSpawn({
			background: true,
			approvalMode: "always",
			task: "a single background task",
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("approvalMode 'always'");
		expect(textOf(result)).not.toContain("session cost limit reached");
	});
});

// ---------------------------------------------------------------------------
// 4. Per-unit warnings: order relative to the gates, and surfacing
// ---------------------------------------------------------------------------

describe("per-unit warning order and surfacing (#379 IN9)", () => {
	it("chain: warnings ride the result after the JSON, in unit order and prefixed", async () => {
		const result = await execute({
			background: false,
			chain: [
				{ task: "commit the changes", label: "one" },
				{ task: "plain work", label: "two" },
				{ task: "commit the changes", label: "three" },
			],
		});
		expect(result.isError).toBeFalsy();
		const text = textOf(result);
		expect(text).toContain("[pre-task validation warnings]");
		// The warning block comes AFTER the JSON payload.
		expect(text.indexOf("[pre-task validation warnings]")).toBeGreaterThan(text.indexOf("{"));

		const first = text.indexOf(`Step 1 ("one"): Task involves git operations`);
		const third = text.indexOf(`Step 3 ("three"): Task involves git operations`);
		expect(first).toBeGreaterThanOrEqual(0);
		expect(third).toBeGreaterThan(first);
	});

	it("a warning-free chain result carries no warning block", async () => {
		const result = await execute({
			background: false,
			chain: [{ task: "plain work", label: "one" }],
		});
		expect(result.isError).toBeFalsy();
		expect(textOf(result)).not.toContain("[pre-task validation warnings]");
	});

	it("a later unit's target rejection wins over an earlier unit's collected warnings", async () => {
		const result = await execute({
			background: false,
			chain: [
				{ task: "commit the changes", label: "one" },
				{ task: "plain work", label: "two", cwd: "/nonexistent/later-unit" },
			],
		});
		expect(result.isError).toBe(true);
		const text = textOf(result);
		expect(text).toContain(`Step 2 ("two"): Invalid cwd`);
		// No warnings surfaced: the rejection precedes the result assembly.
		expect(text).not.toContain("[pre-task validation warnings]");
	});
});

// ---------------------------------------------------------------------------
// 5. displayTaskName regression — an absent task text must not throw
// ---------------------------------------------------------------------------

describe("displayTaskName on an empty task text (#379 commit 1)", () => {
	it('chain: an absent step task renders Step 1 ("") instead of throwing', async () => {
		// The schema requires a step task, so this is unreachable through the
		// registered tool; calling the real handler directly pins the safer
		// behaviour commit 1's `task: params.task ?? ""` introduced (before it,
		// mergeSubTaskParams could return an `undefined` task and
		// displayTaskName's `.length` threw a TypeError).
		const result = await execute({
			background: false,
			chain: [{ cwd: "/nonexistent/empty-task" }],
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain(`Step 1 ("")`);
		expect(textOf(result)).toContain("Invalid cwd");
	});
});

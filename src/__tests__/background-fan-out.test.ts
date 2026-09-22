/**
 * Phase 2 of issue #198: background fan-out for tasks mode —
 * `delegate_task({ tasks: [...], background: true })` spawns N independent
 * background agents and returns immediately with their ids.
 *
 * These tests drive the REAL execute handler and pin the fan-out contract:
 *
 *   1. one spawn per task, ids returned in task order with their labels;
 *   2. per-task values (label/priority/model override) reach each spawn;
 *   3. a bad per-task cwd rejects the WHOLE batch before any spawn;
 *   4. approvalMode 'always' is rejected up front (0 spawns);
 *   5. gitMode 'branch' is rejected up front (0 spawns);
 *   6. a mid-loop spawn failure names the failed task + started ids;
 *   7. abort before/ mid-fan-out: 0 or 1 spawns, reported detached/cancelled;
 *   8. the session cost limit gates the N-task estimate (0 spawns);
 *   9. a bad per-task outputFile rejects the WHOLE batch before any spawn;
 *  10. a per-task H1 outputFile-vs-write hard conflict rejects before any spawn;
 *  11. the ids handed back by one batch are always distinct.
 *
 * COVERAGE BOUNDARIES — what this suite covers and what is intentionally
 * proven elsewhere. This suite covers the fan-out CONTRACT at the handler
 * level with a stubbed spawn: batch validation (cwd/outputFile/H1/approval/
 * gitMode/cost) rejecting before any spawn, task naming + error families,
 * spawn ordering, id uniqueness, partial-failure/abort reporting. The
 * N-agent LIFECYCLE/addressability and the one-wake-per-completion
 * behaviours are intentionally proven elsewhere, not here:
 *   (a) the live two-agent fan-out point-of-use acceptance — a real 2-task
 *       fan-out returned both ids and delivered two per-agent completion
 *       wakes (recorded in .development/TASKS.md / HANDOFF.md);
 *   (b) notify-completion.test.ts — markTerminalSeen's per-id dedupe and
 *       resolveDelivery's completionNotify knob matrix;
 *   (c) session-manager.test.ts's per-agent get/steer/stop tests;
 *   (d) the shared startBackgroundAgent tail used by BOTH single background
 *       and fan-out (the spawn machinery runs exactly once, exercised by
 *       both paths).
 * This note documents that coverage argument — it is NOT a substitute for
 * a test.
 *
 * Harness modeled on background-run-extraction.test.ts: partial
 * session-manager mock (stub spawnBackgroundSession, keep other exports
 * real), ../runner mocked, fake timers with cleanup, temp dirs redirected.
 * Each spawn returns a distinct fake agent (bg-fanout-<n> per call) so the
 * returned id ORDER is assertable.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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

// The extension destructures spawnBackgroundSession out of a DYNAMIC
// import('./session-manager') inside the shared spawn tail — vi.mock
// intercepts dynamic imports too. Spread the real module so the state/session
// helpers (and the __setStorageDir redirect) stay real; stub only the spawn.
vi.mock("../session-manager", async (importOriginal) => ({
	...(await importOriginal<typeof import("../session-manager")>()),
	spawnBackgroundSession: h.spawnBackgroundSession,
}));

// tui.ts imports these at runtime; runner.ts's pi import never runs (module mocked).
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
// Redirect the real execute handler's transcript (and agent-record) writes
// away from the repo .pi/ — same module instance index.ts's dynamic import
// resolves to (vitest module cache).
import { __setOutputDir } from "../transcript";
import { __setStorageDir } from "../session-manager";

// ---------------------------------------------------------------------------
// Harness (background-run-extraction pattern)
// ---------------------------------------------------------------------------

const GLOBAL_MODEL = { provider: "test", id: "test-model" };
const STEP_MODEL = "test/step-model";

interface SpawnParams {
	task?: string;
	type?: string;
	description?: string;
	model?: string;
	thinkingLevel?: string;
	priority?: string;
	systemPrompt?: string;
	cwd?: string;
	toolOptions?: unknown;
	timeout?: number;
	gitMode?: string;
	originalParams?: Record<string, unknown>;
}

/** Per-call spawn sequence — every stub spawn gets a distinct id. */
let spawnSeq = 0;

/** Build the fake BackgroundAgent the stub resolves with for a spawn call. */
function makeFakeAgent(p: SpawnParams): Record<string, unknown> {
	spawnSeq += 1;
	return {
		id: `bg-fanout-${spawnSeq}`,
		sessionId: `sess-bg-fanout-${spawnSeq}`,
		type: p.type ?? "general-purpose",
		description: p.description ?? "",
		status: "running",
		startedAt: 1700000000000 + spawnSeq,
		task: p.task ?? "",
		model: p.model ?? `${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`,
		thinkingLevel: p.thinkingLevel ?? "medium",
		priority: p.priority ?? "normal",
	};
}

/** Default stub: resolve a fresh fake agent for every spawn call. */
function stubSpawns(): void {
	h.spawnBackgroundSession.mockImplementation(
		async (_pi: unknown, _ctx: unknown, p: SpawnParams) => makeFakeAgent(p),
	);
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
let testCwd: string;
let tempPiBase = "";

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

/** Model registry mock: listed models exist; auth per model via `unauthed`. */
function makeRegistry(
	available: string[],
	unauthed: string[] = [],
): {
	find: (provider: string, id: string) => { provider: string; id: string } | undefined;
	hasConfiguredAuth: (model: { provider: string; id: string }) => boolean;
} {
	return {
		find: (provider, id) =>
			available.includes(`${provider}/${id}`) ? { provider, id } : undefined,
		hasConfiguredAuth: (model) => !unauthed.includes(`${model.provider}/${model.id}`),
	};
}

function makeCtx(
	availableModels: string[] = [`${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`],
) {
	return {
		cwd: testCwd,
		model: GLOBAL_MODEL,
		modelRegistry: makeRegistry(availableModels),
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
 * Run delegate_task under fake timers: a SUCCESSFUL fan-out arms a 2s poller
 * + hard-cap timer per spawned agent — clear both afterwards so vitest exits
 * with no open handles.
 */
async function runFanOut(
	params: Record<string, unknown>,
	signal?: AbortSignal,
	ctx: Ctx = makeCtx(),
): Promise<Awaited<ReturnType<ToolEntry["execute"]>>> {
	vi.useFakeTimers();
	try {
		return await tool.execute("call-fanout", params, signal, undefined, ctx);
	} finally {
		vi.clearAllTimers();
		vi.useRealTimers();
	}
}

/** The spawn arg object of call `n` (0-based). */
function spawnParams(n: number): SpawnParams {
	return h.spawnBackgroundSession.mock.calls[n][2] as SpawnParams;
}

const THREE_TASKS = [
	{ task: "unit one", label: "one" },
	{ task: "unit two", label: "two" },
	{ task: "unit three", label: "three" },
];

beforeEach(() => {
	if (tempPiBase) fs.rmSync(tempPiBase, { recursive: true, force: true });
	if (testCwd) fs.rmSync(testCwd, { recursive: true, force: true });
	tempPiBase = fs.mkdtempSync(path.join(os.tmpdir(), "brl-bg-fanout-pi-"));
	// Redirect transcript/storage writes out of the repo .pi/.
	__setOutputDir(path.join(tempPiBase, "output"));
	__setStorageDir(path.join(tempPiBase, "subagents"));
	testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "brl-bg-fanout-"));

	h.runSubagent.mockReset();
	h.spawnBackgroundSession.mockReset();
	spawnSeq = 0;
	stubSpawns();
	sessionStartHandler = undefined;
	tool = setupExtension();
});

afterEach(() => {
	// Belt-and-braces: no poller interval / hard-cap timeout may outlive a test.
	vi.clearAllTimers();
	vi.useRealTimers();
});

afterAll(() => {
	if (tempPiBase) fs.rmSync(tempPiBase, { recursive: true, force: true });
	if (testCwd) fs.rmSync(testCwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The fan-out (background: true + tasks)
// ---------------------------------------------------------------------------

describe("background fan-out for tasks mode (#198 phase 2)", () => {
	it("spawns one background agent per task and returns the ids in task order with labels", async () => {
		const result = await runFanOut({
			background: true,
			tasks: [
				{ task: "first unit", label: "alpha" },
				{ task: "second unit", label: "beta" },
				{ task: "third unit", label: "gamma" },
			],
		});

		expect(result.isError).toBeFalsy();
		expect(result.details).toBeUndefined();
		const text = result.content[0].text;
		expect(text).toContain("Background agents started: 3");
		expect(text).toContain(`1. "alpha" — bg-fanout-1`);
		expect(text).toContain(`2. "beta" — bg-fanout-2`);
		expect(text).toContain(`3. "gamma" — bg-fanout-3`);
		// Ids appear in task order.
		expect(text.indexOf("bg-fanout-1")).toBeLessThan(text.indexOf("bg-fanout-2"));
		expect(text.indexOf("bg-fanout-2")).toBeLessThan(text.indexOf("bg-fanout-3"));
		expect(text).toContain(
			"You'll be woken with a completion message as each finishes",
		);
		expect(text).toContain("get_subagent_result({ agent_id })");

		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(3);
		// Foreground runner untouched — fan-out never blocks.
		expect(h.runSubagent).not.toHaveBeenCalled();
	});

	it("routes per-task values to each spawn (label/priority; per-task model override wins)", async () => {
		const ctx = makeCtx([
			`${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`,
			STEP_MODEL,
		]);
		const result = await runFanOut(
			{
				background: true,
				priority: "low",
				tasks: [
					{ task: "unit one", label: "one" },
					{ task: "unit two", label: "two", model: STEP_MODEL, priority: "critical" },
					{ task: "unit three", label: "three" },
				],
			},
			undefined,
			ctx,
		);

		expect(result.isError).toBeFalsy();
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(3);

		const c1 = spawnParams(0);
		expect(c1.task).toBe("unit one");
		expect(c1.description).toBe("one");
		expect(c1.priority).toBe("low"); // call-level fallback
		expect(c1.model).toBe(`${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`);
		expect(c1.cwd).toBe(testCwd);

		const c2 = spawnParams(1);
		expect(c2.task).toBe("unit two");
		expect(c2.description).toBe("two");
		expect(c2.priority).toBe("critical"); // per-task wins
		expect(c2.model).toBe(STEP_MODEL); // per-task model override wins
		// Retry parity: the unit's own values land on originalParams.
		expect(c2.originalParams?.model).toBe(STEP_MODEL);
		expect(c2.originalParams?.priority).toBe("critical");
		expect(c2.originalParams?.cwd).toBe(testCwd);

		const c3 = spawnParams(2);
		expect(c3.description).toBe("three");
		expect(c3.priority).toBe("low");
		expect(c3.model).toBe(`${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`);
	});

	it("rejects the whole batch on an invalid per-task cwd, before any spawn", async () => {
		const result = await runFanOut({
			background: true,
			tasks: [
				{ task: "unit one", label: "one" },
				{ task: "unit two", cwd: "/nonexistent/nope" },
			],
		});

		expect(result.isError).toBe(true);
		expect(result.details).toBeUndefined();
		const text = result.content[0].text;
		expect(text).toContain(`Task 2 ("unit two"): Invalid cwd:`);
		// Whole batch rejected pre-spawn — task 1 never started either.
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
	});

	it("rejects approvalMode 'always' up front (0 spawns)", async () => {
		const result = await runFanOut({
			background: true,
			approvalMode: "always",
			tasks: THREE_TASKS,
		});

		expect(result.isError).toBe(true);
		expect(result.details).toBeUndefined();
		expect(result.content[0].text).toContain("approvalMode 'always'");
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
	});

	it("rejects gitMode 'branch' up front (0 spawns)", async () => {
		const result = await runFanOut({
			background: true,
			gitMode: "branch",
			tasks: THREE_TASKS,
		});

		expect(result.isError).toBe(true);
		expect(result.details).toBeUndefined();
		const text = result.content[0].text;
		expect(text).toContain("gitMode 'branch'");
		// Suggests the remedies: gitMode 'none' or single-task background calls.
		expect(text).toContain("gitMode 'none'");
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
	});

	it("stops at a failing spawn and names the failed task plus the ids already started", async () => {
		let n = 0;
		h.spawnBackgroundSession.mockImplementation(
			async (_pi: unknown, _ctx: unknown, p: SpawnParams) => {
				n += 1;
				if (n === 2) throw new Error("session spawn exploded");
				return makeFakeAgent(p);
			},
		);

		const result = await runFanOut({
			background: true,
			tasks: THREE_TASKS,
		});

		expect(result.isError).toBe(true);
		expect(result.details).toBeUndefined();
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(2);
		const text = result.content[0].text;
		expect(text).toContain(`Task 2 ("two")`);
		expect(text).toContain("session spawn exploded");
		// The id that DID start is reported, with the detach guarantee.
		expect(text).toContain("bg-fanout-1");
		expect(text).toContain("they are detached and will still wake you");
	});

	it("an already-aborted signal starts nothing and reports the cancellation", async () => {
		const ac = new AbortController();
		ac.abort();

		const result = await runFanOut(
			{ background: true, tasks: THREE_TASKS },
			ac.signal,
		);

		expect(result.isError).toBe(true);
		expect(result.details).toBeUndefined();
		expect(result.content[0].text).toContain(
			"cancelled before any agent started",
		);
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
	});

	it("aborting after the first spawn reports that agent as detached (1 spawn)", async () => {
		const ac = new AbortController();
		h.spawnBackgroundSession.mockImplementation(
			async (_pi: unknown, _ctx: unknown, p: SpawnParams) => {
				// Abort DURING spawn 1 — the loop must stop before task 2.
				ac.abort();
				return makeFakeAgent(p);
			},
		);

		const result = await runFanOut(
			{ background: true, tasks: THREE_TASKS },
			ac.signal,
		);

		expect(result.isError).toBe(true);
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
		const text = result.content[0].text;
		expect(text).toContain("bg-fanout-1");
		expect(text).toContain("they are detached and will still wake you");
	});

	it("gates the N-task estimate on the session cost limit (1 fits, 3 does not)", async () => {
		const ctx = makeCtx();
		// Seed a session-persisted config (the session_start restore path):
		// a limit that fits ONE task's default $0.05 estimate but not three.
		ctx.sessionManager = {
			getEntries: () => [
				{
					type: "custom",
					customType: "brl-subagent-state",
					data: { sessionCostLimit: 0.1 },
				},
			],
			appendCustomEntry: () => {},
		};
		if (sessionStartHandler) await sessionStartHandler({}, ctx as never);

		const rejected = await runFanOut(
			{ background: true, tasks: THREE_TASKS },
			undefined,
			ctx,
		);
		expect(rejected.isError).toBe(true);
		expect(rejected.details).toBeUndefined();
		expect(rejected.content[0].text).toContain("session cost limit reached");
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();

		// Boundary: a single task ($0.05) still fits under the same limit.
		const fits = await runFanOut(
			{ background: true, tasks: [{ task: "solo unit", label: "solo" }] },
			undefined,
			ctx,
		);
		expect(fits.isError).toBeFalsy();
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
	});

	it("rejects the whole batch on an invalid per-task outputFile, before any spawn", async () => {
		const result = await runFanOut({
			background: true,
			tasks: [
				{ task: "unit one", label: "one" },
				// Path traversal: validateOutputFile resolves this against the
				// task cwd (testCwd) and rejects any result whose relative form
				// starts with ".." (escapes the project root).
				{ task: "unit two", label: "two", outputFile: "../../etc/passwd" },
				{ task: "unit three", label: "three" },
			],
		});

		expect(result.isError).toBe(true);
		expect(result.details).toBeUndefined();
		const text = result.content[0].text;
		expect(text).toContain(`Task 2 ("two"): Invalid outputFile:`);
		expect(text).toContain("escapes the project root");
		// Whole batch rejected pre-spawn — tasks 1 and 3 never started either.
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
	});

	it("rejects the whole batch on the per-task H1 outputFile-vs-write hard conflict, before any spawn", async () => {
		const result = await runFanOut({
			background: true,
			tasks: [
				{ task: "unit one", label: "one" },
				// VALID outputFile (resolves inside testCwd, not a directory) but
				// tools: ["read"] makes 'write' unavailable — validatePreTask
				// treats outputFile-without-write as a HARD error, not a warning.
				{ task: "unit two", label: "two", outputFile: "report.md", tools: ["read"] },
				{ task: "unit three", label: "three" },
			],
		});

		expect(result.isError).toBe(true);
		expect(result.details).toBeUndefined();
		const text = result.content[0].text;
		expect(text).toContain(
			`Task 2 ("two"): outputFile is set but the 'write' tool is not available`,
		);
		expect(text).toContain("tools=read");
		// Whole batch rejected pre-spawn — tasks 1 and 3 never started either.
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
	});

	it("returns three distinct agent ids — a batch never hands back a duplicate address", async () => {
		const result = await runFanOut({
			background: true,
			tasks: THREE_TASKS,
		});

		expect(result.isError).toBeFalsy();
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(3);
		const ids = result.content[0].text.match(/bg-fanout-\d+/g) ?? [];
		expect(ids).toHaveLength(3);
		expect(new Set(ids).size).toBe(3);
	});
});

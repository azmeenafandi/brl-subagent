/**
 * Dispatch parameter guards (issue #216) — capability blocks, warning
 * surfacing, and auto-route transparency, at the REAL delegate_task handler.
 *
 * Covered design points:
 *   B — pre-run block: a high-confidence capability mismatch (a
 *       run/execute/test/compile/benchmark task with no bash; an
 *       exploration task with none of find/ls/grep/bash) rejects the
 *       dispatch BEFORE any spawn, the message names the capability, the
 *       resolved toolset, and the fix including the `force` override, and
 *       `force: true` proceeds (spawn happens). Foreground and background
 *       honor block + override identically.
 *   C — pre-task validation warnings ride the RETURNED result (foreground
 *       result, background spawn result, fan-out spawn result), labelled,
 *       in addition to the existing log.warn calls.
 *   D — auto-route transparency: the result states WHICH preset was
 *       auto-selected and the matched-keyword evidence; a read-only
 *       auto-selected preset that cannot perform the task's
 *       high-confidence capability patterns blocks like B (unless force).
 *
 * Harness modeled on background-fan-out.test.ts + per-step-model.test.ts:
 * partial session-manager mock (spawnBackgroundSession stubbed, everything
 * else real), ../runner mocked, fake timers around successful background
 * spawns (the shared tail arms a 2s poller + hard-cap timer), temp dirs
 * redirected so nothing writes into the repo .pi/.
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

// Partial session-manager mock: stub ONLY the spawn; state/session helpers
// and the __setStorageDir redirect stay real (background-fan-out pattern).
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
import { __setOutputDir } from "../transcript";
import { __setStorageDir } from "../session-manager";
import { setLogCwd } from "../logging";
import type { SubagentResult } from "../types";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_MODEL = { provider: "test", id: "test-model" };

interface SpawnParams {
	task?: string;
	description?: string;
	toolOptions?: unknown;
}

let spawnSeq = 0;

function makeFakeAgent(p: SpawnParams): Record<string, unknown> {
	spawnSeq += 1;
	return {
		id: `bg-guard-${spawnSeq}`,
		sessionId: `sess-bg-guard-${spawnSeq}`,
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

function makeRegistry(available: string[]) {
	return {
		find: (provider: string, id: string) =>
			available.includes(`${provider}/${id}`) ? { provider, id } : undefined,
		hasConfiguredAuth: (model: { provider: string; id: string }) =>
			available.includes(`${model.provider}/${model.id}`),
	};
}

function makeCtx() {
	return {
		cwd: testCwd,
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

/** Load the repo's builtin presets (auto-route needs candidates). */
async function loadBuiltins(): Promise<void> {
	if (sessionStartHandler) {
		await sessionStartHandler({}, makeCtx() as never);
	}
}

async function execute(
	params: Record<string, unknown>,
): Promise<Awaited<ReturnType<ToolEntry["execute"]>>> {
	return tool.execute("call-216", params, undefined, undefined, makeCtx());
}

/**
 * Run a dispatch that SPAWNS a background agent under fake timers: a
 * successful spawn arms a 2s poller + hard-cap timer — clear both after.
 */
async function executeWithSpawn(
	params: Record<string, unknown>,
): Promise<Awaited<ReturnType<ToolEntry["execute"]>>> {
	vi.useFakeTimers();
	try {
		return await execute(params);
	} finally {
		vi.clearAllTimers();
		vi.useRealTimers();
	}
}

// Shared task texts — classified by validatePreTask (src/validate.ts).
const RUN_TASK_NO_BASH = { task: "run the test suite", tools: ["read", "write", "edit"] };
const EXPLORE_TASK_NO_BROWSE = { task: "locate the drafts directory", tools: ["read", "write", "edit"] };
const WARNING_TASK = { task: "deploy the app", tools: ["read", "write", "edit"] };
// Auto-route → code-reviewer (tools: read/grep/find/ls; excludes write/edit/bash):
// contains "review" for routing AND run/test for the capability block.
const AUTO_ROUTE_BLOCK_TASK = "review this PR and run the test suite";

beforeEach(() => {
	if (tempPiBase) fs.rmSync(tempPiBase, { recursive: true, force: true });
	if (testCwd) fs.rmSync(testCwd, { recursive: true, force: true });
	tempPiBase = fs.mkdtempSync(path.join(os.tmpdir(), "brl-guards-pi-"));
	__setOutputDir(path.join(tempPiBase, "output"));
	__setStorageDir(path.join(tempPiBase, "subagents"));
	testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "brl-guards-"));
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
	// Session-start redirected the logger's file sink at testCwd — disable it
	// FIRST, drain late writes, then remove the dirs (per-step-model pattern).
	setLogCwd(undefined);
	await new Promise((resolve) => setImmediate(resolve));
	if (tempPiBase) fs.rmSync(tempPiBase, { recursive: true, force: true });
	if (testCwd) fs.rmSync(testCwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// B — pre-run block: no spawn, message names the fix, force overrides
// ---------------------------------------------------------------------------

describe("pre-run capability block (dispatch does not spawn)", () => {
	it("foreground: run task without bash is rejected before the runner is called", async () => {
		const result = await execute(RUN_TASK_NO_BASH);

		expect(result.isError).toBe(true);
		const text = result.content[0].text;
		// Names the missing capability…
		expect(text).toContain("'bash' tool (running commands)");
		// …the resolved toolset…
		expect(text).toContain("tools=read,write,edit");
		// …and the exact fix, override included.
		expect(text).toContain("Fix: add 'bash' to this dispatch's tools");
		expect(text).toContain("force: true");
		expect(h.runSubagent).not.toHaveBeenCalled();
	});

	it("foreground: force: true proceeds past the capability block (spawn happens)", async () => {
		const result = await execute({ ...RUN_TASK_NO_BASH, force: true });

		expect(result.isError).toBeFalsy();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
		// Warning-class behaviour still applies: the mismatch rides the result.
		expect(result.content[0].text).toContain("[pre-task validation warnings]");
		expect(result.content[0].text).toContain("'bash' is not available");
	});

	it("background: run task without bash is rejected before any spawn", async () => {
		const result = await execute({ ...RUN_TASK_NO_BASH, background: true });

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("force: true");
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
		expect(h.runSubagent).not.toHaveBeenCalled();
	});

	it("background: force: true proceeds past the capability block (spawn happens)", async () => {
		const result = await executeWithSpawn({ ...RUN_TASK_NO_BASH, background: true, force: true });

		expect(result.isError).toBeFalsy();
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
		expect(result.content[0].text).toContain("[pre-task validation warnings]");
	});

	it("foreground: exploration task with none of find/ls/grep/bash is rejected", async () => {
		const result = await execute(EXPLORE_TASK_NO_BROWSE);

		expect(result.isError).toBe(true);
		const text = result.content[0].text;
		expect(text).toContain("directory exploration");
		expect(text).toContain("'find', 'ls', 'grep' or 'bash'");
		expect(text).toContain("tools=read,write,edit");
		expect(text).toContain("force: true");
		expect(h.runSubagent).not.toHaveBeenCalled();
	});

	it("fan-out: a capability-blocked unit rejects the whole batch before any spawn", async () => {
		const result = await execute({
			background: true,
			tasks: [{ task: "run the test suite", label: "run", tools: ["read", "write", "edit"] }],
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(`Task 1 ("run")`);
		expect(result.content[0].text).toContain("force: true");
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// C — warnings ride the returned result (background + foreground)
// ---------------------------------------------------------------------------

describe("pre-task validation warnings are surfaced in the result", () => {
	it("background spawn result carries the warnings, labelled", async () => {
		// "deploy" is warning-class (not in the blocking set) — the dispatch
		// proceeds, and the conductor sees the mismatch in the SPAWN result.
		const result = await executeWithSpawn({ ...WARNING_TASK, background: true });

		expect(result.isError).toBeFalsy();
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
		const text = result.content[0].text;
		expect(text).toContain("Background agent started: bg-guard-1");
		expect(text).toContain("[pre-task validation warnings]");
		expect(text).toContain("'bash' is not available (tools=read,write,edit, excludeTools=none)");
	});

	it("foreground result carries the warnings, labelled", async () => {
		const result = await execute({ task: "update the docs", tools: ["read", "bash"] });

		expect(result.isError).toBeFalsy();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
		const text = result.content[0].text;
		expect(text).toContain("[pre-task validation warnings]");
		expect(text).toContain("task involves editing files");
		expect(text).toContain("'write'");
	});

	it("fan-out spawn result carries per-task warnings, labelled with the task", async () => {
		const result = await executeWithSpawn({
			background: true,
			tasks: [{ task: "deploy the app", label: "deploy", tools: ["read", "write", "edit"] }],
		});

		expect(result.isError).toBeFalsy();
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
		const text = result.content[0].text;
		expect(text).toContain("Background agents started: 1");
		expect(text).toContain("[pre-task validation warnings]");
		expect(text).toContain(`Task 1 ("deploy"): Task task involves running commands but 'bash' is not available`);
	});
});

// ---------------------------------------------------------------------------
// D — auto-route transparency + read-only preset mismatch
// ---------------------------------------------------------------------------

describe("auto-route transparency and read-only preset mismatch", () => {
	it("foreground result states the auto-selected preset and the matched keyword", async () => {
		await loadBuiltins();

		const result = await execute({ task: "review this PR for code quality" });

		expect(result.isError).toBeFalsy();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
		const text = result.content[0].text;
		expect(text).toContain("[auto-routed to preset 'code-reviewer'");
		expect(text).toContain("matched keyword 'review'");
	});

	it("background spawn result states the auto-selected preset and the matched keyword", async () => {
		await loadBuiltins();

		const result = await executeWithSpawn({
			task: "review this PR for code quality",
			background: true,
		});

		expect(result.isError).toBeFalsy();
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
		const text = result.content[0].text;
		expect(text).toContain("[auto-routed to preset 'code-reviewer'");
		expect(text).toContain("matched keyword 'review'");
	});

	it("read-only auto-selected preset + run task blocks like B (no spawn)", async () => {
		await loadBuiltins();

		const result = await execute({ task: AUTO_ROUTE_BLOCK_TASK });

		expect(result.isError).toBe(true);
		const text = result.content[0].text;
		expect(text).toContain("'bash' tool (running commands)");
		// The resolved toolset is the auto-selected preset's — named in the message.
		expect(text).toContain("tools=read,grep,find,ls, excludeTools=write,edit,bash");
		expect(text).toContain("force: true");
		expect(h.runSubagent).not.toHaveBeenCalled();
	});

	it("same mismatch with force: true proceeds, and still shows preset + keyword + warning", async () => {
		await loadBuiltins();

		const result = await execute({ task: AUTO_ROUTE_BLOCK_TASK, force: true });

		expect(result.isError).toBeFalsy();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
		const text = result.content[0].text;
		expect(text).toContain("[auto-routed to preset 'code-reviewer'");
		expect(text).toContain("matched keyword 'review'");
		expect(text).toContain("[pre-task validation warnings]");
		expect(text).toContain("'bash' is not available");
	});
});

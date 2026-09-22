/**
 * Reject `background: true` together with the batch modes — chain, tasks,
 * graph.
 *
 * Defect: delegate_task accepted `background: true` alongside `chain`,
 * `tasks`, or `graph`, silently ignored it, and ran the batch
 * foreground/blocking while the caller believed it was background. Dispatch
 * validation now rejects the combination loudly, naming the offending mode
 * and the remedy (drop `background`, or dispatch each unit as its own
 * single-task background call).
 *
 * These tests drive the REAL delegate_task execute handler (../runner mocked
 * so no real pi subprocesses spawn) and assert the standard
 * validation-failure shape: `isError: true`, `details: undefined`, and text
 * naming the offending mode. No case here dispatches a single background
 * session — that path starts a real session and is covered elsewhere.
 *
 * Harness modeled on per-step-model.test.ts (setupExtension + mockPi +
 * makeCtx + tool.execute invocations); that file is intentionally untouched.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the extension
// ---------------------------------------------------------------------------

const runnerMocks = vi.hoisted(() => ({
	runSubagent: vi.fn(),
	cleanupTempDirs: vi.fn().mockResolvedValue(0),
	getPiInvocation: vi.fn(),
	accumulateUsage: vi.fn(),
	parseSubagentLine: vi.fn(),
}));

vi.mock("../runner", () => ({
	runSubagent: runnerMocks.runSubagent,
	cleanupTempDirs: runnerMocks.cleanupTempDirs,
	getPiInvocation: runnerMocks.getPiInvocation,
	accumulateUsage: runnerMocks.accumulateUsage,
	parseSubagentLine: runnerMocks.parseSubagentLine,
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
// Redirect the real execute handler's transcript/agent-record writes away
// from the repo .pi/ — same reason as per-step-model.test.ts: even the
// mutation-check run (check removed → a batch mode actually dispatches with
// the runner mocked) must never write into the repository's .pi/.
import { __setOutputDir } from "../transcript";
import { __setStorageDir } from "../session-manager";

// ---------------------------------------------------------------------------
// Harness (mirrors per-step-model.test.ts)
// ---------------------------------------------------------------------------

interface ToolEntry {
	name: string;
	execute: (
		callId: string,
		params: unknown,
		signal: unknown,
		onUpdate: unknown,
		ctx: unknown,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details?: unknown;
		isError?: boolean;
	}>;
}

let tool: ToolEntry;

const GLOBAL_MODEL = { provider: "test", id: "test-model" };

function setupExtension(): ToolEntry {
	const registeredTools = new Map<string, ToolEntry>();
	const mockPi = {
		registerTool: (t: ToolEntry) => registeredTools.set(t.name, t),
		registerCommand: () => {},
		registerShortcut: () => {},
		on: () => {},
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

/** Model registry mock: models listed in `available` exist; auth per model via `unauthed`. */
function makeRegistry(
	available: string[],
	unauthed: string[] = [],
): {
	find: (provider: string, id: string) => { provider: string; id: string } | undefined;
	hasConfiguredAuth: (model: { provider: string; id: string }) => boolean;
} {
	return {
		find: (provider: string, id: string) => {
			const key = `${provider}/${id}`;
			return available.includes(key) ? { provider, id } : undefined;
		},
		hasConfiguredAuth: (model: { provider: string; id: string }) => {
			const key = `${model.provider}/${model.id}`;
			return !unauthed.includes(key);
		},
	};
}

let testCwd: string;

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
			getEntries: () => [],
			appendCustomEntry: () => {},
		},
		hasUI: false,
	};
}

// Per-test temp dirs standing in for the real repo .pi/ and the project dir.
let tempPiBase = "";
let tempOutputDir = "";
let tempStorageDir = "";

beforeEach(() => {
	if (tempPiBase) fs.rmSync(tempPiBase, { recursive: true, force: true });
	if (testCwd) fs.rmSync(testCwd, { recursive: true, force: true });
	tempPiBase = fs.mkdtempSync(path.join(os.tmpdir(), "brl-bg-batch-pi-"));
	tempOutputDir = path.join(tempPiBase, "output");
	tempStorageDir = path.join(tempPiBase, "subagents");
	__setOutputDir(tempOutputDir);
	__setStorageDir(tempStorageDir);
	testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "brl-bg-batch-"));
	runnerMocks.runSubagent.mockReset();
	tool = setupExtension();
});

afterAll(() => {
	if (tempPiBase) fs.rmSync(tempPiBase, { recursive: true, force: true });
	if (testCwd) fs.rmSync(testCwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The rejection: background + batch mode → validation failure
// ---------------------------------------------------------------------------

describe("background: true is rejected with batch modes", () => {
	it("rejects tasks (parallel) + background, naming \"tasks\"", async () => {
		const result = await tool.execute("call-bg-tasks", {
			tasks: [{ task: "unit one" }],
			background: true,
		}, undefined, undefined, makeCtx());

		expect(result.isError).toBe(true);
		expect(result.details).toBeUndefined();
		expect(result.content[0].text).toContain("tasks");
		// Rejected at validation — nothing dispatched.
		expect(runnerMocks.runSubagent).not.toHaveBeenCalled();
	});

	it("rejects chain (sequential) + background, naming \"chain\"", async () => {
		const result = await tool.execute("call-bg-chain", {
			chain: [{ task: "step one" }],
			background: true,
		}, undefined, undefined, makeCtx());

		expect(result.isError).toBe(true);
		expect(result.details).toBeUndefined();
		expect(result.content[0].text).toContain("chain");
		expect(runnerMocks.runSubagent).not.toHaveBeenCalled();
	});

	it("rejects graph (dependency graph) + background, naming \"graph\"", async () => {
		// Graph node built per the real schema in src/index.ts: required id +
		// task, dependsOn optional — mirrors per-step-model.test.ts's graph shape
		// so the call reaches mode dispatch instead of failing schema validation.
		const result = await tool.execute("call-bg-graph", {
			graph: [{ id: "a", task: "task a", dependsOn: [] }],
			background: true,
		}, undefined, undefined, makeCtx());

		expect(result.isError).toBe(true);
		expect(result.details).toBeUndefined();
		expect(result.content[0].text).toContain("graph");
		expect(runnerMocks.runSubagent).not.toHaveBeenCalled();
	});
});

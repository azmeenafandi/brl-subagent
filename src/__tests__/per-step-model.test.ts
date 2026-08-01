/**
 * Tests for per-step MODEL override (issue #3, Option C).
 *
 * Precedence: step.model > global preset.model > state.config.model > conductor model.
 * The global model is resolved once per mode; per-step, if a step declares a
 * model it is parsed + availability-checked, falling back to the global model
 * with a warn when the override is unavailable.
 *
 * These tests drive the REAL delegate_task execute handler (with ../runner
 * mocked so no real pi subprocesses spawn) and assert the model argument
 * passed to runSubagent for chain/parallel/graph steps, plus the schema
 * advertised on the tool parameters.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
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
import type { SubagentResult } from "../types";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_MODEL = { provider: "test", id: "test-model" };
const STEP_MODEL = "anthropic/claude-opus-4-6";
const STEP_MODEL_PARSED = { provider: "anthropic", id: "claude-opus-4-6" };

interface ToolEntry {
	name: string;
	parameters: {
		type: string;
		properties: {
			chain?: {
				type: string;
				items: { properties: { model?: { type?: string; description?: string } } };
			};
			tasks?: {
				type: string;
				items: { properties: { model?: { type?: string; description?: string } } };
			};
			graph?: {
				type: string;
				items: { properties: { model?: { type?: string; description?: string } } };
			};
		};
	};
	execute: (...args: unknown[]) => Promise<{
		content: Array<{ type: string; text: string }>;
		details?: {
			results?: Array<{ model?: string }>;
			waves?: Array<{ tasks: Array<{ model?: string }> }>;
		};
		isError?: boolean;
	}>;
}

let tool: ToolEntry;

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

/** Model registry mock: models listed in `available` exist and have configured auth. */
function makeRegistry(available: string[]): {
	find: (provider: string, id: string) => { provider: string; id: string } | undefined;
	hasConfiguredAuth: () => boolean;
} {
	return {
		find: (provider: string, id: string) => {
			const key = `${provider}/${id}`;
			return available.includes(key) ? { provider, id } : undefined;
		},
		hasConfiguredAuth: () => true,
	};
}

let testCwd: string;

function makeCtx() {
	return {
		cwd: testCwd,
		model: GLOBAL_MODEL,
		modelRegistry: makeRegistry([`${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`, STEP_MODEL]),
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
	};
}

beforeEach(() => {
	testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "brl-per-step-model-"));
	runnerMocks.runSubagent.mockReset();
	runnerMocks.runSubagent.mockImplementation(
		async (_cwd: string, _prompt: string, model: { provider: string; id: string }) =>
			makeResult(`${model.provider}/${model.id}`),
	);
	runnerMocks.getPiInvocation.mockReset();
	runnerMocks.getPiInvocation.mockReturnValue({ command: process.execPath, args: [] });
	tool = setupExtension();
});

// ---------------------------------------------------------------------------
// Schema: step objects advertise `model`
// ---------------------------------------------------------------------------

describe("delegate_task step schemas accept model", () => {
	it("chain step schema has optional model string", () => {
		const chain = tool.parameters.properties.chain;
		expect(chain).toBeDefined();
		expect(chain?.items.properties.model).toBeDefined();
		expect(chain?.items.properties.model?.type).toBe("string");
	});

	it("tasks step schema has optional model string", () => {
		const tasks = tool.parameters.properties.tasks;
		expect(tasks).toBeDefined();
		expect(tasks?.items.properties.model).toBeDefined();
		expect(tasks?.items.properties.model?.type).toBe("string");
	});

	it("graph step schema has optional model string", () => {
		const graph = tool.parameters.properties.graph;
		expect(graph).toBeDefined();
		expect(graph?.items.properties.model).toBeDefined();
		expect(graph?.items.properties.model?.type).toBe("string");
	});
});

// ---------------------------------------------------------------------------
// Chain mode
// ---------------------------------------------------------------------------

describe("chain mode per-step model", () => {
	it("uses the step model override when available", async () => {
		const result = await tool.execute("call-1", {
			chain: [{ task: "step one", model: STEP_MODEL }],
		}, undefined, undefined, makeCtx());

		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
		expect(runnerMocks.runSubagent.mock.calls[0][2]).toEqual(STEP_MODEL_PARSED);
		// SubTaskResult.model reports the actual model that ran
		expect(result.details?.results?.[0]?.model).toBe(STEP_MODEL);
	});

	it("falls back to the global model when the step model is unavailable", async () => {
		const ctx = makeCtx();
		// Step model NOT in the registry → unavailable → fall back to global
		const result = await tool.execute("call-2", {
			chain: [{ task: "step one", model: "openai/gpt-4o" }],
		}, undefined, undefined, ctx);

		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
		expect(runnerMocks.runSubagent.mock.calls[0][2]).toEqual(GLOBAL_MODEL);
		expect(result.details?.results?.[0]?.model).toBe(`${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`);
	});

	it("falls back to the global model on malformed step model strings", async () => {
		const result = await tool.execute("call-3", {
			chain: [{ task: "step one", model: "no-slash-here" }],
		}, undefined, undefined, makeCtx());

		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
		expect(runnerMocks.runSubagent.mock.calls[0][2]).toEqual(GLOBAL_MODEL);
	});

	it("uses the global model when the step declares no model (unchanged behavior)", async () => {
		const result = await tool.execute("call-4", {
			chain: [{ task: "step one" }],
		}, undefined, undefined, makeCtx());

		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
		expect(runnerMocks.runSubagent.mock.calls[0][2]).toEqual(GLOBAL_MODEL);
	});

	it("resolves each step independently (override on step 1, global on step 2)", async () => {
		const result = await tool.execute("call-5", {
			chain: [
				{ task: "step one", model: STEP_MODEL },
				{ task: "step two" },
			],
		}, undefined, undefined, makeCtx());

		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(2);
		expect(runnerMocks.runSubagent.mock.calls[0][2]).toEqual(STEP_MODEL_PARSED);
		expect(runnerMocks.runSubagent.mock.calls[1][2]).toEqual(GLOBAL_MODEL);
		expect(result.details?.results?.[0]?.model).toBe(STEP_MODEL);
		expect(result.details?.results?.[1]?.model).toBe(`${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`);
	});
});

// ---------------------------------------------------------------------------
// Parallel mode
// ---------------------------------------------------------------------------

describe("parallel mode per-step model", () => {
	it("uses the task model override when available", async () => {
		const result = await tool.execute("call-6", {
			tasks: [{ task: "task one", model: STEP_MODEL }],
		}, undefined, undefined, makeCtx());

		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
		expect(runnerMocks.runSubagent.mock.calls[0][2]).toEqual(STEP_MODEL_PARSED);
		expect(result.details?.results?.[0]?.model).toBe(STEP_MODEL);
	});

	it("falls back to the global model when the task model is unavailable", async () => {
		const result = await tool.execute("call-7", {
			tasks: [{ task: "task one", model: "openai/gpt-4o" }],
		}, undefined, undefined, makeCtx());

		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
		expect(runnerMocks.runSubagent.mock.calls[0][2]).toEqual(GLOBAL_MODEL);
	});

	it("uses the global model when the task declares no model (unchanged behavior)", async () => {
		const result = await tool.execute("call-8", {
			tasks: [{ task: "task one" }],
		}, undefined, undefined, makeCtx());

		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
		expect(runnerMocks.runSubagent.mock.calls[0][2]).toEqual(GLOBAL_MODEL);
	});

	it("applies per-task overrides independently", async () => {
		const result = await tool.execute("call-9", {
			tasks: [
				{ task: "task one", model: STEP_MODEL },
				{ task: "task two" },
			],
		}, undefined, undefined, makeCtx());

		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(2);
		const models = runnerMocks.runSubagent.mock.calls
			.map((call) => call[2])
			.sort((a, b) => (a.provider < b.provider ? -1 : 1));
		expect(models).toEqual([STEP_MODEL_PARSED, GLOBAL_MODEL]);
	});
});

// ---------------------------------------------------------------------------
// Graph mode
// ---------------------------------------------------------------------------

describe("graph mode per-step model", () => {
	it("uses the task model override when available", async () => {
		const result = await tool.execute("call-10", {
			graph: [{ id: "a", task: "task a", model: STEP_MODEL, dependsOn: [] }],
		}, undefined, undefined, makeCtx());

		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
		expect(runnerMocks.runSubagent.mock.calls[0][2]).toEqual(STEP_MODEL_PARSED);
		expect(result.details?.waves?.[0]?.tasks?.[0]?.model).toBe(STEP_MODEL);
	});

	it("falls back to the global model when the task model is unavailable", async () => {
		const result = await tool.execute("call-11", {
			graph: [{ id: "a", task: "task a", model: "openai/gpt-4o", dependsOn: [] }],
		}, undefined, undefined, makeCtx());

		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
		expect(runnerMocks.runSubagent.mock.calls[0][2]).toEqual(GLOBAL_MODEL);
	});

	it("uses the global model when the task declares no model (unchanged behavior)", async () => {
		const result = await tool.execute("call-12", {
			graph: [{ id: "a", task: "task a", dependsOn: [] }],
		}, undefined, undefined, makeCtx());

		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
		expect(runnerMocks.runSubagent.mock.calls[0][2]).toEqual(GLOBAL_MODEL);
	});

	it("applies per-task overrides independently across a wave", async () => {
		const result = await tool.execute("call-13", {
			graph: [
				{ id: "a", task: "task a", model: STEP_MODEL, dependsOn: [] },
				{ id: "b", task: "task b", dependsOn: [] },
			],
		}, undefined, undefined, makeCtx());

		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(2);
		const models = runnerMocks.runSubagent.mock.calls
			.map((call) => call[2])
			.sort((a, b) => (a.provider < b.provider ? -1 : 1));
		expect(models).toEqual([STEP_MODEL_PARSED, GLOBAL_MODEL]);
	});
});

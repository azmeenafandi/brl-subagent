/**
 * Per-step `cwd` in the foreground multi-step modes (issue #222).
 *
 * `mergeSubTaskParams` has always merged `step.cwd`, and the background
 * fan-out has always spawned each unit in ITS resolved cwd — but the three
 * foreground shapes (chain / tasks / graph) validated a per-step cwd without
 * ever USING it: every spawn got the mode-level `resolvedCwd`. This suite
 * pins the corrected semantics:
 *
 *   - a step/node with its own `cwd` spawns IN THAT directory;
 *   - no step `cwd` → the mode-level cwd still applies (regression);
 *   - an invalid step `cwd` rejects the whole dispatch before ANY spawn,
 *     with the unit prefix (`Step 2 ("…")` / `Task 2 ("…")` / `Node "id"`);
 *   - a step's `outputFile` is validated against THAT step's cwd, not the
 *     mode-level one;
 *   - per-step tool/capability validation now covers chain and graph too, and
 *     `force: true` degrades a capability block to a warning there.
 *
 * Harness mirrors per-step-model.test.ts: the REAL delegate_task execute
 * handler with ../runner mocked (no pi subprocesses), temp dirs redirected so
 * nothing writes into the repo .pi/.
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
let tempPiBase: string;

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

function makeCtx() {
	return {
		cwd: testCwd,
		model: GLOBAL_MODEL,
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
			hasConfiguredAuth: () => true,
		},
		getSystemPrompt: () => "You are a helpful assistant.",
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: { getEntries: () => [], appendCustomEntry: () => {} },
		hasUI: false,
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

async function execute(params: Record<string, unknown>) {
	return tool.execute("call-222", params, undefined, undefined, makeCtx());
}

/** The cwds every spawn in the last dispatch received, in call order. */
function spawnCwds(): string[] {
	return runnerMocks.runSubagent.mock.calls.map((c) => c[0] as string);
}

function firstText(result: { content: Array<{ type: string; text: string }> }): string {
	return result.content.map((c) => c.text).join("\n");
}

beforeEach(() => {
	// Issue #195: disable the shared log sink BEFORE removing the previous
	// testCwd — the sink still points at it until this test's session_start.
	setLogCwd(undefined);
	if (tempPiBase) fs.rmSync(tempPiBase, { recursive: true, force: true });
	if (testCwd) fs.rmSync(testCwd, { recursive: true, force: true });
	tempPiBase = fs.mkdtempSync(path.join(os.tmpdir(), "brl-step-cwd-pi-"));
	__setOutputDir(path.join(tempPiBase, "output"));
	__setStorageDir(path.join(tempPiBase, "subagents"));
	testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "brl-step-cwd-"));
	runnerMocks.runSubagent.mockReset();
	runnerMocks.runSubagent.mockImplementation(
		async (_cwd: string, _prompt: string, model: { provider: string; id: string }) =>
			makeResult(`${model.provider}/${model.id}`),
	);
	runnerMocks.getPiInvocation.mockReset();
	runnerMocks.getPiInvocation.mockReturnValue({ command: process.execPath, args: [] });
	sessionStartHandler = undefined;
	tool = setupExtension();
});

afterAll(async () => {
	setLogCwd(undefined);
	await new Promise((resolve) => setImmediate(resolve));
	if (tempPiBase) fs.rmSync(tempPiBase, { recursive: true, force: true });
	if (testCwd) fs.rmSync(testCwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Spawn-path semantics: a step's own cwd is the cwd it spawns in
// ---------------------------------------------------------------------------

describe("per-step cwd is honoured at spawn (issue #222)", () => {
	it("chain: each step spawns in its OWN cwd, steps without one in the mode-level cwd", async () => {
		const stepA = path.join(testCwd, "step-a");
		const stepB = path.join(testCwd, "step-b");
		fs.mkdirSync(stepA);
		fs.mkdirSync(stepB);

		const result = await execute({
			chain: [
				{ task: "first step", cwd: stepA },
				{ task: "second step" },
				{ task: "third step", cwd: stepB },
			],
		});

		expect(result.isError).toBeFalsy();
		expect(spawnCwds()).toEqual([stepA, testCwd, stepB]);
	});

	it("parallel: each task spawns in its OWN cwd, tasks without one in the mode-level cwd", async () => {
		const taskA = path.join(testCwd, "task-a");
		const taskB = path.join(testCwd, "task-b");
		fs.mkdirSync(taskA);
		fs.mkdirSync(taskB);

		const result = await execute({
			tasks: [
				{ task: "work in a", label: "a", cwd: taskA },
				{ task: "work in b", label: "b", cwd: taskB },
				{ task: "work anywhere", label: "c" },
			],
		});

		expect(result.isError).toBeFalsy();
		expect(spawnCwds().sort()).toEqual([taskA, taskB, testCwd].sort());
	});

	it("graph: each node spawns in its OWN cwd, nodes without one in the mode-level cwd", async () => {
		const nodeA = path.join(testCwd, "node-a");
		const nodeB = path.join(testCwd, "node-b");
		fs.mkdirSync(nodeA);
		fs.mkdirSync(nodeB);

		const result = await execute({
			graph: [
				{ id: "n1", task: "node in a", cwd: nodeA },
				{ id: "n2", task: "node anywhere" },
				{ id: "n3", task: "node in b", cwd: nodeB },
			],
		});

		expect(result.isError).toBeFalsy();
		expect(spawnCwds().sort()).toEqual([nodeA, nodeB, testCwd].sort());
	});

	it("a step cwd is resolved relative to the session cwd", async () => {
		fs.mkdirSync(path.join(testCwd, "nested"));
		await execute({ chain: [{ task: "relative cwd", cwd: "nested" }] });
		expect(spawnCwds()).toEqual([path.join(testCwd, "nested")]);
	});

	it("regression: a mode-level cwd still applies when no step declares one", async () => {
		const modeCwd = path.join(testCwd, "mode");
		fs.mkdirSync(modeCwd);

		const result = await execute({
			cwd: modeCwd,
			chain: [{ task: "no step cwd" }],
			tasks: undefined,
		});

		expect(result.isError).toBeFalsy();
		expect(spawnCwds()).toEqual([modeCwd]);
	});
});

// ---------------------------------------------------------------------------
// Invalid per-step cwd: rejected before ANY spawn, unit-prefixed
// ---------------------------------------------------------------------------

describe("an invalid per-step cwd rejects before any spawn (issue #222)", () => {
	const BAD_CWD = path.join(os.tmpdir(), "brl-step-cwd-does-not-exist-222");

	it("chain", async () => {
		const result = await execute({
			chain: [
				{ task: "good step" },
				{ task: "bad step", label: "broken", cwd: BAD_CWD },
			],
		});
		expect(result.isError).toBe(true);
		expect(firstText(result)).toContain(`Step 2 ("broken"): Invalid cwd:`);
		expect(runnerMocks.runSubagent).not.toHaveBeenCalled();
	});

	it("parallel", async () => {
		const result = await execute({
			tasks: [
				{ task: "good task" },
				{ task: "bad task", label: "broken", cwd: BAD_CWD },
			],
		});
		expect(result.isError).toBe(true);
		expect(firstText(result)).toContain(`Task 2 ("broken"): Invalid cwd:`);
		expect(runnerMocks.runSubagent).not.toHaveBeenCalled();
	});

	it("graph", async () => {
		const result = await execute({
			graph: [
				{ id: "n1", task: "good node" },
				{ id: "n2", task: "bad node", label: "broken", cwd: BAD_CWD },
			],
		});
		expect(result.isError).toBe(true);
		expect(firstText(result)).toContain(`Node "n2": Invalid cwd:`);
		expect(runnerMocks.runSubagent).not.toHaveBeenCalled();
	});

	it("a step cwd resolving into a restricted system directory is rejected too", async () => {
		const result = await execute({ chain: [{ task: "escape", cwd: "/etc" }] });
		expect(result.isError).toBe(true);
		expect(firstText(result)).toContain("Invalid cwd:");
		expect(runnerMocks.runSubagent).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// outputFile is validated against the STEP's cwd
// ---------------------------------------------------------------------------

describe("a step's outputFile is validated against that step's cwd (issue #222)", () => {
	it("chain: an outputFile escaping the step's cwd is rejected, unit-prefixed", async () => {
		const stepCwd = path.join(testCwd, "step");
		fs.mkdirSync(stepCwd);

		const result = await execute({
			chain: [
				{ task: "writes outside", label: "escaper", cwd: stepCwd, outputFile: "../escaped.md" },
			],
		});

		expect(result.isError).toBe(true);
		expect(firstText(result)).toContain(`Step 1 ("escaper"): Invalid outputFile:`);
		expect(runnerMocks.runSubagent).not.toHaveBeenCalled();
	});

	it("parallel: an outputFile escaping the task's cwd is rejected, unit-prefixed", async () => {
		const taskCwd = path.join(testCwd, "task");
		fs.mkdirSync(taskCwd);

		const result = await execute({
			tasks: [
				{ task: "writes outside", label: "escaper", cwd: taskCwd, outputFile: "../escaped.md" },
			],
		});

		expect(result.isError).toBe(true);
		expect(firstText(result)).toContain(`Task 1 ("escaper"): Invalid outputFile:`);
		expect(runnerMocks.runSubagent).not.toHaveBeenCalled();
	});

	it("graph: an outputFile escaping the node's cwd is rejected, unit-prefixed", async () => {
		const nodeCwd = path.join(testCwd, "node");
		fs.mkdirSync(nodeCwd);

		const result = await execute({
			graph: [
				{ id: "n1", task: "writes outside", label: "escaper", cwd: nodeCwd, outputFile: "../escaped.md" },
			],
		});

		expect(result.isError).toBe(true);
		expect(firstText(result)).toContain(`Node "n1": Invalid outputFile:`);
		expect(runnerMocks.runSubagent).not.toHaveBeenCalled();
	});

	it("an outputFile INSIDE the step's cwd is accepted and the step still spawns there", async () => {
		const stepCwd = path.join(testCwd, "step");
		fs.mkdirSync(stepCwd);

		const result = await execute({
			chain: [{ task: "writes inside", cwd: stepCwd, outputFile: "findings.md" }],
		});

		expect(result.isError).toBeFalsy();
		expect(spawnCwds()).toEqual([stepCwd]);
	});
});

// ---------------------------------------------------------------------------
// Per-step tool/capability validation reaches chain and graph (issue #222)
// ---------------------------------------------------------------------------

describe("per-step capability validation covers chain and graph (issue #222)", () => {
	// Classified by validatePreTask as a run/execute task with no bash.
	const BLOCKED_STEP = { task: "run the test suite", label: "runner", tools: ["read", "write", "edit"] };

	it("chain: a capability-blocked step rejects before any spawn, unit-prefixed", async () => {
		const result = await execute({ chain: [{ task: "fine" }, BLOCKED_STEP] });

		expect(result.isError).toBe(true);
		expect(firstText(result)).toContain(`Step 2 ("runner")`);
		expect(firstText(result)).toContain("requires the 'bash' tool");
		expect(runnerMocks.runSubagent).not.toHaveBeenCalled();
	});

	it("chain: force: true proceeds past the capability block and spawns", async () => {
		const result = await execute({ chain: [BLOCKED_STEP], force: true });

		expect(result.isError).toBeFalsy();
		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
		// force degrades the block to a warning that rides the result.
		expect(firstText(result)).toContain(`Step 1 ("runner"): Task involves running commands`);
	});

	it("graph: a capability-blocked node rejects before any spawn, unit-prefixed", async () => {
		const result = await execute({ graph: [{ id: "n1", task: "fine" }, { id: "n2", ...BLOCKED_STEP }] });

		expect(result.isError).toBe(true);
		expect(firstText(result)).toContain(`Node "n2"`);
		expect(firstText(result)).toContain("requires the 'bash' tool");
		expect(runnerMocks.runSubagent).not.toHaveBeenCalled();
	});

	it("graph: force: true proceeds past the capability block and spawns", async () => {
		const result = await execute({
			graph: [{ id: "n1", ...BLOCKED_STEP }],
			force: true,
		});

		expect(result.isError).toBeFalsy();
		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
		expect(firstText(result)).toContain(`Node "n1": Task involves running commands`);
	});

	it("chain: a per-step warning rides the result, prefixed with the step", async () => {
		// "deploy" with no bash → warning (not a hard block).
		const result = await execute({
			chain: [{ task: "deploy the app", label: "shipper", tools: ["read", "write", "edit"] }],
		});

		expect(result.isError).toBeFalsy();
		expect(firstText(result)).toContain(
			`Step 1 ("shipper"): Task involves running commands but 'bash' is not available`,
		);
	});

	it("graph: a per-step warning rides the result, prefixed with the node", async () => {
		const result = await execute({
			graph: [{ id: "n1", task: "deploy the app", label: "shipper", tools: ["read", "write", "edit"] }],
		});

		expect(result.isError).toBeFalsy();
		expect(firstText(result)).toContain(
			`Node "n1": Task involves running commands but 'bash' is not available`,
		);
	});
});

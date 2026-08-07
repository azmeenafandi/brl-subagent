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
let sessionStartHandler: ((_event: unknown, ctx: Record<string, unknown>) => Promise<void>) | undefined;

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

/** Model registry mock: models listed in `available` exist; auth per model via `unauthed` (default: all authed). */
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
	it("step override wins over a preset-sourced global model (precedence)", async () => {
		// Install a custom preset with a model into the test cwd, then run
		// session_start so state picks it up. The chain step declares a
		// DIFFERENT model — the step must win.
		const presetDir = path.join(testCwd, ".pi", "brl-subagent", "presets");
		fs.mkdirSync(presetDir, { recursive: true });
		fs.writeFileSync(
			path.join(presetDir, "preset-with-model.md"),
			[
				"---",
				"name: preset-with-model",
				"description: Preset with a pinned model",
				"model: openai/gpt-4o",
				"---",
				"",
				"# Preset With Model",
			].join("\n"),
			"utf-8",
		);
		if (sessionStartHandler) {
			await sessionStartHandler({}, makeCtx() as never);
		}

		const result = await tool.execute("call-p1", {
			preset: "preset-with-model",
			chain: [{ task: "step one", model: STEP_MODEL }],
		}, undefined, undefined, makeCtx());

		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
		expect(runnerMocks.runSubagent.mock.calls[0][2]).toEqual(STEP_MODEL_PARSED);
		expect(result.details?.results?.[0]?.model).toBe(STEP_MODEL);
	});

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

	it("falls back to the global model when the step model's provider lacks auth", async () => {
		// Model IS in the catalog but the provider has no configured auth —
		// the auth-aware availability check (issue #4 behavior) must reject it.
		const ctx = makeCtx();
		ctx.modelRegistry = makeRegistry(
			[`${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`, STEP_MODEL],
			[STEP_MODEL], // STEP_MODEL catalogued but unauthed
		);
		const result = await tool.execute("call-a1", {
			chain: [{ task: "step one", model: STEP_MODEL }],
		}, undefined, undefined, ctx);

		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
		expect(runnerMocks.runSubagent.mock.calls[0][2]).toEqual(GLOBAL_MODEL);
	});

	it("falls back on whitespace-only, empty-id, and empty-provider strings", async () => {
		const cases = ["   ", "provider/", "/model", "  openai/gpt-4o  "];
		for (const bad of cases) {
			runnerMocks.runSubagent.mockClear();
			const result = await tool.execute("call-e1", {
				chain: [{ task: "step one", model: bad }],
			}, undefined, undefined, makeCtx());
			expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
			expect(runnerMocks.runSubagent.mock.calls[0][2]).toEqual(GLOBAL_MODEL);
		}
	});

	it("accepts provider/model-id with slashes in the id (OpenRouter-style)", async () => {
		// First-slash split: "openrouter/meta-llama/llama-3.3-70b" → provider
		// "openrouter", id "meta-llama/llama-3.3-70b". Availability decides.
		const slashModel = "openrouter/meta-llama/llama-3.3-70b-instruct";
		const ctx = makeCtx();
		ctx.modelRegistry = makeRegistry([slashModel]);
		const result = await tool.execute("call-s1", {
			chain: [{ task: "step one", model: slashModel }],
		}, undefined, undefined, ctx);

		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
		expect(runnerMocks.runSubagent.mock.calls[0][2]).toEqual({
			provider: "openrouter",
			id: "meta-llama/llama-3.3-70b-instruct",
		});
	});

	it("step override wins over an AUTO-ROUTED preset's model", async () => {
		// Install a custom preset that SHADOWS a built-in routing name
		// (security-auditor) with a pinned model. "audit" in the task
		// auto-routes to it — the step's explicit model must still win.
		const presetDir = path.join(testCwd, ".pi", "brl-subagent", "presets");
		fs.mkdirSync(presetDir, { recursive: true });
		fs.writeFileSync(
			path.join(presetDir, "security-auditor.md"),
			[
				"---",
				"name: security-auditor",
				"description: Custom auditor with a pinned model",
				"model: openai/gpt-4o",
				"---",
				"",
				"# Custom Auditor",
			].join("\n"),
			"utf-8",
		);
		if (sessionStartHandler) {
			await sessionStartHandler({}, makeCtx() as never);
		}

		const result = await tool.execute("call-ar1", {
			// No explicit preset → auto-route fires on "audit"
			chain: [{ task: "audit the codebase", model: STEP_MODEL }],
		}, undefined, undefined, makeCtx());

		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
		expect(runnerMocks.runSubagent.mock.calls[0][2]).toEqual(STEP_MODEL_PARSED);
		expect(result.details?.results?.[0]?.model).toBe(STEP_MODEL);
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

// ---------------------------------------------------------------------------
// Auto-route vs explicit tool intent (issue #57)
//
// The REAL resolveSubagentParams auto-route block used to fire whenever no
// preset/template was given — even when the conductor pinned an explicit
// tool preference. The routed preset's systemPrompt/promptGuideline then
// merged in, fighting the conductor's explicit choice (e.g. explicit
// tools: [read, bash] auto-routing to code-reviewer → the subagent believed
// it was read-only despite having bash). The fix: any explicit tool
// parameters (tools/excludeTools/noBuiltinTools) count as conductor intent
// and suppress keyword-based auto-routing entirely.
//
// These tests drive the real delegate_task execute handler (runner mocked)
// with the repo's BUILTIN presets loaded via session_start, and assert on
// the built prompt (runSubagent arg 1), the resolved toolOptions
// (runSubagent arg 7), and the auto-route note in the tool result.
// ---------------------------------------------------------------------------

describe("auto-route respects explicit tool intent (issue #57)", () => {
	const REVIEW_TASK = "review this PR for code quality"; // keywords → code-reviewer
	const ROUTED_PERSONA = "Code Reviewer"; // code-reviewer preset systemPrompt
	const ROUTED_GUIDELINE = "Read-only"; // code-reviewer preset promptGuideline

	/** Load the repo's builtin presets (required for auto-route to have candidates). */
	async function loadBuiltins(): Promise<void> {
		if (sessionStartHandler) {
			await sessionStartHandler({}, makeCtx() as never);
		}
	}

	it("auto-routes when no explicit preference is given", async () => {
		await loadBuiltins();

		const result = await tool.execute("call-57a", {
			task: REVIEW_TASK,
		}, undefined, undefined, makeCtx());

		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
		const prompt = runnerMocks.runSubagent.mock.calls[0][1] as string;
		// Routed persona + guidance merged in (the pre-fix behavior for no preference)
		expect(prompt).toContain(ROUTED_PERSONA);
		expect(prompt).toContain(ROUTED_GUIDELINE);
		// Routed preset's own tool restriction is applied
		expect(runnerMocks.runSubagent.mock.calls[0][7]).toEqual({
			tools: ["read", "grep", "find", "ls"],
			excludeTools: ["write", "edit", "bash"],
			noBuiltinTools: undefined,
		});
		// B2: the auto-route decision is surfaced in the result
		expect(result.content[0].text).toContain("[auto-routed to preset 'code-reviewer'");
	});

	it("does NOT auto-route when tools are explicitly given", async () => {
		await loadBuiltins();

		const result = await tool.execute("call-57b", {
			task: REVIEW_TASK,
			tools: ["read", "bash"],
		}, undefined, undefined, makeCtx());

		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
		const prompt = runnerMocks.runSubagent.mock.calls[0][1] as string;
		// No routed persona/guideline — explicit tool intent wins over routing
		expect(prompt).not.toContain(ROUTED_PERSONA);
		expect(prompt).not.toContain("Preset Guidance");
		// The EXPLICIT tools are what the subagent gets
		expect(prompt).toContain("You have access to ONLY these tools: read, bash");
		expect(runnerMocks.runSubagent.mock.calls[0][7]).toEqual({
			tools: ["read", "bash"],
			excludeTools: undefined,
			noBuiltinTools: undefined,
		});
		expect(result.content[0].text).not.toContain("[auto-routed to preset");
	});

	it("does NOT auto-route when excludeTools are explicitly given", async () => {
		await loadBuiltins();

		const result = await tool.execute("call-57c", {
			task: REVIEW_TASK,
			excludeTools: ["write"],
		}, undefined, undefined, makeCtx());

		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
		const prompt = runnerMocks.runSubagent.mock.calls[0][1] as string;
		expect(prompt).not.toContain(ROUTED_PERSONA);
		expect(runnerMocks.runSubagent.mock.calls[0][7]).toEqual({
			tools: undefined,
			excludeTools: ["write"],
			noBuiltinTools: undefined,
		});
		expect(result.content[0].text).not.toContain("[auto-routed to preset");
	});

	it("does NOT auto-route when noBuiltinTools is explicitly given", async () => {
		await loadBuiltins();

		const result = await tool.execute("call-57d", {
			task: REVIEW_TASK,
			noBuiltinTools: true,
		}, undefined, undefined, makeCtx());

		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
		const prompt = runnerMocks.runSubagent.mock.calls[0][1] as string;
		expect(prompt).not.toContain(ROUTED_PERSONA);
		expect(runnerMocks.runSubagent.mock.calls[0][7]).toEqual({
			tools: undefined,
			excludeTools: undefined,
			noBuiltinTools: true,
		});
		expect(result.content[0].text).not.toContain("[auto-routed to preset");
	});

	it("template flows are unchanged: template with no preset/tools does not auto-route", async () => {
		// Templates resolve BEFORE the auto-route block (they overwrite params.task
		// and optionally params.preset/tools), and params.template stays set, so the
		// pre-existing `!params.template` guard already gates template flows — issue
		// #57 adds the explicit-tool gate WITHOUT touching that path.
		const ctx = makeCtx();
		ctx.sessionManager = {
			getEntries: () => [
				{
					type: "custom",
					customType: "brl-subagent-state",
					data: {
						templates: [
							{ name: "review-notes", task: REVIEW_TASK }, // no preset, no tools
						],
					},
				},
			],
			appendCustomEntry: () => {},
		};
		if (sessionStartHandler) {
			await sessionStartHandler({}, ctx as never);
		}

		const result = await tool.execute("call-57e", {
			task: "placeholder", // sanitizer runs before template resolution; template task replaces it
			template: "review-notes",
			params: {},
		}, undefined, undefined, ctx);

		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
		const prompt = runnerMocks.runSubagent.mock.calls[0][1] as string;
		// Template's task resolved; the template carried no preset/tools and the
		// template param itself gates auto-route → no persona merged, unchanged
		// from before the fix.
		expect(runnerMocks.runSubagent.mock.calls[0][4]).toBe(REVIEW_TASK); // task arg = template task
		expect(prompt).not.toContain(ROUTED_PERSONA);
		expect(runnerMocks.runSubagent.mock.calls[0][7]).toBeUndefined();
		expect(result.content[0].text).not.toContain("[auto-routed to preset");
	});

	it("template with tools still suppresses auto-route (template intent wins)", async () => {
		const ctx = makeCtx();
		ctx.sessionManager = {
			getEntries: () => [
				{
					type: "custom",
					customType: "brl-subagent-state",
					data: {
						templates: [
							{ name: "read-only-review", task: REVIEW_TASK, tools: ["read"] },
						],
					},
				},
			],
			appendCustomEntry: () => {},
		};
		if (sessionStartHandler) {
			await sessionStartHandler({}, ctx as never);
		}

		const result = await tool.execute("call-57f", {
			task: "placeholder", // sanitizer runs before template resolution; template task replaces it
			template: "read-only-review",
			params: {},
		}, undefined, undefined, ctx);

		expect(runnerMocks.runSubagent).toHaveBeenCalledTimes(1);
		const prompt = runnerMocks.runSubagent.mock.calls[0][1] as string;
		expect(prompt).not.toContain(ROUTED_PERSONA);
		// The template's explicit tools reach the subagent
		expect(prompt).toContain("You have access to ONLY these tools: read");
		expect(runnerMocks.runSubagent.mock.calls[0][7]).toEqual({
			tools: ["read"],
			excludeTools: undefined,
			noBuiltinTools: undefined,
		});
		expect(result.content[0].text).not.toContain("[auto-routed to preset");
	});
});

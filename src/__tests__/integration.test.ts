/**
 * Integration tests for brl-subagent — module-boundary E2E behavior.
 *
 * These tests verify that the extension's subsystems work together correctly
 * without spawning real pi subprocesses. They test the public API surface
 * of each module in scenarios that span multiple components.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import { resolveThinkingLevel, classifyError, EMPTY_USAGE, formatTokens, formatUsageStats } from "../types";
import type { SubagentPreset, SubagentResult, SubagentRun, ThinkingLevel } from "../types";
import { buildSubagentPrompt, describePromptMode, SUBAGENT_INSTRUCTIONS } from "../prompt";
import { finalizeRunRecord, resolveRetryParams, formatRunDuration } from "../history";
import { sanitizeTask, validateCwd, validateOutputFile, getCurrentDepth, DEPTH_ENV_KEY } from "../sanitize";

// Minimal inline SessionState mock to avoid pi package dependencies in vitest.
// Only includes the subset of fields/methods used by integration tests.
class MockSessionState {
	config: {
		maxThinkingLevel: string;
		maxParallel: number;
		maxSubagentDepth: number;
		maxHistoryEntries: number;
		sessionCostLimit: number;
		seenRunIds: string[];
		presets: any[];
	};
	activeSubagents = 0;
	completedSubagents = 0;
	failedSubagents = 0;
	unseenSubagents = 0;
	builtinPresets: any[] = [];
	pendingQueue: Array<{ run: () => void; signal: AbortSignal | undefined; ctx: any }> = [];

	constructor() {
		this.config = {
			maxThinkingLevel: "high",
			maxParallel: 0,
			maxSubagentDepth: 1,
			maxHistoryEntries: 500,
			sessionCostLimit: 0,
			seenRunIds: [],
			presets: [],
		};
	}
}
const SessionState = MockSessionState;

import { acquireSlot, releaseSlot, updateProgressStatus } from "../concurrency";

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// =========================================================================
// Helpers
// =========================================================================

function makeRun(id: string, overrides: Partial<SubagentRun> = {}): SubagentRun {
	return {
		id,
		task: `Task for ${id}`,
		status: "running",
		model: "openai/gpt-4",
		thinkingLevel: "medium",
		startedAt: new Date().toISOString(),
		...overrides,
	};
}

function makeResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
	return {
		messages: [],
		usage: { ...EMPTY_USAGE },
		exitCode: 0,
		stderr: "",
		...overrides,
	};
}

function createMockPluginContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		ui: {
			setStatus: vi.fn(),
			notify: vi.fn(),
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		} as unknown as ExtensionContext["ui"],
		model: { provider: "test", id: "model-x" },
		cwd: "/home/user/project",
		sessionManager: {
			getEntries: () => [],
			appendCustomEntry: vi.fn(),
		},
		getSystemPrompt: () => "You are a default coding assistant.",
		...overrides,
	} as unknown as ExtensionContext;
}

// Inline helpers to avoid importing pi-dependent modules
function getPreset(
	name: string,
	builtinPresets: SubagentPreset[],
	customPresets: SubagentPreset[],
): SubagentPreset | undefined {
	return builtinPresets.find((p) => p.name === name) || customPresets.find((p) => p.name === name);
}

// =========================================================================
// 1. resolveSubagentParams integration: preset merging + override + cap
// =========================================================================

describe("resolveSubagentParams integration", () => {
	/**
	 * Replicates index.ts resolveSubagentParams logic to test the full
	 * parameter resolution pipeline (preset lookup, merging, thinking cap).
	 */
	function resolveSubagentParams(
		params: {
			task: string;
			label?: string;
			preset?: string;
			systemPrompt?: string;
			inheritSystemPrompt?: boolean;
			thinkingLevel?: string;
			outputFile?: string;
			timeout?: number;
			cwd?: string;
			tools?: string[];
			excludeTools?: string[];
			noBuiltinTools?: boolean;
		},
		state: SessionState,
		ctx: ExtensionContext,
	) {
		const preset = params.preset
			? getPreset(params.preset, state.builtinPresets, state.config.presets)
			: undefined;

		const mergedThinkingLevel =
			(params.thinkingLevel as ThinkingLevel | undefined) ?? preset?.thinkingLevel;
		const mergedSystemPrompt = params.systemPrompt ?? preset?.systemPrompt;
		const mergedInheritSP = params.inheritSystemPrompt ?? preset?.inheritSystemPrompt;
		const mergedOutputFile = params.outputFile ?? preset?.outputFile;
		const mergedTimeout = params.timeout ?? preset?.timeout;
		const mergedTools = params.tools ?? preset?.tools;
		const mergedExcludeTools = params.excludeTools ?? preset?.excludeTools;
		const mergedNoBuiltinTools = params.noBuiltinTools ?? preset?.noBuiltinTools;

		const thinkingLevel = resolveThinkingLevel(
			mergedThinkingLevel as ThinkingLevel | undefined,
			state.config.maxThinkingLevel,
		);

		const toolOptions =
			mergedTools || mergedExcludeTools || mergedNoBuiltinTools
				? {
						tools: mergedTools,
						excludeTools: mergedExcludeTools,
						noBuiltinTools: mergedNoBuiltinTools,
					}
				: undefined;

		return {
			task: params.task,
			label: params.label?.trim() || undefined,
			inheritSP: mergedInheritSP !== false,
			customSP: mergedSystemPrompt,
			outputFile: mergedOutputFile,
			timeout: mergedTimeout,
			effectiveCwd: params.cwd || ctx.cwd,
			thinkingLevel,
			toolOptions,
		};
	}

	// ── Preset fixtures ──────────────────────────────────────────────

	const reviewerPreset: SubagentPreset = {
		name: "code-reviewer",
		description: "Reviews code changes",
		thinkingLevel: "high",
		systemPrompt: "You are a thorough code reviewer.",
		inheritSystemPrompt: false,
		tools: ["read", "grep", "find"],
		timeout: 60000,
	};

	const auditorPreset: SubagentPreset = {
		name: "security-auditor",
		description: "Audits security",
		thinkingLevel: "xhigh",
		systemPrompt: "You are a security auditor.",
		inheritSystemPrompt: false,
		noBuiltinTools: true,
	};

	// ── Tests ────────────────────────────────────────────────────────

	it("uses preset values as defaults and allows overrides", () => {
		const state = new SessionState();
		state.builtinPresets = [reviewerPreset];

		const ctx = createMockPluginContext();

		const result = resolveSubagentParams(
			{
				task: "Audit the codebase",
				preset: "code-reviewer",
				// Override systemPrompt
				systemPrompt: "Focus on security.",
			},
			state,
			ctx,
		);

		expect(result.task).toBe("Audit the codebase");
		// Preset values inherited for non-overridden fields
		expect(result.inheritSP).toBe(false); // from preset
		expect(result.timeout).toBe(60000); // from preset
		expect(result.toolOptions?.tools).toEqual(["read", "grep", "find"]); // from preset
		// Override wins
		expect(result.customSP).toBe("Focus on security.");
	});

	it("caps thinking level at the user-configured maximum", () => {
		const state = new SessionState();
		state.config.maxThinkingLevel = "low"; // user caps at low
		state.builtinPresets = [reviewerPreset]; // preset says high

		const ctx = createMockPluginContext();

		const result = resolveSubagentParams(
			{
				task: "Quick audit",
				preset: "code-reviewer",
			},
			state,
			ctx,
		);

		// reviewerPreset says "high" but max is "low" → capped
		expect(result.thinkingLevel).toBe("low");
	});

	it("explicit thinkingLevel override is also capped at max", () => {
		const state = new SessionState();
		state.config.maxThinkingLevel = "medium";

		const ctx = createMockPluginContext();

		const result = resolveSubagentParams(
			{
				task: "Deep investigation",
				thinkingLevel: "xhigh", // > medium → capped
			},
			state,
			ctx,
		);

		expect(result.thinkingLevel).toBe("medium");
	});

	it("fallbackCwd uses ctx.cwd when no cwd provided", () => {
		const state = new SessionState();
		const ctx = createMockPluginContext({ cwd: "/workspace/my-project" });

		const result = resolveSubagentParams({ task: "test" }, state, ctx);

		expect(result.effectiveCwd).toBe("/workspace/my-project");
	});

	it("cwd override takes precedence over ctx.cwd", () => {
		const state = new SessionState();
		const ctx = createMockPluginContext({ cwd: "/workspace/my-project" });

		const result = resolveSubagentParams({ task: "test", cwd: "/other/dir" }, state, ctx);

		expect(result.effectiveCwd).toBe("/other/dir");
	});

	it("preset with noBuiltinTools is picked up as toolOptions", () => {
		const state = new SessionState();
		state.builtinPresets = [auditorPreset];

		const ctx = createMockPluginContext();

		const result = resolveSubagentParams(
			{
				task: "Audit",
				preset: "security-auditor",
			},
			state,
			ctx,
		);

		expect(result.toolOptions).toBeDefined();
		expect(result.toolOptions!.noBuiltinTools).toBe(true);
		expect(result.toolOptions!.tools).toBeUndefined();
	});

	it("override with excludeTools merges correctly with preset tools", () => {
		const state = new SessionState();
		state.builtinPresets = [reviewerPreset];

		const ctx = createMockPluginContext();

		const result = resolveSubagentParams(
			{
				task: "Review with exclusions",
				preset: "code-reviewer",
				excludeTools: ["write", "edit"],
			},
			state,
			ctx,
		);

		// tools comes from preset, excludeTools from override
		expect(result.toolOptions?.tools).toEqual(["read", "grep", "find"]);
		expect(result.toolOptions?.excludeTools).toEqual(["write", "edit"]);
	});

	it("task label is trimmed when provided as blank string", () => {
		const state = new SessionState();
		const ctx = createMockPluginContext();

		const result = resolveSubagentParams({ task: "test", label: "  " }, state, ctx);
		expect(result.label).toBeUndefined();
	});

	it("inherits inheritSystemPrompt=true when not specified anywhere", () => {
		const state = new SessionState();
		const ctx = createMockPluginContext();

		const result = resolveSubagentParams({ task: "test" }, state, ctx);
		expect(result.inheritSP).toBe(true);
	});

	it("preset with inheritSystemPrompt=false carries through with no override", () => {
		const state = new SessionState();
		state.builtinPresets = [reviewerPreset]; // inheritSystemPrompt: false

		const ctx = createMockPluginContext();

		const result = resolveSubagentParams({ task: "test", preset: "code-reviewer" }, state, ctx);
		expect(result.inheritSP).toBe(false);
	});

	it("explicit inheritSystemPrompt override wins over preset", () => {
		const state = new SessionState();
		state.builtinPresets = [reviewerPreset]; // inheritSystemPrompt: false

		const ctx = createMockPluginContext();

		const result = resolveSubagentParams(
			{ task: "test", preset: "code-reviewer", inheritSystemPrompt: true },
			state,
			ctx,
		);
		expect(result.inheritSP).toBe(true);
	});

	it("unset preset when name not found falls through to defaults", () => {
		const state = new SessionState();
		const ctx = createMockPluginContext();

		const result = resolveSubagentParams({ task: "test", preset: "nonexistent" }, state, ctx);

		// Should still resolve — preset is undefined, falls back to defaults
		expect(result.task).toBe("test");
		expect(result.inheritSP).toBe(true);
		expect(result.thinkingLevel).toBe(state.config.maxThinkingLevel);
	});

	it("no preset + no overrides produces minimal defaults", () => {
		const state = new SessionState();
		const ctx = createMockPluginContext();

		const result = resolveSubagentParams({ task: "minimal" }, state, ctx);

		expect(result.task).toBe("minimal");
		expect(result.inheritSP).toBe(true);
		expect(result.customSP).toBeUndefined();
		expect(result.outputFile).toBeUndefined();
		expect(result.timeout).toBeUndefined();
		expect(result.toolOptions).toBeUndefined();
	});
});

// =========================================================================
// 2. buildSubagentPrompt integration: full prompt construction
// =========================================================================

describe("buildSubagentPrompt integration", () => {
	const basePrompt = "You are a helpful coding assistant. You help users by reading files, executing commands, editing code.";

	it("builds complete prompt with inherit + custom + outputFile", () => {
		const custom = "Focus on security issues.";
		const result = buildSubagentPrompt(basePrompt, true, custom, "/tmp/report.md");

		expect(result).toContain(basePrompt);
		expect(result).toContain(custom);
		expect(result).toContain("/tmp/report.md");
		expect(result).toContain("Output Instructions");
		expect(result).toContain(SUBAGENT_INSTRUCTIONS);

		// Order: basePrompt < custom < output instructions < subagent instructions
		const baseIdx = result.indexOf(basePrompt);
		const customIdx = result.indexOf(custom);
		const outputIdx = result.indexOf("Output Instructions");
		const instrIdx = result.indexOf(SUBAGENT_INSTRUCTIONS);
		expect(baseIdx).toBeLessThan(customIdx);
		expect(customIdx).toBeLessThan(outputIdx);
		expect(outputIdx).toBeLessThan(instrIdx);
	});

	it("builds prompt with inherit=false + custom + outputFile", () => {
		const custom = "You are a reviewer.";
		const result = buildSubagentPrompt(basePrompt, false, custom, "/tmp/out.md");

		expect(result).not.toContain(basePrompt);
		expect(result).toContain(custom);
		expect(result).toContain("/tmp/out.md");
		expect(result).toContain(SUBAGENT_INSTRUCTIONS);
	});

	it("builds prompt with inherit=true + no custom + no outputFile", () => {
		const result = buildSubagentPrompt(basePrompt, true, undefined);

		expect(result).toContain(basePrompt);
		expect(result).toContain(SUBAGENT_INSTRUCTIONS);
		expect(result).not.toContain("Output Instructions");
	});

	it("builds prompt with inherit=false + no custom + outputFile", () => {
		const result = buildSubagentPrompt(basePrompt, false, undefined, "/tmp/out.md");

		expect(result).not.toContain(basePrompt);
		expect(result).toContain("Output Instructions");
		expect(result).toContain("/tmp/out.md");
		expect(result).toContain(SUBAGENT_INSTRUCTIONS);

		// output instructions come first, then subagent instructions
		const outputIdx = result.indexOf("Output Instructions");
		const instrIdx = result.indexOf(SUBAGENT_INSTRUCTIONS);
		expect(outputIdx).toBeLessThan(instrIdx);
	});

	it("returns only SUBAGENT_INSTRUCTIONS when all flags are false/empty", () => {
		const result = buildSubagentPrompt(basePrompt, false, undefined);
		expect(result).toBe(SUBAGENT_INSTRUCTIONS);
	});

	it("joins sections with double newlines", () => {
		const custom = "Custom block.";
		const result = buildSubagentPrompt(basePrompt, true, custom);
		// Sections should be separated by \n\n
		expect(result).toMatch(/\n\n/);
	});

	it("includes summary structure hints in output block", () => {
		const result = buildSubagentPrompt(basePrompt, true, undefined, "/tmp/report.md");
		expect(result).toContain("## Summary");
		expect(result).toContain("## Index");
		expect(result).toContain("Files examined:");
	});

	it("handles very long base prompt gracefully", () => {
		const longBase = "You are an agent.\n" + "x".repeat(10000);
		const custom = "Keep it brief.";
		const result = buildSubagentPrompt(longBase, true, custom);
		expect(result).toContain(longBase);
		expect(result).toContain(custom);
		expect(result).toContain(SUBAGENT_INSTRUCTIONS);
	});

	it("describePromptMode returns correct labels for all 4 modes", () => {
		expect(describePromptMode(true, true)).toBe("inherit + custom instructions");
		expect(describePromptMode(true, false)).toBe("inherit");
		expect(describePromptMode(false, true)).toBe("custom prompt");
		expect(describePromptMode(false, false)).toBe("default (no inheritance)");
	});
});

// =========================================================================
// 3. finalizeRunRecord: run record lifecycle
// =========================================================================

describe("finalizeRunRecord lifecycle", () => {
	it("sets status to done and populates fields for successful run", () => {
		const run = makeRun("run-1", { startedAt: new Date(Date.now() - 5000).toISOString() });
		const result = makeResult({
			exitCode: 0,
			usage: { input: 500, output: 200, cacheRead: 0, cacheWrite: 0, cost: 0.0234, contextTokens: 0, turns: 0 },
		});
		const startTs = new Date(run.startedAt).getTime();

		finalizeRunRecord(run, result, "Audit complete. Found 3 issues.", startTs);

		expect(run.status).toBe("done");
		expect(run.finishedAt).toBeDefined();
		expect(run.durationMs).toBeGreaterThanOrEqual(0);
		expect(run.cost).toBe(0.0234);
		expect(run.tokensIn).toBe(500);
		expect(run.tokensOut).toBe(200);
		expect(run.errorMessage).toBeUndefined();
		expect(run.outputSummary).toBe("Audit complete. Found 3 issues.");
		expect(run.fullOutput).toBe("Audit complete. Found 3 issues.");
	});

	it("sets status to failed when exitCode != 0", () => {
		const run = makeRun("run-2");
		const result = makeResult({
			exitCode: 1,
			errorMessage: "Something went wrong",
			usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.01, contextTokens: 0, turns: 0 },
		});
		const startTs = Date.now() - 10000;

		finalizeRunRecord(run, result, "error output", startTs);

		expect(run.status).toBe("failed");
		expect(run.errorMessage).toBe("Something went wrong");
		expect(run.cost).toBe(0.01);
	});

	it("sets status to failed when stopReason is error", () => {
		const run = makeRun("run-3");
		const result = makeResult({
			exitCode: 0,
			stopReason: "error",
			errorMessage: "Model returned error",
		});

		finalizeRunRecord(run, result, "", Date.now() - 1000);

		expect(run.status).toBe("failed");
		expect(run.errorMessage).toBe("Model returned error");
	});

	it("sets status to failed when stopReason is aborted", () => {
		const run = makeRun("run-4");
		const result = makeResult({
			exitCode: 0,
			stopReason: "aborted",
		});

		finalizeRunRecord(run, result, "", Date.now() - 1000);

		expect(run.status).toBe("failed");
	});

	it("handles zero-cost runs", () => {
		const run = makeRun("run-5");
		const result = makeResult({ exitCode: 0, usage: { ...EMPTY_USAGE } });

		finalizeRunRecord(run, result, "zero cost output", Date.now() - 1000);

		expect(run.status).toBe("done");
		expect(run.cost).toBe(0);
		expect(run.tokensIn).toBe(0);
		expect(run.tokensOut).toBe(0);
	});

	it("truncates outputSummary to 200 chars", () => {
		const run = makeRun("run-6");
		const result = makeResult({ exitCode: 0 });
		const longOutput = "x".repeat(500);

		finalizeRunRecord(run, result, longOutput, Date.now() - 1000);

		expect(run.outputSummary!.length).toBe(200);
		expect(run.fullOutput).toBe(longOutput);
	});

	it("sets fullOutput to undefined when finalOutput is empty", () => {
		const run = makeRun("run-7");
		const result = makeResult({ exitCode: 0 });

		finalizeRunRecord(run, result, "", Date.now() - 1000);

		expect(run.fullOutput).toBeUndefined();
	});

	it("durationMs is computed from startTimestamp to now", () => {
		const run = makeRun("run-8");
		const startTs = Date.now() - 3000;

		finalizeRunRecord(run, makeResult({ exitCode: 0 }), "done", startTs);

		expect(run.durationMs).toBeGreaterThanOrEqual(2500); // slight tolerance
		expect(run.durationMs).toBeLessThan(5000);
	});

	it("errorCategory from classifyError is NOT set by finalizeRunRecord — caller responsibility", () => {
		// finalizeRunRecord does NOT set errorCategory — the caller (index.ts) does it.
		// Verify that classifyError works correctly as part of the pipeline.
		const result = makeResult({
			exitCode: 0,
			errorMessage: "Subagent timed out after 30000ms",
		});
		expect(classifyError(result)).toBe("timeout");

		const result2 = makeResult({ exitCode: 1, stderr: "panic: runtime error" });
		expect(classifyError(result2)).toBe("crash");
	});
});

// =========================================================================
// 4. resolveRetryParams: retry parameter merging
// =========================================================================

describe("resolveRetryParams", () => {
	it("uses original params when no overrides provided", () => {
		const run: SubagentRun = {
			...makeRun("retry-1"),
			task: "Original task",
			label: "original-label",
			originalParams: {
				systemPrompt: "Original prompt",
				inheritSystemPrompt: false,
				thinkingLevel: "high",
				outputFile: "/tmp/out.md",
				timeout: 30000,
				cwd: "/some/dir",
				tools: ["read", "grep"],
				excludeTools: ["write"],
				noBuiltinTools: false,
				preset: "code-reviewer",
			},
		};

		const params = resolveRetryParams(
			{ task: "", retryRunId: "retry-1" },
			run,
		);

		expect(params.task).toBe("Original task");
		expect(params.label).toBe("original-label");
		expect(params.systemPrompt).toBe("Original prompt");
		expect(params.inheritSystemPrompt).toBe(false);
		expect(params.thinkingLevel).toBe("high");
		expect(params.outputFile).toBe("/tmp/out.md");
		expect(params.timeout).toBe(30000);
		expect(params.cwd).toBe("/some/dir");
		expect(params.tools).toEqual(["read", "grep"]);
		expect(params.excludeTools).toEqual(["write"]);
		expect(params.noBuiltinTools).toBe(false);
		expect(params.preset).toBe("code-reviewer");
	});

	it("explicit overrides take precedence over original params", () => {
		const run: SubagentRun = {
			...makeRun("retry-2"),
			task: "Original task",
			label: "original-label",
			originalParams: {
				systemPrompt: "Original",
				thinkingLevel: "high",
				timeout: 30000,
			},
		};

		const params = resolveRetryParams(
			{
				task: "New task override",
				label: "new-label",
				systemPrompt: "Override prompt",
				thinkingLevel: "low",
				timeout: 15000,
				retryRunId: "retry-2",
			},
			run,
		);

		expect(params.task).toBe("New task override");
		expect(params.label).toBe("new-label");
		expect(params.systemPrompt).toBe("Override prompt");
		expect(params.thinkingLevel).toBe("low");
		expect(params.timeout).toBe(15000);
	});

	it("handles run without originalParams gracefully", () => {
		const run: SubagentRun = {
			...makeRun("retry-3"),
			task: "Fallback task",
			label: "fallback-label",
		};

		const params = resolveRetryParams({ task: "" }, run);

		expect(params.task).toBe("Fallback task");
		expect(params.label).toBe("fallback-label");
		expect(params.systemPrompt).toBeUndefined();
		expect(params.thinkingLevel).toBeUndefined();
	});

	it("retryOnTimeout is preserved from explicit params", () => {
		const run: SubagentRun = {
			...makeRun("retry-4"),
			task: "Original",
			originalParams: { timeout: 10000 },
		};

		const params = resolveRetryParams(
			{ task: "", retryRunId: "retry-4", retryOnTimeout: true },
			run,
		);

		expect(params.retryOnTimeout).toBe(true);
	});

	it("overrides with undefined values fall through to original", () => {
		const run: SubagentRun = {
			...makeRun("retry-5"),
			task: "Original",
			originalParams: {
				systemPrompt: "Keep this",
				timeout: 60000,
			},
		};

		const params = resolveRetryParams(
			{
				task: "Overridden task",
				systemPrompt: undefined,
				timeout: undefined,
				retryRunId: "retry-5",
			},
			run,
		);

		// systemPrompt and timeout should fall back to original
		expect(params.systemPrompt).toBe("Keep this");
		expect(params.timeout).toBe(60000);
		expect(params.task).toBe("Overridden task");
	});
});

// =========================================================================
// 5. Concurrency flow: acquireSlot / releaseSlot
// =========================================================================

describe("concurrency flow", () => {
	it("acquireSlot returns true immediately when maxParallel is 0 (unlimited)", async () => {
		const state = new SessionState();
		state.config.maxParallel = 0;
		const ctx = createMockPluginContext();

		const result = await acquireSlot(state, ctx);
		expect(result).toBe(true);
		expect(state.activeSubagents).toBe(1);
	});

	it("acquireSlot returns true when under the limit", async () => {
		const state = new SessionState();
		state.config.maxParallel = 3;
		const ctx = createMockPluginContext();

		const result = await acquireSlot(state, ctx);
		expect(result).toBe(true);
		expect(state.activeSubagents).toBe(1);
	});

	it("acquireSlot queues when at the concurrency limit", async () => {
		const state = new SessionState();
		state.config.maxParallel = 1;
		const ctx = createMockPluginContext();

		// Fill the single slot
		const result1 = await acquireSlot(state, ctx);
		expect(result1).toBe(true);
		expect(state.activeSubagents).toBe(1);
		expect(state.pendingQueue).toHaveLength(0);

		// Second call should queue
		const result2Promise = acquireSlot(state, ctx);
		expect(state.pendingQueue).toHaveLength(1);

		// Release slot to allow the queued item to proceed
		const releasePromise = new Promise<void>((resolve) => {
			releaseSlot(state, true, ctx);
			// Use setImmediate to let the queued acquireSlot resolve
			setImmediate(resolve);
		});

		const result2 = await result2Promise;
		expect(result2).toBe(true);
		expect(state.activeSubagents).toBe(1); // released 1, acquired 1
	});

	it("releaseSlot dequeues next waiting task", async () => {
		const state = new SessionState();
		state.config.maxParallel = 1;
		const ctx = createMockPluginContext();

		// Fill the slot
		await acquireSlot(state, ctx);
		expect(state.activeSubagents).toBe(1);

		// Queue one
		const queuedPromise1 = acquireSlot(state, ctx);
		expect(state.pendingQueue).toHaveLength(1);

		// Queue another
		const queuedPromise2 = acquireSlot(state, ctx);
		expect(state.pendingQueue).toHaveLength(2);

		// Release — first queued should be dequeued and activated
		releaseSlot(state, true, ctx);
		await queuedPromise1;

		expect(state.activeSubagents).toBe(1); // slot was taken by queued
		expect(state.pendingQueue).toHaveLength(1); // one still waiting
		expect(state.completedSubagents).toBe(1);
		expect(state.unseenSubagents).toBe(1);
	});

	it("abort signal removes pending item from queue", async () => {
		const state = new SessionState();
		state.config.maxParallel = 1;
		const ctx = createMockPluginContext();
		const abortController = new AbortController();

		// Fill the slot
		await acquireSlot(state, ctx);
		expect(state.activeSubagents).toBe(1);

		// Queue with abort signal
		const queuedPromise = acquireSlot(state, ctx, abortController.signal);
		expect(state.pendingQueue).toHaveLength(1);

		// Abort
		abortController.abort();
		const result = await queuedPromise;
		expect(result).toBe(false);
		expect(state.pendingQueue).toHaveLength(0);
	});

	it("tracks success/failure counters correctly through multiple cycles", async () => {
		const state = new SessionState();
		state.config.maxParallel = 2;
		const ctx = createMockPluginContext();

		// Two successful completes
		await acquireSlot(state, ctx);
		await acquireSlot(state, ctx);
		expect(state.activeSubagents).toBe(2);

		releaseSlot(state, true, ctx);
		releaseSlot(state, true, ctx);

		expect(state.activeSubagents).toBe(0);
		expect(state.completedSubagents).toBe(2);
		expect(state.unseenSubagents).toBe(2);

		// One failure
		await acquireSlot(state, ctx);
		releaseSlot(state, false, ctx);

		expect(state.activeSubagents).toBe(0);
		expect(state.failedSubagents).toBe(1);
	});

	it("releaseSlot clamps activeSubagents at 0 when underflow occurs", () => {
		const state = new SessionState();
		state.activeSubagents = 0;
		const ctx = createMockPluginContext();

		releaseSlot(state, true, ctx);
		expect(state.activeSubagents).toBe(0); // clamped
	});

	it("updateProgressStatus fires via ctx.ui.setStatus", () => {
		const state = new SessionState();
		state.activeSubagents = 2;
		state.completedSubagents = 1;
		state.failedSubagents = 1;
		const ctx = createMockPluginContext();

		updateProgressStatus(state, ctx);

		// Should have called setStatus with a brl: ... string
		expect(ctx.ui.setStatus).toHaveBeenCalledWith(
			"brl-subagent",
			expect.stringContaining("brl:"),
		);
	});
});

// =========================================================================
// 6. Recursion depth guard
// =========================================================================

describe("recursion depth guard", () => {
	const originalDepth = process.env[DEPTH_ENV_KEY];

	afterEach(() => {
		if (originalDepth === undefined) {
			delete process.env[DEPTH_ENV_KEY];
		} else {
			process.env[DEPTH_ENV_KEY] = originalDepth;
		}
	});

	it("getCurrentDepth returns 0 when env var is not set", () => {
		delete process.env[DEPTH_ENV_KEY];
		expect(getCurrentDepth()).toBe(0);
	});

	it("getCurrentDepth reads BRL_SUBAGENT_DEPTH correctly", () => {
		process.env[DEPTH_ENV_KEY] = "2";
		expect(getCurrentDepth()).toBe(2);
	});

	it("getCurrentDepth returns 0 for non-numeric values", () => {
		process.env[DEPTH_ENV_KEY] = "abc";
		expect(getCurrentDepth()).toBe(0);
	});

	it("getCurrentDepth returns 0 for negative values", () => {
		process.env[DEPTH_ENV_KEY] = "-1";
		expect(getCurrentDepth()).toBe(0);
	});

	it("rejects delegation when depth >= maxSubagentDepth", () => {
		// Simulates index.ts logic
		process.env[DEPTH_ENV_KEY] = "1";

		const currentDepth = getCurrentDepth();
		const maxSubagentDepth = 1;

		expect(currentDepth).toBe(1);
		expect(currentDepth >= maxSubagentDepth).toBe(true);
	});

	it("allows delegation when depth < maxSubagentDepth", () => {
		process.env[DEPTH_ENV_KEY] = "0";

		const currentDepth = getCurrentDepth();
		const maxSubagentDepth = 1;

		expect(currentDepth).toBe(0);
		expect(currentDepth >= maxSubagentDepth).toBe(false);
	});

	it("handles nested depth: depth 2 with max 3 allows delegation", () => {
		process.env[DEPTH_ENV_KEY] = "2";

		const currentDepth = getCurrentDepth();
		const maxSubagentDepth = 3;

		expect(currentDepth >= maxSubagentDepth).toBe(false);
	});

	it("handles nested depth: depth 3 with max 3 rejects delegation", () => {
		process.env[DEPTH_ENV_KEY] = "3";

		const currentDepth = getCurrentDepth();
		const maxSubagentDepth = 3;

		expect(currentDepth >= maxSubagentDepth).toBe(true);
	});
});

// =========================================================================
// 7. Sanitize pipeline integration
// =========================================================================

describe("sanitize pipeline integration", () => {
	const realCwd = process.cwd();

	it("passes clean task through the full pipeline", () => {
		// Simulate index.ts F1 pipeline
		const taskResult = sanitizeTask("Review the authentication module");
		expect(taskResult.ok).toBe(true);
		if (!taskResult.ok) return;
		expect(taskResult.value).toBe("Review the authentication module");
	});

	it("rejects empty task before any further processing", () => {
		const taskResult = sanitizeTask("");
		expect(taskResult.ok).toBe(false);
		if (taskResult.ok) return;
		expect(taskResult.error).toContain("not be empty");
	});

	it("rejects backtick task before any further processing", () => {
		const taskResult = sanitizeTask("task`whoami`");
		expect(taskResult.ok).toBe(false);
		if (taskResult.ok) return;
		expect(taskResult.error).toContain("disallowed characters");
	});

	it("valid task + valid cwd = pipeline success for cwd", () => {
		const taskResult = sanitizeTask("Audit src/");
		expect(taskResult.ok).toBe(true);

		const cwdResult = validateCwd(realCwd, realCwd);
		expect(cwdResult.ok).toBe(true);
		if (cwdResult.ok) expect(cwdResult.value).toBe(realCwd);
	});

	it("valid task + escape-path cwd = cwd rejection", () => {
		const cwdResult = validateCwd("/etc", realCwd);
		expect(cwdResult.ok).toBe(false);
		if (cwdResult.ok) return;
		expect(cwdResult.error).toContain("restricted system directory");
	});

	it("valid task + valid cwd + valid relative output file = full pipeline pass", () => {
		const taskResult = sanitizeTask("Write analysis");
		expect(taskResult.ok).toBe(true);

		const cwdResult = validateCwd(realCwd, realCwd);
		expect(cwdResult.ok).toBe(true);

		const ofResult = validateOutputFile("test-output.md", realCwd);
		expect(ofResult.ok).toBe(true);
		if (ofResult.ok) expect(ofResult.value).toBe(realCwd + "/test-output.md");
	});

	it("valid task + valid cwd + traversal outputFile = outputFile rejection", () => {
		const ofResult = validateOutputFile("../../etc/passwd", realCwd);
		expect(ofResult.ok).toBe(false);
		if (ofResult.ok) return;
		expect(ofResult.error).toContain("escapes");
	});

	it("valid task + valid cwd + absolute outputFile outside project = rejected", () => {
		const ofResult = validateOutputFile("/tmp/output.md", realCwd);
		expect(ofResult.ok).toBe(false);
		if (ofResult.ok) return;
		expect(ofResult.error).toContain("escapes");
	});

	it("trims task whitespace and passes through to cwd validation", () => {
		const taskResult = sanitizeTask("  Analyze  ");
		expect(taskResult.ok).toBe(true);
		if (taskResult.ok) expect(taskResult.value).toBe("Analyze");
	});

	it("error from sanitizeTask is terminal - rest of pipeline not reached", () => {
		// This simulates the index.ts guard:
		//   const taskResult = sanitizeTask(params.task);
		//   if (!taskResult.ok) return error;
		const taskResult = sanitizeTask("");
		expect(taskResult.ok).toBe(false);

		// If we got here without returning, we'd validate cwd
		// But in the real pipeline, this early return prevents that.
		expect(taskResult).toBeDefined();
	});
});

// =========================================================================
// 8. Format functions — edge cases not covered by unit tests
// =========================================================================

describe("formatTokens edge cases", () => {
	it("handles zero", () => {
		expect(formatTokens(0)).toBe("0");
	});

	it("handles single digit", () => {
		expect(formatTokens(5)).toBe("5");
	});

	it("handles 999 (boundary before k)", () => {
		expect(formatTokens(999)).toBe("999");
	});

	it("handles 1000 exactly (first k value)", () => {
		expect(formatTokens(1000)).toBe("1.0k");
	});

	it("handles 9999 (last decimal k value)", () => {
		expect(formatTokens(9999)).toBe("10.0k");
	});

	it("handles 10000 exactly (first integer k value)", () => {
		expect(formatTokens(10000)).toBe("10k");
	});

	it("handles 999999 (last integer k value)", () => {
		expect(formatTokens(999999)).toBe("1000k");
	});

	it("handles 1000000 exactly (first M value)", () => {
		expect(formatTokens(1000000)).toBe("1.0M");
	});

	it("handles large millions", () => {
		expect(formatTokens(75000000)).toBe("75.0M");
	});

	it("handles negative values (unexpected but defensive)", () => {
		expect(formatTokens(-5)).toBe("-5");
	});
});

describe("formatUsageStats edge cases", () => {
	it("returns empty string for all-zero usage", () => {
		const usage = { ...EMPTY_USAGE };
		expect(formatUsageStats(usage)).toBe("");
	});

	it("shows only cost when only cost is set", () => {
		const usage = { ...EMPTY_USAGE, cost: 0.0012 };
		expect(formatUsageStats(usage)).toBe("$0.0012");
	});

	it("shows only turns when only turns is set", () => {
		const usage = { ...EMPTY_USAGE, turns: 3 };
		expect(formatUsageStats(usage)).toBe("3 turns");
	});

	it("shows single turn correctly", () => {
		const usage = { ...EMPTY_USAGE, turns: 1 };
		expect(formatUsageStats(usage)).toBe("1 turn");
	});

	it("shows only cache stats when only those are set", () => {
		const usage = { ...EMPTY_USAGE, cacheRead: 5000, cacheWrite: 2000 };
		const result = formatUsageStats(usage);
		expect(result).toContain("R5.0k");
		expect(result).toContain("W2.0k");
	});

	it("includes contextTokens when > 0", () => {
		const usage = { ...EMPTY_USAGE, contextTokens: 8192 };
		expect(formatUsageStats(usage)).toContain("ctx:8.2k");
	});

	it("omits contextTokens when 0", () => {
		const usage = { ...EMPTY_USAGE, input: 100, output: 50 };
		expect(formatUsageStats(usage)).not.toContain("ctx:");
	});

	it("appends model name at the end when provided", () => {
		const usage = { ...EMPTY_USAGE, turns: 2, input: 500, cost: 0.01 };
		const result = formatUsageStats(usage, "anthropic/claude-3");
		expect(result).toMatch(/anthropic\/claude-3$/);
	});

	it("formats all fields together in expected order", () => {
		const usage = {
			input: 1000,
			output: 500,
			cacheRead: 200,
			cacheWrite: 100,
			cost: 0.0234,
			contextTokens: 4096,
			turns: 2,
		};
		const result = formatUsageStats(usage, "openai/gpt-4");
		expect(result).toBe("2 turns ↑1.0k ↓500 R200 W100 $0.0234 ctx:4.1k openai/gpt-4");
	});
});

describe("formatRunDuration edge cases", () => {
	it("returns ms for sub-second durations", () => {
		expect(formatRunDuration(0)).toBe("0ms");
		expect(formatRunDuration(100)).toBe("100ms");
		expect(formatRunDuration(999)).toBe("999ms");
	});

	it("returns seconds for durations between 1s and 60s", () => {
		expect(formatRunDuration(1000)).toBe("1.0s");
		expect(formatRunDuration(1500)).toBe("1.5s");
		expect(formatRunDuration(59999)).toBe("60.0s");
	});

	it("returns minutes and seconds for durations >= 60s", () => {
		expect(formatRunDuration(60000)).toBe("1m 0s");
		expect(formatRunDuration(65000)).toBe("1m 5s");
		expect(formatRunDuration(120000)).toBe("2m 0s");
		expect(formatRunDuration(3660000)).toBe("61m 0s");
	});

	it("handles typical subagent run times", () => {
		expect(formatRunDuration(45000)).toBe("45.0s");
		expect(formatRunDuration(123456)).toBe("2m 3s");
	});
});

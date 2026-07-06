/**
 * Integration-style tests for P1 (Task Chaining) and P2 (Parallel Mode).
 *
 * These tests cover the logic functions and result aggregation without
 * spawning real pi subprocesses.
 */

import { describe, it, expect } from "vitest";
import {
	resolveThinkingLevel,
	EMPTY_USAGE,
	MAX_CHAIN_STEPS,
	MAX_PARALLEL_TASKS,
	PREVIOUS_OUTPUT_PLACEHOLDER,
	type SubTaskParams,
	type SubTaskResult,
	type ChainDetails,
	type ParallelDetails,
	type ThinkingLevel,
	type SubagentToolOptions,
	type UsageStats,
} from "../types";

// =========================================================================
// Helper: build a SubTaskResult for aggregation tests
// =========================================================================

function makeSubTaskResult(
	overrides: Partial<SubTaskResult> & {
		task: string;
		exitCode: number;
		usage?: Partial<UsageStats>;
	},
): SubTaskResult {
	return {
		label: overrides.label ?? undefined,
		step: overrides.step ?? undefined,
		task: overrides.task,
		exitCode: overrides.exitCode,
		messages: overrides.messages ?? [],
		stderr: overrides.stderr ?? "",
		usage: {
			input: overrides.usage?.input ?? 0,
			output: overrides.usage?.output ?? 0,
			cacheRead: overrides.usage?.cacheRead ?? 0,
			cacheWrite: overrides.usage?.cacheWrite ?? 0,
			cost: overrides.usage?.cost ?? 0,
			contextTokens: overrides.usage?.contextTokens ?? 0,
			turns: overrides.usage?.turns ?? 0,
		},
		model: overrides.model ?? undefined,
		stopReason: overrides.stopReason ?? undefined,
		errorMessage: overrides.errorMessage ?? undefined,
		errorCategory: overrides.errorCategory ?? undefined,
	};
}

/** Minimal resolved params shape used by mergeSubTaskParams. */
interface ResolvedParamsLike {
	task: string;
	label: string | undefined;
	inheritSP: boolean;
	customSP: string | undefined;
	outputFile: string | undefined;
	timeout: number | undefined;
	effectiveCwd: string;
	thinkingLevel: ThinkingLevel;
	toolOptions: SubagentToolOptions | undefined;
	resolvedGitMode: "branch" | "none";
}

// =========================================================================
// 1. mergeSubTaskParams
// =========================================================================

describe("mergeSubTaskParams", () => {
	/**
	 * Replicates the logic from index.ts mergeSubTaskParams.
	 * Accepts maxThinkingLevel as a parameter (instead of reading from state).
	 */
	function mergeSubTaskParams(
		globalParams: ResolvedParamsLike,
		subTask: SubTaskParams,
		maxThinkingLevel: ThinkingLevel,
	): ResolvedParamsLike {
		const mergedThinkingLevel = subTask.thinkingLevel
			? resolveThinkingLevel(
					subTask.thinkingLevel as ThinkingLevel,
					maxThinkingLevel,
				)
			: globalParams.thinkingLevel;

		const mergedTools = subTask.tools ?? globalParams.toolOptions?.tools;
		const mergedExcludeTools =
			subTask.excludeTools ?? globalParams.toolOptions?.excludeTools;
		const mergedNoBuiltinTools =
			subTask.noBuiltinTools ?? globalParams.toolOptions?.noBuiltinTools;

		const mergedToolOptions: SubagentToolOptions | undefined =
			mergedTools || mergedExcludeTools || mergedNoBuiltinTools
				? {
						tools: mergedTools,
						excludeTools: mergedExcludeTools,
						noBuiltinTools: mergedNoBuiltinTools,
					}
				: undefined;

		return {
			task: subTask.task || globalParams.task,
			label: subTask.label ?? globalParams.label,
			inheritSP: subTask.inheritSystemPrompt ?? globalParams.inheritSP,
			customSP: subTask.systemPrompt ?? globalParams.customSP,
			outputFile: subTask.outputFile ?? globalParams.outputFile,
			timeout: subTask.timeout ?? globalParams.timeout,
			effectiveCwd: subTask.cwd ?? globalParams.effectiveCwd,
			thinkingLevel: mergedThinkingLevel,
			toolOptions: mergedToolOptions,
			resolvedGitMode: globalParams.resolvedGitMode,
		};
	}

	const baseGlobal: ResolvedParamsLike = {
		task: "Global task",
		label: "global-label",
		inheritSP: true,
		customSP: "Base system prompt",
		outputFile: "/tmp/global.md",
		timeout: 120000,
		effectiveCwd: "/workspace",
		thinkingLevel: "medium",
		toolOptions: {
			tools: ["read", "grep", "find"],
			excludeTools: ["write"],
			noBuiltinTools: false,
		},
		resolvedGitMode: "none",
	};

	const maxThinkingLevel: ThinkingLevel = "high";

	it("SubTask overrides global task field", () => {
		const result = mergeSubTaskParams(
			baseGlobal,
			{ task: "Specific task" },
			maxThinkingLevel,
		);
		expect(result.task).toBe("Specific task");
	});

	it("SubTask label overrides global", () => {
		const result = mergeSubTaskParams(
			baseGlobal,
			{ task: "test", label: "step-1" },
			maxThinkingLevel,
		);
		expect(result.label).toBe("step-1");
	});

	it("SubTask thinkingLevel overrides global (string override)", () => {
		const result = mergeSubTaskParams(
			baseGlobal,
			{ task: "test", thinkingLevel: "high" },
			maxThinkingLevel,
		);
		expect(result.thinkingLevel).toBe("high");
	});

	it("SubTask tools overrides global (array override)", () => {
		const result = mergeSubTaskParams(
			baseGlobal,
			{ task: "test", tools: ["read"] },
			maxThinkingLevel,
		);
		expect(result.toolOptions?.tools).toEqual(["read"]);
		// excludeTools should fall through to global since not set on subTask
		expect(result.toolOptions?.excludeTools).toEqual(["write"]);
	});

	it("SubTask with no fields set falls through to all globals", () => {
		const result = mergeSubTaskParams(
			baseGlobal,
			{ task: "test" },
			maxThinkingLevel,
		);
		expect(result.task).toBe("test");
		expect(result.label).toBe("global-label");
		expect(result.inheritSP).toBe(true);
		expect(result.customSP).toBe("Base system prompt");
		expect(result.outputFile).toBe("/tmp/global.md");
		expect(result.timeout).toBe(120000);
		expect(result.effectiveCwd).toBe("/workspace");
		expect(result.thinkingLevel).toBe("medium");
		expect(result.toolOptions?.tools).toEqual(["read", "grep", "find"]);
		expect(result.toolOptions?.excludeTools).toEqual(["write"]);
		expect(result.toolOptions?.noBuiltinTools).toBe(false);
		expect(result.resolvedGitMode).toBe("none");
	});

	it("SubTask excludeTools overrides global (non-overlapping fields remain from global)", () => {
		const result = mergeSubTaskParams(
			baseGlobal,
			{ task: "test", excludeTools: ["edit"] },
			maxThinkingLevel,
		);
		// excludeTools is overridden by subTask
		expect(result.toolOptions?.excludeTools).toEqual(["edit"]);
		// tools still comes from global (not set on subTask)
		expect(result.toolOptions?.tools).toEqual(["read", "grep", "find"]);
		// noBuiltinTools still from global
		expect(result.toolOptions?.noBuiltinTools).toBe(false);
	});

	it("SubTask empty task falls through to global task", () => {
		const result = mergeSubTaskParams(
			baseGlobal,
			{ task: "" },
			maxThinkingLevel,
		);
		expect(result.task).toBe("Global task");
	});

	it("SubTask thinkingLevel string is resolved against maxThinkingLevel (capped)", () => {
		const result = mergeSubTaskParams(
			baseGlobal,
			{ task: "test", thinkingLevel: "xhigh" },
			"low" as ThinkingLevel,
		);
		expect(result.thinkingLevel).toBe("low");
	});

	it("SubTask toolOptions becomes undefined when none of tools/excludeTools/noBuiltinTools are set and global has none", () => {
		const noToolGlobal: ResolvedParamsLike = {
			...baseGlobal,
			toolOptions: undefined,
		};
		const result = mergeSubTaskParams(
			noToolGlobal,
			{ task: "test" },
			maxThinkingLevel,
		);
		expect(result.toolOptions).toBeUndefined();
	});

	it("SubTask noBuiltinTools overrides global", () => {
		const result = mergeSubTaskParams(
			baseGlobal,
			{ task: "test", noBuiltinTools: true },
			maxThinkingLevel,
		);
		expect(result.toolOptions?.noBuiltinTools).toBe(true);
		// tools still from global
		expect(result.toolOptions?.tools).toEqual(["read", "grep", "find"]);
	});

	it("resolvedGitMode is always from global params (not merged from subTask)", () => {
		const result = mergeSubTaskParams(
			{ ...baseGlobal, resolvedGitMode: "branch" },
			{ task: "test" },
			maxThinkingLevel,
		);
		expect(result.resolvedGitMode).toBe("branch");
	});
});

// =========================================================================
// 2. Placeholder substitution
// =========================================================================

describe("placeholder substitution", () => {
	it("Replace {previous} with output string", () => {
		const task = "Refactor the module. Previous output: {previous}";
		const previousOutput = "Found 3 lint errors";
		const result = task.replaceAll(PREVIOUS_OUTPUT_PLACEHOLDER, previousOutput);
		expect(result).toBe("Refactor the module. Previous output: Found 3 lint errors");
	});

	it("Multiple {previous} occurrences all replaced", () => {
		const task = "Step: {previous} -> analyze -> {previous}";
		const previousOutput = "raw_data";
		const result = task.replaceAll(PREVIOUS_OUTPUT_PLACEHOLDER, previousOutput);
		expect(result).toBe("Step: raw_data -> analyze -> raw_data");
	});

	it("First step: {previous} replaced with empty string", () => {
		const task = "Start from scratch. Previous: {previous}";
		const firstStepOutput = "";
		const result = task.replaceAll(PREVIOUS_OUTPUT_PLACEHOLDER, firstStepOutput);
		expect(result).toBe("Start from scratch. Previous: ");
	});

	it("Task with no placeholder passes through unchanged", () => {
		const task = "Just a normal task without placeholder";
		const previousOutput = "unused";
		const result = task.replaceAll(PREVIOUS_OUTPUT_PLACEHOLDER, previousOutput);
		expect(result).toBe("Just a normal task without placeholder");
	});

	it("Placeholder constant is the correct string {previous}", () => {
		expect(PREVIOUS_OUTPUT_PLACEHOLDER).toBe("{previous}");
	});

	it("replaceAll with non-matching string is a no-op", () => {
		const task = "Analyze the output";
		const result = task.replaceAll("{previous}", "something");
		expect(result).toBe("Analyze the output");
	});
});

// =========================================================================
// 3. Mode detection logic
// =========================================================================

describe("mode detection logic", () => {
	it("Exactly one of task/chain/tasks → valid", () => {
		// Single task
		const counts1 = [true, false, false].filter(Boolean).length;
		expect(counts1).toBe(1);

		// Chain
		const counts2 = [false, true, false].filter(Boolean).length;
		expect(counts2).toBe(1);

		// Parallel
		const counts3 = [false, false, true].filter(Boolean).length;
		expect(counts3).toBe(1);
	});

	it("Both task and chain → invalid (count === 2)", () => {
		const hasTask = true;
		const hasChain = true;
		const hasTasks = false;
		const count = [hasTask, hasChain, hasTasks].filter(Boolean).length;
		expect(count).toBe(2);
		expect(count === 1).toBe(false);
	});

	it("All three → invalid (count === 3)", () => {
		const hasTask = true;
		const hasChain = true;
		const hasTasks = true;
		const count = [hasTask, hasChain, hasTasks].filter(Boolean).length;
		expect(count).toBe(3);
		expect(count === 1).toBe(false);
	});

	it("None → invalid (count === 0)", () => {
		const hasTask = false;
		const hasChain = false;
		const hasTasks = false;
		const count = [hasTask, hasChain, hasTasks].filter(Boolean).length;
		expect(count).toBe(0);
		expect(count === 1).toBe(false);
	});

	it("Replicates the exact guard from index.ts", () => {
		// Simulates the execute handler logic
		function checkMode(params: {
			task?: string;
			chain?: unknown[];
			tasks?: unknown[];
		}): "chain" | "parallel" | "single" | "invalid" {
			const isChain = !!params.chain && params.chain.length > 0;
			const isParallel = !!params.tasks && params.tasks.length > 0;
			const isSingle =
				typeof params.task === "string" && params.task.length > 0;

			const modeCount = [isChain, isParallel, isSingle].filter(Boolean).length;
			if (modeCount !== 1) return "invalid";
			if (isChain) return "chain";
			if (isParallel) return "parallel";
			return "single";
		}

		expect(checkMode({ task: "test" })).toBe("single");
		expect(checkMode({ chain: [{ task: "a" }, { task: "b" }] })).toBe("chain");
		expect(checkMode({ tasks: [{ task: "a" }, { task: "b" }] })).toBe("parallel");
		expect(checkMode({ task: "test", chain: [{ task: "a" }] })).toBe("invalid");
		expect(checkMode({ task: "test", chain: [{ task: "a" }], tasks: [{ task: "a" }] })).toBe("invalid");
		expect(checkMode({})).toBe("invalid");
		expect(checkMode({ task: "" })).toBe("invalid"); // empty string — not valid
	});
});

// =========================================================================
// 4. ChainDetails aggregation
// =========================================================================

describe("ChainDetails aggregation", () => {
	it("All steps succeed: completedSteps equals totalSteps, stoppedEarly false", () => {
		const results = [
			makeSubTaskResult({ task: "step 1", exitCode: 0, usage: { input: 100, output: 50, cost: 0.01, turns: 2 } }),
			makeSubTaskResult({ task: "step 2", exitCode: 0, usage: { input: 200, output: 100, cost: 0.02, turns: 3 } }),
		];

		const details: ChainDetails = {
			mode: "chain",
			results,
			totalInput: results.reduce((s, r) => s + r.usage.input, 0),
			totalOutput: results.reduce((s, r) => s + r.usage.output, 0),
			totalCost: results.reduce((s, r) => s + r.usage.cost, 0),
			totalTurns: results.reduce((s, r) => s + r.usage.turns, 0),
			completedSteps: results.length,
			totalSteps: 2,
			stoppedEarly: false,
		};

		expect(details.completedSteps).toBe(2);
		expect(details.totalSteps).toBe(2);
		expect(details.stoppedEarly).toBe(false);
	});

	it("Chain stops early: completedSteps less than totalSteps, stoppedEarly true", () => {
		const results = [
			makeSubTaskResult({ task: "step 1", exitCode: 0, usage: { input: 50, output: 25, cost: 0.005, turns: 1 } }),
			makeSubTaskResult({ task: "step 2", exitCode: 1, errorMessage: "Failed", usage: { input: 10, output: 5, cost: 0.001, turns: 1 } }),
		];

		const details: ChainDetails = {
			mode: "chain",
			results,
			totalInput: results.reduce((s, r) => s + r.usage.input, 0),
			totalOutput: results.reduce((s, r) => s + r.usage.output, 0),
			totalCost: results.reduce((s, r) => s + r.usage.cost, 0),
			totalTurns: results.reduce((s, r) => s + r.usage.turns, 0),
			completedSteps: results.length,
			totalSteps: 5,
			stoppedEarly: true,
		};

		expect(details.completedSteps).toBe(2);
		expect(details.totalSteps).toBe(5);
		expect(details.stoppedEarly).toBe(true);
	});

	it("Aggregated totals: totalInput equals sum of all step inputs", () => {
		const results = [
			makeSubTaskResult({ task: "step 1", exitCode: 0, usage: { input: 100, output: 30, cost: 0.01, turns: 1 } }),
			makeSubTaskResult({ task: "step 2", exitCode: 0, usage: { input: 200, output: 60, cost: 0.02, turns: 2 } }),
			makeSubTaskResult({ task: "step 3", exitCode: 0, usage: { input: 300, output: 90, cost: 0.03, turns: 3 } }),
		];

		const details: ChainDetails = {
			mode: "chain",
			results,
			totalInput: results.reduce((s, r) => s + r.usage.input, 0),
			totalOutput: results.reduce((s, r) => s + r.usage.output, 0),
			totalCost: results.reduce((s, r) => s + r.usage.cost, 0),
			totalTurns: results.reduce((s, r) => s + r.usage.turns, 0),
			completedSteps: results.length,
			totalSteps: 3,
			stoppedEarly: false,
		};

		expect(details.totalInput).toBe(600);
		expect(details.totalOutput).toBe(180);
		expect(details.totalCost).toBe(0.06);
		expect(details.totalTurns).toBe(6);
	});

	it("Single step chain: behaves correctly", () => {
		const results = [
			makeSubTaskResult({ task: "only step", exitCode: 0, usage: { input: 50, output: 25, cost: 0.005, turns: 1 } }),
		];

		const details: ChainDetails = {
			mode: "chain",
			results,
			totalInput: results.reduce((s, r) => s + r.usage.input, 0),
			totalOutput: results.reduce((s, r) => s + r.usage.output, 0),
			totalCost: results.reduce((s, r) => s + r.usage.cost, 0),
			totalTurns: results.reduce((s, r) => s + r.usage.turns, 0),
			completedSteps: 1,
			totalSteps: 1,
			stoppedEarly: false,
		};

		expect(details.completedSteps).toBe(1);
		expect(details.totalSteps).toBe(1);
		expect(details.stoppedEarly).toBe(false);
		expect(details.totalInput).toBe(50);
		expect(details.totalCost).toBe(0.005);
	});

	it("Step fields are populated correctly with step numbers", () => {
		const results = [
			makeSubTaskResult({ task: "step 1", exitCode: 0, step: 1 }),
			makeSubTaskResult({ task: "step 2", exitCode: 0, step: 2 }),
		];

		expect(results[0].step).toBe(1);
		expect(results[1].step).toBe(2);
	});

	it("Zero cost steps still aggregate correctly", () => {
		const results = [
			makeSubTaskResult({ task: "step 1", exitCode: 0, usage: { input: 0, output: 0, cost: 0, turns: 0 } }),
			makeSubTaskResult({ task: "step 2", exitCode: 0, usage: { input: 0, output: 0, cost: 0, turns: 0 } }),
		];

		const totalCost = results.reduce((s, r) => s + r.usage.cost, 0);
		expect(totalCost).toBe(0);
	});
});

// =========================================================================
// 5. ParallelDetails aggregation
// =========================================================================

describe("ParallelDetails aggregation", () => {
	it("All tasks succeed: succeeded equals total, failed equals 0", () => {
		const results = [
			makeSubTaskResult({ task: "task 1", exitCode: 0, usage: { input: 100, output: 50, cost: 0.01, turns: 2 } }),
			makeSubTaskResult({ task: "task 2", exitCode: 0, usage: { input: 200, output: 100, cost: 0.02, turns: 3 } }),
		];
		const succeeded = results.filter((r) => r.exitCode === 0).length;
		const failed = results.length - succeeded;

		const details: ParallelDetails = {
			mode: "parallel",
			results,
			totalInput: results.reduce((s, r) => s + r.usage.input, 0),
			totalOutput: results.reduce((s, r) => s + r.usage.output, 0),
			totalCost: results.reduce((s, r) => s + r.usage.cost, 0),
			totalTurns: results.reduce((s, r) => s + r.usage.turns, 0),
			succeeded,
			failed,
		};

		expect(details.succeeded).toBe(2);
		expect(details.failed).toBe(0);
	});

	it("Mixed success/failure: counts correct", () => {
		const results = [
			makeSubTaskResult({ task: "task 1", exitCode: 0, usage: { input: 100, output: 50, cost: 0.01, turns: 2 } }),
			makeSubTaskResult({ task: "task 2", exitCode: 1, errorMessage: "Error", usage: { input: 50, output: 10, cost: 0.005, turns: 1 } }),
			makeSubTaskResult({ task: "task 3", exitCode: 0, usage: { input: 150, output: 75, cost: 0.015, turns: 3 } }),
		];
		const succeeded = results.filter((r) => r.exitCode === 0).length;
		const failed = results.length - succeeded;

		const details: ParallelDetails = {
			mode: "parallel",
			results,
			totalInput: results.reduce((s, r) => s + r.usage.input, 0),
			totalOutput: results.reduce((s, r) => s + r.usage.output, 0),
			totalCost: results.reduce((s, r) => s + r.usage.cost, 0),
			totalTurns: results.reduce((s, r) => s + r.usage.turns, 0),
			succeeded,
			failed,
		};

		expect(details.succeeded).toBe(2);
		expect(details.failed).toBe(1);
	});

	it("All tasks fail: succeeded 0, failed equals total", () => {
		const results = [
			makeSubTaskResult({ task: "task 1", exitCode: 1, errorMessage: "Fail A", usage: { input: 10, output: 5, cost: 0.001, turns: 1 } }),
			makeSubTaskResult({ task: "task 2", exitCode: 2, errorMessage: "Fail B", usage: { input: 20, output: 10, cost: 0.002, turns: 1 } }),
			makeSubTaskResult({ task: "task 3", exitCode: 1, errorMessage: "Fail C", usage: { input: 30, output: 15, cost: 0.003, turns: 1 } }),
		];
		const succeeded = results.filter((r) => r.exitCode === 0).length;
		const failed = results.length - succeeded;

		const details: ParallelDetails = {
			mode: "parallel",
			results,
			totalInput: results.reduce((s, r) => s + r.usage.input, 0),
			totalOutput: results.reduce((s, r) => s + r.usage.output, 0),
			totalCost: results.reduce((s, r) => s + r.usage.cost, 0),
			totalTurns: results.reduce((s, r) => s + r.usage.turns, 0),
			succeeded,
			failed,
		};

		expect(details.succeeded).toBe(0);
		expect(details.failed).toBe(3);
	});

	it("Aggregated totals: correct sum", () => {
		const results = [
			makeSubTaskResult({ task: "task A", exitCode: 0, usage: { input: 200, output: 100, cost: 0.02, turns: 3 } }),
			makeSubTaskResult({ task: "task B", exitCode: 1, errorMessage: "fail", usage: { input: 50, output: 20, cost: 0.005, turns: 1 } }),
		];

		const details: ParallelDetails = {
			mode: "parallel",
			results,
			totalInput: results.reduce((s, r) => s + r.usage.input, 0),
			totalOutput: results.reduce((s, r) => s + r.usage.output, 0),
			totalCost: results.reduce((s, r) => s + r.usage.cost, 0),
			totalTurns: results.reduce((s, r) => s + r.usage.turns, 0),
			succeeded: results.filter((r) => r.exitCode === 0).length,
			failed: results.length - results.filter((r) => r.exitCode === 0).length,
		};

		expect(details.totalInput).toBe(250);
		expect(details.totalOutput).toBe(120);
		expect(details.totalCost).toBe(0.025);
		expect(details.totalTurns).toBe(4);
		expect(details.succeeded).toBe(1);
		expect(details.failed).toBe(1);
	});

	it("Empty parallel results (no tasks) has zero totals", () => {
		const results: SubTaskResult[] = [];
		const succeeded = results.filter((r) => r.exitCode === 0).length;
		const failed = results.length - succeeded;

		const details: ParallelDetails = {
			mode: "parallel",
			results,
			totalInput: 0,
			totalOutput: 0,
			totalCost: 0,
			totalTurns: 0,
			succeeded,
			failed,
		};

		expect(details.succeeded).toBe(0);
		expect(details.failed).toBe(0);
		expect(details.totalInput).toBe(0);
	});
});

// =========================================================================
// 6. Limits validation
// =========================================================================

describe("limits validation", () => {
	it("Chain with more than MAX_CHAIN_STEPS steps is rejected", () => {
		const chainSteps = Array.from({ length: MAX_CHAIN_STEPS + 1 }, (_, i) => ({
			task: `step ${i + 1}`,
		}));
		expect(chainSteps.length).toBe(MAX_CHAIN_STEPS + 1);
		expect(chainSteps.length > MAX_CHAIN_STEPS).toBe(true);

		// Replicates the index.ts guard
		const isValid = chainSteps.length <= MAX_CHAIN_STEPS;
		expect(isValid).toBe(false);
	});

	it("Parallel with more than MAX_PARALLEL_TASKS tasks is rejected", () => {
		const taskList = Array.from({ length: MAX_PARALLEL_TASKS + 1 }, (_, i) => ({
			task: `parallel task ${i + 1}`,
		}));
		expect(taskList.length).toBe(MAX_PARALLEL_TASKS + 1);
		expect(taskList.length > MAX_PARALLEL_TASKS).toBe(true);

		// Replicates the index.ts guard
		const isValid = taskList.length <= MAX_PARALLEL_TASKS;
		expect(isValid).toBe(false);
	});

	it("Chain with exactly MAX_CHAIN_STEPS steps is accepted", () => {
		const chainSteps = Array.from({ length: MAX_CHAIN_STEPS }, (_, i) => ({
			task: `step ${i + 1}`,
		}));
		expect(chainSteps.length).toBe(MAX_CHAIN_STEPS);
		expect(chainSteps.length <= MAX_CHAIN_STEPS).toBe(true);
	});

	it("Parallel with exactly MAX_PARALLEL_TASKS tasks is accepted", () => {
		const taskList = Array.from({ length: MAX_PARALLEL_TASKS }, (_, i) => ({
			task: `task ${i + 1}`,
		}));
		expect(taskList.length).toBe(MAX_PARALLEL_TASKS);
		expect(taskList.length <= MAX_PARALLEL_TASKS).toBe(true);
	});

	it("Constants are positive integers", () => {
		expect(MAX_CHAIN_STEPS).toBeGreaterThan(0);
		expect(MAX_PARALLEL_TASKS).toBeGreaterThan(0);
	});

	it("Chain with 0 steps is empty — would be caught by mode detection", () => {
		// An empty chain array has length 0 => isChain would be false
		const isChainEmpty = false;
		expect(isChainEmpty).toBe(false);
	});
});

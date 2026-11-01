// Purpose: Pin the rendered bytes of the chain / parallel / graph renderers and the
// delegate_task call previews (duplication sweep #378, D10) BEFORE collapsing their
// shared shapes into helpers. Presentation-only refactor: any snapshot change is a
// regression, not an accepted output change.
import { describe, expect, it } from "vitest";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { renderDelegateCall, renderDelegateResult } from "../tui";
import { EMPTY_USAGE, type ChainDetails, type DelegateTaskDetails, type GraphDetails, type ParallelDetails, type SubTaskResult } from "../types";

const WIDTH = 120;

// A theme that tags every colour application, so the goldens pin the colour
// vocabulary as well as the visible text ("byte-identical" includes styling).
const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `**${text}**`,
} as unknown as Theme;

const collapsed: ToolRenderResultOptions = { expanded: false, isPartial: false };
const expanded: ToolRenderResultOptions = { expanded: true, isPartial: false };

const DIFF = [
	"diff --git a/src/alpha.ts b/src/alpha.ts",
	"index abc123..def456 100644",
	"--- a/src/alpha.ts",
	"+++ b/src/alpha.ts",
	"@@ -1,3 +1,4 @@",
	" const a = 1;",
	"+const b = 2;",
	"-const c = 3;",
	" const d = 4;",
].join("\n");

let seq = 0;
function result(overrides: Partial<SubTaskResult> = {}): SubTaskResult {
	seq += 1;
	return {
		task: `task ${seq}`,
		exitCode: 0,
		messages: [],
		stderr: "",
		usage: { ...EMPTY_USAGE },
		...overrides,
	};
}

const assistant = (text: string) => [
	{ role: "assistant", content: [{ type: "text", text }] },
];

const usage = { input: 100, output: 50, cacheRead: 5, cacheWrite: 2, cost: 0.0123, contextTokens: 1234, turns: 2 };

function chainDetails(): ChainDetails {
	return {
		mode: "chain",
		results: [
			result({
				step: 1,
				label: "plan",
				model: "test/model-a",
				task: "Plan the change",
				messages: assistant("Plan written.\nSecond line.\nThird line."),
				usage,
				gitDiff: DIFF,
			}),
			result({
				step: 2,
				label: "build",
				exitCode: 1,
				stopReason: "error",
				errorMessage: "boom in build",
				task: "Build the change",
				messages: [],
				usage: { ...EMPTY_USAGE, turns: 1 },
			}),
			result({
				step: 3,
				task: "Verify the change",
				messages: assistant("Verification skipped."),
				usage: { ...EMPTY_USAGE, turns: 0 },
			}),
		],
		totalInput: 200,
		totalOutput: 80,
		totalCost: 0.02,
		totalTurns: 3,
		completedSteps: 2,
		totalSteps: 3,
		stoppedEarly: true,
	};
}

function parallelDetails(): ParallelDetails {
	return {
		mode: "parallel",
		results: [
			result({
				label: "docs",
				model: "test/model-b",
				task: "Update docs",
				messages: assistant("Docs updated."),
				usage,
				gitDiff: DIFF,
			}),
			result({
				task: "Run tests",
				exitCode: 1,
				stopReason: "error",
				errorMessage: "tests failed",
				messages: [],
				usage: { ...EMPTY_USAGE, turns: 1 },
			}),
		],
		totalInput: 150,
		totalOutput: 60,
		totalCost: 0.01,
		totalTurns: 2,
		succeeded: 1,
		failed: 1,
	};
}

function graphDetails(): GraphDetails {
	const wave = (waveIndex: number, parallel: boolean, tasks: SubTaskResult[]) => ({ waveIndex, parallel, tasks });
	return {
		mode: "graph",
		waves: [
			wave(1, true, [
				result({
					id: "a",
					label: "alpha",
					model: "test/model-c",
					task: "Alpha node",
					messages: assistant("Alpha done."),
					usage,
					gitDiff: DIFF,
				} as Partial<SubTaskResult>),
				result({ label: "beta", task: "Beta node", messages: assistant("Beta done.") }),
			]),
			wave(2, false, [
				result({
					label: "gamma",
					task: "Gamma node",
					exitCode: 1,
					stopReason: "error",
					errorMessage: "gamma failed",
					messages: [],
				}),
			]),
			wave(3, true, [result({ task: "Delta node", messages: assistant("Delta done.") })]),
			wave(4, false, [result({ label: "epsilon", task: "Epsilon node" })]),
		],
		totalInput: 400,
		totalOutput: 160,
		totalCost: 0.04,
		totalTurns: 6,
	};
}

function render(details: DelegateTaskDetails, options: ToolRenderResultOptions): string {
	const node = renderDelegateResult({ content: [], details } as AgentToolResult<DelegateTaskDetails>, options, theme);
	return node.render(WIDTH).join("\n");
}

function renderCall(args: Parameters<typeof renderDelegateCall>[0]): string {
	return renderDelegateCall(args, theme).render(WIDTH).join("\n");
}

describe("chain renderer goldens (issue #378)", () => {
	it("collapsed", () => {
		expect(render(chainDetails(), collapsed)).toMatchSnapshot();
	});
	it("expanded", () => {
		expect(render(chainDetails(), expanded)).toMatchSnapshot();
	});
});

describe("parallel renderer goldens (issue #378)", () => {
	it("collapsed", () => {
		expect(render(parallelDetails(), collapsed)).toMatchSnapshot();
	});
	it("expanded", () => {
		expect(render(parallelDetails(), expanded)).toMatchSnapshot();
	});
});

describe("graph renderer goldens (issue #378)", () => {
	it("collapsed", () => {
		expect(render(graphDetails(), collapsed)).toMatchSnapshot();
	});
	it("expanded", () => {
		expect(render(graphDetails(), expanded)).toMatchSnapshot();
	});
});

describe("delegate_task call preview goldens (issue #378)", () => {
	it("chain preview (>3 steps, labelled and unlabelled)", () => {
		expect(
			renderCall({
				chain: [
					{ task: "step one", label: "one" },
					{ task: "step two without label" },
					{ task: "step three", label: "three" },
					{ task: "step four", label: "four" },
					{ task: "step five" },
				],
			}),
		).toMatchSnapshot();
	});

	it("parallel preview", () => {
		expect(
			renderCall({
				tasks: [
					{ task: "parallel one", label: "p1" },
					{ task: "parallel two without label" },
				],
			}),
		).toMatchSnapshot();
	});

	it("graph preview (>3 tasks with dependencies)", () => {
		expect(
			renderCall({
				graph: [
					{ id: "a", task: "A", label: "alpha" },
					{ id: "b", task: "B", dependsOn: ["a"] },
					{ id: "c", task: "C", label: "gamma", dependsOn: ["a", "b"] },
					{ id: "d", task: "D" },
				],
			}),
		).toMatchSnapshot();
	});
});

/**
 * runModePrologue + resolveModeModel — the batch prologue and its model tail
 * (#379 commit 4).
 *
 * The handler suite (`mode-prologue.test.ts`) pins the ORDER against the real
 * handlers; these are the helpers' own contracts, driven directly with a fake
 * session: each gate trips in isolation with its verbatim rejection, the
 * `beforeCost` hook runs before the cost gate, and the model tail rejects an
 * empty resolution / open circuit after resolving preset + per-call overrides.
 */

import { afterEach, describe, expect, it, vi } from "vitest";

/** Gate invocation order + the cost gate's unit count, recorded across mocks. */
const log = vi.hoisted(() => ({ calls: [] as string[], costUnits: 0, preflightFails: false }));

vi.mock("../prelude", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../prelude")>();
	return {
		...actual,
		gateSessionCost: (input: Parameters<typeof actual.gateSessionCost>[0]) => {
			log.calls.push("cost");
			log.costUnits = input.units;
			return actual.gateSessionCost(input);
		},
		validateDelegationTargets: (input: Parameters<typeof actual.validateDelegationTargets>[0]) => {
			log.calls.push("targets");
			return actual.validateDelegationTargets(input);
		},
		runPreTaskValidation: (input: Parameters<typeof actual.runPreTaskValidation>[0]) => {
			log.calls.push("h1");
			return actual.runPreTaskValidation(input);
		},
	};
});

vi.mock("../sanitize", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../sanitize")>();
	return {
		...actual,
		getCurrentDepth: () => {
			log.calls.push("depth");
			return actual.getCurrentDepth();
		},
	};
});

vi.mock("../preflight", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../preflight")>();
	return {
		...actual,
		preflightCheck: (cwd: Parameters<typeof actual.preflightCheck>[0]) => {
			log.calls.push("preflight");
			return log.preflightFails
				? { ok: false as const, error: "pi binary not found" }
				: actual.preflightCheck(cwd);
		},
	};
});

import { runModePrologue, type ModePrologueInput } from "../mode-prologue";
import { resolveModeModel } from "../prelude";
import type { Logger } from "../logging";
import type { SessionState } from "../state";

function fakeLog(): Logger {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

const MODEL = { provider: "test", id: "test-model" };

function fakeCtx(options: { model?: { provider: string; id: string } | undefined } = {}) {
	return {
		cwd: process.cwd(),
		model: "model" in options ? options.model : MODEL,
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
			hasConfiguredAuth: () => true,
		},
	} as unknown as ModePrologueInput["ctx"];
}

function fakeState(options: {
	maxSubagentDepth?: number;
	costExceeded?: boolean;
	circuitOpen?: boolean;
	model?: { provider: string; id: string };
} = {}): SessionState {
	return {
		config: {
			perTaskCostEstimate: 0.05,
			sessionCostLimit: 1,
			maxSubagentDepth: options.maxSubagentDepth ?? 3,
			maxThinkingLevel: "medium",
			approvalMode: "auto",
			gitMode: "none",
			model: options.model,
		},
		builtinPresets: [],
		customPresets: [],
		checkCostLimit: () => options.costExceeded ?? false,
		getSessionTotalCost: () => 0.5,
		checkCircuit: () => ({
			isOpen: options.circuitOpen ?? false,
			message: options.circuitOpen ? "Circuit breaker is open" : undefined,
		}),
	} as unknown as SessionState;
}

function prologue(overrides: Partial<ModePrologueInput> = {}): ModePrologueInput {
	return {
		params: {},
		state: fakeState(),
		ctx: fakeCtx(),
		log: fakeLog(),
		label: "Chain",
		units: 3,
		...overrides,
	};
}

afterEach(() => {
	log.calls = [];
	log.costUnits = 0;
	log.preflightFails = false;
	delete process.env.BRL_SUBAGENT_DEPTH;
});

describe("runModePrologue", () => {
	it("runs cost → depth → resolve → targets → preflight → H1 and returns the resolved dispatch", () => {
		const result = runModePrologue(prologue());
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(log.calls).toEqual(["cost", "depth", "targets", "preflight", "h1"]);
		expect(result.globalParams.task).toBe("");
		expect(result.resolvedCwd).toBe(process.cwd());
		expect(result.currentDepth).toBe(0);
		// IN2: the cost estimate is perTaskEstimate × the unit count.
		expect(log.costUnits).toBe(3);
	});

	it("runs the graph pre-cost hook before the cost gate and lets its rejection win", () => {
		const rejected = runModePrologue(
			prologue({
				label: "Graph",
				beforeCost: () => {
					log.calls.push("dag");
					return { content: [{ type: "text" as const, text: "Graph validation failed" }], details: undefined, isError: true };
				},
			}),
		);
		expect(rejected.ok).toBe(false);
		if (rejected.ok) return;
		expect(rejected.error.content[0].text).toBe("Graph validation failed");
		expect(log.calls).toEqual(["dag"]);

		log.calls = [];
		const passed = runModePrologue(prologue({ label: "Graph", beforeCost: () => { log.calls.push("dag"); } }));
		expect(passed.ok).toBe(true);
		expect(log.calls).toEqual(["dag", "cost", "depth", "targets", "preflight", "h1"]);
	});

	it("rejects at the cost gate with the label-derived message", () => {
		const result = runModePrologue(prologue({ state: fakeState({ costExceeded: true }) }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.content[0].text).toContain("Cannot delegate: session cost limit reached");
		expect(log.calls).toEqual(["cost"]);
	});

	it("rejects at the depth gate with the shared wording", () => {
		const result = runModePrologue(prologue({ state: fakeState({ maxSubagentDepth: 0 }) }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.content[0].text).toContain("Cannot delegate further: subagent recursion depth limit reached (depth 0/0)");
		expect(log.calls).toEqual(["cost", "depth"]);
	});

	it("rejects an invalid cwd before preflight and H1", () => {
		const result = runModePrologue(prologue({ params: { cwd: "/nonexistent/brl-379-unit" } }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.content[0].text).toContain("Invalid cwd:");
		expect(log.calls).toEqual(["cost", "depth", "targets"]);
	});

	it("rejects a failed pre-flight check before H1", () => {
		log.preflightFails = true;
		const result = runModePrologue(prologue());
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.content[0].text).toBe("Pre-flight check failed: pi binary not found");
		expect(log.calls).toEqual(["cost", "depth", "targets", "preflight"]);
	});

	it("rejects a mode-level H1 conflict after every earlier gate", () => {
		const result = runModePrologue(prologue({ params: { outputFile: "out.md", tools: ["read"] } }));
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.content[0].text).toContain("outputFile is set but the 'write' tool is not available");
		expect(log.calls).toEqual(["cost", "depth", "targets", "preflight", "h1"]);
	});
});

describe("resolveModeModel", () => {
	it("returns the resolved model and its provider/id string", () => {
		const result = resolveModeModel({ state: fakeState(), ctx: fakeCtx(), log: fakeLog(), preset: undefined });
		expect(result).toEqual({ ok: true, model: MODEL, modelStr: "test/test-model" });
	});

	it("lets a per-call override beat the preset model", () => {
		const state = fakeState({ model: { provider: "config", id: "cfg" } });
		const ctx = fakeCtx();
		const preset = { name: "p", model: "preset/p" } as Parameters<typeof resolveModeModel>[0]["preset"];
		const result = resolveModeModel({ state, ctx, log: fakeLog(), preset, perCallModel: "call/per" });
		expect(result.ok && result.modelStr).toBe("call/per");
	});

	it("rejects an empty provider/id resolution", () => {
		const result = resolveModeModel({
			state: fakeState(),
			ctx: fakeCtx({ model: { provider: "", id: "" } }),
			log: fakeLog(),
			preset: undefined,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.content[0].text).toContain("Subagent model is not configured");
	});

	it("rejects an open circuit only after model resolution", () => {
		const result = resolveModeModel({
			state: fakeState({ circuitOpen: true }),
			ctx: fakeCtx(),
			log: fakeLog(),
			preset: undefined,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.content[0].text).toBe("Circuit breaker is open");
	});

	it("reports no available model when nothing resolves", () => {
		const result = resolveModeModel({
			state: fakeState(),
			ctx: fakeCtx({ model: undefined }),
			log: fakeLog(),
			preset: undefined,
		});
		expect(result.ok).toBe(false);
		if (result.ok) return;
		expect(result.error.content[0].text).toContain("No model available");
	});
});

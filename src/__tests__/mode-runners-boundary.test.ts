/**
 * ADR 0027 D1/D3 (cycle S2) — the runtime context is per-invocation state, and
 * the runner factory is a pure view over it.
 *
 * What this pins, and why it is not a compile-level assertion: `tsconfig.json`
 * excludes `src/__tests__`, so a type-only expectation here would never be
 * checked. The factory's signature is therefore pinned where it is USED
 * (`src/index.ts` destructures five names; a drift is a compile error there).
 * These tests pin the two runtime properties a type cannot express:
 *
 *   - D1: `createRuntime` allocates its store per call. Two invocations in one
 *     process must not share a `SessionState` — the mutant this kills is a
 *     module-level singleton, which would make two loaded sessions share
 *     counters, config and the live map.
 *   - D3: `createModeRunners` hands back exactly the five functions the
 *     composition root consumes and nothing else. The two record mappings stay
 *     private, so a call site cannot reach around the factory.
 */

import { describe, expect, it } from "vitest";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createModeRunners } from "../mode-runners";
import { createRuntime } from "../runtime";

/** Neither factory reads from pi, so an identity stub is the whole fake. */
function fakePi(): ExtensionAPI {
	return {} as ExtensionAPI;
}

describe("the runtime context is per-invocation state (ADR 0027 D1)", () => {
	it("keeps the pi identity it was given, and builds a log and a store", () => {
		const pi = fakePi();
		const rt = createRuntime(pi);

		expect(rt.pi).toBe(pi);
		expect(rt.log).toBeDefined();
		expect(rt.state).toBeDefined();
	});

	it("two invocations get two independent stores", () => {
		// The mutant: a module-level `state`, which makes the second assertion
		// read the first invocation's mutation.
		const first = createRuntime(fakePi());
		const second = createRuntime(fakePi());

		first.state.config.maxThinkingLevel = "xhigh";
		first.state.activeSubagents = 3;

		expect(first.state).not.toBe(second.state);
		expect(second.state.config.maxThinkingLevel).not.toBe("xhigh");
		expect(second.state.activeSubagents).toBe(0);
	});
});

describe("the runner factory's interface is its return value (ADR 0027 D3)", () => {
	it("returns the five functions the composition root consumes, and only those", () => {
		const runners = createModeRunners(createRuntime(fakePi()));

		expect(Object.keys(runners).sort()).toEqual([
			"applyUnitShapeGuard",
			"resolveStepModel",
			"runChainMode",
			"runGraphMode",
			"runParallelMode",
		]);
		for (const runner of Object.values(runners)) expect(typeof runner).toBe("function");
	});
});

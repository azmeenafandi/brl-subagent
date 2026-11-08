/**
 * Unit tests for src/unit-params.ts — the per-unit merge and the unit display
 * name (ADR 0027 S1).
 *
 * These replace the two substitutes the closure forced: the hand-maintained
 * replica in chain-parallel.test.ts (now an import of the real function) and
 * the source-text ratchet in integration.test.ts (deleted). A regex over
 * index.ts could only say the `||` was still SPELLED; this file says what the
 * merge DOES, one behaviour per group, with the mutant each one kills named at
 * the test that kills it.
 *
 * The six groups are the six silent-drift classes the merge owns:
 *
 *   1. the `task` fallback (`||`, so `""` falls back like an absent task);
 *   2. inherit-vs-override per field, and `model`, which is NEVER inherited;
 *   3. tools: replaced not unioned, `noBuiltinTools: false` surviving an
 *      inherited `true` (`??`, not `||`), and the `edit ⇒ write` rule;
 *   4. `priority`: only the four schema values survive;
 *   5. thinking: resolved against the cap only when the unit declares a level,
 *      otherwise the global value VERBATIM (no cap applied);
 *   6. display: `label` wins even when it is `""` (`??`, not `||`), then the
 *      60-char boundary.
 */

import { describe, expect, it } from "vitest";
import { displayTaskName, mergeSubTaskParams } from "../unit-params";
import type {
	ApprovalMode,
	GitMode,
	Priority,
	ResolvedParams,
	SubTaskParams,
	SubagentToolOptions,
	ThinkingLevel,
} from "../types";

/**
 * The global side of a merge: the resolver's `ResolvedParams` plus the two
 * resolved modes — exactly `mergeSubTaskParams`' first parameter. Declared via
 * `Parameters` rather than restated, so the fixtures cannot drift from the
 * signature they are feeding.
 */
type GlobalParams = Parameters<typeof mergeSubTaskParams>[0];

/** A global fixture with no unit declared, so every assertion is about ONE override. */
function globalOf(overrides: Partial<GlobalParams> = {}): GlobalParams {
	return {
		task: "Global task",
		label: undefined,
		inheritSP: true,
		customSP: "Global system prompt",
		outputFile: "/tmp/global.md",
		timeout: 120_000,
		effectiveCwd: "/workspace",
		thinkingLevel: "medium",
		toolOptions: undefined,
		autoRoutedPreset: undefined,
		resolvedGitMode: "none" satisfies GitMode,
		resolvedApprovalMode: "auto" satisfies ApprovalMode,
		...overrides,
	};
}

const CAP: ThinkingLevel = "high";

describe("1. the task fallback is `||`, not `??`", () => {
	it("a declared task wins", () => {
		const merged = mergeSubTaskParams(globalOf(), { task: "Unit task" }, CAP);
		expect(merged.task).toBe("Unit task");
	});

	it("an empty task falls back to the global task", () => {
		// Mutant killed: `subTask.task ?? globalParams.task` — `""` is not
		// nullish, so it would pass straight through and the mode-level task
		// would be silently dropped (issue #379).
		const merged = mergeSubTaskParams(globalOf(), { task: "" }, CAP);
		expect(merged.task).toBe("Global task");
	});

	it("a malformed unit (task absent at runtime) falls back too", () => {
		// The schema requires `task`, but the merge is the last thing between a
		// hand-written chain step and a spawn — a unit that reaches it without a
		// task must still run the mode-level one instead of `undefined`.
		const merged = mergeSubTaskParams(globalOf(), {} as SubTaskParams, CAP);
		expect(merged.task).toBe("Global task");
	});
});

describe("2. fields inherit from the global side unless the unit overrides them", () => {
	it("a unit declaring nothing inherits every inheritable field", () => {
		const merged = mergeSubTaskParams(globalOf(), { task: "t" }, CAP);
		expect(merged.label).toBeUndefined();
		expect(merged.inheritSP).toBe(true);
		expect(merged.customSP).toBe("Global system prompt");
		expect(merged.outputFile).toBe("/tmp/global.md");
		expect(merged.timeout).toBe(120_000);
		expect(merged.effectiveCwd).toBe("/workspace");
	});

	it("a unit overrides label, systemPrompt, inheritSystemPrompt, outputFile, timeout and cwd", () => {
		const merged = mergeSubTaskParams(
			globalOf({ label: "global-label" }),
			{
				task: "t",
				label: "unit-label",
				systemPrompt: "Unit system prompt",
				inheritSystemPrompt: false,
				outputFile: "/tmp/unit.md",
				timeout: 5_000,
				cwd: "/workspace/unit",
			},
			CAP,
		);
		expect(merged.label).toBe("unit-label");
		expect(merged.customSP).toBe("Unit system prompt");
		expect(merged.inheritSP).toBe(false);
		expect(merged.outputFile).toBe("/tmp/unit.md");
		expect(merged.timeout).toBe(5_000);
		expect(merged.effectiveCwd).toBe("/workspace/unit");
	});

	it("an absent unit model is `undefined` — the model is never inherited", () => {
		// `model` is `subTask.model`, full stop. A "symmetric" merge
		// (`subTask.model ?? global) would let a mode-level model silently
		// override the resolved one, which the per-step model path (issue #222)
		// then validates against a registry it was never chosen from.
		//
		// The fixture carries a `model` the type does not declare: a merge that
		// grows an inheritance arm must fail HERE, not only once the extra field
		// is typed.
		const globalWithModel = { ...globalOf(), model: "anthropic/claude-opus-4-6" };
		const merged = mergeSubTaskParams(globalWithModel, { task: "t" }, CAP);
		expect(merged.model).toBeUndefined();
	});

	it("a declared unit model is carried through verbatim", () => {
		const merged = mergeSubTaskParams(
			globalOf(),
			{ task: "t", model: "anthropic/claude-sonnet-4-5" },
			CAP,
		);
		expect(merged.model).toBe("anthropic/claude-sonnet-4-5");
	});
});

describe("3. tools are replaced, not unioned", () => {
	const globalTools: SubagentToolOptions = {
		tools: ["read", "grep", "find"],
		excludeTools: ["bash"],
		noBuiltinTools: true,
	};

	it("a unit `tools` list REPLACES the global one", () => {
		// Mutant killed: a union (`[...global, ...subTask]`). Replacing is the
		// contract — a unit that narrows to `["read"]` must not keep `grep`.
		const merged = mergeSubTaskParams(
			globalOf({ toolOptions: globalTools }),
			{ task: "t", tools: ["read"] },
			CAP,
		);
		expect(merged.toolOptions?.tools).toEqual(["read"]);
	});

	it("an absent unit `tools` inherits the global list, field by field", () => {
		const merged = mergeSubTaskParams(
			globalOf({ toolOptions: globalTools }),
			{ task: "t", excludeTools: ["edit"] },
			CAP,
		);
		expect(merged.toolOptions?.tools).toEqual(["read", "grep", "find"]);
		expect(merged.toolOptions?.excludeTools).toEqual(["edit"]);
		expect(merged.toolOptions?.noBuiltinTools).toBe(true);
	});

	it("`noBuiltinTools: false` survives an inherited `true`", () => {
		// Mutant killed: `subTask.noBuiltinTools || global.toolOptions?.noBuiltinTools`.
		// `false` is the value that says "let this unit use the builtins"; `||`
		// would resurrect the global `true` and silently strip the unit's tools.
		const merged = mergeSubTaskParams(
			globalOf({ toolOptions: { tools: ["read"], noBuiltinTools: true } }),
			{ task: "t", noBuiltinTools: false },
			CAP,
		);
		expect(merged.toolOptions?.noBuiltinTools).toBe(false);
	});

	it("`edit` without `write` gains `write` (pi's edit depends on it)", () => {
		// Mutant killed: dropping the injection in the moved body — every unit
		// narrowed to `["edit"]` would then spawn with a tool that cannot run.
		const merged = mergeSubTaskParams(globalOf(), { task: "t", tools: ["edit", "read"] }, CAP);
		expect(merged.toolOptions?.tools).toEqual(["edit", "read", "write"]);
	});

	it("`edit` already alongside `write` is left alone", () => {
		// The other half of the rule: no duplicate `write`, no reordering.
		const merged = mergeSubTaskParams(globalOf(), { task: "t", tools: ["write", "edit"] }, CAP);
		expect(merged.toolOptions?.tools).toEqual(["write", "edit"]);
	});

	it("the global list gets the same injection", () => {
		const merged = mergeSubTaskParams(
			globalOf({ toolOptions: { tools: ["edit"] } }),
			{ task: "t" },
			CAP,
		);
		expect(merged.toolOptions?.tools).toEqual(["edit", "write"]);
	});

	it("no tool field anywhere ⇒ `toolOptions` is undefined, not an empty object", () => {
		const merged = mergeSubTaskParams(globalOf(), { task: "t" }, CAP);
		expect(merged.toolOptions).toBeUndefined();
	});
});

describe("4. priority comes only from the four schema values", () => {
	const VALID: Priority[] = ["critical", "high", "normal", "low"];

	for (const value of VALID) {
		it(`"${value}" is carried through`, () => {
			const merged = mergeSubTaskParams(globalOf(), { task: "t", priority: value }, CAP);
			expect(merged.priority).toBe(value);
		});
	}

	it("an invalid string is dropped to `undefined`", () => {
		// `SubTaskParams.priority` is a plain `string`, so the merge is the only
		// thing between a hand-written step and `acquireSlot`'s ordering.
		const merged = mergeSubTaskParams(globalOf(), { task: "t", priority: "urgent" }, CAP);
		expect(merged.priority).toBeUndefined();
	});

	it("no priority declared ⇒ `undefined`, so the call-level fallback fires", () => {
		const merged = mergeSubTaskParams(globalOf(), { task: "t" }, CAP);
		expect(merged.priority).toBeUndefined();
	});
});

describe("5. thinking resolves against the cap only when the unit declares a level", () => {
	it("a declared level above the cap is clamped to the cap", () => {
		// Mutant killed: ignoring `maxThinkingLevel` (the parameterisation this
		// extraction introduced) and passing the declared level through.
		const merged = mergeSubTaskParams(
			globalOf({ thinkingLevel: "low" }),
			{ task: "t", thinkingLevel: "high" },
			"medium",
		);
		expect(merged.thinkingLevel).toBe("medium");
	});

	it("a declared level below the cap is kept", () => {
		const merged = mergeSubTaskParams(globalOf(), { task: "t", thinkingLevel: "off" }, "high");
		expect(merged.thinkingLevel).toBe("off");
	});

	it("no declared level ⇒ the global level VERBATIM, even above the cap", () => {
		// The global level was already resolved (and capped) upstream; re-capping
		// it here would apply the cap twice and silently lower a session that was
		// configured higher than the per-dispatch cap.
		const merged = mergeSubTaskParams(
			globalOf({ thinkingLevel: "xhigh" }),
			{ task: "t" },
			"low",
		);
		expect(merged.thinkingLevel).toBe("xhigh");
	});
});

describe("6. displayTaskName renders the label when it exists, else the truncated task", () => {
	it("the label wins over the task", () => {
		const merged = mergeSubTaskParams(globalOf(), { task: "Some long task text", label: "audit" }, CAP);
		expect(displayTaskName(merged)).toBe("audit");
	});

	it("an EMPTY label is still the label", () => {
		// Mutant killed: `merged.label || …`. An empty label is a declaration
		// (some callers build it by joining parts that may all be empty); falling
		// back to the task text would render a different unit than the caller named.
		const merged = mergeSubTaskParams(globalOf(), { task: "Some long task text", label: "" }, CAP);
		expect(displayTaskName(merged)).toBe("");
	});

	it("an absent label renders the task unchanged at 60 characters", () => {
		const task = "a".repeat(60);
		const merged = mergeSubTaskParams(globalOf(), { task }, CAP);
		expect(displayTaskName(merged)).toBe(task);
	});

	it("at 61 characters the task is cut to 57 plus an ellipsis", () => {
		const task = "b".repeat(61);
		const merged = mergeSubTaskParams(globalOf(), { task }, CAP);
		const shown = displayTaskName(merged);
		expect(shown).toBe(`${"b".repeat(57)}...`);
		expect(shown).toHaveLength(60);
	});
});

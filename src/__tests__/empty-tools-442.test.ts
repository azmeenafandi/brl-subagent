/**
 * Issue #442 — an explicitly EMPTY tool allowlist means no child tools.
 *
 * SCOPE (the seam, not a replica):
 *   T1 `buildSubagentArgs` — the argument boundary every foreground spawn and
 *      every graph/parallel/chain caller goes through (`runSubagent` is its one
 *      caller, so testing it here covers all of them).
 *   T2 the REAL resolver (`resolveSubagentParams`) — a `tools: []` that arrives
 *      directly or from a preset must survive resolution as `[]`, not as
 *      "omitted", and a direct call must still win over the preset.
 *   T3 the REAL pre-flight (`validatePreTask`) — `tools: []` plus an
 *      `outputFile` is rejected before launch, `force` notwithstanding.
 *
 * WHY A NEW FILE: `resolve-params.test.ts` deliberately does NOT pin `tools: []`
 * downstream behavior ("Do not add those pins without a maintainer decision").
 * #442 is that decision, and the pins belong beside the change, not inside a
 * branch map that excludes them.
 *
 * The real-CHILD proofs (an actual pi process, extension + MCP canaries) live in
 * `empty-tools-child-442.test.ts`; this file stays in-process and fast.
 */
import { describe, expect, it } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { buildSubagentArgs } from "../runner";
import { resolveSubagentParams, type ResolveInputParams } from "../params";
import { validatePreTask } from "../validate";
import { SessionState } from "../state";
import type { Logger } from "../logging";
import type { SubagentPreset, SubagentToolOptions } from "../types";

// =========================================================================
// Harness
// =========================================================================

const MODEL = { provider: "test", id: "model-x" };

/** Silent logger: the resolver's only line is the auto-route info. */
const silentLog: Logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
};

/**
 * The resolver reads only `ctx.cwd`; a full ExtensionContext mock would be
 * noise. Mirrors `resolve-params.test.ts` §Harness so a preset-derived empty
 * list is measured through the same boundary the dispatch uses.
 */
function makeCtx(cwd = "/work"): ExtensionContext {
	return {
		cwd,
		model: MODEL,
		sessionManager: { getEntries: () => [], appendCustomEntry: () => {} },
		getSystemPrompt: () => "You are a default coding assistant.",
		ui: { setStatus: () => {}, notify: () => {}, theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t } },
	} as unknown as ExtensionContext;
}

function makeState(presets: SubagentPreset[] = []): SessionState {
	const state = new SessionState();
	state.builtinPresets = [];
	state.customPresets = presets;
	return state;
}

function resolve(params: ResolveInputParams, state = makeState()) {
	return resolveSubagentParams(params, state, makeCtx(), silentLog);
}

/** Every tool-selection flag `buildSubagentArgs` can emit, in arg order. */
function toolArgs(args: string[]): string[] {
	const out: string[] = [];
	for (let i = 0; i < args.length; i++) {
		const flag = args[i];
		if (flag === "--tools" || flag === "--exclude-tools") {
			// Both take a value; keep it attached so an assertion reads as the argv does.
			out.push(args[i + 1] === undefined ? flag : `${flag} ${args[i + 1]}`);
			i++;
		} else if (flag === "--no-tools" || flag === "--no-builtin-tools") {
			out.push(flag);
		}
	}
	return out;
}

const EMPTY: SubagentToolOptions = { tools: [] };

// =========================================================================
// T1 — the argument boundary
// =========================================================================

describe("buildSubagentArgs — tools: [] vs omitted (issue #442)", () => {
	it("T1.1 omitted adds NO tool restriction at all (pi's defaults stay)", () => {
		const args = buildSubagentArgs(MODEL, "medium", undefined);
		expect(toolArgs(args)).toEqual([]);
	});

	it("T1.2 an explicitly empty allowlist passes exactly the full --no-tools flag", () => {
		const args = buildSubagentArgs(MODEL, "medium", EMPTY);
		expect(toolArgs(args)).toEqual(["--no-tools"]);
		// Exactly once — a duplicated flag would still pass a `toContain` check.
		expect(args.filter((a) => a === "--no-tools")).toHaveLength(1);
	});

	it("T1.3 empty wins over noBuiltinTools: true (it cannot widen into built-ins-off/extensions-on)", () => {
		const args = buildSubagentArgs(MODEL, "medium", { tools: [], noBuiltinTools: true });
		expect(toolArgs(args)).toEqual(["--no-tools"]);
		expect(args).not.toContain("--no-builtin-tools");
	});

	it("T1.4 an explicit non-empty read-only allowlist still maps to --tools read", () => {
		const args = buildSubagentArgs(MODEL, "medium", { tools: ["read"] });
		expect(toolArgs(args)).toEqual(["--tools read"]);
	});

	it("T1.5 noBuiltinTools on its own keeps its existing flag", () => {
		const args = buildSubagentArgs(MODEL, "medium", { noBuiltinTools: true });
		expect(toolArgs(args)).toEqual(["--no-builtin-tools"]);
	});

	it("T1.6 excludeTools alone keeps its existing flag", () => {
		const args = buildSubagentArgs(MODEL, "medium", { excludeTools: ["bash"] });
		expect(toolArgs(args)).toEqual(["--exclude-tools bash"]);
	});

	it("T1.7 excludeTools cannot reactivate a tool under an empty allowlist", () => {
		const args = buildSubagentArgs(MODEL, "medium", { tools: [], excludeTools: ["bash"] });
		expect(toolArgs(args)).toEqual(["--no-tools", "--exclude-tools bash"]);
		expect(args).not.toContain("--tools");
	});

	it("T1.8 an empty excludeTools list adds nothing (no empty flag value)", () => {
		const args = buildSubagentArgs(MODEL, "medium", { tools: ["read"], excludeTools: [] });
		expect(toolArgs(args)).toEqual(["--tools read"]);
	});
});

// =========================================================================
// T2 — the real resolver: [] survives, and precedence is unchanged
// =========================================================================

describe("resolveSubagentParams — an empty allowlist is not erased (issue #442)", () => {
	it("T2.1 a direct tools: [] reaches the argument builder as --no-tools", () => {
		const resolved = resolve({ task: "say hello", tools: [] });
		expect(resolved.toolOptions?.tools).toEqual([]);
		expect(toolArgs(buildSubagentArgs(MODEL, "medium", resolved.toolOptions))).toEqual(["--no-tools"]);
	});

	it("T2.2 a PRESET-derived empty list reaches the argument builder as --no-tools", () => {
		const preset: SubagentPreset = { name: "no-tools-preset", description: "empty", tools: [] };
		const resolved = resolve({ task: "say hello", preset: "no-tools-preset" }, makeState([preset]));
		expect(resolved.toolOptions?.tools).toEqual([]);
		expect(toolArgs(buildSubagentArgs(MODEL, "medium", resolved.toolOptions))).toEqual(["--no-tools"]);
	});

	it("T2.3 a direct tools: [] beats a preset's non-empty allowlist", () => {
		const preset: SubagentPreset = { name: "reader", description: "read-only", tools: ["read", "grep"] };
		const resolved = resolve({ task: "say hello", preset: "reader", tools: [] }, makeState([preset]));
		expect(resolved.toolOptions?.tools).toEqual([]);
		expect(toolArgs(buildSubagentArgs(MODEL, "medium", resolved.toolOptions))).toEqual(["--no-tools"]);
	});

	it("T2.4 a direct non-empty allowlist still beats a preset's empty list", () => {
		const preset: SubagentPreset = { name: "no-tools-preset", description: "empty", tools: [] };
		const resolved = resolve({ task: "say hello", preset: "no-tools-preset", tools: ["read"] }, makeState([preset]));
		expect(resolved.toolOptions?.tools).toEqual(["read"]);
		expect(toolArgs(buildSubagentArgs(MODEL, "medium", resolved.toolOptions))).toEqual(["--tools read"]);
	});

	it("T2.5 omitted tools still yields no toolOptions (pi defaults), like before #442", () => {
		const resolved = resolve({ task: "say hello" });
		expect(resolved.toolOptions).toBeUndefined();
		expect(toolArgs(buildSubagentArgs(MODEL, "medium", resolved.toolOptions))).toEqual([]);
	});

	it("T2.6 the edit-implies-write rule is preserved for non-empty lists", () => {
		const resolved = resolve({ task: "say hello", tools: ["read", "edit"] });
		expect(resolved.toolOptions?.tools).toEqual(["read", "edit", "write"]);
		expect(toolArgs(buildSubagentArgs(MODEL, "medium", resolved.toolOptions))).toEqual([
			"--tools read,edit,write",
		]);
	});

	it("T2.7 an empty list gains no implied write (nothing was listed to imply it)", () => {
		const resolved = resolve({ task: "say hello", tools: [] });
		expect(resolved.toolOptions?.tools).toEqual([]);
	});
});

// =========================================================================
// T3 — the capability pre-flight, through the real validator
// =========================================================================

describe("validatePreTask — tools: [] plus outputFile is a pre-launch rejection (issue #442)", () => {
	/** Resolve then validate, exactly as the dispatch chokepoint does. */
	function dispatch(params: ResolveInputParams, force = false) {
		const resolved = resolve(params);
		return validatePreTask({
			task: resolved.task,
			outputFile: resolved.outputFile,
			toolOptions: resolved.toolOptions,
			force,
			cwd: resolved.effectiveCwd,
		});
	}

	it("T3.1 tools: [] with an outputFile is rejected (no write tool exists)", () => {
		const result = dispatch({ task: "say hello", tools: [], outputFile: "report.md" });
		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toMatch(/outputFile is set but the 'write' tool is not available/);
	});

	it("T3.2 force does NOT downgrade that rejection (outputFile stays hard)", () => {
		const result = dispatch({ task: "say hello", tools: [], outputFile: "report.md" }, true);
		expect(result.valid).toBe(false);
		expect(result.errors.join("\n")).toMatch(/outputFile is set/);
	});

	it("T3.3 the same dispatch WITHOUT outputFile is accepted — [] is a tool setting, not a rejection", () => {
		const result = validatePreTask({
			task: "say hello",
			toolOptions: EMPTY,
			force: false,
			cwd: makeCtx().cwd,
		});
		expect(result.valid).toBe(true);
	});

	it("T3.4 the pre-#442 shape is why this mattered: omit vs [] differ on outputFile", () => {
		// Omitted tools = pi defaults = write is available → accepted.
		expect(dispatch({ task: "say hello", outputFile: "report.md" }).valid).toBe(true);
		// Empty = no write → rejected. A regression that maps [] to "omitted"
		// flips this test, which is the point.
		expect(dispatch({ task: "say hello", tools: [], outputFile: "report.md" }).valid).toBe(false);
	});

	it("T3.5 a non-empty allowlist that omits write is still rejected (unchanged)", () => {
		const result = dispatch({ task: "say hello", tools: ["read"], outputFile: "report.md" });
		expect(result.valid).toBe(false);
	});
});

/**
 * Unit tests for the parameter-resolution seam (issue #429).
 *
 * SCOPE: `resolveSubagentParams` (the explicit-call > preset > config merge)
 * and `resolveDispatchPreset` (the routing seam composed at the top of it,
 * shared with the #412 pre-flight and, until this file, having no named direct
 * test). Branch map and provenance: `.development/investigations/
 * test-plan-429-2026-11-06.md`.
 *
 * Why a NEW file instead of extending `params.test.ts`: that file covers the
 * pure schema helpers (`findUnknownParams` / `snapshotOriginalParams`) with no
 * session state; this one drives the resolver itself and needs a real
 * `SessionState`, preset fixtures, an `ExtensionContext` and a capturing
 * logger — a different harness, not another helper of the same module.
 *
 * HARNESS RULES (deliberate, do not "simplify"):
 * - REAL `SessionState`, not `integration.test.ts` §1's `MockSessionState`.
 *   The real defaults are `maxThinkingLevel: "off"`, `gitMode: "none"`,
 *   `approvalMode: "writes"` — so a cap-sensitive fixture MUST set the cap
 *   explicitly: with the real default ("off") a cap test asserting `"off"`
 *   would pass for the wrong reason.
 * - Timeout-bearing presets are IN-MEMORY SEAM tests. The file-loaded preset
 *   tier discards `timeout` (`presets-files.test.ts` pins that; ADR 0022 §6
 *   depends on it), so the timeout rows below measure the resolver's
 *   `params.timeout ?? preset?.timeout` order — not a shipped preset shape.
 * - Deliberately NOT pinned here (critique escalations, see the plan's Scope):
 *   `tools: []` DOWNSTREAM behavior (the resolver/pre-flight/spawn-args
 *   disagreement) and invalid-but-schema-valid `thinkingLevel` values. Do not
 *   add those pins without a maintainer decision.
 */

import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import { resolveDispatchPreset, resolveSubagentParams, type ResolveInputParams } from "../params";
import { SessionState } from "../state";
import type { SubagentPreset } from "../types";
import type { Logger } from "../logging";

// =========================================================================
// Harness
// =========================================================================

/**
 * Same shape as `integration.test.ts` §1: the resolver reads only `ctx.cwd`,
 * so a full ExtensionContext mock would be noise. One shared instance is safe
 * — every field is immutable or a spy the resolver never calls.
 */
function createMockPluginContext(overrides: Partial<ExtensionContext> = {}): ExtensionContext {
	return {
		ui: {
			setStatus: vi.fn(),
			notify: vi.fn(),
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		} as unknown as ExtensionContext["ui"],
		model: { provider: "test", id: "model-x" },
		cwd: "/context",
		sessionManager: {
			getEntries: () => [],
			appendCustomEntry: vi.fn(),
		},
		getSystemPrompt: () => "You are a default coding assistant.",
		...overrides,
	} as unknown as ExtensionContext;
}

const defaultCtx = createMockPluginContext();

/** One captured `Logger` call — the auto-route evidence (P1/XLOG). */
interface LogEntry {
	level: "debug" | "info" | "warn" | "error";
	message: string;
	data?: Record<string, unknown>;
}

/**
 * Capturing logger: the resolver's only log line today is the auto-route
 * info, and XLOG/XLOGALWAYS assert on the presence and shape of exactly that.
 */
function makeCapturingLogger() {
	const entries: LogEntry[] = [];
	const capture =
		(level: LogEntry["level"]) =>
		(message: string, data?: Record<string, unknown>): void => {
			entries.push({ level, message, data });
		};
	const logger: Logger & { entries: LogEntry[] } = {
		entries,
		debug: capture("debug"),
		info: capture("info"),
		warn: capture("warn"),
		error: capture("error"),
	};
	return logger;
}

function makeState(options: {
	builtinPresets?: SubagentPreset[];
	customPresets?: SubagentPreset[];
	config?: Partial<SessionState["config"]>;
} = {}): SessionState {
	const state = new SessionState();
	Object.assign(state.config, options.config ?? {});
	state.builtinPresets = options.builtinPresets ?? [];
	state.customPresets = options.customPresets ?? [];
	return state;
}

/**
 * Resolve through the REAL function with the harness defaults applied.
 * Overrides are explicit per call so a test never depends on another's shape.
 */
function resolve(
	params: ResolveInputParams,
	state: SessionState,
	options: { ctx?: ExtensionContext; log?: Logger } = {},
) {
	return resolveSubagentParams(
		params,
		state,
		options.ctx ?? defaultCtx,
		options.log ?? makeCapturingLogger(),
	);
}

// =========================================================================
// Fixtures
// =========================================================================

/**
 * The precedence fixture: every merged field carries a DISTINCT preset value,
 * so a test that passes a call value for one field can tell "call wins" from
 * "preset wins" without a second fixture.
 */
const fixturePreset: SubagentPreset = {
	name: "fixture",
	description: "precedence fixture",
	thinkingLevel: "low",
	systemPrompt: "preset prompt",
	inheritSystemPrompt: false,
	outputFile: "preset.md",
	// IN-MEMORY SEAM ONLY — see the file header (file-loaded presets drop timeout).
	timeout: 60_000,
	tools: ["read"],
	excludeTools: ["bash"],
	noBuiltinTools: true,
};

/** Keyword-matching fixture for the routing rows (R3/R4, XLOG, X22). */
const auditorPreset: SubagentPreset = {
	name: "security-auditor",
	description: "Audits security",
	thinkingLevel: "xhigh",
	systemPrompt: "You are a security auditor.",
	inheritSystemPrompt: false,
	noBuiltinTools: true,
};

/** A preset whose NAME is a git mode — the D1 quirk's trigger. */
const branchNamedPreset: SubagentPreset = { name: "branch", description: "named branch" };

/** The task every routing fixture uses: measured keyword is "audit". */
const ROUTABLE_TASK = "run a security audit of the auth module";

// =========================================================================
// resolveDispatchPreset — R1-R5, direct (no resolver, no context)
// =========================================================================

describe("resolveDispatchPreset (issue #429 R1-R5)", () => {
	it("R1: an explicit preset resolves by name and is never auto-routed", () => {
		const state = makeState({ builtinPresets: [fixturePreset, auditorPreset] });

		const routed = resolveDispatchPreset({ preset: "fixture" }, state);

		expect(routed.name).toBe("fixture");
		expect(routed.preset).toBe(fixturePreset);
		expect(routed.autoRouted).toBe(false);
		expect(routed.keyword).toBeUndefined();
	});

	it("R1/R5: an unknown explicit name survives at the seam while its record is undefined", () => {
		const state = makeState({ builtinPresets: [auditorPreset] });

		const routed = resolveDispatchPreset({ preset: "nonexistent" }, state);

		// The caller asked for this name — the seam reports it verbatim…
		expect(routed.name).toBe("nonexistent");
		// …and the record lookup misses, so the resolver has no preset to merge.
		expect(routed.preset).toBeUndefined();
		expect(routed.autoRouted).toBe(false);
	});

	it("R2: a template or ANY explicit tool preference suppresses routing", () => {
		const state = makeState({ builtinPresets: [auditorPreset] });

		// The falsy values are the discriminating ones: `false` and `[]` are
		// still INTENT (`!== undefined`), not absence (XR2FALSE, XR2EMPTY).
		const intentCases: Array<[string, Partial<ResolveInputParams>]> = [
			["template", { template: "some-template" }],
			["tools allowlist", { tools: ["read"] }],
			["empty tools allowlist", { tools: [] }],
			["excludeTools", { excludeTools: ["bash"] }],
			["noBuiltinTools: true", { noBuiltinTools: true }],
			["noBuiltinTools: false", { noBuiltinTools: false }],
		];

		for (const [label, params] of intentCases) {
			expect(
				resolveDispatchPreset({ task: ROUTABLE_TASK, ...params }, state),
				`intent case: ${label}`,
			).toEqual({ autoRouted: false });
		}
	});

	it("R3: no keyword match — and an absent or blank task — never routes", () => {
		const state = makeState({ builtinPresets: [auditorPreset] });

		// Control: the SAME fixture DOES route a matching task, so the misses
		// below are the classifier's guard, not a dead fixture.
		expect(resolveDispatchPreset({ task: ROUTABLE_TASK }, state).autoRouted).toBe(true);

		expect(resolveDispatchPreset({ task: "hello there" }, state)).toEqual({ autoRouted: false });
		expect(resolveDispatchPreset({}, state)).toEqual({ autoRouted: false });
		expect(resolveDispatchPreset({ task: "   " }, state)).toEqual({ autoRouted: false });
	});

	it("R4: a match returns the preset, autoRouted=true and the matched keyword", () => {
		const state = makeState({ builtinPresets: [auditorPreset] });

		const routed = resolveDispatchPreset({ task: ROUTABLE_TASK }, state);

		expect(routed.name).toBe("security-auditor");
		expect(routed.preset).toBe(auditorPreset);
		expect(routed.autoRouted).toBe(true);
		// MEASURED, and it corrects §1's test comment: the matched keyword for
		// "security audit" is "audit" (the rule's first keyword), not "security".
		expect(routed.keyword).toBe("audit");
	});

	it("P2/R4: routing only considers presets that are actually installed", () => {
		// The classifier knows "security-auditor", but the dispatch has no such
		// preset to run with — routing must not invent one.
		const state = makeState();

		expect(resolveDispatchPreset({ task: ROUTABLE_TASK }, state)).toEqual({ autoRouted: false });
	});

	it("P2: a custom preset shadows the builtin record the lookup resolves", () => {
		const customFixture: SubagentPreset = { name: "fixture", description: "custom shadow" };
		const state = makeState({
			builtinPresets: [fixturePreset],
			customPresets: [customFixture],
		});

		expect(resolveDispatchPreset({ preset: "fixture" }, state).preset).toBe(customFixture);
	});
});

// =========================================================================
// resolveSubagentParams — call > preset precedence (P4, P5, P7-P9, P11, P12)
// =========================================================================

describe("resolveSubagentParams: an explicit call value beats the preset's", () => {
	it("P4/M1: call thinkingLevel beats the preset's (the preset still applies when unset)", () => {
		const state = makeState({
			builtinPresets: [fixturePreset],
			// Set explicitly: the real default is "off", which would cap "high"
			// to "off" and make this test pass for the wrong reason.
			config: { maxThinkingLevel: "high" },
		});

		const withCall = resolve({ task: "t", preset: "fixture", thinkingLevel: "high" }, state);
		expect(withCall.thinkingLevel).toBe("high");

		// Preset-only arm: "low" (uncapped here) proves the merge, not just the cap.
		expect(resolve({ task: "t", preset: "fixture" }, state).thinkingLevel).toBe("low");
	});

	it("P5/M2: an empty-string systemPrompt is an override, not an absence", () => {
		const state = makeState({ builtinPresets: [fixturePreset] });

		// "" is schema-valid and discriminating: `??` keeps it, `||` would let
		// the preset's "preset prompt" through.
		expect(resolve({ task: "t", preset: "fixture", systemPrompt: "" }, state).customSP).toBe("");
	});

	it("P5/P7: preset prompt and outputFile reach the result when the call omits them", () => {
		const state = makeState({ builtinPresets: [fixturePreset] });

		const result = resolve({ task: "t", preset: "fixture" }, state);

		expect(result.customSP).toBe("preset prompt");
		expect(result.outputFile).toBe("preset.md");
	});

	it("P8/M3: a call timeout beats the preset's timeout", () => {
		// In-memory seam test — see the fixture comment and the file header.
		const state = makeState({ builtinPresets: [fixturePreset] });

		expect(resolve({ task: "t", preset: "fixture", timeout: 1000 }, state).timeout).toBe(1000);
	});

	it("P8/XTIME: a caller timeout of 0 resolves to undefined — it never falls back to the preset's", () => {
		// In-memory seam test (ADR 0022 §6): the order is
		// `normalizeTimeout(params.timeout ?? preset?.timeout)` — the caller's
		// 0 WINS the merge, so normalization sees 0 and yields undefined.
		// Normalizing per tier instead (`normalizeTimeout(call) ?? normalizeTimeout(preset)`)
		// would resurrect the preset's 60s and silently bound the run.
		const state = makeState({ builtinPresets: [fixturePreset] });

		expect(resolve({ task: "t", preset: "fixture", timeout: 0 }, state).timeout).toBeUndefined();
	});

	it("P7/XOUTPUT: a call outputFile beats the preset's", () => {
		const state = makeState({ builtinPresets: [fixturePreset] });

		expect(resolve({ task: "t", preset: "fixture", outputFile: "call.md" }, state).outputFile).toBe(
			"call.md",
		);
	});

	it("P9/XTOOLS: a call tools allowlist beats the preset's (other tool fields still merge)", () => {
		const state = makeState({ builtinPresets: [fixturePreset] });

		const result = resolve({ task: "t", preset: "fixture", tools: ["bash"] }, state);

		// Whole shape: only `tools` is overridden — excludeTools and
		// noBuiltinTools still come from the preset (per-field merge, not replace).
		expect(result.toolOptions).toEqual({
			tools: ["bash"],
			excludeTools: ["bash"],
			noBuiltinTools: true,
		});
	});

	it("P11/XEXCLUDE: a call excludeTools list beats the preset's", () => {
		const state = makeState({ builtinPresets: [fixturePreset] });

		const result = resolve({ task: "t", preset: "fixture", excludeTools: ["edit"] }, state);

		expect(result.toolOptions).toEqual({
			tools: ["read"],
			excludeTools: ["edit"],
			noBuiltinTools: true,
		});
	});

	it("P12/XNO: an explicit noBuiltinTools=false overrides the preset's true", () => {
		const state = makeState({ builtinPresets: [fixturePreset] });

		const result = resolve({ task: "t", preset: "fixture", noBuiltinTools: false }, state);

		// `??` keeps the explicit false; `||` would let the preset's true win.
		expect(result.toolOptions).toEqual({
			tools: ["read"],
			excludeTools: ["bash"],
			noBuiltinTools: false,
		});
	});
});

// =========================================================================
// P17: the toolOptions shape gate
// =========================================================================

describe("resolveSubagentParams: toolOptions shape (P17)", () => {
	it("P17: noBuiltinTools=false ALONE produces no toolOptions (the gate is truthiness)", () => {
		const state = makeState();

		// Measured seam shape: the object is built when any of the three merged
		// values is TRUTHY, so a lone `false` yields `undefined` — the same as
		// omitting every tool field. The field-level false is pinned by XNO above,
		// where a preset value keeps the object alive.
		expect(resolve({ task: "t", noBuiltinTools: false }, state).toolOptions).toBeUndefined();

		// Control: `true` alone DOES build the object (all other fields absent).
		expect(resolve({ task: "t", noBuiltinTools: true }, state).toolOptions).toEqual({
			tools: undefined,
			excludeTools: undefined,
			noBuiltinTools: true,
		});
	});
});

// =========================================================================
// Routing through the resolver — P1, P3, P22, R5 (XLOG, XLOGALWAYS, X22)
// =========================================================================

describe("resolveSubagentParams: auto-route evidence and suppression", () => {
	it("P1/XLOG: a routed dispatch logs exactly one 'Auto-routed task to preset' entry", () => {
		const state = makeState({ builtinPresets: [auditorPreset] });
		const log = makeCapturingLogger();

		resolve({ task: ROUTABLE_TASK }, state, { log });

		expect(log.entries).toEqual([
			{
				level: "info",
				message: "Auto-routed task to preset",
				data: { preset: "security-auditor", keyword: "audit" },
			},
		]);
	});

	it("P1/XLOGALWAYS: an explicit preset logs no auto-route entry", () => {
		const state = makeState({ builtinPresets: [fixturePreset, auditorPreset] });
		const log = makeCapturingLogger();

		resolve({ task: ROUTABLE_TASK, preset: "fixture" }, state, { log });

		expect(log.entries).toEqual([]);
	});

	it("P22/X22: the routed keyword is propagated as autoRouteKeyword; explicit and unrouted carry none", () => {
		const state = makeState({ builtinPresets: [fixturePreset, auditorPreset] });

		const routed = resolve({ task: ROUTABLE_TASK }, state);
		expect(routed.autoRouteKeyword).toBe("audit");

		const explicit = resolve({ task: ROUTABLE_TASK, preset: "fixture" }, state);
		expect(explicit.resolvedPreset?.name).toBe("fixture");
		expect(explicit.autoRouteKeyword).toBeUndefined();

		const unrouted = resolve({ task: "hello there" }, state);
		expect(unrouted.autoRoutedPreset).toBeUndefined();
		expect(unrouted.autoRouteKeyword).toBeUndefined();
	});

	it("R5/XUNK: an unknown explicit preset suppresses routing and yields no preset or keyword", () => {
		// The discriminating case §1's "falls through to defaults" test misses:
		// the task alone WOULD route, so an absent route here is the explicit
		// name suppressing it — not the classifier failing.
		const state = makeState({ builtinPresets: [auditorPreset] });
		const log = makeCapturingLogger();

		const result = resolve({ task: ROUTABLE_TASK, preset: "nonexistent" }, state, { log });

		expect(result.task).toBe(ROUTABLE_TASK);
		expect(result.resolvedPreset).toBeUndefined();
		expect(result.autoRoutedPreset).toBeUndefined();
		expect(result.autoRouteKeyword).toBeUndefined();
		expect(log.entries).toEqual([]);
	});

	it("R2/XR2FALSE: noBuiltinTools=false is intent — it suppresses routing", () => {
		const state = makeState({ builtinPresets: [auditorPreset] });

		const result = resolve({ task: ROUTABLE_TASK, noBuiltinTools: false }, state);

		expect(result.autoRoutedPreset).toBeUndefined();
		expect(result.resolvedPreset).toBeUndefined();
	});

	it("R2/XR2EMPTY: an empty tools array is intent — it suppresses routing", () => {
		// ROUTING ONLY. The downstream effect of `tools: []` is a known
		// escalation (pre-flight vs spawn args disagree) and must NOT be pinned.
		const state = makeState({ builtinPresets: [auditorPreset] });

		const result = resolve({ task: ROUTABLE_TASK, tools: [] }, state);

		expect(result.autoRoutedPreset).toBeUndefined();
		expect(result.resolvedPreset).toBeUndefined();
	});
});

// =========================================================================
// Quirks pinned as-is — D1, D3, D4, D5, D6
// =========================================================================

describe("resolveSubagentParams: measured quirks (D1, D3-D6)", () => {
	it("P13/M6 (D1): gitMode merges from the preset's NAME, not a preset gitMode field", () => {
		const state = makeState({
			builtinPresets: [branchNamedPreset],
			config: { gitMode: "none" },
		});

		// The quirk: a preset literally named "branch" silently sets gitMode,
		// even though SubagentPreset has no gitMode field.
		expect(resolve({ task: "t", preset: "branch" }, state).resolvedGitMode).toBe("branch");

		// Control: an ordinary preset NAME is not a git mode, so config wins.
		const ordinary = makeState({ builtinPresets: [fixturePreset], config: { gitMode: "branch" } });
		expect(resolve({ task: "t", preset: "fixture" }, ordinary).resolvedGitMode).toBe("branch");
	});

	it("D1 ratchet: src/params.ts still documents the gitMode-from-preset-NAME QUIRK", () => {
		const source = readFileSync(join(__dirname, "..", "params.ts"), "utf8");

		// Changing the merge without updating the QUIRK comment is exactly the
		// silent behavior change the pin above cannot describe. Fix BOTH together.
		expect(source).toContain(
			"QUIRK (pre-existing, preserved from the original closure): gitMode merges",
		);
		expect(source).toMatch(/from preset\?\.NAME, not a preset gitMode field/);
	});

	it("P19 (D3): a nonblank label is trimmed; an empty label is undefined", () => {
		const state = makeState();

		expect(resolve({ task: "t", label: "  audit me  " }, state).label).toBe("audit me");
		expect(resolve({ task: "t", label: "" }, state).label).toBeUndefined();
	});

	it("P18 (D4): an omitted task resolves to '' and never routes", () => {
		// Same contract as §1's #379 pin, restated here so the D-list is complete
		// in the file a reader comes to for the raw seam (the route-suppression
		// arm is the part §1 asserts too).
		const state = makeState({ builtinPresets: [auditorPreset] });

		const result = resolve({}, state);

		expect(result.task).toBe("");
		expect(result.autoRoutedPreset).toBeUndefined();
	});

	it("P21/M12 (D5): an empty-string cwd falls back to ctx.cwd", () => {
		const state = makeState();
		const ctx = createMockPluginContext({ cwd: "/context" });

		// `||`, not `??`: "" is treated as "not provided" and never reaches the
		// child as a cwd.
		expect(resolve({ task: "t", cwd: "" }, state, { ctx }).effectiveCwd).toBe("/context");
		// Control: a real cwd still wins over ctx.cwd.
		expect(resolve({ task: "t", cwd: "/other" }, state, { ctx }).effectiveCwd).toBe("/other");
	});

	it("R1/D6: an empty-string preset is not an explicit-name guard — routing still runs", () => {
		const state = makeState({ builtinPresets: [auditorPreset] });

		// `preset: ""` is schema-valid and falsy, so the seam's `if (params.preset)`
		// does not short-circuit: the dispatch behaves exactly like the omitted case.
		const emptyPreset = resolve({ task: ROUTABLE_TASK, preset: "" }, state);
		const omitted = resolve({ task: ROUTABLE_TASK }, state);

		expect(emptyPreset.resolvedPreset?.name).toBe("security-auditor");
		expect(emptyPreset.autoRoutedPreset?.name).toBe("security-auditor");
		expect(emptyPreset.autoRouteKeyword).toBe("audit");
		expect(emptyPreset.resolvedPreset).toBe(omitted.resolvedPreset);
	});
});

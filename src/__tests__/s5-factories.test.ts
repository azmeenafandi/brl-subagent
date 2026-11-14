/**
 * ADR 0027 S5 (issue #483) — the three registration factories, driven directly.
 *
 * The 24 suites that boot `initExtension` are the behavioural backstop for this
 * stage: they reach every moved handler THROUGH the real registration surface,
 * which is exactly the property a move must not break. This file pins the other
 * half — what the factories themselves own, with no boot at all:
 *
 *   - `createCommands` returns the definition `pi.registerCommand` consumes, and
 *     its table dispatches to the TUI/dep call each key names (including the
 *     `reset` key's dep and `retry`'s abandon callback);
 *   - `createDelegateHandler` returns the definition the registerTool call
 *     consumes, rejects the malformed dispatch shapes before any work, and — the
 *     load-bearing part — routes each shape to the runner/pipeline instance it
 *     was GIVEN. A factory that built its own runner would still pass every
 *     behavioural suite; these spies would not.
 *   - `createAgentTools` returns the three definitions, and their `execute`
 *     paths (not-found, error sanitization) work over the lazy imports.
 *
 * Everything here is fakes: no `initExtension`, no temp session store, no spawn.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createCommands, type CommandDeps } from "../commands";
import { createDelegateHandler, type DelegateHandlerDeps } from "../delegate-handler";
import { createAgentTools } from "../agent-tools";
import { createRuntime } from "../runtime";
import { delegateTaskParamsSchema } from "../schema";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

/**
 * The TUI menus open real dialogs; each is replaced by a spy so the assertion
 * is "this key reached this menu", which is what the table decides. Every export
 * the two definition modules import must exist on the mock (a missing one is a
 * TypeError at first call, not a silent no-op).
 */
const tui = vi.hoisted(() => ({
	showModelSelector: vi.fn(),
	showThinkingSelector: vi.fn(),
	showConcurrencyInput: vi.fn(),
	showDepthInput: vi.fn(),
	showApprovalModeSelector: vi.fn(),
	showCompletionNotifySelector: vi.fn(),
	showRecoverySelector: vi.fn(),
	showCostLimitInput: vi.fn(),
	showRunHistory: vi.fn(),
	showHistoryEntriesInput: vi.fn(),
	showMonitor: vi.fn(),
	showDashboard: vi.fn(),
	showPresetManager: vi.fn(),
	showTemplateManager: vi.fn(),
	showRetryMenu: vi.fn(),
	showSLAConfig: vi.fn(),
	showSLAStats: vi.fn(),
	showComplianceMenu: vi.fn(),
	showConfigMenu: vi.fn(),
	showApprovalDialog: vi.fn(),
	renderDelegateCall: vi.fn(() => "call"),
	renderDelegateResult: vi.fn(() => "result"),
}));
vi.mock("../tui", () => tui);

/** The agent tools reach these two modules by dynamic import inside `execute`. */
const session = vi.hoisted(() => ({
	stopAgent: vi.fn(),
	steerAgent: vi.fn(),
	getAgent: vi.fn(),
	resolveAgentId: vi.fn(),
	findRetryLineage: vi.fn(),
	isTerminalAgentStatus: vi.fn(),
	RETRY_SCAN_WINDOW_MS: 7 * 24 * 60 * 60 * 1000,
	RETRY_SCAN_WINDOW_DAYS: 7,
}));
vi.mock("../session-manager", () => session);
const transcript = vi.hoisted(() => ({ getTranscript: vi.fn(() => []) }));
vi.mock("../transcript", () => transcript);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const workdir = mkdtempSync(join(tmpdir(), "brl-s5-factories-"));
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

function fakePi(): ExtensionAPI {
	return { sendMessage: vi.fn(), persistState: vi.fn() } as unknown as ExtensionAPI;
}

function fakeCtx(cwd = workdir): ExtensionContext {
	return {
		cwd,
		model: { provider: "test", id: "model" },
		getSystemPrompt: () => "SYSTEM",
		ui: { setStatus: vi.fn(), notify: vi.fn(), theme: { fg: (_c: string, text: string) => text } },
		hasUI: false,
	} as unknown as ExtensionContext;
}

beforeEach(() => {
	for (const spy of Object.values(tui)) spy.mockClear();
	for (const spy of Object.values(session)) if (typeof spy === "function") spy.mockClear();
});

const textOf = (result: { content: Array<{ type: string }> }): string =>
	result.content.map((part) => (part as { text?: string }).text ?? "").join("");

// ---------------------------------------------------------------------------
// createCommands
// ---------------------------------------------------------------------------

describe("createCommands — the /brl-subagent definition (ADR 0027 S5)", () => {
	function makeDeps(): CommandDeps {
		return {
			applyConfig: vi.fn(),
			resetState: vi.fn(),
			abandonProductionRun: vi.fn(async () => {}),
		};
	}

	it("returns exactly what pi.registerCommand consumes — no name, no sourceInfo", () => {
		const command = createCommands(createRuntime(fakePi()), makeDeps());
		expect(Object.keys(command).sort()).toEqual(["description", "getArgumentCompletions", "handler"]);
		expect(command.description).toBe("Configure subagent model and thinking level");
		expect(typeof command.handler).toBe("function");
	});

	it("dispatches each menu key to its own TUI call, with the live ctx and this runtime's state", async () => {
		const rt = createRuntime(fakePi());
		const command = createCommands(rt, makeDeps());
		const ctx = fakeCtx();

		const routing: Array<[string, keyof typeof tui]> = [
			["model", "showModelSelector"],
			["thinking", "showThinkingSelector"],
			["concurrency", "showConcurrencyInput"],
			["depth", "showDepthInput"],
			["approval", "showApprovalModeSelector"],
			["completionnotify", "showCompletionNotifySelector"],
			["recovery", "showRecoverySelector"],
			["costlimit", "showCostLimitInput"],
			["historyentries", "showHistoryEntriesInput"],
			["monitor", "showMonitor"],
			["dashboard", "showDashboard"],
			["preset", "showPresetManager"],
			["templates", "showTemplateManager"],
			["sla", "showSLAConfig"],
			["sla-stats", "showSLAStats"],
			["compliance", "showComplianceMenu"],
		];
		for (const [key, target] of routing) {
			for (const spy of Object.values(tui)) spy.mockClear();
			await command.handler(key, ctx);
			expect(tui[target], `/${key} must reach ${target}`).toHaveBeenCalledTimes(1);
			// The first two arguments are the per-call ctx and the runtime's own
			// store — a factory-time capture would hand over a stale ctx here.
			expect(tui[target].mock.calls[0].slice(0, 2)).toEqual([ctx, rt.state]);
		}
	});

	it("routes the config-writing keys through the injected deps, not a rebuilt writer", async () => {
		const rt = createRuntime(fakePi());
		const deps = makeDeps();
		const command = createCommands(rt, deps);
		const ctx = fakeCtx();

		await command.handler("reset", ctx);
		expect(deps.resetState).toHaveBeenCalledWith(ctx);
		expect(deps.applyConfig).not.toHaveBeenCalled();

		// `model` passes the composition root's applyConfig as the change callback.
		await command.handler("model", ctx);
		expect(tui.showModelSelector.mock.calls[0][2]).toBe(deps.applyConfig);
	});

	it("hands the retry menu the injected abandon action (the S4 boot factory's)", async () => {
		const deps = makeDeps();
		const command = createCommands(createRuntime(fakePi()), deps);
		await command.handler("retry", fakeCtx());

		expect(tui.showRetryMenu).toHaveBeenCalledTimes(1);
		const abandon = tui.showRetryMenu.mock.calls[0][2] as (id: string) => void;
		abandon("run-7");
		expect(deps.abandonProductionRun).toHaveBeenCalledWith(expect.anything(), "run-7");
	});

	it("falls back to the config menu with the SAME handler map (menu/config parity)", async () => {
		const command = createCommands(createRuntime(fakePi()), makeDeps());
		const ctx = fakeCtx();
		await command.handler("   ", ctx);

		expect(tui.showConfigMenu).toHaveBeenCalledTimes(1);
		const handlers = tui.showConfigMenu.mock.calls[0][2] as Record<string, unknown>;
		// The map showConfigMenu receives IS the dispatch table, so a key added on
		// one side and not the other cannot pass unnoticed.
		for (const key of ["model", "thinking", "reset", "history", "preset", "templates", "compliance"]) {
			expect(typeof handlers[key], `${key} must be in the menu's handler map`).toBe("function");
		}

		// The two prefix branches are dispatch, not menu: they run before the
		// fallback for `templates…`/`preset…` arguments.
		for (const spy of Object.values(tui)) spy.mockClear();
		await command.handler("preset-reviewer", ctx);
		expect(tui.showPresetManager).toHaveBeenCalledTimes(1);
		expect(tui.showConfigMenu).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// createDelegateHandler
// ---------------------------------------------------------------------------

describe("createDelegateHandler — the delegate_task definition (ADR 0027 S5)", () => {
	function makeDeps() {
		const result = { content: [{ type: "text" as const, text: "ran" }], details: undefined };
		const deps: DelegateHandlerDeps = {
			runChainMode: vi.fn(async () => result),
			runParallelMode: vi.fn(async () => result),
			runGraphMode: vi.fn(async () => result),
			runBackgroundFanOut: vi.fn(async () => result),
			spawnBackgroundRun: vi.fn(async () => result),
			visibleRunsFor: vi.fn(() => []),
		};
		return { deps, result };
	}

	function execute(definition: ReturnType<typeof createDelegateHandler>, params: unknown, ctx = fakeCtx()) {
		return definition.execute("call-1", params as never, undefined, undefined, ctx);
	}

	it("returns the definition the registerTool call consumes, with the imported schema", () => {
		const rt = createRuntime(fakePi());
		const { deps } = makeDeps();
		const definition = createDelegateHandler(rt, deps);

		expect(definition.name).toBe("delegate_task");
		expect(definition.label).toBe("Delegate Task");
		expect(definition.description.length).toBeGreaterThan(0);
		// Identity, not a copy: the schema<->types ratchet in schema.ts depends on
		// this being the one exported schema object.
		expect(definition.parameters).toBe(delegateTaskParamsSchema);
		expect(typeof definition.execute).toBe("function");
		expect(typeof definition.renderCall).toBe("function");
		expect(typeof definition.renderResult).toBe("function");
	});

	it("rejects a dispatch with no shape before touching any dep", async () => {
		const { deps } = makeDeps();
		const definition = createDelegateHandler(createRuntime(fakePi()), deps);

		const result = await execute(definition, {});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Invalid task");
		for (const dep of Object.values(deps)) expect(dep).not.toHaveBeenCalled();
	});

	it("rejects a dispatch that names two shapes", async () => {
		const { deps } = makeDeps();
		const definition = createDelegateHandler(createRuntime(fakePi()), deps);

		const result = await execute(definition, {
			task: "count the files",
			chain: [{ task: "count the files" }],
		});
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Provide exactly one of");
		expect(deps.runChainMode).not.toHaveBeenCalled();
	});

	it("names the available templates when the requested one is missing", async () => {
		const { deps } = makeDeps();
		const definition = createDelegateHandler(createRuntime(fakePi()), deps);

		const result = await execute(definition, { template: "nope" });
		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Template 'nope' not found");
		expect(textOf(result)).toContain("Available: none");
	});

	it("dispatches every shape to the runner/pipeline instance it was GIVEN", async () => {
		// The load-bearing assertion of S5: a factory that called a `create*`
		// factory internally would spawn its own runner — passing every
		// behavioural suite while splitting the spawn queue and the notice latch.
		// These spies are the only instances in scope, so a call anywhere else
		// leaves them untouched and fails here.
		const ctx = fakeCtx();
		const cases: Array<[string, unknown, keyof ReturnType<typeof makeDeps>["deps"]]> = [
			["chain", { chain: [{ task: "a" }] }, "runChainMode"],
			["parallel", { tasks: [{ task: "a" }], background: false }, "runParallelMode"],
			["graph", { graph: [{ id: "a", task: "a" }] }, "runGraphMode"],
			["background fan-out", { tasks: [{ task: "a" }], background: true }, "runBackgroundFanOut"],
			["single background", { task: "a", background: true }, "spawnBackgroundRun"],
		];
		for (const [label, params, dep] of cases) {
			const { deps } = makeDeps();
			const definition = createDelegateHandler(createRuntime(fakePi()), deps);
			const result = await execute(definition, params, ctx);
			expect(textOf(result), `${label} runs through the injected ${dep}`).toBe("ran");
			expect(deps[dep], `${label} must call the injected ${dep}`).toHaveBeenCalledTimes(1);
			// Every other seam stays untouched — one shape, one runner.
			for (const [name, other] of Object.entries(deps)) {
				if (name !== dep && name !== "visibleRunsFor") {
					expect(other, `${label} must not call ${name}`).not.toHaveBeenCalled();
				}
			}
		}
	});
});

// ---------------------------------------------------------------------------
// createAgentTools
// ---------------------------------------------------------------------------

describe("createAgentTools — the three agent-tool definitions (ADR 0027 S5)", () => {
	function tool(name: string) {
		const found = createAgentTools().find((candidate) => candidate.name === name);
		if (!found) throw new Error(`${name} definition missing`);
		return found;
	}

	it("returns the three definitions in the documented order", () => {
		const tools = createAgentTools();
		expect(tools.map((candidate) => candidate.name)).toEqual([
			"get_subagent_result",
			"steer_subagent",
			"stop_subagent",
		]);
		for (const definition of tools) {
			expect(typeof definition.execute).toBe("function");
			expect(definition.parameters).toBeDefined();
			expect(definition.description.length).toBeGreaterThan(0);
		}
	});

	it("stop_subagent reports a missing agent without throwing", async () => {
		session.stopAgent.mockResolvedValueOnce(null);
		const result = await tool("stop_subagent").execute("call-1", { agent_id: "nope" } as never, undefined, undefined, fakeCtx());
		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe("Agent nope not found");
	});

	it("stop_subagent confirms the stop with the agent's description", async () => {
		session.stopAgent.mockResolvedValueOnce({ id: "bg-1", description: "audit" });
		const result = await tool("stop_subagent").execute("call-1", { agent_id: "bg-1" } as never, undefined, undefined, fakeCtx());
		expect(result.isError).toBeUndefined();
		expect(textOf(result)).toBe("Stopped agent bg-1 (audit).");
	});

	it("steer_subagent truncates the echoed message at 50 characters", async () => {
		session.steerAgent.mockResolvedValueOnce({ id: "bg-1" });
		const long = "x".repeat(60);
		const result = await tool("steer_subagent").execute("call-1", { agent_id: "bg-1", message: long } as never, undefined, undefined, fakeCtx());
		expect(textOf(result)).toBe(`Steered agent bg-1: "${"x".repeat(50)}..."`);
	});

	it("sanitizes a throw from the session manager against the CALLER's cwd (F7)", async () => {
		// The error carries the caller's own path; the tool must mask it before
		// the message reaches the conductor's context (issue #30/#65).
		const ctx = fakeCtx();
		session.steerAgent.mockRejectedValueOnce(new Error(`boom at ${join(workdir, "secret.txt")}`));
		const result = await tool("steer_subagent").execute("call-1", { agent_id: "bg-1", message: "go" } as never, undefined, undefined, ctx);
		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe("Failed to steer agent: boom at <cwd>/secret.txt");
	});
});

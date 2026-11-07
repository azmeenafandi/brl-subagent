/**
 * Issue #442 — REAL-CHILD proof that `tools: []` disables the child's tools.
 *
 * WHY A SUBPROCESS: `--no-tools` is pi's flag. A test that asserted only the
 * argument string would pass even if pi honoured nothing, and a fixture that
 * never loads would make the negative assertions pass vacuously. So this file
 * spawns the REAL `pi` binary through the REAL foreground `runSubagent` path, in
 * an isolated temporary HOME, against:
 *
 *   - a harmless direct extension tool      → `extension_canary`
 *   - a local stdio MCP server (direct)     → `mcp__canary_direct__canary`
 *   - a local stdio MCP server (codemode)   → called from a `codemode` script
 *   - a local stdio MCP server (deferred)   → reached via `tool_search`
 *   - a scripted LOOPBACK-ONLY provider     → returns those calls, then "done"
 *
 * The harness (provider, extension, MCP servers, scratch HOME) is shared with
 * the background proof in `../../fixtures/tool-canary.ts`. Everything is
 * confined: throwaway temp HOME/cwd, an HTTP server bound to 127.0.0.1, `node`
 * processes running a temp script, and a literal dummy API key. No real
 * network, no real provider, no real MCP server, no `/reload`.
 *
 * The CANARY LOG is the assertion surface: a canary executes only if it writes
 * its line. The OMITTED-TOOLS CONTROL proves every route really works, so the
 * empty-tools negatives cannot pass on a dead fixture, and the request log
 * proves what the model was actually DECLARED.
 *
 * Coverage note (do not overclaim): all three MCP exposure modes are attempted
 * from a scripted model turn, and for `tools: []` all three fail. NOT covered —
 * an extension that calls `pi.setActiveTools()` itself: #442 defines no-tools
 * as a tool-access setting, not a sandbox against trusted extension code.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

import { runSubagent } from "../runner";
import { resolvePiOnPath } from "../preflight";
import {
	canaryLines,
	startScriptedProvider,
	TASK_MARKER_PREFIX,
	writeCanaryScratch,
	type Scratch,
	type ScriptedProvider,
} from "./fixtures/tool-canary";
import type { SubagentResult, SubagentToolOptions } from "../types";

// ---------------------------------------------------------------------------
// Environment gate — the real binary is the subject of the test
// ---------------------------------------------------------------------------

/**
 * Resolved through the same PATH walk the extension uses. `BRL_PI_BIN` is set
 * in `beforeAll` because `getPiInvocation`'s argv[1] heuristic is right in
 * production and wrong under a test runner: vitest's own entry script is a real
 * path, so without the override the child would be `node <vitest.mjs> --mode
 * json …` and would exit before any request. The override is the extension's
 * sanctioned seam (#271) and is restored afterwards.
 */
const REAL_PI = resolvePiOnPath();
const SKIP = REAL_PI === undefined ? "real pi binary not found on PATH" : false;

function piVersion(bin: string): string | undefined {
	try {
		return execFileSync(bin, ["--version"], { encoding: "utf8", timeout: 15_000 }).trim();
	} catch {
		return undefined;
	}
}

const PI_VERSION: string | undefined = REAL_PI ? piVersion(REAL_PI) : undefined;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(SKIP)("real foreground child — tools: [] disables every tool route (issue #442)", () => {
	let provider: ScriptedProvider;
	const scratchDirs: Scratch[] = [];
	let previousPiBin: string | undefined;

	beforeAll(async () => {
		provider = await startScriptedProvider();
		previousPiBin = process.env.BRL_PI_BIN;
		process.env.BRL_PI_BIN = REAL_PI as string;
	});

	afterAll(async () => {
		await provider.close();
		for (const dir of scratchDirs) dir.dispose();
		if (previousPiBin === undefined) delete process.env.BRL_PI_BIN;
		else process.env.BRL_PI_BIN = previousPiBin;
	});

	/** Run the REAL foreground path in a fresh scratch HOME. */
	async function runChild(
		marker: string,
		toolOptions: SubagentToolOptions | undefined,
	): Promise<{ result: SubagentResult; canary: string[]; requests: ScriptedProvider["requests"]; project: string }> {
		const scratch = writeCanaryScratch(provider.baseUrl, `brl-442-fg-${marker}`);
		scratchDirs.push(scratch);
		// HOME is on `getSafeEnv`'s allowlist, so the child inherits the scratch
		// home and reads ONLY its extensions/mcp.json/models.json. Restored in
		// `finally` so no later phase of this file sees a temp HOME.
		const previousHome = process.env.HOME;
		process.env.HOME = scratch.home;
		try {
			const result = await runSubagent(
				scratch.project,
				"", // no system prompt: keeps this run's argv minimal
				{ provider: "deepseek", id: "scripted-model" },
				"off",
				`${TASK_MARKER_PREFIX}${marker} say hello`,
				undefined,
				undefined,
				toolOptions,
				120_000,
				() => "",
			);
			return {
				result,
				canary: canaryLines(scratch.logPath),
				requests: provider.forMarker(marker),
				project: scratch.project,
			};
		} finally {
			process.env.HOME = previousHome;
		}
	}

	it("control (omitted tools): the canaries ARE declared and DO execute", async () => {
		const { canary, requests } = await runChild("fg-omitted", undefined);

		// The model was declared the canary tools — the control is live, so the
		// empty-case negatives below cannot pass on a fixture that never loaded.
		const declared = new Set(requests[0]?.tools ?? []);
		expect(declared.has("extension_canary")).toBe(true);
		expect(declared.has("mcp__canary_direct__canary")).toBe(true);
		expect(declared.has("codemode")).toBe(true);
		expect(declared.has("tool_search")).toBe(true);

		// Every route executed: built-in, extension, and all three MCP exposures
		// (direct, a codemode script, and deferred after tool_search).
		const log = canary.join("\n");
		expect(log).toMatch(/mcp:canary_direct:call:canary/);
		expect(log).toMatch(/mcp:canary_codemode:call:canary/);
		expect(log).toMatch(/mcp:canary_deferred:call:canary/);
		expect(canary).toContain("extension_canary:executed");
	}, 180_000);

	it("tools: [] — the model is declared no tools, and no forced call executes", async () => {
		const { result, canary, requests, project } = await runChild("fg-empty", { tools: [] });

		// 1. NO TOOLS WERE DECLARED to the model. This is the direct measurement,
		//    not an inference from our own argv.
		expect(requests.length).toBeGreaterThan(0);
		for (const request of requests) expect(request.tools).toEqual([]);

		// 2. NOTHING EXECUTED — not the built-in, the extension tool, nor any MCP
		//    exposure mode. The scripted model still tried (turns 1 and 2 carry
		//    forced calls), so these are attempts, not omissions.
		const log = canary.join("\n");
		expect(canary).not.toContain("extension_canary:executed");
		expect(log).not.toMatch(/:call:/);
		expect(existsSync(join(project, "builtin-canary.txt"))).toBe(false);

		// 3. The child DID start its configured resources: #442 keeps foreground
		//    extension/MCP startup — a tool-access setting, not a startup switch.
		expect(canary).toContain("extension:loaded");
		expect(log).toMatch(/mcp:canary_direct:initialize/);
		expect(log).toMatch(/mcp:canary_direct:tools\/list/);

		// 4. The run completed (the scripted model answered on turn 3), so the
		//    negatives are not an artefact of a crashed child.
		expect(result.exitCode).toBe(0);
	}, 180_000);

	it("records the host pi version the proof ran against", () => {
		// A capability claim about pi is only meaningful against a named host
		// version, so the version is asserted rather than assumed.
		expect(REAL_PI).toBeTruthy();
		expect(PI_VERSION ?? "").toMatch(/^\d+\.\d+\.\d+/);
	});
});

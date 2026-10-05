/**
 * Tier 2: Subprocess integration tests
 *
 * These tests go beyond Tier 1 (import verification) by actually executing
 * the extension's delegate_task handler in a real subprocess via jiti.
 * This catches runtime errors, parameter resolution issues, and execution
 * flow problems that import-only tests can't detect.
 *
 * Spawn target (issue #271):
 * - The harness spawns a node process that loads the extension via jiti (same
 *   as pi) — that process is NOT pi, so its `process.argv[1]` is the harness
 *   script. Left to the argv[1] heuristic, `getPiInvocation` would "spawn pi"
 *   by re-running the harness, and the tests would pass without exercising
 *   delegation at all.
 * - Instead the harness sets `BRL_PI_BIN` (runSubagent's explicit override) to
 *   the committed `fixtures/stub-pi.mjs` — a deterministic, model-free stub
 *   that speaks pi's JSON-line protocol and logs its invocations. This is the
 *   DEFAULT: no model, network, or cost.
 * - Real pi is OPT-IN only: set `BRL_E2E_REAL_PI=1` and a `pi` on PATH to
 *   point `BRL_PI_BIN` at the real binary. CI has no pi installed, so the
 *   default run must stay on the stub.
 *
 * Approach:
 * - Spawn a node process that loads the extension via jiti (same as pi)
 * - Create minimal mocks for pi (ExtensionAPI) and ctx (ExtensionContext)
 * - Call the execute handler directly with test parameters
 * - Capture and verify the result, and the stub's invocation log
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, unlink, rm } from "fs/promises";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { resolvePiOnPath } from "../preflight";

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = join(__dirname, "..", "..");
const TMP_SCRIPT_DIR = join(PROJECT_ROOT, ".tmp", "e2e-subprocess-tests");

// The committed, deterministic pi stand-in (issue #271).
const STUB_PI_PATH = join(PROJECT_ROOT, "src", "__tests__", "fixtures", "stub-pi.mjs");
// The stub writes here (its cwd is the runner's spawn cwd = TMP_SCRIPT_DIR).
const STUB_LOG_PATH = join(TMP_SCRIPT_DIR, "stub-pi-invocations.jsonl");

// ---------------------------------------------------------------------------
// Spawn target resolution
// ---------------------------------------------------------------------------

// Real pi is opt-in (BRL_E2E_REAL_PI=1) and resolved via preflight's shared
// PATH walk. Default stays on the committed stub: no model, network, or cost.
let realPi: string | undefined;
if (process.env.BRL_E2E_REAL_PI === "1") {
	realPi = resolvePiOnPath();
	if (!realPi) {
		throw new Error("BRL_E2E_REAL_PI=1 but no 'pi' executable found on PATH");
	}
}
const PI_BIN = realPi ?? STUB_PI_PATH;
const STUB_MODE = realPi === undefined;

// ---------------------------------------------------------------------------
// Stub invocation log
// ---------------------------------------------------------------------------

interface StubRecord {
	event: "start" | "end";
	pid: number;
	at: number;
	task: string;
}

async function readStubLog(): Promise<StubRecord[]> {
	let raw: string;
	try {
		raw = await readFile(STUB_LOG_PATH, "utf8");
	} catch (err: any) {
		// A missing log is the legitimate empty case. Any other failure
		// (including JSON parse errors below) must surface, so a corrupt or
		// partial line can't masquerade as "no child spawned".
		if (err?.code === "ENOENT") return [];
		throw err;
	}
	return raw
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line) as StubRecord);
}

/** Start/end timestamps for the invocation whose task contains `needle`. */
function interval(
	records: StubRecord[],
	needle: string,
): { start: number; end: number } {
	const start = records.find((r) => r.event === "start" && r.task.includes(needle));
	const end = records.find((r) => r.event === "end" && r.task.includes(needle));
	if (!start || !end) {
		throw new Error(
			`No complete stub invocation for ${JSON.stringify(needle)}; log: ${JSON.stringify(records)}`,
		);
	}
	return { start: start.at, end: end.at };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Run a delegate_task call via a subprocess that loads the extension through jiti.
 * Returns the captured stdout (JSON result), stderr, and exit code.
 */
async function runDelegateTask(params: object): Promise<{
	exitCode: number;
	stdout: string;
	stderr: string;
}> {
	// Create a temporary node script that loads and executes the extension
	const scriptContent = `
// Route extension log lines to stderr so stdout stays pure JSON
console.log = (...args) => console.error(...args);

// Load jiti from the project's node_modules (devDependency)
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
let jitiFactory;
try {
  jitiFactory = require("jiti");
} catch (e) {
  console.error("JITI_NOT_FOUND:" + e.message);
  process.exit(2);
}

const path = require("path");
const projectRoot = ${JSON.stringify(PROJECT_ROOT)};

// Create jiti instance — same way pi does
const jiti = jitiFactory(projectRoot, {
  interopDefault: true,
  moduleCache: false,
});

// Load the extension
let extModule;
try {
  extModule = jiti("./src/index");
} catch (e) {
  console.error("EXT_LOAD_FAILED:" + e.message);
  process.exit(3);
}

// The extension exports a default function that takes pi (ExtensionAPI)
// We need to call it with a mock pi to register the tools
const registeredTools = new Map();
const registeredCommands = new Map();
const registeredShortcuts = new Map();
const eventHandlers = new Map();

const mockPi = {
  registerTool: (tool) => {
    registeredTools.set(tool.name, tool);
  },
  registerCommand: (name, handler) => {
    registeredCommands.set(name, handler);
  },
  registerShortcut: (key, handler) => {
    registeredShortcuts.set(key, handler);
  },
  on: (event, handler) => {
    if (!eventHandlers.has(event)) eventHandlers.set(event, []);
    eventHandlers.get(event).push(handler);
  },
  appendEntry: () => {},
  sendMessage: () => {},
  ctx: {
    getState: (key) => {
      // Return saved state if key matches, otherwise undefined
      if (key === "brl-subagent") {
        return global.__savedState || undefined;
      }
      return undefined;
    },
    setState: (key, value) => {
      if (key === "brl-subagent") {
        global.__savedState = value;
      }
    },
  },
};

// Initialize the extension by calling the default export
const initFn = typeof extModule === "function" ? extModule : extModule.default;
if (typeof initFn !== "function") {
  console.error("NO_DEFAULT_EXPORT:Extension did not export a function");
  process.exit(4);
}

initFn(mockPi);

// Trigger session_start to initialize state
const sessionHandlers = eventHandlers.get("session_start") || [];
for (const handler of sessionHandlers) {
  try {
    await handler({}, {
      cwd: ${JSON.stringify(TMP_SCRIPT_DIR)},
      model: { provider: "test", id: "test-model" },
      getSystemPrompt: () => "You are a helpful assistant.",
      ui: {
        notify: () => {},
        setStatus: () => {},
        theme: { fg: (_color, text) => text },
      },
      sessionManager: {
        getEntries: () => [],
        appendCustomEntry: () => {},
      },
      hasUI: false,
    });
  } catch (e) {
    // session_start handlers may fail if pi internals are missing — that's OK
  }
}

// Get the registered tool
const tool = registeredTools.get("delegate_task");
if (!tool) {
  console.error("TOOL_NOT_FOUND:delegate_task tool was not registered");
  process.exit(5);
}

// Parse params from command line
const paramsStr = process.argv[2];
let params;
try {
  params = JSON.parse(paramsStr);
} catch (e) {
  console.error("PARAMS_PARSE_FAILED:" + e.message);
  process.exit(6);
}

// Mock context
const mockCtx = {
  cwd: ${JSON.stringify(TMP_SCRIPT_DIR)},
  model: { provider: "test", id: "test-model" },
  getSystemPrompt: () => "You are a helpful assistant.",
  ui: {
    notify: () => {},
    setStatus: () => {},
    theme: { fg: (_color, text) => text },
  },
  sessionManager: {
    getEntries: () => [],
    appendCustomEntry: () => {},
  },
  hasUI: false,
};

// Mock signal — use AbortController
const ac = new AbortController();

// Mock onUpdate callback
const updates = [];
const onUpdate = (partial) => {
  updates.push(partial);
};

// Execute the tool
try {
  const result = await tool.execute("test-call-id", params, ac.signal, onUpdate, mockCtx);
  const output = {
    exitCode: 0,
    result: result,
    updates: updates,
  };
  process.stdout.write(JSON.stringify(output) + "\\n");
  process.exit(0);
} catch (e) {
  const output = {
    exitCode: 1,
    error: e.message || String(e),
    stack: e.stack,
    updates: updates,
  };
  process.stdout.write(JSON.stringify(output) + "\\n");
  process.exit(0); // Exit 0 so we can inspect the error in the result
}
`;

	// Ensure temp directory exists
	mkdirSync(TMP_SCRIPT_DIR, { recursive: true });

	// Reset the stub invocation log so assertions are per-test.
	try {
		await rm(STUB_LOG_PATH, { force: true });
	} catch {}

	// Write the script to a temp file
	const scriptPath = join(TMP_SCRIPT_DIR, `test-${Date.now()}.mjs`);
	writeFileSync(scriptPath, scriptContent, "utf-8");

	try {
		const result = await execFileAsync("node", [scriptPath, JSON.stringify(params)], {
			timeout: 30_000,
			maxBuffer: 1024 * 1024,
			cwd: PROJECT_ROOT,
			// Issue #271: pin the subprocess command so the extension spawns the
			// controlled child instead of re-running this harness.
			env: { ...process.env, BRL_PI_BIN: PI_BIN },
		});
		return {
			exitCode: 0,
			stdout: result.stdout,
			stderr: result.stderr,
		};
	} catch (err: any) {
		return {
			exitCode: err.code ?? 1,
			stdout: err.stdout ?? "",
			stderr: err.stderr ?? err.message ?? String(err),
		};
	} finally {
		// Cleanup the temp script
		try {
			await unlink(scriptPath);
		} catch {}
	}
}

/** Parse the harness subprocess's stdout into its JSON result envelope. */
function parseOutput(result: { stdout: string; stderr: string }): any {
	try {
		return JSON.parse(result.stdout);
	} catch {
		throw new Error(
			`Failed to parse stdout as JSON. stdout: ${result.stdout}, stderr: ${result.stderr}`,
		);
	}
}

/**
 * Check if the helper can actually spawn node and load jiti.
 * Skip all tests if prerequisites are missing.
 */
async function canRunSubprocessTests(): Promise<boolean> {
	try {
		const result = await runDelegateTask({});
		// If we get here, node and jiti are available
		// Check that the script didn't fail on jiti load
		if (result.stderr.includes("JITI_NOT_FOUND")) return false;
		return true;
	} catch {
		return false;
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Tier 2: Subprocess integration tests", () => {
	let canRun = false;

	beforeAll(async () => {
		canRun = await canRunSubprocessTests();
	});

	afterAll(async () => {
		try {
			await unlink("/tmp/test-e2e.txt");
		} catch {}
	});

	it("chain mode executes sequentially", async () => {
		if (!canRun) return; // Skip if prerequisites missing

		const result = await runDelegateTask({
			chain: [{ task: "Say hello" }, { task: "Say goodbye" }],
		});

		// The subprocess should exit cleanly (exit 0 from our script)
		// even if the internal execution fails (we capture errors in JSON)
		expect(result.exitCode).toBe(0);

		const output = parseOutput(result);

		// The result should have a result field (from tool.execute)
		expect(output).toHaveProperty("result");
		expect(output.result).toHaveProperty("content");
		expect(Array.isArray(output.result.content)).toBe(true);

		// The content should be non-empty
		expect(output.result.content.length).toBeGreaterThan(0);
		expect(output.result.content[0]).toHaveProperty("text");

		const text = output.result.content[0].text as string;
		// Issue #271: a re-run harness would surface this parse error on the
		// FIRST argv ("--mode"). Its presence is the vacuous-pass signature.
		expect(text).not.toContain("PARAMS_PARSE_FAILED");

		if (STUB_MODE) {
			// Two delegations actually happened, and the second did not start
			// until the first finished (sequential chain).
			const log = await readStubLog();
			expect(log.filter((r) => r.event === "start")).toHaveLength(2);
			const hello = interval(log, "Say hello");
			const goodbye = interval(log, "Say goodbye");
			expect(hello.end).toBeLessThanOrEqual(goodbye.start);
			expect(text).toContain("stub-pi:");
		}

		console.log("Chain mode result:", text.slice(0, 200));
	});

	it("parallel mode executes concurrently", async () => {
		if (!canRun) return;

		// Explicit delays make the overlap deterministic: the "goodbye" task
		// finishes well before the (still sleeping) "hello" task. The binding
		// margin is goodbye's [delay=120] against the near-simultaneous starts,
		// ~120ms; hello's [delay=700] keeps it overlapping long after. Low flake
		// risk — a scheduler stall would have to exceed ~120ms.
		const result = await runDelegateTask({
			tasks: [
				{ task: "Say hello [delay=700]" },
				{ task: "Say goodbye [delay=120]" },
			],
		});

		expect(result.exitCode).toBe(0);

		const output = parseOutput(result);
		expect(output).toHaveProperty("result");
		expect(output.result).toHaveProperty("content");
		expect(Array.isArray(output.result.content)).toBe(true);
		expect(output.result.content.length).toBeGreaterThan(0);
		expect(output.result.content[0]).toHaveProperty("text");

		const text = output.result.content[0].text as string;
		expect(text).not.toContain("PARAMS_PARSE_FAILED");

		if (STUB_MODE) {
			// Both delegations ran, and their lifetimes overlapped.
			const log = await readStubLog();
			expect(log.filter((r) => r.event === "start")).toHaveLength(2);
			const hello = interval(log, "Say hello");
			const goodbye = interval(log, "Say goodbye");
			expect(hello.start).toBeLessThan(goodbye.end);
			expect(goodbye.start).toBeLessThan(hello.end);
		}

		console.log("Parallel mode result:", text.slice(0, 200));
	});

	it("git mode handles branch workflow", async () => {
		if (!canRun) return;

		// NOTE: assumes the cwd is a git checkout — branch-mode creation
		// requires a repo (the project root is one in development and CI).
		const result = await runDelegateTask({
			task: "Say hello",
			gitMode: "branch",
		});

		expect(result.exitCode).toBe(0);

		const output = parseOutput(result);
		expect(output).toHaveProperty("result");
		expect(output.result).toHaveProperty("content");

		const text = output.result.content?.[0]?.text as string;
		expect(text).not.toContain("PARAMS_PARSE_FAILED");
		// The delegation actually ran (not merely "execute didn't crash").
		expect(output.result.isError).not.toBe(true);

		if (STUB_MODE) {
			const log = await readStubLog();
			expect(log.filter((r) => r.event === "start")).toHaveLength(1);
			// The work branch was created and recorded on the result.
			expect(output.result.details?.gitBranch).toMatch(/^brl-subagent-/);
		}

		console.log("Git mode result:", text?.slice(0, 200));
	});

	it("pre-spawn validation rejects outputFile when the write tool is excluded", async () => {
		if (!canRun) return;

		// A write-restricted "sandbox": the write tool is excluded via the
		// supported toolOptions, and an outputFile (which REQUIRES write) is
		// requested. This is a hard, pre-spawn validation conflict.
		const result = await runDelegateTask({
			task: "Write 'hello' to /tmp/test-e2e.txt",
			outputFile: "e2e-sandbox-report.md",
			excludeTools: ["write", "edit"],
		});

		expect(result.exitCode).toBe(0);

		const output = parseOutput(result);
		expect(output).toHaveProperty("result");
		expect(output.result).toHaveProperty("content");

		const text = output.result.content?.[0]?.text || "";
		expect(text).not.toContain("PARAMS_PARSE_FAILED");
		// The SPECIFIC validation error — not merely "some error".
		expect(output.result.isError).toBe(true);
		expect(text).toContain("outputFile is set but the 'write' tool is not available");
		expect(text).toContain("cannot write the report");

		// Rejected before dispatch — the subagent was never spawned.
		if (STUB_MODE) {
			expect(await readStubLog()).toHaveLength(0);
		}

		console.log("Sandbox enforcement result:", text.slice(0, 200));
	});

	it("unknown template is reported explicitly", async () => {
		if (!canRun) return;

		const result = await runDelegateTask({
			template: "test-template",
			params: { name: "World" },
		});

		expect(result.exitCode).toBe(0);

		const output = parseOutput(result);
		expect(output).toHaveProperty("result");
		expect(output.result).toHaveProperty("content");
		expect(output.result.content.length).toBeGreaterThan(0);

		const text = output.result.content?.[0]?.text || "";
		expect(text).not.toContain("PARAMS_PARSE_FAILED");
		// The unknown template is reported explicitly (previously hidden behind
		// an either/or assertion that any non-crash satisfied).
		expect(output.result.isError).toBe(true);
		expect(text).toContain("Template 'test-template' not found");
		if (STUB_MODE) {
			expect(await readStubLog()).toHaveLength(0);
		}

		console.log("Template resolution result:", text.slice(0, 200));
	});

	it("graph mode schedules with dependencies", async () => {
		if (!canRun) return;

		const result = await runDelegateTask({
			graph: [
				{ id: "a", task: "Say hello", dependsOn: [] },
				{ id: "b", task: "Say goodbye", dependsOn: ["a"] },
			],
		});

		expect(result.exitCode).toBe(0);

		const output = parseOutput(result);
		expect(output).toHaveProperty("result");
		expect(output.result).toHaveProperty("content");
		expect(Array.isArray(output.result.content)).toBe(true);
		expect(output.result.content.length).toBeGreaterThan(0);
		expect(output.result.content[0]).toHaveProperty("text");

		const text = output.result.content[0].text as string;
		expect(text).not.toContain("PARAMS_PARSE_FAILED");

		if (STUB_MODE) {
			// The dependency edge was honoured: "a" finished before "b" started.
			const log = await readStubLog();
			expect(log.filter((r) => r.event === "start")).toHaveLength(2);
			const a = interval(log, "Say hello");
			const b = interval(log, "Say goodbye");
			expect(a.end).toBeLessThanOrEqual(b.start);
		}

		console.log("Graph mode result:", text.slice(0, 200));
	});
});

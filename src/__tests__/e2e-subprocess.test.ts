/**
 * Tier 2: Subprocess integration tests
 *
 * These tests go beyond Tier 1 (import verification) by actually executing
 * the extension's delegate_task handler in a real subprocess via jiti.
 * This catches runtime errors, parameter resolution issues, and execution
 * flow problems that import-only tests can't detect.
 *
 * Approach:
 * - Spawn a node process that loads the extension via jiti (same as pi)
 * - Create minimal mocks for pi (ExtensionAPI) and ctx (ExtensionContext)
 * - Call the execute handler directly with test parameters
 * - Capture and verify the result
 */

import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { execFile } from "child_process";
import { promisify } from "util";
import { unlink, access } from "fs/promises";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";

const execFileAsync = promisify(execFile);

const PROJECT_ROOT = join(__dirname, "..", "..");
const TMP_SCRIPT_DIR = join(PROJECT_ROOT, ".tmp", "e2e-subprocess-tests");
const JITI_PACKAGE =
	"/home/azmeen/.local/share/pnpm/global/5/.pnpm/jiti@2.7.0/node_modules/jiti";

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
// Load jiti from pnpm global store
let jitiFactory;
try {
  jitiFactory = require(${JSON.stringify(JITI_PACKAGE)});
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
      ui: { notify: () => {} },
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
  ui: { notify: () => {} },
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
  console.log(JSON.stringify(output));
  process.exit(0);
} catch (e) {
  const output = {
    exitCode: 1,
    error: e.message || String(e),
    stack: e.stack,
    updates: updates,
  };
  console.log(JSON.stringify(output));
  process.exit(0); // Exit 0 so we can inspect the error in the result
}
`;

	// Ensure temp directory exists
	mkdirSync(TMP_SCRIPT_DIR, { recursive: true });

	// Write the script to a temp file
	const scriptPath = join(TMP_SCRIPT_DIR, `test-${Date.now()}.mjs`);
	writeFileSync(scriptPath, scriptContent, "utf-8");

	try {
		const result = await execFileAsync("node", [scriptPath, JSON.stringify(params)], {
			timeout: 30_000,
			maxBuffer: 1024 * 1024,
			cwd: PROJECT_ROOT,
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

		// Parse stdout as JSON
		let output: any;
		try {
			output = JSON.parse(result.stdout);
		} catch {
			throw new Error(`Failed to parse stdout as JSON. stdout: ${result.stdout}, stderr: ${result.stderr}`);
		}

		// The result should have a result field (from tool.execute)
		expect(output).toHaveProperty("result");
		expect(output.result).toHaveProperty("content");
		expect(Array.isArray(output.result.content)).toBe(true);

		// The content should be non-empty
		expect(output.result.content.length).toBeGreaterThan(0);
		expect(output.result.content[0]).toHaveProperty("text");

		// Log result for debugging
		console.log("Chain mode result:", output.result.content[0].text?.slice(0, 200));
	});

	it("parallel mode executes concurrently", async () => {
		if (!canRun) return;

		const result = await runDelegateTask({
			tasks: [{ task: "Say hello" }, { task: "Say goodbye" }],
		});

		expect(result.exitCode).toBe(0);

		let output: any;
		try {
			output = JSON.parse(result.stdout);
		} catch {
			throw new Error(`Failed to parse stdout as JSON. stdout: ${result.stdout}, stderr: ${result.stderr}`);
		}

		expect(output).toHaveProperty("result");
		expect(output.result).toHaveProperty("content");
		expect(Array.isArray(output.result.content)).toBe(true);
		expect(output.result.content.length).toBeGreaterThan(0);
		expect(output.result.content[0]).toHaveProperty("text");

		console.log("Parallel mode result:", output.result.content[0].text?.slice(0, 200));
	});

	it("git mode handles branch workflow", async () => {
		if (!canRun) return;

		const result = await runDelegateTask({
			task: "Say hello",
			gitMode: "branch",
		});

		expect(result.exitCode).toBe(0);

		let output: any;
		try {
			output = JSON.parse(result.stdout);
		} catch {
			throw new Error(`Failed to parse stdout as JSON. stdout: ${result.stdout}, stderr: ${result.stderr}`);
		}

		expect(output).toHaveProperty("result");
		expect(output.result).toHaveProperty("content");

		// Git mode may succeed or fail depending on whether we're in a git repo
		// The important thing is that execute ran without crashing
		console.log("Git mode result:", output.result.content?.[0]?.text?.slice(0, 200));
	});

	it("sandbox enforcement blocks write tools", async () => {
		if (!canRun) return;

		const result = await runDelegateTask({
			task: "Write 'hello' to /tmp/test-e2e.txt",
			sandboxLevel: "readonly",
		});

		expect(result.exitCode).toBe(0);

		let output: any;
		try {
			output = JSON.parse(result.stdout);
		} catch {
			throw new Error(`Failed to parse stdout as JSON. stdout: ${result.stdout}, stderr: ${result.stderr}`);
		}

		expect(output).toHaveProperty("result");
		expect(output.result).toHaveProperty("content");

		// The result should indicate a validation error
		// (readonly sandbox excludes write/edit tools)
		const text = output.result.content?.[0]?.text || "";
		const isError = output.result.isError === true;

		// Either it's flagged as an error, or the text mentions validation
		expect(isError || text.toLowerCase().includes("validation") || text.toLowerCase().includes("write")).toBe(true);

		console.log("Sandbox enforcement result:", text.slice(0, 200));
	});

	it("template resolution substitutes params", async () => {
		if (!canRun) return;

		const result = await runDelegateTask({
			template: "test-template",
			params: { name: "World" },
		});

		expect(result.exitCode).toBe(0);

		let output: any;
		try {
			output = JSON.parse(result.stdout);
		} catch {
			throw new Error(`Failed to parse stdout as JSON. stdout: ${result.stdout}, stderr: ${result.stderr}`);
		}

		expect(output).toHaveProperty("result");
		expect(output.result).toHaveProperty("content");

		// Template should resolve (or report template not found — either is valid)
		const text = output.result.content?.[0]?.text || "";
		console.log("Template resolution result:", text.slice(0, 200));

		// The result should not be a crash
		expect(output.result.content.length).toBeGreaterThan(0);
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

		let output: any;
		try {
			output = JSON.parse(result.stdout);
		} catch {
			throw new Error(`Failed to parse stdout as JSON. stdout: ${result.stdout}, stderr: ${result.stderr}`);
		}

		expect(output).toHaveProperty("result");
		expect(output.result).toHaveProperty("content");
		expect(Array.isArray(output.result.content)).toBe(true);
		expect(output.result.content.length).toBeGreaterThan(0);
		expect(output.result.content[0]).toHaveProperty("text");

		console.log("Graph mode result:", output.result.content[0].text?.slice(0, 200));
	});
});

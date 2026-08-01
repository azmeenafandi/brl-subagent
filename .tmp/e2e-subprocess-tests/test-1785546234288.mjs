
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
const projectRoot = "/home/azmeen/public_projects/brl-subagent_workspace/brl-subagent-track-tests";

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
      cwd: "/home/azmeen/public_projects/brl-subagent_workspace/brl-subagent-track-tests/.tmp/e2e-subprocess-tests",
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
  cwd: "/home/azmeen/public_projects/brl-subagent_workspace/brl-subagent-track-tests/.tmp/e2e-subprocess-tests",
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
  process.stdout.write(JSON.stringify(output) + "\n");
  process.exit(0);
} catch (e) {
  const output = {
    exitCode: 1,
    error: e.message || String(e),
    stack: e.stack,
    updates: updates,
  };
  process.stdout.write(JSON.stringify(output) + "\n");
  process.exit(0); // Exit 0 so we can inspect the error in the result
}

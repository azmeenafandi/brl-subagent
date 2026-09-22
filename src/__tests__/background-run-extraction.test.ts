/**
 * Phase 1 of issue #198: the inline background-spawn branch of delegate_task's
 * execute() was extracted verbatim into the factory-scope spawnBackgroundRun()
 * helper (behaviour-preserving — see the extraction's diff audit). These tests
 * drive the REAL execute handler with background: true and pin that the
 * extraction kept the branch's observable behaviour:
 *
 *   1. the success result carries the spawned agent id + the wake hint;
 *   2. spawnBackgroundSession is called exactly once with the resolved
 *      task/cwd/model;
 *   3. the foreground runner (runSubagent) is never touched.
 *
 * Harness pattern: src/__tests__/per-step-model.test.ts — setupExtension() +
 * makeCtx() + tool.execute(...), with ../runner mocked so no foreground
 * subprocesses spawn. session-manager's spawnBackgroundSession is additionally
 * stubbed (vi.mock intercepts the extension's DYNAMIC import of the module)
 * while every other export stays real (the session helpers this path would
 * touch only run in the poller, which fake timers suppress).
 *
 * Timer hygiene: the extracted path arms a 2s progress poller and a hard-cap
 * timeout — fake timers keep them from firing and are cleared afterwards so
 * vitest exits with no open handles.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the extension
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
	runSubagent: vi.fn(),
	cleanupTempDirs: vi.fn().mockResolvedValue(0),
	getPiInvocation: vi.fn(),
	accumulateUsage: vi.fn(),
	parseSubagentLine: vi.fn(),
	spawnBackgroundSession: vi.fn(),
	// Fields the extracted block reads on the returned BackgroundAgent:
	// id, description, task, status, model, thinkingLevel, priority, startedAt.
	// _sessionRef stays absent — the poller only reads it when the interval
	// fires, which fake timers prevent.
	fakeAgent: {
		id: "bg-extract-001",
		sessionId: "sess-bg-extract-001",
		type: "general-purpose",
		description: "Background subagent (test double)",
		status: "running",
		startedAt: 1700000000000,
		task: "Task the spawn stub reports back",
		model: "test/test-model",
		thinkingLevel: "medium",
		priority: "normal",
	},
}));

vi.mock("../runner", () => ({
	runSubagent: h.runSubagent,
	cleanupTempDirs: h.cleanupTempDirs,
	getPiInvocation: h.getPiInvocation,
	accumulateUsage: h.accumulateUsage,
	parseSubagentLine: h.parseSubagentLine,
}));

// The extension destructures spawnBackgroundSession out of a DYNAMIC
// import('./session-manager') inside the background branch — vi.mock
// intercepts dynamic imports too. Spread the real module so the state/session
// helpers (and the __setStorageDir redirect) stay real; stub only the spawn.
vi.mock("../session-manager", async (importOriginal) => ({
	...(await importOriginal<typeof import("../session-manager")>()),
	spawnBackgroundSession: h.spawnBackgroundSession,
}));

// tui.ts imports these at runtime; runner.ts's pi import never runs (module mocked).
vi.mock("@earendil-works/pi-coding-agent", () => {
	class DynamicBorder {}
	const getMarkdownTheme = () => ({});
	return { DynamicBorder, getMarkdownTheme };
});

vi.mock("@earendil-works/pi-tui", () => {
	class Container {}
	class SelectList {}
	class Spacer {}
	class Text {}
	class Markdown {}
	return { Container, SelectList, Spacer, Text, Markdown };
});

import initExtension from "../index";
// The setters redirect the real execute handler's transcript (and
// agent-record) writes away from the repo .pi/ — they reach the SAME module
// instance index.ts's dynamic import('./transcript' / './session-manager')
// resolves to (vitest module cache).
import { __setOutputDir } from "../transcript";
import { __setStorageDir } from "../session-manager";

// ---------------------------------------------------------------------------
// Harness (minimal copy of the per-step-model pattern)
// ---------------------------------------------------------------------------

const GLOBAL_MODEL = { provider: "test", id: "test-model" };
const TASK = "Draft the phase-1 extraction summary document.";

interface ToolEntry {
	name: string;
	execute: (
		toolCallId: string,
		params: Record<string, unknown>,
		signal: undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details?: unknown;
		isError?: boolean;
	}>;
}

let tool: ToolEntry;
let testCwd: string;
let tempPiBase = "";

function setupExtension(): ToolEntry {
	const registeredTools = new Map<string, ToolEntry>();
	const mockPi = {
		registerTool: (t: ToolEntry) => registeredTools.set(t.name, t),
		registerCommand: () => {},
		registerShortcut: () => {},
		on: () => {},
		appendEntry: () => {},
		sendMessage: () => {},
		ctx: {
			getState: () => undefined,
			setState: () => {},
		},
	};
	initExtension(mockPi as never);
	const toolEntry = registeredTools.get("delegate_task");
	if (!toolEntry) throw new Error("delegate_task tool not registered");
	return toolEntry;
}

/** Model registry mock: the global test model is catalogued and authed. */
function makeRegistry(): {
	find: (provider: string, id: string) => { provider: string; id: string } | undefined;
	hasConfiguredAuth: (model: { provider: string; id: string }) => boolean;
} {
	return {
		find: (provider, id) =>
			provider === GLOBAL_MODEL.provider && id === GLOBAL_MODEL.id
				? { provider, id }
				: undefined,
		hasConfiguredAuth: () => true,
	};
}

function makeCtx() {
	return {
		cwd: testCwd,
		model: GLOBAL_MODEL,
		modelRegistry: makeRegistry(),
		getSystemPrompt: () => "You are a helpful assistant.",
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: {
			getEntries: () => [],
			appendCustomEntry: () => {},
		},
		hasUI: false,
	};
}

beforeEach(() => {
	if (tempPiBase) fs.rmSync(tempPiBase, { recursive: true, force: true });
	if (testCwd) fs.rmSync(testCwd, { recursive: true, force: true });
	tempPiBase = fs.mkdtempSync(path.join(os.tmpdir(), "brl-bg-extract-pi-"));
	// Redirect transcript/storage writes out of the repo .pi/.
	__setOutputDir(path.join(tempPiBase, "output"));
	__setStorageDir(path.join(tempPiBase, "subagents"));
	testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "brl-bg-extract-"));

	h.runSubagent.mockReset();
	h.spawnBackgroundSession.mockReset().mockResolvedValue(h.fakeAgent);
	tool = setupExtension();
});

afterEach(() => {
	// Belt-and-braces: no poller interval / hard-cap timeout may outlive a test.
	vi.clearAllTimers();
	vi.useRealTimers();
});

afterAll(() => {
	if (tempPiBase) fs.rmSync(tempPiBase, { recursive: true, force: true });
	if (testCwd) fs.rmSync(testCwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// The extracted spawnBackgroundRun path (background: true, single mode)
// ---------------------------------------------------------------------------

describe("spawnBackgroundRun extraction (#198 phase 1)", () => {
	it("spawns exactly one background run with the resolved values and never touches the foreground runner", async () => {
		const ctx = makeCtx();

		vi.useFakeTimers();
		let result: Awaited<ReturnType<ToolEntry["execute"]>>;
		try {
			result = await tool.execute(
				"call-bg-single",
				{ task: TASK, background: true },
				undefined,
				undefined,
				ctx,
			);
		} finally {
			// The extracted path arms the 2s progress poller and the hard-cap
			// timeout — clear both so vitest exits with no open handles.
			vi.clearAllTimers();
			vi.useRealTimers();
		}

		// (1) Not an error; the result carries the fake agent id + the wake hint.
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).toContain(h.fakeAgent.id);
		expect(result.content[0].text).toContain(
			"You'll be woken with a completion message when it finishes",
		);

		// (2) The spawn stub was called exactly once with the resolved values:
		// the sanitized task, the validated cwd (= ctx.cwd here), and the
		// model resolved by the prelude (no session_start → no presets →
		// no auto-route → ctx.model).
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
		const spawnCall = h.spawnBackgroundSession.mock.calls[0];
		const spawnParams = spawnCall[2] as {
			task?: string;
			cwd?: string;
			model?: string;
		};
		expect(spawnParams.task).toBe(TASK);
		expect(spawnParams.cwd).toBe(testCwd);
		expect(spawnParams.model).toBe(`${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`);

		// (3) The foreground runner was never called.
		expect(h.runSubagent).not.toHaveBeenCalled();
	});
});

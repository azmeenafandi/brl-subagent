/**
 * Issue #340 — dangling-row fix (foreground single-run pre-start gates).
 *
 * In the foreground single-run path, `persistRun(pi, run, "foreground")` runs
 * BEFORE the circuit-open and concurrency-slot gates, so both early returns
 * used to run `cleanupGitBranch()` only — leaving the persisted record
 * `running` (non-terminal session entry + inflight registry row + live-monitor
 * registration). At the next boot that row is marked interrupted and surfaced
 * as a phantom interrupted run for a dispatch that never started; on a retry
 * it dangling-twins the source row.
 *
 * These tests drive the REAL `delegate_task` execute handler (../runner mocked
 * so no real pi subprocesses spawn) and assert the fixed shape:
 *   - circuit-open dispatch — stored record terminal `failed`, inflight
 *     registry empty for the run, live entry released, returned message
 *     unchanged;
 *   - slot-cancel dispatch — same assertions;
 *   - retry + circuit-open — source registry row intact, twin terminal.
 *
 * Seam choice: `circuit.test.ts` exercises the `SessionState` API only, not the
 * dispatch path; the tool-path seam lives in the extensions that call
 * `tool.execute(...)` (`integration.test.ts` covers params/finalize helpers,
 * `preflight.test.ts` covers the preflight helper). `retry-pins.test.ts` is the
 * closest harness (captures `delegate_task` + `pi.appendEntry`), so this file
 * reuses that shape. The internal `SessionState` instance is captured by
 * wrapping `createSessionState`, which lets the test set the gate condition
 * directly and asserts the real state outcomes (`listInflightRuns`,
 * `isLiveEntryFinalized`).
 *
 * Harness cloned from retry-pins.test.ts (hoisted ../runner mock; tui module
 * mocks; the shared temp-lifecycle fixture redirects transcript/agent/registry
 * writes away from the repo .pi/).
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the extension
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
	runSubagent: vi.fn(),
	cleanupTempDirs: vi.fn().mockResolvedValue(0),
	reapActiveChildren: vi.fn().mockResolvedValue([]),
	getPiInvocation: vi.fn(),
	accumulateUsage: vi.fn(),
	parseSubagentLine: vi.fn(),
}));

vi.mock("../runner", () => ({
	runSubagent: h.runSubagent,
	cleanupTempDirs: h.cleanupTempDirs,
	reapActiveChildren: h.reapActiveChildren,
	getPiInvocation: h.getPiInvocation,
	accumulateUsage: h.accumulateUsage,
	parseSubagentLine: h.parseSubagentLine,
}));

// Capture the real SessionState instance the extension builds so the test can
// set the gate condition and assert the persisted/live outcomes. Everything
// else in the module (resolveTerminalRunEntry, the class) stays real.
const stateHolder = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock("../state", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../state")>();
	return {
		...actual,
		createSessionState: (log?: unknown) => {
			const s = new actual.SessionState(log as never);
			stateHolder.current = s;
			return s;
		},
	};
});

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
import type { SessionState } from "../state";
import { registerInflightRun, listInflightRuns } from "../run-registry";
import { CUSTOM_ENTRY_TYPES } from "../types";
import type { SubagentRun } from "../types";
import { createTempEnv } from "./fixtures/temp-lifecycle";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_MODEL = { provider: "test", id: "test-model" };

interface ToolEntry {
	name: string;
	execute: (
		callId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{
		content: Array<{ type: string; text: string }>;
		details?: unknown;
		isError?: boolean;
	}>;
}

let tool: ToolEntry;
/** Every `pi.appendEntry(customType, data)` the tool under test makes. */
let capturedEntries: Array<{ customType: string; data: unknown }>;
const env = createTempEnv("brl-dangling-row");

function setupExtension(): ToolEntry {
	const registeredTools = new Map<string, ToolEntry>();
	capturedEntries = [];
	const mockPi = {
		registerTool: (t: ToolEntry) => registeredTools.set(t.name, t),
		registerCommand: () => {},
		registerShortcut: () => {},
		on: () => {},
		appendEntry: (customType: string, data: unknown) => {
			// Clone: the run record is mutated in place at finalize, so a
			// by-reference capture would never show the spawn `running` shape.
			capturedEntries.push({
				customType,
				data: data && typeof data === "object" ? structuredClone(data) : data,
			});
		},
		sendMessage: () => {},
		ctx: {
			getState: () => undefined,
			setState: () => {},
		},
	};
	initExtension(mockPi as never);
	const entry = registeredTools.get("delegate_task");
	if (!entry) throw new Error("delegate_task tool not registered");
	return entry;
}

function makeCtx(entries: unknown[] = []) {
	return {
		cwd: env.testCwd,
		model: GLOBAL_MODEL,
		modelRegistry: {
			find: (provider: string, id: string) =>
				availableKey(provider, id) ? { provider, id } : undefined,
			hasConfiguredAuth: () => true,
		},
		getSystemPrompt: () => "You are a helpful assistant.",
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: {
			getEntries: () => entries,
			appendCustomEntry: () => {},
		},
		hasUI: false,
	};
}

function availableKey(provider: string, id: string): boolean {
	return provider === GLOBAL_MODEL.provider && id === GLOBAL_MODEL.id;
}

const getState = (): SessionState => stateHolder.current as SessionState;

/** Every run entry the tool appended, newest last (spawn before terminal). */
function capturedRuns(): SubagentRun[] {
	return capturedEntries
		.filter((e) => e.customType === CUSTOM_ENTRY_TYPES.run)
		.map((e) => e.data as SubagentRun);
}

/** The run id of the (single) spawn entry captured this test. */
function spawnRunId(): string {
	const spawn = capturedRuns().find((r) => r.status === "running");
	if (!spawn) throw new Error("no spawn run entry captured");
	return spawn.id;
}

/** The terminal entry for `id`, if any. */
function terminalEntry(id: string): SubagentRun | undefined {
	return capturedRuns().find((r) => r.id === id && r.status !== "running");
}

beforeEach(() => {
	env.setUp();
	stateHolder.current = undefined;
	h.runSubagent.mockReset();
	// The real preflight runs before the gates (checkPiBinary); an executable
	// command keeps it green without touching PATH.
	h.getPiInvocation.mockReturnValue({ command: process.execPath, args: [] });
	tool = setupExtension();
});

afterAll(async () => {
	await env.tearDown();
});

// ---------------------------------------------------------------------------
// Circuit-open dispatch
// ---------------------------------------------------------------------------

describe("#340 circuit-open dispatch", () => {
	it("finalizes the persisted record before returning", async () => {
		const state = getState();
		state.config.circuitBreaker.circuitOpen = true;
		state.config.circuitBreaker.consecutiveFailures = 3;
		state.config.circuitBreaker.lastFailureTime = Date.now();

		const result = await tool.execute(
			"call-circuit",
			{ task: "do something" },
			undefined,
			undefined,
			makeCtx(),
		);

		// Returned content/isError unchanged — the caller still sees the gate text.
		expect(result.isError).toBe(true);
		const circuitMessage = result.content[0].text;
		expect(circuitMessage).toContain("Circuit breaker is open");

		const runId = spawnRunId();
		const terminal = terminalEntry(runId);
		expect(terminal).toBeDefined();
		expect(terminal!.status).toBe("failed");
		expect(terminal!.finishedAt).toBeDefined();
		expect(terminal!.durationMs).toBeGreaterThanOrEqual(0);
		expect(terminal!.errorMessage).toBe(circuitMessage);
		expect(terminal!.stopReason).toBe("aborted");
		expect(terminal!.originalParams?.errorCategory).toBe("aborted");
		// Pre-start rejection: empty output and EMPTY_USAGE zero-shape.
		expect(terminal!.cost).toBe(0);
		expect(terminal!.tokensIn).toBe(0);
		expect(terminal!.tokensOut).toBe(0);
		expect(terminal!.outputSummary).toBe("");

		// Inflight registry row cleared (no dangling phantom).
		expect(listInflightRuns().some((r) => r.id === runId)).toBe(false);
		expect(listInflightRuns()).toHaveLength(0);

		// Live-monitor registration released.
		expect(state.isLiveEntryFinalized(runId)).toBe(true);

		// Gate rejected before any spawn.
		expect(h.runSubagent).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Slot-cancel dispatch
// ---------------------------------------------------------------------------

describe("#340 slot-cancel dispatch", () => {
	it("finalizes the persisted record before returning", async () => {
		const state = getState();
		// maxParallel 1 with the single slot already held forces the next
		// dispatch to queue; aborting then makes acquireSlot resolve false.
		state.config.maxParallel = 1;
		state.activeSubagents = 1;

		const controller = new AbortController();
		const promise = tool.execute(
			"call-slot",
			{ task: "wait then cancel" },
			controller.signal,
			undefined,
			makeCtx(),
		);
		// The dispatch reaches acquireSlot synchronously and registers its abort
		// listener before execute() yields, so this abort lands while queued.
		controller.abort();
		const result = await promise;

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toBe(
			"Subagent cancelled while waiting for concurrency slot.",
		);

		const runId = spawnRunId();
		const terminal = terminalEntry(runId);
		expect(terminal).toBeDefined();
		expect(terminal!.status).toBe("failed");
		expect(terminal!.finishedAt).toBeDefined();
		expect(terminal!.durationMs).toBeGreaterThanOrEqual(0);
		expect(terminal!.errorMessage).toBe(
			"Subagent cancelled while waiting for concurrency slot.",
		);
		expect(terminal!.stopReason).toBe("aborted");
		expect(terminal!.originalParams?.errorCategory).toBe("aborted");
		// Pre-start rejection: empty output and EMPTY_USAGE zero-shape.
		expect(terminal!.cost).toBe(0);
		expect(terminal!.tokensIn).toBe(0);
		expect(terminal!.tokensOut).toBe(0);
		expect(terminal!.outputSummary).toBe("");

		expect(listInflightRuns().some((r) => r.id === runId)).toBe(false);
		expect(state.isLiveEntryFinalized(runId)).toBe(true);
		expect(h.runSubagent).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Retry + circuit-open
// ---------------------------------------------------------------------------

describe("#340 retry + circuit-open", () => {
	it("leaves the source registry row intact and records the twin terminal", async () => {
		const state = getState();
		state.config.circuitBreaker.circuitOpen = true;
		state.config.circuitBreaker.consecutiveFailures = 3;
		state.config.circuitBreaker.lastFailureTime = Date.now();

		const sourceId = "11111111-1111-4111-8111-111111111111";
		const source: SubagentRun = {
			id: sourceId,
			task: "original task",
			status: "failed",
			startedAt: new Date(Date.now() - 10_000).toISOString(),
			originalParams: {},
		};
		// The source survives in the durable registry (simulating an interrupted
		// run awaiting retry) and in the session (for findSpawnRunById).
		registerInflightRun({
			id: sourceId,
			kind: "foreground",
			startedAt: source.startedAt,
			task: source.task,
		});

		const ctx = makeCtx([
			{ type: "custom", customType: CUSTOM_ENTRY_TYPES.run, data: source },
		]);
		const result = await tool.execute(
			"call-retry",
			{ retryRunId: sourceId },
			undefined,
			undefined,
			ctx,
		);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Circuit breaker is open");

		const twinId = spawnRunId();
		expect(twinId).not.toBe(sourceId);
		const twinTerminal = terminalEntry(twinId);
		expect(twinTerminal).toBeDefined();
		expect(twinTerminal!.status).toBe("failed");
		expect(twinTerminal!.stopReason).toBe("aborted");
		expect(twinTerminal!.originalParams?.errorCategory).toBe("aborted");
		// Pre-start rejection: empty output and EMPTY_USAGE zero-shape.
		expect(twinTerminal!.cost).toBe(0);
		expect(twinTerminal!.tokensIn).toBe(0);
		expect(twinTerminal!.tokensOut).toBe(0);
		expect(twinTerminal!.outputSummary).toBe("");

		// Source row intact and retryable; no dangling twin row.
		const rows = listInflightRuns();
		expect(rows.some((r) => r.id === sourceId)).toBe(true);
		expect(rows.some((r) => r.id === twinId)).toBe(false);
		expect(rows).toHaveLength(1);
	});
});

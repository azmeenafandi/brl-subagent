/**
 * Issue #365 — a transport-class background failure auto-retries ONCE.
 *
 * The 2026-10 cycle lost four background dispatches to `Connection error.`
 * (`exit_error`, before any file work) and every one was recovered by hand.
 * The fix is a bounded, mechanical replay: a background run that settled with a
 * transport-class failure is re-dispatched once through the existing
 * `retryRunId` machinery (recorded params restored, lineage recorded as
 * `resumeOf` + `attempt: 2`), its own completion notice is suppressed, and the
 * retry's settle is the wake.
 *
 * Two layers are pinned here:
 *
 *   1. the PURE predicate (`src/transport-retry.ts`) as a matrix — every
 *      condition failing alone turns it off;
 *   2. the handler (`deliverCompletionAlert` in src/index.ts) driven through the
 *      REAL extension with a stubbed spawn and a capturing `sendMessage` /
 *      `ui.notify` — exactly one spawn, no source completion message, one
 *      toast, and the retry's own settle notifying normally.
 *
 * Harness modeled on terminal-notice-dedupe.test.ts (partial session-manager
 * mock, mocked ../runner, temp dirs redirected, ONE extension instance for the
 * whole file because each init appends another permanent event-bus listener).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

import type { SubagentRun } from "../types";

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
	getAgent: vi.fn(),
}));

vi.mock("../runner", () => ({
	runSubagent: h.runSubagent,
	cleanupTempDirs: h.cleanupTempDirs,
	getPiInvocation: h.getPiInvocation,
	accumulateUsage: h.accumulateUsage,
	parseSubagentLine: h.parseSubagentLine,
}));

vi.mock("../session-manager", async (importOriginal) => ({
	...(await importOriginal<typeof import("../session-manager")>()),
	spawnBackgroundSession: h.spawnBackgroundSession,
	getAgent: h.getAgent,
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

import * as eventBus from "../event-bus";
import initExtension from "../index";
import { __resetTerminalClaims } from "../notify-completion";
import { isTransportRetryable, TRANSPORT_RETRY_TOAST } from "../transport-retry";
import { CUSTOM_ENTRY_TYPES } from "../types";
import { createTempEnv } from "./fixtures/temp-lifecycle";

// ---------------------------------------------------------------------------
// 1. The predicate matrix (pure — no pi, no state)
// ---------------------------------------------------------------------------

const SOURCE_ID = "bg-365-source";

/** A settled background run that the predicate SHOULD match. */
function settledRun(overrides: Partial<SubagentRun> = {}): SubagentRun {
	return {
		id: SOURCE_ID,
		task: "review the docs",
		label: "review-docs",
		status: "failed",
		model: "test/test-model",
		thinkingLevel: "medium",
		startedAt: "2026-10-23T10:00:00.000Z",
		durationMs: 245_000,
		errorCategory: "exit_error",
		errorMessage: "Connection error.",
		attempt: 1,
		originalParams: { background: true, model: "test/test-model" },
		...overrides,
	};
}

describe("isTransportRetryable (issue #365)", () => {
	it("matches a transport failure on the original background dispatch", () => {
		expect(isTransportRetryable(settledRun())).toBe(true);
	});

	it("matches every transport signature case-insensitively", () => {
		for (const message of [
			"Connection error.",
			"ECONNRESET",
			"econnrefused while connecting",
			"socket hang up",
			"TypeError: fetch failed",
			"Network error: offline",
			"connect ETIMEDOUT 10.0.0.1:443",
			"getaddrinfo ENOTFOUND api.example.com",
			"EAI_AGAIN",
		]) {
			expect(isTransportRetryable(settledRun({ errorMessage: message }))).toBe(true);
		}
	});

	it("falls back to the legacy originalParams.errorCategory", () => {
		const run = settledRun({ errorCategory: undefined });
		run.originalParams = { background: true, errorCategory: "exit_error" };
		expect(isTransportRetryable(run)).toBe(true);
	});

	// Each condition failing ALONE must turn the predicate off.

	it("rejects a non-transport message", () => {
		expect(isTransportRetryable(settledRun({ errorMessage: "Pre-flight validation failed" }))).toBe(false);
	});

	it("rejects a missing message", () => {
		expect(isTransportRetryable(settledRun({ errorMessage: undefined }))).toBe(false);
	});

	it("rejects attempt 2 — the retry that failed again surfaces normally (no chain)", () => {
		expect(isTransportRetryable(settledRun({ attempt: 2 }))).toBe(false);
	});

	it("rejects a run with no originalParams (fan-out units are out of scope)", () => {
		expect(isTransportRetryable(settledRun({ originalParams: undefined }))).toBe(false);
	});

	it("rejects a foreground run", () => {
		expect(isTransportRetryable(settledRun({ originalParams: { background: false } }))).toBe(false);
	});

	it("rejects a run whose originalParams never recorded background", () => {
		expect(isTransportRetryable(settledRun({ originalParams: { model: "test/test-model" } }))).toBe(false);
	});

	it("rejects a timeout-class failure", () => {
		expect(
			isTransportRetryable(settledRun({ errorCategory: "timeout", errorMessage: "Connection error." })),
		).toBe(false);
	});

	it("rejects a run that did not fail", () => {
		expect(isTransportRetryable(settledRun({ status: "done" }))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// 2. The handler — driven through the real extension
// ---------------------------------------------------------------------------

const GLOBAL_MODEL = { provider: "test", id: "test-model" };
const env = createTempEnv("brl-fix365");

interface Captured {
	message: Record<string, unknown>;
	options: Record<string, unknown> | undefined;
}

interface Notified {
	message: string;
	level: string | undefined;
}

let captured: Captured[] = [];
let notified: Notified[] = [];

interface ToolEntry {
	name: string;
	execute: (
		callId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown; isError?: boolean }>;
}

let sessionStartHandler:
	| ((_event: unknown, ctx: Record<string, unknown>) => Promise<void>)
	| undefined;
let activeCtx: Record<string, unknown>;
/** The run entries `state.getRunEntries(ctx)` sees — set per test. */
let sessionEntries: Array<Record<string, unknown>> = [];

let spawnSeq = 0;
const agentsById = new Map<string, Record<string, unknown>>();

function makeFakeAgent(p: { description?: string; task?: string }): Record<string, unknown> {
	spawnSeq += 1;
	return {
		id: `bg-365-${spawnSeq}`,
		sessionId: `sess-bg-365-${spawnSeq}`,
		type: "general-purpose",
		description: p.description ?? "",
		status: "running",
		startedAt: 1700000000000 + spawnSeq,
		task: p.task ?? "",
		model: `${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`,
		thinkingLevel: "medium",
		priority: "normal",
	};
}

/** A settled background agent record the wake resolves via getAgent. */
function registerSettledAgent(id: string, error: string): Record<string, unknown> {
	const agent = { ...makeFakeAgent({ description: "review-docs", task: "review the docs" }), id };
	agent.status = "failed";
	agent.error = error;
	agent.completedAt = 1700000000000;
	agentsById.set(id, agent);
	return agent;
}

function setupExtension(): void {
	const registeredTools = new Map<string, ToolEntry>();
	const mockPi = {
		registerTool: (t: ToolEntry) => registeredTools.set(t.name, t),
		registerCommand: () => {},
		registerShortcut: () => {},
		on: (event: string, handler: (_event: unknown, ctx: Record<string, unknown>) => Promise<void>) => {
			if (event === "session_start") sessionStartHandler = handler;
		},
		appendEntry: () => {},
		sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => {
			captured.push({ message, options });
		},
		ctx: {
			getState: () => undefined,
			setState: () => {},
		},
	};
	initExtension(mockPi as never);
	if (!registeredTools.get("delegate_task")) throw new Error("delegate_task tool not registered");
}

function makeRegistry() {
	return {
		find: (provider: string, id: string) =>
			`${provider}/${id}` === `${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`
				? { provider, id }
				: undefined,
		hasConfiguredAuth: () => true,
	};
}

/** Build the session ctx; `sessionEntries` is the mutable run-entry source. */
function makeCtx(): Record<string, unknown> {
	return {
		cwd: env.testCwd,
		model: GLOBAL_MODEL,
		modelRegistry: makeRegistry(),
		getSystemPrompt: () => "You are a helpful assistant.",
		ui: {
			notify: (message: string, level?: string) => notified.push({ message, level }),
			setStatus: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: {
			getEntries: () => sessionEntries,
			appendCustomEntry: () => {},
		},
		hasUI: false,
	};
}

async function startSession(): Promise<void> {
	activeCtx = makeCtx();
	if (sessionStartHandler) await sessionStartHandler({}, activeCtx);
}

/** Push a run entry the session-manager would have persisted. */
function persistRunEntry(run: SubagentRun): void {
	sessionEntries.push({ type: "custom", customType: CUSTOM_ENTRY_TYPES.run, data: run });
}

/** Flush the wake's async dynamic import + delivery (the import needs a macrotask turn). */
async function flush(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** Emit the terminal event the session-manager settles with. */
async function settle(id: string): Promise<void> {
	eventBus.emit(eventBus.createEvent("subagent:failed", id, { error: "Connection error." }));
	await flush();
}

function messagesOfType(type: string): Captured[] {
	return captured.filter((c) => c.message.customType === type);
}

function terminalMessages(): Captured[] {
	return captured.filter(
		(c) =>
			c.message.customType === "subagent-completion" ||
			c.message.customType === "subagent-notification",
	);
}

beforeAll(async () => {
	env.setUp();
	setupExtension();
	await startSession();
});

beforeEach(() => {
	captured = [];
	notified = [];
	spawnSeq = 0;
	agentsById.clear();
	sessionEntries = [];
	__resetTerminalClaims();
	h.spawnBackgroundSession.mockReset();
	h.getAgent.mockReset();
	h.spawnBackgroundSession.mockImplementation(
		async (_pi: unknown, _ctx: unknown, p: { description?: string; task?: string }) => {
			const agent = makeFakeAgent(p);
			agentsById.set(agent.id as string, agent);
			return agent;
		},
	);
	h.getAgent.mockImplementation((id: string) => agentsById.get(id) ?? null);
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

afterAll(async () => {
	await env.tearDown();
});

describe("deliverCompletionAlert — transport auto-retry (issue #365)", () => {
	it("re-dispatches once with the restored params and the source run, suppressing the source notice", async () => {
		vi.useFakeTimers();
		try {
			registerSettledAgent(SOURCE_ID, "Connection error.");
			persistRunEntry(
				settledRun({
					dispatchId: "disp-365",
					originalParams: {
						background: true,
						model: "test/test-model",
						thinkingLevel: "high",
						timeout: 600_000,
						cwd: env.testCwd,
					},
				}),
			);

			await settle(SOURCE_ID);

			// Exactly one spawn, carrying the source run's identity + recorded params.
			expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
			const spawn = h.spawnBackgroundSession.mock.calls[0][2] as Record<string, unknown>;
			expect(spawn.task).toBe("review the docs");
			expect(spawn.description).toBe("review-docs");
			expect(spawn.model).toBe("test/test-model");
			expect(spawn.timeout).toBe(600_000);
			// The lineage the retryRunId machinery mints (attempt 2, resumes the source).
			expect(spawn.attempt).toBe(2);
			expect(spawn.resumeOf).toBe(SOURCE_ID);
			expect(spawn.dispatchId).toBe("disp-365");
			// The retry's own record still says background — the attempt guard, not
			// the snapshot, is what bounds the loop.
			const restored = spawn.originalParams as Record<string, unknown>;
			expect(restored.background).toBe(true);
			// The recorded params (not this call's) are what the retry restores.
			expect(restored.thinkingLevel).toBe("high");
			expect(restored.timeout).toBe(600_000);

			// The source run's completion notice is suppressed: the retry is the wake.
			expect(terminalMessages()).toHaveLength(0);
			// …and the user is told, once.
			expect(notified).toEqual([{ message: TRANSPORT_RETRY_TOAST, level: "warning" }]);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	it("the retry's own settle notifies normally (one wake, no second retry)", async () => {
		vi.useFakeTimers();
		try {
			registerSettledAgent(SOURCE_ID, "Connection error.");
			persistRunEntry(settledRun({ dispatchId: "disp-365" }));

			await settle(SOURCE_ID);
			expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
			const retryId = h.spawnBackgroundSession.mock.results[0].value
				? (await h.spawnBackgroundSession.mock.results[0].value).id as string
				: "";
			expect(retryId).not.toBe("");

			// The retry settles with a transport failure of its own (attempt 2).
			captured = [];
			registerSettledAgent(retryId, "Connection error.");
			persistRunEntry(
				settledRun({ id: retryId, attempt: 2, resumeOf: SOURCE_ID, dispatchId: "disp-365" }),
			);
			await settle(retryId);

			// No chain: attempt 2 surfaces as an ordinary failure.
			expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
			const completions = messagesOfType("subagent-completion");
			expect(completions).toHaveLength(1);
			expect(String(completions[0].message.content)).toContain("— failed");
			// The source toast was the only toast.
			expect(notified).toHaveLength(1);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	it("a non-transport failure surfaces normally — zero spawns", async () => {
		vi.useFakeTimers();
		try {
			registerSettledAgent(SOURCE_ID, "Pre-flight validation failed");
			persistRunEntry(
				settledRun({ errorMessage: "Pre-flight validation failed", errorCategory: "tool_error" }),
			);

			await settle(SOURCE_ID);

			expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
			const completions = messagesOfType("subagent-completion");
			expect(completions).toHaveLength(1);
			expect(String(completions[0].message.content)).toContain("— failed");
			expect(notified).toEqual([]);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	it("a transport failure on an attempt-2 run surfaces normally — zero spawns (no loop)", async () => {
		vi.useFakeTimers();
		try {
			registerSettledAgent(SOURCE_ID, "Connection error.");
			persistRunEntry(settledRun({ attempt: 2, resumeOf: "bg-365-original" }));

			await settle(SOURCE_ID);

			expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
			const completions = messagesOfType("subagent-completion");
			expect(completions).toHaveLength(1);
			expect(String(completions[0].message.content)).toContain("— failed");
			expect(notified).toEqual([]);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	it("a throwing spawn falls back to the normal failure notice (never a silent drop)", async () => {
		vi.useFakeTimers();
		try {
			registerSettledAgent(SOURCE_ID, "Connection error.");
			persistRunEntry(settledRun());
			h.spawnBackgroundSession.mockRejectedValue(new Error("no session slot"));

			await settle(SOURCE_ID);

			expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
			const completions = messagesOfType("subagent-completion");
			expect(completions).toHaveLength(1);
			expect(String(completions[0].message.content)).toContain("— failed");
			// No toast: the retry never got scheduled.
			expect(notified).toEqual([]);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});
});

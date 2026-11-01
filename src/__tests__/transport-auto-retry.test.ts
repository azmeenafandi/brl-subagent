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
import * as fs from "node:fs";
import * as path from "node:path";

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
	/**
	 * Issue #401: `resolveSubagentParams` is wrapped, not replaced, so the suite
	 * can assert WHAT PRECEDED RESOLUTION — the routing-isolation and
	 * non-compounding pins read the `task` each resolution actually saw.
	 */
	resolveSubagentParams: vi.fn(),
}));

vi.mock("../params", async (importOriginal) => {
	const orig = await importOriginal<typeof import("../params")>();
	h.resolveSubagentParams.mockImplementation(orig.resolveSubagentParams);
	return { ...orig, resolveSubagentParams: h.resolveSubagentParams };
});

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
import { backgroundSessionDir } from "../session-manager";
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
/** The registered `delegate_task` tool (used by the manual-retry pin). */
let delegateTool: ToolEntry;
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
	const registered = registeredTools.get("delegate_task");
	if (!registered) throw new Error("delegate_task tool not registered");
	delegateTool = registered;
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

const LOG_FILE = () => path.join(env.testCwd, ".pi", "subagent-logs", "brl-subagent.log");

/** Parse the shared log sink written during the current test. */
function logEntries(): Array<{ message: string; data?: Record<string, unknown> }> {
	const file = LOG_FILE();
	if (!fs.existsSync(file)) return [];
	return fs
		.readFileSync(file, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

const RETRY_SCHEDULED = "Background run settled — transport auto-retry scheduled";

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
	// Isolate the log assertions: the sink is shared for the whole file.
	fs.rmSync(LOG_FILE(), { force: true });
	__resetTerminalClaims();
	// Clear CALLS only — the wrapper's implementation is installed once, at mock
	// factory time, and must survive every reset.
	h.resolveSubagentParams.mockClear();
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
			// Issue #411: the task is byte-identical to the recorded original; the
			// resume preamble rides its own field on the system-prompt side.
			expect(spawn.task).toBe("review the docs");
			expect(String(spawn.resumeContext)).toContain("[attempt 2 — ");
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

			// The scheduled log is the machine-readable half of the same event
			// (the toast is only the user-facing half): source id + retried attempt.
			const scheduled = logEntries().filter((e) => e.message === RETRY_SCHEDULED);
			expect(scheduled).toHaveLength(1);
			expect(scheduled[0].data).toEqual({ sourceId: SOURCE_ID, attempt: 2 });
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

	it("an error-result spawn (gate rejection) falls back to the normal failure notice", async () => {
		vi.useFakeTimers();
		try {
			registerSettledAgent(SOURCE_ID, "Connection error.");
			// approvalMode 'always' cannot run in background, so the retry's own
			// gate rejects it before the session spawn: spawnBackgroundRun returns
			// an isError result rather than throwing.
			persistRunEntry(
				settledRun({ originalParams: { background: true, approvalMode: "always" } }),
			);

			await settle(SOURCE_ID);

			// Exactly one retry attempt, rejected before any session spawn.
			expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
			expect(
				logEntries().filter(
					(e) =>
						e.message ===
						"Transport auto-retry spawn rejected — surfacing the original failure",
				),
			).toHaveLength(1);
			// The source failure notice is delivered (never a silent drop).
			const completions = messagesOfType("subagent-completion");
			expect(completions).toHaveLength(1);
			expect(String(completions[0].message.content)).toContain("— failed");
			// No toast and no scheduled log: the retry never got scheduled.
			expect(notified).toEqual([]);
			expect(logEntries().filter((e) => e.message === RETRY_SCHEDULED)).toHaveLength(0);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// 3. The resume preamble (issues #401, #411)
//
// The retry used to replay the identical task, so attempt 2 re-read, re-planned
// and re-wrote what attempt 1 had already done. The fix delivers a bounded
// inspect-first block on the CHILD'S SYSTEM PROMPT (a `<resume-context>` entry;
// #411 moved it there, out of the `<task>` fence). Two invariants are pinned here:
//
//   1. the preamble is present (marker, source id, bank path), names no
//      start/steering stub, and names the retained session directory ONLY when
//      it exists (issue #404) — with an ABSOLUTE path, since the retry's child
//      can run in a different cwd;
//   2. the preamble is system-prompt-only — `resolveSubagentParams` and the H1
//      pre-task validation still see the RECORDED ORIGINAL task, so routing,
//      thinking level, model and capability warnings cannot be steered by text
//      the runtime composed itself; the wrapped task stays byte-identical.
// ---------------------------------------------------------------------------

/** The code-reviewer guidance is the resolution evidence for the routing pin. */
const CODE_REVIEWER_GUIDELINE = "For code review of PRs or modules";
const SECURITY_AUDITOR_GUIDELINE = "For security audits and vulnerability assessments";

/** The `task` every `resolveSubagentParams` call saw during this test. */
function resolutionTasks(): string[] {
	return h.resolveSubagentParams.mock.calls.map(
		(call) => (call[0] as { task?: string }).task ?? "",
	);
}

/** The single spawn the retry made, asserting there was exactly one. */
function retrySpawn(): Record<string, unknown> {
	expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
	return h.spawnBackgroundSession.mock.calls[0][2] as Record<string, unknown>;
}

describe("transport auto-retry — resume preamble (issue #401)", () => {
	it("names the retained session only when it exists, with an absolute path", async () => {
		vi.useFakeTimers();
		try {
			const sourceId = "9a1e2d3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
			const sessionDir = backgroundSessionDir(sourceId);
			fs.mkdirSync(sessionDir, { recursive: true });
			fs.writeFileSync(path.join(sessionDir, "2026-10-31T10-00-00.jsonl"), "{}\n");
			try {
				registerSettledAgent(sourceId, "Connection error.");
				persistRunEntry(settledRun({ id: sourceId, label: "review-docs" }));

				await settle(sourceId);

				const resumeContext = String(retrySpawn().resumeContext);
				// Marker + attempts, and the source the preamble is about.
				expect(resumeContext).toContain(`[attempt 2 — the previous attempt (${sourceId}) died on a transport failure.`);
				// The surviving-directory guard, in runtime vocabulary (no internal
				// process terms leak into a prompt a user can see).
				expect(resumeContext).toContain("This directory may already contain its uncommitted edits.");
				// The inspect-first instruction: working tree, recent history, bank.
				expect(resumeContext).toContain("git status --short");
				expect(resumeContext).toContain("git log --oneline -8");
				expect(resumeContext).toContain("/tmp/brl-review-docs-bank.md");
				// The retained session, ABSOLUTE (the child's cwd can differ).
				const pointerLine = resumeContext.split("\n").find((line) => line.includes("retained at"));
				expect(pointerLine).toBeDefined();
				const pointerPath = pointerLine!.match(/retained at (\S+)/)?.[1];
				expect(pointerPath).toBe(path.resolve(sessionDir));
				expect(pointerPath && path.isAbsolute(pointerPath)).toBe(true);
				expect(resumeContext).toContain("newest .jsonl inside");
				// Closing instruction.
				expect(resumeContext).toContain("Continue from what exists; do NOT redo committed, written, or banked work.");
				// A pointer at .pi/output/agent-*.jsonl would be a dead end (a
				// start/steering log, not the conversation).
				expect(resumeContext).not.toContain(".pi/output");
				// Bounded: marker + 3 lines + the pointer line (the task is not here).
				expect(resumeContext.split("\n").length).toBeLessThanOrEqual(5);
			} finally {
				fs.rmSync(sessionDir, { recursive: true, force: true });
			}
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	it("omits the session pointer when no retained session exists", async () => {
		vi.useFakeTimers();
		try {
			const sourceId = "9a1e2d3f-4a5b-4c6d-8e9f-0a1b2c3d4e60";
			const sessionDir = backgroundSessionDir(sourceId);
			fs.rmSync(sessionDir, { recursive: true, force: true });
			registerSettledAgent(sourceId, "Connection error.");
			persistRunEntry(settledRun({ id: sourceId, label: "review-docs" }));

			await settle(sourceId);

			const resumeContext = String(retrySpawn().resumeContext);
			expect(resumeContext).toContain(`/tmp/brl-review-docs-bank.md`);
			expect(resumeContext).not.toContain(path.resolve(sessionDir));
			expect(resumeContext).not.toContain("retained at");
			expect(resumeContext).not.toContain("newest .jsonl inside");
			expect(resumeContext.split("\n").length).toBeLessThanOrEqual(4);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	it("an all-separator label falls back to the sanitized id for the bank path", async () => {
		vi.useFakeTimers();
		try {
			const sourceId = "7c1e2d3f-4a5b-4c6d-8e9f-0a1b2c3d4e5f";
			registerSettledAgent(sourceId, "Connection error.");
			persistRunEntry(settledRun({ id: sourceId, label: "---", resumeOf: undefined }));

			await settle(sourceId);

			const resumeContext = String(retrySpawn().resumeContext);
			expect(resumeContext).toContain(`/tmp/brl-${sourceId}-bank.md`);
			expect(resumeContext).not.toContain("/tmp/brl----bank.md");
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	it("a preamble carrying preset and capability keywords does not change resolution (routing isolation)", async () => {
		vi.useFakeTimers();
		try {
			// The label survives bank-path sanitization, so these keywords (a
			// security-auditor preset keyword AND a bash-class H1 keyword) really
			// are in the preamble. If resolution saw it, the preset would flip to
			// security-auditor and the H1 gate would block the missing 'bash'.
			const sourceId = "bg-401-security-audit-implement-source";
			registerSettledAgent(sourceId, "Connection error.");
			persistRunEntry(
				settledRun({
					id: sourceId,
					label: "security-audit-run-123",
					task: "review the docs",
				}),
			);

			await settle(sourceId);

			const spawn = retrySpawn();
			const resumeContext = String(spawn.resumeContext);
			// The keywords ARE in the resume context (system-prompt side)…
			expect(resumeContext).toContain("/tmp/brl-security-audit-run-123-bank.md");
			// …and never in the task or the shipped system prompt — the resume
			// context is its own trusted section, so the label keyword cannot
			// reach resolution or the preset guidance.
			expect(String(spawn.systemPrompt)).not.toContain("security-audit-run-123");
			// …but resolution saw the recorded ORIGINAL task, and nothing else.
			const seen = resolutionTasks();
			expect(seen).toContain("review the docs");
			expect(seen.every((seenTask) => !seenTask.includes("[attempt"))).toBe(true);
			// Same RESOLVED preset as attempt 1 would get from "review the docs".
			const resolutions = h.resolveSubagentParams.mock.results.map(
				(result) =>
					result.value as {
						resolvedPreset?: { name: string; thinkingLevel?: string };
						autoRouteKeyword?: string;
						thinkingLevel?: string;
					},
			);
			expect(resolutions).toHaveLength(1);
			const resolved = resolutions[0];
			expect(resolved.resolvedPreset?.name).toBe("code-reviewer");
			// The keyword evidence comes from the ORIGINAL task ("review"), not from
			// the preamble's "audit" — the security rule is checked FIRST, so a
			// preamble-visible resolution would have selected security-auditor.
			expect(resolved.autoRouteKeyword).toBe("review");
			// Thinking + model are the values that preset/config produce.
			expect(resolved.resolvedPreset?.thinkingLevel).toBe("high");
			expect(resolved.thinkingLevel).toBe(spawn.thinkingLevel);
			expect(spawn.model).toBe("test/test-model");
			// …and the shipped system prompt carries that preset's guidance.
			expect(String(spawn.systemPrompt)).toContain(CODE_REVIEWER_GUIDELINE);
			expect(String(spawn.systemPrompt)).not.toContain(SECURITY_AUDITOR_GUIDELINE);
			// H1 outcome unchanged: no pre-task warnings, and the dispatch spawned
			// (with the preamble in the validation input the missing 'bash' would
			// have been a capability BLOCK, not a warning).
			expect(
				logEntries().filter((e) => e.message === "Background pre-task validation warnings"),
			).toHaveLength(0);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	it("a retry of an attempt-2 run resolves from the recorded original task — preambles never compound", async () => {
		vi.useFakeTimers();
		try {
			const attempt2Id = "bg-401-attempt-2";
			const attempt2Task =
				"[attempt 2 — the previous attempt (bg-365-source) died on a transport failure.\n" +
				"Continue from what exists; do NOT redo committed, written, or banked work.]\n\n" +
				"review the docs";
			// A LEGACY pre-#411 attempt-2 record: its `task` still carries the
			// attempt-2 preamble, the snapshot keeps the clean original. The
			// precedence pin (`originalParams.task` before `run.task`) must still
			// resolve the clean original from such a record.
			persistRunEntry(
				settledRun({
					id: attempt2Id,
					task: attempt2Task,
					label: "review-docs",
					attempt: 2,
					resumeOf: SOURCE_ID,
					originalParams: {
						background: true,
						model: "test/test-model",
						task: "review the docs",
					},
				}),
			);

			// A manual retry (retryRunId) of that attempt-2 record.
			const result = await delegateTool.execute(
				"call-401",
				{ retryRunId: attempt2Id },
				undefined,
				undefined,
				makeCtx(),
			);
			expect(result.isError).toBeFalsy();

			const spawn = retrySpawn();
			// No second preamble, and the resolution input is the clean original.
			expect(spawn.task).toBe("review the docs");
			expect(spawn.attempt).toBe(3);
			expect(spawn.resumeOf).toBe(attempt2Id);
			expect(resolutionTasks()).toContain("review the docs");
			expect(resolutionTasks().every((seenTask) => !seenTask.includes("[attempt"))).toBe(true);
			// A manual retry gets no resume context (the auto-retry preamble is
			// rebuilt per auto-retry, never recorded) — and the new record's
			// `task` is the un-prefixed original, so the NEXT retry resolves clean.
			expect(spawn.resumeContext).toBeUndefined();
			expect((spawn.originalParams as Record<string, unknown>).task).toBeUndefined();
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});
});

describe("transport auto-retry — resume context is system-side (issue #411)", () => {
	it("the retry's task is byte-identical to the original and the resume context rides its own field", async () => {
		vi.useFakeTimers();
		try {
			registerSettledAgent(SOURCE_ID, "Connection error.");
			persistRunEntry(settledRun({ task: "review the docs" }));

			await settle(SOURCE_ID);

			const spawn = retrySpawn();
			// The falsifier: the task handed to the spawn (which the real
			// spawnBackgroundSession persists verbatim as the run entry's `task`)
			// is the clean original — never the resume preamble.
			expect(spawn.task).toBe("review the docs");
			expect(String(spawn.task)).not.toContain("[attempt");
			// …and the recorded snapshot's task is the same byte-identical value.
			const originalParams = spawn.originalParams as Record<string, unknown>;
			expect(originalParams).toBeDefined();
			expect(originalParams.task).toBe("review the docs");
			expect(spawn.task).toBe(originalParams.task);
			// The resume context moved to its own field (system-prompt side).
			expect(String(spawn.resumeContext)).toContain("[attempt 2 — ");
			expect(String(spawn.resumeContext)).toContain(
				"Continue from what exists; do NOT redo committed, written, or banked work.",
			);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	it("attempt 3 never compounds: a manual retry of an auto-retried record stays clean", async () => {
		vi.useFakeTimers();
		try {
			// Phase A: drive the real auto-retry to mint the attempt-2 spawn.
			registerSettledAgent(SOURCE_ID, "Connection error.");
			persistRunEntry(settledRun({ task: "review the docs" }));
			await settle(SOURCE_ID);
			const attempt2 = retrySpawn();
			expect(attempt2.task).toBe("review the docs");
			expect(String(attempt2.resumeContext)).toContain("[attempt 2 — ");

			const attempt2Id = h.spawnBackgroundSession.mock.results[0].value
				? (await h.spawnBackgroundSession.mock.results[0].value).id as string
				: "";
			expect(attempt2Id).not.toBe("");

			// The attempt-2 record AS THE NEW CODE WRITES IT: clean task,
			// snapshot carries the clean original, resumeContext is not persisted.
			h.spawnBackgroundSession.mockClear();
			persistRunEntry(
				settledRun({
					id: attempt2Id,
					task: "review the docs",
					label: "review-docs",
					attempt: 2,
					resumeOf: SOURCE_ID,
					originalParams: { background: true, model: "test/test-model", task: "review the docs" },
				}),
			);

			// Phase B: a manual retry of that attempt-2 record mints attempt 3.
			const result = await delegateTool.execute(
				"call-411-attempt3",
				{ retryRunId: attempt2Id },
				undefined,
				undefined,
				makeCtx(),
			);
			expect(result.isError).toBeFalsy();

			const spawn = retrySpawn();
			expect(spawn.attempt).toBe(3);
			expect(spawn.resumeOf).toBe(attempt2Id);
			// The recorded task stays the original, with no attempt-2 text.
			expect(spawn.task).toBe("review the docs");
			expect(String(spawn.task)).not.toContain("[attempt");
			// Manual retries carry no resume context (the auto-retry preamble is
			// rebuilt per auto-retry, never recorded, never compounded).
			expect(spawn.resumeContext).toBeUndefined();
			expect((spawn.originalParams as Record<string, unknown>).task).toBeUndefined();
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});
});

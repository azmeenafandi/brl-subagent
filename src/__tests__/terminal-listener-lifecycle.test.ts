/**
 * Issue #437 — a runtime's terminal event-bus listeners must not outlive it.
 *
 * A clean session replacement (`/new`, `/resume`, `/fork`, `/reload`, `quit`)
 * tears the old extension runtime down and loads a new one. The factory used to
 * append three ANONYMOUS terminal listeners (`subagent:completed|failed|stopped`)
 * that nothing ever unsubscribed. After a replacement the stale listeners were
 * still first in the bus's Set, so the stale runtime:
 *
 *   1. won the shared terminal claim (`claimTerminalNotice`) for a run it never
 *      spawned, and
 *   2. delivered (or threw on) that notice through its own dead `pi`/`ctx`,
 *      leaving the live runtime's listener with a lost claim and no wake.
 *
 * This suite drives the REAL factory (src/index.ts) twice on the REAL shared
 * event bus and claim set:
 *
 *   A init → A session_start → A session_shutdown → mark A's pi/ctx stale →
 *   B init → B session_start → emit a NEW-session terminal event
 *
 * and pins that exactly ONE correct `subagent-completion` comes from B, that A
 * touches no stale handle, that only A's exact listener identities went away
 * (an unrelated subscriber survives), that shutdown is idempotent, and that
 * repeated clean generations do not grow the bus. The transport-failure and
 * event-first/crash-first dedupe cases are repeated across the same boundary.
 *
 * The event bus is NOT mocked. Only the spawn + agent lookup are stubbed, as in
 * the existing notification suites, so the wake's real claim/notification code
 * runs. `__listenerIdentities` is a read-only test seam on the real bus.
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterEach, afterAll } from "vitest";

import type { SubagentRun, SubagentEventType } from "../types";

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
	spawnBackgroundSession: vi.fn(),
	getAgent: vi.fn(),
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
	reapActiveChildren: h.reapActiveChildren,
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
import { TRANSPORT_RETRY_TOAST } from "../transport-retry";
import { CUSTOM_ENTRY_TYPES } from "../types";
import { createTempEnv } from "./fixtures/temp-lifecycle";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_MODEL = { provider: "test", id: "test-model" };
const env = createTempEnv("brl-fix437");
const TERMINAL_TYPES = [
	"subagent:completed",
	"subagent:failed",
	"subagent:stopped",
] as const satisfies readonly SubagentEventType[];

interface Captured {
	message: Record<string, unknown>;
	options: Record<string, unknown> | undefined;
}

interface Notified {
	message: string;
	level: string | undefined;
}

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

type Handler = (_event: unknown, ctx: Record<string, unknown>) => Promise<void>;

interface StaleAccess {
	touches: number;
	sites: string[];
}

interface Runtime {
	label: string;
	pi: Record<string, unknown>;
	handlers: Map<string, Handler>;
	tools: Map<string, ToolEntry>;
	captured: Captured[];
	notified: Notified[];
	stale: StaleAccess;
	/** Session run entries this runtime's ctx exposes (its own session only). */
	entries: Array<Record<string, unknown>>;
	ctx: Record<string, unknown>;
	start(): Promise<void>;
	shutdown(reason?: string): Promise<void>;
	/** Make every handle invalid, as pi does after the runtime is torn down. */
	markStale(): void;
}

let runtimeSeq = 0;
let agentsById = new Map<string, Record<string, unknown>>();

function makeFakeAgent(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	runtimeSeq += 1;
	return {
		id,
		sessionId: `sess-bg-437-${runtimeSeq}`,
		type: "general-purpose",
		description: "lifecycle",
		status: "running",
		startedAt: 1700000000000 + runtimeSeq,
		task: "lifecycle task",
		model: `${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`,
		thinkingLevel: "medium",
		priority: "normal",
		...overrides,
	};
}

function registerAgent(id: string, overrides: Record<string, unknown> = {}): Record<string, unknown> {
	const agent = makeFakeAgent(id, overrides);
	agentsById.set(id, agent);
	return agent;
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

/** Build one factory invocation with its own pi, ctx and captured traffic. */
function createRuntime(label: string): Runtime {
	const handlers = new Map<string, Handler>();
	const tools = new Map<string, ToolEntry>();
	const captured: Captured[] = [];
	const notified: Notified[] = [];
	const stale: StaleAccess = { touches: 0, sites: [] };
	const entries: Array<Record<string, unknown>> = [];

	const pi: Record<string, unknown> = {
		registerTool: (t: ToolEntry) => tools.set(t.name, t),
		registerCommand: () => {},
		registerShortcut: () => {},
		on: (event: string, handler: Handler) => {
			handlers.set(event, handler);
		},
		appendEntry: () => {},
		sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => {
			captured.push({ message, options });
		},
		setStatus: () => {},
		ctx: { getState: () => undefined, setState: () => {} },
	};

	const rt: Runtime = {
		label,
		pi,
		handlers,
		tools,
		captured,
		notified,
		stale,
		entries,
		ctx: undefined as unknown as Record<string, unknown>,
		async start(): Promise<void> {
			rt.ctx = {
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
					getEntries: () => entries,
					appendCustomEntry: () => {},
				},
				hasUI: false,
			};
			const startHandler = handlers.get("session_start");
			if (!startHandler) throw new Error(`${label}: no session_start handler`);
			await startHandler({}, rt.ctx);
		},
		async shutdown(reason = "new"): Promise<void> {
			const shutdownHandler = handlers.get("session_shutdown");
			if (!shutdownHandler) throw new Error(`${label}: no session_shutdown handler`);
			await shutdownHandler({ reason }, rt.ctx);
		},
		markStale(): void {
			const bump = (site: string): never => {
				stale.touches += 1;
				stale.sites.push(site);
				throw new Error(`stale handle: ${site}`);
			};
			pi.sendMessage = () => bump("pi.sendMessage");
			pi.appendEntry = () => bump("pi.appendEntry");
			const ui = rt.ctx.ui as Record<string, unknown>;
			ui.notify = () => bump("ctx.ui.notify");
			ui.setStatus = () => bump("ctx.ui.setStatus");
			const sessionManager = rt.ctx.sessionManager as Record<string, unknown>;
			sessionManager.getEntries = () => bump("ctx.sessionManager.getEntries");
			sessionManager.appendCustomEntry = () => bump("ctx.sessionManager.appendCustomEntry");
		},
	};

	initExtension(pi as never);
	return rt;
}

type BusListener = (event: unknown) => void;

/** Terminal listener identities, keyed by event type, for one bus snapshot. */
function terminalIdentities(): Record<string, BusListener[]> {
	const snapshot: Record<string, BusListener[]> = {};
	for (const type of TERMINAL_TYPES) snapshot[type] = eventBus.__listenerIdentities(type);
	return snapshot;
}

/** Append the run entry the session-manager would have persisted. */
function persistRun(rt: Runtime, run: SubagentRun): void {
	rt.entries.push({ type: "custom", customType: CUSTOM_ENTRY_TYPES.run, data: run });
}

function settledRun(overrides: Partial<SubagentRun> = {}): SubagentRun {
	return {
		id: "bg-437-source",
		task: "lifecycle task",
		label: "lifecycle",
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

/** Flush the wake's async dynamic import + delivery (needs a macrotask turn). */
async function flush(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

function terminalMessages(rt: Runtime): Captured[] {
	return rt.captured.filter(
		(c) =>
			c.message.customType === "subagent-completion" ||
			c.message.customType === "subagent-notification",
	);
}

function completions(rt: Runtime): Captured[] {
	return rt.captured.filter((c) => c.message.customType === "subagent-completion");
}

// Keep the file isolated even when a failing test leaves a runtime alive.
const baseline = terminalIdentities();

function sweepToBaseline(): void {
	for (const type of TERMINAL_TYPES) {
		const keep = new Set(baseline[type]);
		for (const listener of eventBus.__listenerIdentities(type)) {
			if (!keep.has(listener)) eventBus.off(type, listener);
		}
	}
}

beforeAll(() => {
	env.setUp();
});

beforeEach(() => {
	agentsById = new Map();
	__resetTerminalClaims();
	h.spawnBackgroundSession.mockReset();
	h.getAgent.mockReset();
	h.getAgent.mockImplementation((id: string) => agentsById.get(id) ?? null);
	h.spawnBackgroundSession.mockImplementation(
		async (_pi: unknown, _ctx: unknown, p: { description?: string; task?: string }) => {
			const id = `bg-437-spawn-${agentsById.size + 1}-${Math.random().toString(36).slice(2, 8)}`;
			const agent = registerAgent(id, {
				description: p.description ?? "lifecycle",
				task: p.task ?? "lifecycle task",
			});
			return agent;
		},
	);
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
	sweepToBaseline();
});

afterAll(async () => {
	await env.tearDown();
	expect(terminalIdentities()).toEqual(baseline);
});

// ---------------------------------------------------------------------------
// 1. Clean replacement: the stale runtime must not claim or deliver
// ---------------------------------------------------------------------------

describe("clean session replacement (#437)", () => {
	it("a shut-down runtime does not consume the new session's completion claim", async () => {
		const a = createRuntime("A");
		await a.start();
		await a.shutdown();
		a.markStale();

		const b = createRuntime("B");
		await b.start();

		const id = "bg-437-new-session";
		registerAgent(id);
		persistRun(b, settledRun({ id, status: "done", errorCategory: "none", errorMessage: undefined }));

		vi.useFakeTimers();
		try {
			eventBus.emit(eventBus.createEvent("subagent:completed", id, {}));
			await flush();
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}

		// Exactly ONE correct completion, and it came from the LIVE runtime.
		const fromB = completions(b);
		expect(fromB).toHaveLength(1);
		expect(fromB[0].message.details).toMatchObject({ id, status: "completed" });
		expect(a.captured).toHaveLength(0);
		// The stale runtime touched none of its invalidated handles.
		expect(a.stale).toEqual({ touches: 0, sites: [] });
		// Nor did it emit a false crash notice through the poller path.
		expect(terminalMessages(a)).toHaveLength(0);

		// The claim B took is the shared, one-notice-per-id contract: a repeat of
		// the same terminal event yields no second delivery.
		vi.useFakeTimers();
		try {
			eventBus.emit(eventBus.createEvent("subagent:completed", id, {}));
			await flush();
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
		expect(completions(b)).toHaveLength(1);

		await b.shutdown();
	});
});

// ---------------------------------------------------------------------------
// 2. Exact listener ownership
// ---------------------------------------------------------------------------

describe("listener ownership on shutdown (#437)", () => {
	it("removes exactly this runtime's three listener identities", async () => {
		const a = createRuntime("A");
		await a.start();
		const aIds = terminalIdentities();
		for (const type of TERMINAL_TYPES) expect(aIds[type]).toHaveLength(1);

		await a.shutdown();

		for (const type of TERMINAL_TYPES) {
			const remaining = eventBus.__listenerIdentities(type);
			expect(remaining).toHaveLength(0);
			expect(remaining).not.toContain(aIds[type][0]);
		}

		// The NEXT runtime registers fresh identities — the old ones stay gone.
		const b = createRuntime("B");
		await b.start();
		for (const type of TERMINAL_TYPES) {
			const bIds = eventBus.__listenerIdentities(type);
			expect(bIds).toHaveLength(1);
			expect(bIds[0]).not.toBe(aIds[type][0]);
		}
		await b.shutdown();
	});

	it("keeps an unrelated subscriber intact and receiving events", async () => {
		const unrelated = vi.fn();
		eventBus.on("subagent:completed", unrelated);

		const a = createRuntime("A");
		await a.start();
		const b = createRuntime("B");
		await b.start();
		await a.shutdown();

		// The unrelated identity survives A's teardown; B's listener joins it.
		expect(eventBus.__listenerIdentities("subagent:completed")).toContain(unrelated);
		expect(eventBus.__listenerIdentities("subagent:completed")).toHaveLength(2);

		const id = "bg-437-unrelated";
		registerAgent(id);
		persistRun(b, settledRun({ id, status: "done", errorCategory: "none", errorMessage: undefined }));

		vi.useFakeTimers();
		try {
			eventBus.emit(eventBus.createEvent("subagent:completed", id, {}));
			await flush();
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}

		expect(unrelated).toHaveBeenCalledTimes(1);
		expect(unrelated.mock.calls[0][0]).toMatchObject({ type: "subagent:completed", agentId: id });
		expect(completions(b)).toHaveLength(1);

		await b.shutdown();
		// Only the test's own subscriber was never owned by a runtime.
		expect(eventBus.__listenerIdentities("subagent:completed")).toEqual([unrelated]);
		eventBus.off("subagent:completed", unrelated);
	});

	it("unsubscribes before the shutdown handler's first await", async () => {
		const a = createRuntime("A");
		await a.start();
		expect(eventBus.__listenerIdentities("subagent:failed")).toHaveLength(1);

		// Hold the FIRST await (`reapActiveChildren`) open: the release must
		// already have run, otherwise a replacement that starts while teardown is
		// still in flight could be shadowed by a half-closed runtime.
		let releaseReap: (() => void) | undefined;
		h.reapActiveChildren.mockImplementationOnce(
			() => new Promise<never[]>((resolve) => {
				releaseReap = () => resolve([]);
			}),
		);

		const pendingShutdown = a.shutdown();
		// Synchronous observation, before yielding to the event loop.
		for (const type of TERMINAL_TYPES) {
			expect(eventBus.__listenerIdentities(type)).toHaveLength(0);
		}

		if (!releaseReap) throw new Error("reapActiveChildren was not awaited");
		releaseReap();
		await pendingShutdown;
	});

	it("is idempotent on repeated/double shutdown and leaves the next runtime untouched", async () => {
		const a = createRuntime("A");
		await a.start();
		const aIds = terminalIdentities();

		await a.shutdown();
		const afterFirst = terminalIdentities();
		await a.shutdown();
		await a.shutdown();
		const afterThird = terminalIdentities();

		expect(afterThird).toEqual(afterFirst);
		for (const type of TERMINAL_TYPES) expect(afterThird[type]).toHaveLength(0);

		// A late double-shutdown after B came up must not remove B's listeners.
		const b = createRuntime("B");
		await b.start();
		const bIds = terminalIdentities();
		for (const type of TERMINAL_TYPES) {
			expect(bIds[type]).toHaveLength(1);
			expect(bIds[type][0]).not.toBe(aIds[type][0]);
		}

		await a.shutdown();
		expect(terminalIdentities()).toEqual(bIds);
		await b.shutdown();
	});

	it("does not accumulate listeners over repeated clean generations", async () => {
		const seen = new Set<BusListener>();

		for (let generation = 0; generation < 5; generation += 1) {
			const rt = createRuntime(`gen-${generation}`);
			await rt.start();
			const ids = terminalIdentities();
			for (const type of TERMINAL_TYPES) {
				// Exactly one per type, never a duplicate from an earlier generation.
				expect(ids[type]).toHaveLength(1);
				expect(seen.has(ids[type][0])).toBe(false);
				seen.add(ids[type][0]);
			}

			await rt.shutdown();
			const after = terminalIdentities();
			for (const type of TERMINAL_TYPES) expect(after[type]).toHaveLength(0);
		}

		expect(seen.size).toBe(TERMINAL_TYPES.length * 5);
	});
});

// ---------------------------------------------------------------------------
// 3. All three terminal types, distinct ids, one delivery each
// ---------------------------------------------------------------------------

describe("terminal delivery from the live runtime (#437)", () => {
	it("delivers completed / failed / stopped once each for distinct new-session ids", async () => {
		const a = createRuntime("A");
		await a.start();
		await a.shutdown();
		a.markStale();

		const b = createRuntime("B");
		await b.start();

		const rows = [
			{ type: "subagent:completed" as const, id: "bg-437-done", status: "completed" },
			{ type: "subagent:failed" as const, id: "bg-437-fail", status: "failed" },
			{ type: "subagent:stopped" as const, id: "bg-437-stop", status: "stopped" },
		];
		for (const row of rows) {
			registerAgent(row.id, {
				status: row.status === "completed" ? "done" : row.status,
				error: row.status === "failed" ? "boom" : undefined,
				completedAt: 1700000000000,
			});
			persistRun(
				b,
				settledRun({
					id: row.id,
					status: row.status === "completed" ? "done" : row.status,
					errorCategory: row.status === "failed" ? "exit_error" : "none",
					errorMessage: row.status === "failed" ? "boom" : undefined,
				}),
			);
		}

		vi.useFakeTimers();
		try {
			// One emit + one deterministic flush per type: the fake-timer flush is
			// what drains the wake's dynamic import, so pending chains are settled
			// one at a time rather than raced in a single tick.
			for (const row of rows) {
				eventBus.emit(eventBus.createEvent(row.type, row.id, {}));
				await flush();
			}
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}

		const delivered = completions(b);
		expect(delivered).toHaveLength(rows.length);
		expect(delivered.map((c) => c.message.details)).toEqual(
			rows.map((row) => expect.objectContaining({ id: row.id, status: row.status })),
		);
		for (const row of rows) {
			expect(String(delivered.find((c) => (c.message.details as { id: string }).id === row.id)?.message.content)).toContain(
				`— ${row.status}`,
			);
		}
		expect(a.stale.touches).toBe(0);
		expect(a.captured).toHaveLength(0);

		await b.shutdown();
	});
});

// ---------------------------------------------------------------------------
// 4. Transport auto-retry across a clean replacement
// ---------------------------------------------------------------------------

describe("transport auto-retry after replacement (#437)", () => {
	it("schedules exactly one retry from the live runtime and preserves its settle notice", async () => {
		const a = createRuntime("A");
		await a.start();
		await a.shutdown();
		a.markStale();

		const b = createRuntime("B");
		await b.start();

		const sourceId = "bg-437-retry-source";
		registerAgent(sourceId, {
			status: "failed",
			error: "Connection error.",
			completedAt: 1700000000000,
		});
		persistRun(b, settledRun({ id: sourceId, dispatchId: "disp-437" }));

		// Fixed attempt-2 id so the retry's own settle can be addressed explicitly.
		h.spawnBackgroundSession.mockImplementation(
			async (_pi: unknown, _ctx: unknown, p: { description?: string; task?: string }) =>
				registerAgent("bg-437-retry-attempt2", {
					description: p.description ?? "lifecycle",
					task: p.task ?? "lifecycle task",
				}),
		);

		vi.useFakeTimers();
		try {
			eventBus.emit(eventBus.createEvent("subagent:failed", sourceId, { error: "Connection error." }));
			await flush();
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}

		// Exactly one retry spawn, from B, with the retry lineage.
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
		// …and it used the LIVE runtime's handles, never A's.
		expect(h.spawnBackgroundSession.mock.calls[0][0]).toBe(b.pi);
		expect(h.spawnBackgroundSession.mock.calls[0][1]).toBe(b.ctx);
		const spawn = h.spawnBackgroundSession.mock.calls[0][2] as Record<string, unknown>;
		expect(spawn.attempt).toBe(2);
		expect(spawn.resumeOf).toBe(sourceId);
		expect(spawn.dispatchId).toBe("disp-437");
		// The source notice is suppressed; the user is told once, through B.
		expect(terminalMessages(b)).toHaveLength(0);
		expect(b.notified).toEqual([{ message: TRANSPORT_RETRY_TOAST, level: "warning" }]);
		expect(a.stale.touches).toBe(0);
		expect(a.captured).toHaveLength(0);
		expect(a.notified).toHaveLength(0);

		// The retry's own settle still notifies normally (no chain).
		const retryId = "bg-437-retry-attempt2";
		registerAgent(retryId, {
			status: "failed",
			error: "Connection error.",
			completedAt: 1700000000000,
		});
		persistRun(
			b,
			settledRun({
				id: retryId,
				attempt: 2,
				resumeOf: sourceId,
				dispatchId: "disp-437",
			}),
		);

		vi.useFakeTimers();
		try {
			eventBus.emit(eventBus.createEvent("subagent:failed", retryId, { error: "Connection error." }));
			await flush();
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}

		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
		const delivered = completions(b);
		expect(delivered).toHaveLength(1);
		expect(delivered[0].message.details).toMatchObject({ id: retryId, status: "failed" });
		expect(b.notified).toHaveLength(1);
		expect(a.stale.touches).toBe(0);

		await b.shutdown();
	});
});

// ---------------------------------------------------------------------------
// 5. The pre-existing event-first vs crash-first dedupe, across a replacement
// ---------------------------------------------------------------------------

/** Spawn a crash-shaped background agent through B's REAL delegate_task tool. */
async function spawnCrashShaped(rt: Runtime): Promise<string> {
	const tool = rt.tools.get("delegate_task");
	if (!tool) throw new Error("delegate_task tool not registered");
	const result = await tool.execute(
		"call-437",
		{ task: "crash-shaped", background: true, label: "crash-shaped" },
		undefined,
		undefined,
		rt.ctx,
	);
	expect(result.isError).toBeFalsy();
	const agent = [...agentsById.values()].find((a) => a.description === "crash-shaped");
	if (!agent) throw new Error("stub spawn returned no agent");
	return agent.id as string;
}

/** The agent is dead and session-ref-less; no completedAt → poller crash path. */
function makeCrashShaped(id: string): void {
	const agent = agentsById.get(id);
	if (!agent) throw new Error(`no agent ${id}`);
	agent.status = "running";
	agent._sessionRef = undefined;
	delete agent.completedAt;
}

/** Flush the wake + one 2 s poller tick (the pre-existing dedupe timing). */
async function flushAndPoll(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await vi.advanceTimersByTimeAsync(2000);
	await Promise.resolve();
}

describe("terminal-claim dedupe across a replacement (#315, #437)", () => {
	it("event-first: the wake claims the id and the crash notice stays suppressed", async () => {
		const a = createRuntime("A");
		await a.start();
		await a.shutdown();

		const b = createRuntime("B");
		await b.start();

		vi.useFakeTimers();
		try {
			const id = await spawnCrashShaped(b);
			makeCrashShaped(id);
			const agent = agentsById.get(id)!;
			agent.status = "failed";
			agent.error = "boom";
			persistRun(b, settledRun({ id, status: "failed", errorCategory: "exit_error", errorMessage: "boom" }));

			// The terminal event fires first and claims the id synchronously.
			eventBus.emit(eventBus.createEvent("subagent:failed", id, { error: "boom" }));

			await flushAndPoll(); // poller then hits the session-missing crash path

			const terminal = terminalMessages(b);
			expect(terminal).toHaveLength(1);
			expect(terminal[0].message.customType).toBe("subagent-completion");
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}

		await b.shutdown();
	});

	it("crash-first: the crash notice claims the id and the terminal wake stays suppressed", async () => {
		const a = createRuntime("A");
		await a.start();
		await a.shutdown();

		const b = createRuntime("B");
		await b.start();

		vi.useFakeTimers();
		try {
			const id = await spawnCrashShaped(b);
			makeCrashShaped(id);

			// The poller's crash path claims first, with no terminal event yet.
			await flushAndPoll();
			expect(terminalMessages(b)).toHaveLength(1);
			expect(terminalMessages(b)[0].message.customType).toBe("subagent-notification");

			const agent = agentsById.get(id)!;
			agent.status = "failed";
			agent.error = "boom";
			persistRun(b, settledRun({ id, status: "failed", errorCategory: "exit_error", errorMessage: "boom" }));
			eventBus.emit(eventBus.createEvent("subagent:failed", id, { error: "boom" }));
			await flushAndPoll();

			const terminal = terminalMessages(b);
			expect(terminal).toHaveLength(1);
			expect(terminal[0].message.customType).toBe("subagent-notification");
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}

		await b.shutdown();
	});
});

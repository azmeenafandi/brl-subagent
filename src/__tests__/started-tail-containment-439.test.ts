/**
 * Issue #439 — a run whose spawn returned is NEVER reported as a failed spawn.
 *
 * Measured defect: after `spawnBackgroundSession` resolves, the shared tail
 * (live-monitor registration, footer counter, repaint, poller, deadline, log) ran
 * uncontained. A throw there reached the callers' catch, which said "Failed to
 * spawn background agent" with `isError: true` while the agent was LIVE; the
 * transport retry read that as "did not start".
 *
 * Three contracts are pinned: CONTAINMENT (a post-spawn fault is a started run
 * with degraded monitoring, and one group's fault never skips the others —
 * T1/T2), ORDERING (counter → row → repaint, so the stale sweep cannot
 * decrement a sibling — T2b/T2c), and ONE advisory that does not consume the
 * terminal claim (T6), plus the fan-out and rejected-spawn shapes (T4/T7). The
 * retry and toast halves live in transport-auto-retry.test.ts (T5/T8), which
 * already owns the settle/retry fixtures.
 *
 * Faults are injected at STATEMENTS only (the fix's boundary statement): a
 * throwing `registerLiveSubagent` (a class method, so the real instance is
 * affected), a throwing scheduler, a throwing spawn. The identity record is a
 * plain object the module builds, so a read on it is not a reachable fault.
 */
import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";

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

// Spread the real module so state/session helpers stay real; stub the spawn and
// the record lookup (the tail's poller and deadline read the record through it).
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
import {
	MONITORING_DEGRADED_CUSTOM_TYPE,
	MONITORING_DEGRADED_TOAST,
	__resetTerminalClaims,
} from "../notify-completion";
import { STALE_FINALIZE_GRACE_MS, SessionState } from "../state";
import { DEFAULT_BACKGROUND_DEADLINE_MS } from "../validate";
import { createTempEnv } from "./fixtures/temp-lifecycle";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_MODEL = { provider: "test", id: "test-model" };
const env = createTempEnv("brl-fix439");

interface Captured {
	message: Record<string, unknown>;
	options?: Record<string, unknown>;
}
interface Notified {
	message: string;
	level?: string;
}

interface FakeAgent {
	id: string;
	sessionId: string;
	type: string;
	description: string;
	status: string;
	startedAt: number;
	task: string;
	model: string;
	thinkingLevel: string;
	priority: string;
	completedAt?: number;
	_sessionRef?: {
		messages: Array<{ role: string; content?: Array<{ type: string; text?: string }> }>;
		getSessionStats: () => { tokens: { input: number; output: number } };
		abort: ReturnType<typeof vi.fn>;
	};
}

interface SpawnParams {
	task?: string;
	description?: string;
	timeout?: number;
}

let captured: Captured[] = [];
let notified: Notified[] = [];
/** Every footer line painted during the test — the counter's observable surface. */
let statuses: string[] = [];
let agentsById = new Map<string, FakeAgent>();
let spawnSeq = 0;
let sessionEntries: Array<Record<string, unknown>> = [];
/** Channels that can be closed to prove the advisory's two independent tries. */
let sendThrows = false;
let notifyThrows = false;

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

let tool: ToolEntry;
let commands: Map<string, (args?: string, ctx?: unknown) => Promise<void>>;
let sessionStartHandler:
	| ((_event: unknown, ctx: Record<string, unknown>) => Promise<void>)
	| undefined;
let activeCtx: Record<string, unknown>;

/** A live fake agent. `_sessionRef` keeps the poller's live path off the crash path. */
function makeFakeAgent(p: SpawnParams): FakeAgent {
	spawnSeq += 1;
	const id = `bg-439-${spawnSeq}`;
	const agent: FakeAgent = {
		id,
		sessionId: `sess-439-${spawnSeq}`,
		type: "general-purpose",
		description: p.description ?? "",
		status: "running",
		startedAt: 1700000000000 + spawnSeq,
		task: p.task ?? "",
		model: `${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`,
		thinkingLevel: "medium",
		priority: "normal",
		_sessionRef: {
			messages: [],
			getSessionStats: () => ({ tokens: { input: 3, output: 4 } }),
			abort: vi.fn(async () => {}),
		},
	};
	agentsById.set(id, agent);
	return agent;
}

function makeCtx(): Record<string, unknown> {
	return {
		cwd: env.testCwd,
		model: GLOBAL_MODEL,
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === GLOBAL_MODEL.provider && id === GLOBAL_MODEL.id
					? { provider, id }
					: undefined,
			hasConfiguredAuth: () => true,
		},
		getSystemPrompt: () => "You are a helpful assistant.",
		ui: {
			notify: (message: string, level?: string) => {
				if (notifyThrows) throw new Error("UI channel closed");
				notified.push({ message, level });
			},
			setStatus: (_key: string, text: string) => {
				statuses.push(String(text));
			},
			custom: async () => undefined,
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: {
			getEntries: () => sessionEntries,
			appendCustomEntry: () => {},
		},
		hasUI: false,
	};
}

function setupExtension(): void {
	const registeredTools = new Map<string, ToolEntry>();
	commands = new Map();
	const mockPi = {
		registerTool: (t: ToolEntry) => registeredTools.set(t.name, t),
		registerCommand: (
			name: string,
			spec: { handler: (args?: string, ctx?: unknown) => Promise<void> },
		) => {
			commands.set(name, spec.handler);
		},
		registerShortcut: () => {},
		on: (event: string, handler: (_event: unknown, ctx: Record<string, unknown>) => Promise<void>) => {
			if (event === "session_start") sessionStartHandler = handler;
		},
		appendEntry: () => {},
		sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => {
			if (sendThrows) throw new Error("message channel closed");
			captured.push({ message, options });
		},
		ctx: { getState: () => undefined, setState: () => {} },
	};
	initExtension(mockPi as never);
	const registered = registeredTools.get("delegate_task");
	if (!registered) throw new Error("delegate_task tool not registered");
	tool = registered;
}

/** One single-task background dispatch through the real handler. */
async function singleBackground(params: Record<string, unknown>) {
	return tool.execute("call-439", { background: true, ...params }, undefined, undefined, activeCtx);
}

function advisories(): Captured[] {
	return captured.filter((c) => c.message.customType === MONITORING_DEGRADED_CUSTOM_TYPE);
}

/** Terminal notices for ONE source run id — filtered by type AND id ([c2]). */
function terminalFor(id: string): Captured[] {
	return captured.filter((c) => {
		const type = c.message.customType;
		if (type !== "subagent-completion" && type !== "subagent-notification") return false;
		const details = (c.message.details ?? {}) as { id?: string; agentId?: string };
		return details.id === id || details.agentId === id;
	});
}

function resultText(result: { content: Array<{ text: string }> }): string {
	return result.content[0].text;
}

/** The active-run count the last footer paint reported (0 when the idle line won). */
function lastActiveCount(): number {
	const line = statuses[statuses.length - 1] ?? "";
	const match = /(\d+) running/.exec(line);
	return match ? Number(match[1]) : 0;
}

const originalRegister = SessionState.prototype.registerLiveSubagent;

/**
 * Fault G1 at a chosen point. `after` reproduces the MEASURED #439 shape: the row
 * IS registered, then the statement throws — a live row without its counter under
 * the pre-fix ordering, which let the stale sweep decrement a sibling.
 */
function faultRegister(
	matches: (id: string) => boolean,
	after: "before" | "after" = "before",
): void {
	vi.spyOn(SessionState.prototype, "registerLiveSubagent").mockImplementation(function (
		this: SessionState,
		id: string,
		data: never,
	) {
		if (!matches(id)) return originalRegister.call(this, id, data);
		if (after === "after") originalRegister.call(this, id, data);
		throw new Error("live-monitor registry offline");
	});
}

/** Throw only for the 2s progress poller — other intervals arm normally. */
function breakPoller(): void {
	const realSetInterval = globalThis.setInterval;
	vi.stubGlobal("setInterval", ((fn: never, ms?: number) => {
		if (ms === 2000) throw new Error("scheduler saturated");
		return realSetInterval(fn, ms as never);
	}) as unknown as typeof setInterval);
}

beforeEach(async () => {
	env.setUp();
	captured = [];
	notified = [];
	statuses = [];
	agentsById = new Map();
	spawnSeq = 0;
	sessionEntries = [];
	sendThrows = false;
	notifyThrows = false;
	__resetTerminalClaims();
	h.runSubagent.mockReset();
	h.spawnBackgroundSession.mockReset().mockImplementation(async (_pi: unknown, _ctx: unknown, p: SpawnParams) => makeFakeAgent(p));
	h.getAgent.mockReset().mockImplementation((id: string) => agentsById.get(id) ?? null);
	// A FRESH extension instance per test: the factory owns one SessionState, so
	// this is what makes the footer counts absolute instead of cross-test sums.
	activeCtx = makeCtx();
	setupExtension();
	if (sessionStartHandler) await sessionStartHandler({}, activeCtx);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllGlobals();
	vi.clearAllTimers();
	vi.useRealTimers();
});

afterAll(async () => {
	await env.tearDown();
});

// ---------------------------------------------------------------------------
// 1. Containment — G1 / G2 / G3 are independently contained
// ---------------------------------------------------------------------------

describe("post-spawn containment (issue #439)", () => {
	it("T1 — a G1 fault reports the run STARTED (degraded), and G2 + G3 still ran", async () => {
		vi.useFakeTimers();
		faultRegister((id) => id === "bg-439-1");
		const ticks = vi.spyOn(SessionState.prototype, "updateLiveSubagent");
		// M10's falsifier: the LIVE record may be getter-backed in a way the plain
		// identity record cannot be, so a caller formatting from `agent` reads it a
		// second time and throws into the spawn-failure path. Exactly ONE read means
		// the result came from the identity capture.
		let descriptionReads = 0;
		h.spawnBackgroundSession.mockImplementation(async (_pi: unknown, _ctx: unknown, p: SpawnParams) => {
			const agent = makeFakeAgent(p);
			Object.defineProperty(agent, "description", {
				enumerable: true,
				get() {
					descriptionReads += 1;
					if (descriptionReads > 1) throw new Error("record getter fault");
					return p.description ?? "";
				},
			});
			return agent;
		});

		const result = await singleBackground({ task: "review the module", label: "review-module" });
		const text = resultText(result);

		// Classification: started, with the degraded paragraph built from identity.
		expect(result.isError).toBe(false);
		// Every field comes from the plain identity record, not from `agent`.
		expect(text).toContain("Background agent started: bg-439-1");
		expect(text).toContain("Description: review-module");
		expect(text).toContain("Task: review the module");
		expect(text).toContain("Status: running");
		expect(text).toContain("Monitoring degraded");
		expect(text).toContain("bg-439-1");
		expect(text).toContain("live-monitor registry offline");
		expect(text).not.toContain("Failed to spawn");
		expect(descriptionReads).toBe(1);
		// One advisory, and it is not a terminal notice.
		expect(advisories()).toHaveLength(1);
		expect(notified).toEqual([{ message: MONITORING_DEGRADED_TOAST, level: "warning" }]);
		expect(terminalFor("bg-439-1")).toHaveLength(0);

		// G2 ran: the poller ticks for this run (a skipped group would never tick).
		await vi.advanceTimersByTimeAsync(2000);
		expect(ticks.mock.calls.map((call) => call[0])).toContain("bg-439-1");
		// Issue #453: the deadline is NOT a caller group any more — the caller
		// arms no deadline at all, so there is no G3 to observe here. The spawn's
		// single arm (and its independence) is pinned in session-manager.test.ts.
		await vi.advanceTimersByTimeAsync(DEFAULT_BACKGROUND_DEADLINE_MS);
		expect(agentsById.get("bg-439-1")!._sessionRef!.abort).not.toHaveBeenCalled();
	});

	it("T2 — a G2 fault (poller not armed) still reports started and G1 still ran", async () => {
		vi.useFakeTimers();
		breakPoller();

		const result = await singleBackground({ task: "review the module", label: "review-module" });
		const text = resultText(result);

		expect(result.isError).toBe(false);
		expect(text).toContain("Background agent started: bg-439-1");
		expect(text).toContain("Monitoring degraded");
		expect(text).toContain("progress polling");
		expect(text).toContain("scheduler saturated");
		expect(text).not.toContain("Failed to spawn");
		expect(advisories()).toHaveLength(1);

		// G1 ran independently of G2: the counter + row + repaint landed, so the
		// footer reports the run. (No caller deadline exists to arm — issue #453.)
		expect(lastActiveCount()).toBe(1);
	});
});

// ---------------------------------------------------------------------------
// 2. Ordering — a live row always implies a counted run
// ---------------------------------------------------------------------------

describe("counter/row ordering (issue #439)", () => {
	it("T2b — a G1 fault next to a healthy sibling: the POLLER releases only its own count", async () => {
		vi.useFakeTimers();
		faultRegister((id) => id === "bg-439-2");

		const sibling = await singleBackground({ task: "unit one", label: "one", timeout: 600_000 });
		expect(sibling.isError).toBe(false);
		const degraded = await singleBackground({ task: "unit two", label: "two" });
		expect(resultText(degraded)).toContain("Monitoring degraded");
		expect(degraded.isError).toBe(false);

		// Issue #453: the caller arms no deadline, so the release comes from the
		// poller observing the terminal record — the same path an explicit-timeout
		// run has always used (the spawn's timer sets both fields).
		const degradedAgent = agentsById.get("bg-439-2")!;
		degradedAgent.status = "stopped";
		degradedAgent.completedAt = Date.now();
		await vi.advanceTimersByTimeAsync(2000);

		// The degraded run's own count is released; the healthy sibling keeps 1.
		expect(lastActiveCount()).toBe(1);
		expect(agentsById.get("bg-439-1")!.completedAt).toBeUndefined();
	});

	it("T2c — a post-registration G1 fault cannot make the stale sweep release a sibling's count", async () => {
		vi.useFakeTimers();
		// The MEASURED defect shape: the row lands, then the statement throws.
		faultRegister((id) => id === "bg-439-2", "after");

		await singleBackground({ task: "unit one", label: "one", timeout: 600_000 });
		const degraded = await singleBackground({ task: "unit two", label: "two" });
		expect(resultText(degraded)).toContain("Monitoring degraded");

		// The degraded run's record is now terminal on disk while its row is still
		// live — the monitor's self-heal sweep finalizes ITS row (the only branch
		// that releases a background count) and must release only ITS counter.
		agentsById.get("bg-439-2")!.completedAt = Date.now() - STALE_FINALIZE_GRACE_MS - 1;
		await commands.get("brl-subagent")!("monitor", activeCtx);

		// A third run repaints the footer from the live counters: 2 = sibling + new.
		await singleBackground({ task: "unit three", label: "three", timeout: 600_000 });
		expect(lastActiveCount()).toBe(2);
	});
});

// ---------------------------------------------------------------------------
// 3. Fan-out and the rejected spawn
// ---------------------------------------------------------------------------

describe("fan-out and rejected spawn (issue #439)", () => {
	it("T4 — a degraded unit is still reported started when a LATER unit fails", async () => {
		vi.useFakeTimers();
		faultRegister((id) => id === "bg-439-1");
		h.spawnBackgroundSession.mockImplementation(async (_pi: unknown, _ctx: unknown, p: SpawnParams) => {
			if (spawnSeq === 0) return makeFakeAgent(p);
			throw new Error("no session slot");
		});

		const result = await tool.execute(
			"call-439-fanout",
			{ background: true, tasks: [{ task: "unit one", label: "one" }, { task: "unit two", label: "two" }] },
			undefined,
			undefined,
			activeCtx,
		);
		const text = resultText(result);

		expect(result.isError).toBe(true);
		expect(text).toContain(`Failed to spawn background agent for Task 2 ("two")`);
		// Unit 1's started-degraded report survives unit 2's failure.
		expect(text).toContain("Already started: bg-439-1");
		expect(text).toContain("Monitoring degraded");
		expect(text).toContain("bg-439-1");
		// One advisory for the one degraded run — never one per failing group.
		expect(advisories()).toHaveLength(1);
	});

	it("T7 — a rejected spawn is a spawn failure: existing wording, no advisory", async () => {
		vi.useFakeTimers();
		h.spawnBackgroundSession.mockRejectedValue(new Error("no session slot"));

		const result = await singleBackground({ task: "review the module" });

		expect(result.isError).toBe(true);
		expect(resultText(result)).toBe("Failed to spawn background agent: no session slot");
		expect(advisories()).toHaveLength(0);
		expect(notified).toEqual([]);
	});
});

// ---------------------------------------------------------------------------
// 4. The advisory — once per run, two independent channels, no terminal claim
// ---------------------------------------------------------------------------

describe("degraded-monitoring advisory (issue #439)", () => {
	// DEVIATION, stated (2026-11-07 review): the terminal half drives the real
	// delivery-layer subscriber chain, but the settle EVENT itself is emitted directly
	// rather than through a full `spawnBackgroundSession` settle. A full settle needs a
	// real SDK session, which this suite does not stand up; the property under test is
	// the claim policy on the event bus, so the emit is the honest seam. The real-settle
	// path is covered by the background-session suites.
	it("T6 — one advisory with two failing groups; channel independence; the terminal notice still lands", async () => {
		vi.useFakeTimers();

		// Phase 1: G1 AND G2 fail → exactly ONE advisory naming both groups. (The
		// deadline was the third group; issue #453 moved it into the spawn, so the
		// caller's ledger has two.)
		faultRegister((id) => id === "bg-439-1");
		breakPoller();
		const both = await singleBackground({ task: "unit one", label: "one" });
		expect(resultText(both)).toContain("live-monitor bookkeeping");
		expect(resultText(both)).toContain("progress polling");
		expect(advisories()).toHaveLength(1);
		expect((advisories()[0].message.details as { tailFailures: string[] }).tailFailures).toHaveLength(2);
		expect(notified).toHaveLength(1);

		// Phase 2: a throwing sendMessage must not swallow the UI notice.
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		captured = [];
		notified = [];
		faultRegister((id) => id === "bg-439-2");
		sendThrows = true;
		await singleBackground({ task: "unit two", label: "two" });
		expect(advisories()).toHaveLength(0); // the send threw
		expect(notified.map((n) => n.message)).toEqual([MONITORING_DEGRADED_TOAST]);

		// Phase 3: a throwing ui.notify must not swallow the message.
		vi.restoreAllMocks();
		captured = [];
		notified = [];
		sendThrows = false;
		notifyThrows = true;
		faultRegister((id) => id === "bg-439-3");
		await singleBackground({ task: "unit three", label: "three" });
		expect(advisories()).toHaveLength(1);
		expect(notified).toHaveLength(0); // the UI threw

		// Phase 4: the advisory did NOT consume the terminal claim. The TERMINAL
		// event is the same one the session-manager's settle emits; delivery after
		// the advisory is what proves the claim survived it.
		expect(terminalFor("bg-439-3")).toHaveLength(0);
		eventBus.emit(eventBus.createEvent("subagent:completed", "bg-439-3", {}));
		await vi.advanceTimersByTimeAsync(0);
		const terminal = terminalFor("bg-439-3");
		expect(terminal).toHaveLength(1);
		expect(terminal[0].message.customType).toBe("subagent-completion");
	});
});

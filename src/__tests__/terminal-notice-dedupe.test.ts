/**
 * Issue #315 — ONE terminal notice per background run id.
 *
 * Before this fix a failed background run produced TWO terminal messages: the
 * event-bus wake (`subagent-completion`, always-on since #147) AND the legacy
 * poller's own `subagent-notification` ("... failed."). Successes/stopped runs
 * never hit the poller branch, which is why the duplicate looked failures-only.
 *
 * This suite drives the REAL extension (index.ts) with a stubbed spawn and a
 * capturing `pi.sendMessage`, and pins:
 *
 *   1. a failed run emits EXACTLY ONE message — `subagent-completion`;
 *   2. the defensive session-missing crash path emits EXACTLY ONE
 *      `subagent-notification` (no terminal event precedes it);
 *   3. the poller-exception crash path emits EXACTLY ONE
 *      `subagent-notification`;
 *   4. an event+crash race emits ONE (the wake claims the id first);
 *   5. the `completionNotify` knob still resolves delivery options unchanged.
 *
 * Harness modeled on background-fan-out.test.ts: partial session-manager mock
 * (stub spawnBackgroundSession + a controllable getAgent; keep other exports
 * real), ../runner mocked, fake timers with cleanup, temp dirs redirected.
 *
 * ONE extension instance is created for the whole file (beforeAll): each
 * `initExtension` call appends another permanent event-bus listener, so a
 * per-test instance would leak stale listeners across cases. The shared
 * terminal-claim set is reset in beforeEach; ids are unique per case.
 */

import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

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

// The extension destructures spawnBackgroundSession out of a DYNAMIC
// import('./session-manager') inside the shared spawn tail — vi.mock
// intercepts dynamic imports too. Spread the real module so the state/session
// helpers stay real; stub only the spawn + getAgent (the wake path resolves
// the agent through the exported getAgent, which the stub spawn never
// registers in the real agent map).
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
import { CUSTOM_ENTRY_TYPES } from "../types";
import { createTempEnv } from "./fixtures/temp-lifecycle";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_MODEL = { provider: "test", id: "test-model" };
const env = createTempEnv("brl-fix315");

interface Captured {
	message: Record<string, unknown>;
	options: Record<string, unknown> | undefined;
}

let captured: Captured[] = [];

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
let sessionStartHandler:
	| ((_event: unknown, ctx: Record<string, unknown>) => Promise<void>)
	| undefined;
let activeCtx: Record<string, unknown>;

let spawnSeq = 0;
const agentsById = new Map<string, Record<string, unknown>>();
let lastSpawnedAgent: Record<string, unknown> | undefined;
/** Per-test override for the agent the stub spawn returns. */
let makeAgentImpl: (p: { description?: string; task?: string }) => Record<string, unknown>;

function makeFakeAgent(p: { description?: string; task?: string }): Record<string, unknown> {
	spawnSeq += 1;
	return {
		id: `bg-315-${spawnSeq}`,
		sessionId: `sess-bg-315-${spawnSeq}`,
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

function setStubSpawns(): void {
	h.spawnBackgroundSession.mockImplementation(
		async (_pi: unknown, _ctx: unknown, p: { description?: string; task?: string }) => {
			const agent = makeAgentImpl(p);
			agentsById.set(agent.id as string, agent);
			lastSpawnedAgent = agent;
			return agent;
		},
	);
	h.getAgent.mockImplementation((id: string) => agentsById.get(id) ?? null);
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
	const toolEntry = registeredTools.get("delegate_task");
	if (!toolEntry) throw new Error("delegate_task tool not registered");
	tool = toolEntry;
}

/** Model registry mock: the single test model always exists and is authed. */
function makeRegistry() {
	return {
		find: (provider: string, id: string) =>
			`${provider}/${id}` === `${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`
				? { provider, id }
				: undefined,
		hasConfiguredAuth: () => true,
	};
}

/** Build the session ctx; an optional persisted state entry sets the knob. */
function makeCtx(completionNotify?: string): Record<string, unknown> {
	const entries = completionNotify
		? [
				{
					type: "custom",
					customType: CUSTOM_ENTRY_TYPES.state,
					data: { completionNotify },
				},
			]
		: [];
	return {
		cwd: env.testCwd,
		model: GLOBAL_MODEL,
		modelRegistry: makeRegistry(),
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

/** Run session_start (sets sessionCtx + the completionNotify knob). */
async function startSession(completionNotify?: string): Promise<void> {
	activeCtx = makeCtx(completionNotify);
	if (sessionStartHandler) await sessionStartHandler({}, activeCtx);
}

/** Spawn a background agent through the REAL delegate_task handler. */
async function spawnBackground(label: string): Promise<Record<string, unknown>> {
	const result = await tool.execute(
		"call-315",
		{ task: `task ${label}`, background: true, label },
		undefined,
		undefined,
		activeCtx,
	);
	expect(result.isError).toBeFalsy();
	if (!lastSpawnedAgent) throw new Error("stub spawn returned no agent");
	return lastSpawnedAgent;
}

/** Flush the wake's async import + delivery, then run the 2s poller once. */
async function flushAndPoll(): Promise<void> {
	await Promise.resolve();
	await Promise.resolve();
	await vi.advanceTimersByTimeAsync(2000);
	await Promise.resolve();
}

/** All captured messages of the given customType. */
function messagesOfType(type: string): Captured[] {
	return captured.filter((c) => c.message.customType === type);
}

beforeAll(async () => {
	env.setUp();
	setupExtension();
	await startSession("all");
});

beforeEach(() => {
	captured = [];
	spawnSeq = 0;
	agentsById.clear();
	lastSpawnedAgent = undefined;
	makeAgentImpl = (p) => makeFakeAgent(p);
	__resetTerminalClaims();
	h.spawnBackgroundSession.mockReset();
	h.getAgent.mockReset();
	setStubSpawns();
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

afterAll(async () => {
	await env.tearDown();
});

// ---------------------------------------------------------------------------
// 1. A failed run emits exactly one terminal message
// ---------------------------------------------------------------------------

describe("a failed background run (#315)", () => {
	it("emits exactly one terminal message, and it is subagent-completion", async () => {
		vi.useFakeTimers();
		try {
			const agent = await spawnBackground("fail-once");
			// Settle: the session-manager records failed + completedAt and emits
			// subagent:failed (stubbed spawn means we simulate both here).
			agent.status = "failed";
			agent.error = "boom";
			agent.completedAt = Date.now();
			eventBus.emit(
				eventBus.createEvent("subagent:failed", agent.id as string, { error: "boom" }),
			);

			await flushAndPoll(); // wake delivers, then the 2s poller sees failed

			const terminal = captured.filter(
				(c) =>
					c.message.customType === "subagent-completion" ||
					c.message.customType === "subagent-notification",
			);
			expect(terminal).toHaveLength(1);
			expect(terminal[0].message.customType).toBe("subagent-completion");
			expect(messagesOfType("subagent-notification")).toHaveLength(0);
			expect(String(terminal[0].message.content)).toContain("— failed");
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// 2 + 3. The two crash paths each emit exactly one subagent-notification
// ---------------------------------------------------------------------------

describe("poller crash paths (#315)", () => {
	it("defensive session-missing path emits exactly one subagent-notification", async () => {
		vi.useFakeTimers();
		try {
			makeAgentImpl = (p) => ({ ...makeFakeAgent(p), _sessionRef: undefined });
			await spawnBackground("crash-missing");

			await flushAndPoll();

			const notices = messagesOfType("subagent-notification");
			expect(notices).toHaveLength(1);
			expect(String(notices[0].message.content)).toContain("crashed.");
			expect(messagesOfType("subagent-completion")).toHaveLength(0);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	it("poller-exception path emits exactly one subagent-notification", async () => {
		vi.useFakeTimers();
		try {
			const throwingSession = {
				get messages(): never {
					throw new Error("extract blew up");
				},
				getSessionStats: () => ({ tokens: { input: 0, output: 0 } }),
			};
			makeAgentImpl = (p) => ({ ...makeFakeAgent(p), _sessionRef: throwingSession });
			await spawnBackground("crash-throw");

			await flushAndPoll();

			const notices = messagesOfType("subagent-notification");
			expect(notices).toHaveLength(1);
			expect(String(notices[0].message.content)).toContain("crashed:");
			expect(String(notices[0].message.content)).toContain("extract blew up");
			expect(messagesOfType("subagent-completion")).toHaveLength(0);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// 4. Event + crash race emits exactly one notice
// ---------------------------------------------------------------------------

describe("event + crash race (#315)", () => {
	it("the wake claims the id first, so the crash notice is suppressed", async () => {
		vi.useFakeTimers();
		try {
			makeAgentImpl = (p) => ({ ...makeFakeAgent(p), _sessionRef: undefined });
			const agent = await spawnBackground("race");
			agent.status = "failed";
			agent.error = "boom";

			// Terminal event fires (claims the id synchronously) even though the
			// agent still looks crash-shaped to the poller.
			eventBus.emit(
				eventBus.createEvent("subagent:failed", agent.id as string, { error: "boom" }),
			);

			await flushAndPoll(); // poller then hits the session-missing crash path

			expect(captured).toHaveLength(1);
			expect(captured[0].message.customType).toBe("subagent-completion");
			expect(messagesOfType("subagent-notification")).toHaveLength(0);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	it("suppresses the poller-exception crash notice when the wake already claimed the id", async () => {
		vi.useFakeTimers();
		try {
			const throwingSession = {
				get messages(): never {
					throw new Error("extract blew up");
				},
				getSessionStats: () => ({ tokens: { input: 0, output: 0 } }),
			};
			makeAgentImpl = (p) => ({ ...makeFakeAgent(p), _sessionRef: throwingSession });
			const agent = await spawnBackground("race-throw");
			agent.status = "failed";
			agent.error = "boom";

			eventBus.emit(
				eventBus.createEvent("subagent:failed", agent.id as string, { error: "boom" }),
			);

			await flushAndPoll(); // poller then throws into the exception crash path

			expect(captured).toHaveLength(1);
			expect(captured[0].message.customType).toBe("subagent-completion");
			expect(messagesOfType("subagent-notification")).toHaveLength(0);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// 5. completionNotify knob matrix is unchanged (end-to-end delivery options)
// ---------------------------------------------------------------------------

describe("completionNotify knob (#315)", () => {
	const failedRows: Array<["all" | "failed" | "off", "steer" | "nextTurn", boolean]> = [
		["all", "steer", true],
		["failed", "steer", true],
		["off", "nextTurn", false],
	];

	it.each(failedRows)(
		"a failed run under knob '%s' emits one wake delivered as %s (triggerTurn %s)",
		async (knob, deliverAs, triggerTurn) => {
			await startSession(knob);
			vi.useFakeTimers();
			try {
				const agent = await spawnBackground(`knob-${knob}`);
				agent.status = "failed";
				agent.error = "boom";
				agent.completedAt = Date.now();
				eventBus.emit(
					eventBus.createEvent("subagent:failed", agent.id as string, { error: "boom" }),
				);

				await flushAndPoll();

				expect(captured).toHaveLength(1);
				expect(captured[0].message.customType).toBe("subagent-completion");
				expect(captured[0].options).toEqual({ deliverAs, triggerTurn });
			} finally {
				vi.clearAllTimers();
				vi.useRealTimers();
			}
		},
	);

	afterEach(async () => {
		await startSession("all");
	});
});

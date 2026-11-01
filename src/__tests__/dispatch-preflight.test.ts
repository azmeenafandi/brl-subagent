/**
 * Issue #412 — rule 2's mechanism: the dispatch-shape pre-flight.
 *
 * "No deadline ⇒ durable path" was conductor discretion until this pre-flight:
 * a HIGH/xhigh-thinking run dispatched FOREGROUND with an explicit timeout is
 * the shape that lost 14 minutes of plan critique on 2026-10-31 (killed at the
 * 15-minute foreground timeout; foreground runs persist nothing). The switch
 * makes the durable shape the only one:
 *
 *   thinkingLevel high|xhigh + background:false + an explicit timeout
 *     → background:true, the explicit timeout DROPPED (the 30-minute
 *       DEFAULT_BACKGROUND_DEADLINE_MS applies), and a notice stating the
 *       true tool fact.
 *   force:true keeps it foreground (logged — the dispatch text is the reason).
 *   everything else (medium, omitted background, batch shapes, no timeout) is
 *   untouched.
 *
 * ORDERING INVARIANT (the reason this file has a dedicated test): the switch
 * must be applied BEFORE `snapshotOriginalParams` records the run, so the
 * retry snapshot says `background:true` and `transport-retry.ts`'s predicate
 * (`originalParams?.background === true`) still classifies the run as a
 * background run. A switch applied after the snapshot would silently drop the
 * transport auto-retry for exactly the runs this pre-flight creates.
 *
 * Harness cloned from background-default.test.ts: hoisted `../runner` mock;
 * partial `../session-manager` mock stubbing ONLY spawnBackgroundSession; tui
 * module mocks; temp dirs + output/storage redirects from the shared lifecycle
 * helper; fake timers around background dispatches (a successful spawn arms a
 * 2s poller + the deadline timer).
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { writeFileSync } from "node:fs";
import * as path from "node:path";

const h = vi.hoisted(() => ({
	runSubagent: vi.fn(),
	cleanupTempDirs: vi.fn().mockResolvedValue(0),
	getPiInvocation: vi.fn(),
	accumulateUsage: vi.fn(),
	parseSubagentLine: vi.fn(),
	spawnBackgroundSession: vi.fn(),
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
}));

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
import { DEFAULT_BACKGROUND_DEADLINE_MS } from "../validate";
import { isTransportRetryable } from "../transport-retry";
import {
	resolveThinkingDispatchSwitch,
	THINKING_SWITCH_NOTICE,
} from "../params";
import type { SubagentResult, ThinkingLevel } from "../types";
import { createTempEnv } from "./fixtures/temp-lifecycle";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_MODEL = { provider: "test", id: "test/model" };
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const VALID_LINE = `jev: high (0.44) · C2 · worktree y`;

/** Opt this test's temp project in via the umbrella flag (issue #415). */
function optIn(): void {
	writeFileSync(
		path.join(env.testCwd, "package.json"),
		JSON.stringify({ name: "fixture-project", "brl-subagent": { processChecks: true } }),
		"utf8",
	);
}

interface SpawnParams {
	task?: string;
	description?: string;
	timeout?: number;
	thinkingLevel?: string;
	originalParams?: Record<string, unknown>;
}

let spawnSeq = 0;

function makeFakeAgent(p: SpawnParams): Record<string, unknown> {
	spawnSeq += 1;
	return {
		id: `bg-switch-${spawnSeq}`,
		sessionId: `sess-bg-switch-${spawnSeq}`,
		description: p.description ?? "",
		status: "running",
		startedAt: 1700000000000 + spawnSeq,
		task: p.task ?? "",
		model: `${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`,
		thinkingLevel: p.thinkingLevel ?? "high",
	};
}

function makeResult(modelStr: string): SubagentResult {
	return {
		messages: [
			{ role: "assistant", content: [{ type: "text", text: "done" }], model: modelStr },
		],
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 0, turns: 1 },
		exitCode: 0,
		stderr: "",
		model: modelStr,
		stopReason: "end_turn",
		errorCategory: "unknown",
	};
}

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

interface CapturedMessage {
	customType?: string;
	content?: string;
	display?: boolean;
}

let tool: ToolEntry;
let sendMessageSpy: ReturnType<typeof vi.fn>;
let notifySpy: ReturnType<typeof vi.fn>;
let sessionStartHandler:
	| ((_event: unknown, ctx: Record<string, unknown>) => Promise<void>)
	| undefined;
const env = createTempEnv("brl-dispatch-switch");

function setupExtension(): ToolEntry {
	const registeredTools = new Map<string, ToolEntry>();
	const mockPi = {
		registerTool: (t: ToolEntry) => registeredTools.set(t.name, t),
		registerCommand: () => {},
		registerShortcut: () => {},
		on: (event: string, handler: (_event: unknown, ctx: Record<string, unknown>) => Promise<void>) => {
			if (event === "session_start") sessionStartHandler = handler;
		},
		appendEntry: () => {},
		sendMessage: sendMessageSpy,
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

function makeRegistry(available: string[]) {
	return {
		find: (provider: string, id: string) =>
			available.includes(`${provider}/${id}`) ? { provider, id } : undefined,
		hasConfiguredAuth: (model: { provider: string; id: string }) =>
			available.includes(`${model.provider}/${model.id}`),
	};
}

function makeCtx(): Record<string, unknown> {
	return {
		cwd: env.testCwd,
		model: GLOBAL_MODEL,
		modelRegistry: makeRegistry([`${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`]),
		getSystemPrompt: () => "You are a helpful assistant.",
		ui: {
			notify: notifySpy,
			setStatus: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: {
			getEntries: () => [] as unknown[],
			appendCustomEntry: () => {},
		},
		hasUI: false,
	};
}

type Ctx = ReturnType<typeof makeCtx>;

async function dispatch(
	params: Record<string, unknown>,
	ctx: Ctx = makeCtx(),
): Promise<Awaited<ReturnType<ToolEntry["execute"]>>> {
	vi.useFakeTimers();
	try {
		return await tool.execute("call-412", params, undefined, undefined, ctx);
	} finally {
		vi.clearAllTimers();
		vi.useRealTimers();
	}
}

function spawnArg(call = 0): SpawnParams {
	const arg = h.spawnBackgroundSession.mock.calls[call]?.[2] as SpawnParams | undefined;
	if (!arg) throw new Error("no background spawn captured");
	return arg;
}

function capturedOriginalParams(call = 0): Record<string, unknown> {
	const recorded = spawnArg(call).originalParams;
	if (!recorded) throw new Error("no spawn call captured an originalParams snapshot");
	return recorded;
}

/** Every notice the handler emitted this dispatch (pi.sendMessage channel). */
function notices(): CapturedMessage[] {
	return (sendMessageSpy.mock.calls as Array<[CapturedMessage, unknown]>).map((call) => call[0]);
}

beforeEach(() => {
	env.setUp();
	sendMessageSpy = vi.fn();
	notifySpy = vi.fn();
	h.runSubagent.mockReset();
	h.runSubagent.mockImplementation(
		async (_cwd: string, _prompt: string, model: { provider: string; id: string }) =>
			makeResult(`${model.provider}/${model.id}`),
	);
	h.getPiInvocation.mockReset();
	h.getPiInvocation.mockReturnValue({ command: process.execPath, args: [] });
	h.spawnBackgroundSession.mockReset();
	spawnSeq = 0;
	h.spawnBackgroundSession.mockImplementation(
		async (_pi: unknown, _ctx: unknown, p: SpawnParams) => makeFakeAgent(p),
	);
	sessionStartHandler = undefined;
	tool = setupExtension();
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

afterAll(async () => {
	await env.tearDown();
});

// ---------------------------------------------------------------------------
// The pure predicate
// ---------------------------------------------------------------------------

describe("resolveThinkingDispatchSwitch (rule 2's decision, pure)", () => {
	const base = {
		processChecks: true,
		explicitBackground: false,
		timeout: 900_000,
		force: undefined,
		shape: "single" as const,
	};

	it("switches a high/xhigh foreground dispatch that carries an explicit timeout", () => {
		expect(resolveThinkingDispatchSwitch({ ...base, thinkingLevel: "high" })).toBe("switch");
		expect(resolveThinkingDispatchSwitch({ ...base, thinkingLevel: "xhigh" })).toBe("switch");
	});

	it("never switches below high", () => {
		for (const level of ["off", "minimal", "low", "medium"] as ThinkingLevel[]) {
			expect(resolveThinkingDispatchSwitch({ ...base, thinkingLevel: level })).toBe("none");
		}
	});

	it("never switches without an explicit timeout (there is nothing to drop)", () => {
		expect(
			resolveThinkingDispatchSwitch({ ...base, thinkingLevel: "high", timeout: undefined }),
		).toBe("none");
	});

	it("never switches an omitted or explicit-true background (the caller did not ask foreground)", () => {
		expect(
			resolveThinkingDispatchSwitch({ ...base, thinkingLevel: "high", explicitBackground: undefined }),
		).toBe("none");
		expect(
			resolveThinkingDispatchSwitch({ ...base, thinkingLevel: "high", explicitBackground: true }),
		).toBe("none");
	});

	it("never switches a batch shape (chain/graph block by definition)", () => {
		expect(
			resolveThinkingDispatchSwitch({ ...base, thinkingLevel: "high", shape: "chain" }),
		).toBe("none");
		expect(
			resolveThinkingDispatchSwitch({ ...base, thinkingLevel: "high", shape: "graph" }),
		).toBe("none");
	});

	it("force:true keeps the foreground shape, as a distinguishable outcome", () => {
		expect(
			resolveThinkingDispatchSwitch({ ...base, thinkingLevel: "high", force: true }),
		).toBe("forced");
	});

	it("never switches when the project has not opted in (issue #415: the user's shape stands)", () => {
		expect(
			resolveThinkingDispatchSwitch({ ...base, processChecks: false, thinkingLevel: "high" }),
		).toBe("none");
		expect(
			resolveThinkingDispatchSwitch({
				...base,
				processChecks: false,
				thinkingLevel: "xhigh",
				force: true,
			}),
		).toBe("none");
	});
});

// ---------------------------------------------------------------------------
// Direction 1 — the switch happens, and it is recorded before the snapshot
// ---------------------------------------------------------------------------

describe("auto-switch: high-thinking foreground + explicit timeout (issue #412)", () => {
	it("auto-switches to background, drops the explicit timeout, and says so", async () => {
		optIn();
		const result = await dispatch({
			task: `critique the plan\n\n${VALID_LINE}`,
			thinkingLevel: "high",
			background: false,
			timeout: 900_000,
		});

		expect(result.isError).toBeFalsy();
		// Background spawn, not a blocking foreground run.
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
		expect(h.runSubagent).not.toHaveBeenCalled();
		expect(result.content[0].text).toContain("Background agent started: bg-switch-1");

		// The explicit foreground timeout is DROPPED — the background default applies.
		expect(spawnArg().timeout).toBeUndefined();
		expect(DEFAULT_BACKGROUND_DEADLINE_MS).toBe(30 * 60 * 1000);

		// The notice states the true tool fact (why the shape changed).
		const switchNotice = notices().find((m) => m.content?.includes(THINKING_SWITCH_NOTICE));
		expect(switchNotice, "the switch must emit its notice").toBeDefined();
		expect(switchNotice?.content).toContain("foreground runs persist nothing");
		expect(notifySpy.mock.calls.some((call) => String(call[0]).includes(THINKING_SWITCH_NOTICE))).toBe(true);
	});

	it("records background:true in the retry snapshot (ordering: switch BEFORE snapshotOriginalParams)", async () => {
		optIn();
		await dispatch({
			task: `critique the plan\n\n${VALID_LINE}`,
			thinkingLevel: "xhigh",
			background: false,
			timeout: 900_000,
		});

		const snapshot = capturedOriginalParams();
		expect(snapshot.background).toBe(true);
		// The dropped timeout is recorded as undefined, so a retry re-derives the
		// background default instead of restoring the foreground cap.
		expect(snapshot.timeout).toBeUndefined();

		// The retry predicate classifies the run from exactly that snapshot: the
		// switch must not cost the run its transport auto-retry.
		expect(
			isTransportRetryable({
				status: "failed",
				errorCategory: "exit_error",
				errorMessage: "Connection error.",
				attempt: 1,
				originalParams: snapshot,
			}),
		).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Direction 2 — force keeps the foreground shape
// ---------------------------------------------------------------------------

describe("auto-switch: force:true keeps the foreground shape (issue #412)", () => {
	it("force:true runs foreground and preserves the explicit timeout", async () => {
		optIn();
		const result = await dispatch({
			task: `read one file and answer inline\n\n${VALID_LINE}`,
			thinkingLevel: "high",
			background: false,
			timeout: 900_000,
			force: true,
		});

		expect(result.isError).toBeFalsy();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
		// The foreground timeout reaches the runner path untouched (arg 8 of
		// runSubagent: cwd, prompt, model, thinking, task, signal, onUpdate,
		// toolOptions, timeout).
		expect(h.runSubagent.mock.calls[0]?.[8]).toBe(900_000);
		// No switch notice — the caller asked for foreground and said force.
		expect(notices().some((m) => m.content?.includes(THINKING_SWITCH_NOTICE))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Untouched shapes
// ---------------------------------------------------------------------------

describe("auto-switch: shapes it must NOT touch (issue #412)", () => {
	it("medium thinking stays foreground with its explicit timeout", async () => {
		const result = await dispatch({
			task: "review this change",
			thinkingLevel: "medium",
			background: false,
			timeout: 900_000,
		});

		expect(result.isError).toBeFalsy();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
		expect(notices().some((m) => m.content?.includes(THINKING_SWITCH_NOTICE))).toBe(false);
	});

	it("high thinking WITHOUT an explicit timeout stays foreground (no deadline to lose)", async () => {
		const result = await dispatch({
			task: "review this change",
			thinkingLevel: "high",
			background: false,
		});

		expect(result.isError).toBeFalsy();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
	});

	it("an auto-routed high-thinking preset is switched too (the effective level, not just the declared one)", async () => {
		// "review" auto-routes to `code-reviewer`, whose preset declares
		// thinkingLevel: high — the caller declared no level at all, so a
		// declared-only check would miss exactly this run. Presets are loaded by
		// the session-start hook, so run it first (the other suites' pattern).
		optIn();
		await sessionStartHandler?.({}, makeCtx() as never);
		const result = await dispatch({
			task: `review the code for correctness\n\n${VALID_LINE}`,
			background: false,
			timeout: 900_000,
		});

		expect(result.isError).toBeFalsy();
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
		expect(h.runSubagent).not.toHaveBeenCalled();
		expect(notices().some((m) => m.content?.includes(THINKING_SWITCH_NOTICE))).toBe(true);
		// (The spawned run's own thinkingLevel is the CAPPED one — this harness's
		// maxThinkingLevel defaults to "off" — which is exactly why the pre-flight
		// judges the declared/routed level rather than the cap.)
	});

	it("high thinking with an omitted background keeps the existing default (no switch notice)", async () => {
		// Config default is 'writes' in this harness → omitted background resolves
		// foreground by the #361 default; the #412 switch does not fire because the
		// caller never asked for foreground explicitly.
		const result = await dispatch({
			task: "review this change",
			thinkingLevel: "high",
			timeout: 900_000,
		});

		expect(result.isError).toBeFalsy();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
		expect(notices().some((m) => m.content?.includes(THINKING_SWITCH_NOTICE))).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Issue #415 — the switch is project-local, not global
//
// #412 implemented a conductor decision rule as GLOBAL product behavior: any
// user dispatching `high`/`xhigh` + `background:false` + an explicit timeout
// got a background run with the 30-minute default instead. For a user an
// explicit foreground timeout is usually a BUDGET CAP, so the switch could
// triple time and cost against their instruction. The umbrella
// `processChecks` flag now gates it; the two directions are pinned here.
// ---------------------------------------------------------------------------

describe("the switch is opt-in per project (issue #415)", () => {
	it("USER PATH: no manifest field means the explicit foreground shape and its timeout stand", async () => {
		// env.testCwd has no package.json at all — exactly a user's project.
		const result = await dispatch({
			task: "read one file and answer inline",
			thinkingLevel: "high",
			background: false,
			timeout: 600_000,
		});

		expect(result.isError).toBeFalsy();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
		// Arg 8 of runSubagent is the foreground timeout: the user's cap survives.
		expect(h.runSubagent.mock.calls[0]?.[8]).toBe(600_000);
		expect(notices().some((m) => m.content?.includes(THINKING_SWITCH_NOTICE))).toBe(false);
	});

	it("OUR PATH: this repository (processChecks on) still gets the switch", async () => {
		const ctx = makeCtx();
		(ctx as { cwd: string }).cwd = REPO_ROOT;
		const result = await dispatch(
			{
				task: `Review one file.\n\n${VALID_LINE}`,
				thinkingLevel: "high",
				background: false,
				timeout: 900_000,
			},
			ctx,
		);

		expect(result.isError).toBeFalsy();
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
		expect(h.runSubagent).not.toHaveBeenCalled();
		expect(spawnArg().timeout).toBeUndefined();
		expect(notices().some((m) => m.content?.includes(THINKING_SWITCH_NOTICE))).toBe(true);
	});
});

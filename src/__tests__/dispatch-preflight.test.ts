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
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
	shouldDropUnitTimeout,
	THINKING_SWITCH_NOTICE,
	THINKING_TIMEOUT_DROP_NOTICE,
	THINKING_UNIT_TIMEOUT_DROP_NOTICE,
} from "../params";
import { CUSTOM_ENTRY_TYPES } from "../types";
import { setLogCwd } from "../logging";
import type { SubagentResult, ThinkingLevel } from "../types";
import { createTempEnv } from "./fixtures/temp-lifecycle";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_MODEL = { provider: "test", id: "test/model" };
const REPO_ROOT = path.resolve(__dirname, "..", "..");
const VALID_LINE = `jev: high (0.44) · C2 · worktree y`;

/** Opt a project directory in via the umbrella flag (issue #415). */
function optIn(dir: string = env.testCwd): void {
	writeFileSync(
		path.join(dir, "package.json"),
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
	details?: Record<string, unknown>;
}

let tool: ToolEntry;
let sendMessageSpy: ReturnType<typeof vi.fn>;
let notifySpy: ReturnType<typeof vi.fn>;
/**
 * Every `pi.appendEntry(customType, data)` the handler made this dispatch — the
 * seam `persistRunRecord` (run-registry.ts) writes the FOREGROUND run record
 * through. The record's `originalParams` is the retry snapshot, so this is the
 * only observable that can see the timeout/background the retry would restore
 * (a spawn-arg assertion cannot: the drop arm never spawns).
 */
let capturedEntries: Array<{ type?: string; customType?: string; data?: unknown }>;
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
		appendEntry: (customType: string, data: unknown) => {
			capturedEntries.push({ type: "custom", customType, data });
		},
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
			// The run records `state.persistRun` writes through `pi.appendEntry`
			// are the entries a `retryRunId` re-dispatch resolves from, and the
			// `originalParams` on them is the retry snapshot under test.
			getEntries: () => capturedEntries,
			appendCustomEntry: (entry: unknown) => capturedEntries.push(entry as never),
		},
		hasUI: false,
	};
}

type Ctx = ReturnType<typeof makeCtx>;

async function dispatch(
	params: Record<string, unknown>,
	ctx: Ctx = makeCtx(),
	signal?: AbortSignal,
): Promise<Awaited<ReturnType<ToolEntry["execute"]>>> {
	vi.useFakeTimers();
	try {
		return await tool.execute("call-412", params, signal, undefined, ctx);
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

/**
 * The FOREGROUND run record's `originalParams` (the retry snapshot), read from
 * the `pi.appendEntry` seam `state.persistRun` writes through.
 *
 * Distinct from `capturedOriginalParams` above: that one reads the BACKGROUND
 * spawn site. A foreground dispatch never reaches it, so the drop arm (#431)
 * has no other way to prove what a retry would restore.
 */
function foregroundSnapshot(): Record<string, unknown> {
	const runs = capturedEntries.filter(
		(e) => e.customType === CUSTOM_ENTRY_TYPES.run,
	);
	if (runs.length === 0) throw new Error("no foreground run record was persisted");
	const record = runs[runs.length - 1]?.data as { originalParams?: Record<string, unknown> } | undefined;
	const recorded = record?.originalParams;
	if (!recorded) throw new Error("the foreground run record carried no originalParams");
	return recorded;
}

/** Every notice the handler emitted this dispatch (pi.sendMessage channel). */
function notices(): CapturedMessage[] {
	return (sendMessageSpy.mock.calls as Array<[CapturedMessage, unknown]>).map((call) => call[0]);
}

/** Whether a notice carrying `text` went out on the UI channel. */
function notified(text: string): boolean {
	return notifySpy.mock.calls.some((call) => String(call[0]).includes(text));
}

/**
 * The drop notice's `details` payload — the only place the dropped ms value and
 * the mode the predicate was fed are recorded. Distinguished from the switch
 * arm's payload by the type of `previousTimeout` (a number here, "dropped"
 * there).
 */
function dropNoticeDetails(): Record<string, unknown> | undefined {
	return notices()
		.map((m) => m.details)
		.find((d) => typeof d?.previousTimeout === "number");
}

/**
 * Parse the shared log sink for this test's temp project. `beforeEach` points
 * the logger at `env.testCwd`, so the pre-flight's own log lines (the forced
 * arm has no notice — the log is its only observable) land here.
 */
function logEntries(): Array<{ message: string; data?: Record<string, unknown> }> {
	const file = path.join(env.testCwd, ".pi", "subagent-logs", "brl-subagent.log");
	if (!existsSync(file)) return [];
	return readFileSync(file, "utf-8")
		.split("\n")
		.filter(Boolean)
		.map((line) => JSON.parse(line));
}

/**
 * Seed the session-persisted config (the session_start restore path) so a
 * dispatch sees a CONFIGURED approval mode — the config tier of
 * `resolveEffectiveApprovalMode`, with no call param (issue #361's harness).
 */
async function seedConfig(ctx: Ctx, data: Record<string, unknown>): Promise<void> {
	(ctx.sessionManager as { getEntries: () => unknown[] }).getEntries = () => [
		{ type: "custom", customType: CUSTOM_ENTRY_TYPES.state, data },
	];
	if (sessionStartHandler) await sessionStartHandler({}, ctx as never);
}

beforeEach(() => {
	env.setUp();
	setLogCwd(env.testCwd);
	sendMessageSpy = vi.fn();
	notifySpy = vi.fn();
	capturedEntries = [];
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
		effectiveApprovalMode: "writes" as const,
	};

	it("switches a high/xhigh explicit-foreground dispatch when background is possible", () => {
		for (const mode of ["auto", "writes"] as const) {
			expect(
				resolveThinkingDispatchSwitch({ ...base, thinkingLevel: "high", effectiveApprovalMode: mode }),
			).toBe("switch");
			expect(
				resolveThinkingDispatchSwitch({ ...base, thinkingLevel: "xhigh", effectiveApprovalMode: mode }),
			).toBe("switch");
		}
	});

	it("drops the timeout instead of switching when the effective mode blocks background (#433)", () => {
		// 'always' has no approval dialog in background, so the switch arm would be
		// REJECTED at the spawn gate. The pre-flight must never turn a valid
		// dispatch into an error: keep the foreground shape, remove the deadline.
		expect(
			resolveThinkingDispatchSwitch({
				...base,
				thinkingLevel: "high",
				effectiveApprovalMode: "always",
			}),
		).toBe("drop-timeout");
		expect(
			resolveThinkingDispatchSwitch({
				...base,
				thinkingLevel: "xhigh",
				effectiveApprovalMode: "always",
			}),
		).toBe("drop-timeout");
	});

	it("never switches below high", () => {
		for (const level of ["off", "minimal", "low", "medium"] as ThinkingLevel[]) {
			expect(resolveThinkingDispatchSwitch({ ...base, thinkingLevel: level })).toBe("none");
		}
	});

	it("never acts without an explicit timeout (there is nothing to drop)", () => {
		expect(
			resolveThinkingDispatchSwitch({ ...base, thinkingLevel: "high", timeout: undefined }),
		).toBe("none");
		expect(
			resolveThinkingDispatchSwitch({
				...base,
				thinkingLevel: "high",
				explicitBackground: undefined,
				effectiveApprovalMode: "always",
				timeout: undefined,
			}),
		).toBe("none");
	});

	it("never touches an explicit-true background (the caller already asked for background)", () => {
		expect(
			resolveThinkingDispatchSwitch({
				...base,
				thinkingLevel: "high",
				explicitBackground: true,
			}),
		).toBe("none");
		expect(
			resolveThinkingDispatchSwitch({
				...base,
				thinkingLevel: "high",
				explicitBackground: true,
				effectiveApprovalMode: "auto",
			}),
		).toBe("none");
	});

	it("follows the #361 default for an omitted background: only the foreground default drops the deadline", () => {
		// Omitted + effective auto → the default is background: nothing to remove.
		expect(
			resolveThinkingDispatchSwitch({
				...base,
				thinkingLevel: "high",
				explicitBackground: undefined,
				effectiveApprovalMode: "auto",
			}),
		).toBe("none");
		// Omitted + writes/always → the default is FOREGROUND, so the explicit
		// deadline is the only thing standing between the run and its work.
		for (const mode of ["writes", "always"] as const) {
			expect(
				resolveThinkingDispatchSwitch({
					...base,
					thinkingLevel: "high",
					explicitBackground: undefined,
					effectiveApprovalMode: mode,
				}),
			).toBe("drop-timeout");
		}
	});

	it("never touches a batch shape (an uncapped batch multiplies the hang — #434)", () => {
		for (const shape of ["chain", "graph"] as const) {
			expect(
				resolveThinkingDispatchSwitch({ ...base, thinkingLevel: "high", shape }),
			).toBe("none");
			expect(
				resolveThinkingDispatchSwitch({
					...base,
					thinkingLevel: "high",
					shape,
					explicitBackground: undefined,
				}),
			).toBe("none");
		}
	});

	it("never acts when the project has not opted in (issue #415: the user's shape stands)", () => {
		expect(
			resolveThinkingDispatchSwitch({ ...base, processChecks: false, thinkingLevel: "high" }),
		).toBe("none");
		for (const explicitBackground of [false, undefined] as const) {
			expect(
				resolveThinkingDispatchSwitch({
					...base,
					processChecks: false,
					thinkingLevel: "xhigh",
					explicitBackground,
					effectiveApprovalMode: "always",
					force: true,
				}),
			).toBe("none");
		}
	});
});

// ---------------------------------------------------------------------------
// force precedence (issue #431, D1) — force overrides an ACTING arm only
// ---------------------------------------------------------------------------

describe("force precedence: override an acting arm, never invent one (issue #431)", () => {
	const base = {
		processChecks: true,
		timeout: 900_000,
		force: true,
		shape: "single" as const,
		thinkingLevel: "high" as const,
	};

	it("maps every acting arm (switch and drop-timeout) to 'forced'", () => {
		for (const effectiveApprovalMode of ["auto", "writes", "always"] as const) {
			expect(
				resolveThinkingDispatchSwitch({ ...base, explicitBackground: false, effectiveApprovalMode }),
			).toBe("forced");
		}
		for (const effectiveApprovalMode of ["writes", "always"] as const) {
			expect(
				resolveThinkingDispatchSwitch({ ...base, explicitBackground: undefined, effectiveApprovalMode }),
			).toBe("forced");
		}
	});

	it("leaves a 'none' arm as 'none' regardless of force", () => {
		// Nothing to override: a background run must never emit the "foreground
		// forced" log line (there is no foreground to keep).
		expect(
			resolveThinkingDispatchSwitch({ ...base, explicitBackground: true, effectiveApprovalMode: "writes" }),
		).toBe("none");
		expect(
			resolveThinkingDispatchSwitch({ ...base, explicitBackground: undefined, effectiveApprovalMode: "auto" }),
		).toBe("none");
		expect(
			resolveThinkingDispatchSwitch({
				...base,
				explicitBackground: false,
				effectiveApprovalMode: "writes",
				thinkingLevel: "medium",
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

	it("processChecks OFF: an omitted background keeps the #361 default and its explicit timeout", async () => {
		// This test never calls optIn(), so the temp project has NO manifest and
		// `processChecks` is off (fail-open). The pre-flight is therefore inert for
		// BOTH shapes: the #361 default resolves the omitted background to
		// foreground ('writes' is this harness's configured default), and the
		// explicit timeout survives untouched because the project never opted in.
		// (It is NOT evidence about what happens when opted in — that is the
		// drop-timeout arm below, issue #431.)
		const result = await dispatch({
			task: "review this change",
			thinkingLevel: "high",
			timeout: 900_000,
		});

		expect(result.isError).toBeFalsy();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
		// The user's cap survives the dispatch verbatim.
		expect(h.runSubagent.mock.calls[0]?.[8]).toBe(900_000);
		expect(notices().some((m) => m.content?.includes(THINKING_SWITCH_NOTICE))).toBe(false);
		expect(notices().some((m) => m.content?.includes(THINKING_TIMEOUT_DROP_NOTICE))).toBe(false);
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

// ---------------------------------------------------------------------------
// Issue #431 — the second arm: keep the shape, drop the deadline
//
// The incident: a `high` plan critique was dispatched with `background`
// OMITTED and `timeout: 600000`. The effective mode was `writes`, so the #361
// default kept it FOREGROUND — and the #412 switch, which requires an explicit
// `background: false`, never fired. The run was killed at 10m0s and the work was
// lost. The hazard was never the foreground shape; it was the DEADLINE on an
// unpersisted run.
//
// So the pre-flight gains a second outcome: when the effective shape is
// foreground and background is impossible (or was never asked for), drop the
// explicit timeout. Foreground has NO default deadline (issue #423), so the
// run becomes unkillable by its own clock while its approval gate stays exactly
// where the user put it.
// ---------------------------------------------------------------------------

describe("drop-timeout: foreground keeps its shape, loses its deadline (issue #431)", () => {
	it("omitted background + effective 'writes' → foreground, timeout dropped, notice on both channels", async () => {
		optIn();
		const result = await dispatch({
			task: `critique the plan\n\n${VALID_LINE}`,
			thinkingLevel: "high",
			approvalMode: "writes",
			timeout: 600_000,
		});

		// C: the approval gate is observably unchanged. The run never reached the
		// background spawn (where `writes` logs its "auto-approving" warning), so
		// the diff is still gated on approval.
		expect(result.isError).toBeFalsy();
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
		expect(result.content[0].text).not.toContain("Background agent started");
		expect(
			logEntries().some((e) => e.message.includes("auto-approving")),
			"the background auto-approve warning must not fire for a foreground run",
		).toBe(false);

		// The explicit foreground timeout is DROPPED — foreground has no default
		// deadline, so nothing can kill the run (arg 8 of runSubagent).
		expect(h.runSubagent.mock.calls[0]?.[8]).toBeUndefined();

		// F: the drop arm's OWN notice, exactly, on BOTH channels the switch arm
		// uses — and never the switch notice, whose "the run is now background"
		// sentence would be a lie here.
		const dropNotices = notices().filter((m) => m.content?.includes(THINKING_TIMEOUT_DROP_NOTICE));
		expect(dropNotices, "the drop must emit its notice").toHaveLength(1);
		expect(notified(THINKING_TIMEOUT_DROP_NOTICE), "the human channel needs the notice too").toBe(true);
		expect(notices().some((m) => m.content?.includes(THINKING_SWITCH_NOTICE))).toBe(false);
		expect(notified(THINKING_SWITCH_NOTICE)).toBe(false);

		// The dropped value is the ACTUAL ms, not the switch arm's "dropped": a
		// friction-log reader needs the number to tell a budget cap from a clock.
		const details = dropNoticeDetails();
		expect(details?.previousTimeout).toBe(600_000);
		expect(details?.effectiveApprovalMode).toBe("writes");
	});

	it("records the dropped deadline in the FOREGROUND run record before the snapshot (acceptance A)", async () => {
		// The order mutant (clear the timeout AFTER `snapshotOriginalParams`) keeps
		// the RUN deadline-free, so a runSubagent-arg assertion cannot see it: only
		// the recorded `originalParams` can. A retry would restore the cap from
		// here (ADR 0009).
		optIn();
		await dispatch({
			task: `critique the plan\n\n${VALID_LINE}`,
			thinkingLevel: "xhigh",
			approvalMode: "writes",
			timeout: 600_000,
		});

		const snapshot = foregroundSnapshot();
		expect(snapshot.timeout).toBeUndefined();
		expect(snapshot.background).toBe(false);

		// Stronger twin: a retry of that record re-derives the same shape and
		// deadline (foreground, no timeout) instead of restoring the cap.
		const runId = (capturedEntries.find((e) => e.customType === CUSTOM_ENTRY_TYPES.run)?.data as {
			id: string;
		}).id;
		const retried = await dispatch({ retryRunId: runId });

		expect(retried.isError).toBeFalsy();
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
		expect(h.runSubagent).toHaveBeenCalledTimes(2);
		expect(h.runSubagent.mock.calls[1]?.[8]).toBeUndefined();
		// Idempotent: the restored `timeout: undefined` exits the pre-flight
		// early, so the retry emits no second notice.
		expect(
			notices().filter((m) => m.content?.includes(THINKING_TIMEOUT_DROP_NOTICE)),
		).toHaveLength(1);
	});

	it("config tier: a seeded 'writes' mode reaches the predicate with no call param (acceptance B)", async () => {
		optIn();
		const ctx = makeCtx();
		await seedConfig(ctx, { approvalMode: "writes" });
		const result = await dispatch(
			{ task: `critique the plan\n\n${VALID_LINE}`, thinkingLevel: "high", timeout: 600_000 },
			ctx,
		);

		expect(result.isError).toBeFalsy();
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
		expect(h.runSubagent.mock.calls[0]?.[8]).toBeUndefined();
		expect(notified(THINKING_TIMEOUT_DROP_NOTICE)).toBe(true);
		// M7: the notice records the mode the predicate ACTUALLY judged. The verdict
		// on the omitted row is the same for a raw `undefined` and for 'writes'
		// (both resolve foreground), so the verdict alone cannot tell them apart —
		// the recorded mode can. A call site that fed the raw call param leaves this
		// empty while the dispatch still looks right.
		expect(dropNoticeDetails()?.effectiveApprovalMode).toBe("writes");
	});

	it("config tier: a seeded 'always' mode is not rejected — foreground, no deadline (acceptance B, #433)", async () => {
		optIn();
		const ctx = makeCtx();
		await seedConfig(ctx, { approvalMode: "always" });
		const result = await dispatch(
			{ task: `critique the plan\n\n${VALID_LINE}`, thinkingLevel: "high", timeout: 600_000 },
			ctx,
		);

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).not.toContain(
			"Cannot spawn background agent with approvalMode 'always'",
		);
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
		expect(h.runSubagent.mock.calls[0]?.[8]).toBeUndefined();
	});

	it("config tier: seeded 'always' + explicit background:false is not switched into a rejection (M13)", async () => {
		// The omitted-background rows cannot tell a config-resolved mode from a raw
		// `undefined` call param: both 'writes' and 'always' resolve foreground, and
		// a raw undefined is not 'auto' either — the verdict is `drop-timeout`
		// either way. This row CAN: with the effective mode resolved (always), the
		// pre-flight keeps the shape and drops the deadline; a call site that fed
		// the predicate the raw param would take the `switch` arm and be REJECTED
		// at the background gate (#433 all over again, through the config tier).
		optIn();
		const ctx = makeCtx();
		await seedConfig(ctx, { approvalMode: "always" });
		const result = await dispatch(
			{
				task: `critique the plan\n\n${VALID_LINE}`,
				thinkingLevel: "high",
				background: false,
				timeout: 600_000,
			},
			ctx,
		);

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).not.toContain(
			"Cannot spawn background agent with approvalMode 'always'",
		);
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
		expect(h.runSubagent.mock.calls[0]?.[8]).toBeUndefined();
		expect(notified(THINKING_TIMEOUT_DROP_NOTICE)).toBe(true);
	});

	it("force:true overrides the drop — the explicit timeout is preserved, and only the log records it", async () => {
		optIn();
		const result = await dispatch({
			task: `critique the plan\n\n${VALID_LINE}`,
			thinkingLevel: "high",
			approvalMode: "writes",
			timeout: 600_000,
			force: true,
		});

		expect(result.isError).toBeFalsy();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
		expect(h.runSubagent.mock.calls[0]?.[8]).toBe(600_000);
		// The override is logged, never silent — and never announced as a notice
		// (a notice would imply the dispatch changed something, and it did not).
		expect(
			logEntries().some((e) => e.message.includes("high-thinking foreground forced")),
		).toBe(true);
		expect(notices()).toHaveLength(0);
		expect(notified(THINKING_TIMEOUT_DROP_NOTICE)).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Issue #433 — the pre-flight must never switch a valid dispatch into a
// rejection. `approvalMode: 'always'` cannot run in background (W5, issue #28:
// no dialog there), so the shipped switch arm turned an explicit
// `background: false` dispatch into a loud "Cannot spawn background agent"
// error. The durable-path intent is satisfied the other way instead: keep the
// run foreground and drop the explicit timeout (the #431 second arm).
// ---------------------------------------------------------------------------

describe("issue #433: never switch into a rejection (approvalMode 'always')", () => {
	it("does not reject an explicit-foreground 'always' dispatch — it runs foreground with no deadline", async () => {
		optIn();
		const result = await dispatch({
			task: `critique the plan\n\n${VALID_LINE}`,
			thinkingLevel: "high",
			background: false,
			approvalMode: "always",
			timeout: 600_000,
		});

		// The dispatch is NOT converted into an error by its own pre-flight.
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).not.toContain(
			"Cannot spawn background agent with approvalMode 'always'",
		);
		// Foreground, with the explicit timeout dropped — no clock kills it.
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
		expect(h.runSubagent.mock.calls[0]?.[8]).toBeUndefined();

		// The retry snapshot records the shape that actually ran and drops the
		// cap, so a retry re-derives instead of restoring the foreground deadline.
		const snapshot = foregroundSnapshot();
		expect(snapshot.background).toBe(false);
		expect(snapshot.timeout).toBeUndefined();

		// The drop arm's notice, not the switch arm's (whose text says the run is
		// now background — false here).
		expect(notified(THINKING_TIMEOUT_DROP_NOTICE)).toBe(true);
		expect(notified(THINKING_SWITCH_NOTICE)).toBe(false);
	});

	it("the shipped explicit-false 'switch' arm is unchanged for auto/writes", async () => {
		// Non-regression for #433's scope: only `always` changes arms.
		optIn();
		for (const mode of ["auto", "writes"] as const) {
			h.spawnBackgroundSession.mockClear();
			h.runSubagent.mockClear();
			const result = await dispatch({
				task: `critique the plan\n\n${VALID_LINE}`,
				thinkingLevel: "high",
				background: false,
				approvalMode: mode,
				timeout: 600_000,
			});

			expect(result.isError).toBeFalsy();
			expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
			expect(h.runSubagent).not.toHaveBeenCalled();
			expect(spawnArg().timeout).toBeUndefined();
			expect(notified(THINKING_SWITCH_NOTICE)).toBe(true);
			expect(notified(THINKING_TIMEOUT_DROP_NOTICE)).toBe(false);
		}
	});
});

// ---------------------------------------------------------------------------
// Issue #434 — the pre-flight's UNIT projection: a batch unit's own pair
//
// #431 judged the DISPATCH-level pair, so a unit declaring `thinkingLevel:
// "high"` + `timeout: 600000` under a dispatch with no top-level pair
// reproduced the 2026-11-06 incident for that unit alone: the predicate exits
// on `params.timeout === undefined`, and every unit site passed
// `merged.timeout` to the runner. Seams used below: `runSubagent` arg 8 (arg 3
// its level) and the persisted record's `originalParams` — the retry snapshot
// (ADR 0009).
// ---------------------------------------------------------------------------

describe("unit shape guard: a batch unit's own declared pair (issue #434)", () => {
	/** A task carrying the Jev line every opted-in unit is validated for. */
	const TASK = `read one file and answer inline\n\n${VALID_LINE}`;
	/** A unit declaring the incident's pair; `{ field: undefined }` inherits it. */
	const unit = (over: Record<string, unknown> = {}) => ({
		task: TASK, thinkingLevel: "high", timeout: 600_000, ...over,
	});
	const unitNotices = () =>
		notices().filter((m) => m.content?.includes(THINKING_UNIT_TIMEOUT_DROP_NOTICE));
	/** The deadline (arg 8) and level (arg 3) the unit actually ran with. */
	const ranWith = (i = 0) => h.runSubagent.mock.calls[i]?.[8];
	const ranLevel = (i = 0) => h.runSubagent.mock.calls[i]?.[3];
	const reset = () => {
		h.runSubagent.mockClear();
		sendMessageSpy.mockClear();
		notifySpy.mockClear();
	};

	it("U1/U1b (M8): cap `off` and `high` both drop a parallel unit's deadline", async () => {
		optIn();
		// U1: an unconfigured cap is `off`, so the unit RUNS at `off` while it
		// DECLARED high — judging the capped `merged.thinkingLevel` misses it.
		await dispatch({ tasks: [unit()], background: false });
		expect([ranLevel(), ranWith()]).toEqual(["off", undefined]);
		// U1b: with cap `high` the capped level agrees with the declaration, so
		// this row alone cannot tell the two judgements apart; U1 does.
		reset();
		const ctx = makeCtx();
		await seedConfig(ctx, { maxThinkingLevel: "high" });
		await dispatch({ tasks: [unit()], background: false }, ctx);
		expect([ranLevel(), ranWith()]).toEqual(["high", undefined]);
	});

	it("U2/U2b (M1): a chain step and a graph node declaring the pair are dropped", async () => {
		optIn();
		await dispatch({ chain: [unit()] });
		expect(ranWith()).toBeUndefined();
		expect(unitNotices()).toHaveLength(1); // one notice per DISPATCH, not per unit
		reset();
		await dispatch({ graph: [{ id: "n1", ...unit({ label: "n1" }) }] });
		expect(ranWith()).toBeUndefined();
		expect(unitNotices()).toHaveLength(1);
	});

	it("U3/U3b (M2): an INHERITED pair stays exempt in chain and graph (#431 boundary)", async () => {
		optIn();
		// Clause 5: the unit declares NEITHER field, so the dispatch already judged
		// the pair — and a batch shape keeps the #431 exemption.
		const inherited = { thinkingLevel: undefined, timeout: undefined };
		const pair = { thinkingLevel: "high", timeout: 600_000 };
		await dispatch({ chain: [unit(inherited)], ...pair });
		expect(ranWith()).toBe(600_000);
		reset();
		await dispatch({ graph: [{ id: "n1", ...unit({ ...inherited, label: "n1" }) }], ...pair });
		expect(ranWith()).toBe(600_000);
		expect(unitNotices()).toHaveLength(0);
	});

	it('U3c-a/U3c-b: `""` inherits the level; `timeout: 0` overrides and arms nothing', async () => {
		optIn();
		// U3c-a: `""` is INHERITANCE (the level clause sees the dispatch's `high`),
		// so a unit-declared deadline is still dropped and the notice says which
		// level it was judged on.
		const ctx = makeCtx();
		await seedConfig(ctx, { maxThinkingLevel: "high" });
		await dispatch(
			{ chain: [unit({ thinkingLevel: "" })], thinkingLevel: "high", timeout: 600_000 },
			ctx,
		);
		expect([ranLevel(), ranWith()]).toEqual(["high", undefined]);
		expect(unitNotices()[0]?.details?.thinkingLevel).toBe("high");
		// U3c-b: `0` is a declaration that OVERRIDES the inherited 600000 (the merge
		// is `??`) and arms no timer at all — no hazard to drop, nothing to announce.
		reset();
		await dispatch({ tasks: [unit({ timeout: 0 })], timeout: 600_000 });
		expect(ranWith()).toBe(0);
		expect(unitNotices()).toHaveLength(0);
	});

	it("U3d (M9): EITHER field alone makes the pair unit-declared", async () => {
		optIn();
		// (a) level only: it declares high, the deadline is inherited.
		await dispatch({ tasks: [unit({ timeout: undefined })], timeout: 600_000 });
		expect(ranWith()).toBeUndefined();
		// (b) timeout only: it declares the deadline, the LEVEL is the dispatch's —
		// judging only the unit's own level leaves this row's 600000 in place.
		reset();
		await dispatch({ tasks: [unit({ thinkingLevel: undefined })], thinkingLevel: "high" });
		expect(ranWith()).toBeUndefined();
	});

	it("U4 (M5): a background fan-out unit KEEPS its deadline — there it is the budget", async () => {
		optIn();
		await dispatch({ tasks: [unit()], background: true });
		expect(spawnArg().timeout).toBe(600_000);
		expect(unitNotices()).toHaveLength(0);
	});

	it("U5 (M6): ONE additional notice per dispatch, none once the dispatch arm spoke", async () => {
		optIn();
		await dispatch({ tasks: [unit({ label: "a" }), unit({ label: "b" })], background: false });
		const emitted = unitNotices();
		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.details?.unit).toMatch(/^(a|b)$/);
		// The wording must not claim completeness: a later unit is judged later.
		expect(emitted[0]?.content).toContain("not covered");
		expect(emitted[0]?.content).not.toMatch(/all (affected )?(units|steps)/i);
		expect(
			notifySpy.mock.calls.filter((c) => String(c[0]).includes(THINKING_UNIT_TIMEOUT_DROP_NOTICE)),
		).toHaveLength(1);
		for (const call of h.runSubagent.mock.calls) expect(call[8]).toBeUndefined();
		// Mixed: the DISPATCH arm drops the top-level pair and announces itself, so
		// the unit's drop is silent — one notice in total, still the drop. (The
		// explicit-foreground `always` shape is the one the drop arm owns; `writes`
		// would switch a parallel dispatch into the fan-out instead.)
		reset();
		await dispatch({
			tasks: [unit({ label: "c" })], background: false,
			approvalMode: "always", thinkingLevel: "high", timeout: 600_000,
		});
		expect(notices().filter((m) => m.content?.includes(THINKING_TIMEOUT_DROP_NOTICE))).toHaveLength(1);
		expect(unitNotices()).toHaveLength(0);
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
		expect(ranWith()).toBeUndefined();
	});

	it("U6/U7 (M3/M4): force:true and an opted-OUT project both keep the deadline", async () => {
		optIn();
		await dispatch({ tasks: [unit()], background: false, force: true });
		expect(ranWith()).toBe(600_000);
		expect(unitNotices()).toHaveLength(0);
		// U7: no manifest field (a user's project) — nothing is dropped.
		rmSync(path.join(env.testCwd, "package.json"));
		reset();
		await dispatch({ tasks: [unit()], background: false });
		expect(ranWith()).toBe(600_000);
		expect(unitNotices()).toHaveLength(0);
	});

	it("U7b (M10): a RELATIVE cwd is judged by the dispatch's resolution, not a re-read", async () => {
		// The dispatch resolves `proj` against `ctx.cwd`; a unit site that re-read
		// the flag from the raw relative path would resolve it against the PROCESS
		// cwd (this repository, where `proj` does not exist) and read `false`.
		const projectDir = path.join(env.testCwd, "proj");
		mkdirSync(projectDir, { recursive: true });
		optIn(projectDir);
		await dispatch({ tasks: [unit()], background: false, cwd: "proj" });
		expect(ranWith()).toBeUndefined();
	});

	it("U8 (M7): the unit SNAPSHOT has no deadline, and the retry's run has none", async () => {
		optIn();
		await dispatch({ tasks: [unit()], background: false });
		expect(foregroundSnapshot().timeout).toBeUndefined();
		const runId = (capturedEntries.find((e) => e.customType === CUSTOM_ENTRY_TYPES.run)?.data as {
			id: string;
		}).id;
		// The retry restores the unit's own snapshot, whose level is the CAPPED
		// `off` and whose deadline is absent — so a second DISPATCH-level drop
		// cannot be what makes this pass. Only the recorded snapshot can.
		const retried = await dispatch({ retryRunId: runId });
		expect(retried.isError).toBeFalsy();
		expect(h.runSubagent).toHaveBeenCalledTimes(2);
		expect(ranWith(1)).toBeUndefined();
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
	});

	it("U9: an eligible unit that never reaches its run is never announced", async () => {
		optIn();
		// (a) a chain stops on the first failed step: the eligible SECOND step is
		// absent from the run, and from the notice.
		h.runSubagent.mockImplementationOnce(
			async (_cwd: string, _prompt: string, model: { provider: string; id: string }) => ({
				...makeResult(`${model.provider}/${model.id}`),
				exitCode: 1,
			}),
		);
		const stopped = await dispatch({
			chain: [unit({ thinkingLevel: undefined, timeout: undefined }), unit()],
		});
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
		expect((stopped.details as { stoppedEarly?: boolean }).stoppedEarly).toBe(true);
		expect(unitNotices()).toHaveLength(0);
		// (b) a parallel unit cancelled while WAITING for its slot is never
		// announced: the drop sits after acquisition, so a queued unit the caller
		// aborts has not been judged at all.
		h.runSubagent.mockReset();
		let release: () => void = () => {};
		const blocked = new Promise<void>((resolve) => {
			release = resolve;
		});
		h.runSubagent.mockImplementation(
			async (_cwd: string, _prompt: string, model: { provider: string; id: string }) => {
				await blocked;
				return makeResult(`${model.provider}/${model.id}`);
			},
		);
		const ctx = makeCtx();
		await seedConfig(ctx, { maxParallel: 1 });
		const controller = new AbortController();
		const pending = dispatch(
			{ tasks: [unit({ label: "first" }), unit({ label: "second" })], background: false },
			ctx,
			controller.signal,
		);
		await vi.advanceTimersByTimeAsync(0);
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
		controller.abort();
		release();
		await pending;
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
		const emitted = unitNotices();
		expect(emitted).toHaveLength(1);
		expect(emitted[0]?.details?.unit).toBe("first");
	});

	it("U10 (drift pin): the unit projection agrees with the dispatch arm on the same pair", () => {
		// One rule at two levels: a one-sided edit to either predicate must fail
		// here rather than drift quietly.
		const dispatchActs = (level: string, timeout: number | undefined) =>
			resolveThinkingDispatchSwitch({
				processChecks: true,
				thinkingLevel: (level || undefined) as ThinkingLevel | undefined,
				explicitBackground: false,
				timeout,
				force: undefined,
				shape: "single",
				effectiveApprovalMode: "writes",
			}) !== "none";
		const unitActs = (level: string, timeout: number | undefined) =>
			shouldDropUnitTimeout({
				processChecks: true,
				force: undefined,
				dispatchDeclaredLevel: undefined,
				unitShape: "foreground",
				declaredLevel: level as ThinkingLevel | "",
				declaredTimeout: timeout,
				mergedTimeout: timeout,
			});
		for (const level of ["high", "xhigh", "medium", "low", ""]) {
			for (const timeout of [600_000, undefined, 0]) {
				const label = `${level || '""'}/${timeout}`;
				if (timeout === 0) {
					// Documented divergence (clause 4): `0` is a declaration that arms
					// no timer, so the unit guard must refuse it while the dispatch
					// arm's "a timeout exists" clause is satisfied — the dispatch's drop
					// is a no-op there, a unit notice would be a lie.
					expect(unitActs(level, 0), label).toBe(false);
					expect(dispatchActs(level, 0), label).toBe(level === "high" || level === "xhigh");
					continue;
				}
				expect(unitActs(level, timeout), label).toBe(dispatchActs(level, timeout));
			}
		}
		// Documented divergence (clause 5): a unit declaring NEITHER field inherits
		// the dispatch's pair, already judged one level up.
		for (const level of ["high", "xhigh"] as const) {
			expect(dispatchActs(level, 600_000)).toBe(true);
			expect(
				shouldDropUnitTimeout({
					processChecks: true,
					force: undefined,
					dispatchDeclaredLevel: level,
					unitShape: "foreground",
					declaredLevel: undefined,
					declaredTimeout: undefined,
					mergedTimeout: 600_000,
				}),
			).toBe(false);
		}
	});
});

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
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
	THINKING_TIMEOUT_DROP_NOTICE,
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
		const details = (sendMessageSpy.mock.calls as Array<[{ details?: Record<string, unknown> }]>)
			.map((call) => call[0].details)
			.find((d) => d?.previousTimeout === 600_000);
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

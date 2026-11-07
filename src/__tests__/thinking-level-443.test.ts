/**
 * Issue #443 — an unsupported `thinkingLevel` is rejected BEFORE any launch.
 *
 * THE DEFECT THIS PINS (measured on the pre-fix tree, pi 1.5.0):
 * `resolveThinkingLevel` clamps but cannot fail. An unknown declaration
 * (`"bogus"`, `"MAX"`, `"High"`, `" high"`) has index -1, so it resolved to
 * `undefined`, reached the child as `--thinking undefined`, and pi warned
 * (`Invalid thinking level "undefined"`) and ran at ITS OWN default — the
 * configured cap bypassed, not a launch refused. Background behaved the same
 * (an SDK session at the model default while the records said otherwise), and a
 * bad SECOND unit still started the whole batch.
 *
 * THE FALSIFIER IS A REGISTERED DISPATCH THAT LAUNCHES NOTHING. Two launch
 * seams are watched, and both mean "a child/SDK session started":
 *   - `runSubagent` (mocked `../runner`) — the foreground process spawn;
 *   - `spawnBackgroundSession` (mocked `../session-manager`) — the background
 *     SDK session.
 * The tests deliberately do NOT assert on the resolver or on argv: a guard at
 * the pre-spawn seam legitimately leaves those inner calls unchanged.
 *
 * BYPASS BY DESIGN: `execute` is called directly with a plain object, so pi's
 * tool-argument validation never runs here. That is the point — a schema
 * rejection cannot exercise the runtime guard, and every path below (restored
 * `retryRunId` values, the transport auto-retry's rebuilt params, injected
 * preset objects, per-unit declarations) reaches the handler without the schema
 * anyway. The schema's own boundary is pinned separately in §8.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

const h = vi.hoisted(() => ({
	runSubagent: vi.fn(),
	cleanupTempDirs: vi.fn().mockResolvedValue(0),
	getPiInvocation: vi.fn(),
	accumulateUsage: vi.fn(),
	parseSubagentLine: vi.fn(),
	spawnBackgroundSession: vi.fn(),
	getAgent: vi.fn(),
	/** The custom preset tier, controlled per test (a programmatic injection). */
	customPresets: [] as Array<Record<string, unknown>>,
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

/**
 * The preset FILE tier validates `thinkingLevel` on load (`presets.ts`), so an
 * invalid level can only arrive as an IN-MEMORY object — a preset built by a
 * consumer and handed to the session, which `getPreset` trusts. Replacing the
 * loader is how this suite models that injection without a second validator.
 */
vi.mock("../presets", async (importOriginal) => ({
	...(await importOriginal<typeof import("../presets")>()),
	loadCustomPresets: () => h.customPresets,
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

import * as eventBus from "../event-bus";
import initExtension from "../index";
import { __resetTerminalClaims } from "../notify-completion";
import { delegateTaskParamsSchema } from "../schema";
import { CUSTOM_ENTRY_TYPES, THINKING_LEVELS, isThinkingLevel, resolveThinkingLevel } from "../types";
import type { SubagentRun, SubagentResult, ThinkingLevel } from "../types";
import { invalidThinkingLevelRejection } from "../prelude";
import { TRANSPORT_RETRY_TOAST } from "../transport-retry";
import { createTempEnv } from "./fixtures/temp-lifecycle";

const env = createTempEnv("brl-443");
const GLOBAL_MODEL = { provider: "test", id: "test/model" };

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

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
let sessionStartHandler:
	| ((_event: unknown, ctx: Record<string, unknown>) => Promise<void>)
	| undefined;
let sendMessageSpy: ReturnType<typeof vi.fn>;
let notifySpy: ReturnType<typeof vi.fn>;
/** The run/state entries `state.getRunEntries(ctx)` / `restoreFromSession` read. */
let sessionEntries: Array<Record<string, unknown>> = [];
let activeCtx: Record<string, unknown>;
let spawnSeq = 0;
const agentsById = new Map<string, Record<string, unknown>>();

function makeResult(modelStr: string): SubagentResult {
	return {
		messages: [{ role: "assistant", content: [{ type: "text", text: "done" }], model: modelStr }],
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 0, turns: 1 },
		exitCode: 0,
		stderr: "",
		model: modelStr,
		stopReason: "end_turn",
		errorCategory: "unknown",
	};
}

function makeFakeAgent(p: Record<string, unknown>): Record<string, unknown> {
	spawnSeq += 1;
	const agent = {
		id: `bg-443-${spawnSeq}`,
		sessionId: `sess-bg-443-${spawnSeq}`,
		type: "general-purpose",
		description: p.description ?? "",
		status: "running",
		startedAt: 1700000000000 + spawnSeq,
		task: p.task ?? "",
		model: `${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`,
		thinkingLevel: p.thinkingLevel,
	};
	agentsById.set(agent.id, agent);
	return agent;
}

/** ONE extension instance for the file: each init adds permanent event-bus listeners. */
function setupExtension(): ToolEntry {
	const registered = new Map<string, ToolEntry>();
	const mockPi = {
		registerTool: (t: ToolEntry) => registered.set(t.name, t),
		registerCommand: () => {},
		registerShortcut: () => {},
		on: (event: string, handler: (_event: unknown, ctx: Record<string, unknown>) => Promise<void>) => {
			if (event === "session_start") sessionStartHandler = handler;
		},
		appendEntry: () => {},
		sendMessage: sendMessageSpy,
		ctx: { getState: () => undefined, setState: () => {} },
	};
	initExtension(mockPi as never);
	const entry = registered.get("delegate_task");
	if (!entry) throw new Error("delegate_task tool not registered");
	return entry;
}

function makeCtx(): Record<string, unknown> {
	return {
		cwd: env.testCwd,
		model: GLOBAL_MODEL,
		modelRegistry: {
			find: (provider: string, id: string) =>
				`${provider}/${id}` === `${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`
					? { provider, id }
					: undefined,
			hasConfiguredAuth: () => true,
		},
		getSystemPrompt: () => "You are a helpful assistant.",
		ui: {
			notify: notifySpy,
			setStatus: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: {
			getEntries: () => sessionEntries,
			appendCustomEntry: (e: unknown) => sessionEntries.push(e as never),
		},
		hasUI: false,
	};
}

async function startSession(): Promise<void> {
	activeCtx = makeCtx();
	if (sessionStartHandler) await sessionStartHandler({}, activeCtx);
}

/**
 * Seed the session-persisted config (the `session_start` restore path): the cap
 * a dispatch runs against. Seeded explicitly per test — the real default is
 * `"off"`, which would make a cap assertion pass for the wrong reason.
 */
async function seedConfig(data: Record<string, unknown>): Promise<void> {
	sessionEntries.push({ type: "custom", customType: CUSTOM_ENTRY_TYPES.state, data });
	await startSession();
}

/**
 * Inject the custom preset tier and reload it into the session's state. The
 * array must be handed to the loader — `session_start` copies whatever the
 * loader returns, so assigning after the fact would change nothing.
 */
async function injectPresets(presets: Array<Record<string, unknown>>): Promise<void> {
	h.customPresets = presets;
	await startSession();
}

/** Push a run entry the session-manager would have persisted. */
function persistRunEntry(run: SubagentRun): void {
	sessionEntries.push({ type: "custom", customType: CUSTOM_ENTRY_TYPES.run, data: run });
}

function aFailedRun(overrides: Partial<SubagentRun> = {}): SubagentRun {
	return {
		id: "run-443-source",
		task: "read one file and answer inline",
		label: "prior-run",
		status: "failed",
		model: `${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`,
		thinkingLevel: "medium",
		startedAt: "2026-11-07T10:00:00.000Z",
		durationMs: 1000,
		errorCategory: "exit_error",
		errorMessage: "Connection error.",
		attempt: 1,
		originalParams: { background: true, model: `${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}` },
		...overrides,
	};
}

/** Dispatch through the REAL registered tool. Fake timers: background runs arm timers. */
async function dispatch(
	params: Record<string, unknown>,
	ctx: Record<string, unknown> = activeCtx,
): Promise<Awaited<ReturnType<ToolEntry["execute"]>>> {
	vi.useFakeTimers();
	try {
		return await tool.execute("call-443", params, undefined, undefined, ctx);
	} finally {
		vi.clearAllTimers();
		vi.useRealTimers();
	}
}

/** Every foreground child this file's dispatches started. */
function foregroundLaunches(): Array<{ level: unknown }> {
	return h.runSubagent.mock.calls.map((call) => ({ level: call[3] }));
}

/** Notices the handler emitted (pi.sendMessage channel). */
function notices(): Array<{ customType?: string; content?: string; details?: Record<string, unknown> }> {
	return (sendMessageSpy.mock.calls as Array<[Record<string, unknown>, unknown]>).map((call) => call[0]);
}

function completionNotices(): Array<{ content?: string }> {
	return notices().filter(
		(m) => m.customType === "subagent-completion" || m.customType === "subagent-notification",
	);
}

/**
 * The text of a rejection result. `ToolResult` content is a text|image union
 * and every rejection this suite reads is text, so the cast is the assertion.
 */
function textOf(result: { content: unknown }): string {
	return (result.content as Array<{ text: string }>)[0].text;
}

/** Parse the shared log sink for the current test. */
function logEntries(): Array<{ message: string; data?: Record<string, unknown> }> {
	const file = path.join(env.testCwd, ".pi", "subagent-logs", "brl-subagent.log");
	if (!fs.existsSync(file)) return [];
	return fs.readFileSync(file, "utf-8").split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

async function flush(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

beforeAll(() => {
	env.setUp();
	sendMessageSpy = vi.fn();
	notifySpy = vi.fn();
	tool = setupExtension();
});

beforeEach(async () => {
	sessionEntries = [];
	agentsById.clear();
	spawnSeq = 0;
	h.customPresets = [];
	sendMessageSpy.mockClear();
	notifySpy.mockClear();
	__resetTerminalClaims();
	fs.rmSync(path.join(env.testCwd, ".pi", "subagent-logs", "brl-subagent.log"), { force: true });

	h.runSubagent.mockReset();
	h.runSubagent.mockImplementation(
		async (_cwd: string, _prompt: string, model: { provider: string; id: string }) =>
			makeResult(`${model.provider}/${model.id}`),
	);
	h.getPiInvocation.mockReset();
	h.getPiInvocation.mockReturnValue({ command: process.execPath, args: [] });
	h.spawnBackgroundSession.mockReset();
	h.spawnBackgroundSession.mockImplementation(async (_pi: unknown, _ctx: unknown, p: Record<string, unknown>) =>
		makeFakeAgent(p),
	);
	h.getAgent.mockReset();
	h.getAgent.mockImplementation((id: string) => agentsById.get(id) ?? null);

	// Reset the cap explicitly: the config persists for the file's single
	// extension instance, so an unseeded test would inherit the previous one.
	await seedConfig({ maxThinkingLevel: "off" });
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

afterAll(async () => {
	await env.tearDown();
});

// ---------------------------------------------------------------------------
// §1 The guard itself — pure, no schema, no dispatch
// ---------------------------------------------------------------------------

describe("the declared-level guard (pure)", () => {
	it("accepts every valid level, the preserved empty string, and an omitted declaration", () => {
		for (const level of THINKING_LEVELS) {
			expect(invalidThinkingLevelRejection(level), level).toBeUndefined();
			expect(isThinkingLevel(level), level).toBe(true);
		}
		for (const absent of [undefined, null, ""]) {
			expect(invalidThinkingLevelRejection(absent), JSON.stringify(absent)).toBeUndefined();
		}
	});

	it("rejects every case- and whitespace-variant, naming the supported set", () => {
		for (const raw of ["bogus", "MAX", "High", " high", "high ", "  ", "max"]) {
			const result = invalidThinkingLevelRejection(raw);
			expect(result, raw).toBeDefined();
			const text = textOf(result!);
			expect(text).toContain(`Invalid thinkingLevel ${JSON.stringify(raw)}`);
			expect(text).toContain(THINKING_LEVELS.join(", "));
			expect(text).toContain('Omit thinkingLevel, or pass ""');
		}
	});

	it("never crashes on a non-string value a programmatic caller could pass", () => {
		for (const raw of [5, true, {}, ["high"], 10n]) {
			const result = invalidThinkingLevelRejection(raw);
			expect(result, String(raw)).toBeDefined();
			expect(textOf(result!)).toContain("Invalid thinkingLevel");
		}
	});

	it("prefixes a per-unit rejection with the unit, like the other unit rejections", () => {
		const text = textOf(invalidThinkingLevelRejection("bogus", 'Task 2 ("two")')!);
		expect(text.startsWith('Task 2 ("two"): Invalid thinkingLevel "bogus"')).toBe(true);
	});

	it("is NOT the resolver: resolveThinkingLevel still clamps valid input, and still erases an unknown one", () => {
		// The clamp contract is unchanged (and is why the resolver cannot be the guard).
		expect(resolveThinkingLevel("high", "off")).toBe("off");
		expect(resolveThinkingLevel("off", "xhigh")).toBe("off");
		expect(resolveThinkingLevel(undefined, "high")).toBe("high");
		expect(resolveThinkingLevel("" as ThinkingLevel, "high")).toBe("high");
		expect(resolveThinkingLevel("bogus" as ThinkingLevel, "high")).toBeUndefined();
	});
});

// ---------------------------------------------------------------------------
// §2 The top-level seam — a registered dispatch that launches nothing
// ---------------------------------------------------------------------------

describe("an unknown top-level thinkingLevel launches nothing (issue #443)", () => {
	it("rejects before the foreground spawn", async () => {
		const result = await dispatch({
			task: "read one file and answer inline",
			thinkingLevel: "bogus",
			background: false,
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('Invalid thinkingLevel "bogus"');
		expect(result.content[0].text).toContain(THINKING_LEVELS.join(", "));
		expect(foregroundLaunches()).toEqual([]);
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
	});

	it("rejects every case/whitespace variant and pi's own max", async () => {
		for (const raw of ["MAX", "High", " high", "max"]) {
			h.runSubagent.mockClear();
			const result = await dispatch({
				task: "read one file and answer inline",
				thinkingLevel: raw,
				background: false,
			});
			expect(result.isError, raw).toBe(true);
			expect(result.content[0].text, raw).toContain(`Invalid thinkingLevel ${JSON.stringify(raw)}`);
			expect(foregroundLaunches(), raw).toEqual([]);
		}
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
	});

	it("rejects before the background spawn as well", async () => {
		const result = await dispatch({
			task: "read one file and answer inline",
			thinkingLevel: "bogus",
			background: true,
		});

		expect(result.isError).toBe(true);
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
		expect(foregroundLaunches()).toEqual([]);
	});

	it("covers the inline retryOnTimeout path by rejecting ahead of the first attempt", async () => {
		// The inline retry re-runs `runSubagent` with the SAME resolved level. If
		// the guard sat after the first attempt, that attempt (and then the retry)
		// would launch at pi's own default. Zero launches is the proof it does not.
		const result = await dispatch({
			task: "read one file and answer inline",
			thinkingLevel: "bogus",
			background: false,
			retryOnTimeout: true,
			timeout: 60_000,
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('Invalid thinkingLevel "bogus"');
		expect(foregroundLaunches()).toEqual([]);
	});

	it("is rejected BEFORE the mode-entry pre-task check (a missing dispatch line does not mask it)", async () => {
		// The guard must not live in `validatePreTask`: that seam returns early for
		// a mode-level task that is empty, runs per unit, and by the time it runs
		// the value it is handed has already been resolved (an unknown declaration
		// arrives as `undefined`). This pins the ORDER observably: in a project
		// that opts into process checks, a task with BOTH an unknown level and no
		// dispatch line reports the LEVEL, so the level gate is a pre-dispatch gate
		// and not a late validation rule.
		fs.writeFileSync(
			path.join(env.testCwd, "package.json"),
			JSON.stringify({ name: "fixture-project", "brl-subagent": { processChecks: true } }),
			"utf8",
		);
		try {
			const result = await dispatch({
				task: "read one file and answer inline",
				thinkingLevel: "bogus",
				background: false,
				timeout: 900_000,
			});

			expect(result.isError).toBe(true);
			expect(result.content[0].text).toContain('Invalid thinkingLevel "bogus"');
			expect(result.content[0].text).not.toContain("missing Jev dispatch line");
			expect(foregroundLaunches()).toEqual([]);
			expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
			expect(notices()).toEqual([]);
		} finally {
			fs.rmSync(path.join(env.testCwd, "package.json"), { force: true });
		}
	});
});

// ---------------------------------------------------------------------------
// §3 Preservation — every valid declaration keeps its meaning
// ---------------------------------------------------------------------------

describe("valid declarations keep their behaviour", () => {
	it("passes every valid level through, with the cap raised out of the way", async () => {
		await seedConfig({ maxThinkingLevel: "xhigh" });
		for (const level of THINKING_LEVELS) {
			h.runSubagent.mockClear();
			const result = await dispatch({
				task: "read one file and answer inline",
				thinkingLevel: level,
				background: false,
			});
			expect(result.isError, level).toBeFalsy();
			expect(foregroundLaunches(), level).toEqual([{ level }]);
		}
	});

	it("still clamps an above-cap level", async () => {
		await seedConfig({ maxThinkingLevel: "low" });
		await dispatch({ task: "read one file and answer inline", thinkingLevel: "high", background: false });
		expect(foregroundLaunches()).toEqual([{ level: "low" }]);
	});

	it("still treats an omitted level as the configured maximum", async () => {
		await seedConfig({ maxThinkingLevel: "medium" });
		await dispatch({ task: "read one file and answer inline", background: false });
		expect(foregroundLaunches()).toEqual([{ level: "medium" }]);
	});

	it('still treats a top-level "" as the configured maximum', async () => {
		await seedConfig({ maxThinkingLevel: "high" });
		const result = await dispatch({
			task: "read one file and answer inline",
			thinkingLevel: "",
			background: false,
		});
		expect(result.isError).toBeFalsy();
		expect(foregroundLaunches()).toEqual([{ level: "high" }]);
	});
});

// ---------------------------------------------------------------------------
// §4 Per-unit declarations — all four shapes, bad SECOND unit starts nothing
// ---------------------------------------------------------------------------

describe("an unknown per-unit thinkingLevel rejects the whole batch, nothing started", () => {
	it("tasks (parallel): the second task's declaration blocks the batch", async () => {
		const result = await dispatch({
			tasks: [
				{ task: "read one file and answer inline", thinkingLevel: "low" },
				{ task: "read another file", thinkingLevel: "bogus" },
			],
			background: false,
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('Task 2 ("read another file")');
		expect(result.content[0].text).toContain('Invalid thinkingLevel "bogus"');
		expect(foregroundLaunches()).toEqual([]);
	});

	it("chain: the second step's declaration blocks the chain", async () => {
		const result = await dispatch({
			chain: [
				{ task: "read one file and answer inline", thinkingLevel: "low" },
				{ task: "read the next file", thinkingLevel: "High" },
			],
			background: false,
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Step 2 (");
		expect(result.content[0].text).toContain('Invalid thinkingLevel "High"');
		expect(foregroundLaunches()).toEqual([]);
	});

	it("graph: the second node's declaration blocks the graph", async () => {
		const result = await dispatch({
			graph: [
				{ id: "n1", task: "read one file and answer inline", thinkingLevel: "low" },
				{ id: "n2", task: "read another file", thinkingLevel: "max" },
			],
			background: false,
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('Node "n2"');
		expect(result.content[0].text).toContain('Invalid thinkingLevel "max"');
		expect(foregroundLaunches()).toEqual([]);
	});

	it("background fan-out: the second task's declaration starts no agent at all", async () => {
		const result = await dispatch({
			tasks: [
				{ task: "read one file and answer inline", thinkingLevel: "low" },
				{ task: "read another file", thinkingLevel: "bogus" },
			],
			background: true,
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('Invalid thinkingLevel "bogus"');
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
		expect(foregroundLaunches()).toEqual([]);
	});

	it('a per-unit "" still inherits the GLOBAL level, not the cap', async () => {
		// cap xhigh vs global low: the two differ on purpose, so "inherits the
		// global level" and "falls back to the cap" cannot both pass.
		await seedConfig({ maxThinkingLevel: "xhigh" });
		await dispatch({
			tasks: [{ task: "read one file and answer inline", thinkingLevel: "" }],
			thinkingLevel: "low",
			background: false,
		});
		expect(foregroundLaunches()).toEqual([{ level: "low" }]);
	});

	it("a valid per-unit level still overrides the global one", async () => {
		await seedConfig({ maxThinkingLevel: "xhigh" });
		await dispatch({
			tasks: [{ task: "read one file and answer inline", thinkingLevel: "high" }],
			thinkingLevel: "low",
			background: false,
		});
		expect(foregroundLaunches()).toEqual([{ level: "high" }]);
	});
});

// ---------------------------------------------------------------------------
// §5 The selected preset object — no schema, no preset-file validator
// ---------------------------------------------------------------------------

describe("an unknown level on the SELECTED preset object is rejected", () => {
	it("named preset (injected in memory, so no file-tier validation ran)", async () => {
		await injectPresets([{ name: "house-injected", thinkingLevel: "bogus", description: "injected" }]);

		const result = await dispatch({
			task: "read one file and answer inline",
			preset: "house-injected",
			background: false,
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('Invalid thinkingLevel "bogus"');
		expect(foregroundLaunches()).toEqual([]);
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
	});

	it("auto-routed preset (the routed level reaches resolution without any caller declaration)", async () => {
		// Overrides the builtin `code-reviewer` in the custom tier, which
		// `getPreset` prefers — the keyword router then selects it for "review".
		await injectPresets([{ name: "code-reviewer", thinkingLevel: "MAX", description: "injected" }]);

		const result = await dispatch({
			task: "review the code for correctness",
			background: false,
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('Invalid thinkingLevel "MAX"');
		expect(foregroundLaunches()).toEqual([]);
	});

	it("a valid per-call level wins over the preset's, so it is the effective declaration", async () => {
		// The guard judges the value that REACHES resolution (`params.thinkingLevel
		// ?? preset.thinkingLevel`) — a preset level that the call overrides never
		// does. The cap is raised so the launch shows the DECLARED level, not a clamp.
		await seedConfig({ maxThinkingLevel: "xhigh" });
		await injectPresets([{ name: "house-injected", thinkingLevel: "bogus", description: "injected" }]);

		const result = await dispatch({
			task: "read one file and answer inline",
			preset: "house-injected",
			thinkingLevel: "low",
			background: false,
		});

		expect(result.isError).toBeFalsy();
		expect(foregroundLaunches()).toEqual([{ level: "low" }]);
	});
});

// ---------------------------------------------------------------------------
// §6 Restored values — the manual retryRunId path
// ---------------------------------------------------------------------------

describe("a RESTORED unknown level is rejected (retryRunId)", () => {
	it("restores the recorded bogus level, then rejects it before any launch", async () => {
		persistRunEntry(
			aFailedRun({
				originalParams: {
					background: false,
					task: "read one file and answer inline",
					thinkingLevel: "bogus",
					model: `${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`,
				},
			}),
		);

		// No thinkingLevel on THIS call: the value arrives only via the restore,
		// which is exactly the route the schema cannot see.
		const result = await dispatch({ retryRunId: "run-443-source" });

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain('Invalid thinkingLevel "bogus"');
		expect(foregroundLaunches()).toEqual([]);
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
	});

	it("still launches with a valid restored level (the control the rejection above needs)", async () => {
		await seedConfig({ maxThinkingLevel: "xhigh" });
		persistRunEntry(
			aFailedRun({
				originalParams: {
					background: false,
					task: "read one file and answer inline",
					thinkingLevel: "high",
					model: `${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`,
				},
			}),
		);

		const result = await dispatch({ retryRunId: "run-443-source" });

		expect(result.isError).toBeFalsy();
		expect(foregroundLaunches()).toEqual([{ level: "high" }]);
	});
});

// ---------------------------------------------------------------------------
// §7 The transport auto-retry path — re-enters the spawn seam, never `execute`
// ---------------------------------------------------------------------------

describe("a RESTORED unknown level blocks the transport auto-retry", () => {
	async function settle(id: string): Promise<void> {
		eventBus.emit(eventBus.createEvent("subagent:failed", id, { error: "Connection error." }));
		await flush();
	}

	function registerSettledAgent(id: string): void {
		const agent: Record<string, unknown> = {
			...makeFakeAgent({ description: "prior-run", task: "read one file and answer inline" }),
			id,
		};
		agent.status = "failed";
		agent.error = "Connection error.";
		agent.completedAt = 1700000000000;
		agentsById.set(id, agent);
	}

	it("starts no SDK session and surfaces the ORIGINAL failure instead", async () => {
		vi.useFakeTimers();
		try {
			const SOURCE_ID = "bg-443-transport-bogus";
			registerSettledAgent(SOURCE_ID);
			persistRunEntry(
				aFailedRun({
					id: SOURCE_ID,
					originalParams: {
						background: true,
						task: "read one file and answer inline",
						thinkingLevel: "bogus",
						model: `${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`,
					},
				}),
			);

			await settle(SOURCE_ID);

			// No SDK session was started for the retry.
			expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
			// …and the user still gets the ORIGINAL failure notice (never a silent drop).
			const completions = completionNotices();
			expect(completions).toHaveLength(1);
			expect(String(completions[0].content)).toContain("— failed");
			// No "auto-retrying" toast: nothing was retried.
			expect(notifySpy.mock.calls.map((c) => String(c[0]))).not.toContain(TRANSPORT_RETRY_TOAST);
			// The rejection is recorded, so the reason the retry did not happen is diagnosable.
			const rejected = logEntries().filter((e) =>
				e.message.startsWith("Transport auto-retry spawn rejected"),
			);
			expect(rejected).toHaveLength(1);
			expect(String(rejected[0].data?.error)).toContain('Invalid thinkingLevel "bogus"');
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});

	it("the control: a valid restored level DOES retry (one SDK session)", async () => {
		vi.useFakeTimers();
		try {
			const SOURCE_ID = "bg-443-transport-valid";
			registerSettledAgent(SOURCE_ID);
			persistRunEntry(
				aFailedRun({
					id: SOURCE_ID,
					originalParams: {
						background: true,
						task: "read one file and answer inline",
						thinkingLevel: "high",
						model: `${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`,
					},
				}),
			);

			await settle(SOURCE_ID);

			expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
			expect((h.spawnBackgroundSession.mock.calls[0][2] as Record<string, unknown>).thinkingLevel).toBe(
				"off", // this harness's cap default is "off"; the declaration was accepted, then clamped
			);
			expect(notifySpy.mock.calls.map((c) => String(c[0]))).toContain(TRANSPORT_RETRY_TOAST);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});
});

// ---------------------------------------------------------------------------
// §8 The schema boundary — a first line of defence, and `""` preserved
// ---------------------------------------------------------------------------

describe("the registered schema (pi's own tool-argument validation)", () => {
	async function validate(args: Record<string, unknown>): Promise<Record<string, unknown>> {
		const { validateToolArguments } = await import("@earendil-works/pi-ai");
		return validateToolArguments(
			{ name: "delegate_task", parameters: delegateTaskParamsSchema } as never,
			{ name: "delegate_task", arguments: args } as never,
		) as never;
	}

	async function rejection(args: Record<string, unknown>): Promise<string> {
		await expect(validate(args)).rejects.toThrow();
		try {
			await validate(args);
		} catch (err) {
			return (err as Error).message;
		}
		return "";
	}

	it("accepts every valid level and the empty string", async () => {
		for (const level of [...THINKING_LEVELS, ""]) {
			const out = await validate({ task: "do a thing", thinkingLevel: level });
			expect(out.thinkingLevel, level).toBe(level);
		}
	});

	it("rejects an unknown level naming the WHOLE supported set", async () => {
		for (const raw of ["bogus", "max", "High", " high"]) {
			const message = await rejection({ task: "do a thing", thinkingLevel: raw });
			// Exact bytes of pi-schema's enum error (measured on pi 1.5.0): the
			// whole set, empty string included, so the caller is not guessing.
			expect(message, raw).toContain(
				`thinkingLevel: expected one of ${JSON.stringify([...THINKING_LEVELS, ""])}`,
			);
		}
	});

	it("covers the per-unit declarations too (tasks[], chain[], graph[])", async () => {
		const message = await rejection({
			tasks: [{ task: "do a thing", thinkingLevel: "bogus" }],
		});
		expect(message).toContain(`thinkingLevel: expected one of ${JSON.stringify([...THINKING_LEVELS, ""])}`);
		// The empty string stays legal per unit (it means "inherit the global level").
		const ok = await validate({ tasks: [{ task: "do a thing", thinkingLevel: "" }] });
		expect((ok.tasks as Array<Record<string, unknown>>)[0].thinkingLevel).toBe("");
	});

	it("keeps the six documented brl levels in step with README", () => {
		// The compat note: README documents these six, and pi's `max` is the only
		// level a caller could reasonably expect that is NOT supported.
		const readme = fs.readFileSync(path.join(process.cwd(), "README.md"), "utf8");
		const row = /^\|\s*`thinkingLevel`\s*\|[^|]*\|[^|]*\|([^|]*)\|/m.exec(readme);
		expect(row, "README must document thinkingLevel in the params table").not.toBeNull();
		// The slash-separated list IS the documented set; other backticked tokens
		// in the same cell (the empty string, `max`) are prose about it.
		const list = /`[a-z]+`(?: \/ `[a-z]+`)+/.exec(row![1]);
		expect(list, "README must list the accepted levels").not.toBeNull();
		const documented = [...list![0].matchAll(/`([a-z]+)`/g)].map((m) => m[1]);
		expect(documented).toEqual([...THINKING_LEVELS]);
		expect(documented).not.toContain("max");
		// …and the compatibility note this change creates is stated, not implied.
		expect(row![1]).toContain("`max`");
	});

	it("the schema is a declaration, not the guard: the enum does not narrow the static type", () => {
		// `resolveSubagentParams` and the retry bag still carry `string`, which is
		// why the runtime guard (§2, §4, §6, §7) is the one that must exist.
		const field = (delegateTaskParamsSchema.properties as Record<string, { enum?: string[] }>)
			.thinkingLevel;
		expect(field.enum).toEqual([...THINKING_LEVELS, ""]);
	});
});

// ---------------------------------------------------------------------------
// §9 argv — the pre-fix escape hatch, pinned as the reason the guard exists
// ---------------------------------------------------------------------------

describe("the argument boundary the guard keeps from seeing an unknown value", () => {
	it("buildSubagentArgs still renders whatever it is given — which is why the value must be valid", async () => {
		const { buildSubagentArgs } = await vi.importActual<typeof import("../runner")>("../runner");
		// Not a behaviour we want; the pre-fix measurement, kept as the reason the
		// guard sits BEFORE resolution. The resolver erases "bogus" to undefined,
		// and this is what that undefined becomes: pi warns and uses its default.
		const erased = resolveThinkingLevel("bogus" as ThinkingLevel, "off");
		expect(erased).toBeUndefined();
		const argv = buildSubagentArgs(GLOBAL_MODEL, erased as ThinkingLevel);
		expect(argv[argv.indexOf("--thinking") + 1]).toBeUndefined();
	});
});

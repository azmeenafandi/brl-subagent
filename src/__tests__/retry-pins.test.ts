/**
 * Retry pins (issue #229) — the three gaps the #227 review could not see.
 *
 *   Item 1 — the fan-out spawn site in src/index.ts (runBackgroundFanOut)
 *     deliberately OMITS the four execution-shape keys (background, gitMode,
 *     approvalMode, force) from its snapshotOriginalParams literal. That
 *     omission is the whole reason a fan-out unit retries as a single
 *     FOREGROUND run — and the review's mutation (adding `background: true`
 *     there) left all 1167 tests green. src/unit-run.ts's twin site is pinned
 *     by unit-run.test.ts; this file pins the index.ts one. Test 1 asserts
 *     the omission on the object the REAL site actually handed to the spawn,
 *     then retries that exact captured record.
 *
 *   Item 2 — the retried-background path end-to-end. No committed test
 *     observed a retry whose recorded `background: true` reaches the
 *     background branch in execute() and returns an agent id. Reverting the
 *     carry in resolveRetryParams fails only ONE unit test; this is the e2e
 *     pin.
 *
 *   Item 3 — snapshot↔resolve drift guard. snapshotOriginalParams
 *     (src/params.ts) and resolveRetryParams' return literal (src/history.ts)
 *     are two hand-maintained key sets that must stay in sync. Both are
 *     optional/additive, so the compiler cannot catch a one-sided addition
 *     and no test linked the two — which is exactly how issue #227's four
 *     execution-shape keys went missing in the first place.
 *
 * Coverage boundaries (what these pins do NOT prove):
 *   - The spawn is STUBBED in Tests 1-2. They prove the retry reaches the
 *     right branch and returns the spawn result; they do NOT prove the live
 *     completion wake or the real agent lifecycle (other suites cover that).
 *     No wake is asserted here, by design.
 *   - 3a catches RESOLVE dropping any key: directional for the 16 keys
 *     snapshot records, plus an absolute 19-key ratchet on the resolve side.
 *     3b catches SNAPSHOT dropping a key and any restore wired to the wrong
 *     orig?.<name> field.
 *   - NOT covered here: the snapshot function's input TYPE vs its literal
 *     (a compile surface), and the call sites beyond the two pinned above —
 *     src/unit-run.ts's createUnitRun is pinned by unit-run.test.ts, and the
 *     single-foreground site is not pinned (see the single-background site in
 *     Test 2 for the same snapshot helper).
 *
 * Harness cloned from dispatch-capability-guards.test.ts (hoisted ../runner
 * mock; partial ../session-manager mock stubbing ONLY spawnBackgroundSession;
 * tui module mocks; temp-dir output/storage redirect; setLogCwd cleanup;
 * executeWithSpawn fake-timer wrapper), plus per-step-model.test.ts's
 * seed-a-run-entry retry pattern.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

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
}));

vi.mock("../runner", () => ({
	runSubagent: h.runSubagent,
	cleanupTempDirs: h.cleanupTempDirs,
	getPiInvocation: h.getPiInvocation,
	accumulateUsage: h.accumulateUsage,
	parseSubagentLine: h.parseSubagentLine,
}));

// Partial session-manager mock: stub ONLY the spawn; state/session helpers
// and the __setStorageDir redirect stay real.
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
import { snapshotOriginalParams } from "../params";
import { resolveRetryParams } from "../history";
import { __setOutputDir } from "../transcript";
import { __setStorageDir } from "../session-manager";
import { setLogCwd } from "../logging";
import { CUSTOM_ENTRY_TYPES } from "../types";
import type { SubagentResult, SubagentRun } from "../types";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_MODEL = { provider: "test", id: "test/model" };

interface SpawnParams {
	task?: string;
	description?: string;
	originalParams?: Record<string, unknown>;
}

let spawnSeq = 0;

function makeFakeAgent(p: SpawnParams): Record<string, unknown> {
	spawnSeq += 1;
	return {
		id: `bg-retry-${spawnSeq}`,
		sessionId: `sess-bg-retry-${spawnSeq}`,
		description: p.description ?? "",
		status: "running",
		startedAt: 1700000000000 + spawnSeq,
		task: p.task ?? "",
		model: `${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`,
		thinkingLevel: "medium",
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

let tool: ToolEntry;
let sessionStartHandler:
	| ((_event: unknown, ctx: Record<string, unknown>) => Promise<void>)
	| undefined;
let testCwd: string;
let tempPiBase = "";

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
		sendMessage: () => {},
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
		cwd: testCwd,
		model: GLOBAL_MODEL,
		modelRegistry: makeRegistry([`${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`]),
		getSystemPrompt: () => "You are a helpful assistant.",
		ui: {
			notify: () => {},
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

/** Run a dispatch that may SPAWN a background agent under fake timers: a
 * successful spawn arms a 2s poller + hard-cap timer — clear both after. */
async function executeWithSpawn(
	params: Record<string, unknown>,
	ctx: Ctx = makeCtx(),
): Promise<Awaited<ReturnType<ToolEntry["execute"]>>> {
	vi.useFakeTimers();
	try {
		return await tool.execute("call-229", params, undefined, undefined, ctx);
	} finally {
		vi.clearAllTimers();
		vi.useRealTimers();
	}
}

/** Point ctx's sessionManager at one run entry so findSpawnRunById resolves it. */
function seedRunEntry(ctx: Ctx, run: SubagentRun): void {
	const entries = [{ type: "custom", customType: CUSTOM_ENTRY_TYPES.run, data: run }];
	(ctx.sessionManager as { getEntries: () => unknown[] }).getEntries = () => entries;
}

/** The originalParams the REAL spawn site recorded, as handed to the stub. */
function capturedOriginalParams(): Record<string, unknown> {
	const spawnArg = h.spawnBackgroundSession.mock.calls[0]?.[2] as SpawnParams | undefined;
	const recorded = spawnArg?.originalParams;
	if (!recorded) throw new Error("no spawn call captured an originalParams snapshot");
	return recorded;
}

function makeRun(id: string, task: string, originalParams?: Record<string, unknown>): SubagentRun {
	return {
		id,
		task,
		status: "failed",
		model: `${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`,
		thinkingLevel: "medium",
		startedAt: new Date().toISOString(),
		...(originalParams ? { originalParams } : {}),
	};
}

beforeEach(() => {
	if (tempPiBase) fs.rmSync(tempPiBase, { recursive: true, force: true });
	if (testCwd) fs.rmSync(testCwd, { recursive: true, force: true });
	tempPiBase = fs.mkdtempSync(path.join(os.tmpdir(), "brl-retry-pins-pi-"));
	__setOutputDir(path.join(tempPiBase, "output"));
	__setStorageDir(path.join(tempPiBase, "subagents"));
	testCwd = fs.mkdtempSync(path.join(os.tmpdir(), "brl-retry-pins-"));
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
	setLogCwd(undefined);
	await new Promise((resolve) => setImmediate(resolve));
	if (tempPiBase) fs.rmSync(tempPiBase, { recursive: true, force: true });
	if (testCwd) fs.rmSync(testCwd, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Test 1 (item 1) — a fan-out ORIGIN retries FOREGROUND
// ---------------------------------------------------------------------------

describe("background fan-out origin retries foreground (issue #229 item 1)", () => {
	it("omits all four execution-shape keys from the fan-out unit snapshot", async () => {
		// Phase A: drive the REAL site — one-unit background fan-out.
		const result = await executeWithSpawn({
			background: true,
			tasks: [{ task: "Fan out unit one" }],
		});
		expect(result.isError).toBeFalsy();
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);

		const recorded = capturedOriginalParams();

		// The deliberate omission, on the object the real site produced. All
		// four, not just background: the review mutation added exactly one of
		// these and every test stayed green.
		expect(recorded.background).toBeUndefined();
		expect(recorded.gitMode).toBeUndefined();
		expect(recorded.approvalMode).toBeUndefined();
		expect(recorded.force).toBeUndefined();
	});

	it("retries the captured fan-out unit as a single FOREGROUND run (no background spawn)", async () => {
		// Phase A: capture what the real fan-out site recorded.
		await executeWithSpawn({
			background: true,
			tasks: [{ task: "Fan out unit one" }],
		});
		const recorded = capturedOriginalParams();
		expect(recorded.background).toBeUndefined();

		// Phase B: clear counts (keep implementations), seed THAT record, retry.
		h.runSubagent.mockClear();
		h.spawnBackgroundSession.mockClear();
		const ctx = makeCtx();
		seedRunEntry(ctx, makeRun("retry-fanout-1", "Fan out unit one", recorded));

		const result = await executeWithSpawn({ retryRunId: "retry-fanout-1" }, ctx);

		expect(result.isError).toBeFalsy();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(0);
	});
});

// ---------------------------------------------------------------------------
// Test 2 (item 2) — a retried BACKGROUND origin is background, end-to-end
//
// Coverage boundary: the spawn is stubbed, so this proves the retry reaches
// the background branch and returns the spawn result. It does NOT prove the
// live completion wake or the agent lifecycle (other suites cover those), and
// deliberately asserts no wake.
// ---------------------------------------------------------------------------

describe("a retried background run is background, end-to-end (issue #229 item 2)", () => {
	it("the single-background spawn site records background: true", async () => {
		const result = await executeWithSpawn({ task: "Background single run", background: true });
		expect(result.isError).toBeFalsy();
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
		expect(capturedOriginalParams().background).toBe(true);
	});

	it("retrying that record spawns a background agent again and returns its id", async () => {
		await executeWithSpawn({ task: "Background single run", background: true });
		const recorded = capturedOriginalParams();
		expect(recorded.background).toBe(true);

		h.runSubagent.mockClear();
		h.spawnBackgroundSession.mockClear();
		const ctx = makeCtx();
		seedRunEntry(ctx, makeRun("retry-bg-1", "Background single run", recorded));

		const result = await executeWithSpawn({ retryRunId: "retry-bg-1" }, ctx);

		expect(result.isError).toBeFalsy();
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
		expect(h.runSubagent).toHaveBeenCalledTimes(0);
		expect(result.content[0].text).toContain("Background agent started");
	});
});

// ---------------------------------------------------------------------------
// Test 3 (item 3) — snapshot ↔ resolve drift guard
//
// The invariant is DIRECTIONAL: resolve ⊇ snapshot (every snapshot-recorded
// key is restorable). It is not "equal" — resolve additionally restores
// `task`, `label` and `retryOnTimeout` from the run record / this call, which
// snapshot never records (retryOnTimeout is explicit-only by design: it arms a
// deadline for THIS call, so it is never inherited).
//
// 3a catches RESOLVE dropping a key (directional for the 16, ratchet for all
// 19). 3b catches SNAPSHOT dropping a key and any restore wired to the wrong
// orig?.<name> field. NOT covered: the snapshot function's input-TYPE vs
// literal pair (a compile surface), and the call sites — Tests 1-2 pin the
// background-fan-out and single-background sites, unit-run.test.ts the unit
// site.
// ---------------------------------------------------------------------------

/** All 16 snapshot fields, each with a DISTINCT value (booleans included, so a
 *  swap of two boolean restores is visible). */
const SEED: Parameters<typeof snapshotOriginalParams>[0] = {
	systemPrompt: "sentinel-system-prompt",
	inheritSystemPrompt: false,
	model: "sentinel/model-1",
	thinkingLevel: "high",
	priority: "p1",
	outputFile: "sentinel-output.md",
	timeout: 4242,
	cwd: "/sentinel/cwd",
	tools: ["sentinel-tool-a"],
	excludeTools: ["sentinel-tool-b"],
	noBuiltinTools: true,
	preset: "sentinel-preset",
	background: true,
	gitMode: "branch",
	approvalMode: "always",
	force: true,
};

/** The 19 keys resolveRetryParams' return literal declares. ABSOLUTE ratchet:
 *  update it deliberately when the param surface changes (same spirit as the
 *  KNOWN_DELEGATE_KEYS ratchet in per-step-model.test.ts). */
const RESOLVE_KEYS = [
	"task", "label", "model", "preset", "systemPrompt", "inheritSystemPrompt",
	"thinkingLevel", "priority", "outputFile", "timeout", "cwd", "tools",
	"excludeTools", "noBuiltinTools", "retryOnTimeout", "background", "gitMode",
	"approvalMode", "force",
];

function snapshotSeed() {
	return snapshotOriginalParams(SEED);
}

function resolveSeed() {
	return resolveRetryParams({}, makeRun("drift-1", "sentinel task", snapshotSeed()));
}

describe("snapshot ↔ resolve key-set drift guard (issue #229 item 3)", () => {
	it("3a: resolve ⊇ snapshot, and the resolve key-set matches the pinned 19", () => {
		const snapshotKeys = Object.keys(snapshotSeed()).sort();
		const resolveKeys = Object.keys(resolveSeed()).sort();

		// Directional: every snapshot-recorded key is restorable.
		expect(resolveKeys).toEqual(expect.arrayContaining(snapshotKeys));
		// Absolute ratchet on the resolve side (all 19 literal entries are
		// present even when their value is undefined — key-set, not value-set).
		expect(resolveKeys).toEqual([...RESOLVE_KEYS].sort());
	});

	it("3b: every snapshotted value round-trips through resolve unchanged", () => {
		const resolved = resolveSeed();
		for (const [key, value] of Object.entries(SEED)) {
			expect({ [key]: resolved[key as keyof typeof resolved] }).toEqual({ [key]: value });
		}
	});
});

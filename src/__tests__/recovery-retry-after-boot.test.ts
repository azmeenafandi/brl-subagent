/**
 * Option B U3 Fix A — the boot notice's id resolves through `retryRunId`.
 *
 * The C1 review's critical 3: after a genuine crash + fresh boot the boot mark
 * writes the durable registry + agent record only, and the fresh-session notice
 * then names an id that the session-sourced `retryRunId` lookup rejects as not
 * found. This suite drives the REAL extension end-to-end:
 *
 *   1. `session_start` runs the boot scan + the notice over a durable registry
 *      the session has NEVER seen (no run entries in `getEntries()`);
 *   2. the captured `subagent-recovery` notice names the id;
 *   3. `delegate_task({ retryRunId: <that id> })` resolves through the Fix A
 *      visibility bridge and re-dispatches with the recovered task — instead of
 *      returning the "Retry run ID not found" error.
 *
 * Harness cloned from retry-pins.test.ts: hoisted `../runner` mock, a PARTIAL
 * `../session-manager` mock that stubs ONLY the background spawn (so `getAgent`
 * stays real and reads the redirected agent store), tui module mocks, and the
 * shared temp-lifecycle redirects. ONE extension instance per file.
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

const h = vi.hoisted(() => ({
	runSubagent: vi.fn(),
	cleanupTempDirs: vi.fn().mockResolvedValue(0),
	reapActiveChildren: vi.fn().mockResolvedValue(undefined),
	getPiInvocation: vi.fn(),
	accumulateUsage: vi.fn(),
	parseSubagentLine: vi.fn(),
	spawnBackgroundSession: vi.fn(),
}));

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
import { registerInflightRun, listInflightRuns, markInterrupted } from "../run-registry";
import type { SubagentResult, SubagentRun } from "../types";
import { createTempEnv } from "./fixtures/temp-lifecycle";
import * as fs from "node:fs";
import * as path from "node:path";

const env = createTempEnv("brl-u3-retry-boot");
const ID = "11111111-2222-3333-4444-555555555555";
const TASK = "recover the crashed migration";

interface ToolEntry {
	name: string;
	execute: (
		callId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ content: Array<{ type: string; text: string }>; isError?: boolean }>;
}

let tool: ToolEntry;
let sessionStartHandler:
	| ((_event: unknown, ctx: Record<string, unknown>) => Promise<void>)
	| undefined;
let sessionShutdownHandler: (() => Promise<void>) | undefined;
let sent: Array<{ message: Record<string, unknown>; options?: Record<string, unknown> }> = [];
let spawnSeq = 0;

function setupExtension(): void {
	const tools = new Map<string, ToolEntry>();
	const mockPi = {
		registerTool: (t: ToolEntry) => tools.set(t.name, t),
		registerCommand: () => {},
		registerShortcut: () => {},
		on: (
			event: string,
			handler: ((...a: unknown[]) => Promise<void>),
		) => {
			if (event === "session_start") sessionStartHandler = handler as never;
			if (event === "session_shutdown") sessionShutdownHandler = handler as never;
		},
		appendEntry: () => {},
		sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => {
			sent.push({ message, options });
		},
		ctx: { getState: () => undefined, setState: () => {} },
	};
	initExtension(mockPi as never);
	const entry = tools.get("delegate_task");
	if (!entry) throw new Error("delegate_task tool not registered");
	tool = entry;
}

function makeCtx(): Record<string, unknown> {
	return {
		cwd: env.testCwd,
		model: { provider: "test", id: "test-model" },
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === "test" && id === "test-model" ? { provider, id } : undefined,
			hasConfiguredAuth: () => true,
		},
		getSystemPrompt: () => "You are a helpful assistant.",
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: { getEntries: () => [] as unknown[], appendCustomEntry: () => {} },
		hasUI: false,
	};
}

function seedDurableInterruptedRun(): void {
	registerInflightRun({
		id: ID,
		kind: "background",
		startedAt: "2026-01-01T00:00:00.000Z",
		cwd: env.testCwd,
		recoveryPosture: "offer",
	});
	markInterrupted(ID, "2026-01-01T00:05:00.000Z");
	fs.mkdirSync(env.storageDir, { recursive: true });
	fs.writeFileSync(
		path.join(env.storageDir, `${ID}.json`),
		JSON.stringify({
			id: ID,
			sessionId: ID,
			type: "general-purpose",
			description: "Recoverable",
			status: "running",
			startedAt: Date.now(),
			task: TASK,
			model: "provider/model",
			thinkingLevel: "medium",
		}),
	);
}

/**
 * A foreground/unit run's ONLY durable record after a crash + fresh boot: the
 * registry entry (no session run entry, no background agent record). The O3
 * enrichment fields are what make it recoverable.
 */
function seedDurableForegroundRun(): void {
	registerInflightRun({
		id: ID,
		kind: "foreground",
		startedAt: "2026-01-01T00:00:00.000Z",
		cwd: env.testCwd,
		recoveryPosture: "offer",
		task: TASK,
		label: "Recoverable FG",
		model: "test/test-model",
		thinkingLevel: "medium",
		originalParams: {
			gitMode: "none",
			approvalMode: "writes",
			force: true,
			timeout: 4242,
		},
	});
	markInterrupted(ID, "2026-01-01T00:05:00.000Z");
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

function sourceEntryPresent(): boolean {
	return listInflightRuns().some((e) => e.id === ID);
}

function noticeIds(): string[] {
	const notice = sent.find((s) => s.message.customType === "subagent-recovery");
	return ((notice?.message.details as { ids?: string[] } | undefined)?.ids) ?? [];
}

beforeAll(() => {
	setupExtension();
});

beforeEach(() => {
	env.setUp();
	sent = [];
	spawnSeq = 0;
	h.runSubagent.mockReset();
	h.runSubagent.mockImplementation(
		async (_cwd: string, _prompt: string, model: { provider: string; id: string }) =>
			makeResult(`${model.provider}/${model.id}`),
	);
	h.getPiInvocation.mockReset();
	h.getPiInvocation.mockReturnValue({ command: process.execPath, args: [] });
	h.spawnBackgroundSession.mockReset();
	h.spawnBackgroundSession.mockImplementation(
		async (_pi: unknown, _ctx: unknown, p: { task?: string; description?: string }) => {
			spawnSeq += 1;
			return {
				id: `bg-recovered-${spawnSeq}`,
				sessionId: `sess-recovered-${spawnSeq}`,
				description: p.description ?? "",
				status: "running",
				startedAt: Date.now(),
				task: p.task ?? "",
				model: "test/test-model",
				thinkingLevel: "medium",
			};
		},
	);
});

afterEach(async () => {
	vi.clearAllTimers();
	vi.useRealTimers();
	if (sessionShutdownHandler) await sessionShutdownHandler();
	await env.tearDown();
});

afterAll(() => {
	expect(typeof sessionStartHandler).toBe("function");
});

describe("U3 Fix A — boot notice id → retryRunId (fresh session, durable-only run)", () => {
	it("the notice names the durable-only id and delegate_task resolves it", async () => {
		seedDurableInterruptedRun();

		// 1. Fresh boot: session has NO run entries; the notice comes from disk.
		await sessionStartHandler!({}, makeCtx());
		const ids = noticeIds();
		expect(ids).toEqual([ID]);

		// 2. The notice's id resolves through retryRunId (NOT "not found").
		vi.useFakeTimers();
		let result: Awaited<ReturnType<ToolEntry["execute"]>>;
		try {
			result = await tool.execute("call-fix-a", { retryRunId: ids[0] }, undefined, undefined, makeCtx());
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}

		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).not.toContain("Retry run ID not found");
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
		const spawnArg = h.spawnBackgroundSession.mock.calls[0][2] as { task?: string };
		expect(spawnArg.task).toBe(TASK);
		expect(result.content[0].text).toContain("Background agent started");

		// Retire-on-retry: the source entry is cleared, so the next boot has
		// nothing to re-offer.
		expect(sourceEntryPresent()).toBe(false);
		sent = [];
		await sessionStartHandler!({}, makeCtx());
		expect(noticeIds()).toEqual([]);
	});

	it("a durable-only FOREGROUND run re-dispatches with the recorded task + dispatch shape", async () => {
		seedDurableForegroundRun();

		// Fresh boot: no session run entries, no agent record — the registry
		// entry is the ONLY durable record.
		await sessionStartHandler!({}, makeCtx());
		expect(noticeIds()).toEqual([ID]);
		const notice = sent.find((s) => s.message.customType === "subagent-recovery");
		expect(String(notice?.message.content)).toContain(TASK);
		expect(String(notice?.message.content)).not.toContain("(task unavailable) \u00b7");
		expect(sourceEntryPresent()).toBe(true);

		// The retry resolves through the bridge and re-dispatches FOREGROUND with
		// the recorded task and the recorded originalParams shape.
		const result = await tool.execute("call-fg", { retryRunId: ID }, undefined, undefined, makeCtx());
		expect(result.isError).toBeFalsy();
		expect(result.content[0].text).not.toContain("Retry run ID not found");
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(0);
		const call = h.runSubagent.mock.calls[0] as unknown[];
		expect(call[4]).toBe(TASK);
		expect(call[8]).toBe(4242); // timeout restored from the durable snapshot

		// Retire-on-retry: the superseded source entry is gone.
		expect(sourceEntryPresent()).toBe(false);
	});

	it("a failed retry start leaves the source entry intact and retryable", async () => {
		seedDurableInterruptedRun();
		h.spawnBackgroundSession.mockImplementationOnce(async () => {
			throw new Error("spawn boom");
		});
		await sessionStartHandler!({}, makeCtx());
		expect(noticeIds()).toEqual([ID]);

		vi.useFakeTimers();
		let result: Awaited<ReturnType<ToolEntry["execute"]>>;
		try {
			result = await tool.execute("call-fail", { retryRunId: ID }, undefined, undefined, makeCtx());
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Failed to spawn background agent");
		// The source is untouched — it can be retried again.
		expect(sourceEntryPresent()).toBe(true);
	});

	it("without the durable mark the same call is still rejected (control)", async () => {
		// No seed: the bridge finds nothing, so the historical behaviour holds.
		vi.useFakeTimers();
		let result: Awaited<ReturnType<ToolEntry["execute"]>>;
		try {
			result = await tool.execute("call-control", { retryRunId: ID }, undefined, undefined, makeCtx());
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("Retry run ID not found");
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(0);
	});
});

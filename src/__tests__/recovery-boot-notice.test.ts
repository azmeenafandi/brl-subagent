/**
 * Option B U3 — boot notice delivery (T2 integration).
 *
 * Drives the REAL extension (index.ts) `session_start` path with a seeded
 * durable registry, and pins the delivery discipline the pure tests can't:
 *
 *   1. one `subagent-recovery` message is sent when an interrupted run exists;
 *   2. it is delivered at a TURN BOUNDARY (`nextTurn`), never as a mid-turn
 *      `steer`;
 *   3. at most one per boot (a second session_start in the same boot is quiet);
 *   4. quiet when no interrupted run exists;
 *   5. quiet when the session posture is `off`;
 *   6. quiet when the run's dispatch snapshot is `off`.
 *
 * Harness modeled on terminal-notice-dedupe.test.ts: mocks the runner's heavy
 * deps, redirects the registry/agent stores into a per-test temp dir, and
 * captures `pi.sendMessage`. ONE extension instance per file (each
 * `initExtension` appends permanent event-bus listeners).
 */
import { describe, it, expect, vi, beforeAll, beforeEach, afterEach, afterAll } from "vitest";

const h = vi.hoisted(() => ({
	cleanupTempDirs: vi.fn().mockResolvedValue(0),
	reapActiveChildren: vi.fn().mockResolvedValue(undefined),
	runSubagent: vi.fn(),
	getPiInvocation: vi.fn(),
	accumulateUsage: vi.fn(),
	parseSubagentLine: vi.fn(),
}));

vi.mock("../runner", () => ({
	runSubagent: h.runSubagent,
	cleanupTempDirs: h.cleanupTempDirs,
	reapActiveChildren: h.reapActiveChildren,
	getPiInvocation: h.getPiInvocation,
	accumulateUsage: h.accumulateUsage,
	parseSubagentLine: h.parseSubagentLine,
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
import { registerInflightRun, markInterrupted } from "../run-registry";
import { CUSTOM_ENTRY_TYPES, type RecoveryMode } from "../types";
import { createTempEnv } from "./fixtures/temp-lifecycle";
import * as fs from "node:fs";
import * as path from "node:path";

const env = createTempEnv("brl-u3-notice");
const ID = "11111111-2222-3333-4444-555555555555";

interface Captured {
	message: Record<string, unknown>;
	options: Record<string, unknown> | undefined;
}

let captured: Captured[] = [];
let sessionStartHandler:
	| ((_event: unknown, ctx: Record<string, unknown>) => Promise<void>)
	| undefined;
let sessionShutdownHandler: (() => Promise<void>) | undefined;

function setupExtension(): void {
	const mockPi = {
		registerTool: () => {},
		registerCommand: () => {},
		registerShortcut: () => {},
		on: (
			event: string,
			handler: (_event: unknown, ctx: Record<string, unknown>) => Promise<void>,
		) => {
			if (event === "session_start") sessionStartHandler = handler;
			if (event === "session_shutdown") sessionShutdownHandler = handler as never;
		},
		appendEntry: () => {},
		sendMessage: (message: Record<string, unknown>, options?: Record<string, unknown>) => {
			captured.push({ message, options });
		},
		ctx: { getState: () => undefined, setState: () => {} },
	};
	initExtension(mockPi as never);
}

function makeCtx(recovery?: string): Record<string, unknown> {
	const entries: Array<Record<string, unknown>> = [];
	if (recovery !== undefined) {
		entries.push({ type: "custom", customType: CUSTOM_ENTRY_TYPES.state, data: { recovery } });
	}
	return {
		cwd: env.testCwd,
		model: { provider: "test", id: "test-model" },
		modelRegistry: { find: () => undefined, hasConfiguredAuth: () => true },
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

async function startSession(recovery?: string): Promise<void> {
	if (sessionStartHandler) await sessionStartHandler({}, makeCtx(recovery));
}

function recoveryMessages(): Captured[] {
	return captured.filter((c) => c.message.customType === "subagent-recovery");
}

function seedInterruptedRun(
	opts: { recoveryPosture?: RecoveryMode } = {},
): void {
	registerInflightRun({
		id: ID,
		kind: "background",
		startedAt: "2026-01-01T00:00:00.000Z",
		cwd: env.testCwd,
		...(opts.recoveryPosture ? { recoveryPosture: opts.recoveryPosture } : {}),
	});
	markInterrupted(ID, "2026-01-01T00:05:00.000Z");
	// A matching background agent record gives the notice label/task.
	fs.mkdirSync(env.storageDir, { recursive: true });
	fs.writeFileSync(path.join(env.storageDir, `${ID}.json`), JSON.stringify({
		id: ID,
		sessionId: ID,
		type: "general-purpose",
		description: "Recoverable",
		status: "running",
		startedAt: Date.now(),
		task: "recover me",
		model: "provider/model",
		thinkingLevel: "medium",
	}));
}

beforeAll(() => {
	setupExtension();
});

beforeEach(() => {
	env.setUp();
	captured = [];
});

afterEach(async () => {
	// End the session so the once-per-boot guard resets for the next case.
	if (sessionShutdownHandler) await sessionShutdownHandler();
	await env.tearDown();
});

afterAll(() => {
	expect(typeof sessionStartHandler).toBe("function");
});

describe("U3 boot notice — delivery (T2)", () => {
	it("sends ONE subagent-recovery message at a turn boundary, never steer", async () => {
		seedInterruptedRun();
		await startSession("offer");

		const notices = recoveryMessages();
		expect(notices).toHaveLength(1);
		expect(notices[0].options).toMatchObject({ deliverAs: "nextTurn", triggerTurn: true });
		expect(notices[0].options?.deliverAs).not.toBe("steer");
		expect(String(notices[0].message.content)).toContain(ID.slice(0, 8));
		expect(String(notices[0].message.content)).toContain("Recoverable");
	});

	it("is once per boot — a second session_start is quiet", async () => {
		seedInterruptedRun();
		await startSession("offer");
		expect(recoveryMessages()).toHaveLength(1);

		await startSession("offer");
		expect(recoveryMessages()).toHaveLength(1);
	});

	it("is quiet when no interrupted run exists", async () => {
		await startSession("offer");
		expect(recoveryMessages()).toHaveLength(0);
	});

	it("is silent under posture 'off'", async () => {
		seedInterruptedRun();
		await startSession("off");
		expect(recoveryMessages()).toHaveLength(0);
	});

	it("is silent when the run's dispatch snapshot is 'off'", async () => {
		seedInterruptedRun({ recoveryPosture: "off" });
		await startSession("offer");
		expect(recoveryMessages()).toHaveLength(0);
	});
});

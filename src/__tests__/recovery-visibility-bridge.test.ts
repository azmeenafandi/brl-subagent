/**
 * Option B U3 Fix A — the fresh-boot visibility bridge (the C1 review's three
 * criticals, one root).
 *
 * U3's recovery surfaces were session-sourced, but after a genuine crash + fresh
 * boot the interrupted run exists ONLY in the durable registry
 * (`.pi/run-registry/<id>.json`) plus the background agent record
 * (`.pi/subagents/<id>.json`). The current session has NO entry for it, so the
 * unbridged surfaces silently returned nothing:
 *
 *   1. Run History omitted the run;
 *   2. the retry menu never offered it;
 *   3. `abandonInterruptedRun`'s session lookup returned undefined → `false`;
 *   4. `retryRunId` rejected the notice's id as not found.
 *
 * The existing U3 tests MASKED this by seeding a marked entry into the session
 * (see T1/T4/T6 in recovery-surface.test.ts). This suite deliberately does the
 * OPPOSITE — it seeds the DURABLE state the way production leaves it and drives
 * a session with ZERO run entries — and asserts all four consumers through the
 * SAME `visibleRunEntries` bridge the production call sites use.
 *
 * No real-store writes: the registry and the agent store are redirected into a
 * per-test throwaway dir by the shared temp-lifecycle fixture.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

import {
	createSessionState,
	collapseRunsForHistory,
	retryableRuns,
	resolveTerminalRunEntry,
} from "../state";
import { runHistoryStatus } from "../tui-format";
import { isInterruptedRun, CUSTOM_ENTRY_TYPES, type SubagentRun } from "../types";
import {
	visibleRunEntries,
	abandonInterruptedRun,
	SUBAGENT_ABANDONED_MESSAGE,
} from "../recovery-surface";
import {
	registerInflightRun,
	markInterrupted,
	listInflightRuns,
	clearInflightRun,
} from "../run-registry";
import { getAgent } from "../session-manager";
import { createTempEnv } from "./fixtures/temp-lifecycle";
import type { Logger } from "../logging";
import * as fs from "node:fs";
import * as path from "node:path";

const ID = "11111111-2222-3333-4444-555555555555";

const env = createTempEnv("brl-u3-visible");

function makeLog(): Logger {
	return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

/** A genuinely fresh session: the crash's records live only on disk. */
function freshSession(): ExtensionContext {
	return {
		sessionManager: { getEntries: () => [] },
	} as unknown as ExtensionContext;
}

/**
 * Fabricate the durable state production leaves after a crash: a registry
 * entry carrying the boot scan's `interruptedAt` mark, plus the background
 * agent record that gives the run a label/task. The current session is NEVER
 * given an entry for this id.
 */
function seedDurableInterruptedRun(task = "recover me", label = "Recoverable"): void {
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
			description: label,
			status: "running",
			startedAt: Date.now(),
			task,
			model: "provider/model",
			thinkingLevel: "medium",
		}),
	);
}

/** The SAME bridge wiring the extension and TUI consumers use. */
function bridgeEntries(ctx: ExtensionContext, state: ReturnType<typeof createSessionState>): SubagentRun[] {
	const entries = state.getRunEntries(ctx);
	return visibleRunEntries(entries, {
		listInflight: () => listInflightRuns(),
		getAgent: (id) => getAgent(id),
		findRun: (id) => resolveTerminalRunEntry(entries, id),
	});
}

beforeEach(() => env.setUp());
afterEach(async () => {
	await env.tearDown();
});

describe("U3 Fix A — fresh-boot visibility (no session entries)", () => {
	it("consumer 1: Run History lists the run as Interrupted", () => {
		seedDurableInterruptedRun();
		const state = createSessionState(makeLog());
		const ctx = freshSession();

		const rows = collapseRunsForHistory(bridgeEntries(ctx, state));

		expect(rows).toHaveLength(1);
		expect(rows[0].id).toBe(ID);
		expect(runHistoryStatus(rows[0])).toBe("interrupted");
		expect(rows[0].label).toBe("Recoverable");
		expect(rows[0].task).toBe("recover me");
	});

	it("consumer 2: the retry menu offers the run", () => {
		seedDurableInterruptedRun();
		const state = createSessionState(makeLog());
		const ctx = freshSession();

		const candidates = retryableRuns(bridgeEntries(ctx, state));

		expect(candidates.map((r) => r.id)).toEqual([ID]);
		expect(isInterruptedRun(candidates[0])).toBe(true);
	});

	it("consumer 3: abandon succeeds (not the silent false) and writes the terminal outcome", () => {
		seedDurableInterruptedRun();
		const state = createSessionState(makeLog());
		const ctx = freshSession();
		const writes: SubagentRun[] = [];
		const markAgentStopped = vi.fn();
		const pruneSession = vi.fn();

		const abandoned = abandonInterruptedRun(ID, {
			getRun: (runId) => resolveTerminalRunEntry(bridgeEntries(ctx, state), runId),
			writeRun: (run) => writes.push(run),
			markAgentStopped,
			retireRegistry: (runId) => clearInflightRun(runId),
			pruneSession,
		});

		expect(abandoned).toBe(true);
		expect(writes).toHaveLength(1);
		expect(writes[0].errorCategory).toBe("aborted");
		expect(writes[0].errorMessage).toBe(SUBAGENT_ABANDONED_MESSAGE);
		expect(markAgentStopped).toHaveBeenCalledWith(ID);
		expect(pruneSession).toHaveBeenCalledWith(ID);
		// The registry mark was retired, so a later bridge read no longer shows it.
		expect(bridgeEntries(ctx, state)).toHaveLength(0);
	});

	it("consumer 4: the notice's id resolves through the retryRunId lookup", () => {
		seedDurableInterruptedRun();
		const state = createSessionState(makeLog());
		const ctx = freshSession();
		// The retry path prefers the session spawn entry; there is none here, so
		// it falls through to the bridge — exactly the production branch.
		const sessionSpawn = state.findSpawnRunById(ctx, ID);
		expect(sessionSpawn).toBeUndefined();

		const resolved = resolveTerminalRunEntry(bridgeEntries(ctx, state), ID);

		expect(resolved).toBeDefined();
		expect(resolved?.id).toBe(ID);
		expect(isInterruptedRun(resolved!)).toBe(true);
	});
});

describe("U3 Fix A — dedupe / idempotence (no stacking)", () => {
	it("adds nothing when the session already carries the marked run (reload case)", () => {
		seedDurableInterruptedRun();
		const state = createSessionState(makeLog());
		const marked: SubagentRun = {
			id: ID,
			task: "recover me",
			label: "Recoverable",
			status: "running",
			model: "provider/model",
			thinkingLevel: "medium",
			startedAt: "2026-01-01T00:00:00.000Z",
			interruptedAt: "2026-01-01T00:05:00.000Z",
		};
		const ctx = {
			sessionManager: { getEntries: () => [{ type: "custom", customType: CUSTOM_ENTRY_TYPES.run, data: marked }] },
		} as unknown as ExtensionContext;
		const entries = state.getRunEntries(ctx);

		const bridge = visibleRunEntries(entries, {
			listInflight: () => listInflightRuns(),
			getAgent: (id) => getAgent(id),
			findRun: (id) => resolveTerminalRunEntry(entries, id),
		});

		// Same reference: the bridge is a pure identity on the already-visible path.
		expect(bridge).toBe(entries);
		expect(collapseRunsForHistory(bridge)).toHaveLength(1);
	});

	it("a terminal session entry beats the durable mark (no second interrupted row)", () => {
		seedDurableInterruptedRun();
		const state = createSessionState(makeLog());
		const terminal: SubagentRun = {
			id: ID,
			task: "recover me",
			status: "failed",
			errorCategory: "aborted",
			model: "provider/model",
			thinkingLevel: "medium",
			startedAt: "2026-01-01T00:00:00.000Z",
			finishedAt: "2026-01-01T02:00:00.000Z",
		};
		const ctx = {
			sessionManager: { getEntries: () => [{ type: "custom", customType: CUSTOM_ENTRY_TYPES.run, data: terminal }] },
		} as unknown as ExtensionContext;
		const entries = state.getRunEntries(ctx);

		const bridge = visibleRunEntries(entries, {
			listInflight: () => listInflightRuns(),
			getAgent: (id) => getAgent(id),
			findRun: (id) => resolveTerminalRunEntry(entries, id),
		});

		expect(bridge).toBe(entries);
		const rows = collapseRunsForHistory(bridge);
		expect(rows).toHaveLength(1);
		expect(runHistoryStatus(rows[0])).toBe("failed");
	});

	it("augments an unmarked session SPAWN entry exactly once (reload before the mark was visible)", () => {
		seedDurableInterruptedRun();
		const state = createSessionState(makeLog());
		const spawn: SubagentRun = {
			id: ID,
			task: "recover me",
			status: "running",
			model: "provider/model",
			thinkingLevel: "medium",
			startedAt: "2026-01-01T00:00:00.000Z",
			originalParams: { model: "provider/model", background: true },
		};
		const ctx = {
			sessionManager: { getEntries: () => [{ type: "custom", customType: CUSTOM_ENTRY_TYPES.run, data: spawn }] },
		} as unknown as ExtensionContext;
		const entries = state.getRunEntries(ctx);
		const deps = {
			listInflight: () => listInflightRuns(),
			getAgent: (id: string) => getAgent(id),
			findRun: (id: string) => resolveTerminalRunEntry(entries, id),
		};

		const bridge = visibleRunEntries(entries, deps);
		const again = visibleRunEntries(entries, deps);

		// One synthetic added over the spawn entry; repeated reads never stack.
		expect(bridge).toHaveLength(entries.length + 1);
		expect(again).toHaveLength(entries.length + 1);
		const collapsed = collapseRunsForHistory(bridge);
		expect(collapsed).toHaveLength(1);
		expect(isInterruptedRun(collapsed[0])).toBe(true);
		// The session spawn entry is still the spawn lookup's source (originalParams).
		expect(state.findSpawnRunById(ctx, ID)).toBe(spawn);
	});
});

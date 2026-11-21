/**
 * ADR 0027 S4 — the terminal notifier factory and its per-instance latch (D5).
 *
 * `src/terminal-notifier.ts` owns the three terminal event-bus subscriptions and
 * the release latch that #437 requires. D5's blocker is a MODULE-PRIVATE latch: a
 * module-level `released` flag (or a module-level subscription array) is shared by
 * every `initExtension` instance, so one runtime's shutdown would either unhook
 * another runtime's listeners or mark them released and never unhook them at all
 * — the two-factory probe `a=1, b=0` where `b` should be 1.
 *
 * This suite drives the REAL factory against the REAL shared event bus and the
 * REAL terminal claim set, with two independent runtimes (two `createRuntime`
 * calls, hence two `pi`/`state` pairs) and asserts:
 *
 *   1. `release()` is idempotent and removes exactly one factory's three
 *      listeners;
 *   2. with TWO factories alive, releasing one leaves the other subscribed AND
 *      delivering, and the survivor's own `release()` still works;
 *   3. a factory created after a release still delivers (a restart is not
 *      silenced by a latch that outlived its owner).
 *
 * The event bus is NOT mocked — `__listenerIdentities` is its read-only test
 * seam. Only `getAgent` is stubbed (it is what the alert reads to resolve the
 * run), as in the existing notification suites.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const h = vi.hoisted(() => ({ getAgent: vi.fn() }));

vi.mock("../session-manager", async (importOriginal) => ({
	...(await importOriginal<typeof import("../session-manager")>()),
	getAgent: h.getAgent,
}));

import * as eventBus from "../event-bus";
import { __resetTerminalClaims } from "../notify-completion";
import { createRuntime } from "../runtime";
import { createTerminalNotifier } from "../terminal-notifier";
import { CUSTOM_ENTRY_TYPES, type BackgroundAgent, type SubagentEventType, type SubagentRun } from "../types";

const TERMINAL_TYPES: readonly SubagentEventType[] = [
	"subagent:completed",
	"subagent:failed",
	"subagent:stopped",
];

interface Harness {
	pi: ExtensionAPI & { sendMessage: ReturnType<typeof vi.fn> };
	ctx: ExtensionContext;
	release: () => void;
	sent: () => number;
}

/**
 * A factory plus the runtime it was built over — one `initExtension` equivalent.
 * `entries` is the run-entry store this factory's session sees (issue #556: the
 * advisory reads the durable records, so a test seeds them here).
 */
function makeFactory(entries: Array<Record<string, unknown>> = []): Harness {
	const sendMessage = vi.fn();
	const pi = { sendMessage, appendEntry: vi.fn() } as unknown as ExtensionAPI & {
		sendMessage: ReturnType<typeof vi.fn>;
	};
	const ctx = {
		cwd: process.cwd(),
		model: { provider: "test", id: "model" },
		getSystemPrompt: () => "SYSTEM",
		instrumentation: undefined,
		ui: { notify: vi.fn(), setStatus: vi.fn(), theme: { fg: (_c: string, t: string) => t } },
		sessionManager: { getEntries: () => entries, appendCustomEntry: () => {} },
	} as unknown as ExtensionContext;
	const notifier = createTerminalNotifier(createRuntime(pi), {
		getSession: () => ctx,
		spawnBackgroundRun: async () => ({ content: [], details: undefined }),
	});
	return { pi, ctx, release: notifier.release, sent: () => sendMessage.mock.calls.length };
}

/** The agent record the alert resolves through the stubbed `getAgent`. */
function fakeAgent(id: string): BackgroundAgent {
	return {
		id,
		sessionId: id,
		type: "general-purpose",
		description: "notifier probe",
		status: "done",
		startedAt: 1_700_000_000_000,
		task: "probe the notifier",
		model: "test/model",
		thinkingLevel: "medium",
	} as unknown as BackgroundAgent;
}

let idSeq = 0;
/** Emit a terminal event for a FRESH id — the claim set is once-per-id per process. */
function emitTerminal(type: SubagentEventType): void {
	idSeq += 1;
	emitFor(`s4-notifier-${idSeq}`, type);
}

/** Emit a terminal event for a KNOWN id, so a seeded run record can be matched. */
function emitFor(id: string, type: SubagentEventType = "subagent:failed"): void {
	h.getAgent.mockImplementation((agentId: string) => (agentId === id ? fakeAgent(id) : null));
	eventBus.emit({ type, agentId: id, timestamp: Date.now(), data: {} });
}

/** A settled background record, shaped like the durable entry the alert reads. */
function settledRun(overrides: Partial<SubagentRun> = {}): SubagentRun {
	return {
		id: "bg-556-retry",
		task: "review the docs",
		description: "notifier probe",
		label: "notifier probe",
		status: "failed",
		model: "test/model",
		thinkingLevel: "medium",
		startedAt: "2026-11-20T00:00:00.000Z",
		durationMs: 1_000,
		errorCategory: "exit_error",
		errorMessage: "Connection error.",
		originalParams: { background: true, model: "test/model" },
		...overrides,
	};
}

/** The session-manager entry shape a run record is persisted as. */
function runEntry(run: SubagentRun): Record<string, unknown> {
	return { type: "custom", customType: CUSTOM_ENTRY_TYPES.run, data: run };
}

/** The single delivered completion message's content. */
function delivered(harness: Harness): string {
	return String(harness.pi.sendMessage.mock.calls[0]?.[0]?.content ?? "");
}

/** The listener does `void deliverCompletionAlert(event)` — poll until it lands. */
async function untilLanded(predicate: () => boolean): Promise<void> {
	for (let i = 0; i < 500 && !predicate(); i += 1) {
		await new Promise((resolve) => setTimeout(resolve, 1));
	}
}

function listenerCount(type: SubagentEventType): number {
	return eventBus.__listenerIdentities(type).length;
}

beforeEach(() => {
	__resetTerminalClaims();
	h.getAgent.mockReset();
});

afterEach(() => {
	// Nothing may leak into the next case: this file drives the process-global bus.
	for (const type of TERMINAL_TYPES) {
		for (const listener of eventBus.__listenerIdentities(type)) eventBus.off(type, listener);
	}
});

describe("the terminal notifier's release is per factory instance (ADR 0027 D5)", () => {
	it("releases exactly its own three listeners, and a second release is a no-op", () => {
		const a = makeFactory();
		expect(TERMINAL_TYPES.map(listenerCount)).toEqual([1, 1, 1]);

		a.release();
		expect(TERMINAL_TYPES.map(listenerCount)).toEqual([0, 0, 0]);

		// Idempotent: a repeated/late shutdown must not throw or touch anything else.
		expect(() => a.release()).not.toThrow();
		expect(TERMINAL_TYPES.map(listenerCount)).toEqual([0, 0, 0]);
	});

	it("with two factories alive, releasing one leaves the other subscribed AND delivering", async () => {
		const a = makeFactory();
		const b = makeFactory();
		expect(TERMINAL_TYPES.map(listenerCount)).toEqual([2, 2, 2]);

		a.release();
		// The mutant (a module-private latch) takes BOTH down here, or leaves both:
		// exactly one listener per type must remain, and it must be B's.
		expect(TERMINAL_TYPES.map(listenerCount)).toEqual([1, 1, 1]);

		emitTerminal("subagent:completed");
		await untilLanded(() => b.sent() > 0);
		expect(b.sent()).toBe(1);
		expect(a.sent()).toBe(0);

		// The survivor's own release is still effective — a shared flag would have
		// been set by A's release and this would silently keep B's listeners forever.
		b.release();
		expect(TERMINAL_TYPES.map(listenerCount)).toEqual([0, 0, 0]);
	});

	it("a factory created after a release still delivers (a restart is not silenced)", async () => {
		const first = makeFactory();
		first.release();

		const second = makeFactory();
		emitTerminal("subagent:completed");
		await untilLanded(() => second.sent() > 0);

		expect(second.sent()).toBe(1);
		expect(first.sent()).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// Issue #556 — the repeat transport death advisory rides the completion notice
// ---------------------------------------------------------------------------

describe("the repeat transport death advisory (issue #556)", () => {
	it("carries the change-shape rule when both this attempt and its source died on transport", async () => {
		const source = settledRun({ id: "bg-556-source", attempt: 1 });
		const retry = settledRun({ id: "bg-556-retry", attempt: 2, resumeOf: source.id });
		const harness = makeFactory([runEntry(source), runEntry(retry)]);

		emitFor(retry.id);
		await untilLanded(() => harness.sent() > 0);

		expect(harness.sent()).toBe(1);
		const content = delivered(harness);
		expect(content).toContain('Two transport deaths on "notifier probe"');
		expect(content).toContain("attempts 1 and 2");
		expect(content).toContain("references/autonomous-run.md");
		// The ordinary notice is still there — the paragraph rides it, never replaces it.
		expect(content).toContain("— failed");
	});

	it("keeps this attempt's plain notice when the run record is MISSING (no throw, no paragraph)", async () => {
		// Mutant killed (M4): an unguarded `run.resumeOf` throws here, the outer
		// catch swallows it, and the conductor is never woken at all.
		const harness = makeFactory();

		emitFor("bg-556-unrecorded");
		await untilLanded(() => harness.sent() > 0);

		expect(harness.sent()).toBe(1);
		expect(delivered(harness)).not.toContain("Two transport deaths");
		// The generic notice for what the agent record says — whatever it says.
		expect(delivered(harness)).toContain('Background agent "notifier probe" (bg-556-unrecorded)');
	});

	it("keeps the plain notice when the source record the retry resumed is unknown", async () => {
		const retry = settledRun({ id: "bg-556-orphan", attempt: 2, resumeOf: "bg-556-vanished" });
		const harness = makeFactory([runEntry(retry)]);

		emitFor(retry.id);
		await untilLanded(() => harness.sent() > 0);

		expect(harness.sent()).toBe(1);
		expect(delivered(harness)).not.toContain("Two transport deaths");
		expect(delivered(harness)).toContain("— failed");
	});

	it("says nothing about a repeat when the SOURCE died of something else", async () => {
		const source = settledRun({
			id: "bg-556-source",
			attempt: 1,
			errorCategory: "tool_error",
			errorMessage: "Pre-flight validation failed",
		});
		const retry = settledRun({ id: "bg-556-retry", attempt: 2, resumeOf: source.id });
		const harness = makeFactory([runEntry(source), runEntry(retry)]);

		emitFor(retry.id);
		await untilLanded(() => harness.sent() > 0);

		expect(harness.sent()).toBe(1);
		expect(delivered(harness)).not.toContain("Two transport deaths");
	});
});

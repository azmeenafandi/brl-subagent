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
import type { BackgroundAgent, SubagentEventType } from "../types";

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

/** A factory plus the runtime it was built over — one `initExtension` equivalent. */
function makeFactory(): Harness {
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
		sessionManager: { getEntries: () => [], appendCustomEntry: () => {} },
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
	const id = `s4-notifier-${idSeq}`;
	h.getAgent.mockImplementation((agentId: string) => (agentId === id ? fakeAgent(id) : null));
	eventBus.emit({ type, agentId: id, timestamp: Date.now(), data: {} });
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

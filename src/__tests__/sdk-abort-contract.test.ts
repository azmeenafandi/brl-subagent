/**
 * PROBE TEST — Issue #28 / PR 1a (Risk #1): What does `session.prompt()`
 * do when `session.abort()` fires mid-run?
 *
 * SDK source reading says: `Agent.runWithLifecycle` CATCHES executor errors
 * and converts them into a failure message with `stopReason: "aborted"`
 * (agent-core/dist/agent.js handleRunFailure) — the run promise RESOLVES.
 * Then `_handlePostAgentRun` returns false for aborted messages
 * (isRetryableAssistantError only matches stopReason "error"), so
 * `session.prompt()` RESOLVES, it does NOT reject.
 *
 * This test drives a REAL `createAgentSession` (real Agent, real AgentSession,
 * real extension runner) with a fake modelRuntime whose stream hangs, then
 * aborts mid-run and records what the prompt promise does. It is the empirical
 * contract that W1's stopped-vs-failed discrimination is built on.
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAgentSession, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

/**
 * A stream that emits a `start` event, then waits on the abort signal.
 * When the signal fires it throws AbortError — mirroring how a real
 * provider stream (fetch-based) reacts to session.abort().
 */
function signalAwareStream(signal: AbortSignal) {
	const events: Array<{ type: "start"; partial: unknown }> = [
		{
			type: "start",
			partial: {
				role: "assistant",
				content: [],
				stopReason: "pending",
				timestamp: Date.now(),
			},
		},
	];
	return {
		[Symbol.asyncIterator]() {
			let i = 0;
			return {
				next: () => {
					if (i < events.length) {
						const value = events[i++];
						return Promise.resolve({ value, done: false });
					}
					// Wait for the abort signal, then throw AbortError like a
					// real provider whose HTTP request was aborted.
					return new Promise<IteratorResult<unknown>>((_, reject) => {
						const fail = () => reject(new DOMException("Aborted", "AbortError"));
						if (signal.aborted) fail();
						else signal.addEventListener("abort", fail, { once: true });
					});
				},
			};
		},
		result: () => new Promise(() => {}),
	};
}

/** Minimal fake modelRuntime surface used by createAgentSession + prompt(). */
function fakeModelRuntime() {
	return {
		hasConfiguredAuth: () => true,
		checkAuth: () => Promise.resolve({ configured: true }),
		isUsingOAuth: () => false,
		getModel: () => undefined,
		streamSimple: (_model: unknown, _context: unknown, options: { signal?: AbortSignal }) =>
			signalAwareStream(options?.signal ?? new AbortController().signal),
	};
}

/** Minimal fake Model object. */
function fakeModel() {
	return {
		id: "probe-model",
		name: "Probe Model",
		api: "anthropic-messages",
		provider: "probe",
		baseUrl: "https://probe.invalid",
		reasoning: false,
		input: ["text"] as const,
		cost: { input: 0, output: 0 },
		contextWindow: 200000,
		maxTokens: 8192,
	};
}

let probeDir: string;

beforeAll(async () => {
	probeDir = await mkdtemp(join(tmpdir(), "brl-abort-probe-"));
});

afterAll(async () => {
	await rm(probeDir, { recursive: true, force: true });
});

describe("SDK abort contract (probe for #28 W1)", () => {
	it("session.prompt() RESOLVES (not rejects) when abort() fires mid-run", async () => {
		const { session } = await createAgentSession({
			cwd: probeDir,
			sessionManager: SessionManager.inMemory(probeDir),
			settingsManager: SettingsManager.create(probeDir),
			modelRuntime: fakeModelRuntime() as never,
			model: fakeModel() as never,
			thinkingLevel: "medium",
		});

		// Start the prompt — do not await. The fake stream hangs after `start`.
		const promptPromise = session.prompt("probe: hang forever");

		// Give the run a tick to get past preflight into the streaming loop.
		await new Promise((r) => setTimeout(r, 50));

		// Abort mid-run. abort() waits for the agent to become idle.
		await session.abort();

		// The critical probe: does the prompt promise settle, and how?
		let settled: "resolved" | "rejected" | "pending" = "pending";
		let rejection: unknown = undefined;
		await Promise.race([
			promptPromise.then(
				() => { settled = "resolved"; },
				(err) => { settled = "rejected"; rejection = err; },
			),
			new Promise((r) => setTimeout(r, 2000)),
		]);

		expect(settled).toBe("resolved");
		expect(rejection).toBeUndefined();

		// The aborted run must leave a trace in the session: the last
		// assistant message should carry stopReason "aborted".
		const assistantMessages = session.messages.filter((m) => m.role === "assistant");
		const lastAssistant = assistantMessages[assistantMessages.length - 1];
		expect(lastAssistant).toBeDefined();
		expect(lastAssistant?.stopReason).toBe("aborted");
	}, 15000);

	it("session.isStreaming returns false after abort settles", async () => {
		const { session } = await createAgentSession({
			cwd: probeDir,
			sessionManager: SessionManager.inMemory(probeDir),
			settingsManager: SettingsManager.create(probeDir),
			modelRuntime: fakeModelRuntime() as never,
			model: fakeModel() as never,
			thinkingLevel: "medium",
		});

		const promptPromise = session.prompt("probe: hang forever");
		await new Promise((r) => setTimeout(r, 50));
		expect(session.isStreaming).toBe(true);

		await session.abort();
		await promptPromise;

		expect(session.isStreaming).toBe(false);
		expect(session.isIdle).toBe(true);
	}, 15000);
});

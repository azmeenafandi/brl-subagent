/**
 * Tests for backend.ts — Pluggable backends (E8)
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { getBackend, PiBackend, DirectBackend, DEFAULT_BACKEND, AVAILABLE_BACKENDS } from "../backend";
import type { Backend } from "../backend";

// ---------------------------------------------------------------------------
// Mock runSubagent to test PiBackend integration indirectly
// ---------------------------------------------------------------------------

vi.mock("../runner", () => ({
	runSubagent: vi.fn().mockResolvedValue({
		messages: [{ role: "assistant", content: [{ type: "text", text: "mocked" }] }],
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 1 },
		exitCode: 0,
		stderr: "",
	}),
}));

// ---------------------------------------------------------------------------
// getBackend
// ---------------------------------------------------------------------------

describe("getBackend", () => {
	it('getBackend("pi") returns PiBackend instance', () => {
		const backend = getBackend("pi");
		expect(backend).toBeDefined();
		expect(backend).toBeInstanceOf(PiBackend);
	});

	it('getBackend("direct-api") returns DirectBackend instance', () => {
		const backend = getBackend("direct-api");
		expect(backend).toBeDefined();
		expect(backend).toBeInstanceOf(DirectBackend);
	});

	it('getBackend("unknown") returns undefined', () => {
		const backend = getBackend("unknown");
		expect(backend).toBeUndefined();
	});

	it("PiBackend.supportsTools is true", () => {
		const backend = getBackend("pi")!;
		expect(backend.supportsTools).toBe(true);
	});

	it("DirectBackend.supportsTools is false", () => {
		const backend = getBackend("direct-api")!;
		expect(backend.supportsTools).toBe(false);
	});
});

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

describe("backend constants", () => {
	it("DEFAULT_BACKEND is 'pi'", () => {
		expect(DEFAULT_BACKEND).toBe("pi");
	});

	it("AVAILABLE_BACKENDS contains pi and direct-api", () => {
		expect(AVAILABLE_BACKENDS).toContain("pi");
		expect(AVAILABLE_BACKENDS).toContain("direct-api");
		expect(AVAILABLE_BACKENDS).toHaveLength(2);
	});
});

// ---------------------------------------------------------------------------
// PiBackend.execute
// ---------------------------------------------------------------------------

describe("PiBackend.execute", () => {
	it("returns a result with exitCode 0", async () => {
		const backend = getBackend("pi")!;
		const result = await backend.execute("test task", "model/test", "off");
		expect(result.exitCode).toBe(0);
	});
});

// ---------------------------------------------------------------------------
// DirectBackend.execute
// ---------------------------------------------------------------------------

describe("DirectBackend.execute", () => {
	it("returns placeholder result with appropriate message", async () => {
		const backend = getBackend("direct-api")!;
		const result = await backend.execute("test task", "model/test", "off");

		expect(result.exitCode).toBe(0);
		expect(result.messages).toHaveLength(1);

		const msg = result.messages[0] as Record<string, unknown>;
		expect(msg.role).toBe("assistant");

		const content = msg.content as Array<Record<string, unknown>>;
		expect(content).toHaveLength(1);
		expect(content[0].type).toBe("text");
		expect(content[0].text).toBe(
			"Direct API backend is not yet implemented. Use the default pi backend.",
		);
	});

	it("handles abort signal", async () => {
		const backend = getBackend("direct-api")!;
		const controller = new AbortController();
		controller.abort();

		const result = await backend.execute(
			"test task",
			"model/test",
			"off",
			controller.signal,
		);

		expect(result.exitCode).toBe(1);
		expect(result.stopReason).toBe("aborted");
		expect(result.errorMessage).toBe("Aborted");
	});

	it("returns zero usage stats", async () => {
		const backend = getBackend("direct-api")!;
		const result = await backend.execute("test task", "model/test", "off");

		expect(result.usage.input).toBe(0);
		expect(result.usage.output).toBe(0);
		expect(result.usage.cost).toBe(0);
		expect(result.usage.turns).toBe(0);
	});
});

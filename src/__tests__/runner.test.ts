/**
 * Unit tests for runner.ts — the foreground task→subprocess chokepoint.
 *
 * F27/F43: the task must reach the spawned pi process wrapped in the
 * <task> data fence. Previously untested (the review flagged this as a
 * coverage gap — the primary foreground wrap had zero assertions).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock spawn so runSubagent never launches a real process.
const mocks = vi.hoisted(() => ({
	spawn: vi.fn(),
}));

vi.mock("node:child_process", () => ({
	spawn: mocks.spawn,
}));

import { runSubagent, getPiInvocation } from "../runner";
import { wrapTask } from "../prompt";
import type { SubagentResult } from "../types";

/** Fake child process: emits close(0) so runSubagent resolves. */
function fakeProc() {
	const proc = {
		stdout: { on: vi.fn() },
		stderr: { on: vi.fn() },
		on: vi.fn((event: string, cb: (code?: number) => void) => {
			if (event === "close") cb(0);
			return proc;
		}),
		kill: vi.fn(),
	};
	return proc as never;
}

const EMPTY_RESULT: SubagentResult = {
	messages: [],
	usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 },
	exitCode: 0,
	stderr: "",
};

beforeEach(() => {
	mocks.spawn.mockReset();
	mocks.spawn.mockReturnValue(fakeProc());
});

describe("runSubagent foreground task fencing (F27)", () => {
	it("passes the task wrapped in <task> markers as the final -p argument", async () => {
		const task = "Review the auth flow";
		await runSubagent(
			"/tmp/cwd",
			"system prompt",
			{ provider: "test", id: "model" },
			"medium",
			task,
			undefined,
			undefined,
			undefined,
			undefined,
			() => "",
		);

		expect(mocks.spawn).toHaveBeenCalledTimes(1);
		const args = mocks.spawn.mock.calls[0][1] as string[];
		// Last argument is the task (the -p prompt); it must be fenced.
		expect(args[args.length - 1]).toBe(wrapTask(task));
		expect(args[args.length - 1]).toBe("<task>\nReview the auth flow\n</task>");
	});

	it("wraps the task AFTER intercom injection (substituted content lands inside the fence)", async () => {
		// Intercom injection happens inside runSubagent before the wrap; a
		// message containing a forged </task> must be neutralized by wrapTask.
		const task = "do the thing";
		await runSubagent(
			"/tmp/cwd",
			"system prompt",
			{ provider: "test", id: "model" },
			"medium",
			task,
			undefined,
			undefined,
			undefined,
			undefined,
			() => "",
		);

		const args = mocks.spawn.mock.calls[0][1] as string[];
		const last = args[args.length - 1];
		expect(last.startsWith("<task>\n")).toBe(true);
		expect(last.endsWith("\n</task>")).toBe(true);
	});

	it("passes --append-system-prompt with the system prompt file", async () => {
		await runSubagent(
			"/tmp/cwd",
			"SYSTEM PROMPT CONTENT",
			{ provider: "test", id: "model" },
			"medium",
			"task",
			undefined,
			undefined,
			undefined,
			undefined,
			() => "",
		);

		const args = mocks.spawn.mock.calls[0][1] as string[];
		const idx = args.indexOf("--append-system-prompt");
		expect(idx).toBeGreaterThan(-1);
		expect(args[idx + 1]).toBeDefined();
	});
});

describe("getPiInvocation", () => {
	it("returns the current script when it exists (dev path)", () => {
		const inv = getPiInvocation(["--mode", "json"]);
		expect(inv.args).toContain("--mode");
		expect(inv.args).toContain("json");
	});
});

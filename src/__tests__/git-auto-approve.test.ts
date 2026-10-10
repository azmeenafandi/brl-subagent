/**
 * Foreground gitMode=branch auto-approve teardown (#308).
 *
 * On a successful run the foreground flow restores the starting HEAD, then
 * auto-approves (merges) the work branch when the run produced changes. A
 * DETACHED start has no branch of its own to hold that merge result: teardown
 * re-detached at the captured sha and the merge fast-forwarded THAT detached
 * HEAD, so deleting the work branch would leave the committed work reachable
 * only from the detached HEAD — silently lost on the next checkout (#308).
 *
 * The fix preserves the work branch on the detached path (the durable ref) and
 * logs where the work lives; an ATTACHED start merged onto its own branch, so
 * its temporary work branch is still deleted as before.
 *
 * Harness mirrors per-step-cwd.test.ts: the REAL delegate_task execute handler
 * with ../runner and ../git mocked (no subprocesses, no real repo). The logger
 * is pointed at a throwaway dir so the preservation log line can be asserted.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the extension
// ---------------------------------------------------------------------------

const runnerMocks = vi.hoisted(() => ({
	runSubagent: vi.fn(),
	cleanupTempDirs: vi.fn().mockResolvedValue(0),
	getPiInvocation: vi.fn(),
	accumulateUsage: vi.fn(),
	parseSubagentLine: vi.fn(),
}));

vi.mock("../runner", () => ({
	runSubagent: runnerMocks.runSubagent,
	cleanupTempDirs: runnerMocks.cleanupTempDirs,
	getPiInvocation: runnerMocks.getPiInvocation,
	accumulateUsage: runnerMocks.accumulateUsage,
	parseSubagentLine: runnerMocks.parseSubagentLine,
}));

const gitMocks = vi.hoisted(() => ({
	hasUncommittedChanges: vi.fn(),
	createWorkBranch: vi.fn(),
	captureDiff: vi.fn(),
	getHeadState: vi.fn(),
	restoreHead: vi.fn(),
	deleteBranch: vi.fn(),
	mergeWorkBranch: vi.fn(),
}));

vi.mock("../git", () => ({
	hasUncommittedChanges: gitMocks.hasUncommittedChanges,
	createWorkBranch: gitMocks.createWorkBranch,
	captureDiff: gitMocks.captureDiff,
	getHeadState: gitMocks.getHeadState,
	restoreHead: gitMocks.restoreHead,
	deleteBranch: gitMocks.deleteBranch,
	mergeWorkBranch: gitMocks.mergeWorkBranch,
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
import { setLogCwd } from "../logging";
import { createTempEnv } from "./fixtures/temp-lifecycle";
import type { SubagentResult } from "../types";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_MODEL = { provider: "test", id: "test-model" };
const WORK_BRANCH = "brl-subagent-abc12345";

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
const env = createTempEnv("brl-git-approve");
let logDir: string;

function setupExtension(): ToolEntry {
	const registeredTools = new Map<string, ToolEntry>();
	const mockPi = {
		registerTool: (t: ToolEntry) => registeredTools.set(t.name, t),
		registerCommand: () => {},
		registerShortcut: () => {},
		on: () => {},
		appendEntry: () => {},
		sendMessage: () => {},
		ctx: { getState: () => undefined, setState: () => {} },
	};
	initExtension(mockPi as never);
	const toolEntry = registeredTools.get("delegate_task");
	if (!toolEntry) throw new Error("delegate_task tool not registered");
	return toolEntry;
}

function makeCtx() {
	return {
		cwd: env.testCwd,
		model: GLOBAL_MODEL,
		modelRegistry: {
			find: (provider: string, id: string) => ({ provider, id }),
			hasConfiguredAuth: () => true,
		},
		getSystemPrompt: () => "You are a helpful assistant.",
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: { getEntries: () => [], appendCustomEntry: () => {} },
		hasUI: false,
	};
}

function makeResult(modelStr: string): SubagentResult {
	return {
		messages: [
			{ role: "assistant", content: [{ type: "text", text: "done" }], model: modelStr },
		],
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			cost: 0.001,
			contextTokens: 0,
			turns: 1,
		},
		exitCode: 0,
		stderr: "",
		model: modelStr,
		stopReason: "end_turn",
		errorCategory: "unknown",
	};
}

async function execute(params: Record<string, unknown>) {
	return tool.execute("call-308", params, undefined, undefined, makeCtx());
}

/** Read the shared log sink written during the last execute. */
function logLines(): string[] {
	const logFile = path.join(logDir, ".pi", "subagent-logs", "brl-subagent.log");
	if (!fs.existsSync(logFile)) return [];
	return fs.readFileSync(logFile, "utf-8").split("\n").filter(Boolean);
}

beforeEach(() => {
	env.setUp();
	logDir = fs.mkdtempSync(path.join(env.baseDir, "log-"));
	setLogCwd(logDir);

	runnerMocks.runSubagent.mockReset();
	runnerMocks.runSubagent.mockImplementation(
		async (_cwd: string, _prompt: string, model: { provider: string; id: string }) =>
			makeResult(`${model.provider}/${model.id}`),
	);
	runnerMocks.getPiInvocation.mockReset();
	runnerMocks.getPiInvocation.mockReturnValue({ command: process.execPath, args: [] });

	gitMocks.hasUncommittedChanges.mockReset().mockReturnValue(false);
	gitMocks.getHeadState.mockReset();
	gitMocks.createWorkBranch.mockReset().mockReturnValue({ ok: true, branch: WORK_BRANCH });
	gitMocks.captureDiff.mockReset().mockReturnValue({ ok: true, diff: "diff --git a/x b/x\n+work\n" });
	gitMocks.restoreHead.mockReset().mockReturnValue({ ok: true });
	gitMocks.deleteBranch.mockReset().mockReturnValue({ ok: true });
	gitMocks.mergeWorkBranch.mockReset().mockReturnValue({ ok: true });

	tool = setupExtension();
});

afterAll(async () => {
	setLogCwd(undefined);
	await env.tearDown();
});

// ---------------------------------------------------------------------------
// Auto-approve branch disposal: attached deletes, detached preserves (#308)
// ---------------------------------------------------------------------------

describe("foreground auto-approve teardown (#308)", () => {
	it("attached start: merges then deletes the temporary work branch", async () => {
		gitMocks.getHeadState.mockReturnValue({ sha: "base123", detached: false, branch: "main" });

		const result = await execute({ task: "do work", gitMode: "branch" });

		expect(result.isError).toBeFalsy();
		expect(gitMocks.mergeWorkBranch).toHaveBeenCalledTimes(1);
		expect(gitMocks.mergeWorkBranch).toHaveBeenCalledWith(env.testCwd, WORK_BRANCH);
		// The merge landed on the original branch — dropping the temp branch is safe.
		expect(gitMocks.deleteBranch).toHaveBeenCalledTimes(1);
		expect(gitMocks.deleteBranch).toHaveBeenCalledWith(env.testCwd, WORK_BRANCH);
		expect(logLines().some((l) => l.includes("detached checkout: work preserved"))).toBe(false);
	});

	it("detached start: merges and PRESERVES the work branch as the durable ref", async () => {
		gitMocks.getHeadState.mockReturnValue({ sha: "base123", detached: true, branch: "HEAD" });

		const result = await execute({ task: "do work", gitMode: "branch" });

		expect(result.isError).toBeFalsy();
		expect(gitMocks.mergeWorkBranch).toHaveBeenCalledTimes(1);
		// #308: deleting on a detached start loses the merged commit — the branch
		// is the only durable ref, so it must survive teardown.
		expect(gitMocks.deleteBranch).not.toHaveBeenCalled();
		const preserved = logLines().filter((l) => l.includes("detached checkout: work preserved on branch"));
		expect(preserved).toHaveLength(1);
		expect(preserved[0]).toContain(WORK_BRANCH);
	});
});

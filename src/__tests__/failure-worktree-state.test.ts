/**
 * Issue #474 — the failure path reports the worktree it may have left behind.
 *
 * The unit under test is the WIRING, not the formatter (worktree-report.test.ts
 * owns the block): a settled failure must carry the block at every surface, and
 * a success must carry none. The cwd each surface probes is the load-bearing
 * detail — a batch unit may declare its own directory, so reporting the
 * dispatch's tree instead would describe a repo the unit never touched.
 *
 * Surfaces pinned here:
 *   T1  foreground crash (buildCrashResult — one seam, every crash path)
 *   T2  foreground classified failure (the isSubagentError exit, no throw)
 *   T3  success — no block, and no block in a batch unit's row either
 *   T4  a batch unit's own cwd (chain step) — including the CRASH path, where
 *       the rethrown error must carry the unit's block past the mode's catch
 *   T5  a rejected unit keeps a row (allSettled) with its own block
 *   T6  the background wake — failed carries it, completed does not, and the
 *       #179 completed-to-failed downgrade is classified BEFORE the gate
 *
 * The repository is real (a scratch git repo is the dispatch cwd) so the counts
 * are filesystem truths; the runner and the background spawn are stubbed, which
 * is what makes a crash deterministic. The `cwd` STAMP on the durable agent
 * record is pinned where the real spawn lives (background-session-persistence).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";

import { createTempEnv } from "./fixtures/temp-lifecycle";
import { createTempGitRepo, gitRun } from "./fixtures/temp-git-repo";
import type { SubagentResult, SubagentRun } from "../types";
import { CUSTOM_ENTRY_TYPES } from "../types";

const h = vi.hoisted(() => ({
	runSubagent: vi.fn(),
	cleanupTempDirs: vi.fn().mockResolvedValue(0),
	getPiInvocation: vi.fn(),
	accumulateUsage: vi.fn(),
	parseSubagentLine: vi.fn(),
	spawnBackgroundSession: vi.fn(),
	getAgent: vi.fn(),
}));

vi.mock("../runner", () => ({
	runSubagent: h.runSubagent,
	cleanupTempDirs: h.cleanupTempDirs,
	getPiInvocation: h.getPiInvocation,
	accumulateUsage: h.accumulateUsage,
	parseSubagentLine: h.parseSubagentLine,
}));

vi.mock("../session-manager", async (importOriginal) => ({
	...(await importOriginal<typeof import("../session-manager")>()),
	spawnBackgroundSession: h.spawnBackgroundSession,
	getAgent: h.getAgent,
}));

// tui.ts imports these at runtime; runner.ts's pi import never runs (module mocked).
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
import * as eventBus from "../event-bus";
import { __resetTerminalClaims } from "../notify-completion";

const HEADING = "Worktree state (git, at failure):";
const GLOBAL_MODEL = { provider: "test", id: "test-model" };
const env = createTempEnv("brl-fix474");

function gitAvailable(): boolean {
	try {
		execFileSync("git", ["--version"], { encoding: "utf-8" });
		return true;
	} catch {
		return false;
	}
}

const GIT_OK = gitAvailable();

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
		details?: {
			results?: Array<{ task?: string; exitCode?: number; worktreeState?: string }>;
			waves?: Array<{ tasks: Array<{ task?: string; exitCode?: number; worktreeState?: string }> }>;
		};
		isError?: boolean;
	}>;
}

let tool: ToolEntry;
let sessionStartHandler: ((_event: unknown, ctx: Record<string, unknown>) => Promise<void>) | undefined;
let activeCtx: Record<string, unknown>;
let captured: Array<{ message: Record<string, unknown> }>;
let agentsById: Map<string, Record<string, unknown>>;
let sessionEntries: Array<Record<string, unknown>>;

function makeCtx(cwd: string): Record<string, unknown> {
	return {
		cwd,
		model: GLOBAL_MODEL,
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === GLOBAL_MODEL.provider && id === GLOBAL_MODEL.id ? { provider, id } : undefined,
			hasConfiguredAuth: () => true,
		},
		getSystemPrompt: () => "You are a helpful assistant.",
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: {
			getEntries: () => sessionEntries,
			appendCustomEntry: () => {},
		},
		hasUI: false,
	};
}

function setupExtension(): void {
	const registered = new Map<string, ToolEntry>();
	const mockPi = {
		registerTool: (t: ToolEntry) => registered.set(t.name, t),
		registerCommand: () => {},
		registerShortcut: () => {},
		on: (event: string, handler: (_event: unknown, ctx: Record<string, unknown>) => Promise<void>) => {
			if (event === "session_start") sessionStartHandler = handler;
		},
		appendEntry: () => {},
		sendMessage: (message: Record<string, unknown>) => captured.push({ message }),
		ctx: { getState: () => undefined, setState: () => {} },
	};
	initExtension(mockPi as never);
	const entry = registered.get("delegate_task");
	if (!entry) throw new Error("delegate_task tool not registered");
	tool = entry;
}

function makeResult(overrides: Partial<SubagentResult> = {}): SubagentResult {
	return {
		messages: [{ role: "assistant", content: [{ type: "text", text: "done" }] }],
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 0, turns: 1 },
		exitCode: 0,
		stderr: "",
		model: `${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`,
		stopReason: "end_turn",
		errorCategory: "unknown",
		...overrides,
	};
}

function text(result: { content: Array<{ text: string }> }): string {
	return result.content[0].text;
}

/** The block a text carries, or undefined — the block's presence is the assertion. */
function blockOf(text: string): string | undefined {
	const at = text.indexOf(HEADING);
	return at === -1 ? undefined : text.slice(at);
}

/** Flush the wake's dynamic import + delivery (the import needs a macrotask turn). */
async function flush(): Promise<void> {
	await vi.advanceTimersByTimeAsync(0);
	for (let i = 0; i < 8; i++) await Promise.resolve();
}

/** The agent record the wake reads, plus its terminal run entry. */
function settleBackground(
	agentId: string,
	agent: Record<string, unknown>,
	run: Partial<SubagentRun>,
): void {
	agentsById.set(agentId, { id: agentId, ...agent });
	sessionEntries.push({
		type: "custom",
		customType: CUSTOM_ENTRY_TYPES.run,
		data: {
			id: agentId,
			task: "background task",
			status: "failed",
			model: "test/test-model",
			thinkingLevel: "medium",
			startedAt: new Date(1700000000000).toISOString(),
			finishedAt: new Date(1700000001000).toISOString(),
			durationMs: 1000,
			errorCategory: "exit_error",
			errorMessage: "step died",
			...run,
		},
	});
}

/** The `subagent-completion` payloads the wake delivered. */
function completionMessages(): Record<string, unknown>[] {
	return captured.filter((c) => c.message.customType === "subagent-completion").map((c) => c.message);
}

/** Repo A — the dispatch cwd; repo B — a unit's own cwd. */
let repoA: string;
let repoB: string;
const scratch: string[] = [];

beforeAll(async () => {
	env.setUp();
	setupExtension();
	if (!GIT_OK) return;
	repoA = await createTempGitRepo("brl-474-a-");
	scratch.push(repoA);
	repoB = await createTempGitRepo("brl-474-b-");
	scratch.push(repoB);
	// Repo A: dirty (one modified, one untracked). Repo B: a different branch,
	// one staged change and nothing dirty — so a block naming "unit-branch" can
	// only have come from repo B, and one naming "main" only from repo A.
	// `.pi/` is ignored because the extension really logs into the dispatch cwd;
	// ignoring it (as every real project does) keeps the counts about the files
	// the test authored.
	await writeFile(`${repoA}/.gitignore`, ".pi/\n");
	gitRun(repoA, ["add", ".gitignore"]);
	gitRun(repoA, ["commit", "-q", "-m", "ignore the runtime store"]);
	await writeFile(`${repoA}/base.txt`, "edited\n");
	await writeFile(`${repoA}/scratch.txt`, "untracked\n");
	gitRun(repoB, ["checkout", "-q", "-b", "unit-branch"]);
	await writeFile(`${repoB}/staged.txt`, "staged\n");
	gitRun(repoB, ["add", "staged.txt"]);
});

beforeEach(() => {
	captured = [];
	agentsById = new Map();
	sessionEntries = [];
	__resetTerminalClaims();
	h.runSubagent.mockReset().mockImplementation(async () => makeResult());
	h.getPiInvocation.mockReset().mockReturnValue({ command: process.execPath, args: [] });
	h.spawnBackgroundSession.mockReset();
	h.getAgent.mockReset().mockImplementation((id: string) => agentsById.get(id) ?? null);
	activeCtx = makeCtx(repoA ?? env.testCwd);
	if (sessionStartHandler) void sessionStartHandler({}, activeCtx);
});

afterEach(() => {
	vi.useRealTimers();
	vi.restoreAllMocks();
});

afterAll(async () => {
	await env.tearDown();
	for (const dir of scratch) await rm(dir, { recursive: true, force: true });
});

describe.skipIf(!GIT_OK)("issue #474 — settled-failure surfaces", () => {
	it("T1 — a foreground CRASH carries the block, with the real counts", async () => {
		// Mutant killed: omitting the append from buildCrashResult (the one crash
		// seam) — this is the path every crash takes.
		h.runSubagent.mockRejectedValue(new Error("writeToTempFile failed"));

		const result = await tool.execute("call-474-t1", { task: "single step" }, undefined, undefined, activeCtx);
		const body = text(result);

		expect(result.isError).toBe(true);
		expect(body.startsWith("Subagent crashed: writeToTempFile failed\n\n")).toBe(true);
		const block = blockOf(body);
		expect(block).toContain("  branch: main");
		expect(block).toContain("  dirty:  2 files"); // modified base.txt + untracked scratch.txt
		expect(block).toContain("  staged: 0");
		expect(block).toContain("inspect before reusing.");
	});

	it("T2 — a foreground CLASSIFIED failure (no throw) carries the block", async () => {
		// Mutant killed: omitting the append from the isSubagentError exit. This
		// run does not crash — it settles exitCode 1 and returns isError.
		h.runSubagent.mockResolvedValue(makeResult({ exitCode: 1, errorMessage: "step died", stopReason: "error" }));

		const result = await tool.execute("call-474-t2", { task: "single step" }, undefined, undefined, activeCtx);
		const body = text(result);

		expect(result.isError).toBe(true);
		expect(body.startsWith("Subagent failed: step died")).toBe(true);
		// Appended LAST: the cause (and any H1 warnings) read first.
		expect(blockOf(body)).toContain("  dirty:  2 files");
	});

	it("T3 — a successful run carries no block at all", async () => {
		// Mutant killed: appending unconditionally makes every success noisy.
		const single = await tool.execute("call-474-t3a", { task: "single step" }, undefined, undefined, activeCtx);
		expect(text(single)).not.toContain(HEADING);

		const batch = await tool.execute(
			"call-474-t3b",
			{ chain: [{ task: "step one" }, { task: "step two" }] },
			undefined,
			undefined,
			activeCtx,
		);
		expect(text(batch)).not.toContain(HEADING);
		expect(batch.details?.results?.every((r) => r.worktreeState === undefined)).toBe(true);
	});

	it("T4 — a failed batch unit reports ITS OWN cwd, not the dispatch cwd", async () => {
		// Step 2 declares repoB; step 1 runs in the dispatch cwd (repoA).
		// Mutant killed: probing the mode cwd would report "branch: main".
		h.runSubagent.mockImplementation(async (_cwd: string, _prompt: string, _model: unknown, _level: unknown, task: string) =>
			task.includes("step two")
				? makeResult({ exitCode: 1, errorMessage: "step died", stopReason: "error" })
				: makeResult(),
		);

		const result = await tool.execute(
			"call-474-t4",
			{ chain: [{ task: "step one" }, { task: "step two", cwd: repoB }] },
			undefined,
			undefined,
			activeCtx,
		);

		const results = result.details?.results ?? [];
		expect(results).toHaveLength(2);
		expect(results[0].worktreeState).toBeUndefined(); // the successful step carries nothing
		const unitBlock = results[1].worktreeState ?? "";
		expect(unitBlock).toContain("  branch: unit-branch");
		expect(unitBlock).toContain("  staged: 1");
		expect(unitBlock).toContain("  dirty:  0 files");
	});

	it("T4b — a CRASHED batch unit carries its own block past the mode's outer catch", async () => {
		// The mode catch only knows the dispatch cwd; `finalizeUnitRunCrash`
		// attaches the unit's block to the rethrown error and buildCrashResult
		// prefers it. Mutant killed: preferring the mode cwd reports "branch: main".
		h.runSubagent.mockImplementation(async (_cwd: string, _prompt: string, _model: unknown, _level: unknown, task: string) => {
			if (task.includes("step two")) throw new Error("writeToTempFile failed");
			return makeResult();
		});

		const result = await tool.execute(
			"call-474-t4b",
			{ chain: [{ task: "step one" }, { task: "step two", cwd: repoB }] },
			undefined,
			undefined,
			activeCtx,
		);
		const body = text(result);

		expect(result.isError).toBe(true);
		expect(body.startsWith("Chain mode crashed: writeToTempFile failed")).toBe(true);
		const block = blockOf(body);
		expect(block).toContain("  branch: unit-branch");
		expect(block).not.toContain("branch: main");
	});

	it("T5 — a REJECTED unit keeps a row (own cwd, own block) instead of vanishing", async () => {
		// Mutant killed: the allSettled branch that only logs. Before #474 this
		// aggregate held one row and the crashed task left no trace but a log line.
		h.runSubagent.mockImplementation(async (_cwd: string, _prompt: string, _model: unknown, _level: unknown, task: string) => {
			if (task.includes("boom")) throw new Error("writeToTempFile failed");
			return makeResult();
		});

		const result = await tool.execute(
			"call-474-t5",
			{ tasks: [{ task: "fine task" }, { task: "boom task", cwd: repoB }] },
			undefined,
			undefined,
			activeCtx,
		);

		const rows = result.details?.results ?? [];
		expect(rows).toHaveLength(2);
		const failedRow = rows.find((r) => r.task === "boom task");
		expect(failedRow?.exitCode).toBe(1);
		expect(failedRow?.worktreeState).toContain("  branch: unit-branch");
		expect(rows.find((r) => r.task === "fine task")?.worktreeState).toBeUndefined();
	});
});

describe("issue #474 — the background wake", () => {
	it("T6 — a failed wake carries the block before the directive; a completed one does not", async () => {
		vi.useFakeTimers();
		const cwd = repoA ?? env.testCwd;
		settleBackground("bg-474-failed", { status: "failed", cwd, error: "step died", finalOutput: "step died" }, {});

		eventBus.emit(eventBus.createEvent("subagent:failed", "bg-474-failed", { error: "step died" }));
		await flush();

		const failed = completionMessages();
		expect(failed).toHaveLength(1);
		const content = String(failed[0].content);
		expect(content).toContain(HEADING);
		expect(failed[0].details).toMatchObject({ id: "bg-474-failed", status: "failed" });
		// The directive stays LAST: the block is inserted before it, never after.
		expect(content).toContain("inspect before reusing.\n\nProcess this completion silently");
	});

	it("T7 — the #179 completed-to-failed downgrade is classified BEFORE the gate", async () => {
		vi.useFakeTimers();
		const cwd = repoA ?? env.testCwd;
		// `agent.status` says completed; the run record says the turn errored. The
		// wake is delivered as a FAILURE, so it must carry the block — gating on
		// `agent.status` here (the mutant) would silently drop it.
		settleBackground("bg-474-downgraded", { status: "completed", cwd }, { stopReason: "error", status: "failed" });

		eventBus.emit(eventBus.createEvent("subagent:failed", "bg-474-downgraded", { error: "step died" }));
		await flush();

		const messages = completionMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0].details).toMatchObject({ status: "failed" });
		expect(String(messages[0].content)).toContain(HEADING);
	});

	it("T8 — a genuinely completed wake is untouched", async () => {
		vi.useFakeTimers();
		settleBackground(
			"bg-474-done",
			{ status: "completed", cwd: repoA ?? env.testCwd, finalOutput: "all good" },
			{ status: "done", stopReason: "stop", errorCategory: "success", errorMessage: undefined },
		);

		eventBus.emit(eventBus.createEvent("subagent:completed", "bg-474-done", {}));
		await flush();

		const messages = completionMessages();
		expect(messages).toHaveLength(1);
		expect(messages[0].details).toMatchObject({ status: "completed" });
		expect(String(messages[0].content)).not.toContain(HEADING);
	});

	it("T9 — an old record with no stamped cwd reports unavailable, never a relative guess", async () => {
		vi.useFakeTimers();
		// A pre-#474 agent record has no `cwd`. Its retry snapshot may hold a
		// RELATIVE value; resolving that against this process's cwd would report
		// a tree the run never touched, so it is refused by name.
		settleBackground(
			"bg-474-legacy",
			{ status: "failed", error: "step died", finalOutput: "step died" },
			{ originalParams: { cwd: "relative/project" } as unknown as SubagentRun["originalParams"] },
		);

		eventBus.emit(eventBus.createEvent("subagent:failed", "bg-474-legacy", { error: "step died" }));
		await flush();

		const messages = completionMessages();
		expect(messages).toHaveLength(1);
		expect(String(messages[0].content)).toContain("state: unavailable (no recorded cwd)");
	});
});

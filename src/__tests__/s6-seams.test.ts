/**
 * Issue #430 (S6) — behavioural tests for the extracted `delegate_task` seams.
 *
 * The seams are PRIVATE to `src/delegate-handler.ts` on purpose (ADR 0027 D7):
 * nothing outside the file may depend on one. So every test here drives the
 * tool definition the composition root actually registers — `createDelegateHandler`
 * with fakes — and asserts what a seam DECIDES by observing the dispatch:
 * what reaches the injected runner, what is returned to the caller, what is
 * emitted to the LLM/human.
 *
 * Seam A (normalizeInput) and seam B (resolveShape) are reachable on the
 * background-spawn path without spawning anything: a single-task dispatch with
 * `background: true` routes to the injected `spawnBackgroundRun`, which is the
 * point where the resolved params become observable. Tests that need the
 * FOREGROUND path live in the later describes.
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createDelegateHandler, type DelegateHandlerDeps } from "../delegate-handler";
import { SessionState } from "../state";
import { __setRegistryDir } from "../run-registry";
import { __setOutputDir } from "../transcript";
import {
	CUSTOM_ENTRY_TYPES,
	MAX_CHAIN_STEPS,
	MAX_PARALLEL_TASKS,
	type SubagentRun,
	type TaskTemplate,
} from "../types";

/**
 * The runner is the only subprocess seam the foreground path has. Its
 * `getPiInvocation` is also what the REAL preflight check resolves, so this
 * mock is what makes the foreground path runnable without a `pi` binary:
 * an executable command satisfies `checkPiBinary`.
 */
const runner = vi.hoisted(() => ({
	runSubagent: vi.fn(),
	getPiInvocation: vi.fn(() => ({ command: process.execPath, args: [] as string[] })),
}));
vi.mock("../runner", () => ({
	runSubagent: runner.runSubagent,
	getPiInvocation: runner.getPiInvocation,
	cleanupTempDirs: vi.fn(async () => 0),
	reapActiveChildren: vi.fn(async () => []),
	accumulateUsage: vi.fn(),
	parseSubagentLine: vi.fn(),
}));

vi.mock("@earendil-works/pi-tui", () => {
	class Container {}
	class SelectList {}
	class Spacer {}
	class Text {}
	class Markdown {}
	return { Container, SelectList, Spacer, Text, Markdown };
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_MODEL = { provider: "test", id: "test-model" };
const workdir = mkdtempSync(join(tmpdir(), "brl-s6-seams-"));
/** The durable registry + the transcript dir, redirected out of the repo. */
const registryDir = mkdtempSync(join(tmpdir(), "brl-s6-seams-registry-"));
const transcriptDir = mkdtempSync(join(tmpdir(), "brl-s6-seams-transcript-"));
beforeEach(() => {
	__setRegistryDir(registryDir);
	__setOutputDir(transcriptDir);
});
afterAll(() => {
	__setRegistryDir(undefined);
	__setOutputDir(undefined);
	rmSync(workdir, { recursive: true, force: true });
	rmSync(registryDir, { recursive: true, force: true });
	rmSync(transcriptDir, { recursive: true, force: true });
});

interface SentMessage {
	customType?: string;
	content: string;
	details?: unknown;
}

interface Harness {
	tool: ReturnType<typeof createDelegateHandler>;
	state: SessionState;
	pi: ExtensionAPI;
	sent: SentMessage[];
	notifies: Array<{ message: string; level: string }>;
	warns: Array<{ message: string; data?: Record<string, unknown> }>;
	infos: Array<{ message: string; data?: Record<string, unknown> }>;
	deps: {
		runChainMode: ReturnType<typeof vi.fn>;
		runParallelMode: ReturnType<typeof vi.fn>;
		runGraphMode: ReturnType<typeof vi.fn>;
		runBackgroundFanOut: ReturnType<typeof vi.fn>;
		spawnBackgroundRun: ReturnType<typeof vi.fn>;
		visibleRunsFor: ReturnType<typeof vi.fn>;
	};
}

const okResult = (text: string) => ({
	content: [{ type: "text" as const, text }],
	details: undefined,
});

/** What the mocked `runSubagent` returns: a successful child result. */
function childResult(text = "child output") {
	return {
		messages: [{ role: "assistant", content: [{ type: "text", text }] }],
		usage: { input: 4, output: 2, cost: 0.001 },
		exitCode: 0,
		stderr: "",
	};
}

beforeEach(() => {
	runner.runSubagent.mockResolvedValue(childResult());
});

function makeHarness(): Harness {
	const sent: SentMessage[] = [];
	const notifies: Array<{ message: string; level: string }> = [];
	activeNotifies = notifies;
	const warns: Array<{ message: string; data?: Record<string, unknown> }> = [];
	const infos: Array<{ message: string; data?: Record<string, unknown> }> = [];
	const pi = {
		sendMessage: (msg: SentMessage) => {
			sent.push(msg);
		},
		appendEntry: () => {},
	} as unknown as ExtensionAPI;
	const log = {
		debug: () => {},
		info: (message: string, data?: Record<string, unknown>) => {
			infos.push({ message, data });
		},
		warn: (message: string, data?: Record<string, unknown>) => {
			warns.push({ message, data });
		},
		error: () => {},
	};
	const state = new SessionState(log as never);
	state.config.gitMode = "none";

	const deps = {
		runChainMode: vi.fn(async () => okResult("chain")),
		runParallelMode: vi.fn(async () => okResult("parallel")),
		runGraphMode: vi.fn(async () => okResult("graph")),
		runBackgroundFanOut: vi.fn(async () => okResult("fan-out")),
		spawnBackgroundRun: vi.fn(async () => okResult("background")),
		visibleRunsFor: vi.fn(() => []),
	};
	const tool = createDelegateHandler(
		{ pi, log: log as never, state },
		deps as unknown as DelegateHandlerDeps,
	);
	return { tool, state, pi, sent, notifies, warns, infos, deps };
}

/** The notification sink of the CURRENT test's harness (set by makeHarness). */
let activeNotifies: Array<{ message: string; level: string }> = [];

function makeCtx(entries: unknown[] = []): ExtensionContext {
	return {
		cwd: workdir,
		model: GLOBAL_MODEL,
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === GLOBAL_MODEL.provider && id === GLOBAL_MODEL.id
					? { provider, id }
					: undefined,
			hasConfiguredAuth: () => true,
		},
		getSystemPrompt: () => "SYSTEM",
		ui: {
			notify: (message: string, level: string) => {
				activeNotifies.push({ message, level });
			},
			setStatus: () => {},
			theme: { fg: (_c: string, t: string) => t },
		},
		sessionManager: { getEntries: () => entries, appendCustomEntry: () => {} },
		hasUI: false,
	} as unknown as ExtensionContext;
}

/**
 * A cwd whose package.json opts into the umbrella `processChecks` flag
 * (ADR 0019) — the #412 pre-flight's gate. One directory per call so a test
 * cannot leak the flag into another.
 */
function processChecksCwd(name: string): string {
	const dir = join(workdir, name);
	mkdirSync(dir, { recursive: true });
	writeFileSync(
		join(dir, "package.json"),
		JSON.stringify({ name, "brl-subagent": { processChecks: true } }),
	);
	return dir;
}

/** The ctx for a specific cwd (the pre-flight reads the manifest at dispatch cwd). */
function ctxAt(cwd: string, entries: unknown[] = []): ExtensionContext {
	const ctx = makeCtx(entries) as unknown as { cwd: string };
	ctx.cwd = cwd;
	return ctx as unknown as ExtensionContext;
}

/** The timeout the child was spawned with (arg 9 of runSubagent). */
function runnerTimeout(): number | undefined {
	return runner.runSubagent.mock.calls[0][8] as number | undefined;
}

/** The task the child was spawned with (arg 5 of runSubagent). */
function runnerTask(): string | undefined {
	return runner.runSubagent.mock.calls[0][4] as string | undefined;
}

const textOf = (result: { content: Array<{ type: string; text?: string }> }): string =>
	result.content.map((part) => part.text ?? "").join("");

/** The params the background spawn received — where A/B become observable. */
function spawnedParams(h: Harness): Record<string, unknown> {
	return h.deps.spawnBackgroundRun.mock.calls[0][2] as Record<string, unknown>;
}

const TEMPLATE: TaskTemplate = {
	name: "review",
	task: "Review ${target}",
	description: "review something",
	outputFile: "out.md",
	timeout: 1234,
};

/** The run record's spawn entry, as session lookup expects it. */
function recordedRun(overrides: Partial<SubagentRun> = {}): SubagentRun {
	return {
		id: "11111111-1111-4111-8111-111111111111",
		task: "original task",
		label: "recorded-label",
		status: "failed",
		startedAt: new Date(Date.now() - 5_000).toISOString(),
		originalParams: { task: "original task", background: true, label: "orig-label" },
		...overrides,
	} as SubagentRun;
}

function withEntry(run: SubagentRun): unknown[] {
	return [{ type: "custom", customType: CUSTOM_ENTRY_TYPES.run, data: run }];
}

beforeEach(() => {
	vi.clearAllMocks();
	runner.runSubagent.mockResolvedValue(childResult());
});

// ---------------------------------------------------------------------------
// Seam A — normalizeInput
// ---------------------------------------------------------------------------

describe("seam A — template resolution", () => {
	it("names the available templates when the requested one is missing, and dispatches nothing", async () => {
		const h = makeHarness();
		const result = await h.tool.execute("call-a", { template: "nope", task: "unused" } as never, undefined, undefined, makeCtx());

		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe("Template 'nope' not found. Available: none");
		expect(h.deps.spawnBackgroundRun).not.toHaveBeenCalled();
		expect(h.deps.runChainMode).not.toHaveBeenCalled();
	});

	it("reports a resolution failure for a template with an unsupplied slot", async () => {
		const h = makeHarness();
		h.state.config.templates = [TEMPLATE];
		const result = await h.tool.execute("call-a", { template: "review" } as never, undefined, undefined, makeCtx());

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Template 'review' resolution failed:");
		expect(h.deps.spawnBackgroundRun).not.toHaveBeenCalled();
	});

	it("is template-wins: the resolved body replaces a supplied task, and warns when that task was invalid", async () => {
		const h = makeHarness();
		h.state.config.templates = [TEMPLATE];
		const result = await h.tool.execute(
			"call-a",
			{ template: "review", task: "", params: { target: "the diff" }, background: true } as never,
			undefined,
			undefined,
			makeCtx(),
		);

		expect(result.isError).toBeFalsy();
		expect(spawnedParams(h).task).toBe("Review the diff");
		// The ignored task was rejected by the sanitizer, so both channels spoke.
		const warning = h.sent.find((m) => m.content.includes("the supplied 'task' was ignored"));
		expect(warning).toBeDefined();
		expect(warning!.details).toEqual({
			template: "review",
			rejectedTask: "Task must not be empty.",
		});
		expect(h.warns.some((w) => w.message.includes("supplied task ignored"))).toBe(true);
	});

	it("stays silent about the supplied task when it would itself have passed sanitization", async () => {
		const h = makeHarness();
		h.state.config.templates = [TEMPLATE];
		await h.tool.execute(
			"call-a",
			{ template: "review", task: "a perfectly fine task", params: { target: "x" }, background: true } as never,
			undefined,
			undefined,
			makeCtx(),
		);

		expect(h.sent.filter((m) => m.content.includes("ignored"))).toHaveLength(0);
		expect(spawnedParams(h).task).toBe("Review x");
	});

	it("fills only the template defaults the caller left unset", async () => {
		const h = makeHarness();
		h.state.config.templates = [TEMPLATE];
		await h.tool.execute(
			"call-a",
			{
				template: "review",
				params: { target: "x" },
				background: true,
				outputFile: "explicit.md",
				timeout: 99,
			} as never,
			undefined,
			undefined,
			makeCtx(),
		);

		const params = spawnedParams(h);
		expect(params.outputFile).toBe("explicit.md");
		expect(params.timeout).toBe(99);
	});
});

describe("seam A — retry restore", () => {
	it("resolves a retry from the session entry without touching the visibility bridge", async () => {
		const h = makeHarness();
		const source = recordedRun();
		await h.tool.execute(
			"call-a",
			{ retryRunId: source.id } as never,
			undefined,
			undefined,
			makeCtx(withEntry(source)),
		);

		// The recorded body won, and the S4 bridge (the fallback) was never asked.
		expect(h.deps.visibleRunsFor).not.toHaveBeenCalled();
		expect(spawnedParams(h).task).toBe("original task");
		expect(spawnedParams(h).label).toBe("recorded-label");
		expect(spawnedParams(h).background).toBe(true);
	});

	it("falls back through the visibility bridge when only the durable registry has the run", async () => {
		const h = makeHarness();
		const source = recordedRun();
		h.deps.visibleRunsFor.mockReturnValue([source]);

		await h.tool.execute("call-a", { retryRunId: source.id } as never, undefined, undefined, makeCtx());

		expect(h.deps.visibleRunsFor).toHaveBeenCalledTimes(1);
		expect(spawnedParams(h).task).toBe("original task");
	});

	it("rejects an unknown retry id only after BOTH lookups missed", async () => {
		const h = makeHarness();
		const result = await h.tool.execute("call-a", { retryRunId: "missing-id" } as never, undefined, undefined, makeCtx());

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Retry run ID not found: missing-id.");
		expect(h.deps.visibleRunsFor).toHaveBeenCalledTimes(1);
		expect(h.warns.some((w) => w.message === "Retry run ID not found")).toBe(true);
		expect(h.deps.spawnBackgroundRun).not.toHaveBeenCalled();
	});

	it("resolves a template BEFORE the retry drops it (issue #175 ordering)", async () => {
		const h = makeHarness();
		h.state.config.templates = [TEMPLATE];
		const source = recordedRun();

		// The template's `outputFile`/`timeout` defaults must survive
		// `resolveRetryParams` (which returns a fresh object) — proving the
		// template ran first. The template body wins over the recorded task
		// because `resolveRetryParams` prefers an explicit `params.task`
		// (issue #175: "resolving templates first keeps a combined template +
		// retryRunId call from silently disabling template resolution").
		await h.tool.execute(
			"call-a",
			{ template: "review", params: { target: "x" }, retryRunId: source.id } as never,
			undefined,
			undefined,
			makeCtx(withEntry(source)),
		);

		const params = spawnedParams(h);
		expect(params.task).toBe("Review x");
		expect(params.outputFile).toBe("out.md");
		expect(params.timeout).toBe(1234);
	});

	it("still reports a missing template on a combined template + retry call", async () => {
		const h = makeHarness();
		const source = recordedRun();
		const result = await h.tool.execute(
			"call-a",
			{ template: "absent", retryRunId: source.id } as never,
			undefined,
			undefined,
			makeCtx(withEntry(source)),
		);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe("Template 'absent' not found. Available: none");
	});
});

describe("seam A — unknown params", () => {
	it("warns through both channels and still dispatches", async () => {
		const h = makeHarness();
		const result = await h.tool.execute(
			"call-a",
			{ task: "do it", thinkinglevel: "high", background: true } as never,
			undefined,
			undefined,
			makeCtx(),
		);

		expect(result.isError).toBeFalsy();
		const warning = h.sent.find((m) => m.content.includes("unknown param(s) ignored"));
		expect(warning).toBeDefined();
		expect(warning!.details).toEqual({ unknown: ["thinkinglevel"] });
		expect(h.warns.some((w) => w.message.includes("unknown param(s) ignored"))).toBe(true);
		expect(h.deps.spawnBackgroundRun).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// Seam B — resolveShape
// ---------------------------------------------------------------------------

describe("seam B — sanitize + shape", () => {
	it("rejects an empty task before any runner is reached", async () => {
		const h = makeHarness();
		const result = await h.tool.execute("call-b", {} as never, undefined, undefined, makeCtx());

		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe("Invalid task: Task must not be empty.");
		for (const dep of Object.values(h.deps)) expect(dep).not.toHaveBeenCalled();
	});

	it("rejects a whitespace-only task through the same path", async () => {
		const h = makeHarness();
		const result = await h.tool.execute("call-b", { task: "   \n\t " } as never, undefined, undefined, makeCtx());

		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe("Invalid task: Task must not be empty.");
	});

	it("rejects a dispatch naming two shapes", async () => {
		const conflicts: Array<[string, unknown]> = [
			["task + chain", { task: "one", chain: [{ task: "two" }] }],
			["task + tasks", { task: "one", tasks: [{ task: "two" }] }],
			["chain + graph", { chain: [{ task: "two" }], graph: [{ id: "g", task: "three" }] }],
		];
		for (const [label, params] of conflicts) {
			const h = makeHarness();
			const result = await h.tool.execute("call-b", params as never, undefined, undefined, makeCtx());

			expect(result.isError, label).toBe(true);
			expect(textOf(result), label).toContain("Provide exactly one of:");
			for (const dep of Object.values(h.deps)) expect(dep, label).not.toHaveBeenCalled();
		}
	});

	it("skips the single-task sanitizer for a batch shape with no top-level task", async () => {
		const h = makeHarness();
		const result = await h.tool.execute(
			"call-b",
			{ chain: [{ task: "a" }, { task: "b" }] } as never,
			undefined,
			undefined,
			makeCtx(),
		);

		expect(result.isError).toBeFalsy();
		expect(h.deps.runChainMode).toHaveBeenCalledTimes(1);
	});

	it("hands the runner the SANITIZED task, not the raw one", async () => {
		const h = makeHarness();
		await h.tool.execute("call-b", { task: "   padded task   ", background: true } as never, undefined, undefined, makeCtx());

		expect(spawnedParams(h).task).toBe("padded task");
	});

	it("classifies each shape to exactly one runner", async () => {
		const cases: Array<[unknown, "runChainMode" | "runParallelMode" | "runGraphMode"]> = [
			[{ chain: [{ task: "a" }] }, "runChainMode"],
			[{ tasks: [{ task: "a" }], background: false }, "runParallelMode"],
			[{ graph: [{ id: "a", task: "a" }] }, "runGraphMode"],
		];
		for (const [params, expected] of cases) {
			const h = makeHarness();
			await h.tool.execute("call-b", params as never, undefined, undefined, makeCtx());
			expect(h.deps[expected], `${JSON.stringify(params)} → ${expected}`).toHaveBeenCalledTimes(1);
			for (const [name, dep] of Object.entries(h.deps)) {
				if (name !== expected && name !== "visibleRunsFor") expect(dep).not.toHaveBeenCalled();
			}
		}
	});
});

// ---------------------------------------------------------------------------
// Seam C — prepareShape (the #412 pre-flight, the background default, #434)
// ---------------------------------------------------------------------------

describe("seam C — the #412 dispatch pre-flight", () => {
	it("switches a high-thinking explicit-foreground dispatch to background and drops its deadline", async () => {
		const h = makeHarness();
		const ctx = ctxAt(processChecksCwd("switch"));
		const result = await h.tool.execute(
			"call-c",
			{
				task: "summarize the design notes",
				thinkingLevel: "high",
				timeout: 5_000,
				background: false,
				approvalMode: "auto",
			} as never,
			undefined,
			undefined,
			ctx,
		);

		expect(result.isError).toBeFalsy();
		// The shape MOVED: the injected background spawn is the one that ran.
		expect(h.deps.spawnBackgroundRun).toHaveBeenCalledTimes(1);
		expect(runner.runSubagent).not.toHaveBeenCalled();
		// ... and the deadline was dropped, not carried into the background run.
		const spawned = spawnedParams(h);
		expect(spawned.background).toBe(true);
		expect(spawned.timeout).toBeUndefined();
		// The caller was told, on both channels.
		expect(h.sent.some((m) => m.content.includes("now background"))).toBe(true);
		expect(h.notifies.some((n) => n.message.includes("now background"))).toBe(true);
	});

	it("keeps the shape and drops only the deadline when the approval mode forbids background (#431)", async () => {
		const h = makeHarness();
		const ctx = ctxAt(processChecksCwd("drop-timeout"));
		const result = await h.tool.execute(
			"call-c",
			{
				task: "summarize the design notes",
				thinkingLevel: "high",
				timeout: 5_000,
				background: false,
				approvalMode: "always",
				// The project opts into the process checks, so the foreground path
				// needs the Jev line bypass to reach the runner at all.
				noJev: "s6 seam test",
			} as never,
			undefined,
			undefined,
			ctx,
		);

		expect(result.isError).toBeFalsy();
		expect(h.deps.spawnBackgroundRun).not.toHaveBeenCalled();
		expect(runner.runSubagent).toHaveBeenCalledTimes(1);
		// The date was dropped on the FOREGROUND run — the child got no timeout.
		expect(runnerTimeout()).toBeUndefined();
		// The #431 notice, not the #412 switch notice.
		expect(h.sent.some((m) => m.content.includes("stays FOREGROUND"))).toBe(true);
		expect(h.sent.some((m) => m.content.includes("now background"))).toBe(false);
	});

	it("does not touch a high-thinking dispatch when the project has not opted in", async () => {
		const h = makeHarness();
		const result = await h.tool.execute(
			"call-c",
			{
				task: "summarize the design notes",
				thinkingLevel: "high",
				timeout: 5_000,
				background: false,
			} as never,
			undefined,
			undefined,
			makeCtx(),
		);

		expect(result.isError).toBeFalsy();
		expect(runnerTimeout()).toBe(5_000);
		expect(h.sent).toHaveLength(0);
	});

	it("records the override instead of switching when force is set", async () => {
		const h = makeHarness();
		const ctx = ctxAt(processChecksCwd("forced"));
		const result = await h.tool.execute(
			"call-c",
			{
				task: "summarize the design notes",
				thinkingLevel: "high",
				timeout: 5_000,
				background: false,
				approvalMode: "auto",
				force: true,
				noJev: "s6 seam test",
			} as never,
			undefined,
			undefined,
			ctx,
		);

		expect(result.isError).toBeFalsy();
		expect(runnerTimeout()).toBe(5_000);
		expect(h.sent).toHaveLength(0);
		expect(h.infos.some((i) => i.message.includes("forced"))).toBe(true);
	});

	it("rejects a declared thinking level outside the vocabulary before any run record", async () => {
		const h = makeHarness();
		const result = await h.tool.execute(
			"call-c",
			{ task: "summarize the design notes", thinkingLevel: "High" } as never,
			undefined,
			undefined,
			makeCtx(),
		);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("Invalid thinkingLevel");
		expect(textOf(result)).toContain("matched exactly");
		expect(runner.runSubagent).not.toHaveBeenCalled();
		expect(h.deps.spawnBackgroundRun).not.toHaveBeenCalled();
	});
});

describe("seam C — the background default and the batch guard", () => {
	it("rejects an EXPLICIT background: true chain", async () => {
		const h = makeHarness();
		const result = await h.tool.execute(
			"call-c",
			{ chain: [{ task: "a" }], background: true } as never,
			undefined,
			undefined,
			makeCtx(),
		);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("background: true is not supported with chain");
		expect(h.deps.runChainMode).not.toHaveBeenCalled();
		expect(h.deps.runBackgroundFanOut).not.toHaveBeenCalled();
	});

	it("lets an OMITTED background chain run foreground — the guard judges the caller, not the default", async () => {
		const h = makeHarness();
		const result = await h.tool.execute(
			"call-c",
			{ chain: [{ task: "a" }], approvalMode: "auto" } as never,
			undefined,
			undefined,
			makeCtx(),
		);

		expect(result.isError).toBeFalsy();
		expect(h.deps.runChainMode).toHaveBeenCalledTimes(1);
	});

	it("defaults an omitted background only when the effective approval mode is auto", async () => {
		const background = makeHarness();
		await background.tool.execute(
			"call-c",
			{ task: "summarize the design notes", approvalMode: "auto" } as never,
			undefined,
			undefined,
			makeCtx(),
		);
		expect(background.deps.spawnBackgroundRun).toHaveBeenCalledTimes(1);
		expect(background.deps.spawnBackgroundRun.mock.calls[0][2]).toMatchObject({ background: true });

		const foreground = makeHarness();
		await foreground.tool.execute(
			"call-c",
			{ task: "summarize the design notes", approvalMode: "writes" } as never,
			undefined,
			undefined,
			makeCtx(),
		);
		expect(foreground.deps.spawnBackgroundRun).not.toHaveBeenCalled();
		expect(runner.runSubagent).toHaveBeenCalledTimes(1);
	});

	it("hands the batch runners the #434 unit projection, resolved once per dispatch", async () => {
		const chain = makeHarness();
		await chain.tool.execute(
			"call-c",
			{ chain: [{ task: "a" }], thinkingLevel: "high", force: true } as never,
			undefined,
			undefined,
			ctxAt(processChecksCwd("batch-guard-chain")),
		);
		expect(chain.deps.runChainMode.mock.calls[0][4]).toEqual({
			processChecks: true,
			dispatchDeclaredLevel: "high",
			force: true,
			unitShape: "foreground",
			noticeEmitted: false,
		});

		const fanOut = makeHarness();
		await fanOut.tool.execute(
			"call-c",
			{ tasks: [{ task: "a" }], background: true, force: true } as never,
			undefined,
			undefined,
			ctxAt(processChecksCwd("batch-guard-fanout")),
		);
		expect(fanOut.deps.runBackgroundFanOut.mock.calls[0][4]).toEqual({
			processChecks: true,
			dispatchDeclaredLevel: undefined,
			force: true,
			unitShape: "background",
			noticeEmitted: false,
		});
	});

	it("marks noticeEmitted when the dispatch's own arm spoke (#434 double-report guard)", async () => {
		const h = makeHarness();
		const ctx = ctxAt(processChecksCwd("batch-guard-notice"));
		// A `tasks` fan-out that the pre-flight switched: the dispatch announced
		// the change, so its units must not announce it again. The explicit
		// `background: false` is what makes the switch arm fire (an OMITTED
		// background under `auto` already defaults to the fan-out, `none` above).
		await h.tool.execute(
			"call-c",
			{
				tasks: [{ task: "a" }],
				thinkingLevel: "high",
				timeout: 5_000,
				background: false,
				approvalMode: "auto",
			} as never,
			undefined,
			undefined,
			ctx,
		);
		expect(h.deps.runBackgroundFanOut.mock.calls[0][4]).toMatchObject({
			unitShape: "background",
			noticeEmitted: true,
		});
	});
});

// ---------------------------------------------------------------------------
// Seam D — routeDispatch
// ---------------------------------------------------------------------------

describe("seam D — routing to the injected instance", () => {
	it("rejects a chain over the step limit before any runner", async () => {
		const h = makeHarness();
		const chain = Array.from({ length: MAX_CHAIN_STEPS + 1 }, (_, i) => ({ task: `step ${i}` }));
		const result = await h.tool.execute("call-d", { chain } as never, undefined, undefined, makeCtx());

		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe(`Chain exceeds max ${MAX_CHAIN_STEPS} steps.`);
		expect(h.deps.runChainMode).not.toHaveBeenCalled();
	});

	it("rejects a parallel group over the task limit before any runner", async () => {
		const h = makeHarness();
		const tasks = Array.from({ length: MAX_PARALLEL_TASKS + 1 }, (_, i) => ({ task: `task ${i}` }));
		const result = await h.tool.execute(
			"call-d",
			{ tasks, background: false } as never,
			undefined,
			undefined,
			makeCtx(),
		);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe(`Parallel exceeds max ${MAX_PARALLEL_TASKS} tasks.`);
		expect(h.deps.runParallelMode).not.toHaveBeenCalled();
		expect(h.deps.runBackgroundFanOut).not.toHaveBeenCalled();
	});

	it("calls each shape's OWN injected instance, with the dispatch params and the batch guard", async () => {
		const h = makeHarness();
		const ctx = makeCtx();
		const params = { chain: [{ task: "a" }, { task: "b" }] };
		await h.tool.execute("call-d", params as never, undefined, undefined, ctx);

		expect(h.deps.runChainMode).toHaveBeenCalledTimes(1);
		const [sentParams, sentSignal, sentUpdate, sentCtx, sentGuard] = h.deps.runChainMode.mock.calls[0];
		// Identity, not equality: the runner must see the SAME dispatch object
		// (a copy would drop the background record the pre-flight just wrote).
		expect(sentParams).toBe(params);
		expect(sentSignal).toBeUndefined();
		expect(sentUpdate).toBeUndefined();
		expect(sentCtx).toBe(ctx);
		expect(sentGuard).toMatchObject({ unitShape: "foreground", noticeEmitted: false });
	});

	it("hands the fan-out the tool's pi and ctx, and the retry source on a spawn", async () => {
		const fanOut = makeHarness();
		const ctx = makeCtx();
		await fanOut.tool.execute(
			"call-d",
			{ tasks: [{ task: "a" }], background: true } as never,
			undefined,
			undefined,
			ctx,
		);
		expect(fanOut.deps.runBackgroundFanOut.mock.calls[0][0]).toBe(fanOut.pi);
		expect(fanOut.deps.runBackgroundFanOut.mock.calls[0][1]).toBe(ctx);
		expect(fanOut.deps.runParallelMode).not.toHaveBeenCalled();

		const spawn = makeHarness();
		const source = recordedRun();
		await spawn.tool.execute(
			"call-d",
			{ retryRunId: source.id, task: "a", background: true } as never,
			undefined,
			undefined,
			makeCtx(withEntry(source)),
		);
		expect(spawn.deps.spawnBackgroundRun.mock.calls[0][0]).toBe(spawn.pi);
		// Arg 5 is the identity the retry carries into the background spawn.
		expect(spawn.deps.spawnBackgroundRun.mock.calls[0][3]).toBe("a");
	});

	it("returns the runner's promise without awaiting it for shape work", async () => {
		const h = makeHarness();
		let resolve: (value: unknown) => void = () => {};
		h.deps.runGraphMode.mockReturnValue(new Promise((r) => { resolve = r; }));
		const pending = h.tool.execute(
			"call-d",
			{ graph: [{ id: "a", task: "a" }] } as never,
			undefined,
			undefined,
			makeCtx(),
		);

		// Nothing else may run: the foreground path (cost gate, run record) must
		// stay unreached while the injected runner's promise is unsettled.
		expect(h.state.persistRun).toBeDefined();
		resolve({ content: [{ type: "text", text: "graph" }], details: undefined });
		const result = await pending;
		expect(textOf(result)).toBe("graph");
		expect(runner.runSubagent).not.toHaveBeenCalled();
	});

	it("keeps a single dispatch on the foreground path", async () => {
		const h = makeHarness();
		const result = await h.tool.execute("call-d", { task: "summarize the design notes" } as never, undefined, undefined, makeCtx());

		expect(result.isError).toBeFalsy();
		expect(h.deps.spawnBackgroundRun).not.toHaveBeenCalled();
		expect(runner.runSubagent).toHaveBeenCalledTimes(1);
		expect(runnerTask()).toBe("summarize the design notes");
	});
});

// A file the later seam describes use: proving `processChecks` is off keeps the
// #412 pre-flight deterministic in the temp cwd.
writeFileSync(join(workdir, "README.md"), "s6 seams harness\n");

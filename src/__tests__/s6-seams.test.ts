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

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createDelegateHandler, type DelegateHandlerDeps } from "../delegate-handler";
import { SessionState } from "../state";
import { CUSTOM_ENTRY_TYPES, type SubagentRun, type TaskTemplate } from "../types";

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
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

interface SentMessage {
	customType?: string;
	content: string;
	details?: unknown;
}

interface Harness {
	tool: ReturnType<typeof createDelegateHandler>;
	state: SessionState;
	sent: SentMessage[];
	warns: Array<{ message: string; data?: Record<string, unknown> }>;
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

function makeHarness(): Harness {
	const sent: SentMessage[] = [];
	const warns: Array<{ message: string; data?: Record<string, unknown> }> = [];
	const pi = {
		sendMessage: (msg: SentMessage) => {
			sent.push(msg);
		},
		appendEntry: () => {},
	} as unknown as ExtensionAPI;
	const log = {
		debug: () => {},
		info: () => {},
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
	return { tool, state, sent, warns, deps };
}

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
		ui: { notify: () => {}, setStatus: () => {}, theme: { fg: (_c: string, t: string) => t } },
		sessionManager: { getEntries: () => entries, appendCustomEntry: () => {} },
		hasUI: false,
	} as unknown as ExtensionContext;
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

// A file the later seam describes use: proving `processChecks` is off keeps the
// #412 pre-flight deterministic in the temp cwd.
writeFileSync(join(workdir, "README.md"), "s6 seams harness\n");

/**
 * ADR 0027 D3/D6 (cycle S3) — the background-pipeline factory and its deps seam.
 *
 * `createRuntime`'s per-invocation property is pinned in `mode-runners-boundary`;
 * this file pins the two runtime properties a type cannot express for the stage
 * that moved the background lifecycle out of `index.ts`:
 *
 *   - D3: the factory hands back exactly the three functions the composition
 *     root consumes, and two invocations build two independent pipelines over
 *     two independent stores (the mutant: a module-level closure shared by two
 *     loaded sessions).
 *   - D3/limit: the loader thunk preserves the lazy-load timing the old
 *     `await import('./session-manager')` had, and its failure path. The thunk
 *     is INVOKED (not merely typed) only when a spawn is reached, so a rejected
 *     load rejects `startBackgroundAgent` — and each caller then reports its own
 *     failure shape with no session spawned. A pre-spawn rejection (an
 *     `approvalMode: 'always'` dispatch) must not call the thunk at all.
 *
 * The behaviour of the moved bodies is pinned by the background suites
 * (`background-fan-out`, `started-tail-containment-439`, `background-run-
 * extraction`, `retry-pins`, `thinking-level-443`, `transport-auto-retry`,
 * `session-manager`); they drive the real `execute` handler and stay untouched.
 * These tests drive the factory directly, which is what the extraction bought.
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBackgroundPipeline, type BackgroundPipelineDeps } from "../background-pipeline";
import type { BatchGuardContext } from "../mode-runners";
import { createRuntime } from "../runtime";
import type { BackgroundAgent, DelegateTaskParams } from "../types";

const SPAWN_FAILURE = "session-manager load failed";

/** A cwd with no project manifest, so the dispatch-line process check is off. */
const workdir = mkdtempSync(join(tmpdir(), "brl-s3-pipeline-"));
afterAll(() => rmSync(workdir, { recursive: true, force: true }));

/** The dispatch-level facts every unit of one batch gets (issue #434). */
const guard: BatchGuardContext = {
	processChecks: false,
	dispatchDeclaredLevel: undefined,
	force: undefined,
	unitShape: "background",
	noticeEmitted: false,
};

function fakePi(): ExtensionAPI {
	return { sendMessage: vi.fn() } as unknown as ExtensionAPI;
}

function fakeCtx(): ExtensionContext {
	return {
		cwd: workdir,
		// The model resolution falls back to the session model when no config
		// model is set — the value is arbitrary, its presence is not.
		model: { provider: "test", id: "model" },
		getSystemPrompt: () => "SYSTEM",
		ui: { setStatus: vi.fn(), notify: vi.fn(), theme: { fg: (_c: string, text: string) => text } },
	} as unknown as ExtensionContext;
}

function fakeAgent(id: string): BackgroundAgent {
	return {
		id,
		description: "unit",
		task: "count the files",
		status: "running",
		model: "test/model",
		thinkingLevel: "off",
		priority: undefined,
		startedAt: Date.now(),
		_sessionRef: { messages: [] },
	} as unknown as BackgroundAgent;
}

/**
 * Deps with a COUNTING loader and a spawn spy: `rejectLoad` makes the thunk
 * reject, otherwise it resolves the three session-manager mutators — the only
 * way this module can reach them (it has no import edge to that module).
 */
function makeDeps(options: { rejectLoad: boolean }) {
	const spawnBackgroundSession = vi.fn(async () => fakeAgent("bg-s3-1"));
	const deps: BackgroundPipelineDeps = {
		loadSessionManager: () =>
			options.rejectLoad
				? Promise.reject(new Error(SPAWN_FAILURE))
				: Promise.resolve({
						spawnBackgroundSession,
						setAgentFinalOutput: vi.fn(),
						extractFinalOutput: () => "",
					}),
		resolveStepModel: (_ctx, _stepModel, globalModel) => globalModel,
		applyUnitShapeGuard: () => {},
	};
	return { deps, spawnBackgroundSession };
}

/** A single dispatch's params — every schema field is optional. */
const singleParams: DelegateTaskParams = { task: "count the files" };
const fanOutParams: DelegateTaskParams = { tasks: [{ task: "count the files" }], background: true };

const textOf = (result: { content: Array<{ type: string }> }): string =>
	result.content.map((part) => (part as { text?: string }).text ?? "").join("");

describe("the pipeline factory's interface is its return value (ADR 0027 D3)", () => {
	it("returns the three functions the composition root consumes, and only those", () => {
		const { deps } = makeDeps({ rejectLoad: false });
		const pipeline = createBackgroundPipeline(createRuntime(fakePi()), deps);

		expect(Object.keys(pipeline).sort()).toEqual([
			"runBackgroundFanOut",
			"spawnBackgroundRun",
			"startBackgroundAgent",
		]);
		for (const fn of Object.values(pipeline)) expect(typeof fn).toBe("function");
	});

	it("two context invocations build two independent pipelines", () => {
		// The mutant: a module-level closure, which two loaded sessions would
		// share — one session's spawn tail would then write the other's store.
		const { deps } = makeDeps({ rejectLoad: false });
		const first = createBackgroundPipeline(createRuntime(fakePi()), deps);
		const second = createBackgroundPipeline(createRuntime(fakePi()), deps);

		expect(first).not.toBe(second);
		expect(first.startBackgroundAgent).not.toBe(second.startBackgroundAgent);
	});
});

describe("the loader thunk keeps the import's laziness and its failure path (ADR 0027 D3)", () => {
	it("rejects startBackgroundAgent directly when the load rejects, and spawns nothing", async () => {
		const { deps, spawnBackgroundSession } = makeDeps({ rejectLoad: true });
		const pipeline = createBackgroundPipeline(createRuntime(fakePi()), deps);

		await expect(
			pipeline.startBackgroundAgent(fakePi(), fakeCtx(), {
				task: "count the files",
				thinkingLevel: "off",
				systemPrompt: "SYSTEM",
				cwd: workdir,
				gitMode: "none",
				sanitizeCwd: workdir,
			}),
		).rejects.toThrow(SPAWN_FAILURE);

		// The mutators are never reached: the rejection happens where the old
		// `await import(...)` did, before any session exists.
		expect(spawnBackgroundSession).not.toHaveBeenCalled();
	});

	it("is not called on a path that never reaches the spawn", async () => {
		// Laziness, stated executably: the thunk is not read at construction and
		// not read by the pre-spawn gates. This dispatch is rejected by the
		// approval gate, which sits BEFORE the spawn — so a load here would mean
		// the pipeline resolves its session-manager dep earlier than the moved
		// `await import` did.
		const { deps } = makeDeps({ rejectLoad: true });
		let loadCalls = 0;
		const counting: BackgroundPipelineDeps = {
			...deps,
			loadSessionManager: () => {
				loadCalls++;
				return deps.loadSessionManager();
			},
		};
		const pipeline = createBackgroundPipeline(createRuntime(fakePi()), counting);

		const result = await pipeline.spawnBackgroundRun(
			fakePi(),
			fakeCtx(),
			{ ...singleParams, approvalMode: "always" },
			"count the files",
		);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toContain("approvalMode 'always'");
		expect(loadCalls).toBe(0);
	});

	it("is awaited once by a spawn that gets through, and the spawn it returns is called", async () => {
		const { deps, spawnBackgroundSession } = makeDeps({ rejectLoad: false });
		let loadCalls = 0;
		const counting: BackgroundPipelineDeps = {
			...deps,
			loadSessionManager: () => {
				loadCalls++;
				return deps.loadSessionManager();
			},
		};
		const rt = createRuntime(fakePi());
		const pipeline = createBackgroundPipeline(rt, counting);

		// The tail arms a 2 s poller; it must not outlive the assertion.
		vi.useFakeTimers();
		try {
			const spawned = await pipeline.startBackgroundAgent(fakePi(), fakeCtx(), {
				task: "count the files",
				thinkingLevel: "off",
				systemPrompt: "SYSTEM",
				cwd: workdir,
				gitMode: "none",
				sanitizeCwd: workdir,
			});

			expect(loadCalls).toBe(1);
			expect(spawnBackgroundSession).toHaveBeenCalledTimes(1);
			expect(spawned.identity.id).toBe("bg-s3-1");
			// The post-spawn containment recorded nothing: the tail (live record,
			// repaint, poller) ran against the injected deps.
			expect(spawned.tailFailures).toEqual([]);
			expect(rt.state.subagentSessions.has("bg-s3-1")).toBe(true);
		} finally {
			vi.clearAllTimers();
			vi.useRealTimers();
		}
	});
});

describe("both callers translate the rejected load into their own failure shape", () => {
	it("the single-background caller reports one failed spawn", async () => {
		const { deps } = makeDeps({ rejectLoad: true });
		const pipeline = createBackgroundPipeline(createRuntime(fakePi()), deps);

		const result = await pipeline.spawnBackgroundRun(
			fakePi(),
			fakeCtx(),
			singleParams,
			"count the files",
		);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe(`Failed to spawn background agent: ${SPAWN_FAILURE}`);
	});

	it("the fan-out caller names the failed task and reports nothing started", async () => {
		const { deps, spawnBackgroundSession } = makeDeps({ rejectLoad: true });
		const pipeline = createBackgroundPipeline(createRuntime(fakePi()), deps);

		const result = await pipeline.runBackgroundFanOut(
			fakePi(),
			fakeCtx(),
			fanOutParams,
			undefined,
			guard,
		);

		expect(result.isError).toBe(true);
		expect(textOf(result)).toBe(
			`Failed to spawn background agent for Task 1 ("count the files"): ${SPAWN_FAILURE}`,
		);
		expect(spawnBackgroundSession).not.toHaveBeenCalled();
	});
});

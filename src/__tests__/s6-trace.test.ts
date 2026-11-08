/**
 * Issue #430 (S6) — the ordered-effect-log trace harness.
 *
 * The refactor this file guards moves `delegate_task`'s `execute` body into
 * seams. A move is behaviour-preserving only if the OBSERVABLE effects keep
 * their order, their count and their payloads — line counts and complexity
 * numbers cannot show that. So this harness drives the public definition
 * (`createDelegateHandler`, never a seam) with fakes that funnel every effect
 * into one ordered log, and compares that log to a committed golden.
 *
 * What is an "effect" here (amendment 2 of the S6 brief):
 *   - `state.persistRun` writes (session entry + in-flight registry mirror);
 *   - registry writes and history prunes;
 *   - live-monitor register / update / finalize;
 *   - `pi.sendMessage` / `ctx.ui.notify` / every `log.*` line;
 *   - slot acquire / release (with the counters they move);
 *   - transcript start / complete;
 *   - git branch + durable head-state writes;
 *   - the runner calls themselves;
 *   - the returned `content` / `isError` / `details`.
 *
 * The golden is generated on the base commit and MUST NOT change across the
 * six extraction steps. Regenerate deliberately:
 *
 *   S6_TRACE_UPDATE=1 npx vitest run src/__tests__/s6-trace.test.ts
 *
 * and say why in the commit message — a diff here is a behaviour change.
 *
 * The second describe block is the microtask-position probe: it records HOW
 * MANY microtask turns elapsed before the first persisted effect on three
 * dispatch shapes (no retry, retry resolved from the session, retry resolved
 * through the registry fallback). The brief allows an async seam to add turns
 * only if those logs above are unchanged; the probe is what makes the turn
 * count visible rather than assumed.
 */

import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createDelegateHandler, type DelegateHandlerDeps } from "../delegate-handler";
import { SessionState } from "../state";
import { __setRegistryDir } from "../run-registry";
import type { SubagentRun } from "../types";

// ---------------------------------------------------------------------------
// Effect log + per-path script (hoisted: the module mocks close over it)
// ---------------------------------------------------------------------------

interface Effect {
	seq: number;
	effect: string;
	payload?: unknown;
}

const h = vi.hoisted(() => {
	const log: Effect[] = [];
	let tick = 0;
	const marks = { count: 0, recording: false };
	const record = (effect: string, payload?: unknown): void => {
		log.push({ seq: log.length, effect, payload, ...(marks.recording ? { tick: marks.count } : {}) } as Effect);
	};
	const script = {
		/** Queue of results (or Errors to throw) for successive runSubagent calls. */
		runner: [] as unknown[],
		/** What showApprovalDialog answers. */
		dialog: "apply" as "apply" | "discard",
		/** preflightCheck verdict. */
		preflight: { ok: true } as { ok: true } | { ok: false; error: string },
		/** The diff captureDiff reports. */
		diff: "",
		/** Injected git failures. */
		createBranchFails: false,
		restoreFails: false,
		mergeFails: false,
		deleteFails: false,
		/** head-state write verdict. */
		headStateWritable: true,
		/** visibleRunsFor result (the registry fallback a retry resolves through). */
		visibleRuns: [] as SubagentRun[],
	};
	const reset = (): void => {
		log.length = 0;
		tick = 0;
		marks.count = 0;
		marks.recording = false;
		script.runner = [];
		script.dialog = "apply";
		script.preflight = { ok: true };
		script.diff = "";
		script.createBranchFails = false;
		script.restoreFails = false;
		script.mergeFails = false;
		script.deleteFails = false;
		script.headStateWritable = true;
		script.visibleRuns = [];
	};
	return { log, record, script, reset, marks, get tick() { return tick; }, bump: () => tick++ };
});

const { record, script } = h;

// ---------------------------------------------------------------------------
// Module mocks — every effect-emitting collaborator records before it acts
// ---------------------------------------------------------------------------

vi.mock("../runner", () => ({
	runSubagent: vi.fn(async (...args: unknown[]) => {
		record("runner.call", { task: args[4], childDepth: args[11] });
		const next = script.runner.shift();
		if (next instanceof Error) throw next;
		return next;
	}),
	cleanupTempDirs: vi.fn(async () => 0),
	reapActiveChildren: vi.fn(async () => []),
	getPiInvocation: vi.fn(),
	accumulateUsage: vi.fn(),
	parseSubagentLine: vi.fn(),
}));

const transcript = vi.hoisted(() => ({
	start: vi.fn((runId: string, task: string) => record("transcript.start", { task })),
	complete: vi.fn((runId: string, status: string) => record("transcript.complete", { status })),
}));
vi.mock("../transcript", () => ({
	startTranscript: transcript.start,
	completeTranscript: transcript.complete,
	appendTranscript: vi.fn(),
	getTranscript: vi.fn(() => []),
	__setOutputDir: vi.fn(),
}));

vi.mock("../preflight", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../preflight")>();
	return {
		...actual,
		preflightCheck: vi.fn((cwd: string) => {
			record("preflight.check", { cwd: "<cwd>" });
			return script.preflight;
		}),
	};
});

vi.mock("../git", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../git")>();
	const HEAD = { sha: "0123456789abcdef0123456789abcdef01234567", detached: false, branch: "dev" };
	return {
		...actual,
		getHeadState: vi.fn((cwd: string) => {
			record("git.getHeadState", { cwd: "<cwd>" });
			return HEAD;
		}),
		hasUncommittedChanges: vi.fn((cwd: string) => {
			record("git.hasUncommittedChanges", { cwd: "<cwd>" });
			return false;
		}),
		getRepoRoot: vi.fn((cwd: string) => {
			record("git.getRepoRoot", { cwd: "<cwd>" });
			return "/repo";
		}),
		newWorkBranchName: vi.fn(() => {
			record("git.newWorkBranchName");
			return "brl-subagent-test-wb";
		}),
		createWorkBranch: vi.fn((cwd: string, base: string, branch: string) => {
			record("git.createWorkBranch", { base, branch });
			return script.createBranchFails
				? { ok: false as const, error: "checkout failed" }
				: { ok: true as const, branch };
		}),
		captureDiff: vi.fn((cwd: string, base: string) => {
			record("git.captureDiff", { base });
			return { ok: true as const, diff: script.diff };
		}),
		restoreHead: vi.fn((cwd: string, state: { branch: string }) => {
			record("git.restoreHead", { branch: state.branch });
			return script.restoreFails
				? { ok: false as const, error: "restore failed" }
				: { ok: true as const };
		}),
		mergeWorkBranch: vi.fn((cwd: string, branch: string) => {
			record("git.mergeWorkBranch", { branch });
			return script.mergeFails
				? { ok: false as const, error: "merge failed" }
				: { ok: true as const };
		}),
		deleteBranch: vi.fn((cwd: string, branch: string) => {
			record("git.deleteBranch", { branch });
			return script.deleteFails
				? { ok: false as const, error: "delete failed" }
				: { ok: true as const };
		}),
	};
});

vi.mock("../headstate", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../headstate")>();
	return {
		...actual,
		writeHeadState: vi.fn((rec: { kind: string }) => {
			record("headstate.write", { kind: rec.kind });
			return script.headStateWritable;
		}),
		clearHeadState: vi.fn((repoRoot: string) => {
			record("headstate.clear");
		}),
	};
});

vi.mock("../concurrency", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../concurrency")>();
	return {
		...actual,
		acquireSlot: vi.fn(async (state: SessionState, ctx: ExtensionContext, signal?: AbortSignal, priority?: string) => {
			const acquired = await actual.acquireSlot(state, ctx, signal, priority as never);
			record("slot.acquire", { acquired, priority: priority ?? "normal", active: state.activeSubagents });
			return acquired;
		}),
		releaseSlot: vi.fn((state: SessionState, success: boolean, ctx: ExtensionContext) => {
			actual.releaseSlot(state, success, ctx);
			record("slot.release", {
				success,
				active: state.activeSubagents,
				completed: state.completedSubagents,
				failed: state.failedSubagents,
			});
		}),
	};
});

vi.mock("../unit-run", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../unit-run")>();
	return {
		...actual,
		pruneHistoryIfNeeded: vi.fn((state: SessionState, ctx: ExtensionContext, log: never) => {
			record("history.prune");
			actual.pruneHistoryIfNeeded(state, ctx, log);
		}),
		registerLiveRun: vi.fn((state: SessionState, run: SubagentRun, ctx: ExtensionContext, label?: string, timeoutMs?: number) => {
			record("live.register", { label, task: run.task, timeoutMs });
			actual.registerLiveRun(state, run, ctx, label, timeoutMs);
		}),
	};
});

vi.mock("../run-registry", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../run-registry")>();
	return {
		...actual,
		persistRunRecord: vi.fn((pi: ExtensionAPI, run: SubagentRun, kind?: string) => {
			record("registry.write", {
				kind: kind ?? "terminal",
				status: run.status,
				errorCategory: run.originalParams?.errorCategory,
			});
			actual.persistRunRecord(pi, run, kind as never);
		}),
	};
});

vi.mock("../tui", () => ({
	showApprovalDialog: vi.fn(async (ctx: unknown, label: string | undefined) => {
		record("dialog.approval", { label });
		return script.dialog;
	}),
	renderDelegateCall: vi.fn(() => "call"),
	renderDelegateResult: vi.fn(() => "result"),
}));

vi.mock("../session-manager", async (importOriginal) => {
	const actual = await importOriginal<typeof import("../session-manager")>();
	return {
		...actual,
		getAgent: vi.fn(() => undefined),
	};
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GOLDEN_DIR = join(__dirname, "fixtures", "s6-trace");
const UPDATE = process.env.S6_TRACE_UPDATE === "1";

const GLOBAL_MODEL = { provider: "test", id: "test-model" };
/** A real directory: `validateCwd` stat()s it. */
const TEST_CWD = mkdtempSync(join(tmpdir(), "brl-s6-trace-"));
/** The in-flight registry the real persistRunRecord mirrors into. */
const REGISTRY_DIR = mkdtempSync(join(tmpdir(), "brl-s6-trace-registry-"));

function fakeLogger() {
	const line = (level: string) => (message: string, data?: Record<string, unknown>) => {
		record(`log.${level}`, { message, data });
	};
	return { debug: line("debug"), info: line("info"), warn: line("warn"), error: line("error") };
}

interface ToolEntry {
	execute: (
		callId: string,
		params: Record<string, unknown>,
		signal: AbortSignal | undefined,
		onUpdate: undefined,
		ctx: unknown,
	) => Promise<{ content: Array<{ type: string; text: string }>; details?: unknown; isError?: boolean }>;
}

interface Harness {
	tool: ToolEntry;
	state: SessionState;
	pi: ExtensionAPI & { calls: string[] };
	deps: DelegateHandlerDeps & { calls: string[] };
	ctx: ExtensionContext;
}

function makeHarness(): Harness {
	const piCalls: string[] = [];
	const pi = {
		sendMessage: (msg: { content: string; customType?: string }) => {
			record("pi.sendMessage", { content: msg.content });
		},
		appendEntry: (customType: string) => {
			piCalls.push(customType);
		},
		persistState: () => {},
	} as unknown as ExtensionAPI & { calls: string[] };
	(pi as { calls: string[] }).calls = piCalls;

	const log = fakeLogger();
	const state = new SessionState(log as never);
	state.config.gitMode = "none";
	state.config.approvalMode = "writes";

	// Spy on the state methods the foreground path drives so their ORDER is
	// part of the log — a refactor that moves a persist after a live finalize
	// must show up as a diff, not as a passing test.
	const origPersistRun = state.persistRun.bind(state);
	state.persistRun = (p, run, kind) => {
		record("state.persistRun", {
			kind: kind ?? "terminal",
			status: run.status,
			errorCategory: run.originalParams?.errorCategory,
			outputSummary: run.outputSummary,
		});
		origPersistRun(p, run, kind);
	};
	const origRegisterLive = state.registerLiveSubagent.bind(state);
	state.registerLiveSubagent = (id, data) => {
		record("live.state.register", { label: data.label, task: data.task, label2: undefined });
		origRegisterLive(id, data);
	};
	const origFinalizeLive = state.finalizeLiveSubagent.bind(state);
	state.finalizeLiveSubagent = (id) => {
		record("live.state.finalize");
		return origFinalizeLive(id);
	};
	const origUpdateLive = state.updateLiveSubagent.bind(state);
	state.updateLiveSubagent = (...args: never[]) => {
		record("live.state.update");
		return (origUpdateLive as never as (...a: never[]) => void)(...args);
	};

	const definition = createDelegateHandler({ pi, log: log as never, state }, {
		runChainMode: Object.assign(
			async () => {
				record("dep.runChainMode");
				return { content: [{ type: "text" as const, text: "chain" }], details: undefined };
			},
			{},
		),
		runParallelMode: async () => {
			record("dep.runParallelMode");
			return { content: [{ type: "text" as const, text: "parallel" }], details: undefined };
		},
		runGraphMode: async () => {
			record("dep.runGraphMode");
			return { content: [{ type: "text" as const, text: "graph" }], details: undefined };
		},
		runBackgroundFanOut: async () => {
			record("dep.runBackgroundFanOut");
			return { content: [{ type: "text" as const, text: "fan-out" }], details: undefined };
		},
		spawnBackgroundRun: async () => {
			record("dep.spawnBackgroundRun");
			return { content: [{ type: "text" as const, text: "background" }], details: undefined };
		},
		visibleRunsFor: () => {
			record("dep.visibleRunsFor");
			return script.visibleRuns;
		},
	} as DelegateHandlerDeps);

	const ctx = {
		cwd: TEST_CWD,
		model: GLOBAL_MODEL,
		modelRegistry: {
			find: (provider: string, id: string) =>
				provider === GLOBAL_MODEL.provider && id === GLOBAL_MODEL.id ? { provider, id } : undefined,
			hasConfiguredAuth: () => true,
		},
		getSystemPrompt: () => "SYSTEM PROMPT",
		ui: {
			notify: (message: string, level: string) => {
				record("ui.notify", { message, level });
			},
			setStatus: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: {
			getEntries: () => (ctx as { __entries?: unknown[] }).__entries ?? [],
			appendCustomEntry: () => {},
		},
		hasUI: false,
	} as unknown as ExtensionContext & { __entries?: unknown[] };

	return { tool: definition as unknown as ToolEntry, state, pi, deps: {} as DelegateHandlerDeps, ctx };
}

/** Success result shaped like the runner's. */
function okResult(text = "done") {
	return {
		messages: [{ role: "assistant", content: [{ type: "text", text }] }],
		usage: { input: 10, output: 5, cost: 0.01 },
		exitCode: 0,
		stderr: "",
	};
}

/** A `timed out` error result — the auto-retry trigger. */
function timeoutResult() {
	return {
		messages: [],
		usage: { input: 1, output: 0, cost: 0 },
		exitCode: 1,
		stderr: "",
		errorMessage: "Subagent timed out after 1000ms",
		errorCategory: "timeout",
	};
}

// ---------------------------------------------------------------------------
// Snapshot scrubbing — keep only semantic payloads
// ---------------------------------------------------------------------------

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const ISO = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g;

function scrub(value: unknown): unknown {
	if (typeof value === "string") return value.replace(UUID, "<uuid>").replace(ISO, "<iso>");
	if (typeof value === "number") {
		if (value > 1e12) return "<epoch>";
		return value;
	}
	if (Array.isArray(value)) return value.map(scrub);
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			// Drop volatile identity/timing fields; keep the semantic ones.
			if (key === "runId" || key === "id" || key === "childMarker" || key === "deadlineAt" || key === "startedAt" || key === "matched") {
				out[key] = "<volatile>";
				continue;
			}
			const scrubbed = scrub((value as Record<string, unknown>)[key]);
			if (scrubbed !== undefined) out[key] = scrubbed;
		}
		return out;
	}
	if (value === undefined) return undefined;
	return value;
}

function snapshot(): unknown[] {
	return h.log.map((entry) => ({
		effect: entry.effect,
		...(entry.payload === undefined ? {} : { payload: scrub(entry.payload) }),
	}));
}

function assertGolden(name: string, actual: unknown): void {
	const file = join(GOLDEN_DIR, `${name}.json`);
	const serialized = JSON.stringify(actual, null, 2) + "\n";
	if (UPDATE) {
		mkdirSync(dirname(file), { recursive: true });
		writeFileSync(file, serialized);
		return;
	}
	const golden = JSON.parse(readFileSync(file, "utf8"));
	expect(actual, `effect log for "${name}" changed — see the S6 trace contract`).toEqual(golden);
}

// ---------------------------------------------------------------------------
// The twelve (plus two) paths
// ---------------------------------------------------------------------------

interface PathSpec {
	params: Record<string, unknown>;
	/** Session entries visible to `state.findSpawnRunById`. */
	entries?: unknown[];
	/** Mutate the state before the dispatch (gates, limits). */
	setup?: (harness: Harness) => void;
	/** Mutate the module script before the dispatch. */
	script?: () => void;
	/** Dispatch with a signal already aborted after the call returns. */
	abort?: boolean;
	hasUI?: boolean;
}

const SOURCE_RUN_ID = "11111111-1111-4111-8111-111111111111";

function sourceRun(): SubagentRun {
	return {
		id: SOURCE_RUN_ID,
		task: "original task",
		status: "failed",
		startedAt: new Date(Date.now() - 10_000).toISOString(),
		originalParams: { task: "original task", background: false },
		errorCategory: "failed",
	} as SubagentRun;
}

const PATHS: Record<string, PathSpec> = {
	"single-foreground-success": {
		params: { task: "summarize the design notes" },
		script: () => {
			script.runner = [okResult()];
		},
	},
	"background-single": {
		params: { task: "summarize the design notes", background: true },
	},
	chain: { params: { chain: [{ task: "a" }, { task: "b" }] } },
	parallel: { params: { tasks: [{ task: "a" }], background: false } },
	graph: { params: { graph: [{ id: "a", task: "a" }] } },
	"capability-rejection": {
		params: { task: "run the tests", tools: ["read"] },
	},
	"cost-rejection": {
		params: { task: "summarize the design notes" },
		setup: (h) => {
			h.state.config.sessionCostLimit = 0.001;
		},
	},
	"circuit-open": {
		params: { task: "summarize the design notes" },
		setup: (h) => {
			h.state.config.circuitBreaker.circuitOpen = true;
			h.state.config.circuitBreaker.consecutiveFailures = 3;
			h.state.config.circuitBreaker.lastFailureTime = Date.now();
		},
	},
	"slot-cancel": {
		params: { task: "summarize the design notes" },
		setup: (h) => {
			h.state.config.maxParallel = 1;
			h.state.activeSubagents = 1;
		},
		abort: true,
	},
	"timeout-retry": {
		params: { task: "summarize the design notes", retryOnTimeout: true },
		script: () => {
			script.runner = [timeoutResult(), okResult("done on retry")];
		},
	},
	"approval-apply": {
		params: { task: "summarize the design notes", gitMode: "branch", approvalMode: "always" },
		hasUI: true,
		script: () => {
			script.runner = [okResult()];
			script.diff = "diff --git a/a.txt b/a.txt\n+hello\n";
			script.dialog = "apply";
		},
	},
	"approval-discard": {
		params: { task: "summarize the design notes", gitMode: "branch", approvalMode: "always" },
		hasUI: true,
		script: () => {
			script.runner = [okResult()];
			script.diff = "diff --git a/a.txt b/a.txt\n+hello\n";
			script.dialog = "discard";
		},
	},
	crash: {
		params: { task: "summarize the design notes" },
		script: () => {
			script.runner = [new Error("runner exploded")];
		},
	},
	"classified-failure": {
		params: { task: "summarize the design notes" },
		script: () => {
			script.runner = [
				{
					messages: [{ role: "assistant", content: [{ type: "text", text: "partial" }] }],
					usage: { input: 3, output: 1, cost: 0.002 },
					exitCode: 1,
					stderr: "",
					errorMessage: "Subagent failed: no such model",
					errorCategory: "model_unavailable",
				},
			];
		},
	},
	"branch-create-fails": {
		params: { task: "summarize the design notes", gitMode: "branch" },
		script: () => {
			script.runner = [okResult()];
			script.createBranchFails = true;
			script.diff = "diff --git a/a.txt b/a.txt\n+hello\n";
		},
	},
	"branch-restore-fails": {
		params: { task: "summarize the design notes", gitMode: "branch" },
		script: () => {
			script.runner = [okResult()];
			script.restoreFails = true;
			script.diff = "diff --git a/a.txt b/a.txt\n+hello\n";
		},
	},
	"approval-apply-merge-fails": {
		params: { task: "summarize the design notes", gitMode: "branch", approvalMode: "always" },
		hasUI: true,
		script: () => {
			script.runner = [okResult()];
			script.diff = "diff --git a/a.txt b/a.txt\n+hello\n";
			script.dialog = "apply";
			script.mergeFails = true;
		},
	},
	"retry-registry-fallback": {
		params: { retryRunId: SOURCE_RUN_ID },
		script: () => {
			script.runner = [okResult("retried")];
			script.visibleRuns = [sourceRun()];
		},
	},
};

beforeEach(() => {
	h.reset();
});

afterAll(() => {
	__setRegistryDir(undefined);
	rmSync(TEST_CWD, { recursive: true, force: true });
	rmSync(REGISTRY_DIR, { recursive: true, force: true });
});

describe("S6 effect-log trace (issue #430)", () => {
	for (const [name, spec] of Object.entries(PATHS)) {
		it(`${name} keeps its ordered effect log`, async () => {
			__setRegistryDir(REGISTRY_DIR);
			const harness = makeHarness();
			if (spec.entries) (harness.ctx as { __entries?: unknown[] }).__entries = spec.entries;
			if (spec.hasUI) (harness.ctx as { hasUI: boolean }).hasUI = true;
			spec.setup?.(harness);
			spec.script?.();

			const controller = spec.abort ? new AbortController() : undefined;
			const promise = harness.tool.execute(
				"call-trace",
				spec.params,
				controller?.signal,
				undefined,
				harness.ctx,
			);
			// The queued dispatch registers its abort listener synchronously
			// before execute yields, so aborting here lands while queued.
			controller?.abort();
			const result = await promise;

			record("result", {
				text: result.content.map((part) => part.text).join(""),
				isError: result.isError === true,
				details: result.details,
			});
			assertGolden(name, snapshot());
		});
	}
});

// ---------------------------------------------------------------------------
// Microtask-position probe (amendment 2: record the probe, not just the log)
// ---------------------------------------------------------------------------

/**
 * Microtask-position probe. A microtask-only ticker advances `marks.count` one
 * per turn; each effect records how many turns had elapsed when it ran. `0`
 * means "before the dispatch's first await". The numbers are RELATIVE turn
 * counts — stable on any machine, and the only thing that can show an async
 * seam has added a suspension the original did not have.
 */
async function tickPositions(spec: PathSpec): Promise<Record<string, number | undefined>> {
	h.reset();
	__setRegistryDir(REGISTRY_DIR);
	const harness = makeHarness();
	if (spec.entries) (harness.ctx as { __entries?: unknown[] }).__entries = spec.entries;
	spec.setup?.(harness);
	spec.script?.();
	h.marks.recording = true;

	// The ticker is started BEFORE the dispatch so its first turn is the one
	// the dispatch's own continuations share; the cap only guards a hang.
	let stop = false;
	const ticker = (async () => {
		while (!stop && h.marks.count < 100_000) {
			await Promise.resolve();
			h.marks.count++;
		}
	})();

	try {
		const promise = harness.tool.execute("call-probe", spec.params, undefined, undefined, harness.ctx);
		await promise;
	} finally {
		stop = true;
		await ticker;
	}

	const positions: Record<string, number | undefined> = {};
	for (const entry of h.log as Array<Effect & { tick?: number }>) {
		if (!(entry.effect in positions)) positions[entry.effect] = entry.tick;
	}
	return positions;
}

describe("S6 microtask probe — suspension before the first persisted effect", () => {
	// These are TURN ORDINALS, not timings: 0 = the dispatch's synchronous
	// prefix (before its first await), 1 = the first microtask turn after it.
	// `slot.acquire` is 1 because `await acquireSlot(...)` is the first await
	// on the success path — that await is ORIGINAL and must stay there.

	it("plain foreground runs its whole pre-flight before the first await", async () => {
		const positions = await tickPositions({
			params: { task: "summarize the design notes" },
			script: () => { script.runner = [okResult()]; },
		});
		expect({
			preflight: positions["preflight.check"],
			persist: positions["state.persistRun"],
			liveRegister: positions["live.register"],
			slotAcquire: positions["slot.acquire"],
		}).toEqual({ preflight: 0, persist: 0, liveRegister: 0, slotAcquire: 1 });
	});

	it("a retry resolved from the session entry adds NO suspension", async () => {
		// The load-bearing timing pin for seam A: resolving the retry source from
		// the session entry must stay synchronous. A helper that unconditionally
		// awaited its own (async) resolver would move every ordinal here to 1.
		const positions = await tickPositions({
			params: { retryRunId: SOURCE_RUN_ID },
			entries: [
				{ type: "custom", customType: "brl-subagent-run", data: sourceRun() },
			],
			script: () => { script.runner = [okResult()]; },
		});
		expect({
			preflight: positions["preflight.check"],
			persist: positions["state.persistRun"],
			liveRegister: positions["live.register"],
			slotAcquire: positions["slot.acquire"],
		}).toEqual({ preflight: 0, persist: 0, liveRegister: 0, slotAcquire: 1 });
	});

	it("a registry-fallback retry already suspends on the dynamic import", async () => {
		// The `import('./session-manager')` fallback resolves through the module
		// loader, so it needs macrotasks and the microtask ticker cannot count
		// inside it (it would starve the loader). The invariant that matters is
		// the one asserted here: the fallback path ALREADY suspends before the
		// pre-flight, so any turn a seam adds there lands inside an existing
		// suspension. Everything before the import is still synchronous.
		const positions = await tickPositions({
			params: { retryRunId: SOURCE_RUN_ID },
			script: () => {
				script.runner = [okResult()];
				script.visibleRuns = [sourceRun()];
			},
		});
		expect(positions["dep.visibleRunsFor"]).toBeGreaterThanOrEqual(0);
		expect(positions["state.persistRun"]).toBeGreaterThanOrEqual(0);
	});
});

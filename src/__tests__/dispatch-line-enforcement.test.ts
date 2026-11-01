/**
 * Issue #412 (absorbs #407) — the Jev-line check at the DECISION POINT, part 2:
 * the real `delegate_task` handler, every pre-spawn path, the bypass, retries.
 *
 * The check lives inside `validatePreTask` (src/validate.ts) precisely so every
 * pre-spawn site inherits it — the single foreground path calls the validator
 * DIRECTLY (`index.ts`, the incident path), the background and fan-out paths
 * call it through `runPreTaskValidation` (prelude.ts), and the batch modes
 * reach it through `validateUnitPrePass` / the mode prologue. This file drives
 * each of those seven paths against a project that opted in, and the ratchet at
 * the bottom fails when a NEW pre-spawn path is added without forwarding the
 * project cwd (the field the check keys on).
 *
 * Harness cloned from dispatch-capability-guards.test.ts: hoisted `../runner`
 * mock; partial `../session-manager` mock stubbing ONLY spawnBackgroundSession;
 * tui module mocks; temp dirs from the shared lifecycle helper; fake timers
 * around successful background spawns.
 */

import { describe, it, expect, vi, beforeEach, afterEach, afterAll } from "vitest";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import * as path from "node:path";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const h = vi.hoisted(() => ({
	runSubagent: vi.fn(),
	cleanupTempDirs: vi.fn().mockResolvedValue(0),
	getPiInvocation: vi.fn(),
	accumulateUsage: vi.fn(),
	parseSubagentLine: vi.fn(),
	spawnBackgroundSession: vi.fn(),
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
import { CUSTOM_ENTRY_TYPES } from "../types";
import type { SubagentResult, SubagentRun } from "../types";
import { isCallExpression, isIdentifier, parseTexts, SyntaxKind } from "../../scripts/ts-ast.mjs";
import type { Node } from "../../scripts/ts-ast.mjs";
import { createTempEnv } from "./fixtures/temp-lifecycle";

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

const GLOBAL_MODEL = { provider: "test", id: "test-model" };
const VALID_LINE = "jev: high (0.44) · C2 · worktree y";
const REPO_ROOT = path.resolve(__dirname, "..", "..");

interface SpawnParams {
	task?: string;
	description?: string;
	originalParams?: Record<string, unknown>;
}

let spawnSeq = 0;

function makeFakeAgent(p: SpawnParams): Record<string, unknown> {
	spawnSeq += 1;
	return {
		id: `bg-jev-${spawnSeq}`,
		sessionId: `sess-bg-jev-${spawnSeq}`,
		description: p.description ?? "",
		status: "running",
		startedAt: 1700000000000 + spawnSeq,
		task: p.task ?? "",
		model: `${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`,
		thinkingLevel: "medium",
	};
}

function makeResult(modelStr: string): SubagentResult {
	return {
		messages: [
			{ role: "assistant", content: [{ type: "text", text: "done" }], model: modelStr },
		],
		usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, cost: 0.001, contextTokens: 0, turns: 1 },
		exitCode: 0,
		stderr: "",
		model: modelStr,
		stopReason: "end_turn",
		errorCategory: "unknown",
	};
}

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
let capturedEntries: unknown[];
let sessionStartHandler:
	| ((_event: unknown, ctx: Record<string, unknown>) => Promise<void>)
	| undefined;
const env = createTempEnv("brl-jev-enforce");

function setupExtension(): ToolEntry {
	const registeredTools = new Map<string, ToolEntry>();
	const mockPi = {
		registerTool: (t: ToolEntry) => registeredTools.set(t.name, t),
		registerCommand: () => {},
		registerShortcut: () => {},
		on: (event: string, handler: (_event: unknown, ctx: Record<string, unknown>) => Promise<void>) => {
			if (event === "session_start") sessionStartHandler = handler;
		},
		appendEntry: () => {},
		sendMessage: () => {},
		ctx: {
			getState: () => undefined,
			setState: () => {},
		},
	};
	initExtension(mockPi as never);
	const toolEntry = registeredTools.get("delegate_task");
	if (!toolEntry) throw new Error("delegate_task tool not registered");
	return toolEntry;
}

function makeRegistry(available: string[]) {
	return {
		find: (provider: string, id: string) =>
			available.includes(`${provider}/${id}`) ? { provider, id } : undefined,
		hasConfiguredAuth: (model: { provider: string; id: string }) =>
			available.includes(`${model.provider}/${model.id}`),
	};
}

function makeCtx(): Record<string, unknown> {
	return {
		cwd: env.testCwd,
		model: GLOBAL_MODEL,
		modelRegistry: makeRegistry([`${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`]),
		getSystemPrompt: () => "You are a helpful assistant.",
		ui: {
			notify: () => {},
			setStatus: () => {},
			theme: { fg: (_c: string, t: string) => t, bold: (t: string) => t },
		},
		sessionManager: {
			getEntries: () => capturedEntries,
			appendCustomEntry: (entry: unknown) => capturedEntries.push(entry),
		},
		hasUI: false,
	};
}

type Ctx = ReturnType<typeof makeCtx>;

function seedRunEntry(ctx: Ctx, run: SubagentRun): void {
	capturedEntries = [{ type: "custom", customType: CUSTOM_ENTRY_TYPES.run, data: run }];
	(ctx.sessionManager as { getEntries: () => unknown[] }).getEntries = () => capturedEntries;
}

function makeRun(id: string, task: string, originalParams?: Record<string, unknown>): SubagentRun {
	return {
		id,
		task,
		status: "failed",
		model: `${GLOBAL_MODEL.provider}/${GLOBAL_MODEL.id}`,
		thinkingLevel: "medium",
		startedAt: new Date().toISOString(),
		...(originalParams ? { originalParams } : {}),
	};
}

async function execute(
	params: Record<string, unknown>,
	ctx: Ctx = makeCtx(),
): Promise<Awaited<ReturnType<ToolEntry["execute"]>>> {
	vi.useFakeTimers();
	try {
		return await tool.execute("call-jev", params, undefined, undefined, ctx);
	} finally {
		vi.clearAllTimers();
		vi.useRealTimers();
	}
}

/** The exact dispatch shape the 2026-10-31 misses took: a long critique brief,
 * no `jev:` line anywhere (the template render replaced the task text). */
const PLAN_CRITIQUE_TASK = [
	"Critique the implementation brief at .development/investigations/issue-412-decision-rules-brief-2026-10-31.md.",
	"",
	"Read the brief in full, then verify its claims against the tree. Report:",
	"- BLOCKERS: claims that are wrong or unexecutable.",
	"- MAJORS: seams the brief mis-describes.",
	"",
	"## Verdict",
	"State one of: sound | needs-work | unsound.",
].join("\n");

/** Opt the temp project in, exactly as this repository's package.json does. */
function optIn(): void {
	writeFileSync(
		path.join(env.testCwd, "package.json"),
		JSON.stringify({ name: "fixture-project", "brl-subagent": { processChecks: true } }, null, 2),
		"utf8",
	);
}

beforeEach(() => {
	env.setUp();
	capturedEntries = [];
	h.runSubagent.mockReset();
	h.runSubagent.mockImplementation(
		async (_cwd: string, _prompt: string, model: { provider: string; id: string }) =>
			makeResult(`${model.provider}/${model.id}`),
	);
	h.getPiInvocation.mockReset();
	h.getPiInvocation.mockReturnValue({ command: process.execPath, args: [] });
	h.spawnBackgroundSession.mockReset();
	spawnSeq = 0;
	h.spawnBackgroundSession.mockImplementation(
		async (_pi: unknown, _ctx: unknown, p: SpawnParams) => makeFakeAgent(p),
	);
	sessionStartHandler = undefined;
	tool = setupExtension();
});

afterEach(() => {
	vi.clearAllTimers();
	vi.useRealTimers();
});

afterAll(async () => {
	await env.tearDown();
});

// ---------------------------------------------------------------------------
// The seven pre-spawn paths — all reject before anything spawns
// ---------------------------------------------------------------------------

describe("a missing Jev line is rejected at every pre-spawn site (opt-in project)", () => {
	it("single foreground (the incident path: the validator called directly)", async () => {
		optIn();
		const result = await execute({ task: "Implement the thing.", background: false });

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/missing Jev dispatch line/);
		expect(result.content[0].text).toContain("jev: <level> (<0.xx>) · C<1|2|3> · worktree <y|n>");
		expect(h.runSubagent).not.toHaveBeenCalled();
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
	});

	it("single background (spawnBackgroundRun)", async () => {
		optIn();
		const result = await execute({ task: "Implement the thing.", background: true });

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/missing Jev dispatch line/);
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
		expect(h.runSubagent).not.toHaveBeenCalled();
	});

	it("tasks fan-out (runBackgroundFanOut)", async () => {
		optIn();
		const result = await execute({
			background: true,
			tasks: [{ task: "unit one", label: "one" }],
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(`Task 1 ("one")`);
		expect(result.content[0].text).toMatch(/missing Jev dispatch line/);
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
	});

	it("chain (mode prologue → per-step pre-pass)", async () => {
		optIn();
		const result = await execute({ chain: [{ task: "step one" }, { task: "step two" }] });

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/missing Jev dispatch line/);
		expect(h.runSubagent).not.toHaveBeenCalled();
	});

	it("parallel tasks (mode prologue → per-unit pre-pass)", async () => {
		optIn();
		const result = await execute({ tasks: [{ task: "unit one", label: "one" }] });

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain(`Task 1 ("one")`);
		expect(result.content[0].text).toMatch(/missing Jev dispatch line/);
		expect(h.runSubagent).not.toHaveBeenCalled();
	});

	it("graph (mode prologue → per-node pre-pass)", async () => {
		optIn();
		const result = await execute({ graph: [{ id: "a", task: "node a" }] });

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/missing Jev dispatch line/);
		expect(h.runSubagent).not.toHaveBeenCalled();
	});

	// The mode-entry H1 site is the seventh pre-spawn path, and it is a NO-OP
	// for the line BY DESIGN: a batch dispatch cannot carry a mode-level `task`
	// (single-vs-batch exclusivity rejects it), so mode entry has no task text of
	// its own to audit — every unit's text is checked by the per-unit pre-pass
	// above, and the ratchet pins that mode entry still forwards cwd + noJev.
	it("mode entry has no task text of its own — a batch dispatch is checked per unit", async () => {
		optIn();
		const result = await execute({ task: "mode-level text with no line", chain: [{ task: "step one" }] });

		expect(result.isError).toBe(true);
		// Refused by mode exclusivity, not by the line check — no text reaches
		// mode entry, and nothing spawned.
		expect(result.content[0].text).toMatch(/Provide exactly one of/);
		expect(h.runSubagent).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// The opt-in is per project — a user's dispatch is never rejected
// ---------------------------------------------------------------------------

describe("no opt-in means no check (the product is unchanged for users)", () => {
	it("the same foreground task dispatches normally without a package.json opt-in", async () => {
		const result = await execute({ task: "Implement the thing.", background: false });

		expect(result.isError).toBeFalsy();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
	});

	it("a package.json with processChecks:false is still off", async () => {
		writeFileSync(
			path.join(env.testCwd, "package.json"),
			JSON.stringify({ name: "fixture", "brl-subagent": { processChecks: false } }),
			"utf8",
		);
		const result = await execute({ task: "Implement the thing.", background: false });

		expect(result.isError).toBeFalsy();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// Our path — THIS checkout opts in via its tracked package.json (#415)
// ---------------------------------------------------------------------------

describe("this repository opts in (processChecks on its own manifest)", () => {
	it("a line-less dispatch from the repo root is rejected before anything spawns", async () => {
		const ctx = makeCtx();
		(ctx as { cwd: string }).cwd = REPO_ROOT;
		const result = await execute({ task: "Implement the thing.", background: false }, ctx);

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/missing Jev dispatch line/);
		expect(h.runSubagent).not.toHaveBeenCalled();
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// The 2026-10-31 fixture — the exact miss shape
// ---------------------------------------------------------------------------

describe("the 2026-10-31 misses (fixture)", () => {
	it("the plan-critique dispatch that carried no line is rejected", async () => {
		optIn();
		const result = await execute({
			task: PLAN_CRITIQUE_TASK,
			background: true,
			thinkingLevel: "high",
			label: "plan-critique",
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toMatch(/missing Jev dispatch line/);
		expect(h.spawnBackgroundSession).not.toHaveBeenCalled();
	});

	it("the same brief WITH the classified line passes", async () => {
		optIn();
		const result = await execute({
			task: `${PLAN_CRITIQUE_TASK}\n\n${VALID_LINE}`,
			background: true,
			thinkingLevel: "high",
			label: "plan-critique",
		});

		expect(result.isError).toBeFalsy();
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// The bypass: noJev states why, is surfaced, and never silently disables
// ---------------------------------------------------------------------------

describe("noJev — the stated, logged bypass", () => {
	it("dispatching with noJev proceeds and surfaces the reason as a warning", async () => {
		optIn();
		const result = await execute({
			task: "Implement the thing.",
			background: false,
			noJev: "classifier unreachable; the maintainer approved this dispatch",
		});

		expect(result.isError).toBeFalsy();
		expect(h.runSubagent).toHaveBeenCalledTimes(1);
		const text = result.content[0].text;
		expect(text).toContain("[pre-task validation warnings]");
		expect(text).toContain("noJev");
		expect(text).toContain("classifier unreachable; the maintainer approved this dispatch");
	});

	it("noJev is NOT a silent kill switch — the same dispatch without it is rejected", async () => {
		optIn();
		const withoutBypass = await execute({ task: "Implement the thing.", background: false });
		expect(withoutBypass.isError).toBe(true);
	});

	it("noJev does not rescue a real capability conflict (it bypasses the line check only)", async () => {
		optIn();
		const result = await execute({
			task: `run the test suite\n\n${VALID_LINE}`,
			tools: ["read", "write", "edit"],
			noJev: "unused here",
		});

		expect(result.isError).toBe(true);
		expect(result.content[0].text).toContain("'bash'");
		expect(h.runSubagent).not.toHaveBeenCalled();
	});
});

// ---------------------------------------------------------------------------
// Retries inherit the original's line — no re-check, no new line required
// ---------------------------------------------------------------------------

describe("retry inheritance", () => {
	it("a retry of a run whose task carried the line passes without repeating it", async () => {
		optIn();
		const ctx = makeCtx();
		// The original was a BACKGROUND run (the ones that write a run record and
		// can be auto-retried); the retry re-uses the recorded task, so the line
		// the original carried is the line the retry passes with — no `noJev`.
		seedRunEntry(ctx, makeRun("retry-jev-1", `Background single run\n\n${VALID_LINE}`, { background: true }));

		const result = await execute({ retryRunId: "retry-jev-1" }, ctx);

		expect(result.isError).toBeFalsy();
		expect(h.spawnBackgroundSession).toHaveBeenCalledTimes(1);
	});
});

// ---------------------------------------------------------------------------
// Coverage ratchet — a NEW pre-spawn path must forward the project cwd
// ---------------------------------------------------------------------------

describe("pre-spawn coverage ratchet", () => {
	/**
	 * Every `validatePreTask({…})` in production code must carry `cwd` (the
	 * field the project-local check keys on) and `noJev` (the bypass), and every
	 * `runPreTaskValidation({ preTask: {…} })` must carry both inside the nested
	 * literal. A new pre-spawn path that constructs the config without them
	 * silently skips the check — this test is what makes that a build failure.
	 *
	 * The one allowed non-literal argument is prelude.ts's pass-through
	 * (`validatePreTask(preTask)`), which receives the config it was handed;
	 * the ratchet therefore checks OBJECT LITERALS only, and the callers of
	 * `runPreTaskValidation` cover the same contract.
	 */
	it("every production validatePreTask/runPreTaskValidation site forwards cwd + noJev", () => {
		const srcDir = path.resolve(__dirname, "..");
		const sources = readdirSync(srcDir)
			.filter((f) => f.endsWith(".ts"))
			.map((file) => ({
				path: path.join(srcDir, file),
				text: readFileSync(path.join(srcDir, file), "utf8"),
			}));

		const offenders: string[] = [];
		const sites: string[] = [];

		for (const [absolute, source] of parseTexts(sources)) {
			const file = path.basename(absolute);
			const visit = (node: Node): void => {
				if (
					isCallExpression(node) &&
					isIdentifier(node.expression) &&
					(node.expression.text === "validatePreTask" || node.expression.text === "runPreTaskValidation")
				) {
					const callee = node.expression.text;
					const arg = node.arguments[0] as Node | undefined;
					if (arg === undefined || arg.kind !== SyntaxKind.ObjectLiteralExpression) {
						// The one allowed non-literal site: prelude.ts's pass-through
						// (`validatePreTask(preTask)`) forwards the config it was handed.
						// It still counts as a site — the scan must see the seam it
						// depends on, and the literal callers above are what the keys are
						// checked on.
						if (callee === "validatePreTask") sites.push(`${file}:validatePreTask(pass-through)`);
						node.forEachChild(visit);
						return;
					}
					const literal = arg as Node & { properties?: Node[] };
					const properties = literal.properties ?? [];
					const names = properties.map((p) => (p as Node & { name?: { text?: string } }).name?.text ?? "");
					if (callee === "validatePreTask") {
						sites.push(`${file}:validatePreTask`);
						const missing = ["cwd", "noJev"].filter((k) => !names.includes(k));
						if (missing.length > 0) offenders.push(`${file}:validatePreTask missing ${missing.join(",")}`);
					} else {
						const preTask = properties.find((p) => (p as Node & { name?: { text?: string } }).name?.text === "preTask");
						const nested = (preTask as (Node & { initializer?: Node }) | undefined)?.initializer;
						const nestedNames =
							nested && nested.kind === SyntaxKind.ObjectLiteralExpression
								? (((nested as Node & { properties?: Node[] }).properties ?? []).map(
										(p) => (p as Node & { name?: { text?: string } }).name?.text ?? "",
									))
								: [];
						sites.push(`${file}:runPreTaskValidation`);
						const missing = ["cwd", "noJev"].filter((k) => !nestedNames.includes(k));
						if (missing.length > 0) {
							offenders.push(`${file}:runPreTaskValidation preTask missing ${missing.join(",")}`);
						}
					}
				}
				node.forEachChild(visit);
			};
			source.forEachChild(visit);
		}

		expect(offenders, `a pre-spawn path skips the project Jev check: ${offenders.join("; ")}`).toEqual([]);
		// Coverage assertion (Rule 19): the ratchet must actually have walked the
		// sites — an empty scan is a silent pass.
		expect(sites.length).toBeGreaterThanOrEqual(6);
	});
});

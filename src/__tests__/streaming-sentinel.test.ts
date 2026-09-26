/**
 * Live partial updates are streaming state, not a verdict (issue #206).
 *
 * `emitSubagentUpdate` (src/runner.ts) is the single emission point for every
 * streaming update in every foreground mode (`parseSubagentLine` on
 * `message_end`/`tool_result_end` plus the throttled `emitLiveUpdate` delta
 * path). It used to emit `details: { ...result }`, and the renderer
 * classifies every update with `isSubagentError(details)` — a SETTLED-result
 * predicate. Mid-run that mislabels a live partial: after the first tool turn
 * `stopReason` is `"toolUse"` (→ ✗) and before the first turn it is unset
 * (→ ✓).
 *
 * These tests pin the fix at both levels:
 *  1. the emitted partial carries the unsettled sentinel `exitCode: -1`
 *     (while the accumulator / final result keeps the REAL exit code), and
 *  2. the renderer shows such a partial as running — never an icon — while a
 *     run that genuinely ENDS on a tool turn still renders ✗ (kept #179
 *     semantics: only the streaming state changed).
 */

import { describe, it, expect, vi } from "vitest";

// Mock spawn so runSubagent never launches a real process (harness as in
// runner.test.ts; the tui import graph never reaches node:child_process).
const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock("node:child_process", () => ({
	spawn: mocks.spawn,
	execFileSync: vi.fn(),
}));

import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { Theme, ToolRenderResultOptions } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import { runSubagent, parseSubagentLine } from "../runner";
import { renderDelegateResult } from "../tui";
import { EMPTY_USAGE, isSubagentError } from "../types";
import type { SubagentResult } from "../types";

// ---------------------------------------------------------------------------
// Event-line builders (JSON, exactly as the subprocess stdout emits)
// ---------------------------------------------------------------------------

/** Assistant message_end — after a tool turn pi stamps stopReason "toolUse". */
const assistantEnd = (stopReason?: string): string =>
	JSON.stringify({
		type: "message_end",
		message: {
			role: "assistant",
			model: "test/model",
			...(stopReason ? { stopReason } : {}),
			usage: { input: 10, output: 5 },
			content: [{ type: "text", text: "working on it" }],
		},
	});

const userEnd = (): string =>
	JSON.stringify({
		type: "message_end",
		message: { role: "user", content: [{ type: "text", text: "do the thing" }] },
	});

const toolResultEnd = (): string =>
	JSON.stringify({
		type: "tool_result_end",
		message: {
			role: "toolResult",
			toolCallId: "call_1",
			toolName: "bash",
			content: [{ type: "text", text: "ok" }],
		},
	});

/** message_update — the throttled delta path (emitLiveUpdate). */
const update = (assistantMessageEvent: Record<string, unknown>): string =>
	JSON.stringify({
		type: "message_update",
		usage: { input: 1, output: 1 },
		assistantMessageEvent,
	});

const freshResult = (): SubagentResult => ({
	messages: [],
	usage: { ...EMPTY_USAGE },
	exitCode: 0,
	stderr: "",
});

const collect = (into: Array<AgentToolResult<SubagentResult>>) =>
	(partial: AgentToolResult<SubagentResult>) => {
		into.push(partial);
	};

/** The theme shape the renderer actually consumes (identity, no ANSI). */
const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const collapsed: ToolRenderResultOptions = { expanded: false, isPartial: false };

function renderLines(result: AgentToolResult<SubagentResult>): string {
	const node = renderDelegateResult(result as never, collapsed, theme);
	expect(node).toBeInstanceOf(Text);
	return (node as Text).render(160).join("\n");
}

// ---------------------------------------------------------------------------
// Level 1 — the emitted partial (lowest observable point)
// ---------------------------------------------------------------------------

describe("streaming partials carry the unsettled sentinel (issue #206)", () => {
	it("parseSubagentLine: every partial has exitCode -1; the accumulator keeps its real code", () => {
		const result = freshResult();
		const partials: Array<AgentToolResult<SubagentResult>> = [];
		const onUpdate = collect(partials);
		const lines = [
			userEnd(), // before the first turn settles (pre-fix: rendered ✓)
			update({ type: "text_start", contentIndex: 0 }), // throttled delta path
			assistantEnd("toolUse"), // after the tool turn (pre-fix: rendered ✗)
			toolResultEnd(),
			update({ type: "text_end", contentIndex: 0, content: "working on it" }),
		];
		for (const line of lines) {
			parseSubagentLine(line, result, onUpdate, () => "live output");
		}

		// Every emitted partial is stamped unsettled…
		expect(partials.length).toBeGreaterThanOrEqual(4);
		for (const partial of partials) {
			expect(partial.details.exitCode).toBe(-1);
		}

		// …while the accumulator itself is untouched: its exitCode stays the
		// real (still-unsettled) value, never the sentinel.
		expect(result.exitCode).toBe(0);

		// The pre-first-turn partial: no stopReason yet, yet already running.
		expect(partials[0].details.exitCode).toBe(-1);
		expect(partials[0].details.stopReason).toBeUndefined();

		// The tool-turn partial carries the verdict-looking mid-run state —
		// which the settled predicate reads as a failure. The sentinel is what
		// keeps that out of the icon until the run actually ends.
		const toolTurn = partials.find((p) => p.details.stopReason === "toolUse");
		expect(toolTurn).toBeDefined();
		expect(toolTurn!.details.exitCode).toBe(-1);
		expect(isSubagentError(result)).toBe(true); // settled verdict, once settled (#179)
	});

	it("runSubagent: partials stay -1 through the run; the final result carries the real exit code", async () => {
		// Fake child process: handlers are captured, then driven by the test.
		const handlers = new Map<string, Array<(...args: unknown[]) => void>>();
		const on = (event: string, cb: (...args: unknown[]) => void) => {
			const list = handlers.get(event) ?? [];
			list.push(cb);
			handlers.set(event, list);
			return proc;
		};
		const proc = {
			stdout: { on: (event: string, cb: (...args: unknown[]) => void) => on(`stdout:${event}`, cb) },
			stderr: { on: (event: string, cb: (...args: unknown[]) => void) => on(`stderr:${event}`, cb) },
			on,
			kill: vi.fn(),
			pid: 4242,
			killed: false,
		};
		const emit = (event: string, ...args: unknown[]) => {
			for (const cb of handlers.get(event) ?? []) cb(...args);
		};
		mocks.spawn.mockReturnValue(proc);

		const partials: Array<AgentToolResult<SubagentResult>> = [];
		const promise = runSubagent(
			"/tmp/cwd",
			"", // no system prompt → no temp-file writes
			{ provider: "test", id: "model" },
			"medium",
			"task",
			undefined,
			collect(partials),
			undefined,
			undefined,
			() => "live output",
		);
		await vi.waitFor(() => expect(mocks.spawn).toHaveBeenCalled());

		emit(
			"stdout:data",
			Buffer.from(
				[userEnd(), assistantEnd("toolUse"), toolResultEnd(), update({ type: "text_start", contentIndex: 0 })].join("\n") + "\n",
			),
		);
		emit("close", 1); // the process genuinely failed

		const result = await promise;

		// Streaming state: every partial unsettled, including the tool-turn one.
		expect(partials.length).toBeGreaterThan(0);
		for (const partial of partials) {
			expect(partial.details.exitCode).toBe(-1);
		}
		expect(partials.some((p) => p.details.stopReason === "toolUse")).toBe(true);

		// The ACTUAL emitted tool-turn partial renders as running — never an
		// icon — while the settled result (rendered the way the final tool
		// result is) still shows the failure icon.
		const toolTurnPartial = partials.find((p) => p.details.stopReason === "toolUse");
		const liveOut = renderLines(toolTurnPartial!);
		expect(liveOut).not.toContain("\u2717");
		expect(liveOut).not.toContain("\u2713");
		const settled: AgentToolResult<SubagentResult> = {
			content: [{ type: "text", text: "final answer" }],
			details: result,
		};
		expect(renderLines(settled)).toContain("\u2717");

		// Settled state: the returned result keeps the REAL exit code (the
		// sentinel is never persisted onto it) and classifies as a failure.
		expect(result.exitCode).toBe(1);
		expect(result.stopReason).toBe("toolUse");
		expect(isSubagentError(result)).toBe(true);
	});
});

// ---------------------------------------------------------------------------
// Level 2 — the renderer
// ---------------------------------------------------------------------------

describe("renderDelegateResult renders streaming state as running, never as a verdict (issue #206)", () => {
	const liveDetails = (overrides: Partial<SubagentResult>): SubagentResult => ({
		...freshResult(),
		model: "test/model",
		messages: [{ role: "assistant", content: [{ type: "text", text: "final answer" }] }],
		...overrides,
	});

	it("a partial with stopReason toolUse renders as running text, never ✗", () => {
		const partial: AgentToolResult<SubagentResult> = {
			content: [{ type: "text", text: "searching files…" }],
			details: liveDetails({ exitCode: -1, stopReason: "toolUse" }),
		};
		const out = renderLines(partial);
		expect(out).toContain("searching files…");
		expect(out).not.toContain("\u2717");
		expect(out).not.toContain("\u2713");
	});

	it("a partial before the first turn renders as running, never ✓", () => {
		const partial: AgentToolResult<SubagentResult> = {
			content: [{ type: "text", text: "(starting…)" }],
			details: liveDetails({ exitCode: -1, stopReason: undefined }),
		};
		const out = renderLines(partial);
		expect(out).not.toContain("\u2713");
		expect(out).not.toContain("\u2717");
	});

	it("a settled run that ENDS on a tool turn still renders ✗ (kept semantics)", () => {
		const settled: AgentToolResult<SubagentResult> = {
			content: [{ type: "text", text: "final answer" }],
			details: liveDetails({ exitCode: 0, stopReason: "toolUse" }),
		};
		expect(renderLines(settled)).toContain("\u2717");
	});

	it("a settled successful run still renders ✓", () => {
		const settled: AgentToolResult<SubagentResult> = {
			content: [{ type: "text", text: "final answer" }],
			details: liveDetails({ exitCode: 0, stopReason: "stop" }),
		};
		expect(renderLines(settled)).toContain("\u2713");
	});
});

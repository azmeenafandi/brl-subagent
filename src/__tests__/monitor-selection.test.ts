/**
 * Issue #423 — the live monitor's row ORDER and SELECTION IDENTITY.
 *
 * Three pinned behaviours, each with a named mutation target:
 *
 *  1. rows are ordered by the soonest deadline and settled ids are filtered out
 *     (mutations: keep the raw map order / drop the finalize filter);
 *  2. Enter opens the row that was HIGHLIGHTED, even when the live map shifts
 *     between paint and Enter — the handler resolves against the rendered id
 *     list, not `subagentSessions.keys()` (mutation: re-derive the id from the
 *     map, which re-inserts the first-spawned agent at index 0 and opens it);
 *  3. the up/down wrap is bounded by the RENDERED list, not the live map, so a
 *     spawn between paint and Enter cannot park the cursor on a row that is not
 *     on screen (mutation: wrap over `state.subagentSessions.size`).
 *
 * The fixture is built so every wrong answer is DISTINCT: the first-inserted
 * entry has the earlier `startedAt` and the LATER deadline, so a handler that
 * sorts by start time and a handler that trusts insertion order both open the
 * wrong agent.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { createSessionState } from "../state";
import { showMonitor } from "../tui";
import { CUSTOM_ENTRY_TYPES, type LiveSubagent, type SubagentRun } from "../types";

// ---------------------------------------------------------------------------
// Harness — a fake `ctx.ui.custom` that keeps every overlay it builds
// ---------------------------------------------------------------------------

type OverlayComponent = Component & { handleInput(data: string): void };

const PLAIN_THEME = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as never;

/** Key bindings the monitor and the drill-in ask `matches` about. */
const KEYS: Record<string, string> = {
	"tui.select.up": "\u001b[A",
	"tui.select.down": "\u001b[B",
	"tui.select.confirm": "\r",
	"tui.select.cancel": "\u001b",
};

const KB = { matches: (data: string, key: string) => KEYS[key] === data };

const NOW = 1_500_000;

interface Harness {
	ctx: ExtensionContext;
	/** Every overlay built so far, in call order: [0] = monitor, [1] = drill-in. */
	overlays: OverlayComponent[];
	state: ReturnType<typeof createSessionState>;
}

function makeHarness(): Harness {
	const state = createSessionState();
	const overlays: OverlayComponent[] = [];
	const runningEntries = (): SubagentRun[] =>
		Array.from(state.subagentSessions.keys()).map((id) => runningRun(id));
	const ctx = {
		ui: {
			theme: PLAIN_THEME,
			notify: vi.fn(),
			setStatus: vi.fn(),
			custom: (factory: (tui: unknown, theme: unknown, kb: unknown, done: () => void) => OverlayComponent) => {
				// Called synchronously inside showMonitor / showAgentDetail, so the
				// overlay exists as soon as the handler returns.
				const component = factory(
					{ requestRender: () => {}, terminal: { rows: 24 } },
					PLAIN_THEME,
					KB,
					() => {},
				);
				overlays.push(component);
				return Promise.resolve();
			},
		},
		sessionManager: {
			getEntries: () =>
				runningEntries().map((run) => ({
					type: "custom",
					customType: CUSTOM_ENTRY_TYPES.run,
					data: run,
				})),
		},
		cwd: "/tmp/project",
	} as unknown as ExtensionContext;
	return { ctx, overlays, state };
}

/** A 'running' run entry — what keeps the stale sweep from finalizing a row. */
function runningRun(id: string): SubagentRun {
	return {
		id,
		task: `task ${id.slice(0, 8)}`,
		status: "running",
		model: "provider/model",
		thinkingLevel: "low",
		startedAt: new Date(NOW - 1_000).toISOString(),
		originalParams: {},
	};
}

function register(
	state: Harness["state"],
	ctx: ExtensionContext,
	id: string,
	startedAt: number,
	deadlineAt?: number,
): void {
	const entry: LiveSubagent = {
		id,
		label: id.slice(0, 8),
		task: `task ${id.slice(0, 8)}`,
		model: "provider/model",
		thinkingLevel: "low",
		startedAt,
		...(deadlineAt !== undefined ? { deadlineAt } : {}),
		liveOutput: "",
		usage: { input: 0, output: 0 },
		ctx,
	};
	state.subagentSessions.set(id, entry);
}

/** The rendered monitor lines. */
function paint(harness: Harness): string[] {
	return harness.overlays[0].render(80);
}

/**
 * The monitor's ROW lines: the accent line of each entry (the only lines that
 * carry a braille spinner frame). The dim/secondary lines have none.
 */
function rowLines(lines: string[]): string[] {
	return lines.filter((line) => /[\u280B-\u280F]/.test(line)).map((line) => line.replace(/\u001b\[[0-9;]*m/g, ""));
}

/** The line carrying the selection marker, if any. */
function selectedLine(lines: string[]): string | undefined {
	return lines.find((line) => line.includes("\u203a "));
}

const A = "aaaaaaaa-1111-4111-8111-11111111111a";
const B = "bbbbbbbb-2222-4222-8222-22222222222b";
const C = "cccccccc-3333-4333-8333-33333333333c";
const D = "dddddddd-4444-4444-8444-44444444444d";

describe("monitor row order and filtering (issue #423)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("orders rows by the soonest deadline and drops a settled id", async () => {
		const { ctx, overlays, state } = makeHarness();
		// Insertion order is A (later deadline), B (sooner deadline), C (soonest,
		// but settled) — so neither insertion order nor a start-time sort gives
		// the expected B, A.
		register(state, ctx, A, NOW - 100_000, NOW + 500_000);
		register(state, ctx, B, NOW - 10_000, NOW + 50_000);
		register(state, ctx, C, NOW - 200_000, NOW + 5_000);
		state.finalizeLiveSubagent(C);

		await showMonitor(ctx, state);
		const lines = paint({ ctx, overlays, state });

		expect(lines.join("\n")).toContain("Subagent Monitor (2 active)");
		expect(lines.join("\n")).not.toContain(C.slice(0, 8));
		const rows = rowLines(lines);
		expect(rows).toHaveLength(2);
		expect(rows[0]).toContain(B.slice(0, 8));
		expect(rows[1]).toContain(A.slice(0, 8));
		// The budget segment is on the row: used / budget (percent left).
		expect(rows[1]).toContain("1m 40s / 10m (83% left)");
	});

	it("marks only the selected row and wraps over the rendered list", async () => {
		const { ctx, overlays, state } = makeHarness();
		register(state, ctx, A, NOW - 100_000, NOW + 500_000);
		register(state, ctx, B, NOW - 10_000, NOW + 50_000);

		await showMonitor(ctx, state);
		expect(selectedLine(paint({ ctx, overlays, state }))).toContain(B.slice(0, 8));

		overlays[0].handleInput(KEYS["tui.select.down"]);
		expect(selectedLine(paint({ ctx, overlays, state }))).toContain(A.slice(0, 8));

		overlays[0].handleInput(KEYS["tui.select.down"]);
		expect(selectedLine(paint({ ctx, overlays, state }))).toContain(B.slice(0, 8));
	});
});

describe("monitor drill-in identity across a shift between paint and Enter (issue #423)", () => {
	beforeEach(() => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
	});

	afterEach(() => {
		vi.useRealTimers();
	});

	it("opens the highlighted row after another row is finalized", async () => {
		const { ctx, overlays, state } = makeHarness();
		// A is inserted FIRST with the earlier startedAt and the LATER deadline, so
		// "opened A" is what both a start-time sort and a trust-insertion-order
		// handler produce. The highlighted row is B.
		register(state, ctx, A, NOW - 100_000, NOW + 500_000);
		register(state, ctx, B, NOW - 10_000, NOW + 50_000);

		await showMonitor(ctx, state);
		const highlighted = selectedLine(paint({ ctx, overlays, state }));
		expect(highlighted).toBeDefined();
		expect(highlighted).toContain(B.slice(0, 8));

		// The list changes between paint and Enter: the OTHER row settles (it
		// lingers in the map for 3 s, so a keys()-derived list still offers it).
		state.finalizeLiveSubagent(A);
		overlays[0].handleInput(KEYS["tui.select.confirm"]);

		expect(overlays).toHaveLength(2); // the drill-in opened
		const detail = overlays[1].render(80).join("\n");
		expect(detail).toContain(`[${B.slice(0, 8)}]`);
		expect(detail).not.toContain(`[${A.slice(0, 8)}]`);

		overlays[1].handleInput(KEYS["tui.select.cancel"]);
	});

	it("keeps the wrap bound on the rendered list when a row is spawned mid-paint", async () => {
		const { ctx, overlays, state } = makeHarness();
		register(state, ctx, A, NOW - 100_000, NOW + 500_000);
		register(state, ctx, B, NOW - 10_000, NOW + 50_000);

		await showMonitor(ctx, state);
		// The first paint is what establishes the rendered list the handlers use.
		paint({ ctx, overlays, state });
		// A brand-new row lands after the paint. Wrapping over the live MAP size
		// (3) would park the cursor at index 2 — a row that is not on screen.
		register(state, ctx, D, NOW - 1_000, NOW + 900_000);
		overlays[0].handleInput(KEYS["tui.select.down"]);
		overlays[0].handleInput(KEYS["tui.select.down"]);

		overlays[0].handleInput(KEYS["tui.select.confirm"]);

		expect(overlays).toHaveLength(2);
		const detail = overlays[1].render(80).join("\n");
		expect(detail).toContain(`[${B.slice(0, 8)}]`);

		overlays[1].handleInput(KEYS["tui.select.cancel"]);
	});
});

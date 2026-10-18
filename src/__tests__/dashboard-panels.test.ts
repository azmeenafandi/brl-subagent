// Purpose: Pins the E1 observability dashboard's rendered output (issue #356) — the six panels, their order,
// labels, spacing, width padding and colour vocabulary — so the `showDashboard` SRP split is provably
// byte-identical. Two halves:
//  1. COMPOSER (`showDashboard`) — the goldens were captured from the PRE-SPLIT composer and are asserted
//     unchanged as one full screen, panel-by-panel offsets included.
//  2. PANELS (`renderDashboard*Panel`) — each panel is rendered standalone from its own data slice and
//     compared to the same golden, so a panel that drifts alone fails a named test.
import { describe, expect, it, vi, afterEach } from "vitest";
import { Container, Text, type Component } from "@earendil-works/pi-tui";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { SessionState } from "../state";
import {
	renderDashboardActivePanel,
	renderDashboardCostTrendPanel,
	renderDashboardErrorPanel,
	renderDashboardHeader,
	renderDashboardRecentRunsPanel,
	renderDashboardSlaPanel,
	showDashboard,
} from "../tui";
import { computeCostTrend, computeSLAMetrics } from "../metrics";
import { CUSTOM_ENTRY_TYPES, type LiveSubagent, type SubagentRun } from "../types";

// ---------------------------------------------------------------------------
// Theme fixtures — plain (layout + text) and recording (colour vocabulary)
// ---------------------------------------------------------------------------

const PLAIN_THEME = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

/** Records every `fg` call as `[color, text]`, returning the text unchanged. */
function recordingTheme(): { theme: Theme; calls: Array<[string, string]> } {
	const calls: Array<[string, string]> = [];
	const theme = {
		fg: (color: string, text: string) => {
			calls.push([color, pinTime(text)]);
			return text;
		},
		bold: (text: string) => text,
	} as unknown as Theme;
	return { theme, calls };
}

// ---------------------------------------------------------------------------
// Fixtures — a rich session (live rows, mixed outcomes, costs, error categories)
// and an empty one (every panel's empty branch)
// ---------------------------------------------------------------------------

/** The frozen clock every render uses: spinner frame, elapsed and SLA all derive from it. */
const NOW = new Date("2026-01-02T03:10:00.000Z").getTime();

const RUNNING_A = "11111111-aaaa";
const RUNNING_B = "22222222-bbbb";

function run(over: Partial<SubagentRun> & { id: string }): SubagentRun {
	return {
		task: `task ${over.id}`,
		status: "done",
		model: "anthropic/claude-sonnet-4",
		thinkingLevel: "medium",
		startedAt: "2026-01-02T03:00:00.000Z",
		...over,
	} as SubagentRun;
}

/** The newest-first run history `getRunEntries` returns for the rich fixture. */
function richRuns(): SubagentRun[] {
	return [
		run({ id: RUNNING_B, status: "running", startedAt: "2026-01-02T03:09:40.000Z" }),
		run({ id: RUNNING_A, status: "running", startedAt: "2026-01-02T03:09:30.000Z" }),
		run({ id: "aaaaaaaa-1", label: "impl-footer", durationMs: 1500, cost: 0.0123, startedAt: "2026-01-02T03:09:00.000Z" }),
		run({ id: "bbbbbbbb-2", status: "failed", durationMs: 65_000, cost: 0.2, errorMessage: "boom", startedAt: "2026-01-02T03:08:00.000Z" }),
		run({
			id: "cccccccc-3",
			task: "a very long task description that goes past fifty chars easily yes",
			status: "running",
			startedAt: "2026-01-02T03:07:00.000Z",
		}),
		run({ id: "dddddddd-4", durationMs: 900, startedAt: "2026-01-02T03:06:00.000Z" }),
		run({
			id: "eeeeeeee-5",
			status: "failed",
			durationMs: 2000,
			originalParams: { errorCategory: "timeout" } as never,
			startedAt: "2026-01-02T03:05:00.000Z",
		}),
		run({
			id: "ffffffff-6",
			status: "failed",
			durationMs: 2500,
			originalParams: { errorCategory: "timeout" } as never,
			startedAt: "2026-01-02T03:04:00.000Z",
		}),
		run({
			id: "77777777-7",
			status: "failed",
			durationMs: 3000,
			originalParams: { errorCategory: "auth" } as never,
			startedAt: "2026-01-02T03:03:00.000Z",
		}),
	];
}

/** The live map behind the Active Subagents panel (two rows: labelled and task-named). */
function liveSessions(ctx: ExtensionContext): Map<string, LiveSubagent> {
	const base = { model: "m", thinkingLevel: "low", liveOutput: "", ctx } as const;
	return new Map<string, LiveSubagent>([
		[
			RUNNING_A,
			{ ...base, id: RUNNING_A, label: "my-label", task: "some task", startedAt: NOW - 65_000, usage: { input: 1234, output: 567 } },
		],
		[
			RUNNING_B,
			{
				...base,
				id: RUNNING_B,
				task: "another task with no label at all and a long tail",
				startedAt: NOW - 4_000,
				usage: { input: 10, output: 20 },
			},
		],
	]);
}

function makeCtx(entries: () => SubagentRun[]): ExtensionContext {
	return {
		ui: { theme: PLAIN_THEME, notify: vi.fn(), setStatus: vi.fn() },
		sessionManager: {
			getEntries: () =>
				entries().map((r) => ({ type: "custom", customType: CUSTOM_ENTRY_TYPES.run, data: r })),
		},
		cwd: "/tmp/project",
	} as unknown as ExtensionContext;
}

/** A state with no live rows and no run history (every panel's empty branch). */
function emptyState(): { state: SessionState; ctx: ExtensionContext } {
	const ctx = makeCtx(() => []);
	return { state: new SessionState(), ctx };
}

/** A state whose live map and run history are the rich fixture above. */
function richState(): { state: SessionState; ctx: ExtensionContext } {
	const ctx = makeCtx(richRuns);
	const state = new SessionState();
	for (const [id, session] of liveSessions(ctx)) state.subagentSessions.set(id, session);
	return { state, ctx };
}

// ---------------------------------------------------------------------------
// The composer harness — render whichever screen `showDashboard` builds
// ---------------------------------------------------------------------------

/** Width every render in this file uses (wide enough that nothing wraps). */
const WIDTH = 80;

/** The locale-dependent clock in the header collapses to one token. */
function pinTime(text: string): string {
	return text.replace(/(refreshing \u00b7 ).*$/, "$1<time>");
}

/** Pin the clock, then restore the line's width so padding is still asserted. */
function normalizeLine(line: string): string {
	return pinTime(line).padEnd(line.length);
}

/** Render the dashboard screen `showDashboard` builds, at {@link WIDTH}, then close it. */
async function renderDashboard(
	state: SessionState,
	ctx: ExtensionContext,
	theme: Theme = PLAIN_THEME,
): Promise<string[]> {
	let lines: string[] = [];
	(ctx.ui as unknown as Record<string, unknown>).custom = (
		factory: (
			tui: unknown,
			theme: Theme,
			kb: unknown,
			done: () => void,
		) => Component & { handleInput(data: string): void },
	) => {
		const component = factory({ requestRender: () => {} }, theme, {}, () => {});
		lines = component.render(WIDTH).map(normalizeLine);
		// Closes the screen, which clears the 2 s auto-refresh interval.
		component.handleInput("q");
		return Promise.resolve();
	};
	await showDashboard(ctx, state);
	return lines;
}

/** Render a panel's components standalone at {@link WIDTH} — no composer involved. */
function panelLines(components: Component[]): string[] {
	const container = new Container();
	for (const child of components) container.addChild(child);
	return container.render(WIDTH).map(normalizeLine);
}

afterEach(() => {
	vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Goldens — captured from the pre-split composer (issue #356)
// ---------------------------------------------------------------------------

/** Both panel stacks are framed by two full-width borders (top, bottom). */
const BORDER = "\u2500".repeat(WIDTH);

/** Panel 1 — header (the clock is pinned to `<time>`). */
const RICH_HEADER = [
	" brl-subagent Dashboard  refreshing · <time>                                    ",
];

/** Panel 2 — active subagents: title carrying the count, one row per live entry. */
const RICH_ACTIVE = [
	" Active Subagents (2)                                                           ",
	"   ⠋ my-label  [11111111]  ↑1.2k ↓567  1m 5s                                    ",
	"   ⠋ another task with no label at all and a   [22222222]  ↑10 ↓20  4s          ",
];

/** Panel 3 — SLA summary: success rate, p50/p95/p99, cost. */
const RICH_SLA = [
	" SLA Summary (last 9 runs)                                                      ",
	"   Success: 33.3% · p50: 2.3s · p95: 49.5s · p99: 1m2s                          ",
	"   Cost:      total $0.2123 · avg $0.0236                                       ",
];

/** Panel 4 — recent runs (up to 10): outcome symbol, name, duration, cost. */
const RICH_RECENT = [
	" Recent Runs                                                                    ",
	"   ● task 22222222-bbbb  ...                                                    ",
	"   ● task 11111111-aaaa  ...                                                    ",
	"   ✓ impl-footer  1.5s $0.0123                                                  ",
	"   ✗ task bbbbbbbb-2  1m5s $0.2000                                              ",
	"   ● a very long task description that goes past fifty   ...                    ",
	"   ✓ task dddddddd-4  900ms                                                     ",
	"   ✗ task eeeeeeee-5  2.0s                                                      ",
	"   ✗ task ffffffff-6  2.5s                                                      ",
	"   ✗ task 77777777-7  3.0s                                                      ",
];

/** Panel 5 — error breakdown: sorted categories with proportional bars. */
const RICH_ERRORS = [
	" Error Breakdown                                                                ",
	"   timeout            ████████████████████ 2                                    ",
	"   auth               ██████████ 1                                              ",
];

/** Panel 6 — cost trend: sparkline plus the run count and cost totals. */
const RICH_TREND = [
	" Cost Trend (last 20 runs)                                                      ",
	"   ▁█                                                                           ",
	"   2 runs · total $0.2123 · avg $0.1062                                         ",
];

/** Chrome — the close hint and the bottom border. */
const RICH_FOOTER = [
	" q / esc to close                                                               ",
	"────────────────────────────────────────────────────────────────────────────────",
];

/** Panel 1 — header. */
const EMPTY_HEADER = [
	" brl-subagent Dashboard  refreshing · <time>                                    ",
];

/** Panel 2 — active subagents, empty branch. */
const EMPTY_ACTIVE = [
	" Active Subagents (0)                                                           ",
	"   None running                                                                 ",
];

/** Panel 3 — SLA summary, empty branch. */
const EMPTY_SLA = [
	" SLA Summary (last 0 runs)                                                      ",
	"   No completed runs yet                                                        ",
];

/** Panel 4 — recent runs, empty branch. */
const EMPTY_RECENT = [
	" Recent Runs                                                                    ",
	"   No runs recorded                                                             ",
];

/** Panel 5 — error breakdown, empty branch. */
const EMPTY_ERRORS = [
	" Error Breakdown                                                                ",
	"   No errors ✓                                                                  ",
];

/** Panel 6 — cost trend, empty branch. */
const EMPTY_TREND = [
	" Cost Trend (last 20 runs)                                                      ",
	"   No cost data                                                                 ",
];

/** Chrome — the close hint and the bottom border. */
const EMPTY_FOOTER = [
	" q / esc to close                                                               ",
	"────────────────────────────────────────────────────────────────────────────────",
];

/** Every `fg` call the rich render makes, in order — the colour vocabulary, panel by panel. */
const RICH_FG_CALLS: Array<[string, string]> = [
	["accent", "brl-subagent Dashboard"],
	["dim", "  refreshing · <time>"],
	["accent", "Active Subagents (2)"],
	["accent", "  ⠋ my-label"],
	["dim", "  [11111111]  ↑1.2k ↓567  1m 5s"],
	["accent", "  ⠋ another task with no label at all and a "],
	["dim", "  [22222222]  ↑10 ↓20  4s"],
	["accent", "SLA Summary (last 9 runs)"],
	["dim", "  Success: "],
	["error", "33.3%"],
	["dim", " · p50: 2.3s · p95: 49.5s · p99: 1m2s"],
	["dim", "  Cost:      "],
	["dim", "total $0.2123 · avg $0.0236"],
	["accent", "Recent Runs"],
	["accent", "●"],
	["dim", "task 22222222-bbbb"],
	["dim", "  ..."],
	["accent", "●"],
	["dim", "task 11111111-aaaa"],
	["dim", "  ..."],
	["success", "✓"],
	["dim", "impl-footer"],
	["dim", "  1.5s $0.0123"],
	["error", "✗"],
	["dim", "task bbbbbbbb-2"],
	["dim", "  1m5s $0.2000"],
	["accent", "●"],
	["dim", "a very long task description that goes past fifty "],
	["dim", "  ..."],
	["success", "✓"],
	["dim", "task dddddddd-4"],
	["dim", "  900ms"],
	["error", "✗"],
	["dim", "task eeeeeeee-5"],
	["dim", "  2.0s"],
	["error", "✗"],
	["dim", "task ffffffff-6"],
	["dim", "  2.5s"],
	["error", "✗"],
	["dim", "task 77777777-7"],
	["dim", "  3.0s"],
	["accent", "Error Breakdown"],
	["dim", "  timeout            "],
	["error", "████████████████████"],
	["dim", " 2"],
	["dim", "  auth               "],
	["error", "██████████"],
	["dim", " 1"],
	["accent", "Cost Trend (last 20 runs)"],
	["dim", "  "],
	["accent", "▁█"],
	["dim", "  2 runs · total $0.2123 · avg $0.1062"],
	["dim", "q / esc to close"],
	["accent", "────────────────────────────────────────────────────────────────────────────────"],
	["accent", "────────────────────────────────────────────────────────────────────────────────"],
];

// ---------------------------------------------------------------------------
// 1. Composer — the whole screen, byte for byte
// ---------------------------------------------------------------------------

describe("showDashboard — rendered screen (issue #356)", () => {
	it("renders the six panels in order for a populated session", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const { state, ctx } = richState();

		expect(await renderDashboard(state, ctx)).toEqual([
			BORDER,
			...RICH_HEADER,
			...RICH_ACTIVE,
			...RICH_SLA,
			...RICH_RECENT,
			...RICH_ERRORS,
			...RICH_TREND,
			...RICH_FOOTER,
		]);
	});

	it("renders every empty branch for a fresh session", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const { state, ctx } = emptyState();

		expect(await renderDashboard(state, ctx)).toEqual([
			BORDER,
			...EMPTY_HEADER,
			...EMPTY_ACTIVE,
			...EMPTY_SLA,
			...EMPTY_RECENT,
			...EMPTY_ERRORS,
			...EMPTY_TREND,
			...EMPTY_FOOTER,
		]);
	});

	it("keeps every panel at its pinned offset in the composed screen", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const { state, ctx } = richState();
		const lines = await renderDashboard(state, ctx);

		let at = 1; // past the top border
		for (const [name, panel] of [
			["header", RICH_HEADER],
			["active subagents", RICH_ACTIVE],
			["SLA summary", RICH_SLA],
			["recent runs", RICH_RECENT],
			["error breakdown", RICH_ERRORS],
			["cost trend", RICH_TREND],
			["footer", RICH_FOOTER],
		] as Array<[string, string[]]>) {
			expect(lines.slice(at, at + panel.length), name).toEqual(panel);
			at += panel.length;
		}
		expect(lines[0]).toBe(BORDER);
		// The footer golden already carries the bottom border.
		expect(lines).toHaveLength(at);
		expect(lines[at - 1]).toBe(BORDER);
	});

	it("paints the panels with the pinned colour vocabulary, in order", async () => {
		vi.useFakeTimers();
		vi.setSystemTime(NOW);
		const { state, ctx } = richState();
		const { theme, calls } = recordingTheme();

		await renderDashboard(state, ctx, theme);

		expect(calls).toEqual(RICH_FG_CALLS);
	});
});

// ---------------------------------------------------------------------------
// 2. Panels — each renders its own data slice (no composer involved)
// ---------------------------------------------------------------------------

/** The rich fixture's data slices, exactly as the composer samples them. */
function richSlices() {
	const ctx = makeCtx(richRuns);
	const allRuns = richRuns();
	const recentRuns = allRuns.slice(0, 50);
	const metrics = recentRuns.length > 0 ? computeSLAMetrics(recentRuns) : null;
	return {
		ctx,
		allRuns,
		recentRuns,
		metrics,
		live: liveSessions(ctx),
	};
}

describe("dashboard panels — each renders its own slice (issue #356)", () => {
	it("panel 1 — header", () => {
		expect(panelLines(renderDashboardHeader(PLAIN_THEME, "refreshing \u00b7 <time>"))).toEqual(RICH_HEADER);
	});

	it("panel 2 — active subagents, populated and empty", () => {
		const { live } = richSlices();
		expect(panelLines(renderDashboardActivePanel(PLAIN_THEME, live, () => NOW))).toEqual(RICH_ACTIVE);
		expect(panelLines(renderDashboardActivePanel(PLAIN_THEME, new Map(), () => NOW))).toEqual(EMPTY_ACTIVE);
	});

	it("panel 3 — SLA summary, populated and empty", () => {
		const { recentRuns, metrics } = richSlices();
		expect(panelLines(renderDashboardSlaPanel(PLAIN_THEME, metrics, recentRuns.length))).toEqual(RICH_SLA);
		expect(panelLines(renderDashboardSlaPanel(PLAIN_THEME, null, 0))).toEqual(EMPTY_SLA);
	});

	it("panel 4 — recent runs, populated and empty", () => {
		const { allRuns } = richSlices();
		expect(panelLines(renderDashboardRecentRunsPanel(PLAIN_THEME, allRuns.slice(0, 10)))).toEqual(RICH_RECENT);
		expect(panelLines(renderDashboardRecentRunsPanel(PLAIN_THEME, []))).toEqual(EMPTY_RECENT);
	});

	it("panel 5 — error breakdown, populated and empty", () => {
		const { metrics } = richSlices();
		expect(panelLines(renderDashboardErrorPanel(PLAIN_THEME, metrics?.errorCategoryBreakdown))).toEqual(RICH_ERRORS);
		expect(panelLines(renderDashboardErrorPanel(PLAIN_THEME, undefined))).toEqual(EMPTY_ERRORS);
	});

	it("panel 6 — cost trend, populated and empty", () => {
		const { allRuns } = richSlices();
		expect(panelLines(renderDashboardCostTrendPanel(PLAIN_THEME, computeCostTrend(allRuns, 20)))).toEqual(RICH_TREND);
		expect(panelLines(renderDashboardCostTrendPanel(PLAIN_THEME, []))).toEqual(EMPTY_TREND);
	});

	it("every panel closes with the blank separator child", () => {
		const { allRuns, recentRuns, metrics, live } = richSlices();
		const panels: Array<[string, Component[]]> = [
			["header", renderDashboardHeader(PLAIN_THEME, "refreshing \u00b7 <time>")],
			["active subagents", renderDashboardActivePanel(PLAIN_THEME, live, () => NOW)],
			["SLA summary", renderDashboardSlaPanel(PLAIN_THEME, metrics, recentRuns.length)],
			["recent runs", renderDashboardRecentRunsPanel(PLAIN_THEME, allRuns.slice(0, 10))],
			["error breakdown", renderDashboardErrorPanel(PLAIN_THEME, metrics?.errorCategoryBreakdown)],
			["cost trend", renderDashboardCostTrendPanel(PLAIN_THEME, computeCostTrend(allRuns, 20))],
		];
		for (const [name, components] of panels) {
			const last = components[components.length - 1] as Text;
			expect(last, name).toBeInstanceOf(Text);
			expect(last.text, name).toBe("");
		}
	});
});

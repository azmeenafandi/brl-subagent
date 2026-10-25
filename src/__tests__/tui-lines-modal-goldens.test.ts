// Purpose: Pin the rendered bytes of the four report "lines modals" and the config menu
// (duplication sweep #377, D9/D11) before their boilerplate is collapsed into helpers.
// The goldens were captured on the pre-extraction code; the refactor must leave them unchanged.
import { describe, expect, it, vi } from "vitest";
import type { ExtensionContext, Theme } from "@earendil-works/pi-coding-agent";
import { SessionState } from "../state";
import {
	showConfigMenu,
	showFileAccessReport,
	showFullComplianceSummary,
	showSecretsExposureReport,
	showSLAStats,
} from "../tui";
import { CUSTOM_ENTRY_TYPES, type SubagentRun } from "../types";

// ---------------------------------------------------------------------------
// Harness — render every `ctx.ui.custom` component headlessly at a fixed width
// and record the colour vocabulary it emits.
// ---------------------------------------------------------------------------

const WIDTH = 100;

interface CapturedScreen {
	lines: string[];
	colorCalls: Array<[string, string]>;
	handleInput: ((data: string) => void) | undefined;
	/** Values passed to the screen's `done` callback, in call order. */
	doneCalls: unknown[];
}

interface Capture {
	ctx: ExtensionContext;
	screens: CapturedScreen[];
}

function makeTheme(colorCalls: Array<[string, string]>): Theme {
	return {
		fg: (color: string, text: string) => {
			colorCalls.push([color, text]);
			return text;
		},
		bold: (text: string) => text,
	} as unknown as Theme;
}

function makeCtx(runs: SubagentRun[], customResult: string | null = null): Capture {
	const screens: CapturedScreen[] = [];
	const colorCalls: Array<[string, string]> = [];
	const theme = makeTheme(colorCalls);
	const ctx = {
		ui: {
			theme,
			notify: vi.fn(),
			setStatus: vi.fn(),
			input: vi.fn(async () => null),
			custom: vi.fn((factory: (...args: unknown[]) => { render: (w: number) => string[] }) => {
				const doneCalls: unknown[] = [];
				const component = factory(
					{ requestRender: () => {} },
					theme,
					{},
					(value: unknown) => doneCalls.push(value),
				) as {
					render: (w: number) => string[];
					handleInput?: (data: string) => void;
				};
				screens.push({
					lines: component.render(WIDTH),
					colorCalls,
					handleInput: component.handleInput,
					doneCalls,
				});
				return Promise.resolve(customResult);
			}),
		},
		sessionManager: {
			getEntries: () =>
				runs.map((run) => ({
					type: "custom",
					customType: CUSTOM_ENTRY_TYPES.run,
					data: run,
				})),
		},
		cwd: "/tmp/project",
	} as unknown as ExtensionContext;
	return { ctx, screens };
}

// ---------------------------------------------------------------------------
// Fixtures — fixed dates/costs so both the report text and SLA metrics are stable.
// ---------------------------------------------------------------------------

function reportRuns(): SubagentRun[] {
	return [
		{
			id: "run-1",
			task: "implement the feature",
			status: "done",
			model: "anthropic/claude-sonnet-4",
			thinkingLevel: "medium",
			startedAt: "2026-01-02T03:00:00.000Z",
			finishedAt: "2026-01-02T03:01:00.000Z",
			durationMs: 60_000,
			cost: 0.0123,
			fullOutput: [
				"diff --git a/src/index.ts b/src/index.ts",
				"--- a/src/index.ts",
				"+++ b/src/index.ts",
				"@@ -1 +1 @@",
				"-old",
				"+new",
				"diff --git a/.env b/.env",
				"--- a/.env",
				"+++ b/.env",
			].join("\n"),
		},
		{
			id: "run-2",
			task: "rotate the secret token",
			status: "failed",
			model: "anthropic/claude-sonnet-4",
			thinkingLevel: "low",
			startedAt: "2026-01-02T03:02:00.000Z",
			finishedAt: "2026-01-02T03:02:30.000Z",
			durationMs: 30_000,
			cost: 0.004,
			errorMessage: "boom",
			originalParams: { errorCategory: "timeout" } as never,
			outputSummary: "Modified: credentials.json",
		},
	];
}

function configuredState(): SessionState {
	const state = new SessionState();
	state.config.model = { provider: "anthropic", id: "claude-sonnet-4" };
	state.config.maxThinkingLevel = "high";
	state.config.maxParallel = 4;
	state.config.maxSubagentDepth = 2;
	state.config.approvalMode = "auto";
	state.config.completionNotify = "failed";
	state.config.recovery = "off";
	state.config.maxHistoryEntries = 250;
	state.config.sessionCostLimit = 2.5;
	state.config.slaTrackingEnabled = true;
	state.config.slaWindowSize = 100;
	return state;
}

function snapshotScreen(screen: CapturedScreen): { lines: string[]; colorCalls: Array<[string, string]> } {
	return { lines: screen.lines, colorCalls: screen.colorCalls };
}

// ---------------------------------------------------------------------------
// D9 — the four report screens (lines modal)
// ---------------------------------------------------------------------------

describe("report lines-modal goldens (D9)", () => {
	it("SLA Statistics renders identically", async () => {
		const { ctx, screens } = makeCtx(reportRuns());
		await showSLAStats(ctx, configuredState());
		expect(screens).toHaveLength(1);
		expect(snapshotScreen(screens[0])).toMatchSnapshot();
	});

	it("File Access Report renders identically", async () => {
		const { ctx, screens } = makeCtx(reportRuns());
		await showFileAccessReport(ctx, configuredState());
		expect(screens).toHaveLength(1);
		expect(snapshotScreen(screens[0])).toMatchSnapshot();
	});

	it("Secrets Exposure Report renders identically", async () => {
		const { ctx, screens } = makeCtx(reportRuns());
		await showSecretsExposureReport(ctx, configuredState());
		expect(screens).toHaveLength(1);
		expect(snapshotScreen(screens[0])).toMatchSnapshot();
	});

	it("Compliance Summary renders identically", async () => {
		const { ctx, screens } = makeCtx(reportRuns());
		await showFullComplianceSummary(ctx, configuredState());
		expect(screens).toHaveLength(1);
		expect(snapshotScreen(screens[0])).toMatchSnapshot();
	});

	it("every report closes on q and Escape, and ignores other keys", async () => {
		const openers: Array<[
			string,
			(ctx: ExtensionContext, state: SessionState) => Promise<void>,
		]> = [
			["SLA Statistics", (ctx, state) => showSLAStats(ctx, state)],
			["File Access Report", (ctx, state) => showFileAccessReport(ctx, state)],
			["Secrets Exposure Report", (ctx, state) => showSecretsExposureReport(ctx, state)],
			["Compliance Summary", (ctx, state) => showFullComplianceSummary(ctx, state)],
		];

		for (const [name, open] of openers) {
			for (const key of ["q", "\x1b"]) {
				const capture = makeCtx(reportRuns());
				await open(capture.ctx, configuredState());
				capture.screens[0].handleInput?.(key);
				expect(capture.screens[0].doneCalls, `${name} closes on ${JSON.stringify(key)}`).toEqual([
					undefined,
				]);
			}

			const capture = makeCtx(reportRuns());
			await open(capture.ctx, configuredState());
			capture.screens[0].handleInput?.("x");
			expect(capture.screens[0].doneCalls, `${name} ignores other keys`).toEqual([]);
		}
	});
});

// ---------------------------------------------------------------------------
// D11 — the config menu (bypassed select list)
// ---------------------------------------------------------------------------

describe("config-menu golden (D11)", () => {
	it("renders identically with current values populated", async () => {
		const { ctx, screens } = makeCtx([], "__done__");
		await showConfigMenu(ctx, configuredState(), {});
		expect(screens).toHaveLength(1);
		expect(snapshotScreen(screens[0])).toMatchSnapshot();
	});
});

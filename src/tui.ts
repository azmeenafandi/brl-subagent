// Purpose: All TUI surfaces: config menus, preset/template managers, history, live monitor, and result rendering.
/**
 * brl-subagent — TUI Components
 *
 * All TUI rendering: select lists, configuration menus, model/thinking selectors,
 * preset management, run history viewer, live monitor, retry menu, and
 * delegate_task result rendering.
 */

import type {
	ExtensionContext,
	ExtensionAPI,
	Theme,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, type Component, type SelectItem, SelectList, Spacer, Text, Markdown, matchesKey } from "@earendil-works/pi-tui";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
	TaskTemplate,
	SubagentResult,
	SubagentRun,
	SubTaskParams,
	MultiSubagentDetails,
	ChainDetails,
	ParallelDetails,
	GraphDetails,
	DelegateTaskDetails,
	GraphTask,
	ThinkingLevel,
	UsageStats,
	FileDiff,
	CompletionNotifyMode,
	RecoveryMode,
} from "./types";
import {
	THINKING_LEVELS,
	NAV_FOOTER,
	COMPLETION_NOTIFY_MODES,
	RECOVERY_MODES,
	TASK_PREVIEW_MAX_LENGTH,
	COLLAPSED_OUTPUT_LINES,
	COLLAPSED_DIFF_FILES_PREVIEW,
	EXPANDED_HUNKS_PER_FILE,
	DEFAULT_OUTPUT_CAP_BYTES,
	formatTokens,
	formatUsageStats,
	formatMaxParallel,
	getFinalOutput,
	isSubagentError,
	isMultiSubagentDetails,
	isGraphDetails,
	isUnsettledPartial,
	isInterruptedRun,
} from "./types";
import { buildFileAccessReport, buildSecretsExposureReport, generateComplianceSummary } from "./reports";
import { extractParamNames } from "./templates";
import { parseDiff } from "./diff";
import { formatPresetSummary, getPreset, loadCustomPresets, sanitizeFileName } from "./presets";
import { buildOutputHonestyLines, formatRunDuration } from "./history";
import * as fs from "node:fs";
import * as path from "node:path";
import { collapseRunsForHistory, retryableRuns, sweepStaleLiveSubagents, type SessionState } from "./state";
import { getAgent } from "./session-manager";
import { visibleRunEntriesForSession } from "./recovery-surface";
import { computeSLAMetrics, computeCostTrend, formatSparkline } from "./metrics";
import { formatElapsed, liveRowName, liveSpinner, formatLiveRowDim, runHistoryStatus, runHistoryStatusLabel, buildRetryOfferMessage, runDisplayName, formatMenuValue, menuSection } from "./tui-format";
import {
	renderTranscriptMessages,
	type TranscriptLineStyle,
	type TranscriptMessage,
} from "./transcript-tail";

// ---------------------------------------------------------------------------
// SelectList helper
// ---------------------------------------------------------------------------

function makeSelectListTheme(theme: Theme) {
	return {
		selectedPrefix: (t: string) => theme.fg("accent", t),
		selectedText: (t: string) => theme.fg("accent", t),
		description: (t: string) => theme.fg("muted", t),
		scrollInfo: (t: string) => theme.fg("dim", t),
		noMatch: (t: string) => theme.fg("warning", t),
	};
}

export async function showSelectList(
	ctx: ExtensionContext,
	title: string,
	items: SelectItem[],
	maxItems: number,
): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

		const selectList = new SelectList(
			items,
			Math.min(items.length, maxItems),
			makeSelectListTheme(theme),
		);
		selectList.onSelect = (item) => done(item.value);
		selectList.onCancel = () => done(null);

		container.addChild(selectList);
		container.addChild(new Text(theme.fg("dim", NAV_FOOTER), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				selectList.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

// ---------------------------------------------------------------------------
// Choice-list rows (menu polish U2): one `(current)` marker syntax
// ---------------------------------------------------------------------------

/**
 * Apply the single canonical current-value marker to a choice label. Every
 * in-scope choice list marks exactly the row whose value equals the current
 * setting, and marks nothing when no current value exists.
 */
export function withCurrentMarker(label: string, isCurrent: boolean): string {
	return isCurrent ? `${label} (current)` : label;
}

/** Model choice rows; the current `provider/id` carries the `(current)` marker. */
export function getModelSelectorItems(
	models: ReadonlyArray<Pick<Model<Api>, "provider" | "id" | "name" | "contextWindow">>,
	state: SessionState,
): SelectItem[] {
	const current = state.config.model
		? `${state.config.model.provider}/${state.config.model.id}`
		: undefined;
	return models.map((m) => {
		const value = `${m.provider}/${m.id}`;
		return {
			value,
			label: withCurrentMarker(value, value === current),
			description: m.name ?? `context: ${(m.contextWindow ?? 0) / 1000}K`,
		};
	});
}

/** Thinking-level choice rows; the configured ceiling carries the marker. */
export function getThinkingSelectorItems(state: SessionState): SelectItem[] {
	return THINKING_LEVELS.map((level) => ({
		value: level,
		label: withCurrentMarker(level, level === state.config.maxThinkingLevel),
	}));
}

/** Change-approval choice rows; the active mode carries the marker. */
export function getApprovalModeItems(state: SessionState): SelectItem[] {
	const descriptions: Record<string, string> = {
		auto: "Never ask - auto-approve",
		writes: "Ask when files changed - default",
		always: "Ask every time",
	};
	return (["auto", "writes", "always"] as const).map((mode) => ({
		value: mode,
		label: withCurrentMarker(mode, mode === state.config.approvalMode),
		description: descriptions[mode],
	}));
}

/** Completion-notify choice rows; the active mode carries the marker. */
export function getCompletionNotifyItems(state: SessionState): SelectItem[] {
	const modeDescriptions: Record<CompletionNotifyMode, string> = {
		all: "Wake on every terminal state (completed, failed, stopped) - default",
		failed: "Wake only on failed / stopped runs",
		off: "Never wake (still delivered passively at the next user prompt)",
	};
	return COMPLETION_NOTIFY_MODES.map((mode) => ({
		value: mode,
		label: withCurrentMarker(mode, mode === state.config.completionNotify),
		description: modeDescriptions[mode],
	}));
}

/** Recovery-posture choice rows; the active posture carries the marker. */
export function getRecoveryItems(state: SessionState): SelectItem[] {
	const modeDescriptions: Record<RecoveryMode, string> = {
		offer: "Surface interrupted runs (Run History row + one boot notice) - default",
		off: "Do not surface interrupted runs",
	};
	return RECOVERY_MODES.map((mode) => ({
		value: mode,
		label: withCurrentMarker(mode, mode === state.config.recovery),
		description: modeDescriptions[mode],
	}));
}

/** SLA enable→window step 1; exactly one of Enabled/Disabled carries the marker. */
export function getSLAEnableItems(state: SessionState): SelectItem[] {
	const enabled = state.config.slaTrackingEnabled;
	return [
		{
			value: "disabled",
			label: withCurrentMarker("Disabled", !enabled),
			description: "No SLA tracking",
		},
		{
			value: "enabled",
			label: withCurrentMarker("Enabled", enabled),
			description: "Track performance metrics and detect degradation",
		},
	];
}

// ---------------------------------------------------------------------------
// Model selector
// ---------------------------------------------------------------------------

export async function showModelSelector(
	ctx: ExtensionContext,
	state: SessionState,
	onConfigChanged: (ctx: ExtensionContext, msg: string) => void,
): Promise<void> {
	const availableModels = await ctx.modelRegistry.getAvailable();

	if (!availableModels || availableModels.length === 0) {
		ctx.ui.notify(
			"No models available. Configure API keys first (use /login or set environment variables).",
			"warning",
		);
		return;
	}

	const items: SelectItem[] = getModelSelectorItems(availableModels, state);

	const result = await showSelectList(ctx, "Select Subagent Model", items, 15);
	if (!result) return;

	const slashIdx = result.indexOf("/");
	state.config.model = { provider: result.slice(0, slashIdx), id: result.slice(slashIdx + 1) };
	onConfigChanged(ctx, `Subagent model set to ${result}`);
}

// ---------------------------------------------------------------------------
// Thinking level selector
// ---------------------------------------------------------------------------

export async function showThinkingSelector(
	ctx: ExtensionContext,
	state: SessionState,
	onConfigChanged: (ctx: ExtensionContext, msg: string) => void,
): Promise<void> {
	const items: SelectItem[] = getThinkingSelectorItems(state);

	const result = await showSelectList(ctx, "Select Max Thinking Level", items, 10);
	if (!result) return;

	state.config.maxThinkingLevel = result as ThinkingLevel;
	onConfigChanged(
		ctx,
		`Subagent max thinking level set to ${result} (subagents can request up to ${result})`,
	);
}

// ---------------------------------------------------------------------------
// Concurrency input
// ---------------------------------------------------------------------------

export async function showConcurrencyInput(
	ctx: ExtensionContext,
	state: SessionState,
	onConfigChanged: (ctx: ExtensionContext, msg: string) => void,
): Promise<void> {
	const result = await ctx.ui.input(
		`Max parallel subagents (0 = Unlimited \u00b7 current: ${formatMenuValue("parallel", { maxParallel: state.config.maxParallel })}):`,
	);
	if (result == null) return;
	const num = parseInt(result, 10);
	if (isNaN(num) || num < 0) {
		ctx.ui.notify("Invalid number. Must be >= 0.", "error");
		return;
	}
	state.config.maxParallel = num;
	onConfigChanged(ctx, `Max parallel subagents set to ${formatMaxParallel(num)}`);
}

// ---------------------------------------------------------------------------
// Recursion depth input
// ---------------------------------------------------------------------------

export async function showDepthInput(
	ctx: ExtensionContext,
	state: SessionState,
	onConfigChanged: (ctx: ExtensionContext, msg: string) => void,
): Promise<void> {
	const result = await ctx.ui.input(
		`Max subagent recursion depth (0 = cannot delegate, 1 = one level \u00b7 current: ${formatMenuValue("depth", { maxSubagentDepth: state.config.maxSubagentDepth })}):`,
	);
	if (result == null) return;
	const num = parseInt(result, 10);
	if (isNaN(num) || num < 0) {
		ctx.ui.notify("Invalid number. Must be >= 0.", "error");
		return;
	}
	state.config.maxSubagentDepth = num;
	const desc = num === 0
		? "subagents cannot delegate"
		: `subagents can delegate up to ${num} level${num > 1 ? "s" : ""} deep`;
	onConfigChanged(ctx, `Max recursion depth set to ${num} (${desc})`);
}

// ---------------------------------------------------------------------------
// History entries input — R2: Disk usage policy
// ---------------------------------------------------------------------------

export async function showHistoryEntriesInput(
	ctx: ExtensionContext,
	state: SessionState,
	onConfigChanged: (ctx: ExtensionContext, msg: string) => void,
): Promise<void> {
	const current = formatMenuValue("historyentries", {
		maxHistoryEntries: state.config.maxHistoryEntries,
	});
	const result = await ctx.ui.input(
		`Max run history entries (0 = Unlimited, default 500 \u00b7 current: ${current}):`,
	);
	if (result == null) return;
	const num = parseInt(result, 10);
	if (isNaN(num) || num < 0) {
		ctx.ui.notify("Invalid number. Must be >= 0.", "error");
		return;
	}
	state.config.maxHistoryEntries = num;
	onConfigChanged(
		ctx,
		num === 0
			? "Run history set to unlimited (no pruning)"
			: `Run history entries set to ${num} (oldest entries will be pruned)`,
	);
}

// ---------------------------------------------------------------------------
// Cost limit input — R5: Cost governance
// ---------------------------------------------------------------------------

export async function showCostLimitInput(
	ctx: ExtensionContext,
	state: SessionState,
	onConfigChanged: (ctx: ExtensionContext, msg: string) => void,
): Promise<void> {
	const current = formatMenuValue("costlimit", {
		sessionCostLimit: state.config.sessionCostLimit,
	});
	const result = await ctx.ui.input(
		`Session cost limit in USD (0 = Unlimited, e.g. 1.00 for $1 \u00b7 current: ${current}):`,
	);
	if (result == null) return;
	const num = parseFloat(result);
	if (isNaN(num) || num < 0) {
		ctx.ui.notify("Invalid number. Must be >= 0.", "error");
		return;
	}
	state.config.sessionCostLimit = num;
	onConfigChanged(
		ctx,
		num === 0
			? "Session cost limit set to unlimited"
			: `Session cost limit set to $${num.toFixed(2)}`,
	);
}

// ---------------------------------------------------------------------------
// Approval mode selector — P4
// ---------------------------------------------------------------------------

export async function showApprovalModeSelector(
	ctx: ExtensionContext,
	state: SessionState,
	onConfigChanged: (ctx: ExtensionContext, msg: string) => void,
): Promise<void> {
	const items: SelectItem[] = getApprovalModeItems(state);

	const result = await showSelectList(ctx, "Select Change Approval Mode", items, 5);
	if (!result) return;

	state.config.approvalMode = result as "auto" | "writes" | "always";
	onConfigChanged(ctx, `Change approval mode set to ${result}`);
}

// ---------------------------------------------------------------------------
// Completion notify mode selector (issue #147)
// ---------------------------------------------------------------------------

export async function showCompletionNotifySelector(
	ctx: ExtensionContext,
	state: SessionState,
	onConfigChanged: (ctx: ExtensionContext, msg: string) => void,
): Promise<void> {
	const items: SelectItem[] = getCompletionNotifyItems(state);

	const result = await showSelectList(ctx, "Select Completion Notify Mode", items, 5);
	if (!result) return;

	state.config.completionNotify = result as CompletionNotifyMode;
	onConfigChanged(ctx, `Completion notify mode set to ${result}`);
}

/**
 * Option B U3 (D4): recovery posture selector. Modeled on the completionNotify
 * selector; `RECOVERY_MODES` excludes "auto" by construction.
 */
export async function showRecoverySelector(
	ctx: ExtensionContext,
	state: SessionState,
	onConfigChanged: (ctx: ExtensionContext, msg: string) => void,
): Promise<void> {
	const items: SelectItem[] = getRecoveryItems(state);

	const result = await showSelectList(ctx, "Select Recovery Posture", items, 5);
	if (!result) return;

	state.config.recovery = result as RecoveryMode;
	onConfigChanged(ctx, `Recovery posture set to ${result}`);
}

// ---------------------------------------------------------------------------
// E4: SLA tracking configuration
// ---------------------------------------------------------------------------

export async function showSLAConfig(
	ctx: ExtensionContext,
	state: SessionState,
	onConfigChanged: (ctx: ExtensionContext, msg: string) => void,
): Promise<void> {
	// Step 1: Enable/disable toggle
	const enableItems: SelectItem[] = getSLAEnableItems(state);
	const enableResult = await showSelectList(ctx, "Configure SLA Tracking", enableItems, 5);
	if (!enableResult) return;

	const enabled = enableResult === "enabled";
	state.config.slaTrackingEnabled = enabled;

	if (!enabled) {
		onConfigChanged(ctx, "SLA tracking disabled");
		return;
	}

	// Step 2: Window size input
	const sizeResult = await ctx.ui.input(
		`Window size (10-500 \u00b7 current: ${state.config.slaWindowSize}):`,
	);
	if (sizeResult == null) return;
	const size = parseInt(sizeResult, 10);
	if (isNaN(size) || size < 10 || size > 500) {
		ctx.ui.notify("Invalid window size. Must be 10-500.", "error");
		return;
	}
	state.config.slaWindowSize = size;
	onConfigChanged(ctx, `SLA tracking enabled with window size ${size}`);
}

export async function showSLAStats(
	ctx: ExtensionContext,
	state: SessionState,
): Promise<void> {
	const runs = state.getRunEntries(ctx).slice(0, state.config.slaWindowSize);
	if (runs.length === 0) {
		ctx.ui.notify("No runs to analyze. Delegate a task first.", "info");
		return;
	}

	const { computeSLAMetrics } = await import("./metrics");
	const metrics = computeSLAMetrics(runs);

	const lines: string[] = [
		`SLA Metrics (last ${metrics.totalRuns} runs)`,
		"",
		`  Success rate:      ${(metrics.successRate * 100).toFixed(1)}%`,
		`  Failure rate:      ${(metrics.failureRate * 100).toFixed(1)}%`,
		"",
		`  Duration (ms):`,
		`    Average:         ${metrics.averageDurationMs.toFixed(0)}`,
		`    p50:             ${metrics.p50DurationMs.toFixed(0)}`,
		`    p95:             ${metrics.p95DurationMs.toFixed(0)}`,
		`    p99:             ${metrics.p99DurationMs.toFixed(0)}`,
		"",
		`  Cost:`,
		`    Total:           $${metrics.totalCost.toFixed(4)}`,
		`    Average:         $${metrics.averageCost.toFixed(4)}`,
	];

	if (Object.keys(metrics.errorCategoryBreakdown).length > 0) {
		lines.push("", "  Errors by category:");
		for (const [cat, count] of Object.entries(metrics.errorCategoryBreakdown)) {
			lines.push(`    ${cat}: ${count}`);
		}
	}

	ctx.ui.custom((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("SLA Statistics")), 1, 0));
		container.addChild(new Text("", 0, 0));
		for (const line of lines) {
			container.addChild(new Text(theme.fg("dim", line), 1, 0));
		}
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (data === "q" || data === "\x1b") done(undefined);
			},
		};
	});
}

// Preset management UI
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// E5: Compliance Reports
// ---------------------------------------------------------------------------

export async function showFileAccessReport(
	ctx: ExtensionContext,
	state: SessionState,
): Promise<void> {
	const runs = state.getRunEntries(ctx);
	if (runs.length === 0) {
		ctx.ui.notify("No runs to analyze. Delegate a task first.", "info");
		return;
	}

	const report = buildFileAccessReport(runs);
	const fileCount = Object.keys(report.files).length;

	if (fileCount === 0) {
		ctx.ui.notify("No file access detected in run outputs.", "info");
		return;
	}

	const lines: string[] = [
		`File Access Report (${fileCount} files)`,
		"",
	];

	// Sort files alphabetically for consistent output
	const sortedFiles = Object.keys(report.files).sort();

	for (const file of sortedFiles) {
		const runIds = report.files[file];
		lines.push(`  ${file}`);
		lines.push(`    Runs: ${runIds.join(", ")}`);
	}

	ctx.ui.custom((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("File Access Report")), 1, 0));
		container.addChild(new Text("", 0, 0));
		for (const line of lines) {
			container.addChild(new Text(theme.fg("dim", line), 1, 0));
		}
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (data === "q" || data === "\x1b") done(undefined);
			},
		};
	});
}

export async function showSecretsExposureReport(
	ctx: ExtensionContext,
	state: SessionState,
): Promise<void> {
	const runs = state.getRunEntries(ctx);
	if (runs.length === 0) {
		ctx.ui.notify("No runs to analyze. Delegate a task first.", "info");
		return;
	}

	const report = buildSecretsExposureReport(runs);
	const exposureCount = report.exposures.length;

	if (exposureCount === 0) {
		ctx.ui.notify("No sensitive file access detected.", "info");
		return;
	}

	const lines: string[] = [
		`Secrets Exposure Report (${exposureCount} findings)`,
		"",
	];

	// Group by severity
	const highSeverity = report.exposures.filter((e) => e.severity === "high");
	const mediumSeverity = report.exposures.filter((e) => e.severity === "medium");
	const lowSeverity = report.exposures.filter((e) => e.severity === "low");

	if (highSeverity.length > 0) {
		lines.push("  HIGH SEVERITY:");
		for (const exposure of highSeverity) {
			lines.push(`    ${exposure.file}`);
			lines.push(`      Run: ${exposure.runId}${exposure.runLabel ? ` (${exposure.runLabel})` : ""}`);
		}
		lines.push("");
	}

	if (mediumSeverity.length > 0) {
		lines.push("  MEDIUM SEVERITY:");
		for (const exposure of mediumSeverity) {
			lines.push(`    ${exposure.file}`);
			lines.push(`      Run: ${exposure.runId}${exposure.runLabel ? ` (${exposure.runLabel})` : ""}`);
		}
		lines.push("");
	}

	if (lowSeverity.length > 0) {
		lines.push("  LOW SEVERITY:");
		for (const exposure of lowSeverity) {
			lines.push(`    ${exposure.file}`);
			lines.push(`      Run: ${exposure.runId}${exposure.runLabel ? ` (${exposure.runLabel})` : ""}`);
		}
	}

	ctx.ui.custom((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Secrets Exposure Report")), 1, 0));
		container.addChild(new Text("", 0, 0));
		for (const line of lines) {
			container.addChild(new Text(theme.fg("dim", line), 1, 0));
		}
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (data === "q" || data === "\x1b") done(undefined);
			},
		};
	});
}

export async function showFullComplianceSummary(
	ctx: ExtensionContext,
	state: SessionState,
): Promise<void> {
	const runs = state.getRunEntries(ctx);
	if (runs.length === 0) {
		ctx.ui.notify("No runs to analyze. Delegate a task first.", "info");
		return;
	}

	const summary = generateComplianceSummary(runs);

	const lines: string[] = [
		`Compliance Summary`,
		"",
		`  Total Runs:        ${summary.totalRuns}`,
		`  Date Range:        ${summary.dateRange.earliest ? new Date(summary.dateRange.earliest).toLocaleDateString() : "N/A"} - ${summary.dateRange.latest ? new Date(summary.dateRange.latest).toLocaleDateString() : "N/A"}`,
		"",
		`  SLA Metrics:`,
		`    Success Rate:    ${(summary.metrics.successRate * 100).toFixed(1)}%`,
		`    Failure Rate:    ${(summary.metrics.failureRate * 100).toFixed(1)}%`,
		`    Avg Duration:    ${summary.metrics.averageDurationMs.toFixed(0)}ms`,
		`    p95 Duration:    ${summary.metrics.p95DurationMs.toFixed(0)}ms`,
		`    Total Cost:      $${summary.metrics.totalCost.toFixed(4)}`,
		"",
		`  File Access:       ${summary.filesAccessed} files`,
		`  Sensitive Files:   ${summary.sensitiveFilesTouched}`,
		`  High Severity:     ${summary.highSeverityFindings}`,
	];

	ctx.ui.custom((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold("Compliance Summary")), 1, 0));
		container.addChild(new Text("", 0, 0));
		for (const line of lines) {
			container.addChild(new Text(theme.fg("dim", line), 1, 0));
		}
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (data: string) => {
				if (data === "q" || data === "\x1b") done(undefined);
			},
		};
	});
}

export async function showComplianceMenu(
	ctx: ExtensionContext,
	state: SessionState,
): Promise<void> {
	const items: SelectItem[] = [
		{ value: "file-access", label: "File Access Report", description: "Shows file → subagent run mapping" },
		{ value: "secrets", label: "Secrets Exposure Report", description: "Shows sensitive file access findings" },
		{ value: "full", label: "Full Compliance Summary", description: "Combined summary with metrics" },
	];

	const result = await showSelectList(ctx, "Compliance Reports", items, 5);
	if (!result) return;

	switch (result) {
		case "file-access":
			await showFileAccessReport(ctx, state);
			break;
		case "secrets":
			await showSecretsExposureReport(ctx, state);
			break;
		case "full":
			await showFullComplianceSummary(ctx, state);
			break;
	}
}

// Preset management UI

export async function showPresetManager(
	ctx: ExtensionContext,
	state: SessionState,
): Promise<void> {
	const builtinItems: SelectItem[] = state.builtinPresets.map((p) => ({
		value: `__builtin__:${p.name}`,
		label: `[B] ${p.name}`,
		description: p.description || formatPresetSummary(p),
	}));

	// Custom presets from state (loaded from files on session start)
	const customItems: SelectItem[] = state.customPresets.map((p) => ({
		value: `__custom__:${p.name}`,
		label: `[${findPresetSource(p.name, ctx) === "project" ? "P" : "G"}] ${p.name}`,
		description: p.description || formatPresetSummary(p),
	}));

	const items: SelectItem[] = [
		...builtinItems,
		...(customItems.length > 0
			? [
					{
						value: "__divider__",
						label: "\u2500\u2500\u2500 Custom Presets \u2500\u2500\u2500",
						description: "",
					},
				]
			: []),
		...customItems,
	];

	const result = await showSelectList(
		ctx,
		`Presets (${state.builtinPresets.length} built-in, ${state.customPresets.length} custom)`,
		items,
		15,
	);
	if (!result || result === "__divider__") return;

	{
		// Extract preset name from value
		const isBuiltin = result.startsWith("__builtin__:");
		const isCustom = result.startsWith("__custom__:");
		const presetName = isBuiltin
			? result.slice("__builtin__:".length)
			: isCustom
				? result.slice("__custom__:".length)
				: result;

		const preset = getPreset(presetName, state.builtinPresets, state.customPresets);
		if (preset) {
			await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
				const container = new Container();
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(
					new Text(
						theme.fg("accent", theme.bold(`Preset: ${preset.name}`)) +
							(isBuiltin ? theme.fg("dim", " (built-in)") : ""),
						1,
						0,
					),
				);
				if (preset.description)
					container.addChild(new Text(theme.fg("dim", preset.description), 1, 0));
				container.addChild(new Text("", 0, 0));
				container.addChild(
					new Text(theme.fg("dim", `Thinking: ${preset.thinkingLevel || "(not set)"}`), 1, 0),
				);
				container.addChild(
					new Text(
						theme.fg(
							"dim",
							`Inherit: ${preset.inheritSystemPrompt === false ? "no" : "yes (default)"}`,
						),
						1,
						0,
					),
				);
				if (preset.tools)
					container.addChild(
						new Text(theme.fg("dim", `Tools: ${preset.tools.join(", ")}`), 1, 0),
					);
				if (preset.excludeTools)
					container.addChild(
						new Text(theme.fg("dim", `Exclude: ${preset.excludeTools.join(", ")}`), 1, 0),
					);
				if (preset.systemPrompt)
					container.addChild(
						new Text(theme.fg("dim", `System prompt: ${preset.systemPrompt.slice(0, 100)}`), 1, 0),
					);
				container.addChild(new Text("", 0, 0));
				container.addChild(new Text(theme.fg("dim", "Press any key to close"), 1, 0));
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				return {
					render: (w: number) => container.render(w),
					invalidate: () => container.invalidate(),
					handleInput: (_data: string) => done(),
				};
			});
		}
	}
}

// ---------------------------------------------------------------------------
// Tier classification (menu polish U4, umbrella #345)
// ---------------------------------------------------------------------------

/** Tier vocabulary shared by presets and templates: shipped, project-local, user-global. */
export type Tier = "builtin" | "project" | "global";

/** One candidate directory for classifyTier, tagged with the tier it represents. */
export interface TierDir {
	tier: "project" | "global";
	dir: string;
}

/** Injected I/O and terminal fallback for classifyTier (keeps the decision pure). */
export interface TierClassifierIo {
	/** Tier returned when no file matches and the name is not a builtin. */
	fallback: Tier;
	/** Existence probe for a candidate file path. */
	exists: (filePath: string) => boolean;
}

/**
 * Pure tier classifier: decide which tier a preset or template name comes from.
 *
 * Order of decision:
 *   1. `<sanitizeFileName(name)>.md` in each `dirs` entry, in order — the real
 *      writers (`writePresetFile` / `writeTemplateFile`) emit exactly that
 *      filename via the same `sanitizeFileName`, so a file we wrote by name is
 *      always resolved by path (#345 A1: the pre-U4 finders re-derived a
 *      different, lowercased/underscored filename convention and missed it).
 *   2. `io.fallback` — the surface's terminal value: `builtin` for templates,
 *      `project` for presets (the preset manager only has [P]/[G] labels, so it
 *      maps the non-global answer to `project`).
 *
 * Both the filesystem and the fallback are injected, so the result is a pure
 * function of its arguments and testable against temp dirs or stubs.
 *
 * Documented residual (accepted this cycle): a hand-written file that overrides
 * a builtin NAME but is stored under a non-canonical filename matches no path
 * and is therefore classified by the surface fallback (templates → `builtin`,
 * presets → `project`). The additive `source` field (out of scope for U4) is
 * what would fix it.
 */
export function classifyTier(
	name: string,
	dirs: readonly TierDir[],
	io: TierClassifierIo,
): Tier {
	const fileName = sanitizeFileName(name) + ".md";
	for (const { tier, dir } of dirs) {
		if (io.exists(path.join(dir, fileName))) return tier;
	}
	return io.fallback;
}

/**
 * The two on-disk tiers for a preset or template surface, highest priority
 * first. Mirrors the order loadCustomPresets/loadCustomTemplates scan: the
 * project-local dir wins over the user-global dir.
 */
function tierDirs(ctx: ExtensionContext, kind: "presets" | "templates"): TierDir[] {
	const homedir = process.env.HOME || process.env.USERPROFILE || "";
	return [
		{ tier: "project", dir: path.join(ctx.cwd, ".pi", "brl-subagent", kind) },
		{ tier: "global", dir: path.join(homedir, ".pi", "agent", "brl-subagent", kind) },
	];
}

/**
 * Determine whether a custom preset comes from the project or global directory.
 * Delegates the decision to classifyTier; the preset manager only ever labels
 * custom entries ([P]/[G]), and the preset surface fallback is already
 * `project`, so a builtin-named custom preset stored under a non-canonical
 * filename keeps the pre-U4 project label.
 */
export function findPresetSource(name: string, ctx: ExtensionContext): "project" | "global" {
	const tier = classifyTier(name, tierDirs(ctx, "presets"), {
		fallback: "project",
		exists: fs.existsSync,
	});
	return tier === "global" ? "global" : "project";
}

/**
 * Determine which tier a template comes from: project, global, or builtin.
 * Mirrors findPresetSource. The `builtin` terminal value is the template
 * surface fallback: any name with no canonical file on disk is `builtin`.
 */
export function findTemplateSource(name: string, ctx: ExtensionContext): Tier {
	return classifyTier(name, tierDirs(ctx, "templates"), {
		fallback: "builtin",
		exists: fs.existsSync,
	});
}

// ---------------------------------------------------------------------------
// Template management UI
// ---------------------------------------------------------------------------

export function getTemplate(
	name: string,
	templates: TaskTemplate[],
): TaskTemplate | undefined {
	return templates.find((t) => t.name === name);
}

export async function showViewTemplate(
	ctx: ExtensionContext,
	state: SessionState,
	name: string,
): Promise<void> {
	const template = getTemplate(name, state.config.templates);
	if (!template) return;

	// Tier suffix mirrors the preset view's dim "(built-in)" treatment, extended
	// to project/global so the detail view matches the manager's tier labels.
	const templateTier = findTemplateSource(template.name, ctx);
	const tierSuffix =
		templateTier === "builtin"
			? " (built-in)"
			: templateTier === "project"
				? " (project)"
				: " (global)";

	const paramNames = extractParamNames(template.task + (template.outputFile || ""));

	await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(
			new Text(
				theme.fg("accent", theme.bold(`Template: ${template.name}`)) +
					theme.fg("dim", tierSuffix),
				1,
				0,
			),
		);
		if (template.description)
			container.addChild(new Text(theme.fg("dim", template.description), 1, 0));
		container.addChild(new Text("", 0, 0));
		container.addChild(
			new Text(theme.fg("toolTitle", "Task:") + " " + theme.fg("toolOutput", template.task), 1, 0),
		);
		if (paramNames.length > 0) {
			container.addChild(
				new Text(theme.fg("dim", `Parameters: ${paramNames.join(", ")}`), 1, 0),
			);
		}
		if (template.preset)
			container.addChild(
				new Text(theme.fg("dim", `Preset: ${template.preset}`), 1, 0),
			);
		if (template.thinkingLevel)
			container.addChild(
				new Text(theme.fg("dim", `Thinking: ${template.thinkingLevel}`), 1, 0),
			);
		if (template.outputFile)
			container.addChild(
				new Text(theme.fg("dim", `Output file: ${template.outputFile}`), 1, 0),
			);
		if (template.timeout)
			container.addChild(
				new Text(theme.fg("dim", `Timeout: ${template.timeout}ms`), 1, 0),
			);
		container.addChild(new Text("", 0, 0));
		container.addChild(new Text(theme.fg("dim", "Press any key to close"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (_data: string) => done(),
		};
	});
}

export async function showTemplateManager(
	ctx: ExtensionContext,
	state: SessionState,
): Promise<void> {
	if (state.config.templates.length === 0) {
		ctx.ui.notify(
			"No task templates loaded — built-in templates ship with the extension and " +
			"should always be present. Add custom .md files in " +
			"~/.pi/agent/brl-subagent/templates/ or <project>/.pi/brl-subagent/templates/.",
			"info",
		);
		return;
	}

	// Tier-prefixed labels mirror showPresetManager: [P]roject / [G]lobal / [B]uiltin.
	const templateItems: SelectItem[] = state.config.templates.map((t) => {
		const source = findTemplateSource(t.name, ctx);
		const tierLabel = source === "project" ? "P" : source === "global" ? "G" : "B";
		return {
			value: t.name,
			label: `[${tierLabel}] ${t.name}`,
			description: t.description || t.task.slice(0, 60),
		};
	});

	const result = await showSelectList(
		ctx,
		`Templates (${state.config.templates.length})`,
		templateItems,
		15,
	);
	if (!result) return;

	await showViewTemplate(ctx, state, result);
}

// ---------------------------------------------------------------------------
// Configuration menu
// ---------------------------------------------------------------------------

/** Maximum config rows visible before the list scrolls (U3: 10 → 15). */
export const CONFIG_MENU_VIEWPORT = 15;

export function getConfigMenuItems(state: SessionState): SelectItem[] {
	// Menu polish U2: every value row renders the canonical token from
	// `formatMenuValue` (tui-format.ts) instead of hand-rolled prose. Templates
	// have no `customTemplates` field on state; the merged stack keeps the
	// BUILTIN objects by reference (getAllTemplates), so an identity partition
	// is the state-side equivalent of the manager's builtin/custom split.
	const builtinTemplateObjects = new Set<TaskTemplate>(state.builtinTemplates);
	const builtinTemplateCount = state.config.templates.filter((t) =>
		builtinTemplateObjects.has(t),
	).length;

	return [
		{
			value: "model",
			label: "Set Model",
			description: formatMenuValue("model", { model: state.config.model }),
		},
		{
			value: "thinking",
			label: "Set Max Thinking Level",
			description: formatMenuValue("thinking", {
				maxThinkingLevel: state.config.maxThinkingLevel,
			}),
		},
		{
			value: "concurrency",
			label: "Set Max Parallel Subagents",
			description: formatMenuValue("parallel", { maxParallel: state.config.maxParallel }),
		},
		{
			value: "depth",
			label: "Set Max Recursion Depth",
			description: formatMenuValue("depth", {
				maxSubagentDepth: state.config.maxSubagentDepth,
			}),
		},
		{
			value: "approval",
			label: "Set Change Approval Mode",
			description: formatMenuValue("approval", { approvalMode: state.config.approvalMode }),
		},
		{
			value: "completionnotify",
			label: "Set Completion Notify Mode",
			description: formatMenuValue("completionnotify", {
				completionNotify: state.config.completionNotify,
			}),
		},
		{
			value: "recovery",
			label: "Set Recovery Posture",
			description: formatMenuValue("recovery", { recovery: state.config.recovery }),
		},

		{
			value: "historyentries",
			label: "Set Max History Entries",
			description: formatMenuValue("historyentries", {
				maxHistoryEntries: state.config.maxHistoryEntries,
			}),
		},
		{
			value: "costlimit",
			label: "Set Session Cost Limit",
			description: formatMenuValue("costlimit", {
				sessionCostLimit: state.config.sessionCostLimit,
			}),
		},
		{
			value: "sla",
			label: "Set SLA Tracking",
			description: formatMenuValue("sla", {
				slaTrackingEnabled: state.config.slaTrackingEnabled,
				slaWindowSize: state.config.slaWindowSize,
			}),
		},
		menuSection("Run Activity"),
		{
			value: "history",
			label: "View Run History",
			description: "Browse past subagent runs",
		},
		{
			value: "monitor",
			label: "View Live Monitor",
			description: "Watch running subagents in real-time",
		},
		{
			value: "dashboard",
			label: "View Observability Dashboard",
			description: "Real-time metrics, SLA, errors, and cost trends",
		},
		{
			value: "retry",
			label: "Retry Failed Run",
			description: "Select a failed subagent to retry",
		},
		menuSection("Presets & Templates"),
		{
			value: "preset",
			label: "Browse Presets",
			description: formatMenuValue("presetCounts", {
				builtinCount: state.builtinPresets.length,
				customCount: state.customPresets.length,
			}),
		},
		{
			value: "templates",
			label: "Browse Templates",
			description: formatMenuValue("templateCounts", {
				builtinCount: builtinTemplateCount,
				customCount: state.config.templates.length - builtinTemplateCount,
			}),
		},
		{
			value: "reset",
			label: "Reset Configuration",
			description: "Clear subagent configuration",
		},
	];
}

export async function showConfigMenu(
	ctx: ExtensionContext,
	state: SessionState,
	actions: Record<string, () => Promise<void> | void>,
): Promise<void> {
	while (true) {
		const items = [
			...getConfigMenuItems(state),
			{
				value: "__done__",
				label: "Done",
				description: "Close this menu",
			},
		];

		const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();

			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(
				new Text(theme.fg("accent", theme.bold("brl-subagent Configuration")), 1, 0),
			);

			const selectList = new SelectList(
				items,
				Math.min(items.length, CONFIG_MENU_VIEWPORT),
				makeSelectListTheme(theme),
			);
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);

			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", NAV_FOOTER), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return {
				render: (w: number) => container.render(w),
				invalidate: () => container.invalidate(),
				handleInput: (data: string) => {
					selectList.handleInput(data);
					tui.requestRender();
				},
			};
		});

		if (!result || result === "__done__") return;

		if (result in actions) {
			await actions[result]();
		}
	}
}

// ---------------------------------------------------------------------------
// Run history viewer
// ---------------------------------------------------------------------------

/**
 * U3 Fix A: the recovery visibility bridge wired for a TUI surface. Session
 * run entries UNIONED with synthetic durable interrupted records the session
 * has never seen (a genuine fresh boot), deduped by id. Both the history list
 * and the retry menu read THIS, so they can never disagree about an interrupted
 * run that exists only in the durable registry.
 */
function recoverableRunEntries(ctx: ExtensionContext, state: SessionState): SubagentRun[] {
	return visibleRunEntriesForSession(state.getRunEntries(ctx), getAgent);
}

export async function showRunHistory(
	ctx: ExtensionContext,
	state: SessionState,
	persistState: () => void,
): Promise<void> {
	const statusIcon: Record<string, string> = {
		running: ctx.ui.theme.fg("accent", "◉"),
		done: ctx.ui.theme.fg("success", "✓"),
		failed: ctx.ui.theme.fg("error", "✗"),
		interrupted: ctx.ui.theme.fg("warning", "◌"),
	};

	// Browse loop (issue #260): list → detail → list … until the LIST is exited
	// with Esc. Closing a detail returns here, not to the /brl-subagent menu.
	while (true) {
		// One row per SETTLED run (issue #259): collapse each run's spawn+terminal
		// entry pair to its terminal-preferred record; in-flight runs are omitted
		// (the live monitor owns running state).
		const runs = collapseRunsForHistory(recoverableRunEntries(ctx, state));

		if (runs.length === 0) {
			ctx.ui.notify("No subagent runs recorded yet. Delegate a task to see history.", "info");
			return;
		}

		const items: SelectItem[] = runs.map((r) => {
			const status = runHistoryStatus(r);
			const icon = statusIcon[status] || "·";
			const name = runDisplayName(r);
			const model = r.model.split("/").pop() || r.model;
			const when = r.finishedAt
				? formatRunDuration(r.durationMs || 0)
				: status === "interrupted"
					? "interrupted"
					: "running...";
			const cost = r.cost ? ` $${r.cost.toFixed(4)}` : "";
			const desc = `${r.thinkingLevel} · ${model} · ${when}${cost}`;
			return { value: r.id, label: `${icon} ${name}`, description: desc };
		});

		const selectedId = await showSelectList(ctx, "Subagent History", items, 15);
		if (!selectedId) return; // Esc at the list exits to the menu

		const run = runs.find((r) => r.id === selectedId);
		if (!run) continue; // selected run pruned since listing — re-show the list

		// Mark as seen
		if (state.markRunSeen(run.id)) {
			persistState();
			import("./concurrency").then(({ updateProgressStatus }) => {
				updateProgressStatus(state, ctx);
			});
		}

		await showRunDetail(ctx, run);
	}
}

/**
 * Number of output lines a run-detail viewport shows at once (issue #261):
 * the stored text can be up to the 100 KB cap, so the panel is height-capped
 * and scrolled rather than dumped whole (which would push the footer and
 * header off-screen).
 */
const RUN_DETAIL_OUTPUT_VIEWPORT_LINES = 12;

/**
 * Detail view for one settled run (issue #260, #261): ↑/↓ and PgUp/PgDn scroll
 * the stored output; any OTHER key — including Esc — closes it. The
 * showRunHistory browse loop re-shows the list on return.
 *
 * The output region follows the approval dialog's full-diff view structure
 * (see `showApprovalDialog.buildDiffView` / `withDiffKeybinding`: a bordered
 * Container with a title, the content, and a return footer) but adds the
 * height cap + scroll state that view lacks. Output is wrapped through the
 * same `Text` component those views use, so wrapping/padding stay consistent.
 */
async function showRunDetail(ctx: ExtensionContext, run: SubagentRun): Promise<void> {
	const outputText = run.fullOutput ?? run.outputSummary ?? "";
	await ctx.ui.custom<void>((tui, theme, kb, done) => {
		// First line of the viewport (0 = top). Mutated by scroll keys and
		// clamped to the wrapped-content length on every render.
		let scrollTop = 0;
		// Wrapped output lines for the current width, and the width they were
		// produced at, so a resize re-wraps and a redraw does not.
		let wrappedLines: string[] = [];
		let wrappedWidth = -1;

		const wrapOutput = (width: number): string[] => {
			if (width === wrappedWidth) return wrappedLines;
			wrappedLines = new Text(theme.fg("toolOutput", outputText), 1, 0).render(width);
			wrappedWidth = width;
			return wrappedLines;
		};

		const buildOutputSection = (width: number): Container => {
			const section = new Container();
			const lines = wrapOutput(width);
			const total = lines.length;
			const maxScroll = Math.max(0, total - RUN_DETAIL_OUTPUT_VIEWPORT_LINES);
			if (scrollTop > maxScroll) scrollTop = maxScroll;
			if (scrollTop < 0) scrollTop = 0;
			const from = total === 0 ? 0 : Math.min(scrollTop + 1, total);
			const to = Math.min(scrollTop + RUN_DETAIL_OUTPUT_VIEWPORT_LINES, total);
			const indicator =
				total > RUN_DETAIL_OUTPUT_VIEWPORT_LINES
					? `  (lines ${from}\u2013${to} of ${total} \u00b7 \u2191\u2193 / PgUp\u00b7PgDn)`
					: `  (${total} line${total === 1 ? "" : "s"})`;

			section.addChild(
				new Text(
					theme.fg("muted", "\u2500\u2500\u2500 Output \u2500\u2500\u2500") + theme.fg("dim", indicator),
					1,
					0,
				),
			);

			if (total === 0) {
				section.addChild(new Text(theme.fg("dim", "(no output recorded)"), 1, 0));
				return section;
			}

			// Height-capped viewport: the output was already wrapped to `width`
			// above, so hand the sliced lines back directly instead of feeding them
			// through another Text (which would re-wrap at the padded width).
			const viewport: Component = {
				render: () => lines.slice(scrollTop, scrollTop + RUN_DETAIL_OUTPUT_VIEWPORT_LINES),
				invalidate: () => {
					wrappedWidth = -1;
				},
			};
			section.addChild(viewport);
			return section;
		};

		const buildDetailView = (width: number): Container => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			const statusLabel = runHistoryStatusLabel(run);
			container.addChild(
				new Text(
					theme.fg(
						"toolTitle",
						theme.bold(`${run.label || "Subagent"} — ${statusLabel}`),
					),
					1,
					0,
				),
			);
			container.addChild(new Text("", 0, 0));
			container.addChild(
				new Text(theme.fg("dim", `Task: ${run.task.slice(0, 200)}`), 1, 0),
			);
			container.addChild(
				new Text(
					theme.fg("dim", `Model: ${run.model} · Thinking: ${run.thinkingLevel}`),
					1,
					0,
				),
			);
			container.addChild(new Text(theme.fg("dim", `Started: ${run.startedAt}`), 1, 0));
			if (run.finishedAt) {
				container.addChild(
					new Text(
						theme.fg(
							"dim",
							`Finished: ${run.finishedAt} (${formatRunDuration(run.durationMs || 0)})`,
						),
						1,
						0,
					),
				);
			}
			if (run.cost) {
				container.addChild(
					new Text(
						theme.fg(
							"dim",
							`Cost: $${run.cost.toFixed(4)} · ↑${formatTokens(run.tokensIn || 0)} ↓${formatTokens(run.tokensOut || 0)}`,
						),
						1,
						0,
					),
				);
			}
			if (run.errorMessage) {
				container.addChild(new Spacer(1));
				container.addChild(
					new Text(theme.fg("error", `Error: ${run.errorMessage}`), 1, 0),
				);
			}

			container.addChild(new Spacer(1));
			container.addChild(buildOutputSection(width));
			// Honest disclosures (issue #261): the transcript is the only place the
			// uncapped text lives, and the cap is stated when it was hit.
			for (const line of buildOutputHonestyLines(run, DEFAULT_OUTPUT_CAP_BYTES)) {
				container.addChild(new Text(theme.fg("dim", line), 1, 0));
			}

			container.addChild(new Spacer(1));
			container.addChild(
				new Text(
					theme.fg("dim", "\u2191\u2193 scroll \u00b7 alt+\u2191\u2193 page \u00b7 any other key to close"),
					1,
					0,
				),
			);
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			return container;
		};

		return {
			render: (w: number) => buildDetailView(w).render(w),
			invalidate: () => {},
			handleInput: (data: string) => {
				// Paging: alt+↑ / alt+↓. Checked BEFORE the plain arrows so an
				// alt-modified sequence can never be consumed as a line step.
				// PgUp/PgDn are unusable here: the host binds them to the
				// alt-screen transcript scroll (`tui.altScreen.pageUp/pageDown`)
				// and consumes them before a `ctx.ui.custom` overlay sees input —
				// pi 1.0.2 has no viewport-owner registration for overlays. The
				// PgUp/PgDn checks below stay for inline mode, where they do
				// reach the overlay.
				if (matchesKey(data, "alt+up")) {
					scrollTop -= RUN_DETAIL_OUTPUT_VIEWPORT_LINES;
					tui.requestRender();
					return;
				}
				if (matchesKey(data, "alt+down")) {
					scrollTop += RUN_DETAIL_OUTPUT_VIEWPORT_LINES;
					tui.requestRender();
					return;
				}
				if (kb.matches(data, "tui.select.up")) {
					scrollTop -= 1;
					tui.requestRender();
					return;
				}
				if (kb.matches(data, "tui.select.down")) {
					scrollTop += 1;
					tui.requestRender();
					return;
				}
				if (kb.matches(data, "tui.select.pageUp")) {
					scrollTop -= RUN_DETAIL_OUTPUT_VIEWPORT_LINES;
					tui.requestRender();
					return;
				}
				if (kb.matches(data, "tui.select.pageDown")) {
					scrollTop += RUN_DETAIL_OUTPUT_VIEWPORT_LINES;
					tui.requestRender();
					return;
				}
				done();
			},
		};
	});
}

// ---------------------------------------------------------------------------
// Live monitor dashboard
// ---------------------------------------------------------------------------

export async function showMonitor(
	ctx: ExtensionContext,
	state: SessionState,
): Promise<void> {
	// Issue #52: self-heal stale live entries BEFORE the empty guard — a map
	// holding only terminal entries (poller died mid-run) must render as
	// empty, not as a live monitor full of ghosts.
	sweepStaleLiveSubagents(state, getAgent);

	if (state.subagentSessions.size === 0) {
		ctx.ui.notify(
			"No subagents are currently running. Delegate a task to see live activity.",
			"info",
		);
		return;
	}

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		// Selected row index (0-based). Clamped to the map size on every
		// render — entries can be swept while the monitor is open.
		let selectedIndex = 0;
		// Guards against stacking drill-in overlays on repeated Enter.
		let detailOpen = false;

		const buildView = () => {
			// Issue #52: continuous self-heal — a background agent can complete
			// (poller dead) while the monitor is already open; sweep on every
			// render pass. Idempotent, so racing the poller is safe.
			sweepStaleLiveSubagents(state, getAgent);

			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(
				new Text(
					theme.fg(
						"accent",
						theme.bold(`Subagent Monitor (${state.subagentSessions.size} active)`),
					),
					1,
					0,
				),
			);
			container.addChild(
				new Text(theme.fg("dim", "esc close · ↑/↓ select · enter drill-in"), 1, 0),
			);
			container.addChild(new Text("", 0, 0));

			const entries = Array.from(state.subagentSessions.entries());
			const selIdx = Math.min(selectedIndex, Math.max(0, entries.length - 1));

			let idx = 0;
			for (const [id, session] of entries) {
				const elapsedStr = formatElapsed(Date.now() - session.startedAt);
				const name = liveRowName(session.label, session.task);
				const spinner = liveSpinner(Date.now());
				// Selection marker: a "›" prefix on the selected row only. The
				// rest of the row (spinner/name/dim/muted lines) is unchanged.
				const marker = idx === selIdx ? "› " : "";

				container.addChild(
					new Text(
						theme.fg("accent", `${marker}${spinner} ${name}`) +
						theme.fg(
							"dim",
							formatLiveRowDim(id, session.usage, elapsedStr),
						),
						1,
						0,
					),
				);
				container.addChild(
					new Text(
						theme.fg(
							"muted",
							`   ${session.thinkingLevel} \u00b7 ${session.model.split("/").pop() || session.model}`,
						),
						1,
						0,
					),
				);

				if (session.liveOutput) {
					const lastLine =
						session.liveOutput
							.split("\n")
							.filter(Boolean)
							.pop() || "";
					if (lastLine) {
						container.addChild(
							new Text(theme.fg("toolOutput", `   ${lastLine.slice(0, 60)}`), 1, 0),
						);
					}
				}

				idx++;
				if (idx < entries.length) container.addChild(new Text("", 0, 0));
			}

			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			return container;
		};

		const interval = setInterval(() => tui.requestRender(), 200);
		const cleanup = () => clearInterval(interval);

		return {
			render: (w: number) => buildView().render(w),
			invalidate: () => {},
			handleInput: (data: string) => {
				// esc / q: close the monitor (existing behavior).
				if (_kb.matches(data, "tui.select.cancel") || data === "q") {
					cleanup();
					done();
					return;
				}
				// up / down: move the selection, wrapping like SelectList.
				if (_kb.matches(data, "tui.select.up")) {
					const count = state.subagentSessions.size;
					selectedIndex = count > 0 ? (selectedIndex - 1 + count) % count : 0;
					tui.requestRender();
					return;
				}
				if (_kb.matches(data, "tui.select.down")) {
					const count = state.subagentSessions.size;
					selectedIndex = count > 0 ? (selectedIndex + 1) % count : 0;
					tui.requestRender();
					return;
				}
				// enter: open the full-screen drill-in overlay for the selected agent.
				// The overlay's done() returns to the list — the monitor stays open
				// beneath it (fire-and-forget; handleInput is synchronous).
				if (_kb.matches(data, "tui.select.confirm")) {
					const ids = Array.from(state.subagentSessions.keys());
					const id = ids[Math.min(selectedIndex, ids.length - 1)];
					if (id && !detailOpen) {
						detailOpen = true;
						showAgentDetail(ctx, state, id).finally(() => {
							detailOpen = false;
						});
					}
				}
			},
		};
	});
}

// ---------------------------------------------------------------------------
// Drill-in overlay: full-screen transcript tail for one agent
// ---------------------------------------------------------------------------

/** Map a planned transcript line style to a theme color name. */
function styleToColor(
	theme: Theme,
	style: TranscriptLineStyle,
	text: string,
): string {
	switch (style) {
		case "user":
			return theme.fg("muted", text);
		case "thinking":
			return theme.fg("dim", text);
		case "text":
			return theme.fg("toolOutput", text);
		case "toolCall":
			return theme.fg("accent", text);
		case "toolResult":
			return theme.fg("muted", text);
		case "note":
			return theme.fg("dim", text);
		case "streaming":
			return theme.fg("accent", text);
	}
	return theme.fg("dim", text);
}

/**
 * Full-screen drill-in: the live transcript TAIL of one running agent.
 *
 * Rendered via ctx.ui.custom with a full-screen overlay (width "100%",
 * maxHeight "100%"; the component pads itself to the terminal height). The
 * overlay tracks the agent's session ref (`getAgent(id)._sessionRef`) and
 * refreshes at 200ms while open. Esc returns to the list monitor beneath
 * (this overlay's done() only closes the overlay).
 *
 * Access path verified: `getAgent(agentId)` (session-manager) returns the
 * BackgroundAgent whose `_sessionRef` is the live AgentSession; the transcript
 * is `_sessionRef.messages`, the in-progress message is
 * `_sessionRef.state.streamingMessage`, and liveness is `_sessionRef.isStreaming`.
 * When the agent completes, the settle handler releases `_sessionRef`
 * (issue #31) — the overlay then renders a cached tail once and stops
 * refreshing.
 */
export async function showAgentDetail(
	ctx: ExtensionContext,
	state: SessionState,
	agentId: string,
): Promise<void> {
	await ctx.ui.custom<void>(
		(tui, theme, _kb, done) => {
			// Set once the session ref is gone (agent finished / record removed):
			// renders the finished view once and stops the refresh loop.
			let finished = false;
			// Tail captured at finish time for the one-shot "finished" render.
			let cachedTail = "";
			// Last seen live transcript (foreground runs — issue #105), cached so
			// the one-shot finished render still shows it after the live entry is
			// finalized and deleted.
			let cachedTranscript: TranscriptMessage[] | undefined;

			const buildView = () => {
				const agent = getAgent(agentId);
				const session = agent?._sessionRef;
				const live = state.subagentSessions.get(agentId);

				const container = new Container();
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

				const name = liveRowName(
					live?.label,
					live?.task ?? agent?.task ?? "",
				);
				const shortId = agentId.slice(0, 8);
				const modelShort =
					(live?.model ?? agent?.model ?? "").split("/").pop() ||
					live?.model ||
					agent?.model ||
					"";
				const thinkingLevel = live?.thinkingLevel ?? agent?.thinkingLevel ?? "";
				const priority = live?.priority ?? agent?.priority;
				const startedAt = live?.startedAt ?? agent?.startedAt ?? Date.now();
				const elapsed = formatElapsed(Date.now() - startedAt);
				// Issue #114: per-unit priority is part of the identity line when the
				// run carried one (p:critical etc.); absent → no segment at all.
				const metaSegment = [modelShort, thinkingLevel, priority ? `p:${priority}` : null]
					.filter(Boolean)
					.join(" · ");

				container.addChild(
					new Text(
						theme.fg("accent", theme.bold(name)) +
							theme.fg(
								"dim",
								`  [${shortId}]  ${metaSegment} · ${elapsed}`,
							),
						1,
						0,
					),
				);
				container.addChild(new Text(theme.fg("dim", "esc close"), 1, 0));
				container.addChild(new Spacer(1));

				if (!agent) {
					// Foreground run (issue #105): no BackgroundAgent record exists —
					// the live transcript comes from the streaming JSON pipeline,
					// threaded through the live entry, and is rendered through the
					// SAME planner the background path uses. The refresh loop keeps
					// ticking while the live entry exists.
					if (live) {
						const transcript = live.transcript ?? [];
						cachedTranscript = transcript;
						cachedTail = live.liveOutput;
						container.addChild(new Spacer(1));
						if (transcript.length === 0) {
							// No messages yet — the agent is still in preflight.
							container.addChild(
								new Text(theme.fg("dim", "waiting for first output…"), 1, 0),
							);
						} else {
							const planned = renderTranscriptMessages(transcript, {
								maxLines: Math.max(6, tui.terminal.rows - 5),
								maxWidth: Math.max(20, tui.terminal.columns - 4),
								streaming: !state.isLiveEntryFinalized(agentId),
								spinner: liveSpinner(Date.now()),
							});
							for (const line of planned) {
								container.addChild(
									new Text(styleToColor(theme, line.style, line.text), 1, 0),
								);
							}
						}
						container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
						return container;
					}

					// The foreground run completed and its live entry was finalized
					// and deleted — render the last captured transcript once and stop.
					if (!finished) {
						finished = true;
					}
					container.addChild(
						new Text(theme.fg("dim", "agent finished — transcript ends here"), 1, 0),
					);
					if (cachedTranscript && cachedTranscript.length > 0) {
						container.addChild(new Spacer(1));
						const planned = renderTranscriptMessages(cachedTranscript, {
							maxLines: Math.max(6, tui.terminal.rows - 5),
							maxWidth: Math.max(20, tui.terminal.columns - 4),
						});
						for (const line of planned) {
							container.addChild(
								new Text(styleToColor(theme, line.style, line.text), 1, 0),
							);
						}
					} else {
						// R3 (review): stale foreground selection — the live entry was
						// finalized and deleted before first render, so neither the
						// transcript nor the live tail were ever captured here. Fall
						// back to the persisted run record's fullOutput (the completion
						// path persists it), mirroring the background path's
						// `agent?.finalOutput` fallback.
						const runOutput =
							cachedTail || state.findTerminalRunById(ctx, agentId)?.fullOutput || "";
						const tailLines = runOutput.split("\n").filter(Boolean).slice(-10);
						if (tailLines.length > 0) {
							container.addChild(new Spacer(1));
							for (const line of tailLines) {
								container.addChild(new Text(theme.fg("toolOutput", line), 1, 0));
							}
						}
					}
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					return container;
				}

				if (!session) {
					// The agent completed (or its record vanished) while the overlay
					// was open — capture the last known output once and stop.
					if (!finished) {
						finished = true;
						cachedTail = live?.liveOutput ?? agent?.finalOutput ?? "";
					}
					container.addChild(
						new Text(theme.fg("dim", "agent finished — transcript ends here"), 1, 0),
					);
					const tailLines = cachedTail.split("\n").filter(Boolean).slice(-10);
					if (tailLines.length > 0) {
						container.addChild(new Spacer(1));
						for (const line of tailLines) {
							container.addChild(new Text(theme.fg("toolOutput", line), 1, 0));
						}
					}
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					return container;
				}

				const messages = session.messages ?? [];
				const streaming = session.state?.streamingMessage;
				const planned = renderTranscriptMessages(
					streaming ? [...messages, streaming] : messages,
					{
						maxLines: Math.max(6, tui.terminal.rows - 5),
						maxWidth: Math.max(20, tui.terminal.columns - 4),
						streaming: Boolean(streaming),
						spinner: liveSpinner(Date.now()),
					},
				);

				if (planned.length === 0) {
					// No messages yet — the agent is still in preflight.
					container.addChild(
						new Text(theme.fg("dim", "waiting for first output…"), 1, 0),
					);
				} else {
					for (const line of planned) {
						container.addChild(new Text(styleToColor(theme, line.style, line.text), 1, 0));
					}
				}

				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				return container;
			};

			// Live refresh while open (D2b — the overlay tracks the agent).
			const interval = setInterval(() => {
				if (finished) return; // terminal view rendered once — no more redraws
				tui.requestRender();
			}, 200);
			const cleanup = () => clearInterval(interval);

			return {
				render: (w: number) => {
					const lines = buildView().render(w);
					// Full-screen: pad the overlay content to the terminal height so
					// the drill-in occupies the whole screen (the tui overlay sizes
					// to its rendered content otherwise).
					const rows = tui.terminal.rows;
					for (let i = lines.length; i < rows; i++) lines.push(" ".repeat(w));
					return lines;
				},
				invalidate: () => {},
				handleInput: (data: string) => {
					if (_kb.matches(data, "tui.select.cancel") || data === "q") {
						cleanup();
						done();
					}
				},
			};
		},
		{
			overlay: true,
			overlayOptions: {
				width: "100%",
				maxHeight: "100%",
				anchor: "center",
			},
		},
	);
}

// ---------------------------------------------------------------------------
// E1: Observability Dashboard
// ---------------------------------------------------------------------------

/**
 * Horizontal bar for error breakdown using Unicode block characters.
 */
function buildHorizontalBar(count: number, maxCount: number, maxWidth: number): string {
	if (maxCount === 0 || count === 0) return '';
	const barLen = Math.max(1, Math.round((count / maxCount) * maxWidth));
	return '\u2588'.repeat(barLen);
}

/**
 * Format a duration in ms to a compact string for the recent runs table.
 */
function compactDuration(ms: number): string {
	if (ms < 1000) return `${ms}ms`;
	if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
	return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`;
}

export async function showDashboard(
	ctx: ExtensionContext,
	state: SessionState,
): Promise<void> {
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const buildView = () => {
			// Issue #52: self-heal stale live entries on every render pass —
			// an agent whose poller died shows as "running" forever otherwise.
			sweepStaleLiveSubagents(state, getAgent);

			const container = new Container();
			const now = new Date();
			const refreshStr = `refreshing \u00b7 ${now.toLocaleTimeString()}`;

			// ---- Panel 1: Header ----
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(
				new Text(
					theme.fg("accent", theme.bold("brl-subagent Dashboard")) +
						theme.fg("dim", `  ${refreshStr}`),
				1,
				0,
			),
			);
			container.addChild(new Text("", 0, 0));

			// ---- Panel 2: Active subagents ----
			const activeCount = state.subagentSessions.size;
			container.addChild(
				new Text(
					theme.fg("accent", theme.bold(`Active Subagents (${activeCount})`)),
					1,
					0,
				),
			);
			if (activeCount === 0) {
				container.addChild(new Text(theme.fg("dim", "  None running"), 1, 0));
			} else {
				let idx = 0;
				for (const [id, session] of state.subagentSessions) {
					const elapsedStr = formatElapsed(Date.now() - session.startedAt);
					const name = liveRowName(session.label, session.task);
					const spinner = liveSpinner(Date.now());
					container.addChild(
						new Text(
							theme.fg("accent", `  ${spinner} ${name}`) +
								theme.fg(
									"dim",
									formatLiveRowDim(id, session.usage, elapsedStr),
								),
							1,
							0,
						),
					);
					idx++;
					if (idx < activeCount) container.addChild(new Text("", 0, 0));
				}
			}
			container.addChild(new Text("", 0, 0));

			// ---- Panel 3: SLA Summary ----
			const allRuns = state.getRunEntries(ctx);
			const recentRuns = allRuns.slice(0, state.config.slaWindowSize || 50);
			const metrics = recentRuns.length > 0 ? computeSLAMetrics(recentRuns) : null;

			container.addChild(
				new Text(
					theme.fg("accent", theme.bold(`SLA Summary (last ${recentRuns.length} runs)`)),
					1,
					0,
				),
			);
			if (metrics && metrics.totalRuns > 0) {
				const successPct = (metrics.successRate * 100).toFixed(1);
				const successColor = metrics.successRate >= 0.9 ? "success" : metrics.successRate >= 0.7 ? "warning" : "error";
				container.addChild(
					new Text(
						theme.fg("dim", "  Success: ") +
							theme.fg(successColor, `${successPct}%`) +
							theme.fg("dim", ` \u00b7 p50: ${compactDuration(metrics.p50DurationMs)} \u00b7 p95: ${compactDuration(metrics.p95DurationMs)} \u00b7 p99: ${compactDuration(metrics.p99DurationMs)}`),
					1,
					0,
				),
				);
				container.addChild(
					new Text(
						theme.fg("dim", "  Cost:      ") +
							theme.fg("dim", `total $${metrics.totalCost.toFixed(4)} \u00b7 avg $${metrics.averageCost.toFixed(4)}`),
					1,
					0,
				),
				);
			} else {
				container.addChild(new Text(theme.fg("dim", "  No completed runs yet"), 1, 0));
			}
			container.addChild(new Text("", 0, 0));

			// ---- Panel 4: Recent Runs (last 10) ----
			const recent10 = allRuns.slice(0, 10);
			container.addChild(
				new Text(
					theme.fg("accent", theme.bold("Recent Runs")),
					1,
					0,
				),
			);
			if (recent10.length === 0) {
				container.addChild(new Text(theme.fg("dim", "  No runs recorded"), 1, 0));
			} else {
				for (const run of recent10) {
					const icon =
						run.status === "done"
							? theme.fg("success", "\u2713")
							: run.status === "failed"
								? theme.fg("error", "\u2717")
								: theme.fg("accent", "\u25CF");
					const name = run.label || run.task.slice(0, 50);
					const dur = run.durationMs ? compactDuration(run.durationMs) : "...";
					const cost = run.cost ? ` $${run.cost.toFixed(4)}` : "";
					container.addChild(
						new Text(
							`  ${icon} ${theme.fg("dim", name.slice(0, 50))}` +
								theme.fg("dim", `  ${dur}${cost}`),
							1,
							0,
						),
					);
				}
			}
			container.addChild(new Text("", 0, 0));

			// ---- Panel 5: Error Breakdown ----
			container.addChild(
				new Text(
					theme.fg("accent", theme.bold("Error Breakdown")),
					1,
					0,
				),
			);
			if (metrics && Object.keys(metrics.errorCategoryBreakdown).length > 0) {
				const cats = Object.entries(metrics.errorCategoryBreakdown).sort(
					(a, b) => b[1] - a[1],
				);
				const maxCount = cats[0][1];
				for (const [cat, count] of cats) {
					const bar = buildHorizontalBar(count, maxCount, 20);
					container.addChild(
						new Text(
							theme.fg("dim", `  ${cat.padEnd(18)} `) +
								theme.fg("error", bar) +
								theme.fg("dim", ` ${count}`),
						1,
						0,
					),
				);
				}
			} else {
				container.addChild(new Text(theme.fg("success", "  No errors \u2713"), 1, 0));
			}
			container.addChild(new Text("", 0, 0));

			// ---- Panel 6: Cost Trend (sparkline) ----
			container.addChild(
				new Text(
					theme.fg("accent", theme.bold("Cost Trend (last 20 runs)")),
					1,
					0,
				),
			);
			const costTrend = computeCostTrend(allRuns, 20);
			if (costTrend.length > 0) {
				const sparkline = formatSparkline(costTrend);
				const totalCost = costTrend.reduce((s, c) => s + c, 0);
				container.addChild(
					new Text(
						theme.fg("dim", "  ") + theme.fg("accent", sparkline),
						1,
						0,
					),
				);
				container.addChild(
					new Text(
						theme.fg("dim", `  ${costTrend.length} runs \u00b7 total $${totalCost.toFixed(4)} \u00b7 avg $${(totalCost / costTrend.length).toFixed(4)}`),
						1,
						0,
					),
				);
			} else {
				container.addChild(new Text(theme.fg("dim", "  No cost data"), 1, 0));
			}

			container.addChild(new Text("", 0, 0));
			container.addChild(new Text(theme.fg("dim", "q / esc to close"), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return container;
		};

		// Auto-refresh every 2 seconds
		const interval = setInterval(() => tui.requestRender(), 2000);
		const cleanup = () => clearInterval(interval);

		return {
			render: (w: number) => buildView().render(w),
			invalidate: () => {},
			handleInput: (_data: string) => {
				cleanup();
				done();
			},
		};
	});
}

// ---------------------------------------------------------------------------
// Retry menu
// ---------------------------------------------------------------------------

export async function showRetryMenu(
	ctx: ExtensionContext,
	state: SessionState,
	// U3 (D5): the abandon action is injected by the extension entry point (it
	// owns the session-manager/registry wiring). Omitted in read-only contexts.
	onAbandon?: (id: string) => void | Promise<void>,
): Promise<void> {
	// U3 (D3): failed AND unresolved interrupted runs share this surface, one row
	// per run, built on the same terminal-preferred collapse the history uses.
	const candidates = retryableRuns(recoverableRunEntries(ctx, state));

	if (candidates.length === 0) {
		ctx.ui.notify("No failed or interrupted subagent runs to retry.", "info");
		return;
	}

	const items: SelectItem[] = candidates.map((r) => {
		const interrupted = isInterruptedRun(r);
		const name = runDisplayName(r);
		const model = r.model.split("/").pop() || r.model;
		const err = r.errorMessage ? r.errorMessage.slice(0, 40) : interrupted ? "interrupted" : "error";
		return {
			value: r.id,
			label: `${interrupted ? "◌" : "✗"} ${name}`,
			description: `${interrupted ? "interrupted · " : ""}${model} · ${err}`,
		};
	});

	const selectedId = await showSelectList(ctx, "Retry Failed or Interrupted Run", items, 10);
	if (!selectedId) return;

	const run = candidates.find((r) => r.id === selectedId);
	if (!run) return;

	if (isInterruptedRun(run) && onAbandon) {
		const action = await showSelectList(
			ctx,
			"Interrupted Run",
			[
				{ value: "retry", label: "Retry", description: "Re-dispatch with its recorded params (retryRunId)" },
				{ value: "abandon", label: "Abandon", description: "Finalize as stopped and prune its session file" },
			],
			5,
		);
		if (!action) return;
		if (action === "abandon") {
			await onAbandon(run.id);
			ctx.ui.notify(`Abandoned interrupted run ${run.id.slice(0, 8)}.`, "info");
			return;
		}
	}

	ctx.ui.notify(buildRetryOfferMessage(run), "info");
}

// ---------------------------------------------------------------------------
// delegate_task result rendering (renderCall / renderResult)
// ---------------------------------------------------------------------------

function buildDelegateLabel(
	args: { inheritSystemPrompt?: boolean; systemPrompt?: string },
	theme: Theme,
): string {
	const inherit = args.inheritSystemPrompt !== false;
	const hasCustom = Boolean(args.systemPrompt);
	const badge = inherit
		? hasCustom
			? "[inherit+custom]"
			: null
		: hasCustom
			? "[custom]"
			: "[no-inherit]";
	return badge
		? theme.fg("accent", "delegate_task ") + theme.fg("muted", badge)
		: theme.fg("toolTitle", theme.bold("delegate_task "));
}

function buildScopeLabel(
	args: { tools?: string[]; excludeTools?: string[]; noBuiltinTools?: boolean },
	theme: Theme,
): string {
	if (args.noBuiltinTools) return theme.fg("muted", " [no-builtins]");
	if (args.tools?.length) return theme.fg("muted", ` [tools:${args.tools.join(",")}]`);
	if (args.excludeTools?.length) return theme.fg("muted", ` [-${args.excludeTools.join(",")}]`);
	return "";
}

function renderExpandedResult(
	details: SubagentResult,
	isError: boolean,
	icon: string,
	finalOutput: string,
	theme: Theme,
	mdTheme: ReturnType<typeof getMarkdownTheme>,
): Container {
	const container = new Container();
	const labelText = details.label ? theme.fg("accent", ` [${details.label}]`) : "";
	container.addChild(
		new Text(
			`${icon} ${theme.fg("toolTitle", theme.bold("subagent"))}` +
				labelText +
				(details.model ? theme.fg("muted", ` (${details.model})`) : ""),
			0,
			0,
		),
	);
	if (isError && details.errorMessage) {
		container.addChild(
			new Text(theme.fg("error", `Error: ${details.errorMessage}`), 0, 0),
		);
	}
	if (finalOutput) {
		container.addChild(new Spacer(1));
		container.addChild(
			new Text(theme.fg("muted", "\u2500\u2500\u2500 Output \u2500\u2500\u2500"), 0, 0),
		);
		container.addChild(new Markdown(finalOutput.trim(), 0, 0, mdTheme));
	}
	// P5: Expanded diff section
	addExpandedDiffSection(container, details.gitDiff, theme);
	const usageStr = formatUsageStats(details.usage, details.model);
	if (usageStr) {
		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
	}
	return container;
}

function renderCollapsedText(
	details: SubagentResult,
	isError: boolean,
	icon: string,
	finalOutput: string,
	theme: Theme,
): string {
	let text =
		`${icon} ${theme.fg("toolTitle", theme.bold("subagent"))}` +
		(details.label ? theme.fg("accent", ` [${details.label}]`) : "") +
		(details.model ? theme.fg("muted", ` (${details.model})`) : "");
	if (isError && details.errorMessage) {
		text += `\n${theme.fg("error", `Error: ${details.errorMessage}`)}`;
	} else if (finalOutput) {
		const preview = finalOutput
			.split("\n")
			.slice(0, COLLAPSED_OUTPUT_LINES)
			.join("\n");
		text += `\n${theme.fg("toolOutput", preview)}`;
		if (finalOutput.split("\n").length > COLLAPSED_OUTPUT_LINES) {
			text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
		}
	}
	// P5: Collapsed diff file summary
	const diffSummary = renderCollapsedDiffSummary(details.gitDiff, theme);
	if (diffSummary) text += `\n${diffSummary}`;
	const usageStr = formatUsageStats(details.usage, details.model);
	if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
	return text;
}

// ---------------------------------------------------------------------------
// Chain / parallel collapsed rendering
// ---------------------------------------------------------------------------

function renderCollapsedChain(
	details: ChainDetails,
	theme: Theme,
): string {
	const allSucceeded = details.results.every((r) => !isSubagentError(r));
	const icon = allSucceeded
		? theme.fg("success", "\u2713")
		: theme.fg("error", "\u2717");
	const stoppedEarly = details.stoppedEarly ? " (stopped early)" : "";
	let text = `${icon} ${theme.fg("toolTitle", theme.bold("chain"))} ${theme.fg("muted", `${details.completedSteps}/${details.totalSteps} steps${stoppedEarly}`)}`;

	for (const r of details.results) {
		const isErr = isSubagentError(r);
		const statusIcon = isErr
			? theme.fg("error", "\u2717")
			: theme.fg("success", "\u2713");
		const stepNum =
			r.step !== undefined ? theme.fg("muted", `${r.step}. `) : "";
		const label = r.label ? theme.fg("accent", r.label) : "";
		const output = getFinalOutput(r.messages);
		const preview = output.split("\n").slice(0, 2).join("\n");
		const sep = label ? ": " : "";
		text += `\n${stepNum}${statusIcon} ${label}${sep}${theme.fg("toolOutput", preview)}`;
		if (r.errorMessage) {
			text += `\n   ${theme.fg("error", r.errorMessage)}`;
		}
		// P5: Collapsed diff file summary per step
		const diffSummary = renderCollapsedDiffSummary(r.gitDiff, theme);
		if (diffSummary) text += `\n   ${diffSummary}`;
	}

	text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return text;
}

function renderCollapsedParallel(
	details: ParallelDetails,
	theme: Theme,
): string {
	const icon =
		details.failed === 0
			? theme.fg("success", "\u2713")
			: theme.fg("error", "\u2717");
	let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel"))} ${theme.fg("muted", `${details.succeeded}/${details.failed}/${details.results.length} total`)}`;

	for (const r of details.results) {
		const isErr = isSubagentError(r);
		const statusIcon = isErr
			? theme.fg("error", "\u2717")
			: theme.fg("success", "\u2713");
		const label = r.label ? theme.fg("accent", r.label) : "";
		const output = getFinalOutput(r.messages);
		const preview = output.split("\n").slice(0, 2).join("\n");
		const sep = label ? ": " : " ";
		text += `\n${statusIcon} ${label}${sep}${theme.fg("toolOutput", preview)}`;
		if (r.errorMessage) {
			text += `\n   ${theme.fg("error", r.errorMessage)}`;
		}
		// P5: Collapsed diff file summary per task
		const diffSummary = renderCollapsedDiffSummary(r.gitDiff, theme);
		if (diffSummary) text += `\n   ${diffSummary}`;
	}

	text += `\n${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return text;
}

// ---------------------------------------------------------------------------
// Chain / parallel expanded rendering
// ---------------------------------------------------------------------------

function renderExpandedChain(
	details: ChainDetails,
	theme: Theme,
	mdTheme: ReturnType<typeof getMarkdownTheme>,
): Container {
	const container = new Container();
	const stoppedEarly = details.stoppedEarly ? " (stopped early)" : "";
	container.addChild(
		new Text(
			theme.fg("accent", theme.bold("Chain")) +
				theme.fg(
					"muted",
					` ${details.completedSteps}/${details.totalSteps} steps${stoppedEarly}`,
				),
			0,
			0,
		),
	);
	container.addChild(new Spacer(1));

	for (const r of details.results) {
		const isErr = isSubagentError(r);
		const statusIcon = isErr
			? theme.fg("error", "\u2717")
			: theme.fg("success", "\u2713");
		const stepNum = r.step !== undefined ? `${r.step}. ` : "";
		const label = r.label ? `[${r.label}] ` : "";
		container.addChild(
			new Text(
				`${statusIcon} ${stepNum}${theme.fg("toolTitle", theme.bold(label))}` +
					(r.model ? theme.fg("muted", ` (${r.model})`) : ""),
				0,
				0,
			),
		);
		container.addChild(
			new Text(theme.fg("dim", `Task: ${r.task.slice(0, 200)}`), 0, 0),
		);

		if (isErr && r.errorMessage) {
			container.addChild(
				new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0),
			);
		}

		const output = getFinalOutput(r.messages);
		if (output) {
			container.addChild(
				new Text(theme.fg("muted", "\u2500\u2500\u2500 Output \u2500\u2500\u2500"), 0, 0),
			);
			container.addChild(new Markdown(output.trim(), 0, 0, mdTheme));
		}

		// P5: Expanded diff section per step
		addExpandedDiffSection(container, r.gitDiff, theme);

		const usageStr = formatUsageStats(r.usage, r.model);
		if (usageStr) {
			container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
		}
		container.addChild(new Spacer(1));
	}

	// Aggregated totals
	const aggUsage: UsageStats = {
		input: details.totalInput,
		output: details.totalOutput,
		cacheRead: 0,
		cacheWrite: 0,
		cost: details.totalCost,
		contextTokens: 0,
		turns: details.totalTurns,
	};
	const aggStr = formatUsageStats(aggUsage);
	if (aggStr) {
		container.addChild(
			new Text(theme.fg("dim", `Totals: ${aggStr}`), 0, 0),
		);
	}

	return container;
}

function renderExpandedParallel(
	details: ParallelDetails,
	theme: Theme,
	mdTheme: ReturnType<typeof getMarkdownTheme>,
): Container {
	const container = new Container();
	container.addChild(
		new Text(
			theme.fg("accent", theme.bold("Parallel")) +
				theme.fg(
					"muted",
					` ${details.succeeded} succeeded, ${details.failed} failed, ${details.results.length} total`,
				),
			0,
			0,
		),
	);
	container.addChild(new Spacer(1));

	for (const r of details.results) {
		const isErr = isSubagentError(r);
		const statusIcon = isErr
			? theme.fg("error", "\u2717")
			: theme.fg("success", "\u2713");
		const label = r.label ? `[${r.label}] ` : "";
		container.addChild(
			new Text(
				`${statusIcon} ${theme.fg("toolTitle", theme.bold(label))}` +
					(r.model ? theme.fg("muted", ` (${r.model})`) : ""),
				0,
				0,
			),
		);
		container.addChild(
			new Text(theme.fg("dim", `Task: ${r.task.slice(0, 200)}`), 0, 0),
		);

		if (isErr && r.errorMessage) {
			container.addChild(
				new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0),
			);
		}

		const output = getFinalOutput(r.messages);
		if (output) {
			container.addChild(
				new Text(theme.fg("muted", "\u2500\u2500\u2500 Output \u2500\u2500\u2500"), 0, 0),
			);
			container.addChild(new Markdown(output.trim(), 0, 0, mdTheme));
		}

		// P5: Expanded diff section per task
		addExpandedDiffSection(container, r.gitDiff, theme);

		const usageStr = formatUsageStats(r.usage, r.model);
		if (usageStr) {
			container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
		}
		container.addChild(new Spacer(1));
	}

	// Aggregated totals
	const aggUsage: UsageStats = {
		input: details.totalInput,
		output: details.totalOutput,
		cacheRead: 0,
		cacheWrite: 0,
		cost: details.totalCost,
		contextTokens: 0,
		turns: details.totalTurns,
	};
	const aggStr = formatUsageStats(aggUsage);
	if (aggStr) {
		container.addChild(
			new Text(theme.fg("dim", `Totals: ${aggStr}`), 0, 0),
		);
	}

	return container;
}

// ---------------------------------------------------------------------------
// P4: Approval dialog — user reviews diff before merging
// ---------------------------------------------------------------------------

/**
 * Show approval dialog for subagent changes.
 * Returns "apply" to merge the branch, "discard" to delete it, or null if cancelled.
 */
export async function showApprovalDialog(
	ctx: ExtensionContext,
	label: string | undefined,
	gitDiff: string,
	gitBranch: string,
): Promise<"apply" | "discard" | null> {
	const diffLines = gitDiff.split("\n");
	const filesChanged = (gitDiff.match(/^diff --git /gm) || []).length;
	const hasMoreLines = diffLines.length > 20;
	const previewLines = diffLines.slice(0, 20).join("\n");

	return ctx.ui.custom<"apply" | "discard" | null>((tui, theme, _kb, done) => {
		let currentView: "menu" | "diff" = "menu";
		let selectList: SelectList | null = null;

		const items: SelectItem[] = [
			{
				value: "apply",
				label: "[Y] Apply changes",
				description: "Merge branch into working branch",
			},
			{
				value: "viewdiff",
				label: "[D] View full diff",
				description: "Open full diff in a scrollable view",
			},
			{
				value: "discard",
				label: "[N] Discard changes",
				description: "Delete branch without merging",
			},
		];

		const buildMenuView = () => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(
				new Text(
					theme.fg("accent", theme.bold(`[\u2691] subagent${label ? ` [${label}]` : ""} completed`)),
					1,
					0,
				),
			);
			container.addChild(
				new Text(
					theme.fg("dim", `${filesChanged} file(s) changed, branch: ${gitBranch}`),
					1,
					0,
				),
			);
			container.addChild(new Text("", 0, 0));

			if (gitDiff.trim()) {
				container.addChild(
					new Text(theme.fg("muted", "\u2500\u2500\u2500 Diff Preview \u2500\u2500\u2500"), 1, 0),
				);
				container.addChild(new Text(theme.fg("toolOutput", previewLines), 1, 0));
				if (hasMoreLines) {
					container.addChild(
						new Text(theme.fg("dim", `... ${diffLines.length - 20} more lines`), 1, 0),
					);
				}
				container.addChild(new Text("", 0, 0));
			} else {
				container.addChild(
					new Text(theme.fg("dim", "(no changes detected)"), 1, 0),
				);
			}

			selectList = new SelectList(items, 3, makeSelectListTheme(theme));
			selectList.onSelect = (item) => {
				if (item.value === "viewdiff") {
					currentView = "diff";
					tui.requestRender();
				} else if (item.value === "apply" || item.value === "discard") {
					done(item.value);
				}
			};
			selectList.onCancel = () => done(null);

			container.addChild(selectList);
			container.addChild(new Text(theme.fg("dim", NAV_FOOTER), 1, 0));
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			return container;
		};

		const buildDiffView = () => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(
				new Text(
					theme.fg("accent", theme.bold(`Full Diff — ${gitBranch}`)),
					1,
					0,
				),
			);
			container.addChild(new Text("", 0, 0));
			container.addChild(new Text(theme.fg("toolOutput", gitDiff), 1, 0));
			container.addChild(new Text("", 0, 0));
			container.addChild(
				new Text(theme.fg("dim", "Press any key to return to menu"), 1, 0),
			);
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			return container;
		};

		return {
			render: (w: number) => {
				if (currentView === "diff") {
					return buildDiffView().render(w);
				}
				return buildMenuView().render(w);
			},
			invalidate: () => {
				// No-op: rebuild on each render
			},
			handleInput: (data: string) => {
				if (currentView === "diff") {
					currentView = "menu";
					tui.requestRender();
					return;
				}

				// Keyboard shortcuts
				if (data === "y" || data === "Y") {
					done("apply");
					return;
				}
				if (data === "d" || data === "D") {
					currentView = "diff";
					tui.requestRender();
					return;
				}
				if (data === "n" || data === "N") {
					done("discard");
					return;
				}

				selectList?.handleInput(data);
				tui.requestRender();
			},
		};
	});
}

// ---------------------------------------------------------------------------
// P5: Diff rendering helpers
// ---------------------------------------------------------------------------

/**
 * Render a collapsed one-line summary of changed files from a git diff.
 * Returns empty string if no diff or no files changed.
 */
function renderCollapsedDiffSummary(
	gitDiff: string | undefined,
	theme: Theme,
): string {
	if (!gitDiff?.trim()) return "";
	const files = parseDiff(gitDiff);
	if (files.length === 0) return "";

	const fileEntries = files
		.slice(0, COLLAPSED_DIFF_FILES_PREVIEW)
		.map((f) =>
			theme.fg("accent", `${f.path}`) + theme.fg("accent", ` (+${f.additions} -${f.deletions})`),
		);

	let text = theme.fg("muted", "\u2500\u2500\u2500 Files: ") + fileEntries.join(theme.fg("muted", ", "));

	if (files.length > COLLAPSED_DIFF_FILES_PREVIEW) {
		text += theme.fg("muted", ` +${files.length - COLLAPSED_DIFF_FILES_PREVIEW} more`);
	}

	text += theme.fg("muted", " \u2500\u2500\u2500");
	return text;
}

/**
 * Add a structured diff section to an expanded view Container.
 * Returns true if any file has truncated hunks (needs a "Press D" hint).
 */
function addExpandedDiffSection(
	container: Container,
	gitDiff: string | undefined,
	theme: Theme,
): boolean {
	if (!gitDiff?.trim()) return false;
	const files = parseDiff(gitDiff);
	if (files.length === 0) return false;

	let anyTruncated = false;

	container.addChild(new Spacer(1));
	container.addChild(
		new Text(theme.fg("muted", `\u2500\u2500\u2500 Files changed (${files.length}) \u2500\u2500\u2500`), 0, 0),
	);

	for (const file of files) {
		container.addChild(new Text("", 0, 0));
		container.addChild(
			new Text(
				theme.fg("accent", file.path) +
					theme.fg("dim", `  (+${file.additions} -${file.deletions})`),
				0,
				0,
			),
		);
		container.addChild(new Text(theme.fg("muted", "\u2500".repeat(50)), 0, 0));

		const hunksToShow = file.hunks.slice(0, EXPANDED_HUNKS_PER_FILE);
		for (const hunk of hunksToShow) {
			container.addChild(new Text(theme.fg("toolOutput", hunk), 0, 0));
		}

		if (file.totalHunks > EXPANDED_HUNKS_PER_FILE) {
			anyTruncated = true;
			container.addChild(
				new Text(
					theme.fg(
						"dim",
						`(${file.totalHunks - EXPANDED_HUNKS_PER_FILE} more hunks \u2014 press D for full diff)`,
					),
					0,
					0,
				),
			);
		}
	}

	if (anyTruncated) {
		container.addChild(new Text("", 0, 0));
		container.addChild(
			new Text(theme.fg("dim", "Press D to view full raw diff"), 0, 0),
		);
	}

	return anyTruncated;
}

/**
 * Wrap an expanded view Container in a Component that intercepts 'D'/'d' keys
 * to toggle a full raw diff view. Pressing any key in the full diff view
 * returns to the normal expanded view.
 */
function withDiffKeybinding(
	container: Container,
	gitDiff: string | undefined,
	theme: Theme,
): Container | { render(w: number): string[]; handleInput(d: string): void; invalidate(): void } {
	if (!gitDiff?.trim()) return container;

	let showFullDiff = false;

	return {
		render(width: number) {
			if (showFullDiff) {
				const dc = new Container();
				dc.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				dc.addChild(new Text(theme.fg("accent", theme.bold("Full Diff")), 1, 0));
				dc.addChild(new Text("", 0, 0));
				dc.addChild(new Text(theme.fg("toolOutput", gitDiff), 1, 0));
				dc.addChild(new Text("", 0, 0));
				dc.addChild(new Text(theme.fg("dim", "Press any key to return"), 1, 0));
				dc.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				return dc.render(width);
			}
			return container.render(width);
		},
		handleInput(data: string) {
			if (showFullDiff) {
				showFullDiff = false;
				return;
			}
			if (data === "d" || data === "D") {
				showFullDiff = true;
				return;
			}
			// @ts-expect-error — Genuine SDK gap (issue #124): the SDK's Container class (pi-tui) has no
			// handleInput — only addChild/removeChild/clear/invalidate/render (verified in the installed
			// 0.84.2 type + runtime). The expanded-result container holds interactive children that could
			// consume keys; the SDK exposes no forwarding API, so this optional call is a runtime no-op.
			// Kept (not cast) so key-forwarding activates if the SDK ever grows Container.handleInput.
			container.handleInput?.(data);
		},
		invalidate() {
			container.invalidate();
		},
	};
}

// ---------------------------------------------------------------------------
// P10: Graph collapsed / expanded rendering
// ---------------------------------------------------------------------------

/**
 * Render a collapsed one-line summary of a graph execution.
 * Shows wave count, per-wave status icons, and task labels.
 */
function renderCollapsedGraph(
	details: GraphDetails,
	theme: Theme,
): string {
	const totalTasks = details.waves.reduce((s, w) => s + w.tasks.length, 0);
	const allSucceeded = details.waves.every((w) =>
		w.tasks.every((r) => !isSubagentError(r)),
	);
	const icon = allSucceeded
		? theme.fg("success", "\u2713")
		: theme.fg("error", "\u2717");
	let text = `${icon} ${theme.fg("toolTitle", theme.bold("graph"))} ${theme.fg("muted", `${totalTasks} tasks in ${details.waves.length} waves`)}`;

	const maxWavesToShow = 3;
	const wavesToRender = details.waves.slice(0, maxWavesToShow);

	for (const wave of wavesToRender) {
		const waveOk = wave.tasks.every((r) => !isSubagentError(r));
		const waveIcon = waveOk
			? theme.fg("success", "\u2713")
			: theme.fg("error", "\u2717");
		const modeLabel = wave.parallel ? "parallel" : "serial";
		const taskLabels = wave.tasks.map((r) => {
			const label = r.label || r.task.slice(0, 30);
			const taskIcon = !isSubagentError(r)
				? theme.fg("success", "\u2713")
				: theme.fg("error", "\u2717");
			return `${taskIcon} ${theme.fg("dim", label)}`;
		});
		text += `
  ${waveIcon} Wave ${wave.waveIndex} (${theme.fg("muted", modeLabel)}): ${taskLabels.join(", ")}`;
	}

	if (details.waves.length > maxWavesToShow) {
		text += `
  ${theme.fg("dim", `+${details.waves.length - maxWavesToShow} more waves`)}`;
	}

	text += `
${theme.fg("muted", "(Ctrl+O to expand)")}`;
	return text;
}

/**
 * Render an expanded view of a graph execution.
 * Full Container with per-wave per-task details and aggregated totals.
 */
function renderExpandedGraph(
	details: GraphDetails,
	theme: Theme,
	mdTheme: ReturnType<typeof getMarkdownTheme>,
): Container {
	const container = new Container();
	const totalTasks = details.waves.reduce((s, w) => s + w.tasks.length, 0);
	container.addChild(
		new Text(
			theme.fg("accent", theme.bold(`Graph: ${totalTasks} tasks in ${details.waves.length} waves`)),
			0,
			0,
		),
	);
	container.addChild(new Spacer(1));

	for (const wave of details.waves) {
		const waveOk = wave.tasks.every((r) => !isSubagentError(r));
		const waveIcon = waveOk
			? theme.fg("success", "\u2713")
			: theme.fg("error", "\u2717");
		const modeLabel = wave.parallel ? "parallel" : "serial";
		container.addChild(
			new Text(
				`${waveIcon} ${theme.fg("toolTitle", theme.bold(`Wave ${wave.waveIndex}`))} ${theme.fg("muted", `(${modeLabel}, ${wave.tasks.length} task${wave.tasks.length > 1 ? "s" : ""})`)}`,
				0,
				0,
			),
		);

		for (const r of wave.tasks) {
			const isErr = isSubagentError(r);
			const statusIcon = isErr
				? theme.fg("error", "\u2717")
				: theme.fg("success", "\u2713");
			const label = r.label ? `[${r.label}] ` : "";

			container.addChild(
				new Text(
					`${statusIcon} ${theme.fg("toolTitle", theme.bold(label))}` +
						(r.model ? theme.fg("muted", ` (${r.model})`) : ""),
					0,
					0,
				),
			);
			container.addChild(
				new Text(theme.fg("dim", `Task: ${r.task.slice(0, 200)}`), 0, 0),
			);

			if (isErr && r.errorMessage) {
				container.addChild(
					new Text(theme.fg("error", `Error: ${r.errorMessage}`), 0, 0),
				);
			}

			const output = getFinalOutput(r.messages);
			if (output) {
				container.addChild(
					new Text(theme.fg("muted", "\u2500\u2500\u2500 Output \u2500\u2500\u2500"), 0, 0),
				);
				container.addChild(new Markdown(output.trim(), 0, 0, mdTheme));
			}

			addExpandedDiffSection(container, r.gitDiff, theme);

			const usageStr = formatUsageStats(r.usage, r.model);
			if (usageStr) {
				container.addChild(new Text(theme.fg("dim", usageStr), 0, 0));
			}
			container.addChild(new Spacer(1));
		}
	}

	// Aggregated totals
	const aggUsage: UsageStats = {
		input: details.totalInput,
		output: details.totalOutput,
		cacheRead: 0,
		cacheWrite: 0,
		cost: details.totalCost,
		contextTokens: 0,
		turns: details.totalTurns,
	};
	const aggStr = formatUsageStats(aggUsage);
	if (aggStr) {
		container.addChild(
			new Text(theme.fg("dim", `Totals: ${aggStr}`), 0, 0),
		);
	}

	return container;
}

// ---------------------------------------------------------------------------
// Public rendering entry points (used by delegate_task tool)
// ---------------------------------------------------------------------------

export function renderDelegateCall(
	args: {
		task?: string;
		label?: string;
		systemPrompt?: string;
		inheritSystemPrompt?: boolean;
		thinkingLevel?: string;
		outputFile?: string;
		timeout?: number;
		cwd?: string;
		tools?: string[];
		excludeTools?: string[];
		noBuiltinTools?: boolean;
		chain?: SubTaskParams[];
		tasks?: SubTaskParams[];
		graph?: GraphTask[];
	},
	theme: Theme,
): Text {
	// Graph mode
	if (args.graph && args.graph.length > 0) {
		const n = args.graph.length;
		let text = `${theme.fg("accent", "delegate_task")} ${theme.fg("muted", `graph (${n} task${n > 1 ? "s" : ""})`)}`;
		const preview = args.graph.slice(0, 3);
		for (let i = 0; i < preview.length; i++) {
			const t = preview[i];
			const label = t.label || t.id;
			const deps = t.dependsOn?.length ? theme.fg("dim", ` [depends on: ${t.dependsOn.join(", ")}]`) : "";
			text += `
${theme.fg("muted", `${i + 1}.`)} ${theme.fg("dim", label)}${deps}`;
		}
		if (n > 3) {
			text += `
${theme.fg("dim", `+${n - 3} more`)}`;
		}
		return new Text(text, 0, 0);
	}

	// Chain mode
	if (args.chain && args.chain.length > 0) {
		const n = args.chain.length;
		let text = `${theme.fg("accent", "delegate_task")} ${theme.fg("muted", `chain (${n} step${n > 1 ? "s" : ""})`)}`;
		const preview = args.chain.slice(0, 3);
		for (let i = 0; i < preview.length; i++) {
			const s = preview[i];
			const label = s.label || s.task.slice(0, 60);
			text += `\n${theme.fg("muted", `${i + 1}.`)} ${theme.fg("dim", label)}`;
		}
		if (n > 3) {
			text += `\n${theme.fg("dim", `+${n - 3} more`)}`;
		}
		return new Text(text, 0, 0);
	}

	// Parallel mode
	if (args.tasks && args.tasks.length > 0) {
		const n = args.tasks.length;
		let text = `${theme.fg("accent", "delegate_task")} ${theme.fg("muted", `parallel (${n} task${n > 1 ? "s" : ""})`)}`;
		const preview = args.tasks.slice(0, 3);
		for (let i = 0; i < preview.length; i++) {
			const t = preview[i];
			const label = t.label || t.task.slice(0, 60);
			text += `\n${theme.fg("muted", `${i + 1}.`)} ${theme.fg("dim", label)}`;
		}
		if (n > 3) {
			text += `\n${theme.fg("dim", `+${n - 3} more`)}`;
		}
		return new Text(text, 0, 0);
	}

	// Single mode (original)
	const dl = buildDelegateLabel(args, theme);
	const scopeLabel = buildScopeLabel(args, theme);
	const nameLabel = args.label ? theme.fg("accent", `[${args.label}] `) : "";
	const preview = args.task
		? args.task.length > TASK_PREVIEW_MAX_LENGTH
			? `${args.task.slice(0, TASK_PREVIEW_MAX_LENGTH)}\u2026`
			: args.task
		: "\u2026";
	return new Text(dl + scopeLabel + nameLabel + theme.fg("dim", preview), 0, 0);
}

export function renderDelegateResult(
	result: AgentToolResult<DelegateTaskDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
): Container | Text | ReturnType<typeof withDiffKeybinding> {
	const details = result.details;

	// Check for graph mode
	if (details && isGraphDetails(details)) {
		const gd = details as GraphDetails;
		if (options.expanded) {
			return renderExpandedGraph(gd, theme, getMarkdownTheme());
		}
		return new Text(renderCollapsedGraph(gd, theme), 0, 0);
	}

	// Check for multi-subagent (chain / parallel) mode
	if (details && isMultiSubagentDetails(details)) {
		if (details.mode === "chain") {
			const cd = details as ChainDetails;
			if (options.expanded) {
				return renderExpandedChain(cd, theme, getMarkdownTheme());
			}
			return new Text(renderCollapsedChain(cd, theme), 0, 0);
		} else {
			const pd = details as ParallelDetails;
			if (options.expanded) {
				return renderExpandedParallel(pd, theme, getMarkdownTheme());
			}
			return new Text(renderCollapsedParallel(pd, theme), 0, 0);
		}
	}

	// Single subagent mode (original)
	// Issue #298 (C2): the partial-vs-settled decision lives in ONE place —
	// `isUnsettledPartial` (src/types.ts) owns the overloaded `exitCode === -1`
	// disambiguation (the #206 streaming sentinel vs the #295 settled signal
	// death). Do not re-derive it here; the terminal-status structural ratchet
	// fails a local copy. A genuine partial (or a result with no details yet)
	// renders the raw running text; a classified -1 is a settled FAILURE and
	// takes the verdict branch below (✗ + error line + expanded-transcript
	// binding), never raw text.
	//
	// The leading `!details` is a type-narrowing aid for the settled branch below
	// (TS cannot narrow through a function call); it is NOT a second copy of the
	// decision — the predicate owns the no-details case too.
	if (!details || isUnsettledPartial(details)) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "(running\u2026)", 0, 0);
	}

	const isError = isSubagentError(details);
	const icon = isError ? theme.fg("error", "\u2717") : theme.fg("success", "\u2713");
	const finalOutput = getFinalOutput(details.messages);

	if (options.expanded) {
		const container = renderExpandedResult(
			details,
			isError,
			icon,
			finalOutput,
			theme,
			getMarkdownTheme(),
		);
		// P5: Wrap with keybinding for full diff view
		return withDiffKeybinding(container, details.gitDiff, theme);
	}
	return new Text(
		renderCollapsedText(details, isError, icon, finalOutput, theme),
		0,
		0,
	);
}

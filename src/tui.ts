/**
 * brl-subagent — TUI Components
 *
 * All TUI rendering: select lists, configuration menus, model/thinking selectors,
 * preset management, run history viewer, live monitor, retry menu, and
 * delegate_task result rendering.
 */

import type { ExtensionContext, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Spacer, Text, Markdown } from "@earendil-works/pi-tui";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type {
	SubagentPreset,
	TaskTemplate,
	SubagentResult,
	SubagentRun,
	SubTaskParams,
	MultiSubagentDetails,
	ChainDetails,
	ParallelDetails,
	GraphDetails,
	GraphTask,
	SubTaskResult,
	ThinkingLevel,
	Priority,
	UsageStats,
	FileDiff,
	ScheduleEntry,
} from "./types";
import {
	THINKING_LEVELS,
	NAV_FOOTER,
	TASK_PREVIEW_MAX_LENGTH,
	COLLAPSED_OUTPUT_LINES,
	COLLAPSED_DIFF_FILES_PREVIEW,
	EXPANDED_HUNKS_PER_FILE,
	MAX_POOL_SIZE,
	RESERVED_NAME_PATTERN,
	RESERVED_COMMAND_NAMES,
	formatTokens,
	formatUsageStats,
	formatModel,
	formatMaxParallel,
	getFinalOutput,
	isSubagentError,
	isMultiSubagentDetails,
	isGraphDetails,
} from "./types";
import { buildFileAccessReport, buildSecretsExposureReport, generateComplianceSummary } from "./reports";
import { extractParamNames } from "./templates";
import { parseDiff } from "./diff";
import { formatPresetSummary } from "./presets";
import { formatRunDuration } from "./history";
import type { SessionState } from "./state";
import { computeSLAMetrics, computeCostTrend, formatSparkline } from "./metrics";

// ---------------------------------------------------------------------------
// SelectList helper
// ---------------------------------------------------------------------------

function makeSelectListTheme(theme: { fg: (c: string, t: string) => string }) {
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

	const items: SelectItem[] = availableModels.map((m: Model<Api>) => ({
		value: `${m.provider}/${m.id}`,
		label: `${m.provider}/${m.id}`,
		description: m.name ?? `context: ${(m.contextWindow ?? 0) / 1000}K`,
	}));

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
	const items: SelectItem[] = THINKING_LEVELS.map((level) => ({
		value: level,
		label: level === state.config.maxThinkingLevel ? `${level} (current - ceiling)` : level,
	}));

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
	const result = await ctx.ui.input({
		prompt: "Max parallel subagents (0 = unlimited):",
		default: formatMaxParallel(state.config.maxParallel),
	});
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
	const result = await ctx.ui.input({
		prompt: "Max subagent recursion depth (0 = subagents cannot delegate, 1 = one level, etc.):",
		default: String(state.config.maxSubagentDepth),
	});
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
	const current =
		state.config.maxHistoryEntries === 0
			? "unlimited"
			: String(state.config.maxHistoryEntries);
	const result = await ctx.ui.input({
		prompt: "Max run history entries (0 = unlimited, default 500):",
		default: current,
	});
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
	const current =
		state.config.sessionCostLimit === 0
			? "0 (unlimited)"
			: String(state.config.sessionCostLimit);
	const result = await ctx.ui.input({
		prompt: "Session cost limit in USD (0 = unlimited, e.g. 1.00 for $1):",
		default: current,
	});
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
	const items: SelectItem[] = [
		{
			value: "auto",
			label: "auto",
			description: "Never ask - auto-approve",
		},
		{
			value: "writes",
			label: "writes",
			description: "Ask when files changed - default",
		},
		{
			value: "always",
			label: "always",
			description: "Ask every time",
		},
	];

	const result = await showSelectList(ctx, "Select Change Approval Mode", items, 5);
	if (!result) return;

	state.config.approvalMode = result as "auto" | "writes" | "always";
	onConfigChanged(ctx, `Change approval mode set to ${result}`);
}

// ---------------------------------------------------------------------------
// Default priority selector — P6
// ---------------------------------------------------------------------------

export async function showDefaultPrioritySelector(
	ctx: ExtensionContext,
	state: SessionState,
	onConfigChanged: (ctx: ExtensionContext, msg: string) => void,
): Promise<void> {
	const items: SelectItem[] = [
		{ value: "critical", label: "critical", description: "Highest priority — queued ahead of all others" },
		{ value: "high", label: "high", description: "High priority — above normal and low" },
		{ value: "normal", label: "normal (default)", description: "Normal priority — below critical and high" },
		{ value: "low", label: "low", description: "Lowest priority — queued behind all others" },
	];

	const result = await showSelectList(ctx, "Select Default Priority", items, 5);
	if (!result) return;

	state.config.defaultPriority = result as Priority;
	onConfigChanged(ctx, `Default priority set to ${result}`);
}

// ---------------------------------------------------------------------------
// Git mode selector — P3
// ---------------------------------------------------------------------------

export async function showGitModeSelector(
	ctx: ExtensionContext,
	state: SessionState,
	onConfigChanged: (ctx: ExtensionContext, msg: string) => void,
): Promise<void> {
	const items: SelectItem[] = [
		{
			value: "none",
			label: "none",
			description: "No git integration",
		},
		{
			value: "branch",
			label: "branch",
			description: "Branch-based workflow (creates a work branch per subagent call)",
		},
	];

	const result = await showSelectList(ctx, "Select Git Integration Mode", items, 5);
	if (!result) return;

	state.config.gitMode = result as "branch" | "none";
	onConfigChanged(ctx, `Git integration mode set to ${result}`);
}

// ---------------------------------------------------------------------------

// Pool configuration UI (E11)
// ---------------------------------------------------------------------------

export async function showPoolConfig(
	ctx: ExtensionContext,
	state: SessionState,
	onConfigChanged: (ctx: ExtensionContext, msg: string) => void,
): Promise<void> {
	// Step 1: Enable/disable
	const enableItems: SelectItem[] = [
		{ value: "disabled", label: "Disabled", description: "No process pool (cold start for each subagent)" },
		{ value: "enabled", label: "Enabled", description: "Keep warm pi processes for faster subagent starts" },
	];
	const enableResult = await showSelectList(ctx, "Process Pool", enableItems, 5);
	if (!enableResult) return;

	const enabled = enableResult === "enabled";
	state.config.poolEnabled = enabled;

	if (!enabled) {
		onConfigChanged(ctx, "Process pool disabled");
		return;
	}

	// Step 2: Pool size
	const sizeResult = await ctx.ui.input({
		prompt: `Pool size (1-${MAX_POOL_SIZE}, default 2):`,
		default: String(state.config.poolSize),
	});
	if (sizeResult == null) return;
	const size = parseInt(sizeResult, 10);
	if (isNaN(size) || size < 1 || size > MAX_POOL_SIZE) {
		ctx.ui.notify(`Invalid pool size. Must be 1-${MAX_POOL_SIZE}.`, "error");
		return;
	}
	state.config.poolSize = size;
	onConfigChanged(ctx, `Process pool enabled with ${size} warm process${size > 1 ? "es" : ""}`);
}

// ---------------------------------------------------------------------------
// Update check toggle
// ---------------------------------------------------------------------------

export async function showUpdateCheckToggle(
	ctx: ExtensionContext,
	state: SessionState,
	onConfigChanged: (ctx: ExtensionContext, msg: string) => void,
): Promise<void> {
	const items: SelectItem[] = [
		{ value: "enabled", label: "Enabled", description: "Check for updates on session start" },
		{ value: "disabled", label: "Disabled", description: "Skip update check" },
	];

	const result = await showSelectList(ctx, "Update Check", items, 5);
	if (!result) return;

	state.config.updateCheckEnabled = result === "enabled";
	onConfigChanged(ctx, `Update check ${result}`);
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// E4: SLA tracking configuration
// ---------------------------------------------------------------------------

export async function showSLAConfig(
	ctx: ExtensionContext,
	state: SessionState,
	onConfigChanged: (ctx: ExtensionContext, msg: string) => void,
): Promise<void> {
	// Step 1: Enable/disable toggle
	const enableItems: SelectItem[] = [
		{ value: "disabled", label: "Disabled", description: "No SLA tracking" },
		{ value: "enabled", label: "Enabled", description: "Track performance metrics and detect degradation" },
	];
	const enableResult = await showSelectList(ctx, "SLA Tracking", enableItems, 5);
	if (!enableResult) return;

	const enabled = enableResult === "enabled";
	state.config.slaTrackingEnabled = enabled;

	if (!enabled) {
		onConfigChanged(ctx, "SLA tracking disabled");
		return;
	}

	// Step 2: Window size input
	const sizeResult = await ctx.ui.input({
		prompt: `Window size (10-500, default ${state.config.slaWindowSize}):`,
		default: String(state.config.slaWindowSize),
	});
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
export function getPreset(
	name: string,
	builtinPresets: SubagentPreset[],
	customPresets: SubagentPreset[],
): SubagentPreset | undefined {
	return (
		builtinPresets.find((p) => p.name === name) ||
		customPresets.find((p) => p.name === name)
	);
}

export async function showAddPreset(
	ctx: ExtensionContext,
	state: SessionState,
	persistState: () => void,
): Promise<void> {
	const name = await ctx.ui.input({ prompt: "Preset name (e.g., read-only-audit):" });
	if (!name?.trim()) return;
	const trimmedName = name.trim();

	if (RESERVED_NAME_PATTERN.test(trimmedName)) {
		ctx.ui.notify("Names starting and ending with '__' are reserved. Choose a different name.", "error");
		return;
	}

	if (RESERVED_COMMAND_NAMES.has(trimmedName)) {
		ctx.ui.notify("Name '" + trimmedName + "' is reserved for a command. Choose a different name.", "error");
		return;
	}

	if (getPreset(trimmedName, state.builtinPresets, state.config.presets)) {
		ctx.ui.notify(`Preset "${trimmedName}" already exists. Use a different name.`, "error");
		return;
	}

	await ctx.ui.input({ prompt: "Description (optional):" });

	const thinkingItems: SelectItem[] = [
		{ value: "", label: "(not set — use conductor's choice)" },
		...THINKING_LEVELS.map((level) => ({ value: level, label: level })),
	];
	const thinkingResult = await showSelectList(ctx, "Default Thinking Level", thinkingItems, 8);

	const scopeItems: SelectItem[] = [
		{ value: "all", label: "All tools (default)" },
		{ value: "readonly", label: "Read-only (read, grep, find, ls)" },
		{ value: "custom", label: "Custom tool list..." },
	];
	const scopeResult = await showSelectList(ctx, "Tool Scope", scopeItems, 5);

	let tools: string[] | undefined;
	let excludeTools: string[] | undefined;
	let noBuiltinTools: boolean | undefined;

	if (scopeResult === "readonly") {
		tools = ["read", "grep", "find", "ls"];
		excludeTools = ["write", "edit", "bash"];
	} else if (scopeResult === "custom") {
		const toolsStr = await ctx.ui.input({ prompt: "Tools (comma-separated):" });
		if (toolsStr?.trim()) tools = toolsStr.split(",").map((t) => t.trim()).filter(Boolean);
	}

	const inheritItems: SelectItem[] = [
		{ value: "true", label: "Inherit system prompt (default)" },
		{ value: "false", label: "No inheritance (standalone)" },
	];
	const inheritResult = await showSelectList(ctx, "System Prompt Inheritance", inheritItems, 3);

	const preset: SubagentPreset = {
		name: trimmedName,
		description: undefined, // user skipped or entered empty
		thinkingLevel: thinkingResult || undefined,
		inheritSystemPrompt: inheritResult === "false" ? false : undefined,
		tools,
		excludeTools,
		noBuiltinTools,
	};

	state.config.presets.push(preset);
	persistState();
	ctx.ui.notify(`Preset "${trimmedName}" created`, "info");
}

export async function showRemovePreset(
	ctx: ExtensionContext,
	state: SessionState,
	persistState: () => void,
): Promise<void> {
	if (state.config.presets.length === 0) {
		ctx.ui.notify("No custom presets to remove. Built-in presets cannot be removed.", "info");
		return;
	}

	const items: SelectItem[] = state.config.presets.map((p) => ({
		value: p.name,
		label: p.name,
		description: p.description || formatPresetSummary(p),
	}));

	const result = await showSelectList(ctx, "Remove Preset", items, 10);
	if (!result) return;

	state.config.presets = state.config.presets.filter((p) => p.name !== result);
	persistState();
	ctx.ui.notify(`Preset "${result}" removed`, "info");
}

export async function showPresetManager(
	ctx: ExtensionContext,
	state: SessionState,
	persistState: () => void,
): Promise<void> {
	const builtinItems: SelectItem[] = state.builtinPresets.map((p) => ({
		value: p.name,
		label: p.name,
		description: p.description || formatPresetSummary(p),
	}));

	const userItems: SelectItem[] = state.config.presets.map((p) => ({
		value: p.name,
		label: p.name,
		description: p.description || formatPresetSummary(p),
	}));

	const items: SelectItem[] = [
		...builtinItems,
		...(userItems.length > 0
			? [
					{
						value: "__divider__",
						label: "\u2500\u2500\u2500 Custom Presets \u2500\u2500\u2500",
						description: "",
					},
				]
			: []),
		...userItems,
		{ value: "__add__", label: "+ Add Preset", description: "Create a new delegation preset" },
		{ value: "__remove__", label: "- Remove Preset", description: "Delete a custom preset" },
	];

	const result = await showSelectList(
		ctx,
		`Presets (${state.builtinPresets.length} built-in, ${state.config.presets.length} custom)`,
		items,
		15,
	);
	if (!result || result === "__divider__") return;

	if (result === "__add__") {
		await showAddPreset(ctx, state, persistState);
	} else if (result === "__remove__") {
		await showRemovePreset(ctx, state, persistState);
	} else {
		const preset = getPreset(result, state.builtinPresets, state.config.presets);
		if (preset) {
			const isBuiltin = state.builtinPresets.some((p) => p.name === result);
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
// Template management UI
// ---------------------------------------------------------------------------

export function getTemplate(
	name: string,
	templates: TaskTemplate[],
): TaskTemplate | undefined {
	return templates.find((t) => t.name === name);
}

export async function showAddTemplate(
	ctx: ExtensionContext,
	state: SessionState,
	persistState: () => void,
): Promise<void> {
	const name = await ctx.ui.input({ prompt: "Template name (e.g., owasp-audit):" });
	if (!name?.trim()) return;
	const trimmedName = name.trim();

	if (RESERVED_NAME_PATTERN.test(trimmedName)) {
		ctx.ui.notify("Names starting and ending with '__' are reserved. Choose a different name.", "error");
		return;
	}

	if (RESERVED_COMMAND_NAMES.has(trimmedName)) {
		ctx.ui.notify("Name '" + trimmedName + "' is reserved for a command. Choose a different name.", "error");
		return;
	}

	if (getTemplate(trimmedName, state.config.templates)) {
		ctx.ui.notify(`Template "${trimmedName}" already exists. Use a different name.`, "error");
		return;
	}

	const description = await ctx.ui.input({ prompt: "Description (optional):" });

	const task = await ctx.ui.input({
		prompt: "Task description (use ${param} for slots, e.g. 'Audit ${file} for security issues'):",
	});
	if (!task?.trim()) {
		ctx.ui.notify("Task description is required.", "error");
		return;
	}

	// Show parsed params as hint
	const parsedParams = extractParamNames(task);
	if (parsedParams.length > 0) {
		ctx.ui.notify(`Detected params: ${parsedParams.join(", ")}`, "info");
	}

	const preset = await ctx.ui.input({ prompt: "Preset name (optional, e.g. security-auditor):" });

	const thinkingItems: SelectItem[] = [
		{ value: "", label: "(not set)" },
		...THINKING_LEVELS.map((level) => ({ value: level, label: level })),
	];
	const thinkingResult = await showSelectList(ctx, "Default Thinking Level", thinkingItems, 8);

	const outputFile = await ctx.ui.input({
		prompt: "Output file (optional, e.g. audit-${file}.md):",
	});

	const template: TaskTemplate = {
		name: trimmedName,
		description: description?.trim() || undefined,
		task: task.trim(),
		preset: preset?.trim() || undefined,
		thinkingLevel: thinkingResult || undefined,
		outputFile: outputFile?.trim() || undefined,
	};

	state.config.templates.push(template);
	persistState();
	ctx.ui.notify(`Template "${trimmedName}" created`, "info");
}

export async function showRemoveTemplate(
	ctx: ExtensionContext,
	state: SessionState,
	persistState: () => void,
): Promise<void> {
	if (state.config.templates.length === 0) {
		ctx.ui.notify("No templates to remove.", "info");
		return;
	}

	const items: SelectItem[] = state.config.templates.map((t) => ({
		value: t.name,
		label: t.name,
		description: t.description || t.task.slice(0, 60),
	}));

	const result = await showSelectList(ctx, "Remove Template", items, 10);
	if (!result) return;

	state.config.templates = state.config.templates.filter((t) => t.name !== result);
	persistState();
	ctx.ui.notify(`Template "${result}" removed`, "info");
}

export async function showViewTemplate(
	ctx: ExtensionContext,
	state: SessionState,
	name: string,
): Promise<void> {
	const template = getTemplate(name, state.config.templates);
	if (!template) return;

	const paramNames = extractParamNames(template.task + (template.outputFile || ""));

	await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(
			new Text(theme.fg("accent", theme.bold(`Template: ${template.name}`)), 1, 0),
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
	persistState: () => void,
): Promise<void> {
	const templateItems: SelectItem[] = state.config.templates.map((t) => ({
		value: t.name,
		label: t.name,
		description: t.description || t.task.slice(0, 60),
	}));

	const items: SelectItem[] = [
		...templateItems,
		{ value: "__add__", label: "+ Add Template", description: "Create a new task template" },
		{ value: "__remove__", label: "- Remove Template", description: "Delete a template" },
	];

	const result = await showSelectList(
		ctx,
		`Templates (${state.config.templates.length} saved)`,
		items,
		15,
	);
	if (!result) return;

	if (result === "__add__") {
		await showAddTemplate(ctx, state, persistState);
	} else if (result === "__remove__") {
		await showRemoveTemplate(ctx, state, persistState);
	} else {
		await showViewTemplate(ctx, state, result);
	}
}

// ---------------------------------------------------------------------------
// E9: Schedule management UI
// ---------------------------------------------------------------------------

export async function showScheduleManager(
	ctx: ExtensionContext,
	state: SessionState,
	schedules: ScheduleEntry[],
	persistState: () => void,
	callbacks: {
		addSchedule: () => Promise<void>;
		removeSchedule: () => Promise<void>;
		listSchedules: () => Promise<void>;
	},
): Promise<void> {
	const items: SelectItem[] = [
		{
			value: "__add__",
			label: "+ Add Schedule",
			description: "Create a new recurring task schedule",
		},
		{
			value: "__remove__",
			label: "- Remove Schedule",
			description: "Delete an existing schedule",
		},
		{
			value: "__list__",
			label: "View Schedules",
			description: "Show all schedules with next run times",
		},
	];

	const result = await showSelectList(
		ctx,
		`Schedules (${schedules.length} active)`,
		items,
		5,
	);
	if (!result) return;

	if (result === "__add__") {
		await callbacks.addSchedule();
	} else if (result === "__remove__") {
		await callbacks.removeSchedule();
	} else if (result === "__list__") {
		await callbacks.listSchedules();
	}
}

export async function showAddSchedule(
	ctx: ExtensionContext,
	state: SessionState,
	schedules: ScheduleEntry[],
	persistState: () => void,
	callbacks: {
		addScheduleEntry: (config: import("./types").ScheduleConfig) => string;
	},
): Promise<void> {
	const name = await ctx.ui.input({ prompt: "Schedule name (e.g., hourly-lint):" });
	if (!name?.trim()) return;
	const trimmedName = name.trim();

	if (RESERVED_NAME_PATTERN.test(trimmedName)) {
		ctx.ui.notify("Names starting and ending with '__' are reserved. Choose a different name.", "error");
		return;
	}

	if (RESERVED_COMMAND_NAMES.has(trimmedName)) {
		ctx.ui.notify("Name '" + trimmedName + "' is reserved for a command. Choose a different name.", "error");
		return;
	}

	// Check for duplicate name
	if (schedules.some((s) => s.name === trimmedName)) {
		ctx.ui.notify(`Schedule "${trimmedName}" already exists.`, "error");
		return;
	}

	const task = await ctx.ui.input({ prompt: "Task description for the subagent:" });
	if (!task?.trim()) {
		ctx.ui.notify("Task description is required.", "error");
		return;
	}

	const intervalStr = await ctx.ui.input({
		prompt: "Interval in minutes (minimum 5):",
		default: "60",
	});
	if (intervalStr == null) return;
	const intervalMinutes = parseInt(intervalStr, 10);
	if (isNaN(intervalMinutes) || intervalMinutes < 5) {
		ctx.ui.notify("Interval must be at least 5 minutes.", "error");
		return;
	}

	// Optional preset
	const presetItems: SelectItem[] = [
		{ value: "", label: "(none)" },
		...state.builtinPresets.map((p) => ({
			value: p.name,
			label: p.name,
			description: p.description || undefined,
		})),
		...state.config.presets.map((p) => ({
			value: p.name,
			label: p.name,
			description: p.description || undefined,
		})),
	];
	const presetResult = await showSelectList(ctx, "Preset (optional)", presetItems, 10);

	// Optional thinking level
	const thinkingItems: SelectItem[] = [
		{ value: "", label: "(not set)" },
		...THINKING_LEVELS.map((level) => ({ value: level, label: level })),
	];
	const thinkingResult = await showSelectList(ctx, "Thinking Level (optional)", thinkingItems, 8);

	const config: import("./types").ScheduleConfig = {
		name: trimmedName,
		task: task.trim(),
		preset: presetResult || undefined,
		thinkingLevel: thinkingResult || undefined,
		intervalMinutes,
		enabled: true,
	};

	callbacks.addScheduleEntry(config);
	persistState();
	ctx.ui.notify(`Schedule "${trimmedName}" created (every ${intervalMinutes}m)`, "info");
}

export async function showRemoveSchedule(
	ctx: ExtensionContext,
	schedules: ScheduleEntry[],
	persistState: () => void,
	callbacks: {
		removeScheduleEntry: (id: string) => boolean;
	},
): Promise<void> {
	if (schedules.length === 0) {
		ctx.ui.notify("No schedules to remove.", "info");
		return;
	}

	const items: SelectItem[] = schedules.map((s) => ({
		value: s.id,
		label: s.name,
		description: `every ${s.intervalMinutes}m · ${s.enabled ? "enabled" : "disabled"} · ${s.task.slice(0, 50)}`,
	}));

	const result = await showSelectList(ctx, "Remove Schedule", items, 10);
	if (!result) return;

	const removed = callbacks.removeScheduleEntry(result);
	if (removed) {
		persistState();
		ctx.ui.notify("Schedule removed", "info");
	}
}

export async function showScheduleList(
	ctx: ExtensionContext,
	schedules: ScheduleEntry[],
): Promise<void> {
	if (schedules.length === 0) {
		ctx.ui.notify("No schedules configured.", "info");
		return;
	}

	await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(
			new Text(
				theme.fg("accent", theme.bold(`Schedules (${schedules.length})`)),
				1,
				0,
			),
		);
		container.addChild(new Text("", 0, 0));

		for (const s of schedules) {
			const statusIcon = s.enabled
				? theme.fg("success", "●")
				: theme.fg("dim", "○");
			container.addChild(
				new Text(
					`${statusIcon} ${theme.fg("accent", s.name)}${theme.fg("dim", ` (${s.intervalMinutes}m)`)}`,
					1,
					0,
				),
			);
			container.addChild(
				new Text(
					theme.fg("dim", `  Task: ${s.task.slice(0, 80)}`),
					1,
					0,
				),
			);
			if (s.preset) {
				container.addChild(
					new Text(theme.fg("dim", `  Preset: ${s.preset}`), 1, 0),
				);
			}
			if (s.thinkingLevel) {
				container.addChild(
					new Text(theme.fg("dim", `  Thinking: ${s.thinkingLevel}`), 1, 0),
				);
			}
			const nextRunDate = new Date(s.nextRun);
			const nextRunStr = nextRunDate.toLocaleTimeString();
			container.addChild(
				new Text(
					theme.fg("dim", `  Next run: ${nextRunStr}`),
					1,
					0,
				),
			);
			if (s.lastRun) {
				const lastRunStr = new Date(s.lastRun).toLocaleTimeString();
				container.addChild(
					new Text(
						theme.fg("dim", `  Last run: ${lastRunStr}`),
						1,
						0,
					),
				);
			}
			container.addChild(new Text("", 0, 0));
		}

		container.addChild(new Text(theme.fg("dim", "Press any key to close"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (_data: string) => done(),
		};
	});
}

// ---------------------------------------------------------------------------
// Configuration menu
// ---------------------------------------------------------------------------

export function getConfigMenuItems(state: SessionState): SelectItem[] {
	return [
		{
			value: "model",
			label: "Select Model",
			description: state.config.model
				? `${state.config.model.provider}/${state.config.model.id}`
				: "Not set (will use main agent\u2019s model by default)",
		},
		{
			value: "thinking",
			label: "Select Max Thinking Level",
			description: state.config.maxThinkingLevel,
		},
		{
			value: "concurrency",
			label: "Set Max Parallel Subagents",
			description: formatMaxParallel(state.config.maxParallel),
		},
		{
			value: "depth",
			label: "Set Max Recursion Depth",
			description: state.config.maxSubagentDepth === 0
				? "No delegation from subagents"
				: `Subagents can delegate up to ${state.config.maxSubagentDepth} level${state.config.maxSubagentDepth > 1 ? "s" : ""} deep`,
		},
		{
			value: "priority",
			label: "Set Default Priority",
			description: state.config.defaultPriority,
		},
		{
			value: "gitmode",
			label: "Set Git Integration Mode",
			description: state.config.gitMode === "branch"
				? "Branch-based workflow"
				: "No git integration",
		},
		{
			value: "approval",
			label: "Set Change Approval Mode",
			description: state.config.approvalMode === "auto"
				? "Never ask"
				: state.config.approvalMode === "writes"
					? "Ask when files changed"
					: "Ask every time",
		},

		{
			value: "historyentries",
			label: "Set Max History Entries",
			description: state.config.maxHistoryEntries === 0
				? "Unlimited (no pruning)"
				: `${state.config.maxHistoryEntries} entries kept`,
		},
		{
			value: "costlimit",
			label: "Set Session Cost Limit",
			description: state.config.sessionCostLimit === 0
				? "Unlimited"
				: `$${state.config.sessionCostLimit.toFixed(2)}`,
		},
		{
			value: "reset",
			label: "Reset to Default",
			description: "Clear subagent configuration",
		},
		{
			value: "history",
			label: "View Run History",
			description: "Browse past subagent runs",
		},
		{
			value: "monitor",
			label: "Live Monitor",
			description: "Watch running subagents in real-time",
		},
		{
			value: "dashboard",
			label: "Observability Dashboard",
			description: "Real-time metrics, SLA, errors, and cost trends",
		},
		{
			value: "preset",
			label: "Manage Presets",
			description: `${state.builtinPresets.length} built-in, ${state.config.presets.length} custom`,
		},
		{
			value: "templates",
			label: "Manage Templates",
			description: state.config.templates.length === 0
				? "None saved"
				: `${state.config.templates.length} saved`,
		},
		{
			value: "retry",
			label: "Retry Failed Run",
			description: "Select a failed subagent to retry",
		},
		{
			value: "schedule",
			label: "Manage Schedules",
			description: "Configure recurring task schedules",
		},
		{
			value: "sla",
			label: "SLA Tracking",
			description: state.config.slaTrackingEnabled
				? `Enabled (window: ${state.config.slaWindowSize})`
				: "Disabled",
		},
		{
			value: "pool",
			label: "Process Pool",
			description: state.config.poolEnabled
				? `Enabled (${state.config.poolSize} process${state.config.poolSize > 1 ? "es" : ""})`
				: "Disabled",
		},
		{
			value: "update-check",
			label: "Update Check",
			description: state.config.updateCheckEnabled ? "Enabled" : "Disabled",
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

			container.addChild(
				new Text(theme.fg("dim", `Model: ${formatModel(state.config.model)}`), 1, 0),
			);
			container.addChild(
				new Text(
					theme.fg("dim", `Max Thinking: ${state.config.maxThinkingLevel}`),
					1,
					0,
				),
			);
			container.addChild(
				new Text(
					theme.fg("dim", `Max parallel: ${formatMaxParallel(state.config.maxParallel)}`),
					1,
					0,
				),
			);
			if (state.config.sessionCostLimit > 0) {
				container.addChild(
					new Text(
						theme.fg("dim", `Cost limit: $${state.config.sessionCostLimit.toFixed(2)}`),
						1,
						0,
					),
				);
			}
			container.addChild(new Text("", 0, 0));

			const selectList = new SelectList(
				items,
				Math.min(items.length, 10),
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

export async function showRunHistory(
	ctx: ExtensionContext,
	state: SessionState,
	persistState: () => void,
): Promise<void> {
	const runs = state.getRunEntries(ctx).reverse();

	if (runs.length === 0) {
		ctx.ui.notify("No subagent runs recorded yet. Delegate a task to see history.", "info");
		return;
	}

	const statusIcon: Record<string, string> = {
		running: ctx.ui.theme.fg("accent", "◉"),
		done: ctx.ui.theme.fg("success", "✓"),
		failed: ctx.ui.theme.fg("error", "✗"),
	};

	const items: SelectItem[] = runs.map((r) => {
		const icon = statusIcon[r.status] || "·";
		const name = r.label || r.task.slice(0, 60);
		const model = r.model.split("/").pop() || r.model;
		const when = r.finishedAt ? formatRunDuration(r.durationMs || 0) : "running...";
		const cost = r.cost ? ` $${r.cost.toFixed(4)}` : "";
		const desc = `${r.thinkingLevel} · ${model} · ${when}${cost}`;
		return { value: r.id, label: `${icon} ${name}`, description: desc };
	});

	const selectedId = await showSelectList(ctx, "Subagent History", items, 15);
	if (!selectedId) return;

	const run = runs.find((r) => r.id === selectedId);
	if (!run) return;

	// Mark as seen
	if (state.markRunSeen(run.id)) {
		persistState();
		import("./concurrency").then(({ updateProgressStatus }) => {
			updateProgressStatus(state, ctx);
		});
	}

	// Show detail view
	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		const statusLabel =
			run.status === "done" ? "Completed" : run.status === "failed" ? "Failed" : "Running";
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
		if (run.outputSummary) {
			container.addChild(new Spacer(1));
			container.addChild(
				new Text(
					theme.fg("muted", "\u2500\u2500\u2500 Output Preview \u2500\u2500\u2500"),
					1,
					0,
				),
			);
			container.addChild(
				new Text(theme.fg("toolOutput", run.outputSummary), 1, 0),
			);
			if ((run.outputSummary || "").length >= 200) {
				container.addChild(new Text(theme.fg("dim", "(first 200 characters)"), 1, 0));
			}
		}

		container.addChild(new Spacer(1));
		container.addChild(new Text(theme.fg("dim", "Press any key to close"), 1, 0));
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

		return {
			render: (w: number) => container.render(w),
			invalidate: () => container.invalidate(),
			handleInput: (_data: string) => done(),
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
	if (state.subagentSessions.size === 0) {
		ctx.ui.notify(
			"No subagents are currently running. Delegate a task to see live activity.",
			"info",
		);
		return;
	}

	await ctx.ui.custom<void>((tui, theme, _kb, done) => {
		const buildView = () => {
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
				new Text(theme.fg("dim", "esc close"), 1, 0),
			);
			container.addChild(new Text("", 0, 0));

			let idx = 0;
			for (const [id, session] of state.subagentSessions) {
				const elapsed = Math.round((Date.now() - session.startedAt) / 1000);
				const elapsedStr =
					elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
				const name = session.label || session.task.slice(0, 40);
				const spinner =
					["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"][
						Math.floor(Date.now() / 150) % 10
					];

				container.addChild(
					new Text(
						theme.fg("accent", `${spinner} ${name}`) +
							theme.fg(
								"dim",
								`  \u2191${formatTokens(session.usage.input)} \u2193${formatTokens(session.usage.output)}  ${elapsedStr}`,
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
				if (idx < state.subagentSessions.size) container.addChild(new Text("", 0, 0));
			}

			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			return container;
		};

		const interval = setInterval(() => tui.requestRender(), 200);
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
					const elapsed = Math.round((Date.now() - session.startedAt) / 1000);
					const elapsedStr =
						elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m${elapsed % 60}s`;
					const name = session.label || session.task.slice(0, 40);
					const spinner =
						["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"][
							Math.floor(Date.now() / 150) % 10
					];
					container.addChild(
						new Text(
							theme.fg("accent", `  ${spinner} ${name}`) +
								theme.fg(
									"dim",
									`  \u2191${formatTokens(session.usage.input)} \u2193${formatTokens(session.usage.output)}  ${elapsedStr}`,
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

export async function showRetryMenu(ctx: ExtensionContext, state: SessionState): Promise<void> {
	const failedRuns = state.getRunEntries(ctx).filter((r) => r.status === "failed").reverse();

	if (failedRuns.length === 0) {
		ctx.ui.notify("No failed subagent runs to retry.", "info");
		return;
	}

	const items: SelectItem[] = failedRuns.map((r) => {
		const name = r.label || r.task.slice(0, 60);
		const model = r.model.split("/").pop() || r.model;
		const err = r.errorMessage ? r.errorMessage.slice(0, 40) : "error";
		return {
			value: r.id,
			label: `✗ ${name}`,
			description: `${model} · ${err}`,
		};
	});

	const selectedId = await showSelectList(ctx, "Retry Failed Run", items, 10);
	if (!selectedId) return;

	ctx.ui.notify(
		`Ask the LLM to retry: "Use delegate_task to retry failed run ${selectedId.slice(0, 8)}..."`,
		"info",
	);
}

// ---------------------------------------------------------------------------
// delegate_task result rendering (renderCall / renderResult)
// ---------------------------------------------------------------------------

function buildDelegateLabel(
	args: { inheritSystemPrompt?: boolean; systemPrompt?: string },
	theme: { fg: (c: string, t: string) => string; bold: (t: string) => string },
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
	theme: { fg: (c: string, t: string) => string },
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
	theme: { fg: (c: string, t: string) => string; bold: (t: string) => string },
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
	theme: { fg: (c: string, t: string) => string; bold: (t: string) => string },
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
// Chain / parallel helper: one-line subtask summary
// ---------------------------------------------------------------------------

function renderSubTaskSummary(
	result: SubTaskResult,
	theme: {
		fg: (color: string, text: string) => string;
	},
	maxLines: number,
): string {
	const isError =
		result.exitCode !== 0 ||
		result.stopReason === "error" ||
		result.stopReason === "aborted";
	const icon = isError
		? theme.fg("error", "\u2717")
		: theme.fg("success", "\u2713");
	const label = result.label
		? theme.fg("accent", `${result.label}: `)
		: "";
	const output = getFinalOutput(result.messages);
	const preview = output.split("\n").slice(0, maxLines).join("\n");
	return `${icon} ${label}${theme.fg("toolOutput", preview)}`;
}

// ---------------------------------------------------------------------------
// Chain / parallel collapsed rendering
// ---------------------------------------------------------------------------

function renderCollapsedChain(
	details: ChainDetails,
	theme: {
		fg: (color: string, text: string) => string;
		bold: (text: string) => string;
	},
): string {
	const allSucceeded = details.results.every(
		(r) =>
			r.exitCode === 0 &&
			r.stopReason !== "error" &&
			r.stopReason !== "aborted",
	);
	const icon = allSucceeded
		? theme.fg("success", "\u2713")
		: theme.fg("error", "\u2717");
	const stoppedEarly = details.stoppedEarly ? " (stopped early)" : "";
	let text = `${icon} ${theme.fg("toolTitle", theme.bold("chain"))} ${theme.fg("muted", `${details.completedSteps}/${details.totalSteps} steps${stoppedEarly}`)}`;

	for (const r of details.results) {
		const isErr =
			r.exitCode !== 0 ||
			r.stopReason === "error" ||
			r.stopReason === "aborted";
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
	theme: {
		fg: (color: string, text: string) => string;
		bold: (text: string) => string;
	},
): string {
	const icon =
		details.failed === 0
			? theme.fg("success", "\u2713")
			: theme.fg("error", "\u2717");
	let text = `${icon} ${theme.fg("toolTitle", theme.bold("parallel"))} ${theme.fg("muted", `${details.succeeded}/${details.failed}/${details.results.length} total`)}`;

	for (const r of details.results) {
		const isErr =
			r.exitCode !== 0 ||
			r.stopReason === "error" ||
			r.stopReason === "aborted";
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
	theme: {
		fg: (color: string, text: string) => string;
		bold: (text: string) => string;
	},
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
		const isErr =
			r.exitCode !== 0 ||
			r.stopReason === "error" ||
			r.stopReason === "aborted";
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
	theme: {
		fg: (color: string, text: string) => string;
		bold: (text: string) => string;
	},
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
		const isErr =
			r.exitCode !== 0 ||
			r.stopReason === "error" ||
			r.stopReason === "aborted";
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
				} else {
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
	theme: {
		fg: (color: string, text: string) => string;
	},
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
	theme: {
		fg: (color: string, text: string) => string;
	},
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
	theme: {
		fg: (color: string, text: string) => string;
		bold: (text: string) => string;
	},
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
	theme: {
		fg: (color: string, text: string) => string;
		bold: (text: string) => string;
	},
): string {
	const totalTasks = details.waves.reduce((s, w) => s + w.tasks.length, 0);
	const allSucceeded = details.waves.every((w) =>
		w.tasks.every(
			(r) =>
				r.exitCode === 0 &&
				r.stopReason !== "error" &&
				r.stopReason !== "aborted",
		),
	);
	const icon = allSucceeded
		? theme.fg("success", "\u2713")
		: theme.fg("error", "\u2717");
	let text = `${icon} ${theme.fg("toolTitle", theme.bold("graph"))} ${theme.fg("muted", `${totalTasks} tasks in ${details.waves.length} waves`)}`;

	const maxWavesToShow = 3;
	const wavesToRender = details.waves.slice(0, maxWavesToShow);

	for (const wave of wavesToRender) {
		const waveOk = wave.tasks.every(
			(r) =>
				r.exitCode === 0 &&
				r.stopReason !== "error" &&
				r.stopReason !== "aborted",
		);
		const waveIcon = waveOk
			? theme.fg("success", "\u2713")
			: theme.fg("error", "\u2717");
		const modeLabel = wave.parallel ? "parallel" : "serial";
		const taskLabels = wave.tasks.map((r) => {
			const label = r.label || r.task.slice(0, 30);
			const taskIcon =
				r.exitCode === 0 && r.stopReason !== "error" && r.stopReason !== "aborted"
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
	theme: {
		fg: (color: string, text: string) => string;
		bold: (text: string) => string;
	},
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
		const waveOk = wave.tasks.every(
			(r) =>
				r.exitCode === 0 &&
				r.stopReason !== "error" &&
				r.stopReason !== "aborted",
		);
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
			const isErr =
				r.exitCode !== 0 ||
				r.stopReason === "error" ||
				r.stopReason === "aborted";
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
	theme: {
		fg: (color: string, text: string) => string;
		bold: (text: string) => string;
	},
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
	result: {
		content: Array<{ type: string; text: string }>;
		details?: SubagentResult | MultiSubagentDetails;
	},
	options: { expanded: boolean },
	theme: {
		fg: (color: string, text: string) => string;
		bold: (text: string) => string;
	},
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
	if (!details || details.exitCode === -1) {
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

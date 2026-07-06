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
	SubagentResult,
	SubagentRun,
	ThinkingLevel,
	UsageStats,
} from "./types";
import {
	THINKING_LEVELS,
	NAV_FOOTER,
	TASK_PREVIEW_MAX_LENGTH,
	COLLAPSED_OUTPUT_LINES,
	formatTokens,
	formatUsageStats,
	formatModel,
	formatMaxParallel,
	getFinalOutput,
	isSubagentError,
} from "./types";
import { formatPresetSummary } from "./presets";
import { formatRunDuration } from "./history";
import type { SessionState } from "./state";

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
// Preset management UI
// ---------------------------------------------------------------------------

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
			value: "historyentries",
			label: "Set Max History Entries",
			description: state.config.maxHistoryEntries === 0
				? "Unlimited (no pruning)"
				: `${state.config.maxHistoryEntries} entries kept`,
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
			value: "preset",
			label: "Manage Presets",
			description: `${state.builtinPresets.length} built-in, ${state.config.presets.length} custom`,
		},
		{
			value: "retry",
			label: "Retry Failed Run",
			description: "Select a failed subagent to retry",
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

export function describePromptMode(inheritSP: boolean, hasCustomSP: boolean): string {
	if (inheritSP && hasCustomSP) return "inherit + custom instructions";
	if (inheritSP) return "inherit";
	if (hasCustomSP) return "custom prompt";
	return "default (no inheritance)";
}

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
	} else {
		text += `\n${theme.fg("muted", "(no output)")}`;
	}
	const usageStr = formatUsageStats(details.usage, details.model);
	if (usageStr) text += `\n${theme.fg("dim", usageStr)}`;
	return text;
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
	},
	theme: {
		fg: (color: string, text: string) => string;
		bold: (text: string) => string;
	},
): Text {
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
		details?: SubagentResult;
	},
	options: { expanded: boolean },
	theme: {
		fg: (color: string, text: string) => string;
		bold: (text: string) => string;
	},
): Container | Text {
	const details = result.details;
	if (!details || details.exitCode === -1) {
		const text = result.content[0];
		return new Text(text?.type === "text" ? text.text : "(running\u2026)", 0, 0);
	}

	const isError = isSubagentError(details);
	const icon = isError ? theme.fg("error", "\u2717") : theme.fg("success", "\u2713");
	const finalOutput = getFinalOutput(details.messages);

	if (options.expanded) {
		return renderExpandedResult(
			details,
			isError,
			icon,
			finalOutput,
			theme,
			getMarkdownTheme(),
		);
	}
	return new Text(
		renderCollapsedText(details, isError, icon, finalOutput, theme),
		0,
		0,
	);
}

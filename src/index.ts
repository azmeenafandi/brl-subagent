/**
 * brl-subagent Extension
 *
 * A configurable subagent for pi. Users can assign a model and thinking level
 * to the subagent via the /brl-subagent command (selection UI similar to /model).
 * The subagent inherits the main agent's system prompt and reports back when done.
 *
 * Usage:
 *   /brl-subagent        - Open configuration menu
 *   /brl-subagent model  - Open model selector directly
 *   /brl-subagent thinking - Open thinking level selector directly
 *   /brl-subagent reset  - Reset to defaults
 *
 * The LLM can use the `delegate_task` tool to hand off work to the subagent.
 * Per-call customization: set inheritSystemPrompt and/or systemPrompt to
 * control how the subagent's system prompt is constructed.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DynamicBorder, getMarkdownTheme, withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Spacer, Text, Markdown } from "@earendil-works/pi-tui";
import { Type } from "typebox";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

interface SubagentState {
	model?: { provider: string; id: string };
	maxThinkingLevel: ThinkingLevel;
	maxParallel: number; // 0 = unlimited
	seenRunIds: string[];
}

interface SubagentRun {
	id: string;
	task: string;
	label?: string;
	status: "running" | "done" | "failed";
	model: string;
	thinkingLevel: string;
	startedAt: string;
	finishedAt?: string;
	durationMs?: number;
	cost?: number;
	tokensIn?: number;
	tokensOut?: number;
	errorMessage?: string;
	outputSummary?: string;
}

type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

interface SubagentResult {
	messages: Array<Record<string, unknown>>;
	model?: string;
	usage: UsageStats;
	stopReason?: string;
	errorMessage?: string;
	exitCode: number;
	stderr: string;
}

interface SubagentToolOptions {
	tools?: string[];
	excludeTools?: string[];
	noBuiltinTools?: boolean;
}

const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

function resolveThinkingLevel(
	requested: ThinkingLevel | undefined,
	maxAllowed: ThinkingLevel,
): ThinkingLevel {
	if (!requested) return maxAllowed;
	const requestedIdx = THINKING_LEVELS.indexOf(requested);
	const maxIdx = THINKING_LEVELS.indexOf(maxAllowed);
	return THINKING_LEVELS[Math.min(requestedIdx, maxIdx)];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Resolve the pi binary and command-line invocation for subprocess spawning.
 */
function getPiInvocation(extraArgs: string[]): { command: string; args: string[] } {
	const currentScript = process.argv[1];
	const isBunVirtualScript = currentScript?.startsWith("/$bunfs/root/");
	if (currentScript && !isBunVirtualScript && fs.existsSync(currentScript)) {
		return { command: process.execPath, args: [currentScript, ...extraArgs] };
	}

	const execName = path.basename(process.execPath).toLowerCase();
	const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
	if (!isGenericRuntime) {
		return { command: process.execPath, args: extraArgs };
	}

	return { command: "pi", args: extraArgs };
}

function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

function formatUsageStats(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

function getFinalOutput(messages: Array<Record<string, unknown>>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as Record<string, unknown>;
		if (msg.role === "assistant") {
			const content = msg.content as Array<Record<string, unknown>> | undefined;
			if (content) {
				for (const part of content) {
					if (part.type === "text") return part.text as string;
				}
			}
		}
	}
	return "";
}

async function writeToTempFile(cwd: string, name: string, content: string): Promise<{ dir: string; filePath: string }> {
	const baseDir = path.join(cwd, ".pi", "subagent-tmp");
	await fs.promises.mkdir(baseDir, { recursive: true });
	const tmpDir = await fs.promises.mkdtemp(path.join(baseDir, `${name}-`));
	const filePath = path.join(tmpDir, `${name}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, content, { encoding: "utf-8", mode: TEMP_FILE_MODE });
	});
	return { dir: tmpDir, filePath };
}

function cleanupTempDir(dir: string, filePath: string) {
	try {
		fs.unlinkSync(filePath);
	} catch {
		/* ignore */
	}
	try {
		fs.rmdirSync(dir);
	} catch {
		/* ignore */
	}
}

// ---------------------------------------------------------------------------
// Shared constants & utilities
// ---------------------------------------------------------------------------

const EMPTY_USAGE: UsageStats = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
};

const NAV_FOOTER = "\u2191\u2193 navigate \u2022 enter select \u2022 esc cancel";

const SIGKILL_GRACE_MS = 5000;
const STATUS_RESET_DELAY_MS = 3000;
const TEMP_FILE_MODE = 0o600;
const TASK_PREVIEW_MAX_LENGTH = 80;
const COLLAPSED_OUTPUT_LINES = 5;

function isSubagentError(result: SubagentResult): boolean {
	return result.exitCode !== 0
		|| result.stopReason === "error"
		|| result.stopReason === "aborted";
}

function formatModel(m: { provider: string; id: string } | undefined): string {
	return m ? `${m.provider}/${m.id}` : "Not set (will use main agent\u2019s model)";
}

function formatMaxParallel(n: number): string {
	return n === 0 ? "unlimited" : String(n);
}

function makeSelectListTheme(theme: { fg: (c: string, t: string) => string }) {
	return {
		selectedPrefix: (t: string) => theme.fg("accent", t),
		selectedText: (t: string) => theme.fg("accent", t),
		description: (t: string) => theme.fg("muted", t),
		scrollInfo: (t: string) => theme.fg("dim", t),
		noMatch: (t: string) => theme.fg("warning", t),
	};
}

async function showSelectList(
	ctx: ExtensionContext,
	title: string,
	items: SelectItem[],
	maxItems: number,
): Promise<string | null> {
	return ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
		container.addChild(new Text(theme.fg("accent", theme.bold(title)), 1, 0));

		const selectList = new SelectList(items, Math.min(items.length, maxItems), makeSelectListTheme(theme));
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
// Subagent argument & stream helpers
// ---------------------------------------------------------------------------

function buildSubagentArgs(
	model: { provider: string; id: string },
	thinkingLevel: ThinkingLevel,
	toolOptions?: SubagentToolOptions,
): string[] {
	const args: string[] = [
		"--mode",
		"json",
		"-p",
		"--no-session",
		"--model",
		`${model.provider}/${model.id}`,
		"--thinking",
		thinkingLevel,
	];
	if (toolOptions?.noBuiltinTools) {
		args.push("--no-builtin-tools");
	} else if (toolOptions?.tools && toolOptions.tools.length > 0) {
		args.push("--tools", toolOptions.tools.join(","));
	}
	if (toolOptions?.excludeTools && toolOptions.excludeTools.length > 0) {
		args.push("--exclude-tools", toolOptions.excludeTools.join(","));
	}
	return args;
}

function accumulateUsage(
	target: UsageStats,
	src: {
		input?: number;
		output?: number;
		cacheRead?: number;
		cacheWrite?: number;
		cost?: { total?: number };
		totalTokens?: number;
	} | undefined,
): void {
	if (!src) return;
	target.turns++;
	target.input += src.input ?? 0;
	target.output += src.output ?? 0;
	target.cacheRead += src.cacheRead ?? 0;
	target.cacheWrite += src.cacheWrite ?? 0;
	if (src.cost && typeof src.cost.total === "number") {
		target.cost += src.cost.total;
	}
	if (src.totalTokens) {
		target.contextTokens = src.totalTokens;
	}
}

function emitSubagentUpdate(
	result: SubagentResult,
	onUpdate: ((partial: AgentToolResult<SubagentResult>) => void) | undefined,
): void {
	if (!onUpdate) return;
	onUpdate({
		content: [{ type: "text", text: getFinalOutput(result.messages) || "(running...)" }],
		details: { ...result },
	});
}

function parseSubagentLine(
	line: string,
	result: SubagentResult,
	onUpdate: ((partial: AgentToolResult<SubagentResult>) => void) | undefined,
): void {
	if (!line.trim()) return;
	let event: Record<string, unknown>;
	try {
		event = JSON.parse(line) as Record<string, unknown>;
	} catch {
		result.stderr += `[parse error] ${line.trim().slice(0, 200)}\n`;
		return;
	}

	if (event.type === "message_end" && event.message) {
		const msg = event.message as Record<string, unknown>;
		result.messages.push(msg);

		if (msg.role === "assistant") {
			const usage = msg.usage as Parameters<typeof accumulateUsage>[1];
			accumulateUsage(result.usage, usage);
			if (!result.model && msg.model) result.model = msg.model as string;
			if (msg.stopReason) result.stopReason = msg.stopReason as string;
			if (msg.errorMessage) result.errorMessage = msg.errorMessage as string;
		}

		emitSubagentUpdate(result, onUpdate);
	}

	if (event.type === "tool_result_end" && event.message) {
		result.messages.push(event.message as Record<string, unknown>);
		emitSubagentUpdate(result, onUpdate);
	}
}

function attachAbortHandler(
	proc: { kill: (signal: string) => boolean; killed: boolean },
	signal: AbortSignal,
): void {
	const killProc = () => {
		proc.kill("SIGTERM");
		setTimeout(() => {
			if (!proc.killed) proc.kill("SIGKILL");
		}, SIGKILL_GRACE_MS);
	};
	if (signal.aborted) killProc();
	else signal.addEventListener("abort", killProc, { once: true });
}

// ---------------------------------------------------------------------------
// Subagent process runner
// ---------------------------------------------------------------------------

async function runSubagent(
	cwd: string,
	systemPrompt: string,
	model: { provider: string; id: string },
	thinkingLevel: ThinkingLevel,
	task: string,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: AgentToolResult<SubagentResult>) => void) | undefined,
	toolOptions?: SubagentToolOptions,
	timeout?: number,
): Promise<SubagentResult> {
	const args = buildSubagentArgs(model, thinkingLevel, toolOptions);

	let tmpDir: string | null = null;
	let tmpFilePath: string | null = null;

	if (systemPrompt.trim()) {
		const tmp = await writeToTempFile(cwd, "system", systemPrompt);
		tmpDir = tmp.dir;
		tmpFilePath = tmp.filePath;
		args.push("--append-system-prompt", tmpFilePath);
	}

	// Pass the task as the prompt argument
	args.push(task);

	const result: SubagentResult = {
		messages: [],
		usage: { ...EMPTY_USAGE },
		exitCode: 0,
		stderr: "",
	};

	try {
		const exitCode = await new Promise<number>((resolve) => {
			const invocation = getPiInvocation(args);
			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["ignore", "pipe", "pipe"],
			});

			let buffer = "";

			proc.stdout.on("data", (data: Buffer) => {
				buffer += data.toString();
				const lines = buffer.split("\n");
				buffer = lines.pop() ?? "";
				for (const line of lines) parseSubagentLine(line, result, onUpdate);
			});

			proc.stderr.on("data", (data: Buffer) => {
				result.stderr += data.toString();
			});

			proc.on("close", (code) => {
				if (buffer.trim()) parseSubagentLine(buffer, result, onUpdate);
				resolve(code ?? 0);
			});

			proc.on("error", (err) => {
				result.errorMessage = `Subprocess error: ${err.message}`;
				result.stderr += err.message;
				resolve(1);
			});

			if (signal) {
				attachAbortHandler(proc, signal);
			}

			if (timeout && timeout > 0) {
				const timer = setTimeout(() => {
					result.errorMessage = `Subagent timed out after ${timeout}ms`;
					proc.kill("SIGTERM");
					setTimeout(() => {
						if (!proc.killed) proc.kill("SIGKILL");
					}, SIGKILL_GRACE_MS);
				}, timeout);
				proc.on("close", () => clearTimeout(timer));
			}
		});

		result.exitCode = exitCode;
		return result;
	} finally {
		if (tmpDir && tmpFilePath) cleanupTempDir(tmpDir, tmpFilePath);
	}
}

/**
 * Build the subagent's system prompt based on inheritance and customization options.
 */
function buildSubagentPrompt(
	basePrompt: string,
	inheritSystemPrompt: boolean,
	customSystemPrompt: string | undefined,
	outputFile?: string,
): string {
	const SUBAGENT_INSTRUCTIONS =
		"You are now acting as a subagent. Your task has been delegated to you by the main agent.\n\n" +
		"Complete the assigned task thoroughly. When finished, provide a clear summary covering:\n" +
		"1. What you did\n" +
		"2. Key findings or results\n" +
		"3. Any issues or limitations encountered\n" +
		"4. Files modified (if any)";

	let outputBlock = "";
	if (outputFile) {
		outputBlock =
			`## Output Instructions\n\n` +
			`Write your complete findings to the file at: ${outputFile}\n` +
			`Use the write tool to create this file.\n\n` +
			`Then, in your final response, provide ONLY a structured summary:\n` +
			`1. A 2-3 sentence overview of what you found\n` +
			`2. A compact index with: severity counts, key keywords, files examined, and section references\n` +
			`3. Do NOT include the full findings in your response — they are in the file.\n\n` +
			`When finished, your final response should look like:\n\n` +
			`## Summary\n[2-3 sentences]\n\n` +
			`## Index\n- Critical: N (see §X)\n- High: N (see §Y)\n- Medium: N (see §Z)\n` +
			`- Keywords: word1, word2, word3\n- Files examined: file1.ts, file2.ts`;
	}

	const parts: string[] = [];
	if (inheritSystemPrompt) parts.push(basePrompt);
	if (customSystemPrompt) parts.push(customSystemPrompt);
	if (outputBlock) parts.push(outputBlock);
	parts.push(SUBAGENT_INSTRUCTIONS);

	return parts.join("\n\n");
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const state: SubagentState = {
		maxThinkingLevel: "off",
		maxParallel: 0,
		seenRunIds: [],
	};

	// Module-level progress tracking
	let activeSubagents = 0;
	let completedSubagents = 0;
	let failedSubagents = 0;
	let unseenSubagents = 0;

	// -----------------------------------------------------------------------
	// Status display
	// -----------------------------------------------------------------------

	function updateStatus(ctx: ExtensionContext) {
		if (state.model) {
			ctx.ui.setStatus(
				"brl-subagent",
				ctx.ui.theme.fg("accent", `brl:${state.model.id} [max think:${state.maxThinkingLevel}]`),
			);
		} else {
			ctx.ui.setStatus(
				"brl-subagent",
				ctx.ui.theme.fg("muted", "brl: (use /brl-subagent to configure)"),
			);
		}
	}

	function updateProgressStatus(ctx: ExtensionContext) {
		const total = activeSubagents + completedSubagents + failedSubagents;
		if (total === 0) {
			updateStatus(ctx);
			return;
		}

		const parts: string[] = [];
		if (activeSubagents > 0) parts.push(`${activeSubagents} running`);
		if (completedSubagents > 0) {
			if (unseenSubagents > 0) {
				parts.push(`${completedSubagents} done (${unseenSubagents} unseen)`);
			} else {
				parts.push(`${completedSubagents} done`);
			}
		}
		if (failedSubagents > 0) parts.push(`${failedSubagents} failed`);

		const statusText = `brl: ${parts.join(", ")}`;
		ctx.ui.setStatus("brl-subagent", ctx.ui.theme.fg("accent", statusText));

		// When all subagents finish, reset counters after a brief delay
		if (activeSubagents === 0 && total > 0) {
			const snapshotTotal = total;
			setTimeout(() => {
				if (activeSubagents === 0 && (completedSubagents + failedSubagents) === snapshotTotal) {
					completedSubagents = 0;
					failedSubagents = 0;
					unseenSubagents = 0;
					updateStatus(ctx);
				}
			}, STATUS_RESET_DELAY_MS);
		}
	}

	// -----------------------------------------------------------------------
	// Configuration helpers
	// -----------------------------------------------------------------------

	function applyConfig(ctx: ExtensionContext, message: string) {
		updateStatus(ctx);
		persistState();
		ctx.ui.notify(message, "info");
	}

	function resetState(ctx: ExtensionContext) {
		state.model = undefined;
		state.maxThinkingLevel = "off";
		state.maxParallel = 0;
		updateStatus(ctx);
		persistState();
		ctx.ui.notify("Subagent configuration reset", "info");
	}

	// Queue mechanism for concurrency control
	let pendingQueue: Array<{
		run: () => void;
		signal: AbortSignal | undefined;
		ctx: ExtensionContext;
	}> = [];

	async function acquireSlot(ctx: ExtensionContext, signal?: AbortSignal): Promise<boolean> {
		if (state.maxParallel === 0 || activeSubagents < state.maxParallel) {
			activeSubagents++;
			updateProgressStatus(ctx);
			return true;
		}
		return new Promise((resolve) => {
			const entry = {
				run: () => {
					activeSubagents++;
					updateProgressStatus(ctx);
					resolve(true);
				},
				signal,
				ctx,
			};
			pendingQueue.push(entry);
			if (signal) {
				signal.addEventListener("abort", () => {
					const idx = pendingQueue.indexOf(entry);
					if (idx >= 0) {
						pendingQueue.splice(idx, 1);
						resolve(false);
					}
				}, { once: true });
			}
		});
	}

	function releaseSlot(success: boolean, ctx: ExtensionContext) {
		activeSubagents--;
		if (success) {
			completedSubagents++;
			unseenSubagents++;
		} else {
			failedSubagents++;
		}
		updateProgressStatus(ctx);

		const next = pendingQueue.shift();
		if (next && !next.signal?.aborted) {
			next.run();
		}
	}

	// -----------------------------------------------------------------------
	// Persist state to session
	// -----------------------------------------------------------------------

	function persistState() {
		pi.appendEntry("brl-subagent-state", {
			model: state.model,
			maxThinkingLevel: state.maxThinkingLevel,
			maxParallel: state.maxParallel,
			seenRunIds: state.seenRunIds,
		});
	}

	function persistRun(run: SubagentRun) {
		pi.appendEntry("brl-subagent-run", run);
	}

	// -----------------------------------------------------------------------
	// Model selector (selection UI similar to /model)
	// -----------------------------------------------------------------------

	async function showModelSelector(ctx: ExtensionContext): Promise<void> {
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
		state.model = { provider: result.slice(0, slashIdx), id: result.slice(slashIdx + 1) };
		applyConfig(ctx, `Subagent model set to ${result}`);
	}

	// -----------------------------------------------------------------------
	// Thinking level selector
	// -----------------------------------------------------------------------

	async function showThinkingSelector(ctx: ExtensionContext): Promise<void> {
		const items: SelectItem[] = THINKING_LEVELS.map((level) => ({
			value: level,
			label: level === state.maxThinkingLevel ? `${level} (current - ceiling)` : level,
		}));

		const result = await showSelectList(ctx, "Select Max Thinking Level", items, 10);
		if (!result) return;

		state.maxThinkingLevel = result as ThinkingLevel;
		applyConfig(ctx, `Subagent max thinking level set to ${result} (subagents can request up to ${result})`);
	}

	// -----------------------------------------------------------------------
	// Concurrency input
	// -----------------------------------------------------------------------

	async function showConcurrencyInput(ctx: ExtensionContext): Promise<void> {
		const result = await ctx.ui.input({
			prompt: "Max parallel subagents (0 = unlimited):",
			default: formatMaxParallel(state.maxParallel),
		});
		if (result == null) return;
		const num = parseInt(result, 10);
		if (isNaN(num) || num < 0) {
			ctx.ui.notify("Invalid number. Must be >= 0.", "error");
			return;
		}
		state.maxParallel = num;
		applyConfig(ctx, `Max parallel subagents set to ${formatMaxParallel(num)}`);
	}

	// -----------------------------------------------------------------------
	// Main configuration menu
	// -----------------------------------------------------------------------

	function getConfigMenuItems(): SelectItem[] {
		return [
			{
				value: "model",
				label: "Select Model",
				description: state.model
					? `${state.model.provider}/${state.model.id}`
					: "Not set (will use main agent\u2019s model by default)",
			},
			{
				value: "thinking",
				label: "Select Max Thinking Level",
				description: state.maxThinkingLevel,
			},
			{
				value: "concurrency",
				label: "Set Max Parallel Subagents",
				description: formatMaxParallel(state.maxParallel),
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
		];
	}

	async function showConfigMenu(ctx: ExtensionContext): Promise<void> {
		const items = getConfigMenuItems();

		const result = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
			const container = new Container();

			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
			container.addChild(
				new Text(theme.fg("accent", theme.bold("brl-subagent Configuration")), 1, 0),
			);

			container.addChild(new Text(theme.fg("dim", `Model: ${formatModel(state.model)}`), 1, 0));
			container.addChild(new Text(theme.fg("dim", `Max Thinking: ${state.maxThinkingLevel}`), 1, 0));
			container.addChild(new Text(theme.fg("dim", `Max parallel: ${formatMaxParallel(state.maxParallel)}`), 1, 0));
			container.addChild(new Text("", 0, 0)); // spacer

			const selectList = new SelectList(items, Math.min(items.length, 10), makeSelectListTheme(theme));
			selectList.onSelect = (item) => done(item.value);
			selectList.onCancel = () => done(null);

			container.addChild(selectList);
			container.addChild(
				new Text(theme.fg("dim", NAV_FOOTER), 1, 0),
			);
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

		if (!result) return;

		if (result === "model") {
			await showModelSelector(ctx);
		} else if (result === "thinking") {
			await showThinkingSelector(ctx);
		} else if (result === "concurrency") {
			await showConcurrencyInput(ctx);
		} else if (result === "reset") {
			resetState(ctx);
		}
	}

	// -----------------------------------------------------------------------
	// Run history viewer
	// -----------------------------------------------------------------------

	function formatRunDuration(ms: number): string {
		if (ms < 1000) return `${ms}ms`;
		const sec = (ms / 1000).toFixed(1);
		if (ms < 60_000) return `${sec}s`;
		const min = Math.floor(ms / 60_000);
		const secs = Math.round((ms % 60_000) / 1000);
		return `${min}m ${secs}s`;
	}

	async function showRunHistory(ctx: ExtensionContext): Promise<void> {
		const entries = ctx.sessionManager.getEntries();
		const runs = entries
			.filter((e: { type: string; customType?: string }) =>
				e.type === "custom" && e.customType === "brl-subagent-run",
			)
			.map((e: { data?: SubagentRun }) => e.data!)
			.filter(Boolean)
			.reverse(); // newest first

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
			const when = r.finishedAt
				? formatRunDuration(r.durationMs || 0)
				: "running...";
			const cost = r.cost ? ` $${r.cost.toFixed(4)}` : "";
			const desc = `${r.thinkingLevel} · ${model} · ${when}${cost}`;
			const selLabel = `${icon} ${name}`;
			return { value: r.id, label: selLabel, description: desc };
		});

		const selectedId = await showSelectList(ctx, "Subagent History", items, 15);
		if (!selectedId) return;

		const run = runs.find((r) => r.id === selectedId);
		if (!run) return;

		// Mark as seen
		if (!state.seenRunIds.includes(run.id)) {
			state.seenRunIds.push(run.id);
			if (unseenSubagents > 0) unseenSubagents--;
			updateProgressStatus(ctx);
			persistState();
		}

		// Show detail view
		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const container = new Container();
			container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));

			const statusLabel = run.status === "done" ? "Completed" : run.status === "failed" ? "Failed" : "Running";
			container.addChild(new Text(
				theme.fg("toolTitle", theme.bold(`${run.label || "Subagent"} — ${statusLabel}`)), 1, 0));
			container.addChild(new Text("", 0, 0));
			container.addChild(new Text(theme.fg("dim", `Task: ${run.task.slice(0, 200)}`), 1, 0));
			container.addChild(new Text(theme.fg("dim", `Model: ${run.model} · Thinking: ${run.thinkingLevel}`), 1, 0));
			container.addChild(new Text(theme.fg("dim", `Started: ${run.startedAt}`), 1, 0));
			if (run.finishedAt) {
				container.addChild(new Text(theme.fg("dim", `Finished: ${run.finishedAt} (${formatRunDuration(run.durationMs || 0)})`), 1, 0));
			}
			if (run.cost) {
				container.addChild(new Text(theme.fg("dim", `Cost: $${run.cost.toFixed(4)} · ↑${formatTokens(run.tokensIn || 0)} ↓${formatTokens(run.tokensOut || 0)}`), 1, 0));
			}
			if (run.errorMessage) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("error", `Error: ${run.errorMessage}`), 1, 0));
			}
			if (run.outputSummary) {
				container.addChild(new Spacer(1));
				container.addChild(new Text(theme.fg("muted", "\u2500\u2500\u2500 Output Preview \u2500\u2500\u2500"), 1, 0));
				container.addChild(new Text(theme.fg("toolOutput", run.outputSummary), 1, 0));
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

	// -----------------------------------------------------------------------
	// /brl-subagent command
	// -----------------------------------------------------------------------

	pi.registerCommand("brl-subagent", {
		description: "Configure subagent model and thinking level",
		getArgumentCompletions: (prefix: string) => {
			const options = ["model", "thinking", "concurrency", "reset", "history"];
			const filtered = options.filter((o) => o.startsWith(prefix));
			return filtered.length > 0
				? filtered.map((o) => ({ value: o, label: o }))
				: null;
		},
		handler: async (args, ctx) => {
			const trimmed = args?.trim();
			if (trimmed === "model") {
				await showModelSelector(ctx);
			} else if (trimmed === "thinking") {
				await showThinkingSelector(ctx);
			} else if (trimmed === "concurrency") {
				await showConcurrencyInput(ctx);
			} else if (trimmed === "reset") {
				resetState(ctx);
			} else if (trimmed === "history") {
				await showRunHistory(ctx);
			} else {
				await showConfigMenu(ctx);
			}
		},
	});

	// -----------------------------------------------------------------------
	// Display helpers (used by delegate_task's renderCall / renderResult)
	// -----------------------------------------------------------------------

	function describePromptMode(inheritSP: boolean, hasCustomSP: boolean): string {
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
			? (hasCustom ? "[inherit+custom]" : null)
			: (hasCustom ? "[custom]" : "[no-inherit]");
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
		const labelText = details.label
			? theme.fg("accent", ` [${details.label}]`)
			: "";
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
			container.addChild(new Text(theme.fg("muted", "\u2500\u2500\u2500 Output \u2500\u2500\u2500"), 0, 0));
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
			const preview = finalOutput.split("\n").slice(0, COLLAPSED_OUTPUT_LINES).join("\n");
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

	// -----------------------------------------------------------------------
	// delegate_task helpers
	// -----------------------------------------------------------------------

	interface ResolvedParams {
		task: string;
		label: string | undefined;
		inheritSP: boolean;
		customSP: string | undefined;
		outputFile: string | undefined;
		timeout: number | undefined;
		effectiveCwd: string;
		thinkingLevel: ThinkingLevel;
		toolOptions: SubagentToolOptions | undefined;
	}

	function resolveSubagentParams(
		params: {
			task: string;
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
		ctx: ExtensionContext,
	): ResolvedParams {
		const thinkingLevel = resolveThinkingLevel(
			params.thinkingLevel as ThinkingLevel | undefined,
			state.maxThinkingLevel,
		);

		const toolOptions: SubagentToolOptions | undefined =
			params.tools || params.excludeTools || params.noBuiltinTools
				? { tools: params.tools, excludeTools: params.excludeTools, noBuiltinTools: params.noBuiltinTools }
				: undefined;

		return {
			task: params.task,
			label: params.label?.trim() || undefined,
			inheritSP: params.inheritSystemPrompt !== false,
			customSP: params.systemPrompt,
			outputFile: params.outputFile,
			timeout: params.timeout,
			effectiveCwd: params.cwd || ctx.cwd,
			thinkingLevel,
			toolOptions,
		};
	}

	function resolveSubagentModel(ctx: ExtensionContext):
		| { ok: true; model: { provider: string; id: string } }
		| { ok: false; error: AgentToolResult<SubagentResult> }
	{
		const subagentModel = state.model ||
			(ctx.model
				? { provider: ctx.model.provider, id: ctx.model.id }
				: undefined);

		if (!subagentModel) {
			return {
				ok: false,
				error: {
					content: [{
						type: "text" as const,
						text: "No model available. Configure API keys first, then use /brl-subagent to set a model.",
					}],
					isError: true,
				},
			};
		}

		return { ok: true, model: subagentModel };
	}

	// -----------------------------------------------------------------------
	// delegate_task tool
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "delegate_task",
		label: "Delegate Task",
		description: [
			"Delegate a task to the brl-subagent with isolated context.",
			"The subagent inherits your current system prompt and runs with",
			"its configured model and thinking level (set via /brl-subagent).",
			"If no subagent model is configured, your current model is used.",
			"The subagent reports what it did when complete.",
			"Optionally provide a custom systemPrompt and control inheritance via inheritSystemPrompt.",
		].join(" "),
		promptSnippet: "Delegate tasks to a subagent for isolated, parallel or background work",
		promptGuidelines: [
			"Use delegate_task when the user asks you to hand off work to a subagent, or when a task would benefit from an isolated context window (e.g., deep investigation, parallel research, long-running analysis).",
			"The subagent inherits your system prompt and runs with its own model (configurable via /brl-subagent). It reports what it did when done.",
			"You can customize per-call via inheritSystemPrompt and systemPrompt: set inheritSystemPrompt: false to save context, provide a systemPrompt for custom instructions, or use both to add instructions on top of inheritance.",
			"Set thinkingLevel per call for task-appropriate reasoning depth (off/minimal/low/medium/high/xhigh). It is capped at the user's configured maximum. Use lower levels for simple lookups, higher levels for deep analysis.",
			"Use outputFile to have the subagent write full findings to disk and return only a structured summary — saves context tokens for large investigations.",
			"Set timeout (in ms) to limit how long a subagent can run. Useful for tasks that might hang or get stuck.",
			"Set cwd to override the subagent's working directory. Defaults to the current project directory.",
			"Set label to give the subagent a human-readable name (e.g., 'security-audit' or 'docs-review'). Labels appear in the status bar and tool call display.",
		],
		parameters: Type.Object({
			task: Type.String({
				description: "Detailed description of the task for the subagent to complete",
			}),
			systemPrompt: Type.Optional(
				Type.String({
					description:
						"Custom system prompt or additional instructions for the subagent. " +
						"When inheritSystemPrompt is true (default), this is appended after the inherited prompt. " +
						"When inheritSystemPrompt is false, this replaces the inherited prompt entirely.",
				}),
			),
			inheritSystemPrompt: Type.Optional(
				Type.Boolean({
					description:
						"Whether to inherit the main agent's system prompt. " +
						"Default: true. Set to false to use only your custom systemPrompt, " +
						"or to avoid passing a large inherited prompt to the subagent.",
				}),
			),
			thinkingLevel: Type.Optional(
				Type.String({
					description:
						"Requested thinking level for this subagent call. " +
						"One of: off, minimal, low, medium, high, xhigh. " +
						"Capped at the user's configured maximum. If omitted, the user's configured level is used.",
				}),
			),
			outputFile: Type.Optional(
				Type.String({
					description:
						"Project-relative path where the subagent should write its full findings. " +
						"When provided, the subagent is instructed to write complete output to this file " +
						"and return only a structured summary.",
				}),
			),
			label: Type.Optional(
				Type.String({
					description:
						"Human-readable label for this subagent (e.g., 'security-audit', 'docs-review'). " +
						"Appears in the status bar and tool call display. " +
						"Omit to use the default anonymous counter.",
				}),
			),
			timeout: Type.Optional(
				Type.Number({
					description:
						"Maximum time in milliseconds the subagent is allowed to run. " +
						"If exceeded, the subagent is killed and an error is returned.",
				}),
			),
			cwd: Type.Optional(
				Type.String({
					description:
						"Working directory for the subagent. Must be an existing directory. " +
						"Defaults to the conductor's current working directory.",
				}),
			),
			tools: Type.Optional(Type.Array(Type.String(), {
				description: "Explicit allowlist of tool names for the subagent. Maps to pi's --tools flag.",
			})),
			excludeTools: Type.Optional(Type.Array(Type.String(), {
				description: "Tool names to disable for the subagent. Maps to pi's --exclude-tools flag.",
			})),
			noBuiltinTools: Type.Optional(Type.Boolean({
				description: "Disable all built-in tools for the subagent. Maps to pi's --no-builtin-tools flag.",
			})),
		}),

		async execute(
			_toolCallId: string,
			params: {
				task: string;
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
			signal: AbortSignal | undefined,
			onUpdate: ((partial: AgentToolResult<SubagentResult>) => void) | undefined,
			ctx: ExtensionContext,
		) {
			const { task, label, inheritSP, customSP, outputFile, timeout, effectiveCwd, thinkingLevel, toolOptions } =
				resolveSubagentParams(params, ctx);

			// Determine subagent model: configured model, or fall back to main agent's model
			const modelResult = resolveSubagentModel(ctx);
			if (!modelResult.ok) return modelResult.error;
			const subagentModel = modelResult.model;

			// Start tracking this run for history
			const runId = crypto.randomUUID();
			const run: SubagentRun = {
				id: runId,
				task,
				label,
				status: "running",
				model: `${subagentModel.provider}/${subagentModel.id}`,
				thinkingLevel,
				startedAt: new Date().toISOString(),
			};
			persistRun(run);

			const acquired = await acquireSlot(ctx, signal);
			if (!acquired) {
				return {
					content: [{ type: "text" as const, text: "Subagent cancelled while waiting for concurrency slot." }],
					isError: true,
				};
			}

			let success = false;
			try {
				// Build the subagent's system prompt based on inheritSystemPrompt and systemPrompt
				const basePrompt = ctx.getSystemPrompt();
				const subagentPrompt = buildSubagentPrompt(basePrompt, inheritSP, customSP, outputFile);

				// Emit initial progress with mode info
				const modeInfo = describePromptMode(inheritSP, Boolean(customSP));

				onUpdate?.({
					content: [
						{
							type: "text" as const,
							text: `Starting subagent (${modeInfo})...`,
						},
					],
					details: {
						messages: [],
						usage: { ...EMPTY_USAGE },
						exitCode: -1,
						stderr: "",
					},
				});

				const result = await runSubagent(
					effectiveCwd,
					subagentPrompt,
					subagentModel,
					thinkingLevel,
					task,
					signal,
					onUpdate,
					toolOptions,
					timeout,
				);

				const finalOutput = getFinalOutput(result.messages);
				const isError = isSubagentError(result);

				// Attach label to result for display
				result.label = label;

				// Update run record with completion data
				const finishedAt = new Date().toISOString();
				run.status = isError ? "failed" : "done";
				run.finishedAt = finishedAt;
				run.durationMs = Date.now() - new Date(run.startedAt).getTime();
				run.cost = result.usage.cost;
				run.tokensIn = result.usage.input;
				run.tokensOut = result.usage.output;
				run.errorMessage = result.errorMessage;
				run.outputSummary = finalOutput.slice(0, 200);
				persistRun(run);

				if (isError) {
					const errorMsg =
						result.errorMessage || result.stderr || finalOutput || "(no output from subagent)";
					return {
						content: [{ type: "text" as const, text: `Subagent failed: ${errorMsg}` }],
						details: result,
						isError: true,
					};
				}

				success = true;
				return {
					content: [{ type: "text" as const, text: finalOutput || "(no output)" }],
					details: result,
				};
			} catch (err) {
				return {
					content: [{ type: "text" as const, text: `Subagent crashed: ${(err as Error).message || String(err)}` }],
					details: {
						messages: [],
						usage: { ...EMPTY_USAGE },
						exitCode: 1,
						stderr: String(err),
						errorMessage: (err as Error).message || String(err),
					},
					isError: true,
				};
			} finally {
				releaseSlot(success, ctx);
			}
		},

		renderCall(
			args: { task?: string; label?: string; systemPrompt?: string; inheritSystemPrompt?: boolean; thinkingLevel?: string; outputFile?: string; timeout?: number; cwd?: string; tools?: string[]; excludeTools?: string[]; noBuiltinTools?: boolean },
			theme: {
				fg: (color: string, text: string) => string;
				bold: (text: string) => string;
			},
			_context: unknown,
		) {
			const dl = buildDelegateLabel(args, theme);
			const scopeLabel = buildScopeLabel(args, theme);
			const nameLabel = args.label
				? theme.fg("accent", `[${args.label}] `)
				: "";
			const preview = args.task
				? args.task.length > TASK_PREVIEW_MAX_LENGTH
					? `${args.task.slice(0, TASK_PREVIEW_MAX_LENGTH)}\u2026`
					: args.task
				: "\u2026";
			return new Text(dl + scopeLabel + nameLabel + theme.fg("dim", preview), 0, 0);
		},

		renderResult(
			result: {
				content: Array<{ type: string; text: string }>;
				details?: SubagentResult;
			},
			options: { expanded: boolean },
			theme: {
				fg: (color: string, text: string) => string;
				bold: (text: string) => string;
			},
			_context: unknown,
		) {
			const details = result.details;
			if (!details || details.exitCode === -1) {
				const text = result.content[0];
				return new Text(text?.type === "text" ? text.text : "(running\u2026)", 0, 0);
			}

			const isError = isSubagentError(details);
			const icon = isError ? theme.fg("error", "\u2717") : theme.fg("success", "\u2713");
			const finalOutput = getFinalOutput(details.messages);

			if (options.expanded) {
				return renderExpandedResult(details, isError, icon, finalOutput, theme, getMarkdownTheme());
			}
			return new Text(renderCollapsedText(details, isError, icon, finalOutput, theme), 0, 0);
		},
	});

	// -----------------------------------------------------------------------
	// Session lifecycle
	// -----------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		const entries = ctx.sessionManager.getEntries();
		const stateEntry = entries
			.filter(
				(e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "brl-subagent-state",
			)
			.pop() as { data?: SubagentState } | undefined;

		if (stateEntry?.data) {
			if (stateEntry.data.model) state.model = stateEntry.data.model;
			const storedLevel = (stateEntry.data as any).maxThinkingLevel
				|| (stateEntry.data as any).thinkingLevel;
			if (storedLevel) state.maxThinkingLevel = storedLevel;
			if (stateEntry.data.maxParallel !== undefined) state.maxParallel = stateEntry.data.maxParallel;
			if ((stateEntry.data as any).seenRunIds) state.seenRunIds = (stateEntry.data as any).seenRunIds;
		}

		updateStatus(ctx);
	});
}

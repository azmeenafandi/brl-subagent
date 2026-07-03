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

import { spawn, exec } from "node:child_process";
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

interface SubagentPreset {
	name: string;
	description?: string;
	systemPrompt?: string;
	inheritSystemPrompt?: boolean;
	thinkingLevel?: string;
	outputFile?: string;
	timeout?: number;
	tools?: string[];
	excludeTools?: string[];
	noBuiltinTools?: boolean;
}

interface SubagentState {
	model?: { provider: string; id: string };
	maxThinkingLevel: ThinkingLevel;
	maxParallel: number; // 0 = unlimited
	seenRunIds: string[];
	presets: SubagentPreset[];
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
	fullOutput?: string;
	originalParams?: {
		systemPrompt?: string;
		inheritSystemPrompt?: boolean;
		thinkingLevel?: string;
		outputFile?: string;
		timeout?: number;
		cwd?: string;
		tools?: string[];
		excludeTools?: string[];
		noBuiltinTools?: boolean;
		preset?: string;
	};
}

interface LiveSubagent {
	id: string;
	label?: string;
	task: string;
	model: string;
	thinkingLevel: string;
	startedAt: number;
	liveOutput: string;
	usage: { input: number; output: number };
	ctx: ExtensionContext;
}

interface BackgroundSubagent {
	paneId: string;
	task: string;
	label?: string;
	model: string;
	thinkingLevel: string;
	startedAt: number;
	outputFile: string;
	doneFile: string;
	cwd: string;
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
// Built-in personality presets (loaded from presets/ directory)
// ---------------------------------------------------------------------------

function parseFrontmatter(content: string): { meta: Record<string, unknown>; body: string } {
	const match = content.match(/^---\n([\s\S]*?)\n---\n([\s\S]*)$/);
	if (!match) return { meta: {}, body: content };

	const meta: Record<string, unknown> = {};
	const lines = match[1].split("\n");
	let currentKey = "";
	let currentArray: string[] | null = null;

	for (const line of lines) {
		// Array item: starts with "- "
		if (line.match(/^\s+-\s+/)) {
			if (currentArray !== null) {
				currentArray.push(line.replace(/^\s+-\s+/, "").trim());
			}
			continue;
		}

		// End of array if we were in one
		if (currentArray !== null) {
			meta[currentKey] = currentArray;
			currentArray = null;
		}

		// Key-value pair
		const kvMatch = line.match(/^(\w+):\s*(.*)$/);
		if (kvMatch) {
			const key = kvMatch[1];
			const value = kvMatch[2].trim();
			// Check if next line starts an array
			if (value === "") {
				currentKey = key;
				currentArray = [];
			} else {
				// Strip quotes if present
				meta[key] = value.replace(/^["']|["']$/g, "");
			}
		}
	}
	// Close any pending array
	if (currentArray !== null) {
		meta[currentKey] = currentArray;
	}

	return { meta, body: match[2].trim() };
}

function loadBuiltinPresets(presetsDir: string): SubagentPreset[] {
	const presets: SubagentPreset[] = [];
	try {
		const files = fs.readdirSync(presetsDir);
		for (const file of files) {
			if (!file.endsWith(".md")) continue;
			try {
				const content = fs.readFileSync(path.join(presetsDir, file), "utf-8");
				const { meta, body } = parseFrontmatter(content);

				const name = meta.name as string;
				if (!name) continue;

				presets.push({
					name,
					description: (meta.description as string) || undefined,
					systemPrompt: body || undefined,
					thinkingLevel: (meta.thinkingLevel as string) || undefined,
					inheritSystemPrompt: meta.inheritSystemPrompt === "false" ? false : undefined,
					tools: Array.isArray(meta.tools) ? meta.tools as string[] : undefined,
					excludeTools: Array.isArray(meta.excludeTools) ? meta.excludeTools as string[] : undefined,
					noBuiltinTools: meta.noBuiltinTools === "true" ? true : undefined,
				});
			} catch {
				// Skip malformed files
			}
		}
	} catch {
		// Presets directory doesn't exist or can't be read
	}
	return presets;
}

// Will be populated at startup
let builtinPresets: SubagentPreset[] = [];

// ---------------------------------------------------------------------------
// Extension entry point
// -------------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
	const state: SubagentState = {
		maxThinkingLevel: "off",
		maxParallel: 0,
		seenRunIds: [],
		presets: [],
	};

	// Module-level progress tracking
	let activeSubagents = 0;
	let completedSubagents = 0;
	let failedSubagents = 0;
	let unseenSubagents = 0;

	// Per-subagent live state for the monitor dashboard
	const subagentSessions = new Map<string, LiveSubagent>();

	function registerLiveSubagent(id: string, data: Omit<LiveSubagent, "liveOutput" | "usage">) {
		subagentSessions.set(id, { ...data, liveOutput: "", usage: { input: 0, output: 0 } });
	}

	function updateLiveSubagent(id: string, output: string, input: number, output_: number) {
		const s = subagentSessions.get(id);
		if (s) {
			s.liveOutput = output;
			s.usage = { input, output: output_ };
		}
	}

	function finalizeLiveSubagent(id: string, status: "done" | "failed") {
		const s = subagentSessions.get(id);
		if (s) {
			// Keep for the 3-second reset window, then clean up
			setTimeout(() => subagentSessions.delete(id), STATUS_RESET_DELAY_MS);
		}
	}

	// Background subagent tracking (herdr integration)
	const backgroundSubagents = new Map<string, BackgroundSubagent>();
	let backgroundSubagentCount = 0;

	function isHerdrEnv(): boolean {
		return process.env.HERDR_ENV === "1";
	}

	function execHerdr(args: string[], cwd: string): string {
		try {
			return require("child_process").execSync(`herdr ${args.join(" ")}`, {
				cwd,
				encoding: "utf-8",
				timeout: 10000,
				env: { ...process.env },
			}).trim();
		} catch (err) {
			throw new Error(`herdr command failed: ${(err as Error).message}`);
		}
	}

	async function spawnBackgroundSubagent(
		task: string,
		label: string | undefined,
		model: { provider: string; id: string },
		thinkingLevel: ThinkingLevel,
		systemPrompt: string,
		cwd: string,
		toolOptions: SubagentToolOptions | undefined,
		timeout: number | undefined,
	): Promise<{ paneId: string; outputFile: string; doneFile: string }> {
		// Split a new pane without stealing focus
		const splitResult = execHerdr(["pane", "split", "--direction", "right", "--no-focus", "--format", "json"], cwd);
		const splitJson = JSON.parse(splitResult);
		const paneId = splitJson.result?.pane?.paneId;
		if (!paneId) throw new Error("Failed to get pane ID from herdr split");

		// Prepare temp files for output
		const bgDir = path.join(cwd, ".pi", "subagent-bg");
		await fs.promises.mkdir(bgDir, { recursive: true });
		const id = crypto.randomUUID().slice(0, 8);
		const outputFile = path.join(bgDir, `${id}.jsonl`);
		const doneFile = path.join(bgDir, `${id}.done`);

		// Build the pi command with output redirection
		const args = buildSubagentArgs(model, thinkingLevel, toolOptions);
		if (systemPrompt.trim()) {
			const tmp = await writeToTempFile(cwd, "bg-system", systemPrompt);
			args.push("--append-system-prompt", tmp.filePath);
			// Note: we don't clean up the temp file here since the background process needs it
		}
		args.push(task);

		const invocation = getPiInvocation(args);
		const cmd = `${invocation.command} ${invocation.args.join(" ")} > "${outputFile}" 2>&1; echo done > "${doneFile}"`;

		// Run in the new pane
		execHerdr(["pane", "run", paneId, JSON.stringify(cmd)], cwd);

		// Track the background subagent
		backgroundSubagents.set(id, {
			paneId,
			task,
			label,
			model: `${model.provider}/${model.id}`,
			thinkingLevel,
			startedAt: Date.now(),
			outputFile,
			doneFile,
			cwd,
		});
		backgroundSubagentCount++;

		return { paneId: id, outputFile, doneFile };
	}

	async function readBackgroundResult(bg: BackgroundSubagent): Promise<SubagentResult> {
		const result: SubagentResult = {
			messages: [],
			usage: { ...EMPTY_USAGE },
			exitCode: 0,
			stderr: "",
		};n
		try {
			const content = await fs.promises.readFile(bg.outputFile, "utf-8");
			const lines = content.split("\n");
			for (const line of lines) {
				parseSubagentLine(line, result, undefined);
			}
			result.exitCode = result.stopReason === "error" || result.stopReason === "aborted" ? 1 : 0;
		} catch (err) {
			result.exitCode = 1;
			result.stderr = `Failed to read output: ${(err as Error).message}`;
			result.errorMessage = result.stderr;
		}
		return result;
	}

	function isBackgroundDone(id: string): boolean {
		const bg = backgroundSubagents.get(id);
		if (!bg) return false;
		try {
			fs.accessSync(bg.doneFile);
			return true;
		} catch {
			return false;
		}
	}

	async function cleanupBackground(id: string) {
		const bg = backgroundSubagents.get(id);
		if (!bg) return;
		try { await fs.promises.unlink(bg.doneFile); } catch { /* ignore */ }
		try { await fs.promises.unlink(bg.outputFile); } catch { /* ignore */ }
		backgroundSubagents.delete(id);
	}

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
		if (backgroundSubagentCount > 0) parts.push(`${backgroundSubagentCount} background`);
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
			presets: state.presets,
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
	// Preset management
	// -----------------------------------------------------------------------

	function getPreset(name: string): SubagentPreset | undefined {
		// Built-in presets take precedence
		return builtinPresets.find((p) => p.name === name) || state.presets.find((p) => p.name === name);
	}

	async function showAddPreset(ctx: ExtensionContext): Promise<void> {
		const name = await ctx.ui.input({ prompt: "Preset name (e.g., read-only-audit):" });
		if (!name?.trim()) return;
		const trimmedName = name.trim();

		if (getPreset(trimmedName)) {
			ctx.ui.notify(`Preset "${trimmedName}" already exists. Use a different name.`, "error");
			return;
		}

		const description = await ctx.ui.input({ prompt: "Description (optional):" });

		// Thinking level selector
		const thinkingItems: SelectItem[] = [
			{ value: "", label: "(not set — use conductor's choice)" },
			...THINKING_LEVELS.map((level) => ({ value: level, label: level })),
		];
		const thinkingResult = await showSelectList(ctx, "Default Thinking Level", thinkingItems, 8);

		// Tool scoping
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

		// Inheritance
		const inheritItems: SelectItem[] = [
			{ value: "true", label: "Inherit system prompt (default)" },
			{ value: "false", label: "No inheritance (standalone)" },
		];
		const inheritResult = await showSelectList(ctx, "System Prompt Inheritance", inheritItems, 3);

		const preset: SubagentPreset = {
			name: trimmedName,
			description: description?.trim() || undefined,
			thinkingLevel: thinkingResult || undefined,
			inheritSystemPrompt: inheritResult === "false" ? false : undefined,
			tools,
			excludeTools,
			noBuiltinTools,
		};

		state.presets.push(preset);
		persistState();
		ctx.ui.notify(`Preset "${trimmedName}" created`, "info");
	}

	async function showRemovePreset(ctx: ExtensionContext): Promise<void> {
		if (state.presets.length === 0) {
			ctx.ui.notify("No custom presets to remove. Built-in presets cannot be removed.", "info");
			return;
		}

		const items: SelectItem[] = state.presets.map((p) => ({
			value: p.name,
			label: p.name,
			description: p.description || formatPresetSummary(p),
		}));

		const result = await showSelectList(ctx, "Remove Preset", items, 10);
		if (!result) return;

		state.presets = state.presets.filter((p) => p.name !== result);
		persistState();
		ctx.ui.notify(`Preset "${result}" removed`, "info");
	}

	function formatPresetSummary(p: SubagentPreset): string {
		const parts: string[] = [];
		if (p.thinkingLevel) parts.push(p.thinkingLevel);
		if (p.tools?.length) parts.push(`tools:${p.tools.join(",")}`);
		if (p.excludeTools?.length) parts.push(`-${p.excludeTools.join(",")}`);
		if (p.noBuiltinTools) parts.push("no-builtins");
		return parts.join(" · ") || "default";
	}

	async function showPresetManager(ctx: ExtensionContext): Promise<void> {
		const builtinItems: SelectItem[] = builtinPresets.map((p) => ({
			value: p.name,
			label: `${p.name}`,
			description: p.description || formatPresetSummary(p),
		}));

		const userItems: SelectItem[] = state.presets.map((p) => ({
			value: p.name,
			label: p.name,
			description: p.description || formatPresetSummary(p),
		}));

		const items: SelectItem[] = [
			...builtinItems,
			...(userItems.length > 0 ? [{ value: "__divider__", label: "\u2500\u2500\u2500 Custom Presets \u2500\u2500\u2500", description: "" }] : []),
			...userItems,
			{ value: "__add__", label: "+ Add Preset", description: "Create a new delegation preset" },
			{ value: "__remove__", label: "- Remove Preset", description: "Delete a custom preset" },
		];

		const result = await showSelectList(ctx, `Presets (${builtinPresets.length} built-in, ${state.presets.length} custom)`, items, 15);
		if (!result || result === "__divider__") return;

		if (result === "__add__") {
			await showAddPreset(ctx);
		} else if (result === "__remove__") {
			await showRemovePreset(ctx);
		} else {
			// Show preset detail
			const preset = getPreset(result);
			if (preset) {
				const isBuiltin = builtinPresets.some((p) => p.name === result);
				await ctx.ui.custom<void>((_tui, theme, _kb, done) => {
					const container = new Container();
					container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
					container.addChild(new Text(
						theme.fg("accent", theme.bold(`Preset: ${preset.name}`)) +
						(isBuiltin ? theme.fg("dim", " (built-in)") : ""),
						1, 0));
					if (preset.description) container.addChild(new Text(theme.fg("dim", preset.description), 1, 0));
					container.addChild(new Text("", 0, 0));
					container.addChild(new Text(theme.fg("dim", `Thinking: ${preset.thinkingLevel || "(not set)"}`), 1, 0));
					container.addChild(new Text(theme.fg("dim", `Inherit: ${preset.inheritSystemPrompt === false ? "no" : "yes (default)"}`), 1, 0));
					if (preset.tools) container.addChild(new Text(theme.fg("dim", `Tools: ${preset.tools.join(", ")}`), 1, 0));
					if (preset.excludeTools) container.addChild(new Text(theme.fg("dim", `Exclude: ${preset.excludeTools.join(", ")}`), 1, 0));
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
			{
				value: "monitor",
				label: "Live Monitor",
				description: "Watch running subagents in real-time",
			},
			{
				value: "preset",
				label: "Manage Presets",
				description: `${builtinPresets.length} built-in, ${state.presets.length} custom`,
			},
			{
				value: "retry",
				label: "Retry Failed Run",
				description: "Select a failed subagent to retry",
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
	// Live monitor dashboard
	// -----------------------------------------------------------------------

	async function showMonitor(ctx: ExtensionContext): Promise<void> {
		if (subagentSessions.size === 0) {
			ctx.ui.notify("No subagents are currently running. Delegate a task to see live activity.", "info");
			return;
		}

		await ctx.ui.custom<void>((tui, theme, _kb, done) => {
			const buildView = () => {
				const container = new Container();
				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				container.addChild(new Text(
					theme.fg("accent", theme.bold(`Subagent Monitor (${subagentSessions.size} active)`)), 1, 0));
				container.addChild(new Text(theme.fg("dim", "\u2193 next \u2022 enter inspect \u2022 esc close"), 1, 0));
				container.addChild(new Text("", 0, 0));

				let idx = 0;
				for (const [id, s] of subagentSessions) {
					const elapsed = Math.round((Date.now() - s.startedAt) / 1000);
					const elapsedStr = elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
					const name = s.label || s.task.slice(0, 40);
					const spinner = ["\u280B", "\u2819", "\u2839", "\u2838", "\u283C", "\u2834", "\u2826", "\u2827", "\u2807", "\u280F"][Math.floor(Date.now() / 150) % 10];

					container.addChild(new Text(
						theme.fg("accent", `${spinner} ${name}`) +
						theme.fg("dim", `  \u2191${formatTokens(s.usage.input)} \u2193${formatTokens(s.usage.output)}  ${elapsedStr}`),
						1, 0));
					container.addChild(new Text(
						theme.fg("muted", `   ${s.thinkingLevel} \u00b7 ${s.model.split("/").pop() || s.model}`),
						1, 0));

					if (s.liveOutput) {
						const lastLine = s.liveOutput.split("\n").filter(Boolean).pop() || "";
						if (lastLine) {
							container.addChild(new Text(
								theme.fg("toolOutput", `   ${lastLine.slice(0, 60)}`),
								1, 0));
						}
					}

					idx++;
					if (idx < subagentSessions.size) container.addChild(new Text("", 0, 0));
				}

				container.addChild(new DynamicBorder((s: string) => theme.fg("accent", s)));
				return container;
			};

			const interval = setInterval(() => tui.requestRender(), 200);
			const cleanup = () => clearInterval(interval);

			return {
				render: (w: number) => buildView().render(w),
				invalidate: () => {},
				handleInput: (_data: string) => { cleanup(); done(); },
			};
		});
	}

	// -----------------------------------------------------------------------
	// Retry menu
	// -----------------------------------------------------------------------

	async function showRetryMenu(ctx: ExtensionContext): Promise<void> {
		const entries = ctx.sessionManager.getEntries();
		const failedRuns = entries
			.filter((e: { type: string; customType?: string }) =>
				e.type === "custom" && e.customType === "brl-subagent-run",
			)
			.map((e: { data?: SubagentRun }) => e.data!)
			.filter((r: SubagentRun | undefined) => r && r.status === "failed")
			.reverse();

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
			`Ask the LLM to retry: \"Use delegate_task to retry failed run ${selectedId.slice(0, 8)}...\"`,
			"info",
		);
	}

	// -----------------------------------------------------------------------
	// /brl-subagent command
	// -----------------------------------------------------------------------

	pi.registerCommand("brl-subagent", {
		description: "Configure subagent model and thinking level",
		getArgumentCompletions: (prefix: string) => {
			const options = ["model", "thinking", "concurrency", "reset", "history", "monitor", "preset", "retry"];
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
			} else if (trimmed === "monitor") {
				await showMonitor(ctx);
			} else if (trimmed === "preset" || trimmed?.startsWith("preset")) {
				await showPresetManager(ctx);
			} else if (trimmed === "retry") {
				await showRetryMenu(ctx);
			} else {
				await showConfigMenu(ctx);
			}
		},
	});

	// Register keyboard shortcut for live monitor
	pi.registerShortcut("ctrl+shift+o", {
		description: "Open subagent live monitor",
		handler: async (_input, ctx) => {
			await showMonitor(ctx);
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
			preset?: string;
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
		// Resolve preset (if provided) — values become defaults
		const preset = params.preset ? getPreset(params.preset) : undefined;

		// Merge: conductor's explicit values override preset, undefined falls through
		const mergedThinkingLevel = (params.thinkingLevel as ThinkingLevel | undefined) ?? preset?.thinkingLevel;
		const mergedSystemPrompt = params.systemPrompt ?? preset?.systemPrompt;
		const mergedInheritSP = params.inheritSystemPrompt ?? preset?.inheritSystemPrompt;
		const mergedOutputFile = params.outputFile ?? preset?.outputFile;
		const mergedTimeout = params.timeout ?? preset?.timeout;
		const mergedTools = params.tools ?? preset?.tools;
		const mergedExcludeTools = params.excludeTools ?? preset?.excludeTools;
		const mergedNoBuiltinTools = params.noBuiltinTools ?? preset?.noBuiltinTools;

		const thinkingLevel = resolveThinkingLevel(
			mergedThinkingLevel,
			state.maxThinkingLevel,
		);

		const toolOptions: SubagentToolOptions | undefined =
			mergedTools || mergedExcludeTools || mergedNoBuiltinTools
				? { tools: mergedTools, excludeTools: mergedExcludeTools, noBuiltinTools: mergedNoBuiltinTools }
				: undefined;

		return {
			task: params.task,
			label: params.label?.trim() || undefined,
			inheritSP: mergedInheritSP !== false,
			customSP: mergedSystemPrompt,
			outputFile: mergedOutputFile,
			timeout: mergedTimeout,
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
			"Set thinkingLevel per call to match task complexity. The level is capped at the user's configured maximum. Map tasks to levels using this heuristic: off = file listing, grep, simple read. minimal = file diff, syntax check, find-and-replace. low = refactoring, test generation, documentation. medium = default — code review, debugging, moderate analysis. high = security audit, architecture review, complex debugging. xhigh = multi-step causal reasoning, research, novel problem solving. Default to 'off' or 'minimal' for trivial tasks — do not waste the user's budget.",
			"Use outputFile to have the subagent write full findings to disk and return only a structured summary — saves context tokens for large investigations.",
			"Set timeout (in ms) to limit how long a subagent can run. Useful for tasks that might hang or get stuck.",
			"Set cwd to override the subagent's working directory. Defaults to the current project directory.",
			"Set label to give the subagent a human-readable name (e.g., 'security-audit' or 'docs-review'). Labels appear in the status bar and tool call display.",
			"Use preset to apply a delegation configuration (built-in or custom via /brl-subagent preset). Preset values are defaults — explicit parameters override them. Built-in presets: code-reviewer, security-auditor, test-engineer, tech-writer, rapid-prototyper, debugger, refactorer, data-analyst.",
			"To retry a failed subagent, pass its run ID as retryRunId. The retried run uses the same task and parameters as the original. Explicit parameters on this call override the original's. Use /brl-subagent retry to browse failed runs and get their IDs.",
			"Set retryOnTimeout: true to automatically retry a subagent that times out. Only retries once — the second timeout is treated as a final failure.",
			"Set background: true to run the subagent in a background herdr pane (requires HERDR_ENV=1). The tool returns immediately with a subagent ID. Use check_subagent to wait for and retrieve the result. This enables true background execution — the conductor is not blocked while the subagent runs.",
			"When running inside herdr (HERDR_ENV=1), background execution is the default. Set background: false to force foreground execution if you need the result immediately.",
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
			preset: Type.Optional(
				Type.String({
					description:
						"Name of a saved delegation preset (created via /brl-subagent preset). " +
						"Preset values are used as defaults; explicit parameters on this call override them.",
				}),
			),
			retryRunId: Type.Optional(
				Type.String({
					description:
						"ID of a previously failed subagent run to retry. " +
						"The retried run uses the same task and parameters as the original. " +
						"Only works with runs that ended in failure (exitCode != 0, timeout, error, or abort). " +
						"Explicit parameters on this call override the original's.",
				}),
			),
			retryOnTimeout: Type.Optional(
				Type.Boolean({
					description:
						"If true and the subagent times out, automatically retry with the same parameters. " +
						"Only retries once — the second timeout is treated as a final failure.",
				}),
			),
			background: Type.Optional(
				Type.Boolean({
					description:
						"Run the subagent in a background herdr pane (requires HERDR_ENV=1). " +
						"When running inside herdr, background is the default — the conductor is not blocked. " +
						"Set to false to force foreground execution. " +
						"Returns immediately with a subagent ID. Use check_subagent to wait for and retrieve the result.",
				}),
			),
		}),

		async execute(
			_toolCallId: string,
			params: {
				task: string;
				label?: string;
				preset?: string;
				systemPrompt?: string;
				inheritSystemPrompt?: boolean;
				thinkingLevel?: string;
				outputFile?: string;
				timeout?: number;
				cwd?: string;
				tools?: string[];
				excludeTools?: string[];
				noBuiltinTools?: boolean;
				retryRunId?: string;
				retryOnTimeout?: boolean;
				background?: boolean;
			},
			signal: AbortSignal | undefined,
			onUpdate: ((partial: AgentToolResult<SubagentResult>) => void) | undefined,
			ctx: ExtensionContext,
		) {
			// Handle retryRunId — look up original run and merge params
			if (params.retryRunId) {
				const entries = ctx.sessionManager.getEntries();
				const runEntry = entries
					.filter((e: { type: string; customType?: string }) =>
						e.type === "custom" && e.customType === "brl-subagent-run",
					)
					.map((e: { data?: SubagentRun }) => e.data!)
					.find((r: SubagentRun | undefined) => r?.id === params.retryRunId);

				if (runEntry) {
					const orig = runEntry.originalParams;
					params = {
						task: params.task || runEntry.task,
						label: params.label ?? runEntry.label,
						preset: params.preset ?? orig?.preset,
						systemPrompt: params.systemPrompt ?? orig?.systemPrompt,
						inheritSystemPrompt: params.inheritSystemPrompt ?? orig?.inheritSystemPrompt,
						thinkingLevel: params.thinkingLevel ?? orig?.thinkingLevel,
						outputFile: params.outputFile ?? orig?.outputFile,
						timeout: params.timeout ?? orig?.timeout,
						cwd: params.cwd ?? orig?.cwd,
						tools: params.tools ?? orig?.tools,
						excludeTools: params.excludeTools ?? orig?.excludeTools,
						noBuiltinTools: params.noBuiltinTools ?? orig?.noBuiltinTools,
						retryOnTimeout: params.retryOnTimeout,
					};
				}
			}

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
				originalParams: {
					systemPrompt: params.systemPrompt,
					inheritSystemPrompt: params.inheritSystemPrompt,
					thinkingLevel: params.thinkingLevel,
					outputFile: params.outputFile,
					timeout: params.timeout,
					cwd: params.cwd,
					tools: params.tools,
					excludeTools: params.excludeTools,
					noBuiltinTools: params.noBuiltinTools,
					preset: params.preset,
				},
			};
			persistRun(run);

			// Background mode: spawn in herdr pane and return immediately
			// When running inside herdr, background is the default unless explicitly set to false
			if (isHerdrEnv() && params.background !== false) {
				try {
					const basePrompt = ctx.getSystemPrompt();
					const subagentPrompt = buildSubagentPrompt(basePrompt, inheritSP, customSP, outputFile);
					const bg = await spawnBackgroundSubagent(
						task, label, subagentModel, thinkingLevel, subagentPrompt, effectiveCwd, toolOptions, timeout,
					);

					// Update run record as background
					run.status = "running";
					persistRun(run);

					return {
						content: [{
							type: "text" as const,
							text: `Subagent started in background (id: ${bg.paneId}). Use check_subagent with paneId "${bg.paneId}" to wait for and retrieve the result.`,
						}],
						details: {
							messages: [],
							usage: { ...EMPTY_USAGE },
							exitCode: -1,
							stderr: "",
						},
					};
				} catch (err) {
					return {
						content: [{ type: "text" as const, text: `Failed to start background subagent: ${(err as Error).message}` }],
						isError: true,
					};
				}
			}

			// Register for live monitor dashboard
			registerLiveSubagent(runId, {
				id: runId,
				label,
				task,
				model: run.model,
				thinkingLevel,
				startedAt: Date.now(),
				ctx,
			});

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

				// Wrap onUpdate to feed live monitor
				const liveOnUpdate = onUpdate
					? (partial: AgentToolResult<SubagentResult>) => {
							onUpdate(partial);
							if (partial.details) {
								updateLiveSubagent(
									runId,
									getFinalOutput(partial.details.messages),
									partial.details.usage.input,
									partial.details.usage.output,
								);
							}
						}
					: undefined;

				let result = await runSubagent(
					effectiveCwd,
					subagentPrompt,
					subagentModel,
					thinkingLevel,
					task,
					signal,
					liveOnUpdate,
					toolOptions,
					timeout,
				);

				// Auto-retry on timeout if requested
				if (params.retryOnTimeout && isSubagentError(result) && result.errorMessage?.includes("timed out")) {
					registerLiveSubagent(runId, {
						id: runId,
						label,
						task,
						model: run.model,
						thinkingLevel,
						startedAt: Date.now(),
						ctx,
					});

					onUpdate?.({
						content: [{ type: "text" as const, text: `Retrying after timeout...` }],
						details: { messages: [], usage: { ...EMPTY_USAGE }, exitCode: -1, stderr: "" },
					});

					result = await runSubagent(
						effectiveCwd,
						subagentPrompt,
						subagentModel,
						thinkingLevel,
						task,
						signal,
						liveOnUpdate,
						toolOptions,
						timeout,
					);
				}

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
				run.fullOutput = finalOutput || undefined;
				persistRun(run);

				// Finalize live monitor state
				finalizeLiveSubagent(runId, run.status);

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
	// check_subagent tool (for background subagents)
	// -----------------------------------------------------------------------

	pi.registerTool({
		name: "check_subagent",
		label: "Check Subagent",
		description: [
			"Check on a background subagent's progress or wait for its result.",
			"Use this after delegate_task with background=true to retrieve the subagent's output.",
		].join(" "),
		promptSnippet: "Check on a background subagent and retrieve its result",
		promptGuidelines: [
			"After calling delegate_task with background=true, use check_subagent to wait for and retrieve the result.",
			"The paneId is returned by the background delegate_task call.",
			"By default, check_subagent waits for the subagent to finish before returning. Set wait=false to check progress without blocking.",
		],
		parameters: Type.Object({
			paneId: Type.String({
				description: "The subagent ID returned by a background delegate_task call.",
			}),
			wait: Type.Optional(Type.Boolean({
				description: "Wait for the subagent to complete before returning. Default: true.",
			})),
		}),

		async execute(
			_toolCallId: string,
			params: { paneId: string; wait?: boolean },
			signal: AbortSignal | undefined,
			_onUpdate: ((partial: AgentToolResult<SubagentResult>) => void) | undefined,
			ctx: ExtensionContext,
		) {
			const bg = backgroundSubagents.get(params.paneId);
			if (!bg) {
				return {
					content: [{ type: "text" as const, text: `No background subagent found with ID "${params.paneId}". Use delegate_task with background=true to start one.` }],
					isError: true,
				};
			}

			const shouldWait = params.wait !== false; // default true

			if (shouldWait) {
				// Poll for completion
				const maxWait = 600_000; // 10 minutes max
				const start = Date.now();
				while (!isBackgroundDone(params.paneId) && Date.now() - start < maxWait) {
					if (signal?.aborted) {
						return {
							content: [{ type: "text" as const, text: "Aborted while waiting for background subagent." }],
							isError: true,
						};
					}
					await new Promise((r) => setTimeout(r, 1000));
				}

				if (!isBackgroundDone(params.paneId)) {
					return {
						content: [{ type: "text" as const, text: `Background subagent did not complete within ${maxWait / 1000}s. Check the pane manually: herdr pane read ${bg.paneId}` }],
						isError: true,
					};
				}
			}

			// Read the result
			const result = await readBackgroundResult(bg);
			const finalOutput = getFinalOutput(result.messages);
			const isError = isSubagentError(result);

			// Update run record
			const runEntries = ctx.sessionManager.getEntries();
			const runEntry = runEntries
				.filter((e: { type: string; customType?: string }) =>
					e.type === "custom" && e.customType === "brl-subagent-run",
				)
				.map((e: { data?: SubagentRun }) => e.data!)
				.find((r: SubagentRun | undefined) => r?.task === bg.task && r?.status === "running");

			if (runEntry) {
				runEntry.status = isError ? "failed" : "done";
				runEntry.finishedAt = new Date().toISOString();
				runEntry.durationMs = Date.now() - bg.startedAt;
				runEntry.cost = result.usage.cost;
				runEntry.tokensIn = result.usage.input;
				runEntry.tokensOut = result.usage.output;
				runEntry.errorMessage = result.errorMessage;
				runEntry.outputSummary = finalOutput.slice(0, 200);
				runEntry.fullOutput = finalOutput || undefined;
				persistRun(runEntry);
			}

			// Cleanup
			backgroundSubagentCount = Math.max(0, backgroundSubagentCount - 1);
			await cleanupBackground(params.paneId);

			if (isError) {
				const errorMsg = result.errorMessage || result.stderr || finalOutput || "(no output from subagent)";
				return {
					content: [{ type: "text" as const, text: `Background subagent failed: ${errorMsg}` }],
					details: result,
					isError: true,
				};
			}

			return {
				content: [{ type: "text" as const, text: finalOutput || "(no output)" }],
				details: result,
			};
		},
	});

	// -----------------------------------------------------------------------
	// Session lifecycle
	// -----------------------------------------------------------------------

	pi.on("session_start", async (_event, ctx) => {
		// Load built-in presets from presets/ directory
		const presetsDir = path.join(__dirname, "..", "presets");
		builtinPresets = loadBuiltinPresets(presetsDir);

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
			if ((stateEntry.data as any).presets) state.presets = (stateEntry.data as any).presets;
		}

		updateStatus(ctx);
	});
}

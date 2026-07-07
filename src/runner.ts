/**
 * brl-subagent — Process Runner
 *
 * Spawns and manages subagent pi processes. Handles:
 * - Process spawning with safe environment (F2)
 * - JSON-line stdout parsing
 * - Usage statistics accumulation
 * - Abort signal and timeout handling
 * - Temp file management
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import type {
	SubagentResult,
	SubagentToolOptions,
	UsageStats,
	ThinkingLevel,
} from "./types";
import type { ProcessPool, ProcessPoolEntry } from "./pool";
import {
	EMPTY_USAGE,
	SIGKILL_GRACE_MS,
	TEMP_FILE_MODE,
	MAX_TEMP_DIR_AGE_MS,
	classifyError,
} from "./types";
import { getSafeEnv, DEPTH_ENV_KEY } from "./sanitize";
import type { Logger } from "./logging";
import type { Intercom } from "./messaging";
import { extractMessages, stripMessageLines, formatPendingMessages } from "./messaging";

// ---------------------------------------------------------------------------
// Multi-turn: question pattern
// ---------------------------------------------------------------------------

/**
 * Pattern matching a clarifying question at the start of the final output.
 * The subagent outputs this when it needs more info from the conductor.
 */
export const QUESTION_PATTERN = /^\[QUESTION\]:(.+)/m;

// ---------------------------------------------------------------------------
// Pi binary resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the pi binary and command-line invocation for subprocess spawning.
 */
export function getPiInvocation(extraArgs: string[]): { command: string; args: string[] } {
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

// ---------------------------------------------------------------------------
// Temp file helpers
// ---------------------------------------------------------------------------

/**
 * Get the subagent temp directory path for a given cwd.
 */
function getTempBaseDir(cwd: string): string {
	return path.join(cwd, ".pi", "subagent-tmp");
}

/**
 * Scan .pi/subagent-tmp/ directory and remove any subdirectories whose mtime
 * is older than maxAgeMs. Returns the count of removed directories.
 * Handles missing directory gracefully (returns 0).
 */
export async function cleanupTempDirs(
	cwd: string,
	maxAgeMs: number = MAX_TEMP_DIR_AGE_MS,
): Promise<number> {
	const baseDir = getTempBaseDir(cwd);
	let removed = 0;

	try {
		const entries = await fs.promises.readdir(baseDir, { withFileTypes: true });
		const now = Date.now();

		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const dirPath = path.join(baseDir, entry.name);
			try {
				const stat = await fs.promises.stat(dirPath);
				if (now - stat.mtimeMs > maxAgeMs) {
					await fs.promises.rm(dirPath, { recursive: true, force: true });
					removed++;
				}
			} catch {
				// Skip entries that disappear during iteration
			}
		}
	} catch {
		// Directory does not exist or is not accessible
	}

	return removed;
}

async function writeToTempFile(
	cwd: string,
	name: string,
	content: string,
): Promise<{ dir: string; filePath: string }> {
	const baseDir = getTempBaseDir(cwd);
	await fs.promises.mkdir(baseDir, { recursive: true });
	const tmpDir = await fs.promises.mkdtemp(path.join(baseDir, `${name}-`));
	const filePath = path.join(tmpDir, `${name}.md`);
	await withFileMutationQueue(filePath, async () => {
		await fs.promises.writeFile(filePath, content, {
			encoding: "utf-8",
			mode: TEMP_FILE_MODE,
		});
	});
	return { dir: tmpDir, filePath };
}

function cleanupTempDir(dir: string, filePath: string): void {
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
// Argument construction
// ---------------------------------------------------------------------------

export function buildSubagentArgs(
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

// ---------------------------------------------------------------------------
// Usage tracking
// ---------------------------------------------------------------------------

export function accumulateUsage(
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

// ---------------------------------------------------------------------------
// Abort handler
// ---------------------------------------------------------------------------

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
// Stdout parsing
// ---------------------------------------------------------------------------

function emitSubagentUpdate(
	result: SubagentResult,
	onUpdate: ((partial: AgentToolResult<SubagentResult>) => void) | undefined,
	getFinalOutputFn: (messages: Array<Record<string, unknown>>) => string,
): void {
	if (!onUpdate) return;
	onUpdate({
		content: [
			{
				type: "text",
				text: getFinalOutputFn(result.messages) || "(running...)",
			},
		],
		details: { ...result },
	});
}

export function parseSubagentLine(
	line: string,
	result: SubagentResult,
	onUpdate: ((partial: AgentToolResult<SubagentResult>) => void) | undefined,
	getFinalOutputFn: (messages: Array<Record<string, unknown>>) => string,
	log?: Logger,
): void {
	if (!line.trim()) return;
	let event: Record<string, unknown>;
	try {
		event = JSON.parse(line) as Record<string, unknown>;
	} catch {
		const snippet = line.trim().slice(0, 200);
		result.stderr += `[parse error] ${snippet}\n`;
		log?.warn("Failed to parse subagent stdout line", { snippet });
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

			log?.debug("Subagent message completed", {
				model: result.model,
				stopReason: result.stopReason,
				tokensIn: result.usage.input,
				tokensOut: result.usage.output,
			});
		}

		emitSubagentUpdate(result, onUpdate, getFinalOutputFn);
	}

	if (event.type === "tool_result_end" && event.message) {
		result.messages.push(event.message as Record<string, unknown>);
		emitSubagentUpdate(result, onUpdate, getFinalOutputFn);
	}
}

// ---------------------------------------------------------------------------
// Process runner
// ---------------------------------------------------------------------------

/**
 * Detect a [QUESTION]: pattern in the final output of a subagent result.
 * Returns the question text if found, otherwise null.
 */
export function detectQuestion(result: SubagentResult, getFinalOutputFn: (messages: Array<Record<string, unknown>>) => string): string | null {
	const output = getFinalOutputFn(result.messages);
	const match = output.match(QUESTION_PATTERN);
	return match ? match[1].trim() : null;
}

export async function runSubagent(
	cwd: string,
	systemPrompt: string,
	model: { provider: string; id: string },
	thinkingLevel: ThinkingLevel,
	task: string,
	signal: AbortSignal | undefined,
	onUpdate: ((partial: AgentToolResult<SubagentResult>) => void) | undefined,
	toolOptions: SubagentToolOptions | undefined,
	timeout: number | undefined,
	getFinalOutputFn: (messages: Array<Record<string, unknown>>) => string,
	log?: Logger,
	depth?: number,
	pool?: ProcessPool,
	maxTurns?: number,
	onQuestion?: (question: string, turn: number, maxTurns: number) => Promise<string | null>,
	intercom?: Intercom,
	subagentId?: string,
	backend?: Backend,
): Promise<SubagentResult> {
	const effectiveMaxTurns = Math.max(1, maxTurns ?? 1);

	// E8: Pluggable backend routing
	if (backend && backend.name !== "pi") {
		log?.info("Using non-pi backend", { backend: backend.name, model: `${model.provider}/${model.id}` });
		return backend.execute(task, `${model.provider}/${model.id}`, thinkingLevel, signal);
	}

	// Accumulate context from previous Q&A turns
	const previousAnswers: string[] = [];

	for (let turn = 0; turn < effectiveMaxTurns; turn++) {
		// Build the effective system prompt for this turn
		let effectivePrompt = systemPrompt;
		if (previousAnswers.length > 0) {
			effectivePrompt += "\n\nAdditional context from the conductor:\n" + previousAnswers.join("\n\n");
		}

		// E10: Inject pending intercom messages into the task prompt
	let effectiveTask = task;
	if (intercom && subagentId && intercom.hasMessages(subagentId)) {
		const pending = intercom.receiveAndClear(subagentId);
		if (pending.length > 0) {
			const msgBlock = formatPendingMessages(pending);
			effectiveTask += `

Pending messages from other subagents:
${msgBlock}`;
			log?.debug("Injected pending intercom messages", { subagentId, count: pending.length });
		}
	}

	// E11: Try pool first if provided (only on first turn)
		if (pool && turn === 0) {
			const modelStr = `${model.provider}/${model.id}`;
			const poolEntry = await pool.acquire(cwd, modelStr, thinkingLevel);
			if (poolEntry) {
				log?.debug("Using pool process for subagent", {
					pid: poolEntry.process.pid,
					model: modelStr,
					thinkingLevel,
				});
				try {
					const result = await pool.sendTask(poolEntry, task, timeout, onUpdate as never, getFinalOutputFn);
					return result;
				} catch (err) {
					log?.warn("Pool sendTask failed, falling back to fresh spawn", {
						error: (err as Error).message,
					});
				} finally {
					pool.release(poolEntry);
				}
			}
			log?.debug("Pool acquire returned null, using fresh spawn");
		}

		const args = buildSubagentArgs(model, thinkingLevel, toolOptions);

		let tmpDir: string | null = null;
		let tmpFilePath: string | null = null;

		if (effectivePrompt.trim()) {
			const tmp = await writeToTempFile(cwd, "system", effectivePrompt);
			tmpDir = tmp.dir;
			tmpFilePath = tmp.filePath;
			args.push("--append-system-prompt", tmpFilePath);
		}

		// Pass the effective task as the prompt argument
		args.push(effectiveTask);

		const result: SubagentResult = {
			messages: [],
			usage: { ...EMPTY_USAGE },
			exitCode: 0,
			stderr: "",
		};

		log?.info("Starting subagent process", {
			model: `${model.provider}/${model.id}`,
			thinkingLevel,
			cwd,
			taskPreview: task.slice(0, 80),
			hasSystemPrompt: effectivePrompt.trim().length > 0,
			timeout,
			turn: turn + 1,
			maxTurns: effectiveMaxTurns,
		});

		try {
			const exitCode = await new Promise<number>((resolve) => {
				const invocation = getPiInvocation(args);
				const subDepth = depth !== undefined ? depth : undefined;
				const envOverrides: Record<string, string> | undefined =
					subDepth !== undefined ? { [DEPTH_ENV_KEY]: String(subDepth) } : undefined;
				const proc = spawn(invocation.command, invocation.args, {
					cwd,
					shell: false,
					stdio: ["ignore", "pipe", "pipe"],
					env: getSafeEnv(envOverrides), // F2: Environment isolation + depth tracking
				});

				let buffer = "";

				proc.stdout.on("data", (data: Buffer) => {
					buffer += data.toString();
					const lines = buffer.split("\n");
					buffer = lines.pop() ?? "";
					for (const line of lines) {
						parseSubagentLine(line, result, onUpdate, getFinalOutputFn, log);
					}
				});

				proc.stderr.on("data", (data: Buffer) => {
					result.stderr += data.toString();
				});

				proc.on("close", (code) => {
					if (buffer.trim()) {
						parseSubagentLine(buffer, result, onUpdate, getFinalOutputFn, log);
					}
					log?.info("Subagent process exited", { exitCode: code, pid: proc.pid });
					resolve(code ?? 0);
				});

				proc.on("error", (err) => {
					result.errorMessage = `Subprocess error: ${err.message}`;
					result.stderr += err.message;
					log?.error("Subagent process error", { error: err.message });
					resolve(1);
				});

				if (signal) {
					attachAbortHandler(proc, signal);
				}

				if (timeout && timeout > 0) {
					const timer = setTimeout(() => {
						result.errorMessage = `Subagent timed out after ${timeout}ms`;
						log?.warn("Subagent timed out", { timeout, pid: proc.pid });
						proc.kill("SIGTERM");
						setTimeout(() => {
							if (!proc.killed) proc.kill("SIGKILL");
						}, SIGKILL_GRACE_MS);
					}, timeout);
					proc.on("close", () => clearTimeout(timer));
				}
			});

			result.exitCode = exitCode;
			result.errorCategory = classifyError(result);
		} finally {
			if (tmpDir && tmpFilePath) {
				cleanupTempDir(tmpDir, tmpFilePath);
			}
		}

		// Check for [QUESTION]: pattern in the output
		const question = detectQuestion(result, getFinalOutputFn);
		if (question && turn < effectiveMaxTurns - 1 && onQuestion) {
			log?.debug("Subagent asked a clarifying question", {
				question: question.slice(0, 100),
				turn: turn + 1,
				maxTurns: effectiveMaxTurns,
			});

			const answer = await onQuestion(question, turn + 1, effectiveMaxTurns);
			if (answer === null) {
				log?.debug("User cancelled multi-turn (returned null)");
				return result;
			}

			previousAnswers.push(`Question (turn ${turn + 1}): ${question}\nAnswer: ${answer}`);
			continue;
		}

		// E10: Extract outgoing intercom messages from output
		if (intercom && subagentId) {
			const finalOutput = getFinalOutputFn(result.messages);
			const outgoing = extractMessages(finalOutput);
			for (const msg of outgoing) {
				if (msg.target === "*") {
					intercom.broadcast(subagentId, msg.content);
				} else {
					intercom.send(subagentId, msg.target, msg.content);
				}
			}
			if (outgoing.length > 0) {
				log?.debug("Extracted outgoing intercom messages", { subagentId, count: outgoing.length });
			}
		}

		return result;
	}

	// Should not reach here, but return last result as fallback
	const fallbackResult: SubagentResult = {
		messages: [],
		usage: { ...EMPTY_USAGE },
		exitCode: 0,
		stderr: "",
	};
	return fallbackResult;
}

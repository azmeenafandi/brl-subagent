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
import type { ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import type { AgentToolResult } from "@earendil-works/pi-agent-core";
import { withFileMutationQueue } from "@earendil-works/pi-coding-agent";
import { wrapTask } from "./prompt";
import type {
	SubagentResult,
	SubagentToolOptions,
	UsageStats,
	ThinkingLevel,
} from "./types";
import {
	EMPTY_USAGE,
	SIGKILL_GRACE_MS,
	TEMP_FILE_MODE,
	MAX_TEMP_DIR_AGE_MS,
	classifyError,
} from "./types";
import { getSafeEnv, DEPTH_ENV_KEY, sanitizeErrorMessage } from "./sanitize";
import type { Logger } from "./logging";
import type { Intercom } from "./messaging";
import { extractMessages, stripMessageLines, formatPendingMessages } from "./messaging";
import type {
	TranscriptMessage,
	TranscriptContentBlock,
	TranscriptToolCallBlock,
} from "./transcript-tail";
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
	proc: ChildProcess,
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

// ---------------------------------------------------------------------------
// Live transcript capture (issue #105 — foreground drill-in parity)
// ---------------------------------------------------------------------------

/**
 * Foreground subagents stream thinking/text/toolCall deltas via `message_update`
 * JSONL events. Previously discarded, these are now accumulated into a live
 * transcript tail (`result.liveTranscript`) that the drill-in overlay renders —
 * parity with the background path's `_sessionRef` transcript.
 *
 * Event shapes EMPIRICALLY VERIFIED (pi 0.84.2 probe runs):
 *   { "type": "message_update", "usage": {...},
 *     "assistantMessageEvent": { "type": "text_delta", "contentIndex": 0, "delta": "PRO" } }
 *   text/thinking: *_start {contentIndex} · *_delta {contentIndex, delta} ·
 *                  *_end {contentIndex, content}
 *   toolcall:      toolcall_start {contentIndex} · toolcall_delta {contentIndex,
 *                  delta = partial args JSON} · toolcall_end {contentIndex,
 *                  toolCall: { name, arguments }}
 */

/** Tail cap: keep at most this many transcript messages per run. */
export const LIVE_TRANSCRIPT_MAX_MESSAGES = 40;
/** Approximate byte budget for the captured transcript tail. */
export const LIVE_TRANSCRIPT_MAX_BYTES = 64 * 1024;
/** Min interval between throttled live updates (~5/sec; the drill-in ticks at 200ms). */
export const LIVE_UPDATE_MIN_INTERVAL_MS = 200;

type LiveBlockKind = "text" | "thinking" | "toolCall";

/** Per-result streaming-accumulation state (keyed by the result object). */
interface LiveTranscriptBuilder {
	/** Completed messages + the in-flight assistant message (last element). */
	messages: TranscriptMessage[];
	/** Approximate byte cost of `messages` (recomputed at block boundaries). */
	bytes: number;
	/** True while an assistant message is being streamed (not yet finalized). */
	streamingOpen: boolean;
	/** Timestamp of the last emitted live update (throttle). */
	lastEmit: number;
}

const liveBuilders = new WeakMap<SubagentResult, LiveTranscriptBuilder>();

function getLiveBuilder(result: SubagentResult): LiveTranscriptBuilder {
	let builder = liveBuilders.get(result);
	if (!builder) {
		builder = {
			messages: [],
			bytes: 0,
			streamingOpen: false,
			lastEmit: 0,
		};
		liveBuilders.set(result, builder);
	}
	return builder;
}

/**
 * Convert an authoritative `message_end` message into the transcript shape the
 * drill-in planner understands (role + content blocks of text/thinking/toolCall).
 */
export function toTranscriptMessage(msg: Record<string, unknown>): TranscriptMessage {
	const role = typeof msg.role === "string" ? msg.role : undefined;
	const toolName = typeof msg.toolName === "string" ? msg.toolName : undefined;
	const content = Array.isArray(msg.content) ? msg.content : undefined;
	if (!content) {
		return { role, ...(toolName ? { toolName } : {}) };
	}
	const blocks: TranscriptContentBlock[] = [];
	for (const part of content) {
		if (!part || typeof part !== "object") continue;
		const p = part as Record<string, unknown>;
		if (p.type === "text" && typeof p.text === "string") {
			blocks.push({ type: "text", text: p.text });
		} else if (p.type === "thinking" && typeof p.thinking === "string") {
			blocks.push({ type: "thinking", thinking: p.thinking });
		} else if (p.type === "toolCall") {
			blocks.push({
				type: "toolCall",
				name: typeof p.name === "string" ? p.name : undefined,
				arguments: p.arguments,
			});
		}
	}
	return { role, content: blocks, ...(toolName ? { toolName } : {}) };
}

/** Serialized size of one transcript message (same accounting as recomputeLiveBytes). */
function messageSize(m: TranscriptMessage): number {
	try {
		return JSON.stringify(m)?.length ?? 0;
	} catch {
		/* non-serializable block — ignore */
		return 0;
	}
}

function recomputeLiveBytes(builder: LiveTranscriptBuilder): void {
	let total = 0;
	for (const m of builder.messages) {
		total += messageSize(m);
	}
	builder.bytes = total;
}

/** Enforce the ring-buffer tail cap — oldest messages dropped, in-flight kept. */
function trimLiveTranscript(builder: LiveTranscriptBuilder): void {
	while (
		builder.messages.length > LIVE_TRANSCRIPT_MAX_MESSAGES &&
		builder.messages.length > 1
	) {
		builder.messages.shift();
	}
	while (builder.bytes > LIVE_TRANSCRIPT_MAX_BYTES && builder.messages.length > 1) {
		// Review R1: the byte budget must shrink as messages drop — the OLD code
		// re-read builder.bytes (never decremented), so once over the cap it kept
		// shifting until messages.length === 1, collapsing the drill-in to the
		// last message only (reproduced: 8×~10KB → length 3, ~10KB kept).
		const dropped = builder.messages.shift();
		if (dropped) builder.bytes -= messageSize(dropped);
	}
	recomputeLiveBytes(builder);
}

/** Return the in-flight assistant message, creating a new one if needed. */
function ensureInFlightAssistant(builder: LiveTranscriptBuilder): TranscriptMessage {
	const last = builder.messages[builder.messages.length - 1];
	if (last && last.role === "assistant" && builder.streamingOpen) {
		return last;
	}
	builder.streamingOpen = true;
	const msg: TranscriptMessage = { role: "assistant", content: [] };
	builder.messages.push(msg);
	return msg;
}

/**
 * Get (or create) the block at `contentIndex` of the in-flight assistant
 * message. Placeholders fill gaps so arbitrary contentIndex order works; the
 * drill-in planner skips empty placeholder blocks.
 */
function getOrCreateBlock(
	builder: LiveTranscriptBuilder,
	index: number,
	kind: LiveBlockKind,
): TranscriptContentBlock {
	const msg = ensureInFlightAssistant(builder);
	if (!Array.isArray(msg.content)) msg.content = [];
	const content = msg.content as TranscriptContentBlock[];
	while (content.length <= index) {
		content.push({ type: "thinking", thinking: "" });
	}
	const existing = content[index];
	const wantType = kind === "toolCall" ? "toolCall" : kind;
	if (!existing || typeof existing !== "object" || existing.type !== wantType) {
		const block: TranscriptContentBlock =
			kind === "toolCall"
				? { type: "toolCall", name: "", arguments: "" }
				: kind === "text"
					? { type: "text", text: "" }
					: { type: "thinking", thinking: "" };
		content[index] = block;
		return block;
	}
	return existing;
}

/** Append `delta` to a text/thinking block field; returns the added chars. */
function appendDeltaText(
	block: TranscriptContentBlock,
	field: "text" | "thinking",
	delta: string,
): number {
	const rec = block as unknown as Record<string, unknown>;
	const prev = typeof rec[field] === "string" ? (rec[field] as string) : "";
	rec[field] = prev + delta;
	return delta.length;
}

/** Replace a text/thinking block field with the authoritative `content`. */
function setDeltaContent(
	block: TranscriptContentBlock,
	field: "text" | "thinking",
	content: string,
): number {
	const rec = block as unknown as Record<string, unknown>;
	const prev = typeof rec[field] === "string" ? (rec[field] as string) : "";
	rec[field] = content;
	return content.length - prev.length;
}

/**
 * Throttled live-transcript emission. Block boundaries (start/end) force an
 * update; mid-block deltas are throttled to ~5/sec — the drill-in monitor
 * re-reads state at a 200ms tick, so per-delta emissions would be wasteful
 * and would flood the conductor's update channel.
 */
function emitLiveUpdate(
	result: SubagentResult,
	onUpdate: ((partial: AgentToolResult<SubagentResult>) => void) | undefined,
	getFinalOutputFn: (messages: Array<Record<string, unknown>>) => string,
	builder: LiveTranscriptBuilder,
	force: boolean,
): void {
	if (!onUpdate) return;
	const now = Date.now();
	if (!force && now - builder.lastEmit < LIVE_UPDATE_MIN_INTERVAL_MS) return;
	builder.lastEmit = now;
	result.liveTranscript = builder.messages;
	emitSubagentUpdate(result, onUpdate, getFinalOutputFn);
}

/**
 * Handle one `message_update` JSONL event: apply the delta to the in-flight
 * assistant message and (throttled) emit a live update.
 */
function handleMessageUpdate(
	event: Record<string, unknown>,
	result: SubagentResult,
	onUpdate: ((partial: AgentToolResult<SubagentResult>) => void) | undefined,
	getFinalOutputFn: (messages: Array<Record<string, unknown>>) => string,
): void {
	const deltaEvent = event.assistantMessageEvent as Record<string, unknown> | undefined;
	if (!deltaEvent || typeof deltaEvent.type !== "string") return;

	const type = deltaEvent.type;
	const index =
		typeof deltaEvent.contentIndex === "number" ? deltaEvent.contentIndex : 0;
	const builder = getLiveBuilder(result);

	switch (type) {
		case "text_start":
		case "thinking_start":
		case "toolcall_start": {
			const kind: LiveBlockKind =
				type === "text_start"
					? "text"
					: type === "thinking_start"
						? "thinking"
						: "toolCall";
			getOrCreateBlock(builder, index, kind);
			emitLiveUpdate(result, onUpdate, getFinalOutputFn, builder, true);
			return;
		}
		case "text_delta":
		case "thinking_delta": {
			if (typeof deltaEvent.delta !== "string" || deltaEvent.delta === "") return;
			const block = getOrCreateBlock(
				builder,
				index,
				type === "text_delta" ? "text" : "thinking",
			);
			builder.bytes += appendDeltaText(
				block,
				type === "text_delta" ? "text" : "thinking",
				deltaEvent.delta,
			);
			emitLiveUpdate(result, onUpdate, getFinalOutputFn, builder, false);
			return;
		}
		case "text_end":
		case "thinking_end": {
			if (typeof deltaEvent.content !== "string") return;
			const block = getOrCreateBlock(
				builder,
				index,
				type === "text_end" ? "text" : "thinking",
			);
			builder.bytes += setDeltaContent(
				block,
				type === "text_end" ? "text" : "thinking",
				deltaEvent.content,
			);
			emitLiveUpdate(result, onUpdate, getFinalOutputFn, builder, true);
			return;
		}
		case "toolcall_delta": {
			// Empirically: `delta` carries PARTIAL JSON of the tool arguments.
			if (typeof deltaEvent.delta !== "string" || deltaEvent.delta === "") return;
			const block = getOrCreateBlock(builder, index, "toolCall") as TranscriptToolCallBlock;
			const prev = typeof block.arguments === "string" ? block.arguments : "";
			block.arguments = prev + deltaEvent.delta;
			builder.bytes += deltaEvent.delta.length;
			emitLiveUpdate(result, onUpdate, getFinalOutputFn, builder, false);
			return;
		}
		case "toolcall_end": {
			// Empirically: carries the FULL ToolCall — name + parsed arguments.
			const block = getOrCreateBlock(builder, index, "toolCall") as TranscriptToolCallBlock;
			const toolCall = deltaEvent.toolCall as Record<string, unknown> | undefined;
			if (block && toolCall) {
				if (typeof toolCall.name === "string") block.name = toolCall.name;
				if (toolCall.arguments !== undefined) {
					const prevLen = typeof block.arguments === "string" ? block.arguments.length : 0;
					let newLen = 0;
					try {
						newLen = JSON.stringify(toolCall.arguments)?.length ?? 0;
					} catch {
						newLen = 0;
					}
					builder.bytes += newLen - prevLen;
					block.arguments = toolCall.arguments;
				}
			}
			emitLiveUpdate(result, onUpdate, getFinalOutputFn, builder, true);
			return;
		}
	}
}

/**
 * On assistant `message_end`: replace the delta-built in-flight message with
 * the authoritative message (deltas may have missed trailing blocks), then
 * enforce the tail caps. Purely additive — existing message_end semantics
 * (messages/usage/update emission) are untouched.
 */
function finalizeLiveAssistantMessage(
	result: SubagentResult,
	builder: LiveTranscriptBuilder,
	msg: Record<string, unknown>,
): void {
	const authoritative = toTranscriptMessage(msg);
	const last = builder.messages[builder.messages.length - 1];
	if (last && last.role === "assistant" && builder.streamingOpen) {
		builder.messages[builder.messages.length - 1] = authoritative;
	} else {
		builder.messages.push(authoritative);
	}
	builder.streamingOpen = false;
	trimLiveTranscript(builder);
	result.liveTranscript = builder.messages;
}

/** Append a completed non-assistant message (user echo / toolResult). */
function pushLiveTranscriptMessage(
	result: SubagentResult,
	builder: LiveTranscriptBuilder,
	msg: Record<string, unknown>,
): void {
	builder.messages.push(toTranscriptMessage(msg));
	trimLiveTranscript(builder);
	result.liveTranscript = builder.messages;
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

	if (event.type === "message_update") {
		handleMessageUpdate(event, result, onUpdate, getFinalOutputFn);
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

			// Issue #105: sync the live transcript with the authoritative message
			// (replaces the delta-built in-flight assistant message).
			finalizeLiveAssistantMessage(result, getLiveBuilder(result), msg);
		} else {
			// Issue #105: keep the user echo / toolResult in the live transcript.
			pushLiveTranscriptMessage(result, getLiveBuilder(result), msg);
		}

		emitSubagentUpdate(result, onUpdate, getFinalOutputFn);
	}

	if (event.type === "tool_result_end" && event.message) {
		const msg = event.message as Record<string, unknown>;
		result.messages.push(msg);
		// Issue #105: keep the toolResult echo in the live transcript.
		pushLiveTranscriptMessage(result, getLiveBuilder(result), msg);
		emitSubagentUpdate(result, onUpdate, getFinalOutputFn);
	}
}

// ---------------------------------------------------------------------------
// Process runner
// ---------------------------------------------------------------------------

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
	intercom?: Intercom,
	subagentId?: string,
): Promise<SubagentResult> {
	// E10: Inject pending intercom messages into the task prompt
	if (intercom && subagentId && intercom.hasMessages(subagentId)) {
		const pending = intercom.receiveAndClear(subagentId);
		if (pending.length > 0) {
			const msgBlock = formatPendingMessages(pending);
			task += `

Pending messages from other subagents:
${msgBlock}`;
			log?.debug("Injected pending intercom messages", { subagentId, count: pending.length });
		}
	}

	const args = buildSubagentArgs(model, thinkingLevel, toolOptions);

		let tmpDir: string | null = null;
		let tmpFilePath: string | null = null;

		if (systemPrompt.trim()) {
			const tmp = await writeToTempFile(cwd, "system", systemPrompt);
			tmpDir = tmp.dir;
			tmpFilePath = tmp.filePath;
			args.push("--append-system-prompt", tmpFilePath);
		}

		// Pass the effective task as the prompt argument
		// F27: wrap in the task-as-data fence — the subagent's user message
		// is DATA, not instructions (see SUBAGENT_INSTRUCTIONS Task Boundary).
		args.push(wrapTask(task));

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
			hasSystemPrompt: systemPrompt.trim().length > 0,
			timeout,
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
					// F7 (issue #30): subprocess errors can embed the spawn command
					// (absolute paths to the pi binary, temp files, cwd) — sanitize the
					// errorMessage before it reaches the conductor. stderr is left RAW:
					// it is the subagent's own output (already in-scope of the subagent's
					// context), and the conductor sees it in full via the result. Only
					// OUR error text (errorMessage) is path-sanitized.
					result.errorMessage = `Subprocess error: ${sanitizeErrorMessage(err.message, cwd)}`;
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

/**
 * brl-subagent — Pure transcript-tail rendering for the drill-in overlay
 *
 * Line planning for the full-screen agent transcript view (showAgentDetail):
 * message filtering, tail selection, per-block line caps, budget fitting, and
 * per-line width truncation. Kept free of pi-tui imports so it is
 * unit-testable without a TUI harness.
 *
 * Messages are matched STRUCTURALLY (no pi-ai import): a message is renderable
 * when its `role` is one of user/assistant/toolResult; content blocks are
 * matched by `type` (text/thinking/toolCall).
 */

// ---------------------------------------------------------------------------
// Structural message types (subset of the session transcript shapes)
// ---------------------------------------------------------------------------

export interface TranscriptTextBlock {
	type: "text";
	text?: string;
}

export interface TranscriptThinkingBlock {
	type: "thinking";
	thinking?: string;
}

export interface TranscriptToolCallBlock {
	type: "toolCall";
	name?: string;
	arguments?: unknown;
}

export type TranscriptContentBlock =
	| TranscriptTextBlock
	| TranscriptThinkingBlock
	| TranscriptToolCallBlock;

export interface TranscriptMessage {
	role?: string;
	content?: string | TranscriptContentBlock[] | null;
	toolName?: string;
}

// ---------------------------------------------------------------------------
// Tail selection
// ---------------------------------------------------------------------------

/** True for messages the drill-in view can render (user/assistant/toolResult). */
export function isRenderableTranscriptMessage(
	msg: unknown,
): msg is TranscriptMessage {
	if (!msg || typeof msg !== "object") return false;
	const role = (msg as { role?: unknown }).role;
	return role === "user" || role === "assistant" || role === "toolResult";
}

/**
 * The transcript tail: the last `maxMessages` RENDERABLE messages, in order.
 * Non-renderable messages (custom types like bash-execution updates) are
 * skipped first so the tail is full of meaningful transcript content.
 */
export function buildTranscriptTail(
	messages: readonly unknown[],
	maxMessages: number,
): TranscriptMessage[] {
	if (maxMessages <= 0) return [];
	return messages.filter(isRenderableTranscriptMessage).slice(-maxMessages);
}

// ---------------------------------------------------------------------------
// Per-block truncation
// ---------------------------------------------------------------------------

/**
 * Truncate `text` to its last `maxLines` lines. When truncated, a marker line
 * (default "… (truncated)") is PREPENDED so the cut point is visible above
 * the shown tail. Untruncated text is returned unchanged (marker-free).
 */
export function truncateTail(
	text: string,
	maxLines: number,
	marker = "… (truncated)",
): string {
	const lines = text.split("\n");
	if (lines.length <= maxLines) return text;
	return `${marker}\n${lines.slice(-maxLines).join("\n")}`;
}

/** Cut a single plain line to `width` columns, trailing ellipsis on the cut. */
export function truncateLineWidth(line: string, width: number | undefined): string {
	if (!width || width <= 0 || line.length <= width) return line;
	return line.slice(0, Math.max(0, width - 1)) + "…";
}

// ---------------------------------------------------------------------------
// Line planning
// ---------------------------------------------------------------------------

/** Line styles the drill-in view maps to theme colors. */
export type TranscriptLineStyle =
	| "user"
	| "thinking"
	| "text"
	| "toolCall"
	| "toolResult"
	| "note"
	| "streaming";

/** One planned transcript line: plain text + style for coloring. */
export interface TranscriptRenderLine {
	text: string;
	style: TranscriptLineStyle;
}

export interface TranscriptRenderOptions {
	/** Tail size in messages (default 6). */
	maxMessages?: number;
	/** Max thinking lines per block (default 30). */
	maxThinkingLines?: number;
	/** Max text lines per block (default 20). */
	maxTextLines?: number;
	/** Max user-echo lines (default 6). */
	maxUserLines?: number;
	/** Max tool-call args preview chars (default 80). */
	toolCallArgsPreview?: number;
	/** Total line budget; oldest lines are dropped with an omission note. */
	maxLines?: number;
	/** Per-line width cap; longer lines are cut with a trailing ellipsis. */
	maxWidth?: number;
	/** True while the agent is streaming — appends a spinner line. */
	streaming?: boolean;
	/** Live spinner frame to use for the streaming line. */
	spinner?: string;
}

const DEFAULT_OPTIONS = {
	maxMessages: 6,
	maxThinkingLines: 30,
	maxTextLines: 20,
	maxUserLines: 6,
	toolCallArgsPreview: 80,
} as const;

/** Continuation indent under the block icon (aligned after "💬 " etc.). */
const CONTINUATION_INDENT = "   ";

/** Extract the displayable user text: raw string or the first text block. */
function userText(content: TranscriptMessage["content"]): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		const block = content.find(
			(b): b is TranscriptTextBlock =>
				b.type === "text" && typeof b.text === "string",
		);
		return block?.text ?? "";
	}
	return "";
}

/** Plan one block of plain text: icon on the first line, indented continuation. */
function blockLines(
	text: string,
	icon: string,
	maxLines: number,
	marker: string,
	style: TranscriptLineStyle,
	maxWidth: number | undefined,
): TranscriptRenderLine[] {
	const tail = truncateTail(text, maxLines, marker);
	return tail.split("\n").map((line, i) => ({
		text: truncateLineWidth(
			(i === 0 ? `${icon} ` : CONTINUATION_INDENT) + line,
			maxWidth,
		),
		style,
	}));
}

/** Plan one tool-call line: 🛠 → name: <args preview>. */
function toolCallLines(
	block: TranscriptToolCallBlock,
	previewLen: number,
	maxWidth: number | undefined,
): TranscriptRenderLine[] {
	const name = block.name ?? "tool";
	let argsPreview = "";
	try {
		argsPreview = JSON.stringify(block.arguments ?? {});
	} catch {
		argsPreview = "";
	}
	if (argsPreview.length > previewLen) {
		argsPreview = argsPreview.slice(0, previewLen) + "…";
	}
	const label = argsPreview ? `${name}: ${argsPreview}` : name;
	return [
		{ text: truncateLineWidth(`🛠 → ${label}`, maxWidth), style: "toolCall" },
	];
}

/** Plan all lines for a single message, in chronological order. */
function messageLines(
	msg: TranscriptMessage,
	opts: {
		maxThinkingLines: number;
		maxTextLines: number;
		maxUserLines: number;
		toolCallArgsPreview: number;
		maxWidth?: number;
	},
): TranscriptRenderLine[] {
	if (msg.role === "user") {
		const text = userText(msg.content);
		if (!text) return [];
		return blockLines(
			text,
			"💬",
			opts.maxUserLines,
			"… (message truncated)",
			"user",
			opts.maxWidth,
		);
	}
	if (msg.role === "assistant") {
		const blocks = Array.isArray(msg.content) ? msg.content : [];
		const out: TranscriptRenderLine[] = [];
		for (const block of blocks) {
			if (!block || typeof block !== "object") continue;
			if (block.type === "thinking" && typeof block.thinking === "string" && block.thinking) {
				out.push(
					...blockLines(
						block.thinking,
						"🧠",
						opts.maxThinkingLines,
						"… (thinking truncated)",
						"thinking",
						opts.maxWidth,
					),
				);
			} else if (block.type === "text" && typeof block.text === "string" && block.text) {
				out.push(
					...blockLines(
						block.text,
						"📝",
						opts.maxTextLines,
						"… (text truncated)",
						"text",
						opts.maxWidth,
					),
				);
			} else if (block.type === "toolCall") {
				out.push(...toolCallLines(block, opts.toolCallArgsPreview, opts.maxWidth));
			}
		}
		return out;
	}
	if (msg.role === "toolResult") {
		if (!msg.toolName) return [];
		return [
			{
				text: truncateLineWidth(`← ${msg.toolName} done`, opts.maxWidth),
				style: "toolResult",
			},
		];
	}
	return [];
}

// ---------------------------------------------------------------------------
// Budget fitting
// ---------------------------------------------------------------------------

/**
 * Keep the NEWEST `maxLines` lines. When content is cut, a dim omission note
 * is prepended so the oldest visible line does not read as the transcript
 * start.
 */
export function fitLinesToBudget(
	lines: readonly TranscriptRenderLine[],
	maxLines: number,
): TranscriptRenderLine[] {
	if (maxLines <= 0) return [];
	if (lines.length <= maxLines) return [...lines];
	const kept = lines.slice(lines.length - (maxLines - 1));
	return [{ text: "… (earlier messages omitted)", style: "note" }, ...kept];
}

// ---------------------------------------------------------------------------
// Full pipeline
// ---------------------------------------------------------------------------

/**
 * Plan the drill-in transcript from a message array: tail selection, per-block
 * line caps, budget fit (oldest dropped first), per-line width truncation.
 * The output lines are plain text — the caller maps `style` to theme colors.
 */
export function renderTranscriptMessages(
	messages: readonly unknown[],
	options: TranscriptRenderOptions = {},
): TranscriptRenderLine[] {
	const opts = { ...DEFAULT_OPTIONS, ...options };
	const tail = buildTranscriptTail(messages, opts.maxMessages);

	const lines: TranscriptRenderLine[] = [];
	for (const msg of tail) {
		lines.push(
			...messageLines(msg, {
				maxThinkingLines: opts.maxThinkingLines,
				maxTextLines: opts.maxTextLines,
				maxUserLines: opts.maxUserLines,
				toolCallArgsPreview: opts.toolCallArgsPreview,
				maxWidth: opts.maxWidth,
			}),
		);
	}
	if (opts.streaming && opts.spinner) {
		lines.push({
			text: truncateLineWidth(`${opts.spinner} streaming…`, opts.maxWidth),
			style: "streaming",
		});
	}
	if (opts.maxLines !== undefined && opts.maxLines > 0 && lines.length > opts.maxLines) {
		return fitLinesToBudget(lines, opts.maxLines);
	}
	return lines;
}

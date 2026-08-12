import { describe, expect, it } from "vitest";
import {
	buildTranscriptTail,
	fitLinesToBudget,
	renderTranscriptMessages,
	truncateLineWidth,
	truncateTail,
	type TranscriptRenderLine,
} from "../transcript-tail";

const userMsg = { role: "user", content: "Do the thing" };
const thinkingMsg = {
	role: "assistant",
	content: [{ type: "thinking", thinking: "step 1\nstep 2" }],
};
const textMsg = {
	role: "assistant",
	content: [{ type: "text", text: "here is the result" }],
};
const toolCallMsg = {
	role: "assistant",
	content: [{ type: "toolCall", name: "read", arguments: { path: "src/a.ts" } }],
};
const toolResultMsg = { role: "toolResult", toolName: "read" };
const bashMsg = { role: "bashExecution", command: "ls", output: "" };

describe("buildTranscriptTail", () => {
	it("returns the last N renderable messages in order", () => {
		const tail = buildTranscriptTail(
			[userMsg, thinkingMsg, textMsg, toolCallMsg],
			2,
		);
		expect(tail).toEqual([textMsg, toolCallMsg]);
	});

	it("skips non-renderable custom messages", () => {
		const tail = buildTranscriptTail(
			[userMsg, bashMsg, textMsg, bashMsg, thinkingMsg],
			3,
		);
		expect(tail).toEqual([userMsg, textMsg, thinkingMsg]);
	});

	it("returns everything when under the cap", () => {
		expect(buildTranscriptTail([userMsg, textMsg], 6)).toEqual([userMsg, textMsg]);
	});

	it("handles empty input and maxMessages of zero", () => {
		expect(buildTranscriptTail([], 6)).toEqual([]);
		expect(buildTranscriptTail([userMsg], 0)).toEqual([]);
	});
});

describe("truncateTail", () => {
	it("returns short text unchanged", () => {
		expect(truncateTail("a\nb", 5)).toBe("a\nb");
	});

	it("keeps the last maxLines with a marker prepended", () => {
		const result = truncateTail("l1\nl2\nl3\nl4", 2, "… (thinking truncated)");
		expect(result).toBe("… (thinking truncated)\nl3\nl4");
	});

	it("defaults to the generic marker", () => {
		expect(truncateTail("l1\nl2\nl3", 2)).toBe("… (truncated)\nl2\nl3");
	});

	it("exact boundary is not truncated", () => {
		expect(truncateTail("a\nb\nc", 3)).toBe("a\nb\nc");
	});

	it("single-line text never truncates on line count", () => {
		expect(truncateTail("x".repeat(500), 30)).toBe("x".repeat(500));
	});
});

describe("truncateLineWidth", () => {
	it("leaves short lines untouched", () => {
		expect(truncateLineWidth("hello", 80)).toBe("hello");
	});

	it("cuts long lines with a trailing ellipsis", () => {
		expect(truncateLineWidth("abcdefgh", 5)).toBe("abcd…");
	});

	it("ignores a missing width", () => {
		expect(truncateLineWidth("abcdef", undefined)).toBe("abcdef");
	});
});

describe("fitLinesToBudget", () => {
	const l = (text: string): TranscriptRenderLine => ({ text, style: "text" });

	it("returns all lines when they fit", () => {
		const lines = [l("a"), l("b")];
		expect(fitLinesToBudget(lines, 5)).toEqual(lines);
	});

	it("keeps the newest lines with an omission note", () => {
		const lines = [l("a"), l("b"), l("c"), l("d")];
		const fit = fitLinesToBudget(lines, 3);
		expect(fit).toEqual([
			{ text: "… (earlier messages omitted)", style: "note" },
			l("c"),
			l("d"),
		]);
	});

	it("zero or negative budget yields nothing", () => {
		expect(fitLinesToBudget([l("a")], 0)).toEqual([]);
	});
});

describe("renderTranscriptMessages", () => {
	it("renders a user string message with the chat icon", () => {
		const lines = renderTranscriptMessages([userMsg]);
		expect(lines).toEqual([{ text: "💬 Do the thing", style: "user" }]);
	});

	it("uses the first text block of an array-content user message", () => {
		const msg = {
			role: "user",
			content: [
				{ type: "image", data: "…" },
				{ type: "text", text: "look at this" },
			],
		};
		const lines = renderTranscriptMessages([msg]);
		expect(lines).toEqual([{ text: "💬 look at this", style: "user" }]);
	});

	it("renders thinking blocks dimmed with icons and indented continuation", () => {
		const msg = { role: "assistant", content: [{ type: "thinking", thinking: "a\nb" }] };
		const lines = renderTranscriptMessages([msg]);
		expect(lines).toEqual([
			{ text: "🧠 a", style: "thinking" },
			{ text: "   b", style: "thinking" },
		]);
	});

	it("truncates long thinking to the last lines with a marker", () => {
		const msg = {
			role: "assistant",
			content: [{ type: "thinking", thinking: "l1\nl2\nl3\nl4\nl5" }],
		};
		const lines = renderTranscriptMessages([msg], { maxThinkingLines: 2 });
		expect(lines).toEqual([
			{ text: "🧠 … (thinking truncated)", style: "thinking" },
			{ text: "   l4", style: "thinking" },
			{ text: "   l5", style: "thinking" },
		]);
	});

	it("renders text blocks with the output icon", () => {
		const lines = renderTranscriptMessages([textMsg]);
		expect(lines).toEqual([{ text: "📝 here is the result", style: "text" }]);
	});

	it("truncates long text to the last lines with a marker", () => {
		const msg = {
			role: "assistant",
			content: [{ type: "text", text: "a\nb\nc\nd" }],
		};
		const lines = renderTranscriptMessages([msg], { maxTextLines: 2 });
		expect(lines).toEqual([
			{ text: "📝 … (text truncated)", style: "text" },
			{ text: "   c", style: "text" },
			{ text: "   d", style: "text" },
		]);
	});

	it("renders tool calls as one accent line with an args preview", () => {
		const lines = renderTranscriptMessages([toolCallMsg]);
		expect(lines).toEqual([
			{ text: "🛠 → read: {\"path\":\"src/a.ts\"}", style: "toolCall" },
		]);
	});

	it("truncates oversized tool-call args previews", () => {
		const msg = {
			role: "assistant",
			content: [
				{ type: "toolCall", name: "write", arguments: { content: "x".repeat(200) } },
			],
		};
		const lines = renderTranscriptMessages([msg], { toolCallArgsPreview: 20 });
		expect(lines[0].text.startsWith("🛠 → write: {")).toBe(true);
		expect(lines[0].text.endsWith("…")).toBe(true);
		expect(lines[0].text.length).toBeLessThan(40);
	});

	it("renders tool results as a one-line muted note", () => {
		const lines = renderTranscriptMessages([toolResultMsg]);
		expect(lines).toEqual([{ text: "← read done", style: "toolResult" }]);
	});

	it("preserves block order within an assistant message", () => {
		const msg = {
			role: "assistant",
			content: [
				{ type: "thinking", thinking: "t" },
				{ type: "text", text: "x" },
				{ type: "toolCall", name: "read", arguments: {} },
			],
		};
		const lines = renderTranscriptMessages([msg]);
		expect(lines.map((l) => l.style)).toEqual(["thinking", "text", "toolCall"]);
	});

	it("appends a streaming line when streaming with a spinner", () => {
		const lines = renderTranscriptMessages([thinkingMsg], {
			streaming: true,
			spinner: "⠋",
		});
		expect(lines[lines.length - 1]).toEqual({
			text: "⠋ streaming…",
			style: "streaming",
		});
	});

	it("does not append a streaming line without a spinner", () => {
		const lines = renderTranscriptMessages([thinkingMsg], { streaming: true });
		expect(lines[lines.length - 1].style).not.toBe("streaming");
	});

	it("fits the output to the budget keeping the newest content", () => {
		const messages = [
			{ role: "user", content: "old" },
			{ role: "assistant", content: [{ type: "text", text: "new" }] },
			{ role: "assistant", content: [{ type: "thinking", thinking: "t" }] },
		];
		const lines = renderTranscriptMessages(messages, { maxLines: 2 });
		expect(lines).toEqual([
			{ text: "… (earlier messages omitted)", style: "note" },
			{ text: "🧠 t", style: "thinking" },
		]);
	});

	it("truncates lines to maxWidth", () => {
		const msg = { role: "user", content: "x".repeat(50) };
		const lines = renderTranscriptMessages([msg], { maxWidth: 10 });
		expect(lines[0].text.length).toBe(10);
		expect(lines[0].text.endsWith("…")).toBe(true);
	});

	it("returns nothing for an empty transcript", () => {
		expect(renderTranscriptMessages([])).toEqual([]);
	});

	it("ignores messages with unknown roles and malformed content", () => {
		const lines = renderTranscriptMessages([
			bashMsg,
			{ role: "assistant", content: [{ type: "nonsense" }] },
			{ role: "toolResult", toolName: "" },
		]);
		expect(lines).toEqual([]);
	});
});

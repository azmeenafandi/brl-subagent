/**
 * brl-subagent — Messaging Tests (E10)
 *
 * Tests for the Intercom class and message extraction helpers.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
	Intercom,
	extractMessages,
	stripMessageLines,
	formatPendingMessages,
	TO_PATTERN,
	type Message,
} from "../messaging";

// ---------------------------------------------------------------------------
// Intercom class tests
// ---------------------------------------------------------------------------

describe("Intercom", () => {
	let intercom: Intercom;

	beforeEach(() => {
		intercom = new Intercom();
	});

	it("send adds message to recipient queue", () => {
		intercom.register("agent-1");
		intercom.register("agent-2");

		intercom.send("agent-1", "agent-2", "Hello from agent-1");

		const msgs = intercom.receive("agent-2");
		expect(msgs).toHaveLength(1);
		expect(msgs[0].from).toBe("agent-1");
		expect(msgs[0].content).toBe("Hello from agent-1");
		expect(msgs[0].timestamp).toBeTypeOf("number");
	});

	it("receive returns messages without clearing", () => {
		intercom.register("agent-1");
		intercom.register("agent-2");

		intercom.send("agent-1", "agent-2", "Message 1");
		intercom.send("agent-1", "agent-2", "Message 2");

		const first = intercom.receive("agent-2");
		expect(first).toHaveLength(2);

		const second = intercom.receive("agent-2");
		expect(second).toHaveLength(2); // Still there
	});

	it("receiveAndClear returns messages and empties queue", () => {
		intercom.register("agent-1");
		intercom.register("agent-2");

		intercom.send("agent-1", "agent-2", "Message 1");
		intercom.send("agent-1", "agent-2", "Message 2");

		const msgs = intercom.receiveAndClear("agent-2");
		expect(msgs).toHaveLength(2);

		const after = intercom.receive("agent-2");
		expect(after).toHaveLength(0);
	});

	it("hasMessages true when messages pending", () => {
		intercom.register("agent-1");
		intercom.register("agent-2");

		expect(intercom.hasMessages("agent-2")).toBe(false);

		intercom.send("agent-1", "agent-2", "Hello");

		expect(intercom.hasMessages("agent-2")).toBe(true);
	});

	it("hasMessages false when queue empty", () => {
		intercom.register("agent-1");

		expect(intercom.hasMessages("agent-1")).toBe(false);

		// Send then clear
		intercom.send("agent-2", "agent-1", "Hello");
		intercom.receiveAndClear("agent-1");

		expect(intercom.hasMessages("agent-1")).toBe(false);
	});

	it("hasMessages false for unknown id", () => {
		expect(intercom.hasMessages("unknown")).toBe(false);
	});

	it("broadcast sends to all known IDs", () => {
		intercom.register("agent-1");
		intercom.register("agent-2");
		intercom.register("agent-3");

		intercom.broadcast("agent-1", "Broadcast from agent-1");

		// Should NOT send to self
		expect(intercom.hasMessages("agent-1")).toBe(false);

		// Should send to others
		expect(intercom.hasMessages("agent-2")).toBe(true);
		expect(intercom.hasMessages("agent-3")).toBe(true);

		const msgs2 = intercom.receive("agent-2");
		expect(msgs2[0].content).toBe("Broadcast from agent-1");

		const msgs3 = intercom.receive("agent-3");
		expect(msgs3[0].content).toBe("Broadcast from agent-1");
	});

	it("broadcast excludes specified IDs", () => {
		intercom.register("agent-1");
		intercom.register("agent-2");
		intercom.register("agent-3");

		intercom.broadcast("agent-1", "Hello", ["agent-2"]);

		expect(intercom.hasMessages("agent-1")).toBe(false); // sender excluded
		expect(intercom.hasMessages("agent-2")).toBe(false); // explicitly excluded
		expect(intercom.hasMessages("agent-3")).toBe(true);
	});

	it("multiple sends to same recipient accumulate", () => {
		intercom.register("agent-1");
		intercom.register("agent-2");

		intercom.send("agent-1", "agent-2", "First");
		intercom.send("agent-1", "agent-2", "Second");
		intercom.send("agent-3", "agent-2", "Third");

		const msgs = intercom.receive("agent-2");
		expect(msgs).toHaveLength(3);
		expect(msgs[0].content).toBe("First");
		expect(msgs[1].content).toBe("Second");
		expect(msgs[2].content).toBe("Third");
	});

	it("register/unregister manage known IDs", () => {
		intercom.register("agent-1");
		intercom.register("agent-2");
		expect(intercom.getKnownIds()).toContain("agent-1");
		expect(intercom.getKnownIds()).toContain("agent-2");

		intercom.unregister("agent-1");
		expect(intercom.getKnownIds()).not.toContain("agent-1");
		expect(intercom.getKnownIds()).toContain("agent-2");
	});

	it("receive returns empty array for unknown id", () => {
		const msgs = intercom.receive("unknown");
		expect(msgs).toEqual([]);
	});

	it("timestamps are set correctly", () => {
		intercom.register("agent-1");
		intercom.register("agent-2");

		const before = Date.now();
		intercom.send("agent-1", "agent-2", "Hello");
		const after = Date.now();

		const msgs = intercom.receive("agent-2");
		expect(msgs[0].timestamp).toBeGreaterThanOrEqual(before);
		expect(msgs[0].timestamp).toBeLessThanOrEqual(after);
	});
});

// ---------------------------------------------------------------------------
// extractMessages tests
// ---------------------------------------------------------------------------

describe("extractMessages", () => {
	it("extracts [TO:agent-2]:Found a bug correctly", () => {
		const output = "I found a bug in auth.ts\n[TO:agent-2]:Found a bug\nPlease fix it.";
		const msgs = extractMessages(output);
		expect(msgs).toHaveLength(1);
		expect(msgs[0].target).toBe("agent-2");
		expect(msgs[0].content).toBe("Found a bug");
	});

	it("extracts [TO:*]:Broadcast message", () => {
		const output = "[TO:*]:Broadcast message here";
		const msgs = extractMessages(output);
		expect(msgs).toHaveLength(1);
		expect(msgs[0].target).toBe("*");
		expect(msgs[0].content).toBe("Broadcast message here");
	});

	it("extracts multiple TO patterns in output", () => {
		const output = [
			"Analysis complete.",
			"[TO:agent-2]:Found issue in auth.ts",
			"Also checked DB.",
			"[TO:agent-3]:Schema looks clean",
			"Done.",
		].join("\n");
		const msgs = extractMessages(output);
		expect(msgs).toHaveLength(2);
		expect(msgs[0].target).toBe("agent-2");
		expect(msgs[0].content).toBe("Found issue in auth.ts");
		expect(msgs[1].target).toBe("agent-3");
		expect(msgs[1].content).toBe("Schema looks clean");
	});

	it("returns empty for output without TO patterns", () => {
		const output = "No messages here.\nJust regular text.";
		const msgs = extractMessages(output);
		expect(msgs).toHaveLength(0);
	});

	it("extracts only TO lines from mixed output", () => {
		const output = [
			"## Summary",
			"I checked the codebase thoroughly.",
			"[TO:agent-1]:Security issue found in auth.ts line 42",
			"",
			"## Findings",
			"- No critical issues",
			"[TO:*]:All checks passed",
			"",
			"## Recommendations",
			"Update dependencies.",
		].join("\n");
		const msgs = extractMessages(output);
		expect(msgs).toHaveLength(2);
		expect(msgs[0].target).toBe("agent-1");
		expect(msgs[0].content).toBe("Security issue found in auth.ts line 42");
		expect(msgs[1].target).toBe("*");
		expect(msgs[1].content).toBe("All checks passed");
	});

	it("handles message content with spaces", () => {
		const output = "[TO:agent-5]:This is a longer message with spaces";
		const msgs = extractMessages(output);
		expect(msgs).toHaveLength(1);
		expect(msgs[0].content).toBe("This is a longer message with spaces");
	});

	it("handles empty output", () => {
		const msgs = extractMessages("");
		expect(msgs).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// stripMessageLines tests
// ---------------------------------------------------------------------------

describe("stripMessageLines", () => {
	it("removes [TO:...] lines from output", () => {
		const output = [
			"## Summary",
			"[TO:agent-2]:Found a bug",
			"Normal text here.",
			"[TO:*]:Broadcast",
			"More text.",
		].join("\n");
		const result = stripMessageLines(output);
		expect(result).not.toContain("[TO:");
		expect(result).toContain("## Summary");
		expect(result).toContain("Normal text here.");
		expect(result).toContain("More text.");
	});

	it("preserves output without TO patterns", () => {
		const output = "No messages.\nJust text.";
		const result = stripMessageLines(output);
		expect(result).toBe(output);
	});

	it("handles empty output", () => {
		const result = stripMessageLines("");
		expect(result).toBe("");
	});
});

// ---------------------------------------------------------------------------
// formatPendingMessages tests
// ---------------------------------------------------------------------------

describe("formatPendingMessages", () => {
	it("formats messages into readable block", () => {
		const messages: Message[] = [
			{ from: "agent-1", content: "Found security issue", timestamp: 1000 },
			{ from: "agent-2", content: "DB schema looks clean", timestamp: 2000 },
		];
		const result = formatPendingMessages(messages);
		expect(result).toBe(
			"From agent-1: Found security issue\nFrom agent-2: DB schema looks clean",
		);
	});

	it("returns empty string for empty messages", () => {
		const result = formatPendingMessages([]);
		expect(result).toBe("");
	});

	it("handles single message", () => {
		const messages: Message[] = [
			{ from: "agent-1", content: "Single message", timestamp: 1000 },
		];
		const result = formatPendingMessages(messages);
		expect(result).toBe("From agent-1: Single message");
	});
});

// ---------------------------------------------------------------------------
// TO_PATTERN regex tests
// ---------------------------------------------------------------------------

describe("TO_PATTERN regex", () => {
	it("matches [TO:id]:content", () => {
		const match = "[TO:agent-2]:Hello".match(TO_PATTERN);
		expect(match).not.toBeNull();
	});

	it("matches [TO:*]:broadcast", () => {
		const match = "[TO:*]:Broadcast".match(TO_PATTERN);
		expect(match).not.toBeNull();
	});

	it("does not match without bracket format", () => {
		const match = "TO:agent-2:Hello".match(TO_PATTERN);
		expect(match).toBeNull();
	});
});

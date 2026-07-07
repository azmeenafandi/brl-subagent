/**
 * brl-subagent — Subagent-to-Subagent Messaging (E10)
 *
 * Provides an Intercom class that manages inter-subagent communication
 * via a shared message channel. Subagents can send targeted or broadcast
 * messages using a special output format parsed by the conductor.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Message {
	from: string;
	content: string;
	timestamp: number;
}

// ---------------------------------------------------------------------------
// Regex for extracting TO: patterns from subagent output
// ---------------------------------------------------------------------------

/**
 * Matches lines like:
 *   [TO:agent-id]:some message text
 *   [TO:*]:broadcast message text
 *
 * Group 1 = target id or "*"
 * Group 2 = message content (rest of line after colon)
 */
export const TO_PATTERN = /\[TO:([^*\]]+|\*)\]:([^\n]+)/g;

// ---------------------------------------------------------------------------
// Intercom class
// ---------------------------------------------------------------------------

export class Intercom {
	/**
	 * Map of subagent ID → queue of incoming messages.
	 * Keys are created lazily when a message is sent to a subagent.
	 */
	private messages: Map<string, Message[]> = new Map();

	/**
	 * Known subagent IDs. Populated via `register()` as subagents are spawned.
	 * Used by `broadcast` to determine recipients.
	 */
	private knownIds: Set<string> = new Set();

	/**
	 * Register a subagent ID so it can receive broadcasts.
	 */
	register(id: string): void {
		this.knownIds.add(id);
	}

	/**
	 * Remove a subagent ID from the known set (for cleanup).
	 */
	unregister(id: string): void {
		this.knownIds.delete(id);
	}

	/**
	 * Send a message from one subagent to another.
	 */
	send(fromId: string, toId: string, content: string): void {
		if (!this.messages.has(toId)) {
			this.messages.set(toId, []);
		}
		this.messages.get(toId)!.push({
			from: fromId,
			content,
			timestamp: Date.now(),
		});
	}

	/**
	 * Return all messages for a subagent without clearing the queue.
	 */
	receive(id: string): Message[] {
		return this.messages.get(id) ?? [];
	}

	/**
	 * Return all messages for a subagent and clear the queue.
	 */
	receiveAndClear(id: string): Message[] {
		const msgs = this.messages.get(id) ?? [];
		this.messages.set(id, []);
		return msgs;
	}

	/**
	 * Returns true if there are pending messages for this subagent.
	 */
	hasMessages(id: string): boolean {
		const q = this.messages.get(id);
		return q !== undefined && q.length > 0;
	}

	/**
	 * Send a message to ALL known subagent IDs except the sender and any
	 * explicitly excluded IDs.
	 */
	broadcast(fromId: string, content: string, excludeIds?: string[]): void {
		const exclude = new Set(excludeIds ?? []);
		exclude.add(fromId); // never send back to self

		for (const id of this.knownIds) {
			if (!exclude.has(id)) {
				this.send(fromId, id, content);
			}
		}
	}

	/**
	 * Return the list of all known subagent IDs.
	 */
	getKnownIds(): string[] {
		return [...this.knownIds];
	}
}

// ---------------------------------------------------------------------------
// Output parsing helpers
// ---------------------------------------------------------------------------

/**
 * Extract all [TO:...] messages from a subagent's output text.
 * Returns an array of { target, content } objects.
 */
export function extractMessages(
	output: string,
): Array<{ target: string; content: string }> {
	const results: Array<{ target: string; content: string }> = [];
	const regex = new RegExp(TO_PATTERN.source, "g");
	let match: RegExpExecArray | null;
	while ((match = regex.exec(output)) !== null) {
		results.push({
			target: match[1],
			content: match[2].trim(),
		});
	}
	return results;
}

/**
 * Remove [TO:...] lines from the output so they don't appear in the
 * conductor's view of the result.
 */
export function stripMessageLines(output: string): string {
	return output
		.split("\n")
		.filter((line) => !TO_PATTERN.test(line.trim()))
		.join("\n");
}

/**
 * Format a list of incoming messages into a string that can be appended
 * to a subagent's task prompt.
 */
export function formatPendingMessages(messages: Message[]): string {
	return messages
		.map((m) => `From ${m.from}: ${m.content}`)
		.join("\n");
}

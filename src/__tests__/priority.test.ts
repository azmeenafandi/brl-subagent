/**
 * P6: Priority queue for subagent concurrency
 *
 * Tests for the priorityInsert function that maintains priority ordering
 * in the pending subagent queue. Higher-priority items (lower PRIORITY_ORDER
 * value) are placed ahead of lower-priority items. Equal-priority items
 * maintain FIFO order.
 */

import { describe, it, expect } from "vitest";
import { priorityInsert } from "../concurrency";
import type { Priority } from "../types";

interface QueueEntry {
	priority: Priority;
	id: number; // Insertion order marker for FIFO testing
}

describe("priorityInsert", () => {
	it("inserts critical before high", () => {
		const queue: QueueEntry[] = [
			{ priority: "high", id: 1 },
		];
		priorityInsert(queue, { priority: "critical", id: 2 });
		expect(queue[0].priority).toBe("critical");
		expect(queue[1].priority).toBe("high");
	});

	it("inserts high before normal", () => {
		const queue: QueueEntry[] = [
			{ priority: "normal", id: 1 },
		];
		priorityInsert(queue, { priority: "high", id: 2 });
		expect(queue[0].priority).toBe("high");
		expect(queue[1].priority).toBe("normal");
	});

	it("inserts normal before low", () => {
		const queue: QueueEntry[] = [
			{ priority: "low", id: 1 },
		];
		priorityInsert(queue, { priority: "normal", id: 2 });
		expect(queue[0].priority).toBe("normal");
		expect(queue[1].priority).toBe("low");
	});

	it("maintains FIFO order for equal-priority items", () => {
		const queue: QueueEntry[] = [
			{ priority: "high", id: 1 },
			{ priority: "high", id: 2 },
		];
		// Insert a third high — should go after both
		priorityInsert(queue, { priority: "high", id: 3 });
		expect(queue[0].id).toBe(1);
		expect(queue[1].id).toBe(2);
		expect(queue[2].id).toBe(3);
	});

	it("inserts critical at front of mixed queue", () => {
		const queue: QueueEntry[] = [
			{ priority: "high", id: 1 },
			{ priority: "normal", id: 2 },
			{ priority: "low", id: 3 },
		];
		priorityInsert(queue, { priority: "critical", id: 4 });
		expect(queue[0].priority).toBe("critical");
		expect(queue[1].priority).toBe("high");
		expect(queue[2].priority).toBe("normal");
		expect(queue[3].priority).toBe("low");
	});

	it("inserts low at end of queue", () => {
		const queue: QueueEntry[] = [
			{ priority: "critical", id: 1 },
			{ priority: "high", id: 2 },
			{ priority: "normal", id: 3 },
		];
		priorityInsert(queue, { priority: "low", id: 4 });
		expect(queue[0].priority).toBe("critical");
		expect(queue[1].priority).toBe("high");
		expect(queue[2].priority).toBe("normal");
		expect(queue[3].priority).toBe("low");
	});

	it("inserts into empty queue", () => {
		const queue: QueueEntry[] = [];
		priorityInsert(queue, { priority: "critical", id: 1 });
		expect(queue).toHaveLength(1);
		expect(queue[0].priority).toBe("critical");
	});

	it("all same priority behaves like FIFO", () => {
		const queue: QueueEntry[] = [];
		priorityInsert(queue, { priority: "normal", id: 1 });
		priorityInsert(queue, { priority: "normal", id: 2 });
		priorityInsert(queue, { priority: "normal", id: 3 });
		expect(queue).toHaveLength(3);
		expect(queue[0].id).toBe(1);
		expect(queue[1].id).toBe(2);
		expect(queue[2].id).toBe(3);
	});
});

/**
 * Tests for pool.ts — ProcessPool logic
 *
 * Since spawning real pi processes is not feasible in vitest,
 * we test pool logic in isolation using mocks.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ProcessPool, type ProcessPoolEntry } from "../pool";
import type { ChildProcess } from "node:child_process";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockProcess(): ChildProcess {
	const listeners: Record<string, Function[]> = {};
	const proc = {
		pid: Math.floor(Math.random() * 100000),
		killed: false,
		stdin: {
			write: vi.fn(),
			removeAllListeners: vi.fn(),
		},
		stdout: {
			on: vi.fn(),
			off: vi.fn(),
			removeAllListeners: vi.fn(),
		},
		stderr: {
			on: vi.fn(),
			off: vi.fn(),
			removeAllListeners: vi.fn(),
		},
		on: vi.fn((event: string, handler: Function) => {
			if (!listeners[event]) listeners[event] = [];
			listeners[event].push(handler);
		}),
		off: vi.fn(),
		kill: vi.fn(() => {
			proc.killed = true;
			return true;
		}),
		emit: (event: string, ...args: unknown[]) => {
			for (const handler of listeners[event] ?? []) {
				handler(...args);
			}
		},
	} as unknown as ChildProcess;
	return proc;
}

// We need to mock spawn from "node:child_process"
vi.mock("node:child_process", () => ({
	spawn: vi.fn(() => createMockProcess()),
}));

// Mock getPiInvocation to return a dummy command
vi.mock("../runner", () => ({
	getPiInvocation: vi.fn((_args: string[]) => ({
		command: "dummy-pi",
		args: _args,
	})),
	accumulateUsage: vi.fn(),
	parseSubagentLine: vi.fn(),
}));

// Mock getSafeEnv
vi.mock("../sanitize", () => ({
	getSafeEnv: vi.fn(() => ({})),
	DEPTH_ENV_KEY: "BR_SUBAGENT_DEPTH",
}));

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProcessPool", () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	it("constructor creates pool with valid size", () => {
		const pool = new ProcessPool(4, 120_000);
		expect(pool).toBeDefined();
		pool.shutdown();
	});

	it("constructor clamps size to MAX_POOL_SIZE (8)", () => {
		const pool = new ProcessPool(20, 120_000);
		expect(pool).toBeDefined();
		pool.shutdown();
	});

	it("constructor clamps size to 0 minimum", () => {
		const pool = new ProcessPool(0, 120_000);
		expect(pool).toBeDefined();
		pool.shutdown();
	});

	it("acquire returns null when pool is empty and maxSize is 0", async () => {
		const pool = new ProcessPool(0, 120_000);
		const entry = await pool.acquire("/tmp", "model/test", "off");
		expect(entry).toBeNull();
		pool.shutdown();
	});

	it("acquire returns null when pool is full and no idle match", async () => {
		const pool = new ProcessPool(1, 120_000);
		const mockProcess = createMockProcess();

		const entry: ProcessPoolEntry = {
			process: mockProcess,
			model: "model/test",
			thinkingLevel: "off",
			idle: false, // busy
			lastUsed: Date.now(),
			stdoutBuffer: "",
			cwd: "/tmp",
			stderr: "",
		};

		(pool as any).entries = [entry];

		const result = await pool.acquire("/tmp", "other/model", "high");
		expect(result).toBeNull();
		pool.shutdown();
	});

	it("acquire returns idle entry when model/thinkingLevel/cwd match", async () => {
		const pool = new ProcessPool(2, 120_000);
		const mockProcess = createMockProcess();

		const entry: ProcessPoolEntry = {
			process: mockProcess,
			model: "model/test",
			thinkingLevel: "off",
			idle: true,
			lastUsed: Date.now() - 1000,
			stdoutBuffer: "old data",
			cwd: "/tmp",
			stderr: "old err",
		};

		(pool as any).entries = [entry];

		const result = await pool.acquire("/tmp", "model/test", "off");
		expect(result).toBe(entry);
		expect(entry.idle).toBe(false);
		expect(entry.stdoutBuffer).toBe("");
		expect(entry.stderr).toBe("");
		pool.shutdown();
	});

	it("acquire does not return entry with wrong model (returns null when full)", async () => {
		const pool = new ProcessPool(1, 120_000); // maxSize=1, pool will be full
		const mockProcess = createMockProcess();

		const entry: ProcessPoolEntry = {
			process: mockProcess,
			model: "model/test",
			thinkingLevel: "off",
			idle: true,
			lastUsed: Date.now(),
			stdoutBuffer: "",
			cwd: "/tmp",
			stderr: "",
		};

		(pool as any).entries = [entry];

		// No idle match because model differs, and pool is full (maxSize=1)
		const result = await pool.acquire("/tmp", "other/model", "off");
		expect(result).toBeNull();
		pool.shutdown();
	});

	it("acquire does not return entry with wrong thinkingLevel (returns null when full)", async () => {
		const pool = new ProcessPool(1, 120_000); // maxSize=1, pool will be full
		const mockProcess = createMockProcess();

		const entry: ProcessPoolEntry = {
			process: mockProcess,
			model: "model/test",
			thinkingLevel: "off",
			idle: true,
			lastUsed: Date.now(),
			stdoutBuffer: "",
			cwd: "/tmp",
			stderr: "",
		};

		(pool as any).entries = [entry];

		// No idle match because thinkingLevel differs, and pool is full
		const result = await pool.acquire("/tmp", "model/test", "high");
		expect(result).toBeNull();
		pool.shutdown();
	});

	it("release marks entry as idle", () => {
		const pool = new ProcessPool(2, 120_000);
		const mockProcess = createMockProcess();
		const entry: ProcessPoolEntry = {
			process: mockProcess,
			model: "model/test",
			thinkingLevel: "off",
			idle: false,
			lastUsed: 0,
			stdoutBuffer: "",
			cwd: "/tmp",
			stderr: "",
		};

		(pool as any).entries = [entry];

		expect(entry.idle).toBe(false);
		pool.release(entry);
		expect(entry.idle).toBe(true);
		expect(entry.lastUsed).toBeGreaterThan(0);
		pool.shutdown();
	});

	it("cleanupIdle removes expired idle entries but keeps at least 1", () => {
		vi.useFakeTimers();
		const pool = new ProcessPool(4, 120_000);
		const mockProcess1 = createMockProcess();
		const mockProcess2 = createMockProcess();

		const entry1: ProcessPoolEntry = {
			process: mockProcess1,
			model: "model/test",
			thinkingLevel: "off",
			idle: true,
			lastUsed: Date.now() - 200_000, // expired
			stdoutBuffer: "",
			cwd: "/tmp",
			stderr: "",
		};

		const entry2: ProcessPoolEntry = {
			process: mockProcess2,
			model: "model/test",
			thinkingLevel: "off",
			idle: true,
			lastUsed: Date.now() - 200_000, // expired
			stdoutBuffer: "",
			cwd: "/tmp",
			stderr: "",
		};

		(pool as any).entries = [entry1, entry2];

		pool.cleanupIdle();

		// Should keep at least 1, remove the other
		expect((pool as any).entries.length).toBe(1);
		// First one should have been killed
		expect(mockProcess1.kill).toHaveBeenCalled();
		pool.shutdown();
	});

	it("cleanupIdle keeps entries that are not expired", () => {
		vi.useFakeTimers();
		const pool = new ProcessPool(4, 120_000);
		const mockProcess = createMockProcess();

		const entry: ProcessPoolEntry = {
			process: mockProcess,
			model: "model/test",
			thinkingLevel: "off",
			idle: true,
			lastUsed: Date.now(), // not expired
			stdoutBuffer: "",
			cwd: "/tmp",
			stderr: "",
		};

		(pool as any).entries = [entry];

		pool.cleanupIdle();

		expect((pool as any).entries.length).toBe(1);
		expect(mockProcess.kill).not.toHaveBeenCalled();
		pool.shutdown();
	});

	it("cleanupIdle does not remove busy entries", () => {
		vi.useFakeTimers();
		const pool = new ProcessPool(4, 120_000);
		const mockProcess = createMockProcess();

		const entry: ProcessPoolEntry = {
			process: mockProcess,
			model: "model/test",
			thinkingLevel: "off",
			idle: false, // busy
			lastUsed: Date.now() - 200_000,
			stdoutBuffer: "",
			cwd: "/tmp",
			stderr: "",
		};

		(pool as any).entries = [entry];

		pool.cleanupIdle();

		expect((pool as any).entries.length).toBe(1);
		expect(mockProcess.kill).not.toHaveBeenCalled();
		pool.shutdown();
	});

	it("cleanupIdle respects keep-at-least-1 rule", () => {
		vi.useFakeTimers();
		const pool = new ProcessPool(4, 120_000);
		const mockProcess = createMockProcess();

		const entry: ProcessPoolEntry = {
			process: mockProcess,
			model: "model/test",
			thinkingLevel: "off",
			idle: true,
			lastUsed: Date.now() - 200_000, // expired
			stdoutBuffer: "",
			cwd: "/tmp",
			stderr: "",
		};

		// Only 1 idle entry — should be kept despite being expired
		(pool as any).entries = [entry];

		pool.cleanupIdle();

		expect((pool as any).entries.length).toBe(1);
		expect(mockProcess.kill).not.toHaveBeenCalled();
		pool.shutdown();
	});

	it("shutdown kills all processes", () => {
		const pool = new ProcessPool(4, 120_000);
		const mockProcess1 = createMockProcess();
		const mockProcess2 = createMockProcess();

		const entry1: ProcessPoolEntry = {
			process: mockProcess1,
			model: "model/test",
			thinkingLevel: "off",
			idle: true,
			lastUsed: Date.now(),
			stdoutBuffer: "",
			cwd: "/tmp",
			stderr: "",
		};

		const entry2: ProcessPoolEntry = {
			process: mockProcess2,
			model: "model/test",
			thinkingLevel: "off",
			idle: false,
			lastUsed: Date.now(),
			stdoutBuffer: "",
			cwd: "/tmp",
			stderr: "",
		};

		(pool as any).entries = [entry1, entry2];

		pool.shutdown();

		expect(mockProcess1.kill).toHaveBeenCalledWith("SIGTERM");
		expect(mockProcess2.kill).toHaveBeenCalledWith("SIGTERM");
		expect((pool as any).entries.length).toBe(0);
	});

	it("sendTask writes prompt to stdin and resolves on close", async () => {
		const pool = new ProcessPool(2, 120_000);
		const mockProcess = createMockProcess();

		const entry: ProcessPoolEntry = {
			process: mockProcess,
			model: "model/test",
			thinkingLevel: "off",
			idle: false,
			lastUsed: Date.now(),
			stdoutBuffer: "",
			cwd: "/tmp",
			stderr: "",
		};

		(pool as any).entries = [entry];

		// Start sendTask
		const taskPromise = pool.sendTask(entry, "test task");

		// Give a tick for the promise to start
		await new Promise((r) => setTimeout(r, 10));

		// Check stdin.write was called with the prompt
		expect(mockProcess.stdin.write).toHaveBeenCalledWith(
			JSON.stringify({ type: "prompt", message: "test task" }) + "\n",
		);

		// Simulate process exit to resolve the promise
		mockProcess.emit("close", 0);

		const result = await taskPromise;
		expect(result.exitCode).toBe(0);
		pool.shutdown();
	});
});

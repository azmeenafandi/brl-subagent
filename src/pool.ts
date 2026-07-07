/**
 * brl-subagent — Process Pool (E11)
 *
 * Manages warm pi processes in RPC mode to reduce cold-start latency.
 * Each pool entry holds a spawned pi process that stays alive between tasks.
 * The pool lazily spawns processes on acquire and cleans up idle entries
 * on a periodic timer.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { getPiInvocation, accumulateUsage, parseSubagentLine } from "./runner";
import type { SubagentResult, UsageStats, ThinkingLevel } from "./types";
import { EMPTY_USAGE, SIGKILL_GRACE_MS } from "./types";
import { getSafeEnv, DEPTH_ENV_KEY } from "./sanitize";
import type { Logger } from "./logging";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProcessPoolEntry {
	/** The underlying child process */
	process: ChildProcess;
	/** Model string (provider/id) this process was started with */
	model: string;
	/** Thinking level this process was started with */
	thinkingLevel: string;
	/** Whether the process is currently idle (not handling a task) */
	idle: boolean;
	/** Timestamp of last use (Date.now()) */
	lastUsed: number;
	/** Accumulates raw stdout data for line parsing */
	stdoutBuffer: string;
	/** CWD used to spawn this process */
	cwd: string;
	/** Stderr accumulator for diagnostics */
	stderr: string;
}

// ---------------------------------------------------------------------------
// ProcessPool
// ---------------------------------------------------------------------------

export class ProcessPool {
	private entries: ProcessPoolEntry[] = [];
	private maxSize: number;
	private idleTimeoutMs: number;
	private cleanupTimer: ReturnType<typeof setInterval> | null = null;
	private log?: Logger;

	constructor(maxSize: number = 4, idleTimeoutMs: number = 120_000, log?: Logger) {
		this.maxSize = Math.min(maxSize, 8);
		this.idleTimeoutMs = idleTimeoutMs;
		this.log = log;

		// Start periodic cleanup
		this.cleanupTimer = setInterval(() => this.cleanupIdle(), this.idleTimeoutMs / 2);
		// Allow the timer to not keep the process alive
		if (this.cleanupTimer?.unref) {
			this.cleanupTimer.unref();
		}
	}

	// -------------------------------------------------------------------
	// preWarm
	// -------------------------------------------------------------------

	/**
	 * Spawn `count` pi processes in RPC mode and add them to the pool.
	 * Each process is started with --mode rpc --no-session.
	 * Resolves once all processes are ready (session header received).
	 */
	async preWarm(count: number, cwd: string, model: string, thinkingLevel: string): Promise<void> {
		const spawnCount = Math.min(count, this.maxSize - this.entries.length);
		if (spawnCount <= 0) return;

		const promises: Promise<void>[] = [];
		for (let i = 0; i < spawnCount; i++) {
			promises.push(
				this.spawnEntry(cwd, model, thinkingLevel).then(() => {}),
			);
		}
		await Promise.all(promises);
	}

	// -------------------------------------------------------------------
	// acquire
	// -------------------------------------------------------------------

	/**
	 * Find an idle entry matching model+thinkingLevel.
	 * If none found and pool is under maxSize, spawn a new one.
	 * If pool is full, returns null (caller falls back to fresh spawn).
	 */
	async acquire(cwd: string, model: string, thinkingLevel: string): Promise<ProcessPoolEntry | null> {
		// Try to find an idle match
		const match = this.entries.find(
			(e) => e.idle && e.model === model && e.thinkingLevel === thinkingLevel && e.cwd === cwd,
		);
		if (match) {
			match.idle = false;
			match.lastUsed = Date.now();
			match.stdoutBuffer = "";
			match.stderr = "";
			this.log?.debug("Pool: acquired existing idle process", { model, pid: match.process.pid });
			return match;
		}

		// Spawn new if under capacity
		if (this.entries.length < this.maxSize) {
			const entry = await this.spawnEntry(cwd, model, thinkingLevel);
			entry.idle = false;
			this.log?.debug("Pool: spawned new process", { model, pid: entry.process.pid });
			return entry;
		}

		this.log?.debug("Pool: no idle match and pool full, returning null", {
			model,
			entries: this.entries.length,
		});
		return null;
	}

	// -------------------------------------------------------------------
	// release
	// -------------------------------------------------------------------

	/**
	 * Mark the process as idle and update lastUsed timestamp.
	 */
	release(entry: ProcessPoolEntry): void {
		entry.idle = true;
		entry.lastUsed = Date.now();
		entry.stdoutBuffer = "";
		entry.stderr = "";
		this.log?.debug("Pool: released process", { pid: entry.process.pid });
	}

	// -------------------------------------------------------------------
	// shutdown
	// -------------------------------------------------------------------

	/**
	 * Kill all processes in the pool and stop the cleanup timer.
	 */
	shutdown(): void {
		if (this.cleanupTimer) {
			clearInterval(this.cleanupTimer);
			this.cleanupTimer = null;
		}
		for (const entry of this.entries) {
			this.killEntry(entry);
		}
		this.entries = [];
		this.log?.info("Pool: shut down all processes");
	}

	// -------------------------------------------------------------------
	// cleanupIdle
	// -------------------------------------------------------------------

	/**
	 * Kill processes that have been idle longer than idleTimeoutMs.
	 * Always leaves at least 1 process if maxSize > 0 and there are
	 * idle processes (to avoid fully draining on idle timeout).
	 */
	cleanupIdle(): void {
		const now = Date.now();
		const toRemove: ProcessPoolEntry[] = [];

		for (const entry of this.entries) {
			if (!entry.idle) continue;
			if (now - entry.lastUsed > this.idleTimeoutMs) {
				// Always keep at least 1 idle process if pool has capacity
				const idleCount = this.entries.filter((e) => e.idle && !toRemove.includes(e)).length;
				if (idleCount <= 1 && this.maxSize > 0) break;
				toRemove.push(entry);
			}
		}

		for (const entry of toRemove) {
			this.killEntry(entry);
			this.entries = this.entries.filter((e) => e !== entry);
		}
	}

	// -------------------------------------------------------------------
	// sendTask
	// -------------------------------------------------------------------

	/**
	 * Send a prompt command to a pool process and read the response.
	 * Returns a SubagentResult when agent_end is received.
	 */
	async sendTask(
		entry: ProcessPoolEntry,
		task: string,
		timeout?: number,
		onUpdate?: (partial: { content: Array<{ type: string; text: string }>; details: SubagentResult }) => void,
		getFinalOutputFn?: (messages: Array<Record<string, unknown>>) => string,
	): Promise<SubagentResult> {
		const result: SubagentResult = {
			messages: [],
			usage: { ...EMPTY_USAGE },
			exitCode: 0,
			stderr: "",
		};

		return new Promise<SubagentResult>((resolve) => {
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;

			const settle = (exitCode: number, errorMessage?: string) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				result.exitCode = exitCode;
				if (errorMessage) result.errorMessage = errorMessage;
				resolve(result);
			};

			// Set up timeout
			if (timeout && timeout > 0) {
				timer = setTimeout(() => {
					settle(1, `Subagent timed out after ${timeout}ms`);
					this.killEntry(entry);
				}, timeout);
			}

			// Remove existing listeners and re-attach
			entry.process.stdout?.removeAllListeners("data");
			entry.process.stderr?.removeAllListeners("data");

			const getOutputFn = getFinalOutputFn ?? (() => "");

			entry.process.stdout?.on("data", (data: Buffer) => {
				entry.stdoutBuffer += data.toString();
				const lines = entry.stdoutBuffer.split("\n");
				entry.stdoutBuffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line) as Record<string, unknown>;
						parseSubagentLine(line, result, onUpdate as never, getOutputFn);

						// Check for agent_end / session end
						if (event.type === "agent_end" || event.type === "session_end") {
							settle(0);
							return;
						}
					} catch {
						// Non-JSON line — accumulate in stderr for diagnostics
						entry.stderr += line + "\n";
					}
				}
			});

			entry.process.stderr?.on("data", (data: Buffer) => {
				entry.stderr += data.toString();
			});

			entry.process.on("close", (code) => {
				if (entry.stdoutBuffer.trim()) {
					try {
						const event = JSON.parse(entry.stdoutBuffer) as Record<string, unknown>;
						parseSubagentLine(entry.stdoutBuffer, result, onUpdate as never, getOutputFn);
						if (event.type === "agent_end" || event.type === "session_end") {
							settle(code ?? 0);
							return;
						}
					} catch {
						entry.stderr += entry.stdoutBuffer;
					}
				}
				settle(code ?? 0);
			});

			entry.process.on("error", (err) => {
				settle(1, `Subprocess error: ${err.message}`);
			});

			// Send the prompt
			const prompt = JSON.stringify({ type: "prompt", message: task }) + "\n";
			entry.process.stdin?.write(prompt);
		});
	}

	// -------------------------------------------------------------------
	// Private helpers
	// -------------------------------------------------------------------

	private spawnEntry(cwd: string, model: string, thinkingLevel: string): Promise<ProcessPoolEntry> {
		return new Promise<ProcessPoolEntry>((resolve, reject) => {
			const invocation = getPiInvocation([
				"--mode", "rpc",
				"--no-session",
				"--model", model,
				"--thinking", thinkingLevel,
			]);

			const proc = spawn(invocation.command, invocation.args, {
				cwd,
				shell: false,
				stdio: ["pipe", "pipe", "pipe"],
				env: getSafeEnv(),
			});

			const entry: ProcessPoolEntry = {
				process: proc,
				model,
				thinkingLevel,
				idle: true,
				lastUsed: Date.now(),
				stdoutBuffer: "",
				cwd,
				stderr: "",
			};

			let headerBuffer = "";
			let resolved = false;

			const onData = (data: Buffer) => {
				headerBuffer += data.toString();
				const lines = headerBuffer.split("\n");
				headerBuffer = lines.pop() ?? "";
				for (const line of lines) {
					if (!line.trim()) continue;
					try {
						const event = JSON.parse(line) as Record<string, unknown>;
						if (event.type === "session") {
							// Session header received — process is ready
							resolved = true;
							proc.stdout?.off("data", onData);
							resolve(entry);
							return;
						}
					} catch {
						// Not JSON yet, keep reading
					}
				}
			};

			proc.stdout?.on("data", onData);

			proc.on("error", (err) => {
				proc.stdout?.off("data", onData);
				if (!resolved) reject(err);
			});

			proc.on("close", (code) => {
				proc.stdout?.off("data", onData);
				if (!resolved) {
					reject(new Error(`Pool process exited during startup with code ${code}`));
				}
			});

			// Safety: reject if no header within 10s
			const safetyTimer = setTimeout(() => {
				if (!resolved) {
					proc.stdout?.off("data", onData);
					proc.kill("SIGKILL");
					reject(new Error("Pool process startup timeout (no session header within 10s)"));
				}
			}, 10_000);

			// Allow the timer to not keep the process alive
			if (safetyTimer.unref) safetyTimer.unref();
		});
	}

	private killEntry(entry: ProcessPoolEntry): void {
		try {
			entry.process.kill("SIGTERM");
			setTimeout(() => {
				if (!entry.process.killed) {
					entry.process.kill("SIGKILL");
				}
			}, SIGKILL_GRACE_MS);
		} catch {
			// Process may already be dead
		}
	}
}

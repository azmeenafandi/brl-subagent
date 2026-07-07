/**
 * brl-subagent — Pluggable Backends (E8)
 *
 * Abstraction layer for subagent execution backends.
 * Currently supports:
 *   - "pi"         — Full pi process with tools (default)
 *   - "direct-api" — Direct HTTP API call, no tools (skeleton)
 */

import type { SubagentResult, ThinkingLevel } from "./types";
import { EMPTY_USAGE } from "./types";

// ---------------------------------------------------------------------------
// Backend interface
// ---------------------------------------------------------------------------

export interface Backend {
	/** Human-readable backend name */
	name: string;
	/** Whether this backend supports tool execution */
	supportsTools: boolean;
	/**
	 * Execute a task using this backend.
	 * @param task - The task description
	 * @param model - Model identifier string (e.g. "openai/gpt-4o")
	 * @param thinkingLevel - Requested thinking level
	 * @param signal - Optional abort signal
	 */
	execute(
		task: string,
		model: string,
		thinkingLevel: string,
		signal?: AbortSignal,
	): Promise<SubagentResult>;
}

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const DEFAULT_BACKEND = "pi";
export const AVAILABLE_BACKENDS: string[] = ["pi", "direct-api"];

// ---------------------------------------------------------------------------
// PiBackend — wraps existing runSubagent
// ---------------------------------------------------------------------------

export class PiBackend implements Backend {
	name = "pi";
	supportsTools = true;

	async execute(
		_task: string,
		_model: string,
		_thinkingLevel: string,
		_signal?: AbortSignal,
	): Promise<SubagentResult> {
		// PiBackend execution is handled directly in runSubagent when
		// backend.name === "pi" (or no backend is provided). This method
		// exists for interface consistency but is not called in the normal
		// code path — the runner.ts special-cases the pi backend to use
		// the full spawn logic with system prompts, temp files, etc.
		return {
			messages: [],
			usage: { ...EMPTY_USAGE },
			exitCode: 0,
			stderr: "",
		};
	}
}

// ---------------------------------------------------------------------------
// DirectBackend — direct HTTP API call (skeleton)
// ---------------------------------------------------------------------------

export class DirectBackend implements Backend {
	name = "direct-api";
	supportsTools = false;

	async execute(
		_task: string,
		_model: string,
		_thinkingLevel: string,
		signal?: AbortSignal,
	): Promise<SubagentResult> {
		// Check for abort before starting
		if (signal?.aborted) {
			return {
				messages: [],
				usage: { ...EMPTY_USAGE },
				exitCode: 1,
				stderr: "",
				errorMessage: "Aborted",
				stopReason: "aborted",
			};
		}

		// Skeleton: return a placeholder result.
		// In production, this would use the same API key/auth as pi's
		// providers to make a direct HTTP fetch to the model API.
		return {
			messages: [
				{
					role: "assistant",
					content: [
						{
							type: "text",
							text: "Direct API backend is not yet implemented. Use the default pi backend.",
						},
					],
				},
			],
			usage: { ...EMPTY_USAGE },
			exitCode: 0,
			stderr: "",
		};
	}
}

// ---------------------------------------------------------------------------
// Backend registry
// ---------------------------------------------------------------------------

const backends: Record<string, Backend> = {
	pi: new PiBackend(),
	"direct-api": new DirectBackend(),
};

/**
 * Get a backend by name.
 * @param name - Backend name ("pi" or "direct-api")
 * @returns The Backend instance, or undefined if not found
 */
export function getBackend(name: string): Backend | undefined {
	return backends[name];
}

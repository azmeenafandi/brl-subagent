/**
 * brl-subagent — Type Definitions
 *
 * All shared type definitions and constants for the brl-subagent extension.
 */

import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

// ---------------------------------------------------------------------------
// Core types
// ---------------------------------------------------------------------------

export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export const THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh"];

export type ErrorCategory =
	| "timeout"
	| "model_unavailable"
	| "tool_error"
	| "permission_denied"
	| "parse_error"
	| "aborted"
	| "exit_error"
	| "crash"
	| "unknown";

/**
 * Classify a subagent result into an error category based on its errorMessage,
 * stopReason, exitCode, and stderr content. Inspects patterns in priority order.
 */
export function classifyError(result: SubagentResult): ErrorCategory {
	if (result.stopReason === "aborted") return "aborted";

	const msg = (result.errorMessage ?? "").toLowerCase();
	const err = (result.stderr ?? "").toLowerCase();

	if (msg.includes("timed out")) return "timeout";

	if (msg.includes("model not found") || msg.includes("model unavailable"))
		return "model_unavailable";

	if (msg.includes("permission denied") || msg.includes("eacces")) return "permission_denied";

	if (err.includes("parse error") || err.includes("parse_error") || err.includes("unexpected token"))
		return "parse_error";

	if (err.includes("crash") || err.includes("panic") || err.includes("segmentation fault"))
		return "crash";

	if (msg.includes("spawn") || msg.includes("not found") || msg.includes("enoent"))
		return "tool_error";

	if (result.exitCode !== 0) return "exit_error";

	if (result.stopReason === "error") return "exit_error";

	return "unknown";
}

export interface SubagentPreset {
	name: string;
	description?: string;
	systemPrompt?: string;
	inheritSystemPrompt?: boolean;
	thinkingLevel?: string;
	outputFile?: string;
	timeout?: number;
	tools?: string[];
	excludeTools?: string[];
	noBuiltinTools?: boolean;
}

export interface CircuitBreakerState {
	consecutiveFailures: number;
	lastFailureTime: number; // epoch ms
	circuitOpen: boolean;
	degradedThinkingLevel?: ThinkingLevel;
}

export type GitMode = "branch" | "none";

export interface SubagentState {
	model?: { provider: string; id: string };
	maxThinkingLevel: ThinkingLevel;
	maxParallel: number; // 0 = unlimited
	maxSubagentDepth: number; // 0 = no recursion allowed, 1 = one level, etc.
	gitMode: GitMode; // P3: branch-based git workflow
	maxHistoryEntries: number; // 0 = unlimited
	sessionCostLimit: number; // 0 = unlimited
	perTaskCostEstimate: number; // 0 = no estimate, use default
	seenRunIds: string[];
	presets: SubagentPreset[];
	circuitBreaker: CircuitBreakerState;
}

export interface SubagentRun {
	id: string;
	task: string;
	label?: string;
	status: "running" | "done" | "failed";
	model: string;
	thinkingLevel: string;
	startedAt: string;
	finishedAt?: string;
	durationMs?: number;
	cost?: number;
	tokensIn?: number;
	tokensOut?: number;
	errorMessage?: string;
	outputSummary?: string;
	fullOutput?: string;
	originalParams?: {
		systemPrompt?: string;
		inheritSystemPrompt?: boolean;
		thinkingLevel?: string;
		outputFile?: string;
		timeout?: number;
		cwd?: string;
		tools?: string[];
		excludeTools?: string[];
		noBuiltinTools?: boolean;
		preset?: string;
		errorCategory?: ErrorCategory;
	};
}

export interface LiveSubagent {
	id: string;
	label?: string;
	task: string;
	model: string;
	thinkingLevel: string;
	startedAt: number;
	liveOutput: string;
	usage: { input: number; output: number };
	ctx: ExtensionContext;
}

export interface UsageStats {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
	contextTokens: number;
	turns: number;
}

export interface SubagentResult {
	messages: Array<Record<string, unknown>>;
	model?: string;
	usage: UsageStats;
	stopReason?: string;
	errorMessage?: string;
	exitCode: number;
	stderr: string;
	label?: string;
	errorCategory?: ErrorCategory;
	// P3: Git integration fields
	gitBranch?: string;
	gitDiff?: string;
}

export interface SubagentToolOptions {
	tools?: string[];
	excludeTools?: string[];
	noBuiltinTools?: boolean;
}

// ---------------------------------------------------------------------------
// P1+P2: Task chaining & parallel mode types
// ---------------------------------------------------------------------------

/** One step in a chain or one task in a parallel group. */
export interface SubTaskParams {
	task: string;
	label?: string;
	preset?: string;
	thinkingLevel?: string;
	systemPrompt?: string;
	inheritSystemPrompt?: boolean;
	cwd?: string;
	timeout?: number;
	outputFile?: string;
	tools?: string[];
	excludeTools?: string[];
	noBuiltinTools?: boolean;
}

/** Result of a single subtask execution. */
export interface SubTaskResult {
	label?: string;
	task: string;
	step?: number;
	exitCode: number;
	messages: Array<Record<string, unknown>>;
	stderr: string;
	usage: UsageStats;
	model?: string;
	stopReason?: string;
	errorMessage?: string;
	errorCategory?: ErrorCategory;
	gitBranch?: string;
	gitDiff?: string;
}

/** Aggregate result for chain and parallel modes. */
export interface MultiSubagentDetails {
	mode: "chain" | "parallel";
	results: SubTaskResult[];
	totalInput: number;
	totalOutput: number;
	totalCost: number;
	totalTurns: number;
}

export interface ChainDetails extends MultiSubagentDetails {
	mode: "chain";
	completedSteps: number;
	totalSteps: number;
	stoppedEarly: boolean;
}

export interface ParallelDetails extends MultiSubagentDetails {
	mode: "parallel";
	succeeded: number;
	failed: number;
}

// ---------------------------------------------------------------------------
// Resolved params (after preset merging + validation)
// ---------------------------------------------------------------------------

export interface ResolvedParams {
	task: string;
	label: string | undefined;
	inheritSP: boolean;
	customSP: string | undefined;
	outputFile: string | undefined;
	timeout: number | undefined;
	effectiveCwd: string;
	thinkingLevel: ThinkingLevel;
	toolOptions: SubagentToolOptions | undefined;
}

// ---------------------------------------------------------------------------
// Log levels
// ---------------------------------------------------------------------------

export type LogLevel = "debug" | "info" | "warn" | "error";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const EMPTY_USAGE: UsageStats = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	cost: 0,
	contextTokens: 0,
	turns: 0,
};

export const NAV_FOOTER = "\u2191\u2193 navigate \u2022 enter select \u2022 esc cancel";

export const SIGKILL_GRACE_MS = 5000;
export const STATUS_RESET_DELAY_MS = 3000;
export const TEMP_FILE_MODE = 0o600;
export const TASK_PREVIEW_MAX_LENGTH = 80;
export const COLLAPSED_OUTPUT_LINES = 5;
export const DEFAULT_OUTPUT_CAP_BYTES = 100 * 1024; // 100KB

export const MAX_RUN_HISTORY_ENTRIES = 500;
export const MAX_TEMP_DIR_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

// Circuit breaker constants
export const MAX_CONSECUTIVE_FAILURES = 5;
export const CIRCUIT_BREAKER_RESET_MS = 60000; // 1 min auto-recovery
export const CIRCUIT_DEGRADED_THINKING: ThinkingLevel = "minimal";

export const DEFAULT_SESSION_COST_LIMIT = 0;

export const CUSTOM_ENTRY_TYPES = {
	run: "brl-subagent-run",
	state: "brl-subagent-state",
} as const;

// ---------------------------------------------------------------------------
// P1+P2: Chain / parallel constants
// ---------------------------------------------------------------------------

export const MAX_CHAIN_STEPS = 10;
export const MAX_PARALLEL_TASKS = 8;
export const PREVIOUS_OUTPUT_PLACEHOLDER = "{previous}";

// ---------------------------------------------------------------------------
// Helper functions
// ---------------------------------------------------------------------------

export function resolveThinkingLevel(
	requested: ThinkingLevel | undefined,
	maxAllowed: ThinkingLevel,
): ThinkingLevel {
	if (!requested) return maxAllowed;
	const requestedIdx = THINKING_LEVELS.indexOf(requested);
	const maxIdx = THINKING_LEVELS.indexOf(maxAllowed);
	return THINKING_LEVELS[Math.min(requestedIdx, maxIdx)];
}

export function formatTokens(count: number): string {
	if (count < 1000) return count.toString();
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	return `${(count / 1_000_000).toFixed(1)}M`;
}

export function formatUsageStats(usage: UsageStats, model?: string): string {
	const parts: string[] = [];
	if (usage.turns) parts.push(`${usage.turns} turn${usage.turns > 1 ? "s" : ""}`);
	if (usage.input) parts.push(`↑${formatTokens(usage.input)}`);
	if (usage.output) parts.push(`↓${formatTokens(usage.output)}`);
	if (usage.cacheRead) parts.push(`R${formatTokens(usage.cacheRead)}`);
	if (usage.cacheWrite) parts.push(`W${formatTokens(usage.cacheWrite)}`);
	if (usage.cost) parts.push(`$${usage.cost.toFixed(4)}`);
	if (usage.contextTokens > 0) parts.push(`ctx:${formatTokens(usage.contextTokens)}`);
	if (model) parts.push(model);
	return parts.join(" ");
}

export function getFinalOutput(messages: Array<Record<string, unknown>>): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i] as Record<string, unknown>;
		if (msg.role === "assistant") {
			const content = msg.content as Array<Record<string, unknown>> | undefined;
			if (content) {
				for (const part of content) {
					if (part.type === "text") return part.text as string;
				}
			}
		}
	}
	return "";
}

export function isSubagentError(result: SubagentResult): boolean {
	return result.exitCode !== 0
		|| result.stopReason === "error"
		|| result.stopReason === "aborted";
}

export function formatModel(m: { provider: string; id: string } | undefined): string {
	return m ? `${m.provider}/${m.id}` : "Not set (will use main agent\u2019s model)";
}

export function formatMaxParallel(n: number): string {
	return n === 0 ? "unlimited" : String(n);
}

/**
 * Type guard: checks if a value is a valid state object shape.
 * Used to safely restore persisted state without `as any` casts.
 */
export function isSubagentStateShape(value: unknown): value is SubagentState {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;

	// model is optional but must be valid if present
	if (v.model !== undefined && v.model !== null) {
		if (typeof v.model !== "object") return false;
		const m = v.model as Record<string, unknown>;
		if (typeof m.provider !== "string" || typeof m.id !== "string") return false;
	}

	// maxThinkingLevel must be a valid level if present
	if (v.maxThinkingLevel !== undefined && typeof v.maxThinkingLevel === "string") {
		if (!THINKING_LEVELS.includes(v.maxThinkingLevel as ThinkingLevel)) return false;
	}

	// maxParallel must be a non-negative number
	if (v.maxParallel !== undefined) {
		if (typeof v.maxParallel !== "number" || v.maxParallel < 0) return false;
	}

	// maxSubagentDepth must be a non-negative number if present
	if (v.maxSubagentDepth !== undefined) {
		if (typeof v.maxSubagentDepth !== "number" || v.maxSubagentDepth < 0) return false;
	}

	// gitMode must be "branch" or "none" if present
	if (v.gitMode !== undefined) {
		if (v.gitMode !== "branch" && v.gitMode !== "none") return false;
	}

	// maxHistoryEntries must be a non-negative number if present
	if (v.maxHistoryEntries !== undefined) {
		if (typeof v.maxHistoryEntries !== "number" || v.maxHistoryEntries < 0) return false;
	}

	// sessionCostLimit must be a non-negative number if present
	if (v.sessionCostLimit !== undefined) {
		if (typeof v.sessionCostLimit !== "number" || v.sessionCostLimit < 0) return false;
	}

	// perTaskCostEstimate must be a non-negative number if present
	if (v.perTaskCostEstimate !== undefined) {
		if (typeof v.perTaskCostEstimate !== "number" || v.perTaskCostEstimate < 0) return false;
	}

	return true;
}

/**
 * Type guard: validates a SubagentRun entry shape.
 */
export function isSubagentRunShape(value: unknown): value is SubagentRun {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (typeof v.id !== "string") return false;
	if (typeof v.task !== "string") return false;
	if (!["running", "done", "failed"].includes(v.status as string)) return false;
	return true;
}

/**
 * Type guard: checks if a value is a valid MultiSubagentDetails shape.
 */
export function isMultiSubagentDetails(value: unknown): value is MultiSubagentDetails {
	if (!value || typeof value !== "object") return false;
	const v = value as Record<string, unknown>;
	if (v.mode !== "chain" && v.mode !== "parallel") return false;
	if (!Array.isArray(v.results)) return false;
	if (typeof v.totalInput !== "number") return false;
	if (typeof v.totalOutput !== "number") return false;
	if (typeof v.totalCost !== "number") return false;
	if (typeof v.totalTurns !== "number") return false;
	return true;
}

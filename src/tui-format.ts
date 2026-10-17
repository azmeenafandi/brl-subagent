// Purpose: Pure TUI row formatting shared by the monitor and dashboard (no TUI imports).
/**
 * brl-subagent — Pure TUI formatting helpers
 *
 * Row-render logic shared by the live monitor and dashboard "Active
 * Subagents" panel. Kept free of pi-tui imports so it is unit-testable
 * without a TUI harness.
 */

import { DEFAULT_SLA_WINDOW_SIZE, formatTokens, isInterruptedRun } from "./types";
import type { SubagentRun } from "./types";

/** Braille spinner frames, indexed by Math.floor(now / 150) % 10. */
export const LIVE_SPINNER_FRAMES: readonly string[] = [
	"\u280B",
	"\u2819",
	"\u2839",
	"\u2838",
	"\u283C",
	"\u2834",
	"\u2826",
	"\u2827",
	"\u2807",
	"\u280F",
];

/**
 * Format an elapsed duration (ms) as a compact string, e.g. "5s", "1m 5s".
 * Unified format: minutes and seconds are separated by a space.
 */
export function formatElapsed(ms: number): string {
	const elapsed = Math.round(ms / 1000);
	return elapsed < 60 ? `${elapsed}s` : `${Math.floor(elapsed / 60)}m ${elapsed % 60}s`;
}

/** Live row display name: explicit label wins, else task truncated to 40 chars. */
export function liveRowName(label: string | undefined, task: string): string {
	return label || task.slice(0, 40);
}

/** Spinner frame at a given timestamp (ms since epoch). */
export function liveSpinner(now: number): string {
	return LIVE_SPINNER_FRAMES[Math.floor(now / 150) % 10];
}

/** Dim section of a live row: short id + token counts + elapsed. */
export function formatLiveRowDim(
	id: string,
	usage: { input: number; output: number },
	elapsedStr: string,
): string {
	return `  [${id.slice(0, 8)}]  \u2191${formatTokens(usage.input)} \u2193${formatTokens(usage.output)}  ${elapsedStr}`;
}

/**
 * Display name for a Run History / retry-surface row, shared by BOTH surfaces
 * so they can never name the same run differently (Fix B item 5). Explicit
 * label wins, else the task truncated to 60 chars, else the short id — the last
 * case being a task-less foreground-interrupted row (no task persisted).
 */
export function runDisplayName(run: Pick<SubagentRun, "id" | "label" | "task">): string {
	return run.label || run.task.slice(0, 60) || run.id.slice(0, 8);
}

// ---------------------------------------------------------------------------
// U3 (D1/D3): Run History / retry-surface row projection
// ---------------------------------------------------------------------------

/**
 * The human status of a Run History row. Keys on `isInterruptedRun` FIRST, so a
 * run marked interrupted renders as `interrupted` and NEVER falls through to its
 * raw `\"running\"` status (D1). The raw status is only consulted for an
 * unmarked record.
 */
export type RunHistoryStatus = "interrupted" | "running" | "done" | "failed";

export function runHistoryStatus(run: SubagentRun): RunHistoryStatus {
	if (isInterruptedRun(run)) return "interrupted";
	if (run.status === "done" || run.status === "failed") return run.status;
	return "running";
}

/** Human label for a Run History row's status. */
export function runHistoryStatusLabel(run: SubagentRun): string {
	switch (runHistoryStatus(run)) {
		case "interrupted":
			return "Interrupted";
		case "done":
			return "Completed";
		case "failed":
			return "Failed";
		default:
			return "Running";
	}
}

/**
 * The offer text shown when a retry-surface row is selected. Names the run id
 * and the `retryRunId` parameter explicitly (D3), so the conductor re-dispatches
 * the recorded task/params without a new delegate_task parameter.
 */
export function buildRetryOfferMessage(run: SubagentRun): string {
	const statusWord = isInterruptedRun(run) ? "interrupted" : "failed";
	return (
		`Ask the LLM to retry: "Use delegate_task with retryRunId: ${run.id} ` +
		`to retry the ${statusWord} run ${run.id.slice(0, 8)} with its recorded params."`
	);
}

// ---------------------------------------------------------------------------
// Menu polish U1: canonical menu value vocabulary + divider factory (umbrella #345)
// ---------------------------------------------------------------------------

/**
 * Every menu row kind whose displayed value has a canonical spelling. The
 * strings are the contract: later units consume these tokens instead of
 * hand-rolling prose per call site (and the tests assert the tokens, not prose).
 */
export type MenuValueKind =
	| "model"
	| "thinking"
	| "parallel"
	| "depth"
	| "approval"
	| "completionnotify"
	| "recovery"
	| "historyentries"
	| "costlimit"
	| "sla"
	| "presetCounts"
	| "templateCounts";

/**
 * One kind's canonical tokens. `unset` is the spelling for a missing value (and
 * for numeric zero when the kind folds zero into unset); `values` maps a stored
 * enum value to its display token. Kinds whose normal form is templated
 * (`N levels`, `$N.NN`) carry only the tokens that are fixed.
 */
export interface MenuValueTokenSet {
	readonly unset?: string;
	readonly values?: Readonly<Record<string, string>>;
}

/** The single source of the menu value vocabulary (U1). */
export const MENU_VALUE_TOKENS = {
	model: { unset: "Not set" },
	thinking: {},
	parallel: { unset: "Unlimited" },
	depth: { unset: "Off" },
	approval: {
		values: { auto: "Never ask", writes: "Ask on writes", always: "Ask every time" },
	},
	completionnotify: {
		values: { all: "Every run", failed: "Failed only", off: "Off" },
	},
	recovery: { values: { offer: "On", off: "Off" } },
	historyentries: { unset: "Unlimited" },
	costlimit: { unset: "Unlimited" },
	sla: { values: { off: "Off" } },
	presetCounts: {},
	templateCounts: {},
} as const satisfies Record<MenuValueKind, MenuValueTokenSet>;

/** Canonical fallback when a kind has no value or no specific unset token. */
const DEFAULT_UNSET_TOKEN = "Not set";

/**
 * Structural input for {@link formatMenuValue}. Deliberately not `SessionState`
 * (this module's architecture ratchet permits `./types` only, and a structural
 * shape keeps every kind independently testable). Every field is optional: an
 * absent field degrades to the kind's canonical unset token.
 */
export interface MenuValueInput {
	model?: { provider: string; id: string };
	maxThinkingLevel?: string;
	maxParallel?: number;
	maxSubagentDepth?: number;
	approvalMode?: string;
	completionNotify?: string;
	recovery?: string;
	maxHistoryEntries?: number;
	sessionCostLimit?: number;
	slaTrackingEnabled?: boolean;
	slaWindowSize?: number;
	builtinCount?: number;
	customCount?: number;
}

/** Widened view of one kind's token set (the literal table keeps per-key types). */
function tokensFor(kind: MenuValueKind): MenuValueTokenSet {
	return MENU_VALUE_TOKENS[kind] as MenuValueTokenSet;
}

/** Look up an enum token, falling back to the kind's canonical unset token. */
function enumToken(kind: MenuValueKind, value: string | undefined): string {
	const values = tokensFor(kind).values;
	const token = value === undefined ? undefined : values?.[value];
	return token ?? formatUnset(kind);
}

/** The canonical unset/zero token for a kind (default `Not set`). */
export function formatUnset(kind?: MenuValueKind): string {
	if (!kind) return DEFAULT_UNSET_TOKEN;
	return tokensFor(kind).unset ?? DEFAULT_UNSET_TOKEN;
}

/**
 * Format a menu row's value using the canonical vocabulary. Pure. Numeric zero
 * is the kind's unset token where the spec folds unlimited/off into zero
 * (`parallel`, `depth`, `historyentries`, `costlimit`).
 */
export function formatMenuValue(kind: MenuValueKind, input: MenuValueInput = {}): string {
	switch (kind) {
		case "model":
			return input.model ? `${input.model.provider}/${input.model.id}` : formatUnset(kind);
		case "thinking":
			return input.maxThinkingLevel ?? formatUnset(kind);
		case "parallel":
			if (input.maxParallel === undefined) return formatUnset(kind);
			return input.maxParallel === 0 ? formatUnset(kind) : String(input.maxParallel);
		case "depth": {
			const depth = input.maxSubagentDepth;
			if (depth === undefined) return formatUnset(kind);
			if (depth === 0) return formatUnset(kind);
			return depth === 1 ? "1 level" : `${depth} levels`;
		}
		case "approval":
			return enumToken(kind, input.approvalMode);
		case "completionnotify":
			return enumToken(kind, input.completionNotify);
		case "recovery":
			return enumToken(kind, input.recovery);
		case "historyentries":
			if (input.maxHistoryEntries === undefined) return formatUnset(kind);
			return input.maxHistoryEntries === 0
				? formatUnset(kind)
				: `${input.maxHistoryEntries} entries`;
		case "costlimit":
			if (input.sessionCostLimit === undefined) return formatUnset(kind);
			return input.sessionCostLimit === 0
				? formatUnset(kind)
				: `$${input.sessionCostLimit.toFixed(2)}`;
		case "sla":
			if (input.slaTrackingEnabled === undefined) return formatUnset(kind);
			if (!input.slaTrackingEnabled) return tokensFor(kind).values?.off ?? "Off";
			return `On (window ${input.slaWindowSize ?? DEFAULT_SLA_WINDOW_SIZE})`;
		case "presetCounts":
		case "templateCounts":
			if (input.builtinCount === undefined && input.customCount === undefined) {
				return formatUnset(kind);
			}
			return `${input.builtinCount ?? 0} built-in, ${input.customCount ?? 0} custom`;
	}
}

/**
 * A select-list divider row. Structurally compatible with pi-tui's
 * `SelectItem`; declared locally so this module keeps importing only `./types`.
 */
export interface MenuSectionItem {
	value: string;
	label: string;
	description: string;
}

/** Kebab-case slug: lowercase, non-alphanumeric runs collapsed to `-`, trimmed. */
function slugify(label: string): string {
	return label
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

/** Build a select-list section divider, e.g. `─── Model ───`. Pure. */
export function menuSection(label: string): MenuSectionItem {
	return {
		value: `__divider__:${slugify(label)}`,
		label: `\u2500\u2500\u2500 ${label} \u2500\u2500\u2500`,
		description: "",
	};
}

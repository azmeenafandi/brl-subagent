// Purpose: Pure TUI row formatting shared by the monitor and dashboard (no TUI imports).
/**
 * brl-subagent — Pure TUI formatting helpers
 *
 * Row-render logic shared by the live monitor and dashboard "Active
 * Subagents" panel. Kept free of pi-tui imports so it is unit-testable
 * without a TUI harness.
 */

import {
	DEFAULT_SLA_WINDOW_SIZE,
	TEMPLATE_PARAM_RE,
	formatTokens,
	isInterruptedRun,
} from "./types";
import type { ModeContext, SubagentRun, TaskTemplate } from "./types";

/** Frame duration of the braille spinners (10 frames → a 1.5 s cycle). */
export const LIVE_SPINNER_FRAME_MS = 150;

/** Braille spinner frames, indexed by Math.floor(now / LIVE_SPINNER_FRAME_MS) % 10. */
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
	return LIVE_SPINNER_FRAMES[Math.floor(now / LIVE_SPINNER_FRAME_MS) % LIVE_SPINNER_FRAMES.length];
}

// ---------------------------------------------------------------------------
// Footer activity indicator (issue #354)
// ---------------------------------------------------------------------------

/**
 * The footer line's colour vocabulary — the subset of pi's `ThemeColor` the
 * status line uses, declared locally so this module keeps importing only
 * `./types`. `ctx.ui.theme` satisfies {@link ProgressStatusTheme} structurally,
 * which keeps the formatter free of any TUI import.
 */
export type ProgressStatusColor = "accent" | "success" | "warning" | "error" | "muted";

/** The one theme capability the footer needs. */
export interface ProgressStatusTheme {
	fg(color: ProgressStatusColor, text: string): string;
}

/**
 * The footer's input: the counter slice of `SessionState` plus the elapsed
 * anchor. Structural rather than `SessionState` so the formatter has no
 * dependency on session state and every case is unit-testable.
 */
export interface ProgressStatusInput {
	activeSubagents: number;
	completedSubagents: number;
	failedSubagents: number;
	unseenSubagents: number;
	/** Issue #133 multi-unit breakdown, present only while a dispatch is in flight. */
	modeContext?: ModeContext;
	/** Epoch ms at which the oldest active run started; absent → no elapsed suffix. */
	activeSinceMs?: number;
}

/** One coloured run of text on the footer line. */
export interface ProgressStatusSegment {
	color: ProgressStatusColor;
	text: string;
}

const STATUS_PREFIX = "brl:";
const DONE_SYMBOL = "\u2713";
const FAILED_SYMBOL = "\u2717";
/** Separator before the elapsed suffix — " · ", muted with the duration. */
const ELAPSED_SEPARATOR = " \u00b7 ";

/**
 * The completion segment's colour, decided by outcome: all success → success,
 * mixed → warning, failure-only → error (issue #354).
 */
export function progressCompletionColor(
	completed: number,
	failed: number,
): ProgressStatusColor {
	if (failed === 0) return "success";
	return completed > 0 ? "warning" : "error";
}

/** The #133 breakdown that qualifies the active count. */
function modeBreakdown(mc: ModeContext): string {
	return mc.kind === "graph"
		? `graph wave ${mc.wave}/${mc.totalWaves} \u00b7 node ${mc.node}/${mc.totalNodes}`
		: `chain step ${mc.step}/${mc.totalSteps}`;
}

/**
 * The footer as coloured segments, so the completion group can be painted as
 * one unit (symbols included) while the active segment and elapsed suffix take
 * their own colours. Pure: frame, counts and elapsed are all derived from
 * `now` and the counters.
 *
 * Shapes (issue #354):
 * - active:    `⠋ brl: 2 running, ✓ 1 done, ✗ 1 failed · 1m 14s`
 * - linger:    `✓ brl: 3 done (1 unseen), ✗ 1 failed` (no spinner, no elapsed)
 */
export function formatProgressSegments(
	state: ProgressStatusInput,
	now: number,
): ProgressStatusSegment[] {
	const active = state.activeSubagents > 0;
	const segments: ProgressStatusSegment[] = [];

	// Completion labels, kept separate from their symbols so the prefix can be
	// inserted after the first symbol on the linger line.
	const completion: Array<{ symbol: string; label: string }> = [];
	if (state.completedSubagents > 0) {
		const unseen = state.unseenSubagents > 0 ? ` (${state.unseenSubagents} unseen)` : "";
		completion.push({
			symbol: DONE_SYMBOL,
			label: `${state.completedSubagents} done${unseen}`,
		});
	}
	if (state.failedSubagents > 0) {
		completion.push({ symbol: FAILED_SYMBOL, label: `${state.failedSubagents} failed` });
	}

	if (active) {
		const detail: string[] = [];
		if (state.modeContext) detail.push(modeBreakdown(state.modeContext));
		detail.push(`${state.activeSubagents} running`);
		// The separator trailing the active segment stays with it, so the
		// completion segment is contiguous and can be coloured as a unit.
		segments.push({
			color: "accent",
			text: `${liveSpinner(now)} ${STATUS_PREFIX} ${detail.join(", ")}${completion.length > 0 ? ", " : ""}`,
		});
	}

	if (completion.length > 0) {
		// With no active run the segment carries the prefix itself:
		// `✓ brl: 3 done (1 unseen)`.
		const prefix = active ? "" : `${STATUS_PREFIX} `;
		const [first, ...rest] = completion;
		const text = [
			`${first.symbol} ${prefix}${first.label}`,
			...rest.map((part) => `${part.symbol} ${part.label}`),
		].join(", ");
		segments.push({
			color: progressCompletionColor(state.completedSubagents, state.failedSubagents),
			text,
		});
	}

	if (active && state.activeSinceMs !== undefined) {
		// Clamp at zero: a clock jump backwards must never print a negative age.
		const elapsed = formatElapsed(Math.max(0, now - state.activeSinceMs));
		segments.push({ color: "muted", text: `${ELAPSED_SEPARATOR}${elapsed}` });
	}

	return segments;
}

/**
 * The footer line as one themed string — the coloured form of
 * {@link formatProgressSegments}. Pure: every byte is a function of the
 * counters, `now` and the injected theme.
 */
export function formatProgressStatus(
	state: ProgressStatusInput,
	now: number,
	theme: ProgressStatusTheme,
): string {
	return formatProgressSegments(state, now)
		.map((segment) => theme.fg(segment.color, segment.text))
		.join("");
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
		case "historyentries": {
			const entries = input.maxHistoryEntries;
			if (entries === undefined) return formatUnset(kind);
			if (entries === 0) return formatUnset(kind);
			return entries === 1 ? "1 entry" : `${entries} entries`;
		}
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

// ---------------------------------------------------------------------------
// Menu polish U5: template manager row summary (umbrella #345)
// ---------------------------------------------------------------------------

/**
 * `${param}` slot names declared by a template, sorted and deduped. Mirrors
 * `templates.ts:extractParamNames` over the same `task + outputFile` text; the
 * loop is local because this module's architecture ratchet permits `./types`
 * only (the shared pattern lives there).
 */
function templateSlotNames(t: TaskTemplate): string[] {
	const names = new Set<string>();
	for (const match of (t.task + (t.outputFile ?? "")).matchAll(TEMPLATE_PARAM_RE)) {
		names.add(match[1]);
	}
	return [...names].sort();
}

/**
 * One-line summary of what a template WILL run with, used as the manager row's
 * description when the template declares no `description`:
 * `preset:<name> · thinking:<level> · slots <a>, <b>` — absent parts omitted.
 * A template declaring none of these falls back to the first 60 characters of
 * its task, which is what every row showed before U5.
 */
export function formatTemplateSummary(t: TaskTemplate): string {
	const parts: string[] = [];
	if (t.preset) parts.push(`preset:${t.preset}`);
	if (t.thinkingLevel) parts.push(`thinking:${t.thinkingLevel}`);
	const slots = templateSlotNames(t);
	if (slots.length > 0) parts.push(`slots ${slots.join(", ")}`);
	return parts.join(" \u00b7 ") || t.task.slice(0, 60);
}

/** Build a select-list section divider, e.g. `─── Model ───`. Pure. */
export function menuSection(label: string): MenuSectionItem {
	return {
		value: `__divider__:${slugify(label)}`,
		label: `\u2500\u2500\u2500 ${label} \u2500\u2500\u2500`,
		description: "",
	};
}

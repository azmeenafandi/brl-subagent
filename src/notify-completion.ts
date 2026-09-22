/**
 * brl-subagent — Completion-push wake (issue #147)
 *
 * Builds and sends the `subagent-completion` custom message that wakes the
 * conductor when a background run reaches a terminal state. This module is
 * deliberately split into:
 *   - a PURE `buildCompletionMessage(agent, run)` builder (unit-tested, no pi
 *     SDK, no side effects — derives status/category/label/cost from the run
 *     record);
 *   - a PURE `resolveDelivery(status, knob)` that maps the D1+D2 matrix to a
 *     `{ deliverAs, triggerTurn }` pair;
 *   - a THIN `sendCompletionNotification(pi, ...)` sender — the ONLY call site
 *     of `pi.sendMessage`, one call, no logic.
 *
 * Delivery is always-on (minimum `nextTurn`); the `completionNotify` knob only
 * controls the WAKE (D2). D1: failed/stopped → "steer", completed → "followUp".
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type {
	BackgroundAgent,
	SubagentRun,
	CompletionNotifyMode,
	AgentStatus,
} from "./types";
import { truncateTail } from "./transcript-tail";
import { formatRunDuration } from "./history";
import { classifyTerminalOutcome } from "./types";
import { resolveTerminalRunEntry } from "./state";

/** Terminal statuses the completion message can carry. */
export type CompletionStatus = "completed" | "failed" | "stopped";

/** Structured `details` the conductor can act on without drill-in (D3). */
export interface CompletionMessageDetails {
	id: string;
	status: CompletionStatus;
	errorCategory: string;
	errorMessage?: string;
	/** Issue #179 (D2): the terminal stopReason behind the classified status. */
	stopReason?: string;
	costUsd?: number;
	tokensIn?: number;
	tokensOut?: number;
	durationMs?: number;
	label?: string;
}

export interface CompletionMessagePayload {
	customType: "subagent-completion";
	content: string;
	display: true;
	details: CompletionMessageDetails;
}

export interface DeliveryResolution {
	deliverAs: "steer" | "followUp" | "nextTurn";
	triggerTurn: boolean;
}

/** Default dedupe cap: the set is simply cleared when it exceeds this. */
const DEDUPE_CAP = 200;

/**
 * Soft directive appended to the content (D3): the conductor should process
 * the completion silently unless action is needed. If the run failed, it
 * should investigate the cause before re-dispatching rather than re-issuing an
 * identical task — any re-issue is confirmed with the user first.
 */
const COMPLETION_DIRECTIVE =
	"Process this completion silently unless action is needed. If the run failed, investigate before re-dispatching — do not re-issue an identical task without confirming the cause with the user.";

/**
 * Normalize a BackgroundAgent status to a terminal status word. The subscriber
 * only fires on terminal events, so the status is always terminal in practice;
 * this maps any residual non-terminal value to "completed" rather than throwing.
 */
export function normalizeCompletionStatus(status: AgentStatus): CompletionStatus {
	if (status === "failed" || status === "stopped") return status;
	return "completed";
}

/**
 * Resolve the finalized (terminal-preferring) entry for a run id among the raw
 * getRunEntries list. Thin delegate to the shared `resolveTerminalRunEntry`
 * rule in src/state.ts (the core module owns the preference rule; see there
 * for the two-entry spawn/final append order). Kept under this name for the
 * completion wake path and its existing tests.
 */
export function resolveRunEntry(
	entries: SubagentRun[],
	id: string,
): SubagentRun | undefined {
	return resolveTerminalRunEntry(entries, id);
}

/**
 * Build the one-line summary: `Background agent "<label>" (<id>) — <status> in
 * <duration> · $<cost> · category: <category>` (D3).
 */
function buildSummaryLine(
	label: string,
	id: string,
	status: CompletionStatus,
	durationMs: number | undefined,
	costUsd: number | undefined,
	errorCategory: string,
): string {
	let line = `Background agent "${label}" (${id}) — ${status}`;
	if (durationMs !== undefined) line += ` in ${formatRunDuration(durationMs)}`;
	if (costUsd !== undefined) line += ` · $${costUsd}`;
	line += ` · category: ${errorCategory}`;
	return line;
}

/**
 * PURE builder — no pi SDK, no side effects, never throws. Returns the
 * sendMessage payload shape per D3.
 *
 * Cost/tokens/duration are read from the run entry when present; if the run
 * entry is absent (or the field is unset) the field is omitted from `details`
 * and the summary tail.
 */
export function buildCompletionMessage(
	agent: BackgroundAgent,
	run: SubagentRun | undefined,
): CompletionMessagePayload {
	let status = normalizeCompletionStatus(agent.status);
	// Issue #179 (D2): the notification category must NEVER default to success
	// merely because `agent.status === "completed"`. The SDK resolves a mid-run
	// provider death, so the run entry is the authoritative classified reason —
	// downgrade a stale "completed" when the run says otherwise.
	if (status === "completed" && run) {
		const outcome = classifyTerminalOutcome(run.stopReason, run.errorMessage);
		if (outcome.status !== "completed") {
			status = outcome.status;
		} else if (run.status === "failed") {
			status = "failed";
		}
	}
	// BackgroundAgent has no `label` field — the caller's label is `description`
	// (set from params.description at spawn). Fall back to the id.
	const label = agent.description || agent.id;
	// completed → "success"; failed/stopped → classified category from the run
	// record (finalizeRunEntry stamps it), falling back to "unknown".
	const errorCategory =
		status === "completed"
			? "success"
			: (run?.errorCategory ?? run?.originalParams?.errorCategory ?? "unknown");
	const durationMs = run?.durationMs;
	const costUsd = run?.cost;
	const tokensIn = run?.tokensIn;
	const tokensOut = run?.tokensOut;
	const stopReason = run?.stopReason;
	const errorMessage = status === "completed" ? undefined : agent.error ?? run?.errorMessage;

	const summary = buildSummaryLine(label, agent.id, status, durationMs, costUsd, errorCategory);
	// Issue #179 (C1 fix): truncateTail keeps the LAST 15 lines, but the failure
	// headline is PREPENDED to the stored output — long earlier-turn prose would
	// otherwise push the failure reason out of the notified body. Peel it off
	// before tailing and re-add it as its own part so the reason is never
	// truncated away.
	const stored = agent.finalOutput ?? run?.fullOutput ?? "";
	const headline = status === "completed" ? undefined : errorMessage;
	const body =
		headline && stored.startsWith(headline)
			? stored.slice(headline.length).replace(/^\n+/, "")
			: stored;
	const tail = truncateTail(body, 15);
	const parts = [summary];
	if (headline) parts.push(headline);
	if (tail) parts.push(tail);
	parts.push(COMPLETION_DIRECTIVE);
	const content = parts.join("\n\n");

	const details: CompletionMessageDetails = {
		id: agent.id,
		status,
		errorCategory,
		...(errorMessage ? { errorMessage } : {}),
		...(stopReason ? { stopReason } : {}),
		...(costUsd !== undefined ? { costUsd } : {}),
		...(tokensIn !== undefined ? { tokensIn } : {}),
		...(tokensOut !== undefined ? { tokensOut } : {}),
		...(durationMs !== undefined ? { durationMs } : {}),
		...(label ? { label } : {}),
	};

	return { customType: "subagent-completion", content, display: true, details };
}

/**
 * D1 + D2 matrix — the only knob-dependent logic. Delivery is always-on
 * (minimum `nextTurn`); the knob controls the WAKE (triggerTurn).
 */
export function resolveDelivery(
	status: CompletionStatus,
	knob: CompletionNotifyMode,
): DeliveryResolution {
	if (status === "completed") {
		if (knob === "all") return { deliverAs: "followUp", triggerTurn: true };
		return { deliverAs: "nextTurn", triggerTurn: false }; // knob "failed" | "off"
	}
	// status === "failed" | "stopped"
	if (knob === "off") return { deliverAs: "nextTurn", triggerTurn: false };
	return { deliverAs: "steer", triggerTurn: true }; // knob "all" | "failed"
}

/**
 * Dedupe guard — first terminal event per id wins. Returns true when the event
 * should be delivered, false when it is a duplicate. Capped simply (W1): the
 * set is cleared when it exceeds the cap.
 */
export function markTerminalSeen(seen: Set<string>, id: string, cap = DEDUPE_CAP): boolean {
	if (seen.has(id)) return false;
	seen.add(id);
	if (seen.size > cap) seen.clear();
	return true;
}

/**
 * THIN sender — the only `pi.sendMessage` call site. One call, no logic.
 * The `delivery` is the resolved output of `resolveDelivery` (D1+D2); it
 * carries both `deliverAs` and `triggerTurn` so the matrix is honored.
 */
export function sendCompletionNotification(
	pi: ExtensionAPI,
	message: CompletionMessagePayload,
	delivery: DeliveryResolution,
): void {
	pi.sendMessage(message, { deliverAs: delivery.deliverAs, triggerTurn: delivery.triggerTurn });
}

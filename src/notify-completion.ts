// Purpose: Builds and sends the completion-push wake message for terminal background runs.
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

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateTail } from "./transcript-tail";
import { formatRunDuration } from "./history";
import { formatBudgetDuration } from "./tui-format";
import {
	classifyTerminalOutcome,
	type BackgroundAgent,
	type BackgroundAgentIdentity,
	type SubagentRun,
	type CompletionNotifyMode,
	type AgentStatus,
} from "./types";
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

/**
 * Default dedupe cap. The set stays bounded by evicting its oldest entry when it
 * exceeds this — never the whole set (issue #440: a clear-all forgot the id it had
 * just claimed, so that id could be delivered twice).
 */
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
 * The ONE timeout predicate (issue #423): a run hit its deadline when the
 * classified category says so or the agent's error is the deadline stamp. The
 * wake, the result renderer and the budget line all read it, so the two
 * exhaustion surfaces cannot disagree.
 */
export function isTimeoutEvidence(agent: BackgroundAgent, run?: SubagentRun): boolean {
	const category = run?.errorCategory ?? run?.originalParams?.errorCategory;
	return category === "timeout" || /^Timed out/.test(agent.error ?? "");
}

/**
 * One line stating a run's budget (issue #423). PURE. Returns undefined when the
 * record carries no budget — an old record written before `timeoutMs` existed
 * has nothing to state, so no line is better than an invented 30 m.
 *
 * Shapes:
 * - timeout:  `Budget: 30m (exhausted)`
 * - otherwise `Budget: 30m — 4m 12s used, 25m 48s left`
 *
 * `status` guards the exhausted form: a run classified `completed` never claims
 * to have exhausted its budget (the evidence predicate alone would otherwise be
 * enough to downgrade a late-but-successful settle). `run` is optional because
 * the result path (`get_subagent_result`) has only the agent record; both read
 * the SAME predicate.
 */
export function formatBudgetLine(
	agent: BackgroundAgent,
	status: CompletionStatus | undefined,
	run: SubagentRun | undefined,
	now: number = Date.now(),
): string | undefined {
	if (agent.timeoutMs === undefined) return undefined;
	const budget = formatBudgetDuration(agent.timeoutMs);
	if (status !== "completed" && isTimeoutEvidence(agent, run)) {
		return `Budget: ${budget} (exhausted)`;
	}
	const endMs = agent.completedAt ?? now;
	const usedMs = Math.max(0, endMs - agent.startedAt);
	const remainingMs = Math.max(0, agent.startedAt + agent.timeoutMs - endMs);
	return `Budget: ${budget} — ${formatBudgetDuration(usedMs)} used, ${formatBudgetDuration(remainingMs)} left`;
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
	// Issue #423: the budget rides its own part, and ONLY on a failed/stopped
	// wake — a completed run's message is unchanged (the human reads the budget
	// when something went wrong, not on every success).
	if (status !== "completed") {
		const budgetLine = formatBudgetLine(agent, status, run);
		if (budgetLine) parts.push(budgetLine);
	}
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
 * Issue #474: insert the worktree-state block into a settled-failure wake, as
 * its own part and BEFORE the closing directive.
 *
 * PURE — it takes the already-rendered block and never probes git: the builder's
 * contract is "no side effects", and the probe is a subprocess. The caller
 * renders the block (`describeWorktreeState`) and gates on the CLASSIFIED
 * status.
 *
 * The directive is matched at the END (`endsWith`), never as the first
 * occurrence: an agent's own tail can quote the directive text, and splitting
 * there would drop everything after the quote. A shape that does not end with
 * the directive keeps the block by appending it — a missing report is the one
 * outcome this function must not produce.
 */
export function withWorktreeState(
	message: CompletionMessagePayload,
	worktreeState: string,
): CompletionMessagePayload {
	if (!worktreeState) return message;
	const suffix = `\n\n${COMPLETION_DIRECTIVE}`;
	const content = message.content.endsWith(suffix)
		? `${message.content.slice(0, -suffix.length)}\n\n${worktreeState}${suffix}`
		: `${message.content}\n\n${worktreeState}`;
	return { ...message, content };
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
 * should be delivered, false when it is a duplicate. Retention is bounded (W1):
 * once the set exceeds the cap its OLDEST entry is evicted (a `Set` iterates in
 * insertion order, so that is exact). The id just claimed is the newest entry, so
 * its own call evicts an EARLIER id — not the set, and not that claim. A clear-all
 * forgot the claim entirely, so the very next duplicate was delivered twice (#440).
 */
export function markTerminalSeen(seen: Set<string>, id: string, cap = DEDUPE_CAP): boolean {
	cap = Math.max(cap, 1); // a cap below 1 evicts the claim just made — retention must keep it
	if (seen.has(id)) return false;
	seen.add(id);
	if (seen.size > cap) {
		const oldest = seen.values().next().value;
		if (oldest !== undefined) seen.delete(oldest);
	}
	return true;
}

/**
 * Shared terminal-notice claim set (issue #315). ONE module-level surface so
 * the event-bus wake (`subagent-completion`) and the poller's crash notices
 * (`subagent-notification`) can never both fire for the same run id. Wraps
 * `markTerminalSeen`, so the dedupe + cap rule lives in exactly one place.
 */
const terminalClaims = new Set<string>();

/**
 * Claim the single terminal notice for `id`. Returns true when THIS caller
 * wins the claim (and must deliver), false when another terminal path already
 * claimed the id. The wake is canonical: its subscriber claims synchronously
 * on the terminal event, so a later crash notice is suppressed.
 */
export function claimTerminalNotice(id: string): boolean {
	return markTerminalSeen(terminalClaims, id);
}

/** TEST-ONLY: clear the shared terminal-claim set between test cases. */
export function __resetTerminalClaims(): void {
	terminalClaims.clear();
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

// ---------------------------------------------------------------------------
// Started-but-degraded monitoring advisory (issue #439)
//
// A background spawn whose tail faulted is a STARTED run whose monitoring is
// degraded — never a failed spawn. The conductor learns that from the spawn
// result's paragraph; the user learns it from this advisory. The advisory is
// deliberately NOT a terminal notice and never takes the terminal claim: the
// run is live, and its genuine completion notice must still be delivered later
// (the resolved contract on the issue). A run that emits the advisory and then
// never delivers a terminal notice (no listener at settle time) degrades to
// "advisory only" — a stated limitation, not a silent one.
// ---------------------------------------------------------------------------

/** The advisory's custom message type. NOT a terminal notice type. */
export const MONITORING_DEGRADED_CUSTOM_TYPE = "subagent-monitoring-degraded";

/** The user-facing half of the advisory (the footer/toast line). */
export const MONITORING_DEGRADED_TOAST = "Background agent started — monitoring degraded";

/**
 * The conductor-facing paragraph a STARTED-but-degraded spawn result carries.
 * Built from the identity record only — never from a property read on the live
 * agent (see the boundary statement in `startBackgroundAgent`). EMPTY when the
 * tail attached fully: callers append it unconditionally.
 */
export function buildMonitoringDegradedParagraph(
	unit: Pick<BackgroundAgentIdentity, "id" | "label">,
	tailFailures: string[],
): string {
	if (tailFailures.length === 0) return "";
	const name = unit.label ? `"${unit.label}" ` : "";
	return (
		`\n\nMonitoring degraded: ${name}started, but its live monitoring could not be attached (${tailFailures.join("; ")}). ` +
		`Do not re-dispatch — the run is live; retrieve with get_subagent_result({ agent_id: "${unit.id}" }).`
	);
}

/** The advisory's message body — the same facts, phrased for the user's screen. */
export function buildMonitoringDegradedAdvisory(
	unit: Pick<BackgroundAgentIdentity, "id" | "label">,
	tailFailures: string[],
): string {
	if (tailFailures.length === 0) return "";
	const name = unit.label ? ` "${unit.label}"` : "";
	return (
		`Background agent${name} started, but its monitoring is degraded (${tailFailures.join("; ")}). ` +
		`The run is live — do not re-dispatch it; retrieve with get_subagent_result({ agent_id: "${unit.id}" }).`
	);
}

/**
 * Emit the advisory on both channels, each in its own try: a throwing
 * `sendMessage` must not swallow the footer line, and a missing UI must not
 * swallow the message. Best-effort by design — this is the report of a
 * degraded path and cannot itself fail the spawn.
 */
export function sendMonitoringDegradedAdvisory(
	pi: ExtensionAPI,
	ctx: Pick<ExtensionContext, "ui">,
	identity: BackgroundAgentIdentity,
	tailFailures: string[],
): void {
	try {
		pi.sendMessage(
			{
				customType: MONITORING_DEGRADED_CUSTOM_TYPE,
				content: buildMonitoringDegradedAdvisory(identity, tailFailures),
				display: true,
				details: { agentId: identity.id, tailFailures },
			},
			{ deliverAs: "followUp" },
		);
	} catch { /* best-effort */ }
	try {
		ctx.ui.notify(MONITORING_DEGRADED_TOAST, "warning");
	} catch { /* best-effort */ }
}

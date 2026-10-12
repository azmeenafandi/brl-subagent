// Purpose: U3 recovery surface — interrupted-run projection, one-per-boot notice, and the abandon action.
/**
 * Option B U3 — interrupted-run recovery surface.
 *
 * U1 marks a crashed conductor's in-flight records; U2 persists their session
 * files. U3 makes them VISIBLE and recoverable by a human:
 *
 *   - `collectInterruptedRuns` projects the durable registry (`interruptedAt`
 *     set) into display rows, enriched with the run/agent record's label + task;
 *   - `buildRecoveryNotice` renders ONE turn-boundary notice listing every
 *     unresolved interrupted run (id8 · label · task excerpt · age);
 *   - `resolveRecoveryNoticeDelivery` pins the notice to `nextTurn` — the boot
 *     notice must NEVER steer or arrive mid-turn;
 *   - `abandonInterruptedRun` finalizes a marked run as the existing terminal
 *     `stopped` outcome (agent record `stopped`; run record `failed` +
 *     `errorCategory: "aborted"`, mirroring every other stop path), retires its
 *     registry entry, prunes its U2 session dir, and CLAIMS the run's single
 *     terminal notice so the abandon never wakes the conductor (Fix B item 1);
 *   - `visibleRunEntries` is the Fix A bridge: session run entries UNIONED with
 *     a synthetic record for every durable interrupted run the session has
 *     never seen (a genuine fresh boot). Every session-sourced recovery surface
 *     routes through it, so a crashed run is listed in Run History, offered in
 *     the retry menu, abandonable, and resolvable through `retryRunId` — the
 *     four consumers that previously read session entries the crash left empty.
 *
 * Pure over injected deps so the matrix is unit-testable without the SDK, the
 * filesystem, or the process table. NO resume/re-drive (U4), NO auto mode.
 */

import { listInflightRuns, type InflightRun, type InflightRunKind } from "./run-registry";
import type { SubagentRun } from "./types";
import { isInterruptedRun, runRecoveryPosture, type RecoveryMode } from "./types";
import { resolveTerminalRunEntry } from "./state";
import { sortNewestFirst } from "./history";
import { claimTerminalNotice, type DeliveryResolution } from "./notify-completion";

/** The abandon stamp recorded on the run + agent records. */
export const SUBAGENT_ABANDONED_MESSAGE = "Subagent run abandoned by user";

/** Custom-entry type of the one-per-boot recovery notice. */
export const RECOVERY_NOTICE_CUSTOM_TYPE = "subagent-recovery";

// ---------------------------------------------------------------------------
// Collection
// ---------------------------------------------------------------------------

/** One unresolved interrupted run, projected for display. */
export interface InterruptedRunView {
	id: string;
	kind: InflightRunKind;
	label?: string;
	task?: string;
	model?: string;
	thinkingLevel?: string;
	/** The durable `originalParams` snapshot (absent for pre-enrichment entries). */
	originalParams?: SubagentRun["originalParams"];
	startedAt: string;
	interruptedAt: string;
	/** The posture snapshotted at dispatch (absent ⇒ "offer"). */
	recoveryPosture: RecoveryMode;
}

export interface CollectInterruptedDeps {
	/** The durable in-flight registry entries. */
	listInflight(): InflightRun[];
	/** ONE background agent record by id, or null. */
	getAgent(id: string): {
		description?: string;
		task?: string;
		model?: string;
		thinkingLevel?: string;
	} | null;
	/** The session run entry (terminal-preferring), or undefined. */
	findRun(id: string): SubagentRun | undefined;
}

/**
 * Project every registry entry carrying an `interruptedAt` mark into a display
 * view. Label/task prefer the session run entry (present on a same-session
 * reload), then the background agent record; when neither exists (a fresh
 * process after a foreground crash) the entry's own durable summary is the
 * fallback, and only a pre-enrichment entry lacks one entirely.
 */
export function collectInterruptedRuns(deps: CollectInterruptedDeps): InterruptedRunView[] {
	const views: InterruptedRunView[] = [];
	for (const entry of deps.listInflight()) {
		if (!entry.interruptedAt) continue;
		const run = deps.findRun(entry.id);
		// Fix B (item 8): a THROWING agent-store read degrades to the
		// missing-agent path (null) exactly like an absent record. Enrichment is
		// best-effort — a bad single read must not take down the whole recovery
		// surface — and the durable registry still yields the row (id + age).
		let agent: ReturnType<CollectInterruptedDeps["getAgent"]> = null;
		try {
			agent = deps.getAgent(entry.id);
		} catch {
			agent = null;
		}
		views.push({
			id: entry.id,
			kind: entry.kind,
			label: run?.label ?? agent?.description ?? entry.label,
			task: run?.task ?? agent?.task ?? entry.task,
			model: run?.model ?? agent?.model ?? entry.model,
			thinkingLevel: run?.thinkingLevel ?? agent?.thinkingLevel ?? entry.thinkingLevel,
			originalParams: entry.originalParams,
			startedAt: entry.startedAt,
			interruptedAt: entry.interruptedAt,
			// The registry entry is the durable dispatch snapshot; the session
			// record is the fallback for entries written before U3 added the field.
			recoveryPosture: runRecoveryPosture({
				recoveryPosture: entry.recoveryPosture ?? run?.recoveryPosture,
			}),
		});
	}
	return views;
}

/** Keep only the runs whose snapshotted posture is "offer". */
export function offeredInterruptedRuns(views: InterruptedRunView[]): InterruptedRunView[] {
	return views.filter((v) => v.recoveryPosture === "offer");
}

// ---------------------------------------------------------------------------
// Visibility bridge (Fix A)
// ---------------------------------------------------------------------------

/**
 * Build the synthetic session-visible record for a durable interrupted run the
 * current session has never seen. Every field a session-sourced surface reads
 * (`status`/`interruptedAt`/`label`/`task`/`model`/`thinkingLevel`) comes from
 * the durable view, and `originalParams` restores the dispatch snapshot the
 * registry persisted at dispatch (falling back to the pre-enrichment subset
 * `{model, thinkingLevel, background?}` for old entries) so a `retryRunId`
 * re-dispatch keeps the recorded shape — including `force` (decision
 * 2026-10-11: full parity with a same-session retry). The record is NEVER
 * persisted — it exists only inside `visibleRunEntries`' returned list.
 */
function interruptedViewToRun(view: InterruptedRunView): SubagentRun {
	const originalParams: NonNullable<SubagentRun["originalParams"]> =
		view.originalParams ?? {
			model: view.model,
			thinkingLevel: view.thinkingLevel,
			...(view.kind === "background" ? { background: true } : {}),
		};
	return {
		id: view.id,
		task: view.task ?? "",
		...(view.label ? { label: view.label } : {}),
		status: "running",
		model: view.model?.trim() || "unknown",
		thinkingLevel: view.thinkingLevel?.trim() || "unknown",
		startedAt: view.startedAt,
		interruptedAt: view.interruptedAt,
		recoveryPosture: view.recoveryPosture,
		originalParams,
	};
}

/**
 * THE recovery visibility bridge (Fix A). Session-sourced run entries UNIONED
 * with one synthetic record per durable interrupted run the session has no
 * terminal or already-interrupted representation for — the genuine fresh-boot
 * case, where the crash's record lives ONLY in the durable registry + agent
 * record and the current session has no entry at all.
 *
 * Deduped by id and terminal-preferred: when the session already resolves the
 * id to a terminal entry (a settled/abandoned run) or a marked entry (a
 * re-loaded session's interrupted clone), NO synthetic is added, so the bridge
 * is idempotent and cannot stack rows across reads. The session list is
 * returned by reference when nothing is added, so callers that never hit the
 * fresh-boot case behave byte-for-byte as before.
 *
 * When synthetics ARE added (issue #330) the union is returned ordered
 * NEWEST-FIRST by `startedAt` (the shared `sortNewestFirst` helper), so a
 * bridged row lands in its RECENCY position rather than being appended last.
 *
 * This is the ONE bridge every session-sourced recovery surface routes
 * through (Run History, the retry menu, the abandon lookup, `retryRunId`
 * resolution), so all four agree by construction.
 */
export function visibleRunEntries(
	sessionEntries: SubagentRun[],
	deps: CollectInterruptedDeps,
): SubagentRun[] {
	const synthetic: SubagentRun[] = [];
	const seen = new Set<string>();
	for (const view of collectInterruptedRuns(deps)) {
		if (seen.has(view.id)) continue;
		seen.add(view.id);
		const resolved = deps.findRun(view.id);
		// A terminal or already-interrupted session entry is authoritative —
		// never augment, or a retried-then-settled run would show a second row.
		if (resolved && (resolved.status !== "running" || isInterruptedRun(resolved))) continue;
		synthetic.push(interruptedViewToRun(view));
	}
	return synthetic.length === 0
		? sessionEntries
		: sortNewestFirst([...sessionEntries, ...synthetic]);
}

/** The agent-record lookup the bridge needs (structurally the BackgroundAgent subset). */
export type RecoveryAgentLookup = (
	id: string,
) => { description?: string; task?: string; model?: string; thinkingLevel?: string } | null;

/**
 * The bridge bound to its production deps: the durable registry reader and the
 * terminal-preferred session lookup, with the same `sessionEntries` array the
 * caller passes. ONE wiring for the TUI and the extension, so a call site
 * cannot accidentally read the registry while resolving session entries from a
 * different list. The pure core (`visibleRunEntries`) stays deps-injected for
 * unit tests.
 */
export function visibleRunEntriesForSession(
	sessionEntries: SubagentRun[],
	getAgent: RecoveryAgentLookup,
): SubagentRun[] {
	return visibleRunEntries(sessionEntries, {
		listInflight: () => listInflightRuns(),
		getAgent,
		findRun: (id) => resolveTerminalRunEntry(sessionEntries, id),
	});
}

// ---------------------------------------------------------------------------
// Notice
// ---------------------------------------------------------------------------

export interface RecoveryNoticePayload {
	customType: typeof RECOVERY_NOTICE_CUSTOM_TYPE;
	content: string;
	display: true;
	details: { count: number; ids: string[] };
}

/**
 * The boot notice's delivery discipline: `nextTurn` ALWAYS queues to the
 * pending-next-turn buffer and can never steer or arrive mid-turn — the exact
 * opposite of `resolveDelivery`'s failed/stopped "steer". `triggerTurn` is kept
 * for shape parity (the SDK ignores it for `nextTurn`).
 */
export function resolveRecoveryNoticeDelivery(): DeliveryResolution {
	return { deliverAs: "nextTurn", triggerTurn: true };
}

/** Compact age label ("30s", "5m", "3h", "2d"); "unknown" for a bad timestamp. */
export function formatRecoveryAge(ms: number): string {
	if (!Number.isFinite(ms) || ms < 0) return "unknown";
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}

function shortId(id: string): string {
	return id.slice(0, 8);
}

function taskExcerpt(task: string | undefined): string {
	const trimmed = task?.replace(/\s+/g, " ").trim();
	if (!trimmed) return "(task unavailable)";
	return trimmed.length > 60 ? `${trimmed.slice(0, 57)}...` : trimmed;
}

/**
 * PURE builder — the ONE turn-boundary boot notice for a non-empty list of
 * interrupted runs. `now` is injected for deterministic tests; the age is
 * measured from the recorded `interruptedAt` (how long the run has been
 * interrupted). The caller must never invoke this with an empty list.
 */
export function buildRecoveryNotice(
	items: InterruptedRunView[],
	now: Date = new Date(),
): RecoveryNoticePayload {
	const nowMs = now.getTime();
	const lines = items.map((item) => {
		const label = item.label?.trim() || "(unlabeled)";
		const age = formatRecoveryAge(nowMs - Date.parse(item.interruptedAt));
		return `  \u2022 ${shortId(item.id)} \u00b7 ${label} \u00b7 ${taskExcerpt(item.task)} \u00b7 interrupted ${age} ago`;
	});
	const content =
		`Interrupted subagent run${items.length === 1 ? "" : "s"} detected (${items.length}):\n\n` +
		`${lines.join("\n")}\n\n` +
		`Review with /brl-subagent history, re-dispatch with retryRunId, or abandon via /brl-subagent retry. ` +
		`A row showing "(task unavailable)" is a registry entry written before durable task capture — ` +
		`pass \`task\` explicitly on the retryRunId call.`;
	return {
		customType: RECOVERY_NOTICE_CUSTOM_TYPE,
		content,
		display: true,
		details: { count: items.length, ids: items.map((i) => i.id) },
	};
}

// ---------------------------------------------------------------------------
// Abandon
// ---------------------------------------------------------------------------

export interface AbandonDeps {
	/** Terminal-preferring run lookup (session store). */
	getRun(id: string): SubagentRun | undefined;
	/** Persist the terminal run record. */
	writeRun(run: SubagentRun): void;
	/** Mark the background agent record stopped; an absent record is a no-op. */
	markAgentStopped(id: string): void;
	/** Remove the durable registry entry (the U1 interruption mark). */
	retireRegistry(id: string): void;
	/** Prune the run's U2 session directory (no-op when absent). */
	pruneSession(id: string): void;
}

/**
 * Finalize ONE interrupted run as the existing terminal `stopped` outcome:
 * the run record is written terminal with `stopReason`/`errorCategory`
 * "aborted" (the run store's representation of a stopped outcome — see the
 * `SubagentRun.status` union), the background agent record is flipped to
 * `stopped`, the registry entry is retired, and the U2 session dir is pruned.
 *
 * Idempotent: after the first call the run lookup returns the terminal record,
 * whose `isInterruptedRun` is false, so a repeat is a no-op. Safe when the run
 * is absent, when it is not interrupted, and when no session dir exists.
 *
 * Returns true when THIS call abandoned the run.
 */
export function abandonInterruptedRun(
	id: string,
	deps: AbandonDeps,
	now: Date = new Date(),
): boolean {
	const run = deps.getRun(id);
	if (!run || !isInterruptedRun(run)) return false;

	const finishedAt = now.toISOString();
	const startedMs = Date.parse(run.startedAt);
	const durationMs = Number.isFinite(startedMs) ? now.getTime() - startedMs : undefined;
	const terminal: SubagentRun = {
		...run,
		status: "failed",
		stopReason: "aborted",
		errorCategory: "aborted",
		errorMessage: SUBAGENT_ABANDONED_MESSAGE,
		finishedAt,
		...(durationMs !== undefined ? { durationMs } : {}),
	};
	deps.writeRun(terminal);
	// Fix B (item 1): an abandoned run must NOT wake the conductor. The
	// production `markAgentStopped` flips the agent record and emits
	// `subagent:stopped` — the same terminal event a normal stop raises — and the
	// completion wake's gate is `claimTerminalNotice`. Claim the id HERE, before
	// the mark, so on a fresh boot (where the shared claim set is empty and
	// #315's dedupe has nothing to suppress) the wake loses the race. Normal
	// stops/marks never pre-claim, so they keep waking exactly as before.
	claimTerminalNotice(id);
	deps.markAgentStopped(id);
	deps.retireRegistry(id);
	deps.pruneSession(id);
	return true;
}

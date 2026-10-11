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
 *     registry entry, and prunes its U2 session dir.
 *
 * Pure over injected deps so the matrix is unit-testable without the SDK, the
 * filesystem, or the process table. NO resume/re-drive (U4), NO auto mode.
 */

import type { InflightRun, InflightRunKind } from "./run-registry";
import type { SubagentRun } from "./types";
import { isInterruptedRun, runRecoveryPosture, type RecoveryMode } from "./types";
import type { DeliveryResolution } from "./notify-completion";

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
	startedAt: string;
	interruptedAt: string;
	/** The posture snapshotted at dispatch (absent ⇒ "offer"). */
	recoveryPosture: RecoveryMode;
}

export interface CollectInterruptedDeps {
	/** The durable in-flight registry entries. */
	listInflight(): InflightRun[];
	/** ONE background agent record by id, or null. */
	getAgent(id: string): { description?: string; task?: string } | null;
	/** The session run entry (terminal-preferring), or undefined. */
	findRun(id: string): SubagentRun | undefined;
}

/**
 * Project every registry entry carrying an `interruptedAt` mark into a display
 * view. Label/task prefer the session run entry (present on a same-session
 * reload) and fall back to the background agent record; when neither exists
 * (a fresh process after a foreground crash) the row still surfaces id + age,
 * which is enough to act on.
 */
export function collectInterruptedRuns(deps: CollectInterruptedDeps): InterruptedRunView[] {
	const views: InterruptedRunView[] = [];
	for (const entry of deps.listInflight()) {
		if (!entry.interruptedAt) continue;
		const run = deps.findRun(entry.id);
		const agent = deps.getAgent(entry.id);
		views.push({
			id: entry.id,
			kind: entry.kind,
			label: run?.label ?? agent?.description,
			task: run?.task ?? agent?.task,
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
		`Review with /brl-subagent history, re-dispatch with retryRunId, or abandon via /brl-subagent retry.`;
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
	deps.markAgentStopped(id);
	deps.retireRegistry(id);
	deps.pruneSession(id);
	return true;
}

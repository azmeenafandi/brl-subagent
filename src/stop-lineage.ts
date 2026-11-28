// Purpose: The dispatch-scoped stop plan and its report lines for `stop_subagent` (issue #616).
/**
 * Issue #616 — `stop_subagent`'s dispatch contract, as data.
 *
 * The defect the report fixes was a MESSAGE defect with a scope bug underneath:
 * `stop_subagent` stopped one id and printed "Stopped" for anything it found,
 * including an already-terminal attempt 1 whose transport auto-retry was live
 * under the same label (and, nine seconds before a manual kill, writing a
 * merge-gating review record).
 *
 * The contract this module plans and reports:
 *
 *   - the stop is DISPATCH-scoped: the requested id plus every attempt of the
 *     same `dispatchId` whose `retryCause` is `"transport"`. A manual retry is
 *     never stopped by a stop aimed at another attempt (it is named, not
 *     touched) — `retryCause` is a SCOPE FILTER, not an immunity: naming the
 *     manual retry's own id stops it;
 *   - an attempt whose cause is ABSENT is unknown, and unknown is never stopped
 *     by scope — it is disclosed;
 *   - an armed retry (see `retry-armed.ts`) is a pending intent, never silently
 *     "nothing running";
 *   - a TRUNCATED scan (7-day window / 200-record cap) may not carry a universal
 *     claim either.
 *
 * Everything here is PURE: no filesystem, no session mutation. The tool loops
 * the live attempts and collects outcomes; this module decides what is in scope
 * and what the sentences say. `src/__tests__/stop-subagent-lineage.test.ts` pins
 * every line.
 */

import type { ArmedRetry, CancelOutcome } from './retry-armed';
import type { RetryLineage, RetryRecordIdentity } from './session-manager';
import { isTerminalAgentStatusValue, type AgentStatus, type RetryCause } from './types';

/**
 * Statuses that count as LIVE. F11: `AgentStatus` also carries `pending` and
 * `steered`, which nothing writes today — they are included so a future writer
 * cannot silently fall outside the stop's scope.
 */
export const STOP_LIVE_STATUSES: ReadonlySet<AgentStatus> = new Set<AgentStatus>([
  'pending',
  'running',
  'steered',
]);

export function isLiveStatus(status: AgentStatus): boolean {
  return STOP_LIVE_STATUSES.has(status);
}

/** The dispatch-scoped answer: what to stop, what to leave, what to disclose. */
export interface StopPlan {
  /** The requested (resolved) id. */
  targetId: string;
  /** The requested id's own record, when one exists. */
  target: RetryRecordIdentity | null;
  /** The dispatch key named by the report's universal line. */
  dispatchId: string;
  /** In-scope, live attempts AFTER the requested id — ordered attempt, start. */
  live: RetryRecordIdentity[];
  /** Live manual retries: named as residue, never stopped by scope. */
  outOfScopeLive: RetryRecordIdentity[];
  /** Live attempts whose cause could not be established: named, never stopped. */
  unknownCauseLive: RetryRecordIdentity[];
  /** Every known attempt that is already terminal (nothing to do for them). */
  terminalFamily: RetryRecordIdentity[];
  /** Armed retries found for any family member. */
  armed: ArmedRetry[];
  /** The store scan hit its record cap. */
  capped: boolean;
  /** The scan window, in whole days (the disclosure's number). */
  windowDays: number;
  /** The requested record predates the scan window. */
  targetOutsideWindow: boolean;
}

/**
 * Turn a lineage answer into a stop plan.
 *
 * SCOPE, stated once: the requested id is ALWAYS in scope (the caller named it,
 * and that is how a manual retry is stopped after all); every OTHER attempt is in
 * scope only when the record says `retryCause === "transport"`. Absent is
 * unknown and unknown is never in scope — the discriminator exists precisely
 * because a manual retry of a transport-failed attempt is indistinguishable from
 * the automatic one by shape alone (issue #616 F6/F15).
 */
export function planDispatchStop(input: {
  targetId: string;
  lineage: RetryLineage;
  armed: ArmedRetry[];
  nowMs: number;
}): StopPlan {
  const { targetId, lineage, armed, nowMs } = input;
  const target = lineage.found;
  const dispatchId =
    lineage.family.find((record) => record.dispatchId !== undefined)?.dispatchId ?? targetId;

  const live: RetryRecordIdentity[] = [];
  const outOfScopeLive: RetryRecordIdentity[] = [];
  const unknownCauseLive: RetryRecordIdentity[] = [];
  const terminalFamily: RetryRecordIdentity[] = [];

  for (const record of lineage.family) {
    if (!isLiveStatus(record.status)) {
      terminalFamily.push(record);
      continue;
    }
    if (record.id === targetId || record.retryCause === 'transport') {
      live.push(record);
    } else if (record.retryCause === 'manual') {
      outOfScopeLive.push(record);
    } else {
      unknownCauseLive.push(record);
    }
  }

  // `lineage.family` is already ordered by attempt, then start, then id — the
  // stop order the contract asks for. Sorted again here so this module does not
  // depend on the reader's ordering choice.
  const byAttempt = (a: RetryRecordIdentity, b: RetryRecordIdentity): number =>
    a.attempt - b.attempt || a.startedAt - b.startedAt || a.id.localeCompare(b.id);
  live.sort(byAttempt);
  outOfScopeLive.sort(byAttempt);
  unknownCauseLive.sort(byAttempt);

  return {
    targetId,
    target,
    dispatchId,
    live,
    outOfScopeLive,
    unknownCauseLive,
    terminalFamily,
    armed,
    capped: lineage.bounds.capped,
    windowDays: lineage.bounds.windowDays,
    targetOutsideWindow:
      target !== null && target.startedAt < nowMs - lineage.bounds.windowDays * 24 * 60 * 60 * 1000,
  };
}

// ---------------------------------------------------------------------------
// The sentences
// ---------------------------------------------------------------------------

/** The cause token every line carries. Absent is UNKNOWN — never `transport`. */
export function causeLabel(cause: RetryCause | undefined): string {
  if (cause === 'transport') return 'cause transport';
  if (cause === 'manual') return 'cause manual';
  return 'cause unknown';
}

/** One attempt's identity, as every line names it. */
export function describeAttempt(
  id: string,
  attempt: number,
  cause: RetryCause | undefined,
): string {
  return `${id} (attempt ${attempt}, ${causeLabel(cause)})`;
}

/** A stop attempt and what the STORE says afterwards (not what the primitive returned). */
export interface StoppedAttempt {
  record: RetryRecordIdentity;
  description?: string;
  /** The terminal status read back from the store, or `null` when none could be read. */
  verifiedStatus: AgentStatus | null;
  /** Why no terminal status could be proven (a human-readable state, e.g. "no record"). */
  unverifiedState?: string;
}

export interface StopReportInput {
  plan: StopPlan;
  stopped: StoppedAttempt[];
  /** One entry per marker in `plan.armed`, in the same order. */
  cancels: Array<{ armed: ArmedRetry; outcome: CancelOutcome }>;
}

export interface StopReport {
  text: string;
  isError: boolean;
}

/**
 * Assemble the report. The rules, each pinned by a test:
 *
 *   - the word "Stopped" describes an attempt ONLY when the re-read record says
 *     it is terminal — the primitive's return value is not evidence;
 *   - an in-scope live attempt that does not reach a terminal status is an ERROR
 *     (the postcondition "nothing in scope is running" was not met);
 *   - a live attempt left alone BY SCOPE (manual) or BY UNKNOWNNESS is a residue
 *     line and NOT an error — the scoped stop itself succeeded;
 *   - no universal claim when a retry is armed, a cause is unknown, a live
 *     out-of-scope attempt remains, or the scan was truncated; each of those gets
 *     its own disclosure line instead.
 */
export function formatStopReport(input: StopReportInput): StopReport {
  const { plan, stopped, cancels } = input;
  const lines: string[] = [];
  let isError = false;

  for (const cancel of cancels) {
    const attempt = describeAttempt(cancel.armed.parentId, cancel.armed.attempt, 'transport');
    if (cancel.outcome === 'cancelled') {
      // NOT a universal claim: the cancel is an intent the spawn consumes.
      lines.push(
        `Cancelled transport retry for ${attempt} before it prompted — the dispatch is not claimed quiescent until it settles.`,
      );
    } else if (cancel.outcome === 'failed') {
      lines.push(
        `An armed transport retry for ${attempt} could not be cancelled (the marker write failed) — it may still prompt and run.`,
      );
      isError = true;
    }
  }

  for (const outcome of stopped) {
    const record = outcome.record;
    if (outcome.verifiedStatus !== null && isTerminalStatus(outcome.verifiedStatus)) {
      lines.push(
        `Stopped agent ${record.id} (attempt ${record.attempt}, ${causeLabel(record.retryCause)}, ${outcome.description ?? 'no description'}).`,
      );
    } else {
      const state = outcome.unverifiedState ?? 'not terminal';
      lines.push(
        `Attempt ${record.id} (attempt ${record.attempt}, ${causeLabel(record.retryCause)}) did not reach a terminal status (store says: ${state}) — it may still be running.`,
      );
      isError = true;
    }
  }

  for (const record of plan.outOfScopeLive) {
    lines.push(
      `Left running: ${record.id} (attempt ${record.attempt}, ${causeLabel(record.retryCause)}) — a manual retry is not stopped by a stop aimed at another attempt; name it to stop it.`,
    );
  }

  for (const record of plan.unknownCauseLive) {
    lines.push(
      `Left running: ${record.id} (attempt ${record.attempt}, ${causeLabel(record.retryCause)}) — the retry cause could not be established, so this dispatch-scoped stop leaves it alone.`,
    );
  }

  if (stopped.length === 0 && cancels.length === 0 && plan.target) {
    lines.push(
      `Agent ${plan.target.id} is already ${plan.target.status} (attempt ${plan.target.attempt}, ${causeLabel(plan.target.retryCause)}) — nothing stopped.`,
    );
  }

  if (plan.capped) {
    lines.push(
      'Lineage not fully checked: the agent-store scan hit its record cap (only the newest records were read).',
    );
  }
  if (plan.targetOutsideWindow) {
    lines.push(
      `Lineage not fully checked: ${plan.targetId} started more than ${plan.windowDays} days ago, outside the retry scan window.`,
    );
  }

  // THE UNIVERSAL CLAIM. Every disqualifier is named above instead, so the
  // conductor can tell "the dispatch is quiescent" from "the scan could not say".
  const armedPending = cancels.length > 0;
  const truncated = plan.capped || plan.targetOutsideWindow;
  const unproven = stopped.some(
    (outcome) => outcome.verifiedStatus === null || !isTerminalStatus(outcome.verifiedStatus),
  );
  // An out-of-scope LIVE attempt is disqualifying too, and deliberately: it is a
  // member of the SAME dispatch, so "nothing of this dispatch is running" would
  // be false — the sentence's scope is the dispatch, not the stop's scope.
  const liveResidue = plan.outOfScopeLive.length > 0;
  if (!armedPending && !liveResidue && plan.unknownCauseLive.length === 0 && !truncated && !unproven) {
    lines.push(`Nothing of this dispatch (${plan.dispatchId}) is running.`);
  }

  return { text: lines.join('\n'), isError };
}

function isTerminalStatus(status: AgentStatus): boolean {
  return isTerminalAgentStatusValue(status);
}

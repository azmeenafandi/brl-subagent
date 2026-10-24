// Purpose: The pure auto-retry predicate for background runs that settled with a transport-class failure (issue #365).
import type { SubagentRun } from "./types";

/**
 * Conservative transport signatures (issue #365). The four observed failures in
 * the 2026-10 cycle were all externally-caused drops — `"Connection error."`
 * from the SDK — that died before any file work, so a replay with the recorded
 * params is cheap and safe. The list is substring-matched against the settled
 * run's `errorMessage` (case-insensitive) and deliberately narrow: a retry is
 * never armed for a failure whose cause is unknown, because re-running a
 * genuinely broken dispatch just spends twice.
 */
const TRANSPORT_SIGNATURES = [
	"connection error",
	"econnreset",
	"econnrefused",
	"socket hang up",
	"fetch failed",
	"network error",
	"etimedout",
	"enotfound",
	"eai_again",
] as const;

/**
 * The user-visible warning surfaced when the auto-retry is scheduled. Lives here
 * so the handler and its tests agree on one literal (the runtime-vocabulary
 * ratchet forbids internal vocabulary — this string is user-facing and stays
 * plain).
 */
export const TRANSPORT_RETRY_TOAST = "Transport failure — auto-retrying once (attempt 2/2)";

/**
 * TRUE when a settled run should be re-dispatched ONCE automatically.
 *
 * Every condition must hold (issue #365 spec):
 *
 *   1. the run FAILED as a process-level exit (`exit_error`, with the legacy
 *      `originalParams.errorCategory` fallback the rest of the code uses) —
 *      this is the class the runner already stamps for an external drop;
 *   2. its `errorMessage` carries a transport signature (see above);
 *   3. it is the ORIGINAL dispatch (`attempt ?? 1 === 1`): a user retry, or a
 *      previous auto-retry that failed again, surfaces normally. This is what
 *      bounds the machinery structurally — one retry per logical dispatch,
 *      never a chain, no timer, no queue;
 *   4. it ran in the BACKGROUND — a foreground failure is already visible
 *      inline (and `retryOnTimeout` covers the foreground timeout case);
 *   5. the record carries `originalParams`, which is what the retry restores.
 *      Fan-out units deliberately omit it (their retry semantics belong to
 *      issue #229), so they fall out here by construction.
 *
 * Pure: no pi SDK, no state, no I/O — unit-testable as a matrix.
 */
export function isTransportRetryable(
	run: Pick<SubagentRun, "status" | "errorCategory" | "errorMessage" | "attempt" | "originalParams">,
): boolean {
	if (run.status !== "failed") return false;
	// New consumers read the top-level category; the legacy snapshot key is the
	// documented fallback (same rule as buildCompletionMessage).
	const category = run.errorCategory ?? run.originalParams?.errorCategory;
	if (category !== "exit_error") return false;
	const message = (run.errorMessage ?? "").toLowerCase();
	if (!TRANSPORT_SIGNATURES.some((signature) => message.includes(signature))) return false;
	if ((run.attempt ?? 1) !== 1) return false;
	return run.originalParams?.background === true;
}

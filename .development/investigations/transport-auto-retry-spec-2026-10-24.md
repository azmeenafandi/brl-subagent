# Transport auto-retry for background dispatches — issue #365

jev: **medium (0.92)** · risk **C2** · worktree y. Review: C2 focused.
Issue: #365 (P0, Rule 11 — `connection-error` ×4 in the menu cycle). Cycle: post-v2.6.0.

## Context (verified against the code and the log)

The failures are homogeneous: `"Background run settled"` with `status: failed`, `stopReason: error`,
`errorCategory: exit_error`, `error: "Connection error."` — all four in the cycle log, all before file work.
The infrastructure is already in place:

- **Settle chokepoint:** `finalizeRunEntry` (`src/session-manager.ts:700-775`) builds the classified `SubagentRun`
  (category + `originalParams`) and the event bus emits `subagent:failed`.
- **Notification chokepoint:** `deliverCompletionAlert` (`src/index.ts:4311+`) claims the terminal notice, resolves
  the agent + run entry, builds and sends the completion message.
- **Retry machinery:** `resolveRetryParams(params, run)` (`src/history.ts:151`) merges explicit values over the
  run's `originalParams` (task/model/thinking/preset/tools/cwd/timeout/background/…); `spawnBackgroundRun(...,
  retrySourceRun)` (`src/index.ts:2601`) re-runs the full gate sequence and `newDispatchIdentity(source)` gives
  `resumeOf` + `attempt = source.attempt + 1` (`src/recovery-engine.ts:147`).

## Decision

**A bounded auto-retry of a background run that settles with a transport-class failure — exactly once, for the
original dispatch only.**

### Predicate (pure, unit-testable)

`isTransportRetryable(run: SubagentRun): boolean`, all must hold:

1. `run.status === "failed"` and `run.errorCategory === "exit_error"` (or the `originalParams.errorCategory` fallback).
2. `run.errorMessage` matches a conservative transport signature (case-insensitive):
   `connection error` · `econnreset` · `econnrefused` · `socket hang up` · `fetch failed` · `network error` ·
   `etimedout` · `enotfound` · `eai_again`.
3. `(run.attempt ?? 1) === 1` — only the original dispatch. A user retry or a *previous auto-retry* (`attempt 2`)
   that fails surfaces normally: **one retry per logical dispatch, never a chain**.
4. `run.originalParams?.background === true` — background only.
5. `run.originalParams` exists (fan-out units deliberately omit it — their retry semantics are #229's; out of scope).

### Orchestration

In `deliverCompletionAlert`, on a claimed `subagent:failed` where the predicate holds:

1. **Spawn** the retry via the existing path: `resolveRetryParams({}, run)` → `spawnBackgroundRun(pi, ctx,
   retryParams, retryParams.task!, run)`. The retry inherits `resumeOf` + `attempt: 2` (lineage visible in the
   record), the recorded timeout/model/thinking/tools/cwd/preset, and re-runs the normal gates (cost, approval,
   pre-task). A spawn failure falls back to the normal failure notice.
2. **Suppress** the source run's completion message (the retry supersedes it) and **surface a toast** —
   `ctx.ui.notify("Transport failure — auto-retrying once (attempt 2/2)", "warning")` — plus a log line
   (`"Background run settled — transport auto-retry scheduled"` with source id + attempt). The retry's own terminal
   settle notifies normally; a second transport failure surfaces as an ordinary failure (attempt 2/2).
3. Non-retryable failures and all other terminal types take the existing path unchanged.

### Out of scope

Fan-out units (no `originalParams`), foreground runs (synchronous failure is already visible; `retryOnTimeout`
already exists for the foreground timeout case), chain/graph, timeout-class retries, provider failover, and any
retry UI.

## Tests (pinned)

- Predicate: transport message × attempt 1 × background → true; each condition failing alone → false (non-transport
  message, `attempt: 2`, no `originalParams`, `background: false`, category `timeout`).
- Handler: a transport failure spawns **exactly once** with the restored params + the source run (lineage
  `resumeOf`/`attempt 2`), sends **no** completion message for the source and **one** toast; a retry that settles
  sends the normal notice.
- A non-transport failure → normal notice, zero spawns.
- A transport failure on an `attempt: 2` run → normal notice, zero spawns (no loop).
- The existing completion-notice tests stay green (dedupe claim, delivery matrix).

## Docs

`AGENT.md` (delegation behavior) + the tool's `background` guideline + `README` (the safety section) + `CHANGELOG`
Unreleased: background transport failures auto-retry once with the recorded parameters; a second failure surfaces.

## Risks

- **Re-entrancy** — a spawn inside the settle-notification handler: the handler is already `async` and runs after
  the settle; the spawn is the normal path, and the notice claim is per-id.
- **Loops** — bounded structurally by `attempt === 1`; no timer, no queue.
- **Double notice** — the source notice is suppressed; the retry's notice is the only wake.
- **Cost** — the retry spends again; bounded to one, and the existing cost gate runs on the retry spawn.

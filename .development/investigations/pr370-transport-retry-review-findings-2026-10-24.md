# REVIEW — PR #370 (transport auto-retry) @ `c5719a8`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — focused C2, Jev **medium (0.84)**. Issue #365;
spec `.development/investigations/transport-auto-retry-spec-2026-10-24.md`.
Diff `e318779..HEAD`: `src/transport-retry.ts` (predicate + toast literal), `src/index.ts` (handler), `src/schema.ts`,
the new test file, AGENT/README/CHANGELOG/ARCHITECTURE.

**Verdict: approve-with-nits** (3 minors) → fixed `5c84c4d` → merged `509efa1`.

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| minor | `src/__tests__/transport-auto-retry.test.ts` | Gate-rejection (`isError`) fallback untested — only the throwing spawn was pinned |
| minor | `src/__tests__/transport-auto-retry.test.ts` | The `log.info("…transport auto-retry scheduled")` line is never asserted — the toast is |
| minor | `.development/ARCHITECTURE.md:156` | The timeout-scoped "not auto-retried" line could gain a (#365 transport excepted) pointer |

## Verified-OK

- **Predicate — all five conditions exact:** failed; `exit_error` + the legacy `originalParams.errorCategory` fallback;
  a 9-signature conservative list; `(attempt ?? 1) === 1`; `background === true` (which covers `originalParams`
  presence); pure (no SDK/state/I-O).
- **Handler:** claimed `subagent:failed` only; exactly one `spawnBackgroundRun` with `resolveRetryParams({}, run)` and
  the source run (lineage `resumeOf` + `attempt: 2` asserted); the source notice suppressed; exactly one toast + log;
  a spawn throw falls back to the normal notice; other terminal types bypass via the `event.type` check;
  claim-then-branch ordering means no double notice and no re-entrancy (each spawn has a new id).
- **Bounds:** `attempt: 2` → predicate false → normal notice, zero spawns; no timer, queue, or loop.
- **Tests real:** 16/16 pass; five mutation probes all kill — (a) dropped signature → 1 fail; (b) removed attempt
  guard → 3; (c) background check → the foreground test; (d) removed suppression → the notice-count test;
  (e) double spawn → exactly-once. Tree restored clean.
- **Docs:** AGENT/README/schema/index-tool-text/CHANGELOG state the one-shot transport retry; the remaining
  "not auto-retried" hits are historical or timeout-qualified; the arch module map regenerated (41 modules).
- **No collateral:** foreground/fan-out excluded by construction; the retry re-runs cost/approval/pre-task gates
  inside `spawnBackgroundRun`; the diff is the 8 listed files.

SOLID/DRY violations flagged: 0

## Disposition (2026-10-24)

- **All three minors FIXED** in `5c84c4d` — a gate-rejection `isError` test (approval-`always` restored params
  rejected pre-spawn: source notice delivered, no toast/scheduled log, zero sessions), the scheduled-log assertion,
  the ARCHITECTURE pointer. CI green. Merged `509efa1`; suite **83 files / 1719 tests**.
- **Residual noted by the fixer (not a finding):** the `catch` branch of `scheduleTransportRetry` (throws from
  `resolveRetryParams` or `spawnBackgroundRun`'s pre-`try` section) remains unpinned — flagged only; the realistic
  gate paths return `isError` and are covered.
- **Noted for the next cycle's sweep:** the `retryOnTimeout` prose is duplicated verbatim between the tool guideline
  (`src/index.ts`) and the schema description (`src/schema.ts`) — pre-existing DRY, left untouched.

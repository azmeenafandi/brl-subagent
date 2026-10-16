# REVIEW — PR #341 (#340 dangling-row fix) @ `dd81619`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — independent adversarial, C1 full review (2026-10-16).
Spec: `.development/investigations/issue-340-dangling-row-spec-2026-10-16.md` · checkout: detached at `dd81619`.

**Verdict: approve**

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| minor | `src/__tests__/dangling-row.test.ts:238-240` | Terminal cost/tokens/outputSummary fields not asserted (probe-verified sound; consider adding for lock-in) |

## Verified-OK

- **Terminal completeness:** probe dump shows failed / `finishedAt` / `durationMs >= 0` / `errorMessage` == gate text /
  `stopReason` `aborted` / `errorCategory` `aborted` / cost 0 / tokens 0 / `outputSummary` "" / no `fullOutput` /
  no `interruptedAt`.
- **Registry clearing:** terminal persist (no kind) clears via the terminal-clear rule; no re-register after; the
  retry-source clear still runs after both gates (`index.ts:3410`).
- **Live monitor:** `finalizeLiveSubagent` idempotent claim-set; the status surface keys on `isLiveEntryFinalized`.
- **Retry lineage:** source intact + twin terminal + exactly one registry row; `retryableRuns` (failed|interrupted,
  one row per id) → no duplicate offers across boot/history surfaces.
- **Return fidelity:** slot literal byte-identical to `dev:3360`; circuit return block untouched; `isError`/details
  unchanged.
- **Test validity:** M1 (2 fail: circuit + retry-twin at terminal-undefined, slot passes), M2 (1 fail: slot only),
  M3 (3 fail) — all fail for the right reason; M4 reachability proven via the spawn-entry-present failure mode.
- **Comment accuracy:** helper + retire-on-retry comments describe post-fix behavior exactly.
- **D1 stands:** `aborted`/`aborted` fully coherent via `classifyError` first-branch + `coherentFailureReason`
  keep-rule; history-menu retry preserved.
- **Suite:** full suite 74 files / 1509 tests pass; tsc clean; `git diff --check` clean; blast radius as claimed
  (foreground pre-start path only).

SOLID/DRY violations flagged: 0

**Coverage:** dangling-row tests 3/3 pass; mutation probes M1/M2/M3 in a `/tmp` scratch copy; terminal-record probe
dump; full suite 74 files / 1509 tests; `tsc --noEmit`; `git diff --check`. Findings banked to
`/tmp/review-340-findings.md`.

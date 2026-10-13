# PR #324 focused review findings (#322 shutdown-reap isolation)
# reviewer: openrouter/~openai/gpt-luna-latest — run fe7343ee, 2026-10-10, 2m40s, $0.0129 (medium)
# worktree: brl-subagent-wt-322-review @ cb0bb72 (detached)

**CHANGES-REQUESTED**

| Severity | File:line / focus | Command | Observed result |
|---|---|---|---|
| **Major** | `src/__tests__/recovery.test.ts:855` — shutdown-vs-exit-sweep isolation | Mutation 2: keep marker PIDs in `reaped`, but make the shutdown marker targets’ `terminate` and `forceKill` no-ops; run the focused Vitest test | **Test passed.** Killing the tracked wrapper triggers the runner’s independent `sweepMarkerChildren`, which kills the grandchild before the pre-`await promise` liveness check. The `reaped` membership assertion proves PID accounting, not that shutdown delivered the signal. Line 855 was the expected tripwire, but it did not catch the mutation; **no current assertion catches it**. |
| — | Mutation 1 | Mutation: remove the shutdown marker-target union; run the focused Vitest test | **Failed as expected** at line 854: `expect(reaped).toContain(grandchildPid)`. |
| — | Ordering / retained assertions | Source inspection and test-file diff | All new checks execute before `await promise`; the existing post-settle assertions are unchanged. However, their position does not isolate the shutdown path, as Mutation 2 demonstrates. |
| — | Flake / cleanup | Focused test ×3; process check after each run | Three passes, each `1 passed / 41 skipped`. Vitest durations: **1.23s, 1.24s, 1.21s**. No `sleep 300` or `grandchild.sh` leftovers after any run. |

**Gate A:** `npx tsc --noEmit` clean; full suite **67 files / 1365 tests passed**; `node scripts/docs-arch.mjs` reports the 39-module map current; README guard passes (1300+ claimed, 1365 ran). Installed TypeScript 7.0.2 and Vitest 5.0.3 match the lockfile. The test diff adds assertions only; no assertions were deleted or weakened. `git diff --check` is clean and the worktree remains clean.

**Verified OK**
- PR #324 is at `cb0bb7280fc8c0a69bad864afe587d8f289d8014`; reviewed diff is limited to 14 added lines in `src/__tests__/recovery.test.ts`.
- The timing and process-cleanup checks passed as reported above.

**Gate A note:** Commands and mutations were run empirically; scratch mutations were in `/tmp`, not the repository.

- **SOLID/DRY violations flagged: 0** (excluding the intentionally retained duplicate post-settle assertions).
- Full findings banked at `/tmp/review324-findings.md`.

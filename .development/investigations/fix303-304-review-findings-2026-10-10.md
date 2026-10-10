# PR #305 adversarial review findings (fix303-304)
# reviewer: openrouter/~openai/gpt-luna-latest (project-reviewer preset) — run dea2425e, 2026-10-10, 8m56s, $0.0527
# worktree: brl-subagent-wt-fix-checks-review @ c5a02b5 (detached)

APPROVED

| Focus | Severity | Finding / command and observed result |
|---|---|---|
| #303 kill-check | observation | `npx vitest run src/__tests__/recovery.test.ts -t 'abort/timeout escalation force-kill' --reporter=verbose` → 3 passed. An instrumented scratch probe observed timeout SIGTERM→SIGKILL in **101 ms**, `close signal=SIGKILL`, then dead; abort likewise **101 ms** and `SIGKILL`; cooperative child closed on **SIGTERM** with no SIGKILL. |
| #303 mutation | observation | In a scratch copy, restored `() => Boolean(proc.killed)` at both sites. Both ignore-SIGTERM tests failed by timeout (2 failed, cooperative test passed); the test deadline was shortened only in scratch. |
| #303 timing assertion | minor | The real-process probe confirms the current grace timing, but the two stubborn-child tests do not assert an elapsed bound; their 20-second test timeout would allow a regression to the full 5-second wait. |
| #303 timing seam | minor | Defaults initialize from `SIGKILL_GRACE_MS`/`SIGKILL_POLL_MS`; `afterEach` resets them, and shuffled tests (`--sequence.shuffle.tests --sequence.seed=123`) passed. `runner.ts:101` exports the setter from a shipped source module, so a direct internal-module import could change process-wide production timing; it is not re-exported by `index.ts`. |
| #303 result semantics | observation | The diff changes escalation checks/wait options, not the `close` handler or resolver. Full suite passed; existing runner assertions for timeout message/category/`exitCode=-1` and abort message/category remain unchanged, and the new abort test asserts `errorCategory: "aborted"`. |
| #304 durable ledger | observation | Focused registry tests → 4 passed, including real filesystem refusal. Mixed case asserts `marked=1`, `markFailures=1`, and persisted `interruptedAt`. Scratch background probe observed `{"marked":0,"markFailures":1,"agentInterruptedAt":"2026-10-09T00:00:00.000Z","failureWarning":"Recovery: registry mark failed",...}` when registry marking failed but agent marking succeeded. |
| #304 logging/callers | observation | Failure-only test asserts `marked=0`, `markFailures=1`, and an ID-bearing `Recovery: registry mark failed` warning. `index.ts:3906` gates the summary on either durable marks or failures. Search found the production `markInterrupted` caller in `index.ts`; its boolean is returned to the scan. |
| #304 mutation | observation | In a scratch copy, forced `durable=true`: the failure-only test failed (`expected 1 to be 0`) and mixed case failed (`expected 2 to be 1`). |
| #304 unsafe IDs | observation | Focused test passed with fail-closed policy: asserts `scanned=0`, `marked=0`, `markFailures=0`, `skippedUnsafeIds=1`, and one warning with the garbage ID. The diff’s rationale matches the UUID-only write guard. |
| Rider | observation | `grep -R "listPersistedAgents" ...` found only its declaration in production source. Boot recovery reads candidate records through the registry and fetches background records by ID. |
| SOLID/DRY | minor | Two DRY nits: duplicate mark-warning payload construction (`src/recovery.ts:131–149`); the new `withIgnoreTermWrapper` repeats temp-dir/`BRL_PI_BIN` setup and cleanup from `withSleepWrapper` (`src/__tests__/recovery.test.ts:624–645`). No S/O/L/I/D violations identified. |

**Gate A:** `npx tsc --noEmit` exited 0; `node scripts/docs-arch.mjs` reported **39 modules current**; full suite reported **328/328 files, 1328/1328 tests passed, 0 pending**; README guard reported `README says 1300+, suite ran 1328 — OK`. Test diffs showed no deleted or weakened existing assertions. `git diff --check` was clean.

The suite’s known #302 quirk moved HEAD to `brl-subagent-ba29cbd6`; I restored it with `git checkout --detach c5a02b5`. Final worktree is clean at the PR tip. Environment check: Node v24.14.1; installed TypeScript 7.0.2, Vitest 5.0.1, and pi packages 1.1.0 match the lockfile. No repository files were modified.

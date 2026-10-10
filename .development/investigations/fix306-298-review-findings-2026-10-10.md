# PR #311 focused review findings (#298 + #306, pre-release polish)
# reviewer: openrouter/~openai/gpt-luna-latest — run 989038c8, 2026-10-10, 7m9s, $0.0535
# worktree: brl-subagent-wt-polish @ 114fb74

APPROVED

- Verdict: approve-with-nits — one non-blocking comment-precision note.

PR #311 was **OPEN** and scoped to #298 and #306. `gh issue view 298` requests a centralized partial/settled predicate; `gh issue view 306` identifies the four review nits addressed here.

| Focus | Severity / location | Command | Observed result |
|---|---|---|---|
| #298 predicate and rendering | — (verified OK) | `npx vitest run src/__tests__/streaming-sentinel.test.ts src/__tests__/types.test.ts src/__tests__/terminal-status-consistency.test.ts src/__tests__/runner.test.ts --reporter=dot` | **4 files / 139 passed.** The predicate’s expression exactly matches the previous local logic. Existing renderer tests cover raw partials and classified `-1` failures; an added scratch-only absent-details test passed and rendered raw text. |
| #298 comment invariant | **minor** — `src/types.ts:822` | Jiti probe calling `parseSubagentLine` with an abort-stamped result | Observed `{"emitted":true,"exitCode":-1,"errorCategory":"aborted","predicate":false}`. The bullet “a live partial … NO errorCategory” is too broad: `runner.ts:370` stamps `aborted` before close, and a later output update can carry it. This routes to the failure branch just as the old condition did; qualify the comment as an ordinary, non-abort partial. |
| #306 elapsed bounds | — (verified OK) | Scratch copy: changed both stubborn-child test timings from 100 ms to 5000 ms; ran the targeted recovery tests | **2 failed / 35 skipped**, both at the `<1500` assertion with `expected 5000 to be less than 1500`. The bound detects the full-grace regression. |
| #306 timing seam | — (limitation assessed) | Child-process Jiti probe with `NODE_ENV`/`VITEST` unset; targeted Vitest seam/escalation tests | Unset markers: setter threw before mutation. With `NODE_ENV=test`: setter was accepted, so this is an accidental-use guard, **not** a security boundary. Focused tests passed **3 / 3**. That is adequate for the stated stray-import threat model; a stronger guarantee would require removing the mutable seam, not merely hiding raw `.ts` test code. |
| #306 DRY and assertion audit | — (verified OK) | `git diff dev...HEAD -- src/__tests__` and deleted-assertion grep | Both extractions preserve the warning payload fields and wrapper setup/cleanup; the diff contains **no deleted assertions**. |

**#298 invariant and signal sweep.** `SubagentResult` has no authoritative settled/status field; `stopReason` is not one (the tests exercise `toolUse` on both partial and settled results). `SubagentRun.status` is a separate persisted record field, not in renderer details. For resolved foreground runs, `runner.ts:1051` assigns `classifyError(result)` after process resolution; the classifier is total and falls back to `"unknown"`. Abort also stages its category earlier. If a future finalized `exitCode: -1` result bypasses classification and has no category, the predicate returns `true`, so the renderer displays raw running text rather than a verdict.

The only executable `exitCode === -1` disambiguation is now the predicate. The `runner.ts` streaming stamp, settled signal-death assignment, and five `index.ts` placeholders are producers, not other consumers needing the predicate.

**Gate A:** `npx tsc --noEmit` exited 0; full Vitest JSON report: **66 files, 1349 passed, 0 failed, 0 pending**; `node scripts/docs-arch.mjs` reported “module map is current (39 modules)”; README guard reported “README says 1300+, suite ran 1349 — OK (drift limit 100).” `git diff --check` was clean.

**Environment and cleanup:** Node 24.14.1, Vitest 5.0.3, TypeScript 7.0.2, jiti 2.7.0, and pi packages 1.1.0 match the lockfile. The worktree’s `node_modules` symlinks to the dev checkout. No installed `~/.pi/agent/extensions/brl-subagent` source, project-local run ledger, or current session log was available for a reload/sync check; verification was against the requested worktree source. Scratch copies were removed; the worktree remains clean at `114fb74`. No project files were modified.

- SOLID/DRY violations flagged: **0**.

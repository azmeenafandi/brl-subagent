# PR #324 C1 re-review findings (#322 isolation fix round)
# reviewer: openrouter/~openai/gpt-luna-latest — run 12c083af, 2026-10-10, 5m48s, $0.0249 (high)
# worktree: brl-subagent-wt-322-review2 @ 93c29f8 (detached)

APPROVED

| Focus | Severity | Command / evidence | Observed result |
|---|---|---|---|
| Isolation | None | Source review; `recovery.test.ts` | The isolated case directly spawns the wrapper, registers it, and calls `reapActiveChildren()`—no `runSubagent` path or reachable run exit sweep. Death assertions follow only a bounded wait. The retained run-based test explicitly labels itself accounting, not isolation. |
| Mutation A | None | Scratch copy; `npx vitest run src/__tests__/recovery.test.ts -t '#322 isolation'` | Failed as required at `recovery.test.ts:919:37`: `AssertionError: expected true to be false` (`pidAlive(grandchildPid)`). PID-list assertions passed. |
| Mutation B | None | Scratch copy; same focused test | Failed as required at `recovery.test.ts:909:20`: `AssertionError: expected [<wrapperPid>] to include <grandchildPid>`. |
| Seam safety | None | Focused guard test; temporary scratch cleanup test; source review | With both `NODE_ENV` and `VITEST` cleared, the seam throws. Its token uses the same shared monotonic counter and format as real spawns. `deregister()` restores the registry count; repeated deregistration remains clean. No production entrypoint imports or calls the seam. Raw TypeScript ships, so the runtime gate is the boundary; it depends on production not setting test-environment flags. |
| `waitUntil` | None | Call-site search and source review | Existing callers retain the default throwing behavior. Only the isolated test passes `false`; the wait is bounded at 5s and unconditional death assertions follow. |
| Gate A | None | `tsc`, Vitest, docs/README checks, recovery test ×3, process check | Typecheck clean; full suite **67 files / 1367 tests passed**; docs map current (39 modules); README guard passed (1300+ claimed, 1367 ran). Recovery file passed **44/44** in each of three runs (~7.42s each); no `sleep 300` or brl-grandchild leftovers. `git diff --check` clean. |

**New findings:** None. Test diff review found no deleted or weakened assertions. Installed TypeScript, Vitest, jiti, and pi SDK versions match the lockfile; the worktree remains clean at the reviewed tip.

**SOLID/DRY violations flagged: 0**

Findings banked at `/tmp/review324b-findings.md`.

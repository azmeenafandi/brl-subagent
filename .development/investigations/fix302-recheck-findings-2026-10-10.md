# PR #307 scoped re-verification (fix302, after Fix-T)
# reviewer: openrouter/~openai/gpt-luna-latest — run dd207682, 2026-10-10, 5m19s, $0.0401
# worktree: brl-subagent-wt-test-hygiene-review @ 956c260 (detached)

APPROVED

- Verdict: approve

| Original finding | Disposition | Command / observed result |
|---|---|---|
| **A — major** (`src/index.ts:3515`) detached auto-approve could lose the merge | **Fixed** | Reproduced both Git sequences in scratch repos. Deleting the work branch made `git fsck --no-reflogs --unreachable` list the merged commit; preserving `brl-subagent-review` kept it reachable after switching to `main`. Attached-start control merged onto `main` and deleted the temporary branch. |
| **B — minor** (`src/__tests__/e2e-subprocess.test.ts:497–503`) invariant assertions were not first | **Fixed** | Source order now places both invariant checks immediately after the call. Diff shows the checks were moved, not removed. Detached-worktree e2e passed: 1 file, 7 tests. |
| **C — observation** (`src/session-manager.ts:897`) catch-all could bypass teardown | **Fixed** | Removing the catch-all cleanup call in a scratch worktree made its test fail: expected `restoreHead` once, got zero. A scratch idempotency probe also passed: a post-cleanup throw did not repeat cleanup, and a second spawn received a fresh guard. |
| **D — minor** (`src/__tests__/fixtures/temp-git-repo.ts:55–64`) setup failure could leak temp repo | **Fixed** | `npx vitest run src/__tests__/temp-git-repo.test.ts`: 2 passed. Tests inject failures at init and at `git add` after setup has begun; neither leaves a matching temp directory. |

**A design check:** Preserved refs are not cleaned by later runs; teardown only targets that run’s work branch. This is consistent with the durable-ref choice and is documented in the code and PR fix-round section; the log identifies the preserved branch. Names use an 8-character UUID prefix; collisions fail branch creation rather than overwrite an existing ref. Preserved branches therefore accumulate until manually removed, an intentional retention cost rather than a silent loss.

**Regression and Gate A**

- `npx tsc --noEmit` — clean.
- `npx vitest run` — **66 files passed, 1343 tests passed**.
- `node scripts/docs-arch.mjs` — module map current (39 modules).
- README guard — **README says 1300+, suite ran 1343 — OK**.
- JSON test report — **335/335 suites and 1343/1343 tests passed**; report removed after checking.
- Fresh detached scratch worktree at `956c260`: branch-mode e2e **1 file / 7 tests passed**; HEAD unchanged at `956c260add468ce1ec4776a86bd759a7562de0de`, no `brl-subagent-*` refs left. Scratch worktree removed.
- Attached-start behavior: auto-approve test confirms merge + delete; real-Git control confirms the merged commit remains on `main` and the temporary branch is gone.
- Test diff review: B’s assertions were relocated, not weakened or deleted.
- Scratch repos/worktrees and the temporary report were cleaned up; review worktree remains clean.

**Environment:** Node `v24.14.1`, Vitest `5.0.1`, TypeScript `7.0.2`, and installed `pi-coding-agent` `1.1.0` match the lockfile. No standard installed `brl-subagent` extension copy was present; tests exercised the checkout source, so live extension reload/run-entry behavior was not claimed.

**New findings:** None.

**Verified OK:** A–D dispositions, attached and detached Git reachability, cleanup idempotency and per-run scope, full regression gates, and clean worktree state.

**Gate A note:** Real-Git scratch sequences reproduced the unreachable-commit failure and verified its fix; detached e2e and attached-start controls passed.

**SOLID/DRY violations flagged: 0**

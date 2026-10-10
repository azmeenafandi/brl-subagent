# PR #307 adversarial review findings (test-hygiene / #302)
# reviewer: openrouter/~openai/gpt-luna-latest (project-reviewer preset) — run 5710a8b8, 2026-10-10, 9m15s, $0.0570
# worktree: brl-subagent-wt-test-hygiene-review @ d2d72fa (detached)

CHANGES-REQUESTED

| Severity | File:line | Finding and command → observed result |
|---|---|---|
| **major** | `src/index.ts:3455–3505` | **Detached auto-approval reachability changes in this PR.** On a detached start, the new flow restores to the captured SHA, then auto-merges and deletes the work branch. I compared the old and new Git command sequences in scratch repos: the old `git checkout HEAD` stayed on `brl-subagent-test`; merge reported “Already up to date,” and branch deletion failed because it was checked out. The new `git checkout --detach <base>` followed by merge fast-forwarded to the work commit and deleted its branch; after `git checkout main`, `git fsck --no-reflogs --unreachable` reported that commit unreachable. This contradicts the claim that #308 is unchanged/pre-existing; the detached auto-approve case needs a durable ref or a safe refusal/alternative. |
| **minor** | `src/__tests__/e2e-subprocess.test.ts:497–514` | The invariant guard is **not first after the call**: exit-code and output assertions at 497–506 precede it, despite the comment at 511–512. Source order confirms this. |
| **observation** | `src/session-manager.ts:887–929` | The background settle-handler catch-all calls `markTerminalBestEffort` without `cleanupWorkBranch`; an exception before the normal cleanup call can bypass teardown. `grep -n 'cleanupWorkBranch()' src/session-manager.ts` showed the five normal call sites, but none in that catch-all. |
| **minor** | `src/__tests__/fixtures/temp-git-repo.ts:51–55` | Successful callers clean up the returned temp repo, but setup failure after `mkdtemp` can leak it: the helper has no failure cleanup and callers only learn the path after it resolves. `find /tmp ... brl-e2e-git-* brl-gate-a-*` was empty after successful tests. |

### Mutation checks

- **Item 1 — expected by task:** removing `cwd` at PR tip should make the invariant guard fail and expose a stray branch. **Observed:** in a detached scratch worktree at `d2d72fa`, the test failed later at the stub-log assertion (`expected [] to have a length of 1`); the invariant assertions had passed, HEAD remained `d2d72fa04ac6a32b601ff58e99e99642fc38856c`, it remained detached, and `git branch --list 'brl-subagent-*'` was empty. The Item 2 teardown fix prevents the requested mutation from creating a stray at this tip.
- **Supplemental Item 1 check:** at detached commit `9316317`, the same `cwd` mutation failed at the project branch-list guard: `expected '* brl-subagent-166de613' to be ''`; HEAD was on `brl-subagent-166de613`. I deleted that branch and removed the scratch worktree.
- **Item 2 — expected:** tests fail if detached starts are treated as attached. **Observed:** changing the detached catch result to `detached: false` made 3 tests fail (unit detached-state test and 2 real-Git tests); 27 passed. The mutation was reverted.

### Verified OK / Gate A

- Confirmed the original test passed `gitMode: "branch"` without an isolated `cwd`; the new test creates a real temp repo, passes `cwd: tempRepo`, compares **PROJECT_ROOT** HEAD SHA and `brl-subagent-*` branch list, and checks the temp repo’s branch list.
- Fresh detached scratch worktree at `d2d72fa`: `npx vitest run src/__tests__/e2e-subprocess.test.ts` → **1 file, 7 tests passed**; HEAD stayed at the tip and no work branch remained.
- The prepped detached review worktree’s full suite: `npx vitest run` → **64 files passed, 1337 tests passed**. Afterwards HEAD was still `d2d72fa`, detached, with no `brl-subagent-*` branches.
- `npx tsc --noEmit` → clean. `node scripts/docs-arch.mjs` → module map current (**39 modules**). README guard → `README says 1300+, suite ran 1337 — OK`; JSON run recorded **331/331 suites and 1337/1337 tests passed**.
- Attached restore behavior is still `git checkout <branch>` (asserted by the command-shape test); the attached-start e2e path passed and its temp repo had no surviving work branch.
- Test diff review found no meaningful existing assertions removed; setup helpers were extracted and git mocks updated for the new API.
- `createTempGitRepo` writes under `os.tmpdir()` with repo-local Git config. Successful test callers clean up; no scratch repos or worktrees remained after review cleanup.
- Environment checked: Node `v24.14.1`; installed Vitest `5.0.1`, TypeScript `7.0.2`, and pi-coding-agent `1.1.0` matched the lockfile. The e2e harness starts a fresh child and loads the checkout’s `src/index` via Jiti; no installed brl-subagent extension copy was found to be stale.

**SOLID/DRY violations flagged: 0.** No persistent files were modified; scratch worktrees, mutation edits, and the temporary test report were cleaned up.

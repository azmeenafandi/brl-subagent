# PR #316 focused review findings (#315 terminal-notice dedupe)
# reviewer: openrouter/~openai/gpt-luna-latest — run 30a1d300, 2026-10-10, 4m6s, $0.0235 (medium thinking)
# worktree: brl-subagent-wt-fix315-review @ f526b2a (detached)

**APPROVED**

| Focus | Severity | Command | Observed result |
|---|---|---|---|
| 1. No notice lost | — | `npx vitest run src/__tests__/terminal-notice-dedupe.test.ts --reporter=verbose` | 8/8 passed. Failed runs emitted `subagent-completion` for `all`, `failed`, and `off`; `off` still sends with `nextTurn` and `triggerTurn: false`. |
| 2. Exactly one notice | — | Same targeted run; `grep` of `src/session-manager.ts` | Failed settle and both crash paths each produced one expected message; both event+crash races produced one completion. Settle emits `subagent:failed`. The wake claims before context/agent guards, but current `session-manager.ts` has no agent-removal path, and a poller starts with a session context; I found no currently reachable same-run crash notice that those guards would suppress. |
| 3. Mutation checks | — | Three mutations in `/tmp/review316-mut`; targeted Vitest runs | All detected: restoring the failed-branch send failed 4 tests (duplicate count 2); suppressing one crash guard failed its one-notice test (0 vs 1); bypassing a crash claim or removing the wake claim failed race assertions (2 vs 1). Scratch source was restored; review worktree remains clean. |
| 4. Test seam | — | `grep` for `__resetTerminalClaims` and `__setStorageDir` | Reset callers are tests only; the live suite resets in `beforeEach`, and unit tests reset in `afterEach`. The test-only export follows the existing `__setStorageDir` precedent. |
| 5. Residual references | minor | `git grep -n 'subagent-notification' HEAD -- README.md docs src .development` | No README, TUI/history, or runtime consumer relies on the deleted failure message. Historical `.development/AUDIT.md:570` and `.development/INVESTIGATION_reload_wake.md:41` still describe the failure notice as retained/the failures signal. `src/index.ts:2834` refers only to the separate `delegate-notification` pattern. |
| 6–7. Flake watch and Gate A | — | `npx tsc --noEmit`; `npx vitest run --reporter=json --outputFile=/tmp/rev315.json`; docs and README guards | No Gate-A flake observed. Typecheck exited 0; 67 files, 343 suites, 1360/1360 tests passed; docs map current (39 modules); README guard accepted 1300+ vs 1360. Test diff adds assertions; no assertion/test lines were deleted or weakened. |

**Mutation detail:** The poller duplicate mutation failed the primary exact-one test and all three knob cases. For the crash guard, suppressing the send failed the standalone exact-one assertion; bypassing the guard failed the corresponding race assertion. Removing the wake claim failed both race tests.

**Environment note:** Installed SDK and lockfile both report `1.1.0`. Installed `brl-subagent` source hashes differ from this review tip, and no local session/subagent logs were found, so the verification is against the checked-out source—not a live reloaded installation.

**Additional minor nit:** `src/index.ts:2362,2447` repeats the same claimed `subagent-notification` send envelope at the two crash sites; a small helper could remove the duplication.

**SOLID/DRY violations flagged: 1** — duplicated crash-notice send envelope.

**Gate A:** All requested checks passed. **Repo files modified: none.** Review notes and mutation scratch files were confined to `/tmp`.

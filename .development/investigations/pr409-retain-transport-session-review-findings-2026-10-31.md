# REVIEW — PR #409 (feat/404-retain-transport-session) @ `25e7d12` + conductor fix `0fb15e0`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — **C1 adversarial** (project-reviewer preset, high), Jev **high (0.54) · C1**. Issue #404, plan v2 (post-critique).

Reviewed head: 25e7d12

**Verdict: approve-with-nits** — 2 minors, both resolved (nit 1 fixed in `0fb15e0` with a mutation; nit 2 acknowledged as an intentional test-side pin).

## Findings

| Severity | File:line | One-liner | Disposition |
|---|---|---|---|
| minor | `src/index.ts` resolve callsite | No test pinned `path.resolve` under a **relative** `STORAGE_DIR` root — the one case where it is load-bearing (the default root is relative `.pi/subagents`); test env always sets an absolute root, so dropping `resolve` was unobservable | fixed: extracted `retainedSessionPointer(id)` in session-manager + a relative-root pin; **mutation (drop `resolve`) → 1 failed / 28 passed**, restored 29/29 |
| minor | `background-session-persistence.test.ts` | Tests re-declare the `.transport-retained` literal instead of sharing it | acknowledged: intentional test-side pin (a source rename shows up as a red test); no change |

conductor-verified: 0fb15e0 — extracted `retainedSessionPointer` (absolute resolve in one place), the relative-root test, mutation red (1/28) then restored; full suite **91 files / 1831 tests**; `tsc` clean; `git diff --check` clean. No behaviour change beyond the extraction.

## Verified-OK (review)

- **Ordering/invariant:** guard → pure hoisted `errorCategory` → pure `isTransportRetryable` → mark/prune → entry → `persistRunRecord`; a post-mark throw leaves a *marked* (sweepable) dir; marker failure prunes — bounded on every path.
- **Gate == reader:** the settle builds the predicate from the exact values the record persists (`errorMessage = error`, same category, the `originalParams` stamp touches only the shadowed fallback); attempt-2, non-transport, completed and foreground runs all prune; **interrupted-then-settles stays unmarked** (mark strictly inside `!interruptedAt`).
- **Marker + sweep:** captured dir, marker mtime recency, marked-only walk, foreign-id skip, sessions-root guard, current dir exempt (overshoot-by-one; the next settle reclaims), fail-closed on marker-write failure, never throws into settle.
- **Size floor** (<2 KB skip) premise pinned; **preamble** absolute + exists-gate both ways + "newest .jsonl"; the deliberately updated #401 pins are not weaker (absent-case asserts absence; present-case extracts and compares the absolute pointer).
- **Predicate refactor:** `isTransportFailure` extraction byte-identical; #365 matrix unchanged (22/22).
- **Tests:** 28/28 persistence at review time (all five critique pins present); mutations: drop retention RED, retain-unconditionally RED ×2, drop sweep RED, drop exemption RED, drop marker-fallback RED, genuine relative-pointer RED.
- **Docs:** D5 comment (retention exception), ARCHITECTURE paragraph, measurement debris criterion, AGENT/README/CHANGELOG — accurate and consistent.
- **No collateral:** full suite 91/1830 at review (1831 after the pin), `tsc`, `git diff --check`, clean worktree; nothing half-done from the two-attempt implementation (attempt 1 died; attempt 2 resumed from the uncommitted work + the bank — the #401 preamble's first real use).

## Disposition

Merged after `merge-guard.sh`. #404 closed. The retained session is the third salvage channel (#401's preamble now names it), completing the retry story: files/commits + bank + session.

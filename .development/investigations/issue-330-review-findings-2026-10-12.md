# Review record — PR #332 (#330 run surfaces newest-first, corrected direction)

Focused C2 review (project-reviewer + focused-review) · model `openrouter/meta/muse-spark-1.3-contributor` · 2026-10-12
Review worktree: detached @ `205927c` · bank: /tmp/review-330-findings.md
Jev (pre-dispatch): `medium (1.0) · C2 · worktree y` — chosen medium.

## Verdict: approve — no findings

- **Findings table:** none.
- **Sort correctness:** `sortNewestFirst` newest-first, stable ties, non-mutating; invalid-date behavior unchanged;
  `cleanupRuns` trim preserved + sorted-copy on the unlimited path — verified.
- **Bridge union:** sorts only when synthetics exist; the empty path returns `sessionEntries` by reference
  (2 pre-existing asserts); no mutation of the input; dedupe unchanged — verified.
- **Blast radius:** the four bridge consumers agree; the `.reverse()` removal is the retry-list fix; no import
  cycle (`history` imports neither `state` nor `recovery-surface`) — verified.
- **Test discrimination:** both mutations failed EXACTLY as predicted pre-run, scoped to the file, scratch-only —
  bridge sort removal → 2 failed / 8 passed; `cleanupRuns` unlimited-sort removal → 1 failed / 11 passed — verified.
- **Coverage:** every search reconciled — net branch diff 5 files 122+/15−, no `src/state.ts` net change, the two
  remaining `.reverse()` hits are unrelated session-manager message scans — verified.
- **Reclassification:** no C1 issues found.

## Context

This is the CORRECTED direction: the branch's first commit `6331fa0` was a reverse-based attempt from a
disproven premise (the source order was already newest-first via `cleanupRuns`); `205927c` superseded it, and
the reviewer assessed the NET diff.

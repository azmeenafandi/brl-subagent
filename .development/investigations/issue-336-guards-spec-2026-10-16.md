# Issue #336 guards — silent boundary/partial-read hardening (P0)

jev: medium (0.71) · risk C2 · worktree n → **conductor override: worktree y** (process uniformity; the Jev
`worktree` cell misreads non-`src/` targets — the same known misread recorded for `src/__tests__`).
Worktree: `../brl-subagent-wt-336` · branch `fix/336-boundary-guards` (from `dev`; lockfiles match → symlinked prep).
Review: focused C2 (`project-reviewer` + `focused-review`), model `openrouter/meta/muse-spark-1.3-contributor`.

## Context

#336 (P0, Rule 11): the silent boundary/partial-read class recurred ×2 — the #330 spec premise (a partial read of
`getRunEntries` before its `cleanupRuns` return) and the v2.5.1 sprint-metrics window (time-suffixed bounds compared
as raw strings → a whole day silently dropped; 22 dispatches counted vs 68 spawns). Tuesday's same-day fixes landed
the true-timestamp `in_range` and the cycle-end reference rewrite; the **mechanical guards** are this unit.

## Recon (Rule 13)

**Coverage boundary — recorded, not silently skipped:** the structural index covers `src/**` only; this unit's
targets are `.pi/skills/worktree/**` + `scripts/**`, OUTSIDE the index (the same boundary the dependency-bump specs
recorded for `package.json`). `recon.sh` has no meaningful target for a docs/tooling unit, so the **audit itself is
the coverage instrument**; the corpus was enumerated by:

```
ls .pi/skills/worktree/*.py .pi/skills/worktree/*.sh scripts/*.mjs
→ check-repo.sh, codegraph-check.py, codegraph-refresh.sh, recon.sh, sprint-metrics.py, worktree-cleanup.sh,
  worktree-prep.sh | check-readme-test-count.mjs, docs-arch.mjs, docs-decisions.mjs, ts-ast.mjs   (11 files)
```

## The guards

1. **Cycle-end count reconciliation** — in `references/sprint-end-ritual.md` part 2 (Trust metrics): a documented
   command reconciling the row's dispatch count against the extension log's spawn count over the same window;
   **>20% delta ⇒ suspect the window/counting** before trusting the row (cite the 22-vs-68 incident). Command
   shape: `rg '"Background agent spawned"|"Background fan-out spawned"' .pi/subagent-logs/brl-subagent.log`
   filtered to the window, versus the row's `dispatches` count.
2. **Window/filter parser audit** — for every file in the 11-file corpus: does it parse/compare bounds, dates,
   counts, or filter a corpus? Verdict per file (N/A · safe · fixed), and **every window-taking tool prints its
   effective scope**. Deliverable: the audit table in the PR body + the report. Known checks: `sprint-metrics.py`
   prints its window (verify); `codegraph-check.py` / `recon.sh` compare commits (not time windows — verify no
   silent boundary); `check-readme-test-count.mjs` compares counts (verify its drift boundary states what it
   measured).
3. **Recon checklist line** — in `SKILL.md` Rule 13: a bullet requiring that any spec claim resting on a function's
   **ordering / filtering / return shape** be verified **through the terminal call boundary** (the #330 shape:
   `getRunEntries`'s `return cleanupRuns(...)`), not just the symbol; graph gaps are findings.
4. **Permanent bounds self-test** — `sprint-metrics.py --selftest`: cover time-suffixed vs date-only bounds, the
   inclusive ends, naive=UTC, invalid/missing values, and the pre-fix regression shape (a time-suffixed bound must
   NOT drop its day). Exit non-zero on failure; print each case. **Wire one step into `ci.yml`** (the test job:
   `python3 .pi/skills/worktree/sprint-metrics.py --selftest`); document the invocation in the cycle-end reference.

## Verification

- `python3 .pi/skills/worktree/sprint-metrics.py --selftest` → exit 0 with per-case output.
- **No behavior change:** `--since 2026-10-10 --until 2026-10-13` → **75 dispatches**; `--since
  2026-10-10T02:00:00 --until 2026-10-13T12:00:00` → **69** (Tuesday's observed values).
- The audit table covers all 11 corpus files (coverage line: the enumeration command + count).
- `git diff --check`; full suite (`npx vitest run`) as hygiene — report counts (no `src/` changes).
- If CI is touched: show the step diff and that the workflow still parses (YAML).

## Constraints

- Targets under `.pi/skills/worktree/**` are ALLOWED for this unit (that is the point); `.github/workflows/ci.yml`
  only for the one self-test step.
- Do NOT modify `.development/**`; no `src/` edits; node_modules symlinked (no installs).

## Out of scope

Any behavior change to metric derivation beyond the guards; `src/` changes; the `sprint`→`cycle` terminology
(already done).

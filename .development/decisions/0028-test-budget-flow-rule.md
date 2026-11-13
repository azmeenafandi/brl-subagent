# 0028. The test budget is a per-PR flow rule, not a stock ratio ceiling

- **Status:** Accepted
- **Date:** 2026-11-13
- **Issues:** #490 (the two-surface budget), U0a of the shipped-half cycle (PR #523)
- **Supersedes:** ADR 0027 **D7's test-budget clause only** — "the test-budget check
  (`check-test-budget.mjs`, ratio ≤ 2.0) … [is a] stage gate". The ratio is now reported with a
  warning band and is **not** enforced; the stage gate is the flow rule below. Everything else in D7
  stands.

## Context

The `src` test:source ratio was set at **1.96 + 0.04** — a ratchet at history, never a measured
quality line. It reached **1.99 of 2.0** (388 test lines of headroom) because the composition-root
refactor made previously untestable seams testable: test lines grew **+5,033** against **+2,197**
source lines, and **46%** of that growth is `s6-seams`/`s6-trace` alone. Those tests are behaviour
(`"rejects an empty task before any runner is reached"`), not wiring.

Measured before deciding:

- **2,469 test blocks; 61 (2.5%) carry no `expect`/`assert`**, and most of those call an asserting
  helper.
- **101 exact-shape duplicate groups cover 209 extra blocks** (8.5%, an upper bound — the normaliser
  strips literals, so `expect(f("a")).toBe(1)` and `expect(f("b")).toBe(2)` collide).
- Physical lines are the unit, and source is **34.7% comments** against tests' **14.3%** — so the
  ratio rewards writing prose in `src/` and taxes writing tests. Counting code only would move 1.99
  to **2.54**; the current number is already lenient.
- The existing floor matched imports inside comments, template strings and `import type` — its own
  docstring claimed otherwise.

A stock ratio cannot distinguish "a 500-line module merged with no test" (it barely moves) from
"200 lines of tests for a 100-line feature" (it jumps). Two critique rounds on the replacement found
two blockers worth recording: the evidence check **skipped any body without a block**, and the merge
gate **ran the PR tree's own copy of the checker**, so a PR could weaken the rule that judged it.

## Decision

**(A) The stock is a report; a per-PR flow is the gate.**

- `check-test-budget` prints the ratio with its warning band and **never fails on it**. The `src`
  floor and the scripts floor remain hard.
- **Flow rule:** for each surface, `allowance = 120 + 2 × max(Δsource, 0)` on **net** lines
  (`Σadded − Σdeleted`, `--no-renames` so a source↔test move is visible). A PR is `within` only
  when every surface with a nonzero delta is. Exit 0 within · 1 over · 2 unanswerable
  (`unknown-head`, `already-merged`) — an unmeasurable flow is a block, never a zero.
- **Enforcement is trusted:** `merge-guard` (g) always runs the **cockpit's** copy of the tool against
  the PR head; the PR tree is never consulted for the flow. Over requires a body line
  `Test budget: <reason>` outside fences, blockquotes and the evidence block; presence, not content.
- **Floors are reachability, not coverage:** every non-test source module must be reachable from a
  `*.test.ts` through import edges (transitive; helpers only when a test reaches them; re-exports and
  type-only imports do not create reachability). Today 58/58 `src`, 12/12 `scripts`. The parser masks
  comments and strings and excludes type-only imports; masking is fail-closed (a hidden import shows
  as **missing**, never as passing).
- **Accepted limits, stated:** two test-only PRs of +120 each stay `within` and accumulate; a
  replacement (N out, N in) measures zero. The cycle-close row records the stock and says why if it
  is above the warning band.

## Consequences

Write tests for new behaviour without asking permission, and declare a deliberate backfill in one
line a reviewer can judge. Deleting coverage no longer buys headroom — which was the failure mode of
a stock ceiling. The merge gate now depends on the cockpit's tooling being current (`git pull`
before the gate); the flow is computed by trusted code, while the remaining five evidence keys still
run in the PR tree — its own follow-up, tested by a tampered-tree falsifier.

## Alternatives considered

- **Raise the ceiling to 2.2.** Rejected: it moves the wall without changing the incentive, and the
  next refactor meets 2.2 the same way.
- **Dedupe only.** Rejected as the fix: the realistic yield is 500–1,500 lines (1–3%), one cycle of
  headroom bought by deleting coverage. Retained as a separate, pointed audit (U0b).
- **Changed-line coverage as the gate.** Deferred, not rejected: it measures value rather than
  volume, but it is a tooling unit of its own. Trigger to revisit: two reviews find a behaviour
  change with no covering test.

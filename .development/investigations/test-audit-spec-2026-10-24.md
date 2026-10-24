# Test-suite audit — next cycle, unit 1

jev: **high (0.54)** · risk **C2** · worktree **y** (Jev's `worktree` cell said n — the documented `src/__tests__`
misread; the worktree-guard governs). Review: C2 focused (test infrastructure; the risk is weakened coverage).

## Context

The `menu polish + live signals` cycle closed on 2026-10-24 (v2.6.0). The audit is the next cycle's first unit,
agreed at the close: the suite grew to **82 files / 1701 tests** and the cycle-end sweep surfaced the usual question —
which tests earn their keep? The maintainer's framing: *not* fewer tests for their own sake; the audits from the
suite itself.

Measured inventory (2026-10-24, vitest 5.0.5):

| Fact | Value |
|---|---|
| Suite | 82 files / 1701 tests · **~17 s** wall locally · CI ~50 s |
| Test LOC / source LOC | **34,433 / 21,238 = 1.62×** |
| Runtime composition | tests 55% · imports 42% · transform 2% |
| Dominant files | `e2e.test.ts` 12.1 s (29 tests) · `e2e-subprocess.test.ts` 11.2 s (7) · `recovery.test.ts` 10.9 s (61) — everything else < 1.1 s |
| Dense unit files | `integration.test.ts` 108 tests / 51 ms · `types` 69 / 30 ms · `sanitize` 63 / 25 ms · `validate` 58 / 25 ms |

## Goal

Three deliverables, in order of value:

1. **Mechanical budget pins** — a `scripts/check-test-budget.mjs` reading the vitest JSON report:
   - **wall-time ceiling** (local suite ≤ 60 s; the current 17 s is 3.5× headroom),
   - **test:source LOC ratio ceiling** (≤ 2.0; today 1.62).
   Wire it into CI beside the README count guard. The budget is a *ceiling*, not a target: growth needs a reason,
   shrinking is always allowed.
2. **A mutation sample that hunts behaviour-pinning gaps** — pick 4–6 modules across hazard classes, pre-state each
   mutation's signature, run it, and record **survivors**. For each survivor: is it a missing pin (add the test) or a
   test that merely mirrors implementation (rewrite/delete)? Suggested set (conductor picks in the spec step):
   `kill-escalation`, `run-registry`, `session-manager` (background lifecycle), `validate` (pre-flight), `tui-format`
   (pure formatting), `menu-config-items` (newest surface).
3. **A weak-test / consolidation report** — what the sample found, plus the cost profile's implications: the e2e pair
   is the wall's floor (real gates — recommendation only, no architecture change), the import share (42%) argues for
   consolidation only where it is free (no churn for its own sake). Explicitly **no mass deletion**.

**Outcome can legitimately be "prune zero, add pins"** — the report's honesty matters more than its action count.

## Scope

- In: `src/__tests__/**` (evidence-backed rewrites only), `scripts/check-test-budget.mjs`, `.github/workflows/ci.yml`,
  the report `.development/investigations/test-audit-2026-10-24.md`, README/ARCHITECTURE notes for the budget.
- Out: production source changes; coverage-percentage gates; the e2e subprocess architecture (recommendation only);
  test-count targets; re-litigating the intentional source-scan guards (`status-chokepoint`, `architecture-rules`).

## Acceptance

- The budget guard **fails on an over-budget fixture** (mutation-verified) and **passes on the real suite**; CI runs it.
- The mutation sample: every mutation's expected failure pre-stated; the tree restored; survivors enumerated with a
  disposition each.
- Any test removed/rewritten has an evidence line (the mutation it survived, or the behaviour it failed to pin).
- Full suite green, `tsc --noEmit` clean, the report committed.
- A recommendation on whether the audit becomes a permanent cycle-end step (bounded: run the budget guard + sample
  one module per cycle).

## Risks / calibration

- **C2** — the failure mode is a test that looked redundant but was the only pin. Mitigation: mutation evidence before
  any deletion; the conductor reviews each removal; no mass edits.
- The budget's wall ceiling is local-wall–based; CI wall varies by runner — the guard reads the JSON's own timing and
  documents the margin.

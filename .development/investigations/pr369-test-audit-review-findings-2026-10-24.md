# REVIEW — PR #369 (test-suite audit) @ `8b01578`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — focused C2, Jev **high (0.38)**. Issue #368;
spec `.development/investigations/test-audit-spec-2026-10-24.md`.
Diff `3de1848..HEAD`: the budget guard (new), CI (+1 step), ARCHITECTURE (+3), one added pin, the report.

**Verdict: approve-with-nits** (1 minor) → fixed `b717b44` → merged `8246f05`.

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| minor | `scripts/check-test-budget.mjs:123` | The ratio breach message names value + limit but omits the report path, unlike the wall message |

## Verified-OK

- **Guard math:** wall = report `startTime` → max file `endTime` (no per-file deltas); ratio = physical lines over
  `src/**/*.ts` split on the `__tests__` segment; an independent recount matches **34,444 / 21,238 = 1.62**.
- **Failure paths:** the real report exits 0 (wall 15.66 s, ratio 1.62); independent `/tmp` fixtures breach each
  ceiling alone with **exit 1** (wall 61.00 s; ratio 2.50 on an isolated `src/` tree); exit 2 on usage/malformed
  paths; both ceilings are named constants; LOC is counted from disk.
- **CI:** the budget step runs after the vitest JSON report + the README count guard on the same report path; no
  `continue-on-error`/`|| true` — a breach fails the job.
- **Mutation matrix re-verified independently:** **M5** (`< 60` → `<= 60`) kills exactly the exactly-60 s boundary
  test; **M2** (the survivor) gives 1 failed / 22 passed with the new pin — failing on the `interruptedAt`
  overwrite for the right reason — and 22 passed with the pin removed (genuine pre-existing gap). M1/M3/M4/M6 kill
  claims are plausible from the named tests' code.
- **M2 is a missing pin, not a mirror:** the source already contracts "Idempotent", and an overwrite would silently
  reset the recovery age; the new test asserts both return values and first-timestamp preservation.
- **No collateral:** `src/` diff +11 lines, zero deletions; suite **82 files / 1702 tests** green; `tsc` clean; the
  report's wall table matches the JSON; the ARCHITECTURE bullet is accurate; the recommendations (e2e stays, one
  module per cycle, ceilings-not-targets) follow the evidence.

SOLID/DRY violations flagged: 0

## Disposition (2026-10-24)

- **Minor: FIXED** in `b717b44` (the ratio message names the report path). CI green. Merged `8246f05`.
- **Audit outcome: prune zero, add one pin.** The report is `test-audit-2026-10-24.md`; the budget guard runs in CI
  on every PR. Recommendation adopted: one module mutated per cycle, the budget guard as the standing check.

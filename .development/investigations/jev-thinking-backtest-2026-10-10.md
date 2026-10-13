# Jev thinking-level backtest (2026-10-10)

**Question:** can TypeSafe's Jev classifier (System One) pick the *minimum* thinking level for a dispatch?
**Method:** all **98** production dispatches in the sprint window (2026-09-28 → 2026-10-10) from `.pi/subagents/`, classified **blind** (task text only — my chosen level was not in the state). Three typed questions per item: `level` (off…xhigh, criteria = the project's heuristic), `risk` (C1/C2/C3), `worktree` (bool). Via `codemode` → `models.classify("openrouter", "~typesafe/jev-latest")`. **Cost: $0.0034 total, ~14 s wall.**

## Results

- **Exact agreement: 46/98 (47%) · adjacent (±1): 39 (40%) · far (≥2): 13 (13%)**
- **Jev-above (it wants MORE than I chose): 14** — 6 of those were failed runs (confounded: today's failures were connection drops, not level-caused)
- **Jev-below (it wants LESS): 38** — **16 of my 40 `high` runs and 19 of my 40 `medium` runs were downgraded**

Confusion (mine → Jev): `medium→medium 17 · high→high 17 · medium→low 12 · high→medium 11 · high→xhigh 7 · medium→minimal 7 · high→low 4 · medium→high 3 · low→minimal 3 · off→off 10 · off→minimal 2 · high→minimal 1 · others 1 each`.

### It flags the over-leveling we already suspected
`impl-codegraph-phase1` high→low · `impl-test-hygiene` high→low · `impl-fix315` high→minimal · `retire-graphify` (both runs) high→medium · SDK bumps `medium→minimal` ×4 · `impl-277a` / `impl-274-275` medium→minimal.

### It pushes reviews and multi-factor work UP
`review-u1` high→xhigh (failed) · `review-fix315` / `-r2` medium→high · `review-test-hygiene-r2` high→xhigh (**the review that caught the #308 regression**) · `impl-299-probe` medium→**xhigh** (Δ2) · `proposal-239/240` high→xhigh.

## Verdict: **advisory only — do not auto-pick**

- The disagreement is *systematic*, not noise: Jev discounts mechanical/plumbing work (SDK bumps, docs) but raises **reviews and investigations** — including the two reviews that found real bugs today.
- Its `minimal` calls ignore **operational burden** (worktree, suite, PR, evidence) that survives even trivial reasoning.
- There is no ground-truth label; outcomes don't discriminate (failures were external). So the classifier is a *second opinion*, not an oracle.

## Proposed Phase 1 (advisory wiring)

1. **Pre-dispatch advisory line** logged with the spec/dispatch: `jev: <level> (<confidence>) · risk <C1/C2/C3> · worktree <y/n>`. Deviations **≥2 levels** (and any *upward* deviation on a review) require a stated reason in the spec.
2. **Clamps:** floor `low` for any artifact-producing dispatch (worktree/PR/verification); for C1 reviews, if Jev ≥ `high` and the chosen level < `high`, state why.
3. **Re-run this backtest at the next sprint close** to track agreement and over-leveling cost; extend the state with the diff/change surface once available.

Cost per full sprint: **~$0.004**.

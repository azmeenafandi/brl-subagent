# Cycle Metrics (Trust Protocol — derived from session logs, never vibed; historically "Sprint Metrics" — read the "Sprint" column as the cycle label)

| Sprint | Dispatches | FG/BG | Success | Failed | Retries | Retry succ | Zero-work | Poll/dispatch | Steer | Stop |
|--------|-----------|-------|---------|--------|---------|------------|----------|--------------|-------|------|
| 2026-08-16 | 30 | 6/24 | 91.7% (22/24) | 8.3% (2) | 3 | 100.0% (3/3) | 4 (16.7%) | 0.07 | 0 | 0 |
| 2026-08-18 | 5 | 0/5 | 100.0% (4/4) | 0.0% (0) | 0 | 0% (0/0) | 0 (0.0%) | 0.0 | 0 | 0 |
| 2026-08-23 | 53 | 49/4 | 66.7% (34/51) | 33.3% (17) | 0 | 0% (0/0) | 2 (3.9%) | 0.09 | 1 | 0 |
| 2026-08-25 | 22 | 20/2 | 88.9% (16/18) | 11.1% (2) | 0 | 0% (0/0) | 0 (0.0%) | 0.14 | 0 | 0 |
| 2026-08-26 | 14 | 9/5 | 88.5% (23/26) | 11.5% (3) | 0 | 0% (0/0) | 0 (0.0%) | 0.0 | 0 | 0 |
| 2026-08-27 | 20 | 12/8 | 86.2% (25/29) | 13.8% (4) | 0 | 0% (0/0) | 3 (10.3%) | 0.1 | 0 | 0 |
| 2026-09-04 | 18 | 1/17 | 83.3% (15/18) | 16.7% (3) | 0 | 0% (0/0) | 0 (0.0%) | 0.5 | 0 | 2 |
| 2026-09-11 | 7 | 0/7 | 100.0% (6/6) | 0.0% (0) | 0 | 0% (0/0) | 0 (0.0%) | 0.43 | 0 | 0 |
| 2026-09-12 | 3 | 0/3 | 100.0% (3/3) | 0.0% (0) | 0 | 0% (0/0) | 0 (0.0%) | 0.33 | 0 | 0 |
| 2026-09-20 | 24 | 3/21 | 100.0% (21/21) | 0.0% (0) | 2 | 0.0% (0/2) | 0 (0.0%) | 0.46 | 0 | 0 |


> **The 2026-09-20 row carries a caveat.** Its 100% success / 0% zero-work figures are **contaminated by the #179 defect**, which was fixed and released *in* this sprint. Four dispatches died mid-work yet reported `status: completed` / `exitCode: 0`, so the session log recorded them as successes and no derived metric could see them. The true reading is **≈4 of 21 settled runs failed mid-work → ≈81% real success**, and those deaths never appear in `zero-work`. The friction log answers why (`dispatch-reliability`).
>
> **This should be the last contaminated row.** v2.3.7 shipped the fix, so the *source* of these numbers — the reported terminal status — is now truthful: a death is recorded `failed` and counted as one. Treat cross-sprint trend lines drawn through this row accordingly.
| 2026-09-22 | 36 | 1/35 | 94.3% (33/35) | 5.7% (2) | 0 | 0% (0/0) | 0 (0.0%) | 0.28 | 0 | 0 |
| 2026-09-26 | 11 | 0/11 | 81.8% (9/11) | 18.2% (2) | 0 | 0% (0/0) | 0 (0.0%) | 0.64 | 0 | 2 |
| 2026-09-27 (v2.3.9) | 19 | 2/17 | 75.0% (15/20) | 25.0% (5) | 0 | 0% (0/0) | 0 (0.0%) | 0.32 | 0 | 0 |
| 2026-10-10 (v2.5.0) | 101 | 0/101 | 74.4% (64/86) | 25.6% (22) | 5 | 40.0% (2/5) | 0 (0.0%) | 0.39 | 17 | 2 |
| 2026-10-13 (v2.5.1) | 75 | 2/73 | 72.4% (55/76) | 27.6% (21) | 3 | 100.0% (3/3) | 0 (0.0%) | 0.41 | 0 | 0 |
| 2026-10-17 (v2.5.2) | 16 | 6/10 | 62.5% (10/16) | 37.5% (6) | 0 | 0% (0/0) | 0 (0.0%) | 0.25 | 0 | 0 |
| 2026-10-24 (v2.6.0) | 40 | 1/39 | 87.8% (36/41) | 12.2% (5) | 2 | 50.0% (1/2) | 0 (0.0%) | 0.28 | 1 | 0 |
| 2026-11-01 (v2.7.0) | 60 | 5/55 | 79.1% (53/67) | 20.9% (14) | 15† | n/a† | 1 (1.5%) | 0.15 | 1 | 1 |

> **The 2026-11-01 row's Retries cell is log-derived, not tool-derived.** `sprint-metrics` counts only explicit `retryRunId` dispatches (it reported 0), while the session log shows **15 transport auto-retries** in the window; the 60-dispatches / 67-settled arithmetic does not reconcile with those retries (60 + 15 ≠ 67 either) — both are sweep candidates. The successful-retry split is therefore not yet computable and is written `n/a`.
| 2026-11-08 | 81 | 8/73 | 82.3% (107/130) | 17.7% (23) | 0 | 0% (0/0) | 0 (0.0%) | 0.46 | 7 | 1 |

> **The 2026-11-08 row's reconciliation does not close cleanly.** `sprint-metrics` reports 81 dispatch calls and 130 settled runs; the extension log shows 118 spawn events in the same window. The three numbers differ by retries and by window-boundary effects (a run can spawn before the window and settle inside it), and the tool's `Retries` cell is still 0 because it counts only explicit `retryRunId` dispatches — the same gap recorded on the 2026-11-01 row. Treat the dispatch count as a floor until the counter is fixed (sweep candidate).
| composition-root | 32 | 1/31 | 90.6% (29/32) | 9.4% (3) | 0 | 0% (0/0) | 0 (0.0%) | 0.72 | 3 | 0 |
| generated-artifacts | 69 | 1/68 | 90.7% (68/75) | 9.3% (7) | 0 | 0% (0/0) | 0 (0.0%) | 0.42 | 12 | 0 |

> **This row is tool-reconciled, not hand-reconciled.** `dispatches: 69 (51 direct + 18 codemode) · spawns: 75 · Δ 6`, allowance 7 (seven transport auto-retry starts, zero fan-out units) — every spawn is explained. The `Retries` cell still counts only explicit `retryRunId` dispatches (0), which is why the transport retries appear in the reconcile line and not in the column; the 2026-10-17/24/11-01 rows carry the same gap.

> **The composition-root row was reconciled by hand.** `sprint-metrics` counted **11** dispatches (direct `delegate_task` toolCalls); **21 of the cycle's dispatches ran inside `codemode` scripts** and are invisible to that scan. The extension log shows **31** `Background agent spawned` events in the window plus the one foreground dispatch = **32**, which equals the **32** settled runs. The dispatch count, fg/bg split and polls-per-dispatch were corrected from that source (23 polls / 32 = 0.72); the template and preset columns remain floors for the same reason. Filed as #489 (mechanical fix).
| scratch-hygiene | 12 | 0/12 | 80.0% (12/15) | 20.0% (3) | 0 | 0% (0/0) | 0 (0.0%) | 0.92 | 0 | 0 |
| shipped-half | 20 | 3/17 | 79.2% (19/24) | 20.8% (5) | 0 | 0% (0/0) | 0 (0.0%) | 0.6 | 0 | 0 |
> **The shipped-half row is tool-reconciled.** `dispatches: 20 (direct 20 + codemode 0) · spawns: 24 · Δ 4`, allowance 5 (five transport auto-retry starts, zero fan-out units) — every spawn is explained. The `Retries` cell still counts only explicit `retryRunId` dispatches (0), which is why the transport retries appear in the reconcile line and not in the column; the earlier rows carry the same gap.

| review-debt | 2 | 0/2 | 100.0% (2/2) | 0.0% (0) | 0 | 0% (0/0) | 0 (0.0%) | 1.0 | 0 | 0 |

> **The review-debt row reconciles exactly.** `dispatches: 2 (direct 2 + codemode 0) · spawns: 2 · Δ 0`, allowance 0 — both dispatches were background singles. Its `1.0` polls/dispatch is **two `get_subagent_result` calls, both post-wake reads of the final report** after the completion message — the metric cannot distinguish a completion read from stall polling, so the figure is a proxy, not babysitting evidence.

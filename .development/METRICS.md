# Sprint Metrics (Trust Protocol — derived from session logs, never vibed)

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

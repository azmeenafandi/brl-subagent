# REVIEW — PR #390 (#379 commit 2: gate-order pins) @ `9f424f5`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — focused C2, Jev **medium (0.66)**. Design authority:
`.development/investigations/mode-prologue-design-2026-10-25.md` (IN1–IN8).
Diff `b6eff30..HEAD`: `mode-prologue.test.ts` (new, 690 lines, **20** `it` blocks), `architecture-rules.test.ts` (+1 guard).

**Verdict: approve-with-nits** (2 minors) → count fixed + advisory comment → merged `35a0714`.

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| minor | task/PR description | Claimed "21 tests"; the file has **20** `it` blocks (vitest confirms) — PR body corrected |
| minor (advisory) | `mode-prologue.test.ts` (`expectOrder`) | First-occurrence matching cannot isolate mode-level vs per-unit duplicate events; the IN8 precedence/position tests cover the gap — a comment now records it |

## Verified-OK

- **Pins are real:** the gate wrappers call through to the actual implementations (`vi.mock` + `actual.X`); the cost/depth swap is caught by 2 tests (order + precedence); the spawn cost hoist by 2; each mutation restored, tree clean.
- **Pinned sequences match production:** chain `558→568→590→593→606→628`; parallel `1053→1063→1085→1088→1093→1116`; graph `dag(1500)→cost(1515)→depth(1525)→resolve(1547)→cwd(1550)→preflight(1563)→H1(1586)` (sort later at 1649); fan-out `cost(2046)→resolve(2056)→model(2059)→approval(2070)→targets(2121)→H1(2129)`; spawn `resolve(2571)→model(2577)→approval(2586)→cost(2599)→targets(2611)→H1(2622)`; no depth/preflight in either background path (absence confirmed).
- **The graph-cycle discrepancy is real and handled truthfully:** `validateGraph` (`scheduler.ts:155-188`) checks empty/over-limit/duplicate/missing-dep only — a probe proved it returns `[]` on a 2-cycle while `topologicalSort` rejects it. The duplicate-id pin is the correct pre-cost contract; the design note's §6(d) claim was the stale one.
- **Structural guard live:** an anonymous `as { task: string }` retry-cast mutation fails `architecture-rules` (1 failed / 9 passed); `as {` count is zero; the single `as DelegateTaskParams` is pinned.
- **Coverage additive:** no existing suite asserted gate-vs-gate precedence on the real handler (the depth case was a logic replica); the order log + 8 precedence pairs + depth asymmetry + warning order + `displayTaskName` regression are new.
- **No collateral:** production untouched; **88 files / 1780** green; `tsc` clean; the CI gates pass (15.54 s, ratio 1.74).

SOLID/DRY violations flagged: 0

## Disposition (2026-10-25)

- PR body corrected (20 tests); the `expectOrder` limitation is documented in a comment. Merged `35a0714`.
- **Design-note correction:** §6(d) assumed a graph cycle is caught before the cost gate — it is not (cycles are caught by `topologicalSort` after the prologue). The note carries a correction line.

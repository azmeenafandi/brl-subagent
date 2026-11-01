# REVIEW — PR #391 (#379 commit 3: per-unit pre-pass helper) @ `666746f`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — focused C2, Jev **medium (0.48)**. Design authority:
`.development/investigations/mode-prologue-design-2026-10-25.md` (§3 commit 3, IN8).
Diff `78e6e37..HEAD`: `src/prelude.ts` (`validateUnitPrePass<U, M>`), `src/index.ts` (3 call sites, −105 net),
`unit-pre-pass.test.ts` (new), `architecture-rules.test.ts` (+31 guard), the ARCHITECTURE purpose text.

**Verdict: approve-with-nits** (1 informational, pre-existing) → merged `3486dbe`.

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| minor (informational) | `src/index.ts:740,1362,1724` | The spawn loops re-merge after the pre-pass merge (a pre-existing double-merge from base, unchanged; the helper's `merged` is discarded) |

## Verified-OK

- **Equivalence:** a scratch probe (base inline loop vs helper) 3/3 — identical cwds, the exact `${prefix}: ${w}`
  warning sequence/order, identical first-rejection text, the graph placeholder-strip override honoured.
- **Generic typing neutral:** the helper never constructs `M`; `merge` is the handler's own bound
  `mergeSubTaskParams` and `M` is inferred — no field shape/optionality change is possible; `tsc` clean.
- **Position (IN8):** chain pre-pass→model→circuit (`656→674→696`), parallel same (`1123→1142→1164`), graph
  model→circuit→toposort→pre-pass (`1575→1597→1617→1644`) — matches base; the commit-2 pins (20 `it`s) green.
- **Copies gone:** no `stepPrefix`/`nodePrefix` in `index.ts`; the single `taskPrefix` is the fan-out's own
  sequence (out of scope per the design).
- **Guard real:** an injected `const stepPrefix = …` fails the architecture-rules test; restored, tree clean.
- **Contract test sound:** pins the helper's own behaviour (input order + resolved cwd, per-unit prefix accumulation,
  describe-task override, force block→warning degrade, first-rejection-wins with the merge-call count) — not a call
  restatement.
- **No collateral:** 89 files / 1786 green, `tsc` clean, the diff is exactly the five files, the ARCHITECTURE
  purpose line matches the header.

SOLID/DRY violations flagged: 0

## Disposition (2026-10-25)

Merged `3486dbe`. The double-merge note is pre-existing and left as-is (the helper's return is intentionally the
handler's to consume). **Commit 4 (the batch prologue) awaits the maintainer's go — the gate email is sent.**

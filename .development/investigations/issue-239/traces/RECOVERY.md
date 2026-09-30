# Issue #239 proposal — recovery note (2026-09-29)

The proposer run (`0697231d`, xiaomi/mimo-v2.6-pro) was aborted by the **30-minute background hard cap**
(issue #240's defect) at 54 turns / 53,536 output tokens, while incrementally writing §2.2 of the proposal.

## Recovered

| Artifact | Status |
|---|---|
| `../REVIEW_239_PROPOSAL_PARTIAL.md` | As flushed at the last write: §0 recommendation, §1 ground truth (incl. the five framing corrections), **§2 complete evidence log E1–E14** + quoted signatures + probe inventory. Missing: §3 options detail, summary table, execution sketch, falsifiers, open questions. |
| `probes/probe{1,2,3,4,4c}.ts` | The five probe scripts, with expected result signatures stated before execution. |
| `option1-minimal.diff` | p2 vs pristine p0 — Option 1 implementation (4 signatures retyped, 4 casts removed, `dependsOn?` relaxed). Compiles clean (E10), behavior-neutral (E11). |
| `option2-schema-linked.diff` | p3 vs p0 — Option 2 implementation (`src/schema.ts` extraction, `DelegateTaskParams = Static<...>`, plus Option 1 changes and one boundary assertion). Exactly 1 residual error → fixed (E12), ratchets green (E13). |
| `reports/{p0,p3}-report.json` | vitest JSON from the scratch trees: identical 11-failure sets (all environmental — copies outside the repo); in-situ baseline is 1191/1191 per E1. |

## Limits

- The diffs are captured against the p0 copy of `src/` at commit `4329bb4`; `/tmp` scratch trees are volatile.
- The 11 failures in the reports are environmental (missing `.github/scripts/` in scratch copies), not code effects — E11/E13.
- The agent record lives at `.pi/subagents/0697231d-bde1-411e-8930-1eab2dd9c6e0.json` (usage: 88,754 in / 53,536 out / $0.0946).

## Update (completion run, 2026-09-29)

`deepseek/deepseek-flash` completed the document in 1m33s ($0.028): §3 Options, §4 summary table, §5 nine-step
execution sketch, §6 falsifiers + open questions appended; §0–§2 preserved verbatim. The completed 203-line
document is `../REVIEW_239_PROPOSAL.md`; the partial above it is retained for provenance.

Conductor verification of its load-bearing claims (in the preserved probe trees):
- E10 reproduced: `/tmp/probe239/p2` (Option 1) — `npx tsc --noEmit` exit 0.
- E12 reproduced: `/tmp/probe239/p3` (Option 2 + boundary assertion) — `npx tsc --noEmit` exit 0; the assertion is
  present at `src/index.ts:2884`.
- F4 verified: exactly four multi-line `params as { … }` assertions at p3 index.ts 446/966/1455/2018.
- Minor: §5 Step 5 cites the retry-restore site as 2881; the actual p3 line is 2884 (E12's quote says 2884).
  Immaterial for a spec (line numbers drift), noted for accuracy.

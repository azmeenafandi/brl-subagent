# Friction dispositions

One row per class per cycle. Every friction row in a cycle's window is assigned to exactly one class;
`node scripts/friction-disposition.mjs --check --cycle <name>` refuses otherwise. Edit dispositions by
hand; `--render` refreshes issue states. A cycle is not closed until the check exits 0.

**Rows are indices.** A row in `.development/FRICTION_LOG.md` is identified by its 1-based data-row
index, and a window maps by position — never insert or edit a logged row, because an insertion
re-targets every later row. The tool cannot see an in-place edit from the log alone; this is a
human-review obligation, stated because it is not enforced.

**One writer at a time.** `--render` is a conditional, atomic rewrite (read-hash → build → re-read-hash →
rename), refuses a symlink, and retries once if the file moved under it — it is not a lock. Do not edit
this file while a render is running.

## Windows

| cycle | from | to | opened | closed | provenance |
|---|---|---|---|---|---|
| settle-handlers | 197 | 198 | 2026-11-20T13:25Z | 2026-11-21T04:57Z | reviewed inference: row 197 (tag `tooling`) is the only friction row logged live; row 198 is the close record (excluded); earlier cycles are pre-ledger legacy; the reconstructed classes come from issue/PR evidence and are not claimed to be live rows |

## Dispositions

| cycle | class | rows | evidence | disposition | issue | fix |
|---|---|---|---|---|---|---|
| settle-handlers | `gh-issue-close-no-comment-file` | — | 1 sweep item | folded into #562 | #562 open | mechanical |
| settle-handlers | `handoff-verify-no-state-message` | — | 1 sweep item | folded into #562 | #562 open | mechanical |
| settle-handlers | `handoff-verify-prose-claim` | 197 | bare `src/tui.ts` read as a 0-line claim | folded into #561 | #561 open | mechanical |
| settle-handlers | `jev-parenthetical-rejected` | — | 1 sweep item | folded into #562 | #562 open | mechanical |
| settle-handlers | `plan-critique-review-naming` | — | 1 sweep item | folded into #550 | #550 open | mechanical |
| settle-handlers | `record-from-read-only-preset` | — | 5 (r1-r5 of #546) | folded into #550 | #550 open | mechanical |
| settle-handlers | `spec-evidence-cannot-fail` | — | 6 named failures + 3 rounds; Rule 11: ≥2 | P0 #557 | #557 open | mechanical |
| settle-handlers | `state-comparison-scripts` | — | 4 symptoms | folded into #548 | #548 open | mechanical |
| settle-handlers | `suite-report-no-head` | — | 1 sweep item | folded into #548 | #548 open | mechanical |
| settle-handlers | `transport-deaths` | — | 17/63 failed, 12 auto-retries; Rule 11: ≥2 | P0 #556 | #556 open | mechanical |
| settle-handlers | `worktree-scripts-outside-budgets` | — | 5 sweeps, 0 units; Rule 11: ≥2 | P0 #558 | #558 open | mechanical |

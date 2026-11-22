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
| process-receipts | 199 | 208 | 2026-11-21T15:31Z | 2026-11-22T05:15Z | candidates: 10 machine-made (6 cited to `transport-deaths`, 4 dismissed as deliberate #574 probes, all resolved); rows 199-203 are pre-cycle release lessons inside the contiguous window; row 208 is this cycle's close record (excluded) |

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
| process-receipts | `codegraph-node-file-basename` | 205 | 1 occurrence: `--file` misdiagnoses a file indexed under another root; resolve by basename | folded into #580 | #580 open | mechanical |
| process-receipts | `codegraph-upgrade-pnpm-misdetection` | 204 | 1 occurrence: `codegraph upgrade` shells to npm; the bump is `pnpm add -g` | folded into #580 | #580 open | mechanical |
| process-receipts | `handoff-duplicate-state` | 199 | Rule 11 x2: a slice-replace re-appended a whole block; `handoff-verify` read 0 drift, only `grep -c` saw it | folded into #579 | #579 open | mechanical |
| process-receipts | `jev-classifier-provider-vs-build` | 206, 207 | no-fix, by the maintainer's decision (2026-11-22): the Jev classifier is internal tooling and must never ship to npm, so the published build's inability to write the line is the design, not a defect. ADR 0018 §2 already says the check is our development discipline and sanctions `jev: unavailable`; the diagnosis cost (row 207 corrected 206) is the only residual | accepted → .development/decisions/0018-dispatch-preflight.md::2. The Jev line — a blocking pre-spawn check, OPT-IN per project (our process) | — | judgement |
| process-receipts | `pi-remove-absolute-path` | 202 | Rule 11 x2: the v2.9.0 row and v2.9.1 row 202 — the relative form silently removes nothing | P0 #581 | #581 open | mechanical |
| process-receipts | `release-bump-branch-protection` | 203 | 1 occurrence: the bump push bypasses `main` by design; the release rests on the merge's CI | folded into #580 | #580 open | judgement |
| process-receipts | `release-ritual-changelog-noise` | 200 | 1 occurrence: every `CHANGELOG.md` hit in step 1 is historical and must be left | folded into #580 | #580 open | mechanical |
| process-receipts | `tarball-smoke-install-target` | 201 | 1 occurrence: `pi install <tgz>` wrote the user registry; the working probe is `-ne -e` with clean settings | folded into #580 | #580 open | mechanical |
| process-receipts | `transport-deaths` | — | 3 failed runs + 3 transport retries in this cycle's candidates, all cited and all resolved | fixed d3da4f7 | — | mechanical |

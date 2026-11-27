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
| guard-integrity | 209 | 217 | 2026-11-22T08:20Z | 2026-11-22T09:24Z | candidates: 2 (one run's transport death + its auto-retry, both cited to `transport-deaths` and resolved); rows 209-216 are this cycle's live rows; the METRICS row's window is 08:24:20Z (row 217 explains the trim) |
| proof-integrity | 218 | 225 | 2026-11-22T09:57Z | 2026-11-22T11:10Z | rows 218-224 are this cycle's friction rows (218 = the previous cycle's post-close finding, recorded here because it sits after the close record); 225 is the close record (excluded) |
| provenance | 226 | 233 | 2026-11-27T00:00Z | 2026-11-27T12:30Z | candidates: 6 machine-made (`.development/friction-candidates/provenance.json`), all six cited to a ledger class, 0 dismissed, every citation resolved under `--source-root`; rows 227-232 are this cycle's live rows; row 226 is the previous cycle's post-close finding, which sits after that close record (§1.1 puts it here); 233 is the close record (excluded) |

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
| guard-integrity | `claim-scope-confusion` | 215 | 1 occurrence: a whole-document regex probe vs `parseClaims`'s §STATE scope found a phantom claim in `Since` prose | accepted → .pi/skills/worktree/SKILL.md::Notes | — | judgement |
| guard-integrity | `gate-line-format` | 212 | 1 occurrence: the record wrote `(0.40)`, the classifier printed `(0.4)`; the gate refused it correctly | fixed 57e7a6e | — | judgement |
| guard-integrity | `gh-porcelain-lag` | 210 | 1 occurrence: `gh run list` printed nothing for ~10 min while the API listed two runs; read as a dead Actions | accepted → .pi/skills/worktree/SKILL.md::Notes | — | judgement |
| guard-integrity | `handoff-residual-self-inflicted` | 211 | 1 occurrence: #561's accepted residual claimed a 3-line file from its own documentation example | folded into #590 | #590 open | judgement |
| guard-integrity | `jev-line-fabrication` | 209 | 5 fabricated payloads (.pi/jev-lines.log 374/376/378/383/389), none carrying a `usage` block; Rule 11: ≥2 | fixed 9480ed0 | — | mechanical |
| guard-integrity | `spec-rounds` | 214 | 1 occurrence: 4+3+1 critique rounds for ~40-line units; rounds 2-4 found real defects in the previous drafts | accepted → .pi/skills/worktree/references/spec-evidence.md::The five rules | — | judgement |
| guard-integrity | `sprint-metrics-refused-dispatch` | 216 | 1 occurrence: a harness-refused dispatch counted as a dispatch, Δ −1, row unappendable | fixed 57e7a6e | — | mechanical |
| guard-integrity | `vacuous-test-filter` | 213 | 1 occurrence: `vitest -t` on an absent title exits 0 with all skipped | fixed 57e7a6e | — | judgement |
| proof-integrity | `flag-scope-mismatch` | 223 | 1 occurrence: `--skip-extension-sync` governs only the extension sync; `fetch`/`pull --rebase` runs unconditionally, so the cockpit `dev` advances with the flag on (measured 23c6f8c → 21ca743) | folded into #570 | #570 open | judgement |
| proof-integrity | `live-log-midrun` | 224 | 1 occurrence: a live-log evidence row moved 134/392 → 143/401 between two runs because the conductor dispatched from the cockpit while the implementer measured | accepted → .pi/skills/worktree/references/spec-evidence.md::The five rules | — | judgement |
| proof-integrity | `recheck-transcription-drift` | 219 | 4 occurrences (#592 0.89/0.87, #593 0.52/0.53, #595 0.53/0.54, #594 0.28/0.27); Rule 11: ≥2 | P0 #596 | #596 open | mechanical |
| proof-integrity | `seam-deletion-asymmetry` | 222 | 1 occurrence: the fixture seam compared only the copy's keys, so `rm SKILL.md` with `mutated:[]` passed 23 tests (caught by the C1 review, not by design review) | fixed 6e7d813 | — | mechanical |
| proof-integrity | `spec-arithmetic` | 221 | 3 rounds on one unit (#572 v1 unreachable, v2 arithmetically impossible by construction, v3 one field short); Rule 11: ≥2 | P0 #598 | #598 open | mechanical |
| proof-integrity | `spec-isolation-claim` | 218 | 1 occurrence: the #589 spec prescribed `JEV_PROVENANCE=<tmp>` for isolation, but only `merge-guard.sh` reads that variable (7 refs) and `jev-check.mjs` reads none — the critique wrote to the live log instead | accepted → .pi/skills/worktree/references/spec-evidence.md::Applying it (worked example, 2026-11-21) | — | mechanical |
| proof-integrity | `unreachable-mutant` | 220 | 2 occurrences (#589 A8 after fixture migration, #591 M1 behind two early returns); Rule 11: ≥2 | P0 #597 | #597 open | mechanical |
| provenance | `banking-regression` | 227 | Rule 11 P0, 9 occurrences (≥2): nine dispatches, zero run banks while `bank/` held 20 from earlier cycles; `.pi/skills/worktree/SKILL.md:206–220` addresses the brief author, `presets/project-implementer.md` names bank/durable/scratch zero times, and no pre-flight refuses a brief without one | P0 #599 | #599 open | mechanical |
| provenance | `budget-floor-corpus-top` | 232 | 1 occurrence: `floorCorpus: "top"` judges only the surface's top-level files (`dirname(file) === join(root, dir)`), so `scripts/lib/**` is outside the reachability floor and the next module there is pinned by its own test only; recorded unfiled in the handoff's Next actions, and #604 is the open coverage issue it belongs to | folded into #604 | #604 open | mechanical |
| provenance | `close-receipt-self-red` | 226 | 1 occurrence, the previous cycle's post-close finding: the close receipt rewrote §STATE's Suite line and destroyed the Sizes claim list (3 handoff tests red at `bde4b22`) while `handoff-verify` reported 0 drift — it has no Sizes-family presence check and a claim family only a test reads is one the CLI lets rot; recorded unfiled in the handoff's Next actions | accepted → .development/HANDOFF.md::Next actions | — | mechanical |
| provenance | `handoff-commit-unpushed` | 231 | 1 occurrence: a handoff commit was written and never pushed, so `git pull --ff-only` diverged after the next PR merge landed on `dev`; accepted with the working practice stated in the row text — push the handoff commit in the same turn it is written | accepted → .pi/skills/handoff/SKILL.md::Before committing the handoff | — | judgement |
| provenance | `model-override-substitution` | 228 | 2 occurrences, both machine-cited as candidates: an unresolvable `model` silently ran on the global default (`.pi/subagents/328a74e8-….json` says `deepseek/deepseek-flash` for `revise-596-u1-opus`) and the catalogue advertised a banned entry (`403 … is banned`, run `f9eb079b`) — the Jev row records the intended model and the agent record the actual one, and nothing compares them | folded into #602 | #602 open | mechanical |
| provenance | `pr-body-shape-unchecked` | 229 | 2 of 4 recent PR bodies: #600 and #584 carry no `## Merge Danger`, #577 and #573 carry it; `pr-evidence --check` compares counts and nothing checks section shape, so absence fails nothing; 1 steer candidate cites this class | folded into #603 | #603 open | mechanical |
| provenance | `recheck-duplicate-row` | 230 | 1 occurrence: two `recheck-601` rows appended 80 ms apart with identical bytes (`.pi/jev-lines.log` 12:27:34.143Z and .223Z) — accepted as a conductor slip with no harm, because identical bytes make newest-wins unambiguous and the record resolves the same line, which is exactly the U1 rule | accepted → .pi/skills/worktree/references/review-dispatch.md::`jev-recheck:` + `Risk class:` — the review-time classification | — | judgement |

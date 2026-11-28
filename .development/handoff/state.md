## STATE

The mechanical snapshot #607 moved out of the index. Read by `node scripts/handoff-verify.mjs` — every
line below is a claim it recomputes, and a drift means the claim is wrong, never the checker.

- **dev** @ `5100563` — #606 Unit 3's signed brief (`briefs/factory-vocabulary.md`) and the two recon reports it
  cites; on top of Unit 1's merge (#612) and the pi 1.7.0 SDK parity (#611).
- **Running install:** the **dev checkout** at `/home/azmeen/public_projects/brl-subagent_workspace/brl-subagent-dev` (`pi install` of that path) on pi **1.7.0**, `dev @ 5100563`; every dispatch dogfoods the branch. The declared SDK line is aligned at **1.7.0** — the cockpit `npm ci` is done. Revert to the published build: remove that path → install `npm:brl-subagent@2.9.1` → `/reload`.
- **Board:** `#611` merged (`3789461`) with `#610` closed; `#612` merged (`370774f`) — #606 Unit 1, the front door. Open: #552, #562, #567, #570, #590, #597, #598, #599, #602, #603, #604, #605, #606.
- **Suite:** 154 files / **3516** (3515 passed, 0 failed, 1 skipped) captured at `5100563` — measured on pi 1.7.0; typecheck clean; docs guards current (**63 modules**, **28 ADRs**). Sizes: `index.ts` 356; `tui.ts` 3,240; `friction-disposition.mjs` 1,692; `delegate-handler.ts` 2,277; `session-manager.ts` 3,295; `mode-runners.ts` 1,575; `background-pipeline.ts` 1,025; `agent-tools.ts` 332; `boot-recovery.ts` 376; `terminal-notifier.ts` 440; `worktree-report.ts` 142; `commands.ts` 137; `unit-params.ts` 113; `atomic-write.ts` 101; `runtime.ts` 50; `brief.ts` 228; `dispatch-header.ts` 230; `lib/handoff-claims.mjs` 1,378; `handoff-verify.mjs` 487.

## Open items

- **Landed: #606 Unit 1 / PR #612** (`370774f`) — the mandatory dispatch header, the signed-brief predicates,
  template kinds, and the routing fix. Reviewed `approve-with-nits` by `openrouter/meta/muse-ember` (record
  sha256 `b34be201…`); `merge-guard` green on all seven checks. Spec: `issue-606-grill-spec-2026-11-27.md`.
  **Release checkpoint is OPEN**: this changed `src/`, so the merged code is not in the published package —
  the maintainer decides between a release and continued dev-checkout dogfooding (a `/reload` activates it
  for the dev install).
- **In flight: #606 Unit 3 — the brief is signed, nothing is built yet.** `briefs/factory-vocabulary.md`
  (`5100563`), fifteen decisions taken one question at a time, validated with `validateBriefFile` → ok. The
  design is deliberately small: a **naming layer** over the words the code already uses, **one ban**
  (`worker` → `subagent`), a data-only `VOCABULARY.md` the lint parses and validates, and the refusals
  (`runner`, `trigger`, `ticket tracker`) recorded in the prose glossary. Corpus is living `*.md` prose only.
  Next: worktree + `dispatch: impl` `brief: factory-vocabulary` — the first dispatch the gate will police.
- **Regression found and fixed while cutting this unit:** the Unit 2 close rewrote the Suite line to
  `154 files / 3516` and dropped its passed/failed/skipped breakdown. `handoff-verify.test.ts:909` parses the
  live line and caught it; `handoff-verify` itself did not, because it compares totals and not the suffix.
- **Carried nits from #612** (record, not fixed): `src/brief.ts` and `src/dispatch-header.ts` hold two regexes
  for the zero-decision form that disagree (`none—why` accepted by one, refused by the other; neither matches
  the spec's `^none —\s*\S`); an `impl` template whose body already declares its kind skips the render-time
  `params.brief` check (the validator still refuses the result). Both are minor.
- **Carried process defect, undispositioned:** `stop_subagent` reports success against a *superseded* background
  agent while its automatic transport retry keeps running under the same label — so "stopped" can be false, and
  a retry can write a merge-gating record after the conductor believes the run is dead. Hit twice today. Needs a
  friction row or an issue; not yet filed.

- **Landed: #610 / PR #611 — pi 1.7.0 SDK parity** (`3789461`). Compatibility found no breaking impact: the sole
  breaking change removes install telemetry, which no `src/` file touches, and the public surface is
  unchanged-or-additive. Four devDependency ranges `^1.6.0` → `^1.7.0`; `typebox` still 1.3.27; no source change.
  The focused review (`approve-with-nits`) found the spec's removals list incomplete — three further removals, all
  unreachable — corrected in `026ef8d`. Spec: `.development/investigations/deps-pi-1.7.0-spec-2026-11-28.md`.
  **Any worktree prepped before the bump must be re-prepped with `--force-isolated`.**

- **Cycle `front-door` (open; advanced 2026-11-28).** #609 merged (plan-critic preset at `medium`); #606 **Unit 1**
  merged (`370774f`, `approve-with-nits`); **Unit 2 closed against #607** (`14aef6e`) — reconciled 2026-11-28 after
  testing each clause against the verifier's claim codes: the work existed, the claim never did (#607 never names
  this issue or Unit 2). The accepted residual is stated on the issue: "never copied" has no duplication check
  (#607 D8 — structural smallness, not a proof of no smuggling). **What remains: Unit 3 (vocabulary) and the
  Unit 1 release checkpoint.** The spec's two falsifier receipts are unblocked now the gate is live (spawn/refusal
  counts need a window; the question audit needs a real want).

- **Filed separately:** the `noJev` guard accepts exponent-form numbers (`1e+21`, `1e-7`) through the real coercion
  path — a shipped-code defect, not a Unit 1 deliverable.
- **#552** — a resume-after-drop needs a state reader; the `In flight:` line works without one.
- **#590 / #597 / #598** — the size-claim grammar residual, and two evidence rules a critic has to hold.
- **#570** — the gate's `--selftest` runs in CI now; five scripts still have no rule coverage.
- **ADR amendments pending:** 0009 (retry snapshot carries `task`), 0003 (lineage/metrics source), 0006
  (slotless templates unusable).

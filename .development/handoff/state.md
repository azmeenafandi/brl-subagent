## STATE

The mechanical snapshot #607 moved out of the index. Read by `node scripts/handoff-verify.mjs` — every
line below is a claim it recomputes, and a drift means the claim is wrong, never the checker.

- **dev** @ `5b4da67` — the #606 spec r2 with the gated class DECIDED (code-writing).
- **Running install:** the **dev checkout** (`pi install /home/azmeen/public_projects/brl-subagent_workspace/brl-subagent-dev`) on pi **1.7.0**, `dev @ 5b4da67`; every dispatch dogfoods the branch. Revert to the published build: `pi remove /home/azmeen/public_projects/brl-subagent_workspace/brl-subagent-dev` → `pi install npm:brl-subagent@2.9.1` → `/reload`. The declared SDK line is still 1.6.1 until **PR #611** merges (then `npm ci` in the cockpit).
- **Board:** `#607` merged (`14aef6e`); the queue after it is the factory front door (#606), then the spine. Open: #552, #562, #567, #570, #590, #597, #598, #599, #602, #603, #604, #605, #606, #610.
- **Suite:** 150 files / **3451** (3450 passed, 0 failed, 1 skipped) captured at `5b4da67`; typecheck clean; docs guards current (**61 modules**, **28 ADRs**). Sizes: `index.ts` 356; `tui.ts` 3,240; `friction-disposition.mjs` 1,692; `delegate-handler.ts` 2,261; `session-manager.ts` 3,295; `mode-runners.ts` 1,575; `background-pipeline.ts` 1,025; `agent-tools.ts` 332; `boot-recovery.ts` 376; `terminal-notifier.ts` 440; `worktree-report.ts` 142; `commands.ts` 137; `unit-params.ts` 113; `atomic-write.ts` 101; `runtime.ts` 50; `lib/handoff-claims.mjs` 1,378; `handoff-verify.mjs` 487.

## Open items

- **In flight: PR #611 (#610) — pi 1.7.0 SDK parity.** The compatibility check found no breaking impact (the sole
  breaking change removes install telemetry, which no `src/` file touches); four devDependency ranges `^1.6.0` →
  `^1.7.0`, lockfile churn exactly the eight `@earendil-works` entries, `typebox` still 1.3.27, no source change;
  typecheck clean and the suite unchanged from the `5b4da67` baseline. Spec:
  `.development/investigations/deps-pi-1.7.0-spec-2026-11-28.md`. Post-merge: `npm ci` in the cockpit, and re-prep
  any worktree that predates the bump with `--force-isolated`.

- **Cycle `front-door` (open, paused 2026-11-27 for the night).** #609 merged (the plan-critic preset at `medium`).
  **Resume here:** #606 Unit 1 — the spec is `.development/investigations/issue-606-grill-spec-2026-11-27.md` at
  **r7**, both boundary decisions settled (gated class = code-writing dispatches; boundary = a mandatory dispatch
  header, option A). Six critique rounds are recorded beside it (`issue-606-critique-r1..r6`); r7 has **not** been
  critiqued — the maintainer chose to stop there. The next act is the maintainer's call between *approve → create the
  worktree and dispatch `impl-606`* and *one more critique round*; the conductor recommended approve.
- **Filed separately:** the `noJev` guard accepts exponent-form numbers (`1e+21`, `1e-7`) through the real coercion
  path — a shipped-code defect, not a Unit 1 deliverable.
- **#552** — a resume-after-drop needs a state reader; the `In flight:` line works without one.
- **#590 / #597 / #598** — the size-claim grammar residual, and two evidence rules a critic has to hold.
- **#570** — the gate's `--selftest` runs in CI now; five scripts still have no rule coverage.
- **ADR amendments pending:** 0009 (retry snapshot carries `task`), 0003 (lineage/metrics source), 0006
  (slotless templates unusable).

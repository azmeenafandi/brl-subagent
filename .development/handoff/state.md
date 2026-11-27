## STATE

The mechanical snapshot #607 moved out of the index. Read by `node scripts/handoff-verify.mjs` — every
line below is a claim it recomputes, and a drift means the claim is wrong, never the checker.

- **dev** @ `14aef6e` — the #607 merge (handoff index + five checks).
- **Running install:** the **dev checkout** (`pi install /home/azmeen/public_projects/brl-subagent_workspace/brl-subagent-dev`) on pi **1.6.1**, `dev @ 14aef6e`; every dispatch dogfoods the branch. Revert to the published build: `pi remove /home/azmeen/public_projects/brl-subagent_workspace/brl-subagent-dev` → `pi install npm:brl-subagent@2.9.1` → `/reload`.
- **Board:** `#607` merged (`14aef6e`); the queue after it is the factory front door (#606), then the spine. Open: #552, #562, #567, #570, #590, #597, #598, #599, #602, #603, #604, #605, #606.
- **Suite:** 150 files / **3451** (3450 passed, 0 failed, 1 skipped) captured at `14aef6e`; typecheck clean; docs guards current (**61 modules**, **28 ADRs**). Sizes: `index.ts` 356; `tui.ts` 3,240; `friction-disposition.mjs` 1,692; `delegate-handler.ts` 2,261; `session-manager.ts` 3,295; `mode-runners.ts` 1,575; `background-pipeline.ts` 1,025; `agent-tools.ts` 332; `boot-recovery.ts` 376; `terminal-notifier.ts` 440; `worktree-report.ts` 142; `commands.ts` 137; `unit-params.ts` 113; `atomic-write.ts` 101; `runtime.ts` 50; `lib/handoff-claims.mjs` 1,378; `handoff-verify.mjs` 487.

## Open items

- **#552** — a resume-after-drop needs a state reader; the `In flight:` line works without one.
- **#590 / #597 / #598** — the size-claim grammar residual, and two evidence rules a critic has to hold.
- **#570** — the gate's `--selftest` runs in CI now; five scripts still have no rule coverage.
- **ADR amendments pending:** 0009 (retry snapshot carries `task`), 0003 (lineage/metrics source), 0006
  (slotless templates unusable).

# #542 plan critique — round 2 (2026-11-20)

Critic: `critique-542-r2` (`project-plan-critic` + `openrouter/openai/gpt-6.1-terra`, pinned
`thinkingLevel: medium`). Plan under review: `issue-542-pre-start-agent-record-spec-2026-11-20.md`
(r2, `46d7b65`). Read-only dispatch; this record transcribes the returned findings.

**Verdict: `needs-work`** — 4 major, 2 minor. The r2's **measurements held** (B1/B2/B3, mutants,
the 5-line margin), and round 1's F2/F4/F5 are substantively addressed; the remaining gaps are
**disclosure, contract wording, and test-set fidelity**.

## Findings

| # | Sev | Plan location | Gap | Evidence (command + result) | Fix |
|---|---|---|---|---|---|
| H1 | **major** | Residual window; #546 remedy | The disclosed residue covers only a kill **after all of STEP A**, not a kill inside it. Registry retirement precedes the terminal append, so an earlier kill leaves a `running` agent **and** a `running` run entry, registry retired, dir pruned. #546's marker *after* the run-entry write has no registry entry left to update. | Archived `/tmp` tree, crash sentinel after `clearInflightRun` and before `appendEntry`, then the boot probe: `RES_DISK_STATUS=running`, `BOOT_LAST_RUN_AFTER=running`, `RES_REGISTRY=0`, `RES_SESSION_DIR=false`, boot `0/0/0`. `run-registry.ts` confirms the order. | Disclose this distinct window and **correct #546's ordering/remedy**. Falsifier: a crash at any intermediate registry/append boundary produces residue the contract does not describe. |
| H2 | **major** | Contract; acceptance 4, 8 | “Event after the run entry is terminal” is unconditional, but per-step containment deliberately emits after a **failed** terminal append — which can produce the F1 state without a crash. | Instrumented test (b): `ATTEMPTED=failed COMMITTED=running AGENT=failed`, test still passed; `lastRunEntry()` reads mock calls, including throwing ones. | Qualify: **attempted** when STEP A fails; pin successfully **committed** entries separately. Falsifier: a failed append represented as a committed terminal entry. |
| H3 | **major** | Acceptance 7; tests A3 | The existing A3 does not pin the agent-record flip at the acceptance-write site. | Conditioned the record flip to skip A3's `accept-boom` path → `session-manager.test.ts` still **145 passed**. | Extend A3 with in-memory **and** disk terminal-record assertions, preserving `acceptedAt: null`. Falsifier: the targeted mutant passes. |
| H4 | **major** | Tests; baseline-red; delta | The integrated test file has **five** logical cases (the branch case expanded to two), not the specified six: standalone case (e) is missing. Its **145** total and **+155** lines therefore do not measure the mandatory set as written. Acceptance 3 also cites (c), which deliberately makes the transcript path a directory. | `rg -n 'pre-start terminal flip\|noteCount\|\(h\)'` on the integrated file → no (e); baseline **8 failed/137 passed**, patched **145 passed**; numstat source `45/25`, tests `159/4`. | Decide: a distinct (e) or explicitly merge its pins; reconcile counts; correct acceptance 3; re-measure the integrated diff. If over budget, use the documented `Test budget:` declaration — never drop pins or pad source. |
| H5 | minor | Execution sketch 10 | The flow gate reads **committed** Git objects; the sketch does not require committing first and passing the final PR head SHA. | `test-budget-flow.mjs` states the diff comes from Git, not the working tree; `merge-guard.sh` invokes `--flow --base dev --head "${HEAD_SHA}"`. | Require the trusted cockpit command against the final committed head; record base + head; rerun on any commit change. |
| H6 | minor | Acceptance 9; M7 | M7 does not demonstrate that the settle-entry instrument kills a settle-body mutant: it reverts the pre-start helper, and the tripwire fails earlier on the missing transcript note. | Reproduced M7: the tripwire failed at `expected … to contain 'Transcript completed: failed'`; a separate mutant calling `resolveSettled()` on the sync path failed specifically at `settleEntryRecords()`. | Replace M7's evidence with the actual settle-entry mutant and its assertion failure. |

## Verified sound

- **B1/B2** reproduced with planted dead ownership + production recovery wiring: both `0/0/0`; restart
  status `running` (swap) vs `failed` (r1); the F1 falsifier is absent under the swap, present under r1.
- **B3** reproduced on the real bus: r1 `run=running`, dir retained; swap `run=failed`, dir pruned.
- M1–M10 reran (incl. M5′: fails only case (c); the catch-preserving `finally` passes all 145).
- Round 1's F2/F4/F5 substantively addressed. The measured margin is reproducible, but for a
  different test set than specified (H4).
- SOLID/DRY: 0 violations.

## Conductor decision (2026-11-20) — r3, targeted

- **H1**: disclose the intra-STEP-A window in the spec; **#546 is corrected by comment** (the marker must
  be written **before** registry retirement, or read from the entry before retiring it) — no new issue.
- **H2**: contract says **attempted**; add the committed-entry pin.
- **H3, H4**: extend A3; require a **distinct (e)** and re-measure the integrated diff; if the mandatory
  set exceeds the allowance, declare it — do not drop pins.
- **H5, H6**: adopt as stated.
- The r3 will be followed by a **targeted confirmation critique** limited to H1–H6; if it returns only
  minors, the unit implements.

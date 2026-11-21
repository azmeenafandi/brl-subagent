# #542 plan critique — round 3 (targeted confirmation, 2026-11-20)

Critic: `critique-542-r3` (`project-plan-critic` + `openrouter/openai/gpt-6.1-terra`, pinned medium).
Scope: **only** H1–H6 of round 2, per the conductor. Plan: r3 at `1f4eee6`. Read-only dispatch;
transcribed here.

**Verdict: `needs-work`** — 2 major, 0 minor. Four of six resolutions verified; the two that remain are
**spec-internal consistency** defects, not design defects.

## Findings

| # | Sev | Plan location | Gap | Evidence (command + result) | Fix |
|---|---|---|---|---|---|
| J1 | **major** | H3, tests A3; acceptance 7 | A3 asserts the in-memory `error` but **not the disk `error`**, though acceptance 7 requires both. The skip-the-flip mutant fails, but not on a missing disk error. | `rg -n 'record\.error\|onDisk\.error'` on the r3 test → `record.error` only; A3 against the skip-the-flip mutant fails on `running` vs `failed`. | Add an `onDisk.error` assertion. Falsifier: a disk record lacking the expected error must fail A3. |
| J2 | **major** | H4, §Delta; helper doc | The **+20 source / 160 allowance / 43 over** figure is not the mandated shape: the measured helper doc is shorter than the contract the sketch requires **verbatim** (29 vs 18 doc lines). | Contract quoted vs the scratch fix: 29 vs 18 doc lines; substituting the full contract → `58/25`, net **+33**; with +203 tests → allowance **186**, over **17**. | Re-measure after the complete doc and the disk-error pin; update §Delta and the PR-body declaration. Falsifier: the final committed diff produces different figures from the declaration. |

## Verified sound

- **H1 resolved** — W-0 disclosed with no recovery claim; #546's correction confirmed by comment. A
  scratch SIGKILL probe reproduced `running` agent, two committed `running` entries, zero registry
  entries, `.done` marker. (Boot recovery itself not independently rerun.)
- **H2 resolved** — the contract says *attempted*; test (b) separately asserts `H2_ATTEMPTED=failed`,
  `H2_COMMITTED=running`, `H2_AGENT=failed`.
- **H4 partly resolved** — distinct (e), 6 logical/7 executed, acceptance 3 corrected, declaration
  instruction present; **10 failed/136 passed** baseline, **146 passed** patched; test diff `207/4`.
- **H5 resolved** — commit-first, cockpit flow at the final SHA, base/head/exit/output recorded, rerun
  on commit change.
- **H6 resolved** — the `resolveSettled()` mutant fails at `settleEntryRecords()`; the earlier
  transcript assertion passes.
- The real worktree suite and the final flow verdict are correctly marked as **implementation gates**.

## Conductor decision (2026-11-20) — stop the loop; implement with two explicit conditions

Three rounds have converged: the design has been stable since r2 and the last two rounds produced only
**proof-internal** findings. The two remaining majors are one-line-class fixes that the implementation
must satisfy and the review will verify — they do not need another proposer round:

- **C1**: A3 must assert **both** the in-memory and the **disk** `error` (plus `status`/`completedAt`),
  preserving `acceptedAt: null`.
- **C2**: the helper doc must carry the **complete** contract the spec requires verbatim; the
  `Test budget:` declaration must be **measured from the final committed tree** (the +203 test set runs
  against a source delta of ~+33 once the full doc is in, so the allowance moves to ~186 and the
  overage to ~17 — the final `--flow` output is the authority, not this estimate).

Everything else in r3 stands as written.

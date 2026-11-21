# #546 — plan critique **r1** (`needs-work`)

**Critic:** `critique-546-r1` (project-plan-critic, `openrouter/openai/gpt-6.1-terra`, medium) · Jev
`high (0.58) · C1 · worktree y` · reviewed the spec at `0248a27` ·
**provenance:** the critic ran read-only (preset), so it could not write this file; the findings below are
its final report, transcribed verbatim in substance by the conductor from the run transcript. The verdict
file `REVIEW_PR546_PLAN.md` carries the same content.

## Verdict

**needs-work** — 7 majors, 4 minors, 0 SOLID/DRY. Every major is measured by the critic, not inferred.

## Findings

| Severity | Plan location | Gap | Evidence (command + result) | Suggested fix |
|---|---|---|---|---|
| **major** | STEP 0; marker invariant | The marker-write result is discarded. A failed write leaves an ordinary registry entry, so the claimed invariant does not hold and boot can take the interrupted/never-started path. | Scratch Node probe against `optA`: chmod registry directory `0500`, then `markRecordFlipPending` → `false`, entry present, marker absent. E5 re-run produced a retry notice for an unmarked terminal run. | Specify failure handling and a fault-injection test. **Falsifier:** failed marker write followed by crash yields a false offer or an unrepairable running record. |
| **major** | D4; `flipAgentRecord` | `loadAgent` conflates absent with unreadable/corrupt. The proposed `if (!persisted) return true` can retire the only marker over a still-running file. | Scratch Node probe: chmod running agent file `000`; `existsSync` → `true`, `flipAgentRecord` → `true`; after restoring permissions, disk status remained `running`. | Distinguish confirmed absence from unreadable/partial state; retain the marker on uncertainty. **Falsifier:** `true` while a readable-again disk record is still `running`. |
| **major** | Design assumptions: concurrency; replay contract | Dead-owner gating does not serialize **two boot scanners**. Both can decide and flip the same dead owner's record, emitting duplicate terminal events and reporting two repairs. | Two-process barrier probe: `N=1 node "$D/race.cjs"` and `N=2 node "$D/race.cjs"` → both `repaired 1`; event emitters `1 2`. | Define serialization or explicitly narrow the guarantee and test the concurrent interleaving. **Falsifier:** two terminal events or two repairs for one marker. |
| **major** | Boot applier; D5/D8 | Retirement is reported successful without verifying the unlink. `clearInflightRun` swallows unlink errors, so `flipRetired` can claim settlement while the marker remains. | Scratch Node probe with registry directory `0500`: `flipRetired=1`, `flipFailures=0`, `entryStillPresent=true`. | Make the retirement outcome observable, count failed retirement separately or as failure. **Falsifier:** a successful-retirement counter with the entry still present. |
| **major** | §Mutants M2; S1/S2/R4 | M2's stated mechanism is false: with `deferRetire`, writing the marker after STEP A **succeeds**. The named pre-planted recovery tests do not establish the required W-0 ordering. S1 checks before **clear**, not before **append**. | Scratch Node probe: deferred `persistRunRecord`, then `markRecordFlipPending` → `true`, marker present. | Pin marker-before-append through the real helper; kill or throw between the two operations. **Falsifier:** moving STEP 0 after STEP A survives the test. |
| **major** | `boot-recovery.ts` wiring; verification steps 4/7 | "Import alongside" is ambiguous about static versus the existing lazy site. A static named mutator import violates the reader-API rule; `check-imports.mjs` checks import formatting, not that rule. | `rg -n 'SESSION_MANAGER_READER_API' src/__tests__/architecture-rules.test.ts` → allow-list `getAgent`, `listAgents`; `node scripts/check-imports.mjs` → `60 files, 0 violations`. The scratch `optA` uses lazy destructuring inside the existing `try`. | Require the existing `await import` position and its failure containment; run the architecture suite explicitly. **Falsifier:** a static `flipAgentRecord` import passes the plan's named import gate. |
| **major** | Crash-probe verification step 6; evidence E4 | The harness reads log field `msg`, but the logger output uses `message`; its `SCAN_LINES` cannot verify the required counter triple. | Re-run P0: `SCAN_LINES: []`; `rg 'Boot recovery' "$S/run/critic546-p0/.pi"` → `data: {"repaired":1,"retired":0,"failures":0}`. | Correct the scratch harness before using it as the PR gate; **assert** the parsed triple, not merely print it. **Falsifier:** an incorrect counter still yields a passing probe. |
| minor | Acceptance 4; P2/P4 | "A live or unverifiable owner is never acted on" contradicts the terminal-record branch, which retires regardless of owner. | Scratch Node probe with a live owner and terminal record → `flipRetired=1`, entry removed. | Decide whether terminal retirement is exempt from the hold rule and state the observable contract. |
| minor | Risks: STEP-A throw | The risk table says a STEP-A throw leaves a marker; the specified later successful flip removes it. | Scratch Node probe: throwing append, successful flip → `landed=true`, registry count `0`, disk `failed`. | Describe this as the existing uncommitted-run-entry residual and pin it separately. |
| minor | §Delta; recon hygiene | The probe test delta is not reproducible as stated, and V2/V3 are absent. | `git diff --no-index --numstat src/__tests__ "$S/optA/src/__tests__"` → **170/0**, not 165/0; `wc -l` spec → **506**. | Reconcile the test-count provenance and restore or explicitly remove V2/V3. The 506-line length was verified; a binding 500-line spec limit was **not** found. |
| minor | D4; repeated invocation | A failed write leaves the cached record terminal; a second same-process flip skips the write even after permissions recover. | Scratch Node probe: first flip `false`; restore mode; second flip `false`; disk `running`, memory `failed`. | Specify retry behavior and test it, or explicitly defer repair to a fresh process. |

## Verified sound

- The issue correction requires marker-before-retirement; the proposed deferral preserves the existing
  foreground and normal-background default. `rg -n 'persistRunRecord\(' src/session-manager.ts src/state.ts`
  found the production call sites.
- `loadAgent` is private but available inside `session-manager.ts`; `recovery.ts` currently has no
  session-manager import. The owner-dead extraction matches the existing integer-positive-pid plus
  `classifyOwner(...) === "dead"` predicate.
- Re-ran **E1, E2, E4a, E4c, E5 and E7**: the crash residues and disk outcomes matched their stated
  observations (subject to the M7 harness defect). Other probes and mutants were not re-run.
- Source delta reproduced: `git diff --no-index --numstat base/src optA/src` → **+363/−29, net +334**; the
  allowance arithmetic is **788**. The repository working tree remained unchanged.
- `SOLID/DRY violations flagged: 0` (plan review; no implementation diff).

## Open questions the r2 spec must answer

1. Which concurrency guarantee is required for simultaneous boot scans, and who owns its serialization?
2. Should a confirmed missing agent record retire a marker (distinct from an unreadable record)?

## Conductor decisions (r2 mandate)

1. **Major 1 — accept.** `markRecordFlipPending`'s boolean is consumed: on `false`, do **not** defer
   retirement (fall back to retire-then-append, log a warning) and add a fault-injection test (registry
   directory `0500`) that pins the fallback. No half-marked state.
2. **Major 2 — accept.** `flipAgentRecord` distinguishes **confirmed absence** (`existsSync` false → the
   marker may retire) from **present-but-unreadable/corrupt** (`existsSync` true, `loadAgent` null →
   uncertain → keep the marker, return `false`, warn). Test both.
3. **Major 3 — accept as a narrowed guarantee, not a claim.** Add a **pre-flip disk read** (read-through) so
   a boot that begins after another finished does not rewrite; state explicitly that two boots passing the
   pre-flip check simultaneously can both rewrite (`completedAt` drift, a duplicate `subagent:failed`
   deduped downstream by `claimTerminalNotice`) and pin that interleaving as a **stated limit**. Do not add
   a claim-file class in this unit; name it as the remedy if serialization is ever required.
4. **Major 4 — accept.** `clearInflightRun` returns `boolean` (additive; existing callers ignore it); the
   applier counts a failed unlink as `flipFailures` and keeps the marker.
5. **Major 5 — accept.** S1 pins `markRecordFlipPending` before the **append** (invocation order across
   `pi.appendEntry` and the writer); M2's killers are restated as S1/S2 only; C1/C2/R4 do not kill it.
6. **Major 6 — accept.** The applier is built at the existing `const { getAgent, markAgentInterrupted } =
   await import("./session-manager")` site inside its `try` (own containment); verification gains the
   architecture-rules suite; any allow-list consequence is stated.
7. **Major 7 — accept.** Fix the scratch harness's field name (`message`), and make the probe **assert** the
   `repaired/retired/failures` triple.
8. **Minors** — all accepted: (a) acceptance criterion states the terminal-record exemption (retirement of
   an already-terminal record is owner-independent because it mutates nothing; a **repair** requires a
   provably dead owner); (b) the STEP-A-throw risk is restated as the uncommitted-run-entry residual;
   (c) the test-delta provenance is reconciled (170, not 165) and V2/V3 are restored or explicitly removed
   with a reason; (d) the same-process retry limit is stated and pinned ("repair is deferred to a fresh
   process"), and the pre-flip read (Major 3) is checked for whether it already makes a retry attempt the
   write again.

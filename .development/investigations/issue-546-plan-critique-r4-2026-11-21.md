# #546 — plan critique **r4** (`needs-work`, 2 majors)

**Critic:** `critique-546-r4` (project-plan-critic, `openrouter/openai/gpt-6.1-terra`, medium) · Jev
`high (0.68) · C1 · worktree y` · reviewed the r4 spec at `e44ae9a` · **provenance:** read-only preset (no
file writes); findings transcribed by the conductor. Verdict file: `REVIEW_PR546_PLAN_R4.md`.

## Verdict

**needs-work — remaining majors: 2.** Both r3 majors verified fixed; the new majors are one **unstated
crash residual** (a torn record write) and one **test that cannot fail** (N1/N2 pass without a scan).

## Findings

| Severity | Location | Gap | Evidence | Fix |
|---|---|---|---|---|
| **major** | §Marker lifecycle P3; §Acceptance 2, 5; §Residual windows | A kill or failed write after the agent file is **truncated** leaves **corrupt JSON**, not a `running` record the next boot repairs. The marker survives, but subsequent boots cannot repair it; the window is absent from the stated residuals. | Seeded P1, then `openSync(record,"w")` + `SIGKILL`: size **455 → 0**. Two production boots each reported `{repaired:0, retired:0, failures:1}` and retained the marker. `persistAgent` uses in-place `writeFileSync`. | Make the write recoverable **or** explicitly narrow the guarantee and state the operator-recovery residual. **Falsifier:** interrupt the real write after truncation and show the promised next-boot outcome. |
| **major** | §Tests N1/N2; §Acceptance 9, 13 | The shipped hold tests can pass **without a registry scan**, and their no-notice assertion is vacuous: neither test invokes `maybeSendRecoveryNotice`. | A scratch mutant returning immediately after the failed import made `vitest -t 'N1:\|N2:'` pass **2/2**; `boot()` calls only `performBootRecovery`, while the notice is a separate method. | Add a same-scan positive control proving the scan ran, and invoke the notice surface (or drop the assertion with a reason). **Falsifier:** a skip-scan mutant or an erroneous notice passes N1/N2. |
| minor | §Evidence E17; §Acceptance 15 | Identity + final size does not detect **truncate-then-regrow** on the same inode; an old line can still satisfy the gate. | A preload truncated and regrew the log beyond offset 182 with an old settlement line; a no-op boot reported `TRIPLE … ok:true`, exit 0. | Use a per-boot isolated log (or another scope that cannot accept rewritten earlier bytes); pin truncate-and-regrow as a negative control. |
| minor | §Delta; §Execution sketch | The shipped-test delta excludes the **24 probe cases** the execution sketch requires porting; it is not the final implementation delta. | `git diff --no-index` confirms +231/−2 session and +208 hold file; the 411-line probe is excluded while the execution sketch requires its cases to be ported. | Mark the figure provisional; remeasure after porting; rerun the committed-head budget gate. |

## Verified sound

- **E18**: `vitest -t 'critique 546 foreground'` and `-t 'critique failed initial persist'` pass **2+1** on
  r4, and **M19** fails **2+1** reproducing the r3 states. The separate live/boot functions make the contracts
  clear; a crash between the process-local memory mutation and the disk write leaves the durable marker for
  boot (the torn-write window is distinct).
- **E19/D7**: the shipped hold suite **4/4**; M18 fails N1/N2, M20 fails both half-wired cases; the probe
  exits **0/5/2** (hold/M18/normal) in both acceptance states; the whole-module mock removes both deps;
  entry-byte + explicit-ID assertions prevent the missing-entry `interruptedAt` check passing alone.
- Minors: `e17.sh` positive/rotation/truncation = **0/3/3**; `e2.sh` empty-expectation **2**, missing/empty
  stream **3**, unset **0**; four half-wired probes retain bytes and zero counters; C1 survives M1/M2/M4 and
  M1's S1, M2's S1/H1, M4's S3 are independently confirmed killers.
- `second-failure.cjs` re-stamps `completedAt` and emits twice, as stated. STEP D logs a failed live unlink
  and retains the marker; boot counts a failed unlink. Live `_sessionRef` clearing is outside the guarded
  steps; boot clears the returned touched record.
- `SOLID/DRY violations flagged: 0`.

## Conductor decisions (r5 mandate)

1. **Major 1 — accept as a narrowed guarantee, not an atomic-write unit.** The torn write is a **pre-existing
   `persistAgent` flaw** (in-place `writeFileSync`), distinct from #546's marker/repair scope; an atomic
   writer is a separate hardening unit with its own blast radius. r5 must: state **P6** (torn write →
   corrupt record; the marker is kept, every boot counts `flipFailures` and does not claim a repair; operator
   recovery = replace/remove the corrupt file), add the measurement as **E23**, and reword acceptance 2/5 to
   "a **readable** `running` record" with the corrupt case explicitly out of the repair guarantee. The
   follow-up is filed as **#554** (atomic `persistAgent`), so the spec cross-references it rather than
   inventing the mechanism.
2. **Major 2 — accept.** N1/N2 gain a **same-scan positive control** (an entry the scan does act on, proving
   the scan ran) and **invoke `maybeSendRecoveryNotice`** (or drop the no-notice assertion with a stated
   reason). The skip-scan mutant must fail the shipped suite.
3. **Minors — accept:** E17 uses a per-boot isolated log (or a scope that cannot accept rewritten earlier
   bytes) and pins truncate-and-regrow as a negative control; the delta is marked **provisional** and
   remeasured after the 24 probe cases are ported, with the committed-head budget gate rerun.

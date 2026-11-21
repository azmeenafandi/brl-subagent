# #546 — plan critique **r5** (`needs-work`, 1 major — test-only)

**Critic:** `critique-546-r5` (project-plan-critic, `openrouter/openai/gpt-6.1-terra`, medium) · Jev
`medium (0.44) · C1 · worktree y` · reviewed the r5 spec at `d0005d5` · **provenance:** read-only preset (no
file writes); findings transcribed by the conductor. Verdict file: `REVIEW_PR546_PLAN_R5.md`.

## Verdict

**needs-work — remaining majors: 1.** The major is **test-only** (the N3 control cannot prove the scan ran);
the design is unchanged since r2 and every r4 major is verified fixed.

## Findings

| Severity | Location | Gap | Evidence | Fix |
|---|---|---|---|---|
| **major** | §Tests N3; E25 | N3's control is **already interrupted before boot**, so it does not prove the scan marked that control. The delivered notice check is non-vacuous and the held-record failure ledger proves some scanning occurred, but the claimed same-scan control can be skipped. | `grep -n 'markInterrupted(ID\|seedInterruptedRun()' …/r4tree/src/__tests__/boot-recovery-factory.test.ts` shows the seed marks it before N3 boots. A scratch mutant **skipping every ordinary candidate** passed `vitest -t 'N3:'` **1/1** (N1/N2 failed 2/2). | Seed an **accepted, dead-owner control without `interruptedAt`**; assert its bytes change and it becomes interrupted **before** checking the delivered notice. **Falsifier:** the skip-ordinary mutant passes N3. |
| minor | §Acceptance 9; §Tests N1/N2 | Acceptance says the invoked notice surface lists the control, but under the import-failure mock it **delivers nothing**. The test checks a separately constructed projection; N3 checks delivery under a different fault. | `r5-hold.test.ts` asserts `sent=[]`, the `Recovery notice failed` warning, and a separate `[CONTROL]` projection. | State the distinct expectations in acceptance 9; reserve the delivered-notice claim for N3. |
| minor | §Acceptance 2/5 | "Readable" alone is insufficient for next-boot repair: the owner must be provably dead, the scan must run, and the write must succeed. The criteria also omit `running` from the narrowed condition. | §Acceptance 4 holds live/unverifiable owners; §P3 retains a marker when the write fails. | Qualify the guarantee: a readable **`running`** record, with a provably dead owner, an available scan and a successful write. **Falsifier:** a readable record with an unverifiable owner is repaired. |
| optional | §Verification step 8; §Delta | The r5 deletion side removed the explicit rotation/truncation reruns from the gate, although E17 retains their historical results; the new isolated-log controls cover a different scope. | `git diff --unified=2 d0005d5^ d0005d5 -- <spec> \| grep -E 'rotation\|truncation'` shows the gate deletion. | Retain rotation/identity negative controls for the isolated harness, or explain why they no longer apply. |

## Verified sound

- **E23**: `e23.sh … zero` and `partial` → two boots each `{repaired:0, retired:0, failures:1}`, marker
  retained; the synthetic truncate/partial faithfully produces the corrupt-byte states (it does not interrupt
  the real writer — disclosed); P6 states the remedy and #554.
- **The shipped hold-suite prototype passed 4/4**; **M21 failed N1/N2 2/2**; M13b failed N3 1/4; M21's killer
  is the shipped suite, not a probe.
- **E17r**: isolated no-op, regrown previous log and preseed controls failed closed; the positive control
  passed. Delta is explicitly provisional (24 cases to port; committed-head budget rerun).
- Spot checks: M18 failed 4/4, M20 failed 2/4; E2 hooked/unhooked 0/3, empty expectation 2, missing stream 3;
  the E18 r4 live-pin cases passed 2+1.
- `SOLID/DRY violations flagged: 0`.
- **Critique-run limitation (not a spec defect):** the critic's first factory-suite rerun used the fixture's
  default `/tmp` before inspecting it; subsequent reruns set `TMPDIR` to the requested scratch dir and the
  fixture teardown removed them.

## Conductor decisions (r6 mandate)

1. **Major — accept.** N3 seeds an **accepted, dead-owner** control **without** `interruptedAt`; the test
   asserts the control's bytes **change** and it becomes interrupted, then asserts the delivered notice. The
   skip-ordinary mutant must fail N3 (record it as **M22**, killer = N3).
2. **Minor — accept:** acceptance 9 states the two distinct expectations (the mock's `sent=[]` + warning +
   projection versus N3's real delivery).
3. **Minor — accept:** acceptance 2/5 gains the full precondition set (readable **`running`**, provably dead
   owner, available scan, successful write).
4. **Optional — accept:** keep rotation/identity negative controls for the isolated harness (or state why the
   isolated scope supersedes them).

**Stopping decision:** r6 is a **test-seeding + wording** revision. After it, the conductor verifies the
precise falsifier (**the skip-ordinary mutant fails N3**) and diff-reads the changed sections — no sixth full
critique round, because the design has been stable since r2 and the remaining claim is a single test property
with a mechanical falsifier.

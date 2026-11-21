# #546 — plan critique **r3** (`needs-work`, 2 majors) — **a real #542 regression found**

**Critic:** `critique-546-r3` (project-plan-critic, `openrouter/openai/gpt-6.1-terra`, medium) · Jev
`high (0.6) · C1 · worktree y` · reviewed the r3 spec at `939a1db` · **provenance:** read-only preset (no
file writes); findings transcribed by the conductor. Verdict file: `REVIEW_PR546_PLAN_R3.md`.

## Verdict

**needs-work — remaining majors: 2.** The spec should not ship yet. Five r3 fixes verified sound; the two
majors are behavioural, not proof-internal.

## Findings

| Severity | Location | Gap | Evidence | Fix |
|---|---|---|---|---|
| **major** | §The code, `flipAgentRecord`; STEP B | The boot applier's "absent/unreadable ⇒ no flip" behaviour is **also used by the live pre-start writer**. It can leave the **in-memory agent `running`**, regressing #542. With an absent file it also retires the marker. | `vitest -t 'critique 546 foreground'`: base flips memory to `failed` for absent and unreadable records; r3 leaves it `running` in both. `vitest -t 'critique failed initial persist'` (initial persist fails, permissions restored before preflight failure): base `{status:"failed",disk:true,registry:0}`, r3 `{status:"running",disk:false,registry:0}`. | Separate the live writer's **memory** transition from boot's **disk-only** replay decision; pin both faults through the real pre-start path. **Falsifier:** a failed pre-start still exposes `running` in memory after either fault. |
| **major** | §Tests N1/N2; §Execution sketch | The import-failure hold is measured by scratch probes, but the shipping test list ports only the 24 probe cases + S1/H1/S3; `boot-importfail.cjs` prints without asserting. The production-wired N1/N2 contract is not an enduring test. | `boot-importfail.cjs` has no assertion or failure exit; §Execution sketch names only the 24 cases + three suite cases; M18 reproduces both dangerous outcomes. | Ship production-wired assertions for both acceptance states (unchanged entry bytes, no finalizer/mark, marker retained). **Falsifier:** M18 passes those shipped tests. |
| minor | §Evidence E17 | Log scoping fails open on rotation/truncation: a replacement file shorter than the offset is read from byte zero, so an old settlement can pass. | A preload rotating the log after `statSync`: no-op boot reported `LOG_OFFSET:682`, `TRIPLE … ok:true`, exit 0 from a copied old line. | Fail closed on identity change/size shrink; test rotation/truncation as well as the positive line. |
| minor | §Tests C1; §Mutants | The C1 row attributes M1/M2/M4 coverage to a test that plants the marker directly; those mutations do not affect it. | `vitest -t 'C1:'` passed on M1, M2 and M4; their listed killers elsewhere did fail. | Remove the misleading C1 attribution; retain the independently verified killers. |
| minor | §Evidence E2; `EXPECT_COMMITTED` | A missing stream fails the specified assertion, but a nonempty delimiter-only expectation can pass as an empty stream. | Removing `run-entries.jsonl` with `EXPECT_COMMITTED=` → `expected:[], actual:[], ok:true`, exit 0. | Reject empty parsed expectations; distinguish unreadable/missing from a valid empty stream. |
| minor | §D7; §Evidence E15 | A held marker increments none of the settlement counters, including `flipFailures`; the operational meaning is not explicit. | `halfdep.cjs` with each dependency missing separately and both acceptance states: bytes unchanged, all three flip counters zero. | State and pin that hold is **not** a settlement failure. |

## Verified sound

- **E14**: r3 keeps the marker on a parent-directory `EACCES`, counts one failure, then repairs; registry `000`
  → `false`. H2e/H4f: **2 failed / 22 passed** on r2, **24/24** on r3.
- `statSync` treats only `ENOENT` as absent; the confirming stat is error-code aware.
- **E15** held both acceptance states byte-identically; a separately missing dependency also held.
- **E16**: two processes each `first:true`; the dedupe claim is gone (grep); the limit is stated.
- **E2**: without the hook exit 3 (`["running","failed"]`), with it `["running"]` exit 0; the hook is in the
  real seam and absent from the deliverable.
- `check-imports --dir`: r2 **60/1**, r3 **60/0**; deltas reproduce **+594/−50** and **+548/−2**; typecheck
  passed at each hop.
- M1–M15 + M13b produce their listed killers (apart from the C1 attribution); M16/M17 kill only H2e/H4f;
  M18 reproduces both fall-through outcomes; the static mutant fails the architecture rule (control 11/11).
- `SOLID/DRY violations flagged: 0`.

## Conductor decisions (r4 mandate)

1. **Major A — accept.** Split the behaviour: the **live** pre-start writer always transitions the **memory**
   record to terminal (the #542 pin), then decides retirement from a tri-state disk read (absent → retire;
   terminal → retire; running/unreadable → keep the marker for boot). The **boot** applier stays disk-only
   (fresh process: absent → retire; unreadable → `flipFailures` + keep; running + dead owner → flip; terminal
   → retire). Two functions or one with an explicit `mode` — the proposer decides, but the memory pin and the
   boot's no-memory-assumption must both be stated and tested through the real pre-start path.
2. **Major B — accept.** Add the production-wired N1/N2 assertions to the shipping test list: both
   `acceptedAt` states, entry + marker byte-identical, no `interruptedAt`, no `marked`, no never-started
   finalizer. `boot-importfail.cjs` gains assertions/exits, and the shipped tests must fail under M18.
3. **Minors — all accepted:** E17 fails closed on rotation/truncation (identity + size); the C1 mutant
   attribution is corrected; `EXPECT_COMMITTED` rejects empty expectations and distinguishes missing from
   empty; §D7 states that hold is not a settlement failure (all three flip counters zero, by design).

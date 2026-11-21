# #450 — plan critique, round 3 (2026-11-20)

**Target:** `.development/investigations/issue-450-settle-handlers-spec-2026-11-20.md` (r3, `ca11e1f`)
**Critic:** `project-plan-critic` · `openrouter/openai/gpt-6.1-terra` · thinking `medium` · run `critique-450-r3` (2m43s, $0.155)
**Jev:** `jev: xhigh (0.66) · C1 · worktree n` · settled `changes-requested`

## Result

**Verdict: needs-work**

| Severity | Plan location | Gap | Evidence (command + result) | Suggested fix |
|---|---|---|---|---|
| major | D6, T1, T5, Acceptance 3 | First-statement pinning does not prove body entry: the clear is conditional on a truthy handle. A pre-start edit can unset the handle, settle the deferred, and enter a body without another clear. The regex can also match a commented decoy rather than the actual body. | In `/tmp/brl450-critic-conditional`, added `deadlineHandle = undefined; rejectSettled(err)` after cleanup and the M12 early body throw: **T1 and T5 passed**, `tsc --noEmit` exit **0**. A separate `/tmp/brl450-critic-tripwire` block-comment decoy likewise passed both and typecheck. | Use a body-entry observable independent of the timer handle, and tie any source pin to executable handler bodies rather than an unanchored text match. Falsifier: both scratch mutants go red. |
| minor | D5 honest limit, T4, Risks | The stated lack of an independent containment mutant is too broad: the finalizer catch is behaviorally testable even if teardown is internally contained. | In `/tmp/brl450-critic-r3`, made the third `appendEntry` throw: the original-error assertion passed with containment. Removing only the `finalizeRunEntry` catch made it fail with `append blew up` instead of `original prompt`. | Add this falsifier or narrow the limit specifically to the teardown catch; assert registry-retirement attempt separately. |
| minor | D2.1, Acceptance 3, execution sketch | The spec scopes the never-issued proof, but the r3 scratch **site comment** still says a synchronous throw "therefore means the callee was never entered" without the wrapper/getter qualifications. Acceptance 3 also states the pre-start claim without that scope. | `read /tmp/brl450-r3/src/session-manager.ts` at regime 1 shows the unqualified comment; `node /tmp/brl450-r3-probes/start-then-throw.mjs` reports `live=true` after the synchronous throw. | Require the three D2.1 preconditions in the actual site comment and qualify Acceptance 3. Falsifier: the wrapper probe must not be described as proven pre-start. |

**Verified sound**

- `bash /tmp/brl450-r3-probes/mutants4.sh`: **13/13 named mutants red**, including the four-space M11 and body-entry M12. The new bypasses above are additional mutants.
- The original cleanup probes failed **2/2** in `/tmp/brl450-cleanup-probe`; r3's T4 passed. The old tripwire-bypass probe passed, as recorded.
- Routing probes: tampered own-`then` native promise survived; proxy-wrapped promise left its underlying rejection unowned and exited **1**. A separate `node` vm probe routed a cross-realm promise and a subclass with overridden `then`; intrinsic and ordinary reactions both ran at tick 0.
- `void` does not generally contain a throwing reaction: a standalone throwing handler exited **1**. In the specified routing, the reactions are the native deferred resolver functions, not the settle bodies; their non-throwing behavior is therefore an important invariant.
- `rg` found only three `clearTimeout` sites in `src/session-manager.ts` and none in `src/run-registry.ts`; the current normal T5 path counts one. This does not eliminate the conditional-handle bypass.
- The two r3 test files passed **178/178**; r3 `tsc --noEmit` exited **0**. Comparing recorded baseline/r3 JSON by normalized failing test names found **69 identical failures**, not just identical counts.
- `git diff --no-index --numstat` confirmed the stated cumulative **+149/−29** source and **+419/−0** test delta; six tests are added. `gh issue view 542` confirms the follow-up is open. No repository files were modified.

**Open questions the plan should answer**

- None beyond choosing how to close or explicitly narrow the contracts identified above.

## Conductor triage

All three accepted. Round 2's five resolutions stand (13/13 mutants re-run; routing and normalisation probes verified). The remaining major is narrow and mechanical in shape but needs a real design seam: a **body-entry observable independent of the timer handle**, and source pins tied to the executable handler bodies rather than an unanchored text match. The two minors are wording/limit corrections plus one additional falsifier. Locked decisions unchanged: S1, G1′, #542.

# #450 — plan critique, round 5 (2026-11-20)

**Target:** `.development/investigations/issue-450-settle-handlers-spec-2026-11-20.md` (r5, `9db78ec`)
**Critic:** `project-plan-critic` · `openrouter/openai/gpt-6.1-terra` · thinking `medium` · run `critique-450-r5` (3m11s, $0.160)
**Jev:** `jev: xhigh (0.6) · C1 · worktree n` · settled `changes-requested`

## Result

**Verdict: needs-work**

| Severity | Plan location | Gap | Evidence (command + result) | Suggested fix |
|---|---|---|---|---|
| major | D2.3, D3, Acceptance 8 | The supported species contract is still inconsistent. The site permits a safe `constructor` lookup returning intrinsic `Promise`, but does not require its `Symbol.species` lookup to be safe. It also says every other value throws, although the table measures subclasses and cross-realm promises as accepted. | `node --unhandled-rejections=strict` with `p.constructor === Promise` and a throwing `Promise[Symbol.species]` printed `routing: species trap`, then exited **1**. `species-variants.mjs` routed subclass and cross-realm promises with exit 0. | State the same precise supported assumptions at the site, D3 and Acceptance 8, including species; distinguish "unsupported" from "necessarily rejected." Falsifier: the intrinsic-species probe must not be described as contained. |
| major | Delta budget; execution sketch 15 | The planned test harness exceeds the flow gate, but the sketch omits the required PR declaration and does not assess its cost. | `git diff --no-index --numstat` confirmed source `+232/−35` and test `+910/−1`: net source **197**, test **909**, allowance **514**, over by **395**. `scripts/check-test-budget.mjs` requires `Test budget: <reason>` when over. | If retaining this delta, require the bare declaration and rationale. A cheaper sufficient pin is an indentation-normalized snapshot/hash of the entire window: scratch hashes differed for **M14/M15/M19/M21**. Its trade-off is stricter, opaque review of *any* window change, including comments; deliberate snapshot updates must be reviewed rather than blindly accepted. Do not assume it alone brings the whole PR under budget. |
| major | Appendix A; execution sketch 14 | The supposedly preserved, copyable mutant suite depends on volatile, absolute `/tmp` paths and 21 external Python patches; Appendix A includes only M19 and M21. A fresh implementer cannot execute the prescribed gate from the spec alone. The runner also prints the *expected* RED/GREEN label, rather than deriving it from the test exit. | `rg '^# /tmp/brl450-r5-mutscripts/'` finds only **m19.py** and **m21.py** in the appendix; `mutants-final.sh` references all 21 external patches and prints `$want`. | Make the gate reproducible without proposer-owned scratch state, and validate actual patch, typecheck and test outcomes. Falsifier: run it from a fresh scratch tree with the proposer's `/tmp/brl450-*` absent. |
| minor | D5.1, "What this investigation did not verify" | "Sites 1–3 are pinned by T4 case 6" overstates coverage: case 6 faults the finalizer path; the spec itself says the teardown catch's mutant M18 stays green and the retire catch is unreachable through the harness. | `bash /tmp/brl450-r5-probes/mutants-final.sh`: **M18 GREEN**; T4 case 6 exercises the throwing third `appendEntry`, not all three logging sites. | Name site 2 as behaviorally pinned and sites 1 and 3 as construction-only unless separately demonstrated. |
| minor | Evidence log E40; "What this investigation did not verify" | The carried-entry explanation says E40's subjects were unchanged by r5, although `safeLog` is new in r5. The label alone does not establish which version its earlier run measured. | `git diff --no-index --numstat /tmp/brl450-r4/src/session-manager.ts /tmp/brl450-r5fresh/src/session-manager.ts` gives **+48/−18**; D5.1 identifies `safeLog` as new. The present `/tmp/safelog-probe.mjs` run returns normally for all seven thunks, but does not verify the earlier chronology. | Correct the provenance explanation and identify the tree used for E40; keep the fresh probe result separate from claims about the killed attempt. |

**Verified sound**

- `bash /tmp/brl450-r5-probes/mutants-final.sh`: **M1–M17 and M19–M21 red, M18 green**, all `tsc=0`. M4–M7 use compiling `Date.now()` throws. C1's wrapper probe reports `live=true`; C2's throwing constructor getter exits 1 in both default and strict modes.
- Re-running T1 on the four decoy trees gave **M19/M21 green on r4 and red on r5**. T4 case 6 and T3 case 3 were red on r4 source and green on r5; T7 and its three refusal cases passed.
- `node /tmp/safelog-probe.mjs` returned normally for all seven thunks. The tested species containment attempts do not establish a universal way to attach: intrinsic `then` and `Promise.resolve` perform the problematic read, while `Promise.race` leaves the rejection unowned in the probe.
- Both r5 scratch trees passed **179/179** targeted tests and typecheck. JSON comparison found **69 failed, 1 skipped, 10 failed files, 31 failed suites** on the smaller corpus, with no added failing names; the full-corpus comparison likewise had no additions.
- The 22 resolution rows are present once each; the measured delta table matches the scratch trees. No repository files were modified.

**Open questions the plan should answer**

- None beyond the decisions and falsifiers identified above.

## Conductor triage

All five accepted. Three majors: (1) the species contract needs the same precise wording in three places and must stop calling measured-accepted values "rejected"; (2) the test delta is **over** the flow gate by 395 lines — the PR needs a `Test budget:` declaration, and the spec must say so; a cheaper window-hash pin is possible but does not by itself bring the PR under the allowance; (3) Appendix A cannot be executed without the proposer's `/tmp` state, so either make it reproducible or stop presenting it as a copyable gate. The two minors are coverage and provenance precision, not design.

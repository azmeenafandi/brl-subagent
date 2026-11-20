# #450 — plan critique, round 6 (2026-11-20)

**Target:** `.development/investigations/issue-450-settle-handlers-spec-2026-11-20.md` (r6, `cbfdb62`)
**Critic:** `project-plan-critic` · `openrouter/openai/gpt-6.1-terra` · thinking `medium` · run `critique-450-r6` (4m03s, $0.244)
**Jev:** `jev: xhigh (0.64) · C1 · worktree n` · settled `changes-requested`

## Result

**Verdict: needs-work**

| Severity | Plan location | Gap | Evidence (command + result) | Suggested fix |
|---|---|---|---|---|
| major | D2.3, D3, Acceptance 8; Appendix A.2 | The three identical contracts incorrectly say every attachment path performs the species read and that no containment exists. The `await` probe leaves the *watcher's* rejection unhandled; it does not prove the original promise cannot be handled. | `node --unhandled-rejections=strict` with a throwing intrinsic species getter and `try { await p } catch (e) { ... }` printed `handled: late rejection`, `alive`, and exited **0**. | Correct the universal claim and probe. Keep the specified routing decision if desired, but distinguish its residual from a claim that all containment is impossible. |
| major | Appendix A; execution sketch 14 | The script reports success even when patches fail, and treats a test-file load failure as a mutant kill. | On a fresh `git archive HEAD` tree, `BASE=... WORK=... bash gate.sh` printed **19 PATCH FAILED**, two GREEN, and exited **0**. Adding a top-level `throw new Error("harness-load-fault")` made M4/M6 print **RED**, `tsc=0`, although Vitest reported **no tests**; the script still exited **0**. | Exit nonzero for unexpected verdicts, patch failures, and selections that did not execute the named test; verify the claimed failure reason. Falsifier: the two probes above must not pass the gate. |
| major | D5; Appendix A M16–M18; execution sketch 14 | The gate's exact-match anchors do not match the printed implementation sketch, yet the sketch says to fix the source against the spec and never adjust the patch. | A Python extraction comparing each `old="""..."""` against the printed D5 `failPreStart` block returned exact-match counts **M16=0, M17=0, M18=0**. The log-call formatting differs. | Print a mutually consistent implementation and patches, or explicitly make the patch anchors adaptable while preserving the intended mutations. Falsifier: a fresh agent following the printed D5 block can apply all three patches. |
| minor | Ratchet limits; Appendix B.1 | The asserted fail-closed lexer guarantee is too broad: a valid regex/division construct can make the body reader silently truncate at a regex brace. | Extracted B.1 into a fresh scratch Vitest test. For `if (true) /};/ / 1;`, `handlerBodyLines` returned a truncated body ending `if (true) /` and the test passed; `node -e 'if (true) /};/ / 1'` confirmed valid syntax. This does **not** establish a complete T1 bypass. | Fix the boundary check and add this falsifier to T7, or explicitly narrow the guarantee. |
| minor | §Mutants M5/M11; E10/E38 | Some historical evidence and anchors remain misleading after the corrections. | `read /tmp/brl450-r6/fresh-gate.log` reports M5 window **293** and M11 **292**, versus **289** and **288** in §Mutants. E10/E38 still present r5 M18 as a measured mutation despite E46's no-op correction. | Correct the anchors and explicitly mark the r5 M18 observations as unmutated-tree results wherever summarized. |
| minor | Appendix A `run_case` | The supposedly isolated script writes a shared absolute proposer path regardless of `WORK`, allowing concurrent runs to overwrite each other's diagnostics. | `grep -n '/tmp/brl450-r6-patch.log' gate.sh` found the hard-coded redirect and read at lines 289–290. Running the extracted script consequently wrote that path. | Put the patch log under the caller's unique `WORK`; use a fresh work directory. |

**Verified sound**

- **Species classifications tested independently:** the extracted Appendix A.2 probe gave intrinsic-species throw `routed=false`, exit **1** in default and strict modes; subclass and cross-realm variants routed and exited **0** in both. An own `constructor` getter returning `Promise` also routed successfully, so "own getter" must mean a *throwing* getter.
- The site comment, D3 and Acceptance 8 normalize to the same **1,492-character** string. Each starts: "SUPPORTED — an ordinary native `Promise<void>` of this realm whose `constructor` and `Symbol.species` reads BOTH complete without a throw and resolve to the intrinsic `Promise`". Their identical final no-containment claim is the defect above.
- **r5 evidence defects:** running a scratch copy of the stored `m18.py` against its own extracted anchor left the source SHA unchanged and rewrote `m18.py`. A separate file-write instrument on a fresh **baseline** tree recorded one success-catch hit for each cited catch-all test, both passing. `rg 'constructor|species' /tmp/brl450-r5fresh/src/session-manager.ts` found **0** lines. These checks do not independently establish M18's corrected result on an r6 implementation.
- **Budget:** inspection of the proposer artifact gave source **+253/−35**, test **+910/−1**: net **218**, allowance **556**, test net **909**, over **353**. The bare declaration passed `--declaration`; its fenced equivalent failed. Both the numbered sketch and PR checklist require the line.
- **Hash arithmetic:** using the spec's estimates, `909 − (390…440) + (15…25)` gives **484–544**, below r6's **556** allowance. Against r5's **514**, the range straddles the allowance, so neither categorical r5 outcome follows from those estimates. Opaque diagnostics, comment pinning and spelling pinning are real quality trade-offs; G1′ remains locked.
- The resolution table contains **27 distinct rows**, numbered 1–27. `gh issue view` confirms #542 and #543 are open; their exclusion remains explicit. No repository files were modified.
- **Mutant-table limitation:** the critic extracted and ran Appendix A from a fresh repository tree, but did **not** independently construct the full r6 implementation and therefore cannot verify its 21-result table. The inspected proposer log claims M1–M17 RED, M18 GREEN, M19–M21 RED, all with `tsc=0`; these are **reported, not independently verified**.

**Open questions the plan should answer**

- None beyond the concrete corrections and falsifiers above.

## Conductor triage

All six accepted. The three majors are **all about the proof apparatus, not the design**: (1) the "no containment exists" claim is false — `try { await p } catch` handles the species case (exit 0), so the routing contract must be corrected and the `await` option evaluated; (2) the executable mutant gate passes when patches fail and when no tests run — it is not a gate; (3) the gate's patch anchors do not match the printed D5 block, so a fresh implementer cannot apply them. The three minors are lexer breadth, stale anchors, and a shared-path collision.

**The design has not moved since r4.** Every finding from r5 onward has been about the evidence machinery. That is the signal: the spec's harness (masker + body readers + executable mutant gate, ~400–440 of the 909 added test lines) is now the largest risk in the change — it has produced a broken gate, incompatible anchors, a false containment claim and a leaking shared path, and it costs more review attention than the 50-line production change it protects.

# #450 — plan critique, round 4 (2026-11-20)

**Target:** `.development/investigations/issue-450-settle-handlers-spec-2026-11-20.md` (r4, `338a930`)
**Critic:** `project-plan-critic` · `openrouter/openai/gpt-6.1-terra` · thinking `medium` · run `critique-450-r4` (3m33s, $0.175)
**Jev:** `jev: xhigh (0.57) · C1 · worktree n` · settled `changes-requested`

## Result

**Verdict: needs-work**

| Severity | Plan location | Gap | Evidence (command + result) | Suggested fix |
|---|---|---|---|---|
| major | Q3, T1, Acceptance 2 | The regime-body checks still match unmasked window text. A comment decoy can satisfy the regime-2 regex while an executable throw is inserted before routing. | In `/tmp/brl450-r4crit-regime`, placed the exact regime-2 `try` text in a marker-helper comment and inserted a throwing statement in the real regime 2. `tsc` exited 0; `vitest … -t ratchet` **passed**. | Anchor both regime checks to their executable blocks. Falsifier: the compiling decoy-plus-throw mutant fails T1. |
| major | D2.3, D3, Acceptance 8 | Intrinsic routing is not non-throwing for *every native promise*: `Promise.prototype.then` reads the promise's constructor/species. A throwing constructor getter strands a later rejection, despite the stated supported-value guarantee. | `node --unhandled-rejections=strict` with a native promise whose `constructor` getter throws printed `routing catch: species lookup exploded`, then exited **1** on its later rejection. | Narrow the supported contract and name this residual, or contain it; add the native-promise species probe as falsifier. |
| major | D5, Acceptance 7, execution sketch 3 | Catching each step does not guarantee original-error preservation: the catch's own logging can throw through the opt-in console mirror, preventing later steps. | In `/tmp/brl450-r4crit-lexer`, enabled `setConsoleOutput(true)` and made `console.warn` throw in T4 case 5. `tsc` exited 0; T4 failed: received `console blew up`, not `original prompt`. `src/logging.ts` leaves console calls outside its file-write catch. | Contain catch-path logging or narrow the guarantee. Falsifier: a throwing console sink must not replace the original error or prevent the retire attempt. |
| minor | T1 ratchet limits | The lexer limitation is broader than regex literals *inside* bodies: a regex before a declaration can hide it, and a brace in a regex can silently truncate the returned body. | Scratch helper probes in `/tmp/brl450-r4crit-lexer`: `/[/*]/` before the declaration produced "declaration not found"; `/[}]/` inside returned a truncated body ending `const r = /[`. String/template decoys, an internal comment decoy, nested braces, and `/[//]/` before the declaration behaved as expected. | Test the masker against these cases and define a fail-closed handling for regex literals, or use a more reliable executable-body pin. |
| minor | E10, E26, E29, execution sketch 12 | The recorded evidence is not reproducible as written: the saved mutant script uses an undefined function for M4–M7; the suite counts conflate one skipped test with failures. | `bash /tmp/brl450-r4-probes/mutants5.sh`: M4–M7 red but **tsc=1**. Re-running with compiling `Date.now()` throws gave **tsc=0 and red** for all four. JSON fields show r4 **69 failed, 1 skipped, 10 failed files, 31 failed suites**, not 70 failed tests. | Preserve the compiling mutant script and correct the evidence/count labels. Compare failures by normalized name, not arithmetic. |

**Verified sound**

- `vitest run` on the two r4 scratch test files passed **178/178**; `tsc --noEmit` passed. M1–M16 were red, with M4–M7 re-derived as compiling mutants; M17 was red and M18 green with `tsc=0`.
- T5 sets the sink cwd and debug level; its success positive control fires. The marker catches logger throws, and default `info` filters it. With `BRL_LOG_LEVEL=debug`, however, each settle adds one synchronous log record and associated file/rotation work.
- Comparing `/tmp/brl450-{base,r3,r4}-full.json` by normalized failing `fullName` found **69 identical failing names**, no additions or removals: the recorded scratch acceptance of zero new failures is met.
- The D2.1 three preconditions appear in both pasted site comments; Acceptance 3 is qualified. The wrapper probe reports `live=true`. The two T4 case-5 mutants separately expose original-error preservation and the registry-retire call; M18 supports the narrower defence-in-depth label.
- `git diff --no-index --numstat` confirmed the delta table: baseline→r4 **+196/−29 source, +588/−1 test**; r3→r4 **+54/−7, +177/−9**. Only those two source-tree files differ. No repository files were modified.

**Open questions the plan should answer**

- None beyond the contracts and falsifiers identified above.

## Conductor triage

All five accepted. The three majors are no longer design holes: they are **contract narrowings** (the species read, the log sink) and **instrument hardening** (regime checks still reading unmasked text). The two minors are masker coverage and evidence hygiene. The series by count is 9 → 5 → 3 → 5, but the character shifted: rounds 1–2 found design defects, rounds 3–4 find that the *tests meant to prove the design* can be made to pass for the wrong reason. r5 is mechanical: mask+brace-match the regime blocks too; add the species probe and narrow D3; contain the catch-path logging; fail-closed the lexer; fix the mutant script and count labels.

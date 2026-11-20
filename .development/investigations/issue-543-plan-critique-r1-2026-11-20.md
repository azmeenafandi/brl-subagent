# #543 plan critique — round 1 (2026-11-20)

Critic: `critique-543-r1` (`project-plan-critic` + `openrouter/openai/gpt-6.1-terra`, pinned
`thinkingLevel: medium`). Plan under review: `issue-543-console-mirror-spec-2026-11-20.md` at
`83b71cc`. The dispatch was read-only; this record is the conductor's transcription of the returned
findings.

**Verdict: `needs-work`** — 3 major, 3 minor. The design (option A) is sound; the **proof apparatus**
is not: an untested retry contract, a baseline that cannot establish the failing-set claim, and a
flow step that is not the flow gate.

## Findings

| # | Sev | Plan location | Gap | Evidence (command + result) | Fix |
|---|---|---|---|---|---|
| G1 | **major** | §3.1, §5, §8 | The promised **retry-after-fault** behaviour is untested: a fault can permanently disable the mirror while every proposed test passes. | In a `/tmp` copy, adding `consoleOutput = false` to the new catch yielded `16 passed` in `logging.test.ts` and `1 passed` in the integration filter. | Test a throwing mirror followed by a **healthy call in the same module instance**; the disabling mutant must fail. |
| G2 | **major** | §7 AC7, §12 steps 2–7 | The sequence never captures the full-suite baseline **with the new tests applied and the old source**, so the claimed six-test failing-set difference cannot be established. | Steps 2–3 run only targeted tests; step 7 runs the full suite after the fix. The original base has no new logging cases. | Capture full-suite failing names on the **test-patched base**, then compare with the fixed tree; separately establish the clean-base result. Any new fixed-tree failure falsifies AC7. |
| G3 | **major** | §12 step 8 | `git diff --numstat` is **not** the flow gate: it includes working-tree changes and does not test the final committed PR head. | `node scripts/check-test-budget.mjs --flow --base <base> --head HEAD` in a scratch repo → `+114/+8 src (allowance 136) — within`; using the base as head → `already-merged`. | Run the real `--flow` command against `dev` and the **final committed head**, before merge; record its exit and output. |
| G4 | minor | Contract, §4 catch comment | “The entry is still written to the file” is unconditional, but no write occurs without a configured cwd, and file-write errors remain swallowed. | A real logger probe with no cwd and a throwing mirror returned normally with no file attempt (`src/logging.ts:128–130,165–175`). | Say the mirror fault **does not prevent the file-write attempt**, when configured; persistence stays conditional on the file sink. |
| G5 | minor | §11 | The integrated delta is understated: the doc replacement is net zero and the test count excludes added blank lines. | Integrated `/tmp` commit `--numstat`: logging `10/2`, doc `6/6`, logging tests `114/4`, integration `6/2`; flow **+8 source, +114 tests, allowance 136**. | Correct the estimate; the shape is within budget by 22 lines. |
| G6 | minor | §5.1, §8 | “Five cases” and M1's “all 5 new cases” omit the sixth, disabled-mirror guard. | Patched base run: **5 failed, 11 passed, 16 total** — the guard passes. | Name six added cases, five baseline-red. |

## Verified sound

- The issue's two observables confirmed. Probes of base/A/B confirm A contains method throws, an
  **undefined method** and a **throwing property getter**, while still writing the entry; B
  suppresses the throw but loses the entry and also suppresses a cyclic `JSON.stringify` throw
  (which is **why** the cyclic case is explicitly separate — see #545).
- The isolated integration assertion failed on base, passed **without isolation** on base, and
  passed isolated on A. `realWarn` must be captured **after** `mockRestore`.
- M2/M5/M6 → 1/16, 4/16, 5/16 failures. Removing the try entirely is already M1.
- The replacement `safeLog` doc keeps #450's rationale, credits #543, explains the remaining local
  containment; the old “mirror OUTSIDE” wording exists only there.
- The cyclic-data throw is a **separate** defect; a follow-up issue is warranted.

## Conductor decision (2026-11-20) — in-plan, r2

- **G1**: add the retry-after-fault test (same module instance) and the disabling mutant.
- **G2**: add the test-patched-base full-suite capture as an explicit numbered step, with the
  failing-name diff against the fixed tree, plus the clean-base result.
- **G3**: replace the numstat step with the real `--flow --base dev --head <final sha>` run.
- **G4–G6**: adopt as stated.
- **Follow-up filed:** #545 (cyclic/BigInt `data` throws out of `log.*` before the file catch) —
  out of scope here.

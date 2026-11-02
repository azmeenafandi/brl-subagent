# Complexity / CRAP re-measurement — 2026-11-02

> **REVISIT 2026-11-06.** Decide then: keep the current smell vocabulary (no CRAP gate), adopt CRAP as a
> changed-functions **advisory**, or a soft ceiling on new/changed functions only. Inputs below.

## Why

The 2026-10-25 smell audit measured ESLint `complexity` and concluded: *"re-ranks, adds no recall"* — every
function above 15 was also a body-length finding — and **deliberately excluded `high-complexity`** from the
adopted smell vocabulary (`smell-audit-2026-10-25.md:416`). CRAP (complexity² × (1−coverage)³ + complexity) was
never measured or discussed. The tree has changed materially since (the #374 sweep, #412/#415/#419), so this
re-measures complexity and approximates CRAP before deciding whether coverage-weighted risk belongs in the
process.

## Method (throwaway worktree, nothing in the repo changed)

- Tree: `dev` @ `103a774`. Worktree `../brl-subagent-complexity`, isolated deps, deleted after.
- **Cyclomatic:** ESLint 9 + `typescript-eslint` 8 (installed under `/tmp/smell-eslint`, with its own
  `typescript@5.9`; the repo's TS 7 is untouched), rule `complexity: ["error", 1]` over `src/*.ts`, JSON output.
- **Coverage:** `vitest run` 5.0.5 + `@vitest/coverage-v8@5.0.5` (worktree-local), `--coverage.reporter=json`,
  include `src/**/*.ts`, exclude `src/__tests__/**`. 98 files / 1959 tests green.
- **Join:** each ESLint `complexity` finding matched to Istanbul's `fnMap` by declaration line (name as
  tiebreak); coverage = executed statements / statements whose start line falls inside the function's
  `loc.start..loc.end`; `CRAP = c²(1−cov)³ + c`.
- Coverage boundaries: **statement** coverage as a proxy for branch coverage (CRAP nominally uses branch
  coverage); statements of nested functions count toward the parent; the TUI's live components are not
  exercised by the suite by design (see the false positive below); 15 of 510 functions could not be matched.

## Cyclomatic — now vs the 2026-10-25 audit

510 functions reported; **38 above 15** (audit: 41). Top:

| Complexity | Function | Audit value |
|---:|---|---:|
| **116** | `index.ts` `execute` (the delegate_task handler) | 111 |
| 55 | `tui.ts` `buildView` (live-transcript view closure) | 55 |
| 43 | `types.ts` `isSubagentStateShape` | 43 |
| 40 | `validate.ts` `validatePreTask` | 36 |
| 38 | `session-manager.ts` `spawnBackgroundSession` | 35 |
| 37 | `history.ts` `resolveRetryParams` | 35 |
| 35 | `params.ts` `resolveSubagentParams` | 39 |
| 35 | `notify-completion.ts` `buildCompletionMessage` | 35 |
| 35 | `tui-format.ts` `formatMenuValue` | 35 |
| 34 | `state.ts` `restoreFromSession` | — |
| 33 | `runner.ts` `handleMessageUpdate` | — |
| 28 | `index.ts` `execute` (second, line 3593) | — |

**The audit's conclusion still holds**: every one of these is also a body-length finding — `complexity`
re-ranks, it adds no recall.

## CRAP approximation

Median function statement coverage is **100%**; CRAP is therefore dominated by a few low-coverage functions.

| CRAP | cx | cov | Function | Read |
|---:|---:|---:|---|---|
| **3080** | 55 | **0%** | `tui.ts` `buildView` | **False positive for risk**: untested by design (live TUI component). A gate would need a TUI exclusion. |
| **407** | **116** | **72%** | `index.ts` `execute` | **Real**: highest complexity in the tree and 28% of its statements uncovered. The most change-prone function we have. |
| **281** | 18 | **7%** | `session-manager.ts` `skipJsonValue` | **Real**: a hand-written JSON scanner used by transcript parsing; low complexity, near-zero coverage. |
| 110 | 10 | 0% | `tui.ts` `handleInput` | TUI, untested by design. |
| **108** | 35 | **61%** | `params.ts` `resolveSubagentParams` | Real: ~40% uncovered at complexity 35. |
| 99 | 43 | 69% | `types.ts` `isSubagentStateShape` | Real: shape classifier, ~31% uncovered. |
| 72 | 34 | 68% | `state.ts` `restoreFromSession` | Real: boot-restore path. |
| 64 | 28 | 64% | `index.ts` `execute` (line 3593) | Real: second `execute`, ~36% uncovered. |

## What the numbers say

1. **Complexity alone earns nothing new** — same call as the audit, fresher numbers.
2. **CRAP adds exactly one dimension: coverage-weighted risk.** Three findings are genuine rather than
   testability artifacts: `execute` (116 cx / 72% cov), `skipJsonValue` (18 cx / 7% cov), and
   `resolveSubagentParams` (35 cx / 61% cov). `isSubagentStateShape` and `restoreFromSession` follow.
3. **The top CRAP number is the least actionable**: `buildView` is untested because we deliberately do not test
   live TUI components. Any CRAP gate needs a TUI exclusion or it flags it forever.

## Options for the 2026-11-06 decision

- **A. Keep the vocabulary as-is** (no CRAP gate) and treat `execute` / `skipJsonValue` as targeted follow-ups.
- **B. Changed-functions CRAP advisory**: report the CRAP of functions touched by a PR (needs
  `@vitest/coverage-v8` in CI, a per-diff join, and a TUI exclusion); never fails the build.
- **C. Soft ceiling on new/changed functions only** (e.g., CRAP ≤ 30 unless explicitly waived).

A hard repo-wide gate is not on the table: it would fail today on a by-design-untested component.

## Provenance

Measured 2026-11-02 on `dev` @ `103a774`. Prior art: `.development/investigations/smell-audit-2026-10-25.md`
(the exclusion decision and calibrated smell thresholds). Related: #421 (engineering bar injection — this
measurement is a candidate input to that bar, not yet part of it).

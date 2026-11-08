# 0021. No CRAP gate: complexity stays a smell, coverage debt is paid as targeted follow-ups

- **Status:** Accepted
- **Date:** 2026-11-06
- **Issues:** #428, #429, #430
- **Related:** `.development/investigations/complexity-crap-2026-11-02.md`, `.development/investigations/smell-audit-2026-10-25.md`

## Context

The 2026-10-25 smell audit measured ESLint `complexity` and concluded "re-ranks, adds no recall", so
`high-complexity` was excluded from the smell vocabulary. CRAP — coverage-weighted risk — had never been measured.
The 2026-11-02 re-measurement joined ESLint complexity with Istanbul statement coverage over 510 functions:

- **38 functions above complexity 15** (audit: 41), and every one is also a body-length finding — the audit's
  conclusion holds.
- **CRAP is dominated by a few low-coverage functions.** The top number (`buildView`, 55 cx, 0% coverage, CRAP
  3080) is a **false positive by design**: live TUI components are deliberately untested.
- The genuine findings are `execute` (116 cx, 72% cov), `skipJsonValue` (18 cx, 7% cov), and
  `resolveSubagentParams` (35 cx, 61% cov); `isSubagentStateShape` (43 cx, 69%) and `restoreFromSession`
  (34 cx, 68%) follow.

Three options were on the table: **A** keep the vocabulary, no gate, targeted follow-ups; **B** a changed-functions
CRAP advisory (coverage-v8 in CI, a per-diff join, a TUI exclusion; never fails); **C** a soft CRAP ceiling on
new/changed functions with explicit waivers.

## Decision

### 1. Option A — no CRAP gate

The smell vocabulary is unchanged and CI gains no coverage step. Rationale:

- **No recurring evidence.** Nothing in the record shows new complex-and-untested functions accumulating; the
  measured debt is a fixed set of old functions. B and C would build machinery against a hypothetical.
- **The machinery is real.** B/C need `@vitest/coverage-v8` in CI, a per-diff coverage join, a TUI exclusion, and
  (for C) a waiver mechanism — for a signal the reviewer can already see on a diff.
- **The one measured gate blocker is an artifact.** A repo-wide gate would fail today on `buildView` because we
  choose not to test live TUI components; carving out an exclusion before the gate earns anything is backwards.
- **The debt is better paid directly.** Tests for a 7%-covered JSON scanner and a parameter-precedence seam, plus
  one behavior-preserving refactor, buy more than a report that never fails.

### 2. The debt is scheduled as targeted follow-ups

- **#428** — tests for `skipJsonValue`: the real scandal is coverage (7%), not complexity.
- **#429** — tests for `resolveSubagentParams`: pin the precedence rules and the uncovered branches.
- **#430** — split `execute`: behavior-preserving, its own reviewed unit, CodeGraph-first map, `project-implementer`
  preset, suite as the pin.
- `isSubagentStateShape` and `restoreFromSession` are secondary; they may join the same batch if capacity allows.

### 3. The revisit trigger is a regression, not a number

Adopt **B** (report-only, TUI-excluded) only if a changed function with high CRAP and materially incomplete
coverage reaches review **without a signal catching it** — i.e. a real changed-function regression escapes. A
single artifact such as `buildView` is not a trigger; it is by design.

If B or C is ever adopted, settle the measurement's boundaries first: the TUI exclusion, statement coverage as a
proxy for branch coverage, and nested-function attribution. Those are properties of the measurement, not of the
gate.

## Consequences

- No new CI dependency, no added CI time, no waiver bureaucracy.
- Complexity numbers stay informational; the engineering bar (SOLID/DRY) and the body-length smell remain the
  review-time signals for oversized functions.
- The risk is that no automatic guard exists. It is accepted because the falsifier above is concrete, and because
  the three follow-ups remove the measured debt rather than hiding it behind a threshold.
- A future complexity discussion should start from ADR 0021 and the investigation, not re-derive the options.

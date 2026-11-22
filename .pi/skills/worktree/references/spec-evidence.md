# Spec evidence that can fail

**When this loads:** writing or critiquing a unit spec's §Evidence / §Tests tables, or reviewing a PR
whose body claims a probe result. Rule 11 filed this as a class (#557) because every unit of
`settle-handlers` paid for at least one evidence row that could not fail: N1/N2 passed without a
registry scan, N3's control was pre-marked, E2's probe set a variable with no consumer, E17's log scope
failed open on truncate-and-regrow, and `EXPECT_COMMITTED` accepted an empty stream.

## The five rules

1. **A row names a command and the assertion it must satisfy.** `run X` is a print, not evidence;
   `run X; expect exit 1 naming row 197` is evidence.
2. **Every test row states its negative control** — the mutant, fault or fixture change that makes it
   fail. A test without a named control is a demo.
3. **Every mutant names a measured killer**, and no test may claim a kill it cannot demonstrate.
   (Measured: "M3 → 1 failed, the `da_DK` probe" is a kill; "M3 covered by case 14" is a claim.)
4. **Every probe has a pass state and a fail state.** A harness that can only print, or that passes when
   the input is missing, is not evidence. Absent sources must refuse, not produce a clean-looking
   receipt (the shape #533's critique found).
5. **A provisional number is labelled and re-measured at the head** before the PR body lands. Counts in
   prose outside the `pr-evidence` block are a `pr-evidence` finding; a count at the wrong head is a
   provenance finding.

## A filtered row: the executed count, not the exit status

A row whose command filters the suite (`vitest run <file> -t "<title>"`) cannot be judged by its exit
status: vitest exits **0** when the title matches nothing, with a JSON report saying `passed 0 /
failed 0 / pending 44 / success true` (measured, vitest 5.1.0 — issue #591). Such a row runs through
`node scripts/require-executed.mjs -- <vitest args…>` and quotes that tool's summary line
(`require-executed: 1 executed / 1 passed — …`), so the receipt carries the executed count the claim
depends on. A row pasted from a bare `npx vitest -t` run is a finding, not evidence.

## The falsifier

The class is closed not by the prose but by its use: a critic finding that an evidence row cannot fail,
or a shipped test that stays green under its claimed mutant, **is** the falsifier. If a unit's evidence
survives that test, the checklist did its job.

## Applying it (worked example, 2026-11-21)

The `#533` spec v1 (candidate generator) was written, then checked against these five rules before its
critique: rule 4 caught that an absent spawn log would produce a valid-looking *empty* candidate file
(a probe that passes when its source is missing); rule 1 caught that "≥1 candidate" cannot fail because
the window certainly contains failures; rule 2 caught that the fixture and the `file:line` provenance
contradicted each other (inline events cannot prove line retention). The critique then found the
remaining source-adequacy problems — the checklist did not replace the critic, it stopped the cheap
class before the expensive one.

## Where it binds

- The plan-critic template (`templates/plan-critique.md`) lists these five as required finding
  categories; a critique that does not apply them is incomplete.
- The spec skeleton's §Evidence and §Tests tables cite this reference in their heading.

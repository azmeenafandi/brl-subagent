# REVIEW — PR #392 (#379 commit 4: one batch mode prologue) @ `7c4c7ab`

Reviewer: `openrouter/openai/gpt-6-luna` — focused C2, Jev **medium (0.7)**. Design authority:
`.development/investigations/mode-prologue-design-2026-10-25.md` (§3 IN1–IN12, §4 Design C, §6 pins).
Diff `666746f..HEAD`: `src/mode-prologue.ts` (new), `src/prelude.ts` (`resolveModeModel`,
`resolveSubagentModelPrecedence`, shared rejection builders), `src/index.ts` (−537 net), `src/model-availability.ts`
(`parseModelString`), `mode-prologue-unit.test.ts` (new, 12), `.development/ARCHITECTURE.md`.

**Verdict: approve — 0 findings, 0 SOLID/DRY violations** → merged `04f41d0`.

## Findings

None.

## Verified-OK

- **The 20 pins are unmodified and real:** `git diff 666746f..HEAD -- mode-prologue.test.ts` empty; the reviewer
  swapped cost↔depth in `src/mode-prologue.ts` → **4 pin failures** (the three batch order pins + the cost/depth
  precedence pin); restored, tree clean. The pins observe production because `runModePrologue` imports and calls
  the `prelude` gates the harness wraps at the module boundary.
- **Placement deviation sound:** the new module calls the shared gates (no reimplementation), the wrappers see those
  calls, no import cycle, entry-confinement and the docs module map pass with the full suite.
- **Single-path touch identical:** `execute`'s depth-limit and empty-model rejections now use the shared builders —
  text and shape (`details: undefined`, `isError: true`) match the former literals; gate positions and control flow
  unchanged; appropriate scope forced by the prose guard (site 6 does not join the prologue — Q2 respected).
- **Model tail neutral:** per-call → preset → configured → conductor precedence preserved; empty-model rejection and
  circuit check in the same order; `parseModelString` moved unchanged; single/background call shape identical.
- **`currentDepth`:** the three batch handlers spawn at `+1` exactly as at the base.
- **jscpd:** **10L/70t → 0 clones** (the sweep's acceptance). At 8L/50t the five pairs are the three identical
  `resolveModeModel({…})` call sites, the pre-existing background poller pair, and two pre-existing steer/stop
  fragments — no prologue or pre-pass fragment at either threshold.
- **No collateral:** diff exactly the six files; handler labels/descriptors/collection shapes/warning surfacing/JSON
  tails retained; **90 files / 1798 tests**, `tsc` clean, `git diff --check` clean, docs regen no-op; PR body carries
  `Fixes #379` + `Part of #374`; runtime-vocabulary ratchet green; review left no modifications.

## Disposition (2026-10-25)

Merged `04f41d0`; **#379 and #374 closed**. The duplication sweep is complete: 6/6 units, jscpd 10L/70t
**28 → 9 → 0 clones**, D1/D2 gone, structural guards pin the shapes. Board: zero open issues (the held typebox PR
#364 remains the only open PR).

# Menu polish U4 — tier classifier correctness (umbrella #345)

jev: medium (0.77) · C2 · worktree y — consistent (no deviation).
Worktree: `../brl-subagent-wt-menu-u4` · branch `fix/menu-u4-tier-classifier` (from `dev`; lockfiles match → symlinked prep).
Review: **C2 focused** (`project-reviewer` + `focused-review`), dispatched after implementation — classification
logic with a documented residual; the review's audit surface is the classifier contract.

## Context

The proposal's **A1** — the only finding that renders *false information*: the preset/template tier label is derived
from a filename convention that the writers do not use. `findTemplateSource`/`findPresetSource` transform the display
name with `replace(/[^a-zA-Z0-9_-]/g, "_").toLowerCase()`; the writers (`writePresetFile`/`writeTemplateFile`) emit
via `sanitizeFileName`, which does **not** collapse spaces — e.g. `My Checklist.md`. Result: a **custom template
renders `[B]`** (builtin). Proven by the proposal's probes E12/E13 (`findTemplateSource("My Checklist") => builtin`
with the real loader + a written template); the new tests re-prove it.

## Recon (Rule 13 — codegraph @ `393654a`)

```
## Recon (Rule 13 — codegraph @ 393654a)
- target: `findPresetSource`
- callers(findPresetSource):
  - 1 caller(s)
  - src/tui.ts:731 (showPresetManager)
- impact(findPresetSource, depth 2):
  - 3 affected symbols across 2 files
- grep delta: 3 raw hits for `findPresetSource` (incl. comments/strings).
```

```
## Recon (Rule 13 — codegraph @ 393654a)
- target: `findTemplateSource`
- callers(findTemplateSource):
  - 2 caller(s)
  - src/tui.ts:879 (showViewTemplate)
  - src/tui.ts:948 (showTemplateManager)
- impact(findTemplateSource, depth 2):
  - 4 affected symbols across 2 files
- grep delta: 3 raw hits for `findTemplateSource` (incl. comments/strings).
```

```
## Recon (Rule 13 — codegraph @ 393654a)
- target: `sanitizeFileName`
- callers(sanitizeFileName):
  - 3 caller(s)
  - src/presets.ts:419 (writePresetFile)
  - src/templates.ts:464 (writeTemplateFile)
  - src/templates.ts:1 (templates.ts)
- impact(sanitizeFileName, depth 2):
  - 11 affected symbols across 9 files
- grep delta: 4 raw hits for `sanitizeFileName` (incl. comments/strings).
```

**Coverage note:** the graph lists callers; the *bug* is a filename-normalization mismatch, invisible to it — the
proposal's E12/E13 probes are the evidence, and the new tests re-prove the case against the real writers. The finders
are called only from the two managers + the template detail view.

## Required behavior

1. **Both finders use the writers' normalizer.** Replace the ad-hoc `replace(...).toLowerCase()` transform in
   `findPresetSource` and `findTemplateSource` with `sanitizeFileName` (import from its module — the writers' own
   function; no edits to `presets.ts`/`templates.ts` unless strictly required, and report if so).
2. **Membership fallback.** When no file matches, decide by membership: name ∈ `state.builtinPresets` (presets) /
   `state.builtinTemplates` (templates) → `builtin`; otherwise the existing custom resolution (`project` as the
   preset fallback; the existing project→global dir order for templates).
3. **Extract the decision** as an exported **pure** `classifyTier(name, dirs, builtinNames)` (injectable directory map
   for tests); both finders call it. Signature/shape at the implementer's discretion — report it.
4. **Preserve the tier vocabulary** (`builtin` / `project` / `global`) and every other behavior; no data-shape
   change (the additive `source` field is out of scope — accepted residual).
5. **Documented residual:** a hand-written custom file that overrides a **builtin name** with a non-canonical filename
   still classifies by membership → `builtin`. This cycle accepts it (the additive `source` field would fix it);
   the test must assert the chosen behavior explicitly so the residual is a decision, not an accident.

## Evidence requirements

- **New `src/__tests__/menu-tier.test.ts`** (temp-dir pattern: `templates-files.test.ts`):
  - canonical filename → correct tier;
  - the `My Checklist` case (non-canonical, written by the real `writeTemplateFile`) → custom (`project`), **not**
    `builtin` — the A1 regression pin;
  - global-only → `global`;
  - shipped built-in name → `builtin`;
  - custom-overrides-builtin (non-canonical) → the documented residual behavior, asserted explicitly.
- The real writer round-trip (write a template via `writeTemplateFile`, then classify) — at minimum for the
  `My Checklist` case.
- `npx tsc --noEmit`; full `npx vitest run` (baseline **75 files / 1575 tests**); `git diff --check`.
- Coverage line: the 5 classifier cases + temp-dir counts enumerated.

## Review outcome (amendment at close)

Focused C2 review: **approve-with-nits**. F1 — the membership fallback was **inert in both finders** and is now
**removed** (`classifyTier` = filename match → `io.fallback`; the `builtinNames` parameter and its call-site
arguments dropped), with the docstring corrected to the real mechanism; behavior is identical. F2 — the
project-wins priority gained a same-name-in-both-tiers pin. The stale `TierClassifierIo.fallback` doc comment is
parked for U7. Merged `6811413`.

## Constraints

- `src/tui.ts` + the new test file (plus imports only). `sanitizeFileName` must remain the writers' own function —
  do not fork it. PR per the `pr` skill with **"Part of #345"**.

## Out of scope

The additive `source` field, U5/U6 manager rendering, U7 docs/toasts, the excluded surfaces.

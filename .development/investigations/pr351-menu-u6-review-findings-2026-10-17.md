# REVIEW — PR #351 (issue #345, U6) @ `dee1ffc`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — focused C2 review (2026-10-17).
Checkout: `review/menu-u6` at `a6f9ec1`; re-verified at the fix head `dee1ffc`. Spec:
`.development/investigations/menu-polish-u6-spec-2026-10-17.md`.

**Verdict: changes-requested** (at `a6f9ec1`) → fixed → merged `a9e4121`

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| major | `src/tui.ts:926,1111` | Shared `emptyManagerNotice("task templates",…)` rendered "built-in task templates"; the pre-U6 templates text was "built-in templates" — not byte-identical (spec no-drift) |
| minor | `src/tui.ts:804-820` | Empty-array `tools`/`excludeTools` now omitted; the old `if (preset.tools)` rendered a blank `Tools:` line (policy-aligned; note only) |
| nit | `src/tui.ts:735-754` | Preset rows still built inline while templates use the pure `buildTemplateMenuItems`; asymmetry left un-unified |

## Verified-OK

- **Divider:** `menuSection("Custom Presets")` (`__divider__:custom-presets`, label exactly `─── Custom Presets ───`),
  emitted only when customs exist; the browse loop re-renders on any `__divider__*`, cancel exits; no close-on-select
  path remains.
- **Empty state:** the preset manager notifies via the shared helper and never opens an empty SelectList.
- **Detail unification:** both views render through `showDetailView` with the `(built-in)`/`(project)`/`(global)` title
  suffixes and the shared footer; the unset-field policy holds (preset omits Thinking/Tools/Exclude/System prompt when
  unset and always keeps `Inherit:`; template keeps the `Task:` lead and omits Parameters/Preset/Thinking/Output
  file/Timeout when unset).
- **Behavior preservation:** builtin/custom prefix stripping preserved; the shadowed-name edge shows identical content
  with a corrected tier suffix.
- **Mutation probes:** all four failed with their pre-stated signatures (a: 2 re-render tests; b: omits-divider +
  2 empty-state; c: 5 suffix tests; d: 1 selection test); tree restored clean.

SOLID/DRY violations flagged: 1 (the inline-vs-builder asymmetry, nit)

**Coverage:** `tsc` clean · `git diff --check` clean · full `vitest run` 78 files / 1622 tests (18/18 in the new
suite). Findings banked to `/tmp/review-351-findings.md`.

## Disposition (2026-10-17)

- **Major: FIXED** in `dee1ffc` — `emptyManagerNotice(loadedNoun, builtinNoun, dir)`; templates now render
  "built-in templates" byte-identically (presets use "built-in presets"), pinned by byte-equality tests for both
  notices; suite 78/1623.
- **Minor: NO ACTION** — the omission is the chosen unset-field policy (a blank `Tools:` line was the bug).
- **Nit: NO ACTION** — a symmetric preset builder would touch the `__builtin__:`/`__custom__:` value encoding; the
  implementer flagged that as a separate refactor. Direct dev merges don't auto-close; the umbrella stays open.
- Merged `a9e4121` (CI pass).

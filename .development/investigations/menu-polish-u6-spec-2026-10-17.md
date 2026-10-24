# Menu polish U6 — Presets parity + detail unification (umbrella #345)

jev: medium (0.84) · risk **C2** · worktree y — consistent (no deviation).
Worktree: `../brl-subagent-wt-menu-u6` · branch `feat/menu-u6-presets-parity` (from `dev`, after U5).
Review: **C2 focused** (`project-reviewer` + `focused-review`, muse-spark) after implementation — selection semantics +
two detail renderers.

## Context

U5 folded the Templates manager onto the Presets shell. U6 closes the loop: the Presets manager adopts what Templates
does better (explicit empty state), the preset detail gains the tier suffix, the divider moves to the shared
`menuSection` factory, divider selection becomes a **no-op re-render** (the maintainer's decision #6), and the two
detail views adopt one unset-field policy + one field-label vocabulary.

The current preset divider is a literal (`value: "__divider__"`, label `─── Custom Presets ───`) and selecting it
**closes the manager** (`if (!result || result === "__divider__") return;`) — both differ from the U1 factory shape
(`__divider__:<slug>`) and the chosen semantics.

## Recon (Rule 13 — codegraph @ `b369d58`)

```
## Recon (Rule 13 — codegraph @ b369d58)
- target: `showPresetManager`
- callers(showPresetManager):
  - 1 caller(s)
  - src/index.ts:1 (index.ts)
- impact(showPresetManager, depth 2): 15 affected symbols across 15 files (command-wiring reach)
- grep delta: 4 raw hits for `showPresetManager` (incl. comments/strings).
```

```
## Recon (Rule 13 — codegraph @ b369d58)
- target: `showViewTemplate`
- callers(showViewTemplate):
  - 1 caller(s)
  - src/tui.ts:1009 (showTemplateManager)
- impact(showViewTemplate, depth 2): 3 affected symbols across 2 files
- grep delta: 2 raw hits for `showViewTemplate` (incl. comments/strings).
```

**Coverage note:** the divider facts are read-verified (`tui.ts` preset block: literal value + the close-on-select
return); the detail-view similarity comes from the proposal's §1.5 inventory. The preset detail rendering lives inside
`showPresetManager` (the view branch), so both views are in one module.

## Required behavior

1. **Explicit empty state in the presets manager** — mirror the Templates manager's notify shape (defensive: zero items
   to list → notify, no empty SelectList).
2. **Preset detail title** gains the `(project)` / `(global)` suffix vocabulary, mirroring the template detail's tier
   suffix.
3. **Divider via the shared factory + no-op:** replace the literal with `menuSection("Custom Presets")`; selecting a
   divider **re-renders the manager** (stays open) — restructure the list call in a bounded loop (`while (true)` around
   `showSelectList`; `continue` on `result.startsWith("__divider__")`; cancel still returns). Do not copy the
   close-on-select behavior.
4. **One unset-field policy across both detail views:** omit unset optional fields; keep `Inherit:` (a real default).
   Unify the field-label grammar (the same labels/order for shared concepts) and the tier-suffix vocabulary.
5. **No data/command/behavior changes** beyond menu presentation and within-menu selection semantics.

## Evidence requirements

- Extend/new tests (mock `ctx.ui` as in U2/U5):
  - selecting the preset divider does **not** close the manager (a second list call happens; cancel still exits);
  - the divider's value starts with `__divider__:` and its label is exactly `─── Custom Presets ───` (shared factory);
  - both detail views' titles carry the `(project)`/`(global)` suffix vocabulary;
  - the unset-field policy table holds for both renderers (omit unset; `Inherit:` retained);
  - the presets empty-state notify fires on a zero-item list.
- `npx tsc --noEmit`; full `npx vitest run` (baseline = the post-U5 count — report it); `git diff --check`.
- Coverage line: the cases + counts; report which fields each detail view omits by policy.

## Constraints

- `src/tui.ts` + tests only. No U1 token/`menuSection` contract edits; no `.development/**`.
- Commit + push; PR per the `pr` skill with **"Part of #345"**.

## Out of scope

U7 (docs + the parked toasts/doc comment); the templates manager list (U5, already merged); any data-shape change.

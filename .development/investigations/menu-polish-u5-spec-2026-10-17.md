# Menu polish U5 — Templates manager onto the Presets shell (umbrella #345)

jev: medium (0.65) · risk **C2** (conductor rerate UP from Jev's C3 — the headline unit carries partition/order/fallback
logic, not just strings) · worktree y — level unchanged (no deviation).
Worktree: `../brl-subagent-wt-menu-u5` · branch `feat/menu-u5-template-manager` (from `dev`; symlinked prep).
Review: **C2 focused** (`project-reviewer` + `focused-review`, muse-spark), dispatched after implementation — the audit
surface is the partition/ordering/fallback contract.

## Context

The headline requirement of the cycle. The **Presets manager is the reference design**; the Templates manager adopts
it. Measured delta (proposal §1.5): order is customs-first today (E11: `c1 | shared(custom) | b1 | b2`), no divider,
no tier counts in the title, a raw `task.slice(0,60)` description fallback, and the divider-selection semantics differ.
U4 already fixed the tier classifier, so customs can be labelled `[P]`/`[G]` correctly.

## Recon (Rule 13 — codegraph @ `8c7634f`)

```
## Recon (Rule 13 — codegraph @ 8c7634f)
- target: `showTemplateManager`
- callers(showTemplateManager):
  - 1 caller(s)
  - src/index.ts:1 (index.ts)
- impact(showTemplateManager, depth 2): 15 affected symbols across 15 files (the command-wiring reach)
- grep delta: 3 raw hits for `showTemplateManager` (incl. comments/strings).
```

```
## Recon (Rule 13 — codegraph @ 8c7634f)
- target: `formatPresetSummary`
- callers(formatPresetSummary):
  - 2 caller(s)
  - src/tui.ts:731 (showPresetManager)
  - src/tui.ts:1 (tui.ts)
- impact(formatPresetSummary, depth 2): 7 affected symbols across 6 files
- grep delta: 4 raw hits for `formatPresetSummary` (incl. comments/strings).
```

```
## Recon (Rule 13 — codegraph @ 8c7634f)
- target: `getAllTemplates`
- callers(getAllTemplates):
  - 2 caller(s)
  - src/__tests__/templates-files.test.ts:1
  - src/templates.ts:377 (loadAllTemplates)
- grep delta: 12 raw hits for `getAllTemplates` (incl. comments/strings).
```

**Coverage note:** the graph lists callers, not list order — the order/partition facts come from the proposal's E11
runtime probe and will be re-pinned by the new tests. `showTemplateManager` is reached only from the command wiring.

## Required behavior

1. **Partition + order** (`showTemplateManager`): built-ins first (shipped order), then — **only when customs
   exist** — a divider row `─── Custom Templates ───`, then customs (current order). Partition by **membership in
   `state.builtinTemplates`** (the name is the identity; do not re-derive from filenames). Prefixes: built-ins `[B]`;
   customs `[P]`/`[G]` via the U4-fixed `findTemplateSource`.
2. **Title:** `Templates (N built-in, M custom)` with counts matching the partitions.
3. **Descriptions:** `t.description || formatTemplateSummary(t)` where the summary is `preset · thinking · slots
   <a>, <b>` (omit absent parts; last resort `t.task.slice(0, 60)`). Add an exported pure `formatTemplateSummary`
   (prefer `tui-format.ts` — it may import `./types` only; no new module).
4. **Testability seam:** extract/expose a pure `buildTemplateMenuItems(templates, sourceOf)` (injectable tier lookup,
   mirroring U4's pattern) returning the `SelectItem[]` (with the divider), so order/partition/counts are testable
   without a TUI.
5. **Empty state:** keep the explicit notify (no templates at all); the builder returns `[]` in that case.
6. **Divider selection = no-op re-render** (the maintainer's decision #6, applied to the new divider from the start —
   do not copy the presets manager's close-on-select).
7. **Parent config row:** verify it already renders the same counts via `formatMenuValue("templateCounts", …)` (U2);
   if already correct, no change — report the check.

## Evidence requirements

- New `src/__tests__/menu-template-items.test.ts`:
  - **order**: `[builtin…, divider, custom…]`; divider **absent** when no customs; built-ins keep shipped order;
  - **prefixes**: `[B]` vs `[P]`/`[G]` (injected `sourceOf`);
  - **title counts** match the partitions (and the parent row's counts match);
  - **description fallback** table: declared description wins; summary shown otherwise (`preset · thinking · slots`);
    last-resort slice;
  - **empty state**: builder returns `[]`; the manager's notify path (mock `ctx.ui`, as in U2's prompt tests).
- `npx tsc --noEmit`; full `npx vitest run` (baseline **76 files / 1584 tests**); `git diff --check`.
- Coverage line: the cases + counts; report the parent-row check result.

## Constraints

- `src/tui.ts` (+ `src/tui-format.ts` for the summary formatter only) + the new test file. No `menuSection`/token
  contract edits (U1 frozen); no `.development/**`.
- Commit + push; PR per the `pr` skill with **"Part of #345"**.

## Out of scope

U6 (presets parity/detail unification), U7 (docs + the parked toasts/comment), any data-shape change (the additive
`source` field).

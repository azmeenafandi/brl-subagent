# Menu polish U3 — divider grouping + header cleanup + viewport (umbrella #345)

jev: low (0.53) · C3 · worktree y — consistent (no deviation; artifact clamp satisfied).
Worktree: `../brl-subagent-wt-menu-u3` · branch `feat/menu-u3-grouping-header` (from `dev`; lockfiles match → symlinked prep).
Review: **C3** — conductor diff read + the extended pins (display-only; the divider no-op rests on the existing
`if (result in actions)` dispatch, verified by reading).

## Context

U1 (vocabulary + divider factory) and U2 (rows/titles/prompts adoption) are merged. U3 groups the config menu and
cleans the screen. **User-approved decisions:** the duplicated header is **deleted**; the viewport rises **10 → 15**.

## Recon (Rule 13 — codegraph @ `b1c67ab`)

```
## Recon (Rule 13 — codegraph @ b1c67ab)
- target: `showConfigMenu`
- callers(showConfigMenu):
  - 1 caller(s)
  - src/index.ts:1 (index.ts)
- impact(showConfigMenu, depth 2):
  - 15 affected symbols across 15 files
  - files: src/tui.ts, src/index.ts, src/__tests__/agent-guidance.test.ts, … (command-wiring reach)
- grep delta: 3 raw hits for `showConfigMenu` (incl. comments/strings).
```

```
## Recon (Rule 13 — codegraph @ b1c67ab)
- target: `menuSection`
- callers(menuSection):
  - 1 caller(s)
  - src/__tests__/tui-format.test.ts:1 (tui-format.test.ts)
- impact(menuSection, depth 2):
  - 2 affected symbols across 2 files (src/tui-format.ts, its test)
- grep delta: 12 raw hits for `menuSection` (incl. comments/strings).
```

**Coverage note:** `showConfigMenu` has exactly one caller (the `/brl-subagent` command wiring in `index.ts`); the
depth-2 impact list is the command's test reach, not a behavior consumer. `menuSection` currently has only the U1
test as a caller — **U3 is its first production consumer**. The divider no-op is a *read* fact: `showConfigMenu`'s
dispatch is `if (result in actions)`; the actions map's keys are the 17 handler values, and divider values carry the
`__divider__:` prefix, so a divider selects into the loop again (re-render) — **no dispatch code change**.

## Required behavior

### 1. Grouping (`getConfigMenuItems`)

Insert `menuSection("Run Activity")` immediately before the `history` row and `menuSection("Presets & Templates")`
immediately before the `preset` row; move the `reset` row to **after** `templates` (still before the caller-appended
`Done`). Resulting order:

```
[model, thinking, concurrency, depth, approval, completionnotify, recovery, historyentries, costlimit, sla]
─── Run Activity ───
[history, monitor, dashboard, retry]
─── Presets & Templates ───
[preset, templates]
reset
(Done — appended by showConfigMenu)
```

Every handler `value` string is unchanged, and the relative order **within** each section is unchanged.

**Amendment at close:** the original block omitted `sla` (a brief error — a `Set …` row belongs in the settings
group). The merged order places it immediately after `costlimit`; the 15-row viewport pin was adjusted accordingly (the
`Presets & Templates` divider sits just below the fold).

### 2. Header cleanup (`showConfigMenu`)

Delete the duplicated 4-line summary block (`Model:`, `Max Thinking:`, `Max parallel:`, conditional `Cost limit:`)
and its trailing blank line. Keep the title (`brl-subagent Configuration`) and the bordered shell. Remove the
now-unused `formatModel` import **only if** the compiler confirms no other `tui.ts` use (recon: the header was its
only site; the util stays exported and tested in `tui-format.test.ts`).

### 3. Viewport

`Math.min(items.length, 10)` → `Math.min(items.length, 15)`. Extract the cap as an exported constant
(`CONFIG_MENU_VIEWPORT = 15`) so the pin can assert the number without a full UI harness.

### 4. No behavior changes

Same 17 handler values/actions/keys; divider selection never dispatches; `Done` unchanged.

## Evidence requirements

Extend `src/__tests__/menu-config-items.test.ts`:

- **Value-set pin:** filter out `__divider__` entries → the pinned 17 values, order-preserving (the existing 3-state
  pin keeps passing).
- **Divider invariants:** exactly **2** dividers; each `value.startsWith("__divider__:")`; label matches
  `/^─── .+ ───$/`; `description === ""`; labels exactly `Run Activity` / `Presets & Templates`; **positions** (the
  first divider immediately before `history`; the second immediately before `preset`; `reset` after `templates`).
- **No dispatch:** every divider value is absent from the 17-value handler set (report the exact assertion).
- **Render structure:** render the real list at widths **60 / 80 / 120** and assert no rendered line exceeds the
  width (report the harness used — reuse the U2 selector-render pattern or a `SelectList` instance).
- **Viewport:** assert `CONFIG_MENU_VIEWPORT === 15` and that the list is built with `Math.min(items.length, 15)`.
- `npx tsc --noEmit`; full `npx vitest run` (baseline **75 files / 1569 tests**); `git diff --check`.
- Coverage line: 17 values + 2 dividers + 3 render widths enumerated with counts.

## Constraints

- `src/tui.ts` + `src/__tests__/menu-config-items.test.ts` only. **No `tui-format.ts` edits** (frozen); no
  `.development/**` edits.
- Commit + push; PR per the `pr` skill with **"Part of #345"**.

## Out of scope

U4 (tier classifier), U5/U6 (managers), U7 (docs + the two legacy confirmation toasts parked there), the excluded
surfaces.

# Menu polish U2 — config rows + sub-screen titles (umbrella #345)

jev: medium (0.47) · C3 · worktree y — consistent (no deviation; the C1 low-confidence carve-out does not apply).
Worktree: `../brl-subagent-wt-menu-u2` · branch `feat/menu-u2-rows-titles` (from `dev`; lockfiles match → symlinked prep).
Review: **C3** — conductor diff read + the new pins (display-only; the two formatter bodies are menu-only: `formatModel`
has 1 `tui.ts` site — the header deleted in U3; `formatMaxParallel` has 4, all in `tui.ts`).

## Context

U1 merged (PR #346): `MENU_VALUE_TOKENS`, `formatMenuValue`, `formatUnset`, `menuSection` live in `tui-format.ts`.
U2 **adopts** them: labels onto one verb grammar, descriptions onto the canonical tokens, the two shared formatter
canonicalizations, verb-led titles, one `(current)` marker syntax, and canonical input prompts. **Presentation-only** —
no behavior, keys, actions, or row `value` strings change.

## Recon (Rule 13 — codegraph @ `3bead2c`)

```
## Recon (Rule 13 — codegraph @ 3bead2c)
- target: `getConfigMenuItems`
- callers(getConfigMenuItems):
  - 1 caller(s)
  - src/tui.ts:1040 (showConfigMenu)
- impact(getConfigMenuItems, depth 2):
  - 3 affected symbols across 2 files
  - files: src/tui.ts, src/index.ts
- grep delta: 2 raw hits for `getConfigMenuItems` (incl. comments/strings).
```

```
## Recon (Rule 13 — codegraph @ 3bead2c)
- target: `formatModel`
- callers(formatModel):
  - 4 caller(s)
  - src/__tests__/tui-format.test.ts:1 (tui-format.test.ts)
  - src/__tests__/types.test.ts:1 (types.test.ts)
  - src/tui.ts:1040 (showConfigMenu)
  - src/tui.ts:1 (tui.ts)
- impact(formatModel, depth 2):
  - 7 affected symbols across 6 files
- grep delta: 13 raw hits for `formatModel` (incl. comments/strings).
```

**Coverage note:** the graph lists callers, not strings. The 17-row corpus was enumerated at runtime by the proposal
(E2, `getConfigMenuItems` full array) and will be **re-pinned by the new tests** (value-set + label grammar below).
The only current-marker site today is the thinking selector (`(current - ceiling)`, `tui.ts:168`) — the other five
choice lists have none. `formatMaxParallel` callers (5, all `tui.ts` + one test pin) were recon'd in the U1 spec.

## Required behavior

### 1. Labels (17) — verb-led, each ≤ 30 visible chars

| value | new label |
|---|---|
| `model` | `Set Model` |
| `thinking` | `Set Max Thinking Level` |
| `concurrency` | `Set Max Parallel Subagents` |
| `depth` | `Set Max Recursion Depth` |
| `approval` | `Set Change Approval Mode` |
| `completionnotify` | `Set Completion Notify Mode` |
| `recovery` | `Set Recovery Posture` |
| `historyentries` | `Set Max History Entries` |
| `costlimit` | `Set Session Cost Limit` |
| `reset` | `Reset Configuration` |
| `history` | `View Run History` |
| `monitor` | `View Live Monitor` |
| `dashboard` | `View Observability Dashboard` |
| `preset` | `Browse Presets` |
| `templates` | `Browse Templates` |
| `retry` | `Retry Failed Run` |
| `sla` | `Set SLA Tracking` |

### 2. Descriptions

- **Setting rows** (model, thinking, concurrency, depth, approval, completionnotify, recovery, historyentries,
  costlimit, sla) → `formatMenuValue(<kind>, <structural input from state>)` — no hand-rolled prose.
- **Count rows:** preset → `formatMenuValue("presetCounts", { builtinCount: state.builtinPresets.length,
  customCount: state.customPresets.length })`; templates → `formatMenuValue("templateCounts", { builtinCount:
  state.builtinTemplates.length, customCount: <custom templates count> })` (use the same partition the manager uses;
  report the exact expression).
- **Navigation rows** (history, monitor, dashboard, retry) keep their existing action descriptions (they describe an
  action, not a value). `reset` keeps `Clear subagent configuration`.

### 3. Formatter canonicalizations (in `src/types.ts`)

- `formatModel(undefined)` → `Not set` (drop the `will use main agent…` sentence — also on the banned list).
- `formatMaxParallel(0)` → `Unlimited` (was `unlimited`); update `src/__tests__/types.test.ts` (`toBe("unlimited")` →
  `toBe("Unlimited")`; the other assertion is `toContain("Not set")` and survives).

### 4. Titles (6 choice/config screens) — verb-led

- `Select Subagent Model` (unchanged) · `Select Max Thinking Level` (unchanged) · `Select Change Approval Mode`
  (unchanged) · `Select Completion Notify Mode` (was `Completion Notify Mode`) · `Select Recovery Posture` (was
  `Recovery Posture`) · `Configure SLA Tracking` (was `SLA Tracking`, the two-step enable→window flow).

### 5. One `(current)` marker syntax

Every in-scope choice list marks the item whose value equals the current setting with the suffix ` (current)` on its
label: model (current `provider/id`), thinking (**replace** `(current - ceiling)`), approval (`auto`/`writes`/
`always`), completionnotify, recovery, SLA enable (`Enabled`/`Disabled`). Exactly one marker per list when a current
value exists; no marker when it does not.

### 6. Input prompts (5) — one separator, canonical current token

Shape: `… (<hints> · current: <token>)` — hints keep their content; the current value uses `formatMenuValue` (or the
raw number where the token is a number, e.g. the SLA window):
`showConcurrencyInput`, `showDepthInput`, `showHistoryEntriesInput`, `showCostLimitInput`, `showSLAConfig` (window
prompt). No lowercase `unlimited` remains in any in-scope prompt.

### 7. No behavior changes

Same `value` strings, actions, keys, and row order. **No** dividers/header/viewport (U3), **no** manager changes
(U5/U6).

## Evidence requirements

- **New `src/__tests__/menu-config-items.test.ts`:**
  - **value-set pin:** `getConfigMenuItems(state).map(i => i.value)` deep-equals the pinned 17-element array, across
    **3 fixture states** (defaults / fully configured / zero-unlimited). Report how the state fixture is built (a
    structural fake vs the real constructor — use whichever existing tests already do).
  - **label grammar:** every label matches `/^(Set|View|Browse|Retry|Reset) [A-Z]/` and visible length ≤ 30.
  - **value adoption:** table-driven — descriptions equal the expected token for each state.
  - **negative list:** no `will use main agent`, `no pruning`, `passive delivery`, `No delegation from subagents`,
    `None saved`, or lowercase `unlimited` in any in-scope description/prompt.
- `types.test.ts` updated; `npx tsc --noEmit`; full `npx vitest run` (baseline **74 files / 1536 tests** — U1 added
  27); `git diff --check`.
- Coverage line: the label/title/prompt/marker sites enumerated with counts, plus the grep proving zero legacy
  phrases.

## Constraints

- `src/tui.ts`, `src/types.ts`, `src/__tests__/types.test.ts`, and the new test file only. **No `tui-format.ts` edits**
  (the U1 contract is frozen); no `.development/**` edits.
- Commit + push; PR body per the `pr` skill with **"Part of #345"**.

## Out of scope

U3 (dividers/header/viewport), U4 (tier classifier), U5/U6 (managers), the SLA enable-before-window behaviour quirk
(documented in the proposal, separate cycle), and the excluded surfaces (history/monitor/dashboard/retry tool
rendering).

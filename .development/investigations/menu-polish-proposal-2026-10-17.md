# Proposal — presentation-only polish of the `/brl-subagent` config menu tree

- **Status:** decision-ready proposal (no code written, no repo files modified).
- **Scope (as briefed):** `getConfigMenuItems` + `showConfigMenu`, and the sub-screens they open:
  `showModelSelector`, `showThinkingSelector`, `showConcurrencyInput`, `showDepthInput`,
  `showHistoryEntriesInput`, `showCostLimitInput`, `showApprovalModeSelector`,
  `showCompletionNotifySelector`, `showRecoverySelector`, `showPresetManager`,
  `showTemplateManager`, `showSLAConfig`.
- **Explicitly excluded (not analysed for change):** run history, live monitor, dashboard, retry
  menu, tool-call rendering (`renderDelegateCall` / `renderDelegateResult`), and
  `showComplianceMenu` / `showSLAStats` (no config-menu rows).
- **Constraint taken as law:** same actions, same keys, same data, same behaviour. Labels, value
  formatting, ordering, dividers, titles, header content, empty states, descriptions, footers only.
- **Code authority:** all line numbers are `src/tui.ts` unless stated otherwise, at commit `734d63e`
  (branch `dev`, working tree clean at investigation start).

---

## 0. Method and coverage (how the inventory was produced)

| Step | Command / probe | Observed | Reconciliation |
|---|---|---|---|
| Function enumeration | TS-AST walk of `src/tui.ts` via `scripts/ts-ast.mjs` (`/tmp/menu-probe/enum4.mjs`) | **191** function-like nodes; **12** `showSelectList(...)` calls; **29** `SelectItem` object literals carrying `value`+`label`+`description` | 8 of the 12 select calls are in scope (model 149, thinking 171, approval 309, notify 336, recovery 362, SLA 383, preset 701, template 912); 4 are excluded (compliance 652, history 1176, retry 2077, 2084) |
| Config rows | same AST walk, `getConfigMenuItems` | **17** items, exact order captured | matches the 17 `handlers` keys it routes to; 2 handler-only keys (`sla-stats`, `compliance`) have no row |
| Item-label census | `grep -c "label:" src/tui.ts` | **42** `label:` occurrences total (in- and out-of-scope) | 29 full literals + 2 mapped builders (model, thinking) = 31 in-scope label sites |
| Real item values | `npx jiti /tmp/menu-probe/import-tui.ts` (imports `../src/tui.ts`, fake `SessionState`, prints `getConfigMenuItems`) | 17 rows printed verbatim; `templates=Manage Templates :: 9 saved` while all 9 are built-ins | proves the row builder is importable and unit-testable outside a TUI harness |
| Input screens | `grep -n "ctx.ui.input(" src/tui.ts` | **5** sites (190, 210, 237, 266, 395) | none passes the optional `placeholder` arg (`input(title, placeholder?, opts?)`, pi-coding-agent `dist/core/extensions/types.d.ts:78`) |
| SelectList geometry | `/tmp/menu-probe/width.mjs`, `/tmp/menu-probe/trunc.mjs` | label column is **fixed at 32 chars ⇒ 30 visible label chars max**, then descriptions start; description budget = `width - 34` | 45-char label truncates at 30; model row's 50-char description truncates at width 80 (`…by defa`) |
| Baseline health | `npm run typecheck`; `npx vitest run` on 8 menu-adjacent suites; `npx vitest run src/__tests__/streaming-sentinel.test.ts` | typecheck clean; **142/142** pass in 8 files; **7/7** pass in the one suite that already imports `../tui` | verification harness for this cycle exists today |

---

## 1. Inventory of in-scope surfaces

### 1.1 Shared list shell (`showSelectList`, L90–125)

```
border (accent)
title (accent bold, padX 1)
SelectList(items, min(items.length, maxItems))
NAV_FOOTER ("↑↓ navigate • enter select • esc cancel", dim, padX 1)   // types.ts:664
border (accent)
```
No subtitle, no section support, no empty-state parameter. Every in-scope list except the config
menu goes through it.

### 1.2 `getConfigMenuItems` (L927–1038) — 17 rows, exact order and values

| # | value (key — must not change) | label | description (rendered value) | off/unset wording |
|---|---|---|---|---|
| 1 | `model` | Select Model | `provider/id` or `Not set (will use main agent’s model by default)` | prose + curly apostrophe |
| 2 | `thinking` | Select Max Thinking Level | bare level (`off`…`xhigh`) | n/a |
| 3 | `concurrency` | Set Max Parallel Subagents | `formatMaxParallel` → `unlimited` / `3` | lowercase `unlimited` |
| 4 | `depth` | Set Max Recursion Depth | `No delegation from subagents` / `Subagents can delegate up to N level(s) deep` | prose |
| 5 | `approval` | Set Change Approval Mode | `Never ask` / `Ask when files changed` / `Ask every time` | — |
| 6 | `completionnotify` | Set Completion Notify Mode | `Wake on every terminal state` / `Wake only on failed/stopped` / `Never wake (passive delivery)` | prose |
| 7 | `recovery` | Set Recovery Posture | `Surface interrupted runs (default)` / `Do not surface interrupted runs` | prose |
| 8 | `historyentries` | Set Max History Entries | `Unlimited (no pruning)` / `N entries kept` | prose |
| 9 | `costlimit` | Set Session Cost Limit | `Unlimited` / `$N.NN` | single word |
| 10 | `reset` | Reset to Default | `Clear subagent configuration` | — |
| 11 | `history` | View Run History | `Browse past subagent runs` | — |
| 12 | `monitor` | Live Monitor | `Watch running subagents in real-time` | — |
| 13 | `dashboard` | Observability Dashboard | `Real-time metrics, SLA, errors, and cost trends` | — |
| 14 | `preset` | Manage Presets | `N built-in, M custom` | — |
| 15 | `templates` | Manage Templates | `None saved` / `N saved` | prose-ish count |
| 16 | `retry` | Retry Failed Run | `Select a failed subagent to retry` | — |
| 17 | `sla` | SLA Tracking | `Enabled (window: N)` / `Disabled` | single word |

**Row composition:** 9 settings, 1 destructive (`reset`), 4 run-activity actions, 2 managers,
1 more action (`retry` is activity; `sla` is a setting rendered *after* `sla-stats`-less actions).
Seven distinct label shapes: `Select …` ×2, `Set …` ×7, `Reset …` ×1, `View …` ×1, bare noun ×3
(`Live Monitor`, `Observability Dashboard`, `SLA Tracking`), `Manage …` ×2, imperative `Retry …` ×1.

**`reset` placement:** index 9 of 17 — it is the *last setting*, immediately before the action
block. The brief's "Reset sits mid-list" is directionally right but the position is meaningful
(settings↔actions boundary) and is currently unlabelled. There is no divider of any kind.

### 1.3 `showConfigMenu` (L1040–1133) — the screen

- Title: `brl-subagent Configuration` (L1060).
- **Header block, L1063–1089 — four dim lines that duplicate four rows:**

| header line | duplicates row | divergence |
|---|---|---|
| `Model: ${formatModel(...)}` | row 1 | fallback differs: `Not set (will use main agent’s model)` vs `… by default)` |
| `Max Thinking: ${level}` | row 2 | exact duplicate, different label (`Max Thinking` vs `Select Max Thinking Level`) |
| `Max parallel: ${formatMaxParallel(...)}` | row 3 | exact duplicate |
| `Cost limit: $N.NN` | row 9 | **conditionally present** (`if sessionCostLimit > 0`), while row 9 always renders (`Unlimited`) |

  The header omits depth, approval, completionnotify, recovery, historyentries, sla — 4 of 9
  settings duplicated, 5 omitted, plus a variable line count.
- Viewport: `Math.min(items.length, 10)` with 17+Done = **18 items ⇒ 10 visible rows** (L1093).
  With the header, the screen is ~18–19 terminal lines.
- Footer: `NAV_FOOTER` says `esc cancel`, but Esc and `Done` both close the menu (L1120–1122) —
  "cancel" is inaccurate; nothing is cancelled.
- Loop: items are rebuilt on every iteration (L1046–1047), so a pure `getConfigMenuItems(state)`
  keeps the parent menu live after a sub-screen mutates state. Any new formatter must stay pure.
- Dispatch: `if (result in actions)` (L1126). A divider value is **not** in `actions`, so selecting
  one merely re-renders the menu — a free no-op.

### 1.4 Sub-screens — title, item shape, prefixes, empty state, footer

| Surface | Screen title | Item shape | Prefix/current marker | Empty state | Footer |
|---|---|---|---|---|---|
| `showModelSelector` L128 | `Select Subagent Model` (max 15) | label = `provider/id`; desc = `model.name ?? context: NK` | none | notify: "No models available. Configure API keys first…" (L133–139) | NAV_FOOTER |
| `showThinkingSelector` L161 | `Select Max Thinking Level` (max 10) | label = level; no desc | `(current - ceiling)` suffix on the current level (L168) | n/a (static list) | NAV_FOOTER |
| `showConcurrencyInput` L185 | *none* — prompt sentence `Max parallel subagents (0 = unlimited, current X):` | free text input | `current X` inline | library input | library |
| `showDepthInput` L205 | *none* — `Max subagent recursion depth (0 = cannot delegate, 1 = one level, current N):` | input | inline | library | library |
| `showHistoryEntriesInput` L228 | *none* — `Max run history entries (0 = unlimited, default 500, current unlimited|N):` | input | inline | library | library |
| `showCostLimitInput` L257 | *none* — `Session cost limit in USD (0 = unlimited, e.g. 1.00 for $1, current 0 (unlimited)):` | input | inline | library | library |
| `showApprovalModeSelector` L286 | `Select Change Approval Mode` (max 5) | label = bare mode (`auto`/`writes`/`always`); desc = sentence, one carries ` - default` | none | none | NAV_FOOTER |
| `showCompletionNotifySelector` L320 | `Completion Notify Mode` (max 5) | label = bare mode (`all`/`failed`/`off`); desc = sentence, one carries ` - default` | none | none | NAV_FOOTER |
| `showRecoverySelector` L347 | `Recovery Posture` (max 5) | label = bare mode (`offer`/`off`); desc = sentence | none | none | NAV_FOOTER |
| `showSLAConfig` L373 | step 1 `SLA Tracking` (max 5), then input `Window size (10-500, current N):` | label = `Disabled`/`Enabled`; desc = sentence | none | none | NAV_FOOTER / library |
| `showPresetManager` L670 | `Presets (N built-in, M custom)` (max 15) | label `[B|P|G] name`; desc = `description || formatPresetSummary` | tier prefix | **none** — falls through to SelectList's "No matching commands" | NAV_FOOTER |
| `showTemplateManager` L887 | `Templates (N)` (max 15) | label `[B|P|G] name`; desc = `description || task.slice(0,60)` | tier prefix | notify prose (3 sentences, paths) | NAV_FOOTER |
| Preset detail L721–770 | `Preset: name` + dim `(built-in)` only when builtin | `Thinking:` always (`(not set)` fallback), `Inherit:` always, Tools/Exclude/System prompt if set | tier suffix builtin-only | — | `Press any key to close` |
| Template detail L818–885 | `Template: name` + `(built-in|project|global)` | `Task:` always, Parameters/Preset/Thinking/Output file/Timeout if set | tier suffix for all three tiers | — | `Press any key to close` |

### 1.5 The Presets↔Templates delta (headline requirement, measured)

The brief's premise is partly **already true**: Templates *has* the `[B]`/`[P]`/`[G]` prefixes
(L901–907) and a matching detail view. The real delta is:

| # | Dimension | Presets (reference) | Templates | Delta |
|---|---|---|---|---|
| D1 | Section grouping | builtins → divider `─── Custom Presets ───` (only when customs exist) → customs (L687–699) | flat list, no divider (L902–910) | **missing** |
| D2 | Row order | builtins first, then customs | `state.config.templates` = **customs first, then builtins** (`getAllTemplates`, templates.ts:357–363; probe output `My Checklist \| analyze-data \| code-review`) | **inverted** |
| D3 | Title | `Presets (N built-in, M custom)` | `Templates (N)` | no tier breakdown |
| D4 | Parent-row value | `N built-in, M custom` | `N saved` (counts built-ins the user never saved) | two adjacent rows disagree |
| D5 | Description fallback | `p.description \|\| formatPresetSummary(p)` (config summary) | `t.description \|\| t.task.slice(0, 60)` (raw prose, mid-word cut) | different grammar |
| D6 | Empty state | *none* → SelectList "No matching commands" | explicit notify with remedy text | reference has **no** empty state |
| D7 | Detail tier label | `(built-in)` only; project vs global indistinguishable | `(built-in)` / `(project)` / `(global)` | templates **ahead** of reference |
| D8 | Unset-field policy | `Thinking:` always + `(not set)` | omit when unset | inconsistent |
| D9 | Divider selection | selecting the divider **closes the manager** (`if (!result \|\| result === "__divider__") return;`, L707) | n/a | reference behaviour is a surprise |
| D10 | Value encoding | `__builtin__:name` / `__custom__:name` (tier in value) | bare `name` | Templates cannot derive tier from `value`; calls `findTemplateSource` again in the detail view (L828) |

**D0 — a correctness defect found while measuring D7/D10 (not in the brief):** tier labelling is
wrong for any custom file whose **filename does not equal the sanitized item name**.

- `findTemplateSource` (L793–805) probes `name.replace(/[^a-zA-Z0-9_-]/g,"_").toLowerCase() + ".md"`
  and **falls back to `"builtin"`**.
- `sanitizeFileName` (presets.ts:376) only replaces `/ \ : * ? " < > |` — it keeps spaces and case.
- `writeTemplateFile` writes `sanitizeFileName(name) + ".md"` (templates.ts:466).

Probe (`/tmp/menu-probe/tier.ts`, real `loadAllTemplates` over a temp project dir):

```
loaded: 10 first three: My Checklist | analyze-data | code-review
custom template present: true
findTemplateSource('My Checklist') => builtin          <-- expected "project"
sanitizeFileName('My Checklist') => "My Checklist"     <-- the on-disk name
lookup key findTemplateSource builds => "my_checklist.md"
```

So a **custom** template — including one the extension itself wrote
(`/tmp/menu-probe/written/My Checklist.md`) — renders as `[B]`. `findPresetSource` (L777–786) has
the same lookup bug but a safer fallback (`"project"`), so a global preset can render `[P]`.

### 1.6 Built-in corpus (why the fallbacks rarely show)

`templates/*.md` = **9** files, **9/9** declare `description:`; `presets/*.md` = **9/9** declare
`description:`. Consequence: D5's raw-task fallback only fires for *custom* templates without a
description, and the templates empty state is unreachable unless the shipped directory is missing
(`state.config.templates` is reloaded with the full stack on `session_start` (index.ts:4145) and on
reset (index.ts:233), so it is ≥9 in any healthy install).

---

## 2. Inconsistency catalogue (severity-ranked)

Seventeen findings across six classes. **Critical: 0 · High: 3 · Medium: 8 · Low: 6.**

### Class A — Rendering that is wrong or lossy

**A1 [High] Tier prefix can be factually wrong.** `[B]` is applied to custom templates whose
filename is not `sanitize(name).toLowerCase()`, including files the extension itself wrote
(evidence in §1.5/D0). Presets share the lookup bug with a different fallback (`[P]` for a global).
This is the only finding that renders *false* information rather than awkward information.

**A2 [High] Long values truncate silently at ordinary widths.** The label column is fixed at 32
(SelectList `DEFAULT_PRIMARY_COLUMN_WIDTH`), so descriptions get `width - 34` visible chars.
Probe: the model row's 50-char `Not set (will use main agent’s model by default)` renders
`Not set (will use main agent’s model by defa` at 80 cols and `Not set (will use main a` at 60
(`/tmp/menu-probe/trunc.mjs`). Any value that is a prose sentence is a lossy value.

### Class B — Value grammar sprawl

**B1 [High] One value grammar per row.** Across the 9 setting rows: identifier form, bare enum,
lowercase word, prose sentence, `N entries kept`, `$N.NN`, `N built-in, M custom`, `Enabled
(window: N)`, and prose-with-default. The same "off/unset" semantic is rendered in **≥8 distinct
wordings** — `Not set (…model by default)`, `Not set (…model)` (header), `No delegation from
subagents`, `Unlimited (no pruning)`, `Unlimited`, `unlimited`, `Never wake (passive delivery)`,
`Do not surface interrupted runs`, `Disabled` — plus a 9th in the notify selector (`Never wake
(still delivered passively at the next user prompt)`) and 3 casings (`Unlimited`/`unlimited`).
The brief said "at least six"; reality is ≥8 across 9 slots.

**B2 [Medium] Sibling rows disagree about the same store.** `preset` renders
`N built-in, M custom`; `templates` renders `N saved` — and in a healthy install all 9 "saved"
templates are built-ins (probe output: `Manage Templates :: 9 saved`).

**B3 [Low] Cost/limit prompts disagree with themselves.** `Session cost limit in USD … current 0
(unlimited)):` (double close paren, L260–266) vs `Unlimited` in the row; `in USD` vs `$`; history
says `current unlimited` while cost says `current 0 (unlimited)`; depth prints a bare number.

**B4 [Low] Default/current markers: three syntaxes, one screen.** `(default)` in the recovery row,
` - default` in the approval/notify selector descriptions, `(current - ceiling)` in the thinking
selector. "Current" is indicated in exactly **1 of 6** selectors (thinking only).

### Class C — Screen shell and header

**C1 [Medium] The header duplicates 4 of 9 setting values, with a divergent fallback.** §1.3 table.
`Max Thinking:` and `Max parallel:` are byte-for-byte duplicates of their row descriptions; `Model:`
uses `formatModel` while the row inlines the same expression with a *different* unset sentence;
`Cost limit:` appears only when `> 0` while the row always appears. The header costs 4–5 lines of a
~19-line screen and omits 5 of the 9 settings, so it reads as "the important ones" without a rule.

**C2 [Medium] 4 of 9 settings open a bare text prompt.** `showConcurrencyInput`,
`showDepthInput`, `showHistoryEntriesInput`, `showCostLimitInput` (and SLA's step 2) have no title
line, no bordered shell, no description, no footer — the entire UI is one prose sentence with the
instructions parenthesised into it. The other 5 open a bordered list. `input(title, placeholder?,
opts?)` supports a placeholder (pi-coding-agent `dist/core/extensions/types.d.ts:78`); **0 of 5**
in-scope sites use it (bounded claim: the placeholder's rendering was not verified in a TUI harness).

**C3 [Low] Footer vocabulary.** Lists: `↑↓ navigate • enter select • esc cancel`; detail views:
`Press any key to close`; inputs: library-owned. In the config menu `esc` does not "cancel"
anything — it closes (same effect as `Done`).

**C4 [Low] Empty states: three treatments.** Templates: a 3-sentence notify with filesystem paths.
Presets: no guard — SelectList renders `No matching commands` (probed, `/tmp/menu-probe/selectlist.mjs`).
Config menu: never empty. (Practically unreachable today, §1.6.)

### Class D — Labels and titles

**D1 [Medium] Seven label shapes in one list.** `Select …` ×2, `Set …` ×7, `Reset …`, `View …`,
bare noun ×3, `Manage …` ×2, imperative `Retry …`. The mix makes row type (setting vs action vs
manager) unreadable from the label.

**D2 [Medium] Row and screen titles disagree in 4 of 6 selectors.** Row `Set Change Approval Mode`
opens `Select Change Approval Mode`; row `Set Completion Notify Mode` opens `Completion Notify
Mode`; row `Set Recovery Posture` opens `Recovery Posture`; row `Select Model` opens `Select
Subagent Model`. Screen titles split 3 `Select X` vs 5 noun-only.

**D3 [Low] `Manage` on two read-only screens.** Both managers only browse and show a detail view
(no create/edit/delete path in L670–775 or L887–921). `README.md:282` already says templates
"browses only".

### Class E — Ordering and grouping

**E1 [Medium] No grouping in a 10-row viewport.** 17 rows + `Done` = 18 items, viewport 10, no
divider. Settings (1–9), destructive (10), activity (11–13), managers (14–15), activity again (16),
setting again (17). The Presets manager proves the divider pattern in this exact component; the
config menu doesn't use it.

**E2 [Low] The reference divider is selectable and closes the manager.** `→ ─── Custom Presets ───`
is a normal row; Enter hits L707 and returns, closing the screen. In the config menu the same row
shape would merely re-render (`result in actions` is false) — i.e. the two screens would behave
differently for the same visual affordance unless unified.

### Class F — Presets↔Templates parity (the headline requirement)

**F1 [Medium] Six of ten measured dimensions differ.** No divider (D1), inverted order (D2), title
without tier counts (D3), parent-row value disagreeing with its sibling (D4), different description
fallback grammar (D5), and the *reference* has no empty state while Templates has one (D6). Note
the direction of D6/D7: "adopt the Presets pattern" must not copy the Presets manager's missing
empty state or its builtin-only tier suffix.

**F2 [Medium] Detail-view asymmetry.** Presets show a tier suffix only for built-ins; Templates show
it for all three tiers. Presets always render `Thinking: (not set)`; Templates omit unset optional
fields. Two detail screens that read as one family apply two policies.

---

## 3. Options

All options obey the hard constraint. None changes `value` strings of the 17 handler rows, adds or
removes rows, changes keybindings, or restructures navigation.

### Option A — Minimal normalization (labels + values + titles)

**Mechanism**
- Add one pure value formatter family (`formatMenuValue(kind, config)` → canonical tokens:
  `Not set` / `Unlimited` / `Off` / `N levels` / `Every run` / `Failed only` / `Ask on writes` /
  `$N.NN` / `On (window N)` / `N built-in, M custom`), in `tui-format.ts` (pure, imports only
  `./types` — the architecture ratchet permits exactly that) or exported from `tui.ts`.
- Rewrite the 17 labels onto one verb grammar (`Set …` for settings, `View …` for activity,
  `Manage …` for managers, `Reset Configuration`, `Done`). Keep every label ≤30 chars (A2/geometry).
- Uniform screen titles (`Set X` / `Select X`) and one default marker.
- Canonicalize `formatModel` fallback → `Not set` and `formatMaxParallel` → `Unlimited`
  (both are used only by this menu: `formatModel` 1 site, `formatMaxParallel` 4 sites, all in
  `tui.ts`; `types.test.ts:263/269` pin them — 263 is `toContain("Not set")` and survives, 269 is
  `toBe("unlimited")` and must be updated).

**Blast radius** `tui.ts` (labels, descriptions, 6 titles, 5 input prompts), `types.ts` (2 formatter
bodies), `types.test.ts` (1 assertion). No new module, no handler key, no ARCHITECTURE change.
**Cost** S — one worktree, ~0.5–1 day, 2–3 units.
**Risk if wrong** Low; each label is independently revertible; nothing outside the menu sees the
changed formatters except the two toasts.
**Verification** value-token test + label-grammar test + value-set pin (§5.3). A2 is proven by a
width test at 60/80 cols.
**Does not satisfy** the headline requirement (no divider, no tier counts, Templates manager
untouched) and leaves A1 (wrong `[B]`) in place.

### Option B — Normalization + divider grouping + header cleanup + Templates folded onto Presets  ★

**Mechanism** — A, plus:
1. `menuSection(label)` factory (pure, returns `{value: "__divider__:<slug>", label: "─── label ───",
   description: ""}`; the `─── X ───` convention is already used by tool-call rendering, L1247 etc.).
2. `getConfigMenuItems` grouped, same 17 values, same numeric order inside each group:
   `[9 settings]` → `─── Run Activity ───` → history, monitor, dashboard, retry →
   `─── Presets & Templates ───` → preset, templates → `reset` → (`Done` appended by the caller).
   Divider selection is a no-op loop (`result in actions` false) — no control-flow change needed.
3. `showConfigMenu`: delete the duplicated 4-line header (L1063–1089) and keep the title; raise the
   viewport from 10 to 15 (L1093). Screen becomes title + 19 rows + footer.
4. Templates manager onto the Presets shell: classify by **membership in `state.builtinTemplates`**
   (not by filename), order built-ins first, divider `─── Custom Templates ───` only when customs
   exist, title `Templates (N built-in, M custom)`, description
   `t.description || formatTemplateSummary(t)` where the summary is `preset · thinking · slots ${a}, ${b}`
   (last-resort `task.slice(0,60)` as today). Keep the explicit empty-state notify.
5. Presets manager parity: add `(project)`/`(global)` to the detail title, make divider selection a
   no-op loop, and adopt the same unset-field rule as Templates (omit unset optional fields; keep
   `Inherit:` because "yes (default)" is a real default).
6. Fix A1 by using `sanitizeFileName` (the writer's own function) **and** the membership fallback;
   apply to both finders.

**Blast radius** `tui.ts` (config menu, both managers, two finders, detail views), one pure
formatter/divider module (existing `tui-format.ts` — no new module, no `docs:arch` regen),
`types.ts` + `types.test.ts` as in A. **No** handler keys, **no** `KNOWN_DELEGATE_KEYS` /
`_DelegateParamCoverage` / retry-pins surface: those pin `delegate_task` params and the
snapshot↔resolve key sets, none of which read labels or descriptions.
**Cost** M — ~2 days, 5–6 units.
**Risk if wrong** Grouping adds 2 rows (19 vs 18) into a viewport that already scrolls; mitigated by
the 15-row viewport. If the viewport change is rejected, the menu still scrolls (as today) but with
better structure. Divider rows consume one scroll slot each.
**Verification** value-set pin (17 keys unchanged), divider invariants, tier tests with temp dirs
(the `My Checklist` case), formatter unit tests, and a structural render test at 80 cols asserting
no row exceeds width and no in-scope label exceeds 30 visible chars.

### Option C — Normalization + shared menu-shell/rendering helper

**Mechanism** B, plus a new module (e.g. `src/tui-menu.ts`) exporting:
- `menuSection(label)`, `buildSections([{label?, items}])` — the divider/ordering primitive;
- `showListScreen(ctx, {title, subtitle?, items, maxItems})` — the shell, replacing the 8 in-scope
  `showSelectList` calls (config menu passes the new optional header instead of hand-building);
- `showDetailScreen(ctx, {title, tierSuffix?, subtitle?, fields, footer})` — one renderer for the
  preset and template detail views (they are ~90% identical today);
- `formatMenuValue` + `formatUnset` — one value vocabulary.
`showSelectList` is **left untouched** so the 4 excluded call sites keep byte-identical output.

**Blast radius** new module ⇒ first-line `// Purpose:` header **and** `npm run docs:arch`
(ARCHITECTURE.md module map is ratcheted by `src/__tests__/architecture-doc.test.ts:11–19`); tui.ts
call sites; exported surface grows (tests can import from `../tui`, proven by
`streaming-sentinel.test.ts` passing today). Highest review surface of the three.
**Cost** L — ~3 days, 7–9 units.
**Risk if wrong** Presentation regressions leaking into excluded screens if `showSelectList` is
edited rather than wrapped; double maintenance if the migration stops halfway; a new module for a
6-screen use case is structure without a second consumer.
**Verification** B's tests plus a differential guard: render the old helper and the new shell with
identical inputs at widths 60/80/120 and assert equal strings for the excluded screens.

### Option D — Do nothing (baseline)

**Mechanism** none. **Blast radius** none. **Cost** 0.
**Risk if wrong** The catalogue persists, including A1 (wrong `[B]` in the manager the maintainer
singled out), B2 (`9 saved` for built-ins), C1 (duplicated header), and the Templates/Presets
divergence. The cheapest maintenance position, and the honest baseline for judging A/B/C.

### Option E — Rejected: adopt pi-tui `SettingsList` for the settings block

**Mechanism** use `SettingsList` (`SettingItem{label, currentValue, description, submenu}`) for the
9 setting rows, right-aligned values, optional search. **Why rejected** it changes the interaction
contract: descriptions render **only for the selected row** (8 of 9 values lose their explanatory
text), Enter becomes `onChange`/submenu plumbing rather than the existing `actions` dispatch, and the
hint line/mouse behaviour differ — a behaviour change, not presentation. It would also put the
config menu and the sub-screens on two different component families.

### Comparison

| Option | Mechanism | Blast radius | Cost | Risk if wrong |
|---|---|---|---|---|
| A minimal | formatters + labels + titles | tui.ts + types.ts + 1 test pin | S (~1d) | low, partial vs headline |
| **B grouped (★)** | A + dividers + header drop + viewport + Templates→Presets shell + tier fix | tui.ts, tui-format.ts, types.ts, 1 test pin | M (~2d) | medium: 2 extra scroll rows; reversible per unit |
| C shell | B + new `tui-menu.ts` + 10 call-site migration | + new module, docs:arch, architecture-doc ratchet, wider surface | L (~3d) | medium-high: leak into excluded screens |
| D nothing | — | none | 0 | catalogue + wrong tier label persist |
| E SettingsList | component swap | config menu + dispatch rework | M | high: behaviour change, information loss |

---

## 4. Recommendation

**Option B** — normalize labels/values/titles, group the config menu with the divider pattern the
Presets manager already proves in this exact component, delete the duplicated header, and fold the
Templates manager onto the Presets list shell (built-ins first → `─── Custom Templates ───` →
customs, tier counts in the title, config-summary description fallback, explicit empty state kept)
— **and fix the tier classifier so `[B]` is not a lie**.

**Why B over C.** B satisfies 100% of the headline requirement and every High/Medium finding for
~2/3 of C's cost, without a new module, without `docs:arch` regeneration, and without touching the
render path shared by the four excluded screens. C's genuinely reusable pieces are small
(`menuSection`, the two detail views), and extracting them can be a follow-up cycle if a third list
screen appears. C's differential-render guard is the right idea and is cheap enough to include in B
as a *test* (render the config menu at 3 widths and assert structural invariants) without the
migration.

**Why B over A.** A leaves the headline requirement unmet (Templates keeps no divider, no tier
counts, and the `9 saved` lie) and leaves A1 (wrong `[B]`) — the only finding that renders false
information — in place.

**Why not D.** The maintainer asked for this; the delta is bounded and testable.

### Falsifiers (what would change the recommendation)

1. **Hidden consumer of the two formatters.** If `formatModel` or `formatMaxParallel` is read
   anywhere outside `tui.ts`, canonicalizing their output has a wider blast radius than measured.
   *Current measurement:* `formatModel` 1 call site (L1064), `formatMaxParallel` 4 (L190/198/944/1075),
   plus `types.test.ts` — zero other modules. Re-run `grep -rn "formatMaxParallel\|formatModel(" src`.
2. **Header value.** If the maintainer wants the at-a-glance summary, U3's header deletion is
   dropped and the header is rewritten from `formatMenuValue` instead. B still stands; C1 becomes
   "format drift" rather than "duplication".
3. **Viewport.** If raising 10→15 is rejected (small-terminal policy), dividers still work but the
   menu scrolls 4 more rows than today. If that is unacceptable, B collapses to A + a single
   divider before the managers.
4. **A strict-literal reading of "adopt the Presets pattern".** The reference has *no* empty state
   and a builtin-only tier suffix. Copying those literally would be a regression (D6/D7). If the
   maintainer insists on literal parity, the recommendation for those two dimensions flips to
   "upgrade Presets to Templates' behaviour" — which is what B already does.
5. **Tier membership availability.** If `state.builtinTemplates` can be empty when the manager opens,
   the membership fallback is unreliable. *Current path:* set in `session_start` (index.ts:4144)
   before command use; `resetState` reloads `config.templates` but built-ins never change.
6. **Test pins discovered later.** No test currently imports `getConfigMenuItems` or pins any menu
   label (grep over `src/__tests__` for the label strings returns nothing). If such a pin appears,
   the value-set pin must be updated in the same unit.

---

## 5. Conductor-ready execution sketch (Option B)

Seven units, each sized for one worktree/PR, in dependency order. Every unit must keep
`npm run typecheck && npx vitest run` green (baseline: typecheck clean, 142/142 in the 8
menu-adjacent suites; full suite green on `dev`).

### U1 — Pure formatting foundation (no visible change)
- **Files:** `src/tui-format.ts` (preferred home: it may import only `./types`, enforced by
  `architecture-rules.test.ts:231–241`; no new module ⇒ no `docs:arch` regen), `src/__tests__/tui-format.test.ts`.
- **Add:** `formatMenuValue(kind, config): string` covering `model | thinking | parallel | depth |
  approval | completionnotify | recovery | historyentries | costlimit | sla | presetCounts |
  templateCounts`; `formatUnset(kind?)`; `menuSection(label): SelectItem` returning
  `{value: \`__divider__:${slug}\`, label: \`─── ${label} ───\`, description: ""}`.
- **Acceptance:** canonical token table is a single exported `const MENU_VALUE_TOKENS` (or a
  documented switch) so tests assert tokens, not prose; `formatMenuValue("parallel", {maxParallel:0})`
  and `formatMaxParallel(0)` are asserted semantically equal (case-insensitively) so a future
  divergence is deliberate.
- **Non-goal:** no call-site changes.

### U2 — Config rows + sub-screen titles (visible, no structure change)
- **Files:** `src/tui.ts` (`getConfigMenuItems` L927–1038; titles at L149/171/309/336/362/383;
  input prompts L190/210/237/266/395), `src/types.ts` (L985–991), `src/__tests__/types.test.ts`.
- **Change:** all 17 labels onto one grammar (`Set …` ×9, `View …` ×3, `Manage/Browse …` ×2,
  `Retry …`, `Reset Configuration`); **values untouched**; descriptions replaced with
  `formatMenuValue`; thinking row gets the same `(current)` marker treatment as the other selectors
  (one marker syntax); `formatModel` fallback → `Not set`, `formatMaxParallel(0)` → `Unlimited`
  (update `types.test.ts:269`; :263 already uses `toContain`).
- **Acceptance:** every non-divider label ≤30 visible chars; value-set pin (exactly the 17 values,
  same order) passes; no legacy off-phrase appears in any in-scope description.

### U3 — Grouping + header cleanup
- **Files:** `src/tui.ts` (`getConfigMenuItems` L927+, `showConfigMenu` L1040–1133).
- **Change:** insert `menuSection("Run Activity")` before `history` and
  `menuSection("Presets & Templates")` before `preset`; move `reset` after `templates` (still before
  `Done`); delete L1063–1089 (header block) and the now-unused `formatModel` import if applicable;
  `Math.min(items.length, 10)` → `15`.
- **Acceptance:** 17 handler values unchanged and in unchanged relative order within sections;
  divider values start with `__divider__:` and are **not** in the actions map (selecting one
  re-renders, does not close); rendering at 80 cols shows no truncated label and no row wider than
  the terminal.
- **Reviewer note:** `showConfigMenu`'s dispatch needs **no** code change for dividers
  (`if (result in actions)` at L1126); do not add a guard unless a divider closes the menu.

### U4 — Tier classifier correctness (independent of U1–U3)
- **Files:** `src/tui.ts` (`findPresetSource` L777–786, `findTemplateSource` L793–805,
  `showViewTemplate` L828), `src/__tests__/` new `menu-tier.test.ts`.
- **Change:** replace the ad-hoc `replace(/[^a-zA-Z0-9_-]/g,"_").toLowerCase()` with
  `sanitizeFileName` (the writer's own function, `presets.ts:376`) in both finders; when no file
  matches, decide by membership: name ∈ `state.builtinPresets` / `state.builtinTemplates` →
  `builtin`, else custom (`project` as today's preset fallback). Extract the decision as an exported
  pure `classifyTier(name, dirs, builtinNames)` so tests inject a directory map.
- **Acceptance:** the `My Checklist` probe case classifies as `project`; global-only → `global`;
  shipped built-ins → `builtin`; the extension's own `writeTemplateFile` output round-trips to the
  right tier. **Known residual (document, don't fix here):** a hand-written custom file that
  *overrides a builtin name* with a non-canonical filename still renders `[B]`.

### U5 — Templates manager onto the Presets shell (headline)
- **Files:** `src/tui.ts` (`showTemplateManager` L887–921), new exported
  `buildTemplateMenuItems(templates, sourceOf)`, `src/__tests__/menu-template-items.test.ts`.
- **Change:** partition by tier; order built-ins → divider (only when customs exist) → customs;
  title `Templates (N built-in, M custom)`; description `t.description || formatTemplateSummary(t)`
  where the summary is `preset · thinking · slots ${a}, ${b}` (last-resort `task.slice(0,60)`);
  keep the explicit empty-state notify; parent row (L1019–1023) value → `N built-in, M custom`
  using the same counts.
- **Acceptance:** row order test (`builtin,builtin,…,divider,custom`), divider absent when no
  customs, title counts match partitions, no description is a raw mid-word task slice when the
  template declares a preset/params, and the empty state still renders the notify.

### U6 — Presets parity + detail unification
- **Files:** `src/tui.ts` (`showPresetManager` L670–775, `showViewTemplate` L818–885), new exported
  `buildPresetMenuItems`.
- **Change:** detail title gains `(project)`/`(global)` (mirroring Templates); divider selection
  becomes a no-op re-render instead of closing (wrap the list call in the same bounded loop the
  manager already could use, or re-enter once); one unset-field policy across both detail views
  (omit unset optional fields; keep `Inherit:`); presets with zero items get the same explicit
  notify as Templates.
- **Acceptance:** both detail views use the same field-labelling grammar and the same tier suffix
  vocabulary; selecting a divider leaves the manager open; no preset content changes.

### U7 — Docs and changelog
- **Files:** `.development/ARCHITECTURE.md` **only if** a module's first-line purpose changes
  (`npm run docs:arch` regenerates the map and `architecture-doc.test.ts` will fail otherwise);
  `README.md` (`/brl-subagent templates` row at :59 if the label wording changes; the
  "browses only" note at :282 already matches a `Browse` label); `CHANGELOG.md`.
- **Acceptance:** `npm run docs:arch` reports the map is current; README command table untouched
  (no renamed commands).

### 5.3 Verification strategy (no brittle snapshots)

**Testable seams that exist today:** `getConfigMenuItems(state)` is exported and pure; importing
`../tui` from a vitest test works (`src/__tests__/streaming-sentinel.test.ts` does it — 7/7 green
this session); `showSelectList` is exported. **New seams to export** (pure, no `ctx`):
`formatMenuValue`, `menuSection`, `buildTemplateMenuItems`, `buildPresetMenuItems`,
`classifyTier`. Keep FS-dependent classification behind an injected `sourceOf` callback so label
tests need no filesystem.

| Concern | Pin without snapshots | Falsifier for the pin |
|---|---|---|
| Presentation-only contract | `getConfigMenuItems(state).filter(i => !i.value.startsWith("__divider__")).map(i => i.value)` deep-equals the pinned 17-element array; run for 3 states (defaults / fully configured / zero-unlimited) | any value rename fails here first |
| Divider shape | every divider: `value.startsWith("__divider__:")`, `description === ""`, `label` matches `/^─── .+ ───$/`; no divider value exists in the actions map | a divider that dispatches |
| Label grammar | every non-divider label matches `/^(Set|View|Manage|Browse|Retry|Reset) [A-Z]/` **and** `visibleWidth(label) <= 30` | a label that truncates or reintroduces a bare noun |
| Value vocabulary | every description is in a closed token grammar (`/^(Not set|Unlimited|Off|On \(window \d+\)|\d+ (levels?\|entries\|built-in, \d+ custom)|...|\$[\d.]+|provider\/id)$/`), plus a **negative** list of banned legacy phrases (`/will use main agent|no pruning|passive delivery|No delegation from subagents|None saved/`) — the same ratchet style as `runtime-vocabulary.test.ts` | a new prose value sneaks in |
| Formatter units | table-driven tests over `formatMenuValue` for each kind × {unset, zero, normal, boundary}; semantic-equivalence assertion vs `formatMaxParallel` | a formatter change that forgets a state |
| Tier classification | temp-dir tests (pattern: `templates-files.test.ts`): canonical filename, non-canonical filename (`My Checklist`), global-only, builtin, custom-overrides-builtin (documented residual) | classifier regressions, incl. the A1 bug |
| Render structure | instantiate the real `SelectList` with the built items at widths 60/80/120; assert (a) no line exceeds width, (b) descriptions start at column 32 for described rows, (c) divider rows render as one line | layout breaks on narrow terminals |
| Excluded surfaces | no test change may touch history/monitor/dashboard/retry rendering; if C is ever adopted, add the differential string guard | scope leak |

---

## 6. Open questions (for the conductor / maintainer)

1. **Header:** delete the 4-line summary block (recommended — every value is one row below it) or
   compress it to one line derived from the same formatters? Keeping it unchanged is not
   recommended (C1).
2. **Viewport:** raise the config menu's visible rows from 10 to 15 (recommended) or keep 10?
   With grouping the list is 19 rows; 10 leaves 9 hidden.
3. **Label grammar:** verb-led (`Set Model`, `Set Thinking Level`, `View Run History`,
   `Manage Presets`) — recommended, changes only 2 setting labels and 3 noun rows — or noun-led
   settings grammar (`Model`, `Thinking level`, …) which is closer to pi's `SettingsList` but
   renames all 17 rows.
4. **`Manage` vs `Browse`:** both managers are read-only; rename to `Browse Presets` /
   `Browse Templates` (recommended) or keep `Manage`? Renaming does not touch commands.
5. **Casing of `unlimited`:** canonicalize `formatMaxParallel` to `Unlimited` (recommended; updates
   one assertion in `types.test.ts:269`) or add a separate menu-only formatter and leave the
   formatter untouched?
6. **Divider semantics:** make divider selection a no-op re-render in *both* managers (recommended,
   unifies with the config menu's incidental behaviour) or preserve Presets' close-on-select?
7. **Unset optional fields in detail views:** omit (recommended, Templates' current behaviour) or
   always render `(not set)` (Presets' current behaviour)?
8. **Tier-classification residual:** accept that a hand-written custom template overriding a
   *builtin name* with a non-canonical filename still shows `[B]` for this cycle, or schedule the
   additive `source?: "project"|"global"` field (a data-shape change, not persisted —
   `persistState` does not serialize `templates`, state.ts:240–259)?
9. **Adjacent behaviour, deliberately untouched:** `showSLAConfig` sets
   `state.config.slaTrackingEnabled = true` (L387) *before* the window-size input, so cancelling the
   input leaves SLA enabled in memory with no persist and no toast. Fixing it is a behaviour change
   → separate cycle.
10. **Out-of-scope rows:** `sla-stats` and `compliance` have handlers but no menu rows. Surfacing
    them would be new navigation → not this cycle.

---

## 7. Evidence log

| # | Claim | Probe / read | Observed | Coverage |
|---|---|---|---|---|
| E1 | 12 `showSelectList` calls, 8 in scope | AST walk (`/tmp/menu-probe/enum4.mjs`, real `scripts/ts-ast.mjs`) | 12 listed with titles; 8 in scope | whole `src/tui.ts` (3052 lines parsed) |
| E2 | `getConfigMenuItems` has 17 rows in a fixed order | AST literal enumeration + runtime call via `npx jiti` | 17 rows, exact labels/values printed | full array L927–1038 |
| E3 | Config viewport is 10 with 18 items | read L1091–1094 | `Math.min(items.length, 10)`; 17 + `Done` | exact |
| E4 | Header duplicates 4 rows with a divergent model fallback | read L1063–1089 + `types.ts:985–987` | `formatModel` fallback lacks "by default"; cost line conditional | exact |
| E5 | Value column truncates prose at normal widths | `/tmp/menu-probe/trunc.mjs` (real `SelectList`) | 80 cols → `…by defa`; 60 → `…main a` | widths 60/80/100 |
| E6 | Label column is fixed at 32 ⇒ 30 visible chars | `/tmp/menu-probe/width.mjs`; `select-list.js` `getPrimaryColumnBounds` | 45-char label cut at 30, desc at col 32 | 2 samples + source read |
| E7 | Empty list renders "No matching commands" | `/tmp/menu-probe/selectlist.mjs` | preset manager's real empty state is the library fallback | empty list + divider + filter cases |
| E8 | Divider rows are selectable and rendered as one line | same probe + `select-list.d.ts` (`SelectItem` has no `disabled`) | `→ ─── Custom Presets ───` | 3 render cases |
| E9 | Selecting the preset divider closes the manager | read L707 | `if (!result \|\| result === "__divider__") return;` | exact |
| E10 | Config-menu divider selection would be a no-op | read L1126 | `if (result in actions)`; divider key absent | exact |
| E11 | Merged template order is customs-first | `npx jiti` probe calling real `getAllTemplates` | `c1 \| shared(custom) \| b1 \| b2` | 3 builtins + 2 customs incl. override |
| E12 | Tier label is wrong for non-canonical filenames | `npx jiti` probe with real `loadAllTemplates` + verbatim `findTemplateSource` logic | 10 loaded; `findTemplateSource('My Checklist') => builtin`; writer emits `My Checklist.md` | project dir with 1 custom + 9 builtins |
| E13 | `writeTemplateFile` emits a non-canonical name | `npx jiti` probe | `/tmp/menu-probe/written/My Checklist.md` | 1 template |
| E14 | 9/9 built-in templates and presets declare descriptions | `grep -l '^description:' templates/*.md presets/*.md` | 9/9 and 9/9 | shipped corpora |
| E15 | 5 input sites, none uses the placeholder arg | `grep -n "ctx.ui.input(" src/tui.ts`; pi `types.d.ts:78` | 5 sites (190/210/237/266/395); 0 with placeholder | all of `tui.ts` |
| E16 | Formatters are menu-only | `grep -rn "formatMaxParallel\|formatModel(" src` | `formatModel` 1 site, `formatMaxParallel` 4 sites — all `tui.ts` | whole `src/` |
| E17 | Two formatter outputs are pinned by tests | `types.test.ts:257–274` | `formatMaxParallel(0)` is `toBe("unlimited")`; `formatModel(undefined)` is `toContain("Not set")` | exact assertions |
| E18 | No test or doc pins menu labels | `grep -rn "Select Model\|Manage Templates\|Custom Presets\|Not set (will use"` excluding `tui.ts` | only `types.ts:986` (formatter) | whole repo minus node_modules |
| E19 | `../tui` is importable from vitest | `npx vitest run streaming-sentinel.test.ts` | 7/7 pass | 1 suite |
| E20 | Baseline green | `npm run typecheck`; 8 menu-adjacent suites | typecheck clean; 142/142 | `templates*`, `presets*`, `architecture-rules`, `runtime-vocabulary`, `params`, `retry-pins` |
| E21 | A new module would trip the architecture docs ratchet | read `architecture-doc.test.ts:11–19,21–34` | requires `// Purpose:` first line + `npm run docs:arch` | exact test |
| E22 | `templates`/`presets` are not persisted | read `state.ts:240–259` | `persistState` omits both | exact |

### Contradictions with the brief (reported, then followed reality)

1. **"Templates must adopt the Presets design language — tier prefixes, …"** — Templates *already*
   has the `[B]/[P]/[G]` prefixes and a tier-aware detail view; the actual deltas are grouping,
   order, title counts, description fallback, and a shared empty-state policy (§1.5). Moreover the
   Presets manager is *behind* Templates on two dimensions (no empty state, builtin-only tier
   suffix), so "adopt the preset pattern" must be bidirectional, not a copy.
2. **"'off/unset' is phrased at least six ways"** — measured ≥8 distinct wordings across 9 slots,
   plus three casings (`Unlimited`/`unlimited`), plus a ninth in the notify selector.
3. **"Reset sits mid-list"** — Reset is the last *setting* at index 9 of 17, i.e. it already marks
   the settings↔actions boundary; the real problem is that the boundary is invisible (no divider).
4. **"17 rows in a 10-row viewport"** — confirmed, but the viewport is `min(items,10)` and the
   screen also spends 4–5 lines on the header; the header is the larger vertical cost per pixel of
   information.
5. **Not in the brief at all:** the tier classifier is factually wrong for non-canonical filenames
   (A1) — found while grounding the headline requirement.

# Menu polish U1 — pure formatting foundation (umbrella #345)

jev: low (0.77) · C3 · worktree y — consistent (no deviation; artifact clamp satisfied).
Worktree: `../brl-subagent-wt-menu-u1` · branch `feat/menu-u1-format-foundation` (from `dev`; lockfiles match → symlinked prep).
Review: **C3** — conductor diff read + the new tests (Rule 10: display-only, no consumers yet; the token table is pinned
by tests, not prose).

## Context

Cycle `/brl-subagent menu polish` (opened 2026-10-17; umbrella **#345**); direction **Option B**, execution sketch
§5 U1 of `menu-polish-proposal-2026-10-17.md`. This unit is the **pure foundation** every later unit consumes: one
canonical value vocabulary + the divider factory. **No visible change, no call-site changes.**

## Recon (Rule 13 — codegraph @ `089a3a3`)

```
## Recon (Rule 13 — codegraph @ 089a3a3)
- target: `formatMaxParallel`
- callers(formatMaxParallel):
  - 5 caller(s)
  - src/__tests__/types.test.ts:1 (types.test.ts)
  - src/tui.ts:185 (showConcurrencyInput)
  - src/tui.ts:927 (getConfigMenuItems)
  - src/tui.ts:1040 (showConfigMenu)
  - src/tui.ts:1 (tui.ts)
- impact(formatMaxParallel, depth 2):
  - 8 affected symbols across 5 files
  - files: src/types.ts, src/__tests__/types.test.ts, src/tui.ts, src/index.ts, src/__tests__/streaming-sentinel.test.ts
- grep delta: 12 raw hits for `formatMaxParallel` (incl. comments/strings).
```

```
## Recon (Rule 13 — codegraph @ 089a3a3)
- target: `tui-format`
- callers(tui-format):
  - 4 caller(s)
  - src/__tests__/recovery-surface.test.ts:1 (recovery-surface.test.ts)
  - src/__tests__/recovery-visibility-bridge.test.ts:1 (recovery-visibility-bridge.test.ts)
  - src/__tests__/tui-format.test.ts:1 (tui-format.test.ts)
  - src/tui.ts:1 (tui.ts)
- impact(tui-format, depth 2):
  - 7 affected symbols across 7 files
- grep delta: 6 raw hits for `tui-format` (incl. comments/strings).
```

**Coverage note:** the graph lists callers, not call bodies; the proposal's E16 (`formatModel` 1 site,
`formatMaxParallel` 4 sites in `tui.ts`, plus one test pin at `types.test.ts:257–274`) reconciles against the caller
set above. The index was refreshed by `recon.sh` during this recon (the cycle-open docs commit had made it stale;
`indexed_at_commit = 089a3a3`). **This unit touches none of those call sites** — the callers are listed to pin the
future adoption order and the not-yet-visible blast radius.

## Required behavior

1. **`MENU_VALUE_TOKENS`** — one exported canonical token table (single source; tests assert the tokens, not prose).
   The vocabulary (final strings pinned by tests):

   | kind | unset / zero / boundary | normal |
   |---|---|---|
   | `model` | `Not set` | `provider/id` |
   | `thinking` | — | the level name (raw enum) |
   | `parallel` | `Unlimited` (0) | `N` |
   | `depth` | `Off` (0) | `1 level` / `N levels` |
   | `approval` | — | `Never ask` / `Ask on writes` / `Ask every time` |
   | `completionnotify` | — | `Every run` / `Failed only` / `Off` |
   | `recovery` | — | `On` / `Off` |
   | `historyentries` | `Unlimited` (0) | `1 entry` / `N entries` |
   | `costlimit` | `Unlimited` (0) | `$N.NN` |
   | `sla` | — | `On (window N)` / `Off` |
   | `presetCounts` | — | `N built-in, M custom` |
   | `templateCounts` | — | `N built-in, M custom` |

2. **`formatMenuValue(kind, input)`** — pure; `input` is a **structural** object (typed in `tui-format.ts`; **no
   `SessionState` import** — the module's ratchet permits `./types` only). It must carry, per kind: the model record,
   `maxThinkingLevel`, `maxParallel`, `maxSubagentDepth`, `approvalMode`, `completionNotify`, `recovery`,
   `maxHistoryEntries`, `sessionCostLimit`, `slaTrackingEnabled`/`slaWindowSize`, and `builtinCount`/`customCount`
   (for the count kinds). Every kind has defined behavior; unknown input degrades to the canonical unset token.
3. **`formatUnset(kind?)`** — returns the canonical unset token for the kind (default `Not set`).
4. **`menuSection(label)`** — returns `SelectItem` `{ value: "__divider__:<slug>", label: "─── <label> ───",
   description: "" }`; slug = kebab-case of the label (lowercase; non-alphanumeric runs → `-`); pure.
5. **Semantic equivalence (the future-divergence pin):** `formatMenuValue("parallel", { maxParallel: 0 })` equals
   `formatMaxParallel(0)` **case-insensitively**, and `formatMenuValue("model", {})` contains `Not set` — the casing
   canonicalization lands in **U2**, not here, so the two must not silently disagree.
6. **No call-site changes** — `src/tui.ts` and `src/types.ts` are untouched this unit.

## Evidence requirements

- Extend `src/__tests__/tui-format.test.ts`: table-driven per kind × {unset, zero, normal, boundary}; a **negative
  list** of banned legacy phrases (`will use main agent`, `no pruning`, `passive delivery`,
  `No delegation from subagents`, `None saved`); `menuSection` shape tests (label matches `/^─── .+ ───$/`, slug,
  `description === ""`); the semantic-equivalence assertions from item 5.
- `npx tsc --noEmit`; full suite counts (baseline **74 files / 1509 tests**); `git diff --check`.
- Coverage line: which call sites were left untouched (the recon caller set) + the counts observed.

## Constraints

- `src/tui-format.ts` + `src/__tests__/tui-format.test.ts` **only**. No new module (avoids the `docs:arch` ratchet),
  no `tui.ts`/`types.ts` edits, `.development/**` untouched.
- Commit + push; PR body per the `pr` skill with **"Part of #345"** (not `Fixes` — the umbrella closes on U7).

## Out of scope

Call-site adoption (U2+), the `unlimited`→`Unlimited` formatter change (U2), any visible change, and the excluded
surfaces (history/monitor/dashboard/retry/tool-call rendering).

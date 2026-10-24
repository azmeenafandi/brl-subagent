# Menu polish U7 — final consistency sweep (umbrella #345)

jev: low (0.95) · C3 · worktree y — consistent (no deviation).
Worktree: `../brl-subagent-wt-menu-u7` · branch `chore/menu-u7-final-sweep` (from `dev`, after U6).
Review: **C3** — conductor diff read + the toast pins.

## Context

The final unit closes the loop: the two legacy confirmation toasts still carry banned prose (parked at U2's close),
one stale doc comment remains from U4's membership removal, the docs need a check (no command/label renames are
expected), and the umbrella issue gets its close-out record. The CHANGELOG/release stays with the maintainer.

## Required behavior

1. **The two legacy confirmation toasts** (`src/tui.ts`, the `onConfigChanged` messages in
   `showHistoryEntriesInput` / `showCostLimitInput`):
   - `Run history set to unlimited (no pruning)` → `Run history set to Unlimited`
   - `Session cost limit set to unlimited` → `Session cost limit set to Unlimited`
   The canonical tokens come from `formatMenuValue("historyentries"|"costlimit", …)` — derive them, do not hardcode a
   second vocabulary.
2. **Stale doc comment** (`TierClassifierIo.fallback`): remove the `and the name is not a builtin` clause (the
   membership branch was removed in U4's F1); describe the actual semantic — the surface's terminal fallback when no
   canonical file matches.
3. **Docs check:** verify the README needs no update — the `/brl-subagent` command table lists commands (not menu
   rows), and no command/label was renamed this cycle. Report the check (grep + result). If any in-cycle wording
   appears in README, update it.
4. **CHANGELOG: deferred to the release** (the release ritual owns the release entry); do not add one here.
5. **Close-out:** the PR body carries **"Part of #345"**; the conductor closes the umbrella manually after merge with
   a summary comment (dev merges do not auto-close; the default-branch rule).

## Evidence requirements

- Extend `src/__tests__/menu-config-items.test.ts` (or the existing menu test file — no new file needed): a mock-ctx
  call to each input with `0` asserts the `onConfigChanged` message uses `Unlimited` and contains no `unlimited`,
  `no pruning`, or `passive delivery`.
- `npx tsc --noEmit`; full `npx vitest run` (baseline = the post-U6 count — report it); `git diff --check`.
- Coverage line: the two toasts + the comment + the README check, with counts.

## Constraints

- `src/tui.ts` + the existing menu test file only. No token/`menuSection` contract edits; no `.development/**`.
- Commit + push; PR per the `pr` skill with **"Part of #345"**.

## Out of scope

The release/CHANGELOG (maintainer), any behavior change, and the excluded surfaces.

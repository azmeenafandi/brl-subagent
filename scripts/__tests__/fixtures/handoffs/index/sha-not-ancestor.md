# Handoff — fixture (index)

> Test fixture for `scripts/handoff-verify.mjs`. Not a real handoff: every section is the shape the
> contract promises, and every value is one the test's stubbed repo probe agrees with.

## STATE
Verified: 4c1d9ab (2026-11-08)
In flight: nothing
Next action: #426 (open) — the fixture's next action
Index: verify `node scripts/handoff-verify.mjs` (0 drift) before acting → HANDOFF.md §Invariants · handoff/state.md

## Invariants
- a page holds the mechanical claims, so the index holds none
- the redesign landed at `deadbee1c0ffee`; a cited commit is checked against dev

## Pointers
| Page | Holds |
|---|---|
| [state](handoff/state.md) | the fixture's mechanical snapshot |

## Resume protocol
node scripts/handoff-verify.mjs     # 0 drift
git status --short                  # clean tree

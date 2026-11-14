# Handoff — fixture (correct)

> Test fixture for `scripts/handoff-verify.mjs`. Not a real handoff: every value here is one the test's
> stubbed repo probe agrees with, so a change to this file is a change to the tool's contract.

## STATE
Verified: 4c1d9ab (2026-11-08)
Cycle: fixture cycle.

- **dev** @ `4c1d9ab`. The fixture dev tip.
- **Released:** nothing. Running install: **local-path dev checkout** (this repo, `dev @ 4c1d9ab`), revert
  with `pi remove <dev path>` → `pi install npm:brl-subagent` → `/reload`.
- **Board:** Open: **#426**, **#450**, PR #402 held.
- **Suite:** 2 files / **12** green on dev; docs guards current (**58 modules**, **27 ADRs**).
  `alpha.ts` is **10**; `beta.ts` 3.

### Since the last handover
- Nothing. History shapes stay out of the check: `alpha.ts` **20 → 10**, `beta.ts` (9),
  `alpha.ts` 2,249 vs 2,248, `alpha.ts` 2,249 versus 2,248, `alpha.ts` 5+/2−.

### Next actions
1. Nothing. The `Open:` list is checked against the board.

## Open items
- fixture only

## Pointers
- `scripts/handoff-verify.mjs`

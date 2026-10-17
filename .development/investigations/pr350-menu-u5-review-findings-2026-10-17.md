# REVIEW — PR #350 (issue #345, U5 — headline) @ `e0ab85d`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — focused C2 review (2026-10-17).
Checkout: `review/menu-u5` at the PR head. Spec: `.development/investigations/menu-polish-u5-spec-2026-10-17.md`.

**Verdict: approve-with-nits**

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| minor | `src/tui-format.ts:287` | `templateSlotNames` duplicates `extractParamNames`' shape — ratchet-forced (`./types`-only import), documented; **no action** |
| minor | `src/tui.ts:922` (`findTemplateSource` via `classifyTier`) | The non-canonical-filename corner falls back to `builtin` → `[G]`; this is the documented/accepted U4 residual, out of scope; **no action** |

## Verified-OK

- **Partition/order:** membership-identity `Set` partition; built-ins first in shipped order; the divider appears only
  when customs exist; customs keep their order; override-by-name stays custom (probe c trips exactly the 2 override
  tests).
- **Third builder parameter justified:** membership needs builtin object identities; a two-arg builder would fall back
  to filenames (spec-forbidden).
- **Counts agree by construction:** the builder, title, and parent config row share `partitionTemplates` — identical
  counts, pinned for default and override fixtures.
- **Prefixes:** the custom branch is `project→P else G`; the builtin branch hardcodes `B` — a custom can never render
  `[B]` (the spy test pins `sourceOf` as consulted for customs only).
- **Description fallback:** declared wins; the summary omits absent parts; `slice(0,60)` is the last resort (no
  slicing when a preset/params exist); the shared `/g` regex is safe under `matchAll` (repeat calls identical,
  `lastIndex` 0).
- **Empty state** notifies once and never opens the list; **divider selection re-renders** (probe d: a close-mutant
  yielded 1 screen, not 3); cancel exits; no close-on-select remains.
- Probes a–d all failed their pre-stated signatures; `tsc` clean; `git diff --check` clean; tree clean after revert.

SOLID/DRY violations flagged: 1 (ratchet-forced, documented)

**Coverage:** targeted 20/20 · probe-a 4 tests fail · probe-b 2 · probe-c 2 · probe-d 1 · full `vitest run`
77 files / 1604 tests. Findings banked to `/tmp/review-350-findings.md`.

## Disposition (2026-10-17)

- **Both minors: NO ACTION** — (1) the formatter duplication is forced by the architecture ratchet (`tui-format.ts`
  may import `./types` only) and is documented; (2) the corner is the accepted U4 residual (the additive `source`
  field, deliberately out of this cycle).
- Merged `7d04206` (CI pass).

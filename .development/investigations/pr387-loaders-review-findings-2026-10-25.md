# REVIEW — PR #387 (loader dedupe) @ `274504f`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — focused C2, Jev **medium (0.74)**. Sub-issue #380 (parent #374), audit §2.1 D6. Diff `a5a31ca..HEAD`: `src/loader.ts` (new, 178), `presets.ts` (−100 net), `templates.ts` (−94 net), `loader.test.ts` (new), the ARCHITECTURE module map.

**Verdict: approve-with-nits** (1 minor) → fixed `c8caea1` → merged `4c05eb1`.

## Finding

| Severity | File:line | One-liner |
|---|---|---|
| minor | `loader.test.ts:66` | The `.md`-filter test used only invalid-frontmatter non-`.md` files, so removing the filter kept the 11 new tests green (the filter was pinned only by the family suites) |

## Verified-OK

- **Record identity:** base-vs-HEAD JSON-equal on all four loaders — builtin presets over the repo `presets/`, builtin templates over `templates/`, custom presets+templates over a crafted fixture (validation-skip, non-`.md` skip, description fallback, empty-body template skip); the PROJECT>USER two-tier precedence is JSON-equal with the project copy winning.
- **`parseFrontmatter`** moved byte-identically (diffed base copy vs the loader copy).
- **Error paths:** the builtin missing-dir info line, the silent custom tiers, the malformed-frontmatter warn sequences, the unreadable-file outputs+warns, and the `.md`-dirent EISDIR case are all preserved; the narrowed readdir-only catch has **no reachable divergence** (only a throwing logger could diverge — not reachable).
- **Precedence + fields:** first-occurrence-wins via `dedupeByName` (customs only; builtins keep duplicates as before); the per-family mapping is field-identical to the removed inline objects; validators untouched; the template empty-body guard message identical for both tiers.
- **Tests real:** neuter-validate → 2 failures; neuter-dedupe → 1; drop-`.md`-filter → 3 family-suite failures; tree restored byte-clean.
- **Duplication:** jscpd 12 → 9; the delta is exactly D6's three rows; zero HEAD clusters touch loader/presets/templates; HEAD's 9 rows are range-identical to base's 9 non-D6 rows — no new cluster.
- **No collateral:** 87/1755 green, `tsc` clean, the CI gates pass, `docs:arch` regen lists `loader.ts` (42 modules); diff surface exactly the 5 files.
- **Note:** one intermediate full-run flake in `recovery.test.ts` (PID-liveness timing, untouched since #299) — passed in isolation and on re-run; unrelated (friction-logged).

SOLID/DRY violations flagged: 0

## Disposition (2026-10-25)

- **Minor FIXED** in `c8caea1` — `notes.txt` now carries valid frontmatter and the suite asserts it is skipped; dropping the `.md` filter fails this suite too. CI green. Merged `4c05eb1`. Sweep 5/6.

# REVIEW — issue #356 pair: PR #357 (repaint chokepoint) + PR #358 (showDashboard split)

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — focused C2 each, Jev **medium**. Issue #356.
Both PRs branched from `e71dc62`; behavior-preserving refactors, no visual change.

## PR #357 — footer repaint chokepoint

**Verdict: approve-with-nits** (4 minors, all in the *enforcement claims*) → fixed `a4e61c7` → merged `ca83766`.

| Severity | File:line | One-liner |
|---|---|---|
| minor | `concurrency.ts:243-247` | "nothing outside concurrency.ts calls the paint impl" overclaims — tests legitimately do; the boundary is production-only |
| minor | `status-chokepoint.test.ts:29-35` | `productionSources()` non-recursive; aliasing (`const f = updateProgressStatus`) evades the call-paren regex |
| minor | `concurrency.ts:269` | `updateStatus` exported without `@internal`, unmatched by the scan — a side door |
| minor | `concurrency.ts:237-241,253` | "reentrancy-safe" implies a guard that doesn't exist; `@internal` is convention-only |

**Verified-OK:** no `updateProgressStatus(` caller outside `concurrency.ts` in production (full `src/` grep incl.
dynamic imports); `repaintStatus` is a synchronous pass-through (no coalescing; visible-on-return); the paint body
untouched (callers only); paint-before-notify ordering intact; guards pinned (linger break → 1 fail, ticker → 2);
probe (a) direct call in `index.ts` → 2 boundary tests fail; 175 related tests green; `tsc` clean; tree clean.

**Disposition:** all four fixed in `a4e61c7` — recursive+alias-hardened scan, `updateStatus` `@internal` + scanned,
honest docstrings. Reported residual evasions (bracket access, re-export chains, helper in `concurrency.ts`) as
documented limits. 80/1673.

## PR #358 — `showDashboard` split

**Verdict: approve-with-nits** (1 minor) → fixed `f5c59e9` → merged `1d61b36`.

| Severity | File:line | One-liner |
|---|---|---|
| minor | `dashboard-panels.test.ts:433` | Recording-theme colour test ran the rich fixture only — empty-branch keys unpinned (`success` on "No errors ✓" survived `success`→`dim`) |

**Verified-OK:** **byte-identical rendering** — all six panels' strings/order/labels/separators/colour keys/widths/
padding/conditionals/empty branches match `git show e71dc62:src/tui.ts` token-for-token (incl. trailing-blank
placement, the `metrics && keys>0` ≡ `metrics?.breakdown` slice, and the per-row `Date.now()` via injected `now`);
composer ~63 lines, slices computed once, no panel logic left; every panel pure `(theme, slice[, now])`; 11 tests pin
full-screen goldens + per-panel offsets + the ordered `fg` vocabulary; probes: label (5 fails), order (4), empty-branch
deletion (2) caught; populated colour drift caught — empty-branch colour drift escaped (the minor). `tsc` clean.

**Disposition:** fixed in `f5c59e9` — `EMPTY_FG_CALLS` golden + a composer colour test over the empty fixture;
`success`→`dim` now fails. 80/1676.

SOLID/DRY violations flagged: 0 (both)

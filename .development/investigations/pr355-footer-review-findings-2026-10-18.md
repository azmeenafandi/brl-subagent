# REVIEW — PR #355 (footer activity indicator) @ `8a60bca`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — focused C2, Jev **medium**. Spec: issue #354.
PR base `276540e`; four commits (`a96570e` formatter, `62ab1e7` ticker, `7c49e1e` F1, `8a60bca` F2) + the
review fix `e994057`.

**Verdict: approve-with-nits** (one minor) → fixed in `e994057` → merged `780fb00`.

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| minor | `src/index.ts:4224-4225` | Real `session_shutdown` handler body untested — the tests mirrored it manually instead of invoking it |

## Verified-OK

- **Formatter exactness:** frame `floor(now/150)%10`; `formatElapsed` `1m 14s` (spaced, per the helper's canonical
  format); the agreed active text; no completions ⇒ no segment; `(1 unseen)` inside the segment; colour rule exact
  (failed=0 → success, mixed → warning, completed=0&&failed>0 → error), symbols inherit the segment colour; active
  accent; elapsed muted.
- **Ticker:** one 150 ms interval on first activity; stops at zero + anchor drop; ticks call `renderProgressStatus`
  only (no linger/poller contact); shutdown clears both handles.
- **Linger (F2):** edge-triggered single `statusResetTimer`; N renders → 1 timer; a new run clears it; fire resets
  once and clears the handle; the snapshot-guard removal is safe (active>0 always clears first) — and it fixes the
  old "no reset when a sibling settled mid-window" leak.
- **Helper (F1):** 18 call sites routed; only 2 raw glyphs remain (`tui.ts:2190` sentence, `tui.ts:2275` uncoloured
  label), both real and commented.
- **Regression:** counters/queue/2 s poller untouched; `updateStatus` idle line unchanged; config-change repaint
  correct; the `state-sweep` frozen-clock change justified.
- **Tests:** 79 files / 1664 green + `tsc` clean; the 39 new tests pin the four risk paths, not just happy text.
- **Gate A (mutations, all restored, tree clean):** (a) flipped colour rule → 5 failures; (b) dropped armed-guard →
  3; (c) dropped interval clear → 2; (d) frame math +1 → 10.

SOLID/DRY violations flagged: 0

## Disposition (2026-10-18)

- **F-minor: FIXED** in `e994057` — `cleanupSessionState(state)` extracted from the `session_shutdown` handler and
  invoked by the two shutdown tests (real body exercised: ticker, anchor, linger, counters); no re-review (test-pinned,
  behavior-neutral extraction). CI pass. Merged `780fb00`.
- Out-of-scope flags filed as **issue #356** (footer repaint chokepoint; `showDashboard` SRP).

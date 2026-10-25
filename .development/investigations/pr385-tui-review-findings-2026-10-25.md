# REVIEW (C3, conductor) — PR #385 (TUI boilerplate) @ `765d781`

Sub-issue #377 (parent #374), audit §2.1 D9/D11. C3: conductor diff read + goldens (no reviewer dispatch).
Diff `c3049f6..HEAD`: `src/tui.ts` (−97 net), `tui-lines-modal-goldens.test.ts` (new, 227 lines), its snapshot (451).

**Verdict: approve** (conductor). Merged `a1de441`.

## Verified-OK

- **D9:** `showLinesModal(ctx, title, lines)` reproduces the four removed blocks exactly (border → bold accent title →
  blank → dim lines → border → render/invalidate/q|Escape); the four report screens call it with their titles.
- **D11:** `showConfigMenu` now awaits `showSelectList(ctx, "brl-subagent Configuration", items, CONFIG_MENU_VIEWPORT)`
  — same title, items and viewport; the inlined 19-line block is gone.
- **Goldens:** the new snapshot file pins **pre-extraction rendered bytes** for the four report screens plus the
  populated config menu, and the close-key contract (q/Escape close, other keys ignored). All pass.
- **Lifecycle note:** `showLinesModal` deliberately does not `await` `ctx.ui.custom`, matching the old report-screen
  lifecycle (the report returns while the overlay stays open) — called out in the PR's Merge Danger.
- **jscpd:** 22 → **18 fragments** (D9's three/four rows + D11), no new cluster.
- **No collateral:** suite **85 files / 1735**, `tsc` clean, CI pass; no other file touched.

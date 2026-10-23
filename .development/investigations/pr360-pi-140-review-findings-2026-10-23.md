# REVIEW — PR #360 (pi 1.4.0 parity) @ `dbdf347`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — focused C2, Jev **low**. Issue #359.
Diff `517b964..HEAD`: `package.json` (4 dev ranges), `package-lock.json`, `CHANGELOG.md`. **No source change.**

**Verdict: approve — 0 findings.** Merged `a899209`; cockpit tree refreshed to 1.4.0 (`npm ci`).

## Verified-OK

- **Scope:** only the four `@earendil-works/*` dev ranges `^1.3.0 → ^1.4.0`; `typebox` exactly `1.3.27`; peers `*`;
  zero source/test edits.
- **Lockfile:** all four resolve 1.4.0 in `packages` + `npm ls`; `typebox` single deduped 1.3.27; `npm ls` exit 0,
  no extraneous/invalid; the sole added key is `marked-cjk-friendly@0.1.2` (pi-tui 1.4.0's Markdown renderer, peer
  `marked>=15` satisfied by 18.0.11); zero removed entries; `pi-codemode`/`mcp`/`telemetry` move 1.3.0→1.4.0 in
  lockstep (transitive, not removals); lock root devDeps mirror `package.json`.
- **Tests:** 81 files / 1685 tests pass; `tsc --noEmit` clean; no `paths` mapping and the worktree's node_modules
  holds 1.4.0 — the 1.4.0 types are what compile (no stale 1.3.0 copy).
- **Parity (empirical):** every imported `ExtensionAPI` symbol (`on`, `registerTool`, `registerCommand`,
  `registerShortcut`, `sendMessage`, `appendEntry`) is **byte-identical** between the packed 1.3.0 tarball and the
  installed 1.4.0 `.d.ts` (`/tmp` diff); `ExtensionContext` exposes `ui/mode/hasUI/cwd/sessionManager`
  (+`modelRegistry/model/scopedModels`); only `session_start`/`session_shutdown` are subscribed; `Theme.fg` present;
  all imported pi-ai/agent-core/TUI symbols resolve.
- **Out-of-path claims:** `generateSummary`'s parameter is literally `_reserveTokens` (ignored) and unimported;
  `BeforeProviderHeadersEvent` exists but unsubscribed; `pi-ai/models` exists but unimported; repo-wide grep empty.
- **Dialog concurrency:** interactive `custom()` calls are sequential; the four report dialogs float their promise as a
  pre-existing modeless pattern, not a dependence on the old bug — the 1.4.0 fix only improves it.
- **Records:** CHANGELOG claims all true; README/docs carry no host-version claims (only the historical 1.0.0 entry).

SOLID/DRY violations flagged: 0

**Coverage:** `npm ls`/lock `packages` diff · tarball signature diff · suite + tsc rerun · call-path greps ·
docs sweep. Scratch work confined to `/tmp/pi130`; no repo writes.

## Notes

- The read-only API-diff investigation (`investigate-pi-140`) died on a transport error; its scope was folded into
  this review, which did the empirical tarball diff instead — stronger evidence than the planned plan.
- `typebox` remains at the host pin: the 1.4.0 host still bundles **1.3.27**; dependabot #344 (1.3.37) stays held.

# Dependency parity bump — @earendil-works/* → ^1.2.0 (issue #333)

jev: low (0.69) · risk C3 → **conductor rerate to C2** (reason: the bump changes the SDK line every
module is type-checked against and the runtime value imports resolve from; blast radius spans the whole
module graph — Rule 10 "if unsure, default UP"). **Chosen level: `low`** (strict Jev; artifact floor met).
Worktree: `../brl-subagent-wt-deps12` · branch `chore/deps-pi-1.2.0` (from `dev`; isolated prep
`--force-isolated`, rule 2 — dependency-bump worktrees are ALWAYS isolated).
Review: focused C2 (`project-reviewer` + `focused-review`), model `openrouter/meta/muse-spark-1.3-contributor`.

## Context — pi 1.2.0 compatibility check (2026-10-12): NO breaking impact

- No `before_agent_start` handlers registered (the `messageType` union + custom-run firing is inert for us).
- No `sendUserMessage()` / `ctx.isIdle()` usage (busy-run-start semantics change does not apply); the
  extension only SENDS messages, and the new queue-during-run-start behavior is neutral-to-safer.
- No themes/keybindings/models artifacts shipped (config-schema validation change does not apply);
  `.pi/settings.json` stays valid without `$schema`.
- No references to the removed experimental packages or `@earendil-works/chord`.
- All value imports still exist in 1.2.0: `DynamicBorder`, `getMarkdownTheme`, `withFileMutationQueue`;
  all `pi-tui` symbols used (`Container`, `SelectList`, `SelectItem`, `Spacer`, `Text`, `Markdown`,
  `matchesKey`) exist in pi-tui 1.2.0.

**Drift to close:** the four `@earendil-works/*` devDependencies pin `^1.1.0` (lockfile installs 1.1.0)
while the host runs 1.2.0; `typebox` is `^1.3.34` while the host pins `1.3.27` exactly.

## Recon (Rule 13 — codegraph @ de5bdd8)

- target: `src/tui.ts` (file: src/tui.ts) — the value-import surface
- impact(tui.ts, depth 2): 15 affected symbols across 15 files — `src/tui.ts`, `src/index.ts`, and 13 test
  files (incl. `recovery-boot-notice.test.ts`, `recovery-retry-after-boot.test.ts`,
  `terminal-notice-dedupe.test.ts`)
- affected(src/tui.ts): 13 test file(s)
- **grep delta:** 88 raw hits for `tui` (incl. comments/strings) — consistent with the graph's consumer
  list; no consumer the graph missed. **Coverage boundary:** the graph indexes `src/**` only —
  `package.json`/`package-lock.json` are OUTSIDE it, so the dependency surface is verified by `npm ls` +
  `tsc` + the suite instead (recorded, not silently skipped).

## The change

1. `package.json` devDependencies → `"^1.2.0"`: `@earendil-works/pi-agent-core`, `pi-ai`,
   `pi-coding-agent`, `pi-tui`.
2. `typebox` → `"1.3.27"` (the host's exact pin). If tsc or the suite proves a NEWER line is genuinely
   required, keep a reasoned range and REPORT the conflict with evidence — do not fight an incompatibility.
3. `npm install` **inside the isolated worktree only** (never the cockpit/shared tree); refresh
   `package-lock.json`.
4. No other bumps; no transitive upgrades beyond what the resolved ranges require. No source changes.

## Verification (in the worktree)

- `npx tsc --noEmit` clean.
- Full suite (`npx vitest run`) — report file/test counts.
- `npm ls @earendil-works/pi-coding-agent @earendil-works/pi-tui @earendil-works/pi-ai @earendil-works/pi-agent-core typebox` — report resolved versions.
- `git diff --check`; `git diff package.json` (range diff in Evidence).
- If tsc/suite fails in a way indicating a REAL 1.2.0 incompatibility in our code, STOP and report —
  do not patch source (the compatibility check expects none).

## Post-merge (conductor)

1. `npm ci` in the cockpit once no worktree is linked against the stale lockfile (rule 2).
2. `codegraph-refresh.sh` (lifecycle step 6).
3. TUI smoke via `/reload` (history/retry/notice rendering) — the runtime value imports resolve from the
   refreshed shared tree.

## Out of scope

`$schema` config adoption; any behavior/source change.

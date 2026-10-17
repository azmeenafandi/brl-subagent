# Dependency parity bump — @earendil-works/* → ^1.3.0 (issue #337)

jev: low (0.45) · risk C3 → **conductor rerate to C2** (same rationale as #333: the bump changes the SDK line every
module is type-checked against and the runtime value imports resolve from; Rule 10 "if unsure, default UP" — and the
#333 review's lockfile forensics proved the rerate earns its keep). **Chosen level: `low`** (strict Jev; the
artifact floor is met).
Worktree: `../brl-subagent-wt-deps13` · branch `chore/deps-pi-1.3.0` (from `dev`; isolated prep
`--force-isolated`, rule 2 — dependency-bump worktrees are ALWAYS isolated).
Review: focused C2 (`project-reviewer` + `focused-review`), model `openrouter/meta/muse-spark-1.3-contributor`.

## Context — pi 1.3.0 compatibility check (2026-10-16): NO breaking impact

- The 1.3.0 release notes contain **no Breaking Changes / Removed / deprecation section** (sections: New Features ·
  Added · Changed · Fixed).
- All value imports survive in 1.3.0: `DynamicBorder`, `getMarkdownTheme`, `withFileMutationQueue`; all `pi-tui`
  1.3.0 symbols used (`Container`, `SelectList`, `SelectItem`, `Spacer`, `Text`, `Markdown`, `matchesKey`).
- No `before_agent_start` handlers, no `sendUserMessage()` / `ctx.isIdle()` usage (the 1.2.0-era break classes are
  inert — re-verified).
- Fixes that land in our paths: the `ctx.ui.custom({ overlay: true })` `done()` fix (#10648 — our drill-in overlay
  uses `overlay: true`); transient-provider auto-retry for upstream-stream / "temporarily unavailable" errors
  (#10920/#10965 — our connection-error friction class); malformed-JSON tool-call validation (#10897); codemode
  worker admission + abort/deadline fixes (#10748).
- Pi 1.3.0 **exact-pins** its internal deps: `@earendil-works/*` at 1.3.0, `typebox` at **1.3.27** — unchanged.

**Drift to close:** the four `@earendil-works/*` devDependencies pin `^1.2.0` (lockfile installs 1.2.0) while the
host is 1.3.0. **`typebox` already matches** the host's exact 1.3.27 pin — do NOT touch it.

## Recon (Rule 13 — codegraph @ 252d44f)

- target: `src/tui.ts` (file: src/tui.ts) — the value-import surface
- impact(tui.ts, depth 2): 15 affected symbols across 15 files — `src/tui.ts`, `src/index.ts`, and 13 test files
  (incl. `recovery-boot-notice.test.ts`, `recovery-retry-after-boot.test.ts`, `terminal-notice-dedupe.test.ts`)
- affected(src/tui.ts): 13 test file(s)
- **grep delta:** 88 raw hits for `tui` (incl. comments/strings) — consistent with the graph's consumer list; no
  consumer the graph missed. **Coverage boundary:** the graph indexes `src/**` only — `package.json` /
  `package-lock.json` are OUTSIDE it, so the dependency surface is verified by `npm ls` + `tsc` + the suite instead
  (recorded, not silently skipped).

## The change

1. `package.json` devDependencies → `"^1.3.0"`: `@earendil-works/pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-tui`.
2. **Leave everything else alone** — in particular `typebox` stays exactly `1.3.27` (already the host pin).
3. `npm install` **inside the isolated worktree only** (never the cockpit/shared tree); refresh
   `package-lock.json`. Expected churn: the four plus their transitive `pi-codemode` / `pi-mcp` / `pi-telemetry` at
   1.3.0; no removals expected (chord/esbuild already left at the 1.2.0 bump).
4. No source changes. If tsc/suite fails in a way indicating a REAL 1.3.0 incompatibility in our code, STOP and
   report — do not patch source (the compatibility check expects none).

## Verification (in the worktree)

- `npx tsc --noEmit` clean.
- Full suite (`npx vitest run`) — report file/test counts.
- `npm ls @earendil-works/pi-coding-agent @earendil-works/pi-tui @earendil-works/pi-ai @earendil-works/pi-agent-core typebox` — report resolved versions.
- `git diff --check`; `git diff package.json` (range diff in Evidence).

## Post-merge (conductor)

1. `npm ci` in the cockpit (rule 2) → the shared tree moves to 1.3.0.
2. Switch the running install back to the dev checkout (`pi remove npm:brl-subagent` → `pi install <dev path>`) +
   `/reload` — the cycle's dogfood then starts fully 1.3.0-aligned.

## Out of scope

`typebox` changes; `$schema` adoption; any behavior/source change.

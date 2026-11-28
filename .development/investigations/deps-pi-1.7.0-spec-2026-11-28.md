# Dependency parity bump — @earendil-works/* → ^1.7.0

jev: low (0.68) · C3 · worktree y
→ **conductor rerate to C2** (same rationale as #333/#337: the bump changes the SDK line every module is
type-checked against and the runtime value imports resolve from. Jev's risk confidence was 0.31 with C2 at 0.46 —
the tripwire disagrees, and Rule 10 says re-read the plan, default UP).
Worktree: `../brl-subagent-wt-deps17` · branch `chore/deps-pi-1.7.0` (from `dev`; isolated prep
`--force-isolated`, rule 2 — dependency-bump worktrees are ALWAYS isolated).
Review: focused C2 (`focused-review`) — or a conductor diff read if the diff is exactly the four ranges.

## Context — pi 1.7.0 compatibility check (2026-11-28): NO breaking impact

**The one documented breaking change does not touch us.** 1.7.0's Breaking Changes section removes install
telemetry: the `/api/report-install` endpoint, the `enableInstallTelemetry` setting
(`SettingsManager.getEnableInstallTelemetry()` / `setEnableInstallTelemetry()`), and `PI_TELEMETRY`.

- **Zero source references.** `grep -rn --exclude-dir=node_modules --exclude-dir=.git -iE
  "enableInstallTelemetry|PI_TELEMETRY|report-install" .` → hits only in `.development/` prose, `.tmp/published/`
  and `package-lock.json` (the transitive `pi-telemetry` entry). **No `src/` hit.** Our only settings use is
  `SettingsManager.create(effectiveCwd)` (`src/session-manager.ts:1766`) passed through to `createAgentSession` /
  `DefaultResourceLoader` — we never read or write that key.
- **`pi-telemetry` survives transitively.** In 1.7.0 it is a dependency of `@earendil-works/pi-ai`, not of
  pi-coding-agent (it was never a direct dep in 1.6.1 either). The lockfile entry moves 1.6.1 → 1.7.0; it does not
  disappear. `node -e` over every `@earendil-works/*@1.7.0` package.json: only `pi-ai` names it.

**The public extension surface did not move.** The evidence is a byte-level d.ts comparison of the locally
installed 1.6.1 tree against the installed 1.7.0 tree (the running CLI is 1.7.0, so the new tree was already on
disk — no install was needed to answer this):

| Package | `dist/index.d.ts` |
|---|---|
| `pi-coding-agent` | **byte-identical** (md5 `4d265e155dc80be15a8c26cf9ae59fc3` both sides) |
| `pi-agent-core` | **byte-identical**; 0 changed d.ts files, 0 added/removed |
| `pi-ai` | differs by **one added export line**: `PiImageOptions` / `PiImageRequest` / `PiImageResponse` |
| `pi-tui` | differs by **one added export line**: `formatProgramResume*` / `takeProgramResumeToken` |

Every change in the four packages is **additive** or internal:

- `pi-coding-agent`: 13 d.ts files changed, all internal. Declared-module delta = `core/telemetry.d.ts`
  **removed**; `cli/agent-dir-arg.d.ts` + `modes/interactive/program-resume-reporter.d.ts` **added**. The only
  removals anywhere are the two telemetry methods (settings-manager.d.ts) and the `enableInstallTelemetry` key
  (settings-defaults.d.ts · settings-schema.d.ts). Everything else is additive: `imageOutput?`,
  `supportsReasoningReplay?` (model-config / pi-ai-schemas), `usesDefaultAgentDir()` (config), `resumeFlags`
  (cli/args), two `protected`/`private` editor members, doc comments (terminal-image, tools-manager).
- `pi-ai`: additive — new `pi-image` API in the `KnownImageApi` union (our `Api` is `KnownApi | (string & {})`, so
  it absorbs new members by construction), optional `aspectRatio`/`size` on `ImagesOptions`, optional
  `imageOutput` on usage.
- `pi-tui`: additive — new `program-resume` module. `editor.d.ts` gains private/protected members only.

**Pins that must not move, and don't.** pi 1.7.0 exact-pins `typebox = 1.3.27` — identical to our exact pin and to
1.6.1's. `peerDependencies` of pi-coding-agent are unchanged; `engines.node` unchanged at `>=22.19.0` (host
v24.14.1).

**Ratchets keyed to pi internals still hold** (these are the tests that would rot silently, not loudly):

- `src/__tests__/changelog-format.test.ts` quotes `parseChangelog` from pi's `dist/utils/changelog.js` as measured
  on 1.5.0. That file is **byte-identical** in 1.7.0 (7005 bytes both sides) — the quoted regex is still current.
- `src/__tests__/schema-json-only.test.ts` and the exact-bytes enum-error pin in `thinking-level-443.test.ts` rest on
  `@earendil-works/pi-schema` validation. `diff -rq` of the pi-schema `dist/` **1.6.1 vs 1.7.0 → no output**, i.e.
  identical. The pins hold.

**Runtime value-import probe (expected signature stated before running: every listed symbol resolves to a
non-undefined export, exit 0).** A `/tmp` ESM probe imported the 1.7.0 packages directly and checked the **15**
value symbols our `src/` and tests consume:

```
ok pi-coding-agent :: withFileMutationQueue ... getAgentDir, DefaultResourceLoader,
                       SessionManager, SettingsManager, createAgentSession, ModelRegistry, ModelRuntime
ok pi-tui          :: Container, SelectList, Spacer, Text, Markdown, matchesKey, visibleWidth
PROBE PASS — every value import resolves in 1.7.0   (exit 0)
```

**Drift to close:** the four `@earendil-works/*` devDependencies pin `^1.6.0` and the lockfile resolves **1.6.1**
while the host executes **1.7.0**. `check-repo.sh` already reports this as the expected mid-cycle state:
`~ pi runtime 1.7.0 is AHEAD of lockfile SDK 1.6.1 — expected mid-cycle; the pi-sdk group bump will align (probe
before trusting)`. This spec is that bump. **`typebox` already matches** the host's exact 1.3.27 pin — do NOT touch
it.

## Recon (Rule 13 — codegraph @ 35331b5)

- target: `src/session-manager.ts` (file: src/session-manager.ts) — the dynamic value-import site
  (`getAgentDir`, `createAgentSession`, `SessionManager`, `SettingsManager`, `DefaultResourceLoader`)
- impact(session-manager.ts, depth 2): 54 affected symbols across 54 files — src/session-manager.ts and 53 test
  files
- affected(src/session-manager.ts): 56 test file(s)
- **grep delta:** 214 raw hits for `session-manager` (incl. comments/strings). The value-import surface was then
  enumerated directly: `grep -rn --include=*.ts "^import {" src | grep "@earendil-works"` → 8 files (2 in `src/`:
  `tui.ts`, `runner.ts`; 6 in `src/__tests__/`) plus the `await import(...)` at `session-manager.ts:1734`.
  **Coverage boundary:** the graph indexes `src/**` only — `package.json` / `package-lock.json` are OUTSIDE it, so the
  dependency surface is verified by the d.ts comparison + the runtime probe + `tsc` + the suite instead (recorded,
  not silently skipped). That comparison is the primary evidence above; the graph only scopes the consumer set.

## The change

1. `package.json` devDependencies → `"^1.7.0"`: `@earendil-works/pi-agent-core`, `pi-ai`, `pi-coding-agent`, `pi-tui`.
2. **Leave everything else alone** — in particular `typebox` stays exactly `1.3.27` (already the host pin), and
   `peerDependencies` stay `"*"`.
3. `npm install` **inside the isolated worktree only** (never the cockpit/shared tree); refresh
   `package-lock.json`. Expected churn: the four plus their transitive `pi-codemode` / `pi-mcp` / `pi-ai`→`pi-telemetry`
   family at 1.7.0; **no removals expected**. Watch for: `pi-codemode`'s own dependency set, and whether the
   `@opentelemetry/api` optional peer of `pi-telemetry` shifts.
4. **No source changes.** The compatibility check predicts none. If tsc/suite fails in a way indicating a REAL
   1.7.0 incompatibility in our code, STOP and report — do not patch source.

## Verification (in the worktree)

- `npx tsc --noEmit` clean.
- Full suite (`npx vitest run`) — report file/test counts and **reconcile against the baseline** `5b4da67`:
  **150 files / 3451 (3450 passed, 0 failed, 1 skipped)**. Any delta must be explained by a source change, and
  there is none.
- `npm ls @earendil-works/pi-coding-agent @earendil-works/pi-tui @earendil-works/pi-ai @earendil-works/pi-agent-core typebox`
  — report resolved versions; all four at 1.7.0, typebox a single deduped 1.3.27.
- `git diff --check`; `git diff package.json` (range diff in Evidence).
- `git diff --stat` is **package.json + package-lock.json only**.

## Post-merge (conductor)

1. `npm ci` in the cockpit (rule 2) → the shared tree moves to 1.7.0. `check-repo.sh` should then report
   `pi runtime 1.7.0 matches lockfile SDK`.
2. **No release implied:** devDependencies are not in the tarball (the precedent from #510/#337).
3. `.development/handoff/state.md` currently claims the running install is "on pi **1.6.1**" — **already stale**
   (the host is 1.7.0); correct that line in the same handoff commit as this unit's close.

## Out of scope

`typebox` changes; any `src/` change; adopting the new 1.7.0 features (OSC 7577 program resume, codemode image
generation, `--agent-dir`) — noted as available, not taken.

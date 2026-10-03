# Pre-flight: coupled migration to `@earendil-works/*` 1.0.0 + TypeScript 7.0.2 (#255)

- Worktree: `brl-subagent-wt-255` (branch `chore/255-sdk-1.0-ts7-preflight`)
- Base: `dev` @ `b90f638`, isolated `npm ci` tree
- Environment: node v24.14.1, npm 11.11.0
- Runtime context: pi 1.0.0 already; types were 0.87.1; compiler was TS 5.9.3
- Status: **not committed** (vitest gate red). Working tree holds the bump + `erasableSyntaxOnly`.

## 1. Versions resolved

Command (Step 1):

```
npm install -D @earendil-works/pi-agent-core@1.0.0 @earendil-works/pi-ai@1.0.0 \
  @earendil-works/pi-coding-agent@1.0.0 @earendil-works/pi-tui@1.0.0 \
  typebox@1.3.34 typescript@7.0.2
```

`npm ls ... --depth=0` result (all four moved, typebox already at target):

| package | before | after |
|---|---|---|
| @earendil-works/pi-agent-core | 0.87.1 | **1.0.0** |
| @earendil-works/pi-ai | 0.87.1 | **1.0.0** |
| @earendil-works/pi-coding-agent | 0.87.1 | **1.0.0** |
| @earendil-works/pi-tui | 0.87.1 | **1.0.0** |
| typebox | 1.3.34 | 1.3.34 (unchanged) |
| typescript | 5.9.3 | **7.0.2** |

`npm install` exit 0. `npx tsc --version` → `Version 7.0.2`; `node_modules/typescript/package.json` → 7.0.2.

## 2. `npm run typecheck` under TS 7 + SDK 1.0.0 — source tree

```
> brl-subagent@2.3.9 typecheck
> tsc --noEmit
```

- **exit code: 0**
- **error inventory: empty** (raw: `raw-typecheck-src.txt`, 0 bytes)
- All 33 non-test `src/**/*.ts` files were confirmed in the program (`tsc --listFiles`), and a deliberate probe error was surfaced by the same invocation before removal — the 0 is a real pass, not a misconfiguration.
- **Fixes applied: 0.** No type renames, signature changes, or import moves were required for the source tree. The SDK 1.0.0 type surface is source-code compatible with our 0.87.1-era usage.

## 3. `erasableSyntaxOnly`

Added `"erasableSyntaxOnly": true` to `tsconfig.json` `compilerOptions`. TS 7 accepts the flag name (no unknown-option error). Re-run tsc: **exit 0, 0 errors** — the tree passes cleanly with the flag on. No non-erasable constructs (enums, namespaces, parameter properties) exist in `src/`.

## 4. Test-typecheck cost (tests temporarily included)

`src/__tests__` exclusion removed; `tsc --noEmit` → **exit 1, 218 errors**. Raw: `raw-typecheck-incl-tests.txt`.

Errors by code:

| code | count | meaning |
|---|---|---|
| TS2339 | 93 | property does not exist on type |
| TS2740 | 51 | fixture/mock missing required properties |
| TS2694 | 26 | namespace has no exported member |
| TS2322 | 21 | type not assignable |
| TS7006 | 8 | implicit any parameter |
| TS2345 | 8 | bad argument type |
| TS2304 | 3 | cannot find name |
| TS2459 | 2 | declared locally but not exported |
| TS7016 | 1 | no declaration file for `.mjs` import |
| TS2724 | 1 | `"vitest"` has no exported member `bench` (did you mean `Bench`) |
| TS2353 | 1 | unknown object-literal property |
| TS2352 | 1 | conversion may be a mistake |
| TS2344 | 1 | type does not satisfy `never` constraint |
| TS18048 | 1 | possibly undefined |

By file: `integration.test.ts` 49, `terminal-status-consistency.test.ts` 49, `session-manager.test.ts` 29, `runtime-vocabulary.test.ts` 24, `chain-parallel.test.ts` 20, `architecture-rules.test.ts` 11, `templates-files.test.ts` 9, `git.test.ts` 9, others ≤5.

Characterization (three causes):

1. **TS 7 programmatic-API relocation** (~44 errors, TS2339/TS2694 in `architecture-rules.test.ts`, `runtime-vocabulary.test.ts`, `terminal-status-consistency.test.ts`): `import ts from "typescript"` now resolves to `node_modules/typescript/lib/version` (a stub exporting only `version`). `createSourceFile`, `ScriptTarget`, `SyntaxKind`, `ScriptKind`, `forEachChild`, and the `is*` type guards are gone from the root entry.
2. **SDK 1.0.0 fixture/mock drift** (TS2740/TS2322/TS2345/TS2353, notably `integration.test.ts` 48×TS2740, `chain-parallel.test.ts` 20×TS2322): test doubles no longer satisfy widened interfaces — `SessionState` now needs `subagentSessions`, `_finalizedLiveIds`, `builtinTemplates`, `log` (+~20 more); `ExtensionContext` needs `mode`, `hasUI`, `cwd`, `sessionManager` (+12); `UsageStats` needs `cacheRead`, `cacheWrite`, `contextTokens`; `AgentToolResult` shape changed.
3. **Misc typing hygiene** (TS2304 `ExtensionContext`, TS2459 `TranscriptMessage` not re-exported, TS7016 `.mjs` import, TS7006 implicit `any`, TS2724 vitest `bench`).

**Recommendation:** keep `src/__tests__` excluded. Including tests is **not** clean (218 errors) and cannot be made clean without substantial test-fixture rework (cause 2) plus a TS 7 API migration (cause 1) — not achievable as a pre-flight change and not required to land the bump. Restored the exclusion; tsc re-verified at exit 0.

## 5. Gate: `npx vitest run`

- **exit code: 1**
- **Test Files 4 failed | 54 passed (58)**; **Tests 51 failed | 1129 passed (1180)**.
- Baseline was 58 files / 1212 tests green. Gap of 32 tests = exactly the 32 `it()` blocks in `terminal-status-consistency.test.ts`, which throw at **import/collection time** and are therefore never counted.
- **All 51 failures share one root cause, and it is behavior-shaped, not a type issue:**

```
TypeError: Cannot read properties of undefined (reading 'Latest')
TypeError: Cannot read properties of undefined (reading 'EqualsEqualsToken')
```

Affected files and the `typescript` root-API usage that breaks:

| file | failing tests | shape |
|---|---|---|
| `src/__tests__/architecture-rules.test.ts` | 7 | `ts.createSourceFile` / `ts.ScriptTarget` / type guards |
| `src/__tests__/runtime-vocabulary.test.ts` | 16 | `ts.createSourceFile` / `ts.forEachChild` / `is*` |
| `src/__tests__/terminal-status-consistency.test.ts` | 32 (collection) | top-level `new Set([ts.SyntaxKind.EqualsEqualsToken, …])` |
| `src/__tests__/smoke-artifact-scanner.test.ts` | 28 | imports `.github/scripts/smoke-artifact.mjs` |

The last row is **production CI tooling, not test code**: `.github/scripts/smoke-artifact.mjs:240` calls `ts.createSourceFile(filePath, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS)`. Under TS 7 the `typescript` root export is the version-only stub (`lib/version.cjs` ⇒ `exports.version`, no compiler API), so `ts.ScriptTarget` is `undefined`. This is a runtime regression in the smoke scanner under TS 7.

Per task scope this is **stopped and reported, not fixed**: it is a semantic/API relocation, not a type rename or signature-compatible change. TS 7 exposes the AST under `typescript/unstable/ast` (enums: `ScriptTarget`, `SyntaxKind`, `ScriptKind`; `is*` guards; `visitor`; `scanner`) and parsing via the `typescript/unstable/sync` `Project`/`Program` API — there is no drop-in `ts.createSourceFile` on the root. Migrating the 4 call sites is real work.

## 6. Recommendation: **needs-work**

Not `park`: the SDK 1.0.0 bump is source- and test-runtime-compatible on its own (0 source typecheck errors; no SDK-caused vitest failures), and TS 7 typechecks our source cleanly with `erasableSyntaxOnly` enabled, so the coupled bump is viable.

Remaining items before landing:

1. Migrate the 3 test files + `.github/scripts/smoke-artifact.mjs` off the removed `typescript` root compiler API to TS 7's `typescript/unstable/ast` (+ possibly `unstable/sync`) entry points. This is the sole blocker for the vitest gate; **1 root cause, 4 files, 51 tests**.
2. (Only if tests are ever brought into `typecheck`) resolve the 218 test-file type errors — dominated by SDK 1.0.0 fixture/mock drift (`SessionState`, `ExtensionContext`, `UsageStats`, `AgentToolResult`) and the same TS 7 API issue. Out of scope here; tests stay excluded.
3. Confirm the SDK Dependabot PR and the TS 7 PR are landed/sequenced together; TS 7 is the gating change.

## 7. Branch state

**Uncommitted, tree intact.** No commit or push was made (vitest gate red). Working tree changes:

- `package.json`, `package-lock.json` — dependency bump (Step 1)
- `tsconfig.json` — `+ "erasableSyntaxOnly": true` (Step 3) — source typecheck remains green
- `.development/investigations/pi-sdk-1.0.0-ts7-preflight/` — this report + raw logs (intentionally not staged)

## Coverage boundaries

- This pre-flight measures **static types (tsc)** and the **existing vitest suite**. It does **not** prove runtime behavior of the extension under the bumped types outside those tests — no live pi probe / smoke boot was run with SDK 1.0.0. The handoff notes a live smoke was done for pi 1.0.0 separately; not repeated here.
- `.github/scripts/smoke-artifact.mjs` runtime breakage is inferred from the vitest failure and direct source inspection; the CI workflow itself was not executed.
- Test-typecheck numbers reflect the tree at `b90f638` + this bump only.

## Decisive experiment (conductor, 2026-10-02)

The pre-flight bumped the compiler and the SDK together, confounding the two variables. Re-ran with **only the SDK bumped** — `typescript` back at **5.9.3**, keeping the SDK family at **1.0.0**, typebox **1.3.34**, and `erasableSyntaxOnly: true`:

| Configuration | `npm run typecheck` | `npx vitest run` |
|---|---|---|
| SDK 1.0.0 + TS 7.0.2 | 0 errors | RED — 4 files / 51 tests (TS root AST API removed) |
| **SDK 1.0.0 + TS 5.9.3** | **exit 0** | **58 files / 1212 tests (exact baseline)** |

## Final verdict

- **SDK bump: SHIP — self-contained.** Not one source or test change; compiles against the 1.0.0 declarations under the existing compiler (the "TS 5.9 cannot read 1.0.0's `.d.ts`" hypothesis did not materialize). The 28-case `smoke-artifact-scanner` suite passes, so the release scanner is unaffected by the SDK bump. Branch `chore/255-sdk-1.0-ts7-preflight` carries the validated commit.
- **TypeScript 7: PARK.** Its root export is a 2-key stub — `createSourceFile`/`SyntaxKind` are gone; the AST lives under `typescript/unstable/*` subpaths. Migrating is mandatory for three ratchet tests plus the release-critical `.github/scripts/smoke-artifact.mjs`, and depending a release gate on an unstable API buys nothing functional today. Revisit when the AST API stabilizes (or an official migration path exists); then this experiment is the starting point.
- `erasableSyntaxOnly: true` rides with the SDK bump (it passes now and pins the property that pi's direct TS-source loading depends on).

Coverage boundary: static types + the existing suite only — no live boot/smoke probe with the migrated tree (the runtime itself was already smoke-verified on pi 1.0.0 on 2026-10-02), and the CI workflow itself was not executed locally.

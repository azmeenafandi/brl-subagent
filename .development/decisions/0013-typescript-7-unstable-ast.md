# 0013. TypeScript 7: the AST lives behind one unstable-API adapter

- **Status:** Accepted
- **Date:** 2026-10-03
- **Issues:** #256
- **Refined by:** ADR 0014 (one long-lived API client per worker; `fileChanges` is required by the tsgo content cache)

## Context

TypeScript 7 removed the classic compiler API from the package root. `import ts from "typescript"` now resolves to a version-only module: `ts.createSourceFile`, `ts.SyntaxKind`, and the `ts.is*` predicates are gone. The AST API moved to the explicitly unstable subpaths `typescript/unstable/ast`, `typescript/unstable/ast/is`, and `typescript/unstable/sync`.

Four guards depend on that AST: the architecture fitness functions (#251), the runtime-string vocabulary ratchet (#183), the terminal-status structural guard (#186), and the release-gating packaging scanner (`.github/scripts/smoke-artifact.mjs`, #176). Letting each import the unstable subpaths directly would spread an API that upstream reserves the right to change across four unrelated files, so a future TS major would be four migrations.

The production `src/` tree typechecks clean under TS 7 and ES2024 with no source changes — only the AST consumers were affected.

## Decision

- **Pin `typescript` exactly at `7.0.2`** (no caret) in `devDependencies`. A TS major is a deliberate migration, not a routine bump: the compiler, the emitted target, and the unstable AST API move together.
- **All `typescript/unstable/*` imports live in one file, `scripts/ts-ast.mjs`** — the containment boundary. It re-exports `SyntaxKind`, the 22 `ts.is*` predicates the consumers use, and one `parseTexts(entries)` helper that parses a batch of in-memory sources through a single synthetic project (`noResolve`/`noLib`/`types: []`), and always closes the API before returning.
- **Consumers import predicates and the parse helper from `scripts/ts-ast.mjs` only.** Tree sweeps call `parseTexts` once per run (not once per file); per-fixture calls are a single-entry batch.
- **`scripts/ts-ast.d.mts` re-exports the node types** (`Node`, `SourceFile`, …) so the guards stay typed without importing the unstable path.
- **`target` moves to `es2024`**, the companion runtime level for TS 7. `module`, `moduleResolution`, `strict`, `noEmit`, and `erasableSyntaxOnly` are unchanged.
- **The walk itself is untouched:** `forEachChild`, `.kind === SyntaxKind.ImportKeyword`, type-only discrimination, and line/character reporting via `getLineAndCharacterOfPosition` are identical to the pre-migration code.
- **Upstream reference:** `earendil-works/pi`'s `scripts/check-ts-relative-imports.mjs` and `scripts/check-runtime-deps.mjs` are the same class of tool and established the `unstable/ast` + `unstable/sync` pattern followed here.

## Consequences

- A future TS major's AST churn is a one-file fix in `scripts/ts-ast.mjs`; the four guards are insulated.
- `npm run typecheck` and the full vitest suite pass under TS 7 targeting ES2024; the shipped npm artifact and runtime behaviour are unchanged (dev tooling only).
- The adapter's `parseTexts` returns only `SourceFile`s, so a consumer cannot accidentally reach the wider unstable surface through it.
- The `unstable/*` prefix is load-bearing: it is upstream's signal that these paths may change without a major, which is exactly why this boundary exists and why consumers must not import past it.

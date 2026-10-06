# 0014. The TS7 AST adapter reuses one API client per worker

- **Status:** Accepted
- **Date:** 2026-10-06
- **Issues:** #284
- **Refines:** 0013

## Context

ADR 0013 put every `typescript/unstable/*` import behind `scripts/ts-ast.mjs` and had `parseTexts()` construct a fresh `unstable/sync` `API` per call, closing it in `finally`. Each construction spawns the Go-native compiler (`@typescript/typescript-linux-x64/lib/tsc`) and each `close()` kills it: **~92 spawn/kill pairs per full suite run**. Under load the kill races the Go server's shutdown, which logs the Go `context.Canceled` string (`context canceled`) to its inherited stderr — 13 lines of third-party noise per run, and the sole our-side lever identified in #277 item 3 (investigation record: `.development/investigations/277-context-canceled/`).

## Decision

- **One lazily-created `API` client per process/worker**, reused across `parseTexts()` calls and closed once via a `process.once("exit", …)` hook. Measured: tsgo spawns **92 → 4** per full suite run (one per AST-using worker), `context canceled` **13 → 0**.
- **Every call gets a unique synthetic config path** (`.ts-ast-virtual-project-<n>.json`, module counter) so a reused client cannot serve a stale program for a path whose file set changed.
- **Every call passes `updateSnapshot({ openProjects, fileChanges: { changed: files } })`.** This is required, not decorative: the tsgo server caches virtual file content **by path**, so a client that outlives one call serves stale text for a reused path (e.g. the per-fixture `fixture.ts` scans). The per-call client never needed it only because each fresh child started with an empty cache. Discovering this cost 32 red tests during #284.
- **The `fs` hooks read a module-level `currentRequest` slot** set immediately before `updateSnapshot` and cleared in `finally` — safe because the sync API is single-threaded per worker (a call runs to completion before another can start).
- **No new public exports:** `parseTexts`'s signature and return type are unchanged; `scripts/ts-ast.d.mts` untouched.

## Consequences

- One tsgo process per worker instead of ~92 per suite run: far less process churn and, in practice, no kill-race noise. A rare residual race (visible only outside the suite) is third-party and cannot be suppressed from this repo.
- The wall-clock delta is negligible at suite scale (~0.1 s): the startup cost was parallelized away. The value is process churn, noise, and kill-race surface — not speed.
- Any future change back to per-call clients silently re-opens both the churn and the `context canceled` noise. If someone does it, re-measure spawns and noise first; `.development/investigations/277-context-canceled/repro-tsgo.mjs` reproduces the mechanism outside the suite.
- ADR 0013's Decision bullet "always closes the API before returning" is refined by this record: closure is now once per process, not per call.

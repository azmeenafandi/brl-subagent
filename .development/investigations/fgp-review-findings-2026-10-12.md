# FGP review findings — PR #328 @ `e1791c4` (reviewer: `meta/muse-spark-1.3-contributor`)

**Verdict: approve-with-nits** (2026-10-12). Close-out: both nits fixed in `be9a4a0` (conductor-verified: tsc clean,
suite 73/1500, CI success) before merge.

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| minor | `src/run-registry.ts:158` | An array passes the `typeof === "object"` leniency and is retained instead of degrading to absent (harmless downstream — property reads yield `undefined` — but it contradicts the documented "non-null object" claim; proven empirically `ARRAY_KEPT=true`). Fixed with a plain-object guard + a regression test. |
| minor | `src/index.ts:3367-3376` | The retire comment's "leaves the source intact and retryable" omits the pre-existing dangling NEW entry (`persistRun` precedes the circuit/slot gates): a failed FG retry pre-start leaves TWO rows for the next boot (source + dangling twin). The bug predates the PR — interaction/comment accuracy only. Comment corrected; the dangling-row bug is backlogged. |

## Verified-OK (reviewer's, condensed)

- **D1:** optional 5-field enrichment on both interfaces; undefined-safe `mergeInput` copies; `toRegistryInput` mapping; lenient `normalizeEnrichment`; `isInflightRun` unextended.
- **D2:** `run?.X ?? agent?.X ?? entry.X` ×4 + unconditional `originalParams` forward; `view.originalParams ?? {model, thinkingLevel, background?}`; posture precedence untouched.
- **D3:** hint re-scoped to pre-enrichment entries; delivery still `nextTurn`.
- **D4:** FG clear after `acquireSlot`; BG clear after `startBackgroundAgent` inside the try; throwing spawn leaves the source intact; unit retries impossible.
- **`force`:** wholesale snapshot restores it; explicit caller wins; no other injector.
- **Retire window:** clear-to-start gap is one cached dynamic import (FG) / infallible bookkeeping (BG); **no clear-without-start or double-start construction**.
- **Tampered fields never trusted:** scalars degrade to absent → loud sanitizer reject; restored `cwd`/`outputFile`/`tools` re-validated post-resolution; 50KB task cap enforced.
- **Round-trip choke complete:** all writers via `mergeInput` or preserving spread; all readers via `normalizeEnrichment`; old-shape both directions tested.
- Docs match the §7 maintainer decision (O3 + `force` restored + retire fold).
- **Gate A:** typecheck 0; 73/1499 (then 1500 after the nit test); targeted 57 ×3; docs guards current; README guard pass (drift 99/100); `git diff --check` clean; `pgrep` clean; stores untouched.
- **Mutations M1 (2 fail), M2 (3 fail), M3 (2 fail), M4 (2 fail)** all confirmed on scratch with pre-stated signatures.
- **SOLID/DRY violations flagged: 0.**

## Carried backlog

- **Dangling-row bug (pre-existing, separate fix):** the circuit-open and slot-cancelled early returns after `persistRun` never finalize the run → a `running` session + registry entry lingers; a failed pre-start retry can leave a dangling NEW twin. Predates FGP; interaction only.

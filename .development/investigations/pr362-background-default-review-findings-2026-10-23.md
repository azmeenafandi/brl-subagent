# REVIEW — PR #362 (conditional `background` default) @ `7f12911`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — focused C2. Issue #361. Jev: **medium (0.93) · C2**.
Diff `cd2751d..HEAD`: `src/params.ts` (`resolveEffectiveApprovalMode`, `defaultBackgroundFor`, `DispatchShape`),
`src/index.ts` (explicit-only guard, `useBackground`, `params.background ??= useBackground`), `src/schema.ts`, the
new `background-default.test.ts`, `AGENT.md`/`README.md`/`CHANGELOG.md`.

**Verdict: approve-with-nits** (2 minors) → fixed `a3618bf` → merged `7b3f6b9`.

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| minor | `src/index.ts:3074` + `:3111` | Probes (b)/(c) pass 14/14 in isolation — the guard's `=== true` strictness and the `??=`-below-guard ordering are unpinned individually; only their conjunction with `defaultBackgroundFor` is pinned |
| minor | `src/params.ts:129` | `resolveEffectiveApprovalMode` doc header names a "preset" tier that does not exist (the header overstated the chain) |

## Verified-OK

- **Matrix (14/14 new tests; 82 files / 1699 at review, tsc clean):** omitted single+auto → background (agent id +
  wake text); omitted `tasks`+auto → fan-out (ordered ids); omitted chain/graph → foreground, **no rejection**,
  `runSubagent` 2×/1×, zero spawns; omitted configured `always`/`writes` and per-call `writes` → foreground; explicit
  `true`+chain/graph → verbatim rejection; explicit `false`+auto → foreground; explicit `true`+`always` → verbatim W5
  rejection.
- **Effective mode:** `SubagentPreset` carries no `approvalMode` (preset tier absent by design); the helper is the
  single source used by the dispatch chokepoint and `resolveSubagentParams`.
- **Approval paths:** the `always`-rejection and `writes`-auto-approve paths are unreachable by default (the default
  routes gated modes foreground) and fire only on an explicit `true`.
- **Retry:** `capturedOriginalParams().background === true` pins the `??=` recording; fan-out units omit shape fields
  so units still retry as single foreground runs (#229 semantics preserved).
- **Docs:** the five surfaces match the implemented matrix (tool guideline, schema description, AGENT.md, README,
  CHANGELOG), including the 30-min deadline and the `background:false`-for-inline-answer note.
- **Gate A:** all five mutation probes + combined (a)+(b) ran against scratch-mutated sources; tree restored
  (md5-verified, `git status` empty).

SOLID/DRY violations flagged: 0

## Disposition (2026-10-23)

- **Minor 1: FIXED** in `a3618bf` — `shouldRejectBackgroundForBatch(shape, explicit)` extracted and unit-tested
  (chain/graph × true/undefined/false), the explicit value captured before the default recording; both mutations
  (truthy predicate; ordering) now fail.
- **Minor 2: FIXED** — the docstring states the real chain (param → configured default).
- **Process catch (not a PR finding):** CI was red on the README **test-count guard** (claim "1600+", actual 1701 —
  drift limit 100) on both the impl and fix commits; neither the implementer nor the review checked `gh pr checks`.
  Fixed conductor-side (`bb74064`, README → "1700+"), CI green, merged `7b3f6b9`. Friction logged; the PR skill now
  says a PR is not complete until CI is green.

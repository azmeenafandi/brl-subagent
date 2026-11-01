# REVIEW — PR #389 (#379 commit 1: typed resolver input, casts deleted) @ `a8a144f`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — focused C2, Jev **medium (0.92)**. Design authority:
`.development/investigations/mode-prologue-design-2026-10-25.md`.
Diff `f7fa1a3..HEAD`: `params.ts` (`ResolveInputParams`, `task?: string` + `?? ""`), `index.ts` (4 casts + workaround
deleted, `renderCall` typed), `integration.test.ts` (+1 test).

**Verdict: approve-with-nits** (2 minors) → fixed `18b6a7f` → merged `b6eff30`.

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| minor | `src/tui.ts:3061` | `renderDelegateCall` kept its hand-narrowed 11-key literal; only `renderCall` was retyped |
| minor | `integration.test.ts:381` | The new test pinned the resolver's `""` + no-auto-route, but not the three downstream readers |

## Verified-OK

- **Casts gone, not relocated:** `as Omit<Parameters` / `Omit<Parameters` → zero hits in `src/`; the four call sites are
  bare `resolveSubagentParams(params, …)`; the `spawnBackgroundRun` workaround type is replaced by a
  `DelegateTaskParams | ReturnType<typeof resolveRetryParams>` union; the sole `as DelegateTaskParams` survivor is the
  retry-path line (`index.ts:2964`, deferred to the structural guard); `tsc` proves the casts were unnecessary.
- **Absent-task neutrality at all three readers:** `index.ts:513` (`subTask.task || globalParams.task`),
  `validate.ts:296` (`config.task || ''`), `router.ts:128` (`if (!task …)`); `""` and `undefined` are identically falsy.
- **Latent path:** `displayTaskName`'s old `merged.task.length` TypeError is unreachable via schema-validated dispatch
  (steps require `task: Type.String`); programmatic misuse now yields `""` — strictly safer.
- **New test:** `resolveSubagentParams({}, …)` → `task === ""`, no auto-route (with an `auditorPreset` loaded so any
  empty-task match would fire) — genuine, not incidental.
- **`renderCall`:** typed `DelegateTaskParams`; the preview is unchanged (no `[preset:…]` badge anywhere in the render
  path); the runtime value is a structural superset of what the renderer reads.
- **Deferrals correct:** the retry cast and the `priority: string` looseness are genuinely out of this commit.
- **No collateral:** 87 files / 1756 tests, `tsc` clean, CI pass; the net −17 vs the note's −95 is the doc-block/ratchet
  additions (non-doc ≈ −98).

SOLID/DRY violations flagged: 0

## Disposition (2026-10-25)

- **Both minors FIXED** in `18b6a7f` — `renderDelegateCall` retyped to `DelegateTaskParams`; the three readers'
  `""` ≡ absent equivalence pinned (mutation: `||` → `??` fails an assertion). Suite **87 files / 1759**. Merged.
- Note: a transient `smoke-artifact-scanner` unhandled-close error on the first post-change run (passes in isolation,
  absent on baseline and on the clean re-run) — friction-logged as a flake.

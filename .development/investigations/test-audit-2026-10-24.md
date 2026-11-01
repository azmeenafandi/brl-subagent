# Test-suite audit — budget pins + mutation sample (issue #368)

Date: 2026-10-24 · jev: high (0.54) · risk C2 · worktree `chore/test-audit-368`
Spec: [`test-audit-spec-2026-10-24.md`](test-audit-spec-2026-10-24.md) (authoritative).

**Outcome: prune zero, add one pin.** Six modules were mutated; five mutations were killed on the first
targeted run, one survived (`run-registry`'s `markInterrupted` idempotence). The survivor was a genuine
missing pin — an interrupted run's original timestamp could be silently overwritten by a second boot scan —
and a test now kills that mutation. No test was deleted or rewritten, so there is no removal evidence to cite.
The e2e pair remains the wall's floor and the gate; consolidation is recommendation-only. The permanent-step
recommendation is at the end: keep the budget guard in CI and mutate **one module per cycle**.

Constraints honoured: no production source changes (mutations were temporary and restored), no
coverage-percentage gate, no mass deletion, and the intentional source-scan guards (`status-chokepoint`,
`architecture-rules`) were not re-litigated.

## 1. Measured profile

Environment: node 24.14.1 · vitest 5.0.5 · Linux x64 · audit worktree.
Command: `npx vitest run --reporter=default --reporter=json --outputFile=vitest-report.json`.

| Fact | Measured | Spec baseline |
|---|---|---|
| Suite (before the added pin) | **82 files / 1701 tests** | 82 / 1701 |
| Suite (final, with the one added pin) | **82 files / 1702 tests** | — |
| Wall (report `startTime` → last file `endTime`) | **15.50 s** before; **15.66 s** final | ~17 s local |
| Test LOC / source LOC | **34,433 / 21,238 = 1.62×** before; **34,444 / 21,238 = 1.62×** final | 1.62× |
| Runtime composition | **tests 56% · imports 40% · transform 3% · worker 1%** | tests 55% · imports 42% · transform 2% |

LOC is physical lines (`wc -l` semantics) over `src/**/*.ts`; files under a `__tests__` path segment count
as test, everything else as source. The added pin is 11 lines, hence 34,433 → 34,444.

### The wall is e2e-dominated

Per-file timings overlap across workers, so the wall is roughly the longest path, not the sum. The four
files above 1.1 s, with their offsets from the report start:

| File | Tests | Start | End | Duration |
|---|---:|---:|---:|---:|
| `e2e-subprocess.test.ts` | 7 | 4.53 s | **15.66 s** | 11.13 s |
| `recovery.test.ts` | 61 | 1.90 s | 12.88 s | 10.99 s |
| `e2e.test.ts` | 29 | 0.37 s | 5.99 s | 5.62 s |
| `preflight.test.ts` | 10 | 0.36 s | 1.84 s | 1.48 s |

The other **78 of 82 files finish in ≤ 1.1 s**. `e2e-subprocess.test.ts` is the last finisher and defines
the wall; `recovery.test.ts` overlaps it and is the other long pole. Removing `e2e-subprocess` alone would
move the wall only to ~12.9 s (recovery's end); removing both long poles would move it to ~6.0 s. Those are
real gates — Tier-2 subprocess integration and boot recovery — so this profile argues **against** touching
them for timing (recommendation only; out of scope by the spec). The import share (40%) is the second cost,
but it cannot move the wall while the e2e pair owns the critical path.

Dense unit files are cheap: `integration.test.ts` 108 tests / ~51 ms, `types` 69 / ~30 ms, `sanitize`
63 / ~25 ms, `validate` 58 / ~25 ms. There is nothing to buy by splitting them.

## 2. Budget guard

New: `scripts/check-test-budget.mjs`, wired into `.github/workflows/ci.yml` immediately after
`check-readme-test-count.mjs`. It reads the same `vitest-report.json` and fails when either ceiling is
breached:

- **Wall time ≤ 60 s** — derived from the report's own `startTime` and the latest file `endTime`, not measured
  by the script. Local wall is ~15.7 s, so the ceiling keeps ~3.8× headroom locally. CI runners are slower
  (the cycle profile measured CI near 50 s), which is why the ceiling is deliberately well above the local
  number: it catches runaway growth, not normal runner variance.
- **test:source LOC ratio ≤ 2.0** — counted from disk on every run (`src/**/*.ts`, `__tests__` split), never
  hardcoded. Current 1.62.

Both are **ceilings, not targets**: growth needs a reason, shrinking is always allowed. Failure messages name
the measured value, the limit, and the report path.

Evidence (real command output; fixtures in `/tmp`):

```
$ node scripts/check-test-budget.mjs /tmp/vitest-report-final.json
test-budget: wall 15.66s (<= 60.00s), LOC ratio 1.62 (34444 test / 21238 source, <= 2.0) — OK.

$ node scripts/check-test-budget.mjs /tmp/budget-wall-fixture/report.json   # endTime 61000
test-budget: wall time 61.00s exceeds the 60.00s ceiling (report: ...; the ceiling is a limit, not a target).

# fixture tree: 500 test lines / 200 source lines, wall 1 s
$ node scripts/check-test-budget.mjs report.json
test-budget: test:source LOC ratio 2.50 (500 test / 200 source) exceeds the 2.0 ceiling (the ceiling is a limit, not a target).
```

Both over-budget fixtures exit 1; the real suite exits 0. The ratio fixture is a separate `src/` tree so the
repository was never altered to prove the failure.

## 3. Mutation sample

Method: one mutation at a time. Each expectation was written **before** the run (predictions file:
`/tmp/test-audit-368/predictions.txt`), the exact find string was required to occur once, the targeted test
file(s) ran, the source was restored with `git checkout -- <file>`, and `git status --porcelain
--untracked-files=no` was verified clean after every mutant. Diffs and logs were captured per mutant. No
mutation required the escape clause; every one was behaviour-changing at the test layer.

| # | Module | Mutation (behaviour) | Pre-stated expectation | Observed | Failing test(s) |
|---|---|---|---|---|---|
| M1 | `kill-escalation` | Final group SIGKILL loop skips a target that `verifyDeath()` reports dead (`!target.forceKillGroup` → `!target.forceKillGroup \|\| target.verifyDeath()`) | KILLED — the dead-leader test still expects `GROUP_KILL` | **KILLED** | `escalateKill sends the final group SIGKILL even when the leader verifies dead` |
| M2 | `run-registry` | `markInterrupted` re-marks an already-marked entry (`if (existing.interruptedAt) return true` → `&& false`) | **SURVIVED** — no test marks the same id twice | **SURVIVED** | *(none)* |
| M3 | `session-manager` | Terminal settle prunes an interrupted run's session (`if (!agent.interruptedAt)` → `if (true)`) | KILLED — U2 T4 asserts the marked run keeps its file | **KILLED** | `keeps the session file even when the marked run later settles` |
| M4 | `validate` | Empty task short-circuits before the `outputFile` hard-conflict check (`!taskText.trim() && !config.outputFile` → `!taskText.trim()`) | KILLED — the empty-task + outputFile tests exist for this path | **KILLED** | `is invalid when outputFile is set with an empty task and write is excluded`; `… and write is missing from the allowlist` |
| M5 | `tui-format` | `formatElapsed` boundary `< 60` → `<= 60` (60 s stays seconds) | KILLED — the exactly-60-second boundary test | **KILLED** | `handles the exactly-60-second boundary` |
| M6 | `menu-config-items` (`src/tui.ts`) | Canonical `(current)` marker rendered as `(selected)` | KILLED — `withCurrentMarker` is asserted directly and every choice list is checked | **KILLED** | `only ever appends the single canonical \` (current)\` suffix` + 7 list/screen marker tests |

Five of six predictions matched and were killed. One prediction matched a survival: M2.

### Disposition — M2 (`run-registry`)

- **Evidence of survival (before the pin):** `npx vitest run src/__tests__/run-registry.test.ts` →
  `Tests 22 passed (22)` with the mutation applied. Nothing asserted what happens when `markInterrupted`
  runs twice on one entry.
- **Why it matters:** `markInterrupted`'s early return is not an implementation mirror. It preserves the
  **first** interruption timestamp; without it, a later boot scan rewrites `interruptedAt`, and the recovery
  surface's "how long has this been interrupted" age silently resets. The no-throw/boolean contract is
  separately pinned; the idempotence was not.
- **Disposition: missing pin — added** in `src/__tests__/run-registry.test.ts`:
  `markInterrupted is idempotent — a second mark preserves the first timestamp`.
- **Evidence the pin kills the mutation (after the pin):** the same M2 mutation now yields
  `Tests 1 failed | 22 passed (23)` → `markInterrupted is idempotent — a second mark preserves the first timestamp`.
  Without the mutation the file is `23 passed (23)`.

No survivor was judged an implementation mirror, so **no test was rewritten or deleted**; the report has no
removal-evidence lines because there were no removals.

## 4. Consolidation notes

- **Prune zero.** The sample found no test that only mirrors implementation. The e2e pair, the dense unit
  files, and the source-scan guards all pin behaviour or architecture, not spellings of the implementation.
- **e2e stays as the gate.** `e2e.test.ts` (Tier-1 jiti import) and `e2e-subprocess.test.ts` (Tier-2 stub
  `pi`) are the reason the wall is ~16 s. They are real integration coverage; no architecture change is
  recommended, and no test in this sample justifies touching them.
- **Import share (40%) is not free to buy.** Consolidating imports only helps if it reduces the critical
  path; while `e2e-subprocess` owns the last ~11 s, shaving import setup elsewhere does not move the wall.
  The vitest hint (`isolate: false` ≈ 1.2 s faster) is a config-level trade with isolation risk — noted,
  not adopted.
- **Dense unit files are cheap and sharp.** 108 tests in ~51 ms is exactly what a fast unit file should look
  like; splitting for size would be churn.
- **Intentional guards untouched.** `status-chokepoint` and `architecture-rules` are source-scan rules by
  design; they are out of this audit's scope.

## 5. Recommendation — make it a bounded cycle-end step

Adopt both halves, with different cadences:

1. **Budget guard: already permanent.** `scripts/check-test-budget.mjs` runs in CI on every push/PR. No cycle
   action needed beyond reading a red as "growth needs a reason".
2. **Mutation sample: one module per cycle.** At each cycle end, pick the next module from a fixed rotation
   across hazard classes — process kill (`kill-escalation`), durable state (`run-registry`), background
   lifecycle (`session-manager`), pre-flight (`validate`), pure formatting (`tui-format`), and the newest
   menu/config surface (`menu-config-items`/`src/tui.ts`). Pre-state the expected failure, run only that
   module's targeted test file(s), restore, and record one line in the cycle's investigation note:
   killed, or survivor + disposition (pin by default; rewrite/delete only with the surviving mutation as
   evidence).
3. **Bound it.** One module is ~1–2 minutes including setup; the six-module sample above is a one-off audit,
   not a per-cycle cost. If a cycle has no mutation-worthy change in the next module, skip it and say so —
   the honest outcome may again be "prune zero, add pins".

This keeps the audit cheap, rotating, and evidence-first without adding a new permanent script or a
coverage-percentage gate.

## Limitations

- The wall is local-worktree wall (15.5–15.7 s); CI is slower. The guard reads vitest's own timing and keeps
  the 60 s ceiling, but if CI consistently approaches it, the right response is an evidence-backed ceiling
  review, not test deletion.
- The sample covers 6 of ~40 source modules (~15%), chosen by hazard class rather than randomly. It is a
  sample, not a proof of suite-wide mutation adequacy.
- Mutation testing was manual and targeted (one mutant per module), not a full mutation-score run.

## Verification

- Full suite: **82 files / 1702 tests passed** (`npx vitest run`), final wall 15.66 s.
- `npx tsc --noEmit`: clean.
- `git diff --check`: clean.
- Budget guard: passes the real report; fails both the over-budget wall fixture and the over-ratio fixture.
- Tree restored after every mutant; each mutant log records the clean-after check.

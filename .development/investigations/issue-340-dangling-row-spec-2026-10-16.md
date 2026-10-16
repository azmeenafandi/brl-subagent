# #340 dangling-row fix — finalize pre-start gate rejections (foreground path)

jev: medium (0.76) · risk C1 · worktree y — consistent (no deviation; clamp satisfied).
Worktree: `../brl-subagent-wt-340` · branch `fix/340-dangling-row` (from `dev`; lockfiles match → symlinked prep).
Review: **C1 full adversarial** (`project-reviewer` preset + `adversarial-review` template); review model chosen by
the maintainer at review dispatch.

## Context

Found by the FGP review (PR #328; `fgp-review-findings-2026-10-12.md`), carried as backlog, chosen by the maintainer
as the cycle's stretch unit (2026-10-16) — issue **#340**.

In the foreground single-run path (`src/index.ts`, the subagent tool execute), `state.persistRun(pi, run,
"foreground")` runs **before** `state.checkCircuit()` and `acquireSlot(...)`. Both gates return early with only
`cleanupGitBranch()`, so the persisted record never leaves `running`: the session entry stays non-terminal, the
inflight registry row (written by `persistRunRecord`, kind `"foreground"`) is never cleared, and the live-monitor
registration is never released. At the next boot the registry row is marked interrupted and surfaced as a **phantom
interrupted run** (boot notice + retry/abandon offer) for a dispatch that never started. On a *retried* dispatch the
same failure leaves the source row plus a dangling NEW twin — two rows for the next boot.

## Recon (Rule 13 — codegraph @ 91d4b2b)

```
## Recon (Rule 13 — codegraph @ 91d4b2b)
- target: `persistRunRecord`
- callers(persistRunRecord):
  - 7 caller(s)
  - src/__tests__/recovery-surface.test.ts:1 (recovery-surface.test.ts)
  - src/__tests__/run-registry.test.ts:1 (run-registry.test.ts)
  - src/session-manager.ts:699 (finalizeRunEntry)
  - src/session-manager.ts:474 (spawnBackgroundSession)
  - src/state.ts:267 (persistRun)
  - src/session-manager.ts:1 (session-manager.ts)
  - src/state.ts:1 (state.ts)
- impact(persistRunRecord, depth 2):
  - 39 affected symbols across 27 files
  - files: src/run-registry.ts, src/__tests__/recovery-surface.test.ts, src/__tests__/run-registry.test.ts,
    src/session-manager.ts, src/__tests__/background-session-persistence.test.ts, src/__tests__/session-manager.test.ts,
    src/index.ts, src/state.ts, …
- grep delta: 12 raw hits for `persistRunRecord` (incl. comments/strings).
```

```
## Recon (Rule 13 — codegraph @ 91d4b2b)
- target: `finalizeRunRecord`
- callers(finalizeRunRecord):
  - 7 caller(s)
  - src/__tests__/history.test.ts:1 (history.test.ts)
  - src/__tests__/integration.test.ts:1 (integration.test.ts)
  - src/__tests__/runner.test.ts:1 (runner.test.ts)
  - src/index.ts:1 (index.ts)
  - src/unit-run.ts:208 (finalizeUnitRunCrash)
  - src/unit-run.ts:174 (finalizeUnitRun)
  - src/unit-run.ts:1 (unit-run.ts)
- impact(finalizeRunRecord, depth 2):
  - 26 affected symbols across 21 files
  - files: src/history.ts, src/__tests__/history.test.ts, src/__tests__/integration.test.ts,
    src/__tests__/runner.test.ts, src/index.ts, src/__tests__/agent-guidance.test.ts,
    src/__tests__/background-batch-rejection.test.ts, src/__tests__/background-fan-out.test.ts, …
- grep delta: 37 raw hits for `finalizeRunRecord` (incl. comments/strings).
```

**Grep delta (what grep added beyond the graph):** the graph lists callers, not **ordering**. The affected-site
shape and the scope-relevant orderings below are invisible to the graph and were verified by **reading the call
sites** (coverage: the foreground block from `persistRun` through both gates; the chain/parallel/graph gate+persist
pairs; the background terminal funnel):

- **foreground (the two affected sites):** `persistRun(..., "foreground")` → `registerLiveRun` → git setup →
  `checkCircuit` **early return** → `acquireSlot` **early return**; both returns run `cleanupGitBranch()` only.
- **chain:** `checkCircuit`/`acquireSlot` run **before** the step loop's `persistRun(..., "unit")` — no dangling.
- **parallel:** the launch map's `acquireSlot` runs **before** `runTask` → `persistRun(..., "unit")` — no dangling.
- **graph:** the per-node `acquireSlot` runs **before** the node's `persistRun(..., "unit")` — no dangling.
- **background:** `persistRunRecord(pi, run, "background")` at spawn; every terminal branch (incl. git-setup refusal,
  sync throw) funnels through `finalizeRunEntry` — no dangling.

Terminal-call-boundary check (Rule 13 bullet): the clearing of the inflight row rests on
**`persistRunRecord`'s terminal-clear rule** — `if (run.status !== "running") clearInflightRun(run.id)` — so a
terminal `state.persistRun` (no kind) is sufficient; no extra registry call is needed.

## Required behavior

1. **Circuit-open rejection** (the `circuitCheck.isOpen` early return): finalize `run` before returning —
   - `run.status === "failed"`, `finishedAt` set, `durationMs >= 0`;
   - `errorMessage` = the circuit message text the caller receives (same text — use `circuitCheck.message`);
   - `stopReason` coherent with the category (via `finalizeRunRecord` → `coherentFailureReason`);
   - `originalParams.errorCategory` set per Decision D1;
   - terminal `state.persistRun(pi, run)` (no kind) — clears the inflight row;
   - `state.finalizeLiveSubagent(run.id)` — releases the live entry;
   - returned content/`isError: true` **byte-identical** to today.
2. **Slot-cancel rejection**: same shape; `errorMessage` = the exact current text
   `"Subagent cancelled while waiting for concurrency slot."`; category per Decision D1.
3. **Retry-source semantics unchanged**: `clearInflightRun(retrySourceRun.id)` still executes only **after** both
   gates; a gate-rejected retry leaves the source row intact and retryable, with the twin recorded terminal (not
   dangling).
4. **No change** to `checkCircuit`, `acquireSlot`, gate message text, or any non-foreground path. A fabricated
   `SubagentResult` with `exitCode: 1` is sufficient to drive `finalizeRunRecord` to `failed` (`isSubagentError`
   keys on `exitCode !== 0`).

### Decision D1 (stated for the reviewer)

`errorCategory` = **`"aborted"`** for both gates. Rationale: the category vocabulary has no `"rejected"`; both are
pre-start cancellations observed by the caller as a cancelled dispatch; `"aborted"` pairs coherently via
`coherentFailureReason` (→ `stopReason: "aborted"`), mirrors the parallel/graph slot-cancel results (which already
carry `errorCategory: "aborted"` for the same condition), and keeps the terminal record retry-friendly from the
history menu (the circuit message itself says "try again" after recovery). A reviewer who disagrees should say so
explicitly rather than have the implementer silently pick another category.

## Evidence requirements

- **Regression tests** — locate the tool-path seam by searching `src/__tests__/` for existing circuit/slot coverage
  (`circuit.test.ts` exercises the state API only; the dispatch seam is in `integration.test.ts` / `preflight.test.ts`
  — report which file(s) were used and why):
  - **circuit-open dispatch**: stored run record terminal (`failed`), inflight registry empty for the run
    (`listInflightRuns()`), live entry released, returned message unchanged;
  - **slot-cancel dispatch**: same assertions;
  - **retry + circuit-open**: source registry row intact, twin terminal (no dangling).
- Full suite (`npx vitest run`) — report file/test counts; `npx tsc --noEmit`; `git diff --check`.
- **Probe (live, conductor-run after merge, on the dev dogfood + user-triggered `/reload`)**: open the circuit in a
  live session, dispatch → expect the rejection message; history then shows a **failed** entry (not interrupted),
  and a fresh boot/reload shows **no** interrupted row for it. No release checkpoint (the dogfood runs `dev`).
- Report the coverage line: the test files searched for the seam + the counts observed.

## Constraints

- `src/index.ts` only; optionally a small shared helper in `src/unit-run.ts` if the two sites genuinely share shape
  (two call sites inside one function may stay inline — do not over-abstract).
- node_modules symlinked (no installs); do not modify `.development/**`; no unrelated refactors.
- Commit + push + PR body per the `pr` skill, `Fixes #340` in the commit/PR body.

## Out of scope

Background path; chain/parallel/graph; `checkCircuit`/`acquireSlot` internals; UI copy; the retry-source retention
design itself.

# #455 implementation brief — a SIGKILL that has not landed yet is not a survivor

**Issue:** #455 (`fix: recovery #299 A1 positive path fails under full-suite load`).
**Risk:** C1 · **Worktree:** `../brl-subagent-455` (`fix/455-survivor-drain`).
**Scope decision (conductor):** the defect is in the PRODUCER, not the test. Fix the
classification; keep the test's strict assertion. The issue body called this "test-only";
that framing was wrong and is amended on the issue with the evidence below.

## Recon (rule 13)

```
## Recon (Rule 13 — codegraph @ 6c8ee27)
- target: `escalateKill`
- callers(escalateKill): 8 caller(s)
  - src/__tests__/kill-escalation.test.ts:1
  - src/runner.ts:322 (reapActiveChildren)
  - src/runner.ts:1071 (runSubagent)
  - src/runner.ts:552 (killProc)
  - src/recovery-engine.ts:263 (reapPids)
  - src/runner.ts:290 (sweepMarkerChildren)
- impact(escalateKill, depth 2): 32 affected symbols across 17 files
  (src/kill-escalation.ts, src/runner.ts, src/index.ts, src/recovery-engine.ts,
   and the suites: kill-escalation, recovery, runner, streaming-sentinel, engineering-bar)
- grep delta: 29 raw hits for `escalateKill` (incl. comments/strings) — the graph named
  the same 6 production call sites grep did; no caller was missed.
```

## The measured mechanism (do not re-derive; verify it once)

`escalateKill` (`src/kill-escalation.ts:365-421`) sends `forceKill()` and then **samples death
in the same pass**, with no drain:

```ts
if (target.verifyProcessAlive?.() ?? true) { try { target.forceKill(); } catch {} }
if (!target.verifyDeath() && (target.verifyProcessAlive?.() ?? true)) survivors.push(target);
```

SIGKILL is asynchronous: delivery can pend (`/proc/<pid>/stat` state `R`) and the exit is a
zombie (`Z`) until the parent reaps. `pidGone` (`src/proc.ts:322`) is already zombie-aware but
still answers "not gone" for state `R`.

Probe (40 iterations, child ignores SIGTERM, SIGKILL then an immediate sample):

```
iterations=40 aliveImmediatelyAfterSIGKILL=40 ofWhichZombie=15
sample 0: kill(pid,0) alive, /proc state=R        (… same for samples 1-4)
```

So the survivor list is decided by a race, always. In the test it is a coin flip on scheduling;
in production it is a false "could not kill" warning for a process that is already dead.

## What to change

1. **`EscalationOptions` (`src/kill-escalation.ts:332`) gains `drainMs?: number`** — the bounded
   post-SIGKILL confirmation window. Default **100 ms**; `0` disables it (documented escape).
2. **Restructure the SIGKILL pass into three phases**, preserving every existing decision:
   - **Phase A (force-kill pass):** for each target still alive after the grace window, call
     `forceKill()` exactly as today (keep the `verifyProcessAlive?.() ?? true` gate).
   - **Phase B (drain):** if at least one `forceKill` was issued AND `drainMs > 0`, poll
     `verifyDeath()` for all force-killed targets, sleeping `min(pollMs ?? 10, remaining)` until
     all verify dead or the drain deadline (`now() + drainMs`) passes. Use the injectable
     `sleep`/`now` already in the options — no real timers, no `setTimeout` loops.
   - **Phase C (classify):** survivors are targets that are still not dead AND still
     process-alive, exactly as today.
3. **The unconditional final group SIGKILL (`:406-420`) and the refused-group survivor rule
   stay untouched and stay AFTER phase C.** A refusal is a decision, not a timing window — do
   not fold it into the drain.
4. **`RecoveryDeps` (`src/types.ts` or wherever it lives) gains `drainMs?: number`**, passed to
   `escalateKill` from `reapPids` (`src/recovery-engine.ts:290`). The other four call sites
   (`runner.ts:290,322,552,1071`) inherit the default — do not special-case them.
5. **No behaviour change when nothing needs killing:** zero `forceKill` calls ⇒ no drain sleep.

## Tests (branch checklist, no coverage percentages — ADR 0021 §1)

New, deterministic, fake-dependency tests in `src/__tests__/kill-escalation.test.ts`:

- **A. Dying-after-N-polls is not a survivor.** `verifyDeath` returns false for the first two
  drain samples then true; a `forceKill` that records its call. Assert `survivors === []`,
  `forceKill` called once, and that exactly the expected number of `sleep` calls happened
  (order-sensitive: SIGKILL recorded BEFORE the first death flip).
- **B. A genuinely unkillable target is still a survivor, and the drain is bounded.** Death
  never verifies; assert `survivors` contains the pid and the injected `now()` advanced by no
  more than `drainMs` (a `now` that advances `pollMs` per sleep keeps this exact).
- **C. `drainMs: 0` reproduces the legacy single-sample behaviour** (the mutant-B baseline).
- **D. Order pin:** with two targets, both `forceKill`s are dispatched before the first drain
  sample (record a global sequence array: `kill`/`sleep`/`dead`).

Existing tests that count `sleep`/`now` sequences must be **updated deliberately** — say in the
PR body which ones and why; a silent edit to an order assertion is a red flag, not a fix.

**The real-process test that started this** (`src/__tests__/recovery.test.ts:1314-1355`,
#299 A1 positive path) must stay EXACTLY as it is: `expect(survivors).toEqual([])` and both
`pidAlive` assertions unchanged. It must pass with the drain and fail without it under load.

## Named mutants and their killers

| # | Mutation | Killer |
|---|---|---|
| M1 | drop phase B entirely (classify immediately after SIGKILL) | A (survivors `[pid]`), D (no sleep after kill), and the real-process test under load |
| M2 | `drainMs` honoured but never bounded (poll until dead) | B (elapsed > `drainMs`, test hangs at the 20 s timeout) |
| M3 | drain before issuing `forceKill` | D (order: `dead` sample precedes `kill`) |
| M4 | drop the `verifyProcessAlive` gate on `forceKill` | existing kill-escalation test for an already-exited direct process (name it in the PR) |
| M5 | drain applied when no `forceKill` was issued | A/C variant: sleep count differs from today on a target that died during grace |

State each mutant's re-application result in the PR body: **applied, killed by <test name>**.

## Budget and boundaries

- Test LOC headroom is thin (suite ratio 1.98 / 2.0 ceiling). Keep net test growth ≤ ~80 lines;
  prefer extending an existing `describe` over a new fixture file. If you must exceed it, say so
  and trim a redundant assertion elsewhere in the same file, naming it.
- **Non-goals:** no zombie-detection change (`pidGone` stays as is), no group-kill reordering,
  no change to `graceMs` semantics, no weakening of the #299 A1 assertions, no new dependency.
- Full suite must be green in the worktree: `npx vitest run`, plus `npm run typecheck`, plus
  `node scripts/check-test-budget.mjs <report>` and `node scripts/check-readme-test-count.mjs`.
  **Note:** the cockpit on `dev` has one pre-existing load-only failure (`recovery.test.ts:1350`
  #299 A1) — if it reproduces here, the drain did not land or is too short. That test is the
  acceptance signal, not noise.

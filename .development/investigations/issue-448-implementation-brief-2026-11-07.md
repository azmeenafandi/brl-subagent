# #448 implementation brief (scope corrected) — abort independently of bookkeeping; arm a deadline for a direct spawn

**Status:** rewritten after two plan critiques. **Base:** `dev` @ `dfb1954`. **Risk:** C2.
**Source of truth:** `issue-448-plan-critique-b-2026-11-07.md` (the factual corrections) and the issue body.
**Split:** ownership handshake, cooperative-abort residue, prune safety, time origin → **#453**.

## What is no longer in scope, and why

- **"An explicit timeout leaves the run entry `running`" — struck.** Measured: the cooperative abort path
  already finalizes (`["running","failed"]`). The residue belongs to the **non-settling** prompt, where no
  settle path runs; finalizing there would prune a session a still-writing child may hold (a real SDK append
  after that prune failed `ENOENT`). That is #453.
- **The caller-throw deadline hole is not closed here.** With the owner flag, a throw before the caller arms
  still leaves `timers:0, abort:0, running` (measured). Defer to #453 **in writing**, in the PR and CHANGELOG.

## Defect 1 — a timeout can mark a run `stopped` without aborting it

`session-manager.ts:1928–1943` runs `updateAgentStatus('stopped')` → `transcript.completeTranscript('stopped')`
→ `session.abort()` inside **one `try`**. A throwing bookkeeping call suppresses the abort: the record says
`stopped`, the child keeps running. **Measured** with a real transcript `EISDIR` → `stopped`, `abort: 0`.

Requirements:
- **Abort is attempted independently of fallible bookkeeping** — a status or transcript write failing must
  not prevent `session.abort()` from being called, exactly once.
- Keep **status before abort** (the settle path relies on the pre-set status to classify the run as stopped).
- **Surface** the bookkeeping failure (log with the reason); do not absorb it into silence. Name the surface
  in the PR — do not invent a new user-facing notice for it.
- Apply to the W3 timer **and** to any deadline this brief adds.

## Defect 2 — a direct spawn with no timeout arms no deadline

The default deadline is the caller's (`index.ts:2197-2258`), armed after the spawn returns, so a direct
`spawnBackgroundSession` with no `timeout` arms nothing (**measured**: zero timers, `abort: 0`).

Requirements:
- `spawnBackgroundSession` arms the **default** (`effectiveBackgroundBudget(undefined)`; never re-spell the 30
  minutes) when no explicit timeout is given **and** the caller has not taken ownership.
- **Ownership is an explicit internal flag** (e.g. `deadlineOwner: "caller" | "spawn"`, default `"spawn"`).
  Exactly **one** production call site exists (`src/index.ts:2010`; single dispatch, fan-out, manual retry and
  transport retry all route through it) — it passes `"caller"` and keeps its current timer. Omission
  double-arms, so the flag must be required at that call site in a way a test can see.
- Arm **before** `prompt()` (see cancellation below), and keep the abort-only behaviour: status `stopped`,
  transcript, `session.abort()`, **no finalization, no pruning**.
- **Cancel on both settle handlers** (mirror `:1949`/`:2099`) **and in the synchronous-throw catch** — the
  catch must clear the timer **before** its own fallible cleanup, because no settle handler attaches on that
  path. Regression test: rejected synchronous spawn → advance past the deadline → no abort, unchanged status.

## Acceptance

1. **Abort independence (both faults):** a throwing `updateAgentStatus` and a throwing `completeTranscript`
   each still produce `abort()` exactly once; the failure is logged. Falsify with a real throwing transcript.
2. **Direct spawn:** no explicit timeout → exactly one default deadline; on fire: abort once, agent `stopped`,
   **no finalization and no pruning** (assert the session dir survives and the run entry is untouched by the
   timer).
3. **No double arm:** an ordinary dispatch still has exactly one deadline (the caller's) and unchanged
   behaviour. Count **deadline arms**, not timers — a normal run has three (poller, footer, deadline).
4. **Sync-throw cancellation:** rejected spawn → no armed deadline afterwards (advance time: no abort, no
   status change).
5. **Preservation:** explicit timeout honoured verbatim; `≥ 2^31-1` normalizes to no timeout (default then
   applies); normal completion clears the deadline; foreground arms nothing.
   `session-manager.test.ts:799-814` asserts *no* timer for a zero timeout — it must change to the new owner
   rule, and the PR must say why.
6. **Mutants — expected failing test stated before each run, survivors reported as survivors:**
   - **M1** move `session.abort()` back inside the fallible block → test 1 fails;
   - **M2** arm the default unconditionally (ignore ownership) → test 3 fails (two arms);
   - **M3** drop the sync-throw cancellation → test 4 fails;
   - **M4** arm **after** `prompt()` instead of before → test 4 fails as well, and the brief notes that this
     makes M3/M4 the same kill; if the implementer finds them indistinguishable, say so rather than claiming
     two kills.
7. **Gates:** full suite with a final-tree JSON report, `npm run typecheck`, `node scripts/docs-arch.mjs`,
   `node scripts/docs-decisions.mjs` (read-only forms — the npm scripts write), `git diff --check`, README
   drift, test budget. Expect **~300 total lines** (≈40 source + ≈260 test) against ~543 headroom + 2× new
   source lines; treat that as an estimate, not a cap.
8. **Docs:** CHANGELOG — the abort is no longer suppressed by a bookkeeping failure; a direct spawn is
   bounded; **and the two explicit limits**: a caller-side throw still leaves the run unbounded (#453), and
   abort is cooperative (#453).

## Limits

- Non-settling runs still stay `running` and are not finalized — deliberate, because finalizing prunes (#453).
- No one-owner refactor; the caller keeps its timer and its cleanup responsibilities.
- No change to escalation, to `stopAgent`/`stop_subagent`, or to the foreground path.

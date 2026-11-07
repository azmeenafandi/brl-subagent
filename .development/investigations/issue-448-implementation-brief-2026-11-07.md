# #448 implementation brief (narrowed) — the run entry must be finalized, and a direct spawn needs a deadline

**Status:** amended after plan critique (`issue-448-plan-critique-2026-11-07.md`, needs-work); scope narrowed.
**Base:** `dev` @ `1639fab`. **Risk:** C2.
**Split:** ownership/lifecycle → #453. This brief does the minimum that removes the two measured defects.

## What the critique changed

1. **Defect 1 as first written was overstated** — an ordinary dispatch with no `timeout` **does** get the
   caller's 30-minute deadline (measured `CALLER-CONTROL`: stopped, `abort: 1`, one wake). Only a
   **direct** `spawnBackgroundSession` (and the caller-throw path) has none. The acceptance below is
   scoped to those.
2. **The deadline must not finalize.** `finalizeRunEntry` also prunes the session directory
   (`session-manager.ts:1454-1555,1715-1828`) and a real SDK append after that prune failed `ENOENT`. The
   timer's job stays **abort only**; the settle path owns finalization and pruning.
3. **Count deadline arms, not timers** — a normal caller control has three timers (poller, footer, deadline).
4. **A timer armed before `prompt()` must be cancelled on a synchronous throw** — measured leak: it later
   flipped the agent to `stopped` and aborted after the entry was already `failed`.

## Defect A — the aborted settle path leaves the run entry `running`

Measured (`#439` investigation §2 variant C, reproduced by the critique): an explicit `timeout` fires → the
agent becomes `stopped` with `completedAt`, the transcript completes, but the **persisted session run entry
stays `running`**.

The timer callback is not at fault: `session-manager.ts:1927-1947` flips status, writes the transcript and
calls `session.abort()`. Finalization lives in the settle path. **Diagnose the actual cause in the aborted
branch before changing it** — verify whether `prompt()` resolves on abort in that path (the probe contract at
`:1092-1110` says it does), and whether `finalizeAbortedRun` (`:1793`) is reached. The fix belongs where the
gap is, not where it is easiest.

Requirements:
- The persisted run entry must be finalized on the aborted settle path — no `running` residue when the
  agent record is terminal.
- **Abort must be attempted independently of finalization.** Measured today: a throwing terminal append
  leaves `abort: 0` and the registry entry removed. Attempt the abort first (or guard the finalize), and let
  a persistence failure be reported, not silently swallow the abort.
- Preserve: status, `completedAt`, transcript line, wake, `retryRunId` affordance.

## Defect B — a direct spawn with no timeout has no deadline

The default deadline is armed by the **caller** (`index.ts:2197-2258`) after the spawn returns; a direct
`spawnBackgroundSession` with no `timeout` therefore arms nothing (measured: zero timers, `abort: 0`).

Requirements:
- `spawnBackgroundSession` arms the **default** deadline (`effectiveBackgroundBudget(undefined)` →
  `DEFAULT_BACKGROUND_DEADLINE_MS`; never re-spell 30 minutes) when no explicit timeout is given **and the
  caller has not taken ownership**.
- **Ownership is explicit, never inferred from the caller's identity.** Add an internal, non-schema
  parameter (e.g. `deadlineOwner: "caller" | "spawn"`), defaulting to `"spawn"`, which the normal caller sets
  to `"caller"`. A run must never have two deadlines — assert it with a deadline-arm counter, not a timer
  count.
- The default arm behaves exactly like W3: status `stopped` + the existing message text, transcript,
  `session.abort()`, **no finalization and no pruning**.
- Cancel the arm on **both** settle handlers (`.then` and `.catch` already clear W3 — mirror that) **and on a
  synchronous `prompt()` throw**, with a regression test (advance past the deadline after a rejected spawn:
  no abort, no status change).

## Acceptance

1. **A, persisted:** explicit timeout fires → agent `stopped` **and the persisted run entry finalized** (not
   `running`). Assert the persisted entry, not only the in-memory agent.
2. **A, failure isolation:** a throwing terminal append does not suppress `session.abort()`; the residue is
   reported rather than presented as success.
3. **B, direct:** a direct spawn with no `timeout` arms exactly one default deadline; on fire, `abort` is
   called once and the agent becomes `stopped`; **no finalization and no pruning** on that path.
4. **B, no double arm:** an ordinary dispatch (no timeout) still has exactly one deadline — the caller's —
   and its behaviour is unchanged.
5. **B, sync throw:** a rejected synchronous spawn leaves **no** armed deadline (the leak above).
6. **Preservation:** explicit timeout honoured verbatim; `≥ 2^31-1` normalizes to no timeout (default then
   applies); normal completion clears the deadline and never aborts; foreground arms nothing.
   `session-manager.test.ts:799-814` (expects no timer for zero timeout) is the **one test the fix must
   change** — rewrite it to assert the new owner rule, and say why in the PR.
7. **Mutants — state the expected failing test before each run; report survivors:**
   - **M1** skip the finalize on the aborted path → test 1 fails;
   - **M2** abort after finalize instead of independently → test 2 fails (throwing append yields `abort: 0`);
   - **M3** arm the default deadline unconditionally (ignore ownership) → test 4 fails (two arms);
   - **M4** omit the sync-throw cancellation → test 5 fails.
8. **Gates:** full suite with a final-tree JSON report, `npm run typecheck`, both docs guards,
   `git diff --check`, README drift, test budget. Headroom ~543 lines at 1.98; keep this under ~250.
9. **Docs:** CHANGELOG — the run entry now finalizes on an explicit timeout; a direct spawn is bounded.
   Mention the cooperative-abort limit explicitly (abort is cooperative; #453 owns what remains live).

## Limits

- Not fixed here: whether a still-writing session can be safely pruned (#453); one-owner refactor; the
  deadline's time origin; the caller registration/count handshake.
- Not #439: a caller-side throw still reports a spawn failure for a run that started.

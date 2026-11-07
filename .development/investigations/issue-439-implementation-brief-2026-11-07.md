# #439 implementation brief (revision 3) — a started run must never be reported as a failed spawn

**Issue:** #439. **Risk:** C1. **Worktree:** `../brl-subagent-439` (`fix/439-started-tail-containment`).
**Revision 3** — two critique rounds folded in; `[c1]`/`[c2]` items are acceptance criteria.
The notice contract is **resolved on the issue** (comment): exactly one **terminal** notice per
source dispatch; the degraded advisory is not terminal and may precede the terminal notice.

## Recon (rule 13)

`startBackgroundAgent` is a contiguous region, not a symbol — direct reads of
`src/index.ts:1985-2263` (recorded as the "graph cannot name a region" case). Callers:
`:1930` (fan-out), `:2310` (`spawnBackgroundRun`). Handles `sendCrashNotice`/`pollInterval`/
`hardCapHandle` cross-reference and were read line by line.

## The defect (measured — do not re-derive)

After the spawn at `:2010` the tail runs uncontained: crash-notice closure `:2043`, live row `:2055`,
counter `:2072`, repaint `:2074`, poller `:2078`, deadline `:2202`, final `log.info` `:2259`. A throw
reaches `spawnBackgroundRun`'s catch `:2442-2458` → **"Failed to spawn background agent"** +
`isError: true` while the run is live; fan-out does the same per unit (`:1938`, `:2435`); the retry
path (`:4249-4300`) reads any throw/`isError` as "did not start" and surfaces the source failure
falsely.

## The fix

### 1. Identity out of the fault window, result assembly out of the caller's reach

`startBackgroundAgent` returns `{ agent, identity, tailFailures }` where `identity` is a plain
record captured **immediately** after the spawn: `{ id, description, task, status, model, label }`.
Callers format every result from `identity`, never from `agent` (**[c1]**: result assembly lives in
the callers, so a try inside the helper cannot enclose it).

**Boundary statement (falsifiable, state it in the code):** the returned record is a plain object
this module constructs; a property read on it cannot throw except through a monkey-patched getter,
which the production path cannot produce. Faults are therefore injected at *statements* (a throwing
`state.registerLiveSubagent`, a throwing scheduler), not at synthetic accessors. If a future change
makes the record a proxy/getter-backed object, this boundary is invalid — the test that fails is
T1's "no spawn-failure text".

### 2. Ordering: a live row always implies a counted run

G1 (**[c2]** measured: a row without a counter increment lets the stale sweep decrement a sibling):

1. `state.activeSubagents++` and set `countedForThisRun = true` — **first**;
2. `state.registerLiveSubagent(identity.id, …)` — second (a row now always has its counter);
3. `repaintStatus(state, ctx)` — last.

Every decrement site — poller crash, poller completion, poller catch, deadline, deadline catch
(`rg -n 'finalizeLiveSubagent|activeSubagents--'` found five) — is gated on
`countedForThisRun && state.finalizeLiveSubagent(id)`.

### 3. Containment

One outer containment around every remaining post-spawn statement (bookkeeping, poller, deadline,
`log.info`, and the helper's own return-object construction), whose catch builds the degraded result
from `identity` only. Inside it, three independently contained groups recording into
`tailFailures: string[]`: **G1** bookkeeping (above), **G2** poller, **G3** deadline. Hoist
`let pollInterval`, `let hardCapHandle`, `const sendCrashNotice` (itself best-effort: claim and send
each in their own try), `let countedForThisRun = false` before the groups. There is **no caller-side
settle `.then`** — that lives in `session-manager.ts:1989+`; the caller owns the poller + deadline.

### 4. Classification and advisory

- `spawnBackgroundRun`: non-empty `tailFailures` ⇒ `isError: false`, normal "Background agent
  started: <id>" text **plus** a "Monitoring degraded" paragraph (failure, id, "do not re-dispatch —
  retrieve with `get_subagent_result`"). Never the spawn-failure wording.
- `runBackgroundFanOut`: same per unit; an earlier unit's started-degraded report survives a later
  unit's failure/cancellation.
- `scheduleTransportRetry`: unchanged code path (it reads only `isError`), but its comment states
  that a degraded success suppresses the source notice and the advisory is the degraded signal.
- One advisory **attempt** per run after aggregation: `BACKGROUND_MONITOR_DEGRADED_NOTICE`, with
  `pi.sendMessage` and `ctx.ui.notify` each in their own try; never `claimTerminalNotice` (per the
  issue's resolved contract).

## Tests (ADR 0021 §1)

Seams only: a throwing `state.registerLiveSubagent`, a throwing `repaintStatus`, the scheduler, and
the existing spawn mock (`transport-auto-retry.test.ts:32-72`). No SDK-fault injections.

- **T1** — G1 throws after a successful spawn: `isError:false`, degraded paragraph + id from
  `identity`, no spawn-failure text, one advisory, **and G2/G3 still ran** (poller handle present,
  deadline armed) — **[c2]** this last clause is what kills M1/M2.
- **T2** — G2 throws: same classification; G3 armed.
- **T2b** — G1 throws with another **healthy** agent active (give both fake agents a `_sessionRef`
  so no poller crashes early): drive the deadline branch, assert the sibling's count stays 1.
- **T2c** — post-registration G1 throw (repaint throws) followed by a **stale sweep**: the sibling's
  count is unchanged (the row-implies-counted ordering).
- **T3** — G3 throws: reported started; no spawn-failure text; no timer left behind.
- **T4** — fan-out: unit 1 degrades, unit 2 fails → unit 1 still reported started-degraded.
- **T5** — retry: a contained tail fault on the retry spawn ⇒ real retry spawn observed, one
  advisory, source notice suppressed (retry returns true), and a rejecting spawn still returns false
  with the source failure. Filter terminal messages by **type + source id** (**[c2]**), and assert
  the retry id and the advisory separately.
- **T6** — advisory once with two failing groups; a throwing `sendMessage` still lets the UI notice
  through (and vice versa); a later genuine terminal notice for the id is still delivered (the
  deferred-settle path, not a manual emit — **[c2]**).
- **T7** — rejected `spawnBackgroundSession`: `isError:true`, existing wording, zero advisory.
- **T8** — **[c2]** a throwing retry toast: the source notice outcome is pinned (choose: the toast
  throw is caught by the completion handler after the source claim — assert no second source notice).

## Mutants

| # | Mutation | Killer |
|---|---|---|
| M1 | remove the G1 containment | T1 (G2/G3 ran) |
| M2 | one big try so a G1 failure skips G3 | T1 (G3 armed), T2 |
| M3 | keep the spawn-failure wording | T1 |
| M4 | retry reads a contained failure as "did not start" | T5 |
| M5 | advisory claims the terminal notice | T6 |
| M6 | one advisory per failing group | T6 |
| M7 | contain the rejected spawn | T7 |
| M8 | drop `countedForThisRun` | T2b |
| M9 | register the live row before the counter | T2c |
| M10 | format results from `agent` instead of `identity` | T1 (spawn-failure escape on a getter-fault) |

## Budget and boundaries

- Net test growth ≤ ~150 lines (headroom ≈ 400 total; T2b/T2c/T6 reuse the background fixtures).
- No change to `spawnBackgroundSession` internals, prune/finalize semantics, or deadline ownership
  (#453). No change to the pre-spawn failure contract.
- Gates from ONE JSON report: `npx vitest run --reporter=json --outputFile=/tmp/vitest-439.json`,
  `node scripts/check-test-budget.mjs /tmp/vitest-439.json`,
  `node scripts/check-readme-test-count.mjs /tmp/vitest-439.json`, `npm run typecheck`.
- CHANGELOG: user-visible classification change + the advisory.

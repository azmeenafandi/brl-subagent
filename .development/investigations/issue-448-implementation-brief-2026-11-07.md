# #448 implementation brief — one owner for the background deadline

**Status:** draft for plan critique. **Base:** `dev` @ `a39b63d` (2026-11-07).
**Risk:** C2. The timer lifecycle is small, but the deadline path touches the settle branches — the
implementer must not restructure settlement to move a timer.
**Evidence:** `.development/investigations/issue-439-investigation-2026-11-07.md` §2 (variants **C** and
**E4**), §5.1.

## Recon (verified on `a39b63d`)

Two timers exist and **neither covers the no-timeout case**:

| owner | armed when | what it does | gap |
|---|---|---|---|
| W3, `src/session-manager.ts:1927-1947` | `params.timeout && params.timeout > 0` — **explicit only** | `updateAgentStatus('stopped')`, `transcript.completeTranscript('stopped')`, `session.abort()` | never finalizes the run entry itself — it relies on the abort making `prompt()` resolve into the aborted settle branch |
| caller, `src/index.ts:2197-2258` | `!hasExplicitDeadline` — **no-timeout only**, armed **after** `spawnBackgroundSession` returns | status, `clearInterval(pollInterval)`, `setAgentFinalOutput`, counter gating, repaint | skipped entirely when the spawn or the caller's tail throws (#439's R3); the run then has **no deadline at all** |

Already available and unused by the caller: `effectiveBackgroundBudget(timeout)` (`src/validate.ts:535`),
`DEFAULT_BACKGROUND_DEADLINE_MS` (`:501`), and the recorded `agent.timeoutMs` / run `timeoutMs`
(`background-session-persistence.test.ts:178-205`). **Reuse them; do not re-spell the 30 minutes.**

## Measured defects (re-verify before changing anything)

1. **No explicit timeout + a run that never settles → no deadline exists.** The run stays `running`
   forever: `completedAt: null`, `abort` never called, no wake (`#439` investigation, variant **C**/E4).
2. **Explicit timeout → status flips but the run entry stays `running`** (variant **C**): the agent
   record says `stopped`, the session run entry does not finalize, so history and `retryRunId` disagree
   with the agent record.
3. **The caller's throw leaves no deadline** (#439 R3): with no explicit timeout, the only timer was in
   the caller tail, so a throw before it is armed means the run has none.

If any of the three does not reproduce on `a39b63d`, **stop and report** — do not implement against a
defect you could not see.

## Deliverable

1. **One owner, armed before the run can start.** The deadline for a background run must be owned by
   `spawnBackgroundSession` and armed for **both** cases, before/independent of anything fallible that
   happens after `prompt()`:
   - explicit timeout → today's verbatim behaviour (`normalizeTimeout` honoured exactly, no ceiling);
   - no explicit timeout → `DEFAULT_BACKGROUND_DEADLINE_MS` (via `effectiveBackgroundBudget`).
   The caller's duplicate timer is **removed**, not left as a second owner — exactly one deadline per
   run is the property that #28/#240 established and this change must preserve.
2. **The deadline finalizes what it stops.** On fire: agent `stopped` with the existing message text,
   **run entry finalized** (no `running` residue), transcript completed, counters gated exactly as the
   caller did (claim-guarded, never negative), and the settle path captures final output as it does
   today. Whatever the caller's timer used to do must either move with the deadline or be proven
   unnecessary — enumerate which, in the PR.
3. **Preserve the documented semantics.** Foreground unchanged; background defaults to 30 minutes; an
   explicit timeout is honoured as given; `≥ 2^31-1` normalizes to no timeout, after which the
   background default applies; no new status vocabulary; the message text stays recognisable
   (`Timed out …`), since users and tests match it.
4. **No timer leak.** Both settle paths must clear the deadline (today only the explicit-timeout timer is
   cleared in `.then`); a timer that fires after a clean settle must be a no-op, not a second abort.
5. Surgical: no change to escalation (abort, not kill), to the poller's own logic, or to
   `stopAgent`/`stop_subagent` semantics.

## Acceptance

1. **No-timeout hang** (fault harness, no provider): a run whose `prompt()` never settles, dispatched
   with no `timeout`, reaches the deadline → agent `stopped`, **run entry finalized**, `completedAt`
   set, `abort` called exactly once, wake delivered, counters consistent. This is the falsifier the
   current code fails; keep the pre-fix reproduction as history only.
2. **Explicit timeout** still honoured verbatim, and now finalizes the run entry (defect 2). Assert the
   **persisted** run entry, not only the in-memory agent.
3. **Exactly one timer** per run in both cases: a test that counts armed deadlines (injectable clock or
   spy) for the no-timeout and explicit cases. Fail if two owners arm for the same run.
4. **Preservation:** normal completion clears the deadline and never aborts; an explicit `≥2^31-1`
   timeout normalizes to no timeout and then gets the default; the foreground path arms nothing; the
   existing `background-session-persistence` timeout tests stay green (or change only where the brief
   says the behaviour changes).
5. **Caller-throw case** (#439 R3, do not fix #439 here): with the deadline inside the spawn, a throw in
   the caller's tail must no longer mean "no deadline" — assert the deadline still exists and still
   fires. The *notice* contract for that class stays with #439.
6. **Mutants — state the expected failing test before each run; report survivors as survivors:**
   - **M1** arm only on the explicit path (drop the default arm) → test 1 fails;
   - **M2** arm the default **after** the settle handlers/prompt wiring → test 1 (caller-throw variant)
     fails;
   - **M3** stop the session without finalizing the run entry → test 2 fails on the persisted record;
   - **M4** keep the caller timer as well → test 3 (exactly one timer) fails.
7. **Gates:** `npx vitest run` (JSON from the final tree), `npm run typecheck`, both docs guards,
   `git diff --check`, README drift, test budget. **Headroom is ~543 lines at 1.98/2.0** — this fix
   should stay under ~200 test lines; if it cannot, say so before writing them.
8. **Docs:** CHANGELOG `Unreleased` — the deadline now exists in every background case, the explicit
   timeout now finalizes the run entry, and the caller-side gap (#439) no longer removes the deadline.
   README only if the timeout description needs the "one owner" clarification.

## Limits

- This does **not** fix #439: a caller-side throw still produces a spawn-failure diagnostic for a run
  that started. #448 only guarantees the run is bounded.
- No change to what a timeout *does* (abort, then the settle classifies it) or to the foreground.
- A process death before the timer is armed leaves an unbounded run by construction — crash recovery
  (#447) owns that, not this change.

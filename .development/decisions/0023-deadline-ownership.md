# 0023. One owner for the background deadline: the spawn arms it, only a settle ends a run

- **Status:** Accepted
- **Date:** 2026-11-07
- **Issues:** #453, #448 (superseded in part), #439, #447
- **Supersedes:** ADR 0008 §"one timer per run" is sharpened: one **owner**, not merely one timer — the
  session-manager is that owner, and the caller's parallel timer is deleted. It supersedes the
  `deadlineOwner: "caller"` split introduced by #448 (the split worked, but it left the
  caller-throw hole and a duplicated ownership predicate).

## Context

#448 fixed two defects and deliberately deferred the ownership question to #453: the caller armed the
no-timeout default (to bound a direct spawn) while the spawn armed explicit deadlines, and a flag told
one side not to arm. A decision-ready dossier measured six things that the split cannot answer
(`.development/investigations/issue-453-investigation-2026-11-07.md`):

1. A caller-tail throw after the spawn leaves the run **unbounded** — the one path where nobody arms.
2. The **poller**, not the timer, performs the caller's live-row cleanup — measured: with an explicit
   timeout the caller arms nothing and the live row still clears. Moving the timer loses nothing.
3. A timer-side `finalizeRunEntry` **prunes** the session directory (it shares one guard with the
   settle) — a still-writing SDK session then fails `ENOENT`.
4. A terminal entry written by the timer is **final**, so a late settle's real cost is lost: timed-out
   runs report `cost: 0` into the metrics.
5. The budget's origin is ambiguous: `startedAt` is recorded before branch setup, so the displayed
   `deadlineAt` and the armed timer drift (measured 42 ms injected, 246 ms cold).
6. The claim is not proof of registration: a finalize claim for an unregistered id decremented a
   sibling's `activeSubagents` count.

## Decision

| # | Decision | Choice |
|---|---|---|
| 1 | **One owner.** The session-manager owns the background deadline on every path; the caller's 30-minute timer and the `deadlineOwner` flag are deleted. | O1-b |
| 2 | **Cooperative abort, written contract.** The deadline abort is abort-only: it owns no filesystem or git resource, waits for no settle, and never prunes or releases the branch lock. Only a settle does. | O2-b |
| 3 | **Prune-safe finalization.** The timer may write the terminal record, never prune. The single `runFinalized` guard becomes `entryWritten` + `pruned`; the settle prunes with the true error category. | O3-b |
| 4 | **Snapshot + amendment.** The deadline-time entry is a classification snapshot; a later settle appends an amendment carrying the payload (cost/usage/output). `resolveTerminalRunEntry` selects the **last** non-running entry (`find` → `findLast`). | O4-b |
| 5 | **Time origin = record creation.** Arm with `max(0, budget − elapsed_since_startedAt)` so the timer matches the displayed `deadlineAt`. | O5-b |
| 6 | **Synchronous-throw cleanup** needs no separate change: it is implied by decision 1 (the arm is inside the spawn, and the existing sync-throw clear stays). | O6-b |

## Consequences

- The reachable half of #448's remaining limit closes: a caller-tail throw no longer leaves a run
  unbounded, because the spawn armed the timer before the caller had anything to do.
- **Still open, deliberately:** abort is cooperative, so a prompt that ignores abort keeps the session
  dir (until process exit), its registry entry, and — in branch mode — its git lock. The convoy this
  creates is a separate, pre-existing issue and is NOT solved here.
- Timed-out runs now report their real cost through the amendment; a snapshot-only design would have
  made the metrics lie.
- One ownership predicate exists; a future "who arms this" question has one answer to change.
- The caller's `hardCapHandle` and its three `clearTimeout` sites are deleted; `armDeadline` is the
  only place a background deadline is created.

## Alternatives rejected

- **Keep the split and add a registration handshake** (the issue's option 1b): the handshake protects
  the counter but leaves the caller-throw hole and keeps two arm sites plus a flag — the duplicated
  predicate the recon called out.
- **Move the whole timer into the caller**: loses the direct-spawn bound entirely (a direct
  `spawnBackgroundSession` with no timeout would be unbounded), which is #448 defect 2.
- **Timer finalizes and prunes** (the simplest "one owner"): measured to remove a directory a live,
  still-writing session holds (`ENOENT` on the next append).
- **Snapshot-only terminal entries**: cost under-reporting on every timeout (decision 4).

# #460 investigation — a never-settling branch-mode run wedges the git lock and the spawn queue

**Kind:** decision dossier. **No implementation, no repository change except this file.** The conductor decides;
the brief carries the chosen option only.
**Base:** `dev` @ `5f18385` (`git rev-parse --short HEAD`), clean tree (`git status --porcelain` → empty).
`#453` is **not** merged on this base — `deadlineOwner` still exists (`session-manager.ts:1215`,
`index.ts:2183`) and `finalizeRunEntry` still has the single `runFinalized` guard (`session-manager.ts:1468-1474`).
Every "today" statement below is therefore *pre*-#453.

**Method.** `.codegraph/` is conductor-side and absent here, so every coverage line is a `grep`/`read`, and every
load-bearing claim was probed. The probes live in scratch trees, never in the repo:

```
cp -r src /tmp/brl460/src && diff -r /tmp/brl460/src <repo>/src   → identical
/tmp/brl460    base copy; one added line in createAgentSession (modelRuntime injection, Appendix B.0)
/tmp/brl460m   option (a) mutant: release the lock in armDeadline
/tmp/brl460d   option (d) mutant: release the spawnQueue before the git-lock wait
/tmp/brl460b   option (b) mutant: owner map + refusal before the git-lock wait
```

Each probe prints one `W460P-*` evidence line. **Measured** = produced by one of those runs; **read** =
code-inspected with `file:line`; **inferred** = a conclusion from measured facts that was not itself observed;
**unverified** = named with the command that would settle it (§9).

---

## 0. The two facts that decide this issue

Two measurements, each cheap to re-run, remove most of the option space before any policy argument:

**M1 — the set of runs where a release would fire is exactly the set where the child is not known to be dead.**
A run whose prompt settles releases the lock by itself (the settle is the only releaser, §1.1). A run whose
prompt never settles is, by measurement, a run whose SDK session reports `isIdle === false` and whose
`abort()` promise never settles (W460P-P1, W460P-P3). So "the lock is still held past the deadline" and "the
session is not idle" are the same event, give or take the settle-in-flight window measured at **88 ms**
(W460P-P6). No release policy can be justified by "the child is dead", because a dead child releases on its own
and never needs the policy. Releasing therefore always acts on a child that the SDK still considers live.

**M2 — the process-wide convoy is not specific to the bug.** The per-repo git-lock wait currently happens
*inside* the module-level spawn-queue critical section. A perfectly healthy branch-mode run therefore blocks
every later spawn in the process for its whole duration: measured with a running (not timed-out) branch run A,
a non-git spawn C stayed `PENDING` and resolved only after A settled (W460P-P8). The never-settling case is the
unbounded version of an everyday serialization.

M1 kills "release on the deadline" as a safe default; M2 says the queue half of the issue is separable from the
lock half, and is the cheaper half to fix.

---

## 1. What exactly wedges

### 1.1 The two locks (read)

| Lock | Object | Set | Held by | Released by | Scope |
|---|---|---|---|---|---|
| **spawn queue** | `var spawnQueue: Promise<void>` — `session-manager.ts:30` | taken at `:1237-1239` (`prev = spawnQueue; spawnQueue = new Promise(r => resolveNext = r)`), awaited at `:1240` | the spawn body, from the dynamic SDK import (`:1246`) through `createAgentSession` (`:1354`), the agent record (`:1417`), the run record (`:1452`), the branch setup (`:1781-1848`), the deadline arm (`:2021-2025`), the acceptance write (`:2037`) and `session.prompt()` (`:2053`) | `resolveNext()` in the function's `finally`, `:2283-2285` — i.e. when the spawn **returns** | process-wide, all repos, all git modes |
| **git branch lock** | `gitBranchLocks = new Map<string, Promise<void>>` — `:37`, key = `getRepoRoot(gitCwd) ?? gitCwd` (`:1791`) | chain link installed at `:1795-1796` (`entry = prev.then(() => gate)`), awaited at `:1797` | the unresolved `gate` promise of the spawn that got past `await prev` | `releaseGitLock` (`:1798-1804`): resolves `release()` and deletes the map entry if still head | per repository root, **for the run's whole lifetime** |

The release census is exhaustive:

```
$ grep -n "releaseGitLock\|gitBranchLocks" src/session-manager.ts
37:  const gitBranchLocks = new Map<string, Promise<void>>();
45:    gitBranchLocks.clear();                 // __testResetGitBranchLocks only
1582:  let releaseGitLock: (() => void) | undefined;
1660:      releaseGitLock?.();                   // cleanupWorkBranch's finally
1661:      releaseGitLock = undefined;
1792:    const prev = gitBranchLocks.get(lockKey) ?? Promise.resolve();
1796:    gitBranchLocks.set(lockKey, entry);
1798:    releaseGitLock = () => {
1801:      if (gitBranchLocks.get(lockKey) === entry) gitBranchLocks.delete(lockKey);
1831:      releaseGitLock?.();                   // branch-setup-throw catch
1832:      releaseGitLock = undefined;
```

`cleanupWorkBranch` (`:1596`) is itself called from six places — `:1690` (`failPreStart`), `:1909`
(`markTerminalBestEffort`), `:2102` (then/aborted), `:2142` (then/failed), `:2179` (then/completed), `:2219`
(catch) — **all of them settle-side**. There is no timer, no `stopAgent`, no boot path, and no public API that
releases the lock. The dossier's F2.3 (`issue-453-investigation-2026-11-07.md:256-268`) is still accurate; only
the line numbers have drifted (`:1650-1669` → `:1791-1804`, `:1787-1790` → `:1660-1661`).

### 1.2 Why the convoy is process-wide (read + measured)

A second branch-mode spawn in the same repo waits at `:1797` **while it still holds the spawn queue** — it is
inside the `try` whose `finally` (`:2283-2285`) releases the queue. It never returns, so `resolveNext()` is never
called, so a third spawn of *any* kind blocks at `:1240`.

```
W460P-P2 {"branchA":"brl-subagent-ac58779c","spawnsAfterA":1,
          "afterDeadline":{"status":"stopped","completedAt":"set","error":"Timed out after 120ms","hasSessionRef":true},
          "branchAfterDeadline":"brl-subagent-ac58779c","branchStillExists":["brl-subagent-ac58779c"],
          "B":"PENDING","C":"PENDING","sessionCallsAfterB":2,"sessionCallsAfterC":2,
          "runningRecords":[{"task":"B: same repo branch mode","status":"running"}],"aborts":1}
```

Reading: A's deadline fired (status `stopped`, `completedAt` set, `error: "Timed out after 120ms"`), the repo is
still checked out on A's work branch, the branch still exists, and `_sessionRef` is still present — i.e. **no
settle ran**. B (same repo, branch mode) is `PENDING` after 1.2 s; B *did* reach the SDK (`createAgentSession`
calls 2) and left a `running` agent record. C (non-git) is `PENDING` and `createAgentSession` stayed at 2: C never
reached the SDK at all. That is the convoy exactly as the issue describes it.

### 1.3 The convoy is also the everyday shape (measured)

```
W460P-P8 {"bBefore":"PENDING","cBefore":"PENDING","bAfter":"resolved","cAfter":"resolved","head":"brl-subagent-572653e2"}
```

A is a branch-mode run with a 10-minute budget and a prompt that is simply *not finished yet* — no deadline, no
bug. B (same repo, branch mode) waits on the git lock as designed. C (no git mode) **also** waits, and only
resolves after A's prompt resolves and A settles. The probe held A for ~1 s; the mechanism does not depend on the
duration, so **inferred**: a healthy 20-minute branch run blocks every spawn in the process for 20 minutes. This
is the amplifier M2, and it is present without any never-settling behaviour.

### 1.4 A real non-settling prompt does the same thing (measured)

The dossier's F2.3 used `vi.fn()` prompt mocks. To check the premise with the real SDK, probe 1 drives a real
`createAgentSession` (real `Agent`, real `AgentSession`, real extension runner; an in-memory session manager, so
no file is written) with one fake `modelRuntime` whose `streamSimple` returns a stream that emits `start` and then
never settles **and never listens to the abort signal**:

```
W460P-P1 {"beforeAbort":{"isIdle":false,"messages":2},"promptAfterAbort":"PENDING",
          "abortAfter":"PENDING","abortRejection":null,"idleAfterAbort":false,"sessionFile":null}
```

Then the whole path — real spawn, real git repo, real SDK session, one scratch line injecting the model runtime
(diff B.0) — through the deadline:

```
W460P-P3 {"branchA":"brl-subagent-a5903c59","afterDeadlineStatus":"stopped","afterDeadlineCompletedAt":"set",
          "sessionStillNotIdle":true,"sessionFileExists":true,
          "onWorkBranchAfterDeadline":"brl-subagent-a5903c59","branches":"* brl-subagent-a5903c59",
          "B":"PENDING","C":"PENDING"}
```

The stub in §1.2 is therefore not an artifact: a real deaf stream produces the same record state, the same
unsettled session, the same held lock, and the same two blocked spawns. The cooperative control (a real
signal-aware stream, W460P-P3C) settles, leaves HEAD on `main`, leaves no `brl-subagent-*` branch, and lets B
resolve — so the harness is not simply "everything blocks".

### 1.5 What a blocked waiter has already done (measured + read)

B is not an invisible wait. Before it reaches the git-lock wait it has already:

* created its own SDK session directory — measured `W460P-P11 {"sessionsDirs":2,...}` for one real run plus one
  blocked waiter (`SessionManager.create` at `:1273`, before the branch block at `:1781`);
* persisted an agent record in `running` (`:1417-1418`) — measured in W460P-P2's `runningRecords`;
* persisted a `running` run entry and an inflight registry entry (`:1452`);
* taken a concurrency slot (`index.ts:3552` `acquireSlot` runs before `startBackgroundAgent`).

And it never returns an id to its caller, so no surface can even name the waiter. This residue is permanent: only
a process restart (or the #404 retention sweep, which never runs for a `running` record) clears it.

### 1.6 There is no manual escape (measured)

`stop_subagent` → `stopAgent` (`:1101`) returns **early** at `:1105` because the deadline already made the record
terminal, and a forced `abort()` on the still-held session never settles:

```
W460P-P5 {"stopAgent":"resolved","status":"stopped","completedAt":"set","hasSessionRef":true,
          "rawSessionAbort":"PENDING","head":"brl-subagent-33a17231",
          "branchExists":"* brl-subagent-33a17231"}
```

So the user's lever reports success and frees nothing. Before the deadline it is no better — `stopAgent` awaits
`abort()` and hangs too:

```
W460P-P12S {"stop":"PENDING","status":"stopped","completedAt":"set","hasSessionRef":true,"head":"brl-subagent-289e3b29"}
```

(a 600 s budget, so the deadline has not fired; `stopAgent` set `status: stopped` + `completedAt`, never returned,
and the ref is still held). Meanwhile the UI already believes the run is over: the poller's authoritative
completion check is `agent.completedAt` (`index.ts:2390`), which the deadline set at `:1980` →
`updateAgentStatus` (`:999-1001`). The state is precisely "terminal to every surface, alive in the SDK".

---

## 2. Options

Cost is source+test lines for the change as scoped here (S ≈ ≤40 source / ≤120 test, M ≈ 40-120 / 120-300,
L > that). "Reversibility" = how hard it is to undo after release.

| # | Option | Mechanism | Fixes | Blast radius | Cost | Reversibility | Risk if wrong |
|---|---|---|---|---|---|---|---|
| **0** | Do nothing + document | Keep abort-only; write down that the settle is the only releaser | nothing | docs | S | trivial | The convoy stays discoverable only by reading `gitBranchLocks`; every long branch run keeps blocking all spawns |
| **a** | Release the lock on the deadline's terminal write | one block in `armDeadline` calling `releaseGitLock?.()` | the lock is free, the queue drains | deadline path + git ownership semantics | S (7 lines) | easy | **measured broken**: the second run builds on the first's work branch and the repo ends stranded on it (W460P-P4) |
| **b** | Refuse a second branch-mode spawn while the owner is terminal-but-unsettled; name the state | owner map + predicate + explicit throw before the git-lock wait | the queue drains, the user gets a name and a lever; no data hazard | one map + one predicate + the refusal's cleanup path | S (~35 source) | easy (delete the branch of the predicate) | False positives during the settle-in-flight window → spurious refusals; the repo is still unusable until restart |
| **c** | Bound the queue wait with an explicit "blocked by an unsettled run" error | timeout on `await prev` | same as (b) but only after the timeout | the promise chain itself (no removal primitive) | M | medium | A timed-out waiter must resolve its own `gate` and clean its map entry, or it leaves a dangling link; and it delays the honest error by the timeout |
| **d** | Narrow the spawn-queue critical section: release it before the per-repo git wait | one `resolveNext()` before `await prev` (`:1797`) | **the process-wide convoy**, for every case — including healthy long runs | one line + the queue's documented boundary | S (1 line + comment) | trivial | Two spawns can now be in post-SDK setup concurrently (they were already concurrent after each spawn returned); the pi-API import/`createAgentSession` region stays serialized |
| **e** | Repair the orphan work branch (persist the base, restore it on the next branch-mode spawn / boot) | durable `headState` on the run record + a pre-spawn check "HEAD is on an unowned `brl-subagent-*` branch → restore base" | the exit path after (b), and the crash-mid-run case | a new durable field + a boot/spawn repair path | M-L | medium (a repair that guesses the base wrong moves the user's tree) | Restoring the wrong base, or deleting a work branch a user wanted; needs its own decision record |

### (a) Release on the deadline's terminal write — measured, and it is not just "risky"

The sharp edge in the issue ("a still-running child writing into a branch another run now owns") is real, but the
measurement shows something worse: the lock is also the **ownership marker for the working tree's HEAD**. Releasing
it without performing the teardown leaves the repo checked out on A's work branch, so the next run captures A's
branch as its base — deterministically, whether or not A is still writing.

Mutant (Appendix B.1) adds exactly the release block to `armDeadline`. Sequence: A deaf, deadline 120 ms → release;
B branch-mode same repo → runs; A's prompt resolves late *while B is mid-run*; B settles.

```
W460P-P4 {"branchA":"brl-subagent-8c59eeb7","aAfterDeadlineStatus":"stopped","headAtDeadline":"brl-subagent-8c59eeb7",
          "B":"resolved:bfffb814-94c2-4b57-98e0-db1649f9b265","branchB":"brl-subagent-9d01426c",
          "headAfterASettle":"brl-subagent-9d01426c","aAfterSettleStatus":"stopped",
          "aBranchRecorded":"brl-subagent-8c59eeb7","bBaseRecorded":"brl-subagent-9d01426c",
          "statusWhileB":"?? late-write.txt","headAfterBSettle":"brl-subagent-8c59eeb7",
          "branches":"* brl-subagent-8c59eeb7","statusAfter":""}
```

Reading, in order:

1. B resolves — the lock *is* released, so the queue drains. That is the only thing (a) buys.
2. `branchB` was created **on top of `branchA`** (`headAtDeadline` was `branchA`): B's `getHeadState` captured A's
   un-merged work branch as its base.
3. A's late settle finds HEAD on B's branch → `cleanupWorkBranch` takes the "tree moved off" early return
   (`:1603-1609`) → **A's branch is never restored or deleted**.
4. A's late write (`late-write.txt`) lands in B's working tree while B runs; B's settle `commitAll`s it into B's
   branch and then deletes B's branch (`statusAfter` empty) — the late write is destroyed, not surfaced.
5. B's settle restores **B's captured head state = `branchA`** → the repository ends stranded on A's orphan work
   branch, with B's branch gone. That is exactly the failure the C2 lock's own comment says it exists to prevent
   (`:1785-1791`).

So (a) does not trade "unblocked repo" against "a child may write": it trades a wedged repo for a **stranded repo
with the work branch still checked out** and B's diff computed against the wrong base. Also note it contradicts
ADR 0023 Decision 2 ("the deadline abort … never prunes or releases the branch lock") and would need a
superseding ADR.

### (b) Refuse, and surface the state — measured

Mutant (Appendix B.2): a `gitLockOwners: Map<key, runId>` set when the lock is actually acquired and cleared in
`releaseGitLock`; a predicate over the *agent record* (`completedAt` set, `_sessionRef` still present, age ≥ grace);
and a refusal before `await prev`, using the existing pre-start cleanup and a message naming the run.

```
W460P-P10 {"bResult":"rejected:gitMode 'branch' refused: repository … is locked by run e56f1292-…, which is terminal
            (stopped, Timed out after 120ms) but has not settled — its SDK session is still held and
            releaseWorkBranch never ran. The branch lock cannot be released safely while the session may still
            write. Stop the run or restart pi; the work branch is left checked out at …",
           "cResult":"resolved","bRecord":{"task":"B: same repo","status":"running"},
           "bRunEntries":[{"status":"running"},{"status":"failed","errorMessage":"gitMode 'branch' refused: …"}],
           "aStatus":"stopped","branchExists":"* brl-subagent-12bac426","head":"brl-subagent-12bac426"}
W460P-P10B {"B":"resolved","aStatus":"stopped"}   // after a cooperative settle: no false positive
```

What the measurement does **not** show: the cleanup is complete. `failPreStart` (`:1688-1697`) finalizes the run
entry and clears the registry entry but **does not flip the agent record** — B's persisted record is still
`running`. The branch-setup-throw path immediately below (`:1827-1848`) does call `updateAgentStatus(id, 'failed', …)`,
and the refusal must mirror it. This is the kind of gap the dossier exists to catch before the brief: a loud
refusal that leaves a zombie `running` record is not obviously better than the silent block it replaces.

The predicate's false-positive window is the settle-in-flight interval: measured **88 ms** between the deadline and
the settle for a cooperative real-SDK run (W460P-P6; the settle is the moment `_sessionRef` is cleared and the lock
released). With a grace of a few seconds the window is unreachable in practice; with grace `0` (the probe) it is
reachable in principle. The predicate also inherits one edge from `stopAgent`: a manual stop stamps `completedAt`
through `updateAgentStatus` (`:999-1001`) but does **not** clear `_sessionRef`, so a manually stopped deaf run is
"terminal + unsettled" immediately — which is correct (it is stuck), just not deadline-specific.

### (c) Bound the wait, explicitly — why the honest version is (b), not a timer

The obvious implementation — race `await prev` against a timeout, then throw — is **not local**. The lock is a
promise chain with no removal primitive: each waiter installs `entry = prev.then(() => gate)` as the new head
(`:1795-1796`) *before* it waits. If the waiter throws without resolving its own gate, every later spawn chains
through it (`C`'s `await prev` is `B_entry = A_entry.then(() => gateB)`) and blocks forever even after A releases —
a second, self-inflicted wedge. If it resolves its gate on timeout, the chain survives, but the map entry must be
deleted only when it is still the head, and a resolved-but-stale entry lingers until the next branch spawn passes
through. Both are implementable; neither is a one-liner, and neither produces a behaviour different from (b)'s
"refuse immediately" except that the user waits first.

So (c) is best expressed as (b)'s **pre-enqueue check**: inspect the current owner *before* installing the chain
link, refuse if it is stuck, and never enter the chain. That is what the (b) mutant does, and it is why its error
is immediate (`bResult` above) instead of arriving after a timeout. A pure (c) — a timeout on the wait, with no
owner knowledge — is strictly worse: it delays the error, and the error cannot name the owner.

### (d) Narrow the queue's critical section — measured, and suite-clean

The spawn queue's documented purpose is "pi's API modules aren't safe for concurrent access from extensions"
(`:28-29`), which is the import + `createAgentSession` region. The per-repo git wait is not part of it. Mutant
(Appendix B.3) calls `resolveNext()` immediately before `await prev` at `:1797`; the `finally` call stays and is
idempotent.

```
W460P-P9 {"bBefore":"PENDING","cBefore":"resolved","bAfter":"resolved","cAfter":"resolved","head":"brl-subagent-40f2c1d6"}
```

B (same repo) still waits for the lock, as designed; C (non-git) resolves in the same tick. The existing three
suites are green on the mutant (170/170 — identical to the base copy), and the whole suite's failure set is
byte-identical to the base copy's (37 `FAIL` lines, all environmental: a `/tmp` tree has no `README.md`,
`presets/`, `templates/`, `.pi/` or package manifest at its root — the diff is `IDENTICAL-FAILURE-SET`).

What (d) does **not** do: free the same-repo lock, or turn B's wait into an error. It fixes the amplification, not
the wedge. It also leaves the existing C2 chain test intact (B still cannot touch git until A releases) and does
not invalidate the fan-out's up-front `gitMode: 'branch'` rejection (`CHANGELOG.md:117` — the spawn still does not
return until it has the lock, so a fan-out would still block).

### (e) Repair the orphan branch — measured, and why it is a follow-up

After a restart the lock map is empty, but the repo is not repaired. With the tree left on `brl-subagent-orphan`
(as a crash or a (b)-then-restart leaves it), the next branch-mode spawn builds on it and restores it as its base:

```
W460P-P7  {"dBranch":"brl-subagent-dd720748","diffHasOrphanWork":false,"headAfter":"brl-subagent-orphan",
           "branches":"* brl-subagent-orphan","status":""}
W460P-P7D {"result":"rejected:gitMode 'branch' requested but work branch setup failed: working tree has
           uncommitted changes; commit or stash before requesting background gitMode=branch isolation.
           Refusing to spawn the background agent unisolated.","head":"main"}
```

`diffHasOrphanWork: false` is the silent part: D's diff is computed from `headState.sha` = the orphan branch's
commit, so the earlier run's committed work is outside D's diff window and invisible in the result. A dirty orphan
tree is refused loudly (the message above), but a *clean* orphan — the common case, because `cleanupWorkBranch`
commits before it restores — is accepted silently and becomes the new base. Nothing in the codebase persists a
background run's `headState`; `restoreHead` appears only on the foreground path (`index.ts:3474-3501`,
`:3718-3801`), never in `recovery*.ts` (coverage: `grep -rn "restoreHead\|deleteBranch" src/recovery*.ts src/index.ts` →
index.ts only).

This matters for the recommendation: (b)'s exit is "restart", and restart does not repair the tree. That is a real
gap, but the repair needs a durable owner/base field and a boot-time decision (what if the record is gone, or the
branch was moved by hand) — its own decision record, not this PR.

---

## 3. Does the deadline even know?

### 3.1 The evidence inventory at the moment the timer fires

The whole deadline body is the closure at `session-manager.ts:1974-2010`. Its only guard is
`if (agent.completedAt) return;` (`:1976`). What it *could* read, and what each signal actually means:

| Signal | Where it lives | What it says at the deadline | Measured? |
|---|---|---|---|
| `agent.completedAt` / `agent.status` | the agent record; set by the deadline itself at `:1980` → `updateAgentStatus` (`:994-1001`) | **nothing** about liveness — the deadline writes it | measured (W460P-P2/P3: `completedAt: "set"`, `hasSessionRef: true`) |
| `session.isIdle` | the live `AgentSession` in the closure | **real** evidence: `false` ⇒ a run is active in the SDK | measured (W460P-P1 `idleAfterAbort:false`; W460P-P3 `sessionStillNotIdle:true`) |
| the `session.abort()` promise | returned at `:1987`, **discarded** (`.catch` only) | **real** evidence: resolves when the agent becomes idle; pending ⇒ the SDK still holds the run | measured (W460P-P1 `abortAfter:"PENDING"`; cooperative control resolves) |
| `session.messages` | session projection | a snapshot; a hung turn does not change it, and it does not distinguish "thinking" from "stuck" | read |
| session-file mtime | `agent._sessionFile` | no reader exists; and a stalled stream writes nothing for minutes, so staleness is not death | read (`grep -n "statSync\|mtime" src/session-manager.ts` → retention/prune and record-lineage only, `:265/:313/:883`; none in the deadline) |
| a child / PID handle | — | **does not exist**: background runs are in-process `AgentSession`s. The SDK's bash tool kills its subprocess tree on abort (`pi-coding-agent/dist/core/tools/bash.js:80/:88/:99`) but that cannot settle the run promise — the wedge is the promise, not the process | read |
| the run entry / registry | not written by the deadline on this base (#453 adds the terminal write) | a *record*, not a liveness signal | read (`:1468-1474`, single guard; #453 not merged) |

**Conclusion (inferred from measured facts):** the deadline *can* distinguish "the child is still writing" from
"the child is dead" — the SDK's own `abort()` promise / `isIdle` is exactly that discriminator, and the code throws
it away. But it cannot use that discriminator to justify a **release**, because of M1: a dead child settles and
releases by itself. The only runs on which "release" would fire are the runs where the discriminator says "still
active". The honest use of the signal is therefore **not** "release when it looks dead" (that case never reaches
the policy) but "**refuse to start another branch run while the owner is still active**" — which is option (b).

### 3.2 What does not exist at the deadline

* **No write-activity evidence.** Nothing tracks the last write to the working tree or the session file for this
  run. The child may be a hung HTTP stream (writes nothing) or a `bash` tool running a 40-minute build (writes
  constantly); both look identical from the record. The dossier already measured the consequence on the session
  file side: after a prune, a still-writing session's next append fails `ENOENT`
  (`issue-453-investigation-2026-11-07.md` F3.1/F3.2), which is why finalizing at the deadline is unsafe.
* **No kill.** There is no operation that ends a session that ignores `abort()`. `stopAgent` cannot (`:1105` early
  return, measured W460P-P5). The SDK's `dispose()` exists but is cooperative too: it calls `agent.abort()` (the
  same `AbortController`) and `abortBash()` (`pi-coding-agent/dist/core/agent-session.js:1024-1034`) — it can end a
  stuck *tool*, not a stream that ignores the signal, and it does not settle `prompt()`. So every "force" option is
  a *logical* release, not a physical one.
* **No ownership record on the lock.** `gitBranchLocks` stores a bare `Promise<void>` (`:37`) — not the run id, not
  the acquired-at time, not whether the holder is terminal. Any refusal/repair option must add that (§5 sketch).
* **No durable `headState`.** `headState` is a local (`:1580`) captured at setup; it is never persisted. After a
  restart the base branch is unrecoverable from our records (probe 7 measured the consequence).

### 3.3 The race, measured

For a **cooperative** real-SDK run (the normal case), the sequence after the deadline is: timer flips the record
(`:1980`) → `abort()` (`:1987`) → the stream throws `AbortError` → the SDK resolves `prompt()` → the `.then`
handler runs `cleanupWorkBranch()` → the lock releases. The settle landed **88 ms after the deadline**:

```
W460P-P6 {"deadlineStatus":"88ms-after-deadline","settleAfterDeadlineMs":88,
          "samples":[{"t":88,"status":"stopped","ref":false,"head":"main"}],"head":"main","branches":""}
```

So (a) opens an ~88 ms window in the *safe* case in which a second spawn can create its branch on top of the
first's; once that happens, the first run's settle takes the "tree moved off" early return and the repo ends on the
first run's work branch (W460P-P4). A grace window does not remove the window's cause: the release would still
leave the tree on the work branch, which is the base-confusion half of (a) that has nothing to do with the child
being alive.

---

## 4. The queue's honest failure mode

### 4.1 What the user sees today

Measured (P2/P11): the second dispatch's tool call **never returns**; the queue behind it never drains; and the
waiter has already created a session dir, a `running` agent record, a `running` run entry, a registry entry and a
concurrency slot, with no id ever returned to the caller. Inference (stated as such): because pi tool calls have no
timeout, the conductor's turn stops at that call and the session looks hung; `/brl-subagent` history shows a
`running` row that no live row explains; the first run's row says "stopped / timed out" while its session is still
alive. There is no message anywhere — `gitBranchLocks` is the only place the truth is recorded.

### 4.2 The refusal message (sketch)

```
gitMode 'branch' refused: <repo key> is locked by run <id>, which stopped at the deadline
(<timeout reason>) <N>s ago but has not settled — its SDK session is still held, so the
branch lock cannot be released while it may still write. The work branch <branch> is still
checked out. `stop_subagent <id>` reports success and frees nothing; restart pi to
clear the lock, then restore the base branch by hand.
```

Two implementation constraints on the text, both measured/read:

* `sanitizeErrorMessage` (`src/sanitize.ts:325-343`) neutralises the **cwd and its parent** (`<cwd>`, `<home>`) and
  truncates at `MAX_ERROR_MESSAGE_LENGTH`. A repo-root path in the message will be masked — the message should
  name the **run id** and the **branch**, not the absolute path.
* The branch name is available at the refusal point only if the *owner's* record carries it — today
  `agent.result.gitBranch` is written at **settle** (`:1876` aborted, `:2153` failed, `:2188` completed), which
  never ran for a stuck run.
  So either the message omits the branch, or the sketch adds a `workBranch` stamp on the agent record at setup
  (a small, useful addition: it is the one field a human needs to recover the repo by hand).

### 4.3 Where it is emitted — no new channel

The refusal is a `throw` from `spawnBackgroundSession`; the single-dispatch path catches it at `index.ts:2721-2734`
and returns a tool result:

```
Failed to spawn background agent: <message>      // index.ts:2731, details undefined, isError: true
```

with `log.error("Failed to spawn background agent", { error: message })` at `:2729`. That is exactly the right
audience (the conductor that dispatched) and the right shape (an error result, not a toast), and the slot is
released by the dispatch's `finally { releaseSlot(...) }` (`:3947-3949`). The fan-out path has its own per-task
text (`index.ts:2085`), but fan-out already rejects `gitMode: 'branch'` up front (`CHANGELOG.md:117`), so it is
not the target. **No new notice is needed**; the existing spawn-failure result carries it. A `ctx.ui.notify` would
be a second channel for the same fact — not recommended.

### 4.4 The cleanup that must ride with the refusal

A throw must not leave B's own residue. Measured gap in the (b) mutant: `failPreStart` (`:1688-1697`) finalizes the
run entry and clears the registry entry but does **not** call `updateAgentStatus`, so B's agent record stayed
`running` (W460P-P10 `bRecord.status: "running"`). The refusal must mirror the branch-setup-throw path
(`:1827-1848`): `updateAgentStatus(id, 'failed', reason)` → `finalizeRunEntry('failed', reason)` (which prunes B's
session dir per the #404 gate) → `transcript.completeTranscript(id, 'failed')`, then throw. Otherwise the fix
converts one silent hang into one loud error plus one new zombie row. The prune half was measured with the real
SDK on the mutant: the waiter's session dir is gone after the refusal (`W460P-P12 {"dirsBefore":1,
"b":"rejected:…","dirsAfter":1}` — only the holder's dir remains).

---

## 5. Recommendation

**O-(b)+(d): narrow the spawn-queue critical section (d), and refuse — loudly, before waiting — to start a second
branch-mode run in a repository whose lock owner is terminal-by-deadline but unsettled (b). Keep the lock held.**

Why this pair:

* **(d) is the amplifier fix and carries no policy.** M2 shows the process-wide convoy is an everyday
  serialization, not a bug-only shape; moving the per-repo wait out of the pi-API critical section is one line
  (`:1797`), leaves the pi-API region serialized, keeps the C2 chain semantics, and passed the three suites
  (170/170) and the full suite with a failure set identical to base. It is the cheapest real improvement and it
  survives whichever policy is later chosen.
* **(b) is the only honest policy for the lock.** M1 says a release always fires on a run the SDK still considers
  live; (a) was measured to strand the repo and destroy a late write (P4). (b) leaves the data alone, names the
  owner, and gives the user a lever — and because the refusal happens *before* the chain link is installed, it also
  drains the queue (measured: C resolved while B was refused) and frees the slot via the dispatch's `finally`.
* **(c) collapses into (b).** A bounded wait needs chain surgery and produces a later, less informative error;
  the pre-enqueue check is the same policy without touching the chain.
* **(e) is the exit-path gap, not this PR.** (b)'s exit is "restart", and restart leaves the tree on the work
  branch (P7). That needs a durable `headState` and a boot-time repair decision; it belongs in its own issue (and
  its own ADR), referenced from (b)'s message as a manual recovery step in the meantime.

**Cost:** (d) S — 1 source line + a comment, ~50 test lines (the convoy probes as assertions: B pending, C
resolved). (b) S/M — ~35 source lines (owner map, predicate, refusal, agent-record flip, `workBranch` stamp), ~110
test lines (refusal message, no zombie record, no false positive after a cooperative settle, two-repo independence).
Combined one PR, ~40 source / ~160 test lines.

**Release blocker?** No. Nothing is lost or corrupted today; a dispatch is delayed forever (a stuck tool call, not
a wrong result) and the repo needs a manual restore. It is a permanent-wedge bug for long-lived processes, so it
should land in the next patch release rather than wait, but it does not gate one.

### 5.1 Falsifiers — what would change this recommendation

1. **A real provider stream that cannot ignore abort.** If every real stream is bounded by its own timeout, the
   never-settling case is theoretical and (b) is defensive rather than necessary. (d) still stands, because M2 does
   not depend on the bug. *Settling measurement:* a proxy that accepts and never responds
   (`ALL_PROXY=http://127.0.0.1:<blackhole>`), dispatch a branch-mode run, `stop_subagent` after 10 s, watch the
   lock (the dossier's §12.1/12.3 list this as unverified; it is still unverified here).
2. **A product requirement that a second branch run must proceed while the predecessor is unsettled.** Then (b) is
   wrong and the answer is a quarantine design: perform the teardown on the timer, mark the run quarantined so a
   late settle becomes a no-op, and accept that the late child writes into the *base* tree. That is (a) plus the
   teardown and a quarantine marker, and it needs its own ADR (it supersedes ADR 0023 Decision 2). *Settling
   measurement:* a user story, not a command.
3. **(b)'s predicate fires on a healthy run.** If a cooperative settle can take longer than the grace (e.g. a huge
   `commitAll` on a large tree), the refusal becomes a false positive. *Settling measurement:* time
   `cleanupWorkBranch` on the largest supported repo; if it exceeds the grace, widen the grace or key the predicate
   on the run entry's deadline reason instead of age.
4. **The owner map leaks or misattributes.** With two repos and interleaved runs, the map must be per key and
   cleared in the same closure that releases the lock. The mutant does this and the C2 suites pass, but a
   three-repo interleave is not covered by a test yet (`unverified`; the sketch's step 2 covers it).

---

## 6. Relationship to #453

**Independent, no conflict — and #453 makes the state more coherent, not less.**

What #453 changes on this path (ADR 0023, decisions 1-3):

| #453 change | Touches #460 how |
|---|---|
| Deletes the caller's 30 m timer (`index.ts:2450-2495` on this base) and the `deadlineOwner` flag (ADR 0023 D1) | No interaction. The convoy is created by the *spawn's* lock, not by who arms the deadline. `armDeadline` stays the one arm site. |
| The timer writes the terminal **run entry** at the deadline, `{ prune: false }` (ADR 0023 D3) | Additive. Today the deadline only flips the **agent** record (`:1980`); #453 also finalizes the run entry. (b)'s predicate reads the agent record (`completedAt` + `_sessionRef`), which #453 does not change — so (b) works before or after #453. After #453 the run entry is terminal too, which is a better message ("failed/timeout since <t>") and a possible alternative predicate. |
| Splits `runFinalized` into `entryWritten` + `pruned` (`:1468-1474`) | The refusal path calls `finalizeRunEntry('failed', reason)`; the split must be honoured there too. Note the refusal happens **before** B's acceptance write (`:2035`) — the git block is at `:1781`, the acceptance write at `:2035` — so B's entry still carries `acceptedAt: null` and `entryWritten` false → write, `pruned` false → prune B's own dir. That is the right semantics: a refused run is provably never-started (#447). No conflict, but the implementer must not bypass the split. |
| Time origin = record creation (ADR 0023 D5) | No interaction with the branch lock; the grace clock is `completedAt`, set by the deadline, so it does not drift with the arm origin. |

What #453 deliberately does **not** do (ADR 0023 Consequences, Decision 2): hand the timer the branch lock. So
#460 cannot be closed by #453 and must not be folded into it. Conversely, (a) would *contradict* ADR 0023
Decision 2 and require a superseding ADR; (b) and (d) are consistent with it (the timer still releases nothing; (b)
is a *reader* of the deadline state, not a releaser).

**Sequencing.** Either order works. If #453 lands first, implement (b)'s message from the run entry's terminal
reason and keep the predicate on the agent record. If #460 lands first, #453's deadline write lands on a run whose
lock is refused — no interaction, because the write is on the run entry and the predicate is on the agent record.
(d) is orthogonal to both and can land in either PR.

---

## 7. Execution sketch — what an implementer brief for (b)+(d) must cover, in order

**Step 0 — preconditions (5 min).** `git rev-parse HEAD` (this dossier is at `5f18385`); confirm `#453`'s state
(`grep -n "deadlineOwner" src/session-manager.ts src/index.ts` → 5 hits if unmerged: 3 in session-manager,
2 in index.ts) and adjust only the line anchors, not the design. Baseline on a copy of this base (the repo itself
was not run, to keep it read-only): `vitest run src/__tests__/session-manager.test.ts
src/__tests__/background-session-persistence.test.ts src/__tests__/background-fan-out.test.ts` → 170 green.

**Step 1 — (d), one line, test first.** In `/tmp` (or a branch), write the assertion: A branch-mode running (prompt
not settled), B branch-mode same repo pending, C non-git **resolved within 1 s**; then A settles → B resolves. Run
it against the shipped code: it must fail on C (measured `PENDING`). Apply
`resolveNext()` immediately before `await prev` at `:1797`, with a comment stating the critical section is the pi
API import + `createAgentSession`, not the per-repo wait. Re-run: C resolves, B still pends. Add the regression
test for "B still cannot touch git until A releases" (the existing C2 chain test already pins the `createWorkBranch`
count; keep it green).

**Step 2 — (b) state, test first.** Add `gitLockOwners: Map<string, string>` beside `gitBranchLocks` (`:37`), set
immediately after `await prev` (`:1797`, when the lock is actually held), cleared inside `releaseGitLock`
(`:1798-1804`) only when the id matches, and cleared by `__testResetGitBranchLocks` (`:44-46`). Tests: two repos interleave (owner is
per key); a waiter that never acquires does not become the owner; a release by a stale id does not delete the new
owner. Also stamp `workBranch` on the agent record at setup (right after `:1818`) so the refusal can name it —
`result.gitBranch` is settle-only today (`:1876`, `:2153`, `:2188`).

**Step 3 — the predicate, test first.** `isStuckTerminalOwner(runId)`: `agents.get(runId)` exists, `completedAt`
set, `_sessionRef !== undefined`, `Date.now() - completedAt >= GRACE`. Tests: a cooperative run that settles within
the grace is never refused; a deadline-expired deaf run is refused after the grace; a manually stopped run is
refused (it is stuck too); a run that settled (`_sessionRef` cleared) is never refused. GRACE: a named constant,
documented as "longer than the measured 88 ms settle lag plus the largest observed `cleanupWorkBranch`, and shorter
than a human's patience" — start at 30 s.

**Step 4 — the refusal, test first.** Before the chain link is installed (between `:1791` and `:1792`), when
`isStuckTerminalOwner(holderId)`: `updateAgentStatus(id, 'failed', reason)` → `finalizeRunEntry('failed', reason)` →
`transcript.completeTranscript(id, 'failed')` → `throw new Error(reason)`. Do **not** throw without the record flip
(measured: the record stays `running`). Tests: the throw's message names the run id and the branch; B's agent record
is `failed`; B's run entry is terminal exactly once; B's session dir is pruned; B's registry entry is gone; C
(non-git) resolves; a second refusal in the same repo also fails fast (no chain link installed).

**Step 5 — docs + contract.** CHANGELOG under "explicit limits": a branch-mode run's lock is held until its settle;
a run that is terminal-by-deadline but unsettled makes later branch-mode dispatches in that repository **fail fast
with a named reason**; the repo stays on its work branch and the lock needs a process restart. If a decision record
is required, a new ADR (0025) "branch-lock refusal on an unsettled owner" — or an amendment note under ADR 0023
referencing it; do not edit 0023 (append-only).

**Gates.** The three suites + a new `branch-lock-convoy.test.ts`; `npm run typecheck`; `node scripts/docs-arch.mjs`;
`node scripts/docs-decisions.mjs` (only if an ADR is added); `git diff --check`; the test-budget JSON report.

**Do not** in this PR: release the lock from the timer (contradicts ADR 0023 and measured broken); add a second
timer; change `stopAgent`; touch the foreground branch path (`index.ts:3474-3501`).

---

## 8. Open questions for the conductor / user

1. **Is "the repository is unusable for branch runs until restart" an acceptable shipped behaviour** for a run the
   SDK will not release? (b) makes it loud and named; it does not make the repo usable. The alternative is a
   quarantine design (teardown on the timer + a late-settle no-op) which needs an ADR superseding ADR 0023 D2 and
   accepts base-tree pollution in exchange for a usable repo. The dossier's evidence says the second is riskier;
   the product owner may still prefer it.
2. **Immediate refusal vs a short bounded wait.** Recommendation is immediate (the wait cannot name the owner any
   sooner and needs chain surgery). If the conductor wants a "give it 5 s in case the settle is in flight" grace,
   that is the same predicate with a wait — but then the chain must be entered, and (c)'s chain problem returns.
   The measured 88 ms settle lag is the only number that argues for waiting at all.
3. **Grace value and location.** 30 s constant (my default) vs a config field. The grace only bounds the
   false-positive window; it does not affect correctness after the first refusal.
4. **Does the `workBranch` stamp ride this PR?** The refusal message needs it (the branch was only ever recorded at
   settle), and it is one line at setup. If the repair follow-up (e1) is accepted, the stamp is also its seed.
5. **Can (d) ship alone** if the policy decision on (b) is deferred? It is one line, independent, and fixes the
   everyday convoy. It leaves the stuck run silently holding its own repo, which is today's behaviour for that repo.
6. **Follow-up issue for the orphan-branch repair** (probe 7): after a crash or a (b)-then-restart, the repo is on
   an unowned `brl-subagent-*` branch and the next run silently uses it as the base. Is that accepted as a separate
   issue, or does the conductor want it in the same brief?

---

## 9. Unverified / not measured (with the settling command)

| # | Claim I did **not** establish | Why | Settling command |
|---|---|---|---|
| 1 | A real provider stream can ignore `AbortSignal` | The probes use a synthetic deaf stream (as the dossier did); no live provider was exercised | Dispatch a branch-mode run through a proxy that accepts and never responds (`ALL_PROXY=http://127.0.0.1:<blackhole>`), `stop_subagent` after 10 s, then read `get_subagent_result` and the branch lock |
| 2 | The refusal's false-positive rate at a production grace | The probe used grace 0 (to make the mechanism fire deterministically) and did not time `cleanupWorkBranch` on a large tree | Time `cleanupWorkBranch` (commitAll + captureDiff + restoreHead + deleteBranch) on the largest supported repo; compare to the grace |
| 3 | The user-visible "tool call never returns" | Measured at the spawn level (`PENDING`), not through a live TUI/pi session | Run pi with the extension, dispatch a branch-mode run with a deaf provider, then a second one; observe the tool call and the footer |
| 4 | The owner map under a three-repo interleave | The mutant test covers one repo and two tests; the C2 suites cover the chain but not the new map | Add a probe with repos R1/R2/R3, run A1(deaf), B2, B1(refused), C2, then check ownership per key |
| 5 | Whether a stuck run's session-file mtime is ever a useful signal | Not needed for any option in this dossier; no code reads it in the deadline | Compare mtime across a hung stream vs a long tool call (`read` tool on a big file) and see if it discriminates |
| 6 | That the refusal's `updateAgentStatus` flip actually removes the zombie row end-to-end | Measured only on the mutant's `failPreStart` path (record stayed `running`); the fixed path is in the sketch, not yet run | Implement step 4 of the sketch and assert B's persisted record is `failed` and its run entry is terminal exactly once |

---

## Appendix A — probe inventory (exact commands and outputs)

All probes run with the repo's own vitest (`node_modules` symlinked from the checkout); the config includes
`probes/**/*.test.ts` (and, for the suite runs, `src/__tests__/**/*.test.ts`).

| Probe | Tree | Command | Output line |
|---|---|---|---|
| **P1** real SDK, deaf stream | `/tmp/brl460` | `./node_modules/.bin/vitest run --config vitest.config.ts --silent=false probes/probe1-real-sdk.test.ts` | `W460P-P1 {...promptAfterAbort:"PENDING", abortAfter:"PENDING", idleAfterAbort:false...}` |
| **P2** shipped convoy (stub SDK, real repo) | `/tmp/brl460` | `... probes/probe2-convoy.test.ts` | `W460P-P2 {...B:"PENDING", C:"PENDING", sessionCallsAfterB:2, sessionCallsAfterC:2...}` |
| **P3** real SDK + real repo convoy | `/tmp/brl460` | `... probes/probe3-real-convoy.test.ts` | `W460P-P3 {...sessionStillNotIdle:true, B:"PENDING", C:"PENDING"}` |
| **P3C** cooperative control | `/tmp/brl460` | `... probes/probe3b-cooperative.test.ts` | `W460P-P3C {...status:"stopped", headBeforeB:"main", branchesBeforeB:"", B:"resolved:..."}` |
| **P4** option (a) mutant | `/tmp/brl460m` | `... probes/probe4-option-a.test.ts` | `W460P-P4 {...headAfterBSettle:"brl-subagent-8c59eeb7", statusAfter:""}` |
| **P5** stopAgent / no escape | `/tmp/brl460` | `... probes/probe5-stopagent.test.ts` | `W460P-P5 {...stopAgent:"resolved", hasSessionRef:true, rawSessionAbort:"PENDING"}` |
| **P6** cooperative settle latency | `/tmp/brl460` | `... probes/probe6-cooperative-latency.test.ts` | `W460P-P6 {"settleAfterDeadlineMs":88,...}` |
| **P7** orphan branch after restart | `/tmp/brl460` | `... probes/probe7-orphan-branch.test.ts` | `W460P-P7 {...headAfter:"brl-subagent-orphan", diffHasOrphanWork:false}` / `W460P-P7D {...refused...}` |
| **P8** healthy long run blocks all spawns | `/tmp/brl460` | `... probes/probe8-legit-long-run.test.ts` | `W460P-P8 {"bBefore":"PENDING","cBefore":"PENDING",...}` |
| **P9** option (d) mutant | `/tmp/brl460d` | `... probes/probe9-d-long-run.test.ts` | `W460P-P9 {"bBefore":"PENDING","cBefore":"resolved",...}` |
| **P9C** option (d) convoy | `/tmp/brl460d` | `... probes/probe9c-d-convoy.test.ts` | `W460P-P9C {...B:"PENDING", C:"resolved:{...}"}` (assertions copied from P2 fail by design) |
| **P10** option (b) mutant | `/tmp/brl460b` | `... probes/probe10-option-b.test.ts` | `W460P-P10 {...bResult:"rejected:gitMode 'branch' refused: ...", cResult:"resolved", bRecord:{status:"running"}}` / `W460P-P10B {"B":"resolved"}` |
| **P11** waiter residue (real SDK) | `/tmp/brl460` | `... probes/probe11-waiter-residue.test.ts` | `W460P-P11 {"sessionsDirs":2,...}` |
| **P12** refusal prune (real SDK, option-b mutant) | `/tmp/brl460b` | `... probes/probe12-b-real.test.ts` | `W460P-P12 {"dirsBefore":1,"b":"rejected:gitMode 'branch' refused: …","dirsAfter":1}` |
| **P12S** `stopAgent` on a running deaf run | `/tmp/brl460b` | `... probes/probe12-b-real.test.ts` | `W460P-P12S {"stop":"PENDING","status":"stopped","completedAt":"set","hasSessionRef":true}` |

Note on process isolation: probes that wedge the **spawn queue** poison the module for the rest of the vitest
worker. P3's second test (the cooperative control) timed out at 60 s because it was in the same file as P3 — a
direct demonstration that there is no reset for `spawnQueue` (only `__testResetGitBranchLocks` for the lock map,
`:44-46`). The cooperative control therefore lives in its own file (`probe3b`). This is a process-lifetime fact, not
a harness artifact.

### Suite runs (regression coverage)

```
# base copy, option-(b) mutant, option-(d) mutant — same three suites
$ cd /tmp/brl460{,b,d} && ./node_modules/.bin/vitest run src/__tests__/session-manager.test.ts \
    src/__tests__/background-session-persistence.test.ts src/__tests__/background-fan-out.test.ts
→ 3 files, 170 tests, all pass        (identical on all three trees)

# whole suite, base copy vs each mutant
$ .../vitest run src/__tests__      → 37 FAIL lines each (23 files)
$ diff base-fails.txt b-fails.txt   → IDENTICAL-FAILURE-SET
$ diff base-fails.txt d-fails.txt   → IDENTICAL-FAILURE-SET
```

The 37 failures are environmental: a `/tmp` tree has no `README.md`, `presets/`, `templates/`, `.pi/` or package
manifest at its root, so the doc/preset/manifest/e2e tests fail identically in the base copy. They are not caused
by any mutant.

---

## Appendix B — mutant diffs (the load-bearing hunks; one helper body is elided and marked)

### B.0 The one-line probe hook (present in every `/tmp` tree, inert without the global)

```diff
     resourceLoader,
+    // PROBE-460 ONLY: inject a fake modelRuntime so a REAL SDK session can be
+    // driven with a deaf stream. One added line; no logic change.
+    ...((globalThis as any).__brl460ModelRuntime
+      ? { modelRuntime: (globalThis as any).__brl460ModelRuntime }
+      : {}),
     model: resolvedModel,
```

### B.1 Option (a) — `/tmp/brl460m` (release in the deadline)

```diff
@@ -1997,6 +2002,13 @@
           error: (err as Error).message,
         });
       }
+      // PROBE-460 OPTION (a) MUTANT: release the per-repo git lock on the
+      // deadline's terminal write. This is the whole of the change — nothing
+      // else in the deadline path moves.
+      try {
+        releaseGitLock?.();
+        releaseGitLock = undefined;
+      } catch { /* ignore */ }
       if (bookkeepingFailure) {
```

### B.2 Option (b) — `/tmp/brl460b` (owner map + refusal)

```diff
@@ -36,6 +36,21 @@
 const gitBranchLocks = new Map<string, Promise<void>>();
+
+/** PROBE-460 OPTION (b) MUTANT: who holds each branch lock (run id). */
+const gitLockOwners = new Map<string, string>();
+function stuckGraceMs(): number { /* elided: (globalThis.__brl460StuckGraceMs ?? 30_000) */ }
+function isStuckTerminalOwner(runId: string): boolean {
+  const a = agents.get(runId);
+  if (!a?.completedAt) return false;
+  if (a._sessionRef === undefined) return false; // settle ran: not stuck
+  return Date.now() - a.completedAt >= stuckGraceMs();
+}
@@ -43,6 +58,7 @@
 export function __testResetGitBranchLocks(): void {
   gitBranchLocks.clear();
+  gitLockOwners.clear();
 }
@@ -1789,16 +1810,32 @@
     const lockKey = getRepoRoot(gitCwd) ?? gitCwd;
+    const holderId = gitLockOwners.get(lockKey);
+    if (holderId && isStuckTerminalOwner(holderId)) {
+      const holder = agents.get(holderId)!;
+      const reason =
+        `gitMode 'branch' refused: repository ${lockKey} is locked by run ${holderId}, ` +
+        `which is terminal (${holder.status}, ${holder.error ?? 'no error'}) but has not settled — ` +
+        `its SDK session is still held and releaseWorkBranch never ran. ` +
+        `The branch lock cannot be released safely while the session may still write. ` +
+        `Stop the run or restart pi; the work branch is left checked out at ${lockKey}.`;
+      failPreStart(reason);          // ← measured to leave the agent record 'running'
+      throw new Error(reason);
+    }
     const prev = gitBranchLocks.get(lockKey) ?? Promise.resolve();
@@
     await prev;
+    gitLockOwners.set(lockKey, id);
     releaseGitLock = () => {
       if (gitBranchLocks.get(lockKey) === entry) gitBranchLocks.delete(lockKey);
+      if (gitLockOwners.get(lockKey) === id) gitLockOwners.delete(lockKey);
       release();
     };
```

### B.3 Option (d) — `/tmp/brl460d` (queue released before the git wait)

```diff
@@ -1794,6 +1799,10 @@
     const entry = prev.then(() => gate);
     gitBranchLocks.set(lockKey, entry);
+    // PROBE-460 OPTION (d) MUTANT: the spawnQueue's critical section is the pi
+    // API import + createAgentSession above, NOT this per-repo git wait.
+    // Release it before waiting so one locked repo cannot wedge every spawn.
+    resolveNext();
     await prev;
```

---

## Appendix C — coverage lines (every search this dossier rests on)

```
$ git rev-parse --short HEAD && git branch --show-current && git status --porcelain
5f18385 / dev / (empty)

$ grep -n "releaseGitLock\|gitBranchLocks" src/session-manager.ts
11 lines: 37, 45, 1582, 1660, 1661, 1792, 1796, 1798, 1801, 1831, 1832
  (map reset, declaration, cleanupWorkBranch finally, chain install, release closure, setup-throw)

$ grep -n "cleanupWorkBranch()" src/session-manager.ts
1690, 1909, 2102, 2142, 2179, 2219  → all settle-side

$ grep -n "resolveNext" src/session-manager.ts
1238, 1239, 2284          → one waiter per spawn, released only in the finally

$ grep -n "export async function spawnBackgroundSession" src/session-manager.ts
1189                     → one declaration; one production caller (index.ts:2166)

$ grep -n "deadlineOwner" src/session-manager.ts src/index.ts
session-manager.ts:1215, 2015, 2023 · index.ts:2183, 2447   → #453 is NOT merged on this base

$ grep -n "let runFinalized\|if (runFinalized) return" src/session-manager.ts
1468, 1474                → the single guard #453 will split; unchanged here

$ grep -n "statSync\|mtime" src/session-manager.ts
265, 313, 336, 488, 496, 863, 876, 883, 884, 890
  → retention/prune + record lineage only; none in the deadline or the lock path

$ grep -rn "restoreHead\|deleteBranch" src/recovery*.ts src/index.ts
index.ts:72,73,3479,3493,3718,3750,3781,3786,3801  → foreground only; no background/boot repair

$ grep -n "ctx.ui" src/session-manager.ts
(no output)                → the spawn never emits a UI notice; failures are tool results

$ grep -n "releaseSlot(state, success, ctx)" src/index.ts
3948, in a finally         → a refused spawn releases its concurrency slot
```

---

## Appendix D — structural notes (flagged, not fixed; this is design, not a review verdict)

The code this change touches has some pre-existing shape problems that the implementer will feel. They are
reported, not acted on:

`SOLID/DRY violations flagged: 4`

| Smell key | Location | Note |
|---|---|---|
| `oversized-function` | `session-manager.ts:1189-2290` (~1100 lines) | `spawnBackgroundSession` owns the spawn, the deadline, the branch lifecycle, six settle paths, persistence and transcript I/O. Any of the options above lands in a function that is already too large for its responsibilities (SRP). |
| `duplicated-code` | `session-manager.ts:1688-1697` vs `:1836-1842` | The terminal-cleanup sequence exists twice and the copies differ: `failPreStart` omits `updateAgentStatus`. That divergence is exactly the measured zombie (`bRecord.status: "running"`, W460P-P10). |
| `deep-nesting` | `session-manager.ts:1974-2010`, `:2064-2279` | The deadline callback and the settle handler are both ~400-line nested try/catch structures; the refusal predicate and its cleanup must be inserted without adding another nesting level. |
| `oversized-file` | `session-manager.ts` (2286 lines) | The lock policy, the spawn and the settle live in one file; (b)'s owner map is the kind of state that would be better owned by a small `branch-lock.ts` module — but extracting it is out of scope here. |

One structural note without a standard key: `gitBranchLocks` is a promise **chain**, not a queue — there is no
removal primitive, which is why (c)'s bounded wait is not local (see §2 (c)).

---

## Appendix E — How the recommendation answers the issue body

| Issue body asks | Answer in this dossier |
|---|---|
| "What releases the branch lock when a run is terminal-by-deadline but the SDK still holds the session?" | Nothing can, safely. M1 + P4: the release fires only on runs the SDK still considers live, and a release without the teardown strands the repo. Answer: hold the lock; refuse (b). |
| "What does the queue do — a bounded wait with an explicit error is better than an unbounded silent block?" | Yes — but the honest form of "bounded wait" is a pre-enqueue refusal (b), because the chain has no removal primitive and a timed-out waiter must do surgery to avoid a second wedge. The queue's *process-wide* amplification is fixed separately and unconditionally by (d). |
| "Any change needs a probe that reproduces the convoy with a real non-settling prompt" | Done three ways: a real `createAgentSession` with a deaf stream (P1), the real spawn + real repo + real SDK (P3), and the shipped code with a stub prompt (P2) — the three agree. |
| "A decision-ready investigation (options, measured costs, falsifiers), then a brief. Do not implement from this body." | This file: §2 options, §5 recommendation + falsifiers + cost + release status, §7 execution sketch, §8 open questions. |

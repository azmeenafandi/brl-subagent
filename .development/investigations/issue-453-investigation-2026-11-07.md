# #453 investigation — who owns the background deadline

**Kind:** decision dossier. **No implementation, no repository change.** The six decisions are settled below
with options; the conductor picks, the brief carries the chosen option only.
**Base:** `dev` @ `6c8ee27` (`git rev-parse HEAD`), clean tree (`git status --porcelain` → empty).
`#448` is already merged (`172a522`), so every "today" statement below is *post*-#448: the abort-only
timer and the `deadlineOwner` flag both exist in the code being examined.

**Method.** `.codegraph/` is conductor-side and absent here, so every coverage line below is `grep`/`read`
or a vitest run. Probes live in a scratch copy, never in the repo:

```
cp -r src /tmp/brl453/src && diff -r /tmp/brl453/src <repo>/src   → IDENTICAL
/tmp/brl453-mut                                                   → one added line (§3.1 F3.3, quoted in full in the Appendix)
```

Every probe prints a `W453<letter>-<id>` evidence line. **Measured** = produced by one of those runs;
**read** = code-inspected with `file:line`; **inferred** = a conclusion from measured facts that was not
itself observed; **unverified** = named with the command that would settle it (§12).

**Baseline (unmodified code, scratch copy).**

```
./node_modules/.bin/vitest run src/__tests__/session-manager.test.ts \
  src/__tests__/background-session-persistence.test.ts src/__tests__/background-fan-out.test.ts
→ 3 files, 166 tests, all pass
```

**Coverage of the call graph.**

```
$ grep -rn "spawnBackgroundSession\s*(" src --include=*.ts | grep -v __tests__
src/session-manager.ts:1189:export async function spawnBackgroundSession(
src/index.ts:2010:		const agent = await spawnBackgroundSession(pi, ctx, {
```
→ **one** production invocation, one declaration. It sits in the shared tail `startBackgroundAgent`
(`:1974`), which single dispatch (`:2392`), fan-out (`:1892`), manual retry (`spawnBackgroundRun`, `:2980`)
and transport retry (`:4266`) all reach; there is no second call site to update.

```
$ grep -rho "spawnBackgroundSession(" src/__tests__/*.ts | wc -l
112
   session-manager.test.ts 91 · background-session-persistence.test.ts 19 ·
   engineering-bar.test.ts 1 · empty-tools-background-442.test.ts 1
```

```
$ grep -rn 'it("' src/__tests__/*.ts | grep -iE "deadline|timeout|budget|#448"
21 tests in 4 files (session-manager 14, background-session-persistence 4, background-fan-out 3)
```
Those 21 are the tests that pin today's deadline behaviour; §7.2 names the four that change with Decision 1.

---

## 0. The shipped ownership landscape (read)

Two independent deadline arms exist today, and neither finalizes anything.

| # | Owner | Site | Arms when | On fire |
|---|---|---|---|---|
| **W3** | session-manager (the spawn) | `session-manager.ts:1916-1953` (`armDeadline`), armed at `:1963-1968` | an explicit `timeout > 0` — **always** | status `stopped` + transcript note + `session.abort()`. **No finalize, no prune** (`:1909-1915` comment states it). |
| **HC** | `index.ts` (the caller) | `index.ts:2189-2257` | no explicit timeout (`hasExplicitDeadline === false`, `:2200`) | `completed = true`, clears the poller, status `stopped`, `_sessionRef.abort()`, output capture, `finalizeLiveSubagent` → `activeSubagents--`, repaint. **No finalize, no prune.** |

The no-timeout default is therefore **owned by the caller** and delegated away from the spawn by an explicit
flag: `deadlineOwner: "caller"` at `index.ts:2027`, honoured at `session-manager.ts:1966`. `#448` defect 2
added this so a *direct* spawn (no caller) is still bounded exactly once.

What the caller does after the spawn returns (`index.ts`), in order — this is the list the issue calls
"work the session-manager cannot do":

| Step | Line | Fallible? |
|---|---|---|
| `state.registerLiveSubagent(agent.id, {...})` — reads `agent.description/task/model/thinkingLevel/priority/startedAt/timeoutMs` | `2055-2069` | **yes** — the payload reads the spawn's return value; a throwing getter or a malformed record throws here (measured, §1.4) |
| `state.activeSubagents++` | `2072` | no |
| `repaintStatus(state, ctx)` → `updateProgressStatus` → `syncProgressTicker` (arms the footer ticker) | `2073` / `concurrency.ts:172-183` | yes (UI/paint) |
| `setInterval(poller, 2000)` | `2078` | no in practice |
| the 30 m default timer | `2202-2257` | no |

Why the spawn cannot do that work itself (read): `session-manager.ts` imports no `state` and no UI
(import block `:2-26`), and `state.ts` does not import `session-manager` either — the dependency runs
`index.ts → state`, `index.ts → session-manager`. A deadline living in the spawn has **no handle** on the
live row, the counters, or the footer.

Two write-ordering facts the residue analysis depends on:

- `persistRunRecord` (`run-registry.ts:326-332`): a terminal run **clears the registry first**, then
  appends the session entry. A throwing append therefore leaves `registry: gone, entry: still running`.
- `finalizeRunEntry` (`session-manager.ts:1463-1560`) is the single terminal choke point for a background
  run: it is guarded once-per-run (`runFinalized`, `:1468-1470`), it **decides prune before the write**
  (`:1504-1518`), and its prune target is the child's **session directory** (`pruneSessionDir`,
  `:165-190`), not the registry.

---

## 1. Decision 1 — one owner for the background deadline, or an explicit split with a handshake

### 1.1 Measured facts

**F1.1 — a normal run has three timers and exactly one deadline arm.** Through the real `delegate_task`
handler (spawn stubbed), counting `setTimeout` delays as well as `vi.getTimerCount()`:

```
W453B-B1 {"timersAtReturn":3,"delays":[1800000],"deadlineArms":1,"pollerArms":0}
```
The three timers are the 2 s poller (`index.ts:2078`), the footer spinner ticker
(`concurrency.ts:178`), and the one deadline `setTimeout`. **Count deadline arms (delay == budget), never
`getTimerCount()`** — the issue body is right: the timer count is 3, the deadline-arm count is 1.
(A fourth timer, `state.statusResetTimer` at `concurrency.ts:233`, appears after the run settles.)

**F1.2 — the arm matrix today, per ownership and reservation.** Direct `spawnBackgroundSession` calls,
spying the installed delays:

```
W453H-H2
 direct, no timeout (owner defaults to spawn)          delays [1800000]  arms 1
 caller-owned, no timeout                              delays []         arms 0
 explicit timeout 5000, caller-owned                   delays [5000]     arms 1
 explicit timeout 5000, spawn-owned                    delays [5000]     arms 1
 timeout 0 (normalizes to none), spawn-owned           delays [1800000]  arms 1
 timeout 2^31-1, caller-owned                          delays [1800000]  arms 1   ← see F1.3
```

**F1.3 — the ownership predicate is duplicated, and normalization decides, not the flag.** `:1964` tests
the RAW `params.timeout > 0` **before** the owner flag, so `timeout: 2^31-1` takes the explicit branch and
arms `effectiveBackgroundBudget(...)` = the 30 m default — while `index.ts:2200` computes
`hasExplicitDeadline` from the same raw value and arms nothing. Net: still one arm, but the arm is the
spawn's although the caller believes it delegated an explicit timeout. `#240`'s comment
(`validate.ts:526-534`: "the single definition … so a displayed deadline cannot drift from the armed
timer") holds only because both sides repeat the same raw comparison.

**F1.4 — the caller tail can throw before it registers anything, and the run is then unbounded.** A
throwing getter on the spawn's returned agent, driven through the real `delegate_task`:

```
W453B-B2 {"result":"Failed to spawn background agent: post-start-oops","isError":true,
          "timersAtReturn":0,"abortAfterTwoHours":0}
```
Two hours of fake time, zero aborts, and the user is told the spawn failed while the child is live. This is
the hole `#448` deferred in writing (`issue-448-implementation-brief-2026-11-07.md` §"What is no longer in
scope"). It exists **because the caller is the owner**: the spawn had already declined to arm.

**F1.5 — a finalize claim is not proof of registration.** Real `createSessionState`:

```
W453E-E1 {"claimed":true,"registeredIds":["sibling-A"],"activeAfter":0,"siblingStillRunning":true}
W453E-E4 {"claimed":true,"rawActiveAfter":-1}
```
`finalizeLiveSubagent` (`state.ts:467-485`) only adds the id to a claim set; it never checks membership. The
counter it gates is a single global `activeSubagents`, so a claim for an id that was never counted removes
a *sibling's* count. Every call site clamps at 0 afterwards (`index.ts:2224-2225` etc.), so the damage is a
silently low count, not a negative one.

**F1.6 — but the live-row cleanup does not need the timer at all.** With an explicit timeout the caller
arms **nothing** (`hasExplicitDeadline`, `:2200`) — and the live row still clears when W3 fires:

```
W453J-J1 {"spawnOk":true,"abortsAfterDeadline":1,
          "footerAfter":["⠸ brl: 1 running · ran: 6s · deadline: stopping","⠼ …","brl: (use /brl-subagent to configure)"],
          "footerHasRunning":true}
```
The poller's completion branch (`index.ts:2131-2158`) sees `agent.completedAt` (set by
`updateAgentStatus`, `session-manager.ts:999`) on its next 2 s tick and performs *every* caller-owned step:
output capture, `finalizeLiveSubagent` claim, decrement, repaint, ticker stop. **This is a shipped,
already-exercised precedent for "the timer is not the cleanup owner".**

### 1.2 Options

| Option | Mechanism | Blast radius | Cost | Failure mode |
|---|---|---|---|---|
| **O1-a do nothing** | Two arms as today: caller owns the no-timeout default, spawn owns explicit timeouts; the split is documented | none | S (docs only) | F1.4 stays: a caller-tail throw leaves an unbounded run. `#448`'s flag remains a two-module invariant held together by one comment |
| **O1-b one owner = the spawn** | Delete the caller timer (`index.ts:2189-2257`) **and** the `deadlineOwner` flag (`session-manager.ts:1215,1963-1968`); the spawn always arms the default when no explicit timeout exists. Live row/counter/footer stay with the caller's **poller** (F1.6) | `index.ts` lost block 69 lines (`2189-2257`) + 3 `clearTimeout` sites; `session-manager` ~12; 4 tests change (§7.2); one production call site loses a parameter | **M** (deletes ~80 source + ~96 test, adds ~6 source + ~90 test) | A deadline now stops the run without an *immediate* repaint — up to one 2 s poller tick of latency on the footer. If the poller was never created (caller throw), the counter is released only by the stale sweep (`state.ts:721`, TUI render path) |
| **O1-c spawn owns the timer + caller passes an `onDeadline` hook** | The caller hands a callback into `spawnBackgroundSession`; the timer invokes it for the live-row work | new param threaded through the one call site + every test spawn; the hook runs inside a timer callback (a throwing hook is an uncaughtException unless wrapped) | L (~80 source + ~160 test) | Reintroduces exactly the F1.5 hazard: the hook can claim an id the caller never registered unless a registration token is added — i.e. the handshake the issue asks about, at full price |
| **O1-d cleanup via the `subagent:stopped` event** | The spawn's status flip already emits `subagent:stopped` (`session-manager.ts:1013-1014`); the caller already subscribes (`index.ts:4190`) | the existing listener also calls `claimTerminalNotice` (`:4300`) — piggybacking the counter would couple the deadline to the notice claim, which is `#439`'s non-goal; and a user `stopAgent` would fire the same event (double decrement unless gated) | M | Silent double-decrement on the `stop_subagent` path |

### 1.3 Recommendation — **O1-b (one owner: the spawn)**

The timer and the live row have *different* natural owners and the code already proves it: for explicit
timeouts the timer is the spawn's and the live row is the poller's (F1.6, measured). Extending that
configuration to the no-timeout case is the smallest change that satisfies "one owner" without a
handshake, and it closes F1.4 as a side effect (the arm no longer depends on any caller statement).

What it keeps: the caller's poller, output capture, claim/decrement, repaint — untouched. What it deletes:
the caller's timer and the flag. What it must **not** do: move any live-row work into the timer (the
`state` import does not exist and adding it would invert the module graph).

**Falsifiers** (each would overturn O1-b):
1. A run reaches the deadline with **no poller** and the counter is not released — i.e. measure the
   caller-tail-throw + deadline case and find `activeSubagents` stuck at 1 in a headless process where the
   stale sweep never runs. Command: `F1.4`'s harness, then assert `activeSubagents === 0` after two poller
   intervals; today the sweep is TUI-driven, so this is the real risk.
2. The footer's `deadline: stopping` state (measured in F1.6) disappears when the caller's timer is
   deleted — i.e. the display depends on the timer rather than on `agent.completedAt`. Read:
   `index.ts:2063-2067` computes `deadlineAt` from the record; `tui-format`'s segment reads that. Expected
   safe, not yet measured with the caller timer removed.
3. A second production call site of `spawnBackgroundSession` appears (coverage line in the header says one)
   — then "the only call site passes `caller`" stops being a complete argument.

### 1.4 What the implementation brief must contain

- **Delete** `index.ts:2189-2257` (the comment block, `hasExplicitDeadline`, `hardCapMs`, `hardCapHandle`
  and its three `clearTimeout` sites at `2094/2134/2171`), **and** `deadlineOwner` at
  `session-manager.ts:1215` and the `:1966` gate, leaving `session-manager.ts:1963-1968` as: explicit
  timeout → arm it; otherwise → arm `effectiveBackgroundBudget(undefined)`.
- **State the invariant in one place**: "exactly one deadline arm per background run, always installed
  before `prompt()`, always by `spawnBackgroundSession`". The test that pins it counts *arms* by delay,
  not timers (F1.1).
- **Name the cleanup owner in a comment at the poller** (`index.ts:2131`): a deadline stop reaches the live
  row through `agent.completedAt`, never through the timer.
- **Tests**: (i) one arm per dispatch and per direct spawn (delay census); (ii) a caller-tail throw no
  longer leaves the run unbounded — throw in `registerLiveSubagent`, advance past the budget, assert
  `abort` once and `status: "stopped"`; (iii) after the deadline, `activeSubagents` reaches 0 on a poller
  tick (F1.6 harness); (iv) a source-scan test (precedent: `status-chokepoint.test.ts`) asserting
  `armDeadline`'s body contains no `registerLiveSubagent` / `activeSubagents` / `repaintStatus`.
- **Mutants**: restore the caller timer → (i) red (two arms); drop the pre-prompt arm → (ii) red only if
  the mutant also clears in the catch, so state which; move the arm after `prompt()` → the sync-throw test
  (§6) red. Report survivors as survivors.

---

## 2. Decision 2 — cooperative abort semantics: what stays owned when abort does not settle the prompt

### 2.1 Measured facts

**F2.1 — with the real SDK, an abort the stream ignores leaves *everything* live.** Real
`createAgentSession` + real `AgentSession`, a `streamSimple` whose iterator never reacts to the signal
(the shape of a provider reader stuck in a non-abortable wait):

```
W453K-K1 {"streamingBefore":true,"abortOutcome":"pending","promptOutcome":"pending",
          "isStreamingAfterAbort":true,"isIdleAfterAbort":false,"messages":2,"sessionFile":null}
```
`session.abort()` **never resolves** — it ends in `await this.waitForIdle()`
(`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1989-1999`) after a fire-and-forget
`this.agent.abort()`. The prompt stays pending. So "abort does not settle the prompt" is a **real SDK
state**, not a stub artefact: it is what a signal-deaf stream produces. It is *not* reachable when the
stream honours the signal — `sdk-abort-contract.test.ts` drives the same real stack with a signal-aware
stream and measures `prompt` **resolving** with `stopReason: "aborted"`.

Corollary for any design: **never `await session.abort()` inside a deadline path.** The shipped timer does
not (`session-manager.ts:1931-1944` attaches `.catch` and moves on) — that is load-bearing, not stylistic.

**F2.2 — after a deadline on a never-settling prompt, this is the complete ownership census** (direct
spawn, `timeout: 60_000`, real storage/registry/transcript):

```
W453A-A1 {"agentStatus":"stopped","agentCompletedAt":"set","agentError":"Timed out after 60000ms",
          "aborts":1,"runEntryStatuses":["running"],"runAppendsAddedAfterDeadline":0,
          "registryBefore":["0b91…"],"registryAfter":["0b91…"],  (id abbreviated)
          "sessionDirExists":true,"timersLeft":0}
```
Owned afterwards: **the session directory** (correct — the child may still write), **the registry entry**
(indefinitely), **the run entry** (still `running`), the **branch lock** (see F2.3). Released: the deadline
timer, and — through `updateAgentStatus` → `completedAt` — the agent record and, on the next poller tick,
the live row and `activeSubagents`.

**F2.3 — the branch lock is never released, and it wedges the whole spawn queue.** A branch-mode run whose
prompt never settles holds the per-repo git lock (`session-manager.ts:1650-1669`, released only inside
`cleanupWorkBranch`'s `finally`, `:1787-1790`). The next branch-mode spawn for the same repo waits on
`await prev` forever, and because that second spawn never returns, its own serial `spawnQueue` gate
(`:1237-1240`, `:2208-2210`) is never released either:

```
W453A-A2 {"statusAfterDeadline":"stopped","secondSpawnSettledAnHourLater":false,
          "thirdSpawnSettledAnHourLater":false,"createWorkBranchCalls":1,"restoreHeadCalls":0}
```
An hour of fake time: the second spawn (same repo, branch mode) and a **third, non-git** spawn both remain
unsettled. One unsettled branch-mode run is therefore a process-wide convoy: it blocks every later spawn
in the process, not just the same repo. The lock map is in-memory only, so a process restart clears it.

**F2.4 — the git lock must not be released early.** Releasing it from the deadline would let a second
branch-mode spawn run `hasUncommittedChanges` / `createWorkBranch` on a tree the first child is still
writing (`session-manager.ts:1655-1670`, `:1729-1770`). The refusal is loud (dirty tree → "working tree has
uncommitted changes"), but the first run's own `cleanupWorkBranch` would later `restoreHead` + `deleteBranch`
under a second run's feet. **Inferred, not measured** — the measurement would be a two-run interleave on a
real repo (command in §12).

### 2.2 Options

| Option | Mechanism | Blast radius | Cost | Failure mode |
|---|---|---|---|---|
| **O2-a do nothing + document** | Keep abort-only; write down that the settle is the only releaser and that a never-settling run keeps its dir, registry entry and branch lock until process exit | docs; one log line is optional | S | The convoy in F2.3 stays discoverable only by reading `gitBranchLocks` — a user sees "the agent is running" plus silently wedged later dispatches |
| **O2-b bounded ownership + a diagnostic** | Same abort-only semantics, plus: (i) stamp `deadlineFiredAt`/`abortedAt` on the agent record (it already stamps `error` + `status` + `completedAt`), (ii) `log.warn` when a run is still unsettled at settle-time-absence (i.e. from the next dispatch), (iii) a test pinning "the deadline releases no branch lock and prunes nothing" | one field, one log call, no new timers | S | Still no release path; the diagnostic only makes the wedge visible |
| **O2-c second-phase escalation** | After a grace window past the deadline with no settle: force-finalize, keep the session dir, force-release the git lock (restore + delete the branch) | a second timer per run; a destructive act against a possibly-live child; needs a "who may delete the branch" decision that this issue does not scope | L | Data loss: the branch is deleted while the child still writes; `restoreHead` fights a live worktree |

### 2.3 Recommendation — **O2-b**

Abort stays the strongest lever the SDK offers (F2.1), and the deadline must keep releasing nothing that
the child may still own. The defensible contract, stated once in the brief:

> A deadline abort owns **no** filesystem or git resource. It sets `status: stopped` + `completedAt` +
> the timeout reason, writes the transcript note, calls `abort()` once, and (per §3) may write the terminal
> record. The **settle** is the only event that may prune the session directory or release the branch lock.
> If the settle never comes, nothing does — until process exit.

This is not a new policy; it is the policy the code already implements, minus the parts nobody wrote down.

**Falsifiers**
1. A settle *after* the deadline abort is reached for the common cooperative case (F2.1's signal-aware
   stream) and does release the branch lock and prune — i.e. the contract above is already true for
   every stream that honours the signal. Measure: `sdk-abort-contract.test.ts`'s harness plus a branch-mode
   spawn; assert `restoreHead`/`deleteBranch` called once after the abort-triggered settle.
2. A real provider stream that ignores the signal exists in the wild but is bounded by a provider timeout —
   then the convoy is theoretical for the real system. Neither measured nor excluded (§12).
3. The git lock is released somewhere else that this reading missed — coverage:
   `grep -n "releaseGitLock\|gitBranchLocks" src/session-manager.ts` → the map `:37`, the lock key +
   `await prev` `:1650-1663`, the release closure `:1664-1669`, its two call sites (`:1697` setup-throw,
   `:1788` teardown `finally`), and `__testResetGitBranchLocks` `:44`. No other release.

### 2.4 What the brief must contain

- The contract paragraph above, verbatim, in the `armDeadline` doc comment (`session-manager.ts:1909-1915`)
  and in CHANGELOG under "explicit limits".
- A **positive** test: after a deadline on a never-settling prompt, `restoreHead`/`deleteBranch` were **not**
  called, `pruneSessionDir`'s observable (the session dir) still exists, and the registry entry still lists
  the run — that pins the "owned resources" list against a future "let the timer clean up" edit.
- A **negative** test: the cooperative case (abort resolves the prompt) still prunes and still releases the
  branch — the existing `background-session-persistence.test.ts:249` already pins the dir half.
- No new timer. If the conductor wants O2-c, it needs its own issue (it is a destructive lifecycle
  decision, not a deadline-ownership one).

---

## 3. Decision 3 — prune-safe finalization

### 3.1 Measured facts

**F3.1 — a real SDK `SessionManager` cannot append into a removed directory.**

```
W453C-C1 {"existsAfterFlush":true,"appendAfterPrune":"ENOENT"}
```
(real `SessionManager.create`, one user message to flush the file, `rmSync` the dir exactly as
`pruneSessionDir` does, then `appendMessage` → `ENOENT`, thrown from the SDK's
`pi-coding-agent/dist/core/session-manager.js:816-839`).

**F3.2 — the shipped settle prunes the directory the live `SessionManager` still holds.**

```
W453C-C2 {"agentStatus":"failed","dirExistsAfterSettle":false,"appendAfterSettle":"ENOENT"}
```
So the issue body's premise is right: finalizing **is** pruning (`session-manager.ts:1504-1518`), and the
child object that wrote that file is still reachable in-process.

**F3.3 — a naive timer-side finalize prunes while the prompt is still pending.** One added line in a
mutant copy (`/tmp/brl453-mut`, `finalizeRunEntry('failed', reason)` immediately after the abort block;
the only delta — full `diff` in the Appendix), same never-settling prompt:

```
W453D-D1 {"agentStatus":"stopped","runEntryStatuses":["running","failed"],
          "entryAtDeadlineStatus":"failed","entryAtDeadlineError":"Timed out after 60000ms",
          "dirAfterDeadline":false,"lateWrite":"ENOENT","aborts":1}
```
The record becomes terminal at the deadline, the directory is gone at the deadline, and the child's next
write fails `ENOENT`. Provenance: this is **the mutant's** result, not shipped behaviour — the shipped
timer prunes nothing (F2.2, `sessionDirExists: true`).

**F3.4 — a timer-side finalize that throws escapes the timer callback.** Same mutant, terminal
`pi.appendEntry` throwing `ENOENT`:

```
W453I-I1 {"escapedFromTimer":"parent session gone","uncaught":[],
          "agentStatus":"stopped","aborts":1,
          "runEntryStatuses":["running","failed"],"registry":[]}
```
Three consequences at once: the throw leaves the timer callback (in production that is an
`uncaughtException` — the host process, not just the run); `persistRunRecord` had already **cleared the
registry** (`run-registry.ts:326-332`), so the run is now invisible to recovery; and the run entry never
received its terminal write. This is the worst of all states and it is reachable the moment a terminal
write moves inside a timer.

**F3.5 — the residue is *permanent*, not repaired at the next boot.** The boot scan sources candidates from
the registry but drops any background entry whose agent record is terminal
(`recovery.ts:275`: `if (agent && agent.status !== "running") continue;`), and `getAgent` reads the record
from disk (`session-manager.ts:423-436`). The shipped deadline sets that record to `stopped`:

```
W453G-G1 {"agentRecordStatus":"stopped",
          "registryAfter":[{"id":"8409…","interruptedAt":null}],
          "bootSummary":{"scanned":0,"skipped":0,"marked":0,"markFailures":0,…},
          "runEntryStatuses":["running"],"runEntryInterruptedAt":[null]}
```
So after a deadline-aborted non-settling run: the run entry is `running` **forever**, `interruptedAt` is
never set (so history shows "Running" via `tui-format.ts:415-433`), and the registry entry is never cleared
and never marked. This contradicts the assumption in `issue-439-investigation-2026-11-07.md` §4 ("next boot
… boot scan marks it `interrupted`") — that measurement is for the *pre-start / unmonitored* class, whose
agent record stays `running`. **This is the strongest argument against the do-nothing baseline.**

### 3.2 Options

| Option | Mechanism | Blast radius | Cost | Failure mode |
|---|---|---|---|---|
| **O3-a do nothing** | Timer stays abort-only; the run entry stays `running` when the prompt never settles | none | S (docs) | F3.5: a permanent "Running" row and a permanent registry entry; no recovery affordance, no `interruptedAt` |
| **O3-b finalize at the deadline, never prune** | Split the choke point into *write once* + *prune once*: the timer writes the terminal entry with `prune: false`; the settle (if it ever comes) does the prune with the true category | `finalizeRunEntry` closure only (`:1463-1560`); no signature change outside; `persistRunRecord` untouched | **M** (~45 source + ~120 test) | The dir of a never-settling run is never reclaimed (today's state, safe direction); a failed terminal append still clears the registry first (F3.4, shared with the settle path, flagged out of scope) |
| **O3-c finalize at the deadline *with* prune** | Ship the naive mutant | same + destruction | S | **Falsified by F3.3**: `ENOENT` for a still-writing child |

### 3.3 Recommendation — **O3-b**, with the prune decision explicitly left to the settle

The measured constraints force the shape:

1. **The timer may write the record; it may not delete the directory** (F3.3).
2. **The timer's write must be contained** — `try { … } catch { log.warn }` — or the host dies (F3.4).
3. **The prune decision must survive the once-only write guard.** Today `runFinalized` gates both
   (`:1468-1470` gates the prune at `:1504-1518`). If the timer wrote and pruned nothing, a later
   cooperative settle would find `runFinalized === true` and **never prune**, breaking the shipped contract
   that a timed-out run's directory is removed (`background-session-persistence.test.ts:249`). The guard
   must therefore be split into `entryWritten` and `pruned` — the settle always evaluates the prune, even
   when the entry is already terminal.
4. **The settle's prune must use the settle's category**, not the deadline's. At the deadline the run looks
   like `errorCategory: "timeout"` (`isTransportRetryable` false → prune); at settle the true category can
   be `exit_error`/retryable → **retain** (issue #404's retention). Pruning at the deadline would destroy a
   directory the settle was going to keep for a retry.

**Falsifiers**
1. A cooperative timeout stops removing its session directory after the change —
   `background-session-persistence.test.ts:249` goes red. That would mean the prune was left on the wrong
   side of the guard.
2. A transport-retryable run that first hits its deadline and then settles loses its retained session dir —
   i.e. the deadline pruned. Test: force `isTransportRetryable` true at settle and assert the dir survives
   with the `.transport-retained` marker.
3. A timer-side finalize throw reaches the event loop — F3.4's harness with the write wrapped must show
   `escapedFromTimer: "no-throw"` and the process alive.

### 3.4 What the brief must contain

- The exact code shape at `session-manager.ts:1916-1953`: keep the two existing `try` blocks, add a third
  **after** the abort attempt, and make sure the abort cannot be suppressed by it. Proposed call (the
  existing third parameter gains one optional field, so no new parameter is needed):
  `try { finalizeRunEntry('failed', reason, { stopReason: 'aborted', prune: false }) } catch (err) { log.warn(...) }`.
- The guard split at `:1468-1470`: `entryWritten` gates the write; `pruned` gates the prune; the settle
  path always calls the prune evaluator. Name this in a comment at the choke point — it is the subtle part.
- A test for each of the four constraints: no prune at the deadline (dir exists), settle prunes afterward
  (dir gone), a throwing terminal append does not escape the timer, the entry is written exactly once
  (append count).
- Mutants: (a) prune inside the timer → "no prune at the deadline" red; (b) keep one guard for both → the
  cooperative-prune test red; (c) drop the timer's try/catch → the throw test red; (d) write the entry twice
  (remove the guard) → append-count red.

---

## 4. Decision 4 — snapshot or amend: is the deadline-time run entry final?

### 4.1 Measured facts

**F4.1 — the terminal entry is built from the state at the moment it is written, and the once-only guard
makes any later write a no-op.** Mutant build (F3.3's one line), a cooperative abort whose prompt settles
5 ms later carrying a real assistant turn and usage:

```
W453D-D2 {"agentStatus":"stopped","finalOutput":"work that happened during the abort",
          "entryCount":2,"entryStatuses":["running","failed"],
          "deadlineEntry":{"status":"failed","tokensOut":0,"cost":0,"outputSummary":"","errorMessage":"Timed out after 60000ms"},
          "lastEntry":    {"status":"failed","tokensOut":0,"cost":0,"outputSummary":"","errorMessage":"Timed out after 60000ms"}}
```
The agent record ends with the child's real output; the **run entry does not** — `tokensOut: 0`,
`outputSummary: ""`, and there are still only two appends. The guard (`:1468-1470`) is what makes the
snapshot final.

**F4.2 — the terminal *classification* is already decided by the deadline, not by the snapshot.** With the
shipped code (no timer-side finalize) a prompt that resolves 1 ms after the deadline with a successful
answer still records:

```
W453J-J2 {"runEntryStatuses":["running","failed"],
          "lastEntry":{"status":"failed","stopReason":"aborted","errorCategory":"timeout",
                       "errorMessage":"Timed out after 5000ms","cost":0,"tokensOut":0,"outputSummary":""},
          "agentStatus":"stopped","error":"Timed out after 5000ms","finalOutput":"the answer","aborts":1}
```
`aborted = agent.status === 'stopped' || terminalStopReason === 'aborted'` (`:2015`) — the pre-set decides.
So an amendment could not "rescue" a wrongly-classified run; it can only add the payload the late settle
knows (cost, tokens, output).

**F4.3 — an amendment appended after the snapshot is invisible to today's readers, and one-line fixable.**

```
W453L-L1 {"sortedStatuses":["running","failed","failed"],"resolvedTokensOut":0,
          "resolvedOutputSummary":"","resolvedFinishedAt":"2026-11-07T10:30:00.000Z",
          "historyRows":1,"historyTokensOut":0,"historyLabel":"Failed"}
W453L-L4 {"order":[null,0,900],"findTokensOut":0,"findLastTokensOut":900,"label":"Failed"}
```
`cleanupRuns` sorts by `startedAt` only (`history.ts:27-31`); both entries of a run share it; V8's sort is
stable, so the snapshot precedes the amendment. `resolveTerminalRunEntry` takes the **first** non-running
entry (`state.ts:94-105`) → the snapshot. Switching that one selector to the **last** non-running entry
picks the amendment (L4) and is a no-op for every run that has exactly one terminal entry — i.e. the whole
foreground path and every non-amended background run.

**F4.4 — the payload being lost is not cosmetic: cost is aggregated from run entries.**

```
metrics.ts:88   const costs = runs.map((r) => r.cost ?? 0);
metrics.ts:89   const totalCost = costs.reduce((sum, c) => sum + c, 0);
```
A snapshot-only entry with `cost: 0` (F4.1) reports $0 for a run that burned tokens. Today the cooperative
timeout records a real cost, because the settle is the only writer. **O4-a would therefore be a regression
in the metrics surface for exactly the runs that hit the deadline and then settle** — the common timeout
shape, not an edge case.

### 4.2 Options

| Option | Mechanism | Blast radius | Cost | Failure mode |
|---|---|---|---|---|
| **O4-a snapshot** | The deadline-time entry is final; late output/usage stay on the agent record only | none beyond §3 | S | F4.4: cost/tokens/output under-reported in the run entry, and the metrics aggregate sums it. Silent, plausible-looking wrong data about money |
| **O4-b amend** | The deadline writes the terminal entry; a late settle appends an **amendment** (same id, same `startedAt`, payload only — `status`/`errorCategory` unchanged); `resolveTerminalRunEntry` selects the **last** non-running entry | `state.ts:100-104` (one selector), the settle path's finalize (`:1468-1470` guard gains an "amendment" mode), `metrics.ts`/history consume it unchanged | **M** (~35 source + ~110 test) | Two terminal entries per id for amended runs; the "exactly two appends per run" assertions in several tests need an explicit amended case; a reader that takes the first entry (none in `src/`, `findSpawnRunById` deliberately takes the first and is unaffected) would miss it |
| **O4-c defer the record to the settle (status quo)** | No deadline write at all | none | S | F3.5: no record at all when the prompt never settles, and a permanently `running` row |

### 4.3 Recommendation — **O4-b (snapshot + payload amendment on a late settle)**

The two measured facts that decide it: the *classification* cannot be amended (F4.2, the pre-set already
wins), but the *payload* must be, or the run reports $0 (F4.4). And the amendment is representable with a
one-line reader change that provably does not disturb any existing two-entry run (F4.3, L4).

If the conductor prefers the smaller diff, **O4-a is defensible only with the metrics consequence written
into the CHANGELOG** — otherwise a timeout that settled records a $0 run and `computeSLAMetrics` inherits
it.

**Falsifiers**
1. The last-non-running selector changes any non-amended outcome — measure by re-running the history /
   dashboard / notify suites with `find` → `findLast` and no other change; expected zero diffs (L4 argues
   it, a suite run proves it).
2. A late settle's amendment disagrees with the deadline entry on `status` — then the amendment would need
   to rewrite the classification, which F4.2 says the pre-set forbids; measure with a run whose abort
   resolves `completed` (the SDK coopts an aborted run into `stopReason: "aborted"`, so this needs an
   injected shape).
3. A consumer exists that reads the **first** terminal entry on purpose (retry resolution reads
   `findSpawnRunById`, the spawn entry — unaffected; verify no other first-entry reader:
   `grep -rn "findSpawnRunById\|resolveTerminalRunEntry\|resolveRunEntry" src/*.ts`).

### 4.4 What the brief must contain

- The amendment's exact field set (payload only: `cost`, `tokensIn`, `tokensOut`, `turns`,
  `outputSummary`, `fullOutput`, `finishedAt`, `durationMs`) and the rule that `status`, `errorCategory`,
  `stopReason`, `errorMessage` are **not** amended.
- The selector change with its own test: three entries (spawn, deadline terminal, amendment) →
  `resolveTerminalRunEntry` returns the amendment; two entries → unchanged.
- A test that the metrics aggregate sees the amended cost (`computeSLAMetrics` over the two-entry run).
- Mutants: (a) revert the selector to `find` → the amendment test red; (b) let the amendment change
  `status` → the "classification is not amended" test red; (c) drop the amendment → the cost-aggregate test
  red.

---

## 5. Decision 5 — time origin: when does the budget start?

### 5.1 Measured facts

**F5.1 — the recorded start precedes the arm by the setup cost, and the display uses the recorded start.**

```
W453H-H1 {"startedAt":1794053368209,"armedAt":1794053368251,"setupCostMs":42,
          "timeoutMs":1800000,"displayedDeadlineAt":1794055168209,
          "actualFireAt":1794055168251,"driftMs":42}
```
(Branch mode with 2 × 20 ms of injected setup cost; an earlier, cold run of the same probe measured
`setupCostMs: 246`.) The three sites:

| Site | Line | Clock |
|---|---|---|
| record creation | `session-manager.ts:1396` (`startedAt: Date.now()`) | **after** model resolution, `loader.reload()`, `createAgentSession` and `SessionManager.create`; **before** `transcript.startTranscript` (`:1561`), the run-entry persist (`:1446`), branch setup and any branch-lock wait (`:1650+`) |
| deadline arm | `session-manager.ts:1963-1968` | after all of the above, immediately before `prompt()` |
| display | `index.ts:2063-2067` (`deadlineAt: agent.startedAt + agent.timeoutMs`) | the recorded clock |

`effectiveBackgroundBudget` is documented as "the single definition … so a displayed deadline cannot drift
from the armed timer" (`validate.ts:526-534`). **The budget agrees; the origin does not.** The armed timer
always fires `setupCost` later than the display says, so the run gets *less* than the displayed remaining
time — the opposite of a violation, but a visible one: for ~`setupCost` the footer shows
`deadline: stopping` while the timer has not fired.

**F5.2 — the caller-owned path adds its own tail to the drift (unmeasured).** With O1-a's split the caller
arms at `index.ts:2202`, after the spawn returns and after `registerLiveSubagent` + poller creation. A
direct measurement of that tail was attempted and landed at 2 ms (the injected 30 ms spin ran *before*
record creation, so it did not reach the tail):

```
W453J-J3 {"startedAt":1794053833907,"callerArmAt":1794053833909,"armDelayAfterStart":2,"driftMs":2}
```
Take F5.1's number as the real setup drift and treat the tail as small-but-unmeasured. Under O1-b the tail
disappears entirely — the spawn's arm becomes the only one.

### 5.2 Options

| Option | Mechanism | Blast radius | Cost | Failure mode |
|---|---|---|---|---|
| **O5-a do nothing** | Display keeps `startedAt + budget`; the timer keeps the full budget from the arm | none | S | Display/timer disagree by the setup cost; a slow branch-lock wait makes the footer lie for as long as the wait lasted |
| **O5-b origin = record creation (align the timer to the display)** | Arm with `max(0, budget - (Date.now() - startedAt))` | `session-manager.ts:1963-1968` only; the clamp must not route through `normalizeTimeout` (0 means "no timeout" there, `validate.ts:516-524`) | **S** (~8 source + ~40 test) | A very slow setup consumes the budget → the run is aborted ~immediately after the prompt starts. Arguably correct ("it already used its 30 minutes"), surprising if the wait was a lock queue |
| **O5-c origin = the arm, stamped on the record** | Add `deadlineAt` (absolute epoch) to the agent record at arm time; display reads that field instead of recomputing; the budget is a full 30 m of prompt time | `session-manager.ts:1396-1402` (record shape, persisted → old records lack it), `index.ts:2063-2067`, `types.ts`'s `BackgroundAgent` | **M** (~20 source + ~60 test + a compat read path) | Changes the effective budget for setup-heavy runs (they now get 30 m *of prompt*); persisted-record compat: a missing `deadlineAt` must fall back to the old computation |

### 5.3 Recommendation — **O5-b**

The display is the user-facing contract, and the smallest change honours it. It also has a clean
interpretation: the budget belongs to the run, and the run starts when it is recorded. `O5-c` is the
alternative if the conductor would rather protect prompt time than the displayed number; both are one
decision, and either is small.

**Falsifiers**
1. A branch-lock wait of W seconds must shorten the armed delay by exactly W — measure with a real repo and
   two concurrent branch-mode spawns; if the delay is `budget - W` the change works, if it is `budget` the
   clamp was routed through the wrong helper.
2. A run with `budget - elapsed <= 0` must abort promptly and record a timeout — not arm `setTimeout(0)`
   through `normalizeTimeout` (which yields "no timeout" and leaves the run *unbounded*, the exact #240
   hazard inverted).
3. `state.registerLiveSubagent`'s `deadlineAt` must equal the fire time within a few ms — measure the
   footer segment against the abort timestamp on a run with a slow setup.

### 5.4 What the brief must contain

- The clamp helper (`const remaining = Math.max(0, budget - (Date.now() - startedAt));`) next to
  `armDeadline`, with a comment naming `normalizeTimeout` as the wrong path for the clamped value.
- A test with an injected setup delay (stub `createAgentSession`/git to sleep or advance Date) asserting
  `armedDelay + setup ≈ budget`.
- A test that a zero remaining budget still aborts (never "no timeout"), and that the run entry records
  `errorCategory: "timeout"`.

---

## 6. Decision 6 — synchronous-throw cleanup

### 6.1 Measured facts

**F6.1 — the arm-before-prompt + clear-in-catch already exists and is pinned.** `session-manager.ts:1963-1968`
arms before `prompt()`; the sync catch clears it as its **first** statement (`:1979`) before its own
fallible `cleanupWorkBranch()` (`:1980`) and `finalizeRunEntry` (`:1985`). Three clears exist, one per exit
path: `:1979` (sync catch), `:1990` (`.then`), `:2140` (`.catch`). Pinned by
`session-manager.test.ts:937-971`, which asserts `timersAtPrompt === 1` and `getTimerCount() === 0` after
the rejection. Green in the 166-test baseline.

**F6.2 — the real SDK cannot reach that path anyway.** `session.prompt` is `async`
(`agent-session.js:1649`), so a pre-`await` throw is a rejection, not a synchronous throw — measured in
`issue-439-investigation-2026-11-07.md` §1.1 and restated in #439's body. The path is reachable only with a
mock or a non-async `prompt`, i.e. it is a *defensive* path.

**F6.3 — the hole that is still open is on the caller's side, and it is a *pre-arm* throw.** F1.4:
`timersAtReturn: 0`, no abort after two hours, user told the spawn failed. That is not a synchronous
`prompt()` throw; it is a throw between `await spawnBackgroundSession(...)` (`index.ts:2010`) and the caller's
own arm (`:2202`) — which exists **only because the caller owns the deadline**. Under O1-b the arm has
already happened inside the spawn, so no caller statement can precede it.

### 6.2 Options

| Option | Mechanism | Blast radius | Cost | Failure mode |
|---|---|---|---|---|
| **O6-a do nothing** | `#448` already fixed the reachable half; the caller-throw hole stays documented as out of scope | none | S | F6.3 stays: an unbounded run plus a false "spawn failed" report (the notice half is #439's) |
| **O6-b make it structural** | Adopt O1-b: the only arm is inside the spawn, before `prompt()`; keep the `:1979` clear and its test | subsumed by §1 | S (0 extra, part of O1-b) | none new; the sync-throw path keeps its defensive clear |
| **O6-c caller-side compensating arm** | Wrap the caller tail in `try { … } catch { arm a default; rethrow }` | `index.ts:2054-2259`; a second arming site → two owners again | M | Re-creates the double-owner problem the issue exists to remove |

### 6.3 Recommendation — **O6-b**, i.e. Decision 6 is *implied* by Decision 1 and needs no separate change

If the conductor picks O1-a (split), Decision 6 must instead be answered as O6-c and the caller tail needs
containment — which is #439's work, explicitly a non-goal here. That coupling is worth stating in the
matrix: **O1-a leaves Decision 6 unresolved; O1-b resolves it.**

**Falsifier.** A statement between the arm (`:1967`) and `prompt()` (`:1975`) that can throw and that is not
the sync catch's — read: the only statements are the `if`/assignment and `wrapTask(params.task)`
(`prompt.ts:67-78`, one `String.replace` on a validated string). If `wrapTask` ever gains a validation
throw, the timer would be armed and never cleared; the covering test is F6.1's.

### 6.4 What the brief must contain

- Nothing new beyond §1, plus an explicit sentence in the PR: "the `#448` sync-throw clear at
  `session-manager.ts:1979` is retained unchanged and its test is unchanged."
- If O1-b is *not* chosen: a separate decision on the caller tail is required (route to #439) and the
  deadline must be described as bounded-only-when-the-caller-reaches-line-2202.

---

## 7. Blast radius on the two defects `#448` already fixed

`#448` merged at `172a522` with two defects and two ACCEPTANCE guarantees. A recommendation that silently
re-opens either is disqualifying, so each is named with its line and its fate.

### 7.1 `#448` defect 1 — "a timeout can mark a run `stopped` without aborting it"

**Site:** `session-manager.ts:1916-1953` (`armDeadline`). The shipped shape: one `try` around the two
bookkeeping writes (`:1921-1929`), a **separate** `try` around `session.abort()` with a `.catch` and a
synchronous-throw `catch` (`:1931-1944`), then the failure log (`:1945-1953`). Status is flipped **before**
the abort (`:1922` vs `:1931`), which the settle path depends on (`:2015`).

**Verdict: KEEP, unchanged, at the same lines.** Every decision above touches *what happens after* the
abort block, never the block itself. The implementation brief must state:

- the two `try` blocks stay separate; `session.abort()` is called exactly once and never inside a `try`
  that can be skipped by an earlier failure;
- the status flip stays before the abort;
- the bookkeeping failure keeps its `log.warn` surface (`:1945-1953`);
- the new terminal-write block (§3) goes after the abort, in its own `try` — and must not be able to
  suppress the abort, which is guaranteed by ordering (abort first) rather than by nesting.

Pinned by `session-manager.test.ts:772,805,832,859` (four tests: transcript `EISDIR`, throwing
`updateAgentStatus`, rejecting `abort()`, synchronously throwing `abort()`). All four must stay green
**unedited**.

### 7.2 `#448` defect 2 — "a direct spawn with no timeout arms no deadline"

**Site:** the `deadlineOwner` parameter (`session-manager.ts:1215`), the gate (`:1963-1968`), and the
caller's declaration plus timer (`index.ts:2027`, `:2189-2257`).

**Verdict: REPLACED (superseded), by §1's O1-b.** The flag exists only to arbitrate between two owners; with
one owner it has nothing to arbitrate. Concretely:

| `#448` artefact | Fate | Line |
|---|---|---|
| `deadlineOwner?: "caller" \| "spawn"` parameter + its doc block | **deleted** | `session-manager.ts:1207-1215` |
| `else if ((params.deadlineOwner ?? 'spawn') === 'spawn')` gate | **deleted**; the `else` branch becomes unconditional | `session-manager.ts:1966-1968` |
| `deadlineOwner: "caller"` at the one production call site | **deleted** | `index.ts:2027` |
| the caller's 30 m timer | **deleted** (the whole block, 69 lines) | `index.ts:2189-2257` |
| the double-arm hazard the flag prevented | **cannot occur** — there is one arm site | — |
| the `#448` guarantee "a direct spawn is bounded" | **kept** (still armed before `prompt()`) | `session-manager.ts:1967` |
| the `#448` guarantee "exactly one deadline per run" | **kept and strengthened** (one site, countable) | F1.1 |

Tests that must change with it (4 of the 21 deadline tests):

| Test | Why it changes |
|---|---|
| `session-manager.test.ts:917-936` "a caller-owned spawn arms no default of its own (no double arm) (#448)" | the flag no longer exists; the case becomes "a spawn arms exactly one default, always" |
| `background-fan-out.test.ts:606-633` "hands the no-timeout deadline to the caller-owned spawn flag (#448)" | asserts `spawnParams.deadlineOwner === "caller"`; becomes "the dispatch passes no owner and the spawn arms the default" |
| `background-fan-out.test.ts:582-604` "fires the default deadline at 30m when no timeout is given" | the timer moves from the caller to the (stubbed) spawn — the assertion must move with it, or become an arm-count assertion |
| `background-fan-out.test.ts:635-659` "does not arm the index timer for an explicit timeout — W3 owns it" | still true, but now trivially, because the index arms nothing ever |

**The one thing O1-b must not lose:** `#448`'s measured reason for arming *before* `prompt()` — the
sync-throw clear (`:1979`) and its test (`session-manager.test.ts:937-971`) are the proof, and they stay.

---

## 8. `#439` / `#447` relationship — what the deadline owner must NOT need from them

Two neighbouring issues own two vocabularies that are easy to reach for and wrong to depend on:

- **`#439`** — a caller-side failure after the spawn is reported as a spawn failure while the run is live.
  Its remedy is a **classification** (`started / outcome-unknown` vs `pre-start failure`) carried out of the
  dispatch and into the notice contract.
- **`#447`** — a dispatch that never reached `prompt()` is offered as an interrupted, retryable run. Its
  remedy is an **acceptance state** on the durable marker (`starting` vs `accepted`/`acceptedAt`) so a
  pre-start residue cannot be read as "started".

**What the deadline owner must NOT need from either:**

| Not needed | Why not (measured/read) |
|---|---|
| an `acceptedAt` / `starting` state (`#447`) | The deadline arms **before** `prompt()` (`:1963-1968`) and fires **after** it, so at every deadline-time decision the acceptance question is already answered by the arm itself. Nothing in §1–§6 reads an acceptance field |
| a start-classification field on the dispatch result (`#439`) | The deadline's decisions are all per-run and local: `agent.completedAt`, `agent.status`, `runFinalized`, the id |
| a new notice literal or a "started, unknown" wording (`#439`) | The deadline already produces the shipped `subagent:stopped` wake (`session-manager.ts:1013-1014` → `index.ts:4190`) and the shipped timeout message ("Timed out after Xms"). The brief must add **no** user-facing vocabulary — that is `#439`'s and `#447`'s to define |
| a fourth history status (`#439`'s open question) | §3's terminal write uses the existing `failed` + `errorCategory: "timeout"`, exactly what the cooperative settle writes today (F4.2) |
| the retry-side notice claim (`claimTerminalNotice`) | The deadline does not touch it; the wake owns it (`index.ts:4300`). Coupling the counter to the event was rejected for this reason (§1.2, O1-d) |

**The one place the deadline and `#447` genuinely intersect — and it is `#447`'s to win:** the deadline
classifies a *started* run, so the residue it leaves (§3) is never the pre-start residue `#447` describes.
`#447`'s acceptance state must not be repurposed as a deadline field; if the conductor wants a
"deadline-abandoned" mark, it is a **new** field (`deadlineFiredAt`, §2.2 O2-b) with its own reader, not an
overload of `acceptedAt` or `interruptedAt`.

Also worth recording for `#439`'s benefit (not an action here): the deadline's status pre-set is what makes
its stop indistinguishable from a user stop at the notice layer — `normalizeCompletionStatus`
(`notify-completion.ts:80-83`) maps both to `stopped`, and `isTimeoutEvidence`
(`notify-completion.ts:119-124`) recovers it from the error text/category. A timer-side terminal entry (§3)
would put `errorCategory: "timeout"` in the run entry *before* the wake reads it, which is a small
improvement for that predicate — a side effect, not a requirement.

---

## 9. Decision matrix

| # | Decision | Recommended choice | Confidence | Cost | Blocks a release? |
|---|---|---|---|---|---|
| 1 | One owner | **O1-b** — the spawn owns the timer; delete the caller timer + `deadlineOwner`; the poller keeps the live row | **High** — F1.6 measures the split already working for explicit timeouts; F1.4 shows the split's hole | **M** (~80 source deleted, ~6 added; ~90 test) | **No** — the shipped split is correct for every path except a caller-tail throw, which is a known `#448` deferral |
| 2 | Cooperative abort | **O2-b** — abort-only, no resource release, contract written down, one diagnostic | **High** for the contract (F2.1, F2.2 measured); **Medium** for leaving the branch-lock convoy unmitigated (F2.3) | **S** (~10 source, ~50 test) | **No** — but the convoy deserves its own issue (it is pre-existing and independent of ownership) |
| 3 | Prune-safe finalization | **O3-b** — the timer may write the terminal record, never prune; split the guard into write-once + prune-once | **High** — F3.3/F3.4 measure both hazards; F3.5 measures the cost of doing nothing | **M** (~45 source, ~120 test) | **No** — the current state is a permanent stale row, not a failure |
| 4 | Snapshot vs amend | **O4-b** — snapshot the classification, amend the payload on a late settle (`find` → `findLast`) | **Medium** — F4.4 makes snapshot-only visibly wrong on money; the selector change is one line but touches a shared reader | **M** (~35 source, ~110 test) | **No** — F4.4 is a metrics-accuracy regression introduced *by* this change, not a pre-existing release blocker |
| 5 | Time origin | **O5-b** — origin = record creation; arm with the remainder | **Medium** — the drift is measured (42 ms injected, 246 ms cold) but tiny in the common case; a slow branch lock enlarges it | **S** (~8 source, ~40 test) | **No** |
| 6 | Sync-throw cleanup | **O6-b** — implied by Decision 1; no separate change | **High** — F6.1 measures the clear; F6.3 shows the remaining hole closes with O1-b | **S** (0 extra) | **No** |

**Reading of the matrix.** Nothing here is a release blocker: the shipped system is bounded (every run
armed by *somebody* on every path except F1.4), and the residue is stale data rather than a failure. What
the issue buys is (a) the F1.4 hole, (b) the permanent stale row, (c) a written contract for what a
deadline abort owns. That is a **single medium PR** if Decisions 1/3 are taken together (they share the
`finalizeRunEntry` closure and the arm site), plus a small follow-up for 4/5.

---

## 10. Execution sketch — what the implementation brief must contain, in order

The brief should carry **only** the chosen options. Sequence matters: each step is testable before the next.

**Step 0 — preconditions the implementer verifies first (5 min).**
`git rev-parse HEAD`; `grep -rn "spawnBackgroundSession\s*(" src --include=*.ts | grep -v __tests__` → 2
lines (declaration + `index.ts:2010`); baseline `vitest run` on the three deadline suites → 166 green.
If either differs, stop: the anchors have moved.

**Step 1 — the one-arm change (Decision 1 + 6).**
Delete `index.ts:2189-2257` and the three `clearTimeout(hardCapHandle)` sites (`:2094`, `:2134`, `:2171`);
delete `deadlineOwner` (`session-manager.ts:1207-1215`, `:1966-1968`, `index.ts:2027`).
*Test before code*: an arm census (delay == budget) for a dispatch and for a direct spawn, both `=== 1`;
and F1.4's harness (throwing caller tail → abort fires at the deadline).

**Step 2 — the timer's terminal write, no prune (Decision 3).**
Split the guard at `session-manager.ts:1468-1470` into `entryWritten` / `pruned`; add `{ prune: false }` to
the deadline-time call; wrap it in `try/catch` + `log.warn`; keep the abort block untouched (§7.1).
*Tests*: dir survives the deadline; a later cooperative settle still prunes; a throwing terminal append
neither escapes the timer nor loses the run from every surface; exactly one terminal append.

**Step 3 — the amendment (Decision 4).**
`state.ts:100-104`: `find` → `findLast` for the non-running preference. In the settle path, when
`entryWritten` is already true, append an amendment with the payload fields only.
*Tests*: three-entry resolution; amended cost visible through `computeSLAMetrics`; `status`/`errorCategory`
unchanged by the amendment; a two-entry run unchanged.

**Step 4 — the time origin (Decision 5).**
`session-manager.ts:1963-1968`: `const remaining = Math.max(0, budget - (Date.now() - startedAt))`, with a
comment naming `normalizeTimeout` as the wrong path.
*Tests*: injected setup delay shortens the armed delay by the same amount; a zero remainder still aborts.

**Step 5 — the written contract (Decision 2).**
The `armDeadline` doc comment (`:1909-1915`) gains the ownership contract verbatim. The CHANGELOG already
lists two limits from `#448` — "abort is cooperative" and "a caller throw leaves the run unbounded": the
first **stays**, the second is **removed** because O1-b closes it.
*Tests*: the deadline releases no branch lock and prunes nothing (F2.2/F2.3 as assertions).

**Gates.** `vitest run` with a final-tree JSON report; `npm run typecheck`; `node scripts/docs-arch.mjs`;
`node scripts/docs-decisions.mjs`; `git diff --check`; README drift; test budget.

**Budget (measured at base).**
```
source 23,814 · test 47,261 · ratio 1.9846 · ceiling 2.0 · headroom 367 test lines
```
Step 1 deletes ~80 source lines, which *lowers* the allowance by ~160 test lines, and it deletes the four
superseded `#448` ownership tests (§7.2, ~96 lines), which repays about as much. Steps 2–5 add ~95 source
lines (~190 more allowance). Net for a Steps 1–3 first PR: roughly 300 test lines available. Treat any
estimate here as an estimate, not a cap — the real gate is the JSON report.

**Docs.** CHANGELOG: one arm site; the deadline writes the record but never prunes; a late settle amends the
payload; the budget is anchored at record creation; **and the limits that remain** (abort is cooperative;
a never-settling run keeps its session dir, its registry entry until process exit, and — branch mode — its
git lock).

---

## 11. Where the evidence contradicts the issue body

**C1 — "the caller owns work the session-manager cannot do … Moving the timer wholesale loses them."**
Half true. The session-manager cannot do it (no `state` import), but the **timer** does not do it either in
the shipped tree: for every explicit-timeout run the caller has **no timer at all** and the poller performs
all five steps (F1.6, measured). So the work is caller-owned but **poller-owned**, and moving the timer
costs one poller tick rather than a handshake. This is the single fact that makes Decision 1 cheap.

**C2 — the residue reads as a lifecycle question that a later boot repairs.**
It does not repair. The boot scan drops a background registry entry whose agent record is terminal
(`recovery.ts:275`), and the deadline sets exactly that (`stopped`). Measured: `scanned: 0, marked: 0`,
run entry `running` with `interruptedAt: null`, registry entry retained (F3.5). `#439`'s §4 next-boot
finding applies to the *unmonitored* class, whose agent record stays `running` — not to this one. The
do-nothing baseline is therefore weaker than the issue implies, and Decision 3 is worth its cost.

**C3 — "the claim is not proof of registration … a finalize claim for an unregistered id decremented a
sibling's count."**
Confirmed (F1.5: `claimed:true`, `1 → 0` with the sibling still live; the raw counter reaches `-1`). But the
*consequence* is narrower than the issue's framing: the hazard only exists while a **timer or poller keeps
the id** after a failed registration. With O1-b the timer never claims, and the poller is created in the
same block as the registration, so a registration failure means no poller either — the hazard disappears
without a registration handshake. The handshake is only required by the option that keeps caller-side work
inside the timer (O1-c).

**C4 — precision, not contradiction: "a normal run has three timers (poller, footer, deadline)".**
Measured 3, correct — but the two non-deadline timers are both **`setInterval`s** (poller 2 s, footer
spinner `concurrency.ts:178`), and a fourth `setTimeout` (`statusResetTimer`, `concurrency.ts:233`) appears
after the run settles. "Count deadline arms" is the right rule; "three timers" is a snapshot, not a
constant.

**C5 — precision: "`startedAt` is recorded before branch setup and any branch-lock wait (`:1387` vs
`:1646+`)."** The line pair is right in spirit and the drift is real (F5.1), but the current anchor is
`:1396` (record creation) and the arm is `:1963-1968`, not `:1646` (that is the lock acquisition). The
measured drift is the *whole* pre-arm span, not just the branch wait.

---

## 12. Unverified, and what would settle it

| # | Claim left unverified | Why it matters | Command that would settle it |
|---|---|---|---|
| 12.1 | Whether a **real provider stream** can ignore `AbortSignal` (K1 uses a synthetic deaf stream; the real anthropic/openai SDKs normally honour it) | If never in practice, Decision 2's convoy is theoretical and O2-c is waste | Run a real dispatch with a proxy that accepts the connection and never responds (`ALL_PROXY=http://127.0.0.1:<blackhole>`), then `stop_subagent` after 10 s and observe `get_subagent_result` + the process's git lock |
| 12.2 | The **caller-side** arm drift (the tail after the spawn returns). Measured 2 ms with the injected delay placed before record creation, so the tail was not exercised | Decision 5's size for the O1-a baseline | Re-run `W453J-J3` with a 30 ms sleep injected *between* `spawnBackgroundSession`'s return and `registerLiveSubagent` (patch in the scratch copy) |
| 12.3 | The git-lock convoy with a **real repo** and a live provider (A2 uses a stubbed git module + a stubbed prompt) | Decision 2's severity | Two branch-mode dispatches against a scratch repo, the first with a provider stub that never settles; observe the second's `createWorkBranch` call |
| 12.4 | Whether a still-writing **SDK-owned** writer exists after a settle (the `ENOENT` in C2/D1 is a synthetic append on the real `SessionManager`) | Decision 3's `prune:false`-at-the-deadline choice is safe either way, but the *settle-time* prune remains a theoretical hazard | Instrument a real run's `SessionManager._persist` to log appends after the settle and compare timestamps |
| 12.5 | Whether `registerLiveSubagent` can throw in production (B2 injects a throwing getter) | F1.4's reachability — if nothing there can throw, the hole is theoretical | `grep -n "export interface BackgroundAgent" -A 40 src/types.ts` and compare every field read at `index.ts:2055-2069`; today they are plain record fields, so the realistic trigger is a malformed spawn result, not a live getter |
| 12.6 | `computeSLAMetrics` end-to-end with an amended entry (F4.4 is a read of `metrics.ts:88-89`, not a run) | Decision 4's value | Feed two entries (snapshot + amendment) through `computeSLAMetrics` and assert the summed cost |

### Open questions the conductor must decide (not resolvable from the code)

1. **Latency vs containment for the deadline's repaint.** O1-b moves the deadline's footer update onto a
   ≤2 s poller tick. Is an up-to-2 s "still shows running after the stop" window acceptable, or does the
   timer need to keep a repaint-only hook? (The hook would re-open F1.5 unless it is claim-free.)
2. **O4-a vs O4-b.** Snapshot is smaller; amend keeps the money honest. If the conductor takes O4-a, the
   CHANGELOG must say timed-out runs report `cost: 0` in history/metrics.
3. **O5-b vs O5-c.** A branch-lock wait either eats the budget (O5-b, matches the display) or does not
   (O5-c, matches "30 minutes of work"). Both are one file.
4. **Does the branch-lock convoy get its own issue?** Measured, pre-existing, independent of ownership, and
   the only finding here with a user-visible "everything stopped dispatching" failure mode.
5. **Does a deadline-abandoned session dir need a sweep?** With §3 nothing prunes a never-settling run's
   dir, and the `#404` sweep only reclaims `.transport-retained`-marked dirs. Unbounded litter, slowly.

---

## Appendix — probe inventory

Every probe is a vitest file in `/tmp/brl453/src/__tests__/` (baseline) or `/tmp/brl453-mut/src/__tests__/`
(the one-line mutant), run under the house env (`env -i … HOME/PI_CODING_AGENT_DIR/TMPDIR` redirected, no
network, no provider):

| Probe | File | Measures |
|---|---|---|
| A1, A2 | `w453a-residue.test.ts` | deadline residue census; branch lock + spawn-queue convoy |
| B1, B2 | `w453b-caller.test.ts` | timer/arm census through `delegate_task`; caller-tail throw |
| C1–C3 | `w453c-prune.test.ts` | real-SDK `ENOENT` after prune; settle prunes a live session's dir |
| D1, D2 | `w453d-mutant.test.ts` (mutant) | timer-side finalize prunes; snapshot cannot be amended |
| E1–E4 | `w453e-claim.test.ts` | claim ≠ registration; counter can go to −1 |
| G1 | `w453g-boot.test.ts` | boot scan drops a terminal-agent registry entry |
| H1, H2 | `w453h-origin.test.ts` | setup→arm drift; the full arm matrix |
| I1 | `w453i-timerthrow.test.ts` (mutant) | a throwing terminal append escapes the timer |
| J1, J2, J3 | `w453j-poller.test.ts` | poller cleans a non-caller deadline; the deadline race; caller arm delay |
| K1 | `w453k-coop.test.ts` | real SDK: a signal-deaf stream leaves abort and prompt pending |
| L1–L4 | `w453l-amend.test.ts`, `w453l2-amend.test.ts` | amendment invisibility; `find` vs `findLast` |

The mutant's entire delta (reproducible):

```
$ diff -u /tmp/brl453/src/session-manager.ts /tmp/brl453-mut/src/session-manager.ts
@@ 1941,6 +1941,8 @@
       }
+      // #453 PROBE MUTATION: a naive timer-side finalize (NOT the shipped code).
+      finalizeRunEntry('failed', reason);
       if (bookkeepingFailure) {
```

**What was NOT probed, deliberately:** no real provider, no real process kill, no `/reload` interleaving,
no live repo for the git-lock convoy (12.3). Every claim above that depends on those is marked
**unverified** with the command that would settle it.

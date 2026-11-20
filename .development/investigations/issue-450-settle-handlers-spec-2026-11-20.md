# #450 — attach the background settle handlers before the prompt (shape (b)) — spec r2

**Issue:** #450 — hardening. Recorded priority **low** (2026-11-20: bounded consequence, zero observed
incidence) · classifier risk **C1** · `fix: mechanical` · worktree **y** · review **C2 focused**.
**Cycle:** `settle-handlers` (open 2026-11-20) — **U1**.
**Spec r2:** 2026-11-20, against `dev @ 481b852` (`src/session-manager.ts` 2,723 lines;
`src/__tests__/session-manager.test.ts` 3,456 lines). r1 is preserved at `c511d59`.
**Provenance:** r1 (this file) + the round-1 critique (`issue-450-plan-critique-r1-2026-11-20.md`, nine
findings, **all accepted**) + the decisions recorded on the issue (shape (b); keep F1; add the
async-rejection pin; priority stays low) + the probes logged in §Evidence.

This is a **design** revision, not a wording pass. Four decisions changed relative to r1:

| # | r1 | r2 | Why |
|---|---|---|---|
| 1 | one `try` wrapped the call **and** the routing attach; any throw there called `failPreStart` | **two regimes** with a syntax boundary between them; a post-start fault never calls `failPreStart` (D2) | r1 misclassified a started run as "never issued" (critique #2) |
| 2 | a per-spawn `Symbol` sentinel rejected into the deferred by the pre-start catch, with the catch body no-op'ing on it | the pre-start catch **does not settle the deferred at all** (D6) | the sentinel's only justification was a leak that does not exist, and its correctness was unprovable (critique #6, #8) |
| 3 | non-Error throws unaddressed | normalised in both regimes (D5) | `throw null` raised a `TypeError` out of the cleanup itself (critique #7) |
| 4 | malformed `prompt()` returns silently "handled" by the routing | excluded **by contract**, with the residual stated (D3, Q2) | the SDK's `prompt` is `async`; handling is unreachable and the r1 claim of handling was false (critique #1) |

The caller-visible status change r1 dismissed as "one microtask hop" is **real and accepted** (D4, Q1) with a pin.

## Context (verified 2026-11-20)

Recon holds: `git log --since=2026-11-14 --oneline -- src/session-manager.ts src/background-pipeline.ts
src/__tests__/session-manager.test.ts src/__tests__/background-session-persistence.test.ts` is **empty**
(HEAD `481b852`), and `git status --porcelain` is empty. Every anchor matches:

| Anchor | Line | What it is |
|---|---|---|
| `agent._sessionRef = session;` | `:1988` | the live-session ref (§D8 roots) |
| `deadlineHandle = armDeadline(...)` | `:2462` | the one deadline owner (#453), armed **before** the prompt |
| `run.acceptedAt = new Date().toISOString()` | `:2472` | the durable acceptance marker (#447) |
| `persistRunRecord(pi, run, "background")` | `:2474` | the acceptance write (throw → `failPreStart` → rethrow) |
| `runPromise = session.prompt(wrapTask(params.task))` | `:2490` | the one call whose return must be monitored |
| `runPromise.then(() => {` | `:2501` | the settle handlers, attached **after** the call returns |
| `}).catch((err: Error) => {` | `:2651` | the rejection settle |
| `const failPreStart = (message: string)` | `:1942` | deadline clear → branch teardown → entry finalize → registry retire |
| `const markTerminalBestEffort` | `:2283` | the settle-handler catch-all |
| `agents.set(id, agent);` | `:1576` | the pre-prompt record write (the pre-start retention root) |
| `gitCleanupDone` guard in `cleanupWorkBranch` | `:1841` | once-per-run teardown |
| `armDeadline`'s timer body | `:2350–2440` | `if (agent.completedAt) return`, abort, `prune: false` snapshot |

## The defect, restated precisely

Two failure classes sit in a 9-line span (`:2482–:2503`), not one:

1. **A throwing statement between `prompt()` returning and `.then` attaching.** The settle is lost; the
   pre-armed deadline (#453) replaces the outcome with a `timeout` classification, `cleanupWorkBranch`
   never runs, and the work-branch lock plus the session dir are held until process exit. Only a code
   edit can introduce it.
2. **A throw *after* the routing attach but inside the same `try`** (r1's own shape, critique #2). The
   throw reaches `failPreStart`, which declares "the prompt was never issued" and prunes a **live**
   session's directory and releases its branch lock while the session may still be writing — strictly
   worse than the class it was meant to prevent.

Class 2 is a defect r1 *introduced*. That is why r2 splits the region instead of widening the `try`.

Why the issue is still C1/low: 591/591 background spawns settled, 0 background timeouts; with the real
SDK (`prompt` is `async`, §Evidence E3) a synchronous throw means the call never entered, so class 1
needs a new statement in a hot region. This spec closes class 1 structurally, removes class 2, and pins
both.

## Design

### D1 — The deferred, and THE ATTACH, before the call (shape (b))

Created **after** the acceptance write (a failed acceptance must not leave an unowned promise), the two
settle handlers go on **our own** promise, and the attach is one named statement **above** the prompt
call. The handler bodies are textually unchanged — they keep their indentation and their `.then`/`.catch`
topology (`a throw inside the success body` is still contained by its own `try/catch`; a genuine prompt
rejection still reaches the fault body).

```ts
  let runPromise: Promise<unknown>;
  let resolveSettled!: () => void;
  let rejectSettled!: (reason: unknown) => void;
  const settled = new Promise<void>((resolve, reject) => {
    resolveSettled = resolve;
    rejectSettled = reject;
  });

  const onSettled = (): void => { /* — the existing :2501 body, unchanged — */ };

  const onSettleFault = (reason: unknown): void => {
    if (deadlineHandle) clearTimeout(deadlineHandle);
    try {
      const err = reason instanceof Error ? reason : new Error(String(reason));  // D5
      /* — the existing :2651 body, unchanged except the `err` binding — */
    }
  };

  // THE ATTACH
  settled.then(onSettled).catch(onSettleFault);
```

Named handlers rather than `.then(() => { … })` are not cosmetic: they keep the ~150-line bodies at their
current indentation (a `.then(() => {` wrapper would re-indent every line and produce a
whitespace-only 300-line diff), and they reduce the invariant to one checkable statement — *the attach
line exists, and it is above the call*.

**Chosen over shape (a)** (`Promise.resolve().then(() => session.prompt(…))`), which empties the window but
changes spawn-queue interleaving (`resolveNext()` would run before the prompt), loses the synchronous
acceptance and turns a pre-start rejection into an async terminal event. Decision already recorded on the
issue; not reopened.

### D2 — The catch boundary: two regimes, separated by syntax, not a flag (critique #2)

`failPreStart` is only *true* when nothing started. The boundary is therefore the prompt **call**, and the
code says so with two adjacent `try` statements:

```ts
  // ---- REGIME 1: pre-start ------------------------------------------------
  try {
    runPromise = session.prompt(wrapTask(params.task));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);   // D5
    failPreStart(sanitizeErrorMessage(reason, effectiveCwd));
    throw err;                                                          // D6: deferred NOT settled
  }

  // ---- REGIME 2: post-start ----------------------------------------------
  try {
    runPromise.then(resolveSettled, rejectSettled);
  } catch (err) {
    log.error(
      `spawnBackgroundSession: settle routing failed for ${id} — the run is unmonitored; its deadline remains the only bound`,
      { error: err instanceof Error ? err.message : String(err) },
    );
  }
```

**Why the boundary is the call, and not a guess.** The installed SDK's `prompt` is `async`
(`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1704`; typed
`prompt(text): Promise<void>` in `agent-session.d.ts:573`, §Evidence E3). An `async` function never throws
to its caller — a throw inside it becomes a rejection. So a **synchronous** throw observed here can only
come from evaluating the callee, the receiver or the argument (`wrapTask` is a pure `String.replace`,
`src/prompt.ts:67`) — i.e. the callee was never entered. "Provably never issued" is therefore true in
regime 1 and only there, which is exactly the condition `failPreStart`'s contract requires
(`:1930–1941`: "PRUNING IS PROVABLY SAFE HERE — and only here").

**What regime 2 does and does not do.**

- Does **not** call `failPreStart`: no never-issued message, no dir prune, no branch release while the
  session may write.
- Does **not** clear the deadline and does **not** arm a second bound: ADR 0023 decision 1 keeps one
  owner. The already-armed deadline is the monitor of last resort — it aborts, then writes the
  `timeout`/`aborted` snapshot with `prune: false`, so a still-writing session keeps its dir and its
  branch.
- Does **not** reject the spawn: the run started; the caller must not receive
  "Failed to spawn background agent" (the #439 boundary). The spawn resolves with the agent, `running`.
- **Is unreachable on the real SDK** (an `async` method's promise always has `then`). It exists for a
  non-conforming or injected session, and for a future edit — see D3's residual.

**Residual risk, stated rather than papered over:** a fault injected between the two regimes by a future
edit (a statement on the blank line between `}` and `try {`) escapes uncaught — the spawn rejects with
that fault and the run is left as the deadline's problem. The ratchet (§Tests T1 / Q3) closes this by pinning the
statement list, not by runtime cleverness.

### D3 — The return contract: settle-then-throw thenables are excluded, not designed for (critique #1)

**Contract:** `session.prompt(text)` is `async` and returns `Promise<void>`. The design relies on that and
nothing weaker:

- the deferred is settled **only** by the regime-2 routing reaction, i.e. only after the call returned
  normally — so a throw from the call itself can never race a settlement (this is what makes D6 possible);
- a returned value that is not a promise cannot resolve the deferred (`Promise.prototype.then` throws →
  regime 2 logs);
- a **hostile** thenable that calls `resolveSettled()` synchronously inside `then()` and *then* throws is
  outside the contract. Its worst case is bounded: the success body runs (the same body the real path
  runs, writing one terminal record and emitting the completion event) and the deadline still sees
  `agent.completedAt` set and returns without a second classification. It cannot double-classify;
  it can mis-report a run that was still live. Accepted.

**Why not design for it** (Q2 row R2): the only way to be correct for it is a settle-once latch plus the
r1 sentinel plus a post-`failPreStart` guard — three mechanisms for a value the SDK cannot return, each
of which then needs its own tripwire, and the tripwire is precisely what failed in r1 (critique #6).

**Falsifier:** the installed SDK starts returning a non-native thenable, or its signature widens to
`PromiseLike<void>`/`Promise<any>` — then reopen Q2 with R2.

### D4 — The caller-visible status: accept `running` at the caller's resume (critique #3)

The deferral costs exactly one microtask hop, and the hop is **caller-visible** (r1 called it "measured
harmless" — measured at the test level, not at the caller level):

| | `await spawnBackgroundSession(...)`, immediately-resolved prompt |
|---|---|
| baseline (attach on `runPromise`) | the caller resumes with `agent.status === 'completed'` |
| shape (b) (attach on the deferred) | the caller resumes with `agent.status === 'running'`; `completed` one tick later |

Measured twice: a standalone probe and the real harness (§Evidence E1, E8).

**Decision: accept it**, and make it a *contract* instead of a race:

> **Acceptance criterion D4.** For every prompt shape — already resolved, pending, hanging — at the
> caller's first statement after `await spawnBackgroundSession(...)`, `agent.status === 'running'`. The
> same statement in the pipeline is the identity capture (`background-pipeline.ts:568`,
> `status: agent.status`), so `identity.status` is deterministically `running`.

**Pipeline / identity consequence.** `spawnBackgroundRun` formats `Status: ${spawned.identity.status}`
(`background-pipeline.ts:995`) from that snapshot, so for an immediately-finished run the spawn result now
says `Status: running` where it used to say `Status: completed`. That is the *intended* reading of the
text it accompanies ("Background agent started … You'll be woken with a completion message when it
finishes"); the old value was a scheduling race, not a guarantee. Nothing branches on it: the identity
record has exactly one read (`status: agent.status` at `:568` is the capture,
`Status: ${spawned.identity.status}` at `:995` is the only consumption), and
`buildMonitoringDegradedParagraph` takes only `id`/`label` (§Evidence E13). The run's real outcome is unchanged (same terminal record, same event, same wake).

**Test-only changes:** none in the existing 172 tests — measured, not assumed (§Evidence E4). The
decision is pinned by one **new** test that also pins the pipeline capture point (no `await` between the
spawn and `status: agent.status`), because that is the statement whose position makes the snapshot
deterministic. That test is red on the baseline (`completed` vs `running`, §Evidence E8).

Options and falsifiers for this decision: **Q1**.

### D5 — Non-`Error` throws are normalised in **both** regimes (critique #7)

`prompt()`'s rejection value and a synchronous throw are both `unknown` by contract. `failPreStart` takes
a **string**, and the r1/pre-#450 code passed `(err as Error).message` — with `throw null` that raises
`TypeError: Cannot read properties of null` *inside the cleanup*, masking the original throw and skipping
the terminal write. Two normalisations, one per regime:

```ts
// regime 1 (pre-start)
const reason = err instanceof Error ? err.message : String(err);
failPreStart(sanitizeErrorMessage(reason, effectiveCwd));
throw err;                                    // the ORIGINAL value, unmodified

// regime 2's fault body (first statement after `try {`)
const err = reason instanceof Error ? reason : new Error(String(reason));
```

- The original throw is preserved (`throw err`, not a re-wrapped error) — `throw null` still rejects the
  spawn with `null`.
- The rejection body keeps its old identifier (`err`) so its ~40 lines are untouched; the value is narrowed
  once, before any `.message` use.
- **No `finally` is needed for the deferred** (r1's critique #7 asked for one, because r1 released the
  deferred *after* `failPreStart`): under D6 the pre-start catch never touches the deferred, so no fault in
  `failPreStart` can skip a release. The `finally` requirement is satisfied structurally.
- `failPreStart` itself is already fault-contained (`finalizeRunEntry` in `try/catch`, `cleanupWorkBranch`
  contains its git faults, `clearInflightRun` swallows ENOENT,
  `src/run-registry.ts:261–269`), so it cannot mask the rethrow.

Falsifier: `throw null` (regime 1) or `d.reject(undefined)` (regime 2) must still produce exactly one
terminal run entry with `errorMessage` `"null"` / `"undefined"`, and the spawn must reject with the
original value (§Tests T4; mutants M9, M10).

### D6 — The pre-start catch does **not** settle the deferred (replaces r1's sentinel) (critique #6, #8)

```ts
  } catch (err) {                 // REGIME 1
    …
    failPreStart(sanitizeErrorMessage(reason, effectiveCwd));
    throw err;                    // ← and nothing else. No sentinel, no rejectSettled.
  }
```

`failPreStart` has already classified the run exactly once: deadline cleared, branch torn down, terminal
run entry written (which also writes the `.done` settle marker), registry entry retired. Settling the
deferred afterwards would run a settle body a second time over the same run.

Why abandonment is safe here, and why the r1 sentinel was not worth keeping:

1. **No leak.** An unreachable pending promise and its handler closures are collectable — probed with
   `--expose-gc` + `FinalizationRegistry` (§Evidence E2: `collected: ['closure-payload']`).
2. **Unreachable in this path.** The routing never ran, the deadline was cleared, and nothing else captures
   `settled`; the only other reference is the spawn scope itself, which the pre-start path already roots
   through `agents` and `agent._sessionRef` (D8/E7). The deferred adds **no** root.
3. **The sentinel was unprovable.** Its only job was to stop a second terminal pass, and r1's tripwire for
   that (F1's `SETTLED_RUN_WRITES` count) is blind: the finalizer's `entryWritten` guard masks the repeat,
   and the critic's no-guard build passed F1. A guard whose removal is not observed is not a guard.

The deferred is still settled on every normal path (the routing resolves/rejects it), so shape (b) does not
leave it dangling in production.

**The sentinel's replacement is a tripwire on side effects only a settle body produces** (T5): the
completion transcript line and the terminal event. `failPreStart` produces neither.

### D7 — Deadline interaction (unchanged owner, one new path that must not claim it)

- The deadline is armed at `:2462`, before the acceptance write and before the deferred — **unchanged**.
- **Regime 1's catch** clears it via `failPreStart` (`:1943`); r1 was right that no new `clearTimeout` is
  needed, and r2 keeps that (the timer count assertion in #448's test at `:1007` still passes).
- **`onSettleFault`** keeps its existing `clearTimeout` as its first statement (now with the D5
  normalisation immediately after, inside the `try`). This is the falsifier target of T2 (mutant M1).
- **Regime 2's catch does NOT touch the deadline.** It is the monitor of last resort for an unmonitored
  run, and ADR 0023 decision 1 forbids a second bound. The `timeout`/`prune: false` snapshot it produces
  is what keeps a still-writing session's dir and branch.
- **The success body** keeps its `clearTimeout` (`:2502` → unchanged).

### D8 — What the pre-start path actually retains (claim narrowed) (critique #8)

r1 claimed "nothing is released → nothing to release". The honest statement, measured (§Evidence E7):

| Object | After a pre-start throw | Owner |
|---|---|---|
| terminal **run entry** | `failed`, one write | durable store (correct) |
| `.done` settle marker | written by `finalizeRunEntry` → `markSettled` | scratch dir (correct) |
| in-flight registry entry | retired | `clearInflightRun` (correct) |
| **agent record** | still `running` in memory **and on disk** | `agents` map (`:1576`), `persistAgent` |
| **`agent._sessionRef`** | still the live session | `:1988`; released only by `captureAndReleaseSession` / `markTerminalBestEffort` |
| deferred + handler closures | collectable once the deadline is cleared | none (D6) |

So: **rejecting the deferred alone would not release the session graph either** — the graph is rooted by
`agents` and `_sessionRef`, independently of the deferred. r2 therefore claims **only** collectability of
the deferred, and states the agent-record/`_sessionRef` retention as a **pre-existing** property of the
pre-start path (the same shape #460 §4.4 recorded for `failPreStart`: it stops at the run entry).

**Out of scope, flagged not fixed** (surgical boundary): a pre-start failure leaves an agent record
`running` while its run entry says `failed`. Whether that should be repaired is a separate unit with its
own observable (`getAgent(id)?.status` after a synchronous prompt throw) — it is not this cycle's defect
and the F1 test does not pin it either way.

## Open questions — options, recommendation, falsifiers

### Q1 — The caller-visible status (D4)

| Option | Mechanism | Blast radius | Cost | Risk if wrong |
|---|---|---|---|---|
| **S1 — accept (recommended)** | keep the deferral; document that the spawn reports `running` at the caller's resume and pin it (T6) + pin that the pipeline capture has no `await` between spawn and snapshot | one caller-visible value changes for an immediately-resolved prompt: `completed` → `running`; the spawn result text reads `Status: running`; the terminal record, event and wake are unchanged | 1 test; **0** changes to the 172 existing tests (measured) | a caller that inferred "already finished" from the spawn result loses that inference — it still gets the completion event and `get_subagent_result`; the run's outcome is untouched |
| S2 — preserve the old timing (shape (c)) | drop the deferral: keep the handlers attached directly to `prompt()`'s promise (today's shape), add the *policy* pin only (ratchet), keep the pre-arm | zero timing change; **the structural guarantee is gone** — the window stays one statement wide and is protected only by a source ratchet | smaller src delta (~+10 lines); the ratchet carries the whole guarantee | a rewrite that satisfies the ratchet's spelling but throws at runtime (a throw inside a helper called there, a non-thenable return) loses the settle again; also reverses the shape (b) decision recorded on the issue → conductor sign-off required |
| S0 — do nothing | — | none | none | the defect stays and no test goes red when a future edit re-opens it |

**Recommendation: S1.** The `completed`-at-resume behaviour is a race, not a contract: it holds only when
the prompt happens to resolve before the caller's continuation. Pinning `running` makes the spawn result
truthful for every prompt shape and makes the pipeline snapshot deterministic. **Falsifiers:** (a) a
consumer that *branches* on `identity.status` (none today — `identity.status` has exactly one read,
`background-pipeline.ts:995`, and the degraded paragraph's type excludes it, `notify-completion.ts:374`);
(b) a test that legitimately needs `completed` at resume (none — E4); (c) the conductor judging the
`Status:` text change user-visible in a way that matters for the transport retry (it does not read that
line — it reads `isError`, `background-pipeline.ts:996–1010`).

### Q2 — The return contract for `prompt()` (D3)

| Option | Mechanism | Blast radius | Cost | Risk if wrong |
|---|---|---|---|---|
| **R1 — exclude by contract (recommended)** | rely on `prompt(): Promise<void>` (`async`); state it at the site; the deferred is settled only by the regime-2 routing reaction | none today (the SDK cannot produce a sync throw after starting, and cannot return a non-promise); residual: a hostile thenable that resolves then throws runs the success body once, with the deadline backstop | 0 production lines beyond the comments already in D2/D3 | an SDK change to a non-conforming thenable mis-reports a live run as completed once; it cannot double-classify (the deadline sees `completedAt`) |
| R2 — design for it | settle-once latch + sentinel + a post-`failPreStart` guard; new tests for resolve-then-throw | every settle path gains a guard; two extra states (settled-once, settled-after-failPreStart) | ~+25 src lines, +2 tests, and the r1 sentinel's unprovable tripwire problem returns | the guards are unreachable in production, so their removal is unobserved; more surface for the class-2 misclassification to creep back |
| R0 — r1 | r1 kept the "handles malformed returns" claim without a mechanism | — | — | reproduced by the critique: `failPreStart` writes, then the success body writes |

**Recommendation: R1**, with the residual written into the site comment and the deadline named as the
backstop. **Falsifier:** the SDK's `prompt` signature or implementation stops being `async`/`Promise<void>`
(re-open Q2 with R2).

### Q3 — The shape of the ordering ratchet (critique #4)

| Option | Mechanism | Blast radius | Cost | Risk if wrong |
|---|---|---|---|---|
| **G1 — closed statement list (recommended)** | source scan of the window (`:2472` → the routing): every statement of the window at the function's own 2-space indentation must equal a declared, ordered list of 11 heads; each regime's body must be exactly one statement; the attach is asserted above the call | test-only; couples the test to the region's statement *shape* (not its line numbers) | ~60 test lines; any legitimate addition edits the list (a decision, by design) | a benign restructure goes red (annoyance); a throw hidden **inside** an allowlisted statement (e.g. inside `persistRunRecord`) is invisible — stated |
| G2 — marker order + "no await" (r1) | `indexOf` ordering + `await` absence + same-`try` | test-only | ~20 lines | **proven insufficient**: a probe with two throwing sites returned `{order:true, noAwait:true, sameTry:true, containsThrowSites:2}` (critique #4) |
| G0 — no ratchet | review only | — | 0 | the ordering property the issue keeps in scope stays unpinned |

**Recommendation: G1.** It is the only one of the three that goes red for a *throwing statement*, which is
the fault class this window has. It does not pin line numbers and it does not pin `runPromise.then(`; it
pins "the window is these eleven statements, in this order, and each regime body is one statement" — an
equivalent implementation can pass by amending the list, which is the recorded decision the issue asks
for. **Falsifiers:** a legitimate statement added to the window that *cannot* throw and that the list
cannot express without losing the property — then the list must gain a per-entry "cannot throw" annotation
rather than be dropped. Named mutants that **must** go red: M3–M7 (§Tests).

## Acceptance criteria

Each is a claim an implementer can check; `T*`/`M*` are the tests and mutants in §Tests.

1. **The attach precedes the call.** `settled.then(onSettled).catch(onSettleFault);` is a single statement
   above `session.prompt(`, and the window between the acceptance write and the routing is the closed
   11-statement list. (T1; M3 → red.)
2. **No statement can be inserted on either side of the call** without a red test: before the deferred
   (M4), between the attach and the call (M5), inside regime 1 (M6), inside regime 2 (M7). (T1.)
3. **A synchronous `prompt()` throw stays pre-start** and classifies **once**: one terminal run entry
   (`failed`, the original message), deadline cleared, branch torn down, registry retired, **no settle body
   side effects** (no completion transcript line, no terminal event), spawn rejects with the **original**
   value. (F1 test unchanged + T5; M8 → red.)
4. **A throw after the call is post-start**: `failPreStart` is not called (no never-issued message, no
   prune), the spawn resolves, and the deadline remains the bound and classifies the run
   `timeout`. (T3; M2 → red.)
5. **An async rejection routes through the deferred**: `agent.status === 'failed'`,
   `result.stopReason === 'error'`, run entry `stopReason: "error"`, exactly one terminal write,
   `subagent:failed` emitted, and the deadline cleared (fake timers: 1 → 0). (T2; M1 → red.)
6. **Non-`Error` values work on both regimes**: `throw null` → `errorMessage: "null"` + original rethrow;
   `reject(undefined)` → `errorMessage: "undefined"`. (T4; M9, M10 → red.)
7. **The successful path is unchanged** except the status hop: `done` entry, branch capture, transcript
   `completed`, one terminal write, `completed` one tick after the caller's resume. (Existing suite + T6.)
8. **The caller-visible status is pinned** (`running` at resume, pipeline capture deterministic). (T6; red
   on the baseline — E8.)
9. **Full suite**: zero new failures against the baseline. (E5.)

## Tests

### New — 6, in `src/__tests__/session-manager.test.ts`, one `describe("#450 settle handlers attach before the prompt")`

| ID | Test (title as it must appear) | Asserts | Mutants it kills |
|---|---|---|---|
| **T1** | `pins the window's statement list: handlers attached before prompt(), one statement per regime (#450 ratchet)` | the 11-statement allowlist, in order; both regime bodies are exactly one statement; the attach line precedes `session.prompt(` | M3 (attach moved below the routing), M4 (throw before the deferred), M5 (throw between attach and call), M6 (throw inside regime 1), M7 (throw inside regime 2) |
| **T2** | `routes an async rejection through the deferred, clears the deadline and writes ONE terminal record (#450 async-rejection pin)` | `stopReason: "error"`, `agent.status === "failed"`, one terminal write, `subagent:failed`, fake-timer count 1 → 0, and no abort after advancing 2× the budget | M1 (delete `onSettleFault`'s `clearTimeout`) |
| **T3** | `treats a returned non-thenable as a POST-start fault, never 'never issued' (#450)` | spawn resolves with `running`; the run entry stays `running` (no `failPreStart` classification); `settle routing failed` in the log; advancing the budget yields `errorCategory: "timeout"` and exactly one abort | M2 (merge the regimes) |
| **T4** | `normalises a non-Error value on BOTH regimes and rethrows the original throw (#450)` | `throw null` → `.rejects.toBeNull()`, one terminal entry, `errorMessage: "null"`; `reject(undefined)` → `failed`, `errorMessage: "undefined"` | M9, M10 |
| **T5** | `classifies a synchronous prompt throw ONCE — no settle body runs (#450 sentinel tripwire)` | no `Transcript completed:` line, no `subagent:failed`, still exactly 3 run writes, terminal `failed` | M8 (`rejectSettled(err)` in the pre-start catch) |
| **T6** | ``the caller observes `running` at its resume even when the prompt resolves immediately (#450 D4 decision)`` | `agent.status === "running"` at resume; no `await` between the pipeline's spawn await and `status: agent.status`; `completed` after one tick | red on the **baseline** (E8); this is the D4 pin, not a mutant |

**Fixture requirement discovered empirically (do not omit):** T2 and T5 must set
`mocks.session.messages = []`. With an unreadable session projection the settle body throws at
`captureAndReleaseSession`, the catch-all (`markTerminalBestEffort`) contains it, and the terminal
**event/transcript** the tests look for never appears — the tripwire would pass for the wrong reason. The
existing rejection test at `:2551` does not set `messages`, which is why it can only assert the run entry.

### Must stay green — 11 (anchors re-measured at `481b852`; one r1 anchor was wrong)

| File:line | Test |
|---|---|
| `session-manager.test.ts:982` | "arms the deadline before it returns, so a CALLER throw cannot unbounded the run (#453)" |
| `session-manager.test.ts:1007` | "clears a deadline armed before prompt() when the spawn throws synchronously (#448)" |
| `session-manager.test.ts:1649` | "review C: a throwing settle still tears the work branch down (catch-all)" |
| `session-manager.test.ts:2390` | "releases the ref via markTerminalBestEffort when a settle handler throws" |
| `session-manager.test.ts:2483` | "persists a session run entry with the agent id at spawn" |
| `session-manager.test.ts:2551` | "finalizes the run entry to failed when the session rejects" — **`:2551` is the title; `:2552` is its `mockRejectedValue` line** (r1 cited `:2552`; critique #9 correct) |
| `session-manager.test.ts:2657` | "finalizes the run entry to failed when prompt() throws synchronously (review F1)" |
| `background-session-persistence.test.ts:198` | "normalizes an instantly-firing timeout to the 30m default, not to ~1ms" |
| `background-session-persistence.test.ts:268` | "success: removes the per-run dir when the prompt completes" |
| `background-session-persistence.test.ts:286` | "timeout/abort: removes the dir when the deadline aborts the run" |
| `background-session-persistence.test.ts:752` | "markTerminalBestEffort: prunes the dir when a settle step throws" |

Plus the spawn-queue interleaving / immediate-`running` pins and the `sections builder` ratchet at
`:303` (r1 cited `:309`, which is that test's `readFileSync` line — same test, cite `:303`).

All 172 existing tests in the two files were **measured green** with this design (§E4) — no test change is
required, which is what makes the D4 acceptance a "test-only, additive" decision.

### Ratchet limits, stated

- It is **syntactic**: a throw hidden inside a call in an allowlisted statement (inside `persistRunRecord`,
  inside `new Promise`'s executor) is invisible. Those are pre-start statements whose faults already route
  to the pre-start catch, or cannot throw at all.
- It is **text-based because it must be**: `typescript@7.0.2` ships the native compiler only —
  `ls node_modules/typescript/lib` → `getExePath.*`, `tsc.js`, `version.*`, **no `typescript.js`** — so
  there is no in-process AST API (§E11). Same discipline as the existing `sections builder` ratchet.
- It pins the **statement list**, not line numbers, and not `runPromise.then(`. A renamed handler or a
  different promise combinator passes by amending the list — the forced decision the issue asks for.

## Critic findings → resolution (all nine accepted; none dismissed)

| # | Severity | Finding | Resolution |
|---|---|---|---|
| 1 | major | a returned thenable can resolve then throw | **D3 / Q2-R1**: excluded by contract (SDK `prompt` is `async`), residual stated, deadline backstop |
| 2 | major | a post-call throw enters `failPreStart` (prunes a live dir, releases a live branch lock) | **D2**: two regimes, boundary = the call, with the "async prompt ⇒ a sync throw means never entered" justification |
| 3 | major | the extra hop is caller-visible (`completed` → `running`; `background-pipeline.ts:568`) | **D4 / Q1-S1**: accepted, with an explicit acceptance criterion, the pipeline consequence named, and a pin (T6) that is red on the baseline |
| 4 | major | the ratchet permits throwing statements and pins only this spelling | **§Tests T1 / Q3-G1**: closed 11-statement allowlist + one-statement regime bodies; 5 named throwing/relocation mutants must go red (M3–M7, verified) |
| 5 | major | the decided async-rejection pin was omitted | **T2** added (stopReason, agent status, one terminal write, deadline cleared under fake timers; falsifier = delete the `clearTimeout`, M1) |
| 6 | major | F1's write count is not a tripwire | **D6 + T5**: the sentinel is gone; the tripwire is the completion transcript line + terminal event; M8 (settle the deferred in the pre-start catch) goes red — verified, and only after the `messages: []` fixture fix |
| 7 | major | sentinel rejection sequenced after two throwing steps; `throw null` breaks normalisation | **D5**: normalised per regime, original throw preserved; no release step exists to skip (D6), so the `finally` demand is satisfied structurally; M9/M10 red |
| 8 | minor | the retention claim is too broad | **D8**: narrowed to collectability of the deferred; the real roots (`agents`, `_sessionRef`) named, measured (E7), and explicitly out of scope |
| 9 | minor | `:2551` vs `:2552` | corrected in §Tests and E9 |

## Risks

- **The D4 status change is real for pipeline callers.** Mitigated by the pin (T6) and by the
  no-consumer measurement (one read of `identity.status`). If a caller is found that branches on it, S1 is
  wrong and S2 (shape (c), ratchet-only) is the fallback — say so before implementing, not after.
- **The window's readability.** The call now sits ~270 lines below the acceptance write (the handler bodies
  did not move; only the call did). A reader must follow `settled.then(onSettled).catch(onSettleFault);`
  before the call. The regime comments and the ratchet are what carry it; the diff itself is +73/−18.
- **Regime 2 is a log-and-continue path** (unreachable with the real SDK). If it is ever reached, the run
  is unmonitored until the deadline — deliberately, because every alternative destroys a live session's
  branch or dir. Do not "improve" it by calling `failPreStart` or by arming a second timer.
- **The tripwire depends on the settle body being able to run** (T2/T5 need `session.messages`), and on
  `failPreStart` staying entry-only. If a future fix makes `failPreStart` write the transcript or emit
  `subagent:failed`, T5 must be re-stated, not deleted — the *count* of terminal classifications is what
  it protects.
- **`err` narrowing** in `onSettleFault` (D5) is mechanical but touches a 150-line body: the implementer
  must not reorder statements while editing it.

## Non-goals

- Not shape (a) (`Promise.resolve().then(() => session.prompt(...))`), not a spawn-queue change, not a
  relocation of #439's containment, not a `background-pipeline.ts` change.
- Not a fix for the pre-start agent-record residue (D8) — separate unit, separate observable.
- Does not reopen #426 / #439 / #447 / #448 / #449 / #453 / #511, the deadline owner, the registry, the
  scratch/`.done` marker, or the containment's getter-backed `agent` read.
- No behaviour change for a successful run **except** D4's status at the caller's resume (decided, pinned).

## Delta budget

| File | Delta | Notes |
|---|---|---|
| `src/session-manager.ts` | **+73 / −18** (measured, §E12) | the diff is dominated by comments (~40 lines); the 150-line handler bodies are untouched (they keep their indentation) |
| `src/__tests__/session-manager.test.ts` | **+279 / −0** (measured) | one `describe` with 6 tests; **no existing test edited** |
| other files | 0 | flow: 0 new files, +6 tests |

## Execution sketch (implementer, in order)

1. **Read** `src/session-manager.ts:2470–2505` and `:2640–2660`; confirm the four anchors
   (`:2472`, `:2474`, `:2490`, `:2501`) still resolve. If any moved, stop and re-derive — do not
   pattern-match on this spec's line numbers.
2. **Replace** the pre-start `try/catch` + `runPromise.then(() => {` header with D1's block: `let runPromise`,
   the two resolver declarations, `const settled`, `const onSettled = (): void => {` — the body that follows
   stays byte-identical.
3. **Replace** `}).catch((err: Error) => {` with `};` + `const onSettleFault = (reason: unknown): void => {`,
   and insert D5's normalisation as the first statement **inside** its `try` (the `clearTimeout` stays
   first, before the `try`).
4. **Replace** the trailing `});` with `};`, then insert D1's THE ATTACH statement, then D2's regime 1
   (with D5's normalisation and the unchanged F1 comment + `failPreStart` + `throw err`), then regime 2
   (log-only), then `return agent;`.
5. **Typecheck**: `npx tsc --noEmit`. Expect no change in diagnostics; the definite-assignment on
   `runPromise` must still hold (regime 1's catch always throws).
6. **Run** `npx vitest run src/__tests__/session-manager.test.ts src/__tests__/background-session-persistence.test.ts`
   → **172 passed** before any test is added (this is the "no behavioural regression in the must-stay-green
   set" gate; if it is not 172, stop — the hop landed somewhere it should not have).
7. **Add** the 6 tests from §Tests verbatim in intent (T1–T6), with the `mocks.session.messages = []` fixture
   in T2/T5. Run the same two files → **178 passed**.
8. **Run each named mutant** (M1–M10, §E10) against a scratch copy and confirm RED. Do not proceed with any
   mutant that stays green — that mutant names a missing assertion, not a redundant test.
9. **Run the full suite** and compare the failing set with the baseline on the same machine
   (`git stash`-free: use a clean checkout/`/tmp` copy for the baseline). Acceptance: **0 new failures**
   (E5 measured 69 pre-existing, path-dependent, identical in both).
10. **Write the PR body** with `## Design assumptions` (see the checklist below) and the D4 decision called
    out explicitly, plus "the status at the caller's resume changed from `completed` to `running` for an
    immediately-resolved prompt — pinned by T6".

### Design assumptions (paste into the PR body)

1. **State created:** one in-memory deferred per spawn (`settled` + two resolver bindings), in the spawn's
   scope; no disk, no env, no registry. Lifetime = the spawn call's scope.
2. **Teardown:** normal paths — the routing settles it; the settle body runs once. Pre-start failure — it is
   left pending and becomes collectable when the scope is released (deadline already cleared by
   `failPreStart`). Crash between create and teardown: nothing on disk changes; the existing deadline/registry
   semantics are untouched.
3. **Concurrency:** one deferred per invocation, single writer (`resolveSettled`/`rejectSettled` called only
   by the regime-2 reaction). No shared state, no lock needed.
4. **Missing/partial/unreadable state:** a non-thenable `prompt()` return → regime 2 logs, the deadline stays
   the bound (fail-closed on monitoring, fail-open on the process: the spawn still returns the agent).
5. **Evidence:** §Evidence E1–E13 — each claim has a command and its observed output; the 69 full-suite
   failures are pre-existing and identical in baseline and impl (`/tmp`, path-dependent).

## Evidence log

Expected signature stated **before** each probe; every search carries its coverage.

| # | Claim | Expected (before) | Command / probe | Observed |
|---|---|---|---|---|
| **E1** | the hop is caller-visible: baseline `completed`, deferred `running` at the caller's resume | `baseline: atResume=completed`, `deferred: atResume=running`, both `afterTick=completed` | `/tmp/brl450-probes/status-hop.mjs` (standalone), then the same shape in the real harness (`probe-status.test.ts` appended to a copy of `session-manager.test.ts`, run in `/tmp/brl450-base` and `/tmp/brl450-impl3`) | standalone: exactly that. Harness: base `PROBE_AT_RESUME=completed / AFTER_TICK=completed`; impl `PROBE_AT_RESUME=running / AFTER_TICK=completed` ✔ |
| **E2** | an abandoned pending promise + handler closures are collectable | `collected: ['closure-payload']` | `node --expose-gc /tmp/brl450-probes/abandon-gc.mjs` (`FinalizationRegistry`, 1 MB payload captured by the handler, 5 forced GCs) | `collected: [ 'closure-payload' ]` ✔ |
| **E3** | the SDK's `prompt` is `async` (basis of D2's boundary and D3's exclusion) | one `async prompt(` hit in the dist, one `Promise<void>` in the d.ts | `rg -n "async prompt\(" node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` → `:1704`; `rg -n "prompt\(" …/agent-session.d.ts` → `:573` `prompt(text: string, options?: PromptOptions): Promise<void>;` | exactly that ✔ |
| **E4** | the design is behaviourally transparent to the existing suite | 172/172 green, no test edited | `npx vitest run src/__tests__/session-manager.test.ts src/__tests__/background-session-persistence.test.ts` in `/tmp/brl450-base` (baseline) and `/tmp/brl450-impl3` | baseline **172 passed**; impl **172 passed** before the new tests, **178 passed** after ✔ |
| **E5** | full suite: zero new failures | same failing set in both; impl = baseline + 6 tests, all passing | `npx vitest run --reporter=json` in `/tmp/brl450-base` and `/tmp/brl450-impl3`, failing names diffed in node; the 6 new tests' statuses checked in the JSON | base `3039 tests / 2969 passed / 69 failed / 31 failed files`; impl `3045 / 2975 / 69 / 31` (= baseline + 6, all 6 green); **only-in-impl: 0, only-in-base: 0**. The 69 are docs/handoff/contract-tracking tests that read repo-relative paths (a `/tmp` artifact; the critic measured the same 69) ✔ |
| **E6** | the 11 must-stay-green anchors | all 11 present; async-rejection title at `:2551`, not `:2552` | `grep -n "<title>"` per title over `src/__tests__/session-manager.test.ts` (8 titles incl. the sections-builder ratchet) and `src/__tests__/background-session-persistence.test.ts` (4 titles) — **12 queries, 12 hits** (11 must-stay-green + 1 ratchet anchor) | 11 titles at the cited lines; the rejection title at **2551** (`2552` = its `mockRejectedValue`), matching critique #9; the sections-builder ratchet at `:303` (`:309` = its `readFileSync`) ✔ |
| **E7** | what the pre-start path roots (D8) | `getAgent` → `running`, `_sessionRef` set, disk record `running`, last run entry `failed` | probe test in `/tmp/brl450-probe2`: sync `prompt()` throw, then read `getAgent`, the persisted record, `lastRunEntry()`, `eventBusMock.emit` calls | `GETAGENT=running`, `SESSIONREF=set`, `DISK_STATUS=running`, `LAST_RUN=failed`, `EVENTS=["subagent:created"]` ✔ |
| **E8** | the D4 pin is red on the baseline | `expected 'completed' to be 'running'` | the new T6 copied into `/tmp/brl450-base` (unpatched source) and run alone | `AssertionError: expected 'completed' to be 'running'` ✔ |
| **E9** | the budget/anchors of the change | +73/−18 src, +279/−0 test, 0 other files | `diff -u` against the repo copy, `awk` counting added/removed lines; `diff -rq src` | as stated; only `src/session-manager.ts` and the one test file differ ✔ |
| **E10** | every named mutant goes red | 10/10 RED | `/tmp/brl450-probes/mutants3.sh` — each mutant patches a fresh copy and runs one selection with `-t` | M1 `1 failed`, M2 `1 failed`, M3 `1 failed`, M4 `1 failed`, M5 `1 failed`, M6 `1 failed`, M7 `1 failed`, M8 `1 failed` (after the T5 `messages: []` fix — before it, M8 passed, which is how the fixture requirement was found), M9 `1 failed`, M10 `1 failed` ✔ |
| **E11** | no in-process AST API (why the ratchet is text-based) | only `tsc.js`/`getExePath`/`version` under `lib/`; `require('typescript/lib/typescript.js')` fails | `ls node_modules/typescript/lib`; `node -e "require('…/typescript/lib/typescript.js')"` | `getExePath.d.ts getExePath.js tsc.js version.cjs version.d.cts`; `MODULE_NOT_FOUND` ✔ |
| **E12** | the change is confined to the intended files | only `src/session-manager.ts` + the one test file in the `/tmp` copy | `diff -rq` repo `src` vs `/tmp/brl450-impl3/src`; `git status --porcelain` in the repo | two files; repo `git status` empty (no repository file modified by this investigation) ✔ |
| **E13** | nothing branches on `identity.status` | exactly one read | `grep -n "identity\.status" src/*.ts src/__tests__/*.ts`; `grep -n "function buildMonitoringDegradedParagraph" -A3 src/notify-completion.ts` | one hit, `src/background-pipeline.ts:995` (the result text); the degraded paragraph takes `Pick<BackgroundAgentIdentity, "id" \| "label">` (`notify-completion.ts:374`) ✔ |
| **E14** | `wrapTask` is pure (argument evaluation cannot throw) | a single `String.replace` | `grep -n "export function wrapTask" -A8 src/prompt.ts` | `:67`, `task.replace(/<\/?task>/g, …)` ✔ |

Mutant definitions (the reviewer can re-run them from §E10's script):

| Mutant | Edit | Must go red |
|---|---|---|
| M1 | delete `onSettleFault`'s `if (deadlineHandle) clearTimeout(deadlineHandle);` | T2 |
| M2 | move `runPromise.then(resolveSettled, rejectSettled);` into regime 1's `try` and delete regime 2 | T3 |
| M3 | move `settled.then(onSettled).catch(onSettleFault);` below the routing | T1 |
| M4 | insert `maybeThrowFromFutureEdit();` before `let runPromise` | T1 |
| M5 | insert it between THE ATTACH and regime 1 | T1 |
| M6 | insert it inside regime 1, before the call | T1 |
| M7 | insert it inside regime 2, before the routing | T1 |
| M8 | add `rejectSettled(err);` after `failPreStart(...)` | T5 |
| M9 | revert regime 1 to `(err as Error).message` | T4 |
| M10 | revert `onSettleFault`'s normalisation to `reason as Error` | T4 |

## Conductor decisions (2026-11-20)

- **Q1 → S1 accepted.** The caller-visible status change is the cycle\x27s one contract change: at the caller\x27s
  resume `agent.status === "running"` for every prompt shape, and `identity.status` is deterministically
  `running`. Pinned by T6 (red on the baseline).
- **Q3 → G1 accepted.** The ratchet is the closed 11-statement allowlist; a legitimate addition to the
  window must edit the list, and that edit is the decision prompt.
- **D8 residue → out of scope, filed as #542** (a pre-start failure leaves the agent record `running` while
  the run entry is `failed`; pre-existing, low). Not a unit in this cycle.

## What this investigation did **not** verify

- **The full suite was not run in the repository** (the brief: probe in `/tmp`). The /tmp comparison
  establishes "zero new failures"; the implementer must run the real gate (`npx vitest run`, plus
  `tsc --noEmit`, `check:imports`, `docs:arch`) on the branch.
- **The pipeline identity capture was not measured end-to-end.** D4's pipeline consequence rests on E1
  (spawn-level, same statement shape) plus a source read (`background-pipeline.ts:549–568`: the identity
  object literal is the first statement after the spawn `await`, no `await` in between) plus T6's ratchet
  assertion. A pipeline-level probe with the real spawn would need the SDK mock harness in a new test file;
  it was judged not worth 100 lines of fixture, and T6 pins the property that matters.
- **The `.done` marker is not used as a tripwire** even though `finalizeRunEntry` writes it: `failPreStart`
  writes it too, so it cannot discriminate a double settle. Stated in D6 instead of implied.
- `armDeadline`'s timer body was read, not re-probed: the #453 behaviour it carries (`if (agent.completedAt)
  return`) is pinned by the existing tests at `:982` / `:1007` and by T3's timeout classification.
- The spawn log statistics (591/591, 0 timeouts) are quoted from the issue, not re-derived here.

## Open questions for the conductor

1. **Q1 / D4** — confirm S1 (accept `running` at the caller's resume) as the cycle's contract change, or
   direct S2 (shape (c): ratchet-only, keep the old timing, and record the reversal of shape (b) on the
   issue). This is the only decision that changes what a *user* sees.
2. **Q3** — confirm G1 (closed statement list) as the ratchet shape, accepting that a legitimate addition to
   the window must edit the list and the test's failure message is the decision prompt.
3. **D8's residue** — should the pre-start path leaving an agent record `running` (while the run entry says
   `failed`) be a follow-up unit in this cycle, or left recorded? It is pre-existing, unpinned, and out of
   this spec's scope; naming it now is cheaper than discovering it in the review.

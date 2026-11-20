# #450 — attach the background settle handlers before the prompt (shape (b)) — spec r3

**Issue:** #450 — hardening. Recorded priority **low** (2026-11-20: bounded consequence, zero observed
incidence) · classifier risk **C1** · `fix: mechanical` · worktree **y** · review **C2 focused**.
**Cycle:** `settle-handlers` (open 2026-11-20) — **U1**.
**Spec r3:** 2026-11-20, against `dev @ 72aa82c` (`src/session-manager.ts` 2,723 lines baseline;
`src/__tests__/session-manager.test.ts` 3,456 lines baseline). No source or test file has moved since
`481b852`: `git log --oneline 481b852..HEAD -- src/ package.json vitest.config.ts` → **0**, and
`git status --porcelain` → empty.
**Provenance:** r2 (this file, preserved at `3beed12`) + the round-2 critique
(`issue-450-plan-critique-r2-2026-11-20.md`, **five findings, all accepted**) + the probes in §Evidence
(E15–E23, all run in `/tmp`). Round 1's nine resolutions are verified resolved and are **not** regressed
(§findings table rows 1–9 unchanged). Locked decisions untouched: **S1** (accept `running` at the caller's
resume), **G1** (closed-list ratchet — its *mechanism* is strengthened, not its decision), **#542**
(D8 residue out of scope).

## r3 changes (r2 → r3)

Targeted patch: five findings, five sections. Everything else in r2 is carried over verbatim.

| # | r2 | r3 | Why (finding) |
|---|---|---|---|
| 1 | "A **synchronous** throw observed here can only come from evaluating the callee, the receiver or the argument … *provably never issued* is therefore true in regime 1" | The proof is **scoped**: it holds for the **unwrapped** SDK method (`AgentSession.prompt`, `agent-session.js:1704`), reached by a plain property read and a side-effect-free argument (`wrapTask` is pure). A getter or non-`async` wrapper that **starts** the real method and then throws is **outside** the contract, is not claimed as proven pre-start, and is a named falsifier. (D2.1, Q2) | critique r2 #1 — the probe starts an async method inside a wrapper, then throws, and prints `live: true` (E15) |
| 2 | Regime 2 logs and continues; "the deadline remains the only bound" | Regime 2 routes through the **intrinsic** (`Promise.prototype.then.call(...)`), so a tampered `then` on a native promise cannot strand a rejection; the supported value is a **native `Promise<void>`**; the residual (a Proxy-wrapped promise, a non-native thenable) is **named at the site** and fails closed to the deadline. (D2.3) | critique r2 #2 — a `then` lookup that throws followed by a rejection exits the host **by default** (not only under `--strict`) (E16) |
| 3 | G1 = closed list of 11 statement **heads at the function's own two-space indentation** | G1′ = a declared, ordered **window list** walked with declared block skips: **any** unaccounted non-blank, non-comment line fails, **at any indentation**; the two settle bodies' first statement is pinned separately. (Q3, T1) | critique r2 #3 — a four-space-indented top-level `if (…) throw …` passed r2's filter (E17) |
| 4 | `String(reason)` normalisation per regime; "`failPreStart` itself is already fault-contained" | Total `normalizeThrown`/`thrownMessage` (`try/catch` around `String` **and** around `instanceof`), plus a `failPreStart` that contains **each** of its three steps — teardown, finalize, registry retire — so the **original throw always wins** and terminal retirement is still attempted; the teardown's own catch sites are normalised too. (D5) | critique r2 #4 — `cleanupWorkBranch` threw a `TypeError` on a git helper's `throw null`, and an unstringable reason was replaced by the conversion error (E18) |
| 5 | T5 tripwire = completion transcript line + terminal event (visible **only if** the settle body reaches its writes) | T5 gains a **body-entry** observable: on the sync-throw path exactly **one** `clearTimeout` may run (`failPreStart`'s), and T1 pins each settle body's **first** statement to be its `clearTimeout` — so any body entry is visible even if it throws before its writes. (D6, T5) | critique r2 #5 — M8 + a fault body dying before its writes passed r2's T5 (E19) |

The five fixes touch five regions (`D2`, `D3`/`Q2`, `Q3`/`T1`, `D5`, `T5`) and also `Acceptance`,
`Tests`, `Mutants`, `Risks`, `Delta`, the execution sketch and the design assumptions. **No** locked
decision is reopened: the deferred, the attach-before-call ordering, the two-regime split, the
no-settle-in-the-pre-start-catch rule (D6) and the status decision all stand.

## Context (verified 2026-11-20)

| Anchor | Line (baseline) | What it is |
|---|---|---|
| `agent._sessionRef = session;` | `:1988` | the live-session ref (D8 roots) |
| `deadlineHandle = armDeadline(...)` | `:2462` | the one deadline owner (#453), armed **before** the prompt |
| `run.acceptedAt = new Date().toISOString()` | `:2472` | the durable acceptance marker (#447) |
| `persistRunRecord(pi, run, "background")` | `:2474` | the acceptance write (throw → `failPreStart` → rethrow) |
| `runPromise = session.prompt(wrapTask(params.task))` | `:2490` | the one call whose return must be monitored — the only `prompt(` **call** in `src/` (E3 coverage: 9 hits, 8 comments + this call) |
| `runPromise.then(() => {` | `:2501` | the settle handlers, attached **after** the call returns (the defect) |
| `}).catch((err: Error) => {` | `:2651` | the rejection settle |
| `const failPreStart = (message: string)` | `:1942` | deadline clear → branch teardown → entry finalize → registry retire |
| `const markTerminalBestEffort` | `:2283` | the settle-handler catch-all |
| `agents.set(id, agent);` | `:1576` | the pre-prompt record write (the pre-start retention root) |
| `gitCleanupDone` guard in `cleanupWorkBranch` | `:1841` | once-per-run teardown |
| `armDeadline`'s timer body | `:2350–2440` | `if (agent.completedAt) return`, abort, `prune: false` snapshot |
| `clearTimeout(deadlineHandle)` | `:1943`, `:2502`, `:2652` | the **only three** sites in the file (E20) — the basis of T5's body-entry count |

Line numbers are the **baseline's**. The r3 implementation adds lines above the window
(`normalizeThrown` at `:108`, the contained `failPreStart` at `:1970`), so the implementer must re-derive
every anchor with the step-1 grep rather than trust these numbers (execution sketch, step 1).

## The defect, restated precisely

Two failure classes sit in a 9-line span (`:2482–:2503`), not one:

1. **A throwing statement between `prompt()` returning and `.then` attaching.** The settle is lost; the
   pre-armed deadline (#453) replaces the outcome with a `timeout` classification, `cleanupWorkBranch`
   never runs, and the work-branch lock plus the session dir are held until process exit. Only a code
   edit can introduce it.
2. **A throw *after* the routing attach but inside the same `try`** (r1's own shape, critique r1 #2). The
   throw reaches `failPreStart`, which declares "the prompt was never issued" and prunes a **live**
   session's directory and releases its branch lock while the session may still be writing — strictly
   worse than the class it was meant to prevent.

Class 2 is a defect r1 *introduced*. That is why r2 splits the region instead of widening the `try`.

**Why the issue is still C1/low (claim narrowed in r3).** 591/591 background spawns settled, 0 background
timeouts. With the real SDK — `prompt` is `async` (E3) and is called **unwrapped** at the one call site
(E3 coverage) — a synchronous throw means the callee was never entered, so class 1 needs a new statement
in a hot region. r3 does **not** generalise that to "any synchronous throw proves nothing started": a
wrapper or getter that starts work and then throws breaks the proof, and is excluded by contract, not
absorbed (D2.1). This spec closes class 1 structurally, removes class 2, pins both, and closes the
routing fault the critique found in r2's regime 2.

## Design

### D1 — The deferred, and THE ATTACH, before the call (shape (b)) — unchanged in r3

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

  const onSettled = (): void => {
    if (deadlineHandle) clearTimeout(deadlineHandle);   // D7 + T5's entry observable
    try {
      /* — the existing :2502 body, unchanged — */
    } catch (err) { /* existing catch-all; its log line uses thrownMessage (D5) */ }
  };

  const onSettleFault = (reason: unknown): void => {
    if (deadlineHandle) clearTimeout(deadlineHandle);   // D7 + T5's entry observable
    try {
      const err = normalizeThrown(reason);              // D5: TOTAL, never throws
      /* — the existing :2651 body, unchanged except the `err` binding — */
    } catch (err) { /* existing catch-all; its log line uses thrownMessage (D5) */ }
  };

  // THE ATTACH
  settled.then(onSettled).catch(onSettleFault);
```

Named handlers rather than `.then(() => { … })` are not cosmetic: they keep the ~150-line bodies at their
current indentation (a `.then(() => {` wrapper would re-indent every line and produce a
whitespace-only 300-line diff), and they reduce the invariant to one checkable statement — *the attach
line exists, and it is above the call*. Both bodies' **first statement is the deadline `clearTimeout`**,
which r3 makes load-bearing: it is T5's body-entry observable and is pinned by T1 (§Tests).

**Chosen over shape (a)** (`Promise.resolve().then(() => session.prompt(…))`), which empties the window but
changes spawn-queue interleaving (`resolveNext()` would run before the prompt), loses the synchronous
acceptance and turns a pre-start rejection into an async terminal event. Decision already recorded on the
issue; not reopened.

### D2 — The catch boundary: two regimes, separated by syntax, not a flag (critique r1 #2; narrowed by r2 #1)

`failPreStart` is only *true* when nothing started. The boundary is therefore the prompt **call**, and the
code says so with two adjacent `try` statements:

```ts
  // ---- REGIME 1: pre-start ------------------------------------------------
  try {
    runPromise = session.prompt(wrapTask(params.task));
  } catch (err) {
    const reason = thrownMessage(err);                          // D5: total
    failPreStart(sanitizeErrorMessage(reason, effectiveCwd));    // D5: contained, never throws
    throw err;                                                  // D6: deferred NOT settled
  }

  // ---- REGIME 2: post-start ----------------------------------------------
  try {
    void Promise.prototype.then.call(runPromise, resolveSettled, rejectSettled);   // D2.3
  } catch (err) {
    log.error(
      `spawnBackgroundSession: settle routing failed for ${id} — the run is unmonitored; its deadline remains the only bound`,
      { error: thrownMessage(err) },
    );
  }
```

#### D2.1 — What "provably never issued" proves, and what it does not (critique r2 #1)

The claim r2 made was too wide. r3 states it as a **contract on the call shape**:

> **D2.1 (never-issued proof).** A synchronous throw out of
> `runPromise = session.prompt(wrapTask(params.task))` is proof that the prompt was never issued **iff**
> (a) the callee is the SDK's own `async` method `AgentSession.prompt`
> (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1704`, typed
> `prompt(text): Promise<void>`, `agent-session.d.ts:573`), (b) it is reached by a plain property read on
> the session object (no getter/Proxy in between), and (c) the argument is evaluated without side effects
> (`wrapTask` is one `String.replace`, `src/prompt.ts:67`).

Each clause is load-bearing:

- **(a) `async`.** An `async` function cannot throw to its caller; a throw inside it becomes a rejection.
  So a synchronous throw can only have happened *before* entry.
- **(b) plain read.** A **getter** can start the real method and then throw — the caller sees a synchronous
  throw while the session is already running. r3's probe does exactly this and prints `live: true`
  (E15: `syncThrow=yes`, `live=true`, `settledLate=resolved`). *That shape is outside the contract*: it
  must not be claimed as proven pre-start.
- **(c) pure argument.** If argument evaluation could start work, the same hole reopens. It cannot today
  (E14, re-measured: `wrapTask` is `task.replace(/<\/?task>/g, …)`).

**Consequence for the code.** Regime 1's catch still calls `failPreStart` — the *only* site where pruning
is safe — but the justification is the contract above, and it is written at the site as such. A future
edit that wraps `session.prompt` (a retry wrapper, a decorator, an injected session double that starts
work) **voids** the proof; it must be treated as a post-start fault (regime-2 semantics), not silently
absorbed. `failPreStart`'s doc comment keeps its "PRUNING IS PROVABLY SAFE HERE — and only here" sentence
and gains the three clauses.

**Falsifier (used, E15):** a wrapper that starts `prompt` and then throws. If a wrapper ever enters this
call site, D2.1 must be re-derived *before* `failPreStart` is kept. The probe is in §Evidence (E15); the
corresponding §Mutants row (**C1**) is deliberately **not** a source mutant — it changes the *contract*, not
the code, and the test suite cannot see it.

#### D2.2 — What regime 2 does and does not do

- Does **not** call `failPreStart`: no never-issued message, no dir prune, no branch release while the
  session may write.
- Does **not** clear the deadline and does **not** arm a second bound: ADR 0023 decision 1 keeps one
  owner. The already-armed deadline is the monitor of last resort — it aborts, then writes the
  `timeout`/`aborted` snapshot with `prune: false`, so a still-writing session keeps its dir and its
  branch.
- Does **not** reject the spawn: the run started; the caller must not receive
  "Failed to spawn background agent" (the #439 boundary). The spawn resolves with the agent, `running`.
- **Is unreachable for the supported value**: for a native `Promise<void>` — everything an `async`
  method can return — the routing is `Promise.prototype.then` itself (E22: `p.then ===
  Promise.prototype.then` → `true`) and cannot throw. The catch exists for **unsupported** values and for
  a future edit, and D2.3 says exactly what it buys there.

#### D2.3 — The routing fault: containment for the supported value, a named residual beyond it (critique r2 #2)

r2's regime 2 was "log and continue" and called the deadline "the only bound". The critique showed that
is not a bound **for the process**: if the `then` **lookup** throws, no rejection handler is ever attached,
and a later rejection of that native promise is an *unhandled rejection*, which terminates `node` — under
`--unhandled-rejections=strict` **and under the default mode** (E16: both exits are `1`; the default
mode's `throw` behaviour is enough, so the residual is not a flag-only curiosity).

r3 therefore routes through the intrinsic:

```ts
void Promise.prototype.then.call(runPromise, resolveSettled, rejectSettled);
```

What each value class does (all measured, E16/E22):

| Returned value | `.then`-by-property (r2) | intrinsic routing (r3) |
|---|---|---|
| native `Promise<void>` (the supported value; what `async` returns) | same function, handler attaches | identical: `p.then === Promise.prototype.then`, **no extra microtask** (E22: both reactions run in the same tick) |
| native promise with an **own `then` accessor that throws** (the critic's reproduction; a `Proxy` is the row below) | lookup throws → **no handler** → later rejection kills the host (exit 1) | the accessor is **never read**; the handler attaches; probe prints `tampered:catch=clean`, the rejection is delivered, process **survives** (exit 0) |
| a `Promise` **subclass** instance with an overridden `then` | override called (or throws) | the internal slot is used; attains correctly (`sub settled: sub rejection`) |
| non-thenable (`{}`, `42`, `undefined`) | `TypeError` → caught → logged | `TypeError` → caught → logged (T3 unchanged: spawn resolves, run stays `running`, the deadline classifies `timeout`) |
| non-native thenable (custom `then`) | the value's `then` is called (handled **by accident**) | `TypeError` → caught → logged: **out of contract**, fails closed to the deadline |
| `Proxy` wrapping a native promise | the proxy's `then` (if not trapped) runs → may attach | `TypeError: Method Promise.prototype.then called on incompatible receiver` → caught → logged; the **underlying rejection stays unowned** → **process residual** (exit 1, measured) |

**The contract, stated at the site:**

> The settle bodies are reachable only for a value the intrinsic accepts — in practice a native
> `Promise<void>`, the only thing `session.prompt` returns. Any other value throws synchronously at the
> routing, before any handler exists: the run is out of contract and the deadline is its only bound. For a
> **Proxy-wrapped** promise the underlying rejection is still unowned and the host's unhandled-rejection
> policy applies — that is the residual, and it is not fixable from here (nothing can attach a handler to a
> promise it cannot reach).

**Why not contain the Proxy case too:** any containment would have to *own* the value, i.e. route through
`Promise.resolve(runPromise)`/`Promise.race([runPromise])`. Both **assimilate thenables**, which changes
the non-thenable contract that T3 exists to pin: `Promise.resolve({})` **resolves**, so a non-thenable
return would run the *success* body and record a live run as `completed` — a mis-report strictly worse
than the log. And `Promise.resolve(nativePromise)` is the identity, so it buys nothing for the native case
that the intrinsic does not already give. Rejected on that evidence (Q2, row R3).

**Falsifier (used, E16):** a `then` lookup that throws followed by a rejection must not take the process
down for a *supported* value — the probe shows exit `0` after the fix and exit `1` before it. If a future
edit re-spells the routing as `runPromise.then(…)`, T3's tampered case goes red (M13, measured).

### D3 — The return contract: `Promise<void>` only; everything else fails closed (critique r1 #1, re-stated by r2 #2)

**Contract:** `session.prompt(text)` is `async` and returns a native `Promise<void>`. The design relies on
that and nothing weaker:

- the deferred is settled **only** by the regime-2 routing reaction, i.e. only after the call returned
  normally — so a throw from the call itself can never race a settlement (this is what makes D6 possible);
- the routing accepts **only** a value the intrinsic `Promise.prototype.then` accepts. A non-thenable or a
  custom thenable throws synchronously (caught, logged) and the run is left to the deadline — the
  **supported path is reachable only with a native `Promise<void>`**, by construction rather than by hope
  (D2.3, E16);
- a **hostile thenable** that calls `resolveSettled()` synchronously inside `then()` and *then* throws is
  **outside** the contract and is now also **outside the routing** (the intrinsic refuses it, so its
  `then` is never called). Its worst case under r2 — the success body running for a possibly-live run —
  is no longer reachable through the routing at all.

**Why not design for thenables** (Q2 row R2): the only way to be correct for them is a settle-once latch
plus the r1 sentinel plus a post-`failPreStart` guard — three mechanisms for a value the SDK cannot return,
each of which then needs its own tripwire, and the tripwire is precisely what failed in r1 (critique r1
#6). r3 instead *rejects* them at one line, and names the residual class (Proxy) that cannot be rejected.

**Falsifier:** the installed SDK's `prompt` signature/implementation stops being `async`/`Promise<void>`,
**or** a call site passes a wrapped/non-native value (which voids D2.1 as well as D3). Either reopens Q2
with R2.

### D4 — The caller-visible status: accept `running` at the caller's resume (critique r1 #3) — unchanged in r3

The deferral costs exactly one microtask hop, and the hop is **caller-visible** (r1 called it "measured
harmless" — measured at the test level, not at the caller level):

| | `await spawnBackgroundSession(...)`, immediately-resolved prompt |
|---|---|
| baseline (attach on `runPromise`) | the caller resumes with `agent.status === 'completed'` |
| shape (b) (attach on the deferred) | the caller resumes with `agent.status === 'running'`; `completed` one tick later |

Measured twice: a standalone probe and the real harness (§Evidence E1, E8). r3 does not change the hop
count: the intrinsic routing is the same function for a native promise (E22), and T6 (which asserts
`running` at resume **and** `completed` one tick later) is green in r3 (E21).

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
`buildMonitoringDegradedParagraph` takes only `id`/`label` (§Evidence E13). The run's real outcome is
unchanged (same terminal record, same event, same wake).

**Test-only changes:** none in the existing 172 tests — measured, not assumed (§Evidence E4, re-measured in
r3 at E21). The decision is pinned by one **new** test that also pins the pipeline capture point (no
`await` between the spawn and `status: agent.status`), because that is the statement whose position makes
the snapshot deterministic. That test is red on the baseline (`completed` vs `running`, §Evidence E8).

Options and falsifiers for this decision: **Q1**.

### D5 — Non-`Error` throws: total normalisation, and a pre-start catch that cannot mask (critique r1 #7, r2 #4)

`prompt()`'s rejection value and a synchronous throw are both `unknown` by contract. r2 said "normalise
with `String`". The critique shows two holes:

1. **`String(reason)` itself throws** (`Symbol.toPrimitive`/`toString` that throws, a Proxy), and
   `reason instanceof Error` throws for a Proxy whose `getPrototypeOf` trap throws — a normaliser that is
   not total *replaces* the failure it describes (E18, test "preserves original unstringable reason":
   pre-fix the caller received `Error: conversion failed`, not its own object).
2. **`failPreStart` is not fault-contained.** Its first step is `cleanupWorkBranch()`, and the teardown's
   own catch blocks logged `(err as Error).message` — so a git helper rejecting with `null` made the
   *teardown* throw a `TypeError`, `failPreStart` never reached `finalizeRunEntry`, and the caller got
   `Cannot read properties of null` instead of its prompt error (E18, pre-fix).

r3 fixes both layers:

```ts
// module level, total for EVERY value (a Proxy, a hostile toPrimitive, null, undefined)
function normalizeThrown(thrown: unknown): Error {
  try {
    return thrown instanceof Error ? thrown : new Error(String(thrown));
  } catch {
    return new Error('unprintable thrown value');     // never a second throw
  }
}
function thrownMessage(thrown: unknown): string {
  try {
    return normalizeThrown(thrown).message;
  } catch {
    return 'unprintable thrown value';                // an Error-shaped Proxy whose .message throws
  }
}
```

```ts
const failPreStart = (message: string): void => {
  if (deadlineHandle) clearTimeout(deadlineHandle);
  // EVERY step is contained: a throw here would replace the original spawn failure at
  // all four call sites (they all do `failPreStart(...); throw err`).
  try {
    cleanupWorkBranch();
  } catch (err) {
    log.error(`spawnBackgroundSession: work-branch teardown failed for ${id} — the original spawn failure is preserved`,
      { error: thrownMessage(err) });
  }
  try {
    finalizeRunEntry('failed', message);              // terminal retirement is still ATTEMPTED
  } catch (err) {
    log.warn(`spawnBackgroundSession: pre-start finalize failed for ${id}`, { error: thrownMessage(err) });
  }
  try {
    clearInflightRun(id);
  } catch (err) {
    log.warn(`spawnBackgroundSession: pre-start registry retire failed for ${id}`, { error: thrownMessage(err) });
  }
};
```

Normalisation sites, and why each: the pre-start message (`thrownMessage(err)` in regime 1), the
never-issued stamp (`neverIssued`), the fault body's binding (`normalizeThrown(reason)`), the four
`cleanupWorkBranch` catch sites (`getCurrentBranch`, `captureDiff`, `restoreHead`, `deleteBranch`), the
branch-setup refusal (its `sanitizeErrorMessage((err as Error).message, …)` masked a non-Error git fault
before the refusal was even built), and both settle-body catch-alls' log lines. **Measured coverage:**
`grep -c "as Error).message" src/session-manager.ts` goes **12 → 5**, of which one is a comment; the four
remaining code sites (`:1235` `stopAgent`, `:1281` `steerAgent`, `:2456`/`:2477` the deadline timer body)
are **out of this unit's scope** and flagged in §Risks — they are the same class but belong to other
boundaries (#453's timer body, the steer/stop helpers).

- The original throw is preserved (`throw err`, not a re-wrapped error) — `throw null` still rejects the
  spawn with `null`; an unprintable object still rejects with **that object** (`rejects.toBe`, T4 case 4).
- The rejection body keeps its old identifier (`err`) so its ~40 lines are untouched; the value is narrowed
  once, before any `.message` use.
- **No `finally` is needed for the deferred** (critique r1 #7 asked for one because r1 released the
  deferred *after* `failPreStart`): under D6 the pre-start catch never touches the deferred, so no fault in
  `failPreStart` can skip a release. The `finally` requirement is satisfied structurally.

**Falsifiers (both used, E18):** (i) a git cleanup that rejects with `null` must not change the error the
caller receives, and the terminal entry must still be written — T4 case 3, pre-fix red
(`Cannot read properties of null`), post-fix green; (ii) an unstringable thrown object must arrive as
itself — T4 case 4, pre-fix red (`Error: conversion failed`), post-fix green. Mutants M9/M10 keep the
*normalisation* red-if-regressed.

**Honest limit (measured, not hidden):** with the teardown's own catch sites normalised, the
`failPreStart` containment is **defence in depth** — the critic's git fault is absorbed inside
`cleanupWorkBranch` before it can reach `failPreStart`, so there is **no behavioural mutant** that kills
only the containment (all teardown throw sites the harness can reach are now total). It is kept because
the containment is what makes "never mask the original" true *independently* of every future teardown
edit; a reviewer who wants it gone must show that no step of `failPreStart` can throw.

### D6 — The pre-start catch does **not** settle the deferred (replaces r1's sentinel) (critique r1 #6, #8) — unchanged in r3

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

**The sentinel's replacement, strengthened in r3 (critique r2 #5).** T5 asserts side effects only a settle
body produces **and** a direct body-entry observable, because a fault body can throw *before* those side
effects:

- the completion transcript line and the terminal event (`failPreStart` produces neither), **plus**
- the **exact `clearTimeout` count**: on the sync-throw path only `failPreStart`'s clear may run, and each
  settle body's **first** statement is its `clearTimeout` (D1, pinned by T1), so **any** body entry makes
  the count `2` — even a body that throws on its next line. Measured: green = `1`, M12 (body enters, dies
  before its writes) = `2` (E19).

### D7 — Deadline interaction (unchanged owner, one new path that must not claim it)

- The deadline is armed at `:2462`, before the acceptance write and before the deferred — **unchanged**.
- **Regime 1's catch** clears it via `failPreStart` (`:1943`); r1 was right that no new `clearTimeout` is
  needed, and r2/r3 keep that (the timer count assertion in #448's test at `:1007` still passes).
- **`onSettleFault`** keeps its existing `clearTimeout` as its first statement (now with the D5
  normalisation immediately after, inside the `try`). This is the falsifier target of T2 (mutant M1) **and**
  T5's body-entry observable (r2 #5).
- **The success body** keeps its `clearTimeout` as its first statement (`:2502` → unchanged), the second
  half of T5's observable.
- **Regime 2's catch does NOT touch the deadline.** It is the monitor of last resort for an unmonitored
  run, and ADR 0023 decision 1 forbids a second bound. The `timeout`/`prune: false` snapshot it produces
  is what keeps a still-writing session's dir and branch.

### D8 — What the pre-start path actually retains (claim narrowed) (critique r1 #8) — unchanged in r3

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
`agents` and `_sessionRef`, independently of the deferred. r2/r3 therefore claim **only** collectability of
the deferred, and state the agent-record/`_sessionRef` retention as a **pre-existing** property of the
pre-start path (the same shape #460 §4.4 recorded for `failPreStart`: it stops at the run entry).

**Out of scope, flagged not fixed** (surgical boundary): a pre-start failure leaves an agent record
`running` while its run entry says `failed` — filed as **#542**, not this cycle (§Conductor decisions).

## Open questions — options, recommendation, falsifiers

### Q1 — The caller-visible status (D4) — unchanged, decided

| Option | Mechanism | Blast radius | Cost | Risk if wrong |
|---|---|---|---|---|
| **S1 — accept (decided, r2 + r3)** | keep the deferral; document that the spawn reports `running` at the caller's resume and pin it (T6) + pin that the pipeline capture has no `await` between spawn and snapshot | one caller-visible value changes for an immediately-resolved prompt: `completed` → `running`; the spawn result text reads `Status: running`; the terminal record, event and wake are unchanged | 1 test; **0** changes to the 172 existing tests (measured, E21) | a caller that inferred "already finished" from the spawn result loses that inference — it still gets the completion event and `get_subagent_result`; the run's outcome is untouched |
| S2 — preserve the old timing (shape (c)) | drop the deferral: keep the handlers attached directly to `prompt()`'s promise (today's shape), add the *policy* pin only (ratchet), keep the pre-arm | zero timing change; **the structural guarantee is gone** — the window stays one statement wide and is protected only by a source ratchet | smaller src delta (~+10 lines); the ratchet carries the whole guarantee | a rewrite that satisfies the ratchet's spelling but throws at runtime loses the settle again; also reverses the shape (b) decision recorded on the issue → conductor sign-off required |
| S0 — do nothing | — | none | none | the defect stays and no test goes red when a future edit re-opens it |

**Decided: S1** (conductor, 2026-11-20). r3 adds no new option here and re-measures the pin (E21, T6
green; E8, red on the baseline).

### Q2 — The return contract for `prompt()` (D2.3, D3) — **re-opened and re-decided in r3**

| Option | Mechanism | Blast radius | Cost | Risk if wrong |
|---|---|---|---|---|
| **R1′ — intrinsic routing (recommended, r3)** | `Promise.prototype.then.call(runPromise, …)`: the value's own `then` is never read; the supported (`Promise<void>`) path is byte-equivalent; a tampered accessor cannot strand a rejection; unsupported values throw synchronously → log → deadline | one statement + comment in regime 2; no timing change for native promises (E22); a custom thenable that r2 would have routed now fails closed to the deadline (intended, D3) | 1 line; 0 hops; T3 gains one case | if some real session returns a non-native thenable, that run becomes deadline-monitored instead of routed — measured: **no** such fixture in the suite (E20: 99 `session.prompt.mock*` assignments, 0 custom thenables), and the SDK's `prompt` is `async` |
| R1 — state the contract, keep `.then` (r2's shape, critique-acceptable minimum) | keep `runPromise.then(…)`; write "the supported value is a native `Promise<void>`; a routing fault is out of contract and the process residual is the host's unhandled-rejection policy" at the site | 0 production lines beyond the comment; the critic's reproduction still exits the host (E16 pre-fix side) | 0 | a tampered/accessor `then` on a native promise is **containable for free** and left uncontained; the residual is real where it need not be |
| R3 — contain everything (`Promise.resolve` / `Promise.race`) | own the value before routing | every prompt shape | 1 line + T3 rewrite | **rejected on evidence**: assimilation turns a non-thenable into a *resolution*, so `{}` would run the success body and record a live run `completed` — it breaks T3's contract (E16/R3 probe) |
| R2 — design for thenables | settle-once latch + sentinel + post-`failPreStart` guard; new tests for resolve-then-throw | every settle path gains a guard; two extra states | ~+25 src lines, +2 tests, and the r1 sentinel's unprovable tripwire problem returns | the guards are unreachable in production, so their removal is unobserved; more surface for class-2 misclassification |
| R0 — r1 | r1 kept the "handles malformed returns" claim without a mechanism | — | — | reproduced by the critique: `failPreStart` writes, then the success body writes |

**Recommendation: R1′.** It is the minimal change that makes the supported path *provably* unable to strand
a rejection, and it costs zero hops. **Falsifiers:** (a) a real (non-test) session whose `prompt` returns a
non-native thenable — then the run silently loses its routing and R1 (state-only) or R2 becomes the
choice; (b) the SDK's `prompt` ceasing to be `async`/`Promise<void>` (also voids D2.1).

### Q3 — The shape of the ordering ratchet (critique r1 #4; mechanism fixed by critique r2 #3)

| Option | Mechanism | Blast radius | Cost | Risk if wrong |
|---|---|---|---|---|
| **G1′ — closed window list, indentation-agnostic (recommended, r3)** | slice the window (`:2472` → the routing); walk its lines: every non-blank, non-comment line must be the **next declared entry** — its exact text, at **any** indentation — or lie inside an entry's declared block (`try { … }`, `new Promise(… => { … })`, the two handler declarations); blocks are skipped to their declared closer at the window's own indent; then two body regexes (one statement per regime) and the two settle-body first statements | test-only; couples the test to the region's statement *text*, not its indentation or line numbers | ~95 test lines; any legitimate addition edits the list (a decision, by design) | a benign restructure goes red (annoyance); a statement hidden **inside** a declared block (a handler body, a catch body) is out of the ratchet's scope — stated, and covered behaviourally where it matters (M8/M12 by T5, M6/M7 by the body regexes) |
| G1 — r2's list of statement heads at two-space indent | no bracket logic; indentation is the continuation signal | test-only | ~60 lines | **proven insufficient**: a four-space top-level `if (…) throw …` passed it (E17: r2 scan green, r3 scan red on the *same* mutant source) |
| G2 — marker order + "no await" (r1) | `indexOf` ordering + `await` absence + same-`try` | test-only | ~20 lines | **proven insufficient**: a probe with two throwing sites returned `{order:true, noAwait:true, sameTry:true, containsThrowSites:2}` (critique r1 #4) |
| G0 — no ratchet | review only | — | 0 | the ordering property the issue keeps in scope stays unpinned |

**Recommendation: G1′** (the conductor's G1 decision stands; the mechanism is what changes). It goes red
for a **throwing statement at any indentation**, which is the fault class this window has; it does not pin
line numbers; an equivalent implementation passes by amending the list, which is the recorded decision the
issue asks for. **Falsifiers:** a legitimate statement added to the window that the list cannot express
without losing the property — then the entry gains a per-row "cannot throw" annotation rather than the
ratchet being dropped. Named mutants that **must** go red: M3–M7 and **M11** (§Mutants, 13/13 measured).

## Acceptance criteria

Each is a claim an implementer can check; `T*`/`M*` are the tests and mutants in §Tests / §Mutants.

1. **The attach precedes the call.** `settled.then(onSettled).catch(onSettleFault);` is a single statement
   above `session.prompt(`, and the window between the acceptance write and the routing is the closed
   11-entry list. (T1; M3 → red, measured.)
2. **No statement can be inserted on either side of the call, at any indentation**: before the deferred
   (M4), between the attach and the call (M5), inside regime 1 (M6), inside regime 2 (M7), and a
   **four-space-indented top-level statement** after the attach (M11 — the mutant r2's scan missed). (T1;
   all five measured red.)
3. **A synchronous `prompt()` throw stays pre-start** and classifies **once**: one terminal run entry
   (`failed`, the original message), deadline cleared, branch torn down, registry retired, **no settle body
   side effects** (no completion transcript line, no terminal event) **and no settle body entered at all**
   (exactly one `clearTimeout` on the path). (F1 test unchanged + T5; M8 and M12 → red, measured.)
4. **A throw after the call is post-start**: `failPreStart` is not called (no never-issued message, no
   prune), the spawn resolves, and the deadline remains the bound and classifies the run `timeout`. (T3;
   M2 → red, measured.)
5. **An async rejection routes through the deferred**: `agent.status === 'failed'`,
   `result.stopReason === 'error'`, run entry `stopReason: "error"`, exactly one terminal write,
   `subagent:failed` emitted, and the deadline cleared (fake timers: 1 → 0). (T2; M1 → red, measured.)
6. **Non-`Error` values work on both regimes**: `throw null` → `errorMessage: "null"` + original rethrow;
   `reject(undefined)` → `errorMessage: "undefined"`. (T4 cases 1–2; M9, M10 → red, measured.)
7. **A cleanup fault cannot mask the original throw, and normalisation is total**: a git teardown that
   throws `null` still rejects the spawn with the prompt error **and** writes the terminal entry; an
   unstringable thrown object rejects with **that object**. (T4 cases 3–4; pre-fix red — the two critic
   probes — post-fix green, E18.)
8. **The routing fault is contained for the supported value**: a native `Promise<void>` whose own `then`
   accessor throws is still routed, so its rejection is handled and cannot become an unhandled rejection;
   an unsupported value (non-thenable/thenable/Proxy) throws at the routing, is logged, and leaves the run
   to the deadline — with the Proxy residual named at the site. (T3 case 2; M13 → red, measured; the
   process-level probe is E16.)
9. **The never-issued proof is scoped**: the call site passes the **unwrapped** SDK method and a pure
   argument; a wrapper that starts work then throws is *out of contract* and is not claimed as pre-start.
   (E15 + the D2.1 contract; no source mutant — the probe is the falsifier, §Mutants row C1.)
10. **The successful path is unchanged** except the status hop: `done` entry, branch capture, transcript
    `completed`, one terminal write, `completed` one tick after the caller's resume. (Existing suite + T6.)
11. **The caller-visible status is pinned** (`running` at resume, pipeline capture deterministic). (T6; red
    on the baseline — E8.)
12. **Full suite**: zero new failures against the baseline. (E21: 3045 / 2975 passed / 69 failed / 31
    failed files — identical to r2's measurement; the 69 are pre-existing, path-dependent.)

## Tests

### New — 6, in `src/__tests__/session-manager.test.ts`, one `describe("#450 settle handlers attach before the prompt")`

| ID | Test (title as it must appear) | Asserts | Mutants it kills |
|---|---|---|---|
| **T1** | `pins the window's statement list: handlers attached before prompt(), one statement per regime (#450 ratchet)` | the **closed 11-entry window list** walked line by line — an unaccounted non-blank, non-comment line fails **at any indentation**; declared blocks are skipped to their declared closer; both regime bodies are exactly one statement (regexes); each settle body's **first** statement is `if (deadlineHandle) clearTimeout(deadlineHandle);`; the attach precedes `session.prompt(` | M3, M4, M5, M6, M7, **M11** (all measured red) |
| **T2** | `routes an async rejection through the deferred, clears the deadline and writes ONE terminal record (#450 async-rejection pin)` | `stopReason: "error"`, `agent.status === "failed"`, one terminal write, `subagent:failed`, fake-timer count 1 → 0, and no abort after advancing 2× the budget; `mocks.session.messages = []` | M1 (delete `onSettleFault`'s `clearTimeout`) |
| **T3** | `treats a returned non-thenable as a POST-start fault, never 'never issued' (#450)` | **(1)** non-thenable: spawn resolves with `running`; the run entry stays `running` (no `failPreStart`); `settle routing failed` logged; advancing the budget yields `errorCategory: "timeout"` and exactly one abort. **(2)** the routing-fault contract: a native deferred whose own `then` accessor throws is still routed — its rejection yields `failed` + `errorMessage` containing the rejection text with **no** timer advance (a routing fault would leave it `running`), and no unhandled rejection escapes | M2 (merge the regimes), **M13** (revert to `runPromise.then(…)`) |
| **T4** | `normalises a non-Error value on BOTH regimes and rethrows the original throw (#450)` | (1) `throw null` → `.rejects.toBeNull()`, one terminal entry, `errorMessage: "null"`; (2) `reject(undefined)` → `failed`, `errorMessage: "undefined"`; (3) a git teardown throwing `null` → `.rejects.toThrow("original prompt")`, **3** run writes, terminal `failed` with the original message, `getCurrentBranch failed during cleanup` logged; (4) an unprintable thrown object → `.rejects.toBe(theObject)`, 3 writes, `errorMessage` = `unprintable thrown value` | M9, M10 |
| **T5** | `classifies a synchronous prompt throw ONCE — no settle body runs (#450 sentinel tripwire)` | no `Transcript completed:` line, no `subagent:failed`, still exactly 3 run writes, terminal `failed`, **and `clearTimeout` called exactly once** (failPreStart's) — the body-entry observable; `mocks.session.messages = []` | M8 (`rejectSettled(err)` in the pre-start catch), **M12** (M8 + a fault body that dies before its writes — r2's T5 passed this, E19) |
| **T6** | ``the caller observes `running` at its resume even when the prompt resolves immediately (#450 D4 decision)`` | `agent.status === "running"` at resume; no `await` between the pipeline's spawn await and `status: agent.status`; `completed` after one tick | red on the **baseline** (E8); this is the D4 pin, not a mutant |

**Fixture requirements discovered empirically (do not omit):**

- T2 and T5 must set `mocks.session.messages = []`. With an unreadable session projection the settle body
  throws at `captureAndReleaseSession`, the catch-all (`markTerminalBestEffort`) contains it, and the
  terminal **event/transcript** the tests look for never appears — the tripwire would pass for the wrong
  reason. (This is why r2 found it; r3 keeps it.)
- T3's tampered-`then` case **cannot** use a `vi.fn()`: vitest's own mock instrumentation reads `.then`
  off a returned promise (`spy.js`: `if (returnValue instanceof Promise) returnValue.then(…)`), so the
  accessor would explode inside the harness. It injects a session whose `prompt` is a **plain function**
  (`mocks.createAgentSession.mockImplementationOnce(async () => ({ session: { ...mocks.session, prompt: () => tampered.promise } }))`)
  — which is also exactly the "injected session" shape the contract has to survive.
- T4 needs `setLogCwd(env.baseDir)` (case 3 asserts a log line) and restores the git mocks it overrides.

### Must stay green — 11 (anchors re-measured at `481b852`; r3 does not move any of them)

| File:line | Test |
|---|---|
| `session-manager.test.ts:982` | "arms the deadline before it returns, so a CALLER throw cannot unbounded the run (#453)" |
| `session-manager.test.ts:1007` | "clears a deadline armed before prompt() when the spawn throws synchronously (#448)" |
| `session-manager.test.ts:1649` | "review C: a throwing settle still tears the work branch down (catch-all)" |
| `session-manager.test.ts:2390` | "releases the ref via markTerminalBestEffort when a settle handler throws" |
| `session-manager.test.ts:2483` | "persists a session run entry with the agent id at spawn" |
| `session-manager.test.ts:2551` | "finalizes the run entry to failed when the session rejects" (`:2552` is its `mockRejectedValue` line) |
| `session-manager.test.ts:2657` | "finalizes the run entry to failed when prompt() throws synchronously (review F1)" |
| `background-session-persistence.test.ts:198` | "normalizes an instantly-firing timeout to the 30m default, not to ~1ms" |
| `background-session-persistence.test.ts:268` | "success: removes the per-run dir when the prompt completes" |
| `background-session-persistence.test.ts:286` | "timeout/abort: removes the dir when the deadline aborts the run" |
| `background-session-persistence.test.ts:752` | "markTerminalBestEffort: prunes the dir when a settle step throws" |

Plus the spawn-queue interleaving / immediate-`running` pins and the `sections builder` ratchet at `:303`
(`:309` is that test's `readFileSync` line).

All **178** tests in the two files (172 existing + 6 new) were **measured green** with the r3 implementation
(E21), and the full suite's failing set is **identical** to the baseline's (E21) — the D4 decision, the D5
normalisation and the intrinsic routing are transparent to the existing suite.

### Ratchet limits, stated (updated for G1′)

- It is **text-based**, and it trusts the **declared list**, not indentation: a line enters the window only
  by matching a declared entry, **at any indentation**. Indentation is used for exactly one thing — finding
  a declared block's closer (the declared closer text, at the head's own indent) — so a smuggled top-level
  line can never be mistaken for a continuation, which was r2's bug (E17).
- **Out of the ratchet's scope, by construction:** the interior of every declared block — both
  settle-handler bodies, the `new Promise` executor, and each whole `try { … } catch { … }`. Both regime
  bodies **are** re-asserted by the two dedicated body regexes; a statement added to a *catch* body is
  caught only behaviourally (M8/M12 by T5), which is why T5 carries the body-entry observable rather than
  the ratchet. The ~150-line handler bodies are the reason the ratchet does not re-state them.
- It is **text-based because it must be**: `typescript@7.0.2` ships the native compiler only —
  `ls node_modules/typescript/lib` → `getExePath.*`, `tsc.js`, `version.*`, **no `typescript.js`** — so
  there is no in-process AST API (E11). Same discipline as the existing `sections builder` ratchet.
- It pins the **statement text**, not line numbers, and not `runPromise.then(`; a renamed handler or a
  different routing spelling passes by amending the list — the forced decision the issue asks for.

## Critic findings → resolution (r1: nine, all accepted; r2: five more, all accepted; fourteen rows, none dismissed)

| # | Round | Severity | Finding | Resolution |
|---|---|---|---|---|
| 1 | 1 | major | a returned thenable can resolve then throw | **D3 / Q2-R1′**: excluded by contract **and** by the routing's value check; residual stated, deadline backstop |
| 2 | 1 | major | a post-call throw enters `failPreStart` (prunes a live dir, releases a live branch lock) | **D2**: two regimes, boundary = the call |
| 3 | 1 | major | the extra hop is caller-visible (`completed` → `running`; `background-pipeline.ts:568`) | **D4 / Q1-S1**: accepted, explicit criterion, pipeline consequence named, pin (T6) red on the baseline |
| 4 | 1 | major | the ratchet permits throwing statements and pins only this spelling | **Q3-G1′ / T1**: closed window list, indentation-agnostic; six named mutants must go red (M3–M7, M11) |
| 5 | 1 | major | the decided async-rejection pin was omitted | **T2** added (stopReason, agent status, one terminal write, deadline cleared; falsifier = M1) |
| 6 | 1 | major | F1's write count is not a tripwire | **D6 + T5**: sentinel gone; tripwire = transcript line + terminal event + **body-entry `clearTimeout` count** (r3) |
| 7 | 1 | major | sentinel rejection sequenced after two throwing steps; `throw null` breaks normalisation | **D5** (r3-rewritten): total normalisation, contained `failPreStart`, original throw preserved; M9/M10 red |
| 8 | 1 | minor | the retention claim is too broad | **D8**: narrowed to collectability of the deferred; roots named, measured (E7), out of scope |
| 9 | 1 | minor | `:2551` vs `:2552` | corrected in §Tests and E6 |
| 10 | 2 | major | the never-issued proof is narrower than claimed — a wrapper can start the method then throw | **D2.1 / Q2**: the proof is scoped to the unwrapped `async` SDK method + plain read + pure argument; a start-then-throw wrapper is out of contract; probe E15 is the falsifier (row C1) |
| 11 | 2 | major | regime 2's log-and-continue does not bound a routing fault — a later rejection can terminate the host | **D2.3 / Q2-R1′ / D3**: routed through the intrinsic (contained for native promises, incl. a throwing `then` accessor); unsupported values throw synchronously → log → deadline; the Proxy residual is named at the site; E16 + M13 |
| 12 | 2 | major | the G1 ratchet misses a top-level statement indented four spaces | **Q3-G1′ / T1**: indentation-agnostic closed window list with declared block skips; **M11** added and measured red — while the same source passes r2's scan (E17) |
| 13 | 2 | major | D5 overstates containment: `String(reason)` can throw and `cleanupWorkBranch` can throw a non-`Error` before the protected finalizer | **D5**: `normalizeThrown`/`thrownMessage` (total) + `failPreStart` contains teardown/finalize/registry-retire and never masks; teardown catch sites normalised; both critic probes are T4 cases 3–4 (E18) |
| 14 | 2 | minor | T5's tripwire only sees M8 if the body reaches its writes | **D6 / T5**: body-entry `clearTimeout` count, with T1 pinning each body's first statement; M12 measured red (and green under r2's T5 — E19) |

## Risks

- **The D4 status change is real for pipeline callers.** Mitigated by the pin (T6) and by the
  no-consumer measurement (one read of `identity.status`). If a caller is found that branches on it, S1 is
  wrong and S2 (shape (c), ratchet-only) is the fallback — say so before implementing, not after.
- **The routing contract is a contract, not a total fix** (D2.3). For a native `Promise<void>` the routing
  cannot strand a rejection; for a **Proxy-wrapped** promise (or a value the intrinsic refuses) the run is
  left to the deadline and, for the Proxy case, the underlying rejection can still terminate the host. That
  is named at the site; do not "fix" it by assimilating the value (`Promise.resolve`) — that would record a
  live run as `completed` for a non-thenable return (Q2 row R3).
- **The never-issued proof is scoped** (D2.1). A wrapper around `session.prompt` (retry, decorator, an
  injected double that starts work) voids it; the code comment must be read as a precondition, and review
  must treat such a wrapper as a post-start fault.
- **The window's readability.** The call now sits ~270 lines below the acceptance write. A reader must
  follow `settled.then(onSettled).catch(onSettleFault);` before the call. The regime comments and the
  ratchet are what carry it.
- **Regime 2 is a log-and-continue path for *unsupported* values.** If it is reached, the run is
  unmonitored until the deadline — deliberately, because every alternative destroys a live session's branch
  or dir. Do not "improve" it by calling `failPreStart` or by arming a second timer.
- **The T5 tripwire depends on two invariants**, each pinned: (i) the settle body can run at all
  (`session.messages = []` fixture), and (ii) each body's **first** statement is its `clearTimeout`
  (T1 asserts it). If a future edit moves that statement, T1 goes red before T5 becomes blind — that is the
  designed order.
- **`failPreStart`'s containment is defence in depth** (D5, honest limit). The harness can no longer make
  the teardown throw out of it, so removing the containment is not observed by a test today; it is kept for
  the "never mask the original" contract.
- **Four `(err as Error).message` sites remain** outside this unit — `stopAgent`, `steerAgent`, and two in
  the #453 deadline timer body (baseline `:1207`, `:1253`, `:2406`, `:2427`; the r3 `/tmp` copy's numbers
  are `:1235`, `:1281`, `:2456`, `:2477`). Same class (a `throw null` there throws inside a log line, and
  inside a timer body that would be an uncaught exception) but a different boundary; **flagged, not fixed**
  (surgical boundary). If the reviewer wants them in scope, they are four one-token edits plus one test
  each, and should be their own unit.
- **`err` narrowing** in `onSettleFault` (D5) is mechanical but touches a 150-line body: the implementer
  must not reorder statements while editing it.

## Non-goals

- Not shape (a) (`Promise.resolve().then(() => session.prompt(...))`), not a spawn-queue change, not a
  relocation of #439's containment, not a `background-pipeline.ts` change.
- Not a total fix for hostile return values: a Proxy-wrapped promise keeps its process residual (D2.3).
- Not a fix for the pre-start agent-record residue (D8) — separate unit, **#542**.
- Not a fix for the four out-of-scope `(err as Error).message` sites (§Risks).
- Does not reopen #426 / #439 / #447 / #448 / #449 / #453 / #511, the deadline owner, the registry, the
  scratch/`.done` marker, or the containment's getter-backed `agent` read.
- No behaviour change for a successful run **except** D4's status at the caller's resume (decided, pinned).

## Delta budget

| File | r3 vs r2 | Cumulative vs baseline (`481b852`) | Notes |
|---|---|---|---|
| `src/session-manager.ts` | **+80 / −15** (measured) | **+149 / −29** (measured) | the r3 growth is the two total helpers (27 lines with comments), the contained `failPreStart` (32, up from 11), the regime-2 contract comment (24 lines incl. the `try`), the normalised catch sites; the −15 removes r2's per-regime `String`/`instanceof` lines it replaces |
| `src/__tests__/session-manager.test.ts` | **+184 / −44** (measured) | **+419 / −0** (measured) | T1's scan is rewritten (r2's indent-based ~70 lines replaced by ~95), T3/T4/T5 extended by ~100 lines; still **6** tests in one `describe`; no existing test edited |
| other files | 0 | 0 | `diff -rq` baseline vs r3 `/tmp` copies: only these two files differ (E20) |

(Hunk arithmetic does not sum across revisions — adjacent edits merge — so the cumulative column is
measured directly, not added.)

## Execution sketch (implementer, in order)

1. **Read** `src/session-manager.ts:2460–2510` and `:2640–2700`; confirm the anchors (`:2472`, `:2474`,
   `:2490`, `:2501`, `:2651`) with
   `grep -n "run.acceptedAt = new Date\|persistRunRecord(pi, run\|runPromise = session.prompt(\|runPromise.then(\|}).catch((err: Error)" src/session-manager.ts`.
   If any moved, stop and re-derive — do not pattern-match this spec's line numbers.
2. **Add** the two total helpers (`normalizeThrown`, `thrownMessage`) at module level, before the first
   exported function. They are the only new module-level code.
3. **Harden `failPreStart`**: wrap `cleanupWorkBranch()`, `finalizeRunEntry(...)` and `clearInflightRun(id)`
   each in its own `try/catch`, log with `thrownMessage`, and **keep the `throw err` at every call site** —
   `failPreStart` must never throw now.
4. **Normalise the teardown's own catch sites** (`getCurrentBranch`, `captureDiff`, `restoreHead`,
   `deleteBranch`) and the branch-setup refusal's `sanitizeErrorMessage(...)` to `thrownMessage(err)`.
   `grep -c "as Error).message" src/session-manager.ts` must go 12 → 5 (one of the five is a comment; the
   other four are the out-of-scope sites named in §Risks).
5. **Replace** the pre-start `try/catch` + `runPromise.then(() => {` header with D1's block: `let
   runPromise`, the two resolver declarations, `const settled`, `const onSettled = (): void => {` — the
   body that follows stays byte-identical **except** its catch-all log line (`thrownMessage(err)`).
6. **Replace** `}).catch((err: Error) => {` with `};` + `const onSettleFault = (reason: unknown): void => {`,
   and put `const err = normalizeThrown(reason);` as the first statement **inside** its `try` (the
   `clearTimeout` stays first, before the `try`); its catch-all log line also uses `thrownMessage(err)`.
7. **Replace** the trailing `});` with `};`, then insert THE ATTACH, then regime 1 (with `thrownMessage` +
   `failPreStart` + `throw err`), then regime 2's comment **above** the `try` and the routing
   `void Promise.prototype.then.call(runPromise, resolveSettled, rejectSettled);` as its only statement,
   then `return agent;`.
8. **Typecheck**: `npx tsc --noEmit`. Expect no change in diagnostics; the definite-assignment on
   `runPromise` must still hold (regime 1's catch always throws).
9. **Run** `npx vitest run src/__tests__/session-manager.test.ts src/__tests__/background-session-persistence.test.ts`
   → **172 passed** before any test is added (the "no behavioural regression in the must-stay-green set"
   gate; if it is not 172, stop).
10. **Add the 6 tests** from §Tests verbatim in intent (T1–T6), with the three fixture requirements. Run the
    same two files → **178 passed**.
11. **Run each named mutant** (M1–M13, §Mutants) against a scratch copy and confirm **RED** — 13/13. Do not
    proceed with any mutant that stays green: that mutant names a missing assertion, not a redundant test.
    Re-run the two critic probes (T4 cases 3–4) and the E16 routing probe on the patched tree.
12. **Run the full suite** and compare the failing set with the baseline on the same machine (a `/tmp` copy
    for the baseline). Acceptance: **0 new failures** (E21: 69 pre-existing, identical). Then write the PR
    body with `## Design assumptions` and the D4 decision called out explicitly.

### Design assumptions (paste into the PR body)

1. **State created:** one in-memory deferred per spawn (`settled` + two resolver bindings), in the spawn's
   scope; no disk, no env, no registry. Lifetime = the spawn call's scope.
2. **Teardown:** normal paths — the routing settles it; the settle body runs once. Pre-start failure — it is
   left pending and becomes collectable when the scope is released (deadline already cleared by
   `failPreStart`). Crash between create and teardown: nothing on disk changes; the existing deadline/registry
   semantics are untouched.
3. **Concurrency:** one deferred per invocation, single writer (`resolveSettled`/`rejectSettled` called only
   by the regime-2 reaction). No shared state, no lock needed.
4. **Missing/partial/unreadable state:** a value the intrinsic refuses (non-thenable, custom thenable,
   Proxy) → regime 2 logs, the deadline stays the bound (fail-closed on monitoring, fail-open on the
   process: the spawn still returns the agent). For a Proxy-wrapped promise the underlying rejection is
   unowned — the host's unhandled-rejection policy applies (named residual, D2.3).
5. **Evidence:** §Evidence E1–E23 — each claim has a command and its observed output; the 69 full-suite
   failures are pre-existing and identical in baseline and impl (`/tmp`, path-dependent).

## Evidence log

Expected signature stated **before** each probe; every search carries its coverage. E1–E14 are r2's
entries (carried; E3/E4/E5/E6/E13 re-measured in r3 where marked). E15–E23 are new in r3.

| # | Claim | Expected (before) | Command / probe | Observed |
|---|---|---|---|---|
| **E1** | the hop is caller-visible: baseline `completed`, deferred `running` at the caller's resume | `baseline: atResume=completed`, `deferred: atResume=running`, both `afterTick=completed` | `/tmp/brl450-probes/status-hop.mjs`, then the same shape in the real harness | standalone: exactly that. Harness: base `PROBE_AT_RESUME=completed / AFTER_TICK=completed`; impl `PROBE_AT_RESUME=running / AFTER_TICK=completed` ✔ |
| **E2** | an abandoned pending promise + handler closures are collectable | `collected: ['closure-payload']` | `node --expose-gc /tmp/brl450-probes/abandon-gc.mjs` (`FinalizationRegistry`, 1 MB payload captured by the handler, 5 forced GCs) | `collected: [ 'closure-payload' ]` ✔ |
| **E3** | the SDK's `prompt` is `async` — and it is the **only** `prompt(` call in `src/` (the D2.1 clause (b) precondition) | 1 `async prompt(`; 1 `new AgentSession(`; the only *call* is `:2490` | `rg -n "async prompt\(" node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js` → **1 hit** `:1704`; `rg -n "new AgentSession\(" …/core/sdk.js` → **1 hit** `:304`; `grep -rn "\.prompt(" src --include=*.ts \| grep -v __tests__ \| wc -l` → **9** (8 comments + `session-manager.ts:2490`); `rg -n "prompt\(" …/core/agent-session.d.ts` → `:573 prompt(text: string, options?: PromptOptions): Promise<void>;` | exactly that ✔ (re-measured in r3) |
| **E4** | the design is behaviourally transparent to the existing suite | 172/172 green, no test edited | `vitest run src/__tests__/session-manager.test.ts src/__tests__/background-session-persistence.test.ts` in the r3 `/tmp` copy | **178 passed** = 172 existing + 6 new; no existing test edited (E21) ✔ |
| **E5** | full suite: zero new failures | same failing set in both; impl = baseline + 6 tests, all passing | `vitest run --reporter=json` in `/tmp/brl450-base` and `/tmp/brl450-r3` | base `3039 / 2969 passed / 69 failed / 31 files`; r2 impl `3045 / 2975 / 69 / 31`; **r3 `3045 / 2975 / 69 / 31`**, all 6 `#450` tests green (E21) ✔ |
| **E6** | the 11 must-stay-green anchors | all 11 present; async-rejection title at `:2551`, not `:2552` | `grep -n "<title>"` per title over the two test files — **12 queries, 12 hits** | 11 titles at the cited lines; rejection title `:2551`; sections-builder ratchet `:303` ✔ (carried; test file untouched by r3) |
| **E7** | what the pre-start path roots (D8) | `getAgent` → `running`, `_sessionRef` set, disk record `running`, last run entry `failed` | probe test in `/tmp/brl450-probe2` | `GETAGENT=running`, `SESSIONREF=set`, `DISK_STATUS=running`, `LAST_RUN=failed`, `EVENTS=["subagent:created"]` ✔ |
| **E8** | the D4 pin is red on the baseline | `expected 'completed' to be 'running'` | T6 copied into `/tmp/brl450-base` and run alone | `AssertionError: expected 'completed' to be 'running'` ✔ |
| **E9** | the change is confined to the intended files | only `src/session-manager.ts` + the one test file differ from baseline | `diff -rq /tmp/brl450-base/src /tmp/brl450-r3/src` | two files (E20) ✔ |
| **E10** | every named mutant goes red | 10/10 RED (r2) → **13/13 RED** (r3) | `/tmp/brl450-r3-probes/mutants4.sh` (each mutant patches a fresh copy, runs one `-t` selection with `./node_modules/.bin/vitest`) | M1–M13 red; per-mutant message in §Mutants (E20) ✔ |
| **E11** | no in-process AST API (why the ratchet is text-based) | only `tsc.js`/`getExePath`/`version` under `lib/`; `require('typescript/lib/typescript.js')` fails | `ls node_modules/typescript/lib`; `node -e "require('…/typescript/lib/typescript.js')"` | `getExePath.d.ts getExePath.js tsc.js version.cjs version.d.cts`; `MODULE_NOT_FOUND` ✔ |
| **E12** | the delta | src and test only | `diff -u` + `awk` line counting, baseline vs r2 vs r3 | r3 vs baseline **+149/−29** src, **+419/−0** test; r3 vs r2 **+80/−15** src, **+184/−44** test (E20) ✔ |
| **E13** | nothing branches on `identity.status` | exactly one read | `grep -n "identity\.status" src/*.ts src/__tests__/*.ts`; `grep -n "function buildMonitoringDegradedParagraph" -A3 src/notify-completion.ts` | one hit, `src/background-pipeline.ts:995`; the degraded paragraph takes `Pick<BackgroundAgentIdentity, "id" \| "label">` (`notify-completion.ts:374`) ✔ |
| **E14** | `wrapTask` is pure (argument evaluation cannot throw) | a single `String.replace` | `grep -n "export function wrapTask" -A8 src/prompt.ts` | `:67`, `task.replace(/<\/?task>/g, …)` ✔ |
| **E15** | **critique r2 #1 falsifier**: a getter/non-`async` wrapper can start the real method and then throw, so a synchronous throw is not generally proof of "never issued" | `syncThrow=yes`, `live=true`, `settledLate=resolved` | `node /tmp/brl450-r3-probes/start-then-throw.mjs` — `class Session { async prompt(t){ live = true; await …; } }`, `wrappedPrompt()` calls it then throws | `syncThrow= yes:wrapper threw after starting the call`, `live= true`, `settledLate= resolved` ✔ — the proof is narrowed to the unwrapped call (D2.1) |
| **E16** | **critique r2 #2 falsifier**: a routing fault before a rejection handler attaches can terminate the host; and the intrinsic contains the supported case | (a) `routing-fault.mjs` under `--unhandled-rejections=strict` → `routing catch` then **exit 1**; (b) `routing-contain.mjs` → intrinsic attaches anyway, process survives, non-thenable/thenable throw `TypeError`; (c) residual: a Proxy → `TypeError` + **exit 1** | `node --unhandled-rejections=strict …/routing-fault.mjs`; `node …/routing-fault.mjs` (added: default mode); `node --unhandled-rejections=strict …/routing-contain.mjs`; `node --unhandled-rejections=strict …/routing-residual.mjs` | (a) `routing catch: then lookup exploded` → `exit=1`; **default mode also `exit=1`** (so the residual is not flag-only); (b) `tampered:catch=clean`, `nonThenable:catch=TypeError`, `thenable:catch=TypeError`, `tamperedSettled=later rejection`, `SURVIVED`, `exit=0`; (c) `sub settled: sub rejection`, `proxy catch: TypeError: Method Promise.prototype.then called on incompatible receiver`, `exit=1` ✔ |
| **E17** | **critique r2 #3 falsifier**: r2's indent-based scan misses a four-space top-level statement; the r3 walk does not; the mutant compiles | r2 scan: **pass** on the M11 source (11 heads); r3 scan: **fail** naming the line; `tsc --noEmit` exit 0 | M11 = insert `    if (Date.now() > 0) throw new Error("hidden fault");` after THE ATTACH in `/tmp/brl450-r3`; run a verbatim copy of r2's scan **on the same mutant source** (`/tmp/brl450-r3/src/__tests__/r2scan.tmp.test.ts`, since deleted; the critic measured the same result on r2's own tree) and the r3 T1; `./node_modules/.bin/tsc --noEmit` in the mutant tree | r2 scan: `passed` (11 heads, mutant present); r3 scan: `AssertionError: window line 262 must be the declared head: expected 'if (Date.now() > 0) throw new Error("…' to be 'try {'`; tsc `exit=0` ✔ |
| **E18** | **critique r2 #4 falsifiers**: pre-fix, a git teardown's `throw null` replaced the prompt error and an unstringable reason was replaced by the conversion error; post-fix both are preserved and the terminal entry is written | pre-fix: 2 failed with `Cannot read properties of null` and `Error: conversion failed`; post-fix: green | `vitest run … -t "critic cleanup"` in `/tmp/brl450-cleanup-probe` (pre-fix tree); r3 T4 cases 3–4 in `/tmp/brl450-r3` | pre-fix: `expected [Function] to throw error including 'original prompt' but got 'Cannot read properties of null (readi…'` and `expected Error: conversion failed to be { …(1) }`; post-fix: **green** (T4), with `3` run writes and `errorMessage` containing `original prompt` / `unprintable thrown value`; `grep -c "as Error).message" src/session-manager.ts` **12 → 5** (one is a comment) ✔ |
| **E19** | **critique r2 #5 falsifier**: r2's T5 passes M8 when the fault body dies before its writes; r3's body-entry count catches it | r2-shaped T5 (no spy) on the M12 mutant: **pass**; r3 T5: **fail** `expected 2 to be 1`; green tree: **1** | M12 = M8 (`rejectSettled(err)` after `failPreStart`) **plus** `throw new Error("fault body entered, then died before its writes")` as the first statement inside the fault body's `try`; ran T5 with and without the two spy lines | without the spy: `Tests 1 passed` (the r2 blind spot, reproduced); with it: `AssertionError: expected 2 to be 1`; green: count `1` ✔ |
| **E20** | all 13 named mutants go red on the final r3 tree, and only the intended files differ | 13/13 RED, each on its own named test | `bash /tmp/brl450-r3-probes/mutants4.sh` (rsync src → patch → `./node_modules/.bin/vitest run … -t <selection>`); `diff -rq` baseline vs r3 | 13/13 RED (messages in §Mutants); `diff -rq` → exactly two files ✔ |
| **E21** | the suite is green and the full-suite failing set is unchanged | 178 in the two files; full suite `3045 / 2975 / 69 / 31`; the 6 `#450` tests all `passed` | `./node_modules/.bin/vitest run src/__tests__/session-manager.test.ts src/__tests__/background-session-persistence.test.ts` → `Tests 178 passed`; `vitest run --reporter=json --outputFile=/tmp/brl450-r3-full.json` + a JSON pass over the assertions | `numTotal 3045 / passed 2975 / failed 69 / failedFiles 31`; 6 new tests, all `passed`, none non-passing ✔ |
| **E22** | the intrinsic routing is the same function for the supported value (no hop, no behaviour change) | `p.then === Promise.prototype.then` → `true`; both reactions run in the same tick | `node --input-type=module -e 'const p=(async()=>{})(); …'` (identity + a two-promise reaction-tick comparison) | `p.then === Promise.prototype.then : true`; `reaction ticks intrinsic: [ 0 ] dot-then: [ 0 ]` ✔ |
| **E23** | the routing change is inert for the repo's fixtures (no non-native thenables in tests) | 0 custom thenable `prompt` fixtures | `grep -rn "session\.prompt\.mock" src/__tests__/*.ts \| wc -l` → **99**; `grep -rn "then:" src/__tests__/*.ts` → **0** | 99 native-promise mock assignments, no thenable fixture ✔ |

## Mutants

Each patches a fresh `/tmp` copy of the r3 tree; the selection is the test that must kill it. Measured with
`/tmp/brl450-r3-probes/mutants4.sh` (E20).

| Mutant | Edit | Test it must kill | Measured (red) |
|---|---|---|---|
| M1 | delete `onSettleFault`'s `if (deadlineHandle) clearTimeout(deadlineHandle);` | T2 | `expected 1 to be +0` (deadline cleared 1 → 0) |
| M2 | move the routing into regime 1's `try`, delete regime 2 | T3 | `TypeError: Method Promise.prototype.then called on incompatible receiver #<Object>` — the post-start fault is now caught by regime 1, so `failPreStart` runs and **the spawn rejects** instead of resolving `running` |
| M3 | move THE ATTACH below the routing | T1 | `window line 270 is not the declared statement: expected 'try {' to be 'settled.then(onSettled).catch(onSettl…'` |
| M4 | insert `maybeThrowFromFutureEdit();` before `let runPromise` | T1 | `window line 26 is not the declared statement: expected 'maybeThrowFromFutureEdit();' to be 'let runPromise: Promise<unknown>;'` |
| M5 | insert it between THE ATTACH and regime 1 | T1 | `window line 263 must be the declared head: expected 'maybeThrowFromFutureEdit();' to be 'try {'` |
| M6 | insert it inside regime 1, before the call | T1 | regime-1 body regex fails: `expected '  run.acceptedAt = …' to match /try \{\n {4}runPromise = session\.pro…/` |
| M7 | insert it inside regime 2, before the routing | T1 | regime-2 body regex fails: `expected '  run.acceptedAt = …' to match /try \{\n {4}void Promise\.prototype\.…/` |
| M8 | add `rejectSettled(err);` after `failPreStart(...)` | T5 | `expected true to be false` (the completion transcript line appears) |
| M9 | revert regime 1's message to `(err as Error).message` | T4 | `expected TypeError: Cannot read properties of null… to be null` |
| M10 | revert the fault body's binding to `reason as Error` | T4 | `expected 'Subagent aborted by user' to be 'undefined'` |
| **M11** | insert `    if (Date.now() > 0) throw new Error("hidden fault");` (four-space indent, top level) after THE ATTACH | T1 | `window line 262 must be the declared head: expected 'if (Date.now() > 0) throw new Error("…' to be 'try {'` — **and r2's scan passed the same source** (E17) |
| **M12** | M8 **plus** `throw new Error("fault body entered, then died before its writes")` as the first statement inside the fault body's `try` | T5 | `expected 2 to be 1` (the body-entry `clearTimeout` count) — **r2's T5 passed this** (E19) |
| **M13** | revert the routing to `runPromise.then(resolveSettled, rejectSettled);` | T3 | `expected 'running' to be 'failed'` + `Error: tampered rejection` (the rejection is unowned → vitest surfaces it, the run stays `running`) |
| **C1** (contract falsifier, not a source mutant) | wrap the callee: start `session.prompt`, then throw (E15's shape) | D2.1 | no test can see this — it is a **contract** falsifier: the probe prints `live: true`, which voids the never-issued proof for that call shape. Recorded so a future wrapper is a review stop, not a silent regression. |

## Conductor decisions

- **Q1 → S1 accepted** (2026-11-20, r2): the caller-visible status change is the cycle's one contract
  change — at the caller's resume `agent.status === "running"` for every prompt shape, and
  `identity.status` is deterministically `running`. Pinned by T6 (red on the baseline). **r3 keeps it**
  (E21).
- **Q3 → G1 accepted** (2026-11-20, r2): the ratchet is a closed list, and a legitimate addition to the
  window must edit the list — that edit is the decision prompt. **r3 keeps the decision and fixes the
  mechanism** (G1′: indentation-agnostic walk, declared block skips; M11 measured).
- **D8 residue → out of scope, filed as #542** (a pre-start failure leaves the agent record `running` while
  the run entry is `failed`; pre-existing, low). Not a unit in this cycle.

## Open questions for the conductor

1. **Q2 → R1′ (intrinsic routing).** r2's answer to the return contract was "exclude by contract". The
   critique showed that exclusion alone leaves the host exposed to a routing fault it could contain for
   free. r3 recommends `Promise.prototype.then.call(...)` (one line, zero hops, T3 pins it, M13 kills a
   revert). Confirm, or direct R1 (state-only) and accept the residual for tampered native promises too.
2. **Q3 → G1′ mechanism.** Confirm the indentation-agnostic walk with declared block skips, accepting its
   stated scope: statements **inside** a declared block (handler bodies, catch bodies) are outside the
   ratchet and are pinned behaviourally instead (T5, the regime body regexes).
3. **The four remaining `(err as Error).message` sites** (`stopAgent`, `steerAgent`, the deadline timer
   body ×2). Same fault class, outside this window. In scope for this cycle (four tokens + tests) or a
   follow-up? r3 leaves them and names them in §Risks.

## What this investigation did **not** verify

- **The full suite was not run in the repository** (the brief: probe in `/tmp`). The `/tmp` comparison
  establishes "zero new failures" (E21); the implementer must run the real gate (`npx vitest run`, plus
  `tsc --noEmit`, `check:imports`, `docs:arch`) on the branch.
- **The pre-fix full suite was not re-run in r3.** The `69`-failure baseline figure is r2's measurement
  (E5), re-confirmed only as *identical counts* on the r3 tree (E21).
- **`failPreStart`'s containment has no independent behavioural mutant.** With the teardown's catch sites
  normalised, the harness can no longer make `cleanupWorkBranch` throw out of `failPreStart`, so removing
  that `try/catch` is not observed by any test. Stated in D5 as an honest limit.
- **The Proxy residual was measured standalone, not through the spawn.** A session returning a Proxy would
  need a plain-function injection (the mock instrumentation reads `.then`); the test would have to assert a
  deliberate host exit, which vitest cannot express and which would be noise. The standalone probe (E16c)
  is the evidence.
- **"Regime 2's catch is unreachable for the supported value" is argued, not tested.** It follows from
  `p.then === Promise.prototype.then` (E22) and the spec: `PerformPromiseThen` with two function arguments
  cannot throw. No test asserts the catch is dead (a coverage marker would be the only way, and it is a
  comment-level claim).
- **The pipeline identity capture was not measured end-to-end** (carried from r2). D4's pipeline
  consequence rests on E1 (spawn-level, same statement shape), a source read
  (`background-pipeline.ts:549–568`: the identity object literal is the first statement after the spawn
  `await`, no `await` in between) and T6's ratchet assertion.
- `armDeadline`'s timer body was read, not re-probed: the #453 behaviour it carries (`if (agent.completedAt)
  return`) is pinned by the existing tests at `:982` / `:1007` and by T3's timeout classification.
- The spawn log statistics (591/591, 0 timeouts) are quoted from the issue, not re-derived here.

# #450 — attach the background settle handlers before the prompt (shape (b)) — spec **r7**

**Issue:** #450 — hardening. Recorded priority **low** (2026-11-20: bounded consequence, zero observed
incidence) · classifier risk **C1** · `fix: mechanical` · worktree **y** · review **C2 focused**.
**Cycle:** `settle-handlers` (open 2026-11-20) — **U1**.
**Spec r7:** 2026-11-20, against `dev @ f1005d0`. No source or test file has moved since `481b852`:
`git log --oneline 481b852..HEAD -- src/ package.json vitest.config.ts scripts/` → **0** commits, and
`git status --porcelain -- src/ package.json vitest.config.ts` → **0** lines.
**Status: final.** There is no further critique round; r7 is what an implementer builds from. The *design*
is r4's (unchanged since round 4); every finding from round 5 onward was about the **proof apparatus**, and
this pass deletes that apparatus instead of repairing it.
**Provenance:** r6 (this file at `a2f2e43`) + the round-6 critique
(`issue-450-plan-critique-r6-2026-11-20.md`: 3 major, 3 minor, all accepted) + the **five conductor
decisions** in the table below. Measurements marked **E50–E53** were taken by this r7 pass on trees it
built itself at `/tmp/brl450-r7/{tree,m14,m15,m19,m21}` from `/tmp/brl450-r6/intended` (the r6 implementation
tree) and the repository.
**Locked decisions kept:** the deferred, attach-before-call, the two-regime split, no settle in the pre-start
catch, non-`Error` normalisation, contained `failPreStart`, `safeLog`, the D2.1 preconditions, **S1**
(accept `running` at the caller's resume), **#542** and **#543** out of scope.
**Superseded and deleted:** the closed-list ratchet **G1′** (conductor overrule, §r7 changes #1), the
executable mutant gate (Appendix A), the masker/body readers/T7/T1's body pins, and the evidence entries
that only supported them. What was deleted and why is stated in one line each, here and in §Evidence.

## r7 changes (r6 → r7) — the five conductor decisions

| # | Decision | What changed | Why (the finding it answers) |
|---|---|---|---|
| 1 | **Replace the proof apparatus with one window snapshot.** Delete the comment/string/regex masker, `handlerBodyLines`, `regimeBodyLines`, T7 and T1's closed 12-entry list (~460 test lines). **T1** is now ONE indentation-normalised snapshot of the window, from the acceptance write to the routing, compared against one stored constant; its failure message names the decision. The entry marker `markSettleEntry` **stays** — one executable line, and it is T5's instrument. | T1 (rewritten), the module-scope helpers (replaced by the 16-line `settleWindow` reader), §Tests, §Q3, §Delta | The reader produced a **broken gate, incompatible anchors and a false containment claim** while costing ~400 of the 909 added test lines (critique r6 majors #1–#3, minor #4). §Q3 records the measured cost/robustness trade-off. |
| 2 | **Conductor overrules the locked G1′** (closed-list reader) in favour of the snapshot, on cost/robustness grounds. | §Q3 row **G1′ is withdrawn**; §Conductor decisions records the overrule | Same evidence as #1: the reader's *decision* (pin the window; a legitimate addition must edit the pin) is kept; only its instrument is replaced. G1′ was "locked" since r2 — this is the one locked decision r7 reopens, and it reopens the **mechanism**, not the property. |
| 3 | **Delete the executable mutant gate.** No inline patches, no runner script, no patch log. Keep a **mutant table** (M1–M21 + C1/C2/C3): per row, the edit in one sentence and the test it must kill. The implementer applies each mutant in a scratch copy, runs the named selection, and records `tsc`/test exit codes in the PR body. | §Mutants (table only) | The gate passed when patches failed and when no test executed (critique r6 major #2), its anchors did not match the printed code (major #3), and it leaked a shared `/tmp` path (minor #6). A table an implementer executes by hand has none of those failure modes and no artefact to drift. |
| 4 | **Species containment: probe `await`, keep the intrinsic, correct the claim.** Measured (E50): `await` **does** own the species-throwing promise (exit 0) — so r6's "no containment exists" is false — but it **registers a non-thenable return as a success** (T3/M20 broken) and still leaves the `constructor`-throw rejection unowned (exit 1). Also measured: **0 extra microtask hops**, so T3/T6 timing is unaffected either way. | CONTRACT statement (one text, three places), D2.3, D3, Acceptance 8, §Q2 row **A1** | Critique r6 major #1. The contract now says what each routing actually guarantees, and names `await`'s measured result instead of claiming containment is impossible. |
| 5 | **Correct the stale evidence and recompute the budget.** The M5/M11 window positions are re-measured against the snapshot (both now report **window line 163**; the r6 "289/288" belonged to the deleted closed list). The r5 **M18** observations are marked **unmutated-tree results** wherever they are summarised. | §Mutants, §Evidence, §Delta | Critique r6 minors #5. The r5 `m18.py` wrote its output to its own file, so r5's "M18 GREEN" measured an unchanged tree; it is only real from the r6 pass onward, and r7 re-measures it (E51). |
| 6 | **Budget: recomputed, and the declaration is removed.** r7 measures source **+241/−35** (net **206**) and test **+491/−1** (net **490**) against the repository → allowance **120 + 2×206 = 532**, verdict **within by 42** (`test-flow: +490/+206 src (allowance 532) — within`, E52). | §Delta; the `Test budget:` line is gone from the sketch and the PR checklist | The declaration existed because the masker made the delta 909 against 556. With the snapshot it is 490 against 532, so the gate passes on its own terms and a declaration would be noise. If an implementer's own `--flow` run says `over`, the sketch has the one-line fallback. |

History: r1–r6 are in this file's git history and in the six critique files
(`issue-450-plan-critique-r{1..6}-2026-11-20.md`). Their **27 resolution rows** are not repeated here;
every one of them is either implemented below or explicitly deleted by decision #1/#3, and the two that
r7 corrects are #4 and #5.

## Context (verified against `dev @ f1005d0`)

| Anchor | Line | What it is |
|---|---|---|
| `deadlineHandle = armDeadline(...)` | `:2462` | the one deadline owner (#453), armed **before** the prompt |
| `run.acceptedAt = new Date().toISOString()` | `:2472` | the durable acceptance marker (#447) — **the window's start** |
| `persistRunRecord(pi, run, "background")` | `:2474` | the acceptance write (throw → `failPreStart` → rethrow) |
| `runPromise = session.prompt(wrapTask(params.task))` | `:2490` | the one call whose return must be monitored — the only `prompt(` **call** in `src/` (9 grep hits: 8 comments + this call) |
| `runPromise.then(() => {` | `:2501` | the settle handlers, attached **after** the call returns — **the defect** |
| `}).catch((err: Error) => {` | `:2651` | the rejection settle |
| `const failPreStart = (message: string)` | `:1942` | deadline clear → branch teardown → entry finalize → registry retire |
| `agents.set(id, agent);` | `:1576` | the pre-prompt record write (the pre-start retention root) |
| `agent._sessionRef = session;` | `:1988` | the live-session ref |
| `clearTimeout(deadlineHandle)` | `:1943`, `:2502`, `:2652` | the **only three** call sites in the file |

These are **baseline** line numbers. The implementation adds lines above the window
(`normalizeThrown`/`thrownMessage` at `:108`, `safeLog` at `:137`, the contained `failPreStart` at `:1995`,
the marker at `:2602`), so **re-derive every anchor with the step-1 grep**; never trust these numbers.
Measured on the r7 tree (`/tmp/brl450-r7/tree`, E53): `grep -n "clearTimeout("` → `:2003`, `:2612`, `:2767`
(3 call sites); `grep -n "markSettleEntry"` → 3 hits (declaration `:2602`, success `:2611`, fault `:2766`);
`grep -n "const failPreStart = "` → `:1995`; `grep -n "function safeLog"` → `:137`.

## The defect, restated precisely

Two failure classes sit in a 9-line span (`:2482–:2503`):

1. **A throwing statement between `prompt()` returning and `.then` attaching.** The settle is lost; the
   pre-armed deadline (#453) replaces the outcome with a `timeout` classification, `cleanupWorkBranch` never
   runs, and the work-branch lock plus the session dir are held until process exit.
2. **A throw *after* the routing attach but inside the same `try`** (r1's own shape). The throw reaches
   `failPreStart`, which declares "the prompt was never issued" and prunes a **live** session's directory
   and releases its branch lock while the session may still be writing — strictly worse than the class it
   was meant to prevent.

Class 2 is a defect r1 *introduced*; that is why the region is split into two regimes rather than one wider
`try`. **Why this is still C1/low:** 591/591 background spawns settled, 0 background timeouts; with the real
SDK, `prompt` is `async` (E3) and is called **unwrapped** at the one call site, so a synchronous throw means
the callee was never entered — **under the three D2.1 preconditions, which are now written at the site**.

## Design

### D1 — The deferred, and THE ATTACH before the call (shape (b)) — unchanged since r4

Created **after** the acceptance write (a failed acceptance must not leave an unowned promise), the two
settle handlers go on **our own** promise, and the attach is one named statement **above** the prompt call.
The existing handler bodies keep their text and indentation; each gains **one first statement** (the marker,
r4) and its catch-all log call becomes `safeLog(() => …)` (r5).

```ts
  let runPromise: Promise<unknown>;
  let resolveSettled!: () => void;
  let rejectSettled!: (reason: unknown) => void;
  const settled = new Promise<void>((resolve, reject) => {
    resolveSettled = resolve;
    rejectSettled = reject;
  });

  const markSettleEntry = (kind: 'success' | 'fault'): void => {
    try {
      log.debug(`spawnBackgroundSession: settle body entered for ${id} (${kind})`);
    } catch {
      // best effort — the marker must never change the settle path
    }
  };

  const onSettled = (): void => {
    markSettleEntry('success');                         // FIRST statement
    if (deadlineHandle) clearTimeout(deadlineHandle);   // deadline clear, second
    try {
      /* — the existing :2502 body, unchanged — */
    } catch (err) { /* existing catch-all: safeLog(...) + thrownMessage (D5) */ }
  };

  const onSettleFault = (reason: unknown): void => {
    markSettleEntry('fault');                           // FIRST statement
    if (deadlineHandle) clearTimeout(deadlineHandle);
    try {
      const err = normalizeThrown(reason);              // D5: TOTAL, never throws
      /* — the existing :2651 body, unchanged except the `err` binding — */
    } catch (err) { /* existing catch-all: safeLog(...) + thrownMessage (D5) */ }
  };

  // THE ATTACH: both settle handlers are on our own promise before the session
  // is asked to start. The #450 window snapshot pin covers this statement.
  settled.then(onSettled).catch(onSettleFault);
```

**The marker's contract** (spelled out so nothing is invented at the keyboard):

| Aspect | Value |
|---|---|
| name / position | `markSettleEntry`, an arrow **inside `spawnBackgroundSession`**, declared immediately above `const onSettled` (it closes over `id`, so a module-level function would need the id passed) |
| signature | `(kind: 'success' \| 'fault'): void` |
| level / message | **`debug`**, `` `spawnBackgroundSession: settle body entered for ${id} (${kind})` `` — no `data` object, so `JSON.stringify` cannot touch a caller value |
| ordering | the **first executable statement** of both bodies, above the `clearTimeout` and above the `try` |
| containment | the helper has its own `try/catch` — **load-bearing**, not decorative: `logging.ts` wraps only the **file write**, so its console mirror can throw (D5.1) |
| neutrality | `minLevel` defaults to `"info"`, so **nothing is written in production** (E25: 0 bytes, the log file is not even created) |

Why a `debug` record and not a counter or a flag: it is behaviour-neutral (an existing repo pattern —
`grep -rn "log\.debug(" src/*.ts` → 6 hits), it needs **no state** (so it cannot leak or drift), and it is
the only observable that sees a body **entered and dying on its first line** (D6.1).

Why the handlers are named rather than `.then(() => { … })`: it keeps the ~150-line bodies at their current
indentation (a wrapper would re-indent every line into a 300-line whitespace diff) and reduces the invariant
to one checkable statement — *the attach exists, and it is above the call*.

**Chosen over shape (a)** (`Promise.resolve().then(() => session.prompt(…))`), which empties the window but
changes spawn-queue interleaving (`resolveNext()` would run before the prompt), loses the synchronous
acceptance and turns a pre-start rejection into an async terminal event. Decided on the issue; not reopened.

### D2 — The catch boundary: two regimes, separated by syntax, not a flag

`failPreStart` is only *true* when nothing started, so the boundary is the prompt **call** and the code says
so with two adjacent `try` statements. Regime 1 (pre-start):

```ts
  try {
    runPromise = session.prompt(wrapTask(params.task));
  } catch (err) {
    const reason = thrownMessage(err);                          // D5: total
    failPreStart(sanitizeErrorMessage(reason, effectiveCwd));    // D5: contained, never throws
    throw err;                                                  // D6: deferred NOT settled
  }
```

Regime 2 (post-start):

```ts
  try {
    void Promise.prototype.then.call(runPromise, resolveSettled, rejectSettled);   // D2.3
  } catch (err) {
    safeLog(() =>                                                // a sensor, not a new fault
      log.error(
        `spawnBackgroundSession: settle routing failed for ${id} — the run is unmonitored; its deadline remains the only bound`,
        { error: thrownMessage(err) },
      ),
    );
  }
```

**Why regime 2's catch logs through `safeLog`:** it is the last statement before `return agent;`. With
`setConsoleOutput(true)` and a throwing `console.error`, a plain `log.error` would throw out of the catch and
**reject the spawn** — converting an out-of-contract routing fault (spawn resolves, run left to the deadline)
into a rejected spawn, breaking the #439 boundary. T3 case 3 pins this.

#### D2.1 — What "provably never issued" proves, and what it does not — and it is written at the site

> **D2.1 (never-issued proof).** A synchronous throw out of
> `runPromise = session.prompt(wrapTask(params.task))` is proof that the prompt was never issued **iff**
> (a) the callee is the SDK's own `async` method `AgentSession.prompt`
> (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1704`, typed
> `prompt(text): Promise<void>`), (b) it is reached by a plain property read on the session object (no
> getter/Proxy in between), and (c) the argument is evaluated without side effects (`wrapTask` is one
> `String.replace`, `src/prompt.ts:67`).

Each clause is load-bearing. **(a)** an `async` function cannot throw to its caller, so a synchronous throw
can only have happened *before* entry. **(b)** a getter can start the real method and then throw — the caller
sees a synchronous throw while the session is already running (E24: `syncThrow=yes`, `live=true`; that shape
is *outside* the contract and must be treated as a post-start fault). **(c)** if argument evaluation could
start work, the same hole reopens; it cannot today.

Paste **exactly** this comment above `// ---- REGIME 1`:

```ts
  // ---- REGIME 1: pre-start ------------------------------------------------
  // The one statement in this regime is the prompt CALL. A synchronous throw
  // from it is proof that the prompt was never issued ONLY under three
  // preconditions, and all three hold at this site TODAY (issue #450 D2.1):
  //
  //   (a) the callee is the SDK's own `async` method — `AgentSession.prompt`
  //       (node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1704,
  //       typed `prompt(text): Promise<void>` in agent-session.d.ts:573). An
  //       `async` function cannot throw to its caller: such a throw happened
  //       BEFORE entry.
  //   (b) it is reached by a PLAIN property read on the session object — no
  //       getter, no Proxy. A getter can start the real method and THEN throw,
  //       so the caller sees a synchronous throw while the session is already
  //       running (spec E24: `syncThrow=yes`, `live=true`). That shape VOIDS
  //       the proof and must be handled as a post-start fault.
  //   (c) the argument is evaluated without side effects (`wrapTask` is one
  //       `String.replace`, src/prompt.ts:67).
  //
  // If a future edit wraps `session.prompt` — a retry wrapper, a decorator, an
  // injected session double that starts work — then (a)/(b) no longer hold,
  // this regime's premise is GONE, and `failPreStart`'s directory prune plus
  // branch release would hit a LIVE session. Re-derive D2.1 before keeping it.
```

and this paragraph into `failPreStart`'s doc comment, directly under its "PRUNING IS PROVABLY SAFE HERE —
and only here" paragraph:

```ts
   * "Never issued" is a CONTRACT, not an observation — issue #450 D2.1: it
   * holds because the call site invokes (a) the SDK's own `async` `prompt`
   * through (b) a plain property read, with (c) a side-effect-free argument.
   * A wrapper/getter that starts the real method and then throws breaks all of
   * that (spec E24: `live=true` after the synchronous throw); such a call shape
   * must NOT reach this function. See the REGIME 1 comment at the call site.
```

**Falsifier (used, E24):** a wrapper that starts `prompt` and then throws. If such a wrapper ever enters this
call site, D2.1 must be re-derived *before* `failPreStart` is kept. §Mutants row **C1** records it; no test
can see it, so it is a **review stop**, not a regression.

#### D2.2 — What regime 2 does and does not do

- Does **not** call `failPreStart`: no never-issued message, no dir prune, no branch release while the
  session may write.
- Does **not** clear the deadline and does **not** arm a second bound: ADR 0023 decision 1 keeps one owner.
  The already-armed deadline is the monitor of last resort — it aborts, then writes the `timeout`/`aborted`
  snapshot with `prune: false`, so a still-writing session keeps its dir and its branch.
- Does **not** reject the spawn: the run started; the caller must not receive "Failed to spawn background
  agent" (the #439 boundary). The spawn resolves with the agent, `running`.
- **Is unreachable only for the SUPPORTED value** of the contract (D2.3): for that value the routing is
  `Promise.prototype.then` itself (E22: `p.then === Promise.prototype.then` → `true`) and the species step
  yields the intrinsic, so nothing after the receiver check can throw. Every other value is **unsupported**,
  in one of the three classes the contract names.

#### D2.3 — CONTRACT C450-R7: what the routing guarantees, and the measured `await` result

r2's regime 2 was "log and continue" and called the deadline "the only bound". The critique showed it is not
a bound **for the process**: with no rejection handler attached, a later rejection of that native promise is
an *unhandled rejection*, which terminates `node` — under `--unhandled-rejections=strict` **and under the
default mode** (E16: both exit 1). r4 routed through the intrinsic; r5/r6 corrected *why* that is not
universal (`PerformPromiseThen` performs `SpeciesConstructor(promise)`, which reads `constructor` and then
`constructor[Symbol.species]` — E32, E44).

**r7 corrects the two claims r6 got wrong** (E50): there **is** an attach path that owns the species-throwing
rejection (`try { await p } catch` → deferred rejected, host exits 0), but it is not adoptable, and the
`constructor`-throw residual is real for it too. The contract below is the whole narrowing, and it is the
identical text in the site comment, D3 and Acceptance 8.

> SUPPORTED — an ordinary native `Promise<void>` of this realm whose `constructor` and `Symbol.species` reads
> both complete without a throw and resolve to the intrinsic `Promise`: the routing attaches and no later
> rejection can be stranded.
>
> UNSUPPORTED — every other value, NO GUARANTEE; measured, it splits three ways:
>
> · REFUSED, NOTHING STRANDED: a non-thenable or a custom thenable — thrown here, logged, the run is left to
>   the deadline.
> · REFUSED, REJECTION UNOWNED: a Proxy over a promise, or a native promise whose `constructor` or
>   `Symbol.species` read throws — thrown here, logged, and the value's later rejection has no handler, so the
>   host exits 1 (default and strict).
> · ACCEPTED, NOT RELIED ON: a same-realm subclass and a cross-realm promise route and deliver (exit 0).
>   `await` would also own the species-throwing case, but it registers a non-promise return as a success
>   (spec E50), so it is not the routing.

**What each value class does** (all measured; the E22/E32/E44 rows are carried from r5/r6, the `await`
column is new in E50):

| Returned value | intrinsic routing (chosen) | `await` routing (rejected) |
|---|---|---|
| **ordinary** native `Promise<void>`, safe `constructor` and species — the SUPPORTED value, what `async` returns | attaches; identical to `runPromise.then(…)`; **no extra microtask** (E22, re-measured E50) | attaches; **0 extra hops measured** (E50) |
| native promise with an **own `then` accessor that throws** | the accessor is never read; handler attaches; process **survives** (exit 0) | same (exit 0) |
| **species throws** while `constructor === Promise` | refused before the reaction is queued → the rejection is unowned → **exit 1** | applies `then` via the intrinsic and **owns** the rejection → **exit 0** — the ONE case `await` wins |
| **`constructor` read throws** | refused, rejection unowned → **exit 1** | `PromiseResolve`'s `Get(x,"constructor")` throws *inside* the async function, so the deferred IS rejected — but the value's own rejection is still unowned → **exit 1** |
| same-realm **subclass** / **cross-realm** promise | attains correctly → exit 0 (accepted, not relied on) | attains → exit 0 |
| non-thenable `{}` | `TypeError` at the receiver check → caught → logged → run left to the deadline (**T3's contract**) | **resolves the deferred** — the success body runs and a live run is recorded `completed` (**T3 red, M20's failure mode**) |
| custom thenable | refused → logged → deadline (its `then` is never called) | its `then` **is** called (assimilated) — the r1 class-1 defect is reachable again |
| `Proxy` over a promise | refused; the underlying rejection is unowned → **exit 1** | refused; underlying rejection still unowned → **exit 1** |

**Why `await` is rejected although it contains the species case** (E50; §Q2 row A1): it fails T3's
non-thenable contract — `await {}` resolves, so a run that never started would be recorded `completed`, the
mis-report M20 was rejected for — and it does not own the `constructor`-throw or Proxy rejections either. It
would trade one residual class for a live-run mis-report plus a lost routing-fault log. The measured timing
is a wash (**0 extra microtask hops** for an already-settled native promise: the async continuation *is* the
reaction job), so timing is not a factor in either direction.

**The site text — paste verbatim; it is the block D3 and Acceptance 8 repeat** (formatting differs: comment
markers and line wraps; no word does):

```ts
  // Issue #450 (D2.3/D3/Acceptance 8 — THE CONTRACT; the same words in all three places):
  //
  //   SUPPORTED — an ordinary native `Promise<void>` of this realm whose `constructor`
  //   and `Symbol.species` reads both complete without a throw and resolve to the
  //   intrinsic `Promise`: the routing attaches and no later rejection can be stranded.
  //
  //   UNSUPPORTED — every other value, NO GUARANTEE; measured, it splits three ways:
  //   · REFUSED, NOTHING STRANDED: a non-thenable or a custom thenable — thrown here,
  //     logged, the run is left to the deadline.
  //   · REFUSED, REJECTION UNOWNED: a Proxy over a promise, or a native promise whose
  //     `constructor` or `Symbol.species` read throws — thrown here, logged, and the
  //     value's later rejection has no handler, so the host exits 1 (default and strict).
  //   · ACCEPTED, NOT RELIED ON: a same-realm subclass and a cross-realm promise route
  //     and deliver (exit 0). `await` would also own the species-throwing case, but it
  //     registers a non-promise return as a success (spec E50), so it is not the routing.
```

The paragraphs above it — why the routing is the intrinsic and not `runPromise.then`, and why a routing fault
leaves the run to the deadline — are the shipped prose; they are not part of the contract and not repeated in
three places.

**Falsifiers:** (a) a real (non-test) session whose `prompt` returns a non-native thenable — then the run
silently loses its routing and R2 (design for thenables) becomes the choice; (b) the SDK's `prompt` ceasing
to be `async`/`Promise<void>` (also voids D2.1); (c) a session returning a promise whose `constructor` or
`Symbol.species` was tampered with — E32/E44/E50's exit 1 is then the observed behaviour and nothing in this
unit fixes it. Do **not** "fix" (c) by assimilating the value (`Promise.resolve`/`Promise.race`): it records
a non-thenable return as a success (M20) and contains neither residual.

### D3 — The return contract: one statement, three places

**CONTRACT C450-R7, identical to the site comment in D2.3 and to Acceptance 8:**

> SUPPORTED — an ordinary native `Promise<void>` of this realm whose `constructor` and `Symbol.species` reads
> both complete without a throw and resolve to the intrinsic `Promise`: the routing attaches and no later
> rejection can be stranded.
>
> UNSUPPORTED — every other value, NO GUARANTEE; measured, it splits three ways:
>
> · REFUSED, NOTHING STRANDED: a non-thenable or a custom thenable — thrown here, logged, the run is left to
>   the deadline.
> · REFUSED, REJECTION UNOWNED: a Proxy over a promise, or a native promise whose `constructor` or
>   `Symbol.species` read throws — thrown here, logged, and the value's later rejection has no handler, so the
>   host exits 1 (default and strict).
> · ACCEPTED, NOT RELIED ON: a same-realm subclass and a cross-realm promise route and deliver (exit 0).
>   `await` would also own the species-throwing case, but it registers a non-promise return as a success
>   (spec E50), so it is not the routing.

What the design gets and does not get:

- the deferred is settled **only** by the regime-2 reaction, i.e. only after the call returned normally —
  so a throw from the call itself can never race a settlement (this is what makes D6 possible);
- the routing accepts **only** a value the intrinsic `Promise.prototype.then` accepts; a non-thenable or a
  custom thenable throws synchronously, is logged via `safeLog`, and the run is left to the deadline —
  the supported path is reachable only with the SUPPORTED value, **by construction**;
- it does **not** buy protection against a native promise whose `constructor` or `Symbol.species` read
  throws, or against a Proxy over a promise: those are the REFUSED/UNOWNED class, named in the contract and
  at the site, with the host's unhandled-rejection policy as the outcome;
- a **hostile thenable** that calls `resolveSettled()` synchronously inside `then()` and *then* throws is
  outside the contract **and** outside the routing (the intrinsic refuses it, so its `then` is never called).

**Why not design for thenables** (§Q2 row R2): the only way to be correct for them is a settle-once latch plus
the r1 sentinel plus a post-`failPreStart` guard — three mechanisms for a value the SDK cannot return, each
needing its own tripwire, and the tripwire is exactly what failed in r1 and again in r3. r4–r7 reject them at
one line and name the residuals instead.

### D4 — The caller-visible status: accept `running` at the caller's resume (S1, decided)

The deferral costs exactly one microtask hop, and the hop is **caller-visible**:

| | `await spawnBackgroundSession(...)`, immediately-resolved prompt |
|---|---|
| baseline (attach on `runPromise`) | the caller resumes with `agent.status === 'completed'` |
| shape (b) (attach on the deferred) | the caller resumes with `agent.status === 'running'`; `completed` one tick later |

Measured twice (E1, E8). The intrinsic routing is the same function for a native promise (E22) and the
`await` alternative was measured at **0 extra hops** (E50), so the hop count does not change either way.

> **Acceptance criterion D4.** For every prompt shape — already resolved, pending, hanging — at the caller's
> first statement after `await spawnBackgroundSession(...)`, `agent.status === 'running'`. The same statement
> in the pipeline is the identity capture (`background-pipeline.ts:568`, `status: agent.status`), so
> `identity.status` is deterministically `running`.

**Pipeline consequence.** `spawnBackgroundRun` formats `Status: ${spawned.identity.status}`
(`background-pipeline.ts:995`), so an immediately-finished run now says `Status: running` where it said
`completed`. That is the intended reading of the text it accompanies ("Background agent started … You'll be
woken with a completion message when it finishes"). Nothing branches on it: the identity record has exactly
one read (`:568` capture, `:995` the only consumption) and `buildMonitoringDegradedParagraph` takes only
`id`/`label` (E13). The run's real outcome is unchanged (same terminal record, event, wake).

**Test-only changes:** none in the existing 172 tests (E4; re-measured E53). The decision is pinned by **T6**,
red on the baseline (E8), which also pins that there is no `await` between the spawn and
`status: agent.status`.

### D5 — Non-`Error` throws and a catch path that cannot mask: total normalisation, contained steps, contained logs

`prompt()`'s rejection value and a synchronous throw are both `unknown` by contract. Two holes were measured:
(1) `String(reason)` itself throws for a hostile `toPrimitive`/Proxy, and `reason instanceof Error` throws for
a Proxy whose `getPrototypeOf` trap throws — a normaliser that is not total *replaces* the failure it
describes (E18: pre-fix the caller received `Error: conversion failed`); (2) `failPreStart` was not
fault-contained — a git helper rejecting with `null` made the teardown throw a `TypeError` and the caller got
`Cannot read properties of null` instead of its prompt error (E18).

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
  // every call site (all do `failPreStart(...); throw err`).
  try {                                      // STEP 1 — teardown (defence in depth, M18 green)
    cleanupWorkBranch();
  } catch (err) {
    safeLog(() => log.error(`spawnBackgroundSession: work-branch teardown failed for ${id} — the original spawn failure is preserved`,
      { error: thrownMessage(err) }));
  }
  try {                                      // STEP 2 — finalize (BEHAVIOURALLY PINNED, M16)
    finalizeRunEntry('failed', message);     // terminal retirement is still ATTEMPTED
  } catch (err) {
    safeLog(() => log.warn(`spawnBackgroundSession: pre-start finalize failed for ${id}`,
      { error: thrownMessage(err) }));
  }
  try {                                      // STEP 3 — registry retire (PINNED via the call, M17)
    clearInflightRun(id);
  } catch (err) {
    safeLog(() => log.warn(`spawnBackgroundSession: pre-start registry retire failed for ${id}`,
      { error: thrownMessage(err) }));
  }
};
```

(Formatting inside the three `safeLog(...)` calls may be prettier-printed across lines; the structure — one
`try/catch` per step, `safeLog`, `thrownMessage` — is what the mutants and the review look at.)

Normalisation sites: the pre-start message (`thrownMessage(err)` in regime 1), the never-issued stamp
(`neverIssued`), the fault body's binding (`normalizeThrown(reason)`), the four `cleanupWorkBranch` catch
sites (`getCurrentBranch`, `captureDiff`, `restoreHead`, `deleteBranch`), the branch-setup refusal, and both
settle-body catch-alls' log lines. **Measured coverage:** `grep -c "as Error).message" src/session-manager.ts`
goes **12 → 5**, of which one is a comment; the four remaining code sites (`stopAgent`, `steerAgent`, the two
deadline-timer lines) are **out of this unit** and flagged in §Risks.

- The original throw is preserved (`throw err`, not a re-wrapped error) — `throw null` still rejects the
  spawn with `null`; an unprintable object still rejects with **that object** (T4 case 4).
- The rejection body keeps its old identifier (`err`) so its ~40 lines are untouched; the value is narrowed
  once, before any `.message` use.
- **No `finally` is needed for the deferred:** under D6 the pre-start catch never touches it, so no fault in
  `failPreStart` can skip a release.

**Honest limits, stated precisely:**
- **STEP 1 (teardown) has no behavioural mutant.** With the teardown's own catch sites normalised, the
  harness cannot make `cleanupWorkBranch` throw out of `failPreStart`, so deleting **only** that `try/catch`
  is not observed — **M18 passes T4** (measured on the r7 tree, E51). It stays because it makes "never mask
  the original" true independently of every future teardown edit.
- **STEP 3's catch is also unreachable** — `clearInflightRun` (`run-registry.ts:261`) swallows its own
  `unlinkSync` errors. M17 therefore kills a **deleted step**, not a deleted `catch`.
- **STEP 2 is fully pinned** (M16): the finalizer's write is a real, reachable throw site.

#### D5.1 — A throwing log sink cannot replace the error it reports

`src/logging.ts:158–160` calls the console mirror **outside** its file-write `try/catch`, so with
`setConsoleOutput(true)` and a throwing `console.warn`, `log.warn` throws — and inside a catch block that
throw **becomes the caller's error** and **skips every later step** (E35, pre-fix: T4 received
`console blew up` instead of `original prompt`, and the retire never ran).

```ts
/**
 * Issue #450 (D5): a log call on an ERROR path must never replace the error it
 * reports. `src/logging.ts:158` calls the console mirror OUTSIDE its file-write
 * catch, so with `setConsoleOutput(true)` and a throwing `console` sink,
 * `log.warn` throws — and in a catch block that throw becomes the caller's
 * error, and skips every later step of the cleanup. This wrapper swallows a
 * sinking logger fault. The global fix is #543; this containment is local to
 * the settle/pre-start paths.
 */
function safeLog(write: () => void): void {
	try {
		write();
	} catch {
		// a throwing sink must not mask the original throw nor skip a later step
	}
}
```

**Why a thunk and not `safeLog('warn', message, data)`** (measured, E38): a level-branching signature needs
`level === 'error'`, and `src/__tests__/terminal-status-consistency.test.ts` — the structural guard — reads
that comparison as a re-implementation of the terminal-status predicate and **fails the full suite**. The
thunk has no level logic and no `==` against a status literal.

**The six call sites** (all in `spawnBackgroundSession`'s span except the helper): 1 teardown, 2 finalize,
3 registry retire, 4 `onSettled`'s catch-all, 5 `onSettleFault`'s catch-all, 6 regime 2's catch. Reachability,
measured with a file-write marker (E45): **site 2** is behaviourally pinned (T4 cases 5–6); **site 6** is
pinned (T3 cases 1 and 3); **sites 1, 3 and 5 are construction-only** (0 hits); **site 4 IS reached** by two
existing catch-all tests, but neither makes the sink throw there, so its containment is unpinned (open
question 1).

**The record itself is lost when the console mirror throws first** (the mirror runs before the file write):
that is `logging.ts`, not this containment, which is why T4 case 6 asserts *the error and the retire step*,
not *the log line*.

### D6 — The pre-start catch does **not** settle the deferred

```ts
  } catch (err) {                 // REGIME 1
    …
    failPreStart(sanitizeErrorMessage(reason, effectiveCwd));
    throw err;                    // ← and nothing else. No sentinel, no rejectSettled.
  }
```

`failPreStart` has already classified the run exactly once: deadline cleared, branch torn down, terminal run
entry written (which also writes the `.done` settle marker), registry entry retired. Settling the deferred
afterwards would run a settle body a second time over the same run.

Why abandonment is safe here, and why the r1 sentinel was not worth keeping:

1. **No leak.** An unreachable pending promise and its handler closures are collectable — probed with
   `--expose-gc` + `FinalizationRegistry` (E2: `collected: ['closure-payload']`).
2. **Unreachable in this path.** The routing never ran, the deadline was cleared, and nothing else captures
   `settled`; the only other reference is the spawn scope itself, which the pre-start path already roots
   through `agents` and `agent._sessionRef` (D8/E7). The deferred adds **no** root.
3. **The sentinel was unprovable.** Its only job was to stop a second terminal pass, and r1's tripwire for
   that (`SETTLED_RUN_WRITES`) is blind: the finalizer's `entryWritten` guard masks the repeat, and the
   critic's no-guard build passed it. A guard whose removal is not observed is not a guard.

#### D6.1 — The tripwire: an entry marker that cannot be conditional

T5's job is to prove "**no settle body ran**" on the pre-start path. Three earlier attempts were measurably
blind — an r1 write count (masked by `entryWritten`), an r2/r3 transcript/event pair (blind to a body that
throws before its writes), and an r3 `clearTimeout` count (blind when the handle is already unset). r4's
marker fixes all three because it is the bodies' **first** statement and reads no other subsystem.

T5 asserts, on the sync-throw path:

1. no `Transcript completed:` line (a settle body's only transcript write on success),
2. no `subagent:failed` event,
3. exactly `SETTLED_RUN_WRITES` (3) run writes, terminal status `failed`,
4. **zero `settle body entered` records** (the marker — independent of the timer handle and of any later
   write),
5. the `clearTimeout` count is exactly 1 (the second, redundant entry signal — it still pins D7),
6. **a positive control** — an immediately-resolving prompt in the same test must produce **exactly one**
   record (`(success)`), so "zero" is evidence rather than a blind detector.

Measured: M8 (settle the deferred after `failPreStart`) → red on (1); M12 (M8 + a body dying on its first
line) → red on (5) at `expected 2 to be 1`; **M14** (handle unset + body dies on its first line) → red on
**(4)** with the `clearTimeout` count **still 1** — exactly the blindness r3 had; **M15** (comment decoy) →
T5 **passes** (measured in r5/r6, carried), so T1 (the snapshot) is the independent instrument for it (E51:
T1 red on M15).

### D7 — Deadline interaction (unchanged owner, one new path that must not claim it)

- The deadline is armed before the acceptance write and before the deferred — **unchanged**.
- **Regime 1's catch** clears it via `failPreStart`; no new `clearTimeout` is needed (the timer count
  assertion in #448's test still passes).
- **`onSettleFault`** keeps its existing `clearTimeout` as its first **deadline** statement — now the body's
  **second** statement, behind `markSettleEntry('fault')`. It is T2's target (mutant M1) **and** T5's second
  entry signal. The success body likewise.
- **Regime 2's catch does NOT touch the deadline.** It is the monitor of last resort for an unmonitored run,
  and ADR 0023 decision 1 forbids a second bound. The `timeout`/`prune: false` snapshot it produces is what
  keeps a still-writing session's dir and branch.

### D8 — What the pre-start path actually retains (claim narrowed, measured E7)

| Object | After a pre-start throw | Owner |
|---|---|---|
| terminal **run entry** | `failed`, one write | durable store (correct) |
| `.done` settle marker | written by `finalizeRunEntry` | scratch dir (correct) |
| in-flight registry entry | retired | `clearInflightRun` (correct) |
| **agent record** | still `running` in memory **and on disk** | `agents` map (`:1576`), `persistAgent` |
| **`agent._sessionRef`** | still the live session | `:1988`; released only by `captureAndReleaseSession` / `markTerminalBestEffort` |
| deferred + handler closures | collectable once the deadline is cleared | none (D6) |

So **rejecting the deferred alone would not release the session graph either** — the graph is rooted by
`agents` and `_sessionRef`, independently of the deferred. This unit claims **only** collectability of the
deferred and states the agent-record/`_sessionRef` retention as a **pre-existing** property of the pre-start
path. Out of scope, filed as **#542**.

## Options and decisions

### Q1 — The caller-visible status (D4) — decided: S1

| Option | Mechanism | Blast radius | Cost | Risk if wrong |
|---|---|---|---|---|
| **S1 — accept (decided, r2–r7)** | keep the deferral; document that the spawn reports `running` at the caller's resume; pin it (T6) + pin that the pipeline capture has no `await` between spawn and snapshot | one caller-visible value changes for an immediately-resolved prompt: `completed` → `running`; the spawn result text reads `Status: running`; the terminal record, event and wake are unchanged | 1 test; **0** changes to the 172 existing tests (E4; re-measured E53) | a caller that inferred "already finished" from the spawn result loses that inference — it still gets the completion event and `get_subagent_result`; the run's outcome is untouched |
| S2 — preserve the old timing (shape (c)) | drop the deferral: keep the handlers on `prompt()`'s promise (today's shape), add only a policy pin | zero timing change; **the structural guarantee is gone** — the window stays one statement wide, protected only by a source pin | smaller src delta; the pin carries the whole guarantee | a rewrite that satisfies the pin's spelling but throws at runtime loses the settle again; also reverses the shape (b) decision recorded on the issue |
| S0 — do nothing | — | none | none | the defect stays and no test goes red when a future edit re-opens it |

### Q2 — The return contract for `prompt()` (D2.3, D3) — decided: R1′; `await` probed and rejected (A1)

| Option | Mechanism | Blast radius | Cost | Risk if wrong |
|---|---|---|---|---|
| **R1′ — intrinsic routing (decided, r3–r7)** | `Promise.prototype.then.call(runPromise, …)`: the value's own `then` is never read; for the SUPPORTED value it is byte-equivalent to `runPromise.then(…)`; a refused value throws synchronously → log → deadline. The contract names the three unsupported classes and their residuals | one statement + the contract comment; no timing change for native promises (E22, E50); a custom thenable that r2 would have routed now fails closed to the deadline (intended); the REFUSED/UNOWNED class stays a process residual (E32/E44) | 1 line; 0 hops; T3 has three cases | if some real session returns a non-native thenable, that run becomes deadline-monitored instead of routed — measured: **no** such fixture in the suite (99 `session.prompt.mock*` assignments, 0 custom thenables) and the SDK's `prompt` is `async` |
| **A1 — `await` routing (new, r7; probed, rejected)** | `void (async () => { try { await runPromise; resolveSettled(); } catch (e) { rejectSettled(e); } })()` | **wins the species case** (E50: exit 0, deferred rejected) and keeps the tampered-`then`/subclass/cross-realm cases; **loses** the non-thenable contract: `await {}` resolves, so the success body runs and a live run is recorded `completed` (T3 red, M20's failure mode) and the routing-fault log is lost; still exits 1 for the `constructor`-throw and Proxy classes | 6 statements + 1 nested closure; 0 extra microtask hops (measured) | adopting it re-introduces the mis-report M20 was rejected for, for one residual class gained and two kept |
| R4 — guard the species read | add `try { void runPromise.constructor; } catch` before the routing so a tampered `constructor` is logged as out-of-contract rather than surfacing as the intrinsic's `TypeError` | 3 lines in regime 2 | +3 lines, +1 branch (and it would need `constructor[Symbol.species]` too) | **buys no containment** — the rejection is still unowned and the host still exits 1 — it only changes the message |
| R3 — contain everything (`Promise.resolve`/`Promise.race`) | own the value before routing | every prompt shape | 1 line + T3 rewrite | **rejected on evidence**: assimilation turns a non-thenable into a *resolution*, so `{}` runs the success body and a live run is recorded `completed` (M20), and it does not contain the species residual (E32/E44) |
| R2 — design for thenables | settle-once latch + sentinel + post-`failPreStart` guard; new tests for resolve-then-throw | every settle path gains a guard; two extra states | ~+25 src lines, +2 tests, and r1's unprovable-tripwire problem returns | the guards are unreachable in production, so their removal is unobserved |

**Recommendation: R1′ (decided; r7 completes the correction).** It is the minimal change that makes the
supported path provably unable to strand a rejection **for the one value the contract names**, at zero hops,
and it keeps T3's fail-closed contract for malformed returns. The r6 claim "no containment exists" was
**false** and is replaced by the measured statement in the contract (E50).

### Q3 — How the window is pinned — **G1′ withdrawn; SNAP adopted (conductor overrule, r7 #1/#2)**

| Option | Mechanism | Blast radius | Cost | Risk if wrong |
|---|---|---|---|---|
| **SNAP — one indentation-normalised snapshot (adopted, r7)** | slice the window from the acceptance write to the first `return agent;` after it; trim each line; drop blanks and lines whose trimmed text starts with `//`, `/*`, `*`, `*/`; compare the joined text with one stored constant; on failure report the **first differing line** and say "the settle window changed — attach-before-call and the two regimes are deliberate" | test-only; any legitimate code change inside the window edits the constant (a decision, by design) | **~40 test lines** (16-line reader + 23-line test, constant on one line) vs ~460 for the r6 instrument; measured delta falls from 909 to **490** (E52) | it is a sequence pin, not a parse — a re-nesting that keeps every line in order would pass, though every re-nesting also rewrites a `try {`/`}` line; a line starting with `*` is not pinned (none today); comments on a **code** line are pinned verbatim (annoyance only) |
| G1′ — closed window list + masked, brace-matched body readers (r2–r6, **withdrawn**) | walk the window's non-blank, non-comment lines against 12 declared entries; read four bodies out of comment/string/regex-masked text | test-only; couples the test to the region's statement *text* | **460** measured (T1 136 + masker/readers 202 + T7 122) | **realised**: the reader was bypassed by two decoy shapes, then repaired into a lexer that is not a parser; it produced a broken gate, anchors that did not match the printed code and a false containment claim, and cost more review attention than the 50-line change it protects |
| G1 — r2's list of statement heads at two-space indent | indentation is the continuation signal | test-only | ~60 lines | **proven insufficient**: a four-space top-level `if (…) throw …` passed it |
| G1-regex — r3's unanchored body regexes | two `regex` literals over the window text | test-only | ~6 lines | **proven insufficient**: a block-comment decoy satisfied both |
| G0 — no pin | review only | — | 0 | the ordering property the issue keeps in scope stays unpinned |

**The decision (conductor, r7): SNAP.** The property G1′ was locked for — *the window is closed; a legitimate
addition must edit the pin and that edit is the decision prompt* — is unchanged. What changed is the
instrument. The trade-off, stated so a reviewer can disagree with the numbers in hand:

- **Lost:** the named-statement failure (`window line N is not the declared statement: expected … to be …`)
  and the per-body assertions. The snapshot's failure is a **positional** diff (first differing line + both
  texts), so it still says *where*, not *why*; it does not distinguish "a statement was added" from "a
  statement was edited".
- **Gained:** ≈420 fewer test lines (460 deleted, 39 added), no lexer, no heuristic, no fail-closed edge cases, no anchor coupling
  between the spec and the code. Measured: it goes **red on all four decoys** (M14, M15, M19, M21) and stays
  **green on the intended code** (E51).
- **Comment-pinning, the objection that killed the r6 hash idea, is answered by the normalisation**: comment
  lines are dropped, so the contract comment (and any other comment edit) does **not** rewrite the snapshot —
  measured: the r7 comment rewrites left the snapshot byte-identical (179 lines, same hash, E51).
- **What the snapshot does not do:** it does not validate the *initial* window — an implementer who snapshots
  a wrong window gets a green test. That is what the mutant rows are for: T1 must go red on M3–M7, M11, M14,
  M15, M19, M21 (measured, E51). Snapshot-then-mutate is the check; it is in the sketch (step 10).

## Acceptance criteria

Each is a claim an implementer can check; `T*`/`M*` are the tests and mutants in §Tests / §Mutants.

1. **The attach precedes the call.** `settled.then(onSettled).catch(onSettleFault);` is one statement above
   `session.prompt(`, and the window between the acceptance write and the routing normalises to **179 lines**
   (E51; the exact statements are D1/D2/D5). (T1; M3 → red.)
2. **No statement can be inserted on either side of the call, inside either regime, or as a decoy**: before
   the deferred (M4), between the attach and the call (M5, and the four-space variant M11), inside regime 1
   (M6), inside regime 2 (M7), a block-comment decoy (M15, M19) or a template-literal decoy (M21) that spells
   the expected text — all red, with `tsc` exit 0 (E51). (T1.)
3. **A synchronous `prompt()` throw is treated as pre-start *under D2.1* and classifies once**: one terminal
   run entry (`failed`, the original message), deadline cleared, branch torn down, registry retired, **no
   settle body side effects** (no completion transcript line, no terminal event), **zero `settle body
   entered` records** *and* exactly one `clearTimeout`. The never-issued classification is justified **only**
   by the three D2.1 clauses, which are present at the site as comments (review). (F1 test unchanged + T5;
   M8, M12, M14 → red.)
4. **A throw after the call is post-start**: `failPreStart` is not called (no never-issued message, no prune),
   the spawn resolves, the routing fault is logged, and the deadline remains the bound and classifies the run
   `timeout`. (T3 case 1; M2 → red.)
5. **An async rejection routes through the deferred**: `agent.status === 'failed'`,
   `result.stopReason === 'error'`, run entry `stopReason: "error"`, exactly one terminal write,
   `subagent:failed` emitted, deadline cleared (fake timers 1 → 0). (T2; M1 → red.)
6. **Non-`Error` values work on both regimes**: `throw null` → `errorMessage: "null"` + original rethrow;
   `reject(undefined)` → `errorMessage: "undefined"`. (T4 cases 1–2; M9, M10 → red.)
7. **A fault in ANY of `failPreStart`'s three steps cannot mask the original throw, normalisation is total,
   and neither can a throwing log sink**: (i) a git teardown that throws `null` still rejects the spawn with
   the prompt error **and** writes the terminal entry; (ii) an unstringable thrown object rejects with **that
   object**; (iii) a **terminal write that throws** still rejects with the original error and logs
   `pre-start finalize failed` (M16 → red); (iv) the registry-retire step is asserted separately by a
   `clearInflightRun` call observation plus the registry's end state (M17 → red); (v) a **throwing
   `console.warn`** on that same path, with `setConsoleOutput(true)`, still rejects with the original error
   **and** the retire is still attempted (T4 case 6, E35). The global `logging.ts` fix is **#543**; this
   criterion is about the local `safeLog`. (Teardown step: M18 green, by design — §D5.)
8. **The routing contract is exactly CONTRACT C450-R7, and it is the same text in all three places** (the site
   comment printed in D2.3, D3, and here). A native `Promise<void>` whose own `then` accessor throws is still
   routed, so its rejection is handled (T3 case 2; M13 → red); a non-thenable or custom thenable throws at
   the routing, is logged, and leaves the run to the deadline (T3 case 1; M20 → red); a throwing log sink on
   that path must not turn the routing fault into a rejected spawn (T3 case 3). In full:

   > SUPPORTED — an ordinary native `Promise<void>` of this realm whose `constructor` and `Symbol.species`
   > reads both complete without a throw and resolve to the intrinsic `Promise`: the routing attaches and no
   > later rejection can be stranded.
   >
   > UNSUPPORTED — every other value, NO GUARANTEE; measured, it splits three ways:
   >
   > · REFUSED, NOTHING STRANDED: a non-thenable or a custom thenable — thrown here, logged, the run is left
   >   to the deadline.
   > · REFUSED, REJECTION UNOWNED: a Proxy over a promise, or a native promise whose `constructor` or
   >   `Symbol.species` read throws — thrown here, logged, and the value's later rejection has no handler, so
   >   the host exits 1 (default and strict).
   > · ACCEPTED, NOT RELIED ON: a same-realm subclass and a cross-realm promise route and deliver (exit 0).
   >   `await` would also own the species-throwing case, but it registers a non-promise return as a success
   >   (spec E50), so it is not the routing.

   Evidence: E32, E44, E50 (7+4 probe variants × 2 policies, plus the `await` column). The unowned-rejection
   classes have **no** test — a deliberate host exit is not expressible in vitest — so the probe is the
   falsifier (rows C2, C3).
9. **The never-issued proof is scoped, and the scope is IN THE CODE**: the call site passes the **unwrapped**
   SDK method and a pure argument; the three preconditions are pasted into the REGIME 1 comment and into
   `failPreStart`'s doc comment (D2.1); a wrapper that starts work then throws is *out of contract* and is
   **not** claimed as pre-start (`live=true`, E24). (§Mutants row C1.)
10. **The successful path is unchanged** except the status hop and one `debug` record: `done` entry, branch
    capture, transcript `completed`, one terminal write, `completed` one tick after the caller's resume.
    (Existing suite + T6 + E25: the record is invisible at the default level.)
11. **The caller-visible status is pinned** (`running` at resume, pipeline capture deterministic). (T6; red on
    the baseline, E8.)
12. **Full suite: zero new failures against the baseline on the same corpus.** Measured on the r7 tree and a
    base copy of the same corpus (E53): base `3039 / 2969 passed / 69 failed / 1 skipped / 31 failed suites`,
    r7 `3045 / 2975 / 69 / 1 / 31` — **added failing names: 0, removed: 0**, compared by normalized
    `(basename, fullName)` pairs, never arithmetically across corpora. (A `/tmp` tree without `.git` fails 10
    more tests than the repository **in both trees** — compare sets.)

## Tests

All six live in `src/__tests__/session-manager.test.ts`, inside
`describe("#450 settle handlers attach before the prompt")`. 172 existing + 6 = **178**, measured green on the
r7 tree with `tsc --noEmit` exit 0 (E53).

| ID | Test (title as it must appear) | Asserts | Mutants it kills |
|---|---|---|---|
| **T1** | `pins the settle window snapshot: the deferred, attach-before-call and the two regimes are deliberate (#450)` | the window from the acceptance write to the first `return agent;` after it, normalised (rule below), equals the stored constant; on failure it reports the **first differing line** with both texts and the decision sentence | M3, M4, M5, M6, M7, M11, M15, M19, M21 (measured red, E51) — and every other window-touching row, see §Mutants |
| **T2** | `routes an async rejection through the deferred, clears the deadline and writes ONE terminal record (#450 async-rejection pin)` | `stopReason: "error"`, `agent.status === "failed"`, one terminal write, `subagent:failed`, fake-timer count 1 → 0, no abort after advancing 2× the budget; `mocks.session.messages = []` | M1 |
| **T3** | `treats a returned non-thenable as a POST-start fault, never 'never issued' (#450)` | **(1)** non-thenable: spawn resolves with `running`; run entry stays `running` (no `failPreStart`); `settle routing failed` logged; advancing the budget yields `errorCategory: "timeout"` and exactly one abort. **(2)** a native deferred whose own `then` accessor throws is still routed — its rejection yields `failed` with no timer advance. **(3)** the same routing fault with `setConsoleOutput(true)` and a throwing `console.error`: the spawn must still RESOLVE with a `running` agent | M2, M13, M20 |
| **T4** | `normalises a non-Error value on BOTH regimes and rethrows the original throw (#450)` | (1) `throw null` → `.rejects.toBeNull()`, one terminal entry, `errorMessage: "null"`; (2) `reject(undefined)` → `failed`, `errorMessage: "undefined"`; (3) a git teardown throwing `null` → `.rejects.toThrow("original prompt")`, **3** run writes, terminal `failed`, `getCurrentBranch failed during cleanup` logged; (4) an unprintable thrown object → `.rejects.toBe(theObject)`, `errorMessage` = `unprintable thrown value`; (5) the **third `appendEntry` throws** → `.rejects.toBe(originalPrompt)`, `pre-start finalize failed` logged, `clearInflightRun` observed, registry empty; (6) the same fault with `setConsoleOutput(true)` and a throwing `console.warn` → `.rejects.toBe(originalPrompt)` and `clearInflightRun` still observed (the log line is **not** asserted: a throwing mirror loses the record) | M9, M10, M16, M17 |
| **T5** | `classifies a synchronous prompt throw ONCE — no settle body runs (#450 sentinel tripwire)` | the six assertions of D6.1 — including **ZERO `settle body entered` records** and the **positive control** — with `mocks.session.messages = []`, `setLogCwd(env.baseDir)`, `setLogLevel("debug")` | M8, M12, M14 |
| **T6** | ``the caller observes `running` at its resume even when the prompt resolves immediately (#450 D4 decision)`` | `agent.status === "running"` at resume; no `await` between the pipeline's spawn await and `status: agent.status`; `completed` after one tick | red on the **baseline** (E8) — the D4 pin, not a mutant |

### T1 — the mechanism, the rule, and how to create the constant

The reader and the assertion, pasted verbatim (module scope, next to `readLog`):

```ts
// Issue #450 (r7/T1): the settle window, normalised. Boundaries are the acceptance
// write and the FIRST `return agent;` after it; the rule is in the pin below.
const EXPECTED_SETTLE_WINDOW = /* one JSON string, generated from YOUR source — step 10 */ "";

function settleWindow(src: string): string[] {
	const lines = src.split("\n");
	const start = lines.findIndex((l) => l.trim() === "run.acceptedAt = new Date().toISOString();");
	if (start < 0) throw new Error("settle window: acceptance write not found");
	const end = lines.findIndex((l, i) => i > start && l.trim() === "return agent;");
	if (end < 0) throw new Error("settle window: `return agent;` not found after the acceptance write");
	const code = lines
		.slice(start, end)
		.map((l) => l.trim())
		.filter((l) => l !== "" && !l.startsWith("//") && !l.startsWith("/*") && !l.startsWith("*") && !l.startsWith("*/"));
	if (code.length === 0) throw new Error("settle window: empty after normalisation");
	return code;
}
```

```ts
	it("pins the settle window snapshot: the deferred, attach-before-call and the two regimes are deliberate (#450)", () => {
		const src = readFileSync(new URL("../session-manager.ts", import.meta.url), "utf8");
		const actual = settleWindow(src);
		const expected = EXPECTED_SETTLE_WINDOW.split("\n");
		let firstDiff = -1;
		for (let i = 0; i < Math.max(actual.length, expected.length); i++) {
			if (actual[i] !== expected[i]) { firstDiff = i; break; }
		}
		expect(
			firstDiff,
			firstDiff < 0
				? ""
				: `the settle window changed — attach-before-call and the two regimes are deliberate. ` +
					`First difference at window line ${firstDiff + 1}: expected ${JSON.stringify(expected[firstDiff])} got ${JSON.stringify(actual[firstDiff])}`,
		).toBe(-1);
		expect(actual).toEqual(expected);
	});
```

**The normalisation rule, stated once:** start at the line whose trimmed text is
`run.acceptedAt = new Date().toISOString();`; stop at the first line after it whose trimmed text is
`return agent;` (exclusive); for each remaining line **trim it**, then **drop** it if it is empty or its
trimmed text starts with `//`, `/*`, `*` or `*/`; join with `\n`. Properties this gives, measured:

- **indentation-free** — re-indenting the window does not change the snapshot;
- **comment-free** — a comment edit (including the CONTRACT comment) does not change it: the r7 comment
  rewrites left the snapshot byte-identical at **179 lines / 5481 chars** (E51);
- **order- and text-sensitive** — the code-line sequence is pinned exactly, brace lines included;
- **its blind spot is narrow and fail-safe**: a *code* line whose trimmed text begins with `*` would be
  dropped (none exists), and a block comment's **interior** lines are kept as if they were code (M19's decoy
  `try {`/`void Promise…` lines are therefore pinned — the direction of error is extra red, never a silent
  pass).

**Creating the constant** (step 10 of the sketch): write the implementation first, then run this from the repo
root — it applies the reader and prints the exact literal to paste:

```bash
node -e '
const lines = require("node:fs").readFileSync("src/session-manager.ts","utf8").split("\n");
const s = lines.findIndex(l => l.trim() === "run.acceptedAt = new Date().toISOString();");
const e = lines.findIndex((l,i) => i > s && l.trim() === "return agent;");
const code = lines.slice(s,e).map(l => l.trim())
  .filter(l => l !== "" && !["//","/*","*","*/"].some(p => l.startsWith(p)));
const joined = code.join("\n");
console.error("lines=" + code.length + " chars=" + joined.length);
console.log(JSON.stringify(joined));
' > /tmp/window.literal && head -c 120 /tmp/window.literal
```

Store the printed literal as a **single JSON string** (not a template literal: the window contains a template
literal with `${id}`, which would interpolate). **Check the count**: on the intended window it is **179 lines /
5481 chars**; if yours is not 179, your window differs from D1/D2/D5 — fix the source, not the number.

**Fixture requirements discovered empirically (do not omit):**

- T2 and T5 must set `mocks.session.messages = []`. With an unreadable session projection the settle body
  throws at `captureAndReleaseSession`, the catch-all (`markTerminalBestEffort`) contains it, and the terminal
  event/transcript the tests look for never appears — the tripwire would pass for the wrong reason.
- T3's tampered-`then` case **cannot** use a `vi.fn()`: vitest's own mock instrumentation reads `.then` off a
  returned promise (`spy.js`), so the accessor would explode inside the harness. Inject a session whose
  `prompt` is a **plain function** (`mocks.createAgentSession.mockImplementationOnce(async () => ({ session: {
  ...mocks.session, prompt: () => tampered.promise } }))`) — also exactly the "injected session" shape the
  contract must survive. T3 case 3 uses the same shape (a plain function returning `{}`).
- T4 needs `setLogCwd(env.baseDir)` (cases 3 and 5 assert log lines) and restores the git mocks it overrides.
- T5 needs `setLogCwd(env.baseDir)` AND `setLogLevel("debug")`, and **must restore `setLogLevel("info")`**.
  The marker is a `debug` record; without raising the level "zero records" would hold no matter what the code
  did (a blind detector) and the positive control would fail. E25: at the default level the marker writes
  **0 bytes**.
- T4 case 5 needs `import * as runRegistry from "../run-registry"` + `vi.spyOn(runRegistry, "clearInflightRun")`;
  **T4 case 6 and T3 case 3 need that spy plus `setConsoleOutput` imported from `../logging`**, and both must
  restore `setConsoleOutput(false)` **and** `mockRestore()` the console spy in the test body (a leaked throwing
  `console.warn` poisons the rest of the file — measured in an earlier draft). E28: the spy observes exactly
  `failPreStart`'s own call (`persistRunRecord`'s internal `clearInflightRun` is module-local and not counted).

### Must stay green — the existing 172, in particular these 11

Locate them by title (`grep -n "<title>" src/__tests__/session-manager.test.ts`), not by line number:

| File | Test |
|---|---|
| `session-manager.test.ts` | "arms the deadline before it returns, so a CALLER throw cannot unbounded the run (#453)" |
| `session-manager.test.ts` | "clears a deadline armed before prompt() when the spawn throws synchronously (#448)" |
| `session-manager.test.ts` | "review C: a throwing settle still tears the work branch down (catch-all)" |
| `session-manager.test.ts` | "releases the ref via markTerminalBestEffort when a settle handler throws" |
| `session-manager.test.ts` | "persists a session run entry with the agent id at spawn" |
| `session-manager.test.ts` | "finalizes the run entry to failed when the session rejects" |
| `session-manager.test.ts` | "finalizes the run entry to failed when prompt() throws synchronously (review F1)" |
| `background-session-persistence.test.ts` | "normalizes an instantly-firing timeout to the 30m default, not to ~1ms" |
| `background-session-persistence.test.ts` | "success: removes the per-run dir when the prompt completes" |
| `background-session-persistence.test.ts` | "timeout/abort: removes the dir when the deadline aborts the run" |
| `background-session-persistence.test.ts` | "markTerminalBestEffort: prunes the dir when a settle step throws" |

Plus the spawn-queue interleaving / immediate-`running` pins and the `sections builder` ratchet. All **178**
tests in the two files and the structural guard (`terminal-status-consistency`, 33/33) were measured green on
the r7 tree; the full suite's failing set is identical to the baseline's on the same corpus (E53).

## Risks

- **The D4 status change is real for pipeline callers.** Mitigated by T6 and by the no-consumer measurement
  (one read of `identity.status`). If a caller is found that branches on it, S1 is wrong and S2 (shape (c),
  pin-only) is the fallback — say so before implementing, not after.
- **The window snapshot is a decision point, not a formality.** It is 179 code lines of production text stored
  in a test. Any legitimate edit inside the window (a new statement in a settle body, a re-wording of a code
  line) turns it red and requires re-baselining, which is the moment to ask "is this statement supposed to be
  in the settle window?". The failure message names the decision and the first differing line; do not
  re-baseline without reading it. This is the accepted cost of removing the masker (Q3).
- **A snapshot green does not prove the window is right** — only that it has not changed since it was taken.
  The mutant rows for T1 (M3–M7, M11, M14, M15, M19, M21) are what prove the pin is not vacuous; run them
  (sketch, step 10) before declaring the test useful.
- **The routing contract is narrower than "safe for every native promise".** For the SUPPORTED value it cannot
  strand a rejection. For a native promise whose `constructor` or `Symbol.species` read throws, and for a
  Proxy over a promise, the rejection is unowned and the host exits 1 (E32/E44/E50). Do **not** "fix" this by
  assimilating the value (`Promise.resolve`): it records a non-thenable return as a success (M20) and contains
  neither residual. Do **not** call the measured-accepted subclass or cross-realm promise rejected — they
  route (E44).
- **`await` is not the routing, and the reason must not be lost.** It owns the species case (E50) but resolves
  a non-thenable and loses the routing-fault log. A future author who "simplifies" the routing to `await`
  re-introduces M20's mis-report; the contract line says so at the site.
- **The never-issued proof is scoped — and written in the code** (D2.1). A wrapper around `session.prompt`
  (retry, decorator, an injected double that starts work) voids it; review must treat such a wrapper as a
  post-start fault. **A reviewer must not restate the proof without the three clauses.**
- **Catch-path logging is contained locally, not globally.** `logging.ts` still calls the console mirror
  outside its file-write catch, so any other catch-path log can still replace the error it reports; **#543**
  is the fix. Within this unit: site 2 is behaviourally pinned (T4 case 6) and site 6 (T3 case 3); sites 1, 3
  and 5 are construction-only; site 4 is reached by two existing tests but never with a throwing sink (E45),
  so its containment is unpinned (open question 1). A throwing sink also **loses the record** (the mirror runs
  before the file write), which is why T4 case 6 asserts the error and the retire, not the line.
- **`failPreStart`'s teardown containment has no behavioural mutant** (M18 green, E51). It is kept as defence
  in depth; a reviewer who wants it gone must show `cleanupWorkBranch` cannot throw. M16/M17 pin the finalize
  and retire steps; M17 kills a deleted *step*, not a deleted `catch`.
- **Regime 2 is a log-and-continue path for unsupported values.** If it is reached, the run is unmonitored
  until the deadline — deliberately, because every alternative destroys a live session's branch or dir. Do not
  "improve" it by calling `failPreStart` or by arming a second timer.
- **`safeLog` is a thunk, and that is load-bearing**: a level-branching signature trips
  `terminal-status-consistency` (E38). Do not "simplify" it back to a level argument without re-running that
  guard.
- **Four `(err as Error).message` sites remain** outside this unit (`stopAgent`, `steerAgent`, and two in the
  #453 deadline timer body) — same fault class, different boundary; **flagged, not fixed** (surgical
  boundary). They are four one-token edits plus a test each, and should be their own unit.
- **`err` narrowing** in `onSettleFault` is mechanical but touches a ~150-line body: do not reorder statements
  while editing it, and do not move the marker below the body's first line (T1 and T5 both see it).

## Non-goals

- Not shape (a) (`Promise.resolve().then(() => session.prompt(...))`), not a spawn-queue change, not a
  relocation of #439's containment, not a `background-pipeline.ts` change.
- Not a total fix for hostile return values: a Proxy-wrapped promise and a native promise whose `constructor`
  or `Symbol.species` read throws keep their process residual (CONTRACT C450-R7).
- Not the pre-start agent-record residue (D8) — **#542**.
- Not the global log-sink fix (`logging.ts:158–160`) — **#543**. This unit contains its own catch-path calls
  with `safeLog` and does not touch `logging.ts`.
- Not the four out-of-scope `(err as Error).message` sites (§Risks).
- Not an observability feature: the marker is a `debug` record used by one test, not a metric, and it is not
  wired into any dashboard, event or run record.
- Does not reopen #426 / #439 / #447 / #448 / #449 / #453 / #511, the deadline owner, the registry, the
  scratch/`.done` marker, or the containment's getter-backed `agent` read.
- No behaviour change for a successful run **except** D4's status at the caller's resume and one
  suppressed-by-default `debug` line.

## Delta budget — measured, and **within** (no declaration)

Measured on the r7 tree `/tmp/brl450-r7/tree` (the repository + the two files, with the r7 contract comment and
the snapshot test), against `dev @ f1005d0`, with `git diff --no-index --numstat --no-renames` (E52):

| File | r7 vs baseline | Notes |
|---|---|---|
| `src/session-manager.ts` | **+241 / −35** → net **206** | the production change is r6's (+253/−35, net 218) minus the shortened contract comment (26 → 15 lines) and one comment edit; **no code line differs from r6** |
| `src/__tests__/session-manager.test.ts` | **+491 / −1** → net **490** | 6 tests + the 16-line reader + the one-string constant; the r6 instrument (masker 202, T1 136, T7 122 = **460** lines) is deleted |
| other files | 0 | `diff -rq` against the repository: only these two differ |

The rule, computed with the repository's own module (`scripts/lib/test-budget-flow.mjs`):

```
allowance = 120 + 2 × max(Δsource, 0) = 120 + 2 × 206 = 532
Δtest = 490                    →  test-flow: +490/+206 src (allowance 532) — within
```

**Consequence: the `Test budget:` declaration is removed** — the gate passes on its own terms with 42 lines to
spare (r6 was 909 against 556, over by 353). The margin is thin enough to state the arithmetic: every net
source line buys 2 test lines of allowance, so a tree whose source net is smaller than 206 can go over even
with the same tests. Re-run `node scripts/check-test-budget.mjs --flow --base dev --head <sha>` on your branch
and act on **its** line — add the declaration (sketch step 12b) only if it says `over`. Do not fabricate
numbers; quote `--flow`'s line.

## Execution sketch (implementer, in order)

1. **Read** `src/session-manager.ts:2460–2510` and `:2640–2700`; confirm the anchors with
   `grep -n "run.acceptedAt = new Date\|persistRunRecord(pi, run\|runPromise = session.prompt(\|runPromise.then(\|}).catch((err: Error)" src/session-manager.ts`.
   If any moved, stop and re-derive — do not pattern-match this spec's line numbers.
2. **Add** `normalizeThrown` and `thrownMessage` at module level, before the first exported function (D5).
3. **Add `safeLog` immediately below them**, exactly as printed in D5.1 — a **thunk**, not a level argument.
4. **Harden `failPreStart`**: wrap `cleanupWorkBranch()`, `finalizeRunEntry(...)` and `clearInflightRun(id)` in
   their own `try/catch`, log through `safeLog(() => …)` with `thrownMessage`, keep `throw err` at every call
   site so `failPreStart` never throws. **Paste the D2.1 paragraph** into its doc comment.
5. **Normalise the teardown's own catch sites** (`getCurrentBranch`, `captureDiff`, `restoreHead`,
   `deleteBranch`) and the branch-setup refusal to `thrownMessage(err)`.
   `grep -c "as Error).message" src/session-manager.ts` must go **12 → 5** (one is a comment; the other four
   are the out-of-scope sites in §Risks).
6. **Replace** the pre-start `try/catch` + `runPromise.then(() => {` header with D1's block: `let runPromise`,
   the two resolver declarations, `const settled`, then `markSettleEntry` exactly as printed, then
   `const onSettled = (): void => {` with `markSettleEntry('success');` as its first statement — the rest of
   the body byte-identical **except** its catch-all log call, which becomes
   `safeLog(() => log.error(…, { error: thrownMessage(err) }))`.
7. **Replace** `}).catch((err: Error) => {` with `};` + `const onSettleFault = (reason: unknown): void => {`
   whose **first** statement is `markSettleEntry('fault');`, then the `clearTimeout`, then
   `const err = normalizeThrown(reason);` as the first statement **inside** its `try`; its catch-all log call
   also becomes `safeLog(() => log.error(…))`.
8. **Replace** the trailing `});` with `};`, then insert THE ATTACH, then the **D2.1 REGIME 1 comment block
   verbatim** + regime 1, then regime 2's comment (with **CONTRACT C450-R7 pasted in**) above the routing
   `void Promise.prototype.then.call(runPromise, resolveSettled, rejectSettled);` as its only statement, and
   regime 2's catch with `safeLog(() => log.error(…))`. Then `return agent;`. **Each regime body must contain
   exactly one statement.**
9. **Typecheck**: `npx tsc --noEmit` → 0. Then run the two files → **172 passed** (before any test is added;
   if it is not 172, stop) and `npx vitest run src/__tests__/terminal-status-consistency.test.ts` → **33
   passed** (a `safeLog` with a level argument fails here, E38).
10. **Add the two files' test code**: the `settleWindow` reader + T1's assertion (§Tests T1), T2–T6 with their
    fixture requirements, and the extra imports (`import * as runRegistry`, `setLogLevel`,
    `setConsoleOutput`). **Create `EXPECTED_SETTLE_WINDOW` by running the reader over your own source** and
    storing `JSON.stringify` of the result as one string literal; the intended window is **179 lines / 5481
    chars** — if yours differs, your window differs from D1/D2/D5, so fix the source. Then run the two files
    → **178 passed**.
11. **Verify the pin is not vacuous, mutant by mutant, in a scratch copy** (§Mutants): apply the row's edit to
    a copy of your tree, run `npx tsc --noEmit` and the row's named selection, and record both exit codes.
    Expected: **M1–M17 and M19–M21 red, M18 green** (the documented teardown limit), `tsc` 0 everywhere. A
    green row (other than M18) names a missing assertion; a `tsc` failure means the edit is not the row.
    T1 must be red for M3–M7, M11, M14, M15, M19 and M21 — that is the pin's own proof.
12. **Run the full suite** and compare the failing set with the baseline **on the same corpus** (a `/tmp` copy
    for each; a tree lacking `.git`/`.development` fails 10 extra tests **in both trees** — compare sets by
    normalized `(basename, fullName)`, never raw counts). Acceptance: **0 new failures** (E53's figures are the
    reference). Then run `node scripts/check-test-budget.mjs --flow --base dev --head <sha>`: expect
    `+490/+206 src (allowance 532) — within`. If it says `over`, add the declaration (step 12b) and quote its
    line.

    **12b (only if `--flow` says over).** Put one bare line, outside fences and blockquotes, in the PR body —
    `Test budget: over-allowance — <n> test lines against a <m>-line allowance (net <s> source lines): <why>` —
    and verify it with `node scripts/check-test-budget.mjs --declaration <body-file>` (prints the line, exit 0;
    a fenced copy or a blank line after the colon exits 1 — verify it on your body file).

### Design assumptions (paste into the PR body)

1. **State created:** one in-memory deferred per spawn (`settled` + two resolver bindings) in the spawn's
   scope; no disk, no env, no registry. Lifetime = the spawn call's scope. The entry marker creates **no**
   state — one `debug` log line, filtered out at the default level (0 bytes, E25). `safeLog` creates no state:
   `try { write() } catch {}` with no field, cache or flag (total for seven throwing thunks, E40/E48).
2. **Teardown:** normal paths — the routing settles it, the settle body runs once. Pre-start failure — it is
   left pending and becomes collectable when the scope is released (the deadline was cleared by
   `failPreStart`). Crash between create and teardown: nothing on disk changes; the deadline/registry
   semantics are untouched.
3. **Concurrency:** one deferred per invocation, single writer (`resolveSettled`/`rejectSettled` are called
   only by the regime-2 reaction). No shared state, no lock. The marker and `safeLog` are re-entrant by
   construction (a pure log call; a `try/catch`), so two bodies entering cannot interleave anything.
4. **Missing/partial/unreadable state:** a value the intrinsic refuses (non-thenable, custom thenable) → regime
   2 logs, the deadline stays the bound (fail-closed on monitoring, fail-open on the process: the spawn still
   returns the agent). The REFUSED/UNOWNED class is named, not papered over: a Proxy over a promise, and a native
   promise whose `constructor` **or** `Symbol.species` read throws — for these the rejection is unowned and the
   host's unhandled-rejection policy applies (E32/E44/E50). A throwing **log sink** is the third unreadable
   input: contained by `safeLog` at every catch-path site in this unit (#543 is the process-wide fix), and the
   record itself is lost when the mirror throws first (E35).
5. **Evidence:** §Evidence, E2–E53 as listed there — each claim has a command and its observed output, and each
   search carries its coverage. The full-suite comparison is **same-corpus and set-based** (E53); the `/tmp`
   trees' absolute counts (69 failed / 31 suites) differ from the repository's (59 / 23) because those trees
   lack `.git`, and they differ in **both** trees equally. The r7 snapshot and mutant measurements are E51.

### PR-body checklist (the implementation PR, in order)

1. `## Design assumptions` — the five answers above, unedited.
2. **The D4 decision** — one paragraph: the caller observes `running`, `identity.status` is deterministic, and
   the terminal record/event/wake are unchanged (S1, T6).
3. **The test-budget line**, if and only if `--flow` says `over` (step 12b). With the measured r7 delta it says
   `within` and the line is **absent**.
4. **The mutant table's results** (step 11): one line per row with `tsc` and selection exit codes, the one
   `GREEN` on M18 and why it is green (the teardown catch is unreachable through the harness), and the T1-red
   confirmation for M3–M7, M11, M14, M15, M19, M21.
5. **The same-corpus full-suite comparison** (step 12) — the two JSON summaries and "added 0 / removed 0".
6. **The scope statement** — #542 (agent-record residue) and #543 (global log-sink fix) are out of scope, with
   the six `safeLog` sites inside it.

## Evidence (r7: only what an implementer needs; superseded entries deleted)

Deleted as superseded: E5, E6, E9–E12, E14, E15, E17, E19–E21, E23, E26, E27, E29–E31, E33, E34, E36, E37,
E39, E41, E42, E46, E47, E49 — they measured the closed list, the masker, T7, the executable gate or the
r5/r6 tree states those instruments produced. Nothing an implementer must act on depended on them. **E50–E53
are new in r7** and were measured on `/tmp/brl450-r7/*` trees this pass built; carried rows are named as such.

| # | Claim | Command / probe | Observed |
|---|---|---|---|
| **E1/E8** | the deferral's one-hop status change, and the baseline pin | harness probe with an immediately-resolved prompt, then T6 on the r7 tree and on a base copy | baseline: `completed` at the caller's resume; shape (b): `running`, `completed` one tick later — T6 green on the tree, red on the baseline |
| **E2** | an abandoned deferred is collectable — the pre-start path leaks nothing | `--expose-gc` + `FinalizationRegistry` probe (r2, carried) | `collected: ['closure-payload']` |
| **E3** | `prompt` is `async`, and there is exactly one call site | read of `dist/core/agent-session.js:1704` + `agent-session.d.ts:573`; `grep -n "prompt(" src/session-manager.ts` → 9 hits | `async prompt(text): Promise<void>`; 8 comments + the one call at `:2490` |
| **E4** | D4 changes no existing test | full two-file run before/after the deferral (r2/r4, carried; re-measured as E53) | identical 172-test set, `running` vs `completed` visible only in the new T6 |
| **E7** | the pre-start path's retention roots | file-write + object inspection probe (r1, carried) | agent record and `_sessionRef` still live; deferred collectable — D8 |
| **E13** | nothing branches on `identity.status` | `grep -n "identity.status\|status: agent.status" src/background-pipeline.ts` | `:568` capture, `:995` the only consumption; the degraded-paragraph builder takes `id`/`label` |
| **E16** | an unowned rejection terminates `node` in **both** modes | `node` (default) and `node --unhandled-rejections=strict` on a stranded native rejection | exit **1 / 1** |
| **E18** | a non-total normaliser and a non-contained `failPreStart` each replace the error they describe | T4 cases 3–4 on the pre-fix and post-fix sources | pre-fix: caller received `Error: conversion failed` (unstringable object) and `Cannot read properties of null` (git teardown throwing `null`); post-fix: the original value arrives and the terminal entry is written |
| **E22** | the intrinsic is the same function for a native promise | `p.then === Promise.prototype.then` probe | `true`; the reaction runs in the same tick (re-measured in E50: 0 extra hops) |
| **E24** | a wrapper that starts `prompt` then throws leaves the session LIVE | `node start-then-throw.mjs` | `syncThrow=yes:wrapper threw after starting the call`, `live=true`, `settledLate=resolved`, exit 0 — the D2.1 falsifier (C1) |
| **E25** | the marker is invisible at the default level | temp-env probe: `setLogCwd` + `log.debug(<marker>)` + read the log file | `{bytes: 0, hasMarker: false}`; the record is written only after `setLogLevel("debug")` |
| **E28** | the `clearInflightRun` spy sees exactly `failPreStart`'s call | `vi.spyOn(runRegistry, "clearInflightRun")` in T4 case 5 | 1 observation; `persistRunRecord`'s internal retire is module-local and not counted — so M17 is a valid *step* mutant |
| **E32** | `PerformPromiseThen` reads `constructor` (species step), so some native promises strand a rejection | `species-variants.mjs <variant>` × 7, default and strict | ctor-getter / species-getter / non-object ctor → `routed=false`, exit **1/1**; subclass, cross-realm → `routed=true`, exit **0/0** |
| **E35** | a throwing log sink replaces the original error and skips the retire; `safeLog` prevents both | T4 case 6 (warn) and T3 case 3 (error) on the r4 source vs the r5+ source | r4: `expected Error: console blew up to be Error: original prompt`; fixed: green, retire attempted. The log LINE is lost when the mirror throws |
| **E38** | `safeLog` must be a thunk, not a level argument | full-suite run with a level-branching variant | `terminal-status-consistency` fails on `level === 'error'` read as a status predicate; the thunk passes 33/33 |
| **E40/E48** | `safeLog` cannot itself throw | probe over 7 throwing thunks, on the r5 tree and again on the r6 tree (path repointed) | `SAFELOG_TOTAL=yes` (7/7) twice |
| **E44** | `Symbol.species` is a **second** throw point, and subclass/cross-realm are accepted | `species-contract.mjs <variant>` × 7 and `species-attach-paths.mjs <path>` × 4, each in both modes | `p.constructor === Promise` **yet** `routed=false`, `catch=Error: species getter exploded`, exit **1/1**; subclass/cross-realm `routed=true`, exit **0/0**; `intrinsic`/`resolve`/`race` all throw the same read |
| **E45** | which `safeLog` sites are reached (file-write marker, not `console.log`) | a scratch copy with `writeFileSync('/tmp/…/reached.log','S<n>')` before each of the six sites, one run per test | T4 → `2 S2`; T3 → `2 S6`; T5/T2 → ∅; the two catch-all tests → `1 S4` each; sites 1, 3, 5 → never. Control: a *passing* test's `console.log` is printed nowhere |
| **E50** (r7) | `await` owns the species case but not the contract | `node routing.mjs <intrinsic\|await> <variant>` over 9 variants, default and strict; `hop.mjs` for microtask order | species-throws: intrinsic exit **1**, await exit **0** (deferred rejected). ctor-getter: **1 / 1** (await rejects the deferred, value's rejection still unowned). Proxy: **1 / 1**. non-thenable: intrinsic `routed=false` + logged; await `routed=true settled=resolved`. custom thenable: intrinsic refused; await `then` called. subclass/cross-realm/own-then: **0 / 0** both. Timing: identical microtask order (`marker -> marker2 -> settled`) — **0 extra hops** |
| **E51** (r7) | the snapshot pin works and is not vacuous | `settleWindow` over `/tmp/brl450-r7/{tree,m14,m15,m19,m21}` + the T1 test under vitest; then all 21 mutant rows in one pass (`BASE=/tmp/brl450-r7/tree`) | intended: **green**, snapshot **179 lines / 5481 chars**. M14/M15/M19/M21: **red**, `vitest_exit=1`, each message naming the decision and the first differing line. Full set: **20 RED, M18 GREEN, `tsc=0` everywhere**. The comment rewrites that produced the r7 contract left the snapshot byte-identical |
| **E52** (r7) | the delta and the flow verdict | `git diff --no-index --numstat --no-renames` on the two files + `computeFlow` from `scripts/lib/test-budget-flow.mjs` | `241 35` src, `491 1` test; `{"source":206,"test":490,"allowance":532,"verdict":"within"}`; `test-flow: +490/+206 src (allowance 532) — within` |
| **E53** (r7) | the r7 tree is green and full-suite-identical on the same corpus | `tsc --noEmit`; the two-file vitest run; `terminal-status-consistency`; `scripts/check-imports.mjs`; `vitest run --reporter=json` on the r7 tree and on a base copy of the same corpus | `tsc=0`; **178 passed**; 33/33; `imports: 60 files, 0 violations`; base `3039 / 2969 / 69 failed / 1 skipped / 31 suites`, r7 `3045 / 2975 / 69 / 1 / 31` — **added failing names 0, removed 0** |

> **Probe hygiene (carried, still true).** A `/tmp` tree needs a resolving `node_modules` (`tsc`/`vitest`
> exit 127 otherwise — an all-"COMPILE-FAIL" table proves nothing). Full-suite comparisons are same-corpus and
> set-based. Two prior scratch-tree defects were caught and discarded rather than reported (a broken
> `node_modules` symlink in r5; the `/tmp/brl450-r6-patch.log` shared-path leak in r6 — gone with the gate).

## Mutants (table only — the implementer executes them; no runner, no patches)

Each row edits a **scratch copy** of your tree, then runs `tsc --noEmit` and the named selection. Expected:
`tsc` 0 and the selection **red**, except **M18**, which is **green** by design. Measured on the r7 tree in one
pass (E51): **20 RED, M18 GREEN, `tsc=0` everywhere**. "Test it must kill" names the *behavioural* test; every
row that touches the window also turns **T1** red (measured), and for M3–M7, M11, M15, M19, M21 T1 is the only
instrument.

| Mutant | Edit (one sentence) | Test it must kill | Measured on the r7 tree (E51) |
|---|---|---|---|
| M1 | delete `onSettleFault`'s `if (deadlineHandle) clearTimeout(deadlineHandle);` | T2 | `expected 1 to be +0`, `tsc=0` |
| M2 | move the routing into regime 1's `try` and delete regime 2 | T3 | `TypeError: Method Promise.prototype.then called on incompatible receiver` — the post-start fault is caught by regime 1, so `failPreStart` runs and the spawn rejects |
| M3 | move THE ATTACH below the routing | T1 | first difference at window line **162**: expected the attach, got `try {` |
| M4 | insert `if (Date.now() > 0) throw new Error("hidden fault");` before `let runPromise` | T1 | window line **9**: expected `let runPromise…`, got the throw |
| M5 | insert the same statement between THE ATTACH and regime 1 | T1 | window line **163**: expected `try {`, got the throw |
| M6 | insert the same statement inside regime 1, before the call | T1 | window line **164**: expected the `session.prompt(` line, got the throw |
| M7 | insert the same statement inside regime 2, before the routing | T1 | window line **171**: expected the routing, got the throw |
| M8 | add `rejectSettled(err);` after `failPreStart(...)` | T5 | `expected true to be false` (the completion transcript line appears) |
| M9 | revert regime 1's message to `(err as Error).message` | T4 | `expected TypeError: Cannot read properties of null… to be null` |
| M10 | revert the fault body's binding to `reason as Error` | T4 | `expected 'Subagent aborted by user' to be 'undefined'` |
| M11 | insert `    if (Date.now() > 0) throw …` (four-space indent, top level) after THE ATTACH | T1 | window line **163**: expected `try {`, got the four-space throw |
| M12 | M8 **plus** a throw as the fault body's first statement after the marker/clear | T5 | `expected 2 to be 1` (the `clearTimeout` count) |
| M13 | revert the routing to `runPromise.then(resolveSettled, rejectSettled);` | T3 | `expected 'running' to be 'failed'` — the tampered `then` accessor throws, no handler attaches, nothing settles the run |
| M14 | the critic's conditional-handle build: `deadlineHandle = undefined; rejectSettled(err);` after `failPreStart(...)`, plus a throw as the fault body's first statement in its `try` | T5 | `a settle body was ENTERED on the sync-throw path: expected 1 to be +0` — with the `clearTimeout` count assertion still passing at 1 |
| M15 | the critic's block-comment decoy: the real fault body opens on `if (false && deadlineHandle) clearTimeout(…)` and dies, while a block comment spells the expected head | T1 | window line **120**: expected `markSettleEntry('fault');`, got the open of the real body — **T5 passes this** (measured: T5 green, T1 red) |
| M16 | delete **only** `failPreStart`'s `try/catch` around `finalizeRunEntry` | T4 | `the ORIGINAL throw must survive a throwing terminal write: expected Error: append blew up to be Error: original prompt` |
| M17 | delete the whole `clearInflightRun(id)` **step** from `failPreStart` | T4 | `the registry retire step must be ATTEMPTED: expected "clearInflightRun" to be called at least once` |
| M18 | delete `failPreStart`'s `try/catch` around `cleanupWorkBranch()` | **none — green by design** | `Tests 1 passed` — the teardown's own catch sites are total, so no harness fault reaches it (the documented limit, D5). **Note:** r5's "M18 GREEN" measured an **unmutated tree** (its patch wrote to its own file); the real measurement starts at r6 and is repeated here |
| M19 | the critic's regime decoy: a block comment inside the marker helper spells `try {` + the routing + `} catch`, and the REAL regime 2 throws before the routing | T1 | window line **18**: expected the marker's `log.debug(…)`, got the decoy's `try {`/routing lines (block-comment interiors are not stripped) |
| M20 | route through `Promise.resolve(runPromise).then(…)` (own the value instead of the intrinsic) | T3 | `expected '' to contain 'settle routing failed'` — `Promise.resolve({})` **resolves**, so the success body runs and the non-thenable contract breaks |
| M21 | the second decoy: the expected regime-2 text in a **multi-line template literal** inside the marker helper, plus the real throw before the routing | T1 | window line **17**: expected `try {`, got `void \`try {` |
| **C1** (contract falsifier) | wrap the callee: start `session.prompt`, then throw (E24's shape) | D2.1 | no test can see it — the probe prints `live=true`, which voids the never-issued proof for that call shape. A future wrapper is a **review stop** |
| **C2** (contract falsifier) | hand the routing a native promise whose `constructor` getter throws (E32) | CONTRACT (REFUSED/UNOWNED) | probe only: `routed=false`, exit 1 in both modes; every containment attempt behaves the same |
| **C3** (contract falsifier) | hand the routing a native promise whose species read throws (E44) and, separately, route it with `await` (E50) | CONTRACT (REFUSED/UNOWNED + the `await` sentence) | probe only: intrinsic `routed=false`, exit **1/1**; `await` owns it, exit **0** — which is why the contract names `await`'s measured result |

## Conductor decisions (all recorded with their reason)

- **S1 — accept `running` at the caller's resume** (r2, kept r3–r7). One caller-visible value changes; the
  terminal record/event/wake do not; pinned by T6, red on the baseline.
- **The entry marker** (r4, kept): a `debug`, state-free entry record is the tripwire; the `clearTimeout` count
  is demoted to a second, redundant signal.
- **The containment limit is narrowed** (r4, kept): the finalize (M16) and retire (M17) steps are behaviourally
  pinned; only the teardown catch is defence in depth (M18, measured green).
- **`safeLog`'s signature is a thunk** (r5, kept): forced by the existing structural guard, not by taste (E38).
- **`logging.ts` global fix → #543; the agent-record residue → #542** (both out of scope).
- **r7 #1 — the proof apparatus is replaced by one window snapshot** (~460 test lines out, 45 in). Reason: it
  produced a broken gate, incompatible anchors and a false containment claim, and cost more review attention
  than the change it protects.
- **r7 #2 — G1′ (the locked closed-list reader) is overruled in favour of the snapshot.** The *property* is
  kept (the window is closed; a legitimate addition edits the pin); the *instrument* is replaced. Recorded as
  the one locked decision r7 reopens, with Q3's lost/gained list so a reviewer can disagree with the numbers.
- **r7 #3 — the executable mutant gate is deleted**; a table is kept and the implementer executes it by hand,
  recording exit codes. Reason: the gate passed on patch failure and on unexecuted selections, its anchors did
  not match the printed code, and it leaked a shared path.
- **r7 #4 — `await` was probed and rejected; the intrinsic stays; the "no containment exists" claim is
  corrected** with the measured result (E50). Reason: `await` owns the species case but resolves a
  non-thenable (T3/M20) and still leaves the `constructor`-throw class unowned.
- **r7 #5 — the budget is recomputed (490 against 532, within) and the declaration is removed.** Reason: with
  the instrument gone the delta passes the gate on its own terms; a declaration would be noise.

## Open questions for the conductor

1. **Site 4's containment is reachable and unpinned** (E45: both catch-all tests hit that `safeLog` line;
   neither makes the sink throw). Accept the by-construction statement, or spend one variant test
   (`setConsoleOutput` + a throwing `console.error` in "review C: a throwing settle…") — **~30 test lines**,
   which would take the delta to ~520 against 532, still within. **Recommendation: accept it now** — the
   pre-start (T4 case 6) and routing (T3 case 3) paths already pin `safeLog`'s contract, and the gap belongs to
   the existing tests, not to this change.
2. **The marker's level.** `debug` is filtered out by default, so the record never exists in production and T5
   depends on `setLogLevel("debug")`. `info` would write one line per settle into every user's log.
   **Recommendation: `debug`** (E25: 0 bytes at the default), with T5's positive control keeping the test
   honest.
3. **The four remaining `(err as Error).message` sites** (`stopAgent`, `steerAgent`, the deadline timer body
   ×2). Same fault class, outside this window. In scope (four tokens + tests) or a follow-up? r7 leaves them
   and names them in §Risks.
4. **The snapshot's maintenance cost** (Q3). It is now a decision point in a 179-line constant. If the team
   prefers, the same normalisation can be stored as a **sha256 of the joined text** (~3 lines), but the
   failure would then be opaque — the first-diff message needs the stored lines. Recommendation: keep the
   lines.

## What this investigation did **not** verify

- **The r7 snapshot and mutant results come from the proposer's own tree**, not from an implemented PR:
  `/tmp/brl450-r7/tree` was built from `/tmp/brl450-r6/intended` by swapping the contract comment and the test
  file, then measured (E51–E53). The implementer's tree will differ in comment wording and test placement; the
  **179-line window and the 20-red/1-green mutant table** are the anchors to compare against.
- **The full suite was not run in the repository.** It ran on the r7 tree and on a base copy of the **same**
  corpus (both without `.git`), which is what makes the set comparison meaningful (E53); the absolute counts
  there differ from the repository's **equally in both trees**. The implementer must run the real gate on the
  branch (`npx vitest run`, `tsc --noEmit`, `check:imports` — measured green on the r7 tree).
- **The species/`await` probes are standalone subprocess probes**, never through the spawn: a session returning
  such a promise cannot be exercised in-process without either swallowing the rejection (defeating the probe)
  or exiting the runner. The `await` behaviour is measured at the process level; this spec does **not** explain
  the spec-internal mechanism beyond "the fast path reads `constructor`, not `species`".
- **No test asserts that the contract comment says what the contract says.** It is a comment; it is printed in
  three places in this spec for review, and Acceptance 8 is checked by review, not by an instrument.
- **"Regime 2's catch is unreachable for the SUPPORTED value" is argued, not tested** — it follows from
  `p.then === Promise.prototype.then` (E22), the species read succeeding (E44) and the spec of
  `PerformPromiseThen`.
- **Site 4's containment is reached but unpinned** (E45): the reachability is measured, the behaviour is not.
- **`failPreStart`'s teardown containment has no behavioural mutant** (M18 green, E51); `clearInflightRun`'s
  own `catch` is unreachable through the harness, so M17 kills a deleted *step*.
- **The r7 test file was not linted** (biome/eslint) — only `tsc --noEmit`, the vitest runs, the full-suite
  JSON and the mutant pass. Formatting/import-order gates are the implementer's steps 9–12.
- **The spawn log statistics** (591/591 settled, 0 timeouts) are quoted from the issue, not re-derived here.

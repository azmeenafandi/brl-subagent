# Issue #439 — distinguish started and uncertain background retry spawns from pre-start failure

**Status:** investigation only. No fix, no design of the fix, no tracked file touched except this one.
**Checkout:** `dev` @ `5e93f7c`; `src/` is byte-identical to the `78feb6e` the dispatch cites
(`git diff --stat 78feb6e..HEAD` → only `.development/HANDOFF.md`). Every line number below is
`78feb6e`'s, and therefore also HEAD's for `src/`.
**Scratch:** `/tmp/brl439` (a copy of `src/`, `node_modules` symlinked, `presets/` + `templates/`
symlinked; `diff -r /tmp/brl439/src <repo>/src` → identical). Bank: `/tmp/brl-inv-439-bank.md`.
**No** provider, no credentials, no network: every measurement is a controlled SDK stub (the house
`vi.mock("@earendil-works/pi-coding-agent")` pattern already used by `session-manager.test.ts`,
`background-session-persistence.test.ts`, `engineering-bar.test.ts`, `empty-tools-background-442.test.ts`),
plus the **real** `SessionManager`, the **real** run registry, the **real** boot scan and the **real**
terminal-notice factory.

Commands (all from `/tmp/brl439`):

```
./node_modules/.bin/vitest run --reporter=default     # 7 files, 56 tests, all pass
```

| harness | what it measures |
|---|---|
| `src/__tests__/w439-harness.test.ts` | D1 throw sites S1–S5; D2 shapes A1/A2/B/C/D; D5 in-process orphan |
| `src/__tests__/w439b-outcomes.test.ts` | outcome taxonomy E1–E4; fixed S3 timer-arm injection; S6 timer ordering |
| `src/__tests__/w439c-real-sdk.test.ts` | D3 durability with the REAL `SessionManager`; boot scan with dead/live owner |
| `src/__tests__/w439d-extra.test.ts` | `appendEntry` really throws (ENOENT) |
| `src/__tests__/w439e-strings.test.ts` | D6 — the exact literals each surface emits |
| `src/__tests__/w439f-ordering.test.ts` | settle-vs-`await` ordering; cost of one extra microtask hop |
| `src/__tests__/w439g-retry.test.ts` | conductor side: cloned `transport-auto-retry.test.ts` + R0–R3 |

Evidence discipline used throughout: **measured** = produced by one of the commands above;
**read** = code-inspected with the file:line given; **recovered** = quoted from the #437 records and
not re-executable today (§7).

---

## 1. Ground truth — the prompt → return window (D1)

### 1.1 What is actually in the window

`spawnBackgroundSession` (`src/session-manager.ts:1188`) runs, in order:

| # | Statement (line) | Can throw? | Durable state at that moment | Monitoring attached |
|---|---|---|---|---|
| P1 | `agents.set(id, agent); persistAgent(agent)` (`:1407-1408`) | **no** — `persistAgent` (`:376`) swallows `JSON.stringify`/write errors; `ensureOwnerOnlyDir` never throws (`store-permissions.ts:33`) | in-memory map only | none |
| P2 | `persistRunRecord(pi, run, "background")` (`:1436`) | **yes** — inside: registry write first (`registerInflightRun`), then `pi.appendEntry(run)` | registry entry (durable); session run entry only if the append lands | none |
| P3 | `transcript.startTranscript` (`:1561`) | **yes** — `appendFileSync` is not wrapped (`transcript.ts:50-65`) | registry + run entry + on-disk agent record `running` | none |
| P4 | `agent._sessionRef = session` (`:1564`) | no | as above | none |
| P5 | `gitMode=branch` setup (`:1650+`) | yes, **handled**: own `catch` → `finalizeRunEntry('failed')` → rethrow (`:1704-1725`) | as above | none |
| P6 | `eventBus.emit('subagent:created')` (`:1888`) | **no** — `emit` wraps every listener in `try/catch` (`event-bus.ts:58-80`) and `log.*` never throws (`logging.ts:167-175`) | as above | none |
| P7 | `runPromise = session.prompt(wrapTask(task))` (`:1903`) | the **acceptance boundary** | as above | none |
| P8 | `try{…}catch{cleanupWorkBranch; finalizeRunEntry('failed'); throw}` (`:1897-1910`) | only reaches `catch` via P7's own evaluation | run entry finalized `failed`, registry cleared | none |
| P9 | `timeoutHandle = setTimeout(...)` (`:1927`, guarded by `params.timeout && > 0` at `:1926`) | **no in practice** — `normalizeTimeout` is total (`validate.ts:516`) and the delay is always a finite `number` | as above | the W3 timer (only when an explicit timeout exists) |
| P10 | `runPromise.then(...)` (`:1947`) … `.catch(...)` (`:2069`) | **no** for a real promise | as above | the settle handlers |
| P11 | `return agent` (`:2137`), `finally { resolveNext() }` | `resolveNext` is a promise resolver: no | as above | as above |
| — | **caller**, `src/index.ts`: `state.registerLiveSubagent(agent.id, …)` (`:2051`), `activeSubagents++`, `repaintStatus` (`:2069`), `setInterval` poller (`:2074`), 30 m default `setTimeout` (`:2198`) | **yes** (fs/UI/paint), **not** contained | as above | poller + default deadline + live row |

Two structural facts follow from the table and are the whole of D1:

1. **The only monitor for a background run is the settle handler pair (P10).** The W3 deadline (P9)
   exists only with an explicit `timeout`; the 30 m default lives in the caller (`:2198`) and is
   attached after `spawnBackgroundSession` returns.
2. **`session.prompt` is an `async` method** (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.js:1649`).
   An async function never throws synchronously: every throw before its first `await` becomes a
   **rejection of the returned promise**. So P8's `catch` cannot fire for an SDK preflight failure;
   it fires only if `wrapTask` throws (it cannot: `prompt.ts:67-78` is one `String.replace` on an
   already-validated string) or if `session.prompt` is not a function. The F1 test that "covers the
   sync-throw path" (`src/__tests__/session-manager.test.ts:1979-2009`) therefore exercises a shape
   the real SDK cannot produce.

### 1.2 Injections — one per site

| ID | Injection | Observed |
|---|---|---|
| **S1** | `pi.appendEntry` throws (a real ENOENT is also measured, `w439d`) | spawn rejects `append-fs-boom`; **registry entry exists** (`kind: background`, no `interruptedAt`); agent record on disk `running`; `prompt` never called |
| **S2** | `startTranscript` fails (transcript dir under a file → `ENOTDIR`) | spawn rejects; run entry **stays `running`**; registry entry exists; agent record `running`; `prompt` never called |
| **S3** | `setTimeout` throws on the **W3 arm only** (work timer via `timers/promises`) | spawn rejects `timer-boom`; `prompt` called **1×**; fake work ran (`messages: 1`); run entry `["running"]` forever; registry entry persists; agent record `running`; **no agent returned**; `abort` 0 |
| **S4** | `prompt()` returns a thenable whose `.then` getter throws | identical to S3 (prompt 1×, `messages: 1`, run entry `running`, registry present, record `running`, no agent returned) |
| **S5** | a listener on `subagent:created` throws | swallowed; spawn completes normally — **not a throw site** |
| **A1** | `prompt` is a **non-async** function that throws (the F1 mock shape) | spawn rejects; run entry `running`→`failed`; registry cleared; **agent record on disk stays `running`**; no transcript completion entry; no abort; the timer arm sits after the throw, so it never runs |
| **A2** | `prompt` is `async` and throws (the real SDK shape) | spawn **resolves** with the agent; `.catch` path: record `failed` + `completedAt`, transcript completed, registry cleared |
| **R3** | caller-side: the first post-spawn statement throws (`agent.id` accessor), real `delegate_task` handler | `promptInvoked = 1`, tool result `isError: true`, text `Failed to spawn background agent: post-start-oops`, zero source notices, zero toast — **the run started and the user was told the spawn failed** |

Reading of the injections:

- S1/S2 are **pre-start** throws (P2/P3) that leave a durable "dispatch attempted" residue: the
  registry entry survives, and in S2 even the run entry stays `running`. Nothing monitors them, because
  nothing was started — but nothing cleans them either.
- S3/S4 are **post-acceptance** throws in the window. They are *the* #439 state: the run has started,
  the settle handlers never attach, no agent is returned, the caller reports a spawn failure. This is
  exactly what the #437 critique measured in the deleted `/tmp/brl437/c1` (recovered in §7).
- R3 shows the same class one level up, in the caller, where the 30 m deadline and the live row live.
- A1 is a pre-start failure that nonetheless leaves a **zombie `running` agent record and session
  transcript**: `get_subagent_result` will report `running` forever, and the in-memory `agents` entry
  keeps `_sessionRef` (the whole live session graph) alive.

---

## 2. `prompt()` acceptance contract (D2)

Measured against the real `spawnBackgroundSession` with a controlled session object; one variant per row.

| # | Variant | Anything started? | What the returned promise does | `session.messages` | Record outcome | Distinguishable at the call boundary from … |
|---|---|---|---|---|---|---|
| **A1** | synchronous throw (non-async stub) | no | never created | — | run entry `failed`, record stays `running` | — (unreachable with the real SDK) |
| **A2** | `async` throw | no work, promise created | rejects immediately | 0 | `failed`, `completedAt` set, transcript completed | **(B)** only by inspecting `messages`/record after the fact |
| **B** | returned then rejected after doing work | **yes** — one assistant message written | rejects | 1 | `failed` / `errorCategory: exit_error` / `"connection error"` / `retryable: true` | **(A2)** not by the record; both are `failed` |
| **C** | never settles; transport drop before provider acceptance | yes (late work arrives at t+5 ms) | stays pending forever | grows | with explicit `timeout: 40` → status `stopped`, `completedAt` set, **run entry stays `running`**, registry entry persists; **without** a timeout → status `running`, `completedAt` null, `abort` 0, run entry `running`, registry present: **no deadline exists at all** (`E4`) | **(B)** yes, later: `C` never sets `completedAt` and never finalizes the run entry |
| **D** | abort | yes | **resolves** (`stopReason: "aborted"` in the last assistant message) | 1 | `stopped`, run entry `failed` / `Subagent aborted by user` | yes |
| **E1** | resolves with **no assistant message at all** | no observable work | resolves | 0 | **`completed`**, run entry `done`, `stopReason: "stop"`, `exitCode: 0`, `turns: 0`, output `""` | **not distinguishable from a success** — a silent drop is recorded as success |
| **E2** | resolves with `stopReason: "error"` + `"Connection error."` | yes | resolves | 1 | `failed` / `exit_error` / `retryable: true` | yes |
| **E3** | resolves with `stopReason: "error"`, no message | yes | resolves | 1 | `failed` / `exit_error` / `Run ended with a provider error (stopReason "error")` → **not** transport-retryable | yes |

**Verdicts requested:**

- **Does `prompt()` acceptance prove "started"?** **No.** Acceptance proves the SDK took the call. E1
  shows the promise can resolve with no assistant message and the run is then recorded as a success
  with `turns: 0`; C shows it can stay pending while nothing has reached a provider. "Provider
  accepted the request" is not observable from this API.
- **Does rejection prove "not started"?** **No.** B rejects after an assistant turn was already written.
  A rejection proves the run did not *complete*; it says nothing about whether work happened.
- **Can the caller distinguish (B) from (C)?** At the boundary, no: both are just a promise. Later,
  yes, but only from the durable record (`completedAt`/run-entry finalize), i.e. exactly the monitoring
  that S3/S4 show can be missing.

---

## 3. Marker soundness and the crash window (D3)

### 3.1 Write ordering, measured

`persistRunRecord` (`src/run-registry.ts:326-332`):

```
if (run.status !== "running") clearInflightRun(run.id);      // terminal: registry FIRST
else if (kind) registerInflightRun(toRegistryInput(...));    // dispatch: registry FIRST
pi.appendEntry(CUSTOM_ENTRY_TYPES.run, run);                 // session entry LAST
```

- `registerInflightRun` → `writeAtomic` (temp file + `renameSync`, mode 0600) **never throws**
  (`run-registry.ts:181-192`; every fs error is swallowed). So the registry write is all-or-nothing and
  silent on failure.
- `pi.appendEntry` is `AgentSession.sessionManager.appendCustomEntry` → `_appendEntry` → `_persist` →
  `appendFileSync` (`agent-session.js:2801`, `session-manager.js:816-839`), and it **rethrows** after
  rolling the in-memory entry back. Measured: ENOENT after removing the session dir → throws.
- **Durability hole (measured, real `SessionManager`):** with no conversation yet in the session,
  `_persist` returns early (`session-manager.js:786-812`) — `appendCustomEntry` writes **nothing to
  disk** (file does not exist), the entry sits in `fileEntries` and flushes with the first user
  message. An `inMemory` session never persists anything (`getSessionFile() === undefined`,
  `isPersisted() === false`). So the "durable run entry" is only durable once the conductor's own
  session has been flushed — normally true inside a tool call, false for a fresh/in-memory session.
- No `fsync` anywhere on either path: "durable" means survives process death, not power loss.

### 3.2 Is (`run` entry + registry entry) a sound "started-or-unknown" signal?

**No — it is a "dispatch attempted" signal.** Three measured reasons:

1. It is written **before** `session.prompt` (P2 at `:1436` vs P7 at `:1903`). Whatever it means, it
   cannot mean "the prompt was issued".
2. It **survives** the pre-start throws that never reach `finalizeRunEntry` (S1: registry entry written,
   `appendEntry` threw → no terminal write; S2: same, and the run entry is left `running`). Nothing
   clears it later; `clearInflightRun` is called only from a terminal `persistRunRecord` or a
   successor's `clearInflightRun(retrySourceRun.id)`.
3. The **boot scan turns that residue into a false positive** (measured with the real
   `recoverInflightRuns`): a registry entry with a dead owner is marked `interruptedAt` and the
   recovery surface lists it — with a task, an age, a recovery posture and a `retryRunId`
   affordance — even though `prompt()` was never called on the run.

The reverse direction is also wrong: an entry for a genuinely started run carries **no field** that
distinguishes "prompt never invoked" from "prompt accepted, provider silent". `status: "running"` is
used for both (it is the run's status, not the acceptance state).

**Design consequence (fact, not a proposal):** a marker that is written before the point of no return
cannot be trusted as "started-or-unknown" unless it carries an explicit acceptance state
(`starting` vs `accepted`/`acceptedAt`), and the pre-start throw paths must either clear it or leave it
in the weaker state. Today the two states are the same record.

---

## 4. Orphan handling today (D5)

For a **started-but-unmonitored** run (S3/S4 class):

| Question | Answer | Evidence |
|---|---|---|
| What monitors it? | Nothing. The settle handlers are the only monitor and they never attached; no poller was ever created (the caller never got an agent); the 30 m default deadline is created in the caller **after** the throw. | S3/S4 |
| Is it reaped in-process? | No. `sweepStaleLiveSubagents` (`state.ts:721+`) only finalizes live rows whose **agent record has `completedAt` set**, and there is no live row anyway. | O: after 100 ms the run entry is `running`, the registry entry persists, nothing finalizes |
| Is there any in-process signal? | No. The `subagent:created` event has **no production subscriber** (`src/index.ts:4221` subscribes only the three terminal types); no terminal event is ever emitted because no handler runs. | read |
| History / dashboard | The run entry is `running` and not `interruptedAt`, so `runHistoryStatus` → `"Running"` **forever**; `get_subagent_result` reads the same record → `running`, no output. | E: `{statusKey: "running", label: "Running"}` |
| Shutdown | `cleanupSessionState` (`index.ts:214-233`) clears the live map and counters only. Background sessions are **not** aborted; their records are not finalized. On `/new` the run keeps executing (same process); only the wake is lost (#437's policy). | read |
| Next boot | The registry entry has no `interruptedAt`; the owner pid is dead → boot scan marks it `interrupted` → `/brl-subagent history` shows `Interrupted`, the recovery notice lists it, and `retryRunId` is accepted. This is the *correct* outcome for this class — the work is genuinely gone by then. | measured boot scan (dead owner) + `buildRecoveryNotice` |
| Same-process orphan with a **live** owner | Boot scan skips it (`owner-alive`), the recovery surface shows nothing (`count 0`) — correct, but it also means an orphan that survives a `/new` is invisible until the process exits. | O, and dead/live boot-scan pair |

For the **pre-start-with-residue** class (S1/S2) the same boot path produces the **false positive** in
§3.2: an "Interrupted" row and a recovery offer for a run that never started.

---

## 5. Can the window be emptied? (D4)

### 5.1 The claim (falsifiable)

> For the real SDK, no statement between prompt **acceptance** and handler **attachment** can throw
> today: the two statements that sit there are `setTimeout` with a finite numeric delay (P9) and
> `.then` on a real promise (P10). The window is therefore *already* empty in the throwing sense, and
> the S3/S4 failures require an injected fault the SDK cannot produce. Attaching the handlers before
> invoking `prompt()` would make that structural rather than accidental — but **it cannot empty the
> started-unmonitored interval**, because the poller and the 30-minute default deadline are attached in
> `src/index.ts` **after** `spawnBackgroundSession` returns, in a block with no containment (measured
> R3). The residual is `state.registerLiveSubagent(agent.id, …)` at `src/index.ts:2051`: it is the
> first statement that touches the returned agent, and if it throws, the poller (`:2074`), the live row
> and the default deadline (`:2198`) never exist.

Falsifiers: (a) a throwing statement between P7 and P10 for a real `prompt()`; (b) a monitor for a
background run that is attached before `spawnBackgroundSession` returns; (c) containment of the
caller's post-spawn block that turns a throw into anything other than `isError`. None was found.

### 5.2 What "emptying" would break

Two shapes are available, and they are not equivalent:

- **(a) defer the prompt** (`runPromise = Promise.resolve().then(() => session.prompt(...))`). Empties
  the window but changes semantics: the spawn queue's `finally { resolveNext() }` (`:2138-2140`) runs
  **before** the prompt is invoked, so two queued spawns can interleave prompt invocations; the caller
  registers the live row, the poller and the deadline for a run whose prompt has not started; the
  `try/catch` (P8) disappears and a would-be pre-start failure arrives as an asynchronous terminal
  event instead of a rejected spawn.
- **(b) attach to a deferred, then invoke** (create a promise, attach `.then/.catch`, then call
  `session.prompt` and route its settlement into the deferred; arm the timer before the call). Keeps
  the synchronous acceptance and the queue semantics. Costs:
  1. the P8 catch must now **reject the deferred** as well as finalize and rethrow, or a pre-start
     throw leaves a permanently-pending promise (a leak);
  2. because the timer is armed before the prompt, the P8 catch must `clearTimeout` — otherwise the
     timer fires against a failed run and flips it to `stopped` + `session.abort()` (its
     `if (agent.completedAt) return` guard does not help: the F1 path never sets `completedAt`);
  3. one extra microtask hop before the settle becomes observable. Measured: today the agent is still
     `running` when `await spawnBackgroundSession(...)` resumes and becomes `failed` one microtask
     later; the deferred shape takes two hops. No existing test observes the difference.

Nothing else breaks: `subagent:created` keeps its position (and has no production subscriber and no
test pinning its order); `finalizeRunEntry`'s retention/prune decision is independent of ordering;
the answer text and `agent.status` at return are unchanged for the successful path.

**Tests that pin the current ordering** (read; a shape-(b) change must keep them green):

| File:line | What it pins |
|---|---|
| `src/__tests__/session-manager.test.ts:1979-2009` | sync `prompt` throw → run entry finalized `failed`, spawn **rejects** (the F1 contract) |
| `src/__tests__/session-manager.test.ts:1807-1831` | spawn run entry persisted with `status: "running"` while the prompt never settles; exactly one append |
| `src/__tests__/session-manager.test.ts:1622-1625` | `agent.status === "running"` immediately after `await spawnBackgroundSession` |
| `src/__tests__/background-session-persistence.test.ts:197-208` | the W3 timer's delay normalization (instant-fire timeout) |
| `src/__tests__/background-session-persistence.test.ts:231-306` | prune-on-settle for success/timeout/error/user-stop — depends on the handlers, not their attach position |
| `src/__tests__/session-manager.test.ts:1385-1450, 1714-1745` | settle-handler throws are contained (issue #53) |

**Not pinned anywhere:** the position of the timer arm relative to `prompt()`, and the absence of
throwing statements between acceptance and attachment. That is the D8 consequence: a new test must pin
the ordering, or the next edit can silently reintroduce a throwing statement.

### 5.3 Verdict, stated plainly

- **The session-manager window can be emptied completely** (shape b): after the change, no statement
  between acceptance and attachment exists that can throw, and the only residual is `session.prompt`
  itself — the acceptance boundary — plus the promise-wiring call.
- **The system window cannot be emptied**: the started-but-unmonitored interval is re-created in
  `src/index.ts` between `await spawnBackgroundSession(...)` (`:2010`) and the timer arms
  (`:2074`, `:2198`), and `registerLiveSubagent` (`:2051`) sits in it. Emptying the inner window
  therefore relocates the ambiguity; it does not remove it. Any fix that only touches
  `session-manager.ts` leaves R3 reproducible.

---

## 6. Current diagnostics, per outcome (D6)

Surfaces: the spawn **tool result**, the **completion wake** (`subagent-completion`), the poller's
**crash notice** (`subagent-notification`), the **history row**, the **recovery notice**, and the
retry **toast**. Literals measured with the real builders (`w439e`, `w439g`).

| | **pre-start rejected** | **started, monitored** | **started, unknown** |
|---|---|---|---|
| Spawn tool result | `Failed to spawn background agent: <sanitized msg>` (`index.ts:2450`), `isError: true` | `Background agent started: <id> … Status: running` (`:2431-2438`) | `Failed to spawn background agent: <sanitized msg>`, `isError: true` — even though the prompt ran (R3) |
| Source notice (retry path) | delivered: `Background agent "<label>" (<id>) — failed in <dur> · category: exit_error\n\n<errorMessage>\n\nProcess this completion silently…` | suppressed — the retry's own settle is the wake | **delivered, byte-identical to the pre-start case** (R1 vs R2) |
| Toast | none | `Transport failure — auto-retrying once (attempt 2/2)` when the retry spawned | none |
| Crash notice | n/a | `Background agent "<label>" crashed.` only from the poller | never — no poller exists |
| History row | `Failed` (`runHistoryStatus`) | `Completed` / `Failed` | `Running`, **forever**; not `interruptedAt`, retry offer text says "failed run" |
| Recovery affordance today | none (registry cleared by the terminal persist) | none | none in-process |
| Next boot | none — **except** the S1/S2 residue: an `Interrupted` row + recovery notice for a run that never started | none | `Interrupted` row + recovery notice + `retryRunId` accepted |
| Claim involved | `claimTerminalNotice(sourceId)` held, reused for the one fallback send (`notify-completion.ts:287`) | claim held by the wake; the retry's own terminal event claims **its own** id | same as pre-start: the source claim is consumed and never released |

Adjacency to **#440**: `terminalClaims` is a module-level `Set` with `DEDUPE_CAP = 200` and
`seen.clear()` on overflow (`notify-completion.ts:64`, `:279-287`). A burst of >200 ids forgets every
claim, so a duplicate terminal path can deliver again. This matters to #439 because the retry branch
allocates a **new** id per attempt: a retry storm both grows the set and, at the cap, can un-claim the
source. The claim is also per id, so the source and the retry can never dedupe each other — which is
what makes "started retry + source notice" possible at all.

Places a notice-contract decision would change: the retry branch (`scheduleTransportRetry`'s `false` →
source notice at `index.ts:4270-4285`), the claim policy for an unknown outcome, the crash-notice
literal, and the history status vocabulary (which currently has no value for "started, not settled").

---

## 7. Recovered #437 evidence (D7)

Issue #439 has no comments. Its evidence is three comments on #437 plus a scratch harness. The three
sizes named in the dispatch match three of the five local records exactly:

| local record | bytes |
|---|---|
| `.development/investigations/issue-437-investigation-2026-11-06.md` | 39,011 |
| `.development/investigations/issue-437-design-2026-11-06.md` | 61,419 |
| `.development/investigations/issue-437-design-critique-2026-11-06.md` | 17,656 |
| `…-fix-plan-2026-11-06.md` (superseded) | 11,057 |
| `…-plan-critique-2026-11-06.md` (AMEND verdict) | 21,217 |

**#439-relevant facts, verbatim where they are evidence:**

1. The design's classification contract (the claim #439 inherits and must re-decide), design §5.2:
   > **Point of no return: step 14.** `spawnBackgroundSession` returns only after `session.prompt()` has
   > been invoked (steps 15-16 cannot throw) … **Contract:** `startBackgroundAgent` returning normally ⟺
   > a background session exists and its prompt was issued. `spawnBackgroundRun` throwing or returning
   > `isError` ⟺ **no prompt was issued**.

   The design's three outcome classes are `definite pre-start rejection` / `committed started retry` /
   `outcome-unknown`, and §6.7 bounds the guarantees: "Deactivation is *cooperative* … it cannot abort
   work already handed to the SDK"; "A started retry may finish in the old runtime"; "If a send throws,
   the design cannot know whether the message was accepted … 'Exactly once' is therefore **not**
   claimed for the throw case — at-most-one-attempt is."

2. The critique's blocker (verbatim), which refutes the contract:
   > The marker runs **after** `await spawnBackgroundSession`; it cannot detect a throw after
   > `session.prompt()` but before that await resolves. The report's equivalence "throw / `isError` iff
   > no prompt" and its assertion that every post-prompt operation is nonthrowing are false. The real
   > function arms the optional timeout, calls `runPromise.then(...).catch(...)`, returns, and releases
   > its queue in `finally` before the caller can mark. An SDK `async prompt` can already have returned
   > a promise or done work; its rejection is not a synchronous pre-start proof.

3. The critique's measured evidence (the scratch harness that no longer exists), verbatim:
   > `(cd /tmp/brl437/c1 && ./node_modules/.bin/vitest run src/__tests__/transport-retry-start-classification.test.ts -t POST-PROMPT --reporter=verbose)` injects a timer throw and, separately, a returned-promise `.then` getter throw. **Each:** real factory + real session-manager, controlled fake SDK: prompt 1, fake work microtask wrote `work-progress`, callback site 0, source notices 1, no toast, attempt-2 running agent + registry + session file; even after settling the fake work the agent stayed `running` because no settle handler attached. Both diagnostics falsely say spawn rejected.

4. The marker experiment, verbatim (critique, "Verified sound"):
   > Additional `/tmp/brl437/c3` vs `c4` post-return fault with only `markStarted` argument removed:
   > source 0→1, proving that marker has useful defense **after return**, but none for the actual
   > prompt→return window. `/tmp/brl437/c7` vs `c8` moves a scratch signal to immediately before prompt
   > and removes only that call: post-prompt fault tests green→red, source 0→1. This is a classification
   > probe, **not** a complete fix: records remained running and logs still lied.

5. The caller-side fault was measured separately in the critique (§critique "major" row 2):
   > controlled `setInterval` throw: ordinary dispatch `spawns=1,isError=true,active=1,registered=1,timers=0`;
   > retry `spawns=1,source=0,timers=0` but logs `spawn rejected — surfacing the original failure`.
   > Ordinary post-start paint throw instead gives `isError=false,spawns=1`.

   My R3 reproduces the caller-side half of this independently (§1.2).

**No longer reproducible, stated explicitly:**

- `/tmp/brl437` and every `/tmp/brl437/{c1…c9}` copy are **gone** (`ls /tmp/brl437` → absent). The
  POST-PROMPT test file `transport-retry-start-classification.test.ts` exists nowhere in the repo
  (`find src -name '*start-classification*'` → nothing), the `work-progress` fake and the driver
  scripts (`driver3.mjs`, `driver4.mjs`, `c1-real-loader.mjs`) are gone, and the full-suite logs
  `/tmp/brl437/{base2,s1}-c1-full.log` are gone.
- The issue comments themselves are not readable from this checkout (no network); only the five local
  records are. Their content is therefore *quoted*, not re-verified, and the three sizes named in the
  dispatch match the three records above.
- What I *did* re-establish independently: the session-manager half of (3) (S3/S4), the caller-side
  half (R3), the conductor-side surface (R1/R2), and the boot-scan false positive (§3.2).

---

## 8. Test feasibility and cost (D8)

**Can every outcome be reproduced in vitest without a live provider? Yes,** and it was, in this
investigation:

- the session-manager window: `vi.mock("@earendil-works/pi-coding-agent")` returning a controlled
  `createAgentSession` (the pattern of `session-manager.test.ts:7-59`) — S1–S5, A1/A2, B, C, D, E1–E4;
- durability and the boot scan: the **real** `SessionManager`, the real registry and the real
  `recoverInflightRuns` (`w439c`) — no mock needed;
- the conductor branch: already trivially mockable — `transport-auto-retry.test.ts` mocks
  `spawnBackgroundSession` and exposes `retrySpawn()` (`:617-620`); my R0–R3 are four added cases in a
  clone of that file.

**What a C1-standard proof would require**

- *Mutants* (each must go red on a named case): (M1) attach the handlers after `prompt()` again → S3/S4
  green→red; (M2) remove the started/unknown signal → the classification case green→red (the #437
  `c7`/`c8` result); (M3) remove containment of the caller's post-spawn tail → R3 green→red; (M4) swap
  `registerInflightRun`/`appendEntry` order in `persistRunRecord` → the D3 case green→red. The #437
  critique's warning applies: a mutant killed only by a *missing log line* is not a kill.
- *Fault matrix*: 7 throw sites (P2, P3, P5, P9, P10, caller-post-spawn, event listener) ×
  {throws, does not throw}; 4 prompt shapes (sync/non-async reject, async reject, never-settles,
  resolve-on-abort); 3 terminal shapes (no message, provider error + transport text, provider error
  without text); 3 conductor classes (succeeds / started-then-throws / rejected pre-start) ≈ **20–24
  cases**. My scratch set is 29 new cases over 6 files (56 total minus the clone's 24 pre-existing cases).
- *LOC*: the scratch files total **1,922 lines**, of which **1,007** are the cloned
  `transport-auto-retry.test.ts`; the new evidence is ~915 lines across 6 files, written with `console.log`
  evidence rather than assertions. A production version needs assertions and house-style comments;
  scaling the scratch cases (~34 lines/case in `w439-harness`) puts a 20-case matrix at **~500–680
  lines**, and a trimmed 14-case version at **~330–440**.

**Budget.** Measured at HEAD with the script's own rule (`scripts/check-test-budget.mjs`): test
**46,769** / source **23,699** = **1.9735**, ceiling 2.0 → **629 lines of headroom**. A 330–440 line
matrix fits only if nothing else grows; a faithful 20-case matrix in the house style does not fit
without repayment. **Flag:** any proposal that adds the full matrix as-is cannot fit the budget — it
must either be trimmed to the decision-critical cells (S3/S4, B, C, E1, R1/R2, D3 false positive) or
offset by deleting superseded tests (the F1 sync-throw test, `session-manager.test.ts:1979-2009`, is a
candidate: it pins a shape the real SDK cannot produce, 31 lines).

---

## 9. Decisions this investigation leaves to the maintainer

No recommendation is implied by the ordering below.

### Decision A — adopt vs unknown

**A1 "accepted = started" (adopt).** Treat `prompt()` returning as the point of no return, and suppress
the source notice whenever the spawn returned an agent.
- Facts that support it: with the real SDK the only throws in the window require an injected fault
  (S3/S4); the run genuinely started in those injections; the alternative (reporting a source failure)
  produces a false diagnostic (R1) and invites a duplicate manual re-dispatch.
- Facts that cut against it: acceptance does not prove provider contact (D2 verdict, E1/C); a spawn
  that returns an agent can still be a run that never produces a turn; and the *caller* can throw
  after the return (R3), where "returned an agent" is not even observable to the catch.
- Blast radius: `scheduleTransportRetry`'s return value semantics, the source-notice branch
  (`index.ts:4270-4285`), and every test that asserts "no source notice ⇒ retry succeeded"
  (`transport-auto-retry.test.ts` — its 24 existing cases pass unchanged against today's code; my clone added R0–R3).

**A2 "accepted = unknown" (tri-state).** Carry `not-started | attempted-unknown | started` out of the
spawn, and let the retry branch treat `attempted-unknown` conservatively (claim retained, source notice
suppressed or explicitly marked uncertain, never retried again).
- Facts that support it: rejection does not prove not-started (B); the durable marker already cannot
  distinguish the two states (§3.2); the #437 design itself specified an `outcome-unknown` class and
  bounded the guarantee to at-most-one attempt.
- Facts that cut against it: every post-start fault then yields a notice that says "unknown", and
  nothing in the current history/dashboard vocabulary can render that state (§6); the state must be
  threaded through `spawnBackgroundRun`'s `ToolResult` shape and the claim policy, which is a larger
  diff than A1.
- Blast radius: same as A1 **plus** the run-record/history status vocabulary, `get_subagent_result`,
  and the recovery surface (which keys on `interruptedAt`, not on acceptance).

Facts that bear on the choice either way: R1 and R2 are byte-identical at the user surface today; the
durable marker is written before the point of no return and survives the paths that never reach it
(S1/S2 → false "interrupted" at next boot); and `claimTerminalNotice` is per id with a 200-id cap that
forgets every claim on overflow (#440).

### Decision B — the notice contract

The choice is between (i) **exactly one notice per source dispatch** (the retry either replaces the
source notice or the source notice is the only one), and (ii) **at-most-one attempt, with an explicit
uncertainty outcome allowed**. What the measured facts fix:

- The retry's own terminal event carries a **new id** and therefore its own claim, so a started retry
  that also produced a source notice yields **two** notices for one dispatch — R1's shape.
- The source notice is delivered *after* `claimTerminalNotice(sourceId)` has already been consumed, so
  there is no second chance to correct it later in the same process.
- `TRANSPORT_RETRY_TOAST` is the only signal that distinguishes "retry scheduled" from "retry failed",
  and it is emitted **after** the spawn returns (`index.ts:4290`) — a started-then-thrown retry never
  reaches it (R1: `toast: []`).
- The crash-notice path is not a fallback for a started-unknown run: it requires the poller, which
  never exists in that class (§4).

Open sub-questions the facts do not settle: whether a started-unknown retry should keep the source
notice suppressed (risk: silence) or deliver it with uncertainty wording (risk: a duplicate report of a
run that is still going); and whether the history vocabulary needs a fourth status ("Unsettled") to
make the state visible at all.

---

## Appendix — measured vs read vs recovered

| Claim | Status |
|---|---|
| S1/S2/S3/S4/A1/A2/B/C/D/E1–E4/R0–R3, timer ordering, boot-scan dead/live owner, durability of `appendCustomEntry`, `appendEntry` throws, all D6 literals, LOC ratio | **measured** in `/tmp/brl439` |
| `eventBus.emit` non-throwing; `log.*` non-throwing; `persistAgent` non-throwing; `registerInflightRun` non-throwing; `prompt` is `async`; no production subscriber to `subagent:created`; caller block ordering; shutdown leaves background runs running; `sweepStaleLiveSubagents` keys on `completedAt` | **read** (file:line cited inline) |
| The #437 POST-PROMPT results, the `c3`/`c4` and `c7`/`c8` marker experiments, the caller-side `setInterval` numbers, the issue comments | **recovered** (quoted; harness gone) |

**Not tested, and why:**

- **No real process kill.** The crash window is simulated by writing the registry entry the pre-start
  paths leave behind (S1/S2) and running the **real** boot scan against a dead owner identity. A real
  `SIGKILL` between the registry write and the prompt would produce the same durable artifact; it was
  not performed because the outcome is determined by the record, not by the signal.
- **No `/reload` / `/new` interleaving.** #437 measured that; this investigation keeps a single
  runtime generation. The #439 facts do not depend on it: the throw paths leave their residue before
  any generation change.
- **No live provider.** E1's "resolved with no assistant message" is produced by a stub that resolves
  immediately; whether the real SDK can resolve that way after a transport drop is **not** established
  here (the SDK's `runWithLifecycle` normally converts a drop into a `stopReason: "error"` message,
  which E2/E3 cover). E1 is therefore evidence about *this code's* classification, not about the SDK's
  failure modes.
- **No timing measurement of provider acceptance.** "Accepted ≠ started" is established from the API
  contract and from E1/C; no attempt was made to observe a provider handshake.

# #616 — `stop_subagent` reports success on a superseded agent — spec **r1**

**Issue:** #616 (tooling; filed 2026-11-28 after a live incident) · **C1** (teardown/concurrency) · worktree **y**.
**jev:** medium (0.89) · C1 · worktree y — classifier on the implementation brief; the level is an observation, the risk class governs review depth (full adversarial review).
**Written against:** `dev @ e6958f4` (handoff-verified). **Status: awaiting the maintainer's design nod** — the issue names three fix directions and says "pick one, do not do both blindly".

---

## Recon (Rule 13 — codegraph @ e6958f4, then grep)

```
$ bash .pi/skills/worktree/recon.sh stopAgent --grep
## Recon (Rule 13 — codegraph @ e6958f4)
- target: `stopAgent`
- callers(stopAgent):
  - 3 caller(s)
  - src/__tests__/background-session-persistence.test.ts:1 (background-session-persistence.test.ts)
  - src/__tests__/session-manager.test.ts:1 (session-manager.test.ts)
  - src/agent-tools.ts:62 (createAgentTools)
- impact(stopAgent, depth 2):
  - 7 affected symbols across 6 files
  - files: src/session-manager.ts, src/__tests__/background-session-persistence.test.ts, src/__tests__/session-manager.test.ts, src/agent-tools.ts, src/__tests__/s5-factories.test.ts, src/index.ts
- grep delta: 42 raw hits for `stopAgent` (incl. comments/strings)
```

**grep delta, reconciled.** The graph names the three callers and the impact set. grep adds what the
graph cannot: (a) the stop tool's *message literal* (`src/agent-tools.ts:313`, the string that lies),
(b) `stop_subagent` mentions in user-facing docs/tests (46 hits total, 42 with `stopAgent`), and
(c) the **absence** of any test that drives `stop_subagent` through a lineage — the graph shows
`agent-tools.ts` is called only by `index.ts`, so there is no existing stop-tool test to extend, only
the `get_subagent_result` lineage suite to imitate. No graph gap found.

**Read (terminal call boundaries, not just symbols):**

- `src/agent-tools.ts:284-317` — the stop tool. `const agent = await stopAgent(params.agent_id);`
  then, for **any** non-null return, `Stopped agent ${params.agent_id} (${agent.description}).`
  It does **not** call `resolveAgentId` (no 8-hex prefix support) and does **not** call
  `findRetryLineage`.
- `src/session-manager.ts:1523-1553` — `stopAgent(id)`: `getAgent(id)` (exact id), and when the
  status is already `completed`/`failed`/`stopped` it **returns the agent unchanged** (line 1526-1529:
  "Nothing to stop — already terminal"). Otherwise it stamps `aborted/aborted`, flips the status to
  `stopped`, and aborts `agent._sessionRef` if present. **The primitive is honest; the caller's
  message is what lies** — a terminal return is indistinguishable from a performed stop.
- `src/agent-tools.ts:104-112, 170-183` — `get_subagent_result` already does the lineage work:
  `resolveAgentId` (prefix resolution; `src/session-manager.ts:869`) and `findRetryLineage`
  (`src/session-manager.ts:1200-1241`), and it already prints
  `Superseded by <id> (attempt N, <status>, started …)` for a terminal record whose family has a
  newer attempt. **The reader exists; only the stop tool does not use it.**
- `src/session-manager.ts:793-801, 1167-1190` — `RetryRecordIdentity` carries `status`, `attempt`,
  `startedAt`; `identityFromRegistry` reports a registry-only run as `running`. So "which attempts
  are live" is already computable from `lineage.family` (+ `lineage.inflight`).
- `src/terminal-notifier.ts:309-360` + `src/history.ts:209-231` + `src/background-pipeline.ts:941-967`
  — the transport auto-retry re-enters `spawnBackgroundRun` with the source run;
  `newDispatchIdentity(source)` gives `attempt + 1`, the **same `dispatchId`**, and `resumeOf =
  source.id`; `resolveRetryParams` inherits `label: params.label ?? run.label`. So the retry is a
  *different agent id under the same label*, joinable by `dispatchId`.
- `src/recovery-engine.ts:154-166` + `src/delegate-handler.ts:1543` — a **manual** retry
  (`retryRunId`) mints its identity through the same `newDispatchIdentity`, so manual and automatic
  retries are indistinguishable members of one dispatch family.

---

## The defect, restated in those terms

The stop tool's postcondition should be *"nothing of this dispatch is running"*. It actually reports
*"the id you named returned a record"* — and `stopAgent` returns a record for an id that died minutes
ago, while the live attempt is a **different id**. Observed 2026-11-28 twice on `review-612`: the
stop reported success on `cd6efa1c` (already failed on `UND_ERR_SOCKET`), attempt 2 `445406ea` ran on
and wrote a merge-gating `approve-with-nits` record nine seconds before it too was killed.

---

## Design — the three issue directions, and the one taken

| Direction | What it fixes | What it leaves broken |
|---|---|---|
| **A. Stop the lineage, not the id** | The retry actually stops; the postcondition holds | Still needs an honest message, or the conductor cannot tell what was stopped |
| **B. Report the supersede in the stop result** | The lie becomes visible; the live attempt can be stopped by a second call | The stop itself still does nothing; a conductor who reads only the first line is still wrong about the run being dead |
| **C. Fail/warn when the target is superseded** | No false success | Work keeps running; the caller must issue a second stop |

**Taken: A, with B's reporting folded in as the message contract** (not as a second mechanism — it is
the same call's result text). C is rejected as the primary design: "your call failed, try again" is a
worse contract than "the dispatch is stopped", and the incident shows the cost of a stop that does not
stop. B alone is rejected because it leaves the retry alive by design.

### Exact shape (the implementation is a composition, not a rewrite)

`stopAgent(id)` stays the single-agent primitive (its terminal no-op is correct and tested).
The **tool handler** (`src/agent-tools.ts`, stop tool only) becomes:

1. `resolveAgentId(params.agent_id)` — same resolution as `get_subagent_result`; an ambiguous prefix
   refuses (one line, same shape as the result tool's refusal), an unresolved id keeps today's
   `Agent <id> not found` error.
2. `const lineage = findRetryLineage(agentId)`; the **family** is the dispatch family (by
   `dispatchId`, falling back to direct `resumeOf` children — the reader's existing rule).
3. **Live** = family members whose `status` is non-terminal (`pending`, `running`, `steered`), ordered
   `attempt`, then `startedAt`. In the real lifecycle at most one is live (the retry is armed only
   after the source settles), but the code must not assume it: it stops each and reports each.
4. `await stopAgent(id)` for each live id, **sequentially**; a throw on one does not abort the others
   (collect, then report).
5. Post-run **verification from records, not from the primitive's return**: re-read each stopped id
   and require a terminal status (`stopped`, or the terminal status it settled to). The result text
   is built from those reads — "Stopped" only for ids whose record now reads terminal *and* that were
   live when we started.
6. **No live member**: do not say "Stopped". Report the family's terminal picture
   (`nothing running — <id> attempt N is <status>`), `isError: false` (the requested end state holds).
   A record that is absent from the store but present in the registry as `running` is reported
   honestly (`registry lists <id> as running, but no live record/session was found`) rather than
   claimed stopped — and is **not** an error, because it may be a just-spawned run whose record is
   about to land; the message says what was seen.

### Message contract (one line per attempt, stable substrings a test can pin)

- Stopped: `Stopped agent <id> (attempt N, <description>) — the stop target was a superseded attempt; its live retry was stopped instead.` when the requested id was terminal and another member was live; otherwise the existing `Stopped agent <id> (<description>).`
- Nothing live: `Agent <id> is already <status> — nothing of this dispatch is running.` (+ the family line when there is more than one attempt)
- Partial: any live id that did not reach a terminal status is named with its observed status, and the call is `isError: true` (a stop that did not stop is a failure, not a footnote).

---

## Falsifiers (each is executable and must be able to fail)

1. **Dead attempt 1, live attempt 2** → the call stops attempt 2 (its record flips to `stopped`),
   the text names attempt 2's id, and the text does **not** contain `Stopped agent <attempt1>`.
2. **All-terminal family** → no `Stopped ` prefix anywhere in the text; the text names the terminal
   status; `isError` false. (Kills direction-C-only behaviour and the current lie.)
3. **Single live agent, no lineage** → byte-identical to today's `Stopped agent <id> (<description>).`
4. **Cross-dispatch isolation** → a second dispatch's live attempt is untouched (status unchanged;
   no abort call observed on its session).
5. **Manual retry joins the family** → a `retryRunId` retry of the same dispatch is stopped by a
   stop aimed at the original id (this is the decision requested below).
6. **Prefix id** `99f4e815` resolves and stops; an ambiguous prefix refuses without stopping anything.
7. **Registry-only live attempt** (no persisted record yet) → reported as seen, never as stopped,
   never as `not found`.
8. **Idempotence** → a second stop of the same dispatch reports "nothing running", performs no second
   abort, and does not error.

**Mutation targets (each must redden its falsifier):** replace the family-live set with `[found]`
(the current behaviour) → F1; drop the "no live member" branch → F2; stop the requested id first
regardless of liveness → F2/F8; use `resumeOf`-only matching → F1 against a grandchild attempt
(dispatchId family); resolve with `getAgent` instead of `resolveAgentId` → F6; skip the post-stop
record re-read → F7.

---

## Tests

New `src/__tests__/stop-subagent-lineage.test.ts`, modelled on
`get-subagent-result-lineage.test.ts`: `initExtension(mockPi)` captures the registered
`stop_subagent` tool, `createTempEnv("brl-616-stop-lineage")` gives temp agent + registry stores, and
each case seeds records/registry entries as the existing suite does. Real handler, real records; the
only stub is `stopAgent`'s session (`_sessionRef.abort` a spy) so "aborted exactly once" is
observable. One integration case (case 1) goes through the real `stopAgent` for the live attempt so
the status flip is real.

---

## Out of scope (recorded, not fixed)

- **The retry inherits the label** (`history.ts:211`), so `--settle <label>` and the provenance log see
  one name for two agents. It is adjacent, not the same defect: it corrupts the *process* record, not
  the stop contract. Fixing it changes settle-key semantics and deserves its own issue.
- The auto-retry policy itself (`background: true`, attempt 1, transport signature) — unchanged.
- `get_subagent_result`'s message shape — already correct; the new tool text should not copy it
  verbatim, but must not contradict it.
- The foreground retry path (`retryRunId` → foreground) — the stop tool only addresses background
  agents today (`_sessionRef`), and this spec does not widen it.

## Risks / open questions

1. **Family scope is a decision, not a detail**: `newDispatchIdentity` is shared by the transport
   retry and the manual `retryRunId` retry, so "stop the lineage" also stops a deliberate manual
   retry. Recommended: yes — the tool's contract is *dispatch-scoped* ("stop this dispatch"), and a
   conductor who wants one attempt can name its live id (which is the latest member anyway). If the
   maintainer prefers automatic-retries-only, the record needs a provenance field to tell them apart —
   new persisted state, not additive-safe.
2. **Stopping several agents** is teardown: sequential aborts, no parallel `Promise.all` (one abort
   throwing must not hide another's failure), and no new timer. The existing per-agent abort is
   try/caught; the composition adds the collection only.
3. **The status flip precedes the abort** (`session-manager.ts:1536-1548`); the post-stop re-read can
   therefore see `stopped` while the abort is still settling. The verification is on the *status*, which
   is what "the conductor reads as dead" means; the abort's own failure is logged by the primitive.

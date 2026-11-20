# #542 — a pre-start failure settles the agent record, not only the run entry — spec **r3**

**Issue:** #542 (harden) · priority **low** measured, **C1** · `fix: mechanical` · worktree **n** ·
review **C2 focused** · cycle `settle-handlers`, **U2** (next: **U3 = #543**).
**Spec r3:** 2026-11-20, against `dev @ 104069a` (source unchanged since `ba5e9f1`). `git status
--porcelain` → **0**; every probe ran on copies under `/tmp/brl542r3/`; the repository was never written.
**Status:** decision-ready. Two measured pushbacks: the **write order deviates from #466's** (§Contract)
and **two crash windows are not closed** here (§Residual window). r3 answers round 2 (H1–H6).

---

## r3 changes (r2 → r3)

| # | r2 | r3 | Measured |
|---|---|---|---|
| **H1** | disclosed only a kill **between** the run-entry write and the record flip; #546's remedy ordered its marker after the run-entry write | a **distinct** intra-STEP-A window (§Residual window **W-0**): `finalizeRunEntry` retires the registry **before** appending, so a kill there leaves `agent=running`, run entry `running` (**uncommitted**), registry retired, session dir pruned. #546 is **corrected by comment** (2026-11-20): the marker must be written **before** registry retirement. **Not claimed fixed.** | SIGKILL probe (§Evidence **B4**): `AGENT_STATUS=running`, `COMPLETEDAT=None`, `COMMITTED_RUNS=['running','running']`, `REGISTRY_ENTRIES=0`, `SESSION_DIR_EXISTS=False` |
| **H2** | contract: "after the run entry is terminal" (unconditional) | contract: "after the run-entry write is **ATTEMPTED**", with the designed consequence stated (STEP A failing still flips the record and writes the note; the residue is `agent=failed`, run entry uncommitted). Test (b) pins **committed** separately from **attempted**. Contract text in this spec == the helper's doc, verbatim. | (b) observes the streams separately: `ATTEMPTED=failed COMMITTED=running AGENT=failed`. r2 read `lastRunEntry()` (mock calls, including the throwing one), so it could not tell them apart — the critique measured a mutant slipping past it |
| **H3** | A3 pinned only the run entry (`acceptedAt: null`) | A3 extended: in-memory **and** disk terminal record (`status`, `completedAt`, `error`), ref released, `acceptedAt: null` preserved | mutant skipping the flip on the `accept-boom` path: r3 A3 **fails** (`expected 'running' to be 'failed'`); the r2 file on the same mutant: **145 passed** |
| **H4** | advertised 6 cases; the file had 5; baseline 8 red; tests +155 | **distinct (e)** added (fault-free exactly-once + no capture); **6 logical cases / 7 executed**; counts re-measured (**10 red / 136 passed**, **146** green, tests **+203**); Acceptance 3 no longer cites (c); over-allowance declared | §Tests, §Baseline-red, §Delta |
| **H5** | "recompute the flow verdict" from the working tree | sketch step 10: **commit first**, then the cockpit command `node scripts/check-test-budget.mjs --flow --base dev --head <final sha>`; record base + head + exit + output; rerun on any commit change | `check-test-budget.mjs:45-50` (reads Git; `--head` required); `merge-guard.sh:331` |
| **H6** | M7 was "revert the helper", which fails the tripwire at clause (1) | M7 is the **settle-entry mutant** — call `resolveSettled()` on the sync-throw path — and fails at **clause (4)** `settleEntryRecords()` | `expected [ Array(1) ] to deeply equal []`, message "a settle body was ENTERED on the sync-throw path"; the old M7 fails earlier at `to contain 'Transcript completed: failed'` |

## r2 changes (r1 → r2), carried

F1 order swapped (B1/B2); F2 emit after the prune decision (real-bus B3, case (h)); F3 every property
mandatory, `noteCount` counts; F4 `updateAgentStatus` totality qualified (D3); F5 M5′ replaces the
artefactual M5; F6 the real worktree suite and a recomputed delta.

---

## Recon corrections

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| **R1** | "`updateAgentStatus` can throw via `eventBus.emit` (a throwing listener skips the run entry and the transcript)" | **Half true.** `emit` wraps every listener in its own `try/catch` (`event-bus.ts:58-88`), so an ordinary listener throw is logged and swallowed — measured **D3**: `EMIT_ORDINARY=<no throw>`. But the catch's own logger can throw: a throwing log sink makes `emit` throw — **D3**: `EMIT_SINK=sink blew`. So `updateAgentStatus` can throw only through its error-reporting path (the #543 console-mirror class, out of scope). | `event-bus.ts:58-100`, `logging.ts:158`; **D3** |
| **R1′** | (implied) therefore containment does not matter | **Still matters.** #542 puts three writes in one step, so "one try, three writes" lets a fault in the first suppress two more — and the suite forces a throwing emit through the bus mock today (`session-manager.test.ts:86-105`, used at `:3630`). The `markBranchSpawnFailed` comment already *claimed* per-step containment while the body was one try/catch. | **M4** kills (a) and (b) |
| **R3** | "the fix is additive; F1's test pins nothing" | **True of F1, false of the suite.** The #450 sentinel tripwire (`:3787-3812`) asserts `not.toContain("Transcript completed")` and `not.toContain("subagent:failed")` on the same sync-throw path; #542 gives both a second producer. Inverting the two clauses while keeping the settle-entry marker, the positive control and the timer clause **preserves the tripwire's intent** (clause (4) `settleEntryRecords() === []` is the property's real instrument, untouched). Not narrowing costs **2 failed**. | **R3**; §Tests edit 3 |
| **R4** | "three call sites" | **Four defects, five sites.** `markBranchSpawnFailed` never clears `agent._sessionRef`, and the ref is set at `:2051` — before the block at `:2125` — so both refusal sites leak the live session graph on the baseline. | **X2**; §Baseline-red |
| **R2** | `completeTranscript` total? | It no-ops for a *missing* file (`transcript.ts:114-127`) but is **not total**: a directory at the path throws `EISDIR` (probed as test (c)). | (c) |
| **R5** (new r3) | "the run entry is terminal when the event fires" | **Only when the append commits.** `persistRunRecord` retires the registry **then** appends (`run-registry.ts:345-352`), and containment deliberately continues after a failed append — so on that fault the last committed entry is `running` while the agent record is `failed`. Stated in the contract and pinned by (b). | §Contract; (b) |

A/B/C are `:2046`/`:2544`/`:2829`, each followed by `throw`; `captureAndReleaseSession` (`:2061`) is
declared below A (TDZ there is real); `finalizeRunEntry` never reads `agent.status`; `persistAgent` never
throws; ADR 0026 D5 governs.

---

## Context — the defect, reproduced

Recorded as **E7** in the #450 spec; reproduced on `ba5e9f1` and re-derived on `572cda4` (test (a) fails
on HEAD: `expected '<no subagent:failed>' to be 'failed'`):
`GETAGENT=running SESSIONREF=set DISK_STATUS=running LAST_RUN=failed EVENTS=["subagent:created"]
NOTE=undefined`. The run entry is `failed`, the record `running` in memory **and on disk**, `_sessionRef`
holds the live session, and there is no note and no terminal event: `failPreStart` stops at the run entry.

### Anchors (re-derived from `104069a`; re-grep before editing)

| Anchor | Line | Role |
|---|---|---|
| `agents.set(id, agent); persistAgent(agent);` | `:1621-1622` | the durable `running` record — exists before every pre-start throw |
| `const finalizeRunEntry = (` | `:1724` | prune/retention gate at `:1754`, gated on `!agent.interruptedAt` |
| `let deadlineHandle` | `:1971` | the insertion point for the helper sits just below this |
| `const failPreStart = (message: string)` | `:1994` | deadline → teardown → **flip** → registry retire |
| `const markBranchSpawnFailed = (message: string)` | `:2032` | **deleted**; its comment is the #466 order claim |
| `transcript.startTranscript(agent.id, params.task);` | `:2044` | first pre-start throw — **the helper must be initialised above this line** |
| `failPreStart(neverIssued(err));` + `throw err` | `:2046-2047` | **call site A** (ref not yet set) |
| `agent._sessionRef = session;` | `:2051` | the ref becomes live |
| `const captureAndReleaseSession = …` | `:2061` | declared **below** A — TDZ (and it would fabricate output) |
| `markBranchSpawnFailed(reason); clearInflightRun(id); throw` | `:2170-2172` | branch refusal #1 (stuck owner) |
| `markBranchSpawnFailed(`…`)` in the setup catch | `:2278-2280` | branch refusal #2 (setup throw) |
| `failPreStart(sanitizeErrorMessage(reason, effectiveCwd));` | `:2829` | **call site C** |

B (`:2544`) and C (`:2829`) share the shape. "Every throw funnels":
`awk 'NR>=2050 && NR<=2835 && /throw /'` → `:2172`, `:2211`, `:2217`, `:2265`, `:2280` (inside the branch
`try` → its catch → the helper), `:2545`, `:2830` — three `failPreStart` sites + two branch = **5**.

---

## The contract block — crash window, attemptedness and reentrancy, one statement

*These are the words that go in the helper's doc comment; the spec and the code must not diverge.*

> **ORDER.** The three writes run **run entry → record flip → transcript**. This is deliberately NOT
> #466's record-first order, for two measured reasons:
>
> 1. **Crash window.** A kill after the run-entry append **commits** and before the record flip leaves
>    a **`running` agent with a terminal run entry** — not a terminal agent with an unfinalized run.
>    The first residue costs a stale row whose run entry already says `failed`, registry retired,
>    session dir pruned, and which no retry or interrupted-run surface can pick up (§Residual window,
>    **including the earlier window inside this step**). The second is F1's: an unfinalized `running`
>    run entry, a leaked registry entry, and a retained session dir only a manual sweep removes.
> 2. **Reentrancy.** The `subagent:failed` event is emitted by the record flip — the **second** write.
>    So the run-entry prune/retention decision (`finalizeRunEntry`'s `!agent.interruptedAt` gate at
>    `:1754`) has already been taken when a listener runs, and a listener that synchronously sets
>    `interruptedAt` cannot change the retention outcome. Under the record-first order it can, and it
>    does: measured, the directory survives.
>
> **ATTEMPTED, NOT COMMITTED.** The event follows the run-entry write being **attempted**, not its
> having been committed. `persistRunRecord` retires the registry **before** it appends
> (`run-registry.ts:345-352`), so an append that throws leaves no terminal entry; and **each step is
> contained separately** — every caller rethrows the ORIGINAL failure (`failPreStart(…); throw err`),
> so no step may replace it or suppress another (`updateAgentStatus` is total only through its
> error-reporting path, R1/D3; the transcript note is not total at all, R2). The consequence on the
> STEP-A fault is stated plainly: the record flip and the note still happen, so the residue is
> **`agent=failed` with the run entry uncommitted (`running`)** — the designed outcome of a fault, not a
> second defect, and pinned separately from the committed case (test (b)).
>
> **NOTHING IS CAPTURED and the ref is dropped INLINE, outside every `try`.** `captureAndReleaseSession`
> is not used here: it would fabricate a `finalOutput` for a session that never produced one, and it is
> declared below call site A — a TDZ reference there. `persistAgent` strips `_sessionRef` anyway, so the
> release is memory-only and must nonetheless always run (the issue's second bullet).

**Falsifier for the contract:** a failed append represented anywhere as a **committed** terminal entry, or
a crash at any intermediate registry/append boundary whose residue this contract does not describe
(§Residual window **W-0**).

Against #466's intent: #466 fixed the *set and sequence* of writes for a refused spawn because its
reader surface was the agent record. The record is still written on every path; only the *relative*
order of two independent writes changed. ADR 0026 D4 does not require the record first; the ADR is not
edited — the deviation is recorded here, in the helper's doc, and in the PR body.

---

## Decision — Option B, order swapped

**One shared, per-step-contained three-write helper for all five sites.** `failPreStart` keeps its own
responsibility (deadline, teardown, registry retire) and delegates the terminal flip.

**Placement matters:** insert the helper **above `failPreStart`'s own doc comment** (directly after
`let deadlineHandle`, `:1971`), so neither doc block is orphaned and the helper is initialised above the
transcript start (`:2044`). Anywhere in that band is fine; a position **below** `:2044` TDZes call site A
(**M8**, measured: A2 fails with a `ReferenceError` instead of the original `ENOTDIR`).

```ts
  // doc comment: the §Contract block above, verbatim, prefixed by "Issue #465 (b) /
  //   #466 (ADR 0026 D4) / #542: the terminal write for a run that was PROVABLY never
  //   issued — the branch refusals below and every pre-start throw end here. ONE definition."
  const markSpawnFailedBeforePrompt = (message: string): void => {
    try {                          // STEP A — run entry (+ retention/prune, registry retire)
      finalizeRunEntry('failed', message);
    } catch (err) {
      safeLog(() => log.warn(`spawnBackgroundSession: pre-start finalize failed for ${id}`,
        { error: thrownMessage(err) }));
    }
    try {                          // STEP B — record flip (completedAt + error, emits subagent:failed)
      updateAgentStatus(id, 'failed', message);
    } catch (err) {
      safeLog(() => log.warn(`spawnBackgroundSession: pre-start record flip failed for ${id}`,
        { error: thrownMessage(err) }));
    }
    try {                          // STEP C — transcript note (no-op+warn when the file is missing)
      transcript.completeTranscript(id, 'failed');
    } catch (err) {
      safeLog(() => log.warn(`spawnBackgroundSession: pre-start transcript note failed for ${id}`,
        { error: thrownMessage(err) }));
    }
    agent._sessionRef = undefined;  // outside every try — cannot throw, must always run
  };
```

`failPreStart` (`:1994`) becomes: deadline clear → STEP 1 teardown (unchanged, contained) →
`markSpawnFailedBeforePrompt(message)` → STEP 3 registry retire (unchanged, contained). Its STEP-2
`try/catch` is deleted (the helper is total); its doc gains one sentence: the flip is the **full**
terminal flip (#542); the "pruning is provably safe here" argument is unchanged.

`markBranchSpawnFailed` (`:2032`) is **deleted**; both refusal sites (`:2170`, `:2278`) call
`markSpawnFailedBeforePrompt`. Function-scoped `const`, not an exported symbol —
`Structural closure: n/a — no moved/deleted exports` (2 call sites, renamed in the same edit) — and its
old "record flip -> run entry -> transcript" comment is replaced by the contract block above.

### The other steps, and why C is last

`failPreStart` keeps `clearTimeout(deadlineHandle)` (total), `cleanupWorkBranch()` and
`clearInflightRun(id)` (own `try` each) as they are; only STEP 2 becomes the helper call. **Why C last:**
it is the least load-bearing and the most likely to degrade (missing file → warn; `EISDIR`/`EACCES` →
throw, R2), so it sits where a fault can suppress nothing.

### Rejected options

| Option | Mechanism | Blast radius | Cost | Why not |
|---|---|---|---|---|
| **D — do nothing** | leave the record `running` | 0 | 0 | The defect: monitor/drill-in disagree with history/retry after every pre-start throw, and the session graph is retained. Low incidence, but the fix is 45 source lines. |
| **A — `failPreStart` delegates to the existing `markBranchSpawnFailed`** | one call, helper stays single-`try` | 3 sites | ~8 src lines | Fixes the record flip, but keeps the *documented-but-false* containment across three writes (**M4** survives), leaves the branch-refusal ref leak (**R4**), and leaves the comment lying. Rejected on those three counts, not on size. |
| **C — duplicate the writes in `failPreStart`** | copy A/B/C | 3 sites | ~20 lines | Two copies of a three-write terminal sequence is the drift the issue's fix direction forbids; #466's DRY threshold (2 occurrences) is already met. |
| **B (chosen)** | shared helper, **run entry first** | 5 sites | +45/−25 src (+207/−4 tests) | Fixes the three pre-start sites **and** the two refusals, keeps #450's containment discipline, makes the comment true, and gives the better residue + the safe emit position. With the r1 (record-first) order the same code is rejected by F1+F2. |

### Scope boundary — what this unit does not touch

- **REGIME 2** (#544's post-start boundary, `:2833-2884`): untouched; no new call from it.
- **REGIME 1's premise** (#450 D2.1, `:2798-2820`): untouched.
- **Pruning / retention / `.done` marker**: still exactly one `finalizeRunEntry` per path.
- **Branch-lock, scratch-dir, `.done` paths**: non-goals. **#543** (the console mirror) is out of scope;
  its fault class is why containment stays (R1).
- **The crash windows** (§Residual window, W-0 and W-1): explicitly **not** fixed here.

---

## Tests — every advertised property, mandatory

All of it lands in `src/__tests__/session-manager.test.ts`, which carries the harness (mocks at `:1-99`,
`createTempEnv` at `:149`, `lastRunEntry` at `:134`, `resetGitMocks` at `:738`). **One new `describe` = 6
logical cases (7 executed: `it.each` ×2)**, plus three edits to existing tests. The "synchronous
listener" pin uses the bus mock, whose implementation *is* a synchronous listener at the instant the real
bus calls one (`event-bus.ts:58-88` is a plain `for` loop); the real-bus variant is **B3**. The listener
case is titled `(h)` in the file (the r2 spec's `(f)`); r3 uses the file's labels.

| # | Property | Path | Pins |
|---|---|---|---|
| **(a)** | **order observable, and the flip's own fault is contained** (F3a, F1) | sync `prompt()` throw, `emit` throws on `subagent:failed` | `runStatusAtRecordFlip === "failed"` (the run entry exists **before** the record flip); record `failed`; **one** note; one event; ref released; registry empty; no `finalOutput`. Baseline-red: `'<no subagent:failed>'` — HEAD emits no event at all. |
| **(b)** | **run-entry fault continues; ATTEMPTED ≠ COMMITTED** (F3b, H2) | 3rd `appendEntry` throws; the mock records the **committed** stream | record `failed` **and** disk `failed`; one note; ref released; registry empty — A's fault suppressed neither B nor C — **and** `attempted.status === "failed"` while the last **committed** entry is still `"running"` (the acceptance record). This is the designed residue, pinned, not a second defect. Observed: `ATTEMPTED=failed COMMITTED=running AGENT=failed`. |
| **(c)** | **note fault still releases, original error wins** (F3c, R2) | directory planted at the transcript path → `EISDIR` | the fault is **not** mocked (`statSync(...).isDirectory() === true`); rejection is the original `sync preflight failure`; ref released; record `failed`; run entry `failed`. **This is the only pin that catches the release placement (M5′).** It does **not** assert a note count (the path is a directory — see Acceptance 3). |
| **(d)** | **both branch refusals terminal + released** (F3d, R4) | `it.each`: dirty tree / `createWorkBranch` throws | record + disk `failed`; ref released; **one** note; exactly one `subagent:failed`; run entry `failed`; registry empty — for **both** sites. Baseline-red on the ref. |
| **(e)** | **fault-free control: exactly once, nothing captured** (F3e, H4) | plain sync throw, **no** injected listener/append/transcript fault | `noteCount(id, "Transcript completed") === 1`; `failedEvents() === 1`; `finalOutput` **and** `result` `undefined`. Redundant with (a) on the counts **by design**: (a) counts under a fault, (e) proves the fault was not what produced the count. Baseline-red: `expected +0 to be 1` (HEAD writes no note). |
| **(h)** | **synchronous listener cannot change retention** (F2) | sync throw + a listener that calls `markAgentInterrupted` | `dirBeforeFlip === true` (there **was** a dir to retain); at emit time the run entry is `failed` **and** the dir is already gone; the listener ran (`interruptedAt` set); record `failed`. |

`noteCount` **counts**, never `.find()`:
`readFileSync(path,'utf-8').split("\n").filter((l) => l.includes(text)).length` (one note = one line).

### Edits to three existing tests

1. **No edit — log-string pin** (`:3748`): `expect(readLog()).toContain("pre-start finalize failed")`; the
   helper's STEP A keeps that exact wording (also reached from the branch paths).
2. **`A2 (S2)` extension** (r2, `:3423`): the transcript-start path already asserted the run entry and the
   registry; r2 added the record, ref, no-capture, one-event and the original `ENOTDIR` (**M8**, the
   helper's position). Unchanged in r3.
3. **`A3` extension** (r3, H3, `:3452`): A3 previously pinned only the run entry (`acceptedAt: null`).
   Extend it — **without** touching the write-count / `accept-boom` setup — with the terminal **record**,
   in memory **and** on disk:

   ```ts
   const id = (fakePi.appendEntry.mock.calls[0][1] as Record<string, unknown>).id as string;
   const record = getAgent(id)!;
   expect(record.status).toBe("failed");
   expect(typeof record.completedAt).toBe("number");
   expect(String(record.error)).toContain(PROMPT_NEVER_ISSUED_MESSAGE);
   expect(record._sessionRef).toBeUndefined();
   const onDisk = JSON.parse(readFileSync(join(env.storageDir, `${id}.json`), "utf8"));
   expect(onDisk.status).toBe("failed");
   expect(typeof onDisk.completedAt).toBe("number");
   expect(terminal.acceptedAt).toBeNull(); // still the acceptance-write residue
   ```

   **Falsifier:** a mutant that skips the record flip on the `accept-boom` path must fail A3. Measured:
   `if (!message.includes('accept-boom')) updateAgentStatus(...)` → r3 A3 fails `expected 'running' to
   be 'failed'`; the **r2** file on the same mutant → **145 passed**. So the extension is load-bearing.
4. **The #450 sentinel tripwire** (`:3787-3812`) must be narrowed — the unit's one semantic test change:

   ```ts
   // before
   expect(readFileSync(transcriptGetTranscriptPath(id), "utf-8")).not.toContain("Transcript completed");
   expect(emittedTypes()).not.toContain("subagent:failed");
   // after (#542: the note and the event now come from the pre-start flip, not a settle body)
   expect(readFileSync(transcriptGetTranscriptPath(id), "utf-8")).toContain("Transcript completed: failed");
   expect(emittedTypes().filter((t) => t === "subagent:failed")).toHaveLength(1);
   ```
   `not.toContain("subagent:completed")` stays; clauses (4) `settleEntryRecords() === []` and (5) one
   `clearTimeout` are untouched. **PR body justification:** the two narrowed clauses were #450's
   *instrument* for "no settle body ran", not its property — a transcript write and a terminal event used
   to have exactly one producer. Clause (4) is the real instrument and is still red for the settle-entry
   mutant (**M7**).

## Baseline-red proof (measured: HEAD + the **r3** test file)

`npx vitest run src/__tests__/session-manager.test.ts` on the `104069a` tree with the r3 test file →
**10 failed | 136 passed (146)**; with the swap → **146 passed**, `npx tsc --noEmit` exit **0**. (r2's
file: 8 failed / 137 passed of 145 — r3 adds (e) **and** makes A3 red on HEAD.)

```
A2 (S2), A3, (b)       → expected 'running' to be 'failed'      (c), (d)×2 → expected { sessionId: … } to be undefined
(e)                    → expected +0 to be 1                   (h)        → expected '<none>' to be 'failed'
#450 sentinel tripwire → expected '{"type":"system",…}' to contain 'Transcript completed: failed'
(a) ORDER              → expected '<no subagent:failed>' to be 'failed'
```

## Acceptance criteria

1. After a synchronous `prompt()` throw: `getAgent(id).status === 'failed'` **and** the persisted
   `<storage>/<id>.json` says `failed`; `completedAt` is a number and `error` is the sanitized pre-start
   message (a, b, e, A2, amended A3).
2. `agent._sessionRef`, `agent.finalOutput`, `agent.result` are `undefined` after the throw (c, e, A2).
3. The transcript carries **exactly one** `Transcript completed: failed` note — a count, not a find —
   on every path where that path is a file (a, b, d, e, h). (c) is excluded **by construction**: it
   plants a directory there, so its count is 0; (c) pins the release placement and error precedence.
4. Exactly one `subagent:failed` is emitted — **after the run-entry write is ATTEMPTED** — and
   `subagent:completed` never is (a, d, h). On a STEP-A append fault the attempt is `failed` while the
   last **committed** entry stays `running`: the designed residue, pinned by (b), not a regression.
5. The run entry keeps its shape: `failed`, same id/`errorMessage`, `finalTurnError === false`,
   `stopReason === 'error'` (the `F1` test at `:2657` passes **unedited**), and `listInflightRuns()` holds
   no entry for the id (a, b, d).
6. Callsite A (transcript-start throw) yields the terminal record, the pre-start stamp, a released ref,
   no fabricated output, **and** the original `ENOTDIR`/`ENOENT` (A2 extension + **M8**).
7. Callsite B (acceptance-write throw) yields the terminal record — **in memory and on disk** (`status`,
   `completedAt`, `error`), with `acceptedAt: null` preserved (extended A3, H3).
8. A fault in any single step of the flip suppresses no other step and never replaces the caller's
   original error (b, c, M4).
9. The #450 tripwire still fails if any settle body is entered (`settleEntryRecords() === []`) and still
   counts exactly one `clearTimeout` (**M7** = the settle-entry mutant).
10. `markBranchSpawnFailed` no longer exists; both refusal sites call the shared helper; the helper is
    initialised **above** the transcript start (`:2044`) and **above** `failPreStart`'s doc comment.
11. `npx tsc --noEmit` clean; `session-manager.test.ts` green; the **real worktree** full suite green
    (step 8); the flow verdict recomputed from the final committed diff (step 10), with §Delta's
    `Test budget:` line in the PR body.

## Delta — recomputed from the **final integrated diff** (ADR 0028)

`allowance(surface) = 120 + 2 × max(Δsource, 0)`, net lines, `--no-renames`, per surface
(`scripts/check-test-budget.mjs:12-16`), measured with `git diff --no-index --numstat` on `/tmp/brl542r3/`:

| Surface | + | − | net | allowance | verdict |
|---|---|---|---|---|---|
| `src/session-manager.ts` | 45 | 25 | **+20** | 120 + 2×20 = 160 (this is the *source* row) | — |
| `src/__tests__/session-manager.test.ts` | 207 | 4 | **+203** | **160** | **over by 43** |
| `scripts/**` | 0 | 0 | 0 | — | within (untouched) |

The source delta: one helper (+~30 with its doc), one deleted helper (−10), one step (−7), one call, two renames.

**Why over, and why it is not padding.** The r2 margin was 5; r3's mandatory additions are (e) (~15),
the (b) committed stream (~11) and the A3 record block (~17). A comment-stripped variant of the same
mandatory set measures **198/4 = +194** — still **over by 34** — so the overage is structural, not
verbosity. The PR body carries:

```
Test budget: over-allowance — #542's mandatory pins (distinct case (e), the committed-vs-attempted
assertion in (b), and the in-memory+disk record assertions in A3) cost +203 test lines against a
160-line allowance on a +20 source delta; no pin was dropped and src/ was not padded.
```

The cuts that got r2 from +198 to +155 are still in force (merged refusal `it.each`, counted `noteCount`,
A2 extension instead of a new callsite-A test). **Margin is −43 and moves with the source** (2 lines per
source line): never grow `src/` to "earn" allowance, never drop a pin — use the declaration.

---

## Mutants — measured against the final test set

Each row: the edit applied to the patched `src/session-manager.ts`, then
`npx vitest run src/__tests__/session-manager.test.ts`. `A2`, `A3`, `tripwire` are the touched pre-existing
tests.

| # | Mutant | Killed by |
|---|---|---|
| **M1** | delete STEP A (the run-entry write) | A2, A3, tripwire, (a), (b), (e), (c), (d)×2, (h) + 3 pre-existing |
| **M2** | delete STEP B (the record flip) | A2, A3, (a), (b), (e), (c), (d)×2, (h) |
| **M3** | delete STEP C (the transcript note) | tripwire, (a), (b), (d)×2, (e) |
| **M4** | collapse A+B+C into one `try/catch` (the pre-#542 body) | #450-normalises, (a), (b) |
| **M5′** | move `agent._sessionRef = undefined` **inside** STEP C's `try`, after `completeTranscript` | **(c)** — the release-placement killer |
| **M6** | call `updateAgentStatus` twice | A2, (d)×2, (e) |
| **M7** | **settle-entry mutant**: in the sync-throw catch, call `resolveSettled()` before `throw err` — a settle body is entered, nothing else changes | **tripwire clause (4)**: `settleEntryRecords()` = `[Array(1)]`, "a settle body was ENTERED on the sync-throw path". Clause (1) **passes** (the helper's note exists) |
| **M8** | declare the helper **below** the transcript start (`:2044`) | A2 — `ReferenceError` replaces the original `ENOTDIR` |
| **M9** | replace the inline release with `captureAndReleaseSession()` | A2 (TDZ), (a) (fabricated `finalOutput`) |
| **M10** | delete the inline release entirely | (a), (b), (c), (d)×2 |

**M7 corrected from r2 (H6).** r2's M7 reverted `failPreStart`'s STEP 2 to `finalizeRunEntry` only, and
the tripwire failed **earlier** at clause (1) (`to contain 'Transcript completed: failed'`) — the helper's
absence, not the settle-entry detector. The settle-entry mutant passes clause (1) and dies at clause (4)
`expected [ Array(1) ] to deeply equal []`. **M7 is that mutant.**

Corrected from r1 (F5): r1's M5 ("release into STEP A's `finally`") also removed the catch. Re-measured:
release-in-a-per-step-`finally` with the catch retained → **145 passed** (r2 file; 146 on r3). Any
`finally` on a per-step `try` equals a statement after the `try/catch` — not a mutant. M5′ replaces it.

Not killable, therefore not a mutant: *"keep `markBranchSpawnFailed` and duplicate the writes"* —
behaviourally identical for every test; rejected on DRY grounds (option C).

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| The narrowed #450 tripwire reads as weakening a pin | **medium** — review friction, not correctness | Instrument-substitution argument in the PR body; clause (4) `settleEntryRecords()` untouched and still red for the settle-entry mutant (M7 measured); the replacement asserts a **count**, which the old negative clause could not. |
| New user-visible behaviour: a pre-start failure now emits `subagent:failed`, so the completion-push wake can fire for a run that never started | low | Identical to today's branch-refusal behaviour (same `updateAgentStatus` call). `deliverCompletionAlert` is fully `try/catch`-wrapped (`terminal-notifier.ts:360-405`), deduped by `claimTerminalNotice`, and reads a run entry that now exists **before** the event fires — the swap makes this strictly safer. |
| `completedAt` becomes non-null; the ref release reaches the refusal sites | low | `finalizeRunEntry` does not read `completedAt`; `isStuckTerminalOwner` needs a *held* branch lock that STEP 1 has released. The ref release is measured (R4) and pinned by (d). |
| **Two crash windows** (§Residual window) and a flow that is **over by 43** | low, **documented** | the windows are stated, not claimed fixed; the remedy is a separate unit (#546) whose ordering is corrected. §Delta carries the documented `Test budget:` declaration — never drop a pin, never pad `src/`. |

## Execution sketch

1. `git status --porcelain` → empty; `git log --oneline -1`. Re-derive §Anchors with one
   `grep -n "failPreStart\|markBranchSpawnFailed\|captureAndReleaseSession\|transcript.startTranscript\|agent._sessionRef" src/session-manager.ts`.
2. Write the failing tests first (§Tests: the new `describe` incl. (e), the (b) committed stream, the A2
   and **A3** extensions, the tripwire narrowing). `npx vitest run src/__tests__/session-manager.test.ts`
   → expect **10 failed**, messages as in §Baseline-red; paste them into the PR body.
3. Cut `markBranchSpawnFailed` (`:2019-2039`, doc + const) and insert it **above `failPreStart`'s doc
   comment** (after `let deadlineHandle`, `:1971`), rewritten per §Decision — **run entry first** — with
   the §Contract block as its doc, verbatim. (The r2 probe patch placed it *between* the doc and the
   function; do not replicate that.)
4. Replace `failPreStart`'s STEP 2 (`:2004-2009`) with the helper call + the two comment lines, and add
   the one sentence to its doc comment (full flip; pruning unchanged).
5. Rename the two refusal call sites (`:2170`, `:2278`); replace the `:2159-2169` "record flip -> run
   entry -> transcript" claim with a pointer to the contract block; name the helper in REGIME 2's comment.
6. Run the file → **146 passed**. `npx tsc --noEmit` → clean. `node scripts/check-imports.mjs` → clean.
7. Apply M1–M10 one at a time in a `/tmp` copy (never the repo); record exit codes in the PR body.
8. **GATE — the real worktree full suite** (not a `/tmp` comparison): `npx vitest run` from the
   worktree → the change's suites green and **no new failing test name** against a pre-change run of the
   same command; record both name lists (an empty diff after stripping timings).
9. PR body: `## Design assumptions`, the narrowed-tripwire justification, the baseline-red output, the
   mutant table, the worktree-suite evidence, and §Delta's `Test budget:` line.
10. **GATE — the flow, from committed Git objects.** The flow reads `git diff <base>...<head>`, not the
    working tree (`check-test-budget.mjs:45-50`; `merge-guard.sh:331`), so **commit first**. Then from the
    **cockpit** repository root (the trusted copy — a PR that edits `scripts/**` must not grade itself):
    `node scripts/check-test-budget.mjs --flow --base dev --head <final sha>`.
    Record **base sha, head sha, exit code and the full output line** in the PR body. If any commit
    changes afterwards (amend, rebase, follow-up), **rerun on the new head**. A non-zero exit with
    §Delta's `Test budget:` line is the expected outcome, not a failure to be "fixed" by padding `src/`.

**Design assumptions (stateful checklist).** *(1) State:* one agent-record write and one run-entry write,
both to existing stores (`<storage>/<id>.json`, the session entry log, the run registry) — no new path,
file or lock. *(2) Teardown:* unchanged — `finalizeRunEntry` owns the `.done` marker, prune/retention and
the registry retire, and now runs **first**; a kill inside that sequence is §Residual window **W-0**,
disclosed, not repaired. *(3) Concurrency:* single-threaded spawn path, no `await` between steps; the only
synchronous reentrancy point (`subagent:failed`) now runs after the prune decision — B3. *(4)
Missing/partial:* each step is fail-open and the helper never throws; a missing transcript no-ops, an
unwritable one is contained (c); a failed run-entry append leaves the record `failed` with the entry
uncommitted (H2), which is the contract. *(5) Evidence:* B1–B4, D3, the 10 baseline-red failures, M1–M10.

---

## Residual window — stated, **not** claimed fixed

Two kill points in the shipped order, two residues; **boot recovery repairs neither** (measured end to end
with the production wiring, B1/B2/B4). **W-0 is new in r3 (H1) and is the earlier of the two.**

**W-0 — inside STEP A, after registry retirement and before the append.** `finalizeRunEntry` →
`persistRunRecord` retires the registry **before** it appends (`run-registry.ts:345-352`), so the kill
lands with the entry already gone and the terminal record never written:

| | kill between `clearInflightRun` and `appendEntry` |
|---|---|
| agent record on disk | `running` (no `completedAt`, no `error`) |
| run entry | `running` — the terminal write was **never attempted**; the last *committed* entry is the acceptance record (`running`, `acceptedAt` ISO) |
| registry entry | **retired** (0) |
| session dir | **pruned** (false) |
| scratch `.done` marker | present |
| boot scan (`scanned/skipped/marked`) | `0/0/0` — no candidate |
| restart-observable `getAgent(id).status` | `running` |

Measured (B4): `AGENT_STATUS=running`, `COMPLETEDAT=None`, `COMMITTED_RUNS=['running','running']`,
`REGISTRY_ENTRIES=0`, `SESSION_DIR_EXISTS=False`, `SCRATCH_DONE_MARKER=True`. **#546's remedy must not be
assumed to cover it:** #546 as filed ordered its `recordFlipPending` marker
*after* the run-entry write and before the record flip — but the registry entry is already retired by
then, so there is nothing left to update. **#546 is corrected by comment (2026-11-20):** the marker must
be written **before** registry retirement (into the registry entry immediately before `clearInflightRun`,
or carried in the entry the retire path reads), and the recovery verdict then applies it to the persisted
`running` record. This spec does **not** fix W-0 and does **not** create that unit.

**W-1 — between the committed run entry and the record flip** (the window r2 disclosed):

| | r1 order (record first) | **r2/r3 order (run entry first)** |
|---|---|---|
| agent record on disk | `failed` (terminal) | `running` (**stale**) |
| run entry | `running` (**unfinalized**) | `failed` (terminal) |
| registry entry | **remains** | retired |
| session dir | **retained** | pruned |
| boot scan (`scanned/skipped/marked`) | `0/0/0` | `0/0/0` |
| restart-observable `getAgent(id).status` | `failed` | `running` |

The swap **removes the F1 falsifier** (B2: present under r1; B1: absent under r2/r3) and the leaked
registry entry and retained dir — but the residue is **not** self-healing: the stale `running` record
survives every boot, and only `get_subagent_result` (`getAgent` → `loadAgent`) reports it. The contained
remedy (#546) is stated there; this unit does not contain it.

**Falsifier for §Residual window:** a crash at **any** intermediate registry/append boundary whose residue
is not one of the two rows above. W-0 was found by exactly that falsifier in round 2.

---

## Evidence

All probes ran on copies under `/tmp/brl542r2/` and `/tmp/brl542r3/` (node_modules symlinked) built from
HEAD + the swap; W-0 used a real `SIGKILL` from inside the writer. The repository was never written.

| ID | Claim | Probe | Observed |
|---|---|---|---|
| **B1** | the W-1 residue, and what boot does with it | `zz-542r2-boot.test.ts` on `crash-swap`: spawn → kill after write 1 → plant a dead owner → the **real** `recoverProduction` wiring | `RES_MEM/DISK=running`, `RES_REGISTRY=0`, `RES_SESSION_DIR=false`, `BOOT_SCANNED=0 MARKED=0`, `BOOT_DISK_STATUS_AFTER=running`, `RESTART_STATUS=running`, `BOOT_TERMINAL_AGENT_WITH_RUNNING_RUN=false` |
| **B2** | the r1 residue is the falsifier state | same test on `crash-r1` | `RES_DISK=failed`, `RES_REGISTRY=1`, `RES_SESSION_DIR=true`, `BOOT_SCANNED=0 SKIPPED=0 REGISTRY_REMAINS=true`, `BOOT_LAST_RUN_AFTER=running`, `BOOT_TERMINAL_AGENT_WITH_RUNNING_RUN=true` |
| **B3** | the reentrancy contract, **real bus** | `zz-542r2-listener.test.ts`: a real `on("subagent:failed")` listener sets `interruptedAt` synchronously | swap: `L_DIR_BEFORE_PRUNE=true`, `L_RUN_AT_EVENT=failed`, `L_APPENDS_AT_EVENT=3`, **`L_DIR_AFTER=false`**; r1 order: `L_RUN_AT_EVENT=running`, `L_APPENDS_AT_EVENT=2`, **`L_DIR_AFTER=true`** |
| **B4** | **W-0**, a faithful kill inside STEP A | `zz-intra-a.test.ts` on a `fix` copy whose `persistRunRecord` does `clearInflightRun(run.id); if (BRL_CRASH_INTRA) process.kill(SIGKILL);` before `appendEntry`; the append mock writes every committed entry to a JSONL file | worker died by SIGKILL; after: `AGENT_STATUS=running COMPLETEDAT=None`, `COMMITTED_RUNS=['running','running']`, `REGISTRY_ENTRIES=0`, `SESSION_DIR_EXISTS=False`, `SCRATCH_DONE_MARKER=True` |
| **O** | the ordering pin discriminates the order | the order block on `base` / `r1fix` / `fix` | `6 failed` / `1 failed` — **only** `(a)` (`expected 'running' to be 'failed'`) / all passed |
| **D3** | R1 qualified, both halves | real `emit` with a throwing listener, then with `setConsoleOutput(true)` and a throwing `console.error` | `EMIT_ORDINARY=<no throw>`; `EMIT_SINK=sink blew` |
| **T** | the final test set against the final source | `session-manager.test.ts` on `fix` | **146 passed**; `tsc --noEmit` exit **0** |
| **Δ** | the flow numbers | `git diff --no-index --numstat base/… fix/…` | src `45 25`; tests `207 4` → net +20 / **+203**; lean variant `198 4` → +194 |
| **S** | no regression observed outside the unit | full suite in `base` and `fix` (`/tmp` trees) | both **69 failed**; failing names identical after stripping timings (`diff` → empty) |
| **H3** | the A3 extension is load-bearing | `if (!message.includes('accept-boom')) updateAgentStatus(...)` on a `fix` copy | r3 A3 **fails** (`expected 'running' to be 'failed'`); r2 file **145 passed** |
| **H6** | M7 is the settle-entry mutant | `resolveSettled()` before `throw err` in the sync-throw catch | tripwire fails at clause (4): `expected [ Array(1) ] to deeply equal []`; the old revert fails at clause (1) `to contain 'Transcript completed: failed'` |
| **M** | M1–M10 killed, M5-old survives | mutant runs on `fix` copies | §Mutants |

## Not verified

- **The real worktree suite.** Running it writes into the repository, which this investigation may not do.
  The `/tmp` trees agree on their 69 pre-existing path-environment failures (**S**), but "the worktree
  suite is green" is **not** measured — sketch step 8, and it is the gate.
- **The flow verdict** (`scripts/check-test-budget.mjs --flow --base dev --head <sha>`) and
  `scripts/check-imports.mjs`: not run here (sketch steps 6, 10); §Delta applies the tool's formula to the
  integrated diff, it is not the tool's verdict.
- **The real SDK's `session.messages` on a never-started session** — the inline-release argument does not
  depend on it: (a)/(e) assert `finalOutput`/`result` are `undefined` for mock and SDK alike. The
  **completion-push wake** and **Windows/POSIX `EISDIR`** differences are also unmeasured.
- **Whether the shipped `.d.ts`/exports change**: none — the helper is a function-scoped `const` (`Structural closure: n/a`).

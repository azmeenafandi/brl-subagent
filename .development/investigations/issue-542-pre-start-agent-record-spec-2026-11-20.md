# #542 — a pre-start failure settles the agent record, not only the run entry — spec **r2**

**Issue:** #542 (harden) · priority **low** measured, **C1** · `fix: mechanical` · worktree **n** ·
review **C2 focused** · cycle `settle-handlers`, **U2** (next: **U3 = #543**).
**Spec r2:** 2026-11-20, against `dev @ 572cda4` (post-critique r1; source unchanged since `ba5e9f1`).
`git status --porcelain` on the repo → **0** lines; every probe ran on copies under `/tmp/brl542r2/`.
**Status:** decision-ready. Two things a reviewer will push back on, both measured: the **write order
deviates from #466's** (§The contract block) and the crash window is **not closed** by this unit (§Residual
window). Everything advertised is pinned.

---

## r2 changes (r1 → r2)

| # | r1 finding | r1 said | r2 does |
|---|---|---|---|
| **F1** | crash window: boot recovery does **not** repair "terminal agent + unfinalized run" | claimed recovery existed; record-first order | **Order swapped** to run entry → record → transcript (§Decision). Measured on both orders (§Evidence **B1**, **B2**): the swap removes the falsifier state (terminal agent + `running` run entry + leaked registry entry + retained session dir), replacing it with a `running` agent whose run entry is terminal, registry retired, dir pruned. Boot repair repairs **neither** — stated as a **residual window** with its own remedy, to be filed separately (§Residual window). |
| **F2** | reentrancy: a synchronous `subagent:failed` listener can flip the retention gate | "no await" treated as sufficient | The swap puts the emit **after** the run-entry prune decision. Measured with the **real bus** (§Evidence **B3**): listener sets `interruptedAt` → dir still pruned, event fires with the run entry already terminal. Pinned by test (f). |
| **F3** | tests: B-fault, C-fault, both branch sites, exact note count were optional/absent; `.find()` cannot count | six tests, two optional | Every property mandatory; `.find()` replaced by a counted `noteCount`; B-fault, C-fault, **both** branch sites added; the two existing pins re-checked (§Tests). Baseline-red: **8 failed** on HEAD (§Baseline-red). |
| **F4** | R1 over-claims: `updateAgentStatus` is not total when the catch's logger throws | "total today" | R1 **qualified** and re-measured (§Evidence **D3**); per-step containment kept, with the reason stated (§Recon R1). |
| **F5** | M5's kill is real only because the recorded mutant also removed the catch; a `finally` placement survives | M5 killed by T6 | M5 **deleted**. New **M5′** (release inside STEP C's `try`) is killed by (c) — measured (§Mutants). "Release in STEP B's `finally`" is listed as **not killable — and not a mutant** (§Mutants note). |
| **F6** | execution sketch omits the real worktree suite; delta was an estimate | `/tmp` suite called green | Step 8 of the sketch is the **real worktree full suite**; the flow verdict is recomputed from the **final integrated diff** (§Delta, measured +155/+20 → within by 5; §Execution step 10). The `/tmp` comparison is demoted to supporting evidence (§Not verified). |

Carried forward unchanged from r1 (verified sound by the critique): the single shared per-step-contained
helper, R2 (`completeTranscript` is not total on `EISDIR`), R4 (the branch refusals leak `_sessionRef`
on the baseline), R3 (the #450 tripwire **must** be narrowed), the two-edit test cost, the inline
release, no output capture, and #543 out of scope.

---

## Recon corrections

| # | Claim | Verdict | Evidence |
|---|---|---|---|
| **R1** | "`updateAgentStatus` can throw via `eventBus.emit` (a throwing listener skips the run entry and the transcript)" | **Half true.** `emit` wraps every listener in its own `try/catch` (`event-bus.ts:58-88`), so an ordinary listener throw is logged and swallowed — measured **D3**: `EMIT_ORDINARY=<no throw>`. But the catch's own logger can throw: a throwing log sink makes `emit` throw — **D3**: `EMIT_SINK=sink blew`. So the correct statement is: **`updateAgentStatus` can throw only through its error-reporting path**, which is the console-mirror class of fault (#543, out of scope here) and exactly what happens in a `setConsoleOutput(true)` TUI run. | `event-bus.ts:58-100`, `logging.ts:158`; **D3**. |
| **R1′** | (implied) therefore containment does not matter | **Still matters.** #542 puts three writes in one step, so "one try, three writes" lets a fault in the first suppress two more — and the suite forces a throwing emit through the bus mock today (`session-manager.test.ts:86-105`, used at `:3630`). The `markBranchSpawnFailed` comment already *claimed* per-step containment while the body was one try/catch; the code must match the comment. | **M4** (single try) kills (a) and (b) — measured. |
| **R3** | "the fix is additive; F1's test pins nothing" | **True of F1, false of the suite.** The #450 sentinel tripwire (`:3787-3812`) asserts `not.toContain("Transcript completed")` and `not.toContain("subagent:failed")` on the same sync-throw path; #542 gives both a second producer. Inverting the two clauses while keeping the settle-entry marker, the positive control, and the timer clause **preserves the tripwire's intent** (clause (4) `settleEntryRecords() === []` is the property's real instrument and is untouched). Not narrowing costs **2 failed**. | **R3**; §Tests edit 2. |
| **R4** | "three call sites" | **Four defects, five sites.** `markBranchSpawnFailed` never clears `agent._sessionRef`, and the ref is set at `:2051` — before the block at `:2125` — so both refusal sites leak the live session graph on the baseline. Measured again here: both refusal tests fail on HEAD with `expected { sessionId: 'test-session', …(5) } to be undefined`. | **X2**, §Baseline-red |

**R2** (verified sound in r1, re-used here): `completeTranscript` no-ops for a *missing* file
(`transcript.ts:114-127`) but is **not total** — a directory at the path throws `EISDIR` (probed again as
test (c)). Everything else in the recon holds: A/B/C are `:2046`/`:2544`/`:2829`, each followed by
`throw`; `captureAndReleaseSession` (`:2061`) is declared below A, so its TDZ there is real;
`finalizeRunEntry` never reads `agent.status`; `persistAgent` never throws; ADR 0026 D5 governs.

---

## Context — the defect, reproduced

Recorded as **E7** in the #450 spec; reproduced on `ba5e9f1` (**P1**) and re-derived on `572cda4` (test
**(a)** fails on HEAD with `expected '<no subagent:failed>' to be 'failed'`):
`GETAGENT=running SESSIONREF=set DISK_STATUS=running LAST_RUN=failed EVENTS=["subagent:created"]
NOTE=undefined`. After a synchronous `prompt()` throw the run entry is `failed` while the agent record is
`running` in memory **and on disk**, `_sessionRef` still holds the live session, and there is no note and
no terminal event: `failPreStart` stops at the run entry.

### Anchors (re-derived from `572cda4`; re-grep before editing)

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

Call sites B (`:2544`) and C (`:2829`) follow the same shape. Coverage of "every throw funnels":
`awk 'NR>=2050 && NR<=2835 && /throw /'` → `:2172`, `:2211`, `:2217`, `:2265`, `:2280` (all inside the
branch `try` → its catch → the helper), `:2545`, `:2830` — three `failPreStart` sites + two branch = **5**.

---

## The contract block — crash window and reentrancy, one statement

*These are the words that go in the helper's doc comment; the spec and the code must not diverge.*

> **ORDER.** The three writes run **run entry → record flip → transcript**. This is deliberately NOT
> #466's record-first order, for two measured reasons:
>
> 1. **Crash window.** A kill between the first and second write leaves a **`running` agent with a
>    terminal run entry** — not a terminal agent with an unfinalized run. The first residue costs a
>    stale row whose run entry already says `failed`, registry retired, session dir pruned, and which
>    no retry or interrupted-run surface can pick up (§Residual window states what is still not
>    repaired). The second residue is the one F1 measured: an unfinalized `running` run entry, a leaked
>    registry entry, and a retained session dir that only a manual sweep removes.
> 2. **Reentrancy.** The `subagent:failed` event is emitted by the record flip — the **second** write.
>    So the run-entry prune/retention decision (`finalizeRunEntry`'s `!agent.interruptedAt` gate at
>    `:1754`) has already been taken when a listener runs, and a listener that synchronously sets
>    `interruptedAt` cannot change the retention outcome. Under the record-first order it can, and it
>    does: measured, the directory survives.
>
> **EACH STEP IS CONTAINED SEPARATELY.** Every caller rethrows the ORIGINAL failure (`failPreStart(…);
> throw err`), so no step may replace it and no step may suppress another. Containment is not
> decoration: `updateAgentStatus` is total only while its error-reporting path is (R1/D3), and the
> transcript note is not total at all (R2).
>
> **NOTHING IS CAPTURED and the ref is dropped INLINE, outside every `try`.** `captureAndReleaseSession`
> is not used here: it would fabricate a `finalOutput` for a session that never produced one, and it is
> declared below call site A — a TDZ reference there. `persistAgent` strips `_sessionRef` anyway, so the
> release is memory-only and must nonetheless always run (the issue's second bullet).

Against #466's intent: #466 fixed the *set and sequence* of writes for a refused spawn because its reader
surface was the agent record. The record is still written on every path; only the *relative* order of two
independent writes changed, and the new order is the one that keeps both the prune gate and the event
ordering honest. ADR 0026 D4 does not require the record first; the ADR is not edited — the deviation is
recorded here, in the helper's doc, and in the PR body.

---

## Decision — Option B, order swapped

**One shared, per-step-contained three-write helper for all five sites.** `failPreStart` keeps its own
responsibility (deadline, teardown, registry retire) and delegates the terminal flip.

**Placement matters:** insert the helper **above `failPreStart`'s own doc comment** (i.e. directly after
`let deadlineHandle`, `:1971`), so neither doc block is orphaned and the helper is initialised above the
transcript start (`:2044`). Anywhere at or above `:2044` and below `:1971`'s neighbour is fine; a
position **below** `:2044` TDZes call site A (**M8**, measured: A2 fails with a `ReferenceError`
instead of the original `ENOTDIR`).

```ts
  // doc comment: the §Contract block above, verbatim, prefixed by
  //   "Issue #465 (b) / #466 (ADR 0026 D4) / #542: the terminal write for a run
  //    that was PROVABLY never issued — the branch refusals below and every
  //    pre-start throw (#542) end here. ONE definition, so the two paths cannot drift."
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

`failPreStart` (`:1994`) becomes: deadline clear (unchanged) → STEP 1 teardown (unchanged, contained) →
`markSpawnFailedBeforePrompt(message)` → STEP 3 registry retire (unchanged, contained). Its STEP-2
`try/catch` is deleted (the helper is total) and its doc comment gains one sentence: the flip is the
**full** terminal flip (#542); the "pruning is provably safe here" argument is unchanged.

`markBranchSpawnFailed` (`:2032`) is **deleted**; both refusal sites (`:2170`, `:2278`) call
`markSpawnFailedBeforePrompt`. Function-scoped `const`, not an exported symbol —
`Structural closure: n/a — no moved/deleted exports` (2 call sites, renamed in the same edit) — and its
old "record flip -> run entry -> transcript" comment is replaced by the contract block above.

### The other steps, and why C is last

`failPreStart` keeps `clearTimeout(deadlineHandle)` (total), `cleanupWorkBranch()` and
`clearInflightRun(id)` (own `try` each) exactly as they are; only its STEP-2 `try/catch` becomes the
helper call, so the helper's three writes are the only new ordering. **Why C last:** it is the least load-bearing and the most likely to degrade (missing file → warn;
`EISDIR`/`EACCES` → throw, R2), so it sits where a fault can suppress nothing.

### Rejected options

| Option | Mechanism | Blast radius | Cost | Why not |
|---|---|---|---|---|
| **D — do nothing** | leave the record `running` | 0 | 0 | The defect: monitor/drill-in disagree with history/retry after every pre-start throw, and the session graph is retained. Low incidence, but the fix is 45 source lines. |
| **A — `failPreStart` delegates to the existing `markBranchSpawnFailed`** | one call, helper stays single-`try` | 3 sites | ~8 src lines | Fixes the record flip, but keeps the *documented-but-false* containment across three writes (**M4** survives), leaves the branch-refusal ref leak (**R4**), and leaves the comment lying. Rejected on those three counts, not on size. |
| **C — duplicate the writes in `failPreStart`** | copy A/B/C | 3 sites | ~20 lines | Two copies of a three-write terminal sequence is the drift the issue's fix direction forbids; #466's DRY threshold (2 occurrences) is already met. |
| **B (chosen)** | shared helper, **run entry first** | 5 sites | +45/−25 src (+159/−4 tests) | Fixes the three pre-start sites **and** the two refusals, keeps #450's containment discipline, makes the comment true, and gives the better residue + the safe emit position. With the r1 (record-first) order the same code is rejected by F1+F2: the residue is the unfinalized-run one and the emit precedes the prune gate. |

### Scope boundary — what this unit does not touch

- **REGIME 2** (#544's post-start boundary, `:2833-2884`): untouched; no new call from it.
- **REGIME 1's premise** (#450 D2.1, `:2798-2820`): untouched.
- **Pruning / retention / `.done` marker**: still exactly one `finalizeRunEntry` per path.
- **Branch-lock, scratch-dir, `.done` paths**: non-goals. **#543** (the console mirror) is out of scope;
  its fault class is why containment stays (R1).
- **The residual crash window** (§Residual window): explicitly **not** fixed here.

## Tests — every advertised property, mandatory

All of it lands in `src/__tests__/session-manager.test.ts`, which already carries the harness (SDK/git/
event-bus mocks at `:1-99`, `createTempEnv` at `:149`, `lastRunEntry` at `:134`, `resetGitMocks` at
`:738`, imports at `:100-119`). **One new `describe` = 6 test cases**, plus two edits to existing tests.
No new file: the "synchronous listener" pin uses the bus mock, whose implementation *is* a synchronous
listener at the exact instant the real bus calls one (`event-bus.ts:58-88` is a plain `for` loop over
`listener(event)`) — the real-bus variant is measured separately as **B3**.

| # | Property (r2 finding) | Path | Pins |
|---|---|---|---|
| **(a)** | **order observable, and the flip's own fault is contained** (F3a, F1) | sync `prompt()` throw, `emit` throws on `subagent:failed` | `runStatusAtRecordFlip === "failed"` (the run entry exists **before** the record flip); record `failed`; **one** note; ref released; registry empty. Baseline-red: `'<no subagent:failed>'`, because HEAD emits no event at all. |
| **(b)** | **run-entry fault continues** (F3b) | 3rd `appendEntry` throws | record `failed` **and** disk `failed`; one note; ref released; registry empty — i.e. A's fault suppressed neither B nor C. |
| **(c)** | **note fault still releases, original error wins** (F3c, R2) | directory planted at the transcript path → `EISDIR` | the fault is **not mocked** (`statSync(...).isDirectory() === true`); rejection is the original `sync preflight failure`; ref released; record `failed`; run entry `failed`. **This is the only pin that catches the release placement (M5′).** |
| **(d)** | **both branch refusals terminal + released** (F3d, R4) | `it.each`: dirty tree / `createWorkBranch` throws | record + disk `failed`; ref released; **one** note; exactly one `subagent:failed`; run entry `failed`; registry empty — for **both** sites. Baseline-red on the ref. |
| **(e)** | **exactly one note, one event, nothing captured** (F3e) | plain sync throw | `noteCount(id, "Transcript completed") === 1` — a **count**, so a second note fails; one event; `finalOutput`/`result` `undefined`. |
| **(f)** | **synchronous listener cannot change retention** (F2) | sync throw + a listener that calls `markAgentInterrupted` | `dirBeforeFlip === true` (there **was** a dir to retain); at emit time the run entry is `failed` **and** the dir is already gone; the listener ran (`interruptedAt` set); record `failed`. |

`noteCount` **counts**, never `.find()` — `readFileSync(path,'utf-8').split("\n").filter((l) => l.includes(text)).length`
(one note = one JSONL line) — and every note assertion uses it.

### Edits to two existing tests

1. **Log-string pin** (`:3748`): `expect(readLog()).toContain("pre-start finalize failed")` — no edit is
   needed, because the helper's STEP A keeps that exact wording (chosen for this reason). It is also
   reached from the branch paths, where "pre-start" is still accurate.
2. **The #450 sentinel tripwire** (`:3787-3812`) must be narrowed — the unit's one semantic test change:

   ```ts
   // before
   expect(readFileSync(transcriptGetTranscriptPath(id), "utf-8")).not.toContain("Transcript completed");
   expect(emittedTypes()).not.toContain("subagent:failed");
   // after (#542: the note and the event now come from the pre-start flip, not a settle body)
   expect(readFileSync(transcriptGetTranscriptPath(id), "utf-8")).toContain("Transcript completed: failed");
   expect(emittedTypes().filter((t) => t === "subagent:failed")).toHaveLength(1);
   ```
   `not.toContain("subagent:completed")` stays; clauses (4) `settleEntryRecords() === []` and (5) one
   `clearTimeout` are untouched. **PR body justification:** those two clauses were #450's *instrument*
   for "no settle body ran", not its property — a transcript write and a terminal event used to have
   exactly one producer. Clause (4) is the property's real instrument and is still red for any
   settle-body mutant (measured: **M7** kills it).

### Baseline-red proof (measured: HEAD + this test file)

`npx vitest run src/__tests__/session-manager.test.ts` on `572cda4` → **8 failed | 137 passed**, every
failure a statement of the defect (with the swap: **145 passed**, `tsc --noEmit` exit 0; the six new cases
alone: `-t pre-start terminal flip`):

```
A2 (S2) transcript-start   → expected 'running' to be 'failed'      (c) note fault → ref still set
#450 sentinel tripwire     → expected '{"type":"system",…}' to contain 'Transcript completed: failed'
(a) ORDER                  → expected '<no subagent:failed>' to be 'failed'   (f) listener → '<none>'
(b) run-entry fault        → expected 'running' to be 'failed'      (d) both refusals → ref still set
```

## Acceptance criteria

1. After a synchronous `prompt()` throw: `getAgent(id).status === 'failed'` **and** the persisted
   `<storage>/<id>.json` says `failed`; `agent.completedAt` is a number and `agent.error` is the sanitized
   pre-start message (a, b, A2).
2. `agent._sessionRef`, `agent.finalOutput` and `agent.result` are `undefined` after the throw (c, e).
3. The transcript carries **exactly one** `Transcript completed: failed` note — a count, not a find (a,
   b, c, d, e).
4. Exactly one `subagent:failed` is emitted — **after** the run entry is terminal — and
   `subagent:completed` never is (a, d, f; the narrowed tripwire keeps the last clause).
5. The run entry is unchanged in shape: `failed`, same id, same `errorMessage`, `finalTurnError ===
   false`, `stopReason === 'error'` (the existing `F1` test at `:2657` passes **unedited**), and
   `listInflightRuns()` holds no entry for the id (a, b, d).
6. Callsite A (transcript-start throw) yields the terminal record, the pre-start stamp, a released ref,
   no fabricated output, **and** the caller still receives the original `ENOTDIR`/`ENOENT` (A2 extension
   + **M8**).
7. Callsite B (acceptance-write throw) yields the terminal record with `acceptedAt: null` preserved
   (existing `A3`, unedited).
8. A fault in any single step of the flip suppresses no other step and never replaces the caller's
   original error (b, c, M4).
9. The #450 tripwire still fails if any settle body is entered (`settleEntryRecords() === []`) and still
   counts exactly one `clearTimeout` (M7).
10. `markBranchSpawnFailed` no longer exists; both refusal sites call the shared helper; the helper is
    initialised **above** the transcript start (`:2044`) and **above** `failPreStart`'s doc comment.
11. `npx tsc --noEmit` clean; `session-manager.test.ts` fully green; the **real worktree** full suite green
    (sketch step 8); the flow verdict recomputed from the final integrated diff (sketch step 10).

## Delta — recomputed from the **final integrated diff** (ADR 0028)

`allowance(surface) = 120 + 2 × max(Δsource, 0)`, net lines, `--no-renames`, per surface
(`scripts/check-test-budget.mjs:12-16`). Measured with
`git diff --no-index --numstat base/… fix/…` on `/tmp/brl542r2/{base,fix}`:

| Surface | + | − | net | allowance | verdict |
|---|---|---|---|---|---|
| `src/session-manager.ts` | 45 | 25 | **+20** | 120 + 2×20 = 160 (this is the *source* row) | — |
| `src/__tests__/session-manager.test.ts` | 159 | 4 | **+155** | **160** | **within by 5** |
| `scripts/**` | 0 | 0 | 0 | — | within (untouched) |

The source delta is one helper (+~30 with its doc), one deleted helper (−10), one `failPreStart` step
(−7), one call and two renames.

**How the test surface got inside the allowance** (all four numbers are measured integrated diffs, not
estimates — the r1 figure of +128 was an estimate):

| Set | Net | Verdict | Change |
|---|---|---|---|
| naive: a test per property, each branch site its own `it`, plus a new callsite-A test | **+198** | over by 38 | — |
| merge the two refusal sites into one `it.each` table | **+176** | over by 16 | −22 |
| counted-`noteCount` via raw-line count; tighter banner/comments | **+169** | over by 9 | −7 |
| **final:** extend the existing `A2 (S2)` test instead of adding a callsite-A test | **+155** | **within by 5** | −14 |

The last cut is the honest one: `A2 (S2)` at `:3423` **already** spawns through the transcript-start
throw and asserts the run entry and the registry. Extending it with five assertions pins the new
properties (record, ref, no capture, one event, and — because the error is still `ENOTDIR` — the helper's
hook position) for a fraction of a new test. That is also why **M8/M9 stay killable** without a new test.

**Margin is 5, and it moves with the source:** landing 3+ net source lines smaller flips the flow to
`over` (154 < 155). The remedy is the PR-body line `Test budget: <reason>` — **never** padding `src/`.

---

## Mutants — measured against the final test set

Each row: the edit applied to the patched `src/session-manager.ts`, then
`npx vitest run src/__tests__/session-manager.test.ts`. Ids are §Tests (a)-(f); `A2` and `tripwire` are
the two pre-existing tests this unit touches.

| # | Mutant | Killed by |
|---|---|---|
| **M1** | delete STEP A (the run-entry write) | (a), (c), (d)×2, (f) + 6 pre-existing |
| **M2** | delete STEP B (the record flip) | A2, (a), (b), (c), (d)×2, (f) |
| **M3** | delete STEP C (the transcript note) | tripwire, (a), (b), (d)×2 |
| **M4** | collapse A+B+C into one `try/catch` (the pre-#542 body) | #450-normalises, (a), (b) |
| **M5′** | move `agent._sessionRef = undefined` **inside** STEP C's `try`, after `completeTranscript` | **(c)** — the release-placement killer |
| **M6** | call `updateAgentStatus` twice | A2, (d)×2 |
| **M7** | revert `failPreStart`'s STEP 2 to `finalizeRunEntry` only (pre-#542) | A2, 2×#450, (a), (b), (c), (f) |
| **M8** | declare the helper **below** the transcript start (`:2044`) | A2 — `ReferenceError` replaces the original `ENOTDIR` |
| **M9** | replace the inline release with `captureAndReleaseSession()` | A2 (TDZ), (a) (fabricated `finalOutput`) |
| **M10** | delete the inline release entirely | (a), (b), (c), (d)×2 |

**Corrected from r1 (F5):** r1's M5 ("release into STEP A's `finally`") was recorded as killed, but the
mutant actually run *also removed the catch*. Re-measured: release-in-a-per-step-`finally` with the catch
retained → **145 passed**. Any `finally` on a per-step `try` equals a statement after the `try/catch`, so
it **cannot** be a mutant and is not listed. M5′ replaces it, killed by exactly one test — (c).

Not killable, therefore not a mutant: *"keep `markBranchSpawnFailed` and duplicate the three writes in
`failPreStart`"* — behaviourally identical for every test; rejected on DRY grounds (option C).

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| The narrowed #450 tripwire reads as weakening a pin | **medium** — review friction, not correctness | Instrument-substitution argument in the PR body; clause (4) `settleEntryRecords()` untouched and still red for any settle-body mutant (M7 measured); the replacement asserts a **count**, which the old negative clause could not. |
| New user-visible behaviour: a pre-start failure now emits `subagent:failed`, so the completion-push wake can fire for a run that never started | low | Identical to today's branch-refusal behaviour (same `updateAgentStatus` call). `deliverCompletionAlert` is fully `try/catch`-wrapped (`terminal-notifier.ts:360-405`), deduped by `claimTerminalNotice`, and reads a run entry that now exists **before** the event fires — the swap makes this strictly safer. |
| `completedAt` becomes non-null; the ref release reaches the refusal sites | low | `finalizeRunEntry` does not read `completedAt`; `isStuckTerminalOwner` needs a *held* branch lock that STEP 1 has released. The ref release is measured (R4/X2) and pinned by (d); moving it out would reintroduce the drift this unit removes. |
| **Residual crash window** (§Residual window) | low, **documented** | Stated, not claimed fixed; remedy is a contained recommendation for a separate unit. |
| Flow margin is 5 | low | §Delta: a 3-line-smaller implementation flips to `over`; use the `Test budget:` line, never pad `src/`. |

## Execution sketch

1. `git status --porcelain` → empty; `git log --oneline -1`. Re-derive every §Anchors line with one
   `grep -n "failPreStart\|markBranchSpawnFailed\|captureAndReleaseSession\|transcript.startTranscript\|agent._sessionRef" src/session-manager.ts`.
2. Write the failing tests first (§Tests: the new `describe` + the A2 extension) and the tripwire
   narrowing. Run `npx vitest run src/__tests__/session-manager.test.ts` → expect **8 failed**, messages
   exactly as in §Baseline-red. Paste them into the PR body.
3. Cut `markBranchSpawnFailed` (`:2019-2039`, doc + const) and insert it **above `failPreStart`'s doc
   comment** (directly after `let deadlineHandle`, `:1971`), rewritten per §Decision — **run entry
   first**. The probe patch in `/tmp` placed it *between* the doc and the function (two adjacent doc
   blocks); do not replicate that.
4. Replace `failPreStart`'s STEP 2 (`:2004-2009`) with the helper call + the two comment lines, and add
   the one sentence to its doc comment (full flip; pruning unchanged).
5. Rename the two refusal call sites (`:2170`, `:2278`); replace the `:2159-2169` comment's
   "record flip -> run entry -> transcript" claim with a pointer to the contract block, and add the three
   words naming the helper to REGIME 2's comment.
6. Run the file → **145 passed**. `npx tsc --noEmit` → clean. `node scripts/check-imports.mjs` → clean.
7. Apply M1-M10 one at a time in a `/tmp` copy (never the repo); record exit codes in the PR body.
8. **GATE — the real worktree full suite** (not a `/tmp` comparison): `npx vitest run` from the
   worktree → the change's own suites green and **no new failing test name** against a pre-change run of
   the same command; record both name lists in the PR body (an empty diff after stripping timings).
9. PR body: the `## Design assumptions` block (§below), the narrowed-tripwire justification, the
   baseline-red output, the mutant table, the worktree suite evidence.
10. **Recompute the flow verdict from the final integrated diff**
   (`scripts/check-test-budget.mjs --flow …`, trusted cockpit copy). §Delta is a prediction, not the
   verdict; if the final test delta exceeds its allowance, apply the §Delta cut list or add the body line
   `Test budget: <reason>` — never pad `src/`.

**Design assumptions (stateful checklist).** *(1) State:* one agent-record write and one run-entry write,
both to existing stores (`<storage>/<id>.json`, the session entry log, the run registry) — no new path, no
new file, no new lock. *(2) Teardown:* unchanged — `finalizeRunEntry` still owns the `.done` marker,
prune/retention and the registry retire, and now runs **first**, so those are the earliest durable
effects. *(3) Concurrency:* single-threaded spawn path, no `await` between steps, and the only synchronous
reentrancy point (the `subagent:failed` listener) now runs after the prune decision — measured B3.
*(4) Missing/partial:* each step is fail-open and the helper never throws; a missing transcript no-ops, an
unwritable one is contained (c). *(5) Evidence:* B1-B3, D3, the 8 baseline-red failures, M1-M10, step 8.

---

## Residual window — stated, **not** claimed fixed

Neither write order survives a kill between the two writes intact, and **boot recovery repairs neither**;
measured end to end with the production wiring (B1/B2):

| | r1 order (record first) | **r2 order (run entry first)** |
|---|---|---|
| agent record on disk | `failed` (terminal) | `running` (**stale**) |
| run entry | `running` (**unfinalized**) | `failed` (terminal) |
| registry entry | **remains** | retired |
| session dir | **retained** | pruned |
| boot scan (`scanned/skipped/marked`) | `0/0/0` — the terminal record is dropped *before* the candidate list | `0/0/0` — the registry has no candidate left |
| restart-observable `getAgent(id).status` | `failed` | `running` |

So the swap **removes the falsifier** (B2: it exists under the r1 order; B1: it does not under r2) and
removes the leaked registry entry and the retained dir — but it does **not** make the residue
self-healing: the stale `running` record survives every boot, and only `get_subagent_result` (via
`getAgent` → `loadAgent`) still reports it.

**Contained remedy (its own unit, separate issue — do not file it from this PR):** the boot cannot finish
the record flip because a fresh process cannot see the crashed session's run entries
(`recovery.ts:18-20`). The durable signal it *can* read is the registry. The remedy is therefore: the
run-entry step writes a `recordFlipPending` (id + terminal status) marker into the registry entry, the
record flip clears it, and `recoverInflightRuns` gains a verdict that applies it to a persisted `running`
record — `run-registry.ts` (field + writer) + `recovery.ts` (one new verdict + summary counter) +
`session-manager.ts` (marker write/clear) + tests in `recovery*.test.ts` and `session-manager.test.ts`.
That is more than this unit may contain, and it is worth its own crash-residue pin (the shape used in B1).
**Recommendation: the conductor files it as a separate issue; this spec does not create it.**

---

## Evidence

All probes ran on copies built with `git archive HEAD | tar -x -C /tmp/brl542r2/<tree>` (node_modules
symlinked); the repository was never written. Trees: `base` (HEAD), `fix` (HEAD + the swap), `r1fix` (the
same containment in the **r1** order), `crash-swap`/`crash-r1` (the same, truncated by a throw between
write 1 and write 2 — a faithful kill: nothing after it runs, since `failPreStart` does not catch it and
the caller's `throw err` is skipped).

| ID | Claim | Probe | Observed |
|---|---|---|---|
| **B1** | the r2 residue, and what boot does with it | `zz-542r2-boot.test.ts` on `crash-swap`: spawn → kill after write 1 → plant a dead owner → the **real** `recoverProduction` wiring | `RES_MEM/DISK=running`, `RES_REGISTRY=0`, `RES_SESSION_DIR=false`, `BOOT_SCANNED=0 MARKED=0`, `BOOT_DISK_STATUS_AFTER=running`, `RESTART_STATUS=running`, `BOOT_TERMINAL_AGENT_WITH_RUNNING_RUN=false` |
| **B2** | the r1 residue is the falsifier state | same test on `crash-r1` | `RES_DISK=failed`, `RES_REGISTRY=1`, `RES_SESSION_DIR=true`, `BOOT_SCANNED=0 SKIPPED=0 REGISTRY_REMAINS=true`, `BOOT_LAST_RUN_AFTER=running`, `BOOT_TERMINAL_AGENT_WITH_RUNNING_RUN=true` |
| **B3** | the reentrancy contract, **real bus** | `zz-542r2-listener.test.ts`: a real `on("subagent:failed")` listener sets `interruptedAt` synchronously | swap: `L_DIR_BEFORE_PRUNE=true`, `L_RUN_AT_EVENT=failed`, `L_APPENDS_AT_EVENT=3`, **`L_DIR_AFTER=false`**; r1 order: `L_RUN_AT_EVENT=running`, `L_APPENDS_AT_EVENT=2`, **`L_DIR_AFTER=true`** |
| **O** | the ordering pin discriminates the order | the order block on `base` / `r1fix` / `fix` | `6 failed` / `1 failed` — **only** `(a)` (`expected 'running' to be 'failed'`) / `6 passed` |
| **D3** | R1 qualified, both halves | real `emit` with a throwing listener, then with `setConsoleOutput(true)` and a throwing `console.error` | `EMIT_ORDINARY=<no throw>`; `EMIT_SINK=sink blew` |
| **T** | the final test set against the final source | `session-manager.test.ts` on `fix` | **145 passed**; `tsc --noEmit` exit **0** |
| **Δ** | the flow numbers | `git diff --no-index --numstat base/… fix/…` | src `45 25`; tests `159 4` → net +20 / +155 |
| **S** | no regression observed outside the unit | full suite in `base` and `fix` (`/tmp` trees) | both **69 failed**; failing names identical after stripping timings (`diff` → empty) |
| **M** | M1-M10 killed, M5-old survives | mutant runs on `fix` copies | §Mutants |

## Not verified

- **The real worktree suite.** Running it writes into the repository, which this investigation may not do.
  The `/tmp` trees agree on their 69 pre-existing path-environment failures (**S**), but "the worktree
  suite is green" is **not** measured — it is sketch step 8, and it is the gate.
- **The flow verdict** (`scripts/check-test-budget.mjs --flow`) and `scripts/check-imports.mjs`: neither was
  run here — sketch steps 6 and 10; §Delta is a prediction from this investigation's patch, not the verdict.
- **The real SDK's `session.messages` on a never-started session.** The inline-release argument does not
  depend on it: (a) asserts `finalOutput`/`result` are `undefined`, true for the mock and the SDK alike.
- **The completion-push wake** for a pre-start failure (only the emit is observed) and
  **Windows/POSIX differences** in the `EISDIR` force used by (c).
- **Whether the shipped `.d.ts`/exports change**: none do — the helper is a function-scoped `const`
  (`Structural closure: n/a — no moved/deleted exports`).

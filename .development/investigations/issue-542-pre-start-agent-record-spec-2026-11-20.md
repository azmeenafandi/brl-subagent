# #542 — a pre-start failure settles the agent record, not only the run entry — spec **r1**

**Issue:** #542 (harden) · priority **low** measured, **C1** · `fix: mechanical` · worktree **n** ·
review **C2 focused** · cycle `settle-handlers`, **U2** (next: **U3 = #543**).
**Spec r1:** 2026-11-20, against `dev @ ba5e9f1` (post-#544). `git status --porcelain` on the repo →
**0** lines before and after this investigation; every probe ran on copies under `/tmp/brl542/`.
**Status:** decision-ready. One existing test pin must be **narrowed** — see §Recon correction **R3**;
that is the one thing in this unit a reviewer will push back on, so it is stated first.

---

## Recon corrections (read before the design)

The conductor's recon is right on the anchors and on the *shape* of the defect. Four points need
correcting — **R3** changes the test plan, **R1** changes the argument for containment (not the
design), and **R4** widens the blast radius.

| # | Recon claim | Verdict | Evidence |
|---|---|---|---|
| **R1** | "`updateAgentStatus` can still throw via `eventBus.emit` — e.g. a listener throwing on `subagent:failed` skips the run entry and the transcript" | **FALSE as production behaviour.** `event-bus.emit` wraps *every* listener in its own `try/catch` (`src/event-bus.ts:58-88`, present since the initial commit). A throwing `subagent:failed` listener is logged and swallowed; it cannot skip anything. `persistAgent` is total (its only uncaught call, `ensureStorageDir` → `ensureOwnerOnlyDir`, is itself total — `store-permissions.ts:41-73`). So `updateAgentStatus` is **total today**. | read: `event-bus.ts:58-88`, `session-manager.ts:509-540`, `store-permissions.ts:41-73`. Probed: **P3** (throw forced through the *mocked* bus) — see §Evidence. |
| **R1′** | (implied) the containment mismatch does not matter | **Still matters, for a different reason.** #542's body introduces a *second and third* write into the same step, so "one try, three writes" would let a fault in the first suppress two more. And the suite's established way to force a throwing emit is the module mock (`session-manager.test.ts:86-105`, already used at `:3630`), so the shape is testable. The comment already claims "each step is contained" (`:2022-2031`) — the code must match the comment, not the other way round. | read + **P3**, mutant **M3**. |
| **R2** | "`completeTranscript` never throws and no-ops with a warning when the transcript file is missing" | **Half true.** It no-ops for a *missing* file (`transcript.ts:114-127`) but is **not total**: `appendEntry` (`transcript.ts:71-95`) calls `appendFileSync`, which throws when the path exists but is not writable/appending-able (EISDIR, EACCES, ENOSPC). Measured: a directory planted at the transcript path makes the note throw. | **X1** (measured): `GETAGENT=failed LAST_RUN=failed SESSIONREF=unset ISDIR=true` — the fault was contained, the original error still won. |
| **R3** | "The F1 test does not pin the agent record either way, so the fix is additive" | **True of F1, false of the suite.** The #450 sentinel tripwire (`session-manager.test.ts:3787-3812`) asserts, on the *same* sync-throw path: `not.toContain("Transcript completed")` and `not.toContain("subagent:failed")`. #542 gives both a second producer, so the tripwire fails by construction. Measured: Option B → `session-manager.test.ts` **2 failed** (the tripwire and one log-string pin), then **139/139** after the two edits in §Tests. | **P1/P2** + full-file runs, §Evidence. |
| **R4** | "Three call sites" | **Four defects, five sites.** `markBranchSpawnFailed` never clears `agent._sessionRef`, and the ref is set at `:2051` — *before* the branch block at `:2125` — so both branch-refusal sites (`:2170`, `:2278`) leak the live session graph on the baseline too. Measured **X2**: baseline `SESSIONREF=set` after a dirty-tree refusal; Option B `SESSIONREF=unset`. | **X2**. |

Everything else in the recon was re-verified and holds: the three `failPreStart` call sites are
`:2046`, `:2544`, `:2829`, each followed by `throw`; `agent._sessionRef = session` is `:2051`, i.e.
**after** the transcript-start site; `captureAndReleaseSession` is declared at `:2061` **below**
`failPreStart` (`:1994`) and its TDZ at the transcript-start site is real (measured: `Cannot access
'captureAndReleaseSession' before initialization`); `finalizeRunEntry` never reads `agent.status`
(only `markTerminalBestEffort` does, `:2364-2371`); `persistAgent` never throws; ADR 0026 D5 ("every
record ends in exactly one outcome") is the governing decision.

---

## Context — the defect, reproduced

The recorded probe is **E7** in the #450 spec. Reproduced here on `ba5e9f1` in a `/tmp` copy of the
tree (**P1**, command in §Evidence), identical output:

```
GETAGENT=running      SESSIONREF=set        DISK_STATUS=running
LAST_RUN=failed       EVENTS=["subagent:created"]        NOTE=undefined
```

After a synchronous `prompt()` throw: the run entry is `failed`, the agent record is `running` in
memory **and on disk**, `_sessionRef` still points at the live session, no transcript note, no
terminal event. `failPreStart` stops at the run entry. A restart therefore restores a `running`
agent whose run entry is already terminal: the run-entry surfaces (pre-flight capability scan,
history, retry) and the agent-record surfaces (monitor, drill-in) disagree, and the session graph is
retained until process exit.

### Anchors (re-derived from `ba5e9f1`; do not trust the recon's or these without re-grepping)

| Anchor | Line | Role |
|---|---|---|
| `agents.set(id, agent); persistAgent(agent);` | `:1621-1622` | the durable agent record (`running`) — **exists before every pre-start throw** |
| `persistRunRecord(pi, run, "background");` | `:1660` | the spawn run entry |
| `const cleanupWorkBranch = …` | `:1885` | branch teardown (idempotent) |
| `const failPreStart = (message: string)` | `:1994` | deadline clear → teardown → finalize → registry retire |
| `const neverIssued = (err: unknown)` | `:2019` | `PROMPT_NEVER_ISSUED_MESSAGE: <sanitized>` |
| `const markBranchSpawnFailed = (message: string)` | `:2032` | the 3-write sequence, **single** try/catch |
| `transcript.startTranscript(agent.id, params.task);` | `:2044` | first pre-start throw |
| `failPreStart(neverIssued(err));` + `throw err` | `:2046-2047` | **call site A** (ref not yet set) |
| `agent._sessionRef = session;` | `:2051` | the ref becomes live |
| `const captureAndReleaseSession = …` | `:2061` (release at `:2067`) | **declared below** A — TDZ |
| `markBranchSpawnFailed(reason); clearInflightRun(id); throw` | `:2170-2172` | branch refusal #1 (stuck owner) |
| `markBranchSpawnFailed(`…`)` in the setup catch | `:2278-2280` | branch refusal #2 (setup throw) |
| `run.acceptedAt = …` / acceptance `persistRunRecord` | `:2535-2537` | the acceptance marker |
| `failPreStart(neverIssued(err));` + `throw err` | `:2544-2545` | **call site B** (ref set) |
| `runPromise = session.prompt(wrapTask(params.task));` | `:2821` | REGIME 1's one statement |
| `failPreStart(sanitizeErrorMessage(reason, effectiveCwd));` + `throw err` | `:2829-2830` | **call site C** (ref set) |
| `settled.then(onSettled).catch(onSettleFault);` / REGIME 2 | `:2796` / `:2833-2884` | untouched by this unit |

Coverage of the "every throw funnels" claim: `awk 'NR>=2050 && NR<=2835 && /throw /'` → real throws at
`:2172`, `:2211`, `:2217`, `:2265`, `:2280` (all inside the branch `try` → its catch → the helper),
`:2545` and `:2830` (`failPreStart`). Three `failPreStart` sites + two branch sites = **5**.

---

## Decision

**Option B — one shared, per-step-contained three-write helper for all five sites.** `failPreStart`
keeps its own responsibility (deadline, teardown, registry) and delegates the terminal flip.

```ts
  /**
   * Issue #465 (b) / #466 (ADR 0026 D4) / #542: the terminal write for a run that
   * was PROVABLY never issued — the branch refusals below and every pre-start throw
   * end here. Record flip -> run entry -> transcript, ONE definition, so the
   * pre-start and branch-refusal paths cannot drift apart.
   *
   * EACH STEP IS CONTAINED SEPARATELY: every caller rethrows the ORIGINAL failure,
   * so no step here may replace it, and no step may suppress the other two.
   *
   * NO OUTPUT IS CAPTURED. Nothing ran: `captureAndReleaseSession` is NOT used here
   * (it would fabricate a `finalOutput` for a session that never produced one, and it
   * is declared BELOW the transcript-start call site — a TDZ reference there). The
   * ref is dropped inline; `persistAgent` strips it anyway.
   */
  const markSpawnFailedBeforePrompt = (message: string): void => {
    try {                          // STEP A — record flip (completedAt + error, emits subagent:failed)
      updateAgentStatus(id, 'failed', message);
    } catch (err) {
      safeLog(() => log.warn(`spawnBackgroundSession: pre-start record flip failed for ${id}`,
        { error: thrownMessage(err) }));
    }
    try {                          // STEP B — run entry (+ retention/prune, registry retire)
      finalizeRunEntry('failed', message);
    } catch (err) {
      safeLog(() => log.warn(`spawnBackgroundSession: pre-start finalize failed for ${id}`,
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

`failPreStart` (`:1994`) becomes: deadline clear (unchanged) → STEP 1 teardown (unchanged, contained)
→ `markSpawnFailedBeforePrompt(message)` → STEP 3 registry retire (unchanged, contained). Its STEP-2
`try/catch` is deleted (the helper is total) and its doc comment gains one paragraph: the flip is the
**full** terminal flip (#542), and the "pruning is provably safe here" argument is unchanged.

`markBranchSpawnFailed` (`:2032`) is **deleted**; its two call sites (`:2170`, `:2278`) call
`markSpawnFailedBeforePrompt`. It is a function-scoped `const`, not an exported symbol, so
`Structural closure: n/a — no moved/deleted exports` (2 call sites, both renamed in the same edit).

### Where the helper may be declared (a real, narrow constraint)

The helper must be **initialised before call site A** (`:2046`), i.e. textually above
`transcript.startTranscript` (`:2044`). Anywhere at or above `:2044` is fine — including its current
position (`:2032`, above `failPreStart`: measured, all six tests pass with the block moved to just
above the transcript start). The trap is the *natural* new home, beside its new sibling
`captureAndReleaseSession` (`:2061`), which is **below** call site A: there the call at `:2046` raises
`Cannot access 'markSpawnFailedBeforePrompt' before initialization` — and because STEP 2 is no longer
wrapped in a `try`, that `ReferenceError` escapes `failPreStart`, **replaces the caller's error** and
skips the registry retire. Measured (**M8**): T4 fails with
`expected … to throw error matching /ENOTDIR|ENOENT/ but got 'Cannot access 'markSpawnFailedBefore…'`.
The recommended position is therefore above `failPreStart` (`:1973`), away from `:2044`.

### Write ordering and containment (per step)

| Order | Step | What it does | Its failure must NOT suppress | Contained by |
|---|---|---|---|---|
| 1 (in `failPreStart`) | `clearTimeout(deadlineHandle)` | disarm the #453 owner | — | already total |
| 2 | `cleanupWorkBranch()` | release branch lock + delete work branch | steps 3-5 | own try (unchanged, M18) |
| 3 | **A** `updateAgentStatus(id,'failed',msg)` | `status='failed'`, `completedAt=Date.now()`, `error=msg`, persist, emit `subagent:failed` | **B** (run entry) and **C** (transcript) | own try |
| 4 | **B** `finalizeRunEntry('failed', msg)` | the run entry (terminal), `.done` marker, retention/prune, registry retire | **C** | own try |
| 5 | **C** `transcript.completeTranscript(id,'failed')` | the audit note | nothing after it | own try |
| 6 | `agent._sessionRef = undefined` | drop the live session graph | — | outside every try (cannot throw) |
| 7 | `clearInflightRun(id)` | belt for a finalize that threw | — | own try (unchanged, M17) |

**Why A before B.** B does not read `agent.status` (verified: `:1724-1850` — `finalizeRunEntry` reads
`agent.result?.usage` and `agent.finalOutput`, never the status; only `markTerminalBestEffort` derives
a status from the record). So the record-first order is safe, and it puts the *user-visible* fact
(monitor/drill-in) first — the exact ordering #466/ADR 0026 D4 already fixed for refused spawns.

**Why C last.** It is the least load-bearing and the most likely to degrade (missing file → warn;
unwritable/EISDIR → throw, **R2**), so it sits where a fault can suppress nothing.

**Why the release is inline.** `captureAndReleaseSession` would (a) run `extractFinalOutput` on a
session that produced nothing and stamp a fabricated `finalOutput`/failure headline, and (b) be a TDZ
reference at call site A. The ref *must* be dropped: on B and C it points at a live session that will
never settle (the issue's second bullet).

**Nothing is fabricated.** `agent.result` stays `undefined`; `agent.finalOutput` stays `undefined`;
`finalizeRunEntry` then writes `outputSummary: ""` / no `fullOutput` and `usage` from `EMPTY_USAGE`.
No `recordSessionUsage()`, no `setAgentFinalOutput`.

### Rejected options

| Option | Mechanism | Blast radius | Cost | Why not |
|---|---|---|---|---|
| **D — do nothing** | leave the record `running` | 0 | 0 | The defect: monitor/drill-in disagree with history/retry after every pre-start throw; session graph retained. Low incidence, but the fix is 46 lines. |
| **A — `failPreStart` delegates to `markBranchSpawnFailed`** | one-line call, helper stays at `:2032`, single try | 3 sites | ~8 src lines (≈10 fewer than B) | Smallest diff, and it would fix the record flip. But it embeds the *documented-but-false* containment into three writes per call (M3 survives), leaves the branch-refusal `_sessionRef` leak (**X2**), and leaves the comment lying. Rejected on those three counts, not on size. |
| **C — duplicate the writes in `failPreStart`** | copy A/B/C into `failPreStart` | 3 sites | ~20 lines | Two copies of a 3-write terminal sequence is exactly the drift the issue's fix direction forbids; #466's DRY threshold (2 occurrences) is already met. |
| **B (chosen)** | one shared per-step-contained helper, 5 sites | 5 sites, 2 existing tests touched | +46/−25 src, +128 test | Fixes the 3 pre-start sites **and** the 2 branch sites' ref leak, keeps #450's containment discipline, and makes the comment true. |

### What stays unchanged (the unit's scope boundary)

- **REGIME 2** (#544's post-start boundary, `:2833-2884`): untouched. No new call to the helper from
  REGIME 2; a post-start routing fault still does **not** settle the run (#439).
- **REGIME 1's premise** (D2.1 preconditions, `:2798-2820`): untouched — the comment still describes
  what makes "never issued" a fact.
- **Pruning / retention / `.done` marker**: still exactly one `finalizeRunEntry` call per path.
- **Branch-lock, scratch-dir, `.done` paths**: non-goals, untouched.
- **#543** (the next unit) is not pre-empted.

---

## Tests

New file or a new `describe` in `src/__tests__/session-manager.test.ts` — the file already carries the
whole harness (SDK/git/event-bus mocks at `:1-99`, `createTempEnv` at `:149`, `lastRunEntry` at
`:134`, imports at `:100-119`). Six tests, 126 lines (§Delta).

| Test | Path | Assertions (one per observable) |
|---|---|---|
| **T1** | sync `prompt()` throw | `getAgent(id).status === 'failed'`; the **disk** record `status === 'failed'`; `typeof completedAt === 'number'`; `error === 'sync preflight failure'` |
| **T2** | same | `_sessionRef` is `undefined`; `finalOutput` is `undefined`; `result` is `undefined` (nothing ran → no fabricated output) |
| **T3** | same | transcript note `Transcript completed: failed`; exactly **one** `subagent:failed` emit; last run entry `failed` with the same message and id; `listInflightRuns()` has no entry for the id |
| **T4** | `startTranscript` throw (blocked output dir) | callsite A: record + disk terminal, `error` starts with `PROMPT_NEVER_ISSUED_MESSAGE`, `_sessionRef` undefined, run entry `failed`, **no transcript file**, `subagent:failed` emitted, and the rejection is the original `ENOTDIR`/`ENOENT` (also pins that the helper is initialised above `:2044` — M8) |
| **T5** | acceptance-write throw (2nd `appendEntry` throws) | callsite B: record `failed`, run entry `failed`, `acceptedAt` still `null`, transcript note present |
| **T6** | throwing `subagent:failed` emit (module mock) | **containment**: the rejection is still the *original* error (not `emit exploded`), the run entry is still written, the note still exists, the ref still released |
| **T7** (optional, +28) | directory planted at the transcript path | **STEP C containment** (R2): record + run entry written, ref released, original error wins. Recommend including it — it is the only *non-mocked* force of a throwing step. |
| **T8** (optional, +2) | existing `:1798` "C1: refuses to spawn when the base tree has uncommitted changes" | one added line: `expect(getAgent(id)!._sessionRef).toBeUndefined()` — pins the **X2** benefit on a branch-refusal site. |

### Two edits to existing tests (one mechanical, one a narrowing)

1. **Log-string pin** (`:3748`): `expect(readLog()).toContain("pre-start finalize failed")`. Keep the
   helper's STEP B wording exactly `pre-start finalize failed` — then **no edit is needed**. (Measured:
   with `pre-prompt finalize failed` this test fails; the wording in the §Decision code block is chosen
   for this reason.) Note that the helper is also reached from the branch paths, where "pre-start" is
   still accurate — both are before the prompt.
2. **The #450 sentinel tripwire** (`:3787-3812`) **must be narrowed**, and this is the unit's one
   semantic test change:

   ```ts
   // before
   expect(readFileSync(transcriptGetTranscriptPath(id), "utf-8")).not.toContain("Transcript completed");
   expect(emittedTypes()).not.toContain("subagent:failed");
   // after (#542: the note and the event now come from `failPreStart`, not from a settle body)
   expect(readFileSync(transcriptGetTranscriptPath(id), "utf-8")).toContain("Transcript completed: failed");
   expect(emittedTypes().filter((t) => t === "subagent:failed")).toHaveLength(1);
   ```
   `not.toContain("subagent:completed")` stays. The justification must go in the PR body: those two
   clauses were #450's **instrument** for "no settle body ran", not its property — a transcript write
   and a terminal event used to have exactly one producer. #542 gives them a second producer, and the
   property's real instrument is clause **(4)**: `settleEntryRecords()` must be `[]`, which is
   **untouched and still red for any settle-body mutant**. Clause (5) (one `clearTimeout`) is also
   untouched.

   Measured cost of *not* narrowing: `session-manager.test.ts` → **2 failed / 137 passed**.

### Baseline-red proof (measured, `ba5e9f1`)

Six prescribed tests, run against an unmodified tree: **6 failed / 6**, with these first-assertion
messages — every one is the defect:

```
T1 → expected 'running' to be 'failed'                 (agent record, memory)
T2 → expected { sessionId: 'test-session', …(4) } to be undefined   (_sessionRef)
T3 → expected undefined to be 'Transcript completed: failed'
T4 → expected 'running' to be 'failed'                 (callsite A)
T5 → expected 'running' to be 'failed'                 (callsite B)
T6 → expected undefined to be 'Transcript completed: failed'
```

With Option B: **6 passed**. The full file: **139 passed**. Full suite from a `/tmp` tree: identical
failure set to the baseline tree (69 pre-existing, path-environment failures — §Not verified).

How to run:

```bash
npx vitest run src/__tests__/session-manager.test.ts            # 139 + the 6-8 new
npx vitest run src/__tests__/session-manager.test.ts -t '#542'   # just this unit
npx tsc --noEmit
```

---

## Acceptance criteria

1. After a synchronous `prompt()` throw: `getAgent(id).status === 'failed'` **and** the persisted
   `<storage>/<id>.json` says `failed` (T1).
2. `agent.completedAt` is a number and `agent.error` is the sanitized pre-start message (T1).
3. `agent._sessionRef === undefined` and `agent.finalOutput === undefined` and `agent.result ===
   undefined` after the throw (T2).
4. The transcript carries exactly one `Transcript completed: failed` note (T3).
5. Exactly one `subagent:failed` event is emitted (T3; T6 adds "even when the emit itself throws"),
   and `subagent:completed` never is (the narrowed tripwire keeps that clause).
6. The run entry is unchanged in shape and content: `failed`, same id, same `errorMessage`,
   `finalTurnError === false`, `stopReason === 'error'` — i.e. `F1` (`:2687`) passes **unedited** (T3 +
   the existing test).
7. `listInflightRuns()` contains no entry for the id (T3).
8. Callsite A (transcript-start throw) yields the same terminal record plus a **pre-start** stamp, and
   the caller still receives the original `startTranscript` error (T4).
9. Callsite B (acceptance-write throw) yields the terminal record, with `acceptedAt: null` preserved
   on the terminal entry (T5).
10. A fault in any single step of the flip does not suppress the others and never replaces the
    caller's original error (T6, T7).
11. The #450 tripwire still fails if any settle body is entered (`settleEntryRecords() === []`), and
    exactly one `clearTimeout` still happens.
12. `markBranchSpawnFailed` no longer exists; both branch-refusal sites call the shared helper; the
    helper is initialised **above the transcript-start call (`:2044`)**.
13. `npx tsc --noEmit` clean; `session-manager.test.ts` fully green; the rest of the suite unchanged
    relative to baseline.

---

## Risks

| Risk | Severity | Mitigation |
|---|---|---|
| The narrowed #450 tripwire reads as weakening a pin | **medium** — review friction, not correctness | Justify as instrument-substitution in the PR body; clause (4) marker records remain the property's instrument; T6/T7 add containment coverage the tripwire never had. |
| New user-visible behaviour: a pre-start failure now emits `subagent:failed`, so the completion-push wake can fire for a run that never started | low | Identical to today's branch-refusal behaviour (same `updateAgentStatus` call). `deliverCompletionAlert` is fully `try/catch`-wrapped (`terminal-notifier.ts:360-405`), deduped by `claimTerminalNotice`, and reads the run entry that exists. |
| `completedAt` becomes non-null, changing what "never started" looks like to consumers | low | `finalizeRunEntry` does not read it; `isStuckTerminalOwner` needs a *held* branch lock, which STEP 1 has already released before the flip. Measured: no test in the suite observes the difference. |
| The helper creeping into REGIME 2 later | low | REGIME 2's comment already forbids `failPreStart` after the prompt; extend it with three words naming the helper. |
| Ordering regressions (`finalizeRunEntry` reading a status) | low | Verified it does not; the record-first order is #466's. |
| Releasing `_sessionRef` on branch refusals is a behaviour change outside #542's literal text | low, **positive** | Measured X2; pinned by T8. If the conductor refuses it, the release must move out of the helper into `failPreStart` — which reintroduces the drift this unit exists to remove. Recommend keeping it. |

---

## Delta estimate (ADR 0028 flow rule)

`allowance = 120 + 2 × Δsource(net)`.

| Surface | + | − | net | allowance | verdict |
|---|---|---|---|---|---|
| `src/session-manager.ts` | 46 | 25 | **+21** | — | — |
| `src/__tests__/session-manager.test.ts` | 132 | 4 | **+128** (T1-T6 + the tripwire narrowing) | 120 + 2×21 = **162** | **within by 34** |
| + T7/T8 (optional) | +30 | 0 | +158 | 162 | within by **4** — include only one of them, or trim comments |

The source delta is one helper (+~30 lines including its doc), one deleted helper (−10), one
`failPreStart` step (−7), one call and two renames.

---

## Mutant table (measured on `/tmp/brl542/probe`; each row: the edit, the tests it killed)

| # | Mutant | Killed by |
|---|---|---|
| **M1** | delete STEP A (`updateAgentStatus`) | T1, T3, T4, T5 |
| **M2** | delete STEP C (`completeTranscript`) | T3, T5, T6 |
| **M3** | collapse A+B+C into one `try/catch` (the pre-#542 body) | **T6** |
| **M4** | replace the inline release with `captureAndReleaseSession()` | T1, T2, T3, T4, T6 (T2 = fabricated output; the rest = the TDZ/`extractFinalOutput` throw replacing the original error) |
| **M5** | move `agent._sessionRef = undefined` into STEP A's `finally` | **T6** |
| **M6** | call `updateAgentStatus` twice | T3 (two `subagent:failed` events) |
| **M7** | revert `failPreStart`'s STEP 2 to `finalizeRunEntry` only (do-nothing for the pre-start path) | T1, T2, T3, T4, T5, T6 |
| **M8** | declare the helper **below** the transcript-start call (`:2044`) — e.g. beside `captureAndReleaseSession` at `:2061` | T4 (`ReferenceError` instead of `ENOTDIR`). *Note:* the old `:2032` position is **safe** (measured: 6/6 pass); only a position below `:2044` TDZes. |

Not killable, and therefore not listed as a mutant: *"keep `markBranchSpawnFailed` and duplicate the
three writes in `failPreStart`"* — behaviourally identical for every test; it is rejected on DRY
grounds (option C), not by a test.

---

## Execution sketch

1. `git status --porcelain` → empty; `git log --oneline -1` → `ba5e9f1`. Re-derive every anchor:
   `grep -n "const failPreStart\|const markBranchSpawnFailed\|captureAndReleaseSession\|failPreStart(\|markBranchSpawnFailed(\|transcript.startTranscript\|agent._sessionRef" src/session-manager.ts`.
2. Write the failing tests first (T1-T6) into `src/__tests__/session-manager.test.ts`; run
   `npx vitest run src/__tests__/session-manager.test.ts -t '#542'` → expect **6 failed** with the
   messages in §Baseline-red proof. Paste them into the PR body.
3. Cut the `markBranchSpawnFailed` block (`:2019-2039`, doc + const) and paste it **above
   `failPreStart`** (`:1973`, after the `deadlineHandle` declaration at `:1971`), rewritten per
   §Decision. (Staying at `:2032` also works — it is above `:2044`; put it beside
   `captureAndReleaseSession` at `:2061` and call site A TDZes, M8.)
4. Replace `failPreStart`'s STEP 2 (`:2004-2009`) with the single helper call + the two comment lines.
   Extend `failPreStart`'s doc comment: the flip is now the full terminal flip (#542), pruning is
   unchanged.
5. Rename the two call sites (`:2170`, `:2278`) and extend the branch-refusal comment (`:2159-2169`)
   to name the shared helper.
6. Narrow the #450 tripwire (`:3803-3809`) exactly as in §Tests, leaving clauses (3)-(6) untouched. Run
   the full file → **139 passed**.
7. `npx tsc --noEmit` → clean. `node scripts/check-imports.mjs` → clean.
8. Apply the eight mutants one at a time in a `/tmp` copy (never the repo), run
   `npx vitest run src/__tests__/session-manager.test.ts -t '#542'`, record exit codes in the PR body.
9. PR body: the `## Design assumptions` block (below), the narrowed-tripwire justification, the
   baseline-red output, the mutant results, and the flow line.

**Design assumptions (stateful checklist).** *(1) What state:* one agent record write and one run-entry
write, both to existing stores (`<storage>/<id>.json`, the session custom-entry log) — no new path, no
new file, no new lock. *(2) Teardown:* unchanged — `finalizeRunEntry` still owns the `.done` marker,
prune/retention and the registry retire. The crash window between A and B is **not new**: a process
death there leaves the registry entry the boot scan already handles (#439). The window is *narrowed*,
not widened: before, a death between the record write and the run entry left a `running` record; now it
leaves a `failed` one. *(3) Concurrency:* single-threaded spawn path, no
`await` between the steps. *(4) Missing/partial state:* the helper is fail-open per step (T6/T7) and
never throws. *(5) Evidence:* T1-T6 + mutants M1-M8.

---

## Evidence

All probes ran on copies built with `git archive HEAD | tar -x -C /tmp/brl542/probe` (node_modules
symlinked); the repository was never written. The probe suites are
`/tmp/brl542/probe/src/__tests__/zz-542*.test.ts`; `zz-542.test.ts` **is** the prescribed test block.

| ID | Claim | Probe | Observed |
|---|---|---|---|
| **E7′** | the defect on `ba5e9f1` | spawn with a throwing `prompt` in a `/tmp` copy | `GETAGENT=running SESSIONREF=set DISK_STATUS=running LAST_RUN=failed EVENTS=["subagent:created"] NOTE=undefined` |
| **P1** | Option B fixes callsite C | same, patched | `failed / unset / failed / failed / ["subagent:created","subagent:failed"] / Transcript completed: failed`, `completedAt=1795214598271`, `finalOutput=undefined` |
| **P2** | callsite A fixed, no transcript file | `writeFileSync(<base>/blocker); __setOutputDir(<base>/blocker/out)` | `THROWN=ENOTDIR…`, `GETAGENT=failed SESSIONREF=unset DISK_STATUS=failed LAST_RUN=failed RUNS_WRITTEN=2`, `EVENTS=["subagent:failed"]` |
| **P4** | callsite B fixed | 2nd `appendEntry` throws | `GETAGENT=failed LAST_RUN=failed ACCEPTEDAT=null NOTE=Transcript completed: failed` |
| **P3** | STEP A fault contained | mocked `emit` throws on `subagent:failed` | `THROWN=sync preflight failure` (original wins), `LAST_RUN=failed`, `NOTE=Transcript completed: failed`, `SESSIONREF=unset` |
| **X1** | `completeTranscript` is not total (R2) | directory planted at the transcript path inside the prompt mock | `GETAGENT=failed LAST_RUN=failed SESSIONREF=unset ISDIR=true` — contained |
| **X2** | branch refusals leak the ref on baseline (R4) | dirty-tree refusal, both trees | baseline `SESSIONREF=set`; Option B `SESSIONREF=unset` |
| **TDZ** | `captureAndReleaseSession` at callsite A is a TDZ reference | M4, run T4 | `Cannot access 'captureAndReleaseSession' before initialization` |
| **R1** | the real bus swallows listener errors | read `event-bus.ts:58-88` + `git log -S"Don't let listener errors break the event loop"` → initial commit | 2 `try/catch` blocks around `listener(event)`; `emit` cannot throw from a listener |
| **R3** | the suite is not additive | Option B against the untouched test file | `session-manager.test.ts` → `2 failed \| 137 passed`; after the two edits → `139 passed` |
| **M** | 8/8 mutants killed | `python3 /tmp/brl542/mutants.py` (M1-M7) + `/tmp/brl542/mutant-m8.ts` (M8) | `M1 T1,T3,T4,T5 · M2 T3,T5,T6 · M3 T6 · M4 T1,T2,T3,T4,T6 · M5 T6 · M6 T3 · M7 all 6 · M8 T4` |
| **S** | no regression in the suite | full `vitest run` in `/tmp/brl542/base` and `/tmp/brl542/probe` | both `69 failed \| 10 files failed`; `diff` of the failing-test names → **IDENTICAL** |
| **Δ** | delta | `git diff --no-index --numstat baseline optionB` | `46 25` on `src/session-manager.ts`; test block 126 lines + 2 net in the tripwire |

---

## Not verified

- **The suite at the repository root.** Running it would require writing files into the repo, which
  this investigation may not do. Both trees were run from `/tmp`, where 69 tests fail for
  path-environment reasons (`expect(resumeContext).not.toContain("/tmp")` and friends). The failing
  **set is identical** on the baseline and option-B trees, so no regression is *observed*, but "the
  repo-root suite is green" is **not measured** — the implementer must run it.
- **The real SDK's `session.messages` on a never-started session.** The mocks have no `messages`; M4's
  T1 failure therefore partly reflects a fixture artifact. The stated reason for the inline release
  (no fabricated output, TDZ) does not depend on it.
- **The completion-push wake path** (`terminal-notifier.deliverCompletionAlert`) for a pre-start
  failure: only the `subagent:failed` emit is observed, not the toast/message the conductor receives.
- **Windows/POSIX differences** in the EISDIR force used by T7.
- **Whether the shipped `.d.ts`/exports change**: none do — the helper is a function-scoped `const`.

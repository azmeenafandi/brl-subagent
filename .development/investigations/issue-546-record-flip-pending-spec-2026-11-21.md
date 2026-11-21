# #546 — a crash between the terminal writes leaves a `running` agent record boot cannot repair — spec **r2**

**Issue:** #546 (harden) · priority **low** (a process kill inside a sub-millisecond window; state
consistency, not a lost run) · **C1** · worktree **y**.
**Spec r2:** 2026-11-21, against `c575a6c` (`git status --porcelain` → **0**; every probe ran in
`~/.cache/brl-subagent/scratch/spec-546-r2/`, never the repository, never `/tmp`). r1 was measured
`needs-work` (7 majors); this revision implements all seven and the four minors and **re-measures every
fix** (§Evidence: E1–E5/E11/E13 re-recorded, E9–E13 new, 17/17 mutants killed). **Status:**
decision-ready — one finding corrects the r2 mandate's own wording (row M2) and one corrects the r1 harness
reading, each with the measurement that forced it.

---

## r1 → r2 changes

| # | r1 (measured wrong by `critique-546-r1`) | r2 (implemented + measured) | Evidence |
|---|---|---|---|
| **1** | STEP 0's `boolean` was **discarded**; a failed marker write still deferred retirement, so the entry looked repairable with no durable intent | `marked` is consumed: on `false` log a warning, run STEP A with `deferRetire: false` (**retire-then-append**, the pre-#546 order), **skip STEP D**. No half-marked state is constructible (atomic temp+rename; the only `false`+entry case is an entry `readEntry` cannot parse, which the boot scan also skips). Residue on a crash in that window = the **pre-#546** residue, stated (P5) | **H1** (real helper, registry dir `0500`): `markRecordFlipPending` → `false`, terminal persist called with `{deferRetire:false}`, leftover entry has **no** marker; **M12** dies |
| **2** | `loadAgent` conflated **absent** with **unreadable**; `if (!persisted) return true` could retire the only marker over a still-`running` file | the store gets its named path helper **`agentRecordPath(id)`** (`<STORAGE_DIR>/<id>.json`, validated) and a **tri-state** reader **`readAgentRecordFromDisk(id)` → `{record, exists}`**: absent ⇒ `'retired'`; present-but-unreadable/corrupt ⇒ `false` + warn, **marker kept**; the scan gives unreadable its own verdict (`flipFailures++`) | **H2a** (chmod `000`: failures 1, entry kept, later boot repairs), **H2b** (absent ⇒ retired 1, no file created), **H2c** (corrupt ⇒ failures 1), **H2d** (applier alone ⇒ `false`); **M13** dies |
| **3** | dead-owner gating did **not** serialize two boot scans; a stale in-memory record could re-stamp a settled one | a **pre-flip disk read** (`readFreshAgentRecord` → `readAgentRecordFromDisk`, wired in the boot applier) is what `recordFlipDecision` and `flipAgentRecord` decide on, not the scanner's memory; the ledger counts the **applier's outcome** (`repaired`/`retired`/`false`), not the scan's earlier guess. **Guarantee narrowed and stated** (§The narrowed guarantee) | **H3** (stale memory `running` + disk `failed`: retired, **0** events, `completedAt` unchanged), **seq race** (2nd boot 0/0/0), **seam race** (both pass the check ⇒ both rewrite: **2** repairs, **2** events, 2–5 ms stamp drift) |
| **4** | retirement was unverified: `flipRetired=1` with the entry still on disk | `clearInflightRun` returns **`boolean`** (`true` = the desired end state — gone or never there; `false` = still there); existing callers ignore it; the applier returns `false` on a failed unlink ⇒ `flipFailures++`, marker kept | **H4a/H4b** (registry `0500`: failures 1, entry kept, later boot retires), **H4c/H4e** (failed flip never retires), **H4d** (the **production** wiring counts it); **M10/M14** die |
| **5** | M2's mechanism was **false**: with `deferRetire` a marker written **after** STEP A succeeds | S1 pins the invocation order **`markRecordFlipPending` before the terminal `pi.appendEntry`**; M2's killers are restated **S1 + H1** (measured; **S2 does not kill it** — see the correction note). Four new guards get mutants | **M2** → S1, H1 (probe **22/22** — S2/C1/C2/R4 survive); **M12** → H1; **M13** → H2d, **M13b** (the reader) → H2a/H2c/H2d; **M14** → H4d; **M15** → H3/H4c/H5/S3 |
| **6** | "import alongside" was ambiguous; a static mutator import violates the reader-API rule | the applier is built at the **existing** `await import("./session-manager")` site (`boot-recovery.ts:113`) inside its own containment; the import is now **optional**, so a failure leaves `applyRecordFlip`/`readFreshAgentRecord` unset and the scan takes the **no-applier** (pre-#546) branch. No allow-list change: the rule's static edge is what it checks, and `import()` edges carry no names | import-failure probe: `unavailableWarned` ✓, `scanFailed:false`, `marked:1`, marker **kept**, record `running`; static-import falsifier: arch suite **fails** (`boot-recovery.ts → session-manager.flipAgentRecord`), `check-imports` 60/0 |
| **7** | the harness parsed `msg`; the logger writes `message`, so the triple was never verified — and a *missing* line defaulted to `0,0,0`, so a base run "passed" vacuously | `boot.cjs` parses **`message`** and exits **3** on: a triple mismatch, a **missing** settlement line under `EXPECT_TRIPLE`, a settlement line present under `EXPECT_NO_SETTLEMENT` (base), or a `completedAt` that is not `set`/`unchanged` against the pre-kill snapshot | **E4a** `{1,0,0}` + `completedAt set` ✓, **E4b** `{1,0,0}` ✓, **E4c** `{0,1,0}` + `completedAt unchanged` (**1795226603307** twice) ✓, **E5** `NO_SETTLEMENT ok` ✓, **E1/E2** `NO_SETTLEMENT ok` ✓ |
| **m1** | acceptance 4 contradicted the terminal branch | **terminal-record exemption** stated: retiring an already-terminal record mutates nothing ⇒ owner-independent; a **repair** requires a provably dead owner | C6/H4a: terminal record retired with a dead owner; C3/C3b hold |
| **m2** | the STEP-A-throw risk wording was wrong | restated as the **uncommitted-run-entry residual** (record `failed`, run entry never committed, marker removed by the flip) and pinned by the existing `session-manager.test.ts:3766` case | existing case still green |
| **m3** | test delta said 165; V2/V3 missing | delta is **170/0** (r1 probe, now superseded by **384/0**), V2/V3 restored as rows; the source delta is re-measured | §Delta |
| **m4** | same-process retry skipped the write after permissions recovered | the **disk pre-read** makes the retry attempt the write again | **H5**: `false` (chmod `0400`), restore, second call ⇒ `'repaired'`, disk `failed` |

**Correction to the r2 mandate (measured).** The mandate asked to restate M2's killers as "S1/S2". S2 (the
crash pin) **passes** on the M2 mutant — the whole probe file is **22/22 green**, S2/C1/C2/R4 included —
because under M2 the marker is written after STEP A *and the entry is still there*, so
`markRecordFlipPending` succeeds and the crash pin sees a marker. Only an assertion on the **order** can
kill M2: S1 (explicit `invocationCallOrder`) and H1 (the fallback gate, which under M2 no longer precedes
STEP A, so `deferRetire` is `true` under `0500`). The mutant table states S1 + H1, not S2.

---

## Recon (Rule 13 — codegraph @ c575a6c)

```
# recoverInflightRuns (src/recovery.ts)          — where the marker branch lands
- callers: 4 — src/recovery.ts:463 (recoverProduction), src/__tests__/session-manager.test.ts:3344
  (scanBoot), src/__tests__/run-registry.test.ts:1, src/__tests__/session-manager.test.ts:1
- impact (depth 2): 8 symbols / 5 files — recovery.ts, boot-recovery.ts, 3 test files
- affected(src/recovery.ts): 80 test files      - grep delta: 17 raw hits (comments/strings included)
# persistRunRecord (src/run-registry.ts)         — the one terminal writer, shared with the foreground
- callers: 9 — session-manager.ts:1357 (spawnBackgroundSession), :1724 (finalizeRunEntry),
  state.ts:333 (persistRun), + 6 tests (recovery-surface, run-registry, session-manager:3344 scanBoot)
- impact: 86 symbols / 59 files    - affected: 83 test files    - grep delta: 27 raw hits
# markSpawnFailedBeforePrompt (src/session-manager.ts)   — the pre-start terminal path
- callers: 2 — session-manager.ts:2063 (failPreStart), :1357 (spawnBackgroundSession)
- impact: 18 symbols / 9 files (session-manager, background-session-persistence, headstate-git, …)
- grep delta: 21 raw hits
```

**r2 additions (new symbols, no callers yet — this unit introduces them):** `agentRecordPath`,
`readAgentRecordFromDisk`, `AgentFlipOutcome`, `flipAgentRecord` (session-manager); `RecordFlipPending`,
`RecordFlipStatus`, `markRecordFlipPending` (run-registry); `RecordFlipVerdict`, `RecordFlipOutcome`,
`FreshAgentRecord`, `recordFlipDecision`, `ownerProvablyDead` (recovery). `grep -rn 'recordFlipPending'
src/` at `c575a6c` → **0 hits**; at the r2 tree → **20** in `src/*.ts` (`run-registry` 11, `recovery` 9) plus
**23** in the two test files (`session-manager.test.ts` 2, probe 21).

## Recon verification — each load-bearing fact re-read at `c575a6c`

| # | Claim | Verdict | Anchor / command |
|---|---|---|---|
| **V1** | `persistRunRecord` retires **then** appends (W-0) | **True** — `:347` vs `:351` | `sed -n 345,352p src/run-registry.ts` |
| **V2** | `clearInflightRun` is a bare `fs.unlinkSync` (no tombstone), and **swallows** the error — r2 makes it return whether the file is gone | **True** — `:261-269`; r2 `return !fs.existsSync(file)` in the `catch` | `src/run-registry.ts:261` |
| **V3** | `updateInflightRun` never resurrects (missing entry ⇒ `false`) | **True** — `:252-259` | `src/run-registry.ts:252` |
| **V4** | recovery sources candidates **only** from the registry | **True** — `for (const entry of listInflightRuns())` at `:329` | `src/recovery.ts:329` |
| **V5** | a marker on a terminal record is **swallowed** by the scan | **True** — `if (agent && agent.status !== "running") continue;` at `:355` runs before any verdict | `src/recovery.ts:355` |
| **V6** | `persistRunRecord` has **one** terminal-writer identity shared with the foreground | **True** — `state.ts` `persistRun` delegates; 9 callers, 2 production | recon block 2 |
| **V7** | `updateAgentStatus` mutates memory, persists, emits | **True** — `:1126-1155` | `src/session-manager.ts:1126` |
| **V8** | `persistAgent` **swallows** write errors | **True and load-bearing** — `writeFileSync` in a `try` whose `catch` only logs (`:509-539`); measured **E7** | `src/session-manager.ts:509` |
| **V9** | the agent map is module state, never reset | **True** — `const agents = new Map(...)` at `:195`; one uuid per test (measured: a shared id makes a later case read the earlier record) | `src/session-manager.ts:195` |
| **V10** | `BootScanSummary` additions are safe | **True** — the only shape assertion is `toMatchObject` | `run-registry.test.ts:596` |
| **V11** | the never-started path already gates on a provably-dead owner; the same predicate is needed here | **True** — inline `ownerDead` at `:390-397`; #546 extracts `ownerProvablyDead` | `src/recovery.ts:390` |
| **V12** | a failed marker write cannot leave a **half-marked** entry | **True** — `writeAtomic` = temp `0600` + `renameSync` (`:196-208`); the temp name ends `.tmp`, so `listInflightRuns` (`.json` only, `:272`) never reads it | `src/run-registry.ts:196` |
| **V13** | the architecture rule does **not** see names on a dynamic `import()` | **True** — the `ImportKeyword` branch pushes `names: []` (`architecture-rules.test.ts:131-137`); the reader-API rule iterates `edge.names` | `sed -n 128,140p src/__tests__/architecture-rules.test.ts` |

**Grep coverage.** `grep -rn 'listInflightRuns()' src/*.ts` → 5 hits, all read paths named in §Blast radius
(`recovery.ts:329`, `boot-recovery.ts:252`, `recovery-surface.ts:231`, `session-manager.ts:718`,
`run-registry.ts:272` itself). `grep -n 'import { .* } from "./session-manager"' src/boot-recovery.ts` → 0
hits (every session-manager edge there is `await import`). `grep -c 'flipAgentRecord\|readAgentRecordFromDisk'
src/boot-recovery.ts` at the r2 tree → **2** (both inside the guarded import block).

---

## Context — two windows, measured end to end with the production wiring

The #542 fix (merged) swapped the pre-start order to **run entry → record flip → transcript**
(`session-manager.ts:2013`, `finalizeRunEntry` → `persistRunRecord` → append). It left two residues that
**no boot scan repairs**, reproduced with a real `SIGKILL` and the **production** boot scan, observed by a
third process (**E1/E2**; §Evidence).

**W-0 — inside STEP A, after `clearInflightRun` and before `appendEntry`** (re-measured, **E2**): record
`running`, run entry `running` (never attempted), registry **retired**, session dir pruned, no flip ledger
at all, restart-observable status `running`.
**W-1 — after the run entry commits, before the record flip** (**E1**): record `running` (**stale**), run
entry `failed`, otherwise identical — no ledger, restart status `running`.

Both share one cause: **the signal a fresh process can read (the registry entry) is deleted before the
write that repairs the record happens.** Candidates come from the registry (`V4`), so once the entry is
unlinked there is none, and the record is a zombie only `get_subagent_result` reports.

**The "obvious minimal fix" is measured too (option D, E5, re-recorded).** Appending before retiring
repairs nothing: the boot marks the entry interrupted (`marked=1`) and delivers a notice (`NOTICES=1`) for
a dispatch whose run entry already says `failed`, while the record **stays `running`**. A registry-only
scan cannot read the dead process's run entry.

---

## Decision — Option A: a marker written **before** retirement, retirement deferred to after the flip

The one durable signal a fresh process can read must carry the **intent**, not just the liveness. A field
on the registry entry does that, and it dies with the entry — which is why the retirement moves to **last**.

### Marker lifecycle — written → survives → cleared, with every crash/fault point

| # | Point | What is on disk | Next boot |
|---|---|---|---|
| **P0** | after `markRecordFlipPending`, before the run-entry append | entry+marker, record `running`, run entry `running` | **repaired**: record `failed` (+`completedAt`+`error`), entry retired, `flipRepaired=1` (**E4a**) |
| **P1** | after the commit, before the flip | entry+marker, record `running`, run entry **`failed`** | **repaired**, same as P0 (**E4b**) |
| **P2** | after the flip, before the retire | entry+marker, record `failed` | **retired only**: no rewrite, `completedAt` unchanged, no event, `flipRetired=1` (**E4c**) |
| **P3** | the flip's own write failed (`persistAgent` swallows, **V8**) | entry+marker, record `running` **on disk** | repair **deferred**: `flipFailures=1`, entry kept (**E6**) |
| **P4** | the owner is alive (second process booting) | entry+marker, record `running` | **held**: nothing written, entry kept, no retry offer (**E4d**) |
| **P5** | **STEP 0 failed** (marker write `false`) | entry **without** marker, pre-#546 order taken | **not repairable** — the historical residue (W-0/W-1). Stated, not claimed: with no durable intent there is nothing for a boot to read (`E2`) |

**The invariant the design buys:** *a `running` agent record a fresh process can observe is either (a) owned by a live process, or (b) accompanied by a durable marker naming the terminal status.* No other state is constructible — **except** P5, the explicit pre-#546 fallback, named as such.

### The narrowed guarantee (major 3) — ordering, not mutual exclusion

One boot that **begins after another finished** cannot rewrite: the applier re-reads the record from the store immediately before deciding (`readFreshAgentRecord`), sees the terminal status, and only unlinks the entry — ledgered `retired`, not `repaired` (E4c, H3, the sequential race). But two boots whose scans and pre-flip reads **interleave** — both read `running` before either writes — are **not serialized by anything**: each writes its own `completedAt` and each emits `subagent:failed`. The reconciled outcome is one terminal record carrying the later writer's stamp (drift ≤ the read/write overlap) plus one duplicate event, which `claimTerminalNotice` dedups downstream. **Measured limit:** a two-process probe with a barrier between the pre-read and the write produced **2 repairs, 2 events, and a 2–5 ms stamp difference** (E11, two recorded runs); the same probe sequential produced **1 repair + 1 retire, 1 event**. Serializing this needs a per-run claim (an `O_EXCL` claim file, or an atomic-rename lease) — **out of scope** for this unit, and named as the remedy if serialization is ever required.

### The contract block — goes in `persistRunRecord`'s doc and the helper's doc, verbatim

> **MARKER BEFORE RETIREMENT.** The pre-start terminal path is `markRecordFlipPending` → terminal run entry
> (`deferRetire`) → record flip (`flipAgentRecord`) → **retire** (`clearInflightRun`). Retirement is last
> and conditional because `clearInflightRun` is an unlink (`V2`): a marker written after it has no home, and
> an entry retired before the flip leaves a `running` record no boot scan can source a candidate for.
> Every other `persistRunRecord` caller keeps retire-then-append — the deferral is opt-in by argument.
> **If the marker did not land, the deferral is NOT taken:** the pre-start path falls back to the pre-#546
> order and states that the residue is then the historical one.
>
> **THE FLIP VERIFIES THE DISK IN BOTH DIRECTIONS.** `persistAgent` swallows write errors (`V8`), so
> `updateAgentStatus` returning is not the flip landing: `flipAgentRecord` reads `<storage>/<id>.json` BEFORE
> deciding (a stale in-memory `running` must not re-stamp a settled record; a writable-again store must let
> a retry try again) and AFTER writing (only a terminal persisted status is `repaired`). Present-but-
> unreadable is **not** absence: the first keeps the marker, the second may retire it.
>
> **REPLAY IS INERT; HOLD, NEVER GUESS.** An already-terminal record is not rewritten (no `completedAt`
> re-stamp, no second `subagent:failed`) — the marker is retired with no write (`flipRetired`). A marker
> whose record is still `running` is applied only when its owner is **provably dead** (`V11`): a live or
> unverifiable owner may be microseconds from doing it itself, so nothing is written, nothing is offered,
> and the marker stays. **A record that is already terminal is exempt from the owner rule**: retiring it
> mutates nothing, so it is owner-independent; a **repair** (a write) requires a provably dead owner.
>
> **RETIREMENT IS VERIFIED.** `clearInflightRun` reports whether the entry is gone; a `false` is a failed
> settlement, counted and kept for the next boot, never reported as settled.

### The code — four touch points (r2)

**`src/run-registry.ts`** (+119/−6 measured):

```ts
export function clearInflightRun(id: string): boolean {      // ADDITIVE: void -> boolean
  const file = resolvePath(id);
  if (!file) return true;                                    // nothing addressable to remove
  try { fs.unlinkSync(file); return true; }
  catch { return !fs.existsSync(file); }                     // ENOENT = desired; EACCES = not
}
// markRecordFlipPending: r1 body, unchanged — but its boolean is now CONSUMED (STEP 0/D).
export function persistRunRecord(pi, run, kind?, options?: { deferRetire?: boolean }): void {
  if (run.status !== "running") { if (!options?.deferRetire) clearInflightRun(run.id); }
  else if (kind) { registerInflightRun(toRegistryInput(run, kind)); }
  pi.appendEntry(CUSTOM_ENTRY_TYPES.run, run);
}
```

**`src/session-manager.ts`** (+156/−28 measured):

```ts
function agentRecordPath(id: string): string | null {        // the ONE store path helper (F24)
  try { assertSafeAgentId(id); } catch { return null; }
  return join(STORAGE_DIR, `${id}.json`);
}
export function readAgentRecordFromDisk(id: string): { record: BackgroundAgent | null; exists: boolean } {
  const file = agentRecordPath(id);
  if (!file || !existsSync(file)) return { record: null, exists: false };   // CONFIRMED ABSENCE
  try { return { record: JSON.parse(readFileSync(file, 'utf-8')), exists: true }; }
  catch { return { record: null, exists: true }; }                          // UNREADABLE
}
export type AgentFlipOutcome = 'repaired' | 'retired' | false;
export function flipAgentRecord(id, status, error?): AgentFlipOutcome {
  const before = readAgentRecordFromDisk(id);                // PRE-FLIP: the DISK, not the map
  if (!before.exists) return 'retired';                      // nothing durable can go stale
  if (!before.record) { warn(); return false; }              // unreadable/corrupt: keep the marker
  if (isTerminalAgentStatus(before.record.status)) return 'retired';  // replay is inert
  try { updateAgentStatus(id, status, error); } catch (err) { warn(); } finally { /* release ref */ }
  const after = readAgentRecordFromDisk(id);                 // POST-FLIP: did it land?
  if (!after.exists) return 'retired';
  if (!after.record) { warn(); return false; }
  return isTerminalAgentStatus(after.record.status) ? 'repaired' : false;
}
```

`markSpawnFailedBeforePrompt` becomes STEP 0 → A → B → C → D with the fallback:

```ts
  const marked = markRecordFlipPending(id, { status: 'failed', error: message, at: new Date().toISOString() });
  if (!marked) safeLog(() => log.warn(`... marker not written for ${id} — using the pre-#546 order`, {}));
  try { finalizeRunEntry('failed', message, { deferRetire: marked }); } catch (err) { safeLog(...) }
  const landed = flipAgentRecord(id, 'failed', message);      // 'repaired' | 'retired' | false
  try { transcript.completeTranscript(id, 'failed'); } catch (err) { safeLog(...) }
  agent._sessionRef = undefined;
  if (marked && landed && !clearInflightRun(id))              // STEP D — skipped when unmarked
    safeLog(() => log.warn(`... record settled but the entry survived for ${id}`, {}));
```

The two blanket `clearInflightRun(id)` calls after the helper — `failPreStart` STEP 3 (`:2077`) and the
branch-refusal site (`:2221`) — are **deleted**: they would delete the marker that repairs this crash.

**`src/recovery.ts`** (+235/−7 measured):

```ts
export type RecordFlipOutcome = "repaired" | "retired" | false;
export interface FreshAgentRecord { record: PersistedAgentLike | null; exists: boolean }
function ownerProvablyDead(owner, deps): boolean { ... }     // extracted from the never-started path
function recordFlipDecision(entry, fresh: FreshAgentRecord, deps):
    "repaired" | "retired" | "held" | "unreadable" {
  if (!fresh.exists) return "retired";           // confirmed absence
  if (!fresh.record) return "unreadable";        // keep the marker, count a failure
  if (fresh.record.status !== "running") return "retired";
  return ownerProvablyDead(fresh.record.owner ?? entry.owner, deps) ? "repaired" : "held";
}
```

Inserted at the **top** of the candidate loop, before `if (agent && agent.status !== "running") continue;`
(`:355`, the drop that would otherwise swallow the marker, `V5`). The branch holds on `"held"` and
`"unreadable"` (the marker stays, the entry is kept, nothing is offered), calls the applier inside a
`try`, and ledgers **the applier's** `repaired`/`retired`/`false` — never its own earlier `decision`, or
the second boot in a race would count a repair it did not perform.

**`src/boot-recovery.ts`** (+50/−3 measured): the **existing** lazy import is made optional and the applier
is built inside it (one guarded block, no half-wiring):

```ts
    let sm: typeof import("./session-manager") | undefined;
    try { sm = await import("./session-manager"); }
    catch (err) { log.warn("Boot recovery: session-manager unavailable — running the registry-only scan", ...); }
    const wiring = sm;
    // recoverProduction({ readAgentRecord: wiring ? (id) => wiring.getAgent(id) : undefined,
    //   ...(wiring ? {
    //     readFreshAgentRecord: (id) => wiring.readAgentRecordFromDisk(id),
    //     applyRecordFlip: (verdict) => {
    //       const outcome = wiring.flipAgentRecord(verdict.id, verdict.status, verdict.error);
    //       if (outcome === false) return false;
    //       return clearInflightRun(verdict.id) ? outcome : false;   // retirement VERIFIED
    //     },
    //   } : {}),
```

If the import fails, both deps are absent: the scan still runs the registry half (mark + never-started) and
the marker branch leaves the entry to the ordinary candidate path — the pre-#546 behaviour (measured:
`marked:1`, marker kept, record `running`). **No allow-list change**: the reader-API rule only inspects
names on static edges, and this edge is `import()` (`V13`). A **static** named mutator import is the
falsifier and it fails the rule (E13).

### Sub-decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| **D1** | Field name, shape, vocabulary | `recordFlipPending?: { status, error?, at }`; `RecordFlipStatus = "failed" \| "completed"` (only `failed` written) | `status`+`error` are exactly what the flip writes; the value is copied verbatim into `updateAgentStatus` |
| **D2** | Written in STEP 0, **cleared** by the conditional STEP D retirement; a failed write falls back to the pre-#546 order | `markSpawnFailedBeforePrompt`'s first statement; `deferRetire: marked`, STEP D skipped | anything after STEP A has no entry to write to (`V1`); no durable intent ⇒ no deferral (P5) |
| **D4** | "Landed" means **disk** | `readAgentRecordFromDisk` before and after | **V8/E7**: a return-based "landed" retires the marker over a record still `running` |
| **D5** | Verdict ledger | `repaired` / `retired` / `failures`, three not one, counted from the **applier's outcome** | `repaired` rewrites a record (and emits); `retired` does not; `failures` must be visible. Under the race the second boot must ledger `retired`, not a second repair |
| **D6** | A marker beats `acceptedAt: null` | the marker branch is **before** the never-started classification | the marker names a terminal status for a dispatch whose run entry is already written |
| **D7** | Held ⇒ skip, not fall through | `continue` when the owner is live/unverifiable | measured **E5**: the ordinary path turns an unflippable entry into a false retry offer |
| **D8** | Fail-closed on the applier | `false` or a throw ⇒ `flipFailures++`, entry kept, scan continues | measured **E6/H4d** |
| **D10** | The two branch-refusal sites | unchanged except **deleting** the blanket `clearInflightRun` (`:2221`) | it would unlink the marker the helper just wrote |
| **D11** | The applier's return is the ledger | `RecordFlipOutcome`, not `boolean \| void` | a truthful `retired` under the race is impossible from the scan's earlier decision |
| **D12** | Unreadable is its own verdict | `"unreadable"` ⇒ `flipFailures++`, marker kept | "we could not tell" must not read as a clean boot (the #304 rule) |
| **D13** | `clearInflightRun` returns `boolean` | additive; existing callers ignore it | the applier is the only caller that needs the truth (**E4/H4a**) |

### Rejected options

| Option | Mechanism | Blast radius | Cost | Risk if the analysis is wrong |
|---|---|---|---|---|
| **B — separate marker file** (`<registry>/<id>.pending.json`) | survives the unlink; the flip unlinks it | `run-registry` (the dir reader must skip it: `listInflightRuns` treats **every** `*.json` as an entry, `:272-287`), `recovery`, `boot-recovery`, every test that counts registry files | ~+90 src, +30 tests | Two files with no atomic relation: a crash between "write pending" and "retire" leaves **both**, and an orphan `.pending.json` needs a sweep nobody wrote |
| **C — tombstones instead of unlink** | `clearInflightRun` writes `{state:"retired"}` | **every** registry reader + retention/prune + `.done` non-goals | +120 src, unknown churn | A permanent file per run; expiry needs a retention policy this unit does not own |
| **D — append-before-retire, no marker** | swap the order for this caller | `run-registry` only | ~+12 src | **Measured false positive (E5)**: `marked=1`, a notice for a dispatch whose run entry says `failed`, record stays `running` |
| **E — do nothing** | leave the residue; document it | 0 | 0 | `get_subagent_result` reports `running` forever; the repair is a manual record edit. Low incidence, but the state is provably reconstructible |
| **A (chosen)** | marker in the entry, retirement last, disk-verified flip, verdict at boot | `run-registry` (+field, +writer, +option, boolean retire), `recovery` (+verdict, +3 counters, +fresh read), `session-manager` (+3 helpers, STEP 0/D), `boot-recovery` (+1 guarded dep block) | **+560/−44 src, net +516** (257 code lines; 289 comment, 14 blank), tests ~+520 | If a boot runs **concurrently** with a live writer, the hold rule is the only prevention — measured (E4d) that it holds; the two-boot window is the stated limit (E11). If `persistAgent`'s swallow were fixed to throw, the read-back becomes redundant, not wrong |

### Blast radius — the registry readers, named

| Reader | Sees a marker? | Effect |
|---|---|---|
| `recovery.ts:329` (`listInflightRuns`) | yes | the new verdict, before the terminal-record drop |
| `boot-recovery.ts:252` (`maybeSendRecoveryNotice`) | indirectly | a repaired/retired entry is gone before the notice surface runs; a **held** entry has no `interruptedAt` ⇒ `collectInterruptedRuns` skips it |
| `recovery-surface.ts:231`, `session-manager.ts:718` | projected only when `interruptedAt` is present | a marker never becomes an "interrupted run" on any tool surface |
| `run-registry.test.ts:596` | `toMatchObject` | new summary fields are additive (`V10`) |
| the agent store (`session-manager` only) | n/a | `readAgentRecordFromDisk` is a new **read** of one record; `agentRecordPath` replaces two inline path builds and adds F24 validation to `persistAgent`'s path (already validated) |

---

## Tests — 25 measured cases (22 probe + 3 suite), each red on base unless marked

The probe file (`zz-546-r2-probe.test.ts`, **384 lines / 22 cases**) is a *measurement artefact*, not the
deliverable: namespace imports so the SAME file runs on base; the shipped tests import directly and live in
the suites named below. **Base: 21/22 red** (H4e is green on base by construction — a regression guard),
every failure at an assertion or a missing-symbol `TypeError`, not at import.

| # | Case | Suite | Pins | On base |
|---|---|---|---|---|
| **R1–R3** | marker round-trip + idempotent; a mistyped marker is **dropped** (entry survives); the writer is total (missing entry / unsafe id ⇒ `false`) | probe | the writer + lenient read (M11) | `TypeError: markRecordFlipPending` |
| **C5/R4** | `{deferRetire:true}` keeps the entry across a **throwing** append; without it the entry is retired first | probe | the W-0 order as an API contract (M3) | `expected [Array(0)] to deeply equal ['…json']` |
| **C1** | marker + `running` + dead owner ⇒ record `failed`+`completedAt`+`error`, entry retired, `flipRepaired===1` | probe | the repair (M1/M2/M4) | `expected 'running' to be 'failed'` |
| **C2** | the second scan is inert (`completedAt` unchanged, counters 0) | probe | replay safety | `expected 'undefined' to be 'number'` |
| **C3** | **live** owner ⇒ nothing written, entry kept, `flipRepaired===0`, `marked===0` | probe | the hold rule (M7/M9) | counter/`interruptedAt` mismatch |
| **C3b** | **unparsable** owner ⇒ held, `interruptedAt` stays null, `marked===0` | probe | hold ⇒ *skip*, not fall through (M7/M9) | `expected '…' to be null` |
| **C4** | applier's durable write failed ⇒ `flipFailures===1`, entry kept, record `running` | probe | fail-closed (D8) | `expected undefined to be 1` |
| **C6** | marker whose record **already landed** ⇒ retired, `completedAt` unchanged, `flipRetired===1` | probe | the drop-before-verdict ordering (M8) | entry leaks (`expected [Array(1)] to deeply equal []`) |
| **S2/P1** | STEP 0 + STEP A of the **real writers**, then the real boot ⇒ repaired, second boot inert | probe | the end-to-end repair on the shipped path | `expected 'running' to be 'failed'` |
| **H2a** | record **present but unreadable** (chmod `000`) ⇒ `flipFailures===1`, marker kept; after restore a later boot repairs | probe | major 2 — the **reader** (M13b) | `TypeError: flipAgentRecord` |
| **H2b** | **confirmed absent** record ⇒ `flipRetired===1`, entry gone, no record created | probe | absence ⇒ retire | `flipRetired` undefined |
| **H2c** | **corrupt** record ⇒ unreadable, marker kept, `flipFailures===1` | probe | major 2 — the **reader** (M13b) | `TypeError` |
| **H2d** | the **applier contract** refuses an unreadable record (`false`, no registry write) | probe | defence in depth — the **applier** (M13) | `TypeError` |
| **H3** | stale memory `running` + disk `failed` ⇒ **retired**, `completedAt` unchanged, **0** events | probe | the pre-flip disk read (M15) | `TypeError` |
| **H4a** | terminal record + registry `0500` ⇒ `flipFailures===1`, entry kept; after restore retired | probe | verified retirement (M14) | `TypeError` |
| **H4b** | landed flip + failed unlink ⇒ **failures**, not a repair | probe | verified retirement (M14) | `TypeError` |
| **H4c** | a **failed flip** (record `0400`) never retires; after restore repairs | probe | STEP D / fail-closed (M10/M15) | `TypeError` |
| **H4d** | the **production** wiring (`createBootRecovery`) counts a failed unlink as a failure | probe | the real applier (M10/M14) | `TypeError` |
| **H4e** | the **production** wiring never retires an entry whose flip did not land | probe | the real applier (M10) | **green on base** (guard) |
| **H5** | same-process retry: `false` (record `0400`), restore, second call ⇒ `'repaired'`, disk `failed` | probe | the disk pre-read (M15) | `TypeError` |
| **S1** | after a synchronous `prompt()` throw: `markRecordFlipPending` is invoked **before the terminal `pi.appendEntry`** (`mock.invocationCallOrder`), record `failed`, registry empty | `session-manager` | THE ordering pin (M1/M2) | `TypeError` on the spy target |
| **H1** | registry dir `0500` inside the pre-start window ⇒ marker `false`, terminal persist called with `{deferRetire:false}`, leftover entry has **no marker** | `session-manager` | the fallback (M12/M2) | `TypeError` |
| **S3** | record `0400` ⇒ flip `false`, STEP D skipped, marker kept; a later boot repairs | `session-manager` | **D4** + verified retirement (M5/M6/M15) | `TypeError` |

`it.skipIf(process.platform === "win32")` on every `chmod` case (S3, H1, H2a–d, H4a–e, H5). The existing pins at `session-manager.test.ts:3766`/`:3800` (spy: `clearInflightRun` ran on the pre-start path) stay **green unedited** — STEP D still calls it on the success path.

## Delta (ADR 0028) — measured from the scratch tree, not estimated

`allowance(surface) = 120 + 2 × max(Δsource, 0)`, net lines, `--no-renames`:

| Surface | + | − | net | allowance |
|---|---|---|---|---|
| `src/run-registry.ts` | 119 | 6 | +113 | — |
| `src/recovery.ts` | 235 | 7 | +228 | — |
| `src/session-manager.ts` | 156 | 28 | +128 | — |
| `src/boot-recovery.ts` | 50 | 3 | +47 | — |
| **src total** | **560** | **44** | **+516** | 120 + 2×516 = **1152** |
| `src/__tests__/session-manager.test.ts` (S1/H1/S3) | 137 | 2 | +135 | 1152 |
| `src/__tests__/zz-546-r2-probe.test.ts` (22 cases, artefact) | 384 | 0 | +384 | 1152 |
| **tests total (measured)** | **521** | **2** | **+519** | **within 1152** |

Stripped of comment-only lines the four-file source diff is **+271** — **257 code + 14 blank** — against
**289** comment lines outright (doc-heavy by house style; the contract block and the four guard comments are
required, not padding). The r1 probe file (170/0, 7 cases) is **retired** —
its harness lacks the r2 deps and 5/7 of its cases fail against the r2 tree (measured); the r2 probe
supersedes it and its 170 lines are **not** counted above. If the integrated set measures over the
allowance, the PR body carries the `Test budget: over-allowance — …` declaration and no pin is dropped.

## Mutants — 17 rows, every killer measured on the r2 scratch tree

| # | Mutant | Killed by (measured) |
|---|---|---|
| **M1** | delete STEP 0 (no marker) | S1, H1, S3 |
| **M2** | write the marker **after** STEP A | **S1, H1** — every probe case **passes** (22/22), S2 included |
| **M3** | ignore `deferRetire` in `persistRunRecord` | C5/R4, S2/P1, S3 |
| **M4** | `clearInflightRun` between STEP A and STEP B | S3 |
| **M5** | STEP D retires unconditionally | S3 |
| **M6** | `flipAgentRecord` returns `'repaired'` without the post-write read | H4c, H4e, H5, S3 |
| **M7** | `recordFlipDecision` returns `"repaired"` without the ownership guard | C3, C3b |
| **M8** | move the marker branch **below** `if (agent && agent.status !== "running") continue` | C6, H4a–H4d, S3 |
| **M9** | delete the `held ⇒ continue` | C3, C3b |
| **M10** | retire even when the flip returned `false` | H4d, H4e |
| **M11** | strict marker read (reject the whole entry on a bad marker) | R2 |
| **M12** | ignore the marker-write boolean (always defer) | H1 |
| **M13** | the **applier** treats present-but-unreadable as absent | H2d — in H2a/H2c the scan's own `"unreadable"` verdict holds first, so the applier guard needs the direct pin |
| **M13b** | the **reader** conflates unreadable with absent (`exists:false`) — the critique's major 2 verbatim | H2a, H2c, H2d (measured: 3 failed / 19 passed) |
| **M14** | ignore the unlink result | H4d |
| **M15** | memory-first pre-read in `flipAgentRecord` (no disk read) | H3, H4c, H5, S3 |
| **M-static** | a static `import { flipAgentRecord } from "./session-manager"` in boot-recovery | the **architecture suite**: `boot-recovery.ts → session-manager.flipAgentRecord` (10 passed / 1 failed); `check-imports.mjs` stays **60 files, 0 violations** — it does not check this rule |

M5/M6 are the pair that matters: **M5** is what a reviewer writes by hand ("just retire when the flip
returns"), **M6** is the only thing that makes M5 detectable. M10/M14 are the r2 pair: a settlement that
did not land must neither retire nor read as settled.

## Verification plan (conductor-ready, in order)

1. `git status --porcelain` → empty. Re-derive the anchors:
   `grep -n 'recordFlipPending\|markSpawnFailedBeforePrompt\|finalizeRunEntry\|clearInflightRun(id)\|persistRunRecord(pi, entry)' src/{run-registry,session-manager,recovery,boot-recovery}.ts`
   and paste the counts into the PR body (§Recon verification was taken at `c575a6c`).
2. Write the tests first. `npx vitest run src/__tests__/{run-registry,recovery,session-manager}.test.ts` →
   the red rows of §Tests, messages pasted (probe evidence: base **21/22**, §Evidence).
3. Implement in the §Execution sketch order — `run-registry` → `session-manager` → `recovery` →
   `boot-recovery`, `npx tsc --noEmit` clean at each hop (the tree typechecks without tests:
   `tsconfig.json` excludes `src/__tests__`).
4. Suites green; `npx tsc --noEmit` **0**; `node scripts/check-imports.mjs` clean; **the architecture suite**
   `npx vitest run src/__tests__/architecture-rules.test.ts` green (allow-list unchanged — `getAgent`,
   `listAgents`; the dynamic edge carries no names, `V13`).
5. M1–M15, M13b + M-static one at a time in a scratch copy (never the repo); record the killed case names
   (§Mutants is the expected table).
6. **The crash probes against the patched tree** (`phase1.cjs` writes the real records then `SIGKILL`s;
   `boot.cjs` runs `createBootRecovery().performBootRecovery()` + `maybeSendRecoveryNotice` in a fresh
   process; `read.cjs` is a third process). `boot.cjs` **parses `message`** and exits **3** on any of:
   `EXPECT_TRIPLE` mismatch or a **missing** settlement line, `EXPECT_NO_SETTLEMENT` violation (base
   controls, E5), `EXPECT_COMPLETEDAT` violation (`set`/`unchanged` vs the pre-kill `pre.json`).
   Record P0–P5, the two base controls (W-0, W-1), and E5.
7. **The two-process probes**: sequential (2nd boot 0/0/0) and the seam barrier (both repairs, 2 events,
   2–5 ms stamp drift) — the narrowed guarantee is a **stated limit**, not a claim.
8. **GATE — full suite in the worktree**: the four suites green and no new failing name against a
   pre-change run; record both name lists.
9. **GATE — the flow, from committed objects**: commit first, then
   `node scripts/check-test-budget.mjs --flow --base dev --head <final sha>`; record base/head sha, exit and
   the full line. A non-zero exit **with** the declaration is the expected outcome.

**Design assumptions (stateful checklist).** *(1) State:* one new FIELD on the existing per-run registry
file (dir `0700`, `0600`); no new path, no new file class, no lock. *(2) Teardown:* the retirement **is**
the teardown and it is now conditional, verified and last; a kill at any point leaves the marker, whose
consumer is the next boot — the sweep is the boot scan. *(3) Concurrency:* two processes can read the same
registry; the boot write is gated on `ownerProvablyDead`, and a **pre-flip disk read** makes a later boot
inert. Two boots that pass the check together are **not** serialized — the stated limit (E11); the remedy
(claim file) is out of scope. *(4) Missing/partial/unreadable:* invalid marker ⇒ dropped (fail-open to the
pre-#546 residue); absent record ⇒ retire; present-but-unreadable ⇒ keep + `flipFailures`; failed flip or
failed unlink ⇒ keep + `flipFailures`; marker-write `false` ⇒ pre-#546 order. *(5) Evidence:* E1–E13, Δ,
21/22 red-on-base, 17/17 mutants.

## Risks, residuals, out of scope

| Risk | Severity | Mitigation / statement |
|---|---|---|
| The `#542` contract comment claims STEP A "retires"; this unit moves it to STEP D | **medium** (review friction) | the contract block above is the replacement, and W-1 becomes a **repaired** state (P1) |
| Deleting the two blanket `clearInflightRun` calls (`:2077`, `:2221`) removes #542's "belt" | low | the belt was for a retired entry; S3 and the existing `:3766` case pin that the helper owns retirement |
| A boot-time `subagent:failed` could wake the completion push at startup | low | `deliverCompletionAlert` is `try/catch`-wrapped and deduped by `claimTerminalNotice`; it fires over a run entry that already exists |
| A **held** marker with an unverifiable owner is permanent | low, **stated** | no `/proc` ⇒ the platform guard skips the scan (`recovery.ts:463`); the entry is the durable intent and the record stays `running` exactly as today |
| Two boots that pass the pre-flip check together both rewrite | low, **stated limit** | `completedAt` drift ≤ the read/write overlap and one duplicate event, deduped downstream (**E11**); serialization = claim file, out of scope. The disk read-back costs two sync reads per repair, failure path only (M6/M15 is the alternative) |

**Residual windows this unit does not close** (stated, not claimed fixed):

- **Before STEP 0** — a kill between the durable dispatches and the marker write leaves the pre-#542 state
  (record `running`, entry present, run entry `running`): the boot scan marks it **interrupted** and offers
  a retry — the designed interrupted class.
- **The marker-write failure (P5)** — with no durable intent the fallback takes the pre-#546 order and a
  kill inside it is the historical residue (W-0/W-1). This is strictly better than an entry that looks
  repairable and is not; the fault requires a read-only/full registry, not a kill.
- **The STEP-A throw (the uncommitted-run-entry residual).** With a marker, a throwing terminal append is
  *attempted, not committed*: STEP B still flips the record and STEP D removes the marker, so the residue
  is **`agent=failed` with the run entry uncommitted** — the designed outcome of a fault, pinned separately
  by the existing `session-manager.test.ts:3766` case (green unedited).
- **Same-process repair** — a failed persist is not retried inside the same call; repair is deferred to the
  next boot. The disk pre-read means a **same-process retry** (a second `flipAgentRecord` after the store is
  writable) does attempt the write again (**H5**) — it is not automatic retry logic, just the absence of a
  memory-based shortcut.
- **A live, wedged owner** — the marker is held until that process dies; no boot may preempt a live writer.
- **The session entry stream at P0** — the repair flips the record and retires the entry, but the dead
  process's session log cannot be appended to; a resumed session still shows the last run entry `running`.
- Retention/`.done`/prune paths, the #542 write order, and any general registry redesign: **untouched.**

## Acceptance criteria

1. A marker written before retirement survives the run-entry write, the flip, and a crash at any of them;
   `listInflightRuns()` reports it verbatim (R1, C5/R4).
2. A crash after the marker and before the flip is **repaired on the next boot**: the record is terminal
   with `completedAt` and the marker's `error`, the entry is gone, `flipRepaired === 1`, and a third process
   reports `getAgent(id).status === 'failed'` (C1, S2/P1, **E4a/E4b**). *Falsifier:* any observable
   disagreeing, or a boot whose log says `repaired: 0`.
3. A marker whose flip already landed retires **without** a rewrite: `completedAt`/`error` byte-identical,
   no second terminal event, `flipRetired === 1` (C2, C6, **E4c**, H3).
4. A **repair** (a write) happens only for a provably dead owner: live/unverifiable ⇒ no write, no
   `interruptedAt`, no retry notice, entry kept (C3, C3b, **E4d**). **Terminal-record exemption:** retiring
   an **already-terminal** record mutates nothing, so it is owner-independent (C6, H4a). *Falsifier:* a
   boot that marks a marker-bearing entry it cannot verify, or a repair over a live owner.
5. A failed flip write is **not** reported as landed: `'retired'`/`'repaired'`/`false` are distinct, a
   `false` keeps the marker and counts `flipFailures`, and the next boot repairs (C4, H4c, S3, **E6/E7**).
   *Falsifier:* `'repaired'` with the persisted status still `running`.
6. A failed **unlink** is not reported as settled: `clearInflightRun === false` ⇒ `flipFailures`, entry
   kept, next boot retires (H4a, H4b, H4d, **E12**). *Falsifier:* `flipRetired` with the entry still present.
7. An **unreadable/corrupt** record is not treated as absent: `false`, marker kept, `flipFailures === 1`
   (H2a, H2c, H2d); a **confirmed absent** record retires (H2b). *Falsifier:* `'retired'` while a readable-
   again record is still `running`.
8. A marker that could not be written falls back to the pre-#546 order and says so: `markRecordFlipPending
   === false` ⇒ `{deferRetire:false}`, STEP D skipped, no half-marked entry (H1, **E2/P5**).
9. The happy path leaves **nothing**: registry empty, record `failed`, run entry `failed`, marker gone (S1).
   No other `persistRunRecord` caller changes semantics (C5/R4).
10. `npx tsc --noEmit` clean; the four suites + the **architecture suite** green; the worktree full suite
    shows no new failing name; the flow verdict recorded from the committed head (steps 8–9).
11. `Structural closure: n/a — no moved/deleted exports` — **added** exports (`RecordFlipPending`,
    `RecordFlipStatus`, `markRecordFlipPending`, `AgentFlipOutcome`, `flipAgentRecord`,
    `readAgentRecordFromDisk`, `RecordFlipOutcome`, `FreshAgentRecord`, `RecordFlipVerdict`) and two added
    optional fields; `clearInflightRun`/`flipAgentRecord` signatures change **widening** (void→boolean;
    boolean→union) with no caller depending on the old shape. Nothing removed.

## Evidence

Probes ran in `~/.cache/brl-subagent/scratch/spec-546-r2/` (`base` = `c575a6c` src; `optA2` = this design,
`tsc --noEmit` exit 0). Every crash case: real `SIGKILL`, then a fresh process running the production boot,
then a third process reading only disk. `boot.cjs` parses `message` and **asserts**, exiting **3** on any
mismatch: the `repaired/retired/failures` triple (`EXPECT_TRIPLE`), the *absence* of any settlement line on a
tree that has no ledger (`EXPECT_NO_SETTLEMENT=1`), and `completedAt` against a `pre.json` snapshot taken
immediately before the `SIGKILL` (`EXPECT_COMPLETEDAT=set|unchanged`). A **missing** settlement line now fails
a triple assertion — r1 defaulted it to `0,0,0`, which made every base "assertion" vacuously true.

| ID | Claim | Probe | Observed |
|---|---|---|---|
| **E1/E2** | base W-1/W-0 residues | `run.sh base … w1` / `w0 "" "" 1` | `NO_SETTLEMENT ok:true` (no ledger at all), `REGISTRY=[]`, `RESTART=running` — the zombie; both windows reproduce |
| **E4a** | P0 repaired | `run.sh optA2 … p0 1,0,0 set` | `TRIPLE {expected:[1,0,0], actual:{repaired:1,retired:0,failures:0}, linePresent:true, ok:true}`; `COMPLETEDAT {expect:set, before:null, after:1795226598198, ok:true}`; `RESTART=failed`, `REGISTRY=[]` |
| **E4b** | P1 repaired | `run.sh optA2 … p1 1,0,0 set` | same triple, `ok:true`; `COMPLETEDAT set`, `before:null → after:1795226609891`; `COMMITTED_RUNS=[running,failed]` |
| **E4c** | P2 retired only | `run.sh optA2 … p2 0,1,0 unchanged` | `TRIPLE {…retired:1…, ok:true}`; `COMPLETEDAT {expect:unchanged, before:1795226603307, after:1795226603307, ok:true}`; `REGISTRY=[]` |
| **E4d** | live owner held | `phase1 p0-live` (+ a live `sleep` pid) then `boot.cjs` | `DISK=running`, `COMPLETEDAT=null`, entry+marker kept, `NOTICES=0`, `SCAN_LINES=[]` |
| **E5** | option D false offer, **asserted absent ledger** | `run.sh base … d1 "" "" 1` | `NO_SETTLEMENT {linePresent:false, ok:true}`, `marked:1`, `NOTICES=1`, `RESTART=running` — appending before retiring repairs nothing |
| **E6** | fail-closed | `bootOnce(() => false)` (C4) | `flipFailures:1`, entry kept, `DISK=running` |
| **E7** | `persistAgent` swallows | chmod `0400` + flip | without read-back `LANDED=true DISK=running`; with it `false` |
| **E8** | the r2 probes | `vitest zz-546-r2-probe` on optA2 / base | optA2 **22/22**; base **21 failed / 1 passed** (H4e is the green guard) |
| **E9** | unreadable vs absent vs corrupt | H2a/H2b/H2c/H2d | `000` ⇒ failures 1 + kept; absent ⇒ retired 1, no file; corrupt ⇒ failures 1; applier alone ⇒ `false` |
| **E10** | the pre-flip disk read | H3 | stale memory `running` + disk `failed` ⇒ `retired 1`, `completedAt` **111** unchanged, **0** events |
| **E11** | the race — and therefore the narrowed guarantee | `race-run.sh` seq / barrier / seam | seq: 2nd boot `0/0/0`, 1 event; barrier (applier entry): 2nd **retired 1**, 1 event; seam (both pre-reads `running`): **2 repairs, 2 events**, stamps `…634262` vs `…634257` (**5 ms**; 2 ms on the earlier run), final disk = the later stamp |
| **E12** | the retirement is verified | H4a/H4b/H4c/H4d, S3 | `0500` ⇒ failures 1, entry kept, later boot retires; failed flip ⇒ never retired |
| **E13** | import failure / static import | `boot-importfail.cjs` on a tree with `session-manager.ts` renamed; `mut-static` | failure: `unavailableWarned:true`, `scanFailed:false`, `marked:1`, marker kept, record `running`; static: arch suite **10 passed / 1 failed** (`boot-recovery.ts → session-manager.flipAgentRecord`), `check-imports` 60/0 |
| **Δ/T** | the delta + typecheck | `git diff --no-index --numstat base/src optA2/src`; `npx tsc --noEmit` | +50/−3, +235/−7, +119/−6, +156/−28 ⇒ **+560/−44, net +516** (257 code / 289 comment / 14 blank); tsc **0**; suites **251 passed** |

## Not verified

- **The worktree full suite and the flow verdict** — gates 8–9, not this investigation.
- **Automatic retry scheduling** — H5 proves a retry *attempts* the write; repair is deferred to the next
  boot. **The production drift window** — the seam probe bounds the overlap, it does not measure production
  (E11). **Windows** — `chmod` cases skipped; the read-back and tri-state are platform-neutral.

## Open questions (answered for r2)

1. **Which concurrency guarantee is required for simultaneous boot scans, and who owns its serialization?**
   **Ordering, not mutual exclusion.** A later boot is inert (E4c/E10/E11-seq); two boots that pass the
   pre-flip check together may both write (E11-seam) — drift ≤ the read/write overlap and one duplicate
   event, deduped by `claimTerminalNotice`. Serialization would be a per-run claim owned by `run-registry`
   (`O_EXCL` claim file or atomic-rename lease) — out of scope, named as the remedy if ever required.
2. **Should a confirmed missing agent record retire a marker?** **Yes** — absence means nothing durable can
   go stale, so the marker's only purpose (a later repair) is vacuous; it is retired with no write (H2b).
   **Present-but-unreadable is not absence**: we know nothing, so the marker is kept and the settlement is
   counted a failure (H2a/H2c/H2d).

## Execution sketch for the implementer (ordered)

`run-registry` (field/writer/option, `clearInflightRun` boolean) → `session-manager` (`agentRecordPath`,
`readAgentRecordFromDisk`, `loadAgent` delegates, `flipAgentRecord` + outcome, STEP 0–D + fallback, delete
the two blanket retires) → `recovery` (`RecordFlipOutcome`/`FreshAgentRecord`/`recordFlipDecision`, the
`unreadable` verdict, the fresh-read dep, `ownerProvablyDead`) → `boot-recovery` (optional import, guarded
applier + fresh reader, log line) → tests (S1/H1/S3 in `session-manager`; the 22 probe cases ported into
`run-registry`/`recovery`) → tsc + the four suites + the architecture suite + `check-imports` → 17 mutants
→ the crash probes (P0–P5, W-0/W-1, E5) → the two race probes → the worktree gates. Every step's expected
observable is a row above; a disagreement with a row is first evidence the **spec** is wrong (Rule 20).

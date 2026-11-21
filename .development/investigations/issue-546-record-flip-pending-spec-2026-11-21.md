# #546 — a crash between the terminal writes leaves a `running` agent record boot cannot repair — spec **r3**

**Issue:** #546 (harden) · priority **low** (a process kill inside a sub-millisecond window; state
consistency, not a lost run) · **C1** · worktree **y**.
**Spec r3:** 2026-11-21, against `c575a6c` (`git status --porcelain` → **0**; every probe ran in
`~/.cache/brl-subagent/scratch/spec-546-r3/` (0700), never the repository, never `/tmp`; no `npm install`).
r2 was measured `needs-work` (4 majors + 1 minor); this revision implements all five and re-measures every
fix (§Evidence E2/E4a–c/E8/E14–E17; 24/24 on r3, 2/24 red on the r2 tree; three new mutants). Two r2
**proof claims** are corrected (the tree's import check; the deletion count). **Status: decision-ready.**

## r1 → r2 changes

| # | r1 (measured wrong by `critique-546-r1`) | r2 (implemented + measured) | Evidence |
|---|---|---|---|
| **1** | STEP 0's `boolean` was **discarded**; a failed marker write still deferred retirement | `marked` is consumed: on `false` log, run STEP A with `deferRetire:false` (pre-#546 order), **skip STEP D**. No half-marked state is constructible (atomic temp+rename). Residue = the pre-#546 residue (P5) | H1 (registry `0500`): `false`, terminal persist `{deferRetire:false}`, leftover entry has no marker; M12 dies |
| **2** | `loadAgent` conflated **absent** with **unreadable**; `if (!persisted) return true` could retire the only marker over a still-`running` file | named path helper `agentRecordPath(id)` + **tri-state** reader `readAgentRecordFromDisk(id) → {record, exists}`: absent ⇒ `'retired'`; present-but-unreadable ⇒ `false` + warn, marker kept, `flipFailures++` | H2a (chmod `000`: failures 1, entry kept, later boot repairs), H2b (absent ⇒ retired), H2c (corrupt ⇒ failures 1), H2d (applier `false`); M13/M13b die |
| **3** | dead-owner gating did **not** serialize two boot scans; stale memory could re-stamp a settled record | a **pre-flip disk read** (`readFreshAgentRecord`) is what `recordFlipDecision` decides on; the ledger counts the **applier's outcome**. **Guarantee narrowed and stated** | H3 (stale memory + disk `failed` ⇒ retired, 0 events), seq race (2nd boot 0/0/0), seam race (2 repairs, 2 events, 2–5 ms drift) |
| **4** | retirement was unverified: `flipRetired=1` with the entry still on disk | `clearInflightRun` returns **`boolean`**; the applier returns `false` on a failed unlink ⇒ `flipFailures++`, marker kept | H4a/H4b (registry `0500`), H4c/H4e (failed flip never retires), H4d (production wiring); M10/M14 die |
| **5** | M2's mechanism was **false**: with `deferRetire` a marker written **after** STEP A succeeds | S1 pins the invocation order (**marker before the terminal `pi.appendEntry`**); M2's killers are **S1 + H1** (S2 passes: probe **22/22**) | M2 → S1, H1; four new guards get mutants |
| **6** | "import alongside" was ambiguous; a static mutator import violates the reader-API rule | the applier is built at the existing `await import("./session-manager")` site inside its own containment; the import is optional, so failure leaves both deps unset. No allow-list change (`V13`) | import-failure probe, static-import falsifier: arch suite fails, `check-imports` (base) 60/0 |
| **7** | the harness parsed `msg`; the logger writes `message` — a **missing** line defaulted to `0,0,0` | `boot.cjs` parses `message` and exits **3** on a mismatch, a **missing** settlement line, a settlement under `EXPECT_NO_SETTLEMENT`, or a wrong `completedAt` | E4a `{1,0,0}` + `set`, E4b, E4c `{0,1,0}` + `unchanged`, E5 `NO_SETTLEMENT ok`, E1/E2 |
| **m1** | acceptance 4 contradicted the terminal branch | **terminal-record exemption**: retiring an already-terminal record mutates nothing ⇒ owner-independent; a **repair** needs a provably dead owner | C6/H4a; C3/C3b hold |
| **m2** | the STEP-A-throw risk wording was wrong | restated as the **uncommitted-run-entry residual** (record `failed`, run entry never committed) | existing `session-manager.test.ts:3766` |
| **m3** | test delta said 165; V2/V3 missing | delta re-measured; V2/V3 restored | §Delta |
| **m4** | same-process retry skipped the write after permissions recovered | the **disk pre-read** makes the retry attempt the write again | H5: `false` (`0400`), restore, second call ⇒ `'repaired'` |

## r2 → r3 changes

| # | r2 gap (measured by `critique-546-r2`) | r3 (implemented + measured) | Evidence |
|---|---|---|---|
| **1** | absence and unlink were `existsSync`-based: an **untraversable parent** reads as "absent" — agent dir `000` → `retired=1, failures=0`, marker gone, record `running`; registry dir `000` → `clearInflightRun` **true**, entry kept | error-reporting I/O: `statSync`/`unlinkSync`; `ENOENT` = **confirmed**, any other error = **uncertain** (reader `{record:null, exists:true}`; unlink `false` after a confirming `statSync`). H2e/H4f added | **E14**: before `retired=1/failures=0` + entry gone; after `failures=1` + marker kept, later boot repairs; unlink before **true**, after **false**. H2e/H4f: 2 failed / 22 passed on the r2 tree, 24/24 on r3; M16/M17 |
| **2** | the no-applier branch **fell through**: `acceptedAt:null` → the never-started finalizer retired the marker (`registryFiles:[]`); accepted → `marked:1` + `interruptedAt` | when `applyRecordFlip` **or** `readFreshAgentRecord` is unavailable the scan `continue`s — no finalizer, no `marked`, no `interruptedAt`; entry and marker untouched | **E15** (the `boot-importfail` shape, both states): entry+marker kept, record `running`, no `interruptedAt`, marker **sha-identical**; M18 restores the r2 result |
| **3** | `claimTerminalNotice` is module-local, so two processes may each deliver a notice — not just duplicate events | the dedupe claim is **removed** from §The narrowed guarantee; the limit is stated and a shared claim named out of scope | **E16**: two processes, same id, both `first:true` (same-process second call `false`) |
| **4** | the W-0 probe set `BRL_CRASH_W0` with **no consumer** — `COMMITTED_RUNS:["running","failed"]`, a W-1 duplicate | scratch-only hook **in the real `persistRunRecord` seam** (after the unlink, before `pi.appendEntry`) + an `EXPECT_COMMITTED` assertion | **E2**: without the hook `["running","failed"]` → exit 3; with it `["running"]` → exit 0. The hook is not shippable (below) |
| **5** | `boot.cjs` parsed the **whole** log, so an earlier settlement line satisfied a later boot | assertions are scoped to bytes **appended after this boot started** (`statSync` offset) | **E17**: no-op second boot → `LOG_OFFSET:182`, `LOG_LINES_THIS_BOOT:0`, `TRIPLE actual:null ok:false`, exit **3**; the old parser on the same state → exit **0** |
| **m** | two r2 **proof** claims were wrong: `check-imports 60/0` was true of base, not of the r2 tree (the extended `./run-registry` import is a `wrap` violation), and the delta's deletion count was 49, not 44 | the import is **wrapped** one binding per line; the delta is re-derived from `base → optFinal` | `check-imports`: **1 violation** on the r2 tree, **60/0** on r3; §Delta re-measured (+594/−50) |

**No r2 *finding* was wrong.** All five reproduced exactly on the r2 tree before the fix (E14–E17); the
errors were in the r2 spec's *proof* (the two rows above) and in one r2 doc line that said a held marker
"falls through to the ordinary candidate path" while the code already `continue`d (only the no-applier
case was behavioural).

---

## Recon (Rule 13 — codegraph @ c575a6c) and r3 additions

```
# recoverInflightRuns (src/recovery.ts)   — callers: 4 (recoverProduction :463, scanBoot, 2 tests)
# persistRunRecord (src/run-registry.ts)  — callers: 9 (session-manager :1357/:1724, state :333, 6 tests)
# markSpawnFailedBeforePrompt (session-manager) — callers: 2 (:2063 failPreStart, :1357 spawn)
# r3 adds NO exported symbol: it replaces the bodies of `clearInflightRun` (run-registry) and
# `readAgentRecordFromDisk` (session-manager). `recordFlipPending` at c575a6c → 0; r3 → 20 + 23 tests.
```

**Recon verification (each re-read at `c575a6c`).** V1 `persistRunRecord` retires **then** appends (`:347`
vs `:351`). V2 `clearInflightRun` is a bare `unlinkSync` that **swallows** the error (`:261-269`) — r3 makes
it report the desired end state. V3 `updateInflightRun` never resurrects (`:252-259`). V4 candidates come
**only** from the registry (`recovery.ts:329`). V5 a marker on a terminal record is swallowed by
`:355` before any verdict. V6 one terminal-writer identity shared with the foreground. V7 `updateAgentStatus`
mutates memory, persists, emits (`:1126-1155`). V8 `persistAgent` **swallows** write errors (`:509-539`, E7).
V9 the agent map is module state (`:195`). V10 `BootScanSummary` additions are safe (`toMatchObject`).
V11 the never-started path already gates on a provably-dead owner (`:390-397`). V12 a failed marker write
cannot leave a half-marked entry (`writeAtomic` temp+rename; `.tmp` is never read). V13 the architecture rule
does not see names on a dynamic `import()` (`:131-137`). **V14 (r3)** `existsSync` returns false for
`EACCES` on a parent directory, not only for `ENOENT` — measured E14. **V15 (r3)** `claimTerminalNotice`
wraps `const terminalClaims = new Set<string>()` in `notify-completion.ts` — measured E16.

**Grep coverage.** `grep -rn 'listInflightRuns()' src/*.ts` → 5 read paths (`recovery.ts:329`,
`boot-recovery.ts:252`, `recovery-surface.ts:231`, `session-manager.ts:718`, `run-registry.ts:272`);
`grep -n 'import { .* } from "./session-manager"' src/boot-recovery.ts` → 0 (all `await import`);
`grep -c 'flipAgentRecord\|readAgentRecordFromDisk' src/boot-recovery.ts` → **2**, both guarded.

---

## Context — two windows, measured end to end with the production wiring

The #542 fix swapped the pre-start order to **run entry → record flip → transcript**; it left two residues
that **no boot scan repairs**, reproduced with a real `SIGKILL`, the **production** boot scan, and a third
process reading only disk.

**W-0 — after `clearInflightRun`, before `appendEntry`** (`persistRunRecord`'s real gap; re-measured through
the scratch hook, **E2**): record `running`, committed stream **`["running"]`** (terminal entry never
attempted), registry retired, session dir pruned, no ledger. **W-1 — after the commit, before the flip**
(**E1**): stream `["running","failed"]`, otherwise identical. One cause: **the signal a fresh process can
read (the registry entry) is deleted before the write that repairs the record** (V4).

**The "obvious minimal fix" is measured too (option D, E5).** Appending before retiring repairs nothing: the
boot marks the entry interrupted (`marked=1`) and delivers a notice (`NOTICES=1`) for a dispatch whose run
entry already says `failed`, while the record **stays `running`**.

---

## Decision — Option A: a marker written **before** retirement, retirement deferred to after the flip

### Marker lifecycle — written → survives → cleared, with every crash/fault point

| # | Point | What is on disk | Next boot |
|---|---|---|---|
| **P0** | after `markRecordFlipPending`, before the run-entry append | entry+marker, record `running`, stream `["running"]` | **repaired**: record `failed` (+`completedAt`+`error`), entry retired, `flipRepaired=1` (**E4a**) |
| **P1** | after the commit, before the flip | entry+marker, record `running`, stream `["running","failed"]` | **repaired** (**E4b**) |
| **P2** | after the flip, before the retire | entry+marker, record `failed` | **retired only**: no rewrite, `completedAt` unchanged, no event (**E4c**) |
| **P3** | the flip's own write failed (`persistAgent` swallows, V8) | entry+marker, record `running` on disk | **deferred**: `flipFailures=1`, entry kept (**E6**) |
| **P4** | the owner is alive | entry+marker, record `running` | **held**: nothing written, entry kept, no retry offer (**E4d**) |
| **P5** | **STEP 0 failed** (marker write `false`) | entry **without** marker, pre-#546 order | **not repairable** — the historical W-0/W-1 residue, stated (**E2**) |

**The invariant:** *a `running` agent record a fresh process can observe is either (a) owned by a live
process, or (b) accompanied by a durable marker naming the terminal status.* No other state is constructible
— **except** P5, the explicit pre-#546 fallback.

### The narrowed guarantee — ordering, not mutual exclusion

One boot that **begins after another finished** cannot rewrite: the applier re-reads the store immediately
before deciding, sees the terminal status, and only unlinks the entry — ledgered `retired` (E4c, H3, seq
race). Two boots whose pre-flip reads **interleave** are **not serialized by anything**: each writes its own
`completedAt` and emits `subagent:failed`; the reconciled record carries the later stamp (drift ≤ the
read/write overlap) plus one duplicate event. **Measured limit:** 2 repairs, 2 events, 2–5 ms drift (E11);
sequential: 1 repair + 1 retire, 1 event. **The notice claim does not close this across processes:**
`claimTerminalNotice` guards a module-level `Set` (`notify-completion.ts:318`), so two processes each win
the same claim and **each may deliver a notice** — duplicate notices are possible, not merely duplicate
events (**E16**: both `true`; same-process second call `false`). A shared claim is the remedy and is **out
of scope**; serializing the flip needs a per-run claim (`O_EXCL` file or atomic-rename lease), also out of
scope.

### The contract block — goes in `persistRunRecord`'s doc and the helper's doc, verbatim

> **MARKER BEFORE RETIREMENT.** The pre-start terminal path is `markRecordFlipPending` → terminal run entry
> (`deferRetire`) → record flip (`flipAgentRecord`) → **retire** (`clearInflightRun`). Retirement is last
> and conditional because `clearInflightRun` is an unlink (V2): a marker written after it has no home, and
> an entry retired before the flip leaves a `running` record no boot scan can source a candidate for.
> Every other `persistRunRecord` caller keeps retire-then-append — the deferral is opt-in by argument.
> **If the marker did not land, the deferral is NOT taken:** the pre-start path falls back to the pre-#546
> order and states that the residue is then the historical one.
>
> **THE FLIP VERIFIES THE DISK IN BOTH DIRECTIONS.** `persistAgent` swallows write errors (V8), so
> `updateAgentStatus` returning is not the flip landing: `flipAgentRecord` reads `<storage>/<id>.json` BEFORE
> deciding and AFTER writing (only a terminal persisted status is `repaired`). **Absence must be proven, not
> assumed:** only `ENOENT` from `statSync` is a confirmed absence; any other stat error is uncertain and is
> treated as unreadable (the marker is kept).
>
> **REPLAY IS INERT; HOLD, NEVER GUESS.** An already-terminal record is not rewritten — the marker is retired
> with no write (`flipRetired`). A marker whose record is still `running` is applied only when its owner is
> **provably dead** (V11). A record that is already terminal is exempt from the owner rule (retiring it
> mutates nothing); a **repair** (a write) requires a provably dead owner. **A marker whose applier or fresh
> reader is not wired is held**: no finalize, no interrupted mark, entry and marker untouched.
>
> **RETIREMENT IS VERIFIED.** `clearInflightRun` reports whether the desired end state is **proven**: an
> unlink that succeeds or returns `ENOENT` is `true`; any other unlink error is confirmed with a `statSync`
> and is `false` unless that stat proves `ENOENT`. A `false` is a failed settlement, counted and kept for
> the next boot, never reported as settled.

### The code — four touch points (r3)

**`src/run-registry.ts`** (+131/−12 cumulative):

```ts
export function clearInflightRun(id: string): boolean {       // ADDITIVE: void -> boolean
  const file = resolvePath(id);
  if (!file) return true;                                     // nothing addressable to remove
  try { fs.unlinkSync(file); return true; }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return true;    // confirmed gone
    try { fs.statSync(file); return false; }                             // confirmed still there
    catch (e) { return (e as NodeJS.ErrnoException).code === "ENOENT"; } // untraversable ⇒ uncertain ⇒ false
  }
}
// markRecordFlipPending: r1 body, unchanged — but its boolean is CONSUMED (STEP 0/D).
export function persistRunRecord(pi, run, kind?, options?: { deferRetire?: boolean }): void {
  if (run.status !== "running") { if (!options?.deferRetire) clearInflightRun(run.id); }
  else if (kind) { registerInflightRun(toRegistryInput(run, kind)); }
  pi.appendEntry(CUSTOM_ENTRY_TYPES.run, run);
}
```
**`src/session-manager.ts`** (+177/−28; the wrapped import is the `check-imports` fix):

```ts
function agentRecordPath(id: string): string | null { ... }   // the ONE store path helper (F24)
export function readAgentRecordFromDisk(id): { record: BackgroundAgent | null; exists: boolean } {
  const file = agentRecordPath(id);
  if (!file) return { record: null, exists: false };
  try { statSync(file); }
  catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { record: null, exists: false }; // CONFIRMED ABSENT
    warn(`Could not stat agent record ${id} — treating it as unreadable`);
    return { record: null, exists: true };                    // UNCERTAIN ⇒ unreadable ⇒ keep the marker
  }
  try { return { record: JSON.parse(readFileSync(file, "utf-8")), exists: true }; }
  catch { return { record: null, exists: true }; }            // UNREADABLE
}
export type AgentFlipOutcome = "repaired" | "retired" | false;
export function flipAgentRecord(id, status, error?): AgentFlipOutcome {
  const before = readAgentRecordFromDisk(id);
  if (!before.exists) return "retired";
  if (!before.record) { warn(); return false; }
  if (isTerminalAgentStatus(before.record.status)) return "retired";
  try { updateAgentStatus(id, status, error); } catch (err) { warn(); } finally { /* release ref */ }
  const after = readAgentRecordFromDisk(id);
  if (!after.exists) return "retired";
  if (!after.record) { warn(); return false; }
  return isTerminalAgentStatus(after.record.status) ? "repaired" : false;
}
```
`markSpawnFailedBeforePrompt` becomes STEP 0 → A → B → C → D with the fallback:

```ts
  const marked = markRecordFlipPending(id, { status: 'failed', error: message, at: ... });
  if (!marked) safeLog(() => log.warn(`... marker not written for ${id} — using the pre-#546 order`, {}));
  try { finalizeRunEntry('failed', message, { deferRetire: marked }); } catch (err) { safeLog(...) }
  const landed = flipAgentRecord(id, 'failed', message);
  if (marked && landed && !clearInflightRun(id))               // STEP D — skipped when unmarked
    safeLog(() => log.warn(`... record settled but the entry survived for ${id}`, {}));
```
The two blanket `clearInflightRun(id)` calls after the helper — `failPreStart` STEP 3 (`:2077`) and the
branch-refusal site (`:2221`) — are **deleted**: they would delete the marker that repairs this crash.
**`src/recovery.ts`** (+236/−7):

```ts
function recordFlipDecision(entry, fresh: FreshAgentRecord, deps):
    "repaired" | "retired" | "held" | "unreadable" {
  if (!fresh.exists) return "retired";           // confirmed absence
  if (!fresh.record) return "unreadable";        // keep the marker, count a failure
  if (fresh.record.status !== "running") return "retired";
  return ownerProvablyDead(fresh.record.owner ?? entry.owner, deps) ? "repaired" : "held";
}
```
Inserted at the **top** of the candidate loop, before `if (agent && agent.status !== "running") continue;`
(`:355`, V5). **The r3 hold is a full skip, including the missing-dependency case:**

```ts
if (entry.recordFlipPending) {
  if (!options.applyRecordFlip || !options.readFreshAgentRecord) {
    options.log?.debug("held a record-flip marker (applier or fresh-record reader not wired)");
    continue;                 // no never-started finalizer, no mark, entry and marker untouched
  }
  ...                         // unreadable ⇒ flipFailures++ + continue; held ⇒ continue
}
```
**`src/boot-recovery.ts`** (+50/−3): the **existing** lazy import is made optional and the applier is built
inside it (one guarded block, no half-wiring):

```ts
    let sm: typeof import("./session-manager") | undefined;
    try { sm = await import("./session-manager"); }
    catch (err) { log.warn("Boot recovery: session-manager unavailable — running the registry-only scan", ...); }
    const wiring = sm;
    // recoverProduction({ ...,
    //   ...(wiring ? {
    //     readFreshAgentRecord: (id) => wiring.readAgentRecordFromDisk(id),
    //     applyRecordFlip: (verdict) => {
    //       const outcome = wiring.flipAgentRecord(verdict.id, verdict.status, verdict.error);
    //       if (outcome === false) return false;
    //       return clearInflightRun(verdict.id) ? outcome : false;   // retirement VERIFIED
    //     },
    //   } : {}),
```
If the import fails, both deps are absent and the marker branch **holds** (E15). **No allow-list change**:
the reader-API rule only inspects names on static edges, and this edge is `import()` (V13).

### Sub-decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| **D1** | Field name, shape | `recordFlipPending?: { status, error?, at }`; `RecordFlipStatus = "failed" \| "completed"` (only `failed` written) | exactly what the flip writes, copied verbatim into `updateAgentStatus` |
| **D2** | Written in STEP 0, **cleared** by conditional STEP D; failed write falls back | `markSpawnFailedBeforePrompt`'s first statement; `deferRetire: marked` | anything after STEP A has no entry to write to (V1) |
| **D4** | "Landed" means **disk** | `readAgentRecordFromDisk` before and after | V8/E7: a return-based "landed" retires over a `running` record |
| **D5** | Verdict ledger | `repaired`/`retired`/`failures`, counted from the **applier's outcome** | a race's second boot must ledger `retired`, not a second repair |
| **D6** | A marker beats `acceptedAt:null` | the marker branch is **before** the never-started classification | the marker names a terminal status for an already-written run entry |
| **D7** | Held ⇒ skip, **including a missing dependency** | `continue` on `held`, `unreadable`, and `!applyRecordFlip || !readFreshAgentRecord` | a finalizer or a mark over a marker writes state no applier can settle (E15) |
| **D8** | Fail-closed on the applier | `false`/throw ⇒ `flipFailures++`, entry kept, scan continues | E6/H4d |
| **D10** | The two branch-refusal sites | unchanged except **deleting** the blanket `clearInflightRun` (`:2221`) | it would unlink the marker |
| **D11** | The applier's return is the ledger | `RecordFlipOutcome`, not `boolean \| void` | a truthful `retired` under the race is impossible from an earlier decision |
| **D12** | Unreadable is its own verdict | `"unreadable"` ⇒ `flipFailures++`, marker kept | "we could not tell" must not read as a clean boot (#304) |
| **D13** | `clearInflightRun` returns `boolean` **by error code** | `ENOENT` = success; any other error confirmed by `statSync`; uncertain ⇒ `false` | `existsSync` false conflates gone with untraversable (E14) |
| **D14** | Absence requires a **proof** | reader: `statSync` `ENOENT` only; any other stat error ⇒ `exists:true, record:null` | keeps the marker on an untraversable parent (H2e) |
| **D15** | The notice claim is **per process** | stated limit; duplicate notices possible | the claim `Set` is module-local (V15, E16) |

### Rejected options

| Option | Mechanism | Blast radius | Cost | Risk if wrong |
|---|---|---|---|---|
| **B — separate marker file** (`<registry>/<id>.pending.json`) | survives the unlink; the flip unlinks it | `run-registry` (the dir reader must skip it: `listInflightRuns` treats **every** `*.json` as an entry), `recovery`, `boot-recovery`, every test that counts registry files | ~+90 src, +30 tests | two files with no atomic relation: a crash leaves **both**, and an orphan `.pending.json` needs a sweep nobody wrote |
| **C — tombstones instead of unlink** | `clearInflightRun` writes `{state:"retired"}` | **every** registry reader + retention/prune + `.done` non-goals | +120 src, unknown churn | a permanent file per run; expiry needs a retention policy this unit does not own |
| **D — append-before-retire, no marker** | swap the order for this caller | `run-registry` only | ~+12 src | **measured false positive (E5)**: `marked=1`, a notice for an entry that says `failed`, record stays `running` |
| **E — do nothing** | leave the residue; document it | 0 | 0 | `get_subagent_result` reports `running` forever; the repair is a manual record edit |
| **F — shared cross-process claim** | a claim file or registry key per run id | `notify-completion` + a new store | ~+60 src, a new stateful file | out of scope: new retention/teardown surface for a duplicate notice (E16) |
| **A (chosen)** | marker in the entry, retirement last, disk-verified flip, error-code reads, hold on a missing applier | `run-registry` (+131/−12), `recovery` (+236/−7), `session-manager` (+177/−28), `boot-recovery` (+50/−3) | **+594/−50 src, net +544** (277 code; 303 comment, 14 blank), tests ~+546 | if a boot runs concurrently with a live writer, the hold rule is the only prevention — measured (E4d); the two-boot window is the stated limit (E11/E16). If `persistAgent`'s swallow were fixed to throw, the read-back becomes redundant, not wrong |

### Blast radius — the registry readers, named

| Reader | Sees a marker? | Effect |
|---|---|---|
| `recovery.ts:329` (`listInflightRuns`) | yes | the new verdict, before the terminal-record drop |
| `boot-recovery.ts:252` (`maybeSendRecoveryNotice`) | indirectly | a repaired/retired entry is gone before the notice surface; a **held** entry has no `interruptedAt` ⇒ `collectInterruptedRuns` skips it |
| `recovery-surface.ts:231`, `session-manager.ts:718` | projected only when `interruptedAt` is present | a marker never becomes an "interrupted run" on any tool surface |
| `run-registry.test.ts:596` | `toMatchObject` | new summary fields are additive (V10) |
| the agent store | n/a | `readAgentRecordFromDisk` is a new **read** of one record; `agentRecordPath` replaces two inline path builds and adds F24 validation |

---

## Tests — 29 measured cases (24 probe + 3 suite + 2 import-fail probes)

The probe file (`zz-546-r3-probe.test.ts`, **411 lines / 24 cases**) is a *measurement artefact*: namespace
imports so the SAME file runs on base/r2; the shipped tests import directly and live in the suites named
below. **On the r2 tree: 2 failed / 22 passed** (H2e, H4f); **on r3: 24/24**; on base every unguarded case
fails at an assertion or a missing-symbol `TypeError`, not at import.

| # | Case | Suite | Pins | On base (r2 exception marked) |
|---|---|---|---|---|
| **R1–R3** | marker round-trip + idempotent; a mistyped marker is **dropped**; the writer is total | probe | the writer + lenient read (M11) | `TypeError` (base) |
| **C5/R4** | `{deferRetire:true}` keeps the entry across a **throwing** append; without it the entry is retired first | probe | the W-0 order as an API contract (M3) | red (base) |
| **C1** | marker + `running` + dead owner ⇒ record `failed`+`completedAt`+`error`, entry retired, `flipRepaired===1` | probe | the repair (M1/M2/M4) | red |
| **C2** | the second scan is inert (`completedAt` unchanged, counters 0) | probe | replay safety | red |
| **C3/C3b** | **live** and **unparsable** owners ⇒ nothing written, entry kept, `flipRepaired===0`, `marked===0`, no `interruptedAt` | probe | the hold rule (M7/M9) | red |
| **C4** | the applier's durable write failed ⇒ `flipFailures===1`, entry kept, record `running` | probe | fail-closed (D8) | red |
| **C6** | marker whose record **already landed** ⇒ retired, `completedAt` unchanged, `flipRetired===1` | probe | the drop-before-verdict ordering (M8) | red |
| **S2/P1** | STEP 0 + STEP A of the **real writers**, then the real boot ⇒ repaired, second boot inert | probe | the end-to-end repair | red |
| **H2a/H2b/H2c** | record chmod `000` / confirmed absent / corrupt ⇒ (failures 1, kept) / (retired) / (failures 1, kept) | probe | major 2 — the **reader** (M13b) | red |
| **H2d** | the **applier** refuses an unreadable record (`false`, no registry write) | probe | defence in depth (M13) | red |
| **H2e** | **agent DIR `000`** ⇒ `flipFailures===1`, marker kept, record `running`; restore ⇒ later boot repairs | probe | **r3 fix 1** — uncertain ≠ absent (M16) | **r2: red** (retires); green on r3 |
| **H3** | stale memory `running` + disk `failed` ⇒ retired, `completedAt` unchanged, **0** events | probe | the pre-flip disk read (M15) | red |
| **H4a/H4b** | terminal + registry `0500` ⇒ failures 1, kept; landed flip + failed unlink ⇒ failures, not a repair | probe | verified retirement (M14) | red |
| **H4c/H4e** | a **failed flip** never retires; the production wiring never retires a flip that did not land | probe | STEP D / fail-closed (M10) | H4e green (guard) |
| **H4d** | the **production** wiring counts a failed unlink as a failure | probe | the real applier (M10/M14) | red |
| **H4f** | **registry DIR `000`** ⇒ `clearInflightRun === false`, entry still present after restore | probe | **r3 fix 1** — the unlink (M17) | **r2: red** (returns true); green on r3 |
| **H5** | same-process retry: `false` (`0400`), restore, second call ⇒ `'repaired'`, disk `failed` | probe | the disk pre-read (M15) | red |
| **S1** | after a synchronous `prompt()` throw: marker invoked **before** the terminal `pi.appendEntry`, record `failed`, registry empty | `session-manager` | THE ordering pin (M1/M2) | red |
| **H1** | registry dir `0500` in the pre-start window ⇒ marker `false`, terminal persist `{deferRetire:false}`, no marker | `session-manager` | the fallback (M12) | red |
| **S3** | record `0400` ⇒ flip `false`, STEP D skipped, marker kept; later boot repairs | `session-manager` | D4 + verified retirement (M5/M6/M15) | red |
| **N1/N2** | **session-manager unavailable**, `acceptedAt:null` / accepted ⇒ entry+marker **byte-identical**, record `running`, **no** `interruptedAt`, `marked` absent | import-fail probes (`boot-importfail.cjs`) | **r3 fix 2** — the hold (M18) | r2: `[]` / `marked:1` |

`it.skipIf(process.platform === "win32")` on every `chmod` case; the pins at `session-manager.test.ts:3766`/
`:3800` stay **green unedited** — STEP D still calls `clearInflightRun`.

## Delta (ADR 0028) — measured from the scratch tree (`base → optFinal`), not estimated

`allowance(surface) = 120 + 2 × max(Δsource, 0)`, net lines, `--no-renames`:

| Surface | + | − | net |
|---|---|---|---|
| `src/run-registry.ts` | 131 | 12 | +119 |
| `src/recovery.ts` | 236 | 7 | +229 |
| `src/session-manager.ts` | 177 | 28 | +149 |
| `src/boot-recovery.ts` | 50 | 3 | +47 |
| **src total** | **594** | **50** | **+544** → allowance 120 + 2×544 = **1208** |
| `src/__tests__/session-manager.test.ts` (S1/H1/S3) | 137 | 2 | +135 |
| `src/__tests__/zz-546-r3-probe.test.ts` (24 cases, artefact) | 411 | 0 | +411 |
| **tests total (measured)** | **548** | **2** | **+546** — within 1208 |

Stripped of comment-only lines the four-file diff is **594 added = 277 code + 303 comment + 14 blank**
(doc-heavy by house style; the contract block and guard comments are required). **Correction to r2:** its
`run-registry` deletion count (6) was short by 5 — base→r2 measures **+119/−11**, total **+560/−49 net
+511**, not `+560/−44 net +516`; the numbers above measure r3 directly.

## Mutants — 20 rows; the r3 rows were built and run on the r3 tree

| # | Mutant | Killed by (measured) |
|---|---|---|
| **M1** | delete STEP 0 (no marker) | S1, H1, S3 |
| **M2** | write the marker **after** STEP A | **S1, H1** — every probe case passes (22/22), S2 included |
| **M3** | ignore `deferRetire` | C5/R4, S2/P1, S3 |
| **M4** | `clearInflightRun` between STEP A and STEP B | S3 |
| **M5** | STEP D retires unconditionally | S3 |
| **M6** | `'repaired'` without the post-write read | H4c, H4e, H5, S3 |
| **M7** | no ownership guard | C3, C3b |
| **M8** | marker branch **below** the terminal-record drop | C6, H4a–H4d, S3 |
| **M9** | delete `held ⇒ continue` | C3, C3b |
| **M10** | retire when the flip returned `false` | H4d, H4e |
| **M11** | strict marker read | R2 |
| **M12** | ignore the marker-write boolean | H1 |
| **M13** | the **applier** treats present-but-unreadable as absent | H2d |
| **M13b** | the **reader** conflates unreadable with absent (`exists:false`) | H2a, H2c, H2d (3 failed / 19 passed) |
| **M14** | ignore the unlink result | H4d |
| **M15** | memory-first pre-read (no disk read) | H3, H4c, H5, S3 |
| **M-static** | a static `import { flipAgentRecord }` in boot-recovery | the architecture suite (10/1); `check-imports` does not check this rule |
| **M16** | the **reader** reverts to `existsSync` (untraversable parent = absent) | **H2e** (1 failed / 23 passed) |
| **M17** | the **unlink** reverts to `!existsSync` in the catch | **H4f** (1 failed / 23 passed) |
| **M18** | the **no-applier** branch restored as the r2 `else` fall-through | **N1/N2** — `registryFiles:[]` on null, `marked:1` + `interruptedAt` on accepted |

M5/M6 are the pair that matters: **M5** is what a reviewer writes by hand, **M6** is the only thing that
makes M5 detectable. M10/M14/M16/M17 are the settlement-integrity quartet: a settlement that did not land
must neither retire nor read as settled. The M1–M15/M13b rows remain as measured on the r2 tree (the r2
critic verified them); r3 re-ran the 24-case probe and the 3 suite cases green on the r3 tree.

## Verification plan (conductor-ready, in order)

1. `git status --porcelain` → empty. Re-derive the anchors:
   `grep -n 'recordFlipPending\|markSpawnFailedBeforePrompt\|finalizeRunEntry\|clearInflightRun(id)\|persistRunRecord(pi, entry)' src/{run-registry,session-manager,recovery,boot-recovery}.ts`
   and paste the counts into the PR body (§Recon was taken at `c575a6c`).
2. Write the tests first. `npx vitest run src/__tests__/{run-registry,recovery,session-manager}.test.ts` →
   the red rows of §Tests, messages pasted (probe evidence: r2 tree **2/24 red**, r3 **24/24**).
3. Implement in the §Execution sketch order — `run-registry` → `session-manager` → `recovery` →
   `boot-recovery`, `npx tsc --noEmit` clean at each hop (the tree typechecks without tests).
4. Suites green; `npx tsc --noEmit` **0**; `node scripts/check-imports.mjs` **60 files, 0 violations**
   (the `./run-registry` import **must be wrapped** — r2's tree had a `wrap` violation at
   `session-manager.ts:50`); the architecture suite **11/11** (allow-list unchanged).
5. M1–M18 + M13b one at a time in a scratch copy (never the repo); record the killed case names (§Mutants
   is the expected table). M16/M17 are single-case kills; M18 is measured through the module-rename shape.
6. **Crash probes against the patched tree** (`phase1.cjs` writes the real records then `SIGKILL`s;
   `boot.cjs` runs `createBootRecovery().performBootRecovery()` + `maybeSendRecoveryNotice` in a fresh
   process; `read.cjs` is a third process). `boot.cjs` parses `message` and exits **3** on any of:
   `EXPECT_TRIPLE` mismatch or a **missing** settlement line, `EXPECT_NO_SETTLEMENT` violation,
   `EXPECT_COMPLETEDAT` violation, **`EXPECT_COMMITTED`** mismatch (E2). Record P0–P5, the two base
   controls (W-0, W-1), and E5 (`accepted`, explicitly — the null-accepted entry is finalized, not marked).
7. **The W-0 seam**: run `base` **without** the scratch hook (stream `["running","failed"]` → exit 3) and
   **with** it (stream `["running"]` → exit 0). The hook is six lines in the *scratch* tree's
   `persistRunRecord`, between the retirement branch and `pi.appendEntry`; it is **not** in the deliverable
   (an env-gated kill switch on the terminal path is a fault-injection/DoS surface and a second, artificial
   crash path — the real W-0 is an external `SIGKILL` at that same syscall boundary).
8. **Harness scoping**: settle a P2 residue, then run a **no-op second boot** with `EXPECT_TRIPLE=0,1,0` →
   exit **3** (`LOG_LINES_THIS_BOOT:0`); the old whole-log parser on the same state → exit **0**.
9. **The two-process probes**: sequential (2nd boot 0/0/0) and the seam barrier (both repairs, 2 events,
   2–5 ms drift) — a **stated limit**, not a claim; plus the two-process claim probe (E16).
10. **GATES — full suite and the flow**: the four suites green with no new failing name against a
    pre-change run (record both name lists); then commit, and run
    `node scripts/check-test-budget.mjs --flow --base dev --head <final sha>` — record base/head sha, exit
    and the full line (a non-zero exit **with** the declaration is expected).

**Design assumptions (stateful checklist).** *(1) State:* one new FIELD on the existing per-run registry
file (dir `0700`, `0600`); no new path, file class, or lock. *(2) Teardown:* the retirement **is** the
teardown and it is conditional, verified, and last; a kill at any point leaves the marker, whose consumer is
the next boot. *(3) Concurrency:* two processes can read the same registry; the write is gated on
`ownerProvablyDead`, and the pre-flip disk read makes a later boot inert. Two boots that pass the check
together are not serialized — E11; the two-process **notice** claim is not shared — E16; both are stated
limits, with claim files named as the out-of-scope remedy. *(4) Missing/partial/unreadable:* invalid marker ⇒
dropped (fail-open to the pre-#546 residue); **confirmed absent (`ENOENT`) ⇒ retire**; **untraversable
parent/other stat error ⇒ unreadable** (keep + `flipFailures`); failed flip or failed unlink ⇒ keep;
marker-write `false` ⇒ pre-#546 order; **no applier/reader ⇒ hold**. *(5) Evidence:* E1–E17, Δ, 24/24 on
r3 / 2/24 red on r2, 20/20 mutants killed.

## Risks, residuals, out of scope

| Risk | Severity | Mitigation / statement |
|---|---|---|
| The `#542` contract comment claims STEP A "retires"; this unit moves it to STEP D | **medium** (review friction) | the contract block above is the replacement; W-1 becomes a **repaired** state (P1) |
| Deleting the two blanket `clearInflightRun` calls (`:2077`, `:2221`) removes #542's "belt" | low | the belt was for a retired entry; S3 and `:3766` pin that the helper owns retirement |
| A boot-time `subagent:failed` could wake the completion push at startup | low | `deliverCompletionAlert` is `try/catch`-wrapped; it fires over a run entry that already exists |
| **Two boots may each deliver a terminal notice** (the claim is module-local) | low, **stated** | duplicate notice possible; a shared claim is the out-of-scope remedy (E16) |
| A **held** marker with an unverifiable owner is permanent | low, stated | no `/proc` ⇒ the platform guard skips the scan (`recovery.ts:463`); the record stays `running` exactly as today |
| An **uncertain** stat (`000` parent) keeps the marker until a later boot can look | low, stated | fail-closed by design; E14 shows the later boot repairs. A permanently unreadable store leaves the marker for the operator |
| Two boots that pass the pre-flip check together both rewrite | low, stated limit | `completedAt` drift ≤ the read/write overlap and one duplicate event + notice (E11/E16); serialization = claim file, out of scope |

**Residual windows this unit does not close** (stated, not claimed fixed):

- **Before STEP 0** — a kill between the durable dispatches and the marker write leaves the pre-#542 state:
  the boot scan marks it **interrupted** and offers a retry (the designed interrupted class).
- **The marker-write failure (P5)** — no durable intent ⇒ the fallback takes the pre-#546 order; a kill
  inside it is the historical residue (W-0/W-1, E2); the fault is a read-only/full registry, not a kill.
- **The STEP-A throw (the uncommitted-run-entry residual)** — with a marker, a throwing terminal append is
  *attempted, not committed*: STEP B still flips the record and STEP D removes the marker, so the residue is
  **`agent=failed` with the run entry uncommitted** (pinned by `session-manager.test.ts:3766`).
- **Same-process repair** — a failed persist is deferred to the next boot; a second `flipAgentRecord` after
  the store is writable does attempt the write again (H5), which is the absence of a memory shortcut, not
  automatic retry logic.
- **A live, wedged owner** — the marker is held until that process dies; no boot may preempt a live writer.
- **The session entry stream at P0** — a resumed session still shows the last run entry `running`.
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
   an **already-terminal** record mutates nothing (C6, H4a). *Falsifier:* a boot that marks a marker-bearing
   entry it cannot verify, or a repair over a live owner.
5. A failed flip write is **not** reported as landed: `'retired'`/`'repaired'`/`false` are distinct, a
   `false` keeps the marker and counts `flipFailures`, and the next boot repairs (C4, H4c, S3, E6/E7).
   *Falsifier:* `'repaired'` with the persisted status still `running`.
6. A failed **unlink** is not reported as settled: `clearInflightRun === false` ⇒ `flipFailures`, entry
   kept, next boot retires (H4a, H4b, H4d, E12). *Falsifier:* `flipRetired` with the entry still present.
7. An **unreadable/corrupt** record is not treated as absent: `false`, marker kept, `flipFailures === 1`
   (H2a, H2c, H2d); a **confirmed absent** record retires (H2b). **An absent record proves `ENOENT`, not
   merely a false `existsSync`:** an untraversable parent is uncertain ⇒ marker kept, `flipFailures === 1`,
   and the later accessible boot repairs (H2e, E14). *Falsifier:* `'retired'` while a readable-again record
   is still `running`, or a `000` directory that reports a settlement.
8. A marker that could not be written falls back to the pre-#546 order and says so: `markRecordFlipPending
   === false` ⇒ `{deferRetire:false}`, STEP D skipped, no half-marked entry (H1, E2/P5).
9. A marker whose **applier or fresh reader is unavailable** is **held**: no never-started finalizer, no
   `marked`, no `interruptedAt`, entry and marker byte-identical (N1/N2, E15). *Falsifier:* an import
   failure removes or marks a marker.
10. The happy path leaves **nothing**: registry empty, record `failed`, run entry `failed`, marker gone (S1).
    No other `persistRunRecord` caller changes semantics (C5/R4).
11. `npx tsc --noEmit` clean; the four suites + the **architecture suite** (11/11) green; `check-imports`
    **60/0**; no new failing name in the worktree suite; the flow verdict recorded from the committed head.
12. **The W-0 stream is `["running"]`** with the instrumented seam, and `["running","failed"]` without it
    (the probe must fail the `EXPECT_COMMITTED` gate) — E2. **The harness is scoped:** a no-op second boot
    cannot satisfy an `EXPECT_TRIPLE` from an earlier boot (E17).
14. `Structural closure: n/a — no moved/deleted exports` — **added** exports (`RecordFlipPending`,
    `RecordFlipStatus`, `markRecordFlipPending`, `AgentFlipOutcome`, `flipAgentRecord`,
    `readAgentRecordFromDisk`, `RecordFlipOutcome`, `FreshAgentRecord`, `RecordFlipVerdict`) and two added
    optional fields; `clearInflightRun`/`flipAgentRecord` signatures change **widening** (void→boolean;
    boolean→union) with no caller depending on the old shape. Nothing removed.

## Evidence

Probes ran in `~/.cache/brl-subagent/scratch/spec-546-r3/` (`base` = `c575a6c` src; `optFinal` = this
design, `tsc --noEmit` exit 0; `before` = the r2 tree, used for every "before" row). Every crash case: real
`SIGKILL`, then a fresh process running the production boot, then a third process reading only disk.
`boot.cjs` parses `message`, scopes to bytes appended by **this** boot, and exits **3** on an
`EXPECT_TRIPLE` mismatch (or missing line), `EXPECT_NO_SETTLEMENT`, `EXPECT_COMPLETEDAT`, or
`EXPECT_COMMITTED` mismatch.

| ID | Claim | Probe | Observed |
|---|---|---|---|
| **E1/E2** | base W-1/W-0 residues | `run.sh base … w1`; `EXPECT_COMMITTED=running run.sh base … w0 null "" "" 1` | W-1 `["running","failed"]`; **W-0 without the seam hook `["running","failed"]` → exit 3; with it `["running"]` → exit 0**; both `REGISTRY=[]`, `RESTART=running` |
| **E4a** | P0 repaired | `run.sh optFinal … p0 1,0,0 set` | `TRIPLE {1,0,0}` `ok:true`; `COMPLETEDAT set` (`null → 1795227626486`); `RESTART=failed`, `REGISTRY=[]` |
| **E4b** | P1 repaired | `run.sh optFinal … p1 1,0,0 set` | same triple; `COMPLETEDAT set`; `COMMITTED_RUNS=[running,failed]` |
| **E4c** | P2 retired only | `run.sh optFinal … p2 0,1,0 unchanged` | `TRIPLE {0,1,0}`; `COMPLETEDAT unchanged` (1795227632466 twice); `REGISTRY=[]` |
| **E4d** | live owner held | `phase1 p0-live` (+ a live pid) then `boot.cjs` | `DISK=running`, `COMPLETEDAT=null`, entry+marker kept, `NOTICES=0`, `SCAN_LINES=[]` |
| **E5** | option D false offer, **asserted absent ledger** | `run.sh base … d1 accepted "" "" 1` | `NO_SETTLEMENT ok`, `marked:1`, `NOTICES=1`, `RESTART=running` |
| **E6/E7** | fail-closed; `persistAgent` swallows | `bootOnce(() => false)` (C4); chmod `0400` + flip | `flipFailures:1`, entry kept, `DISK=running`; without read-back `LANDED=true DISK=running`, with it `false` |
| **E8** | the probe file, and the r2 critic's verified-sound list | `vitest zz-546-r3-probe` on optFinal / before; 4 suites; arch; imports | optFinal **24/24**, before **2 failed / 22 passed** (H2e/H4f); suites **240 passed**; arch **11/11**; imports **60 files, 0 violations** (r2 tree: 1 violation); H2a/b/c, H4a/d, M1–M15+M13b as the r2 critic verified |
| **E9/E10** | unreadable vs absent vs corrupt; the pre-flip disk read | H2a–H2d; H3 | `000` ⇒ failures 1 + kept; absent ⇒ retired; corrupt ⇒ failures 1; applier ⇒ `false`; stale memory + disk `failed` ⇒ `retired`, `completedAt` unchanged, 0 events |
| **E11** | the race — the narrowed guarantee | `race-run.sh` seq / barrier / seam | seq: 2nd boot `0/0/0`, 1 event; barrier: 2nd **retired 1**, 1 event; seam: **2 repairs, 2 events**, stamps 5 ms apart |
| **E12** | the retirement is verified | H4a/H4b/H4c/H4d/H4f, S3 | `0500` ⇒ failures 1, kept, later boot retires; failed flip ⇒ never retired |
| **E13** | import failure / static import / import wrap | `boot-importfail.cjs`; `mut-static`; `check-imports` | failure: `unavailableWarned:true`, `scanFailed:false`, entry+marker kept; static: arch **10/1**; imports: **1 violation** on the r2 tree, **60/0** on r3 |
| **E14** | `existsSync` conflates an untraversable parent with absence | `dirprobe.cjs before/optFinal agent-dir-000`; `… registry-dir-000` | before: `retired=1, failures=0`, entry gone, record `running`; after: `failures=1`, marker kept, second boot `repaired=1`, record `failed`. Unlink before **true** (entry still there), after **false**. H2e/H4f: 2 failed/22 passed on r2, 24/24 on r3 |
| **E15** | the missing-applier hold | `phase1 p1 null/accepted` + `boot-importfail.cjs` | before: null ⇒ `registryFiles:[]`; accepted ⇒ `marked:1` + `registryInterruptedAt`; after: both keep entry+marker (sha256 identical), `record:running`, `interruptedAt:null`, no settlement line |
| **E16** | the notice claim is module-local | `twoclaim.cjs` × 2 processes, same id | `{"first":true,"secondInProcess":false}` twice — two processes win the same claim |
| **E17** | the harness log scoping | settle P2, boot once, no-op second boot with `EXPECT_TRIPLE=0,1,0` | second boot: `LOG_OFFSET:182`, `LOG_LINES_THIS_BOOT:0`, `TRIPLE actual:null ok:false`, exit **3**; the r2 whole-log parser on the same state: `ok:true`, exit **0** |
| **Δ/T** | the delta + typecheck | `git diff --no-index --numstat base/src optFinal/src`; `tsc --noEmit` | +131/−12, +236/−7, +177/−28, +50/−3 ⇒ **+594/−50 net +544** (277 code/303 comment/14 blank); tsc **0**; suites **240 passed** |

## Not verified

- **The worktree suite and the flow verdict** — gate 10, not this investigation. **Automatic retry
  scheduling** — H5 proves a retry *attempts* the write; repair is deferred to the next boot. **The
  production drift window** — the seam probe bounds the overlap, it does not measure production (E11).
  **Windows** — `chmod` cases skipped; the read-back and error-code paths are platform-neutral.

## Open questions (answered for r3)

1. **Which concurrency guarantee is required for simultaneous boot scans, and who owns its serialization?**
   **Ordering, not mutual exclusion.** A later boot is inert (E4c/E10/E11-seq); two boots that pass the
   pre-flip check together may both write (E11-seam) — drift ≤ the read/write overlap, one duplicate event
   **and notice** (the claim is per process, E16). Serialization needs a per-run claim
   (`O_EXCL` claim file or atomic-rename lease) owned by `run-registry`; a shared notice claim is a second,
   separate piece of state. Both are **out of scope**, named as the remedy if ever required.
2. **Should a confirmed missing agent record retire a marker?** **Yes** — absence means nothing durable can
   go stale, so the marker's only purpose (a later repair) is vacuous (H2b). **Present-but-unreadable and
   unprovable (a non-`ENOENT` stat error) are not absence**: we know nothing, so the marker is kept and the
   settlement is counted a failure (H2a/H2c/H2d, H2e, E14).

## Execution sketch for the implementer (ordered)

`run-registry` (field/writer/option; **`clearInflightRun` boolean by error code**) → `session-manager`
(`agentRecordPath`, **`readAgentRecordFromDisk` via `statSync` error codes**, `loadAgent` delegates, wrap the
`./run-registry` import, `flipAgentRecord` + outcome, STEP 0–D + fallback, delete the two blanket retires) →
`recovery` (`RecordFlipOutcome`/`FreshAgentRecord`/`recordFlipDecision`, the `unreadable` verdict, the
fresh-read dep, **the no-applier/held `continue`**, `ownerProvablyDead`) → `boot-recovery` (optional import,
guarded applier + fresh reader) → tests (S1/H1/S3 in `session-manager`; the 24 probe cases ported into
`run-registry`/`recovery`, including **H2e/H4f**) → tsc + the four suites + the architecture suite +
`check-imports` → 20 mutants (M16/M17 single-case, M18 through the import-fail shape) → the crash probes
(P0–P5, W-0 with the **scratch-only** seam hook, W-1, E5) → the harness-scoping re-run → the two race probes
+ the two-process claim → the worktree gates. Every step's expected observable is a row above; a
disagreement with a row is first evidence the **spec** is wrong (Rule 20).

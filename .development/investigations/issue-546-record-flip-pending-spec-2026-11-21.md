# #546 — a crash between the terminal writes leaves a `running` agent record boot cannot repair — spec **r4**

**Issue:** #546 (harden) · priority **low** (a process kill inside a sub-millisecond window; state
consistency, not a lost run) · **C1** · worktree **y**.
**Spec r4:** 2026-11-21, against `c575a6c` (`git status --porcelain` → **0**; every probe ran in
`~/.cache/brl-subagent/scratch/spec-546-r4/` (0700), never the repository, never `/tmp`; no `npm install`).
r3 was measured `needs-work` (2 **behavioural** majors + 4 minors); this revision implements all six and
re-measures every fix (§E18–E22, E2, E17). **Status: decision-ready.**

r4 changes **one source file** relative to r3 — `src/session-manager.ts` (+92/−22: the live/boot split) —
plus the tests. `run-registry.ts`, `recovery.ts` and `boot-recovery.ts` are **byte-identical to r3**, so the
re-measured rows for those surfaces (E14–E17, H2e, H4f, M16/M17) are the r3 rows re-run on the r4 tree, not
new claims.

## r3 → r4 changes

| # | r3 gap (measured by `critique-546-r3`) | r4 (implemented + measured) | Evidence |
|---|---|---|---|
| **1 (major)** | `flipAgentRecord` served **both** the live pre-start writer and the boot applier, so its "absent/unreadable ⇒ don't flip" rule left the **in-memory** agent `running` after a failed pre-start — a regression of the merged #542 fix — and an absent record also retired the marker that could have repaired it. | **Three functions, two contracts, one disk verdict.** `settleLiveAgentRecord` (live): `updateAgentStatus` **first and unconditionally** (memory terminal in every fault), then the shared disk verdict. `flipAgentRecord` (boot): disk-only, unchanged. `terminalVerdictAfterWrite`: `repaired` (terminal) / `retired` (absent) / `false` (running or unreadable — keep the marker). STEP B calls the **live** helper; the boot applier keeps the replay one (`boot-recovery.ts:167`). Both helpers are total, and `_sessionRef` is still cleared **outside every try** (STEP C's neighbour, `:2246`). | **E18**: r3 `unreadable {running, marker}` / `absent {running, marker gone}`, `INITIAL_WRITE {running, disk:false, registry:0}`; r4 `unreadable {failed, disk:true, marker}` / `absent {failed, disk:true, marker gone}`, `INITIAL_WRITE {failed, disk:true, registry:0}`. **A mutant of r4 that restores the r3 call (`M19`) reproduces r3's three states exactly.** |
| **2 (major)** | the import-failure **hold** was measured only by `boot-importfail.cjs`, which printed and never asserted; the shipping list carried the 24 probe cases + S1/H1/S3 only, so nothing in CI held the contract. | **Shipped** `src/__tests__/boot-recovery-import-failure-546.test.ts`: N1/N2 drive the real factory (`createBootRecovery` → `performBootRecovery`) with the **whole** `../session-manager` module made unavailable by a throwing `vi.mock`, and assert entry **and** record bytes identical, no `interruptedAt`, no `marked`, no never-started finalizer, no notice, no ledger line. The scratch probe gained the same assertions and exits (0 hold · 5 violated · 4 threw · 2 fault not reproduced). | **E19**: shipped 2 passed on r4, **2 failed on M18** (N1: `ENOENT … registry/<id>.json` — the entry was retired; N2: bytes differ, `+ "interruptedAt": …`); probe HOLD-OK exit 0 on r4 and r3, HOLD-VIOLATED exit 5 on M18 in **both** acceptance states, exit 2 on a normal tree (the assertion cannot pass vacuously). |
| **3 (minor)** | E17's log scoping failed **open** on rotation/truncation: a replacement file shorter than the offset was read from byte 0, so an old settlement line satisfied a later boot. | the harness stamps the offset with the log's **identity** (`size`, `mtimeMs`, `ino`) and re-`statSync`s before reading: a changed identity or a shrunken size **fails closed** (exit 3) with a named reason. | **E17**: positive current-boot line → exit 0; **rotation** → `LOG_SCOPE {"ok":false,"reason":"log-identity-changed","offset":182}` + exit 3; **truncation** → `log-shrank` (offset 1972) + exit 3; the r3 whole-log parser on the same state → exit 0 (the old fail-open). |
| **4 (minor)** | the C1 row attributed M1/M2/M4 coverage to a test that **plants the marker directly**; those mutations do not touch it. | the C1 row states what C1 is (the positive repair pin) and names the **measured survivors**; the mutant rows keep the independently measured killers. | **E22**: `vitest -t 'C1:'` → **1 passed / 23 skipped** on `mut-M1`, `mut-M2`, `mut-M4` (and on M5/M9/M13b). M1's killers are S1/H1/S3, M2's S1/H1, M4's S3 — each re-measured. |
| **5 (minor)** | `EXPECT_COMMITTED` could pass a **nonempty delimiter-only** expectation as an empty stream, and could not distinguish a missing/unreadable stream from a valid empty one. | the parser **rejects a zero-status expectation** (exit 2 + a USAGE line) and the assertion reports `stream:"missing"` vs `stream:"present"` with an empty list as **different failures**. | **E2**: `EXPECT_COMMITTED=` and `,` → `{"expected":[],"reason":"empty-expectation"}` + exit 2; removed stream → `{"actual":[],"stream":"missing","reason":"stream-missing"}` + exit 3; present-but-empty → `{"stream":"present","reason":"mismatch"}` + exit 3; unset → exit 0. |
| **6 (minor)** | §D7 did not say what a **held** marker counts as, and the half-wired shapes (applier without reader, reader without applier) were unpinned. | §D7 states: a hold touches **no** settlement counter — `flipRepaired`, `flipRetired`, `flipFailures` are all **zero, by design** (it is neither a settlement nor a failed settlement). Two shipped cases pin both half-wired shapes in both acceptance states. | **E20**: probe 4/4 `{"unchanged":true, …, "flipRepaired":0,"flipRetired":0,"flipFailures":0}` exit 0; shipped 2 passed; `M20` (`\|\|` → `&&`) fails both. |

**Kept verbatim from r3** (each re-measured where r4 touches it, otherwise re-run unchanged): the error-code
`statSync`/`unlinkSync` logic (E14, H2e/H4f, M16/M17 rebuilt on the r4 tree), the hold-when-unavailable
branch order, the per-process notice-limit wording (E16), the real W-0 seam + its scratch-only hook (E2), the
boot-scoped log (E17), the wrapped import (`check-imports` 60/0), M1–M18 + M13b, and the acceptance
falsifiers. The delta is re-derived (§Delta): **+664/−50** source, **+439/−2** shipped tests (+411 probe
artefact), allowance **1348**.

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

## Recon (Rule 13 — codegraph @ c575a6c) and r4 additions

```
# recoverInflightRuns (src/recovery.ts)   — callers: 4 (recoverProduction :463, scanBoot, 2 tests)
# persistRunRecord (src/run-registry.ts)  — callers: 9 (session-manager :1357/:1724, state :333, 6 tests)
# markSpawnFailedBeforePrompt (session-manager) — callers: 2 (:2063 failPreStart, :1357 spawn)
# r3 added NO exported symbol: it replaced the bodies of `clearInflightRun` (run-registry) and
# `readAgentRecordFromDisk` (session-manager). `recordFlipPending` at c575a6c → 0; r3/r4 → 20 in `src/*.ts`.
# r4 adds NO exported symbol either: `settleLiveAgentRecord` and `terminalVerdictAfterWrite` are
# MODULE-PRIVATE; `flipAgentRecord` keeps its r3 signature and is now the BOOT replay only.
#   grep -rn 'settleLiveAgentRecord' src --include=*.ts  → definition :1325 + STEP B :2239
#   grep -rn 'flipAgentRecord' src --include=*.ts        → definition :1246 + boot-recovery :167 + tests
```

**Recon verification (each re-read at `c575a6c`, re-checked on the r4 tree).** V1 `persistRunRecord` retires
**then** appends (`:347` vs `:351`). V2 `clearInflightRun` is a bare `unlinkSync` that **swallows** the error
(`:261-269`) — r3 makes it report the desired end state. V3 `updateInflightRun` never resurrects (`:252-259`).
V4 candidates come **only** from the registry (`recovery.ts:329`). V5 a marker on a terminal record is
swallowed by `:355` before any verdict. V6 one terminal-writer identity shared with the foreground. V7
`updateAgentStatus` mutates memory **first**, persists, then emits (`:1186-1212`) — that order is *why* the
live pin is a memory write and not a disk read. V8 `persistAgent` **swallows** write errors (`:509-539`, E7).
V9 the agent map is module state (`:195`). V10 `BootScanSummary` additions are safe (`toMatchObject`). V11 the
never-started path already gates on a provably-dead owner (`:390-397`). V12 a failed marker write cannot leave
a half-marked entry (`writeAtomic` temp+rename; `.tmp` is never read). V13 the architecture rule does not see
names on a dynamic `import()` (`:131-137`). V14 `existsSync` returns false for `EACCES` on a parent directory,
not only for `ENOENT` — measured E14. V15 `claimTerminalNotice` wraps `const terminalClaims = new Set<string>()`
in `notify-completion.ts` — measured E16. **V16 (r4)** every background spawn mints a **fresh** id
(`const id = generateUUID()`, `session-manager.ts:1604`) — a retry inherits `dispatchId`/`attempt`, never the
id — so a **second** pre-start failure for one id is not reachable from the spawn path (see §The code).

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

**The #542 pin is a second, independent window (major A).** #542 fixed the *live* process's row: a pre-start
failure must not leave an agent this process still answers about (`get_agent_status`,
`get_subagent_result`) reading `running`. r3 traded that guarantee away for the boot's disk-only caution
because one function served both. r4 keeps both: the live writer *always* makes memory terminal; the boot
applier *never* trusts memory.

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
— **except** P5, the explicit pre-#546 fallback. **In the live process the row itself is terminal in every
one of these faults** (`settleLiveAgentRecord` writes memory before it reads the disk), which is the #542
half of the invariant.

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

### Two contracts, one disk verdict (major A)

| | LIVE — `settleLiveAgentRecord` (`markSpawnFailedBeforePrompt` STEP B) | BOOT — `flipAgentRecord` (`applyRecordFlip`) |
|---|---|---|
| **Assumption before the write** | **the memory map is this process's own record and must not lie.** `updateAgentStatus(id, status, error)` runs **first and unconditionally** — absent record, unreadable record, a persist `persistAgent` swallows: the row is terminal when the pre-start path returns (#542). | **a fresh process has no memory to trust.** It reads the **disk** before deciding: absent ⇒ `retired`; present-but-unreadable ⇒ warn + `false`; already terminal ⇒ `retired` with **no write** (replay is inert); `running` ⇒ `updateAgentStatus` (which loads the record into the map) iff the owner is provably dead. |
| **Retirement decision** | the shared post-write disk verdict: terminal ⇒ `repaired` (retire) · absent ⇒ `retired` (retire — nothing durable to repair) · **`running` or unreadable ⇒ `false` (KEEP the marker)**. | the same `terminalVerdictAfterWrite` after the write, so a swallowed persist reads `false` and the marker survives (E6/E7). |
| **What it may not do** | retire on a disk it cannot read (that is how r3 stranded a `running` record), or skip the memory write for any disk state. | write over a live owner, rewrite an already-terminal record, or trust the scanner's memory-first snapshot (V7). |

**A second pre-start failure for the same id.** Unreachable from the spawn path (V16: a fresh `generateUUID()`
per spawn; retries inherit `dispatchId`/`attempt`). At the helper level it is **not write-idempotent**: the
memory write runs again, so `completedAt` is re-stamped, `error` is replaced, and a **second**
`subagent:failed` is emitted; the disk verdict is unchanged (terminal), so the marker is retired again.
**Measured** (E21: `completedAt` 1795230570936 → 1795230570962, `failureEvents` 1 → 2). Stated, not fixed:
an idempotence short-circuit ("skip when the memory status is already terminal") would be a branch **no
production path reaches** — the r3 doc's "ONCE, idempotently" is therefore scoped to the **end state**, not
to the writes, on the live side.

### The contract block — goes in `persistRunRecord`'s doc and the helpers' doc, verbatim

> **MARKER BEFORE RETIREMENT.** The pre-start terminal path is `markRecordFlipPending` → terminal run entry
> (`deferRetire`) → record step (`settleLiveAgentRecord`) → **retire** (`clearInflightRun`). Retirement is
> last and conditional because `clearInflightRun` is an unlink (V2): a marker written after it has no home,
> and an entry retired before the flip leaves a `running` record no boot scan can source a candidate for.
> Every other `persistRunRecord` caller keeps retire-then-append — the deferral is opt-in by argument.
> **If the marker did not land, the deferral is NOT taken:** the pre-start path falls back to the pre-#546
> order and states that the residue is then the historical one.
>
> **THE WRITE VERIFIES THE DISK.** `persistAgent` swallows write errors (V8), so `updateAgentStatus`
> returning is not the write landing: both helpers read `<storage>/<id>.json` **after** writing and only a
> terminal persisted status is `repaired`. **Absence must be proven, not assumed:** only `ENOENT` from
> `statSync` is a confirmed absence; any other stat error is uncertain and is treated as unreadable (the
> marker is kept).
>
> **TWO CONTRACTS, ONE DISK VERDICT.** The **live** writer (`settleLiveAgentRecord`) writes **memory** first
> and unconditionally — the #542 pin: absent, unreadable, or a persist the store swallowed, the row in *this*
> process must read terminal. The **boot** replay (`flipAgentRecord`) never trusts memory: it reads the disk
> before deciding (absent ⇒ retire; unreadable ⇒ keep + `false`; terminal ⇒ retire with no write; `running` ⇒
> flip only for a provably dead owner). Both then take the **same** retirement verdict from the disk
> (`terminalVerdictAfterWrite`): terminal ⇒ settle · absent ⇒ settle · `running`/unreadable ⇒ **keep the
> marker**.
>
> **REPLAY IS INERT; HOLD, NEVER GUESS.** An already-terminal record is not rewritten — the marker is retired
> with no write (`flipRetired`). A marker whose record is still `running` is applied only when its owner is
> **provably dead** (V11). A record that is already terminal is exempt from the owner rule (retiring it
> mutates nothing); a **repair** (a write) requires a provably dead owner. **A marker whose applier or fresh
> reader is not wired is held**: no finalize, no interrupted mark, entry and marker untouched, and **no
> settlement counter moves** — a hold is not a settlement failure (all three flip counters zero, by design).
>
> **RETIREMENT IS VERIFIED.** `clearInflightRun` reports whether the desired end state is **proven**: an
> unlink that succeeds or returns `ENOENT` is `true`; any other unlink error is confirmed with a `statSync`
> and is `false` unless that stat proves `ENOENT`. A `false` is a failed settlement, counted and kept for
> the next boot, never reported as settled.

### The code — four touch points (r4)

**`src/run-registry.ts`** (+131/−12 cumulative, **unchanged from r3**):

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
**`src/session-manager.ts`** (+247/−28; the wrapped import is the `check-imports` fix; **+92/−22 of that is
the r4 split**):

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

/** BOOT/replay: disk-only, no memory assumption. */
export function flipAgentRecord(id, status, error?): AgentFlipOutcome {
  const before = readAgentRecordFromDisk(id);
  if (!before.exists) return "retired";                       // confirmed absence
  if (!before.record) { warn(); return false; }               // unreadable ⇒ keep the marker
  if (isTerminalAgentStatus(before.record.status)) return "retired";  // replay is inert
  let touched: BackgroundAgent | null = null;
  try { touched = updateAgentStatus(id, status, error); }     // loads the DISK record into the map
  catch (err) { warn(); } finally { if (touched) touched._sessionRef = undefined; }
  return terminalVerdictAfterWrite(id);
}

/** The DISK verdict both contracts end on. */
function terminalVerdictAfterWrite(id): AgentFlipOutcome {
  const after = readAgentRecordFromDisk(id);
  if (!after.exists) return "retired";                        // nothing durable to repair
  if (!after.record) { warn(); return false; }                // cannot tell ⇒ keep the marker
  return isTerminalAgentStatus(after.record.status) ? "repaired" : false;  // persist swallowed ⇒ keep
}

/** LIVE (#542 pin): MEMORY first, unconditionally; retirement from the disk. */
function settleLiveAgentRecord(id, status, error?): AgentFlipOutcome {
  try {
    if (!updateAgentStatus(id, status, error)) {              // in neither map nor store
      warn(); return false;                                   // nothing was pinned ⇒ keep the marker
    }
  } catch (err) { warn(); }                                   // map already mutated ⇒ memory is terminal
  return terminalVerdictAfterWrite(id);
}
```
`markSpawnFailedBeforePrompt` becomes STEP 0 → A → B → C → D with the fallback (STEP B is the r4 change):

```ts
  const marked = markRecordFlipPending(id, { status: 'failed', error: message, at: ... });
  if (!marked) safeLog(() => log.warn(`... marker not written for ${id} — using the pre-#546 order`, {}));
  try { finalizeRunEntry('failed', message, { deferRetire: marked }); } catch (err) { safeLog(...) }
  const landed = settleLiveAgentRecord(id, 'failed', message);   // r4: MEMORY always terminal
  try { transcript.completeTranscript(id, 'failed'); } catch (err) { safeLog(...) }
  agent._sessionRef = undefined;                                // outside every try — cannot throw, must always run
  if (marked && landed && !clearInflightRun(id))                // STEP D — skipped when unmarked
    safeLog(() => log.warn(`... record settled but the entry survived for ${id}`, {}));
```
The two blanket `clearInflightRun(id)` calls after the helper — `failPreStart` STEP 3 (`:2077`) and the
branch-refusal site (`:2221`) — are **deleted**: they would delete the marker that repairs this crash.
**`src/recovery.ts`** (+236/−7, **unchanged from r3**):

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
(`:355`, V5). The r3 hold is a full skip, including the one-dependency-wired case (r4 pins it):

```ts
if (entry.recordFlipPending) {
  if (!options.applyRecordFlip || !options.readFreshAgentRecord) {
    options.log?.debug("Recovery: held a record-flip marker (applier or fresh-record reader not wired)");
    continue;                 // no never-started finalizer, no mark, entry and marker untouched, 0 counters
  }
  ...                         // unreadable ⇒ flipFailures++ + continue; held ⇒ continue
}
```
**`src/boot-recovery.ts`** (+50/−3, **unchanged from r3**): the **existing** lazy import is made optional and
the applier is built inside it (one guarded block, no half-wiring):

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
If the import fails, both deps are absent and the marker branch **holds** (E15/E19). **No allow-list
change**: the reader-API rule only inspects names on static edges, and this edge is `import()` (V13).

### Sub-decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| **D1** | Field name, shape | `recordFlipPending?: { status, error?, at }`; `RecordFlipStatus = "failed" \| "completed"` (only `failed` written) | exactly what the flip writes, copied verbatim into `updateAgentStatus` |
| **D2** | Written in STEP 0, **cleared** by conditional STEP D; failed write falls back | `markSpawnFailedBeforePrompt`'s first statement; `deferRetire: marked` | anything after STEP A has no entry to write to (V1) |
| **D4** | "Landed" means **disk** | the post-write `readAgentRecordFromDisk` in `terminalVerdictAfterWrite` | V8/E7: a return-based "landed" retires over a `running` record |
| **D5** | Verdict ledger | `repaired`/`retired`/`failures`, counted from the **applier's outcome** | a race's second boot must ledger `retired`, not a second repair |
| **D6** | A marker beats `acceptedAt:null` | the marker branch is **before** the never-started classification | the marker names a terminal status for an already-written run entry |
| **D7** | Held ⇒ skip, **including a half-wired pair**; **a hold is not a settlement failure** | `continue` on `held`, `unreadable`, and `!applyRecordFlip \|\| !readFreshAgentRecord`; `flipRepaired`/`flipRetired`/`flipFailures` stay **0** | a finalizer or a mark over a marker writes state no applier can settle (E15); counting a hold as `flipFailures` would make a healthy registry-only boot look degraded (E20) |
| **D8** | Fail-closed on the applier | `false`/throw ⇒ `flipFailures++`, entry kept, scan continues | E6/H4d |
| **D10** | The two branch-refusal sites | unchanged except **deleting** the blanket `clearInflightRun` (`:2221`) | it would unlink the marker |
| **D11** | The applier's return is the ledger | `RecordFlipOutcome`, not `boolean \| void` | a truthful `retired` under the race is impossible from an earlier decision |
| **D12** | Unreadable is its own verdict | `"unreadable"` ⇒ `flipFailures++`, marker kept | "we could not tell" must not read as a clean boot (#304) |
| **D13** | `clearInflightRun` returns `boolean` **by error code** | `ENOENT` = success; any other error confirmed by `statSync`; uncertain ⇒ `false` | `existsSync` false conflates gone with untraversable (E14) |
| **D14** | Absence requires a **proof** | reader: `statSync` `ENOENT` only; any other stat error ⇒ `exists:true, record:null` | keeps the marker on an untraversable parent (H2e) |
| **D15** | The notice claim is **per process** | stated limit; duplicate notices possible | the claim `Set` is module-local (V15, E16) |
| **D16 (r4)** | Split the flip into **two functions** (not a `mode` flag) | `settleLiveAgentRecord` (private) + `flipAgentRecord` (exported, replay) + `terminalVerdictAfterWrite` (private, shared) | a `mode` parameter is one call site away from the r3 defect, and it makes every reader re-derive which semantics apply; two names state the contract at the call site. The shared tail is the DRY edge: the twin-line "read the disk after the write and classify" exists in both, so it is one function, not two |
| **D17 (r4)** | The live write is **unconditional** | `updateAgentStatus` before any disk read; idempotent **end state**, not idempotent **writes** | the #542 fault is exactly a process that skipped the write because the disk looked wrong (E18). A memory short-circuit would be dead code (V16: a fresh id per spawn); its consequence is stated (E21) |
| **D18 (r4)** | The live retirement is the **same disk tri-state** as the boot's | `terminalVerdictAfterWrite` on both sides | one rule for "may the marker die": terminal or provably absent. r3 retired on absent **before** writing; the live contract writes first, so absent *after* the write means the write did not land and nothing durable exists either way |

### Rejected options

| Option | Mechanism | Blast radius | Cost | Risk if wrong |
|---|---|---|---|---|
| **B — separate marker file** (`<registry>/<id>.pending.json`) | survives the unlink; the flip unlinks it | `run-registry` (the dir reader must skip it: `listInflightRuns` treats **every** `*.json` as an entry), `recovery`, `boot-recovery`, every test that counts registry files | ~+90 src, +30 tests | two files with no atomic relation: a crash leaves **both**, and an orphan `.pending.json` needs a sweep nobody wrote |
| **C — tombstones instead of unlink** | `clearInflightRun` writes `{state:"retired"}` | **every** registry reader + retention/prune + `.done` non-goals | +120 src, unknown churn | a permanent file per run; expiry needs a retention policy this unit does not own |
| **D — append-before-retire, no marker** | swap the order for this caller | `run-registry` only | ~+12 src | **measured false positive (E5)**: `marked=1`, a notice for an entry that says `failed`, record stays `running` |
| **E — do nothing** | leave the residue; document it | 0 | 0 | `get_subagent_result` reports `running` forever; the repair is a manual record edit |
| **F — shared cross-process claim** | a claim file or registry key per run id | `notify-completion` + a new store | ~+60 src, a new stateful file | out of scope: new retention/teardown surface for a duplicate notice (E16) |
| **G (r4, rejected) — one function with a `mode: 'live' \| 'replay'`** | one body, branch on the mode for the pre-write read and the memory write | `session-manager` only | ~+45/−10 (smaller than the split) | the r3 defect *was* a shared body with one implicit mode; a caller that passes the wrong literal is silent, and the boot's disk-only rule and the live's memory pin would live in one readable block that must be re-audited on every change (D16) |
| **A (chosen)** | marker in the entry, retirement last, live memory pin + disk-verified verdict, boot disk-only replay, error-code reads, hold on a missing/half-wired applier | `run-registry` (+131/−12), `recovery` (+236/−7), `session-manager` (+247/−28), `boot-recovery` (+50/−3) | **+664/−50 src, net +614** (293 code; 355 comment, 16 blank), tests ~+439 | if a boot runs concurrently with a live writer, the hold rule is the only prevention — measured (E4d); the two-boot window is the stated limit (E11/E16). If `persistAgent`'s swallow were fixed to throw, the read-back becomes redundant, not wrong |

### Blast radius — the registry readers, named

| Reader | Sees a marker? | Effect |
|---|---|---|
| `recovery.ts:329` (`listInflightRuns`) | yes | the new verdict, before the terminal-record drop |
| `boot-recovery.ts:252` (`maybeSendRecoveryNotice`) | indirectly | a repaired/retired entry is gone before the notice surface; a **held** entry has no `interruptedAt` ⇒ `collectInterruptedRuns` skips it |
| `recovery-surface.ts:231`, `session-manager.ts:718` | projected only when `interruptedAt` is present | a marker never becomes an "interrupted run" on any tool surface |
| `run-registry.test.ts:596` | `toMatchObject` | new summary fields are additive (V10) |
| the agent store | n/a | `readAgentRecordFromDisk` is a new **read** of one record; `agentRecordPath` replaces two inline path builds and adds F24 validation. **r4 adds one writer path**: the live helper's unconditional `updateAgentStatus`; it is the *existing* writer, called in the *existing* order (V7), with no new state |

## Tests — 34 measured cases (24 probe + 6 session-manager + 4 shipped hold)

The probe file (`zz-546-r3-probe.test.ts`, **411 lines / 24 cases**) is a *measurement artefact*: namespace
imports so the SAME file runs on base/r2; the shipped tests import directly and live in the suites named
below. **On the r2 tree: 2 failed / 22 passed** (H2e, H4f); **on r3 and on r4: 24/24**; on base every
unguarded case fails at an assertion or a missing-symbol `TypeError`, not at import.

| # | Case | Suite | Pins | Before (r3 unless marked) |
|---|---|---|---|---|
| **R1–R3** | marker round-trip + idempotent; a mistyped marker is **dropped**; the writer is total | probe | the writer + lenient read (M11) | `TypeError` (base) |
| **C5/R4** | `{deferRetire:true}` keeps the entry across a **throwing** append; without it the entry is retired first | probe | the W-0 order as an API contract (M3) | red (base) |
| **C1** | marker + `running` + dead owner ⇒ record `failed`+`completedAt`+`error`, entry retired, `flipRepaired===1` | probe | **the repair's positive end state** — C1 is *not* a mutant killer (measured survivors: M1, M2, M4, M5, M9, M13b — E22) | red (base) |
| **C2** | the second scan is inert (`completedAt` unchanged, counters 0) | probe | replay safety | red |
| **C3/C3b** | **live** and **unparsable** owners ⇒ nothing written, entry kept, `flipRepaired===0`, `marked===0`, no `interruptedAt` | probe | the hold rule (M7/M9) | red |
| **C4** | the applier's durable write failed ⇒ `flipFailures===1`, entry kept, record `running` | probe | fail-closed (D8) | red |
| **C6** | marker whose record **already landed** ⇒ retired, `completedAt` unchanged, `flipRetired===1` | probe | the drop-before-verdict ordering (M8) | red |
| **S2/P1** | STEP 0 + STEP A of the **real writers**, then the real boot ⇒ repaired, second boot inert | probe | the end-to-end repair | red |
| **H2a/H2b/H2c** | record chmod `000` / confirmed absent / corrupt ⇒ (failures 1, kept) / (retired) / (failures 1, kept) | probe | major 2 — the **reader** (M13b) | red |
| **H2d** | the **applier** refuses an unreadable record (`false`, no registry write) | probe | defence in depth (M13) | red |
| **H2e** | **agent DIR `000`** ⇒ `flipFailures===1`, marker kept, record `running`; restore ⇒ later boot repairs | probe | r3 fix 1 — uncertain ≠ absent (**M16**, re-built on r4: 1 failed/23) | r2: red; r3/r4: green |
| **H3** | stale memory `running` + disk `failed` ⇒ retired, `completedAt` unchanged, **0** events | probe | the pre-flip disk read (M15) | red |
| **H4a/H4b** | terminal + registry `0500` ⇒ failures 1, kept; landed flip + failed unlink ⇒ failures, not a repair | probe | verified retirement (M14) | red |
| **H4c/H4e** | a **failed flip** never retires; the production wiring never retires a flip that did not land | probe | STEP D / fail-closed (M10) | H4e green (guard) |
| **H4d** | the **production** wiring counts a failed unlink as a failure | probe | the real applier (M10/M14) | red |
| **H4f** | **registry DIR `000`** ⇒ `clearInflightRun === false`, entry still present after restore | probe | r3 fix 1 — the unlink (**M17**, re-built on r4: 1 failed/23) | r2: red; r3/r4: green |
| **H5** | same-process retry: `false` (`0400`), restore, second call ⇒ `'repaired'`, disk `failed` | probe | the disk pre-read (M15) | red |
| **S1** | after a synchronous `prompt()` throw: marker invoked **before** the terminal `pi.appendEntry`, record `failed`, registry empty | `session-manager` | THE ordering pin (M1/M2) | red |
| **H1** | registry dir `0500` in the pre-start window ⇒ marker `false`, terminal persist `{deferRetire:false}`, no marker | `session-manager` | the fallback (M12) | red |
| **S3** | record `0400` ⇒ flip `false`, STEP D skipped, marker kept; later boot repairs | `session-manager` | D4 + verified retirement (M5/M6/M15) | red |
| **R4-a** | `critique 546 foreground … > still flips memory on unreadable` — chmod `000` in the pre-start window ⇒ **memory `failed`**, disk unreadable ⇒ **marker KEPT** | `session-manager` | **r4 major A** — the #542 memory pin + the keep-on-unprovable retirement (**M19**) | r3: **failed** (`{running, marker}`); M19: failed; **base: 1 failed** (memory `failed` but registry `[]` — base has the pin, not the marker) |
| **R4-b** | `… > still flips memory on absent` — record removed ⇒ **memory `failed`**, the memory write re-creates it terminal ⇒ **marker retired** | `session-manager` | major A — absent-after-write ⇒ retire | r3: **failed** (`{running, registry:[]}`); M19: failed (`disk:false`); base: passes (`{failed, disk:true, registry:[]}`) |
| **R4-c** | `critique failed initial persist then permissions restored before preflight failure` ⇒ `{status:"failed", disk:true, registry:0}` | `session-manager` | major A — the exact r3 regression state | r3: **failed** `{running, disk:false, registry:0}`; M19: failed (same); base: passes |
| **N1** | **session-manager unavailable**, `acceptedAt:null` ⇒ entry+marker **byte-identical**, record `running`, no `interruptedAt`, no `marked`, no finalizer, no notice, no ledger | `boot-recovery-import-failure-546` | **r4 major B** — the hold, production-wired (**M18**) | r2: `registryFiles:[]`; r3: probe only |
| **N2** | the same for an **accepted** entry | same | major B (**M18**) | r2: `marked:1` + `interruptedAt`; r3: probe only |
| **D7a/D7b** | a **half-wired** applier (applier-only / reader-only), both acceptance states ⇒ no applier call, no fresh read, no finalizer, no mark, entry+marker byte-identical, **all three flip counters 0** | `boot-recovery-import-failure-546` | **r4 minor 6** — hold ≠ settlement failure (**M20**) | r3: rule existed, unpinned; M20: 2 failed |

`it.skipIf(process.platform === "win32")` on every `chmod` case; the pins at `session-manager.test.ts:3766`/
`:3800` stay **green unedited** — STEP D still calls `clearInflightRun`, and `settleLiveAgentRecord` preserves
the memory outcome. The shipped hold file **must not** statically import `session-manager` (a throwing
`vi.mock` factory re-throws during collection) — its header states that, and it imports only
`boot-recovery`/`recovery`/`run-registry`/`runtime`/`logging`.

## Delta (ADR 0028) — measured from the scratch tree (`base → r4`), not estimated

`allowance(surface) = 120 + 2 × max(Δsource, 0)`, net lines, `--no-renames`:

| Surface | + | − | net |
|---|---|---|---|
| `src/run-registry.ts` | 131 | 12 | +119 |
| `src/recovery.ts` | 236 | 7 | +229 |
| `src/session-manager.ts` | 247 | 28 | +219 |
| `src/boot-recovery.ts` | 50 | 3 | +47 |
| **src total** | **664** | **50** | **+614** → allowance 120 + 2×614 = **1348** |
| `src/__tests__/session-manager.test.ts` (S1/H1/S3 + R4-a/b/c) | 231 | 2 | +229 |
| `src/__tests__/boot-recovery-import-failure-546.test.ts` (N1/N2 + D7a/D7b) | 208 | 0 | +208 |
| **tests total (shipped)** | **439** | **2** | **+437** — within 1348 |
| `src/__tests__/zz-546-r3-probe.test.ts` (24 cases, **artefact**, not shipped) | 411 | 0 | +411 |
| **tests total incl. the artefact** | **850** | **2** | **+848** |

Stripped of comment-only lines the four-file diff is **664 added = 293 code + 355 comment + 16 blank**
(doc-heavy by house style; the contract block, the two-contract doc and the guard comments are required).
**r3 → r4 movement:** `session-manager.ts` **+92/−22** (the split + its doc), the shipped test file
**+94/−0** against r3's *shipped* shape (S1/H1/S3 = +137/−2 → +231/−2), and the new hold file **+208**. (On
the r3 *scratch* tree, which also carried the ad-hoc critique block, the same file moves **+91/−27**: that
unshipped block is replaced by the shipped R4-a/b/c cases.) The allowance moves from 1208 to **1348** because
the source delta moved; it is still `120 + 2×Δsource`.

## Mutants — 22 rows; M16–M20 were built and run on the **r4** tree

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
| **M16** | the **reader** reverts to `existsSync` (untraversable parent = absent) | **H2e** — rebuilt on r4: **1 failed / 23 passed** |
| **M17** | the **unlink** reverts to `!existsSync` in the catch | **H4f** — rebuilt on r4: **1 failed / 23 passed** |
| **M18** | the **no-applier** branch restored as the r2 `else` fall-through | **N1/N2** (`registryFiles:[]` on null; `marked:1` + `interruptedAt` on accepted) — **shipped**: 2 failed / 2, probe exit 5 |
| **M19 (r4)** | STEP B calls the **boot** helper (`flipAgentRecord`) — i.e. the r3 shape | **R4-a, R4-b, R4-c** (2 failed + 1 failed) — reproduces r3's `{running, …}` / `{running, disk:false, registry:0}` exactly; N1/N2 stay green (the boot contract is untouched) |
| **M20 (r4)** | the half-wired guard `\|\|` → `&&` (a one-dep scan falls through to the ordinary path) | **D7a/D7b** (2 failed) — the applier-only case reaches the missing reader, the reader-only case reaches the fresh reader |

M5/M6 are the pair that matters: **M5** is what a reviewer writes by hand, **M6** is the only thing that
makes M5 detectable. M10/M14/M16/M17 are the settlement-integrity quartet: a settlement that did not land
must neither retire nor read as settled. **M19 is the #542 regression itself** — the r3 shape as a mutation,
so the live-pin tests are provably about the split, not about incidental state. M1–M15/M13b remain as
measured on the r2/r3 trees (the r2 and r3 critics verified them); r4 re-ran the 24-case probe and the three
live-pin cases.

## Verification plan (conductor-ready, in order)

1. `git status --porcelain` → empty. Re-derive the anchors:
   `grep -n 'recordFlipPending\|markSpawnFailedBeforePrompt\|finalizeRunEntry\|clearInflightRun(id)\|persistRunRecord(pi, entry)\|settleLiveAgentRecord' src/{run-registry,session-manager,recovery,boot-recovery}.ts`
   and paste the counts into the PR body (§Recon was taken at `c575a6c`).
2. Write the tests first. `npx vitest run src/__tests__/{run-registry,recovery,session-manager}.test.ts` →
   the red rows of §Tests, messages pasted (probe evidence: r2 tree **2/24 red**, r3/r4 **24/24**). The three
   live-pin cases are red on the r3 tree (`critique 546 foreground` 2 failed, `critique failed initial
   persist` 1 failed) and green on r4.
3. Implement in the §Execution sketch order — `run-registry` → `session-manager` (the **split** before STEP B)
   → `recovery` → `boot-recovery`, `npx tsc --noEmit` clean at each hop (the tree typechecks without tests).
4. Suites green; `npx tsc --noEmit` **0**; `node scripts/check-imports.mjs` **60 files, 0 violations**
   (the `./run-registry` import **must be wrapped**); the architecture suite **11/11** (allow-list unchanged);
   the new hold file **4 passed**.
5. M1–M20 + M13b one at a time in a scratch copy (never the repo); record the killed case names (§Mutants is
   the expected table). M16/M17/M19/M20 are the r4-tree builds; M19's kill is the **three** live-pin cases,
   M20's the **two** half-wired cases.
6. **Crash probes against the patched tree** (`phase1.cjs` writes the real records then `SIGKILL`s;
   `boot.cjs` runs `createBootRecovery().performBootRecovery()` + `maybeSendRecoveryNotice` in a fresh
   process; `read.cjs` is a third process). `boot.cjs` parses `message` and exits **3** on any of:
   `EXPECT_TRIPLE` mismatch or a **missing** settlement line, `EXPECT_NO_SETTLEMENT` violation,
   `EXPECT_COMPLETEDAT` violation, **`EXPECT_COMMITTED`** mismatch (E2). An `EXPECT_COMMITTED` that parses to
   zero statuses is a **usage error (exit 2)**, and a missing stream is reported as `stream:"missing"`, not
   as "present with no lines" (E2). Record P0–P5, the two base controls (W-0, W-1), and E5 (`accepted`,
   explicitly — the null-accepted entry is finalized, not marked).
7. **The W-0 seam**: run `base` **without** the scratch hook (stream `["running","failed"]` → exit 3) and
   **with** it (stream `["running"]` → exit 0). The hook is six lines in the *scratch* tree's
   `persistRunRecord`, between the retirement branch and `pi.appendEntry`; it is **not** in the deliverable
   (an env-gated kill switch on the terminal path is a fault-injection/DoS surface and a second, artificial
   crash path — the real W-0 is an external `SIGKILL` at that same syscall boundary).
8. **Harness scoping**: settle a P2 residue, then run a **no-op second boot** with `EXPECT_TRIPLE=0,1,0` →
   exit **3**; then the same state with (a) the log **rotated** (new inode) and (b) the log **truncated** →
   exit **3** in both, with `log-identity-changed` / `log-shrank`; the r3 whole-log parser on the same state
   → exit **0** (E17).
9. **The two-process probes**: sequential (2nd boot 0/0/0) and the seam barrier (both repairs, 2 events,
   2–5 ms drift) — a **stated limit**, not a claim; plus the two-process claim probe (E16).
10. **The hold**: `node boot-importfail.cjs <tree>-noimport <state> null|accepted` → `HOLD-OK` exit 0; the
    same probe against the **normal** tree → exit 2 (`FAULT-NOT-REPRODUCED`, so a green run cannot be
    vacuous); against M18 → exit 5. Then `vitest run src/__tests__/boot-recovery-import-failure-546.test.ts`
    → 4 passed, and the same file on M18 (2 failed) and M20 (2 failed).
11. **GATES — full suite and the flow**: the four suites green with no new failing name against a
    pre-change run (record both name lists); then commit, and run
    `node scripts/check-test-budget.mjs --flow --base dev --head <final sha>` — record base/head sha, exit
    and the full line (a non-zero exit **with** the declaration is expected).

**Design assumptions (stateful checklist).** *(1) State:* one new FIELD on the existing per-run registry
file (dir `0700`, `0600`); no new path, file class, or lock. r4 adds **no state**: the live helper's
`updateAgentStatus` is the existing writer on the existing record, and the split adds only functions.
*(2) Teardown:* the retirement **is** the teardown and it is conditional, verified, and last; a kill at any
point leaves the marker, whose consumer is the next boot. The live memory write is not teardown: it is the
same record write #542 already performed, moved back in front of the disk read. *(3) Concurrency:* two
processes can read the same registry; the write is gated on `ownerProvablyDead`, and the pre-flip disk read
makes a later boot inert. Two boots that pass the check together are not serialized — E11; the two-process
**notice** claim is not shared — E16; both are stated limits, with claim files named as the out-of-scope
remedy. *(4) Missing/partial/unreadable:* invalid marker ⇒ dropped (fail-open to the pre-#546 residue);
**confirmed absent (`ENOENT`) ⇒ retire**; **untraversable parent/other stat error ⇒ unreadable** (keep +
`flipFailures`); failed flip or failed unlink ⇒ keep; marker-write `false` ⇒ pre-#546 order; **no applier, or
half-wired ⇒ hold with zero counters**; a live fault ⇒ **memory terminal in every one of these**.
*(5) Evidence:* E1–E22, Δ, 24/24 on r3/r4 (2/24 red on r2), 22 mutants, the shipped hold file 4 passed.

## Risks, residuals, out of scope

| Risk | Severity | Mitigation / statement |
|---|---|---|
| The `#542` contract comment claims STEP A "retires"; this unit moves it to STEP D | **medium** (review friction) | the contract block above is the replacement; W-1 becomes a **repaired** state (P1) |
| The live helper is **not write-idempotent** (`updateAgentStatus` re-stamps `completedAt`, replaces `error`, re-emits) | low, **unreachable** | every spawn mints a fresh id (V16), so a second pre-start failure for one id cannot arise; the end state is idempotent (terminal stays terminal, the disk verdict is unchanged) and an idempotence short-circuit would be dead code (E21) |
| Deleting the two blanket `clearInflightRun` calls (`:2077`, `:2221`) removes #542's "belt" | low | the belt was for a retired entry; S3 and `:3766` pin that the helper owns retirement |
| A boot-time `subagent:failed` could wake the completion push at startup | low | `deliverCompletionAlert` is `try/catch`-wrapped; it fires over a run entry that already exists |
| **Two boots may each deliver a terminal notice** (the claim is module-local) | low, **stated** | duplicate notice possible; a shared claim is the out-of-scope remedy (E16) |
| A **held** marker with an unverifiable owner is permanent | low, stated | no `/proc` ⇒ the platform guard skips the scan (`recovery.ts:463`); the record stays `running` exactly as today |
| An **uncertain** stat (`000` parent) keeps the marker until a later boot can look | low, stated | fail-closed by design; E14 shows the later boot repairs. A permanently unreadable store leaves the marker for the operator |
| Two boots that pass the pre-flip check together both rewrite | low, stated limit | `completedAt` drift ≤ the read/write overlap and one duplicate event + notice (E11/E16); serialization = claim file, out of scope |
| A **held** (or half-wired) marker looks like a silent no-op in the ledger | low, stated | §D7: all three flip counters are **zero by design** — a hold is neither a settlement nor a failed settlement; the debug line names it, and the shipped D7 cases pin the zeros (E20) |

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
  automatic retry logic. **The live helper never retries**: it writes once per pre-start failure.
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
8. **The public surface is unchanged from r3.** `Structural closure: n/a — no moved/deleted exports`; the
   added exports are the r3 list (`RecordFlipPending`, `RecordFlipStatus`, `markRecordFlipPending`,
   `AgentFlipOutcome`, `flipAgentRecord`, `readAgentRecordFromDisk`, `RecordFlipOutcome`, `FreshAgentRecord`,
   `RecordFlipVerdict`) plus two added optional fields. **r4 adds no export**: `settleLiveAgentRecord` and
   `terminalVerdictAfterWrite` are module-private, and `flipAgentRecord` keeps its r3 signature
   `(id, status, error?) => AgentFlipOutcome` with **one** caller (`boot-recovery.ts:167`) — its contract
   narrows to the boot replay. `clearInflightRun`/`flipAgentRecord` signatures change **widening** vs base
   (void→boolean; boolean→union) with no caller depending on the old shape. Nothing removed.
9. A marker whose **applier or fresh reader is unavailable** is **held**: no never-started finalizer, no
   `marked`, no `interruptedAt`, entry and marker byte-identical (N1/N2, E15/E19). *Falsifier:* an import
   failure removes or marks a marker.
10. A **half-wired** pair (applier without reader, reader without applier) is held the same way, in both
    acceptance states, with **all three flip counters zero** (D7a/D7b, E20). *Falsifier:* a hold increments
    any flip counter, or a half-wired scan reaches the applier/fresh reader (M20).
11. The happy path leaves **nothing**: registry empty, record `failed`, run entry `failed`, marker gone (S1).
    No other `persistRunRecord` caller changes semantics (C5/R4).
12. **The live pre-start writer pins memory in every fault** (major A): after an **absent** record, an
    **unreadable** record, and a **swallowed initial persist**, `getAgent(id).status === "failed"` in the
    same process, and the retirement follows the disk tri-state — absent/terminal ⇒ the marker is gone;
    `running`/unreadable ⇒ the marker is kept (R4-a/b/c, E18). *Falsifier:* `running` in memory after either
    fault, or `{running, disk:false, registry:0}` after the initial-persist fault (M19 reproduces exactly
    that).
13. The **import-failure hold is shipped**, not probed: `boot-recovery-import-failure-546.test.ts` passes
    (4/4), fails under **M18** (N1/N2) and under **M20** (D7a/D7b), and the scratch probe exits 0/5/2 for
    hold/violation/no-fault (E19). *Falsifier:* M18 or M20 passes those tests.
14. `npx tsc --noEmit` clean; the four suites + the **architecture suite** (11/11) green; `check-imports`
    **60/0**; the new hold suite **4 passed**; no new failing name in the worktree suite; the flow verdict
    recorded from the committed head.
15. **The W-0 stream is `["running"]`** with the instrumented seam, and `["running","failed"]` without it
    (the probe must fail the `EXPECT_COMMITTED` gate) — E2. **The harness is scoped:** a no-op second boot
    cannot satisfy an `EXPECT_TRIPLE` from an earlier boot (E17), and an `EXPECT_COMMITTED` that parses to
    zero statuses is a usage error, not an empty stream (E2).

## Evidence

Probes ran in `~/.cache/brl-subagent/scratch/spec-546-r4/` (`base` = `c575a6c` src; `r3tree` = the r3 tree;
`r4tree` = this design, `tsc --noEmit` exit 0). Rows marked **(r4)** were re-run on the r4 tree in this
revision; the others are r3 measurements whose code path r4 does not touch (`run-registry.ts`,
`recovery.ts`, `boot-recovery.ts` are byte-identical to r3). Every crash case: real `SIGKILL`, then a fresh
process running the production boot, then a third process reading only disk. `boot.cjs` parses `message`,
scopes to bytes and **identity** appended by **this** boot, and exits **3** on an `EXPECT_TRIPLE` mismatch (or
missing line), `EXPECT_NO_SETTLEMENT`, `EXPECT_COMPLETEDAT`, or `EXPECT_COMMITTED` mismatch; exit **2** on a
zero-status `EXPECT_COMMITTED`.

| ID | Claim | Probe | Observed |
|---|---|---|---|
| **E1/E2** | base W-1/W-0 residues; the committed-stream gate | `run.sh base … w1`; `EXPECT_COMMITTED=running run.sh base … w0 null "" "" 1`; **(r4)** `e2.sh` | W-1 `["running","failed"]`; **W-0 without the seam hook `["running","failed"]` → exit 3; with it `["running"]` → exit 0**; both `REGISTRY=[]`, `RESTART=running`. **(r4)** `EXPECT_COMMITTED=`/`,` → `{"expected":[],"reason":"empty-expectation"}` + exit 2; a **removed** stream → `{"actual":[],"stream":"missing","reason":"stream-missing"}` + exit 3; present-but-empty → `{"stream":"present","reason":"mismatch"}` + exit 3; unset → exit 0 |
| **E4a** | P0 repaired | `run.sh r4tree … p0 1,0,0 set` | `TRIPLE {1,0,0}` `ok:true`; `COMPLETEDAT set`; `RESTART=failed`, `REGISTRY=[]` (r3 measurement; the r4 tree's crash probes were spot-checked with `e17.sh`, whose seed boot repairs a P2 residue and prints the same `{0,1,0}`) |
| **E4b** | P1 repaired | `run.sh … p1 1,0,0 set` | same triple; `COMPLETEDAT set`; `COMMITTED_RUNS=[running,failed]` |
| **E4c** | P2 retired only | `run.sh … p2 0,1,0 unchanged`; **(r4)** `e17.sh` seed | `TRIPLE {0,1,0}`; `COMPLETEDAT unchanged`; `REGISTRY=[]` |
| **E4d** | live owner held | `phase1 p0-live` (+ a live pid) then `boot.cjs` | `DISK=running`, `COMPLETEDAT=null`, entry+marker kept, `NOTICES=0`, `SCAN_LINES=[]` |
| **E5** | option D false offer, **asserted absent ledger** | `run.sh base … d1 accepted "" "" 1` | `NO_SETTLEMENT ok`, `marked:1`, `NOTICES=1`, `RESTART=running` |
| **E6/E7** | fail-closed; `persistAgent` swallows | `bootOnce(() => false)` (C4); chmod `0400` + flip | `flipFailures:1`, entry kept, `DISK=running`; without read-back `LANDED=true DISK=running`, with it `false` |
| **E8** | the suites and the probe, **(r4)** | `vitest` on r4tree: the probe; `run-registry`+`recovery`+`session-manager`+`boot-recovery-factory`; `architecture-rules`; the hold file; `check-imports`; `tsc` | probe **24/24**; four suites **243 passed**; arch **11/11**; hold file **4 passed**; imports **60 files, 0 violations**; tsc **0**. r2 tree **2 failed / 22 passed** (H2e/H4f, r3-measured) |
| **E9/E10** | unreadable vs absent vs corrupt; the pre-flip disk read | H2a–H2d; H3 | `000` ⇒ failures 1 + kept; absent ⇒ retired; corrupt ⇒ failures 1; applier ⇒ `false`; stale memory + disk `failed` ⇒ `retired`, `completedAt` unchanged, 0 events |
| **E11** | the race — the narrowed guarantee | `race-run.sh` seq / barrier / seam | seq: 2nd boot `0/0/0`, 1 event; barrier: 2nd **retired 1**, 1 event; seam: **2 repairs, 2 events**, stamps 5 ms apart |
| **E12** | the retirement is verified | H4a/H4b/H4c/H4d/H4f, S3 | `0500` ⇒ failures 1, kept, later boot retires; failed flip ⇒ never retired |
| **E13** | import failure / static import / import wrap | `boot-importfail.cjs`; `mut-static`; `check-imports` | failure: entry+marker kept; static: arch **10/1**; imports **60/0** on r3/r4 (r2 tree: 1 violation) |
| **E14** | `existsSync` conflates an untraversable parent with absence | `dirprobe.cjs before/optFinal agent-dir-000`, `… registry-dir-000`; **(r4)** M16/M17 rebuilt on the r4 tree | before: `retired=1, failures=0`, entry gone, record `running`; after: `failures=1`, marker kept, second boot `repaired=1`, record `failed`. Unlink before **true**, after **false**. **(r4)** M16 → H2e alone (1 failed/23); M17 → H4f alone (1 failed/23) |
| **E15** | the missing-applier hold | `phase1 p1 null/accepted` + `boot-importfail.cjs`; **(r4)** the same probe with assertions | before: null ⇒ `registryFiles:[]`; accepted ⇒ `marked:1` + `registryInterruptedAt`. after: `HOLD-OK` exit **0** both states, entry+record bytes identical, `record:running`, `interruptedAt:null`, no ledger line |
| **E16** | the notice claim is module-local | `twoclaim.cjs` × 2 processes, same id | `{"first":true,"secondInProcess":false}` twice — two processes win the same claim (r3 measurement; the claim code is unchanged by r4) |
| **E17 (r4)** | the harness log scoping — positive, **rotation**, **truncation** | `e17.sh` | positive current-boot line → `TRIPLE {0,1,0}` `ok:true`, **exit 0**; rotation → `LOG_SCOPE {"ok":false,"reason":"log-identity-changed","offset":182}` + exit **3**; truncation → `log-shrank` (offset 1972) + exit **3**; the r3 whole-log parser (`boot-r3.cjs`) on the same state → **exit 0** |
| **E18 (r4)** | **major A** — the live writer's memory pin and the disk tri-state | `vitest -t 'critique 546 foreground'` and `-t 'critique failed initial persist'` on `r3tree`, `mut-M19` and `r4tree` | **r3**: `unreadable {"status":"running","registry":[marker]}`, `absent {"status":"running","registry":[]}`, `INITIAL_WRITE {"status":"running","disk":false,"registry":0}` — 2 failed + 1 failed. **M19** (STEP B = the boot helper): identical states — 2 failed + 1 failed. **r4**: `unreadable {"status":"failed","disk":true,"registry":[marker]}`, `absent {"status":"failed","disk":true,"registry":[]}`, `INITIAL_WRITE {"status":"failed","disk":true,"registry":0}` — 2 passed + 1 passed. **base**: memory `failed` in both, `registry:[]` (no marker) ⇒ the unreadable case fails on the marker only, absent/persist pass |
| **E19 (r4)** | **major B** — the hold, shipped and asserted | `vitest run src/__tests__/boot-recovery-import-failure-546.test.ts` on r4tree / M18 / M20; `boot-importfail.cjs` on `<tree>-noimport` | r4tree **4 passed** (N1, N2, D7a, D7b); **M18 2 failed / 2** (N1: `ENOENT … registry/<id>.json`; N2: bytes differ, `+ "interruptedAt"`); **M20 2 failed / 4** (the two D7 cases). Probe: `HOLD-OK` exit **0** on r4-noimport and r3-noimport in both states; `HOLD-VIOLATED` exit **5** on M18-noimport (null: `appended:1`, never-started finalizer; accepted: `interruptedAt` + `marked` line); exit **2** on a normal tree (`FAULT-NOT-REPRODUCED`) |
| **E20 (r4)** | **minor 6** — a hold is not a settlement failure; the half-wired shapes | `halfdep.cjs` × 4 (applier-only/reader-only × null/accepted) + the shipped D7 cases + M20 | probe: `{"unchanged":true,"marks":0,"final":0,"reads":0,"applies":0,"flipRepaired":0,"flipRetired":0,"flipFailures":0,"marked":0,"neverStarted":0}` 4/4, exit **0**; shipped 2 passed; **M20** 2 failed (`readFreshAgentRecord is not a function` / the reader was reached) |
| **E21 (r4)** | a **second** pre-start failure for the same id | `second-failure.cjs` (the live helper's memory step, twice, 25 ms apart) | `before {running, completedAt:null, events:0}` → `first {failed, 1795230570936, error:"first…", events:1}` → `second {failed, 1795230570962, error:"second…", events:2}` — re-stamped, error replaced, second event; the disk verdict is unchanged; **unreachable from the spawn path** (fresh id per spawn, V16) |
| **E22 (r4)** | **minor 4** — the C1 attribution | `vitest -t 'C1:'` on `mut-M1`, `mut-M2`, `mut-M4`, `mut-M5`, `mut-M9`, `mut-M13b` | `1 passed / 23 skipped` on **every** one — C1 does not kill M1/M2/M4; their measured killers are S1/H1/S3, S1/H1 and S3 |
| **Δ/T** | the delta + typecheck **(r4)** | `git diff --no-index --numstat --no-renames base/src r4tree/src`; `tsc --noEmit` | +131/−12, +236/−7, +247/−28, +50/−3 ⇒ **+664/−50 net +614** (293 code / 355 comment / 16 blank); tsc **0**; shipped tests **+439/−2** (+411 artefact) |

## Not verified

- **The worktree suite and the flow verdict** — gate 11, not this investigation.
- **A second pre-start failure through the real spawn path** — unreachable (V16) and measured at the helper
  level only (E21); if ids are ever reused, the stated re-stamp/second-event behaviour is the one to revisit.
- **Automatic retry scheduling** — H5 proves a retry *attempts* the write; repair is deferred to the next
  boot.
- **The production drift window** — the seam probe bounds the overlap, it does not measure production (E11).
- **Windows** — `chmod` cases skipped; the read-back and error-code paths are platform-neutral.

## Open questions (answered for r4)

1. **Which concurrency guarantee is required for simultaneous boot scans, and who owns its serialization?**
   **Ordering, not mutual exclusion.** A later boot is inert (E4c/E10/E11-seq); two boots that pass the
   pre-flip check together may both write (E11-seam) — drift ≤ the read/write overlap, one duplicate event
   **and notice** (the claim is per process, E16). Serialization needs a per-run claim (`O_EXCL` claim file
   or atomic-rename lease) owned by `run-registry`; a shared notice claim is a second, separate piece of
   state. Both are **out of scope**, named as the remedy if ever required.
2. **Should a confirmed missing agent record retire a marker?** **Yes** — absence means nothing durable can
   go stale, so the marker's only purpose (a later repair) is vacuous (H2b). **Present-but-unreadable and
   unprovable (a non-`ENOENT` stat error) are not absence**: we know nothing, so the marker is kept and the
   settlement is counted a failure (H2a/H2c/H2d, H2e, E14). **On the live side the same rule applies to the
   post-write disk** (D18): the memory write re-creates an absent record, so "absent after the write" means
   the write did not land and nothing durable exists (E18).
3. **Does the live path need a write-idempotence short-circuit?** **No.** A second pre-start failure for one
   id is unreachable (fresh id per spawn, V16); the behaviour if it happened is stated (E21); a short-circuit
   would be a branch with no production caller, and the mandate's live contract is "always make memory
   terminal".

## Execution sketch for the implementer (ordered)

`run-registry` (field/writer/option; **`clearInflightRun` boolean by error code**) → `session-manager`
(`agentRecordPath`, **`readAgentRecordFromDisk` via `statSync` error codes**, `loadAgent` delegates, wrap the
`./run-registry` import, **the split: `terminalVerdictAfterWrite` → `flipAgentRecord` (boot, disk-only) →
`settleLiveAgentRecord` (live, memory first)**, STEP 0–D with **STEP B = the live helper** and the fallback,
delete the two blanket retires) → `recovery` (`RecordFlipOutcome`/`FreshAgentRecord`/`recordFlipDecision`,
the `unreadable` verdict, the **no-applier and half-wired `continue`**, `ownerProvablyDead`) → `boot-recovery`
(optional import, guarded applier + fresh reader) → tests (S1/H1/S3 **+ R4-a/b/c with the critique names** in
`session-manager`; the 24 probe cases ported into `run-registry`/`recovery`, including **H2e/H4f**; the hold
file with **N1/N2 + D7a/D7b**) → tsc + the four suites + the architecture suite + `check-imports` → 22
mutants (M16/M17 single-case, M19 the three live-pin cases, M20 the two half-wired cases, M18 through the
import-fail shape) → the crash probes (P0–P5, W-0 with the **scratch-only** seam hook, W-1, E5) → the
harness-scoping re-run (positive/rotation/truncation + the `EXPECT_COMMITTED` usage/missing distinction) →
the two race probes + the two-process claim → the worktree gates. Every step's expected observable is a row
above; a disagreement with a row is first evidence the **spec** is wrong (Rule 20).

# #546 — a crash between the terminal writes leaves a `running` agent record boot cannot repair — spec **r1**

**Issue:** #546 (harden) · priority **low** (a process kill inside a sub-millisecond window; state
consistency, not a lost run) · **C1** · worktree **y**.
**Spec r1:** 2026-11-21, against the cockpit `dev @ c575a6c` (`git status --porcelain` → **0** before and
after; every probe ran in `~/.cache/brl-subagent/scratch/spec-546/`, the repository was never written
except this file).
**Status:** decision-ready, **one measurement the plan did not anticipate**: `persistAgent` swallows write
errors, so "the flip returned" is not "the flip landed" (§Sub-decision **D4**, **E7**); the flip verifies
the disk because of it.

---

## Recon

```
## Recon (Rule 13 — codegraph @ c575a6c)
- target: `recoverInflightRuns` (file: src/recovery.ts)
- callers(recoverInflightRuns):
  - 4 caller(s)
  - src/__tests__/run-registry.test.ts:1 (run-registry.test.ts)
  - src/__tests__/session-manager.test.ts:3344 (scanBoot)
  - src/recovery.ts:463 (recoverProduction)
  - src/__tests__/session-manager.test.ts:1 (session-manager.test.ts)
- impact(recoverInflightRuns, depth 2):
  - 8 affected symbols across 5 files
  - files: src/recovery.ts, src/__tests__/run-registry.test.ts, src/__tests__/session-manager.test.ts, src/__tests__/recovery.test.ts, src/boot-recovery.ts
- affected(src/recovery.ts):
  - 80 test file(s)
  - src/__tests__/boot-recovery-factory.test.ts, kill-escalation, mode-runners-boundary, notify-completion, recovery-boot-notice, recovery-retry-after-boot, recovery-surface, recovery-visibility-bridge, recovery, run-registry, runner …
- grep delta: 17 raw hits for `recoverInflightRuns` (incl. comments/strings)

## Recon (Rule 13 — codegraph @ c575a6c)
- target: `persistRunRecord` (file: src/run-registry.ts)
- callers(persistRunRecord): 9 — src/session-manager.ts:1357 (spawnBackgroundSession), :1724 (finalizeRunEntry), src/state.ts:333 (persistRun), plus tests (recovery-surface, run-registry, session-manager:3344 scanBoot)
- impact: 86 affected symbols across 59 files (incl. state.ts, background-session-persistence, headstate-git tests)
- affected(src/run-registry.ts): 83 test files
- grep delta: 27 raw hits for `persistRunRecord` (incl. comments/strings)

## Recon (Rule 13 — codegraph @ c575a6c)
- target: `markSpawnFailedBeforePrompt` (file: src/session-manager.ts)
- callers: 2 — src/session-manager.ts:2063 (failPreStart), :1357 (spawnBackgroundSession)
- impact: 18 affected symbols across 9 files (session-manager, background-session-persistence, headstate-git, engineering-bar, branch-headstate-refusal, empty-tools-background-442 …)
- affected(src/session-manager.ts): 83 test files
- grep delta: 21 raw hits for `markSpawnFailedBeforePrompt` (incl. comments/strings)
```

## Recon verification — each load-bearing fact re-read at `c575a6c`

| # | Claim | Verdict | Anchor / command |
|---|---|---|---|
| **V1** | `persistRunRecord` retires **then** appends (W-0); `clearInflightRun` is a bare `fs.unlinkSync` (no tombstone); `updateInflightRun` never resurrects | **All true** — `:347` vs `:351`; `:261-269`; `:252-259` | `sed -n 345,352p src/run-registry.ts` |
| **V4** | recovery sources candidates **only** from the registry | **True** — `for (const entry of listInflightRuns())` at `:329`; the module header says it explicitly ("NOT from the current session's entries") | `:308-320`, `:329` |
| **V5** | a marker on a terminal record is **swallowed** by the scan | **True** — `if (agent && agent.status !== "running") continue;` at `:355` runs before any verdict. Measured on base: the entry is never retired (**C6** red `expected [ Array(1) ] to deeply equal []`) | `:355` |
| **V6** | `persistRunRecord` has **one** terminal-writer identity shared with the foreground | **True** — `state.ts` `persistRun` delegates; 9 callers, 2 of them production | recon block 2 |
| **V7** | `updateAgentStatus` mutates memory, persists, emits | **True** — status/`completedAt`/`error` set, `agents.set`, `persistAgent`, then `eventBus.emit` | `:1126-1155` |
| **V8** | `persistAgent` **swallows** write errors | **True and load-bearing** — `writeFileSync` in a `try` whose `catch` only logs (`log.error`). So a flip cannot detect its own failed write. Measured **E7** | `:509-539` |
| **V9** | the agent map is module state, never reset | **True** — `const agents = new Map(...)` at `:195`; the probe file needs one uuid per test (measured: a shared id made a later case read the earlier case's cached record) | `:195`, **E8** |
| **V10** | `BootScanSummary` additions are safe | **True** — the only shape assertion is `toMatchObject` | `run-registry.test.ts:596` |
| **V11** | `recoverInflightRuns`'s never-started path already gates on a provably-dead owner, and the same predicate is needed here | **True** — inline `ownerDead` computation; #546 extracts it (`ownerProvablyDead`) instead of copying it | `:390-397` |

**Grep coverage.** `grep -rn 'listInflightRuns()' src/*.ts` → 5 hits, all read paths named in §Blast radius
(`recovery.ts:329`, `boot-recovery.ts:252`, `recovery-surface.ts:231`, `session-manager.ts:718`,
`run-registry.ts:272` itself). `grep -n 'recordFlipPending' src/` at `c575a6c` → **0 hits** (the field does
not exist yet; it is new in this unit).

---

## Context — two windows, measured end to end with the production wiring

The #542 fix (merged) swapped the pre-start order to **run entry → record flip → transcript**
(`session-manager.ts:2013`, `finalizeRunEntry` → `persistRunRecord` → append). It removed the unfinalized
run entry and the listener-reentrancy hole, and left two residues that **no boot scan repairs**. Both are
reproduced here with a real `SIGKILL` from inside the writer and the **production** boot scan
(`createBootRecovery().performBootRecovery()` → `recoverProduction` → the real deps), then observed in a
**third** process (**E1–E3**, harness: `phase1.cjs` / `boot.cjs` / `read.cjs`, §Evidence).

**W-0 — inside STEP A, after `clearInflightRun` and before `appendEntry`** (the issue's correction
comment; re-measured, **E2**):

| | shipped order (kill inside `persistRunRecord`) |
|---|---|
| agent record on disk | `running` (no `completedAt`, no `error`) |
| run entry | `running` — the terminal write was never attempted |
| registry entry | **retired** (0 files) |
| session dir | **pruned** |
| boot scan (`scanned/skipped/marked`) | `0/0/0` — no boot log line, no boot append |
| restart-observable `getAgent(id).status` | `running` |

**W-1 — after the run entry commits, before the record flip** (the issue's table row; **E1**):

| | shipped order |
|---|---|
| agent record on disk | `running` (**stale**) |
| run entry | `failed` (terminal) |
| registry entry | retired (0 files) |
| session dir | pruned |
| boot scan | `0/0/0` — no boot log line, no boot append |
| restart-observable `getAgent(id).status` | `running` |

Both rows share one cause: **the signal a fresh process can read (the registry entry) is deleted before the
write that repairs the record happens.** Candidates come from the registry (`V4`), so once the entry is
unlinked there is none, and a `running` record with no candidate is a zombie that only
`get_subagent_result` (`getAgent` → `loadAgent`) ever reports.

**The "obvious minimal fix" is measured too (option D, E5).** Appending before retiring does not repair
anything; it produces a **false retry offer** — boot marks the entry interrupted (`marked=1`), delivers a
recovery notice for a dispatch whose run entry already says `failed`, and the record **stays `running`**. A
registry-only scan cannot read the dead process's run entry, so it cannot tell "interrupted" from
"terminated but unflipped".

---

## Decision — Option A: a marker written **before** retirement, retirement deferred to after the flip

The one durable signal a fresh process can read must carry the **intent**, not just the liveness. A field
on the registry entry does that, and it dies with the entry — which is exactly why the retirement moves to
**last**.

### Marker lifecycle — written → survives → cleared, with every crash point

| # | Point | What is on disk | Next boot |
|---|---|---|---|
| **P0** | after `markRecordFlipPending`, before the run-entry append | entry+marker, record `running`, run entry `running` | **repaired**: record `failed` (+`completedAt`+`error`), entry retired, `flipRepaired=1` (**E4a**) |
| **P1** | after the commit, before the flip | entry+marker, record `running`, run entry **`failed`** | **repaired**, same as P0 (**E4b**) |
| **P2** | after the flip, before the retire | entry+marker, record `failed` | **retired only**: no rewrite, `completedAt` unchanged, no event re-emitted, `flipRetired=1` (**E4c**) |
| **P3** | the flip's own write failed (`persistAgent` swallows, **V8**) | entry+marker, record `running` **on disk** | repair **deferred**: `flipFailures=1`, entry kept (**E6**) — the marker is the retry |
| **P4** | the owner is alive (second process booting) | entry+marker, record `running` | **held**: nothing written, entry kept, no retry offer (**E4d**) |

**The invariant the design buys:** *a `running` agent record that a fresh process can observe is either
(a) owned by a live process, or (b) accompanied by a durable marker naming the terminal status.* No other
state is constructible.

### The contract block — goes in `persistRunRecord`'s doc and the helper's doc, verbatim

> **MARKER BEFORE RETIREMENT.** The pre-start terminal path is `markRecordFlipPending` → terminal run entry
> (`deferRetire`) → record flip (`flipAgentRecord`) → **retire** (`clearInflightRun`). Retirement is last
> and conditional because `clearInflightRun` is an unlink (`V1`): a marker written after it has no home, and
> an entry retired before the flip leaves a `running` record no boot scan can source a candidate for (W-0,
> W-1). Every other `persistRunRecord` caller keeps retire-then-append — the deferral is opt-in by argument,
> so the foreground `state.ts` writer and the background settle paths are untouched.
>
> **THE FLIP VERIFIES THE DISK, NOT THE RETURN.** `persistAgent` swallows write errors (`V8`), so
> `updateAgentStatus` returning is not the flip landing: `flipAgentRecord` re-reads `<storage>/<id>.json`
> (`loadAgent`, which bypasses the in-memory map) and reports `false` unless the persisted status is
> terminal — the caller then keeps the marker for the next boot.
>
> **REPLAY IS INERT; HOLD, NEVER GUESS.** An already-terminal record is not rewritten (no `completedAt`
> re-stamp, no second `subagent:failed`) — the marker is retired with no write (`flipRetired`). A marker
> whose record is still `running` is applied only when its owner is **provably dead**, the predicate the
> never-started path already applies (`V11`): a live or unverifiable owner may be microseconds from doing it
> itself, so nothing is written, nothing is offered, and the marker stays.

### The code — four touch points

**`src/run-registry.ts`** (+104/−2 measured):

```ts
export type RecordFlipStatus = "failed" | "completed";   // the AGENT-record vocabulary

export interface RecordFlipPending {
  status: RecordFlipStatus;
  error?: string;   // the string the flip would have stamped (already sanitised by the caller)
  at: string;       // ISO of the marker write — diagnostics only
}
// InflightRun  gains: recordFlipPending?: RecordFlipPending;
// InflightRunInput gains: recordFlipPending?: RecordFlipPending | null;  (null = explicit CLEAR)

export function markRecordFlipPending(id: string, flip: RecordFlipPending): boolean {
  try {
    const file = resolvePath(id);
    if (!file) return false;
    const existing = readEntry(file);
    if (!existing) return false;                      // retire already happened ⇒ nothing to strand
    if (existing.recordFlipPending) return true;       // idempotent
    return writeAtomic(file, { ...existing, recordFlipPending: flip });
  } catch { return false; }                            // TOTAL: a pre-start cleanup may not throw
}

export interface PersistRunRecordOptions { deferRetire?: boolean }
export function persistRunRecord(pi, run, kind?, options?: PersistRunRecordOptions): void {
  if (run.status !== "running") { if (!options?.deferRetire) clearInflightRun(run.id); }
  else if (kind) { registerInflightRun(toRegistryInput(run, kind)); }
  pi.appendEntry(CUSTOM_ENTRY_TYPES.run, run);
}
```

`normalizeEnrichment` gains the lenient read: a well-formed marker is kept, anything else is **dropped**
(never invented) — the deliberate opposite of the strict `recoveryPosture` check, for the same reason
`acceptedAt` is lenient. `mergeInput` treats `null` as the clear, mirroring `acceptedAt`.

**`src/session-manager.ts`** (+82/−19 measured):

```ts
export function flipAgentRecord(id: string, status: RecordFlipStatus, error?: string): boolean {
  let record: BackgroundAgent | null = null;
  try {
    record = getAgent(id);
    if (record && !isTerminalAgentStatus(record.status)) {
      record = updateAgentStatus(id, status, error) ?? record;   // memory + disk + event
    }
  } catch (err) {
    log.warn(`Failed to flip the terminal record for ${id}`, { error: thrownMessage(err) });
  } finally {
    if (record) record._sessionRef = undefined;   // memory-only; must run even if the flip threw
  }
  const persisted = loadAgent(id);                // THE DISK, not the map (D4)
  if (!persisted) return true;                    // nothing durable can go stale
  return isTerminalAgentStatus(persisted.status);
}
```

`markSpawnFailedBeforePrompt` becomes STEP 0 → A → B → C → D:

```ts
  const markSpawnFailedBeforePrompt = (message: string): void => {
    // STEP 0 (#546) — the durable INTENT, written while the entry still exists.
    markRecordFlipPending(id, { status: 'failed', error: message, at: new Date().toISOString() });
    try {                          // STEP A — run entry (+ retention/prune; retire DEFERRED to STEP D)
      finalizeRunEntry('failed', message, { deferRetire: true });
    } catch (err) { safeLog(...'pre-start finalize failed'...) }
    const landed = flipAgentRecord(id, 'failed', message);   // STEP B — total, disk-verified
    try {                          // STEP C — transcript note
      transcript.completeTranscript(id, 'failed');
    } catch (err) { safeLog(...'pre-start transcript note failed'...) }
    agent._sessionRef = undefined;  // outside every try
    if (landed) clearInflightRun(id);                        // STEP D — retire LAST
  };
```

`finalizeRunEntry` gains the `deferRetire` flag on its `terminal` argument and forwards it
(`persistRunRecord(pi, entry, undefined, { deferRetire: terminal?.deferRetire })`, `:1841`). The two
blanket `clearInflightRun(id)` calls that followed the helper — `failPreStart` STEP 3 (`:2077`) and the
branch-refusal site (`:2221`) — are **deleted**: they would delete the marker that repairs this crash. The
helper owns retirement now.

**`src/recovery.ts`** (+157/−7 measured):

```ts
export interface RecordFlipVerdict { id: string; status: RecordFlipStatus; error?: string }
// RegistryScanOptions + ProductionRecoveryOptions gain:
//   applyRecordFlip?(verdict): boolean | void     // false ⇒ the durable write did NOT land
// BootScanSummary gains flipRepaired / flipRetired / flipFailures (flat, like the rest)

function ownerProvablyDead(owner, deps): boolean { ... }   // extracted from the never-started path
function recordFlipDecision(entry, agent, deps): "repaired" | "retired" | "held" {
  if (!agent || agent.status !== "running") return "retired";
  const owner = agent.owner ?? entry.owner;
  return ownerProvablyDead(owner, deps) ? "repaired" : "held";
}
```

inserted at the **top** of the candidate loop, before `if (agent && agent.status !== "running") continue;`
(`:355`) — the drop that would otherwise swallow the marker (`V5`):

```ts
    if (entry.recordFlipPending) {
      if (!options.applyRecordFlip) { /* debug: no applier wired ⇒ pre-#546 path */ }
      else {
        const decision = recordFlipDecision(entry, agent, options.deps);
        if (decision === "held") { /* debug */ continue; }        // no write, no offer, entry kept
        // call the applier; `false`/a throw ⇒ flipFailures++, the entry is KEPT
        // (fail-closed, exactly like mark(): the summary must not claim a repair that did not land)
        continue;                                                 // either way this entry's scan is over
      }
    }
```

**`src/boot-recovery.ts`** (+20/−1 measured): import `flipAgentRecord` alongside `getAgent`/`markAgentInterrupted`,
wire the dep, and log one separate line:

```ts
applyRecordFlip: (verdict) => {
  if (!flipAgentRecord(verdict.id, verdict.status, verdict.error)) return false;
  clearInflightRun(verdict.id);
  return true;
},
// …
if (summary.flipRepaired + summary.flipRetired + summary.flipFailures > 0)
  log.warn("Boot recovery settled pending record flips", { repaired, retired, failures });
```

The flip and the retirement live **in the applier**, not in the scan: the marker *is* the entry, so the two
writes belong together, and `recovery.ts` stays free of a `session-manager` import (it imports only
`run-registry`, `sanitize`, `proc`, `recovery-engine`, `types` today — `:34-39`). The boot wiring owns the
one new import, and `flipAgentRecord`'s own disk read is what makes `false` truthful.

### Sub-decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| **D1** | Field name and shape | `recordFlipPending?: { status, error?, at }` on `InflightRun` | `pending` names the state, not the writer; `status` + `error` are exactly what the flip writes, so the verdict needs no mapping table; `at` is diagnostics only (ordering is the entry's) |
| **D2** (was D2+D3) | Written in STEP 0, **cleared** by the conditional STEP D retirement (never explicitly) | `markSpawnFailedBeforePrompt`'s first statement | retirement happens inside `persistRunRecord` (`V1`), so anything after STEP A has no entry to write to; and one owner for the lifecycle beats a clear-then-retire sequence that opens a second window for nothing |
| **D4** | "Landed" means **disk**, not "no throw" | `loadAgent(id)` re-read inside `flipAgentRecord` | **V8/E7**: `persistAgent` swallows `EACCES`/`ENOSPC`, so a return-based "landed" retires the marker over a record that is still `running` — the pre-#546 residue, re-created by the fix. Cost: one file read on a failure path |
| **D5** | Verdict ledger | `repaired` / `retired` / `failures` counters, three not one | `repaired` **rewrites a record** (and emits `subagent:failed`); `retired` does not; `failures` must be separately visible or a broken boot reads as a clean one (the #304 rule the `mark` path already follows) |
| **D6** | A marker beats `acceptedAt: null` | the marker branch is **before** the never-started classification | the marker names a terminal status for a dispatch whose run entry is already written; finalizing it "never started" would double-write and misclassify |
| **D7** | Held ⇒ skip, not fall through | `continue` when the owner is live/unverifiable | measured **E5**: the ordinary path turns an unflippable entry into an interrupted **retry offer** for a run that already terminated. `DecideRecovery` would also *mark* an unparsable pid — a write on unverifiable ownership, against the maintained no-owner policy |
| **D8** | Fail-closed on the applier | `false` or a throw ⇒ `flipFailures++`, entry kept, scan continues | measured **E6**; a thrown applier must not abort the scan for other candidates (same rule as `mark`) |
| **D9** | Vocabulary | `RecordFlipStatus = "failed" \| "completed"`; only `failed` written today | the marker's value is copied verbatim into `updateAgentStatus`, whose `AgentStatus` also has `stopped`; narrowing to `"failed"` would force a widening edit the day a second writer appears, and the reader validates both values today |
| **D10** | The two branch-refusal sites | unchanged — they call the same helper, so they inherit STEP 0/D | the only edit there is **deleting** the blanket `clearInflightRun` (`:2221`), which would otherwise unlink the marker the helper just wrote |

### Rejected options

| Option | Mechanism | Blast radius | Cost | Risk if the analysis is wrong |
|---|---|---|---|---|
| **B — separate marker file** (`<registry>/<id>.pending.json`) | survives the unlink; the flip unlinks it | `run-registry` (dir reader must skip it: `listInflightRuns` treats **every** `*.json` as an entry, `:272-287`), `recovery` (second list + a second candidate class), `boot-recovery`, every test that counts registry files | ~+90 src, +30 tests | Two files that must agree with no atomic relation: a crash between "write pending" and "retire" leaves **both**, between "clear pending" and "retire" a silent zombie, and an orphan `.pending.json` needs a sweep rule nobody wrote |
| **C — tombstones instead of unlink** | `clearInflightRun` writes `{state:"retired"}` | **every** reader of the registry (`recovery-surface`, `session-manager:718`, `listInflightRuns` in 83 test files, the boot scan) plus retention/prune and `.done` non-goals | +120 src, unknown test churn | A tombstone is a permanent file per run; expiry needs a retention policy this unit explicitly does not own, and every existing `listInflightRuns()` caller changes meaning at once |
| **D — minimal: append-before-retire, no marker** | swap the order for this caller; the leftover entry is an ordinary interrupted candidate | `run-registry` only | ~+12 src | **Measured false positive (E5)**: boot offers a retry for a dispatch whose run entry already says `failed`, and the record stays `running`. It trades a silent zombie for a noisy wrong offer |
| **E — do nothing** | leave the residue; document it | 0 | 0 | The issue's two rows stand: `get_subagent_result` reports `running` forever, the monitor and run-history disagree, and the only repair is a manual record edit. Low incidence, but the fix is ~40 source lines and the state is provably reconstructible |
| **A (chosen)** | marker in the entry, retirement last, verdict at boot | `run-registry` (+field, +writer, +option), `recovery` (+1 verdict, +3 counters), `session-manager` (+1 helper, STEP 0/D), `boot-recovery` (+1 dep) | +104/+157/+82/+20 src = **+363/−29**, net **+334**, tests ~+230 | If a boot can run **concurrently** with a live writer on the same registry, the hold rule is the only thing preventing a double flip — measured (**E4d**) that it holds. If `persistAgent`'s swallow were ever fixed to throw, `flipAgentRecord`'s read-back becomes redundant, not wrong |

### Blast radius — the registry readers, named

| Reader | Sees a marker? | Effect |
|---|---|---|
| `recovery.ts:329` (`listInflightRuns`) | yes | the new verdict, before the terminal-record drop |
| `boot-recovery.ts:252` (`maybeSendRecoveryNotice`) | indirectly | a repaired/retired entry is gone before the notice surface runs; a **held** entry has no `interruptedAt` ⇒ `collectInterruptedRuns` skips it |
| `recovery-surface.ts:231`, `session-manager.ts:718` | projected only when `interruptedAt` is present | a marker never becomes an "interrupted run" on any tool surface |
| `run-registry.test.ts:596` | `toMatchObject` | new summary fields are additive (`V10`) |

---

## Tests — every advertised property, and what is red on base

Three files. The probe file behind this table (**E8**) is a *measurement artefact*, not the deliverable: it
is written with namespace imports so the SAME file runs on base; the shipped tests import directly and live
in the suites named below.

| # | Case | Suite | Pins | On base (`c575a6c`) |
|---|---|---|---|---|
| **R1** | marker round-trip + idempotent second write | `run-registry` | the writer's contract | `TypeError: markRecordFlipPending is not a function` |
| **R2** | a mistyped marker is **dropped**, the entry is not rejected (other fields intact) | `run-registry` | lenient read (D1, M11) | n/a — the field does not exist |
| **R3** | `markRecordFlipPending` is total: missing entry ⇒ `false`, unsafe id ⇒ `false` | `run-registry` | "a cleanup may not throw" | `TypeError` (above) |
| **R4** | `{deferRetire:true}` keeps the entry across a **throwing** append; without it the entry is retired first | `run-registry` | the W-0 order, as an API contract (M3) | `expected [ Array(0) ] to deeply equal [ '…json' ]` |
| **C1** | residue (marker + `running` + dead owner) ⇒ record `failed`+`completedAt`+`error`, entry retired, `flipRepaired === 1` | `recovery` | the repair (M1, M2, M4) | `expected 'running' to be 'failed'` |
| **C2** | the second scan is inert: `completedAt` unchanged, `flipRepaired = flipFailures = 0` | `recovery` | replay safety (D-contract) | `expected 'undefined' to be 'number'` |
| **C3** | **live** owner ⇒ nothing written, entry kept, `flipRepaired === 0`, `marked === 0` | `recovery` | the hold rule (M7) | `expected undefined to be +0` (counter only — base is behaviourally identical here; the kill is **M7**) |
| **C3b** | **unparsable** owner ⇒ held, `interruptedAt` stays `null`, `marked === 0` | `recovery` | hold ⇒ *skip*, not fall through (M9, D7) | `expected '2026-…781Z' to be null` — base **marks** it: the false retry offer |
| **C4** | applier's durable write failed ⇒ `flipFailures === 1`, entry **kept**, record `running` | `recovery` | fail-closed (M10) | `expected undefined to be 1` |
| **C6** | marker whose record **already landed** ⇒ retired, `completedAt` unchanged, `flipRetired === 1`, `flipRepaired === 0` | `recovery` | the drop-before-verdict ordering (M8) | `expected [ Array(1) ] to deeply equal []` — base **leaks** the entry forever |
| **C7** | marker on an `acceptedAt: null` entry ⇒ repaired, and the never-started finalizer **never runs** | `recovery` | D6 precedence | `expected 'running' to be 'failed'` |
| **S1** | after a synchronous `prompt()` throw: record `failed` (memory+disk), run entry `failed`, registry empty, and `markRecordFlipPending` is called **before** `clearInflightRun` (`mock.invocationCallOrder`) | `session-manager` | the happy path + the order (M1/M2) | `TypeError` on the spy target |
| **S2** | the **B1-shape crash pin**: STEP 0 + STEP A of the real helper, then the real boot wiring ⇒ record flipped, entry retired, `flipRepaired === 1`, second boot inert | `session-manager` | the end-to-end repair on the shipped path | `expected 'running' to be 'failed'` |
| **S3** | flip write failure (`chmod 0o400` the record ⇒ `persistAgent` swallows) ⇒ `false`, marker kept; after restoring the mode the next boot repairs | `session-manager` | **D4**, the read-back (M5, M6) | `flipAgentRecord` absent ⇒ `TypeError`; behaviourally base has no marker |
| **S4** | the branch-refusal site still ends with `listInflightRuns() === []` **and** the record `failed` | `session-manager` | guards the deletion of the blanket `clearInflightRun` (`:2221`) | green on base — a **regression guard**, not a red pin |

`it.skipIf(process.platform === "win32")` on **S3** (POSIX `chmod`). The existing pins at
`session-manager.test.ts:3766`/`:3800` (spy: `clearInflightRun` ran on the pre-start path) stay **green
unedited** — STEP D still calls it, on the success path.

## Delta (ADR 0028) — measured from the probe tree, not estimated

`allowance(surface) = 120 + 2 × max(Δsource, 0)`, net lines, `--no-renames`:

| Surface | + | − | net | allowance |
|---|---|---|---|---|
| `src/run-registry.ts` | 104 | 2 | +102 | — |
| `src/recovery.ts` | 157 | 7 | +150 | — |
| `src/session-manager.ts` | 82 | 19 | +63 | — |
| `src/boot-recovery.ts` | 20 | 1 | +19 | — |
| **src total** | **363** | **29** | **+334** | 120 + 2×334 = **788** |
| `src/__tests__/**` (probe set, 7 cases) | 165 | 0 | +165 | **788** |

Comment-stripped, the same source diff is **184** added lines (the delta is doc-heavy by house style, and
the `persistRunRecord`/contract blocks are required, not padding). The shipped test set (~14 cases across
three files) is budgeted at **≈ +230**, i.e. **within** the 788 allowance; if the integrated set measures
over, the PR body carries the `Test budget: over-allowance — …` declaration and no pin is dropped.

## Mutants — each with its killer

| # | Mutant | Killed by |
|---|---|---|
| **M1** | delete STEP 0 (no marker) | C1, C2, S1 (order pin), S2 |
| **M2** | write the marker **after** STEP A (the issue's original ordering) | C1, C2, S2, R4 — `markRecordFlipPending` returns `false` (the entry is gone) |
| **M3** | ignore `deferRetire` in `persistRunRecord` (keep the unconditional retire) | C1, C2, S2, R4 |
| **M4** | `clearInflightRun` between STEP A and STEP B | C1, S2 |
| **M5** | STEP D retires unconditionally (`clearInflightRun(id)` without `landed`) | S3 |
| **M6** | `flipAgentRecord` returns after `updateAgentStatus` without the disk read-back | S3 (**E7**: measured `LANDED=true` with the disk still `running`) |
| **M7** | `recordFlipDecision` returns `"repaired"` without the ownership guard | C3, C3b |
| **M8** | move the marker branch **below** `if (agent && agent.status !== "running") continue` | C6 (entry leaks; `expected [ Array(1) ] to deeply equal []` on the *patched* tree) |
| **M9** | delete the `held ⇒ continue` (fall through to the candidate path) | C3b (`marked === 1`, `interruptedAt` set) |
| **M10** | retire even when the applier returned `false` | C4 |
| **M11** | strict marker read (reject the whole entry on a bad marker) | R2 |

M5/M6 are the pair that matters: **M5** is what a reviewer will write by hand ("just retire when the flip
returns"), and **M6** is the only thing that makes M5 detectable — measured, **E7**.

## Verification plan

1. `git status --porcelain` → empty. Re-derive the anchors with
   `grep -n 'recordFlipPending\|markSpawnFailedBeforePrompt\|finalizeRunEntry\|clearInflightRun(id)\|persistRunRecord(pi, entry)' src/{run-registry,session-manager,recovery,boot-recovery}.ts`
   and paste the counts into the PR body (§Recon verification was taken at `c575a6c`).
2. Write the tests first (§Tests). `npx vitest run src/__tests__/{run-registry,recovery,session-manager}.test.ts`
   → the red rows of §Tests, messages pasted.
3. Implement in this order — `run-registry` (type, field, normalizer, writer, option) → `recovery` (verdict,
   counters, `ownerProvablyDead` extraction) → `session-manager` (`flipAgentRecord`, STEP 0/D, the two
   deleted blanket retires) → `boot-recovery` (dep + log line). The tree typechecks **without tests**
   (`tsconfig.json` excludes `src/__tests__`), so step 3 is `npx tsc --noEmit` clean at each hop.
4. Suites green; `npx tsc --noEmit` **0**; `node scripts/check-imports.mjs` clean.
5. M1–M11 one at a time in a scratch copy (never the repo); record which case died and its message.
6. **The crash probes, against the patched tree** — reuse the harness (`phase1.cjs` writes the real records
   with the real writers then `SIGKILL`s itself; `boot.cjs` runs `createBootRecovery().performBootRecovery()`
   + `maybeSendRecoveryNotice` in a fresh process; `read.cjs` is a third process). Record for **P0, P1, P2,
   P3, P4** and for the two **base controls** (W-0, W-1): `DISK_STATUS`, `COMPLETEDAT`, `ERROR`,
   `RESTART_STATUS`, `REGISTRY_FILES`, `COMMITTED_RUNS`, `SESSION_DIR`, `NOTICES`, and the boot log's
   `repaired/retired/failures` triple. Expected: the §Marker lifecycle table, verbatim.
7. **GATE — the full suite in the worktree** (`npx vitest run`): the four suites green and **no new failing
   test name** against a pre-change run of the same command; record both name lists.
8. PR body: `## Design assumptions` (below), the residue tables, the mutant table, the probe table, the
   `Test budget:` line.
9. **GATE — the flow, from committed objects.** Commit first, then from the **cockpit** root:
   `node scripts/check-test-budget.mjs --flow --base dev --head <final sha>`; record base sha, head sha, exit
   and the full line. Rerun on any commit change. A non-zero exit **with** the declaration is the expected
   outcome, not a failure.

**Design assumptions (stateful checklist).** *(1) State:* one new FIELD on the existing per-run registry
file (dir `0700`, `writeAtomic` → `0600`) — no new path, no new file class, no lock. *(2) Teardown:* the
retirement **is** the teardown and it is now conditional and last; a kill at any point leaves the marker,
whose consumer is the next boot — the sweep is the boot scan, so there is none to write. *(3) Concurrency:*
two processes can read the same registry; the boot write is gated on `ownerProvablyDead` and a live owner
holds the entry untouched (C3, C3b). The marker write and the unlink are not atomic against each other,
which is why the marker is first and the unlink last. *(4) Missing/partial/unreadable:* an invalid marker is
dropped (fail-open to the pre-#546 residue, never a fabricated flip); a missing entry ⇒ `false`; a missing
record ⇒ `retired`; the applier's `false` keeps the marker (fail-closed). *(5) Evidence:* E1–E8, Δ, 7
probe cases red-on-base, M1–M11.

## Risks, residuals, out of scope

| Risk | Severity | Mitigation / statement |
|---|---|---|
| The `#542` contract comment claims STEP A "retires"; this unit moves it to STEP D | **medium** (review friction) | the contract block above is the replacement text, it states *why* the retire moved, and W-1 becomes a **repaired** state (P1) rather than a residue |
| Deleting the two blanket `clearInflightRun` calls (`:2077`, `:2221`) removes #542's "belt" for a throwing finalize | low | the belt was for a retired entry; **S4** pins that the refusal site still ends with no entry, and a STEP-A throw now leaves a marker instead of nothing |
| A boot-time `subagent:failed` (the repair emits one) could wake the completion push at startup | low | same class as #542's flip: `deliverCompletionAlert` is `try/catch`-wrapped and deduped by `claimTerminalNotice`, and it now fires over a run entry that already exists |
| A **held** marker with an unverifiable owner is permanent | low, **stated** | no `/proc` ⇒ the platform guard skips the whole scan (`recovery.ts:463`); the entry is the durable record of the intent, and the record stays `running` exactly as today |
| `loadAgent` read-back: one extra sync read per repair | low | failure path only; the alternative (M6) is a silent regression of the fix |

**Residual windows this unit does not close** (stated, not claimed fixed):

- **Before STEP 0** — a kill between the durable dispatches and the marker write leaves the pre-#542
  state: record `running`, registry entry present, run entry `running`. The boot scan marks it
  **interrupted** and offers a retry — the designed interrupted class, not a zombie.
- **The session entry stream at P0.** The repair flips the record and retires the entry, but the dead
  process's *session log* cannot be appended to by a fresh process: a resumed session still shows the last
  run entry as `running`. The record is authoritative for status; the run-history surface for that
  resumed session is not repaired here.
- **A live, wedged owner.** If the owner process is alive but never reaches STEP D (uninterruptible), the
  marker is held by design until that process dies — no boot may preempt a live writer.
- Retention/`.done`/prune paths, the #542 write order, and any general registry redesign: **untouched.**

## Acceptance criteria

1. A marker written before retirement survives the run-entry write, the flip, and a crash at any of them,
   and `listInflightRuns()` reports it verbatim (R1, R4).
2. A crash after the marker and before the flip is **repaired on the next boot**: the persisted record is
   terminal with `completedAt` and the marker's `error`, the registry entry is gone, `flipRepaired === 1`,
   and a third process reports `getAgent(id).status === 'failed'` (C1, S2, **E4a/E4b**).
   *Falsifier:* any of those five observables disagreeing, or a boot whose log says `repaired: 0`.
3. A marker whose flip already landed retires **without** a rewrite: `completedAt` and `error` byte-identical
   across the boot, no second terminal event, `flipRetired === 1` (C2, C6, **E4c**).
4. A live or unverifiable owner is never acted on: no record write, no `interruptedAt`, no retry notice,
   entry kept (C3, C3b, **E4d**).
   *Falsifier:* a boot that marks a marker-bearing entry it cannot verify.
5. A failed flip write is **not** reported as landed: `false`, marker kept, `flipFailures === 1`, and the
   next boot repairs (C4, S3, **E6/E7**). *Falsifier:* `flipAgentRecord(...) === true` with the persisted
   status still `running`.
6. The happy path leaves **nothing**: registry empty, record `failed`, run entry `failed`, marker gone
   (S1). No other `persistRunRecord` caller changes semantics: `state.ts`'s foreground writer and the
   background settle paths still retire before appending (R4 asserts both branches).
7. `npx tsc --noEmit` clean; the four suites green; the **worktree** full suite shows no new failing name;
   the flow verdict recorded from the committed head (steps 4, 7, 9).
8. `Structural closure: n/a — no moved/deleted exports` — three **added** exports (`RecordFlipPending`,
   `RecordFlipStatus`, `markRecordFlipPending`, `flipAgentRecord`) and two added optional fields; nothing
   removed, no signature narrowed.

## Evidence

Probes ran in `~/.cache/brl-subagent/scratch/spec-546/` (`base` = `c575a6c` src, byte-identical to the
repo: `diff -rq base/src src` → empty; `optA` = the design implemented, `tsc --noEmit` exit 0). Every crash
case: **P1 exit=137** (real `SIGKILL`), then a fresh process running the production boot, then a third
process reading only disk.

| ID | Claim | Probe | Observed |
|---|---|---|---|
| **E1** | base, shipped order, W-1 | `run.sh base base-w1 w1` | `PRE/POST DISK=running`, `COMMITTED_RUNS=[running,failed]`, `REGISTRY=0`, `SESSION_DIR=false`, **no boot line and no boot append** (the scan logs only what it acted on), `RESTART=running` |
| **E2** | base, W-0 (kill inside `persistRunRecord`) | `run.sh base-w0 base-w0 w0` | `DISK=running COMPLETEDAT=null`, `COMMITTED_RUNS=[running]` (**never attempted**), `REGISTRY=0`, `SESSION_DIR=false`, no boot line, `RESTART=running` |
| **E3** | base, `acceptedAt: null` is not rescued either | `run.sh base base-w0-null w1 NULL` | identical to E1 — the never-started finalize also needs an entry to source |
| **E4a** | **P0** (marker, no run entry yet) | `run.sh optA optA-p0b p0` | `POST DISK=failed COMPLETEDAT=1795224389626 ERROR=spawn preflight failure`, `REGISTRY=0`, log `repaired:1 retired:0 failures:0`, `RESTART=failed` |
| **E4b** | **P1** (marker + committed `failed` run entry) | `run.sh optA optA-p1b p1` | same as E4a, `COMMITTED_RUNS=[running,failed]` |
| **E4c** | **P2** (flipped, not retired) | `run.sh optA optA-p2b p2` | `POST DISK=failed`, `COMPLETEDAT` **identical** to PRE, `REGISTRY=0`, log `repaired:0 retired:1 failures:0` |
| **E4d** | **P4** (owner alive at boot) | `run.sh optA optA-p0-live p0-live` with a real live pid + its start token | `POST DISK=running`, marker + entry **kept**, `NOTICES=0`, `RESTART=running` |
| **E5** | option D's residue becomes a **false retry offer** | `run.sh base optD-d1 d1` (terminal run entry committed, entry left, owner dead) | boot log `marked:1`, `Recovery notice delivered {"count":1}`, `POST DISK=running COMPLETEDAT=null`, entry kept |
| **E6** | fail-closed: the applier reports a failed durable write | `dbg3.cjs` on an E4a residue with `applyRecordFlip: () => false` | `flipFailures:1`, `ENTRY_KEPT=[{…flip:{status:failed}}]`, `DISK=running`; `markRecordFlipPending(missing)=false`, `(unsafe id)=false` |
| **E7** | `persistAgent` swallows the write, so "returned" ≠ "landed" | `dbg4.cjs`: `chmod 0o400` the record, then flip | **without** the read-back: `LANDED=true DISK_STATUS=running MEM_STATUS=failed`; **with** `loadAgent` read-back: `LANDED=false` |
| **E8** | the design is implementable and its pins are red on base | `zz-546-probe.test.ts` on `optA` then `base` | optA **7 passed**; base **7 failed**, one message per row of §Tests; a shared uuid across cases made C2 read C1's cached record (**V9**) |
| **Δ** | the delta | `git diff --no-index --numstat base/src optA/src` | `20/1`, `157/7`, `104/2`, `82/19` → **+363/−29**, net **+334**; comment-stripped +184 |
| **T** | the tree typechecks | `npx tsc --noEmit` in `optA` | exit **0** |

## Not verified

- **The worktree full suite and the flow verdict** — running them writes into (or grades) the repository;
  both are gates in the sketch (steps 7, 9), not this investigation.
- **Whether `flipAgentRecord`'s disk read is ever a measurable cost in production** — one sync read on a
  failure path; not benchmarked.
- **A second process booting *while* the writer is between STEP B and STEP D** — the hold rule covers the
  live-owner case (E4d) but the interleaving itself was not raced in a probe.
- **Windows**: `chmod`-based S3 is skipped there; the fail-closed read-back itself is platform-neutral.

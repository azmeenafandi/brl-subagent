# Background Parallel Subagents — Proposal & Plan

> Investigation recap (2026-09-15), **settled decisions**, and an implementation plan.
> **Status: REVIEWED & APPROVED — 2026-09-22.** Implementation starts with Phase 0; the fan-out phases
> follow as separate PRs targeting `dev`.
> **All line numbers re-verified 2026-09-22 against `dev` @ `bf48292`.** The original review was against
> `802eabe` (2026-09-15); everything shipped between (v2.3.7 on `main`, four fixes on `dev`) left the
> dispatch region and the inline background branch untouched (`git diff main..dev -- src/index.ts` = 1 line),
> so the structural findings stand. Line anchors in the Evidence map are dev-based now.
> **Settled 2026-09-22:** D3 **corrected** (branch-mode fan-out is *rejected*, not merely serialized);
> **Q2 answered — no batch id for v1** (user decision); D5 approved (Phase 0 ships independently).
> **Scope:** the **parallel slice** of ROADMAP **M2** (Conductor Autonomy Arc). Chain/graph are **not**
> estimated here — the fan-out / resumable-state-machine split is itself settled (below).

## Problem

`delegate_task` is strictly foreground for batch modes. **Chain, parallel, and graph all block** until every
subtask finishes. Only the *single* mode can run in the background (`background: true` → agent id immediately,
wake on terminal).

That means the two most useful shapes cannot be combined: *"fan out 8 independent investigations and let me keep
working"*. Today the conductor must choose between parallelism and non-blocking.

`AGENT.md:27` already acknowledges the gap:

> Chain, parallel, and graph are batch — one call, many subtasks. They are foreground today; **background batch is future work.**

## Relationship to ROADMAP M2 — the split is settled

This gap is **already planned.** `ROADMAP.md` → *Conductor Autonomy Arc* → **M2 — Background-by-default for
chain/parallel/graph** ("Opt-in first (`background: true` legal on chain/tasks/graph), configurable default later
(`defaultRunMode`)").

M2's text specifies a **resumable orchestration state machine**; this proposal builds **fan-out** (N independent
background agents). **Settled 2026-09-22 — they are different slices, not competing designs:**

| | M2 (ROADMAP) | This proposal |
|---|---|---|
| Mechanism | **Resumable orchestration state machine**, driven by the existing poller | **Fan-out** — N independent background agents |
| State | Persisted in the run record; **must survive extension reload** | None needed — agents are independent and each record already persists |
| Wakes | unspecified | One per agent (N wakes), `completionNotify` respected |
| Applies to | **chain and graph** | **parallel only** |

- **Parallel has no dependencies.** Spawn all → collect ids is complete. No sequencing, no `{previous}`
  substitution, no waves. A state machine would be ceremony wrapped around a for-loop.
- **Chain and graph genuinely need the machine.** Next-step selection depends on prior output (chain `{previous}`,
  graph `dependsOn` waves); that is where resumable, reload-surviving state earns its cost.

**M2's honest caveats that also bind here** (see ROADMAP):

- **Cross-run session caps** — each unit is a session; **no global cap exists today** (→ Q5)
- **Wake cost** — a wake is a real LLM turn; this is the basis of D2
- **Approval interplay** — `approvalMode: 'always'` is rejected in background; generalizes to N units per run

*Not applicable to the parallel slice:* tick latency between chain steps, and reload recovery of orchestration state.

## Current behaviour — including a live defect (re-verified 2026-09-22)

`execute()` (`src/index.ts`) resolves the mode and dispatches:

```
modeCount = [isChain, isParallel, isGraph, isSingle]   // L2444
if (modeCount !== 1) → error "Provide exactly one of…"  // L2445
if (isChain)    → runChainMode()   // L2459
if (isParallel) → runParallelMode() // L2475
if (isGraph)    → runGraphMode()    // L2491
// single mode only, from here down:
const singleTask = params.task!                         // ~L2497
const bgResolved = resolveSubagentParams(…)             // L2503  (runs for foreground too — see D4)
if (params.background) { … }                            // L2510–2885  (376 lines, INLINE)
// foreground single path continues at L2940+ (re-resolves params at L2953)
```

**`background` is not part of the mode axis.** It is consulted *only* in the single-mode path, which the batch
modes return before reaching. Therefore:

> ⚠️ **`delegate_task({ tasks: [...], background: true })` passes validation, ignores `background`, and runs
> `runParallelMode` — a BLOCKING call — while the caller believes it is background.**

**Re-verified 2026-09-22:** still exactly true on `dev` @ `bf48292`; still **unpinned by any test** (grep: zero
hits). It is undefined-by-omission, not specified.

This is the same class as **#174** and **#175**: a claim that does not match reality. It is **independent of the
feature** and worth fixing regardless — see *Phase 0*.

## What already exists (why this is M, not L)

The machinery for N independent background agents is **already there** — it is per-agent throughout:

| Primitive | Location (`dev` @ `bf48292`) | Reusable for a batch? |
|---|---|---|
| Spawn an independent session | `spawnBackgroundSession()` `session-manager.ts:409` | ✅ takes **one** params object — call N× |
| Agent registry + persistence | `agents` Map `session-manager.ts:50`, `persistAgent`/`loadAgent` | ✅ keyed by id |
| Storage dir | `STORAGE_DIR = '.pi/subagents'` (`session-manager.ts:54`), `__setStorageDir()` (`:60`) | ✅ |
| Live monitor | `state.registerLiveSubagent()` `state.ts:333`, `subagentSessions` map | ✅ the monitor iterates the whole map — N rows render natively |
| Wake on terminal | `deliverCompletionAlert()` `index.ts:3811` + `markTerminalSeen(id)` | ✅ per-id, idempotent |
| Poll / steer / stop | `get_subagent_result`, `steer_subagent`, `stop_subagent` | ✅ per-agent, N-agnostic |
| Per-task param merge | `mergeSubTaskParams(globalParams, task)` `index.ts:338` (used at `:1260`) | ✅ exactly what fan-out needs (one caveat: no call-level `model` fallback — Phase 2 step 3) |
| Per-task validation | `validateCwd` / `validateOutputFile` / `validatePreTask` — already per-unit in the background branch (`index.ts:2572/2582/2597`) | ✅ |
| Timeouts / hard caps / transcripts | per-agent deadline in `session-manager`; hard cap + poller in the inline branch | ⚠️ **inline — the extraction is Phase 1** |
| Concurrency slots + priority | `acquireSlot`/`releaseSlot` `concurrency.ts:44` | ⚠️ **foreground-only** — see D1 |

The `spawnQueue` (`session-manager.ts:20`, held only across setup, `:435-437`) serializes pi-API setup per spawn —
fine for N spawns. Limits: `MAX_CHAIN_STEPS = 10`, `MAX_PARALLEL_TASKS = 8`, `MAX_GRAPH_TASKS = 12`
(`types.ts:614-616`).

**Foreground and background use different engines.** Foreground runs `runSubagent()` (`runner.ts:719`);
background runs a real pi session via `createAgentSession`. So this is **not** "make `runParallelMode` async" — it
is "add a fan-out path that calls `spawnBackgroundSession` N times".

## Settled decisions

### D1 — Background fan-out does **not** take concurrency slots (unchanged)

Two concurrency models coexist: **foreground** (`acquireSlot` + priority queue, holds a slot per unit) and
**background** (no slots — `activeSubagents` counter + live monitor).

*Decision:* background fan-out uses **no slots**, bounded by `MAX_PARALLEL_TASKS` (8).

*Rationale:* `acquireSlot` **awaits**. A slot-blocked spawn means the tool call does *not* return immediately —
breaking the entire point of background. Bounding by `MAX_PARALLEL_TASKS` keeps the blast radius explicit instead
of coupling detached work to the foreground slot pool.

### D2 — v1 wakes **once per agent** (N wakes); coalescing deferred (facts updated 2026-09-22)

The wake path is strictly per-agent: `deliverCompletionAlert` → `markTerminalSeen(id)` → one message per terminal
agent, each firing a turn. Eight staggered completions ⇒ **eight wakes ⇒ eight turns**.

- **v1 (chosen):** accept N wakes. Each agent genuinely *is* independent, and `state.config.completionNotify`
  already exists as the user's knob. **Zero new machinery.**
- **v2 (deferred):** coalesce into one batch wake — batch membership, completion counter, debounce window,
  aggregate message, its own state machine + tests. *This is the single decision that would move the estimate
  from **M** to **L**.*

**Facts corrected/added 2026-09-22:**

- The knob's modes are **`all` | `failed` | `off`** (`types.ts:17`) — the 2026-09-15 draft said `all`/`terminal`/`off`.
- Wake-delivery semantics (measured, `INVESTIGATION_reload_wake.md`): a wake lands **promptly when the conductor
  is idle** (0–7 s) and is **queued until a quiet turn boundary when the conductor is mid-turn**
  (observed 28–567 s). Consequence for fan-out: N completions while the conductor is working arrive as a
  burst of queued turns — not lost, not merged. The knob remains the v1 mitigation.

### D3 — CORRECTED 2026-09-22: branch-mode fan-out is **rejected loudly**, not merely serialized

The 2026-09-15 draft assumed branch-mode fan-out would "run one at a time by design" and only needed documenting.
**That is wrong, and the difference matters:**

- `spawnBackgroundSession` acquires the per-repo git lock **inside the spawn call, before returning the agent id**:
  `await prev` at `session-manager.ts:732`; the function returns at `:1208` *after* that wait. The lock
  (`gitBranchLocks`, `session-manager.ts:24`) is held until the agent **settles** (`cleanupWorkBranch`).
- Therefore, with N>1 branch-mode tasks, spawn #2 **cannot return until agent #1 has finished**. An
  `await`/`Promise.all` over the spawns blocks the tool call for the whole serialized chain — the exact
  foreground-blocking failure the feature exists to remove, and worse than "runs one at a time".

*Decision (user-agreed 2026-09-22):* **`background: true` + more than one task with resolved `gitMode: 'branch'`
is rejected up front**, loudly, naming the rule — before any spawn.

*Why any N>1, with no "different cwd" carve-out:* `gitBranchLocks` is keyed by the **cwd string**
(`session-manager.ts:720` — `params.cwd ?? ctx.cwd`), not the repo root. Two cwds that are sibling subdirectories
of one repo share a working tree but **not** a lock, so "different cwd" is not proof of a different repo. (This
is a pre-existing latent hazard for multiple single branch-mode spawns too — file as a separate low-priority
issue; **not** fixed here.)

### D4 — The enabling refactor: extract the inline background branch (scope refined)

The background branch is **376 lines inline in `execute()`** (`index.ts:2510–2885`): approval/cost guards →
per-task validation → prompt build → `spawnBackgroundSession` → live registration → poller → hard-cap timer →
counters → result shape. Fan-out needs that callable N times → **extract
`spawnBackgroundRun(pi, ctx, resolvedParams)`** (a new module or a function beside the mode runners).

The ~30-line `bgResolved` prelude (`index.ts:2502–2509`) folds into the helper. Note this prelude currently runs
for **every** single-mode call, including foreground (which then re-resolves at `:2953`) — folding it in removes
one redundant `resolveSubagentParams` + auto-route `log.info` per foreground single. Log-only; accept.

**Explicitly NOT in the extraction** (stays in `session-manager.ts`): the work-branch lifecycle, the per-agent
timeout, and the settle/stopped paths with run-entry finalization. The C3 risk is the spawn-side wiring, and it
is now guarded by `live-subagent`, `session-manager`, `notify-completion`, and `terminal-status-consistency`
suites.

**Preserve in Phase 1:** the background model-resolution fallback (`bgModelResult.ok ? … : undefined` — an
unresolvable model silently falls back to the SDK default, whereas foreground errors). No behavior change.

### D5 — Reject `background` + batch modes loudly (Phase 0, independent) — APPROVED

The silent-ignore defect is fixed by an explicit rejection, **not** by the feature. ~10 lines in `execute()`
immediately after the `modeCount` check (`index.ts:2445–2457`), before `isChain`. The message names the
combination (and must pass the `runtime-vocabulary` ratchet — no `Rule <n>` / `E<nn>` / `issue #<n>` phrasing).

### D6 — Tracking (settled 2026-09-22; supersedes "no issue filed, deliberate")

- **Phase 0** is filed as its own bug issue and ships independently.
- **Phases 1–4** are filed as a feature issue with the phase checklist; each phase lands as its own PR targeting `dev`.

## Proposed implementation plan

Each phase is independently landable and independently useful.

### Phase 0 — Silence is not consent (XS · C1 · **independent of this feature**) — APPROVED, next

Reject `background` with `chain`/`tasks`/`graph` loudly until the feature exists.

- Fixes a live contract violation: a blocking call that reports itself as background.
- Removes the ambiguity that would otherwise make Phase 2's semantics hard to reason about.
- *Test:* background + `tasks` / `chain` / `graph` → `isError: true`, message names the combination. (Phase 2's
  `background + tasks + branch` rejection is a *different* check with a different message — do not conflate.)

### Phase 1 — Extract `spawnBackgroundRun()` (M · **C3** · pure refactor)

Move `index.ts:2510–2885` plus the `2502–2509` prelude into a reusable helper. **No behaviour change.**

- *Test:* the existing background suite passes unchanged; add an explicit "single background is unaffected" case.
- *Gate:* this phase alone should be releasable without touching any contract surface.
- *Ratchet check:* `terminal-status-consistency`'s `STRUCTURAL_ALLOWLIST` is keyed by exact file+snippet —
  today's five entries live in `logging.ts` / `session-manager.ts` / `tui.ts`, none inside the extracted range,
  but re-run the ratchets if the helper lands in a new file.

### Phase 2 — Fan-out (S–M · C2)

`background: true` + `tasks: [...]` → spawn N agents, return N ids immediately. **Validate all first, then spawn
all** (so a per-task validation error never leaves agents running).

```
1. globalParams: resolve once (existing single-mode path)
2. per task: merged = mergeSubTaskParams(globalParams, task)
3. per task: resolveSubagentParams({...merged, task}, …)   // auto-route is per task text
   per task: model = resolveStepModel(ctx, merged.model, globalModel)   // parity with runParallelMode L1084
4. per task: validateCwd → validateOutputFile → validatePreTask
   (NOT preflightCheck / getCurrentDepth — those are foreground-only by design: background runs
   in-process via the SDK, and is spawned noExtensions so it cannot delegate)
5. up front: resolvedApprovalMode === 'always' → reject (call-level only: SubTaskParams has no
   approvalMode and presets cannot set one)
6. up front: resolvedGitMode === 'branch' && taskList.length > 1 → reject (D3)
7. up front: cost check perTaskEstimate × N (mirrors the single background guard, index.ts:2516-2537)
8. per task: spawnBackgroundRun(...) with per-task originalParams = snapshot of the MERGED params
   (retry parity — a retried member must restore its own task/model/cwd, not the batch's)
9. collect ids; return ids in task order + labels.
   Spawn-time failure mid-loop: never silently drop the batch — report which task failed and list the ids
   already spawned (those agents keep running, detached).
   Abort (Q3): stop spawning on signal.aborted; already-spawned agents stay detached and will still wake you.
```

- `MAX_PARALLEL_TASKS` (8) already enforced at the dispatch site (`index.ts:2476`).
- *Open (conductor default, Q1):* text-only result (`details: undefined`, parity with single background).

### Phase 3 — Contract surface (S · C1)

- `promptGuidelines` (`index.ts:1983`) — batch semantics, N-wake behaviour, "do not poll" still applies.
  **Test-pinned strings**: `agent-guidance.test.ts` asserts `"do not poll"`,
  `"wake the conductor with a structured completion message"`, `"polling is only correct"`, and the AGENT.md
  path — edit deliberately.
- **`AGENT.md`** — execution-models table (`:17–24`; `single, background` row and the `Batchable?` column) and
  the "future work" sentence (`:27`).
- `README.md` — the background section (`:245–258`) + the parameter table (`:87`).
- Document: the **branch-mode rejection** (D3), the **slot-free** choice (D1), the **N-wake / queueing**
  behaviour (D2), and **abort semantics** (Q3).
- All new strings must pass the `runtime-vocabulary` ratchet.

### Phase 4 — Tests (M · C2)

Target suites: `session-manager.test.ts`, `chain-parallel.test.ts`, `live-subagent.test.ts`,
`notify-completion.test.ts` — plus the new constraint suites that now scan the tree
(`runtime-vocabulary`, `terminal-status-consistency`).

- N agents spawned, each independently pollable / steerable / stoppable.
- One wake per completion; `completionNotify` respected.
- Per-task validation errors name the failing task; validation runs before any spawn.
- Cost estimate accounts for N.
- Abort semantics: aborting the tool call does **not** stop detached agents (Q3).
- Draft-order/ids returned in task order.
- `gitMode: 'branch'` + N>1 → rejected up front (guards D3 so it cannot regress silently).

## Questions — resolved 2026-09-22

| # | Question | Resolution |
|---|---|---|
| **Q1** | `details` shape on the batch result? | **Text-only (conductor default):** N ids + labels in the result text; `details: undefined` (parity with single background). The live monitor already renders N rows from `subagentSessions` — no TUI work. Reopen if a machine-readable consumer appears. |
| **Q2** | Return a batch id even with N wakes? | **SKIPPED (user, 2026-09-22).** No batch concept exists anywhere; v2 coalescing is the only hard consumer and it is deferred. Recorded retrofit path: `isSubagentRunShape` is permissive (id/task/status) and `snapshotOriginalParams` is a whitelist, so adding `batchId` later is additive and does not force retry semantics. Accepted costs: no short correlation token in v1 (labels + ids serve); pre-upgrade in-flight batches can't be coalesced later (transient). |
| **Q3** | Aborting the tool call — do detached agents keep running? | **Yes, by rule:** stop spawning on `signal.aborted`; already-spawned agents remain detached and keep running; their wakes still name them. Documented in Phase 3. |
| **Q4** | Do `chain` and `graph` get background variants too? | Out of scope — they belong to M2's resumable state machine. Revisit after this slice ships. |
| **Q5** | Overall cap on concurrent background agents? | **Not added — recorded limitation.** Per-call `MAX_PARALLEL_TASKS` (8) binds; multiple calls can stack (2 calls × 8 = 16). Revisit on real usage. |

## Estimate

| Piece | Size | Risk |
|---|---|---|
| Phase 0 — reject `background` + batch loudly | **XS** | C1 |
| Phase 1 — extract `spawnBackgroundRun()` | **M** (376 lines + ~30-line prelude moved) | **C3** |
| Phase 2 — fan-out loop | **S–M** (~80 lines + guards) | C2 |
| Phase 3 — contract surface | **S** | C1 |
| Phase 4 — tests | **M** | C2 |

**Verdict: M as a v1 — for the parallel slice only.** No new execution engine is required — every primitive
exists. The cost is (a) the C3 extraction of the single background path, (b) three product decisions now settled
(D1–D3), and (c) three small guards added 2026-09-22 (branch rejection, abort rule, retry-parity snapshot).
Chain/graph via M2's resumable machine is a larger, separate estimate (not attempted here).

## Evidence map (`dev` @ `bf48292`, re-verified 2026-09-22)

| Fact | Source |
|---|---|
| Dispatch order; `background` only in single mode | `src/index.ts:2439–2510` |
| `modeCount` excludes `background` | `src/index.ts:2444` |
| Inline background branch (376 lines) | `src/index.ts:2510–2885` |
| `bgResolved` prelude also runs for foreground (re-resolved at `:2953`) | `src/index.ts:2502–2509` |
| `approvalMode: 'always'` rejected in background | `src/index.ts:2518–2527` |
| Background cost guard (R5's equivalent) inside the branch; R5 itself after (`:2887`) never runs for background | `src/index.ts:2516–2537, 2887` |
| Per-task validation inside the branch (cwd / outputFile / H1) | `src/index.ts:2572, 2582, 2597` |
| Per-agent wake | `src/index.ts:3811` (`deliverCompletionAlert`) |
| `runParallelMode` launch loop (`acquireSlot` per task, `Promise.allSettled`), per-step model resolution | `src/index.ts:1256–1289`, `:1084` (`resolveStepModel`) |
| `mergeSubTaskParams` | `src/index.ts:338` (used at `:1260`) |
| `spawnBackgroundSession()` — returns AFTER the branch-lock wait (`await prev` `:732`, `return agent` `:1208`) | `src/session-manager.ts:409` |
| `agents` Map / `STORAGE_DIR` / `__setStorageDir` | `src/session-manager.ts:50, 54, 60` |
| `spawnQueue` (serializes pi-API setup on spawn only) | `src/session-manager.ts:20, 435–437` |
| `gitBranchLocks` (full branch lifecycle per **cwd string**, not repo root) | `src/session-manager.ts:24, 720, 732, 793+` |
| Live monitor iterates all sessions (N rows already) | `src/tui.ts:1402+`, `src/state.ts:333` |
| Concurrency primitives (foreground-only) | `src/concurrency.ts:44` |
| Limits (`MAX_PARALLEL_TASKS = 8`, …) | `src/types.ts:614–616` |
| `completionNotify` modes `all`/`failed`/`off` | `src/types.ts:17` |
| Foreground engine | `src/runner.ts:719` (`runSubagent`) |
| Wake-message builder + delivery knob | `src/notify-completion.ts:124, 196` |
| Partial docs of the gap | `AGENT.md:17–27`, `README.md:87, 245–258` |
| Wake delivery semantics (idle prompt vs mid-turn queueing) | `.development/INVESTIGATION_reload_wake.md` |
| Ratchets that will scan the new code | `src/__tests__/runtime-vocabulary.test.ts`, `src/__tests__/terminal-status-consistency.test.ts` |
| Investigation source | graphify query 2026-09-15 (`graphify-out/memory/query_20260915_113237_*`) |

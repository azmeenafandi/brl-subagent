# The runtime-context seam for extracting `src/index.ts` (composition-root cycle)

**Design investigation for:** #430 (split `delegate_task.execute`) and the Track B theme from
2026-11-08 — the closure at `src/index.ts:433` has to give up its sections before #430 can be
done without 20-parameter functions.
**Status of this document:** decision-ready proposal for the conductor + maintainer. Not an
implementation, not an ADR (the ADR skeleton is §4, ready to paste into
`.development/decisions/0027-*.md`).
**Repository state read at:** `74f5b9f` (dev), `src/index.ts` = 4,720 lines, default export
begins at line 433, body = **4,288 lines**, **22 nested `function` declarations**. Re-checked at
`1ef474b`: only `.development/HANDOFF.md` changed between those two commits, so every line number
below is still exact.

---

## §0 How every claim below was measured

| claim class | method | command / artefact |
|---|---|---|
| line counts, section boundaries | `awk`/`python` over the real file, comment-stripped for identifier counts (block comments reduced to their newlines so line numbers stay true) | `awk 'NR>=433 && NR<=4720'`, `python3` strip-and-count script (line-count assertion printed `True`) |
| closure bindings + read/write sites | identifier scan inside 433–4720, comment-stripped | printed site lists (reproduced in §1) |
| intra-closure call graph | for each of the 22 helpers, regex over its line range for the other 21 names followed by `(` | §1.4 table |
| test-seam surface | `grep -rl 'from "../index"' src/__tests__`; then, per suite, `readFileSync`-on-`index.ts` | **24** test files import the module (22 default export, 1 `cleanupSessionState`, 1 named builders); **6** read the file as text (§2.5) |
| import-graph rules that bind extraction | **executed** the real suite against a byte copy of `src/`, `scripts/`, `package.json`, `vitest.config.ts` in `/tmp/probe-arch` with `node_modules` symlinked (baseline: 11/11 pass), then injected the two failures | §2.5 table, probe transcripts below |
| `erasableSyntaxOnly` vs class syntax | real `tsc` 7.0.2 from the repo's `node_modules` on a scratch file | `error TS1294` (parameter properties), exit 0 after rewriting to explicit fields |

Probes run (all in `/tmp`, repository untouched):

```
P1  /tmp/probe-arch         baseline: "Test Files 1 passed (1) / Tests 11 passed (11)"
P1a rename `async function runChainMode(` → `runChainModeMOVED(` in the /tmp copy
    → FAIL "runChainMode must exist in src/index.ts: expected -1 to be greater than or equal to 0"
      (architecture-rules.test.ts:351)
P1b add /tmp/probe-arch/src/probe-bg.ts: `import { spawnBackgroundSession } from "./session-manager"`
    → FAIL "lifecycle mutators belong to the entry point: allowed from session-manager outside
      index.ts — getAgent, listAgents: expected [ Array(1) ]" + "probe-bg.ts → session-manager.spawnBackgroundSession"
P1c add /tmp/probe-arch/src/probe-back.ts: `import initExtension from "./index"`
    → FAIL "index.ts is the pi entry point — importing it as a library creates hidden startup
      coupling: expected [ 'probe-back.ts → ./index' ] to deeply equal []"
P2  /tmp/probe-ctx/erasable.ts  `class A { constructor(private rt: Rt) {} }`
    → "erasable.ts(3,14): error TS1294: This syntax is not allowed when 'erasableSyntaxOnly' is enabled."
    rewritten as an explicit field + assignment → exit 0
```

**Correction to the issue text (Rule 20 — reality first).** #430 says *"A second `execute` at
~line 3593 is 28 cx / 64%"*. There is **no** `execute` declaration at ~3593. The tree has
exactly **four** `execute` properties: `delegate_task` at **2828** (`async execute(`,
lines 2828–3950 = **1,123 lines**), `get_subagent_result` at 3995, `steer_subagent` at 4164,
`stop_subagent` at 4213. Line 3583 is `await import('./transcript')` inside the single
`delegate_task` execute (the foreground transcript wiring). The "second execute" is either the
`get_subagent_result` handler or a stale measurement; #430's scope should be re-read as *one*
1,123-line `execute` plus three small siblings, not two large ones.

---

## §1 Inventory of the closure's captured state

### §1.1 The seven bindings the closure actually captures

"Captured" here means *declared in the factory body and read by a nested function without being
a parameter*. Everything else the nested helpers use is either a parameter or a module import.
The count is small — this is the whole reason the seam is designable.

| # | binding | declaration | mutable? | writes | reads (comment-stripped) | lifetime |
|---|---|---|---|---|---|---|
| 1 | `pi: ExtensionAPI` | factory parameter, `index.ts:433` | no | — | **47 code sites**: registration 7 (`registerCommand` 2705; `registerTool` 2782, 3975, 4148, 4200; `on` 4453, 4526); effect 8 direct `pi.sendMessage` (653, 2324, 2850, 2908, 3095, 3117, 4368, 4415); forwarded to modules 5 (2182 `spawnBackgroundSession`, 2483 `sendMonitoringDegradedAdvisory`, 3226 `runBackgroundFanOut`, 3240/4658 `spawnBackgroundRun`, 4713 `sendCompletionNotification`); forwarded into `SessionState` 14 (`state.persistRun`/`persistState`: 459, 479, 857, 1040, 1200, 1674, 1838, 2729, 3390, 3526, 3818, 3945, 4291, 4441); `finalizeUnitRun`/`finalizeUnitRunCrash(state, pi, …)` 6 (906, 915, 1272, 1280, 1728, 1743) | **process** — one per extension load (`initExtension(pi)`) |
| 2 | `log: Logger` | `const log = createLogger("brl-subagent")`, `index.ts:434` | object immutable; **sink is process-global** (`logging.ts:118` `logCwd`) | never reassigned | **120 code sites**, spread over every section (per-section counts §1.2) | process |
| 3 | `state: SessionState` | `let state = createSessionState(log)`, `index.ts:437` | yes (mutated, **never reassigned** — verified: the only `state =` in the file is 437) | `state.reset()` 465; the field writes in §1.3 | **172 code sites**, spread over every section | process (reset per session, not recreated) |
| 4 | `sessionCtx: ExtensionContext \| undefined` | `let sessionCtx`, `index.ts:442` | yes | **4455** (`session_start`) | **4692** only (`deliverCompletionAlert`). **Never cleared on shutdown** — 0 mentions in 4526–4554 | process, but semantically per-session |
| 5 | `recoveryNoticeDelivered: boolean` | `let recoveryNoticeDelivered = false`, `index.ts:448` | yes | 4401 (mark), **4552** (reset in `session_shutdown`) | 4400 (guard) | per boot |
| 6 | `displayTaskName` | `const` arrow, `index.ts:597` | no (pure) | — | 639 (`applyUnitShapeGuard`), 723 (chain), 1121 (parallel), 1957 (fan-out), 2042 (fan-out) | created at registration, but **pure** |
| 7 | terminal-listener ownership: `terminalTypes` (4574), `terminalSubscriptions` array (4581), `terminalSubscriptionsReleased` (4585) | three declarations, `index.ts:4574–4586` | array + flag | 4597 (flag), 4601 (`off` loop), 4608 (register loop) | 4582, 4598, 4604 | process; released once at `session_shutdown` |

Registration-time constants (also captured, but **not** by any section that would move): 
`registrationPresets` 2763, `presetRestrictionSummary` 2764, `registrationTemplates` 2774,
`templateSummary` 2775, `agentMdPath` 2780 — each read **exactly once**, all inside the
`delegate_task` **description/promptGuidelines** (2797 `${agentMdPath}`, 2805
`${presetRestrictionSummary}`, 2806 `buildTemplateGuideline(templateSummary)`). They are
registration-time only: the `execute` body never reads them. That matters for S5 (§3.3): moving
the *registration* carries them along as module-level locals or factory parameters; they add
nothing to any runtime seam.

### §1.2 Per-section dependency matrix (the numbers that decide the design)

Comment-stripped identifier counts inside each section's line range:

| section | lines | `pi` | `log` | `state` | `sessionCtx` | `spawnBackgroundRun` |
|---|---:|---:|---:|---:|---:|---:|
| `mergeSubTaskParams` (529) | 92 | 0 | 0 | **1** (550: `state.config.maxThinkingLevel`) | 0 | 0 |
| `applyUnitShapeGuard` (621) | 52 | 1 | 1 | 0 | 0 | 0 |
| `runChainMode` (673) | 396 | 4 | 9 | 17 | 0 | 0 |
| `runParallelMode` (1073) | 356 | 3 | 9 | 13 | 0 | 0 |
| `runGraphMode` (1433) | 434 | 4 | 10 | 18 | 0 | 0 |
| `runBackgroundFanOut` (1876) | 270 | 2 | 5 | 3 | 0 | 0 |
| `startBackgroundAgent` (2146) | 351 | 4 | 2 | 19 | 0 | 0 |
| `spawnBackgroundRun` (2497) | 204 | 2 | 5 | 4 | 0 | 1 |
| `/brl-subagent` handlers (2705) | 52 | 2 | 0 | 19 | 0 | 0 |
| `delegate_task` registration (2782–3950) | 1,169 | 11 | 40 | 36 | 0 | 1 |
| `get_subagent_result` (3975) | 168 | 1 | 1 | 0 | 0 | 0 |
| `steer_subagent` (4148) | 52 | 1 | 0 | 0 | 0 | 0 |
| `stop_subagent` (4200) | 49 | 1 | 0 | 0 | 0 | 0 |
| boot recovery cluster (4253–4452) | 200 | 4 | 13 | 12 | 0 | 0 |
| session handlers (4453–4554) | 102 | 2 | 13 | 17 | **1** | 0 |
| terminal notifier cluster (4574–4720) | 147 | 2 | 4 | 2 | **1** | 1 |

Two facts fall out:

* **`pi` / `log` / `state` are the three broad bindings.** Per-identifier reach: `pi` in **15 of
  16** rows, `log` in **12**, `state` in **12** (47 / 120 / 172 code sites overall). Per row:
  **10 rows read all three, 3 read two, 3 read one** (`mergeSubTaskParams`, `steer_subagent`,
  `stop_subagent`). Every row that moves **200+ lines** — the three mode runners, the background
  pipeline, the boot cluster, `delegate_task` — is in the "all three" group, and so is the
  147-line terminal notifier. Only the small rows can take a plain function deps struct with no
  container; a seam that does not carry the three pays a positional-parameter tax everywhere
  that matters.
* **`sessionCtx` appears in two sections, `recoveryNoticeDelivered` in two, the terminal trio in
  two.** They are *not* context material — they are owned slots with one writer and one reader,
  which is exactly what the current closure already is. Promoting them into a shared context
  would widen the surface for no measured gain (§3, falsifier F4).

### §1.3 What `state` really is (and why it is not new state)

`state` is already a class (`SessionState`, `state.ts:192`) holding config, counters, the two
footer timers, `pendingQueue`, `subagentSessions`, `modeContext`, `builtinPresets` /
`customPresets` / `builtinTemplates`, and `_migratedPresets`. Field writes inside the closure:

| write site | field |
|---|---|
| 465 (`resetState`) | `state.reset()` |
| 469 | `state.config.templates =` |
| 819, 1064, 1571, 1660, 1862 | `state.modeContext` (set/cleared per mode) |
| 2308 | `state.activeSubagents` clamp |
| 3846 | `state.config.lastSLAMetrics` |
| 4461, 4462, 4465, 4466, 4475, 4483, 4484, 4485 | preset/template load + migration |
| 245–255 (`cleanupSessionState`, module-level export) | counters, queue, timers |

So `state` is a **singleton with an existing, tested class boundary**. The runtime seam does not
need to invent session storage — it needs to hand this one object to the sections that leave.

### §1.4 The intra-closure call graph: a shallow DAG with exactly one back-edge

Call sites of each helper inside the closure, attributed to the enclosing unit (comment-stripped
source scan; every call site is a numbered line, so each edge is checkable):

```
leaves (no intra-closure calls):
  applyConfig, resetState, resolveSubagentModel, resolveStepModel, mergeSubTaskParams,
  applyUnitShapeGuard, startBackgroundAgent, visibleRunsFor, performBootRecovery,
  headStateDeps, maybeSendHeadStateNotice, maybeSendRecoveryNotice, releaseTerminalSubscriptions

runChainMode        → resolveStepModel (735), mergeSubTaskParams, applyUnitShapeGuard
runParallelMode     → resolveStepModel, mergeSubTaskParams, applyUnitShapeGuard
runGraphMode        → resolveStepModel, mergeSubTaskParams, applyUnitShapeGuard
runBackgroundFanOut → resolveSubagentModel (1900), mergeSubTaskParams (1956),
                      resolveStepModel (1970), applyUnitShapeGuard (2041),
                      startBackgroundAgent (2055)
spawnBackgroundRun  → resolveSubagentModel (2546), startBackgroundAgent (2620)
reconcileHeadStatesAtBoot → headStateDeps
abandonProductionRun → visibleRunsFor (4437)
/brl-subagent body  → resetState (2728), abandonProductionRun (2735)
delegate_task body  → visibleRunsFor (2948), runChainMode (3210), runBackgroundFanOut (3226),
                      runParallelMode (3227), runGraphMode (3231), spawnBackgroundRun (3240),
                      resolveSubagentModel (3353)
session_start       → performBootRecovery, reconcileHeadStatesAtBoot,
                      maybeSendHeadStateNotice, maybeSendRecoveryNotice
session_shutdown    → releaseTerminalSubscriptions (4536)
terminal listener   → deliverCompletionAlert → scheduleTransportRetry → spawnBackgroundRun (4657)
```

One edge points "backwards" in move order: the **terminal listener** (registered last, 4574–4610)
reaches `spawnBackgroundRun` (2497) through `deliverCompletionAlert` → `scheduleTransportRetry`
(4657), and `spawnBackgroundRun` has exactly two call sites in the whole file (3240, 4657). That is
a *call-time* edge, so it costs one injected function — never a module import (§2.5, probe P1b).
Every other edge is a forward edge along the staged order in §3.3.

**Corroboration (Rule 13 — `codegraph callers <name> --file src/index.ts`, the index resolves
here):** `mergeSubTaskParams` → chain, graph, parallel, fanOut; `startBackgroundAgent` → fanOut,
spawnBackgroundRun; `applyUnitShapeGuard` / `resolveStepModel` → chain, graph, fanOut, plus
`runTask` (the per-unit `const` closure at 1155 inside `runParallelMode` — the graph resolves one
level finer than this table); `displayTaskName` → chain, parallel, fanOut, applyUnitShapeGuard;
`runBackgroundFanOut` → callers: none (it is called from the `delegate_task` body, which is not a
declared function). **Where the graph under-reports, the source wins:** it lists only
`scheduleTransportRetry` as a caller of `spawnBackgroundRun`, missing the call at 3240 in the
`delegate_task` body; the table above is the source scan, and the graph was used as a cross-check,
not as the source of truth.

### §1.5 Process-global state the sections touch, which the context must NOT adopt

These are module-level and outlive any single `initExtension` invocation. Moving them into a
per-runtime context would be a behaviour change and would misstate their lifetime — the ADR
records them as explicitly out of scope:

| state | location | lifetime |
|---|---|---|
| `agents` map, `gitBranchLocks`, `gitBranchLockOwners`, `STORAGE_DIR` | `session-manager.ts:120, 38, 51, 124` | process |
| event-bus `listeners` | `event-bus.ts:10` | process (shared across runtime instances — the reason #437 exists) |
| `activeChildren` map, `spawnTokenSeq` | `runner.ts:95, 98` | process (**not** per runtime — a second runtime instance shares it) |
| `terminalClaims` | `notify-completion.ts:299` | process |
| `logCwd`, `minLevel`, `consoleOutput` | `logging.ts:118, 49, 55` | process; re-pointed per `session_start` (4458) |
| `REGISTRY_DIR`, `HEAD_STATE_DIR`, `OUTPUT_DIR` | `run-registry.ts:107`, `headstate.ts:76`, `transcript.ts:15` | process (redirectable for tests) |

---

## §2 Three candidate designs (plus the minimal and do-nothing baselines)

All three accept the same non-negotiables, which are enforced by executable rules (§2.5):
an extracted module **must not** import `index.ts` (P1c), **must not** import
`session-manager.ts` lifecycle mutators (P1b), and the import graph must stay acyclic.

### Design A — a full runtime context handed to module factories

**Mechanism.** `src/runtime.ts` exports `RuntimeContext` and `createRuntime(pi)`; the context
carries the three singletons *and* the two live slots: 
`{ pi, log, state, session(), setSession(ctx), bootNotice: {has, mark, reset}, terminal: {types, list, released} }`.
Every extracted section becomes a factory `createModeRunners(rt: RuntimeContext)` returning its
functions, so the per-call signatures stay 3-5 arguments (`(ctx, params, signal)`) exactly as
today — the closure simply moves from the factory body into each module's factory body.

- **Blast radius:** 7 bindings become context fields (5 of them mutable);
  1 new module (`runtime.ts`, ~80 lines) + 1 factory per section; **every** extracted section's
  signature is `(rt)`; `session()`/`setSession()` introduce a *temporal* contract the compiler
  cannot see (read before `session_start` ⇒ `undefined`), where today that slot is a local
  `let` whose only reader is a listener that cannot run before `session_start`.
- **Cost:** 6 factories × ~8 lines of boilerplate = ~50 lines of pure wiring; the mechanical
  move per stage is unchanged.
- **Failure mode:** **god object.** With 7 reachable fields, any module can read state it does
  not own; the closure's coupling is preserved verbatim under `rt.` prefixes, and the next
  refactor inherits the same 4,288-line problem spread across modules. The engineering bar's
  **I** (interface segregation) is violated at the one point that is hardest to unwind later.
- **Test seam:** best-in-class for unit tests (a plain object is a valid context), worst for
  reviewability (a new field is a silent new global).

### Design B — one runtime class with methods

**Mechanism.** `class SubagentRuntime { private pi; private state; runChainMode() {} … }`,
instantiated once in `initExtension`; `this` supplies the capture.

- **Blast radius:** if the class stays in `index.ts`, **nothing moves** — the file still holds
  every line, so this is a readability change only (1,194+ lines become methods). If the class
  is split per section (`class ModeRunners { constructor(rt) }`), it degenerates into Design A
  with `this` instead of a closure.
- **Cost:** **`erasableSyntaxOnly` forbids parameter properties** — probe P2: `TS1294`, so every
  class pays an explicit `private rt: Rt;` field plus a constructor assignment. Class syntax
  also loses the function-type inference the current `ReturnType<typeof …>` uses at 597/598.
- **Failure mode:** **detached methods.** Passing `rt.spawnBackgroundRun` as a callback (which
  the terminal notifier and `deps` structs do) silently drops `this` and throws at call time —
  a class of bug the closure design cannot have. Also invites an accidental public surface on
  the instance.
- **Test seam:** equal to A (construct with a fake rt), but methods bound to `this` are harder to
  stub per-test.

### Design C — per-module dependency structs, one shared three-field context (recommended)

**Mechanism.** Two distinct things, deliberately not one:

1. **`RuntimeContext` = exactly three fields**, all immutable, all process-lifetime, the three
   measured broadest (§1.2): `{ pi, log, state }` (`src/runtime.ts`, ~25 lines including the doc comment).
   `createRuntime(pi: ExtensionAPI): RuntimeContext` constructs `state` once — the same two lines
   that are at `index.ts:434,437` today.
2. **Capabilities are injected, never inherited.** Each extracted module exports
   `create<Section>(rt: RuntimeContext, deps?: <Section>Deps)` where `<Section>Deps` contains
   **only function fields that cross a module boundary** — e.g.
   `createTerminalNotifier(rt, { getSession, spawnBackgroundRun })`,
   `createBackgroundPipeline(rt, { spawnBackgroundSession, setAgentFinalOutput, extractFinalOutput })`.
   Data never travels in `deps`; it is already in `rt` or is a per-call parameter.

The slots stay where they are owned today: `sessionCtx` remains a `let` in `index.ts` (written by
the `session_start` handler there) and reaches the notifier as an injected `getSession` closure;
`recoveryNoticeDelivered` and the terminal-subscription trio move **into** their single owning
module as module-private state, because §1.2 measured them as two-section bindings.

- **Blast radius:** 1 new tiny module; per-stage moves are mechanical; **no** binding gains reach
  it did not have. `pi`/`log`/`state` stay exactly as visible as they are now.
- **Cost:** the 3-field literal repeats at ~6 factories (~6 lines total) and per call site
  `create<Section>(rt)` is one extra indirection in `index.ts`. Compiler-enforced: adding a
  shared slot later changes signatures, not silently.
- **Failure mode:** *scope creep of the struct.* The mitigation is a stated ADR rule: a fourth
  field requires naming the section that owns it and why the owner cannot hold it (§4, D2). If
  that rule is not enforced, C drifts into A over three PRs — and the drift is reviewable
  (one line in `runtime.ts`).
- **Test seam:** a section is unit-testable by constructing `createRuntime(fakePi)` and calling
  the factory — no `initExtension`, no `registerTool` capture, no `tool.execute("call-1", …)`.
  All 22 behavioral suites keep working through the default export, unchanged; only the six
  text readers move (§2.5(b)).

### Design D — minimal: extract only the *pure* seams (no context)

**Mechanism.** Move `displayTaskName` (597, pure) and `mergeSubTaskParams` (529–620, needs one
scalar: `state.config.maxThinkingLevel`) into `src/unit-params.ts` as plain functions taking
`(globalParams, subTask, maxThinkingLevel)`. index.ts loses ~100 lines and imports two functions.
- **Blast radius:** 1 new module, 1 test assertion re-pointed (`integration.test.ts:452` reads
  `index.ts` for `task: subTask.task || globalParams.task`), 1 new unit test for the moved pair.
- **Cost:** ~2 hours; no ADR needed for the mechanics, but it is the *first* stage of C anyway.
- **Failure mode:** it does not unlock anything structural — `delegate_task` still cannot move,
  because it needs `pi`/`log`/`state` everywhere (§1.2).
- **Test seam:** the two functions become directly testable (today they are reachable only by
  driving the whole extension).

### Design E — do nothing (baseline)

index.ts stays 4,720 lines / 4,288-line closure / 22 helpers; #430 stays blocked; the `execute`
stays at cx 116 / 72% coverage (ADR 0021 numbers). *Cost of nothing:* the complexity/CRAP finding
stays open, and every future change to `delegate_task` is reviewed inside a 1,123-line function.
No new risk is created — this is a legitimate choice if the cycle is dropped.

### §2.1 Comparison table

| | A: full context + factories | B: runtime class | **C: 3-field rt + injected capabilities** | D: pure helpers only | E: do nothing |
|---|---|---|---|---|---|
| mechanism | 1 context (7 fields incl. 5 mutable slots), 1 factory per section | 1 class (`this`) or per-section classes | 1 context (**3 immutable fields**) + function-only `deps` per module | plain functions, no context | — |
| blast radius | 7 bindings promoted; 6+ factories; temporal `session()` contract | 0 lines move (single class) or A-equivalent | per-stage only; 6 factories; `index.ts` keeps all slots it owns | 1 module, 1 test re-point | none |
| cost | ~50 lines wiring + review of every field | ~1 extra line per property (`TS1294`), `this` audit | ~6 lines of `create<Section>(rt)` calls | ~2h | 0 |
| risk if wrong | god object; coupling preserved with `rt.` prefixes | detached-`this` runtime throw; no file-size win | struct creep to A (reviewable, 1 line) | doesn't unlock #430 | status quo holds #430 shut |
| unlocks mode runners | yes | yes (only split form) | **yes** | no | no |
| unlocks #430 execute | yes | yes | **yes** | no | no |
| test seam | good (fake rt), poor reviewability | mediocre (`this`) | **good**: factory + fake rt, suites unchanged | narrow win | none |
| ADR needed | yes | yes | **yes** (§4) | no (stage 1 of C) | no |

### §2.2 Where the "20 parameters" would actually come from

The parameter count is a function of *what crosses the boundary*, and §1.2 measures it:

- A mode runner needs `pi`(4), `log`(9), `state`(17) and **three** shared helpers
  (`mergeSubTaskParams`, `applyUnitShapeGuard`, `resolveStepModel`). Threaded positionally that is
  4 + 3 = 7 arguments before the per-call `(ctx, params, signal)` — and 7 is already too many.
  Under **C** the helpers live in `unit-params.ts` / `mode-prologue.ts` and are *imported*, so the
  mode runner's signature is `(rt) + (ctx, params, signal, batchGuard)` — the same shape the
  existing 1877/2147/2498 helpers already use for `pi`.
- `delegate_task` needs `pi`, `log`, `state` plus **six** capabilities (three mode runners,
  fan-out, background spawn, `visibleRunsFor`). Threaded as parameters: 9. Threaded as a
  `deps` struct: 3 bundles (`runners`, `background`, `recovery`) — and that struct literal is
  the composition root's job, which is what `index.ts` is *for*.
- `spawnBackgroundRun` today already has **6 positional parameters**
  (`pi, ctx, retryParams, retryParams.task!, run, preamble` — call at 4658): the creep is
  measured, not hypothetical. C replaces the first with `rt` and folds the trailing two into one
  options object when it moves.

### §2.3 Lifetime notes that constrain the seam (design-assumptions checklist, partially)

1. **What state does the seam create?** Nothing new. `RuntimeContext` is a package over the two
   objects created at 434/437 today; no directory, no file, no environment variable.
2. **Who tears it down?** Nobody — it is an in-memory struct with the same lifetime as the
   factory invocation; `session_shutdown` (4526) keeps calling `cleanupSessionState(state)` and
   clearing the module-private latches of the extracted owners.
3. **Concurrency:** the context is created once, before any `pi.on` registration, and is never
   written after construction (all three fields `readonly`). The one concurrency hazard the
   closure has *today* — two `session_start`s racing the boot scan — is unchanged by the seam.
4. **Missing/partial state:** `sessionCtx` is `undefined` before `session_start` (4442/4692);
   the seam keeps that as an owned-slot invariant with one reader (`deliverCompletionAlert`),
   rather than promoting it into a context field that any module could read stale.
5. **Evidence:** §0. Every numeric claim in §1/§2 is a command output; the two behavioural claims
   about the import graph are probe P1b/P1c, not code reading.

### §2.5 Blast radius that has nothing to do with the context: the ratchets

Extraction in this repository is *pinned by source text*, and that — not the context design — is
the real cost. Measured, exact:

**(a) Executable import-graph rules (`src/__tests__/architecture-rules.test.ts`, 11 tests, all
passing at baseline in the /tmp copy):**

| rule (line) | what it forbids | how extraction can trip it |
|---|---|---|
| `no runtime import cycles` (181) | value-import cycles | none, if extracted modules never import `index.ts` |
| `the entry point is not a library` (212) | any non-test module importing `index.ts` | **P1c fires**: "probe-back.ts → ./index" |
| `non-entry modules take only the reader API from session-manager` (263) | `spawnBackgroundSession`, `setAgentFinalOutput`, `extractAgent…`, `markAgentInterrupted`, `updateAgentStatus`, `pruneBackgroundSession`, `stopAgent`, `steerAgent`, `retainedSessionPointer`, `resolveAgentId`, `findRetryLineage`… | **P1b fires**: "probe-bg.ts → session-manager.spawnBackgroundSession". Allow-list is `{getAgent, listAgents}`. Fix: inject them (§3, S3), or extend the allow-list with a recorded decision |
| `every bare specifier is a builtin or peerDependency` (250) | new deps | not touched |
| `process execution confined to runner.ts/git.ts` (243) | — | not touched |
| `raw console calls confined to logging.ts` (278) | — | new modules must use `log` (which the context supplies) |
| `dispatch carries typed values, not anonymous object-literal casts` (304) | `as {` in **`index.ts`** (0 today); exactly **1** `resolveRetryParams(...) as DelegateTaskParams`, at **2954** | **S5 breaks it**: the cast is at 2954, inside the `delegate_task` body, so moving that body to `delegate-handler.ts` makes `retryAssignments`/`namedCasts` 0 in `index.ts` → both pins must move to the new module in the same commit (or the rule is re-anchored per-file) |
| `the per-unit pre-pass is one helper, called by each batch handler` (338) | exactly 3 `validateUnitPrePass({` in `index.ts`, positioned relative to `async function runChainMode(` / `runParallelMode` / `runGraphMode` **in that file** | **P1a fires on the first move of a mode runner**: "runChainMode must exist in src/index.ts". Must be re-anchored to the new module(s) in the same commit |

**(b) Source-text ratchets on `src/index.ts` — six suites read the file (exact sites):**

| suite:line | what it reads from index.ts | breaks when |
|---|---|---|
| `agent-guidance.test.ts:24` | `"do not poll"`, `"wake the conductor with a structured completion message"`, `"completionNotify"`, `"polling is only correct"`, `'pkgPath("AGENT.md")'`, `"${agentMdPath}"`, absence of `extensions/brl-subagent/AGENT.md` | S5 (registration moves) |
| `conductor-guardrails.test.ts:15` | 8+ literal strings of `promptGuidelines` / `description` (`"## Conductor Guardrails"`, `"gitMode='branch'"`, …) | S5 |
| `readme-commands.test.ts:25,53` | parses the `const handlers: Record<string…>` block (the `/brl-subagent` dispatch map) and compares it to the README table | S5 (and only S5) |
| `status-chokepoint.test.ts:94` | index.ts must contain `repaintStatus(` and must not contain `updateStatus`/`updateProgressStatus` | only if `index.ts` loses **every** `repaintStatus` call — **10 call sites today** (458, 478, 829, 2356, 2389, 2429, 2437, 2441, 2453, 4522); **9 are outside the mode runners**, and 4522 (`session_start`) is not scheduled to move at all, so S2–S5 are safe |
| `integration.test.ts:452` | regex `task:\s*subTask\.task \|\| globalParams\.task` inside index.ts for `mergeSubTaskParams` | S1 (first move) |
| `architecture-rules.test.ts:311,345` | see (a) | S2 (`:345`), S5 (`:311`) |

**(c) Coverage-floor suites** — `project-flags:217` and `runtime-vocabulary:222` only require
`src/index.ts` to remain *in the scanned file set* (existence, not content), and
`logical-runs-453:306` asserts an *absence* (`getRunEntries(`). `prose-duplication.test.ts:208`
requires at least one shipped string literal ≥ `MIN_LENGTH = 80` chars (after whitespace
normalisation, substitutions flattened to one placeholder char) to still live in `src/index.ts`,
as a vacuity floor.

*Checked rather than assumed:* the closure is not where that floor lives. index.ts carries
**seven module-level helpers above the default export** (lines 186–430: `buildInventorySummary`,
`formatTemplateSummaryItem`, `buildTemplateGuideline`, `cleanupSessionState`,
`buildRetryResumePreamble`, `graphTaskToSubTaskParams`, `toSubTaskResult`), and
`buildTemplateGuideline` (226–228) returns a ~184-char static template that no stage in §3.3
moves. So the floor stays green through S6. It becomes a hazard only if a stage also moves those
top-level helpers (a reasonable S1b, since `cleanupSessionState` is imported by
`footer-activity.test.ts:32`); in that case the floor must be re-pointed at the modules that now
carry the prose — named in the PR body, not silently relaxed.

**(d) Docs guards:** `scripts/docs-arch.mjs` requires a first-line `// Purpose:` in every new
`src/*.ts` and regenerates the module map (48 modules today → 49+ after `runtime.ts`); 
`scripts/docs-decisions.mjs` regenerates the ADR index (26 → 27). Both are drift tests; both must
run in the moving PR.

**(e) 24 test files import `src/index.ts`:** **22** import only the default export
(`initExtension`), **1** (`footer-activity.test.ts:32`) imports `cleanupSessionState`, and
`agent-guidance.test.ts:4-9` imports the three exported builders. **None of them construct any
internal helper.** Consequence: the entire behavioral suite is *already* written against the
public seam (`initExtension(fakePi)` → captured `registerTool` entry → `execute(...)` with a fake
`ctx`), so it is invariant under every design in §2. "22 test files import only the default
export" is therefore not a constraint on the design — it is the sentence that proves the
extraction is test-safe. The seats that must change are the six text readers in (b).

---

## §3 Recommendation

**Design C: a three-field immutable `RuntimeContext` (`pi`, `log`, `state`) created once in
`initExtension`, plus function-only dependency structs for the capabilities that cross a module
boundary.** Ship it as the first line of an ADR (§4), then extract in the five stages below; #430
is stage 6 and only needs the two seams the earlier stages expose.

**The recommendation in ten lines**

1. Extract nothing before #476 lands — every extracted file otherwise inherits the duplicate-import drift.
2. Create `src/runtime.ts` with one thing: `RuntimeContext = { pi, log, state }`, all `readonly`, built by `createRuntime(pi)`.
3. Never add a fourth field without naming the section that owns it and why the owner cannot hold it (ADR D2).
4. Everything else crosses a boundary as an **injected function**, never as inherited data — that is what keeps probe P1b/P1c green.
5. Keep `sessionCtx`, `recoveryNoticeDelivered` and the terminal-subscription trio where they are owned today (index.ts); two of them move into their single owning module when that module is extracted.
6. Move pure helpers first (S1) — it is the cheapest possible test of the ratchet re-pointing ritual.
7. Then mode runners (S2), which is the first real consumer of the context and the first re-anchor of the `#379` positional pin.
8. Then background pipeline (S3) — the stage where the `session-manager` reader-API rule forces the injection decision, so decide it there and record it.
9. Then boot recovery + terminal notifier (S4), then registrations (S5) — S5 is a text-ratchet move, not a design move.
10. Only then #430 (S6), inside the already-extracted handler module, where its complexity is countable without a 1,123-line file in the way.

### §3.1 Why C and not A

A is the design that *looks* tidiest and fails the bar's **I**. The measurement that decides it is
§1.2: three bindings are broad, five are two-section bindings, and only three of the sixteen
rows (all small) read a single one. A context big enough to
carry all seven hands every module reach it does not need, and the closure's coupling is renamed
rather than removed. C keeps the same ergonomics where it matters (no 20-parameter functions,
per-call signatures unchanged) and pays one 3-field literal per module for it.

C also subsumes D (S1) and E is rejected on the ADR 0021 finding: the `execute` is the
largest, most change-prone function in the tree and stays that way for free if the cycle is
dropped.

### §3.2 Falsifiers — evidence that would change this recommendation

| # | falsifier | where it would show up | what it would mean |
|---|---|---|---|
| F1 | A section needs a **fourth** shared mutable slot during S2–S4 (e.g. mode runners genuinely need `sessionCtx`) | a proposed 4th field in `runtime.ts` | the 3-field split is wrong; re-open A vs C with that section's numbers |
| F2 | Extracting the background pipeline needs **>4** injected session-manager mutators, making `BackgroundDeps` a second god object | S3 PR body | switch the rule instead: extend `SESSION_MANAGER_READER_API` with a recorded decision (the rule's own message asks for that) |
| F3 | The S1 diff is **not** mechanical (`git diff -U0` shows changed behaviour lines, not moves) | S1 PR | hidden coupling not in §1 — go back to the inventory before S2 |
| F4 | Any stage's suite stays **green when the extracted call is deleted** (vacuous pin) | the deletion proof in each PR | the seam is not pinned; add the killer before merge (the #465/#466 lesson: "a claim with no killer drifts") |
| F5 | The three-field literal turns out to be threaded through ≥10 call sites per module (i.e. it is passed *down* repeatedly instead of once into a factory) | S2 PR size | the factory form was chosen wrongly; switch that module to a class (B) or pass `rt` once at construction — do not add fields |
| F6 | Maintainer prefers a single-file readability win over extraction | this doc | B-in-one-file is the honest alternative: methods, no moves, no ratchets touched |

### §3.3 Staged extraction order (the cycle plan, with the ratchet work made explicit)

Each stage is its own PR (C1 for S2–S3, C2 for S1/S4–S5), each with a deletion proof and
`git diff -U0` reviewed for "moves only".

| stage | what moves | lines | new module(s) | ratchets to re-point in the same commit | new pin |
|---|---|---:|---|---|---|
| **S0** | nothing — #476 (import normalisation) lands first | — | — | — | `check-imports` |
| **S1** | `displayTaskName` (597), `mergeSubTaskParams` (529–620) | ~100 | `unit-params.ts` | `integration.test.ts:452` (regex → new file) | direct unit test of `mergeSubTaskParams(…, maxThinkingLevel)` incl. the `edit ⇒ write` rule |
| **S2** | `runChainMode` (673), `runParallelMode` (1073), `runGraphMode` (1433) **plus the two guards they share** — `resolveStepModel` (501, 28 lines) and `applyUnitShapeGuard` (621, 52 lines) — because the fan-out (S3) needs the same two, so they must land before it | ~1,266 | `mode-runners.ts` (+ `runtime.ts` if not already) | `architecture-rules:345` (`runChainMode` must exist *in index.ts*), `:304` caret if any `as {` moves; `status-chokepoint:94` stays green (9 `repaintStatus` calls outside the runners) | one test that each runner calls `validateUnitPrePass` from the new module; boundary test that the factory needs only `rt` |
| **S3** | `runBackgroundFanOut` (1876), `startBackgroundAgent` (2146), `spawnBackgroundRun` (2497) | ~825 | `background-pipeline.ts` | none text-based today | **decision point**: inject `spawnBackgroundSession`/`setAgentFinalOutput`/`extractFinalOutput` via `deps` (probe P1b shows the alternative fails); pin with a fake-deps unit test of `startBackgroundAgent`'s `tailFailures` containment (#439) |
| **S4** | boot cluster `performBootRecovery`/`headStateDeps`/`reconcileHeadStatesAtBoot`/`maybeSendHeadStateNotice`/`visibleRunsFor`/`maybeSendRecoveryNotice`/`abandonProductionRun` (4253–4452) **and** the terminal notifier + `releaseTerminalSubscriptions` + `scheduleTransportRetry` + `deliverCompletionAlert` (4574–4720) | ~347 | `boot-recovery.ts`, `terminal-notifier.ts` | none text-based (`logical-runs-453:306` stays green — it asserts *absence* in index.ts) | notifier takes `{ getSession, spawnBackgroundRun }` (the one back-edge) — pin the release idempotence with a second `release()` call |
| **S5** | `/brl-subagent` handlers (2705–2756), `delegate_task` (2782–3970), `get_subagent_result` (3975–4142), `steer_subagent` (4148–4199), `stop_subagent` (4200–4248) | ~1,510 | `commands.ts`, `delegate-handler.ts`, `agent-tools.ts` | `agent-guidance:24`, `conductor-guardrails:15`, `readme-commands:25,53`, and `architecture-rules:304` (retry cast) — **one commit, all four**, or the suite reddens in four places at once. (§2.5(c): `prose-duplication:208` stays green — the surviving `buildTemplateGuideline` literal holds the floor.) | the suites keep driving `initExtension` — they are the pin; add one direct test of the handler factory with fake `deps` bundles |
| **S6** | inside `delegate-handler.ts`: #430's seams (arg validation/params resolution, pre-flight + capability, shape selection, run-record creation, completion/wake) | 1,123 → target <30 cx | (splits inside the module) | none remaining in index.ts | per-seam unit tests as #430 requires |

**Where #474 (the connection-drop ×3) fits:** outside this order, and it is not a dependency of
any stage. The cycle line puts it before #430; it touches the background run-record / failure
path that S3 moves, so the cheapest sequencing is `S0 → ADR → S1 → S2 → #474 → S3 → S4 → S5 →
S6` *or* #474 first — either way it must not be rebased across S3's 825-line move.

Per-stage notes that are easy to get wrong:

- **S2 must move `applyUnitShapeGuard` and `resolveStepModel` with the runners**, not after them:
  §1.4 shows the fan-out (S3) calls both, so leaving them in `index.ts` would force S3's module to
  import from `index.ts` — which probe P1c forbids. They are 52 + 28 lines and need only `pi` +
  `log` (+ `displayTaskName`, which S1 already moved).
- **S3 retires the `resolveSubagentModel` wrapper** (491–497): it exists only to keep a call shape
  (`ctx, preset, perCallModel`) around `prelude.ts`'s `resolveSubagentModelPrecedence({state, ctx,
  log, …})`. Once the callers are in modules that already hold `rt`, they call the prelude
  function directly and the wrapper is deleted (3 call sites: 1900, 2546, 3353).
- **S4's terminal notifier is the only module that needs two injected capabilities** (`getSession`,
  `spawnBackgroundRun`); everything else it needs is in `rt` or imported.

Expected `index.ts` after S5: **~400–600 lines** (estimate, not measured: 185 import lines +
~37 of surviving helpers `applyConfig` 9 / `resetState` 28 + 102 session handlers + the `pi`
surface and the `deps` assembly; `resolveSubagentModel` 10 is retired at S3 and
`applyUnitShapeGuard`/`resolveStepModel` leave at S2). S6 does not touch it at all.

### §3.4 Conductor-ready execution sketch (what an implementer spec must cover, in order)

1. **State the invariant first.** "No behaviour change; the suite is the pin; `git diff -U0`
   contains moves + ratchet re-points only." Name the stage.
2. **Create `runtime.ts` before the first move** (S2): the interface, `createRuntime(pi)`, and
   `index.ts:434,437` rewritten as `const rt = createRuntime(pi)` with local aliases
   (`const { log, state } = rt`) so the 120/172 read sites do not change in the same commit.
   That alias line is the whole mechanical trick — it keeps the first extraction's diff small.
3. **Move, do not rewrite.** Section out verbatim into `create<Section>(rt, deps)` returning the
   functions index.ts used to call by name. Any line that changes shape gets named in the PR body.
4. **Re-point the ratchets in the same commit**, with the new anchor quoted in the PR body
   (`architecture-rules.test.ts:345` for S2, `:304` + the three literal suites for S5, `:452`
   for S1).
5. **Deletion proof per moved seam**: delete the call site (or the exported function's body) and
   show the suite reddens; restore. Explicitly required — S1/S4 have no other killer.
6. **Design assumptions block** in the PR body: §2.3 answers, updated with anything the stage
   learned (state created = none; teardown = unchanged; concurrency = context is write-once).
7. **Gates as usual**: `npx vitest run`, `npx tsc --noEmit`, `node scripts/docs-arch.mjs`,
   `node scripts/docs-decisions.mjs`, `git diff --check`; plus `npm run docs:arch --write` in
   the moving PR (48 → 49+ modules).
8. **Record the seam decision once** (§4 ADR) and let each stage cite it — do not re-litigate the
   context per PR.

### §3.5 What must stay in `index.ts` (the composition root, explicitly)

- `export default function (pi: ExtensionAPI)` and its `createRuntime(pi)`.
- The seven `pi` surface calls (`registerCommand` 2705, `registerTool` ×4, `on` ×2) and the
  `deps` literals that assemble sections — this is the one place allowed to know every section.
- `sessionCtx` (owned `let`), `setLogCwd(ctx.cwd)`, preset/template loading and
  `validateTemplatePresetRefs`, `state.restoreFromSession`, `cleanupSessionState(state)`,
  `reapActiveChildren(log)`.
- `resetState` (28) and `applyConfig` (9) *unless* S5 absorbs them into `commands.ts`; either way
  their `repaintStatus` calls are what keeps `status-chokepoint:94` honest if the session handlers
  ever move too.

---

## §4 ADR skeleton for the maintainer record

Target file: `.development/decisions/0027-runtime-context-for-index-extraction.md`
(next free number — 0026 is current; the index is generated by `npm run docs:decisions`).

```markdown
# 0027. A three-field runtime context, and injected capabilities, as the seam that lets `index.ts` give up its sections

- **Status:** Proposed (accept when S2 lands; until then this is the design record, not a
  committed shape)
- **Date:** <date of decision>
- **Issues:** #430 (first consumer), #476 (prerequisite), the 2026-11-08 Track B theme
- **Supersedes:** nothing. Extends ADR 0021 (no complexity gate; targeted follow-ups) with the
  one structural seam the targeted follow-up needs.

## Context

`src/index.ts` is 4,720 lines; `export default function (pi: ExtensionAPI)` at line 433 opens a
**4,288-line closure with 22 nested functions**, carrying the `delegate_task` handler
(1,123 lines, cx 116 / 72% coverage — ADR 0021's finding, still open as #430) plus four other
handlers, three mode runners, a background pipeline, boot recovery and the terminal notifier.

Measured (this cycle's investigation, `/tmp/brl-composition-root-proposal.md` §1):

- the closure captures **seven** bindings: `pi` (47 code sites), `log` (120), `state` (172),
  `sessionCtx` (write 4455, read 4692), `recoveryNoticeDelivered` (4400/4401/4552),
  `displayTaskName` (5 reads), and the terminal-subscription trio (4574–4610);
- three are broad (10 of the 16 sections read all three, and every section that moves 200+
  lines is among them); the other four are read by one or two sections and can be owned
  privately by the module that absorbs them;
- the 22 helpers form a shallow DAG with exactly **one** backward edge
  (`terminal notifier → scheduleTransportRetry → spawnBackgroundRun`);
- `pi`, `log`, `state` are already threaded as explicit parameters into three of the helpers
  (`index.ts:1877, 2147, 2498`) and into `SessionState` at 14 sites — so the codebase has already
  chosen "explicit deps" as its direction; what it lacks is a *named container* and a rule for
  what may go in it.

Two executable rules decide the design space, and both were executed against a byte copy of the
tree (`/tmp/probe-arch`, baseline 11/11 green):

- a non-entry module that imports `index.ts` fails "the entry point is not a library"
  (`architecture-rules.test.ts:212`);
- a non-entry module that imports `spawnBackgroundSession` (or any session-manager lifecycle
  mutator) fails "non-entry modules take only the reader API from session-manager"
  (`:263`) — the allow-list is `{getAgent, listAgents}`.

Therefore a seam cannot be "the closure, moved": any capability that crosses a module boundary
must be **injected**, and any data that crosses must be **read-only**.

## Decision

**D1 — the context is exactly three immutable fields.** `src/runtime.ts` exports
`RuntimeContext { readonly pi; readonly log; readonly state }` and `createRuntime(pi)`, which
constructs the `SessionState` that `index.ts:437` constructs today. `index.ts` keeps local
aliases so the 120/172 existing read sites do not change.

**D2 — a fourth field needs an argument, in the ADR.** A proposal to add one must name the
section that owns the value and why that section cannot hold it privately. The five remaining
captured bindings stay where they are owned: `sessionCtx` stays a `let` in `index.ts` and reaches
the terminal notifier as `getSession`; `recoveryNoticeDelivered` and the terminal-subscription
trio move into their single owning module.

**D3 — capabilities are injected, never inherited.** Every extracted module is
`create<Section>(rt, deps?)` where `deps` holds **only function fields** (e.g.
`{ spawnBackgroundSession, setAgentFinalOutput, extractFinalOutput }`,
`{ getSession, spawnBackgroundRun }`). No data in `deps`. This is what keeps D1 possible and
keeps `architecture-rules.ts:263` honest instead of allow-listed.

**D4 — the composition root stays in `index.ts`.** The default export, the seven `pi` surface
calls, the session-lifecycle handlers, and the `deps` literals that assemble the sections are the
composition root and are the last thing to move — if ever. `index.ts` may not be emptied:
`prose-duplication:208` needs at least one ≥80-char shipped literal there (today supplied by the
module-level `buildTemplateGuideline`, 226–228), and `project-flags:217` / `runtime-vocabulary:222`
/ `logical-runs-453:306` need the file to remain a scanned module.

**D5 — extraction is staged, one PR per stage, with a deletion proof.** S1 pure helpers →
S2 mode runners → S3 background pipeline → S4 boot recovery + terminal notifier →
S5 registrations → S6 #430's `execute` seams. Each stage re-points the source-text ratchets it
touches **in its own commit**, and each seam carries a killer (delete it, watch the suite
redden) — the #465/#466 lesson, applied to structure rather than behaviour.

## Consequences

- `index.ts` shrinks from a 4,288-line closure to an estimated ~450–700 lines by S5, and
  `delegate_task`'s complexity becomes countable inside a 1,123-line module instead of a
  4,288-line closure.
- Six factories exist where one closure did; each names its dependencies, so a new dependency is
  a compile error at the factory, not a silent capture.
- Sections become unit-testable without booting the extension (`createRuntime(fakePi)`), which
  the 22 behavioral suites do not need but #430's seams do.
- The cost lands on six test suites that read `src/index.ts` as text
  (`agent-guidance:24`, `conductor-guardrails:15`, `readme-commands:25`, `status-chokepoint:94`,
  `integration:452`, `architecture-rules:311,345`). Each stage pays its own re-point.
- **Limit:** the context makes the *data* seam explicit; it does not make cross-module *control*
  flow obvious. The one backward edge (notifier → background spawn) remains a runtime callback,
  invisible to the compiler. That is stated, not solved.
- **Limit:** process-global state (`session-manager.agents`, `event-bus.listeners`,
  `runner.activeChildren`, `notify-completion.terminalClaims`, `logging.logCwd`) is deliberately
  out of scope. It outlives the context, and moving it would misstate its lifetime.

## Alternatives rejected

- **A full runtime context carrying all seven bindings** (`session()`/`setSession()`,
  `bootNotice`, `terminal`). Ergonomic, but promotes five two-section bindings to process-wide
  reach and replaces one closure with six closures over a god object; violates interface
  segregation at the hardest point to unwind.
- **One runtime class with methods.** `erasableSyntaxOnly` forbids parameter properties
  (measured: `error TS1294`), so every property is spelled out; kept in one file it moves no
  lines at all, and split per section it is the factory design with a detached-`this` hazard
  (`deps.spawn = rt.spawnBackgroundRun`).
- **Per-module structs with no shared container** (each function takes `{pi, log, state, …}`).
  Correct in principle, and what S1 does; rejected as the *whole* design because §1.2 measures
  all three in 10 of 16 sections and in every section that moves 200+ lines, so the same
  three-field preamble would repeat in every signature and every hop.
- **Extend `SESSION_MANAGER_READER_API`** instead of injecting the spawn/steer/stop mutators.
  Cheaper for S3, but the rule exists because lifecycle mutators belong to the entry point;
  allow-listing them would let three modules silently race the agent store. Injection keeps the
  rule's meaning.
- **Move the terminal notifier first** (it looks leaf-shaped). Rejected: it holds the one
  backward edge, so moving it first forces the injection decision before the pipeline it calls
  exists.
- **A whole-file formatter or a complexity gate.** Already rejected in ADR 0021 and #476; nothing
  here reopens it.

## Open questions for the maintainer

1. Is S2 the right first structural stage, or should S1 + a one-file class conversion (B, no
   moves) come first to prove the review ritual?
2. Does #430 stay a single issue after S5 (the `execute` is then inside `delegate-handler.ts`),
   or is it re-scoped as S6-only?
3. Who owns the ADR acceptance: the conductor (autonomous mode for this cycle) or the maintainer?
```

# Mode prologue + per-unit pre-pass — design note (issue #379)

Date: 2026-10-25 · jev: high (0.92) · risk **C2** (C1 if any gate order moves) · worktree `refactor/dedupe-mode-prologue-379`
Issue: [#379](https://github.com/azmeenafandi/brl-subagent/issues/379) — U5, the last unit of the duplication sweep [#374](https://github.com/azmeenafandi/brl-subagent/issues/374)
Source: `.development/investigations/smell-audit-2026-10-25.md` §2.1 (D1, D2) · **design only — no source change in this PR**

---

## Summary (one screen)

**Recommendation: design C-refined, landed as four commits, with "A-strengthened" as commit 1.**
Not B (a single skeleton over all six prologue sites), and not A alone (it leaves ~310 lines of
prologue duplicated and D2 untouched).

Six findings changed the shape of the answer:

1. **The repetition is larger than the issue states — and already divergent.** There are **six**
   prologue sites, not three: `runChainMode` (`index.ts:530-638`), `runParallelMode`
   (`1044-1138`), `runGraphMode` (`1525-1635`), `runBackgroundFanOut` (`2075-2197`),
   `spawnBackgroundRun` (`2617-2685`), and the single-task foreground path inside `execute`
   (`3167-3310`). Four share the full sequence `cost → depth → resolve → targets → preflight → H1`;
   the two background sites run a **different sequence** (no depth gate, no preflight, and in
   `spawnBackgroundRun` the cost gate runs *after* resolve+model+approval).
2. **The 13-field cast has already drifted: 4 sites, 3 variants, all compiler-unchecked.**
   `:564`, `:1078` and `:2088` spell 13 fields; `:1559` (graph) spells **14** (it adds
   `approvalMode`). jscpd flags the graph copy as a clone of `resolveSubagentParams`'s *own*
   parameter type (`index.ts:1559-1573 ↔ params.ts:184-198`) — the literal duplicates a
   declaration the compiler already owns.
3. **The `renderCall` copy is not "the cast plus a missing field" — it is a hand-narrowed 11-key
   subset of a 25-key schema**, while the SDK hands `renderCall` the exact `Static<TParams>`
   (`@earendil-works/pi-coding-agent/dist/core/extensions/types.d.ts:516`). The fix is to delete
   the literal and use `DelegateTaskParams`, not to add `preset?: string` to it.
4. **The cast is not gratuitous — it exists for one field.** Probe (appendix A): passing `params`
   without the cast fails with `TS2345`, and the *only* incompatibility is `task?: string`
   (`DelegateTaskParams`, schema-derived) vs `task: string` (`resolveSubagentParams`). Widening the
   resolver to `task?: string` + `task: params.task ?? ""` deletes all four casts and is provably
   neutral: all three readers of that field are falsy-tolerant (`mergeSubTaskParams`
   `subTask.task || globalParams.task` at `:486`; `validatePreTask`'s `config.task || ''` at
   `validate.ts:296`; `classifyTask`'s `if (!task …)` at `router.ts:128`).
5. **D2 is invisible to jscpd at the sweep's threshold.** The current baseline (appendix B) is
   **9 clones / 270 duplicated lines at 10L/70t, and all nine are D1 fragments**. The per-unit
   pre-pass only surfaces at 8L/50t, and then only its warning-collection tail. So the acceptance
   line "jscpd re-run shows D1/D2 gone" can be met for D1 (→ 0 clones) and **cannot** be met for D2
   by the detector; D2 needs a structural guard.
6. **The gate order is not pinned by any test that drives the real handler** — the depth gate is
   covered only by a logic replica (`integration.test.ts:1281-1317`), and no test asserts which
   gate wins when two trip at once. That gap, not the duplication, is the actual risk of this unit.

**Smallest safe first step:** commit 1 only — the typed resolver input (`params.ts`), the four
casts deleted, `renderCall`/`renderDelegateCall` typed from `DelegateTaskParams`, no other change.
`tsc --noEmit` plus the existing suite is the whole proof; zero behaviour delta except the `""`
normalisation in finding 4. Everything else waits for the gate-order pins of commit 2.

---

## 1. Method

Read in full: the six prologue sites and their tails, `src/prelude.ts` (the #201 extraction of the
individual gates), `src/params.ts` (`resolveSubagentParams` + its declared input type),
`src/schema.ts:54-260`, `src/types.ts` (`ResolvedParams`, `SnapshotParams`,
`DelegateTaskParams`), `.development/ARCHITECTURE.md` (dispatch pipeline + module map), and the
nine suites that touch these paths.

Measured, not assumed:

- **jscpd re-run at the sweep's setting** on this worktree (after #376-#381 merged): 41 files,
  21,232 lines, **9 clones / 270 duplicated lines / 1.27 %** — the audit's 28 fragments are down to
  9, and all 9 are D1 (appendix B).
- **jscpd at 8L/50t**, scoped to `src/index.ts`, to locate D2: 15 clones; the per-unit pre-pass
  appears only as an 11-13 line warning-collection tail (`667-677 ↔ 1170-1180`,
  `1168-1180 ↔ 2181-2193`).
- **A throwaway `tsc` probe** (appendix A) to establish exactly why the casts exist. The probe file
  was deleted; `git status` clean.

Everything below cites current line numbers in this worktree.

## 2. What is actually duplicated (corrected inventory)

### 2.1 Prologue sites — six, in two classes

| # | Site | Range | Sequence (line order) | Class |
|---|---|---|---|---|
| 1 | `runChainMode` | `530-638` (109 L) | cost `531` → depth `541` → resolve `563`(cast) → `validateCwd` `585` → preflight `598` → H1 `620` (inline `validatePreTask`) | batch |
| 2 | `runParallelMode` | `1044-1138` (95 L) | cost `1045` → depth `1055` → resolve `1077`(cast) → `validateDelegationTargets` `1099` (no outputFile) → preflight `1104` → H1 `1127` (`runPreTaskValidation`) | batch |
| 3 | `runGraphMode` | `1525-1635` (111 L) | **`validateGraph` `1511` first** → cost `1526` → depth `1536` → resolve `1558`(cast, 14 fields) → `validateCwd` `1581` → preflight `1594` → H1 `1617` (inline) | batch |
| 4 | `runBackgroundFanOut` | `2075-2197` (123 L) | cost `2077` → resolve `2087`(cast) → model `2109` → approval `2120` → `writes` warn `2124` → gitMode-branch reject `2136` | background |
| 5 | `spawnBackgroundRun` | `2617-2685` (69 L) | resolve `2617` (**spread, no cast**) → model `2623` → approval `2632` → `writes` warn → **cost `2645`** → `validateDelegationTargets` `2657` → H1 `2668` | background |
| 6 | `execute` single foreground | `3167-3310` (144 L) | cost `3169` → depth `3181` → resolve `3217` (**spread, no cast**) → `validateCwd` `3220` → `validateOutputFile` `3233` (inline) → preflight `3247` → H1 `3259` (with `force`) | single |

Sites 1-3 plus 6 are the same six-gate sequence in the same order, ~110 lines each. Sites 4-5 are a
**different** sequence: no depth gate, no preflight, an approval gate that exists nowhere in the
foreground batch paths, and (site 5) the cost gate *after* resolve/model/approval.

### 2.2 The cast literal — 4 sites, 3 variants, plus a narrowed renderer type

| Site | Fields | Note |
|---|---|---|
| `index.ts:564` (chain) | 13 | no `approvalMode` |
| `index.ts:1078` (parallel) | 13 | no `approvalMode` |
| `index.ts:1559` (graph) | **14** | adds `approvalMode` — already drifted from its siblings |
| `index.ts:2088` (fan-out) | 13 | no `approvalMode` |
| `params.ts:184-198` | 16 | the resolver's *own* input type — jscpd flags `1559 ↔ 184` as a clone |
| `index.ts:3853-3864` (`renderCall`) | 11 | a hand-narrowed subset: no `preset`, `gitMode`, `approvalMode`, `model`, `priority`, `background`, `chain`, `tasks`, `graph` |
| `tui.ts:3060-3076` (`renderDelegateCall`) | 14 | the renderer's own copy — *includes* `chain`/`tasks`/`graph`, which the `renderCall` copy omits |

Because `params as X` is erased at runtime, **no field is dropped on dispatch** from any of the four
casts — they are pure type claims. The real defect surface is the two renderer literals:

- `renderCall`'s declared args cannot read `preset` (or `chain`/`tasks`/`graph`/`model`/`priority`)
  without a type error, so the call preview cannot evolve to show them;
- the value it forwards *does* carry `chain`/`tasks`/`graph` at runtime, which is why chain/parallel/
  graph previews work today even though `renderCall`'s type says those keys do not exist. The two
  hand-maintained literals disagree, and only the runtime coincidence keeps previews correct;
- the SDK already supplies the right type: `renderCall?: (args: Static<TParams>, theme, context)`
  (`pi-coding-agent/dist/core/extensions/types.d.ts:516`). The 11-field literal is a *narrowing* of
  a type we were handed.

### 2.3 Verbatim multi-copy rejection blocks inside the prologues

Not in the audit's cluster list, but the same class and the same fix boundary:

| Block | Copies | Lines |
|---|---|---|
| depth rejection (`Cannot delegate further: subagent recursion depth limit reached …`) | **4** | `552`, `1066`, `1547`, `3192` |
| empty-model rejection (`Subagent model is not configured. …`) | **4** | `694`, `1197`, `1650`, `3300` |
| preflight rejection (`Pre-flight check failed: …`) | **4** | `605`, `1111`, `1601`, `3251` |
| circuit check (`circuitCheck.isOpen`) | **3** prologues + 1 late | `705`, `1208`, `1661`, `3440` |
| `resolveSubagentModel(ctx, globalParams.resolvedPreset, params.model as string \| undefined)` | 3 | `682`, `1185`, `1638` |

### 2.4 D2 — the per-unit pre-pass, four copies

| # | Site | Range | Prefix | Collection | Label / logContext | Extra |
|---|---|---|---|---|---|---|
| 1 | chain | `640-679` | `Step ${i+1} ("…")` | `stepCwds: string[]` | `Chain` / `{step: i+1}` | — |
| 2 | parallel | `1140-1182` | `Task ${i+1} ("…")` | `taskCwds: string[]` | `Parallel` / `{task: i+1}` | — |
| 3 | graph | `1692-1743` | `Node "${id}"` | `nodeCwds: Map` | `Graph` / `{id}` | strips `{placeholder}` tokens before H1 for **every** node |
| 4 | fan-out | `2152-2197` | `Task ${i+1} ("…")` | `fanOutTasks: FanOutTask[]` | `Background fan-out` / `{task: i+1}` | also resolves the per-unit **model** |

The body of each is the same five steps (`mergeSubTaskParams` → `validateDelegationTargets` →
`runPreTaskValidation` → collect `${prefix}: ${w}` → push cwd), ~30 lines ×4.

## 3. Invariants that must survive (the refactor's actual contract)

> Read this as the test list. Each item names where it is true today and what would look like a regression.

**IN1 — Cost gate is the first gate of the batch paths, and it is *not* first in `spawnBackgroundRun`.**
`531`/`1045`/`1526`/`2077`/`3169` run cost first; `2645` runs it after resolve (2617), model (2623)
and the approval gate (2632). A "unified" skeleton that hoists cost would change what a caller sees
when a background single dispatch is over budget **and** `approvalMode: 'always'`
(pre-fix: the approval rejection; post-fix: the cost rejection).

**IN2 — The cost estimate is `perTaskCostEstimate(>0 ? : 0.05) × units`**, with `units = length` of
the unit list for chain/parallel/graph/fan-out and `1` for both single paths (`gateSessionCost`'s own
contract, `prelude.ts:62-97`). Site 3 passes `graphTasks.length` (`1526-1531`), which is the *declared*
node count — not the wave count.

**IN3 — Depth gate sits between cost and resolve (4 sites), and is absent from both background paths.**
`541`, `1055`, `1536`, `3181`; nothing at `2075-2197` or `2617-2685`. This asymmetry is real, not an
oversight in the reading: `DEPTH_ENV_KEY` is stamped only by the foreground subprocess runner
(`runner.ts:1117`), so background SDK sessions do not increment it. **Pin the current behaviour; do
not "fix" it in a dedupe PR** — changing it is a separate, user-visible decision.

**IN4 — `resolveSubagentParams` runs exactly once per dispatch**, before any target validation, with a
single call shape (`state, ctx, log` + params).

**IN5 — Target validation: cwd always; `outputFile` only where the validated value is later used.**
Mode-level `outputFile` is path-validated in site 5 (`2657`, via `validateDelegationTargets`) and site
6 (`3233`, inline `validateOutputFile`); chain/parallel/graph validate only the cwd at mode level
(`585`, `1099` with no `outputFile`, `1581`) and reach every unit's `outputFile` through
`mergeSubTaskParams` in the per-unit pass. Message bytes are identical between the two spellings
(`validateDelegationTargets` with no `outputFile`/`prefix` returns `Invalid cwd: ${err}`,
`prelude.ts:134-146`), so sites 1-3 *may* share the call — but sites 5-6 must keep their outputFile step.

**IN6 — Preflight follows target validation and precedes H1** (`598`/`1104`/`1594`/`3247`). Absent in
both background paths — plausibly because they spawn an in-process SDK session rather than a `pi`
subprocess (there is no binary to locate); the observed fact is the absence, and it must not change.

**IN7 — Mode-entry H1 runs on the *mode-level* params and never carries `prefix` or `force`.**
Chain/parallel/graph (`620`, `1127`, `1617`) surface it as an unprefixed joined-errors rejection;
site 6 passes `force: params.force` (`3265`) because a single dispatch's task text is the real task;
site 5 also passes force (`2677`); site 4 (fan-out) has **no** mode-entry H1 at all — only the per-unit
pass.

**IN8 — The per-unit pre-pass validates every unit before any spawn, and its *position* differs per
mode.** chain/parallel: after H1, before model+circuit (`640`, `1140`). graph: after model+circuit and
after `topologicalSort` (`1692`, following `1661` circuit and `1680` sort). fan-out: after all
mode-level gates, before the spawn loop (`2152-2197`). A shared skeleton that normalises the position is a
behaviour change: today a graph with a bad node **and** an unconfigured model reports the model error
first; after a naive hoist it would report the node error.

**IN9 — Warnings are ordered, prefixed, and surfaced.** Per-unit warnings accumulate in unit order as
`${prefix}: ${w}` and are appended to the result **after** the JSON payload through
`formatValidationWarnings` (`prelude.ts:169-172`), which returns `""` for an empty list so
warning-free results stay byte-identical (`index.ts:1012`, `1487`, `2038`).

**IN10 — `force` reaches per-units, not mode entry.** All four per-unit calls pass
`force: params.force as boolean | undefined` (`674`, `1177`, `1738`, `2190`); sites 5 and 6 pass the
bare `force: params.force` (`2677`, `3265`).

**IN11 — Model resolution happens once per dispatch, and its rejection precedes the circuit check.**
`682`/`1185`/`1638` (identical text at `694`/`1197`/`1650`), circuit at `705`/`1208`/`1661`.
Site 6 resolves the model at `3287`, *after* H1 and after `formatValidationWarnings` — its rejection
therefore wins over the circuit's, as it does in the batch modes.

**IN12 — `renderCall` is the SDK's `Static<TParams>`; the renderer may read any param.**
Anything narrower is a silent capability loss at the preview surface (finding 3).

## 4. Designs

Each design is assessed on: evidence, invariants touched, diff shape, what a regression looks like,
and the tests that would catch it.

### Design A — typed literal only

**Shape.** One checked type for the resolver's input; the 13-field cast deleted at four sites;
`renderCall`/`renderDelegateCall` typed from `DelegateTaskParams`. The three prologues stay as they are.

**A1 (widen the resolver, the variant I would ship).**
```ts
// params.ts — the input type is derived from the schema, not re-spelled
export type ResolveInputParams = Pick<DelegateTaskParams,
  "task" | "label" | "preset" | "systemPrompt" | "inheritSystemPrompt" | "thinkingLevel" |
  "outputFile" | "timeout" | "cwd" | "tools" | "excludeTools" | "noBuiltinTools" |
  "gitMode" | "approvalMode" | "template" | "force">;   // task is already optional in the schema type

export function resolveSubagentParams(params: ResolveInputParams, …) {
  …
  task: params.task ?? "",     // "" ≡ undefined at all three readers (see finding 4)
}
```
then `index.ts` passes `params` bare at `563`, `1077`, `1558`, `2087`; `spawnBackgroundRun`'s
`Omit<Parameters<typeof resolveSubagentParams>[0], "task"> & { task?: string; model?; priority? }`
(`2603-2606`) collapses to `DelegateTaskParams`; `renderCall(args: DelegateTaskParams, …)`.

**Evidence.** Probe A (appendix): `TS2345`, and the error text names `task?: string | undefined` as
the sole mismatch. Probe B: the existing `Omit<>` workaround is *also* not assignable on its own —
it only compiles because `{ ...params, task: singleTask }` supplies a `string`. So the workaround is
already a workaround for a declaration that should have been optional.

**Diff shape.** `src/params.ts` +~18/−17 (hoisted type, one `?? ""`), `src/index.ts` −~70 (four
17-line casts + the 12-line `renderCall` literal, +2 imports), `src/tui.ts` +5/−12
(`renderDelegateCall` typed from `DelegateTaskParams`, local alias for its `Pick`). Net ≈ **−95 lines,
no behaviour change**.

**Risk. Low** — C3 for the type work (erased, compile-time), C2 only for the `?? ""` value delta. Two
deltas to state in the PR:
1. `globalParams.task` becomes `""` instead of `undefined` for batch modes. All three readers treat
   falsy alike (finding 4). A regression would look like: an auto-route firing on an empty task
   (impossible — `classifyTask` returns `undefined` on `!task`), or an H1 keyword warning firing on
   empty text (impossible — `validatePreTask` early-returns on empty text *unless* `outputFile` is
   set, and the `outputFile` branch runs today too).
2. It removes a latent `TypeError`: `displayTaskName` does `merged.task.length > 60` (`:510-512`), and
   `mergeSubTaskParams` returns `subTask.task || globalParams.task` — with both empty and
   `globalParams.task === undefined` that is `undefined.length`. `?? ""` makes that path produce
   `Step 1 ("")` instead. Strictly better; worth a regression test rather than a silent ride-along.

**Tests.** `npx tsc --noEmit` *is* the test (four casts deleted, three renderer/signature types
unified). Plus: a `params.test.ts` case asserting `resolveSubagentParams({…no task…}).task === ""` and
no auto-route; a type-level ratchet in the shape of `per-step-model.test.ts`'s `KNOWN_DELEGATE_KEYS`
ratchet — a compile-time assertion that `ResolveInputParams` covers `DelegateTaskParams`'s params keys
(verified by `tsc`, since a runtime test cannot see types).

**Verdict as a whole unit: insufficient** — leaves ~310 duplicated prologue lines and all of D2, and
the acceptance criterion "the prologue exists once" unaddressed. **But it is the correct commit 1.**

### Design A′ (mention only) — name the type, keep the casts

`type ModeParams = Omit<DelegateTaskParams, "task"> & { task: string }`, four `as ModeParams`. Not
proposed: it keeps a lie (batch modes have no task) and keeps four assertions; the compiler still
cannot tell a wrong field from a missing one. Listed because it is the cheapest-looking option and
should be explicitly rejected in the PR.

### Design B — one shared skeleton over every prologue site

**Shape.** `runModePrologue({ mode, units, labels, gateToggles, hooks })` covering all six sites.

**Evidence that it must grow hooks.** Parameterising only the *labels* and *unit counts* covers
sites 1-2. Every other site contributes a structural difference that must become a parameter:

| Difference | Sites | Becomes |
|---|---|---|
| DAG validation before the cost gate | 3 | `beforeCost?: () => rejection` |
| no depth gate | 4, 5 | `depthGate: false` |
| no preflight | 4, 5 | `preflight: false` |
| no mode-entry H1 | 4 | `modeEntryH1: false` |
| approval gate before cost | 5 | `approvalGate: "beforeCost"` |
| cost gate after resolve | 5 | `costGate: "afterResolve"` |
| per-unit pass before vs after model+circuit | 1,2 vs 3,4 | `unitPassPosition: "preModel" \| "postCircuit"` |
| two return shapes (`ToolResult<undefined>` rejection vs `{ok:false,error}`) | all | normalization |
| `writes`/gitMode-branch side gates | 4, 5 | callbacks |

Nine knobs before the first line of shared code. At that point the "shared" function is an
interpreter for a six-mode configuration, and the configuration itself is ~40 lines that must be read
per mode to know what a handler does — i.e. the reader still reads six prologues, now with indirection.

**Diff shape.** `index.ts` −~350, `prelude.ts` +~180 (one 120-line template method + a param type).
Net −170 but the largest single new function in `prelude.ts`.

**Risk. C1, not C2.** The failure mode is not a compile error — it is **silent order normalisation**.
Concretely: the most natural reading of the six sites is "cost first", which is wrong for site 5
(IN1); the most natural reading of the per-unit pass is "right after H1", which is wrong for site 3
(IN8). Both would pass every existing suite (no test asserts which gate wins — §6).

**Tests that would pin it:** IN1-IN12 as ~20 real-handler assertions, one per ordering pair, before
any code moves. That is a bigger test-writing job than the refactor itself, and it is exactly the
work commit 2 does anyway — so B is affordable only *after* the pins exist; by then C is available at
half the risk.

**Verdict: reject for this unit.** Keep the seams visible. The six sites are not six copies of one
thing; they are two families that happen to share a prefix, and B unifies across the family boundary.

### Design C — refined: two helpers + one hook, ordering preserved by construction

This is the recommended shape, and it differs from the issue's sketch in one important respect: **the
per-unit pass is a helper the handler *calls*, never a hook the prologue *invokes**. That is what
makes IN8 impossible to break.

**C1 — `runModePrologue` in `prelude.ts`** (the batch family: chain, parallel, graph; site 6 optional, see Q2):

```ts
export interface ModePrologueInput {
  params: ResolveInputParams;         // design A1 — the type that kills the casts
  state: SessionState; ctx: ExtensionContext; log: Logger;
  costLabel: string;                  // "Chain delegation" | "Parallel delegation" | "Graph delegation"
  units: number;                      // per-unit estimate count (IN2)
  validationLabel: string;            // "Chain" | "Parallel" | "Graph"  (H1 log + prefix-free message)
  /** graph only: DAG validation, which runs BEFORE the cost gate (IN1/IN3 boundary). */
  beforeCost?: () => ToolResult<undefined> | undefined;
}

export type ModePrologueOutcome =
  | { ok: false; error: ToolResult<undefined> }
  | { ok: true; globalParams: ReturnType<typeof resolveSubagentParams>; resolvedCwd: string };
```

Body order, exactly as IN1/IN3/IN5/IN6/IN7 state: `beforeCost?` → cost → depth → resolve →
`validateDelegationTargets({ctx, effectiveCwd})` (no outputFile — IN5) → preflight → H1 via
`runPreTaskValidation` (no prefix, no force — IN7). Two message-identity facts make this a provable
no-op: `validateDelegationTargets` without `outputFile` returns `Invalid cwd: ${err}` byte-identically
to sites 1/3's inline block, and `runPreTaskValidation` with no `prefix`/`logContext` logs and returns
exactly what sites 1/3's inline `validatePreTask` block does (`prelude.ts:184-207` vs
`index.ts:620-638`).

**C2 — `validateUnitPrePass` in `prelude.ts`** (D2):

```ts
export interface UnitPrePassInput<U> {
  units: readonly U[];
  /** Per-unit data the handler already computes — no formatting policy in the helper. */
  describe: (unit: U, index: number) => {
    prefix: string;                    // `Step 1 ("…")` | `Task 2 ("…")` | `Node "n1"`
    logContext: Record<string, unknown>; // {step} | {task} | {id}
    taskText?: string;                 // graph: placeholder-stripped (IN: graph's declared text)
  };
  label: string;                       // "Chain" | "Parallel" | "Graph" | "Background fan-out"
  globalParams: ReturnType<typeof resolveSubagentParams>;
  ctx: ExtensionContext; log: Logger;
  force?: boolean;                     // IN10
}

export type UnitPrePassOutcome<U> =
  | { ok: false; error: ToolResult<undefined> }
  | { ok: true; units: Array<{ unit: U; cwd: string; outputFile?: string }>; warnings: string[] };
```

The helper owns `mergeSubTaskParams` → `validateDelegationTargets` → `runPreTaskValidation` → the
`${prefix}: ${w}` accumulation (IN9) and returns units in input order; each handler still builds its
own `string[]`/`Map`/`FanOutTask[]` from the result, and site 4 still resolves the per-unit model
around it. Graph's placeholder strip stays in the graph handler (it is graph policy, and it belongs
next to the comment explaining why).

**C3 — `resolveModeModel` in `prelude.ts`** (IN11): model resolution + the empty-model rejection +
the circuit check, returning `{subagentModel, modelStr}` or a rejection. This is what lets chain/
parallel keep the per-unit pass *between* H1 and model, and graph put it *after* circuit, without a
hook: each handler just calls C1, then C2, then C3 — or C1, C3, C2 for graph.

**Resulting handler shape** (`runChainMode`, the whole prologue, verbatim target):

```ts
const pro = runModePrologue({ params, state, ctx, log, costLabel: "Chain delegation",
  units: chainSteps.length, validationLabel: "Chain" });
if (!pro.ok) return pro.error;

const pass = validateUnitPrePass({ units: chainSteps, label: "Chain", force: params.force,
  globalParams: pro.globalParams, ctx, log, describe: describeStep });
if (!pass.ok) return pass.error;

const tail = resolveModeModel(pro.globalParams, params.model, state, ctx, log);
if (!tail.ok) return tail.error;
```

**Diff shape.** `index.ts` −~300/+~40 (three prologues + four pre-passes → 3 × ~10 lines),
`prelude.ts` +~130, `params.ts` +~18 (from A1). Net ≈ **−230 lines**, three functions added, no
existing helper's contract changed. Handler recognisability is preserved: each one still shows its
own labels, its own unit descriptor, and the position of its pre-pass call.

**Risk. C2.** A regression would look like: the same rejection with a different prefix/absence of
prefix (IN5/IN7), a warning that lands in a different order (IN9), the per-unit pass running after a
model rejection (IN8), or `Step 1 ("")`-class display changes from the A1 normalisation. All four are
externally observable and testable.

**Tests.** The pins of §6; then, per commit, `tsc --noEmit`, the full suite, and a jscpd re-run with
the expected numbers in §7.

### Design comparison

| | A (A1) | A′ (named cast) | B (one skeleton) | **C (C1+C2+C3, recommended)** |
|---|---|---|---|---|
| Lines removed | ~95 | ~45 | ~350 | ~230-300 |
| D1 gone | casts only | casts only | yes | yes |
| D2 gone | no | no | yes | yes |
| Gate order touched | no | no | **yes** | **no** |
| New abstractions | 1 type | 1 type | 1 six-mode interpreter, 9 knobs | 3 typed helpers, 1 optional hook |
| Risk class | C3 | C3 (keeps a lie) | **C1** | C2 |
| Reviewable in one sitting | yes | yes | no | yes, commit by commit |
| Pins required before it is safe | none | none | ~20 | ~20 (shared with B) |

## 5. Recommendation and staging

**Ship C, in four commits, on one branch.** Each commit is independently green and independently
reviewable; the maintainer can stop after any of them and the tree is better than before.

| # | Commit | Content | Proof | Risk |
|---|---|---|---|---|
| 1 | `refactor(params): derive the resolver input type from the schema` | A1: `ResolveInputParams` in `params.ts`; 4 casts deleted; `spawnBackgroundRun`'s `Omit<>` type → `DelegateTaskParams`; `renderCall`/`renderDelegateCall` typed from `DelegateTaskParams`; `params.test.ts` case for `task === ""` | `tsc --noEmit` (currently fails without the change); suite green; **0** `as {` casts left in `index.ts` | C3 |
| 2 | `test(dispatch): pin the mode prologue's gate order` | IN1-IN12 as real-handler assertions (§6) — **written against unchanged code**, all green | new suite green; mutating any gate's position makes it red (verify by hand: move graph's pre-pass before model locally, confirm the test fails, revert) | C3 |
| 3 | `refactor(dispatch): one per-unit pre-pass helper` | C2 + four call sites, keeping each call where it is today | suite + jscpd 8L/50t before/after; structural guard (IN: one `runPreTaskValidation` inside a loop) | C2 |
| 4 | `refactor(dispatch): one batch prologue` | C1 + C3 at sites 1-3 (site 6 per Q2) | suite + jscpd 10L/70t → 0 clones | C2 |

**Smallest safe first step: commit 1 alone** — under 100 lines of net deletion, mostly type-level, with
`tsc` as the proof and one new test. It fixes the latent `renderCall` defect's *type* half (the
visible half is Q1) and it is a prerequisite for commits 3-4 anyway (C1's `params` field).

**Tradeoffs accepted:** C leaves the two background prologues hand-written and visibly similar to the
batch ones (Q3). That is deliberate — they are a different gate sequence, and making them look alike
is the change that would hide IN1/IN3/IN6/IN7. It also leaves three call sites that still *look*
alike; the dedupe is in the body, not in the call shape, which is the point.

## 6. Tests

### Existing coverage, mapped to invariants

| Suite | Pins | Notes |
|---|---|---|
| `background-fan-out.test.ts` (629 L) | IN1 (fan-out), IN2 (`470`: N-task estimate), IN5 (`359`, `506`), IN7/IN10 (`529` H1 hard conflict) | drives the real handler with `../runner` mocked |
| `dispatch-capability-guards.test.ts` (508 L) | IN7/IN10 (`force` degrades block→warning), IN9 (warning surfacing) | real handler |
| `per-step-cwd.test.ts` (480 L) | IN5/IN8 (per-unit cwd resolved and used) | real handler |
| `per-step-model.test.ts` (—) | IN11 (per-unit model beats global), `KNOWN_DELEGATE_KEYS ↔ schema` ratchet | real handler; the ratchet pattern to copy for A1's type |
| `chain-parallel.test.ts` (710 L) | `mergeSubTaskParams` semantics, aggregation | **unit-level only** — never calls the prologue |
| `preflight.test.ts` (186 L) | IN6 (helper behaviour) | **never asserts where the gate runs** |
| `integration.test.ts` | IN: `resolveSubagentParams` preset merge; **the depth gate only as a logic replica** (`1281-1317`: `expect(currentDepth >= maxSubagentDepth)`) | the replica is the gap: no test drives a real dispatch with the gate tripped |
| `tui-render-goldens.test.ts` | call-preview bytes (#378) | the surface a `preset` badge would change |
| `architecture-rules.test.ts` | import graph, entry confinement | home for the structural guard below |

### Gaps that must be closed (commit 2, before any code moves)

New file `src/__tests__/mode-prologue.test.ts`, real-handler harness (copy the
`dispatch-capability-guards.test.ts` / `background-fan-out.test.ts` setup: register the extension,
mock `../runner`, capture spawns):

1. **Order pairs** — with two gates tripped, assert which rejection wins:
   a. chain: cost over limit + `maxSubagentDepth: 0` → cost message.
   b. chain: depth exhausted + invalid `cwd` → depth message.
   c. chain: invalid `cwd` + unconfigured model → cwd message.
   d. graph: invalid DAG (cycle) + cost over limit → `Graph validation failed` (IN1 boundary).
   e. parallel: mode-level `outputFile`-vs-write conflict + invalid per-task cwd → the H1 rejection (IN7 before IN8).
   f. fan-out: `approvalMode: 'always'` + cost over limit → the approval message (IN1, the background exception).
   g. `spawnBackgroundRun`: `approvalMode: 'always'` + cost over limit → the approval message.
   h. single foreground: cost over limit + `maxSubagentDepth: 0` → cost message.
2. **Depth gate, real path** (IN3) — set `BRL_SUBAGENT_DEPTH` + `maxSubagentDepth`, drive
   chain/parallel/graph/single: assert the exact `Cannot delegate further …` text. **And** assert both
   background paths do *not* reject (pin the asymmetry; it must not be "fixed" by accident).
3. **Per-unit pass position** (IN8) — graph: bad node (`cwd: "/nonexistent"`) + unconfigured model →
   the *model* rejection (proves the node pass runs after model resolution); chain with the same inputs
   → the cwd/prefix rejection (proves it runs before).
4. **All-before-any-spawn** (IN8) — chain of 3 with unit 3 invalid → 0 spawns, and the rejection
   carries `Step 3 ("…")`.
5. **Warning order and surfacing** (IN9/IN10) — chain of 3, units 1 and 3 warn → the result text ends
   with the two warnings in unit order, prefixed, after the JSON; a warning-free chain's result is
   byte-identical to today's (no trailing block).
6. **Prefix vocabulary** — `Step 1 ("…")`, `Task 2 ("…")`, `Node "n1"` exact strings; `displayTaskName`
   truncation at 60 chars.

Direct unit tests for the extracted helpers (commit 3/4), cheap because they are pure-ish with fake
`state`/`ctx`/`log`: `runModePrologue` (each gate trips in isolation; `beforeCost` runs first),
`validateUnitPrePass` (order, prefix, `force` passthrough, graph placeholder stripping, `Map`-keyed
consumption), `resolveModeModel` (empty model string → rejection, circuit open → rejection).

Structural guard (add to `architecture-rules.test.ts`, with the recorded-reason allow-list style the
file already uses):

- `src/index.ts` contains **zero** `as {` object-literal assertions (today: 4, all of them the
  prologue casts — `564`, `1078`, `1559`, `2088`; a future legitimate one needs a recorded reason);
- the depth-rejection literal appears **exactly once** in `src/` (today: 4);
- `runPreTaskValidation({` appears **at most once** inside a `for`/`for…of` loop in `src/index.ts`
  (the D1/D2 regression fence that jscpd cannot provide — finding 5).

## 7. Verification plan (what "done" means at implementation time)

Re-measure, don't predict:

```sh
npx tsc --noEmit
npx vitest run                                    # baseline to record: files/tests before the change
npx jscpd@latest src --format typescript --ignore "**/__tests__/**" \
    --min-lines 10 --min-tokens 70 --reporters console
```

- **jscpd 10/70:** expect **9 clones → 0** (baseline in appendix B: all nine fragments are D1 or the
  cast↔`params.ts` type clone; the post-fix tree has no other 10/70 clone). Duplicated lines 270
  (1.27 %) → 0.
- **jscpd 8/50 scoped to `src/index.ts`:** expect the D2 tails (`667-677 ↔ 1170-1180`,
  `1168-1180 ↔ 2181-2193`) to disappear; remaining pairs should be pre-existing non-D1 fragments
  (`2503-2514 ↔ 2574-2585`, `3999-4023 ↔ 4048-4072`), which are out of this unit's scope.
- **Suite:** all green, plus the new ~18-22 tests. Watch the two budget guards: the README
  `<N>+ test suite` claim (`scripts/check-readme-test-count.mjs`, ±100 tolerance — a ~20-test delta
  should not trip it, verify) and the test-budget ceilings (`check-test-budget.mjs`, ≤ 60 s / ratio ≤ 2.0).
- **Docs:** if the helpers land, `prelude.ts`'s `// Purpose:` header must change (`npm run docs:arch`
  regenerates `.development/ARCHITECTURE.md`'s module map, guarded by `architecture-doc.test.ts`), and
  the dispatch-pipeline paragraph at `ARCHITECTURE.md:53-54` should name the prologue helper. **This is
  a build failure if forgotten** — the note exists so the implementation PR does not discover it late.

## 8. Open questions for the maintainer

- **Q1 — the visible half of the `renderCall` defect.** Typing `renderCall` from `DelegateTaskParams`
  makes `preset` readable; it does not make it *visible*. Adding a `[preset:name]` badge to the
  single-mode preview is a user-visible change that touches `tui-render-goldens.test.ts`. In this unit
  (commit 1 + a golden) or a follow-up?
- **Q2 — does site 6 (single foreground, `3167-3310`) join C1?** It is the same six-gate order, but it
  lives inside `execute`, is 144 lines (incl. the inline `validateOutputFile` and the `force`-carrying
  H1), and is the highest-traffic path in the extension. Recommendation: **no** in this unit — one
  prologue site at a time, and site 6's H1/`force` semantics differ from the batch family (IN7).
- **Q3 — do the background paths get their own `runBackgroundPrologue`?** They share six of seven steps
  with each other (not with the batch family). Recommendation: a follow-up unit, after the batch
  helper has lived a cycle; doing both in one PR doubles the ordering surface under review.
- **Q4 — ADR?** Not required for C (moderate reversibility, no cross-cutting contract). If Q2/Q3 expand
  the scope to "every dispatch path routes through one prologue", record it as ADR 0017 — that decision
  is expensive to walk back.

---

## Appendix A — the `tsc` probe (why the casts exist)

Transient file `src/__probe379.ts` (deleted; tree clean):

```ts
export const direct  = resolveSubagentParams(params, state, ctx, log);           // probe A
export const omitted = resolveSubagentParams(
  params as Omit<Parameters<typeof resolveSubagentParams>[0], "task"> & { task?: string },
  state, ctx, log);                                                              // probe B
```

`npx tsc --noEmit`:

```text
__probe379.ts(13,45): error TS2345: Argument of type '{ task?: string | undefined; … 18 more … }'
  is not assignable to parameter of type '{ task: string; label?: string | undefined; … }'
__probe379.ts(17,2):  error TS2345: Argument of type 'Omit<{ task: string; … }, "task"> & { … }'
  is not assignable to parameter of type '{ task: string; … }'
```

Reading: the *only* mismatch is `task` optionality (every other schema field is assignable), and the
`spawnBackgroundRun` workaround type does not fix it either — that site compiles because
`{ ...params, task: singleTask }` supplies a `string` at the call. The declaration is what is wrong,
so the fix belongs in `params.ts` (design A1), not in another assertion.

## Appendix B — jscpd baselines on this worktree

At the sweep's setting (`10L/70t`, tests excluded), 41 files / 21,232 lines:

```text
typescript | 41 files | 21,232 lines | 88,373 tokens | 9 clones | 270 duplicated lines (1.27%)
```

The nine fragments, each mapped to this note:

| # | Pair | Lines | What |
|---|---|---|---|
| 1 | `543-585 ↔ 1057-1099` | 43 | chain ↔ parallel: cost → depth → resolve → cwd |
| 2 | `543-577 ↔ 1538-1572` | 35 | chain ↔ graph: same prefix |
| 3 | `563-585 ↔ 2087-2109` | 23 | chain ↔ fan-out: cast + resolve |
| 4 | `577-600 ↔ 1573-1596` | 24 | cwd + preflight |
| 5 | `600-628 ↔ 1596-1625` | 29 | preflight tail + mode-entry H1 |
| 6 | `678-716 ↔ 1181-1219` | 39 | chain ↔ parallel: model + empty-model + circuit |
| 7 | `678-716 ↔ 1634-1673` | 39 | chain ↔ graph: same |
| 8 | `682-704 ↔ 3287-3310` | 23 | chain ↔ single foreground: model + circuit |
| 9 | `1559-1573 ↔ params.ts:184-198` | 15 | **the graph cast literal ↔ the resolver's own input type** |

At `8L/50t` scoped to `src/index.ts` (15 clones), D2 appears only as tails —
`667-677 ↔ 1170-1180` and `1168-1180 ↔ 2181-2193` — and the `renderCall` copy appears as
`567-576 ↔ 3854-3863`. That is the evidence for finding 5: **D2 needs a structural guard, not the
detector.**

> **Correction (2026-10-25, from the commit-2 pins):** §6(d)'s assumption that a graph **cycle** is caught
> before the cost gate is wrong — `validateGraph` checks empty/over-limit/duplicate/missing-dep only; cycles are
> rejected by `topologicalSort` **after** the prologue. The pins assert the duplicate-id contract, which is the
> true pre-cost graph validation.

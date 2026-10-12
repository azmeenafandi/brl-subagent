# INVESTIGATION — should the durable run registry persist more than identity for FOREGROUND runs?

Status: decision-ready proposal (design investigation, no source modified)
Repo: `brl-subagent` @ `investigation/fg-task-persistence` (base `2cd6857`)
Scope: `.pi/run-registry/` durable entries + the U3 recovery surface + the `retryRunId` path

---

## 0. TL;DR

**Recommendation: Option 3 — persist the full run summary (`task`, `label`, `model`,
`thinkingLevel`, and the run's `originalParams` snapshot) in the registry entry, and have the
U3 bridge restore all of it, giving a post-crash foreground retry full parity with a
same-session retry.**

The registry is written through ONE choke point (`persistRunRecord` → `toRegistryInput(run)`,
`src/run-registry.ts`), and that function already receives the entire `SubagentRun` — including
the `originalParams` object that already exists on every foreground/unit run record. The bytes
are therefore already in memory at the write site; the change is to copy a field set, not to
compute a new one. It adds **no new `delegate_task` parameter**, so `KNOWN_DELEGATE_KEYS`,
`_DelegateParamCoverage`, and the `retry-pins` snapshot↔resolve drift guard are untouched.
All new fields are optional/additive, so old entries read as today and new entries are ignored
by old readers (both directions probed, §6 Probe D).

The one genuinely open safety question is `force` (and, less sharply, `approvalMode`): a retry
restores the *recorded* execution shape, and the same is already true today for same-session
retries (issue #227) and background runs. Full parity is the predictable choice and matches the
retry menu's advertised contract ("Re-dispatch with its recorded params"); the conductor should
ratify whether `force` is the single exception (§3 falsifiers, §5 Q1).

---

## 1. Ground truth — what the code actually does

### 1.1 The registry shape and its lifecycle

`InflightRun` (`src/run-registry.ts`, interface at the top of the file) currently carries exactly:

```
id, dispatchId?, attempt?, kind, owner?, childMarker?, recoveryPosture?, startedAt, cwd, interruptedAt?
```

(10 fields; `interruptedAt` is the boot-scan mark, not a dispatch field.)

Lifecycle, verified against the code:

- **Write at dispatch** — `persistRunRecord(pi, run, kind)` (`src/run-registry.ts:272`):
  a `running` record with a `kind` calls `registerInflightRun(toRegistryInput(run, kind))`.
  Call sites: `state.persistRun` (`src/state.ts:267-268`) delegates here; every run-record write
  goes through it. Background spawn calls `persistRunRecord(pi, run, "background")` directly
  (`src/session-manager.ts:683`).
- **Refresh during run** — a `running` record **without** a `kind` is a no-op for the registry
  (`persistRunRecord` only registers when `kind` is set): `else if (kind) {...}`.
- **Clear at settle** — a terminal (`status !== "running"`) record calls `clearInflightRun`.
  For foreground single: `state.persistRun(pi, run)` at the finalize/`catch` blocks
  (`src/index.ts:3594`, `:3721`). For units: `finalizeUnitRun`/`finalizeUnitRunCrash`
  (`src/unit-run.ts:185`, `:229`).
- **Interruption mark** — the boot scan calls `markInterrupted(id, iso)` (`src/index.ts:3989-3994`),
  which reads the entry and writes `{ ...existing, interruptedAt }`. **Existing fields survive the
  mark by construction** (`markInterrupted` spreads `existing`).
- **Retire** — `clearInflightRun` has exactly two non-test callers: `persistRunRecord`'s terminal
  branch, and the abandon action's `retireRegistry` (`src/index.ts:4079`).

**Consequence for payload lifetime (§1.8):** a normal run's entry is short-lived (dispatch →
settle). An **interrupted** run's entry is retired only by **abandon** — not by a retry. See §1.8.

### 1.2 What a retry actually consumes — `resolveRetryParams`

`resolveRetryParams` lives in **`src/history.ts:141-192`** (NOT `src/index.ts`; the brief's pointer
is one hop off). Its only **production** call site is `src/index.ts:2965`, inside the
`if (params.retryRunId)` branch. (Full coverage: `grep -rn "resolveRetryParams(" src/*.ts` →
2 hits, one of which is the definition; the rest are tests.)

It returns a fresh 19-key literal. Exhaustive enumeration of its **sources**:

| returned key | read from | shape |
|---|---|---|
| `task` | `params.task \|\| run.task` | **top-level run field** |
| `label` | `params.label ?? run.label` | **top-level run field** |
| `model` | `params.model ?? orig?.model` | `originalParams` |
| `preset` | `params.preset ?? orig?.preset` | `originalParams` |
| `systemPrompt` | `params.systemPrompt ?? orig?.systemPrompt` | `originalParams` |
| `inheritSystemPrompt` | `params.inheritSystemPrompt ?? orig?.inheritSystemPrompt` | `originalParams` |
| `thinkingLevel` | `params.thinkingLevel ?? orig?.thinkingLevel` | `originalParams` |
| `priority` | `params.priority ?? orig?.priority` | `originalParams` |
| `outputFile` | `params.outputFile ?? orig?.outputFile` | `originalParams` |
| `timeout` | `params.timeout ?? orig?.timeout` | `originalParams` |
| `cwd` | `params.cwd ?? orig?.cwd` | `originalParams` |
| `tools` | `params.tools ?? orig?.tools` | `originalParams` |
| `excludeTools` | `params.excludeTools ?? orig?.excludeTools` | `originalParams` |
| `noBuiltinTools` | `params.noBuiltinTools ?? orig?.noBuiltinTools` | `originalParams` |
| `retryOnTimeout` | `params.retryOnTimeout` | **explicit-only (never inherited)** |
| `background` | `params.background ?? orig?.background` | `originalParams` |
| `gitMode` | `params.gitMode ?? orig?.gitMode` | `originalParams` |
| `approvalMode` | `params.approvalMode ?? orig?.approvalMode` | `originalParams` |
| `force` | `params.force ?? orig?.force` | `originalParams` |

(`orig = run.originalParams`.) So a retry consumes **2 top-level run fields** (`task`, `label`)
and **15 `originalParams` fields**, plus the explicit-only `retryOnTimeout`. All 17 restorable
fields are exactly what `snapshotOriginalParams` (`src/params.ts:94-133`) writes when a run is
dispatched; the session run records and background agent records both persist it today.

**Both `task` and `label` are top-level `SubagentRun` fields**, so any enrichment must set them on
the synthetic run the bridge builds, not inside `originalParams`.

### 1.3 The U3 bridge, and exactly where the gap lives

`collectInterruptedRuns` (`src/recovery-surface.ts:83-123`) projects each `interruptedAt` registry
entry into an `InterruptedRunView`, enriching from:
1. `deps.findRun(entry.id)` — the **session** run entry (same-session reload only), then
2. `deps.getAgent(entry.id)` — the **background** agent record (background runs only).

A foreground/unit run after a **fresh boot** has neither → `label`/`task`/`model`/`thinkingLevel`
are `undefined`, and `buildRecoveryNotice`'s `taskExcerpt` prints `"(task unavailable)"`
(`src/recovery-surface.ts:253-258`, `:276-278`).

The visibility bridge `visibleRunEntries` → `interruptedViewToRun`
(`src/recovery-surface.ts:135-158`) builds the synthetic session record:

```
task: view.task ?? ""
originalParams: { model: view.model, thinkingLevel: view.thinkingLevel,
                  ...(kind === "background" ? { background: true } : {}) }
```

**Probed (Probe C):** even if the registry entry already carried `task`/`label`/`model`/
`thinkingLevel`/`originalParams`, `visibleRunEntries` ignores all of them — the synthetic run's
`task` stays `""` and `originalParams` stays `{}`-ish. So **writing new fields into the registry is
necessary but NOT sufficient**; `collectInterruptedRuns` must read them and `interruptedViewToRun`
must forward them.

**Probed (Probe B):** with the current synthetic shape, `resolveRetryParams` returns
`task: ""` → the single-mode sanitizer then rejects with `Invalid task: Task must not be empty.`
With an enriched synthetic record (`task` set, `originalParams` populated), the retry restores
`task`, `label`, `model`, `thinkingLevel`, `timeout`, `gitMode`, `force`, … and **explicit caller
values still win** (Probe B case c).

### 1.4 Precedent & footprint

- **Background agent records already persist task text.** `spawnBackgroundSession` sets
  `agent.task = params.task` (`src/session-manager.ts:641`) and `persistAgent` writes the record
  (stripping only `_sessionRef` and `_sessionFile`, `src/session-manager.ts:185-191`). So raw task
  text at rest is an established, reviewed precedent — the registry is not a new class of secret.
- **Session run entries already persist task + `originalParams`** at dispatch
  (`createUnitRun`, `src/unit-run.ts:110-150`; single foreground `src/index.ts:3237-3255`).
- **The registry is small and near-empty at rest.** `listInflightRuns` reads and parses every
  `*.json` in `.pi/run-registry/`; in steady state only in-flight runs live there (settle clears
  them). `recoverInflightRuns` deliberately avoids parsing the whole `.pi/subagents/` store
  (`src/recovery.ts:246-296`) — adding task text to the registry does NOT reintroduce that cost
  for the *normal* case, but an interrupted entry that is never abandoned is parsed on every boot
  and every notice (§1.8).
- **Size bound.** `sanitizeTask` caps the task at `MAX_TASK_LENGTH = 50_000` chars
  (`src/sanitize.ts:23`, `:33-40`), and the persisted `run.task` is the sanitized value
  (`src/index.ts:2998` sets `params.task = taskResult.value` before the run record is built).
  So a worst-case registry entry grows by ≤50 KB. `writeAtomic` pretty-prints
  (`JSON.stringify(entry, null, 2)`) and rewrites the whole file on the boot mark — two extra
  serializations of ≤50 KB per interrupted run, not a hot path.

### 1.5 Privacy / ownership

- `.gitignore` line 11: `.pi/*` — **the registry is git-ignored** (`!.pi/skills/`,
  `!.pi/extensions/` are the only re-includes). No task text can be committed.
- `ensureDir` creates the registry dir `mode 0o700`; `writeAtomic` writes files `mode 0o600`
  (`src/run-registry.ts`, mirroring the agent store's F6 discipline). Same owner-only guarantee as
  `.pi/subagents/`.
- **Sanitization parity:** task text is `sanitizeTask`-validated on every persistence path
  (trim, ≤50 KB, no shell metachars — the metachar regex is a documented no-op). Error *messages*
  are path-redacted via `sanitizeErrorMessage`, but **task text is never path-redacted anywhere**;
  the registry must not be the first place to invent a different rule. `originalParams.systemPrompt`
  can be caller-supplied and large, but is already persisted verbatim in session/agent records.

### 1.6 Compatibility

- **Additive optional fields need no migration.** `isInflightRun` (`src/run-registry.ts`) tests
  only `id`(string), `startedAt`(string), `kind`, and `recoveryPosture ∈ RECOVERY_MODES`; it
  **ignores unknown keys**, so an old reader accepts a new-shape entry. A new reader sees
  `undefined` for fields absent from an old entry. Both directions probed (Probe D).
- **The round-trip is NOT free.** `mergeInput` copies a *fixed* field set onto the base, and
  `registerInflightRun`/`updateInflightRun` build from `mergeInput`. **Probed (Probe A):** an extra
  input field is silently dropped unless `InflightRunInput`, `mergeInput`, and `toRegistryInput`
  are each extended. Three functions, one file.
- **Ratchets:** `KNOWN_DELEGATE_KEYS` (`src/params.ts`, 25 keys) and `_DelegateParamCoverage`
  (`src/index.ts:198`) govern *delegate_task params*; this design adds none → untouched. The
  `retry-pins.test.ts` drift guard compares `snapshotOriginalParams`'s key set with
  `resolveRetryParams`'s — also unchanged; we only add a new *source* of the same keys.
- **Shape-guard choice:** the existing strict `recoveryPosture` check REJECTS a malformed entry
  wholesale — applying that to `task`/`originalParams` would drop the entire entry and **lose the
  interruption mark**. New fields must be validated *leniently* (ignore a wrong-typed field, keep
  the entry), or not validated at all.

### 1.7 Safety semantics — absent vs present on a crashed-run re-dispatch

For each dispatch-affecting field, what a post-crash `retryRunId` does:

| field | ABSENT (today's behavior) | PRESENT (restored) | note |
|---|---|---|---|
| `gitMode` | falls back to `state.config.gitMode` in the NEW session | restores recorded mode | a recorded `none` vs a current `branch` changes whether a work branch is created |
| `approvalMode` | falls back to `state.config.approvalMode` | restores recorded mode | a recorded `always` vs current `writes` changes write-gating; a recorded `writes` auto-approves |
| `force` | `undefined` → H1 guards enforced | `true` → **H1 capability/outputFile guards bypassed** | sharpest field; the only implicit guard override |
| `timeout` | no deadline (normalized default) | fresh deadline from record | harmless |
| `outputFile` | none | restored (re-validated against the *current* project root) | validation still applies |
| `toolOptions` (`tools`/`excludeTools`/`noBuiltinTools`) | preset/default toolset | restores the recorded restriction | edits `edit→write` fix still applied at resolution |
| `cwd` | `ctx.cwd` of the new session | recorded cwd (relative paths resolved against the *new* `ctx.cwd`) | a removed worktree → loud `validateCwd` failure, not silent |
| `preset`/`systemPrompt`/`inheritSystemPrompt`/`priority` | defaults | restored | benign |

**Owner/process semantics:** a retry does NOT revive the old run. `newDispatchIdentity(retrySourceRun)`
(`src/recovery-engine.ts`) inherits `dispatchId` and records `resumeOf`/`attempt+1`, and the retry
path mints a **fresh run id** (`src/index.ts:3237` `const runId = crypto.randomUUID()`) with a fresh
`owner`/`childMarker` (`:3253-3254`). So the retried run registers under a **new** registry id, and
the OLD interrupted entry is untouched.

### 1.8 Finding: a retry does not retire the source registry entry

`clearInflightRun`'s only callers are terminal writes and the abandon action; `retrySourceRun` is
used **only** for identity inheritance (`grep -n retrySourceRun src/index.ts` → 2573, 2655, 2849,
2964, 3084, 3234; none clear the source). Therefore, after a retry, the old interrupted entry
(the one the notice named) **remains on disk and is re-offered at every subsequent boot** until
abandoned. This is pre-existing behavior, but it directly answers the brief's "the payload is
short-lived because entries retire at settle" hypothesis: **entries retire at terminal settle or
abandon — NOT at retry.** Persisting a task therefore means the task text can live indefinitely in
the stale entry. This is a size/lifetime fact the conductor should weigh (see §5 Q3), and it is
why "no cap on the persisted task" is acceptable only because the entry count is small.

---
## 2. Options

All options share two invariants (they are what makes any of them cheap):
- **Single write site:** `toRegistryInput(run)` already holds the full `SubagentRun`, so fields are
  copied, never recomputed.
- **No new delegate param:** `KNOWN_DELEGATE_KEYS` / `_DelegateParamCoverage` / `retry-pins` guard
  untouched; the retry surface is unchanged (`retryRunId` still resolves through the bridge).

### O0 — Do nothing (document the caveat)

- **Mechanism:** keep the registry identity-only. `buildRecoveryNotice` keeps printing
  `(task unavailable)` and the hint "pass `task` explicitly on the retryRunId call".
- **Blast radius:** none — zero code change.
- **Cost:** 0.
- **Risk-if-wrong:** the gap is *not* cosmetic — a foreground retry without an explicit task fails
  with `Invalid task: Task must not be empty.` (Probe B), and even with a task the entire execution
  shape silently defaults to the *current* session config, which can differ from the crashed run's
  (e.g. a recorded `approvalMode: "always"` becomes the current `"writes"`). The visible offer is
  "weak" exactly as the U3 review documented.

### O1 — Minimal: persist `task` only

- **Mechanism:** add `task?: string` to `InflightRun` + `InflightRunInput`; copy it in `mergeInput`;
  map it in `toRegistryInput` from `run.task`; in `collectInterruptedRuns` add `?? entry.task` to
  the task fallback. The synthetic run then carries the recovered task.
- **Blast radius:** `src/run-registry.ts` (interface ×2, `mergeInput`, `toRegistryInput`);
  `src/recovery-surface.ts` (`collectInterruptedRuns`); tests `run-registry.test.ts`,
  `recovery-surface.test.ts`, `recovery-retry-after-boot.test.ts`; notice copy.
- **Cost:** S — one field across three functions + one fallback.
- **Risk-if-wrong:** the retry becomes *possible* without a caller-supplied task but everything else
  (model/thinkingLevel/gitMode/approvalMode/force/timeout) still silently defaults to the current
  session. The offer looks fixed while still dispatching a different shape — the most dangerous
  state, because it removes the caller's reason to pass explicit params.

### O2 — Display + defaults: `task`/`label`/`model`/`thinkingLevel`

- **Mechanism:** as O1, plus `label`, `model`, `thinkingLevel`. `collectInterruptedRuns` falls back
  to `entry.<field>`; `interruptedViewToRun` keeps its existing `originalParams` literal
  `{ model, thinkingLevel, background? }` (so `resolveRetryParams` restores model/thinkingLevel).
  The notice/menu/history rows show the real name; `runDisplayName` (`src/tui-format.ts:61`) and
  the retry menu (`src/tui.ts:2058-2069`) improve with **zero TUI change**.
- **Blast radius:** O1 + `InterruptedRunView` gains `model`/`thinkingLevel` consumers (already
  present); tests.
- **Cost:** M.
- **Risk-if-wrong:** exactly the asymmetry O3 removes: display is complete but dispatch-shape params
  (`gitMode`/`approvalMode`/`force`/`timeout`/`outputFile`/`cwd`) still default to the current
  config. Both directions of mismatch are surprises; the `approvalMode` direction can be a security
  regression (see §1.7).

### O3 — Full snapshot / safety parity (RECOMMENDED)

- **Mechanism:** O2, plus persist `originalParams?: SubagentRun["originalParams"]` (the exact object
  `snapshotOriginalParams` already puts on the run record). `collectInterruptedRuns` exposes it on
  the view; `interruptedViewToRun` uses `view.originalParams ?? {model, thinkingLevel, background?}`
  as the synthetic `originalParams`. `resolveRetryParams` then restores the same 17 fields a
  same-session retry restores. **Probed end-to-end (Probe E):** a registry-seeded foreground
  interrupted run re-dispatches with the recorded task/label/model/thinkingLevel/timeout/gitMode/
  force, and explicit caller values still win.
- **Blast radius:** `src/run-registry.ts` (interface ×2, `mergeInput`, `toRegistryInput`);
  `src/recovery-surface.ts` (`InterruptedRunView`, `collectInterruptedRuns`, `interruptedViewToRun`);
  tests (`run-registry`, `recovery-surface`, `recovery-boot-notice`, `recovery-retry-after-boot`,
  `retry-pins` as a regression); notice copy; optional docs (`AGENT.md`/`README`/`CHANGELOG`).
  **Does NOT touch:** `KNOWN_DELEGATE_KEYS`, `_DelegateParamCoverage`, `resolveRetryParams`,
  `snapshotOriginalParams`, `isInflightRun`'s accept/ignore behavior, the boot scan
  (`recoverInflightRuns`), or `abandonInterruptedRun`.
- **Cost:** M.
- **Risk-if-wrong:** (a) restoring `force: true` across a process/config boundary implicitly
  re-enables an H1 guard override days later; (b) a recorded `cwd` may no longer exist →
  `validateCwd` fails loudly (acceptable: not silent); (c) the registry entry grows by ≤50 KB and,
  because a retry does not retire the source entry (§1.8), that text can persist indefinitely in a
  stale entry.

The brief's two "safety parity" and "full `originalParams` snapshot" alternatives **collapse to
the same change**: `snapshotOriginalParams` *is* the curated retry-settable set, so "persist the
dispatch-affecting params" and "persist `originalParams`" are the same object. O3 is that change.

---
## 3. Recommendation, options table, falsifiers

**Recommendation: Option 3** — persist `task`/`label`/`model`/`thinkingLevel` + `originalParams`
and have the bridge restore all of it. Rationale: the data is already computed and already
persisted elsewhere (session entries, agent records); restoring it makes a post-crash foreground
retry identical to a same-session retry (the contract the retry menu advertises), and explicit
caller params still win. O1/O2 leave a *silent* shape divergence, which is the failure class
issues #227/#229 were written to prevent.

| Option | Mechanism | Blast radius | Cost | Risk-if-wrong |
|---|---|---|---|---|
| **O0** do-nothing | identity-only registry; keep `(task unavailable)` + hint | none | 0 | foreground retry still rejects on empty task / silently uses current config |
| **O1** task-only | `task?` on entry+input, copied in `mergeInput`/`toRegistryInput`, bridge fallback | run-registry.ts, recovery-surface.ts, 3 test files, notice | S | offer looks fixed, but model/thinkingLevel/exec-shape silently default |
| **O2** display+defaults | O1 + `label`/`model`/`thinkingLevel`; bridge uses them, `originalParams` stays `{model,thinkingLevel,background?}` | O1 + view/TUI consumers (improve for free) | M | gitMode/approvalMode/force still default to current config — asymmetric with same-session retry |
| **O3** full snapshot **(rec)** | O2 + `originalParams` wholesale; bridge restores it → 17-field parity | O1 + `InterruptedRunView` + bridge forward; **no** ratchet/param change | M | restores `force` (guard override) across a config boundary; stale `cwd`; ≤50 KB payload with §1.8 lifetime |

### Falsifiers (what would change the recommendation)

1. **If foreground retry post-crash is acceptable to leave weak:** O0 wins. Falsified by the fact
   that a foreground retry with no explicit task is currently a hard error (Probe B) and the U3
   review already flags the offer as weak — the gap is functional, not cosmetic.
2. **If a security review rules that `force` must never be implicitly restored across a process
   boundary:** recommend **O3-minus-`force`** — persist `originalParams` in full but drop `force`
   in `interruptedViewToRun` (and leave explicit `force` caller-only). This is a one-line carve-out;
   it preserves display + all non-override params. The `approvalMode`/`gitMode` restore should stay:
   *not* restoring them is itself a downgrade risk (§1.7).
3. **If the registry's on-disk footprint is a hard constraint** (evidence: tasks near 50 KB and
   interrupted entries that are never abandoned, §1.8): cap the *persisted* task or retire the
   source entry on a successful retry — but note a capped task would re-dispatch a *truncated* task,
   which is worse than today's `(task unavailable)`; prefer fixing §1.8 (retire-on-retry) separately.
4. **If `originalParams.cwd` causes real post-crash validation failures** in practice: drop `cwd`
   from the restored subset (still restore `task`/`model`/`thinkingLevel`/shape params). This is a
   refinement of O3, not a switch to O2.
5. **If someone shows a same-session retry does not actually restore these fields** — disproven by
   `resolveRetryParams` (§1.2) and the `retry-pins` drift guard; would need that test to fall.

---

## 4. Conductor-ready execution sketch (implementer spec, in order)

1. **`src/run-registry.ts` — extend the shape (one file, three functions).**
   - Add optional fields to **both** `InflightRun` and `InflightRunInput`:
     `task?`, `label?`, `model?`, `thinkingLevel?`, `originalParams?: SubagentRun["originalParams"]`.
   - Copy each in `mergeInput` with the existing `if (input.X !== undefined)` undefined-safe pattern
     (never clobber with `undefined`).
   - Map each in `toRegistryInput(run, kind)` from `run.task`/`run.label`/`run.model`/
     `run.thinkingLevel`/`run.originalParams`.
   - **Do NOT** extend `isInflightRun` strictly. Recommended: read each new field through a
     lenient helper (`typeof x === "string" ? x : undefined`; `originalParams` only if it is a
     non-null object) so a tampered field degrades to absent instead of dropping the entry and
     losing the interruption mark. (Precedent: `recoveryPosture` is strict today because dropping
     a bad posture is semantically safe; dropping a task is not the same trade.)
2. **`src/recovery-surface.ts` — consume the fields.**
   - `InterruptedRunView`: add `originalParams?: SubagentRun["originalParams"]`.
   - `collectInterruptedRuns`: extend the fallback chain to
     `run?.<field> ?? agent?.<field> ?? entry.<field>` for `label`/`task`/`model`/`thinkingLevel`;
     set `originalParams: entry.originalParams` (the durable dispatch snapshot). Registry posture
     precedence (`entry.recoveryPosture ?? run?.recoveryPosture`, already tested) is unchanged.
   - `interruptedViewToRun`: `originalParams: view.originalParams ?? { model, thinkingLevel,
     ...(kind === "background" ? { background: true } : {}) }` — keeps the pre-enrichment fallback
     for old entries. `task: view.task ?? ""` unchanged.
3. **Notice copy** (`buildRecoveryNotice`): the parenthetical now applies only to pre-enrichment /
   task-less entries. Keep the "pass `task` explicitly" hint (still correct for those), but soften
   the framing so enriched rows are not described as task-less. No delivery change
   (`nextTurn` stays).
4. **Tests (each option must be pinned; the negative is mandatory).**
   - `run-registry.test.ts`: round-trip — register with all new fields, assert `listInflightRuns`
     returns them; assert `markInterrupted` preserves them; assert an entry written without them
     still parses (old shape).
   - `recovery-surface.test.ts`: `collectInterruptedRuns` fallback order (session > agent >
     registry); synthetic run carries `task` + `originalParams`.
   - `recovery-retry-after-boot.test.ts`: a **foreground/unit** durable-only run (no agent record)
     resolves and re-dispatches with the recorded task/shape — mirroring the existing *background*
     test in that file.
   - **Negative:** an old-shape registry entry (no task) still yields `"(task unavailable)"` and
     still requires an explicit `task` (today's honest caveat).
   - Mutation guards: deleting any one `mergeInput` copy must fail the round-trip; dropping the
     `entry.task` fallback must fail the notice test.
5. **Docs / records.** Update the U3 caveat text (AGENT.md / README if the `(task unavailable)`
   caveat is documented) + CHANGELOG. If Q1 rules "drop `force`", record the decision in
   `.development/decisions/` in the style of the `KNOWN_DELEGATE_KEYS` allow-list decisions.

**Out of scope for this implementation:** U4 resume/re-drive, changing `retireRegistry` on retry
(§1.8 — separate bug), any new `delegate_task` param, any change to `resolveRetryParams` or
`snapshotOriginalParams`.

---

## 5. Open questions (conductor/user must decide)

- **Q1 — `force` on the durable path.** Restore it (full O3 parity; consistent with same-session
  retries and `#227`) or drop it (defense against an implicit H1 override across a config
  boundary)? Recommendation: restore, because the caller explicitly invokes `retryRunId` and
  explicit values win; if a stronger posture is wanted, the fix should be a *visible* confirmation,
  not a silent divergence. **This is the one decision that changes the implementation.**
- **Q2 — uniform persistence.** Write the new fields for all kinds (foreground/unit/background) or
  only foreground/unit? Recommendation: uniform — it is the single choke point, background already
  has the same data in its agent record, and branching invites the exact drift `#108`/`#229` fought.
- **Q3 — stale entry lifetime (§1.8).** A retried interrupted entry is never retired, so its task
  text persists indefinitely and is re-offered every boot. Fix now (retire/`resumeOf`-link the
  source on successful retry) or accept? Recommendation: accept for this change; file separately —
  it is orthogonal to persistence and its own UX/size bug.
- **Q4 — task cap.** Persist the full ≤50 KB sanitized task, or a shorter excerpt? Recommendation:
  full task (an excerpt would re-dispatch a truncated task). If a cap is wanted, it must be
  display-only and the retry must still require an explicit task.
- **Q5 — notice wording.** Should enriched rows say "recorded params recovered", and should the
  `(task unavailable)` hint remain for legacy entries? Recommendation: keep the hint (legacy
  accuracy) but scope it.

---

## 6. Evidence log (claim → probe/read → observed, with coverage)

All probes ran against the real repo modules under `jiti` from `/tmp/fgprobe` (node_modules
symlinked), never modifying repo files. Scratch copies of `run-registry.ts`/`recovery-surface.ts`
with the O3 change applied were typechecked with the repo's `tsc`.

| # | Claim | Probe / read | Observed (expected signature stated first) |
|---|---|---|---|
| A | Adding a field to the registry *input* is NOT automatically persisted — three functions must be extended | `/tmp/fgprobe/probe-registry.mts` (real `registerInflightRun` + extra `task`/`originalParams`); expected: fields DROPPED | on-disk entry `{id,kind,startedAt,cwd}`; `listed task?: undefined`; `originalParams?: undefined` |
| B | `resolveRetryParams` sources: `task`/`label` from top-level run, 15 fields from `originalParams`, `retryOnTimeout` explicit-only | read `src/history.ts:141-192`; probe `/tmp/fgprobe/probe-retry.mts`; expected: enriched bridge restores them, explicit wins | (a) `{"task":"","label":"L","model":"p/m","thinkingLevel":"high"}`; (b) full restore incl. `gitMode:"branch", force:true, timeout:4242`; (c) explicit `task:"NEW", gitMode:"none", force:false` wins |
| C | The U3 bridge ignores `task`/`label`/`model`/`thinkingLevel`/`originalParams` even if present on the registry entry | `/tmp/fgprobe/probe-bridge.mts` (`visibleRunEntries`); expected: synthetic task stays `""` | `[{"id":...,"task":"","model":"unknown","thinkingLevel":"unknown",...,"originalParams":{}}]` despite entry carrying all five |
| D | Additivity is safe both directions | `/tmp/fgprobe/probe-additive.mts`; expected: old reader parses new entry, new reader parses old entry | (1) old reader sees entry, `task: T`; (2) new reader sees entry, `task: undefined`, `orig: undefined` |
| E | The full O3 change typechecks and behaves end-to-end | `/tmp/fgprobe/changed/` (patched copies) + `driver.ts`; `tsc -p` expected: EXIT 0; runtime expected: registry→bridge→retry restores everything | `tsc EXIT:0`; runtime restored `task:"RECOVER ME"`, `label:"LBL"`, `model:"p/m"`, `thinkingLevel:"high"`, `timeout:4242`, `gitMode:"branch"`, `force:true` |
| F | Registry entry fields today | read `src/run-registry.ts` `InflightRun` | id, dispatchId?, attempt?, kind, owner?, childMarker?, recoveryPosture?, startedAt, cwd, interruptedAt? (10) |
| G | `mergeInput`/`toRegistryInput` are the copy points | read `src/run-registry.ts` (`mergeInput`, `toRegistryInput`) + Probe A | fixed field copies; extra input keys dropped |
| H | `resolveRetryParams` production call sites | `grep -rn "resolveRetryParams(" src/*.ts` | 2 hits: definition `src/history.ts:141` + use `src/index.ts:2965` |
| I | Registry retires only on terminal settle or abandon | `grep -rn "clearInflightRun(" src/*.ts` + `grep -n retrySourceRun src/index.ts` | clear: `src/run-registry.ts:274` (terminal), `src/index.ts:4079` (abandon); `retrySourceRun` never clears → stale interrupted entry persists across retries (§1.8) |
| J | Boot mark preserves existing fields | read `markInterrupted` (`src/run-registry.ts`) + wiring `src/index.ts:3989-3994` + `runBootScan` (`src/recovery.ts`) | `writeAtomic(file, { ...existing, interruptedAt })`; scan only adds the mark |
| K | Privacy: registry owner-only + gitignored; task-text precedent | read `.gitignore:11` (`.pi/*`), `writeAtomic` (`mode 0o600`), `ensureDir` (`0o700`), `persistAgent` (`src/session-manager.ts:185-191`), `sanitizeTask` (`MAX_TASK_LENGTH = 50_000`) | ignored; 0o600/0o700; background records already persist `task`; 50 KB bound |
| L | No ratchet/param surface is touched | read `KNOWN_DELEGATE_KEYS` (25 keys, `src/params.ts`), `_DelegateParamCoverage` (`src/index.ts:198`), `retry-pins.test.ts` "snapshot↔resolve key-set drift guard" | no new delegate param; snapshot/resolve key sets unchanged |
| M | The current caveat is a hard error, not just weak display | Probe B(a); read sanitizer branch `src/index.ts:2988-3000` | retry with empty task → `Invalid task: Task must not be empty.` |
| N | TUI retry/history surfaces consume the bridge and would improve for free | read `src/tui.ts:1132-1134`, `:2058`, `:2067`, `src/tui-format.ts:61` (`runDisplayName`), `buildRetryOfferMessage` | both read `recoverableRunEntries` → `visibleRunEntriesForSession`; names derive from `label`/`task` |
| O | `resolveRetryParams`'s native home is `history.ts`, not `index.ts` | `grep -rn "resolveRetryParams" src/*.ts` | definition in `src/history.ts`; brief's pointer corrected |

### Coverage notes

- **Probe A** used the API's `_` prefix: `registerInflightRun` was called through a cast because the
  new fields are not yet in `InflightRunInput`; this tests the *read/merge* path, exactly the claim.
- **Probe E** typechecked a patched copy in `/tmp` with the repo `tsconfig` options
  (`strict`, `erasableSyntaxOnly`, `moduleResolution: bundler`); `tsc` exited 0. No repo file was
  written.
- **Not probed (reasoned from source):** the live subprocess dispatch (`runSubagent`) was not
  spawned; Probe B/E stop at the `resolveRetryParams` boundary that the retry branch feeds into,
  which is where the gap is. The end-to-end extension drive is covered by the existing
  `recovery-retry-after-boot.test.ts` harness (background variant) and should be extended per §4.4.
- **Search coverage:** `grep -rn "resolveRetryParams(" src/*.ts` → exactly 2 non-test sites (1 def,
  1 call). `grep -rn "clearInflightRun(" src/*.ts` → 2 non-test sites. `grep -n "retrySourceRun"
  src/index.ts` → 6 sites, none clearing the source entry.



---

## 7. Decision (2026-10-11, maintainer)

**APPROVED: O3 — full snapshot, `force` RESTORED.** The maintainer ruled for parity with same-session retries
over the O3-minus-`force` carve-out. For the record: the Jev classifier, run on the decision out of curiosity,
chose **O3m** (`force` carved out; guard-boundary driver, prob 0.95/conf 0.94) — i.e. the proposal's falsifier #2
— and the maintainer consciously overrode it, reasoning that a documented silent divergence from the advertised
retry contract is the class #227/#229 fought, and that the caller explicitly invokes `retryRunId` with explicit
values winning. Jev is a task-calibration classifier, not a security reviewer; its output is advisory context,
not authority.

**Also approved (folded in, per the conductor's proposal):** fix the stale-entry lifetime (§1.8) in the same
change — a successful retry retires the source registry entry so the old interrupted run is not re-offered at
every subsequent boot; a FAILED retry start must leave the source interrupted and retryable.

**Implementation spec:** to be drafted by the conductor from §4 plus the fold.

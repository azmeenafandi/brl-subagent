# 0024. The unit projection of the pre-flight: a batch unit's own declared deadline is dropped

- **Status:** Accepted
- **Date:** 2026-11-07
- **Issues:** #434, #431, #412, #415, #443
- **Supersedes:** ADR 0022's deferral sentence — "per-unit dimensions (`timeout`, `thinkingLevel` on each unit,
  with `mergeSubTaskParams` letting the unit value win) have **no per-unit pre-flight** — filed as #434" — and the
  chain/graph exemption, but **only** for pairs a unit declares itself. Both records stay Accepted for everything
  else; inherited pairs keep the exemption (clause 5 below).

## Context

ADR 0022's arms judge the **dispatch-level** pair: `declaredThinkingLevel(params…)` and `params.timeout`. Batch
units carry their own (`schema.ts`'s step fields) and `mergeSubTaskParams` lets the unit win per field, so a
`tasks`/`chain`/`graph` unit declaring `thinkingLevel: "high"` + `timeout: 600000` under a dispatch with no
top-level pair reproduced the 2026-11-06 incident for that unit alone: `resolveThinkingDispatchSwitch` exits on
its first clause (`params.timeout === undefined`), and every unit site then handed `merged.timeout` to
`runSubagent`. The deferral was recorded, not hidden; the hazard was named in the issue and the ADR.

The reverse argument for leaving it deferred (an uncapped batch multiplies one hang across N units) is the
argument for fixing it **per unit** rather than at dispatch level: what multiplies is the number of deadlines,
and a per-unit judgement removes exactly those.

## Decision

One predicate, `shouldDropUnitTimeout` (`src/params.ts`), beside the dispatch predicate and documented as its
unit projection. It answers a boolean and is eligible when **all** hold:

1. `processChecks` — **threaded** from `execute`, never re-read at a unit site.
2. `force !== true` — the override reaches units.
3. the **effective declared** level is `high`/`xhigh`: the unit's own, else the dispatch's declared level, which
   the unit inherits. Never `merged.thinkingLevel`, which is **capped** (`off` by default) — judging it would
   disable the guard exactly where nobody configured a cap (#443 is the same drift one level up).
4. the **merged** timeout is defined and `> 0` — only a positive timeout arms a foreground timer.
5. the unit **declares** the pair: a non-empty `thinkingLevel`, or `timeout` present (`0` included: it is a
   declaration that overrides an inherited value, and clause 4 refuses it because it arms nothing).
6. the unit's shape is **foreground**, passed explicitly.

Only the **drop** arm exists per unit. A unit cannot become its own background dispatch — it is one spawn inside
a batch the caller already shaped — so the switch/drop-timeout approval reasoning is not restated, and no verdict
here may move a shape.

`applyUnitShapeGuard` (`src/index.ts`) applies the effect — `merged.timeout = undefined` — at the four unit sites
from a `BatchGuardContext` threaded out of `execute` (`processChecks`, the dispatch's declared level, `force`, the
unit shape, and a one-shot notice flag). Ordering rules, each pinned by a test:

- the drop lands **before** `createUnitRun`/`startBackgroundAgent`, so the retry snapshot records an absent
  deadline and a retry re-derives instead of restoring the cap (ADR 0009);
- it lands **after** the unit holds its concurrency slot and immediately before its run, so a unit a cancellation
  can still skip is never announced;
- at most **one** additional notice per dispatch, suppressed entirely when a dispatch arm already announced (the
  drop still happens — the deadline is the hazard, the notice is the report). `THINKING_UNIT_TIMEOUT_DROP_NOTICE`
  names the unit it is attached to and states that later units are judged later; it claims no completeness;
- one `log.info` per affected unit.

## Alternatives rejected

- **Widen `resolveThinkingDispatchSwitch` to look at units.** The issue forbids it and the shape does not exist
  yet at that point (units are merged per handler); it would also have to invent an aggregate verdict for N
  heterogeneous units.
- **Switch a unit to background.** A unit is not a dispatch: `background` is a dispatch-level shape, the
  chain/graph gates reject it, and the fan-out path already owns the detached case.
- **Re-read `processChecks` at the unit site.** Measured: a dispatch with a relative `params.cwd` resolves the
  manifest against `ctx.cwd`, while a unit-site re-read resolves it against the process cwd and reads `false`.
  Two answers to one question is the drift #361's resolver extraction exists to prevent.
- **Judge `merged.thinkingLevel`.** It is capped; with the default cap `off`, the guard would never fire.
- **A notice per affected unit.** N agents writing N lines for one decision; the fan-out default would multiply
  it further. The one-notice rule is the dispatch arms' existing discipline, extended.

## Consequences and limits

- In an opted-in project, a batch unit that declares its own high/xhigh pair loses its deadline and stays
  foreground. Inherited pairs keep ADR 0022's behaviour, including the chain/graph exemption — the #434/#431
  boundary is clause 5, and it is pinned by both a positive and a negative test.
- Background fan-out units are untouched by construction: there the deadline is the legitimate 30-minute budget,
  and removing it would subtract a bound rather than add durability.
- `force` remains dispatch-wide: there is no per-unit escape, because a batch's collision of shapes is the
  caller's statement, not one unit's.
- **The notice cannot be complete.** It is emitted at the first affected unit's run, so a later affected unit is
  not named, and a unit cancelled while queued is never mentioned. The wording says so; a reader must not treat
  the absence of a line as proof that no other unit was affected.
- A unit's declared pair can still be overridden by nothing at the unit level: if a preset could carry a
  `timeout`, the drop's "no deadline" guarantee would inherit ADR 0022's MAJ-7 invariant hazard.
- Pinned by: the runner's deadline argument at each of the four sites, the persisted unit snapshot plus the
  retry's second runner call (order), the notice count/mixed case, and a paired eligibility matrix against
  `resolveThinkingDispatchSwitch` whose two documented divergences (a `timeout: 0`, and a unit that declares
  neither field) are asserted on **both** sides so a one-sided edit fails.

**Falsifier.** A dispatch in a `processChecks`-on project whose *unit* declares `high`/`xhigh` + a positive
`timeout`, runs foreground, and is killed by that deadline.

**Reversal trigger.** A project reporting that the unit arm cost it a run it wanted capped: the remedy is
`force: true` per dispatch, or a per-unit override designed with its own ADR — not restoring the deferred hole.

# Plan critique — issue #431 (pre-flight second arm, design B) + folded #433

Tree: brl-subagent-dev @ `02ea23a` (HEAD at review time). All claims below were
checked with real commands against this tree; the raw evidence bank is
`/tmp/review-431-findings.md`.

## Verdict

**AMEND** — the design is sound and correctly grounded (layer choice, ordering,
retry semantics, transport-retry honesty all verify), but the spec as written
ships one false doc statement, contradicts itself in the verdict table's force
row, names two mutants (M5, M7) whose killers are absent from its own
acceptance, and leaves three load-bearing facts unnamed (the preset-timeout
invariant, the budget-cap/hang rationale, the per-unit fan-out bypass). None of
this invalidates design B; all of it is cheap to fix in the spec before dispatch.

Blocking: 0. Major: 9. Minor: 5. Optional: 3.

## Findings

### Major

**MAJ-1 — The verdict table's force row contradicts its own none rows.**
Spec table row 6: "any of the above with `force: true` → `forced`". Rows 4–5
return `none` unconditionally (omitted+auto; `background: true`). A literal
implementation returns `"forced"` for `background: true` + `force: true`, and
the call site's forced arm logs *"Dispatch pre-flight: high-thinking foreground
forced"* (`src/index.ts:2805-2812`) — a false log line for a BACKGROUND run.
Today force is only reachable after `explicitBackground !== false` exits
(`src/params.ts:252`), so no such state exists yet; the spec creates it.
The spec's own note ("force on **the new arm** … outcome identical: foreground,
timeout kept") shows the intent is force-on-acting-arms only.
Fix: precedence rule — `force` maps `switch`/`drop-timeout` → `forced`; arms
that compute `none` stay `none` regardless of force. Pin it (see M8).

**MAJ-2 — "No change to the delegate_task description / no user-facing docs" is
already false: `src/schema.ts:220-235` documents the pre-flight and goes stale.**
The shipped `background` parameter description says: "ONE pre-flight exception
exists … a high/xhigh-thinking dispatch with background: false AND an explicit
timeout **is switched to background** and the explicit timeout is dropped".
Post-#431 that sentence is false for `always` (#433: it stays foreground) and
incomplete for omitted-background dispatches (second outcome, second notice).
This text ships to every user's model context (it is the tool schema), and this
repo treats doc drift as a CI class (ADR 0012). The spec's own citation
(SKILL.md:335 "never documented as a user-facing feature") does not cover this:
the flag is already named in the schema descriptions (`noJev`, schema.ts:214;
`background`, schema.ts:228) as exception context, and no test pins the string
(verified: `grep -rn "pre-flight exception" src/__tests__` → 0 hits), so the
update is cheap. SKILL.md's Rule 2 paragraph (:327-336, "a high/xhigh dispatch
with background: false and an explicit timeout is auto-switched to background")
goes stale the same way — and it, not the Rule 18 dispatch-parameter clause
(:228-238, which never mentions enforcement), is where the spec's SKILL.md
delta belongs.

**MAJ-3 — M5's killer does not exist in the acceptance.**
M5 = "`params.timeout` not cleared before the snapshot". The acceptance's
handler proof (#3) observes "no deadline" via the runSubagent timeout arg —
which an order-mutant (clear AFTER `snapshotOriginalParams`, before the spawn)
still passes: the run has no deadline, but the foreground record at
`src/index.ts:3035` restores the cap to every retry (`resolveRetryParams`,
`src/history.ts:203`). The only snapshot pins that exist are switch-arm,
spawn-arg based (`dispatch-preflight.test.ts:378-408` reads
`spawnBackgroundSession` args; the foreground record never flows through that
seam). No proposed test reads the foreground record. Fix: acceptance must add a
snapshot pin — spy `pi.appendEntry` (the harness stubs it, 
`dispatch-line-enforcement.test.ts:147`) or use the `capturedEntries` +
`retryRunId` re-dispatch pattern (:191, :513) — asserting
`originalParams.timeout === undefined` AND `originalParams.background === false`.

**MAJ-4 — M7's killer does not exist in the acceptance either.**
M7 = "predicate reads the approval mode from `params` only, ignoring the config
default" → killer "a test whose mode comes from `state.config`". But both
handler tests in acceptance #3 pass `approvalMode` as a CALL PARAM
(`'writes'`, `'always'`), and the pure predicate tests receive
`effectiveApprovalMode` pre-resolved — they cannot kill a call-site that
skips `resolveEffectiveApprovalMode`. Fix: add a config-seeded handler test
(`seedConfig(ctx, { approvalMode: "always" })` pattern,
`background-default.test.ts:209`) with NO `approvalMode` param: omitted
background + high + timeout → foreground, no deadline; and explicit-false
variant → not rejected (#433 through the config tier).

**MAJ-5 — "its approval gate is unchanged" (acceptance #3) has no observable
seam in the named harness — vacuous-assertion risk.**
The foreground gate is `shouldPrompt = ctx.hasUI !== false && (mode === "always"
|| (mode === "writes" && hasChanges))` → `showApprovalDialog`
(`src/index.ts:3344-3353`), reachable only under the gitMode-branch workflow.
The test harnesses set `hasUI: false` and dispatch without gitMode, so the
dialog branch never executes; an assertion "gate unchanged" written against it
asserts nothing. The honest observables that kill M2 (arm also sets
background=true): `spawnBackgroundSession` NOT called, `runSubagent` called,
`result.isError` falsy, result text lacks "Cannot spawn background agent"
(the always case), and no "auto-approving" `log.warn` (the writes case,
`src/index.ts:2294-2299`). The spec should list these instead of the
unobservable phrase — or state that the dialog seam stays covered by
`git-auto-approve.test.ts` and is out of scope here.

**MAJ-6 — Table row 4's "(already durable)" is false as a record, and ADR 0022
would enshrine it.**
A background run killed by its explicit deadline is NOT retained: the settle-time
retention gate is `isTransportRetryable` (`src/transport-retry.ts:88-97` —
transport signature + attempt 1 + `originalParams.background === true`; issue
#404 scoped retention to exactly that class). FRICTION_LOG.md:37 (2026-08-23)
is the counterexample on record: a BACKGROUND agent timed out at 600s, "its
session was unrecoverable". Row 4's honest rationale: background deadline-kills
are a deliberately-capped separate class (explicit timeouts honored verbatim —
issue #240, ADR 0008; Rule 18's 2h maintainer cap is the process answer), not
"already durable". The distinction matters because the 2026-08-23 recurrence is
half of the Rule 11 P0 count that justifies this issue.

**MAJ-7 — Unnamed invariant: `params.timeout = undefined` means "fall back to
`preset?.timeout`", not "no deadline".**
`resolveSubagentParams` merges `normalizeTimeout(params.timeout ??
preset?.timeout)` (`src/params.ts:379`). The drop arm's hazard-removal and its
notice claim ("no clock can kill the run") hold ONLY because no preset can
carry a timeout at runtime: `presetFromFrontmatter` (`src/presets.ts:81-95`,
shared by both preset tiers) maps no `timeout` field, making
`SubagentPreset.timeout` (`src/types.ts:155`) dead. If preset-timeout mapping
is ever added, the arm silently no-ops (the drop re-merges the preset's value)
and the notice becomes a lie — with no test failing. The spec relies on this
and never states it. Fix: name it in ADR 0022 and the predicate docblock;
optionally pin it (presets-files test: frontmatter `timeout` does not map).

**MAJ-8 — Per-unit fan-out bypass: the hazard class survives inside `tasks`/
`chain`/`graph` units, and the spec neither covers nor non-goals it.**
Units declare their own `timeout` (STEP_TAIL_FIELDS, `src/schema.ts:43-53`) and
`thinkingLevel` (schema.ts:27-29); `mergeSubTaskParams` (`src/index.ts:471`)
lets the unit value win, and each foreground unit runs `runSubagent` with
`merged.timeout` (`src/index.ts:1062,1097`). A `tasks` fan-out under `writes`
(effective shape foreground) with per-unit `thinkingLevel: "high"` +
`timeout: 600000` and NO top-level timeout/thinking reproduces the incident per
unit — the predicate exits early (top-level `timeout === undefined`,
top-level thinking undefined). The spec's verdict table has no unit dimension
and its non-goals don't mention it. Fix: explicit non-goal + follow-up issue
("per-unit pre-flight"), or extend; do not leave the class silently uncovered
after an issue whose premise is "the mechanical check missed a state".

**MAJ-9 — The budget-cap/hang objection is never answered; the ADR content list
is insufficient.**
The spec defends design B with "the shape does not move" — that answers ADR
0018's approval-dialog rationale for the exemption, but NOT the #415/ADR 0019
rationale that gated the switch: "a user's explicit foreground timeout is
usually a budget cap" (ADR 0019 Context). The new arm overrides that cap with
something strictly more aggressive than the shipped arm: the switch arm
replaces the cap with a 30-minute background default; the drop arm leaves NO
bound at all, and the caller's tool call blocks until the child settles — also
removing the hang protection the tool description itself sells ("Useful for
tasks that might hang or get stuck", `src/index.ts:2526`). The cover exists and
is adequate — processChecks opt-in, the notice, `force: true`, and Rule 18's
dispatch-parameter clause (SKILL.md:228-231) already makes a foreground timeout
a process violation in opted-in projects — but the spec names none of it, and
its ADR 0022 bullet ("why the exemption's reasoning survives (the shape does
not move)") would record an incomplete argument the next maintainer re-litigates.
Fix: ADR delta D5 below; optionally one honest clause in the notice.

### Minor

**MIN-1 — Two existing pins must be amended and the spec doesn't name them.**
(a) `dispatch-preflight.test.ts:308-315` ("never switches an omitted or
explicit-true background") — the omitted half flips under the new arm, and the
test's `base` input lacks the new required `effectiveApprovalMode` (compile
break; forced update — fine, but "Regressions pinned unchanged" in acceptance
#4 must not be read as "don't touch"). (b) `:487-510` ("high thinking with an
omitted background keeps the existing default") — passes unchanged ONLY because
it never calls `optIn()` (verified: the temp env is rm+recreated per test,
`fixtures/temp-lifecycle.ts:75-84`, so no manifest → processChecks off). Its
comment ("the #412 switch does not fire because the caller never asked for
foreground explicitly") is therefore already misleading, and its opted-in twin
IS the new arm's handler test. Rename/re-comment as the processChecks-off pin;
add the opted-in twin.

**MIN-2 — The chain/graph exemption is carried over without re-derivation.**
ADR 0018's reason was switch-specific ("they block and reject background:
true"). Drop-timeout is perfectly applicable to a blocking batch — the drop arm
doesn't move shape either. Keeping the exemption is defensible (an uncapped
chain multiplies the hang across N units with no per-unit pre-flight — see
MAJ-8), but ADR 0022 must state the reason, not inherit a rationale that no
longer applies.

**MIN-3 — Notice mechanics underspecified.** The switch arm emits on TWO
channels: `pi.sendMessage(..., { deliverAs: "followUp" })` (reaches the
conductor LLM) and `ctx.ui.notify(..., "warning")` (reaches the human)
(`src/index.ts:2797-2803`). "It emits its own notice" should say: same dual
channel; export the literal from params.ts (e.g. `THINKING_TIMEOUT_DROP_NOTICE`)
so M6's killer pins the exact string on both channels (pattern:
`dispatch-preflight.test.ts:373-376`); and carry the ACTUAL dropped value in
`details` (`previousTimeout: <ms>`, plus `effectiveApprovalMode`) — the switch
arm's `previousTimeout: "dropped"` (index.ts:2801) throws the number away, and
the friction log needed exactly that number.

**MIN-4 — ADR mechanics.** ADR 0022 needs (a) a `Supersedes:` header line
naming ADR 0018 §1's omitted-background exemption bullet (precedent: 0019 and
0020 both carry one) and (b) `npm run docs:decisions` after adding it —
`decisions-index.test.ts:11-19` fails a stale generated index (README: "edit
the records, not this block").

**MIN-5 — `retryOnTimeout` silently becomes inert on the drop arm.** The
foreground timeout-retry (`src/index.ts:3259-3262`) can never fire once the
deadline is dropped, so a caller who passed `retryOnTimeout: true` + an
explicit timeout gets a durability mechanism they asked for replaced by one
they didn't. Defensible (a foreground timeout retry restarts from zero — it
preserves nothing, which is rule 2's whole point), but it is an override of a
declared intent and deserves one line in ADR 0022 (or: treat
`retryOnTimeout: true` as force-equivalent — a design question, see Open
questions).

### Optional

**OPT-1 — Wrong ratchet cited.** The spec justifies "use `defaultBackgroundFor`,
don't re-spell" with `_ResolveInputCoverage` — that type ratchets SCHEMA-KEY
coverage of `ResolveInputParams` (`src/index.ts:300-322`), not condition
duplication. The instruction is right; cite DRIFT-precedent #361 (the resolver
extraction, params.ts:327-338 comment) instead.

**OPT-2 — The AGENT.md question is answerable now; answer it in the spec.**
`package.json` `files[]` (:13-21) includes `AGENT.md` → it ships in the tarball
→ by the spec's own rule, the flag stays out of it. Verified AGENT.md mentions
neither processChecks nor the pre-flight today (only the transport-retry
behavior, :44). Write the derived answer down so the implementer doesn't
re-litigate it.

**OPT-3 — Degenerate timeout values.** `timeout: 0` / negative / NaN / ≥2^31-1
pass the `timeout === undefined` exit and are dropped harmlessly
(`normalizeTimeout` nulls them anyway, `validate.ts:517-524`); on the forced arm
the log claims a "kept" timeout that would never arm. Pre-existing nuance from
the switch arm; no action needed, one comment line at most.

## Amended spec deltas (paste-ready)

**D1 — replace table row 6 with a precedence rule (MAJ-1):**
> `force: true` on an arm that would otherwise return `switch` or
> `drop-timeout` → **`forced`** (override honoured, timeout kept, log-only).
> Arms that compute `none` (`background: true`; omitted + effective `auto`)
> return `none` regardless of `force` — there is nothing to override, and the
> forced log line ("foreground forced") must never print for a background run.

**D2 — predicate body sketch that satisfies the table unambiguously (MAJ-1, MAJ-7):**
```ts
export function resolveThinkingDispatchSwitch(input: {
    processChecks: boolean;
    thinkingLevel: ThinkingLevel | undefined;
    explicitBackground: boolean | undefined;
    timeout: number | undefined;
    force: boolean | undefined;
    shape: DispatchShape;
    effectiveApprovalMode: ApprovalMode;
}): ThinkingDispatchSwitch {
    if (!input.processChecks) return "none";
    if (input.shape === "chain" || input.shape === "graph") return "none";
    if (input.thinkingLevel !== "high" && input.thinkingLevel !== "xhigh") return "none";
    if (input.timeout === undefined) return "none";
    const base: ThinkingDispatchSwitch =
        input.explicitBackground === true
            ? "none"
            : input.explicitBackground === false
                ? (approvalBlocksBackground(input.effectiveApprovalMode) ? "drop-timeout" : "switch")
                : (defaultBackgroundFor(input.shape, input.effectiveApprovalMode) ? "none" : "drop-timeout");
    if (base === "none") return "none";
    return input.force === true ? "forced" : base;
}
```
with the `always` guard expressed through ONE shared helper, not a re-spelled
`=== "always"` in two modules (the M3 mutant then has a structural killer —
drift becomes a single edit site):
```ts
// types.ts (leaf module — prelude.ts:49 and params.ts both already import it; no cycle)
/** The approval modes that make a background spawn impossible (W5, issue #28). */
export const approvalBlocksBackground = (m: ApprovalMode): boolean => m === "always";
```
`rejectApprovalAlwaysInBackground` (prelude.ts:142) and the predicate both
consume it. Docblock addition: "The omitted-background arm keys on the EFFECTIVE
SHAPE via `defaultBackgroundFor`, never on a re-spelled mode list. Its
no-deadline guarantee relies on `preset?.timeout` being unreachable at runtime
(`presetFromFrontmatter` maps no timeout); if presets ever carry one, this arm
must merge it before deciding."

**D3 — docs surfaces (MAJ-2, MIN-2, MIN-4, OPT-2), replacing the spec's §3 list:**
1. ADR 0022 with header `Supersedes: the omitted-background exemption bullet of
   ADR 0018 §1` + run `npm run docs:decisions` (decisions-index.test.ts fails
   a stale index).
2. `src/schema.ts` `background` description: rewrite the pre-flight-exception
   sentence for two outcomes (switch for auto/writes explicit-false;
   drop-timeout for always explicit-false and for omitted-background gated
   foreground), keeping the existing "only in a project that opted into its own
   process checks" framing (the noJev description is the precedent for naming
   the flag in exception context).
3. SKILL.md Rule 2 paragraph (:327-336): the enforcement sentence gains the
   second outcome. The Rule 18 dispatch-parameter clause needs NO change (it
   already says foreground dispatches omit the timeout — the new arm mechanizes
   it; say so in Rule 2, not there).
4. AGENT.md: unchanged — derived now: it ships in the tarball
   (package.json files[] :13-21) and carries no pre-flight text today.

**D4 — notice constant + text + channels (MIN-3, MAJ-9):**
> Export `THINKING_TIMEOUT_DROP_NOTICE` from params.ts. Emit on BOTH channels
> the switch arm uses (`pi.sendMessage` followUp + `ctx.ui.notify` "warning"),
> with `details: { thinkingLevel, previousTimeout: <the actual ms value>,
> effectiveApprovalMode }`. Text: the explicit timeout was dropped; the run
> stays foreground because its effective approval mode needs the interactive
> dialog; foreground runs have no default deadline, so no clock kills the run —
> the conductor's call blocks until the child settles; pass `force: true` to
> keep the explicit timeout.

**D5 — ADR 0022 content, replacing the spec's one-line bullet (MAJ-6, MAJ-7, MAJ-9, MIN-2, MIN-5):**
> Records: (a) the second arm and the #433 guard ("never switch into a
> rejection"); (b) why the exemption's approval-dialog reasoning survives (the
> shape does not move) AND, separately, the budget-cap objection (#415/ADR
> 0019): the arm overrides an explicit cap with NO bound — justified by the
> processChecks opt-in, the notice, `force`, and Rule 18's clause that a
> foreground timeout is already a process violation in opted-in projects; the
> hang-protection trade-off (a dropped deadline removes the only clock on a
> possibly-hung child) is stated, not hidden; (c) row-4 scoping: background
> deadline-kills are a separate deliberate class (explicit honored verbatim —
> #240/ADR 0008; retention is transport-only — #404; the 2026-08-23 recurrence
> was answered by Rule 18's 2h cap in prose); (d) the preset-timeout invariant
> (MAJ-7); (e) chain/graph stay exempt because an uncapped batch multiplies the
> hang across N units with no per-unit pre-flight; (f) `retryOnTimeout` becomes
> inert on the drop arm, deliberately (a foreground timeout retry restarts from
> zero — it preserves nothing); (g) the falsifier: a processChecks-on dispatch,
> background omitted, effective mode writes/always, high/xhigh, explicit
> timeout, that ends with a deadline-kill of a foreground run.

**D6 — non-goal addition (MAJ-8):**
> Per-unit dimensions are out of scope: `tasks`/`chain`/`graph` units carrying
> their own `timeout` + `thinkingLevel` bypass this per-dispatch predicate
> (mergeSubTaskParams lets the unit value win). Follow-up issue filed:
> "per-unit dispatch pre-flight" — the class is known, not silently uncovered.

## Mutant additions

The spec's M1–M4, M6 stand as written (their killers exist once acceptance
amendments A–C land). M5 and M7 stand ONLY with the amendments (their named
killers do not exist today — MAJ-3/MAJ-4). Add:

- **M8** force leaks onto a none arm (`background: true` + `force: true` → `"forced"`,
  or omitted+auto+force → `"forced"`) → killed by the new pure pins: both return
  `"none"` and the handler emits no forced log line (D1).
- **M9** the order mutant M5 actually needs: timeout cleared for the RUN but
  AFTER `snapshotOriginalParams` (run deadline-free, snapshot keeps the cap) →
  killed ONLY by amendment A's foreground-record snapshot pin (arg-8 assertions
  cannot see it).
- **M10** drop arm clears the timeout but emits no notice (silent drop) → killed
  by the exported-constant notice pin asserting presence on BOTH channels
  (sendMessage followUp + ui.notify), plus absence of `THINKING_SWITCH_NOTICE`.
- **M11** drop arm fires with processChecks OFF → killed by a USER-PATH-style
  handler pin using the OMITTED shape (the existing off-pin at
  dispatch-preflight.test.ts:516 uses explicit-false): no manifest → arg-8
  timeout preserved verbatim, no notice.
- **M12** the #433 guard re-spelled as a literal `=== "always"` in the predicate
  while `rejectApprovalAlwaysInBackground` drifts (e.g. gate later also rejects
  another mode) → structurally killed by the shared `approvalBlocksBackground`
  helper (D2); without the helper, pin both sites against the one constant.
- **M13** call site computes the new arm from `params.approvalMode` raw instead
  of `resolveEffectiveApprovalMode(params.approvalMode, state)` (the call-site
  twin of M7) → killed by amendment B's config-seeded tests (call param absent;
  mode only in state.config).

## Acceptance amendment

Replace/augment the spec's acceptance items 1–3 with:

**A. Foreground-record snapshot pin (kills M5/M9).** processChecks on, omitted
background, `approvalMode: 'writes'` (call param), high, `timeout: 600000` →
capture the foreground run record (spy `pi.appendEntry`, or the
`capturedEntries` seam of dispatch-line-enforcement.test.ts:191) and assert
`originalParams.timeout === undefined` AND `originalParams.background === false`
(the effective-shape recording at index.ts:2849 stays honest). Stronger twin:
re-dispatch with `retryRunId` (pattern :513) → still foreground, arg-8
`undefined`.

**B. Config-tier pins (kills M7/M13).** Same dispatch with NO `approvalMode`
param and `seedConfig(ctx, { approvalMode: "always" })` (background-default
harness :209) → not rejected, foreground, arg-8 `undefined`; and with seeded
`"writes"` + omitted background → foreground, arg-8 `undefined`. These prove the
effective mode reaches the predicate from `state.config` through the single
resolver.

**C. "Approval gate unchanged" restated as observables (MAJ-5).** For the writes
case: `spawnBackgroundSession` not called; `runSubagent` called once;
`result.isError` falsy; no "auto-approving" warn (background path never
entered). For the always case: result text does NOT contain "Cannot spawn
background agent with approvalMode 'always'". The `showApprovalDialog` seam
(index.ts:3344-3353, needs gitMode branch + hasUI) stays covered by
git-auto-approve.test.ts and is out of scope for these tests.

**D. Force matrix (kills M8, pins the spec's logging change).** Pure: force on
each arm — explicit-false+auto/writes → `forced`; explicit-false+always →
`forced`; omitted+writes/always → `forced`; omitted+auto → `none`;
explicit-true → `none`. Handler: one omitted+writes+force dispatch → arg-8
timeout preserved, forced log line, NO notice on either channel.

**E. Existing-pin deltas named (MIN-1).** dispatch-preflight.test.ts:308-315 is
REWRITTEN (omitted half becomes mode-dependent; `base` gains
`effectiveApprovalMode`); :487-510 is re-labelled as the processChecks-off pin
(comment fixed) and its opted-in twin becomes the new-arm handler test.
"Regressions pinned unchanged" applies to: auto dispatches, explicit-true,
chain/graph, processChecks-off USER-PATH (:516), and the shipped explicit-false
+ auto/writes switch arm.

**F. Notice-text pin (kills M6/M10).** `THINKING_TIMEOUT_DROP_NOTICE` exported
from params.ts; test asserts the exact constant on both channels and asserts
`THINKING_SWITCH_NOTICE` was NOT emitted on the drop arm (its "the run is now
background" sentence is the lie the spec forbids).

Items 4–5 of the spec's acceptance (regressions, `npx vitest run` +
`npm run typecheck`) stand; add `npm run docs:decisions` freshness to the PR
checklist (decisions-index.test.ts).

## Open questions the plan should answer (with recommendations)

1. **`retryOnTimeout: true` + explicit timeout on a drop-arm dispatch** — drop
   anyway, or treat the flag as force-equivalent (the caller declared a
   deadline-and-retry intent)? Recommendation: drop anyway (a foreground
   timeout retry restarts from zero — it preserves nothing, which is rule 2's
   premise) and record it per MIN-5/D5(f). This is derivable now; it is listed
   only because the spec is silent and the maintainer owns intent-override policy.
2. **Per-unit follow-up issue number** — MAJ-8's non-goal needs the issue filed
   at PR time so the non-goal is a deferral, not a hole.

## Derived answers (not left open)

- **Does the pre-flight see retry-restored values?** Yes — the `retryRunId`
  merge (index.ts:2663-2680) and template resolution (:2645-2653, which can set
  `params.timeout`) both run BEFORE the switch (:2777). Restored
  `{background:false, timeout:undefined}` exits early → the arm is idempotent;
  no re-apply is needed or wanted.
- **Is `background` coercion a missing table state?** No — probed through the
  real validator (`/tmp/probe431/coercion2.mjs`, pi-ai `validateToolArguments`
  against the shipped schema): `"false"`/`"true"`/`0`/`1` all arrive as real
  booleans; garbage `approvalMode` strings pass the schema but
  `resolveEffectiveApprovalMode` falls back to config, and config is sanitized
  to the 3-enum at load (state.ts:342-345). The effective mode at the predicate
  is always one of the three — PROVIDED the call site feeds it from the resolver
  (what M7/M13 guard). The `background: true` row should be implemented as the
  else-bucket (non-false, non-undefined → `none`), matching
  `shouldRejectBackgroundForBatch`'s strict `=== true` philosophy.
- **Is `forced` on the new arm harmless?** Yes as log-only (outcome identical:
  foreground, timeout kept) — given D1's precedence fix; without it, it is a
  false log line on background runs (MAJ-1).
- **Is the predicate the right layer for #433?** Yes. The rejections fire deep
  in the spawn paths (index.ts:2291 single, :1755 fan-out) after cost/target/
  capability gates; guarding there cannot preserve the durable-path intent, and
  a call-site guard would re-spell the predicate's condition. The predicate is
  the only site that knows both the switch intent and the effective mode.

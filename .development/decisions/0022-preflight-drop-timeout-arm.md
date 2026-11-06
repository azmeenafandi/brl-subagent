# 0022. The pre-flight's second arm: drop the deadline, keep the approval gate

- **Status:** Accepted
- **Date:** 2026-11-06
- **Issues:** #431, #433, #434, #412, #415, #423
- **Supersedes:** the omitted-background exemption bullet of ADR 0018 §1 ("an omitted `background` — the #361
  default already considered approval modes"). ADR 0018 stays Accepted for the explicit-false switch arm, the
  Jev-line check, its transitions, and the provenance rule; ADR 0019's scoping of both checks is untouched.

## Context

The 2026-11-06 incident is the one #412's mechanism was supposed to prevent, and it did not fire. A
`high`-thinking plan critique was dispatched with `background` **omitted** and `timeout: 600000`. The effective
approval mode was `writes`, so the #361 default resolved `background: false` and the run went foreground — while
ADR 0018's switch required the caller to have written `background: false` **explicitly**. The pre-flight therefore
returned `none`, no notice was emitted, and the foreground deadline killed the run at 10m0s. The work was lost.
It is the second occurrence of the same class (Rule 11 P0).

Two readings of that miss are both wrong, and both are worth recording because each produced a rejected design:

- **"Foreground is the hazard."** It is not. Foreground runs have no default deadline at all (#423); the kill
  timer arms only for an explicit, normalized `timeout`. What can kill an unpersisted run is a **deadline**, not
  the shape it runs in.
- **"The omitted-background exemption was correct."** The #361 default decided the *shape* from the approval
  mode; it never considered the *deadline*. Neither did the exemption that deferred to it. Nothing in the
  pipeline looked at the pair (foreground, explicit timeout) for a dispatch the caller had not marked.

Code reading while designing this fix also found a second defect in the shipped arm (#433): an
**explicit** `background: false` dispatch with `approvalMode: 'always'` and an explicit timeout was switched to
background — and the background spawn path then **rejects** `'always'` loudly ("Cannot spawn background agent
with approvalMode 'always'"; W5 / issue #28, there is no dialog in background). A pre-flight converted a valid,
working foreground dispatch into an error. That is a general rule, not one case: **the pre-flight must never
switch a dispatch into a rejection.**

## Decision

### 1. One rule, two arms

Rule 2 ("no deadline ⇒ durable path") stays: the run must not be killable by its own deadline. When the deadline
cannot simply be dropped into a background shape, it is dropped **in place** instead.

| caller shape | effective approval mode | verdict |
|---|---|---|
| `background: true` | any | `none` |
| `background` omitted, effective shape background | `auto` | `none` |
| `background` omitted, effective shape foreground | `writes` / `always` | **`drop-timeout`** |
| `background: false` explicit | `auto` / `writes` | **`switch`** (ADR 0018, unchanged) |
| `background: false` explicit | `always` | **`drop-timeout`** (#433) |

- `switch` — move to background and drop the timeout (the 30-minute default applies). Unchanged from ADR 0018.
- `drop-timeout` — keep the foreground shape, drop the timeout. A foreground run has no default deadline, so no
  clock kills it and the conductor's call blocks until the child settles.
- Both arms are gated exactly as before: `processChecks` on (ADR 0019), declared `high`/`xhigh` thinking, an
  explicit timeout, and a non-batch shape.

The omitted-background row keys on the **effective shape**, computed with `defaultBackgroundFor` — the same
helper the #361 default uses — never on a re-spelled mode list. `effectiveApprovalMode` is resolved at the call
site through `resolveEffectiveApprovalMode(params.approvalMode, state)`, never read from the raw call param: a
config-tier mode must reach the predicate, or the predicate would judge a mode the child will not run with.

### 2. Never switch into a rejection (#433)

`'always'` makes a background spawn impossible, so the explicit-foreground row routes to `drop-timeout` for
`always` but to `switch` for `auto`/`writes` — the shipped behaviour for those two is untouched. The guard is
expressed **once**, in `approvalBlocksBackground` (`src/types.ts`), consumed by both the predicate and
`rejectApprovalAlwaysInBackground` (`src/prelude.ts`). Two copies of `=== "always"` would let the gate widen or
narrow while the pre-flight keeps switching into the new rejection; one definition makes that a single edit site.

### 3. `force` precedence

`force: true` maps an arm that would otherwise return `switch` or `drop-timeout` to **`forced`**: the explicit
timeout is kept and the override is logged (the dispatch text is the reason — `force` has no reason field,
ADR 0007). An arm that computes `none` stays `none` regardless of `force`: there is nothing to override, and the
"high-thinking foreground forced" log line must never print for a run that is already background.

### 4. Ordering: the deadline is cleared before the snapshot

Both arms mutate `params` **before** any run record is written (`snapshotOriginalParams` at the foreground
record and at the background spawn). `params.timeout = undefined` recorded in `originalParams` is what makes a
retry re-derive an absent deadline instead of restoring the cap (ADR 0009). An implementation that clears the
timeout for the run *after* the snapshot looks correct to every spawn-argument assertion and silently hands the
cap back to every retry — which is why the pin for this is the recorded run entry, not the spawn argument.

The drop is idempotent on retry: the restored `timeout: undefined` exits the predicate early, so no second
notice is emitted.

### 5. The notice states the true fact, and only the true fact

A `drop-timeout` dispatch emits `THINKING_TIMEOUT_DROP_NOTICE` on **both** channels the switch arm uses
(`pi.sendMessage` follow-up for the conductor, `ctx.ui.notify` warning for the human), with
`details.previousTimeout` carrying the **actual dropped ms value** (not `"dropped"`) and
`details.effectiveApprovalMode`. Reusing `THINKING_SWITCH_NOTICE` is forbidden: its "the run is now background"
sentence is false on this arm. The dropped number is the load-bearing detail — the friction log needed exactly
that value to tell a budget cap from a tight clock.

### 6. The preset-timeout invariant (unnamed before this record)

`params.timeout = undefined` does **not** mean "no deadline" downstream: `resolveSubagentParams` merges
`params.timeout ?? preset?.timeout`. The arm's guarantee therefore holds **only because no preset can carry a
timeout at runtime** — `presetFromFrontmatter` maps no `timeout` field, so `SubagentPreset.timeout` is dead. If
preset timeouts ever map, the drop silently re-merges one, the notice becomes a lie, and no test fails. Any future
preset-timeout mapping must merge (or explicitly skip) the preset value before deciding.

## Objections this arm has to answer

**"The approval-dialog reasoning of ADR 0018 still applies."** It does, and it is why the shape does not move on
either new row: `writes` gates the diff on approval and `always` cannot run without the dialog, so both must stay
in front of the user. What moves is only the deadline.

**"#415/ADR 0019: a user's explicit foreground timeout is usually a budget cap."** Also true, and this arm is
deliberately more aggressive than the switch: the switch replaces a cap with a 30-minute background default, while
`drop-timeout` leaves **no bound at all** and the conductor's tool call blocks until the child settles. Three
things make that acceptable rather than reckless:

1. **Opt-in is the gate.** `processChecks` is project-local and off everywhere else (ADR 0019). In an opted-in
   project a foreground timeout is already a process violation — Rule 18's dispatch-parameter clause says
   foreground dispatches omit the timeout — so the arm mechanizes a rule the project already declared.
2. **The override is visible.** Both channels are told, the actual ms is recorded, and `force: true` is the
   stated escape with the dispatch text as its reason.
3. **The failure mode is bounded by the monitor, not by a guess.** The cost of an unbounded run is a stuck tool
   call the user can abort; the cost of the old behaviour was a lost 10-minute critique.

**The hang trade-off, stated rather than hidden.** A dropped deadline removes the only clock on a possibly-hung
child, and the tool description itself sells that clock ("Useful for tasks that might hang or get stuck"). The arm
trades "killed while making progress" for "possible hang the human must notice". That is the intended direction in
an opted-in project, and `force: true` restores the clock.

**Background deadline-kills are not "already durable".** Row 1/2 (`none`) is not a claim that background runs are
safe: a background run killed by its explicit timeout is **not** retained. The settle-time retention gate is
`isTransportRetryable` (transport signature + attempt 1 + `originalParams.background === true` — issue #404), and
the 2026-08-23 recurrence is the counterexample on record: a background agent timed out at 600s and its session
was unrecoverable. Background deadline-kills are a separate, deliberate class: explicit timeouts are honored
verbatim (#240, ADR 0008), retention is transport-only (#404), and the process answer is Rule 18's 2h maintainer
cap in prose, not a mechanism. This record does not change that class; it stops pretending the class is safe.

**`chain`/`graph` stay exempt.** The ADR 0018 reason (they block, and `background: true` is rejected) explained
the *switch* arm only. The reason that survives is different and is written here: an uncapped batch multiplies a
single hang across N units, and per-unit dimensions (`timeout`, `thinkingLevel` on each unit, with
`mergeSubTaskParams` letting the unit value win) have **no per-unit pre-flight** — filed as #434. Exempting the
batch is a deferral of a known hole, not a claim that batches are safe.

**`retryOnTimeout` becomes inert on the drop arm — deliberately.** A caller who passed `retryOnTimeout: true`
plus an explicit timeout gets the timeout dropped, so the foreground timeout-retry can never fire. Accepted: a
foreground timeout retry restarts from zero and preserves nothing, which is exactly rule 2's premise. The flag is
not treated as force-equivalent.

## Consequences

- The 2026-11-06 shape (omitted `background`, `writes`, `high`, explicit timeout) is now deadline-free. The
  switch arm's behaviour for explicit `background: false` + `auto`/`writes` is unchanged, by pin.
- A dispatch can no longer be converted into a rejection by its own pre-flight (#433).
- `src/schema.ts`'s `background` description documents two outcomes instead of one; SKILL.md Rule 2's enforcement
  sentence names the second arm.
- A new arm is a new silent-failure surface. It is pinned by: the recorded `originalParams` (order), the notice
  constant on both channels, the config-tier cases with no call param, the force matrix, and the
  processChecks-off case where nothing may fire.

**Falsifier.** A dispatch in a `processChecks`-on project, `background` omitted, effective approval mode
`writes`/`always`, `high`/`xhigh` thinking, an explicit timeout — that ends in a deadline-kill of a foreground
run. That is the exact shape this record claims is now unkillable, and one occurrence reopens the decision.

**Reversal trigger.** A project opting into `processChecks` and reporting that the arm cost it a run it wanted
capped: the remedy is `force: true` per dispatch, or (if it recurs) splitting the deadline policy out of the
umbrella flag with its own ADR — not restoring the lost-run behaviour.

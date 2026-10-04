# Team Agreement rule notes

Narrative behind the invariants in `SKILL.md` — founding incidents, war stories,
dates, and historical framing. The binding rules (with their numbers) live in
`SKILL.md`; nothing here changes them. Rule numbers match `SKILL.md` exactly.

**Contents**

- [Rule 2 — Dependency management is repo-level only](#rule-2)
- [Rule 4 — Tracked docs/tools materialize; state does not](#rule-4)
- [Rule 5 — ALL code changes go through a branch + worktree](#rule-5)
- [Rule 6 — Release checkpoint for extension-code changes](#rule-6)
- [Rule 7 — Delegation threshold](#rule-7)
- [Rule 8 — "Fixes #N" in commit + PR bodies](#rule-8)
- [Rule 9 — Verify outputs, not existence](#rule-9)
- [Rule 11 — Recurrence escalation](#rule-11)
- [Rule 12 — Environment before theory](#rule-12)
- [Rule 13 — Graph-first scoping](#rule-13)
- [Rule 14 — Route, don't hand-roll](#rule-14)
- [Rule 15 — Spec environment verification](#rule-15)
- [Rule 16 — User review gate](#rule-16)
- [Rule 17 — Reviewer independence](#rule-17)
- [Rule 18 — Termination triage + retry taxonomy](#rule-18)
- [Rule 19 — Coverage assertion](#rule-19)
- [Rule 20 — Target assertion](#rule-20)
- [Rule 21 — Claims cite their evidence](#rule-21)

## Rule 2

- the lockfile will diverge BY DESIGN, and a symlinked install would clobber the
  cockpit's pristine tree (issue #100)
- a symlinked checkout cannot be installed in place — the worktree-guard blocks
  it (#100/#106), correctly — and a symlinked install would serve the stale tree

## Rule 4

- `(2026-09-30)` — the tracking date in "Since #247 (2026-09-30)"
- graph guidance (Rule 13) is used by the CONDUCTOR to scope/frame instructions,
  then the spec carries the distilled scope

## Rule 5

- This rule applies to the conductor implementing directly, not just to
  delegated subagents.

## Rule 6

- The running pi session executes the extension code loaded at startup
- (previously the reload checkpoint)
- not a synced working copy
- a buggy auto-reload loop is worse than the staleness it fixes
- (dedupe is by resolved absolute path)

## Rule 7

- `— tracked since #247` (in "this skill, `.development/` — tracked since #247")

## Rule 8

- stale issues are how drift starts

## Rule 9

- a sync that ran before the merge completed is a stale sync
- The live-verification ritual is what makes an issue *actually* closed rather
  than *believed* closed.
- the #119/#122 probes confirmed the run-entry fields appeared in the monitor,
  not merely that persistRun was called
- See the process rules in this skill.
- (monitor entries, notifications, drill-in fields)

## Rule 11

- a P0 without a direction is anxiety, not a plan

## Rule 12

- Ordering, not exclusivity — theory still has its turn.

## Rule 13

- The graph is the efficiency layer for scoping (one query = the overview); grep
  remains the deterministic ground truth for exact references and verification.
- (last update predates the sprint's commits)
- The #114 scoping error is the proof-of-need: the graph already had the
  complete touchpoint map; the conductor hand-assembled it from memory + grep
  instead.

## Rule 14

- A lookup replaces a judgment call.
- Templates are CONTRACT + free-form TARGET: the contract (verdict format,
  quality bar, verification discipline) is fixed; the target description is
  filled by the conductor for ANY scope (a PR, a plan, a finding, a revision
  round).
- The audit that drove this rule: templates used 2 of 372 dispatches; graph mode
  0 of 372 — the machinery was built and never routinized.

## Rule 15

- the #122 100+ turn loop was a spec whose cited line numbers its own prescribed
  edit shifted by +15
- e.g. "run `npx tsc --noEmit` first; the compiler's output — not this spec — is
  the only authority for error locations"
- occurrence 1 — 2026-09-12
- a symbol-only sweep is *structurally blind* — it cannot see references by
  MODULE NAME
- holding bare strings; `e2e.test.ts`'s `ISOLATED_FILES` held the string
  `"update"`
- verify it produces the intended behavior, not that it looks correct
- Cost when skipped: the #164 spec ordered "touch ONLY the files listed", then
  the suite required a file outside that list — **the spec created its own
  conflict** and the implementer had to deviate to stay green.

## Rule 16

- it was born from the dispatch-bypass incident (two unapproved dispatches in
  one hour, one 100+ turn loop) and held for every subsequent dispatch —
  user-approved specs ran without a single loop or timeout
- (one review pass over a sequence of specs)
- Batched approval is the working form; mechanical wiring (approvalMode for
  delegations) is deferred unless the manual gate starts failing.

## Rule 17

- The 08-18 incident: reviewer #2 was given reviewer #1's findings file and told
  "you MAY read it" — the resulting zero-disagreement convergence was influence,
  not validation.
- (the #125 second opinion was a correctly-labelled verification pass)
- Independent reviews produce genuine convergence; verification passes produce
  corroboration; both are valuable, but they must be labelled correctly.

## Rule 18

- (SDK settings-manager `retry.maxRetries ?? 3`)
- consumed INSIDE the provider call — a surfaced connection error means the
  ladder already failed, so an INSTANT re-dispatch often hits the same
  conditions — invisible to us except as latency
- never call it "retry" without qualification
- correct responses to a surfaced connection error: termination-triage question
  first, then delay or fallback model — not instant re-dispatch
- The 08-26 user feedback: the conductor treated every termination as a
  technical fault and re-issued without ever asking whether the user terminated
  it.
- (2026-08-27, third recurrence)
- the #120 implementer was killed while posting its PR; work survived only
  because commit+push preceded the kill

## Rule 19

- issue #189: four occurrences in one week, two of them in the guards
  themselves; #204: five in the v2.3.8 sprint, filed as a P0 because the
  template-driven reads stayed unguarded
- `grep '^2026-09-1'` silently omitted every 09-20 entry; `grep -rn … | head -8`
  hid the matching section at line ~510.
- instead of patterning it
- the #175 spec skipped fix-direction item 4 and only an adversarial review
  caught it
- the #186 ratchet documents its evasion set and allow-list reasons.
- reconciliation
- #204: at the second occurrence, in review AND debug output

## Rule 20

- a green result is first evidence the TARGET was wrong, not that the guard is
  weak
- issue #205: the #200 cost-×N mutation hit the earlier copy of a duplicated
  line and the suite stayed green; the Phase-3 probe asserted a field that lived
  elsewhere

## Rule 21

- (issue #217)
- The #204 class applied to prose: a partial or absent observation presented as
  complete.

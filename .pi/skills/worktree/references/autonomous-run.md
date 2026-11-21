# Autonomous runs

**When this loads:** a task says "autonomously", "AFK", "while I'm away", or the
maintainer hands over a unit/set and leaves the terminal. The default ask is one
line — *"resolve #NNN, autonomously"* — and expands to this contract.

## 1. The grant

The grant is a **scope**, never an open-ended mandate:

| Shape | Example | Ends when |
|---|---|---|
| Unit-scoped | *"Resolve #560, autonomously."* | that unit is merged, closed, the handoff updated, and the final report sent |
| Set-scoped | *"Do #560 then #548."* | every listed unit is merged/closed — or the first stop condition |
| Cycle-scoped | *"Run the process cycle."* | acceptable when the set is small and each unit is independently scoped; otherwise propose the unit order first |

**Size check before starting.** If the grant cannot be held in one review pass
(rough test: the units' evidence would not fit one report), do not start —
propose a narrower grant and say why.

## 2. The loop

Per unit: recon (Rule 13, `recon.sh`) → spec → plan critique → worktree →
implementer → reviewer → gate (a)–(g) → merge commit → close → handoff.

The dispatch shapes, models and presets live in the handoff's `§STATE` — never
restated here (that is how they drift). Non-probes: explicit `background: true`
plus a timeout. **Two transport deaths on one label: change the shape**, do not
retry a third time.

## 3. Decision rights

**Stops the run**, even under a blanket grant:

1. publish a release;
2. force-push, or rewrite `main`/tags;
3. change the run's scope;
4. act on an ambiguous goal.

**The conductor's alone** (recorded in the unit summary, not asked):

- reorder units; skip one the work made unnecessary (reason recorded);
- insert a blocker unit when it is small relative to what it unblocks;
- extra critique rounds; a rejected approach;
- park scope creep as a new issue while the unit still delivers what was granted;
- file new work — never do it unasked.

**The test, said out loud:** does the pivot change *what* the run delivers, or only
*how/when*? How/when is the conductor's; what is the maintainer's.

## 4. On a stop: freeze the whole set

1. Finish the current atomic step — never a half-formed commit or a dirty worktree.
2. `In flight:` tells the truth (unit, step, next action).
3. Handoff pushed; `handoff-verify` 0 drift; tree clean.
4. Send the **stop** report: the condition, what is parked, the decision needed.
5. End the turn. No new units.

The *whole set* freezes — even units that look unaffected — because the decision
may change the plan, and half-finished work is worse than idle capacity.

## 5. Delegation

**Always delegated** (the conductor reads the summary, not the process):
implementation, review, plan critique, design/proposal, deep
investigation/debugging/research — anything whose process is longer than its answer.

**The conductor keeps:** recon and the ground truths; the **spec** (the dispatch
contract cannot be owned by the party judged against it); the gate, the merge and
the close; the handoff; judgment, pivots, reporting.

**Never delegated:** gate/merge, scope decisions, the final evidence reconciliation,
the handoff.

Delegation is not a blank cheque: the dispatch-shape pre-flight still applies, and
"whenever possible" does not mean delegating a one-line read or a single command.

## 6. Reporting

Three notifications by default — each **ending with the next action or the decision
needed**, each sent **before** the turn ends:

- **start** — scope, grant shape, planned order, checkpoints;
- **stop** — the condition, what is parked, the decision needed, handoff sha / 0-drift / clean;
- **final** — per unit: PR, merge sha, the evidence line, the gate result; issues
  filed and closed; residuals; handoff sha; one line on what comes next.

Per-unit notifications are **off** unless the grant says *"notify per unit"*. The
unit-close summary still lands in the session and the handoff.

Where they go: the private notify channel when the private skill is present (the
SKILL's conditional line); otherwise the session only.

## 7. Bias

- Build the check, not the prose (Rule 11's fix-direction default).
- A decision worth arguing about twice gets an ADR.
- A residual is filed, never smoothed away in a summary.
- Reversibility is protected: tags are immutable, no force-push, no silent scope growth.
- **Autonomy changes who decides within scope, not the standards** — the merge
  gate, the evidence bar, the review and the cycle ritual are unchanged.

## 8. Crash and resume

`§STATE` (Verified / dev / Suite / In flight) is the recovery point. On a fresh
session after a drop: read the handoff, resume from `In flight:`, check the private
channel for a reply, and do not redo merged work. A run that dies twice on one
label is a shape problem, not a retry problem.

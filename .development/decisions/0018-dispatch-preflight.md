# 0018. The dispatch pre-flight: shape auto-switch, and the opt-in Jev-line gate

- **Status:** Accepted
- **Date:** 2026-10-31
- **Issues:** #412, #407

## Context

Two conductor decisions kept failing even though both were written down.

**Dispatch shape.** On 2026-10-31 a plan critique ran foreground under a 15-minute timeout, was killed at ~14
minutes ("almost done"), and lost everything — foreground runs persist no transcript to resume — and the background
re-run cost another 17 minutes. The rule ("no deadline ⇒ durable path") existed as prose in a skill; the decision
was still discretion at the moment it mattered.

**The Jev line.** Rule 22's dispatch line (`jev: medium (0.84) · C2 · worktree y`) was audited after the fact by
`jev-check.mjs --log`, and the audit held. Three dispatches on 2026-10-31 still carried no line, including a
template render that *replaces* the task text. Worse, the audit validates the line's **format**, not its
provenance: a live dispatch carried `medium (0.70)` while the classifier had answered `high (0.32)` — an invented
confidence passes.

Both are the same diagnosis as ADR 0007's: a check that lives in a prose reminder drifts; a check at a chokepoint
holds. This records the two chokepoint checks and their escape hatches.

## Decision

### 1. Rule 2's mechanism — the shape auto-switch (product behavior)

A dispatch whose **declared** thinking level is `high`/`xhigh`, whose `background` is explicitly `false`, and which
carries an explicit `timeout`, is switched to `background: true` with the explicit timeout **dropped** (the
30-minute `DEFAULT_BACKGROUND_DEADLINE_MS` applies), and a notice states the true tool fact (foreground runs
persist nothing; background keeps its session and is retried on a transport error).

- `force: true` keeps it foreground and is logged — the dispatch text is the reason (`force` has no reason field;
  ADR 0007's contract is not widened).
- The switch is applied **before** `snapshotOriginalParams`, so the retry snapshot records `background: true` and
  `transport-retry.ts` still classifies the run as background. A switch after the snapshot would silently cost
  every auto-switched run its transport auto-retry.
- Exempt: `chain`/`graph` (they block and reject `background: true`), an omitted `background` (the #361 default
  already considered approval modes), and a dispatch with no explicit timeout (no deadline to lose). The level is
  the declared one, not the `maxThinkingLevel` cap — the cap defaults to `off`, so applying it would disable the
  pre-flight in every unconfigured session.

This is product behavior for every user: it only removes a shape that cannot be resumed.

### 2. The Jev line — a blocking pre-spawn check, OPT-IN per project (our process)

`validatePreTask` rejects a dispatch whose task carries no usable line, so every pre-spawn path inherits it (single
foreground, single background, fan-out, chain, parallel, graph, mode entry). The check is enabled **only** by a
project's own `package.json`:

```json
{ "brl-subagent": { "requireJevLine": true } }
```

Absent → no check, ever. This is our development discipline, not a product requirement: a user's dispatch is never
rejected for a missing Jev line. The manifest is tracked, so it exists in every worktree (a gitignored marker under
`.pi/` would be absent exactly where the work happens).

- Accepted forms: the canonical line, and the sanctioned escape `jev: unavailable` (a recorded gap — the
  classifier did not run — not a silent skip).
- Escapes: `noJev: "<reason>"` (a non-empty string, refused as `true`/`""` at the schema layer) proceeds and
  downgrades the rejection to a warning that carries the reason; it bypasses ONLY the line check, never a
  capability conflict. `force` remains capability-only and does not bypass the line.
- A retry inherits the original's recorded task, so it inherits the line; it is not re-checked.
- The merge-time audit (`--log`) stays background-only: the log's only task-carrying event is the background spawn
  record. Foreground strictness is dispatch-time only.

### 3. Provenance — the line must be machine-produced

`jev-check --line '<json>' --label <name>` appends `<iso>\t<label>\t<line>` to `.pi/jev-lines.log` (gitignored),
whose header records the cutoff date. `jev-check --log --require-provenance` (run by `merge-guard` check (e)) fails
a dispatch line with no row, and fails closed (exit 2) when the log is missing or empty. Dispatches before the
cutoff are exempt — no history is rewritten.

## Consequences

- A high-thinking foreground dispatch with a deadline can no longer be created by accident; the durable shape is
  the default and `force` is the visible exception.
- In this repository a dispatch without a line is rejected before anything spawns, with the exact form and the
  command that prints it. Users see no behavior change; the check is inert without the manifest field.
- An invented confidence no longer passes the audit: the line has to have been printed by the classifier's own
  formatter. A missing provenance log fails the merge rather than passing vacuously.
- The three conductor decision rules that remain prose (release timing, "done carries its falsifier") are
  documented in `.pi/skills/**` and `.development/` — never in `AGENT.md`, which ships as product documentation
  (see CONTRIBUTING.md).

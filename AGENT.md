# AGENT.md — brl-subagent capability reference (v2.3.4+)

> The `delegate_task` prompt guidelines are a derived summary of this file; if they disagree, this file wins.

This file is the authoritative reference for how the brl-subagent extension behaves
and how you (the conductor) should judge a delegation. Read it when planning
delegation-heavy work.

## Execution models

| Mode | What blocks | What wakes you | Batchable? |
| --- | --- | --- | --- |
| single, foreground | blocks until it returns | — (result comes back inline) | no |
| single, background | returns immediately with an agent id | yes — a `subagent-completion` message on terminal state | no |
| chain | blocks until the chain finishes or fails | — | yes (foreground) |
| parallel (`tasks`) | blocks until every task finishes | — | yes (foreground) |
| graph | blocks; runs in waves via `dependsOn` | — | yes (foreground) |

- Foreground single blocks: you wait for the result inline.
- Background single returns immediately with an agent id; a completion message wakes you (see below).
- Chain, parallel, and graph are batch — one call, many subtasks. They are foreground today; background batch is future work.
- Chain stops at the first failure; max 10 steps.
- Parallel runs every task regardless of the others — no short-circuit.
- Graph runs in waves, ordered by `dependsOn` edges.

## The completion contract

- A background run wakes you with a structured `subagent-completion` message when it reaches a terminal state (`completed`, `failed`, or `stopped`). The `details` carry `id`, `status`, `errorCategory` (with `errorMessage` when present), cost/tokens/duration, and `label`; the content carries a tail of output.
- The wake triggers a turn even when you are idle. Do not poll for it.
- Delivery mode by status holds at knob `"all"`: `failed`/`stopped` → steering you to act; `completed` → follow-up. The `completionNotify` knob changes both the delivery mode and the wake: under `"failed"` a `completed` run is delivered as a passive `nextTurn` (no wake) while `failed`/`stopped` still steer; under `"off"` everything is a passive `nextTurn` and nothing wakes you. (The knob controls whether an idle conductor is triggered — see below.)
- Knob dependency: polling is correct only when wakes are disabled (`completionNotify: "off"`). The wake is per-terminal-status and knob-scoped: under `"all"` a terminal run always wakes you; under `"failed"` only a `failed` or `stopped` run wakes you — a `completed` run stays a passive `nextTurn` (no wake); under `"off"` nothing wakes you. So polling is wrong unless wakes are disabled. One status check as a stall check is legitimate; repeated polling is not.
- One message per run — the extension deduplicates on the first terminal event for a run id, so don't expect multiple messages for a single run.
- Honest records: trust the message's `category`/abort source over your own guess. The provider/abort origin is authoritative on why the run stopped.
- Steering is not an abort. Being steered to act on a terminal run is not terminating it. A real `stop` is an abort — and a stopped run still wakes you.

## Delegation judgment

- Foreground vs background: if your next step needs the result inline, run foreground. If the user can keep working or is AFK, run background and act on the wake.
- Batch vs sequential: if the work is pre-declared, use chain/parallel/graph. If you're steering incrementally with the user, issue sequential calls.
- Retry taxonomy: `retryRunId` is a retry — it re-runs with the recorded task and params. A re-dispatch (a fresh call with the same task text) is not a retry. Never re-issue an identical spec after a termination without confirming the cause with the user (Rule 18).
- When to delegate: when the task needs an isolated context, a deep investigation, parallel research, or a long-running analysis.
- Approval: `approvalMode: "always"` is rejected in background — there is no dialog. Use `auto` (default) or `writes`; `writes` auto-approves in background.

## Canonical shapes

- Batch chain with `{previous}`: `chain: [{ task: "…" }, { task: "Use {previous} …" }]` — each step gets the prior step's output.
- Graph with `dependsOn`: subtasks declare edges; the scheduler runs them in waves.
- Background + act on wake: spawn a background run, then act when the completion message arrives. Never poll between spawn and wake.
- retryRunId: pass a failed run's id to re-run it with its recorded task and params; explicit parameters override the originals.

## Mechanics pointer

Presets and templates are documented in the schema, not here. Judgment only:

- Prefer a preset when the delegation matches a standard shape — review/audit/test/docs; override per-call deliberately.
- Recurring task shapes → a saved template.

The schema's `delegate_task` parameters, the `templateSummary` and `presetRestrictionSummary` lines in the prompt guidelines, and `get_subagent_result`'s description are the mechanics reference.

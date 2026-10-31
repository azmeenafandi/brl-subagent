# AGENT.md — brl-subagent capability reference

> The `delegate_task` prompt guidelines are a derived summary of this file; if they disagree, this file wins.

> **Naming:** deliberately `AGENT.md`, **not** `AGENTS.md`. This is *not* a pi
> context file — it is read on demand via the extension's `delegate_task`
> guidance, not auto-loaded into the system prompt. Renaming it would change
> nothing for users (a package directory is not in pi's context-file lookup
> chain) while adding its full contents to every session run inside this repo.

This file is the authoritative reference for how the brl-subagent extension behaves
and how you (the conductor) should judge a delegation. Read it when planning
delegation-heavy work.

## Execution models

| Mode | What blocks | What wakes you | Batchable? |
| --- | --- | --- | --- |
| single, background (**default** at effective `auto`) | returns immediately with an agent id | yes — a `subagent-completion` message on terminal state | no |
| single, foreground (default at `writes`/`always`, or `background: false`) | blocks until it returns | — (result comes back inline) | no |
| chain | blocks until the chain finishes or fails | — | yes (foreground) |
| parallel (`tasks`), background fan-out (**default** at effective `auto`) | returns immediately with one agent id per task | yes — a `subagent-completion` message per agent, on each agent's terminal state | yes |
| parallel (`tasks`), foreground (default at `writes`/`always`, or `background: false`) | blocks until every task finishes | — | yes (foreground) |
| graph | blocks; runs in waves via `dependsOn` | — | yes (foreground) |

- **`background` is a conditional default (issue #361).** With `background` omitted, a single task or a `tasks` fan-out runs in the **background** when the *effective* approval mode is `auto` (per-call param, else the configured default), and stays **foreground** when it is `writes` or `always`. Chain and graph always stay foreground. Explicit `true`/`false` is honoured exactly.
- Foreground single blocks: you wait for the result inline.
- Background single returns immediately with an agent id; a completion message wakes you (see below).
- Chain, parallel, and graph are batch — one call, many subtasks. Chain and graph are foreground; `tasks` fans out by default under `auto` (and always with `background: true`): every task starts as its own background agent, the call returns with one id per task in task order, and you are woken once per agent as each finishes.
- Fan-out validates the whole batch before spawning anything: any invalid task (cwd, `outputFile`, or a pre-task check) rejects the entire batch before a single spawn starts, and the error names the task (`Task N ("label")`).
- Fan-out rejects `gitMode: "branch"` for the batch — the git lock is awaited inside the first spawn and held until that agent settles, so branch-mode spawns targeting the same repository would serialize and block the call (the rule is blanket because the lock is keyed by the resolved repository root, so any two units of the same repo contend). It also rejects `approvalMode: "always"` up front, and the session cost limit is checked as per-task estimate × N.
- Spawn failure mid-loop stops further spawns and reports the failed task plus the ids already started; abort mid-loop stops further spawns and reports the ids already started. Either way those agents are detached and still wake you.
- Chain stops at the first failure; max 10 steps.
- Parallel runs every task regardless of the others — no short-circuit.
- Graph runs in waves, ordered by `dependsOn` edges.

## The completion contract

- A background run wakes you with a structured `subagent-completion` message when it reaches a terminal state (`completed`, `failed`, or `stopped`). The `details` carry `id`, `status`, `errorCategory` (`"unknown"` when unclassified) and `label`; `errorMessage`, `stopReason`, cost/tokens/duration ride along only when the run entry has been finalized — a `stopped` run is notified at stop time, **before** finalize, so those fields are usually absent there. The content carries a tail of output when one has been captured.
- The wake triggers a turn even when you are idle — whenever the knob's wake condition covers that terminal status (see the matrix below). Do not poll for it.
- Delivery mode by status holds at knob `"all"`: `failed`/`stopped` → steering you to act; `completed` → follow-up. The `completionNotify` knob changes both the delivery mode and the wake: under `"failed"` a `completed` run is delivered as a passive `nextTurn` (no wake) while `failed`/`stopped` still steer; under `"off"` everything is a passive `nextTurn` and nothing wakes you. (The knob controls whether an idle conductor is triggered — see below.)
- Knob dependency: polling is correct only when wakes are disabled (`completionNotify: "off"`). The wake is per-terminal-status and knob-scoped: under `"all"` a terminal run always wakes you; under `"failed"` only a `failed` or `stopped` run wakes you — a `completed` run stays a passive `nextTurn` (no wake); under `"off"` nothing wakes you. So repeated polling is wrong; a single status check as a stall check is legitimate, and a status check is needed only when the knob will not wake you for that outcome (`"off"`, or a `completed` run under `"failed"`).
- One message per run — the extension deduplicates on the first terminal event for a run id, so don't expect multiple messages for a single run. A fan-out wakes you once per agent — still one message per run (each agent is its own run), never coalesced.
- **Transport failures auto-retry once.** A background run whose conductor-side transport dropped (`exit_error` with a connection/network signature — `Connection error.`, `ECONNRESET`, `socket hang up`, `fetch failed`, `ETIMEDOUT`, …) is re-dispatched **once** with its recorded task and params, recorded as `attempt: 2` (`resumeOf` the source). The retry's prompt opens with a short resume block — inspect `git status --short`, the recent history, the `/tmp/brl-<label>-bank.md` progress bank, and the previous attempt's transcript when it exists — so it continues from what survived a drop instead of redoing it. The block is prompt-only: routing, thinking, model and the capability pre-flight still see the recorded original task. The source run's completion message is suppressed and replaced by a warning toast, so the retry's own settle is the wake you get — do not re-dispatch it yourself. A second transport failure surfaces as an ordinary failure; non-transport failures, foreground runs, and fan-out units are never auto-retried (`retryRunId` stays your call for those).
- Honest records: trust the message's `errorCategory`/abort source over your own guess. The provider/abort origin is authoritative on why the run stopped.
- Steering is not an abort. Being steered to act on a terminal run is not terminating it. A real `stop` is an abort — and a stopped run still wakes you.

## Delegation judgment

- Foreground vs background: the default is background under effective `auto`, foreground otherwise. Pass `background: false` for a quick probe whose answer the next step needs inline (it keeps the call blocking, so no wake round-trip). Pass `background: true` to force a background run where the default blocks. If the user can keep working or is AFK, act on the wake. Pre-declared independent work while the user is away → `tasks` (fan-out is the default) and act on each wake.
- Batch vs sequential: if the work is pre-declared, use chain/parallel/graph. If you're steering incrementally with the user, issue sequential calls.
- Retry taxonomy: `retryRunId` is a retry — it re-runs with the recorded task and params. A re-dispatch (a fresh call with the same task text) is not a retry. Never re-issue an identical spec after a termination without confirming the cause with the user.
- When to delegate: when the task needs an isolated context, a deep investigation, parallel research, or a long-running analysis.
- Approval: `approvalMode: "always"` is rejected in background — there is no dialog. Use `auto` (default) or `writes`; `writes` auto-approves in background. This is why the background default is approval-aware: an omitted `background` stays foreground under `writes`/`always`, so the gate is never silently bypassed by a default.

### Claim verification

- Ground claims about run state, liveness, or elapsed time in observed results — the subagent result API (`get_subagent_result`), the user-visible monitor, or a command's output.
- Do not infer liveness from a run record: an agent's output record is finalized when the run completes, so a quiet record is not evidence the agent has stopped.
- Measure elapsed time rather than estimating it; state the measured value.
- When a claim is unverified, say so.

## Canonical shapes

- Batch chain with `{previous}`: `chain: [{ task: "…" }, { task: "Use {previous} …" }]` — each step gets the prior step's output.
- Graph with `dependsOn`: subtasks declare edges; the scheduler runs them in waves.
- Background + act on wake: spawn a background run (the default under `auto`), then act when the completion message arrives. Never poll between spawn and wake.
- Background fan-out: `tasks: [...]` — one background agent per task, one id per task in task order, one wake per agent.
- Inline probe: `background: false` — blocks and returns the result in the same turn when the next step needs it immediately.
- retryRunId: pass a failed or **interrupted** run's id to re-run it with its recorded task and params; explicit parameters override the originals. A run interrupted before durable task capture (a pre-enrichment registry entry) has no recorded task — pass `task` explicitly for those.

## Interrupted runs and recovery

- An interrupted run (its conductor died mid-run) stays visible with status **Interrupted** in `/brl-subagent history` and is listed by `/brl-subagent retry` alongside failed runs — including after a crash + fresh boot, where it is reconstructed from the durable per-run registry (plus the background agent record). Recover it with `retryRunId: <run-id>` (recorded params restored), or abandon it from that menu — abandon finalizes the run as stopped, drops its persisted session file, and sends **no** completion wake.
- **Task persistence (O3):** a foreground/unit run persists its task, label, model, thinking level and full `originalParams` snapshot in the durable registry at dispatch, so after a crash + fresh boot its row shows the real task and `retryRunId` restores the recorded shape — the same 17 fields a same-session retry restores (including `force`; explicit caller values still win). A successful retry retires the source entry so the superseded run is not re-offered at the next boot; a failed retry start leaves it intact and retryable.
- **Legacy rows:** an entry written before task persistence lacks those fields, so its row carries `(task unavailable)` and `retryRunId` cannot restore a task — pass `task` explicitly on the retry call. A background run keeps its task via its agent record.
- The **recovery posture** (`/brl-subagent recovery`, default `offer`) controls whether a boot surfaces interrupted runs with one turn-boundary notice; `off` silences it. Nothing is auto-resumed today.

## Deadlines and retries

- `timeout` (ms) is a **deadline, not a ceiling** — an explicit value is honored as given; 30 minutes is only the default for a background run that passes none (a foreground run is not capped). Background expiry aborts the session (the run ends `stopped`); foreground expiry kills the process. Because background is now the default under `auto`, remember the 30-minute deadline: pass an explicit `timeout` for anything expected to run longer.
- `retryOnTimeout` applies to **foreground runs only**. A timed-out background run is not auto-retried on the deadline: re-dispatch it with `retryRunId` if that is the right call. The one automatic retry is the **transport-class** one above — a background run that died on a dropped connection is replayed once. The same applies to an interrupted run — recovery is always an explicit `retryRunId` call, never automatic (auto mode is not yet accepted).

## Mechanics pointer

Presets and templates are documented in the schema, not here. Judgment only:

- Prefer a preset when the delegation matches a standard shape — review/audit/test/docs; override per-call deliberately.
- Recurring task shapes → a saved template.

The schema's `delegate_task` parameters, the `templateSummary` and `presetRestrictionSummary` lines in the prompt guidelines, and `get_subagent_result`'s description are the mechanics reference.

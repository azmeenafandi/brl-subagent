# brl-subagent — Architecture

> **Current-state reference for developers.** It is version-free by design: release history lives in
> `ROADMAP.md` / `TASKS.md`, design decisions in the issues and PRs they shipped in, and git history below
> that. The **module map** is generated from the source and checked in CI (`npm run docs:arch`), so it
> cannot drift.
>
> User-facing usage: [`README.md`](../README.md) · conductor-facing capability contract: [`AGENT.md`](../AGENT.md) ·
> development process: [`.pi/skills/worktree/SKILL.md`](../.pi/skills/worktree/SKILL.md) ·
> contributing: [`CONTRIBUTING.md`](../CONTRIBUTING.md).

## What it is

A pi extension that adds delegation tools — `delegate_task`, `stop_subagent`, `steer_subagent`,
`get_subagent_result` — plus the `/brl-subagent` command surface. The conductor delegates work to subagents
with isolated context, configurable model / thinking level / tools, and either a blocking result or a
background run that wakes the conductor when it finishes.

## The two execution paths

```
conductor
   │  delegate_task (single | chain | tasks | graph)
   ▼
┌─────────────────────────── brl-subagent ───────────────────────────┐
│  sanitize → resolve params → validate (+capability guards)         │
│            → shared prelude (cost gate · approval · H1)            │
├──────────────────────────────┬─────────────────────────────────────┤
│ FOREGROUND (runner.ts)       │ BACKGROUND (session-manager.ts)     │
│ spawn `pi` subprocess        │ SDK session (createAgentSession)    │
│ JSON-line stdout → aggregate │ records + transcripts → wake        │
│ result returns in the turn   │ result via monitor/result tool      │
└──────────────────────────────┴─────────────────────────────────────┘
```

- **Foreground — subprocess.** `runner.ts` spawns a `pi` process with an allowlisted environment, parses its
  JSON-line stream, folds usage, and returns the aggregate in the tool result. Covers single, `chain`,
  foreground `tasks`, and `graph` runs.
- **Background — SDK session.** `session-manager.ts` creates an in-process session via `createAgentSession`,
  returns the agent id immediately, persists run records + transcripts, and `notify-completion.ts` pushes a
  structured wake on the terminal event. `tasks` + `background: true` fans out one agent per task, one wake
  per agent.

*Why two:* foreground optimizes decision flows (the result is in the turn); background optimizes concurrent,
unattended work (the conductor is woken instead of polling). `chain` and `graph` are foreground-only and
reject `background: true` loudly; branch-mode fan-out is rejected up front because the per-repo git lock is
awaited inside the spawn (issues #28, #147, #198).

## Dispatch pipeline

`delegate_task` → sanitize (`sanitize.ts`) → resolve params (`params.ts`: preset merge, thinking caps, timeout
normalization, model resolution, edit→write fix, auto-routing) → template / retry resolution → validate
(`validate.ts` H1 + capability pre-flight) → shared prelude (`prelude.ts`: cost gate, approval gating,
dispatch guards) → mode runner (`index.ts`) → spawn → run records + monitor → result or wake.

`schema.ts` is the single source of truth for the `delegate_task` parameter schema, and `DelegateTaskParams`
is derived from it, so schema and type cannot drift (#239).

## Module map

<!-- BEGIN GENERATED: module-map (npm run docs:arch) -->

_Generated from each module's `// Purpose:` header by `npm run docs:arch` — edit the source, not this block._

| Module | Purpose |
|---|---|
| `concurrency.ts` | Session-bound concurrency queue: slot acquisition/release, priority insertion, and progress counters. |
| `diff.ts` | Parses git unified diffs into structured per-file summaries and hunks for the result UI. |
| `event-bus.ts` | In-memory lifecycle pub/sub (`subagent:*` events) for extensions and the completion wake. |
| `git.ts` | Branch-based git workflow for worktree runs: branch creation, diff capture, switch-back, cleanup. |
| `history.ts` | Run-record store: creation, finalization, retry lookup, and history pruning. |
| `index.ts` | Entry point: tool/command registration, the delegate_task handlers, and the execution-mode runners. |
| `logging.ts` | Leveled structured logging with file output and rotation under `.pi/subagent-logs/`. |
| `messaging.ts` | Inter-subagent messaging: the Intercom channel and `[TO:id]` output parsing. |
| `metrics.ts` | SLA metrics over run history: p50/p95/p99 latency, success and cost rates, degradation detection. |
| `model-availability.ts` | Auth-aware model availability: distinguishes catalog presence from configured provider auth. |
| `notify-completion.ts` | Builds and sends the completion-push wake message for terminal background runs. |
| `params.ts` | Param resolution: per-call + preset merge, thinking caps, timeout normalization, tool and git/approval resolution, auto-routing. |
| `paths.ts` | Package-root path resolution (`pkgPath()`) so shipped assets resolve from the extension directory. |
| `preflight.ts` | Pre-spawn environment checks: pi binary, temp-dir writability, cwd readability. |
| `prelude.ts` | Shared guard/validation prelude opening every delegation mode (cost gate, approval, H1 validation, dispatch guards). |
| `presets.ts` | Preset loading, parsing, validation, and the file-backed custom-preset tier. |
| `prompt.ts` | Builds the subagent system prompt, including the task fence and inherited-instruction handling. |
| `reports.ts` | Compliance reporting: file-access records and secrets-exposure detection. |
| `router.ts` | Auto-route: keyword classification of a task description to the best preset. |
| `runner.ts` | Foreground execution: spawns the `pi` subprocess, parses its JSON-line stream, and folds usage. |
| `sanitize.ts` | Input validation, environment allowlisting, and output sanitization (task, cwd, outputFile, agent ids). |
| `scheduler.ts` | Dependency-graph scheduler: cycle detection, topological waves, and graph validation. |
| `schema.ts` | The registered `delegate_task` parameter schema — the single source of truth for its types. |
| `session-manager.ts` | Background execution: SDK sessions (`createAgentSession`), agent records, timeouts, steering, and settle paths. |
| `state.ts` | Session-bound state container with versioned validation and migration for persisted settings. |
| `templates.ts` | Task-template resolution: `${param}` substitution over the file-backed template tiers. |
| `transcript-tail.ts` | Pure line-planning for the drill-in transcript overlay (no TUI imports). |
| `transcript.ts` | JSONL transcript recording for every agent run (`.pi/output/agent-<id>.jsonl`). |
| `tui-format.ts` | Pure TUI row formatting shared by the monitor and dashboard (no TUI imports). |
| `tui.ts` | All TUI surfaces: config menus, preset/template managers, history, live monitor, and result rendering. |
| `types.ts` | Shared types, constants, and the error/termination classification taxonomy. |
| `unit-run.ts` | Per-unit run-entry helpers shared by chain, parallel, and graph modes. |
| `validate.ts` | H1 pre-task validation: deterministic tool/thinking/git checks and failure post-mortems. |

**33 modules** — every one is listed because a new module without a purpose fails CI.

<!-- END GENERATED: module-map -->

## Persistence and state

| Where | What |
|---|---|
| `.pi/subagents/` | run records — the source for history, the monitor, and retries (owner-only permissions) |
| `.pi/output/agent-<id>.jsonl` | transcripts — every run, enabling the drill-in view and the steering audit trail |
| `.pi/subagent-logs/` | leveled structured logs with rotation |
| session state (`state.ts`) | concurrency counters, config, preset/template caches — session-bound, version-validated on restore |

## Invariants (do not regress)

Each rule below is enforced in code and pinned by tests; the pointer is where it was established.

- **Task-as-data fence** — the task body is wrapped in `<task>…</task>` at both chokepoints, and forged
  markers are neutralized, so task text can never be executed as instructions (#27, #42).
- **Environment allowlist** — spawned processes receive a filtered environment (#F2).
- **Sanitization before persist/echo** — task / cwd / outputFile are validated, agent ids must be UUIDs,
  error messages are sanitized, and persisted run data is owner-only (#30, #29, #65).
- **Capability pre-flight** — a task whose capability the resolved toolset cannot provide is rejected before
  any spawn (or downgraded to a warning with `force`) (#216).
- **Honest terminal status** — one classifier over the raw `stopReason`: `stop` → completed, `aborted` →
  stopped, anything else → failed with `truncated` / `incomplete` distinctions, and every renderer and
  aggregate routes through the same shared predicate (#179, #120).
- **One deadline per run** — an explicit `timeout` is owned by the session-manager timer; the index timer
  arms only on the no-timeout default path (#240, #244).
- **Steering contract** — `steer_subagent` delivers to the live session and writes the transcript audit line
  only after successful delivery (#241).
- **Background safety** — `approvalMode: 'always'` is rejected in background, `'writes'` warns, and the
  per-repo git lock serializes branch-mode runs (#28, #198).
- **Retry fidelity** — a retry restores the recorded execution shape (`background`, `gitMode`, `approvalMode`,
  `force`, model, thinking level, priority) with explicitly passed values winning; multi-step shapes degrade
  to a single run; background runs are not auto-retried on timeout (#227, #244).
- **Cost governance** — a session cost gate runs in the shared prelude before every spawn family, with the
  per-task estimate fallback (#R5, #201).
- **Concurrency queue** — four priority tiers govern slot acquisition for foreground and multi-mode runs;
  background fan-out deliberately runs outside the slot queue (#114, #198).

## Tests

- `src/__tests__/` — unit and integration suites, one per module; `e2e.test.ts` is Tier-1 jiti
  import verification (it spawns nothing), `e2e-subprocess.test.ts` spawns a controlled stub `pi`
  (real `pi` is opt-in via `BRL_E2E_REAL_PI=1`), and `*-real.test.ts` suites exercise real git /
  session paths.
- CI runs `npm run typecheck` and `npx vitest run`; `.pi/skills/worktree/check-repo.sh` mirrors the gate
  locally before a worktree is created.
- The module map's own guard is `src/__tests__/architecture-doc.test.ts`: regeneration must equal the
  checked-in block, so a new module without a purpose header — or an edit that skips `npm run docs:arch` —
  fails the suite.
- Structural rules are executable: `src/__tests__/architecture-rules.test.ts` enforces no runtime import
  cycles, entry-point confinement (nothing imports `index.ts`), the pure-helper boundary, process-execution
  confinement, the runtime-dependency allowlist, and the session-manager reader API. A violation fails CI
  with the rule's name and remedy in the message.

## Where to go next

- **Behaviour of a tool or parameter** → `AGENT.md` (the registered contract) and `README.md` (usage).
- **Why a rule exists** → `.development/decisions/` (accepted ADRs).
- **Why something is the way it is** → the issue / PR numbers cited above, the `ROADMAP.md` "Shipped" tables,
  the `TASKS.md` changelog, and git history.
- **How development works** → `.pi/skills/worktree/SKILL.md`; contributors start at `CONTRIBUTING.md`.

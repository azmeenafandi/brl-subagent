# brl-subagent — Architecture

> Generated: 2026-08-03 | Version: 2.3.9 (released 2026-09-27). Content reflects the post-2.1.2 changes shipped through v2.3.8: v2.2.0 (foreground drill-in parity #105, background retry #98, unknown-param warn #99/#110, worktree tooling #100/#106, CI hardening #104, DRY snapshot #108), v2.2.1 (priority per-unit arbitration #114), v2.3.0 (parallel-subtask run entries #119, background audit fields #122, tsc gate #117), v2.3.1 (graph/chain live-monitor visibility #130, run records + status-bar breakdown #133), v2.3.2 (honest termination records + abort-source stamping #120, line-anchored intercom extraction #129, unit-run family finish #136, dead-code removal #141), v2.3.3 (completion-push wake #147, single-notification-per-run #149), v2.3.4 (conductor knowledge gap #154 — AGENT.md + schema wake contract + templateSummary), v2.3.5 (published npm pi package + peerDependencies; AGENT.md packaging fix #158; pkgPath #160; guideline path pinning #162; OIDC staged releases), v2.3.6 (shipped-doc version pinning #166; maintainer content out of AGENT.md #165; npm-only install path #171; update-notifier removal #164), v2.3.7 (honest terminal status — stopReason classification, work volume, no predicate copies #179; file logging finally enabled D6; template-only + retry-only dispatch #175; runtime vocabulary stripped #174; packaging smoke test in publish.yml #176) and v2.3.8 (**background fan-out for `tasks`** — the inline background branch extracted into a shared `startBackgroundAgent` tail, validated-all-then-spawn-all with per-task guards/overrides and per-task retry snapshots, up-front approval/gitMode/cost-×N gates, abort + partial-failure reporting, one wake per agent #198; loud rejection of the old silent ignore #196; explicit run-entry lookups #185; coherent failed-run records #187; runtime-vocabulary + terminal-status AST ratchets #183/#186) and v2.3.9 (live-render sentinel #206; capability guards — exploration vocabulary, pre-run block with `force`, warning surfacing, auto-route evidence #216; per-step cwd + per-unit pre-passes across chain/parallel/graph #222; foreground tasks per-task validation #220; repo-root branch lock #224; retry execution-shape carry #227; shipped-doc accuracy audit + template requirements #204/#205/#217; shared prelude #201; test-leak fix #195). See TASKS.md changelog entries.

## Overview

`brl-subagent` is a modular pi coding-agent extension that adds a `delegate_task` tool. The LLM spawns subagents — independent `pi` processes — with isolated context windows, configurable models, thinking levels, and tool scoping.

```
┌─────────────────────────────────────────────────┐
│                   pi (conductor)                 │
│  ┌───────────────────────────────────────────┐  │
│  │         brl-subagent extension            │  │
│  │  ┌─────────┐  ┌──────────┐  ┌─────────┐  │  │
│  │  │ Config  │  │delegate_ │  │  Live   │  │  │
│  │  │  Menu   │  │  task    │  │ Monitor │  │  │
│  │  └─────────┘  └────┬─────┘  └─────────┘  │  │
│  │                    │ spawn()              │  │
│  └────────────────────┼─────────────────────┘  │
│                       ▼                         │
│  ┌──────────────────────────────────────────┐   │
│  │         pi (subagent process)            │   │
│  │  --mode json --no-session --model X      │   │
│  │  --thinking Y --tools A,B,C              │   │
│  │  │  stdout (JSON-line stream)            │   │
│  │  │  stderr                               │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

## Distribution & Packaging (v2.3.5)

The extension is published as a first-class **pi package** on npm — `pi install npm:brl-subagent` (global) or `-l` (project-local), updated with `pi update --extensions`.

**Manifest contract** (`package.json`):

- `pi.extensions: ["./src/index.ts"]` — the entry point pi resolves for the package.
- `files` — the tarball allowlist: `src/ presets/ templates/ README.md LICENSE AGENT.md`, with `!src/__tests__/` excluded. Everything else in the repo is gitignored dev workspace and never ships.
- `peerDependencies` — the five pi-bundled core packages (`@earendil-works/pi-ai`, `pi-agent-core`, `pi-coding-agent`, `pi-tui`, `typebox`) declared with `"*"`. Pi supplies these at runtime, so they must **not** be listed as bundled `dependencies`; the peer declaration is what makes `--omit=dev` production installs resolve (they had been `devDependencies`, yet `typebox` and two of the pi packages are runtime imports).
- `devDependencies` keep the pinned `^0.85.x` range for local parity and typecheck — `^0.85.1` satisfies `*`, so the two declarations coexist.

**Runtime vs development versions (parity):** the peer ranges are deliberately `"*"` — the runtime version of a bundled core package is whatever the user's pi ships, not our choice. `devDependencies` pin what we develop, typecheck, and test against. Those two can legitimately diverge, and one does:

- **`typebox` — known divergence, verified inert (2026-09-12).** Pi bundles **1.3.7** (nested under `pi-coding-agent`); our devDep range is `^1.3.25` (resolved to 1.3.29 by dependabot PR #167) — so we develop ~22 patches *ahead* of what a user's extension resolves at runtime. Verified safe: the extension's entire `typebox` surface is nine primitive builders (`Optional`, `String`, `Object`, `Literal`, `Boolean`, `Array`, `Number`, `Union`, `Record`) in `src/index.ts` — no `Value`, no `Compile`, no `Static<>`, no custom kinds. A composite schema exercising all nine produced **byte-identical** output under 1.3.7, 1.3.25, and 1.3.29. Consequence: the divergence is **accepted, not pinned** — dependabot's `typebox` bumps (which widen it) are safe to merge, and pinning to pi's 1.3.7 would buy nothing while holding us behind bug fixes.
- **`@earendil-works/*`** — pinned `^0.85.x` in `devDependencies` to match the running harness; `check-repo.sh` flags skew at every worktree pre-flight.

**Asset resolution:** bundled assets (`presets/`, `templates/`, `package.json`, `AGENT.md`) resolve through `pkgPath()` (`src/paths.ts`), which anchors on `<pkg>/src` → `<pkg>`. That is correct for every install mode — npm store, git store, and local path alike (#160).

**Release pipeline:** `.github/workflows/publish.yml` triggers on a published GitHub release, runs the full gate (`npm ci` → `tsc --noEmit` → `vitest`), then `npm stage publish --provenance`. It uses **OIDC trusted publishing** (`id-token: write`) — no long-lived npm token exists in the repository or its secrets — and **stages** rather than publishes: a maintainer reviews and approves with 2FA before a version goes live. This follows npm's own CI recommendation and sidesteps the January-2027 removal of direct-publish granular tokens.

**Install-mode flexibility:** pi's loader (`resolveExtensionEntries`) is manifest-aware in every scope, so the same package works as a global npm install, a project-local install, a git install (pinned ref), or a local-path install (development). Never load two copies at once — dedupe is by resolved absolute path, so distinct install roots register duplicate tools and commands.

## File Structure

```
brl-subagent/
├── src/
│   ├── types.ts              # Type definitions, constants, helpers (F5, F9); BackgroundAgent, SubagentEvent
│   ├── sanitize.ts           # Input/output/env sanitization (F1-F3); assertSafeAgentId UUID validation (#36)
│   ├── validate.ts           # H1 pre-task validation + H3 post-mortem diagnostics
│   ├── params.ts             # Parameter resolution — per-call params × preset merge, caps, tool fixes (#59)
│   ├── paths.ts              # Package-root path resolution — pkgPath() helper for presets/templates/package.json/AGENT.md (#160)
│   ├── presets.ts            # Preset loading, parsing, validation (R10); file-backed write helpers (#14)
│   ├── state.ts              # Session-bound state management (F5, F7, F9)
│   ├── prompt.ts             # System prompt construction; promptGuideline → "Preset Guidance" section (#19); wrapTask task-as-data fence + Task Boundary directive (#27/#42)
│   ├── runner.ts             # Process spawning and stdout parsing; wrapTask applied to the -p task argument (F27)
│   ├── concurrency.ts        # Concurrency queue and progress tracking (F8)
│   ├── history.ts            # Run record management and retry logic
│   ├── unit-run.ts           # Per-unit run-entry helpers — createUnitRun, finalizeUnitRun, finalizeUnitRunCrash, registerLiveRun, pruneHistoryIfNeeded, makeLiveOnUpdate (#132/#136)
│   ├── router.ts             # Skill-based auto-routing — task text → preset (E2)
│   ├── reports.ts            # Compliance reports — file access, secrets exposure (E5)
│   ├── metrics.ts            # SLA metrics — latency percentiles, degradation detection (E4)
│   ├── messaging.ts          # Inter-subagent messaging via [TO:agent-id]: (E10) — standalone-line extraction (#129)
│   ├── messaging.ts          # Inter-subagent messaging via [TO:agent-id]: (E10)
│   ├── model-availability.ts # Auth-aware model availability check — catalog + provider auth (#4/#16)
│   ├── event-bus.ts          # Lifecycle event pub/sub for background agents
│   ├── transcript.ts         # JSONL transcript recording
│   ├── transcript-tail.ts    # Drill-in transcript tail builder — byte-budgeted live tail (#89/#105)
│   ├── session-manager.ts    # Background session lifecycle — create/spawn/steer/stop/poll; literalPrompt wrap (F26) + wrapTask at session.prompt (F27)
│   ├── tui.ts                # All TUI rendering and UI interactions
│   ├── tui-format.ts         # Pure monitor row formatting — liveRowName etc. (#61/#78)
│   ├── logging.ts            # Structured logging with rotation (F10)
│   ├── preflight.ts          # Pre-flight environment validation (R3)
│   ├── git.ts                # Git integration — branch-based workflow (P3)
│   ├── diff.ts               # Git diff parser — structured file-level summaries (P5)
│   ├── templates.ts          # Task template resolution with ${param} substitution (P9)
│   ├── scheduler.ts          # Dependency graph scheduler — cycle detection, topological sort (P10)
│   └── index.ts              # Extension orchestrator entry point
├── presets/              # Built-in personality profiles
│   ├── code-reviewer.md
│   ├── security-auditor.md
│   ├── test-engineer.md
│   ├── tech-writer.md
│   ├── rapid-prototyper.md
│   ├── debugger.md
│   ├── refactorer.md
│   └── data-analyst.md
├── .development/         # Project documentation
│   ├── ARCHITECTURE.md   # This file
│   ├── AUDIT.md          # Strengths & weaknesses
│   ├── ROADMAP.md        # Future planning
│   ├── TASKS.md          # Task tracking
│   ├── PER_PRESET_MODEL.md
│   ├── PRESET_MIGRATION.md
│   ├── TEST_PLAN_BG_RESULTS.md
│   ├── PRESET_DEMO_AUDIT.md
│   └── DOCS_CURRENCY_AUDIT.md
├── package.json          # pi package manifest
├── README.md             # User-facing documentation
└── LICENSE               # MIT
```

## Architecture Layers

### 1. Configuration Layer
- **`/brl-subagent` command** — opens interactive TUI menu
- **Model selection** — `ctx.modelRegistry.getAvailable()` → select via `SelectList`
- **Thinking level** — ceiling set via `THINKING_LEVELS` array; per-call capped
- **Concurrency** — `maxParallel` (0 = unlimited); queue-based slot system
- **Recursion depth** — `maxSubagentDepth` (default 1); prevents infinite subagent chains via `BRL_SUBAGENT_DEPTH` env var
- **Git mode** — `gitMode` ("branch" | "none"); branch-based isolation workflow
- **Approval mode** — `approvalMode` ("auto" | "writes" | "always"); controls change review flow
- **Cost governance** — `sessionCostLimit` (0 = unlimited); pre-delegation threshold check
- **Presets** — built-in loaded from `presets/*.md` (updated via `pi install`, never touched by users); custom presets loaded from `.pi/brl-subagent/presets/` (project-local) and `~/.pi/agent/brl-subagent/presets/` (global) as `.md` files with YAML frontmatter. Custom presets survive `pi install` updates. A preset's `promptGuideline` is appended to the subagent prompt as a `## Preset Guidance` section (`prompt.ts:99-100`, #19).
- **Templates** — user-saved task configurations with `${param}` substitution slots
- **State persistence** — `pi.appendEntry("brl-subagent-state", {...})`

### 2. Tool Registration Layer
- **`delegate_task`** — registered via `pi.registerTool()`
- Parameters defined via TypeBox schemas with 24+ parameters (13 original + chain, tasks, graph, template, params, retryRunId, gitMode, retryOnTimeout, approvalMode, priority, background, model override)
- **Tool configuration**: `tools` and `excludeTools` parameters allow direct control of which tools are available to subagents (replaces former SandboxLevel system)
- Supports four execution modes: single, chain, parallel, graph
- **`get_subagent_result`** — poll a background agent's status/result (`agent_id`, `wait`, `verbose`)
- **`steer_subagent`** — send a steering message to a running background agent (`agent_id`, `message`)
- `renderCall` / `renderResult` — custom TUI rendering with mode-specific views

### 3. Execution Layer
- **`runSubagent()`** — core async function (in `runner.ts`)
  - Builds subagent args (`--mode json -p --no-session --model X --thinking Y --tools Z`)
  - F27: the task is wrapped in the `<task>…</task>` data fence by `wrapTask()` before it becomes the `-p` user message (applied AFTER `{previous}`/`{otherId}` substitution so substituted output lands inside the fence); embedded `<task>`/`</task>` markers are neutralized to fullwidth `〈task〉`/`〈/task〉` so the fence cannot be forged (#42)
  - Writes system prompt to temp file (`.pi/subagent-tmp/`)
  - Spawns `pi` child process via `getPiInvocation()`
  - Parses JSON-line stdout into `message_end` and `tool_result_end` events
  - Accumulates usage stats (tokens, cost)
  - Handles abort signal + timeout (SIGTERM → 5s → SIGKILL)
  - Cleans up temp files in `finally`
  - Signature (14 params): `(cwd, systemPrompt, model, thinkingLevel, task, signal, onUpdate, toolOptions, timeout, getFinalOutputFn, log, depth, intercom, subagentId)` — the process-pool parameter was removed with the pool (#41/#44)
- **`runChainMode()`** — sequential step execution with `{previous}` placeholder substitution
- **`runParallelMode()`** — concurrent fan-out with per-task concurrency slot acquisition. INCIDENTAL FIX (post-2.1.2): the parallel path previously passed 16 args to the 15-param `runSubagent`, silently dropping `intercom`/`subagentId` — parallel subagents never received intercom messages. Now passes both (`index.ts:1047`).
- **`runGraphMode()`** — wave-based execution using topological sort from `scheduler.ts`

### 4. Results Layer
- **`SubagentResult`** — messages array, usage stats, exit code, stderr, error category, git branch/diff, approved flag
- **`SubagentRun`** — persisted run record with ID, timestamps, cost, output, original params, error category
- **`ChainDetails`** / **`ParallelDetails`** / **`GraphDetails`** — aggregate results for multi-task modes
- **Run history** — stored as custom session entries; auto-pruned to `maxHistoryEntries` (default 500)
- **Live monitor** — `subagentSessions` Map; spinning indicator dashboard. **All five modes register per-unit entries** (single/background/parallel/graph/chain — #130/#133) with streaming drill-in; the staleness sweep treats a foreground live entry without a persisted run entry as stale (the invariant every mode now satisfies — #133); the status bar shows the **mode breakdown** (`graph wave x/y · node x/y`, `chain step x/y`) composed with the background counters, and run history carries **aggregate dispatch entries** ("Graph dispatch: N tasks in M waves"). **Completion-push (#147):** terminal background events wake the conductor via `pi.sendMessage` + `triggerTurn` (structured `subagent-completion` message; `completionNotify` knob; see the Subagent Messaging section)

### 5. TUI Rendering Layer
- **Collapsed view** — icon + label + model + output preview (5 lines) + usage
- **Expanded view** — full Markdown output + detailed usage stats
- **Chain view** — per-step status with collapsed/expanded output and diff summaries
- **Parallel view** — per-task status with success/fail counts
- **Graph view** — per-wave per-task status with dependency visualization
- **Diff views** — collapsed file summary (+N -M), expanded hunks (capped at 10/file), full raw diff (press D)
- **Approval dialog** — apply/discard/view-diff with keyboard shortcuts
- **Live monitor** — per-subagent spinner, token counters, elapsed time, latest output
- **Status-bar breakdown** — `graph wave x/y · node x/y` / `chain step x/y` composed with the background done/failed/unseen counters (`brl: graph wave 1/2 · node 2/3, 2 running`) — per-unit success flags feed the counters honestly (#137)
- **Config menu** — `SelectList`-based menus for model, thinking, concurrency, depth, approval, cost limit, history, presets, templates, retry, monitor, dashboard, SLA (issue #114: the default-priority knob was removed — priority is per-unit, negotiated in conversation)

## Data Flow

```
User prompt → LLM decides to delegate
  → delegate_task.execute()
    → sanitizeTask()                (F1: injection prevention)
    → validateCwd()                 (F1: path traversal prevention)
    → validateOutputFile()          (F1: containment check)
    → resolveTemplate()             (P9: ${param} substitution)
    → checkCostLimit()              (R5: budget gate)
    → getCurrentDepth()             (recursion guard)
    → resolveSubagentParams()       (merge preset + explicit + state)
    → resolveSubagentModel()        (preset.model > config.model > conductor model; auth-aware via modelIsAvailable, #16)
    → validatePreTask()             (H1: hard-reject outputFile-without-write; tool/thinking/git checks = warnings, #33)
    → preflightCheck()              (R3: pi binary, cwd, temp dir)
    → switchToBranch() (if gitMode) (P3: create work branch)
    → checkCircuit()                (R1: circuit breaker gate)
    → acquireSlot(priority)         (concurrency gate with priority queue)
    → buildSubagentPrompt()         (inherit + custom + output instructions)
    → runSubagent()                 (spawn pi process, parse stdout)
        → wrapTask()                (F27: task-as-data fence on the -p user message; after {previous}/{otherId} substitution)
        → parseSubagentLine()       (JSON-line → message_end/tool_result_end)
        → accumulateUsage()         (track tokens, cost)
        → emitSubagentUpdate()      (stream to onUpdate callback)
    → sanitize output               (F3: strip ANSI, cap size)
    → captureDiff() (if gitMode)    (P3: diff against base branch)
    → showApprovalDialog()          (P4: merge/discard workflow)
    → switchBack + merge/delete     (P3+P4: cleanup or merge work branch)
    → finalizeRunRecord()           (save run to session, classify error)
    → recordSuccess/Failure()       (R1: circuit breaker tracking)
    → releaseSlot()                 (free concurrency slot)
  → Tool result returned to LLM with content + details
```

For multi-task modes, the flow diverges:

```
Chain mode:
  → for each step: resolveSubagentParams → resolveStepModel (step.model > global model, #39) → runSubagent → capture output → {previous} substitution

Parallel mode:
  → Promise.allSettled(): each task acquires its own slot → resolveStepModel (per-task model, #39) → runSubagent concurrently

Graph mode:
  → topologicalSort() → waves → for each wave: Promise.allSettled() within wave
  → resolveStepModel (per-task model, #39) → substitute {taskId} placeholders from completed task outputs
```

## State Management

State is persisted as custom session entries, managed by the `SessionState` class (`state.ts`):

| Entry Type | Key | Contents |
|-----------|-----|----------|
| `brl-subagent-state` | Session-level | `model`, `maxThinkingLevel`, `maxParallel`, `maxSubagentDepth`, `gitMode`, `approvalMode`, `defaultPriority`, `maxHistoryEntries`, `sessionCostLimit`, `perTaskCostEstimate`, `seenRunIds`, `templates`, `circuitBreaker`, `slaTrackingEnabled`, `slaWindowSize`, `lastSLAMetrics` |
| `brl-subagent-run` | Per-invocation | `id`, `task`, `label`, `status`, `model`, `thinkingLevel`, timestamps, `cost`, `tokensIn/Out`, `outputSummary`, `fullOutput`, `originalParams`, `errorCategory`, `gitBranch`, `gitDiff`, `approved` |

State is restored on `session_start` via `restoreFromSession()` using type guards (`isSubagentStateShape`) — no `as any` casts. Corrupted entries are logged and skipped, falling back to defaults.

## Module-Level State (Session-Bound)

All mutable state is encapsulated in the `SessionState` class (`state.ts`), which is initialized in `session_start` and cleaned up in `session_shutdown`:

- **Progress counters**: `activeSubagents`, `completedSubagents`, `failedSubagents`, `unseenSubagents` — mutated through `acquireSlot`/`releaseSlot` (foreground modes) and the background poller's terminal paths; both are on the single-threaded `SessionState` instance, so the mutations are race-safe by construction
- **Concurrency queue**: `pendingQueue` — priority-ordered, cleared on shutdown
- **Live sessions**: `subagentSessions` Map — auto-expires entries after 3 seconds, cleared on shutdown
- **Config**: All user-configurable fields stored in `this.config`
- **Schedules**: `Map<string, ScheduleEntry>` — recurring task definitions (E9)
- **SLA**: Metrics computation and degradation tracking (E4)

This ensures no stale state leaks across sessions (`/resume`, `/new`).

## Module Count Summary

| Phase | Modules Added | Running Total |
|-------|---------------|---------------|
| P1 Foundation | types, sanitize, presets, state, prompt, runner, concurrency, history, tui, logging, preflight, index | 12 |
| P3 Power | git, diff, templates, scheduler | 16 |
| P4 Excellence | router, reports, metrics, messaging, tui-format | 21 |
| P5/P6 Hardening + Background | validate, model-availability, params, event-bus, transcript, transcript-tail, session-manager, update | 29 |
| Post-2.3.1 (#135, 2026-08-26) | unit-run (per-unit run-entry helpers: makeLiveOnUpdate, createUnitRun, finalizeUnitRun, finalizeUnitRunCrash, registerLiveRun, pruneHistoryIfNeeded) | 30 |
| Post-2.3.5 (#160, 2026-09-11) | paths (package-root path resolution — `pkgPath()`, single-sources the `<pkg>/src` → `<pkg>` base used by presets/templates/package.json/AGENT.md) | 31 |
| Post-2.3.5 (#164, 2026-09-12) | **update — REMOVED** (the obsolete version notifier; pi notifies natively and the GitHub-release check misdirected under the npm channel) | 30 |
| **Total** | | **30 source modules** |

Note: `roles.ts` (E6), `backend.ts` (E8), `pool.ts` (E11) and `schedule.ts` (E9) were removed — E9's recurring-task scheduler was deleted in #91 (2026-08-14, never dogfooded; the graph `scheduler.ts` is untouched). `tui-format.ts` (#78), `params.ts` (#59), `transcript-tail.ts` (#89) and `unit-run.ts` (#135) joined the inventory. The P5/P6 additions include the H1 validation module (`validate.ts`), auth-aware model availability (`model-availability.ts`), and the background-session stack (event-bus, transcript, transcript-tail, session-manager, update). `index.ts` is the orchestrator entry point; all modules are imported from it.

## Background Execution Architecture (Phase 6)

Phase 6 shifts from a **subprocess-based (blocking)** model to a **session-based (non-blocking)** model for background agents.

### Current Architecture (Subprocess-Based)

```
Conductor (blocking)
  → delegate_task.execute()
    → spawn pi child process
    → wait for completion (blocks caller)
    → return result
```

- The conductor blocks while the subagent runs
- Conductor cannot do other work during delegation
- Limited to one delegation at a time per conductor

### New Architecture (Session-Based)

```
Conductor (non-blocking)
  → delegate_task.execute(background: true)
    → W5: reject approvalMode 'always'; warn on 'writes' (no dialog in background)
    → W6: R5 session cost check (before spawn — background can't bypass the limit)
    → validatePreTask (H1)             (hard-reject outputFile-vs-write, #33)
    → session-manager.spawnBackgroundSession()
      → W4: gitMode='branch'? create work branch first (refuse dirty tree; per-repo lock)
      → build own DefaultResourceLoader (noExtensions + noSkills, #36)
      → appendSystemPrompt(literalPrompt) (F26: systemPrompt wrapped as `\n<system-prompt>\n…\n</system-prompt>\n` so resolvePromptInput's existsSync→readFileSync can never read a path-looking prompt as a file; also carries the full built prompt, #21)
      → createAgentSession(model, thinkingLevel, toolOptions)
      → session.prompt(wrapTask(task))   (F27: task-as-data fence)
      → W3: arm per-agent timeout (pre-set stopped + reason, then abort at deadline)
    → return agent ID immediately
    → conductor continues working

  Later: get_subagent_result({ agent_id, wait, verbose })
    → poll status: pending → running → completed/failed/stopped
    → poller in index.ts (hardcoded 2000ms interval; hard cap ABORTS the session, W2)
    → gitMode='branch' result carries gitBranch + gitDiff (captured at teardown, W4)

  On demand: steer_subagent({ agent_id, message })
    → record message in transcript; status → steered
    → (live delivery pending pi's extension API)

  On demand: stop_subagent({ agent_id })
    → stopAgent(id): pre-set 'stopped' → await session.abort() → complete transcript
    → probe contract: prompt() RESOLVES with stopReason "aborted" (never .catch)
```

### New Modules (Phase 6)

| Module | Purpose | Dependencies |
|--------|---------|--------------|
| `types.ts` (extended) | `BackgroundAgent`, `TranscriptEntry`, `SubagentEvent` types | — |
| `session-manager.ts` (new) | Create, track, stop, steer background sessions | types.ts, event-bus.ts |
| `transcript.ts` (new) | JSONL transcript recording for replay and analysis | types.ts |
| `event-bus.ts` (new) | Lifecycle event pub/sub for cross-module reactions | types.ts |

### Session Manager Design

```typescript
interface BackgroundAgent {
  id: string;                    // unique agent ID
  sessionId: string;             // pi session ID
  type: string;                  // agent type (label)
  description: string;           // human-readable description
  status: AgentStatus;           // pending | running | completed | failed | stopped | steered
  startedAt: number;             // creation timestamp
  completedAt?: number;          // completion timestamp
  task: string;                  // original task text
  model: string;                 // model used
  thinkingLevel: ThinkingLevel;  // thinking level used
  finalOutput?: string;          // final output captured on completion
  result?: SubagentResult;       // final result (if completed)
  error?: string;                // error message (if failed)
  /** @internal — session reference for live monitor polling */
  _sessionRef?: AgentSession;    // live pi session; stripped by persistAgent
}
```

The transcript path is derived, not stored: `getTranscriptPath(id)` → `.pi/output/agent-<id>.jsonl` (validates the id via `assertSafeAgentId` before joining).

**Persistence**: Agent records stored in `Map<string, BackgroundAgent>` and persisted to `.pi/subagents/<agentId>.json` for crash recovery.

### Transcript Design

```typescript
interface TranscriptEntry {
  type: TranscriptEntryType;     // system | user | assistant | tool_call | tool_result | error
  timestamp: number;             // entry creation time
  content: string;               // entry content
  metadata?: Record<string, unknown>; // optional context (tool name, etc.)
}
```

**Storage**: Each agent gets a JSONL file at `.pi/output/agent-<agentId>.jsonl`. Entries are appended as they arrive (streaming, not buffered). Transcripts can be read back for replay, debugging, or mid-run steering.

### Event Bus Design

```typescript
type SubagentEventType = 
  | 'subagent:created'
  | 'subagent:started'
  | 'subagent:completed'
  | 'subagent:failed'
  | 'subagent:stopped'
  | 'subagent:steered'
  | 'subagent:compacted';

interface SubagentEvent {
  type: SubagentEventType;
  agentId: string;
  timestamp: number;
  data: Record<string, unknown>;
}
```

**Pattern**: Simple in-memory pub/sub. Synchronous emission. Listeners called in registration order. No persistence — events are ephemeral notifications.

### Steering Protocol

Mid-run steering records a message against a running background agent (delivery into the live session is pending pi's extension API):

1. Conductor calls `steerAgent(agentId, "Also check the error handling in login.ts")`
2. Session manager appends the message to the agent's transcript (`transcript.appendEntry(id, 'user', 'Steering: …')`)
3. Agent status transitions to `steered` (only valid while `running`)
4. `subagent:steered` event emitted via the event bus
5. Transcript records both the steering message and the agent's subsequent response

README (#23): *"Steering via `steerAgent` currently records the message in the transcript and marks the agent as steered — delivery to the live session is pending pi's extension API."* The `steer_subagent` tool description still claims the message "interrupts after the current tool execution", but the implementation is transcript + status only.

**Live evidence (#28, 2026-08-03):** steering a background agent to STOP did NOT abort the in-process session — status flipped to `steered`, but the live monitor kept showing it running and the `session.prompt` loop continued. This evidence became issue #28. **CLOSED (2026-08-06):** stopping now goes through `stop_subagent` → `stopAgent()` → `session.abort()` (a real abort — see [Abort & Safety Controls](#abort--safety-controls-issue-28)); steering remains transcript + `steered` status only.

### Abort & Safety Controls (issue #28, PRs #47/#49/#50/#51)

Issue #28 — *background sessions bypass safety controls; no real abort* — is CLOSED (live-verified 2026-08-06). The abort path and the safety controls background sessions now honor:

**Abort path (W1, PR #47):** `stop_subagent({ agent_id })` → `stopAgent(id)` (`session-manager.ts:271`):
1. Pre-set status `stopped` FIRST — the `.then` handler in `spawnBackgroundSession` fires after the run settles and must not overwrite it.
2. `await session.abort()` (waits for the agent to become idle).
3. Complete the transcript (`completeTranscript(id, 'stopped')`).

**Probe contract (`sdk-abort-contract.test.ts`):** `session.prompt()` RESOLVES on abort — the SDK's `runWithLifecycle` catches the AbortError and converts it into a failure message with `stopReason: "aborted"`. So an aborted run lands in the `.then` handler, never `.catch`. Stopped-vs-completed discrimination is `.then`-based: `aborted = agent.status === 'stopped' || lastAssistant?.stopReason === 'aborted'`. A genuine preflight rejection (auth failure, model resolution) still lands in `.catch` as `failed`.

**Per-agent timeout + hard cap (W2+W3, PR #49):**
- The W3 deadline timer is armed immediately after `session.prompt(...)` is called, so in-prompt preflight (auth check, model resolution) counts toward the deadline. On fire: if `agent.completedAt` is set the timer is a no-op (double-fire guard); otherwise it pre-sets `stopped` with the reason (`Timed out after ${timeout}ms`) and aborts the session.
- The index.ts hard cap (`hardCapMs = Math.min(timeout ?? 30min, 30min)`) previously only stopped the poller — the pi session kept running forever (orphaned-session leak). It now also pre-sets `stopped` and calls `session.abort()`, honoring a shorter per-agent timeout.

**Honest termination records (#120, 2026-08-27):** every kill path stamps the abort source BEFORE the SIGTERM — user-cancel → `Subagent aborted by user` + category `aborted`; timeout → `Timed out after ${timeout}ms` + `timeout`; the catch-all included (no path left without a category). The stamp survives reclassification via classifyError's `aborted by user` pattern, and the shared `SUBAGENT_ABORTED_MESSAGE` constant keeps stamp sites and classifier in sync. Failure records are further enriched with the model-error turn count (`enrichFailureDiagnostics`). The run's status stays `failed` (the vocabulary has no "aborted") — the truth lives in errorMessage + errorCategory. (The provider-side `Connection error.` class is external — diagnosed and mitigated, not fixable here.)
- `normalizeTimeout` (`validate.ts:291`) maps `0`/negative/`NaN`/`Infinity`/`≥2^31` → `undefined` (no timeout); the timer clamps to 30 min so a raw large value can't fire at ~1ms.
- Timer callbacks never throw uncaught — status flips are recorded before the best-effort abort (a throw in a timer callback would kill the host process).

**gitMode=branch lifecycle (W4, PR #50):**
- A work branch is created BEFORE the prompt runs (`createWorkBranch`), so the agent's writes land on the branch, never on the base working tree. A branch that cannot be created is a hard failure — the spawn is refused; background never falls back to running unisolated.
- C1: a dirty working tree refuses the spawn loudly — uncommitted changes would ride onto the work branch, get clobbered by the agent's writes, and leak back into the base tree on switch.
- Teardown (`cleanupWorkBranch`) runs on EVERY settle path (complete / fail / abort): `commitAll` first so `captureDiff(base...HEAD)` sees real commits (agents rarely commit — C1), with `captureWorkingDiff` as the untracked fallback (intent-to-add + path-limited reset, #51); then switch back to the original branch, delete the work branch, and release the per-repo lock. The branch name + captured diff are recorded on `agent.result` (`gitBranch`/`gitDiff`) and surfaced by `get_subagent_result` — partial work from an aborted run is preserved, not discarded.
- C2: a per-repo lock (`gitBranchLocks` map) serializes the FULL lifecycle (setup → run → teardown). Without it concurrent branch-mode spawns would read each other's work branch as their base and both teardowns would fight over the shared working tree (stranding the repo on an orphan branch). Released on every exit path.

**approvalMode (W5, PR #50):** `'always'` is rejected before spawn — there is no interactive dialog in background mode, so an unattended agent with write access can't present one. `'writes'` silently auto-approves with a warning logged (`index.ts:2176-2191`).

**Session cost limit (W6, PR #50):** the R5 check runs BEFORE the background branch (`index.ts:2164-2194`, same estimate/limit logic as single mode) — a session at its cost limit can no longer bypass it by delegating to background.

**Gate A test tier (PR #51):** the `*-real.test.ts` convention — real-tool tests against scratch state (real git in OS temp dirs, `canRunSubprocessTests` guard, run in CI and the worktree smoke test). `git-real.test.ts` pins the branch-lifecycle behaviors mocked tests encoded wrongly (C1/C2) plus `captureWorkingDiff`'s untracked handling; `sdk-abort-contract.test.ts` pins the abort probe contract empirically (real `createAgentSession` with a hanging fake modelRuntime, aborted mid-run).

### Polling Mechanism for Background Agents

Background agents are polled via the `get_subagent_result` tool (`agent_id` / `wait` / `verbose` params):

1. **Poll interval**: hardcoded **2000ms** in the index.ts poller (`setInterval(…, 2000)`) — there is **no** `pollIntervalMs` parameter
2. **Status states**: `pending` → `running` → `completed` | `failed` | `stopped` (plus `steered`)
3. **Result retrieval**: Returns the result when completed — `Final output:` section capped at **8000 chars** (full output in transcript); progress message while running
4. **Transcript access**: Includes transcript path; `verbose: true` appends the last 10 transcript entries
5. **Hard cap**: polling stops after 30 minutes (or the per-agent timeout, whichever is shorter) — the session is now ABORTED, not just abandoned (W2). Status flips to `stopped` with the timeout reason and a notification fires. Pre-#28 the cap only stopped the poller, orphaning the live session.

### Notification System for Background Agents

Background agents emit notifications to the conductor via `pi.sendMessage()` with `{ deliverAs: "followUp" }` to report lifecycle events. This provides real-time visibility into agents running independently.

#### Notification Events

| Event | Trigger | Content |
|-------|---------|---------|
| `completed` | Agent finishes successfully | `Background agent "<description>" completed.` |
| `crashed` | Agent encounters an unhandled error | `Background agent "<description>" crashed.` |
| `stopped` | User abort via `stop_subagent` OR deadline (per-agent timeout / hard cap) | `Background agent "<description>" stopped.` (timeout/cap include the reason, e.g. `stopped (Timed out after 20000ms)` / `timed out (1800000ms hard cap)`) |

#### Implementation

```typescript
pi.sendMessage({
  customType: "subagent-notification",
  content: `Background agent "${agent.description}" completed.`,
  display: true,
  details: { agentId: agent.id }
}, { deliverAs: "followUp" });
```

- **`customType: "subagent-notification"`** — distinguishes these from other message types
- **`display: true`** — ensures the notification is visible to the user
- **`details.agentId`** — allows the conductor to correlate notifications to specific agents
- **`{ deliverAs: "followUp" }`** — delivers the message as a follow-up to the original delegation, appearing inline in the conversation

#### Lifecycle Integration

Notifications are emitted from the **background agent polling loop in `index.ts`** (~2268-2370) — not from `spawnBackgroundSession`'s result handler (that lives in `session-manager.ts`):
1. Agent status transitions to `completed` → emit notification
2. Agent status transitions to `failed`/`crashed` → emit notification
3. Agent is aborted (user `stop_subagent`) or hits its deadline (per-agent timeout / hard cap) → the session is aborted and a `stopped` notification fires (pre-#28 the watchdog only stopped the poller, orphaning the session)
4. All other transitions (pending → running) are tracked internally without notifications

### Background Security & Prompt Model (#21/#26/#27/#33/#36)

- **Prompt injection** — the built prompt (base + inherit + custom + preset guidance) reaches the session via `DefaultResourceLoader.appendSystemPrompt` (`session-manager.ts:345-371`), the same mechanism pi uses for `--append-system-prompt`. The SDK exposes no `systemPrompt` option on `createAgentSession`.
- **Literal prompt wrap (F26, #26)** — a raw `systemPrompt` string is wrapped as `\n<system-prompt>\n…\n</system-prompt>\n` before `appendSystemPrompt` (`session-manager.ts:370-372`). This defeats the SDK's `resolvePromptInput` (resource-loader.js:16): it `existsSync(input)`-checks the string and `readFileSync`s it if it matches a real path — a raw prompt value like `.env` or `package.json` would be silently REPLACED by that file's contents (arbitrary-file-read-into-prompt). The wrap guarantees the value is (1) a multi-component RELATIVE path (the `/` in `</system-prompt>` — a leading `\n` guarantees no `/` prefix, so it can never equal a single-component name like `.env`), and (2) exceeds NAME_MAX=255 on mainstream filesystems (SUBAGENT_INSTRUCTIONS ≈ 1644 bytes with no `/` is appended by `buildSubagentPrompt`, so one contiguous component is > 255 chars) → the path can never exist → `existsSync` is always false. Windows: `\n`, `<`, `>` are illegal in filenames outright.
- **Task fence (F27, #27)** — the task is wrapped in `<task>…</task>` markers by `wrapTask()` before `session.prompt(...)` (`session-manager.ts:452`), matching the foreground `-p` chokepoint. The `SUBAGENT_INSTRUCTIONS` "Task Boundary" directive reframes the content as DATA, not instructions (see `prompt.ts`). Embedded markers are neutralized to fullwidth variants (#42).
- **Loader isolation** — background always builds its own `DefaultResourceLoader({ cwd, agentDir, settingsManager, noExtensions: true, noSkills: true })` (`session-manager.ts:354-369`). If no loader were passed, `createAgentSession` would import extension/skill code from the LLM-controlled target cwd into this process (RCE; F25 fix, #36). `noExtensions`/`noSkills` are blanket — they also disable user-global extensions/skills (e.g. `~/.pi/agent/skills`); users needing those should use foreground delegation.
- **Tool options honored** — `createAgentSession` receives the resolved `toolOptions`: `tools` allowlist (default `['read','bash','grep','find','ls','write','edit']`), `excludeTools` blocklist, `noBuiltinTools` → `noTools: 'builtin'` (`session-manager.ts:374-391`). Pre-#33 the toolset was hardcoded regardless of the prompt (the demo-audit F5 bypass).
- **Background H1 validation** — `validatePreTask()` runs before spawn; an `outputFile`-vs-`write` conflict is a hard error that rejects the delegation before tokens are spent (`index.ts:2186-2201`, #33).
- **Model resolution** — the model STRING is resolved to a real `Model` object via `ctx.modelRegistry.find(provider, modelId)` before `createAgentSession` (a raw string yields "No API key found for undefined" and clamps thinking to off); `thinkingLevel` is forwarded to the session (`session-manager.ts:325-338, 387`).

### Concurrency Safety

Background spawns use dynamic imports + a serialization queue to prevent module caching issues when multiple agents start simultaneously. The `crypto.randomUUID()` fallback uses `Math.random()` when crypto is unavailable.

### Integration with Existing Modules

| Existing Module | Integration |
|-----------------|-------------|
| `concurrency.ts` | Background agents bypass concurrency queue (they run in separate sessions) |
| `runner.ts` | Background agents use `pi sessions start` instead of direct `spawn()` |
| `state.ts` | Background agent records persisted alongside run history |
| `tui.ts` | New views: agent list, agent status, transcript viewer, steering input |
| `history.ts` | Completed background agents added to run history |

## Recursion Depth Tracking

To prevent infinite subagent chains, a `BRL_SUBAGENT_DEPTH` env var is injected into each subprocess:

```
Conductor (depth 0)
  → spawns subagent with BRL_SUBAGENT_DEPTH=1
    → subagent checks: depth 1 >= maxSubagentDepth (default 1)?
    → if yes: rejects delegate_task with error
    → if no: could spawn with BRL_SUBAGENT_DEPTH=2
```

- `getCurrentDepth()` reads the env var (defaults to 0 if unset)
- `delegate_task.execute()` rejects calls when `currentDepth >= maxSubagentDepth`
- `runSubagent()` passes `childDepth = currentDepth + 1` via `getSafeEnv()` overrides
- `BRL_SUBAGENT_DEPTH` is in the safe env allowlist so it propagates through nesting
- Default `maxSubagentDepth: 1` — subagents cannot delegate further
- Configurable via `/brl-subagent depth` or the configuration menu

## Error Classification

The `classifyError()` function in `types.ts` categorizes subagent failures into 9 categories, inspected in priority order:

| Category | Pattern |
|----------|---------|
| `aborted` | `stopReason === "aborted"` |
| `timeout` | errorMessage includes "timed out" |
| `model_unavailable` | errorMessage includes "model not found" or "model unavailable" |
| `permission_denied` | errorMessage includes "permission denied" or "EACCES" |
| `parse_error` | stderr includes parse error markers |
| `crash` | stderr includes "crash", "panic", or "segmentation fault" |
| `tool_error` | errorMessage includes "spawn", "not found", or "ENOENT" |
| `exit_error` | non-zero exit code or stopReason === "error" |
| `unknown` | fallback |

Error categories are stored on run records (`errorCategory` on `SubagentRun.originalParams`) for analysis and retry routing.

## Circuit Breaker

The circuit breaker in `state.ts` (R1) prevents cascading failures:

- **Threshold**: 5 consecutive failures (`MAX_CONSECUTIVE_FAILURES`)
- **Action**: Opens circuit, records failure time, degrades thinking level to `"minimal"`
- **Auto-recovery**: After 60 seconds (`CIRCUIT_BREAKER_RESET_MS`), the circuit closes automatically
- **Recording**: `recordSuccess()` resets counters; `recordFailure()` increments and may open circuit
- **Check**: `checkCircuit()` returns `{ isOpen, message, waitTimeRemaining }`
- **Integration**: Called at the start of `delegate_task.execute()` — rejects if open

## Cost Governance

Cost governance (R5) enforces per-session budget limits:

- **`sessionCostLimit`**: Maximum total cost for the session (0 = unlimited)
- **`perTaskCostEstimate`**: Estimated cost per delegation (0 = use default $0.05)
- **`getSessionTotalCost()`**: Sums cost from all completed runs
- **`checkCostLimit(cost, ctx)`**: Returns true if adding `cost` would exceed the limit
- **Integration**: Checked before spawning — returns a clear error with current spend and limit

## Pre-flight Checks

The `preflightCheck()` function in `preflight.ts` (R3) validates the execution environment before consuming resources:

1. **Pi binary availability** — checks `getPiInvocation()` resolves, or walks PATH for `pi`
2. **Cwd readability** — verifies the project directory exists, is readable, and is a directory
3. **Temp directory writability** — creates and removes a test file in `os.tmpdir()`

Returns `{ ok: true }` or `{ ok: false, error: "..." }` with a human-readable description.

## Git Integration (P3)

The `git.ts` module provides branch-based workflow for subagent isolation. All git commands use `execFileSync` with a 10-second timeout to prevent shell injection.

### Functions

- **`getCurrentBranch(cwd)`** — returns the current branch name via `git rev-parse --abbrev-ref HEAD`
- **`hasUncommittedChanges(cwd)`** — checks for dirty working tree via `git status --porcelain`
- **`createWorkBranch(cwd, baseBranch)`** — creates `brl-subagent-<uuid>` branch from base
- **`captureDiff(cwd, baseBranch)`** — returns unified diff between base branch and HEAD via `git diff baseBranch...HEAD`
- **`switchToBranch(cwd, branch)`** — switches to an existing branch via `git checkout`
- **`mergeWorkBranch(cwd, branch)`** — merges a branch with `--no-edit`
- **`deleteBranch(cwd, branch)`** — force-deletes a branch via `git branch -D`

### Workflow

1. Captures the original branch name
2. Creates a work branch (`brl-subagent-<uuid>`) from the original
3. Runs the subagent on the work branch
4. Captures the diff between the original branch and the work branch
5. Switches back to the original branch
6. Presents the approval dialog (P4) or auto-merges based on `approvalMode`
7. Merges or discards the work branch
8. Falls back to `gitMode: "none"` on any git error

### Shell Safety

All git operations use `execFileSync` (not `execSync` or `spawn` with shell: true) to prevent shell injection via crafted branch names or paths. Each command has a 10-second timeout.

## Task Chaining and Parallel Mode (P1+P2)

### Chain Mode (P1)

Sequential execution of tasks where each step can reference the previous step's output.

- **Parameter**: `chain: SubTaskParams[]` (max `MAX_CHAIN_STEPS` = 10)
- **Placeholder**: `{previous}` in task text is replaced with the final output of the preceding step
- **Failure handling**: Chain stops at the first failed step (unless it's the last step)
- **Result type**: `ChainDetails` with per-step `SubTaskResult` array, completion counts, and `stoppedEarly` flag

### Parallel Mode (P2)

Concurrent fan-out execution of independent tasks.

- **Parameter**: `tasks: SubTaskParams[]` (max `MAX_PARALLEL_TASKS` = 8)
- **Execution**: All tasks launched concurrently via `Promise.allSettled()`
- **Concurrency**: Each task independently acquires a concurrency slot via `acquireSlot()`
- **Failure handling**: All tasks run regardless of individual failures
- **Result type**: `ParallelDetails` with per-task `SubTaskResult` array, `succeeded`/`failed` counts

### Composition

Chain and parallel modes can be nested in a single delegation:
- A chain step can itself trigger a parallel fan-out (if the LLM delegates from within a chain)
- Parallel tasks can each be chains (if subagents delegate from within parallel tasks)
- Recursion depth limits apply at each nesting level

## Change Approval Workflow (P4)

When `gitMode: "branch"` is active, subagent file changes are isolated on a work branch and can be reviewed before merging.

### Approval Modes

| Mode | Behavior |
|------|----------|
| `auto` | Never ask — auto-merge all changes |
| `writes` | Ask when files changed (default) |
| `always` | Ask every time, even if no changes detected |

### Approval Dialog

The `showApprovalDialog()` TUI component presents:

1. **File count** — number of files changed
2. **Diff preview** — first 20 lines of unified diff
3. **Options**: `[Y] Apply changes` / `[D] View full diff` / `[N] Discard changes`
4. **Full diff view** — scrollable raw diff with return-to-menu

### Merge/Discard Flow

- **Apply**: `mergeWorkBranch()` merges the work branch into the current branch
- **Discard**: `deleteBranch()` removes the work branch without merging
- **No changes**: Empty branch is silently deleted (no dialog shown)
- **Auto mode**: Changes are merged without user interaction

## Priority Queue (P6)

Subagent tasks are queued with priority levels. Within each tier, FIFO ordering is preserved.

### Priority Tiers

| Priority | Order | Description |
|----------|-------|-------------|
| `critical` | 0 | Highest — queued ahead of all others |
| `high` | 1 | Above normal and low |
| `normal` | 2 | Default tier |
| `low` | 3 | Lowest — queued behind all others |

### Priority Insertion

The `priorityInsert()` function in `concurrency.ts` inserts a pending task into the correct position in the `pendingQueue`, maintaining FIFO within each priority tier. Higher-priority tasks are dequeued first.

### Configuration

- **Per-call priority**: `priority` parameter on `delegate_task` (issue #114: the `defaultPriority` state field / config knob was removed — priority is decomposition-relative; units that compete for slots carry their own priority on `tasks[]`/`graph[]` items, falling back to the call-level `priority` and then `DEFAULT_PRIORITY`)
- **Priority types**: Defined in `types.ts` with `PRIORITY_ORDER` mapping and `Priority` type

## Output Diffing (P5)

Structured parsing and display of git diffs when subagents modify files.

### FileDiff Interface

```typescript
interface FileDiff {
  path: string;        // relative file path (e.g. "src/logging.ts")
  additions: number;   // count of + lines
  deletions number;   // count of - lines
  hunks: string[];     // first 10 hunk texts, capped
  totalHunks: number;  // actual total (may be more than hunks.length)
}
```

### parseDiff Function

The `parseDiff()` function in `diff.ts` parses standard git unified diff output:

1. Extracts file paths from `diff --git` lines
2. Counts additions (`+`) and deletions (`-`), skipping `+++`/`---` headers
3. Collects hunk strings from `@@` headers, capped at `MAX_HUNKS_PER_FILE` (10)
4. Returns array sorted alphabetically by path

### Display Views

- **Collapsed**: One-line file summary with `(+N -M)` per file, max 5 file entries (`COLLAPSED_DIFF_FILES_PREVIEW`)
- **Expanded**: Per-file hunk display, max 5 hunks per file (`EXPANDED_HUNKS_PER_FILE`), with truncation hint
- **Full diff**: Raw unified diff view accessible via `D` key binding (`withDiffKeybinding()`)

## Task Templates (P9)

User-saved `delegate_task` configurations with `${param}` placeholder slots.

### TaskTemplate Interface

```typescript
interface TaskTemplate {
  name: string;
  description?: string;
  task: string;              // may contain ${param} placeholders
  preset?: string;
  thinkingLevel?: string;
  outputFile?: string;       // may also contain ${param} placeholders
  timeout?: number;
  tools?: string[];
  excludeTools?: string[];
  noBuiltinTools?: boolean;
  inheritSystemPrompt?: boolean;
}
```

### resolveTemplate Function

The `resolveTemplate()` function in `templates.ts`:

1. Extracts all `${param}` names from `task` and `outputFile` fields
2. Validates that all required params are provided (extra params silently ignored)
3. Replaces all `${param}` occurrences with provided values
4. Returns the resolved `TaskTemplate` or a descriptive error

### Template Management

- **Create**: `/brl-subagent templates` → "+ Add Template" → guided input with param detection
- **View**: Select template → shows task, params, preset, thinking level
- **Delete**: "/brl-subagent templates" → "- Remove Template"
- **Use**: `delegate_task` `template` param + `params` object for slot values

## Tool Configuration

Tool access for subagents is controlled directly via `tools` and `excludeTools` parameters on `delegate_task`, combined with conductor guardrails.

### Parameter-Based Tool Control

| Parameter | Purpose |
|-----------|--------|
| `tools` | Explicit allowlist of tools available to the subagent |
| `excludeTools` | Explicit blocklist of tools to remove from defaults |

### Tool Dependency Chain

The `edit` tool requires `write` to be available. When `edit` is included in the `tools` list, `write` is automatically added to ensure edit operations succeed. The subagent prompt clarifies which tools are actually available.

### Pre-Task Validation (H1)

Deterministic pre-spawn checks in `validate.ts` validate that tool configuration and thinking level match the task description. Runs in code (not LLM context), so results are consistent regardless of conductor state:
- Tool-requirement mismatches (e.g., a file-writing task with `tools: ["read"]`), git-mode conflicts, and thinking-level recommendations produce **warnings** — the conductor can override
- Exactly **one hard error** exists: `outputFile` set while the `write` tool is unavailable (`validate.ts:214-283`). `valid: errors.length === 0` — the hard conflict rejects before any tokens are spent (pre-#33 it was literally `valid: true`)
- Background mode runs the same validation before spawn — rejects outputFile-vs-write, logs warnings (`index.ts:2186-2201`)
- `diagnoseFailure()` (H3) post-mortem suggestions live in the same module

### Preset Restriction Visibility (#33)

`formatToolRestriction()`/`formatPresetRestriction()` in `presets.ts` produce a one-line summary of a preset's tool restrictions (`excludeTools` is a hard constraint → "read-only: excludes …"; an explicit `tools` allowlist is soft → "tools: …"; otherwise "no tool restrictions"). The summary is embedded in the `delegate_task` tool description (B1) and appended to the auto-route result note (B2) so the conductor sees restrictions before delegating.

### Conductor Guardrails (H4)

Embeds behavior rules in prompt guidelines:
- Recommends appropriate tool configurations for different task types
- Guides conductors to select safe tool sets for untrusted code review

## Dependency Graph (P10)

Wave-based execution of tasks with declared dependencies, using topological sort.

### GraphTask Interface

```typescript
interface GraphTask {
  id: string;              // unique identifier
  task: string;            // may contain {otherTaskId} placeholders
  label?: string;
  dependsOn: string[];     // IDs of tasks that must complete first
  preset?: string;
  thinkingLevel?: string;
  // ... other SubTaskParams fields
}
```

### Algorithms

- **`detectCycle(tasks)`** — Three-color DFS cycle detection; returns the cycle path or null
- **`topologicalSort(tasks)`** — Kahn's algorithm producing execution waves; returns `GraphTask[][]` where each wave contains tasks whose dependencies are satisfied
- **`validateGraph(tasks)`** — Checks for: empty graph, max tasks exceeded, duplicate IDs, dangling dependency references

### Wave-Based Execution

```
Wave 1: Tasks with no dependencies (in-degree 0) → run in parallel
Wave 2: Tasks depending only on Wave 1 → run in parallel
...
Wave N: Remaining tasks → run in parallel
```

Within each wave, tasks are executed concurrently via `Promise.allSettled()`. Output placeholders (`{taskId}`) are resolved from completed tasks' final outputs.

### Constants

- `MAX_GRAPH_TASKS` = 12 (max tasks per graph)
- Tasks within a wave are sorted by ID for deterministic execution order

### Result Type

```typescript
interface GraphDetails {
  mode: "graph";
  waves: GraphWave[];    // per-wave results
  totalInput: number;
  totalOutput: number;
  totalCost: number;
  totalTurns: number;
}
```

### TUI Display

- **Collapsed**: Wave count, per-wave status icons, task labels, parallel/serial mode indicator
- **Expanded**: Full per-wave per-task details with output, diffs, usage stats, and aggregated totals

## Per-Step Model Override (C3, #39)

Each chain step (`SubTaskParams.model`), parallel task, and graph task (`GraphTask.model`) can override the model with a `"provider/model-id"` string. Resolution precedence:

```
step.model > global resolved model (preset.model > state.config.model > conductor model)
```

`resolveStepModel(ctx, stepModel, globalModel)` (`index.ts:368-390`) parses and availability-checks the override via `modelIsAvailable()`; an invalid or unavailable step model logs a warning and falls back to the global model. Wired into chain mode (`index.ts:630`), parallel mode (`index.ts:998`), and graph mode (`index.ts:1446`).

## Agent-ID Validation (#36)

`assertSafeAgentId()` in `sanitize.ts:135` validates agent ids against a UUID pattern before they are interpolated into file paths (path traversal / absolute-path defense). Enforced at every LLM-reachable chokepoint: `getAgent` returns `null` on invalid ids, `getTranscriptPath` throws, `persistAgent` refuses to write, and `getTranscriptPath` in `transcript.ts` is the single chokepoint for transcript file paths (F24).

## Skill-Based Routing (E2)

The `router.ts` module auto-classifies task descriptions to the best preset personality:

- **Classification rules** — ordered by priority; each rule maps keywords to a preset
- **Keyword matching** — case-insensitive substring matching against task text
- **Fallback** — returns `null` when no rule matches (conductor uses default preset)
- **Integration** — called in `delegate_task.execute()` when no explicit preset is provided

### Classification Examples

| Keywords | Preset |
|----------|--------|
| "audit", "security", "vulnerability" | security-auditor |
| "review", "PR", "pull request" | code-reviewer |
| "test", "coverage", "spec" | test-engineer |
| "deploy", "CI", "pipeline" | rapid-prototyper |
| "debug", "error", "crash" | debugger |
| "refactor", "clean up" | refactorer |
| "docs", "README" | tech-writer |
| "data", "SQL", "query" | data-analyst |
| "implement", "build", "fix" | dev-agent |

## RBAC Matrices (E6) — REMOVED

The `roles.ts` module no longer exists — it was removed in v2.0.2 as redundant with per-task tool control, and the sandbox system it depended on was removed in v2.1.0 (2026-07-19). Tool access is now controlled directly via the `tools` and `excludeTools` parameters on `delegate_task`; presets can define default restrictions via their `tools`/`excludeTools` fields.

## Pluggable Backends (E8) — REMOVED v2.1.0

The `backend.ts` module was removed as dead code. The `direct-api` backend was never used in production; only the `pi` backend was ever active. The backend abstraction layer has been removed to simplify the codebase.

## Process Pool (E11) — REMOVED post-2.1.2 (#41/#44)

The `pool.ts` module no longer exists — it was deleted entirely (src/pool.ts, src/__tests__/pool.test.ts, all config keys `poolEnabled`/`poolSize`, the `/brl-subagent pool` UI, and the preWarm/shutdown hooks) on 2026-08-03. Rationale:
- **Never enabled in any real session** — 41 persisted states all had `poolEnabled: false`; the feature was opt-in dead weight.
- **Latent wrong-prompt-on-reuse bug** — pool processes were spawned without `--append-system-prompt`, so reused processes never received SUBAGENT_INSTRUCTIONS.
- **F27 fence bypass** — the pool `sendTask` path sent the raw unwrapped task and pool processes lacked the Task Boundary directive (the adversarial review of 919a2e9 flagged this as its #1 High finding). Removing the pool removed the bypass.

The `runSubagent` signature lost its pool parameter (now 14 params). This also incidentally fixed the parallel-mode intercom bug (see Parallel Mode).

## SLA Metrics (E4)

The `metrics.ts` module computes performance metrics from run history:

- **Latency percentiles** — p50, p95, p99 via linear interpolation
- **Success rate** — ratio of non-error runs to total runs
- **Cost analysis** — average, median, total cost per task
- **Degradation detection** — compares current metrics against baseline with configurable thresholds

### Degradation Triggers

| Metric | Threshold |
|--------|----------|
| p95 latency | > 2× baseline |
| Success rate | < 80% |
| Cost | > 3× baseline average |

## Recurring Scheduler (E9) — REMOVED (#91, 2026-08-14)

The `schedule.ts` module was deleted — never enabled in any real session, session-bound with a `_tools` hack, 936 lines removed (module, tests, TUI commands, and the SessionState schedules map). The dependency-graph `scheduler.ts` (P10) is a different module and remains.

## Subagent Messaging (E10)

**Completion-push wake (#147, 2026-09-02):** the event-bus's FIRST consumer — a module-scope subscriber in index.ts listens to `subagent:completed`/`subagent:failed`/`subagent:stopped` and, per depth-1 runs (structural — each session runs its own extension instance/event-bus, so only direct children's events arrive), pushes a structured `subagent-completion` custom message via `pi.sendMessage` with `triggerTurn: true` (wakes an idle conductor). `src/notify-completion.ts` splits the work: pure `buildCompletionMessage(agent, run)` + pure `resolveDelivery(status, knob)` (the D1/D2 matrix) + thin `sendCompletionNotification`. `resolveRunEntry` prefers the finalized run entry over the spawn entry (both share id/startedAt; the spawn entry sorts first). Delivery is always-on (minimum `nextTurn`); the `completionNotify` knob (`all`/`failed`/`off`, default `all`) controls only the wake. The poller's pre-existing short echoes (customType `subagent-notification`) were removed in #149 — the crash notices stay (poller-unique edges: no-session, loop-crash).

The `messaging.ts` module enables inter-subagent communication:

- **Output format** — `[TO:agent-id]:message text` parsed from subagent stdout
- **Standalone-line extraction (#129)** — only lines whose trimmed content STARTS with `[TO:` are extracted; a mid-sentence mention (e.g. quoting the format inside prose) is NOT a message. The E10 prompt guidance requires the standalone form.
- **Targeted delivery** — `[TO:agent-id]:` sends to specific subagent by label
- **Broadcast** — `[TO:*]:` sends to all running subagents
- **Delivery timing** — messages delivered after sender completes, before recipient starts
- **Message history** — stored in-memory with timestamps

## Compliance Reports (E5)

The `reports.ts` module generates compliance and audit reports:

- **File access report** — which files each subagent touched (inferred from git diff)
- **Secrets exposure** — pattern-based scan for `.env`, `.pem`, `credentials.json`, `id_rsa`
- **Compliance summary** — aggregated counts by role, status, error category
- **SLA integration** — includes latency/cost metrics from metrics.ts

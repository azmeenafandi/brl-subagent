# brl-subagent — Architecture

> Generated: 2026-07-06 | Version: 1.5.0

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

## File Structure

```
brl-subagent/
├── src/
│   ├── types.ts          # Type definitions, constants, helpers (F5, F9)
│   ├── sanitize.ts       # Input/output/env sanitization (F1-F3)
│   ├── presets.ts        # Preset loading, parsing, validation (R10)
│   ├── state.ts          # Session-bound state management (F5, F7, F9)
│   ├── prompt.ts         # System prompt construction
│   ├── runner.ts         # Process spawning and stdout parsing
│   ├── concurrency.ts    # Concurrency queue and progress tracking (F8)
│   ├── history.ts        # Run record management and retry logic
│   ├── tui.ts            # All TUI rendering and UI interactions
│   ├── logging.ts        # Structured logging with rotation (F10)
│   ├── preflight.ts      # Pre-flight environment validation (R3)
│   ├── git.ts            # Git integration — branch-based workflow (P3)
│   └── index.ts          # Extension orchestrator entry point
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
│   └── TASKS.md          # Task tracking
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
- **Cost governance** — `sessionCostLimit` (0 = unlimited); pre-delegation threshold check
- **Presets** — built-in loaded from `presets/*.md`, custom stored in state
- **State persistence** — `pi.appendEntry("brl-subagent-state", {...})`

### 2. Tool Registration Layer
- **`delegate_task`** — registered via `pi.registerTool()`
- Parameters defined via TypeBox schemas with 16 parameters (13 original + `retryRunId`, `gitMode`, `retryOnTimeout`)
- `prepareArguments` — not used (no compatibility shims needed yet)
- `renderCall` / `renderResult` — custom TUI rendering

### 3. Execution Layer
- **`runSubagent()`** — core async function (in `runner.ts`)
  - Builds subagent args (`--mode json -p --no-session --model X --thinking Y --tools Z`)
  - Writes system prompt to temp file (`.pi/subagent-tmp/`)
  - Spawns `pi` child process via `getPiInvocation()`
  - Parses JSON-line stdout into `message_end` and `tool_result_end` events
  - Accumulates usage stats (tokens, cost)
  - Handles abort signal + timeout (SIGTERM → 5s → SIGKILL)
  - Cleans up temp files in `finally`

### 4. Results Layer
- **`SubagentResult`** — messages array, usage stats, exit code, stderr, error category, git branch/diff
- **`SubagentRun`** — persisted run record with ID, timestamps, cost, output, original params, error category
- **Run history** — stored as custom session entries; auto-pruned to `maxHistoryEntries` (default 500)
- **Live monitor** — `subagentSessions` Map; spinning indicator dashboard

### 5. TUI Rendering Layer
- **Collapsed view** — icon + label + model + output preview (5 lines) + usage
- **Expanded view** — full Markdown output + detailed usage stats
- **Live monitor** — per-subagent spinner, token counters, elapsed time, latest output
- **Config menu** — `SelectList`-based menus for model, thinking, concurrency, depth, git mode, cost limit, history, presets

## Data Flow

```
User prompt → LLM decides to delegate
  → delegate_task.execute()
    → sanitizeTask()                (F1: injection prevention)
    → validateCwd()                 (F1: path traversal prevention)
    → validateOutputFile()          (F1: containment check)
    → checkCostLimit()              (R5: budget gate)
    → getCurrentDepth()             (recursion guard)
    → resolveSubagentParams()       (merge preset + explicit + state)
    → resolveSubagentModel()        (configured model or fallback)
    → preflightCheck()              (R3: pi binary, cwd, temp dir)
    → switchToBranch() (if gitMode) (P3: create work branch)
    → checkCircuit()                (R1: circuit breaker gate)
    → acquireSlot()                 (concurrency gate)
    → buildSubagentPrompt()         (inherit + custom + output instructions)
    → runSubagent()                 (spawn pi process, parse stdout)
        → parseSubagentLine()       (JSON-line → message_end/tool_result_end)
        → accumulateUsage()         (track tokens, cost)
        → emitSubagentUpdate()      (stream to onUpdate callback)
    → sanitize output               (F3: strip ANSI, cap size)
    → captureDiff() (if gitMode)    (P3: diff against base branch)
    → switchBack + deleteBranch()   (P3: cleanup)
    → finalizeRunRecord()           (save run to session, classify error)
    → recordSuccess/Failure()       (R1: circuit breaker tracking)
    → releaseSlot()                 (free concurrency slot)
  → Tool result returned to LLM with content + details
```

## State Management

State is persisted as custom session entries, managed by the `SessionState` class (`state.ts`):

| Entry Type | Key | Contents |
|-----------|-----|----------|
| `brl-subagent-state` | Session-level | `model`, `maxThinkingLevel`, `maxParallel`, `maxSubagentDepth`, `gitMode`, `maxHistoryEntries`, `sessionCostLimit`, `perTaskCostEstimate`, `seenRunIds`, `presets`, `circuitBreaker` |
| `brl-subagent-run` | Per-invocation | `id`, `task`, `label`, `status`, `model`, `thinkingLevel`, timestamps, `cost`, `tokensIn/Out`, `outputSummary`, `fullOutput`, `originalParams`, `errorCategory`, `gitBranch`, `gitDiff` |

State is restored on `session_start` via `restoreFromSession()` using type guards (`isSubagentStateShape`) — no `as any` casts. Corrupted entries are logged and skipped, falling back to defaults.

## Module-Level State (Session-Bound)

All mutable state is encapsulated in the `SessionState` class (`state.ts`), which is initialized in `session_start` and cleaned up in `session_shutdown`:

- **Progress counters**: `activeSubagents`, `completedSubagents`, `failedSubagents`, `unseenSubagents` — mutated only through `acquireSlot`/`releaseSlot` methods (race-condition-safe)
- **Concurrency queue**: `pendingQueue` — cleared on shutdown
- **Live sessions**: `subagentSessions` Map — auto-expires entries after 3 seconds, cleared on shutdown
- **Config**: All user-configurable fields stored in `this.config`

This ensures no stale state leaks across sessions (`/resume`, `/new`).

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

## Git Integration

The `git.ts` module (P3) provides branch-based workflow for subagent isolation:

- **`getCurrentBranch(cwd)`** — returns the current branch name
- **`hasUncommittedChanges(cwd)`** — checks for dirty working tree
- **`createWorkBranch(cwd, baseBranch)`** — creates `brl-subagent-<uuid>` branch from base
- **`captureDiff(cwd, baseBranch)`** — returns unified diff between base branch and HEAD
- **`switchToBranch(cwd, branch)`** — switches to an existing branch
- **`deleteBranch(cwd, branch)`** — force-deletes a branch

All commands use `execFileSync` with a 10-second timeout. The workflow in `index.ts`:
1. Creates a work branch before spawning the subagent
2. After completion, captures the diff against the base branch
3. Switches back to the original branch
4. Deletes the work branch

Git integration is configured via `gitMode` parameter or `/brl-subagent gitmode`.

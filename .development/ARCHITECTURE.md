# brl-subagent — Architecture

> Generated: 2026-07-07 | Version: 1.6.0

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
│   ├── diff.ts           # Git diff parser — structured file-level summaries (P5)
│   ├── templates.ts      # Task template resolution with ${param} substitution (P9)
│   ├── scheduler.ts      # Dependency graph scheduler — cycle detection, topological sort (P10)
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
- **Approval mode** — `approvalMode` ("auto" | "writes" | "always"); controls change review flow
- **Default priority** — `defaultPriority` ("critical" | "high" | "normal" | "low"); FIFO within tier
- **Default sandbox level** — `defaultSandboxLevel` ("none" | "readonly" | "safe"); tool access restrictions
- **Cost governance** — `sessionCostLimit` (0 = unlimited); pre-delegation threshold check
- **Presets** — built-in loaded from `presets/*.md`, custom stored in state
- **Templates** — user-saved task configurations with `${param}` substitution slots
- **State persistence** — `pi.appendEntry("brl-subagent-state", {...})`

### 2. Tool Registration Layer
- **`delegate_task`** — registered via `pi.registerTool()`
- Parameters defined via TypeBox schemas with 24+ parameters (13 original + chain, tasks, graph, template, params, retryRunId, gitMode, retryOnTimeout, approvalMode, sandboxLevel, priority)
- Supports four execution modes: single, chain, parallel, graph
- `renderCall` / `renderResult` — custom TUI rendering with mode-specific views

### 3. Execution Layer
- **`runSubagent()`** — core async function (in `runner.ts`)
  - Builds subagent args (`--mode json -p --no-session --model X --thinking Y --tools Z`)
  - Writes system prompt to temp file (`.pi/subagent-tmp/`)
  - Spawns `pi` child process via `getPiInvocation()`
  - Parses JSON-line stdout into `message_end` and `tool_result_end` events
  - Accumulates usage stats (tokens, cost)
  - Handles abort signal + timeout (SIGTERM → 5s → SIGKILL)
  - Cleans up temp files in `finally`
- **`runChainMode()`** — sequential step execution with `{previous}` placeholder substitution
- **`runParallelMode()`** — concurrent fan-out with per-task concurrency slot acquisition
- **`runGraphMode()`** — wave-based execution using topological sort from `scheduler.ts`

### 4. Results Layer
- **`SubagentResult`** — messages array, usage stats, exit code, stderr, error category, git branch/diff, approved flag
- **`SubagentRun`** — persisted run record with ID, timestamps, cost, output, original params, error category
- **`ChainDetails`** / **`ParallelDetails`** / **`GraphDetails`** — aggregate results for multi-task modes
- **Run history** — stored as custom session entries; auto-pruned to `maxHistoryEntries` (default 500)
- **Live monitor** — `subagentSessions` Map; spinning indicator dashboard

### 5. TUI Rendering Layer
- **Collapsed view** — icon + label + model + output preview (5 lines) + usage
- **Expanded view** — full Markdown output + detailed usage stats
- **Chain view** — per-step status with collapsed/expanded output and diff summaries
- **Parallel view** — per-task status with success/fail counts
- **Graph view** — per-wave per-task status with dependency visualization
- **Diff views** — collapsed file summary (+N -M), expanded hunks (capped at 10/file), full raw diff (press D)
- **Approval dialog** — apply/discard/view-diff with keyboard shortcuts
- **Live monitor** — per-subagent spinner, token counters, elapsed time, latest output
- **Config menu** — `SelectList`-based menus for model, thinking, concurrency, depth, git mode, approval, sandbox, priority, cost limit, history, presets, templates

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
    → resolveSubagentModel()        (configured model or fallback)
    → preflightCheck()              (R3: pi binary, cwd, temp dir)
    → switchToBranch() (if gitMode) (P3: create work branch)
    → checkCircuit()                (R1: circuit breaker gate)
    → acquireSlot(priority)         (concurrency gate with priority queue)
    → buildSubagentPrompt()         (inherit + custom + output instructions)
    → runSubagent()                 (spawn pi process, parse stdout)
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
  → for each step: resolveSubagentParams → runSubagent → capture output → {previous} substitution

Parallel mode:
  → Promise.allSettled(): each task acquires its own slot → runSubagent concurrently

Graph mode:
  → topologicalSort() → waves → for each wave: Promise.allSettled() within wave
  → substitute {taskId} placeholders from completed task outputs
```

## State Management

State is persisted as custom session entries, managed by the `SessionState` class (`state.ts`):

| Entry Type | Key | Contents |
|-----------|-----|----------|
| `brl-subagent-state` | Session-level | `model`, `maxThinkingLevel`, `maxParallel`, `maxSubagentDepth`, `gitMode`, `approvalMode`, `defaultPriority`, `defaultSandboxLevel`, `maxHistoryEntries`, `sessionCostLimit`, `perTaskCostEstimate`, `seenRunIds`, `presets`, `templates`, `circuitBreaker` |
| `brl-subagent-run` | Per-invocation | `id`, `task`, `label`, `status`, `model`, `thinkingLevel`, timestamps, `cost`, `tokensIn/Out`, `outputSummary`, `fullOutput`, `originalParams`, `errorCategory`, `gitBranch`, `gitDiff`, `approved` |

State is restored on `session_start` via `restoreFromSession()` using type guards (`isSubagentStateShape`) — no `as any` casts. Corrupted entries are logged and skipped, falling back to defaults.

## Module-Level State (Session-Bound)

All mutable state is encapsulated in the `SessionState` class (`state.ts`), which is initialized in `session_start` and cleaned up in `session_shutdown`:

- **Progress counters**: `activeSubagents`, `completedSubagents`, `failedSubagents`, `unseenSubagents` — mutated only through `acquireSlot`/`releaseSlot` methods (race-condition-safe)
- **Concurrency queue**: `pendingQueue` — priority-ordered, cleared on shutdown
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

- **Default priority**: `defaultPriority` state field (default: `"normal"`)
- **Per-call override**: `priority` parameter on `delegate_task`
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

## Subagent Sandboxing (P7)

Tool access restrictions for subagents based on sandbox level.

### SandboxLevel Type

```typescript
type SandboxLevel = "none" | "readonly" | "safe";
```

### Tool Maps

| Level | Allowed Tools | Excluded Tools |
|-------|---------------|----------------|
| `none` | All tools | None |
| `readonly` | read, grep, find, ls | write, edit, bash |
| `safe` | read, grep, find, ls, bash | write, edit |

### Per-Call Override Semantics

Resolution order (first non-default wins):
1. Per-call `sandboxLevel` parameter
2. Preset's `sandboxLevel` field
3. State config `defaultSandboxLevel`

When sandbox level is not `none`:
- `tools` is set to the sandbox allowlist (unless user provides explicit tools)
- `excludeTools` is set to the sandbox blocklist (unless user provides explicit excludes)

### Configuration

- **Default level**: `/brl-subagent sandbox` → select "none" / "readonly" / "safe"
- **Per-call override**: `sandboxLevel` parameter on `delegate_task`

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

# brl-subagent — Audit: Strengths & Weaknesses

> Generated: 2026-07-07 | Version: 2.0.0 (previously 1.6.0)

## What's Been Fixed (since v1.3.0)

| # | Weakness | Resolution | Implementation |
|---|----------|-----------|----------------|
| 1 | Zero test coverage | **RESOLVED** | 532 tests across 25 files (unit + integration + benchmarks) |
| 2 | No input/output sanitization | **RESOLVED** | `sanitize.ts`: `sanitizeTask`, `validateCwd`, `validateOutputFile`, `stripAnsi`, `capOutput` |
| 3 | Subprocess environment inheritance | **RESOLVED** | `getSafeEnv()` allows only `PATH`, `HOME`, `LANG`, `TMPDIR`, `BRL_SUBAGENT_DEPTH` |
| 4 | Type safety holes | **RESOLVED** | `isSubagentStateShape` / `isSubagentRunShape` / `isMultiSubagentDetails` / `isGraphDetails` type guards replace all `as any` |
| 5 | No structured logging | **RESOLVED** | `logging.ts`: leveled logging (debug/info/warn/error) with file rotation (5MB/5 files) |
| 6 | No output size limits | **RESOLVED** | `capOutput` in `sanitize.ts` (100KB default, configurable) |
| 7 | Memory leak risk | **RESOLVED** | Session-bound cleanup; `finalizeLiveSubagent` removes entries after 3s; `session_shutdown` clears all |
| 8 | Race conditions in progress counters | **RESOLVED** | Counters mutated only within `acquireSlot`/`releaseSlot` on single-threaded `SessionState` instance |
| 9 | No circuit breaker | **RESOLVED** | R1: `CircuitBreakerState` with 5-failure threshold, 60s auto-recovery, thinking-level degradation |
| 10 | No disk usage policy | **RESOLVED** | R2: Auto-prune runs (default 500), cleanup stale temp dirs (24h), configurable history limit |
| 11 | No pre-flight model validation | **RESOLVED** | R3: `preflightCheck()` validates pi binary, cwd readability, temp dir writability before spawning |
| 12 | Monolithic architecture | **RESOLVED** | Refactored into 24 modules: types, sanitize, presets, state, prompt, runner, concurrency, history, tui, logging, preflight, git, diff, templates, scheduler, router, roles, reports, metrics, schedule, pool, messaging, backend, index |
| 13 | Module-level state not session-bound | **RESOLVED** | `SessionState` class initialized in `session_start`, cleaned in `session_shutdown` |
| 14 | Silent preset load failures | **RESOLVED** | R10: `validateAllPresets()` validates parsed presets; errors reported per file |
| 15 | No cost governance | **RESOLVED** | R5: `sessionCostLimit`, `perTaskCostEstimate`, `checkCostLimit()`, pre-delegation budget check |
| 16 | No change approval workflow | **RESOLVED** | P4: `approvalMode` ("auto"/"writes"/"always"), `showApprovalDialog()` TUI with apply/discard, merge-or-discard flow |
| 17 | No version control integration | **RESOLVED** | P3: `git.ts` — branch-based workflow with `createWorkBranch`, `captureDiff`, `mergeWorkBranch`, `switchToBranch`, `deleteBranch`. Uses `execFileSync` for shell safety. |
| 18 | No task chaining / parallel mode | **RESOLVED** | P1+P2: `runChainMode()` with `{previous}` placeholder; `runParallelMode()` with concurrent fan-out; `runGraphMode()` with dependency-aware waves |
| 20 | No priority queue | **RESOLVED** | P6: Four priority tiers (critical/high/normal/low), `priorityInsert()` in concurrency queue, FIFO within tier |
| 21 | No output diffing | **RESOLVED** | P5: `parseDiff()` in `diff.ts`, `FileDiff` interface, hunk capping (10/file), collapsed/expanded/full-diff views |
| 23 | No RBAC / permission tiers | **RESOLVED** | P7: `SandboxLevel` type ("none"/"readonly"/"safe"), `SANDBOX_TOOLS`/`SANDBOX_EXCLUDE` maps, per-call override semantics. E6: `roles.ts` with reviewer/developer/auditor roles, tool permissions, per-call override chain: role > sandbox > config. |
| 24 | No task templates | **RESOLVED** | P9: `TaskTemplate` interface, `resolveTemplate()` with `${param}` substitution, template management TUI, `template`+`params` on `delegate_task` |
| 26 | No skill-based routing | **RESOLVED** | E2: `router.ts` — keyword-based auto-classification of tasks to presets |
| 27 | No compliance reports | **RESOLVED** | E5: `reports.ts` — file access tracking, secrets exposure detection, compliance summary |
| 28 | No SLA tracking | **RESOLVED** | E4: `metrics.ts` — p50/p95/p99 latency, success rate, cost analysis, degradation detection |
| 29 | No RBAC roles | **RESOLVED** | E6: `roles.ts` — reviewer/developer/auditor roles with tool permissions and override chain |
| 30 | No multi-turn subagents | **RESOLVED** | E7: `maxTurns` parameter enables clarifying questions via `[QUESTION]:` format |
| 31 | No pluggable backends | **RESOLVED** | E8: `backend.ts` — Backend abstraction with pi and direct-api implementations |
| 32 | No recurring scheduling | **RESOLVED** | E9: `schedule.ts` — interval-based recurring task management with TUI |
| 33 | No subagent messaging | **RESOLVED** | E10: `messaging.ts` — Intercom class with `[TO:agent-id]:` output format |
| 34 | No process pool | **RESOLVED** | E11: `pool.ts` — warm pi process management with lazy spawn and idle cleanup |

## Strengths

### Preset System
- 8 well-structured personality profiles with YAML frontmatter
- Thinking levels, tool scoping, and custom system prompts per preset
- Built-in + user-custom preset support with merge semantics (preset = defaults, explicit = override)
- Schema validation on load with per-file error reporting (R10)

### Concurrency Control
- Queue-based slot system with configurable `maxParallel`
- Priority-aware queue with four tiers (critical > high > normal > low), FIFO within tier
- Proper abort handling — queued tasks removed on abort
- Graceful status display showing running/completed/failed counts

### Timeout Handling
- Graceful SIGTERM → 5-second grace → SIGKILL pattern
- `retryOnTimeout` flag for automatic single-retry
- Per-task configurable timeout in milliseconds

### Run History & Persistence
- Full session persistence: task, label, model, thinking, duration, cost, output preview
- Seen/unseen tracking with status bar badge (`3 done (2 unseen)`)
- `originalParams` preserved for exact retry reproduction
- Error category classification stored on run records
- Auto-pruning with configurable max history entries (R2)

### Live Monitor
- Real-time dashboard with animated spinner, token usage, elapsed time
- Live output preview showing last line of subagent stdout
- Keyboard shortcut: Ctrl+Shift+O

### Prompt Inheritance
- 4 modes: inherit, inherit+custom, custom-only, no-inheritance (token-saving)
- `outputFile` mode for large investigations — writes findings to disk, returns summary only

### TUI Polish
- Collapsed/expanded result views with color-coded status icons
- Markdown rendering for expanded output
- Consistent theming via `getMarkdownTheme()`
- Mode-specific rendering for chain, parallel, and graph results

### Abort Handling
- Proper `AbortSignal` wiring from conductor to subprocess
- Concurrency-queue abort (pending tasks removed)
- Temp file cleanup in `finally` block

### Security Basics
- Temp files use `0o600` permissions via `withFileMutationQueue`
- Temp directories auto-cleaned after use
- Read-only presets restrict tool access (`tools` allowlist + `excludeTools` blocklist)
- Environment isolation via `getSafeEnv()` allowlist
- Input sanitization: injection prevention, path traversal, containment checks
- Output sanitization: ANSI stripping, size capping

### Circuit Breaker (R1)
- 5 consecutive failures threshold
- 60s auto-recovery window
- Degraded thinking level (`minimal`) during open circuit
- Success resets counter immediately
- Clear error messaging with wait time

### Pre-flight Checks (R3)
- Validates pi binary availability before spawn
- Verifies cwd readability and temp writability
- Fast-fail before concurrency slot acquisition

### Cost Governance (R5)
- Per-session budget cap with configurable limit
- Per-task cost estimation with default $0.05
- Pre-delegation threshold check with clear rejection message
- Session cost checked before chain/parallel/graph spawning (aggregated estimate)

### Git Integration (P3)
- Branch-based workflow: creates isolation branch before delegation
- Auto-captures diff against base branch on completion
- Returns to original branch and deletes work branch
- Graceful fallback to `gitMode: "none"` on errors
- All git commands use `execFileSync` (no shell injection risk)

### Change Approval Workflow (P4)
- Three approval modes: auto (never ask), writes (ask when files changed), always
- TUI approval dialog with diff preview, apply/discard/view-diff options
- Keyboard shortcuts (Y/D/N) for quick interaction
- Merge-or-discard flow integrated with git branch lifecycle

### Task Chaining (P1)
- Sequential step execution with `{previous}` placeholder
- Chain stops on first failure (unless last step)
- Per-step progress updates with ChainDetails aggregate
- Up to 10 steps per chain

### Parallel Execution (P2)
- Concurrent fan-out with Promise.allSettled
- Each task independently acquires a concurrency slot
- Per-task progress updates with ParallelDetails aggregate
- Up to 8 parallel tasks

### Priority Queue (P6)
- Four priority tiers with FIFO within tier
- PriorityInsert function for correct queue placement
- Configurable default priority with per-call override
- Critical tasks always run before low-priority tasks

### Output Diffing (P5)
- Structured parseDiff producing FileDiff array
- Hunk capping at 10 per file with totalHunks tracking
- Collapsed file summary: (+N -M) per file, max 5 entries
- Expanded view: per-file hunks, max 5 per file with truncation hint
- Full raw diff view accessible via D key binding

### Task Templates (P9)
- Reusable task configurations with ${param} placeholder slots
- Validation: detects missing params before execution
- Template management TUI: add, view, remove
- Integrated with delegate_task via template + params parameters

### Subagent Sandboxing (P7)
- Three sandbox levels: none, readonly, safe
- Tool allowlist/blocklist per level
- Per-call override with resolution chain: call > preset > config
- Prevents subagents from writing files in readonly mode

### Dependency Graph (P10)
- Cycle detection via three-color DFS
- Topological sort via Kahn's algorithm producing execution waves
- Wave-based parallel execution with inter-wave dependency resolution
- Output placeholders ({taskId}) resolved from completed tasks
- Graph validation: empty check, max tasks, duplicate IDs, dangling references

### Error Classification
- 9 categories with priority-based pattern matching
- Stored on run records for analysis and retry routing
- Drives circuit breaker decisions
- Classifies chain/parallel/graph subtask failures individually

### Recursion Depth Limit
- `BRL_SUBAGENT_DEPTH` env var tracks nesting
- Configurable `maxSubagentDepth` (default: 1)
- Clear rejection message when limit reached
- Applies to single, chain, parallel, and graph modes

### Skill-Based Routing (E2)
- Auto-classify task descriptions to best preset via keyword matching
- Fallback to default preset when no rule matches
- Ordered classification rules by priority
- Integrated into delegate_task.execute() for automatic preset selection

### RBAC Roles (E6)
- Three built-in roles: developer, reviewer, auditor
- Tool permissions per role with override chain
- Per-call role override with resolution: call > preset > role > sandbox > config
- Prevents unauthorized tool access for read-only roles

### Pluggable Backends (E8)
- Backend abstraction with pi (full tools) and direct-api (HTTP) implementations
- Configurable via /brl-subagent backend
- Supports non-pi execution backends for flexibility
- Backend interface: name, supportsTools, execute()

### Process Pool (E11)
- Warm pi process management reducing cold-start latency
- Lazy spawn on first acquire, idle cleanup on timer
- Model and thinking-level matching for process reuse
- Configurable pool size (default: 2)

### SLA Metrics (E4)
- p50/p95/p99 latency computation via linear interpolation
- Success rate and cost analysis per task
- Degradation detection against configurable baseline
- Alert thresholds: latency > 2× baseline, success < 80%, cost > 3× average

### Recurring Scheduler (E9)
- Cron-like task scheduling with minimum 5-minute intervals
- Fire-and-forget asynchronous execution
- Enable/disable without removing schedule
- TUI management via /brl-subagent schedule and unschedule

### Subagent Messaging (E10)
- Intercom class for inter-subagent communication
- Targeted ([TO:agent-id]:) and broadcast ([TO:*]:) message formats
- Messages delivered after sender completes, before recipient starts
- In-memory message history with timestamps

### Compliance Reports (E5)
- File access reports from git diff analysis
- Secrets exposure detection: .env, .pem, credentials.json, id_rsa
- Compliance summary with role breakdown and error categories
- SLA integration with latency and cost metrics

### Reserved Name Validation
- RESERVED_NAME_PATTERN prevents __*__ names (TUI sentinels)
- RESERVED_COMMAND_NAMES prevents collision with /brl-subagent completions
- Applied to presets, templates, and schedules
- Clear error messages when reserved names are used

### Preset Prompt Guidelines
- promptGuideline field on presets provides usage hints
- Built-in presets include guidelines (e.g., "For security audits. Use thinkingLevel: high.")
- dev-agent preset added for full-access development work
- Helps LLM select appropriate presets for different task types

---

## Weaknesses

### ⚠️ Remaining Weaknesses

#### 19. No Dry-Run / Preview Mode
- No way to ask "what would you change?" without actually changing files
- The approval workflow (P4) shows diffs after execution, but cannot prevent file writes
- A true dry-run would need sandboxed execution or filesystem snapshot/rollback

#### 22. No Audit Trail (Partial)
- Run history tracks which subagent ran, with what params, and error category
- Git diff captures which files were modified in branch mode
- Compliance reports (E5) detect secrets exposure and file access
- But no record of which files were **read** during execution, or which **tools** were invoked
- Cannot answer "did a subagent read `.env`?" or "which files did it grep?"

#### 25. No Progress Estimation / ETA
- No way to predict how long a subagent might take
- Would require historical data analysis (average duration by task pattern/model)
- Current progress is step-based only (chain: "2/5 steps", parallel: "3/8 done")

---

## Summary

| Category | Total | Resolved | Partially | Remaining |
|----------|-------|----------|-----------|-----------|
| 🔴 Critical | 9 | 9 | 0 | 0 |
| 🟡 Robustness | 6 | 6 | 0 | 0 |
| 🟠 Feature Gaps | 13 | 11 | 0 | 2 |
| 🟢 Phase 4 | 9 | 9 | 0 | 0 |
| **Total** | **37** | **35** | **0** | **2** |

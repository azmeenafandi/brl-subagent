# brl-subagent — Audit: Strengths & Weaknesses

> Generated: 2026-07-06 | Version: 1.5.0 (previously 1.3.0)

## What's Been Fixed (since v1.3.0)

| # | Weakness | Resolution | Implementation |
|---|----------|-----------|----------------|
| 1 | Zero test coverage | **RESOLVED** | 258 tests across 10 files (unit + integration + benchmarks) |
| 2 | No input/output sanitization | **RESOLVED** | `sanitize.ts`: `sanitizeTask`, `validateCwd`, `validateOutputFile`, `stripAnsi`, `capOutput` |
| 3 | Subprocess environment inheritance | **RESOLVED** | `getSafeEnv()` allows only `PATH`, `HOME`, `LANG`, `TMPDIR`, `BRL_SUBAGENT_DEPTH` |
| 4 | Type safety holes | **RESOLVED** | `isSubagentStateShape` / `isSubagentRunShape` type guards replace all `as any` |
| 5 | No structured logging | **RESOLVED** | `logging.ts`: leveled logging (debug/info/warn/error) with file rotation (5MB/5 files) |
| 6 | No output size limits | **RESOLVED** | `capOutput` in `sanitize.ts` (100KB default, configurable) |
| 7 | Memory leak risk | **RESOLVED** | Session-bound cleanup; `finalizeLiveSubagent` removes entries after 3s; `session_shutdown` clears all |
| 8 | Race conditions in progress counters | **RESOLVED** | Counters mutated only within `acquireSlot`/`releaseSlot` on single-threaded `SessionState` instance |
| 9 | No circuit breaker | **RESOLVED** | R1: `CircuitBreakerState` with 5-failure threshold, 60s auto-recovery, thinking-level degradation |
| 10 | No disk usage policy | **RESOLVED** | R2: Auto-prune runs (default 500), cleanup stale temp dirs (24h), configurable history limit |
| 11 | No pre-flight model validation | **RESOLVED** | R3: `preflightCheck()` validates pi binary, cwd readability, temp dir writability before spawning |
| 12 | Monolithic architecture | **RESOLVED** | Refactored into 13 modules: types, sanitize, presets, state, prompt, runner, concurrency, history, tui, logging, preflight, git, index |
| 13 | Module-level state not session-bound | **RESOLVED** | `SessionState` class initialized in `session_start`, cleaned in `session_shutdown` |
| 14 | Silent preset load failures | **RESOLVED** | R10: `validateAllPresets()` validates parsed presets; errors reported per file |
| 15 | No cost governance | **RESOLVED** | R5: `sessionCostLimit`, `perTaskCostEstimate`, `checkCostLimit()`, pre-delegation budget check |
| 17 | No version control integration | **RESOLVED** | P3: `git.ts` — branch-based workflow with `createWorkBranch`, `captureDiff`, auto-switchback |

## Strengths

### Preset System
- 8 well-structured personality profiles with YAML frontmatter
- Thinking levels, tool scoping, and custom system prompts per preset
- Built-in + user-custom preset support with merge semantics (preset = defaults, explicit = override)
- Schema validation on load with per-file error reporting (R10)

### Concurrency Control
- Queue-based slot system with configurable `maxParallel`
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

### Git Integration (P3)
- Branch-based workflow: creates isolation branch before delegation
- Auto-captures diff against base branch on completion
- Returns to original branch and deletes work branch
- Graceful fallback to `gitMode: "none"` on errors

### Error Classification
- 9 categories with priority-based pattern matching
- Stored on run records for analysis and retry routing
- Drives circuit breaker decisions

### Recursion Depth Limit
- `BRL_SUBAGENT_DEPTH` env var tracks nesting
- Configurable `maxSubagentDepth` (default: 1)
- Clear rejection message when limit reached

---

## Weaknesses

### 🟡 Feature Gaps (Unresolved)

#### 16. No Change Approval Workflow
- Subagent writes files directly without review
- No diff preview before changes applied
- No rollback mechanism for subagent changes

#### 18. No Task Chaining / Parallel Mode
- Only single-task delegation
- pi reference subagent supports `chain` (sequential with `{previous}`) and `parallel` (fan-out)
- brl-subagent supports neither

#### 19. No Dry-Run / Preview Mode
- No way to ask "what would you change?" without actually changing files

#### 20. No Priority Queue
- All subagents are FIFO — a critical security audit waits for low-priority refactors

#### 21. No Output Diffing
- No structured summary of what changed at file/function level

#### 22. No Audit Trail (Partial)
- Run history tracks which subagent ran, with what params, and error category
- But no record of which files were read/modified, or which tools were invoked
- Cannot answer "did a subagent read `.env`?"

#### 23. No RBAC / Permission Tiers
- All presets share the same privilege model
- No way to define role-based tool access beyond per-preset tool lists

#### 24. No Task Templates
- Presets are personality profiles only, not reusable task configurations

#### 25. No Progress Estimation / ETA
- No way to know how long a subagent might take

---

## Summary

| Category | Total | Resolved | Remaining |
|----------|-------|----------|-----------|
| 🔴 Critical | 9 | 9 | 0 |
| 🟡 Robustness | 6 | 6 | 0 |
| 🟠 Feature Gaps | 10 | 1 | 9 |
| **Total** | **25** | **16** | **9** |

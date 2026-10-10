# brl-subagent — Audit: Strengths & Weaknesses

> Generated: 2026-08-03 | Version: 2.5.0 (release prepared 2026-10-10). Content reflects the post-2.1.2 changes shipped in v2.1.3 through v2.5.0 (see the follow-up sections below).

## What's Been Fixed (since v1.3.0)

| # | Weakness | Resolution | Implementation |
|---|----------|-----------|----------------|
| 1 | Zero test coverage | **RESOLVED** | 641 tests across 31 files (unit + integration + benchmarks) |
| 2 | No input/output sanitization | **RESOLVED** | `sanitize.ts`: `sanitizeTask`, `validateCwd`, `validateOutputFile`, `stripAnsi`, `capOutput` |
| 3 | Subprocess environment inheritance | **RESOLVED** | `getSafeEnv()` allows only `PATH`, `HOME`, `LANG`, `TMPDIR`, `BRL_SUBAGENT_DEPTH` |
| 4 | Type safety holes | **RESOLVED** | `isSubagentStateShape` / `isSubagentRunShape` / `isMultiSubagentDetails` / `isGraphDetails` type guards replace all `as any` |
| 5 | No structured logging | **RESOLVED** | `logging.ts`: leveled logging (debug/info/warn/error) with file rotation (5MB/5 files) |
| 6 | No output size limits | **RESOLVED** | `capOutput` in `sanitize.ts` (100KB default, configurable) |
| 7 | Memory leak risk | **RESOLVED** | Session-bound cleanup; `finalizeLiveSubagent` removes entries after 3s; `session_shutdown` clears all |
| 8 | Race conditions in progress counters | **RESOLVED** | Counter mutations are single-threaded on the `SessionState` instance — foreground via `acquireSlot`/`releaseSlot`, background via the poller's terminal paths; race-safe by construction (the doc claim "only within acquireSlot/releaseSlot" was corrected 2026-08-26: the poller mutates directly, still race-free)
| 9 | No circuit breaker | **RESOLVED** | R1: `CircuitBreakerState` with 5-failure threshold, 60s auto-recovery, thinking-level degradation |
| 10 | No disk usage policy | **RESOLVED** | R2: Auto-prune runs (default 500), cleanup stale temp dirs (24h), configurable history limit |
| 11 | No pre-flight model validation | **RESOLVED** | R3: `preflightCheck()` validates pi binary, cwd readability, temp dir writability before spawning |
| 12 | Monolithic architecture | **RESOLVED** | Refactored into 30 modules: types, sanitize, validate, params, paths, presets, state, prompt, runner, concurrency, history, unit-run, router, reports, metrics, messaging, model-availability, event-bus, transcript, transcript-tail, session-manager, tui, tui-format, logging, preflight, git, diff, templates, scheduler, index (schedule.ts/E9 removed in #91; corrected 2026-08-27; paths.ts added #160, 2026-09-11; update.ts removed #164, 2026-09-12) |
| 13 | Module-level state not session-bound | **RESOLVED** | `SessionState` class initialized in `session_start`, cleaned in `session_shutdown` |
| 14 | Silent preset load failures | **RESOLVED** | R10: `validateAllPresets()` validates parsed presets; errors reported per file |
| 15 | No cost governance | **RESOLVED** | R5: `sessionCostLimit`, `perTaskCostEstimate`, `checkCostLimit()`, pre-delegation budget check |
| 16 | No change approval workflow | **RESOLVED** | P4: `approvalMode` ("auto"/"writes"/"always"), `showApprovalDialog()` TUI with apply/discard, merge-or-discard flow |
| 17 | No version control integration | **RESOLVED** | P3: `git.ts` — branch-based workflow with `createWorkBranch`, `captureDiff`, `mergeWorkBranch`, `switchToBranch`, `deleteBranch`. Uses `execFileSync` for shell safety. |
| 18 | No task chaining / parallel mode | **RESOLVED** | P1+P2: `runChainMode()` with `{previous}` placeholder; `runParallelMode()` with concurrent fan-out; `runGraphMode()` with dependency-aware waves |
| 20 | No priority queue | **RESOLVED** | P6: Four priority tiers (critical/high/normal/low), `priorityInsert()` in concurrency queue, FIFO within tier |
| 21 | No output diffing | **RESOLVED** | P5: `parseDiff()` in `diff.ts`, `FileDiff` interface, hunk capping (10/file), collapsed/expanded/full-diff views |
| 23 | No RBAC / permission tiers | **REMOVED** | P7 (SandboxLevel) removed in v2.1.0 as redundant with `tools`/`excludeTools` parameters. E6 (roles.ts) removed in v2.0.2. Tool access is now controlled directly via per-task `tools` and `excludeTools` parameters on `delegate_task`. Presets can define default tool restrictions via their `tools`/`excludeTools` fields. |
| 24 | No task templates | **RESOLVED** | P9: `TaskTemplate` interface, `resolveTemplate()` with `${param}` substitution, template management TUI, `template`+`params` on `delegate_task` |
| 26 | No skill-based routing | **RESOLVED** | E2: `router.ts` — keyword-based auto-classification of tasks to presets |
| 27 | No compliance reports | **RESOLVED** | E5: `reports.ts` — file access tracking, secrets exposure detection, compliance summary |
| 28 | No SLA tracking | **RESOLVED** | E4: `metrics.ts` — p50/p95/p99 latency, success rate, cost analysis, degradation detection |
| 29 | No RBAC roles | **REMOVED** | Redundant with P7 sandboxing — sandboxLevel already restricts tools |
| 30 | No multi-turn subagents | **REMOVED** | Architectural issues — broken in practice, removed in v2.0.2 |
| 31 | No pluggable backends | **RESOLVED** | E8: `backend.ts` — Backend abstraction with pi and direct-api implementations |
| 32 | No recurring scheduling | **REMOVED (#91, 2026-08-14)** | E9 `schedule.ts` was deleted — session-bound, `_tools` hack, never dogfooded in any real session; 936 lines removed. The dependency-graph `scheduler.ts` (P10) is unrelated and untouched. |
| 33 | No subagent messaging | **RESOLVED** | E10: `messaging.ts` — Intercom class with `[TO:agent-id]:` output format |
| 34 | No process pool | **REMOVED** | E11: `pool.ts` removed entirely (#41/#44, 2026-08-03) — never enabled in any real session (41 persisted states all `poolEnabled: false`), latent wrong-prompt-on-reuse bug, and it was the F27 fence bypass path (REVIEW_ISSUE27 finding #1). src/pool.ts + pool.test.ts deleted; no pool references remain in src/ or tests. |

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
- **All five modes visible since v2.3.1 (post-#130/#133):** single, background, parallel, graph, chain — per-unit rows with label/model/priority and streaming drill-in
- **Status-bar mode breakdown:** `graph wave x/y · node x/y` and `chain step x/y` composed with the background counters
- **Aggregate dispatch entries** in run history ("Graph dispatch: N tasks in M waves" / "Chain dispatch: N steps")

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

### Subagent Sandboxing (P7) — REMOVED v2.1.0
- **Removed** as redundant with `tools`/`excludeTools` parameters on `delegate_task`
- The conductor specifies allowed/excluded tools per-task directly
- Pre-task validation (H1) warns about tool/task mismatches
- Conductor guardrails (H4) guides tool selection for different task types
- Presets can still define default tool restrictions via their `tools`/`excludeTools` fields

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

### Process Pool (E11) — REMOVED post-2.1.2 (#41/#44)
- Warm-process pooling deleted on 2026-08-03: src/pool.ts (383 lines) + src/__tests__/pool.test.ts (410 lines) removed; `poolEnabled`/`poolSize` config keys, `/brl-subagent pool` UI, preWarm/shutdown hooks, and the `runSubagent` pool parameter all gone. Zero `pool` references remain in src/.
- Rationale: never enabled in any real session (41 persisted states all false); latent wrong-prompt-on-reuse bug (pool processes spawned without `--append-system-prompt`); the pool `sendTask` path bypassed the F27 task fence and the Task Boundary directive (REVIEW_ISSUE27.md finding #1, High).

### SLA Metrics (E4)
- p50/p95/p99 latency computation via linear interpolation
- Success rate and cost analysis per task
- Degradation detection against configurable baseline
- Alert thresholds: latency > 2× baseline, success < 80%, cost > 3× average

### Recurring Scheduler (E9) — REMOVED
- Deleted in #91 (2026-08-14): `schedule.ts` + `src/__tests__/schedule.test.ts`, the `/brl-subagent schedule|unschedule` TUI, and the `schedules` map on SessionState — never enabled in any real session, session-bound, `_tools` hack.
- The dependency-graph `scheduler.ts` (P10) is a different module and remains.

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
- Applied to presets and templates (schedules went with the E9 removal, #91)
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

| Category | Total | Resolved | Removed | Remaining |
|----------|-------|----------|---------|-----------|
| 🔴 Critical | 9 | 9 | 0 | 0 |
| 🟡 Robustness | 6 | 5 | 0 | 1 |  ← #22 No Audit Trail |
| 🟠 Feature Gaps | 5 | 3 | 0 | 2 |  ← #19 No Dry-Run, #25 No ETA |
| 🟢 Phase 4 | 5 | 2 | 3 | 0 |
| 📡 Notifications | 1 | 1 | 0 | 0 |
| 📁 Preset Migration | 1 | 1 | 0 | 0 |
| **Total** | **27** | **21** | **3** | **3** |

## Known Risks

### Vitest Import Blind Spot

Tests pass even when source files import variables/functions that don't exist, because Vitest's module resolution doesn't fail at import time for unresolved symbols. However, when pi loads the same module in production, unresolved imports cause runtime failures. This means a passing test suite does not guarantee the code will load correctly in the pi runtime.

**Mitigation:** Always verify with a manual `import` test or runtime smoke test after significant refactors. Consider adding a dedicated smoke test that imports and exercises every module.

## v2.5.0 Audit Follow-up (2026-10-10)

The durability cycle's audit surface: **recovery** (U1 — durable run registry, registry-sourced boot scan, wait-once reap, interrupted marking; the adversarial review's critical finding was fixed in-round: foreground records are now discoverable from a default fresh boot), **kill-path correctness** (#303 real-exit death check; #308 detached auto-approve keeps the merged commit reachable), **ledger truthfulness** (#304), and **test hygiene** (#302 — the suite can no longer move the checkout's HEAD or leak work branches). Process firsts: an unfamiliar adversarial reviewer (`~openai/gpt-luna-latest`) caught the #308 reachability regression the leak fix introduced; the recovery acceptance was live-verified on the merged build (dev toggle + `/reload`) before the release. Open at release: #299 (the documented D6 destination, trigger-based).

## v2.3.9 Audit Follow-up (2026-09-27)

Two read-only audits checked every README and AGENT.md claim against the code immediately before the release; the findings and their dispositions:

- **README** — 5 minor + 1 nit: the `stop_subagent` terminal contract (idempotent success, not an error); the `code-review` template example's slot (`${target}`); the timeout ordering wording; the disclosed 30-minute background cap; the missing parameter rows plus a new "Safety & control" section (guard / `force` / warning surfacing); the `{<nodeId>}` placeholder wording. All fixed (PR #226).
- **AGENT.md** — 2 minor + 1 nit: completion `details` are best-effort (a `stopped` run notifies before finalize); the wake/poll claims qualified by `completionNotify`; the `errorCategory` field name. Fixed (PR #226).
- **Schema-level** — `get_subagent_result`'s never-read `wait` parameter removed; the `retryRunId` description corrected — and the correction itself was caught being false ("pass them again explicitly" did nothing), which led to **#227** fixing the behaviour instead of documenting the hole. Both verified by review rounds (approve-with-nits; nits resolved or superseded).
- **Follow-ups filed:** #229 (pin the fan-out snapshot omission; e2e retried-background test; key-set drift guard).

## v2.3.8 Audit Follow-up (2026-09-22)

The largest single feature day of the project: the M2 parallel slice (background fan-out) delivered in five reviewed phases, alongside the four fixes filed at the v2.3.7 release.

**Fixed and released**

- **#185 — explicit run-entry lookups.** `findRunById` returned the FIRST match — the spawn entry (`status: "running"`) — so finished runs were looked up as running: the TUI stale-foreground fallback lost terminal output, and the #52 staleness sweep never reclaimed a poller-dead live entry. The terminal-preference rule now lives once in `resolveTerminalRunEntry`; `findSpawnRunById` (retry params) and `findTerminalRunById` (finalized entry) express intent at each call site.
- **#187 — coherent failed-run records.** `finalTurnError` was derived from the *coerced* failure reason, so a hard-cap timeout or a synchronous spawn throw was recorded `finalTurnError: true` with no provider error; it now derives from the raw terminal reason. The foreground `finalizeRunRecord` never set `stopReason`; it now shares the background path's `coherentFailureReason` helper.
- **#183 / #186 — two ratchets became structural.** The runtime-vocabulary ratchet scans runtime string literals under `src/**` with the TypeScript AST (every form the #174 grep missed, including terms split across `+` concatenations). The terminal-status ratchet was a line-regex matching one of eight spellings and ignoring `exitCode`-as-success; it is now an AST walk over comparisons (any quote style/alias), membership, failure-lists and numeric exit-code checks, with recorded allow-list reasons.

**Feature**

- **#198 — background fan-out for `tasks` (M2 parallel slice).** Five phases, each independently reviewed: **Phase 0** replaced the silent ignore with a loud rejection (#196); **Phase 1** extracted the inline background branch into a shared, factory-scope spawn path (normalized-diff proof: the function signature plus the removed `if` wrapper — all 363 body lines identical); **Phase 2** added `runBackgroundFanOut()` — validate-all-then-spawn-all, per-task guards and overrides, per-task retry snapshots, up-front approval/`gitMode: 'branch'`/cost-×N gates, abort and partial-failure reporting, task-order ids — with the spawn+monitor+poller tail shared through `startBackgroundAgent` (the single path's spawn region byte-identical apart from plumbing); 10/10 adversarial mutation probes killed. **Phase 3** documented the contract (prompt guideline, schema, AGENT.md, README); **Phase 4** closed the test gaps (per-task `outputFile` and H1 rejections, both mutation-verified). **Live acceptance:** a real two-task fan-out returned both ids and delivered two per-agent completion wakes.

**Process notes**

- **Risk-calibrated review held.** C1 adversarial passes for the extraction and the fan-out (medium-thinking reviewer, mutation probes), C2 focused passes for docs and tests; every review found at least one real nit, all fixed pre-merge.
- **Point-of-use verification caught tooling, not code:** the headless harness's mock ctx lacked `modelRegistry` (`harness-ctx-fidelity`), a mutation probe hit the wrong copy of a duplicated pattern (`mutation-target-drift`, filed as #201), and a wiring probe asserted the wrong field (`probe-field-mismatch`). A GitHub-side wedged PR head needed close/reopen (`github-pr-head-wedge`).

## v2.3.7 Audit Follow-up (2026-09-20)

An unusually dense day: four issues closed, one release, and a defect whose own fixes kept falling victim to it.

**Fixed and released**

- **#179 — honest terminal status (C1).** A background run that died mid-work was recorded *and reported* as a completed success: the SDK resolves `session.prompt()` on a mid-run provider death (`handleRunFailure` records an assistant message with `stopReason: "error"`, then resolves), and our settle path had no `error` branch — it derived status from `exitCode` alone and set `completed` unconditionally. Three such deaths occurred in one day, one of them *while implementing the fix*. Status is now classified from the terminal `stopReason`.
- **#179 D6 — file logging was never wired.** `createLogger(prefix, cwd?)` enables file output only when given a `cwd`; both call sites omitted it, so the extension's log had never been written in the project's history. That absence is why the day's deaths left no forensic trace at all.
- **#175 — template-only and retry-only dispatch** were both rejected because the single-mode sanitize ran before the blocks that assign the task body.
- **#174 — internal vocabulary in runtime output**, shipped since v2.3.3 and unfollowable by construction for every user.
- **#176 — packaging smoke test** now gates the release pipeline before staging.

**Found, filed, not yet fixed**

- **#185** — `findRunById` returns the *first* match, which is the spawn entry (`status: "running"`), so the drift-in fallback loses terminal output and the #52 sweep never reclaims a stale foreground entry. Correctly deferred from #179 to keep that change scoped — and visible in raw session data, where the spawn entry precedes the finalized one.
- **#186** — the terminal-status ratchet catches only the exact double-quoted form (4 of 8 spellings evade) and ignores `exitCode === 0`-as-success.
- **#187** — two failed-run records can't be trusted: `finalTurnError` can be stamped true for a *timeout* (the coherence coercion feeds it `'error'`), and the foreground `finalizeRunRecord` leaves `stopReason` undefined.
- **#183** — no automated ratchet stops internal vocabulary leaking into runtime strings again (the #174 class).

**Process notes**

- **The verification instrument was broken, and that mattered.** Because a death reported success, no stability reading taken before #179 could be trusted. The dogfooding posture (`dev` branch + a local-path `pi install`) was established this day, along with release-ritual **step 8** covering the switch back to the published package — *only after* the staging approval, since switching earlier silently reverts the running extension to the previous published version.
- **Dispatch reliability.** Four of roughly eight dispatches died and reported success. Short runs completed (probes ~2s, reviews 3–5 min); the failures clustered on longer, multi-file runs. Mitigations adopted: commit-early instructions, and incremental persistence in the review and debug templates so a death leaves verified findings behind rather than nothing.
- **Verification discipline.** Every dispatch's output was ground-truthed against files, commits and PRs rather than its reported status — which is the only reason the false successes surfaced at all.

## Phase 6.5 Audit — Pre-sync Findings (2026-07-11)

### Issue 1: session.id vs session.sessionId (Bug)
- **Location:** src/session-manager.ts:250
- **Problem:** Code uses `session.id` but `AgentSession` has `sessionId` property
- **Impact:** `sessionId` will be `undefined`, falls back to generated `id`
- **Severity:** Low (not a crash, but incorrect)
- **Fix:** Change `session.id` to `session.sessionId`

### Issue 2: File System Operations (OK)
- **Location:** src/session-manager.ts, src/transcript.ts
- **Problem:** Writes to `.pi/subagents/` and `.pi/output/` directories
- **Impact:** Directories created in current working directory
- **Severity:** None (expected behavior)

### Issue 3: Error Handling (Minor)
- **Location:** src/session-manager.ts (spawnBackgroundSession)
- **Problem:** If `createAgentSession()` fails, error is thrown and not caught
- **Impact:** Caller must handle the error
- **Severity:** Low (standard async error handling)

### Issue 4: Session Lifecycle (OK)
- **Location:** src/session-manager.ts (spawnBackgroundSession)
- **Problem:** `session.prompt()` is non-blocking (intentional)
- **Impact:** Session runs independently in background
- **Severity:** None (by design)


## Phase 6.5 Audit — Post-sync Findings (2026-07-11)

### Issue 5: SettingsManager Constructor (Bug — Fixed)
- **Location:** src/session-manager.ts
- **Problem:** Used `new SettingsManager(effectiveCwd)` but SettingsManager has private constructor
- **Impact:** "Cannot convert undefined or null to object" error
- **Severity:** High (crash)
- **Fix:** Changed to `SettingsManager.create(effectiveCwd)`

### Issue 6: Background Execution Not Wired (Bug — Fixed)
- **Location:** src/index.ts (execute handler)
- **Problem:** `background` parameter defined in schema but execute handler didn't check for it
- **Impact:** Background tasks ran as foreground tasks
- **Severity:** High (feature not working)
- **Fix:** Added `if (params.background)` check before single mode execution

### Issue 7: session.id vs session.sessionId (Bug — Fixed)
- **Location:** src/session-manager.ts:250
- **Problem:** Used `session.id` but AgentSession has `sessionId` property
- **Impact:** sessionId would be undefined, fall back to generated id
- **Severity:** Low (not a crash, but incorrect)
- **Fix:** Changed to `session.sessionId`

### Background Execution — Verified Working
- **Test:** Spawned background task with 30-second wait
- **Result:** Task ran independently in background
- **Proof:** Main interface remained responsive while task was running
- **Duration:** 35 seconds (30s task + 5s session creation overhead)
- **Transcript:** Created successfully in .pi/output/

### Phase 6.5 Complete — All Features Working
- ✅ Background execution (spawnBackgroundSession)
- ✅ Status polling (get_subagent_result)
- ✅ Mid-run steering (steer_subagent)
- ✅ Transcript recording (JSONL files)
- ✅ Event bus (lifecycle events)


## 2026-07-19 — Tool System & Concurrency Audit

### Tool System Fixes
1. **edit requires write** — pi's tool dependency chain means edit fails without write. Fixed by auto-including write when edit is in tools list.
2. **Inherited prompt confusion** — When inheritSystemPrompt=true and tools are restricted, subagent prompt lists tools it doesn't have. Fixed by appending "Your Available Tools" section.
3. **Sandbox removed** — Redundant. tools/excludeTools + H1 validation + H4 guardrails provide the safety layer.
4. **Backend removed** — direct-api was a skeleton. Only pi backend was ever used.

### Concurrency Fix
- **Background spawn serialization** — pi's API modules (getAgentDir, createAgentSession) fail under concurrent access. Fixed with dynamic import + serialization queue.
- **UUID fallback** — crypto.randomUUID() fails in some contexts. Fixed with Math.random() fallback.

### Dead Code Removed
- event-bus.ts: on, onAny, once, off, offAll, listenerCount (only emit + createEvent used)
- transcript.ts: appendToolCall, appendToolResult, appendAssistantMessage, appendError, listTranscripts, hasTranscript
- preflight.ts: PreflightOk, PreflightFail interfaces (replaced with inline union)
- tui.ts: describePromptMode duplicate (real one in prompt.ts)
- backend.ts: entire file deleted (dead code)

### Foreground Transcripts
- All foreground tasks now create transcripts (previously only background tasks did)

### Footer Visibility Fix
- Footer component was not rendering in certain TUI views
- Fixed by ensuring footer is included in all view render paths
- Verified in collapsed, expanded, chain, parallel, and graph views

### Polling Mechanism Fixes
- Background agent status polling was not properly handling session state transitions
- Fixed poll interval handling and status message formatting
- Poll interval is hardcoded at 2000ms in the index.ts poller (there is **no** `pollIntervalMs` parameter; `get_subagent_result` takes `agent_id`, `wait`, `verbose`)
- Final output capture added on completion (`extractFinalOutput` + `setAgentFinalOutput`)

### Version 2.1.0 Summary
- **Phase 5 (Hardening)**: All H1-H4 tasks complete
- **Phase 6 (Background Execution)**: All 6.1-6.5 tasks complete
- **Tool system**: edit auto-includes write, prompt clarifies available tools
- **Concurrency**: Dynamic import + serialization queue for background spawns
- **Sandbox removed**: Redundant with tools/excludeTools parameters
- **Backend removed**: direct-api dead code eliminated
- **Foreground transcripts**: All sessions now record transcripts

## 2026-07-29 — Notification System & Preset Migration Audit

### Notification System for Background Agents

**What was added:**
- Three `pi.sendMessage()` calls with `{ deliverAs: "followUp" }` emit lifecycle notifications for background agents
- Events covered: completed, crashed, timed-out (30-min hard cap)
- Uses `customType: "subagent-notification"` with `details.agentId` for correlation
- Notifications appear inline in the conductor conversation as follow-ups

**Design rationale:**
- `deliverAs: "followUp"` ensures the notification is associated with the original delegation, not injected as a new message
- Agent description (human-readable label) is used in content text rather than raw agent ID
- Only terminal transitions emit notifications — intermediate states (pending → running) are silent

### File-Backed Custom Preset Migration

**What was changed:**
- Custom presets moved from session-bound `state.config.presets` (array in serialized state) to file-backed `.md` files in two user directories:
  - `.pi/brl-subagent/presets/` (project-local, highest priority)
  - `~/.pi/agent/brl-subagent/presets/` (global, shared across projects)
- `state.customPresets` now loaded from files on every `session_start` via `loadCustomPresets()`
- `writePresetFile()` function writes `.md` files with YAML frontmatter matching built-in preset format
- Existing session-persisted presets migrated to files on first session start via `_migratedPresets` in state

**TUI changes:**
- `getPreset` function moved from `tui.ts` to `presets.ts` (single source of truth)
- `showAddPreset()` now writes `.md` files and asks user for save location (project vs global)
- `showRemovePreset()` scans directories for `.md` files and deletes the selected file
- `showPresetManager()` displays `[B]` (built-in), `[P]` (project), `[G]` (global) source indicators
- `findPresetSource()` helper resolves source label without loading preset content
- `persistState` parameter removed from all three preset TUI functions (no longer needed)

**Integration points:**
- `index.ts` `session_start` handler: migrates old session presets → writes `.md` files → refreshes `state.customPresets`
- `state.ts` `restoreFromSession()`: stashes old `data.presets` in `_migratedPresets` for migration
- `presets.ts`: exports `loadCustomPresets`, `writePresetFile`, `getPreset`, `parseFrontmatter`
- `delegate_task.execute()`: uses `state.customPresets` instead of `state.config.presets` for preset resolution

### Remaining Weaknesses (unaffected)

| # | Weakness | Notes |
|---|----------|-------|
| 19 | No Dry-Run / Preview Mode | Unchanged — still no sandboxed execution preview |
| 22 | No Read Audit Trail | Unchanged — no record of which files were read |
| 25 | No Progress Estimation / ETA | Unchanged — no historical duration analysis |

## Post-demo Security Audit (2026-08-01)

Security audit of `src/session-manager.ts` performed during the preset demo run (full report in `PRESET_DEMO_AUDIT.md`): 2 High, 4 Medium, 2 Low, 3 Informational findings. The F1/F2 fixes (PR #36) and the partial F5 fix (#33 + #21) landed ~1.5-2h after the audit was written.

| ID | Finding | Severity | Status |
|----|---------|----------|--------|
| F1 | Path traversal via unsanitized agent id (`join(STORAGE_DIR, \`${id}.json\`)`; `../` not sanitized by path.join) | High | ✅ FIXED (#36) — `assertSafeAgentId()` UUID validation (`sanitize.ts:135`); `getAgent` → null, `getTranscriptPath` → throw, `persistAgent` → refuse |
| F2 | Model-controlled cwd triggers execution of third-party pi extension code (`DefaultResourceLoader.reload()` from untrusted cwd) | High | ✅ FIXED (#36) — background always builds its own `DefaultResourceLoader` with `noExtensions: true` + `noSkills: true`; nothing imported from the LLM-controlled cwd |
| F3 | systemPrompt string can be silently read as a file (SDK `resolvePromptInput` `existsSync` check) | Medium | 🟡 OPEN (#26) — a raw single-line custom prompt matching a real path would read that file into the prompt |
| F4 | Task text has no boundary separation (no "task is data" framing; subagent holds full tools) | Medium | 🟡 OPEN (#27) |
| F5 | Background sessions bypass approval/gitMode/timeout/cost; hardcoded tools; stopAgent is a status-only placeholder | Medium | 🔶 PARTIALLY FIXED (#33 + #21) — toolOptions now honored, H1 validation runs pre-spawn, prompt injected via `appendSystemPrompt`; approval/gitMode/timeout/cost still not threaded; `stopAgent` remains transcript/status-only |
| F6 | Sensitive data persisted plaintext, world-readable (0644) | Medium | 🟡 OPEN (#29) — records contain task + finalOutput incl. secrets read during the run |
| F7 | Error messages disclose paths/context | Low | 🟡 OPEN (#30) |
| F8 | `_sessionRef` never released (full live session retained per completed agent) | Low | 🟡 OPEN (#31) |
| F9 | Clean: model string resolution | Info | — |
| F10 | Clean: concurrency/error propagation (spawnQueue try/finally, reload failure propagates) | Info | — |
| F11 | Clean: persistence hygiene (.pi/ gitignored, `_sessionRef` stripped) | Info | — |

**Blockers encountered (the preset demo finding):** the security-auditor preset restricts tools to read/grep/find/ls; a `delegate_task` call passing `outputFile` was silently defeated by the preset's tool restriction — the subagent could not write the report. Addressed in the same wave: H1 now hard-rejects `outputFile`-without-`write` (#33) and preset tool restrictions are surfaced to the conductor via `formatPresetRestriction` (#33).

**Key takeaway:** preset tool restrictions override per-call outputFile expectations; the conductor now sees the restrictions before delegating.

## Post-demo Audit Follow-up (2026-08-03, post-2.1.2 / unreleased)

Status of the F1–F11 findings and related issues as of 2026-08-03 (main @ 515dc46, working tree):

| ID | Finding | Status (2026-08-03) |
|----|---------|---------------------|
| F3 | systemPrompt string read as file | ✅ **FIXED (#26, PR #40)** — literal `\n<system-prompt>\n…\n</system-prompt>\n` wrap (`session-manager.ts:370-372`); the `/` forces a multi-component relative path and the appended SUBAGENT_INSTRUCTIONS (>NAME_MAX) guarantees `existsSync` is false. Test: session-manager.test.ts "a path-looking systemPrompt is NOT read as a file (F26 security property)" |
| F4 | Task text has no boundary separation | ✅ **FIXED (#27, commit 919a2e9 + #42, PR #46)** — `wrapTask()` fences the task at both chokepoints (runner.ts `-p` arg :328; session-manager.ts `session.prompt` :452); `SUBAGENT_INSTRUCTIONS` gains the "Task Boundary" directive; embedded `<task>`/`</task>` markers are neutralized to fullwidth variants. NOTE: 919a2e9 landed DIRECTLY on main (no PR — process error); the worktree skill's rule #5 was added to prevent recurrence. Live-verified 2026-08-03: a forged-marker payload stayed inside the fence in BOTH foreground and background paths |
| F5 | Background bypass (approval/gitMode/timeout/cost; stopAgent placeholder) | 🔶 **PARTIALLY FIXED further** — task fence now applies to background (`session.prompt(wrapTask(...))`); the pool path that bypassed everything is gone (#41/#44). Still open: approvalMode/gitMode/timeout/cost are not threaded into `spawnBackgroundSession`; `stopAgent`/`steerAgent` remain transcript/status-only. **#28 now has LIVE evidence**: steering a background agent to STOP did not abort the in-process session (status: steered, but monitor kept showing running; `session.prompt` loop continued). No `session.abort()` exists — a real abort is the fix direction for #28 |
| F6 | World-readable persistence | 🟡 OPEN (#29) |
| F7 | Error path disclosure | 🟡 OPEN (#30) |
| F8 | `_sessionRef` retention | 🟡 OPEN (#31) |

**Process pool culled (#41/#44, 2026-08-03):** `src/pool.ts` (383 lines) and `src/__tests__/pool.test.ts` (410 lines) deleted; `poolEnabled`/`poolSize` config keys, `/brl-subagent pool` UI, preWarm/shutdown hooks, and the `runSubagent` pool param removed. Rationale: never enabled in any real session (41 persisted states all `poolEnabled: false`), latent wrong-prompt-on-reuse bug, and the pool path was the F27 fence bypass (REVIEW_ISSUE27 finding #1). **INCIDENTAL FIX:** the old parallel path passed 16 args to the 15-param `runSubagent`, silently dropping `intercom`/`subagentId` — parallel subagents never received intercom messages; now fixed (`index.ts:1047`).

**Wontfix decisions (2026-08-03):**
- **#38 (foreground extension loading) CLOSED wontfix** — verified against SDK source: pi's trust model already mitigates (non-interactive subprocess → `hasUI: false` → fail-closed untrusted → project extensions never loaded). A blanket flag would break user-global skills. README documents background isolation; foreground relies on the trust model.
- **#35 (custom preset staleness) CLOSED wontfix** — mitigated by guideline text ("inspect them via /brl-subagent preset before combining with outputFile or tool-dependent work").
- **#37 (trust-based loader alternative, `resolveProjectTrust: false`) CLOSED wontfix** — rejected in favor of the blanket `noExtensions`/`noSkills` loader.

**Open (2026-08-03):** #28 (real abort for background agents — steering/stop do not abort), #29/#30/#31 (F6/F7/F8), #34 (H1 validation for chain/parallel/graph modes), #45 (`/brl-subagent gitmode` menu item is misleading: gitMode resolution is per-call param > state config, and the menu only sets the state fallback — 5 sessions set 'branch' but 12 run records show `gitBranch: None`; fix: remove the menu item, keep the per-call param).


## v2.3.1 Audit Follow-up (2026-08-25)

**Weakness found + fixed (the sweep invariant):** #133 — graph/chain live entries (added in #130) were invisible in the monitor because `sweepStaleLiveSubagents` treats a foreground live entry without a persisted run record as stale and finalizes it on the first render. Single/parallel always persisted run entries; #130's record-less nodes violated the invariant. Fixed by restoring the invariant (full run-record lifecycle for graph/chain), not by changing the sweep — which is byte-for-byte unchanged and remains the single liveness oracle.

**Verification-gap lesson (Rule 9 proof):** the regression was invisible to 903 unit tests — none exercised the sweep against record-less entries. It was caught by the point-of-use probe (the monitor ritual failed three times on 08-24 before a background-sleep control isolated the sweep as the culprit; the earlier "slash commands don't dispatch" hypothesis was refuted — extension commands execute immediately even during streaming). Regression now pinned: sweep-survival tests (running → kept, done → finalized) + graph-execute integration tests.

**Open:** #120 (provider connection errors — capture protocol armed), #129 (intercom fidelity), #132 (DRY: wrapper + run-record helpers).

## Post-2.3.1 Follow-up (2026-08-26)

- **#135 (PR, no version bump)** — per-unit run-entry helpers extracted to `src/unit-run.ts` (makeLiveOnUpdate 4×, createUnitRun 3×, finalizeUnitRun 3×) + 10 direct helper tests; 922 tests. Remaining duplication filed as #136.
- **#138 (PR, no version bump)** — status-bar counter fix: per-unit `releaseSlot` passed `false` unconditionally (parallel per-task, graph per-node), so every successful unit counted as FAILED; now each unit's real success (`!isSubagentError`) reaches the release. User-observed live (5-node probe: "1 done (1 unseen), 5 failed" — the fingerprint), fixed, verified (5-node probe ends at "6 done, 0 failed"). 926 tests.
- **Correction:** the F8 resolution's "mutated only within acquireSlot/releaseSlot" claim was imprecise — the background poller mutates the counters directly on its terminal paths; race-safety comes from the single-threaded SessionState, not the mutation site (fixed above).

## v2.3.2 Audit Follow-up (2026-08-27)

- **#120 CLOSED — honest termination records**: every kill path (foreground abort, timeout, background terminal paths, the catch-all) stamps the abort source + honest error category — no path left without one; classifyError's `aborted by user` pattern + the shared `SUBAGENT_ABORTED_MESSAGE` constant keep the stamp authoritative. `enrichFailureDiagnostics` adds the model-error turn count. Verified live on cancel/timeout/background paths. The provider-side `Connection error.` class is external (post-ladder persistent unavailability) — diagnosed and mitigated, not fixable here.
- **#129 CLOSED — E10 extraction fidelity**: `TO_PATTERN` anchored to standalone lines — mid-sentence instruction-quotes are no longer extracted as messages; the E10 guidance requires the standalone form. Verified live with the adversarial flash shape (quote + real line emitted; only the real line arrived).
- **#136 CLOSED — per-unit family complete**: finalizeUnitRunCrash/pruneHistoryIfNeeded/registerLiveRun single-source the remaining duplication; review caught + fixed the chain Step-N label delta.
- **#141 CLOSED — dead code**: `stripMessageLines` removed (import, function, tests).
- **Process**: Rule 18 extended (no time limits on implementers — third-recurrence lesson); termination triage + retry taxonomy (pi transport retries ≠ re-dispatch ≠ user retry); briefing discipline for user-involving probes; background-by-default.
- **Corrections this pass**: module count 27→30 (params, tui-format, transcript-tail, unit-run added; schedule/E9 removed in #91 — the E9 finding and section now say REMOVED).

## v2.3.3 Audit Follow-up (2026-09-02)

- **#147 CLOSED — completion-push wake**: event-bus subscriber (its FIRST consumer) → `pi.sendMessage` + `triggerTurn` wakes an idle conductor on terminal background events; structured D3 message (id · duration · cost · category + byte-budgeted tail + directive); pure builder/thin-sender split; `resolveRunEntry` (finalized entry over the spawn entry — both share id/startedAt); `completionNotify` knob (`all`/`failed`/`off`, delivery always-on, wake configurable). Feasibility validated pre-dispatch (graph + code: event-bus complete, no new emission sites); adversarial review caught the spawn-entry resolution bug (empirically reproduced) + the stopped-run pre-finalize degradation (accepted by design, documented); revision round fixed resolution with honest tests. Live-verified at point of use: idle wake (completed run, cost/duration present — proves the terminal-entry fix in production), stopped wake (exactly one event, accepted `category: unknown` degradation), followUp-boundary delivery mid-task. Two probe-design lessons logged (exit-1-in-a-tool-call does NOT fail a session; a background run's failure is session-level, not forceable on demand).
- **#149 CLOSED — single notification per run**: the #147 live probes + user observation (`[subagent-notification]` tag) surfaced a pre-existing SECOND completion channel — the poller's short echoes (customType `subagent-notification`, followUp no-trigger, v2.1.x era) duplicated the wake with strictly less information and bypassed the knob. Coverage map classified all eight sites; four retired (completed/stopped/2×timeout — pairing proven live or by code position), the crash trio kept (poller-unique: no-session edge, loop-crash) + the failed site kept by explicit user decision (residual duplication documented, not blocking). Reviewer verified empirically (scratch probes in /tmp: stopped emit count = 1 with real persist; completed survives transcript deletion; persistAgent swallows write errors). Live-verified: one message per run (completed + stopped paths).
- **Process**: two probe-design failures logged (the exit-1 probe; the false "#149 failed-emit gap" inference) — corrected by full settle-ladder reading; scoping lesson logged (when validating "X has no consumers", map the DIRECT sendMessage sites, not just the event-bus); worktree-guard absolute-path bug found at its point of use (first conductor-implemented change, PR #152) — filed #153, fixed in .pi/ (whitelisted); sequencing lesson (cleanup ran before a confirmed merge — PR #152's merge was blocked by the pending CI check; recovered via the PR head sha — merge first, verify, THEN cleanup).
- **Corrections**: module count 30 unchanged; the failed-path "missing wake" finding was INVALID (probe design flaw) — every terminal path emits (completed :970, stopped :217/:904/:871, spawn-refusal :692, settle-throw :1049).

## v2.3.4 Audit Follow-up (2026-09-04)

- **#154 CLOSED — conductor knowledge gap**: the design discussion established the three-home split (schema = mechanics + dynamic inventories, AGENT.md = behavior + judgment, generated summaries for built-in lists — static inventories go stale). Coverage matrices proved the call surface was well-taught; the misses were the behavioral layer (the wake), the knob dependency, and the stale poll-teaching in the schema itself (pre-#147 text — a recurrence of the instruction-affordance class). Fix package: AGENT.md at root (authoritative, versioned, "guidelines are a derived summary" header), schema rewrites replacing poll-teaching with the wake contract + knob clause (Option C — rewrite not add), generated templateSummary mirroring presetRestrictionSummary, a pinning test, and a currency rule (behavioral-contract PRs update the schema text). **Adversarial review caught two headline defects**: (1) CRITICAL — `${templateSummary}` sat in a DOUBLE-QUOTED string (never interpolates — dead code shipping a literal placeholder; the SAME pre-existing bug in `${presetRestrictionSummary}` since 13e722a, discovered by tracing the replicated pattern); (2) MAJOR — AGENT.md's "all or failed always wakes" claim was false (under "failed", completed runs don't wake). The revision fixed all 7 findings (backtick literals, knob-accurate wording, rendered-text pinning test break-verified to fail when broken, a real path for the AGENT.md pointer, buildInventorySummary DRY helper). Acceptance demonstrated live: a conductor waited for the wake without polling. 976 tests.
- **Toolchain**: pi-sdk group ^0.85.0 (harness parity). The bump gate caught the upstream packaging gap (pi-coding-agent@0.85.0's main entry statically imports the undeclared @earendil-works/pi-server — verified unexpected: the ONLY undeclared import across ~320 sites, new in 0.85.0, masked in the monorepo by workspace resolution); bridged with a direct devDependency; upstream issue filed by a third party 17 minutes before ours.
- **#153 CLOSED (local tooling, gitignored)**: the worktree-guard fix took two rounds — round 1's exemption still blocked because the repo-root check was a SLASH-LESS startsWith (the sibling brl-subagent-wt-154 STRING-PREFIXES brl-subagent); found by instrumenting the exemption. Also: /reload does NOT hot-reload auto-discovered .pi/extensions (staleness proven empirically — correct on-disk logic still blocked at runtime; a full restart was required).
- **Process**: two more technical mid-task deaths logged (the #154 implementer died twice — first mid-investigation at 2m8s with zero work on disk; clean identical re-dispatch recovered). The #154 review was the session's strongest — Gate A evidence (cat -A quote semantics, git blame provenance) caught what code reading alone would miss.

## v2.3.5 Audit Follow-up (2026-09-11)

- **Published as a pi package (npm)** — the extension is now installable via `pi install npm:brl-subagent` (global or `-l` project-local), updated with `pi update --extensions`. The manifest work that made it *valid*: `peerDependencies` for the five pi-bundled core packages (`"*"`), because `typebox` and two `@earendil-works` packages are **runtime imports that sat in `devDependencies`** — and `pi install` uses production installs (`--omit=dev`), so a consumer install would have crashed at load. Verified end-to-end in a sandbox: the install lands the extension and pulls exactly one package. Added the `files` allowlist, `license`, and `repository`.
- **#158 CLOSED — AGENT.md unreachable for npm users**: the capability reference was omitted from `files` (so it never reached consumers) AND the `delegate_task` guideline hardcoded the retired sync-copy path. Both were invisible under the old sync-copy dev setup — the package dogfooding switch is what exposed them. AGENT.md now ships and resolves from the extension's own directory.
- **#160 CLOSED — package-root resolution consolidated**: `pkgPath()` (`src/paths.ts`) single-sources the `<pkg>/src` → `<pkg>` base across 7 call sites in 2 modules. The focused review proved behaviour preservation (all 9 built-in templates load through the helper) and mutation-tested the new coverage.
- **#162 CLOSED — regression path closed**: the AGENT.md guidance test asserted only the filename, so a reverted hardcoded path stayed green; it now pins the computed-path contract (the `${agentMdPath}` interpolation, with the retired path asserted absent).
- **Process**: `sync-extension.sh` retired (npm dogfooding + local-path dev toggle); the release pipeline is OIDC trusted publishing with **staged**, approval-gated versions — first real run staged 2.3.5, maintainer-approved; CI on node 24 with actions v7. **Corrections**: module count 30 → **31** (paths.ts). **Gap found at release**: the bump shipped three stale doc version strings (README ×2, AGENT.md header) — nothing pins doc versions to `package.json`; the guard test is queued for the next release (2.3.5 is immutable).
- **Toolchain**: pi-sdk `^0.85.1` parity — the `pi-server` devDependency workaround retired once pi 0.85.1 removed the experimental import that had made the undeclared dependency load-bearing.

## v2.3.6 Audit Follow-up (2026-09-12)

A follow-on sweep in which **every item traces to something the 2.3.5 release exposed** — the release's own lessons became guards.

- **#166 CLOSED — shipped-doc version claims pinned.** The README `**Version:**` line must equal `package.json`, and AGENT.md's H1 must stay version-free, making the release ritual's step 1 **mechanical**: a forgotten inventory fails CI instead of shipping quietly. A forward-compat ratchet mirrors the #114 precedent. This is also the mechanical half of the sprint's **Rule 11 P0** (unverified claims — 3 occurrences: the sync-list claim, the 2.3.5 version strings, the jiti negative claim).
- **#165 CLOSED — maintainer content out of the shipped AGENT.md.** Its `## Local development` section reached every user's conductor as part of the capability reference; relocated to the worktree skill, whose cross-reference to it was repointed so nothing dangles.
- **#171 CLOSED — npm is the sole user-facing install path.** The documented git alternative was removed; its own text admitted the trade (a pinned ref is never advanced by `pi update --extensions`), so following it pinned a user out of updates.
- **#164 CLOSED — the obsolete update notifier removed.** It duplicated pi's native notice, misdirected users to the GitHub release, and — under staged publishing — could announce a version npm did not yet have. `src/update.ts` and its test deleted; the module count drops **31 → 30**. The C2 focused review proved backwards compatibility **empirically** (legacy session keys ignored, not rejected; the guard did not go soft elsewhere) and mutation-tested the README pinning test four ways.
- **Corrections**: module count 31 → **30** (update.ts removed). Two spec-scoping gaps were surfaced by the **implementer**, not the conductor — an e2e fixture list referencing the deleted module by *name* (symbol greps cannot see it) and a self-contradictory grep check. Both logged; the name-vs-symbol lesson is the second instance this sprint of *'the query did not cover the evidence'*.
- **Toolchain**: vitest 4 → 5 (major; CI-verified) and typebox 1.3.25 → 1.3.29. The typebox dev/runtime divergence from pi's bundled **1.3.7** was verified **inert** for our nine-primitive-builder surface (byte-identical schema output across 1.3.7/1.3.25/1.3.29) and is now recorded in the Distribution & Packaging section so it need not be re-investigated.

# brl-subagent — Task Tracking

> Living document — update status as tasks progress.
> See `ROADMAP.md` for full feature descriptions and priorities.

## Legend

| Status | Meaning |
|--------|---------|
| `todo` | Not started |
| `in_progress` | Currently working on |
| `done` | Completed and verified |
| `blocked` | Waiting on dependency |
| `cancelled` | No longer needed |

| Phase | Description |
|-------|-------------|
| `P1` | Foundation (v1.4.0) |
| `P2` | Reliability (v1.5.0) |
| `P3` | Power (v1.6.0) |
| `P4` | Excellence (v2.0.0) |

---

## Phase 1 — Foundation (v1.4.0) ✅ 10/10

| ID | Task | Phase | Effort | Status | Assignee | Notes |
|----|------|-------|--------|--------|----------|-------|
| F1 | Input sanitization (task, cwd, outputFile) | P1 | S | `done` | — | `sanitize.ts`: `sanitizeTask`, `validateCwd`, `validateOutputFile` |
| F2 | Environment isolation in spawn() | P1 | S | `done` | — | `sanitize.ts`: `getSafeEnv()` — safe env allowlist passed to spawn |
| F3 | Output sanitization (ANSI strip, size cap) | P1 | S | `done` | — | `sanitize.ts`: `stripAnsi`, `capOutput` (100KB default) |
| F4 | Unit test suite | P1 | M | `done` | — | 92 tests across 4 files: types, presets, sanitize, prompt |
| F5 | Type safety hardening | P1 | M | `done` | — | `isSubagentStateShape` / `isSubagentRunShape` type guards replace all `as any` |
| F6 | Modular architecture (split index.ts) | P1 | L | `done` | — | 13 → 16 modules: types, sanitize, presets, state, prompt, runner, concurrency, history, tui, logging, preflight, git, diff, templates, scheduler, index |
| F7 | Session-bound state (lifecycle hooks) | P1 | M | `done` | — | `SessionState` class; initialized in `session_start`, cleaned in `session_shutdown` |
| F8 | Race condition fixes | P1 | M | `done` | — | Counters mutated only within `acquireSlot`/`releaseSlot` on `SessionState` instance |
| F9 | State migration & validation | P1 | M | `done` | — | Type guards validate on restore; corrupted entries logged + skipped |
| F10 | Structured logging | P1 | M | `done` | — | `logging.ts`: leveled logging (debug/info/warn/error) with file rotation (5MB/5 files) |

## Phase 2 — Reliability (v1.5.0) ✅ 10/10

| ID | Task | Phase | Effort | Status | Assignee | Notes |
|----|------|-------|--------|--------|----------|-------|
| R1 | Circuit breaker | P2 | M | `done` | subagent | Opens after 5 consecutive failures, auto-recovers after 60s, degrades thinking level to minimal |
| R2 | Disk usage policy | P2 | S | `done` | subagent | Auto-prune runs (default 500), cleanup stale temp dirs (24h), configurable via `/brl-subagent historyentries` |
| R3 | Pre-flight checks | P2 | M | `done` | subagent | Validates pi binary, cwd readability, temp dir writability before spawning |
| R4 | Output size limiting (per-task cap) | P2 | S | `done` | — | Already implemented in F3 (`capOutput` in sanitize.ts) |
| R5 | Cost governance | P2 | M | `done` | subagent | Per-session budget cap, per-task cost estimate, configurable via `/brl-subagent costlimit` |
| R6 | State restore error recovery | P2 | S | `done` | — | Already implemented in F9 (type guards + fallback) |
| R7 | Integration tests | P2 | L | `done` | subagent | 85 integration tests covering param resolution, prompt building, run lifecycle, retry, concurrency, depth guard, sanitize pipeline |
| R8 | Performance benchmarks | P2 | M | `done` | subagent | 32 benchmarks across 8 groups: prompt building, frontmatter parsing, error classification, cleanupRuns, formatUsageStats, sanitizeTask, retry params, env filtering |
| R9 | Error classification | P2 | S | `done` | subagent | `classifyError()` in types.ts — 9 categories with priority-based pattern matching |
| R10 | Preset validation on load | P2 | S | `done` | subagent | `validateAllPresets()` validates parsed preset objects after loading |

## Phase 3 — Power (v1.6.0) ✅ 10/10

| ID | Task | Phase | Effort | Status | Assignee | Notes |
|----|------|-------|--------|--------|----------|-------|
| P1 | Task chaining ({previous} placeholder) | P3 | L | `done` | subagent | `runChainMode()` in index.ts: sequential step execution, `{previous}` substitution, stops on failure, ChainDetails aggregate. Max 10 steps. |
| P2 | Parallel task mode | P3 | L | `done` | subagent | `runParallelMode()` in index.ts: concurrent fan-out via Promise.allSettled, per-task slot acquisition, ParallelDetails aggregate. Max 8 tasks. |
| P3 | Git integration (auto-commit, diff) | P3 | L | `done` | subagent | `git.ts`: `getCurrentBranch`, `hasUncommittedChanges`, `createWorkBranch`, `captureDiff`, `switchToBranch`, `deleteBranch`, `mergeWorkBranch`. Uses `execFileSync` for shell injection safety. |
| P4 | Change approval workflow (dry-run) | P3 | L | `done` | subagent | `approvalMode` config ("auto"/"writes"/"always"), `showApprovalDialog()` TUI with diff preview, keyboard shortcuts (Y/D/N), merge-or-discard flow integrated with git branch lifecycle. |
| P5 | Output diffing | P3 | M | `done` | subagent | `diff.ts`: `parseDiff()` produces `FileDiff[]` with additions/deletions/hunks. Hunk capping (MAX_HUNKS_PER_FILE=10). Collapsed file summary, expanded per-file hunks, full raw diff view (D key). |
| P6 | Priority queue | P3 | M | `done` | subagent | `priorityInsert()` in concurrency.ts: four tiers (critical/high/normal/low), FIFO within tier. `defaultPriority` config + per-call `priority` param override. |
| P7 | Subagent sandboxing | P3 | L | `done` | subagent | `SandboxLevel` type ("none"/"readonly"/"safe"), `SANDBOX_TOOLS`/`SANDBOX_EXCLUDE` maps. Per-call override chain: call > preset > config. TUI selector via `/brl-subagent sandbox`. |
| P8 | Process pool | P3 | L | `done` | subagent | Implemented as E11 in Phase 4: `pool.ts` manages warm pi processes in RPC mode with lazy spawn, idle cleanup, and configurable pool size. |
| P9 | Task templates | P3 | M | `done` | subagent | `templates.ts`: `resolveTemplate()` with `${param}` substitution, `extractParamNames()` for validation. Template management TUI (add/view/remove). `template`+`params` on `delegate_task`. |
| P10 | Dependency graph | P3 | L | `done` | subagent | `scheduler.ts`: `detectCycle()` (three-color DFS), `topologicalSort()` (Kahn's algorithm → waves), `validateGraph()`. `runGraphMode()` in index.ts: wave-based execution with `{taskId}` output substitution. Max 12 tasks. |

## Phase 4 — Excellence (v2.0.0) ✅ 11/11

| ID | Task | Phase | Effort | Status | Assignee | Notes |
|----|------|-------|--------|--------|----------|-------|
| E1 | Observability dashboard | P4 | XL | `done` | subagent | Web UI showing active subagents, history, cost trends, success rates. Real-time metrics via `metrics.ts` integration. |
| E2 | Skill-based routing | P4 | L | `done` | subagent | `router.ts`: auto-classify task description → best preset personality using keyword matching rules. |
| E3 | Recursive delegation | P4 | L | `done` | subagent | Configurable depth limit via `maxSubagentDepth`; prevents infinite chains. Integrated with `BRL_SUBAGENT_DEPTH` env propagation. |
| E4 | SLA tracking | P4 | M | `done` | subagent | `metrics.ts`: p50/p95/p99 latency, success rate, cost-per-task, degradation detection against baseline. Configurable window size (10-500 runs). |
| E5 | Compliance reports | P4 | M | `done` | subagent | `reports.ts`: file access tracking, secrets exposure detection, compliance summary with role breakdown. |
| E6 | RBAC matrices | P4 | M | `done` | subagent | `roles.ts`: three built-in roles (reviewer/developer/auditor) with tool permissions. Per-call override chain: role > sandbox > config. |
| E7 | Multi-turn subagents | P4 | L | `done` | subagent | `maxTurns` parameter: subagents ask clarifying questions via `[QUESTION]:` format. Conductor feeds answers back as context. |
| E8 | Pluggable backends | P4 | XL | `done` | subagent | `backend.ts`: Backend abstraction with `pi` (full tools) and `direct-api` (HTTP, no tools) implementations. Configurable via `/brl-subagent backend`. |
| E9 | Scheduling (cron-like) | P4 | M | `done` | subagent | `schedule.ts`: recurring task schedules with interval-based polling, fire-and-forget execution, enable/disable, `/brl-subagent schedule` TUI. |
| E10 | Subagent-to-subagent messaging | P4 | L | `done` | subagent | `messaging.ts`: Intercom class with `[TO:agent-id]:` output format, targeted and broadcast messages, message delivery on completion. |
| E11 | Process pool | P4 | L | `done` | subagent | `pool.ts`: warm pi process management in RPC mode, lazy spawn on acquire, idle cleanup timer, configurable pool size. Replaces deferred P8. |

---

## Phase Completion Summary

| Phase | Version | Tasks | Completed | Deferred | Notes |
|-------|---------|-------|-----------|----------|-------|
| P1 — Foundation | v1.4.0 | 10 | 10 | 0 | All security and architecture tasks done |
| P2 — Reliability | v1.5.0 | 10 | 10 | 0 | Circuit breaker, cost governance, pre-flight checks |
| P3 — Power | v1.6.0 | 10 | 10 | 0 | All tasks including P8 (now E11) |
| P4 — Excellence | v2.0.0 | 11 | 11 | 0 | All 11 tasks complete (E1-E11) |
| **Total** | | **41** | **41** | **0** | All phases complete |

## Change Log

| Date | Change |
|------|--------|
| 2026-07-06 | Initial documentation: ARCHITECTURE.md, AUDIT.md, ROADMAP.md, TASKS.md created |
| 2026-07-06 | Phase 1 complete: F1–F10 implemented. 92 unit tests passing. Architecture refactored into 13 modules. |
| 2026-07-06 | **Recursion depth limit** added: `BRL_SUBAGENT_DEPTH` env var tracks nesting; `maxSubagentDepth` config (default: 1) prevents infinite subagent chains. Configurable via `/brl-subagent depth`. |
| 2026-07-06 | **Dev-agent preset** added to prompt guidelines: full-access preset for development subagents. |
| 2026-07-06 | **Subagent feedback protocol** added to prompt instructions: standardized reporting format for subagent results. |
| 2026-07-06 | **execFileSync security fix**: Replaced `execSync`/`spawn` shell calls with `execFileSync` for all git commands to prevent shell injection. |
| 2026-07-06 | Phase 2 complete: R1–R10 implemented. 258 tests across 10 files (54 types, 35 sanitize, 11 prompt, 20 presets, 13 git, 13 circuit, 11 cost, 8 history, 8 preflight, 85 integration) + 32 benchmarks. |
| 2026-07-06 | P3 (Git integration) complete: branch-based workflow with `git.ts` module. `delegate_task` supports `gitMode` parameter. Configurable via `/brl-subagent gitmode`. |
| 2026-07-07 | Phase 3 complete: P1–P10 (except P8 deferred). 365 tests across 16 files. New modules: diff.ts, templates.ts, scheduler.ts. |
| 2026-07-07 | **P1 — Task chaining** complete: `runChainMode()` with `{previous}` placeholder substitution, sequential execution, per-step progress updates, ChainDetails aggregate. Max 10 steps. |
| 2026-07-07 | **P2 — Parallel task mode** complete: `runParallelMode()` with concurrent fan-out via Promise.allSettled, per-task concurrency slot acquisition, ParallelDetails aggregate. Max 8 tasks. |
| 2026-07-07 | **P4 — Change approval workflow** complete: `approvalMode` config ("auto"/"writes"/"always"), `showApprovalDialog()` TUI with diff preview and keyboard shortcuts, merge-or-discard flow. |
| 2026-07-07 | **P5 — Output diffing** complete: `parseDiff()` in diff.ts, FileDiff interface, hunk capping (10/file), collapsed/expanded/full-diff TUI views. |
| 2026-07-07 | **P6 — Priority queue** complete: four priority tiers, `priorityInsert()` in concurrency queue, default priority config + per-call override. |
| 2026-07-07 | **P7 — Subagent sandboxing** complete: SandboxLevel type, SANDBOX_TOOLS/EXCLUDE maps, per-call override chain, TUI selector. |
| 2026-07-07 | **P9 — Task templates** complete: `resolveTemplate()` with ${param} substitution, template management TUI, template+params on delegate_task. |
| 2026-07-07 | **P10 — Dependency graph** complete: detectCycle (DFS), topologicalSort (Kahn's algorithm), validateGraph, runGraphMode with wave-based execution. Max 12 tasks. |
| 2026-07-07 | **P8 — Process pool** deferred to Phase 4 (E11). Would reduce cold-start latency but requires significant process lifecycle management. |
| 2026-07-07 | **Phase 4 complete**: E1-E11 all implemented. 532 tests across 25 files. New modules: router.ts, roles.ts, reports.ts, schedule.ts, metrics.ts, pool.ts, messaging.ts, backend.ts. Total 24 source modules. |
| 2026-07-07 | **E1 — Observability dashboard** complete: real-time metrics dashboard showing active subagents, cost trends, success rates, and SLA metrics. |
| 2026-07-07 | **E2 — Skill-based routing** complete: `router.ts` auto-classifies task descriptions to best preset via keyword matching rules. |
| 2026-07-07 | **E3 — Recursive delegation** complete: configurable `maxSubagentDepth` with `BRL_SUBAGENT_DEPTH` env propagation. Prevents infinite subagent chains. |
| 2026-07-07 | **E4 — SLA tracking** complete: `metrics.ts` computes p50/p95/p99 latency, success rate, cost-per-task, degradation alerts. Configurable analysis window. |
| 2026-07-07 | **E5 — Compliance reports** complete: `reports.ts` generates file access reports, secrets exposure detection, compliance summary with role breakdown. |
| 2026-07-07 | **E6 — RBAC matrices** complete: `roles.ts` with reviewer/developer/auditor roles, tool permissions, per-call override chain. |
| 2026-07-07 | **E7 — Multi-turn subagents** complete: `maxTurns` parameter enables subagents to ask clarifying questions via `[QUESTION]:` format. |
| 2026-07-07 | **E8 — Pluggable backends** complete: `backend.ts` with Backend abstraction, pi (full tools) and direct-api (HTTP) implementations. |
| 2026-07-07 | **E9 — Scheduling** complete: `schedule.ts` with recurring task schedules, interval polling, fire-and-forget execution, TUI management. |
| 2026-07-07 | **E10 — Subagent messaging** complete: `messaging.ts` Intercom class with `[TO:agent-id]:` format, targeted and broadcast messages. |
| 2026-07-07 | **E11 — Process pool** complete: `pool.ts` manages warm pi processes, lazy spawn, idle cleanup, configurable pool size. Replaces deferred P8. |
| 2026-07-07 | **Reserved name validation** added: `RESERVED_NAME_PATTERN` (`/^__.*__$/`) and `RESERVED_COMMAND_NAMES` set prevent collision with TUI sentinels and `/brl-subagent` completions. Applied to presets, templates, and schedules. |
| 2026-07-07 | **Preset prompt guidelines** added: `promptGuideline` field on presets provides usage hints. Built-in presets include guidelines for when to use each personality (e.g., "For security audits. Use thinkingLevel: high."). dev-agent preset added. |

# brl-subagent — Development Roadmap

> Generated: 2026-07-09 | Version: 2.0.2

## Phase 1 — Foundation (v1.4.0) ✅ COMPLETE

> Goal: Production-ready security and robustness baseline. No new features — fix gaps.

| ID | Feature | Effort | Priority | Status |
|----|---------|--------|----------|--------|
| F1 | **Input sanitization** — validate `task` for injection, `cwd` for path traversal, `outputFile` for containment | S | P0 | ✅ |
| F2 | **Environment isolation** — filtered env in `spawn()` (allowlist: `PATH`, `HOME`, `LANG`, `TMPDIR`, `BRL_SUBAGENT_DEPTH`) | S | P0 | ✅ |
| F3 | **Output sanitization** — strip ANSI escapes; cap output at 100KB default (configurable) | S | P0 | ✅ |
| F4 | **Unit test suite** — Vitest tests for: `parseFrontmatter`, `buildSubagentPrompt`, `resolveSubagentParams`, `formatUsageStats`, `accumulateUsage` | M | P0 | ✅ |
| F5 | **Type safety hardening** — replace all `as any` with proper type guards; add state schema validation | M | P0 | ✅ |
| F6 | **Modular architecture** — split `index.ts` into 16 modules | L | P1 | ✅ |
| F7 | **Session-bound state** — move counters and sessions to `session_start`/`session_shutdown` lifecycle via `SessionState` | M | P1 | ✅ |
| F8 | **Race condition fixes** — per-run state instead of module-level mutable counters | M | P1 | ✅ |
| F9 | **State migration & validation** — versioned state schema; validate on load; handle corruption gracefully | M | P1 | ✅ |
| F10 | **Structured logging** — log levels; `.pi/subagent-logs/` with rotation | M | P1 | ✅ |

## Phase 2 — Reliability (v1.5.0) ✅ COMPLETE

> Goal: Production resilience. Circuit breakers, cost control, and operational excellence.

| ID | Feature | Effort | Priority | Status |
|----|---------|--------|----------|--------|
| R1 | **Circuit breaker** — track consecutive failures; degrade (fallback model, reduce thinking, pause) after N | M | P0 | ✅ |
| R2 | **Disk usage policy** — max temp size; max history entries; auto-prune with configurable retention | S | P0 | ✅ |
| R3 | **Pre-flight checks** — validate environment (pi binary, cwd, temp dir) before spawning | M | P0 | ✅ |
| R4 | **Output size limiting** — per-task cap with truncation notice; configurable via parameter | S | P0 | ✅ |
| R5 | **Cost governance** — per-session budget cap; per-task cost estimate; alert at threshold | M | P1 | ✅ |
| R6 | **State restore error recovery** — try/catch on state deserialization; fall back to defaults | S | P1 | ✅ |
| R7 | **Integration tests** — end-to-end: spawn real pi subprocesses, verify output, test retry/timeout/abort | L | P1 | ✅ |
| R8 | **Performance benchmarks** — measure spawn time, throughput under concurrency, memory over time | M | P2 | ✅ |
| R9 | **Error classification** — categorize errors (timeout, model_unavailable, tool_error, permission_denied) | S | P1 | ✅ |
| R10 | **Preset validation** — schema-validate on load; report which file failed and why | S | P1 | ✅ |

## Phase 3 — Power (v1.6.0) ✅ COMPLETE

> Goal: Feature parity with the best subagent systems. Advanced delegation patterns.

| ID | Feature | Effort | Priority | Status |
|----|---------|--------|----------|--------|
| P1 | **Task chaining** — `chain: [{task}, ...]` with `{previous}` placeholder; sequential execution with per-step progress | L | P0 | ✅ **DONE** |
| P2 | **Parallel task mode** — `tasks: [{task}, ...]` for concurrent fan-out; each task acquires its own concurrency slot | L | P0 | ✅ **DONE** |
| P3 | **Git integration** — branch-based workflow; auto-create work branch, capture diff, switchback, merge/discard | L | P1 | ✅ **DONE** |
| P4 | **Change approval workflow** — approvalMode (auto/writes/always); TUI dialog with diff preview, apply/discard | L | P1 | ✅ **DONE** |
| P5 | **Output diffing** — parseDiff for structured file-level summaries; collapsed/expanded/full-diff views; hunk capping | M | P1 | ✅ **DONE** |
| P6 | **Priority queue** — four tiers (critical/high/normal/low), FIFO within tier, priorityInsert function | M | P2 | ✅ **DONE** |
| P7 | **Subagent sandboxing** — SandboxLevel (none/readonly/safe), SANDBOX_TOOLS/EXCLUDE maps, per-call override | L | P2 | ✅ **DONE** |
| P8 | **Process pool** — keep warm pi processes for reuse (reduces cold-start latency) | L | P2 | ✅ **DONE** (E11) |
| P9 | **Task templates** — save reusable task configurations with ${param} substitution; template management TUI | M | P2 | ✅ **DONE** |
| P10 | **Dependency graph** — declare task dependencies; topological sort → wave-based parallel execution; cycle detection | L | P3 | ✅ **DONE** |

### Discovery Tasks (added during implementation)

| ID | Feature | Notes |
|----|---------|-------|
| D1 | **Recursion depth limit** | `BRL_SUBAGENT_DEPTH` env var + `maxSubagentDepth` config; prevents infinite subagent chains |
| D2 | **Dev-agent preset** | Added to prompt guidelines: full-access preset for development subagents |
| D3 | **Subagent feedback protocol** | Enhanced prompt instructions for how subagents should report their work |
| D4 | **execFileSync security fix** | Replaced `execSync`/`spawn` with `execFileSync` for all git commands to avoid shell injection |
| D5 | **Graph mode execution** | Added `runGraphMode()` to index.ts with wave-based execution using scheduler.ts |
| D6 | **Chain/parallel mode in index.ts** | Added `runChainMode()` and `runParallelMode()` with cost/depth guard integration |
| D7 | **Type guards for multi-mode** | Added `isMultiSubagentDetails()`, `isGraphDetails()` for runtime mode detection in TUI |
| D8 | **Approval dialog with diff view** | TUI approval dialog with keyboard shortcuts (Y/D/N) and scrollable full diff view |

## Phase 4 — Excellence (v2.0.0) ✅ COMPLETE

> Goal: Best-in-class subagent extension with unmatched capabilities.

| ID | Feature | Effort | Priority | Status |
|----|---------|--------|----------|--------|
| E1 | **Observability dashboard** — web UI showing active subagents, history, cost trends, success rates | XL | P2 | ✅ **DONE** |
| E2 | **Skill-based routing** — auto-classify task → best preset personality | L | P2 | ✅ **DONE** |
| E3 | **Recursive delegation** — subagents can delegate sub-tasks to other subagents | L | P3 | ✅ **DONE** |
| E4 | **SLA tracking** — p50/p95/p99 latency; success rate; cost-per-task; degradation alerts | M | P3 | ✅ **DONE** |
| E5 | **Compliance reports** — "which subagents touched X?", "secrets accessed?", "cost by agent type" | M | P3 | ✅ **DONE** |
| E6 | **RBAC matrices** — role-based tool permissions (reviewer, auditor, developer) | M | P3 | ❌ **Removed** |
| E7 | **Multi-turn subagents** — subagents ask clarifying questions back to conductor | L | P3 | ❌ **Removed** |
| E8 | **Pluggable backends** — support non-pi backends: OpenAI API, Anthropic API, webhook, container | XL | P3 | ✅ **DONE** |
| E9 | **Scheduling** — cron-like: "run security audit every night at 2am" (via pi agent loop) | M | P3 | ✅ **DONE** |
| E10 | **Subagent-to-subagent messaging** — direct communication channel between concurrent subagents | L | P3 | ✅ **DONE** |
| E11 | **Process pool** — keep warm pi processes for reuse (reimplemented from P8 in Phase 3) | L | P2 | ✅ **DONE** |

### Discovery Tasks (added during implementation)

| ID | Feature | Notes |
|----|---------|-------|
| D1 | **Recursion depth limit** | `BRL_SUBAGENT_DEPTH` env var + `maxSubagentDepth` config; prevents infinite subagent chains |
| D2 | **Dev-agent preset** | Added to prompt guidelines: full-access preset for development subagents |
| D3 | **Subagent feedback protocol** | Enhanced prompt instructions for how subagents should report their work |
| D4 | **execFileSync security fix** | Replaced `execSync`/`spawn` with `execFileSync` for all git commands to avoid shell injection |
| D5 | **Graph mode execution** | Added `runGraphMode()` to index.ts with wave-based execution using scheduler.ts |
| D6 | **Chain/parallel mode in index.ts** | Added `runChainMode()` and `runParallelMode()` with cost/depth guard integration |
| D7 | **Type guards for multi-mode** | Added `isMultiSubagentDetails()`, `isGraphDetails()` for runtime mode detection in TUI |
| D8 | **Approval dialog with diff view** | TUI approval dialog with keyboard shortcuts (Y/D/N) and scrollable full diff view |
| D9 | **Reserved name validation** | `RESERVED_NAME_PATTERN` and `RESERVED_COMMAND_NAMES` prevent collision with TUI sentinels |
| D10 | **Preset prompt guidelines** | `promptGuideline` field on presets provides usage hints ("For security audits. Use thinkingLevel: high.") |
| D11 | **Process pool warm-start** | `pool.ts`: lazy spawn, idle cleanup timer, configurable pool size for reduced cold-start latency |
| D12 | **RBAC role system** | `roles.ts`: reviewer/developer/auditor roles with tool permissions and override chain |
| D13 | **SLA degradation alerts** | `metrics.ts`: baseline comparison with configurable thresholds for performance regression detection |
| D14 | **Secrets exposure detection** | `reports.ts`: pattern-based scan for `.env`, `.pem`, `credentials.json` in file access reports |
| D15 | **Schedule management TUI** | `/brl-subagent schedule` and `/brl-subagent unschedule` for recurring task lifecycle |
| D15 | **Version notifier** | Check for newer versions of brl-subagent on task start; display upgrade notice |
| D16 | **Backtick code block removal** | Strip triple-backtick fences from subagent prompts to prevent LLM prompt leakage |
| D17 | **Reserved names** | `RESERVED_NAME_PATTERN` and `RESERVED_COMMAND_NAMES` prevent collision with TUI sentinels |
| D18 | **Preset guidelines** | `promptGuideline` field on presets provides usage hints |
| D19 | **Dead code cleanup** | Remove vestigial E6 roles.ts and E7 multi-turn code after removal decision |

> **Removal rationale:** E6 was removed as redundant with P7 sandboxing — sandboxLevel already restricts tools. E7 was removed due to architectural issues — the multi-turn protocol was fragile and broken in practice.

## Phase 5 — Hardening (v2.1.0) 🚧 IN PROGRESS

> Goal: Make the extension bulletproof regardless of conductor quality. A distracted, tired, or lazy conductor cannot produce a subagent that silently fails.

| ID | Feature | Effort | Priority | Status |
|----|---------|--------|----------|--------|
| H1 | **Pre-task Validation** — Deterministic pre-spawn checks that validate tool configuration and thinking level match the task description | M | P0 | 🚧 |
| H2 | **Integration Test Suite** — End-to-end tests using real pi subprocesses for every Phase 3+4 feature | L | P0 | 🚧 |
| H3 | **Post-mortem Diagnostics** — After a subagent fails, analyze why and append suggestions to error messages | S | P0 | 🚧 |
| H4 | **Conductor Guardrails** — Embed conductor behavior rules in promptGuidelines and SUBAGENT_INSTRUCTIONS | S | P0 | 🚧 |

## Phase 6 — Background Execution (v2.2.0) ✅ COMPLETE

> Goal: Enable subagents to run in the background without blocking the conductor. Add transcript recording, mid-run steering, and session resume. Inspired by [pi-subagents](https://github.com/tintinweb/pi-subagents).

> **Architecture shift**: Current architecture is subprocess-based (blocking `spawn()`). New architecture is session-based (non-blocking `pi sessions start`). Background agents run independently; conductor polls for status.

> **Note**: Phase 6 provides the foundation modules (types, session manager, transcript, event bus). Actual background execution logic requires a pi ExtensionAPI extension and is pending.

| ID | Feature | Effort | Priority | Status |
|----|---------|--------|----------|--------|
| 6.1 | **Types extension** — Add `BackgroundAgent`, `TranscriptEntry`, `SubagentEvent`, event bus types to `types.ts` | S | P0 | ✅ DONE |
| 6.2 | **Session manager** — Create and manage pi sessions for background agents; non-blocking execution; status tracking; resume | L | P0 | ✅ DONE |
| 6.3 | **Transcript recording** — Record agent conversations to JSONL files for replay, analysis, and mid-run steering | M | P0 | ✅ DONE |
| 6.4 | **Event bus** — Lifecycle event pub/sub (`subagent:created`, `:started`, `:completed`, `:failed`, `:stopped`, `:steered`, `:compacted`) so other extensions can react to agent state changes | S | P1 | ✅ DONE |

### Phase 6.1 — Types Extension (independent, parallelizable) ✅ DONE

| Subtask | Description | Depends On |
|---------|-------------|------------|
| 6.1.1 | Add `AgentStatus` type (`pending`, `running`, `completed`, `failed`, `stopped`, `steered`) | — |
| 6.1.2 | Add `BackgroundAgent` interface (id, sessionId, type, description, status, timestamps, task, model, thinkingLevel, transcriptPath, result, error) | 6.1.1 |
| 6.1.3 | Add `TranscriptEntry` interface and `TranscriptEntryType` type (system, user, assistant, tool_call, tool_result, error) | — |
| 6.1.4 | Add `SubagentEvent` interface, `SubagentEventType` type, and `SubagentEventListener` type for event bus | — |

### Phase 6.2 — Session Manager (depends on 6.1) ✅ DONE

| Subtask | Description | Depends On |
|---------|-------------|------------|
| 6.2.1 | Create `src/session-manager.ts` with `createSession()`, `getSession()`, `listSessions()`, `stopSession()`, `steerSession()`, `resumeSession()` | 6.1.2 |
| 6.2.2 | Store agent records in `Map<string, BackgroundAgent>` and persist to `.pi/subagents/` directory | 6.2.1 |
| 6.2.3 | Emit events via event-bus on status changes | 6.4 |
| 6.2.4 | Add `delegate_task` `background` parameter (boolean) to toggle blocking vs non-blocking mode | 6.2.1 |

### Phase 6.3 — Transcript Recording (depends on 6.1) ✅ DONE

| Subtask | Description | Depends On |
|---------|-------------|------------|
| 6.3.1 | Create `src/transcript.ts` with `startTranscript()`, `appendEntry()`, `getTranscript()`, `listTranscripts()` | 6.1.3 |
| 6.3.2 | Write to `.pi/output/agent-<id>.jsonl` — each line is a JSON object | 6.3.1 |
| 6.3.3 | Stream entries as they arrive (not buffered) | 6.3.1 |
| 6.3.4 | Read back transcripts for replay and analysis | 6.3.1 |

### Phase 6.4 — Event Bus (depends on 6.1) ✅ DONE

| Subtask | Description | Depends On |
|---------|-------------|------------|
| 6.4.1 | Create `src/event-bus.ts` with `on()`, `emit()`, `off()`, `once()` | 6.1.4 |
| 6.4.2 | Simple in-memory pub/sub; synchronous emission; registration-order delivery | 6.4.1 |
| 6.4.3 | Integrate with session-manager and transcript modules | 6.4.1 |

## Phase 6.5 — Background Execution Integration (v2.2.0) 📋 PLANNED

> Goal: Wire the foundation modules (session-manager, transcript, event-bus) to pi's actual session API (`createAgentSession()` from `@earendil-works/pi-coding-agent`). Add `get_subagent_result` and `steer_subagent` tools.

| ID | Feature | Effort | Priority | Status |
|----|---------|--------|----------|--------|
| 6.5.1 | **Session manager integration** — Update `session-manager.ts` to use `createAgentSession()` instead of placeholder records | L | P0 | 📋 |
| 6.5.2 | **get_subagent_result tool** — Register new tool to poll session status and retrieve results | M | P0 | 📋 |
| 6.5.3 | **steer_subagent tool** — Register new tool to inject messages into running sessions | M | P0 | 📋 |
| 6.5.4 | **Transcript integration** — Wire transcript recording to session lifecycle events | S | P1 | 📋 |
| 6.5.5 | **Event-bus integration** — Wire event-bus to session lifecycle (create/complete/fail/stop/steer) | S | P1 | 📋 |

### Phase 6.5.1 — Session Manager Integration (depends on 6.2)

| Subtask | Description | Depends On |
|---------|-------------|------------|
| 6.5.1.1 | Import `createAgentSession`, `SessionManager` from `@earendil-works/pi-coding-agent` | — |
| 6.5.1.2 | Replace placeholder record creation with actual session spawning | 6.5.1.1 |
| 6.5.1.3 | Handle background vs foreground mode (background returns ID immediately) | 6.5.1.2 |
| 6.5.1.4 | Store session reference in agent record for later polling/steering | 6.5.1.2 |

### Phase 6.5.2 — get_subagent_result Tool (depends on 6.5.1)

| Subtask | Description | Depends On |
|---------|-------------|------------|
| 6.5.2.1 | Register `get_subagent_result` tool with `agent_id` parameter | — |
| 6.5.2.2 | Poll session status (running/completed/failed/stopped) | 6.5.1 |
| 6.5.2.3 | Return result or "still running" message | 6.5.2.2 |
| 6.5.2.4 | Include transcript path in result | 6.5.2.3 |

### Phase 6.5.3 — steer_subagent Tool (depends on 6.5.1)

| Subtask | Description | Depends On |
|---------|-------------|------------|
| 6.5.3.1 | Register `steer_subagent` tool with `agent_id` and `message` parameters | — |
| 6.5.3.2 | Validate session is running before steering | 6.5.1 |
| 6.5.3.3 | Inject message into session conversation | 6.5.3.2 |
| 6.5.3.4 | Emit `subagent:steered` event | 6.5.3.3 |

### Phase 6.5.4 — Transcript Integration (depends on 6.3)

| Subtask | Description | Depends On |
|---------|-------------|------------|
| 6.5.4.1 | Call `startTranscript()` when session is created | 6.3 |
| 6.5.4.2 | Call `appendToolCall()` / `appendToolResult()` during execution | 6.5.4.1 |
| 6.5.4.3 | Call `completeTranscript()` when session ends | 6.5.4.1 |

### Phase 6.5.5 — Event-bus Integration (depends on 6.4)

| Subtask | Description | Depends On |
|---------|-------------|------------|
| 6.5.5.1 | Emit `subagent:created` on session create | 6.4 |
| 6.5.5.2 | Emit `subagent:started` when session starts running | 6.5.5.1 |
| 6.5.5.3 | Emit `subagent:completed` / `subagent:failed` on session end | 6.5.5.1 |
| 6.5.5.4 | Emit `subagent:stopped` / `subagent:steered` on user action | 6.5.5.1 |

---

## Effort Legend

| Label | Meaning |
|-------|---------|
| S | Small — <1 hour |
| M | Medium — 1-4 hours |
| L | Large — 1-2 days |
| XL | Extra Large — multiple days |

## Priority Legend

| Label | Meaning |
|-------|---------|
| P0 | Blocking — must ship in current phase |
| P1 | High — strongly desired in current phase |
| P2 | Medium — nice to have |
| P3 | Low — future consideration |

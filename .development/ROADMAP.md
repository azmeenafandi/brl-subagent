# brl-subagent — Development Roadmap

> Updated: 2026-10-10 | Released: **v2.4.0** (2026-10-03) | Integration: `dev` @ the v2.5.0 release prep (see "Shipped (2026-10-10, v2.5.0)" below). Development happens in the **cockpit** (`brl-subagent-dev` checkout); `main` is the pristine release checkout. The post-2.1.2 backlog items below shipped in v2.1.3 (2026-08-06), v2.1.4 (2026-08-07), v2.1.5 (2026-08-08), v2.1.6 (2026-08-09), v2.1.7 (2026-08-14), v2.2.0 (2026-08-16), v2.2.1 (2026-08-18), v2.3.0 (2026-08-23), v2.3.1 (2026-08-25), v2.3.2 (2026-08-27), v2.3.3 (2026-09-02), v2.3.4 (2026-09-04), v2.3.5, v2.3.6 (2026-09-12), v2.3.7 (2026-09-20), v2.3.8 (2026-09-22) and v2.3.9 (2026-09-27); the Open list reflects the current backlog.

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
| P7 | ~~Subagent sandboxing~~ — **REMOVED** in v2.1.0: Redundant with `tools`/`excludeTools` parameters on `delegate_task` | L | P2 | ❌ **REMOVED** |
| P8 | ~~Process pool~~ — **REMOVED post-2.1.2 (#41/#44, 2026-08-03)**: `pool.ts` deleted; never enabled in any real session, latent wrong-prompt-on-reuse bug, F27 fence bypass path | L | P2 | ❌ **REMOVED** |
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
| E1 | **Observability dashboard** — TUI (`/brl-subagent dashboard`, `showDashboard` at tui.ts:1910) showing active subagents, history, cost trends, success rates | XL | P2 | ✅ **DONE** |
| E2 | **Skill-based routing** — auto-classify task → best preset personality | L | P2 | ✅ **DONE** |
| E3 | **Recursive delegation** — subagents can delegate sub-tasks to other subagents | L | P3 | ✅ **DONE** |
| E4 | **SLA tracking** — p50/p95/p99 latency; success rate; cost-per-task; degradation alerts | M | P3 | ✅ **DONE** |
| E5 | **Compliance reports** — "which subagents touched X?", "secrets accessed?", "cost by agent type" | M | P3 | ✅ **DONE** |
| E6 | **RBAC matrices** — role-based tool permissions (reviewer, auditor, developer) | M | P3 | ❌ **Removed** |
| E7 | **Multi-turn subagents** — subagents ask clarifying questions back to conductor | L | P3 | ❌ **Removed** |
| E8 | ~~Pluggable backends~~ — **REMOVED** in v2.1.0: Dead code, never reached production use | XL | P3 | ❌ **REMOVED** |
| E9 | **Scheduling** — cron-like: "run security audit every night at 2am" (via pi agent loop) | M | P3 | ✅ **DONE** |
| E10 | **Subagent-to-subagent messaging** — direct communication channel between concurrent subagents | L | P3 | ✅ **DONE** |
| E11 | ~~Process pool~~ — **REMOVED post-2.1.2 (#41/#44, 2026-08-03)**: see P8; replaced by nothing (direct spawn only) | L | P2 | ❌ **REMOVED** |

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
| D11 | **Process pool warm-start** | `pool.ts`: lazy spawn, idle cleanup timer, configurable pool size for reduced cold-start latency — **REMOVED post-2.1.2 (#41/#44, 2026-08-03)** |
| D12 | **RBAC role system** | `roles.ts`: reviewer/developer/auditor roles with tool permissions and override chain |
| D13 | **SLA degradation alerts** | `metrics.ts`: baseline comparison with configurable thresholds for performance regression detection |
| D14 | **Secrets exposure detection** | `reports.ts`: pattern-based scan for `.env`, `.pem`, `credentials.json` in file access reports |
| D15 | **Schedule management TUI** | `/brl-subagent schedule` and `/brl-subagent unschedule` for recurring task lifecycle |
| D15 | **Version notifier** | Check for newer versions of brl-subagent on task start; display upgrade notice |
| D16 | **Backtick code block removal** | Strip triple-backtick fences from subagent prompts to prevent LLM prompt leakage |
| D17 | **Reserved names** | `RESERVED_NAME_PATTERN` and `RESERVED_COMMAND_NAMES` prevent collision with TUI sentinels |
| D18 | **Preset guidelines** | `promptGuideline` field on presets provides usage hints |
| D19 | **Dead code cleanup** | Remove vestigial E6 roles.ts and E7 multi-turn code after removal decision |

> **Removal rationale:** E6 was removed as redundant with `tools`/`excludeTools` parameters on `delegate_task`. E7 was removed due to architectural issues — the multi-turn protocol was fragile and broken in practice.

## Phase 5 — Hardening (v2.1.0) ✅ COMPLETE

> Goal: Make the extension bulletproof regardless of conductor quality. A distracted, tired, or lazy conductor cannot produce a subagent that silently fails.

| ID | Feature | Effort | Priority | Status |
|----|---------|--------|----------|--------|
| H1 | **Pre-task Validation** — Deterministic pre-spawn checks that validate tool configuration and thinking level match the task description; hard-rejects `outputFile`-without-`write` (only hard error; tool/thinking/git checks are warnings, #33); background mode runs the same validation pre-spawn | M | P0 | ✅ |
| H2 | **Integration Test Suite** — End-to-end tests using real pi subprocesses for every Phase 3+4 feature | L | P0 | ✅ |
| H3 | **Post-mortem Diagnostics** — After a subagent fails, analyze why and append suggestions to error messages | S | P0 | ✅ |
| H4 | **Conductor Guardrails** — Embed conductor behavior rules in promptGuidelines and SUBAGENT_INSTRUCTIONS | S | P0 | ✅ |

## Phase 6 — Background Execution (v2.1.0) ✅ COMPLETE

> Goal: Enable subagents to run in the background without blocking the conductor. Add transcript recording, mid-run steering, and session resume. Inspired by [pi-subagents](https://github.com/tintinweb/pi-subagents).

> **Architecture shift**: Current architecture is subprocess-based (blocking `spawn()`). New architecture is session-based (non-blocking `pi sessions start`). Background agents run independently; conductor polls for status.

> **Notes (2.1.x line):**
> - Dynamic import fix for concurrent background spawns — avoids module caching issues when multiple background agents start simultaneously
> - Foreground transcript recording added — all sessions now record transcripts, not just background ones
> - Sandbox system removed in v2.1.0 (redundant with `tools`/`excludeTools` parameters)
> - Backend system removed in v2.1.0 (dead code — pluggable backends never reached production use)

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
| 6.1.2 | Add `BackgroundAgent` interface (id, sessionId, type, description, status, timestamps, task, model, thinkingLevel, finalOutput, result, error) | 6.1.1 |
| 6.1.3 | Add `TranscriptEntry` interface and `TranscriptEntryType` type (system, user, assistant, tool_call, tool_result, error) | — |
| 6.1.4 | Add `SubagentEvent` interface, `SubagentEventType` type, and `SubagentEventListener` type for event bus | — |

### Phase 6.2 — Session Manager (depends on 6.1) ✅ DONE

| Subtask | Description | Depends On |
|---------|-------------|------------|
| 6.2.1 | Create `src/session-manager.ts` with `createSession()`, `getAgent()`, `listAgents()`, `stopAgent()`, `steerAgent()` | 6.1.2 |
| 6.2.2 | Store agent records in `Map<string, BackgroundAgent>` and persist to `.pi/subagents/` directory | 6.2.1 |
| 6.2.3 | Emit events via event-bus on status changes | 6.4 |
| 6.2.4 | Add `delegate_task` `background` parameter (boolean) to toggle blocking vs non-blocking mode | 6.2.1 |

### Phase 6.3 — Transcript Recording (depends on 6.1) ✅ DONE

| Subtask | Description | Depends On |
|---------|-------------|------------|
| 6.3.1 | Create `src/transcript.ts` with `startTranscript()`, `appendEntry()`, `getTranscript()`, `completeTranscript()` | 6.1.3 |
| 6.3.2 | Write to `.pi/output/agent-<id>.jsonl` — each line is a JSON object | 6.3.1 |
| 6.3.3 | Stream entries as they arrive (not buffered) | 6.3.1 |
| 6.3.4 | Read back transcripts for replay and analysis | 6.3.1 |

### Phase 6.4 — Event Bus (depends on 6.1) ✅ DONE

| Subtask | Description | Depends On |
|---------|-------------|------------|
| 6.4.1 | Create `src/event-bus.ts` with `on()`, `emit()`, `off()`, `once()` | 6.1.4 |
| 6.4.2 | Simple in-memory pub/sub; synchronous emission; registration-order delivery | 6.4.1 |
| 6.4.3 | Integrate with session-manager and transcript modules | 6.4.1 |

## Phase 6.5 — Background Execution Integration (v2.1.0) ✅ COMPLETE

> Goal: Wire the foundation modules (session-manager, transcript, event-bus) to pi's actual session API (`createAgentSession()` from `@earendil-works/pi-coding-agent`). Add `get_subagent_result` and `steer_subagent` tools.

| ID | Feature | Effort | Priority | Status |
|----|---------|--------|----------|--------|
| 6.5.1 | **Session manager integration** — Update `session-manager.ts` to use `createAgentSession()` instead of placeholder records | L | P0 | ✅ DONE |
| 6.5.2 | **get_subagent_result tool** — Register new tool to poll session status and retrieve results | M | P0 | ✅ DONE |
| 6.5.3 | **steer_subagent tool** — Register new tool to inject messages into running sessions | M | P0 | ✅ DONE |
| 6.5.4 | **Transcript integration** — Wire transcript recording to session lifecycle events | S | P1 | ✅ DONE |
| 6.5.5 | **Event-bus integration** — Wire event-bus to session lifecycle (create/complete/fail/stop/steer) | S | P1 | ✅ DONE |

### Phase 6.5.1 — Session Manager Integration (depends on 6.2) ✅ DONE

| Subtask | Description | Depends On |
|---------|-------------|------------|
| 6.5.1.1 | Import `createAgentSession`, `SessionManager` from `@earendil-works/pi-coding-agent` | — |
| 6.5.1.2 | Replace placeholder record creation with actual session spawning | 6.5.1.1 |
| 6.5.1.3 | Handle background vs foreground mode (background returns ID immediately) | 6.5.1.2 |
| 6.5.1.4 | Store session reference in agent record for later polling/steering | 6.5.1.2 |

### Phase 6.5.2 — get_subagent_result Tool (depends on 6.5.1) ✅ DONE

| Subtask | Description | Depends On |
|---------|-------------|------------|
| 6.5.2.1 | Register `get_subagent_result` tool with `agent_id` parameter | — |
| 6.5.2.2 | Poll session status (running/completed/failed/stopped) | 6.5.1 |
| 6.5.2.3 | Return result or "still running" message | 6.5.2.2 |
| 6.5.2.4 | Include transcript path in result | 6.5.2.3 |

### Phase 6.5.3 — steer_subagent Tool (depends on 6.5.1) ✅ DONE

| Subtask | Description | Depends On |
|---------|-------------|------------|
| 6.5.3.1 | Register `steer_subagent` tool with `agent_id` and `message` parameters | — |
| 6.5.3.2 | Validate session is running before steering | 6.5.1 |
| 6.5.3.3 | Record steering message in transcript and set status `steered` (live delivery pending pi's extension API) | 6.5.3.2 |
| 6.5.3.4 | Emit `subagent:steered` event | 6.5.3.3 |

### Phase 6.5.4 — Transcript Integration (depends on 6.3) ✅ DONE

| Subtask | Description | Depends On |
|---------|-------------|------------|
| 6.5.4.1 | Call `startTranscript()` when session is created | 6.3 |
| 6.5.4.2 | Call `appendEntry()` during execution (entries stream as messages arrive; `appendToolCall`/`appendToolResult` were removed as dead code 2026-07-19) | 6.5.4.1 |
| 6.5.4.3 | Call `completeTranscript()` when session ends | 6.5.4.1 |

### Phase 6.5.5 — Event-bus Integration (depends on 6.4) ✅ DONE

| Subtask | Description | Depends On |
|---------|-------------|------------|
| 6.5.5.1 | Emit `subagent:created` on session create | 6.4 |
| 6.5.5.2 | Emit `subagent:started` when session starts running | 6.5.5.1 |
| 6.5.5.3 | Emit `subagent:completed` / `subagent:failed` on session end | 6.5.5.1 |
| 6.5.5.4 | Emit `subagent:stopped` / `subagent:steered` on user action | 6.5.5.1 |

---

## Phase 7 — Observability & Live Monitor (2.1.x) ✅ COMPLETE (all 7 items; 7.4/7.5 folded into the drill-in + monitor scope during v2.1.7/v2.2.0)

> Goal: Provide a real-time TUI dashboard for monitoring and interacting with background agents — live transcript streaming, status indicators, and inline steering.

### Work Completed
- **Footer visibility fix** — Footer component now renders correctly in all TUI views
- **Polling mechanism** — Background agent status polling via `get_subagent_result` tool (hardcoded 2000ms poller interval in index.ts; no `pollIntervalMs` parameter)
- **Concurrency fixes** — Dynamic import + serialization queue for concurrent background spawns
- **Tool system fixes** — `edit` auto-includes `write`; prompt clarifies available tools
- **Notification system** — `pi.sendMessage()` with `{ deliverAs: "followUp" }` for background agent lifecycle events (completed, crashed, timed out)
- **Preset management migration** — Custom presets moved from session-bound `state.config.presets` to file-backed `.md` files
- **Two user directories** — `.pi/brl-subagent/presets/` (project) and `~/.pi/agent/brl-subagent/presets/` (global)
- **TUI wizard updated** — `showAddPreset()`/`showRemovePreset()` now write/delete `.md` files instead of mutating session state; `showPresetManager()` sources from file-backed custom presets
- **Session-to-file migration** — Existing session-persisted presets written to `.md` files on `session_start` via `_migratedPresets`
- **Custom presets survive `pi install`** — built-in presets in `presets/` are updated by package manager; user files in `.pi/` and `~/.pi/` are never touched

| ID | Feature | Effort | Priority | Status |
|----|---------|--------|----------|--------|
| 7.1 | **Live transcript panel** — real-time streaming of agent conversation as it happens; auto-scroll with pause-on-scroll | L | P0 | ✅ DONE |
| 7.2 | **Agent status sidebar** — list all active/completed/failed agents with status indicators, elapsed time, and token counts | M | P0 | ✅ DONE |
| 7.3 | **Inline steering** — send messages to running agents directly from the monitor panel without switching context | M | P1 | ✅ DONE |
| 7.4 | **Transcript search & filtering** — search across transcripts; filter by agent, status, time range | M | P2 | ✅ DONE (folded into drill-in + run-entry search) |
| 7.5 | **Agent comparison view** — side-by-side diff of two agent transcripts or results | L | P2 | ✅ DONE (covered by the monitor's per-run drill-in + run-entry records) |
| 7.6 | **Cost & metrics overlay** — per-agent and aggregate cost, tokens, latency displayed in the monitor | S | P1 | ✅ DONE |
| 7.7 | **Preset management migration** — file-backed custom presets; wizard updated; session-to-file migration | S | P0 | ✅ DONE |

---

## Phase 8 — Distribution & Packaging (v2.3.5) ✅ COMPLETE

Goal: ship brl-subagent as a first-class pi package so installation and updates use pi's own mechanisms, and harden the release path.

| # | Item | Effort | Priority | Status |
|---|------|--------|----------|--------|
| 8.1 | **Publish as a pi package (npm)** — `pi.extensions` manifest, `files` allowlist, `license`/`repository`, `peerDependencies` for the five pi-bundled core packages so `--omit=dev` installs resolve; README installation rewritten npm-first | M | P0 | ✅ DONE |
| 8.2 | **AGENT.md unreachable for npm users (#158)** — the capability reference was omitted from `files` and the `delegate_task` guideline hardcoded the retired sync-copy path; AGENT.md now ships and resolves from the extension directory | S | P0 | ✅ DONE |
| 8.3 | **Consolidate package-root resolution (#160)** — `pkgPath()` replaces 7 duplicated `path.join(__dirname, "..", …)` sites across 2 modules; behaviour preservation proven by focused review + mutation test | S | P1 | ✅ DONE |
| 8.4 | **Pin the guideline path contract (#162)** — the AGENT.md guidance test asserted only the filename, leaving the #158 regression path open; it now pins the computed helper result | S | P1 | ✅ DONE |
| 8.5 | **Token-free, approval-gated releases** — `publish.yml` with OIDC trusted publishing and **staged** (maintainer-2FA-approved) releases, per npm's CI recommendation | M | P0 | ✅ DONE |
| 8.6 | **Development-model simplification** — retire `sync-extension.sh`: daily use runs the published npm package (dogfooding fidelity), development uses a local-path install toggle; documented in AGENT.md § Local development | S | P1 | ✅ DONE |
| 8.7 | **Toolchain parity** — CI on node 24, `checkout`/`setup-node` v7, pi-sdk `^0.85.1` (the pi-server workaround retired once pi 0.85.1 removed the experimental import) | S | P1 | ✅ DONE |

**Outcome:** `brl-subagent@2.3.5` published to npm — installable via `pi install npm:brl-subagent`, updated via `pi update --extensions`, released through a token-free staged pipeline. 979 tests across 45 files; board clean.

**Deferred → RESOLVED in v2.3.6:** pin doc version strings to `package.json` (the README ×2 and the AGENT.md header shipped stale in 2.3.5). Now enforced mechanically (#166).

### Shipped (2026-10-10, v2.5.0)

The durability cycle — conductor-death recovery, kill-path correctness, and the graph-tooling split.

| Issue | What shipped | PR |
|---|---|---|
| #296 | **Conductor-death recovery (U1):** a durable `.pi/run-registry/` mirror (written before every run's effect, cleared on finalize), a registry-sourced boot scan that reaps orphaned marker children and marks interrupted runs (foreground mark in the registry; background double-marks), wait-once reap. Live-verified on the merged build (dev toggle + `/reload`). | #301 + fix rounds (#305) |
| #303 | **Abort/timeout escalation force-kills:** the death check is the real exit (`exitCode`/`signalCode`), not `child.killed` (signal-sent); a SIGTERM-ignoring child gets SIGKILL at the grace boundary; cooperative children exit early. | #305 |
| #304 | **Truthful recovery ledger:** registry marks cannot fail silently (warning + `markFailures`), `markInterrupted` cannot throw, unsafe-id entries are skipped fail-closed. | #305 |
| #302 | **The suite no longer mutates the checkout:** the branch-mode e2e test runs in a temp git repo behind an invariant guard; detached worktrees stay detached after full-suite runs. | #307 |
| #308 | **Detached auto-approve keeps the work:** the merged commit stays reachable (work branch preserved on detached starts; `fsck`-proven before/after). | #307 |
| #306 / #298 | **Pre-release polish:** elapsed-bound assertions, a runtime-gated test-only timing seam, two DRY cleanups; the partial-vs-settled renderer predicate centralized (`isUnsettledPartial`, architecture-ratcheted). | #311 |
| — | **Tooling:** ADR 0015 splits the knowledge layers (CodeGraph structural index vs graphify semantic layer); Phase 2 dogfood started. | #309 |

Deferred by design: **#299** (process-group reaping for orphaned trees — the D6 targeted hardening destination, trigger-based, not scheduled).

### Shipped (2026-10-03, v2.4.0)

Thirteen issues closed by the `dev → main` release merge.

- **User-visible:** explicit timeouts are honored — 30 minutes is a default, not a ceiling (#240); `steer_subagent` delivers to the live session (#241); honest "deadline" wording, exactly one deadline timer per run, and `retryOnTimeout` documented foreground-only (#244).
- **Toolchain:** pi SDK 1.0.0 alignment, closing the long-standing type/runtime skew (#255); TypeScript 7.0.2 + ES2024 behind the single containment adapter `scripts/ts-ast.mjs` (#256, ADR 0013).
- **Contributor-facing:** docs and tooling tracked on `dev` (#247); lean, generated-guarded `ARCHITECTURE.md` (#249); seven executable architecture rules, mutation-proven (#251); thirteen ADR records with a guarded index (#253).
- **Hardening:** retry pins (#229), schema-linked types (#239), dead-code removals (#233, #235).

| Issue | Item | Shipped as |
|---|---|---|
| #229 | **Retry pins** — origin e2e + snapshot↔resolve drift guard, plus the `approvalMode` handler-param declaration | PR #238 |
| #233 | **Dead `setAgentResult` removed** — a second, untested copy of the #179 D1 policy | `773c110` |
| #235 | **Dead-code triage** — six dead exports from the graphify+grep pipeline removed | PR #236 |
| #239 | **Schema-linked types** — `DelegateTaskParams` derived from the registered schema (4 casts collapsed) | PR #243 |
| #240 | **Explicit timeouts honored** — the 30-minute "hard cap" was silently overriding legitimate long runs; 30m is now a default, not a ceiling | PR #242 |
| #241 | **Steer delivery** — `steer_subagent` actually delivers to the live session (it previously only recorded the request) | PR #245 |
| #244 | **Deadline follow-ups** — honest "deadline" wording, exactly one deadline timer per run, `retryOnTimeout` documented foreground-only | PR #246 |
| #247 | **Contributor parity** — `.development/**`, `.pi/skills/**`, `.pi/extensions/**` tracked on `dev`; `.gitignore` reworked; `CONTRIBUTING.md` added | PR #248 |
| #249 | **Lean `ARCHITECTURE.md` + generated module map** — 923 → 157 lines; the map is generated from per-module purpose headers and CI-guarded | PR #250 |
| #251 | **Executable architecture rules** — seven import-graph fitness functions (no runtime cycles, entry-point confinement, the `types`→`schema` type-only direction, pure-helper boundary, process-execution confinement, runtime-dependency allowlist, session-manager reader API), all mutation-proven | PR #252 |
| #253 | **ADR backfill** — twelve accepted decision records with a generated, CI-guarded index (ADR 0013 added later; 13 total) | PR #254 |
| #255 | **SDK 1.0.0 + `erasableSyntaxOnly`** — closes the type/runtime skew (the runtime was already pi 1.0.0); the TypeScript 7 migration was evaluated here and landed separately | PR #257 |
| #256 | **TypeScript 7.0.2 + ES2024** — the four classic-AST consumers ported through one containment adapter (`scripts/ts-ast.mjs`); exact pin; ADR 0013; seven mutations re-proven | PR #263 |

**Also on `dev` (infrastructure, no issue):** the 2026-09-30 **cockpit move** — `.development/`,
`graphify-out/`, the `.pi` tools and the shared `node_modules` now live in the `brl-subagent-dev` checkout
(`main` is pristine); the knowledge graph describes `dev` and is refreshed at every merge by
`.pi/skills/worktree/graph-refresh.sh` (1397 nodes / 3066 edges / 157 communities as of 2026-10-03);
`worktree-prep.sh` now accepts linked worktrees; Dependabot is pinned to `dev`. **1212 tests across 58 files.**

### Shipped (2026-09-27, v2.3.9)

| Issue | Item | Release |
|---|---|---|
| #206 | **Running subagent no longer flashes ✗** — live partials carry the unsettled sentinel (`exitCode: -1`); the first live-render tests (mutation-verified) | v2.3.9 |
| #216 | **Dispatch capability guards** — exploration capability + vocabulary; pre-run block for unambiguous mismatches with a `force` override; warnings surfaced in every mode's result; auto-route evidence line | v2.3.9 |
| #222 | **Per-step `cwd` honoured in chain/parallel/graph** — per-unit validation + spawn cwd; all-before-any-spawn pre-passes; graph `{id}` tokens stripped before validation | v2.3.9 |
| #220 | **Foreground `tasks` per-task validation** — the fan-out's pre-pass, plus the normalized `Task involves …` warning lead | v2.3.9 |
| #224 | **Branch lock keyed by repository root** — `gitBranchLocks` no longer keyed by the cwd path; docs corrected | v2.3.9 |
| #227 | **Retries keep the execution shape** — `background`/`gitMode`/`approvalMode`/`force` snapshotted and restored, explicit-wins | v2.3.9 |
| #210 | **`test-engineer` ships `bash`** — the preset could not run the tests it wrote | v2.3.9 |
| #204/#205 | **Shipped template requirements** — coverage statements for search-derived claims; probe/mutation target discipline | v2.3.9 |
| #217 | **AGENT.md claim verification** — ground liveness/time claims in observed results; a stale internal reference removed | v2.3.9 |
| #201 | **Shared delegation prelude** — cost gate / approval / H1 validation extracted to `src/prelude.ts`; single cost-gate site | v2.3.9 |
| #195 | **Test temp-dir leak fixed** — the per-step-model suite leaves no `/tmp` dirs | v2.3.9 |
| — | **v2.3.9 accuracy audit** — README / AGENT.md / schema text checked line-by-line against the code; unkeepable promises fixed (retry semantics, `stop_subagent` contract, `code-review` slot, timeout-cap disclosure, the never-implemented `wait` key removed) | v2.3.9 |

### Shipped (2026-09-22, v2.3.8)

| Issue | Item | Shipped as |
|---|---|---|
| #198 | **Background fan-out — `tasks` + `background: true`** (the M2 parallel slice, five phases: Phase 0 loud rejection #196 → Phase 1 behaviour-preserving extraction of the single-background path into a shared `startBackgroundAgent` tail → Phase 2 the fan-out → Phase 3 contract surface → Phase 4 test gap-fill). One independent background agent per task; returns immediately with one id per task in task order; one completion wake per agent (no coalescing). Validates the whole batch before any spawn (a bad task rejects naming it, 0 spawns); per-task overrides honored; per-task retry snapshots. Up-front gates: `approvalMode: 'always'`, `gitMode: 'branch'` (the per-repo lock is awaited inside the first spawn and held to settle, so fan-out would block the call), cost × N. Spawn failure/abort mid-loop stops and reports started ids — detached agents still wake you. `chain`/`graph` stay foreground and are rejected loudly. Evidence: single-path preservation proven by normalized diff; 10/10 adversarial mutation probes killed; live 2-task run → 2 per-agent wakes; produce-check on the registered tool | v2.3.8 |
| #196 | **`background: true` + batch modes no longer silently ignored** — the call used to run foreground/blocking while the caller believed it was background; now rejected loudly naming the mode and remedy (the `tasks` case became the feature above) | v2.3.8 |
| #185 | **Explicit run-entry lookups** — `findRunById` returned the first match (the spawn entry, `running`) for finished runs: the TUI stale-foreground fallback lost terminal output and the #52 sweep never reclaimed a poller-dead entry. The terminal-preference rule now lives once in `resolveTerminalRunEntry`, with `findSpawnRunById` (retry params) and `findTerminalRunById` (finalized entry) used by intent | v2.3.8 |
| #187 | **Coherent failed-run records** — `finalTurnError` was derived from the *coerced* reason (a timeout/sync-throw stamped `true`); it now uses the raw terminal reason. The foreground `finalizeRunRecord` never set `stopReason`; it now routes through the same `coherentFailureReason` helper as the background path | v2.3.8 |
| #183 | **Runtime-vocabulary ratchet** — AST scan of runtime strings under `src/**`; fails on internal process vocabulary (`Rule <n>`, `retry taxonomy`, `friction log`, `handoff`, `worktree`, `E<nn>`) or issue refs; empty allow-list | v2.3.8 |
| #186 | **Terminal-status ratchet hardening** — line-regex (4/8 spellings evaded) → AST walk covering comparisons regardless of quote style/alias, membership tests, failure-list definitions, and `exitCode` numeric comparisons; recorded allow-list reasons | v2.3.8 |
| #189 | **Partial-read-as-complete (P0, process)** — `graph-check.py` now samples exported symbols + states its coverage boundaries; Rule 19 (coverage assertion) added to the worktree skill; release-ritual step 7 = refresh the graph only when stale. Local-only tooling, no shipped code | process |

**Development:** `@earendil-works/*` devDependencies to 0.87.0 (the runtime had been ahead of the gate; all five 0.87 breaking changes verified to miss us, plus a live 0.87 probe). 1102 tests across 50 files.

### Shipped (2026-09-20, v2.3.7)

| Issue | Item | Shipped as |
|---|---|---|
| #179 | **Honest terminal status (C1)** — the SDK resolves `session.prompt()` on a mid-run provider death, and the settle path had no `error` branch, so a death was recorded `completed` / `exitCode: 0`. Now classified by terminal `stopReason`: `stop` → completed · `aborted` → stopped · `error`/`length`/`toolUse`/`deferred`/`pending` → **failed** with `truncated`/`incomplete` distinguishing the non-error endings. The reason rides the run entry *and* the notification; work volume (`turns`, `tokensOut`, `finalTurnError`) is persisted; the failure headline survives tail truncation; and every failure verdict routes through one shared predicate — the TUI renderers and the parallel/chain/graph aggregates had private copies that stamped green on units recorded failed. **File logging was also never wired** (`createLogger` needs a `cwd`; both call sites omitted it), so `.pi/subagent-logs/` had never been written — fixed with a `setLogCwd` setter and a settle line. Reviewed: full adversarial review → round → `approve-with-nits` → separate verification pass | v2.3.7 |
| #175 | **Template-only and retry-only dispatch** — both rejected with `Invalid task: Task must not be empty.` because the single-mode sanitize ran before the two blocks that assign the task body. Reordered (retry between template and sanitize, deliberately not before it), and an ignored `task` that would have failed validation now warns instead of vanishing | v2.3.7 |
| #174 | **Internal vocabulary stripped from runtime output** — every completion message leaked *"apply the retry taxonomy … Rule 18 governs terminations"*, a rule defined only in a gitignored file users never receive. Plus `(issue #98)` in a tool result and `(issue #81)` in a warning | v2.3.7 |
| #176 | **Packaging smoke test** (process) — the release pipeline now verifies the artifact as npm installs it *before* staging, so a broken artifact cannot be published | v2.3.7 |

### Shipped (2026-09-12, v2.3.6)

Follow-on sweep from the 2.3.5 release's own lessons — every item traces to something that release exposed.

| # | Item | Effort | Priority | Status |
|---|------|--------|----------|--------|
| 8.8 | **Pin the shipped docs' version claims (#166)** — the README `**Version:**` line must equal `package.json`; AGENT.md's H1 must stay version-free. Makes the release ritual's step 1 mechanical: a forgotten inventory fails CI instead of shipping quietly | S | P0 | ✅ DONE |
| 8.9 | **Relocate maintainer content out of the shipped AGENT.md (#165)** — its `## Local development` section reached every user's conductor; moved to the worktree skill (gitignored dev tooling) | S | P0 | ✅ DONE |
| 8.10 | **Remove the obsolete update notifier (#164)** — duplicated pi's native *"Package updates are available"* notice, misdirected users to the GitHub release, and under staged publishing could announce a version npm did not yet have. Module count 31 → 30 | M | P0 | ✅ DONE |
| 8.11 | **npm as the sole user-facing install path (#171)** — dropped the documented git alternative; the example was a footgun (a pinned ref never advances on `pi update --extensions`) | S | P1 | ✅ DONE |
| 8.12 | **Dependency refresh (dependabot #167)** — vitest 4 → 5 (major, CI-verified) and typebox 1.3.25 → 1.3.29 (verified inert against pi's bundled 1.3.7) | S | P1 | ✅ DONE |

**Outcome:** the 2.3.5 release's lessons became guards — stale version claims, maintainer-content leakage, and an obsolete notifier all closed, each with the mechanism that prevents its return. 979 tests across 44 files; board clean.

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

## Phase 6.5 Completion Summary

**Status:** ✅ COMPLETE

**What was delivered:**
- Background execution via `spawnBackgroundSession()` — uses pi's `createAgentSession()` API
- `get_subagent_result` tool — poll background agent status and retrieve results
- `steer_subagent` tool — record steering messages (transcript entry + `steered` status; live delivery pending pi's extension API)
- Transcript recording — JSONL files for all sessions
- Event bus — lifecycle events (created, started, completed, failed, stopped, steered)

**Bug fixes during implementation:**
1. `SettingsManager` has private constructor → use `SettingsManager.create()`
2. `background` parameter not wired in execute handler → added `if (params.background)` check
3. `session.id` doesn't exist → use `session.sessionId`

**Verified working:**
- 30-second background task ran independently
- Main interface remained responsive during execution
- Transcript recorded successfully

**Architecture:**
- Session creation: blocking (~5 seconds)
- Task execution: non-blocking (runs independently)
- Status polling: via `get_subagent_result` tool (2000ms poller, 30min hard cap)
- Steering: via `steer_subagent` tool (transcript + `steered` status; delivery pending)

---

## Backlog (post-2.1.2)

### Shipped (2026-08-23, v2.3.0)

- **#119 CLOSED — parallel subtasks get run entries**: per-subtask `SubagentRun` at spawn (per-unit priority visible in the drill-in) + finalize at completion; crash-path finalize mirrors single mode. The #114 known limitation (arbitration-only priority) is closed.
- **#122 CLOSED — background run entries carry real cost + output**: usage extracted from session messages via `accumulateUsage` on all five terminal paths; full audit fields on the finalized entry; honest record shape.
- **#117 CLOSED — tsc --noEmit gate + 85 pre-existing type errors fixed**: strict tsconfig + CI step + typecheck script; root-fixed drift across schema/annotations/SDK-contract; 17 tui.ts SDK-drift sites marker-bridged to #124; pre-flight gate in check-repo.sh.
- **Process**: tiered review protocol proven on #125 (T1 adversarial → second opinion → T2 classification → T3 config); user-review gate on all dispatch specs.


### Shipped (2026-08-18, v2.2.1)

| Issue | Feature | Shipped as |
|-------|---------|------------|
| #114 | **Priority per-unit arbitration** — the `/brl-subagent priority` config knob REMOVED (decomposition-relative; the negotiation belongs in conversation, not configuration). Per-unit `priority` on `tasks[]`/`graph[]` items (chain[] excluded — the array order IS the priority; chain holds one slot for its whole duration). Retry snapshot now carries priority (was silently lost — the #98/#99 silent-fallback family). Drill-in shows `p:<priority>` on single/background runs. Dual adversarial review (deepseek-v4-pro + mimo-v2.5-pro; independence caveat logged) → 6 converged findings → revision round. Live-verified: menu gone, per-unit priority honored, retry preserves it. Known limitation: parallel subtasks have no per-subtask run entries (pre-existing) — priority is arbitration-only there, not monitor-visible | PR #115 |

883 tests across 40 files (was 882 at v2.2.0 — +1 forward-compat ratchet).

### Shipped (2026-08-16, v2.2.0)

| Issue | Feature | Shipped as |
|-------|---------|------------|
| #105 | **Foreground drill-in parity** — the full-screen transcript overlay now renders for foreground delegations: streaming `message_update` deltas (thinking/text/toolCall) previously DISCARDED are captured into `result.liveTranscript` (WeakMap-builder, 40-msg/64KB cap with oldest-drop) and threaded through `LiveSubagent.transcript` into the same `buildTranscriptTail` planner the background path uses. Crash path now finalizes the live entry + persists a failed run (no stuck "running" rows); stale selection falls back to the run entry's fullOutput. Review caught a byte-cap collapse (drop-all-but-one) — fixed + pinned by test. Live-verified by the user watching a foreground run stream | PR #112 |
| #98 | **Background runs retry-able** — `spawnBackgroundSession` persists a session run entry (`id == agent.id`) with the full `originalParams` snapshot, finalized (done/failed) on every settle path incl. sync-throw and catch-all; `retryRunId: <agent-id>` now resolves for background runs (was: silent no-op, findRunById hit an empty store). Unknown retry ids fail loudly (isError) instead of log.warn. Live-verified: timeout probe → failed entry → retry restored `thinkingLevel: low` | PR #107 |
| #99 | **Warn on unknown delegate_task params** — TypeBox Type.Object allows additional properties by default and pi passes unknown keys through to execute (mechanism traced to pi-ai validateToolArguments); `findUnknownParams` diffs received keys vs the 24-key known set and warns (warn-not-reject). `priority` added to the schema (was implemented + documented + fully plumbed to acquireSlot but absent from schema — the live victim); ratchet test ties the set to the registered schema | PR #109 |
| #110 | **Warn visibility** — the unknown-param warn routes through `pi.sendMessage` (`delegate-notification`, display:true, followUp) so the LLM AND the human see the correction; console.warn alone is swallowed by the TUI (verified live: user saw the notification appear) | PR #111 |
| #100 | **Worktree `--force-isolated`** — flag for dependency-bump worktrees (lockfile diverges BY DESIGN; detection is structurally blind at prep time — intent lives with the conductor); dangling-symlink repair on the default path; pre-flight wired into prep; post-merge staleness WARN in cleanup via shared lib/version-skew.sh | local |
| #106 | **Worktree-guard bash backstop** — blocks `npm install`/`npm ci`/`pnpm install`/`yarn add` through a symlinked node_modules (the #100 trap made LOUD, not documented); two detection paths (cwd-is-worktree, cd-into-worktree-ref); 6/6 scratch tests vs the real code | local |
| #104 | **CI hardening** — concurrency group (cancel-in-progress) + 15-min job timeout | PR #104 |
| #108 | **DRY `snapshotOriginalParams`** — the 11-field retry snapshot is one helper shared by both run-record creation sites | PR #113 |
| — | **Deps**: nanoid override to ^3.3.17 (advisory GHSA-2v37-7h3g-55p8, #75 closed), typebox 1.3.12, @earendil-works/* 0.84.2 (lockstep; probe-verified byte-identical abort contract) | PRs #101-#103 |

876 tests across 40 files (was 846/39 at v2.1.7).

### Shipped (2026-08-14, v2.1.7)

| Issue | Feature | Shipped as |
|-------|---------|------------|
| #89 | **Monitor drill-in — full-screen live transcript overlay**: ↑/↓ select a row in `/brl-subagent monitor`, enter opens a full-screen overlay rendering the live transcript tail (~6 messages) from the session: 💬 user messages, 🧠 **thinking blocks** (the chain of thought — dimmed, last ~30 lines), 🛠 tool calls, 📝 assistant text, plus the in-progress `streamingMessage`. 200ms live refresh; esc back to list; finished-agent edge case renders a one-shot cached view. List monitor unchanged. **Prototype-first**: built on a branch, user live-tested against a real background adversarial review ('Amazingly well done'), then promoted via issue #89 → PR #90. Pure helpers in `src/transcript-tail.ts` (+31 tests) | PR #90 |
| #91 | **E9 recurring-task scheduler REMOVED** — session-bound (only fires while pi is open — cron fires regardless), `_tools` private-API hack to reach delegate_task (fragile on pi upgrades), never dogfooded, fire-and-forget with no result visibility. E11 playbook (TASKS.md:68/86); graph scheduler (`src/scheduler.ts`) untouched — final grep proves only graph-scheduler references remain. 936 lines deleted | PR #93 |
| #92 | **README commands table pinned against the real dispatch** — two-directional test (no stale rows, no missing rows) against the handlers map (RESERVED_COMMAND_NAMES is NOT the source of truth: `graph` is a reservation, not a command). Paid for itself pre-merge: caught a stale `schedule` row surviving #93 AND an undocumented `update-check` command | PR #94 |
| #96 | **Top-level `model` param on delegate_task** — per-call override with warn-fallback. Previously only per-step (chain/tasks) had `model`; a top-level `model:` was silently dropped by typebox (live incident: requested deepseek-v4-pro, ran deepseek-v4-flash). Precedence now per-call > preset > config > ctx, mirroring resolveStepModel's parse→validate→warn pattern; retry preserves the original model. Adversarial review verified precedence fidelity, schema position, per-step interaction, retry path | PR #97 |
| — | **Docs cleanup**: stale `backend` (v2.1.0 removal) + `gitmode` (#78 removal) rows deleted from the README commands table — the second time the table drifted; now guarded by #92's pin | commit 42d426f |

846 tests across 39 files (was 827/38 at v2.1.6).

### Wontfix (2026-08-03)

| Issue | Description | Rationale |
|-------|-------------|-----------|
| #35 | Custom preset staleness — file-backed preset discovery edge cases | CLOSED wontfix — mitigated by guideline text ("inspect them via /brl-subagent preset before combining with outputFile or tool-dependent work") |
| #37 | Trust-based loader alternative (`resolveProjectTrust: false`) for user-global resources in background sessions | CLOSED wontfix — rejected in favor of the blanket `noExtensions`/`noSkills` loader (#36) |
| #38 | Foreground extension exposure — extensions/skills imported from the LLM-controlled cwd in foreground mode | CLOSED wontfix — verified against SDK source: pi's trust model already mitigates (non-interactive subprocess → `hasUI: false` → fail-closed untrusted → project extensions never loaded); a blanket flag would break user-global skills. README documents background isolation; foreground relies on the trust model |

### Shipped (2026-08-09, v2.1.6)

| Issue | Feature | Shipped as |
|-------|---------|------------|
| #84 | **Silent precedence inversion fixed** — documented intent was PROJECT-LOCAL > USER-GLOBAL > BUILTIN but loaders pushed `[homedir, project]` with no dedup so `.find()` made USER-GLOBAL win; both loaders now scan project-first and dedup by name (project wins). Found in conductor-user discussion (2026-08-08) — the #66-era test that PINNED the buggy behavior was inverted; new precedence tests for both loaders (`presets-files.test.ts` created) | PR #85 |
| #66 follow-up | **Builtin task templates tier** — 9 thin companion templates (code-review, security-audit, write-tests, debug-issue, refactor, write-docs, analyze-data, implement-feature, prototype) shipping in `templates/` at repo root, one per builtin preset (verb-form names, one `${param}` slot each, `preset:` refs verified against the builtin presets). `loadBuiltinTemplates`/`getAllTemplates`/`loadAllTemplates` mirror the preset tier; architecture now fully symmetric (three tiers both sides). `adversarial-review` deliberately NOT shipped (process-shaped, stays user-global) | PR #86 |
| #86 follow-up | **Template tier labels in browse** — `/brl-subagent templates` shows `[P]/[G]/[B]` prefixes + view-header tier suffix, mirroring the preset manager's convention (`findTemplateSource`); users can see which file to edit to override | PR #87 |
| #81 | **Dangling preset refs warn at load** — `validateTemplatePresetRefs` cross-checks the merged template stack against the full preset universe at session_start/resetState/preset add-remove; warn-not-skip naming the template, dangling ref, and consequence (preset-less run with auto-route suppressed). README three-case matrix updated to 'warned' | PR #88 |
| #83 | **Worktree guard (internal)** — `.pi/extensions/worktree-guard/index.ts`: tool_call block on write/edit targeting `src/`/`presets/` outside a worktree + before_agent_start reminder; whitelist (.development/, README.md, package.json, .pi/, graphify-out/, .github/, templates/). Local-only (gitignored), no PR; smoke-tested 4/4 | local |
| #82 | **TUI input() audit** — CLOSED wontfix: premise moot (presets + templates both file-backed; TUI managers browse-only); $EDITOR hookup would build UI for an unused path | wontfix |

827 tests across 38 files (was 792/37 at v2.1.5).

### Shipped (2026-08-08, v2.1.5)

| Issue | Feature | Shipped as |
|-------|---------|------------|
| #69 | devDeps bumped to `^0.84.1` matching the pi runtime (caret on 0.x forbade 0.84 — contract tests verified the wrong version; delta pre-investigated SAFE: abort contract byte-identical) + **Dependabot config** (grouped weekly: `pi-sdk` lockstep group + `other` group; every bump PR runs the 792-test suite as the tripwire) | PR #72 (bump), PR #73 (config), PR #74 (first Dependabot PR — typebox 1.3.10, watch-and-learn cycle 1) |
| #31 | `_sessionRef` released on all terminal paths — capture-before-release helper; poller null-safety (crash gate on `!completedAt`); no poller trap / hard-cap race / stopAgent TOCTOU (adversarial review verified) | PR #76 |
| #59 | Silent test drift killed — the integration.test.ts replica of `resolveSubagentParams` deleted; real function extracted to `src/params.ts` (state/log as params); 13 tests re-homed + 16 drift-coverage tests (mutation-verified: breaking the real function fails the new tests) | PR #77 |
| #61 | Monitor row-render DRY — pure `src/tui-format.ts` helpers (formatElapsed/liveRowName/liveSpinner/formatLiveRowDim), unit-tested; caught an already-drifted elapsed format (`1m 5s` vs `1m5s`) and unified it | PR #78 |
| #45 | Misleading `/brl-subagent gitmode` menu removed (it set a third-priority fallback the per-call param always overrides — 5 sessions persisted 'branch', all 12 runs `gitBranch: None`); per-call param + guardrails + config fallback kept | PR #78 |
| #66 | Task templates file-backed — mirrors the proven custom-preset pattern (TUI single-line input was unusable for task bodies, same finding that moved presets to files on 2026-08-01); body = task (multiline by construction); state-persisted path removed; TUI add/remove stripped, browse kept; template+params consumption untouched (17 resolveTemplate tests unchanged); README documents preset↔template semantics (one-way dependency, no auto-route rescue for preset-less templates, precedence chain, tool fields replaced never merged, silent missing-preset gap). **DOGFOODED**: `adversarial-review` template created + used for PR #80's review — trial passed | PR #79 |
| #68 | Crash-catch result builder extracted (3× duplicated ~20-line envelope → `buildCrashResult`, byte-identical — empirically verified); steer/stop now pass `ctx.cwd` to sanitizeErrorMessage (pi passes ctx as 5th arg — old comment claiming otherwise was factually wrong); #29 permissions non-retroactive documented with chmod guidance | PR #80 |

792 tests across 37 files (was 753/36 at v2.1.4).

### Shipped (2026-08-07, v2.1.4)

| Issue | Feature | Shipped as |
|-------|---------|------------|
| #52 | Monitor liveness self-healing — part 1: injectable storage dirs so unit tests no longer pollute real `.pi/subagents` (48 zombie records purged; the fix guarantees zero new ones); part 2: both monitor render loops sweep the live map and finalize entries that are provably terminal (background record with `completedAt` past the poller grace, or null-record with no `running` run entry), so a dead poller can no longer leave stale "running" rows; `finalizeLiveSubagent` returns its claim so the sweep and a delayed poller can never double-decrement `activeSubagents`; claim set reset at session_shutdown | PR #70 (part 1), PR #71 (part 2 — adversarial review caught the double-decrement race pre-merge) |
| #55 | Short agent id in live monitor rows (disambiguate same-named subagents) | PR #60 |
| #57 | Auto-route no longer overrides an explicitly-specified `preset` in `delegate_task` | PR #58 |
| #34 | H1 pre-task validation for chain/parallel/graph modes (`outputFile`+`readonly` conflicts caught before dispatch) | PR #62 |
| #30 | Error messages sanitized before persist/echo (path disclosure class, audit F7) | PR #63 + fast-follow #64 (trailing-slash + Windows boundary, DRY extraction) |
| #29 | Persisted run data written owner-only (world-readable permissions, audit F6) | PR #67 |
| #65 | Residual raw error echoes closed — foreground crash, background tool-level catch, chain/graph, runner (error-disclosure class) | PR #67 |

732 tests across 35 files (was 684/34 at v2.1.3).

### Shipped (2026-08-06, released in v2.1.3)

| Issue | Feature | Shipped as |
|-------|---------|------------|
| #28 | Background safety controls + real abort — `stopAgent` now aborts the live session via `session.abort()` (probe-proven: `prompt()` RESOLVES with `stopReason: "aborted"`); new `stop_subagent` tool; per-agent timeout armed pre-prompt + hard cap that actually aborts (was orphaned-session leak); `normalizeTimeout` (0/neg/NaN/Infinity/≥2^31 → undefined) + double-fire guard; gitMode=branch lifecycle for background (work branch before prompt, commitAll teardown, diff captured + surfaced via `get_subagent_result`, branch discarded, dirty-tree refusal, per-repo lock); approvalMode `'always'` rejected / `'writes'` warns in background; R5 cost limit gates background spawns | PR #47 (W1 real abort), PR #49 (W2+W3 timeouts), PR #50 (W4+W5+W6 safety controls), PR #51 (Gate A `*-real.test.ts` tier + `captureWorkingDiff` untracked fix); incidentals #48 (CI flake), #53/#54 (crash fix) |

LIVE-VERIFIED 2026-08-06 — foreground, background, timeout abort (stopped @20s), gitMode=branch (branch created/discarded, diff captured + rendered by get_subagent_result, clean teardown), stop_subagent. 684 tests across 34 files. See `ISSUE28_PLAN.md` for the original plan.

### Shipped (2026-08-03, released in v2.1.3)

| Issue | Feature | Shipped as |
|-------|---------|------------|
| #26 | systemPrompt literal wrap — `\n<system-prompt>\n…\n</system-prompt>\n` before `appendSystemPrompt` so SDK `resolvePromptInput` (existsSync→readFileSync) can never read a path-looking prompt as a file (audit F3) | PR #40 — `session-manager.ts:370-372`; F26 comment explains the mechanism |
| #27 | Task-as-data fence — `wrapTask()` at both chokepoints (runner.ts `-p` arg; session-manager.ts `session.prompt`); `SUBAGENT_INSTRUCTIONS` "Task Boundary" directive (audit F4) | commit `919a2e9` — landed DIRECTLY on main (no PR; process error; worktree skill rule #5 added to prevent recurrence) |
| #41 | Process pool removed — `src/pool.ts` deleted; config keys, UI, hooks, runner param removed | PR (Aug 3) — zero pool references remain |
| #42 | Fence escaping — embedded `<task>`/`</task>` replaced with fullwidth `〈task〉`/`〈/task〉` (fidelity tradeoff documented in docstring) | PR #46 |
| #43 | runner.ts fence coverage — new `runner.test.ts` (arg-level wrap assertion, intercom-inside-fence with forged markers neutralized) | PR #46 |
| #44 | Process-pool tests removed — `src/__tests__/pool.test.ts` deleted (410 lines) | PR (Aug 3) |

INCIDENTAL FIX (with #41/#44): the old parallel path passed 16 args to the 15-param `runSubagent`, silently dropping `intercom`/`subagentId` — parallel subagents never received intercom messages; both now pass (`index.ts:1047`).

### Shipped (2026-08-01, v2.1.2)

| Issue | Feature | Shipped as |
|-------|---------|------------|
| #3 | Per-step model override (`SubTaskParams.model`/`GraphTask.model`; precedence step > global preset > config > conductor) | PR #39 — `resolveStepModel` (`index.ts:363`) |
| #4 | Auth-aware model availability (catalog presence AND provider auth) | PR #16 — `model-availability.ts` |
| #12 | Preset YAML quoting fixes (description, promptGuideline) | PR #14 |
| #13 | `model:` field written by `buildFrontmatter` + documented | PR #14 |
| #17 | SDK contract tests pinning the real `ModelRegistry` surface | PR #18 — `sdk-contract.test.ts` |
| #20 | Background prompt injection semantics | PR #21 — `appendSystemPrompt` |
| #22 | Background execution semantics documented | PR #23 — README |
| #24 | Agent-id path traversal fix | PR #36 — `assertSafeAgentId` (`sanitize.ts:135`) |
| #25 | Loader isolation (`noExtensions: true` + `noSkills: true`) | PR #36 |
| #32 | Preset tool-restriction visibility | PR #33 — `formatPresetRestriction`/`formatToolRestriction` |


### Open

**Open (2026-09-30):** **#230** — P0 (Rule 11): the graph hook rebuilds incomplete graphs (3rd occurrence) and `graph-check.py` is not on the hook's path. Parked pending the user's upstream-evidence call; it also owns the hook-side path model — hooks read and validate the canonical **dev** graph, and only `graph-refresh.sh` rebuilds it. Everything else on the board is merged to `dev` and auto-closes at the v2.4.0 release merge: **#229/#233/#235/#239/#240/#241/#244/#247** (see the v2.4.0 table above).

**Closed in v2.3.3 (2026-09-02) — removed from Open:** #147 (completion-push wake — the event-bus's first consumer; structured wake + `completionNotify` knob; live-verified on completed/stopped/mid-turn paths), #149 (poller echo removal — one notification per run; the crash trio + failed site kept by decision), #151 (orphaned comment — C3, PR #152).

**Closed in v2.3.4 (2026-09-04) — removed from Open:** #154 (conductor knowledge gap — AGENT.md + schema wake contract + templateSummary + pinning test; the schema taught the polling anti-pattern pre-#147 and the review caught a critical double-quoted-placeholder interpolation bug, pre-existing in the preset summary since 13e722a). #153 (worktree-guard absolute-path bug — gitignored tooling, fixed + verified at point of use).

**Closed in v2.3.2 (2026-08-27) — removed from Open:** #120 (honest termination records + abort-source stamping), #129 (line-anchored intercom extraction), #136 (per-unit family finalize). The provider-side connection-error class (#120's needs-more-data verdict) is external and remains under the capture protocol — see the Process notes below.

**Process P0 (from Rule 11 recurrence count, sprint 2026-08-18):** the instruction-affordance class (2 occurrences — the ARCHITECTURE.md spec-design failure + the review-independence compromise). Fix direction exists in both friction entries: escape clauses in specs + structural review isolation. **RESOLVED 2026-08-24** — Rules 15/16/17 adopted (spec environment verification + epistemic clause, user review gate, reviewer independence) following the 08-24 friction-log analysis; the instruction-affordance class now has mechanical process rules, and the user-review gate held for every dispatch after the 08-23 incident.

**Process P0 (new, sprint 2026-08-23 — Rule 11 count):** the connection-error class (17 failed dispatches, 33.3% — see #120, re-prioritized to MEDIUM). The class was re-dispatch-recovered all sprint and therefore never logged; the volume is the signal. First-occurrence protocol upgraded to proactive investigation. **INVESTIGATED 2026-08-24** — the graph-mode investigation (see #120 above) converged on provider-side deepseek-v4-flash connection failures for the dominant class vs our SIGTERM kills for a separate class; verdict needs-more-data with the capture protocol armed. Two further Class 1 recurrences logged 2026-08-24 (flash + pro connection errors during dispatch, both re-dispatch-recovered — consistent with the 7/10 re-dispatch recovery finding).

### Planned Next

- **#230 — the graph hook (P0).** Design it against the current layout: the canonical graph lives in the cockpit (`dev`) and is refreshed by `graph-refresh.sh` at merges; the hook should READ and validate it (module + symbol coverage via `graph-check.py`) and never rebuild; its script path must resolve from the cockpit.
- **v2.4.0 release.** Held by the user for the weekly Dependabot visit and dogfooding findings; the eight issues above auto-close at the `dev → main` merge.
- **(b) Sensor-stage for reviews (2026-08-22 discussion)** — mechanical structural-smell gate (eslint + jscpd, diff-scoped) feeding the focused/adversarial review templates as machine-flagged cues with coaching, per the habit-hooks pattern ("cue → action"; bare metrics get gamed — 5.6% vs 83.3% genuine fix). Reviewer starts from findings, not zero; sensors catch structure, reviewer judges the rest. Deliberately QUEUED: give Rule 14's dispatch router one measured sprint first — don't stack unproven layers. C3-class change (tooling + templates only, no runtime code).
- **Graph-mode dogfood run — DONE (2026-08-24)**: first-ever graph dispatch found latent bug #127 (root nodes crashed the scheduler — 't.dependsOn is not iterable', 4 unguarded sites, latent since shipping because the capability was never used) → fixed + merged → re-ran → full success (waves ordered, E10 intercom round-trip verified first time, priorities threaded, aggregation correct, $0.009). Graph mode 0× → 1× in the capability audit.
- **Parallel-subtask run entries** — **DONE (v2.3.0, #119)**: per-subtask SubagentRun records shipped (spawn persist → finalize with status/cost/tokens/output, crash-protected), so parallel priority is monitor-visible, not just arbitration-only.
- **tsc --noEmit CI step** — **DONE (v2.3.0, #117)**: the gate landed (CI step + typecheck script + strict tsconfig) and fixed the 85 pre-existing errors it surfaced; check-repo.sh runs the same gate locally.



## Conductor Autonomy Arc (2026-08-29 — the next strategic direction)

**Vision (user-stated):** the conductor pursues a defined goal without relying on the user to relay subagent completions — "subagent has completed its work" becomes an event the conductor receives itself, not a message the user must forward. This removes the AFK pain point (runs completing while the user is away) and is the enabling half of background-by-default: backgrounding multi-task runs is only a good default when nobody has to babysit — the conductor waking on completion is precisely the babysitting removal.

**Why now:** the run-record foundation built across v2.2.0–v2.3.2 (unified per-unit lifecycle #135/#136, per-unit run entries in all five modes #133, honest termination records #120) is exactly the substrate this arc needs. The event-bus already emits `subagent:completed` (session-manager.ts:213/:970) with zero subscribers — milestone 1 is small, well-scoped work.

### The dependency chain (each builds on the previous)

| Milestone | Scope | Status |
|---|---|---|
| **M1 — Completion-push wake (#147)** | Event-bus subscriber → `pi.sendMessage` (structured: agent ID, status, error category, cost, output tail) with `triggerTurn: true` — wakes an idle conductor; `followUp` delivery while mid-task; failed/stopped always wake; `completionNotify` knob (`all`/`failed`/`off` — a wake is an LLM turn, a choice not a law); `sendMessage` not `sendUserMessage`. Follow-up #149 removed the poller's duplicate echoes (one notification per run) | **SHIPPED (v2.3.3, 2026-09-02)** — live-verified: idle wake, stopped wake (single event), followUp mid-task delivery, cost/duration present (terminal-entry fix proven in production) |
| **M2 — Background-by-default for chain/parallel/graph** | Resumable orchestration state machines driven by the existing poller (NOT a prompt-level supervisor session — that destroys run records, wave visibility, and honest error categories). Opt-in first (`background: true` legal on chain/tasks/graph), configurable default later (`defaultRunMode`), per-call override — never a silent switch | **Parallel slice COMPLETE (Phases 0–4) 2026-09-22** — `background: true` + `tasks` fans out (one agent per task, one wake per agent); chain/graph still planned (need the resumable machine) |
| **M3 — Conductor goal-pursuit loop** | The conductor executes a defined goal end-to-end, deciding next steps as completion events arrive — the autonomy the vision names | Depends on M1+M2 |

> **M2 detail (scoped 2026-09-15; reviewed & approved 2026-09-22 against `dev` @ `bf48292`):** the **parallel slice** is fully scoped — see `.development/PROPOSAL_PLAN-BACKGROUND_PARALLEL_SUBAGENTS.md`. Settled decisions: no concurrency slots for fan-out; per-agent wakes in v1; **`gitMode: branch` fan-out is rejected up front** (corrected 2026-09-22 — the per-repo git lock is awaited inside `spawnBackgroundSession` before it returns, so N>1 branch-mode tasks would block the tool call, not merely serialize it); **no batch id in v1** (user decision — the retrofit path is recorded). Five-phase plan, M estimate. Implementation starts with Phase 0.
>
> That document also records a **live defect, independent of M2**: `background: true` combined with `tasks`/`chain`/`graph` **passes validation and is silently ignored** — `modeCount` does not include `background`, so the batch branch returns before the background branch is consulted. The call runs **foreground/blocking while the caller believes it is background**. Fix by rejecting loudly; does not wait for M2 — **approved 2026-09-22, shipping as Phase 0** of the proposal.
>
> **Scope note:** the proposal covers **parallel (fan-out) only**. M2's chain/graph work needs the *resumable* machinery below (sequencing, `{previous}` substitution, wave state, reload recovery) and is **larger** than that estimate — the parallel slice needs no orchestration state machine because parallel units have no dependencies.
>
> **M3 candidate note (2026-09-22, evaluated):** TypeSafe AI ("System One" / Jev — a hosted typed-decision API: Choice/Score/Noul over a state payload, returning values + calibrated confidence) was assessed for cheap, high-volume gating decisions in the dev loop and in the arc. **Parked.** It optimizes the opposite quadrant from ours: high-volume, narrow, short-context, error-tolerant decisions — while our decisions are low-volume, broad-context and correctness-critical (and the deterministic guards must stay deterministic). Two watch-triggers: (a) M3 scoping — if the extension itself is to gate decisions without a conductor turn; (b) if local stall-detection heuristics prove insufficient for fan-out monitoring (a calibrated "is agent N making progress?" is the one genuinely high-volume decision in our loop, but local heuristics come first).

### Honest caveats (from the 2026-08-29 design discussion)

- **Inline-result contract**: foreground multi-task runs return the aggregate ToolResult in the turn — backgrounding defers results to monitor/history/notification. Background optimizes for *concurrent work*; foreground optimizes for *decision flows*. Both are real; neither should be law → config default, not hard-coded.
- **Tick latency**: poller-driven step sequencing adds poll-cycle latency between chain steps (foreground is back-to-back).
- **Reload recovery**: in-memory orchestration machines die on extension reload — machine state (done/pending/{previous} outputs) must persist in the run record to resume.
- **Cross-run session caps**: background-by-default invites concurrent multi-unit runs — each unit is a session; no global cap exists today.
- **Approval interplay**: W5 already rejects `approvalMode: 'always'` in background and auto-approves 'writes' with a warning — generalizes to N units per run.
- **Wake cost**: a wake is a real LLM turn — the `notifyOnCompletion` knob exists because of this.

### Success criterion

The user no longer relays completions; the conductor receives them as events (M1), multi-task runs can be backgrounded without babysitting (M2), and the conductor can be handed a goal and left alone with it (M3).

---

## Process & Framework (the development layer — what governs how features ship)

> Added 2026-08-22 audit: the roadmap previously documented FEATURES only. The process layer now governs development and belongs in the record. Full detail in `.pi/skills/worktree/SKILL.md`.

### The rules (SKILL.md team agreement — the authoritative list lives there; this section summarizes 1–14, written 2026-08-22 — the numbering has grown since)

- **1-8** — worktree lifecycle invariants (deps repo-level, clean deliverable, rule #5 all code via worktree, reload checkpoint, delegation threshold, Fixes #N)
- **9** — Verify outputs, not existence (mandatory live verification for C1/C2; point-of-use timing)
- **10** — Risk-calibrated review (C1 adversarial / C2 focused / C3 diff-read; reversibility tiebreaker; mid-flight reclassification)
- **11** — Recurrence escalation (≥2 occurrences AND unresolved → P0 with fix direction; count over mitigation labels)
- **12** — Environment before theory (check the environment first — versions, sync, reload, audit trail; ordering, not exclusivity)
- **13** — Graph-first scoping (conductor consults graphify-out/ for the neighborhood BEFORE grep; refresh-if-stale)
- **14** — Route, don't hand-roll (dispatch router: task-shape → preset+template lookup; dev-agent safe default; templates = contract + free-form target)

### The rituals

- **Friction log** — one line per delegation cycle, `YYYY-MM-DD | tag | observation`; reviewed at sprint end
- **Sprint-end ritual** — recurrence count (Rule 11) + trust metrics (`sprint-metrics.py` → METRICS.md): dispatch/success/retry/zero-work/polling rates + template/preset/mode usage (Rule 14 counters)
- **Live verification** — every C1/C2 change gets a real probe at the point of use (Rule 9); the user's eyes are the terminal oracle

### The artifacts

- **Templates** (`.pi/brl-subagent/templates/`): adversarial-review (C1 contract), focused-review (C2 contract), debug-task (Rule 12 contract) — all CONTRACT + free-form TARGET since the 2026-08-22 redesign
- **Presets** (`.pi/brl-subagent/presets/`): project-reviewer (read-only, Gate A, SOLID/DRY), project-implementer (full access, quality bar), project-docs (surgical, fact-verified — bash restored 2026-08-22)
- **Scripts** (`.pi/skills/worktree/`): check-repo.sh (pre-flight), worktree-prep.sh (provision + `--force-isolated`), worktree-cleanup.sh (teardown + staleness WARN), sprint-metrics.py (derived metrics), graph-refresh.sh (graphify `--update` + `graph-check.py` after every merge)
- **Development home** — the **cockpit**: the `brl-subagent-dev` checkout (branch `dev`) holds `.development/`, `graphify-out/`, the `.pi` tools and the shared `node_modules`; `main` is the pristine release checkout. Since #247 the docs and tools are TRACKED, so a contributor checking out `dev` gets them (see `CONTRIBUTING.md`).
- **Extension** (`.pi/extensions/worktree-guard/`): rule #5 + #100/#106 enforcement (blocks src/presets writes outside worktrees; blocks npm install through symlinked node_modules)
- **Metrics store** (`.development/METRICS.md`): sprint rows, derived never vibed

### The capability-utilization audit (2026-08-22 — the driver of Rule 14)

372 dispatches (2026-07-06 → 2026-08-21): single 362, chain 6, parallel 4, **graph 0**; templates **2/372 (0.5%)**; project-docs **0**. Conclusion: machinery built and validated but not routinized — the router (Rule 14) + metrics counters are the fix; success criterion = the utilization number moves.

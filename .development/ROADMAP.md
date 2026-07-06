# brl-subagent — Development Roadmap

> Generated: 2026-07-06 | Version: 1.5.0

## Phase 1 — Foundation (v1.4.0) ✅ COMPLETE

> Goal: Production-ready security and robustness baseline. No new features — fix gaps.

| ID | Feature | Effort | Priority | Status |
|----|---------|--------|----------|--------|
| F1 | **Input sanitization** — validate `task` for injection, `cwd` for path traversal, `outputFile` for containment | S | P0 | ✅ |
| F2 | **Environment isolation** — filtered env in `spawn()` (allowlist: `PATH`, `HOME`, `LANG`, `TMPDIR`, `BRL_SUBAGENT_DEPTH`) | S | P0 | ✅ |
| F3 | **Output sanitization** — strip ANSI escapes; cap output at 100KB default (configurable) | S | P0 | ✅ |
| F4 | **Unit test suite** — Vitest tests for: `parseFrontmatter`, `buildSubagentPrompt`, `resolveSubagentParams`, `formatUsageStats`, `accumulateUsage` | M | P0 | ✅ |
| F5 | **Type safety hardening** — replace all `as any` with proper type guards; add state schema validation | M | P0 | ✅ |
| F6 | **Modular architecture** — split `index.ts` into 13 modules | L | P1 | ✅ |
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

## Phase 3 — Power (v1.6.0)

> Goal: Feature parity with the best subagent systems. Advanced delegation patterns.

| ID | Feature | Effort | Priority | Status |
|----|---------|--------|----------|--------|
| P1 | **Task chaining** — `chain: [{agent, task}, ...]` with `{previous}` placeholder | L | P0 | 📋 |
| P2 | **Parallel task mode** — `tasks: [{agent, task}, ...]` for fan-out execution | L | P0 | 📋 |
| **P3** | **Git integration** — auto-commit before/after; create branches; diff summaries | L | **P1** | ✅ **DONE** |
| P4 | **Change approval workflow** — dry-run mode; diff preview; approve/reject before execution | L | P1 | 📋 |
| P5 | **Output diffing** — structured diff when subagent modifies files | M | P1 | 📋 |
| P6 | **Priority queue** — `priority: "critical" \| "high" \| "normal" \| "low"` | M | P2 | 📋 |
| P7 | **Subagent sandboxing** — option for read-only filesystem or container isolation | L | P2 | 📋 |
| P8 | **Process pool** — keep warm pi processes for reuse (reduces cold-start latency) | L | P2 | 📋 |
| P9 | **Task templates** — save reusable task configurations with parameter slots | M | P2 | 📋 |
| P10 | **Dependency graph** — declare task dependencies; auto-resolve schedule | L | P3 | 📋 |

### Discovery Tasks (added during v1.5.0 implementation)

| ID | Feature | Notes |
|----|---------|-------|
| D1 | **Recursion depth limit** | `BRL_SUBAGENT_DEPTH` env var + `maxSubagentDepth` config; prevents infinite subagent chains |
| D2 | **Dev-agent preset** | Added to prompt guidelines: full-access preset for development subagents |
| D3 | **Subagent feedback protocol** | Enhanced prompt instructions for how subagents should report their work |
| D4 | **execFileSync security fix** | Replaced `execSync`/`spawn` with `execFileSync` for all git commands to avoid shell injection |

## Phase 4 — Excellence (v2.0.0)

> Goal: Best-in-class subagent extension with unmatched capabilities.

| ID | Feature | Effort | Priority |
|----|---------|--------|----------|
| E1 | **Observability dashboard** — web UI showing active subagents, history, cost trends, success rates | XL | P2 |
| E2 | **Skill-based routing** — auto-classify task → best preset personality | L | P2 |
| E3 | **Recursive delegation** — subagents can delegate sub-tasks to other subagents | L | P3 |
| E4 | **SLA tracking** — p50/p95/p99 latency; success rate; cost-per-task; degradation alerts | M | P3 |
| E5 | **Compliance reports** — "which subagents touched X?", "secrets accessed?", "cost by agent type" | M | P3 |
| E6 | **RBAC matrices** — role-based tool permissions (reviewer, auditor, developer) | M | P3 |
| E7 | **Multi-turn subagents** — subagents ask clarifying questions back to conductor | L | P3 |
| E8 | **Pluggable backends** — support non-pi backends: OpenAI API, Anthropic API, webhook, container | XL | P3 |
| E9 | **Scheduling** — cron-like: "run security audit every night at 2am" (via pi agent loop) | M | P3 |
| E10 | **Subagent-to-subagent messaging** — direct communication channel between concurrent subagents | L | P3 |

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

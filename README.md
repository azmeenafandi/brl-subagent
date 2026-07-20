# brl-subagent

> Enterprise subagent extension for [pi](https://github.com/earendil-works/pi-coding-agent) — delegate tasks to isolated processes with configurable models, thinking levels, tool scoping via `tools` and `excludeTools`, dependency graphs, and a live observability dashboard.

**Version:** 2.1.0 · **Author:** Azmeen Afandi / Beeroo Labs · **License:** MIT

---

## What it does

`brl-subagent` gives pi a **`delegate_task`** tool that spawns isolated subagent processes. Each subagent runs in its own `pi` process with its own model, context window, and tool permissions.

**v2.1.0:** Background subagent concurrency fixes, tool system overhaul, sandbox and backend removal, transcript recording, and dead code cleanup.

**v2.0.4:** The sandbox system has been removed. Tools are now controlled directly via `tools` and `excludeTools` parameters on `delegate_task`.

**v2.0.3 adds:** Phase 5 hardening features (pre-task validation, integration tests, post-mortem diagnostics, and conductor guardrails).

---

## Installation

```bash
# Global (all projects)
cd ~/.pi/agent/extensions && git clone https://github.com/azmeenafandi/brl-subagent.git

# Project-local
cd your-project/.pi/extensions && git clone https://github.com/azmeenafandi/brl-subagent.git
```

Pi auto-discovers extensions in these directories. To update: `git pull` inside the cloned directory.

---

## Quick reference

### Commands

| Command | What it does |
|---|---|
| `/brl-subagent` | Open configuration menu |
| `/brl-subagent model` | Select subagent model |
| `/brl-subagent thinking` | Set max thinking level ceiling |
| `/brl-subagent concurrency` | Set max parallel limit |
| `/brl-subagent depth` | Set max recursion depth |
| `/brl-subagent priority` | Set default priority |
| `/brl-subagent gitmode` | Set git integration mode |
| `/brl-subagent backend` | Set default backend |
| `/brl-subagent approval` | Set change approval mode |
| `/brl-subagent costlimit` | Set session cost limit |
| `/brl-subagent historyentries` | Set max history entries |
| `/brl-subagent sla` | Configure SLA tracking |
| `/brl-subagent sla-stats` | View SLA statistics |
| `/brl-subagent pool` | Configure process pool |
| `/brl-subagent preset` | Manage delegation presets |
| `/brl-subagent templates` | Manage task templates |
| `/brl-subagent schedule` | Manage recurring schedules |
| `/brl-subagent history` | Browse past subagent runs |
| `/brl-subagent monitor` | Live monitor running subagents |
| `/brl-subagent dashboard` | Live observability dashboard |
| `/brl-subagent retry` | Browse failed runs to retry |
| `/brl-subagent reset` | Reset all configuration |
| **Ctrl+Shift+O** | Shortcut for live monitor |

All settings persist across sessions.

---

## delegate_task parameters

### Core

| Parameter | Type | Default | Description |
|---|---|---|---|
| `task` | string | *required* | What the subagent should do. Be specific — it doesn't see your conversation history. |
| `label` | string | — | Human-readable name (e.g., `"security-audit"`). Shows in status bar, result header, and history. |
| `preset` | string | — | Named delegation preset. Preset values are defaults; explicit params override. |
| `systemPrompt` | string | — | Extra instructions or a different persona for the subagent. |
| `inheritSystemPrompt` | boolean | `true` | Whether to inherit the main agent's system prompt. Set `false` to save tokens. |
| `thinkingLevel` | string | — | `off` / `minimal` / `low` / `medium` / `high` / `xhigh`. Capped at user's configured max. |
| `outputFile` | string | — | Path for the subagent to write full findings. Returns only a summary. |
| `timeout` | number | — | Max milliseconds. Exceeded → SIGTERM (5s grace) → SIGKILL. |
| `cwd` | string | — | Working directory. Defaults to conductor's cwd. |

---

## Phase 5 hardening (v2.1.0)

---

## Changelog

### v2.1.0

- **Footer live counters:** Footer now shows background subagent activity with live counters.
- **Background subagent concurrency fix:** Fixed dynamic import and serialization queue for reliable parallel execution.
- **Tool system fix:** `edit` tool now auto-includes `write`; prompt clarifies which tools are available to subagents.
- **Backend system removed:** Removed dead backend code that was no longer used.
- **Foreground transcript recording:** All tasks now record transcripts for full observability.
- **Dead code cleanup:** Removed 12 unused exports across the codebase.
- **Phase 5 Hardening complete (H1–H4):** Pre-task validation, integration tests, post-mortem diagnostics, and conductor guardrails finalized.

### H1 — Pre-task validation

Deterministic pre-spawn checks that validate tool configuration and thinking level match the task description. Warns about **thinking level mismatches** (e.g., `off` thinking on a complex debugging task) and **missing tools** for the requested task.

### H2 — Integration test suite

Two-tier test coverage:
- **Tier 1:** jiti import verification — confirms the extension loads without errors.
- **Tier 2:** Subprocess execution — verifies the extension can spawn and communicate with a subagent process.

### H3 — Post-mortem diagnostics

When a subagent fails, analyzes the failure and suggests concrete fixes:
- Git mode mismatch (e.g., `gitMode: 'branch'` when repo is dirty)
- Thinking level too low for the task complexity
- Timeout issues and recommendations for increasing limits

### H4 — Conductor guardrails

Behavior rules embedded in `promptGuidelines` and `SUBAGENT_INSTRUCTIONS` that guide the conductor LLM to configure subagents correctly before spawning. Prevents common misconfigurations at the prompt level.

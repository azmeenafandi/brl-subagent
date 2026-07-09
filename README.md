# brl-subagent

> Enterprise subagent extension for [pi](https://github.com/earendil-works/pi-coding-agent) — delegate tasks to isolated processes with configurable models, thinking levels, tool scoping, RBAC, sandboxing, dependency graphs, and a live observability dashboard.

**Version:** 2.0.0 · **Author:** Azmeen Afandi / Beeroo Labs · **License:** MIT

---

## What it does

`brl-subagent` gives pi a **`delegate_task`** tool that spawns isolated subagent processes. Each subagent runs in its own `pi` process with its own model, context window, and tool permissions.

**v2.0.0 adds:** dependency graph delegation, task templates, recurring schedules, an observability dashboard, RBAC roles, sandbox levels, change approval workflows, git integration, and subagent-to-subagent messaging.

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
| `/brl-subagent sandbox` | Set default sandbox level |
| `/brl-subagent backend` | Set default backend |
| `/brl-subagent role` | Set default RBAC role |
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

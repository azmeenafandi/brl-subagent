# brl-subagent

> Enterprise subagent extension for [pi](https://github.com/earendil-works/pi-coding-agent) — delegate tasks to isolated processes with configurable models, thinking levels, tool scoping, RBAC, sandboxing, dependency graphs, and a live observability dashboard.

**Version:** 2.0.0 · **Author:** Azmeen Afandi / Beeroo Labs · **License:** MIT

---

## What it does

`brl-subagent` gives pi a **`delegate_task`** tool that spawns isolated subagent processes. Each subagent runs in its own `pi` process with its own model, context window, and tool permissions.

**v2.0.0 adds:** dependency graph delegation, task templates, recurring schedules, an observability dashboard, RBAC roles, sandbox levels, change approval workflows, git integration, multi-turn questioning, and subagent-to-subagent messaging.

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
| `maxTurns` | number | `1` | Max conversation turns. Set > 1 to allow the subagent to ask clarifying questions. |

### Tool scoping

| Parameter | Type | Default | Description |
|---|---|---|---|
| `tools` | string[] | — | Allowlist (e.g., `["read", "grep"]`). Maps to pi's `--tools` flag. |
| `excludeTools` | string[] | — | Blocklist (e.g., `["write", "edit"]`). Maps to pi's `--exclude-tools` flag. |
| `noBuiltinTools` | boolean | `false` | Disable all built-in tools. Maps to pi's `--no-builtin-tools` flag. |
| `role` | string | `"developer"` | RBAC role: `reviewer` (read-only), `developer` (full), or `auditor` (security-focused). |
| `sandboxLevel` | string | user config | `none` (full access), `readonly` (audits), or `safe` (debugging). More restrictive of role/sandbox wins. |

### Security & governance

| Parameter | Type | Default | Description |
|---|---|---|---|
| `gitMode` | string | user config | `"branch"` creates a work branch, captures diff, switches back. `"none"` does nothing. |
| `approvalMode` | string | user config | `"auto"` (never ask), `"writes"` (ask when files changed), `"always"` (ask every time). |
| `priority` | string | user config | `"critical"`, `"high"`, `"normal"`, or `"low"` — determines queue order. |
| `backend` | string | user config | `"pi"` (full tools, default) or `"direct-api"` (no tools, direct API call). |

### Retry & templates

| Parameter | Type | Default | Description |
|---|---|---|---|
| `template` | string | — | Name of a saved task template. Use with `params` to fill template slots. |
| `params` | Record\<string, string\> | — | Parameter values for template `${param}` slots. |
| `retryRunId` | string | — | ID of a previously failed run to retry with same parameters. Explicit params override. |
| `retryOnTimeout` | boolean | `false` | Auto-retry once on timeout. Second timeout = final failure. |

### Advanced delegation modes

| Parameter | Type | Default | Description |
|---|---|---|---|
| `chain` | SubTaskParams[] | — | Sequential steps (max 10). Use `{previous}` to reference the prior step's output. |
| `tasks` | SubTaskParams[] | — | Parallel tasks (max 8). All run concurrently regardless of individual failures. |
| `graph` | GraphTask[] | — | Dependency graph (max 12). Declare `dependsOn` to auto-schedule waves. Use `{id}` to reference another task's output. |

Each `chain`/`tasks`/`graph` entry supports: `task`, `label`, `preset`, `thinkingLevel`, `systemPrompt`, `inheritSystemPrompt`, `cwd`, `timeout`, `outputFile`, `tools`, `excludeTools`, `noBuiltinTools`.

The subagent returns: final output text, usage stats (turns, tokens, cost), and error info if something went wrong.

---

## Prompt inheritance modes

| `inheritSystemPrompt` | `systemPrompt` | Behavior |
|---|---|---|
| `true` | not set | Inherits the main agent's full prompt |
| `true` | set | Inherits + your custom instructions |
| `false` | set | Only your custom prompt |
| `false` | not set | Bare minimum — saves tokens |

---

## Presets

Presets save reusable delegation configurations. Use them by name:

```json
{ "task": "Audit src/ for security issues", "preset": "security-auditor" }
```

### Built-in presets

9 presets ship in `presets/` as markdown files with YAML frontmatter:

| Preset | Personality | Thinking | Tools |
|---|---|---|---|
| `code-reviewer` | Constructive code review — correctness, security, maintainability | `high` | read-only |
| `security-auditor` | OWASP-focused vulnerability assessment | `high` | read-only |
| `test-engineer` | Test design — happy paths, edge cases, error paths | `medium` | read + write |
| `tech-writer` | Technical documentation — audience-aware, example-driven | `medium` | read + write |
| `rapid-prototyper` | Speed over perfection — ship first, refine later | `low` | all tools |
| `debugger` | Systematic diagnosis — reproduce, isolate, root cause | `high` | read + bash |
| `refactorer` | Code structure — small steps, DRY, preserve behavior | `medium` | read + write |
| `data-analyst` | Data analysis — statistical rigor, actionable recommendations | `medium` | read + write |
| `dev-agent` | Full-access development — code implementation, testing, git | `medium` | all tools |

**Auto-routing:** When neither `preset` nor `template` is specified, the extension auto-routes the task to the best-matching preset based on keyword analysis.

### Custom presets

```bash
/brl-subagent preset
```

Select **"+ Add Preset"** to create your own. Or drop a `.md` file in `presets/` — it'll be loaded on next session start. Built-in presets take precedence over custom presets with the same name.

---

## Task templates

Templates are reusable task definitions with `${param}` placeholders. They let you parameterize common workflows.

### Template syntax

```
Audit ${file} for ${focus} issues. Use the ${standard} standard.
```

Parameter names are extracted from `${...}` placeholders. When invoking a template, provide values for each param via the `params` field.

### Example

Create a template:
```bash
/brl-subagent templates → "+ Add Template"
```

- Name: `owasp-audit`
- Task: `Perform an OWASP Top 10 audit of ${file} focusing on ${category}. Generate a report.`
- Preset: `security-auditor`

Invoke it:
```json
{
  "template": "owasp-audit",
  "params": {
    "file": "src/auth.ts",
    "category": "injection vulnerabilities"
  }
}
```

The resolved task becomes: *"Perform an OWASP Top 10 audit of src/auth.ts focusing on injection vulnerabilities. Generate a report."*

Template fields (`preset`, `thinkingLevel`, `outputFile`, etc.) are used as defaults; explicit `delegate_task` parameters override them.

---

## Advanced delegation modes

### Chain mode

Sequential steps where each receives the previous step's output via `{previous}`:

```json
{
  "chain": [
    { "task": "Find all TODO comments in src/", "label": "find-todos" },
    { "task": "Categorize these TODOs by priority: {previous}", "label": "categorize" },
    { "task": "Create a prioritized action plan: {previous}", "label": "action-plan" }
  ]
}
```

Chain stops at the first failure. Max 10 steps.

### Parallel mode

Fan-out concurrent execution — all tasks run regardless of individual failures:

```json
{
  "tasks": [
    { "task": "Review src/auth.ts for security issues", "label": "auth-review" },
    { "task": "Review src/api.ts for error handling", "label": "api-review" },
    { "task": "Review src/db.ts for SQL injection", "label": "db-review" }
  ]
}
```

Max 8 parallel tasks. Each task is independently scoped with its own model, thinking level, and tools.

### Dependency graph

Declare task dependencies — the scheduler auto-parallelizes independent tasks and sequences dependent ones:

```json
{
  "graph": [
    { "id": "collect", "task": "Collect all source files", "dependsOn": [] },
    { "id": "analyze-a", "task": "Analyze security: {collect}", "dependsOn": ["collect"] },
    { "id": "analyze-b", "task": "Analyze performance: {collect}", "dependsOn": ["collect"] },
    { "id": "report", "task": "Merge findings: {analyze-a} and {analyze-b}", "dependsOn": ["analyze-a", "analyze-b"] }
  ]
}
```

The scheduler builds waves via topological sort: `{collect}` runs first, then `{analyze-a}` and `{analyze-b}` run in parallel, then `{report}` runs last. Max 12 tasks.

---

## Security features

### Input sanitization

All task strings are sanitized before execution — command injection patterns and environment variable expansion are stripped. Output is sanitized to remove ANSI escape codes and capped at 100KB.

### Sandboxing

Three levels restrict which tools a subagent can use:

| Level | Allowed Tools | Blocked Tools | Use case |
|---|---|---|---|
| `none` | All | None | Full access (default) |
| `readonly` | read, grep, find, ls | write, edit, bash | Audits, reviews |
| `safe` | read, grep, find, ls, bash | write, edit | Debugging, testing |

Set via `/brl-subagent sandbox` or per-call `sandboxLevel`. The more restrictive of role and sandbox wins.

### RBAC (Role-Based Access Control)

| Role | Tools | Use case |
|---|---|---|
| `developer` | All tools | Full development access |
| `reviewer` | read, grep, find, ls | Code review, analysis |
| `auditor` | read, grep, find, ls | Security-focused review |

Set via `/brl-subagent role` or per-call `role`. When combined with sandboxing, the intersection of both is applied.

### Change approval workflow

When git mode is `"branch"`, subagent changes are captured on a work branch. The approval mode controls whether you review changes before merging:

- **auto** — Merge automatically (never ask)
- **writes** — Ask when files were changed (default)
- **always** — Ask every time

The approval dialog shows a diff preview, file count, and branch name. You can apply, discard, or view the full diff before deciding.

### Recursion depth limiting

Subagents can only delegate to a configurable depth (default: 3). Prevents infinite sub-subagent spawning. Configure via `/brl-subagent depth`.

### Reserved name protection

Names starting and ending with `__` (e.g., `__done__`) and names that collide with built-in command completions (e.g., `model`, `reset`, `history`) are blocked for presets, templates, and schedules.

---

## Run history and seen/unseen

Every `delegate_task` call is recorded — task, label, model, thinking level, duration, cost, output preview. Browse with `/brl-subagent history`.

When a subagent finishes, it's **unseen** until you review it:

- `brl: 3 done (3 unseen)` — all completions need review
- `brl: 3 done (1 unseen)` — two reviewed, one remains

Opening a run marks it as seen. Seen status persists across sessions. History entries are pruned automatically when exceeding the configured max (default: 500, configurable via `/brl-subagent historyentries`).

---

## Live monitor

Watch all running subagents in real-time:

```bash
/brl-subagent monitor   # or Ctrl+Shift+O
```

Shows: spinning indicator, label/task, model, thinking level, live token usage, elapsed time, and latest output line. Auto-refreshes every 200ms.

---

## Observability dashboard

The dashboard provides a real-time overview of all subagent activity:

```bash
/brl-subagent dashboard
```

**Panels:**

- **Active subagents** — live status of currently running subagents with token counts and elapsed time
- **SLA Summary** — success rate, p50/p95/p99 duration percentiles, total and average cost
- **Recent Runs** — last 10 completed/failed runs with duration and cost
- **Error Breakdown** — horizontal bar chart of errors by category (timeout, model_unavailable, tool_error, etc.)
- **Cost Trend** — sparkline visualization of per-run cost over the last 20 runs

Auto-refreshes every 2 seconds. Access SLA statistics on-demand via `/brl-subagent sla-stats`.

---

## Retry and resume

### Manual retry

Pass `retryRunId` from a failed run:

```json
{ "task": "", "retryRunId": "abc123" }
```

Or browse failed runs: `/brl-subagent retry`

### Auto-retry on timeout

```json
{ "task": "Reproduce flaky test", "timeout": 300000, "retryOnTimeout": true }
```

Original parameters are stored automatically. Explicit params on the retry override the original. Only one automatic retry — the second timeout is a final failure.

---

## Git integration

When git mode is set to `"branch"` (via `/brl-subagent gitmode` or per-call `gitMode`):

1. A work branch is created from the current branch (e.g., `brl/audit-abc123`)
2. The subagent runs on the work branch
3. The diff between the original branch and work branch is captured
4. Based on approval mode: auto-merge, prompt for approval, or always prompt
5. The work branch is deleted (on merge or discard)

The diff is rendered inline in both collapsed and expanded result views, with file-level summaries (+additions/-deletions) and structured hunk display.

---

## Other features

**Concurrency with priority queue** — Set max parallel subagents via `/brl-subagent concurrency`. Tasks are queued and dispatched by priority (critical > high > normal > low). Excess subagents wait for a slot.

**Circuit breaker** — After 5 consecutive failures, the circuit opens and rejects new delegations for 60 seconds. During degraded state, thinking level is auto-limited to `minimal`. Resets after a successful run.

**Cost governance** — Set a session cost limit via `/brl-subagent costlimit`. Delegations are rejected once the estimated cumulative cost exceeds the limit. Per-task cost estimates are configurable.

**Pre-flight checks** — Validates working directory existence and accessibility before spawning a subagent. Fails fast to avoid wasting resources on doomed runs.

**Subagent-to-subagent messaging** — Parallel and graph-mode subagents can communicate via the Intercom system. Each subagent registers an ID and can send/receive messages to coordinate work.

**Multi-turn questioning** — Set `maxTurns > 1` to let subagents ask clarifying questions. The conductor shows the question to the user, and the answer is fed back as additional context for the next turn.

**Skill-based auto-routing** — When no preset is specified, tasks are automatically routed to the best-matching built-in preset based on keyword analysis of the task description.

**Recurring scheduling** — Schedule tasks to run on a recurring interval via `/brl-subagent schedule`. Configure task, preset, thinking level, and interval (minimum 5 minutes). Schedules persist across sessions.

**SLA tracking and degradation alerts** — Enable via `/brl-subagent sla`. Tracks success rate, duration percentiles, cost, and error categories over a configurable window (10-500 runs). Detects degradation against baseline metrics and logs recommendations.

**Compliance reports** — File access report (which subagents touched which files), secrets exposure report (sensitive file access findings with severity levels), and full compliance summary — accessible via the compliance menu.

**Process pool** — Optional pre-warmed pi processes for faster subagent startup. Configure via `/brl-subagent pool`. Pool size 1-8, idle timeout 2 minutes.

**Structured logging** — All operations emit structured logs (debug/info/warn/error) with context — run IDs, costs, timing, error categories.

---

## Output display

When a subagent finishes:

**Collapsed (default):**
```
✓ subagent [security-audit] (claude-sonnet-4-5)
  I found 3 potential issues in src/auth.ts...
(Ctrl+O to expand)
↑1.2k ↓340 R2k $0.0234
```

**Expanded (Ctrl+O):** Full output as Markdown + detailed usage stats + structured diff display.

**Chain/Parallel/Graph:** Collapsed shows per-step/task summaries with status icons. Expanded shows full output per step with aggregated totals.

---

## License

MIT - Azmeen Afandi / Beeroo Labs

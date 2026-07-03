# brl-subagent

> A subagent extension for [pi](https://github.com/earendil-works/pi-coding-agent) — delegate work to isolated processes with their own model, thinking level, and context window.

**Author:** Azmeen Afandi / Beeroo Labs | **License:** MIT

---

## What it does

`brl-subagent` gives pi a **`delegate_task`** tool. The LLM can spawn subagents for parallel research, code audits, long-running analysis, or any task that benefits from isolation. Each subagent runs in a separate `pi` process with its own context window.

Configure the subagent's model and thinking level once via `/brl-subagent`, then delegate freely.

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

| Command | What it does |
|---|---|
| `/brl-subagent` | Open configuration menu |
| `/brl-subagent model` | Select subagent model |
| `/brl-subagent thinking` | Set max thinking level ceiling |
| `/brl-subagent concurrency` | Set max parallel limit |
| `/brl-subagent preset` | Manage delegation presets |
| `/brl-subagent history` | Browse past subagent runs |
| `/brl-subagent monitor` | Watch running subagents live (Ctrl+Shift+O) |
| `/brl-subagent retry` | Browse failed runs to retry |
| `/brl-subagent reset` | Reset everything |

All settings persist across sessions.

---

## delegate_task parameters

| Parameter | Type | Default | Description |
|---|---|---|---|
| `task` | string | *required* | What the subagent should do. Be specific — it doesn't see your conversation history. |
| `label` | string | — | Human-readable name (e.g., `"security-audit"`). Shows in tool call badge, result header, and history. |
| `preset` | string | — | Named delegation preset (built-in or custom). Preset values are defaults; explicit params override. |
| `systemPrompt` | string | — | Extra instructions or a different persona for the subagent. |
| `inheritSystemPrompt` | boolean | `true` | Whether to inherit the main agent's system prompt. Set `false` to save tokens. |
| `thinkingLevel` | string | — | `off` / `minimal` / `low` / `medium` / `high` / `xhigh`. Capped at user's configured max. |
| `outputFile` | string | — | Path for the subagent to write full findings. Returns only a summary. |
| `timeout` | number | — | Max milliseconds. Exceeded → SIGTERM (5s) → SIGKILL. |
| `cwd` | string | — | Working directory. Defaults to conductor's cwd. |
| `tools` | string[] | — | Allowlist (e.g., `["read", "grep"]`). |
| `excludeTools` | string[] | — | Blocklist (e.g., `["write", "edit"]`). |
| `noBuiltinTools` | boolean | `false` | Disable all built-in tools. |
| `retryRunId` | string | — | ID of a failed run to retry with same params. Explicit params override. |
| `retryOnTimeout` | boolean | `false` | Auto-retry once on timeout. Second timeout = final failure. |

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

8 personality presets ship in `presets/` as markdown files with YAML frontmatter:

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

### Custom presets

```bash
/brl-subagent preset
```

Select **"+ Add Preset"** to create your own. Or drop a `.md` file in `presets/` — it'll be loaded on next session start. Built-in presets take precedence over custom presets with the same name.

---

## Run history & seen/unseen

Every `delegate_task` call is recorded — task, label, model, thinking level, duration, cost, output preview. Browse with `/brl-subagent history`.

When a subagent finishes, it's **unseen** until you review it:

- `brl: 3 done (3 unseen)` — all completions need review
- `brl: 3 done (1 unseen)` — two reviewed, one remains

Opening a run marks it as seen. Seen status persists across sessions.

---

## Live monitor

Watch all running subagents in real-time:

```bash
/brl-subagent monitor   # or Ctrl+Shift+O
```

Shows: spinning indicator, label/task, model, thinking level, live token usage, elapsed time, and latest output line.

---

## Retry & resume

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

Original parameters are stored automatically. Explicit params on the retry override the original.

---

## Other features

**Concurrency** — Set max parallel subagents via `/brl-subagent concurrency`. Excess subagents are queued.

**Timeout** — Set `timeout` in milliseconds. Exceeded → SIGTERM (5s grace) → SIGKILL.

**File output** — Set `outputFile` to write full findings to disk. Returns only a summary.

**Custom cwd** — Set `cwd` to override the subagent's working directory.

**Read-only subagents** — Use `tools: ["read", "grep", "find", "ls"]` + `excludeTools: ["write", "edit", "bash"]` (or the `code-reviewer`/`security-auditor` presets).

**Abort** — Press **Ctrl+C** during delegation to kill the subagent.

**Temp directory** — System prompt temp files go to `.pi/subagent-tmp/` (add to `.gitignore`).

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

**Expanded (Ctrl+O):** Full output as Markdown + detailed usage stats.

---

## License

MIT - Azmeen Afandi / Beeroo Labs

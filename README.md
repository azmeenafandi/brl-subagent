# brl-subagent

> A configurable subagent extension for [pi](https://github.com/earendil-works/pi-coding-agent) that runs isolated tasks in parallel with their own model and thinking level.

**Author:** Azmeen Afandi / Beeroo Labs  
**License:** MIT

---

## What it does

`brl-subagent` lets you delegate work to a subagent that runs in a separate `pi` process with its own context window. You configure the subagent's model and thinking level once via an interactive menu, then the LLM can spawn subagents whenever it needs to — for parallel research, deep code audits, long-running analysis, or any task that benefits from isolation.

When a subagent finishes, it reports back with what it did, key findings, files modified, and usage stats.

---

## Installation

Clone this repo into one of pi's extension directories:

### Global (all projects)

```bash
cd ~/.pi/agent/extensions
git clone https://github.com/azmeenafandi/brl-subagent.git
```

### Project-local (single project)

```bash
cd your-project/.pi/extensions
git clone https://github.com/azmeenafandi/brl-subagent.git
```

Pi auto-discovers extensions in these directories — no extra setup needed. To update later, just `git pull` inside the cloned directory.

---

## Configuration

Run `/brl-subagent` inside pi to open the configuration menu. From there you can:

| Option | What it does |
|---|---|
| **Select Model** | Pick the model your subagent will use (or leave unset to use the main agent's model) |
| **Select Max Thinking Level** | Set the ceiling for subagent thinking. Choose from `off`, `minimal`, `low`, `medium`, `high`, or `xhigh`. Individual calls can request a lower level. |
| **Set Max Parallel Subagents** | Limit concurrent subagents (0 = unlimited) |
| **Reset to Default** | Clear all configuration |

You can also jump straight to a selector:

```bash
/brl-subagent model       # Open model selector directly
/brl-subagent thinking    # Open thinking level selector directly
/brl-subagent concurrency  # Set max parallel limit
/brl-subagent history     # Browse past subagent runs
/brl-subagent reset       # Reset everything
```

All settings persist across sessions automatically.

---

## Using the subagent

The LLM gains access to a **`delegate_task`** tool. Just ask pi to hand off work, and it will spawn a subagent. For example:

> "Audit every TypeScript file in `src/` for security issues. Use a subagent for each file."

The LLM can also be explicit:

```json
{
  "task": "Review src/auth.ts for hardcoded secrets and missing input validation."
}
```

### Parameters

| Parameter | Type | Required | Default | Description |
|---|---|---|---|---|
| `task` | string | Yes | — | What you want the subagent to do. Be specific — the subagent doesn't see your conversation history. |
| `systemPrompt` | string | No | — | Extra instructions or a completely different persona for the subagent. |
| `inheritSystemPrompt` | boolean | No | `true` | Whether to pass the main agent's system prompt to the subagent. Set to `false` to save tokens on simple tasks. |
| `label` | string | No | — | Human-readable name for this subagent (e.g., `"security-audit"`, `"docs-review"`). Appears in the tool call badge, result header, and run history. |
| `preset` | string | No | — | Name of a saved delegation preset (created via `/brl-subagent preset`). Preset values are used as defaults; explicit parameters on this call override them. |
| `thinkingLevel` | string | No | — | Requested thinking level for this call. One of: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`. Capped at the user's configured maximum. Omit to use the user's configured level. |
| `outputFile` | string | No | — | Project-relative path where the subagent writes full findings. The subagent returns only a structured summary — full output goes to disk. |
| `timeout` | number | No | — | Maximum time in milliseconds. If exceeded, the subagent is killed (SIGTERM → 5s → SIGKILL). |
| `cwd` | string | No | — | Working directory for the subagent. Defaults to the conductor's current directory. |
| `tools` | string[] | No | — | Allowlist of tools the subagent can use (e.g., `["read", "grep"]`). |
| `excludeTools` | string[] | No | — | Tools to disable (e.g., `["write", "edit"]` for read-only subagents). |
| `noBuiltinTools` | boolean | No | `false` | Disable all built-in tools. Useful when the subagent only needs custom tools. |

### Return value

The subagent returns:
- **The final output** as text (the subagent's last message)
- **Usage stats**: turns taken, tokens in/out, cache reads/writes, cost
- **Error info** if something went wrong (non-zero exit, crash, or abort)

---

## Prompt customization

The subagent's system prompt can be controlled per-call with `inheritSystemPrompt` and `systemPrompt`. There are four modes:

| `inheritSystemPrompt` | `systemPrompt` | Behavior | Best for |
|---|---|---|---|
| `true` (default) | not set | Inherits the main agent's full prompt | Open-ended tasks that need project context |
| `true` | set | Inherits the main prompt **plus** your custom instructions | Adding constraints on top of full context |
| `false` | set | Uses **only** your custom prompt (a different persona) | Role-specific tasks like documentation writing |
| `false` | not set | No inheritance, just the bare minimum | Quick lookups (e.g., "read this one file") — saves tokens |

The subagent always gets pi's default tool descriptions and basic instructions to summarize what it did.

---

## Per-Call Thinking Level

You can set the thinking level per `delegate_task` call, capped at the user's configured maximum:

```json
{
  "task": "Audit contracts/ for security issues",
  "thinkingLevel": "high"
}
```

The user sets a ceiling via `/brl-subagent thinking` ("Select Max Thinking Level") for cost control. The conductor model can dial within that range for task-appropriate depth:

| Task | Ideal thinking | Why |
|---|---|---|
| Simple file read / lookup | `off` or `minimal` | Speed matters, no reasoning needed |
| Code audit / security review | `high` | Deep reasoning required |
| Creative ideation | `high` | Divergent thinking benefits |
| Scoring / evaluation | `medium` | Evaluative, not generative |
| Debugging flaky tests | `high` | Complex causal reasoning |

**Cap behavior:** If the user's max is `medium` and the conductor requests `high`, the subagent runs at `medium`. If the request is `low`, it runs at `low`. If omitted, the user's configured max is used.

---

## File Output (Treasury Management)

Use `outputFile` to have the subagent write full findings to disk instead of returning them in the response. The subagent returns only a structured summary — saving context tokens:

```json
{
  "task": "Audit contracts/ for security issues",
  "outputFile": ".pi/subagent-outputs/audit_contracts.md"
}
```

The extension auto-appends file-logging instructions to the subagent's system prompt. The subagent writes its complete output to the specified file using its `write` tool, then returns a compact summary with severity counts, keywords, and files examined.

> **Note:** The extension does NOT create the file or directory — the subagent does via its own `write` tool. Paths are relative to the subagent's working directory.

---

## Timeout

Limit how long a subagent can run to prevent stuck tasks:

```json
{
  "task": "Reproduce flaky test",
  "timeout": 300000
}
```

When the timeout is exceeded, the subagent receives `SIGTERM` (with a 5-second grace period before `SIGKILL`). The result is returned with `isError: true` and `errorMessage: "Subagent timed out after 300000ms"`.

---

## Custom Working Directory

Override the subagent's working directory for isolated worktrees:

```json
{
  "task": "Run tests in isolated worktree",
  "cwd": "/tmp/worktree_attempt_5"
}
```

Defaults to the conductor's current working directory. The path must be an existing directory.

---

## Temp Directory

System prompt temp files are written to `.pi/subagent-tmp/` inside the project directory (not `/tmp`). Each subagent call gets a unique subdirectory that is cleaned up after the subagent exits. Add `.pi/subagent-tmp/` to your `.gitignore` — it's a build artifact, not source code.

---

## Concurrency

By default, subagents run with no limit — great for fanning out to many files at once. If you're hitting resource limits, set a cap via the config menu or run:

```bash
/brl-subagent concurrency
```

Excess subagents are queued and launched as slots free up. The footer shows real-time progress:

| Footer | Meaning |
|---|---|
| `brl: 3 running` | Three subagents are actively working |
| `brl: 1 running, 4 done, 1 failed` | Mixed progress during fan-out |
| `brl: 3 done (3 unseen)` | All finished — 3 results haven't been reviewed yet |
| `brl: 5 done (1 unseen)` | Most results reviewed, 1 still pending |
| `brl: 5 done` | All finished (resets to normal after 3 seconds) |
| `brl:claude-sonnet-4-5 [max think:medium]` | Configured model and max thinking ceiling |

---

## Naming Subagents

Give subagents human-readable labels so you can tell them apart at a glance:

```json
{
  "label": "security-audit",
  "task": "Audit contracts/ for security issues"
}
```

The label appears in three places:
- **Tool call badge:** `delegate_task [security-audit] Audit contracts/...`
- **Result header:** `✓ subagent [security-audit] (claude-sonnet-4-5)`
- **Run history:** each entry shows its label for easy scanning

When subagents have labels, the status bar shows named entries (e.g., `brl: [audit] running, [docs] done (1 unseen)`) instead of anonymous counts. Omit the label to use the default anonymous counter.

---

## Run History & Audit Trail

Every `delegate_task` call is automatically recorded — task, label, model, thinking level, timestamps, duration, token usage, cost, and a preview of the output. This gives you a persistent, searchable audit trail of what your subagents did, whether they succeeded, and how much they cost.

Browse the history at any time:

```bash
/brl-subagent history
```

This opens a scrollable list of past runs (newest first) with status icons and key metrics. Select a run to see its full detail: task description, model, thinking level, start/end times, duration, cost, token counts, error messages, and an output preview.

### Seen vs. Unseen

When a subagent finishes, it's marked **unseen** until you review it. The status bar shows how many results are waiting for your attention:

- `brl: 3 done (3 unseen)` — all three completions need review
- `brl: 3 done (1 unseen)` — you've looked at two, one remains

Opening a run in the history view marks it as seen. Seen status persists across sessions — you won't lose track of what you've reviewed. The counters reset after 3 seconds of inactivity, but the history and seen records are permanent.

> **Tip:** Periodically run `/brl-subagent history` to spot-check subagent output. This lets you verify that the conductor is delegating effectively and that subagents are producing quality results — no more blind trust.

---

## Live Monitor

Watch all running subagents in real-time with a live dashboard. While subagents are working, open the monitor:

```bash
/brl-subagent monitor
```

Or press **Ctrl+Shift+O** to open it directly.

The dashboard shows every active subagent with:
- Spinning indicator showing it's alive
- Label or task name
- Model and thinking level
- Live token usage (input/output) updating in real-time
- Elapsed time
- The most recent line of output — so you can see what it's working on *right now*

When all subagents finish, the dashboard clears. The status bar continues to show completion counts as usual.

> **Tip:** Combine with labels (["Naming Subagents"](#naming-subagents)) to make the dashboard instantly readable: `◉ security-audit` instead of `◉ Review all TypeScript files for...`.

---

## Presets

Presets let you save and reuse common delegation configurations. Instead of specifying `tools`, `thinkingLevel`, `inheritSystemPrompt`, and other options every time, define them once as a named preset and delegate with just the preset name.

### Creating presets

Open the preset manager:

```bash
/brl-subagent preset
```

From there, select **"+ Add Preset"** and walk through the interactive wizard. You'll configure:
- **Name** — a short identifier (e.g., `read-only-audit`, `fast-scan`)
- **Description** — optional context
- **Thinking level** — default thinking depth for this preset
- **Tool scope** — all tools, read-only, or a custom allowlist
- **System prompt inheritance** — whether to inherit the main prompt

### Using presets

Pass the `preset` parameter on `delegate_task`:

```json
{
  "task": "Audit src/ for security issues",
  "preset": "read-only-audit"
}
```

Preset values are **defaults** — any explicit parameter on the call overrides the preset. For example, if the preset sets `thinkingLevel: "high"` but you pass `thinkingLevel: "low"`, the subagent runs at `low`.

### Example presets

| Preset | Use case | Settings |
|---|---|---|
| `read-only-audit` | Safe code reviews | `tools: ["read", "grep", "find", "ls"]`, `excludeTools: ["write", "edit", "bash"]`, `thinkingLevel: "high"` |
| `fast-scan` | Quick lookups | `thinkingLevel: "off"`, `inheritSystemPrompt: false` |
| `deep-analysis` | Complex reasoning | `thinkingLevel: "xhigh"`, `timeout: 600000` |
| `isolated-docs` | Documentation writing | `inheritSystemPrompt: false`, `systemPrompt: "You are a technical writer."` |

### Managing presets

| Command | What it does |
|---|---|
| `/brl-subagent preset` | Open the preset manager (list, add, remove, view) |

Presets persist across sessions automatically.

> **Tip:** Share presets across your team by committing them to version control. Presets are stored in the extension's session state and are restored on startup.

---

## Read-only subagents

For safe audits where you don't want the subagent modifying anything:

```json
{
  "tools": ["read", "grep", "find", "ls"],
  "excludeTools": ["write", "edit", "bash"],
  "task": "Audit all smart contracts for vulnerabilities."
}
```

---

## Aborting

Press **Ctrl+C** during delegation to kill the subagent. It receives `SIGTERM` first, with a 5-second grace period before `SIGKILL`. The main agent gets back an error with `stopReason: "aborted"`.

---

## Output display

When the subagent finishes, you'll see:

**Collapsed (default):**
```
✓ subagent (claude-sonnet-4-5)
  I found 3 potential issues in src/auth.ts...
(Ctrl+O to expand)
↑1.2k ↓340 R2k $0.0234
```

**Expanded (Ctrl+O):** Full output rendered as Markdown, plus detailed usage stats.

---

## License

MIT © Azmeen Afandi / Beeroo Labs

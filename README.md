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
| **Select Thinking Level** | Choose from `off`, `minimal`, `low`, `medium`, `high`, or `xhigh` |
| **Set Max Parallel Subagents** | Limit concurrent subagents (0 = unlimited) |
| **Reset to Default** | Clear all configuration |

You can also jump straight to a selector:

```bash
/brl-subagent model       # Open model selector directly
/brl-subagent thinking    # Open thinking level selector directly
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
| `brl: 5 done` | All finished (resets to normal after 3 seconds) |

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

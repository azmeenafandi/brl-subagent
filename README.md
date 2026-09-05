# brl-subagent

> Multi-agent orchestration for [pi](https://github.com/earendil-works/pi-coding-agent) — chain, parallel, and dependency-graph delegation to isolated subagents with per-step model routing, preset-driven tool scoping, thinking-level control, and background execution with live monitoring, real abort, and per-agent timeouts.

**Version:** 2.3.4 · **Author:** Azmeen Afandi / [Beeroo Labs](https://beeroolabs.com) · **License:** MIT

---

## What it does

`brl-subagent` is **one of the most capable subagent orchestration extensions for pi** — one `delegate_task` tool that spawns fully isolated subagent processes, each with its own model, context window, tool permissions, and thinking level.

- **Multi-step delegation, natively** — chain, parallel, and dependency-graph modes with per-step model routing, so a complex task fans out exactly as you design it.
- **True background execution** — live monitor, real abort (`stop_subagent`), per-agent timeouts, and hard caps. Nothing orphans; nothing leaks.
- **Preset-driven tool scoping** — every subagent runs with exactly the tools its job needs, restricted by preset or per-call `tools`/`excludeTools`, with auto-route that picks the right preset when you don't.
- **Templates with slots** — saved, file-backed task templates with `${param}` placeholders for workflows you run again and again.
- **Safety by default** — task-fence injection protection, sanitized error paths, owner-only persistence, and a 700+ test suite pinning every contract against the real pi SDK.

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
| `/brl-subagent approval` | Set change approval mode |
| `/brl-subagent completionnotify` | Set completion-push wake (all/failed/off) |
| `/brl-subagent costlimit` | Set session cost limit |
| `/brl-subagent historyentries` | Set max history entries |
| `/brl-subagent sla` | Configure SLA tracking |
| `/brl-subagent sla-stats` | View SLA statistics |
| `/brl-subagent preset` | Manage delegation presets |
| `/brl-subagent templates` | Browse task templates |
| `/brl-subagent history` | Browse past subagent runs |
| `/brl-subagent monitor` | Live monitor running subagents |
| `/brl-subagent dashboard` | Live observability dashboard |
| `/brl-subagent retry` | Browse failed runs to retry |
| `/brl-subagent update-check` | Toggle update check on startup |
| `/brl-subagent reset` | Reset all configuration |

All settings persist across sessions.

---

## delegate_task parameters

### Core

| Parameter | Type | Default | Description |
|---|---|---|---|
| `task` | string | *required* | What the subagent should do. Be specific — it doesn't see your conversation history. |
| `label` | string | — | Human-readable name (e.g., `"security-audit"`). Shows in status bar, result header, and history. |
| `model` | string | — | Model override (`provider/model-id`). Defaults to the global subagent model. Validated against the catalog and provider auth; falls back with a warning if unavailable or malformed. Per-step `model` on chain/tasks/graph still wins for that step. |
| `preset` | string | — | Named delegation preset. Preset values are defaults; explicit params override. |
| `template` | string | — | Named task template. See [Task Templates](#task-templates). |
| `params` | object | — | Values for `${param}` slots in the template. All slots must be filled; missing ones error. |
| `systemPrompt` | string | — | Extra instructions or a different persona for the subagent. |
| `inheritSystemPrompt` | boolean | `true` | Whether to inherit the main agent's system prompt. Set `false` to save tokens. |
| `thinkingLevel` | string | — | `off` / `minimal` / `low` / `medium` / `high` / `xhigh`. Capped at user's configured max. |
| `outputFile` | string | — | Path for the subagent to write full findings. Returns only a summary. |
| `timeout` | number | — | Max milliseconds. Exceeded → SIGTERM (5s grace) → SIGKILL. |
| `cwd` | string | — | Working directory. Defaults to conductor's cwd. |
| `background` | boolean | `false` | Spawn as an independent background session; returns an ID immediately. See [Background execution](#background-execution). |
| `priority` | string | — | Concurrency priority: `critical` / `high` / `normal` / `low`. Defaults to `normal`; higher-priority delegations queue ahead. `tasks[]` / `graph[]` steps can set `priority` per unit (see below). |

## Multi-step modes (chain, tasks, graph)

Beyond a single `task`, `delegate_task` accepts three multi-step shapes: `chain` (sequential steps, `{previous}` references the prior step's output), `tasks` (parallel, independent), and `graph` (dependency-ordered, `{otherId}` references another task's output).

Every execution knob can be set per step: `model`, `thinkingLevel`, `tools`, `excludeTools`, `noBuiltinTools`, `systemPrompt`, `inheritSystemPrompt`, `outputFile`, `timeout`, `cwd`. Unset fields inherit from the global parameters (and their preset defaults).

**Per-step priority:** `tasks[]` and `graph[]` items accept a `priority` (`critical` / `high` / `normal` / `low`) — the per-unit priority decides which unit wins a concurrency slot first, overriding the call-level default for that unit only. `chain[]` steps deliberately take NO `priority`: a chain holds one slot for its whole duration, so steps never compete for slots — array order is the priority.

**Per-step model:** `model: "provider/model-id"` on a step overrides the global subagent model for that step only (e.g. a cheap model for extraction steps, an expensive one for synthesis). The override is validated against the model catalog and provider auth before use; if it's unavailable or malformed, the step falls back to the global model with a warning. Note: the global model must still resolve — a session with no configured model at all cannot run multi-step modes even if every step declares one (consistent with single-mode behavior).

---

## Tools

Alongside `delegate_task`, the extension registers three companion tools for background agents — `get_subagent_result` (poll status and retrieve results), `steer_subagent` (send a steering message), and `stop_subagent` (abort a running agent). See [Background execution](#background-execution) for the full background model.

### `stop_subagent`

Stops a running background agent — a real abort, not a status flip.

| Parameter | Type | Description |
|---|---|---|
| `agent_id` | string | Agent ID of the running background session to stop |

**What it does:** aborts the live session via `session.abort()` — the pending `prompt()` resolves with `stopReason: "aborted"` rather than hanging — and marks the agent `stopped`. Partial work from a `gitMode: 'branch'` run is captured in the result before the work branch is discarded. Returns an error if the agent is not found or already terminal. Use it to halt a background agent that is no longer needed.

---

## Presets

Built-in presets ship with the extension. You can also create **custom presets** as `.md` files — no TUI wizard needed.

**Project presets:** `.pi/brl-subagent/presets/<name>.md`  
**Global presets:** `~/.pi/agent/brl-subagent/presets/<name>.md`

Files use the same format as built-in presets — YAML frontmatter with these fields:

> Note: the parser does not support inline comments — put notes on their own line starting with `#`.

```yaml
---
name: my-preset
description: Debug with verbose thinking
# optional — pin a model; falls back to the configured model if unavailable
model: anthropic/claude-opus-4-6
tools:
  - read
  - bash
thinkingLevel: high
---
```

Custom presets override built-ins with the same name and survive `pi install` updates.

Refer to a preset via the `preset` parameter of `delegate_task` (see above). Parameters on `delegate_task` override preset values.

---

## Task Templates

Task templates are named, saved `delegate_task` configurations with `${param}` placeholder slots. Where presets shape the *persona*, templates capture the **task body itself** — a full, often multi-line instruction with slots filled at call time.

**Templates are file-backed** — you create and edit them as `.md` files, exactly like custom presets. The old TUI add/remove flows were removed because single-line input cannot express a task body; use your editor instead.

**Built-in templates:** `templates/<name>.md` (ships with the extension — one thin companion per builtin preset)  
**Project templates:** `.pi/brl-subagent/templates/<name>.md`  
**Global templates:** `~/.pi/agent/brl-subagent/templates/<name>.md`

Precedence is **PROJECT > USER > BUILTIN** (issue #84 + builtin tier): a custom template with the same `name` as a built-in one overrides it, so you can copy a built-in file into your project directory and edit it to customize. The built-in tier is the fallback — it only appears when no custom template claims the name.

Files are markdown with YAML frontmatter; the **body is the task** (multiline by construction):

```yaml
---
name: code-review
preset: code-reviewer
thinkingLevel: medium
---
Review PR ${pr} in this repository.

Focus on:
- correctness bugs and race conditions
- style and naming consistency
- missing test coverage

Report findings as a numbered list with file:line references.
```

Supported frontmatter fields:

| Field | Type | Description |
|---|---|---|
| `name` | string | *required* — template name used in `delegate_task` |
| `description` | string | One-line summary shown in the browse UI |
| `preset` | string | Preset applied when the template is used |
| `thinkingLevel` | string | `off` / `minimal` / `low` / `medium` / `high` / `xhigh` |
| `outputFile` | string | Output file path (may contain `${param}` slots) |
| `timeout` | number | Max milliseconds for the delegated run |
| `tools` | list | Tool allowlist |
| `excludeTools` | list | Tools to exclude |
| `noBuiltinTools` | `"true"` / `"false"` | Disable all pi built-in tools |
| `inheritSystemPrompt` | `"true"` / `"false"` | Override system-prompt inheritance (default `true`) |

Invalid files (missing `name`, bad `thinkingLevel`, non-numeric `timeout`, …) are skipped with a logged warning. Both directories are scanned on session start. Templates survive `pi install` updates — the same property as custom presets.

**Built-in templates shipped with the extension** (VERB-form names, deliberately distinct from their companion presets):

| Template | Companion preset | thinkingLevel | Task shape |
|---|---|---|---|
| `code-review` | `code-reviewer` | medium | Review ${target} for correctness, security, style |
| `security-audit` | `security-auditor` | high | Audit ${target} — injection, authz, secrets, dependencies |
| `write-tests` | `test-engineer` | medium | Write tests for ${file} incl. edge cases |
| `debug-issue` | `debugger` | medium | Debug ${symptom}: reproduce, isolate, fix |
| `refactor` | `refactorer` | medium | Refactor ${target}, preserve behavior |
| `write-docs` | `tech-writer` | low | Document ${topic} with an example |
| `analyze-data` | `data-analyst` | medium | Analyze ${dataset}: patterns, outliers, trends |
| `implement-feature` | `dev-agent` | medium | Implement ${feature} per project conventions |
| `prototype` | `rapid-prototyper` | low | Prototype ${idea} fast, working > polished |

These are deliberately THIN teaching examples — 2-4 line bodies showing `${param}` slots in action, with `preset:` pointing at their companion. Copy one into your project `templates/` dir to customize it (the copy then overrides the built-in).

**Usage:** pass the template name plus parameter values to `delegate_task`:

```js
delegate_task({
  template: "code-review",
  params: { pr: "https://github.com/org/repo/pull/42" },
});
```

- Every `${param}` slot in the template must be provided in `params` — a missing slot fails the call with an error listing the missing names.
- Template fields are **defaults**: explicitly-provided `delegate_task` parameters override them.
- The template's task **replaces** `params.task` entirely.
- Extra keys in `params` are ignored.

**Templates and presets — how they interact:**

- **Dependency runs one way.** A template MAY declare a `preset:` dependency; presets know nothing about templates. Deleting or renaming a preset silently leaves templates that reference it without it.
- **Preset-less templates are not rescued by auto-route.** A template without a `preset:` field runs preset-less — `params.template` itself counts as explicit intent, so the E2 keyword auto-router does NOT kick in. (The same suppression applies when `preset`, `tools`, `excludeTools`, or `noBuiltinTools` are given explicitly.)
- **Full precedence chain** (highest first):

  `explicit delegate_task param > template field > preset defaults > config fallback`

  The template's own `preset:` field slots in as a *template field*: an explicit `preset` param wins over the template's `preset:`, and the resolved preset's defaults (thinkingLevel, systemPrompt, tools, …) fill whatever the params and template leave unset. Config-level defaults (gitMode, approvalMode, maxThinkingLevel caps, …) apply last.
- **Tool fields are replaced, never merged.** A template's `tools` fully overrides the referenced preset's `tools` (same for `excludeTools`/`noBuiltinTools`) — the template's list wins entirely, it is not unioned with the preset's. Mixing still works per-field: a template that sets only `tools` still inherits the preset's `excludeTools`/`noBuiltinTools`.
- **Nonexistent-preset refs warn at session start (issue #81).** A template whose `preset:` names a preset that does not exist is caught by a load-time cross-check: `validateTemplatePresetRefs` warns at session start (and on preset add/remove) naming the template, the dangling reference, and the consequence — the delegation would otherwise run preset-less **silently** with auto-route suppressed. Warn-not-skip: the run still proceeds preset-less, but it is no longer silent. A typo'd preset now produces a visible warning; keep `preset:` names in sync with installed presets.

| Template `preset:` | Result |
|---|---|
| names an existing preset | preset applied (template-field slot in the precedence chain) |
| absent | template runs **preset-less**; auto-route does NOT rescue it |
| names a nonexistent preset | **warned** preset-less run (session-start warning names template + dangling ref), auto-route still suppressed (issue #81) |

`/brl-subagent templates` now **browses only** — it lists your saved templates and shows their details; creation and editing happen in your editor.

## Background execution

Set `background: true` to spawn the subagent as an independent session that returns an ID immediately and keeps running. Its progress is tracked via `getAgent` and the live monitor while the main session continues. (Steering via `steerAgent` currently records the message in the transcript and marks the agent as steered — delivery to the live session is pending pi's extension API.)

**System prompt semantics:** background sessions are spawned with the same built prompt as foreground subagents (base prompt when `inheritSystemPrompt: true`, custom prompt, preset guidance, and subagent instructions). Like pi's own `--append-system-prompt`, supplying this prompt **replaces** any discovered `.pi/APPEND_SYSTEM.md` / global `APPEND_SYSTEM.md` content — this matches foreground subagent behavior exactly. With `inheritSystemPrompt: true` (the default) your conductor session's instructions — including its own appended content — are inherited through the base prompt.

**Extension/skill isolation:** background sessions never import extension or skill code — not from the target `cwd` (which is LLM-controlled and untrusted — there is no trust prompt in background mode) and not from your global `~/.pi/agent/skills`. This is a deliberate security choice: the prompt is fully specified by the caller, so nothing is lost from the delegation contract. If a task needs installed skills or extension tools, use foreground delegation instead.

**Background safety controls (issue #28):** background agents honor the same safety controls as foreground runs — no more unattended sessions that bypass approval, git isolation, deadlines, or cost:

- **Per-agent timeout** — the deadline is armed before the prompt starts (preflight time counts toward it). On expiry the session is aborted and the agent ends with status `stopped` and the timeout reason. Timeout values are normalized (`0`/negative/`NaN`/`Infinity`/`≥ 2^31` → no timeout) and a double-fire guard prevents the timer from acting on an already-settled agent.
- **Session cost limit (R5)** — the cost check runs before the background spawn, so a session at its limit cannot bypass it by delegating to background.
- **Approval mode** — `approvalMode: 'always'` is rejected for background agents (there is no interactive dialog to approve a diff while running unattended); `'writes'` silently auto-approves with a warning logged.
- **gitMode branch isolation** — with `gitMode: 'branch'` a work branch is created before the run, the agent's changes are committed at teardown so the diff is real, the diff is captured and surfaced via `get_subagent_result`, and the branch is then switched away from and deleted. This requires a clean working tree — a dirty tree is refused loudly rather than risking the base branch.
## Changelog

See [CHANGELOG.md](CHANGELOG.md) for the release history.

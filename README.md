# brl-subagent

> Enterprise subagent extension for [pi](https://github.com/earendil-works/pi-coding-agent) — delegate tasks to isolated processes with configurable models, thinking levels, tool scoping via `tools` and `excludeTools`, dependency graphs, and a live observability dashboard.

**Version:** 2.1.3 · **Author:** Azmeen Afandi / Beeroo Labs · **License:** MIT

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
| `/brl-subagent preset` | Manage delegation presets |
| `/brl-subagent templates` | Manage task templates |
| `/brl-subagent schedule` | Manage recurring schedules |
| `/brl-subagent history` | Browse past subagent runs |
| `/brl-subagent monitor` | Live monitor running subagents |
| `/brl-subagent dashboard` | Live observability dashboard |
| `/brl-subagent retry` | Browse failed runs to retry |
| `/brl-subagent reset` | Reset all configuration |

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
| `background` | boolean | `false` | Spawn as an independent background session; returns an ID immediately. See [Background execution](#background-execution). |

## Multi-step modes (chain, tasks, graph)

Beyond a single `task`, `delegate_task` accepts three multi-step shapes: `chain` (sequential steps, `{previous}` references the prior step's output), `tasks` (parallel, independent), and `graph` (dependency-ordered, `{otherId}` references another task's output).

Every execution knob can be set per step: `model`, `thinkingLevel`, `tools`, `excludeTools`, `noBuiltinTools`, `systemPrompt`, `inheritSystemPrompt`, `outputFile`, `timeout`, `cwd`. Unset fields inherit from the global parameters (and their preset defaults).

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

### v2.1.3

- **Real abort for background agents (issue #28):** the `stop_subagent` tool and async `stopAgent()` abort the live session via `session.abort()` — the pending `prompt()` resolves with `stopReason: "aborted"` and the agent is marked `stopped`. Previously steering/stopping only flipped a status flag and the session kept running.
- **Per-agent timeout + hard cap:** a deadline is armed before the prompt runs; when exceeded the session is aborted and the agent ends `stopped` with the timeout reason. The hard cap actually aborts now (was an orphaned-session leak). Timeouts are normalized (`0`/negative/`NaN`/`Infinity`/`≥2^31` → no timeout) and a double-fire guard prevents acting on an already-settled agent.
- **Background safety controls:** `gitMode: 'branch'` creates a work branch before the run, commits and captures the diff at teardown (surfaced via `get_subagent_result`), then discards the branch — dirty working trees are refused; `approvalMode: 'always'` is rejected in background (no dialog) and `'writes'` auto-approves with a warning; the R5 session cost limit gates background spawns.
- **Real-git test tier (Gate A):** new `*-real.test.ts` convention runs real git against scratch repos, covering the branch lifecycle and the `captureWorkingDiff` untracked-file fix.
- **Crash fix (incidental):** transcript completion no-ops on a missing transcript file (was an uncaughtException killing pi); defensive settle-handler wrappers across the background lifecycle.
- Shipped as 4 PRs (#47 real abort, #49 timeouts, #50 safety controls, #51 Gate A) + incidentals (#48 CI flake, #54 crash fix). Live-verified 2026-08-06 — foreground, background, timeout abort (stopped @ 20s), gitMode=branch lifecycle (branch created/discarded, diff rendered), stop_subagent — all pass. 684 tests across 34 files.

### v2.1.2

- **Per-step model override:** chain/parallel/graph steps can declare their own `model` (`step.model > global preset > config > conductor`), availability-checked with fallback to the global model. Resolves issue #3 (per-step presets intentionally not implemented — see design decision).
- **Security hardening:** agent ids validated as UUIDs before any filesystem access (`assertSafeAgentId` — closes agent-id path traversal); background sessions never import extension/skill code from the target cwd (loader built with `noExtensions`/`noSkills` — closes cwd→code-execution RCE).
- **Preset tool visibility:** the `delegate_task` tool description now exposes each preset's tool restrictions (e.g. `security-auditor (read-only: excludes write, edit, bash)`); auto-routed presets are reported in the tool result.
- **H1 loud failure:** `outputFile` combined with an unavailable `write` tool is now a hard error before spawn (was a silent failure); background mode runs H1 validation too.
- **Background prompt injection:** background sessions receive the full built prompt (base + custom + preset guidance + subagent instructions) via `DefaultResourceLoader.appendSystemPrompt` — same semantics as pi's `--append-system-prompt`; background honors resolved `toolOptions` and resolves the model string to a real Model object.
- **Prompt guideline wiring:** `promptGuideline` from presets is now appended to the subagent prompt as a "## Preset Guidance" section.
- **Auth-aware model availability:** preset models are checked against catalog presence AND provider auth (extracted to `src/model-availability.ts`); SDK contract tests pin the real `ModelRegistry` surface.
- **SDK contract tests:** new `sdk-contract.test.ts` guards against silent SDK drift (real ModelRegistry, env-independent).
- 646 tests across 31 files.

### v2.1.1

- **Background agent notifications:** the conductor sees a notification when a background agent completes, crashes, or times out (via `deliverAs: "followUp"`).
- **Custom preset discovery:** custom presets survive `pi install` updates — `.pi/brl-subagent/presets/` (project-local) and `~/.pi/agent/brl-subagent/presets/` (global), same YAML frontmatter format, override built-ins with the same name.
- **Live monitor & footer:** background subagents appear in the footer with live counters (running / completed / unseen); polling guards against double-decrement and stale contexts.
- **Tool system fixes:** `edit` auto-includes `write` (pi tool dependency chain); subagent prompt clarifies exactly which tools are available.
- **Removed:** sandbox system, backend system (dead code), 12 dead exports, 80K lines of bloat from git tracking.

### v2.1.0

- **Footer live counters:** Footer now shows background subagent activity with live counters.
- **Background subagent concurrency fix:** Fixed dynamic import and serialization queue for reliable parallel execution.
- **Tool system fix:** `edit` tool now auto-includes `write`; prompt clarifies which tools are available to subagents.
- **Backend system removed:** Removed dead backend code that was no longer used.
- **Foreground transcript recording:** All tasks now record transcripts for full observability.
- **Dead code cleanup:** Removed 12 unused exports across the codebase.
- **Phase 5 Hardening complete (H1–H4):** Pre-task validation, integration tests, post-mortem diagnostics, and conductor guardrails finalized.

### H1 — Pre-task validation

Deterministic pre-spawn checks that validate tool configuration and thinking level match the task description. Warns about **thinking level mismatches** (e.g., `off` thinking on a complex debugging task) and **missing tools** for the requested task. **Hard-rejects** combinations that cannot work — e.g. `outputFile` when the `write` tool is unavailable (a preset like `security-auditor` excludes it) — with a visible error before any tokens are spent.

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

# brl-subagent

> Multi-agent orchestration for [pi](https://github.com/earendil-works/pi-coding-agent) — chain, parallel, and dependency-graph delegation to isolated subagents with per-step model routing, preset-driven tool scoping, thinking-level control, and background execution with live monitoring, real abort, and per-agent timeouts.

**Version:** 2.1.7 · **Author:** Azmeen Afandi / Beeroo Labs · **License:** MIT

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
| `/brl-subagent priority` | Set default priority |
| `/brl-subagent approval` | Set change approval mode |
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
| `priority` | string | — | Concurrency priority: `critical` / `high` / `normal` / `low`. Overrides the configured default; higher-priority delegations queue ahead. |

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

### v2.1.7

- **Monitor drill-in — full-screen transcript overlay (issue #89):** in `/brl-subagent monitor`, select a row (↑/↓) and press enter for a **full-screen live view of the subagent's chain of thought** — the last ~6 messages rendered from the live session: 🧠 thinking blocks (dimmed tail), 🛠 tool calls, 💬 user messages, 📝 assistant text, plus the in-progress streaming message, refreshing every 200ms. Esc returns to the list. Prototype-first: built on a branch, tested live against a real background review, then promoted.
- **Top-level `model` param (issue #96):** `delegate_task` now accepts `model: "provider/model-id"` to override the model per call — previously only per-step (chain/tasks) had this, and a top-level `model:` was silently ignored (running the default instead). Precedence: per-call > preset > config > conductor; an invalid or unavailable override falls back with a warning.
- **Recurring-task scheduler removed (issue #91):** `/brl-subagent schedule` is gone — it only ran while pi was open (cron is the right tool for real recurrence), reached `delegate_task` through a fragile private API, and was never used. The graph-mode scheduler is unaffected.
- **README commands table pinned (issue #92):** a test now asserts the documented commands match the real dispatch in both directions — it already caught a stale row and an undocumented command.
- Shipped as 5 commits (#90, #93, #94, #97 + docs). 846 tests across 39 files.

### v2.1.6

- **Preset/template precedence fixed (issue #84):** the documented intent (PROJECT-LOCAL > USER-GLOBAL > BUILTIN) is now the actual behavior — both loaders dedup by name with project-first scanning. Previously a user-global override silently beat a project-local one; a test that had pinned the buggy behavior was inverted.
- **Builtin task templates (issue #66 follow-up):** 9 companion templates ship with the extension (`code-review`, `security-audit`, `write-tests`, `debug-issue`, `refactor`, `write-docs`, `analyze-data`, `implement-feature`, `prototype`) — one per builtin preset, each a thin teaching example with a `${param}` slot. The template architecture is now fully symmetric with presets: three tiers (builtin / user-global / project-local), identical precedence, same load lifecycle.
- **Tier labels in template browse:** `/brl-subagent templates` now shows `[B]`/`[G]`/`[P]` prefixes (and the detail view a tier suffix), so you can see at a glance which file to edit to override a template — mirroring the preset manager's convention.
- **Dangling preset references warn at load (issue #81):** a template whose `preset:` names a nonexistent preset no longer fails silently — a session-start cross-check warns naming the template, the dangling reference, and the consequence. Warn-not-skip: the run still proceeds preset-less, but the footgun is visible.
- Shipped as 4 commits (#85, #86, #87, #88). 827 tests across 38 files.

### v2.1.5

- **DevDeps aligned with the pi runtime (issue #69):** all four `@earendil-works/*` packages bumped to `^0.84.1` — the caret on a 0.x range previously forbade the running version, so the contract tests verified the wrong SDK. The delta was pre-investigated safe (abort contract byte-identical); the contract-test tripwire passes.
- **Dependabot live (issue #69 part 2):** grouped weekly updates (`pi-sdk` lockstep group + `other` group); every bump PR runs the full test suite as the tripwire. First PR merged (typebox 1.3.10).
- **Memory retention fixed (issue #31):** `_sessionRef` is released on every terminal path — a completed background agent no longer holds a live session object. The poller was made null-safe so the release can't be misread as a crash.
- **Silent test drift killed (issue #59):** `resolveSubagentParams` extracted from the index.ts closure into `src/params.ts`; the drifting test replica was deleted and 29 tests now exercise the real function — mutation-verified to catch regressions.
- **TUI hygiene (issues #61 #45):** the monitor row-render is DRY via pure `src/tui-format.ts` helpers (caught an already-drifted elapsed format and unified it); the misleading `/brl-subagent gitmode` menu was removed — the per-call `gitMode` param is the real control.
- **File-backed task templates (issue #66):** templates now live as frontmatter+body `.md` files (body = task, multiline by construction) in `~/.pi/agent/brl-subagent/templates/` or `<project>/.pi/brl-subagent/templates/` — mirroring the proven custom-preset pattern. The single-line TUI add/remove was removed; `/brl-subagent templates` browses. Dogfooded on a real review.
- **Crash-result builder (issue #68):** the 3× duplicated crash-catch envelope is now one `buildCrashResult`; `steer_subagent`/`stop_subagent` error paths pass `ctx.cwd` so sibling-project paths are properly masked.
- Shipped as 8 commits (#72, #73, #74, #76, #77, #78, #79, #80). 792 tests across 37 files.

### v2.1.4

- **Monitor liveness self-healing (issue #52):** the live monitor no longer shows stale "running" entries after the background poller dies mid-run (extension reload, crash). Both render loops sweep the live map and finalize entries that are provably terminal; `finalizeLiveSubagent` returns its claim so the sweep and a delayed poller can never double-decrement the active counter. Test storage is now injectable, so unit tests no longer pollute real `.pi/subagents` state.
- **Error & secret hygiene (issues #29 #30 #65):** persisted run data is written with owner-only permissions; error messages are sanitized before persist/echo (paths, trailing slashes, Windows boundaries), closing the residual raw-echo class across foreground, background tool-level, chain/graph, and runner paths.
  - **Permissions non-retroactive (issue #68):** files created before the #29 fix keep their original permissions — there is no automatic migration. Re-apply owner-only perms with e.g. `find ~/.pi/agent/brl-subagent -type f -exec chmod 600 {} +` and `find ~/.pi/agent/brl-subagent -type d -exec chmod 700 {} +` (project-local installs: do the same for their `.pi/subagents` and `.pi/output` trees).
- **H1 pre-task validation (issue #34):** chain/parallel/graph modes now run the same pre-task validation as single mode — `outputFile` + `readonly` conflicts are caught before dispatch instead of silently ignored.
- **Auto-route intent (issue #57):** an explicitly-specified `preset` in `delegate_task` is no longer overridden by auto-route.
- **Monitor row disambiguation (issue #55):** the live monitor shows a short agent id per row, so same-named subagents are distinguishable.
- Shipped as 8 commits (#58, #60, #62, #63, #64, #67, #70, #71). 732 tests across 35 files.

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

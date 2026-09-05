# Changelog

Release history for brl-subagent. Newest first. The full narrative for each release lives in the GitHub release notes.

### v2.3.4

- **The conductor knowledge gap closed (issue #154):** the LLM's only standing knowledge channel — the tool schema — was current for mechanics but stale at the behavioral layer, and two places actively taught the polling anti-pattern (pre-#147 text). The fix package: a new **AGENT.md** at the repo root (the authoritative agent-facing reference — execution models, the completion contract, delegation judgment, canonical shapes); **schema rewrites** replacing the poll-teaching text with the wake contract + the `completionNotify` knob dependency; a **generated template summary** in the guidance (mirroring the preset summary); a **pinning test** so behavioral features can't ship without their LLM-facing text. An adversarial review caught a critical interpolation bug (a `${…}` placeholder in a double-quoted string — dead code that shipped a literal placeholder, pre-existing in the preset line too) and a knob-inaccurate AGENT.md claim; both fixed, with the pinning test break-verified to genuinely catch regressions. The acceptance behavior — a conductor waiting for the wake instead of polling — was demonstrated live.
- **Development:** pi-sdk group aligned to ^0.85.0 (harness parity). The bump gate caught an upstream packaging gap — pi-coding-agent@0.85.0's main entry statically imports the undeclared `@earendil-works/pi-server`; a direct devDependency bridges it until pi declares the dep (filed upstream). 976 tests across 44 files.

### v2.3.3

- **Completion-push wake (issue #147):** the extension now pushes a structured completion message into the conductor's session when a background run reaches a terminal state — `pi.sendMessage` with `triggerTurn: true` wakes an idle conductor, so the user no longer relays "subagent has completed its work". The message carries id · duration · cost · error category + output tail + a soft directive; delivery mode follows the urgency split (failed/stopped → steer, completed → followUp); the `completionNotify` knob (`all` / `failed` / `off`) controls the wake while delivery stays always-on. Verified live end-to-end (completed, stopped, and mid-turn delivery) — the first milestone of the conductor-autonomy arc.
- **One notification per run (issue #149):** the poller's pre-existing short completion echoes (`Background agent "X" completed.`) are removed — they duplicated the #147 wake with strictly less information and bypassed the knob. Crash notices (the poller-unique edges) stay. Reviewed and merged after the double-notification was discovered live during the #147 probes.
- **Development:** toolchain aligned with pi itself — TypeScript 5.9.3 (pi's published compiler line) and the pi-sdk group at 0.84.4 (the running harness). The proposed TypeScript 7.0.2 major was declined: we follow the published SDK's line, not the dev-branch experiment. 971 tests across 43 files.

### v2.3.2

- **Honest termination records (issue #120):** user-cancelled and timed-out subagent runs no longer record an empty, indistinguishable failure — the kill paths stamp the abort source (`Subagent aborted by user` / `Timed out after Xms`) with honest error categories (`aborted` / `timeout`), foreground and background alike (including the catch-all path). Failure diagnostics also enrich the record with the model-error turn count. The status bar and SLA breakdown now tell the truth about how runs ended. (The dominant provider-side connection-error class is external — diagnosed and mitigated, not fixable here.)
- **Intercom [TO:] extraction only matches standalone lines (issue #129):** subagents that quoted the message format mid-sentence no longer have their instruction-quotes extracted as real messages — the anchored pattern + sender guidance keep the E10 channel clean, verified live with the exact adversarial shape (deepseek-v4-flash emitted both quote and real line; only the real line arrived).
- **Per-unit run-entry family complete (issue #136):** `finalizeUnitRunCrash`, `pruneHistoryIfNeeded`, and `registerLiveRun` single-source the remaining per-unit duplication — the #132 family's finish. The focused review caught and fixed a real label-fallback delta (unlabeled chain steps keep their `Step N` live label) before merge.
- **Dead code removed (issue #141):** the unused `stripMessageLines` function, its export, and its tests.
- **Process:** Rule 18 codified (termination triage + retry taxonomy + no time limits on implementers); every fix verified at point of use; all subagent dispatches background-by-default. 944 tests across 42 files.

### v2.3.1

- **Graph and chain runs visible in the live monitor (issue #130):** nodes and steps register with `/brl-subagent monitor` for the first time — each row shows label, model, and per-unit priority (the call-level floor now applies in chain mode too), and the drill-in streams the node's current work exactly like parallel subtasks. Registration follows issue #119's crash-protected pattern — a spawn throw finalizes the entry, so no stuck `running` ghosts.
- **Run records + status-bar breakdown for graph/chain (issue #133):** the reason #130's entries were invisible: the monitor's staleness sweep treats a foreground live entry without a persisted run entry as stale and finalizes it on the first render. Graph/chain now get the full run-record lifecycle (persist `running` at spawn → finalize with status/cost/tokens/output at completion → crash-protected), restoring the sweep's invariant with zero changes to the sweep. New surfaces: **aggregate dispatch entries** in run history ("Graph dispatch: N tasks in M waves") and a live **mode breakdown in the status bar** — `graph wave x/y · node x/y` and `chain step x/y` — composed with the background counters.
- **Process:** PR #134 was reviewed (adversarial, approve-with-nits → 3 findings fixed pre-merge), reviewed by the user before merge, and verified end-to-end at point of use — the monitor/status-bar/history ritual that failed three times during #130's verification now passes for both graph and chain probes. 912 tests across 41 files.

### v2.3.0

- **Parallel subtasks get run entries (issue #119):** the monitor's per-run drill-in now shows parallel subtasks like any other run — each subtask persists a `SubagentRun` at spawn (with its **per-unit priority** from issue #114) and finalizes at completion with status, model, duration, cost, tokens, and sanitized output. The prior known limitation (parallel priority was arbitration-only, invisible in the monitor) is closed. Crash-path finalize mirrors single mode (a spawn throw can no longer leave a stuck `running` entry).
- **Background run entries carry real cost + output (issue #122):** the finalized background run entry now populates `cost`/`tokensIn`/`tokensOut`/`outputSummary`/`fullOutput` — usage is extracted from the session's assistant messages (`accumulateUsage`, the same fold foreground uses) on every terminal path (completed, aborted, failed, catch-all). Timed-out runs no longer report zero tokens. The record's shape is fully honest (no undefined required fields).
- **Typecheck gate + 85 pre-existing type errors fixed (issue #117):** CI now runs `tsc --noEmit` (strict) between install and tests; a `typecheck` script and repo `tsconfig.json` (strict, bundler resolution, tests excluded) land with it. The 85 errors the gate surfaced — schema-vs-annotation drift, handler signatures mismatched to the SDK contract, a UI file written against a different SDK surface — are fixed at the root (17 remaining sites in the TUI are SDK-surface drift deliberately deferred to issue #124, marker-bridged with `@ts-expect-error` + issue refs). The pre-flight (`check-repo.sh`) runs the same gate locally, so drift is caught before a worktree builds on it.
- **Process:** PR #125 was reviewed in tiers (runtime-relevant adversarial tier → second opinion → checkpoint classification → config/markers), with the tiered protocol catching a dead-guard lie and three flaws in the proposed fix before merge. 892 tests across 40 files.

### v2.2.1

- **Priority: from config knob to per-unit arbitration (issue #114):** the `/brl-subagent priority` menu item is removed — priority is decomposition-relative (a unit's importance is unknowable until the conductor plans), so it belongs in the conversation, not configuration. In its place: **per-unit `priority` on `tasks[]`/`graph[]` items** (the units that actually compete for concurrency slots; `chain[]` deliberately excluded — the array order IS the priority). Retries now **preserve priority** (the retry snapshot was missing it — a per-call `critical` delegation silently lost its priority on retry). The drill-in monitor shows `p:<priority>` on runs that declare it. Known limitation: parallel subtasks have no per-subtask run entries (pre-existing), so their priority is arbitration-only, not yet visible in the monitor.

### v2.2.0

- **Foreground drill-in parity (issue #105):** the full-screen transcript overlay now works for **foreground** delegations too — the streaming `message_update` deltas (thinking/text/toolCall) that were previously discarded are captured and rendered through the same planner as the background path. Foreground runs also finalize + persist failed run entries on crash (no more stuck "running" rows) and fall back to the run entry's full output on stale selection. The monitor is now category-agnostic.
- **Background runs are retry-able (issue #98):** `spawnBackgroundSession` now persists a session run entry (`id == agent.id`) with an `originalParams` snapshot, finalized on every settle path — so `retryRunId: <agent-id>` resolves for background runs instead of silently no-oping. Unknown retry ids now fail loudly instead of warning quietly.
- **Warn on unknown `delegate_task` params (issue #99):** TypeBox's `Type.Object` allows additional properties by default and pi passes them through — a typo like `thinkinglevel` was silently ignored. `findUnknownParams` diffs received keys against the schema's known set and warns (never rejects). `priority` (critical/high/normal/low) is now a first-class schema param — fully plumbed to the concurrency queue for chain/parallel/graph/single modes. A ratchet test ties the known-key set to the registered schema, so the two can never drift.
- **Warn visibility (issue #110):** the unknown-param warn routes through `pi.sendMessage` (`delegate-notification`, `display: true`) so both the LLM and the human actually *see* the correction — `console.warn` alone is swallowed by the TUI.
- **Worktree tooling (issues #100/#106):** `worktree-prep.sh --force-isolated` for dependency-bump worktrees (with dangling-symlink repair and a pre-flight wiring), a post-merge staleness WARN in cleanup, and a worktree-guard backstop that blocks `npm install`/`npm ci` through a symlinked `node_modules`.
- **CI hardening (issue #104):** concurrency group with `cancel-in-progress` + 15-minute job timeout.
- **DRY (issue #108):** the 11-field `originalParams` snapshot is a single `snapshotOriginalParams` helper shared by both run-record creation sites.

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

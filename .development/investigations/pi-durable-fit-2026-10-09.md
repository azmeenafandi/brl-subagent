# Investigation: Adopting `@earendil-works/pi-durable` as brl-subagent's subagent execution substrate

- Worktree: `/home/azmeen/public_projects/brl-subagent_workspace/brl-subagent-wt-durable-fit` (branch `chore/durable-fit-assessment`)
- Date: 2026-10-09
- Status: COMPLETE (sections written incrementally; see git history of this file)
- Pinned subject: `@earendil-works/pi-durable@1.1.0` (published 2026-10-07, Experimental)
- Continuation: a prior attempt died before writing. Scratch reused from `/tmp/durable-probe/` (verified in E1c). No output file or commits existed before this run.

---

## Context established

### What brl-subagent is

`brl-subagent@2.4.0` is a pi coding-agent **extension** (single entry point `./src/index.ts`, declared under `package.json#pi.extensions`). It adds a `delegate_task` tool, presets, templates, chain/parallel/graph fan-out, a live TUI monitor, completion wakes, and "dispatch capability guards". It consumes the pi SDK:

```
peerDependencies: @earendil-works/pi-agent-core, pi-ai, pi-coding-agent, pi-tui, typebox
```

The extension executes inside a host pi session (the `ExtensionAPI`/`ExtensionContext` surface). Key modules (line counts in this worktree):

| File | lines | role |
|---|---|---|
| `src/index.ts` | 3950 | extension entry: tool/command registration, `delegate_task` handler, execution-mode runners, validation/guard orchestration |
| `src/tui.ts` | 2959 | live monitor rendering, drill-in, format helpers |
| `src/session-manager.ts` | 1163 | **background** agents: in-process `createAgentSession` sessions, steering, stop, completion pollers |
| `src/types.ts` | 982 | `SubagentRun`, `SubagentResult`, error classification, custom-entry constants |
| `src/runner.ts` | 906 | **foreground** agents: `pi` **subprocess** spawn + JSON-line parsing + usage accumulation |
| `src/state.ts` | 647 | session state container, run-entry write/read, stale-live sweep |
| `src/validate.ts` | 417 | H-preflight validation (H1 tool mismatch, etc.) |
| `src/schema.ts` | 254 | `delegateTaskParamsSchema` (TypeBox) |
| `src/params.ts` | 251 | `KNOWN_DELEGATE_KEYS`, `snapshotOriginalParams`, unknown-param detection |
| `src/history.ts` | 259 | `SubagentRun` store: create/finalize, `resolveRetryParams`, history pruning |
| `src/notify-completion.ts` | 233 | completion wakes back into the conductor |
| `src/unit-run.ts` | 274 | fan-out per-unit run records |
| `src/git.ts` | ~190 | git modes: `createWorkBranch`, `captureDiff`, `mergeWorkBranch`, `commitAll` |
| `src/presets.ts` / `src/templates.ts` | 560 / ~560 | markdown-backed preset/template loaders |

### What pi-durable is (pinned 1.1.0)

`@earendil-works/pi-durable` is a **durable agent harness**, published Experimental ("The API changes without notice between releases"). At pinned 1.1.0 it is NOT a dependency of the installed `pi-coding-agent@1.1.0` (E1). It exposes:

- `Harness.open(storage, { models, registry, settings, env, ... })`, `harness.resume()`, `harness.root()`, `harness.close()`.
- **Conversations** = immutable-entry transcripts; **Documents** = typed JSON state committed alongside entries (`pi.agent`, `pi.provider`, `pi.live`, `pi.inbox`, `pi.usage`); **Tasks** = durable state machines checkpointed per step; **Submissions** = durable inputs with idempotent `requestId`; **Extensions** = named bundles of tools/sections/hooks/tasks in a `Registry`.
- `commit-before-show`: nothing is displayed before its commit is stored. `replay: "safe"` controls whether a tool re-runs after a crash; otherwise it yields an `interrupted` result.
- Storage backends: `MemoryStorage`, `openNodeSqliteStorage(file)`, `openNodeJsonlStorage(dir)`, `openDurableObjectSqliteStorage(...)`.
- Observability: `Conversation.viewState()` / `watch()`, `harness.taskGraph()` / `watchTaskGraph()`, `watchEvents()`, `watchDoc()`, `harness.subscribeCommits()`.
- Child ownership: a task-owned conversation is a subagent; `ownership: { kind: "task", taskId }`; abort propagates top-down; `background: true` tasks are abort boundaries.
- Dependency closure: `chord`, `pi-ai`, `diff`, `typebox`; engines `node >=22.19.0`. Root loads TypeBox (~23 MB peak RSS unbundled).

### Task brief claim checked against reality

The brief says: *"Our subagents run as pi-coding-agent sessions spawned in-process by the extension; durability against process death is nil."*

**Partially contradicted by the code.** There are **two** execution paths:

1. **Background** (`spawnBackgroundSession`, `src/session-manager.ts:337+`): in-process `createAgentSession(...)` — matches the brief.
2. **Foreground** (`runSubagent`, `src/runner.ts:747+`): spawns a **subprocess** (`getPiInvocation` → `node <script>` / custom binary / `pi`, args from `buildSubagentArgs` = `--mode json -p --no-session …`). Does NOT match "spawned in-process".

Durability against process death is nil on both paths (E2): the foreground transcript lives only in the `pi` JSON stream parsed in memory (`--no-session`), and the background session is `SessionManager.inMemory(...)`. Run records are the only persisted artifacts, appended as pi session custom entries on the **conductor's** session.

---

## Evidence log

Rules: expected signature stated before each probe; empty searches print their query first. Coverage = exact command + printed count/range.

### E1 — pi-durable is NOT a dependency of the installed pi-coding-agent

**Expected:** no `pi-durable` reference in the installed 1.1.0 package.
**Probe / coverage:**
```
grep -n "durable" node_modules/@earendil-works/pi-coding-agent/package.json        # exit=1, 0 matches
node -e "console.log(Object.keys(require(...package.json).dependencies))"          # 23 names
grep -rin "durable" node_modules/@earendil-works/pi-coding-agent/dist/ | grep -v .map | wc -l   # 0
```
**Observed:** deps = `chord, pi-agent-core, pi-ai, pi-codemode, pi-mcp, pi-tui, photon-node, brace-expansion, chalk, cross-spawn, diff, grok-mermaid, highlight.js, hosted-git-info, ignore, jiti, minimatch, proper-lockfile, quickjs-wasi, semver, typebox, undici, yaml`. `dist/` grep = **0**. Published package ships `dist`, `docs`, `examples` — no `src/`. **Confirmed absent.**

### E1b — Installed README copy reconciliation
`diff /tmp/pi-durable-README.md /tmp/durable-probe/node_modules/@earendil-works/pi-durable/README.md` → **IDENTICAL** (36579 bytes). The prior attempt's fetched README is the pinned package README.

### E1c — Scratch install verified and reused
`/tmp/durable-probe/package.json` pins `"@earendil-works/pi-durable": "^1.1.0"`. Installed: `chord@1.1.0`, `pi-ai@1.1.0`, `pi-durable@1.1.0`, `pi-telemetry@1.1.0`. Node in this environment = **v24.14.1**; `node:sqlite` (`DatabaseSync`) available (used by `openNodeSqliteStorage`). **Reused, not re-installed.**

### E1d — pi-durable's dependency closure / exports
Deps = `chord ^1.1.0`, `pi-ai ^1.1.0`, `diff 8.0.4`, `typebox 1.3.27`; engines `node >=22.19.0`. Exports: `.`, `./tools`, `./env{,/node}`, `./storage/memory`, `./storage/jsonl{,/node}`, `./storage/sqlite{,/node,/cloudflare}`, `./testing`.

### E2 — The two execution paths, verified at the source
**Expected:** foreground = subprocess; background = in-process; neither persists a resumable transcript.
**Reads/coverage:** `src/runner.ts:67` `getPiInvocation`, `:170` `buildSubagentArgs` (`--mode json -p --no-session`), `:803` `spawn(...)`, `:624` `parseSubagentLine`; `src/session-manager.ts:337+` `spawnBackgroundSession` → `SessionManager.inMemory(effectiveCwd)` + `createAgentSession(...)`.
**Observed:** exactly as expected. Call sites: `runSubagent` at `src/index.ts:728,1198,1814,3310,3357`; `spawnBackgroundSession` at `src/index.ts:2276`.

### E3 — Convergence signal: pi's own monorepo builds an experimental agent on pi-durable
**Probes:** `gh api repos/earendil-works/pi/contents/packages/durable`; `gh api "search/code?q=pi-durable+repo:earendil-works/pi"`; `gh api "repos/earendil-works/pi/commits?path=packages/coding-agent/src/experimental/durable"`.
**Observed:**
- `packages/coding-agent/src/experimental/durable/` exists on `main`: `README.md` (3913 B), `harness-setup.ts` (4421), `runtime.ts` (14119), `prompt.ts` (3148), `subagent.ts` (2616), `tui.ts` (24985), `main.ts` (598), `sessions.ts` (1961).
- README: *"A small local coding agent on `@earendil-works/pi-durable`. One process owns the model runtime, the durable Harness, its SQLite storage, and the TUI. … the agent itself is the durable Harness with its built-in `CodingTools`."* Advertises kill-mid-tool-call durability via `--continue`, a child-owned `subagent` tool, and a `/tasks` panel.
- Commits: `2026-10-01T07:53:08Z 5609b0d6 feat(coding-agent): experimental TUI coding agent on pi-durable`; `2026-10-01T08:07:11Z 70c03621 show the durable TUI's task panel by default`; `2026-10-01T12:44:50Z 48dd1e2f port the experimental client/server to pi-durable` — **six days before v1.1.0 (2026-10-07)**.
- `packages/coding-agent/package.json` on `main`: version `1.1.0`, deps **do not include pi-durable** — the integration uses the monorepo `source` export condition.
- `packages/durable/CHANGELOG.md` on `main` = pinned 1.1.0 changelog + empty `## [Unreleased]`.
- **Parallel effort:** `pi-coding-agent`'s shipped CHANGELOG records an inherited `pi-agent-core` **`AgentHarness` v2** and v4 `Session`/`SessionRepo` "durable operation records", with unfinished paths rejecting `HarnessNotImplemented`. `pi-agent-core@1.1.0` grep for "durable" = **1** (a doc comment), and no `AgentHarness` symbol in its shipped dist.

**Interpretation (evidence-bounded):** pi IS investing in pi-durable for its own harness, but repo-only/experimental; the published `pi-coding-agent` does not depend on it and `pi-agent-core` ships a **separate** durable-execution effort. Directional convergence, no publish-boundary convergence.

### E4 — EMPIRICAL PROBE: crash mid-step → reopen → `resume()` continues
**Expected signature (stated before running):**
- Process A: prints `TICK 1`, writes crash marker, `process.exit(42)` **before** saving the next checkpoint; exits **42**.
- Persisted task record after A: status `running`/`pending`, checkpoint `{phase:"tick", n:1}`.
- Process B (fresh process, same storage): `getTask` before resume shows non-terminal; after `resume()`+`waitForTask`, runs `TICK 1,2,3` and outcome `{status:"completed", result:"counted to 3"}`.

**Setup:** custom durable task `probe.ticker` (`defineTask`, input `{to:3}`) whose `tick` phase exits the process mid-step on first run. Storage = `openNodeSqliteStorage("/tmp/durable-probe/probe-run/session.sqlite")`. Harness opened with `{ models: createModels(), registry }` (no provider/credentials needed; `createModels()` is providerless). Scripts `/tmp/durable-probe/probe-lib.mjs`, `probe-crash.mjs`, `probe-resume.mjs`.

**Observed (SQLite):**
```
A: TASKID 7 / PROCESS_A: scheduling / TICK 1 (to=3) / SIMULATED CRASH … / A_EXIT=42
B: BEFORE_RESUME: {"status":"pending","checkpoint":{"phase":"tick","n":1}}
   TICK 1 / TICK 2 / TICK 3
   AFTER_RESUME outcome: {"status":"completed","result":"counted to 3"}   B_EXIT=0
```
**Observed (JSONL, `openNodeJsonlStorage`):** identical — A exit 42; B `BEFORE_RESUME pending n=1` → `TICK 1,2,3` → `completed "counted to 3"`. (First JSONL attempt was invalidated by a probe bug — the crash marker path was not parameterized — and re-run cleanly after `PROBE_MARKER` was added; the invalid run completed without crashing and is discarded.)
**Result: matches expected exactly, on both backends. Core durability claim CONFIRMED.**

### E4b — Idempotent submissions (`requestId`)
**Expected:** two `submit()` calls with the same `requestId` return the same submission id, even with different content.
**Observed:** `S1 8 S2 8 EQUAL true`; `S3 (same requestId, different content) 8 EQUAL_S1 true`. **Confirmed.**

### E5 — The in-repo ratchets (Q2 inputs)
- `KNOWN_DELEGATE_KEYS` (`src/params.ts:48`) = 25 literal keys (`task`, `systemPrompt`, …, `chain`, `tasks`, `graph`, `force`). The registered schema ↔ `KNOWN_DELEGATE_KEYS` ↔ `DelegateTaskParams` chain is compile-time ratcheted via `_DelegateParamCoverage` (`src/index.ts:180`, `_ExpectNever<Exclude<_KnownDelegateKey, keyof DelegateTaskParams>>`) plus `_KnownDelegateKey` (`:178`). Runtime unknown-key warning at `src/index.ts:2795`.
- Retry-pins drift guard (`src/__tests__/retry-pins.test.ts`): pins that `snapshotOriginalParams` (`src/params.ts:96`) and `resolveRetryParams`' return literal (`src/history.ts:167`) stay in sync — "3a catches RESOLVE dropping any key … plus an absolute 19-key ratchet on the resolve side; 3b catches SNAPSHOT dropping a key". This is the #227/#229 class.
- Background retry is **parked**: README:108 — *"Background runs are not auto-retried — re-dispatch with `retryRunId`."* `retryOnTimeout` is documented **foreground-only** (`README:108,118`; `src/index.ts:3327` "Auto-retry on timeout" guarded by `params.retryOnTimeout`).

### E6 — TUI integration surface (Q3)
- `src/tui.ts` imports public surfaces only: `DynamicBorder, getMarkdownTheme` from `@earendil-works/pi-coding-agent`, and `Container, Component, SelectList, Spacer, Text, Markdown, matchesKey` from `@earendil-works/pi-tui`. It renders **run records** (read from session custom entries) — not a live conversation view. Launched via `pi.registerCommand("brl-subagent", …)` subcommands `monitor`/`dashboard`/`history`/`historyentries`/`retry` (`src/index.ts:2662–2691`) and `ctx.ui.custom(...)` (`src/tui.ts:91,412,470`).
- pi's experimental durable TUI (`experimental/durable/tui.ts`) imports pi-tui **and** pi-coding-agent *internal* source paths (`../../modes/interactive/components/...`, `../../core/tools/renderers/index.js`) — available only in-repo, not to a consumer extension.
- pi's experimental `runtime.ts` builds a plain-value `DurableView` with a `subscribe`/`current` source; it wires `Conversation.viewState()` → `conversation.subscribe`, `harness.subscribeCommits` for new subagent conversations, and `harness.taskGraph()` → `graph.subscribe`.

---

## Q1 — Convergence signal: is pi itself moving onto pi-durable?

**Evidence-only answer: DIRECTIONAL YES, but NOT at the publish boundary — and a parallel in-house durable harness competes.**

- Positive: pi's own monorepo carries a full experimental coding agent whose entire harness is pi-durable (E3), added 2026-10-01, and the durable package is under active release cadence (1.0.2→1.1.0 in the days before). Its own `subagent.ts` is literally the subagent pattern we would adopt.
- Negative/counter: (a) the published `pi-coding-agent@1.1.0` neither depends on nor references pi-durable (E1); (b) the experimental integration uses the monorepo `source` export, so it cannot be consumed from npm; (c) `pi-agent-core` ships a **separate** `AgentHarness` v2 / v4 durable-session effort that the shipped CHANGELOG describes as inheriting "durable execution" — a competing internal direction.

**Verdict: directionally toward pi-durable, but inconclusive as a commitment.** Naming/version alignment alone is explicitly not evidence and was not used.

## Q2 — File-by-file fit

| Our layer (symbol) | pi-durable equivalent | Verdict under Option A |
|---|---|---|
| `delegate_task` tool + chain/parallel/graph fan-out (`src/index.ts:2738+`) | `Harness` + registry tools; child conversations via `ownership:{kind:"task"}`; joins `failFast`/`allSettled` | **REBUILD** — the *delegation contract* (params, presets, fan-out semantics) survives; the engine is rewritten |
| `src/runner.ts` foreground (`runSubagent`, `getPiInvocation`, `buildSubagentArgs`) | generation over `models` + `NodeExecutionEnv`; `--mode json -p --no-session` disappears | **REPLACED** |
| `src/session-manager.ts` background (`spawnBackgroundSession`, `steerAgent`, `stopAgent`, `SessionManager.inMemory`) | child conversation owned by the call's task (or a `background` anchor task); `steer`/`abort` via `whenBusy:"steer"` / `conversation.abort()` | **REPLACED** |
| `src/history.ts` run records (`SubagentRun`, `finalizeRunRecord`, `resolveRetryParams`) | `TaskRecord`/`SubmissionRecord` via `getTask`/`scanTasks`/`waitForTask` | **REPLACED** (shape and API differ; run-history semantics must be re-derived) |
| `src/state.ts` session state + `.pi/subagents/` storage | Harness storage (SQLite/JSONL) + documents | **REPLACED** |
| `src/tui.ts` monitor/dashboard/history/drill-in | `Conversation.viewState()`/`watch()`, `taskGraph()`/`watchTaskGraph()`, `watchEvents()`; re-render with pi-tui | **REBUILT** (renderers reused; data source and analytics rebuilt) |
| `src/notify-completion.ts` wakes | `submit()` follow-up + `onReport` + `harness.subscribeCommits` | **REBUILT** |
| provider/secrets (`ctx.modelRegistry`, `getSafeEnv`) | `models` (pi-ai `Models`) resolved from pi's `ModelRuntime`; `NodeExecutionEnv` for fs/shell | **REBUILT** |
| approval (`approvalMode: "always"/"writes"/"auto"`, `src/index.ts:3401`) | `hook(ToolTask, { beforeTool })` returning `{block}` / argument rewrite | **REBUILT** (semantics must be re-encoded) |
| `src/git.ts` git modes (`createWorkBranch`, `captureDiff`, `mergeWorkBranch`, `commitAll`) | none | **KEEP** (wrap around the child; git is orthogonal) |
| `src/validate.ts` capability guards (`validatePreTask`, H1) | no equivalent (pi-durable validates tool args only) | **KEEP** |
| `src/schema.ts` + `params.ts` (`delegateTaskParamsSchema`, `KNOWN_DELEGATE_KEYS`, `_DelegateParamCoverage`) | no equivalent — our public contract | **KEEP** |
| `src/presets.ts` / `src/templates.ts` / `presets/**` / `templates/**` | `configure()` / `AgentDoc` for agent config; no preset/template loader | **KEEP files, REMAP** to `configure()` |
| Retry-pins drift guard (`snapshotOriginalParams` ↔ `resolveRetryParams`) | `requestId` idempotency + `resume()` | **PARTIALLY OBSOLETE** if retry is replaced by resume; otherwise KEEP |
| `src/concurrency.ts` / `src/scheduler.ts` | Harness task scheduler + settings concurrency | **REPLACED** (if adopted) |

**Survives:** the delegation contract (params/schema/ratchets), presets/templates as content, git modes, work banking (per-step commit discipline — a prompt/process property, see `presets/dev-agent.md:27`), and the idea of completion wakes.
**Must be rebuilt:** TUI attach, approval semantics, provider/secrets plumbing, run history/metrics/compliance, completion wakes, concurrency gating.

## Q3 — TUI attachment story

pi-durable's whole UI surface is committed state (E3/E6). Concretely:
- **Transcript:** `Conversation.viewState()` → `AttachedReplicatedState<ConversationView>`; `view.subscribe(value => …)` re-renders. `watch()` delivers the same view with the exact Chord ops per commit (for a remote client). Late joiners get a fresh view; nothing is replayed.
- **Task graph:** `harness.taskGraph()` → `AttachedReplicatedState<TaskGraph>`; `harness.watchTaskGraph()` → `TaskGraphWatch`. Each node carries owner edge, status, `background`, abort mark, owned conversations.
- **Events:** `watchEvents()` → `AgentEventStream` with `.snapshot` + `.start(events)` — coding-agent-style `message_start`/`tool_execution_start`/… with deltas (this is the closest match to our current monitor's streaming).
- **Live docs:** `value.docs["pi.live"]` (running generation partials, tool output, retries, compactions), `pi.inbox`, `pi.usage`, `pi.agent`, `pi.provider`.
- **Proven pattern:** pi's experimental `runtime.ts` builds a plain-value `DurableView` + `subscribe`, wires `Conversation.viewState()` and `harness.subscribeCommits`, and renders with pi-tui. Our `src/tui.ts` could do the same because it already consumes only *public* pi-tui + pi-coding-agent re-exports (E6) — no internal paths.

**Unknowns (written as unknowns):** whether our monitor's per-run analytics (cost/SLA, file-access report, sensitive-file report, compliance summary — `src/reports.ts`) can be derived from durable entries/documents without re-instrumenting; and how approval dialogs (`ctx.ui.custom`) interleave with pi-durable `beforeTool` hooks that execute inside the Harness (the hook API returns `{block}`/rewrite synchronously/asynchronously, but there is no documented UI-blocking approval primitive — a hook cannot await a user dialog the way our foreground approval flow does today). This is the single biggest TUI/UX unknown for Option A.

## Q4 — Empirical probe (see E4/E4b)

**CONFIRMED.** A task killed mid-step (`process.exit(42)` before its next checkpoint) leaves a non-terminal record; a fresh process over the same storage re-runs from the last committed checkpoint and reaches terminal (`counted to 3`), on **both SQLite and JSONL**. Idempotent `requestId` submissions also confirmed (same id, even with different content). No credentials were needed; no provider was configured.

## Q5 — Effort estimate (our units: C1 = small/targeted worktree PR, C2 = large/structural)

- **A. Adopt-as-substrate — ~8–12 C2 PRs.** Sequence: (1) dependency + storage + `NodeExecutionEnv`/`models` plumbing + a throwaway vertical slice of one `delegate_task`; (2) replace `session-manager` background with child-owned conversations; (3) replace `runner` foreground with generation over child conversations; (4) run-history/metrics/compliance rebuild on task records; (5) TUI `DurableView` + task panel; (6) approval via hooks (with the dialog unknown resolved); (7) git-mode wrapper; (8) presets/templates → `configure()`; (9) completion wakes; (10) fan-out joins; (11–12) migration of ratchets/tests and a deprecation path for stored run records. Highest risk; roughly a quarter-scale effort.
- **B. Mine-the-patterns — ~3–5 C1/C2 PRs.** (1) `dispatchId`/`parentRunId`/`resumeOf` on `SubagentRun` written before spawn; (2) session_start auto-resume of interrupted runs with idempotent dispatch; (3) incremental checkpoint of partial output/cost; (4) task-graph-style TUI panel from run records; (5) tests + ratchet sync. Incremental, no new dependency.
- **C. Wait/watch — 0 PRs now; ~1 C1 PR per re-evaluation.** Track pi-durable's Experimental status and whether `pi-coding-agent` starts depending on it; the trigger to revisit A is "pi-durable leaves Experimental" and/or "the published coding-agent depends on it".
- **D. Do-nothing — 0 PRs.** Baseline.

## Q6 — The parked "background retries" decision

Today (README:108): background runs are **not** auto-retried; a failed run is re-dispatched with `retryRunId`. `retryOnTimeout` is foreground-only (E5).

- **Under A (adopt):** `resume()` replaces auto-retry **only for interrupted (crashed) runs** — it continues from the last checkpoint. A terminal *failure* (provider error, model refusal, `unanswered`) is not a crash and is not resumed. So a **retry policy is still needed** for logical failure. pi-durable supplies `settings.retry` (stream retry) and compaction retry, plus join policies; the parked decision becomes "do we add a policy for `unanswered` submissions?" — resume does not answer it.
- **Under B (mine):** no engine-level resume; both an explicit retry policy and an explicit crash-resume policy are needed. Idempotent dispatch ids make a resume **safe**, but the policy (auto vs manual) is still a decision.
- **Under C/D:** unchanged — background runs are not auto-retried.

**Bottom line: `resume` does not replace a retry policy; it complements it.** Retry handles "ran to a terminal failure"; resume handles "process died mid-run". The parked decision is about the former and is orthogonal.

---

## Options

### Option A — Adopt pi-durable as the subagent execution substrate
- **Mechanism:** `Harness` over SQLite (or JSONL) storage; each `delegate_task` creates a child conversation owned by the call's task, submits the task with a stable `requestId`, and waits or backgrounds it. Presets/templates configure the child via `configure()`. Registry installs `CodingTools` + our prompt/preset sections. Git modes wrap the child. TUI renders `viewState()` + `taskGraph()`. Run records become task/submission records.
- **Blast radius:** `src/index.ts`, `src/runner.ts`, `src/session-manager.ts`, `src/history.ts`, `src/state.ts`, `src/tui.ts`, `src/notify-completion.ts`, `src/concurrency.ts`, `src/scheduler.ts`; `package.json` gains an Experimental dependency shipped to users; retry-pins drift guard partially obsolete. Ratchets `KNOWN_DELEGATE_KEYS`/`_DelegateParamCoverage` survive unchanged.
- **Cost / risk:** ~8–12 C2 PRs. Risk if analysis wrong: pi-durable's Experimental API churns under us and forces repeated migrations; foreground runs lose the ability to run on a bare `pi` binary (Node ≥22.19 + `node:sqlite` required in-process); approval dialogs may have no hook primitive.
- **Verification:** vertical-slice probe (delegate one task end-to-end), crash/resume test (E4 pattern), full test-suite parity, ratchet tests. Falsified if a single `delegate_task` cannot be expressed without reimplementing generation, or if approval cannot block a tool call.

### Option B — Mine the patterns into the current design (RECOMMENDED)
- **Mechanism:** keep the architecture; add (1) a stable `dispatchId` + `parentRunId`/`resumeOf` to `SubagentRun`, written **before** the spawn (intent-before-effect); (2) session_start auto-resume of interrupted runs guarded by the idempotent `dispatchId`; (3) per-step checkpointing of partial output/cost as the JSON stream is parsed; (4) a task-graph-style TUI panel derived from `parentRunId`; (5) completion wakes unchanged.
- **Blast radius:** additive fields on `SubagentRun` (`src/types.ts`, `src/history.ts`, `src/state.ts`), new logic in `src/index.ts` `session_start` (line 3827) and dispatch sites, new panel in `src/tui.ts`, tests. No new dependency; no user migration. If a `resumeOf`/`dispatchId` param is exposed on `delegate_task`, the schema↔`KNOWN_DELEGATE_KEYS`↔`DelegateTaskParams` chain and both snapshot/resolve literals must be updated together (E5).
- **Cost / risk:** ~3–5 C1/C2 PRs. Risk if analysis wrong: checkpointed resumption of a *subprocess* run may be coarse — if the `pi` JSON stream cannot be replayed, "resume" degrades to "re-run from scratch" (still better than losing the record, but not true continuation). This is the central falsifier.
- **Verification:** crash harness (kill a foreground run mid-flight, re-open, assert no duplicate run and a resumable/retried state), unit tests on idempotent dispatch, TUI snapshot test, ratchet test.

### Option C — Wait / watch
- **Mechanism:** no substrate change; re-evaluate when pi-durable leaves Experimental or `pi-coding-agent` depends on it.
- **Blast radius:** none. **Cost:** 0 now. **Risk if wrong:** if the effective (dependency + ratchet) adoption cost grows, or pi's default harness shifts and forces migration without lead time — mitigated by reusing pi's own experimental port as a template.

### Option D — Do-nothing (baseline)
- **Mechanism:** keep nil crash durability; rely on run records + `retryRunId`.
- **Blast radius:** none. **Cost:** 0. **Risk:** a process death still loses the in-flight subagent run; the conductor must notice and re-dispatch manually.

### Options table

| Option | Mechanism | Blast radius | Cost | Risk-if-wrong |
|---|---|---|---|---|
| A Adopt substrate | `Harness`+child conversations replace runner/session-manager | ~10 core files + new Experimental dep + TUI/approval rebuild | 8–12 C2 PRs | Experimental API churn forces repeat migrations; approval has no hook primitive; Node/`node:sqlite` runtime requirement |
| B Mine patterns | `dispatchId`/`parentRunId`/checkpoints on `SubagentRun` | additive fields + session_start resume + TUI panel | 3–5 C1/C2 PRs | subprocess JSON stream not replayable ⇒ resume is coarse re-run |
| C Wait/watch | no change; track Experimental→stable | none | 0 now, ~1 C1 per review | forced migration with little lead time |
| D Do-nothing | unchanged | none | 0 | crash still loses the run |

## Recommendation + falsifiers + execution sketch

**Recommendation: Option B — mine the patterns**, with **C (watch)** as the trigger to revisit A. Rationale: the durable *value* (survive process death / idempotent dispatch) is real and cheaply capturable in our own records; pi-durable is Experimental, unpublished as a coding-agent dependency, and pi-agent-core is pursuing a **parallel** durable harness — betting the extension's whole substrate on it now imports API-churn risk and a large TUI/approval/provider rebuild for a benefit we can get incrementally. The convergence signal is directional, not a commitment (Q1).

**Falsifiers (what would change the recommendation to A):**
1. `pi-durable` drops the "Experimental" label on npm AND `pi-coding-agent`'s published `package.json` depends on or re-exports it. Then A's migration risk collapses and reuse becomes the low-cost path.
2. A spike proves approval can be expressed as a pi-durable hook (or the hook can await a UI dialog) and the TUI attach is mostly `viewState()` wiring — dropping A's cost materially.
3. The Option B crash harness shows a foreground subprocess run cannot be checkpointed/resumed at all (the `pi` JSON stream is not replayable), collapsing B's central benefit.

**Conductor-ready execution sketch — Option B, in order:**
1. **Intent-before-effect record:** add `dispatchId` (stable id generated before spawn), `parentRunId`, `resumeOf` to `SubagentRun` (`src/types.ts`), defaulted/optional so existing records parse (mirror `isSubagentRunShape`'s permissive contract). Persist the record before `spawn`/`createAgentSession`. Verify: unit test that the record exists with a terminal-less status at the moment of spawn.
2. **Idempotent dispatch guard:** an `execute()` path that, given a `dispatchId`, returns the existing run instead of creating a second one. Ratchet: if exposed as a delegate param, update `src/schema.ts` + `KNOWN_DELEGATE_KEYS` + `_DelegateParamCoverage` + BOTH `snapshotOriginalParams` and `resolveRetryParams` in one commit (E5).
3. **session_start recovery:** in `pi.on("session_start", …)` (`src/index.ts:3827`), scan `state.getRunEntries(ctx)` for non-terminal runs; mark them interrupted; surface/auto-resume guarded by `dispatchId`. Do not duplicate the stale-live sweep (`src/state.ts:616`).
4. **Per-step checkpointing:** while parsing the subagent JSON stream (`parseSubagentLine`, `src/runner.ts:624`) and in `spawnBackgroundSession`'s poller, persist partial output/usage into the run record on a bounded interval (reuse `LIVE_UPDATE_MIN_INTERVAL_MS = 200`).
5. **Task-graph TUI panel:** derive parent→child edges from `parentRunId`; render in `src/tui.ts` alongside the existing monitor (reuse `Container`/`Text` from pi-tui). Verify with a snapshot test.
6. **Metrics/compliance:** keep `src/reports.ts` reads on run records; confirm no new reads were introduced.
7. **Watch trigger doc:** record the falsifier-1 condition in a decision doc (`src/.development/decisions/`) so the A-vs-B revisit is scheduled, not accidental.

## Boundaries — what was NOT verified

- **Storage backends beyond SQLite and JSONL:** Memory and the Cloudflare Durable Object adapter were not probed; only the two Node file backends.
- **No real model/generation path was exercised:** `createModels()` was providerless. Generation, streaming partials, provider prompt-cache/`sessionId`, tool execution, compaction, and usage accounting were **not** run end-to-end. The E4 probe tested the *task scheduler + storage + resume*, not generation.
- **Benchmarks not run:** `bench:storage`, `bench:storage:memory`, `bench:tool-output`, and the README's ~23 MB/4 MB RSS figures were **not** independently measured.
- **Long-run stability / concurrent processes:** only sequential crash-reopen was tested. No cross-process locking behavior, multi-agent concurrency, or long-session stability.
- **Approval/hook semantics:** the pi-durable `beforeTool` hook's ability to block on a UI approval dialog is **unresolved** (Q3 unknown); no probe attempted.
- **`resume()` scheduler internals:** whether a task that was `running` when killed can double-execute a non-idempotent side effect was not audited beyond the at-least-once rerun observed in E4.
- **Convergence:** `gh` code search returned 109 items but was not exhaustively read; only the coding-agent `experimental/durable` package, `package.json`, `CHANGELOG`, and commit history were inspected. `packages/agent/CHANGELOG.md` and root `README.md` mentions were seen in the result list but not read.
- **Ratchet exhaustiveness:** `KNOWN_DELEGATE_KEYS` was read in full (25 keys); the retry-pins guard was read from its header comment, not executed.

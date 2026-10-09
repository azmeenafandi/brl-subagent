# Investigation: Adopting `@earendil-works/pi-durable` as brl-subagent's subagent execution substrate

- Worktree: `/home/azmeen/public_projects/brl-subagent_workspace/brl-subagent-wt-durable-fit` (branch `chore/durable-fit-assessment`)
- Date: 2026-10-09
- Status: IN PROGRESS (sections written incrementally; see git history of this file)
- Pinned subject: `@earendil-works/pi-durable@1.1.0` (published 2026-10-07, Experimental)
- Continuation: a prior attempt died before writing. Scratch reused from `/tmp/durable-probe/` (verified below). No output file or commits existed before this run.

---

## Context established

### What brl-subagent is

`brl-subagent@2.4.0` is a pi coding-agent **extension** (single entry point `./src/index.ts`, declared under `package.json#pi.extensions`). It adds a `delegate_task` tool, presets, templates, chain/parallel/graph fan-out, a live TUI monitor, completion wakes, and "dispatch capability guards". It is a consumer of the pi SDK:

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
| `src/concurrency.ts` | 187 | concurrency limit gate |
| `src/scheduler.ts` | 188 | scheduling primitive |

### What pi-durable is (pinned 1.1.0)

`@earendil-works/pi-durable` is a **durable agent harness**, published Experimental ("The API changes without notice between releases"). It is the subject of this investigation, NOT (at pinned 1.1.0) a dependency of the installed `pi-coding-agent@1.1.0` (verified in Evidence E1.1). It exposes:

- `Harness.open(storage, { models, registry, settings, env, ... })`, `harness.resume()` (Evidence E3.x), `harness.root()`, `harness.close()`.
- **Conversations** = immutable-entry transcripts; **Documents** = typed JSON state committed alongside entries (`pi.agent`, `pi.provider`, `pi.live`, `pi.inbox`, `pi.usage`); **Tasks** = durable state machines checkpointed per step; **Submissions** = durable inputs with idempotent `requestId`; **Extensions** = named bundles of tools/sections/hooks/tasks in a `Registry`.
- `commit-before-show`: nothing is displayed before its commit is stored. `replay: "safe"` controls whether a tool re-runs after a crash; otherwise it yields an `interrupted` result.
- Storage backends: `MemoryStorage`, `openNodeSqliteStorage(file)`, `openNodeJsonlStorage(dir)`, `openDurableObjectSqliteStorage(...)`.
- Observability: `Conversation.viewState()` / `watch()`, `harness.taskGraph()` / `watchTaskGraph()`, `watchEvents()` (coding-agent-style event stream), `watchDoc()`.
- Child ownership: a task-owned conversation is a subagent; `ownership: { kind: "task", taskId }`; abort propagates top-down; background tasks are abort boundaries.

### Task brief claim checked against reality

The brief says: *"Our subagents run as pi-coding-agent sessions spawned in-process by the extension; durability against process death is nil."*

**Partially contradicted by the code.** There are **two** execution paths:

1. **Background** (`spawnBackgroundSession`, `src/session-manager.ts:337+`): in-process `createAgentSession(...)` — matches the brief.
2. **Foreground** (`runSubagent`, `src/runner.ts:747+`): spawns a **subprocess** (`getPiInvocation` → `node <script>` / custom binary / `pi`, built by `buildSubagentArgs` with `--mode json -p --no-session`). This does NOT match "spawned in-process".

Durability against process death is indeed nil on both paths: the foreground subprocess's transcript lives only in the `pi` JSON stream parsed in memory (`--no-session`), and the background session is `SessionManager.inMemory(...)` (see Evidence E2.x). Run records are the only persisted artifacts, and they are appended as pi session custom entries (`pi.appendEntry`), which live in the *conductor's* session, not in a crash-safe sidecar with independent ownership.

---

## Evidence log

Rules: expected signature stated before each probe; empty searches print their query first. Coverage = exact command + printed count/range.

### E1 — pi-durable is NOT a dependency of the installed pi-coding-agent

**Query/claim:** `@earendil-works/pi-durable` does not appear in `node_modules/@earendil-works/pi-coding-agent/package.json` dependencies.
**Probe:**
```
grep -n "durable" node_modules/@earendil-works/pi-coding-agent/package.json   # exit=1, no output
node -e "console.log(Object.keys(require('.../package.json').dependencies))"    # 22 deps, no pi-durable
grep -rin "durable" node_modules/@earendil-works/pi-coding-agent/dist/ | grep -v .map | wc -l
```
**Observed:** local `grep` exit=1 (0 matches in package.json). Dependency list = `chord, pi-agent-core, pi-ai, pi-codemode, pi-mcp, pi-tui, photon-node, brace-expansion, chalk, cross-spawn, diff, grok-mermaid, highlight.js, hosted-git-info, ignore, jiti, minimatch, proper-lockfile, quickjs-wasi, semver, typebox, undici, yaml` (23 names). `dist/` grep for "durable" = **0** matches. Local `src/` is NOT shipped (published package ships `dist`, `docs`, `examples` only). **Confirmed: no dependency, no runtime reference at 1.1.0.**

### E1b — Installed README copy reconciliation

`diff /tmp/pi-durable-README.md /tmp/durable-probe/node_modules/@earendil-works/pi-durable/README.md` → **IDENTICAL**. The prior attempt's fetched README can be trusted as the pinned package README (36579 bytes).

### E1c — Scratch install verified and reusable

```
cat /tmp/durable-probe/package.json      # "@earendil-works/pi-durable": "^1.1.0"
ls /tmp/durable-probe/node_modules/@earendil-works/  # chord, pi-ai, pi-durable, pi-telemetry
```
Versions installed: `chord@1.1.0`, `pi-ai@1.1.0`, `pi-durable@1.1.0`, `pi-telemetry@1.1.0`. **pi-durable 1.1.0 + its runtime deps (chord, pi-ai) present.** Reused; NOT re-installed.

### E1d — pi-durable's own dependency closure

`pi-durable@1.1.0` dependencies = `@earendil-works/chord ^1.1.0`, `@earendil-works/pi-ai ^1.1.0`, `diff 8.0.4`, `typebox 1.3.27`. Engines: `node >=22.19.0`. Package root loads TypeBox; ~23 MB peak RSS unbundled, ~4 MB tree-shaken (README "Storage" note). Exports include `./storage/memory`, `./storage/jsonl{,/node}`, `./storage/sqlite{,/node,/cloudflare}`, `./tools`, `./testing`, `./env{,/node}`.

### E2 — The two execution paths, verified at the source

**Expected:** foreground delegates are subprocesses; background delegates are in-process SDK sessions; neither persists a resumable transcript.

**Reads:**
- `src/runner.ts:67` `getPiInvocation` returns `{ command, args }` and `src/runner.ts:803` `spawn(invocation.command, invocation.args, { stdio: ["ignore","pipe","pipe"], ... })` with `args` from `buildSubagentArgs` (`src/runner.ts:170`) = `--mode json -p --no-session --model … --thinking …` — **foreground = subprocess**, transcript never persisted (`--no-session`), parsed line-by-line by `parseSubagentLine` (`src/runner.ts:624`).
- `src/session-manager.ts:337+` `spawnBackgroundSession` dynamically imports the SDK and calls `SessionManager.inMemory(effectiveCwd)` + `createAgentSession(...)` — **background = in-process, in-memory session**.

**Observed:** as expected; the brief's "in-process" is true only for background. (Coverage: both functions read in full/sufficiently; line anchors named.)

### E3 — Convergence signal: pi's own monorepo has an experimental coding agent on pi-durable

**Query:** does pi itself move onto pi-durable? Evidence only from shipped code/CHANGELOG/docs and repo history.

**Probes (network, `gh`/`curl`):**
```
gh api repos/earendil-works/pi/contents/packages/durable            # exists on main
gh api "search/code?q=pi-durable+repo:earendil-works/pi"            # total_count 109
gh api "repos/earendil-works/pi/commits?path=packages/coding-agent/src/experimental/durable"
```
**Observed — STRONG directional signal:**
- `packages/coding-agent/src/experimental/durable/` exists on `main` with: `README.md` (3913 B), `main.ts` (598), `sessions.ts` (1961), `runtime.ts` (14119), `prompt.ts` (3148), `subagent.ts` (2616), `tui.ts` (24985), `harness-setup.ts` (4421).
- Its README: *"A small local coding agent on `@earendil-works/pi-durable`. One process owns the model runtime, the durable Harness, its SQLite storage, and the TUI. … the agent itself is the durable Harness with its built-in `CodingTools`."* Sessions live under `~/.pi/agent/experimental/durable-sessions/<cwd-hash>/<session>/session.sqlite`. It advertises durability ("Kill the process in the middle of a tool call and start it again with `--continue`"), a `subagent` tool in a child owned conversation, and a `/tasks` task-graph panel.
- Commit history for that directory: `2026-10-01T07:53:08Z 5609b0d6 feat(coding-agent): experimental TUI coding agent on pi-durable`; `2026-10-01T08:07:11Z 70c03621 show the durable TUI's task panel by default`; `2026-10-01T12:44:50Z 48dd1e2f feat(coding-agent): port the experimental client/server to pi-durable`. **Added 2026-10-01, i.e. six days BEFORE the 2026-10-07 v1.1.0 release.**
- `packages/coding-agent/package.json` on `main`: version `1.1.0`, dependencies **do not include pi-durable** (same 23-name list as E1). The experimental integration uses the monorepo `source` export condition, not a published dependency.
- `packages/durable/CHANGELOG.md` on `main` matches the pinned 1.1.0 changelog plus an empty `## [Unreleased]`. `pi-durable@1.1.0` was released `2026-10-07T21:33:33Z` (`Release v1.1.0` commit).
- **Parallel/competing effort:** pi-coding-agent's `CHANGELOG.md` (shipped 1.1.0) records an inherited **`AgentHarness` v2** in `pi-agent-core`: *"Promoted the inherited v2 session and `AgentHarness` API from pi-agent-core's experimental entrypoint to its default export"*, *"Added the inherited compile-complete `AgentHarness` v2 scaffold; unfinished operation paths reject with `HarnessNotImplemented` while durable execution is implemented"*, and *"Replaced the inherited pi-agent-core harness session model with the v4 lane-based `Session`, `SessionStorage`, and `SessionRepo` APIs, including durable operation records"*. `pi-agent-core@1.1.0` grep for "durable" = **1** match (`dist/types.d.ts:427`, a recovery-policy doc comment); no `AgentHarness` symbol in the shipped `pi-agent-core` dist.

**Interpretation (evidence-bounded):** pi IS investing in pi-durable for its own agent harness (experimental, repo-only), but the published `pi-coding-agent` does not depend on it and `pi-agent-core` ships a **separate** v4/`AgentHarness` v2 durable-execution effort. **Not yet convergent at the publish boundary; the direction of travel can be read as toward pi-durable, but pi-agent-core's own harness is a live alternative.** Q1 detail follows in the Q1 section.

---

## Q1–Q6 findings

_(to be filled)_

## Options

_(to be filled)_

## Recommendation + falsifiers + execution sketch

_(to be filled)_

## Boundaries

_(to be filled)_

# Investigation: Option B prerequisites — what survives a process death during a subagent run

- Worktree: `/home/azmeen/public_projects/brl-subagent_workspace/brl-subagent-wt-optionb-probes`
- Branch: `chore/optionb-probes` @ `5f343fc` (== dev checkout HEAD, == `brl-subagent-dev` @ `5f343fc`)
- Date: 2026-10-09
- Status: IN PROGRESS (sections written incrementally)
- Method: Rule 12 — environment before theory. Empirical probes P1–P4.

---

## Environment (debug-task checklist)

| # | Check | Result |
|---|-------|--------|
| 1 | SDK/runtime installed | node `v24.14.1`; `@earendil-works/pi-coding-agent@1.1.0`, `pi-agent-core@1.1.0`, `pi-ai@1.1.0`, `pi-tui@1.1.0`; `pi` CLI `1.1.0` (`~/.local/share/pnpm/bin/pi`). |
| 2 | Lockfile consistency | `package-lock.json` pins all `@earendil-works/*` at `1.1.0`; installed matches. **Consistent.** |
| 3 | Extension synced | `diff -rq src /…/brl-subagent-dev/src --exclude=__tests__` → **exit 0, no output**. Worktree HEAD == dev HEAD == `5f343fc`. `node_modules` symlinks to the shared dev tree (worktree-prep done). |
| 4 | Running extension current | Global settings (`~/.pi/agent/settings.json`) `packages` includes `…/brl-subagent-dev` (dev checkout, not this worktree). `/reload` unverifiable from here; irrelevant for probes because every probe loads fresh via `pi -ne -e <worktree>`. No code drift (check 3). |
| 5 | Env vars | Conductor env: `PI_CODING_AGENT=true`, `PI_SESSION_ID=01a12029-…`, `PI_PROVIDER=deepseek`, `PI_MODEL=deepseek-flash`, `PI_REASONING_LEVEL=high`. Extension-readable vars: `BRL_LOG_LEVEL`, `BRL_LOG_CONSOLE` (`src/logging.ts:66,85`), `BRL_PI_BIN` (`src/runner.ts:68`), `BRL_*_DEPTH` (`src/sanitize.ts:401`). None required for probes. `pi auth check --provider deepseek` → `ready`. |
| 6 | Audit trail | `.pi/output/agent-12ed7d4b-….jsonl` — a completed "Say hello" agent. Run records live in TWO stores: **`.pi/subagents/<id>.json`** (background agent records; `src/session-manager.ts:59` `STORAGE_DIR`, `persistAgent`) and **pi session custom entries** `CUSTOM_ENTRY_TYPES.run` (`state.persistRun` → `pi.appendEntry`, `src/state.ts:223-224`; background also appends at `src/session-manager.ts:508,577`). |

**Environment verdict: no environmental defect found. Versions consistent, worktree synced, storage layout identified. Proceed to source + empirical probes.**

---

## P3 — SDK resume capability (BIGGEST UNKNOWN)

### Expected signature (stated before reading/probing)
- If a session load/resume/fork API is reachable from `createAgentSession`, it will appear in the installed `dist/index.d.ts` barrel and `dist/core/session-manager.d.ts` / `agent-session*.d.ts`.
- If `SessionManager.inMemory()` means "no persistence", `isPersisted()` will be false and no file will be created.

### Read-only evidence (installed `pi-coding-agent@1.1.0` type surface, `dist/`)

Exports relevant to resume (from `dist/index.d.ts:20-21`):
- `createAgentSession`, `createAgentSessionFromServices`, `createAgentSessionRuntime`, `createAgentSessionServices` (from `./core/sdk.ts`).
- `SessionManager` plus `parseSessionEntries`, `loadEntriesFromFile`, `buildSessionContext`, etc.

`SessionManager` static API (`dist/core/session-manager.d.ts:361-425`):
- `static create(cwd, sessionDir?, options?)` — new file-backed session.
- `static open(path, sessionDir?, cwdOverride?)` — **load a specific session file**.
- `static continueRecent(cwd, sessionDir?)` — **resume the most recent session** (or create new).
- `static inMemory(cwd?, options?, entries?)` — in-memory, no file persistence.
- `static forkFrom(sourcePath, targetCwd, sessionDir?, options?)` — **fork** a session into another cwd.
- `static findById(cwd, id, sessionDir?)`, `static list(...)`.

`createAgentSession(options: CreateAgentSessionOptions)` (`dist/core/sdk.d.ts:14-68`): accepts `sessionManager?: SessionManager`. Implementation (`dist/core/sdk.js:77,84`) does:
```js
const sessionManager = options.sessionManager ?? SessionManager.create(cwd, getDefaultSessionDir(cwd, agentDir));
...
const existingSession = sessionManager.buildSessionContext();
```
→ **Resume = construct a `SessionManager` pointed at an existing/forked session and pass it in.** There is **no `AgentSession.resume()` method**; the continuation is achieved by re-creating the session over the persisted `sessionManager`.

`AgentSessionRuntime` (`dist/core/agent-session-runtime.d.ts:53-140`) adds host-level replacement: `switchSession(sessionPath, …)`, `newSession(…)`, `fork(entryId, …)`, `importFromJsonl(inputPath, …)`. These are returned by `createAgentSessionRuntime` (a full host runtime), **not** by `createAgentSession` (which returns only `{ session, extensionsResult }`). An extension calling `createAgentSession` directly does not get these; it must rebuild over a `SessionManager`.

**Documentation defect found:** the `createAgentSession` JSDoc (`dist/core/sdk.d.ts`, `dist/core/sdk.js:50-52`) shows `await createAgentSession({ continueSession: true })`, but **`continueSession` is NOT a field of `CreateAgentSessionOptions` and is NOT consumed by the implementation** (`grep continueSession` in `sdk.js` returns only the JSDoc lines; `sdk.d.ts` has no such field). Do not rely on it.

### `SessionManager.inMemory` semantics (verified in JS)
- `static inMemory(...)` → `new SessionManager(cwd, "", undefined, false, options, entries)` (`dist/core/session-manager.js:1364-1366`); the 4th ctor arg is `persist = false`.
- `_persist(entry)` → `if (!this.persist || !this.sessionFile) return;` (`:794-796`). **Nothing hits disk.**
- A file is created only once a user/assistant *message* exists (`_hasConversation`, `:791-793`); setup-only entries stay in memory.

### Empirical probe (deterministic, no model calls)

Scratch: `/tmp/optb-sdk-probe/probe.mjs` (imports the installed dist by absolute path). Expected signatures stated before each run.

| Step | Expected | Observed |
|---|---|---|
| `write-mem` (inMemory, append user+custom, SIGKILL self) | `isPersisted=false file=undefined entries=2`, exit 137, **no file** | `MEM isPersisted= false file= undefined` / `MEM entries= 2` / exit **137** / `sessions/` **does not exist** |
| `write-file` (SessionManager.create, append user+custom, SIGKILL self) | `isPersisted=true file=<path> exists=true entries=2`, exit 137, file survives | `FILE isPersisted= true file= /tmp/optb-sdk-probe/sessions/2026-10-09T10-19-29-317Z_01a1202c-….jsonl exists= true` / `entries= 2` / exit **137** |
| raw file after SIGKILL | header + message + custom = **3 lines** | 3 lines (session header, `type:"message"` user, `type:"custom"` probe) |
| `reopen` (`SessionManager.open(path)` → `buildSessionContext` → `createAgentSession({sessionManager})`) | entries=2, contextMessages=1, agentSession.messages=1 | `REOPEN entries= 2` / `contextMessages= 1` / `agentSession.messages= 1` / same `sessionId` |

Coverage: `node probe.mjs write-mem|write-file|reopen`; each printed exactly the lines quoted; DIR listing printed (1 file for file-backed, absent for inMemory).

### P3 verdict
- **An SDK resume/load/fork capability EXISTS** — but it is *session-file-based*: `SessionManager.open|continueRecent|forkFrom` + `createAgentSession({sessionManager})`. Persistence is append-per-entry JSONL, so a SIGKILL preserves everything up to the last appended entry.
- **`SessionManager.inMemory` persists nothing** — confirmed empirically. brl-subagent's background path constructs exactly this (`src/session-manager.ts:398` `SessionManager.inMemory(effectiveCwd)`), so **a background run's conversation is unrecoverable from disk today**; only the run entry/agent record survive.
- **Foreground path** runs `pi --mode json -p --no-session` (`src/runner.ts:170`), so it too has no session file to resume.
- `continueSession: true` in the `createAgentSession` JSDoc is **not implemented** (docs-only; would be silently ignored).

---

## P1 — Background crash + intent-before-effect

### Expected signature (stated before reading)
If the run entry is written before spawn, a `running` entry survives a `kill -9`; with no boot recovery it stays `running` indefinitely. Record exactly which store holds it (session custom entries vs `.pi/` files).

### Code evidence — **record-before-spawn IS ALREADY TRUE for background runs**
Order inside `spawnBackgroundSession` (`src/session-manager.ts:337+`):
1. `createAgentSession({ …, sessionManager: SessionManager.inMemory(effectiveCwd) })` (`:398`, `:455`) — session constructed, **not yet running**.
2. Build `agent` record with `status:'running'`, then `agents.set(id, agent)` + **`persistAgent(agent)`** (`:482-484`) → writes **`.pi/subagents/<id>.json`** (owner-only 0600; `STORAGE_DIR='.pi/subagents'`, `session-manager.ts:59`).
3. Build `run` (`status:"running"`) and **`pi.appendEntry(CUSTOM_ENTRY_TYPES.run, run)`** (`:508`) → session custom entry in the **conductor's** session.
4. `transcript.startTranscript(...)`, store `agent._sessionRef`.
5. **`runPromise = session.prompt(wrapTask(params.task))`** (`:874`) — the effect/spawn.

So both records are written **before** the prompt/effect. `finalizeRunEntry` (`:518+`) flips the run entry to `done`/`failed`; `updateAgentStatus` flips the agent record. Both live in lockstep.

### No boot recovery
- `pi.on("session_start", …)` (`src/index.ts:3827-3878`) loads presets/templates, cleans temp dirs, logs, and calls `state.restoreFromSession(ctx)`. `restoreFromSession` (`src/state.ts:236-313`) restores **config only** — model, thinking level, budgets, gitMode, approvalMode, completionNotify, circuit breaker, SLA fields. It **never touches run entries or background agent records**.
- `sweepStaleLiveSubagents` (`src/state.ts:616`) runs **only in the TUI monitor/dashboard render path** (`src/tui.ts:1354,1375,1786`), and only over the in-memory `state.subagentSessions` map (empty in a fresh process). It does not scan `.pi/subagents/*.json` nor persisted run entries.
- `session_shutdown` (`src/index.ts:3881+`) clears the live map/counters/queue; it does **not** finalize in-flight runs.

### Store visibility from a fresh session (code)
- `.pi/subagents/<id>.json` is **cwd-relative** (`STORAGE_DIR`), so a fresh session in the same cwd sees the record via `getAgent` → `loadAgent` (used by `get_agent_status`). It will read `running`.
- The session custom run entry is read from `ctx.sessionManager.getEntries()` (`state.getRunEntries`, `:320`), i.e. **the current session's file only**. A *different* fresh session will **not** see the killed run's run entry (different session file); it sees only the `.pi/subagents` record.

### P1 empirical probe
_(pending — see probe log below)_

---

## P2 — Foreground crash (two variants)

Foreground = `runSubagent` (`src/runner.ts:747+`) spawns a **`pi` subprocess** (`getPiInvocation`, `buildSubagentArgs` → `--mode json -p --no-session`, `:67,:170,:815`). The run entry is written before spawn by `createUnitRun` + `state.persistRun(pi, run)` (`src/index.ts:702-704` chain; single-mode analogous) — **intent-before-effect true for foreground too**.

### Expected signatures (stated before analysis)
- (a) Kill only the `pi` **subprocess**, extension alive → Node's `proc.on("close", code)` fires; the extension finalizes the run (`finalizeRunRecord`). Expect: run reaches terminal; `exitCode` is likely `0` because `close` resolves `code ?? 0` and a SIGKILL yields `code=null`.
- (b) Kill the **conductor** process → nothing in the extension runs; expect the run entry to stay `running` and the child `pi` subprocess to be orphaned.

### Code evidence
- Subprocess close/error handling (`src/runner.ts:815-853`):
  - `proc.on("close", (code) => { …; resolve(code ?? 0); })` — **ignores `signal`**; a SIGKILL'd child (`code=null`, `signal='SIGKILL'`) resolves **`0`**.
  - `proc.on("error", …)` sets `errorMessage` and resolves `1` (only fires when the spawn itself fails — not on a later kill).
  - Timeout/abort paths (`:244-247`, `:864-872`) set `errorMessage`/`errorCategory='aborted'` and SIGTERM→SIGKILL.
- After `await`, `result.exitCode = exitCode`, `result.errorCategory = classifyError(result)` (`:875-883`).
- `classifyError` (`src/types.ts:69-118`) with `stopReason` undefined, empty `errorMessage`/`stderr`, `exitCode 0` → falls through to **`"unknown"`**.
- `finalizeRunRecord` (`src/history.ts:99-119`): `run.status = isSubagentError(result) ? "failed" : "done"`; `isSubagentError` (`types.ts:730`) = `exitCode !== 0` OR a failure `stopReason`. With `exitCode 0`/no stopReason → **`status = "done"`**.
  - ⇒ **P2(a) predicted: a SIGKILL'd foreground subprocess is finalized as `done` (false success) with `errorCategory:"unknown"`.** The record is at least *terminal* (no zombie `running`), but the status is wrong.
- `finalizeRunRecord` is called at settle (`src/index.ts:3449` single-mode, `:3580`), followed by `state.persistRun(pi, run)` + `state.finalizeLiveSubagent(runId)`.
- (b) Conductor death: the extension's JS never runs again, so `finalizeRunRecord` never executes — the run entry stays `running`. The child `pi` subprocess is spawned with `shell:false` and no explicit process-group detach (`src/runner.ts:815-821`); on parent death the pipes close but the child is not explicitly killed. Whether it keeps burning is empirical.

### P2 empirical probe
_(pending — see probe log below)_

---

## P4 — Auto-resume collision check (read-only)

### Expected signature
A boot-time auto-resume added in `pi.on("session_start", …)` must not double-deliver completion wakes, must not resume a run the user already steered/stopped, and must respect the `completionNotify` knob.

### Findings
- Completion wakes are delivered by an event-bus subscriber registered at module/extension load (`src/index.ts:3912-3952`): `eventBus.on("subagent:completed"|"failed"|"stopped", …)` → `deliverCompletionAlert` → `resolveRunEntry` + `buildCompletionMessage` + `resolveDelivery(status, knob)` + `sendCompletionNotification` (`pi.sendMessage`).
- Dedupe: `markTerminalSeen(terminalSeen, id)` — a **per-process** `Set<string>` (cap 200). It is **not persisted** and not restored on `session_start`. So a boot-time resume that re-emits a terminal event in a new process would **not** be deduped by this set.
- Delivery semantics (`src/notify-completion.ts:resolveDelivery`): completed → `followUp`/`nextTurn`; failed/stopped → `steer` when knob is `all|failed`, else `nextTurn`. `triggerTurn` controls whether the conductor is woken.
- **Collision risk:** an auto-resume that (i) writes a terminal entry directly, or (ii) emits a `subagent:*` terminal event, would produce a *second* completion delivery for a run whose wake was already delivered in the prior process. The in-memory dedupe set cannot catch it across a process boundary. Gating needed:
  1. Resume only entries whose status is still `running` **and** whose agent record has **no `completedAt`** (idempotent dispatch id / spawn entry — P1 shows the spawn entry carries `originalParams`).
  2. On resume, do **not** re-emit a terminal event for a run already finalized; if a resumed run later settles, the event is the first for that process and is delivered normally. Consider seeding `terminalSeen` from persisted terminal run entries at `session_start` to survive the boundary.
  3. Honor `completionNotify` for any resumed-run notification (the knob is restored by `restoreFromSession`).
  4. Guard against resuming a run the user intentionally `stop_subagent`'d: `stopAgent` sets status `stopped` (terminal), so a `running`-only filter excludes it — provided the stop was persisted (it is: `updateAgentStatus` + `finalizeRunEntry`).
- `resolveTerminalRunEntry` already prefers a terminal entry over the spawn entry (`src/state.ts:81-95`), so `resolveRunEntry` reads the settled record when present.

### P4 verdict
A boot-time auto-resume in `session_start` **does not collide at the code-registration level** (the wake subscriber is process-local and the dedupe set is fresh), but it **can double-notify across a process restart** because nothing persists "this completion was already delivered". Minimum gating: resume only non-terminal runs, seed/exclude already-terminal ids, and route any wake through the existing `completionNotify` knob.

---

## Probe log (chronological)

- Env: versions/lockfile/sync/env/audit — see Environment table.
- P3: `/tmp/optb-sdk-probe/probe.mjs` `write-mem`/`write-file`/`reopen` — results above.
- P1: _(pending)_
- P2: _(pending)_

## Verdicts
_(consolidated after probes)_

## Boundaries (what was NOT tested)
_(pending)_

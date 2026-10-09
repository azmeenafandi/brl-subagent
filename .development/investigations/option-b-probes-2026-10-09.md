# Investigation: Option B prerequisites — what survives a process death during a subagent run

- Worktree: `/home/azmeen/public_projects/brl-subagent_workspace/brl-subagent-wt-optionb-probes`
- Branch: `chore/optionb-probes` @ `5f343fc` (== dev checkout HEAD, == `brl-subagent-dev` @ `5f343fc`)
- Date: 2026-10-09
- Status: COMPLETE (sections written incrementally; committed/pushed as probes ran)
- Method: Rule 12 — environment before theory. Empirical probes P1–P4.

---

## Environment (debug-task checklist)

| # | Check | Result |
|---|-------|--------|
| 1 | SDK/runtime installed | node `v24.14.1`; `@earendil-works/pi-coding-agent@1.1.0`, `pi-agent-core@1.1.0`, `pi-ai@1.1.0`, `pi-tui@1.1.0`; `pi` CLI `1.1.0` (`~/.local/share/pnpm/bin/pi`). |
| 2 | Lockfile consistency | `package-lock.json` pins all `@earendil-works/*` at `1.1.0`; installed matches (`grep -m1 '"version"' node_modules/@earendil-works/pi-{coding-agent,agent-core}/package.json`). **Consistent.** |
| 3 | Extension synced | `diff -rq src /…/brl-subagent-dev/src --exclude=__tests__` → **exit 0, no output**. Worktree HEAD == dev HEAD == `5f343fc`. `node_modules` symlinks to the shared dev tree (worktree-prep done). |
| 4 | Running extension current | Global settings (`~/.pi/agent/settings.json`) `packages` includes `…/brl-subagent-dev` (dev checkout, not this worktree). `/reload` unverifiable from here; irrelevant for probes — every probe loads fresh via `pi -ne -e <worktree>`. No code drift (check 3). |
| 5 | Env vars | Conductor env: `PI_CODING_AGENT=true`, `PI_SESSION_ID=01a12029-…`, `PI_PROVIDER=deepseek`, `PI_MODEL=deepseek-flash`, `PI_REASONING_LEVEL=high`. Extension-readable vars: `BRL_LOG_LEVEL`, `BRL_LOG_CONSOLE` (`src/logging.ts:66,85`), `BRL_PI_BIN` (`src/runner.ts:68`), `BRL_*_DEPTH` (`src/sanitize.ts:401`). None required. `pi auth check --provider deepseek` → `ready`; a live `pi -ne -e <wt> -p "…PONG"` returned `PONG` (exit 0). |
| 6 | Audit trail | `.pi/output/agent-12ed7d4b-….jsonl` — a completed "Say hello" agent. Run records live in TWO stores: **`.pi/subagents/<id>.json`** (background agent records; `src/session-manager.ts:59` `STORAGE_DIR`, `persistAgent`) and **pi session custom entries** `CUSTOM_ENTRY_TYPES.run` (`state.persistRun` → `pi.appendEntry`, `src/state.ts:223-224`; background also appends at `src/session-manager.ts:508,577`). |

**Environment verdict: no environmental defect found. Versions consistent, worktree synced, storage layout identified, live model path works. Proceed to source + empirical probes.**

---

## P1 — Background crash + intent-before-effect

### Expected signature (stated before)
If the run entry is written before spawn, a `running` entry survives a `kill -9`; with no boot recovery it stays `running` indefinitely. Record which store holds it.

### Code evidence — **record-before-spawn IS ALREADY TRUE for background runs**
Order inside `spawnBackgroundSession` (`src/session-manager.ts:337+`):
1. `createAgentSession({ …, sessionManager: SessionManager.inMemory(effectiveCwd) })` (`:398`, `:455`).
2. Build `agent` (`status:'running'`), `agents.set(id, agent)` + **`persistAgent(agent)`** (`:482-484`) → **`.pi/subagents/<id>.json`** (0600; `STORAGE_DIR='.pi/subagents'`, `:59`).
3. Build `run` (`status:"running"`), **`pi.appendEntry(CUSTOM_ENTRY_TYPES.run, run)`** (`:508`) → session custom entry in the **conductor's** session.
4. `transcript.startTranscript(...)`, store `agent._sessionRef`.
5. **`runPromise = session.prompt(wrapTask(params.task))`** (`:874`) — the effect.

### No boot recovery
- `pi.on("session_start", …)` (`src/index.ts:3827-3878`) loads presets/templates, cleans temp dirs, logs, then `state.restoreFromSession(ctx)`. `restoreFromSession` (`src/state.ts:236-313`) restores **config only** (model, thinking, budgets, gitMode, approvalMode, completionNotify, circuit breaker, SLA). It **never touches run entries or agent records**.
- `sweepStaleLiveSubagents` (`src/state.ts:616`) runs **only in the TUI render path** (`src/tui.ts:1354,1375,1786`) over the in-memory `state.subagentSessions` map (empty in a fresh process). It does not scan `.pi/subagents/*.json` nor persisted run entries.
- `session_shutdown` (`src/index.ts:3881+`) clears the live map/counters/queue; it does **not** finalize in-flight runs.

### Empirical probe
Scratch: `pi -ne -e <worktree> -p <prompt> --session-dir /tmp/optb-probe/sessions` with cwd `/tmp/optb-probe` (so `.pi/subagents` lands in /tmp, not the repo). Harness `/tmp/optb-probe/p1-harness.sh` then `/tmp/optb-probe/p1b-harness.sh`.

- **Run 1 (`p1`)** — prompt told the background subagent to `sleep 300`. The subagent (deepseek-flash) detached the sleep with `nohup … &` and **settled at +2.7s**, before our +3s kill → missed the window. Value delivered: a **before-kill snapshot** showed both stores already `running`: `.pi/subagents/67ee6d67-….json` `"status": "running"` and session `RUN_ENTRY 67ee6d67-… status= running`. (This directly shows intent-before-effect.)
- **Run 2 (`p1b`)** — kill `-9` issued **0.5 s after** the agent record appeared (mid-run). Expected: both stores survive as `running`, nothing finalizes.
  ```
  POST-KILL .pi/subagents/5bd584d4-f238-440a-bd26-ae37013d93c8.json
    "status": "running",  (no completedAt)
  POST-KILL session run entries:
    RUN_ENTRY id= 5bd584d4-… status= running finishedAt= None      <-- exactly ONE entry (no finalize)
  fresh-session view (JSON.parse of .pi/subagents/<id>.json, what session-manager.getAgent→loadAgent does):
    FRESH_SESSION_getAgent status= running completedAt= None
  pgrep: (no json pi subprocess) (no sleeps)   <-- in-process background died with the conductor
  ```
- **Matches expected exactly.** Both records survive a `kill -9` as `running`, indefinitely.

### Coverage
- `cat .pi/subagents/<id>.json` (full record printed) and a JSONL scan of `sessions/*.jsonl` filtering `type:"custom"` + `customType` containing `run` (printed 1 entry for the killed run in `p1b`; 2 entries in run 1 because it settled). p1b poll loop looked for the record with 0.02 s cadence for up to 1600 iterations.

### P1 verdict
- **"Record (intent) before spawn" is already true** for background runs — `.pi/subagents/<id>.json` (status `running`) and the conductor session's run custom entry (status `running`) are written before `session.prompt()`.
- **No boot recovery exists.** A killed background run stays `running` forever.
- **Fresh-session visibility:** the `.pi/subagents/<id>.json` record is **cwd-relative**, so a fresh session in the same cwd reads it as `running` via `getAgent` (`get_agent_status`). The session run custom entry lives only in the **original conductor session file** — a fresh session's `state.getRunEntries(ctx)` (which reads `ctx.sessionManager.getEntries()`, `src/state.ts:320`) will **not** see it. So a boot-time recoverer must read `.pi/subagents/` (cwd-relative), not the new session's entries.

---

## P2 — Foreground crash (two variants)

Foreground = `runSubagent` (`src/runner.ts:747+`) spawns a **`pi` subprocess** (`getPiInvocation` `:67`, `buildSubagentArgs` → `--mode json -p --no-session` `:170`, `spawn` `:815`). Run entry written before spawn by `createUnitRun` + `state.persistRun(pi, run)` (e.g. `src/index.ts:702-704` chain; single-mode analogous) — **intent-before-effect true for foreground too**.

### P2(a) — kill only the `pi` subprocess, extension alive
**Expected (stated before):** the extension finalizes the run (no zombie). Because `proc.on("close", code)` does `resolve(code ?? 0)` and a SIGKILL yields `code=null`, a kill with **no terminal event** should finalize `exitCode 0` → `classifyError` `"unknown"` → `isSubagentError` false → **`status:"done"` (false success)**.

**Observed (harness `p2a3`):** child real cmdline:
```
/usr/bin/node-24 …/@earendil-works/pi-coding-agent/dist/bundle/cli.js --mode json "<task>"
```
Killed **immediately** on detection (during the child's first model call, no `agent_end`):
```
RUN status= done  stopReason= None  errorCategory= unknown  errorMessage= None  fullOutput= ''
conductor output: "Done — delegate_task was called exactly once … The subagent returned no output."
```
→ **Prediction confirmed exactly: a SIGKILL'd foreground subprocess is finalized as `done` with empty output** (`src/runner.ts:837-841` `resolve(code ?? 0)`; `classifyError` `src/types.ts:69-118`; `finalizeRunRecord` `src/history.ts:99-119`; `isSubagentError` `src/types.ts:730`).

**Contrast (harness `p2a2`, killed ~1.5 s after detection):** the child had already emitted a terminal `toolUse` stopReason, so the run finalized `failed` / `stopReason=toolUse` / category `incomplete` — i.e. the recorded outcome depends on whether the child emitted its terminal event before the kill. (Two session files appeared in that run because an earlier attempt's conductor had continued; the run under test is the `10:22:20` session with `running` then `failed`.)

**Also observed:** killing the child orphans the child's own `bash sleep 200` grandchild (found alive afterwards as a leftover `sleep 200`; killed during cleanup).

### P2(b) — kill the whole CONDUCTOR process
**Expected (stated before):** nothing in the extension runs; run entry stays `running`; child subprocess orphaned.

**Observed (harness `p2b`):**
```
CHILD_PID=10482 ; KILL -9 CONDUCTOR 10333
CHILD_ORPHAN_ALIVE=yes pid=10482 ; child ppid now: 332   <-- reparented, STILL RUNNING
SESSION run entries: RUN status= running finishedAt= None  <-- no finalize
```
→ **Matches expected: the orphaned `pi --mode json` subprocess kept running (burning tokens), and the run entry stays `running` with no finalize.** Killed manually during cleanup.

### Coverage
- Child found via `pgrep -P $COND` + `/proc/<pid>/cmdline` match on `--mode json` (direct-child only, so the harness shell never matched — the first attempt used a `pgrep -f` pattern that self-matched and was discarded).
- Run entries scanned from `sessions/*.jsonl` (`type:"custom"`, `customType` containing `run`).

### P2 verdict
- **(a) extension alive:** the run **is** finalized (terminal), but a SIGKILL with no terminal event is misrecorded as a **`done` false success** (empty output, category `unknown`). A resume-on-boot keyed on `status === "running"` would **miss** this crash.
- **(b) conductor dead:** no finalize at all; the run entry is stuck `running` **and** the child subprocess is orphaned and keeps working. A boot-time recovery would need to both find the `running` entry and reap/stop the orphan.

---

## P3 — SDK resume capability (BIGGEST UNKNOWN)

### Expected signature (stated before)
A session load/resume/fork API reachable from `createAgentSession` will appear in the installed `dist` type surface; if `SessionManager.inMemory()` means no persistence, `isPersisted()` is false and no file is created.

### Read-only evidence (installed `pi-coding-agent@1.1.0` type surface)
- Exports (`dist/index.d.ts:20-21`): `createAgentSession`, `createAgentSessionFromServices`, `createAgentSessionRuntime`, `createAgentSessionServices`; `SessionManager`, `parseSessionEntries`, `loadEntriesFromFile`, `buildSessionContext`.
- `SessionManager` statics (`dist/core/session-manager.d.ts:361-425`): `create(cwd, sessionDir?, options?)`, **`open(path, sessionDir?, cwdOverride?)`**, **`continueRecent(cwd, sessionDir?)`**, `inMemory(cwd?, options?, entries?)`, **`forkFrom(sourcePath, targetCwd, sessionDir?, options?)`**, `findById`, `list`.
- `createAgentSession(options)` accepts `sessionManager?: SessionManager` (`dist/core/sdk.d.ts:14-68`); impl (`dist/core/sdk.js:77,84`) uses `options.sessionManager ?? SessionManager.create(...)` then `sessionManager.buildSessionContext()`. → **Resume = build a `SessionManager` over an existing/forked session file and pass it in.** There is **no `AgentSession.resume()`**.
- `AgentSessionRuntime` (`dist/core/agent-session-runtime.d.ts:53-140`) adds host-level `switchSession`, `newSession`, `fork`, `importFromJsonl` — returned by `createAgentSessionRuntime`, **not** by `createAgentSession` (which returns only `{ session, extensionsResult }`).
- **Doc defect:** `createAgentSession`'s JSDoc shows `{ continueSession: true }`, but `continueSession` is **not** in `CreateAgentSessionOptions` and is **not consumed** (`grep continueSession dist/core/sdk.js` → JSDoc only; absent from `sdk.d.ts`).

### `SessionManager.inMemory` semantics (verified in JS)
`inMemory` → `new SessionManager(cwd, "", undefined, false, …)` (`dist/core/session-manager.js:1364-1366`, 4th arg `persist=false`); `_persist` → `if (!this.persist || !this.sessionFile) return;` (`:794-796`). A file is created only once a user/assistant message exists (`_hasConversation`, `:791-793`).

### Empirical probe (deterministic, no model calls)
Scratch `/tmp/optb-sdk-probe/probe.mjs` (imports installed dist by absolute path) with expected signatures stated first:

| Step | Expected | Observed |
|---|---|---|
| `write-mem` (inMemory; append user+custom; SIGKILL self) | `isPersisted=false file=undefined entries=2`, exit 137, no file | `MEM isPersisted= false file= undefined` / `entries= 2` / exit **137** / `sessions/` **absent** |
| `write-file` (`SessionManager.create`; append; SIGKILL self) | `isPersisted=true`, file exists, entries=2, exit 137 | `FILE isPersisted= true file= …/2026-10-09T10-19-29-317Z_…jsonl exists= true` / `entries= 2` / exit **137** |
| raw file after SIGKILL | header + message + custom = 3 lines | 3 lines (session header, `type:"message"` user, `type:"custom"` probe) |
| `reopen` (`open` → `buildSessionContext` → `createAgentSession({sessionManager})`) | entries=2, contextMessages=1, messages=1 | `entries= 2` / `contextMessages= 1` / `agentSession.messages= 1` / same `sessionId` |

### P3 verdict
- **Resume/load/fork DOES exist — but only for file-backed sessions:** `SessionManager.open|continueRecent|forkFrom` + `createAgentSession({sessionManager})`. Append-per-entry JSONL means a SIGKILL preserves everything up to the last appended entry.
- **`SessionManager.inMemory` persists nothing** (confirmed). brl-subagent's background path constructs exactly this (`src/session-manager.ts:398`), so **a background run's conversation is unrecoverable today**; only the run entry/agent record survive.
- **Foreground** uses `--no-session` (`src/runner.ts:170`) → no session file to resume either.
- `continueSession: true` in the JSDoc is **docs-only / unimplemented**.

---

## P4 — Auto-resume collision check (read-only)

### Expected signature
A boot-time auto-resume in `pi.on("session_start", …)` must not double-deliver completion wakes, must not resume a run the user stopped, and must respect the `completionNotify` knob.

### Findings
- Wakes are delivered by an event-bus subscriber registered at extension load (`src/index.ts:3912-3952`): `eventBus.on("subagent:completed"|"failed"|"stopped", …)` → `deliverCompletionAlert` → `resolveRunEntry` + `buildCompletionMessage` + `resolveDelivery(status, knob)` + `sendCompletionNotification` (`pi.sendMessage`).
- Dedupe: `markTerminalSeen(terminalSeen, id)` — a **per-process** `Set<string>` (cap 200, `src/notify-completion.ts`). **Not persisted, not restored on `session_start`.**
- Delivery (`resolveDelivery`): completed → `followUp`/`nextTurn`; failed/stopped → `steer` when knob is `all|failed`, else `nextTurn`; `triggerTurn` controls the wake.
- **Collision risk:** an auto-resume that writes a terminal entry or emits a `subagent:*` terminal event would produce a **second** completion delivery for a run already notified in the prior process; the in-memory dedupe cannot catch it across the process boundary.
- `resolveTerminalRunEntry` (`src/state.ts:81-95`) already prefers a terminal entry over the spawn entry, so `resolveRunEntry` reads the settled record when present.

### P4 verdict
A boot-time auto-resume **does not collide at registration level** (the wake subscriber is process-local, dedupe set fresh), but it **can double-notify across a process restart** because nothing persists "already delivered". Minimum gating: (1) resume only non-terminal runs (`status==="running"` **and** no `completedAt` — the spawn entry carries `originalParams`); (2) seed/exclude already-terminal ids (survive the boundary); (3) never re-emit a terminal event for an already-finalized run; (4) route any resumed-run wake through the existing `completionNotify` knob (it is restored by `restoreFromSession`). `stop_subagent` → status `stopped` (terminal), so a `running`-only filter excludes user-stopped runs.

---

## Consolidated verdicts

| Question | Verdict |
|---|---|
| Is "record before spawn" already true? | **Yes** — background writes `.pi/subagents/<id>.json` (`running`) **and** a conductor-session run entry (`running`) before `session.prompt()`. Foreground writes its run entry before `spawn`. |
| What does a crash leave behind? | Background: both records `running`, indefinitely (no boot recovery). Foreground + extension alive: finalized — but a SIGKILL with no terminal event is a **`done` false success**. Foreground + conductor dead: run entry stuck `running`, child subprocess **orphaned and still running**. |
| Is there an SDK resume API? | **Yes, file-based**: `SessionManager.open|continueRecent|forkFrom` + `createAgentSession({sessionManager})`. No `AgentSession.resume()`; `continueSession` is docs-only. |
| Does anything hit disk for the current paths? | **No.** Background uses `SessionManager.inMemory` (verified: nothing on disk); foreground uses `--no-session`. Only the run entry/agent record persist. |
| Why this matters for Option B | To resume, brl-subagent must (i) *first* switch the background path from `inMemory` to a file-backed `SessionManager.create` (and/or foreground to a persistent session), (ii) fix the foreground `code ?? 0` false-success so crashes are recorded as non-terminal/failed, and (iii) add a `session_start` recoverer gated per P4. |

## Boundaries (what was NOT tested)
- **No resume of a live agent turn was executed.** P3 proved `createAgentSession` reloads persisted context, but not that a killed mid-turn model call is re-driven — that is pi-durable/engine territory; the SDK offers no turn-level resume.
- **P1/P2 used a real model** (`deepseek-flash`); the background subagent's tendency to detach `sleep` (run 1) is model behavior, not extension behavior. The P1b/P2 results were reproduced with controlled kills.
- **P2(a) exit-code internals** were inferred from `src/runner.ts` (`resolve(code ?? 0)`) plus the observed `done`/`unknown` record — the raw `result.exitCode` is not stored on the run entry, so it was not read directly.
- **No changes were made to the extension or environment.** All probes ran in `/tmp/optb-probe` (cwd) and `/tmp/optb-sdk-probe`; the extension loaded via `pi -ne -e <worktree>`. Leftover processes were killed (`pgrep` clean at end). Cockpit checkout `brl-subagent-dev` `git status --porcelain` = **empty**.
- **Not tested:** chain/parallel/graph-mode crashes; gitMode=branch teardown on crash; multiple concurrent background runs; the TUI monitor's stale sweep under a live restart; Windows.

## Probe log (chronological)
- Env: versions/lockfile/sync/env/audit — Environment table.
- P3: `/tmp/optb-sdk-probe/probe.mjs` `write-mem`/`write-file`/`reopen` — P3 table.
- P1: `/tmp/optb-probe/p1-harness.sh` (settled early; snapshot evidence), `/tmp/optb-probe/p1b-harness.sh` (mid-run kill → running survives).
- P2a: `p2a-harness.sh` (discarded — self-matching pgrep), `p2a2-harness.sh` (terminal toolUse before kill → failed), `p2a3-harness.sh` (immediate kill → **done** false success).
- P2b: `/tmp/optb-probe/p2b-harness.sh` (conductor kill → orphan alive, entry running).
- Cleanup: all `pi --mode json` / `sleep` processes killed; `pgrep` clean.

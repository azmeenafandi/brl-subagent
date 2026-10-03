# INVESTIGATION #179 — Forensics: background deaths recorded as success

**Scope:** read-only investigation. No tracked file modified, nothing committed.
Worktree `chore/179-forensics` @ `e9bb676`, based on `dev`. Running extension = dev build
(`~/.pi/agent/settings.json` → `packages: [..., "../../public_projects/brl-subagent_workspace/brl-subagent-dev"]`).

**Bottom line (up front):** The deaths are real and *environmental*, but the record and the
notification are not merely "missing a signal" — the settle path contains a **positive
mis-labelling defect**. When the provider dies, the SDK swallows the error into a failure
assistant message with `stopReason: "error"` and **resolves** `session.prompt()`
(`runWithLifecycle` never rethrows). The background settle handler only tests
`stopReason === "aborted"`; `"error"` falls through to the unconditional
`agent.status = "completed"` / `exitCode: 0` branch. The death is therefore recorded as
success at every layer, and the completion push literally tells the conductor
`category: success`. The instruments that could have shown the death (log, transcript,
session) are all either inert or unreachable after settle.

---

## Step 1 — Environment checklist (run BEFORE reading source)

| # | Check | Result |
|---|-------|--------|
| 1 | Installed SDK version | `node -e "require('@earendil-works/pi-coding-agent/package.json').version"` → **0.86.0** |
| 2 | Lockfile consistency | `package.json` dep `^0.86.0`; `package-lock.json:495` resolves `pi-coding-agent-0.86.0.tgz`. **Consistent.** |
| 3 | Extension synced (repo src vs installed extension src) | `diff -rq brl-subagent-wt-179/src brl-subagent-dev/src` → **no output (byte-identical)**. Installed extension is the dev build of this exact tree. |
| 4 | Running extension current | `brl-subagent-dev` HEAD == `e9bb676` == worktree HEAD; src identical (item 3). The code loaded is current as of this commit. `/reload` itself is not observable from disk (a reload event is not logged anywhere — see Q1). |
| 5 | Environment variables | `PI_CODING_AGENT=true`, `PI_MODEL=deepseek-flash`, `PI_PROVIDER=deepseek`, `PI_REASONING_LEVEL=high`. **No subagent/logging env var exists.** `grep process.env src/*.ts` shows only `PATH`, `HOME`, `DEPTH_ENV_KEY`, and a sanitizer enumeration — nothing gates logging. |
| 6 | Audit trail | See §"Audit-trail reconstruction" below. The trail exists and is damning: both deaths are `completed`/`exitCode:0`/`category:success`, including the completion pushes. |

Environment did **not** contain a version/sync/cwd/env fault. It *did* contain the two
mis-labelled records, which is how the root cause was located.

---

## Audit-trail reconstruction (the actual evidence)

Agent records live in the **main checkout** `.../brl-subagent/.pi/subagents/*.json`
(the conductor's cwd), not in this worktree. Both deaths are on **2026-09-20**, model
`deepseek/deepseek-flash`.

Scanning the 11 records written that day (scratch script, `/tmp/scan_agents.mjs`):

```
{"id":"9fad5384","status":"completed","model":"deepseek/deepseek-flash","turns":9,"in":19991,"out":5894,"exitCode":0,"err":"","finLen":76,...}
{"id":"08c0be56","status":"completed","model":"deepseek/deepseek-flash","turns":22,"in":14129,"out":22760,"exitCode":0,"err":"","finLen":41,...}
```

- **`9fad5384`** — the "produced zero files anywhere" death. **9 turns, 5894 output tokens**,
  status `completed`, `exitCode: 0`, `err: ""`. Label in the run/notify record:
  `"176-packaging-smoke-test"`. Its `finalOutput` (76 chars) is:
  `"I'll start by exploring the repository structure to understand the codebase."`
- **`08c0be56`** — the "wrote deliverables but never ran verification / never committed /
  never pushed / no PR" death. **22 turns, 22760 output tokens**, status `completed`,
  `exitCode: 0`, `err: ""`. Label `"176-packaging-smoke-test-retry"`. Its `finalOutput`
  (41 chars) is: `"Now run the required verification suites."`

Both `finalOutput`s are **mid-task sentences**, not completion summaries. `extractFinalOutput`
(`src/session-manager.ts:247`) falls back to the *last assistant turn with non-empty text*;
the SDK's provider-failure turn carries empty text, so the function silently returns an
earlier turn's prose and the death reads like normal progress.

### The run entries (session custom entries, `brl-subagent-run`)

`pi.appendEntry` writes into the **conductor's** session log
(`~/.pi/agent/sessions/--home-azmeen-public_projects-brl-subagent_workspace-brl-subagent--/2026-07-06T10-02-37-160Z_019f36e1-....jsonl`, 83 MB).
Extracted (`/tmp/scan_runs.mjs`):

```
--- 9fad5384 status= done finishedAt= 2026-09-20T08:34:05.786Z errorMessage= undefined
    outputSummary= "I'll start by exploring the repository structure to understand the codebase."
    errorCategory= undefined
--- 08c0be56 status= done finishedAt= 2026-09-20T08:54:59.261Z errorMessage= undefined
    outputSummary= "Now run the required verification suites."
    errorCategory= undefined
```

`status: "done"`, no `errorMessage`, no `errorCategory`. The run entry inherits the mislabel
one-for-one from `agent.status` (`finalizeRunEntry`, `src/session-manager.ts:548+`).

### The completion notification the conductor actually received

Extracted from the same log (`/tmp/scan_notify.mjs`):

```
Background agent "176-packaging-smoke-test" (9fad5384-...) — completed in 2m 31s · $0.0137 · category: success

I'll start by exploring the repository structure to understand the codebase.

Process this completion silently unless action is needed. ...
DETAILS {"id":"9fad5384-...","status":"completed","errorCategory":"success","costUsd":0.0137,"tokensIn":19991,"tokensOut":5894,"durationMs":151352,"label":"176-packaging-smoke-test"}
```

```
Background agent "176-packaging-smoke-test-retry" (08c0be56-...) — completed in 14m 27s · $0.0354 · category: success

Now run the required verification suites.
```

`buildCompletionMessage` (`src/notify-completion.ts`) derives `status` from `agent.status`
and derives `errorCategory` as `status === "completed" ? "success" : ...`. It never consults
the SDK stop reason. A death and a success are indistinguishable in the notification — by
construction.

### The transcripts on disk

```
.brl-subagent/.pi/output/agent-9fad5384-....jsonl   → 2 lines
  {"type":"system",...,"content":"Transcript started..."}
  {"type":"system",...,"content":"Transcript completed: completed"}   ← the death says "completed"
.brl-subagent/.pi/output/agent-08c0be56-....jsonl   → 2 lines, same shape
```

Across the whole output dir (1125 files): entry-type tally `{ system: 2255, user: 2 }`.
No `assistant`, no `tool_call`, no `tool_result`, no `error` entry exists anywhere.

---

## Q1 — THE LOG

**Confirm item 1: yes, that is the whole story for *file output*.**

- `createLogger(prefix, cwd?)` — `src/logging.ts:57`. `const logDir = cwd ? path.join(cwd, ".pi", "subagent-logs") : undefined;` (`:58`).
- **Exactly two call sites, both omit `cwd`** (`grep -rn createLogger src/`):
  - `src/session-manager.ts:15` → `createLogger('brl-subagent')`
  - `src/index.ts:195` → `createLogger('brl-subagent')`
  - No other call sites (including none that pass a `cwd`). `setLogLevel` (`src/logging.ts:49`) has **zero callers** anywhere in `src`.
- No `.pi/subagent-logs/` directory exists in any checkout (`for d in .../*/; do [ -d "$d/.pi/subagent-logs" ] ...` → none).

**What supplying `cwd` produces** (verified by executing the real module via jiti against a scratch cwd, `/tmp/probe-log.mjs`):

```
$ node /tmp/probe-log.mjs
--- level filtering (default minLevel=info) ---
[brl-subagent] INFO: info line
[brl-subagent] WARN: warn line
[brl-subagent] ERROR: error line
--- no-cwd logger (simulating real call sites) ---
[brl-subagent] INFO: no-cwd: console only, no file

$ find /tmp/probe-cwd -type f
/tmp/probe-cwd/.pi/subagent-logs/brl-subagent.log
$ stat -c '%a %n' /tmp/probe-cwd/.pi /tmp/probe-cwd/.pi/subagent-logs /tmp/probe-cwd/.pi/subagent-logs/*.log
700 /tmp/probe-cwd/.pi
700 /tmp/probe-cwd/.pi/subagent-logs
600 /tmp/probe-cwd/.pi/subagent-logs/brl-subagent.log
$ cat /tmp/probe-cwd/.pi/subagent-logs/brl-subagent.log
{"timestamp":"...","level":"info","prefix":"brl-subagent","message":"info line","data":{"agentId":"abc"}}
{"timestamp":"...","level":"warn","prefix":"brl-subagent","message":"warn line"}
{"timestamp":"...","level":"error","prefix":"brl-subagent","message":"error line","data":{"code":503}}
```

- **File:** `<cwd>/.pi/subagent-logs/brl-subagent.log`. Note **both call sites use prefix
  `'brl-subagent'`, so enabling both would write to the SAME file** (no per-module file).
- **Entries:** JSON lines `{timestamp, level, prefix, message, data?}`, appended synchronously (`fs.appendFileSync`, `src/logging.ts:96`).
- **Rotation:** `rotateIfNeeded` (`src/logging.ts:118`) at `MAX_LOG_SIZE = 5MB` (`:22`), keeping `MAX_LOG_FILES = 5` (`:25`). It renames `brl-subagent.log` → `.1`, `.1`→`.2`, … and unlinks the oldest; suffixes are `.1`–`.4` plus the live file.
- **Permissions:** dir `mkdirSync(..., mode: 0o700)` (`:63`); file `mode: 0o600` (`:97`). Confirmed `700/700/600` above.
- **Other gating:** none. `minLevel` is a module-level `let` defaulting to `"info"` (`:35`); `setLogLevel` exists but is never called. `debug` is therefore always filtered, `info/warn/error` always emit. No config/env gate.

**Critical nuance — enabling the log would NOT have caught these deaths.** The background
settle path's *success* branch (`src/session-manager.ts:942-972`) contains **no log statement
at all**; `log.*` in that file fires only on abort failure, git-lifecycle warnings, the
timeout handler, and settle-handler *exceptions* (`grep -n "log\." src/session-manager.ts`).
A provider death that falls through to `agent.status = 'completed'` takes a path with zero
log calls, so even with `cwd` supplied the log would show "Background agent spawned"
(index.ts:2858) and then silence. The log instrument exists but is not aimed at the failure.

---

## Q2 — THE TRANSCRIPT

**What the API can store today** (`src/types.ts:504-513`):

```ts
export type TranscriptEntryType = "system" | "user";
export interface TranscriptEntry { type: TranscriptEntryType; timestamp: number; content: string; metadata?: Record<string, unknown>; }
```

Only two kinds — `system` and `user`. There is no `assistant`, `tool_call`, `tool_result`,
or `error` member in the current type.

**What is actually written** (`grep -rn "appendEntry|startTranscript|completeTranscript"`):
- `transcript.startTranscript(agent.id, params.task)` — `system` start marker
  (`session-manager.ts:149` for `createSession`, `:576` for `spawnBackgroundSession`).
- `transcript.completeTranscript(id, status)` — `system` terminal marker (many settle branches).
- `transcript.appendEntry(id, 'user', ...)` — **exactly one call site**, steering
  (`session-manager.ts:328`).

So a transcript can only ever hold start + completion markers + steering messages. On-disk
evidence: 1125/1128 files have exactly 2 entries, 2 files have 3 (the two steering cases),
1 file has 1. Tally `{ system: 2255, user: 2 }`.

**Was conversation recording ever wired?** Git history is decisive:

- `4ff38a3` ("6.1: Foundation") shipped `src/transcript.ts` *with* helper functions
  `appendToolCall`, `appendToolResult`, `appendAssistantMessage`, `appendError` and even a
  doc comment `appendEntry(agentId, 'assistant', content)`.
- `2be05ac` ("6.1.1") had defined the rich type:
  `export type TranscriptEntryType = "system" | "user" | "assistant" | "tool_call" | "tool_result" | "error";`
- `72b2311` ("remove dead code: unused exports from transcript.ts") **deleted all four
  helpers as unused** — no production caller ever invoked them.
- `a190da9` (the `tsc --noEmit` gate, #117) re-introduced the narrowed type
  `"system" | "user"` — i.e. exactly the two kinds the code uses.

**Conclusion:** conversation recording was **scaffolded in the foundation and never wired**,
then the dead helpers were pruned (deliberately) and the type narrowed to the used subset.
The doc comments "transcripts contain the full subagent conversation" (`src/transcript.ts:23`)
and "transcripts hold the full conversation" (`:60`, `:83`) are **stale security-rationale
comments**, not an implementation contract: they justify the `0o700/0o600` permissions on a
capability that does not exist. The comment's claim simply does not match the implementation.

---

## Q3 — THE SESSION

Installed SDK `@earendil-works/pi-coding-agent@0.86.0`. The session object the extension
already holds is `agent._sessionRef` (`BackgroundAgent`, set at `session-manager.ts:581`,
released in every terminal branch).

**What `AgentSession` exposes** (`node_modules/@earendil-works/pi-coding-agent/dist/core/agent-session.d.ts`):

| Member | Line | Relevance to a dead run |
|--------|------|------------------------|
| `get messages(): AgentMessage[]` | 331 | Full message list; assistant messages carry `stopReason` + `errorMessage` (pi-ai `types.d.ts:365-367`). |
| `get state(): AgentState` | 294 | `AgentState.errorMessage` = "Error message from the most recent failed or aborted assistant turn, if any" (`pi-agent-core/dist/types.d.ts:343`). Also `isStreaming`, `pendingToolCalls`. |
| `get sessionId(): string` | 339 | Present even for in-memory sessions. |
| `get sessionFile(): string \| undefined` | 337 | **`undefined`** for `SessionManager.inMemory` (see Q-Session note). |
| `get isIdle(): boolean` | 306 | True after the run settles. |
| `get retryAttempt(): number` / `get isRetrying(): boolean` | ~594 / 596 | How many auto-retries were burned — a provider-health signal. |
| `abort(): Promise<void>` | 485 | — |
| `subscribe(listener)` | 289 | Events include `agent_end` (`{messages, willRetry}`), `agent_settled`, `auto_retry_start`/`auto_retry_end`, `summarization_retry_*` (`agent-session.d.ts:43-91`). |
| `get isStreaming()` | 304 | — |

There is **no `status`, `exitCode`, or `stopReason` getter on the session as a whole.** The
terminal state must be *synthesized* from the messages — which is exactly what the extension
does at `session-manager.ts:897`:

```ts
const lastAssistant = [...(session.messages ?? [])].reverse().find(m => m.role === "assistant");
const aborted = agent.status === "stopped" || lastAssistant?.stopReason === "aborted";
```

**The SDK's own stop reasons** (`@earendil-works/pi-ai/dist/types.d.ts:292`):

```ts
export type StopReason = "pending" | "stop" | "length" | "toolUse" | "error" | "aborted" | "deferred";
```

**What a dead run actually looks like inside the SDK** — the key mechanism
(`@earendil-works/pi-agent-core/dist/agent.js:335-381`):

```js
async runWithLifecycle(executor) {
  ...
  try { await executor(abortController.signal); }
  catch (error) { await this.handleRunFailure(error, abortController.signal.aborted); }   // :352 — swallowed
  finally { this.finishRun(); }                                                          // :355
}
async handleRunFailure(error, aborted) {
  const failureMessage = { role: "assistant", content: [{type:"text",text:""}], ...,
    stopReason: aborted ? "aborted" : "error", errorMessage: error.message, ... };       // :366
  await this.processEvents({ type: "message_end", message: failureMessage });            // :372 — pushed to messages
  ...
}
finishRun() { ... this.activeRun?.resolve(); }                                           // :375-380 — RESOLVES
```

So on a provider 503 the low-level agent records an assistant failure message
(`stopReason: "error"`, `errorMessage: "…"`) and **resolves**. `AgentSession.prompt`
(`dist/core/agent-session.js:1057` → `_runAgentPrompt` → `await this.agent.prompt(messages)`,
`:860`) does not add a rethrow around the run; its only `catch` (`:1052`) rethrows *preflight*
errors (no model / no API key / streaming-without-behavior) before `_runAgentPrompt`. Therefore
**a mid-run provider death makes `session.prompt()` RESOLVE**, and the extension's `.then`
handler treats it as a clean completion:

```ts
// src/session-manager.ts
897  const lastAssistant = [...(session.messages ?? [])].reverse().find(m => m.role === 'assistant');
898  const aborted = agent.status === 'stopped' || lastAssistant?.stopReason === 'aborted';
...
942  agent.status = 'completed';
943  agent.completedAt = Date.now();
...
956    exitCode: 0,          // completion branch
```

`stopReason === "error"` is not `"aborted"`, so the death lands in the completion branch.
Auto-retry (`_handlePostAgentRun`, `agent-session.js:880-903`) may burn several attempts
first, but when the budget is exhausted the last message is still `stopReason: "error"` and
the promise still resolves.

**What could be read at settle time from the session the extension already holds**
(all before `captureAndReleaseSession()` nulls the ref, so all are reachable at line 897):
- `lastAssistant.stopReason` → `stop` | `length` | `toolUse` | `pending` | `error` | `aborted` | `deferred`
- `lastAssistant.errorMessage`
- `session.state.errorMessage`
- assistant-turn count / summed usage (`accumulateUsage` counts every assistant message, so
  `turns` includes error turns; real turns show non-zero `input`/`output`)
- `session.isIdle`, `session.retryAttempt` / `isRetrying`
- the git diff (only when `gitMode === "branch"` — the two deaths were not branch mode, `gitDiff` length 0).

**Not recoverable:** the provider HTTP status. Foreground already documents this
(`src/runner.ts:682-700`): a provider failure surfaces as a composed `errorMessage` string
("OpenAI API error (429): …" or a bare "Connection error."); there is no separate `status`
field on the message payload. So `errorMessage` is the only provider-side breadcrumb.

---

## Q4 — THE SIGNALS

**Facts that reliably separate "did something" from "did nothing":**

- **Work volume:** `usage.turns` and summed `input`/`output` tokens. The record already
  carries these. `usage.turns` counts every assistant message (real *and* error turns, since
  `accumulateUsage` (`src/runner.ts`) increments unconditionally when a `usage` object is
  present; a failure turn carries `EMPTY_USAGE`, adding a turn but 0 tokens). So:
  - `turns == 0` → the agent never got the model to answer at all;
  - `output == 0` with `turns >= 1` → the only assistant turns were failures;
  - `output > 0` → at least one real model response was produced (deaths: 5894 / 22760 output tokens — clearly "did something").
- **Terminal stop reason** (the decisive *new* datum, currently discarded): the last
  assistant message's `stopReason`. `stop` = natural end; `error` = provider/run failure;
  `aborted` = cancel; `length` = truncated; `toolUse`/`pending`/`deferred` = cut mid-turn.
- `session.state.errorMessage` / `lastAssistant.errorMessage` give the human-readable reason.

**Facts that are NOT recoverable generically:**

- **Partial completion is NOT detectable by any generic signal — the conductor's assumption
  is CORRECT.** Nothing in the extension knows a task's acceptance criteria: the task arrives
  as free text (`wrapTask(params.task)`), the extension has no step list, no checklist, no
  expected-artifact manifest. The only terminal signal is the SDK's `stopReason`, which
  describes *how the model loop ended*, not *whether the task's steps were all performed*.
  Concretely:
  - A run that "ended cleanly" (`stopReason: "stop"`) can still be premature — the agent
    decides it is done (or simply stops). `08c0be56`'s final visible text was
    "Now run the required verification suites." — the agent *intended* more work; whether it
    died on that very turn or stopped voluntarily is not decidable from the record, and even
    a clean `stop` would not prove the suites ran.
  - `gitDiff` (branch mode only) proves *something* was written, not that it satisfies the task.
  - No tool-call inventory is captured on the background path, and the transcript records none
    (Q2).
- We can detect **"ended in an error"** and **"produced zero output"** — but we cannot detect
  **"did less than the task required while ending without an error."** The conductor's
  assumption stands: that class needs per-task acceptance criteria, which are external to the
  extension.

---

## Instruments that are INERT, and why

| Instrument | Status | Why |
|-----------|--------|-----|
| `.pi/subagent-logs/brl-subagent.log` | **Entirely inert** | Both `createLogger` call sites omit `cwd` (`session-manager.ts:15`, `index.ts:195`); `logDir` is `undefined`, so no dir/file is ever created. No `.pi/subagent-logs/` exists in any checkout. Even if enabled, the success branch of the settle path has no log statement, so the death would still be silent. |
| Transcript `.pi/output/agent-*.jsonl` | **Near-inert** | `TranscriptEntryType` only allows `system`/`user`; `appendEntry` is called solely by steering. Every file = start marker + `"Transcript completed: <status>"` marker — and the death's own transcript says **"completed"**. The "full conversation" doc comment is stale. |
| Live background session file | **Gone at settle** | `SessionManager.inMemory(effectiveCwd)` (`session-manager.ts:404`) → `sessionFile === undefined`; nothing survives a death. |
| `result.messages` on the agent record | **Inert** | Every terminal branch seeds `messages: []` (e.g. `:946`, `:1044`) and nothing ever fills it, though `persistAgent` (`:92`) comments claim records contain "result.messages (full conversation)". Confirmed all deaths have `msgs: 0`. |
| `brl-subagent-run` session entry | **Inherits the mislabel** | `status` and `errorMessage`/`errorCategory` are derived from `agent.status`; `stopReason` is never written. |
| Completion notification | **Inherits the mislabel** | `buildCompletionMessage` maps `status === "completed"` → `errorCategory: "success"`; the SDK stop reason is never consulted. |

---

## Facts available at settle time that could honestly describe a run

Reachable from `session` at `session-manager.ts:897` (before the ref is released), plus the
agent record the extension already builds:

1. `lastAssistant.stopReason` — the terminal cause (`stop`/`length`/`toolUse`/`pending`/`error`/`aborted`/`deferred`).
2. `lastAssistant.errorMessage` and `session.state.errorMessage` — the reason with provider detail.
3. Assistant-turn count and summed input/output/cost (already folded by `recordSessionUsage`).
4. `session.retryAttempt` / `isRetrying` — whether auto-retry was engaged (provider-health context).
5. `session.isIdle` — settle confirmation.
6. `gitDiff`/`gitBranch` (branch mode only).

There is already a vocabulary to classify these: `classifyError(result)` (`src/types.ts:59`)
maps `stopReason === "error"` → `"exit_error"` (`:94`) and `"aborted"` → `"aborted"` (`:60`),
and `isSubagentError(result)` (`src/types.ts:667`) already treats `stopReason === "error"` as
a failure. Neither is applied on the background settle path. The foreground path already
captures exactly the missing data — `runner.ts:626-627` records `msg.stopReason` and
`msg.errorMessage`, and `countModelErrorTurns` (`runner.ts:661`) counts provider-error turns —
so the background path is the outlier.

---

## FIX DIRECTIONS (design inputs — NOT implementations)

**D1 — Capture the terminal stop reason at settle and classify honestly.**
At `session-manager.ts:897`, read `lastAssistant.stopReason`/`errorMessage` and
`session.state.errorMessage`; treat `error`/`length`/`deferred`/`pending`/mid-`toolUse` as
non-success (reuse `classifyError` / `isSubagentError`, already present). Only `stop` should
map to `completed`; `aborted` stays `stopped`. *Nuance:* a `length`/`toolUse` end is also not a
clean finish — decide whether those are `failed` or a new "incomplete" status.

**D2 — Stop deriving the record and notification from `agent.status` alone.**
`finalizeRunEntry` and `buildCompletionMessage` should carry the classified reason
(`errorCategory`, `errorMessage`, `stopReason`) so a death cannot be stamped `success`. Add
`stopReason` to the `brl-subagent-run` entry and to `CompletionMessageDetails`. The
notification's `category` must reflect the stop reason, never default to `success` purely
because `agent.status === "completed"`.

**D3 — Record an explicit work-volume datum.**
Persist `turns` / `tokensOut` (already available) plus whether the final turn was a provider
error. This makes "did nothing" (`turns==0`/`output==0`) vs "did work then died"
(`turns>0`, ended `error`) explicit, and gives the conductor a principled reason to distrust a
non-`stop` terminal state.

**D4 — Stop letting `extractFinalOutput` mask a death.**
When the last assistant turn is a failure (empty text), do not silently fall back to an
earlier turn and present it as the run's output. Either mark the output as
non-authoritative/"last non-failure turn", or store the failure reason as the headline output.
Both deaths' `finalOutput` currently looks like ordinary progress.

**D5 — Transcript: choose explicitly.**
Either (a) wire minimal event recording — at least the terminal `stopReason`/`errorMessage`
and a turn/tool count, so a death is visible in the transcript — or (b) correct the
"full conversation" doc comments (`src/transcript.ts:23,60,83`) so they no longer overclaim a
capability that was never implemented. The transcript's own completion line must not say
"completed" for a died run.

**D6 — Logging: enable and aim it.**
Pass a `cwd` at both `createLogger` sites (the extension has `ctx.cwd`/`effectiveCwd`), and add
an explicit settle log line (status, stopReason, turns, tokens, error) so the log can tell
death from success. Note the shared-prefix collision: both sites use `'brl-subagent'`, so decide
whether to share one file or give each module its own prefix. Merely passing `cwd` is
insufficient without D1 + the new log line.

**D7 — Notification honesty.**
Include the terminal reason in `completion-notification` `details` (e.g. `stopReason`,
`errorCategory`, `turns`) and phrase the summary by outcome ("ended with provider error after N
turns") rather than by `agent.status`. Default to "unverified" semantics whenever the terminal
stop reason is not `stop`.

**D8 — Partial completion (out of scope as a generic signal).**
Not decidable by any instrument the extension owns (Q4). If partial-completion detection is
wanted, it must come from per-task acceptance criteria the caller supplies (e.g. a required
verification checklist / artifact manifest echoed back at settle) — a product/design decision,
not a forensics fix.

---

## Reproduce / verify commands used

```bash
# versions / sync
node -e "require('@earendil-works/pi-coding-agent/package.json').version"     # 0.86.0
diff -rq brl-subagent-wt-179/src brl-subagent-dev/src                         # identical

# logging call sites + level gate
grep -rn "createLogger|setLogLevel" src/
node /tmp/probe-log.mjs                                                       # file/dir/perms + JSON lines

# transcript vocabulary + write sites
sed -n '501,514p' src/types.ts
grep -rn "appendEntry|startTranscript|completeTranscript" src/ | grep -v __tests__

# SDK stop-reason contract and settle mechanism
sed -n '292p'  .../pi-ai/dist/types.d.ts
sed -n '335,381p' .../pi-agent-core/dist/agent.js

# audit trail
node /tmp/scan_agents.mjs     # Sep-20 agent records
node /tmp/scan_runs.mjs       # brl-subagent-run entries
node /tmp/scan_notify.mjs     # completion pushes the conductor received
```

Scratch scripts live in `/tmp` (`scan_agents.mjs`, `scan_runs.mjs`, `scan_notify.mjs`,
`probe-log.mjs`). No tracked file was modified.

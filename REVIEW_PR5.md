# Adversarial Review — PR #5 "fix: capture and surface background subagent final results"

**Reviewed worktree:** `brl-subagent-bg-results`
**Diff:** `origin/main..HEAD` (2 commits: `4dd11f4` + `7470c8f`; 4 files, +39/−6)
**Pi version checked against:** `@earendil-works/pi-coding-agent 0.83.0` (dist sources + empirical runtime tests)
**Tests:** `vitest run` — 555 passed (none cover the new code; `src/__tests__/*` is gitignored except `preset-model.test.ts`).

---

## Executive summary

The PR's intent is good — persist the background agent's final assistant text and surface it in the completion notification and in `get_subagent_result`. The extraction logic itself (last assistant message → text parts → join) is correct for the happy path, and there is **no deletion race** between `setAgentFinalOutput` and `finalizeLiveSubagent` (different stores). However, the implementation has **two serious problems** and several moderate ones:

1. **SERIAL (must fix): `setAgentFinalOutput` → `persistAgent` serializes the entire live pi session.** Because `agent._sessionRef` is attached to the record, `JSON.stringify(agent)` walks a ~4,900-object graph that includes the session, its message history, tool results (including file contents from `read`), the model runtime, settings, and extension runner. Empirically: **1,367 KB of JSON for an essentially empty session** (theme initialized); and **`JSON.stringify` THROWS** (`Theme not initialized. Call initTheme() first.`) when a getter in that graph isn't initialized. The PR adds three new `persistAgent` calls (crash / completed / hard-cap paths), two of which sit *inside* critical completion sequences. A throw there silently kills the completion bookkeeping (see Q3/Q4/Q7), and the megabyte-sized synchronous `writeFileSync` blocks the whole pi event loop at completion time.

2. **HIGH: `!session.isStreaming` is not a reliable completion signal at poll time.** `isStreaming` (`_isAgentRunActive`) is set to `true` only inside `_runAgentPrompt` — i.e. *after* `prompt()`'s preflight awaits (auth check — can be a network call — `emitBeforeAgentStart`, etc.). During that window (and permanently, if `prompt()` rejects: no model / no API key), `isStreaming` is `false` and the first 2-second poll declares the agent **completed with empty output**, clears the poller, and sends a "completed" notification — while the real run hasn't started (or has failed). `setAgentFinalOutput('')` then permanently stamps an empty `finalOutput`.

3. **MEDIUM: the crash path (`!session`) is effectively dead code and misleads.** `_sessionRef` is assigned synchronously before the poller starts and is never nulled by anything — a crashed run (`session.prompt()` rejection) leaves the ref intact, so those agents fall into the *completion* path, not the crash path. The new crash-path code suggests crashes are handled when they aren't.

4. **MEDIUM: notification preview + full (untruncated) `finalOutput` in `get_subagent_result`.** Custom-message content and tool results are rendered as **markdown** in pi's TUI; a 500-char slice of agent output (which may contain unclosed ``` fences, tables, etc.) can break rendering, and `deliverAs: "followUp"` while the main session streams feeds the preview into the **main agent's LLM context**. `get_subagent_result` embeds the **entire** `finalOutput` untruncated (pi has no tool-result size cap in the run loop), so a large final message is dumped wholesale into the caller's context.

5. **LOW/MEDIUM:** extraction logic is duplicated 3× (drift risk); `finalOutput` can be written twice with different content (poll vs `.then()`); the static import of `session-manager` is inconsistent with the deliberate dynamic imports everywhere else; the hard-cap `setTimeout` body has no try/catch.

Pre-existing issues this PR *interacts* with (not introduced, but they make the new code misreport): a rejected `prompt()` is counted as "completed"; the hard-cap path is later overwritten to `status: 'completed'` by `spawnBackgroundSession`'s `.then()`; the resolved `bgModel` is never actually applied to the background session (so "no model" failures are plausible).

---

## Q1 — Is final output extraction correct? `session.messages` empty at completion? `isStreaming` reliable?

### Extraction logic (happy path): correct
- `session.messages` is a getter returning `this.agent.state.messages` (`agent-session.js:653`) — always an array, never missing; empty only before the run commits anything. The `?.` chains and `|| ''` handle null content, string content, and tool-call-only final messages safely (no throw).
- **Commit timing is safe at the settle point.** The agent-loop commits the final assistant message to state.messages at `message_end` (`pi-agent-core/dist/agent.js:381`), which happens before `agent.prompt()` resolves; `isStreaming` flips to `false` only in `_emitAgentSettled()` (`agent-session.js:315`) *after* the run **and** any post-run continuation (retry, auto-compaction, queued follow-ups) completes. So when the poller sees `!isStreaming`, the final message is committed and final. Good.
- Minor: if the final assistant message is tool-call-only (aborted/interrupted run), `finalOutput` is `''`; after auto-compaction the "last assistant message" is whatever the compacted history ends with. Both acceptable.

### Completion signal (`!session.isStreaming`): NOT reliable — two failure modes

**(a) Premature completion during `prompt()` preflight.** `_isAgentRunActive` is set `true` only at the top of `_runAgentPrompt` (`agent-session.js:745`). The public `prompt()` (used by `spawnBackgroundSession`) performs several `await`s *before* that: `emitInput` handlers, `_expandSkillCommand`/template expansion, `await this._modelRuntime.checkAuth(provider)` (a **network round-trip** when `hasConfiguredAuth` is false), and `emitBeforeAgentStart`. During this window `isStreaming === false`. The first poll tick fires 2 s after `spawnBackgroundSession` resolves — if preflight takes longer (slow auth check / slow model resolution), the poller takes the `!isStreaming` branch: marks `completed`, clears the poller and the hard cap, `setAgentFinalOutput(id, '')`, finalizes, and sends a "completed" notification. The real run then starts and runs to completion **unobserved**: `finalOutput` stays `''`, no completion notification is ever sent, `completedSubagents`/`activeSubagents` are wrong.

**(b) Failed-to-start sessions are reported as completed.** If `prompt()` rejects (no model selected — note the extension resolves `bgModel` but **never passes it to `createAgentSession`**, so the session relies on `findInitialModel`/settings; no API key; auth failure), `_isAgentRunActive` never becomes true. The `.catch()` in `spawnBackgroundSession` correctly marks the record `failed`, but the poller independently sees `!isStreaming` and runs the **completed** path: `completedSubagents++`, "Background agent … completed." notification, `finalOutput: ''`. Contradictory status reporting with no crash notification.

**Recommendation:** don't treat `!isStreaming` alone as completion. Either (1) gate on the agent record's status (`status === 'running'` and `completedAt` set by the `.then()`/`.catch()` handlers, which are the authoritative settle signal), or (2) await `session.prompt()` via a promise that the poller checks (e.g., set `agent._sessionRef` completion through the same promise chain), or (3) require at least one committed assistant message *and* `!isStreaming` *and* a minimum elapsed time. Also stop polling when the record status becomes `failed`/`stopped` and report accordingly.

---

## Q2 — Notification content (preview): issues?

Custom messages are rendered in the TUI via `Markdown(text, …)` (`modes/interactive/components/custom-message.js:88`), and `pi.sendMessage({customType…}, {deliverAs: "followUp"})` routes to `sendCustomMessage` → when the main session is streaming → `this.agent.followUp(appMessage)` (`agent-session.js:1079`), i.e. **the message is queued into the main agent's turn and sent to the model**. Findings:

- **Markdown breakage (medium):** the 500-char preview is arbitrary agent output rendered as markdown. A code fence (` ``` `), table, header, or `***` in the output can break/restyle TUI rendering, and `slice(0, 500)` can cut mid-fence leaving it unclosed (the renderer then treats following content as code). A slice can also split a UTF-16 surrogate pair (emoji at the boundary).
- **Context pollution (medium, mostly pre-existing):** the pre-existing "completed." notification already flowed into the main session this way; the PR adds up to 500 chars of *uncontrolled agent text* into the main LLM context (token cost, and the model can react to it). When the main session is idle it's display-only (no LLM turn) — fine.
- Non-text content is filtered before preview — good. Empty `finalOutput` yields a dangling `"\n\n"` — harmless but sloppy.

**Recommendation:** strip/escape markdown in the preview (or render as plain text — e.g., replace backticks, collapse newlines), trim to a whole line, and consider a smaller cap. The preview should be display-only; a followUp custom message is the wrong delivery channel for raw agent output.

---

## Q3 — Crash path (`!session`): reliable? stale/finalized `liveOutput`?

- **The branch is effectively unreachable.** `agent._sessionRef = session` is assigned synchronously inside `spawnBackgroundSession` before the poller is created, the poller closure holds that same object, and nothing in the codebase ever sets it to `null`. A crashed/failed run does *not* null the ref — pi keeps the session object alive. So the "session may have crashed" path never fires, and real failures fall into the completion path (Q1b) instead. The added code creates a false sense that crashes are captured.
- **If it ever did run:** `state.subagentSessions.get(id)?.liveOutput` is the last 2-second poll snapshot — up to 2 s stale and mid-stream (not necessarily the final message). The map entry exists at that point (single tick, `completed` guard prevents other paths from having finalized), so `?? ''` only triggers if `registerLiveSubagent` failed. Semantics are fine as a last-resort snapshot, but inconsistent with the message-based extraction used elsewhere.
- **Ordering bug (medium):** `setAgentFinalOutput(...)` is called **before** `completed = true` in this path (`src/index.ts:2104-2105`). If `persistAgent` throws (see Q7 — it can), the outer `catch` runs the `!completed` branch: decrements counters, but **never calls `state.finalizeLiveSubagent`** (the dashboard entry leaks until session shutdown) and **never sends the crash notification**.

---

## Q4 — Hard cap path: duplicated extraction issues?

- **Third copy of the same extraction** (poller, crash, hard cap), and the crash path uses `liveOutput` instead of the session messages — inconsistent; any future fix must be applied in 3 places.
- **No try/catch in the `setTimeout` body (high):** if `setAgentFinalOutput` → `persistAgent` throws (megabyte stringify of the session graph — Q7), the exception is **uncaught** (30 minutes in), and everything after it is skipped: `finalizeLiveSubagent`, `activeSubagents--`, `completedSubagents++`, the timeout notification. Depending on the host's uncaught-exception handling this can take down the extension.
- **Snapshot semantics:** at 30 min the session is still streaming; the agent-loop pushes a *partial* message into context at stream `start` and only replaces it with the final message at `done` (`pi-agent-core/dist/agent-loop.js:200-250`). So `hardCapFinalOutput` may be mid-sentence text — acceptable for a timeout, but it's persisted as `finalOutput` with no truncation marker, so `get_subagent_result` later presents a cut-off message as "Final output".
- **Pre-existing interaction (not introduced):** after the hard cap finalizes, the session keeps running; when it eventually settles, `spawnBackgroundSession`'s `.then()` sets `status: 'completed'` + `completedAt` and persists — **overwriting the timed-out record**, so `get_subagent_result` shows "Status: completed" with partial output. The PR's persisted `finalOutput` makes this more misleading, not less.
- Pre-existing: hard cap counts as `completedSubagents++` rather than failed/timed-out.

**Recommendation:** factor extraction into one helper (e.g., `extractFinalOutput(session)` in `session-manager.ts`), wrap the hard-cap body in try/catch, and add an explicit "timed out" marker (e.g., `finalOutput: hardCapFinalOutput + "\n[… truncated by 30min hard cap]"`).

---

## Q5 — `get_subagent_result`: does `finalOutput` break the verbose transcript section?

- **Formatting: no breakage.** The block is inserted after the `Result:` section and before `\n\nTranscript (N entries):` with proper `\n\n` separators; an empty `finalOutput` is skipped (`if (agent.finalOutput)`); `\n` at the end of output is absorbed by the following separator. Ordering is sensible.
- **Duplication (low):** if both `agent.result` and `agent.finalOutput` exist (possible when `setAgentResult` is also called), the response contains two overlapping result sections.
- **Untruncated output (medium-high):** unlike the notification (500-char slice), the tool embeds the **entire** `finalOutput`. The last assistant message of a 30-minute background agent can be tens of KB to MBs (e.g., agent dumped a file/diff in its final message). pi's run loop imposes **no tool-result size cap** (only compaction summaries truncate, at 2000 chars — `compaction/utils.js:75`), so this payload goes wholesale into the main agent's context, risking context overflow, and the `Transcript: <path>` line appended last can be pushed out of the visible/truncated response. Inconsistent with the 500-char preview design.
- Markdown fences in the output render as markdown in the result panel (same as Q2).

**Recommendation:** truncate in the tool too (e.g., 4–8 KB with an explicit `…[truncated, full output in transcript]` marker), or move the transcript path *before* the output block.

---

## Q6 — Race between `setAgentFinalOutput` and `finalizeLiveSubagent`

- **No deletion race exists.** The two functions operate on **different stores**: `setAgentFinalOutput` on the session-manager `agents` map + `.pi/subagents/<id>.json`; `finalizeLiveSubagent` only schedules `state.subagentSessions.delete(id)` after 3 s. Nothing deletes agent records (`agents.delete` appears nowhere). The record cannot be deleted before persist.
- Ordering in the completion path is correct (`setAgentFinalOutput` → `finalizeLiveSubagent`).
- Interleaving of the three terminal paths (poll-completed, crash, hard cap) is safe: all are guarded by the single-threaded `completed` flag set before any finalize; the 3 s delayed delete cannot race a late `updateLiveSubagent` because the poller returns early once `completed` is set.
- The only shared-object race is between `setAgentFinalOutput` and `spawnBackgroundSession`'s `.then()/.catch()` — both mutate the *same* in-memory object, so no lost update; the last `persistAgent` wins and the file converges to contain both `finalOutput` and the final `status`. (The file bloat from these writes is the real problem — Q7.)

---

## Q7 — Is `setAgentFinalOutput`'s `persistAgent` safe if the record was removed?

- **Record-removal safety: yes.** `getAgent(id)` returns the map entry, falls back to `loadAgent(id)` from disk, and returns `null` if neither exists → `setAgentFinalOutput` early-returns without persisting. Nothing currently removes records anyway.
- **BUT `persistAgent` is unsafe for a different reason (SERIAL): `_sessionRef` is serialized into the record file.** `spawnBackgroundSession` assigns `agent._sessionRef = session` after the initial clean persist; every later persist — including all three new `setAgentFinalOutput` calls and the pre-existing `.then()/.catch()` handlers — serializes the **entire live session graph** (session, `agent.state.messages` incl. tool results with file contents, session manager entries, model runtime, settings manager, extension runner with the shared runtime). Empirically (pi 0.83.0, in-memory session, theme initialized, **one user message, no assistant messages**):

  ```
  STRINGIFY OK — size: 1367 KB   (JSON.stringify of { id, status, _sessionRef: session })
  ```
  and without theme init:
  ```
  STRINGIFY THREW: Theme not initialized. Call initTheme() first.
  ```
  (Cycle check: 4,924 reachable objects, 0 cycles — so no circular-ref crash, but the graph includes live getters with environment-dependent behavior.)

  Consequences:
  - Each completion/crash/timeout writes **~1.4 MB+ synchronously** (`writeFileSync`) on the main thread, blocking the entire pi event loop (including the main session's streaming) for tens to hundreds of ms; real 30-min runs (dozens of messages, tool results) push this to several MB.
  - `.pi/subagents/<id>.json` balloons; `getAgent`/`listAgents` after an extension reload (empty map) must `JSON.parse` megabytes per record.
  - If **any** getter in the 4,900-object graph throws (as the theme getter does when uninitialized — e.g., headless/non-interactive modes, or transient runtime state), `persistAgent` throws and `setAgentFinalOutput` propagates it into the completion/crash/hard-cap sequences with the abort behaviors described in Q3/Q4.

**Recommendation (must fix):** strip `_sessionRef` (and any other non-serializable/live fields) before persist — e.g., `const { _sessionRef, ...persistable } = agent; writeFileSync(..., JSON.stringify(persistable))` — or store `finalOutput`/status via a dedicated small document instead of the whole record. Wrap `setAgentFinalOutput`'s persist in try/catch so bookkeeping can't be aborted by a serialization failure.

---

## Q8 — Regressions for foreground tasks / existing background behavior

- **Foreground: none.** The diff touches only the `background` branch of `delegate_task`, `get_subagent_result`, and the new helper. Foreground `runChainMode`/`runParallelMode`/`runGraphMode` and the foreground live-monitor paths (index.ts:2394/2512/2553/2687) are untouched. All 555 tests pass.
- **Static import inconsistency (low):** `import { setAgentFinalOutput } from "./session-manager"` (index.ts:83) while every other access to session-manager is a deliberate dynamic import ("static import fails under concurrent jiti loads" is documented in session-manager for the pi package). `session-manager.ts` has no runtime top-level pi imports (only `import type`), so this specific static import is currently safe and creates no cycle — but it reintroduces the pattern the dynamic imports were designed around and should either be justified or made dynamic for consistency.
- **New failure mode (regression risk for *background* behavior):** `setAgentFinalOutput` is inserted mid-sequence in all three terminal paths; a persist failure now silently aborts completion bookkeeping (Q3/Q4) — previously the same paths could only fail at `sendMessage` (post-bookkeeping). The completion path is the worst: `completed = true` is already set, so the outer catch swallows the error and `activeSubagents` **never decrements** (footer stuck, subsequent spawns miscounted), `finalizeLiveSubagent` never runs (stale dashboard entry), and the notification is lost.
- `.gitignore` `sync-extension.sh` addition: unrelated, harmless.

---

## Priority-ordered recommendations

| # | Severity | Finding | Fix |
|---|----------|---------|-----|
| 1 | SERIAL | `persistAgent` serializes the live session via `_sessionRef` — 1.4 MB+ writes, can throw mid-completion | Exclude `_sessionRef` from serialization (destructure out); wrap persist in try/catch; make `setAgentFinalOutput` non-aborting |
| 2 | HIGH | `!isStreaming` is false during preflight and for failed starts → premature "completed" with `finalOutput: ''`; poller cleared while run continues | Use the record's status/`completedAt` (set by the settled prompt promise) as the completion signal, or check `messages` non-empty + not-streaming; treat `failed`/`stopped` status as terminal and notify accordingly |
| 3 | MEDIUM | Crash path unreachable (ref never nulled) + ordering bug (`setAgentFinalOutput` before `completed = true`) | Remove/repurpose the branch; set `completed` first; call `finalizeLiveSubagent` even on persist failure |
| 4 | MEDIUM | Hard-cap path: no try/catch; uncaught throw skips bookkeeping; extraction duplicated ×3 | Wrap timeout body; extract shared `extractFinalOutput()` helper; add truncation marker |
| 5 | MEDIUM | `get_subagent_result` embeds untruncated `finalOutput`; notification preview is markdown-rendered and can flow into the main LLM context | Truncate in the tool; escape/strip markdown in preview; consider display-only delivery |
| 6 | LOW | Static import inconsistency; empty-output notification trailing `\n\n`; surrogate-pair slice | Consistency cleanup; guard empty preview |

**Verdict:** the approach is sound and the happy-path extraction is correct, but the persist-serialization issue (1) and the completion-signal unreliability (2) should be fixed before merge. Neither is covered by the current test suite — the new code is entirely untested (add tests for `setAgentFinalOutput` persist shape, extraction helper, and the completion-state machine).

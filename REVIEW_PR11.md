# Adversarial Review — PR #11: Background Poller Cleanup

**Branch:** `chore/poller-cleanup` (f5055da)
**Files changed:** `src/index.ts` (+78/−38), `src/session-manager.ts` (+10)
**Verdict:** Solid, defensive cleanup — the shared `extractFinalOutput`, the guarded hard-cap path, and preview sanitization all land in the right direction. Findings below are mostly **minor / pre-existing**, with a handful of **medium** items worth addressing before merge. No regressions found in behavior; all 517 unit tests pass.

---

## 1. `extractFinalOutput` — message shape coverage

**Location:** `src/session-manager.ts:188–195`, used at `index.ts:2155, 2174, 2223`

I checked the actual pi 0.83 types (`@earendil-works/pi-agent-core` `types.d.ts:276`, `@earendil-works/pi-ai` `types.d.ts`):

- `AssistantMessage.content: (TextContent | ThinkingContent | ToolCall)[]` — **always an array**, never string/null.
- `UserMessage`/`CustomMessage`: `string | (TextContent | ImageContent)[]` (role-filtered out anyway).
- `BashExecutionMessage`, `BranchSummaryMessage`, `CompactionSummaryMessage`: no `content` field at all.

| Shape | Handled? |
|---|---|
| Array with `{type:"text", text}` blocks | ✅ |
| String content | ✅ (`typeof content === 'string'` — dead code for assistant msgs in pi 0.83, but harmless defense) |
| `null` / `undefined` content | ✅ (falls through to `''`) |
| `ThinkingContent` / `ToolCall` blocks | ✅ correctly skipped (only `type === 'text'` extracted) |
| Empty array `content: []` | ✅ → `''` |
| Tool-call-only final assistant message | ⚠️ **returns `''`** even when an earlier assistant message contains the real final text |

**Medium — tool-call-only last message gap.** `extractFinalOutput` takes the *last* assistant message unconditionally. In a tool-using session the final message is frequently a tool-call-only turn (e.g., agent ends mid-turn, is stopped, fails, or the 30-min hard cap fires between turns). In all those cases the extraction yields `''`, and the notification shows no output even though a previous assistant message had substantive text. The same limitation existed in the pre-PR inline code, so it's **not a regression** — but consolidating into a shared helper was the chance to fix it, and now the limitation is shared by all 3 call sites. Recommend: fall back to the *last assistant message with non-empty text content*, or at least consider `stopReason` (`'stop'`/`'length'` vs `'toolUse'`).

**Note (correct behavior):** `ThinkingContent` blocks are intentionally excluded — good; including them would leak reasoning traces into notifications.

**Type note:** the loose structural param type compiles fine against `AgentMessage[]` (all union members are assignable; `content` is optional in the target so content-less custom message types satisfy it).

---

## 2. `sanitizePreview` — markdown safety and edge cases

**Location:** `src/index.ts:138–154` (module scope, not exported, function declaration → hoisted, fine placement)

### Does it prevent markdown breakage? Mostly — the main vector is fixed
Stripping `` ` `` and ` ``` ` kills the dominant breakage mode (unclosed backtick/fence turning the rest of the notification into a code block). Remaining gaps:

- **Medium — tilde fences (`~~~`) are not stripped.** `~~~` is a valid CommonMark fence; an unclosed one still breaks rendering of everything after it.
- **Low — 4-space / tab-indented lines become code blocks.** `filter(l => l.trim())` drops whitespace-only *lines* but preserves leading whitespace on kept lines; a deeply indented output (common in code/JSON dumps) renders the remainder as an indented code block in CommonMark.
- **Low — `agent.description` (the label) is NOT sanitized.** The notification header `` Background agent "${agent.description}" completed `` interpolates `params.label` (user-controlled tool input) unsanitized — a label containing backticks still breaks the header. `sanitizePreview` only covers the output, which gives a false sense of completeness.
- **Low — `>` blockquotes, `#` headings, `---` rules, unbalanced-paren URLs** pass through and alter rendering (cosmetic; acceptable for a 500-char preview).
- **Low — HTML tags pass through** (`<b>`, etc.). pi's TUI almost certainly escapes these; not a concern unless a renderer with raw-HTML passthrough is used.

### Edge cases

| Case | Behavior |
|---|---|
| All-empty / whitespace-only lines | ✅ → `''`, notification shows header only; no crash |
| Emoji (non-BMP) | ✅ safe — whole lines are kept, never split |
| **Very long single line (no `\n`)** | ⚠️ **Dropped entirely → empty preview.** `if (out.length + line.length + 1 > maxLen) break;` never truncates a line; it only bounds how many *whole* lines fit. A 10KB one-line output (minified JSON, a URL, a single wrapped paragraph) yields an **empty preview** — worse than the pre-PR `slice(0, 500)`, which at least showed the first 500 chars. |
| **Surrogate-pair guard is dead code** | The doc comment claims "never split surrogate pairs at the boundary," but the boundary code is unreachable: lines are only appended whole, so `out.length ≤ maxLen−1` always, `out.slice(0, maxLen)` is a no-op, and the final char is always `'\n'` (never a high surrogate). The `[\uD800-\uDBFF]` check never fires. Not harmful — but misleading: the *actual* behavior for over-long lines is "drop entirely," not "truncate safely." Either implement real mid-line truncation (then the surrogate check becomes reachable — and it's correct for the one case it handles) or fix the comment. |

### Scope
Module-level in `index.ts` is acceptable. **Low:** the repo already has a purpose-built `src/sanitize.ts` (F3: `stripAnsi`, `capOutput` with UTF-8-safe byte truncation, covered by `sanitize.test.ts`). `sanitizePreview` is unexported and therefore **untested** (no tests reference it). Moving it to `sanitize.ts` would make it testable and keep truncation logic in one place.

---

## 3. Hard-cap try/catch — completeness and double-execution

**Location:** `index.ts:2216–2262`

**Catch path completeness:** sets `completed = true`, clears the interval, calls `finalizeLiveSubagent`, decrements `activeSubagents` (with clamp), increments `failedSubagents`, refreshes status, and sends a notification. That's the full bookkeeping. **Missing from catch:** `setAgentFinalOutput(...)` — if the throw occurred before the try reached it (the most likely throw point is `extractFinalOutput` → `[...session.messages]` throws `TypeError` if `messages` is ever undefined), the agent's persisted `finalOutput` is left unset, and `get_subagent_result` shows no final output even though the session had one. Minor.

**Double-execution risk — real but narrow.** If the throw happens *after* some try-path mutations (e.g., inside `updateProgressStatus` → `ctx.ui.setStatus`, or `pi.sendMessage`), the catch re-runs them:
- `finalizeLiveSubagent` twice → harmless (schedules two 3s deletions).
- `activeSubagents--` twice → **counter drift**: the `< 0` clamp only saves the all-zero case; with other agents running, the counter is wrong by one.
- `completedSubagents++` (try) **and** `failedSubagents++` (catch) → both counters inflate, status reads "1 done, 1 failed" for one agent.

The `completed` flag correctly prevents re-entry of the whole block, and the realistic throw points (extraction, `persistAgent`'s internals) occur *before* the mutations — so in practice the window is small. Still, the canonical fix is: do all fallible work first (capture output, build the message string), mutate counters last, and only then notify. Worth a comment or restructure.

**Semantics:** the catch path counts the agent as `failedSubagents++`, while the normal hard-cap path counts `completedSubagents++`. Timing out being counted as "completed" is the pre-existing convention (kept for the happy path), so the error path differing is defensible but inconsistent — a timeout is arguably a failure in both cases.

---

## 4. Crash path ordering

**Location:** `index.ts:2129–2153` — **unchanged by this PR** (pre-existing).

- The `if (!session)` crash branch is checked **before** `if (agent.completedAt)`. If the session ref were ever null while the agent had actually completed, the branch would send a false "crashed" notification and increment `failedSubagents`. The comment argues the ref is assigned synchronously and never nulled, so this is theoretical — but the ordering is fragile; checking `agent.completedAt` first would make it bulletproof.
- Otherwise the crash path is complete: finalize ✅, decrement ✅, `failedSubagents++` ✅, status ✅, notification ✅, and it seeds `setAgentFinalOutput` from the live monitor's cached output (a nice touch).
- No TDZ risk: `hardCapHandle` is declared synchronously before the first 2s tick can run.

---

## 5. 8000-char truncation in `get_subagent_result`

**Location:** `index.ts:2962–2965`

- **Reasonable cap** for a tool result; correct design choice to truncate only the *result text* while `agent.finalOutput` stays persisted in full.
- **Low — surrogate-pair / combining-sequence split:** `full.slice(0, 8000)` is UTF-16 code-unit based; an emoji straddling the boundary renders as a replacement char. The repo already has the pattern for this: `capOutput` in `sanitize.ts` does UTF-8-safe truncation. Reuse it or apply the same while-loop.
- **Marker renders correctly** (`\n…[truncated — full output in transcript]` — ellipsis + em dash are plain unicode text, safe in markdown). One caveat: the marker promises the full output is "in transcript," but on the **hard-cap path the transcript is never closed** (`transcript.completeTranscript` is only called from `session.prompt().then/.catch` in `session-manager.ts`), and the underlying session **keeps running** — polling stops but nothing aborts it. The persisted `finalOutput` is a 30-min snapshot, while the transcript will keep growing until the session eventually finishes (or never, if it hangs — which is presumably why the cap exists). The agent record also stays `status: "running"` forever on the hard-cap path (no `completedAt`/`status` update). Pre-existing, but this PR's marker makes the transcript claim explicit; consider marking the agent failed/stopped at hard cap.

---

## 6. Dynamic import — duplicate check

**Location:** `index.ts:2092`

```ts
const { spawnBackgroundSession, setAgentFinalOutput, extractFinalOutput } = await import('./session-manager');
```

✅ **Correct.** All three names are used within the same block: `spawnBackgroundSession` (2095), `setAgentFinalOutput` (2137, 2175, 2224), `extractFinalOutput` (2155, 2174, 2223). The static top-level `import { setAgentFinalOutput }` was removed (diff line `- import { setAgentFinalOutput } from "./session-manager";`). Other `session-manager` dynamic imports (`getAgent` 2929, `getTranscriptPath` 2979, `steerAgent` 3010) are in separate tool scopes — **no duplicate or shadowed imports**. `spawnBackgroundSession` is not imported twice.

---

## 7. Regressions

**None found.** Verified:

- **Live monitor:** still updated every 2s tick via `updateLiveSubagent(agent.id, finalOutput, stats…)` with the stats try/catch preserved (`index.ts:2156–2162`). Same semantics as before — including the pre-existing quirk that the monitor shows only the *last* assistant message's text, which flickers to `''` between tool-call turns (now centralized in `extractFinalOutput`).
- **Notifications:** sent on completion ✅, failed/stopped ✅, crash ✅, hard cap ✅, and now also on hard-cap error (new) ✅.
- **Tests:** `npx vitest run --exclude '**/e2e*'` → **25 files, 517 tests, all passing.**

**Pre-existing gap this PR leaves open (medium, since this is the "poller cleanup" PR):** the poll-tick **outer catch** (`index.ts:2202–2211`, unchanged from main) is the one failure path that still:
1. sends **no notification** (silent failure),
2. does **not** call `state.finalizeLiveSubagent(agent.id)` → the `subagentSessions` map entry is **never cleaned up** (cleanup only happens via `finalizeLiveSubagent`'s 3s timeout) → a **ghost entry persists in the live monitor**,
3. does **not** call `setAgentFinalOutput`.

The hard-cap catch got the full treatment (counters + finalize + notification); the tick catch got none. For consistency with the rest of this PR, it should mirror the hard-cap catch.

---

## 8. `sanitizePreview` usage consistency

| Path | Sanitized? |
|---|---|
| Completion (success) | ✅ `index.ts:2196` |
| Hard cap (timeout) | ✅ `index.ts:2232` |
| Hard-cap error path | ⚠️ No output included at all — acceptable (state unknown), but could include partial output for diagnostics |
| Crash path | No output — fine (nothing to show) |
| Failed/stopped | No output — pre-existing, fine |
| `get_subagent_result` | Correctly does **not** use it — raw tool result, not a rendered notification; uses its own 8000-char cap |

Consistent where output is included. No stale `finalOutput.slice(0, 500)` call sites remain (verified by grep).

---

## Priority summary

| # | Severity | Finding |
|---|---|---|
| 1 | **Medium** | `extractFinalOutput` returns `''` for tool-call-only final messages even when earlier text exists (shared across all 3 call sites now) |
| 2 | **Medium** | `sanitizePreview` drops over-long single lines entirely → empty preview; surrogate-pair guard is dead code; `~~~` fences and indented code blocks still break markdown; label interpolated unsanitized |
| 3 | **Medium** | Hard-cap catch: no `setAgentFinalOutput`; narrow double-mutation window if throw happens after counter mutations (both `completedSubagents++` and `failedSubagents++` can fire) |
| 4 | **Medium** | Poll-tick outer catch (pre-existing, untouched): no notification, no `finalizeLiveSubagent` → ghost live-monitor entry, no `setAgentFinalOutput` |
| 5 | **Low** | Crash branch ordering: `!session` checked before `agent.completedAt` (theoretical false "crashed") |
| 6 | **Low** | 8000-char slice can split surrogate pairs; `capOutput` in `sanitize.ts` already has the safe pattern |
| 7 | **Low** | Hard cap leaves agent `status: "running"` forever and never closes the transcript, while the truncation marker claims full output is in the transcript |
| 8 | **Low** | `sanitizePreview` unexported → untested; consider `sanitize.ts` |
| 9 | ✅ | Dynamic import: no duplicates, all 3 names used |
| 10 | ✅ | Notifications on all termination paths except the pre-existing tick-catch gap (see #4) |
| 11 | ✅ | No regressions; 517 tests pass; live monitor updates intact |

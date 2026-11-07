# #449 implementation brief — a settled run with no assistant output is not a success

**Status:** draft for plan critique. **Base:** `dev` @ `3914d6c` (2026-11-07).
**Risk:** C2 on the predicates, **C1** if the guard touches the settle branches themselves — the
implementer must not restructure settlement to add a check.
**Decision:** recorded in issue #449; reachability proven in
`issue-449-triage-2026-11-07.md`. Do not re-litigate whether this happens.

## Recon (verified this session)

The defect is **not** one branch — it is **two predicates that happen to agree**:

| path | decision site | today's rule | why zero messages passes |
|---|---|---|---|
| background | `src/session-manager.ts:1985` → `classifyTerminalOutcome` (`src/types.ts:1032`) | `stopReason` switch; `undefined` hits `default: { status: "completed" }` | `terminalStopReason = lastAssistant?.stopReason` (`:1957`) is `undefined` when the SDK removed the only assistant message |
| foreground | `isSubagentError` (`src/types.ts:922`) → `finalizeRunRecord`, `runChainMode`, `runGraphMode`, TUI counters (13 call sites) | `exitCode !== 0` or a terminal `stopReason` | `exitCode` is `0` and `stopReason` stays `undefined` |

`SubagentResult.messages` (`src/types.ts:462`) already carries the child's `message_end` events, so the
foreground side needs **no new plumbing** — the information is present, just unused.

Upstream cause (do not patch): the SDK classifies a recoverable `length` truncation as a retryable
recovery, **omits** the assistant message from the projection (`agent-session.js:2455`, `:2486`,
`:856-884`, `:583-589`), then the auto-compaction returns `undefined` on a young branch
(`compaction.js:609-643`), so the retry never runs and the run resolves.

`classifyError` (`src/types.ts:109`) already encodes the adjacent principle from #179 — a terminal
`stopReason` with no terminal answer is a failure (`length` → `truncated`, `toolUse`/`deferred`/`pending`
→ `incomplete`). This brief extends **the same idea** to the case where the terminal message is gone
rather than unusable. Do not invent a parallel vocabulary.

## Deliverable

1. **One shared predicate**, beside `isSubagentError` in `src/types.ts` — the single spelling of "this
   run settled with no assistant output at all". Both decision sites must call it; a second spelling
   inside either sink is the drift this brief forbids. It must be total (no throw) and cheap.
2. **Background sink:** before the `classifyTerminalOutcome` result is treated as `completed`, apply the
   predicate. The run must record `failed`, `exitCode 1`, and a **truthful** category. Use the existing
   `incomplete` category (it already means "terminal stop reason with no terminal answer") unless the
   implementer finds a better existing member — **do not add a new `ErrorCategory` member** without
   stopping to ask; the union is consumed by TUI, history and the completion message.
3. **Foreground sink:** `isSubagentError` (or the caller-side decision it feeds) must return true for a
   zero-exit result with no assistant message. One predicate, both sinks.
4. **The message must not overclaim.** The omitted message is intentionally removed by the SDK and is
   *not* recoverable from `session.messages`, so the reason cannot assert "truncated". State what is
   known and what is not, e.g. `Run settled with no assistant output — the provider's response may have
   been truncated and omitted by the SDK (see #449)`. It must not match any `TRANSPORT_SIGNATURES`
   entry, so the automatic transport retry does **not** fire for it.
5. **Completion message agrees.** `buildCompletionMessage` derives from `details.status`; a record of
   `failed` must produce a failure notification with the honest reason, and the history row must not
   read as success. No second classification rule inside the message builder.
6. Surgical: no new dependency; no change to `classifyTerminalOutcome`'s handling of *present* stop
   reasons; no attempt to reconstruct or re-insert the omitted message; no retention-policy change (see
   Limits).

## Acceptance

1. **Background, bypass-style** (controlled session, no pi schema, no provider): a session whose
   `messages` contain no assistant message and whose `prompt()` resolves → run entry `failed`,
   `exitCode 1`, category `incomplete`, completion message status not `success`, and **no** `done`
   record. Assert the persisted run entry, not only the in-memory agent.
2. **Foreground:** a `SubagentResult` with `messages: []`, `exitCode: 0`, no `stopReason` →
   `isSubagentError` true, and the run record `failed` through `finalizeRunRecord`; a chain/graph unit
   in that shape counts as a failed unit.
3. **Preservation — these must stay exactly as they are** (all measured in the triage):
   - zero-output *successes* with an assistant message present (empty content array, empty text block,
     thinking-only, tool_use-then-empty): `completed`, `turns ≥ 1`, empty output — **not** failures;
   - explicit `stopReason "length"` retained → `failed` / `truncated`;
   - multi-turn truncation where only the last assistant message is omitted → `failed` with
     `toolUse`-as-last classification, unchanged (wrong reason is a different issue);
   - `aborted` → `stopped`; `error` → `failed` / `exit_error`; timeout and normal success unchanged.
4. **Mutants** — state the expected failing tests **before** each run, and report survivors as
   survivors:
   - **M1** remove the predicate from the background sink only → background cases fail, foreground
     stays green;
   - **M2** remove it from the foreground sink only → the mirror image (proves the sinks are covered
     independently, not by one test);
   - **M3** implement the check as `usage.turns === 0` instead of "no assistant message" → the
     implementer must construct the discriminating case (a settled run with `turns 0` but an assistant
     message, or the reverse) and show it red; if no such case exists in this codebase, report M3 as
     **equivalent, not killed**;
   - **M4** fix only the completion message, not the record → the record-vs-message test fails.
5. **Historical baseline:** reproduce the false success on the pre-fix tree once and keep it as
   history; the post-fix falsifier is the zero-launch classification test, not the reproduction.
6. **Committed repro, not a test:** the triage harness lives in `/tmp` and will vanish. Commit a
   minimal reproduction (loopback fake provider + real SDK, the triage recipe) under
   `.development/investigations/repro/issue-449/` with a short README — **outside `src/__tests__`**, so
   it does not consume the test LOC budget.
7. **Gates:** `npx vitest run` (JSON report), `npm run typecheck`, both docs guards,
   `git diff --check`, README test-count drift, test budget. **Headroom is 629 lines at 1.97/2.0**; this
   fix should stay well under ~200 new test lines, and must not become the PR that breaks the budget.
8. **Docs:** CHANGELOG `Unreleased` entry stating the class, the honest limit (the omitted message is
   unrecoverable), and that the automatic transport retry does not fire; README only if the status
   vocabulary changes (it should not).

## Limits

- The guard is **structural, not diagnostic**: it cannot distinguish a truncation omission from any
  other resolve-with-no-assistant-message, because the evidence is gone. Say so in the code comment
  and the CHANGELOG rather than implying we detect truncation.
- **Data loss is not fixed.** The session directory is pruned on this path (the retention gate keys on
  `isTransportFailure`), so the work stays unrecoverable; the fix removes the false success, not the
  loss. Extending retention to this class is a **follow-up decision**, not part of this brief.
- Upstream: pi resolves successfully after its own recovery attempt did not run. We defend locally and
  report upstream with the committed repro; we do not patch `node_modules`.
- Not covered: the `openai-*` APIs and long-session compaction (the omission is above the provider
  layer, but neither was driven end to end).

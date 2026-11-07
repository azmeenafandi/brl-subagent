# #449 implementation brief — a settled background run with no assistant output is not a success

**Status:** amended after plan critique (`/tmp/CRITIQUE_449.md`, verdict needs-work); **scope narrowed to the
background path** by maintainer decision.
**Base:** `dev` @ `274f3dd` (2026-11-07). **Risk:** C2 — one pure classifier plus one call site; no control-flow change.
**Decision:** recorded in issue #449; reachability proven in `issue-449-triage-2026-11-07.md`.

## Scope decision, with the evidence that forced it

The first draft treated the defect as symmetric across background and foreground. **It is not:**

| path | what the evidence shows | verdict |
|---|---|---|
| background | the SDK removes the only assistant message from the **projected** `session.messages` before settling; `lastAssistant?.stopReason` is `undefined` → `classifyTerminalOutcome` hits `default: completed` | **the defect** |
| foreground | the child process emits `message_end` **for that turn** before the omission (measured: `message_end:assistant:length`), `runner.ts:971-980` records `stopReason: "length"`, so `isSubagentError` already returns true | **not affected — do not touch** |

Two traps the first draft fell into, both now forbidden:

- `BackgroundAgent.result.messages` is **always seeded `[]`** (`src/session-manager.ts:1613`) — it is not
  evidence of anything and must not be used.
- Widening `isSubagentError` would reclassify **deliberately handled input** (a user-global extension
  returning `{action:"handled"}` exits 0 with zero message events, measured) and would change chain
  continuation, graph dependents, aggregate results, circuit-breaker and slot accounting across 15 call
  sites — a policy decision with no basis in the measured defect.

**Out of scope, explicitly:** `isSubagentError`, the foreground child, chain/graph control flow, TUI
aggregates, and any retention-policy change.

## Deliverable

1. **One pure classifier, explicit evidence.** `classifyTerminalOutcome` (`src/types.ts:1032`) gains an
   evidence signal — `"present" | "absent" | "unknown"` — in its existing `extra` bag, **defaulting to
   `"unknown"`** so every current caller (`notify-completion.ts:175`, `types.ts:1076`) keeps today's
   behaviour. Only the background settle site supplies a real value. Do not add a second predicate, and do
   not compute presence inside the classifier.
2. **Precedence is preserved, and tested.** An already-known terminal outcome wins over the evidence:
   `aborted` → `stopped`; `error` / `length` / `toolUse` / `deferred` / `pending` → `failed`; a non-zero
   exit is handled by the caller as today. Evidence only decides the **formerly-default** case:
   `stopReason === undefined && evidence === "absent"` → `failed` / `incomplete`. Everything else, including
   `evidence === "unknown"`, keeps the current result.
3. **The settle site supplies the evidence** from the projected session (`session.messages` contains no
   assistant message → `"absent"`; otherwise `"present"`), i.e. `src/session-manager.ts:1985`. Nothing else
   changes in the settle branches.
4. **Truthful, non-overclaiming reason.** The omitted message cannot be recovered, so the reason must not
   assert truncation as fact. Use a fixed headline such as `Run settled with no assistant output — the
   provider's response may have been truncated and omitted by the SDK (see #449)`. It must not match any
   `TRANSPORT_SIGNATURES` entry, so automatic transport retry cannot fire; `incomplete` is independently
   excluded by the retry category gate.
5. **Reason priority.** When the guard fires, the headline wins over a stale
   `session.state.errorMessage` (the existing branch prefers that field). If such a message exists it may be
   appended, but it must not replace the headline — and a test must pin that with both present.
6. **Every background surface agrees.** Agent record (`failed`, `exitCode 1`), persisted run entry
   (`failed`, category `incomplete`), completion message (failure, using the same reason), transcript and
   failure event. `buildCompletionMessage` constructs its details from `agent.status` and the run and calls
   `classifyTerminalOutcome` again (`src/notify-completion.ts:168-201`) — assert the **persisted** record,
   not only the wake.

## Acceptance

1. **Bypass-style, background** (controlled session, no pi schema, no provider): projected `messages` with no
   assistant message + `prompt()` resolves → run entry `failed`, `exitCode 1`, category `incomplete`,
   completion message failure, and **no** `done` record. Assert the persisted entry.
2. **Precedence (P2):** pre-stamped `stopped` + zero projected messages → stays `stopped` (the retry-abort
   path). Explicit `length`/`error` with zero projected messages → their existing categories, not
   `incomplete`.
3. **Stale reason:** `session.state.errorMessage` set + zero projected messages → headline present, stale
   text not substituted.
4. **Preservation:** zero-output successes **with** an assistant message present (empty content array, empty
   text block, thinking-only, tool_use-then-empty) stay `completed` with `turns ≥ 1`; multi-turn truncation
   (P3) keeps its existing `failed` classification; `aborted`/`error`/timeout/normal success unchanged.
5. **Foreground untouched:** assert the current foreground verdicts explicitly — a `length`-terminated stream
   still fails via its own path, and a handled-input exit-0 stream still passes — so a future edit cannot
   quietly extend the guard.
6. **Fixture hygiene:** any existing background success fixture that relies on `messages: []` must be
   repaired by giving it an assistant message, **never** by weakening an assertion or adding an
   evidence-default escape. The critique measured 7 failures / 114 tests when a literal guard was applied
   globally; that is a fixture defect, not a reason to soften the rule.
7. **Mutants — state the expected failing test before each run; report survivors as survivors:**
   - **M1** default the evidence to `"present"` (guard never fires) → test 1 fails, preservation stays green;
   - **M2** apply the guard **before** the precedence switch (zero messages + pre-stamped `stopped` becomes
     `failed`) → test 2 fails;
   - **M3** implement the condition as `usage.turns === 0` instead of assistant absence → test 4 fails, using
     an assistant `message_end` **without `usage`** (measured to parse as one assistant turn, `turns 0`);
     label it a supported parser fixture, not a claim about a conforming provider message;
   - **M4** fix only the completion message, not the record → the persisted-entry assertion fails.
8. **Committed repro, not a test:** commit a minimal reproduction (loopback fake provider + real SDK) under
   `.development/investigations/repro/issue-449/` with a short README — **outside `src/__tests__`**, which the
   budget script does not walk (verified). It must use `env -i` and `PI_OFFLINE=1`; nothing else has proven
   safe.
9. **Gates:** `npx vitest run` with a JSON report **from the final tree** (not a synthetic input), `npm run
   typecheck`, both docs guards, `git diff --check`, README test-count drift, test budget. Headroom is
   **629 lines** at 1.97/2.0; this fix should stay well under ~150 new test lines.
10. **Docs:** CHANGELOG `Unreleased` — the class, the honest limit (the omitted message is unrecoverable and
    truncation is not proven), that automatic transport retry does not fire, and that the foreground path is
    unchanged. README only if a user-visible status changes (it should not).

## Limits

- **Structural, not diagnostic:** the guard cannot distinguish a truncation omission from any other
  resolve-with-no-assistant-message, because the evidence is gone. The code comment and CHANGELOG must say so.
- **Data loss is not fixed:** the session directory is pruned on this path; the fix removes the false
  success, not the loss. Retention is a separate decision.
- **Upstream:** pi resolves successfully after its own recovery attempt did not run. Report it with the
  committed reproducer; do not patch `node_modules`. The report's scope (bare SDK only, or also the
  extension's background record) is a follow-up decision, not part of this change.
- Not covered: the `openai-*` APIs and long-session compaction (the omission is above the provider layer, but
  neither was driven end to end).

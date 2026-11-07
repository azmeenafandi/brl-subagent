# #449 implementation brief — a settled background run with no assistant output is not a success

**Status:** amended twice. The first critique (`issue-449-plan-critique-2026-11-07.md`) narrowed the scope to
the background path; the second replaced the mutants, pinned the surface contract and hardened the
reproducer. **Scope: background path only**, by maintainer decision (recorded in issue #449).
**Base:** `dev` @ `f2922e4` (2026-11-07). **Risk:** C2 — one pure classifier plus one call site; no control-flow change.
**Reachability:** proven in `issue-449-triage-2026-11-07.md`.

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
   `"unknown"`** so every current caller (`notify-completion.ts:179`, `types.ts:1076`) keeps today's
   behaviour. Only the background settle site supplies a real value. Do not add a second predicate, and do
   not compute presence inside the classifier.

   **`"absent"` means exactly one thing:** an array that was *read* and contains zero assistant messages. A
   missing or throwing `messages` getter is **not** `"absent"` — it takes the existing catch-all
   (`session-manager.ts:2059-2065`), which still records completion. That is a known limit, documented, and
   **not repaired here** (`background-session-persistence.test.ts:717-733` deliberately tests the unreadable
   getter; adding a message cannot fix it).
2. **Precedence is preserved, and tested.** An already-known terminal outcome wins over the evidence:
   `aborted` → `stopped`; `error` / `length` / `toolUse` / `deferred` / `pending` → `failed`; a non-zero exit
   is handled by the caller as today. Evidence only decides the **formerly-default** case:
   `stopReason === undefined && evidence === "absent"` → `failed` / `incomplete`. Everything else, including
   `evidence === "unknown"`, keeps the current result.
3. **The settle site supplies the evidence** from the projected session (`session.messages` read and
   containing no assistant message → `"absent"`; otherwise `"present"`), i.e. `src/session-manager.ts:1985`.
   Nothing else changes in the settle branches.
4. **Truthful, non-overclaiming reason.** The omitted message cannot be recovered, so the reason must not
   assert truncation as fact. Use a fixed headline such as `Run settled with no assistant output — the
   provider's response may have been truncated and omitted by the SDK (see #449)`. It must not match any
   `TRANSPORT_SIGNATURES` entry, so automatic transport retry cannot fire; `incomplete` is independently
   excluded by the retry category gate.
5. **Reason priority.** When the guard fires, the headline wins over a stale `session.state.errorMessage`
   (the existing branch prefers that field). If such a message exists it may be appended, but it must not
   replace the headline — and a test must pin that with both present.
6. **Surface contract — pinned, field by field.** The reader must know exactly what carries what:
   - **agent record**: `status: "failed"`, `result.exitCode === 1`, `error` = headline;
   - **persisted run entry**: `status: "failed"`, `errorCategory: "incomplete"`. The run entry has **no
     `exitCode` field** — assert the agent's, not the entry's;
   - **completion message**: failure (the same reason). `buildCompletionMessage` builds its details from
     `agent.status` and the run and calls `classifyTerminalOutcome` again
     (`src/notify-completion.ts:168-201`) — assert the **persisted** record as well as the wake;
   - **transcript**: today it records only `Transcript completed: failed` (`src/transcript.ts:114-127`) —
     no new field is required, and none may be assumed;
   - **failure event**: carries the error text, **no category** (`src/types.ts:353-425`) — do not assert one.
   If the implementer believes the transcript or the event needs a new field, **stop and ask**; the brief
   does not authorize that, and the earlier "nothing else changes in the settle branches" stands.

## Acceptance

1. **Bypass-style, background** (controlled session, no pi schema, no provider): projected `messages` with no
   assistant message + `prompt()` resolves → persisted agent `failed` with **`result.exitCode === 1`**, run
   entry `failed` with category `incomplete`, completion message failure, and **no** `done` record.
2. **Precedence, against the pure classifier:** explicit `length` / `error` / `toolUse` / `deferred` /
   `pending` with `evidence: "absent"` keeps its existing category (not `incomplete`); `aborted` returns
   `stopped`. These are classifier-level assertions — a zero-assistant *settle site* with an explicit
   `length` cannot be constructed, so do not pretend to.
3. **Precedence at the settle site (P2):** pre-stamped `stopped` + zero projected messages → stays
   `stopped`. This branch returns **before** the classifier (`session-manager.ts:1956-1986`), so the test
   proves the ordering, not the classifier.
4. **Stale reason:** `session.state.errorMessage` set + zero projected messages → headline present, stale
   text not substituted.
5. **Preservation:** zero-output successes **with** an assistant message present (empty content array, empty
   text block, thinking-only, tool_use-then-empty) stay `completed`; multi-turn truncation (P3) keeps its
   existing `failed` classification; `aborted`/`error`/timeout/normal success unchanged.
6. **Foreground untouched:** assert the current foreground verdicts explicitly — a `length`-terminated stream
   still fails via its own path, and a handled-input exit-0 stream still passes — so a future edit cannot
   quietly extend the guard.
7. **Fixture inventory — measured, and it is small:** no background success assertion in `src/__tests__`
   depends on an explicit empty projected array. With a background-only guard, `session-manager.test.ts` ran
   104/104 and `background-session-persistence.test.ts` 33/33 green. The earlier "7 failures / 114" figure
   came from a **global foreground** predicate experiment and is **not** a background fixture defect — do not
   repair generic `SubagentResult.messages: []` fixtures on that basis; it would erase useful foreground
   coverage. Repair only a fixture proven to exercise the background projected session.
8. **Mutants — state the expected failing test before each run; report survivors as survivors.** The first
   draft's M1 and M2 were **equivalent/dead** (measured):
   - **M1** — *not* "default to present" (that cannot override the settle site's explicit `absent`; measured
     to survive). Instead **drop the explicit `absent` supplied by the settle site** (leave it `unknown`) →
     test 1 fails, preservation green.
   - **M2a** (pure classifier): make evidence win **before** the stop-reason switch → test 2 fails on
     `length`/`error` + `absent`.
   - **M2b** (settle ordering): move the guard **ahead of the pre-stamped `stopped` branch** → test 3 fails.
     The pre-stopped branch returns before the classifier, so test 3 kills only this mutation — that is why
     the two are split.
   - **M3** — the missing-`usage` fixture alone does **not** kill `usage.turns === 0` when the message still
     carries `stopReason: "stop"` (measured: it survived). The killer needs an assistant with **no `usage`
     AND no `stopReason`** in the projected session, asserting `completed` with `turns 0`; label it a
     **nonconforming synthetic boundary** (the SDK type requires both fields), not a real provider message.
   - **M4** fix only the completion message, not the record → the persisted-entry assertion fails.
9. **Committed repro, not a test:** commit a minimal reproduction (loopback fake provider + real SDK) under
   `.development/investigations/repro/issue-449/` with a short README — **outside `src/__tests__`**, which the
   budget script does not walk (verified). **`env -i` + `PI_OFFLINE=1` are NOT sufficient** (measured):
   `env -i … node -p 'os.homedir()'` still returns the real home, the SDK derives agent/auth paths from it,
   and `PI_OFFLINE` only disables *startup* network operations. The invocation must set a scratch `HOME`
   **and** `PI_CODING_AGENT_DIR`, fake credentials, and a provider base URL that is loopback-only. The
   README must state that criterion, and the check must be observable: **`message_end` with
   `stopReason: "length"`, a resolved prompt, zero assistant messages in the projected session, and a
   persisted record of `failed` / `incomplete`.** A script that merely exits 0 is not evidence.
   Budget this honestly: analogous test blocks run 19–61 lines each, so **150–250** lines is the realistic
   cost of tests 1–6 plus fixture repair — not the first draft's "well under 150".
10. **Gates:** `npx vitest run` with a JSON report **from the final tree** (not a synthetic input), `npm run
    typecheck`, both docs guards, `git diff --check`, README test-count drift, test budget. Headroom is
    **629 lines** at 1.97/2.0 against a 150–250 line cost — this fits, but it is not free; do not pad it.
11. **Docs:** CHANGELOG `Unreleased` — the class, the honest limit (the omitted message is unrecoverable and
    truncation is not proven), that automatic transport retry does not fire, and that the foreground path is
    unchanged. The README criterion means **no new status vocabulary**; the displayed outcome for this class
    does change from `completed` to `failed`, and the CHANGELOG must say so plainly.

## Limits

- **Structural, not diagnostic:** the guard cannot distinguish a truncation omission from any other
  resolve-with-no-assistant-message, because the evidence is gone. The code comment and CHANGELOG must say so.
- **Unreadable projection is not covered:** a throwing `messages` getter takes the existing catch-all.
- **Data loss is not fixed:** the session directory is pruned on this path; the fix removes the false
  success, not the loss. Retention is a separate decision.
- **Upstream:** pi resolves successfully after its own recovery attempt did not run. Report it with the
  committed reproducer; do not patch `node_modules`. The report's scope (bare SDK only, or also the
  extension's background record) is a follow-up decision, not part of this change.
- Not covered: the `openai-*` APIs and long-session compaction (the omission is above the provider layer, but
  neither was driven end to end).

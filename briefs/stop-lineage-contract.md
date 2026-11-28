# Brief — `stop_subagent`'s dispatch contract (#616)

Slug: `stop-lineage-contract` · grilled 2026-11-28, one question at a time, eight decisions.
Issue: #616 (`tooling: stop_subagent reports success on a superseded agent while its transport retry runs on`).
Ship shape: **PR A of two** (PR B is `briefs/settle-attempt-cause.md`).

## Want

> "The stop/report contract is what a conductor relies on to know a run is dead. Here 'stopped' was
> false, and the consequence was not cosmetic: an off-protocol run produced an `approve-with-nits` record
> that would have gated a merge."
> — the maintainer, issue #616.

> "1, auto-retry-scoped."
> — the maintainer's answer on the contract (Q1), 2026-11-28.

The stop tool must stop what it says it stopped, and the sentence it prints must never describe a dead
agent while a live one of the same dispatch keeps writing.

## Facts

Sources: `recon-616` = the read-only probe dispatch (2026-11-28, `deepseek/deepseek-flash`, facts returned
inline); `codegraph` = the conductor's `codegraph_explore` answers the same day. Files are at `dev @ 16b79ed`.

| # | Fact | Source |
|---|---|---|
| F1 | The stop tool is a 3-line adapter: `stopAgent(params.agent_id)`, and for **any** non-null return it prints `Stopped agent <id> (<description>).` It never calls `resolveAgentId` or `findRetryLineage`. | `src/agent-tools.ts:296-316` |
| F2 | `stopAgent` returns the agent **unchanged** when its status is already `completed`/`failed`/`stopped`, so "already dead" and "just stopped" are the same return value. The primitive is honest; the caller's message is the lie. | `src/session-manager.ts:1523-1529` |
| F3 | `get_subagent_result` already resolves 8-hex prefixes and prints `Superseded by <id> (attempt N, <status>, started …)`. | `src/agent-tools.ts:87-110`, `:171-185` |
| F4 | The lineage reader `findRetryLineage` joins a family by `dispatchId`, falling back to direct `resumeOf` children, and folds in the in-flight registry. It reads **only** the persisted agent store `.pi/subagents/<id>.json` — never session run history. | `src/session-manager.ts:1200-1241`, `:1134-1160` |
| F5 | Persisted agent records carry the identity: `dispatchId`/`resumeOf`/`attempt` (`src/types.ts:903-905`), stamped at spawn (`src/session-manager.ts:1905-1907`), and `persistAgent` keeps them. `RETRY_IDENTITY_KEYS` = `id, dispatchId, resumeOf, attempt, status, startedAt`. | `src/session-manager.ts:774-781`, `:574` |
| F6 | **No discriminator exists** between an automatic transport retry and a manual `retryRunId` retry: both mint through `newDispatchIdentity` (same `dispatchId`, `resumeOf`, `attempt + 1`), and `snapshotOriginalParams` records a fixed key set that omits `retryRunId`. `SubagentRun` has no retry-cause field. | `src/background-pipeline.ts:942`, `src/delegate-handler.ts:1543`, `src/recovery-engine.ts:154-164`, `src/params.ts:94-113`, `src/types.ts:368-462` |
| F7 | The automatic retry is only ever **attempt 2**: `isTransportRetryable` requires `attempt ?? 1 === 1`, a background run and a recorded `originalParams`. | `src/transport-retry.ts:84-89` |
| F8 | A retry inherits its label (`label: params.label ?? run.label`), and an automatic retry never passes through `delegate_task`, so the ledger has one row for two agents. | `src/history.ts:211` |
| F9 | **Spawn window**: attempt 2 gets its id at `src/session-manager.ts:1711`, its agent record lands at `:1917` and its registry entry at `:1955`. Between them nothing knows it exists, and `stopAgent` can only reach a session through the live in-memory `_sessionRef` (set at `:2436`). | recon-616 F2/Q4 |
| F10 | The spawn re-writes its registry entry immediately **before** `session.prompt()` — a natural gate for a cancel check. | `src/session-manager.ts:2938` |
| F11 | `AgentStatus` = `pending | running | steered | completed | failed | stopped`; only `running`, `completed`, `failed`, `stopped` are ever written today; `isTerminalAgentStatus` = the last three. | `src/types.ts:839`, `src/session-manager.ts:835-837` |
| F12 | The family reader is bounded: a 7-day mtime window and the newest 200 records. | `src/session-manager.ts:759`, `:762`, `:1134-1160` |
| F13 | The stop contract is documented as **per-id and idempotent**: "an already-terminal agent is a no-op success". `stopAgent`'s terminal no-op is pinned by tests; the tool description is pinned byte-for-byte; the two message literals are pinned by a mocked handler test. | `README.md:161-165`, `src/__tests__/session-manager.test.ts:622-673`, `src/__tests__/registration-surface.test.ts:146-149`, `src/__tests__/s5-factories.test.ts:341-354` |
| F14 | No other path performs lineage work, because no other path claims dispatch-level success: the deadline timer, the post-abort settle branch and boot abandonment are all per-id flips. The stop tool is the only production caller of `stopAgent`. | recon-616 Q5 |
| F15 | A `retryRunId` retry of a transport-failed attempt 1 is indistinguishable from the automatic one (F6), and I found no guard preventing both from existing as siblings under one `dispatchId`. | `src/delegate-handler.ts:464-491` (no such check) |

## Settled decisions

| Decision | Answer | Why |
|---|---|---|
| The contract (Q1) | **Dispatch-scoped stop**: "stop everything of this dispatch that is running", with a per-attempt honest report. Postcondition: nothing in scope is running. | A stop that over-stops is visible in its own result and recoverable; one that under-stops keeps writing files — the incident. |
| Family scope (Q1) | **Automatic transport retries only.** A manual retry is never stopped by a stop aimed at the original dispatch; `retryCause: manual` is a scope filter, **not** an immunity (naming it directly stops it). | The maintainer wants precision: don't halt a run they deliberately started. |
| Discriminator (Q2) | **New additive field `retryCause: "transport" \| "manual"`** on the dispatch identity, stamped at both mint sites, persisted on the run record, the registry input and the agent record, added to `RETRY_IDENTITY_KEYS`. Absent ⇒ `unknown` ⇒ **never** auto-stopped, and disclosed. | Inference from the parent's failure class cannot tell a manual retry of a transport-failed attempt from the automatic one (F6/F15) — the exact over-stop the narrowing exists to prevent. |
| Spawn window (Q3) | **Armed-retry marker + cancel honoured at the pre-prompt gate.** `scheduleTransportRetry` records the armed retry durably before the spawn; the gate at `:2938` aborts instead of prompting when a cancel is set; a stop of the family sets it. | Otherwise a stop during the window prints "nothing running" while the retry is starting — the same lie, milder window. |
| Out-of-scope live member (Q4) | **Success, residue named.** Error reserved for an in-scope live attempt that does not reach a terminal status. | "The dispatch is settled" is no longer the promise; erroring on a correct scoped stop would blunt the error class that must stay meaningful. |
| Shared label (Q5) | **In scope, tooling-only (PR B)**: `--settle` gains `--attempt N` / `--cause transport\|manual` keyed columns; still exactly one settle per dispatch. No label change, no ledger key change, no `src/` change. | The process record is a different defect, but one row must be able to say which attempt did the work. |
| Addressing (Q6) | **`resolveAgentId` exactly as the result tool uses it**: full id or unique 8-hex prefix; ambiguous ⇒ error listing matches, stopping nothing; unresolved ⇒ `not found`. No `dispatchId` addressing, no label addressing. | Every notice prints only 8 hex characters; and labels are shared across attempts — that *is* #616. |
| Reader bounds (Q7) | **Disclose, don't fail:** when the requested record predates the window or the scan returned exactly the cap, append a bound line and keep success. | The claim "nothing of this dispatch is running" is universal, so it must not rest silently on a truncated scan; an error would fail correct stops of old dispatches. |
| README (Q2 follow-up) | **Update the documented shape** to whatever this PR ships. | The maintainer's instruction; `README.md:161-165` currently promises the per-id contract. |
| Ship shape (Q8) | **Two PRs, two briefs.** This one is C1: adversarial review + a live probe at merge. PR B is the settle tooling. | The C1 review should see a diff that contains only the stop contract; PR B has its own `--selftest`/ledger surface. |

## Contract (what the implementation must satisfy)

- **Resolve** the target with `resolveAgentId`; **expand** to the family with `findRetryLineage` (registry folded
  in, F4); **filter** to `retryCause === "transport"`; **live** = status in `pending | running | steered`
  (only `running` is written today, F11), ordered by `attempt`, then `startedAt`; stop each **sequentially**,
  collecting outcomes — one throw must not hide another.
- **Verify from records, not from the primitive's return**: re-read each stopped id and require a terminal
  status before the word "Stopped" may describe it (F2).
- **Never print a universal claim** — "nothing of this dispatch is running" — when: an auto-retry is armed or
  spawning (Q3), a family member's cause is `unknown` (Q2), or the scan was truncated (Q7). Each case has its
  own disclosure line.
- **Armed marker**: durable and atomic in the existing run registry; written before the spawn; cleared on
  spawn settlement or cancel; must **not** render as a run row in the monitor or the run history (it is an
  intent, not a run). Cancel is honoured at the pre-prompt gate (F10). The sliver between that check and
  `session.prompt()` is unprotectable and must be stated in the PR body, not papered over.
- **Idempotence kept**: a terminal family with nothing live and nothing armed is a success (`nothing running`),
  performs no abort, and stays non-error — the documented contract survives in its new dispatch-scoped form.
- **Wording** is the implementer's, but each line must carry: the id it acted on, its attempt number, its
  cause, and — for residue — the id, attempt and cause of what was left running. Tests pin every line.
- **Docs and pins in the same PR**: `README.md:161-165`, the byte-pinned tool description
  (`src/__tests__/registration-surface.test.ts:146-149` + its fixture), and the two message literals in
  `src/__tests__/s5-factories.test.ts:341-354`.
- **Non-goals**: stopping manual retries by dispatch; foreground retries (no agent record, no `_sessionRef`);
  widening the reader's window; label changes at mint time; ledger keying by `dispatchId`; #620.

## Falsifiers (each must fail on the pre-fix tree and pass on the fix)

1. Attempt 1 dead (transport), attempt 2 live (transport) → attempt 2's record flips terminal, the text names
   attempt 2, and it does **not** contain `Stopped agent <attempt1>`.
2. All-terminal family → no `Stopped` prefix anywhere; the terminal status is named; `isError` false.
3. Live **manual** retry, stop aimed at attempt 1 → the manual run is untouched (status unchanged, no abort
   observed) and is named as still running; the call succeeds.
4. Stop names the manual retry's own id → it stops.
5. Stop during the spawn window (armed marker present, no record yet) → the cancel is honoured: no prompt
   reaches the model, the record settles `stopped`, and the text says a spawning retry was stopped.
6. A family member with `retryCause` absent → not stopped, and the text says the cause could not be established.
7. Prefix `99f4e815` resolves and stops; an ambiguous prefix refuses and stops nothing.
8. Truncated scan (record older than the window, or scan at the cap) → the bound is disclosed; no universal claim.
9. Idempotence: a second stop reports nothing running, aborts nothing a second time, does not error.
10. Single live agent, no lineage → the existing `Stopped agent <id> (<description>).` shape is preserved.

Mutation targets: replace the live set with `[found]` (today's behaviour) → F1; drop the `retryCause` filter →
F3; treat absent cause as transport → F6; ignore the armed marker → F5; skip the post-stop re-read → F9;
resolve with `getAgent` instead of `resolveAgentId` → F7; drop the disclosure lines → F8.

confirmed: 2026-11-28 by Azmeen

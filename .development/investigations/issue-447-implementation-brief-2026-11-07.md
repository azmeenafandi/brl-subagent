# #447 implementation brief — a dispatch that never reached the prompt is not "interrupted"

**Issue:** #447 (`fix: a dispatch that never reached the prompt is offered as an interrupted, retryable run`).
**Risk:** C1 (record vocabulary + boot scan; Jev said C1 at 0.53).
**Worktree:** `../brl-subagent-447` (`fix/447-acceptance-marker`).

## Recon (rule 13)

```
## Recon (Rule 13 — codegraph @ 6c8ee27)
- targets: `recoverInflightRuns` (src/recovery.ts:248), `runBootScan` (recovery-engine),
  `persistRunRecord` / `registerInflightRun` / `markInterrupted` (session-manager / registry),
  `buildRecoveryNotice` (recovery-surface)
- callers(recoverInflightRuns): the session_start hook only.
- grep delta: the durable-write ordering inside `spawnBackgroundSession` has no symbol; it was
  read directly (agent record ~:1434, registry entry ~:1436, run entry `persistRunRecord` :1461,
  transcript :1571, deadline :1962-1972, prompt :1975).
```

## The defect (measured in the #439 investigation §1.2, §3, §4 — do not re-derive)

The durable run/registry entry is written **long before** `session.prompt()` (`:1975`). Two
pre-start throws leave residue that the boot scan then presents as a started-and-died run:

- **S1** — the registry `appendEntry` throws (reproduced with a real `ENOENT`): the spawn rejects,
  the registry entry survives `kind: background` with **no** `interruptedAt`, and the on-disk agent
  record stays `running`. `prompt` was never called.
- **S2** — `transcript.startTranscript` (`:1571`) fails (`ENOTDIR`): same, and the **run entry** also
  stays `running`.
- A genuine pre-start throw at `prompt()` itself is already handled by #448 (sync-throw catch →
  `finalizeRunEntry('failed', …)`); the gap is the region **before** it.
- The reverse direction is equally wrong: nothing distinguishes "prompt never invoked" from "prompt
  accepted, provider silent" — both are `status: "running"`.

## Fix: a tri-state acceptance marker (`null` → string), plus a pre-start cleanup

### 1. Marker on both durable records

Add `acceptedAt?: string | null` to `SubagentRun` (`types.ts`) and to the inflight registry entry
type. It is **written at creation as `null`** (JSON keeps `null`; this is what makes "tracked and
not yet accepted" distinguishable from "legacy record" — see §3). It is set to an ISO timestamp by
ONE write immediately **before** `session.prompt(...)`.

- The acceptance write must be **fail-safe**: if it throws, the dispatch must NOT start — run the
  pre-start cleanup (§2) and rethrow. A run whose acceptance we cannot record must not run, or the
  residue problem returns.
- Keep the write in lockstep with the run entry and the registry (`persistRunRecord` for the run
  entry + the registry update, both already used at creation) so the two never disagree.

### 2. Pre-start cleanup (in-process throws)

Wrap the region **after** the durable writes and **before** `prompt()` — transcript start, git/branch
setup, the acceptance write — in a try/catch that on throw: clears the deadline if armed, calls
`cleanupWorkBranch()`, finalizes the run entry as `failed` with a message that says the prompt was
never issued (`errorCategory` may stay `unknown`, or reuse the existing default), and clears the
registry entry (`clearInflightRun`). Then rethrow, so the caller still sees the spawn failure (that
classification is #439's; this issue does not change what the caller is told).

`finalizeRunEntry('failed', …)` already prunes per its contract — for a run whose prompt was never
issued, pruning is correct (nothing can be writing). State that explicitly in a comment, because it
is the one place where pruning is provably safe.

### 3. Boot scan: `null` means never started, `undefined` means legacy

In the record-building step of `recoverInflightRuns` (`src/recovery.ts:271-296`), read the
acceptance state from the entry (fallback: the agent record):

| `acceptedAt` | classification |
|---|---|
| ISO string | **accepted** — today's behaviour exactly (dead owner ⇒ `interrupted`, recovery surface lists it, retry offered) |
| `null` | **never started** — do NOT set `interruptedAt`; finalize the entry `failed` with a "prompt was never issued" reason; not offered as interrupted/retryable |
| `undefined` | **legacy/untracked** — today's behaviour (a pre-upgrade record must not lose its retry offer) |

This tri-state is the whole compatibility story: new runs are never `undefined` (they write
`null` at creation), so no new residue can land in the legacy bucket; old records keep their
meaning.

### 4. Recovery surface

No vocabulary change is needed: `buildRecoveryNotice` keys on `interruptedAt`, and the never-started
class never gets one. Pin that with a test — do NOT invent a fourth display status. State in the
brief-following comment at the marker: the display vocabulary stays `running | completed | failed |
stopped`; "started, outcome unknown" remains #439's business.

## Tests (branch checklist — ADR 0021 §1)

- **A1 (S1)** — registry write throws before the prompt: the run entry ends `failed` (not
  `running`), the registry entry is cleared, and a subsequent `recoverInflightRuns` + notice build
  lists **nothing** for that id.
- **A2 (S2)** — `startTranscript` throws: same assertions.
- **A3 (acceptance write)** — a throw in the acceptance write itself ⇒ prompt never invoked, cleanup
  ran, no residue.
- **A4 (order pin)** — the acceptance write happens after the transcript/start and before `prompt`
  (inject an ordered recorder; assert `acceptance < prompt`).
- **A5 (regression, accepted)** — a record with `acceptedAt: <iso>` and a dead owner is still marked
  `interrupted`, still listed, still retryable (the exact today-behaviour pin).
- **A6 (legacy)** — a record with **no** `acceptedAt` field keeps today's behaviour (interrupted,
  listed). This is the compatibility pin.
- **A7 (null round-trip)** — `null` survives the JSON round-trip of the persisted run entry and
  registry entry (a `undefined` would be dropped by JSON — that is why `null` is the sentinel).

## Named mutants and their killers

| # | Mutation | Killer |
|---|---|---|
| M1 | skip the pre-start cleanup (today's code) | A1, A2 |
| M2 | write the marker as `undefined` instead of `null` | A7 (and A1/A2 misclassify) |
| M3 | treat `undefined` as never-started | A6 |
| M4 | treat `null` as accepted | A1, A2 (still listed as interrupted) |
| M5 | mark interrupted for the never-started class | A1's notice assertion |
| M6 | write the acceptance marker *after* prompt | A4, and A1/A2 lose the marker distinction |
| M7 | let the acceptance write fail and still prompt | A3 (prompt must not be invoked) |

## Boundaries and budget

- No change to the recovery **policy** for accepted runs (kill/offer decisions stay).
- No fourth display status; no history/dashboard redesign.
- The caller-side classification of a pre-start throw is #439's; this issue keeps `isError: true` and
  the existing wording there.
- Net test growth ≤ ~110 lines (suite ratio 1.98 / 2.0).
- Gates: `npx vitest run`, `npm run typecheck`, `node scripts/check-test-budget.mjs <report>`,
  `node scripts/check-readme-test-count.mjs <report>`.
- CHANGELOG entry: the record vocabulary gains `acceptedAt` (persisted field, backward compatible)
  and the boot scan stops offering never-started dispatches as interrupted runs.

# Mutation Pilot — src/session-manager.ts

Base: `e617427` (dev), worktree `brl-subagent-wt-234` (branch wt-234). Scratch — **no commits**.
Baseline: `src/__tests__/session-manager.test.ts` = 83 passed.

Legend: KILLED = target suite fails; SURVIVED = all pass. For SURVIVED mutants the four
extra suites (`terminal-status-consistency`, `background-run-extraction`, `per-step-cwd`,
`background-fan-out`) were also run to distinguish "caught elsewhere" from "caught nowhere".

| n | mutation | expectation | verdict | failing tests | notes |
|---|---|---|---|---|---|
| S1 | `agent.status = isSubagentError(result) ? 'failed' : 'completed'` -> `'completed'` | KILLED | **SURVIVED** | — | L239 `setAgentResult`. Caught NOWHERE (4 extra suites: 65 passed). `setAgentResult` has zero direct test calls; grep finds only two incidental comments. Issue #179 D1 terminal-status classification is unasserted. |
| S2 | `stopAgent` terminal set -> only `'completed'` | KILLED | **SURVIVED** | — | L330. Caught NOWHERE (4 extra: 65 passed). Never stop a `failed`/`stopped` agent; no test calls `stopAgent` on an already-terminal agent. |
| S3 | `steerAgent` `if (agent.status !== 'running')` -> `if (false)` | KILLED | **SURVIVED** | — | L362. Caught NOWHERE. Every `steerAgent` test (L423, L480, L504) plants a `running` agent, so the non-running throw path is unexercised. |
| S4 | `agent.status = 'steered'` -> `'running'` | KILLED | **KILLED** | `persistAgent still writes valid records (regression guard)` | L369. |
| S5 | `persistAgent`: `assertSafeAgentId(agent.id)` -> `void agent.id` | KILLED? | **KILLED** | attack-chain traversal test (L482 `escapeTarget` exists) | L84. F24 traversal guard in `persistAgent` IS covered — the "no write outside storage dir" assertion kills it. |
| S6a | `getAgent`: try-block `assertSafeAgentId(id)` -> `void id` | KILLED? | **SURVIVED** | — | L173. Caught NOWHERE. The traversal test at L422 still passes because `loadAgent('../../etc/passwd')` finds no file and returns null anyway — the guard is redundant *for the tested inputs*, not absent. |
| S6b | `getTranscriptPath`: drop `assertSafeAgentId(id)` | KILLED? | **KILLED** | `agent id validation (F24) > getTranscriptPath throws for a traversal id`; `agent id validation (F24) > getTranscriptPath throws for an absolute path` | L385. Throw-on-invalid guard fully covered. |
| S7 | `const gitCwd = params.cwd ?? ctx.cwd` -> `ctx.cwd` | KILLED | **KILLED** | `W4 review fixes — C1 dirty tree, commit-on-teardown, M1 aborted diff, C2 lock > C2: two branch-mode spawns in DIFFERENT non-repo cwds do not serialize` (108ms) | L723. Under the default (no explicit `--testTimeout`) run this HANGS: the failure leaks a never-resolved entry into the module-global `gitBranchLocks`, so every later test in the file blocks on `await prev` (10 cascading 15s timeouts in the diagnostic re-run). Kills, but by lock poisoning + hang, not a clean assertion. |
| S8 | `releaseGitLock`: drop `if (get(lockKey) === entry)` identity check | UNKNOWN | **SURVIVED** | — | L741. Caught NOWHERE. See analysis below. |
| S9 | `updateAgentStatus`: terminal set -> only `'completed'` | KILLED? | **KILLED** | `spawnBackgroundSession .then abort discrimination (probe contract) > marks agent stopped (not completed) when prompt resolves with an aborted run`; `spawnBackgroundSession per-agent timeout (issue #28 W3) > aborts the session and marks stopped after the deadline`; `issue #31 ... > releases the ref on the aborted/stopped path`; `issue #31 ... > releases the ref on the stopped-in-catch path (rejecting prompt while already stopped)` | L205. 4 tests, all on `completedAt` being set for `stopped`. |
| S10 | `updateAgentStatus`: `else if (status === 'failed')` -> `else if (false)` | KILLED? | **SURVIVED** | — | L217. Caught NOWHERE. Across ALL test files, `updateAgentStatus` is only ever called with `'running'`, `'completed'`, `'stopped'` — never `'failed'`. The `subagent:failed` assertions at L1212-1219 come from the *spawn settle* path, a different emitter, so they cannot see this branch. |
| S11 | `defaultTerminalMessage` provider-error string reworded | KILLED? | **KILLED** | (see /tmp/sm-S11-out.txt; asserts `run.errorMessage` contains `stopReason "error"`) | L266. |
| S11 | `defaultTerminalMessage` provider-error string -> `'Run ended without completing'` | KILLED? | **KILLED** | `issue #179 — honest terminal status (D1/D2/D3) > D3: a 'did nothing' provider death is recorded with turns 0 and a synthesized reason` | L266. |
| S12 | `extractFinalOutput`: drop `.reverse()` | KILLED? | **KILLED** | `issue #179 — honest terminal status (D1/D2/D3) > D3: a 'did nothing' provider death is recorded with turns 0 and a synthesized reason` (returns first assistant `'planning turn'` instead of last) | L287. Last-non-empty-text fallback is covered. |
| S13 | `finalizeRunEntry`: `if (runFinalized) return` -> `if (false) return` | UNKNOWN | **SURVIVED** | — | L578. Caught NOWHERE. See analysis below. |
| S17 | `extractFinalOutput`: `if (text.trim()) return text` -> `return text` | KILLED? | **KILLED** | `issue #179 — honest terminal status (D1/D2/D3) > D3: a 'did nothing' provider death is recorded with turns 0 and a synthesized reason` | L296. With S12 the empty-text-skip is the second line of defence; this one kills it. |

## Summary

7 KILLED (S4, S5, S6b, S7, S9, S11, S12, S17 = 8) / 7 SURVIVED (S1, S2, S3, S6a, S8, S10, S13 = 7).
Exact: **8 KILLED / 7 SURVIVED** across the 15 listed mutants (the task calls these "16").

Predictions: KILLED predicted for S1,S2,S3,S4,S7,S9,S10,S11,S12,S17 (10). Of those, 5 held
(S4,S7,S9,S11,S12,S17 -> 6 actually held), and 4 were WRONG (S1,S2,S3,S10).
UNKNOWN predicted for S8, S13 — both SURVIVED.

### Survivor analysis

**S1 — `setAgentResult` terminal classification (L239).** Real gap, HIGH severity.
`setAgentResult` has zero direct test calls anywhere in the suite, and the surviving
`isSubagentError(result)` ternary is the whole of issue #179 D1: a mid-run provider death
resolves with `exitCode 0` and must be recorded `'failed'`, not `'completed'`. Mutating it
away mislabels every such run as success, and nothing notices. Note the file already
contains a *different*, well-tested assertion of the same policy (S12/S17 kill on the
D3 test) — the D1 site itself is simply never driven. A trivial test would kill it:
`setAgentResult(id, { exitCode: 0, stopReason: 'error' })` -> expect `status === 'failed'`.

**S2 — `stopAgent` terminal-state short-circuit (L330).** Real gap.
`stopAgent` is called only on live `running` agents (L524, L541, L599, L1462). Stopping an
already-`failed`/`stopped` agent currently returns early instead of re-aborting a dead
session and re-stamping. Low blast radius today, but the guard is the only thing making
`stopAgent` idempotent, and a future call site that passes a terminal id would silently
abort-again.

**S3 — `steerAgent` non-running guard (L362).** Real gap.
This is the only thing rejecting a steer of a finished agent — the user-visible error
`Cannot steer agent <id>: status is X, not running`. All three `steerAgent` tests (L423,
L480, L504) plant `status: "running"`, so the throw is never exercised. Steering a
completed agent would instead append a bogus "Steering:" line to a finished transcript and
emit a `subagent:steered` event. Killable with one line: plant a `completed` record and
`expect(() => steerAgent(id, "x")).toThrow()`.

**S6a — `getAgent` traversal guard (L173).** Real gap, HIGH severity (security).
Verified by probe: `loadAgent` (L110-118) does `join(STORAGE_DIR, \`${id}.json\`)` with
**no validation**, so removing the guard lets an LLM-supplied id like `../planted-escape`
read and JSON.parse any `.json` file one level above the storage dir. The shipped test
(L422) uses `../../etc/passwd`, which does not exist, so `existsSync` returns false and
`loadAgent` returns null either way — the assertion passes for the wrong reason. I wrote a
probe that plants a real parseable record above the storage dir: it passes on correct code
and FAILS under the mutant (`getAgent('../planted-escape')` returns the leaked record
instead of null). So a ~6-line test kills it. Contrast S5/S6b, which are killed — the F24
guards are covered at the *write* and *path-construction* sites but not the *read* site.

**S8 — `releaseGitLock` identity check (L741).** Real gap, and a plausible test exists —
I verified one. The chain protocol is `prev = map[K] ?? resolved; entry = prev.then(gate);
map[K] = entry; await prev`, with the releaser deleting `map[K]` only if it still holds its
own `entry`. With N=2 the releaser is always the chain head, so the check is a no-op —
which is exactly why both shipped C2 tests (L981, L1035) miss it: they only ever queue
*one* successor. The break needs the releaser to have a *successor* at release time.
Probe result: queue A, B, C behind A, release A, then assert only B entered
(`createWorkBranch` called twice, not three times). Correct code passes; the mutant FAILS
with 3 calls — A's unconditional delete wipes C's entry, so **C walks straight in
alongside B**, the precise shared-working-tree race the lock comment describes. No late
arrival D is even needed; my first draft over-engineered it. This is a genuine
concurrency-coverage finding, not an equivalent mutant.

**S10 — `updateAgentStatus` failed-event branch (L217).** Real gap.
Across the entire test suite `updateAgentStatus` is only ever called with `'running'`,
`'completed'` and `'stopped'` — never `'failed'`. The `subagent:failed` assertions at
L1212-1219 come from the *spawn settle* path, a different emitter, so they cannot observe
this branch. Dropping it means a failed agent persists correctly but emits no event, so
notify/UI consumers never learn the run failed. One test — `updateAgentStatus(id,'failed')`
then assert a `subagent:failed` event with the error — kills it.

**S13 — `finalizeRunEntry` single-finalize guard (L578).** Real gap, and a plausible test
exists — I verified one. The existing catch-all test (L1407) throws inside the *aborted*
branch, which never reached its own stamped `finalizeRunEntry`, so the guard is a no-op
there; that is why it misses. The guard is only load-bearing when a settle handler throws
*after* stamping. Probe: on the completion path the stamped `finalizeRunEntry('done')`
(L1111) is followed by `completeTranscript` + `eventBus.emit`, so a throwing
`subagent:completed` emit drops into `markTerminalBestEffort`, which finalizes again.
Correct code appends 2 run entries (one `started` + one terminal); the mutant appends
**3** — a duplicate terminal run entry for the same agent, corrupting the run history a
`/history`-style reader consumes. Probe passes on correct code and fails on the mutant.

# #299 Option B (PR #325) — review records, rounds 1-8 (2026-10-10)

PR #325 (`fix/299-pgid-group-reap`, final head `abfe10d`), merged into `dev` 2026-10-10.
Each section is the conductor-written record of one verification round. Live probe banks were
`/tmp/review-299b-*.md` (ephemeral working artifacts).

| Round | Tip | Verdict | Headline |
|---|---|---|---|
| 1 | 62e2537 | changes-requested | 2 majors: marker = PID snapshot (foreign-group signal); grace window bypassed (11 ms vs 1000 ms) |
| 2 | 0fa2fc2 | changes-requested | 1 major: `pidGone` false-negative on the kill(0)→stat reaped transition |
| 3 | ae6d313 | changes-requested | 1 major: `groupHasMembers() === false` conflated empty with unknown inspection |
| 4 | 6c4d20f | changes-requested | 1 major: truncated stat record treated as empty |
| 5 | 2454700 | changes-requested | 1 major: shifted-fields record (missing state token) treated as empty |
| 6 | 1e6a17b | changes-requested | 2 majors + 1 minor: impossible pgrps, unvalidated field alignment, dead `x` counted live |
| 7 | 2325601 | approve-with-nits | `parseStatPrefix` contract closes the class; 1 test-DRY minor |
| 8 | abfe10d | approve | Fix B cleanup verified; no findings |


---

## Round 1 — initial adversarial review (C1)

# REVIEW — PR #325 (fix/299-pgid-group-reap) @ `62e2537`

Reviewer: `openrouter/~openai/gpt-luna-latest` (project-reviewer, high thinking), adversarial C1, 2026-10-10.
Review worktree: `brl-subagent-wt-299-review` (clean at `62e2537` throughout). Banked evidence: `/tmp/review-299b-findings.md`.

## Verdict: **changes-requested**

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| major | `src/kill-escalation.ts:134`; `src/proc.ts:135` | Marker verification is only a PID snapshot: if that process exits and its PID is reused before `kill(-pid)`, the stale group signal can hit an unrelated tree. Reproduced in an isolated PID namespace (forced PID reuse → SIGTERM reached a foreign marker-free group leader AND its member). Disproves "marker presence alone prevents foreign-group signaling". |
| major | `src/kill-escalation.ts:199` | The poll loop treats a dead group leader as a dead target, so the unconditional group SIGKILL bypasses D5's grace window. Real run: grace 1000 ms, returned in 11 ms, member SIGKILLed before its 400 ms SIGTERM cleanup finished. `groupTarget.verifyDeath` (`:141`) is leader-only liveness; `escalateKill`'s `targets.every(verifyDeath)` early-exit (`:199`) falls straight through to the unconditional group SIGKILL (`:224-226`). |
| minor | `src/__tests__/recovery.test.ts:1102` | T5 does not exercise `runSubagent`'s spawn fallback: forcing `detached: true` unconditionally still passes T5 (M4b) — the no-detached Windows branch is not test-proven at the spawn site. |
| minor | `src/proc.ts:97`; `src/runner.ts:164` | The POSIX `process.kill(-pgid, signal)` primitive is duplicated instead of shared. (SOLID/DRY count: 1) |

## Verified-OK

- Direct PID signals remain alongside group signals across all target paths; the direct-only scratch mutation failed the `#322 isolation` tripwire.
- M1–M4 each failed their intended tripwires on scratch copies; T1–T6 pass unmutated.
- D1 POSIX group-leader behavior verified; gates cover detached spawn, target selection, recovery wiring, final sweep; **D7 holds** (no record/registry/session changes).
- Full suite **67 files / 1378 passed**; recovery `-t '#299'` 11/39 ×3 (wider two-file selection: 16/44 ×3); typecheck exit 0.
- README test-count, docs-arch (39 modules), docs-decisions (16), `git diff --check` guards pass.
- Review worktree clean at `62e2537`; no leaked processes.

## Gate A note

Real commands, repeat runs, scratch mutations, and isolated-PID-namespace PID-reuse + grace-window probes. Lockfile/installed SDK versions matched; no installed-source or registry artifact applicable to this review.

## Fix direction (conductor's reading, for the user loop)

- **Major 1** — verify identity at SIGNAL time, not scan time: re-read the marker (or the child handle's liveness for tracked children) immediately before each signal and skip when it no longer matches. This narrows the window to the read→kill syscall boundary — the same exposure the pre-existing direct signals have carried since Option A — and makes the namespace probe's scenario safe (the reused foreign pid carries no marker → no signal). Residual documented, not silently assumed.
- **Major 2** — group-empty verification: `verifyDeath` for group targets = leader dead AND no live `pgrp == pgid` members (a `/proc` pgrp scan, leader-liveness fallback when `/proc` is unavailable). Early-exit then only when the group is truly empty; the unconditional final SIGKILL still fires for a TERM-stubborn member — but after the grace window, not 11 ms into it.
- **Minor 1** — extend T5 (or add a sibling) to prove the spawn `detached` gate's false branch.
- **Minor 2** — share one negative-pid group-kill primitive between `proc.ts` and `runner.ts`.


---

## Round 2 — Fix A verification (marker guard + grace + pidGone race)

# RE-REVIEW (Fix A round) — PR #325 @ `0fa2fc2`

Reviewer: `openrouter/~openai/gpt-luna-latest` (project-reviewer, high), focused adversarial verification pass, 2026-10-10.
Review worktree: `brl-subagent-wt-299-review2` (clean at `0fa2fc2` throughout). Banked evidence: `/tmp/review-299b-fixA-findings.md`.

## Verdict: **changes-requested**

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| major | `src/proc.ts:193-196` | `pidGone` false-negative on a two-read transition: `kill(pid,0)` samples alive, the process is reaped before `/proc/<pid>/stat` is read, `readStatFields` returns undefined → `pidGone=false`. The marker guard then classifies the gone leader as **live foreign** and skips BOTH the group SIGTERM and the unconditional final group SIGKILL — even while `groupHasMembers=true` — and `escalateKill` returns **no survivors**. Deterministic reproduction through the real `pidGone`/`groupTarget`/`escalateKill` path. Distinct from the documented read→kill reuse residual (this is a positive sample followed by disappearance). |
| minor | `src/kill-escalation.ts:161-166,217-223` | `pidTarget` and `groupTarget` duplicate the same direct-signal guard dispatch logic (DRY; new in Fix A). |

## Verified-OK

- **Mutations independently re-run:** A1 removal → `recovery.test.ts:1243` (foreign pid received `[foreignPid,'SIGTERM']`); A2 leader-only `verifyDeath` → `:1328` **3/3 deterministic** (cleanup-window tripwire; doneFile absent); A2b remove final group SIGKILL → T4 `:1149` (stubborn member survived 5 s wait).
- **Real-`/proc` carve-out probes:** zombie leader → `pidGone=true`, `pidHasMarker=false`, group signals dispatched as `[leader,SIGTERM]`+`[leader,SIGKILL]` (no direct signal), member dead, survivors empty. Stable reaped-not-reused leader → `pidAlive=false`, PGID pinned by live member, group TERM+KILL cleared the group.
- **Different-run marker isolation:** a live process carrying marker B is NOT signaled under marker A (all marker-A signals skipped, process alive).
- **Targeted gates:** `-t '#299'` **28/28 ×3** (7.6–7.8 s each); `#322 isolation` **1/1 ×3**; direct-signal retention covered independently.
- **Test integrity:** test diff **+331/−0**; no assertion weakened/deleted; bounded waits; unique `mkdtemp` dirs.
- **Coverage query:** 13 marker/recovery path references; runner collection feeds exit sweep + shutdown reap; `recoverRecord` + `runBootScan` resolve markers into `reapPids` guards; tracked `ChildProcess` targets are a separate identity class.
- **Gate A:** typecheck exit 0; full suite **67/67 files, 1390/1390 tests**; docs guards current (39 modules/16 decisions); `git diff --check` clean; real `ChildProcess` semantics verified (`exitCode/signalCode === null` pre-exit, non-null after); process audit clean; worktree clean at `0fa2fc2`.
- **Zombie members excluded from `groupHasMembers`** — argued correct (no userspace handler remains for grace/cleanup), though a zombie may pin the PGID until reaped.
- **Perf note:** group scan median **1.122 ms**, p95 ~1.955 ms at 73 `/proc` entries; one scan per checked group target per poll (100 ms default) — negligible single-target, potentially measurable event-loop delay at dozens/hundreds of stubborn targets (no stress fixture run).
- **Residual measured:** read→group-kill dispatch gap ~**45.577 µs** (not a bound; descheduling can extend).

## Fix directions (conductor's reading, for the user loop)

- **Major:** in `pidGone`, treat a positive liveness sample followed by `/proc/<pid>/stat` ENOENT as **gone** — `/proc/<pid>/stat` is readable for any live or zombie process of ours; ENOENT means reaped, and a reused pid is either live-foreign (readable stat/environ, no marker → the guard's foreign branch handles it) or not yet allocated (group may still be ours). Keep the non-`/proc` platform path as-is (distinguish "no /proc" from "stat ENOENT"). Additionally: when a signal is refused, the escalation outcome must not report a clean `survivors=[]` while a targeted group still has live members — surface refused/unsignaled targets in the report.
- **Minor:** fold the new duplicated guard dispatch into Fix B alongside the existing shared-primitive item.


---

## Round 3 — Fix A.1 verification (pidGone ENOENT + honest survivors)

# VERIFICATION (Fix A.1 round) — PR #325 @ `ae6d313`

Reviewer: `openrouter/~openai/gpt-luna-latest` (project-reviewer, high), focused adversarial verification, 2026-10-10.
Review worktree: `brl-subagent-wt-299-review3` (clean at `ae6d313` throughout). Banked evidence: `/tmp/review-299b-fixA1-findings.md` (12 probes, accumulated across two connection-drop continuations — the banking convention kept every probe).

## Verdict: **changes-requested**

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| major | `src/kill-escalation.ts:280` | `groupHasMembers() === false` conflates an empty group with failed/partial `/proc` inspection. Verified (Probe 10) with a real live same-PGID member: a refused group signal left the member alive while reporting `survivors=[]`. The A.1 honesty fix is honest only when membership is *known*; on unknown inspection it fails closed to a clean claim. (Same conflation also feeds `verifyDeath`, which can early-exit on an uninspected group.) |
| minor | `src/proc.ts:225` | On a `hidepid=2` mount, a foreign live pid can yield `kill -0` EPERM (read alive) followed by stat ENOENT (read gone) → classified gone → the guard permits a group-signal attempt despite marker mismatch. Platform-semantics risk verified from man pages/source reasoning; NOT reproducible on this host (no hidepid active). EPERM signalling constrains the blast radius for unprivileged runs. |

## Verified-OK

- Worktree clean at `ae6d313`; patch exactly 4 files (+231/−12); diff-check clean.
- **M-a** fails exactly at `recovery.test.ts:1339`; **M-b** at `recovery.test.ts:1398`; T1/T2 deterministic ×3.
- `-t '#299'` ×3 = 32 passed / 44 skipped; `#322 isolation` ×3 = 1 passed each.
- `pidGone` errno matrix: only ENOENT → gone; EACCES/EPERM/EIO/EINVAL/EMFILE/no-code fail closed. Source branch coverage enumerated.
- **No over-report:** no normal successful group-kill path sets the refusal flag; refused-against-empty-group is not reported as a survivor. Focused lifecycle run 5 tests passed.
- **Caller consequences clean:** survivor outcomes affect warnings/results only — NOT marking or revisit decisions; already-interrupted records stay revisitable; summary counts reflect proposed/attempted pids.
- Sibling-audit claims verified (single reads / skip-vanished); unchanged `classifyOwner` decision traced, no additional issue.
- Test diff: no weakened/deleted assertions; bounded waits; unique tmp dirs.
- Gate A: typecheck exit 0; docs guards current; full suite **67/1394 passed**. The `context canceled` progress lines are attributed by the existing investigation to TypeScript's Go `tsgo` subprocess shutdown noise — benign.
- **SOLID/DRY violations flagged: 0.**

## Fix directions (conductor's reading, for the user loop)

- **Major (Fix A.2):** make `groupHasMembers` three-state — `true` (members observed) / `false` (positively empty) / `undefined` (inspection unavailable or partial: `/proc` listing failure, unreadable member stats). Callers: `verifyDeath` requires *positively empty* (unknown ⇒ NOT dead — no early exit); `refusedForceKillGroup` requires *positively empty* to report clean — unknown ⇒ count the target as a survivor. Preserve the documented platform-level degradation (no `/proc` at all → leader-liveness fallback) and do not regress macOS/Windows behavior. Tests: inspection-failure fixture with a live member → no early exit + survivor reported. Mutations: revert to false-on-unknown → new test must fail (M-a/M-b must stay valid).
- **Minor (Fix B, documentation):** hidepid=2 as a documented boundary (unreproducible here; EPERM bounds unprivileged impact). Optionally a backlog issue if the maintainer wants a code guard — not required for this unit.


---

## Round 4 — Fix A.2 verification (tri-state membership)

# VERIFICATION (Fix A.2 round) — PR #325 @ `6c4d20f` (head `c03ee50`)

Reviewer: `openrouter/~openai/gpt-luna-latest` (project-reviewer, high), focused adversarial verification, 2026-10-10.
Review worktree: `brl-subagent-wt-299-review4` (clean at `c03ee50` throughout). Banked evidence: `/tmp/review-299b-fixA2-findings.md`.

## Verdict: **changes-requested**

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| major | `src/proc.ts:173-175` | A truncated stat record with a valid `)` but no pgrp token (e.g. `5500 (node) S 1`) is silently treated as **empty** instead of **partial**: `Number(fields[2])` is `NaN`, `NaN === pgid` is false, the entry is skipped as a non-member, and the scan returns `false` (positively empty). Reproduced in a scratch copy; `proc.test.ts:115` failed. |
| minor | `src/__tests__/proc.test.ts:25-43`; `src/__tests__/recovery.test.ts:77-93` | The transparent `node:fs` mock wrapper is duplicated across both test files (DRY). |

## Verified-OK

- **M-c** re-run independently: fails BOTH halves of T-new — `recovery.test.ts:1492` (1 ms vs ≥180 ms, no early exit) and `:1495` (empty survivors vs leader PID) — plus three `proc.test.ts` unit cases.
- **M-a** fails at `recovery.test.ts:1377`; **M-b** at `:1436` — as expected.
- Tri-state call sites and recovery/runner wiring audited; invalid-pgid and unavailable-`/proc` paths still return `false` (the deliberate leader-liveness fallback); the absent-reader refusal path reports a survivor; production `defaultRecoveryDeps` supplies the reader.
- Full suite **68 files / 1409 passed**; `proc.test.ts` 8/8; T-new 1/1; `-t '#299'` **47 passed ×3**; `#322 isolation` 2/2.
- Direct-signal retention and simulated Windows-gate tests pass; no persisted schema fields (D7).
- Gate A: typecheck, docs-arch (39), docs-decisions (16), README count guard (1400+ vs 1409), `git diff --check` — all green. Lockfile/SDK parity confirmed. Worktree clean at `c03ee50`; no leaked fixtures.
- **SOLID/DRY violations flagged: 1** (the duplicated fs-mock wrapper).

## Fix directions (conductor's reading, for the user loop)

- **Major (Fix A.3 — tiny):** in the group-membership scan, a record whose pgrp token is absent or non-numeric is a PARTIAL inspection ⇒ `undefined` (unknown), never "not a member"/empty. Concretely, after `read.ok`, validate the parsed record carries a numeric pgrp (`fields.length >= 3` and `Number.isInteger(Number(fields[2]))`); otherwise `return undefined`. Same-class audit: check the sibling consumers of `readStatFieldsDetailed` (`pidGone` state field, `readStartToken` field 19, `readProcessGroup`) for truncation/NaN conflation and report; fix only same-class membership-path instances. Companion test: the `5500 (node) S 1` record ⇒ `undefined`; mutation **M-d** (revert the guard → test must fail).
- **Minor (Fix B):** fold the duplicated fs-mock wrapper into the DRY set (spawn-gate test, shared group-kill primitive, duplicated guard dispatch, hidepid note).

## Convergence note

Round 1 was core identity/escalation logic (two majors); round 2 a race in the fix; round 3 the known/unknown reporting conflation; round 4 a single parsed-field edge inside the same scan helper. Every round narrower; A.3 is a ~3-line guard plus a unit case.


---

## Round 5 — Fix A.3 verification (truncated record)

# VERIFICATION (Fix A.3 round) — PR #325 @ `2454700`

Reviewer: `openrouter/~openai/gpt-luna-latest` (project-reviewer, high), focused adversarial verification, 2026-10-10.
Review worktree: `brl-subagent-wt-299-review5` (clean at `2454700` throughout). Banked evidence: `/tmp/review-299b-fixA3-findings.md` (428 lines, probes 0–12, completed before a connection drop; the continuation only classified the open matrix rows and emitted this verdict).

## Verdict: **changes-requested**

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| major | `src/proc.ts:184` | Shifted-fields records with an absent state token still return `false` (false-empty). Matrix cases: `5500 (node)  1 1 9999 0 0` and `5500 (node) 1 1 9999 0 0` — the state token is missing, whitespace splitting shifts the fields, and the A.3 guard accepts `"1"` as the state (only `undefined` is rejected) and `9999` as the numeric pgrp (it *is* an integer), so the scan compares 9999 ≠ pgid and reports a positively-empty group. Record malformation is not detected for this shape. |

## Verified-OK

- **M-d** (delete the A.3 guard): fails `proc.test.ts:123` (`expected false to be undefined`) + `recovery.test.ts:1548` (grace) + `:1551` (survivors `[]` vs `[pid]`). **M-c** (tri-state reversion): fails `:1492`/`:1495` + the truncated case `:1548`/`:1551`.
- **Matrix otherwise correct:** `no-pgrp`, `missing-state-short`, `empty-rest`, `nonnumeric-pgrp`, `close-paren-absent`, `zombie-missing-pgrp` → `undefined`; `extra-whitespace-valid` → `true`; `zombie-numeric-pgrp` → `false` (well-formed zombie, justified).
- **Sibling audit evidence:** truncated-empty `start=undefined pgrp=undefined gone=false`; nonnumeric-pgrp same; valid-token `start=123456 pgrp=4321 gone=false`; zombie-missing-pgrp `gone=true pgrp=undefined` — all conservative as claimed.
- Typecheck exit 0; full suite **68 files / 1413 passed**; `-t '#299'` **51 ×3**; `proc.test.ts` 11/11; recovery `-t #299` 19/19; `#322 isolation` 1; kill-escalation 26/26.
- Gate A: docs-arch (39), docs-decisions (16), README guard (1400+ vs 1413), `git diff --check` — clean; no stray processes or temp dirs; worktree clean.
- **SOLID/DRY violations flagged: 0.**

## Fix direction (conductor's reading, for the user loop)

- **Major (Fix A.4 — tiny):** the state token must be validated by SHAPE, not merely for non-undefined: accept only the kernel's process-state letters (`R S D Z T t X x K W P I`), else the record is malformed → `undefined` (partial). A numeric `"1"` shifted into the state slot then reads as malformed instead of a trusted field layout. Keep the numeric-pgrp requirement and the zombie skip. Tests: the two exact shifted records ⇒ `undefined`; a well-formed record with a numeric state-like field must not be trusted; mutation **M-e** (revert the state-shape check → new tests must fail). M-d/M-c stay valid.

## Convergence note

Parse-boundary findings sequence: A.2 unknown-vs-empty (whole-scan) → A.3 truncated record → A.4 shifted-fields state token. Each narrower; A.4 is a small shape validation on a single token.


---

## Round 6 — Fix A.4 verification (shifted fields)

# VERIFICATION (Fix A.4 round) — PR #325 @ `1e6a17b`

Reviewer: `openrouter/~openai/gpt-luna-latest` (project-reviewer, high), focused adversarial verification, 2026-10-10.
Review worktree: `brl-subagent-wt-299-review6` (clean at `1e6a17b` throughout). Banked evidence: `/tmp/review-299b-fixA4-findings.md` (accumulated across two connection-drop continuations).

## Verdict: **changes-requested**

## Findings

| Severity | File:line | Finding |
|---|---|---|
| major | `src/proc.ts:197` | Integer-only validation accepts IMPOSSIBLE pgrps: scratch cases with `-1` and an oversized integer returned `false`, reporting a malformed-only scan as empty. |
| major | `src/proc.ts:195-200` | A valid state token does not validate subsequent FIELD ALIGNMENT: malformed `R S 1 9999` passes the state check (state `R`), reads `1` as the pgrp, and returns `false` (the non-numeric ppid slot `S` is never examined). |
| minor | `src/proc.ts:199` | Historical dead state `x` is whitelisted but not skipped: a scratch record with `x` and the target pgrp returned `true`, counting a dead process as a live member. |

## Verified-OK

- **M-e** tripped all three shifted-record units + both `T-new-shifted` soft assertions; **M-d** tripped the truncated + malformed-zombie units + both `T-new-truncated` assertions; **M-c** tripped the listing-failure unit + both `T-new` assertions.
- State set matches the installed `proc_pid_stat(5)` documentation; unrecognized states fail closed to `undefined`; historical `W`/`P` are harmless allowlist entries.
- `it.each` cases non-tautological; `T-new-shifted` exercises a real baseline member, both soft assertions, bounded waits, unique temp dirs, cleanup.
- Full suite **68 files / 1420 passed**; `-t '#299'` **58 ×3**; proc 17; recovery `#299` 20; `#322` 2; kill-escalation 26; direct-signal 3; Windows/direct-only gate 1.
- Typecheck, docs guards, README guard (1400+ vs 1420), `git diff --check` — clean; worktree clean; no source files modified.
- **SOLID/DRY violations flagged: 0.**
- Note (not a finding): the reviewer could not map a "D7-labeled" check on this delta — D7 (no persisted fields) is satisfied vacuously here; the persisted-schema audit was done in earlier rounds.

## Strategic note (conductor)

This is the third consecutive round whose finding lives inside the same `stat`-prefix parser (A.2 whole-scan → A.3 truncated → A.4 shifted → now impossible-values/alignment/dead-`x`). The piecemeal-validation approach is whack-a-mole: each round validates one more slot. A single strict PREFIX validation closes the class:
- state ∈ `{R S D Z T t X x K W P I}` (validate by shape),
- `fields[1]` (ppid) must be an integer — this is the alignment check the `R S 1 9999` case exploits,
- `fields[2]` (pgrp) must be an integer in `[0, PID_MAX_LIMIT]` (reject `-1`/oversized; 0 is legal — kernel threads carry it),
- skip `x`/`X`/`Z` as dead.
Any record passing all four is a well-formed prefix whose values we actually use; no further shape can produce a false-empty, because everything beyond the prefix is unused.


---

## Round 7 — Fix A.5 verification (the parseStatPrefix contract)

# VERIFICATION (Fix A.5 round) — PR #325 @ `2325601`

Reviewer: `openrouter/~openai/gpt-luna-latest` (project-reviewer, high), focused adversarial verification, 2026-10-10.
Review worktree: `brl-subagent-wt-299-review7` (clean at `2325601` throughout). Banked evidence: `/tmp/review-299b-fixA5-findings.md`.

## Verdict: **approve-with-nits**

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| minor | `src/__tests__/recovery.test.ts:1620` | `T-new-aligned` repeats the detached leader/member setup and reap assertions from the truncated/shifted integration tests; extracting their shared fixture would reduce test duplication. |

## Verified-OK

- **All six mutations tripped on scratch copies:** M-f (ppid alignment), M-g (pgrp bounds), M-h (dead-`x` skip), M-e (state shape), M-d (integer-pgrp guard), M-c (false-on-unknown) — each failed its expected tests; review worktree stayed at `2325601`, clean.
- **Input-space matrix clean:** decimal spellings, boundary values, missing fields, comm spaces/parens, suffix fields, all accepted states. Invalid prefix tokens taint the scan to `undefined`; `T`/`t` (stopped) and other live states match members correctly; ONLY `Z`/`X`/`x` are skipped. Leading-zero decimals and repeated whitespace behave per the stated token/splitting contract. **No malformed input produces a false-empty or false-live result.**
- `groupHasMembers` has no direct `fields[2]` read — `parseStatPrefix` is the single prefix consumer; the 7 unit cases + `T-new-aligned` are non-tautological with both soft assertions, bounded waits, unique temp dirs, `/proc` gating.
- `readProcessGroup`'s pgrp-0 distinction has NO in-repo production call sites — not a consumer inconsistency in this change.
- Direct-signal retention, persisted-field (D7), and out-of-scope files unchanged. No fixture processes left; no repo files modified.
- **Gate A:** typecheck; full suite **68 files / 1428 passed**; `-t '#299'` **66 ×3**; targeted proc+recovery `#299` **45 ×3**; proc **24**; recovery `#299` **21**; `#322` **2**; kill-escalation **26**; docs guards; README guard (1400+ vs 1428); `git diff --check` clean; lockfile parity.
- **SOLID/DRY violations flagged: 1** (the test fixture duplication above).

## Parse-class closure

Seven rounds, each a strictly narrower shape, ended in approval:
round 1 core identity/escalation majors → A (marker guard + grace) → round 2 pidGone race → A.1 → round 3 unknown-vs-empty → A.2 → round 4 truncated record → A.3 → round 5 shifted fields → A.4 → round 6 impossible pgrp / alignment / dead-`x` → **A.5 (the `parseStatPrefix` contract)** → round 7 **approve-with-nits**. The contract — `false` only from a complete scan of well-formed prefixes — holds under the full input-space matrix.

## Fix B list (conductor — all remaining minors, for the maintainer's scoping)

1. Spawn-gate false-branch test (round-1 minor: prove no-`detached` at the `runSubagent` spawn site under injected platform).
2. Shared group-kill primitive (`src/proc.ts` ~:97 / `src/runner.ts` ~:164 duplication).
3. Duplicated `pidTarget`/`groupTarget` guard dispatch (`src/kill-escalation.ts`).
4. Duplicated `node:fs` transparent mock (`proc.test.ts` / `recovery.test.ts`).
5. Shared detached leader/member fixture for the integration tests (covers the triplication + this round's `T-new-aligned` nit).
6. hidepid=2 documented boundary (code comment / PR note; unreproducible here).
7. Optional: `readProcessGroup` could reuse `parseStatPrefix` (semantic difference: it rejects pgrp 0) — no production call sites; a note/nit at most.


---

## Round 8 — Fix B verification (cleanup round)

# SCOPED FOCUSED VERIFICATION (Fix B round) — PR #325 @ `abfe10d`

Reviewer: `openrouter/~openai/gpt-luna-latest` (project-reviewer, medium), scoped focused verification, 2026-10-10.
Review worktree: `brl-subagent-wt-299-review8` (clean at `abfe10d` throughout). Banked evidence: `/tmp/review-299b-fixB-findings.md`.

## Verdict: **approve** — findings: none. SOLID/DRY violations flagged: 0.

## Verified-OK

- **Shared kill primitive:** ESRCH-swallow / other-error-rethrow retained; runner call sites still dispatch through `groupTarget`'s best-effort wrapper; no new dependency cycle.
- **`dispatchIfOwned`:** preserves the original guard predicate, skip recording, and return-before-signal order; group-before-direct ordering intact.
- **`#299 T1-false`:** forces the capability seam off at the REAL spawn site and verifies the child shares its parent's process group; seam reset + child cleanup present. T1 now captures the pid from the same marker scan that satisfies readiness (race closed).
- **`withMembershipCase`:** all **eight soft assertions retained (two per case)**; case names and log tags preserved; fault teardown/reset hooks present.
- **Shared fs mock:** delegates when controls are unset; both suites' injected controls exercised (no cross-file leakage).
- **hidepid=2 note:** documentation-only. Skipping `readProcessGroup` reuse judged sound (no production callers; its parser is intentionally stricter).
- **Mutations re-verified independently (M-c…M-h):** each failed the relevant test(s) — M-c/T-new, M-d/T-new-truncated, M-e/T-new-shifted, M-f/T-new-aligned, M-g/T1-false, M-h/guarded kill-escalation; disabling `reapActiveChildren` made T1 fail by timeout. **No refactor disarmed a tripwire.**
- **Gate A:** `tsc --noEmit`; full suite **68 files / 1429 tests**; `-t '#299'` **67 ×3**; targeted proc/recovery/kill-escalation **111**; README count guard; docs architecture/decisions guards; `git diff --check`; post-test process audit clean; worktree clean.
- No persisted-field changes in the delta; direct-signal behavior and Windows-gate fallback exercised by the suite.


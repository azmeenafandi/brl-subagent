# U1 PR #301 scoped re-verification (review of the fix branch)
# worktree: brl-subagent-wt-u1-review @ b153a4c (detached, clean)
# started 2026-10-09
[banked] env: detached clean b153a4c; Fix A 82d6282 + six Fix B commits (015389b, ef7bbf3, bc750d4, e4b66cb, 617c86c, b153a4c); original findings @ dev c1e459b read
[banked] Gate A: `npx tsc --noEmit` exit 0 (clean). Full suite: 64 test files, 1321 passed / 0 failed (vitest JSON: testResults=64, numTotalTests=1321). Matches expected 64/1321.

## Independent probe run (zz-u1verify-probe.test.ts, 14 tests) — ALL PASS
[banked] P1 CRITICAL (fresh boot, ZERO session entries, registry-only): foreground dead owner + live marker child → summary.marked=1, child SIGTERM'd dead, registry entry gains interruptedAt. background → agent record + registry entry both gain interruptedAt. PASS.
[banked] P2 MAJOR (full store parse): 40 unrelated 200KB agent files; spy listPersistedAgents NOT called; readAgentRecord invoked exactly 1×; scan unaffected. Plus static grep: recovery.ts/recovery-engine.ts/proc.ts contain no `listPersistedAgents`. PASS.
[banked] P3 MAJOR (N×grace): N=4 orphans, graceMs=120 → sleep called exactly ONCE with 120; real elapsed=120ms. PASS.
[banked] P4 B1 preference: resolveTerminalRunEntry([spawn,marked])=marked; dedupeRunEntriesById=[marked]; SessionState.findTerminalRunById(ctx,'r')=marked (CUSTOM_ENTRY_TYPES.run). PASS.
[banked] P5 B2 revisit: marked record + real live marker child → reaped, marks=0, summary.revisited=1/reaped=1. Survivor (never dies) → survive then SIGTERM+SIGKILL, decision stays `reap` next boot (entry retained). PASS.
[banked] P6 B3 owner policy: verified-dead owner + marker → mark/reap child-orphaned (NO regression); owner {}/{pid:"x"}/{pid:0}/{pid:-5}/{NaN}/{1.5} + marker → owner-unverifiable mark-only, kill never called; missing owner → skip no-owner. PASS.
[banked] P7 B4 early exit: real child reaped elapsed=100ms (old 5311ms); survivor graceMs=150 elapsed=151ms then SIGKILL. PASS.
[banked] P8 B5 shared marker: 2 children same marker tracked independently; killing 1 leaves count=1; reap reaps the remaining 1; both dead. PASS.
[banked] P10 B8 /proc guard: __setProcAvailableForTest(false) → recoverProduction summary all-zero, mark never called, kill never called, registry entry unmarked. PASS.
[banked] MUTATION tautology check: mutated listInflightRuns()→return [] ; in-repo P2b acceptance test "reaps a dead conductor's foreground orphan and marks the registry entry" FAILED (1 failed). Restored; git diff clean. NOT a tautology.
[banked] B6: types.ts BackgroundAgent comment now says childMarker declared for round-trip tolerance / no bg path sets it — matches declaration (verified by read).
[banked] B7: escalateKill is the one helper; 4 sites (runner reapActiveChildren:127, abort:339, timeout:994, recovery-engine reapPids:223).
[banked] B8/docs: docs:arch "module map is current (39 modules)" exit 0; architecture-rules + architecture-doc suites pass (11 tests) incl. no runtime import cycles.
[banked] check-readme-test-count: README says 1300+, suite ran 1321 — OK.

## #11 hygiene / regression
[banked] tsc clean; suite 64 files/1321 pass; readme-count OK; docs:arch current (39 modules); architecture-rules+doc pass.
[banked] Fix A run-registry.test.ts still pins P2b acceptance (fails under listInflightRuns mutation).
[banked] REAL-STORE LEAK CHECK: full suite left NO `.pi/run-registry` and NO `.pi/subagents` in the worktree root (ls .pi → only extensions/output/skills; run-registry absent, subagents absent); git status clean. unit-run.test.ts fake-pi path only reaches persistRun with a TERMINAL run → persistRunRecord calls clearInflightRun (unlink, ENOENT caught) and never writeAtomic/ensureDir, so no real store is created. No unredirected writer found among tests referencing registerInflightRun/persistRunRecord/persistAgent/markAgentInterrupted (all such test files use createTempEnv).

## NEW FINDINGS (blast radius only)
[new/minor] src/session-manager.ts:144-146 — `listPersistedAgents` doc comment still says "Used by boot recovery to find records stuck `running`", but boot recovery no longer calls it (production scan is registry + getAgent-by-id; only recovery.test.ts uses listPersistedAgents). Stale doc comment from finding #2's fix; cosmetic.
[new/observation] decideRecovery checks `interruptedAt` BEFORE owner liveness, so the B2 revisit reaps a marker-matching child of a marked record even if the recorded owner is alive. This is the intended B2 semantics and matches the requested probe; only reachable if some prior process marked the entry (owner judged dead). Noted as a narrow cross-process residual, not a blocker.
[out-of-scope noted] #303 preserved: runner.ts:339 (abort) and :994 (timeout) still pass `() => Boolean(proc.killed)` as verifyDeath, so a SIGTERM-ignoring child is not force-killed on those paths. Documented in kill-escalation.ts header. Neither fixed nor a Fix B failure.

## VERDICT
approved — all 10 FINAL severity-table findings fixed (with independent evidence); SOLID/DRY items fixed; no regressions; one new cosmetic doc-drift minor.

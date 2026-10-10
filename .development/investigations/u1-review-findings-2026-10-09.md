# U1 PR #301 adversarial review findings
# run started 2026-10-09T13:12:03Z
# worktree: brl-subagent-wt-u1-review @ c1e459b (detached, clean)


## env check
- worktree clean, detached at c1e459b; commits ea45941..c1e459b (5) as chartered; base dev (merge-base e805a13 is plan-merge)
- node v24.14.1
- spec docs present: PROPOSAL_PLAN-OPTION_B_DURABILITY.md (merged dev), option-b-probes-2026-10-09.md (P1/P2) — confirmed, details below
- Gate A running (tsc + suite) — results banked when done
[banked] env: detached clean c1e459b; 5 commits ea45941..c1e459b; base dev merge e805a13; spec docs present
[minor] types.ts:737-744: BackgroundAgent comment says "no childMarker" but childMarker field declared — doc drift
[banked] types.ts:737-744 minor doc drift: BackgroundAgent comment claims no childMarker but field declared

## attempt 2 (Gate A + source review) — started
[banked] Gate A: `npx tsc --noEmit` exit 0 (clean). `npx vitest run` → Test Files 62 passed (62); Tests 1290 passed (1290) — matches expected 62/1290.
[banked] coverage: NO test outside src/__tests__/recovery.test.ts mentions dispatchId/resumeOf/attempt; recovery.test.ts asserts only the pure newDispatchIdentity helper + isSubagentRunShape tolerance. End-to-end retry propagation (run record actually persisted with inherited dispatchId/resumeOf/attempt) is untested.
[banked] MUTATION (a) invert owner-alive→mark (`decideRecovery` line 188): EXPECT pure "owner-alive" FAIL + "two conductors live owner untouched" FAIL. OBSERVED exactly those 2 failed (23 passed). Restored, green.
[banked] MUTATION (b) reap=[] (drop findByMarker): EXPECT marker-found-reap FAIL, recoverRecord SIGTERM→SIGKILL FAIL, real /proc orphan reap FAIL. OBSERVED exactly those 3 failed (22 passed). Restored, green.
[banked] MUTATION (c) remove already-interrupted skip: EXPECT idempotent-skip pure FAIL + boot-scan-twice FAIL. OBSERVED exactly those 2 failed (23 passed). Restored, green.
[banked] MUTATION (d) classifyOwner returns alive on pidAlive (drop start-token check): EXPECT 2 ownership-unverifiable FAIL + foreign-process guard FAIL. OBSERVED exactly those 3 failed (22 passed). Restored, green.
[banked] MUTATION matrix: all four required mutations are caught by the scoped suite; no uncaught mutation → no finding here.
[banked] COVERAGE GAP (minor): retry identity end-to-end is untested in-repo. Empirically VERIFIED WORKING via /tmp probe clone of retry-pins harness (probe-retry-identity.test.ts, 9 passed): foreground retry persisted run inherits dispatchId="D-ORIG", resumeOf="<orig id>", attempt=2, fresh owner+childMarker; background retry spawn receives same; fresh dispatch attempt=1/no resumeOf. Sites: src/index.ts:2929 (retrySourceRun=runEntry), :3199 & :2632 (newDispatchIdentity), :3211-3216 (run fields). Missing assertions in src/__tests__/retry-pins.test.ts.

## attempt 3 (continuation: focus 1,4,5,6,7,9) — started
# worktree reconfirmed detached c1e459b
[banked] focus7 doc drift CONFIRMED: types.ts:737-738 comment "Background records carry dispatchId/owner/attempt (no childMarker — there is no child process; the session is in-process)" but line 744 declares `childMarker?: string;`. Drift is real (comment vs declaration).

## focus 1: matrix edge cases (empirical, /tmp/u1-probe/edge.probe.test.ts)
[banked] EDGE multi-pid marker: 2 live children sharing marker → scan reaped:2, SIGTERM×2, both dead. SOUND.
[banked] EDGE owner-alive + live marker child: runBootScan skipped:1, marked:0, kill calls 0, child alive. SOUND (spec requirement met).
[banked] EDGE pid-reuse (owner start token mismatch) + live marker child: classifyOwner=dead → marked:1, reaped:1, marker child SIGTERM'd. SOUND.
[banked] EDGE malformed owner: `{pid:"not-a-pid"}` and pid∈{0,-5,NaN,1.5} → all marked:1, no kill. no-owner (`owner` absent) → skipped no-owner. INCONSISTENCY (minor): `owner:{}`/garbage pid is acted on (marked) while a MISSING owner is left untouched; a corrupt owner object is "unverifiable ownership" by the stated policy yet is marked. Kill path still never touches it (mark-only).
[minor/major] EDGE pre-marked record with a STILL-ALIVE marker child: runBootScan skipped already-interrupted → child NOT reaped (alive after scan). `recoverRecord` also marks the record even when `survived` is non-empty, and `survived` is only logged. Consequence: a SIGKILL survivor (or a child whose marker was unreadable at mark time) is orphaned forever — no later boot re-checks a marked record. Narrow window but it defeats U1's child-reap goal in exactly the crash it targets.

## focus 4: dedupe/resolution/persist semantics (empirical, /tmp/u1-probe/semantics.probe.test.ts)
[banked] terminal-first resolution: [spawn, done, failed] → BOTH dedupeRunEntriesById and resolveTerminalRunEntry pick the FIRST terminal (done). Consistent.
[banked] persist round-trip: mark append `{...run, interruptedAt}` preserves dispatchId/attempt/owner/childMarker; isSubagentRunShape accepts the new fields; JSON round-trip (agent store) preserves them. SOUND.
[banked] DRY/CONTRACT (minor): state.ts:71-73 declares resolveTerminalRunEntry "the ONE implementation of the preference rule", but recovery.ts:130 dedupeRunEntriesById is a SECOND, divergent implementation. Empirically they DISAGREE on [spawn(running), marked(running+interruptedAt)]: resolveTerminalRunEntry → spawn (interruptedAt undefined); dedupe → marked clone. The documented "one rule" is false and U3's render/retry will read the unmarked spawn shape via the shared lookup.

## focus 5: platform boundary (empirical, /tmp/u1-probe/semantics.probe.test.ts, node:fs mocked so /proc reads fail)
[banked] /proc absent: isProcAvailable()=false; readStartToken→undefined; currentProcessOwner().start=""; findByMarker→[]; classifyOwner(live-owner)=unknown → skip. runBootScan over a dead-owner record: marked=1, reaped=0, kill calls=0 (no unverified kill path). SOUND at engine level.
[banked] NOTE: the engine would still MARK a definitively-dead owner without /proc; the production "nothing marked" guarantee lives solely in index.ts performBootRecovery's early `if (!isProcAvailable()) return;`. That guard has no test and no injectable seam (procAvailable is a private module-level cache) — coverage gap, not a defect.

## focus 6 — per-record grace + registry collision (empirical, /tmp/u1-probe/*)
[banked] BOOT STALL (major, perf): recoverRecord sleeps graceMs once PER reaped record, sequentially (probe: 3 records → 3 sleep calls). With SIGKILL_GRACE_MS=5000, a boot with N orphaned foreground runs blocks session_start (awaited in the handler) for N×5s. reapActiveChildren's single shared wait shows the intended shape.
[banked] SHUTDOWN STALL (minor): reapActiveChildren always awaits the full SIGKILL_GRACE_MS (5000ms) when any child is tracked — even if it exits instantly (probe retry test duration 5311ms = 300ms timeout + 5s fixed wait). session_shutdown awaits it → clean exits block ~5s whenever a foreground child was in flight.
[banked] REGISTRY-KEY COLLISION (minor, latent): keyed on caller marker; two concurrent children sharing a marker collapse to one Map entry. Probe: shared marker → activeChildCount=1 with 2 live children; first child's close deletes the shared key → activeChildCount=0, reapActiveChildren=[] while the 2nd child is still alive (leak). Not reachable today (all 5 index.ts call sites pass unique per-run childMarker) but the registry degrades silently if any caller reuses one.
[banked] TIMEOUT-RETRY REAP RACE: NOT a race. Probe: attempt1 (timeout 300ms) resolves via close, activeChildCount=0 BEFORE the retry; re-registering the SAME marker tracks the retry (count=1, reap=1). runSubagent resolves only on `close`, so the delete happens-before the retry's set. SOUND.

## focus 4b: BOOT-SCAN RECORD VISIBILITY — foreground crash not recoverable at default startup (EMPIRICAL)
[banked] pi startup default = `SessionManager.create` (new session) — main.js:351; `--continue`/-c → continueRecent (main.js:342), `--resume`/`--session` → open. Verified by SDK probe /tmp/u1-sdk/session-visibility.mjs:
  - dead session (create + appendMessage + appendCustomEntry("brl:run", running record)) persists to its own .jsonl
  - `SessionManager.create()` (DEFAULT boot) → 0 run entries visible
  - `SessionManager.continueRecent()` → 1 run entry visible
[banked] performBootRecovery candidates = state.getRunEntries(ctx) [session entries of the CURRENT session] + listPersistedAgents() [.pi/subagents/*.json].
  Foreground/chain/parallel/graph run records go ONLY to session custom entries (state.persistRun→appendEntry; index.ts:713/1168/1805/3218/3506/3633, unit-run.ts:178/222). Agent records (.pi/subagents) are written ONLY by session-manager background functions (persistAgent callsites all in session-manager.ts).
  ⇒ On the DEFAULT fresh startup after a conductor crash mid-FOREGROUND-run: getRunEntries=[] and listPersistedAgents has no record for that run → records=[] → NOTHING reaped, NOTHING marked; the orphaned `pi --mode json` child (with BRL_SUBAGENT_CHILD_MARKER) keeps running. Recovery only works if the user restarts with --continue/--resume/--session on the crashed session (or the crash was a BACKGROUND run, whose agent record IS in .pi/subagents/).
  This is the P2(b) acceptance scenario ("foreground conductor kill → child reaped, entry marked") and it fails on the default boot path.
[banked] COVERAGE: no test invokes performBootRecovery / markAgentInterrupted / listPersistedAgents / runBootScan-with-record-discovery. recovery.test.ts's "real /proc integration" fabricates the run record in memory and calls runBootScan directly, so the discoverability gap is invisible to the suite (green 62/1290 notwithstanding).

## focus 6b: shutdown ordering (verified against the SDK, empirical)
[banked] pi awaits session_shutdown handlers: agent-session-runtime.js:107 (teardownCurrent) and :298 (dispose, reason "quit") both `await emitSessionShutdownEvent`, which awaits extensionRunner.emit → each async handler. So `await reapActiveChildren(log)` before clearing live state is correctly ordered and does complete. SOUND.
[banked] session_start emits also include reason "reload" (agent-session.js:2966), and teardownCurrent covers /new,/resume,/fork — so performBootRecovery AND the 5s reapActiveChildren wait run on every session transition, not just boot.

## focus 6c/4c: performBootRecovery cost + test isolation (EMPIRICAL)
[banked] listPersistedAgents() readdirSync's + JSON.parse's EVERY .pi/subagents/*.json (loadAgent full parse incl. result.messages) on every session_start, unfiltered by status. Measured on the dev checkout store: 971 files / 116.0MB / 470ms warm just to JSON.parse (proxy script). performBootRecovery is awaited in session_start ⇒ that cost blocks every boot AND every /new,/resume,/fork,reload, and grows unbounded with the store. Only `status==="running"` records are used.
[banked] TEST ISOLATION (minor): e2e-subprocess.test.ts fires the real session_start with ctx.sessionManager.getEntries=[] and spawns the harness with cwd=PROJECT_ROOT (line 307) but does NOT use createTempEnv/__setStorageDir. From a checkout whose .pi/subagents exists (the dev checkout: 971 records/116MB) the boot scan parses the whole real store; once U1-era records (with owner) are present it would also REWRITE interruptedAt into the developer's records. Worktree runs are safe only because the worktree has no .pi/subagents.

## focus 7: docs
[banked] docs-arch check-mode: exit 0, "module map is current (35 modules)"; 35 table rows; recovery.ts Purpose first line == ARCHITECTURE.md:84 row. SOUND.
[banked] types.ts:737-738 drift CONFIRMED (comment "(no childMarker ...)" vs declared `childMarker?: string;` at :744; the field is never set by any background path). Existing minor.
[banked] No other prose doc claims recovery posture yet; plan §5 defers user-visible docs to the unit that changes each behavior (U3), U1 is explicitly UI-silent. No additional doc gap found beyond the drift.

## focus 9: SOLID/DRY
[banked] DRY+L (minor): dedupeRunEntriesById (recovery.ts:130) is a SECOND preference rule diverging from resolveTerminalRunEntry (state.ts:71-73, doc'd as "the ONE implementation"); they disagree on marked-vs-spawn (proven above). The "one rule" doc is now false; U3's shared-lookup consumers see the unmarked spawn shape.
[banked] DRY (minor): SIGTERM→grace→SIGKILL escalation implemented 4× — runner.ts:reapActiveChildren (wait-once, key-presence check), runner.ts timeout handler (:955), runner.ts abort handler (:305), recovery.ts:recoverRecord (wait-per-record) — with inconsistent wait semantics (N×5s vs 5s once).
[banked] S (minor/weak): recovery.ts (429 lines) carries candidate projection + pure engine + boot orchestration + /proc production wiring in one module.
[banked] L on injected seams: RecoveryDeps contracts are preserved by defaultRecoveryDeps (pidAlive handles non-integer/EPERM; startTokenOf undefined⇒unknown; kill throws caught; findByMarker [] when unavailable). No behavioral narrowing found.

## FINAL (attempt 3) — severity table
[verified] CRITICAL index.ts:3884-3899 + :3892/:3988 — foreground/chain/parallel/graph run records are session-only; default boot (SessionManager.create) sees 0 of them and .pi/subagents has no foreground record ⇒ boot scan finds no candidate: orphan child NOT reaped, entry NOT marked (P2b acceptance unmet at default startup).
[verified] MAJOR session-manager.ts:146-165 — listPersistedAgents() full-parses every .pi/subagents/*.json at every session_start (awaited); measured 971 files/116.0MB/470ms warm on the dev store; grows unbounded; only running records are used.
[verified] MAJOR recovery.ts:228 — grace sleep once PER reaped record, sequential ⇒ N orphans = N×5000ms boot block.
[verified] MINOR types.ts:737-738 vs :744 — "(no childMarker)" comment contradicts declared field.
[verified] MINOR recovery.ts:137 vs state.ts:71-103 — second, divergent preference rule (marked-vs-spawn disagrees).
[verified] MINOR recovery.ts:184 + :228 — a marked record is never revisited; a still-alive marker child / SIGKILL survivor leaks forever (survived logged only).
[verified] MINOR runner.ts:71-100 — reapActiveChildren always awaits the full 5000ms when any child is tracked (measured 5311ms for a 300ms-timeout run).
[verified] MINOR runner.ts:890/910 — registry keyed on caller marker; shared marker silently untracks a live child (proven) — latent (all 5 call sites pass unique markers).
[verified] MINOR recovery.ts:184-191 — `owner:{}`/garbage pid marked while missing owner skipped; unverifiable-ownership policy inconsistency (mark-only, never kills).
[verified] MINOR e2e-subprocess.test.ts:203-231 — fires real session_start with cwd=PROJECT_ROOT without redirecting STORAGE_DIR; scans the developer's real .pi/subagents store when present.
SOLID/DRY violations flagged: 3 (DRY+L preference-rule duplicate; DRY SIGTERM-escalation ×4 with inconsistent wait; S recovery.ts 4-responsibilities)

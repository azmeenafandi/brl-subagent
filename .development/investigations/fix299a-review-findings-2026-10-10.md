# PR #321 C1 review findings (#299 Option A — marker sweep)
# reviewer: openrouter/~openai/gpt-luna-latest — run bc96a1bc, 2026-10-10, 5m53s, $0.0438 (high thinking)
# worktree: brl-subagent-wt-299a-review @ 094786f (detached)

APPROVED

| Focus | Severity | Command / observed result |
|---|---|---|
| 1. Sweep correctness | Minor test-strength nit | Full suite: `#299-A reapActiveChildren pids BEFORE=[35780,35781] REAPED=[35780,35781] grandchildAliveAfter=false`. The sweep covers each tracked marker, dedupes against tracked PIDs and prior matches, and `findByMarker` excludes `process.pid`. `pidTarget.verifyDeath` uses `!pidAlive(pid)`. Run markers are UUIDs; auto-retry reuses its run’s marker sequentially, after the first run’s sweep completes. |
| 2. TOCTOU safety | Minor residual risk | Source inspection of `findByMarker` → `pidTarget` confirms the targets retain only PIDs. If a matched process exits and its PID is reused—also during the TERM grace period—`pidAlive` can see the replacement and escalation could signal it. This is the same PID-reuse class as the existing boot `reapPids`, not a new primitive, but adds shutdown and in-session call sites. |
| 3. Terminal sweeps | None | Full suite verified timeout and abort (`aliveAfterRun=false`). Scratch-only real-process probes also observed `success directResult=0 ... alive=false` and `external ... code=-1 category=crash alive=false`. The close handler preserves result stamping and resolves only after the exit sweep. |
| 4. `reapPids` early exit | None | Real suite: `elapsedMs=101 (grace=5000) survivors=[]`. Scratch-only non-dying-target check: `signals=["SIGTERM","SIGKILL"] elapsedMs=241 graceMs=240`; grace cap honored. |
| 5. Mutations / boundary | Pass | All three mutations failed as required: removing shutdown union failed the returned-PID assertion; neutering the exit sweep left marker PIDs; disabling polling measured `5007ms` against `<2500ms`. Boundary output: `grandchild=35804 aliveAfterShutdownReap=true markerVisible=false`. |
| 6. Gate A | Pass | `npx tsc --noEmit` clean; `npx vitest run` **67 files / 1365 tests passed** (1360 is stale); docs architecture current (39 modules); README count guard passed for 1300+. No test-file assertion deletions; `git diff --check` clean. |
| 7. Hygiene | Pass | Default-worker suite and scratch probes left no `sleep` processes (`pgrep -x sleep -a` empty). Cleanup/mutation runs stayed in `/tmp`; repository worktree remains clean. |

**Minor test nit:** `recovery.test.ts:845-852` awaits `runSubagent` before checking grandchild death, so its exit-time sweep could mask whether shutdown alone killed it. The mutation is still caught because the shutdown result must include the grandchild PID.

**Gate A note:** Environment checked first: Node v24.14.1, installed pi SDK 1.1.0 matches the lockfile, `/proc` is available, and no brl-subagent extension is installed that could be stale. Full-suite real-process output and the additional scratch probes are recorded in `/tmp/review321-findings.md`.

**SOLID/DRY violations flagged: 0.** No repository files modified.

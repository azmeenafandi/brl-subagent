# Investigation: does the marker-based reap cover grandchildren? (#299 pre-implementation probe)

- Worktree: `/home/azmeen/public_projects/brl-subagent_workspace/brl-subagent-wt-299-probe`
- Branch: `probe/299-grandchild-reap` @ `de2f973` (dev)
- Date: 2026-10-10
- Status: COMPLETE — probe only. **No `src/` changes.** Deliverable = this note + PR.
- Issue: #299 (LOW, trigger-based) — process-group reaping for orphaned subagent trees (D6 destination from #296).

---

## Question

#299's documented boundary says: *"killing the child does NOT clean its tree — the P2(a) probe found an orphaned grandchild (`sleep 200`) surviving its parent's death."* The U1 boundary moved: the spawned child carries `BRL_SUBAGENT_CHILD_MARKER=<uuid>` in its env, its own subprocesses inherit that env, `findByMarker` (`src/proc.ts:104`) scans `/proc/*/environ` and returns **all** matching pids, and the boot scan reaps **every** one (`src/recovery.ts` / `src/recovery-engine.ts:177+`, deps mediated). So #299's statement may only describe the **kill paths**, not the boot scan.

**Prove or disprove:** which grandchild scenarios does the current marker-based reap cover, and which survive?

---

## Method

Faithful tree **without a real pi child** (no model spend): a fake "child" process (node) carrying the per-run marker env that itself spawns a grandchild `bash -c 'sleep 300'`. Both kept alive. Then the production paths are driven through the real code:

- **Boot scan:** `recoverProduction` → `recoverInflightRuns` → `runBootScan` → `decideRecovery` → `findByMarker` → `reapPids` with `defaultRecoveryDeps()`; a registry entry is written with a **dead owner** and the record's `childMarker`.
- **Shutdown:** `runSubagent` (with `BRL_PI_BIN` pointed at a wrapper that spawns a grandchild) → `reapActiveChildren`.
- **In-session:** `runSubagent` with a timeout → the abort/timeout single-child escalation (`childTarget`).

The marker env is set directly on the fake child (`process.env` at spawn), and inherited by its grandchild — exactly the production inheritance chain. The non-inheriting case launches the grandchild via `env -u BRL_SUBAGENT_CHILD_MARKER …`, modelling an env-scrubbing / setsid-daemonized subtree.

Environment: node `v24.14.1`; raw `.ts` loaded via `jiti` (same loader the package ships); `isProcAvailable()` = true. Scratch: `/tmp/299-probe`.

### Reproduce

```bash
git worktree list   # brl-subagent-wt-299-probe @ probe/299-grandchild-reap (de2f973)
node /tmp/299-probe/boot-scan.mjs    # items 1a + 2 (boot scan)
node /tmp/299-probe/shutdown.mjs     # items 1b + 1c (shutdown + in-session)
pgrep -af 'sleep 300|fake-child|wrapper.cjs'   # expect clean after each run
```

Scratch scripts (not committed): `fake-child.cjs`, `fake-child-noninherit.cjs`, `wrapper.cjs`, `boot-scan.mjs`, `shutdown.mjs` under `/tmp/299-probe`. All use the `__setRegistryDir` test seam pointed at `/tmp/299-probe/registry` and restore it on exit.

---

## Item 1a — INHERITING grandchild, boot scan

Marker inherited → `findByMarker` returns **both** pids → the boot scan reaps **both**.

```
marker = probe299-77a6a5a8-ade7-4278-b8b1-71025c0a462f
childPid  = 23526   alive=true   comm=MainThread   startToken=369820
gchildPid = 23533   alive=true   comm=sleep        startToken=369826
findByMarker(marker) BEFORE = [23526, 23533]        <-- both
registry: kind=foreground, owner={pid:999999999, start:"1"} (DEAD), childMarker=marker
recoverProduction summary = { scanned:1, skipped:0, marked:1, markFailures:0,
                              reaped:2, revisited:0, ... }
AFTER: child   alive=false  comm=<gone>
       gchild  alive=false  comm=<gone>
```

**Verdict 1a: PROVEN** — marker inheritance makes the boot scan reap the whole inheriting tree. `findByMarker` returns every match and `reapPids` escalates them all together (one grace window). This **disproves** the blanket reading of #299's boundary for the boot path.

## Item 1b — SHUTDOWN path (`reapActiveChildren`)

`runSubagent` tracks only the direct `ChildProcess`. The wrapper's grandchild is never in `activeChildren`.

```
marker = shutdown-8c4f7e58-266c-418f-8ddf-d51c803d9c44
childPid  = 23605   alive=true   comm=MainThread   startToken=376086
gchildPid = 23612   alive=true   comm=sleep        startToken=376092
findByMarker(marker) = [23605, 23612]
reapActiveChildren() returned [23605]        <-- ONLY the tracked pid
activeChildCount() after = 0
AFTER: child   alive=false  comm=<gone>
       gchild  alive=true   comm=sleep   startToken=376092
```

**Verdict 1b: PROVEN** — `reapActiveChildren` (`src/runner.ts:148`) kills only the tracked direct pids. A marker-carrying grandchild **survives a clean `session_shutdown`** today.

## Item 1c — IN-SESSION timeout/abort path (child-only escalation)

`runSubagent` with `timeout=2000`. The timeout handler escalates `childTarget(proc)` = the direct child only (`src/runner.ts:1034`; the abort handler is the same shape at `src/runner.ts:376`).

```
marker = insession-43f229b2-f2f1-4bd5-899e-f7c0e4350d66
childPid  = 23613   alive=true   comm=MainThread   startToken=376150
gchildPid = 23620   alive=true   comm=sleep        startToken=376157
findByMarker(marker) = [23613, 23620]
run result: exitCode=-1, errorCategory="timeout"
activeChildCount() after = 0
AFTER: child   alive=false  comm=<gone>
       gchild  alive=true   comm=sleep   startToken=376157
```

**Verdict 1c: PROVEN** — no scan runs while a session lives. `recoverProduction` is wired **only** at extension startup (`src/index.ts:3944`); `reapActiveChildren` runs **only** at `session_shutdown` (`src/index.ts:4035`). A mid-session timeout/abort kills the direct child only, so an inheriting grandchild survives **until the next boot scan**.

## Item 2 — NON-INHERITING grandchild, boot scan

Grandchild launched with the marker stripped (`env -u BRL_SUBAGENT_CHILD_MARKER`).

```
marker = probe299-6c153faa-ab1a-43be-bcf9-95c4c303da0e
childPid  = 23538   alive=true   comm=MainThread   startToken=370370
gchildPid = 23545   alive=true   comm=sleep        startToken=370376
findByMarker(marker) BEFORE = [23538]        <-- ONLY the child
recoverProduction summary = { scanned:1, skipped:0, marked:1, reaped:1, ... }
AFTER: child   alive=false  comm=<gone>
       gchild  alive=true   comm=sleep   startToken=370376
```

**Verdict 2: PROVEN** — when the marker does not reach the grandchild, the boot scan cannot see it and it **survives**. This is exactly the gap a process-group (pgid) kill closes.

---

## Coverage map

| # | Path / scenario | Reap mechanism | Inheriting grandchild | Non-inheriting grandchild |
|---|-----------------|----------------|-----------------------|---------------------------|
| 1 | **Boot scan** (conductor restart) | `findByMarker` → `reapPids` (all marker matches) | **REAPED** (1a) | **SURVIVES** (2) |
| 2 | **Clean shutdown** (`session_shutdown`) | `reapActiveChildren` — tracked pids only | **SURVIVES** (1b) | **SURVIVES** |
| 3 | **In-session timeout/abort** | `childTarget` — direct child only | **SURVIVES** (1c) | **SURVIVES** |
| 4 | **In-session external child kill** (P2a) | none (extension finalizes the dead child) | **SURVIVES** | **SURVIVES** |

### Hypothesis verdict

- **Disproved:** "killing the child does NOT clean its tree" is **not** true of the **boot scan** — with a normal (inheriting) tree the marker scan reaps child **and** grandchildren. The premise held only because the P2(a) probe killed the child while the conductor was alive and observed the grandchild before any boot scan.
- **Proven for the kill paths:** shutdown (1b), in-session timeout/abort (1c), and external kill (P2a) all leave an inheriting grandchild alive.
- **Proven for non-inheriting trees:** even the boot scan leaves a grandchild that scrubbed/did not inherit the marker (2). This is the residual that **only** a pgid group-kill (or equivalent) closes.

**Bottom line:** the marker-based reap already covers the *common* (inheriting) grandchild at boot; the real gaps are (a) the kill paths leave inheriting grandchildren until the next boot, and (b) an env-scrubbing/setsid subtree survives even the boot scan.

---

## Recommendation

Two options, ordered by scope. Both are **not implemented** here.

### Option A — small fix: marker sweep on the kill paths (recommended first)

Extend the kill paths to reap by **marker**, not just by tracked pid. Because the real pi child stamps its own subprocesses with the same marker in the normal case, this closes the shutdown and in-session gaps for the common tree.

- **Shutdown seam:** `reapActiveChildren` (`src/runner.ts:148`). Today it builds targets from `activeChildren` entries' `proc`. Extend it to also union `findByMarker(entry.marker)` (add an import from `src/proc.ts`) into the pid set, dedupe against the tracked pids, and add **pid-based** escalation targets (same shape `recovery-engine.ts:reapPids` already uses: `terminate = deps.kill(pid,"SIGTERM")`, `forceKill = SIGKILL`, `verifyDeath = !pidAlive(pid)`). One grace window for the whole set.
- **In-session seam (optional):** run the same marker sweep in `runSubagent`'s `close`/timeout/abort handlers (`src/runner.ts` ~`1034` and ~`376`) **after** the direct child exits: `findByMarker(childMarker)` → reap leftovers. This is more precise than a periodic timer and needs no new scheduling surface. A periodic scan is the fallback only if the child cannot itself be relied on to reach a terminal handler.
- **Scope:** small — one helper + one call site (shutdown), optionally two more (timeout/abort). No record/format changes.
- **Risk:** low. Markers are per-run UUIDs, so a sweep cannot hit a foreign tree. Must reap only after the direct child is confirmed dead (the shutdown sweep already runs after `escalateKill`; the in-session sweep must run in the process-exit handler, not before). Does **not** close the non-inheriting case.
- **Touches:** `src/runner.ts` (`reapActiveChildren`, `runSubagent` handlers); reuses `findByMarker`/`pidAlive` from `src/proc.ts` and the `escalateKill` helper.

### Option B — pgid unit: process-group spawn + group-kill (the #299 destination)

Spawn each foreground/unit child in its own process group and signal the group on every kill path. Closes **all four rows**, including non-inheriting/setsid trees.

- **Spawn:** add `detached: true` (setsid) to the `spawn` at `src/runner.ts:953`. With setsid the child is the group leader, so `pgid == child pid`; persist `pgid` **additively** alongside `pid` so the assumption is explicit and future spawn changes are caught. Records: `ProcessOwner` (`src/types.ts:274`), `SubagentRun.childMarker`-adjacent field (`src/types.ts:~748`), `InflightRun` (`src/run-registry.ts:38`), and the agent record read/write in `src/session-manager.ts`. No new external surface.
- **Kill sites (group signal `process.kill(-pgid, sig)` instead of `process.kill(pid, sig)`):**
  - `src/runner.ts:childTarget` (`:131`) — used by abort (`:376`), timeout (`:1034`), and `reapActiveChildren` (`:148`).
  - `src/recovery-engine.ts:reapPids` (`:212`) via a new `RecoveryDeps` member (e.g. `killGroup(pgid, signal)`), defaulted in `src/proc.ts:defaultRecoveryDeps` (`:134`). `decideRecovery`/`findByMarker` are unchanged — the marker still identifies the tree; the pgid is only the kill mechanism.
- **Identity safety:** before signaling the group, verify the **leader** pid's start token matches the persisted owner (the existing `classifyOwner` policy already does this for the pid) so a reused pgid cannot be signaled.
- **Cross-platform:** Windows has no setsid/pgid; guard on `process.platform` and fall back to the current direct-kill path.
- **Signal-semantics note (#299):** `detached: true` removes the child from the terminal's process group, so terminal-generated signals no longer reach it. The extension's abort path direct-kills, so abort semantics are preserved; this changes only who else can signal the tree.
- **Scope:** medium — spawn option + a group-kill dep threaded through `recovery-engine`/`proc`, plus the additive `pgid` field on the registry/agent records and tests. Boot ordering (`reap → mark → offer/resume`) is unchanged.
- **Risk:** medium — group signaling and pgid reuse require the leader-identity check; the `detached` change must be covered by the abort/timeout tests; Windows fallback must be exercised.

### Which to ship

Ship **Option A** now: it is small, low-risk, touches one seam, and closes the shutdown/in-session leakage that a normal (inheriting) pi child produces — the realistic trigger. Keep **Option B** as #299's targeted hardening for the residual non-inheriting/setsid case (and for group-atomicity); it is the only option that closes row 1's non-inheriting column.

---

## Flags (out of scope — not fixed)

- `src/session-manager.ts:144-146` comment still says boot recovery uses `listPersistedAgents` — stale since the registry switch (already logged as a backlog nit; comment-only).
- Background sessions (`spawnBackgroundSession`) run **in-process** (`session.prompt`), so they spawn no subprocess and neither Option A nor Option B applies to them.
- The boot scan's `reapPids` waits the full `SIGKILL_GRACE_MS` window even when every target dies immediately (no `pollMs` on that path, unlike `reapActiveChildren`). Pre-existing; noted, not changed. (No `src/` changes were permitted.)

## Hygiene

- All spawned processes killed and verified: `pgrep -af 'sleep 300|fake-child|wrapper.cjs'` → clean after each run.
- Registry scratch `/tmp/299-probe/registry` removed by each script; `__setRegistryDir` restored to `.pi/run-registry` on exit.
- Worktree left clean apart from this note.

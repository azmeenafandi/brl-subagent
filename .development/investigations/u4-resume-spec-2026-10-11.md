# U4 (A₂) spec — resume for background runs (APPROVED 2026-10-11, parked behind the gate)

**Unit:** U4 of `.development/PROPOSAL_PLAN-OPTION_B_DURABILITY.md` · **Risk: C1** · **Jev:** `high (0.64) · C1 (1.0)`
**Status:** spec APPROVED (maintainer, 2026-10-11); **dispatch waits for the U2/U3 measurement gate** (or a maintainer waiver).
**Worktree (when it fires):** `../brl-subagent-wt-u4` · branch `feat/u4-resume` · base = current dev.

## Goal

A marked background run continues from its persisted session instead of restarting cold.

## Recon (Rule 13 — codegraph @ `c6c7653`)

- `retryRunId` resolution (`src/index.ts` ~2951): `findSpawnRunById` → fallback `resolveTerminalRunEntry(visibleRunsFor(ctx, getAgent), id)` → `retrySourceRun` → `resolveRetryParams(params, runEntry)`. Natural trigger point.
- Identity threading exists: `newDispatchIdentity(retrySourceRun)` → `resumeOf`/`attempt`; `startBackgroundAgent` params (~2299-2332) + `bgIdentity` (~2571, ~2671) carry them into the background spawn. **No new persisted fields, no delegate params.**
- `spawnBackgroundSession` (4 callers; `startBackgroundAgent` production): creates the session (U2) and strips `_sessionFile` from persistence.
- SDK: `SessionManager.open(path, sessionDir?, cwdOverride?)`, `createAgentSession({ sessionManager })`, `getHeader()`.
- U2 primitives: `backgroundSessionDir(id)`, `pruneBackgroundSession(id)`.
- `performBootRecovery` runs reap→mark at boot only; the resume needs its own reap-first pass.

## Design (approved)

- **D1 — Trigger, no new param (plan D4).** In the `retryRunId` branch, when `retrySourceRun` is interrupted + kind background and its session dir holds a session file: set an internal resume intent (source id, file, childMarker, cwd) threaded through `startBackgroundAgent` → `spawnBackgroundSession`. Otherwise: today's cold re-dispatch unchanged.
- **D2 — Session acquisition (COPY).** Copy the source session file into the NEW run's dir (preserves U2's dir-name = run-id invariant; the source is dead so the copy is quiescent), then `SessionManager.open(copiedFile)` + `createAgentSession({ sessionManager })`. On success: resolve the source (agent record → `stopped`, registry retired) and prune the source dir. On any failure: cold fallback, source stays interrupted/retryable.
- **D3 — Re-drive contract.** Task = source's original task + a pinned verify-state-first preamble: *"This is a RESUMED run; the session was interrupted mid-flight. FIRST verify the current state (files, artifacts, git status) and do not blindly repeat side effects — at-least-once applies; then continue the task."* Exact text pinned by test.
- **D4 — Guards (ordered; each falls back cold + warn).** **reap-first** (source `childMarker` survivors reaped before the open) → **worktree-exists** (registry `cwd`) → **schema check** (header `version` equals expected 3; unknown ⇒ refuse) → **notify-once** (normal single-settle notice; source never terminal-claimed, so no duplicate).
- **D5 — Records.** Resumed run = fresh record with `resumeOf = sourceId`, `attempt = source.attempt + 1` (existing `newDispatchIdentity`); source leaves the interrupted list; history collapse prefers terminal.
- **D6 — Measurement instrumentation.** Structured log per attempt: `resumed` vs `cold-fallback` + reason (feeds the measurement note's re-work assessment).
- **D7 — Offer text (small).** U3's retry menu hint for background interrupted rows says the retry resumes from its saved session when available.

**Boundaries:** no delegate param changes; no fan-out reassembly; **foreground not resumable** (cold retry only — the U3 caveat); single writer; at-least-once side effects documented in code + AGENT/README.

## Tests & mutations

T1 happy path (real SDK session opened; original task + pinned preamble; `resumeOf`/`attempt`) · T2 guard matrix (missing session / schema mismatch / missing worktree / reap-first ordering) · T3 notify-once · T4 ownership/retention (new dir; source dir pruned after copy; resumed settle prunes; no double-prune) · T5 pinned instruction · T6 foreground unaffected · T7 no regressions.
**Mutations:** M1 schema check off → T2-mismatch fails · M2 reap-first off → T2-orphan fails · M3 resume bypassed → T1 fails · M4 copy/ownership broken → T4 fails · M5 preamble removed → T5 fails · U3's M1–M5 stay valid.

## Acceptance / evidence

tsc; suite 73/1488 + new; targeted ×3; all mutations with exact sites; `git diff --check`; `pgrep` clean; stores untouched (sandboxed); measurement log observed.

## Out of scope

Fan-out reassembly · `auto` posture · foreground resume · session-format migration.

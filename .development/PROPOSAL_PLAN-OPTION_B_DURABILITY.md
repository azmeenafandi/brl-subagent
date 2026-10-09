# Option B — durability plan: process-death detection, recovery, and resume

- **Status: PLAN — for review (2026-10-09).** Six decisions locked (D1–D6 in the `.development/HANDOFF.md`
  decision log). No implementation dispatched.
- **Evidence base:** `.development/investigations/option-b-probes-2026-10-09.md` (P1–P4 + the torn-write
  addendum) and `.development/investigations/pi-durable-fit-2026-10-09.md` (the alternative that was
  considered and parked — Option A there, not this plan's Option B).
- **Format precedent:** `.development/PROPOSAL_PLAN-BACKGROUND_PARALLEL_SUBAGENTS.md`.

## 1. Why

Subagent runs are not durable against process death:
- **Background runs** (in-process sessions): the run entry and the `.pi/subagents/<id>.json` agent record
  survive a kill as `running`, but **nothing recovers them** — no session persistence, no boot scan (P1).
- **Foreground runs** (subprocess, `--no-session`): a killed child used to be recorded as a false `done`
  (fixed in #295); a killed **conductor** leaves the child **orphaned and still running**, with the run
  entry stuck `running` (P2).
- **Fan-out units**: same record shape, no batch linkage, no reassembly path (D5).
- The SDK *can* persist and reload sessions (`SessionManager.create/open`, verified SIGKILL-safe and
  self-healing in the torn-write addendum) — the extension simply does not use that capability today.

## 2. What this plan does NOT cover

- **`auto` recovery mode** — phased later with its guard block (D2).
- **Fan-out automatic reassembly** — deferred; needs a persisted batch plan record and resume engines per
  mode, plus two product decisions (shared-tree invalidation, result semantics). Linkage fields ship in v1
  so the deferral is a pure addition (D5).
- **Foreground true resume** — no persistable session under `--no-session`; foreground recovery is
  re-dispatch only (D5).
- **Process-group reaping (grandchildren)** — the targeted hardening destination, tracked as **#299** (D6).

## 3. Locked decisions (D1–D6)

| | Decision | Locked as |
|---|---|---|
| D1 | The recovery promise | Staged **A₁** (file-backed background sessions + retention, no resume logic; measure) → **A₂** (resume with guards). Torn-write risk resolved by the probe (torn tails load + self-heal; lost entry is the incomplete one) |
| D2 | The posture | Session-scoped config in `/brl-subagent`: `offer` (default) \| `auto` (opt-in, guarded later) \| `off`; **per-run posture snapshot** written at dispatch so `auto` survives a session boundary; one recovery path, two triggers |
| D3 | The interrupted state | Additive `interruptedAt` on **both** records; status stays `running`; centralized `isInterruptedRun`. No new status value (old readers would drop it; `state.ts` `!== "running"` rules would misread it as resolved) |
| D4 | The contract surface | `dispatchId` / `resumeOf` / `attempt` are **internal** record fields — no `delegate_task` params, no schema↔ratchet chain |
| D5 | v1 scope | Detection/marking for all three paths; background resume + re-dispatch · foreground re-dispatch only · fan-out mark + manual re-dispatch. **Linkage now, reassembly later** |
| D6 | Orphan reaping | pid + run-id marker persisted at spawn; verify identity before kill (`/proc` marker or cmdline+start-time); reap at shutdown and boot; ordering `reap → mark → offer/resume`. Grandchild hardening = #299 |

## 4. Work units

Each unit is its own worktree + PR, with its own implementation spec approved before dispatch.
Risk classes per the Team Agreement (C1 = state/lifecycle/persistence → adversarial review).

### U1 — Identity, liveness, and the detection engine (C1)

**Goal:** every run records enough identity to decide, in a fresh process, whether it is genuinely live —
and stray children from a dead process are reaped before anything else touches their worktree.

**Scope (symbolic):**
- `SubagentRun` (and the `.pi/subagents/<id>.json` agent record) gain additive fields: `dispatchId`
  (uuid, generated before spawn), `resumeOf?`, `attempt?`, `interruptedAt?`, plus liveness identity:
  **owner process identity** (conductor pid + start-time token — covers the two-conductors-in-one-cwd case)
  and, for foreground runs, the **child pid + run-id env marker** (the runner already passes
  `getSafeEnv` overrides, so the marker is one more variable).
- A boot scan (at `session_start`, after config restore) over the persisted records: for each `running`
  record — owner alive → leave; child alive + marker verified → leave; otherwise → **reap if needed, then
  mark `interruptedAt`** on both records.
- Shutdown reap: kill in-memory in-flight children on `session_shutdown` (covers clean exits).
- `isInterruptedRun(run)` predicate centralized in `src/types.ts` (sibling of #298's partial/settled work).
- **Assumption stated in code and docs:** one conductor per cwd is *not* required (owner identity covers
  it). A record with **no owner at all is left untouched** (`no-owner`) — **maintainer-confirmed 2026-10-09**:
  never mark a record whose ownership cannot be checked. Revisit once every writer emits `owner`
  (post-version-boundary), when `no-owner` can safely become interrupted.

**Acceptance:** the P1/P2 crash scenarios reproduced as tests (background kill → records running then
marked at boot; foreground conductor kill → child reaped, entry marked; child-kill → #295 classification
holds); a two-process fixture proving a live owner's records are untouched; mutation verification for the
liveness decision; `npx tsc --noEmit` + full suite green. **Closes #296** (its detection + child-reap
halves). Not in unit: resume, UI, persistence.

### U2 — A₁: file-backed background sessions + retention (C1)

**Goal:** background subagent sessions persist to disk (enabling A₂ and post-hoc inspection) with a
bounded, measured footprint.

**Scope:** `spawnBackgroundSession` switches `SessionManager.inMemory` → `SessionManager.create(cwd,
<explicit session dir>)`. Explicit dir **must** be passed (the SDK default is global
`~/.pi/agent/sessions/<cwd-key>/`). Retention: session files removed when their run is finalized or
abandoned; interrupted runs keep theirs until resolved. A measurement note records sizes/debris after a
week of use.

**Acceptance:** a background run's session file exists during the run and is pruned per policy; crash test
(kill mid-run) leaves a loadable session (per the addendum's findings); suite green; no behavior change to
runs themselves. Not in unit: resume, re-drive, any recovery action.

### U3 — Marking surface, offer action, posture config (C2)

**Goal:** interrupted runs are visible and recoverable by a human.

**Scope:** TUI / Run History render `Interrupted` (keyed on `isInterruptedRun`, never on a status value);
a boot notice lists interrupted runs (delivered with the existing wake-queue discipline — never mid-turn);
the offer action reuses the existing **`retryRunId`** surface with pre-filled params (foreground →
re-dispatch; fan-out units → individually retryable; background → re-dispatch now, resume once U4 lands);
`/brl-subagent` gains `recovery: "offer" | "off"` (default `offer`; `auto` not yet accepted) and the
per-run posture snapshot is written at dispatch (D2); an `abandon` action finalizes a marked run as
`stopped` (existing terminal value).

**Acceptance:** TUI tests pin the interrupted rendering; the retry path works end-to-end on a marked run;
config persists per session and restores at boot; the boot notice respects turn boundaries; docs updated
(AGENT.md / README paragraphs that currently say "background runs are not auto-retried"). Not in unit:
resume, auto mode, reassembly.

### U4 — A₂: resume for background runs (C1)

**Goal:** a marked background run can continue from its persisted session instead of restarting cold.

**Scope:** load via `SessionManager.open(sessionFile)` + `createAgentSession({ sessionManager })`;
re-drive with a **verify-state-first** instruction (side effects may repeat — at-least-once is the
documented contract); guards: reap-first (U1), worktree-exists, schema check (header `version` equals the
expected value — refuse unknown), notify-once (no duplicate completion wake). Value measurement
(re-work avoided) recorded.

**Gate:** U4 is **conditional on the U2/U3 measurement** — sizes/debris bounded, interruptions actually
observed, re-work meaningful. Otherwise it stays parked with this plan as its record.

## 5. Cross-cutting requirements

- **Evidence discipline** (Rules 19/20) in every unit's spec: expected signatures before probes, coverage
  lines on searches, mutation verification for the liveness/classification logic.
- **No delegate-param surface changes** — D4 keeps the schema↔`KNOWN_DELEGATE_KEYS`↔snapshot/resolve↔
  retry-pins chain untouched. Any unit that finds it needs a param must stop and re-open D4.
- **Boundaries stated** (D3's additive fields only; single process owns a session file — the SDK's
  append-only writes make concurrent appends valid-but-interleaved, a *semantic* hazard we keep out of
  scope by reaping before resuming).
- **Docs:** the recovery posture, interrupted rendering, and retry semantics are user-visible — AGENT.md
  and the README's background/retry paragraphs are updated in the unit that changes each behavior.

## 6. Sequencing

`U1 → U2 → U3 → (measurement gate) → U4`, with the release schedule orthogonal (CodeGraph dogfooding
continues side-by-side). Each unit: spec → user approval → dispatch → review per its risk class.

## 7. Open questions for the per-unit specs

- Retention details: prune sessions at finalization, or keep terminal ones briefly for inspection?
- The boot notice's exact delivery: a queue entry, a TUI line, or both? Quiet-boundary timing?
- `off` semantics: hides the notice entirely, or notices without an action?
- Abandon naming/semantics in the TUI; whether `stopped` is the right terminal value for abandoned runs.
- Owner-identity token: `/proc/<pid>/stat` start-time vs a UUID env var owned by the conductor process.

## 8. Evidence appendix

| Finding | Where |
|---|---|
| Background: record-before-spawn true; no boot recovery; `.pi/subagents/` is cross-session, session entries are not | P1, probes doc |
| Foreground: child-kill → false `done` (fixed #295); conductor-kill → orphan alive + entry stuck running; grandchild leak found | P2a/P2b, probes doc |
| SDK resume exists but is file-backed only; `inMemory` persists nothing; `--no-session` has nothing to resume | P3, probes doc |
| Double-notify risk across restarts; gating requirements enumerated | P4, probes doc |
| Torn tails load + self-heal (newline appended on read); append-only; no fsync (power-loss boundary); header `version: 3`; `sessionDir` honored, default is global; two writers stay valid (interleaved) | Torn-write addendum |
| Consumer sweep for status values (40 accesses; the two guard sites; no switch/destructuring) | D3 verification, conductor log |
| `gitMode: 'branch'` rejected for fan-out → shared tree; units have independent ids, no batch linkage | `src/index.ts` fan-out validation, `src/unit-run.ts` |

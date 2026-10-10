---
name: worktree
description: >
  Worktree lifecycle management for brl-subagent development. Use when creating
  a git worktree for a delegation task, preparing it for a subagent, cleaning up
  after a PR merge, checking the cockpit (dev) checkout's health, running the
  sprint-end ritual (recurrence escalation + trust metrics — a SPRINT boundary,
  NOT a worktree close), cutting a release, OR before implementing any change to
  src/ or presets/ (all code changes go through a worktree).
---

# Worktree Framework

The conductor (not the subagent) owns the worktree lifecycle. This skill is the
playbook; the scripts in this directory are the enforcement. Run the scripts —
never re-type their logic by hand. Full design:
`.development/WORKTREE_FRAMEWORK.md`; process rules 9-21 are in this skill.

## References

- [`references/rule-notes.md`](references/rule-notes.md) — Team Agreement rule narratives (incidents, war stories).
- [`references/release-ritual.md`](references/release-ritual.md) — the release ritual (steps 1-10).
- [`references/local-development.md`](references/local-development.md) — npm dogfooding + the dev toggle (`-ne -e`).
- [`references/review-dispatch.md`](references/review-dispatch.md) — the adversarial-review brief content + calibration.
- [`../pr/SKILL.md`](../pr/SKILL.md) — the PR-body contract (Summary / Evidence / Merge Danger / Fixes), size-thresholded.
- [`references/friction-log-ritual.md`](references/friction-log-ritual.md) — the friction log ritual.
- [`references/sprint-end-ritual.md`](references/sprint-end-ritual.md) — Rule 11 recurrence escalation + trust metrics.

## Team Agreement (invariants)

1. **The cockpit (`dev`) checkout's `node_modules` is the SHARED source of
   truth — pristine.** Worktrees symlink to it; never run `npm install`/`npm ci`
   in the cockpit during delegation work. If deps appear missing, run
   `check-repo.sh` and report — do not patch.
2. **Dependency management is repo-level only.** `worktree-prep.sh` is the only
   sanctioned provisioning path. **Dependency-bump worktrees (any task that
   will touch `package.json`/`package-lock.json`) ALWAYS pass `--force-isolated`.**
   After a bump merge into `dev`, refresh the shared tree with `npm ci` in the
   cockpit once no worktree is linked against the stale lockfile; worktrees
   prepped before the bump must be re-prepped with `worktree-prep.sh <path>
   --force-isolated`. The cleanup script warns when the shared tree is stale.
3. **Subagents consume, never provision.** A subagent hitting a missing dep or
   broken artifact mid-task REPORTS it and stops — never creates, reinstalls,
   or touches the cockpit checkout.
4. **Tracked docs/tools materialize; state does not.** Since #247,
   `.development/**` and the `.pi` TOOLS (`.pi/skills/**`, `.pi/extensions/**`)
   are TRACKED — they materialize in every worktree; specs MAY ask a subagent to
   read them. Still gitignored (and absent from worktrees): `.codegraph/`
   (the structural index — conductor-side only, ADR 0016), `.pi` session state
   (`output/`, `subagents/`, `subagent-logs/`, `subagent-tmp/`, `sessions/`),
   local config (`.pi/brl-subagent/`), `REVIEW_*.md`, `.tmp/`. **Subagents
   NEVER see gitignored files** — specs must
   never ask them to read or edit those; environment-dependent instructions get
   an escape clause: "if X is not available in your worktree, report and skip —
   do not seek it elsewhere."
5. **ALL code changes go through a branch + worktree — even small fixes.**
   Direct-to-main commits are never acceptable. If you are about to modify
   `src/` or `presets/` and you are NOT in a worktree, STOP — create one first.
6. **Release checkpoint for extension-code changes.** Since v2.3.5 the daily
   install is the **published npm package**, so merged extension code is NOT
   active until a **release**: bump → GitHub release → CI stages → maintainer approval
   on npm → `pi update --extensions`. After merging a change that alters the
   running extension, the conductor STOPS, states the release checkpoint, and
   waits; changes that never reach the running extension (docs, tests, tooling)
   are complete at merge. For live verification of unmerged work use the
   local-path dev toggle (`references/local-development.md`) + `/reload`; never
   load two copies. The reload or update is ALWAYS user-triggered — never
   automate it.
7. **Delegation threshold — the conductor is a project manager, not an
   implementer.** Implementation, probes/investigations, adversarial reviews,
   and code drafts go to subagents with a precise spec; the conductor holds
   sequencing, review of subagent output, rituals, and judgment calls. Tripwire
   before opening any file to implement or analyze: "could I write a spec for
   this?" — if yes, delegate it. Exceptions: tiny ritual/doc edits in repo
   docs/tools (this skill, `.development/`), and tasks where the conductor
   already holds irreplaceable context (e.g. mid-review steering).
8. **"Fixes #N" in commit + PR bodies.** GitHub only auto-closes issues on the
   magic keyword. "issue #N" or "part of #N" does NOT close. Every commit/PR
   that fully resolves an issue uses `Fixes #N` (or `Closes #N`) in the body.
9. **Verify outputs, not existence (Rule 9).** After any process/tooling
   change, verify what the mechanism actually PRODUCES, not just that it runs —
   run the probe, check the output, and verify at the POINT OF USE. Mandatory
   for every C1/C2 change: dispatch a real probe and observe the result. For
   user-visible output, verification must confirm VISIBILITY end-to-end — the
   probe asks "what does the user see?" not just "did the mechanism execute?".
10. **Risk-calibrated review (Rule 10).** Classify every change BEFORE
    reviewing: C1 (state/concurrency/teardown/security) → full adversarial
    review; C2 (logic/API/cross-module) → focused review; C3
    (display/docs/config) → conductor diff read. No ritual without a
    classification. Reversibility is the tiebreaker; new evidence during review
    can reclassify.
11. **Recurrence escalation (Rule 11).** At sprint end, count friction classes.
    Any class with ≥2 occurrences AND not resolved → P0 for the next sprint,
    with a fix direction. The count is the truth; a "mitigated" label is a
    hypothesis — recurrence evidence overrides it.
12. **Environment before theory (Rule 12).** When something breaks, check the
    environment FIRST (installed SDK version vs lockfile, extension sync, reload
    currency, the session log / run entries audit trail), THEN theorize about
    code. When delegating a debugging task, instruct the subagent to check the
    environment first.
13. **Graph-first scoping (Rule 13) — the Recon checkpoint.** Before writing a
    spec for any C1/C2 change, the CONDUCTOR runs
    `bash .pi/skills/worktree/recon.sh <symbol|file> [--file <src>] --grep`
    (conductor-side only; subagents never see the index, rule 4) and PASTES its
    output into a `## Recon` section at the top of the spec. **No C1/C2 spec
    dispatches without that section** — the maintainer's spec approval rejects a
    spec that lacks it. (This rule's own history: "consult before grep" was an
    intention with no artifact for months and was skipped by default; the
    artifact IS the fix.)
    - The section records BOTH views: the graph's structure (callers, impact,
      affected tests) + the **grep delta** (what grep added or the graph missed).
    - **A graph gap is a FINDING, never a silent skip.** `recon.sh` refreshes a
      stale index itself (1 s); if the refresh fails, or an answer is empty or
      wrong, record that in the Recon section explicitly — never quietly fall
      back to grep.
    - **Structural questions → CodeGraph — the SOLE structural index** (ADR
      0016). Underneath `recon.sh`: `codegraph callers <symbol>`, `codegraph
      impact <symbol>` (file nodes by basename, e.g. `runner.ts`), `codegraph
      query <terms>`, `codegraph affected <file>`; refresh with
      `codegraph-refresh.sh` at every merge (lifecycle step 6);
      `codegraph-check.py --repo-root <path>` for freshness. CLI-only,
      conductor-side, watcher off, never a hook (#230).
    - **Doc concept / cross-document questions → grep + `docs-arch` + the ADRs**
      — the deterministic fallback. graphify is retired (ADR 0016); no LLM sits
      on the doc-navigation path.
14. **Route, don't hand-roll (Rule 14 — dispatch router).** Every dispatch goes
    through the router table — classify the task shape, then use the matching
    preset + template.

    | Task shape | Preset | Template |
    |---|---|---|
    | Adversarial review (C1: state/concurrency/security) | project-reviewer | adversarial-review |
    | Focused review (C2: logic/API) | project-reviewer | focused-review |
    | Debug / breakage investigation (Rule 12) | dev-agent | debug-task |
    | Design investigation / solution proposal (options + recommendation) | project-proposer | design-proposal |
    | Implementation (spec-driven) | project-implementer | — |
    | Docs (verify facts, surgical) | project-docs | — |
    | General work (no match) | dev-agent | — |

    Default: dev-agent + no template — the safe fallback, never wrong.
15. **Spec environment verification (Rule 15).** Before dispatching any
    delegation, verify that every file, directory, and resource referenced in
    the spec exists in the subagent's WORKTREE (the cockpit is a different
    environment — gitignored files like `.codegraph/` and `.pi` session state
    do NOT materialize there; since #247 `.development/` and the `.pi` tools do
    — rule 4's ignore list is the scoping boundary). References must be SYMBOLIC
    (function names, module names, error messages), never absolute (line
    numbers). Specs must include escape clauses for missing resources ("if X is
    not available in your worktree, report and skip — do not seek it
    elsewhere"). EPISTEMIC CLAUSE: the spec must designate the authoritative
    source of truth for its own claims and must never assert ground truth it
    cannot guarantee. The spec is a mechanism — Rule 9 applies to it.
    **DELETION/RENAME SWEEP (issue #173):** when a spec DELETES OR RENAMES a
    module, the removal map must include the **module name and its import
    path**, and must cover: static imports, dynamic `import()`, fixture/allow
    lists, and string dispatch. Confirmed by the tests, never by the map — the
    suite is the backstop, not the oracle.
16. **User review gate (Rule 16).** No delegation beyond trivial ritual work
    (sync, reload, index refresh) may be dispatched without explicit user
    approval of the spec. The conductor presents the spec (or a batch), the user
    reviews, the user approves — THEN the conductor dispatches. "Looks solid"
    does not mean "dispatch now". This gate is non-negotiable.
17. **Reviewer independence (Rule 17).** Independent adversarial reviews must be
    dispatched with IDENTICAL specs, neither reviewer knowing the other exists —
    no path to the other's findings file, no "you may read it for context", no
    hint another review exists. If cross-reading is intended, label it
    EXPLICITLY as a verification pass ("check this findings file for errors"),
    not as an independent review.
18. **Termination triage + retry taxonomy (Rule 18).** On ANY unexpected
    subagent termination (failed/stopped/error status not initiated by the
    conductor), the FIRST response is a question to the user — "did you stop it
    (not meeting expectations, looping, wrong direction), or should I
    investigate?" — before troubleshooting, before classification, before any
    re-dispatch. A user abort is spec-quality signal: capture WHY (looping /
    wrong problem / too slow / budget) and feed it into the next dispatch's
    framing. NEVER re-issue an identical spec after a termination without the
    user's confirmation of the cause. Retry vocabulary is layered and never
    interchangeable: (a) pi transport retries — automatic, 3× staggered by
    default, INSIDE the provider call; (b) extension retryRunId (background
    re-spawn, #98); (c) conductor re-dispatch — a fresh delegation; (d) user
    retry — not a thing for a connection-interrupted agent. Correct responses to
    a surfaced connection error: triage question first, then delay or fallback
    model. **Dispatch-parameter clause:** NEVER set a timeout in the sense of a tight clock — completion time is
    unknowable, and a time-limited agent risks losing all its work. FOREGROUND dispatches: omit the timeout
    (no default cap). BACKGROUND dispatches: pass an explicit generous timeout (e.g. `86400000` = 24h) instead
    of omitting — background runs default to a 30-minute deadline (`DEFAULT_BACKGROUND_DEADLINE_MS`, applied as
    `spawn.timeout ?? DEFAULT_BACKGROUND_DEADLINE_MS`), which cut the #295 review's mutation probes on
    2026-10-09. The bound is the user's monitor + the worktree oracle, never a clock.
19. **Coverage assertion (Rule 19 — the partial-read class).** A search or read
    whose silent truncation or filter boundary is read as completeness is this
    project's most recurrent defect class. Whenever a search, read or filter
    feeds a COUNT, an INVENTORY, or a SPEC:
    - **Print and reconcile the coverage.** Show the matched range/count and
      check it against the expectation, or read the artifact directly.
    - **For filters — dates, categories, literal forms, file types — state the
      boundary.** A pattern that silently misses is indistinguishable from a
      corpus that lacks the item.
    - **For specs, read the WHOLE issue** — symptom, root cause AND the
      fix-direction list.
    - **Prefer reading to searching for small, bounded artifacts** (a
      fix-direction list, a ritual's steps, a reference file). Grep finds; it
      does not prove completeness.
    - **Every guard states its coverage.** "What this check does NOT see"
      belongs in the check itself — output or docstring.
    - **Coverage statements travel with the claim.** Any read/search-derived
      finding, report or verdict carries its coverage line (query, count/range)
      — the report/finding/probe templates require it.
20. **Target assertion (Rule 20 — the probe/mutation class).** A probe or
    mutation aimed at a site chosen without verifying it is the site under test
    produces a misleading reading. Before running:
    - **Name the target by unique surrounding context** — not the bare line or
      field name. If the pattern appears more than once, say which one and why.
    - **State the expected failure signature BEFORE running.** A mutation that
      should kill a test must fail that specific test.
    - **Scope the run to the specific test file**, not the full suite — a green
      targeted run is the signal to re-check the target.
21. **Claims cite their evidence (Rule 21 — the conductor's own coverage).** A
    conductor message that asserts state, liveness, or elapsed time is a claim
    like any other: name the command/result behind it, or mark it as unverified.
    - **Time** → measure it (`date`), state the value ("7m25s") — never a
      guessed escalation ("17+ minutes").
    - **Liveness** → the run-status surface or the user-visible monitor. **Never**
      infer death from a settle-time artifact: `.pi/output/agent-<id>.jsonl` is
      written when a run SETTLES, so a frozen file says nothing about a live run.
      The incremental `/tmp` findings file is the live artifact.
    - **State** ("nothing is in flight", "the tree is clean") → the command that
      showed it.

## Lifecycle

```
0. PRE-FLIGHT   check-repo.sh                 (cockpit checkout; stop on failure)
1. CREATE       git worktree add <path> <branch>
2. PREP         worktree-prep.sh <path> [--force-isolated if bump]  (symlink/install + smoke test)
3. DELEGATE     task with cwd = <path>; subagent commits, pushes, opens PR (body per the pr skill)
4. REVIEW       adversarial review (REVIEW_*.md lives in worktree, gitignored)
5. USER LOOP    review → revisions → approve
6. MERGE        merge commit to `dev` (PRs target `dev`; `dev → main` is the
                release-time merge commit. Never squash — per-issue commits
                must survive so release notes can read them. Never merge a
                task PR straight to `main`.) Then run
                `codegraph-refresh.sh` — the canonical structural index
                (cockpit/dev) is refreshed AT EVERY MERGE; explicit invocation
                only, never a hook (#230). The refresh asserts coverage AND
                freshness (`indexed_at_commit == HEAD`, `index_state =
                complete`). CodeGraph is the SOLE structural index (ADR 0016);
                graphify is retired.
7. CHECKPOINT   release checkpoint for extension-code changes — conductor
                pauses for the user (rule #6; docs/tests/tooling: none)
8. CLEANUP      worktree-cleanup.sh <path>   (UNCONDITIONAL — auto-derives the branch;
                deletes local + remote heads, never dev/main. Applies to EVERY
                worktree of the unit — implementation AND review worktrees)
9. VERIFY       (rule #9) at the point of use — for C1/C2 changes dispatch a
                live probe and confirm the behavior, verifying what the
                mechanism PRODUCES, not that it exists. Under npm dogfooding
                the installed extension is the RELEASED version, so on-disk
                parity with main is checked at release time (tarball vs the
                tagged commit), not after every merge.
```

## Adversarial review dispatch (rule #7 + #8 + #10)

**Classify BEFORE reviewing (Rule 10).** Every change gets a risk class first;
no ritual without a classification:

| Class | When | Review depth |
|-------|------|--------------|
| **C1 — Critical** | State, concurrency, teardown, security, persistence | Full adversarial review (project-reviewer preset, Gate A) |
| **C2 — Significant** | Logic, API surface, cross-module integration | Focused review (targeted concern areas, implementer report + conductor verification) |
| **C3 — Minor** | Display, docs, config, comments, dead code | Conductor diff read only (no subagent review) |

Reversibility is the tiebreaker when the class is ambiguous; new evidence found
during review can reclassify. If unsure, default UP. Brief content, dispatch
mechanics, verdict format: `references/review-dispatch.md`.

## When to use each script

- **`check-repo.sh`** — before ANY worktree creation. If it fails, fix the
  cockpit checkout first (`npm ci` once, only while no worktree is linked; or
  `git pull --rebase`). Never create a worktree on a broken source of truth.
- **`worktree-prep.sh <path> [--include-dev-docs] [--force-isolated]`** —
  immediately after `git worktree add`: provisions node_modules (symlink when
  lockfiles match, isolated `npm ci` otherwise) and smoke-tests vitest, running
  the pre-flight itself. **Do not delegate until the smoke test passes.** Pass
  `--force-isolated` for a dependency-bump task (rule 2); `--include-dev-docs`
  is redundant since #247.
- **`worktree-cleanup.sh <path> [--branch <name>]`** — after the PR is merged OR
  closed. Removes the worktree; deletes the branch (auto-derived when `--branch`
  is omitted) from local and `origin` (never `dev`/`main`); then syncs the
  cockpit. The pull is skipped with a warning when the cockpit has uncommitted
  changes. Unconditional; warns if the shared tree is stale.
- **`codegraph-refresh.sh [--repo-root <path>] [--full]`** — after EVERY merge
  into `dev` (lifecycle step 6): runs `codegraph sync` (or `--full` for a
  rebuild) in the cockpit, then `codegraph-check.py`. CodeGraph is the sole
  structural index (ADR 0016); refreshed by this explicit step, never by a hook
  (#230). Needs the pinned CLI (`pnpm add -g @colbymchenry/codegraph@1.6.2` —
  npm's global prefix needs root here; `CODEGRAPH_BIN` overrides the path);
  run `codegraph telemetry off` once (the script also sets `DO_NOT_TRACK=1`).
  Refuses cleanly when the project has no `.codegraph/` yet (init instructions).
  **Version policy:** pinned at **1.6.2**. Awareness: `codegraph upgrade
  --check`. Deliberate bump: `pnpm add -g
  @colbymchenry/codegraph@<v>` → full `codegraph index` → this refresh green →
  update the version here. Never `codegraph upgrade` while pnpm-managed (one
  writer per install; the npm route ships a vendored runtime with no postinstall).
- **`codegraph-check.py`** — after a refresh, and on demand. Verifies module AND
  exported-symbol coverage against `src/*.ts`, asserts freshness
  (`indexed_at_commit` equals HEAD, `index_state = complete` — stronger than the
  retired mtime check), prints a dirty-paths advisory, and states its coverage
  boundaries (what it does NOT check). Exits non-zero on any discrepancy —
  catching the silent refresh failures that issues #173 (missing module) and
  #189 (missing symbols) record. Run from the cockpit.

## Notes

- **The cockpit is the `dev` checkout** (`brl-subagent-dev`): it holds
  `.development/`, `.codegraph/` (the structural index), the `.pi/` tools and
  the SHARED `node_modules`. `main` is the pristine release checkout.
- Scripts are bash and run from the cockpit checkout (they resolve the repo root
  from their own location; `--repo-root` overrides); `worktree-prep.sh` runs
  from the cockpit, not the worktree. `sprint-metrics.py` is python3 and derives
  its own session-log source.
- If a script fails, read its output — it states the mode chosen and why. That
  output is the audit trail.
- The skill is the playbook, the scripts are the enforcement, the docs are the
  written team agreement. Process rules 9-12 and the trust protocol are in this
  skill; the metrics store is `.development/METRICS.md`; the friction log is
  `.development/FRICTION_LOG.md`.

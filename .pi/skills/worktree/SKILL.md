---
name: worktree
description: >
  Worktree lifecycle management for brl-subagent development. Use when creating
  a git worktree for a delegation task, preparing it for a subagent, cleaning up
  after a PR merge, checking the cockpit (dev) checkout's health before starting work,
  running the sprint-end ritual (recurrence escalation + trust metrics — a
  SPRINT boundary, NOT a worktree close),
  cutting a release (the release ritual — version-reference inventory, doc
  updates, bump, tag, GitHub draft + publish),
  OR before implementing any change to src/ or presets/ (all code changes go
  through a worktree). Scripts live in this skill directory. Covers the
  pre-flight check, node_modules provisioning (symlink vs isolated install),
  smoke testing, unconditional teardown, the risk-calibrated review dispatch
  (C1/C2/C3 classification), the release ritual, and the sprint-end metrics
  ritual. Full design:
  .development/WORKTREE_FRAMEWORK.md; process rules 9-21 are in this skill.
---

# Worktree Framework

The conductor (not the subagent) owns the worktree lifecycle. This skill is the
playbook; the scripts in this directory are the enforcement. Run the scripts —
never re-type their logic by hand.

## Team Agreement (invariants)

1. **The cockpit (`dev`) checkout's `node_modules` is the SHARED source of
   truth — pristine.** Worktrees symlink to it; never run `npm install`/`npm ci`
   in the cockpit during delegation work. If
   deps appear missing, run `check-repo.sh` and report — do not patch.
2. **Dependency management is repo-level only.** `worktree-prep.sh` is the only
   sanctioned provisioning path. **Dependency-bump worktrees (any task that
   will touch `package.json`/`package-lock.json`) ALWAYS pass `--force-isolated`**
   — the lockfile will diverge BY DESIGN, and a symlinked install would clobber
   the cockpit's pristine tree (issue #100). After a bump merge into `dev`,
   refresh the shared tree with `npm ci` in the cockpit once no worktree is
   linked against the stale lockfile; worktrees prepped before the bump must be
   re-prepped with `worktree-prep.sh <path> --force-isolated` (a symlinked
   checkout cannot be installed in place — the worktree-guard blocks it
   (#100/#106), correctly — and a symlinked install would serve the stale tree).
   The cleanup script warns when the shared tree is stale.
3. **Subagents consume, never provision.** A subagent hitting a missing dep or
   broken artifact mid-task REPORTS it and stops — never creates, reinstalls,
   or touches the cockpit checkout.
4. **Tracked docs/tools materialize; state does not.** Since #247 (2026-09-30),
   `.development/**` and the `.pi` TOOLS (`.pi/skills/**`, `.pi/extensions/**`)
   are TRACKED — they materialize in every worktree, and specs MAY ask a
   subagent to read them. Still gitignored (and absent from worktrees):
   `graphify-out/`, `.pi` session state (`output/`, `subagents/`,
   `subagent-logs/`, `subagent-tmp/`, `sessions/`), local config
   (`.pi/brl-subagent/`), `REVIEW_*.md`, `.tmp/`.
   **Subagents NEVER see gitignored files**, so specs must never ask a subagent
   to read or edit those — graph guidance
   (Rule 13) is used by the CONDUCTOR to scope/frame instructions, then the
   spec carries the distilled scope. Environment-dependent instructions get
   an escape clause: "if X is not available in your worktree, report and skip
   — do not seek it elsewhere."
5. **ALL code changes go through a branch + worktree — even small fixes.**
   Direct-to-main commits are never acceptable. If you are about to modify
   `src/` or `presets/` and you are NOT in a worktree, STOP — create one
   first. This rule applies to the conductor implementing directly, not just
   to delegated subagents.
6. **Release checkpoint for extension-code changes** (previously the reload
   checkpoint). The running pi session executes the extension code loaded at
   startup. Since v2.3.5 the daily install is the **published npm package**,
   not a synced working copy — so merged extension code is NOT active until a
   **release**: bump → GitHub release → CI stages → maintainer approval on npm
   → `pi update --extensions`. After merging a change that alters the running
   extension, the conductor STOPS, states the release checkpoint, and waits.
   Changes that never reach the running extension (docs, tests, tooling) are
   complete at merge — no checkpoint. For live verification of unmerged work
   use the local-path dev toggle (§ Local development, below) + `/reload`;
   never load two copies (dedupe is by resolved absolute path). The reload or
   update is ALWAYS user-triggered — never automate it (a buggy auto-reload
   loop is worse than the staleness it fixes).
7. **Delegation threshold — the conductor is a project manager, not an
   implementer.** Implementation, probes/investigations, adversarial reviews,
   and code drafts go to subagents with a precise spec; the conductor holds
   sequencing, review of subagent output, rituals, and judgment calls.
   Tripwire before opening any file to implement or analyze: "could I write a
   spec for this?" — if yes, delegate it. Exceptions: tiny ritual/doc edits
   in repo docs/tools (this skill, `.development/` — tracked since #247), and tasks where the
   conductor already holds irreplaceable context (e.g. mid-review steering).
8. **"Fixes #N" in commit + PR bodies.** GitHub only auto-closes issues on
   the magic keyword. "issue #N" or "part of #N" does NOT close — stale
   issues are how drift starts. Every commit/PR that fully resolves an issue
   uses `Fixes #N` (or `Closes #N`) in the body.
9. **Verify outputs, not existence (Rule 9).** After any process/tooling
   change, verify what the mechanism actually PRODUCES, not just that it
   runs — run the probe, check the output, and verify at the POINT OF USE
   (a sync that ran before the merge completed is a stale sync). Mandatory
   for every C1/C2 change: dispatch a real probe and observe the result.
   The live-verification ritual is what makes an issue *actually* closed
   rather than *believed* closed. For features with user-visible output
   (monitor entries, notifications, drill-in fields), verification must
   confirm VISIBILITY end-to-end — the probe asks "what does the user
   see?" not just "did the mechanism execute?" (the #119/#122 probes
   confirmed the run-entry fields appeared in the monitor, not merely that
   persistRun was called). See the process rules in this skill.
10. **Risk-calibrated review (Rule 10).** Classify every change BEFORE
    reviewing: C1 (state/concurrency/teardown/security) → full adversarial
    review; C2 (logic/API/cross-module) → focused review; C3
    (display/docs/config) → conductor diff read. No ritual without a
    classification. Reversibility is the tiebreaker; new evidence during
    review can reclassify.
11. **Recurrence escalation (Rule 11).** At sprint end, count friction
    classes. Any class with ≥2 occurrences AND not resolved → P0 for the
    next sprint, with a fix direction (a P0 without a direction is anxiety,
    not a plan). The count is the truth; a "mitigated" label is a
    hypothesis — recurrence evidence overrides it.
12. **Environment before theory (Rule 12).** When something breaks, check
    the environment FIRST (installed SDK version vs lockfile, extension
    sync, reload currency, the session log / run entries audit trail), THEN
    theorize about code. Ordering, not exclusivity — theory still has its
    turn. When delegating a debugging task, instruct the subagent to check
    the environment first.
13. **Graph-first scoping (Rule 13).** Before writing a spec for any C1/C2
    change, the CONDUCTOR consults the knowledge graph (graphify-out/ —
    conductor-side only; subagents never see it, rule 4) for the change's
    NEIGHBORHOOD — relationships, seams (AMBIGUOUS edges), and blast
    radius — BEFORE grep. The graph is the efficiency layer for scoping
    (one query = the overview); grep remains the deterministic ground
    truth for exact references and verification. If the graph is stale
    (last update predates the sprint's commits), refresh it first. The
    spec includes BOTH views: the graph's structure + grep's exact call
    sites. The #114 scoping error is the proof-of-need: the graph already
    had the complete touchpoint map; the conductor hand-assembled it from
    memory + grep instead.
14. **Route, don't hand-roll (Rule 14 — dispatch router).** Every dispatch
    goes through the router table — classify the task shape, then use the
    matching preset + template. A lookup replaces a judgment call.

    | Task shape | Preset | Template |
    |---|---|---|---|
    | Adversarial review (C1: state/concurrency/security) | project-reviewer | adversarial-review |
    | Focused review (C2: logic/API) | project-reviewer | focused-review |
    | Debug / breakage investigation (Rule 12) | dev-agent | debug-task |
    | Design investigation / solution proposal (options + recommendation) | project-proposer | design-proposal |
    | Implementation (spec-driven) | project-implementer | — |
    | Docs (verify facts, surgical) | project-docs | — |
    | General work (no match) | dev-agent | — |

    Default: dev-agent + no template — the safe fallback, never wrong.
    Templates are CONTRACT + free-form TARGET: the contract (verdict
    format, quality bar, verification discipline) is fixed; the target
    description is filled by the conductor for ANY scope (a PR, a plan, a
    finding, a revision round). The audit that drove this rule: templates
    used 2 of 372 dispatches; graph mode 0 of 372 — the machinery was
    built and never routinized.
15. **Spec environment verification (Rule 15).** Before dispatching any
    delegation, verify that every file, directory, and resource referenced
    in the spec exists in the subagent's WORKTREE (the cockpit is a different
    environment — gitignored files like `graphify-out/` and `.pi` session
    state do NOT materialize there; since #247 `.development/` and the `.pi`
    tools DO — rule 4's ignore list is the scoping boundary). References must be
    SYMBOLIC (function names, module names, error messages), never
    absolute (line numbers — the #122 100+ turn loop was a spec whose
    cited line numbers its own prescribed edit shifted by +15). Specs must
    include escape clauses for missing resources ("if X is not available
    in your worktree, report and skip — do not seek it elsewhere").
    EPISTEMIC CLAUSE: the spec must designate the authoritative source of
    truth for its own claims (e.g. "run `npx tsc --noEmit` first; the
    compiler's output — not this spec — is the only authority for error
    locations") and must never assert ground truth it cannot guarantee
    ("the reconnaissance is done" framing told the #122 subagent the spec
    could not be wrong; it looped reconciling an infallible instruction
    against reality). The spec is a mechanism — Rule 9 applies to it:
    verify it produces the intended behavior, not that it looks correct.
    **DELETION/RENAME SWEEP (issue #173, occurrence 1 — 2026-09-12):** when a
    spec DELETES OR RENAMES a module, a symbol-only sweep is *structurally
    blind* — it cannot see references by MODULE NAME. The removal map must
    include the **module name and its import path**, and must cover: static
    imports, dynamic `import()`, fixture/allow lists holding bare strings
    (`e2e.test.ts`'s `ISOLATED_FILES` held the string `"update"`), and string
    dispatch. Confirmed by the tests, never by the map — the suite is the
    backstop, not the oracle. Cost when skipped: the #164 spec ordered
    "touch ONLY the files listed", then the suite required a file outside
    that list — **the spec created its own conflict** and the implementer had
    to deviate to stay green.
16. **User review gate (Rule 16).** No delegation beyond trivial ritual
    work (sync, reload, graphify update) may be dispatched without
    explicit user approval of the spec. The conductor presents the spec
    (or a batch), the user reviews, the user approves — THEN the conductor
    dispatches. "Looks solid" does not mean "dispatch now". This gate is
    non-negotiable; it was born from the dispatch-bypass incident (two
    unapproved dispatches in one hour, one 100+ turn loop) and held for
    every subsequent dispatch — user-approved specs ran without a single
    loop or timeout. Batched approval (one review pass over a sequence of
    specs) is the working form; mechanical wiring (approvalMode for
    delegations) is deferred unless the manual gate starts failing.
17. **Reviewer independence (Rule 17).** Independent adversarial reviews
    must be dispatched with IDENTICAL specs, neither reviewer knowing the
    other exists — no path to the other's findings file, no "you may read
    it for context", no hint another review exists. If cross-reading is
    intended, label it EXPLICITLY as a verification pass ("check this
    findings file for errors"), not as an independent review. The 08-18
    incident: reviewer #2 was given reviewer #1's findings file and told
    "you MAY read it" — the resulting zero-disagreement convergence was
    influence, not validation. Independent reviews produce genuine
    convergence; verification passes produce corroboration; both are
    valuable, but they must be labelled correctly (the #125 second opinion
    was a correctly-labelled verification pass).
18. **Termination triage + retry taxonomy (Rule 18).** On ANY unexpected
    subagent termination (failed/stopped/error status not initiated by the
    conductor), the FIRST response is a question to the user — "did you
    stop it (not meeting expectations, looping, wrong direction), or
    should I investigate?" — before troubleshooting, before
    classification, before any re-dispatch. A user abort is spec-quality
    signal: capture WHY (looping / wrong problem / too slow / budget) and
    feed it into the next dispatch's framing. NEVER re-issue an identical
    spec after a termination without the user's confirmation of the
    cause. Retry vocabulary is layered and never interchangeable: (a) pi
    transport retries — automatic, 3× staggered by default (SDK
    settings-manager `retry.maxRetries ?? 3`), consumed INSIDE the
    provider call, invisible to us except as latency — a surfaced
    connection error means the ladder already failed, i.e. persistent
    provider unavailability across the retry window, so an INSTANT
    re-dispatch often hits the same conditions; (b) extension retryRunId
    (background re-spawn, #98); (c) conductor re-dispatch — a fresh
    delegation, never call it "retry" without qualification; (d) user
    retry — for a connection-interrupted agent this is not a thing (the
    process is dead; the retry belongs to pi's transport layer). Correct
    responses to a surfaced connection error: termination-triage question
    first, then delay or fallback model — not instant re-dispatch. The
    08-26 user feedback: the conductor treated every termination as a
    technical fault and re-issued without ever asking whether the user
    terminated it.
    **Dispatch-parameter clause (2026-08-27, third recurrence):** NEVER set a
    timeout on implementer/reviewer dispatches — completion time is unknowable,
    and a time-limited agent risks losing all its work (the #120 implementer was
    killed while posting its PR; work survived only because commit+push preceded
    the kill). Omit the timeout parameter entirely (the default is no cap); the
    bound is the user's monitor + the worktree oracle, never a clock.

19. **Coverage assertion (Rule 19 — the partial-read class).** A search or read
    whose silent truncation or filter boundary is read as completeness is this
    project's most recurrent defect class (issue #189: four occurrences in one
    week, two of them in the guards themselves; #204: five in the v2.3.8
    sprint, filed as a P0 because the template-driven reads stayed unguarded).
    Whenever a search, read or filter feeds a COUNT, an INVENTORY, or a SPEC:
    - **Print and reconcile the coverage.** Show the matched range/count and
      check it against the expectation, or read the artifact directly instead
      of patterning it. `grep '^2026-09-1'` silently omitted every 09-20 entry;
      `grep -rn … | head -8` hid the matching section at line ~510.
    - **For filters — dates, categories, literal forms, file types — state the
      boundary.** A pattern that silently misses is indistinguishable from a
      corpus that lacks the item.
    - **For specs, read the WHOLE issue** — symptom, root cause AND the
      fix-direction list (the #175 spec skipped fix-direction item 4 and only
      an adversarial review caught it).
    - **Prefer reading to searching for small, bounded artifacts** (a
      fix-direction list, a ritual's steps, a reference file). Grep finds; it
      does not prove completeness.
    - **Every guard states its coverage.** "What this check does NOT see"
      belongs in the check itself — output or docstring. `graph-check.py`
      prints its boundaries and samples symbols; the #186 ratchet documents
      its evasion set and allow-list reasons.
    - **Coverage statements travel with the claim.** Any read/search-derived
      finding, report or verdict carries its coverage line (query, count/range,
      reconciliation) — and the templates that shape reports, findings and
      probes now require it (#204: at the second occurrence, in review AND
      debug output).

20. **Target assertion (Rule 20 — the probe/mutation class).** A probe or
    mutation aimed at a site chosen without verifying it is the site under
    test produces a misleading reading: a green result is first evidence the
    TARGET was wrong, not that the guard is weak (issue #205: the #200 cost-×N
    mutation hit the earlier copy of a duplicated line and the suite stayed
    green; the Phase-3 probe asserted a field that lived elsewhere). Before
    running:
    - **Name the target by unique surrounding context** — not the bare line or
      field name. If the pattern appears more than once, say which one and why.
    - **State the expected failure signature BEFORE running.** A mutation that
      should kill a test must fail that specific test.
    - **Scope the run to the specific test file**, not the full suite — a green
      targeted run is the signal to re-check the target.

21. **Claims cite their evidence (Rule 21 — the conductor's own coverage).** A conductor
    message that asserts state, liveness, or elapsed time is a claim like any other:
    name the command/result behind it, or mark it as unverified (issue #217). Specifics:
    - **Time** → measure it (`date`), state the value ("7m25s") — never a guessed
      escalation ("17+ minutes").
    - **Liveness** → the run-status surface or the user-visible monitor. **Never** infer
      death from a settle-time artifact: `.pi/output/agent-<id>.jsonl` is written when a
      run SETTLES (its mtime equals the settle timestamp), so a frozen file says nothing
      about a live run. The incremental `/tmp` findings file is the live artifact.
    - **State** ("nothing is in flight", "the tree is clean") → the command that showed it.
    The #204 class applied to prose: a partial or absent observation presented as complete.

## Lifecycle

```
0. PRE-FLIGHT   check-repo.sh                 (cockpit checkout; stop on failure)
1. CREATE       git worktree add <path> <branch>
2. PREP         worktree-prep.sh <path> [--force-isolated if bump]  (symlink/install + smoke test)
3. DELEGATE     task with cwd = <path>; subagent commits, pushes, opens PR
4. REVIEW       adversarial review (REVIEW_*.md lives in worktree, gitignored)
5. USER LOOP    review → revisions → approve
6. MERGE        merge commit to `dev` (PRs target `dev`; `dev → main` is the
                release-time merge commit. Never squash — per-issue commits
                must survive so release notes can read them. Never merge a
                task PR straight to `main`.) Then run graph-refresh.sh — the
                canonical graph (cockpit/dev) is refreshed AT EVERY MERGE;
                hooks only read/validate it, never rebuild (#230).
7. CHECKPOINT   release checkpoint for extension-code changes — conductor
                pauses for the user (rule #6; docs/tests/tooling: none)
8. CLEANUP      worktree-cleanup.sh <path> --branch <branch>   (UNCONDITIONAL)
9. VERIFY       (rule #9) at the point of use — for C1/C2 changes dispatch a
                live probe and confirm the behavior, verifying what the
                mechanism PRODUCES, not that it exists. Under npm dogfooding
                the installed extension is the RELEASED version, so on-disk
                parity with main is checked at release time (tarball vs the
                tagged commit), not after every merge.
```

## Local development (npm dogfooding + the dev toggle)

Since v2.3.5 the extension is a **published pi package**. The running extension is
the artifact users actually get — that is the dogfooding posture, and it is what
exposed the #158 AGENT.md packaging defect that the retired sync-copy setup could
never see.

**Daily use** (the published artifact — the same thing users install):

```bash
pi install npm:brl-subagent            # global (or -l for project-local)
pi update --extensions                 # advance to a newer published version
```

**Developing** (load the checkout in place — **no copying, no syncing**):

```bash
pi remove npm:brl-subagent
pi install /abs/path/to/brl-subagent   # or an unmerged worktree: …/brl-subagent-wt-<n>
# /reload pi after edits

# back to the published artifact
pi remove /abs/path/to/brl-subagent
pi install npm:brl-subagent
```

- A **local-path install can point at an unmerged worktree**, so it doubles as
  live verification for a PR — something the retired `sync-extension.sh` could
  never do.
- **Never load two copies.** Dedupe is by resolved absolute path, so an npm
  install plus a local-path install register duplicate tools and commands.
  Remove one before installing the other.
- `pi update --extensions` advances the npm install and leaves a local-path
  install alone.
- **Retired (2026-09-11):** `sync-extension.sh` (rsync into
  `~/.pi/agent/extensions/brl-subagent`). It could not coexist with npm
  dogfooding — retargeting the npm store would fight the package manager, and a
  separate directory would double-load. `worktree-prep.sh` / `worktree-cleanup.sh`
  guard their sync steps and degrade to a no-op.

**Testing a candidate without touching settings** (verified empirically 2026-09-14):

```bash
pi -ne -e /abs/path/to/brl-subagent     # or an unmerged worktree
```

- **`-ne` is REQUIRED.** Pi's loader merges CLI paths with the resolved settings
  packages (`extensionPaths = noExtensions ? cliEnabledExtensions :
  mergePaths(...)`), so `pi -e <dir>` **alone** loads the installed npm copy *and*
  the dev copy → duplicate tools and commands. `--no-extensions` keeps only the
  explicit `-e` paths.
- Verified: with `-ne -e <dir>` the dev directory loads cleanly and registers
  `delegate_task`, `get_subagent_result`, `steer_subagent`, `stop_subagent`;
  zero extension load errors.
- **Trade-off:** `-ne` also suppresses the *other* extensions (pi-intercom,
  context7, …) — a bare session of pi's built-ins plus brl-subagent. That
  isolation is usually what you want when testing this extension; when you need
  your normal session, use the toggle above instead.
- **Nothing to undo** — no settings change, so there is no way to forget to
  revert and unknowingly run dev code.

## Adversarial review dispatch (rule #7 + #8 + #10)

**Classify BEFORE reviewing (Rule 10).** Every change gets a risk class first;
no ritual without a classification:

| Class | When | Review depth |
|-------|------|--------------|
| **C1 — Critical** | State, concurrency, teardown, security, persistence | Full adversarial review (project-reviewer preset, Gate A) |
| **C2 — Significant** | Logic, API surface, cross-module integration | Focused review (targeted concern areas, implementer report + conductor verification) |
| **C3 — Minor** | Display, docs, config, comments, dead code | Conductor diff read only (no subagent review) |

Reversibility is the tiebreaker when the class is ambiguous; new evidence
found during review can reclassify mid-flight. If unsure, default UP.

Reviewers are **read-only on the repo but have bash** — the read-only
`code-reviewer` preset excludes bash and is NOT used (empirical verification
needs execution). Use the project-scoped `project-reviewer` preset
(`.pi/brl-subagent/presets/project-reviewer.md`): tools `read, bash, grep,
find, ls`, explicitly NO `write`/`edit` so the reviewer can never touch code.
It carries the Gate A expectation, the SOLID/DRY mirror check, and the
verdict format — the dispatch task only adds the PR-specific focus areas.

**Dispatch with `preset: "project-reviewer"` — NOT bare `tools` (the
auto-route can override an explicit tools list; an explicit preset wins) and
NOT `dev-agent` + `excludeTools` (the retired workaround).**

**The instruction MUST demand the verdict in the final output** — never tell
the reviewer to write a file it cannot write:

- Do NOT write any files.
- Output your verdict in this exact format in your final response:
  verdict line (`approve` / `approve-with-nits` / `changes-requested`),
  findings table (severity | file:line | one-liner), verified-OK list,
  and `SOLID/DRY violations flagged: N` (the efficacy gauge — the
  project-reviewer preset's mirror check feeds it).
- Gate A: verify stateful claims (teardown, races, git/fs behavior)
  empirically — scratch repos in /tmp, real commands — do not just read code.
- Keep the verdict compact; the deep write-up lives in the final output only.

The conductor retrieves the final output (never sleep-waits — the user
watches the monitor and pings when done), writes `REVIEW_PR*.md` in the
worktree from the returned verdict, and presents it for the user loop.

## When to use each script

- **`check-repo.sh`** — before ANY worktree creation. If it fails, fix the
  cockpit checkout first (usually: `npm ci` once — only while no worktree is
  linked to the shared tree — or `git pull --rebase`). Never
  create a worktree on a broken source of truth.
- **`worktree-prep.sh <path> [--include-dev-docs] [--force-isolated]`** — immediately after
  `git worktree add`. Provisions node_modules (symlink when lockfiles match,
  isolated `npm ci` otherwise), and smoke-tests vitest. The `--include-dev-docs`
  symlink is redundant since #247 (`.development/` is tracked and materializes
  natively) — it remains only for checkouts that predate the tracking. (The retired `sync-extension.sh`
  is no longer provisioned — that step is a guarded no-op.) **Do not
  delegate until the smoke test passes.** Pass `--force-isolated` for any
  dependency-bump task (one that will modify `package.json` or
  `package-lock.json`) — the lockfile diverges by design and the symlink
  would clobber the cockpit's pristine node_modules. Runs the pre-flight
  (check-repo.sh) itself before provisioning.
- **`worktree-cleanup.sh <path> --branch <name>`** — after the PR is merged OR
  closed without merge. Removes the worktree, deletes the branch, syncs the
  cockpit.
  (`sync-extension.sh` was retired 2026-09-11 — that step is a guarded no-op.)
  Unconditional — cleanup happens regardless of
  merge outcome. Warns if the cockpit's node_modules is stale vs the merged lockfile
  (post-bump ritual: run `npm ci` in the cockpit, once no worktree is linked).
- **`graph-refresh.sh`** — after EVERY merge into `dev` (lifecycle step 6).
  Runs `graphify . --update` in the cockpit, then `graph-check.py`. The
  canonical graph describes the cockpit (dev) tree and is refreshed by this
  explicit step — never by a hook side effect (issue #230). `--repo-root`
  overrides. Add `graphify cluster-only <cockpit>` manually when a fresh
  `GRAPH_REPORT.md`/community naming is wanted (the extract keeps
  `graph.json` — nodes, edges, communities — current on its own).
- **`graph-check.py`** — after a refresh, and on demand. Verifies module coverage AND exported-symbol coverage of the graph
  against `src/*.ts` on disk, prints its coverage boundaries (what it does NOT
  check), and exits non-zero on any discrepancy — catching the silent refresh
  failures that issues #173 (missing module) and #189 (missing symbols /
  stale-content rewrite) record. Run it from the cockpit checkout;
  `--repo-root` overrides.

## Friction log ritual

Log a friction **when one occurs** — not once per cycle. A clean delegation
cycle logs **nothing**, and that is the expected outcome. Append one line to
`.development/FRICTION_LOG.md`:

```
YYYY-MM-DD | <tag> | <observation>
```

One line, no elaboration, no judgment — what happened, not what to do about it.
Log frictions as they happen, not deferred to sprint end. The purpose is the
tripwire against losing *genuine* workflow observations to the dopamine of
merged PRs — signal, not ceremony.

**What counts:** anything that took an unexpected path — *or could have*. A
near-miss qualifies (a wrong course proposed and caught before it shipped), not
just a realised failure. **This is not a blame log**: it records paths, not
people — no finger-pointing at the assistant, the conductor, or the user,
because a log that assigns fault stops being written in honestly. Its purpose
is **enlightenment** — what can we improve in how we develop, useful for
brl-subagent and portable to other projects.

**Never manufacture an entry to satisfy the ritual.** A forced or padded entry
is worse than silence: the log feeds the Rule 11 class counts (≥2 occurrences →
P0), so an invented friction can fabricate a recurrence and produce a false
priority. An empty log over a clean cycle is a correct log.

## Release ritual

Run this on every release. **Step 1 exists because it was skipped once** — the
v2.3.5 bump shipped three stale version strings (README `Version: 2.3.4`, the
README git-install example `@v2.3.4`, and the AGENT.md header `(v2.3.4+)`)
because nothing checked them and no test pins them.

**Order matters: the version inventory first, docs before the bump.**

1. **Inventory version references** — every place the outgoing version appears:
   ```bash
   grep -rn "<old-version>" package.json package-lock.json README.md AGENT.md \
     CHANGELOG.md .development/ .pi/skills/worktree/ | grep -v node_modules
   ```
   Update every *current-state* hit (README header, doc headers). Leave
   *historical* hits (CHANGELOG entries, `.development/` history, the friction
   log). AGENT.md carries no version stamp by design (#166), so nothing to
   update there.
2. **`.development/` docs** (TRACKED since #247 — doc updates are direct-to-dev commits):
   - `ROADMAP.md` — header version → new; add a **"Shipped (<date>, vX)"** table
     for this release's items
   - `ARCHITECTURE.md` / `AUDIT.md` — header version → new; AUDIT gets a
     **"vX Audit Follow-up (<date>)"** section
   - `TASKS.md` — a changelog row: items, issues closed, process changes, test
     count, board state, friction
   - `METRICS.md` — the sprint's row (run the metrics script; see the
     sprint-end ritual below)
3. **Bump** — `npm version <X> --no-git-tag-version` (updates `package.json`
   **and** `package-lock.json`).
4. **Docs that ship** — `README.md` version header; `CHANGELOG.md` release entry
   (newest-first, project voice). *(The git-install example tag was dropped in
   #171 — npm is the sole user-facing install/update path.)*
5. **Commit + tag + push** — `chore: bump version to <X>`. The commit carries
   only `package.json`, `package-lock.json`, `README.md`, `CHANGELOG.md`
   (`.development/` docs are tracked now — commit them separately, so the bump
   commit stays code + shipping docs only).
6. **Release note as a GitHub DRAFT** —
   `gh release create vX --draft --title "…" --notes-file <file>`, then tell the
   user where to review it. **The user publishes it** — and that publish is what
   triggers `publish.yml`.
7. **`graphify . --update`** — refresh the knowledge graph to the released state
   (Rule 13's graph-first scoping depends on a current graph). Then **verify it
   against ground truth** — never trust that the refresh succeeded:

   ```bash
   python3 .pi/skills/worktree/graph-check.py
   ```

   The check verifies module coverage AND exported-symbol coverage against
   `src/*.ts` on disk, prints its coverage boundaries, and exits non-zero on
   any discrepancy. It is mechanical because **this failure is silent**: the
   2026-09-12 refresh produced a graph missing `src/paths.ts` (added the day
   before) and reported success — issue #173, occurrence 2; the 2026-09-20
   `cluster-only` rewrite kept every module and lost the day's symbols — issue
   #189. Refresh ONLY when stale (`built_at_commit` vs HEAD, source mtimes) —
   a 2026-09-22 refresh on an unchanged tree still rewrote the graph
   (821→816 nodes, semantic names→fallbacks) with the guard green.

   **Shrink guard (graphify #479):** if the export *refuses* because the new
   graph has fewer nodes, do NOT force reflexively. The guard cannot distinguish
   a legitimate deletion from data loss, so:
   1. confirm the shrink is real (modules/tests actually deleted, docs trimmed),
   2. **state the reasoning**,
   3. only then re-run with `--force`.

   The 2026-09-12 release legitimately shrank the graph — a module and a test
   were deleted and two shipped docs trimmed, so forcing was correct. That
   reasoning is recorded here **so it is not re-derived or assumed**; record the
   equivalent reasoning each time the guard fires.
8. **Switch the running install back to the published package** — *only after the
   staged publish is approved*, never before.

   If the local development toggle is in use (`pi install <path>`, see
   § Local development), the running extension is a **working-tree checkout**, not
   the released artifact. Restore the shipped path:

   ```bash
   pi remove /abs/path/to/brl-subagent-dev
   pi install npm:brl-subagent
   pi update --extensions
   # then /reload
   ```

   **Timing is load-bearing.** Switching *before* the staging approval reverts the
   running extension to the previous published version — silently dropping every
   fix in this release. Approval first, then switch.

   And never leave both loaded: dedupe is by resolved absolute path, so a
   local-path install plus an npm install register duplicate tools and commands.
   The dev checkout itself can stay on disk for the next cycle — it is the
   *install* that changes, not the directory.

9. **Sprint-end ritual** — Rule 11 recurrence escalation + trust metrics (below).
10. **Friction log** — one line per unexpected or inefficient outcome, logged as
   it happens, not deferred to the end.

**Current release channel (v2.3.5+):** `.github/workflows/publish.yml` — OIDC
trusted publishing, **staged** (a maintainer approves with 2FA at npmjs.com →
package → Staged Packages). Publishing the GitHub release does **not** put the
version live; the approval does. The running extension then updates via
`pi update --extensions` (the release checkpoint, rule #6).

## Sprint-end ritual (Rule 11 + trust metrics)

**Trigger: a SPRINT boundary — never a worktree event.** A sprint spans many
worktree create/teardown cycles; closing one worktree is not a sprint end.
Do NOT run this at worktree cleanup — run it when the sprint's work is done.

**A sprint ends when the user declares it.** There is no time-based or
release-based cadence: the human maintainer calls the boundary — the machine
does not tire, the human does. Do not infer a sprint end from a release, a
merged PR, or a worktree teardown; wait to be told.

At sprint end, BOTH of these run — they share one cadence:

1. **Recurrence escalation (Rule 11):** group the sprint's friction entries by
   CLASS (not tag), count occurrences. Any class with ≥2 occurrences AND not
   resolved → P0 for next sprint, filed as an issue with a fix direction.
   Recurrence evidence overrides a "mitigated" label.
2. **Trust metrics:** run `python3 .pi/skills/worktree/sprint-metrics.py
   --since <sprint-start> --until <sprint-end> --sprint <label> --out
   .development/METRICS.md` — the script derives the rates from the session
   log (never vibed), appends the row, and the numbers feed the Rule 11
   escalation mechanically. Review the row alongside the friction log:
   the log answers WHY, the metrics answer HOW MANY.

## Notes

- **The cockpit is the `dev` checkout** (`brl-subagent-dev`): it holds
  `.development/`, `graphify-out/`, the `.pi/` tools and the SHARED
  `node_modules`. `main` is the pristine release checkout (no deps until a
  release needs them).
- Scripts are bash; run them from the cockpit checkout (they resolve the repo
  root from their own location by default; `--repo-root` overrides).
  `sprint-metrics.py` is python3 and derives its own session-log source.
- `worktree-prep.sh` runs from the cockpit checkout, not the worktree.
- If a script fails, read its output — it states the mode chosen and why.
  That output is the audit trail.
- Process rules 9-12 and the trust protocol are in this skill; the metrics
  store is `.development/METRICS.md`; the friction log is
  `.development/FRICTION_LOG.md`.
  The skill is the playbook, the scripts are the enforcement, the docs are
  the written team agreement.

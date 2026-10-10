# Team Agreement rule notes

Narrative behind the invariants in `SKILL.md` — founding incidents, war stories,
dates, and historical framing. The binding rules (with their numbers) live in
`SKILL.md`; nothing here changes them. Rule numbers match `SKILL.md` exactly.

**Contents**

- [Rule 2 — Dependency management is repo-level only](#rule-2)
- [Rule 4 — Tracked docs/tools materialize; state does not](#rule-4)
- [Rule 5 — ALL code changes go through a branch + worktree](#rule-5)
- [Rule 6 — Release checkpoint for extension-code changes](#rule-6)
- [Rule 7 — Delegation threshold](#rule-7)
- [Rule 8 — "Fixes #N" in commit + PR bodies](#rule-8)
- [Rule 9 — Verify outputs, not existence](#rule-9)
- [Rule 11 — Recurrence escalation](#rule-11)
- [Rule 12 — Environment before theory](#rule-12)
- [Rule 13 — Graph-first scoping](#rule-13)
- [Rule 14 — Route, don't hand-roll](#rule-14)
- [Rule 15 — Spec environment verification](#rule-15)
- [Rule 16 — User review gate](#rule-16)
- [Rule 17 — Reviewer independence](#rule-17)
- [Rule 18 — Termination triage + retry taxonomy](#rule-18)
- [Rule 19 — Coverage assertion](#rule-19)
- [Rule 20 — Target assertion](#rule-20)
- [Rule 21 — Claims cite their evidence](#rule-21)

## Rule 2

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

## Rule 4

4. **Tracked docs/tools materialize; state does not.** Since #247 (2026-09-30),
   `.development/**` and the `.pi` TOOLS (`.pi/skills/**`, `.pi/extensions/**`)
   are TRACKED — they materialize in every worktree, and specs MAY ask a
   subagent to read them. Still gitignored (and absent from worktrees):
   `.codegraph/` (the structural index — conductor-side only, ADR 0016),
   `.pi` session state (`output/`, `subagents/`,
   `subagent-logs/`, `subagent-tmp/`, `sessions/`), local config
   (`.pi/brl-subagent/`), `REVIEW_*.md`, `.tmp/`.
   **Subagents NEVER see gitignored files**, so specs must never ask a subagent
   to read or edit those — graph guidance
   (Rule 13) is used by the CONDUCTOR to scope/frame instructions, then the
   spec carries the distilled scope. Environment-dependent instructions get
   an escape clause: "if X is not available in your worktree, report and skip
   — do not seek it elsewhere."

## Rule 5

5. **ALL code changes go through a branch + worktree — even small fixes.**
   Direct-to-main commits are never acceptable. If you are about to modify
   `src/` or `presets/` and you are NOT in a worktree, STOP — create one
   first. This rule applies to the conductor implementing directly, not just
   to delegated subagents.

## Rule 6

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

## Rule 7

7. **Delegation threshold — the conductor is a project manager, not an
   implementer.** Implementation, probes/investigations, adversarial reviews,
   and code drafts go to subagents with a precise spec; the conductor holds
   sequencing, review of subagent output, rituals, and judgment calls.
   Tripwire before opening any file to implement or analyze: "could I write a
   spec for this?" — if yes, delegate it. Exceptions: tiny ritual/doc edits
   in repo docs/tools (this skill, `.development/` — tracked since #247), and tasks where the
   conductor already holds irreplaceable context (e.g. mid-review steering).

## Rule 8

8. **"Fixes #N" in commit + PR bodies.** GitHub only auto-closes issues on
   the magic keyword. "issue #N" or "part of #N" does NOT close — stale
   issues are how drift starts. Every commit/PR that fully resolves an issue
   uses `Fixes #N` (or `Closes #N`) in the body.

## Rule 9

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

## Rule 11

11. **Recurrence escalation (Rule 11).** At sprint end, count friction
    classes. Any class with ≥2 occurrences AND not resolved → P0 for the
    next sprint, with a fix direction (a P0 without a direction is anxiety,
    not a plan). The count is the truth; a "mitigated" label is a
    hypothesis — recurrence evidence overrides it.

## Rule 12

12. **Environment before theory (Rule 12).** When something breaks, check
    the environment FIRST (installed SDK version vs lockfile, extension
    sync, reload currency, the session log / run entries audit trail), THEN
    theorize about code. Ordering, not exclusivity — theory still has its
    turn. When delegating a debugging task, instruct the subagent to check
    the environment first.

## Rule 13

13. **Graph-first scoping (Rule 13).** Before writing a spec for any C1/C2
    change, the CONDUCTOR consults the knowledge graph (conductor-side only;
    subagents never see it, rule 4) for the change's NEIGHBORHOOD —
    relationships, seams (AMBIGUOUS edges), and blast radius — BEFORE grep.
    The graph is the efficiency layer for scoping (one query = the overview);
    grep remains the deterministic ground truth for exact references and
    verification. If the graph is stale (last update predates the sprint's
    commits), refresh it first. The spec includes BOTH views: the graph's
    structure + grep's exact call sites. The #114 scoping error is the
    proof-of-need: the graph already had the complete touchpoint map; the
    conductor hand-assembled it from memory + grep instead. **Checkpoint added 2026-10-10:** that failure repeated — the graph was consulted before grep only intermittently for months (an intention with no artifact decays). Every C1/C2 spec now carries a `## Recon` section produced by `recon.sh`, and its absence is visible at the spec-approval gate; a graph gap is recorded as a finding, never silently worked around.

    CodeGraph is the SOLE structural index (ADR 0016): **structural questions
    → CodeGraph** —
    `codegraph callers <symbol>` (semantic call sites),
    `codegraph impact <symbol>` (blast radius; file nodes by basename),
    `codegraph query <terms>` (symbol search), `codegraph affected <file>`
    (tests to re-run); refresh with `codegraph-refresh.sh` at every merge and
    run `codegraph-check.py` if freshness is in doubt. **Doc concept /
    cross-document questions → grep + `docs-arch` + the ADRs** — the
    deterministic fallback; graphify is retired (no LLM on the doc path).

## Rule 14

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

## Rule 15

15. **Spec environment verification (Rule 15).** Before dispatching any
    delegation, verify that every file, directory, and resource referenced
    in the spec exists in the subagent's WORKTREE (the cockpit is a different
    environment — gitignored files like `.codegraph/` and `.pi` session
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

## Rule 16

16. **User review gate (Rule 16).** No delegation beyond trivial ritual
    work (sync, reload, index refresh) may be dispatched without
    explicit user approval of the spec. The conductor presents the spec
    (or a batch), the user reviews, the user approves — THEN the conductor
    dispatches. "Looks solid" does not mean "dispatch now". This gate is
    non-negotiable; it was born from the dispatch-bypass incident (two
    unapproved dispatches in one hour, one 100+ turn loop) and held for
    every subsequent dispatch — user-approved specs ran without a single
    loop or timeout. Batched approval (one review pass over a sequence of
    specs) is the working form; mechanical wiring (approvalMode for
    delegations) is deferred unless the manual gate starts failing.

## Rule 17

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

## Rule 18

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

## Rule 19

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
      belongs in the check itself — output or docstring. `codegraph-check.py`
      prints its boundaries and reconciles symbol coverage; the #186 ratchet documents
      its evasion set and allow-list reasons.
    - **Coverage statements travel with the claim.** Any read/search-derived
      finding, report or verdict carries its coverage line (query, count/range,
      reconciliation) — and the templates that shape reports, findings and
      probes now require it (#204: at the second occurrence, in review AND
      debug output).

## Rule 20

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

## Rule 21

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

## Rule 22

**The level I pick is a line item, and it was wrong systematically.** The maintainer asked why a docs/ADR unit and a two-site extraction both ran at `high`; the honest answer was pattern-matching from a day of C1 work. The extension's own pre-flight validator is keyword-coarse — it flagged that two-site extraction as "architectural work" — so nothing in the loop pushed back.

**The backtest (2026-10-10, 98 sprint-window dispatches, $0.0034).** Blind-classified every production dispatch with TypeSafe's **Jev** classifier ("System One" — typed choice questions over JSON state, `models.classify` via `codemode`): exact agreement 47%, adjacent 87%. The disagreement is systematic, not noise — it **discounts mechanical/plumbing work** (16/40 `high` and 19/40 `medium` downgraded, including `impl-codegraph-phase1` high→low and `impl-fix315` high→minimal) and it **raises reviews** (`review-test-hygiene-r2` — the review that caught the #308 regression — high→**xhigh**; `impl-299-probe` medium→xhigh). It also ignores operational burden entirely, so its `minimal` calls would under-provision worktree/suite/PR work.

**Decision: advisory, with clamps.** Rule 22 records `jev: <level> (<conf>) · risk · worktree` in every spec/dispatch; ≥2-level deviations and below-Jev reviews need a reason; artifact work floors at `low`. Same doctrine as Rule 13: an intention with no artifact decays — the recorded line is the artifact, and the maintainer's spec approval is the gate. Phase 2 (classifier inside the extension) is deliberately unscheduled; the released package is untouched.

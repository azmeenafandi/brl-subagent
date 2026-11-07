# Handoff

> **How to use:** read §STATE → run its verify commands → work `## Open items` → follow `## Pointers`.
> §STATE is injected at session start and after every compaction by `.pi/extensions/handoff/`, with a
> `Verified:` staleness line; the write contract is `.pi/skills/handoff/references/handoff.md`.
> Historical content: `.development/HANDOFF-ARCHIVE-2026-10-17.md`, `-2026-11-06.md`, `-2026-11-07b.md` (the pre-sweep snapshot) — not current state.

## STATE
Verified: ba06e95 (2026-11-07)

- **dev** @ `ba06e95` (PR #464 merge). Merged today, in order: #457 (#440 terminal-claim eviction), #458 (#436 preset field parity), #459 (#455 survivor drain), #461 (#434 per-unit shape guard), #462 (#439 post-spawn containment), #463 (#456 Jev `--worktree` stated field), #464 (#447 acceptance marker). Docs: ADR 0023 (deadline ownership), ADR 0024 (unit projection), the #453 dossier, and `12a722e` (review-dispatch note: a bulleted `Verdict:` is invisible to the gate). Worktrees live: **`453`** (implementing).
- **Released:** **v2.7.0 LIVE** — `main` @ `98bd36e`, tag `v2.7.0`, npm `latest` 2.7.0. **Release checkpoint OPEN** (rule #6): every merged fix today (#440, #436, #455, #434, #439, and #447 when it lands) is extension code, merged and unreleased. Release on the maintainer's go only.
- **Board — autonomous bug sweep.** Closed today (7): #440, #436, #455, #434, #439, #456, #447. Open `bug`: **#453** (deadline ownership — impl running, brief revision 2 after a needs-work critique), **#460** (design-open: a never-settling branch-mode run wedges the git lock + queue; do not implement from the body). Enhancement: #426, #430. PR #402 still held.
- **Suite:** 109 files / **2333** green on dev (`--reporter=json`); typecheck clean. Budget **1.96** (48,777 test / 24,853 source, ceiling 2.0 → ~930 test lines of headroom, the ratchet is healthy again after #429/#431/#443 were thin). README says `2300+`. The `recovery.test.ts` load flake is fixed (#455) and verified under full-suite load.
- **Merge gate:** `merge-guard.sh <pr> <record>` from the **cockpit**. (a) CI runs the **merge ref** — a branch-green PR can be red on README count drift (cost #459 one cycle); (b) `#<pr>`; (c) line-start `Verdict:`; (d) reviewed head **or** `conductor-verified:`; (e) exact-text provenance match; (f) `recheck-<pr>` + its own `Risk class:`. Merge commits; PRs to `dev` never auto-close — close by hand.
- **Merge-conflict routine (three times today — #439, #447, and the CHANGELOG in general):** `dev` moves under a PR, and the conflict is **CHANGELOG.md ordering only** — keep both entries newest-first, commit the merge, re-run the gates, add a `Post-review merge:` line to the record naming the merge commit and the re-verified numbers, then re-push. The reviewed code was byte-identical in both cases.
- **Dispatch models + presets:** implementer `project-implementer` + `deepseek/deepseek-flash`; reviewer `project-reviewer` + `openrouter/meta/muse-spark-1.3-contributor`; plan critic `project-plan-critic` + `openrouter/openai/gpt-6.1-terra` + **`thinkingLevel: "medium"` always**; design investigation `project-proposer` + `inheritSystemPrompt: false`. Non-probe work: explicit `background: true` + `timeout: 7200000`.
- **Jev provenance:** print the line with `--classifier … --worktree y|n --label`, then **paste it verbatim** — never hand-type (both hand-typed lines today got the level wrong). Since #456 the `worktree` field can be **stated** (a Rule-5 process fact) and the row records `stated:worktree`, so a src dispatch no longer needs an exception; `level`/`risk` stay classifier answers. 24 exceptions remain recorded from before the fix, all in `.pi/jev-dispatch-exceptions.txt`.
- **Project flag:** `{"brl-subagent": {"processChecks": true}}` gates the Jev line, the two-arm dispatch-shape pre-flight and engineering-bar injection; fail-open, one reader.

### Since the last handover
- **Five bugs closed with measured evidence, none by assertion.** #455 was a *producer* bug (SIGKILL death sampled in the same instant as the signal — 40/40 probes alive; now a bounded drain, and both the drain **and** the grace loop are bounded twice because a no-op sleep defeated the clock bound alone). #439 contained the post-spawn tail *through result construction* and fixed a sibling-count theft (a finalize claim for an unregistered id decremented a live sibling, 1 → 0). #434 applied the pre-flight to batch units, judging the **declared** level (the capped one is `off` and would silently disable it). #436 made the preset field map a type-pinned table. #440 stopped a cap overflow from forgetting the claim it just made.
- **Every fix got a plan critique when the design was contestable, and the critiques paid:** #434 and #439 each needed **three** brief revisions (declared-vs-capped level, empty-string vs `timeout: 0` inheritance, `processChecks` re-read at a relative cwd, double notices; containment boundary through result construction, hoists, sibling accounting, non-terminal advisory). Mutants were named in every brief and killed by named tests; two reviews independently re-applied them.
- **Three subagent deaths and one stall** (connection errors): `impl-436` left the brief's M2 mutant applied in its worktree, `impl-434` left partial work, `impl-455` stalled with zero transcript output after committing. **Never trust a killed agent's worktree** — read `git diff` for a reversed condition before continuing.
- **The #453 critique found three blockers in my brief** (run-entry statuses are `running|done|failed` — no `stopped`; the timer's terminal write clears the registry and the session dir survives; and `findLast` does not stop raw-entry consumers double-counting a snapshot + amendment — measured 3 runs/$5 for a $2+$3 pair). Revision 2 adds a **logical-run projection** applied before any windowing, a `failed/timeout` snapshot, and an explicit durable-surface contract.

### Next actions
1. **#453** — impl running (xhigh, Steps 0-5 of the revision-2 brief, mutants M1-M10). C1 review next; it is the last implementable `bug`.
2. **#460** — design-open; do not implement from the body.
3. **Release checkpoint** — every fix in this sweep is extension code, merged and unreleased; the maintainer decides when.


## Open items
- **#426 design-open** — subagent timeouts: soft stage, stall watchdog vs cliff, extension, calibration. Filed 2026-11-03; no direction chosen. Do not implement from it.
- **PR #402 held** — re-evaluate only when pi's typebox pin moves off 1.3.27.
- **Watch-CI** — the `recovery.test.ts` family (#299 A1 load flake) is fixed by #455; the earlier group-empty fast-path note is superseded. The lesson stands: a load-only failure is a PRODUCT defect until a before-commit comparison proves otherwise.
- **Sweep candidates (advisory):** wire the CodeGraph freshness check into `merge-guard` (the rule is fixed, the enforcement is manual); `sprint-metrics` auto-retry accounting (it counts only explicit `retryRunId`, so transport auto-retries read as 0); `stop_subagent`'s bare not-found; Jev exceptions ↔ ledger cross-check.
- **ADR amendments pending:** 0009 (retry snapshot carries `task`), 0003 (lineage/metrics source), 0006 (slotless templates unusable).
- **Probe isolation incident (2026-11-07):** the #449 plan critique inherited the harness environment and ran a real agentic `pi` CLI against OpenRouter `anthropic/claude-fable-5` — 4 turns, **$0.0698915** — and `env | grep PI_` exposed seven `PI_*` values (none credential-shaped) to that model. Now Rule 23 in `references/rule-notes.md`: `env -i` + scratch `HOME` + scratch `PI_CODING_AGENT_DIR` + fake creds + loopback-only (`env -i` + `PI_OFFLINE=1` alone is measured insufficient), and never an agentic CLI for a source question.
- **Reviewer record format (recurring, 2 hits):** reviewers write `- Verdict: approve` as a bullet, which `merge-guard` rejects at check (c); #446 needed a conductor normalization line. Fix the preset/reference guidance to demand a **line-start** `Verdict:`, so the record clears the gate without an edit.

## Operating notes
- **CodeGraph first, no exception (Rule 13):** every exploration starts with `codegraph` (`explore`, `node`, `callers`, `callees`, `impact`, `affected`) or `recon.sh <symbol> --grep`; `grep`/`rg` only for what the graph cannot answer (prose, config, a recorded gap) — and say why. Note the index is cockpit-only, so PR-branch symbols don't resolve there.
- **Dispatch line:** with `processChecks` on, a line-less dispatch is rejected before spawn. Classify → `--classifier … --label` → paste the printed line. `jev-check --log --require-provenance` runs in the merge gate; historical misses are in `.pi/jev-dispatch-exceptions.txt`.
- **Banking:** implementation and critique briefs name `/tmp/brl-<label>-bank.md` and require incremental writes plus commit-per-step — that is what made three transport drops cost nothing this cycle.
- **Reviews:** C1 adversarial, C2 focused, C3 conductor read (Rule 10). Re-run the classifier on the dispatch text at review time (`--label recheck-<pr>`) and put `jev-recheck:` + `Risk class:` in the record. After a verdict, either re-review the new head or record `conductor-verified: <sha> — <evidence>`; a post-verdict commit with neither blocks at gate (d).
- **Mutation choice decides coverage:** name the mutant and its killer in the spec, and prefer a realistic mutant — a weak one can make a sound pin look vacuous (2026-11-06: `(meta.timeout as number)` survived a pin that `Number(meta.timeout)` killed).
- **Acceptance bars must be measurable here:** no coverage percentages (ADR 0021 §1 — no provider, and adding one is foreclosed); use a branch checklist + named mutants. A metric no tool in this repo can produce is a spec defect, not an aspiration.
- **Releases:** no calendar pressure; never propose one unprompted.
- **Gates:** `npx vitest run` · `npx tsc --noEmit` · `node scripts/docs-arch.mjs` · `node scripts/docs-decisions.mjs` · `git diff --check` · merge step 7 `codegraph-refresh.sh`.
- **Never `npm install` in the cockpit** — `worktree-prep.sh` only, and `--force-isolated` for any dependency-bump worktree. `.pi/brl-subagent/{presets,templates}` are gitignored local config, so the tracked record of a convention change lives here.

## Pointers
- `.pi/skills/worktree/SKILL.md` — lifecycle (step 0 = read §STATE), team rules 1–22, rituals, dispatch presets; `references/` holds review-dispatch, jev-advisory, engineering-bar, release-ritual, friction-log and sprint-end.
- `.pi/skills/handoff/references/handoff.md` — the §STATE write contract; `.pi/skills/pr/SKILL.md` — the PR-body contract.
- `.development/` — `ROADMAP.md`, `AUDIT.md`, `TASKS.md`, `METRICS.md`, `FRICTION_LOG.md`, `GLOSSARY.md`, `ARCHITECTURE.md`, `WORKTREE_FRAMEWORK.md`, `decisions/` (**22 ADRs**; the index is generated — `npm run docs:decisions`).
- `.development/investigations/` — specs, evidence and review findings: the complexity/CRAP measurement, `test-plan-428-…`, `plan-critique-431-…`, `serena-bakeoff-2026-11-05/`, the smell audit, the calibration log.
- `README.md` (user-facing), `AGENT.md` (delegation reference — ships in the tarball), `CHANGELOG.md` (Unreleased section; pi-parsable headings).
- Archives: `.development/HANDOFF-ARCHIVE-2026-10-17.md`, `.development/HANDOFF-ARCHIVE-2026-11-06.md`.

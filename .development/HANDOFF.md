# Handoff

> **How to use:** read §STATE → run its verify commands → work `## Open items` → follow `## Pointers`.
> §STATE is injected at session start and after every compaction by `.pi/extensions/handoff/`, with a
> `Verified:` staleness line; the write contract is `.pi/skills/handoff/references/handoff.md`.
> Historical content: `.development/HANDOFF-ARCHIVE-2026-10-17.md` — not current state.

## STATE
Verified: f1ece22 (2026-10-25)

- **dev** @ `2ff396b` — `git log -1 --oneline dev`. Only `dev` + `main`; no worktrees beyond the cockpit pair.
- **Released:** v2.6.0 LIVE (2026-10-24) — `main` @ `ef9f6be` (tag `v2.6.0`), npm `latest` = 2.6.0 — `gh release list`.
- **Running install:** the DEV checkout (dogfood — `pi list` shows the `brl-subagent-dev` path; reloaded after the sweep, so the batch prologue is live; #365's auto-retry exercised 5× on 2026-10-25). pi 1.4.0; deps `@earendil-works/*` ^1.4.0, `typebox` 1.3.27 (host pin) — `pi list`, `cat package.json`.
- **Board:** **#396 open** (`get_subagent_result` retry-lineage fix — enhancement) · **#398 open** (review briefs: structural-closure line for refactor PRs — tooling). **#364 (typebox 1.4.2) held** — the only open PR; typebox 1.4.2 verified a no-op for our surface (`typebox-1.4.2-experiment-2026-10-27.md`), held for host parity (pi 1.4.0 ships 1.3.27).
- **Sweep (from the smell audit #372): COMPLETE 6/6** — #376–#381 all merged; #379 closed with commit 4 (PR #392 `7c4c7ab`: one batch mode prologue + `resolveModeModel` tail; the 20 pins unmodified). **jscpd 10L/70t: 28 → 9 → 0 clones.** D1/D2 gone; structural guards pin the shapes.
- **Cycle (post-v2.6.0): OPEN — all work landed.** Test-suite audit (#368), P0s (#365 auto-retry, #366 Jev check), smell audit (#372), the sweep (#374), and the handoff follow-ups (#393 staleness ignore + conservative range judging, #394 extension typecheck — PR #395 `2a0142b`). **Only the release decision remains.**
- **Suite:** 90 files / 1798 — `npx vitest run`; `npx tsc --noEmit` clean. CI gates: budget guard (wall ≤ 60 s, ratio ≤ 2.0), README count, prose guard (#375), Jev ledger (#366).
- **Notification channel:** `brl-notifications-fa9@clawmail.me` (claimed) — autonomous-run decisions only; token in `~/.config/brl-notifications/clawmail.env` (never in the repo).
- **Handoff mechanism:** LIVE (PR #353) — injection + staleness line + `/handoff` + `/handoff mark`; all five live checks passed (2026-10-17/18).

### Since the last handover
- Three recurrence-guards merged (PR #397): prep smoke log retained, `merge-guard.sh` (CI + verdict + reviewed-head/disposition + dispatch audit) is now the merge gate (SKILL.md step 7), `jev-check --log` audits dispatch payloads. #396 filed for the shipped `get_subagent_result` lineage fix.
- #393/#394 merged (PR #395, two review rounds: merge/rename path holes + a truncated-stream gap, all fixed and mutation-proven). The handoff hook now ignores its own commits and judges ranges conservatively; extension code is typechecked.
- Typebox 1.4.2 experiment: a no-op for our surface; held for host parity (record: `typebox-1.4.2-experiment-2026-10-27.md`).
- Friction: `pre-dispatch Jev skipped` ×3 today (incl. the #395 fix dispatch) — the ledger-only check cannot see a skipped dispatch; `jev-check --log` proposed.

### Next actions
1. **Release v2.7.0 held until SAT 2026-10-31 / SUN 2026-11-01** (maintainer, 2026-10-27) — awaiting a possible pi release this week. If pi ships: run the **vendor-parity unit first** (release notes break-by-break, deps bump, API diff, suite, parity PR → dev), then the cycle-end ritual (Rule 11, trust metrics, env sweep, retros) and the release sequence. pi `latest` today = **1.4.0** (installed); dependabot's next visit is also 31 Oct, so the release lands after it.
2. #364 stays held until pi's typebox pin moves.
3. A `/reload` picks up the #395 handoff fix (the current session still runs the old hook).

## Open items` → follow `## Pointers`.
> §STATE is injected at session start and after every compaction by `.pi/extensions/handoff/`, with a
> `Verified:` staleness line; the write contract is `.pi/skills/handoff/references/handoff.md`.
> Historical content: `.development/HANDOFF-ARCHIVE-2026-10-17.md` — not current state.

## STATE
Verified: f1ece22 (2026-10-25)

- **dev** @ `2ff396b` — `git log -1 --oneline dev`. Only `dev` + `main`; no worktrees beyond the cockpit pair.
- **Released:** v2.6.0 LIVE (2026-10-24) — `main` @ `ef9f6be` (tag `v2.6.0`), npm `latest` = 2.6.0 — `gh release list`.
- **Running install:** the DEV checkout (dogfood — `pi list` shows the `brl-subagent-dev` path; reloaded after the sweep, so the batch prologue is live; #365's auto-retry exercised 5× on 2026-10-25). pi 1.4.0; deps `@earendil-works/*` ^1.4.0, `typebox` 1.3.27 (host pin) — `pi list`, `cat package.json`.
- **Board:** **#396 open** (`get_subagent_result` retry-lineage fix — enhancement) · **#398 open** (review briefs: structural-closure line for refactor PRs — tooling). **#364 (typebox 1.4.2) held** — the only open PR; typebox 1.4.2 verified a no-op for our surface (`typebox-1.4.2-experiment-2026-10-27.md`), held for host parity (pi 1.4.0 ships 1.3.27).
- **Sweep (from the smell audit #372): COMPLETE 6/6** — #376–#381 all merged; #379 closed with commit 4 (PR #392 `7c4c7ab`: one batch mode prologue + `resolveModeModel` tail; the 20 pins unmodified). **jscpd 10L/70t: 28 → 9 → 0 clones.** D1/D2 gone; structural guards pin the shapes.
- **Cycle (post-v2.6.0): OPEN — all work landed.** Test-suite audit (#368), P0s (#365 auto-retry, #366 Jev check), smell audit (#372), the sweep (#374), and the handoff follow-ups (#393 staleness ignore + conservative range judging, #394 extension typecheck — PR #395 `2a0142b`). **Only the release decision remains.**
- **Suite:** 90 files / 1798 — `npx vitest run`; `npx tsc --noEmit` clean. CI gates: budget guard (wall ≤ 60 s, ratio ≤ 2.0), README count, prose guard (#375), Jev ledger (#366).
- **Notification channel:** `brl-notifications-fa9@clawmail.me` (claimed) — autonomous-run decisions only; token in `~/.config/brl-notifications/clawmail.env` (never in the repo).
- **Handoff mechanism:** LIVE (PR #353) — injection + staleness line + `/handoff` + `/handoff mark`; all five live checks passed (2026-10-17/18).

### Since the last handover
- Three recurrence-guards merged (PR #397): prep smoke log retained, `merge-guard.sh` (CI + verdict + reviewed-head/disposition + dispatch audit) is now the merge gate (SKILL.md step 7), `jev-check --log` audits dispatch payloads. #396 filed for the shipped `get_subagent_result` lineage fix.
- #379 commits 3–4 merged (PRs #391/#392), each C2-reviewed (approve-with-nits with 1 informational; then approve, 0 findings).
- **The sweep closed:** #379 and #374 closed; board empty. #365's auto-retry recovered 5 transport drops today (5/5 succeeded; 0 re-work).

### Next actions
1. The two handoff follow-ups (the `Verified:` self-commit lag; `.pi/extensions/**` typechecking).
2. #364 stays held (typebox at the host pin); no release decision this cycle yet.

## Open items` → follow `## Pointers`.
> §STATE is injected at session start and after every compaction by `.pi/extensions/handoff/`, with a
> `Verified:` staleness line; the write contract is `.pi/skills/handoff/references/handoff.md`.
> Historical content: `.development/HANDOFF-ARCHIVE-2026-10-17.md` — not current state.

## STATE
Verified: 10eca8b (2026-10-25)

- **dev** @ `10eca8b` — `git log -1 --oneline dev`. Only `dev` + `main`; one worktree, `brl-subagent-wt-379-impl` (active on #379 commit 4).
- **Released:** v2.6.0 LIVE (2026-10-24) — `main` @ `ef9f6be` (tag `v2.6.0`), npm `latest` = 2.6.0 — `gh release list`.
- **Running install:** the DEV checkout (dogfood — `pi list` shows the `brl-subagent-dev` path; the dev-only transport auto-retry is live). pi 1.4.0; deps `@earendil-works/*` ^1.4.0, `typebox` 1.3.27 (host pin) — `pi list`, `cat package.json`.
- **Board:** **#374 (sweep parent) + #379 open**; the other five sweep sub-issues #376–#378, #380, #381 merged; #375 merged; **#364 (typebox 1.4.2) held** — `gh issue list`, `gh pr list`. PRs target `dev` → **`Fixes #N` does not auto-close** (close manually).
- **Sweep (from the smell audit #372):** 5/6 units merged, jscpd 28 → 9 fragments. **#379 (design-first): commits 1–3 merged** — typed resolver input (#389), 20 gate-order pins (#390), per-unit pre-pass helper (#391). **Commit 4 (batch prologue) IN FLIGHT — run `99f4e815`**: on completion verify the 20 pins **unmodified** → C2 review → merge → close #379 + #374 → records.
- **Cycle (post-v2.6.0): OPEN** — its work: test-suite audit (#368), P0s (#365 transport auto-retry, #366 Jev check), smell audit (#372), the sweep (#374). Remaining: #379 (in flight), then the two handoff follow-ups.
- **Suite:** 89 files / 1786 — `npx vitest run`; `npx tsc --noEmit` clean. Commit 4 may add tests. CI gates: budget guard (wall ≤ 60 s, ratio ≤ 2.0), README count, prose guard (#375), Jev ledger (#366).
- **Notification channel:** `brl-notifications-fa9@clawmail.me` (claimed 2026-10-25) — autonomous-run decisions only; token in `~/.config/brl-notifications/clawmail.env` (never in the repo).
- **Handoff mechanism:** LIVE (PR #353) — injection + staleness line + `/handoff` + `/handoff mark`; all five live checks passed (2026-10-17/18).

### Since the last handover
- Three recurrence-guards merged (PR #397): prep smoke log retained, `merge-guard.sh` (CI + verdict + reviewed-head/disposition + dispatch audit) is now the merge gate (SKILL.md step 7), `jev-check --log` audits dispatch payloads. #396 filed for the shipped `get_subagent_result` lineage fix.
- Test-suite audit (#368/PR #369): the CI budget guard; prune zero + one pin.
- #365 transport auto-retry (PR #370) and #366 the mechanical Jev check (PR #371) merged.
- Smell audit (#372/PR #373): no write-time coach — the spend became the sweep (#374) and the vocabulary/guide + prose guard (#375/PR #382).
- The sweep: #376/#377/#378/#380/#381 merged; #379 commits 1–3 merged; commit 4 in flight.

### Next actions
1. **Finish #379**: on `99f4e815`'s completion — verify the pins → C2 review → merge → close #379 and #374 → records. Then the sweep is 6/6.
2. The two handoff follow-ups (the `Verified:` self-commit lag; `.pi/extensions/**` typechecking).
3. #364 stays held (typebox at the host pin); no release decision this cycle yet.

## Open items
- **Handoff follow-ups (design observations from #353's review):** the `Verified:` self-commit lag (the hook could ignore the handoff's own commit in the staleness delta); `.pi/extensions/**` is not typechecked by `tsc --noEmit` (`tsconfig.include` = `src/**`).
- **Dependabot policy:** `typebox` is held at the pi host pin; future bumps are held until the host moves. No `ignore` entries (awareness preserved; #364 is the signal).
- **No other pinned backlog.** The menu cycle's carried nits and the duplication backlog were superseded by the sweep; the review records remain in `.development/investigations/`.

## Operating notes
- **Wake delivery:** background completion wakes arrive promptly when the conductor is idle, and
  queued (28–567 s) mid-turn — pi's follow-up queueing, not a defect
  (`.development/INVESTIGATION_reload_wake.md`).
- **Dispatch conventions:** implementers run the configured default at `low`; reviewers pin a model
  explicitly at `medium` (never the config default). Skill workflows that need `delegate_task` run in
  the conductor — subagents have no dispatch.
- **Reviews:** C1 adversarial (project-reviewer), C2 focused, C3 conductor read (Rule 10). **Reviewer model:
  `openrouter/meta/muse-spark-1.3-contributor`** (standing). The gpt-6-luna run was an old one-off trial and is
  closed — after a compaction, check the last dispatch artifact (subagent log / ledger row) for the current
  convention instead of trusting a summary's preference list.
- **Gates:** `npx vitest run` · `npx tsc --noEmit` · `node scripts/docs-arch.mjs` ·
  `node scripts/docs-decisions.mjs` · `git diff --check`. **Merge step 7: run `codegraph-refresh.sh`** — the
  structural index is a gate (never automatic; `codegraph-check.py` must pass: coverage + built from HEAD).
- **Never `npm install` in the cockpit** — `worktree-prep.sh` is the only provisioning path (Rule 2).
- **Jev (Rule 22):** strict — any deviation carries a one-line reason; calibration log at
  `.development/investigations/jev-calibration-log.md`.

## Pointers
- `.pi/skills/worktree/SKILL.md` — lifecycle (step 0 = read §STATE), rituals, team rules.
- `.pi/skills/handoff/references/handoff.md` — the §STATE write contract.
- `.development/` — `ROADMAP.md`, `AUDIT.md`, `TASKS.md`, `METRICS.md`, `FRICTION_LOG.md`,
  `GLOSSARY.md`, `ARCHITECTURE.md`, `decisions/` (16 ADRs).
- `.development/investigations/` — specs, evidence, review findings, calibration log.
- `README.md` (user-facing), `AGENT.md` (delegation reference), `CHANGELOG.md`.
- Archive: `.development/HANDOFF-ARCHIVE-2026-10-17.md`.

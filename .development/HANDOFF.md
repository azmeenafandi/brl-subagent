# Handoff

> **How to use:** read §STATE → run its verify commands → work `## Open items` → follow `## Pointers`.
> §STATE is injected at session start and after every compaction by `.pi/extensions/handoff/`, with a
> `Verified:` staleness line; the write contract is `.pi/skills/handoff/references/handoff.md`.
> Historical content: `.development/HANDOFF-ARCHIVE-2026-10-17.md` — not current state.

## STATE
Verified: f4e518b (2026-10-17)

- **dev** @ `f4e518b` — `git log -1 --oneline dev`. Only `dev` + `main`; no stray worktrees.
- **Released:** v2.5.2 is LIVE — `main` @ `ae7c488` (tag `v2.5.2`), npm `latest` = 2.5.2 —
  `gh release list`, `git log -1 --oneline main`.
- **Running install:** the DEV checkout (dogfood — `pi list` shows the `brl-subagent-dev` path).
  pi runtime **1.3.0**; deps `@earendil-works/*` ^1.3.0 + `typebox` 1.3.27 (the host pin) —
  `cat package.json`.
- **Board:** zero open issues — `gh issue list`.
- **Cycle `vendor parity + boundary guards`: CLOSED 2026-10-17 (v2.5.2)** — pi 1.3.0 parity
  (#338), boundary guards (#336/#339), the dangling-row fix (#340/#341), vitest 5.0.4 with
  `typebox` held at the host pin (#342). Cycle-end ritual ran before the release docs; Rule 11 = 0
  escalations.
- **Cycle `/brl-subagent` menu polish: OPEN** — all units U1–U7 merged (PRs #346–#352, last
  `e397be4`); awaits the maintainer's close/release decision (the release is the cycle's first act —
  `references/sprint-end-ritual.md`). Presentation-only, no navigation/keybinding changes.
- **In flight:** the handoff mechanism unit — `.pi/extensions/handoff/` (session_start +
  session_compact injection, `/handoff`, `/handoff mark`), `.pi/skills/handoff/`, this restructure;
  branch `feat/handoff-mechanism`; C2 focused review next. Live checks 1–5 (spec §Verification) are
  conductor-run post-merge.
- **Suite:** 78 files / 1625 tests — `npx vitest run`; `npx tsc --noEmit` clean.

### Since the last handover
- U5–U7 merged (Templates onto the Presets shell, presets parity, final sweep) — PRs #350–#352.
- Handoff mechanism spec pinned: `.development/investigations/handoff-mechanism-spec-2026-10-17.md`.
- HANDOFF restructured; the old file moved verbatim to the archive.

### Next actions
1. C2 review → merge the handoff unit → run live checks 1–5 (injection, RECONCILE, post-compaction,
   subagent inertness, worktree inertness).
2. Maintainer: decide the menu-polish cycle close + the next release version.

## Open items
- **Handoff live checks 1–5** — post-merge, conductor-run (spec §Verification).
- **U4 tier-classifier measurement** — snapshot due ~2026-10-18; a zero reading EXTENDS the window
  (`.development/investigations/u2-u3-measurement-2026-10-11.md`).
- **Dependabot policy:** `typebox` is held at the pi host pin; future bumps are held until the host
  moves. No `ignore` entries (awareness preserved).
- **Backlog (pinned, not urgent):** 4 carried U3 nits (`issue-u3-review-findings-2026-10-11.md`);
  two tests using the two-scan `waitUntil`+`findByMarker` pattern; `errorCategoryBreakdown`'s legacy
  `originalParams` field; `runDisplayName` docstring overclaim.
- **Dismissed** (2026-10-16): the parallel/graph slot-cancel `stopReason` coherence observation —
  those paths persist no run to finalize.

## Operating notes
- **Wake delivery:** background completion wakes arrive promptly when the conductor is idle, and
  queued (28–567 s) mid-turn — pi's follow-up queueing, not a defect
  (`.development/INVESTIGATION_reload_wake.md`).
- **Dispatch conventions:** implementers run the configured default at `low`; reviewers pin a model
  explicitly at `medium` (never the config default). Skill workflows that need `delegate_task` run in
  the conductor — subagents have no dispatch.
- **Reviews:** C1 adversarial (project-reviewer), C2 focused, C3 conductor read (Rule 10).
- **Gates:** `npx vitest run` · `npx tsc --noEmit` · `node scripts/docs-arch.mjs` ·
  `node scripts/docs-decisions.mjs` · `git diff --check`.
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

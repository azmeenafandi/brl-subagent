# Handoff

> **How to use:** read §STATE → run its verify commands → work `## Open items` → follow `## Pointers`.
> §STATE is injected at session start and after every compaction by `.pi/extensions/handoff/`, with a
> `Verified:` staleness line; the write contract is `.pi/skills/handoff/references/handoff.md`.
> Historical content: `.development/HANDOFF-ARCHIVE-2026-10-17.md` — not current state.

## STATE
Verified: 65721c1 (2026-10-23)

- **dev** @ `65721c1` — `git log -1 --oneline dev`. Only `dev` + `main`; no stray worktrees.
- **Released:** v2.5.2 is LIVE — `main` @ `ae7c488` (tag `v2.5.2`), npm `latest` = 2.5.2 —
  `gh release list`, `git log -1 --oneline main`.
- **Running install:** the DEV checkout (dogfood — `pi list` shows the `brl-subagent-dev` path).
  pi runtime **1.4.0** (released 2026-10-21); deps `@earendil-works/*` **^1.4.0** (parity merged, PR #360
  `a899209`, cockpit refreshed with `npm ci`); `typebox` stays **1.3.27** (the 1.4.0 host pin) — `cat package.json`.
- **Board:** zero open issues — `gh issue list`. (PRs target `dev`, so `Fixes #N` does **not** auto-close;
  #354 and #359 were closed manually. **#344 is an open PR**, not an issue.)
- **Cycle `vendor parity + boundary guards`: CLOSED 2026-10-17 (v2.5.2)** — pi 1.3.0 parity
  (#338), boundary guards (#336/#339), the dangling-row fix (#340/#341), vitest 5.0.4 with
  `typebox` held at the host pin (#342). Cycle-end ritual ran before the release docs; Rule 11 = 0
  escalations.
- **Cycle `/brl-subagent` menu polish: OPEN** — all units U1–U7 merged (PRs #346–#352, last
  `e397be4`); awaits the maintainer's close/release decision (the release is the cycle's first act —
  `references/sprint-end-ritual.md`). Presentation-only, no navigation/keybinding changes. + **footer activity indicator** (#354, PR #355 `780fb00`)
  — spinner, oldest-run elapsed, outcome-coloured completion symbols; replaces the static status text.
  + **refactor pair #356**: repaint chokepoint (#357 `ca83766`) and `showDashboard` split (#358 `1d61b36`).
- **Handoff mechanism: MERGED** (PR #353 `ca73803`) — `.pi/extensions/handoff/` (session_start +
  session_compact injection, guards, `/handoff`, `/handoff mark`), `.pi/skills/handoff/`, this
  restructure + archive. **Live checks: 1 ✅ injection · 2 ✅ RECONCILE line (the expected lag) · 4 ✅ subagent inertness (FG env=1; BG agents see no host events) · 5 ✅ worktree (unit) · 3 ✅ `/pi-vcc` post-compaction (STATE re-injected after the summary).**
- **PRs:** none open (issue tracker) · **#344 open deliberately** — typebox 1.3.37 held at the host
  pin 1.3.27 (the standalone awareness signal; no `ignore` by policy).
- **#356 CLOSED** — repaint chokepoint (#357) + `showDashboard` split (#358) merged; 5 review minors fixed.
- **Suite:** 81 files / 1685 tests — `npx vitest run`; `npx tsc --noEmit` clean.

### Since the last handover
- U5–U7 merged (Templates onto the Presets shell, presets parity, final sweep) — PRs #350–#352.
- Handoff mechanism built, reviewed (approve-with-nits → 2 minors fixed), merged `ca73803`; HANDOFF
  restructured + archived; lifecycle step 0 added (step 6→7 renumbered).
- Footer activity indicator (#354/PR #355) and the #356 refactor pair (PRs #357/#358) merged, each
  reviewed (approve-with-nits, all minors fixed); issue #356 closed.
- **pi 1.4.0 parity** merged (PR #360 `a899209`): `@earendil-works/*` ^1.4.0, **no source change**, review
  approve/0 findings (byte-identical ExtensionAPI signatures); cockpit tree refreshed to 1.4.0.

### Next actions
1. Schedule the two handoff design-observation follow-ups (self-commit lag; extension typechecking)
   — live checks 1–5 are all confirmed.
2. Maintainer: decide the menu-polish cycle close + the next release version (v2.6.0 suggested).

## Open items
- **Handoff live checks 1–5** — post-merge, conductor-run (spec §Verification).
- **Handoff follow-ups (design observations from the review):** the `Verified:` self-commit lag (the
  hook could ignore the handoff's own commit in the staleness delta); `.pi/extensions/**` is not
  typechecked by `tsc --noEmit` (`tsconfig.include` = `src/**`).
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

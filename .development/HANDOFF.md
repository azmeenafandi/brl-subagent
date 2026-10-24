# Handoff

> **How to use:** read §STATE → run its verify commands → work `## Open items` → follow `## Pointers`.
> §STATE is injected at session start and after every compaction by `.pi/extensions/handoff/`, with a
> `Verified:` staleness line; the write contract is `.pi/skills/handoff/references/handoff.md`.
> Historical content: `.development/HANDOFF-ARCHIVE-2026-10-17.md` — not current state.

## STATE
Verified: c94e1bb (2026-10-24)

- **dev** @ `c94e1bb` — `git log -1 --oneline dev`. Only `dev` + `main`; no stray worktrees.
- **Released:** **v2.6.0 LIVE (2026-10-24)** — release PR #367 merged `6f7d0aa`; bump `ef9f6be` tagged
  `v2.6.0`; publish workflow green; npm `latest` = **2.6.0** — `gh release list`, `npm view brl-subagent version`.
- **Running install:** **`npm:brl-subagent` 2.6.0** (the published package; the local-path toggle is OFF — the
  dev checkout stays on disk for the next cycle). pi runtime **1.4.0**; repo deps `@earendil-works/*`
  **^1.4.0**, `typebox` at the host pin **1.3.27** — `pi list`, `cat package.json`.
- **Board:** **#365 + #366 open** — the 2026-10-24 cycle-close P0s (transport auto-retry; mechanical Jev
  query), the next cycle's work after the audit. **Dependabot:** **#364 typebox 1.4.2 — HELD** (open PR, the
  visible signal; no `ignore`); **#363 vitest 5.0.5 — ADOPTED** (merged `0907ae1`). PRs target `dev`, so
  `Fixes #N` does **not** auto-close (close manually).
- **Cycle `vendor parity + boundary guards`: CLOSED 2026-10-17 (v2.5.2)** — pi 1.3.0 parity
  (#338), boundary guards (#336/#339), the dangling-row fix (#340/#341), vitest 5.0.4 with
  `typebox` held at the host pin (#342). Cycle-end ritual ran before the release docs; Rule 11 = 0
  escalations.
- **Cycle `menu polish + live signals`: CLOSED 2026-10-24 (v2.6.0)** — ritual ran before the release:
  metrics row 40 dispatches / 87.8%, **Rule 11 = 2 escalations** (#365 transport auto-retry; #366
  mechanical Jev query), 5 advisory sweep candidates. Units: U1–U7 (#346–#352), footer (#355),
  refactors (#357/#358), handoff (#353), pi 1.4.0 (#360), background default (#362), vitest 5.0.5 (#363).
- **Next cycle: OPEN (opens with the v2.6.0 release)** — first unit: the **test-suite audit** (budget
  pins + weak-test identification + consolidation; the suite is 1701/82 at ~17 s). Then the P0s #365/#366.
- **Handoff mechanism: MERGED** (PR #353 `ca73803`) — `.pi/extensions/handoff/` (session_start +
  session_compact injection, guards, `/handoff`, `/handoff mark`), `.pi/skills/handoff/`, this
  restructure + archive. **Live checks: 1 ✅ injection · 2 ✅ RECONCILE line (the expected lag) · 4 ✅ subagent inertness (FG env=1; BG agents see no host events) · 5 ✅ worktree (unit) · 3 ✅ `/pi-vcc` post-compaction (STATE re-injected after the summary).**
- **PRs:** **#364 open** (typebox 1.4.2 — held at the host pin 1.3.27; the visible signal, no `ignore` by
  policy; it superseded #344, which dependabot closed when it opened #364).
- **#356 CLOSED** — repaint chokepoint (#357) + `showDashboard` split (#358) merged; 5 review minors fixed.
- **delegate_task default: conditional background** (#361, PR #362 `7b3f6b9`) — omitted `background`
  resolves **background** for auto single/fan-out, **foreground** for chain/graph and `always`/`writes`;
  explicit values unchanged. The runtime background deadline (30 min) applies unless `timeout` is set.
- **Transport auto-retry: LIVE** (#365, PR #370 `509efa1`) — a background run settling with a transport-class
  failure (exit_error + transport message, **original attempt only**) auto-retries **once** with the recorded
  params (`resumeOf`/attempt 2); the source notice is suppressed in favour of a toast; a second failure surfaces.
- **Suite:** 83 files / 1719 tests (~20 s) — `npx vitest run`; `npx tsc --noEmit` clean. **Budget guard in CI:**
  wall ≤ 60 s, test:source LOC ratio ≤ 2.0 (ceilings; `scripts/check-test-budget.mjs`).

### Since the last handover
- U5–U7 merged (Templates onto the Presets shell, presets parity, final sweep) — PRs #350–#352.
- Handoff mechanism built, reviewed (approve-with-nits → 2 minors fixed), merged `ca73803`; HANDOFF
  restructured + archived; lifecycle step 0 added (step 6→7 renumbered).
- Footer activity indicator (#354/PR #355) and the #356 refactor pair (PRs #357/#358) merged, each
  reviewed (approve-with-nits, all minors fixed); issue #356 closed.
- **pi 1.4.0 parity** merged (PR #360 `a899209`): `@earendil-works/*` ^1.4.0, **no source change**, review
  approve/0 findings (byte-identical ExtensionAPI signatures); cockpit tree refreshed to 1.4.0.
- **Conditional background default** merged (#361/PR #362): approval-aware matrix, explicit-only chain/graph
  guard (strictness + ordering individually pinned), retry records the effective value; review
  approve-with-nits (2 minors fixed). CI's README test-count guard caught a stale "1600+" claim (now 1700+).
- **v2.6.0 RELEASED (2026-10-24):** release PR #367 `6f7d0aa`, bump `ef9f6be` tagged, npm staged → approved
  → `latest` = 2.6.0; **install switched back to `npm:brl-subagent`** (dev checkout removed from the install
  list); vitest 5.0.5 adopted (~17 s suite).

### Next actions
1. **Test-suite audit: DONE** (#368/PR #369) — budget guard live; prune zero + one pin; one module per cycle
   from here (see the report).
2. **#366** (mechanical Jev query) is the remaining P0.
3. Queued: the two handoff design-observation follow-ups (self-commit lag; extension typechecking).

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

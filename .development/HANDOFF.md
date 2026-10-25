# Handoff

> **How to use:** read §STATE → run its verify commands → work `## Open items` → follow `## Pointers`.
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

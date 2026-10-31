# Handoff

> **How to use:** read §STATE → run its verify commands → work `## Open items` → follow `## Pointers`.
> §STATE is injected at session start and after every compaction by `.pi/extensions/handoff/`, with a
> `Verified:` staleness line; the write contract is `.pi/skills/handoff/references/handoff.md`.
> Historical content: `.development/HANDOFF-ARCHIVE-2026-10-17.md` — not current state.

## STATE
Verified: 336fdac (2026-10-31)

- **dev** @ `336fdac` — `git log -1 --oneline dev`. Only `dev` + `main`; worktrees: the cockpit pair only.
- **Released:** v2.6.0 (2026-10-24, `main` @ `ef9f6be`, npm `latest`). **v2.7.0 proposed, NOT taken** — the cycle ritual ran (2026-10-31); the release awaits the maintainer's go, no date pressure.
- **Running install:** the DEV checkout (dogfood); pi **1.4.0**; deps `@earendil-works/*` ^1.4.0; `typebox` **1.3.27** (host pin) — `pi list`, `cat package.json`.
- **Board:** **#411** (ADR 0001: the #401 resume preamble sits inside the task fence — bug, C2/C1) · **#407** (enforce the Jev line at `delegate_task`; needs an explicit override per ADR 0007) · **#402 dependabot typebox 1.4.3 HELD** — the only open PR (host pins 1.3.27; 1.4.2 verified a no-op). #364 closed (superseded).
- **Cycle (post-v2.6.0): COMPLETE.** Audit #368; P0s #365/#366; smell audit #372; sweep #374 (6/6, jscpd 10/70 28 → 0); handoff follow-ups #393/#394; lineage #396; resume preamble #401; session retention #404; store permissions #408; gate fixes #395/#397/#399/#400/#405. **Ritual recorded** (`FRICTION_LOG`): 60 dispatches, 79.1% success, polling 0.15/dispatch; **15 auto-retries uncounted by `sprint-metrics`** (flagged).
- **Suite:** 92 files / 1849; `npx tsc --noEmit` clean. CI: budget, README count, prose guard, Jev ledger, runtime vocabulary.
- **Merge gate:** `merge-guard.sh <pr> <record>` (SKILL.md step 7) — CI + verdict + reviewed-head/disposition + dispatch audit.

### Since the last handover
- #396, #401, #404, #408 merged (PRs #406, #403, #409, #410), reviewed C2/C2/C1/C1; the plan critic caught 2 blockers on #396 and 6 majors on #404.
- ADR audit (2026-10-31): **#411 filed** (0001 × #401); ADR amendments pending (0009, 0003); the slotless-template defect fixed locally.

### Next actions
1. **v2.7.0 release** — the maintainer's go; then the release ritual (release PR dev→main, bump, tag, staged publish for approval).
2. **#411** (fence fix, C1 review) → **#407** (dispatch-line enforcement with an explicit override, per ADR 0007).
3. ADR amendments 0009/0003 + the sweep candidates.

## Open items
- **#411 · #407** (above) · **#402 held** (typebox 1.4.3 — re-evaluate only when pi's typebox pin moves).
- **Sweep candidates (advisory):** `merge-guard` check (f) CodeGraph freshness; `sprint-metrics` auto-retry accounting; `stop_subagent`'s bare not-found string; Jev exceptions ↔ ledger cross-check; plan-critic cost discipline ($0.52/run — C1/C2 plans only).
- **ADR amendments pending:** 0009 (retry snapshot now carries `task`; attempt context never recorded), 0003 (the durable agent record is the lineage source; metrics must read lineage), 0006 (a template with no `${slot}` is unusable).

## Operating notes
- **Dispatch line (Rule 22):** every dispatch carries `jev: <level> (<conf>) · Cx · worktree y|n`; manual until #407. `jev-check --log` audits it; historical misses live in `.pi/jev-dispatch-exceptions.txt` with reasons + a ledger row.
- **Banking:** implementation and plan-critique briefs name `/tmp/brl-<label>-bank.md`; commit per step. A transport auto-retry resumes from the worktree, the bank and the retained session (#401/#404).
- **Wake delivery:** wakes are prompt when idle, queued mid-turn (pi's follow-up queueing).
- **Dispatch conventions:** implementers at the configured default, `low`/`medium`; reviewers pin a model at `medium`+ (never the config default). **Reviewer model: `openrouter/meta/muse-spark-1.3-contributor`.** Plan critic: preset `project-plan-critic` (qwen3.8-max-0902, `inheritSystemPrompt: false`).
- **Releases:** no calendar pressure; do not propose one while a known fix is open.
- **Reviews:** C1 adversarial, C2 focused, C3 conductor read (Rule 10). After a verdict: re-review the new head, or record `conductor-verified: <sha> — <evidence>` for nits.
- **Gates:** `npx vitest run` · `npx tsc --noEmit` · `node scripts/docs-arch.mjs` · `node scripts/docs-decisions.mjs` · `git diff --check` · **merge step 7 `codegraph-refresh.sh`** (check (f) pending).
- **Never `npm install` in the cockpit** — `worktree-prep.sh` only (Rule 2). `.pi/brl-subagent/{presets,templates}` are gitignored local config.

## Pointers
- `.pi/skills/worktree/SKILL.md` — lifecycle (step 0 = read §STATE), rituals, team rules.
- `.pi/skills/handoff/references/handoff.md` — the §STATE write contract.
- `.development/` — `ROADMAP.md`, `AUDIT.md`, `TASKS.md`, `METRICS.md`, `FRICTION_LOG.md`,
  `GLOSSARY.md`, `ARCHITECTURE.md`, `decisions/` (16 ADRs).
- `.development/investigations/` — specs, evidence, review findings, calibration log.
- `README.md` (user-facing), `AGENT.md` (delegation reference), `CHANGELOG.md`.
- Archive: `.development/HANDOFF-ARCHIVE-2026-10-17.md`.

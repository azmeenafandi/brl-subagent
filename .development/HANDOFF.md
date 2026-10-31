# Handoff

> **How to use:** read §STATE → run its verify commands → work `## Open items` → follow `## Pointers`.
> §STATE is injected at session start and after every compaction by `.pi/extensions/handoff/`, with a
> `Verified:` staleness line; the write contract is `.pi/skills/handoff/references/handoff.md`.
> Historical content: `.development/HANDOFF-ARCHIVE-2026-10-17.md` — not current state.

## STATE
Verified: d0cc223 (2026-10-31)

- **dev** @ `d0cc223` — PR #413 merged. Only `dev` + `main`; worktrees: the cockpit pair only.
- **Released:** v2.6.0 (2026-10-24, `main` @ `ef9f6be`, npm `latest`). **v2.7.0 proposed, NOT taken** — awaiting the maintainer's go; **#411 merged after the cycle ritual**, so the running install needs a `/reload` (dev toggle) or the release.
- **Running install:** the DEV checkout (dogfood), pi **1.4.0**; deps `@earendil-works/*` ^1.4.0; `typebox` **1.3.27** (host pin).
- **Board:** **#407** (enforce the Jev line at `delegate_task`) · **#412** (three decision rules + the dispatch pre-flight + the AGENT.md boundary — **held**, one pass when the maintainer says) · **#402 dependabot typebox 1.4.3 HELD** (only open PR; host pins 1.3.27). **#411 closed** (merged #413).
- **Cycle (post-v2.6.0): COMPLETE** (ritual 2026-10-31); #411 landed after it — **release checkpoint pending** (rule 6: extension code changed).
- **Suite:** 92 files / 1855; `npx tsc --noEmit` clean; CodeGraph refreshed at `d0cc223`.
- **Merge gate:** `merge-guard.sh <pr> <record>` — CI + verdict + reviewed head/`conductor-verified:` + dispatch audit (exceptions in `.pi/jev-dispatch-exceptions.txt`).

### Since the last handover
- **#411 merged** (PR #413, `d0cc223`): the resume preamble is a `<resume-context>` system-prompt entry; the wrapped task stays byte-identical; ADR **0017** (never an edit of 0001). Plan critique `needs-work` (2 blockers, 8 majors, all fixed); C1 `approve-with-nits` (2 doc nits fixed, `conductor-verified`).
- Two silent-completion incidents: a foreground plan-critic killed at 15 min (work lost) and a C1 whose final message truncated with no verdict — both now require file-first records/banks.

### Next actions
1. **Release checkpoint** (rule 6) — `/reload` the dev toggle or fold into v2.7.0; the maintainer decides.
2. **#412** (held) — the three decision rules + the `delegate_task` pre-flight, one pass.
3. **#407** — dispatch-line enforcement with an explicit override (ADR 0007 pattern).

## Open items
- **#407 · #412 (held) · #402 held** — re-evaluate #402 only when pi's typebox pin moves.
- **Sweep candidates (advisory):** `merge-guard` check (f) CodeGraph freshness (now exercised manually each merge); `sprint-metrics` auto-retry accounting; `stop_subagent`'s bare not-found; Jev exceptions ↔ ledger cross-check; plan-critic cost discipline.
- **ADR amendments pending:** 0009 (the retry snapshot carries `task`; attempt context never recorded), 0003 (the durable agent record is the lineage source; metrics read lineage), 0006 (slotless templates are unusable).

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

# Handoff

> **How to use:** read §STATE → run its verify commands → work `## Open items` → follow `## Pointers`.
> §STATE is injected at session start and after every compaction by `.pi/extensions/handoff/`, with a
> `Verified:` staleness line; the write contract is `.pi/skills/handoff/references/handoff.md`.
> Historical content: `.development/HANDOFF-ARCHIVE-2026-10-17.md` — not current state.

## STATE
Verified: 7118862 (2026-10-31)

- **dev** @ `7118862` — PR #416 merged. Only `dev` + `main`; worktrees: the cockpit pair only.
- **Released:** v2.6.0 (2026-10-24, `main` @ `ef9f6be`, npm `latest`). **v2.7.0 NOT taken.** **Release checkpoint open.**
- **Running install:** DEV checkout (dogfood), pi **1.4.0**; deps ^1.4.0; typebox **1.3.27** (host pin). **Reloaded after #415** — the running build reads `processChecks`; live-verified both ways (a line-less cockpit dispatch is rejected; a `high` + foreground + timeout dispatch in a cwd without the manifest stays foreground).
- **Board:** **#402 held** (dependabot typebox 1.4.3; host pins 1.3.27). #407/#412/#415 closed (folded/merged).
- **Cycle (post-v2.6.0): COMPLETE**; #411/#412/#415 landed after it. **Suite:** 96 files / **1940**; tsc clean; CodeGraph fresh at `7118862`.
- **Merge gate:** `merge-guard.sh <pr> <record>` — (a) CI, (b) `#<pr>`, (c) line-start `Verdict:`, (d) head sha / `conductor-verified:`, (e) `--log --require-provenance`.
- **Dispatch models (never guess):** implementers **`deepseek/deepseek-flash`**; reviewers **`openrouter/meta/muse-spark-1.3-contributor`**; plan critic the `project-plan-critic` preset (qwen3.8-max-0902).
- **Jev provenance:** every line printed by `node .pi/skills/worktree/jev-check.mjs --line '<json>' --label <label>` (rows in `.pi/jev-lines.log`).
- **Project flag:** the cockpit's `package.json` opts in: `{"brl-subagent": {"processChecks": true}}` — the single umbrella (ADR 0019) gating the Jev line + the shape switch; fail-open; single reader (ratchet-tested). Local templates require `${jev}`; the reviewer preset allows `/tmp/REVIEW_<n>.md`.

### Since the last handover
- **#415 merged** (PR #416, `7118862`): #412's global shape switch scoped behind `processChecks`; the user path is pinned (explicit foreground + timeout stand, no notice); ADR 0019 supersedes the global scope of 0018.
- The #415 implementer's first attempt died on transport; the auto-retry resumed and completed (the #401/#404/#411 machinery, now with the system-side resume context).

### Next actions
1. **v2.7.0** — the maintainer's decision (no calendar pressure).
2. **#402 held**; the "bare `Verdict:` line" doc nit remains optional.

## Open items
- **#402 held** — re-evaluate only when pi's typebox pin moves.
- **Doc nit (optional):** `review-dispatch.md` should say a *bare* `Verdict:` line (no list bullet).
- **Sweep candidates (advisory):** `sprint-metrics` auto-retry accounting; `stop_subagent`'s bare not-found; plan-critic cost discipline; the release-ritual tarball smoke (added by #415) is not yet exercised.
- **ADR amendments still pending:** 0009 (retry snapshot carries `task`), 0003 (lineage/metrics source), 0006 (slotless templates unusable).

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

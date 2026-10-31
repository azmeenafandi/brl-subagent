# Handoff

> **How to use:** read §STATE → run its verify commands → work `## Open items` → follow `## Pointers`.
> §STATE is injected at session start and after every compaction by `.pi/extensions/handoff/`, with a
> `Verified:` staleness line; the write contract is `.pi/skills/handoff/references/handoff.md`.
> Historical content: `.development/HANDOFF-ARCHIVE-2026-10-17.md` — not current state.

## STATE
Verified: db9cd51 (2026-10-31)

- **dev** @ `db9cd51` — PR #414 merged. Only `dev` + `main`; worktrees: the cockpit pair only.
- **Released:** v2.6.0 (2026-10-24, `main` @ `ef9f6be`, npm `latest`). **v2.7.0 NOT taken.** **Release checkpoint open:** #411 + #412 are merged but the running install is stale — `/reload` (dev toggle) or the release; reload/update is ALWAYS user-triggered.
- **Running install:** the DEV checkout (dogfood); pi **1.4.0**; deps `@earendil-works/*` ^1.4.0; `typebox` **1.3.27** (host pin).
- **Board:** **#402 held** (dependabot typebox 1.4.3; host pins 1.3.27). #407 closed (folded into #412); #412 closed (merged #414).
- **Cycle (post-v2.6.0): COMPLETE**; #411 + #412 landed after it. **Suite:** 95 files / **1920**; `npx tsc --noEmit` clean; CodeGraph fresh at `db9cd51`.
- **Merge gate:** `merge-guard.sh <pr> <record>` — (a) CI, (b) `#<pr>`, (c) line-start `Verdict:`, (d) head sha / `conductor-verified:`, (e) **`--log --require-provenance`**.
- **Dispatch models (never guess):** implementers **`deepseek/deepseek-flash`**; reviewers **`openrouter/meta/muse-spark-1.3-contributor`**; plan critic the `project-plan-critic` preset (qwen3.8-max-0902).
- **Jev provenance:** every dispatch line is printed by `node .pi/skills/worktree/jev-check.mjs --line '<json>' --label <label>` (appends to `.pi/jev-lines.log`, cutoff `2026-10-31T07:54:32Z`). A hand-typed line passes the format audit but fails the merge-gate provenance check.
- **Local config (post-#412, gitignored):** the five local templates require `${jev}` (pass `params.jev`); the reviewer preset allows the `/tmp/REVIEW_<n>.md` record via bash.

### Since the last handover
- **#411 merged** (PR #413): the retry resume context is system-side (`<resume-context>`); ADR 0017.
- **#412 merged** (PR #414, `db9cd51`): rule 2's auto-switch (high/xhigh foreground + explicit timeout → background), the opt-in Jev gate (`package.json.brl-subagent.requireJevLine`), conformance vectors, the provenance log + merge-gate (e); ADR 0018; the three decision rules documented.
- Two gate bugs found by using the gate: the provenance cutoff stored a date (fixed to the creation instant, `f85857e`), and the review record's head/verdict fields were missing/bulleted (record normalized; doc tightening pending).

### Next actions
1. **Release checkpoint** — `/reload` or v2.7.0; the maintainer decides.
2. **#402 held**; the "bare `Verdict:` line (no bullet)" doc nit is optional.
3. The first post-reload dispatch exercises rule 2 and the line check for real.

## Open items
- **#402 held** — re-evaluate only when pi's typebox pin moves.
- **Doc nit (optional):** `review-dispatch.md` should say a *bare* `Verdict:` line (no list bullet) — a bullet blocked check (c) today, normalized by hand.
- **Sweep candidates (advisory):** `sprint-metrics` auto-retry accounting; `stop_subagent`'s bare not-found; plan-critic cost discipline; the pre-flight's effect on foreground template dispatches is unmeasured.
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

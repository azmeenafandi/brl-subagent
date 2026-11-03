# Handoff

> **How to use:** read §STATE → run its verify commands → work `## Open items` → follow `## Pointers`.
> §STATE is injected at session start and after every compaction by `.pi/extensions/handoff/`, with a
> `Verified:` staleness line; the write contract is `.pi/skills/handoff/references/handoff.md`.
> Historical content: `.development/HANDOFF-ARCHIVE-2026-10-17.md` — not current state.

## STATE
Verified: 940d386 (2026-11-02)

- **dev** @ `940d386` — v2.7.0 (tag `98bd36e`) plus the pi 1.5.0 parity cycle (PR #418, PR #420) and docs/tooling commits. Only `dev` + `main`; worktrees: the cockpit pair only.
- **Released:** **v2.7.0 LIVE** (2026-11-01) — `main` @ `98bd36e` (tag `v2.7.0`), npm `latest` = 2.7.0.
- **Running install:** **`npm:brl-subagent` 2.7.0**, reloaded and live in this session (dev path removed; the dev checkout stays on disk).
- **Board:** **#421 in flight** (engineering bar injected at the spawn seam; worktree `impl-421`, agent `066a38d6`) · **#402 held** (dependabot typebox 1.4.3; host pins 1.3.27). #407/#412/#415/#419 closed.
- **Cycle: `Pi 1.5.0 parity`** (opened 2026-11-02; units PR #418, PR #420 merged; #421 queued). Previous cycle closed 2026-10-31.
- **Suite:** 98 files / **1959**; `tsc --noEmit` clean; **CodeGraph freshness = `src/` unchanged since the indexed commit** (docs/tooling/records deltas are not staleness; the check names changed `src/` files when it is real).
- **Merge gate:** `merge-guard.sh <pr> <record>` — (a) CI, (b) `#<pr>`, (c) line-start `Verdict:`, (d) head sha / `conductor-verified:`, (e) `--log --require-provenance`.
- **Dispatch models + presets (never guess):** implementers — preset **`project-implementer`** (carries the SOLID/DRY bar; `dev-agent` ships without one — do not use it) + model **`deepseek/deepseek-flash`**; reviewers — preset **`project-reviewer`** + model **`openrouter/meta/muse-spark-1.3-contributor`**; plan critic — preset **`project-plan-critic`** (qwen3.8-max-0902).
- **Jev provenance:** every line printed by `node .pi/skills/worktree/jev-check.mjs --line '<json>' --label <label>` (rows in `.pi/jev-lines.log`).
- **Project flag:** `{"brl-subagent": {"processChecks": true}}` in the cockpit manifest — gates the Jev line + the shape switch; fail-open; single reader (ratchet). Local templates require `${jev}`; the reviewer preset allows `/tmp/REVIEW_<n>.md`.

### Since the last handover
- **#419 merged** (PR #420): the `noJev` bypass is validated in the handler — coerced primitives/non-strings are refused (ADR 0020 supersedes ADR 0018 §2's schema claim).
- **Tooling**: ts-ast exit-hook race fixed (green runs no longer exit 1); CodeGraph freshness now means "`src/` unchanged", not "same commit hash"; the dispatch presets are pinned in STATE + SKILL.
- **Complexity/CRAP measured** on the current tree (`.development/investigations/complexity-crap-2026-11-02.md`) — decision queued for **2026-11-06**.
- **#421 filed** from the drift audit: inject the engineering bar at spawn (tracked `.pi/` content, `processChecks`-gated, pinned both ways). The lost assumptions checklist is folded into it.

### Next actions
1. **#421** — in flight (agent `066a38d6`, worktree `../brl-subagent-421-engineering-bar`): engineering-bar file + gated injection in the shared prompt builder + both-direction pins.
2. **2026-11-06** — complexity/CRAP decision: no gate vs changed-functions advisory vs soft ceiling.
3. **#402 held**; the "bare `Verdict:` line" doc nit remains optional.

## Open items
- **#421** (in flight) · **#402 held** — re-evaluate only when pi's typebox pin moves.
- **Sweep candidates (advisory):** wire the CodeGraph freshness check into `merge-guard` as check (f) (the rule is fixed, the *enforcement* is manual); `sprint-metrics` auto-retry accounting; `stop_subagent`'s bare not-found; Jev exceptions ↔ ledger cross-check; plan-critic cost discipline.
- **ADR amendments still pending:** 0009 (retry snapshot carries `task`), 0003 (lineage/metrics source), 0006 (slotless templates unusable).

## Operating notes
- **Dispatch line:** in this repo (`processChecks`) a line-less dispatch is rejected before spawn; print every line with `--line --label` (provenance). `jev-check --log --require-provenance` runs in the merge gate; historical misses live in `.pi/jev-dispatch-exceptions.txt`.
- **Presets:** implementation = `project-implementer` (SOLID/DRY/Liskov bar); review = `project-reviewer`; plan = `project-plan-critic`. Never `dev-agent` for implementation.
- **Banking:** implementation and plan-critique briefs name `/tmp/brl-<label>-bank.md`; commit per step. A transport auto-retry resumes from the worktree, the bank and the retained session.
- **Reviews:** C1 adversarial, C2 focused, C3 conductor read (Rule 10). After a verdict: re-review the new head, or record `conductor-verified: <sha> — <evidence>` for nits.
- **Releases:** no calendar pressure; never propose one unprompted.
- **Gates:** `npx vitest run` · `npx tsc --noEmit` · `node scripts/docs-arch.mjs` · `node scripts/docs-decisions.mjs` · `git diff --check` · merge step 7 `codegraph-refresh.sh` (+ `codegraph-check.py`).
- **Never `npm install` in the cockpit** — `worktree-prep.sh` only. `.pi/brl-subagent/{presets,templates}` are gitignored local config.

## Pointers
- `.pi/skills/worktree/SKILL.md` — lifecycle (step 0 = read §STATE), rituals, team rules, dispatch presets.
- `.pi/skills/handoff/references/handoff.md` — the §STATE write contract.
- `.development/` — `ROADMAP.md`, `AUDIT.md`, `TASKS.md`, `METRICS.md`, `FRICTION_LOG.md`, `GLOSSARY.md`, `ARCHITECTURE.md`, `decisions/` (20 ADRs).
- `.development/investigations/` — specs, evidence, review findings, calibration log, the complexity/CRAP measurement.
- `README.md` (user-facing), `AGENT.md` (delegation reference), `CHANGELOG.md` (pi-parsable headings).
- Archive: `.development/HANDOFF-ARCHIVE-2026-10-17.md`.

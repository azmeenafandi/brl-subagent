## STATE
Verified: 8fee9cb (2026-11-02)

- **dev** @ `8fee9cb` — v2.7.0 (tag `98bd36e`) plus the pi 1.5.0 parity cycle: PR #418 (toolchain/changelog) and PR #420 (the `noJev` coercion guard, ADR 0020). Only `dev` + `main`; worktrees: the cockpit pair only.
- **Released:** **v2.7.0 LIVE** (2026-11-01) — `main` @ `98bd36e` (tag `v2.7.0`), npm `latest` = 2.7.0 (tarball verified; the moment it appeared, installs switched).
- **Running install:** **`npm:brl-subagent` 2.7.0** — the shipped package, reloaded and live in this session (dev path removed; the dev checkout stays on disk for the next cycle).
- **Board:** **#402 held** (dependabot typebox 1.4.3; host pins 1.3.27). #407/#412/#415 closed.
- **Suite:** 98 files / **1945**; tsc clean; release PR #417 CI green; CodeGraph fresh at `98bd36e`.
- **Merge gate:** `merge-guard.sh <pr> <record>` — (a) CI, (b) `#<pr>`, (c) line-start `Verdict:`, (d) head sha / `conductor-verified:`, (e) `--log --require-provenance`.
- **Dispatch models (never guess):** implementers **`deepseek/deepseek-flash`**; reviewers **`openrouter/meta/muse-spark-1.3-contributor`**; plan critic the `project-plan-critic` preset (qwen3.8-max-0902).
- **Jev provenance:** every line printed by `node .pi/skills/worktree/jev-check.mjs --line '<json>' --label <label>` (rows in `.pi/jev-lines.log`).
- **Project flag:** `{"brl-subagent": {"processChecks": true}}` in the cockpit manifest — gates the Jev line + the shape switch; fail-open; single reader (ratchet). Local templates require `${jev}`; the reviewer preset allows `/tmp/REVIEW_<n>.md`.

### Release checklist (v2.7.0)
- [x] Inventory + `.development/` docs (ROADMAP/AUDIT/TASKS/METRICS) on dev
- [x] Release PR #417 (dev→main) merged (`d8b375d`); dev preserved
- [x] Bump `98bd36e`; **tarball smoke passed** (user path `false` / our path `true`)
- [x] Tag `v2.7.0` pushed; dev fast-forwarded
- [x] Draft GitHub release created
- [x] Maintainer published the draft → CI staged → npm approved (tarball live)
- [x] Install switched to `npm:brl-subagent` 2.7.0; reloaded and live
- [x] STATE marked live

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
- **Cycle: `Pi 1.5.0 parity`** (opened 2026-11-02; units: PR #418, PR #420). Previous cycle (post-v2.6.0) closed 2026-10-31. **Suite:** 98 files / **1959**; tsc clean; **CodeGraph freshness = `src/` unchanged since the indexed commit** (docs/tooling/records deltas are not staleness; the check names changed `src/` files when it is real).
- **Merge gate:** `merge-guard.sh <pr> <record>` — (a) CI, (b) `#<pr>`, (c) line-start `Verdict:`, (d) head sha / `conductor-verified:`, (e) `--log --require-provenance`.
- **Dispatch models (never guess):** implementers **`deepseek/deepseek-flash`**; reviewers **`openrouter/meta/muse-spark-1.3-contributor`**; plan critic the `project-plan-critic` preset (qwen3.8-max-0902).
- **Jev provenance:** every line printed by `node .pi/skills/worktree/jev-check.mjs --line '<json>' --label <label>` (rows in `.pi/jev-lines.log`).
- **Project flag:** the cockpit's `package.json` opts in: `{"brl-subagent": {"processChecks": true}}` — the single umbrella (ADR 0019) gating the Jev line + the shape switch; fail-open; single reader (ratchet-tested). Local templates require `${jev}`; the reviewer preset allows `/tmp/REVIEW_<n>.md`.

### Since the last handover
- **CodeGraph freshness rule fixed** (`1589997`, docs `13a4f95`): a docs/tooling commit after a sync no longer flags the index as stale — the check compares `src/**/*.ts` (minus tests) between the indexed commit and HEAD, fails closed on an uncomputable delta, and lists the changed source files when the drift is real. Verified both ways (live docs-only pass; a doctored-DB `src/` delta fails with `src/schema.ts`, `src/validate.ts`).
- **#419 merged** (PR #420, `8fee9cb`): the `noJev` bypass is read through a handler-level runtime guard — non-strings and coerced primitives are refused (no bypass, no TypeError); ADR 0020 supersedes ADR 0018 §2's schema-layer claim. The ts-ast exit-hook race that made green runs exit 1 and blocked a worktree pre-flight is fixed (`5761736`).
- **pi 1.5.0 parity merged** (PR #418, `2e0ead2`): devDeps `^1.5.0`; the CHANGELOG's 26 version headings converted to pi-parsable `## [X.Y.Z] - date` (pi 1.5.0's "Extension Updates" notice; verified: the real parser now reads 26 entries, newest 2.7.0); two ratchets — changelog heading vs package version, and JSON-Schema-only tool schemas (pi-schema ignores TypeBox features outside JSON Schema). #402 stays held: pi 1.5.0 still bundles typebox 1.3.27.
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

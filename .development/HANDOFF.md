# Handoff

> **How to use:** read §STATE → run its verify commands → work `## Open items` → follow `## Pointers`.
> §STATE is injected at session start and after every compaction by `.pi/extensions/handoff/`, with a
> `Verified:` staleness line; the write contract is `.pi/skills/handoff/references/handoff.md`.
> Historical content: `.development/HANDOFF-ARCHIVE-*.md` — not current state.

## STATE

Verified: a2c8700 (2026-11-20)
Cycle: **timeout-guidance OPEN** (declared 2026-11-18) — U1 = **#426 E** (the portable timeout guidance + the reference-workload table; "safe for everyone"). The spec is committed with the round-4 fixes (5 findings applied); the implementation is in flight in `feat/timeout-guidance`; no code merged yet. The `preflight-debt` cycle closed 2026-11-18 (U1 #537; close row in `FRICTION_LOG.md`).
- **dev** @ `a2c8700`. The closed cycle's merged unit: #539 (#537: the pre-flight capability rows — write/create `anyOf [write, bash]`, edit `anyOf [write, edit, bash]`, delete `requiredTools [bash]`; review `muse-ember`); the cycle close is the docs commit `f5fe4f9`. The `timeout-guidance` worktree is `../brl-subagent-timeout-guidance` (`feat/timeout-guidance`); the cockpit pair remains `main` + `dev`.
- **Released:** **v2.9.0 LIVE** (2026-11-14) — tag `v2.9.0` at `485c761`, npm `latest` 2.9.0, published-build parity 82/82. **#539 is merged and dogfooded but NOT in the published tarball**; the post-2.9.0 release is the maintainer's call.
- **Running install:** **local-path dev checkout** on pi **1.6.0** (this repo, `dev @ a2c8700`; the code is `6be93bd`) — dogfooded 2026-11-18: the probe dispatch (bash-bearing, `write`/`edit` excluded, five trigger words) returned **zero pre-flight warnings**. Revert: `pi remove <dev path>` → `pi install npm:brl-subagent` → `/reload`.
- **Board:** #537 closed by #539. Open: **#533** (P0: friction reconstructed at close), **#450** (harden: background settle handlers), **#426** (design-open: timeout follow-ups). **PR #536** (dependabot typebox 1.3.27 → 1.4.6) held — the pin crosses the extension↔harness boundary; re-evaluate when pi's pin moves.
- **Suite:** 142 files / **3035** green (3034 passed + 1 skipped); typecheck clean; docs guards current (**60 modules**, **28 ADRs**); budget **src 1.96 · scripts 0.77**, floors **60/60 · 13/13**; each PR's flow is enforced by gate (g). `index.ts` 356; `tui.ts` 3,240; `delegate-handler.ts` 2,261; `mode-runners.ts` 1,575; `background-pipeline.ts` 1,025; `terminal-notifier.ts` 405; `agent-tools.ts` 332; `boot-recovery.ts` 313; `commands.ts` 137; `worktree-report.ts` 142; `runtime.ts` 50; `unit-params.ts` 113.
- **Merge gate:** `merge-guard.sh <pr> <record>` from the **cockpit**; (a) CI (a conflict reads `no checks reported`), (b) `#<pr>`, (c) bare line-start `Verdict:`, (d) reviewed head or `conductor-verified:`, (e) provenance, (f) `recheck-<pr>` + `Risk class:`, (g) flow (cockpit copy) + body-block recompute (`pr-evidence --check`). Merge commits, never squash; PRs to `dev` never auto-close. A handoff commit touches only `.development/HANDOFF*`.
- **Dispatch models:** implementer `project-implementer` + `deepseek/deepseek-flash`; reviewer `project-reviewer` + `openrouter/meta/muse-ember`; plan critic `project-plan-critic` + `openrouter/openai/gpt-6.1-terra` + `thinkingLevel: medium` always; design `project-proposer` + `inheritSystemPrompt: false`. Non-probe: explicit `background: true` + `timeout: 7200000`.
- **Jev:** classify blind → `jev-check --classifier … --worktree y|n --label <name>` → paste the line; the record's recheck row is `recheck-<pr>`; `--settle` the outcomes. `level` is an observation; `worktree` is stated.
- **Project flag:** `{"brl-subagent": {"processChecks": true}}` gates the Jev line, the dispatch-shape pre-flight and the engineering bar (fail-open).

### Since the last handover
- **The `timeout-guidance` cycle opened 2026-11-18** — U1 = #426 E; the direction and placement are locked (the portable principle in the prompt, the reference table in `AGENT.md`, the "safe for everyone" scope); the spec is committed at `a2c8700` with the round-4 fixes (the plan-critique loop stopped at round 4); the `feat/timeout-guidance` worktree is open; the implementer is dispatched (`timeout-guidance-impl`).
- **pi 1.6.0 render-compat plan saved 2026-11-20** — the one breaking change (pi-tui `render()` `readonly` + `Container` cached lines) hits three TUI render sites; the timeout spec is unaffected. Plan at `.development/investigations/pi-1.6.0-render-compat-plan-2026-11-20.md`; scheduled after this cycle.
- **The `preflight-debt` cycle closed 2026-11-18.** U1 #537 (PR #539) merged at `6be93bd`, reviewed approve-with-nits, dogfooded (zero warnings), and the close ritual ran: **5 dispatches (1 fg / 4 bg), 5/5 settled (100%), Δ 0, 0.8 polls/dispatch, 0 steer/stop**; **Rule 11** — the #533 class recurrence #5 (already P0), the handoff's four stale claims ×1 class resolved in-cycle, the CodeGraph staleness carried; **environment sweep** — five candidates, led by a `handoff-verify` size guard and CodeGraph freshness in `merge-guard`. The full row is in `FRICTION_LOG.md`; spec at `.development/investigations/issue-537-preflight-capability-rows-spec-2026-11-18.md`.

### Next actions
1. **The `timeout-guidance` cycle is open (U1 = #426 E).** The spec is committed at `a2c8700`; the `feat/timeout-guidance` worktree is open; the implementation is in flight (implementer `timeout-guidance-impl`); the PR/review follows. No code merged yet. The open board — **#533** (P0 process/tooling), **#450** (hardening, direction open), **#426** (design-open; E is the unit, B/C/D trigger-parked) — remains as before; #450 stays unimplemented until a priority is recorded.
2. **Release:** the post-2.9.0 code (#539) is merged and dogfooded but not in the published tarball — cut the next release on the maintainer's go (no version proposed here).
3. **Follow-ups with no issue yet:** the pi 1.6.0 render compat (plan saved — three copies in the TUI file, optional pi devDeps bump; do after this cycle; typebox #536 stays held); the v2.9.0-prep recovery survivor-report flake (load-only; ownership before group-emptiness in `verifyDeath` + an unknown-scan test); `spawnBackgroundSession` size; the shared `vi.mock("../git")` fixture; the `branch-lock.ts` extraction; the budget ceiling; the merge gate's (g) block half still executing the PR tree's `pr-evidence` (unfiled C1).

## Open items
- **#533 P0** — friction reconstructed at close, never logged live (recurrence #5 at the `preflight-debt` close); the fix is mechanical (derive the cycle's friction candidates at close from the Jev ledger / session log). Cycle-independent.
- **#450 direction-open** — background settle handlers before the prompt; re-scoped 2026-11-14; no implementation until a priority is recorded.
- **#426 design-open** — subagent timeouts: soft stage, stall watchdog vs cliff, extension, calibration. Filed 2026-11-03; no direction chosen. Do not implement from it.
- **PR #536 held** — dependabot typebox 1.3.27 → 1.4.6; the pin crosses the extension↔harness boundary. Re-evaluate only when pi's pin moves.
- **ADR amendments pending:** 0009 (retry snapshot carries `task`), 0003 (lineage/metrics source), 0006 (slotless templates unusable).
- **Sweep candidates (advisory):** wire the CodeGraph freshness check into `merge-guard`; `sprint-metrics` auto-retry accounting (only explicit `retryRunId`); `stop_subagent`'s bare not-found; the Jev exceptions ↔ ledger cross-check; the `handoff-verify` size guard (the 60 KB handoff); `diagnoseFailure` Rule 4's missing bash awareness.

## Operating notes
- **CodeGraph first, no exception (Rule 13):** every exploration starts with `codegraph` (`explore`, `node`, `callers`, `callees`, `impact`, `affected`) or `recon.sh <symbol> --grep`; `grep`/`rg` only for what the graph cannot answer (prose, config, a recorded gap) — and say why. The index is cockpit-only.
- **Dispatch line:** with `processChecks` on, a line-less dispatch is rejected before spawn. Classify → `--classifier … --label` → paste the printed line. `jev-check --log --require-provenance` runs in the merge gate.
- **Banking:** the run's bank is `<root>/runs/<id>/bank.md` under the private scratch root (`~/.cache/brl-subagent`; never `/tmp`); implementation and critique briefs require incremental writes.
- **Reviews:** C1 adversarial, C2 focused, C3 conductor read (Rule 10). Re-run the classifier on the dispatch text at review time (`--label recheck-<pr>`) and put `jev-recheck:` + `Risk class:` in the record. After a verdict, either re-review the new head or record `conductor-verified: <sha> — <evidence>`.
- **Mutation choice decides coverage:** name the mutant and its killer in the spec; prefer a realistic mutant — a weak one can make a sound pin look vacuous.
- **Acceptance bars must be measurable here:** no coverage percentages (ADR 0021 §1); use a branch checklist + named mutants.
- **Releases:** no calendar pressure; never propose one unprompted.
- **Gates:** `npx vitest run` · `npx tsc --noEmit` · `node scripts/docs-arch.mjs` · `node scripts/docs-decisions.mjs` · `git diff --check` · merge step 7 `codegraph-refresh.sh`.
- **Never `npm install` in the cockpit** — `worktree-prep.sh` only, `--force-isolated` for a dependency bump. The dispatch contract under `.pi/brl-subagent/` (presets, templates, README) is **tracked** since #514; `state.json` stays local.

## Pointers
- `.pi/skills/worktree/SKILL.md` — lifecycle (step 0 = read §STATE), rules, rituals, dispatch presets; `references/` holds review-dispatch, jev-advisory, engineering-bar, release-ritual, friction-log and sprint-end.
- `.pi/skills/handoff/references/handoff.md` — the §STATE write contract; `.pi/skills/pr/SKILL.md` — the PR-body contract.
- `.development/` — `ROADMAP.md`, `AUDIT.md`, `TASKS.md`, `METRICS.md`, `FRICTION_LOG.md`, `GLOSSARY.md`, `ARCHITECTURE.md`, `WORKTREE_FRAMEWORK.md`, `decisions/` (**28 ADRs**; the index is generated — `npm run docs:decisions`).
- `.development/investigations/` — specs, evidence and review findings: `issue-537-preflight-capability-rows-spec-2026-11-18.md`, `issue-426-timeout-guidance-spec-2026-11-18.md`, `pi-1.6.0-render-compat-plan-2026-11-20.md`, the complexity/CRAP measurement, `test-plan-428-…`, `plan-critique-431-…`, `serena-bakeoff-2026-11-05/`, the smell audit, the calibration log.
- `README.md` (user-facing), `AGENT.md` (delegation reference — ships in the tarball), `CHANGELOG.md` (Unreleased section; pi-parsable headings).
- Archives: `.development/HANDOFF-ARCHIVE-2026-10-17.md`, `-2026-11-06.md`, `-2026-11-07b.md`, `-2026-11-08.md`, `-2026-11-08b.md`, `-2026-11-18.md`.

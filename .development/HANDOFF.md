# Handoff

> **How to use:** read §STATE → run its verify commands → work `## Open items` → follow `## Pointers`.
> §STATE is injected at session start and after every compaction by `.pi/extensions/handoff/`, with a
> `Verified:` staleness line; the write contract is `.pi/skills/handoff/references/handoff.md`.
> Historical content: `.development/HANDOFF-ARCHIVE-2026-10-17.md` — not current state.

## STATE
Verified: 1d1c526 (2026-11-06)

- **dev** @ `1d1c526` (after the #428 merge `3b668dc`; #425 at `87ac4ee`) — v2.7.0 (tag `98bd36e`) plus the pi 1.5.0 parity cycle (PR #418, PR #420, PR #422 merged as merge commits). Only `dev` + `main`; worktrees: the cockpit pair + `../brl-subagent-431-preflight-arm` (`fix/431-preflight-second-arm`).
- **Released:** **v2.7.0 LIVE** (2026-11-01) — `main` @ `98bd36e` (tag `v2.7.0`), npm `latest` = 2.7.0. **Release checkpoint OPEN**: #422 is extension code merged and unreleased.
- **Running install:** **the dev checkout** (`pi install /…/brl-subagent-dev`), live after a reload — the npm 2.7.0 copy was removed (never two). It includes #422 (bar injection) and #425 (deadline visibility); reloaded and live-verified. Users still get published 2.7.0.
- **Board:** **#423 merged** (PR #425, `87ac4ee`; #426 tracks the surviving candidates B–E) · **#427 Serena bake-off closed** (findings + addendum in `.development/investigations/serena-bakeoff-2026-11-05/`) · **#428 merged** (PR #432, `3b668dc`) · **#429/#430 open** (CRAP follow-ups) · **#431 in implementation** (spec v2 after the C1 critique; implementer `04c6a41f`) · **#433 folded into #431** · **#434 open** (per-unit pre-flight bypass, deferred from #431) · **#421 closed** (PR #422, `ce63df2`) · **#402 held** (dependabot typebox 1.4.3; host pins 1.3.27). #407/#412/#415/#419 closed.
- **Cycle: `Pi 1.5.0 parity`** — closed 2026-11-03 (units PR #418, PR #420, PR #422). Previous cycle closed 2026-10-31.
- **Suite:** 101 files / **2138**; `tsc --noEmit` clean; CodeGraph refreshed at `3b668dc` (549 exports, coverage complete). **Release checkpoint OPEN**: #422 + #425 are extension code merged and unreleased (the dev install is live; users get 2.7.0). #428 is tests + test-facing exports only — no functional change, not a release item.
- **Merge gate:** `merge-guard.sh <pr> <record>` — (a) CI, (b) `#<pr>`, (c) line-start `Verdict:`, (d) head sha / `conductor-verified:`, (e) `--log --require-provenance`, (f) `jev-recheck:` + `Risk class:` with a `recheck-<pr>` provenance row and a tier no weaker than the recheck. PRs to `dev` do not auto-close issues — close by hand.
- **Dispatch models + presets (never guess):** implementers — preset **`project-implementer`** (carries the SOLID/DRY bar; `dev-agent` ships without one — do not use it) + model **`deepseek/deepseek-flash`**; reviewers — preset **`project-reviewer`** + model **`openrouter/meta/muse-spark-1.3-contributor`**; plan critic — preset **`project-plan-critic`** (qwen3.8-max-0902); design second opinions — `project-proposer`, `inheritSystemPrompt: false`.
- **Jev provenance:** run the classifier via codemode (`~typesafe/jev-latest`, blind), then `node .pi/skills/worktree/jev-check.mjs --classifier '<raw answers>' --label <label>` (rows in `.pi/jev-lines.log`). `--line --label` is refused without `--legacy-line` — format-only input cannot claim a classifier.
- **Project flag:** `{"brl-subagent": {"processChecks": true}}` in the cockpit manifest — now gates three mechanisms: Jev line, shape switch, engineering-bar injection (ADR 0019 addendum); fail-open; single reader (ratchet). Local templates require `${jev}`; the reviewer preset allows `/tmp/REVIEW_<n>.md`.

### Since the last handover
- **#421 merged** (PR #422, `ce63df2`): a tracked `.pi/skills/worktree/references/engineering-bar.md` is injected as `<engineering-bar>` at **both** seams (background `appendSystemPrompt` after `<resume-context>`; foreground `--append-system-prompt` at `runSubagent`) behind `processChecks`; 17 tests pin both directions, incl. "disabled → the file is never read" and the packed tarball excludes it. ADR 0019 carries an addendum + falsifier (first real third-party setter → split the field). No adversarial review was dispatched (maintainer instruction); a C2 conductor verification cleared it, and an independent glm-5.3 design opinion recommended keeping the umbrella. **Live-verified on the dev build:** a `dev-agent` probe reported the injected section; after trimming the duplicated bar text from the local `project-implementer`/`project-reviewer` presets, a `project-implementer` probe still reported it (and the old preset heading was gone) — the bar now arrives solely through the injection.
- **#419 merged** (PR #420): the `noJev` bypass is validated in the handler — coerced primitives/non-strings are refused (ADR 0020 supersedes ADR 0018 §2's schema claim).
- **Tooling**: ts-ast exit-hook race fixed; CodeGraph freshness now means "`src/` unchanged"; the dispatch presets are pinned in STATE + SKILL. **CodeGraph-first is now Rule 13 for ALL exploration**; `recon.sh --explore` + the command cheat-line + the ADR 0015 addendum landed in `9a07273` (#424).
- **#423 merged** (PR #425, `87ac4ee`): the budget is visible on the footer (`ran:` / `deadline in`), monitor and dashboard (per-row `elapsed / budget`, deadline order, settled rows filtered, drill-in identity via the painted list), and result/wake (`Budget: … used, … left` / `(exhausted)` on timeout evidence). C1 review approve-with-nits; both nits fixed in `a94af63`; the new merge check **(f)** cleared its first real merge (provenance-bound `jev-recheck:` + tier). **Live-verified after `/reload`:** two concurrent probes (3 m / 8 m) printed `Budget: 3m — 2m 18s used, 42s left` and `Budget: 8m — 2m 2s used, 5m 58s left` (the 3 m one also showed its budget mid-run), and the maintainer confirmed the footer's `ran:`/`deadline in` and the monitor's deadline order.
- **Serena bake-off (#427, 2026-11-05): parked.** LSP-backed Serena (16 s setup; 5–6 s/query) does answer what CodeGraph structurally cannot — type-position references, implementations, bash symbols — but adoption creates a second "what references this?" lane, which is the ambiguity ADR 0016 closed. No dependency added; scratch + tool uninstalled; findings + reopen trigger recorded. **Addendum (docs review):** the bake-off measured the classic `--agent-interface tools`; v2's REPL (composition, context economy) is untested, so the 5–6 s/query and 1.8–3 k-char costs are interface-specific. Editing tools (rename, safe delete, symbol diagnostics, dry-run `replace_in_files`) were not evaluated; `--tools` does **not** remove MCP tools (`--exclude-tools 'mcp__*'`/`--no-mcp` required). **If the complexity decision starts refactoring, run the refactoring bake-off first.**
- **Complexity/CRAP decided (2026-11-06): A** — no CRAP gate, smell vocabulary unchanged (ADR 0021). The three genuine findings are scheduled: #428 tests for `skipJsonValue` (7% cov), #429 tests for `resolveSubagentParams` (61%), #430 behavior-preserving `execute` split (116 cx). Falsifier: a changed-function regression that escapes review → adopt B (report-only, TUI-excluded).
- **#428 merged** (PR #432, `3b668dc`): the plan critic returned AMEND (90% coverage unmeasurable under ADR 0021; escape mutation invisible to end-only assertions; no defined malformed-input contract; caller-level mutant unreachable from scanner tests). All six decisions adopted (D1–D5 + seam), ~60-case A–G matrix + 5 mutation kills, `readJsonStringAt`/`skipJsonValue`/`scanTopLevelScalars` exported test-facing with JSDoc contracts, lineage fixture extended with a nested payload. Review approve-with-nits; both nits fixed (`c000947`) and conductor-verified. Suite +95 tests (2043 → 2138).

### Next actions
1. **#431 (+#433) in implementation** — design **B** (drop the deadline, keep the approval gate). C1 plan critique returned **AMEND** (0 blocking / 9 major / 5 minor; `.development/investigations/plan-critique-431-2026-11-06.md`) and design B was upheld, including the budget-cap objection — the cover (processChecks opt-in, notice, `force`, Rule 18) is adequate but ADR 0022 must **name** the objection and the hang trade-off, not inherit ADR 0018's rationale. Spec v2 in the issue body absorbs D1–D6 + mutants M1–M13 + acceptance A–G; #434 filed for the per-unit bypass. Implementer `04c6a41f` (background, 2h, thinking `high` — classifier said medium, +1 for C1 subtlety). Worktree `../brl-subagent-431-preflight-arm` ff'd to `1d1c526`. Next: **C1 adversarial review** → merge-guard → maintainer merge call. **Policy call made by the conductor, maintainer may veto:** `retryOnTimeout` becomes inert on the drop arm — decided "drop anyway" (a foreground timeout retry restarts from zero), recorded per ADR 0022(f).
2. **#429 → #430** — remaining CRAP follow-ups. **#429's acceptance bar is broken** (`≥90% statement` is unmeasurable here and contradicts ADR 0021 §1) — amend before dispatch.
3. **#426 design-open** — timeout follow-ups (soft stage, stall watchdog, extension, calibration); no priority recorded yet.
4. **#402 held** (dependabot typebox; host pins 1.3.27); the "bare `Verdict:` line" doc nit remains optional. **Release checkpoint OPEN** — a 2.7.1/2.8.0 cut is available when wanted.

## Open items
- **#426 design-open** — subagent timeouts: visible budget, soft stage, stall watchdog vs
  cliff, extension, calibration. Filed 2026-11-03 from a discussion; no direction chosen
  (the maintainer is deciding the priority order). Do not implement from it yet.
- **#402 held** — re-evaluate only when pi's typebox pin moves.
- **Sweep candidates (advisory):** wire the CodeGraph freshness check into `merge-guard` as check (f) (the rule is fixed, the *enforcement* is manual); `sprint-metrics` auto-retry accounting; `stop_subagent`'s bare not-found; Jev exceptions ↔ ledger cross-check; plan-critic cost discipline.
- **ADR amendments still pending:** 0009 (retry snapshot carries `task`), 0003 (lineage/metrics source), 0006 (slotless templates unusable).

## Operating notes
- **CodeGraph first, no exception:** every code-exploration task starts with `codegraph`
  (`explore`, `node`, `callers`, `callees`, `impact`, `affected`); `grep`/`rg` only when the
  graph cannot answer (a text/prose/config pattern, or a gap recorded as a finding) — and say why.
- **Dispatch line:** in this repo (`processChecks`) a line-less dispatch is rejected before spawn; print every line with `--line --label` (provenance). `jev-check --log --require-provenance` runs in the merge gate; historical misses live in `.pi/jev-dispatch-exceptions.txt`.
- **Presets:** implementation = `project-implementer` (SOLID/DRY/Liskov bar); review = `project-reviewer`; plan = `project-plan-critic`. Never `dev-agent` for implementation.
- **Banking:** implementation and plan-critique briefs name `/tmp/brl-<label>-bank.md`; commit per step. A transport auto-retry resumes from the worktree, the bank and the retained session.
- **Reviews:** C1 adversarial, C2 focused, C3 conductor read (Rule 10). **Before dispatching one, re-run the classifier on the dispatch text** and print it `jev-check --classifier '<raw answers>' --label recheck-<pr>`; the record carries `jev-recheck:` + `Risk class:` (merge check (f) refuses a weaker tier). After a verdict: re-review the new head, or record `conductor-verified: <sha> — <evidence>` for nits.
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

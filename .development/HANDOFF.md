# Handoff

> **How to use:** read §STATE → run its verify commands → work `## Open items` → follow `## Pointers`.
> §STATE is injected at session start and after every compaction by `.pi/extensions/handoff/`, with a
> `Verified:` staleness line; the write contract is `.pi/skills/handoff/references/handoff.md`.
> Historical content: `.development/HANDOFF-ARCHIVE-2026-10-17.md` and `-2026-11-06.md` — not current state.

## STATE
Verified: 6be07d0 (2026-11-06)

- **dev** @ `6be07d0` (#429 plan + critique docs; last code merge `fb0991f` = PR #435) — `git log -1 --oneline dev`. Branches `dev` + `main` only; worktrees are the cockpit pair only — `git worktree list`.
- **Released:** **v2.7.0 LIVE** (2026-11-01) — `main` @ `98bd36e`, tag `v2.7.0`, npm `latest` 2.7.0 (`gh release list`). **Release checkpoint OPEN** (rule #6): **#422 + #425 + #435** are extension code, merged and unreleased. Release on the maintainer's go only — never propose a version unprompted.
- **Running install:** the **dev checkout** (`pi list`), reloaded by the maintainer on 2026-11-06 — so the process now carries #422 (bar injection), #425 (budget visibility) and #435 (pre-flight drop arm). All three live-verified (#435 on 2026-11-06 via both drop-arm probes — `grep "timeout dropped" .pi/subagent-logs/brl-subagent.log`). **#437 hazard while open:** every `/new` silently kills background completion wakes — run `/reload` after `/new` before relying on them, or poll `get_subagent_result`. Users get published 2.7.0.
- **Board** (`gh issue list`): open **#429** (`resolveSubagentParams` tests — amended + critiqued, verdict needs-work, acceptance finalization pending), **#437** (completion-push stale-ctx after `/new` — filed 2026-11-06), **#430** (`execute` split), **#434** (per-unit pre-flight bypass), **#436** (preset frontmatter field parity), **#426** (timeout design-open); **PR #402** held (typebox 1.4.3 vs the host's 1.3.27 pin). Merged 2026-11-06: #428 (PR #432), #431 + #433 (PR #435).
- **Cycle:** `Pi 1.5.0 parity` closed 2026-11-03; none open. The current thread is the CRAP follow-ups (#429, #430) from ADR 0021.
- **Suite:** 101 files / **2152** (`npx vitest run`, verified on dev at the merge); `npx tsc --noEmit` clean; CodeGraph complete at `6be07d0` (docs-only delta since the merge), 551 exports (`python3 .pi/skills/worktree/codegraph-check.py`).
- **Merge gate:** `merge-guard.sh <pr> <record>` — (a) CI, (b) `#<pr>`, (c) line-start `Verdict:`, (d) reviewed head or a `conductor-verified:` line, (e) `--log --require-provenance`, (f) a provenance-bound `jev-recheck:` + a `Risk class:` no weaker. PRs to `dev` never auto-close issues — close by hand. Merge commits, never squash.
- **Dispatch models + presets (never guess; after a compaction verify against `.pi/subagents/*.json`):** implementer = `project-implementer` + `deepseek/deepseek-flash` (never `dev-agent` — it ships no quality bar); reviewer = `project-reviewer` + `openrouter/meta/muse-spark-1.3-contributor`; plan critic = `project-plan-critic` + **`openrouter/openai/gpt-6.1-terra`** (STANDING since 2026-11-06 by maintainer instruction; supersedes `qwen/qwen3.8-max-0902`, which is **not** a fallback); design second opinions = `project-proposer` + `inheritSystemPrompt: false`. Presets cache at `session_start` (`src/index.ts:4000`), so a preset edit needs `/reload` or `/new`; a per-call `model:` overrides the cache.
- **Dispatch shape — never rely on the conditional default:** non-probe work gets explicit `background: true` + `timeout: 7200000` (the 2 h maintainer cap). Foreground is only for a probe whose answer the next step needs inline, and then **omit the timeout** — foreground has no default cap, and a foreground deadline destroys the run (the 2026-11-06 600 s loss). ADR 0022's drop arm mechanizes this for high/xhigh under `processChecks` only; it cannot help a `medium` dispatch.
- **Jev provenance:** classify blind via codemode (`~typesafe/jev-latest`), then `node .pi/skills/worktree/jev-check.mjs --classifier '<raw answers>' --label <label>` (rows land in `.pi/jev-lines.log`). `--line --label` is refused without `--legacy-line` — a hand-typed line cannot claim a classifier.
- **Project flag:** `{"brl-subagent": {"processChecks": true}}` in the cockpit manifest gates three mechanisms — the Jev dispatch line, the two-arm dispatch-shape pre-flight (ADR 0018 + 0022), and engineering-bar injection (ADR 0019). Fail-open; one reader.

### Since the last handover
- **#428 merged** (PR #432, `3b668dc`): the shallow JSON identity reader is pinned — 93 tests over the A–G matrix, three functions exported test-facing with JSDoc contracts, the lineage fixture extended with a nested payload. Suite 2043 → 2138.
- **#431 + #433 merged** (PR #435, `fb0991f`): the pre-flight gained a second arm. Where a background run is impossible (`always`) or the omitted-`background` default keeps a `writes`/`always` run foreground, it **drops the explicit timeout instead of switching shape**, so the approval gate never moves; the same rule closed a bug where the switch turned a valid `background:false` + `always` dispatch into a rejection. ADR 0022 supersedes ADR 0018's omitted-background exemption and records the budget-cap and hang trade-offs. Suite → 2152. C1 review: 1728-cell predicate cross-product, 0 mismatches; 13 mutants re-applied, 0 survivors.
- **Three transport drops on that unit** (impl, review, nit) — all auto-retried and recovered from the banked `/tmp` findings + commit-per-step; no conductor re-dispatch.
- **New investigations:** `test-plan-428-2026-11-06.md`, `plan-critique-431-2026-11-06.md`, and the Serena addendum in `serena-bakeoff-2026-11-05/findings.md`.
- **#435 live-verified** (2026-11-06, probes `probe-435a`/`probe-435b`): both drop-arm shapes confirmed in the running install — 600 s timeout dropped, run stayed foreground with no deadline, notice on followUp + toast (maintainer-confirmed), run snapshots carry no `timeout` and `background:false`; the `background:false`+`always` twin was **not rejected** (the #433 bug). Provenance rows in `.pi/jev-lines.log`.
- **#429 kicked off**: issue amended (coverage % → branch checklist + named mutants), plan doc `test-plan-429-2026-11-06.md` (`51f5971`); plan critique ran (`critique-429`, xhigh/terra, 7m56s) — verdict **needs-work**, 31/31 mutants killed (none equivalent), plan corrections: R-anchors are :370-398, integration §1 uses a `MockSessionState` (real default `maxThinkingLevel: off`). Transcribed to `plan-critique-429-2026-11-06.md` (`6be07d0`).
- **#437 root-caused live**: the critique's completion wake was lost — `deliverCompletionAlert` sends via the activation-captured `pi` (`notify-completion.ts:306`); `/new` invalidates it (pi runner guard). `sessionCtx` refreshes at `session_start`, the `pi.sendMessage` path does not. Transport auto-retry may share the exposure — verify in the fix.
- **Two critique escalations, UNFILED** (need maintainer triage): (a) `tools: []` — resolver returns it, pre-flight reads write-as-unavailable, but foreground spawn args carry no restriction while background forwards `[]` (`session-manager.ts:1355`); critic's SDK probe: omitted → `read,bash,edit,write`, `[]` → none. (b) schema-valid bogus `thinkingLevel` resolves to `undefined` and reaches spawn args. Evidence in the critique doc.

### Next actions
1. **#429 finalize + implement** — fold the critique into the plan doc (measured 31-mutant table incl. X-series, corrected R-anchors, MockSessionState reconciliation, the ≥5 hand-run picks; strike the D2 pin pending escalation (a)); update the issue if acceptance wording shifts → `worktree-prep.sh` → `project-implementer` (`deepseek/deepseek-flash`, `background:true` + 7200000, banked) → review. **After any `/new`, `/reload` first (#437) or the completion wake is lost.**
2. **#437** — completion-push stale-ctx fix (small diff, C1-adjacent, silent-failure); maintainer to weigh against finishing #429 first.
3. **File the two #429 escalations** (tools:[] inconsistency; bogus thinking level) once the maintainer gives direction.
4. **#430** — the behavior-preserving `execute` split (C1; needs a CodeGraph structural map and a closure block).
5. **#434** and **#436** — unscheduled; #436 is the cheaper of the two.
6. **#426** needs the maintainer's priority call before any design work.

## Open items
- **#429 escalations unfiled** — `tools: []` foreground/background toolset inconsistency (critic flags security-adjacent) + bogus `thinkingLevel` → `undefined`; both measured in `plan-critique-429-2026-11-06.md`, awaiting triage.
- **#426 design-open** — subagent timeouts: soft stage, stall watchdog vs cliff, extension, calibration. Filed 2026-11-03; no direction chosen. Do not implement from it.
- **PR #402 held** — re-evaluate only when pi's typebox pin moves off 1.3.27.
- **#434** — `tasks`/`chain`/`graph` units carry their own `timeout` + `thinkingLevel` and bypass the per-dispatch pre-flight; deferred from #431 by design, not by oversight.
- **#436** — `outputFile` is declared on `SubagentPreset` but unmapped, so frontmatter `outputFile:` is silently ignored; `timeout`'s omission is deliberate and now pinned (ADR 0022 §6). The structural cause is `presetFromFrontmatter` re-stating the interface's field list with no key-parity check (`src/presets.ts:86`).
- **Watch-CI** — one transient full-suite failure on the #435 branch (2026-11-06) was never captured or reproduced; three consecutive greens and CI green on the same head. Not a finding; recapture the name if it recurs.
- **Sweep candidates (advisory):** wire the CodeGraph freshness check into `merge-guard` (the rule is fixed, the enforcement is manual); `sprint-metrics` auto-retry accounting (it counts only explicit `retryRunId`, so transport auto-retries read as 0); `stop_subagent`'s bare not-found; Jev exceptions ↔ ledger cross-check.
- **ADR amendments pending:** 0009 (retry snapshot carries `task`), 0003 (lineage/metrics source), 0006 (slotless templates unusable).
- **Optional doc nit:** the reviewer preset's bare `Verdict:` line guidance.

## Operating notes
- **CodeGraph first, no exception (Rule 13):** every exploration starts with `codegraph` (`explore`, `node`, `callers`, `callees`, `impact`, `affected`) or `recon.sh <symbol> --grep`; `grep`/`rg` only for what the graph cannot answer (prose, config, a recorded gap) — and say why. Note the index is cockpit-only, so PR-branch symbols don't resolve there.
- **Dispatch line:** with `processChecks` on, a line-less dispatch is rejected before spawn. Classify → `--classifier … --label` → paste the printed line. `jev-check --log --require-provenance` runs in the merge gate; historical misses are in `.pi/jev-dispatch-exceptions.txt`.
- **Banking:** implementation and critique briefs name `/tmp/brl-<label>-bank.md` and require incremental writes plus commit-per-step — that is what made three transport drops cost nothing this cycle.
- **Reviews:** C1 adversarial, C2 focused, C3 conductor read (Rule 10). Re-run the classifier on the dispatch text at review time (`--label recheck-<pr>`) and put `jev-recheck:` + `Risk class:` in the record. After a verdict, either re-review the new head or record `conductor-verified: <sha> — <evidence>`; a post-verdict commit with neither blocks at gate (d).
- **Mutation choice decides coverage:** name the mutant and its killer in the spec, and prefer a realistic mutant — a weak one can make a sound pin look vacuous (2026-11-06: `(meta.timeout as number)` survived a pin that `Number(meta.timeout)` killed).
- **Acceptance bars must be measurable here:** no coverage percentages (ADR 0021 §1 — no provider, and adding one is foreclosed); use a branch checklist + named mutants. A metric no tool in this repo can produce is a spec defect, not an aspiration.
- **Releases:** no calendar pressure; never propose one unprompted.
- **Gates:** `npx vitest run` · `npx tsc --noEmit` · `node scripts/docs-arch.mjs` · `node scripts/docs-decisions.mjs` · `git diff --check` · merge step 7 `codegraph-refresh.sh`.
- **Never `npm install` in the cockpit** — `worktree-prep.sh` only, and `--force-isolated` for any dependency-bump worktree. `.pi/brl-subagent/{presets,templates}` are gitignored local config, so the tracked record of a convention change lives here.

## Pointers
- `.pi/skills/worktree/SKILL.md` — lifecycle (step 0 = read §STATE), team rules 1–22, rituals, dispatch presets; `references/` holds review-dispatch, jev-advisory, engineering-bar, release-ritual, friction-log and sprint-end.
- `.pi/skills/handoff/references/handoff.md` — the §STATE write contract; `.pi/skills/pr/SKILL.md` — the PR-body contract.
- `.development/` — `ROADMAP.md`, `AUDIT.md`, `TASKS.md`, `METRICS.md`, `FRICTION_LOG.md`, `GLOSSARY.md`, `ARCHITECTURE.md`, `WORKTREE_FRAMEWORK.md`, `decisions/` (**22 ADRs**; the index is generated — `npm run docs:decisions`).
- `.development/investigations/` — specs, evidence and review findings: the complexity/CRAP measurement, `test-plan-428-…`, `plan-critique-431-…`, `serena-bakeoff-2026-11-05/`, the smell audit, the calibration log.
- `README.md` (user-facing), `AGENT.md` (delegation reference — ships in the tarball), `CHANGELOG.md` (Unreleased section; pi-parsable headings).
- Archives: `.development/HANDOFF-ARCHIVE-2026-10-17.md`, `.development/HANDOFF-ARCHIVE-2026-11-06.md`.

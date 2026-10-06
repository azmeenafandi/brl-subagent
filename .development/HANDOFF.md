# Handoff — 2026-09-22 (night)

> Updated 2026-10-04 — **v2.4.0 is published on npm (`latest`)**; the running extension is the **`dev` checkout**
> (deliberate developing mode: `pi install <dev path>`, npm install removed). The **cockpit** is the `dev` checkout
> (`.development/`, `graphify-out/`, `.pi/` tools, shared `node_modules`); `main` is the pristine release
> checkout (v2.4.0 tagged).
> Read this first: it is the state a fresh conductor cannot infer from the repo alone.
> Companion durable records: `.development/` (ROADMAP, AUDIT, TASKS, METRICS, FRICTION_LOG,
> INVESTIGATION_reload_wake.md), `.pi/skills/worktree/SKILL.md` (the rituals),
> `graphify-out/` (the knowledge graph — now describes DEV).

## Environment

| | |
|---|---|
| pi runtime | **1.0.4** (updated 2026-10-06; changelog scan: no extension-API breaks (`*` tool patterns, `--no-mcp`, codemode images; one child-pi nuance — `--tools` keeps MCP tools unless `mcp__`-prefixed, no MCP here); guard probe BLOCKED a cockpit `src/` write; live smoke PASSED `PI-104-SMOKE` (900 ms); runtime AHEAD of lockfile SDK 1.0.3 — expected mid-cycle, all four SDK 1.0.4 packages on npm; **SDK parity CLOSED same-day — PR #273 (merge `62cf9fa`): devDeps → `^1.0.4`, cockpit tree refreshed
with `npm ci`, check-repo fully green (runtime == lockfile)**). **Previous: 1.0.3** (updated 2026-10-05; changelog scan: no extension-API changes — the one breaking change (Azure provider renamed `azure-openai-responses` → `azure`) does not touch this setup (zero config references); boot clean 10:31:47Z on the dev-path install; live smoke PASSED `PI-103-SMOKE` (1.4 s); guard probe BLOCKED a cockpit `src/` write — Rule 5 enforced; runtime AHEAD of lockfile SDK 1.0.2 — **SDK parity CLOSED same-day: PR #270 (merge `3d601c1`): devDeps → `^1.0.3`, cockpit tree refreshed with `npm ci`, check-repo fully green (runtime == lockfile)**). **Previous: 1.0.2** (updated 2026-10-04; changelog scan clean — additive only (`registerToolRenderer` etc.), no extension-API breaks, no migration; boot clean 02:00:05Z on the **dev-path install**; live smoke PASSED `PI-102-SMOKE` — 970 ms spawn → completion; guard probe BLOCKED a cockpit `src/` write — Rule 5 enforced; **SDK parity CLOSED the same day — PR #266 (`f3c1da9`, merge `7d2acbc`): the four devDeps → `^1.0.2`, cockpit tree refreshed with `npm ci`, check-repo fully green (the lockfile diff was a legitimate npm-11 dedupe: 323→233 tree entries, no direct-spec changes)**). **Previous: 1.0.0** (updated 2026-10-02; boot clean + live smoke PASSED: spawn → steer → completion, guard probe blocked a cockpit `src/` write — Rule 5 still enforced under 1.0.0) — devDeps/lockfile were **1.0.0 too** (PR #257, `5827745`): **that skew was CLOSED**, check-repo's runtime line was green then, and the cockpit's shared tree was refreshed with `npm ci`. **TypeScript is now 7.0.2** (PR #263, `0b1cdc3`): migrated via the single containment adapter `scripts/ts-ast.mjs` (`typescript/unstable/*`), exact pin, `target: es2024` (ADR 0013; #256 closes at release) — the cockpit tree was refreshed again and `check-repo` is green under TS 7 |
| `main` | **`8a00ee3`** — **v2.4.0 released** (release merge `d954dd6`; bump commit `8a00ee3`; GitHub release published 2026-10-03; npm `latest` = 2.4.0 with signed provenance). **Pristine since 2026-09-30: no `node_modules`, no docs/graph/.pi** (all moved to the dev cockpit) |
| `dev` | **`92cb3da`** (the v2.4.0 release commit `8a00ee3` + post-release docs commits) — the post-2.3.9 fix cycle shipped as **v2.4.0**: all 13 issues closed (10 manually — the release PR's comma-separated keyword list did not auto-close: friction `fixes-keyword-omission`; `dev` was briefly deleted by GitHub's auto-delete-head-branches and restored). Cycle: **#242** (#240 default-not-ceiling timeouts, `35badde`), **#243** (#239 schema-linked types, `fcb9dc2`), **#245** (#241 steer delivery, `9c9b754`), **#246** (#244 deadline wording + single-timer ownership, `f892e3f`), **#248** (#247 contributor parity, `dec5fb65`), **#250** (#249 ARCHITECTURE rewrite + module-map guard, `949be9d`), **#252** (#251 architecture rules as tests, `3e17491`), **#254** (#253 ADR backfill, `290cf9f`), **#257** (#255 SDK 1.0.0 bump + `erasableSyntaxOnly`, `5827745`) and **#263** (#256 TypeScript 7.0.2 + ES2024 via the AST adapter, `0b1cdc3`); main at the `v2.4.0` tag; **COCKPIT since 2026-09-30** (holds `.development/`, `graphify-out/`, `.pi/`, the shared `node_modules`) |
| Running extension | **DEV-INSTALL MODE — the running extension is the dev checkout** (`pi install /home/azmeen/public_projects/brl-subagent_workspace/brl-subagent-dev` @ `a54ca6a`; includes #265 (file-only logging) and #268 (Run History UX) — both live-verified; `pi list` shows exactly one entry; npm `latest` stays 2.4.0). **History:** worktree mode `brl-subagent-wt-259` (`08f63ee`) for the #268 live verification (incl. the alt+↑/↓ paging fix); before that, worktree mode `brl-subagent-wt-265` (`e4f37cc`) for #265 — the TUI stayed clean through a dispatch emitting the exact screenshot lines; before that, published dogfooding (`npm:brl-subagent` 2.4.0, ritual step 9, 2026-10-03): **`npm:brl-subagent` 2.4.0 — the PUBLISHED artifact** (ritual step 9 done 2026-10-03: dev-path install removed → `pi install npm:brl-subagent` → `pi update --extensions` → `/reload`; `pi list` shows exactly one brl-subagent entry; **published-build probe PASSED** — `RELEASE-240-OK`, 870 ms, spawn → completion; the single boot warning is the designed `approvalMode: 'writes'` auto-approve notice). **History of the dev-install period:** **reloaded 2026-09-29 15:03Z — #240/#241/#244 all LIVE**; **pi updated to 1.0.0 (2026-10-02) — post-update smoke PASSED** (clean boot, zero errors; live spawn → steer → completion probe
SMOKE-STEER-100; the guard extension loaded and blocked a cockpit `src/` write probe; 1.0.0's changelog has no breaking
format, no extension-API changes and no migration doc — its defaults changed TUI mode to fullscreen): `npm:brl-subagent` was removed and the ABSOLUTE dev path installed; `pi list` shows exactly one brl-subagent entry (the dev tree, registered source displays as a relative path but resolves correctly). A user `/reload` activates it in-session — until then the session still holds the published 2.3.9. To remove later, use the ABSOLUTE path from `pi list` (friction `pi-remove-source-mismatch`). Rationale: the user is daily-driving the dev tree for a few days. |
| npm | **2.3.9 live (latest)** — published and approved 2026-09-27; the running install was switched to it (step 8) |
| Worktrees | main + dev only (cockpit = dev; every task worktree cleaned) |
| Graph | **1028 nodes / 2619 edges / 62 communities** — refreshed **2026-09-30** to describe the **DEV** tree (first refresh under the new model: `graph-refresh.sh` per merge; 17 files re-extracted, ~$0.01; `graph-check.py` green: 33/33 modules, 313/313 exported symbols). Pre-refresh state archived by graphify as `graphify-out/2026-09-30/` |

## Next actions (2026-10-05, post-#272)

**Recently closed:**
- **#230** (P0, Rule 11) — closed no-fix 2026-10-04: the installed graphify hook stands down in linked
  worktrees, so the cockpit graph changes only through the check-gated `graph-refresh.sh`; the residual
  exposure is the `main` checkout's gitignored artifact (nothing consumes it for scoping). Upstream
  graphify#3580 stays open for them; local graphify is now 0.9.75.
- **#265** (BUG) — fixed & closed 2026-10-04: PR #267 (merge `984a52e`) — logging is file-only by default
  (`BRL_LOG_CONSOLE=1` opt-in), five `console.*` sites routed through loggers, 8th architecture rule
  (AST-based). Live-verified at the point of use: the dispatch that used to corrupt the TUI produced zero
  terminal writes while every entry landed in the file log. Reaches npm users with the next release.

- **#259/#260/#261 (LOW) — Run History UX** — fixed & closed 2026-10-04: PR #268 (merge `a54ca6a`) — one
  row per settled run (`collapseRunsForHistory`, terminal-preferred, in-flight omitted; ordering fixed to
  newest-first after a stray `.reverse()` made it oldest-first), detail returns to the list (browse loop),
  full-output panel with honest transcript/cap lines. Paging is **alt+↑/↓** — PgUp/PgDn are host-reserved
  by pi's alt-screen viewport in fullscreen mode and a `ctx.ui.custom` overlay cannot claim them (live-
  proven; terminal-encoding differences out of scope unless a user reports one). Live-verified end-to-end
  before merge; 60 files / 1235 tests.
- **Worktree skill progressive disclosure** (PR #269, merge `c6ec1f5`) — `SKILL.md` 642→**290 lines** + six
  one-level `references/` files (release ritual, local development, review dispatch, friction log, sprint-end,
  rule narratives). Reviewed honestly: the first pass overstated preservation (“nothing deleted”) — the
  completion pass (`89f804f`) restored the full verbatim rule narratives and three dropped index details;
  verified 18/18 narrative rule blocks verbatim, all 21 rules intact in order.

**Hygiene done 2026-10-04:** GitHub *auto-delete head branches* is **OFF** (`delete_branch_on_merge=false`);
`worktree-cleanup.sh` now auto-derives the branch and deletes **local + remote** heads (never `dev`/`main`)
and skips its cockpit pull with a warning on a dirty tree — functionally tested end-to-end; the local backup
tarball (`cockpit-backup-20260930-203530.tar.gz`, 12 MB) and `main/.tmp/` are pruned. Also fixed locally: the
`project-docs` preset's tools list omitted `bash` despite its own “do not remove” comment (the first
skill-restructure dispatch was stopped pre-write by the pre-flight warning), and today's three frictions are
logged (merge-refresh miss, preservation-claim overstatement, preset drift).

**Post-merge graph refreshes:** #269 (2026-10-04) → 1438 / 3195 / 160; #270 (2026-10-05) → 1458 / 3219 / 159;
#272 (2026-10-05) → 1517 / 3339 / 161; **#273 (2026-10-06) → 1531 / 3261 / 210, coverage 33/33 modules +
319/319 symbols**. The 10-04 flagged `SKILL.md` semantic shrink (23→10) is the restructure itself (content
moved into the new references, extracted in the same pass).

**#271 (TEST) — fixed & closed 2026-10-05: PR #272 (merge `a1b30ca`)** — Tier-2 harness spawns a
controlled stub via `BRL_PI_BIN` (real pi opt-in via `BRL_E2E_REAL_PI=1`, loud when unavailable); no
vacuous passes (sentinel rejected per case, order/overlap proven from a stub log, pre-spawn case asserts
the specific conflict + empty log). Focused review PASS WITH NOTES → all accepted findings fixed; two
notes recorded inline; `sandbox` naming purged (that system was removed in v2.1.1). **Standing instruction
(2026-10-05): review dispatches use `deepseek/deepseek-flash`** — replaced `deepseek-v4-pro`, which
dropped a review mid-run on a transient connection error.

**#280 (LOW) + #282 (LOW) + #284 (LOW) OPEN:**
- **#280** — `get_agent_result`'s "Transcript:" pointer still uses the filesystem form while run-history uses
  the POSIX display form (#276 aftermath; the id is already validated via `getAgent` in the same handler)
- **#282** — test temp-dir/log-cwd teardown copy-pasted across 12 test files and already drifted (one copy
  missed the `setLogCwd(undefined)` step → the #277 leak); fix = one shared lifecycle helper (`fixtures/`).
  NOTE (2026-10-06): the `isolate: true` finding — per-file workers even under `--maxWorkers=2` — makes this
  purely DRY/hygiene; there is no cross-file leakage mechanism to fix
- **#284** — reuse one long-lived TS7 `API` in `scripts/ts-ast.mjs` (92 tsgo spawn/kills per full run; the only
  our-side lever for the #277 `context canceled` noise)

**#283 (TEST) closed 2026-10-06 as not reproducible** — filed from a second-hand side observation without
retained raw evidence; `isolate: true` (per-file workers) killed the leakage hypothesis; 5 green low-worker
runs (2 unloaded, 2 under 14-burner load, 1 file-alone). See the issue's closing comment.

**Batch 2026-10-06, autonomous resolution** (maintainer blanket approval; specs = the issue bodies +
pinned decisions): **#274 + #275 + #276 + #277 MERGED — batch complete.** PRs #278 (`6e837fc`), #279
(`615d05e`), #281 (`0d068aa`); all four closed **manually** (`Fixes` keywords do NOT auto-fire: PRs here
target `dev`, not the repo's default branch — close every merged issue by hand). **#277 outcome:** items 1+2
fixed (git stderr capture; fan-out log-cwd teardown — root cause was a late logger write re-creating a deleted
temp dir, not a missing `afterAll`); item 3 sourced to the **TypeScript 7 native compiler's Go runtime**
(`context canceled` under load: stderr inherit + kill race) — record + self-contained repro at
`.development/investigations/277-context-canceled/`; optional lever = one long-lived `API` in
`scripts/ts-ast.mjs`. None block a release. Any reviewer dispatch uses `deepseek/deepseek-flash`.

**Graph (2026-10-06):** a mid-batch incremental refresh thinned the docs semantic pass and the completeness
guard refused every write; resolved with a **from-scratch build** (graph moved aside, semantic cache
re-extracted). The post-#281 refresh then passed normally (incremental, 29 files, $0.036). Graph now
**1418 nodes / 3224 links**, `graph-check.py` passes 34/34 modules and 322/322 symbols. Residual: ~22 doc
files produce no semantic nodes under the current extractor (LLM omissions). Pre-rebuild 1530-node graph kept
at `graphify-out/graph.json.pre-276-rebuild`.

**Other candidates (marked, not filed):** the `showSelectList` preselect nice-to-have deferred from #260, and
cutting a release when the accumulated fixes should reach npm users.

## Cockpit layout (moved 2026-09-30)

- **The cockpit is the `brl-subagent-dev` checkout** (branch `dev`): `.development/`, `graphify-out/`,
  `.pi/` (skills incl. the worktree framework + `graph-refresh.sh`, guard extension, delegation config)
  and the REAL `node_modules` — the symlink direction is inverted (worktrees symlink to dev now).
- **`main` is the pristine release checkout**: only tracked release files; no deps until a release needs them.
- **The graph is a dev artifact**: `graph-refresh.sh` runs `graphify . --update` + `graph-check.py` at every
  merge into `dev` — never as a hook side effect (#230 designs the hook against this). graphify backs up the
  pre-refresh state as a dated snapshot dir per refresh day.
- **Tooling updated in the same sweep**: check-repo §4 now checks the COCKPIT is on `dev` and current with
  origin/dev (previously it demanded `main`); cleanup syncs the cockpit; the guard's messages and its worktree
  reminder now name `dev`; SKILL.md rules/lifecycle/scripts re-phrased for the cockpit. Guard suite 13/13.
- **Phase 1b DONE (2026-09-30, boot `12:43:45Z`)**: `move-cockpit-pi.sh` merged `main/.pi` → `dev/.pi`
  (120 MB) and copied the session bucket (the dev bucket now carries the history; the main bucket is
  preserved as an archive). pi now runs FROM the cockpit: guard suite green natively (no `NODE_PATH`),
  `check-repo.sh` green end-to-end — including the new dev-branch check and the informational runtime-skew
  line (0.99.1 > 0.87.1).
- **Phase 2 (tracking infra) — PR #248 MERGED `dec5fb65`** (branch `chore/247-contributor-parity-tracking`,
  issue #247): `.gitignore` reworked (`.pi/*` + negations so new state dirs are ignored by default;
  `.development/` unignored), `.development/**` + `.pi/skills/**` + `.pi/extensions/**` tracked,
  `CONTRIBUTING.md` added, SKILL.md + WORKTREE_FRAMEWORK.md updated for the tracking model. Gates green
  (1201/1201). **Dogfood caught a real bug**: `worktree-prep.sh` demanded `.git` be a directory, so
  provisioning failed on the cockpit (a LINKED worktree, `.git` is a file) — fixed to ask git
  (`rev-parse --is-inside-work-tree`). Reconciliation done in the cockpit (preserve → pull → re-apply →
  docs-churn commit); `graph-refresh.sh` run post-merge. **#230 is the next tracked fix.**
- **Docs infrastructure (2026-09-30, PR #250 → `949be9d`)**: `ARCHITECTURE.md` rewritten as a lean
  current-state document (923 → 157 lines) with a GENERATED module map (`npm run docs:arch`; every
  `src/*.ts` carries a `// Purpose:` first line) guarded by `src/__tests__/architecture-doc.test.ts` —
  mutation-proofed: a new module, an edited purpose, or a removed header each turn the suite red. The
  release ritual no longer version-stamps it. Deferred follow-ups: architecture fitness functions
  (dependency rules as tests) and an ADR backfill.
- **Architecture rules — executable (2026-09-30, PR #252 → `3e17491`)**: `src/__tests__/architecture-rules.test.ts`
  enforces seven structural rules via the TypeScript compiler API — no runtime import cycles, entry-point
  confinement, the `types.ts`→`schema.ts` type-only direction (#239), the pure-helper boundary,
  process-execution confinement, the runtime-dependency allowlist, and the session-manager reader API.
  All seven mutation-proofed; the scoping found that a regex survey reports a false `types↔schema` cycle, so
  the rules encode the *runtime* graph instead. Graph after the merge: 1270 nodes / 2864 edges / 120
  communities. The ADR backfill made it a complete arc: PR #254 (`290cf9f`) added twelve accepted records in
  `.development/decisions/` with a generated index (`npm run docs:decisions`) and a CI drift guard — the
  construction was delegated (spec) while the decision content stayed with the conductor. Post-#254 graph:
  1316 nodes / 2924 edges / 141 communities.
- Backup before the move: `cockpit-backup-20260930-203530.tar.gz` (workspace root).
- Transitional (pre-restart) known breakages: anything under `main/.pi` that resolves repo deps (e.g. the
  guard test needs `NODE_PATH=<dev>/node_modules` until the move) or finds `.development/`/`graphify-out/`
  via script-relative paths — all self-heal once `.pi` lives in the cockpit.

## The release — v2.3.9 (shipped)

- Tag **v2.3.9** on `main` (`b7c52e4`; parent `7289618` = the `dev → main` merge); `dev` fast-forwarded to the same commit; main CI green.
- The user **published the GitHub release** (`01:31:11Z`) → `publish.yml` **succeeded** → the staged package was approved → **2.3.9 is live on npm (latest)**. **#206, #210, #216, #217, #220, #222, #224, #227 auto-close** when the merge landed on `main` (the `Fixes` keywords are in the commit bodies).
- **Step 8 done**: `pi remove` (absolute path) + `pi install npm:brl-subagent` + `pi update --extensions`; `pi list` shows only `npm:brl-subagent` (2.3.9); the user `/reload` completed the switch in-session (2026-09-27).
- Metrics row appended: 2026-09-27 (v2.3.9) — 19 dispatches (2 fg / 17 bg), 15 done / 5 failed (all transient provider connection errors, every one recovered — incremental findings + model switching), 0 zero-work, 0.32 poll/dispatch.
- Friction across the arc: the three ≥2-occurrence classes were already escalated and closed (#215/#216/#217); new entries `connection-error-x2`, the graph-hook recurrence, and the parallel-call race.

## Sprint state — the four fixes, the process P0, and M2 Phases 0–4 (feature-complete, all on `dev`)

| Issue | PR | Merge / notes |
|---|---|---|
| #185 explicit run-entry lookups | #191 | `cc18c1ec` |
| #187 coherent failed-run records | #192 | `291a700` |
| #183 runtime-vocabulary ratchet | #193 | `6ab129ee` |
| #186 hardened terminal-status ratchet | #194 | `bf482924` (incl. a review-driven revision) |
| #189 partial-read-as-complete (P0) | local-only | `graph-check.py` symbol sampling + boundaries; Rule 19 in SKILL.md; release-ritual step 7 = refresh only when stale |
| #196 background+batch silent ignore — M2 Phase 0 | #197 | `621e710` + `f9af856` (merge `0587518`); C1 adversarial review `approve-with-nits` → the schema-description nit fixed pre-merge |
| #198 Phase 1 — extract `spawnBackgroundRun()` | #199 | `85f7fce` + `6d66da5` (merge `ca76cd7`); C1 adversarial review (medium thinking) `approve-with-nits` → 2 document-level nits fixed, 3 accepted; live probe (real spawn) passed identically at HEAD and pre-extraction BASE |
| #198 Phase 2 — background fan-out | #200 | `7a7538c` + `775b18a` (merge `ca4b7f1`); C1 adversarial review (medium) `approve-with-nits` → 10/10 mutation probes killed; four nits fixed in `775b18a`; DRY finding filed as #201 (deferred); live probe created two REAL agent records |
| #198 Phase 3 — contract surface (docs + LLM strings) | #202 | `8d94ce8` + `e749a6d` (merge `c048973`); C2 focused review `approve-with-nits` → both docs nits fixed in `e749a6d`; produce-check confirmed the clause wired into the registered tool; CI green on the final artifact |
| #198 Phase 4 — fan-out test gap-fill | #203 | `c098077` + `9cba4e0` (merge `0dc5bd4`); C2 focused review `approve-with-nits` → near-vacuous id case dropped + cross-module prose pins relaxed; both kept cases mutation-killed independently; CI green on the final artifact |

- Combined gate on merged `dev` (isolated worktree): **tsc clean, 1102 tests / 50 files** (the four fixes alone: 1087 / 47; Phase 0 adds the 3-case rejection suite; Phase 1 the extraction suite; Phase 2 nine fan-out cases; Phase 3 is docs-only; Phase 4 adds the outputFile/H1 rejection cases net +2).
- The four sprint issues were **closed manually** with status comments — their commits did not carry
  `Fixes #N` in the commit BODY, so release-time auto-close would not have fired
  (friction `fixes-keyword-omission`). **#196 is different** — its commit body carries `Fixes #196`
  (commit `621e710`), so it auto-closes when `dev → main` lands at release; it stays open until then.
- **Board: #204 + #205 OPEN (P0, Rule 11)** — the two sprint-end recurrence escalations (partial-read-as-complete;
  probe/mutation target selection). **#206 OPEN (bug, medium)** — a running foreground subagent flashes `✗`
  mid-stream (live partials classified as a settled verdict; fix = the `exitCode: -1` unsettled sentinel in
  `emitSubagentUpdate`; bases audit in the issue). **#195 OPEN (low)** — test temp-dir leak. **#201 OPEN (low)** —
  the shared background guard/validation prelude. #196 and #198 **auto-closed** when `dev → main` landed at the
  release (the `Fixes`/`Closes` keywords fired). Everything else closed.

## The release — v2.3.8 shipped

- Tag **v2.3.8** on `main` (`5affd09`; parent `3e51322` = the `dev → main` merge); `dev` back-merged (`d61db22`). CI green on every pre-merge artifact.
- The user published the GitHub release (16:14Z) → `publish.yml` **succeeded** → the staged package was approved → **2.3.8 is live on npm (latest)**. **#196 and #198 auto-closed** when the merge landed on `main` (16:11Z).
- **Step 8 done**: `pi remove` of the local-path install + `pi install npm:brl-subagent` + `pi update --extensions`; `pi list` shows only `npm:brl-subagent` (2.3.8). A user-triggered `/reload` completes the switch in the running session. *Near-miss:* the first `pi remove` used the stored relative source string and did not match, briefly leaving BOTH installs registered — cleared with the absolute path before any reload (friction `pi-remove-source-mismatch`).
- Graph: refreshed and verified (942 nodes, 52 semantic communities; `graph-check.py` green). The post-push hook's rebuild had FAILED the check (2 new exported symbols missing) and degraded community names — a full `graphify . --update` + `cluster-only` + `label` fixed both (friction `graph-hook-stale-rebuild`).
- Sprint metrics row appended (**2026-09-22**): 36 dispatches (1 fg / 35 bg), **94.3% success (33/35)**, 2 failed, **0 zero-work**, 0 retries, 0.28 polling/dispatch, 0 steer/stop. The friction log answers WHY.

## Operational knowledge (do not re-derive)

- **Wake delivery semantics.** Background completion wakes are delivered promptly (0–7 s) when the
  conductor is IDLE at settle, and queued until a quiet turn boundary when it is MID-TURN
  (observed 28–567 s). Verified identical in reloaded and freshly restarted processes — it is pi's
  follow-up queueing, not an extension defect. Evidence: `INVESTIGATION_reload_wake.md`; friction
  `biased-baseline`. Do not mistake the busy-path delay for a broken wake.
- **Run-record surface.** Session jsonl (`~/.pi/agent/sessions/…`) carries `"brl-subagent-run"`
  custom entries; completion wakes as `"subagent-completion"`, failure notices as
  `"subagent-notification"`. Extension log: `.pi/subagent-logs/brl-subagent.log`.
- **Conventions.** Dev-branch flow (worktrees from `dev`; PRs target `dev`; `dev → main` is a
  release-time merge commit). Ground-truth every dispatch (statuses can lie). No timeouts on
  implementer/reviewer dispatches. Rule 19: every guard states its coverage. Reviews: C1 →
  adversarial, C2 → focused, C3 → conductor read. Review/debug templates persist findings
  incrementally to `/tmp`. A delegated brl-subagent runs with `noExtensions` — it has no
  `delegate_task`, so skill-driven workflows needing dispatch must run in the conductor.
- **Dispatch model + thinking levels (2026-09-22; reviewer model reconfirmed 2026-09-26).** Implementers run on the
  configured default (`xiaomi/mimo-v2.6-flash`, chosen by the user to test performance) at `low`. **Reviewer
  dispatches — focused AND adversarial — pin `model: "deepseek/deepseek-flash"` explicitly** and run at `medium`.
  The model id must be passed per call: presets and templates declare no model, so omitting it silently runs the
  implementer default (review-209 did — friction `reviewer-model-default-drift`). Never rely on the config default
  for reviewers. Template frontmatter (`adversarial-review` declares `high`) is router metadata and never
  reaches dispatch parameters (friction `thinking-level-silent-mismatch`). **Tools are explicit whenever the
  task's shape needs a capability the preset may lack** (directory exploration → `find`/`ls`/`grep`/`bash`); a
  missing tool is silent until the subagent fails — evidence and the product fix are in #216.
- **Local-only (gitignored) changes from this sprint:** `graph-check.py`, Rule 19 (+ the "coverage travels with
  the claim" bullet), **new Rule 20** and **new Rule 21** (claims cite their evidence) in `.pi/skills/worktree/SKILL.md`,
  the `.pi/brl-subagent/templates/` review/debug contracts (coverage + target requirements), the worktree-guard fix
  (command-position install matching + context-aware advice) and its `guard.test.cjs` regression script,
  release-ritual step 7, `.development/` docs.

## Next

**v2.3.9 shipped (2026-09-27)**; post-sprint maintenance continues on `dev` (`4329bb4`, 6 PRs ahead of `main`): the
test-quality audit (#231/#232), the dead-code arc (#234/#236/#237), and #229 (#238) — all merged. **#229, #233 and
#235 auto-close at the next dev→main release** (`Fixes` keywords in their commit bodies).

**Workflow add (2026-09-29):** the `project-proposer` + `design-proposal` project-local combo (gitignored:
`.pi/brl-subagent/{presets,templates}/`) is created and routed (Rule 14 table row). Proposer outcomes:
- **#240 proposal DONE + conductor-verified** — deepseek/deepseek-flash (after stealth's 3 provider-empty failures),
  5m59s; `.development/investigations/issue-240/REVIEW_240_PROPOSAL.md` (341 lines); recommendation **Option A**
  (default-not-ceiling); the A2 probe was independently reproduced (1191/1191 + typecheck, zero test edits).
- **#239 proposal COMPLETE + verified** — xiaomi/mimo-v2.6-pro over-thought the first attempt (54 turns / 53.5k
  tokens) and was aborted by the 30-min hard cap at exactly 30m00s (live incident commented on #240); §0–§2 and all
  probes/diffs were recovered, and deepseek-flash completed §3–§6 in 1m33s ($0.028). Full 203-line document at
  `.development/investigations/issue-239/REVIEW_239_PROPOSAL.md`; the conductor re-verified E10/E12 (both option
  implementations typecheck clean) and the F4 claim. `wt-240` cleaned; **Option 2 was APPROVED by the user
  (2026-09-29)** — implementer spec pending approval, `wt-242` (`refactor/239-schema-linked-params`) prepped.

**Model directive (user, 2026-09-29):** the default brl-subagent (subagent) model is now
`deepseek/deepseek-flash` — set after `openrouter/stealth/space-bunny-alpha` proved unstable (3 provider-empty
failures) and `xiaomi/mimo-v2.6-pro` demonstrated overthinking (54 turns / killed by the 30m cap mid-proposal).
**ALL subagent work uses this model until the user decides otherwise**; the conductor pins `model:` per call for
auditability.

**Implementation outcomes (2026-09-29):** #240 → PR #242 merged `35badde` (M1–M4 conductor-reproduced, 1194/1194,
CI pass); #239 → PR #243 merged `fcb9dc2` (rebased after #242 with the timeout wording carried into `schema.ts`;
M1–M3 conductor-reproduced, 1195/1195, CI pass); #241 → PR #245 merged `9c9b754` (steer delivery; M1–M4
conductor-reproduced, 1201/1201, CI pass); #244 → PR #246 merged `f892e3f` (deadline wording, single-timer ownership,
foreground-only retryOnTimeout docs; M1/M2 conductor-reproduced, 1201/1201, CI pass).
All auto-close at the next dev→main release.

**Release plan (user, 2026-09-29):** the next release is **v2.4.0** — holding until the weekly dependabot PR arrives
and any dogfooding findings are in. The seven merged issues above auto-close at that `dev → main` merge; the
running dev install already carries all of them (reloaded 15:03Z).

**Cockpit-move note (2026-09-30):** the release ritual's graphify-update step is **retired** —
`graph-refresh.sh` keeps the dev graph current at every merge, so release-time only VERIFIES
(`graph-check.py`). Release work now runs from the cockpit; `main` stays pristine.

**Update prep (2026-09-30):** pi is now **0.99.1** (smoke-verified above). devDependencies still resolve to
**0.87.1** — the runtime SDK surface we bind (`createAgentSession`, in-memory `SessionManager`,
`AgentSession.steer`) is re-verified empirically by the post-update smoke; when Dependabot (or we) bump the
devDeps to 0.99.x, gate the bump with `tsc` + the suite — option-shape drift in `createAgentSession` is the
one thing only the bumped types can catch.

The board's only open work item is parked (#230); everything else is documented backlog:

1. **Sprint CLOSED (user-declared 2026-09-27); post-sprint work continues.** **Developing mode is ACTIVE** — the
   running install is the dev checkout (local-path @ `4329bb4`); the user is daily-driving it (dogfooding green so
   far). Flip back via the release ritual's step 8 when a release is cut; remove by the ABSOLUTE path (friction
   `pi-remove-source-mismatch`).
2. **Open:** **#230** (P0 Rule 11 — graph hook: silent node loss; upstream evidence filed on
   Graphify-Labs/graphify#3580 — Linux/small-corpus occurrence + a clean replay on 0.9.69; fix direction may
   simplify if upstream arms the guard) + **#239** (low — collapse the four chain/tasks/graph casts now that
   `DelegateTaskParams` carries the exact shapes; blocked on `GraphTask.dependsOn` being required vs the schema's
   `Type.Optional`; flagged by the #238 implementer, inventory corrected to 4 sites; **MERGED to `dev`** — PR #243
   (`fcb9dc2`), rebased after #242; conductor verification: verbatim extraction, M1–M3 reproduced, 1195/1195, CI
   pass) + **#240** (MEDIUM — the 30-min background hard cap: no decision record (provenance table in the issue),
   ceiling semantics silently shortening explicit timeouts, foreground/background asymmetry; **MERGED to `dev`** —
   PR #242 (`35badde`); conductor verification: M1–M4 reproduced, 1194/1194, CI pass; proposal:
   `.development/investigations/issue-240/`) + **#244** (LOW — background-timeout follow-ups; **MERGED to `dev`** —
   PR #246 (`f892e3f`); M1/M2 conductor-reproduced, 1201/1201, CI pass; `retryOnTimeout` documented
   foreground-only) + **#241** (MEDIUM — `steer_subagent` does not deliver: records status+transcript
   only while the tool description promises real steering; the pinned SDK has `AgentSession.steer()` so delivery is
   implementable; also the one-shot-steer guard defect and the settle race; **LIVE BASELINE captured 2026-09-29** — predictions confirmed; **PR #245 merged `9c9b754`** — M1–M4 conductor-reproduced, 1201/1201, CI pass; **live acceptance probe PASSED 14:20Z** (both codewords delivered, repeat steer works, both audit lines; before/after in `.development/investigations/issue-241/BASELINE.md`)). **#229 DONE** — PR #238 merged
   to `dev` (`4329bb4`, 2026-09-29): six pins in `src/__tests__/retry-pins.test.ts` (fan-out-origin capture+retry,
   background-origin e2e, directional + 19-key-ratchet drift guard, sentinel round-trip) + type-only
   `DelegateTaskParams` with the `_DelegateParamCoverage` compile-time ratchet; mutants M1–M4 independently
   reproduced by the conductor; auto-closes at the next dev→main.
   Related finding (2026-09-27 discussion): we skip graphify's recommended post-merge `graphify update .`
   (the stock hooks skip worktrees by design, so our integration points get no rebuild) and `graph-check.py`
   is release-ritual-only, not on the Rule 13 scoping path — both feed #230's fix direction. Local evidence
   kept: `.development/investigations/graphify-shrink-3580/` (comment text, sanitized rebuild log, backup zip).
3. **Documented backlog (no issues):** the #223-review nits (the graph spawn test asserts the SET via `.sort()`;
   the three near-identical per-unit pre-pass blocks — DRY; the non-uniform pre-pass placement), the #213-review
   coverage nits (cost-gate log-label pinning; substring-only rejection-text pinning), and the M2 arc's remaining
   half (chain/graph background via the resumable machine; M3 goal-pursuit loop).
4. **A possible v2 wake-coalescing design** (N wakes = N conductor turns) — empirically motivated by the live
   2-task acceptance.
5. **Conventions in force:** implementers run the configured default at `low`; reviewer dispatches pin a model
   explicitly at `medium` (the operational-knowledge section names the current ones); every shipped-text change
   gets a worktree + PR + review; the release ritual and sprint-end ritual live in the worktree skill.

**Test-tautology audit (2026-09-27, complete):** all 15 regression fixes defect-injected — 6 source reverts + 9
targeted mutations, every one KILLED (0 GREEN, 0 SURVIVED). No tautological guard tests found; the mutation pilot
on `scheduler.ts` scored 8/14 killable (3 true equivalents; 3 real fixture gaps: pre-sorted fixtures, no
multi-parent node, no exact cycle-content assertion). Evidence: `.development/investigations/test-audit-2026-09-27/`.
On the shelf: mutation runs on 1–2 more modules for a broader rate. **Gaps closed same day:** PR #231 (merged to
`dev` as `e617427`, test-only) adds the wave-ordering fixture (kills BOTH sort mutants) and the exact-cycle-content
fixture (kills the `path.pop` mutant); the third candidate is now a CONFIRMED equivalent mutant — the full 1169-test
suite stays green with `processed.has(depId) → false` applied, because the guard is unreachable for every input
`topologicalSort` accepts. Scheduler final: **10 killed / 4 equivalents / 0 unexplained survivors**.

**Second module — `session-manager.ts` (2026-09-27):** 15 mutants → **8 KILLED / 7 SURVIVED, all seven caught
NOWHERE** (primary suite + the 4 importing suites). The gaps, high→low: **S1** `setAgentResult`'s #179 D1
classification has zero direct tests (a provider death resolves `completed` and nothing notices); **S6a**
`getAgent`'s traversal guard is untested — a planted record one level above the storage dir is read, while the
shipped test uses a nonexistent path and passes for the wrong reason; **S8** lock-release identity check needs a
3-spawn queue (probe-verified: the mutant lets two branch-mode spawns share the working tree); **S13**
double-finalize guard needs a throw *after* stamping (probe-verified: 3 run entries vs 2); **S2** `stopAgent`
idempotency, **S3** `steerAgent` non-running throw, **S10** `updateAgentStatus('failed')` emit — each untested.
S7 killed only by lock poisoning + hang (the mutant leaks a lock entry; 10 cascading timeouts). Evidence:
`.development/investigations/test-audit-2026-09-27/session-manager/`. **Gaps closed 2026-09-27:** PR #232 (merged to
`dev` as `adb1ed1`, test-only, +194) adds six tests — one per live gap (S6a traversal READ, S8 three-spawn lock
chain, S13 double-finalize, S2 stop idempotency, S3 steer contract, S10 failed-event) — each mutant-kill verified
(conductor re-verified T1/T2 independently). **S1 reclassified: DEAD CODE** — the graph shows a single `contains`
edge and zero `calls`/`imports`; the live #179 D1 policy is covered by the existing `it.each` classification table.
Cleanup candidate (delete the dead `setAgentResult` export), not a test gap. **Cleanup done:** issue #233 → PR #234
(merged `5915c540`): export + doc comment deleted, unused `isSubagentError` import dropped, two test comments
reworded; gates green (typecheck + 53 files / 1175 tests). `Fixes #233` sits in the commit body, so the issue closes
at the next dev→main release. The audit shelf is empty.

**Dead-code pipeline (follow-on, 2026-09-27):** issue #235. The graphify `contains`-only-edge query + grep
verification found 9 production symbols with no references; `git log -S` triage classified 6 as safe removals
(**done**: PR #236, merged `c4e8a38`) and 3 as needing work — **E5 compliance is BROKEN WIRING** (the handler table
lacks a `compliance` key, so 325 LOC in reports.ts + 4 tui views are unreachable), **`isSensitiveFile` is the
never-wired path-based detector** (the live scan matches only output TEXT and stores the regex literal in the
`file` field), and **`setLogLevel` was never wired** (`minLevel` hardcoded). **Wiring done:** PR #237 (merged
`6c6faa9`) — handler key + README row (pinned both ways by `readme-commands.test.ts`), `isSensitiveFile` now the
report's path-based detector (full-path entries, fragment suppression, case-normalized so `.ENV` is caught),
`BRL_LOG_LEVEL` knob + tests (54 files / 1185 tests). The conductor's mutant spot-check forced a test refinement —
the first fixture also matched the text scan; see friction `spec-derived-test-tautology`. #235 closes at the next
dev→main release. Findings:
`.development/investigations/deadcode-triage-2026-09-27/`.

All worktrees cleaned; `main` @ `8a00ee3` (**v2.4.0**, pristine — the graphify hook's stray partial graph was removed),
`dev` @ `8a00ee3` (**the cockpit**, fast-forwarded to the release). **v2.4.0 is PUBLISHED — GitHub release live, npm `latest` at 2.4.0, and the running install switched to the published package** (ritual step 9 done; published-build probe PASSED). The dev cockpit stays on disk for the next cycle — only the install changed. Board: **#230** (P0 Rule 11, graph hook —
now also the owner of the hook-side path model, parked pending the upstream-evidence call) + **#259/#260/#261**
(LOW, Run History UX — one row per run / list-returning navigation / full-output view; logged 2026-10-03);
**#229/#233/#235/#239/#240/#241/#244/#247/#249/#251/#253/#255/#256** are **CLOSED** (v2.4.0).
Cockpit move **COMPLETE** (Phases 0–1b DONE 2026-09-30; pi now runs from `brl-subagent-dev`);
Phase 2 **MERGED** (PR #248 → `dec5fb65`; contributor parity live on `dev`); docs infra **MERGED**
(PR #250 → `949be9d` — ARCHITECTURE lean + generated-guarded) + architecture rules **MERGED**
(PR #252 → `3e17491` — seven mutation-proofed fitness functions) + ADR backfill **MERGED**
(PR #254 → `290cf9f` — twelve records + guarded index; ADR 0013 added → 13) + dependency line **CLOSED**
(PR #257 → `5827745` — `@earendil-works/*` 1.0.0 + typebox 1.3.34 + `erasableSyntaxOnly`) + **toolchain parity
CLOSED** (PR #263 → `0b1cdc3` — TypeScript 7.0.2 + ES2024 behind the `scripts/ts-ast.mjs` adapter; 7/7 mutations
re-proven; graph 1397 nodes / 3066 edges / 157 communities); **#230 next**.

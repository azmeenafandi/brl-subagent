# Handoff — 2026-09-22 (night)

> Updated 2026-10-10 — **v2.5.0 PUBLISHED and LIVE on npm (`latest` = 2.5.0).** The running install was switched back to
> `npm:brl-subagent` and reloaded; the **published-build probe PASSED** (presetsDir = the npm package path; shipped files
> byte-identical to the tagged commit). The dev cockpit stays on disk for the next cycle — only the install changed.
> The **cockpit** is the `dev` checkout (`.development/`, `.codegraph/` (the structural index), `.pi/` tools, shared `node_modules`);
> `main` is the pristine release checkout (v2.4.0 tagged until the release merge).
> Read this first: it is the state a fresh conductor cannot infer from the repo alone.
> Companion durable records: `.development/` (ROADMAP, AUDIT, TASKS, METRICS, FRICTION_LOG,
> INVESTIGATION_reload_wake.md), `.pi/skills/worktree/SKILL.md` (the rituals),
> `.codegraph/` (the structural index — now describes DEV).

## Environment

| | |
|---|---|
| pi runtime | **1.1.0** (updated 2026-10-08; changelog scan: no extension-API breaks — additive only (`durationMs` on the tool-render context + `tool_execution_end`; `outputPad`; `aborted` on `agent_settled`); one semantic change flagged — `--tools` gains `+name`/`-name` adjusters while plain lists still replace (our restricted-tools spawn path exercised by the smoke); extension hooks live under 1.1.0 (guard probe BLOCKED a cockpit `src/` write — Rule 5 enforced); live smoke PASSED `PI-110-SMOKE` (1.3 s, restricted tools); npm: all four packages at 1.1.0 in lockstep; runtime was AHEAD of lockfile SDK 1.0.4 — expected mid-cycle; **SDK parity CLOSED same-day — PR #290 (merge `3ea40f9`): the four devDeps → `^1.1.0`, lockfile +40/−40 (8 packages, no dedupe churn), isolated-worktree suite 61/1258 + `tsc` clean — re-verified by the conductor — cockpit tree refreshed with `npm ci`, `check-repo` fully green (runtime == lockfile)**). **Adoption candidates (marked, not filed):** `durationMs` (tool-render footer timing) and `agent_settled.aborted` (sharper cancelled-vs-finished settle handling). **Previous: 1.0.4** (updated 2026-10-06; changelog scan: no extension-API breaks (`*` tool patterns, `--no-mcp`, codemode images; one child-pi nuance — `--tools` keeps MCP tools unless `mcp__`-prefixed, no MCP here); guard probe BLOCKED a cockpit `src/` write; live smoke PASSED `PI-104-SMOKE` (900 ms); runtime AHEAD of lockfile SDK 1.0.3 — expected mid-cycle, all four SDK 1.0.4 packages on npm; **SDK parity CLOSED same-day — PR #273 (merge `62cf9fa`): devDeps → `^1.0.4`, cockpit tree refreshed
with `npm ci`, check-repo fully green (runtime == lockfile)**). **Previous: 1.0.3** (updated 2026-10-05; changelog scan: no extension-API changes — the one breaking change (Azure provider renamed `azure-openai-responses` → `azure`) does not touch this setup (zero config references); boot clean 10:31:47Z on the dev-path install; live smoke PASSED `PI-103-SMOKE` (1.4 s); guard probe BLOCKED a cockpit `src/` write — Rule 5 enforced; runtime AHEAD of lockfile SDK 1.0.2 — **SDK parity CLOSED same-day: PR #270 (merge `3d601c1`): devDeps → `^1.0.3`, cockpit tree refreshed with `npm ci`, check-repo fully green (runtime == lockfile)**). **Previous: 1.0.2** (updated 2026-10-04; changelog scan clean — additive only (`registerToolRenderer` etc.), no extension-API breaks, no migration; boot clean 02:00:05Z on the **dev-path install**; live smoke PASSED `PI-102-SMOKE` — 970 ms spawn → completion; guard probe BLOCKED a cockpit `src/` write — Rule 5 enforced; **SDK parity CLOSED the same day — PR #266 (`f3c1da9`, merge `7d2acbc`): the four devDeps → `^1.0.2`, cockpit tree refreshed with `npm ci`, check-repo fully green (the lockfile diff was a legitimate npm-11 dedupe: 323→233 tree entries, no direct-spec changes)**). **Previous: 1.0.0** (updated 2026-10-02; boot clean + live smoke PASSED: spawn → steer → completion, guard probe blocked a cockpit `src/` write — Rule 5 still enforced under 1.0.0) — devDeps/lockfile were **1.0.0 too** (PR #257, `5827745`): **that skew was CLOSED**, check-repo's runtime line was green then, and the cockpit's shared tree was refreshed with `npm ci`. **TypeScript is now 7.0.2** (PR #263, `0b1cdc3`): migrated via the single containment adapter `scripts/ts-ast.mjs` (`typescript/unstable/*`), exact pin, `target: es2024` (ADR 0013; #256 closes at release) — the cockpit tree was refreshed again and `check-repo` is green under TS 7 |
| `main` | **`8a00ee3`** — **v2.4.0 released** (release merge `d954dd6`; bump commit `8a00ee3`; GitHub release published 2026-10-03; npm `latest` = 2.4.0 with signed provenance). **Pristine since 2026-09-30: no `node_modules`, no docs/graph/.pi** (all moved to the dev cockpit) |
| `dev` | **`92cb3da`** (the v2.4.0 release commit `8a00ee3` + post-release docs commits) — the post-2.3.9 fix cycle shipped as **v2.4.0**: all 13 issues closed (10 manually — the release PR's comma-separated keyword list did not auto-close: friction `fixes-keyword-omission`; `dev` was briefly deleted by GitHub's auto-delete-head-branches and restored). Cycle: **#242** (#240 default-not-ceiling timeouts, `35badde`), **#243** (#239 schema-linked types, `fcb9dc2`), **#245** (#241 steer delivery, `9c9b754`), **#246** (#244 deadline wording + single-timer ownership, `f892e3f`), **#248** (#247 contributor parity, `dec5fb65`), **#250** (#249 ARCHITECTURE rewrite + module-map guard, `949be9d`), **#252** (#251 architecture rules as tests, `3e17491`), **#254** (#253 ADR backfill, `290cf9f`), **#257** (#255 SDK 1.0.0 bump + `erasableSyntaxOnly`, `5827745`) and **#263** (#256 TypeScript 7.0.2 + ES2024 via the AST adapter, `0b1cdc3`); main at the `v2.4.0` tag; **COCKPIT since 2026-09-30** (holds `.development/`, `.codegraph/`, `.pi/`, the shared `node_modules`) |
| Running extension | **DEV-INSTALL MODE — the running extension is the dev checkout** (`pi install /home/azmeen/public_projects/brl-subagent_workspace/brl-subagent-dev` @ `a54ca6a`; includes #265 (file-only logging) and #268 (Run History UX) — both live-verified; `pi list` shows exactly one entry; npm `latest` stays 2.4.0). **History:** worktree mode `brl-subagent-wt-259` (`08f63ee`) for the #268 live verification (incl. the alt+↑/↓ paging fix); before that, worktree mode `brl-subagent-wt-265` (`e4f37cc`) for #265 — the TUI stayed clean through a dispatch emitting the exact screenshot lines; before that, published dogfooding (`npm:brl-subagent` 2.4.0, ritual step 9, 2026-10-03): **`npm:brl-subagent` 2.4.0 — the PUBLISHED artifact** (ritual step 9 done 2026-10-03: dev-path install removed → `pi install npm:brl-subagent` → `pi update --extensions` → `/reload`; `pi list` shows exactly one brl-subagent entry; **published-build probe PASSED** — `RELEASE-240-OK`, 870 ms, spawn → completion; the single boot warning is the designed `approvalMode: 'writes'` auto-approve notice). **History of the dev-install period:** **reloaded 2026-09-29 15:03Z — #240/#241/#244 all LIVE**; **pi updated to 1.0.0 (2026-10-02) — post-update smoke PASSED** (clean boot, zero errors; live spawn → steer → completion probe
SMOKE-STEER-100; the guard extension loaded and blocked a cockpit `src/` write probe; 1.0.0's changelog has no breaking
format, no extension-API changes and no migration doc — its defaults changed TUI mode to fullscreen): `npm:brl-subagent` was removed and the ABSOLUTE dev path installed; `pi list` shows exactly one brl-subagent entry (the dev tree, registered source displays as a relative path but resolves correctly). A user `/reload` activates it in-session — until then the session still holds the published 2.3.9. To remove later, use the ABSOLUTE path from `pi list` (friction `pi-remove-source-mismatch`). Rationale: the user is daily-driving the dev tree for a few days. |
| npm | **2.3.9 live (latest)** — published and approved 2026-09-27; the running install was switched to it (step 8) |
| Worktrees | main + dev only (cockpit = dev; every task worktree cleaned) |
| Index | **CodeGraph — the sole structural index** (ADR 0016): `.codegraph/` (gitignored), refreshed at every merge into `dev` by `.pi/skills/worktree/codegraph-refresh.sh` (+ `codegraph-check.py`: coverage + `indexed_at_commit == HEAD`). The retired graphify tree is gone; its final report is archived at `.development/investigations/graphify-retirement-2026-10-10/` |

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
- **Glossary started (2026-10-09)** — `.development/GLOSSARY.md`: plain-language definitions for terms that
  earned their keep (first entries: oracle, ground truth, spec, backstop, invariant, ratchet, regression,
  linter, ADR). Added at the maintainer's request — entries are added/refreshed whenever a term causes
  confusion or becomes load-bearing.
- **#295 (BUG) — fixed & closed 2026-10-09**: PR #297 (merge `aec6659`) — a SIGKILLed foreground subagent was
  finalized as a false `done` (signal death → fabricated exit 0 → category `unknown`). Now: signal captured,
  `exitCode -1` sentinel on `code === null`, unstaged external kills stamped `SUBAGENT_SIGNAL_KILLED_MESSAGE`
  → existing category `crash`, staged timeout/abort reasons preserved. Adversarial review (glm-5.3-flash,
  2 runs due to the 30m background cap): `approve-with-nits`; mutation probes 4a/4b killed (sentinel and
  classify rule both load-bearing); review finding F1 (settled signal-death runs took the TUI raw-text branch)
  fixed in `c445625` with a mutation-pinned test. 61 files / 1265 tests. **#298 filed** (centralize the
  partial-vs-settled predicate — `-1` is overloaded). Probe evidence:
  `.development/investigations/option-b-probes-2026-10-09.md`.

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

**#282 MERGED 2026-10-06 — BOARD EMPTY.** PR #289 (`9c7cf3b`), closed manually. One shared temp-dir +
log-cwd lifecycle helper (`src/__tests__/fixtures/temp-lifecycle.ts`) adopted by the 8 drifted files; the
load-bearing order is now structural: clear log cwd → drain (`setImmediate`) → rmSync (the #277 late-write
lesson). `transcript.test.ts` (single dir in `beforeAll` + per-test unlinks) and the three non-lever `mkdtemp`
users are documented exclusions. Conductor-run acceptance: suite 61/1258 green, `/tmp` = 0 after a full run,
after fan-out ×3, and after session-manager alone; `cannot delete branch` 0 and `context canceled` 0 (the
#277/#284 fixes holding). Test-only — no `/reload` needed. Delivered across EIGHT external connection drops
with ~3 minutes of total lost work: commit-per-step cadence + short units (friction log: connection-drop-grind).

**#287 MERGED 2026-10-06** — PR #288 (`b20e794`), closed manually. The transcript-path format is now
ratcheted by an architecture rule (mirrors the runtime-vocabulary literal walk; type-position skip; scope =
top-level `src/*.ts`). Conductor's independent mutation test confirmed it bites. `ARCHITECTURE.md`'s rule
enumeration reconciled to nine rules (adds #239, #265, #287). Test + docs only — no `/reload` needed.

**#280 MERGED 2026-10-06** — PR #286 (`aed2aa8`), closed manually. One-file fix: `get_agent_result`'s pointer
renders via `transcriptDisplayPath`; the redundant dynamic `getTranscriptPath` import is gone. Needs one
`/reload` to activate (extension code). Graph: the post-merge refresh was the day's third guard refusal
(net −1, docs-semantic variance) — written with `--allow-partial` after graph-check verified 34/34 modules
and 322/322 symbols.

**#284 MERGED 2026-10-06** — PR #285 (`15f82c6`), closed manually. One long-lived TS7 `API` per worker in
`scripts/ts-ast.mjs`; measured tsgo spawns **92 → 4**, `context canceled` **13 → 0**, suite green, no orphans.
API gotcha for anyone making the adapter long-lived again: the tsgo server caches virtual file content **by
path**, so a reused client must pass `updateSnapshot({ fileChanges: { changed } })` (the per-call client only
avoided it via an empty per-child cache). Wall-clock delta negligible — the win is process churn, noise, and
kill-race surface. Not extension code (scripts/), so no `/reload` needed.

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

**Graph (2026-10-08/09):** the post-#290 refresh was refused a 4th time — and now required **BOTH** force flags
(`--allow-partial`: unverified semantic shrink of `HANDOFF.md`, 25→18; `--allow-dedup-shrink`: 2 merged nodes,
one fuzzy). Forced only after attributing the reduction to docs/reference-side variance (the merge touched
`package.json` + lockfile, no `src/`), then `graph-check.py` re-verified 34/34 modules + 322/322 symbols — graph
now **1490 nodes / 3273 links**. A routine docs-only merge needing manual two-flag reconciliation is the
strongest escalation signal yet; monitoring continues (alternatives recorded: the codegraph bake-off, or an
in-repo `ts-ast` extractor for the critical path). Then the **5th refusal arrived with the Phase 0 bake-off
merge itself (PR #291, docs-only)**: unverified semantic shrink of `FRICTION_LOG.md` (26→12) and `HANDOFF.md`
(16→9) — both files GREW that day, so pure LLM-extraction variance — net −20; forced with `--allow-partial`
only, re-verified 34/34 + 0/322; graph now **1470 nodes / 3271 links**. Window tally: **5 refusals, 0 involving
`src/` structure** — the alternative that cannot exhibit this class shipped its evidence in the merge that
exhibited it. **#6 (2026-10-09, PR #293, docs-only — the durability assessment):** three docs shrank
(FRICTION_LOG 22→7, HANDOFF 10→4, SKILL 30→23), net −15 (1528→1513), again **both flags**; and the mtime
freshness check flagged STALE purely because the auto-sync probe's restored `src/paths.ts` touch bumped its
mtime with content unchanged — the exact class `codegraph-check.py`'s `indexed_at_commit == HEAD` assertion
removes. **Tally: 6 refusals, 0 with `src/` structure; graph now 1513 / 3323.** Post-#294 refresh (2026-10-09):
clean pass, no refusal — variance again. **#7 (2026-10-09, PR #300 plan-doc merge):** HANDOFF 36→7, FRICTION_LOG 21→4, net −35;
**both flags** needed again — and the single-flag force silently no-op'd (caught via `graph.json`'s unchanged
mtime, not the check); forced → **1534 / 3382**, 34/34 + 0/323. **Tally: 7 refusals, 0 involving `src/`.** Earlier day pattern (2026-10-06): 3 refusals (post-#278
dedup → `--allow-dedup-shrink`; post-#279 incomplete docs pass → from-scratch rebuild; post-#286 net −1 →
`--allow-partial` + coverage check) and 4 clean passes. Pre-rebuild 1530-node graph kept at
`graphify-out/graph.json.pre-276-rebuild`.

**[SUPERSEDED 2026-10-10 — ADR 0016: graphify is RETIRED and CodeGraph is the sole structural index. The
codegraph-evaluation + Phase 2 material below is historical; the Phase 2 criteria are moot.]**

**Other candidates (marked, not filed):** the `showSelectList` preselect nice-to-have deferred from #260,
**the next release — user decision 2026-10-08: after dependabot's weekly visit (Saturdays; next 2026-10-10)**,
so one release absorbs any dependabot bumps (urgent/security still interrupts). Saturday is expected to re-open
vitest (`^5.0.0` vs latest 5.0.3) and typebox (`^1.3.34` vs 1.3.36) — triage → merge (bump worktrees +
`npm ci` refresh) → doc cleanup → release ritual; and — **parked 2026-10-06** — the
**codegraph evaluation** (`colbymchenry/codegraph`: MIT, Rust/tree-sitter kernel, local SQLite, MCP + CLI,
no LLM in the extraction path). Front-runner alternative to graphify precisely because graphify's failures are
all in its LLM semantic layer (3 guard refusals on 2026-10-06, thin doc extraction, no true rebuild path,
~$0.2 rebuilds). Bake-off bar if/when picked up: (1) reproduce `graph-check.py`'s coverage (34/34 modules +
322 exported symbols reachable via its JSON/DB), (2) query parity on today's real questions — the re-export
seam (`session-manager.getTranscriptPath` → `transcript-path.ts`) and `setLogCwd`'s callers, (3) determinism
(index twice → identical; incremental sync with no manual intervention), (4) integration cost (`graph-check` +
`graph-refresh` rewrite; explicit `codegraph sync` in the merge ritual, not the watcher — the #230 discipline).
Hold until graphify's monitoring window closes; telemetry off, `.codegraph/` gitignored, pinned version.

**PHASED METHOD (agreed 2026-10-08; user approved Phase 0 execution).** *Phase 0 — bake-off, tool-side only:*
CLI-only (no MCP/agent wiring), pinned install, `DO_NOT_TRACK=1`; index a **scratch clone** of the
repo (NOT the cockpit — ADR 0011's authoritative tree must not carry exploration state; note
`check-repo.sh` filters untracked paths, so a cockpit `.codegraph/` would NOT trip it — that earlier
claim was wrong); run the bake-off bar above plus cost/latency/DB-size; and
cost the **third option** — an in-repo `ts-ast` extractor for the same four queries, reusing `allEdges()`.
Deliverable: findings file + recommendation. *Phase 1 (only if Phase 0 passes):* integration prototype in a
worktree — `.gitignore`, a `graph-check` adapter over its SQLite/JSON, a `graph-refresh` equivalent, skill +
ARCHITECTURE docs. *Phase 2:* side-by-side dogfooding with explicit `codegraph sync` at merges and the watcher
off (the #230 discipline); then the switch decision and an ADR in the 0013/0014 shape.

**Phase 0 RUN 2026-10-08 — PASS on every bar item** (coverage 34/34 + 0/322 in 5ms; query parity incl.
the re-export seam, both directions; byte-identical re-index; docs-only sync a no-op; adapter prototyped).
Findings + prototype: `.development/investigations/codegraph-bakeoff-2026-10-08/` (PR #291, merged
`bf4a628`). **Phase 2 (dogfood) TRIAL RUN (2026-10-08)** — CLI installed pinned via **pnpm global** (`pnpm add -g @colbymchenry/codegraph@1.6.2`; `npm i -g` targets `/usr/local` → needs root on this machine — merged docs/error text corrected in place
the same day). Cockpit indexed: 122 files → 2,272 nodes / 7,797 edges, `.codegraph/` gitignored, porcelain
clean. First dogfood: `codegraph-refresh.sh` green (34/34 + 0/322, "index was built from HEAD"). Query-parity
sample: **12/12** after fixing my comparison methodology (two intermediate passes each had ground-truth artifacts
in opposite directions — the definition-line/definition-file treatment; CodeGraph was correct in all cases).
Caveat found: `is_exported` has false positives (`displayTaskName` is unexported but flagged) — the guard matches
by name, so it is unaffected; do not use the flag as ECMAScript-export truth. **RECONCILED (2026-10-10 — ADR 0015, PR #309 merge `84f6df1`):** the one-off trial above is NOT the formal Phase 2 window. Per ADR 0015, Phase 2 opens at the first post-dependabot merge and runs BOTH refreshes at every merge (`graph-refresh.sh` remains the gate; `codegraph-refresh.sh` shadows it), on the ADR's criteria (refusal rate, sync time, 5–10 query-parity questions; retire/narrow after a week or N merges). The cockpit `.codegraph/` (11 MB, gitignored) is already present from the trial, so the open item is per-merge usage, not adoption. Latest data point: the post-#309 refresh was refused again (#8; docs-only; both flags) — friction entry added. **PHASE 2 (formal) STARTED 2026-10-10** — first data point at the dependabot merge `bad271e`: the graphify gate REFUSED (#9; lockfile-only merge; 149 s; `--allow-partial`) while the CodeGraph shadow passed in 5 s with `indexed_at_commit == HEAD`; window tally 9 refusals / 0 `src/` structure. Phase 2 log: `.development/investigations/codegraph-phase2-dogfood-2026-10-10.md`. Data point #2 (`924a13d`, code merge): gate PASS 71 s; CodeGraph PASS 2 s (380 symbols, `== HEAD`). **PR #311 merged (`924a13d`)** — #298 (partial-vs-settled predicate) + #306 (four review nits) closed; Luna verdict APPROVED with one comment-precision nit, fixed conductor-side (`960dd00`) before merge; suite 66 files / 1349. All pre-release items are closed except **#299** (the documented D6 destination — trigger-based, not scheduled). **RELEASE CYCLE STARTED (2.5.0).** **Graphify RETIRED (2026-10-10)** — ADR 0016 (PR #317, merge `810b444`): hooks, merge driver, CLI, caches and the 41 MB `graphify-out/` removed; the CodeGraph pair is the sole gate, and the first CodeGraph-only post-merge run took **1 s** (39/39 modules, 380 symbols, `indexed_at_commit == HEAD`). #313/#314 closed. **#315 fixed** — PR #316 (merge `42fbb61`; Luna APPROVED at medium thinking, $0.024): one terminal notice per run; crash paths share the claim. Board: **#299** (LOW, trigger-based) + the #316 DRY nit (crash-notice envelope). **#299 Option A merged** (PR #321, `1745c66`; C1 review APPROVED at high — all three mutations caught): marker sweep on the kill paths (`reapActiveChildren` unions `findByMarker` pids; `runSubagent` terminal sweeps) + the `reapPids` early-exit (101 ms vs the 5 s grace). #299 stays open for Option B (non-inheriting gap + the PID-reuse TOCTOU, which B must close with leader identity verification + a Windows fallback). New polish nit filed #322 (test-strength). Board now: **#299** (LOW) + #318 + #322. **DEPENDABOT #310 merged (`bad271e`)** — dev-deps lockfile-only bump; isolated `--force-isolated` suite + tsc + CI green; shared tree refreshed (`npm ci`, 161 packages); worktree cleaned; no strays. Same-day contrast: the post-#292
graphify refresh **passed cleanly, no refusal** (1528/3368, ~$0.06) — same input class as #5's refusal;
variance confirmed. Dogfood window open. **CLI pinned at 1.6.2** (decision 2026-10-08): updates are
deliberate bumps — `pnpm add -g @colbymchenry/codegraph@<v>` → full `codegraph index` → refresh green;
`codegraph upgrade --check` is the awareness command; never `codegraph upgrade` while pnpm-managed.
Install layout: registry route (per-platform optional-dep carrying the vendored Node runtime; no postinstall
script); the GitHub-releases download fallback exists but is unused here.

**[CLOSED 2026-10-10 — ADR 0016: the dogfood window ended in retirement, not narrowing. The Phase 2 log
(`.development/investigations/codegraph-phase2-dogfood-2026-10-10.md`) carries the RETIRED note; the final
report is archived at `.development/investigations/graphify-retirement-2026-10-10/`.]**

**Durability decision (2026-10-09):** delegated design investigation (`pi-durable` fit → PR #293, merge
`5f73608`) — the user approved **Option B (mine the patterns)**: idempotent `dispatchId` + intent-before-effect
run records, `session_start` recovery, per-step checkpoints, a task-graph-style TUI panel (~3–5 C1/C2 PRs),
with Option C (wait/watch) as the revisit trigger for Option A. Falsifiers that would flip to A are in the doc
(pi-durable leaving Experimental AND the published coding-agent depending on it; a spike proving
approval-as-hook + cheap TUI attach; or B's crash harness collapsing). Key evidence: crash → `resume()`
confirmed on SQLite + JSONL; **`resume` ≠ `retry`** — the parked background-retries decision stays open.
Implementation not started; the doc carries the 7-step execution sketch for a future spec. **Probe findings merged
(#294, `75f41b8`):** intent-before-effect already true on both paths; **#295** filed (SIGKILLed foreground
subprocess finalizes as false `done`); **#296** filed (conductor death → orphaned child keeps running, entry
stuck `running`); SDK resume is **file-backed only** (background `inMemory`, foreground `--no-session`) — a
session-persistence decision joins the prerequisites. Next: fix **#295**, then the six decisions → spec. **Option B decision log: D1 LOCKED (2026-10-09) — file-backed sessions, staged **A₁** (persistence + retention, no resume logic; measure) → **A₂** (resume with guards); the torn-write probe addendum resolved the discovery risk.** **D2 LOCKED (2026-10-09) — recovery posture: session-scoped config in `/brl-subagent` (`offer` default | `auto` opt-in | `off`), plus a per-run posture snapshot at dispatch so `auto` survives a session boundary; one recovery path, phased `offer`/`off` → `auto` with its guard block (cost-cap accounting, reap-first, env-exists, per-boot cap, quiet-turn, P4 dedupe).** **D3 LOCKED (2026-10-09) — interrupted state: additive `interruptedAt` metadata on BOTH records (run entry + `.pi/subagents/<id>.json` agent record), status stays `running` (non-terminal, correct for unresolved), centralized `isInterruptedRun` predicate. No new status value: old readers would drop such records (history silently, state with a `Corrupted run entry skipped` warning) and `state.ts:87/111` would misread a fourth value as *resolved*.)** **D4 LOCKED (2026-10-09) — `dispatchId`/`resumeOf`/`attempt` are INTERNAL additive record fields, NOT `delegate_task` params (avoids the schema↔`KNOWN_DELEGATE_KEYS`↔ratchet-chain choreography; exposing them later is additive with no data migration).** **D5 LOCKED (2026-10-09) — v1 scope: detection/marking for all three paths; actions differentiated — background gets resume (A₂) + re-dispatch, foreground gets re-dispatch only (no persistable session), fan-out gets mark + MANUAL re-dispatch. Linkage fields (`batchId`+index) written on units in v1 (cheap, enables Run History grouping); the batch plan record + resume engine are deferred until automatic reassembly is scheduled (≈5–6 units, plus the shared-tree-invalidation and result-semantics decisions — `gitMode: branch` is rejected for fan-out, so all units share one working tree). Auto mode stays phased (D2).** **D6 LOCKED (2026-10-09) — orphan reaping: persist pid + run-id env marker at spawn; kill in-memory pids at shutdown; at boot, verify identity (marker in `/proc/<pid>/environ`, or cmdline+start-time) before SIGTERM→SIGKILL, then mark interrupted; ordering is reap → mark → offer/resume. Grandchildren survive child-only reaping (P2a's `sleep` case) — process-group kill (setsid + persisted pgid) is the TARGETED HARDENING DESTINATION, tracked as issue #299.** **All six Option B decisions are LOCKED (D1–D6, 2026-10-09) — the spec is writable.** **U1 STATUS (2026-10-09 late): PR #301 open — adversarial review verdict `changes-requested` (critical: foreground run records are session-only, so the default fresh boot can't discover them → nothing reaped/marked; majors: unbounded agent-store parse at every session_start, N×grace boot stall). **Fix A BANKED + VERIFIED**: commit `82d6282` (durable `.pi/run-registry/` mirror via a single persist choke point, registry-sourced boot scan, wait-once reap, e2e isolation) — tsc clean, suite 63 files / 1304 tests, no real-store leaks; Fix A's drop-time audit (un-isolated persistRun tests) resolved benignly. **Fix B charter PENDING** (unify the preference rule, revisit already-marked records with live children, `owner:{}` policy, `reapActiveChildren` fixed 5s, `types.ts` doc drift, DRY refactors) → scoped re-review (deepseek-flash, 2026-10-09) **APPROVED** — all 11 dispositions fixed, P2b acceptance proven non-tautological (fails under a registry-source mutation), suite 64/1321, tsc clean, no real-store leaks; **MERGED 2026-10-09 — PR #301 merge commit `7916dad` into dev (no squash); both worktrees cleaned; graph refreshed (39/39 modules, 375/375 exported declarations — no guard refusal this time; the src-heavy merge passed where docs-only merges refused). #296 stays OPEN until the release merge: GitHub's `Fixes` auto-close fires only on the default branch (`main`) — same mechanic as the v2.4.0 batch. RULE-6 CHECKPOINT: U1 alters the extension, so it is NOT active in the running install until a release; live rule-9 verification (C1) is deferred to release time under npm dogfooding / the dev toggle. New minor to fix opportunistically: `src/session-manager.ts:144-146` comment (stale since the registry switch). **LIVE VERIFICATION (2026-10-09, dev toggle + /reload on merged dev): P2b PASSED both halves** — fabricated dead-owner registry entry + live marker child → child reaped (`reaped:[63762]`) and the entry stamped `interruptedAt` (15:14:33.484Z); observed one ~5.0s grace window awaited at session_start during a reap (designed wait-once; an early-exit there is a candidate nit). Side-finding filed #304: the registry mark silently no-ops for ids the UUID guard rejects while the boot log still claims `marked:1` (latent — all real ids are UUIDs; silent failure + decision-not-write ledger). Next per plan: **U2** (U1 → U2 → U3 → measurement gate → U4). **BUG BATCH (2026-10-10, pre-dependabot): #303 + #304 → PR #305 (merge `a10ffe7`); #302 + #308 → PR #307 (merge `aca74b0`).** Both reviewed by the maintainer-chosen `openrouter/~openai/gpt-luna-latest` (adversarial + scoped re-check; #307's review returned CHANGES-REQUESTED once and the fix round caught #308, a commit-reachability regression the leak fix introduced — re-check then APPROVED). Conductor verification on #307: tsc clean, 66 files / 1343 tests, docs-arch 39 modules, detached-worktree runs leave HEAD unchanged + zero strays, CI green. #303/#304/#302/#308 close at the release merge (Fixes keywords fire on the default branch only). Review evidence pinned: `.development/investigations/fix303-304-review-findings-2026-10-10.md`, `fix302-review-findings-2026-10-10.md`, `fix302-recheck-findings-2026-10-10.md`. Release checkpoint unchanged (no release). Next: **U2** when the maintainer is back. Verification findings pinned: `.development/investigations/u1-review-verification-findings-2026-10-09.md`. New nit for the backlog: `src/session-manager.ts:144-146` comment still says boot recovery uses `listPersistedAgents` — stale since the registry switch (comment-only). Review findings pinned: `.development/investigations/u1-review-findings-2026-10-09.md`.** **Plan doc merged: PR #300 (merge `45165a8`) — `.development/PROPOSAL_PLAN-OPTION_B_DURABILITY.md` (units U1–U4; U4 gated on the U2/U3 measurement). Next: U1 spec for approval.**

## Cockpit layout (moved 2026-09-30)

- **The cockpit is the `brl-subagent-dev` checkout** (branch `dev`): `.development/`,
  `.codegraph/` (the structural index), `.pi/` (skills incl. the worktree framework +
  `codegraph-refresh.sh`, guard extension, delegation config)
  and the REAL `node_modules` — the symlink direction is inverted (worktrees symlink to dev now).
- **`main` is the pristine release checkout**: only tracked release files; no deps until a release needs them.
- **The structural index is a dev artifact**: `codegraph-refresh.sh` runs `codegraph sync` + `codegraph-check.py` at every
  merge into `dev` — never as a hook side effect (#230; graphify's hook class retired with the tool, ADR 0016).
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

**Cockpit-move note (2026-09-30; updated 2026-10-10 — ADR 0016):** the release ritual's graph-update step is
**retired** — `codegraph-refresh.sh` keeps the dev structural index current at every merge, so release-time only
VERIFIES (`codegraph-check.py`). Release work now runs from the cockpit; `main` stays pristine.

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

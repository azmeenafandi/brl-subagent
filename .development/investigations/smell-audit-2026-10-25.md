# Smell audit — do lint-level detectors find what our reviews find? (issue #372)

Date: 2026-10-25 · jev: xhigh (0.30) · risk C3 · worktree `exp/smell-audit`
Issue: [#372](https://github.com/azmeenafandi/brl-subagent/issues/372) · source: habit-hooks (mechanic only — no adoption)

**Verdict: the detectors find real smells, but not the ones our reviews find — and the ones they
find are a *backlog*, not a *stream*.** All four detectors together caught 3 of the 13 smell-class
findings in the review corpus (`pr353`–`pr371`) and missed every semantic class (test pins, prose
drift, encapsulation, vocabulary/chokepoint). What they *did* find is an 11-cluster DRY backlog in
`src/` that no diff-scoped review could ever see, including the triplication of `runChainMode` /
`runParallelMode` / `runGraphMode`. A replay of the duplication detector over 29 historical commits
shows that smell is *born*, not *lived with*: 5/29 commits introduced a clone, and the trigger is a
new feature/mode commit, not a routine PR. On the three most recent `src/`-touching PRs the detector
fired **0 times inside a changed hunk** — correct silence, but no evidence of value either.

**Recommendation: do not build the write-time coaching nudge this cycle.** Spend the finding
instead: one sweep issue for the 11 duplication clusters, and adopt habit-hooks' *vocabulary + guide
structure* into the review dispatch and `AGENT.md` (zero runtime, zero deps). The extension shape,
the 3–4 smells that would carry it, and the latency/cost budget are specified in §8.3–8.4 so the
decision is cheap to reopen when a trigger-rate estimate actually justifies it.

Constraints honoured: no dependency adoption, no committed jscpd/ESLint config, no CI change, no
code fix. All scratch lives under `/tmp` (`/tmp/smell-*`); the only worktree change is this report.

## 1. Method

Environment: node 24.14.1 · npm 11.11.0 · Linux x64 · `npx` and network available (both detectors
installed/ran; the escape clause was not needed).

| Detector | Version | Scope | Scratch |
|---|---|---|---|
| `jscpd` (duplication) | `@latest` via npx | `src/`, `**/__tests__/**` ignored | `/tmp/smell-jscpd{,-low,-weak}`, `/tmp/smell-hist-jscpd` |
| AST probe (own, throwaway) | imports the repo's `scripts/ts-ast.mjs` (TS 7 sync API) | `src/**/*.ts` minus tests, 41 files | `/tmp/smell-probe/ast-probe.mjs` |
| `eslint` flat config (`max-params`, `max-depth`, `complexity`, `max-lines-per-function`) | 9.39.5 + `typescript-eslint` 8.72.0, installed under `/tmp/smell-eslint` | same 41 files | `/tmp/smell-eslint` |
| history replay (own) | jscpd over each commit's materialised `src/` + that commit's added-line ranges | 29 commits | `/tmp/smell-probe/replay.py` |

The AST probe is the only artefact worth keeping a copy of; it is reproduced verbatim in appendix A.
It uses `SourceFile.forEachChild` — the TS 7 node view exposes it per node (there is no root
`forEachChild` export), so the probe needs no walker of its own.

Every detector finding was then read in the source and judged TP/FP. Findings were also re-run
**scoped to a PR's own changed files and added-line hunks** (the write-time-coach question), for
`pr355`, `pr362`, `pr370`.

## 2. Duplication (`jscpd`)

```sh
npx jscpd@latest src --format typescript --ignore "**/__tests__/**" \
    --min-lines 10 --min-tokens 70 --reporters json --output /tmp/smell-jscpd
```

```text
28 clones · 671 duplicated lines · 3,655 duplicated tokens
21,329 lines / 91,057 tokens scanned across 40 sources · 3.15% lines · 4.01% tokens
wall 1.8 s
```

`--mode mild|weak` produced byte-identical output at this threshold (every fragment already `exact`);
the mode flag is not a near-duplicate knob here and was dropped.

### 2.1 The 28 fragments are 11 smells

Raw jscpd output is unusable as coaching input: 28 rows, many of them overlapping fragments of the
same block (one 120-line prologue produces 5 rows). Grouped by concept, and each read in the source:

| # | Files:lines | Payload class | Rows | Verdict |
|---|---|---|---|---|
| D1 | `index.ts:492-577` ↔ `1015-1092`, `1505-1592`, `2089-2111` | mode prologue: cost gate → depth gate → `resolveSubagentParams(params as {…13 fields…})` → cwd/preflight/pre-task gates. The **cast literal** from the issue lives here | 1,2,3,4,5,8,10 | **TP (high)** — three modes copy ~120 lines each; the 13-field cast literal appears **5×** (`index.ts:513,1036,1526,2090` and the `renderCall(args:)` copy at `:3852`, which drops `preset`) and is compiler-unchecked by construction |
| D2 | `index.ts:627-665` ↔ `1139-1177`, `1601-1640` | per-unit pre-pass: merge → validate targets → `runPreTaskValidation` → warnings | 6,7 | **TP (high)** — same function body under 3 names (`stepPrefix` / `taskPrefix` / `nodePrefix`) |
| D3 | `index.ts:827-839` ↔ `1283-1295` | `SubTaskResult` field copy (10 assignments + `classifyError`) | 9 | **TP (med)** — needs `toSubTaskResult(result)` |
| D4 | `index.ts:1677-1691` ↔ `1780-1794` | graph node → `SubTaskParams` field mapping, twice in one function | 11 | **TP (low)** — one of them builds a `SubTaskParams` object that a spread would do |
| D5 | `params.ts:86-102` ↔ `types.ts:354-376` | the "snapshot fields" type literal (16 fields) declared twice | 12 | **TP (low)** — type-level; `pr362` reviewed *exactly these fields* and did not see the second copy |
| D6 | `presets.ts:149-164` ↔ `229-243`, `presets.ts:204-217` ↔ `templates.ts:206-219`, `templates.ts:243-258` ↔ `308-324` | preset/template loader: dir list → readdir → `.md` filter → frontmatter → validate → normalise into the record | 13,14,18 | **TP (high)** — two loader families, four copies of the normalise block |
| D7 | `schema.ts:194-204` ↔ `217-228`, `schema.ts:209-228` ↔ `235-254` | the 11-field per-unit schema (`chain[]` / `tasks[]` / `graph[]`) written three times | 15,16 | **TP (high)** — the single most mechanical fix in this report: one `stepFields()` |
| D8 | `session-manager.ts:1149-1173` ↔ `1286-1309` | aborted-run result block in `.then()` vs `.catch()` | 17 | **TP (med)** — the code's own comments say "same aborted path semantics as the .then branch" |
| D9 | `tui.ts:509-532` ↔ `567-583`, `640-656`, `689-705` | the "lines modal" boilerplate (border → title → blank → dim lines → border → render/invalidate/q) | 20,21,22 | **TP (high)** — 4 report screens × 24 lines; a `showLinesModal(ctx, title, lines)` collapses all four |
| D10 | `tui.ts:2524-2537` ↔ `2551-2568`, `2595-2647` ↔ `2674-2726`, `2668-2706` ↔ `3104-3142`, `2712-2736` ↔ `3149-3169`, `3214-3224` ↔ `3230-3240` | chain/parallel/graph renderers: collapsed step line, expanded per-result block, aggregated totals, `delegate_task` call-preview loop | 23,24,25,26,27,28 | **TP (high)** — `renderExpandedChain` and `renderExpandedParallel` differ only in the header and a status label |
| D11 | `tui.ts:104-122` ↔ `1294-1312` | the 19-line select-list boilerplate (border → title → `SelectList` → `onSelect/onCancel` → footer → render/handleInput) | 19 | **TP (high)** — `showConfigMenu` inlines it while `showSelectList`, 1000 lines above, already provides it: a helper **bypassed**, not missing |

**TP/FP: 28/28 fragments, 11/11 clusters, true positive.** Not one cluster is an artefact. But that
is a statement about *this* codebase, which has a large DRY backlog — not about jscpd's precision in
general (see §2.2).

### 2.2 Threshold sensitivity — and why 10L/70t is the right setting here

| `--min-lines`/`--min-tokens` | Clones | Duplicated lines | Share | Assessment |
|---|---:|---:|---:|---|
| 10 / 70 | 28 | 671 | 3.15% | 11 distinct smells, all TP |
| 4 / 30 | 172 | 1,905 | 8.92% | 64 fragments re-report the 11 clusters; 17 are pure type/field-list fragments; ~25 are 2–3-line call idioms (`container.addChild(...)`, `log.warn(...)`, `details: undefined,`) |

The only *new* concept the 4/30 run adds is **`git.ts:141-217` — `switchToBranch` / `restoreHead` /
`mergeWorkBranch` / `deleteBranch` / `commitAll`**, five thin wrappers around
`try { execFileSync("git", …); return {ok:true} } catch { … }`. Judged **FP**: the repeated shape *is*
the API surface; each wrapper carries its own typed return and docstring, and a generic `runGit()`
would trade five documented commands for one string-typed one. That single judgement settles the
tuning question — below 10/70 the run starts buying wrapper families with false positives.

### 2.3 What jscpd structurally cannot see

- **Prose duplication.** Each string literal is **one token**, so two near-identical paragraphs score
  2 tokens and can never form a clone. Verified: neither the 10/70 nor the 4/30 report contains a
  fragment with `retryOnTimeout` — yet `src/index.ts:2866` (tool guideline) and `src/schema.ts:141`
  (schema description) carry the same paragraph, which is exactly the DRY finding `pr370` banked.
- **Single-token vocabulary.** The inlined `✓`/`✗` glyph class from `pr355` is one literal per line —
  invisible at any `min-lines`.
- **Short repeated shapes.** `validate.ts:214 diagnoseFailure` is 7 copies of
  `test → suggestions.push("…")`; each copy is 4–5 lines, so it is below the token floor, and its
  variation is data, not text. The most coachable shape in that function is the one jscpd can't see.
- **Call-site vocabulary.** The 14 repaint call sites (`issue #356`) are one-line calls to a function
  that already exists. Duplication detectors have nothing to say about *"the same call, 14 times, in
  a function that should own it"*.

## 3. AST probes

```sh
node /tmp/smell-probe/ast-probe.mjs          # human table, 41 files, 0.22 s
node /tmp/smell-probe/ast-probe.mjs --json   # machine dump used for the tables below
```

### 3.1 Files > 500 lines (6)

```text
 4393  src/index.ts
 3324  src/tui.ts
 1371  src/session-manager.ts
 1279  src/runner.ts
 1165  src/types.ts
  721  src/state.ts
```

**TP as structure, low actionability.** `src/index.ts` is one `export default function (pi)` closure
spanning lines 238–4392; the file size is the *output* of that, not an independent problem. No review
in the corpus ever cited it (diff-scoped reviews cannot).

### 3.2 Function bodies > 40 lines (90 fragments → 70 distinct)

90 fragments overstate the count by 20: a body nested inside another *flagged* body is counted twice
(`tui.ts:1794 showAgentDetail` 216 L contains a 200 L `<callback>`; `tui.ts:1414` contains 180 L).
Collapsed by span containment — the extension-wide closure excepted, since it would swallow nearly
every function in `index.ts` — **70 distinct**, banded 41–60 L ×30, 61–100 L ×24, 101–200 L ×6,
>200 L ×10.

26 fragments are over 100 L and collapse to **16 distinct functions**; the other 10 are long *nested*
bodies inside an already-listed parent (`runTask` 172 L inside `runParallelMode`, `buildView` 162 L
inside `showAgentDetail`, the abort/timeout settle callback 152 L inside `spawnBackgroundSession`).
Three of those nested ones are listed below too — a 170-line helper inside a 470-line function is the
finding, not a rounding error.

Every function over 100 lines, with the issue's four thresholds:

| Location | Name | Lines | Params | Depth |
|---|---|---:|---:|---:|
| `src/index.ts:238` | `<default-export>` (the whole extension) | 4155 | 1 | 1 |
| `src/index.ts:2886` | `execute` (the `delegate_task` handler) | 966 | 5 | **6** |
| `src/session-manager.ts:474` | `spawnBackgroundSession` | 897 | 3 | 4 |
| `src/index.ts:1465` | `runGraphMode` | 594 | 4 | 4 |
| `src/index.ts:467` | `runChainMode` | 522 | 4 | 3 |
| `src/index.ts:994` | `runParallelMode` | 466 | 4 | 2 |
| `src/index.ts:2320` | `startBackgroundAgent` | 276 | 3 | 0 |
| `src/index.ts:2069` | `runBackgroundFanOut` | 240 | 4 | 3 |
| `src/runner.ts:1049` | `runSubagent` | 230 | **15** | 3 |
| `src/tui.ts:1794` | `showAgentDetail` | 216 | 3 | 0 |
| `src/tui.ts:1414` | `showRunDetail` | 183 | 2 | 0 |
| `src/index.ts:1187` | `runTask` | 172 | 3 | 1 |
| `src/tui.ts:1811` | `buildView` (inside `showAgentDetail`) | 162 | 0 | 4 |
| `src/index.ts:2602` | `spawnBackgroundRun` | 156 | 5 | 2 |
| `src/session-manager.ts:1125` | `<callback>` (abort/timeout settle) | 152 | 0 | 3 |
| `src/tui.ts:1602` | `showMonitor` | 145 | 2 | 1 |
| `src/tui.ts:2736` | `showApprovalDialog` | 145 | 4 | 0 |
| `src/params.ts:195` | `resolveSubagentParams` | 125 | 4 | 2 |
| `src/tui.ts:1150` | `getConfigMenuItems` | 118 | 1 | 0 |

Reading the 16 distinct ones: **TP 16/16** — each is genuinely multi-responsibility, and the top 6
are multi-*mode* multi-responsibility (D1/D2 in §2.1 are the same defect seen from another angle).
The count itself does not survive as a target either: `execute` (966 L) is one tool handler and
`<default-export>` (4155 L) is one closure — both are *correct* answers to "how much does this thing
do", which is why the sweep in §8.5 orders by design change, not by line count.

Reading a 10-item sample of the 41–60 L band: **TP 4 / FP-ish 6**. The FPs are the interesting part:

- `tui.ts:2277 showDashboard`, 59 L — the *product* of `pr358`'s split; six `append(render…Panel(…))`
  calls and one interval. `pr358`'s own verified-OK section reads "composer ~63 lines, slices computed
  once, no panel logic left". A 40-line threshold flags the fix, not the defect.
- `tui-format.ts:144 formatProgressSegments`, 44 L — created by `pr355`, verified token-for-token by
  that review. Three segments, each commented.
- `validate.ts:214 diagnoseFailure`, 76 L — seven independent rule blocks. "Too long" is the wrong
  framing; the right framing (table-driven rules) is invisible to every detector here.
- `git.ts` wrappers (§2.2), `mergeSubTaskParams` (63 L: one `??` merge + a tool fix-up — TP-lite).

### 3.3 Functions with > 4 params (19)

| Location | Name | Params | Body |
|---|---|---:|---:|
| `src/runner.ts:1049` | `runSubagent` | **15** | 230 |
| `src/unit-run.ts:208` | `finalizeUnitRunCrash` | 8 | 29 |
| `src/kill-escalation.ts:252` | `groupTarget` | 6 | 61 |
| `src/kill-escalation.ts:319` | `processTarget` | 6 | 12 |
| `src/notify-completion.ts:102` | `buildSummaryLine` | 6 | 14 |
| `src/prompt.ts:117` | `buildSubagentPrompt` | 6 | 43 |
| `src/transcript-tail.ts:163` | `blockLines` | 6 | 17 |
| `src/tui.ts:2430` | `renderExpandedResult` | 6 | 40 |
| `src/unit-run.ts:174` | `finalizeUnitRun` | 6 | 16 |
| + 10 functions at exactly 5 | `spawnBackgroundRun`, `execute` ×3, `dispatchIfOwned`, `emitLiveUpdate`, `parseSubagentLine`, `updateLiveSubagent`, `renderCollapsedText`, `createUnitRun` | 5 | 13–966 |

**TP 1 clear, 8 TP-lite, 10 FP-by-convention.** `runSubagent(signal, onUpdate, state, ctx, params…,
log)` with 15 positional arguments is a real defect (a `DispatchContext` is missing). Everything else
is the repo's deliberate shape: a fixed `(input…, log?)` / `(theme, mdTheme, …)` tail. `kill-escalation`'s
`groupTarget` (6) is `(pid, ...)` + identity + log — mechanical, and an options object there would add
indirection for no named concept. Trustworthiness of this class as a coach: low.

### 3.4 Nesting depth > 3 (19 functions)

Depth 6: `index.ts:2886 execute`, `presets.ts:197 loadCustomPresets`, `reports.ts:228
buildSecretsExposureReport`, `templates.ts:199 loadCustomTemplates`. Depth 5: `presets.ts:128
loadBuiltinPresets`, `scheduler.ts:76 topologicalSort`, `session-manager.ts:938 cleanupWorkBranch`,
`templates.ts:276 loadBuiltinTemplates`, `types.ts:820 getFinalOutput`. Depth 4: 10 more.

**TP 9, FP 10.** The 4-band is mostly idiomatic TypeScript guard nesting: `types.ts:820
getFinalOutput` is `for → if → if → for → if` (14 lines) reading `messages[].content[].type === "text"`
— five levels, no ambiguity, nothing to extract. `topologicalSort` (Kahn) and `cleanupWorkBranch`
(lock-release on every exit) are TP-ish but the extraction the guide recommends is the same extraction
D6/D8 already call for. `loadCustom*` at 6 is a genuine TP, and it is the *same* function the
duplication detector flags — the two detectors converge on one fix.

### 3.5 Cross-check: ESLint agrees exactly

`max-params` flagged **19 functions, the identical set** (same file, same line). `max-depth` flagged
**49 sites**, and every one falls inside exactly one of the probe's **19 functions** (containment
checked programmatically; 19/19, 0 orphans). Two independent implementations, one answer — useful
because it means the probe's numbers aren't a bug in the probe.

`max-lines-per-function` disagreed by design: ESLint ignores blank lines and comments
(`skipBlankLines/skipComments: true` in my config), so `index.ts:238` is 2975 lines to ESLint and 4155
to the raw-span probe. The probe's `--json` numbers are the ones quoted above; note the gap when
comparing to any lint-derived figure.

## 4. ESLint pass (ran; kept because it was cheap)

```sh
mkdir -p /tmp/smell-eslint && cd /tmp/smell-eslint
npm i --no-save eslint@9 typescript-eslint          # 5.5 s, no repo change
eslint --no-config-lookup --config /tmp/smell-eslint/eslint.config.mjs \
       --format json "$(find src -name '*.ts' -not -path '*/__tests__/*')"
```

Config: `max-params: 4`, `max-depth: 3`, `complexity: 15`,
`max-lines-per-function: {max: 40, skipBlankLines: true, skipComments: true}`.

| Rule | Findings (41 files) |
|---|---:|
| `max-lines-per-function` | 72 |
| `max-depth` | 49 sites / 19 functions |
| `complexity` | 41 |
| `max-params` | 19 |

Wall: **2.4 s** for all 41 files; **0.41 s** for `params.ts`, **0.60 s** for `tui.ts` (3324 lines).
The friction was nil — `--no-config-lookup` + a config under `/tmp` means nothing in the repo moved —
so the "timebox, skip if painful" branch never triggered.

Complexity's top of the table is where the value is: `execute` 111, `buildView` (tui) 55,
`isSubagentStateShape` 43, `resolveSubagentParams` 39, `validatePreTask` 36, `resolveRetryParams` 35,
`buildCompletionMessage` 35, `spawnBackgroundSession` 35, `formatMenuValue` 35. Every one of those is
a function the body-length probe also flagged — `complexity` re-ranks, it doesn't add recall.

**Threshold calibration, measured.** Applying habit-hooks' own shipped TypeScript thresholds
(`max-lines-per-function: 12`, `max-params: 3`, `complexity: 10`, `max-depth: 4`, `max-lines: 200`)
to the same 41 files:

| Thresholds | Findings |
|---|---:|
| this repo's calibrated set (40 / 4 / 15 / 3) | **181** |
| habit-hooks shipped TS defaults (12 / 3 / 10 / 4) | **444** |

The tool's defaults are 2.5× louder than the set I judged above, and the set I judged was already
half false positives in the 41–60 L band. A coach cannot be shipped at habit-hooks' defaults onto
this repo.

## 5. When is a duplicate *born*? (history replay)

The three PRs I re-ran (§6.2) are recent, small and review-hardened — a bad estimate of the
steady-state trigger rate. So the same detector was replayed over history: materialise `src/` at each
commit, run jscpd at 10/70, and ask whether any clone fragment overlaps a line that commit *added*.

| Commit sample | n | Commits with ≥1 in-hunk clone |
|---|---:|---:|
| The 8 most recent `src/` commits (`a96570e`…`5c84c4d`) | 8 | **0** |
| Every 25th `src/` commit across 358 | 14 | **0** |
| Commits that *introduced* a known cluster (`1fe9df9` reports, `f3ba985` chain/parallel rendering, `9cf8748` custom presets) | 3 | **3** (3, 3, 1 clones) |
| The 5 commits with the largest `src/` additions (`8a2b7a0` 7787 L … `7a7538c` 1070 L) | 5 | **2** (`987657a` 4, `7a7538c` 2) |

29 distinct commits, 5 fired. Excluding the three hand-picked positives: **2/26 ≈ 7.7%**, and both
were large feature commits — most recently `7a7538c "background fan-out for tasks mode (#198)"`
(2026-09-22), which added the `runBackgroundFanOut` copy of the mode prologue. The clean-fire commits
are the ones that introduce a *fourth* copy of an existing block: a new mode, a new report screen, a
new loader family.

That is the habit-hooks thesis in one table: the cue does not need to fire often, it needs to fire
**when the copy is made**. It also bounds the value — a repo in steady state fires almost never, and
this repo has been in steady state for five weeks.

## 6. Comparison against the review corpus

Sources: `pr353`, `pr355`, `pr357-358`, `pr362`, `pr369`, `pr370`, `pr371` review records, plus
`test-audit-2026-10-24.md` and the examples named in the issue. Every smell-class finding in those
records, and whether the detector stack catches it:

| # | Known finding (source) | Class | Caught? |
|---|---|---|---|
| K1 | §STATE range-scan loop duplicated in `extractStateSection` / `replaceVerified` (`pr353` F2, `.pi/extensions/handoff/lib.ts:69-87,189-199`) | DRY | **Caught — but only outside the prescribed scope.** Replayed the pre-fix file (`git show 5647d78^`): exactly **1 clone, 12 L / 96 t, `lib.ts:70` ↔ `:189`** at 10/70. The issue's command scans `src`, where the same file scores **0** — the only DRY finding our reviews made in that period sits outside the prescribed scope. |
| K2 | pre-split `showDashboard` ~191 lines (`pr357-358`, `e71dc62:src/tui.ts:2031`) | oversized function | **Caught.** ESLint `max-lines-per-function` reports **191** at `e71dc62` (probe: 200 L). Note the same rule still fires on the extracted composer at HEAD (59 L) — the split could not silence it, which is the calibration problem in one line. |
| K3 | `runBackgroundFanOut` cast literal (`index.ts`; issue #372 example) | repeated type literal | **Caught.** Cluster D1 pairs the literal across two mode copies (`index.ts:512-534` ↔ `2089-2111`) and pairs a third copy against `params.ts`'s signature. It points at the defect without enumerating it: 2 of the 5 occurrences are paired, the `renderCall(args:)` copy at `:3852` is never paired. |
| K4 | `retryOnTimeout` prose duplicated verbatim, tool guideline vs schema description (`pr370`, `src/index.ts:2866` ↔ `src/schema.ts:141`) | repeated prose | **Missed** — string literals are single tokens (§2.3); verified absent from both the 10/70 and 4/30 reports. |
| K5 | inlined `✓`/`✗` glyphs before `formatOutcomeSymbol` (`pr355` F1; 1 code literal survives at `tui.ts:2366`) | repeated literal / vocabulary | **Missed** — one token per line; no enabled rule looks at string content. |
| K6 | 14 repaint call sites with no chokepoint (`pr357`, issue #356) | vocabulary / single owner | **Missed.** Call sites are 1-line; nothing in jscpd or the four ESLint rules reasons about "same call, N places". (A `no-restricted-syntax` callee rule catches this class — bespoke, one line of config, not a smell rule.) |
| K7 | `productionSources()` non-recursive; alias evades the call-paren regex (`pr357`) | guard weakness | **Missed** — semantic. |
| K8 | `updateStatus` exported without `@internal` (`pr357`) | encapsulation | **Missed** — semantic. |
| K9 | `session_shutdown` body untested; tests mirrored it (`pr355`) | test smell | **Missed** — the detectors have no notion of a pin. |
| K10 | `recording-theme` colour test covered the rich fixture only (`pr358`) | test smell | **Missed.** |
| K11 | `markInterrupted` idempotence unpinned (`pr369` M2 survivor) | test smell | **Missed.** |
| K12 | doc/predicate drift: `resolveEffectiveApprovalMode` header names a non-existent "preset" tier (`pr362`), the `.5` confidence comment (`pr371`), the ARCHITECTURE "not auto-retried" line (`pr370`) | doc drift | **Missed** — semantic (three findings, one class). |
| K13 | ratio-breach message omits the report path while the wall message names it (`pr369`) | message inconsistency | **Missed.** |

**3 caught / 10 missed**, and 2 of the 3 caught are "measurable shape" smells. Of the 10 misses, 7 are
semantic (K7–K13), 2 are *tokenisation* misses (K4, K5) that a bespoke rule could cover and a generic
linter cannot, and 1 (K6) is the cross-cut vocabulary class no generic rule is even aimed at.

### 6.1 The inverse direction: smells no review named

Everything in §2.1 (11 clusters), §3.1 (6 files), §3.2 (>100 L functions) is **detector-only** — no
review in the corpus mentions any of it. That is not reviewer sloppiness: those reviews are
diff-scoped by design, and the defects predate every PR they reviewed. The one exception is D5
(`snapshotOriginalParams` ↔ `originalParams`), which sits inside `pr362`'s own diff and was not seen.

### 6.2 The write-time question, measured three ways

For each PR, detectors re-run over **only the PR's changed `src/` files**, then filtered to the PR's
**added-line hunks**:

| PR | Changed `src/` files | ESLint findings (file scope) | ESLint in-hunk | jscpd clones (file set) | jscpd in-hunk |
|---|---|---:|---:|---:|---:|
| #370 transport auto-retry | `index.ts`, `schema.ts`, `transport-retry.ts` | 37 | **0** | 12 | **0** |
| #362 background default | `index.ts`, `params.ts`, `schema.ts` | 39 | **0** | 13 | **0** |
| #355 footer activity | `concurrency.ts`, `index.ts`, `state.ts`, `tui-format.ts`, `tui.ts`, `types.ts` | 85 | **1** (`tui-format.ts:144`, 44 L) | 20 | **0** |

Read the two ways:

- **As precision, it is good news.** All three reviews banked **0 SOLID/DRY violations**. On the hunks
  the detectors were silent too, with one exception — and the exception is the false positive:
  `formatProgressSegments` (44 L) is the function `pr355` *created* and verified token-for-token.
- **As recall, it is no evidence at all.** Nothing in those three diffs is a smell the detectors can
  see, so 0-in-hunk is a true negative, not a proven capability. The only positive cases available are
  historical (§5's three commits; K1, K2), and all of them were caught.

**File scope is not viable.** At file scope the same three PRs produce 37 + 39 + 85 ESLint findings
and 12 + 13 + 20 clones — **~206 findings, 0 of them caused by the PR** (§6.2 column 3 vs 4). A coach
that reports 49 pre-existing smells on a 55-line diff is a coach the agent learns to ignore.

## 7. Signal vs noise — consolidated tally

| Detector | Findings | TP | FP | Basis |
|---|---:|---:|---:|---|
| jscpd 10/70 | 28 fragments → 11 clusters | 28 (11/11 clusters) | 0 | every cluster read |
| jscpd 4/30 | 172 fragments | ~0 new | 1 new family (`git.ts` wrappers) + 64 re-reports + 17 type-literal fragments | threshold sweep |
| bodies > 40 L | 90 → 70 distinct | 16/16 in the >100 L band; 4/10 in the 41–60 L sample | 6/10 in the 41–60 L sample | read top 16 + a 10-item sample |
| params > 4 | 19 | 1 clear + 8 TP-lite | 10 (deliberate `(…, log)` tails) | all read |
| depth > 3 | 19 | 9 | 10 (idiomatic guard nesting at depth 4) | all read |
| files > 500 L | 6 | 6 (as structure) | 0 | all read |
| ESLint `complexity` > 15 | 41 | re-ranks known TPs | adds no recall (all 41 overlap another class) | top-10 read |
| **in-hunk, 3 recent PRs** | 1 | 0 | 1 | read |

Two judgements worth carrying forward:

1. **False positives are not random — they concentrate where the reviews did their job.** The two
   loudest FPs (post-split `showDashboard` 59 L, `formatProgressSegments` 44 L) are the two artefacts
   two separate reviews explicitly certified as well-factored. A nudge that argues with the finished
   review is worse than no nudge: it teaches the agent that the numbers are noise.
2. **Duplication is the only class where the detector beats reading.** Every other class is either
   re-detected by the review anyway (oversized bodies, at the top of the distribution) or undetectable
   (K4–K13). jscpd's 11/11 cluster precision is the one place the machine sees something a reviewer
   structurally cannot: the copy that lives 900 lines away, or in another file, written three months
   ago.

## 8. Recommendation

### 8.1 Verdict

**Do not build a write-time coaching nudge this cycle.** Three reasons, in order of weight:

1. **Measured trigger rate is ~0 for the work we actually ship.** 0 in-hunk hits on the last three
   `src/` PRs; 0/21 on an unbiased history sample; 2/26 when deliberately hunting. The coach would sit
   idle through a normal week and interrupt a big feature week — the opposite of the habit-forming
   cadence habit-hooks relies on.
2. **What it *would* catch is a backlog, not a stream.** The 11 clusters are 3 commits old
   (2026-07-06 → 2026-09-22). Fixing them is one sweep; after that the detector has nothing to say
   until the next new mode. A sweep is conductor-side delegation work, not a runtime extension.
3. **The FP class is expensive and lands on good code.** At the thresholds that produce >0 recall,
   half the 41–60 L band is false, and the FPs are the functions our reviews just certified. At
   calibrated thresholds (§8.2) it is silent — i.e. safe, but also useless as a nudge.

The counter-argument, stated fairly: habit-hooks' evidence is about *phrasing* (83.3% genuine fix with
coaching vs 5.6–28.9% with a bare metric), and our subagents currently get no in-flight signal about
structural smells at all — only a post-run review, in a different session. So the *mechanism* is
sound. What is missing is a smell that recurs often enough to coach.

### 8.2 The 3–4 smells that would carry it (if built)

Only these, with the thresholds calibrated from §3.2–3.4 (none of them fires on the three PRs above):

| Smell key | Detector | Threshold | Findings repo-wide | Why it qualifies |
|---|---|---:|---:|---|
| `duplicated-code` | jscpd 10 L / 70 t, filtered to fragments touching the edit | as-is | 11 clusters | 11/11 TP; the one class reviews can't see; the only class with a validated birth event (5/29 commits) |
| `oversized-function` | AST span | **≥ 120 lines** (not 40) | 16 (distinct, >100 L) | 16/16 TP above 100 L; at 40 L half the band is FP |
| `deep-nesting` | AST depth | **≥ 5** (not 3) | 9 | depth 4 is idiomatic guard nesting in this codebase (10 FP) |
| `too-many-parameters` | AST | **≥ 6** (not 4) | 9 | only `runSubagent` (15) is unambiguous; ship as `suggested`, never failing |

Deliberately excluded: `high-complexity` (re-ranks, adds no recall), `oversized-file` (nothing
actionable a coach can say about `index.ts` that a human issue can't), and every semantic class in
K7–K13 — those belong to the review, and pretending a linter covers them is how the review gets
weaker.

### 8.3 Extension shape and budget

Shape if the decision is ever reopened — a pi extension, not a habit-hooks integration:

```text
.pi/extensions/smell-coach/                 (~350 lines + tests)
  index.ts       tool_result handler + settle hook
  detectors/
    ast.ts       import scripts/ts-ast.mjs → parse the changed file, run the 4 probes   (~35 ms/file, in-process)
    clone.ts     spawn jscpd over src/ *only* at settle, cached by src mtime            (~1.8 s per invocation)
  coach.ts       smell key → guide text (the guides are prose files, one per smell)
  state.ts       debounce + dedupe (path + content hash + smell key), per session
```

- **Trigger.** `pi.on("tool_result", …)` on `write`/`edit`/`patch` results. The handler composes — text
  appended to the tool result is shown to the model on the next request — so the nudge lands **in the
  writing agent's own context**, mid-run, before the next edit. That is the property habit-hooks buys
  from Claude Code's `PostToolUse` hook, and pi already exposes it (`docs/extensions.md`: "Redact,
  annotate, or replace a tool result → `tool_result`").
- **Scoping.** Hunk-scoped, not file-scoped (§6.2): run the AST probes on the changed file, but only
  report findings whose `startLine` falls inside the edit's added range. jscpd output is filtered the
  same way. Anything else is pre-existing backlog and gets dropped — this is the difference between
  1 finding and 49.
- **Debounce.** AST probes per edit (cheap). Clone check at most once per **settle** or per 30 s of
  edit quiescence — it needs the whole `src/` corpus anyway.
- **Dedupe.** `(path, contentHash, smellKey)` per session; a smell that fired once does not fire again
  for the same content. This is the same content-aware dedupe `handoff` already implements.
- **Injection text.** One guide per smell, ~250–400 tokens (habit-hooks' `oversized-function` guide is
  ~1.3 KB). Cap at one smell per edit, highest severity first; two cards in one tool result reads as
  noise.
- **Foreground only (assumed, not verified here).** A spawned foreground child loads project
  extensions, so `tool_result` should reach the writing agent; fan-out units are foreground spawns, so
  the same path should apply. Background agents are in-process SDK sessions that, per `pr353`'s
  verified Check 4, do not emit the host's session events at all — so a coach built on `tool_result`
  would likely be **inert for background agents**, which is where most writes happen under the
  current default (`background` is the conditional `auto` path per `pr362`). The first probe for any
  implementation would be the `pr353` Check 4 pattern: does the hook fire inside a child at all, and
  in which of the two hosting models. This is the strongest practical argument against building it
  now: the dominant write path may have no hook.

**Budget:**

| Item | Cost |
|---|---|
| AST probes, 1 changed file (`tui.ts`, 3324 L) | **26 ms** parse + **8 ms** walk (measured) |
| AST probes, whole `src/` (41 files) | **0.22 s** in one process (measured) |
| jscpd over `src/` (spawn + parse) | **1.8 s** wall (measured, warm npx cache) |
| ESLint, one file | **0.41–0.61 s** (measured) — skip it; the AST probe answers the same 4 questions for free |
| Injected tokens per nudge | ~250–400 (one guide card) |
| Nudges at the measured rate | 7.7% of `src/` commits; the repo runs ~80 (lifetime) to ~150 (last month) `src/` commits/month → **6–11 nudges/month, 75–135/year** |
| Injected tokens per year (above) | 75–135 × 300 ≈ **25–40 k tokens/year** — negligible; cost is not the deciding factor, **cadence** is |
| Engineering | ~350 LOC + tests + a threshold/guide corpus ≈ one cycle, plus the standing cost of triaging FPs |
| **Value** | Not measurable now: 0 in-hunk hits on the last 3 PRs, and the backlog it *would* have caught is better spent as a sweep |

### 8.4 What to borrow even without the tool

habit-hooks' smell vocabulary and guide structure are the durable part, and they cost nothing:

1. **The vocabulary.** `oversized-function`, `too-many-parameters`, `deep-nesting`, `duplicated-code`,
   `oversized-file` — tool-independent **smell keys**, so a finding is named by the *problem* and not by
   the rule that found it (their `max-params` / `PLR0913` → `too-many-parameters` normalisation). Two
   uses here: the review dispatch can ask for findings **by smell key**, making review records
   comparable across PRs (today "SOLID/DRY violations flagged: 0" is a single un-typed counter), and
   the friction log / test-audit can count by key instead of prose.
2. **The guide shape** — problem → why it matters → numbered moves → **AVOID** (the anti-Goodhart
   paragraph) → a concrete technique. Worth quoting into the review dispatch, because the AVOID clauses
   are precisely what our own review findings keep saying in prose: *"Avoid mechanical extraction…
   pulling matching lines into a function with five parameters leaves the real shape untouched"* is the
   same judgement as `pr357`'s "`repaintStatus` is a synchronous pass-through", arrived at from the
   other end.
3. **`suggested` vs `enforced` separation.** Their catalogue splits "coach but exit 0" from "fail the
   run". We have no such distinction and it shows: `too-many-parameters` and `deep-nesting` at depth 4
   are `suggested` material at best; `duplicated-code` is the only key that earns enforcement.
4. **The uncoached bucket.** "A smell with no catalogue entry is never dropped, and `incomplete-run`
   is reserved" — a stage that dies must not print a clean pass. That is the same fail-closed instinct
   as `pr371`'s `StructuralError` on a malformed ledger, and worth naming in our review dispatch.
5. **Their proof framing.** The metric is the cue, the guide is the action; a bare number gets gamed
   (5.6% genuine on Sonnet 4.6, 79/90 gamed). This audit's own data agrees — see §7, judgement 1: our
   two loudest detector "findings" landed on functions a review had just certified correct.

**The cheapest concrete borrow:** `src/__tests__/agent-guidance.test.ts` already asserts that specific
guidance *sentences* are present in the real source. A 15-line sibling — collect every string literal
≥ 80 chars across `src/`, normalise whitespace, assert no two are near-identical — would have caught
K4 (`retryOnTimeout` prose) mechanically, inside the existing CI, with no new dependency. That is the
class of smell we *actually* keep shipping (five surfaces to keep in sync: tool guideline, schema
description, `AGENT.md`, `README.md`, `CHANGELOG.md`), and it is worth more than a lint coach.

### 8.5 What to do with the findings instead

Recommended, in order (recommendation only — out of scope for this report):

1. **One sweep issue for the 11 duplication clusters** (D1–D11; two of them are the same fix seen
   twice). Ordered by value/effort: D7 (schema step shapes) → D9 (report modal) → D10
   (chain/parallel renderers) → D1/D2 (mode prologue) → D6 (loaders) → D3/D4/D5/D8/D11. This sweep
   also pays for itself twice over: D1/D2 *are* the `runXMode` body lengths in §3.2, and D6 *is*
   `loadCustom*`'s depth-6 nesting in §3.4 — fixing the duplication removes those two findings.
2. **The string-uniqueness test** in §8.4 (catches K4 and its family).
3. **Nothing else.** Re-measure before reopening the coach: if a future cycle adds a 4th mode or a 5th
   report screen, the §5 replay method takes ~2 minutes and will say whether the trigger rate moved.

## 9. Limits of this study

- **Sample size.** 29 replayed commits of 358; three PRs for the in-hunk test. The 7.7% trigger rate is
  an estimate with wide error bars, and it is biased *low* by the recent-commit sample and *high* by
  the largest-additions sample.
- **TP/FP is my reading, not a second opinion.** Every judgement above is mine, taken by reading the
  code; the corpus has no calibration for "is this duplication acceptable". The `git.ts` wrappers (FP)
  and the tui modal block (TP) are the two calls most likely to be argued the other way.
- **Not measured:** whether the 11 clusters would survive a real refactor (each one is a design change,
  not a text move — the runXMode triplication especially, where the three modes differ in scheduling);
  the coach's actual effect on a subagent (no A/B); `knip`/`ts-morph` (habit-hooks' unused-export /
  unused-file sensors); and test-smell detection (K9–K11), which no detector in this stack addresses.
- **`jscpd` accounting.** `sources: 40` for 41 files; jscpd's own file accounting, not reconciled.
- **Scope.** The prescribed `src/` scope excludes `.pi/extensions/`, `scripts/` and `templates/` — the
  first of which holds the one DRY finding the reviews actually made (K1). A repo-wide run would likely
  add a second cluster family in `scripts/`.

## Appendix A — the throwaway AST probe

`/tmp/smell-probe/ast-probe.mjs` (not committed). Core: import `parseTexts`/`SyntaxKind` from
`scripts/ts-ast.mjs`, walk with `node.forEachChild(cb)`, and for each `FUNCTION_KINDS` node record
`parameters.length`, `lineOf(getEnd()) - lineOf(getStart()) + 1`, and the max depth of
`NEST_KINDS` (if/for/for-in/for-of/while/do/try/switch) inside that function, with nested
function-likes getting their own budget and else-if chains counted once (ESLint `max-depth`
semantics). Output: four sorted tables, plus `--json`.

```js
const FUNC_KINDS = new Set([FunctionDeclaration, FunctionExpression, ArrowFunction,
                            MethodDeclaration, Constructor, GetAccessor, SetAccessor]);
const NEST_KINDS = new Set([IfStatement, ForStatement, ForInStatement, ForOfStatement,
                            WhileStatement, DoStatement, TryStatement, SwitchStatement]);
```

The one subtlety worth recording: the TS 7 node view has **no root `forEachChild`** — it is a method
on each node, and every AST accessor is a prototype getter, so `Object.keys(node)` yields only the
view's internal fields (`parent`, `view`, `index`, `_byteIndex`, `_sourceFile`). A generic
property-walking probe does not work; `node.forEachChild` does. The tsgo child prints
`context canceled` on exit (known, issue #284) — harmless, and it does not affect exit codes.

## Appendix B — raw artefact locations

| Artefact | Path |
|---|---|
| jscpd reports (10/70, 4/30, mode sweep) | `/tmp/smell-jscpd/jscpd-report.json`, `/tmp/smell-jscpd-low/`, `/tmp/smell-jscpd-weak/` |
| AST probe output | `/tmp/smell-probe/ast-excl-tests.txt`, `/tmp/smell-probe/ast.json` |
| ESLint reports (calibrated + habit-hooks thresholds) | `/tmp/smell-eslint/eslint-report-src.json`, `/tmp/smell-eslint/habit-thresholds.json` |
| Pre-fix historical files (`5647d78^` lib.ts, `e71dc62` tui.ts) and their detector runs | `/tmp/smell-hist/`, `/tmp/smell-hist-jscpd/` |
| Per-PR scoped runs | `/tmp/smell-pr355{,-jscpd}/`, `/tmp/smell-pr362{,-jscpd}/`, `/tmp/smell-pr370{,-jscpd}/` |
| History replay | `/tmp/smell-probe/replay.py`, `/tmp/smell-replay.json` |
| habit-hooks clone (read-only reference) | `/tmp/habit-hooks/` |

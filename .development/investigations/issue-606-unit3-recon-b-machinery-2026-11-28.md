# Issue #606 Unit 3 — reconnaissance B: enforcement machinery and prose corpus

**Method.** Read-only survey on 2026-11-28. I did not run the test suite or any guard; all numbers below are results printed by the stated discovery/count commands. Counts use tracked paths (`git ls-files`), so this untracked report is not included. “Normative corpus” below means tracked Markdown in the stated instruction/decision/documentation surfaces; it deliberately excludes test fixtures.

## 1. Absent-with-query list

1. **No dedicated prose-synonym / terminology lint command exists.** Exact query (no output):
   ```sh
   git grep -n -i -E 'forbidden[ -]synonym|synonym.*(lint|guard|check)|terminology.*(lint|guard|check)' -- scripts .github .pi/skills package.json
   ```
   This does not mean there are no vocabulary controls: the runtime-string vocabulary ratchet exists (§2.3), but it scans TypeScript runtime literals, not this Markdown corpus.
2. **No direct CI invocation of either generated-document CLI.** Exact query (no output):
   ```sh
   grep -n -E 'node scripts/(docs-arch|docs-decisions)\.mjs' .github/workflows/ci.yml
   ```
   They are nevertheless exercised indirectly by the CI Vitest command through `src/__tests__/architecture-doc.test.ts` and `src/__tests__/decisions-index.test.ts` (§2.2).
3. **No ADR match for `terminology` or `glossary`.** Exact counted queries, corpus `.development/decisions/`:
   ```sh
   git grep -n -i -E 'terminology' -- .development/decisions | wc -l  # 0
   git grep -n -i -E 'glossary' -- .development/decisions | wc -l     # 0
   ```
4. **No literal “factory vocabulary” proposal/phrase in ADRs or investigations.** Exact query (no output), corpus `.development/decisions/` and `.development/investigations/`:
   ```sh
   git grep -n -i -F 'factory vocabulary' -- .development/decisions .development/investigations
   ```
   There is, however, substantial #606 upstream vocabulary prior art (§5).

## 2. Enforcement sockets

### 2.1 Standalone docs/prose guard scripts

| Guard / file | What it checks | Scope and enforcement point |
|---|---|---|
| `scripts/audit-scratch-instructions.mjs` | Durable artifacts must not be instructed to live in a system temp directory. It classifies each temp-path mention as `artifact` (hit), `refusal`, or `probe-scratch`; unknown wording fails closed. | Exactly `.pi/skills/**/*.md`, `.pi/brl-subagent/presets/**/*.md`, and `.pi/brl-subagent/templates/**/*.md`; `.development/**`, fixtures, and `CHANGELOG.md` are intentionally excluded. Direct CI command in `.github/workflows/ci.yml:58`. |
| `scripts/check-contract-tracking.mjs` | Every Markdown file under the project-local dispatch contract is both on disk and tracked; detects untracked-on-disk and tracked-but-missing drift. | `.pi/brl-subagent/**/*.md`; direct CI command at `.github/workflows/ci.yml:64`. |
| `scripts/check-readme-test-count.mjs` | Pins README’s `<N>+ test suite` claim to the JSON-reported executed suite count. Normal mode prevents an overstatement; `--strict` also caps stale-understatement; `--bump` rewrites the claim. | `README.md` plus the Vitest JSON report; direct CI commands at `.github/workflows/ci.yml:42` and `:45`, selected by release-seam conditions. |
| `scripts/docs-arch.mjs` | Regenerates/checks the generated module-map block in `.development/ARCHITECTURE.md` from first-line `// Purpose:` headers in top-level `src/*.ts`. | A stale document exits non-zero; direct command is not written in CI, but `src/__tests__/architecture-doc.test.ts:14-18` executes it under the CI suite. |
| `scripts/docs-decisions.mjs` | Regenerates/checks the ADR index in `.development/decisions/README.md` from `NNNN-*.md` records and verifies heading/Status/Date metadata. | A stale document exits non-zero; indirect CI route is `src/__tests__/decisions-index.test.ts:14-18`. |
| `scripts/handoff-verify.mjs` | Verifies the mechanical shape, citations, size/count claims, and state-page claims for `.development/HANDOFF.md`; explicitly excludes the meaning of prose. | CLI socket for handoff documentation, not a direct `.github/workflows/ci.yml` step found in this survey. Contract and exit grammar are in `scripts/handoff-verify.mjs:1-91`. |

Relevant adjacent rather than corpus-wide sockets:

- `src/__tests__/prose-duplication.test.ts:1-34` fails the suite for cross-file near-duplicate **shipped runtime string** prose (`src/**/*.ts`, not `src/__tests__`), at ≥80 characters and equality/Jaccard ≥0.80.
- `src/__tests__/runtime-vocabulary.test.ts:1-24,47-69,245-260` is the existing terminology/vocabulary control. It AST-scans runtime string literals in `src/**/*.ts` (excluding tests and type-only positions) for `Rule <n>`, `retry taxonomy`, `friction log`, `handoff`, `worktree`, `E<nn>`, and `issue #<n>`, with recorded allow-list reasons. It is **not** a Markdown/docs synonym linter.

### 2.2 CI wiring

Workflow: `.github/workflows/ci.yml`, job `test`. Exact relevant commands:

```sh
npx vitest run --reporter=default --reporter=json --outputFile=vitest-report.json
node scripts/check-readme-test-count.mjs vitest-report.json
node scripts/check-readme-test-count.mjs vitest-report.json --strict
node scripts/audit-scratch-instructions.mjs
node scripts/check-contract-tracking.mjs
```

The first command is the indirect socket for `runtime-vocabulary`, `prose-duplication`, `architecture-doc`, and `decisions-index` tests. The two README commands are mutually selected by `.github/workflows/ci.yml:41-45`; the latter is the release-seam `--strict` arm. Direct docs/prose commands count: **4**, printed by:

```sh
grep -n -E 'node scripts/(check-readme-test-count|audit-scratch-instructions|check-contract-tracking)\.mjs' .github/workflows/ci.yml | wc -l
# 4
```

### 2.3 One existing guard’s shape: `audit-scratch-instructions`

File: `scripts/audit-scratch-instructions.mjs`.

- **Arguments:** `audit-scratch-instructions.mjs [--root <dir>]`; no selector, `--tracked`, `--overrides`, and `--strict` are explicitly rejected (`:280-292`).
- **Inputs:** recursively collected Markdown in the three `TRACKED_CORPUS` directories (`:64-68`); each corpus must exist and be non-empty (`:198-228`).
- **Exit semantics:** **0** = clean; **1** = one or more durable-artifact hits; **2** = usage or missing/unreadable/empty corpus (`:46-47`, `:292`).
- **Self-test:** no `--selftest` argument. It is independently tested by `scripts/__tests__/audit-scratch-instructions.test.ts`; the suite includes classification, empty/missing-corpus, argument, and real-process exit-code cases (`:89-351`). That test file is reached by the CI Vitest command above.

**Socket conclusion.** A future Markdown vocabulary guard has two obvious direct CI insertion points—an independent `node scripts/<guard>.mjs` step beside `audit-scratch-instructions`/`check-contract-tracking`, or a Vitest guard beside the runtime vocabulary and duplicate-prose tests. No new lint is designed here.

## 3. Prose corpus a lint would scan

### 3.1 Normative Markdown partition

The following table is the proposed scan inventory, not a claim that every historical investigation sentence should be forbidden. Package status is determined solely from `package.json`’s `files`: `src/`, `presets/`, `templates/`, `README.md`, `LICENSE`, `AGENT.md`, with `!src/__tests__/` excluded.

| Surface | Tracked Markdown files | Physical lines | Count query (printed result) | Published package? |
|---|---:|---:|---|---|
| Root policy/product docs: `AGENT.md`, `README.md`, `CHANGELOG.md`, `CONTRIBUTING.md` | 4 | 878 | `git ls-files -- AGENT.md README.md CHANGELOG.md CONTRIBUTING.md REVIEW_PR540.md REVIEW_PR541.md \| grep -E '\.md$' \| wc -l` → **4**; same list piped to `xargs wc -l \| tail -n1` → **878** | **Mixed:** `AGENT.md` and `README.md` included; `CHANGELOG.md` and `CONTRIBUTING.md` excluded. |
| `.pi/skills/**` | 16 | 3,281 | `git ls-files -- .pi/skills \| grep -E '\.md$' \| wc -l` → **16**; same list → `wc -l` total **3,281** | **Excluded** (not in `files`). |
| `.pi/brl-subagent/**` project-local presets/templates/README | 11 | 636 | `git ls-files -- .pi/brl-subagent \| grep -E '\.md$' \| wc -l` → **11**; same list → **636** | **Excluded**. |
| `.development/**` (ADRs, handoffs, specs, investigations, glossary, operations docs) | 219 | 30,610 | `git ls-files -- .development \| grep -E '\.md$' \| wc -l` → **219**; same list → **30,610** | **Excluded**. |
| `presets/**` | 9 | 303 | `git ls-files -- presets \| grep -E '\.md$' \| wc -l` → **9**; same list → **303** | **Included** (`presets/`). |
| `templates/**` | 9 | 94 | `git ls-files -- templates \| grep -E '\.md$' \| wc -l` → **9**; same list → **94** | **Included** (`templates/`). |
| `fixtures/**` | 1 | 54 | `git ls-files -- fixtures \| grep -E '\.md$' \| wc -l` → **1**; same list → **54** | **Excluded**; fixture data, not normative prose. |

**Normative scan total:** **268 files / 35,802 lines.** Exact partition query and printed file result:

```sh
git ls-files -- AGENT.md README.md CHANGELOG.md CONTRIBUTING.md .pi/skills .pi/brl-subagent .development presets templates | grep -E '\.md$' | wc -l
# 268
```

The physical-line total is the sum of the printed per-surface `wc -l` results: `878 + 3281 + 636 + 30610 + 303 + 94 = 35802`.

### 3.2 Other tracked Markdown, deliberately out of the normative lint corpus

- Test fixture Markdown under `scripts/__tests__/fixtures/**`: **40 files / 726 lines**, printed by:
  ```sh
  git ls-files -- 'scripts/__tests__/fixtures' | grep -E '\.md$' | wc -l       # 40
  git ls-files -- 'scripts/__tests__/fixtures' | grep -E '\.md$' | xargs wc -l | tail -n1  # 726 total
  ```
  These deliberately contain invalid/drifted samples and should not establish policy terminology.
- All tracked Markdown: **309 files / 36,582 lines**, printed by:
  ```sh
  git ls-files -- '*.md' | wc -l                         # 309
  git ls-files -- '*.md' | xargs wc -l | tail -n1         # 36582 total
  ```
- Partition check found no other tracked Markdown: `root=4 skills=16 contract=11 development=219 presets=9 templates=9 fixtures=1 testfixtures=40 other=0 total=309`, printed by the `git ls-files -- '*.md' | awk ...` partition command in the survey log.

## 4. Synonyms in use today

### 4.1 Measurement definition

Each count is a case-insensitive whole-word **match** (not file count) across the **268-file normative Markdown corpus**. Exact command schema, substituted once per term:

```sh
git ls-files -- AGENT.md README.md CHANGELOG.md CONTRIBUTING.md .pi/skills .pi/brl-subagent .development presets templates | grep -E '\.md$' | xargs rg -o -i -w '<term>' | wc -l
```

Representatives below were printed by the same corpus list with `xargs rg -n -i -w -m 1 '<term>' | head -n 1`.

| Family | Terms: count; representative file:line | Readout |
|---|---|---|
| Dispatch family | `dispatch`: **1,063**; `.development/FRICTION_LOG.md:36`. `delegate`: **67**; `.development/FRICTION_LOG.md:25`. `spawn`: **769**; `.development/FRICTION_LOG.md:42`. | **Mixed as a family:** `dispatch` is lexically dominant over `delegate` (15.9×), but `spawn` is substantial (72% of dispatch’s count). Counts alone cannot establish whether the documented distinction is intentional at every occurrence. |
| Actor family | `subagent`: **955**; `.development/FRICTION_LOG.md:25`. `agent`: **1,142**; `.development/FRICTION_LOG.md:32`. `worker`: **26**; `.development/FRICTION_LOG.md:124`. | **Mixed** between `agent` and `subagent` (similar scale); **worker is already rare/disciplined** compared with either (2.3% of `agent`). |
| Configuration family | `preset`: **635**; `.development/FRICTION_LOG.md:25`. `template`: **262**; `.development/FRICTION_LOG.md:37`. | **Preset-dominant** (2.4×) but not cleanly single-term; `template` remains frequent and is likely a distinct file kind. |
| Git-workspace family | `worktree`: **883**; `.development/FRICTION_LOG.md:19`. `branch`: **960**; `.development/FRICTION_LOG.md:23`. `checkout`: **197**; `.development/FRICTION_LOG.md:30`. | **Genuinely mixed:** `worktree` and `branch` are near parity; `checkout` remains material (22% of `worktree`). |
| Lifecycle family | `run`: **2,652**; `.development/FRICTION_LOG.md:43`. `execution`: **160**; `.development/investigations/fg-task-persistence-proposal-2026-10-11.md:26`. `session`: **1,544**; `.development/FRICTION_LOG.md:32`. | **Run dominates execution** (16.6×), but the family is **mixed** because `session` is 58% of `run`. This directly collides with upstream’s proposed `run`/avoid-`session` vocabulary (§5). |

The counts should be treated as corpus inventory, not semantic proof: `.development` intentionally includes historical prose, quotations, and reports. Any future lint needs an explicit decision whether history is scanned, exempted, or only reported.

## 5. Prior art

### 5.1 Existing project glossary

`.development/GLOSSARY.md:1-18` is an existing project glossary with entry rules and the stated principle that load-bearing/confusing terms should be defined, cross-referenced, and pruned. It is a current documentation socket, but not an enforced canonical-synonym checker.

### 5.2 ADRs

ADR vocabulary discussion exists, but it is not factory terminology:

- `.development/decisions/0005-honest-terminal-status.md:20` says the terminal-status ratchet enforces that vocabulary in CI.
- `.development/decisions/0013-typescript-7-unstable-ast.md:12` identifies the runtime-string vocabulary ratchet as one of four AST-dependent guards.
- `.development/decisions/0021-no-crap-gate-targeted-followups.md:11,22,30` defines/retains a **smell vocabulary** and declines a new CI coverage gate.

Query totals, corpus `.development/decisions/`:

```sh
git grep -n -i -E 'vocabulary' -- .development/decisions | wc -l  # 6 matching lines
git grep -n -i -E 'terminology' -- .development/decisions | wc -l # 0 matching lines
git grep -n -i -E 'glossary' -- .development/decisions | wc -l    # 0 matching lines
```

### 5.3 Investigations and the #606 source vocabulary

The concrete Unit 3 prior art is `.development/investigations/issue-606-grilling-upstream-2026-11-27.md`:

- `:296-311` introduces the upstream software-factory source and explicitly says Unit 3 should use its vocabulary.
- `:313-359` quotes canonical terms and avoid-lists: **task** (avoid job/workflow/action), **run** (avoid session), **runner** (avoid server/host/box/compute/sandbox), plus ticket tracker/source, git host, orchestrator, and observability platform.
- `:361-367` condenses the five Unit 3 terms and forbidden synonyms.
- `:369-384` identifies two mapping hazards: a factory run must not wait for a human, and the proposed `worktree → runner` mapping conflicts with the upstream runner’s non-persistent-state definition.
- `.development/investigations/issue-606-grill-spec-2026-11-27.md:9,303` says Unit 3 is vocabulary + a forbidden-synonym lint, but is out of Unit 1’s scope.

Investigation search results, corpus `.development/investigations/`:

```sh
git grep -n -i -E 'terminology' -- .development/investigations | wc -l # 1 matching line
git grep -n -i -E 'glossary' -- .development/investigations | wc -l    # 1 matching line
git grep -n -i -E 'vocabulary' -- .development/investigations | wc -l  # 207 matching lines
git grep -n -i -F 'factory vocabulary' -- .development/investigations  # no output
```

**Conclusion on “factory vocabulary proposal.”** No literal file/phrase by that name was found (§1), but the upstream reconnaissance is functionally the proposal input: it provides the canonical words, forbidden alternatives, and the already-identified worktree/runner persistence exception. It should be cited rather than rediscovered.

## 6. What I did not verify

- I did **not** run `npm`, Vitest, any guard CLI, CI, a package build, or package publication; exit semantics above are read from the named files and their tests, not observed executions.
- I did **not** inspect an npm tarball. Package inclusion/exclusion is inferred from `package.json:11-19`’s `files` whitelist.
- I did **not** judge whether every counted synonym use is semantically wrong; the corpus includes historical `.development` content and quotations.
- I did **not** design, implement, or modify a lint, source, preset, skill, git state, or workflow. The only intended modification is this investigation file.

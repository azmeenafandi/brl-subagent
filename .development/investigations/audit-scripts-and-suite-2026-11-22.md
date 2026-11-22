# Process tooling and test-suite audit — 2026-11-22

## §1. Verdict and scope

The suspicion is substantially true, but the measured mass is not a graveyard of uncalled scripts: all 31 inventoried process scripts have non-test references, while the 147 included test files contain 68,014 lines and the scripts 16,361 lines. The more consequential cruft is **evidence machinery that can certify the wrong thing**: the actual saved `3ae8c55` suite report is red while the handoff says green and its verifier passes; three fail-open exit-code mutants survive their respective complete test files; and the review-head exception is satisfied by a prose mention. Several counters and overlapping parsers increase maintenance cost and have already drifted. No dead entry point was established, and not every test or behavior was exhaustively audited.

**Revision:** requested `dev`/`3ae8c55`; actual checkout was `dev`/`1804bb8`. `git diff --name-only 3ae8c55 HEAD` printed only `.development/HANDOFF.md`. Script/test/CI measurements therefore apply unchanged to the requested commit. The two handoff revisions and their respective provenance-bearing reports were separately checked below. The local board was not queried; known residuals #552, #561, #562, #567, #569, #570, #572, #579 and PR #536 are not presented as new. Jev was unavailable and not used.

**Counting:** S1 false-green (6), S2 stale claim/pin (5), S3 dead (0 established), S4 duplication (2), S5 cost (1). Severity denotes the requested finding class, not impact ranking. Findings are measured unless explicitly called an inference. No production files were changed; tests/mutants and fixtures were made only under `mktemp -d`. A full suite was not rerun; the existing report was examined and a targeted failing test independently reproduced. For the separate impact index, my judgment is Critical 0; High 4 (F01, F04, F07, F08); Medium 8 (F02, F03, F05, F06, F09, F11, F12, F13); Low 2 (F10, F14). These impact labels are judgments, not additional findings.

## §2. Findings table

| ID | Area | Severity | Finding | Evidence | Disposition |
|---|---|---|---|---|---|
| F01 | Review gate | S1 | A mere prose mention of `conductor-verified:` clears an unreviewed head. | `.pi/skills/worktree/merge-guard.sh:198,577`; scratch check passes with no current SHA and no actual verification line; §3.1. | Fix: require an unfenced line-start marker containing the current head and nonempty evidence. |
| F02 | Scratch-instruction CI guard | S1 | Tests derive the failure/usage exit code from the same constant as the implementation: both fail-open mutants survive. | `scripts/__tests__/audit-scratch-instructions.test.ts:180,252`; M1 and M2: 22/22 green each while exit becomes 0; §3.2. | Fix: assert literal external exit codes; exercise CLI with planted hit and bad usage. |
| F03 | Contract-tracking CI guard | S1 | The untracked-file failure exit is likewise self-referential. | `scripts/__tests__/check-contract-tracking.test.ts:103`; M3: 10/10 green, real mutant CLI reports an untracked file with exit 0; §3.2. | Fix: assert literal nonzero exit through subprocess. |
| F04 | Handoff verifier | S1 | It checks only total cases, not passed/failed/skipped: a red report validates the green snapshot. | `scripts/lib/handoff-claims.mjs:431-453`, `scripts/lib/suite-report.mjs:235-258`; actual red report and synthetic all-failed control both pass; §3.3. | Fix: preserve status counts in the validated snapshot and compare each stated claim, not only total. |
| F05 | Handoff size verifier | S1 | `.mjs` size claims are invisible to parser and resolver; the real anti-rot test checks only what that parser happened to emit. | `scripts/lib/handoff-claims.mjs:145-149`, `scripts/handoff-verify.mjs:105-110`, `scripts/__tests__/handoff-verify.test.ts:138-154`; probe returns `[]`/`null`; §3.4. | Fix: parse explicit repository-relative script paths and assert their presence in the test. |
| F06 | README count guard | S1 | A hollow JSON object containing only a count is accepted as a valid suite, including in `--strict`/`--bump`. | `scripts/check-readme-test-count.mjs:89-103`, `scripts/__tests__/check-readme-test-count.test.ts:72-81`; `{numTotalTests:3100,testResults:[]}` exits 0; §3.5. | Fix: share validated report derivation; require appropriate suite status for release claims. |
| F07 | Test budget test | S2 | A hardcoded source LOC pin is stale and makes the requested tree's full suite red. | `scripts/__tests__/test-budget.test.ts:919-921`: 7,583 expected, 7,615 measured; targeted reproduction exits 1; §3.3. | Fix: assert accounting on a controlled fixture, or mechanically derive the independent reference; avoid an unconditional fixed real-tree total. |
| F08 | Handoff suite snapshot | S2 | Both revision snapshots claim 3,295 passed / 0 failed, contrary to their saved reports. | `.development/HANDOFF.md:17`; `git show 3ae8c55:.development/HANDOFF.md` and provenance-bearing `b12a334`/`3ae8c55` JSON each show 3,294 passed, 1 failed, 1 skipped; §3.3. | Fix: correct the snapshot after a real green capture; don't relabel a red run. |
| F09 | Handoff size snapshot | S2 | Current and requested handoffs say `friction-disposition.mjs` is 1,667 lines; it is 1,692. | `.development/HANDOFF.md:17`; `wc -l` and `git show 3ae8c55:scripts/friction-disposition.mjs | wc -l` both yield 1,692; §3.4. | Fix the number and F05. This is not #561's opposite-direction prose-as-size issue. |
| F10 | README suite claim | S2 | “Every contract against the real pi SDK” overstates what the suite demonstrably runs: entire process-tool contracts are independently tested without the SDK, and many SDK imports are mocked. | `README.md:17`; `rg -l 'vi\.mock\(["\x27]@earendil-works/' src/__tests__ | wc -l` → 31; `scripts/__tests__/check-contract-tracking.test.ts:30-34`; §3.6. | Doc-only: say selected SDK integration contracts use the real SDK, alongside unit and tooling tests. |
| F11 | CI trigger claim | S2 | Guard header says the truth check runs on “every push”; workflow only runs on push to `main`, plus pull requests. | `scripts/check-readme-test-count.mjs:8-10`, `.github/workflows/ci.yml:3-6,39-45`; §3.6. | Doc-only, or add a dev-push trigger if that was the intended policy. |
| F12 | Record parser | S4 | Offline record validation and the full gate maintain separate parsers and actually disagree on an unterminated final line. | `scripts/lib/record-fields.mjs:75-126`, `.pi/skills/worktree/merge-guard.sh:150-164,466-477`: offline accepts final `Verdict: approve`; shell rejects it; §3.7. | Merge into the Node parser, or add shared parity fixtures including no terminal newline. |
| F13 | Suite evidence | S4 | Three independent interpretations of report JSON diverge: derived results, top-level count, and timestamps-only. | `scripts/lib/suite-report.mjs:190-224`, `scripts/check-readme-test-count.mjs:89-103`, `scripts/check-test-budget.mjs:153-175`; hollow README input and 1-second synthetic budget input both pass; §3.5. | Merge report structural validation; keep count and timing consumers' distinct purposes explicit. |
| F14 | Post-verdict capture ritual | S5 | A docs-only post-verdict commit requires another complete suite solely because the commit ID changed. One recorded run costs 19.74 s locally—not the hypothesized 2–3 minutes. | `.pi/skills/worktree/SKILL.md:660-667`; `3ae8c55` report's max end minus start = 19.74 s; §3.8. | Consider evidence reuse only with a verified unchanged test-relevant tree/digest and explicit provenance; do not simply relabel a report. |

## §3. Evidence and reproducibility

### §3.1 F01 — the review-head exception is not a line or a verification

A real scratch record contained a valid #42 verdict, old head `111…`, valid risk/recheck, and the prose sentence `A reminder: the token \`conductor-verified:\` means nothing here.` It did **not** contain requested head `deadbeef…`.

```
bash .pi/skills/worktree/merge-guard.sh --check-record "$D/record.md" \
  --pr 42 --head deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
# record-check: OK — ... (approve; Risk class C1; head 111111111111)
# exit 0
node --input-type=module - "$D/record.md"   # imports mentionsHead/hasConductorVerified/checkRecord
# mentionsHead= false hasConductorVerified= true problems= []
```

For the actual shell gate predicate, a scratch copy of `merge-guard.sh` with only its final `main "$@"` removed was sourced, then `check_record 42 "$D/record.md" deadbeefdeadbeefdeadbeefdeadbeefdeadbeef` was invoked. Output: `(b)` pass, `(c)` pass, **`(d) head deadbeefdead is post-verdict — the record carries a 'conductor-verified:' line`**, `FAIL_COUNT=0`. This reproduces check (d), not the full network/Jev gate. The source uses `grep -qiE 'conductor-verified:'` anywhere, including prose/fences; `references/review-dispatch.md:333-354` calls for a line identifying the verified commit and evidence. Other gates may block a PR independently; they do not correct this check.

### §3.2 F02–F03 — three mutation survivors, complete target files

Setup: `D=$(mktemp -d); mkdir -p "$D/repo"; git archive 3ae8c55 | tar -x -C "$D/repo"; ln -s "$PWD/node_modules" "$D/repo/node_modules"; git -C "$D/repo" init -q; git -C "$D/repo" add .pi/brl-subagent`. The scratch git index is needed for the tracking test; no commit was made. Baseline `(cd "$D/repo" && ./node_modules/.bin/vitest run scripts/__tests__/audit-scratch-instructions.test.ts scripts/__tests__/check-contract-tracking.test.ts --reporter=dot)` returned **2 files / 32 tests passed**.

Each mutation was performed on a fresh copy of the original target bytes with Python `Path.read_text().replace(...); Path.write_text(...)`; the target test command was `(cd "$D/repo" && ./node_modules/.bin/vitest run <file> --reporter=dot)`:

| Mutant | Exact replacement | Target file | Result |
|---|---|---|---|
| M1 | `audit-scratch-instructions.mjs`: `{ OK: 0, HITS: 1, USAGE: 2 }` → `{ OK: 0, HITS: 0, USAGE: 2 }` | `scripts/__tests__/audit-scratch-instructions.test.ts` | exit 0, **22/22 passed** |
| M2 | same: `USAGE: 2` → `USAGE: 0` with `HITS: 1` unchanged | same | exit 0, **22/22 passed** |
| M3 | `check-contract-tracking.mjs`: `{ OK: 0, DRIFT: 1, USAGE: 2 }` → `{ OK: 0, DRIFT: 0, USAGE: 2 }` | `scripts/__tests__/check-contract-tracking.test.ts` | exit 0, **10/10 passed** |

For M1, an additional scratch `.pi/skills/audit-mutant.md` said `Append durable bank to /tmp/bank.md`; `(cd "$D/repo" && node scripts/audit-scratch-instructions.mjs)` printed `hit: ... · artifact` and `audit: 1 hit(s) ...` **but exited 0**. For M3, an extra untracked scratch preset produced `untracked contract file: .pi/brl-subagent/presets/audit-untracked.md` **and exited 0**. The corresponding actual CI invocations are `.github/workflows/ci.yml:58,65`. Existing unmutated guards currently produce correct failure constants; this is a demonstrated test blind spot, not a claim that the shipped guards currently return 0 on these inputs. The tests do make useful assertions on output and classification; only their independent exit-code protection is false-green.

### §3.3 F04, F07, F08 — a red real report was certified as the handoff's green run

Read-only extraction:

```
python3 - <<'PY'
import json,pathlib
p=pathlib.Path.home()/'.cache/brl-subagent/reports'
for prefix in ('b12a334','3ae8c55'):
 for f in p.glob(prefix+'*.json'):
  if f.name.endswith('.provenance.json'): continue
  x=json.loads(f.read_text())
  print(prefix, *(x.get(k) for k in ('numTotalTests','numPassedTests','numFailedTests','numPendingTests')), len(x['testResults']))
PY
# b12a334 3296 3294 1 1 147
# 3ae8c55 3296 3294 1 1 147
```

The `3ae8c55a7d97927648c33c7e6a7db095bb3f6fdc.json` sidecar says the same full head, `dirty: false`, `capturedAt: 2026-11-22T05:43:11.089Z`. Its failing assertion is `scripts/__tests__/test-budget.test.ts:921`: `expected 7615 to be 7583`. The pending case is the intentionally root-only foreign-owner check, `src/__tests__/scratch-root.test.ts:276`; a skip is not inherently a defect. `git show 3ae8c55:.development/HANDOFF.md` says **3295 passed + 1 skipped, 0 failed**, captured at `b12a334`; the current `1804bb8` handoff repeats that claim for `3ae8c55`. Both named reports contradict it.

Independent targeted execution, in the archived scratch tree:

```
(cd "$D/repo" && ./node_modules/.bin/vitest run scripts/__tests__/test-budget.test.ts \
  -t 'measures the skills surface on the real tree' --reporter=dot)
# AssertionError: expected 7615 to be 7583
# 1 failed | 67 skipped; exit 1
```

`git show --stat --oneline b12a334 -- .pi/skills/worktree/check-repo.sh scripts/__tests__/test-budget.test.ts` showed **32 insertions in check-repo.sh** and no corresponding test change; 7,583 + 32 = 7,615. This verifies the red, not a full new-suite result.

Yet `node scripts/handoff-verify.mjs --no-network --report "$HOME/.cache/brl-subagent/reports/3ae8c55a7d97927648c33c7e6a7db095bb3f6fdc.json"` printed `✓ Suite: 147 files / 3296 tests ... (head 3ae8c55...)` and exited **0**. As a stronger negative control, a `/tmp` synthetic report with 147 result files, 3,296 failed assertion results and zero passes also printed the same suite check and exited 0 (`provenance: absent`). The former is the actual, head-matching evidence; the latter isolates status handling. `scripts/lib/handoff-claims.mjs:25-26` itself says this is a passed/green claim, but `checkSuite` only compares totals. `check-test-budget` is separately a budget check and its successful timing result should not be mistaken for a green suite.

### §3.4 F05 and F09 — the stale `.mjs` size is not parsed

```
wc -l scripts/friction-disposition.mjs
# 1692 scripts/friction-disposition.mjs
git show 3ae8c55:scripts/friction-disposition.mjs | wc -l
# 1692
node --input-type=module -e 'import {readFileSync} from "node:fs"; import {parseClaims} from "./scripts/lib/handoff-claims.mjs"; import {resolveModulePath} from "./scripts/handoff-verify.mjs"; const c=parseClaims(readFileSync(".development/HANDOFF.md","utf8")); console.log("friction parsed:",c.sizes.filter(x=>x.name.includes("friction"))); console.log("friction resolution:",resolveModulePath(process.cwd(),"friction-disposition.mjs")); console.log("parsed sizes:",c.sizes.length)'
# friction parsed: []
# friction resolution: null
# parsed sizes: 14
```

The actual line says **1,667**. `SIZE_RE` accepts only `.ts`; the resolver only tries `src/<name>` and `<root>/<name>`, not `scripts/<name>`. The existing real-handoff test iterates only `claims.sizes`, so the unrecognized claim cannot fail it. The existing #561 concern is a prose mention *incorrectly included*; this is an actual `.mjs` claim *silently excluded*.

### §3.5 F06 and F13 — independent JSON interpretations

The real README says `3100+`. In a scratch directory, `python3` wrote `hollow.json` containing exactly `{"numTotalTests":3100,"testResults":[]}`. Then:

```
node scripts/check-readme-test-count.mjs "$D/hollow.json" --strict
# readme-test-count: README says 3100+, suite ran 3100 — OK (drift 0 of limit 100).
# exit 0
```

That report contains zero result files. The stricter `readSuiteReport` would reject it as `empty-results` (its code at `scripts/lib/suite-report.mjs:190-199`). Separately, a scratch `timing.json` with only `{"startTime":1000,"testResults":[{"endTime":2000}]}` made `node scripts/check-test-budget.mjs "$D/timing.json"` print `wall 1.00s ...`, the real ratios and `test-budget: OK.`, exit 0. This is **not a timing measurement**; it demonstrates that the budget tool only validates its timing-shaped input. Different consumer purposes do not justify a README guard treating a non-run as a suite; `--bump` also writes the false count to README in a release workflow.

Actual tree measurements with the saved `3ae8c55` report: `node scripts/check-test-budget.mjs <report>` printed wall **19.74s**, src **1.98** (61,033/30,893), scripts **0.87** (7,621/8,746), skills **0.07** (524/7,615); floors src **61/61**, scripts **14/14** reachable. Reachability is an import-graph floor, **not proof of behavioral coverage**. `node scripts/check-readme-test-count.mjs <report>` printed `3100+, suite ran 3296 — OK (truth only)`; `--strict` returned 1, drift **196**, limit **100**. This lag on dev is explicitly permitted by `.github/workflows/ci.yml:32-45`, so it is not called a current policy violation; it must be bumped at the release seam.

### §3.6 F10–F11 — claims versus configured execution

`rg -l 'vi\.mock\(["\x27]@earendil-works/' src/__tests__ | wc -l` printed **31** files. The SDK integration test `src/__tests__/sdk-contract.test.ts:1-21` usefully imports a real registry, but the same suite includes isolated tooling contracts and SDK mocks. README's universal `every contract against the real pi SDK` has no demonstrated basis; this is a documentation claim about the suite, not an assertion that the real-SDK tests are worthless.

`rg -n 'push:|branches:|pull_request:|truth|every push' .github/workflows/ci.yml scripts/check-readme-test-count.mjs` shows `push: branches: [main]`, `pull_request:`, and the guard's “every push” statement. A direct push to `dev` does not match this workflow's push trigger; this is a conclusion from the committed YAML, not a claim about GitHub branch protection or a queried Actions run.

### §3.7 F12 — independent parsers demonstrably disagree

A scratch review record contained `# Review #42`, the requested reviewed head, valid C1/recheck, and **`Verdict: approve` as its last line with no final newline**. Commands and output:

```
bash .pi/skills/worktree/merge-guard.sh --check-record "$D/no-final-newline.md" \
  --pr 42 --head deadbeefdeadbeefdeadbeefdeadbeefdeadbeef
# record-check: OK ...; exit 0
bash -c 'source "$1"; check_record 42 "$2" deadbeefdeadbeefdeadbeefdeadbeefdeadbeef; printf "FAIL_COUNT=%s\n" "${#FAIL_REASONS[@]}"' \
  _ "$D/merge-guard-functions.sh" "$D/no-final-newline.md"
# (b) pass; (c) no line-start Verdict; (d) pass; FAIL_COUNT=1
```

The scratch shell file is the exact script minus its final `main "$@"`; the shell's `while read` drops the unterminated line, while the JS `split("\n")` retains it. This is a demonstrated offline/full-field parity defect, not evidence that the generator itself emits unterminated records. The extra copies also contradict the literal “field rules live here once” wording in `scripts/lib/record-fields.mjs:7-10`.

### §3.8 F14 — measured cost, not an assumed 2–3 minutes

The documented `SKILL.md:660-667` rule says **any** post-verdict commit, including docs-only, requires `--capture` again. Read-only inspection of the saved `3ae8c55` JSON with `max(result.endTime) - startTime` measured **19.7416 s**. It is a previously recorded local run, not an independently timed rerun or a CI measurement, and it was red. One such mandated recapture per eligible commit has that approximate local measured cost; frequency and cumulative cycle cost were not measured. The handoff records a later docs-only commit, but no assertion is made that the rule necessarily applied to that commit.

## §4. Top 10 by value

1. **F01:** make the exception a line-start, unfenced `conductor-verified: <current-prefix> — <evidence>`; add prose/fence/mismatched-SHA negatives.
2. **F04/F08:** compare passed, failed, skipped and total when the handoff asserts them; correct the real red snapshot.
3. **F07:** remove the real-tree magic LOC pin in favor of an independent fixture accounting test; rerun the actual full suite before claiming green.
4. **F02:** pin actual CLI exit codes 0/1/2 with literals; plant one hit and bad usage.
5. **F03:** independently pin the contract-tracking CLI's untracked and unreadable exits.
6. **F05/F09:** include repo-relative `.mjs` size claims, test that the specific claim was parsed, and refresh the wrong number.
7. **F06:** use shared structural report validation for README truth/bump; reject empty or contradictory results.
8. **F12:** remove the duplicated record parser or at minimum share an unterminated-line parity fixture.
9. **F11:** correct “every push” or intentionally add dev-push CI.
10. **F10:** narrow the universal real-SDK claim to the contracts genuinely exercised through it.

F13 is naturally reduced by item 7; F14 merits a measured, provenance-preserving design rather than a rushed bypass.

## §5. What is actually fine

- `node scripts/docs-arch.mjs --check` → `module map is current (61 modules)`; `node scripts/docs-decisions.mjs --check` → `ADR index is current (28 decisions)`. These claims were recomputed, not presumed stale. ADR enumeration `find .development/decisions -maxdepth 1 -name '[0-9][0-9][0-9][0-9]-*.md' | wc -l` also returned **28**.
- `node scripts/audit-scratch-instructions.mjs` → `audit: 0 hit(s) in 26 tracked file(s) — clean`, exit 0; `node scripts/check-contract-tracking.mjs` → `11 tracked file(s), clean`, exit 0. F02/F03 are mutant-test gaps, not evidence of current incorrect exit values.
- `vitest.config.ts:4` includes all **147** tracked `*.test.ts` under the three named test roots; `.github/workflows/ci.yml:39` runs `vitest run` on PRs and main pushes, and `.github/workflows/publish.yml:42` runs it for release staging. `src/__tests__/test.bench.ts` is a separately documented benchmark, not a silently skipped `*.test.ts`; it is not part of those CI runs.
- Conditional skips are real and documented: the saved run contains one pending root-only owner test; the current full suite cannot honestly be reported all-passed. `rg -n '\.(skip|todo)\s*\(|\b(xit|xdescribe|xtest)\s*\(' ...` found no unconditional `.skip`/`.todo`; conditional `skipIf`/`runIf` are enumerated by `rg -n 'skipIf|runIf'` and depend on platform/host capabilities.
- No entry-point deletion is recommended on name-search evidence alone. Documentation, CI and historical references are not equivalent to measured execution, and a manually invoked ritual tool can be live without a code caller. The appendix records the distinction and its limits.

## §6. Inventory methodology and limitations

The 31 scripts are tracked `scripts/*.mjs`, `scripts/*.sh`, `scripts/lib/*.mjs`, and all tracked worktree-skill `.sh`, `.py`, `.mjs`. The 147 test files are tracked `*.test.ts` under the requested roots; test setup, fixtures and the bench are listed separately. For each file, lines are physical `splitlines()` (equivalent to `wc -l` on these newline-terminated files); churn is exactly the number of lines returned by `git log --format=%h -- <path>` at `1804bb8`. No renames are followed. `expect(` is a raw textual occurrence count, not the number of executed assertions: helpers, loops, comments and other assertion APIs make low counts a **triage smell**, not proof of vacuity.

Callers were inventoried in one batched equivalent of the requested name search: `rg --hidden -n -F -f "$D/patterns" --glob '!node_modules/**' --glob '!.git/**' --glob '!.tmp/**' --glob '!.codegraph/**' .`, where patterns contain every inventoried basename. Result: **2,310 matching lines**, exit 0. For each row the count is distinct external `file:line` matches; the table gives up to two examples. Historical `.development/investigations/` and tests remain in the reference count and are not silently promoted to runtime callers. Files sharing a basename (notably `scripts/{,lib/}suite-report.mjs`, `pr-evidence.mjs`, and `scratch-root.mjs`) have inherently ambiguous name-search counts; own-basename files were excluded, including sibling copies. These are **references**, not resolved call graph edges. Verdict `referenced` means at least one non-test/non-investigation reference was found; it does not claim the ritual ran. `CI` means filename included by the committed Vitest glob, not that every case executes on every platform. Only F02/F03 received complete-file mutation tests, and only the F07 case was independently rerun; this is not an exhaustive semantic inspection or proof that all remaining tests can fail. No GH history/network query or full suite was run. Budget note: the required per-path churn inventory spawned 178 `git log` subprocesses (plus nine for support files), exceeding the requested approximate 150-command budget when subprocesses are counted individually, although they were batched in a small number of shell invocations.

### §6.1 Scripts and test files

Columns: path · LOC · churn · raw expects (`—` for scripts) · external name-reference count · example references · verdict. Each row is a separate tracked file.

| Path | LOC | Churn | `expect(` | Refs | Reference examples | Verdict |
|---|---:|---:|---:|---:|---|---|
| `.pi/skills/worktree/__tests__/friction-candidates-fixture.test.ts` | 191 | 2 | 10 | 0 | — | CI |
| `.pi/skills/worktree/__tests__/script-guards.test.ts` | 333 | 2 | 22 | 2 | `scripts/__tests__/test-budget.test.ts:620`, `.development/HANDOFF.md:30` | CI |
| `.pi/skills/worktree/check-repo.sh` | 202 | 7 | — | 45 | `.gitignore:15`, `.gitignore:19` | referenced |
| `.pi/skills/worktree/codegraph-check.py` | 243 | 3 | — | 28 | `scripts/__tests__/test-budget.test.ts:616`, `.development/investigations/issue-426-timeout-guidance-spec-2026-11-18.md:142` | referenced |
| `.pi/skills/worktree/codegraph-refresh.sh` | 63 | 5 | — | 33 | `CONTRIBUTING.md:85`, `.pi/skills/worktree/__tests__/script-guards.test.ts:19` | referenced |
| `.pi/skills/worktree/jev-check.mjs` | 3322 | 17 | — | 52 | `scripts/__tests__/test-budget.test.ts:617`, `.github/workflows/ci.yml:68` | referenced |
| `.pi/skills/worktree/lib/version-skew.sh` | 41 | 1 | — | 9 | `scripts/__tests__/test-budget.test.ts:615`, `scripts/__tests__/test-budget.test.ts:913` | referenced |
| `.pi/skills/worktree/merge-guard.sh` | 1348 | 11 | — | 64 | `scripts/__tests__/test-budget.test.ts:600`, `scripts/__tests__/test-budget.test.ts:607` | referenced |
| `.pi/skills/worktree/recon.sh` | 198 | 2 | — | 46 | `.development/investigations/issue-443-plan-critique-2026-11-07.md:13`, `.pi/skills/worktree/__tests__/script-guards.test.ts:84` | referenced |
| `.pi/skills/worktree/run.sh` | 519 | 2 | — | 20 | `CHANGELOG.md:21`, `.github/workflows/ci.yml:80` | referenced |
| `.pi/skills/worktree/sprint-metrics.py` | 1394 | 8 | — | 33 | `scripts/__tests__/test-budget.test.ts:915`, `scripts/__tests__/friction-disposition.test.ts:1195` | referenced |
| `.pi/skills/worktree/worktree-cleanup.sh` | 118 | 2 | — | 20 | `.development/TASKS.md:229`, `CONTRIBUTING.md:40` | referenced |
| `.pi/skills/worktree/worktree-prep.sh` | 167 | 2 | — | 35 | `.development/TASKS.md:229`, `CHANGELOG.md:218` | referenced |
| `scripts/__tests__/audit-scratch-instructions.test.ts` | 310 | 4 | 84 | 0 | — | CI; M1/M2 survive (§3.2) |
| `scripts/__tests__/check-contract-tracking.test.ts` | 201 | 1 | 32 | 0 | — | CI; M3 survives (§3.2) |
| `scripts/__tests__/check-imports.test.ts` | 34 | 1 | 3 | 0 | — | CI |
| `scripts/__tests__/check-readme-test-count.test.ts` | 145 | 1 | 33 | 0 | — | CI; hollow input accepted (§3.5) |
| `scripts/__tests__/docs-generators.test.ts` | 92 | 1 | 17 | 0 | — | CI |
| `scripts/__tests__/friction-disposition.test.ts` | 1913 | 7 | 242 | 0 | — | CI |
| `scripts/__tests__/handoff-verify.test.ts` | 1206 | 11 | 246 | 2 | `scripts/lib/handoff-claims.mjs:12`, `.development/HANDOFF.md:68` | CI; `.mjs` blind spot (§3.4) |
| `scripts/__tests__/pr-evidence.test.ts` | 603 | 5 | 95 | 1 | `scripts/__tests__/fixtures/pr-evidence/clean.md:2` | CI |
| `scripts/__tests__/review-record.test.ts` | 829 | 5 | 187 | 5 | `scripts/__tests__/fixtures/review-records/s6-findings-bank.md:6`, `.pi/skills/worktree/merge-guard.sh:996` | CI |
| `scripts/__tests__/scratch-root.test.ts` | 728 | 4 | 181 | 1 | `scripts/__tests__/suite-report.test.ts:27` | CI |
| `scripts/__tests__/suite-report.test.ts` | 560 | 4 | 110 | 2 | `scripts/__tests__/handoff-verify.test.ts:17`, `scripts/__tests__/pr-evidence.test.ts:28` | CI |
| `scripts/__tests__/test-budget.test.ts` | 966 | 13 | 181 | 1 | `.development/decisions/0028-test-budget-flow-rule.md:97` | CI; real pin red (§3.3) |
| `scripts/__tests__/ts-ast.test.ts` | 34 | 1 | 5 | 0 | — | CI |
| `scripts/audit-scratch-instructions.mjs` | 312 | 4 | — | 8 | `scripts/__tests__/audit-scratch-instructions.test.ts:2`, `scripts/__tests__/audit-scratch-instructions.test.ts:48` | referenced |
| `scripts/check-contract-tracking.mjs` | 129 | 1 | — | 9 | `.gitignore:30`, `scripts/__tests__/test-budget.test.ts:903` | referenced |
| `scripts/check-imports.mjs` | 596 | 2 | — | 16 | `scripts/__tests__/check-imports.test.ts:15`, `scripts/__tests__/check-imports.test.ts:28` | referenced |
| `scripts/check-readme-test-count.mjs` | 141 | 3 | — | 20 | `scripts/__tests__/check-readme-test-count.test.ts:21`, `.development/investigations/issue-434-implementation-brief-2026-11-07.md:122` | referenced |
| `scripts/check-test-budget.mjs` | 749 | 9 | — | 77 | `scripts/__tests__/test-budget.test.ts:48`, `scripts/__tests__/test-budget.test.ts:52` | referenced |
| `scripts/docs-arch.mjs` | 87 | 2 | — | 39 | `scripts/handoff-verify.mjs:73`, `scripts/__tests__/handoff-verify.test.ts:38` | referenced |
| `scripts/docs-decisions.mjs` | 110 | 2 | — | 27 | `scripts/handoff-verify.mjs:72`, `scripts/__tests__/handoff-verify.test.ts:37` | referenced |
| `scripts/friction-disposition.mjs` | 1692 | 8 | — | 14 | `scripts/__tests__/test-budget.test.ts:905`, `scripts/__tests__/friction-disposition.test.ts:2` | referenced |
| `scripts/handoff-verify.mjs` | 390 | 7 | — | 26 | `scripts/__tests__/handoff-verify.test.ts:2`, `scripts/__tests__/handoff-verify.test.ts:35` | referenced |
| `scripts/lib/handoff-claims.mjs` | 558 | 6 | — | 7 | `scripts/handoff-verify.mjs:5`, `scripts/handoff-verify.mjs:74` | referenced |
| `scripts/lib/pr-evidence.mjs` | 422 | 4 | — | 29 | `scripts/__tests__/pr-evidence.test.ts:2`, `scripts/__tests__/pr-evidence.test.ts:39` | referenced |
| `scripts/lib/record-fields.mjs` | 461 | 3 | — | 9 | `scripts/__tests__/review-record.test.ts:38`, `scripts/__tests__/review-record.test.ts:60` | referenced |
| `scripts/lib/scratch-root.mjs` | 1030 | 5 | — | 22 | `scripts/__tests__/scratch-root.test.ts:70`, `scripts/__tests__/scratch-root.test.ts:71` | referenced |
| `scripts/lib/suite-report.mjs` | 412 | 5 | — | 24 | `scripts/__tests__/suite-report.test.ts:2`, `scripts/__tests__/suite-report.test.ts:47` | referenced |
| `scripts/lib/test-budget-flow.mjs` | 128 | 2 | — | 5 | `scripts/__tests__/test-budget.test.ts:49`, `scripts/check-test-budget.mjs:64` | referenced |
| `scripts/pr-evidence.mjs` | 345 | 3 | — | 29 | `scripts/__tests__/pr-evidence.test.ts:2`, `scripts/__tests__/pr-evidence.test.ts:39` | referenced |
| `scripts/review-record.mjs` | 517 | 7 | — | 37 | `scripts/scratch-root.mjs:17`, `scripts/__tests__/review-record.test.ts:40` | referenced |
| `scripts/scratch-root.mjs` | 186 | 2 | — | 22 | `scripts/__tests__/scratch-root.test.ts:70`, `scripts/__tests__/scratch-root.test.ts:71` | referenced |
| `scripts/suite-report.mjs` | 244 | 4 | — | 24 | `scripts/__tests__/suite-report.test.ts:2`, `scripts/__tests__/suite-report.test.ts:47` | referenced |
| `scripts/ts-ast.mjs` | 237 | 4 | — | 56 | `scripts/check-imports.mjs:53`, `scripts/check-imports.mjs:60` | referenced |
| `src/__tests__/agent-guidance.test.ts` | 78 | 3 | 10 | 8 | `.development/investigations/composition-root-context-proposal-2026-11-08.md:377`, `.development/investigations/composition-root-context-proposal-2026-11-08.md:408` | CI |
| `src/__tests__/architecture-doc.test.ts` | 34 | 1 | 3 | 11 | `scripts/__tests__/docs-generators.test.ts:7`, `scripts/docs-arch.mjs:6` | CI |
| `src/__tests__/architecture-rules.test.ts` | 438 | 10 | 24 | 71 | `.development/investigations/composition-root-context-proposal-2026-11-08.md:33`, `.development/investigations/composition-root-context-proposal-2026-11-08.md:359` | CI |
| `src/__tests__/atomic-write.test.ts` | 245 | 2 | 33 | 0 | — | CI |
| `src/__tests__/background-batch-rejection.test.ts` | 215 | 3 | 10 | 11 | `.development/investigations/test-audit-2026-09-27/tmut-7.log:7`, `.development/investigations/test-audit-2026-09-27/tmut-7.log:14` | CI |
| `src/__tests__/background-default.test.ts` | 577 | 3 | 75 | 6 | `.development/investigations/plan-critique-431-2026-11-06.md:78`, `.development/investigations/test-plan-429-2026-11-06.md:16` | CI |
| `src/__tests__/background-fan-out.test.ts` | 671 | 11 | 78 | 37 | `.development/investigations/mode-prologue-design-2026-10-25.md:445`, `.development/investigations/mode-prologue-design-2026-10-25.md:458` | CI |
| `src/__tests__/background-pipeline-boundary.test.ts` | 257 | 1 | 19 | 0 | — | CI |
| `src/__tests__/background-run-extraction.test.ts` | 240 | 3 | 8 | 11 | `.development/investigations/test-audit-2026-09-27/tmut-6.log:7`, `.development/investigations/test-audit-2026-09-27/tmut-6.log:10` | CI |
| `src/__tests__/background-session-persistence.test.ts` | 874 | 10 | 106 | 30 | `.development/investigations/pr409-retain-transport-session-review-findings-2026-10-31.md:14`, `.development/investigations/u2-review-findings-2026-10-11.md:12` | CI |
| `src/__tests__/boot-recovery-factory.test.ts` | 315 | 3 | 27 | 8 | `.development/investigations/issue-545-log-data-serialization-spec-2026-11-21.md:96`, `.development/investigations/issue-546-record-flip-pending-spec-2026-11-21.md:502` | CI |
| `src/__tests__/boot-recovery-import-failure-546.test.ts` | 282 | 1 | 19 | 7 | `.development/investigations/issue-546-record-flip-pending-spec-2026-11-21.md:53`, `.development/investigations/issue-546-record-flip-pending-spec-2026-11-21.md:525` | CI |
| `src/__tests__/branch-headstate-refusal.test.ts` | 165 | 1 | 18 | 2 | `.development/investigations/issue-466-headstate-2026-11-08.md:614`, `src/__tests__/headstate.test.ts:8` | CI |
| `src/__tests__/branch-lock-convoy.test.ts` | 318 | 4 | 22 | 1 | `.development/investigations/issue-460-investigation-2026-11-07.md:566` | CI |
| `src/__tests__/chain-parallel.test.ts` | 661 | 5 | 96 | 29 | `.development/PROPOSAL_PLAN-BACKGROUND_PARALLEL_SUBAGENTS.md:260`, `.development/investigations/mode-prologue-design-2026-10-25.md:449` | CI |
| `src/__tests__/changelog-format.test.ts` | 44 | 1 | 4 | 2 | `.pi/skills/worktree/references/release-ritual.md:64`, `.development/FRICTION_LOG.md:212` | CI |
| `src/__tests__/circuit.test.ts` | 186 | 3 | 34 | 4 | `.development/investigations/issue-340-dangling-row-spec-2026-10-16.md:111`, `.development/investigations/issue-239/traces/reports/p0-report.json:1` | CI |
| `src/__tests__/conductor-guardrails.test.ts` | 124 | 7 | 23 | 11 | `.development/investigations/composition-root-context-proposal-2026-11-08.md:378`, `.development/investigations/issue-426-timeout-guidance-spec-2026-11-18.md:27` | CI |
| `src/__tests__/cost.test.ts` | 155 | 3 | 12 | 4 | `.development/investigations/issue-239/traces/reports/p0-report.json:1`, `.development/investigations/issue-239/traces/reports/p3-report.json:1` | CI |
| `src/__tests__/dangling-row.test.ts` | 378 | 2 | 47 | 1 | `.development/investigations/issue-340-review-findings-2026-10-16.md:12` | CI |
| `src/__tests__/dashboard-panels.test.ts` | 585 | 3 | 21 | 2 | `.development/investigations/pr357-358-refactor-review-findings-2026-10-18.md:32`, `src/tui.ts:2008` | CI |
| `src/__tests__/decisions-index.test.ts` | 44 | 1 | 8 | 7 | `scripts/docs-decisions.mjs:6`, `scripts/__tests__/docs-generators.test.ts:7` | CI |
| `src/__tests__/diff.test.ts` | 170 | 3 | 42 | 2 | `.development/investigations/issue-239/traces/reports/p0-report.json:1`, `.development/investigations/issue-239/traces/reports/p3-report.json:1` | CI |
| `src/__tests__/dispatch-capability-guards.test.ts` | 532 | 4 | 86 | 76 | `.development/investigations/mode-prologue-design-2026-10-25.md:446`, `.development/investigations/mode-prologue-design-2026-10-25.md:458` | CI |
| `src/__tests__/dispatch-line-enforcement.test.ts` | 602 | 3 | 59 | 3 | `.development/decisions/0020-nojev-handler-validation.md:69`, `.development/investigations/plan-critique-431-2026-11-06.md:66` | CI |
| `src/__tests__/dispatch-line.test.ts` | 380 | 3 | 54 | 6 | `.development/decisions/0020-nojev-handler-validation.md:63`, `.development/investigations/issue-415-process-checks-brief-2026-10-31.md:21` | CI |
| `src/__tests__/dispatch-preflight.test.ts` | 1302 | 8 | 170 | 7 | `.development/investigations/plan-critique-431-2026-11-06.md:62`, `.development/investigations/plan-critique-431-2026-11-06.md:158` | CI |
| `src/__tests__/e2e-subprocess.test.ts` | 639 | 11 | 57 | 16 | `.development/investigations/277-context-canceled/findings.md:164`, `.development/ARCHITECTURE.md:203` | CI |
| `src/__tests__/e2e.test.ts` | 197 | 9 | 24 | 20 | `.development/TASKS.md:103`, `.github/scripts/smoke-artifact.mjs:474` | CI |
| `src/__tests__/empty-tools-442.test.ts` | 243 | 1 | 32 | 3 | `.development/investigations/issue-537-preflight-capability-rows-spec-2026-11-18.md:27`, `.development/investigations/issue-537-preflight-capability-rows-spec-2026-11-18.md:33` | CI |
| `src/__tests__/empty-tools-background-442.test.ts` | 243 | 1 | 11 | 4 | `.development/investigations/issue-453-investigation-2026-11-07.md:44`, `.development/investigations/issue-439-investigation-2026-11-07.md:11` | CI |
| `src/__tests__/empty-tools-child-442.test.ts` | 185 | 1 | 19 | 2 | `src/__tests__/empty-tools-propagation-442.test.ts:18`, `src/__tests__/empty-tools-442.test.ts:20` | CI |
| `src/__tests__/empty-tools-propagation-442.test.ts` | 300 | 1 | 25 | 0 | — | CI |
| `src/__tests__/engineering-bar.test.ts` | 410 | 1 | 55 | 5 | `.development/investigations/issue-453-investigation-2026-11-07.md:44`, `.development/investigations/issue-439-investigation-2026-11-07.md:11` | CI |
| `src/__tests__/failure-worktree-state.test.ts` | 466 | 1 | 37 | 0 | — | CI |
| `src/__tests__/footer-activity.test.ts` | 830 | 5 | 118 | 2 | `.development/investigations/composition-root-context-proposal-2026-11-08.md:398`, `.development/investigations/composition-root-context-proposal-2026-11-08.md:407` | CI |
| `src/__tests__/get-subagent-result-lineage.test.ts` | 527 | 5 | 56 | 5 | `.development/investigations/test-plan-428-2026-11-06.md:115`, `.development/investigations/test-plan-428-2026-11-06.md:276` | CI |
| `src/__tests__/git-auto-approve.test.ts` | 320 | 3 | 21 | 2 | `.development/investigations/plan-critique-431-2026-11-06.md:95`, `.development/investigations/plan-critique-431-2026-11-06.md:383` | CI |
| `src/__tests__/git-real.test.ts` | 357 | 5 | 60 | 4 | `.development/investigations/issue-239/traces/reports/p0-report.json:1`, `.development/investigations/issue-239/traces/reports/p3-report.json:1` | CI |
| `src/__tests__/git.test.ts` | 307 | 5 | 30 | 13 | `.development/investigations/issue-239/traces/reports/p0-report.json:1`, `.development/investigations/issue-239/traces/reports/p3-report.json:1` | CI |
| `src/__tests__/headstate-git.test.ts` | 247 | 1 | 27 | 3 | `.development/investigations/issue-466-headstate-2026-11-08.md:610`, `src/__tests__/headstate.test.ts:7` | CI |
| `src/__tests__/headstate.test.ts` | 299 | 2 | 58 | 2 | `.development/investigations/issue-466-headstate-2026-11-08.md:607`, `src/__tests__/headstate-git.test.ts:4` | CI |
| `src/__tests__/history.test.ts` | 172 | 5 | 22 | 14 | `.development/investigations/test-audit-2026-09-27/revert-sweep-findings.md:18`, `.development/investigations/test-audit-2026-09-27/revert-sweep-d1601a1.log:7` | CI |
| `src/__tests__/import-convention.test.ts` | 214 | 11 | 33 | 1 | `scripts/__tests__/check-imports.test.ts:5` | CI |
| `src/__tests__/integration.test.ts` | 1614 | 11 | 262 | 89 | `.development/investigations/composition-root-context-proposal-2026-11-08.md:291`, `.development/investigations/composition-root-context-proposal-2026-11-08.md:381` | CI |
| `src/__tests__/json-scanner.test.ts` | 572 | 2 | 27 | 6 | `.development/investigations/test-plan-428-2026-11-06.md:311`, `.development/investigations/test-plan-428-2026-11-06.md:325` | CI |
| `src/__tests__/kill-escalation.test.ts` | 573 | 9 | 67 | 3 | `.development/investigations/issue-545-log-data-serialization-spec-2026-11-21.md:97`, `.development/investigations/issue-455-implementation-brief-2026-11-07.md:15` | CI |
| `src/__tests__/live-subagent.test.ts` | 141 | 2 | 19 | 5 | `.development/PROPOSAL_PLAN-BACKGROUND_PARALLEL_SUBAGENTS.md:260`, `.development/investigations/issue-239/traces/reports/p0-report.json:1` | CI |
| `src/__tests__/loader.test.ts` | 255 | 2 | 21 | 2 | `.development/investigations/pr387-loaders-review-findings-2026-10-25.md:3`, `.development/investigations/pr387-loaders-review-findings-2026-10-25.md:11` | CI |
| `src/__tests__/logging.test.ts` | 490 | 4 | 79 | 26 | `.development/investigations/issue-543-console-mirror-spec-2026-11-20.md:61`, `.development/investigations/issue-543-console-mirror-spec-2026-11-20.md:80` | CI |
| `src/__tests__/logical-runs-453.test.ts` | 315 | 3 | 36 | 0 | — | CI |
| `src/__tests__/menu-config-items.test.ts` | 743 | 4 | 73 | 4 | `.development/investigations/menu-polish-u7-spec-2026-10-17.md:33`, `.development/investigations/menu-polish-u2-spec-2026-10-17.md:116` | CI |
| `src/__tests__/menu-preset-parity.test.ts` | 502 | 2 | 49 | 0 | — | CI |
| `src/__tests__/menu-template-items.test.ts` | 361 | 1 | 35 | 2 | `.development/investigations/menu-polish-u5-spec-2026-10-17.md:73`, `.development/investigations/menu-polish-proposal-2026-10-17.md:494` | CI |
| `src/__tests__/menu-tier.test.ts` | 232 | 2 | 26 | 4 | `.development/investigations/menu-polish-u4-spec-2026-10-17.md:77`, `.development/investigations/menu-polish-proposal-2026-10-17.md:481` | CI |
| `src/__tests__/messaging.test.ts` | 345 | 5 | 68 | 2 | `.development/investigations/issue-239/traces/reports/p0-report.json:1`, `.development/investigations/issue-239/traces/reports/p3-report.json:1` | CI |
| `src/__tests__/metrics.test.ts` | 250 | 5 | 52 | 2 | `.development/investigations/issue-239/traces/reports/p0-report.json:1`, `.development/investigations/issue-239/traces/reports/p3-report.json:1` | CI |
| `src/__tests__/mode-prologue-unit.test.ts` | 254 | 1 | 34 | 1 | `.development/investigations/pr392-review-findings-2026-10-25.md:7` | CI |
| `src/__tests__/mode-prologue.test.ts` | 697 | 3 | 58 | 5 | `.development/investigations/pr392-review-findings-2026-10-25.md:17`, `.development/investigations/mode-prologue-design-2026-10-25.md:457` | CI |
| `src/__tests__/mode-runners-boundary.test.ts` | 68 | 1 | 8 | 2 | `.development/investigations/issue-545-log-data-serialization-spec-2026-11-21.md:98`, `.development/investigations/issue-537-preflight-capability-rows-spec-2026-11-18.md:45` | CI |
| `src/__tests__/model-availability.test.ts` | 148 | 1 | 17 | 2 | `.development/investigations/issue-239/traces/reports/p0-report.json:1`, `.development/investigations/issue-239/traces/reports/p3-report.json:1` | CI |
| `src/__tests__/monitor-selection.test.ts` | 259 | 1 | 16 | 0 | — | CI |
| `src/__tests__/no-temp-paths.test.ts` | 220 | 3 | 11 | 1 | `.development/HANDOFF-ARCHIVE-2026-11-18.md:42` | CI |
| `src/__tests__/notify-completion.test.ts` | 830 | 10 | 145 | 27 | `.development/PROPOSAL_PLAN-BACKGROUND_PARALLEL_SUBAGENTS.md:261`, `.development/investigations/test-audit-2026-09-27/tmut-8.log:7` | CI |
| `src/__tests__/package-manifest.test.ts` | 76 | 4 | 9 | 2 | `.development/investigations/issue-239/traces/reports/p0-report.json:1`, `.development/investigations/issue-239/traces/reports/p3-report.json:1` | CI |
| `src/__tests__/params.test.ts` | 160 | 4 | 21 | 12 | `.development/investigations/mode-prologue-design-2026-10-25.md:258`, `.development/investigations/mode-prologue-design-2026-10-25.md:425` | CI |
| `src/__tests__/per-step-cwd.test.ts` | 480 | 3 | 57 | 41 | `.development/investigations/mode-prologue-design-2026-10-25.md:447`, `.development/investigations/test-audit-2026-09-27/tmut-2.log:7` | CI |
| `src/__tests__/per-step-model.test.ts` | 2170 | 21 | 322 | 30 | `.development/investigations/mode-prologue-design-2026-10-25.md:259`, `.development/investigations/mode-prologue-design-2026-10-25.md:448` | CI |
| `src/__tests__/preflight.test.ts` | 267 | 10 | 33 | 7 | `.development/HANDOFF-ARCHIVE-2026-11-18.md:37`, `.development/investigations/mode-prologue-design-2026-10-25.md:450` | CI |
| `src/__tests__/preset-model.test.ts` | 123 | 1 | 10 | 2 | `.development/investigations/issue-239/traces/reports/p0-report.json:1`, `.development/investigations/issue-239/traces/reports/p3-report.json:1` | CI |
| `src/__tests__/presets-files.test.ts` | 489 | 3 | 48 | 13 | `.development/TASKS.md:237`, `.development/investigations/test-plan-429-2026-11-06.md:101` | CI |
| `src/__tests__/presets.test.ts` | 293 | 6 | 48 | 3 | `.development/investigations/issue-443-plan-critique-2026-11-07.md:19`, `.development/investigations/issue-239/traces/reports/p0-report.json:1` | CI |
| `src/__tests__/priority.test.ts` | 102 | 3 | 23 | 2 | `.development/investigations/issue-239/traces/reports/p0-report.json:1`, `.development/investigations/issue-239/traces/reports/p3-report.json:1` | CI |
| `src/__tests__/proc.test.ts` | 207 | 5 | 24 | 8 | `.development/investigations/issue-299-optionb-review-findings-2026-10-10.md:149`, `.development/investigations/issue-299-optionb-review-findings-2026-10-10.md:150` | CI |
| `src/__tests__/project-flags.test.ts` | 219 | 2 | 32 | 5 | `.development/decisions/0019-project-process-checks.md:56`, `.development/investigations/issue-537-preflight-capability-rows-spec-2026-11-18.md:29` | CI |
| `src/__tests__/prompt.test.ts` | 201 | 7 | 48 | 2 | `.development/investigations/issue-239/traces/reports/p0-report.json:1`, `.development/investigations/issue-239/traces/reports/p3-report.json:1` | CI |
| `src/__tests__/prose-duplication.test.ts` | 313 | 3 | 15 | 6 | `.development/investigations/composition-root-context-proposal-2026-11-08.md:386`, `.pi/skills/worktree/references/review-dispatch.md:408` | CI |
| `src/__tests__/readme-commands.test.ts` | 92 | 3 | 7 | 5 | `.development/investigations/composition-root-context-proposal-2026-11-08.md:379`, `.development/HANDOFF-ARCHIVE-2026-10-17.md:524` | CI |
| `src/__tests__/recovery-boot-notice.test.ts` | 285 | 2 | 21 | 6 | `.development/investigations/deps-pi-1.3.0-spec-2026-10-16.md:32`, `.development/investigations/issue-329-330-fix-spec-2026-10-12.md:19` | CI |
| `src/__tests__/recovery-retry-after-boot.test.ts` | 353 | 2 | 27 | 10 | `.development/investigations/deps-pi-1.3.0-spec-2026-10-16.md:32`, `.development/investigations/issue-329-330-fix-spec-2026-10-12.md:19` | CI |
| `src/__tests__/recovery-surface.test.ts` | 618 | 3 | 105 | 14 | `.development/investigations/issue-329-330-fix-spec-2026-10-12.md:17`, `.development/investigations/issue-329-330-fix-spec-2026-10-12.md:20` | CI |
| `src/__tests__/recovery-visibility-bridge.test.ts` | 317 | 3 | 40 | 8 | `.development/investigations/issue-329-330-fix-spec-2026-10-12.md:20`, `.development/investigations/issue-329-330-fix-spec-2026-10-12.md:24` | CI |
| `src/__tests__/recovery.test.ts` | 2394 | 23 | 284 | 40 | `.development/investigations/u1-review-verification-findings-2026-10-09.md:29`, `CHANGELOG.md:35` | CI |
| `src/__tests__/registration-surface.test.ts` | 299 | 3 | 34 | 6 | `.development/investigations/issue-426-timeout-guidance-spec-2026-11-18.md:28`, `.development/investigations/issue-426-timeout-guidance-spec-2026-11-18.md:108` | CI |
| `src/__tests__/reports.test.ts` | 385 | 4 | 51 | 2 | `.development/investigations/issue-239/traces/reports/p0-report.json:1`, `.development/investigations/issue-239/traces/reports/p3-report.json:1` | CI |
| `src/__tests__/resolve-params.test.ts` | 542 | 1 | 61 | 3 | `.development/investigations/test-plan-429-2026-11-06.md:99`, `src/__tests__/empty-tools-442.test.ts:14` | CI |
| `src/__tests__/retry-pins.test.ts` | 528 | 5 | 39 | 13 | `.development/HANDOFF-ARCHIVE-2026-10-17.md:471`, `.development/investigations/test-plan-428-2026-11-06.md:327` | CI |
| `src/__tests__/retry-preamble-bank-511.test.ts` | 228 | 4 | 34 | 0 | — | CI |
| `src/__tests__/router.test.ts` | 141 | 3 | 21 | 2 | `.development/investigations/issue-239/traces/reports/p0-report.json:1`, `.development/investigations/issue-239/traces/reports/p3-report.json:1` | CI |
| `src/__tests__/run-history-collapse.test.ts` | 173 | 4 | 15 | 2 | `.development/investigations/issue-329-330-fix-spec-2026-10-12.md:68`, `.development/investigations/issue-329-330-fix-spec-2026-10-12.md:90` | CI |
| `src/__tests__/run-history-output.test.ts` | 123 | 2 | 32 | 0 | — | CI |
| `src/__tests__/run-registry.test.ts` | 875 | 12 | 124 | 12 | `.development/investigations/u1-review-verification-findings-2026-10-09.md:25`, `.development/investigations/issue-340-dangling-row-spec-2026-10-16.md:29` | CI |
| `src/__tests__/runner.test.ts` | 927 | 8 | 80 | 12 | `.development/TASKS.md:226`, `.development/TASKS.md:232` | CI |
| `src/__tests__/runtime-vocabulary.test.ts` | 364 | 8 | 18 | 104 | `scripts/__tests__/fixtures/review-records/s4-no-recheck.md:18`, `.development/investigations/277-context-canceled/findings.md:40` | CI |
| `src/__tests__/s5-factories.test.ts` | 371 | 1 | 44 | 0 | — | CI |
| `src/__tests__/s6-seams.test.ts` | 1549 | 6 | 201 | 0 | — | CI |
| `src/__tests__/s6-trace.test.ts` | 783 | 1 | 5 | 0 | — | CI |
| `src/__tests__/sanitize.test.ts` | 571 | 13 | 111 | 2 | `.development/investigations/issue-239/traces/reports/p0-report.json:1`, `.development/investigations/issue-239/traces/reports/p3-report.json:1` | CI |
| `src/__tests__/scheduler.test.ts` | 290 | 6 | 51 | 62 | `.development/investigations/test-audit-2026-09-27/mutation-3.log:7`, `.development/investigations/test-audit-2026-09-27/mutation-3.log:14` | CI |
| `src/__tests__/schema-json-only.test.ts` | 40 | 1 | 4 | 0 | — | CI |
| `src/__tests__/scratch-root.test.ts` | 724 | 5 | 152 | 1 | `scripts/__tests__/suite-report.test.ts:27` | CI |
| `src/__tests__/scratch-spawn.test.ts` | 510 | 3 | 63 | 1 | `src/runner.ts:1087` | CI |
| `src/__tests__/sdk-abort-contract.test.ts` | 164 | 1 | 7 | 6 | `.development/investigations/issue-453-investigation-2026-11-07.md:236`, `.development/investigations/issue-453-investigation-2026-11-07.md:300` | CI |
| `src/__tests__/sdk-contract.test.ts` | 208 | 3 | 22 | 5 | `.development/TASKS.md:216`, `CHANGELOG.md:277` | CI |
| `src/__tests__/session-manager.test.ts` | 4761 | 60 | 709 | 275 | `.development/AUDIT.md:537`, `CHANGELOG.md:39` | CI |
| `src/__tests__/smoke-artifact-scanner.test.ts` | 160 | 1 | 28 | 90 | `.development/investigations/issue-239/traces/reports/p0-report.json:1`, `.development/investigations/issue-239/traces/reports/p3-report.json:1` | CI |
| `src/__tests__/started-tail-containment-439.test.ts` | 626 | 4 | 60 | 0 | — | CI |
| `src/__tests__/state-sweep.test.ts` | 532 | 5 | 72 | 20 | `.development/investigations/test-audit-2026-09-27/revert-sweep-findings.md:19`, `.development/investigations/test-audit-2026-09-27/revert-sweep-548877b.log:7` | CI |
| `src/__tests__/status-chokepoint.test.ts` | 197 | 4 | 23 | 7 | `.development/investigations/composition-root-context-proposal-2026-11-08.md:380`, `.development/investigations/issue-453-investigation-2026-11-07.md:212` | CI |
| `src/__tests__/store-permissions.test.ts` | 166 | 2 | 19 | 1 | `.development/investigations/pr410-store-permissions-review-findings-2026-10-31.md:16` | CI |
| `src/__tests__/streaming-sentinel.test.ts` | 302 | 2 | 31 | 15 | `.development/investigations/fix306-298-review-findings-2026-10-10.md:13`, `.development/investigations/test-audit-2026-09-27/revert-sweep-77e329a.log:7` | CI |
| `src/__tests__/temp-git-repo.test.ts` | 63 | 1 | 4 | 1 | `.development/investigations/fix302-recheck-findings-2026-10-10.md:14` | CI |
| `src/__tests__/templates-files.test.ts` | 807 | 4 | 129 | 19 | `.development/investigations/issue-443-plan-critique-2026-11-07.md:19`, `.development/investigations/plan-critique-429-2026-11-06.md:314` | CI |
| `src/__tests__/templates.test.ts` | 276 | 4 | 51 | 5 | `.development/investigations/plan-critique-429-2026-11-06.md:314`, `.development/investigations/issue-239/traces/reports/p0-report.json:1` | CI |
| `src/__tests__/terminal-listener-lifecycle.test.ts` | 829 | 1 | 57 | 7 | `.development/investigations/issue-437-design-2026-11-06.md:469`, `.development/investigations/issue-437-design-2026-11-06.md:629` | CI |
| `src/__tests__/terminal-notice-dedupe.test.ts` | 474 | 3 | 23 | 15 | `.development/investigations/fix318-review-findings-2026-10-10.md:10`, `.development/investigations/fix318-review-findings-2026-10-10.md:19` | CI |
| `src/__tests__/terminal-notifier-factory.test.ts` | 271 | 2 | 24 | 0 | — | CI |
| `src/__tests__/terminal-status-consistency.test.ts` | 688 | 6 | 43 | 71 | `.development/investigations/277-context-canceled/findings.md:41`, `.development/investigations/277-context-canceled/findings.md:50` | CI |
| `src/__tests__/thinking-level-443.test.ts` | 918 | 2 | 98 | 0 | — | CI |
| `src/__tests__/transcript-path.test.ts` | 52 | 1 | 10 | 1 | `.development/investigations/codegraph-bakeoff-2026-10-08/findings.md:39` | CI |
| `src/__tests__/transcript-tail.test.ts` | 258 | 1 | 35 | 2 | `.development/investigations/issue-239/traces/reports/p0-report.json:1`, `.development/investigations/issue-239/traces/reports/p3-report.json:1` | CI |
| `src/__tests__/transcript.test.ts` | 84 | 4 | 7 | 3 | `.development/HANDOFF-ARCHIVE-2026-10-17.md:162`, `.development/investigations/issue-239/traces/reports/p0-report.json:1` | CI |
| `src/__tests__/transport-auto-retry.test.ts` | 1072 | 11 | 131 | 28 | `.development/investigations/issue-404-plan-critique-2026-10-31.md:17`, `.development/investigations/issue-404-plan-critique-2026-10-31.md:20` | CI |
| `src/__tests__/tui-format.test.ts` | 611 | 7 | 154 | 11 | `.development/investigations/menu-polish-u1-spec-2026-10-17.md:39`, `.development/investigations/menu-polish-u1-spec-2026-10-17.md:87` | CI |
| `src/__tests__/tui-lines-modal-goldens.test.ts` | 227 | 1 | 12 | 1 | `.development/investigations/pr385-tui-review-findings-2026-10-25.md:4` | CI |
| `src/__tests__/tui-render-goldens.test.ts` | 235 | 1 | 9 | 3 | `.development/investigations/mode-prologue-design-2026-10-25.md:452`, `.development/investigations/mode-prologue-design-2026-10-25.md:527` | CI |
| `src/__tests__/types.test.ts` | 671 | 14 | 104 | 21 | `.development/HANDOFF-ARCHIVE-2026-11-18.md:46`, `.development/investigations/fix306-298-review-findings-2026-10-10.md:13` | CI |
| `src/__tests__/unit-params.test.ts` | 295 | 1 | 37 | 0 | — | CI |
| `src/__tests__/unit-pre-pass.test.ts` | 160 | 4 | 21 | 2 | `.development/investigations/pr391-prepass-review-findings-2026-10-25.md:6`, `.development/investigations/issue-537-preflight-capability-rows-spec-2026-11-18.md:141` | CI |
| `src/__tests__/unit-run.test.ts` | 558 | 3 | 70 | 8 | `.development/investigations/u1-review-verification-findings-2026-10-09.md:26`, `.development/investigations/issue-239/traces/reports/p0-report.json:1` | CI |
| `src/__tests__/validate.test.ts` | 665 | 12 | 140 | 21 | `.development/investigations/test-audit-2026-09-27/tmut-4.log:7`, `.development/investigations/test-audit-2026-09-27/tmut-4.log:184` | CI |
| `src/__tests__/worktree-report.test.ts` | 260 | 1 | 22 | 2 | `src/__tests__/sanitize.test.ts:522`, `src/__tests__/failure-worktree-state.test.ts:4` | CI |

### §6.2 Test setup, fixtures, and the standalone benchmark

These are support files, not `*.test.ts` cases. Their names are searched by the same `rg --hidden -n -F -f` method. A zero explicit name reference on a bench is normal when it is discovered by the benchmark runner.

| Path | LOC | Churn | `expect(` | Refs | Reference examples | Verdict |
|---|---:|---:|---:|---:|---|---|
| `src/__tests__/fixtures/deadline-census.ts` | 18 | 1 | 0 | 0 | — | test fixture/helper |
| `src/__tests__/fixtures/fs-mock.ts` | 84 | 2 | 0 | 0 | — | test fixture/helper |
| `src/__tests__/fixtures/scratch-root-isolation.ts` | 28 | 2 | 0 | 1 | `src/__tests__/setup-scratch-root.ts:10` | test fixture/helper |
| `src/__tests__/fixtures/stub-pi.mjs` | 72 | 1 | 0 | 2 | `src/__tests__/e2e-subprocess.test.ts:16`, `src/__tests__/e2e-subprocess.test.ts:53` | test fixture/helper |
| `src/__tests__/fixtures/temp-git-repo.ts` | 65 | 2 | 0 | 2 | `.development/investigations/fix302-recheck-findings-2026-10-10.md:14`, `.development/investigations/fix302-review-findings-2026-10-10.md:12` | test fixture/helper |
| `src/__tests__/fixtures/temp-lifecycle.ts` | 165 | 5 | 0 | 8 | `.development/HANDOFF-ARCHIVE-2026-10-17.md:160`, `.development/investigations/plan-critique-431-2026-11-06.md:165` | test fixture/helper |
| `src/__tests__/fixtures/tool-canary.ts` | 335 | 1 | 0 | 1 | `src/__tests__/empty-tools-child-442.test.ts:17` | test fixture/helper |
| `src/__tests__/setup-scratch-root.ts` | 19 | 1 | 0 | 1 | `vitest.config.ts:10` | Vitest setup |
| `src/__tests__/test.bench.ts` | 450 | 3 | 0 | 2 | `.development/investigations/codegraph-bakeoff-2026-10-08/findings.md:45`, `.development/investigations/pi-sdk-1.0.0-ts7-preflight/raw-typecheck-incl-tests.txt:260` | manual bench; outside CI |

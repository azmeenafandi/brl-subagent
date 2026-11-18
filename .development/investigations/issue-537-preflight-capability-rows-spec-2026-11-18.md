# #537 — the pre-flight's write/edit warnings on a bash-writing reviewer (and the delete row)

**Issue:** #537 — P0, `fix: mechanical`. Folded with the delete row (same false-claim class).
**Spec:** 2026-11-18 · **classifier risk C2** · **worktree y** · review: C2 focused.
**Jev:** `jev: low (0.47) · C2 · worktree y` (minted 2026-11-18, provenance label `impl-537`).

## Context (verified)

`validatePreTask` (`src/validate.ts:365`) is the deterministic H1 capability scan run before every
dispatch. It maps keyword patterns in the task text to required builtin tools (`TOOL_REQUIREMENTS`,
`src/validate.ts:116`), emits warning-class lines for a missing capability, and promotes only two
shapes to hard errors (a run/execute/test/compile/benchmark task with no bash; an exploration task
with none of find/ls/grep/bash), plus the separate `outputFile`-without-write error.

The reviewer preset is `read/grep/find/ls/bash`, `excludeTools: [write, edit]` — read-only, but it
legitimately writes its findings bank and record **through bash**. Its task text contains "write",
"create", "edit" and "fix", so the write and edit rows match, and each row emits one warning per
missing tool: **four lines per review dispatch**. Live evidence: `review-534` and `review-535`; the
shipped-half and review-debt closes named it; ~4th appearance. The same warning channel carries the
two hard errors — warning fatigue on the one surface that must stay loud.

## Recon (Rule 13 — codegraph @ 42b449d)
- target: `validatePreTask` (file: src/validate.ts)
- callers(validatePreTask):
  - 13 caller(s)
  - src/__tests__/dispatch-line.test.ts:1 (dispatch-line.test.ts)
  - src/__tests__/empty-tools-442.test.ts:1 (empty-tools-442.test.ts)
  - src/__tests__/integration.test.ts:1 (integration.test.ts)
  - src/__tests__/project-flags.test.ts:1 (project-flags.test.ts)
  - src/__tests__/validate.test.ts:1 (validate.test.ts)
  - src/delegate-handler.ts:949 (prepareForeground)
  - src/__tests__/dispatch-line.test.ts:273 (dispatch)
  - src/__tests__/empty-tools-442.test.ts:198 (dispatch)
  - src/prelude.ts:291 (runPreTaskValidation)
  - src/__tests__/presets-files.test.ts:458 (validate)
  - src/__tests__/presets-files.test.ts:1 (presets-files.test.ts)
  - src/delegate-handler.ts:1 (delegate-handler.ts)
  - … +1 more
- impact(validatePreTask, depth 2):
  - 30 affected symbols across 20 files
  - files: src/validate.ts, src/__tests__/dispatch-line.test.ts, src/__tests__/empty-tools-442.test.ts, src/__tests__/integration.test.ts, src/__tests__/project-flags.test.ts, src/__tests__/validate.test.ts, src/delegate-handler.ts, src/prelude.ts …
- affected(src/validate.ts):
  - 82 test file(s)
  - src/__tests__/boot-recovery-factory.test.ts
  - src/__tests__/mode-runners-boundary.test.ts
  - src/__tests__/notify-completion.test.ts
  - src/__tests__/recovery-boot-notice.test.ts
  - src/__tests__/recovery-retry-after-boot.test.ts
  - src/__tests__/recovery-surface.test.ts
  - src/__tests__/recovery-visibility-bridge.test.ts
  - src/__tests__/recovery.test.ts
  - src/__tests__/run-registry.test.ts
  - src/__tests__/runner.test.ts
- grep delta: 105 raw hits for `validatePreTask` (incl. comments/strings) — record what grep added or the graph missed

**Grep delta.** The graph gave the seams (foreground `prepareForeground`, batch `runModePrologue`,
unit pre-pass, background fan-out/single, preset resolution). Grep added the exact warning-text pins
the graph lists only as files: `dispatch-capability-guards.test.ts:387` and `:414` (a **bash-bearing**,
write/edit-less fixture) — and confirmed **no test pins the delete row** anywhere.
`grep -rn "involves writing\|involves editing" src` = 2 assertions, both in that file. **Grep gap,
found by the plan critique:** `e2e.test.ts:94` holds the same bash-bearing create fixture but
asserts with `/write|edit/`, not the warning text — an exact-text search cannot see it. Round 2 found
a third shape: `validate.test.ts:301` asserts `warnings.length > 0` with no literal text at all. The
exact claim is "a test asserts a write/edit warning", not "a test contains the warning string" —
regex assertions and count assertions both evade text search.

## Problem

1. **Write/edit rows require write AND edit** (`requiredTools: ['write','edit']`). With bash present
   the capability exists, yet both missing tools warn — two matched rows × two missing tools = four
   warnings on the correct reviewer shape. The naive fix over-corrects: `edit` cannot create a
   missing file, so an any-of that accepts `edit` for the create half would hide a genuine gap.
2. **The delete row requires write AND bash** (`src/validate.ts:155`). The write arm is not merely
   over-strict — **the write tool cannot unlink**. bash is the only builtin that deletes; a
   bash-bearing reviewer still gets told to add write for a delete task.

The scan's claim is a *capability* claim; with bash present these warnings are false. The dedicated
tools remain preferable by the prompt, and `outputFile` keeps its hard error (the output block says
"Use the write tool to create this file").

## Design

Data-table change only, in `src/validate.ts`:

- **write row** (write + create) → `requiredTools: []`, `anyOfTools: ['write', 'bash']` — `edit`
  cannot create a missing file, so it must not satisfy this arm (critique round 1, major 2).
- **edit row** (edit an existing file) → `requiredTools: []`, `anyOfTools: ['write', 'edit', 'bash']`
  — `write` can rewrite a file wholesale, so it satisfies editing.
- **delete row** → `requiredTools: ['bash']`
- **`COVERAGE BOUNDARY` comment** → state the rule: bash satisfies write/edit/delete; the delete row
  does not require write (write cannot unlink); the scan sees builtins only.

The existing `anyOfTools` branch already emits **one** warning naming every option:
`Task involves writing/creating files but none of 'write', 'bash' is available (tools=…,
excludeTools=…)` for the write arm, and `Task involves editing files but none of 'write', 'edit',
'bash' is available …` for the edit arm. A bash-less, write/edit-less toolset therefore gets one
line per matched row (max two), not four.

**Unchanged:** the blocking capability errors, `force` semantics, `outputFile`-without-write (hard
error), the presets (the reviewer stays read-only with bash), and custom-tool awareness (the scan
sees builtins only — pre-existing).

## Tests

`src/__tests__/validate.test.ts`
- `:30` "warns when write tool is missing…" → rewrite: bash present (reviewer toolset) → **no**
  write/edit warning; add a bash-less twin (`tools: [read]`) → the anyOf warning naming write/bash.
- `:65` same for the edit row (the anyOf names write/edit/bash).
- `:157` "keeps write/edit mismatches warning-class" → switch the fixture to `tools: [read]` so it
  still produces a warning; assert valid / no errors / warning present.
- New: **edit-only cannot create** — `tools: [read, edit]` + "Create a new file with the API
  endpoint" → warns, naming write/bash (critique round 1, major 2; the falsifier for the split).
- New: **edit satisfies the edit row** — `tools: [read, edit]` + "Refactor the authentication
  module" → no edit warning; and `tools: [read, write]` + the same → no edit warning (write
  rewrites).
- `:301` "no outputFile → existing behavior unchanged" — the same bash-bearing create fixture
  (`excludeTools: [write,edit]`, no `tools` allowlist, so bash is available) asserts
  `warnings.length > 0`; add `bash` to its exclusions (or set `tools: [read]`) so the warning still
  fires and the assertion keeps its meaning (critique round 2, major 1 — a count assertion with no
  literal text, invisible to an exact-text search).
- New: delete row — bash-only toolset + delete task ("delete the stale artifacts") → no warning;
  bash-less (`tools: [read,write,edit]`) → exactly the `'bash' is not available` line, and **no**
  write warning.

`src/__tests__/dispatch-capability-guards.test.ts`
- `:387` and `:414` — the "update the docs" fixture (`tools: [read,bash]`) currently pins the false
  claim. Switch the fixture to `tools: [read]` (keeps the evidence and the #220 rendering pins) and
  update the exact string to the anyOf wording
  `Task involves editing files but none of 'write', 'edit', 'bash' is available (tools=read,
  excludeTools=none)`.
- New reviewer-shape acceptance through `execute()`: `tools: [read,grep,find,ls,bash]`,
  `excludeTools: [write,edit]`, a review-shaped task that reproduces the real triggering vocabulary
  ("Review the change: write nothing, create nothing, edit nothing, delete nothing; bank the
  findings and write the record through bash") → the result is **not** an error, `runSubagent` is
  called, and the result carries no "Task involves writing/creating files", no "Task involves
  editing files" and no "Task involves deleting files" line (critique round 1, minor 1).
  The original `review-534`/`review-535` task texts live in gitignored `.pi/subagents/*.json` and
  cannot be replayed in CI; this fixture is the documented equivalent probe, and its vocabulary is
  the union of the real texts' triggering words.
- Untouched: `:377` (bash warning, tools read/write/edit), `:426` (unit-prefixed bash warning),
  `presets-files.test.ts` T4 (outputFile hard error), `unit-pre-pass.test.ts:117` (force-degraded
  bash warning).

`src/__tests__/e2e.test.ts`
- `:94` "validatePreTask detects missing write tool" is the **same bash-bearing create fixture**
  (`tools: [read,bash,grep]`, exclude write/edit) and asserts a warning — it would redden. Switch
  its toolset to `tools: [read]` (no bash) so the jiti integration still proves a genuinely missing
  create capability; the assertion stays. (Critique round 1, major 1; the exact-text grep missed it
  because it asserts with `/write|edit/`, not the warning text.)

## Acceptance

1. The reviewer shape produces **0** write/edit warnings at the same task text (issue acceptance).
2. The bash-less, write/edit-less fixture still warns, and the line names write, edit and bash
   (issue acceptance).
3. The delete row: 0 warnings with bash for a task that uses a **matching** delete verb ("delete
   the stale artifacts"); exactly one "bash is not available" without. ("deleting" is an inflected
   form the unchanged regex does not match — a documented boundary; the fifth live warning on the
   critique dispatch came from the plan's own "delete row" wording, not from the issue's
   "deleting files". The earlier acceptance claim was vacuous — critique round 2, minor 1.)
4. The split is pinned both ways: an edit-only create task warns (write/bash named); an edit-only
   refactor task does not.
5. `outputFile` + `excludeTools: [write]` still a hard error (with and without `force`); a run task
   without bash still errors; exploration without find/ls/grep/bash still errors.
6. Suite + `tsc` green; the flow rule stays within its allowance.
7. **Dogfood:** the review dispatch for this PR emits no write/edit/delete warnings — the
   pre-flight's own complaint is gone (it fired five times on the plan-critique dispatch itself).

## Risks

- **Suppressing a genuine warning**: the predicate now says "capability exists"; a bash-bearing
  toolset genuinely can write/edit/delete. The dedicated-tool preference is not a capability gap.
  `outputFile` still requires write because the output block names that tool.
- **Message change**: bash-less toolset warnings now say "none of 'write', 'edit', 'bash'" instead of
  one line per tool — deliberate (actionable, one line per row). The exact-text pins change by design.
- **Edit-only create**: with the write arm restricted to write/bash, an edit-only toolset now warns
  on a write/create task even when the task only overwrites an existing file. That is the safe
  direction (warning-class, and the create half genuinely needs write/bash); the edit row still
  passes edit-only.
- **File rename is a documented false negative** (critique round 2, major 2): `rename` stays in the
  edit row, so a file-rename task with edit and/or write and no bash does not warn — neither can
  remove the old path. It was already a false negative for write+edit toolsets (both were required);
  the split extends it to edit-only and write-only. **Recommended disposition: accept and document**,
  not add a bash-only rename row: `rename` also describes symbol renames that `edit` performs, so a
  bash-only row would create a new false-positive class on ordinary refactors — the exact failure
  mode #537 exists to reduce. The coverage boundary is the table's word-matching limit. **Accepted
  by the maintainer 2026-11-18.**
- **Delete-row word matches**: `clean`/`prune` can describe code edits; bash-only is the file-deletion
  capability, and the edit row covers edits. Pre-existing word-table boundary.
- **Suite count**: small net growth; the flow rule (allowance 120 + 2 × net source growth) applies;
  the rows add no logic.

## Unit shape

One worktree, one implementer dispatch (`impl-537`, `project-implementer` +
`deepseek/deepseek-flash`, preset thinkingLevel `medium` — the classifier split is 0.56 low / 0.43
medium, so the preset's medium is the safe side), C2 focused review. Scope: `src/validate.ts` +
`validate.test.ts` + `dispatch-capability-guards.test.ts` + `e2e.test.ts`; no docs beyond the
coverage comment. **This spec is committed to `dev` before the worktree is created** (critique round
1, minor 2) so the implementer receives it through the tracked `.development/**` materialization; it
is therefore input, not a PR file, and the PR diff must not contain it. No release implied.

## Critique round 1 (2026-11-18)

`project-plan-critic` (gpt-6.1-terra, medium) — **Verdict: needs-work**, audited HEAD `42b449d`.
Disposition — **all four accepted**:

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 1 | major | `e2e.test.ts:94` is the same bash-bearing create fixture and would redden; the three-file scope missed it | Accepted — added to scope, fixture switched to bash-less |
| 2 | major | `edit` cannot create a missing file; any-of including edit is a false negative | Accepted — write row is `[write, bash]`, edit row `[write, edit, bash]`; edit-only create fixture pinned |
| 3 | minor | The reviewer-shape test only asserts absent strings; a rejected dispatch could pass; synthetic text instead of the real tasks | Accepted — assert success + spawn; vocabulary union fixture; the archived tasks are gitignored, so the equivalent probe is documented |
| 4 | minor | The spec is untracked and would not reach the worktree; scope excludes it | Accepted — commit the spec to `dev` before the worktree; it is input, not a PR file |

Verified sound by the critic: the recon reproduced at `42b449d`; the planned table change simulated
clean on both recorded original review tasks; no test pins the delete row.

## Critique round 2 (2026-11-18)

`project-plan-critic` (gpt-6.1-terra, medium) — **Verdict: needs-work**, audited HEAD `42b449d`.
Disposition:

| # | Severity | Finding | Disposition |
|---|---|---|---|
| 5 | major | `validate.test.ts:301` is a second bash-bearing create fixture asserting `warnings.length > 0`; the planned write row would make it warn-free and redden the test | Accepted — added to scope; fixture gains `bash` in its exclusions (the assertion keeps its meaning) |
| 6 | major | `rename` also means renaming a file; edit/write alone cannot remove the old path, so the split newly suppresses the warning for edit-only and write-only toolsets | **Accepted by the maintainer 2026-11-18** as a documented false negative (see Risks) — a bash-only rename row would newly warn on symbol renames that `edit` performs |
| 7 | minor | Acceptance 3's quoted "deleting files" is vacuous: `/\b(delete|remove|…)\b/` does not match "deleting" | Accepted — acceptance now uses a matching verb ("delete the stale artifacts"); the word-table inflection gap is documented |

Verified sound by round 2: the recon index is built from `42b449d`; the `e2e.test.ts:94` bash-less
fixture now produces the write/bash warning and satisfies `/write|edit/`; the mixed write row's
edit-only "add a comment" warning is the documented conservative tradeoff; both recorded review
tasks and the synthetic dispatch task simulate clean; the warning-pin query found five pins, all in
the planned test files; the spec is untracked but not ignored, so committing it before the worktree
makes it shippable.

# Issue #412 — implementation brief (rev. 2, post-critique)

HEAD `7495756` (critic audited). Verdict `needs-work` — 2 blockers + 10 majors incorporated. Absorbs #407.
**Order: the pre-flight mechanism first (Part 2), the three rules second (Part 1).** One PR.

## Part 2 — the dispatch pre-flight (built first)

### 2a. Rule 2's mechanism — the auto-switch (blocker 1: it was absent)

At `src/index.ts:2763` (`params.background ??= useBackground;`), after template resolution (`:2622`) and `retryRunId`
(`:2639`), before `preflightCheck` (`:2884`) / `validatePreTask` (`:2891`):

- Capture `explicitBackground = params.background` **before** defaulting.
- When `effectiveThinking ∈ {high, xhigh}` **and** `explicitBackground === false` **and** `params.timeout` is set
  explicitly: set `params.background = true`, **drop the explicit timeout** (the background 30-min
  `DEFAULT_BACKGROUND_DEADLINE_MS` applies), and emit a notice stating the true tool fact.
- `force: true` (existing field) keeps it foreground and logs "foreground forced"; no new reason channel —
  the dispatch text is the reason (`force` has no reason field; do not widen it, ADR 0007's text stays true).
- **Ordering invariant**: the switch must be applied **before** the retry snapshot (`src/params.ts:106`,
  `snapshotOriginalParams`) so `originalParams.background === true` and `transport-retry.ts:89` still classifies
  the run as background.
- Tests: (i) `thinkingLevel:"high", background:false, timeout:900000` → background spawn + notice, timeout = default;
  (ii) the same with `force:true` → foreground; (iii) `medium` stays untouched; (iv) the ordering test: the snapshot
  captures `background:true`, and the auto-retry predicate accepts the run.

### 2b. The Jev line check

- **Opt-in (blocker 2)**: a `package.json` field — `"brl-subagent": { "requireJevLine": true }` — read from
  `<cwd>/package.json`. Tracked, so it exists in every worktree (worktrees share the repo's package.json).
  Absent → no check (users unaffected). Add the field to this repo's `package.json` in the PR.
- **Check site**: inside `validatePreTask` (`src/validate.ts:293`) so all seven pre-spawn sites inherit it
  (`index.ts:2891` directly; `prelude.ts:235` inside `runPreTaskValidation`; the batch paths via
  `validateUnitPrePass` at `index.ts:574/962/1360` and `mode-prologue.ts:144`). Blocking error, not a warning.
  Coverage falsifier: a test that fails when a new pre-spawn path bypasses the check.
- **Parser**: new `src/dispatch-line.ts` (first line `// Purpose: …`, architecture-doc pin) — accepts the full line
  and the sanctioned escape `jev: unavailable` (`SKILL.md:263`). **Conformance test**: golden vectors shelled against
  `node .pi/skills/worktree/jev-check.mjs --line '<json>'` must agree accept/reject; mutate one pattern → fail
  (`.pi/` is not shipped, so no import is possible).
- **Bypass**: `noJev: Type.Optional(Type.String({ minLength: 1 }))` in `src/schema.ts` — `true` and `""` are refused
  at the schema layer; a handler test proves the logged bypass. Separate from `force`.
- **Foreground**: covered (the 15-min kill was a foreground dispatch). The merge audit stays background-only
  (`--log`) — deliberate, stated as a non-goal; foreground strictness is dispatch-time only.
- **Retries**: a retry inherits the original's line; no re-check; pin one test.
- **Provenance (Part 2c — the Goodhart fix)**: `jev-check --line '<json>' --label <name>` appends
  `<iso>\t<label>\t<line>` to `.pi/jev-lines.log` (gitignored); `--log --require-provenance` fails a logged dispatch
  line with no provenance entry, since the cutoff recorded in that file's header. `merge-guard` check (e) calls the
  action with `--require-provenance`. Historical dispatches exempt (cutoff = this PR's merge). Update `--selftest`.

### 2d. ADR 0018 (new; never edit 0007/0001)

`.development/decisions/0018-dispatch-preflight.md` — the hard pre-spawn reject, the opt-in field, the `force`/`noJev`
escapes, and rule 2's auto-switch. Run `npm run docs:decisions`, commit the regenerated index + README block.

## Part 1 — the three rules (docs, after Part 2)

1. `SKILL.md`: a **"Conductor decision rules"** section (no unprompted releases; no deadline ⇒ durable path; "done"
   carries its falsifier) **and** amend the Rule 22 text (`:257-264`): advisory for the *level*, **blocking on
   presence** when the project opts in; `jev: unavailable` is an accepted form.
2. `references/sprint-end-ritual.md`: **add** a record-row contract (there is none today) — the close row says
   "release: the maintainer's call", never a version.
3. `.pi/skills/handoff/references/handoff.md` (the durable write contract): the no-unprompted-release sentence —
   not only in `HANDOFF.md`, which is injected/regenerated.
4. `.pi/skills/pr/SKILL.md` §2: name the format `Verification: <command> → <observed result>` (extend the existing
   evidence section; do not add a second contract).
5. `references/review-dispatch.md`: the reviewer writes `/tmp/REVIEW_<n>.md` via bash **before** its final message
   (read-only reviewer, /tmp is scratch — the bank precedent); the conductor copies it into the worktree.
6. `CONTRIBUTING.md`: **AGENT.md is shipped product behavior; our build/release discipline lives in `.pi/skills/**`
   and `.development/`.**

## Stages

1. Worktree `../brl-subagent-412-…` on `feat/412-…`; re-stamp all line refs at the worktree's base sha.
2. Red tests → 2a → 2b/2c → ADR 0018 → Part 1 docs → gates: `npm run typecheck`; the **CI reporter form**
   (`npx vitest run --reporter=json --outputFile=vitest-report.json`) + `node scripts/check-readme-test-count.mjs`
   + `node scripts/check-test-budget.mjs`; `npm run docs:arch` (write mode) + commit `.development/ARCHITECTURE.md`.
3. C1 adversarial review; merge gate — the **conductor** runs `codegraph-refresh.sh` + `codegraph-check.py` at the
   merged head (a new `src/` module makes this mandatory).
4. Post-merge local config: the `${jev}` slot in **all five** local templates (`adversarial-review`, `debug-task`,
   `design-proposal`, `focused-review`, `plan-critique`); the reviewer-preset wording for the `/tmp` record.
   (An unfilled slot hard-errors at resolution — the desired fail-fast.)

## Non-goals

- `--log` stays background-only (foreground is dispatch-time only).
- No classifier or ledger-format change; no resumable timeouts.

## Resolved by the critique (do not re-open)

- ADR 0018: **yes**; run `docs:decisions`, commit the README decisions block.
- `noJev: true` / `""`: refused **at the schema layer** (`minLength: 1`), plus a handler-level test.
- `jev: unavailable`: **accepted** as a line (SKILL's sanctioned escape).
- The auto-switch must be recorded **before** the retry snapshot; ordering test name it.
- Foreground is covered at dispatch; the merge audit stays background-only.

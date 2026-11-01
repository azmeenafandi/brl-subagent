# Issue #411 — implementation brief (rev. 2, post-critique)

Draft plan, 2026-10-31. HEAD `5989198`. Critic verdict 2026-10-31 (`needs-work`, 2 blockers / 8 majors) — every
finding below is incorporated; the critic's evidence is in the session record. Issue #411; ADR 0001.

## Goal

Move #401's resume preamble out of the `<task>` fence onto the child's **system-prompt side**, without changing the
preamble text, the wrapped task, or the recorded task. Verdict on the critic's meta-point: the trust boundary is
**conductor-computed and charset-bounded**, not "system-side" (the latter is gameable).

## Design (A, chosen — refined by the critique)

1. New `resumeContext?: string` on both spawn shapes (`src/index.ts:1937`; `src/session-manager.ts:1130` params).
2. `src/index.ts:2329` → `task: singleTask`, `resumeContext: attemptContext`. Leave the `originalParams` ternary
   (`:2340-2342`) alone — collapsing it is out of scope; a new test pins the invariant instead.
3. `src/session-manager.ts:1234-1253`:
   - `const sections: string[] = [];` push the existing `<system-prompt>` literal when `params.systemPrompt?.trim()`;
     push `\n<resume-context>\n${params.resumeContext.trim()}\n</resume-context>\n` when `params.resumeContext?.trim()`.
   - **Keep the conditional spread**: `...(sections.length ? { appendSystemPrompt: sections } : {})` — `[] !== undefined`
     and `session-manager.test.ts:227/:240` assert `undefined` for empty/whitespace prompts.
   - Deterministic order: `<system-prompt>` first, `<resume-context>` second.
4. Why not overload `systemPrompt`: it carries the merged `bgPrompt`; the only reader is `session-manager.ts:1234-1235`
   (`grep -rn systemPrompt src/*.ts` — `history.ts:190` persists the raw param, `params.ts:266` merges presets,
   `runner.ts:1084-1085` is the foreground temp-file path). Mixing conductor context in would make ordering and
   attribution untestable.

## Verified mechanism (critic's live probe, installed pi 1.4.0)

`buildSystemPrompt({appendSystemPrompt: entries})` joins entries with `"\n\n"` (`agent-session.js:1298`) **inside the
single `<addendum>` section** (`system-prompt.js:97-98`). So multi-entry is supported, array order is preserved, and
"a `<resume-context>` system-prompt section" is true only *inside* `<addendum>`. The plan says this, and the live
probe below reads the real retained `.jsonl` instead of a mock.

## ADR — new record, never an edit

`CONTRIBUTING.md:60-66`: "supersede, never edit an accepted record; regenerate with `npm run docs:decisions`."
Create **`.development/decisions/0017-resume-context-system-side.md`**: `# 0017. …`, `- **Status:** Accepted`,
`- **Date:** 2026-10-31`, `- **Issues:** #411`; Context cites 0001; consequence: *conductor-computed, charset-bounded
resume context is delivered as a `<resume-context>` entry in the child's `appendSystemPrompt`; the `<task>` fence
carries the task payload only.* Leave 0001's heading/Status/Date untouched. Gate: `src/__tests__/decisions-index.test.ts`
(filename↔heading number, unique numbers, ≥12 records).

## Pin moves (deliberate — every one re-pointed, none deleted, none vacuous)

| File | Today | After |
|---|---|---|
| `session-manager.test.ts:173` | `appendSystemPrompt` `toEqual(["\n<system-prompt>\n…\n</system-prompt>\n"])` | two-entry array, exact order |
| `session-manager.test.ts:227/:240` | `toBeUndefined()` for empty/whitespace `systemPrompt` | unchanged; add case: resumeContext with no systemPrompt → exactly one `<resume-context>` entry |
| `transport-auto-retry.test.ts:635-653` | literal marker assertions on `spawn.task` | same literals asserted on `spawn.resumeContext` |
| `transport-auto-retry.test.ts:650-682` | line-count bounds + `not.toContain` on `task`; `:421` `endsWith("\n\nreview the docs")` | bounds re-pointed at `resumeContext` (≤5 lines: marker + 3 + pointer); `:421` becomes `spawn.task === "review the docs"` |
| `transport-auto-retry.test.ts:725-730` | routing isolation asserts the marker **is in** `spawn.task` | move to `spawn.resumeContext`; ADD `expect(String(spawn.systemPrompt)).not.toContain("security-audit-run-123")` |
| `background-session-persistence.test.ts` | **untouched** — the #404 pointer pin is `retainedSessionPointer` (no preamble); the pointer-in-preamble pins are `transport-auto-retry.test.ts:644-648` | same file, assertions re-pointed |
| `retry-pins.test.ts:770-786` | fixture comment encodes the old behavior | keep the precedence pin (`originalParams.task` over `run.task`) and correct its comment |

## New tests (each must fail before, pass after)

1. **Real auto-retry falsifier**: run the actual transport-retry path; assert
   `spawn.task === spawn.originalParams.task === "review the docs"` and the persisted run entry's `task` contains no `[attempt`.
2. Foreground probe: `runSubagent` receives no `resumeContext` and its `-p` argument contains no `<resume-context>`
   (`runner.test.ts:71` already pins the wrap — do not duplicate it).
3. Attempt 3: preamble says attempt 3, no attempt-2 text compounded; recorded task = original.
4. Loader sections in order (mock is fine for the array shape; the live probe covers the real join).
5. `<resume-context>` neutralization: **not needed today** (both interpolations are charset-bounded) — but pin the rule:
   a test that fails the moment a third interpolated field is added without neutralization.

## Live probe stage (falsifier for the mechanism)

Spawn a real transport retry, read the retained `.jsonl`'s system message, assert the `<resume-context>` text appears
inside `<addendum>` and the task message contains no marker. Precedent:
`.development/investigations/issue-299-grandchild-reap-probe-2026-10-10.md`.

## Stages (ordered; worktree first — worktree-guard blocks `src/` edits outside one)

1. Worktree `../brl-subagent-411-…` on `fix/411-…` (`worktree-prep.sh`).
2. Red tests (the falsifiers above) → code → `npm run typecheck && npx vitest run`.
3. ADR 0017 + `npm run docs:decisions` (gate `decisions-index.test.ts`).
4. Docs: `README.md:131` and `:320`, `AGENT.md:44` ("prompt-only" → the new channel; note the spawn result's `Task:`
   line no longer shows the marker — accepted, `attempt`/`resumeOf` carry it), `src/index.ts:230-235` docstring, CHANGELOG.
5. Live probe.
6. **C1 adversarial review** (issue's risk class), then merge gate.

Rollback: a single-commit revert — no record/schema migration.

## Non-goals

- No change to `buildRetryResumePreamble` text.
- No foreground retry path (background-only).
- No #407 work (dispatch-line enforcement) — separate issue.
- No `originalParams` ternary collapse.

# Handoff mechanism — project extension + skill + document restructure

jev: medium (0.70) · risk C2 · worktree **y** (conductor override — Jev's `worktree` cell reads `false` because the
targets aren't `src/`/`presets/`; `.pi/extensions/**` is tracked code and this extension runs on every session).
Worktree: `../brl-subagent-wt-handoff` · branch `feat/handoff-mechanism` (from `dev`; symlinked prep).
Review: **C2 focused** (`project-reviewer` + `focused-review`, muse-spark) — the extension is code with session-wide
effects; the skill/docs get a conductor read.

## Context (the decision record)

HANDOFF.md is load-bearing across compaction but has **no trigger** and has accumulated three genres (current state,
operating notes, session history) with no pruning rule. Pi's extension events provide the missing hooks; the repo
already ships a project extension (`worktree-guard`). Settled in discussion (2026-10-17):

- **Read trigger:** `session_start` + **`session_compact`** (post-compaction) inject the STATE snapshot; the summary
  cannot be trusted to carry it.
- **Write/enforcement:** **no `session_before_compact` handler** — pi-vcc itself consumes that event and the runner
  keeps the LAST non-null result; a cancel could interfere or loop. Staleness is surfaced via a `Verified: <sha>`
  line in STATE compared with `git rev-parse HEAD`.
- **Inertness:** subagent children DO load extensions (`buildSubagentArgs` passes no `--no-extensions`) → guard on
  `BRL_SUBAGENT_DEPTH`; also inert in worktrees/non-`dev` branches and when the handoff file is absent.
- **Project-only:** the extension is invisible to the shipped `brl-subagent` extension; no `src/` changes.
- **History out:** archive the old sections verbatim; do not delete.

## Recon (Rule 13)

**Coverage boundary:** all targets are outside the structural index (`src/**`): `.pi/extensions/**`, `.pi/skills/**`,
`.development/**`. `recon.sh` has no meaningful target for this unit (same boundary recorded by #336). The instrument
is an explicit enumeration + the pi SDK's own declarations:

- `.pi/extensions/worktree-guard/{index.ts,guard.test.cjs}` — the project-extension pattern: `export default function
  init(pi)` with `pi.on(...)`; the test is a `node`-run `.cjs` using jiti to load TS.
- `.pi/skills/` — only `pr` and `worktree`; no handoff skill exists (grep `handoff|handover` over `.pi/skills`
  returns nothing).
- pi SDK `dist/core/extensions/types.d.ts` — `SessionStartEvent` (reasons `startup|reload|new|resume|fork`),
  `session_compact` (after success), `SessionBeforeCompactResult` (`cancel`, `compaction`), `session_shutdown`;
  `pi.on(...)`, `pi.sendMessage(...)`.
- pi examples — `dynamic-tools.ts` (`session_start`), `tic-tac-toe.ts` (`session_start` + `sendMessage`),
  `plan-mode/index.ts` (`sendMessage(..., { deliverAs: "followUp" })`).
- `src/runner.ts::buildSubagentArgs` — `--mode json -p --no-session …`, no `--no-extensions`; `src/sanitize.ts`
  `DEPTH_ENV_KEY = "BRL_SUBAGENT_DEPTH"`.
- pi-vcc `src/hooks/before-compact.ts` — registers `session_before_compact` + `session_compact`; its comment: the
  runner keeps the **last non-null** `session_before_compact` result.
- **Tracked-state check:** `git ls-files .pi/extensions/` → both worktree-guard files tracked; `check-ignore` → not
  ignored. (Observation: the guard's header says "gitignored" — stale; fix it in this unit as a one-line correction.)

## H1 — `.pi/extensions/handoff/` (the extension)

**Files:** `index.ts` (registration), `lib.ts` (pure helpers), `handoff.test.cjs` (node test, guard pattern), plus the
one-line worktree-guard header correction.

**Registration** (`export default function initHandoff(pi)`):

1. **`session_start`** — inject the handoff snapshot:
   - **Guards (all must pass; else no-op silently):** `process.env.BRL_SUBAGENT_DEPTH` unset; `.development/HANDOFF.md`
     exists; the cwd is the cockpit (branch `dev` and the repo root contains `.development/` — use
     `git rev-parse --show-toplevel`/`--abbrev-ref HEAD`).
   - **Extract:** the `## STATE` section (from the `## STATE` heading to the next `## ` heading) and the
     `Verified: <sha>` line inside it.
   - **Staleness:** compare with `git rev-parse HEAD` (the cockpit's dev tip). Prepend one line:
     - current → `Handoff verified at <short-sha> — matches HEAD.`
     - stale → `Handoff verified at <short-sha> but HEAD is <short-sha> — RECONCILE before trusting §STATE.`
     - unparseable → `Handoff has no Verified: line — verify §STATE against the repo before trusting it.`
   - **Inject:** `pi.sendMessage({ customType: "handoff-state", content: <staleness + STATE section>,
     display: <short banner> }, { deliverAs: "nextTurn" })` — verify the exact option against the SDK types and the
     plan-mode example; no `triggerTurn` (passive context, not a run).
   - **Dedupe:** do not inject twice in the same session — check the branch entries for an existing `handoff-state`
     message (`ctx.sessionManager.getBranch()`); on reload/reason `"reload"` skip if present. If the branch API makes
     this awkward, accept a reload duplicate and document it (report which).
2. **`session_compact`** — same injection (a compaction is a context reset; no dedupe against earlier injections).
   Must not observe `session_before_compact` at all.
3. **`session_shutdown`** — write the staleness line to the session log only; no UI, no message.
4. **`/handoff` command** — show the STATE section + the staleness line + the verify-command list (from the skill
   reference); `/handoff mark` rewrites the `Verified: <sha>` line to the current dev HEAD (a convenience; the
   conductor still owns the content).
5. **Inertness:** in a worktree, a subagent, or a non-project cwd → no reads, no messages, no commands beyond
   registration.

**`lib.ts` (pure, testable):** `extractStateSection(raw)`, `parseVerified(raw)`, `buildStaleness(verified, head)`,
`shouldInject(env, branch, hasFile)`, `dedupeKey()`/`hasInjected(branchEntries)` — no fs/git inside (inject via
arguments), mirroring `classifyTier`'s style.

**Tests (`handoff.test.cjs`, guard pattern):** extract (markers present/missing/truncated), parse (valid/absent/
malformed sha), staleness (match/stale/unparseable), guards (depth env, non-dev branch, missing file), dedupe helper.
Run: `node .pi/extensions/handoff/handoff.test.cjs`. Also add the same assertions to a vitest-importable path if
tsconfig permits importing outside `src/`; if not, report that boundary and keep the node test.

## H2 — `.pi/skills/handoff/` (the contract)

**`SKILL.md`** — description: *Use when starting a fresh session, before or after compaction, or when asked to update
the handoff.* Body: the three rules, the structure, and the link to the reference (progressive disclosure).

**`references/handoff.md`** — the full contract:
- **Structure:** preamble ("how to use: read STATE → verify → open items → pointers"); `## STATE` with a
  `Verified: <sha> (<date>)` line + snapshot + `### Since the last handover` + `### Next actions`; `## Open items`;
  `## Operating notes`; `## Pointers`.
- **Write rules:** STATE is **replaced at each handover, never appended**; Open items pruned; total ≤ ~120 lines,
  STATE ≤ ~40; every STATE claim carries a verify command or is marked unverified.
- **`Verified:` protocol:** update at every handover and whenever the STATE materially changes (the hook compares it
  with dev HEAD and flags drift).
- **Pre-compaction checklist:** rewrite STATE → update `Verified:` → prune open items → confirm pointers.
- **History rule:** never store session narratives/release sections/superseded STATE; archive to
  `.development/HANDOFF-ARCHIVE-*.md` or rely on git/investigations.
- **Verify-command table:** tips (`git log -1`), install (`pi list`), board (`gh issue list`), release
  (`gh release list`), deps (`package.json`), suite (`npx vitest run`).

## H3 — HANDOFF restructure

- Rewrite `.development/HANDOFF.md` per the contract, with `Verified:` set to the current dev HEAD at the time of the
  rewrite; keep only current state + open items + operating notes + pointers.
- Move the old sections **verbatim** to `.development/HANDOFF-ARCHIVE-2026-10-17.md` (header: *historical; not current
  state; see git/investigations*).
- `.pi/skills/worktree/SKILL.md`: lifecycle **step 0** — "read the HANDOFF STATE (and the injected hook snapshot), then
  verify its claims"; the sprint-end ritual's cycle-open line stays.
- No `AGENTS.md` (the extension is the trigger); note it as a fallback for environments without the project extension.

## Verification

- **Unit:** `node .pi/extensions/handoff/handoff.test.cjs` green; the worktree-guard test still green.
- **Live (conductor, post-merge, dev dogfood):**
  1. `/reload` → the injected `handoff-state` message appears with the STATE + `matches HEAD`;
  2. mutate `Verified:` to a wrong sha → `/reload` → the **RECONCILE** line appears;
  3. `/pi-vcc` compaction → the post-compaction injection appears (the STATE after the summary);
  4. a subagent dispatch → no `handoff-state` in the child transcript/log;
  5. a worktree session (if practical) → inert.
- **Hygiene:** full suite / `tsc` (no `src/` changes, but run); docs guards; `git diff --check`; coverage lines.

## Risks / boundaries

- **pi-vcc interaction:** no `session_before_compact` handler; live-verify once (item 3) that nothing interferes.
- **Reload duplicates:** dedupe via branch entries; if the API is awkward, document the duplicate acceptance.
- **Token cost:** only the STATE section (~40 lines); measure it in the live check.
- **Inertness is the safety property:** any unguarded injection in a subagent or worktree is a **major** finding.
- The extension is read-only with respect to the handoff (except `/handoff mark`, which touches only the `Verified:`
  line).

## Out of scope

The shipped `brl-subagent` extension; pi-vcc; any `src/` change; the `.pi/extensions/worktree-guard` behavior (only its
stale header line).

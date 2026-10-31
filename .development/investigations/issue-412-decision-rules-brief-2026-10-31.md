# Issue #412 — implementation brief (rev. 1): the three decision rules + the dispatch pre-flight

Draft plan, 2026-10-31 (absorbs #407). HEAD `4f95228`. Every claim below was checked against the tree; the
seam list is the part the last brief got wrong, so it leads.

## Goal

Encode three conductor decision rules where a check can see them, and make the Rule 22 dispatch line **mechanical**
at `delegate_task` time — without rejecting a user's dispatch that has no Jev line (the rule is ours, the tool ships
to users). `AGENT.md` is untouched: it documents product behavior, not our process.

## Verified seams

- `validatePreTask` — `src/validate.ts`; called at `src/index.ts:2891` (single dispatch) and `src/prelude.ts:194`
  (batch gate 3b). Capability/tool validation, not the dispatch line.
- `src/preflight.ts:155 preflightCheck(cwd)` — environment only (pi binary, cwd readable, temp writable). Not the seam.
- Project-local config is **directories only**: `src/presets.ts:138`, `src/templates.ts:227` (`.pi/brl-subagent/…`);
  there is **no config-flag mechanism** (`ls src/` — no `config.ts`; `grep -rn "brl-subagent/" src/*.ts` → presets,
  templates, tui text only).
- `force` (capability override) — `src/schema.ts:200`.
- The cycle-end ritual (`references/sprint-end-ritual.md`) does **not** instruct proposing a version; the drift was
  the ritual *record row* we wrote at close (`FRICTION_LOG.md:178`) + the `§STATE` wording.
- PR body requirements — `.pi/skills/pr/SKILL.md`; review-record requirements —
  `.pi/skills/worktree/references/review-dispatch.md`.
- Local templates/presets are **gitignored** — a change to `.pi/brl-subagent/templates/plan-critique.md` cannot ride
  the PR; it is a post-merge local-config step.

## Part 1 — the three rules (docs, no code)

1. `.pi/skills/worktree/SKILL.md` gains **"Conductor decision rules"**:
   - **No unprompted releases** — the ritual ends at "cycle complete — ready when you say"; never name a version or
     a date. The release decision is the maintainer's.
   - **No deadline ⇒ durable path** — a missing deadline means verify first, act once: background, banked,
     commit-per-step; foreground only for a probe whose answer the next step needs inline; never a short foreground
     timeout on a `high`/`xhigh` run.
   - **"Done" carries its falsifier** — every completion names the check that would prove it wrong, or says
     "unverified".
2. `references/sprint-end-ritual.md`: a cycle close never proposes a version; the record row says "release: the
   maintainer's call".
3. `.pi/skills/pr/SKILL.md`: the PR body carries a `Verification:` line (command + observed result); the review
   cites it.
4. `references/review-dispatch.md`: the reviewer writes `REVIEW_<issue>.md` (gitignored) **before** its final
   message; the conductor transcribes/verifies the verdict. (Both silent-completion incidents of 2026-10-31.)
5. `CONTRIBUTING.md`: **AGENT.md is shipped product behavior; our build/release discipline lives in `.pi/skills/**`
   and `.development/`.**

## Part 2 — the dispatch pre-flight (absorbs #407)

Design:

- **New `src/dispatch-line.ts`**: the canonical line (`jev: <level> (<0.xx>) · C<1|2|3> · worktree <y|n>`) as a
  parser + a `checkDispatchLine(task): {ok, line?}` — one place, unit-tested.
- **Opt-in for this repository only**, so users are unaffected. Recommended: a tracked marker file **`.pi/jev-required`**
  (exists → enforce; absent → no check). Alternatives for the critic: a gitignored marker under `.pi/brl-subagent/`,
  or a `package.json` field. Verify which `.pi` paths are tracked vs ignored.
- **Check site**: every `delegate_task` path, after template rendering and **before any spawn** — the single
  handler (near `index.ts:2891`), the batch prelude (`prelude.ts:194`), and any path that writes a run record.
  Rejection names the exact form and `jev-check --line '<json>'`.
- **Bypass**: `noJev?: string` (a **non-empty reason**, not a boolean) on the schema; logged; a bare `true` is
  rejected. Same spirit as `force`, separate field (different meaning).
- **Templates**: the local `plan-critique` (and any other local template we dispatch) gains a `${jev}` slot; the
  conductor passes `params.jev`. Builtin templates must **never** gain the slot (users' renders would break). The
  local-template edit is post-merge, gitignored.
- **Tests** (each fails before / passes after): marker present + no line → refused, zero spawns, message names the
  form; valid line → unaffected; `noJev: "reason"` → allowed + logged, `noJev: true` → refused; marker absent →
  no rejection (user path); the template-render path covered; the three 2026-10-31 task shapes as fixtures.

## Non-goals

- No change to `jev-check --log`, the classifier, or the ledger format (#407 non-goals stand).
- No resumable timeouts (separate follow-up).
- No `AGENT.md` edits.

## Stages

1. Worktree `../brl-subagent-412-…` on `feat/412-…` (`worktree-prep.sh`).
2. Red tests → code → docs → `npm run typecheck && npx vitest run` + `node scripts/docs-arch.mjs && node scripts/docs-decisions.mjs`.
3. C1 adversarial review; merge gate.
4. Post-merge local config: add `${jev}` to `.pi/brl-subagent/templates/plan-critique.md` + create `.pi/jev-required`
   (if that is the chosen marker) — a local step, recorded in STATE.

## Open questions the critic should settle

- Marker mechanism (tracked `.pi/jev-required` vs gitignored local marker vs `package.json` field) — which actually
  works with the repo's tracked/ignored split?
- Is the batch prelude (`prelude.ts:194`) really on every mode's path, or only chain/parallel/graph? Where is the
  single foreground path's pre-spawn seam?
- Does foreground need the check at all (are the three 2026-10-31 misses in the audited log as background spawns)?
- Is `noJev: string` the right shape, or does `force` already carry a reason field we should reuse?

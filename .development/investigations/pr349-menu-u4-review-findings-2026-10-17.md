# REVIEW — PR #349 (issue #345, U4 tier classifier) @ `437fa12`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — focused C2 review (2026-10-17).
Checkout: `review/menu-u4` at the PR head. Spec: `.development/investigations/menu-polish-u4-spec-2026-10-17.md`.

**Verdict: approve-with-nits**

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| minor | `src/__tests__/menu-tier.test.ts` (shipped-builtin case) | Membership fallback unpinned: dropping `builtinNames.includes` leaves 8/8 green; the branch is inert in both finders (preset maps builtin→project=fallback; template fallback IS builtin) |
| minor | `src/__tests__/menu-tier.test.ts` (priority) | Project-wins order unpinned: no same-name-in-both-tiers test; swapping `tierDirs` leaves 8/8 green |
| nit | task brief (not code) | The brief says `tierDirs` is exported — it is module-private; only `classifyTier`/finders/types are exported (smaller surface, fine) |

## Verified-OK

- **A1 pin genuine:** real `writeTemplateFile` round-trip in hermetic temp dirs; the old-transform revert fails **6/8**
  (`expected 'builtin' to be 'project'/'global'`) — the old code breaks every space/case name, not just `My Checklist`.
- **Normalization equivalence:** `tui.ts` imports `sanitizeFileName` from `./presets` — the same binding
  `templates.ts` uses; no fork.
- Behavior preserved on all five paths; only the intended A1 delta.
- The residual is a decision (explicitly asserted; membership fires only on canonical-miss AND builtin name).
- `io` split honest (`classifyTier` pure; `fs.existsSync` bound at the finder edge); dir order mirrors the loader
  first-wins scan; no cycles (architecture rules pass).
- Edges: `a/b`→`a-b` collision shared with the writers by construction; empty name no-throw; HOME-unset identical to
  the pre-U4 expression.
- `tsc` clean; `git diff --check` clean; tree left byte-clean.

SOLID/DRY violations flagged: 0

**Coverage:** targeted 8/8 · probe-A 6 fail/2 pass · probe-B 8/8 (gap F1) · probe-C 8/8 (gap F2) ·
full `npx vitest run` 76 files / 1583 tests. Findings banked to `/tmp/review-349-findings.md`.

## Disposition (2026-10-17)

- **F1 (inert membership branch): ACCEPTED → removed** in `437fa12` — `classifyTier` is now `dirs → io.fallback`
  (the `builtinNames` parameter and its three call-site arguments dropped); the docstring describes the real fallback
  mechanism; no behavior change (verified: finders' outputs are identical before/after).
- **F2 (unpinned priority): ACCEPTED → pinned** in `437fa12` — a same-name-in-both-tiers case now asserts `project`
  wins for both dir lists; suite 76 files / **1584** tests.
- **Brief nit: no action** — the private `tierDirs` is the smaller, correct surface.
- Merged `6811413` (CI pass). The stale `TierClassifierIo.fallback` comment ("…and the name is not a builtin") is
  parked for **U7** (one-line doc pass).

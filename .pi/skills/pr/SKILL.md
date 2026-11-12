---
name: pr
description: "Use when writing a PR body (implementation, fix, or docs PRs targeting dev)."
metadata:
  credits:
    adapted-from: "mattpocock/skills — engineering/pr (MIT © 2026 Matt Pocock)"
    original: "humanlayer/skills — show-me (Dex Horthy)"
---

# Writing a PR body

This skill covers the **body only**. Process (branch per unit, target `dev`, merge
commit — never squash) lives in the worktree skill's lifecycle. Release PRs
(`dev` → `main`) follow `references/release-ritual.md` instead.

The body serves two readers: the **reviewer** (what to aim at) and the **release
notes** (what shipped). Keep prose brief; use the project's domain language
(`.development/GLOSSARY.md`).

## Size threshold — do not over-template

| PR | Shape |
|---|---|
| Behavioral / cross-module / C1–C2 | All four sections below |
| Docs, comments, nits, single-line fixes | One-line summary + the `Fixes` block; keep Evidence only if anything ran; still state the door |

## 1. Summary — the smallest view that makes the point

One short paragraph. Then **at most one** visual, only if it clarifies: a diff-sketch
(file tree), a call tree, or a small pseudocode block.

```diff
 src/
 ├── runner.ts           # the death check that changed
+└── kill-escalation.ts  # the extracted escalation helper
```

## 2. Evidence — what proves it works

Paste the REAL command and its observed result (Rule 21 — claims cite evidence);
show **before → after** where a before exists. Execution output is the S-tier here;
screenshots only for TUI-visible change. Never just "tests pass".

### The numbers are generated, not typed (#488)

Every count in the body — changed files, `src/` diff lines, suite files/tests, the two
budgets — lives in **one block**, and the block is emitted from the tree:

```bash
node scripts/pr-evidence.mjs --emit --base dev      # paste the output into Evidence
node scripts/pr-evidence.mjs --apply --pr <n>       # or let it rewrite the block in the PR body
node scripts/pr-evidence.mjs --check --pr <n>       # before requesting review
```

`--check` recomputes every key from the repo and names each mismatch
(`stale-head`, `stale-changed-files`, `stale-src-diff`, `stale-suite`, `stale-budget`).
Exit 0 clean · 1 drift · 2 usage, or a body that states a count with no block. A docs PR
with no counts and no block passes — there is nothing to attribute.

The `suite:` key is measured from a report resolved by `scripts/lib/suite-report.mjs` (#513):
`<root>/reports/<head>.json` under the private root of #512, captured with
`node scripts/suite-report.mjs --capture`, or pinned with `--report <path>`. `--check --pr <n>`
passes the PR's head as the expected provenance, so a report captured at another commit is exit 2
(`provenance-mismatch`), and a report whose count has no assertion results behind it is exit 2
(`hollow-report`) — neither can become a passing `suite:` line.

**A hand-typed count is a process gap, not a style nit.** Outside the block, a line that
states a count (`N files`, `N tests`, `N lines`) drifts as `unattributed-count`; quote an
old value inside a fenced block or a blockquote instead. The `← <command>` half of each
block line is documentation for the human reviewer — the checker never executes it (§ 488
non-goal: executing text from a PR body is a code-execution hole).

**Every behavioral PR carries one explicit line in this shape:**

```
Verification: <command> → <observed result>
```

One per claim that matters (typecheck, the suite, the doc guards), e.g.
`Verification: node scripts/pr-evidence.mjs --check --pr <n> → exit 0`, or
`Verification: npx tsc --noEmit → 0 errors`. The arrow separates the command from the
result it actually printed, so a reader can tell a run from a recollection. Suite counts
stay in the evidence block — never restated in this line. If something could not be run,
the line says
`Verification: <check> → not run (<why>)` — silence is not evidence, and "unverified" is
an honest state while an unmarked claim is not. A review record cites these lines
(Conductor decision rule 3).

## 3. Merge Danger

- **Door:** one-way or two-way? If a merge cannot be walked back cheaply, name the
  rollback.
- **Blast radius:** what can it affect — one file, one path, all runs, the public
  surface, an unmerged sibling unit?
- **Ramifications:** the one thing a future reader must know (ordering/invariant, or
  why a tempting alternative was rejected).

## 4. Issue linkage — mandatory

One `Fixes #N` **per line**; a comma list does NOT fan out, and the keyword fires on
the default-branch merge only — a `dev` merge defers the close to the next release.

Fixes #NNN

## Issue auto-close does not fire on `dev`-targeted PRs

GitHub only auto-closes issues when the merging PR targets the **default branch** (`main`). These PRs target
`dev`, so `Fixes #N` / `Closes #N` is documentation only — **close the issue manually after merge** (with a
comment naming the merge commit).

## A PR is not complete until CI is green

Check `gh pr checks <n>` before reporting the PR ready (and again after every push). The README
**test-count guard** (`scripts/check-readme-test-count.mjs`) runs in two modes since #469: on a task
PR it enforces **truth only** — the `"<N>+ test suite"` claim must never overstate the run, so
adding tests can never turn it red. The **freshness** half (trailing by more than 100) is enforced at
the release seam only, because it is a property of the merged tree, and the release ritual bumps it
mechanically with `--bump`.

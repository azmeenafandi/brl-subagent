# Contributing to brl-subagent

brl-subagent is a [pi](https://github.com/earendil-works/pi) extension. Issues and pull requests are welcome.

## Getting set up

1. **Clone and check out `dev`** — the integration branch (see the branch model below).
2. **Install once** in your checkout: `npm ci`.
3. **Run pi from the checkout** — pi loads the project's `.pi/skills/` and `.pi/extensions/` from the current
   directory, so the worktree tooling and the guard extension come to life with no extra setup.

## Branch model

- `main` — release branch. It only receives `dev → main` release merges.
- `dev` — integration branch. **All pull requests target `dev`.**
- Every task is developed in its own **git worktree** cut from `dev` — nothing is committed to `dev` directly.

## The workflow

The authoritative process is [`.pi/skills/worktree/SKILL.md`](.pi/skills/worktree/SKILL.md); skim it before your
first PR. The short form:

```bash
# 1. pre-flight the checkout
bash .pi/skills/worktree/check-repo.sh

# 2. create a worktree from dev
git worktree add ../brl-subagent-<branch> -b fix/<issue>-<slug> dev

# 3. provision it (symlinks node_modules when lockfiles match, smoke-tests vitest)
bash .pi/skills/worktree/worktree-prep.sh ../brl-subagent-<branch>

# 4. work there, then run the gates
cd ../brl-subagent-<branch>
npm run typecheck && npx vitest run

# 5. commit, push, open the PR against dev (use "Fixes #N" in the body)

# 6. after the PR is merged, clean up
bash .pi/skills/worktree/worktree-cleanup.sh ../brl-subagent-<branch> --branch fix/<issue>-<slug>
```

A guard extension (`.pi/extensions/worktree-guard/`) enforces the important half of this locally: it blocks
edits to `src/` and `presets/` outside a worktree, and blocks `npm install` through a symlinked
`node_modules` (which would clobber the shared dependency tree).

## Tests

- `npx vitest run` — the full suite; it must stay green.
- `npm run typecheck` — strict `tsc --noEmit`.

Behaviour changes need a test that fails before and passes after. If a bug was reported, pin the reported case.

Structure is enforced too: [`architecture-rules.test.ts`](src/__tests__/architecture-rules.test.ts) audits the
import graph (cycles, layering, runtime-dependency allowlist) and `architecture-doc.test.ts` guards the
generated module map — a change that breaks either fails CI with the rule named.

## Documentation

Design docs, investigations, and the roadmap live in [`.development/`](.development/) — start with
`ARCHITECTURE.md`, `ROADMAP.md`, and `TASKS.md`. The dev workflow's own record (friction log, metrics,
handoff) is there too. `ARCHITECTURE.md`'s module map is generated from each `src/*.ts` purpose header: give
new modules a `// Purpose:` first line and run `npm run docs:arch` (CI fails otherwise).

## The knowledge graph (optional)

Maintainers keep a code knowledge graph in `graphify-out/` — not tracked, because it is generated. If you have
the `graphify` tool, `.pi/skills/worktree/graph-refresh.sh` builds it locally. Nothing else depends on it.

## Reporting issues

Small, precise reproductions are gold: expected vs. actual behaviour, the `delegate_task` parameters if
relevant, and the run's status. `Fixes #N` in a PR body closes the issue when the change reaches a release.

# Brief — the worktree-guard's durability classifier (#617)

Slug: `worktree-guard-durability` · grilled 2026-11-28, one question at a time, eleven decisions.
Issue: #617 (`tooling: worktree-guard blocks every src/ write from a session whose cwd is a linked worktree`).

## Want

> "I think we should fix issue #617 first since it's a real pain. Do a recon first to get feasible fix
> shapes and then grill me for real maintainer decisions."
> — the maintainer, 2026-11-28, stating the want.

#617: the guard derives `REPO_ROOT` from `process.cwd()`. A delegated implementation runs with `cwd` = its
linked worktree, where every `src/` path then reads as "inside the repo", so the worktree exemption can never
fire and every `write`/`edit` on `src/` or `presets/` is refused — the mechanism that enforces rule #5 blocks
the sanctioned place to obey it. The same classifier also lets a worktree session write the **cockpit's** `src/`
by absolute path (a pre-existing hole the fix must close).

## Facts

Convention: `recon-617` = the `probe-617-recon` dispatch (2026-11-28, `openrouter/openai/gpt-6.1-terra`,
report inline in its completion message); `conductor-617` = measured by the conductor with the same harness
(`jiti` + a captured `tool_call` handler).

| # | Fact | Source |
|---|---|---|
| F1 | The main checkout `brl-subagent` has `.git` as a **directory**, HEAD `ref: refs/heads/main`. The dev cockpit and every scratch worktree have `.git` as a `gitdir:` **file** plus `commondir: ../..`. | recon-617 §Observed metadata |
| F2 | A `.git` file does **not** prove linked-worktree status: `git init --separate-git-dir` produces one with no `commondir`. | recon-617 §Other layouts |
| F3 | Detached HEAD is a bare sha (`--abbrev-ref HEAD` → `HEAD`); `git worktree add --relative-paths` writes a **relative** `gitdir:`. | recon-617 §Observed metadata |
| F4 | A branch-only identity rule (main worktree or HEAD ∈ `{main,dev}`) loses the cockpit once it is switched to another branch or detached (reproduced: `switch --detach`, `switch -c cockpit-other`). | recon-617 §Candidate failure matrix (R1) |
| F5 | A **leaf symlink** from a worktree into a durable tree writes the durable file; canonicalizing only the parent directory does not see it. | recon-617 §Symlink boundary |
| F6 | A nested repo classifies differently from its parent, so a cache keyed by tree root is wrong; HEAD changes and moves add more staleness. | recon-617 §Root-only caching |
| F7 | With `cwd` = a linked worktree, both a relative `src/…` and an absolute `<worktree>/src/…` are refused, while an absolute **cockpit** `src/…` is allowed. | conductor-617 (jiti harness, `brl-subagent-wt-615`) |
| F8 | Project-local `.pi/extensions` load only after project trust; saved decisions match "the current directory or one of its parents", and print/headless mode **skips** protected resources when no decision applies. `~/.pi/agent/trust.json` trusts the **workspace parent** (mtime 2026-10-18). | pi `docs/security.md` §Understand project trust; `trust.json` |
| F9 | Consequence of F8: the guard did not load in worktree sessions before 2026-10-18; it has loaded since. The bug is latent from #247 (2026-09-30, `.pi/extensions` tracked) and **live** from 2026-10-18. | F8 + `git log 0d660bb` |
| F10 | `.pi/extensions/worktree-guard/guard.test.cjs` holds 13 install-heuristic checks and is wired to nothing: no npm script, no workflow line, and `vitest.config.ts` includes only `src/__tests__`, `scripts/__tests__`, `.pi/skills/worktree/__tests__`. | recon-617 §Wiring |
| F11 | `extractTargets` collects paths only for `write`/`edit`; `bash` is checked for install commands only. | recon-617 §Wiring; the file |
| F12 | #509 (closed) binds scratch artifacts to a private, durable, non-tmpfs root with `O_NOFOLLOW` and a root boundary, enforced by `scripts/scratch-root.mjs` (#512/#513) — not to `/tmp`. | issue #509 |

## Settled decisions

| Decision | Answer | Why |
|---|---|---|
| Durable identity | **S5 union**: the target's tree is durable iff (a) it is the main worktree (`.git` is a directory), **or** (b) its HEAD names branch `main` or `dev`, **or** (c) its basename is in a small constant list | Each clause covers another's hole: (a) survives a renamed main checkout, (b) covers a contributor's cockpit on `dev`, (c) survives the cockpit being detached or switched (F4) |
| The name list | A **constant in the guard**: `DURABLE_CHECKOUT_NAMES = ["brl-subagent", "brl-subagent-dev"]`, matched on basename | The one environment fact S5 needs, reviewed with the predicate that reads it; a config file's failure mode (unreadable ⇒ fail-closed ⇒ blind) is worse (Q9) |
| Detached / switched durable | **Still durable** | Falls out of the name clause; the opposite is the R1 hole (F4) |
| Unresolvable metadata | **Protected**, with a distinct message: `could not classify <path>: <reason>` | Same protective outcome as today, but "the guard is blind" stays distinguishable from "you broke a rule" (Q2) |
| No repository above the path | **Not protected** | Rule #5 governs this repository's changes; the scratch root's own safety is `scratch-root.mjs`'s job (#509, F12), never a second copy (Q3) |
| Nested repository | **Any durable ancestor protects**; a nested repo inside a worktree is allowed | Keeps vendored fixtures usable and refuses a `.git` planted inside the cockpit (Q5) |
| Symlinks | **Classify the real path**: `realpath` the deepest existing ancestor, re-apply the remaining segments, then classify | The decision must follow the bytes that get written (F5); one predicate, not two that must agree (Q8) |
| Protected surface | **Unchanged**: `src/` + `presets/`, same whitelist | This is a classifier fix; widening is a policy change with its own evidence (Q7) |
| `bash` blind spot | **Unchanged and documented** | The guard is a tripwire for the habitual path, not a sandbox; a shell parser is a new false-positive surface, and the escape existed because a *false* refusal (F11) (Q11) |
| Test wiring | **Port `guard.test.cjs` into a vitest matrix and delete it** — `.pi/skills/worktree/__tests__/worktree-guard.test.ts` | One runner, CI-covered, counted by the budget; the unwired manual file is what let the classifier go untested (F10) (Q10) |
| Scope | **One PR**, **C1**: classifier + realpath + fail-closed message + the vitest matrix; the absolute-path hole closes as a side effect | A write-gating predicate must land with the test that proves it (F7) (Q6) |
| Foreign repositories | **Scoped to the session's repository's common gitdir** (Q12 A, post-grill 2026-11-28); a foreign repo is durable only via a durable ancestor | Unscoped, clauses (a)–(c) are also true of things that are not ours: a temp `git init` inside a scratch worktree is a main worktree, and an unrelated repository whose default branch is `main` answers the branch clause — the same false-positive class this PR removes. The durable ancestor must belong to the session's repository; a session whose own repository cannot be resolved fails closed (Q2) |

## Contract (what the implementation must satisfy)

- Protected iff the target, resolved to its real path and relative to `cwd` when relative, has **any durable
  ancestor tree of the session's repository** (common gitdir), the whitelist (evaluated on the durable tree's
  repo-relative path) does not cover it, and it lies under `src/` or `presets/`.
- Resolution per tree: walk up for `.git`; a directory ⇒ main worktree; a file ⇒ parse `gitdir:` (resolve it
  relative to the containing tree), then read `<gitdir>/HEAD` (`ref: refs/heads/<branch>` or a sha) — no
  subprocess. Any read failure on a relevant link is "unresolvable" ⇒ protected (Q2).
- No cache. The path is classified on every call.
- `before_agent_start` keeps its reminder, with the advice corrected to the durable/worktree vocabulary.
- Non-goals: widening the surface; inspecting `bash`; the #616 stop/label defects; any shipped-`src/` change
  (so no release checkpoint).

## Falsifiers (each must fail on the pre-fix guard and pass on the fix)

1. Worktree cwd, relative `src/…` → **allowed** (today: refused — F7).
2. Worktree cwd, absolute `<worktree>/src/…` → **allowed**.
3. Worktree cwd, absolute `<cockpit>/src/…` → **refused** (today: allowed — F7's hole).
4. Worktree cwd, `../brl-subagent-dev/src/…` → **refused**.
5. Cockpit cwd, relative and absolute own `src/` → **refused**; cockpit `.pi/` and `.development/` → **allowed**.
6. Detached cockpit, and a cockpit switched to `feature/x` → **refused** (the name clause; F4).
7. Main worktree on any branch → **refused** (the structural clause).
8. A worktree leaf symlinked to `<cockpit>/src/x` → **refused**; a cockpit-internal whitelisted symlink →
   **allowed**; a dangling leaf → classified at its lexical destination (F5).
9. A nested repo inside a worktree → **allowed**; a nested repo inside the cockpit → **refused** (Q5).
10. A path with no `.git` above it (including the private scratch root) → **allowed** (Q3, #509).
11. Unreadable/unparseable `.git`, or a `gitdir:` naming nothing → **refused** with `could not classify …`
    (Q2), not the generic worktree advice.
12. `src/` inside a durable tree whose repo-relative path is whitelisted (`.pi/…`) → **allowed** (Q7).

## Mutation receipts required at the PR

Drop the name clause → F6; drop the branch clause → F6 (contributor cockpit); drop the structural clause → F7;
drop `realpath` → F8; nearest-tree-only → F9; fail-open on unreadable metadata → F11; keep the old sibling
pattern → F1/F2.

confirmed: 2026-11-28 by Azmeen

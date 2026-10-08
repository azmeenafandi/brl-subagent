# Worktree Framework Design (settled 2026-08-02, IMPLEMENTED 2026-08-03)

> **Update 2026-09-30 (cockpit move + #247):** the cockpit is the `brl-subagent-dev` checkout (branch `dev`) —
> it owns `.development/`, `graphify-out/`, the `.pi` tools and the SHARED `node_modules` (worktrees symlink
> to it); `main` is the pristine release checkout. Since #247, `.development/**` and `.pi/skills/**` +
> `.pi/extensions/**` are TRACKED (contributor parity); `graphify-out/` and `.pi` session state stay
> gitignored. The canonical graph describes the COCKPIT tree and is refreshed at every merge into `dev` by
> `graph-refresh.sh` (never by a hook side effect — #230). **CodeGraph prototype (Phase 1, 2026-10-08):** a
> parallel `codegraph-refresh.sh` + `codegraph-check.py` pair lives in `.pi/skills/worktree/` for the
> Phase 2 dogfooding — the canonical graph above remains graphify's until the switch decision. **In the text below, read "main repo" / "main
> checkout" as the cockpit (dev) checkout** — the design predates the move; see `HANDOFF.md` for the current
> layout.

> Design discussion recap — worktree workflow standardization. All decisions below are agreed.
> Status: **IMPLEMENTED** — all three scripts (check-repo.sh, worktree-prep.sh, worktree-cleanup.sh) + SKILL.md shipped in `.pi/skills/worktree/`; a real worktree lifecycle test (create → prep → delegate → cleanup) passed 2026-08-03.

## Problem

Repeated friction in the worktree dev flow:
1. Worktrees lack `node_modules` → agents (incl. the conductor) reached for `npm install`, which can drift the shared dependency tree (observed once: main repo missing SDK packages).
2. A `node_modules` symlink was accidentally committed (`node_modules/` gitignore pattern with trailing slash only matches directories, not symlinks — mode 120000).
3. `sync-extension.sh` is gitignored → worktrees never get it. *(Retired 2026-09-11 — see the post-2.3.5 section at the end.)*
4. Pre/post worktree flow (create → prep → merge → sync main → remove worktree → sync extension) was done manually ~12× in one sprint.
5. Human observations of friction kept getting flushed by the dopamine of deliverables (completion bias) — no capture mechanism.

## Principles

- **The framework makes the right thing the easy thing, and the wrong thing loud.**
- Scripts = deterministic enforcement. Skill = institutional memory (when/why). Docs = the written team agreement.
- Main repo `node_modules` is the **source of truth — pristine**. Detect violations; never silently patch.
- Dependency management is **repo-level only**. `worktree-prep.sh` is the only sanctioned provisioning path. Never `npm install` mid-delegation.
- Repo stays a clean deliverable: `git clone` → working extension, no dev-tooling residue.

## Decisions

### 1. `.gitignore` fix
`node_modules/` → `node_modules` (no trailing slash) so symlinks are also ignored.

### 2. Two focused scripts (not one lifecycle script)
- **`worktree-prep.sh`** — pre-worktree provisioning
- **`worktree-cleanup.sh`** — post-worktree teardown

Each does one job well; cleanup is safe to run even if prep never ran.

### 3. Standalone pre-flight check
`check-repo.sh` — "is the repo healthy?" (main node_modules pristine? lockfile consistent? SDK packages present?). Lives on its own AND is invoked by prep (same function, two call sites). Fails loudly on anomalies — stops, reports, never patches. Its SDK version-skew check is a shared helper (`lib/version-skew.sh`) also used by cleanup's post-merge staleness WARN (one function, two call sites).

### 4. Shared (symlinked) node_modules — with detection-based safety
- Lockfiles match (worktree `package-lock.json` == main repo's) → **symlink** to main repo's node_modules (instant, zero duplication)
- Lockfiles differ (deps modified) → **isolated `npm ci`** in the worktree (shared tree never mutated)
- Main repo node_modules missing/broken → **do not symlink**, isolated install + loud warning
- `--force-isolated` flag → **always isolated**, regardless of lockfile state (dependency-bump worktrees; see decision #5)
- Script prints which mode was chosen and why (self-documenting output = audit trail)

### 5. Dependency-bump scenario (why detection is NOT enough — the flag)
Deliberate dep changes are rare and conductor-directed (e.g. SDK-version bump — exactly what the contract tests exist to guard). The accidental variant is a bare `npm install` with caret ranges. Detection handles the *accidental* variant (lockfile-diff → isolated mode automatically). But it is **structurally blind to the planned bump**: a fresh worktree is created FROM main, so lockfiles ALWAYS match at prep time — the divergence happens during the task, after provisioning. The intent lives only with the conductor at prep time, so it must be declared: **`worktree-prep.sh --force-isolated`** for any task that will touch `package.json`/`package-lock.json`. Lived 3× before the flag (08-08 #69 planning, 08-15 nanoid #102, 08-15 SDK #103 — each needed a manual symlink swap). Post-merge, cleanup warns when main's node_modules is stale vs the merged lockfile (run `npm ci` in main).

### 6. Skill: project-scoped at `.pi/skills/worktree/`
- pi supports project-scoped skills at `.pi/skills/` (loaded from cwd upward); `.pi/` is gitignored → skill loads only in this project AND never pollutes the repo.
- The skill is the **playbook**: when to invoke the scripts, the invariants, the team agreement ("deps are repo-level; prep is the only sanctioned provisioning path"), what anomalies look like, and how to respond (report, don't fix).
- The skill **drives the scripts, never duplicates them** — no step-by-step command listings that can drift.
- Scripts live alongside the skill (`.pi/skills/worktree/worktree-prep.sh` etc.) — one self-contained directory, referenced by the skill.

### 7. Who needs what (process architecture)
| Role | Runs in | Needs |
|------|---------|-------|
| Conductor | Main checkout | Skill + scripts |
| Prep script | Main checkout, before subagent starts | Provisions worktree (node_modules, context files, smoke test) |
| Subagent | Worktree | Nothing — inherits a provisioned worktree |

**Worktree ownership:** the CONDUCTOR creates, preps, and cleans up the worktree — never the subagent. The delegation task always specifies `cwd: <worktree-path>`; the subagent consumes the provisioned worktree. Rationale: the worktree is a lifecycle resource spanning create → prep → task → review → merge → cleanup; pre-flight (check-repo.sh) must run in the main checkout before anything exists; cleanup happens after the subagent is gone; and centralizing creation in the conductor (guided by the skill) removes the drift risk of ad-hoc git surgery. A subagent hitting a missing dep or broken artifact mid-task REPORTS it and stops — never creates, reinstalls, or touches the main checkout (guardrail text in the skill).

### 7b. The lifecycle (final, settled 2026-08-02)

```
0. PRE-FLIGHT (check-repo.sh, main checkout):
   - main node_modules pristine (SDK packages present, lockfile consistent)
   - working tree clean, main up to date with origin
   - STOP and report if any check fails — never create on a broken source of truth
1. CREATE: branch from updated main + `git worktree add <path> <branch>`
2. PREP (worktree-prep.sh, run from MAIN checkout, not the worktree):
   - runs the pre-flight itself (check-repo.sh) — never provisions from a broken source
   - node_modules: symlink to main repo's IF lockfiles match, else isolated `npm ci`
   - `--force-isolated` for dependency-bump tasks (lockfile diverges by design)
   - ~~provision sync-extension.sh~~ — the script was RETIRED 2026-09-11 (see the post-2.3.5 section); the step is a no-op and the script skips it gracefully
   - OPTIONALLY symlink .development/ for reviewer context
   - smoke test: vitest runs in the worktree before any subagent starts
3. DELEGATE: task with cwd = worktree; subagent commits, pushes branch, opens PR
4. ADVERSARIAL REVIEW (optional): reviewer writes REVIEW_*.md in worktree
   (gitignored — never pollutes the PR); subagent implements revisions
5. USER REVIEW loop: review → possible revisions → approve
6. MERGE: squash merge to main
7. CLEANUP (worktree-cleanup.sh) — UNCONDITIONAL (runs even if PR was
   closed without merging):
   - `git worktree remove --force <path>`
   - `git branch -d <branch>`
   - sync main checkout (fetch + pull)
   - ~~run sync-extension.sh~~ — RETIRED 2026-09-11; the installed extension now updates via the npm package (`pi update --extensions`)
```

### 8. FRICTION_LOG.md at `.development/`
Human parking-lot: one line per friction, captured **before** the deliverable lands (tripwire against completion-bias flush). Reviewed at sprint end. `.development/` is for the human + conductor (gitignored, local).

### 9. Machine-local trade-off (accepted)
`.pi/` is gitignored → framework doesn't travel with clones. Accepted: project is single-dev; ease-of-use for users matters more than co-development tooling portability.

## Build order (next sprint) — ✅ COMPLETE (2026-08-03)

1. ✅ `.gitignore` fix + `check-repo.sh` (pre-flight) — node_modules pattern now matches symlinks; check-repo.sh ships
2. ✅ `worktree-prep.sh` (symlink/install decision, context provisioning, smoke test)
3. ✅ `worktree-cleanup.sh` (teardown + sync)
4. ✅ SKILL.md (playbook + team agreement + friction-log ritual) — includes rule #5 (ALL code changes go through a branch+worktree, even small fixes — applies to the conductor), added after the 919a2e9 direct-to-main incident
5. ✅ FRICTION_LOG.md (seeded with 2026-08-01 observations + direct-to-main entry)

## Next step (planned): enforcement extension

Rule #5 is currently convention-based — the skill reminds, nothing enforces. Planned idea: a project-scoped extension at `.pi/extensions/worktree-guard` that makes the rule mechanical:

- **`tool_call` block** — intercepts writes to `src/` or `presets/` from a working directory that is NOT a worktree (i.e. the main checkout) and rejects them with a pointer to the worktree skill
- **`before_agent_start` reminder** — injected prompt line re-stating the rule for both conductor and subagents
- **Whitelist** — `.development/`, `README.md`, `package.json` (and other root-level non-code files) remain writable from the main checkout, so docs/release chores don't force a worktree

Design intent: the wrong thing (direct-to-main code changes) becomes *loud* — the framework's core principle, extended from scripts to the extension layer. Not yet built; revisit when the extension API surface for `tool_call` blocks is confirmed.

## Open (deferred, not blocking)

- Scripts' GitHub-side duties (merge via `gh`, tag, release notes) — boundary TBD when building cleanup script
- Whether deliberate dep bumps ever happen in worktrees (currently: no — repo-level only)
- Revisit for other projects when the time comes

## Post-2.3.5: sync-extension retirement + the release checkpoint (2026-09-11)

`brl-subagent` became a published pi package in v2.3.5, which changed the dev model and retired a piece of this framework.

- **`sync-extension.sh` RETIRED.** Daily use now runs the *published npm package* (`pi install npm:brl-subagent`), so the running extension is the artifact users actually get — dogfooding fidelity that immediately surfaced the #158 AGENT.md packaging defect, which the sync-copy setup could never see. Development uses a **local-path install** toggle (`pi remove npm:brl-subagent && pi install <repo-or-worktree-path>`), documented in AGENT.md § Local development. The sync script could not coexist with `pi update --extensions`: retargeting the npm store would fight the package manager, and a separate directory would double-load the extension (dedupe is by resolved absolute path).
- **Script behaviour:** `worktree-prep.sh` and `worktree-cleanup.sh` guard their sync-extension steps with `-f`/`-x` checks, so both degrade to a clean no-op. **No script change was required** — the retirement was safe by construction.
- **Checkpoint semantics changed (rule 6).** The post-merge `/reload` checkpoint existed because merged code was synced into the extensions directory. Under npm dogfooding, merged extension code is **not** active until a release: bump → GitHub release → CI stages → maintainer approves on npm → `pi update --extensions`. For changes that touch the running extension, the reload checkpoint is therefore a **release checkpoint**. Changes that never reach the running extension (docs, tests, tooling) still complete at merge.

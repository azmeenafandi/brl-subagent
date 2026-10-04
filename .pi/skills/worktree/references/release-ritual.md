# Release ritual

**Contents:**

1. Inventory version references
2. `.development/` docs
3. Release merge (`dev` → `main`)
4. Bump
5. Docs that ship
6. Commit + tag + push
7. Release note as a GitHub DRAFT
8. Graph — no release-time step
9. Switch the running install back to the published package
9. Sprint-end ritual
10. Friction log

Run this on every release. **Step 1 exists because it was skipped once** — the
v2.3.5 bump shipped three stale version strings (README `Version: 2.3.4`, the
README git-install example `@v2.3.4`, and the AGENT.md header `(v2.3.4+)`)
because nothing checked them and no test pins them.

**Order matters: the version inventory first, docs before the bump.**

1. **Inventory version references** — every place the outgoing version appears:
   ```bash
   grep -rn "<old-version>" package.json package-lock.json README.md AGENT.md \
     CHANGELOG.md .development/ .pi/skills/worktree/ | grep -v node_modules
   ```
   Update every *current-state* hit (README header, doc headers). Leave
   *historical* hits (CHANGELOG entries, `.development/` history, the friction
   log). AGENT.md carries no version stamp by design (#166), so nothing to
   update there.
2. **`.development/` docs** (TRACKED since #247 — doc updates are direct-to-dev commits):
   - `ROADMAP.md` — header version → new; add a **"Shipped (<date>, vX)"** table
     for this release's items
   - `AUDIT.md` — header version → new; AUDIT gets a
     **"vX Audit Follow-up (<date>)"** section
   - `ARCHITECTURE.md` — **no release-time edit**: it is version-free by design and its
     module map is generated + CI-checked (`npm run docs:arch`, issue #249)
   - `TASKS.md` — a changelog row: items, issues closed, process changes, test
     count, board state, friction
   - `METRICS.md` — the sprint's row (run the metrics script; see the
     sprint-end ritual — `references/sprint-end-ritual.md`)
3. **Release merge (`dev` → `main`)** — merge commit, never squash; a release PR is preferred for the record. Two post-merge checks, both learned the hard way (2026-10-03, v2.4.0):
   - **Auto-close fired?** The PR body must list **one `Fixes #N` per line** — a comma-separated list does NOT close (friction `fixes-keyword-omission`, recurrence: v2.4.0 auto-closed 3 of 13). Verify after the merge and close stragglers with a status comment naming the release commit.
   - **`dev` still exists?** GitHub's *auto-delete head branches* deletes the PR head — and the release PR's head is `dev`. Restore with `git push origin dev` at the release commit if it is gone. After the bump + tag, fast-forward `dev` to the release commit (`git fetch origin main && git merge --ff-only origin/main && git push origin dev`) so both branches sit on the release.
4. **Bump** — `npm version <X> --no-git-tag-version` (updates `package.json`
   **and** `package-lock.json`).
5. **Docs that ship** — `README.md` version header; `CHANGELOG.md` release entry
   (newest-first, project voice). *(The git-install example tag was dropped in
   #171 — npm is the sole user-facing install/update path.)*
6. **Commit + tag + push** — `chore: bump version to <X>`. The commit carries
   only `package.json`, `package-lock.json`, `README.md`, `CHANGELOG.md`
   (`.development/` docs are tracked now — commit them separately, so the bump
   commit stays code + shipping docs only).
7. **Release note as a GitHub DRAFT** —
   `gh release create vX --draft --title "…" --notes-file <file>`, then tell the
   user where to review it. **The user publishes it** — and that publish is what
   triggers `publish.yml`.
8. **Graph — no release-time step** (ADR 0011/0012). The canonical graph describes the **cockpit (`dev`)**
   and is refreshed at every merge into `dev` by `graph-refresh.sh` (lifecycle step 6). A release changes
   `main`, which the graph does not describe — and the graphify post-commit hook will fire on the bump
   commit, writing an incomplete graph wherever the commit ran (observed in `main`, 2026-10-03; #230).

   The refresh discipline below still applies **at merge time**:

   Never trust that a refresh succeeded —

   ```bash
   python3 .pi/skills/worktree/graph-check.py
   ```

   The check verifies module coverage AND exported-symbol coverage against
   `src/*.ts` on disk, prints its coverage boundaries, and exits non-zero on
   any discrepancy. It is mechanical because **this failure is silent**: the
   2026-09-12 refresh produced a graph missing `src/paths.ts` (added the day
   before) and reported success — issue #173, occurrence 2; the 2026-09-20
   `cluster-only` rewrite kept every module and lost the day's symbols — issue
   #189. Refresh ONLY when stale (`built_at_commit` vs HEAD, source mtimes) —
   a 2026-09-22 refresh on an unchanged tree still rewrote the graph
   (821→816 nodes, semantic names→fallbacks) with the guard green.

   **Shrink guard (graphify #479):** if the export *refuses* because the new
   graph has fewer nodes, do NOT force reflexively. The guard cannot distinguish
   a legitimate deletion from data loss, so:
   1. confirm the shrink is real (modules/tests actually deleted, docs trimmed),
   2. **state the reasoning**,
   3. only then re-run with `--force`.

   The 2026-09-12 release legitimately shrank the graph — a module and a test
   were deleted and two shipped docs trimmed, so forcing was correct. That
   reasoning is recorded here **so it is not re-derived or assumed**; record the
   equivalent reasoning each time the guard fires.
9. **Switch the running install back to the published package** — *only after the
   staged publish is approved*, never before.

   If the local development toggle is in use (`pi install <path>`, see the
   local-path toggle — `references/local-development.md`), the running extension
   is a **working-tree checkout**, not the released artifact. Restore the
   shipped path:

   ```bash
   pi remove /abs/path/to/brl-subagent-dev
   pi install npm:brl-subagent
   pi update --extensions
   # then /reload
   ```

   **Timing is load-bearing.** Switching *before* the staging approval reverts the
   running extension to the previous published version — silently dropping every
   fix in this release. Approval first, then switch.

   And never leave both loaded: dedupe is by resolved absolute path, so a
   local-path install plus an npm install register duplicate tools and commands.
   The dev checkout itself can stay on disk for the next cycle — it is the
   *install* that changes, not the directory.

9. **Sprint-end ritual** — Rule 11 recurrence escalation + trust metrics (see `references/sprint-end-ritual.md`).
10. **Friction log** — one line per unexpected or inefficient outcome, logged as
   it happens, not deferred to the end.

**Current release channel (v2.3.5+):** `.github/workflows/publish.yml` — OIDC
trusted publishing, **staged** (a maintainer approves with 2FA at npmjs.com →
package → Staged Packages). Publishing the GitHub release does **not** put the
version live; the approval does. The running extension then updates via
`pi update --extensions` (the release checkpoint, rule #6).

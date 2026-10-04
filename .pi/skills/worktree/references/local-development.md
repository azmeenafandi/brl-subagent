# Local development (npm dogfooding + the dev toggle)

Since v2.3.5 the extension is a **published pi package**. The running extension is
the artifact users actually get — that is the dogfooding posture, and it is what
exposed the #158 AGENT.md packaging defect that the retired sync-copy setup could
never see.

**Daily use** (the published artifact — the same thing users install):

```bash
pi install npm:brl-subagent            # global (or -l for project-local)
pi update --extensions                 # advance to a newer published version
```

**Developing** (load the checkout in place — **no copying, no syncing**):

```bash
pi remove npm:brl-subagent
pi install /abs/path/to/brl-subagent   # or an unmerged worktree: …/brl-subagent-wt-<n>
# /reload pi after edits

# back to the published artifact
pi remove /abs/path/to/brl-subagent
pi install npm:brl-subagent
```

- A **local-path install can point at an unmerged worktree**, so it doubles as
  live verification for a PR — something the retired `sync-extension.sh` could
  never do.
- **Never load two copies.** Dedupe is by resolved absolute path, so an npm
  install plus a local-path install register duplicate tools and commands.
  Remove one before installing the other.
- `pi update --extensions` advances the npm install and leaves a local-path
  install alone.
- **Retired (2026-09-11):** `sync-extension.sh` (rsync into
  `~/.pi/agent/extensions/brl-subagent`). It could not coexist with npm
  dogfooding — retargeting the npm store would fight the package manager, and a
  separate directory would double-load. `worktree-prep.sh` / `worktree-cleanup.sh`
  guard their sync steps and degrade to a no-op.

**Testing a candidate without touching settings** (verified empirically 2026-09-14):

```bash
pi -ne -e /abs/path/to/brl-subagent     # or an unmerged worktree
```

- **`-ne` is REQUIRED.** Pi's loader merges CLI paths with the resolved settings
  packages (`extensionPaths = noExtensions ? cliEnabledExtensions :
  mergePaths(...)`), so `pi -e <dir>` **alone** loads the installed npm copy *and*
  the dev copy → duplicate tools and commands. `--no-extensions` keeps only the
  explicit `-e` paths.
- Verified: with `-ne -e <dir>` the dev directory loads cleanly and registers
  `delegate_task`, `get_subagent_result`, `steer_subagent`, `stop_subagent`;
  zero extension load errors.
- **Trade-off:** `-ne` also suppresses the *other* extensions (pi-intercom,
  context7, …) — a bare session of pi's built-ins plus brl-subagent. That
  isolation is usually what you want when testing this extension; when you need
  your normal session, use the toggle above instead.
- **Nothing to undo** — no settings change, so there is no way to forget to
  revert and unknowingly run dev code.

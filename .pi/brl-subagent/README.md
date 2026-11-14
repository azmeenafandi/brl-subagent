# The project-local dispatch contract

This directory is the **project-local tier** of the dispatch contract: the presets and
templates a conductor in this repository dispatches *by name*. It is tracked (#514)
because the loader gives project-local files precedence over the shipped copies — so an
untracked file here would mean a clean checkout dispatches a different text than the one
this repository reviewed.

## The tracked set

Five presets and five templates, plus this README:

| Kind | Files |
|---|---|
| `presets/` | `project-docs`, `project-implementer`, `project-plan-critic`, `project-proposer`, `project-reviewer` |
| `templates/` | `adversarial-review`, `debug-task`, `design-proposal`, `focused-review`, `plan-critique` |

Extension state (`state.json`, session scratch, …) stays local: the ignore rules in
`.gitignore` re-ignore every child of this directory and re-admit only `*.md`, `presets/`
and `templates/`.

## Precedence

**PROJECT-LOCAL > USER-GLOBAL (`~/.pi/agent/brl-subagent/`) > BUILT-IN** (the shipped
`presets/` and `templates/` in the npm package). The loader scans the project directory
first and skips a duplicate name, so the first occurrence wins; the custom-over-builtin
override happens in `getAllPresets` / `getAllTemplates`, not in the loader
(`src/presets.ts:199-225`, `src/templates.ts:246-270`).

Two consequences:

- **A new contract file must be tracked.** `node scripts/check-contract-tracking.mjs`
  fails on an untracked `*.md` under this directory and on a tracked file missing from
  disk, and CI runs it — the "never silently untracked" rule this directory exists for.
- **A personal variant belongs to the global tier.** Anything under
  `~/.pi/agent/brl-subagent/` is yours and binds nobody else; anything here binds every
  dispatch in this repository.

## Durable artifacts never live in a system temp directory

Banks, findings files and review records outlive the run, so they belong to the private
scratch root (`~/.cache/brl-subagent` on Linux, `~/Library/Caches/brl-subagent` on macOS,
`%LOCALAPPDATA%\brl-subagent` on Windows): the run's progress bank at
`<root>/runs/<id>/bank.md` (a foreground child sees that directory as `$BRL_SCRATCH`) and
the review record at `<root>/review-<n>/REVIEW_<n>.md`. Probe scratch — a throwaway repo
for a Gate A check — may still use `/tmp`.

`node scripts/audit-scratch-instructions.mjs` gates this corpus together with `.pi/skills`:
a durable artifact path in a system temp directory is a hit (exit 1), while a probe-scratch
mention and a line describing the #512 refusal are printed as non-hits.

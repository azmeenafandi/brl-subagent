# Review record — PR #339 (#336 boundary guards)

Focused C2 review (project-reviewer + focused-review) · model `openrouter/meta/muse-spark-1.3-contributor` · 2026-10-16
Review worktree: detached @ `cdf2b1a` · bank: /tmp/review-336-findings.md
Jev (pre-dispatch): `medium (0.83) · C2` — chosen medium.

## Verdict: approve-with-nits

| Severity | File | Finding | Disposition |
|---|---|---|---|
| nit | `check-repo.sh` §1c | bash `[[ > ]]` version compare is lexicographic (0.9.0 reads AHEAD of 0.10.0); informational, prints both — use `sort -V` | **FIXED** in `777ce2d` (version-aware compare; repro before/after) |
| nit | `sprint-metrics.py::load_events` | silently skips malformed JSONL lines, no count | **DECLINED** — a torn final line is an expected tail condition; the skip feeds no stated count; a stderr counter would be noise on routine drops |
| nit | `sprint-end-ritual.md` | the reconciliation log path resolves only where the extension runs (absent in worktrees) | **FIXED** in `777ce2d` (one cockpit clause) |

## Focus-area verdicts (reviewer)

- **Self-test discrimination:** verified — Probe A (pre-fix raw-string shape) → **10/15 fail incl. the named
  regression case, exit 1**; Probe B (dropped day-branch) → 14/15 fail; scratch-only, worktree untouched.
- **No behavior change:** verified — 75 / 69 dispatches as specced; the net diff is pure additions (no `-` lines;
  `in_range` / `load_events` untouched).
- **Audit coverage:** verified — the 11-file enumeration matches the spec corpus; only `sprint-metrics.py` takes a
  time window; the PR-body claim holds.
- **Docs accuracy:** verified — the reconciliation command works as written from the cockpit (74 narrowed spawns vs
  75 dispatches = 1.3%; >20% would have fired at 67.6%); the 22-vs-68 citation is exact (FRICTION_LOG.md:200); the
  #330 shape is exact (state.ts:367-380).
- **CI validity:** verified — the step is valid YAML, consistent with siblings; the selftest exits 0.
- **Reclassification:** no C1 issues found.

## Fix round (`777ce2d`)

`check-repo.sh` now compares via `printf '%s\n%s\n' "$LOCKED_SDK" "$RUNTIME" | sort -V | tail -1`; the cockpit
clause was added to the reconciliation block. Post-fix: selftest **15/15**, suite **73/1506**, `git diff --check`
clean.

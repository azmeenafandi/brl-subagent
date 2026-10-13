# Review record — PR #334 (#333 dependency parity bump to pi 1.2.0)

Focused C2 review (project-reviewer + focused-review) · model `openrouter/meta/muse-spark-1.3-contributor` · 2026-10-12
Review worktree: detached @ `2b31695` · bank: /tmp/review-deps12-findings.md
Jev (pre-dispatch): `medium (0.86) · C2` — chosen medium.

## Verdict: approve — zero findings

- **FA1 declared ranges:** exactly the four `@earendil-works/*` at `^1.2.0` + `typebox` exact `1.3.27`;
  no other `package.json` change — verified.
- **FA2 resolved graph:** seven `1.1.0→1.2.0` transitions (4 direct + codemode/mcp/telemetry); a SINGLE
  deduped `typebox 1.3.27`; the `chord`/esbuild tree removal is legitimate (the host `pi-coding-agent@1.2.0`
  manifest has no chord/esbuild deps); dev tools untouched (vitest 5.0.3, typescript 7.0.2, jiti 2.7.0) — verified.
- **FA3 no source changes:** name-only diff = `package.json` + `package-lock.json` — verified.
- **FA4 evidence consistency:** tsc exit 0; suite **73 files / 1506 tests** — reconciled exactly as
  1500 + 3 (PR #331) + 3 net (PR #332, one rename pair discounted) — verified.
- **FA5 reproducibility:** `npm ls --all` exit 0; `npm ci --dry-run` in a /tmp copy exit 0 (155 packages) — verified.
- **Reclassification:** no C1 issues found.

## Coverage highlights (reviewer)

Lockfile key-diff reconciled (31 removed / 0 added keyed entries vs a python packages-table compare);
version-line query reconciled (27× esbuild removal, 7× 1.2.0 additions, typebox dedupe); merged-diff
`it(` counts reconciled to the 1506 total.

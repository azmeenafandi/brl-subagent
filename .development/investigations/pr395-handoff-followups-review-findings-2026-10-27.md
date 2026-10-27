# REVIEW — PR #395 (#393 + #394, handoff follow-ups) @ `2a0142b` (merge)

Reviewer: `openrouter/openai/gpt-6-luna` — focused C2, Jev **medium (0.8)**. Origin:
`.development/investigations/pr353-handoff-review-findings-2026-10-17.md` §Design observations #1/#2.
Diff `dev...HEAD`: `.pi/extensions/handoff/{lib.ts,index.ts,handoff.test.cjs}`,
`.pi/skills/handoff/references/handoff.md`, `.pi/skills/handoff/SKILL.md`, `tsconfig.json`.

**Final disposition: merged `2a0142b` — after two review rounds and one conductor fix.**

## Round 1 — `3c5473c`: changes-requested

| Severity | File:line | One-liner |
|---|---|---|
| Major | `index.ts:103`; `lib.ts:188-9,245` | `git log --name-only` omits merge-commit paths and reports only the destination of a rename — a foreign range could be judged handoff-only |
| Minor | `lib.ts:197` | Trimming path lines could turn `.development/HANDOFF.md ` (trailing space) into the whitelisted path |

Verified-OK: regular cases (handoff-only, foreign, interleaved, non-ancestor, empty range); the ignore
mutation reddened 5 tests; `tsc` genuinely covering the extension (a real `TS2322` fails where the old
include was blind); suite 90/1798; docs accurate; scope exact.

## Round 2 — `1dd75fe` (fix): changes-requested

| Severity | File:line | One-liner |
|---|---|---|
| Major | `lib.ts:240-242` | `parseDiffPaths` accepted a final path without its NUL terminator — a truncated stream could still produce a handoff-only match |

Verified-OK (real-git scratch probes, 10/10): merge resolution adding a foreign file → RECONCILE;
foreign → `HANDOFF.md` and reverse → RECONCILE with both paths; trailing-space filename → RECONCILE;
handoff-only → annotated match; foreign/interleaved/non-ancestor → RECONCILE; empty range → match;
`--allow-empty` → RECONCILE (fail-closed, judged correct for the hook). Mutations killed their tests.

## Conductor fix — `77338bf`: verified, merged

`parseDiffPaths` now requires the stream's trailing NUL (a truncated stream is `null` → foreign), plus two
regression tests (truncated single record, truncated rename). Mutation: removing the guard fails both new
tests; restored, the extension suite, `tsc`, and the full suite are green.

## Notes

- The `.cjs` extension suite is not wired into CI (pre-existing, same as `guard.test.cjs`) — out of scope,
  flagged as a follow-up candidate.
- The fixed hook takes effect on the next `/reload`; until then the running session still shows the old line.
- Worktree `brl-subagent-wt-tooling-393-394` closed; branch deleted; #393 and #394 closed.

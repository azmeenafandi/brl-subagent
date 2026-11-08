<!--
Regression fixture S6 (issue 487) — a merged unit's record as it reached the gate.
Provenance: PR 486, the reviewer's findings bank written straight out to the record file: no
disposition field at all, no PR number, and the risk class fused with the recheck on one line.
Expected: rejected with `wrong-pr` + `missing-verdict` + `missing-recheck` + `malformed-risk`
when checked with `--pr 486` (as the test at review-record.test.ts:276 does); the shape-only
invocation reports `missing-pr` instead of `wrong-pr`.
-->

REVIEW SCRATCH
head=beef4175cf3427b3096a992e6926321785d17734
FINDING-verify: trace-harness provenance VERIFIED (fixtures pass at base, regen is a no-op at HEAD)
FINDING-verify: complexity VERIFIED (execute 125 lines -> 7; every table entry matches)
FINDING-minor: the PR body says "44 seam tests" but the file runs 63 tests — count drift
FINDING-verify: gates ALL GREEN on the same tree (suite, typecheck, imports, docs, diff-check)
Risk class: C1. jev-recheck: jev: xhigh (0.47) · C1 · worktree y
Reviewed head: beef4175cf3427b3096a992e6926321785d17734

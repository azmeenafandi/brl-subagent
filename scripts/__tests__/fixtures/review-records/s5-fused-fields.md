<!--
Regression fixture S5 (issue 487) — a merged unit's record as it reached the gate.
Provenance: PR 485, the findings-bank shape with the two classifier fields FUSED onto one line:
`Risk class: C2. jev-recheck: jev: medium (0.65) · C2 · worktree y`. The gate sees neither field,
because a line-start `Risk class:` swallows the rest of the line as its value.
Expected: rejected, named reasons `missing-recheck` + `malformed-risk`.
-->

# PR #485 findings (banked as verified)

- [1-move-identity] VERIFIED: the split is accounted for line by line against the base.
- [3-instance-identity] VERIFIED: the new modules import types only, never the factories.
- [8-gates] VERIFIED: suite green, tsc clean, docs guards current, diff-check clean.

Verdict: approve-with-nits
Risk class: C2. jev-recheck: jev: medium (0.65) · C2 · worktree y
Reviewed head: ecdaba410833e9082afd9286e56a4955cd0f2a24

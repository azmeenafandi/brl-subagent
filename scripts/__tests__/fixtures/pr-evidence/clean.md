<!-- The contract fixture: its block IS the stub fact set the other fixtures are mutations of.
     `pr-evidence.test.ts` reads `actual` out of this block, so this file defines what "clean" means. -->
## Summary

Extracts the evidence renderer, so a PR body's numbers are generated rather than transcribed.

## Evidence

<!-- pr-evidence:begin -->
head: 8e7f6a5c4b3a2918171615141312111009080706 ← git rev-parse HEAD
changed-files: 5 ← git diff --name-only dev...8e7f6a5c4b3a2918171615141312111009080706 | wc -l
src-diff-lines: 120 ← git diff --numstat dev...8e7f6a5c4b3a2918171615141312111009080706 -- src | awk '{s+=$1+$2} END {print s+0}'
suite: 133 files / 2745 tests ← npx vitest run --reporter=json --outputFile=vitest-report.json (testResults / numPassedTests)
budget: src 1.99 · scripts 0.61 ← node scripts/check-test-budget.mjs --report vitest-report.json
<!-- pr-evidence:end -->

## Merge Danger

- **Door:** two-way — the renderer is additive.
- **Blast radius:** the `pr` skill and `scripts/`.

Fixes #488

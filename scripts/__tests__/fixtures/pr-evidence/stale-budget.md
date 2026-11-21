<!-- Drift: `src` and `scripts` match the contract, the `skills` ratio does not — the third clause is
     COMPARED, not carried. A check that compared two ratios would pass this body. Expect
     `stale-budget`, exit 1. -->
## Evidence

<!-- pr-evidence:begin -->
head: 8e7f6a5c4b3a2918171615141312111009080706 ← git rev-parse HEAD
changed-files: 5 ← git diff --name-only dev...8e7f6a5c4b3a2918171615141312111009080706 | wc -l
src-diff-lines: 120 ← git diff --numstat dev...8e7f6a5c4b3a2918171615141312111009080706 -- src | awk '{s+=$1+$2} END {print s+0}'
suite: 133 files / 2745 tests ← npx vitest run --reporter=json --outputFile=vitest-report.json (testResults / numPassedTests)
budget: src 1.99 · scripts 0.61 · skills 0.07 ← node scripts/check-test-budget.mjs --report vitest-report.json
<!-- pr-evidence:end -->

<!-- Drift: the block names a commit that is not the head being checked. Expect `stale-head`, exit 1. -->
## Evidence

<!-- pr-evidence:begin -->
head: 4c1d9ab2f1e0c3d4e5f60718293a4b5c6d7e8f90 ← git rev-parse HEAD
changed-files: 5 ← git diff --name-only dev...4c1d9ab2f1e0c3d4e5f60718293a4b5c6d7e8f90 | wc -l
src-diff-lines: 120 ← git diff --numstat dev...4c1d9ab2f1e0c3d4e5f60718293a4b5c6d7e8f90 -- src | awk '{s+=$1+$2} END {print s+0}'
suite: 133 files / 2745 tests ← npx vitest run --reporter=json --outputFile=vitest-report.json (testResults / numPassedTests)
budget: src 1.99 · scripts 0.61 ← node scripts/check-test-budget.mjs --report vitest-report.json
<!-- pr-evidence:end -->

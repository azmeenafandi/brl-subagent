<!-- S6 / #486: the seam-test count in prose was stale (the measured run was 84).
     CAUGHT MECHANICALLY as `unattributed-count` (exit 1): the count is in prose, outside the block.

     Also kept OLD-FORMAT on purpose (#558): its `budget:` line carries the two ratios of its era, so
     a reader sees the required-refusal case — `missing-key` naming the three-ratio shape, then
     `--apply` → `--check` clean. Do not modernise this line; it is the fixture. -->
## Evidence

<!-- pr-evidence:begin -->
head: 8e7f6a5c4b3a2918171615141312111009080706 ← git rev-parse HEAD
changed-files: 5 ← git diff --name-only dev...8e7f6a5c4b3a2918171615141312111009080706 | wc -l
src-diff-lines: 120 ← git diff --numstat dev...8e7f6a5c4b3a2918171615141312111009080706 -- src | awk '{s+=$1+$2} END {print s+0}'
suite: 133 files / 2745 tests ← npx vitest run --reporter=json --outputFile=vitest-report.json (testResults / numPassedTests)
budget: src 1.99 · scripts 0.61 ← node scripts/check-test-budget.mjs --report vitest-report.json
<!-- pr-evidence:end -->

The two new files add 44 seam tests.

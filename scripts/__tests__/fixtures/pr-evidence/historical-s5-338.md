<!-- S5 / #485, verbatim: `index.ts` "landed at 338" when the measured head was 353.
     OUT OF THE MECHANICAL SET: the claim carries no unit noun, so the ban list (number + `files`/
     `tests`/`lines`) cannot see it, and the block has no per-file line-count key. Exit 0 — stated, never
     guessed at. Emitted with a unit noun it WOULD be caught: see the reworded body in the test. -->
## Evidence

<!-- pr-evidence:begin -->
head: 8e7f6a5c4b3a2918171615141312111009080706 ← git rev-parse HEAD
changed-files: 5 ← git diff --name-only dev...8e7f6a5c4b3a2918171615141312111009080706 | wc -l
src-diff-lines: 120 ← git diff --numstat dev...8e7f6a5c4b3a2918171615141312111009080706 -- src | awk '{s+=$1+$2} END {print s+0}'
suite: 133 files / 2745 tests ← npx vitest run --reporter=json --outputFile=vitest-report.json (testResults / numPassedTests)
budget: src 1.99 · scripts 0.61 ← node scripts/check-test-budget.mjs --report vitest-report.json
<!-- pr-evidence:end -->

`src/index.ts` landed at 338 after the extraction.

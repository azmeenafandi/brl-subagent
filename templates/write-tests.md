---
name: write-tests
description: Test generation with edge-case coverage
preset: test-engineer
thinkingLevel: medium
---
Write tests for ${file} covering the happy path and edge cases.

Include the test file path in your report and note any
untestable code paths you skipped. When you mutate the code to prove a test fails on the defect, name the target by unique surrounding context, state the expected failure first, and run that specific test file, not the full suite — a green targeted run means re-check the target.

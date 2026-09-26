---
name: write-tests
description: Test generation with edge-case coverage
preset: test-engineer
thinkingLevel: medium
---
Write tests for ${file} covering the happy path and edge cases.

Include the test file path in your report and note any
untestable code paths you skipped. When designing a mutation to prove a test fails on the defect, name the target by unique surrounding context and state the expected failure first.

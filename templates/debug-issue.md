---
name: debug-issue
description: Reproduce, isolate, and fix a bug
preset: debugger
thinkingLevel: medium
---
Debug ${symptom}. Reproduce it first, then isolate the root cause.

Show the failing input, the root cause, and the minimal fix.
Final report: end with a Coverage line — the exact command or query used, the count or range it printed, and how it reconciles with the corpus you expected; show an empty result's size before treating it as absence. Before running any probe or reproduction, name its target by unique surrounding context and state the expected failure signature; a passing probe is first evidence the target was wrong, not that the behavior is fine.

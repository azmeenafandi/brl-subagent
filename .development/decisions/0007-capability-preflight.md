# 0007. Capability pre-flight with an explicit force override

- **Status:** Accepted
- **Date:** 2026-09-27
- **Issues:** #216, #33

## Context

Dispatches failed deep inside the run when the resolved toolset plainly could not do the task — for example, an exploration task with no search tools. The only pre-existing pre-spawn check was H1's hard error for `outputFile` without `write`.

## Decision

- Classify the task's capability: run/execute/test/compile/benchmark needs `bash`; exploration needs find/ls/grep/bash.
- Reject an unambiguous mismatch before spawning.
- `force: true` downgrades the rejection to a warning; `outputFile`-without-`write` stays a hard error that `force` never suppresses.
- Surface warnings in every mode's result.

## Consequences

- Capability mismatches cost a dispatch-time rejection instead of a wasted run.
- `force` is the recorded escape hatch and its use is visible in the result.
- Auto-route writes an evidence line for the same reason.

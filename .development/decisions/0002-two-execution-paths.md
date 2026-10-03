# 0002. Two execution paths: foreground subprocess, background SDK session

- **Status:** Accepted
- **Date:** 2026-08-06
- **Issues:** #28, #147, #198

## Context

The original design spawned a `pi` subprocess for every delegation, which blocked and returned the result in the turn. Unattended and concurrent work needed non-blocking runs, and pi's SDK exposed `createAgentSession` with `steer()` and `abort()`, making an in-process path viable.

## Decision

- Foreground delegations run through the subprocess runner (`runner.ts`) and the result returns in the tool call.
- Background delegations run through an in-process SDK session (`session-manager.ts`) with run records, transcripts, and a completion wake.
- `background: true` is supported for single runs and for `tasks` fan-out, one agent per task.
- `chain` and `graph` reject `background` loudly, and branch-mode fan-out is rejected up front because the per-repo git lock is awaited inside the spawn.

## Consequences

- Two code paths must be maintained in parallel.
- Background runs are not auto-retried on timeout (documented foreground-only).
- Fan-out deliberately runs outside the concurrency-slot queue, accepting that slot accounting does not cover background fan-out.

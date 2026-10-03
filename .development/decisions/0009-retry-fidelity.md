# 0009. Retry fidelity: restore the recorded execution shape, explicit values win

- **Status:** Accepted
- **Date:** 2026-09-29
- **Issues:** #227, #244

## Context

Retries silently dropped parts of the execution shape — `background`, `gitMode`, `approvalMode`, `force` — and priority, so a retry could run as a different kind of job than the original. Multi-step retries silently degraded.

## Decision

- The run record snapshots the execution shape plus model/thinking/priority.
- A retry restores it, with explicitly passed values winning.
- chain/tasks/graph retries degrade to a single run — documented, not silent.
- Fan-out unit retries are single foreground runs; `retryOnTimeout` is explicit-only and never restored.

## Consequences

- A retry is predictable and inspectable.
- The documented degradation is a known limitation rather than a trap.
- The fan-out unit behavior is deliberate because units record no `background` snapshot.

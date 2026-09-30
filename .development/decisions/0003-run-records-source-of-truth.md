# 0003. Run records are the source of truth for monitor, history, retry, and metrics

- **Status:** Accepted
- **Date:** 2026-09-22
- **Issues:** #52, #122, #133, #185, #187

## Context

The TUI, the history viewer, retry resolution, and metrics each grew private reads of run data instead of sharing one store. The monitor's liveness sweep and foreground/graph/chain visibility all needed persisted entries, and a background entry once carried no cost/output because extraction ran after the session was gone.

## Decision

- Every run — foreground, background, and each unit of chain/tasks/graph — persists a `SubagentRun` entry created at spawn and finalized on every terminal path with status, stopReason, cost/tokens, and output.
- Consumers use explicit intent-named lookups rather than first-match.
- Usage is captured before the session reference is released.

## Consequences

- The monitor's staleness sweep depends on the invariant that a live row has a persisted entry.
- Retry reads the recorded `originalParams` snapshot, so it no longer reconstructs parameters.
- Every consumer routes through one store, closing the cost/output gap from late extraction.

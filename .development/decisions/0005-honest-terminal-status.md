# 0005. Honest terminal status from the raw stopReason

- **Status:** Accepted
- **Date:** 2026-09-20
- **Issues:** #179, #120

## Context

The SDK resolves `session.prompt()` on a mid-run provider death, but the settle path had no error branch, so deaths were recorded and reported as completed with exit code 0. Renderers and aggregates each kept private copies of the verdict logic.

## Decision

- Classify from the raw terminal `stopReason` in one shared classifier: `stop` → completed, `aborted` → stopped, error/length/toolUse/deferred/pending → failed with `truncated`/`incomplete` distinctions.
- Persist work volume (turns, tokensOut, finalTurnError).
- Route every renderer and aggregate through the single predicate.

## Consequences

- A timeout or sync-throw can no longer be stamped green.
- The terminal-status ratchet (#186) enforces the vocabulary in a CI test.
- A failure headline survives output tail-truncation.

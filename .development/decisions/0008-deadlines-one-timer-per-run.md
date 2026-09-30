# 0008. Deadlines: one timer per run; 30 minutes is a default, not a ceiling

- **Status:** Accepted
- **Date:** 2026-09-29
- **Issues:** #240, #244

## Context

The 30-minute "hard cap" silently shortened explicit timeouts and orphaned sessions — the orphan was fixed by aborting, but the override remained. With an explicit timeout, both the index timer and the session-manager timer armed at the same deadline.

## Decision

- An explicit `timeout` is honored verbatim and owned by the session-manager timer.
- The index timer arms only on the no-timeout default path.
- User-visible wording says "deadline", never "hard cap".
- `retryOnTimeout` is documented foreground-only, and the ≥2³¹ boundary normalizes to "no timeout".

## Consequences

- Exactly one deadline timer per run.
- Long runs are legitimate.
- The no-timeout default (30m) still protects against orphaned work — it is a protection, not a policy.

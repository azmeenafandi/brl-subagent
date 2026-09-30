# 0004. Completion-push wake instead of polling

- **Status:** Accepted
- **Date:** 2026-09-02
- **Issues:** #147, #149

## Context

Conductors babysat background runs by polling `get_subagent_result`, while the event bus emitted terminal events with zero subscribers. A wake is a real LLM turn and therefore a cost the user should control.

## Decision

- On a terminal background event, push a structured `subagent-completion` message (`triggerTurn`) carrying the run's outcome.
- Failed and stopped runs always wake; the `completionNotify` knob is all/failed/off.
- Send exactly one notification per run — the poller's duplicate echoes were removed.

## Consequences

- The guideline is "do not poll — you will be woken".
- The knob exists because wakes cost money.
- A stopped run wakes by design even though it is not a failure.

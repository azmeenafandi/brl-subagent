# 0001. Task-as-data fence at both execution chokepoints

- **Status:** Accepted
- **Date:** 2026-08-03
- **Issues:** #27, #42

## Context

The subagent task is a conductor-authored string passed as the `-p` argument in the foreground subprocess and as `session.prompt` in the background session. An LLM treats its user message as instructions, so a task containing embedded instruction blocks could blur task text with system instructions and be executed. `{previous}`/`{otherId}` substitution runs first, so the fence had to survive it.

## Decision

- Wrap the task in `<task>…</task>` after `{previous}`/`{otherId}` substitution, at both chokepoints (`runner.ts` and `session-manager.ts`).
- Neutralize forged markers by replacing embedded `<task>`/`</task>` text with fullwidth `〈task〉`/`〈/task〉` so it can never close the fence early.
- Add the Task Boundary directive to `SUBAGENT_INSTRUCTIONS` so the subagent treats the fenced content as data, not instructions.

## Consequences

- Fidelity trade-off accepted: literal marker text inside a task is altered (documented in the `wrapTask` docstring).
- A forged-marker probe was tried live in both paths and was neutralized.
- `runner.test.ts` pins the foreground chokepoint so a regression fails CI.

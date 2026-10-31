# 0017. Retry resume context is delivered system-side, never inside the task fence

- **Status:** Accepted
- **Date:** 2026-10-31
- **Issues:** #411

## Context

ADR 0001 wraps the task at both execution chokepoints — `session.prompt(wrapTask(...))` for background sessions
and the foreground subprocess `-p` argument — and the Task Boundary directive tells the subagent that the content
inside `<task>…</task>` is DATA, not instructions. Instruction-shaped text inside the fence is untrusted content to
be ignored.

Issue #401 added a resume preamble for transport auto-retries by **prepending it to the replayed task**, so the
preamble landed *inside* the fence and asked the child to run `git status`, `git log`, read the progress bank, and
continue from retained state. Those are commands about how the child should behave — exactly the content the fence
exists to screen out. It worked by model compliance, not by design, and it risked training the model to follow
instruction text inside the fence.

## Decision

Deliver the resume preamble as a conductor-authored `<resume-context>` section on the child's **system-prompt
side**, through the existing `appendSystemPrompt` channel (never inside the fence):

- `resumeContext?: string` on both spawn shapes (`src/index.ts` `startBackgroundAgent`,
  `src/session-manager.ts` `spawnBackgroundSession`).
- The background retry passes `task: singleTask` (byte-identical to the recorded original) and
  `resumeContext: attemptContext`.
- `spawnBackgroundSession` builds `appendSystemPrompt` as an ordered array — `<system-prompt>` first, then
  `<resume-context>` — which the SDK joins inside the single `<addendum>` section.
- The `<task>` fence carries the task payload only.

## Consequences

- Conductor-computed, charset-bounded resume context is delivered as a `<resume-context>` entry in the child's
  `appendSystemPrompt`; the `<task>` fence carries the task payload only.
- The wrapped task stays byte-identical to the recorded original, so `originalParams.task`, routing isolation, and
  the attempt-3 non-compounding invariant are all preserved.
- The preamble *text* is unchanged; only the delivery channel moved.
- ADR 0001's fence semantics are unchanged — this records a channel decision, not an amendment to the fence.

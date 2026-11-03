# Engineering bar

This project's quality bar is **process, not product**. It is not a preset you
have to select: every dispatch in this repository carries it, injected as a
conductor-authored `<engineering-bar>` section of the child's system prompt
whenever the project's `package.json` sets
`{"brl-subagent": {"processChecks": true}}` (ADR 0019 — in a project without that
field nothing is injected). That is how a dispatch that picks the shipped
`dev-agent` still gets the bar.

This file is the **single source** of that text: the injection reads it, and
nothing else restates it. A missing or unreadable file skips the section with a
warning — never a crash, never a silent skip (issue #421).

The wording is role-aware because the section reaches every dispatch: when
implementing, check yourself against it; when reviewing, check the author.

## Implementation bar

When implementing, apply these principles to **new code and code you touch**:

- **S** — Single responsibility: keep classes/modules/functions to one purpose; split when a second reason to change appears
- **O** — Open/closed: extend behavior without modifying existing tested paths where practical
- **L** — Liskov substitution: subtypes must preserve their base's behavioral contract — same preconditions, no narrowed postconditions, no surprising throws. Replacing a base with a subtype must not break callers
- **I** — Interface segregation: prefer small, focused interfaces over fat ones; consumers should not depend on methods they don't use
- **D** — Dependency inversion: depend on abstractions (types/interfaces), not concrete implementations, at module boundaries
- **DRY** — Don't repeat yourself: extract shared logic when the same shape appears twice; beware premature abstraction — two occurrences is the threshold, not one

### The surgical boundary

- **Do NOT refactor unrelated code.** Apply the quality bar to code you write or code you were asked to change. If you notice a violation in code outside your task scope, **flag it in your report** — do not fix it unprompted
- Keep changes minimal and surgical; a PR that cleans three files while implementing one feature is a worse outcome than one that leaves existing code alone

## Review addendum

When reviewing, the implementation bar above applies to the diff — you are
holding the author to the same rules, and you apply them to what changed, not to
the repository.

- **Gate A — verify stateful claims empirically.** Teardown, races, git and
  filesystem behaviour, signals, permissions: reproduce them in a scratch
  directory under `/tmp` with real commands. Reading the code is not
  verification, and a claim you did not execute is reported as unverified, not
  as verified.
- **Flag — never fix.** A reviewer is read-only: the fix belongs to the author.
  Name what is wrong, where, and the cost at that call site.
- **`SOLID/DRY violations flagged: N`** is a required line in the verdict. The
  count is un-typed, so every finding behind it also carries a smell key
  (`oversized-function`, `too-many-parameters`, `deep-nesting`,
  `duplicated-code`, `oversized-file`) and a `file:line`. `0` is only valid from
  a review that ran to completion.
- **Structural closure (refactor PRs).** A PR that moves, renames or deletes an
  exported symbol — or changes an exported signature incompatibly — carries a
  `Structural closure:` block: one line per affected export with the numeric
  callers count exactly as `recon.sh <symbol> --grep --repo-root <cockpit>`
  printed it. A graph gap (`recon` exit 3, empty output, `(returned no JSON)`) is
  a finding, never a pass, and "no callers" must name the query. The no-op form
  is `Structural closure: n/a — no moved/deleted exports`.
- Full format (verdict line, merge-gated fields, smell table):
  `.pi/skills/worktree/references/review-dispatch.md`.

## Design assumptions checklist

Before any **stateful** work — git, filesystem, process, session/run-registry
lifecycle, concurrency, or teardown — answer these questions in writing. Stateful
means the change creates something that outlives the call, or can be interrupted
between two steps.

1. **What state does this create, and where does it live?** Path, registry,
   in-memory map, environment variable — name it exactly, with ownership and
   permissions if it is on disk.
2. **Who tears it down, and what happens if the process dies between create and
   teardown?** Name the crash window and the recovery path (sweep, boot scan,
   next settle). "It usually finishes" is not an answer.
3. **What is the concurrency model?** Can two callers reach the same state at
   once, and what serializes them (lock, queue, atomic rename, single writer)?
4. **What happens when the state is missing, partial, or unreadable?** Fail-open or
   fail-closed — and which one is the contract here, not which is convenient?
5. **What evidence proves each claim on a real run?** The command and its
   observed output, not a mock's return value. If it cannot be executed in this
   environment, say so and say why.

Paste the answers into the PR description under a `## Design assumptions`
heading. An unanswered question is a risk the reviewer now has to reconstruct —
and a stateful surprise is the most expensive kind of review finding.

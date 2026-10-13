# Glossary

Plain-language definitions for terms that come up in this project's work and docs. Started 2026-10-09 at
the maintainer's request. The working rule behind it: *a term you can't restate in your own words is a term
you can't use to make decisions.*

**How this file works**

- An entry is added when a term (a) caused confusion in a conversation, or (b) became load-bearing — our
  decisions now depend on understanding it.
- Order within an entry: plain-language meaning → what it means *here* → why it matters (the part that
  changes what you'd do).
- Short. Cross-reference project docs instead of repeating them.
- Prune entries that stop being used; a stale glossary is worse than none.

---

## Oracle

**Plain meaning.** The independent source of expected answers you compare a result against to decide "is
this correct?" — literally "a source of authoritative answers".

**Not to be confused with** a *spec*, which says what the system should do. The spec is the rulebook; the
oracle is the answer key. (Unrelated to Oracle the database company.)

**Here we use several, by question:**

- *Is the graph complete?* → the **filesystem** itself: every `src/*.ts` on disk must appear in the graph
  (`graph-check.py`, `codegraph-check.py`). The graph tool never gets to define "complete".
- *Is an agent's work correct?* → the **worktree** ("the worktree oracle"): smoke test + full suite + live
  probes. We trust what the worktree produces, never the agent's report.
- *Who calls this function?* → grep as an approximate oracle — known weak (2026-10-08: two wrong
  constructions before the definition-line fix; the tool under test was right throughout).
- *Does it behave right for the user?* → your **eyes** (Rule 9's visibility clause).

**Why it matters.** A green check is only as meaningful as its oracle. Weak oracles make "pass" provisional,
so every guard states its **boundaries** (what it does *not* see), and an oracle bug is a real bug.

## Ground truth

The reality an oracle compares against: files on disk, a live probe's output, your screen. In the retired
`graph-check.py`'s words: "Ground truth is the filesystem and the graph JSON. Nothing else."

## Spec (specification)

A written statement of what should be built or how something should behave — a delegation spec, the Team
Agreement, `AGENT.md`. Prescriptive: what *should* happen. An oracle is evaluative: *was it* right.

## Backstop

The mechanism that catches you when something slips: the full test suite, the architecture rules, review.
Not the same as an oracle — a backstop detects breakage; it doesn't certify correctness. Rule 15: the suite
is the backstop for a spec, not its definition of truth — a spec and its tests can be wrong in the same way.

## Invariant (architecture rule)

A property that must always hold, written so it can be checked mechanically. Our 9 architecture rules (no
import cycles, raw-console confinement, …) are invariants enforced as tests. Spec: "do X." Invariant:
"never allow Y."

## Ratchet

A check that only turns one way: it locks in an improvement and fails if the code slides back. Examples: the
transcript-path rule (no re-inlined path literals outside `transcript-path.ts`), the runtime-vocabulary
ratchet. Ratchets are never loosened — only tightened or retired.

## Regression

Something that used to work and no longer does. A "regression test" would fail if a fixed bug came back;
most of our 1,2xx-test suite serves this role.

## Linter

A tool that reads source code and flags suspicious patterns *without running it* (style, unused code, common
bugs). **This project has no linter** (checked 2026-10-09): we rely on the type checker (`tsc`), the
executable architecture rules, and review. Analysed and deliberately not adopted for now — the
"sensor-stage" idea is queued in `ROADMAP.md`. Umbrella term: *static analysis*.

## ADR (architecture decision record)

A short numbered, dated note in `.development/decisions/` recording a decision, the options considered, and
why — so nobody (human or agent) has to relitigate it later. We write one when a choice constrains future
work (e.g. 0013: TypeScript 7 pinned exactly, with one containment adapter).

---

*Maintained by the conductor. Entries are added or refreshed whenever a term causes confusion or becomes
load-bearing — just ask.*

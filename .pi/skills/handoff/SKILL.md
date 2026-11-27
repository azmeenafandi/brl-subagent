---
name: handoff
description: >
  Use when starting a fresh session, before or after a compaction, or when asked
  to update the handoff. Covers `.development/HANDOFF.md` (the index), the pages
  under `.development/handoff/` (the claims and the invariants), the `Verified:`
  protocol, the write rules, and the budget.
---

# Handoff

`.development/HANDOFF.md` is the conductor's durable state, and since #607 it is an **index**, not a
record: a front page of four §STATE lines plus bounded lists of invariants, pointers and resume
commands. The mechanical claims — dev sha, install, board, suite, modules, ADRs, file sizes — live in
the PAGE `.development/handoff/state.md`, and the invariant list in `handoff/invariants.md`. A page is
opened on demand; the index is what every session pays for.

The **handoff extension** (`.pi/extensions/handoff/`) injects §STATE at session start and after every
compaction, prefixed with a staleness line:

```
Handoff verified at f4e518b — matches HEAD.
Handoff verified at f4e518b — matches HEAD (ignoring the handoff's own commit).
Handoff verified at ae7c488 but HEAD is f4e518b — RECONCILE before trusting §STATE.
Handoff has no Verified: line — verify §STATE against the repo before trusting it.
```

The extension runs in the **cockpit on `dev`** only — it is inert in subagents, worktrees and
non-project cwds. It reads; it never writes (except `/handoff mark`, which touches only the index's
`Verified:` line). The content is the conductor's; **the verifier is the authority**, not the banner.

## The four rules

1. **Read §STATE, then verify before acting.** §STATE names four things: the tree (`Verified:`), what
   is in flight, the one next action, and where the pages are. Run `node scripts/handoff-verify.mjs`
   before trusting any of it: exit 0 every claim holds · 1 a claim is wrong · 2 cannot check.
2. **The index is REPLACED, never appended.** Four §STATE fields, a bound on every section, and no
   counts in prose — a count belongs in `handoff/state.md`, where the verifier recomputes it.
3. **History is retired, not migrated.** A section that stops being current state moves verbatim to
   `.development/HANDOFF-ARCHIVE-<date>.md`. The index never carries it "just this once": a section
   with room to grow is a section that grows.
4. **Write the handoff BEFORE a compaction, not after.** The summary cannot be trusted to carry
   §STATE; the pre-compaction checklist is in the reference.

## The shape, and the budget

```
# Handoff
> 2 lines of preamble at most
## STATE             Verified: · In flight: · Next action: #<n> (open) · Index:
## Invariants        ≤8 `- ` bullets
## Pointers          ≤12 `|` rows — markdown links, one per page
## Resume protocol   ≤3 command lines
```

The whole index is **≤80 lines and ≤8 KB**, every line ≤160 characters, no `### ` heading, no count in
prose. Those are not style notes: `handoff-verify` fails on each of them with a named code
(`over-budget`, `state-shape`, `section-over-bound`, `state-drift`, `unattributed-count`).

## Before committing the handoff

Run the verifier — it makes TWO passes and prints both:

- **the index**: structure (H2 set, no H3), shape (four §STATE fields, per-line bound), budget,
  index completeness (`unindexed-page` / `dead-link`), citation liveness (`#<n> (open|closed|merged)`
  against `gh`, a backticked sha against `dev`, a `## Pointers` target against the filesystem), no
  counts in prose, and one open next action;
- **the page**: the mechanical claims — dev, install, open set, suite, modules/ADRs, file sizes — with
  the index's `Verified:` as the head the suite report must have been captured at.

A missing page is exit **2** (`state-page-missing`), never a drift. A drift means **fix the claim,
never the script**. `--json` for a machine, `--no-network` to skip the `gh` lookups (it says so),
`--report <vitest.json>` to pin the suite report, `--root <path>` to evaluate another checkout. Not in
CI — it needs `gh` and the local install.

Push the handoff commit **in the same turn**: a handoff commit that stays local diverges `dev` from
`origin/dev` the moment a PR merges, and the next `git pull --ff-only` refuses.

## Commands

| Command | Effect |
|---|---|
| `/handoff` | show §STATE + the staleness line + the resume protocol |
| `/handoff mark` | rewrite the index's `Verified:` line to the current HEAD (content stays yours) |

Marking rewrites the sha only. The pages are reconciled by hand afterwards — re-capture the suite,
then update the page's `dev @` and sizes.

## Reference

[`references/handoff.md`](references/handoff.md) — the full contract: the index and page shapes, the
write rules, the `Verified:` protocol, the page convention, the budgets, and what each check means.

---
name: handoff
description: >
  Use when starting a fresh session, before or after a compaction, or when asked
  to update the handoff. Covers `.development/HANDOFF.md`: the §STATE snapshot,
  the `Verified:` protocol, the write rules, and the size budget.
---

# Handoff

`.development/HANDOFF.md` is the conductor's durable state. It is the one thing a
fresh session cannot infer from the repo, and a compaction summary is lossy — so
the **handoff extension** (`.pi/extensions/handoff/`) injects §STATE at session
start and after every compaction, prefixed with a staleness line:

```
Handoff verified at f4e518b — matches HEAD.
Handoff verified at f4e518b — matches HEAD (ignoring the handoff's own commit).
Handoff verified at ae7c488 but HEAD is f4e518b — RECONCILE before trusting §STATE.
Handoff has no Verified: line — verify §STATE against the repo before trusting it.
```

The extension runs in the **cockpit on `dev`** only — it is inert in subagents,
worktrees and non-project cwds. It reads; it never writes (except `/handoff mark`,
which touches only the `Verified:` line). The content is the conductor's.

## The three rules

1. **Read §STATE first, then verify it.** Every STATE claim carries a verify
   command or is marked unverified. A snapshot is a claim, not ground truth —
   `RECONCILE` means the file describes another tree.
2. **STATE is REPLACED at every handover, never appended.** Session narratives,
   release sections and superseded STATE do not belong here: git and
   `.development/investigations/` are the history. Archive verbatim to
   `.development/HANDOFF-ARCHIVE-<date>.md` rather than deleting.
3. **Write the handoff BEFORE a compaction, not after.** The summary cannot be
   trusted to carry §STATE; the pre-compaction checklist is in the reference.

## Structure (short form)

`# Handoff` → preamble (how to use) → `## STATE` (`Verified:` line + snapshot +
`### Since the last handover` + `### Next actions`) → `## Open items` →
`## Operating notes` → `## Pointers`.

Budget: the whole file ≤ ~120 lines, `## STATE` ≤ ~40. STATE is injected into
every session's context — its size is a per-session tax.

## Commands

| Command | Effect |
|---|---|
| `/handoff` | show §STATE + the staleness line + the verify commands |
| `/handoff mark` | rewrite §STATE's `Verified:` line to the current HEAD (content stays yours) |

## Reference

[`references/handoff.md`](references/handoff.md) — the full contract: structure,
write rules, the `Verified:` protocol, the pre-compaction checklist, the history
rule, and the verify-command table.

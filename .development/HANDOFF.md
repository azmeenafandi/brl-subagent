# Handoff

> Read §STATE → run the resume commands → open the pages you need.
> History: `.development/HANDOFF-ARCHIVE-*` and `.development/FRICTION_LOG.md` — never re-read it.

## STATE
Verified: 4e0a1c9 (2026-11-27)
In flight: nothing
Next action: #606 (open) — the factory's front door
Index: verify `node scripts/handoff-verify.mjs` (0 drift) before acting → §Invariants·§Pointers·§Resume protocol · handoff/state.md · handoff/invariants.md

## Invariants
- (f) reads the provenance ledger; the recheck line is *resolved*, never typed
- `.pi/jev-lines.log` is gitignored — never copy it into the repo
- code changes go through a worktree; merge commits, never squash
- bank every dispatch to `bank/<label>.md`; push the handoff commit in the same turn
- a count lives in a page, never in this index — the suite total is the claim that ages
- `handoff-verify` is the authority, not the extension banner: reconcile on drift, capture on exit 2
- the gate reads the PR body, so a merged claim names an artifact (sha · record · report), never a promise
- one next action at a time; the board holds the queue

## Pointers
| Page | Holds |
|---|---|
| [state](handoff/state.md) | the mechanical snapshot: dev, install, board, suite, modules, ADRs, file sizes |
| [invariants](handoff/invariants.md) | the full invariant list, each with its reason and its source |
| [spec](investigations/issue-607-handoff-index-spec-2026-11-27.md) | this redesign, in full |
| [worktree skill](../.pi/skills/worktree/SKILL.md) | lifecycle, rituals, dispatch presets |
| [handoff reference](../.pi/skills/handoff/references/handoff.md) | the write contract for these pages |
| [pr skill](../.pi/skills/pr/SKILL.md) | the PR-body contract |
| [friction log](FRICTION_LOG.md) | where a rule-level defect is filed |
| [archive](HANDOFF-ARCHIVE-2026-11-27.md) | the archived handover history |

## Resume protocol
node scripts/handoff-verify.mjs     # 0 drift (or exit 2: capture the suite report first)
git status --short                  # clean tree
gh issue view <next-action-number>  # the next action

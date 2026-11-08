# 0026. A durable headState per repository: the boot restores the base branch and keeps the interrupted run's work

- **Status:** Accepted
- **Date:** 2026-11-08
- **Issues:** #466, #460, #465
- **Supersedes:** nothing. Qualifies ADR 0023 decision 2: the deadline still owns no git
  resource and releases no lock — a *new* owner (the boot) may restore a branch, and only
  for a record whose owner it has proved dead.

## Context

A branch-mode run creates `brl-subagent-<8hex>` and records the starting HEAD only in a local
variable (`session-manager.ts:1644`, `git.ts:70`). If the run never settles — a deaf prompt
(#460 M1) or a crash — the tree stays on that branch and nothing durable names the base. The
next dispatch then reads the orphan as its base and its diff window starts at the orphan's tip,
so the earlier run's work is outside the report (#460 P7, re-measured two-process in the #466
dossier: `W466P-P2B`).

Two measurements shape the decision. **The boot cannot see the case**: the deadline writes the
run record terminal (`session-manager.ts:2111`), and a terminal record retires the registry
claim (`run-registry.ts:346-353`), so `recoverInflightRuns` gets nothing to classify
(`W466P-P1S2`: `scanned 0` after `entries 1 → 0`). **The clean orphan is ours**: a crash inside
`cleanupWorkBranch`'s 27 ms `commitAll`→`captureDiff` window leaves a clean tree on the work
branch with the work committed there and the diff lost in memory (`W466P-P4`).

Evidence: `.development/investigations/issue-466-headstate-2026-11-08.md` (798 lines, 12 probes,
options O0–O4).

## Decision

**D1 — one record per repository, outside the repo, written before the branch exists.** A
`HeadStateRecord` (`{version, repoRoot, runId, kind, base: {branch, sha, detached}, workBranch,
owner, createdAt}`) at `.pi/head-state/<sha256(repoRoot)[0:16]>.json`, `0o700`/`0o600`, atomic
temp+rename. It is written inside the per-repo lock, after the dirty check and **before**
`createWorkBranch`, which is why the branch name moves to the caller (`newWorkBranchName()`).
One record per repo is sufficient because `gitBranchLocks` already serializes the whole branch
lifecycle per repo root.

**D2 — the boot restores, and only under three preconditions.** Row order is fixed: record
parses → `repoRoot` resolves → **owner provably dead** (`classifyOwner`) → HEAD is *exactly*
the recorded work branch → the branch still exists → the tree is clean. Then `restoreHead(base)`,
verify, clear. A deleted-but-checked-out branch (unborn HEAD) is a *repair* row, not a refusal:
`git checkout <base>` works there and `status` reads dirty for the wrong reason.

**D3 — the work branch is never deleted by the boot, and nothing is forced.** After a crash the
branch is the only copy of the work (the diff was never captured). No `checkout -f`, no
`reset --hard`, no `branch -D`, no branch *choice* — the repair replays the recorded base.

**D4 — everything the boot cannot repair is named, and the next branch dispatch refuses.** A
dirty tree, an unreadable record, a vanished repo, a legacy state: leave the tree alone, keep
the record, one warn line. A branch dispatch in a repo whose record is still unresolved and
whose owner is not alive refuses before the dirty check, naming the work branch, the base and
the exact commands. #465's in-process refusal keeps priority: a live owner is a different fact.

**D5 — silence is not a verdict.** Every record ends in exactly one outcome, logged; the repair
and the needs-manual verdict reach the user once, on the existing `nextTurn` channel
(`resolveRecoveryNoticeDelivery`), gated by `config.recovery !== "off"`. The *repair* is never
gated by that config.

**D6 — the foreground branch path is in scope.** `index.ts:3397` creates the same work branch
with the same crash exposure (it warns and proceeds on a dirty tree where the background path
refuses). It writes and clears the same record with `kind: "foreground"`, so "no record" means
"no orphan" for every branch run, not just background ones.

## Alternatives rejected

- **Teaching the boot scan to see terminal runs** (keep the registry entry). Re-opens #447's
  terminal⇒cleared invariant for every consumer of `listInflightRuns`; measured alternative: a
  90-line store.
- **Reading the base from the log line or the reflog.** Both exist and both were measured
  (`Created work branch {branch, base}` in `.pi/subagent-logs/brl-subagent.log`;
  `checkout: moving from main to brl-subagent-…` in the reflog). Neither is a contract: rotation
  at 5 MB × 5, level filtering, a sha instead of a branch for detached starts, and a 90-day
  reflog expiry. They become hints in the message, not the record.
- **The agent record as the home.** It is durable and already read at boot, but only *by id from
  a registry entry that no longer exists*, and a terminal agent record is dropped even when the
  entry survives (`W466P-P1S3`). It cannot be the index; it may stay a payload.
- **Inside the repo** (`.git/brl-subagent/…`). Travels with the repo, but nothing enumerates
  repos at boot, and it is worktree-hostile.
- **Deleting the orphan branch after restoring.** The settled path deletes it *because it
  captured the diff first*; after a crash there is no diff, so deletion is data loss.
- **Repairing at the next dispatch only.** Same commands, later, and the tree stays wrong — with
  the user's own edits landing on the orphan — until someone dispatches.
- **Waiting a grace period for the late writer.** A detached child does not die on its own; the
  wait buys nothing and delays the boot.

## Consequences and limits

- **The late-writer hazard is admitted, not solved.** A `bash` child is spawned detached
  (`bash.js:63-71`) and survives a conductor SIGKILL (measured: alive, 38 B/s, writes into the
  restored tree). Background runs carry no `childMarker`, so the existing marker scan cannot
  find it. Damage is bounded to the working tree and is visible in `git status`.
- **Non-`/proc` hosts do not repair.** `classifyOwner` returns `unknown` without a start token,
  so the policy degrades to warn+refuse. No pid-only fallback: pid reuse would make it unsound.
- **Same-project restarts only.** The store is cwd-relative like the other two stores.
- **Two concurrent pi processes in one repo** are not serialized (pre-existing); the record is
  last-writer-wins and the earlier orphan becomes an unrecorded `brl-subagent-*` branch.
- **Older orphans are leaked refs**, reported by count, never deleted.
- **No staleness sweep is specified here.** A record whose repo is gone would otherwise be
  immortal; the follow-up adds a bounded age-based sweep (precedent: `cleanupTempDirs`) and
  states its value — it is housekeeping, not part of the repair contract.

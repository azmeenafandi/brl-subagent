## Invariants

The list the index only summarises. Each entry is a rule that has already cost a cycle when it was
dropped, with the reason it exists and where the reason comes from. Read this page before changing a
process tool; read the linked record before changing the rule.

### State

- **A count is a claim, and a claim needs a report.** `Suite:` is compared against a vitest JSON report
  captured at the `Verified:` sha, and a red report certifies nothing whatever its totals say. *Reason:*
  the numbers in this file drifted four separate ways before #495 made them mechanical, and the first
  `handoff-verify` receipt was itself red over a destroyed size list — the checker is the thing that
  caught it.
- **`Verified:` names the tree the pages describe, and it lives only in the index.** `handoff mark`
  rewrites that one line; the pages are reconciled by hand afterwards. *Reason:* two copies of one sha is
  two chances to disagree (#520), and the extension's banner is a hint — the verifier is the authority.
- **The handoff's own commit is not drift.** Every commit after `Verified:` must touch only
  `.development/HANDOFF.md`, its archives and `.development/handoff/*.md`; an empty path list is drift,
  never a vacuous pass. *Reason:* `Verified:` can never name the commit that writes it, and a rule that
  said otherwise would print RECONCILE forever (#393, #579).
- **History is retired, not migrated.** When a section stops being current state it moves verbatim to
  `.development/HANDOFF-ARCHIVE-<date>.md`. *Reason:* the `Since the last handover` chain grew to
  sixty-two percent of the file and was read on every resume — the archive keeps the words available
  without paying for them each session (#607).
- **The index carries no count, and no section may grow.** Four §STATE fields, a bounded preamble,
  bounded §Invariants/§Pointers/§Resume protocol, and a byte budget. *Reason:* a section with room to
  grow is a section that grows; the bound is what makes "no history" structural instead of editorial.
- **A citation is a claim.** `#<n> (open|closed|merged)` is checked against the board, a backticked sha
  against `dev`, a `## Pointers` link against the filesystem. *Reason:* a dead pointer reads as a page
  that was written, and a closed issue labelled "next" is the same class of false premise as a stale
  total (#607 D4/D5).

### Evidence

- **A filtered test run must execute something.** `vitest -t "<title>"` exits 0 when the title matches
  nothing, so a receipt that says `success: true` for a run that ran nothing is a fabricated claim.
  `node scripts/require-executed.mjs -- <vitest args>` is the guard. *Reason:* #591 measured it on this
  repo, and a green suite with zero executed #607 tests fails the spec's own acceptance.
- **A spec's evidence row needs a command and a negative control.** A row that cannot fail is not
  evidence; every claim states the command, the pass state, and the fail state. *Reason:* three
  unfalsifiable rows survived two review rounds until the rule was written down (#557, and the plan
  critic now audits for it first).
- **Name the mutant and its killer.** A mutation table states where in the control flow the mutated code
  is reached, because a mutant behind an early return cannot go red. *Reason:* #597 filed two instances
  where the named mutant was unreachable, both caught by critique rather than by the author.
- **A corpus's numbers are produced by a script, not by hand.** A spec that asserts counts over a fixture
  corpus ships the corpus and the script that prints them. *Reason:* #598 — an arithmetic table was wrong
  through three rounds, and the third was caught by the implementer.
- **A check that cannot answer exits 2, never 0 or 1.** No report, no `dev` ref, no `gh`, no page: all
  exit 2 with the reason. *Reason:* conflating "cannot check" with "holds" is how a vacuous proof ships;
  conflating it with drift sends the reader to fix a claim that is not wrong (#513).

### Process

- **(f) reads the provenance ledger; the recheck line is resolved, never typed.** The gate's own predicate
  is `matchRow` in `scripts/lib/provenance-ledger.mjs`, one reader for both the gate and the record.
  *Reason:* transcription drift was measured at 4/4 before #601 — a hand-typed line is a claim about a row
  nothing compared.
- **A merged claim names an artifact.** A sha, a review record, a suite report — never a promise, never a
  paraphrase. *Reason:* the gate recomputes the body from the tree, and a claim it cannot recompute is a
  claim it has to trust (ADR 0021 §1: no coverage percentages, no unmeasurable bars).
- **Code changes go through a worktree; merges are merge commits, never squash.** *Reason:* the gate's
  flow check, the receipt recompute and the branch base all assume the merge commit; a squash rewrite
  moves the shas every record cites.
- **One next action at a time; the board holds the queue.** The index states one `#<n> (open)`; a second
  parallel "next" is `next-action-ambiguous`. *Reason:* a queue in the handoff is history growing back,
  and the stale `Next: U6` after U6 merged was a real drift found in the wild.
- **Bank every dispatch to `bank/<label>.md` and push the handoff commit in the same turn.** *Reason:* a
  handoff commit that stays local diverges `dev` from `origin/dev` the moment a PR merges, and the next
  `git pull --ff-only` refuses; the bank is what survives a transport death.
- **Switch shape at two deaths, with nothing else changed.** A background run that dies the same way twice
  is retried in the conductor or split, not re-dispatched. *Reason:* #556 measured twelve auto-retries,
  every one a first attempt, and the waste was the retry that dies identically.

### Security and the private channel

- **`.pi/jev-lines.log` is gitignored; never copy it into the repo.** The private owner channel, its
  address and its scripts are gitignored too, and `check-repo.sh` fails when a private path is not
  ignored. *Reason:* the repository is public; a leak guard is cheaper than a rotation.

### Environment

- **Never `npm install` in the cockpit** — `worktree-prep.sh` only, `--force-isolated` for a dependency
  bump. *Reason:* the cockpit's `node_modules` is the installed dev checkout the dispatch runs on; an
  install there changes the thing under test mid-unit.
- **Opus-class models are prohibited unless the owner names one in the same turn.** A hard unit gets a
  better spec, a narrower scope or another critique round. *Reason:* one authorised experiment cost
  dollars-per-minute of a kind no review can repay (#602 filed the substitution that followed it).
- **`pr-evidence --check` runs in the PR worktree, at the PR head.** *Reason:* it recomputes the body from
  the checked-out tree; run elsewhere it compares the body against a different tree and passes for the
  wrong reason.

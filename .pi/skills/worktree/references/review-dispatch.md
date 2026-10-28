# Adversarial review dispatch (how-to)

Classify first — the C1/C2/C3 table is in `SKILL.md`.

**Jev check on the dispatch (Rule 22):** the spec/dispatch under review carries a *queried*
`jev: level (confidence)` line — `jev: medium (0.84) · C2 · worktree y`, produced by the codemode
query and formatted with `.pi/skills/worktree/jev-check.mjs --line`. A **bare level**
(`jev: medium · C2`, no confidence) or a **missing line** is a finding: both are the exact form the
2026-10-13 and 2026-10-23 skips took. Record it in the verdict's findings table like any other
finding — it is a process defect, not a style nit. Format, the pipeline and the ledger check:
`references/jev-advisory.md`.

Reviewers are **read-only on the repo but have bash** — the read-only
`code-reviewer` preset excludes bash and is NOT used (empirical verification
needs execution). Use the project-scoped `project-reviewer` preset
(`.pi/brl-subagent/presets/project-reviewer.md`): tools `read, bash, grep,
find, ls`, explicitly NO `write`/`edit` so the reviewer can never touch code.
It carries the Gate A expectation, the SOLID/DRY mirror check, and the
verdict format — the dispatch task only adds the PR-specific focus areas.

The PR body's **Door** and **Blast radius** lines (the `pr` skill) are targeting
signal — aim the dispatch's focus areas at the risk they name.

**Mutation choice decides coverage.** For path-isolation tests, mutate the ACTION while leaving the accounting
intact (e.g. neuter the signals but keep the returned pid list) — an accounting-only mutation passes while the test
still cannot distinguish the paths (#322: the run's own exit sweep masked the shutdown reap).

**Dispatch with `preset: "project-reviewer"` — NOT bare `tools` (the
auto-route can override an explicit tools list; an explicit preset wins) and
NOT `dev-agent` + `excludeTools` (the retired workaround).**

**Dispatch with `gitMode: "none"`.** A reviewer never commits or branches — the
review worktree must not move. (Stray `brl-subagent-*` branches in review worktrees
were root-caused to the e2e suite's branch-mode test mutating its cwd — #302; not the
extension's git mode.) Review worktrees go through
`worktree-cleanup.sh` at close exactly like implementation worktrees; when
investigating a stray, capture `git -C <review-wt> status -sb` and
`git branch --show-current` BEFORE cleanup — the evidence dies with the worktree.

**The instruction MUST demand the verdict in the final output** — never tell
the reviewer to write a repo file (it has no `write`/`edit` tools):

- Do NOT write repo files. **Banking to a `/tmp/review-<unit>-findings.md`
  scratch file IS sanctioned and expected**: instruct the reviewer to append
  verified findings, pending items, and expected mutation signatures there as
  it goes (bash-side). The verdict still lives in the final response; banking
  exists so a drop/timeout leaves a resumable artifact (Rule 21's live
  artifact) — a re-dispatch then starts with "read the banked file first".
- Output your verdict in this exact format in your final response:
  verdict line (`approve` / `approve-with-nits` / `changes-requested`),
  `Reviewed head: <sha>` (the commit you actually reviewed — `git -C <worktree>
  rev-parse HEAD`, not the sha quoted in the dispatch), findings table
  (severity | `Smell` | file:line | one-liner) — see *Findings by smell key*
  below, verified-OK list, and the efficacy gauge: the count of smell
  findings, by key (the project-reviewer preset's mirror check feeds it).
- Gate A: verify stateful claims (teardown, races, git/fs behavior)
  empirically — scratch repos in /tmp, real commands — do not just read code.
- Keep the verdict compact; the deep write-up lives in the final output only.

The conductor retrieves the final output (never sleep-waits — the user
watches the monitor and pings when done), writes `REVIEW_PR*.md` in the
worktree from the returned verdict, and presents it for the user loop.

## The review record is a contract — it is merge-gated

`merge-guard.sh <pr> <record>` (lifecycle step 7) reads the record with a script, so the
record carries three machine-checked facts. Miss one and the gate blocks the merge:

| Line | Required | Checked by |
|---|---|---|
| PR number | `#<pr>` somewhere in the record (title is fine) | (b) the guard |
| `Verdict: approve` / `Verdict: approve-with-nits` | one **final** disposition line; `changes-requested` may not merge | (c) the guard |
| `Reviewed head: <sha>` | the commit the verdict covers (`@ <sha>` in the title also counts; a >=7-char prefix of the head is accepted) | (d) the guard |

Format the head line explicitly, e.g.

```
# REVIEW — PR #412 (`tooling/x`, "title") @ 4c1d9ab

Reviewed head: 4c1d9ab2f1e0…

Verdict: approve-with-nits
```

Rules the parser assumes:

- The **last** `Verdict:` line is the disposition. Round-by-round narratives
  (`## Round 1 — 3c5473c: changes-requested`) belong in the body; only the final line
  starts with `Verdict:`. A line naming more than one verdict (an echoed template) is
  read as **ambiguous** and blocks — state one disposition.
- `approve-with-nits` is a mergeable verdict; `changes-requested` is not, and an
  unrecognised/absent verdict is not either.
- Markdown decoration is fine (`**Verdict: approve**`, `## Verdict:`, backticks).

### `conductor-verified:` — the post-verdict commit

If a commit lands **after** the verdict, the reviewed head no longer equals the PR head.
The gate blocks that by default: a C2 change whose last commit never saw a reviewer is the
`unreviewed final fix` friction entry (PR #395, 2026-10-27 — round 2 returned
changes-requested, the two-line NUL-terminator fix went in as `77338bf`, the gates ran
locally, and the PR merged with that commit unreviewed; the disposition was defensible but
nothing but prose recorded it).

Two legitimate exits, in order of preference:

1. **Re-review the new head** and write its sha in `Reviewed head:`. This is the default.
2. **Record the conductor verification** when a re-review is disproportionate (docs/nits, a
   mechanically-proven guard, a trivial rebase): add a line the guard recognises —

   ```
   conductor-verified: 77338bf — two-line NUL guard + 2 regression tests; mutation fails both
                       new tests; extension suite, tsc, full suite 90/1798 green; diff-check clean.
   ```

   Name what was run and what it produced (Rule 21), never just "verified". The marker clears
   check (d) — it does **not** upgrade the verdict: a `changes-requested` record still blocks.

A record `merge-guard.sh` refuses is not a merge candidate, however clean the diff reads.

## Findings by smell key

Name a finding by the **problem**, not by the rule that found it (#375,
smell audit §8.4.1). `SOLID/DRY violations flagged: N` is an un-typed
counter — no two review records are comparable. The findings table
carries a `Smell` column:

| Severity | Smell | file:line | One-liner |
|---|---|---|---|
| major | `duplicated-code` | `src/prelude.ts:41` | the mode prologue is copied three times; the copies will drift |
| nit | `too-many-parameters` | `src/tui.ts:812` | six positional args; one record would make the call site readable |

The keys are tool-independent, so a finding survives a change of linter:
`oversized-function`, `too-many-parameters`, `deep-nesting`,
`duplicated-code`, `oversized-file`.

**`suggested` vs `enforced`.** Only `duplicated-code` earns enforcement:
a textual duplicate is decidable and mechanically guardable (it has a
test — `src/__tests__/prose-duplication.test.ts`). `too-many-parameters`
and `deep-nesting` are **suggested**: past the threshold they cost
readability, not correctness, and a refactor that only appeases the
count can make the code worse. Report them as nits unless the call site
genuinely suffers.

**The uncoached bucket is fail-closed.** A smell with no key above is
never dropped: report it under its nearest key, or as a free-form key
and say it is uncoached. A stage that dies must not print a clean pass —
`0 findings` is only valid from a stage that ran to completion (the same
instinct as `pr371`'s `StructuralError` on a malformed ledger).

## The guide shape

Every finding — and every fix proposed for one — follows this shape. It
is the durable half of the habit-hooks mechanic: the **metric is the
cue, the guide is the action**. A bare number gets gamed (5.6% genuine
on Sonnet 4.6, 79/90 gamed there) and our own loudest detector "findings"
landed on functions a review had just certified correct (audit §7). So a
smell count opens a question; it never closes one.

1. **Problem** — the key and the concrete site.
2. **Why it matters** — the cost *at this call site*, not in general.
3. **Numbered moves** — 2–4 concrete steps, ordered.
4. **AVOID** — the anti-Goodhart paragraph. *"Avoid mechanical
extraction … pulling matching lines into a function with five parameters
leaves the real shape untouched."* The duplicate disappears; the design
flaw survives, now harder to see. Same judgement as `pr357`'s
"`repaintStatus` is a synchronous pass-through" — reached from the other
end.
5. **A concrete technique** — the one thing to try first (the seam, the
record, the guard).

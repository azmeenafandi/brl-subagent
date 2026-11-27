# Handoff — the full contract

`.development/HANDOFF.md` holds the conductor's current state, and it is read by a fresh session that
has none of the conversation's context — re-injected after every compaction. Since #607 it is an
**index**: a front page with four §STATE lines and bounded lists. The mechanical claims live in the
**page** `.development/handoff/state.md`, and the invariant list in `.development/handoff/invariants.md`.

Why the split: 62% of the old handoff was the `### Since the last handover` chain — loaded on every
resume, at every compaction, and never acted on. Deleting it by hand would have regrown, so the
guarantee is **structural smallness** with a named shape, checked by `scripts/handoff-verify.mjs`. The
accepted residual is stated plainly: a bounded line can still hold a sentence, and the falsifier is the
measured receipt (a fresh session reaches the next action in a command or two), not a proof that no
prose can ever be smuggled in.

## The index — `.development/HANDOFF.md`

```
# Handoff

> Read §STATE → run the resume commands → open the pages you need.
> History: `.development/HANDOFF-ARCHIVE-*` and `.development/FRICTION_LOG.md` — never re-read it.

## STATE
Verified: <sha> (<date>)
In flight: <one line, or `nothing`>
Next action: #<n> (open) — <one line>
Index: verify `node scripts/handoff-verify.mjs` (0 drift) before acting → <the pages>

## Invariants
- ≤ 8 bullet lines, each a rule, never a status

## Pointers
| Page | Holds |
|---|---|
| [state](handoff/state.md) | … |

## Resume protocol
<≤ 3 command lines>
```

Rules the verifier enforces, one code each:

| Rule | Code |
|---|---|
| the H2 set is exactly `STATE · Invariants · Pointers · Resume protocol`; no `### ` heading | `state-drift` |
| §STATE is exactly the four lines, in that order; every index line ≤160 characters | `state-shape` |
| preamble ≤2 `>` lines · §Invariants ≤8 bullets · §Pointers ≤12 `|` rows · §Resume ≤3 commands | `section-over-bound` |
| the whole file ≤80 lines and ≤8 KB | `over-budget` |
| every `handoff/*.md` page is linked from §Pointers, and every linked page exists | `unindexed-page` / `dead-link` |
| `#<n> (open|closed|merged)` matches the board; a backticked sha is on `dev`; a `## Pointers` target exists | `issue-state-drift` / `sha-not-ancestor` / `path-missing` |
| no bare count in prose, even inside a blockquote (units: files · tests · lines · modules · ADRs · issues · commands · dispatches · spawns) | `unattributed-count` |
| exactly one `Next action:` line, citing `#<n>` in the state `(open)` | `next-action-ambiguous` / `next-action-issue-missing` / `next-action-state-missing` |
| the index's `Verified:` is an ancestor of HEAD, and nothing on `dev` after it touches a non-handoff path | `verified-not-ancestor` / `verified-drift` / `verified-missing` |

The `Index:` line carries the **verify-before-acting** instruction, so a session that sees only the
injected §STATE still knows to run the verifier first. `§STATE` ≤ 2,000 bytes is the measured receipt.

## The pages — `.development/handoff/`

- **`state.md`** — one `## STATE` section in the grammar `parseClaims` has always read, and **no
  `Verified:` line** (the index owns it; a second copy is a second source):

  ```
  ## STATE
  - **dev** @ `<sha>` — one clause on what that sha is
  - **Running install:** … `dev @ <sha>` … (or `this repo`, or a real path)
  - **Board:** Open: #…, #…
  - **Suite:** <n> files / **<m>** (<p> passed, <q> failed, <r> skipped) captured at `<sha>`;
    docs guards current (**<n> modules**, **<n> ADRs**). Sizes: `name.ts` <n>; `name.mjs` <n>; …
  ## Open items
  - what is genuinely open
  ```

  Every one of those is a claim the page pass recomputes: `dev-sha-drift`, `install-missing`,
  `install-sha-drift`, `open-set-drift`, `suite-count-drift`, `suite-red`, `modules-drift`,
  `adrs-drift`, `file-missing`, `file-size-drift` — plus `*-claim-missing` when a claim vanishes. The
  page also keeps one structural guard: a duplicated `## STATE` is `state-drift` (#579).
- **`invariants.md`** — the full invariant list, one reason each, sourced. The index summarises; this
  page explains, so a rule dropped from the index can still be found before it is dropped again.

A page is added by writing it and linking it from §Pointers: the completeness check reads the
`handoff/*.md` directory, so a page nobody indexed is `unindexed-page`, and a link to a page nobody
wrote is `dead-link`.

## Write rules

1. **§STATE is REPLACED at each handover — never appended.** No "previous state" subsections, no
   changelog inside §STATE, no second `## STATE`.
2. **§Pointers are links only.** A pointer is a promise the target exists; content belongs in the page.
3. **A count lives in the page, never in the index.** The index carries no totals at all — the suite
   total is the claim that ages fastest, and the verifier refuses any count it finds in prose.
4. **Every claim carries a verify command or is marked unverified.** The page's claims are recomputed;
   prose in a page that is not a claim is not checked.
5. **Absolute dates** (`2026-10-17`), not "yesterday" or "last week".
6. **No unprompted release.** `## STATE` never proposes a version. The next action says *"release on
   the maintainer's go"* or names the release as the maintainer's call; a version number appears only
   after the maintainer has asked for one or a defect forced it.

## Mechanical claims — run the checker

```
node scripts/suite-report.mjs --capture             # run the suite into <root>/reports/<head>.json + provenance
node scripts/handoff-verify.mjs                     # two passes: index, then page. 0 · 1 drift · 2 cannot check
node scripts/handoff-verify.mjs --report <json>     # pin the suite report (default: <root>/reports — one per head)
node scripts/handoff-verify.mjs --report-dir <dir>  # scan another directory (two candidates = a refusal)
node scripts/handoff-verify.mjs --issues <json>     # pin the board (`gh issue list --json number`) — no network
node scripts/handoff-verify.mjs --no-network        # skip the gh lookups, and print that it skipped
node scripts/handoff-verify.mjs --root <path>       # evaluate ANOTHER checkout's handoff against its own git
```

`<root>` is `~/.cache/brl-subagent`, the private root of #512. The report is read through
`scripts/lib/suite-report.mjs` (#513): the test count is DERIVED from `assertionResults`, a hollow
report is refused by name, and the count line carries the report's provenance (its head,
`unattributed (dirty tree)`, or `provenance: absent`). The report that proves a page's `Suite:` line is
the one captured at the head the **index's** `Verified:` names (#520).

**Exit 2 is "cannot check", never "holds".** No report, no `dev` ref, no `gh`, an injected board that
cannot answer a `(closed)` claim, a bad flag, and since #607 a **missing page** (`state-page-missing`).
A drift is exit 1 and means the CLAIM is wrong — fix the claim, never the script.

**Out of scope by design — the meaning of the prose.** The index is checked for shape, size, set
relations, citation liveness and counts; a page is checked for the claims it states. Nothing here
judges whether a sentence is wise. The old scope sentence named narrative claims (`### Next actions`,
the `Since` bullets); #607 removed those sections, so the residual is stated instead.

## The `Verified:` protocol

- The line is `Verified: <sha> (<date>)` as the **first line inside the index's `## STATE`**. It lives
  **once** (#607 D3): a page that repeats it is a second source for one sha.
- `<sha>` is the **dev HEAD the snapshot describes** — short (7) or full, either parses. The extension
  compares it to `git rev-parse HEAD` in the cockpit and prints `matches HEAD`, `RECONCILE …` or
  `no Verified: line`.
- **The handoff's own commit is not drift.** `Verified:` can never name the commit that writes it — so
  the extension resolves the range `Verified..HEAD` and reports `matches HEAD (ignoring the handoff's own
  commit)` when **every** commit in it touches only `.development/HANDOFF.md`, its archives, or a page
  under `.development/handoff/`. One commit touching anything else → `RECONCILE`. A `Verified:` that is
  not an ancestor of HEAD is drift too — rebase, amend, another branch.
- Update it at **every handover** and when the STATE materially changes (a merge, a release, a state
  change the file now describes). After a merge, re-mark with the merge sha: a merge commit touches
  paths outside the handoff, so the old sha reads as drift — that is the rule working.
- `/handoff mark` rewrites the sha to HEAD for you — it does **not** reconcile the content or the
  pages. Marking a stale snapshot as current is a false claim.
- The ignore list is exactly the index, its archives and its pages. A doc-only commit elsewhere (an
  investigation, a CHANGELOG entry) still `RECONCILE`s — re-mark if it changed what §STATE describes.

## Pre-compaction checklist

Run this before any compaction (manual `/compact` or the context threshold):

1. **Rewrite §STATE** — the tree, what is in flight, the one next action, the index line.
2. **Update the page** — the mechanical snapshot, and `Verified:` in the index (`/handoff mark`).
3. **Run `node scripts/handoff-verify.mjs`** — exit 0 before the commit; a drift is a claim to fix
   (`dev-sha-drift`, `over-budget`, `next-action-ambiguous`, …), and exit 2 is a capture to take.
4. **Prune §Pointers and the page's `## Open items`** — drop what closed, keep what is live.
5. **Move history out** — anything narrative goes to git / `investigations/` / the archive.

The extension has no `session_before_compact` hook by design: pi-vcc owns that event and the runner
keeps the last non-null result, so cancelling could interfere or loop. The checklist is the write-side
discipline; the injection is the read-side trigger.

**Fallback without the extension.** In a checkout where the project extension is not loaded (no project
trust, another machine), read §STATE manually at session start and run the resume protocol. An
`AGENTS.md` pointer is deliberately NOT used: it would be a second, unversioned copy of the trigger, and
it does not re-fire after a compaction.

## History rule

Never store in the index or a page:

- session narratives ("we discussed, then tried …"),
- release sections for shipped versions,
- superseded STATE snapshots.

History lives in git history, `.development/investigations/` (specs, evidence, review findings) and the
friction log. When a restructure makes old content redundant, **move it verbatim** to
`.development/HANDOFF-ARCHIVE-<date>.md` with a header saying it is historical and not current state —
never delete it. `.development/HANDOFF-ARCHIVE-2026-11-27.md` is the #607 retirement of the `Since the
last handover` chain.

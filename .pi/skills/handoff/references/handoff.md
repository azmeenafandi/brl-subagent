# Handoff — the full contract

`.development/HANDOFF.md` holds the conductor's current state. It is read by a
fresh session that has none of the conversation's context, and it is re-injected
after every compaction. This reference is the contract for writing it.

## Structure

| Section | Content |
|---|---|
| `# Handoff` | title only (no date in the title — the date lives in `Verified:`) |
| preamble | how to use: read §STATE → run its verify commands → open items → pointers; one line on the injected hook |
| `## STATE` | `Verified: <sha> (<date>)` line, the snapshot, `### Since the last handover`, `### Next actions` |
| `## Open items` | what is genuinely open — board issues, pending decisions, live checks |
| `## Operating notes` | durable, do-not-re-derive knowledge (delivery semantics, dispatch conventions, gate commands) |
| `## Pointers` | where the durable records live — links only, no content |

`## STATE` must be self-contained: a reader who sees only that section can tell
what tree is checked out, what is running, what the board looks like, what cycle
is open, and what is next.

## Write rules

1. **STATE is REPLACED at each handover — never appended.** No "previous state"
   subsections, no changelog inside STATE. `### Since the last handover` is the
   only place a delta belongs, and it is cleared at the next handover.
2. **Open items are pruned.** A closed item leaves the file; only open items and
   short-lived blocked notes stay.
3. **Size budget: the file ≤ ~120 lines, `## STATE` ≤ ~40.** The STATE section is
   injected into every session (and after every compaction) — every line is a
   recurring token cost.
4. **Every STATE claim carries a verify command or is marked unverified.** A
   claim without one is a hypothesis; write `(unverified)` rather than implying
   it was checked. The verify table below is the vocabulary.
5. **Absolute dates** (`2026-10-17`), not "yesterday" or "last week".
6. **No narrative.** What happened belongs in git, `.development/investigations/`
   or the friction log — not in the handoff.
7. **No unprompted release.** `## STATE` never proposes a version. The `### Next actions`
   line says *"release on the maintainer's go"* (or names the release as the maintainer's
   call); a version number appears only after the maintainer has asked for one or a defect
   forced it. This is the durable home of the rule — `HANDOFF.md` is regenerated at every
   handover, so a sentence that lives only there is one rewrite away from being lost.

## Mechanical claims — run the checker

`node scripts/handoff-verify.mjs` diffs §STATE's mechanical claims against the repo and names every
drift. Run it **before** committing the handoff:

```
node scripts/suite-report.mjs --capture             # run the suite into <root>/reports/<head>.json + provenance
node scripts/handoff-verify.mjs                 # exit 0 every claim holds · 1 drift · 2 cannot check
node scripts/handoff-verify.mjs --report <json> # pin the suite report (default: <root>/reports — one per head)
node scripts/handoff-verify.mjs --report-dir <dir> # scan another directory instead (two candidates = a refusal)
node scripts/handoff-verify.mjs --issues <json> # pin the board (`gh issue list --json number`) — no network
node scripts/handoff-verify.mjs --no-network    # skip the gh open-set check, and print that it skipped
```

`<root>` is `~/.cache/brl-subagent`, the private root of #512. The report is read through
`scripts/lib/suite-report.mjs` (#513): the test count is DERIVED from `assertionResults`, so a
report whose results are empty is refused by a named code instead of counted, and the count line
carries the report's provenance — the head it was captured at, `unattributed (dirty tree)`, or
`provenance: absent`. Capture with `--capture` and the default path always has provenance.

It checks seven things: the `Verified:` range (an ancestor of HEAD, and every commit on `dev` after it
touching only the handoff and its archives), the `dev @ <sha>` line, the `Running install:` path and its
sha, the `Open:` issue set against `gh issue list --state open`, the `Suite:` counts against a vitest JSON
report, the `modules`/`ADRs` counts against `docs-arch`/`docs-decisions`, and every `` `name.ts` <n> ``
line count against `wc -l`. A single-value claim (`dev`, `modules`, `ADRs`) stated twice is checked twice:
agreeing duplicates are one claim, a disagreeing one is a named drift.

**Out of scope by design — narrative claims.** The cycle queue, `### Next actions` and the
`### Since the last handover` bullets are *not* checked, and the checker prints that scope with every
verdict. They are prose, and the only mechanical reading of them is a guess at which queue item is
"current" — a heuristic there would fail closed on a legitimate rewrite, which is a worse trade than a
human reading three lines. The stale `Next: U6` after U6 had merged was the third drift found in the wild;
it is closed by reading the queue, not by a check.

**A drift means the claim is wrong — fix the claim, never the script.** The checker reads the shapes
above and nothing else: prose, `### Since the last handover` history (`2,006 → 353`) and a quoted field
name ("the `Open:` list") are not claims, so a false positive is a bug in the checker, not a reason to
loosen it. It is deliberately **not in CI**: it needs `gh` and the local install, and §STATE is this
machine's state, not the repo's.

## The `Verified:` protocol

- The line is `Verified: <sha> (<date>)` as the **first line inside `## STATE`**.
- `<sha>` is the **dev HEAD the snapshot describes** — short (7) or full, either
  parses. The extension compares it to `git rev-parse HEAD` in the cockpit and
  prints `matches HEAD`, `RECONCILE …` or `no Verified: line`.
- **The handoff's own commit is not drift.** `Verified:` can never name the commit
  that writes it — that commit moves HEAD by one — so the extension resolves the
  range `Verified..HEAD` and reports `matches HEAD (ignoring the handoff's own
  commit)` when **every** commit in that range touches only
  `.development/HANDOFF.md` and/or `.development/HANDOFF-ARCHIVE-*.md`. One commit
  touching anything else → `RECONCILE` (interleaved ranges are real drift). A
  `Verified:` that is not an ancestor of HEAD is drift too — rebase, amend, another
  branch — and always `RECONCILE`s.
- Update it at **every handover** and **whenever the STATE materially changes**
  (a merge, a release, a state change that the file now describes).
- `/handoff mark` rewrites the sha to HEAD for you — it does **not** reconcile
  the content. Marking a stale snapshot as current is a false claim.
- The ignore list is exactly the handoff and its archives. A doc-only commit
  elsewhere (an investigation, a CHANGELOG entry) still `RECONCILE`s — re-mark if
  it changed what `§STATE` describes, and tolerate the banner as noise if not.

## Pre-compaction checklist

Run this before any compaction (manual `/compact` or the context threshold):

1. **Rewrite `## STATE`** — tree, running install, board, cycle, in-flight work.
2. **Update `Verified:`** to the dev HEAD being described (`/handoff mark`).
3. **Run `node scripts/handoff-verify.mjs`** — exit 0 before the commit; a drift is a claim to fix (the
   checker's names are the code: `dev-sha-drift`, `open-set-drift`, `suite-count-drift`, …).
4. **Prune `## Open items`** — drop what closed, keep what is live.
5. **Confirm `## Pointers`** — every linked file still exists.
6. **Move history out** — anything narrative goes to git/investigations/archive.

The extension has no `session_before_compact` hook by design: pi-vcc owns that
event and the runner keeps the last non-null result, so cancelling could
interfere or loop. The checklist is the write-side discipline; the injection is
the read-side trigger.

**Fallback without the extension.** In a checkout where the project extension is
not loaded (no project trust, another machine), read §STATE manually at session
start. An `AGENTS.md` pointer is deliberately NOT used: it would be a second,
unversioned copy of the trigger, and it does not re-fire after a compaction.

## History rule

Never store in the handoff:

- session narratives ("we discussed, then tried …"),
- release sections for shipped versions,
- superseded STATE snapshots.

History lives in git history, `.development/investigations/` (specs, evidence,
review findings) and the friction log. When a restructure makes old content
redundant, **move it verbatim** to `.development/HANDOFF-ARCHIVE-<date>.md` with
a header saying it is historical and not current state — never delete it.

## Verify-command table

| Claim | Command |
|---|---|
| tips | `git log -1 --oneline dev` (`git log -1 --oneline main`) |
| install | `pi list` |
| board | `gh issue list` |
| STATE's mechanical claims | `node scripts/handoff-verify.mjs` (all seven checks, exit 1 on drift) |
| release | `gh release list` (and `git tag --list \| tail -3`) |
| deps | `cat package.json` — the `@earendil-works/*` pins + `typebox` (held at the pi host pin) |
| suite | `npx vitest run` |
| hygiene | `npx tsc --noEmit` · `node scripts/docs-arch.mjs` · `node scripts/docs-decisions.mjs` |

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
3. **Prune `## Open items`** — drop what closed, keep what is live.
4. **Confirm `## Pointers`** — every linked file still exists.
5. **Move history out** — anything narrative goes to git/investigations/archive.

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
| release | `gh release list` (and `git tag --list \| tail -3`) |
| deps | `cat package.json` — the `@earendil-works/*` pins + `typebox` (held at the pi host pin) |
| suite | `npx vitest run` |
| hygiene | `npx tsc --noEmit` · `node scripts/docs-arch.mjs` · `node scripts/docs-decisions.mjs` |

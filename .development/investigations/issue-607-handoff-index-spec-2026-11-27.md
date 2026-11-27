# #607 — the handoff is 62% history; make it an index the next session loads, and pages it opens on demand — spec

**Issue:** #607 (process, owner priority for the next fresh session) · **C2** · worktree **y**.
**jev:** medium (0.66) · C2 · worktree y
**Spec:** 2026-11-27, against `966cd4d` (`dev`). Status: **decision-ready** (pre-critique).

---

## Recon (Rule 13 — codegraph @ `966cd4d`)

```
# unattributedCounts (scripts/lib/pr-evidence.mjs)  — callers: 2 (pr-evidence.test.ts, checkBody :397)
# parseClaims / evaluate (scripts/lib/handoff-claims.mjs) — pure claim grammar + verdict; consumed by handoff-verify.mjs
# extractStateSection ( .pi/extensions/handoff/lib.ts ) — the injection seam; needs `## STATE` + a `Verified:` line only
# resolveReport (scripts/lib/suite-report.mjs) — the suite-count source (#513), keyed by the handoff's Verified sha
```

**Recon verification.** V1 `parseClaims` reads the whole `## STATE` section and derives every mechanical claim
from it (`scripts/lib/handoff-claims.mjs`); the seven checks are `evaluate()`. V2 `unattributedCounts`
(`pr-evidence.mjs:276`) is the exact "count outside a block" pattern #607 names — `COUNT_RE =
(?<![\w.])[\d][\d,]*[ \t]+(?:[\w'-]+[ \t]+){0,2}(?:files?|tests?|lines?)\b`, fence-skipping, blockquote-skipping.
V3 the extension only depends on `## STATE` (heading, tolerating a `(qualifier)`) and the `Verified:` line
(`lib.ts:40,46`) — it ends §STATE at the **next** `## ` heading, so adding `## Invariants` after `## STATE` is
compatible. V4 the existing structure check (check 0) mandates `## STATE` and `## Open items` each exactly once;
the new index removes `## Open items`, so check 0's mandatory set must change. V5 `handoff-verify.mjs` reads one
file (`--file`, default `.development/HANDOFF.md`) and passes its §STATE to `parseClaims`; a second read (the
state page) is a new seam. V6 `evaluate()` takes `claims` + a `probe` and returns `{results, drifts}`; new checks
are new `check*` functions appended in fixed order plus their probe facts.

**Grep delta.** `grep -rn "unattributedCounts" scripts` → 2 hits (the lib + one test import) — the reuse point is
one exported function. `grep -rn "## STATE\|Open items" .pi/extensions/handoff/lib.ts` → the extension mentions
only `STATE`; `Open items` is not an extension dependency. `grep -c "Open items" scripts/lib/handoff-claims.mjs` →
1 (the `MANDATORY_HEADINGS` constant) — the only place the old heading is load-bearing.

---

## Context — measured, not asserted

`.development/HANDOFF.md` is 214 lines / 50,502 b (~13k tokens). The issue's measurement: `## STATE` 8,603 b
(17%), `### Since the last handover` 31,155 b (62%, unactionable history), `### Next actions` 3,345 b (7%),
operating notes 7%, open items/pointers 5%. A fresh session loads all of it to reach the ≈5 KB that decides what
to do. Seven `HANDOFF-ARCHIVE-*` files already exist; the chain keeps growing anyway. In one evening it needed
three corrections (a placeholder the close made false, a `dev` sha that moved, an `Open:` set missing two issues)
— each caught by `handoff-verify` or by hand, never by the artifact.

**The decision a fresh session needs, ranked (from the issue):** Verified · In flight · Next action · Invariants ·
Pointers · Resume protocol. Everything else is history or verification detail.

---

## Decision — `HANDOFF.md` becomes a lean index; the mechanical claims move to a page; five checks are added

### 1. The index (`HANDOFF.md`) — ≤80 lines AND ≤8 KB

```
# Handoff

> Read §STATE → run the 3 resume commands → open the pages you need.
> History: `.development/HANDOFF-ARCHIVE-*` and `.development/FRICTION_LOG.md` — never re-read it.

## STATE
Verified: <sha> (<date>)
In flight: nothing
Next action: #607 (open) — redesign the handoff as an index

## Invariants
- (f) reads the provenance ledger; the recheck line is *resolved*, never typed
- `.pi/jev-lines.log` is gitignored — never copy it into the repo
- code changes go through a worktree; merge commits, never squash
- bank every dispatch to `bank/<label>.md`; push the handoff commit same turn

## Pointers
| Page | Holds |
|---|---|
| [state](handoff/state.md) | the mechanical state: dev, install, board, suite, sizes |
| [invariants](handoff/invariants.md) | the full invariant list, each with its reason |

## Resume protocol
node scripts/handoff-verify.mjs     # 0 drift
git status --short                  # clean tree
gh issue view <next-action-number>  # the next action
```

**§STATE holds exactly three lines and nothing else** — `Verified:`, `In flight:`, `Next action:`. No `dev @`,
no `Running install:`, no `Open:`, no `Suite:`, no module/ADR/size counts, no cycle history. The `Verified:` sha
is the extension's anchor and check 1's subject; it must stay the **first line inside `## STATE`**. The section
must be followed by `## Invariants` (the next `## ` heading), which is what lets the extension end §STATE there
unchanged.

**The `### Since the last handover` chain is retired, not migrated.** Its current content is archived verbatim
to `.development/HANDOFF-ARCHIVE-2026-11-27.md` (the existing archive convention), and the index carries the one
line above naming where history lives. Nothing else is carried forward into the index.

**Numbers are not prose.** The index may cite a command or a report path, never a count. The mechanical counts
live in the state page, not here.

### 2. The pages (`.development/handoff/`)

Two pages ship in this unit (the minimum resume set; further wiki pages are #606's follow-on, out of scope):

- **`state.md`** — the mechanical claims, in the **exact grammar `parseClaims` already parses**, minus the
  `Verified:` line (the index is authoritative for the sha): `dev @ <sha>`, `Running install: …`, `Open: #…`,
  `Suite: <n> files / <m> tests (<p> passed, <q> failed, <r> skipped)`, `<n> modules`, `<n> ADRs`, and every
  `` `name.ts` <n> `` size line. One claim per line; the same "a drift means fix the claim" contract.
- **`invariants.md`** — the full invariant list with one reason each (the index carries the short list; this page
  carries the "why", sourced to the issue/ADR/sha that established each).

Each page opens with a one-line `Source:` note naming the issue it records state for, and is itself a subject
page — cited in the index's pointer table, never pasted into it.

### 3. `handoff-verify.mjs` — relocation + five new checks

**Relocation.** Checks 2–7 (dev, install, open, suite, modules/adrs, sizes) now read **`handoff/state.md`** — the
file discovered at `<dir-of-the-index>/handoff/state.md` — instead of the index's §STATE. Check 1 (`Verified:`
ancestor + no non-handoff commit after it) still reads the index's §STATE. The `Verified:` sha is the
`expectHead` the suite check (5) passes to the report resolver. The state page's absence is an exit-2 usage
fault, not drift (`state-page-missing`), because there is nothing to check.

**Check 0 (structure) changes.** Mandatory headings become `## STATE`, `## Invariants`, `## Pointers`,
`## Resume protocol` (each exactly once); `## Open items` leaves the mandatory set. The existing duplicate-H2
rule (any other H2 repeated → `state-drift`) is unchanged.

**The five new checks** (all fail loudly with the named reason; all outside fenced code blocks):

1. **budget** — the index file is over 80 lines **or** over 8,192 UTF-8 bytes → `over-budget` (one drift naming
   both measured values).
2. **index completeness** — pages are `*.md` directly under `<index-dir>/handoff/`; listed pages are the markdown
   link targets (`[...](target)`) inside `## Pointers` whose target ends in `.md` and resolves inside `handoff/`.
   A page file not listed → `unindexed-page`; a listed page whose file is absent → `dead-link`. (Normalised by
   path relative to `handoff/`.)
3. **citation liveness** — inside `## Pointers`, three kinds are cited and verified:
   - an issue/PR ref `#<n>` immediately followed by `(open)` or `(closed)` must match `gh issue view <n>`'s state
     → else `issue-state-drift` (skipped under `--no-network`, printed as a skip; `--issues <json>` supplies the
     open set so `(open)` resolves offline and `(closed)` is refused as unanswerable);
   - a backticked `7–40`-hex sha must be an ancestor of `dev` → else `sha-not-ancestor`;
   - a path (a markdown link target, or a backticked token containing `/` and ending in a known extension) must
     exist → else `path-missing`.
4. **no counts in prose** — reuse `pr-evidence`'s `unattributedCounts` (the `COUNT_RE` unit detector + fence and
   blockquote skipping) over the **index**, with the unit list extended to `files?|tests?|lines?|modules?|ADRs?`
   → `unattributed-count` (one finding per line, carrying line number + the token that tripped).
5. **one next action** — exactly one `Next action:` line at line-start inside `## STATE`; zero or more than one
   → `next-action-ambiguous`. (The line naming `#<n>` is a documented writer rule, not a check.)

The check order stays fixed (structure → budget → completeness → liveness → no-counts → next-action → the seven
mechanical checks), so two runs print the same bytes.

### 4. The extension is untouched

`.pi/extensions/handoff/` reads `## STATE` and `Verified:` only (V3); both are preserved, and §STATE now ends at
`## Invariants`. No extension change; `handoff.test.cjs` must stay green unchanged.

---

## Sub-decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Where the mechanical claims live | a page `handoff/state.md`, discovered at `<dir-of-index>/handoff/state.md` (no new flag) | the index must carry no counts (#607); a derived path cannot drift from the index it describes |
| D2 | What §STATE keeps | `Verified:` + `In flight:` + `Next action:` only | the ranked list's first three, the extension's minimum, the falsifier's target |
| D3 | The page grammar | the existing `parseClaims` shapes, minus `Verified:` | move-not-rewrite; the seven checks keep their drift codes |
| D4 | `Verified:` lives once | in the index §STATE; the state page does not repeat it | one authoritative sha; the suite check takes it as `expectHead` from the index |
| D5 | `--no-network` + liveness | `(open)` resolves from `--issues`; `(closed)` is exit-2 unanswerable; shas/paths resolve without network | shas and paths are local git/fs facts; issue state is the only network fact |
| D6 | The retired chain | archived to `HANDOFF-ARCHIVE-2026-11-27.md` verbatim, never migrated | the issue: "retired, not migrated" |
| D7 | budget measures the index only | lines (`\n` split) and UTF-8 bytes | the pages are opened on demand, not injected; only the index is the per-session tax |
| D8 | `no counts` applies to the index only | the state page carries the counts checks 2–7 verify | the page is the mechanical-claims document; the index is the index |
| D9 | new drift codes | `over-budget` · `unindexed-page` · `dead-link` · `issue-state-drift` · `sha-not-ancestor` · `path-missing` · `unattributed-count` · `next-action-ambiguous` · `state-page-missing` | each seeded violation names one; a human can fix without parsing prose |

## Blast radius

- `scripts/lib/handoff-claims.mjs` — add the index parse (`parseIndex`), the five check functions, the new
  structure set; the mechanical `parseClaims` is unchanged but consumed with a state-page source.
- `scripts/handoff-verify.mjs` — read the index **and** the derived state page; pass both to `evaluate`; print the
  new scope line.
- `scripts/__tests__/handoff-verify.test.ts` — fixtures for every new drift code + the relocation (the existing
  "correct.md" fixture becomes a correct **index**; a new `correct-state.md` fixture holds the mechanical claims).
- `.development/HANDOFF.md` (rewritten), `.development/handoff/state.md`, `.development/handoff/invariants.md`
  (new), `.development/HANDOFF-ARCHIVE-2026-11-27.md` (new, verbatim history).
- `.pi/skills/handoff/SKILL.md` and `references/handoff.md` — restated for the index structure, the budget, the
  page convention and the five checks.
- `.pi/extensions/handoff/` — **no change** (V3); `handoff.test.cjs` must stay green unchanged.

## Acceptance (what would prove it wrong)

1. A fresh session, given only this repo, reaches the correct next action in **≤3 commands and ≤10k tokens** of
   reading, with no clarifying question (the issue's falsifier).
2. Each seeded violation turns the check red **before** the session trusts the index: (a) 20 lines of history
   pasted back into the index → `over-budget` (or `unattributed-count`); (b) a page file omitted from the pointer
   table → `unindexed-page`; (c) a listed page whose file is missing → `dead-link`; (d) a stale sha in `## Pointers`
   → `sha-not-ancestor`; (e) a second `Next action:` line → `next-action-ambiguous`; (f) a bare `Suite: 150 files`
   outside a fence in the index → `unattributed-count`.
3. The seven mechanical checks still pass when the claims are in `state.md`, and each existing drift code
   (`dev-sha-drift`, `suite-count-drift`, …) is still reachable from a fixture against the page.
4. `node scripts/handoff-verify.mjs` exits 0 on the shipped index + page, and the extension's `handoff.test.cjs`
   passes unchanged.
5. The current `HANDOFF.md` is ≤80 lines and ≤8 KB, and its `### Since the last handover` chain is gone.

## Evidence / mutants (to be measured by the implementer)

| # | What is pinned | Expected red |
|---|---|---|
| M1 | the budget check's `<= 80` and `<= 8192` | an 81-line or 8,193-byte index → `over-budget` |
| M2 | completeness: a page file added but not listed | `unindexed-page` |
| M3 | completeness: a listed page deleted | `dead-link` |
| M4 | liveness: a sha in `## Pointers` not on `dev` | `sha-not-ancestor` |
| M5 | liveness: an issue ref `#<n> (closed)` for an open issue | `issue-state-drift` |
| M6 | liveness: a listed path that is absent | `path-missing` |
| M7 | no-counts: a fenced count passes, an unfenced count drifts | `unattributed-count` |
| M8 | next-action: zero and two `Next action:` lines | `next-action-ambiguous` |

The existing suite (3417) stays green; the new test additions are fixtures only (no production behaviour change
outside `handoff-verify` and the two docs). `npx tsc --noEmit` clean (no `src/` change).

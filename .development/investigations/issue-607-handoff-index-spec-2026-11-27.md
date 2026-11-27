# #607 — the handoff is 62% history; make it an index the next session loads, and pages it opens on demand — spec **r5**

**Issue:** #607 (process, owner priority) · **C2** · worktree **y**.
**jev:** medium (0.66) · C2 · worktree y
**Spec r5:** 2026-11-27, against `484c79f` (`dev`). **Status: decision-ready** after four critique rounds
(10 · 4+1 · 4 · 5 majors — all answered below).

---

## r4 → r5 changes (the fourth critique's five majors, each measured and answered)

| # | r4 gap (measured by `crit-607-r4`) | r5 answer |
|---|---|---|
| 1 (major) | A leading `|` doesn't bound content: 20 events packed into one 603-byte table line pass the form+bound. | Every index **line ≤ 160 chars** (`state-shape` if over). The "no history" guarantee is the conjunction of shape rules + no-counts + citation-liveness + budget; count-free narrative packed inside a short line is the stated residual. |
| 2 (major) | "Exit 2 only when no report exists" contradicts the resolver: invalid/mismatched reports and a bad flag also refuse. | Exit 2 is "**cannot check**", enumerated: no report · `provenance-mismatch` · `empty-results` · invalid report · bad flag · missing page. Each refusal mode is a fixture. |
| 3 (major) | "The verifier reports page drift until re-captured" is false: report refusal aborts **before** accumulated drifts print. | Corrected: after `/handoff mark`, `handoff-verify` exits 2 (report refusal) naming the capture command — the reconcile order is **re-capture the suite first, then the page's `dev @`/sizes drifts surface**. |
| 4 (major) | Requiring only `#<n>` lets a closed next action pass (no `(state)` to check). | The `Next action:` line must cite `#<n> (open|closed|merged)`; missing number → `next-action-issue-missing`, missing state → `next-action-state-missing`; a closed action → liveness `issue-state-drift`. |
| 5 (major) | The example cites a wildcard archive path and a gitignored log, but the rule says cited paths exist. | **Path liveness is scoped to markdown link targets `](...)` in `## Pointers` only** — prose backticks, globs and gitignored paths are illustrative, never checked. |

---

## r3 → r4 · r2 → r3 · r1 → r2 changes (kept for the record)

- **r3→r4:** section line-bounds + form; evidence commands + separate fence/blockquote mutants; mark→reconcile documented; suite acceptance corrected to the resolver's `provenance: absent` degrade.
- **r2→r3:** section bounds (now line+form); page drops `Verified:`; no-counts widened; non-blank-line counting.
- **r1→r2:** `isHandoffOwnPath` extends to `.development/handoff/*.md` in both consumers; the page is a `## STATE` in the exact grammar; `## STATE` gains `Index:`; citation states `(open|closed|merged)`; `VERIFY_COMMANDS` updated; 7 fixtures + 3 live reads named.

---

## Recon (Rule 13 — codegraph @ `484c79f`)

```
# parseClaims / evaluate (scripts/lib/handoff-claims.mjs) — pure claim grammar + verdict
# unattributedCounts (scripts/lib/pr-evidence.mjs) — no-counts reuse point
# extractStateSection / isHandoffOwnCommit / VERIFY_COMMANDS / replaceVerified ( .pi/extensions/handoff/lib.ts )
# resolveReport (scripts/lib/suite-report.mjs) — provenance rules: match→accepted · mismatch→refused · no sidecar→`provenance: absent` · empty-results→refused
```

**Recon verification.** V1 `parseClaims` needs a `## STATE` + bullet `dev @`. V2 `isHandoffOwnPath` (both
files) extends to `.development/handoff/*.md`. V3 the extension injects §STATE only; `replaceVerified` rewrites
the index only. V4 `resolveReport` refusal modes (lines 35–69): `provenance-mismatch` (wrong sidecar),
`provenance-unreadable`, `empty-results` (invalid report), `count-mismatch` — all throw `InputError` → exit 2.
V5 `checkSuite` throws before `evaluate` returns, so a report refusal aborts before other drifts print — the
existing "cannot check" order, documented not changed. V6 check 0 mandates `STATE`+`Open items`; replaced.

**Grep delta.** `grep -rn "isHandoffOwnPath\|HANDOFF_OWN" .pi/extensions scripts/lib` → 2 definitions.
`git ls-files 'scripts/__tests__/fixtures/handoffs/*.md'` → 7 fixtures. `rg -n 'readFileSync\(join\(ROOT, "\.development", "HANDOFF.md"' scripts/__tests__/handoff-verify.test.ts` → 3 live reads.

---

## Decision — index + state page, two passes, a section-bounded shape, and precise exit semantics

### 1. The index (`HANDOFF.md`) — ≤80 lines AND ≤8 KB, flat, no history, no counts

```
# Handoff

> Read §STATE → run the resume commands → open the pages you need.
> History: `.development/HANDOFF-ARCHIVE-*` and `.development/FRICTION_LOG.md` — never re-read it.

## STATE
Verified: <sha> (<date>)
In flight: nothing
Next action: #607 (open) — redesign the handoff as an index
Index: .development/HANDOFF.md (Invariants · Pointers · Resume protocol) → handoff/state.md, handoff/invariants.md

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
node scripts/handoff-verify.mjs     # 0 drift (or exit 2: capture the suite report first)
git status --short                  # clean tree
gh issue view <next-action-number>  # the next action
```

**§STATE has exactly four non-blank lines, in order** — `Verified:`, `In flight:`, `Next action: #<n> (state)`,
`Index:`. The `Next action:` line must cite `#<n> (open|closed|merged)` (a checkable state).

**The index shape** (the mechanical "no history" guarantee — each rule fails with a named code):

| Rule | Code |
|---|---|
| H2 set == exactly `{STATE, Invariants, Pointers, Resume protocol}`; no H3 | `state-drift` |
| §STATE == the four named lines in order | `state-shape` |
| preamble ≤ 2 lines, each `>`; `## Invariants` ≤ 8 `- ` lines; `## Pointers` ≤ 12 `|` lines; `## Resume protocol` ≤ 3 command lines | `section-over-bound` (count) / `state-shape` (form) |
| every index line ≤ 160 chars | `state-shape` |
| no bare count outside a fence (units below, blockquotes **not** skipped) | `unattributed-count` |

The `### Since the last handover` chain is archived verbatim to `.development/HANDOFF-ARCHIVE-2026-11-27.md`.
**Residual, stated:** count-free narrative packed into a single short line within every bound is not detected —
the conjunction of the rules above is the guarantee; a human reading one line sees it.

### 2. The pages (`.development/handoff/`)

- **`state.md`** — a `## STATE` section, the exact existing grammar, **no `Verified:`**: `- **dev** @ \`<sha>\``,
  `Running install: …`, `Open: #…`, `Suite: <n> files / <m> tests (<p> passed, <q> failed, <r> skipped)`,
  `<n> modules`, `<n> ADRs`, each `` `name.ts` <n> `` size line. `parseClaims` unchanged.
- **`invariants.md`** — the full invariant list, one reason each, sourced to the issue/ADR/sha.

### 3. `handoff-verify.mjs` — two passes + the five new checks

**Pass A (the index).** `parseIndex` extracts headings, the §STATE lines, the pointer-table links, citations,
and raw text. Checks, in fixed order:

0. **structure / shape** — the rules in the table above (`state-drift` / `state-shape` / `section-over-bound`).
1. **verified** — the index's `Verified:` is an ancestor of HEAD with no non-handoff commit after it.
2. **budget** — >80 lines or >8,192 UTF-8 bytes → `over-budget`.
3. **index completeness** — pages vs `## Pointers` link targets (`unindexed-page` / `dead-link`).
4. **citation liveness** — over the whole index, outside fences:
   - `#<n> (open|closed|merged)` → `gh issue view <n> --json number,state` matches → else `issue-state-drift`
     (`--no-network` skips; `--issues` resolves `(open)` only, `(closed|merged)` exit-2 unanswerable);
   - a backticked `7–40`-hex sha (excluding `Verified:`) → ancestor of `dev` → else `sha-not-ancestor`;
   - a **markdown link target `](...)` inside `## Pointers`** → exists → else `path-missing` (prose backticks,
     globs and gitignored paths are never checked).
5. **no counts in prose** — fence-skipping, blockquote-**not**-skipping, units
   `files?|tests?|lines?|modules?|ADRs?|issues?|commands?|dispatches?|spawns?` → `unattributed-count`.
6. **one next action** — exactly one `Next action:` line (`next-action-ambiguous`) citing `#<n>`
   (`next-action-issue-missing`) **and** `(open|closed|merged)` (`next-action-state-missing`); the state is
   checked by (4).

**Pass B (the state page).** `parseClaims(statePage)` unchanged; checks 2–7 with the existing drift codes;
check 5 (suite) uses the index's `Verified:` as `expectHead`. `--file` names the index; the page is
`<dir-of-index>/handoff/state.md`; a missing page is exit-2 `state-page-missing`.

**Exit semantics, stated exactly.** 0 = every check holds · 1 = a drift (a claim is wrong; fix the claim) ·
2 = **cannot check** — no `dev` ref, no suite report, `provenance-mismatch`, `empty-results`, an invalid
report, a bad flag, or a missing state page. A drift and a cannot-check are never conflated, and a report
refusal aborts before other drifts print (the existing `checkSuite`-throws-first order, documented not changed).

### 4. The extension — two small, load-bearing changes

- **`isHandoffOwnPath`** (`.pi/extensions/handoff/lib.ts`) extends to `.development/handoff/*.md`, in lock-step
  with `handoff-claims.mjs`.
- **`VERIFY_COMMANDS`** (`.pi/extensions/handoff/lib.ts`) updates to the new resume protocol; `handoff.test.cjs`
  pins the sync.

`extractStateSection`, the staleness logic, and `replaceVerified` (`/handoff mark`, index-only) are unchanged.
**Post-mark reconcile, stated:** `mark` rewrites only the index `Verified:`; the next `handoff-verify` exits 2
(report refusal) naming the capture command — re-capture the suite **first**, then the page's `dev @`/sizes
drifts surface. The extension banner may call the index "current" while the page is unreconciled; the verifier
is the authority, not the banner.

---

## Sub-decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Mechanical claims live in `handoff/state.md` | `## STATE`, existing grammar, no `Verified:` | index carries no counts; `parseClaims` unchanged; mark single-file |
| D2 | §STATE = 4 non-blank lines incl. `Index:` | the four named lines | self-sufficient injection |
| D3 | `Verified:` lives once (index) | page does not repeat it | no mark mismatch |
| D4 | Liveness: state+sha over whole index; **path only `## Pointers` links** | split scope | prose backticks/globs/gitignored are illustrative |
| D5 | Citation states | `(open|closed|merged)` via `gh issue view <n>` | `MERGED` is a real PR state |
| D6 | Offline liveness | `--no-network` skips; `--issues` = open-only | injected list is open issues only |
| D7 | History detection | section line-bounds + forms + **per-line ≤160** + no H3 | mechanical; packed-line case covered; residual stated |
| D8 | no-counts units | `files?|tests?|lines?|modules?|ADRs?|issues?|commands?|dispatches?|spawns?`, blockquotes not skipped | handoff's own units |
| D9 | budget measures the index only | lines + UTF-8 bytes | only the index is the per-session tax |
| D10 | retired chain | archived verbatim | "retired, not migrated" |
| D11 | exit 2 = cannot-check, enumerated | no-report/mismatch/empty/invalid/bad-flag/missing-page | a refusal is never a silent pass |

## Blast radius

- `scripts/lib/handoff-claims.mjs` — `isHandoffOwnPath` + `handoff/*.md`; `parseIndex` + five checks + shape;
  new mandatory headings; `parseClaims` unchanged.
- `scripts/handoff-verify.mjs` — read index + derived page; two passes; `--file`/`--root` unchanged; scope line;
  `state-page-missing` exit 2.
- `scripts/__tests__/handoff-verify.test.ts` + fixtures — migrate all 7 fixtures + 3 live reads; new fixtures for
  every new drift code and every exit-2 refusal; every old code re-reachable against the page.
- `.pi/extensions/handoff/lib.ts` — `isHandoffOwnPath` + `handoff/*.md`; `VERIFY_COMMANDS`; `handoff.test.cjs`.
- `.development/HANDOFF.md` (rewritten), `.development/handoff/state.md` + `invariants.md` (new),
  `.development/HANDOFF-ARCHIVE-2026-11-27.md` (new).
- `.pi/skills/handoff/SKILL.md` + `references/handoff.md` — restated.

## Acceptance (what would prove it wrong)

1. A fresh session reaches the next action in **≤3 commands and ≤10k tokens**, no clarifying question.
2. Each seeded violation turns a named check red: (a) 20 lines of history in §STATE / under `## Invariants` /
   `## Pointers` / as a `### Since` section → `state-shape`/`section-over-bound`/`state-drift`; (b) a page omitted
   → `unindexed-page`; (c) a listed page deleted → `dead-link`; (d) a stale sha → `sha-not-ancestor`; (e) a second
   `Next action:` → `next-action-ambiguous`; a `Next action: #607` without `(state)` → `next-action-state-missing`;
   (f) a bare `Suite: 150 files` or `9 issues` (even blockquoted) → `unattributed-count`.
3. Every existing mechanical drift code is still reachable from a fixture against the page; `parseClaims` is
   byte-unchanged.
4. `node scripts/handoff-verify.mjs` exits 0 on the shipped index+page when a report at the `Verified:` sha
   exists; exit 2 (cannot-check) for each enumerated refusal; reaching the next action needs neither.
   `handoff.test.cjs` passes; a page commit after `Verified:` reads handoff-owned; an unrelated commit drifts.
5. The shipped `HANDOFF.md` is ≤80 lines and ≤8 KB, has no `### ` heading, no bare count, no line >160 chars, no
   `Since the last handover`.

## Evidence (command + assertion · negative control · mutant → killer)

| # | Command + assertion | Negative control | Mutant → killer |
|---|---|---|---|
| E1 | `node scripts/handoff-verify.mjs` (report present) → exit 0 | an 81-line index → `over-budget` | budget `<= 80` → E1 neg |
| E2 | pages listed + present → pass | unlisted → `unindexed-page`; deleted → `dead-link` | completeness set-diff → both negs |
| E3 | a cited sha on `dev` → pass | a sha off `dev` → `sha-not-ancestor` | ancestor check inverted → E3 neg |
| E4 | `#607 (open)` + `gh issue view 607 --json state` = OPEN → pass | `#607 (closed)` → `issue-state-drift`; `#601 (merged)` (PR) → passes | state compare → E4 neg |
| E5 | a `## Pointers` link target exists → pass | a missing link target → `path-missing`; a prose backtick/glob is **not** a citation | `existsSync` inverted → E5 neg |
| E6 | a count in a fence → **pass**; unfenced incl. `> Suite: 150 files` and `9 issues` → `unattributed-count` | `> Suite: 150 files` → drift | fence-skip removed → fenced case drifts; blockquote-skip kept → `>` case drifts (two mutants, two killers) |
| E7 | one `Next action: #<n> (open)` → pass | zero/two → `next-action-ambiguous`; no `#<n>` → `next-action-issue-missing`; no `(state)` → `next-action-state-missing` | count compare → E7 neg |
| E8 | page claims: stale `dev @`/`Suite:`/size → existing codes | each claim mutated → its code | `parseClaims` unchanged, checks relocated |
| E9 | §STATE=4 · Invariants ≤8 · Pointers ≤12 · Resume ≤3 · line ≤160 → pass | 20 paragraph lines under a section → `section-over-bound`; a 603-byte table line → `state-shape` | bound/char constant relaxed → E9 neg |
| E10 | no report → exit 2 "cannot check"; wrong sidecar → exit 2 `provenance-mismatch`; empty results → exit 2 | each refusal enumerated | `checkSuite` throw order unchanged → E10 neg |

Suite counts measured at the implementation head (provisional until captured); `npx tsc --noEmit` clean (no
`src/` change); `npx vitest run` green.

# #607 — the handoff is 62% history; make it an index the next session loads, and pages it opens on demand — spec **r4**

**Issue:** #607 (process, owner priority) · **C2** · worktree **y**.
**jev:** medium (0.66) · C2 · worktree y
**Spec r4:** 2026-11-27, against `69c5cdd` (`dev`). **Status: decision-ready** after three critique rounds
(`crit-607`: 10 majors; `crit-607-r2`: 4+1; `crit-607-r3`: 4 — all answered below).

---

## r3 → r4 changes (the third critique's four majors, each measured and answered)

| # | r3 gap (measured by `crit-607-r3`) | r4 answer |
|---|---|---|
| 1 (major) | Section bounds didn't bound history: `Pointers` was unbounded and `Invariants` bounded bullets, not prose paragraphs (probe: 20 paragraph lines → 36 lines, within every bound). | Every prose-bearing section is **line-bounded AND form-checked**: §STATE = 4 non-blank lines; preamble ≤ 2 `>` lines; `## Invariants` ≤ 8 non-blank `- ` lines; `## Pointers` ≤ 12 non-blank `|` lines; `## Resume protocol` ≤ 3 non-blank command lines. A 20-line paragraph paste fails the form (`state-shape`) or the bound (`section-over-bound`). |
| 2 (major) | Evidence rows lacked runnable commands + measured killers; E6's "fence/quote skip removed" mutant contradicted its own negative control. | §Evidence rewritten: each row names a command + assertion, a negative control, and a mutant with its killer — fence-skip and blockquote-skip are **two separate mutants** with their own kill cases. |
| 3 (major) | `/handoff mark` after a page-only commit changes the index sha but leaves the suite report keyed to the prior sha → `provenance-mismatch`. | Documented as **intended**: `mark` rewrites only the index `Verified:`; reconciling the page (re-capture the suite, update `dev @`/`Suite:`/sizes) is the conductor's step, and `handoff-verify` reports the page drift until it is done (the existing "content is yours to reconcile" contract, now spanning two files). |
| 4 (major) | "Exit 2 without a report at Verified" contradicted the resolver: a sidecar-less report is accepted (`provenance: absent`) for any expected sha. | Acceptance corrected: the suite check's report resolution is **unchanged (#513/#520)** — exit 2 only when no report exists; a sidecar-less report is the documented `provenance: absent` degrade. #607 relocates the `Suite:` claim, it does not touch the resolver. |

---

## r2 → r3 changes (second critique — kept for the record)

| # | r2 gap | r3 answer |
|---|---|---|
| 1 | History under `## Invariants` passed the r2 shape. | section bounds (now line+form, r4). |
| 2 | Duplicating `Verified:` broke `/handoff mark`. | the page carries **no `Verified:`**; mark stays index-only. |
| 3 | "Capture first" records HEAD, not the page sha. | suite dependency pre-existing; relocated not widened. |
| 4 | Unit list let `9 issues`/`3 resume commands` pass. | unit list widened; index example de-counted. |
| 5 | "Exactly four lines" vs blank separators. | non-blank-line counting. |

## r1 → r2 changes (first critique's ten majors — kept for the record)

| # | r1 gap | r2 answer |
|---|---|---|
| 1 | Evidence rows had no commands/killers. | §Evidence rewritten. |
| 2 | `state.md` commit not handoff-owned. | `isHandoffOwnPath` extends in both consumers to `.development/handoff/*.md`. |
| 3 | `parseClaims` needs a `## STATE` + bullet `dev @`. | the page is a `## STATE` in the exact grammar. |
| 4 | "20 lines of history" not implied. | index shape rules (→ section bounds). |
| 5 | PR no-counts detector skips blockquotes. | no-counts does not skip blockquotes. |
| 6 | `Next action:` content/liveness unchecked. | check 5 requires `#<n>`; liveness scans whole index. |
| 7 | PR states include `MERGED`. | citation states `(open|closed|merged)` via `gh issue view <n>`. |
| 8 | "Given only this repo" can't pass suite. | checked vs unavailable; falsifier needs only §STATE + `gh issue view`. |
| 9 | injected §STATE has no pointer. | §STATE gains `Index:`; `VERIFY_COMMANDS` updated. |
| 10 | full fixture/CLI corpus unaccounted. | 7 fixtures + 3 live reads named. |

---

## Recon (Rule 13 — codegraph @ `69c5cdd`)

```
# parseClaims / evaluate (scripts/lib/handoff-claims.mjs) — pure claim grammar + verdict
# unattributedCounts (scripts/lib/pr-evidence.mjs) — the reuse point for no-counts
# extractStateSection / isHandoffOwnCommit / VERIFY_COMMANDS / replaceVerified ( .pi/extensions/handoff/lib.ts )
# resolveReport (scripts/lib/suite-report.mjs) — suite source (#513); provenance rules at lines 35-69
```

**Recon verification.** V1 `parseClaims` reads a whole `## STATE`; `dev @` needs the bullet form. V2
`isHandoffOwnPath` (both files) extends to `.development/handoff/*.md`. V3 the extension injects §STATE only;
`replaceVerified` rewrites `Verified:` in the index only. V4 `resolveReport` provenance: sidecar match → accepted
`head <sha>`; mismatch → refused; **no sidecar → accepted `provenance: absent`**; no report → cannot-check. V5
check 0 mandates `STATE`+`Open items`; replaced.

**Grep delta.** `grep -rn "isHandoffOwnPath\|HANDOFF_OWN" .pi/extensions scripts/lib` → 2 definitions.
`git ls-files 'scripts/__tests__/fixtures/handoffs/*.md'` → 7 fixtures. `rg -n 'readFileSync\(join\(ROOT, "\.development", "HANDOFF.md"' scripts/__tests__/handoff-verify.test.ts` → 3 live reads.

---

## Decision — index + state page, two passes, and a section-bounded, form-checked shape

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

**§STATE has exactly four non-blank lines, in order** — `Verified:`, `In flight:`, `Next action:`, `Index:`.
The `Index:` line makes the injected snapshot self-sufficient. No counts, no history, no `### ` heading.

**Every prose-bearing section is line-bounded AND form-checked** (the mechanical "no history" guarantee):

| Section | Bound (non-blank lines) | Form |
|---|---|---|
| preamble (before `## STATE`) | ≤ 2 | every line starts `>` |
| `## STATE` | = 4 | the four named lines in order |
| `## Invariants` | ≤ 8 | every line starts `- ` |
| `## Pointers` | ≤ 12 | every line starts `|` (a table) |
| `## Resume protocol` | ≤ 3 | every line is a non-heading command |

A line that breaks a section's form is `state-shape`; a section over its bound is `section-over-bound`. The
retired `### Since the last handover` chain is archived verbatim to `.development/HANDOFF-ARCHIVE-2026-11-27.md`.

**Numbers are not prose** — the index cites a command or a report path, never a count.

### 2. The pages (`.development/handoff/`)

- **`state.md`** — a `## STATE` section with the mechanical claims in the exact existing grammar, **no
  `Verified:` line**: `- **dev** @ \`<sha>\``, `Running install: …`, `Open: #…`, `Suite: <n> files / <m> tests
  (<p> passed, <q> failed, <r> skipped)`, `<n> modules`, `<n> ADRs`, and each `` `name.ts` <n> `` size line.
  `parseClaims` is unchanged; its `verified` is `null` here and Pass B never runs check 1.
- **`invariants.md`** — the full invariant list, one reason each, sourced to the issue/ADR/sha.

### 3. `handoff-verify.mjs` — two passes + the five new checks

**Pass A (the index).** `parseIndex` extracts headings, the §STATE lines, the pointer-table links, the citations,
and the raw text. Checks, in fixed order:

0. **structure / shape** — H2 set == exactly `{STATE, Invariants, Pointers, Resume protocol}` (`state-drift`); no
   H3 (`state-drift`); §STATE = the four named lines in order (`state-shape`); each section's form + bound
   (`state-shape` / `section-over-bound`).
1. **verified** — the index's `Verified:` is an ancestor of HEAD with no non-handoff commit after it.
2. **budget** — >80 lines or >8,192 UTF-8 bytes → `over-budget`.
3. **index completeness** — pages vs listed (`unindexed-page` / `dead-link`).
4. **citation liveness** — whole index, outside fences: `#<n> (open|closed|merged)` → `gh issue view <n>` state
   (`issue-state-drift`; `--no-network` skips, `--issues` resolves `(open)` only); a backticked `7–40`-hex sha →
   ancestor of `dev` (`sha-not-ancestor`); a path → exists (`path-missing`).
5. **no counts in prose** — fence-skipping, **not** blockquote-skipping, units
   `files?|tests?|lines?|modules?|ADRs?|issues?|commands?|dispatches?|spawns?` → `unattributed-count`.
6. **one next action** — exactly one `Next action:` line (`next-action-ambiguous`) naming `#<n>`
   (`next-action-issue-missing`); its `(open|closed)` is checked by (4).

**Pass B (the state page).** `parseClaims(statePage)` unchanged; checks 2–7 (dev, install, open, suite,
modules/adrs, sizes) with the existing drift codes; check 5 (suite) uses the index's `Verified:` as `expectHead`.
`--file` names the index; the page is `<dir-of-index>/handoff/state.md`; missing page is exit-2
`state-page-missing`.

### 4. The extension — two small, load-bearing changes

- **`isHandoffOwnPath`** (`.pi/extensions/handoff/lib.ts`) extends to `.development/handoff/*.md`, in lock-step
  with `handoff-claims.mjs`.
- **`VERIFY_COMMANDS`** (`.pi/extensions/handoff/lib.ts`) updates to the new resume protocol; `handoff.test.cjs`
  pins the sync.

`extractStateSection`, the staleness logic, and `replaceVerified` (`/handoff mark`, index-only) are unchanged —
the page carries no `Verified:`, so `mark` stays single-file, and reconciling the page after a mark is the
conductor's step (the verifier reports the page drift until re-captured).

---

## Sub-decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Mechanical claims live in `handoff/state.md` | a `## STATE` in the existing grammar, no `Verified:` | index carries no counts; `parseClaims` unchanged; mark stays single-file |
| D2 | §STATE = exactly 4 non-blank lines incl. `Index:` | the four named lines | self-sufficient injection |
| D3 | `Verified:` lives once (index) | page does not repeat it | no mark mismatch |
| D4 | Liveness scans the whole index | not just Pointers | `Next action: #607 (open)` is a citation |
| D5 | Citation states | `(open|closed|merged)` via `gh issue view <n>` | `MERGED` is a real PR state |
| D6 | Offline liveness | `--no-network` skips; `--issues` = open-only | injected list is open issues only |
| D7 | History detection | **line bounds + form** per section, no H3 | mechanical, catches paragraph pastes |
| D8 | no-counts units | `files?|tests?|lines?|modules?|ADRs?|issues?|commands?|dispatches?|spawns?`, blockquotes not skipped | handoff's own units |
| D9 | budget measures the index only | lines + UTF-8 bytes | only the index is the per-session tax |
| D10 | retired chain | archived verbatim to `HANDOFF-ARCHIVE-2026-11-27.md` | "retired, not migrated" |
| D11 | suite report at a fresh machine | exit 2 only when no report; `provenance: absent` is the existing degrade (#513/#520) | relocated, not widened |

## Blast radius

- `scripts/lib/handoff-claims.mjs` — `isHandoffOwnPath` + `handoff/*.md`; `parseIndex` + five checks + section
  bounds/forms; new mandatory headings; `parseClaims` unchanged.
- `scripts/handoff-verify.mjs` — read index + derived page; two passes; `--file`/`--root` unchanged; scope line;
  `state-page-missing` exit 2.
- `scripts/__tests__/handoff-verify.test.ts` + fixtures — migrate all 7 fixtures + 3 live reads; new fixtures for
  every new drift code; every old code re-reachable against the page.
- `.pi/extensions/handoff/lib.ts` — `isHandoffOwnPath` + `handoff/*.md`; `VERIFY_COMMANDS`; `handoff.test.cjs`.
- `.development/HANDOFF.md` (rewritten), `.development/handoff/state.md` + `invariants.md` (new),
  `.development/HANDOFF-ARCHIVE-2026-11-27.md` (new).
- `.pi/skills/handoff/SKILL.md` + `references/handoff.md` — restated for the index shape, the page convention,
  the budget, and the five checks.

## Acceptance (what would prove it wrong)

1. A fresh session reaches the next action in **≤3 commands and ≤10k tokens**, no clarifying question.
2. Each seeded violation turns a named check red: (a) 20 lines of history in §STATE / under `## Invariants` /
   under `## Pointers` / as a `### Since` section → `state-shape`/`section-over-bound`/`state-drift`; (b) a page
   omitted → `unindexed-page`; (c) a listed page deleted → `dead-link`; (d) a stale sha → `sha-not-ancestor`;
   (e) a second `Next action:` → `next-action-ambiguous`; (f) a bare `Suite: 150 files` or `9 issues` (even
   blockquoted) → `unattributed-count`.
3. Every existing mechanical drift code is still reachable from a fixture against the page; `parseClaims` is
   byte-unchanged.
4. `node scripts/handoff-verify.mjs` exits 0 on the shipped index+page when a report at the `Verified:` sha
   exists; exit 2 only when **no** report exists (a sidecar-less report is the existing `provenance: absent`
   degrade); reaching the next action needs neither. `handoff.test.cjs` passes; a page commit after `Verified:`
   reads handoff-owned; an unrelated commit drifts.
5. The shipped `HANDOFF.md` is ≤80 lines and ≤8 KB, has no `### ` heading, no bare count, no
   `Since the last handover`.

## Evidence (command + assertion · negative control · mutant → killer)

| # | Command + assertion | Negative control | Mutant → killer |
|---|---|---|---|
| E1 | `node scripts/handoff-verify.mjs` (report present) → exit 0 | an 81-line index → `over-budget` | budget `<= 80` → E1 neg |
| E2 | pages listed + present → pass | unlisted page → `unindexed-page`; deleted page → `dead-link` | completeness set-diff → both negs |
| E3 | a cited sha on `dev` → pass | a sha off `dev` → `sha-not-ancestor` | ancestor check inverted → E3 neg |
| E4 | `#607 (open)` + `gh issue view 607 --json state` = OPEN → pass | `#607 (closed)` → `issue-state-drift`; `#601 (merged)` (PR) → passes | state compare → E4 neg |
| E5 | a listed path exists → pass | a missing path → `path-missing` | `existsSync` inverted → E5 neg |
| E6 | a count in a fence → **pass**; unfenced incl. `> Suite: 150 files` and `9 issues` → `unattributed-count` | `> Suite: 150 files` → drift | fence-skip removed → the **fenced** case now drifts; blockquote-skip kept → the `>` case drifts (two mutants, two killers) |
| E7 | one `Next action:` with `#<n>` → pass | zero/two → `next-action-ambiguous`; no `#<n>` → `next-action-issue-missing` | count compare → E7 neg |
| E8 | page claims: stale `dev @`/`Suite:`/size → existing codes | each claim mutated → its code | `parseClaims` unchanged, checks relocated |
| E9 | §STATE=4 · Invariants ≤8 · Pointers ≤12 · Resume ≤3 → pass | 20 paragraph lines under `## Invariants`/`## Pointers` → `section-over-bound` (or `state-shape`) | a bound constant relaxed → E9 neg |

Suite counts measured at the implementation head (provisional until captured); `npx tsc --noEmit` clean (no
`src/` change); `npx vitest run` green.

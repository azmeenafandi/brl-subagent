# #607 — the handoff is 62% history; make it an index the next session loads, and pages it opens on demand — spec **r3**

**Issue:** #607 (process, owner priority for the next fresh session) · **C2** · worktree **y**.
**jev:** medium (0.66) · C2 · worktree y
**Spec r3:** 2026-11-27, against `92ac016` (`dev`). **Status: decision-ready** after two critique rounds
(`crit-607`: 10 majors; `crit-607-r2`: 4 majors + 1 minor — all answered below).

---

## r2 → r3 changes (the second critique's five findings, each measured and answered)

| # | r2 gap (measured by `crit-607-r2`) | r3 answer |
|---|---|---|
| 1 (major) | History pasted **under `## Invariants`** satisfies the r2 shape+budget (probe: 20 `- Prior session did work.` bullets → 48 lines, 1,676 b, 4 H2s, no H3). | The index shape is now **section-bounded**: §STATE = 4 non-blank lines, `## Invariants` ≤ 8 bullets, `## Resume protocol` ≤ 3 lines, preamble ≤ 2 lines → `section-over-bound`. The seeded 20 lines exceed any of them. |
| 2 (major) | Duplicating `Verified:` breaks `/handoff mark` (it rewrites only the index; the page then mismatches). | The state page carries **no `Verified:` line**. `/handoff mark` stays index-only; the page's mechanical claims take the index's `Verified:` sha as the suite report's `expectHead`. |
| 3 (major) | "Capture first" records current HEAD, not the earlier page `Verified:` sha, so a fresh-machine recovery still exits 2. | The suite check's report dependency is **pre-existing (#513/#520), unchanged by #607** — relocated, not widened. Acceptance states: exit 0 with a report at the `Verified:` sha; exit 2 (named reason + capture command) without — and *reaching the next action needs neither*. |
| 4 (major) | The unit allowlist lets `9 issues` and the spec's own `3 resume commands` pass, contrary to "never a count". | Unit list extended to the handoff's own units (`issues?|commands?|dispatches?|spawns?` added); the index example is de-counted ("the resume commands", no bare numerals); the coverage boundary is stated in output. |
| 5 (minor) | "Exactly four lines" contradicted the example's blank separator before `## Invariants`. | The shape counts **non-blank** lines: §STATE's non-blank lines are exactly the four named lines; blank lines are permitted and ignored. |

---

## r1 → r2 changes (first critique's ten majors — kept for the record)

| # | r1 gap | r2 answer |
|---|---|---|
| 1 | Evidence rows had no commands/negative controls/killers. | §Evidence rewritten (commands + assertions + negative controls + mutant killers). |
| 2 | A `state.md` commit is not handoff-only to either consumer. | `isHandoffOwnPath` extends in **both** `handoff-claims.mjs` and `.pi/extensions/handoff/lib.ts` to `.development/handoff/*.md`. |
| 3 | `parseClaims` needs a `## STATE` section and the bullet `dev @`. | The page is a `## STATE` section in the exact existing grammar. |
| 4 | "20 lines of history" not implied by budget/no-counts. | Index shape rules (r2) → now the **section bounds** (r3). |
| 5 | PR no-counts detector skips blockquotes and unit-narrow. | No-counts does **not** skip blockquotes; unit list widened. |
| 6 | `Next action:` content/liveness unchecked. | Check 5 requires `#<n>`; liveness scans the whole index. |
| 7 | PR states include `MERGED`; offline `(closed)` contradiction. | Citation states `(open|closed|merged)` via `gh issue view <n>`; offline rules defined. |
| 8 | "Given only this repo" can't pass the suite check. | Checked vs unavailable distinguished; falsifier needs only §STATE + `gh issue view`. |
| 9 | Injected §STATE has no pointer; extension test pins old table. | §STATE gains `Index:`; `VERIFY_COMMANDS` + `handoff.test.cjs` updated. |
| 10 | Full fixture/CLI corpus not accounted for. | §Blast radius names 7 fixtures + 3 live reads; acceptance requires every old code re-reachable. |

---

## Recon (Rule 13 — codegraph @ `92ac016`)

```
# parseClaims / evaluate (scripts/lib/handoff-claims.mjs) — pure claim grammar + verdict; checks 0-7 in one `evaluate`
# unattributedCounts (scripts/lib/pr-evidence.mjs) — the "count outside a block" pattern #607 names (reuse point)
# extractStateSection / isHandoffOwnCommit / VERIFY_COMMANDS ( .pi/extensions/handoff/lib.ts ) — the injection seam + handoff-owned rule
# replaceVerified ( .pi/extensions/handoff/lib.ts ) — /handoff mark rewrites Verified in the INDEX only
# resolveReport (scripts/lib/suite-report.mjs) — suite source (#513), keyed by the Verified sha; --capture records current HEAD
```

**Recon verification.** V1 `parseClaims` reads a whole `## STATE` section; `dev @` needs the bullet form
(`DEV_RE` = `^[ \t]*[-*][ \t]+\**dev\**…`). V2 `isHandoffOwnPath` (both files) must extend to
`.development/handoff/*.md`. V3 the extension injects `extractStateSection` only; `replaceVerified` rewrites
`Verified:` in the index (§STATE) only — the page must not carry a `Verified:` line to keep `/handoff mark`
single-file. V4 check 0 mandates `STATE`+`Open items`; the new set replaces it. V5 `--capture` records HEAD
(`suite-report.mjs`), and `resolveReport` refuses a report whose head ≠ the expected sha — the suite check's
"unavailable" (exit 2) at a fresh machine is existing behavior, not a #607 change.

**Grep delta.** `grep -rn "isHandoffOwnPath\|HANDOFF_OWN" .pi/extensions scripts/lib` → 2 definitions.
`git ls-files 'scripts/__tests__/fixtures/handoffs/*.md'` → **7** tracked fixtures.
`rg -n 'readFileSync\(join\(ROOT, "\.development", "HANDOFF.md"' scripts/__tests__/handoff-verify.test.ts` →
**3** live-handoff reads. `rg -n 'replaceVerified|mark' .pi/extensions/handoff/` → index-only writer.

---

## Decision — index + state page, two evaluation passes, and a section-bounded shape

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

**§STATE has exactly four non-blank lines, in order** — `Verified:`, `In flight:`, `Next action:`, `Index:`
(blank lines around them are permitted). The `Index:` line makes the injected snapshot self-sufficient. No
counts, no cycle history, **no `### ` sub-heading** — §STATE ends at `## Invariants`.

**The index is section-bounded** (the "no history" guarantee, mechanically): exactly four H2 headings; **no H3
headings**; §STATE = 4 non-blank lines; `## Invariants` ≤ 8 bullets; `## Resume protocol` ≤ 3 lines; the
preamble ≤ 2 lines. The retired `### Since the last handover` chain is archived verbatim to
`.development/HANDOFF-ARCHIVE-2026-11-27.md`, never migrated.

**Numbers are not prose.** The index cites a command or a report path, never a count (the example above carries
no bare count). Counts live in the state page.

### 2. The pages (`.development/handoff/`)

- **`state.md`** — a `## STATE` section carrying the mechanical claims in the **exact existing grammar**, **with
  no `Verified:` line**: `- **dev** @ \`<sha>\``, `Running install: …`, `Open: #…`, `Suite: <n> files /
  <m> tests (<p> passed, <q> failed, <r> skipped)`, `<n> modules`, `<n> ADRs`, and every `` `name.ts` <n> ``
  size line. `parseClaims` is unchanged; its `verified` comes back `null` for the page, and Pass B never runs
  check 1.
- **`invariants.md`** — the full invariant list, one reason each, sourced to the issue/ADR/sha that established
  it. The index carries the short list; this page carries the "why".

### 3. `handoff-verify.mjs` — two passes + the five new checks

**Pass A (the index).** `parseIndex` extracts the headings, the §STATE lines, the pointer-table link targets,
the citations, and the raw text. Checks, in fixed order:

0. **structure / shape** — H2 set == exactly `{STATE, Invariants, Pointers, Resume protocol}` (no extra, no
   repeat → `state-drift`); **no H3 heading** (`state-drift`); §STATE non-blank lines == exactly the four named
   lines in order (`Verified:` first) → else `state-shape`; a bounded section over its limit →
   `section-over-bound` (Invariants > 8 bullets, Resume protocol > 3 lines, preamble > 2 lines).
1. **verified** — the index's `Verified:` is an ancestor of HEAD with no non-handoff commit after it (existing
   check 1, now sourced from `parseIndex`).
2. **budget** — >80 lines or >8,192 UTF-8 bytes → `over-budget` (names both measured values).
3. **index completeness** — pages = `*.md` directly under `<index-dir>/handoff/`; listed = link targets
   `[...](target)` inside `## Pointers` ending in `.md` and resolving inside `handoff/`. Page not listed →
   `unindexed-page`; listed but absent → `dead-link`.
4. **citation liveness** — over the **whole index** (outside fences):
   - `#<n>` immediately followed by `(open|closed|merged)` → `gh issue view <n> --json number,state` must
     match → else `issue-state-drift` (skipped under `--no-network`; `--issues` resolves `(open)` only,
     `(closed|merged)` is exit-2 unanswerable);
   - a backticked `7–40`-hex sha (excluding the `Verified:` line) → ancestor of `dev` → else `sha-not-ancestor`;
   - a path (markdown link target, or backticked token containing `/` ending in a known extension) → exists →
     else `path-missing`.
5. **no counts in prose** — the `unattributedCounts` shape (fence-skipping, **not** blockquote-skipping) with
   the unit list `files?|tests?|lines?|modules?|ADRs?|issues?|commands?|dispatches?|spawns?` →
   `unattributed-count` (line + token). Coverage boundary printed: a count with a unit outside this list is not
   detected.
6. **one next action** — exactly one `Next action:` line → else `next-action-ambiguous`; its text names `#<n>` →
   else `next-action-issue-missing`. The line's `(open|closed)` is checked by (4).

**Pass B (the state page).** `parseClaims(statePage)` unchanged; run checks 2–7 (dev, install, open, suite,
modules/adrs, sizes) with the existing drift codes. Check 0/1 are **not** run on the page; check 5 (suite) uses
the **index's** `Verified:` sha as `expectHead`.

`--file` names the index; the state page is `<dir-of-index>/handoff/state.md`. A missing state page is exit-2
`state-page-missing`. The scope line names what is now out of scope: `In flight:`/`Index:` text and the
`Invariants` bullet list are prose — the five new checks plus the section bounds are the only mechanical reading
of the index.

### 4. The extension — two small, load-bearing changes

- **`isHandoffOwnPath`** (`.pi/extensions/handoff/lib.ts`) extends to `.development/handoff/*.md`, in lock-step
  with `handoff-claims.mjs`: a page commit is the handoff's own, not drift.
- **`VERIFY_COMMANDS`** (`.pi/extensions/handoff/lib.ts`) updates to the new resume protocol; `handoff.test.cjs`
  pins the sync.

`extractStateSection`, the `Verified:` staleness logic, and `replaceVerified` (`/handoff mark`, index-only) are
unchanged — the page carries no `Verified:` line, so `mark` stays single-file.

---

## Sub-decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Mechanical claims live in `handoff/state.md`, derived from the index dir | a `## STATE` section in the existing grammar, **no `Verified:`** | index carries no counts; `parseClaims` unchanged; `/handoff mark` stays single-file |
| D2 | §STATE = exactly 4 non-blank lines incl. `Index:` | `Verified` · `In flight` · `Next action` · `Index` | the injected snapshot is self-sufficient |
| D3 | `Verified:` lives **once**, in the index | the page does not repeat it | one authoritative sha; no `/handoff mark` mismatch |
| D4 | Liveness scans the whole index | not just `## Pointers` | `Next action: #607 (open)` is a citation too |
| D5 | Citation states | `(open|closed|merged)`, `gh issue view <n>` maps PRs | `MERGED` is a real PR state |
| D6 | Offline liveness | `--no-network` skips; `--issues` = open-only (`(closed|merged)` exit 2) | the injected list is open issues only |
| D7 | History detection | **section bounds** (§STATE 4 lines · Invariants ≤8 · Resume ≤3 · preamble ≤2) + no H3 | mechanical, not a prose heuristic; catches a paste in any prose section |
| D8 | no-counts unit list | `files?|tests?|lines?|modules?|ADRs?|issues?|commands?|dispatches?|spawns?`, blockquotes **not** skipped | the handoff's own units; boundary stated |
| D9 | budget measures the index only | lines + UTF-8 bytes | pages open on demand; only the index is the per-session tax |
| D10 | retired chain | archived to `HANDOFF-ARCHIVE-2026-11-27.md` verbatim | the issue: "retired, not migrated" |
| D11 | suite report at a fresh machine | exit 2 "cannot check" with the capture command; **not** a #607 change | the report dependency is #513/#520, relocated not widened |

## Blast radius

- `scripts/lib/handoff-claims.mjs` — `isHandoffOwnPath` + `handoff/*.md`; `parseIndex` + the five new checks +
  section bounds; the new mandatory-heading set; `parseClaims` unchanged.
- `scripts/handoff-verify.mjs` — read index **and** derived state page; two passes; `--file`/`--root` unchanged;
  scope line updated; `state-page-missing` exit 2.
- `scripts/__tests__/handoff-verify.test.ts` + fixtures — migrate **all 7** fixtures and the **3** live-handoff
  reads; new fixtures for every new drift code; every old code re-reachable against the page.
- `.pi/extensions/handoff/lib.ts` — `isHandoffOwnPath` + `handoff/*.md`; `VERIFY_COMMANDS`; `handoff.test.cjs`.
- `.development/HANDOFF.md` (rewritten), `.development/handoff/state.md` + `invariants.md` (new),
  `.development/HANDOFF-ARCHIVE-2026-11-27.md` (new).
- `.pi/skills/handoff/SKILL.md` + `references/handoff.md` — restated for the index shape, the page convention,
  the budget, and the five checks.

## Acceptance (what would prove it wrong)

1. A fresh session reaches the next action in **≤3 commands and ≤10k tokens**, no clarifying question: §STATE
   (injected) → `gh issue view <next-action-number>`.
2. Each seeded violation turns a named check red: (a) 20 lines of history pasted into §STATE **or** under
   `## Invariants` **or** as a `### Since` section → `state-shape`/`section-over-bound`/`state-drift`; (b) a page
   omitted from the table → `unindexed-page`; (c) a listed page deleted → `dead-link`; (d) a stale sha →
   `sha-not-ancestor`; (e) a second `Next action:` → `next-action-ambiguous`; (f) a bare `Suite: 150 files` or
   `9 issues` (even blockquoted) → `unattributed-count`.
3. Every existing mechanical drift code (`dev-sha-drift`, `suite-count-drift`, `file-size-drift`, …) is still
   reachable from a fixture against the page; `parseClaims` itself is byte-unchanged.
4. `node scripts/handoff-verify.mjs` exits 0 on the shipped index+page **when the report at the `Verified:` sha
   is present**; exit 2 (`state-page-missing`/no-report) names the capture command otherwise — and reaching the
   next action needs neither. `handoff.test.cjs` passes; a page commit after `Verified:` reads handoff-owned; an
   unrelated commit drifts.
5. The shipped `HANDOFF.md` is ≤80 lines and ≤8 KB, has no `### ` heading, no bare count, and no
   `Since the last handover`.

## Evidence (each row: command + assertion, a negative control, a mutant with its killer)

| # | Command / assertion | Negative control | Mutant → killer |
|---|---|---|---|
| E1 | `node scripts/handoff-verify.mjs` on shipped index+page (report present) → exit 0 | an 81-line index → `over-budget` | budget `<=80` → E1 neg |
| E2 | pages listed + present → no completeness drift | unlisted page → `unindexed-page`; deleted page → `dead-link` | completeness compare → both negs |
| E3 | a cited sha on `dev` → pass | a sha off `dev` → `sha-not-ancestor` | ancestor check inverted → E3 neg |
| E4 | `#607 (open)` with `gh issue view 607` = OPEN → pass | `#607 (closed)` → `issue-state-drift`; `#601 (merged)` (PR) → passes as `merged` | state compare → E4 neg |
| E5 | a listed path exists → pass | a missing path → `path-missing` | `existsSync` inverted → E5 neg |
| E6 | a count in a fence → pass; outside (incl. `>`, incl. `9 issues`) → `unattributed-count` | `> Suite: 150 files` and `There are 9 issues` → both drift | fence/quote skip removed → E6 neg |
| E7 | exactly one `Next action:` with `#<n>` → pass | zero/two → `next-action-ambiguous`; no `#<n>` → `next-action-issue-missing` | count compare → E7 neg |
| E8 | page claims checked: stale `dev @`/`Suite:`/size → their existing codes | each claim mutated → its code | `parseClaims` unchanged, checks relocated |
| E9 | §STATE = 4 lines, Invariants ≤8, Resume ≤3 → pass | 20 history bullets under Invariants → `section-over-bound` | section bound relaxed → E9 neg |

Suite counts are measured at the implementation head and re-stated there (provisional until captured);
`npx tsc --noEmit` clean (no `src/` change); `npx vitest run` green.

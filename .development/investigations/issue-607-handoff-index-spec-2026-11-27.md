# #607 — the handoff is 62% history; make it an index the next session loads, and pages it opens on demand — spec **r2**

**Issue:** #607 (process, owner priority for the next fresh session) · **C2** · worktree **y**.
**jev:** medium (0.66) · C2 · worktree y
**Spec r2:** 2026-11-27, against `d724dd7` (`dev`). **Status: decision-ready** after one critique round
(`crit-607`, 10 majors, every one a design defect a line of code would have inherited; all answered below).

---

## r1 → r2 changes (the critique's ten majors, each measured and answered)

| # | r1 gap (measured by `crit-607`) | r2 answer |
|---|---|---|
| 1 | The evidence table named expected reds with no commands, measured killers, or negative controls (spec-evidence #557 rules). | §Evidence rewritten: every row names the command, its assertion, a negative control, and a mutant with its killer. |
| 2 | A handoff commit touching `state.md` is **not** handoff-only to either consumer — `isHandoffOwnCommit` in `handoff-claims.mjs` and `.pi/extensions/handoff/lib.ts` both return false for a page commit, so the next session reads drift/RECONCILE right after the commit. | `isHandoffOwnPath` extends in **both** files to `.development/handoff/*.md`. The extension IS touched (r1 claimed otherwise — wrong). |
| 3 | `parseClaims` cannot consume the r1 page: it needs a `## STATE` section and the bullet-form `dev @`, not a bare `dev @`. | The state page is a complete `## STATE` section in the **exact existing grammar** (bullet `dev @`, `Running install:`, `Open:`, `Suite:`, `<n> modules`, `<n> ADRs`, sizes) **plus its own `Verified:`**. `parseClaims` is unchanged. |
| 4 | The seeded "20 lines of history" falsifier is not implied by budget (short) or no-counts (count-free history). | Check 0 enforces the index **shape**: exactly four H2s, **no H3 headings at all**, and §STATE = exactly four named lines. History pasted into §STATE or as a `### Since` section is `state-shape`/`state-drift`. |
| 5 | Reusing the PR no-counts detector skips blockquotes and recognises only files/tests/lines. | The index no-counts check does **not** skip blockquotes, and the unit list is the handoff's own mechanical units (below). |
| 6 | Counting `Next action:` lines accepts an empty, non-issue, or closed action; liveness was scoped to `## Pointers` so `Next action: #607 (open)` went unchecked. | Check 5 requires exactly one line naming `#<n>`; liveness scans the **whole index** (not just `## Pointers`) so the action's `(open|closed)` is verified. |
| 7 | PR states are not OPEN/CLOSED — `gh issue view 601` returns `MERGED`; `--issues` is open-issues only, contradicting "closed is refused". | Citation states are `(open|closed|merged)`; verified via `gh issue view <n> --json number,state` (which maps PRs too). Offline: `--no-network` skips; `--issues` resolves `(open)` only, `(closed|merged)` is exit-2 unanswerable. |
| 8 | "Given only this repo" cannot make the verifier pass: the suite report lives in private machine state and its absence is exit 2. | The resume protocol distinguishes **checked** (exit 0) from **unavailable** (exit 2 — capture first). The falsifier is about *reaching* the next action, which needs only §STATE + `gh issue view`. |
| 9 | The injected §STATE carries no pointer to the index/pages, and the extension test only pins the old verify-command table. | §STATE gains a fourth line (`Index:`) naming the index and its sections; `VERIFY_COMMANDS` in `lib.ts` and `handoff.test.cjs` are updated together. |
| 10 | Only `correct.md` + one page fixture was accounted for; 7 tracked fixtures and 3 live-handoff reads exist. | §Blast radius names the full corpus; acceptance requires every old drift code re-reachable from a fixture against the page. |

---

## Recon (Rule 13 — codegraph @ `d724dd7`)

```
# parseClaims / evaluate (scripts/lib/handoff-claims.mjs) — pure claim grammar + verdict; checks 0-7 in one `evaluate`
# unattributedCounts (scripts/lib/pr-evidence.mjs) — the "count outside a block" pattern #607 names (reuse point)
# extractStateSection / isHandoffOwnCommit / VERIFY_COMMANDS ( .pi/extensions/handoff/lib.ts ) — the injection seam + handoff-owned rule
# resolveReport (scripts/lib/suite-report.mjs) — suite source (#513), keyed by the Verified sha
```

**Recon verification.** V1 `parseClaims` reads a whole `## STATE` section; the `dev @` claim needs the
bullet form (`DEV_RE` = `^[ \t]*[-*][ \t]+\**dev\**…`), not bare `dev @`. V2 `isHandoffOwnPath`
(`handoff-claims.mjs`) = `/^\.development\/HANDOFF(?:\.md|-ARCHIVE-[^/]+\.md)$/` — a page commit is foreign;
the extension's `isHandoffOwnCommit` (`.pi/extensions/handoff/lib.ts`) has the same rule and must extend in
lock-step. V3 the extension injects `extractStateSection` only (`index.ts:183`); `show` appends
`VERIFY_COMMANDS`; the staleness delta uses `isHandoffOwnCommit`. V4 check 0 mandates `STATE`+`Open items`;
`Open items` leaves. V5 `evaluate()` returns `{results, drifts}` in fixed order — the new checks are new
`check*` functions + probe facts, and the page checks reuse the existing ones minus check 0/1.

**Grep delta.** `grep -rn "isHandoffOwnPath\|HANDOFF_OWN" .pi/extensions scripts/lib` → 2 definitions, must
both extend. `git ls-files 'scripts/__tests__/fixtures/handoffs/*.md'` → **7** tracked fixtures.
`rg -n 'readFileSync\(join\(ROOT, "\.development", "HANDOFF.md"' scripts/__tests__/handoff-verify.test.ts` →
**3** live-handoff reads (CLI corpus, not fixtures).

---

## Decision — index + state page, two evaluation passes, and a shape that rejects history

### 1. The index (`HANDOFF.md`) — ≤80 lines AND ≤8 KB, flat, no history

```
# Handoff

> Read §STATE → run the 3 resume commands → open the pages you need.
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

**§STATE has exactly four lines, in order** — `Verified:`, `In flight:`, `Next action:`, `Index:`. The
`Index:` line is what makes the injected snapshot self-sufficient (V3 injects only §STATE): it names the
index file, its three other sections, and the two pages. No `dev @`, no `Running install:`, no `Open:`, no
`Suite:`, no counts, no cycle history, **no `### ` sub-heading** — §STATE ends at `## Invariants`.

**The index is flat and fixed-shape.** Exactly four H2 headings — `## STATE`, `## Invariants`, `## Pointers`,
`## Resume protocol` — and **no H3 headings anywhere**. The retired `### Since the last handover` chain is
archived verbatim to `.development/HANDOFF-ARCHIVE-2026-11-27.md`, never migrated; the one preamble line above
names where history lives.

**Numbers are not prose.** The index cites a command or a report path, never a count. Counts live in the state
page.

### 2. The pages (`.development/handoff/`)

- **`state.md`** — a complete `## STATE` section: `Verified: <sha> (<date>)` (same value as the index),
  `- **dev** @ \`<sha>\``, `Running install: …`, `Open: #…`, `Suite: <n> files / <m> tests (<p> passed,
  <q> failed, <r> skipped)`, `<n> modules`, `<n> ADRs`, and every `` `name.ts` <n> `` size line. **This is
  the exact grammar `parseClaims` already parses** — nothing new to parse, and `parseClaims` is unchanged.
- **`invariants.md`** — the full invariant list, one reason each, sourced to the issue/ADR/sha that
  established it. The index carries the short list; this page carries the "why".

### 3. `handoff-verify.mjs` — two passes + the five new checks

**Pass A (the index).** New `parseIndex` extracts the headings, the §STATE lines (`Verified`, `In flight`,
`Next action`, `Index`), the pointer-table link targets, the citations, and the raw text. Checks, in fixed
order:

0. **structure / shape** — H2 set == exactly `{STATE, Invariants, Pointers, Resume protocol}` (no extra, no
   repeat → `state-drift`); **no H3 heading** (a `### Since the last handover` is `state-drift`); §STATE body
   == exactly the four named lines in order, each non-blank (`Verified:` first) — any other line is
   `state-shape`.
1. **verified** — the index's `Verified:` is an ancestor of HEAD with no non-handoff commit after it (the
   existing check 1, unchanged logic, now sourced from `parseIndex`).
2. **budget** — >80 lines or >8,192 UTF-8 bytes → `over-budget` (names both measured values).
3. **index completeness** — pages = `*.md` directly under `<index-dir>/handoff/`; listed = link targets
   `[...](target)` inside `## Pointers` ending in `.md` and resolving inside `handoff/`. Page not listed →
   `unindexed-page`; listed but absent → `dead-link`.
4. **citation liveness** — over the **whole index** (outside fences), three kinds:
   - `#<n>` immediately followed by `(open|closed|merged)` → `gh issue view <n> --json number,state` must
     match → else `issue-state-drift` (skipped under `--no-network`, printed; `--issues` resolves `(open)`
     only, `(closed|merged)` is exit-2 unanswerable);
   - a backticked `7–40`-hex sha (excluding the `Verified:` line, which check 1 owns) → ancestor of `dev` →
     else `sha-not-ancestor`;
   - a path (markdown link target, or backticked token containing `/` ending in a known extension) → exists →
     else `path-missing`.
5. **no counts in prose** — the `unattributedCounts` shape (fence-skipping, **not** blockquote-skipping) with
   the unit list `files?|tests?|lines?|modules?|ADRs?` → `unattributed-count` (line + offending token).
   Coverage boundary stated in output: a count with a unit outside this list (e.g. `9 issues`) is not detected.
6. **one next action** — exactly one `Next action:` line in §STATE → else `next-action-ambiguous`; its text
   must name `#<n>` → else `next-action-issue-missing`. The line's `(open|closed)` is checked by (4).

**Pass B (the state page).** `parseClaims(statePage)` unchanged; run checks 2–7 (dev, install, open, suite,
modules/adrs, sizes) with the existing drift codes. Check 0/1 are **not** re-run on the page (structure and
`Verified:` are the index's). The page's `Verified:` is cross-checked against the index's (disagree →
`verified-page-drift`), and check 5 (suite) uses the page's `Verified:` as `expectHead`.

`--file` still names the index; the state page is derived at `<dir-of-index>/handoff/state.md`. A missing
state page is exit-2 `state-page-missing` (usage, not drift). The scope line is updated to name exactly what
is now out of scope: the `In flight:` and `Index:` text are prose, and the `Invariants` bullet list is prose —
the five new checks are the only mechanical reading of the index.

### 4. The extension — two small, load-bearing changes (r1's "untouched" claim was wrong)

- **`isHandoffOwnPath`** (`.pi/extensions/handoff/lib.ts`) extends to `.development/handoff/*.md`, in
  lock-step with `handoff-claims.mjs` (V2): a page commit must be the handoff's own, not drift.
- **`VERIFY_COMMANDS`** (`.pi/extensions/handoff/lib.ts`) updates to the new resume protocol; `handoff.test.cjs`
  pins the sync (the reference's verify table and the constant cannot drift).

`extractStateSection` and the `Verified:` staleness logic are unchanged — §STATE still starts with `Verified:`
and ends at `## Invariants`.

---

## Sub-decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Mechanical claims live in `handoff/state.md`, derived from the index dir (no new flag) | page is a full `## STATE` in the existing grammar | index carries no counts; `parseClaims` unchanged |
| D2 | §STATE = exactly 4 lines incl. `Index:` | `Verified` · `In flight` · `Next action` · `Index` | the injected snapshot is self-sufficient (V3 injects §STATE only) |
| D3 | `Verified:` lives in **both** files | index §STATE + page §STATE, cross-checked | the page is a complete §STATE; the index is the extension's anchor |
| D4 | Liveness scans the whole index | not just `## Pointers` | `Next action: #607 (open)` is a citation too |
| D5 | Citation states | `(open|closed|merged)`, `gh issue view <n>` maps PRs | `MERGED` is a real PR state; issues have no `merged` |
| D6 | Offline liveness | `--no-network` skips; `--issues` = open-only (`(closed|merged)` exit 2) | the injected list is open issues only — cannot answer closed/merged |
| D7 | History detection | index shape (4 H2s, no H3, §STATE = 4 lines) | mechanical, not a prose heuristic; catches the seeded paste |
| D8 | no-counts unit list | `files?|tests?|lines?|modules?|ADRs?`, blockquotes **not** skipped | the handoff's own mechanical units; the index rule is stricter than PR bodies |
| D9 | budget measures the index only | lines + UTF-8 bytes | pages open on demand; only the index is the per-session tax |
| D10 | retired chain | archived to `HANDOFF-ARCHIVE-2026-11-27.md` verbatim | the issue: "retired, not migrated" |

## Blast radius

- `scripts/lib/handoff-claims.mjs` — `isHandoffOwnPath` + `handoff/*.md`; `parseIndex` + the five new checks;
  the structure check's new mandatory set + §STATE shape + no-H3 rule; the page cross-check. `parseClaims`
  unchanged.
- `scripts/handoff-verify.mjs` — read index **and** derived state page; two evaluation passes; `--file`/`--root`
  unchanged; scope line updated; `state-page-missing` exit 2.
- `scripts/__tests__/handoff-verify.test.ts` + fixtures — migrate **all 7** tracked fixtures and the **3**
  live-handoff reads; new fixtures for every new drift code and the relocation (each old code re-reachable
  against the page).
- `.pi/extensions/handoff/lib.ts` — `isHandoffOwnPath` + `handoff/*.md`; `VERIFY_COMMANDS` updated;
  `handoff.test.cjs` pins both.
- `.development/HANDOFF.md` (rewritten), `.development/handoff/state.md` + `invariants.md` (new),
  `.development/HANDOFF-ARCHIVE-2026-11-27.md` (new).
- `.pi/skills/handoff/SKILL.md` + `references/handoff.md` — restated for the index shape, the page convention,
  the budget, and the five checks.

## Acceptance (what would prove it wrong)

1. A fresh session reaches the next action in **≤3 commands and ≤10k tokens**, no clarifying question: §STATE
   (injected) → `gh issue view <next-action-number>`.
2. Each seeded violation turns a named check red: (a) 20 lines of history pasted into §STATE or as a
   `### Since` section → `state-shape`/`state-drift`; (b) a page omitted from the table → `unindexed-page`;
   (c) a listed page deleted → `dead-link`; (d) a stale sha in the index → `sha-not-ancestor`; (e) a second
   `Next action:` → `next-action-ambiguous`; (f) a bare `Suite: 150 files` (even blockquoted) → `unattributed-count`.
3. Every existing mechanical drift code (`dev-sha-drift`, `suite-count-drift`, `file-size-drift`, …) is still
   reachable from a fixture against the page; `parseClaims` itself is byte-unchanged.
4. `node scripts/handoff-verify.mjs` exits 0 on the shipped index+page; `handoff.test.cjs` passes; a page
   commit after `Verified:` reads as handoff-owned (no drift) while an unrelated commit still drifts.
5. The shipped `HANDOFF.md` is ≤80 lines and ≤8 KB, has no `### ` heading, and no `Since the last handover`.

## Evidence (each row: command + assertion, a negative control, a mutant with its killer)

| # | Command / assertion | Negative control | Mutant → killer |
|---|---|---|---|
| E1 | `node scripts/handoff-verify.mjs` on shipped index+page → exit 0, 0 drift | an 81-line index → `over-budget` | budget `<=80` → E1's negative |
| E2 | pages listed, files present → no completeness drift | add an unlisted page → `unindexed-page`; delete a listed one → `dead-link` | completeness compare → both negatives |
| E3 | a cited sha on `dev` → pass | a sha off `dev` → `sha-not-ancestor` | ancestor check inverted → E3 neg |
| E4 | `#607 (open)` with `gh issue view 607` = OPEN → pass | `#607 (closed)` → `issue-state-drift`; `#601 (merged)` (a PR) → passes as `merged` | state compare → E4 neg |
| E5 | a listed path exists → pass | a missing path → `path-missing` | `existsSync` inverted → E5 neg |
| E6 | a count inside a fence → pass; outside (incl. `>`) → `unattributed-count` | `> Suite: 150 files` → `unattributed-count` | fence/quote skip removed → E6 neg |
| E7 | exactly one `Next action:` with `#<n>` → pass | zero/two lines → `next-action-ambiguous`; no `#<n>` → `next-action-issue-missing` | count compare → E7 neg |
| E8 | page claims checked: stale `dev @`, stale `Suite:`, stale size → their existing codes | each mechanical claim mutated → its code | `parseClaims` unchanged, checks relocated |

Suite counts are measured at the implementation head and re-stated there (provisional until captured);
`npx tsc --noEmit` clean (no `src/` change); `npx vitest run` green.

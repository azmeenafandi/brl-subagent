# #607 — the handoff is 62% history; make it an index the next session loads, and pages it opens on demand — spec **r6 (final)**

**Issue:** #607 (process, owner priority) · **C2** · worktree **y**.
**jev:** medium (0.66) · C2 · worktree y
**Spec r6:** 2026-11-27, against `8630e60` (`dev`). **Status: decision-ready** — five critique rounds (10 · 4+1 · 4 · 5 · 6
majors) answered; the architecture has been stable since r2, and r6 folds the last six findings.

---

## r5 → r6 changes (the fifth critique's six majors — answered with decisions, not restated blame)

| # | r5 gap | r6 decision |
|---|---|---|
| 1 (major) | The "20 lines of history" residual is too narrow: bounded lines can hold counted history, spread across sections. | **Residual stated broadly and honestly:** the mechanical guarantee is *structural smallness* — section line-bounds + forms + per-line ≤160 + no-H3 + no-counts + citation-liveness + budget. A determined adversary packing count-bearing narrative into bounded lines is outside mechanical scope; the falsifier is measured by the **receipt** (below), not by a proof that no prose can ever sneak in. |
| 2 (major) | A correctly-labelled `#596 (closed)` passes liveness, so a closed next action survives. | Check 6 requires the next action to state `(open)` **specifically** (a next action is by definition open): missing `#<n>` → `next-action-issue-missing`; a state other than `(open)` → `next-action-state-missing`. Liveness then verifies the `(open)` label matches the real state (`issue-state-drift`). A closed next action is caught either way. |
| 3 (major) | The exit-2 enumeration omits `ambiguous-reports`, `no-provenance-match`, `root-invalid`. | **Simplified, not re-enumerated:** exit 2 = "cannot check" — `resolveReport`'s existing refusal modes **unchanged (#513/#520)**, plus the new `state-page-missing`. The spec does not re-list the resolver's own modes (that is its contract, not #607's). |
| 4 (major) | Post-mark outcome is conditional: a sidecar-less report is accepted, not exit 2. | Stated as conditional: after `/handoff mark`, the outcome depends on report selection — sidecar-less → `provenance: absent` (accepted); mismatching sidecar → `provenance-mismatch` (exit 2); the reconcile order is **re-capture the suite, then update the page**. |
| 5 (major) | Evidence rows still lack executable commands + measured killers. | **Scope handoff:** the spec states **falsifiers + negative controls** (the seeded violations that must turn red); the *executable commands and measured mutant kills are the implementer's implementation-report deliverable*, re-measured by the reviewer. The spec stops trying to write the test file. |
| 6 (major) | The `≤3 commands / ≤10k tokens` falsifier has no measurement procedure. | **Falsifier receipt** (below): §STATE ≤ 2,000 bytes (measured), the next action reached in 1 command after injection, recorded in the close comment with the measured values. |

---

## Recon (Rule 13 — codegraph @ `8630e60`)

```
# parseClaims / evaluate (scripts/lib/handoff-claims.mjs) — pure claim grammar + verdict
# unattributedCounts (scripts/lib/pr-evidence.mjs) — no-counts reuse point
# extractStateSection / isHandoffOwnCommit / VERIFY_COMMANDS / replaceVerified ( .pi/extensions/handoff/lib.ts )
# resolveReport (scripts/lib/suite-report.mjs) — suite source (#513); refusal modes its own contract
```

**Recon verification.** V1 `parseClaims` needs a `## STATE` + bullet `dev @`. V2 `isHandoffOwnPath` (both
files) extends to `.development/handoff/*.md`. V3 the extension injects §STATE only; `replaceVerified` rewrites
the index only. V4 `resolveReport`'s refusal modes are its own contract (#513/#520) — #607 relocates the suite
claim, it does not re-enumerate them. V5 `checkSuite` throws before other drifts print (existing order,
documented). V6 check 0 mandates `STATE`+`Open items`; replaced.

**Grep delta.** `grep -rn "isHandoffOwnPath\|HANDOFF_OWN" .pi/extensions scripts/lib` → 2 definitions.
`git ls-files 'scripts/__tests__/fixtures/handoffs/*.md'` → 7 fixtures. `rg -n 'readFileSync\(join\(ROOT, "\.development", "HANDOFF.md"' scripts/__tests__/handoff-verify.test.ts` → 3 live reads.

---

## Decision

### 1. The index (`HANDOFF.md`) — ≤80 lines AND ≤8 KB, flat, no history, no counts

```
# Handoff

> Read §STATE → run the resume commands → open the pages you need.
> History: `.development/HANDOFF-ARCHIVE-*` and `.development/FRICTION_LOG.md` — never re-read it.

## STATE
Verified: <sha> (<date>)
In flight: nothing
Next action: #607 (open) — redesign the handoff as an index
Index: verify `node scripts/handoff-verify.mjs` (0 drift) before acting → HANDOFF.md §Invariants·§Pointers·§Resume protocol · handoff/state.md · handoff/invariants.md

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

**§STATE has exactly four non-blank lines, in order** — `Verified:`, `In flight:`, `Next action: #<n> (open)`,
`Index:`. The `Next action:` line must cite `#<n> (open)` — the state is **required and must be `open`**. The
`Index:` line carries the **verify-before-acting** instruction, so a session that sees only the injection knows to
run the verifier first — it must never trust the next action before `handoff-verify` is green.

**The index shape** (the mechanical "no history" guarantee — each rule fails with a named code):

| Rule | Code |
|---|---|
| H2 set == exactly `{STATE, Invariants, Pointers, Resume protocol}`; no H3 | `state-drift` |
| §STATE == the four named lines in order | `state-shape` |
| preamble ≤ 2 `>` lines; `## Invariants` ≤ 8 `- ` lines; `## Pointers` ≤ 12 `|` lines; `## Resume protocol` ≤ 3 command lines | `section-over-bound` (count) / `state-shape` (form) |
| every index line ≤ 160 chars | `state-shape` |
| no bare count outside a fence (units below, blockquotes **not** skipped) | `unattributed-count` |

The `### Since the last handover` chain is archived verbatim to `.development/HANDOFF-ARCHIVE-2026-11-27.md`.
**Residual (broad):** the guarantee is structural smallness, not a proof that no prose can ever be smuggled in;
the falsifier is measured by the receipt below, not by that impossible proof.

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
   (`next-action-issue-missing`) **with the state `(open)`** (`next-action-state-missing`); the `(open)` label is
   checked by (4).

**Pass B (the state page).** `parseClaims(statePage)` unchanged; checks 2–7 with the existing drift codes;
check 5 (suite) uses the index's `Verified:` as `expectHead`. `--file` names the index; the page is
`<dir-of-index>/handoff/state.md`; a missing page is exit-2 `state-page-missing`.

**Exit semantics.** 0 = every check holds · 1 = a drift (a claim is wrong; fix the claim) · 2 = **cannot check** —
`resolveReport`'s existing refusal modes (unchanged, #513/#520) plus `state-page-missing` and a bad flag. A
drift and a cannot-check are never conflated.

### 4. The extension — two small, load-bearing changes

- **`isHandoffOwnPath`** (`.pi/extensions/handoff/lib.ts`) extends to `.development/handoff/*.md`, in lock-step
  with `handoff-claims.mjs`.
- **`VERIFY_COMMANDS`** (`.pi/extensions/handoff/lib.ts`) updates to the new resume protocol; `handoff.test.cjs`
  pins the sync.

`extractStateSection`, the staleness logic, and `replaceVerified` (`/handoff mark`, index-only) are unchanged.
**Post-mark reconcile (conditional):** `mark` rewrites only the index `Verified:`; the next `handoff-verify`
outcome depends on report selection (sidecar-less → `provenance: absent` accepted; mismatching sidecar →
`provenance-mismatch` exit 2). Reconcile = re-capture the suite, then update the page's `dev @`/sizes. The
extension banner may call the index "current" while the page is unreconciled; the verifier is the authority.

---

## Sub-decisions

| # | Decision | Choice | Why |
|---|---|---|---|
| D1 | Mechanical claims live in `handoff/state.md` | `## STATE`, existing grammar, no `Verified:` | index carries no counts; `parseClaims` unchanged; mark single-file |
| D2 | §STATE = 4 non-blank lines incl. `Index:` | the four named lines | self-sufficient injection |
| D3 | `Verified:` lives once (index) | page does not repeat it | no mark mismatch |
| D4 | Liveness: state+sha over whole index; **path only `## Pointers` links** | split scope | prose backticks/globs/gitignored are illustrative |
| D5 | Citation states | `(open|closed|merged)` via `gh issue view <n>` | `MERGED` is a real PR state |
| D6 | Next action state | must be `(open)`; liveness verifies it | a next action is by definition open |
| D7 | Offline liveness | `--no-network` skips; `--issues` = open-only | injected list is open issues only |
| D8 | History detection | section bounds + forms + per-line ≤160 + no H3 + no-counts + liveness + budget | mechanical; residual stated honestly |
| D9 | no-counts units | `files?|tests?|lines?|modules?|ADRs?|issues?|commands?|dispatches?|spawns?`, blockquotes not skipped | handoff's own units |
| D10 | budget measures the index only | lines + UTF-8 bytes | only the index is the per-session tax |
| D11 | retired chain | archived verbatim | "retired, not migrated" |
| D12 | exit 2 | cannot-check, `resolveReport` modes unchanged + `state-page-missing` | relocates the claim, doesn't re-enumerate the resolver |

## Blast radius

- `scripts/lib/handoff-claims.mjs` — `isHandoffOwnPath` + `handoff/*.md`; `parseIndex` + five checks + shape;
  new mandatory headings; `parseClaims` unchanged.
- `scripts/handoff-verify.mjs` — read index + derived page; two passes; `--file`/`--root` unchanged; scope line;
  `state-page-missing` exit 2.
- `scripts/__tests__/handoff-verify.test.ts` + fixtures — migrate all 7 fixtures + 3 live reads; new fixtures for
  every new drift code; every old code re-reachable against the page.
- `.pi/extensions/handoff/lib.ts` — `isHandoffOwnPath` + `handoff/*.md`; `VERIFY_COMMANDS`; `handoff.test.cjs`.
- `.development/HANDOFF.md` (rewritten), `.development/handoff/state.md` + `invariants.md` (new),
  `.development/HANDOFF-ARCHIVE-2026-11-27.md` (new).
- `.pi/skills/handoff/SKILL.md` + `references/handoff.md` — restated.

## Acceptance (what would prove it wrong)

1. **Falsifier receipt (measured):** §STATE ≤ 2,000 bytes (`extractStateSection` → `wc -c`); a fresh session
   that sees **only the injection** runs `node scripts/handoff-verify.mjs` (1 command) and `gh issue view <n>`
   (2 commands) before trusting the next action — well under 3 — and stops or reconciles on drift/cannot-check;
   the whole index ≤8 KB (budget), well under 10k tokens; no clarifying question. A seeded **malformed index** and
   an **unreconciled page** must each stop the session before it acts. The measured values are recorded in the
   #607 close comment.
2. Each seeded violation turns a named check red: (a) 20 lines of history in §STATE / under `## Invariants` /
   `## Pointers` / as a `### Since` section → `state-shape`/`section-over-bound`/`state-drift`; (b) a page omitted
   → `unindexed-page`; (c) a listed page deleted → `dead-link`; (d) a stale sha → `sha-not-ancestor`; (e) a second
   `Next action:` → `next-action-ambiguous`; a `Next action: #607` without `(open)` → `next-action-state-missing`;
   a closed next action → `issue-state-drift` or `next-action-state-missing`; (f) a bare `Suite: 150 files` or
   `9 issues` (even blockquoted) → `unattributed-count`.
3. Every existing mechanical drift code is still reachable from a fixture against the page; `parseClaims` is
   byte-unchanged.
4. `node scripts/handoff-verify.mjs` exits 0 on the shipped index+page when a report at the `Verified:` sha
   exists; exit 2 (cannot-check) otherwise; reaching the next action needs neither. `handoff.test.cjs` passes; a
   page commit after `Verified:` reads handoff-owned; an unrelated commit drifts.
5. The shipped `HANDOFF.md` is ≤80 lines and ≤8 KB, has no `### ` heading, no bare count, no line >160 chars, no
   `Since the last handover`.

## Falsifiers the implementation must make fail (executable tests are the implementer's deliverable, re-measured by the reviewer)

| Seeded violation | Drift code that must fire |
|---|---|
| 81-line or >8,192-byte index | `over-budget` |
| a page file unlisted / a listed page deleted | `unindexed-page` / `dead-link` |
| a sha in the index not on `dev` | `sha-not-ancestor` |
| `#607 (closed)` where #607 is OPEN (and vice-versa) | `issue-state-drift` |
| a `## Pointers` link target that does not exist | `path-missing` |
| `Suite: 150 files` / `9 issues` outside a fence (even `>`-quoted) | `unattributed-count` |
| zero / two `Next action:` lines; no `#<n>`; a state other than `(open)` | `next-action-ambiguous` / `next-action-issue-missing` / `next-action-state-missing` |
| §STATE ≠ the four lines; an H3 or extra H2; a >8-bullet Invariants; a >160-char line | `state-shape` / `state-drift` / `section-over-bound` |
| a stale `dev @` / `Suite:` / size in the page | the existing `dev-sha-drift` / `suite-count-drift` / `file-size-drift` |

`npx tsc --noEmit` clean (no `src/` change); `npx vitest run` green; suite counts measured at the implementation head.

6. **Non-vacuous evidence (the implementation report):** for each check family, a filtered test command that
   executes ≥1 case (`node scripts/require-executed.mjs …` or an equivalent guard) and a measured mutant/seeded-
   fixture kill (the observed failing test/code). A green suite with zero executed #607 tests, or a seeded
   violation that stays green, fails acceptance.

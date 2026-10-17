# REVIEW — PR #353 (handoff mechanism) @ `5647d78`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — focused C2, Jev **high (0.66)**.
Run 1 (`e1542420`) died on a **connection error** at 12m5s after banking ~2/3 of the surfaces; run 2 (`d9db2c5e`)
continued from the bank and completed in 4m40s. Spec: `.development/investigations/handoff-mechanism-spec-2026-10-17.md`.

**Verdict: approve-with-nits** (at `316d73e`) → both minors fixed in `5647d78` → merged `ca73803`.

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| minor | `.pi/extensions/handoff/index.ts:52-59` | `VERIFY_COMMANDS` omits the reference's 7th `hygiene` row (`tsc`/`docs-arch`/`docs-decisions`) |
| minor | `.pi/extensions/handoff/lib.ts:69-87,189-199` | DRY: the §STATE range-scan loop duplicated in `extractStateSection` and `replaceVerified` |

## Verified-OK

- Unit suite **ALL PASS** (rerun in the review session).
- **Mutation probes (a)–(d):** each pre-stated signature matched (2/2/2/3 guard-test failures); tree restored
  identical, status clean.
- **Inertness e2e** on the real `index.ts`+`lib.ts`: `DEPTH=1`, `DEPTH="0"`, git failure, no repo, wrong branch,
  missing file → silent no-ops, no throws; positive control injects (send=2, append=1). `"0"` is
  set-means-child (conservative); `""`/whitespace/missing are not subagents.
- **Parse boundaries:** §STATE ends at the next `## ` (`###` kept, `#` ignored); absent/malformed-first `Verified:`
  → null; uppercase/leading-ws accepted; only the extracted section is parsed.
- **`/handoff mark`:** rewrites exactly one line, preserves an outside-§STATE `Verified:`, refuses (null) without
  §STATE or when HEAD is unreadable; LF file byte-preserved; show path probe-gated.
- **Injection:** `deliverAs:"nextTurn"` valid, no `triggerTurn`, passive queueing; post-compaction ordering correct;
  **no `session_before_compact` handler**; content-aware dedupe (byte-identical suppressed, drift re-injects).
- **Docs/contract:** archive body byte-verbatim vs `dev` (10-line header per spec H3); new HANDOFF 74 lines /
  §STATE 34 (within budget), no history; lifecycle renumbering consistent (step 0 added; 6→7 in 3 files; 0–9→1–10;
  remaining step-6 hits correctly historical); worktree-guard header accurate.

SOLID/DRY violations flagged: 1 (the `findStateRange` duplication; fixed)

**Coverage:** targeted suite ALL PASS · probes 2/2/2/3 · inertness 6 no-op cases + 1 positive control · full suite
78 files / 1625 tests · `tsc` clean · archive diff byte-identical. Findings banked to `/tmp/review-353-findings.md`.

## Disposition (2026-10-17)

- **F1/F2: FIXED** in `5647d78` — the hygiene row added (constant moved to `lib.ts`, pinned by a sync guard in the
  test); `findStateRange` extracted for both consumers. No re-review (C3 reclassification: test-pinned consistency/DRY).
- Merged `ca73803` (CI pass).

## Design observations (post-merge, for a follow-up)

1. **Self-reference lag:** `Verified: <sha>` cannot equal the sha of the commit that updates it — the records commit
   moves HEAD by one, so the next injection will read RECONCILE until the next handover. Candidate: the hook ignores
   the handoff's own commit (and its archive) in the staleness delta.
2. **Untyped extensions:** `tsconfig.json` includes only `src/**`, so `.pi/extensions/**/*.ts` never passes
   `tsc --noEmit` — a type error there surfaces only at runtime via jiti. Candidate: a second tsconfig include or a
   dedicated check.

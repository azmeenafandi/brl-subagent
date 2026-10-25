# REVIEW — PR #382 (smell vocabulary + near-duplicate prose guard) @ `5f7598a`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — focused C2, Jev **medium (0.78)**. Issue #375;
source `.development/investigations/smell-audit-2026-10-25.md` §8.4.
Diff `7b9d805..HEAD`: `review-dispatch.md` (+58), `friction-log-ritual.md` (+14), `scripts/ts-ast.mjs`/`.d.mts`
(shared literal helpers), `prose-duplication.test.ts` (new).

**Verdict: approve-with-nits** (3 minors) → fixed `dcecd0f` → merged `6326534`.

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| minor | `prose-duplication.test.ts:25` | The ceiling comment claimed 0.70; the re-measured global max is 0.667 (threshold 0.80 still clears) |
| minor | `runtime-vocabulary.test.ts:49,108` | A private `SUBSTITUTION` + `flattenLiteralText` copy duplicated the adapter the PR extracted for sharing |
| minor | `prose-duplication.test.ts` | No fixture pinned the `${…}` template-expression or the no-substitution-template extraction paths |

## Verified-OK

- **Guard design:** `MIN_LENGTH` 80 + cross-file-only + `__tests__` exclusion is honest; the intra-file D7 backlog is
  deliberately not allow-listed (stated in the comment); normalised equality + word-token Jaccard in code.
- **Threshold arithmetic:** a 12-token one-word edit → 11/13 ≈ 0.85; the fixture sentence (15 tokens) scores 0.875,
  pinned by the one-word-edit test.
- **AST extraction:** string literals, no-substitution templates, template expressions, `+` concatenations, parens;
  type positions skipped; comments unreachable via the walk (pinned); **96 literals across 16 files** on this tree.
- **Mutation proof:** a one-word-edited clone of the retryOnTimeout guideline appended to `src/schema.ts` → the guard
  failed with an actionable message; restored clean. **Vacuity:** a collector returning `[]` fails the non-empty test.
- **Adapter:** purely additive (`SUBSTITUTION`, `flattenLiteralText`); `architecture-rules` + `runtime-vocabulary`
  suites green; `docs-arch.mjs` doesn't import `ts-ast`; `.d.mts` matches; `tsc` clean.
- **Docs:** the five keys, `suggested` vs `enforced` (only `duplicated-code` enforced), the fail-closed uncoached
  bucket, the guide shape, the sample `Smell`-column row — faithful to §8.4 (the 5.6% / 79/90 and `repaintStatus` /
  `StructuralError` quotes verified verbatim).
- **No collateral:** docs + adapter + test only; `package.json`/lockfiles untouched; 84 files / 1727 green; CI pass.

SOLID/DRY violations flagged: 1 (the runtime-vocabulary copy — fixed)

## Disposition (2026-10-25)

- **All three FIXED** in `dcecd0f` — the stale ceiling corrected to the re-measured value; `runtime-vocabulary.test.ts`
  migrated to the shared helpers (private copy deleted); two fixtures pin the template-expression and
  no-substitution-template paths, mutation-checked. Suite **84 files / 1729**; CI green. Merged `6326534`.
- **Residual (out of scope, noted):** `architecture-rules.test.ts` carries a reduced private copy of the same
  literal-flattening logic — a candidate for the next pass over the shared helper.

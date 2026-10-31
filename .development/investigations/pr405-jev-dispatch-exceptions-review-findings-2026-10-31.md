# REVIEW — PR #405 (fix/jev-dispatch-exceptions) @ `7dcdd64` + conductor fix `4422f30`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — C2, Jev **medium (0.41)**.
Origin: the merge-guard's (e) audit caught a **real Jev miss** of the conductor's (#396 plan-critique
dispatch, 2026-10-31) — and exposed that a historical miss blocks every future merge forever.

Reviewed head: 7dcdd64

**Verdict: approve-with-nits** — 1 minor, 1 nit, 1 info; all three fixed by the conductor in
`4422f30` (mutation-proven), so (d) clears through this disposition rather than a second re-review.

## Findings

| Severity | File:line | One-liner | Disposition |
|---|---|---|---|
| minor | jev-check.mjs:754–811 | No selftest pinned prefix-vs-substring; `startsWith`→`includes` still passed 31/31 | fixed: mid-string case added (`aaaabbbb…` vs prefix `bbbb`); mutation → 31/32 FAIL |
| nit | jev-check.mjs:24–32,900–909 | `--exceptions` missing from the header Modes comment and USAGE | fixed: both |
| info | jev-check.mjs:373 | A single-char prefix over-matches | fixed: loader warns when a prefix is <7 chars |

conductor-verified: 4422f30 — mid-string selftest (mutation 31/32 FAIL, restored 32/32 PASS), USAGE + header
lines added, short-prefix warning; `node --check` clean; `--ledger` unchanged; suite 90/1798; diff-check clean.

## Verified-OK (review)

- No laundering: a matching offender is printed as `acknowledged: <reason>` and removed from the
  offenders; a valid line is never excepted; a non-matching offender still exits 1; mixed runs exit 1;
  case-insensitive; prefix is `startsWith` (edge-probed).
- Parsing: comments/blanks skipped; prefix-only lines recorded with `(no reason recorded)`; CRLF
  handled; single-token lines harmless; exit 0 only with zero offenders.
- Real log (cockpit): exit 0 with 2 printed exceptions; `--exceptions /tmp/nonexistent` → exit 1 with
  the same 2 offenders; `--ledger` unchanged (101 rows).
- Design judgement: the local, gitignored allow-list is the right closure — history stays immutable; the
  abuse mode (a broad prefix) is bounded to hiding a dispatch line, and the printed reason + the ledger
  row are the review surface. The reviewer called this "thin but sufficient"; it is conductor-run, not CI.

## Disposition

Merged after `merge-guard.sh` (dogfood: the guard runs the new `--log` with the local exceptions file).

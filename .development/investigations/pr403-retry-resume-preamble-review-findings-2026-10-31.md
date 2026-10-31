# REVIEW — PR #403 (feat/retry-resume-preamble) @ `62df165`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — C2 (three rounds: C2 on the PR,
focused re-review of the fix commit, narrow C3 re-review of the README delta).
Issue: #401. Jev: high (0.46) initial, medium (0.92) / (0.41) on the re-reviews.

Reviewed head: 62df165

**Verdict: approve**

## Findings and dispositions

| Round | Severity | File:line | One-liner | Disposition |
|---|---|---|---|---|
| 1 | nit | `src/index.ts:~243` | Bank-label fallback used the raw id; an all-separator label yielded `---` | fixed `9e98a9e` (sanitize + fallback pin) |
| 1 | nit | `README.md` | "in this unit" phrasing | fixed (`do not get a resume block`) |
| 2 | **blocking** | `README.md:131,318` | The README still promised the transcript pointer after the code removed it | fixed `62df165` (two sentences) |

## Verified-OK

- **Prompt-only isolation** (the load-bearing pin): resolution, auto-routing, thinking
  level, H1 keyword warnings and capability pre-flight all see the recorded original task;
  the routing-isolation test fails if the preamble leaks into `resolveSubagentParams`.
- **Non-compounding** across fresh / manual-retry / attempt-3 paths; the prefixed `run.task`
  never re-enters resolution (`originalParams.task`, preferred by `resolveRetryParams`).
- **Preamble** bounded (4 lines), vocabulary-safe (ratchet green), names **no** transcript
  path (verified: the output log is a start/steering log; the session dir is pruned on
  settle — `#404` tracks retaining it), label sanitized with a structural fallback pin.
- **Mutations**: dropping the prompt injection reddens 3–4 tests; preamble into resolution
  reddens the routing-isolation test; both restored, tree clean.
- **Docs** match behavior (attempt-2-only, prompt-only, manual excluded, banking
  convention); README's auto-retry text carries no contradiction.
- **No collateral**: retry predicate/bounds/gates/timing untouched; `tsc` clean; suite
  **90 files / 1802 tests**; `git diff --check` clean.

## Process note

The implementer died on **two** transport failures (attempt 1 `12c63cee`; attempt 2
`a49e6e4f`, 8m46s / 94 turns). The second left the work uncommitted and green; the
conductor performed last-mile banking — reviewed the diff, ran the gates and both
mutations, committed — and then found the dead-end transcript pointer in post-review
verification (removed; #404 filed). The review history above covers every commit.

## Disposition

Merged after `merge-guard.sh` (CI + this record + the dispatch audit). #401 closed.

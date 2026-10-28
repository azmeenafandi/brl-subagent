# REVIEW — PR #397 (tooling/recurrence-guards) @ `2daa12d`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — focused C2, Jev **medium (0.9)**.
Origin: friction entries 2026-10-27 (`prep-smoke-failure-without-evidence` recurrence 2, `unreviewed final fix`, Jev-skip recurrence).

Reviewed head: 2daa12d

**Verdict: approve-with-nits** (2 informational) → merged.

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| info | `merge-guard.sh` (check d) | A reviewed-head sha mentioned anywhere in the record's prose would clear (d); inherent to grep-over-prose, and the failure direction on *missing* head is closed |
| info | `jev-check.mjs` (`--log`) | A dispatch that merely *quotes* a concrete `jev:` line would pass; inherent to text scanning; placeholders and bare levels correctly fail |

## Verified-OK

- `merge-guard.sh` checks (a)–(e) each gate: CI state parsing distinguishes fail/pending/skip/neutral; `#<pr>`, a final disposition line (changes-requested blocked), PR-head sha or `conductor-verified:`, and the `--log` audit. Missing record / unreadable log / `gh` failure all fail closed; selftest 15/15 with distinct-outcome fixtures.
- `jev-check --log`: default **0** (1 event since 2026-10-28); `--since 2026-10-25` → **exactly 3 offenders**, exit **1**; `--since 2026-10-27` → 2; missing log → **2**; timestamps compare lexicographically safely; garbled/missing timestamps are audited (sort to 9999-12-31), not grandfathered.
- `worktree-prep.sh`: forced failure → exit 1, full output teed and path printed; green → exit 0, log retained; `set +e` + `PIPESTATUS[0]` read is SIGPIPE/pipefail-safe; `.pi/*` gitignored.
- Docs consistent (SKILL.md step 7 mandates the guard; review-dispatch.md requires `Reviewed head:` plus a disposition line, and documents `conductor-verified:`; jev-advisory.md documents `--log`/cutoff/conductor-time).
- End-to-end: the guard run against the real PR #397 with the real CI and the cockpit log → **MERGE OK, exit 0**.
- Risk judgements: the commit-2 bisect blocks fail-closed (accepted); the one non-reproducing `1 failed/1797` is accepted (four consecutive green runs; this PR adds the evidence-retention that class needs).
- No collateral: exactly six files, no `src/`, 90/1798, `tsc`, `git diff --check`, `bash -n`; fixtures are real.

## Disposition (2026-10-28)

Merged after the guard passed on this PR (dogfood). Closes the loop for the three friction classes: prep smoke evidence retained, post-review commits gate on reviewed-head/disposition, and dispatch payloads audited for the Rule 22 line.

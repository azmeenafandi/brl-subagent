# REVIEW — PR #406 (feat/396-retry-lineage) @ `bcebc09` + conductor fix `95582e4`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` — C2, Jev **high (0.3)** (low-confidence
classification; the review depth was high). Issue #396, plan v2 (post-critique).

Reviewed head: bcebc09

**Verdict: approve-with-nits** — 3 nits + 1 info, all resolved (nits fixed in `95582e4`, mutation-free text
changes; the info confirmed intentional), so (d) clears through this disposition.

## Findings

| Severity | File:line | One-liner | Disposition |
|---|---|---|---|
| nit | session-manager.ts:276 | Store-size comment said 116 MB; the reviewer's benchmark store was ~225 MB | The **live** store is 116 MB (verified `du -sh`; 1161 records); 225 MB is the synthetic 100 KB-payload fixture. Comment now dates the live figure and names both. No wrong number. |
| nit | index.ts:3541 | "no retry lineage recorded" overclaims a windowed scan | fixed: "no **recent** retry lineage recorded (scanned the last 7 days)" |
| nit | index.ts:3569 | Window asymmetry silent: an out-of-window terminal source never gets a `Superseded by` line or a disclaimer | fixed: `Retry lineage not checked: this run started more than 7 days ago.` on the found path when the source predates the window |
| info | index.ts:3569 | Non-terminal source with a completed later attempt shows no hint | confirmed intentional: lineage is terminal-gated; the retry only fires on a settled failure, so a running source with a later attempt is a live-run anomaly surfaced by the live monitor, not this tool |

conductor-verified: 95582e4 — three text/comment fixes only (window-aware strings, found-path window note with
exported `RETRY_SCAN_WINDOW_MS/DAYS`, dated store figure); `tsc` clean; targeted 13/13; full suite
91 files / 1815; diff-check clean; no logic path changed (the note is appended to the same terminal branch).

## Verified-OK (review)

- Id form: full UUID passthrough; unique 8-hex prefix resolved **before** both `getAgent` and the lineage;
  ambiguous prefix refuses with candidates; unsafe/non-hex keeps the unchanged message; edges probed
  (old prefix, uppercase, whitespace, 7/9-hex, non-hex, running-source).
- Family: `dispatchId` one-pass matching + `resumeOf` fallback; latest = attempt/startedAt; attempt-3
  grandchild pinned; found-terminal → `Superseded by`; known-and-latest unchanged; registry text both ways.
- Bound: `statSync` first, 7-day window, cap 200, identity fields only; benchmark on a 1151-record store:
  **200 reads / ~134 ms** (full parse ~305 ms); the read-count spy pins the cap.
- 13 tests all drive the real handler with temp stores; each behaviour has a killer; literal `"99f4e815"`
  is test 1; seven mutations observed red and reverted.
- No collateral: `listPersistedAgents()` body untouched (import lines only; its comment stays true);
  suite 91/1815; `tsc`; `git diff --check`; the one earlier 1-failed singleton is not attributable to the
  new file (its 8-day mtime fixture has a 24 h margin) and did not reproduce in four runs.

## Disposition

Merged after `merge-guard.sh`. #396 closed. The next durability step is #404 (its plan v1 went to the plan
critic in parallel).

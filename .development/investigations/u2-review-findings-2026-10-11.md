# ADVERSARIAL REVIEW (C1) — PR #326 U2 (A₁) @ `a8c15d6`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` (project-reviewer, high), 2026-10-11.
Review worktree: `brl-subagent-wt-u2-review` (clean at `a8c15d6` throughout). Banked evidence: `/tmp/review-u2-findings.md`.

## Verdict: **approve-with-nits**

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| minor | `src/__tests__/background-session-persistence.test.ts` (T2) | The git-refusal, sync-throw, and `markTerminalBestEffort` prune paths share the choke point **by inspection only** — M1 witnesses just the 4 `.then`/`.catch` paths, so a future bypass of `finalizeRunEntry` on those 3 paths has no failing-test witness. |
| minor | `src/session-manager.ts:151` | `pruneBackgroundSession` recomputes from the CURRENT `STORAGE_DIR` while settle uses the captured dir — document for U3 that abandon-after-root-change no-ops at the new root and leaves old-root debris (prod-safe; only tests swap the root). |

## Verified-OK (reviewer's, condensed)

- **D1:** `SessionManager.create(cwd, per-run dir)` + `getSessionFile()` captured as live-only `_sessionFile`, stripped by `persistAgent` (single writer); SDK `create`/`open` source confirms explicit-dir persistence + first-message materialization.
- **D2:** all 8 settle paths funnel through guarded `finalizeRunEntry` exactly once; prune-first ordering beats persist throws; interrupted guard **live** (M2 kills T4); double-settle/double-prune safe.
- **D3:** torn-tail append genuinely skipped by the SDK loader (`parseSessionEntryLine` null-skip); `SessionManager.open` reloads prior entries; U1 mark intact; poller crash notices touch live-UI only, never settle/prune.
- **D4:** no persisted field; run-registry shape unchanged; no `delegate_task` surface change.
- **Path safety:** UUID validation before join/rm; basename-pair shape guard; never-throws internal vs fail-loud public asymmetry correct; symlink `rm` removes the link only (probed).
- **Failure semantics:** unreadable sessions dir makes `create` throw before any record exists — loud spawn failure, no zombie (correct expectation: FAIL, not degrade).
- **Pre-existing flag confirmed:** sync `prompt()` throw leaves `agent.status` `running` on disk while the run entry finalizes + prune runs; out of scope, prune unaffected.
- **Mutations independently re-run with pre-stated signatures:** M1 4-failed/6-passed (exactly T2); M2 1-failed/9-passed (exactly T4); M3 7-failed/3-passed (T1 + 6 sites).
- **Gate A:** tsc clean; suite **69/1439**; targeted **10/10 ×3**; docs-arch/decisions current; README 1400+ vs 1439 OK; `git diff --check` clean; `pgrep` clean; real `.pi/subagents` absent before and after.
- **SOLID/DRY violations flagged: 0.**

## Disposition (conductor)

Both nits are non-blocking and naturally belong to **U3** (which reuses `pruneBackgroundSession`):
the root-change documentation is explicitly "document for U3", and the three un-witnessed prune paths can gain per-path witnesses when U3 touches the abandon/retention surface. Recommended: merge #326 as-is; carry both nits into the U3 spec/backlog.

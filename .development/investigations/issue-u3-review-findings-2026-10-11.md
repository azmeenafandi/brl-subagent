# U3 (PR #327) — review records, rounds 1–3 (2026-10-11)

PR #327 (`feat/u3-recovery-surface`, final head `e2b4195`), merged into `dev` 2026-10-11.
Reviewer: `openrouter/meta/muse-spark-1.3-contributor` for all three rounds. Live banks were /tmp/review-u3-*.md (ephemeral).

| Round | Tip | Verdict | Headline |
|---|---|---|---|
| 1 | 74f1be4 | changes-requested | 3 criticals (one root: session-sourced surfaces blind after a real crash) + 1 major (abandon wake) + 3 minors |
| 2 | 21e243c | approve-with-nits | Fix A (on-demand registry union bridge) closes all criticals; 4 new minors |
| 3 | e2b4195 | approve-with-nits | Fix B (wake suppression, abort tally, precedence pin, docs, polish) verified; 1 docstring nit carried |

## Carried backlog nits (recorded at merge)

1. `runDisplayName` docstring overclaims naming consistency with dashboard Panel 4 (`tui.ts:1948`, slice-50, no id fallback) — cosmetic.
2. The durable registry does not persist a foreground run's `task`/`label`/`model` — root of the task-less foreground recovery caveat; persisting needs a design decision.
3. `errorCategoryBreakdown` reads the legacy `originalParams?.errorCategory` (pre-existing; a `computeSLAMetrics` cleanup candidate).
4. Metrics abort-class residual: user stops are also excluded from the failure tally (documented at `isAbortedRun`); the verifier accepted it as constrained and defensible.

---

# ADVERSARIAL REVIEW (C1) — PR #327 U3 @ `74f1be4`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` (project-reviewer, high), 2026-10-11.
Review worktree: `brl-subagent-wt-u3-review` (clean at `74f1be4` throughout). Banked evidence: `/tmp/review-u3-findings.md`.

## Verdict: **changes-requested**

## Findings

| Severity | File:line | One-liner |
|---|---|---|
| critical | `src/index.ts:4037` | Abandon's `getRun` reads SESSION entries that never carry `interruptedAt`, so production abandon silently returns false. |
| critical | `src/state.ts:130,148` | History collapse + retry menu read unmarked SESSION entries → interrupted runs are invisible and unoffered after a real crash (the tests mask this by seeding marked entries into the session). |
| critical | `src/index.ts:3978` | The boot mark writes the registry + agent record only, never a **session clone**, starving all three session-sourced surfaces; the fresh-session notice names an id that `retryRunId` then rejects as not found. |
| major | `src/index.ts:4042` | Abandon emits `subagent:stopped` → fires a completion wake for the run just abandoned (the fresh-boot claim set is empty, so the #315 dedupe cannot suppress it). |
| minor | `src/metrics.ts:63` | Abandoned runs count as `failed` in SLA/dashboard tallies (`aborted` only in `errorCategory`). |
| minor | `src/recovery-surface.ts:82` | Registry-over-run posture precedence unpinned — the reviewer's precedence-swap mutation passed the suite. |
| minor | `AGENT.md:71`, `README.md:115` | Docs promise history visibility + menu abandon that do not hold post-crash. |

**Shared root cause of the three criticals:** U3's surfaces are SESSION-sourced, but after a genuine crash + fresh boot the interrupted run exists only in the registry + agent record. The tests seed marked entries into the session, so the production path (P1) was never exercised. Proven with a realistic post-crash scratch script: **0 history rows, 0 retry rows, abandon → false**.

## Verified-OK

- **D2 delivery:** SDK `nextTurn` queues without consulting `triggerTurn` (`agent-session.js:1792`) — never steers; once-per-boot guard + shutdown reset; config-off + per-run-off gates; empty-silent; scan-failure isolation all present.
- **D4 threading:** all five dispatch sites snapshot the posture; registry round-trip preserves it; guards reject junk/`auto`; config persist/restore/reset + selector + reserved name + README row.
- **D3 core:** `retryRunId` resolution is status-agnostic and works in the resume case; `newDispatchIdentity` unaffected.
- **D7:** all three prune witnesses non-trivial (dir exists before the failing step); STORAGE_DIR-change debris boundary honestly documented.
- New module has its `Purpose` header; arch map regenerated (40 modules); no notice-machinery duplication (shares only the `DeliveryResolution` type).
- **6/7 independent mutations caught** with pre-stated signatures (gate-order, absent→offer, collapse exception, skip-retire, config-off gate, once-per-boot); the 7th (posture precedence swap) exposed the minor above.
- **Gate A:** tsc clean; suite **71/1467**; targeted 38 ×3; docs guards current; README guard OK; `git diff --check` clean; worktree clean; no `.pi`/`~/.pi` debris.
- **SOLID/DRY violations flagged: 0.**

## Fix directions (conductor's reading, for the user loop)

- **Fix A — the three criticals (one root):** make interrupted runs visible to EVERY surface after a genuine fresh boot — the boot mark must produce a session-visible representation (a deduped "session clone" of the interrupted run entry) OR the surfaces (history collapse, retry menu, abandon lookup, `retryRunId` resolution) must union the registry/agent records for interrupted ids. Requirement, however implemented: after a real crash + fresh boot, the interrupted run is (1) listed as `Interrupted`, (2) offered in the retry menu, (3) abandonable, (4) resolvable by the id the notice names. **Tests must exercise the REAL path** (no seeded marked session entries) and fail under a mutation that removes the visibility bridge.
- **Fix B — major + minors:** suppress (or explicitly claim) the abandon wake; settle the abandoned-run metrics representation (not silently `failed` in SLA/dashboard); pin the registry-over-run posture precedence with a failing test; correct or fulfill the docs claims (they become mostly true after Fix A).

---

# VERIFICATION (Fix A round) — PR #327 @ `21e243c`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` (project-reviewer, high), 2026-10-11.
Review worktree: `brl-subagent-wt-u3-review2` (clean at `21e243c` throughout). Banked evidence: `/tmp/review-u3-fixA-findings.md` (55 lines).

## Verdict: **approve-with-nits** — all three round-1 criticals CLOSED.

## Findings (all minor)

| Severity | File:line | One-liner |
|---|---|---|
| minor | `src/tui.ts:1164,2067` | Display fallback `r.label \|\| task.slice(0,60) \|\| id.slice(0,8)` duplicated ×2 — extract a helper. |
| minor | `src/index.ts:4014` | `visibleRunsFor` redeclares the `getAgent` shape inline instead of importing `RecoveryAgentLookup`. |
| minor | `src/recovery-surface.ts:283` | Notice copy doesn't hint that a task is required to retry task-less (foreground) rows. |
| minor | `src/recovery-surface.ts:160` | `getAgent` throw propagates (no degrade) — pre-existing store-read shape, NOT a Fix A regression. |

## Verified-OK (critical closure)

- **M1 (bridge → identity, scratch): 6 failed / 3 passed at exactly `:117`/`:131`/`:151`/`:172`/`:251` + `recovery-retry-after-boot.test.ts:225`** — claim confirmed byte-for-byte.
- **M2 (dedupe/terminal guard dropped): 2 failed / 5 passed at exactly `:200`/`:224`** — confirmed.
- **M4/M5 regions:** `recovery-surface.test.ts` 19/19, incl. `:306` posture + `:377`/`:384` abandon idempotence — holds.
- **Bridge robustness (scratch 5/5):** unmarked rows skipped; missing agent → `task:""` synthetic, no throw; multi-id registry order + duplicate dedupe; by-ref identity when empty AND no in-place mutation when augmenting; terminal suppresses the synthetic; repeated reads stable.
- **Option-(a) rejection rationale verified in source** (`src/recovery.ts:10-11` never-re-mark + the `performBootRecovery` mark path) — the on-demand bridge is the correct shape.
- **E2E non-tautology:** forcing a task-less synthetic FAILS `recovery-retry-after-boot` at `:225` — the test genuinely depends on the bridge-carried task.
- **Foreground crash judged an acceptable boundary:** the notice is honest (`(unlabeled) · (task unavailable)`); a bare `retryRunId` fails LOUD (`Invalid task`, not "not found"); retry WITH a task passes resolution + sanitizer; abandon works via `isInterruptedRun`. **No design change required.**
- No regressions (delta removes 4 lines only — doc/import/type-shape; `nextTurn` delivery + posture filter untouched).
- **Gate A:** tsc clean; suite **73 files / 1476 passed** (exact match); targeted recovery set **33 ×3**; broader recovery set (7 files/120) ×3; README guard 1400+ vs 1476 HOLDS; docs-guard tests green; `pgrep` clean; worktree + real stores untouched (all mutations under `/tmp/mut-fixA-*`).
- **SOLID/DRY violations flagged: 0.**

---

# VERIFICATION (Fix B round) — PR #327 @ `e2b4195`

Reviewer: `openrouter/meta/muse-spark-1.3-contributor` (project-reviewer, high), 2026-10-11.
Review worktree: `brl-subagent-wt-u3-review3` (clean at `e2b4195` throughout). Banked evidence: `/tmp/review-u3-fixB-findings.md`.

## Verdict: **approve-with-nits**

## Findings (single minor)

| Severity | File:line | One-liner |
|---|---|---|
| minor | `src/tui-format.ts:52-56` | `runDisplayName`'s docstring claims both surfaces "can never name the same run differently", but dashboard Panel 4 (`src/tui.ts:1948`, slice-50, no id fallback) still names the same runs differently. The docstring overclaims about a surface this PR did not change. |

## Verified-OK

- **Wake suppression is deterministic, not racy:** `abandonInterruptedRun` pre-claims (`:345`) before `markAgentStopped` (`:346`); `updateAgentStatus` emits synchronously (`session-manager.ts:299`), `eventBus.emit` invokes listeners synchronously, `deliverCompletionAlert` claims synchronously at entry (`index.ts:4204`) → the wake gate loses. Per-id scoped, idempotent, only 3 claim sites; normal stops never pre-claim; a no-op abandon never claims.
- **Metrics abort exclusion judged honest:** before/after proven empirically (fixture failureRate 0.8→0.5; a pure done+userStop mix 0.5/0.5→1.0/0.0). Over-broadness vs the finding is dual-documented (predicate + tally), constrained (identical record shapes; pure function; D5 marker ban) and defensible (user stops are not reliability failures). The breakdown still surfaces `originalParams`-carried aborts — residual accepted, no finding.
- **Posture precedence pinned** both directions + the fallback; a seed-swap kills exactly the two direction tests.
- **`isAbortedRun` single-owner:** lives in ratchet-exempt `types.ts`; `"aborted"` is in the ratchet's `FAILURE_REASONS`, so any private copy outside `types.ts` fails the structural guard; `metrics.ts` carries no abort literal.
- **`getAgent` degrade:** the try wraps only the agent read; `catch → null` is exactly the missing-agent path.
- **Docs accurate:** post-crash reconstruction (4 consumers via bridge + agent-record enrichment), no-wake-on-abandon, the fg task-less caveat with exact `(task unavailable)` copy matching `recovery-surface.ts:253,277`; no contradiction with `AGENT.md:44`.
- Items 5–6 verified (`runDisplayName` at both sites + tests; `RecoveryAgentLookup` type-only import).
- **Fix A closure intact** (bridge→identity kills 5 tests); D2 delivery untouched.
- **7/7 mutations with exact pre-stated signatures:** wake 1, metrics 1 (0.8 received), precedence 2, item-8 1, bridge 5, **M4 2**, **M5 1**.
- **Gate A:** tsc exit 0; full suite **73 files / 1488 passed ×3**; targeted 61 ×3; docs guards 11 passed; README guard PASS (1400+ vs 1488, drift 88 ≤ 100); `git diff --check` clean; worktree clean after every mutation restore; no lingering workers; `.pi/**` and real stores untouched.
- **SOLID/DRY violations flagged: 0.**

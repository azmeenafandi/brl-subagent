# #453 implementation brief (revision 2) — one owner for the background deadline

**Issue:** #453. **Risk:** C1. **Decisions:** ADR 0023. **Evidence:** the #453 dossier.
**Revision 2** — folds in the plan critique (`needs-work`, 3 blockers + 5 majors). Items marked `[c N]`
are acceptance criteria, not suggestions. **Do not start until #439 and #447 are merged**, then redo Step 0
against the real tree.

## Step 0 — preconditions (ordering, not symbol presence) `[c 6]`

Record the merge commits of #439 and #447, then verify the *sequence* in `spawnBackgroundSession` and in
`startBackgroundAgent`: arm → registration/increment → record creation → transcript → **prompt** →
record settlement. Read the actual lines (they moved under #439/#447) and paste the ranges into the PR
body. Also run the three deadline suites and record the count. Stop if the arm site, the acceptance
marker, or the containment groups are not where this brief says.

## Step 1 — one arm site

Delete the caller's 30-minute timer in `startBackgroundAgent` **and its three `clearTimeout(hardCapHandle)`
sites**; delete `deadlineOwner` (both the field and the `"caller"` call site). The spawn arms the
no-timeout default always; keep #448's sync-throw clear untouched.

`[c 5]` Name, in the PR body, what each caller-timer duty becomes — measured today:
- **output capture + live-row finalize + repaint + `failedSubagents++`** on the deadline path: the
  poller already owns these for the *explicit-timeout* shape (the dossier's F1.6 measurement, which is
  the exact shape being generalised). Prove the same path works with the default budget: a poller that
  observes the spawn-stopped agent must self-terminate, finalize the live row and repaint.
- **poller clearing on deadline**: the poller is caller-owned and the spawn cannot clear it; the poller
  must exit on the terminal agent state on its next tick (assert it does, and that it does not spin).
- **a throw after the counter increment but before the poller exists**: cannot strand the counter any
  more — #439's G1/G2/G3 containment + `releaseLiveCount` covers it; assert with a throwing
  registration that the counter returns to zero.

**Tests:** arm census with a **frozen clock** `[c 8]`: a dispatch and a direct spawn each arm exactly ONE
deadline (delay == budget) — count *deadline arms*, not all timers. The F1.4 caller-tail-throw harness:
the abort still fires at the deadline. Delete the four superseded #448 ownership tests **and update the
existing direct-spawn test that asserts "no deadline-time append"** `[c 9]` — name both in the PR body.

## Step 2 — the timer writes the record, never prunes; the vocabulary is the run entry's

`[c 2]` **`status: "stopped"` does not exist for a `SubagentRun`** (`running | done | failed`; the shape
guard rejects anything else). So:
- the **agent** keeps `stopped` (unchanged, written by the existing deadline bookkeeping);
- the **run entry** the timer writes is `status: "failed"` with `errorCategory: "timeout"` and the
  timeout message. This is the classification snapshot; it must pass `isSubagentRunShape`.

`[c 1]` **State the durable contract exactly, then test each surface:**
- the timer writes the terminal run entry; `persistRunRecord` clears the **registry** entry (accepted:
  the registry means "an owner may still be running" and a terminal classification ends that claim);
- the timer **never** deletes the session directory — it survives even process exit (measured), and the
  retention sweep only selects marked retained dirs;
- a never-settling run therefore keeps: its session dir (forever), its branch lock (until process
  exit), no registry entry, one `failed/timeout` run entry. That is the documented limit; the CHANGELOG
  says it.

`[c 5]` **Flag transitions and the failure contract:** set `entryWritten` only **after** the append
resolves (so a later settle can still classify); a throwing append must not suppress the abort (the
abort block stays outside it), must not prune, and must leave the run visible as `failed/timeout` once
the settle repairs it. Test: append throws → later cooperative settle writes the terminal entry exactly
once; and a never-settling run with a throwing append still ends the agent `stopped`.

`[c 7]` **Retention invariant:** a deadline-stopped run classifies from the timeout error, which is not
transport-retryable, so it is **not** retained for retry. Pin that with a deadline followed by a
transport-shaped settle: the retention rule must not fire on the timeout classification, and the settle's
true category is what readers see. Keep the prune decision in the settle, from the true category.

**Tests:** dir survives the deadline; a later cooperative settle prunes it; exactly one terminal append
across timer + settle; the registry is cleared at the deadline (assert it); throwing append cases above.

## Step 3 — one logical run for every raw-entry consumer `[c 3]`

`findLast` alone does **not** fix the metrics: `computeSLAMetrics`, cost governance, history and the
report surfaces read **raw entries** and will double-count a snapshot + amendment (measured: 3 runs, $5
for a $2 + $3 pair), and history truncation can drop the amendment before resolution.

So:
- Add **one** projection helper (e.g. `projectLogicalRuns(entries)`) that groups entries by run id in
  order and yields one logical run per id: the **last** classification (`status`/`errorCategory`) plus
  the **amended payload** (cost/usage/output/final detail). Export it from the same module as
  `resolveTerminalRunEntry` and use it in every raw-entry consumer (`metrics`/SLA, cost accounting,
  history listing, reports).
- `resolveTerminalRunEntry`: `find` → **`findLast`** for the non-running entry (single-id resolution).
- **Apply the projection before any window/limit** (history cap, report window) — the amendment must
  never be windowed away from its snapshot.
- The amendment itself must remain a valid full entry (`isSubagentRunShape` passes): same id, same
  classification fields, payload updated; never a second classification *claim*.

**Tests:** snapshot $2 + amendment $3 → one logical run, $5 total (metrics, cost, history, report);
three-entry resolution picks the amendment; a capped history keeps snapshot+amendment together; a
two-entry run is unchanged; `status`/`errorCategory` are not rewritten by the amendment; `[c 4]` a late
settle with output produced **after** the deadline carries that output in the amendment (the stopped
settle finalizes before capturing output today — fix the order at the settle site).

## Step 4 — time origin

`[c 8]` The timer's argument is used for BOTH the delay and the reason string. Separate them:
`armDeadline(budgetMs, delayMs)` — the reason always names `budgetMs`, the delay is
`Math.max(0, budgetMs - (Date.now() - startedAtMs))` (`startedAtMs` is the **epoch-ms agent field**, not
the ISO run-entry field — verify which each site reads). A zero remainder still aborts, and the reason
still reports the full budget.

**Tests:** an injected setup delay shortens the armed delay by exactly that amount while the reason stays
the full budget; zero remainder aborts immediately with the full-budget reason.

## Step 5 — the written contract

`armDeadline`'s doc comment carries the contract: the deadline owns no filesystem or git resource, waits
for no settle, never prunes or releases the branch lock; only a settle does. CHANGELOG: one arm site; the
timer writes a `failed/timeout` snapshot but never prunes; a late settle amends the payload; one logical
run per id in every reader; the budget is anchored at record creation; **limits that remain** — abort is
cooperative, a never-settling run keeps its session dir, its branch lock (until process exit) and no
registry entry. #448's "a caller throw leaves the run unbounded" limit is removed.

## Mutants — each with a discriminating killer `[c 9]`

| # | Mutation | Killer (must fail) |
|---|---|---|
| M1 | re-arm in the caller (two arm sites) | arm census on a **real-spawn dispatch** — two arms |
| M2 | deadline write prunes | dir-survives |
| M3 | `entryWritten` set before the append resolves | later cooperative settle does not write the terminal entry (append-throw test) |
| M4 | collapse `entryWritten`/`pruned` into one flag | a successful timer write suppresses the settle's prune |
| M5 | `find` instead of `findLast` | three-entry resolution |
| M6 | drop the projection (raw entries) | one-logical-run: 1 run/$5 vs 2-3 runs |
| M7 | amendment is a second classification claim | exactly one `failed/timeout` classification across entries |
| M8 | origin = now (ignore elapsed) | injected-setup-delay |
| M9 | reason reports the remainder | zero-remainder reason still names the full budget |
| M10 | abort suppressed by a write failure | the #448/#439 abort-independence test stays green |

## Budget

Measured on `40f5f8e`: 47,539 test / 24,057 source (1.9761) → **~701 test lines** of headroom if source
grows by 95 and tests are not removed; recalculate on the post-#439/#447 tree and on the final report.
Step 1 deletes ~80 source and ~96+ superseded test lines. Report the real delta.

**Non-goals:** the branch-lock convoy (#460), #439's containment (already merged), #447's marker, a
fourth display status, the foreground path.

**Gates from ONE JSON report:** `npx vitest run --reporter=json --outputFile=/tmp/vitest-453.json`,
`node scripts/check-test-budget.mjs /tmp/vitest-453.json`,
`node scripts/check-readme-test-count.mjs /tmp/vitest-453.json`, `npm run typecheck`,
`node scripts/docs-arch.mjs`, `node scripts/docs-decisions.mjs`, `git diff --check`.

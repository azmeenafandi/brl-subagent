# #448 plan critique — second pass (narrowed brief), 2026-11-07

> Transcribed by the conductor from the critic's completion message (`9c76f4e0`, terra, xhigh, 5m44s,
> $0.395). No `write` tool, so the `/tmp` original does not exist; the text is verbatim where given, and
> the mutant section is truncated where the completion message cut off.

Verdict: needs-work

Base verified: HEAD `5edcc60`, clean tree; `git diff --name-only 1639fab HEAD -- src package.json package-lock.json` empty. Node 24.14.1, Vitest 5.1.0, SDK 1.5.0.

| Severity | Plan location | Gap | Evidence | Suggested fix |
|---|---|---|---|---|
| **blocker** | Brief:22–34, 61–62, 81 | **Defect A still presupposes a broken aborted-settle branch.** Variant C's prompt **never settles**, so that branch is never reached. When it does settle, the existing helper already finalizes. Unconditional finalization at timeout conflicts with abort-only. | **Measured:** real parent-session JSONL: pending → `["running"]`; cooperative abort → `["running","failed"]`. **Read:** `session-manager.ts:1794–1828,1965–1990`. | Decide whether to defer the nonsettling residue to #453 or revisit the lifecycle design. Require separate pending and cooperative tests; do not claim the measured variant is fixed by changing its nonexistent settle path. |
| major | Brief:9–12, 49–52, 88 | **Caller ownership preserves the caller-throw hole:** the spawn declines the default arm before the caller has armed it. The brief names the path but does not say it stays unbounded. | **Measured:** with the proposed owner flag: `timers:0`, `abort:0`, `status:"running"` after a post-spawn caller throw. | Explicitly defer that deadline hole — not merely the misleading notice — or require an ownership handshake. |
| major | Brief:13–15, 53–54, 65–66, 84–87 | Abort-only prevents **timer-side** pruning but does not guarantee prune safety: abort can settle the prompt, whose existing settle path prunes and releases the branch lock, and the new direct deadline can reach that path where none fired before. | **Measured:** a synthetic detached writer holding the real SDK session got `ENOENT` after settlement. Not established that the real SDK leaves such a writer. | State the residual risk; test "no prune while prompt remains pending" separately from expected settle cleanup. |
| major | Brief:26–27, 35–37, 53–54 | **"The timer callback is not at fault" misses a real abort-suppression path:** transcript I/O happens before abort inside one `try`; mirroring W3 propagates it to the new deadline. | **Measured:** real transcript `EISDIR` → `stopped`, `abort:0`. **Read:** `session-manager.ts:1928–1943`; `transcript.ts:113–128`. | Keep status-before-abort, but make abort independent of fallible bookkeeping. Falsify with a real throwing transcript append. |
| major | Brief:35–37, 63–64, 76 | **The "measured today" terminal-append result came from a mutated timer-side finalize**, not current code. Baseline cooperative fault → `abort:1`, entry `running`, registry absent. | **Measured:** `diff -u` shows the injected finalize; baseline cooperative fault gives `abort:1`. | Correct provenance and specify an observable diagnostic and recovery-residue contract; the fault test must reach and throw on the terminal append. |
| major | Brief:55–57, 69, 78 | **M4 is only killable if arming precedes `prompt()`** — the brief never chooses that ordering. | **Read:** `:1901–1912,1926–1949,2099`. **Measured:** pre-arm scratch: cancellation → zero timers; omitted → one timer, stopped, abort once. | Pin pre-prompt arming and clear in the existing catch **before** fallible cleanup/finalization, or permit post-prompt arming and mark M4 inapplicable. |
| minor | Brief:72–80 | The ~250-line limit is unsubstantiated and conflates total additions with the test/source ratio. | **Measured:** 23,769 source / 46,995 test = 1.977; headroom 543 **plus twice any added source**. Estimate ≈60 fixture + 150 acceptance + 10 rewrite + 40 fault/owner matrix = **~260 test lines**, plus ~40 source. | Treat ~300 total as an estimate, not a coverage-cutting cap; run the real final-tree gate. |
| optional | Brief:79 | "Both docs guards" does not name the read-only checks; the similarly named npm scripts use `--write`. | **Read:** `package.json`, `scripts/docs-{arch,decisions}.mjs`. | Name `node scripts/docs-arch.mjs` and `node scripts/docs-decisions.mjs`. |

## First-pass closure

| First-pass item | Status | Evidence |
|---|---|---|
| Ordinary dispatch overstatement | **Partial** | Ordinary control stopped, abort 1, wake 1; direct no-timeout and caller throw had abort 0 — the latter remains uncovered by the owner split. |
| Timer finalize/prune lifecycle | **Partial** | Timer-side finalize forbidden; settle can still prune with a synthetic detached writer. |
| Caller-owned cleanup | **Closed for narrowed scope** | Caller retains `index.ts:2051–2250`; handshake deferred. |
| Sync-throw leak | **Partial** | Both settle handlers clear W3; the sync catch has no handlers attached — requirement present, ordering/M4 undecided. |
| Old M2 ordering claim | **Closed for narrowed scope** | Former pre-prompt-ordering mutant no longer asserted as a caller-throw kill. |
| Abort suppressed by finalize failure | **Partial** | Replacement M2 is killable, but its `abort:0` evidence came from a mutation, not baseline. |
| Double-arm analysis | **Closed for enumerated callers** | Integrated owner control counted one deadline; ignoring ownership counted two. Does not close caller-tail failure. |

## Call-site census (read)

`rg -n '\bspawnBackgroundSession\s*\(' src --glob '*.ts' --glob '!**/__tests__/**'` finds **one production
invocation** (`src/index.ts:2010`) plus the declaration. It must pass `"caller"`; single dispatch, fan-out
(`:1892`), manual retry and transport retry (`:4262`) all reach that shared site. Explicit timeouts still use
W3. Default `"spawn"` is safe for these callers **only if** that site opts out; omitting it double-arms.

Under `src/__tests__`: **106 direct expressions in four files** — `session-manager.test.ts` 85,
`background-session-persistence.test.ts` 19, and one each in `engineering-bar.test.ts` /
`empty-tools-background-442.test.ts`. They normally use the spawn default; caller-owner cases should opt out
explicitly. `git grep` also finds `.development/investigations/repro/issue-449/repro.test.ts:211`.

## Mutants (measured, truncated)

- **M1:** existing `session-manager.test.ts:1914–1941` passed baseline and failed when the aborted helper's
  finalize was removed. It tests **cooperative settlement, not variant C**.
- **M2:** the cooperative terminal-append fault test passed baseline and failed when finalize was inserted
  before timer abort — a meaningful *prohibited-transformation* kill.

## What must change

1. Resolve the nonsettling-record and caller-throw scope decisions.
2. Specify the pending-versus-settled pruning boundary.
3. Correct the append-failure provenance and the reporting contract.
4. Pin timer ordering or revise M4.
5. Add the transcript-I/O abort falsifier.

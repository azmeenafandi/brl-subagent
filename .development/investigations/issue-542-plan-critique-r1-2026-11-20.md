# #542 plan critique — round 1 (2026-11-20)

Critic: `critique-542-r1` (`project-plan-critic` + `openrouter/openai/gpt-6.1-terra`, pinned
`thinkingLevel: medium`). Plan under review: `issue-542-pre-start-agent-record-spec-2026-11-20.md`
at `2c0b1c5`. The dispatch was read-only, so this record is the conductor's transcription of the
critic's returned findings (the critic wrote nothing to the repository).

**Verdict: `needs-work`** — 3 major, 3 minor. The design direction (one shared per-step-contained
three-write helper) survives; the **write order**, the **crash contract**, and the **test set** do not.

## Findings

| # | Sev | Plan location | Gap | Evidence (command + result) | Fix |
|---|---|---|---|---|---|
| F1 | **major** | Design assumptions — crash window | The claimed boot recovery after record A but before run-entry B is **false**: recovery skips a terminal agent, leaving its registry entry and never finalizing its run. The window already exists for branch refusals; Option B adds it to three pre-start paths. | Archived scratch tree, `npx vitest run src/__tests__/zz-542c.test.ts --reporter=dot` → `BOOT_FAILED_AGENT_FINALIZED=0 REGISTRY_REMAINS=true`; the same dead-owner, `acceptedAt:null` fixture with a **running** agent → `BOOT_RUNNING_AGENT_FINALIZED=1`. | Resolve the crash consistency **in-plan**. Pin restart behaviour after A and before B, including null and non-null acceptance states. Falsifier: a terminal agent with an unfinalized run after recovery. |
| F2 | **major** | Write ordering — reentrancy | “No await” does not exclude **synchronous reentrancy**: the `subagent:failed` event is emitted before B, and a listener can change state used by B's prune gate. | Same scratch test printed `LISTENER_LAST_RUN=running`; after a synchronous listener marked the agent interrupted, `SESSION_DIR_EXISTS=true`. `finalizeRunEntry` gates pruning on `!agent.interruptedAt` (`src/session-manager.ts:1754`). | State the listener-visible ordering and retention contract, and test it. Falsifier: a listener mutation changing the intended pre-start retention outcome. |
| F3 | **major** | Tests T3, T6–T8; acceptance 4, 10 | The tests do not establish all advertised containment and branch-release properties. T7 and the only branch-refusal pin are **optional**; the measured T3 helper uses `.find()`, which cannot prove exactly one transcript note. | `src/__tests__/session-manager.test.ts:3748` checks the finalize-fault log and registry retirement, **not the subsequent transcript**. The probe's `zz-542.test.ts:189-198` returns the first matching note. The six tests exercise the mocked A fault, not a B fault followed by C. | Behavioural pins for **B-fault continuation**, **C-fault release + original error**, **both branch sites**, and an **exact transcript-note count**. Falsifiers: skipping C after B throws; retaining either refused session; writing two notes. |
| F4 | minor | R1 | “`updateAgentStatus` is total today” is too strong: a listener throw is caught, but the catch's **logger** can itself throw. | Scratch test with a throwing listener **plus** a throwing `console.error` made the real `emit` throw `sink blew`. | Qualify R1: ordinary listener exceptions are swallowed **unless error reporting itself throws**. Keep per-step containment. |
| F5 | minor | Mutant M5 | The stated M5 kill does not prove a properly contained `finally` is detected; the recorded mutant removes the catch as well. | `mutants.py` replaces the catch with `finally`; a mutant retaining the catch and moving release into `finally` yielded `6 passed`. | Correct the mutant description and result; do not claim T6 pins release placement. |
| F6 | minor | Execution sketch; delta | The real worktree suite is acknowledged as necessary but omitted from the steps; +128 test delta is an estimate, not an integrated diff. | `git diff --no-index --numstat` → `46 25`; allowance `120 + 2×21 = 162`, leaving 34 lines at +128 and 4 at +158. The saved failure-name files each have 69 lines, `diff -q` identical. | Add the real-worktree full suite as a gate; recompute flow from the final integrated diff. Do not report the `/tmp` comparison as a green suite. |

## Verified sound

- **R2** reproduced: `completeTranscript` on a directory returns `EISDIR` (not total).
- **R4** reproduced: `SESSIONREF=set` on **both** baseline branch-refusal sites, `unset` with Option B.
- **R3**: Option B against the untouched full file → `1 failed / 138 passed`; the tripwire's transcript assertion fails. Inverting the two terminal-output assertions while keeping its settle-entry marker, positive control and timer assertions **preserves its intent**.
- The six prescribed tests fail on the baseline and pass against the scratch Option B; the helper is local with two branch call sites and initialises above transcript start; no exported rename.
- **Split recommendation:** keep the branch-refusal release and its pins in this unit (the shared helper touches those sites). Resolve the crash window **before implementation**; if the remedy exceeds this unit, record and link a separate issue rather than claiming recovery exists.
- SOLID/DRY: 0 violations in the proposed shape (no implementation diff yet).

## Conductor decision (2026-11-20) — in-plan, r2

- **F1 + F2 share one remedy: swap the write order to run entry → record → transcript** in the
  shared helper (both paths). A kill between the writes then leaves a **running** agent with a
  terminal run entry — the state boot repair already handles — instead of a terminal agent with an
  unfinalized run. And the `subagent:failed` event (emitted by the record flip) then fires **after**
  the run-entry prune decision, so a synchronous listener cannot change the retention outcome.
  The proposer must **measure** both effects (a kill after B; a listener mutating `interruptedAt`)
  and pin them. If the swap does not close the crash window, file the recovery extension as a
  separate issue and record the window explicitly — do not claim recovery.
- **F3**: make every pin mandatory; add the B-fault and C-fault cases, both branch sites, and an
  exact note count (`filter(...).length === 1`).
- **F4, F5, F6**: adopt as stated.

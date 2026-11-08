# #448 plan critique — 2026-11-07

> Transcribed by the conductor from the critic's completion message (`1b07f8e3`, model
> `openrouter/openai/gpt-6.1-terra`, xhigh, 4m35s, $0.284). The critic has no `write` tool and the
> transcript retains only start/settle markers, so the original `/tmp` record is gone; the text below is
> verbatim where it was given, and the final section is marked as truncated at the point the completion
> message cut off.

Verdict: needs-work

Base verified: `git rev-parse HEAD` = `f42f55c`; `git diff --stat a39b63d HEAD` shows only the brief and
`git diff --quiet a39b63d HEAD -- src package.json package-lock.json` exits 0 — the probed implementation
matches the stated base.

| Severity | Plan location | Gap | Evidence | Suggested fix |
|---|---|---|---|---|
| **blocker** | Brief:24–33 | **Defect 1 is overstated.** A never-settling **ordinary dispatch** with no timeout *does* have the caller's 30-minute deadline. The missing deadline reproduces for a **direct spawn** or a **caller-tail throw**. The brief says to stop if a defect fails. | **Measured:** `/tmp/brl448-critique-Ic56pF` → `DIRECT-NO-TIMEOUT`: zero timers, running, abort 0; `CALLER-CONTROL`: stopped, abort 1, one wake. Both retained a `running` run entry. | Stop implementation against the current wording. Narrow defect 1 and its acceptance control to the actually uncovered paths. Falsifier: a successful ordinary dispatch does not arm or fire its default timer. |
| **blocker** | Brief:37–48, 90–94 | **Finalizing the run is not equivalent to stopping the SDK.** A non-settling prompt can keep writing or retain a git branch lock after `abort()`. Calling `finalizeRunEntry` immediately also prunes the session directory. The brief promises finalization, later settle output and no settlement restructure without deciding this lifecycle. | **Read:** `session-manager.ts:1454–1555,1715–1828` ties finalization to pruning and the once-only guard. **Measured:** a real SDK `SessionManager` append after its session dir was removed failed `ENOENT`. | Decide and document what remains live after a cooperative abort, when pruning and branch-lock release are safe, and whether the terminal record is a snapshot or may be amended. Falsify with a still-writing session, late settlement and real branch cleanup. Do not claim the work is bounded because its record is terminal. |
| major | Brief:42–48, 60–74 | Moving the timer loses caller-owned work: poller clearing, final-output capture, live-row claim, active-count decrement, repaint. A claim alone does not prove this run was counted; caller failure can occur before registration or after counting but before poller creation. | **Read:** registration/count at 2051–2068, poller at 2074, cleanup at 2202–2250. **Measured:** an unregistered id gave `claimed=true`, `registered=false`, and decremented a sibling's count from 1 to 0. | Require a registration/count ownership handshake and preserve each caller responsibility, including partial tail failure. Falsify with throws before registration and after increment, alongside a live sibling. |
| major | Brief:37–39, 53–54 | Arming before `prompt()` adds a **synchronous-throw cleanup path** the brief omits: both promise handlers cannot clear a timer if they never attach, and `completedAt` is not set on the current sync-throw path. | **Measured:** after a rejected spawn, one timer remained; it later flipped the agent to `stopped` and called abort, while entries were `running, failed`. | Require timer cancellation on synchronous prompt failure and a regression test. Falsifier: advance past the deadline after a rejected synchronous spawn and observe any abort or status change. |
| major | Brief:75–80 | **M2 is not killed** by the proposed caller-throw test: an arm placed after handler wiring but before the spawn returns still precedes the caller throw, so it tests ordering, not the R3 outcome. | **Measured:** the relocated arm fired after R3 (`timers=1`, `stopped`, `abort=1`). | Replace M2's claimed kill with an assertion inside the controlled `prompt()` that the deadline was already armed. M1/M3/M4 are plausibly distinguishable; none was run as a full implementation mutant. |
| major | Brief:44–48, 60–65 | A naïve timer-side finalize can **prevent abort on persistence failure** and lose recovery evidence: the guard is set before the write, and registry removal precedes the session append. | **Measured:** a scratch timer-side finalize with a throwing terminal append produced `stopped`, `abort=0`, entry `running`, registry absent. **Read:** `run-registry.ts:326–332`; `session-manager.ts:1460`. | Specify best-effort ordering and the persistence-failure contract; abort must be attempted independently of finalization. Falsify with a throwing terminal append and verify abort, recoverability and retry behaviour. |
| major | Brief:44–48, 60–67 | "Final output as today" is underspecified for a deadline that finalizes before an uncooperative prompt settles: `finalizeRunEntry` snapshots `agent.finalOutput` once; a later capture cannot update the entry. Counting all timers also gives false positives from poller/footer. | **Read:** `session-manager.ts:1454–1464,1530–1555,1824–1828`; `index.ts:2074,2210–2218`. **Measured:** a normal caller control had **three** timers, not one deadline. | Define the terminal snapshot and late-output policy. Count **deadline arms**, not all timers, through an integrated harness. |
| major | Brief:68–74, 84–94 | **Compatibility and user-visible change understated:** a formerly unreachable run will now receive an abort; an existing direct-spawn test explicitly expects no default timer; wake delivery depends on an active runtime, not merely a timer. | **Read:** `session-manager.test.ts:799–814` expects no timer for zero timeout; `index.ts:4178–4190,4294–4300`; `README.md:14,93,321` ("nothing leaks"). | Explicitly authorize changing the obsolete test and document the newly reached abort and the cooperative-abort limitation. Scope wake acceptance to an active subscribed runtime. |
| minor | Brief:18–20, 53–54, 81–83 | Wrong anchors: the run entry has **no** `timeoutMs` (the agent record does); **both** `.then` and `.catch` clear the W3 timer. The under-200-line budget is an estimate with no integrated fault/persistence coverage. | **Read:** `rg -n 'timeoutMs\|clearTimeout\(timeoutHandle\)'` → agent field, clears at 1949/2099. **Measured:** 46,995 test / 23,769 source = 1.977; headroom 543 before source changes. | Correct the anchors. Estimate **220–350** incremental lines with shared fixtures; under 200 is possible but unproven. Replace obsolete timer-owner tests before cutting behavioural cases. |
| minor | Brief:37–41, 49–52 | **The deadline's time origin is silent.** The monitor displays `agent.startedAt + timeoutMs`, but `startedAt` is recorded before branch setup and possible lock waiting. | **Read:** record creation at 1387, display deadline at 2062, branch-lock wait from 1646. | Define whether the budget starts at record creation or immediately before prompt, and align the displayed deadline. Falsify with a delayed branch-lock acquisition. |

## Verified sound

- **Q1 — reproduction and provenance.** HEAD `f42f55c`; the diff vs `a39b63d` is the brief only, so the probed implementation matches the stated base. The explicit-timeout and caller-throw defects reproduced; **the unconditional no-timeout claim did not.**
- **Q2 — seam recommendation.** *[truncated in the completion message at "Require the s…"]*

## Open questions left to the maintainer

- When abort does not make the prompt settle, which resources remain owned, and what later event is allowed to prune the session and release its branch lock?
- Is the finalized run entry an immutable deadline-time snapshot, or should late settlement amend its output and usage?

## Probe harness recipe (from the critique)

```bash
local P="$1"; shift
(cd "$P" && env -i PATH=/usr/local/bin:/usr/bin:/bin \
  HOME="$P/home" PI_CODING_AGENT_DIR="$P/agent" TMPDIR="$P/tmp" \
  ANTHROPIC_API_KEY=fake OPENAI_API_KEY=fake \
  ALL_PROXY=http://127.0.0.1:9 HTTPS_PROXY=http://127.0.0.1:9 \
  HTTP_PROXY=http://127.0.0.1:9 NO_PROXY=127.0.0.1,localhost CI=1 \
  ./node_modules/.bin/vitest run src/__tests__/critique-448.test.ts --reporter=verbose "$@")
```

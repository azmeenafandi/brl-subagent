# #449 plan critique — second pass (amended brief)

> Reconstructed by the conductor from the critic's completion message. The critic (preset
> `project-plan-critic`) has no `write` tool, so `/tmp/CRITIQUE_449B.md` was never created and the
> transcript retains only start/settle markers; the findings below are the critic's own text, transcribed
> verbatim where it gave evidence. Run `c0da5b23`, model `openrouter/openai/gpt-6.1-terra`, xhigh, 4m37s.

Verdict: needs-work

| Severity | Plan location | Gap | Evidence (command + result) | Suggested fix |
|---|---|---|---|---|
| major | brief:79–81 | M1 is an equivalent mutant: changing the **default** to `present` does not override the settle site's explicit `absent`. M2 cannot be killed by the stated pre-stopped case: that branch returns before the classifier. | **Measured:** scratch `vitest -t '449B M1'` passed with the proposed M1. `vitest -t '449B M2'` passed pre-stopped but failed a direct `length`/`absent` classifier assertion. **Read:** `session-manager.ts:1956–1986`. | Replace M1 with changing the supplied absent evidence or defaulting unknown to absent. Split M2 into a pure classifier precedence test and a mutation moving the settle guard ahead of the pre-stopped branch. |
| major | brief:63–70, 82–84 | The M3 fixture as described does not necessarily kill the mutant. An assistant with no usage **and `stopReason: "stop"`** still takes the success arm even when presence is derived from turns. Test 4 also requires `turns ≥ 1`, contradicting its missing-usage fixture. Explicit `length`/`error` with zero assistant messages is not constructible at the settle site. | **Measured:** scratch M3 passed with missing usage plus `stop`; it failed when both usage **and stopReason** were absent. **Read:** `session-manager.ts:1956–1986`; `runner.ts:518–528`. | Put the missing-usage **and missing-stopReason** assistant in the background projected-session fixture, assert completed/turns 0, and label it a nonconforming synthetic boundary. Test explicit reasons plus absent evidence directly against the classifier. |
| major | brief:86–89 | Reproducer isolation is underspecified: `env -i` and `PI_OFFLINE=1` alone do not isolate the real home or block provider calls. | **Measured:** `env -i PATH=/usr/bin:/bin PI_OFFLINE=1 node -p 'require("node:os").homedir()'` returned `/home/azmeen`. **Read:** SDK `dist/config.js:510–527` derives agent/auth paths from that home; `dist/cli/args.js:458` describes offline as disabling *startup* network operations. | Require scratch `HOME`, scratch `PI_CODING_AGENT_DIR`, fake credentials and an enforced loopback-only provider, including in the README invocation. Falsifier: the repro can read real auth or reach a non-loopback endpoint. |
| major | brief:41–43, 52–66 | The required surface contract is not pinned. Acceptance 1 asserts only the run entry and completion; the existing transcript contains only `Transcript completed: failed`, and the failure event carries an error but no category. The run entry itself has no `exitCode`. "Nothing else changes in the settle branches" conflicts with requiring additional transcript/event fields. | **Read:** `src/transcript.ts:114–127`, `src/session-manager.ts:1990–2026`, `src/types.ts:353–425`. | Specify which surfaces carry status, reason and category; assert the persisted agent's `result.exitCode`, persisted run, wake, transcript and event separately. If transcript/event need added fields, explicitly authorize those changes. |
| minor | brief:74–77 | The "7 failures / 114" were caused by a **global foreground predicate** experiment, not seven background fixture defects. Repairing those generic empty-result fixtures would erase useful foreground coverage. | **Read:** first critique and `src/__tests__/types.test.ts:181–193`, `history.test.ts:127–169`, `terminal-status-consistency.test.ts:61–96`. **Measured:** scratch background-only guard: `session-manager.test.ts` 104/104 and `background-session-persistence.test.ts` 33/33 passed. | Remove that rationale; repair only a proven affected projected-session fixture, not `SubagentResult.messages`. |
| minor | brief:41–42, 99–100 | Empty, missing and unreadable projection are conflated or unspecified. A throwing getter bypasses the classifier and the existing catch-all records completion. This is not evidence of zero messages. | **Measured:** scratch `vitest -t 'markTerminalBestEffort: prunes'` passed with a throwing getter and completed status. **Read:** SDK `agent-session.js:1248–1250`; `session-manager.ts:2059–2065`. | Define `absent` as an inspected array with zero assistants; document the unreadable/missing case and its existing catch-all limit rather than "repairing" its fixture. |
| minor | brief:86–92 | The repro's observable success criterion and the claimed test-line estimate are not established. A loopback script that never exercises omission could satisfy the wording. | **Read:** acceptance 8 has no required observation. **Measured:** existing analogous test blocks range from 19 to 61 lines; headroom is 629 lines. | Require version-pinned invocation and observed `message_end:length`, resolved prompt and zero projected assistants. Budget approximately **150–250** test lines with reuse; "well under 150" is optimistic, not measured. |
| minor | brief:5–6, 95 | The brief cites the old base and says the scope decision is recorded in the issue; the current issue comment still describes a symmetric fix. It also says no user-visible status changes, although this defect changes completed to failed. | **Measured:** `git rev-parse HEAD` → `f2922e4`; `git diff 274f3dd f2922e4 --stat` → investigation docs only. `gh issue view 449 --json body,comments` showed the earlier symmetric comment. | Update provenance/decision citation and clarify whether README criterion means a new *status vocabulary*, not a changed displayed outcome. |

## Per-major closure from the first critique

- **(a) Closed — read:** the brief distinguishes projected session messages from streamed events and forbids
  `BackgroundAgent.result.messages`; `session-manager.ts:1601–1615` seeds it empty.
- **(b), (d) Closed — read:** `rg -n '\b(isSubagentError|classifyTerminalOutcome)\s*\(' src --glob
  '!**/__tests__/**'` found 15 predicate calls and three classifier calls. The proposed default leaves the
  other classifier callers unchanged; the foreground predicate is untouched.
- **(c) Partially — read:** headline priority and persisted category are specified; transcript/event
  assertions and field ownership are not.
- **(e) Closed in design — read:** the three production classifier constructions are the settle site,
  `notify-completion.ts:179` and `types.ts:1076`; the latter two have no evidence argument. No other
  construction was found by `rg -n -F 'classifyTerminalOutcome('`.
- **(f) Partially — measured/read:** M1 survives; M2's stated pre-stop falsifier survives; M3 needs the
  additional missing stop reason. M4 is independently killable by the persisted-entry assertion, but was not
  implemented or run. SDK `pi-ai/dist/types.d.ts:375–389` requires both usage and stopReason: M3 is **not** a
  conforming SDK message.

## Zero-assistant paths (read/measured)

Recoverable-length omission should fire. Retry-backoff abort with a pre-stamp stays stopped. A direct SDK
`abortRetry()` **without** a stamp resolved with zero assistants in a loopback scratch probe and should fire
as `incomplete`. A before-start un-stamped `session.abort()` produced an `aborted` assistant, so the existing
stopped path wins. Preflight rejection uses `.catch`. Handled-input/command short-circuits require extensions
or an unwrapped command, excluded here. Deferred second prompts require concurrency this spawn does not use.
These are the inspected SDK paths, not a claim about untested future SDK versions.

## Fixture inventory (read)

The 19 files found by `rg -l 'spawnBackgroundSession|createAgentSession' src/__tests__ -g '*.ts'` comprise
three session mocks (`session-manager.test.ts`, `background-session-persistence.test.ts`,
`engineering-bar.test.ts`), two real-SDK tests, and 14 mocked-spawn suites. No background success assertion
depending on an explicit empty projected array was found. `engineering-bar.test.ts:166` omits messages but
tests prompt configuration, not successful settlement. `background-session-persistence.test.ts:717–733`
intentionally tests an unreadable getter; adding a message cannot repair it. Other success fixtures already
supply assistants.

## Wording and budget (measured)

The proposed headline matched none of the nine transport signatures or vocabulary regexes.
`node scripts/docs-arch.mjs` and `node scripts/docs-decisions.mjs` both reported current. The budget walker
counted 113 test and 47 source TypeScript files: 46,769 / 23,699 lines, leaving 629. The repro outside `src`
is excluded.

## Limitations

No full suite was run. Four engineering-bar scratch tests failed because the scratch copy lacked git metadata
and the tracked reference; the other 13 passed. All behavioural probes used isolated `/tmp` homes, fake
credentials and loopback or no provider. No repository files were modified.

## What the brief must change

1. Replace the ineffective mutants (M1, M2 split, M3 boundary).
2. Pin the actual background M3 boundary (missing usage **and** missing stopReason).
3. Specify and assert each surface (agent exit code, run entry, wake, transcript, event).
4. Harden the repro invocation and require an observable result.
5. Correct the fixture and budget claims.

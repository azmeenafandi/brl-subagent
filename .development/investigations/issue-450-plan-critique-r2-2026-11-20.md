# #450 — plan critique, round 2 (2026-11-20)

**Target:** `.development/investigations/issue-450-settle-handlers-spec-2026-11-20.md` (r2, `3beed12`)
**Critic:** `project-plan-critic` · `openrouter/openai/gpt-6.1-terra` · thinking `medium` · run `critique-450-r2` (2m52s, $0.172)
**Jev:** `jev: xhigh (0.58) · C1 · worktree n` · settled `changes-requested`

## Result

**Verdict: needs-work**

| Severity | Plan location | Gap | Evidence (command + result) | Suggested fix |
|---|---|---|---|---|
| major | D2, Q2 | The synchronous-throw boundary is not generally proof that no work started: a getter or non-async wrapper can start the real async method and then throw. The installed factory currently constructs an `AgentSession` whose method is async, but the spec also discusses injected sessions without stating this narrower assumption. | `rg -n 'new AgentSession\(\|async prompt\(' node_modules/@earendil-works/pi-coding-agent/dist/core/{sdk,agent-session}.js` found `sdk.js:304` and `agent-session.js:1704`. A Node probe starting an async method inside a wrapper, then throwing, printed `live: true`. | State that the never-issued proof requires the unwrapped SDK method and side-effect-free lookup/argument evaluation. Falsifier: an injected wrapper starts work then throws; it must not be claimed as proven pre-start. |
| major | D2 regime 2, D3, Risks | Log-and-continue does not necessarily bound a routing fault: if accessing `.then` throws before a rejection handler attaches, a later rejection can terminate the host process. The non-thenable T3 cannot expose this. | `node --unhandled-rejections=strict` with a native pending promise whose `then` getter throws logged `routing catch`, then exited **1** on its later rejection. | Specify the supported routing-fault contract and process-level residual, or contain it for supported promises. Falsifier: inject a throwing `then` lookup followed by rejection and verify the declared process behavior. |
| major | Q3-G1, T1, acceptance 2 | The proposed ratchet can miss a top-level statement merely indented four spaces. This is distinct from the acknowledged throw *inside* an allowlisted statement and invalidates "no statement can be inserted" without changing the locked G1 decision. | In `/tmp/brl450-ratchet-live`, inserted `    if (Date.now() > 0) throw new Error("hidden fault");` after THE ATTACH. `vitest … -t '#450 ratchet'` **passed**; `-t 'caller observes'` failed with `hidden fault`. | Make the closed-list scan reject unaccounted statements regardless of indentation. Add this compiling, differently indented mutant as a falsifier. M4–M7 currently go red for their tested literal shapes. |
| major | D5, acceptance 3 and 6 | Original-error preservation and fault containment are overstated. `String(reason)` can itself throw; separately, `cleanupWorkBranch` can throw while handling a non-Error git fault, before `failPreStart` reaches its protected finalizer. | In `/tmp/brl450-cleanup-probe`, `vitest … -t 'critic cleanup'` failed both tests: a git cleanup throwing `null` replaced `original prompt` with a `TypeError`; an unstringable thrown object was replaced by `conversion failed`. | Either narrow the contract explicitly or protect normalization and cleanup while preserving the original rejection and attempting terminal retirement. Use both probes as falsifiers. |
| minor | D6, T5 | T5 detects M8 only if the erroneous settle body reaches its transcript/event writes; it does not prove that no settle body ran when the catch-all intervenes. | In `/tmp/brl450-tripwire-bypass`, added both M8 and a throw inside the fault body before its side effects. `vitest … -t 'sentinel tripwire'` **passed**. | Narrow the asserted claim or add a direct body-entry tripwire independent of later side effects; retain `messages: []` for the behavioral event checks. |

**Verified sound**

- `bash /tmp/brl450-probes/mutants3.sh` reproduced **10/10 red**, including M1, M2, M3 and M8. Baseline and implementation copies passed **172** and **178** tests respectively in the two specified files.
- T6 passed in `/tmp/brl450-impl3`; copying it into the baseline made it fail with `completed` versus `running`. Its source check reads `src/background-pipeline.ts` and spans the spawn await to the identity status capture.
- `git grep -n 'identity\.status' -- 'src/**/*.ts' 'src/*.ts'` found one consumption, `src/background-pipeline.ts:995`. Searching tracked source for literal status text found the separate result-lineage tests and the started-tail `running` test, not a spawn-text `completed` assertion.
- `failPreStart` calls `finalizeRunEntry` without emitting a terminal event or completing the transcript. The `messages: []` fixture makes T5's selected side effects reachable. `String(null)` and `new Error(String(undefined)).message` yield the specified strings, and `sanitizeErrorMessage` leaves these short strings unchanged.
- `node --expose-gc /tmp/brl450-probes/abandon-gc.mjs` collected the abandoned closure payload. For the stated unwrapped SDK path, routing cannot already be attached when the synchronous pre-start catch runs.
- `gh issue view 542` confirms the D8 residue follow-up is open. No repository files were modified.

**Open questions the plan should answer**

- None beyond the supported fault contracts identified above.

## Conductor triage

All five accepted. Round 1's nine resolutions stand (verified by re-run, not trust). The r3 patch is targeted: narrow the D2 proof to the unwrapped SDK method; state (or contain) the routing-fault contract; make the ratchet reject unaccounted statements at any indentation (new mutant); add a fault-contained normalisation and preserve the original throw across cleanup faults; give T5 a direct body-entry tripwire. Locked decisions unchanged: S1, G1, #542.

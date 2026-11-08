# Plan critique — issue #429 (`resolveSubagentParams` tests)

> Source: background agent `3c7aa09d` (`critique-429`, preset `project-plan-critic`,
> `openrouter/openai/gpt-6.1-terra`, xhigh), dispatched 2026-11-06T14:58Z on tree `dev` @ `51f5971`,
> settled 15:05:56Z (34 turns). Jev line: `xhigh (0.77) · C2 · worktree n` (provenance: `.pi/jev-lines.log`).
> Completion wake was LOST to the stale-ctx completion-push bug (see the issue filed 2026-11-06);
> result retrieved via `get_subagent_result`. Transcribed from the run record's `finalOutput`
> plus the critic's incremental bank (`/tmp/brl-critique-429-bank.md`, 236 lines) as the measurement appendix.

## Final report

Verdict: needs-work

| Severity | Plan location | Gap | Evidence (command + result) | Suggested fix |
|---|---|---|---|---|
| major | D2, P17 | `tools: []` exposes a live tool-restriction inconsistency, not a universal “no tools” contract. | `node /tmp/probe429/project/schema-audit.cjs`: resolver returns `tools: []`, preflight treats write as unavailable, but foreground args contain no tool restriction. `node /tmp/probe429/project/sdk-probe.cjs`: real SDK with omitted tools activates `read,bash,edit,write`; with `[]`, activates none. Background forwards `[]` at `src/session-manager.ts:1355`. | Escalate for maintainer decision/separate security fix. Do not pin downstream equivalence. Falsifier: foreground and background actually receive the same effective toolset. |
| major | P4/P16, D decisions | Schema-valid invalid thinking levels produce an undefined resolved level, despite the declared return type. | `node /tmp/probe429/project/edge-audit.cjs`: `"bogus"` survives pi validation; resolver returns `undefined`; preflight passes and foreground args contain `undefined` after `--thinking`. | Triage separately before freezing this behavior. Falsifier: the registered call is rejected or resolves to a valid level. |
| major | Null/`unknown` paragraph | The proposed discriminator is wrong, and raw schema checking does not describe pi’s actual argument path. | `node /tmp/probe429/project/schema-audit.cjs`: all 14 tested optional `null` fields fail raw TypeBox check but pi’s `validateToolArguments` removes them. `node .../edge-audit.cjs`: `null ?? preset` and `null || preset` both yield the preset. | Exclude null-arrives-at-resolver cases from the registered-tool contract; test schema-valid `""`, `false`, and `0` where discriminating. |
| major | Mutant table; acceptance #2 | Candidate list misses five precedence inversions, timeout-normalization ordering, logging, keyword propagation, and falsy intent. | `cd /tmp/probe429/project && node audit.cjs`: **31/31** measured mutants killed by their named probe cases. The additions and observables are below. | Add the measured mutants and named killers. Falsifier: any final-table mutant survives the committed suite. |
| major | R5 | Existing unknown-preset test does not assert the missing preset or prove that an otherwise routable task stays unrouted. | `node .../schema-audit.cjs`: unknown explicit name + `"security audit"` gives `name: "nonexistent"` at the seam, but outer preset, routed preset, and keyword are undefined. XUNK routes instead and survives section 1. | Pin the missing result **and** suppression of routing; retain the existing weaker test without duplicating it. |
| minor | Existing pins; branch-map anchors | Section 1 uses `MockSessionState`, not real `SessionState`; all R1–R4 anchors are wrong. Real state defaults thinking to `off`. | `node /tmp/probe429/project/smoke.cjs`; `nl -ba src/params.ts`: seam is **370–398**, R1 377–379, R2 382–386, R3 387–391, R4 392–397. | Correct provenance and set `maxThinkingLevel` explicitly in fixtures. Mark only the already-tested arms `(existing)`. |
| minor | P8; M13 | Timeout-bearing preset fixtures are synthetic; M13’s predicted keyword observable is unchanged. | `src/__tests__/presets-files.test.ts:302–364` pins that file-loaded presets discard timeout. `node .../audit.cjs`: M13 changes `autoRoutedPreset`, but keyword is undefined in both versions. | Label the timeout case an in-memory seam test; assert M13 on `autoRoutedPreset`. |

Verified sound:

- **Provenance and limits:** audited `dev` at `51f5971`; copied `src/params.ts` has the same SHA-256 as the repository. `git diff 19e46c8 HEAD -- src/params.ts src/schema.ts src/__tests__/integration.test.ts` was empty. Repository status was clean at exit; no repository files were modified.
- `npm run typecheck` passed. Scratch integration baseline passed **112/112**; the section-1 mutation run exercised **33** tests and skipped the other 79. The full suite and a future committed suite were **not** run against all mutants.
- Direct-test query: `rg -l resolveDispatchPreset src/__tests__` returned empty across **108 files** counted by `find src/__tests__ -type f | wc -l`. This means no *named direct call*, not no indirect coverage.
- Out-of-scope redirects are supported by the named suites: background-default matrix, `validate.test.ts:265–322` and `:545+`, and the template substitution/file suites.
- D1, D3–D6 measured as stated: branch-named preset → `branch`; blank labels → undefined; omitted task → `""`; empty cwd → context cwd; empty preset survives validation and permits routing. D2’s **resolver shape** is confirmed, subject to the downstream issue above.

**Measured mutant table.** Command: `cd /tmp/probe429/project && node audit.cjs`; all 31 variants also passed a scratch TypeScript compilation. Each row’s ID plus its input is its named killer; `†` means an existing section-1 test killed it, `‡` means the existing transport test did.

| Mutant | Killer observable: base → mutant |
|---|---|
| M1 | call high / preset low: `high → low` |
| M2 | empty system prompt: `"" → preset prompt` |
| M3 | timeout 1000 / preset 60000: `1000 → 60000` |
| M4† | tools edit: `[edit,write] → [edit]` |
| M5† | edit + write: `[edit,write] → [edit,write,write]` |
| M6 | preset named branch: `branch → none` |
| M7† | invalid git mode: config `branch → garbage` |
| M8† | no tool options: `undefined → object with undefined fields` |
| M9† | omitted task: `"" → undefined` |
| M10† | whitespace label: `undefined → ""` |
| M11† | omitted inherit: `true → false` |
| M12 | empty cwd: `/context → ""` |
| M13† | explicit preset: routed preset `undefined → fixture` |
| RM1† | routable task + explicit tools: no preset → security-auditor |
| RM2† | routable task + template: no preset → security-auditor |
| X15† | call approval always / config auto: `always → auto` |
| X16† | xhigh / medium cap: `medium → xhigh` |
| X22‡ | routed keyword: `audit → undefined` |
| XLOG | routed log: one preset/keyword entry → none |
| XTIME | caller timeout 0 / preset 60000: `undefined → 60000` |
| XINHERIT† | call true / preset false: `true → false` |
| XOUTPUT | call output / preset output: `call.md → preset.md` |
| XTOOLS | call tools / preset tools: `[bash] → [read]` |
| XEXCLUDE | call exclude / preset exclude: `[edit] → [bash]` |
| XNO | call false / preset true: `false → true` |
| XR2FALSE | explicit `noBuiltinTools: false`: no route → security-auditor |
| XSP† | call prompt / preset prompt: call → preset |
| XEMPTY | `tools: []`: defined options → undefined |
| XUNK | unknown explicit preset + routable task: no route → security-auditor |
| XLOGALWAYS | explicit preset: no log → auto-route log |
| XR2EMPTY | explicit `tools: []`: no route → security-auditor |

No candidate was equivalent. M4 and M7 were reconstructed as compiling mutants before the final measurement.

**Branch-map reconciliation.** `(existing)` identifies only the exercised arm; named tests are in `src/__tests__/integration.test.ts` §1 unless otherwise stated.

| Rows | Existing pin and remaining gap |
|---|---|
| P1, P3 | `(existing)` “auto-routes to a preset…” and “does NOT auto-route when an explicit preset…”; log assertions missing. |
| P2 | `(existing)` preset-default and minimal-default tests; unknown-name result needs R5 assertion. |
| P4 | `(existing)` both thinking-cap tests; competing call/preset precedence missing. |
| P5 | `(existing)` “uses preset values as defaults and allows overrides”; empty override missing. |
| P6 | `(existing)` “preset with inheritSystemPrompt=false…” and “explicit inheritSystemPrompt override wins…” |
| P7 | `(existing)` minimal-default absence only; competing output paths missing. |
| P8 | `(existing)` preset default and zero/valid timeout tests; conflict and normalization order missing. |
| P9 | `(existing)` preset tools and edit tests; same-field precedence missing. |
| P10 | `(existing)` both “edit→write fix” tests; also preset and minimal cases cover no-edit/absent. |
| P11 | `(existing)` “override with excludeTools merges correctly with preset tools”; same-field conflict missing. |
| P12 | `(existing)` “preset with noBuiltinTools is picked up as toolOptions”; false override missing. |
| P13–P14 | `(existing)` branch, none, and invalid git-mode tests; preset-name quirk missing. |
| P15 | `(existing)` call, config fallback, and invalid approval-mode tests. |
| P16 | `(existing)` both cap tests; invalid schema-valid level requires triage. |
| P17 | `(existing)` minimal and no-builtin shape tests; empty arrays/false-only shape missing. |
| P18 | `(existing)` “absent task normalises…” and reader tests. |
| P19 | `(existing)` blank-label test; nonblank trim and empty-string cases missing. |
| P20 | `(existing)` omitted, preset false, and call true inherit tests. |
| P21 | `(existing)` absent/nonempty cwd tests; empty cwd missing. |
| P22 | Not §1; `(existing)` `transport-auto-retry.test.ts` “a preamble carrying preset and capability keywords does not change resolution” kills X22. |
| R1–R2 | `(existing)` explicit preset and four explicit tools/exclude/no-builtin/template tests; false and empty intent cases missing. |
| R3–R4 | `(existing)` absent-task miss and “auto-routes…” hit; §1 does not assert keyword. For `"security audit"`, the measured keyword is **audit**, not the “security” stated in that test’s comment. |
| R5 | `(existing)` “unset preset when name not found falls through to defaults” is partial; XUNK is the missing discriminating case. |

**Required hand-run picks:** M1, M2, M3, XTIME, XOUTPUT, XTOOLS, XEXCLUDE, XNO, X22, and XLOG. XSP and XINHERIT have measured existing killers; every precedence inversion still needs its named killer in the PR.

Open questions the plan should answer:

- Should the D2 tool-restriction inconsistency block this test-only PR, or be tracked and fixed separately?
- Should invalid `thinkingLevel` be rejected or normalized in a separate behavior issue? The test plan should not silently enshrine `undefined`.

Incremental bank and reproducible probes: `/tmp/brl-critique-429-bank.md` and `/tmp/probe429/`.

---

## Measurement bank (incremental record, verbatim)

# Issue 429 critique bank

- Tree: dev 51f5971e3bf2a8af7a5e5b02213624c50d280299; git status --short empty on entry; Node v24.14.1, npm 11.11.0.
- gh issue view 429: open, amended checklist and mutation acceptance; plan references old 19e46c8; baseline tree is 51f5971.

## Initial verification
- `git diff 19e46c8 HEAD -- src/params.ts src/schema.ts src/__tests__/integration.test.ts` emitted nothing; `git diff --stat 19e46c8 HEAD` shows only the plan. Source anchors same, but plan is old provenance.
- `rg -n 'resolveDispatchPreset|resolveSubagentParams' src/__tests__` produced zero occurrences of resolveDispatchPreset, many resolveSubagentParams references. Integration actually declares `class MockSessionState`, `const SessionState = MockSessionState`, NOT the real class; plan's existing-pin/harness claim is false.
- `rg -n 'toolOptions|noBuiltinTools|excludeTools' src --glob '!**/__tests__/**'` showed runner.ts:493-499 only emits `--tools` if length > 0, while validate.ts:215 denies a name whenever tools exists and doesn't include it. Empty tools plausibly yields inconsistent preflight vs child; verify by running.
- `npx vitest --version`: vitest 5.0.5; `node_modules/.bin/jiti --version` fails (jiti interprets --version as filename), not evidence of a working version flag.
- Section 1 is lines 131-671 (33 `it`s including 3 reader-focused tests): `rg -n '^// [12]\\. |^\\s*it\\(' src/__tests__/integration.test.ts` prints the named matrix. Existing R2, P10, P14-P16, P18/P19/P20, P21, M4/M5/M7-M12/RM1/RM2 have specific pins, but gaps remain per arm. P22 keyword not asserted by section 1.
- Direct-test query is `rg -l 'resolveDispatchPreset' src/__tests__` -> empty, searched 108 files (`find src/__tests__ -type f | wc -l`). Static search establishes no named direct references, not absence of all indirect integration coverage.
- `cd /tmp/probe429/project && node smoke.cjs` imports byte-identical copied params.ts (SHA-256 7ae8...589c7) with real `SessionState`: defaults `maxThinkingLevel=off, gitMode=none, approvalMode=writes`; auto-routed `security audit` selects security-auditor keyword `audit` and logs evidence. The plan's M1 high expectation requires setting max >= high; the §1 mock default is high, whereas real state default is off.
- `nl -ba src/params.ts | awk 'NR>=350 && NR<=500'`: seam starts line 370; R1 377-379, R2 382-386, R3 387-391, R4 392-397. Plan incorrectly anchors R1-R4 to 363-384; P anchors 419-494 are correct.
- pi-agent validation is not a raw TypeBox Check: `node_modules/@earendil-works/pi-ai/dist/utils/validation.js:11` uses pi-schema `{coerce:true}`, parse structuredClone, comments explicitly allow null omission. Measure actual inputs, not just schema source.
{"id":"M1","kill":"KILLED","p":{"preset":"fixture","thinkingLevel":"high"},"o":{},"base":{"thinkingLevel":"high"},"mutant":{"thinkingLevel":"low"}}
{"id":"M2","kill":"KILLED","p":{"preset":"fixture","systemPrompt":""},"o":{},"base":{"customSP":""},"mutant":{"customSP":"preset prompt"}}
Audit interrupted at M3: duplicate replacement text elsewhere; M1-M2 already banked; fix harness anchor and resume.
{"id":"M1","kill":"KILLED","p":{"preset":"fixture","thinkingLevel":"high"},"o":{},"base":{"thinkingLevel":"high"},"mutant":{"thinkingLevel":"low"}}
{"id":"M2","kill":"KILLED","p":{"preset":"fixture","systemPrompt":""},"o":{},"base":{"customSP":""},"mutant":{"customSP":"preset prompt"}}
{"id":"M3","kill":"KILLED","p":{"preset":"fixture","timeout":1000},"o":{},"base":{"timeout":1000},"mutant":{"timeout":60000}}
{"id":"M4","kill":"KILLED","p":{"tools":["edit"]},"o":{},"base":{"tool.tools":["edit","write"]},"mutant":{"tool.tools":["edit"]}}
{"id":"M5","kill":"KILLED","p":{"tools":["edit","write"]},"o":{},"base":{"tool.tools":["edit","write"]},"mutant":{"tool.tools":["edit","write","write"]}}
{"id":"M6","kill":"KILLED","p":{"preset":"branch"},"o":{"presets":[{"name":"branch","description":"b"}]},"base":{"resolvedGitMode":"branch"},"mutant":{"resolvedGitMode":"none"}}
{"id":"M7","kill":"KILLED","p":{"gitMode":"garbage"},"o":{"git":"branch"},"base":{"resolvedGitMode":"branch"},"mutant":{"resolvedGitMode":"garbage"}}
{"id":"M8","kill":"KILLED","p":{"task":"hello"},"o":{},"base":{"toolOptions":"[undefined]"},"mutant":{"toolOptions":{"tools":"[undefined]","excludeTools":"[undefined]","noBuiltinTools":"[undefined]"}}}
{"id":"M9","kill":"KILLED","p":{},"o":{},"base":{"task":""},"mutant":{"task":"[undefined]"}}
{"id":"M10","kill":"KILLED","p":{"label":"   "},"o":{},"base":{"label":"[undefined]"},"mutant":{"label":""}}
{"id":"M11","kill":"KILLED","p":{},"o":{},"base":{"inheritSP":true},"mutant":{"inheritSP":false}}
{"id":"M12","kill":"KILLED","p":{"cwd":""},"o":{},"base":{"effectiveCwd":"/context"},"mutant":{"effectiveCwd":""}}
{"id":"M13","kill":"KILLED","p":{"preset":"fixture"},"o":{},"base":{"aname":"[undefined]","autoRouteKeyword":"[undefined]"},"mutant":{"aname":"fixture","autoRouteKeyword":"[undefined]"}}
{"id":"RM1","kill":"KILLED","p":{"task":"security audit","tools":["read"]},"o":{},"base":{"rname":"[undefined]","aname":"[undefined]"},"mutant":{"rname":"security-auditor","aname":"security-auditor"}}
{"id":"RM2","kill":"KILLED","p":{"task":"security audit","template":"known"},"o":{},"base":{"rname":"[undefined]","aname":"[undefined]"},"mutant":{"rname":"security-auditor","aname":"security-auditor"}}
Audit reached and killed M1-M13, RM1-RM2; X15 initially matched another helper elsewhere; restricting replacement to exported seam and rerunning.
{"id":"M1","kill":"KILLED","p":{"preset":"fixture","thinkingLevel":"high"},"o":{},"base":{"thinkingLevel":"high"},"mutant":{"thinkingLevel":"low"}}
{"id":"M2","kill":"KILLED","p":{"preset":"fixture","systemPrompt":""},"o":{},"base":{"customSP":""},"mutant":{"customSP":"preset prompt"}}
{"id":"M3","kill":"KILLED","p":{"preset":"fixture","timeout":1000},"o":{},"base":{"timeout":1000},"mutant":{"timeout":60000}}
{"id":"M4","kill":"KILLED","p":{"tools":["edit"]},"o":{},"base":{"tool.tools":["edit","write"]},"mutant":{"tool.tools":["edit"]}}
{"id":"M5","kill":"KILLED","p":{"tools":["edit","write"]},"o":{},"base":{"tool.tools":["edit","write"]},"mutant":{"tool.tools":["edit","write","write"]}}
{"id":"M6","kill":"KILLED","p":{"preset":"branch"},"o":{"presets":[{"name":"branch","description":"b"}]},"base":{"resolvedGitMode":"branch"},"mutant":{"resolvedGitMode":"none"}}
{"id":"M7","kill":"KILLED","p":{"gitMode":"garbage"},"o":{"git":"branch"},"base":{"resolvedGitMode":"branch"},"mutant":{"resolvedGitMode":"garbage"}}
{"id":"M8","kill":"KILLED","p":{"task":"hello"},"o":{},"base":{"toolOptions":"[undefined]"},"mutant":{"toolOptions":{"tools":"[undefined]","excludeTools":"[undefined]","noBuiltinTools":"[undefined]"}}}
{"id":"M9","kill":"KILLED","p":{},"o":{},"base":{"task":""},"mutant":{"task":"[undefined]"}}
{"id":"M10","kill":"KILLED","p":{"label":"   "},"o":{},"base":{"label":"[undefined]"},"mutant":{"label":""}}
{"id":"M11","kill":"KILLED","p":{},"o":{},"base":{"inheritSP":true},"mutant":{"inheritSP":false}}
{"id":"M12","kill":"KILLED","p":{"cwd":""},"o":{},"base":{"effectiveCwd":"/context"},"mutant":{"effectiveCwd":""}}
{"id":"M13","kill":"KILLED","p":{"preset":"fixture"},"o":{},"base":{"aname":"[undefined]","autoRouteKeyword":"[undefined]"},"mutant":{"aname":"fixture","autoRouteKeyword":"[undefined]"}}
{"id":"RM1","kill":"KILLED","p":{"task":"security audit","tools":["read"]},"o":{},"base":{"rname":"[undefined]","aname":"[undefined]"},"mutant":{"rname":"security-auditor","aname":"security-auditor"}}
{"id":"RM2","kill":"KILLED","p":{"task":"security audit","template":"known"},"o":{},"base":{"rname":"[undefined]","aname":"[undefined]"},"mutant":{"rname":"security-auditor","aname":"security-auditor"}}
{"id":"X15","kill":"KILLED","p":{"approvalMode":"always"},"o":{"approval":"auto"},"base":{"resolvedApprovalMode":"always"},"mutant":{"resolvedApprovalMode":"auto"}}
{"id":"X16","kill":"KILLED","p":{"thinkingLevel":"xhigh"},"o":{"max":"medium"},"base":{"thinkingLevel":"medium"},"mutant":{"thinkingLevel":"xhigh"}}
{"id":"X22","kill":"KILLED","p":{"task":"security audit"},"o":{},"base":{"autoRouteKeyword":"audit"},"mutant":{"autoRouteKeyword":"[undefined]"}}
{"id":"XLOG","kill":"KILLED","p":{"task":"security audit"},"o":{},"base":{"logs":[["Auto-routed task to preset",{"preset":"security-auditor","keyword":"audit"}]]},"mutant":{"logs":[]}}
{"id":"XTIME","kill":"KILLED","p":{"preset":"fixture","timeout":0},"o":{},"base":{"timeout":"[undefined]"},"mutant":{"timeout":60000}}
{"id":"XINHERIT","kill":"KILLED","p":{"preset":"fixture","inheritSystemPrompt":true},"o":{},"base":{"inheritSP":true},"mutant":{"inheritSP":false}}
{"id":"XOUTPUT","kill":"KILLED","p":{"preset":"fixture","outputFile":"call.md"},"o":{},"base":{"outputFile":"call.md"},"mutant":{"outputFile":"preset.md"}}
{"id":"XTOOLS","kill":"KILLED","p":{"preset":"fixture","tools":["bash"]},"o":{},"base":{"tool.tools":["bash"]},"mutant":{"tool.tools":["read"]}}
{"id":"XEXCLUDE","kill":"KILLED","p":{"preset":"fixture","excludeTools":["edit"]},"o":{},"base":{"tool.excludeTools":["edit"]},"mutant":{"tool.excludeTools":["bash"]}}
{"id":"XNO","kill":"KILLED","p":{"preset":"fixture","noBuiltinTools":false},"o":{},"base":{"tool.noBuiltinTools":false},"mutant":{"tool.noBuiltinTools":true}}
{"id":"XR2FALSE","kill":"KILLED","p":{"task":"security audit","noBuiltinTools":false},"o":{},"base":{"rname":"[undefined]","aname":"[undefined]"},"mutant":{"rname":"security-auditor","aname":"security-auditor"}}
TOTAL 26/26 killed
{"key":"thinkingLevel","rawCheck":false,"pi":"ok","parsed":{},"hasOwn":false}
{"key":"systemPrompt","rawCheck":false,"pi":"ok","parsed":{},"hasOwn":false}
{"key":"inheritSystemPrompt","rawCheck":false,"pi":"ok","parsed":{},"hasOwn":false}
{"key":"outputFile","rawCheck":false,"pi":"ok","parsed":{},"hasOwn":false}
{"key":"timeout","rawCheck":false,"pi":"ok","parsed":{},"hasOwn":false}
{"key":"tools","rawCheck":false,"pi":"ok","parsed":{},"hasOwn":false}
{"key":"excludeTools","rawCheck":false,"pi":"ok","parsed":{},"hasOwn":false}
{"key":"noBuiltinTools","rawCheck":false,"pi":"ok","parsed":{},"hasOwn":false}
{"key":"gitMode","rawCheck":false,"pi":"ok","parsed":{},"hasOwn":false}
{"key":"preset","rawCheck":false,"pi":"ok","parsed":{},"hasOwn":false}
{"key":"task","rawCheck":false,"pi":"ok","parsed":{},"hasOwn":false}
{"key":"label","rawCheck":false,"pi":"ok","parsed":{},"hasOwn":false}
{"key":"cwd","rawCheck":false,"pi":"ok","parsed":{},"hasOwn":false}
{"key":"template","rawCheck":false,"pi":"ok","parsed":{},"hasOwn":false}
{"arg":{"tools":[]},"rawCheck":true,"parsed":{"tools":[]},"resolved":{"name":null,"auto":null,"keyword":null,"tools":[]}}
{"arg":{"preset":"","task":"security audit"},"rawCheck":true,"parsed":{"preset":"","task":"security audit"},"resolved":{"name":"security-auditor","auto":"security-auditor","keyword":"audit","tools":null}}
{"arg":{"template":"","task":"security audit"},"rawCheck":true,"parsed":{"template":"","task":"security audit"},"resolved":{"name":"security-auditor","auto":"security-auditor","keyword":"audit","tools":null}}
{"arg":{"noBuiltinTools":false,"task":"security audit"},"rawCheck":true,"parsed":{"noBuiltinTools":false,"task":"security audit"},"resolved":{"name":null,"auto":null,"keyword":null,"tools":null}}
DECISION {"p":{"preset":"nonexistent","task":"security audit"},"dispatch":{"name":"nonexistent","autoRouted":false},"result":{"task":"security audit","label":null,"cwd":"/context","git":"none","preset":null,"auto":null,"keyword":null}}
DECISION {"p":{},"dispatch":{"autoRouted":false},"result":{"task":"","label":null,"cwd":"/context","git":"none","preset":null,"auto":null,"keyword":null}}
DECISION {"p":{"label":"   "},"dispatch":{"autoRouted":false},"result":{"task":"","label":null,"cwd":"/context","git":"none","preset":null,"auto":null,"keyword":null}}
DECISION {"p":{"label":""},"dispatch":{"autoRouted":false},"result":{"task":"","label":null,"cwd":"/context","git":"none","preset":null,"auto":null,"keyword":null}}
DECISION {"p":{"cwd":""},"dispatch":{"autoRouted":false},"result":{"task":"","label":null,"cwd":"/context","git":"none","preset":null,"auto":null,"keyword":null}}
DECISION {"p":{"preset":"branch"},"dispatch":{"name":"branch","preset":{"name":"branch"},"autoRouted":false},"result":{"task":"","label":null,"cwd":"/context","git":"branch","preset":"branch","auto":null,"keyword":null}}
EMPTY TOOLS {"options":{"tools":[]},"args":["--mode","json","-p","--no-session","--model","p/m","--thinking","off"],"preflight":{"valid":false,"warnings":[],"errors":["outputFile is set but the 'write' tool is not available (tools=, excludeTools=none). The subagent cannot write the report. Remove outputFile or adjust the preset/tool restrictions."]}}
{"sdkInput":"omitted","active":["read","bash","edit","write"]}
{"sdkInput":[],"active":[]}
foreground ["--mode","json","-p","--no-session","--model","p/m","--thinking","off"]

## Important D2 result (measured)
- `node /tmp/probe429/project/schema-audit.cjs`: registered schema accepts tools:[], and actual `validateToolArguments` preserves it. `resolveSubagentParams` returns toolOptions.tools []; `buildSubagentArgs` emits NO --tools / --no-builtin-tools; `validatePreTask` rejects outputFile (write unavailable).
- `node /tmp/probe429/project/sdk-probe.cjs`: REAL pi createAgentSession with omitted tools -> [read,bash,edit,write], with tools:[] -> []; background src/session-manager.ts:1355 forwards [] via ??; foreground cli builder drops [] instead. Live cross-mode/tool-guard inconsistency, potentially security significant; pin resolver shape only as a quarantined seam, flag maintainer decision / separate bug, do not claim downstream universally no tools.
- Schema null experiment: typebox/value Check rejects all 14 optional null inputs; installed pi `validateToolArguments` COERCES ALL 14 to omitted properties (not rejection), so null literal never reaches resolver through this normal path. Distinguish raw callers which can directly pass null. `preset:''` and `tools:[]` survive validation.

 RUN  v5.0.5 /tmp/probe429/project

················································································································

 Test Files  1 passed (1)
      Tests  112 passed (112)
   Start at  23:00:44
   Duration  377ms (transform 67%, import 15%, tests 15%, worker 3%)

{"id":"M10","status":1,"failed":["task label is trimmed when provided as blank string"],"passed":32,"pending":79}
{"id":"M11","status":1,"failed":["inherits inheritSystemPrompt=true when not specified anywhere","unset preset when name not found falls through to defaults","no preset + no overrides produces minimal defaults"],"passed":30,"pending":79}
{"id":"M12","status":0,"failed":[],"passed":33,"pending":79}
{"id":"M13","status":1,"failed":["does NOT auto-route when an explicit preset is given (issue #57 intent rule)"],"passed":32,"pending":79}
{"id":"M1","status":0,"failed":[],"passed":33,"pending":79}
{"id":"M2","status":0,"failed":[],"passed":33,"pending":79}
{"id":"M3","status":0,"failed":[],"passed":33,"pending":79}
{"id":"M4","status":1,"failed":["edit→write fix: edit-only allowlist gains write"],"passed":32,"pending":79}
{"id":"M5","status":1,"failed":["edit→write fix: explicit write is not duplicated"],"passed":32,"pending":79}
{"id":"M6","status":0,"failed":[],"passed":33,"pending":79}
{"id":"M7","status":1,"failed":["invalid gitMode falls back to state config"],"passed":32,"pending":79}
{"id":"M8","status":1,"failed":["no preset + no overrides produces minimal defaults"],"passed":32,"pending":79}
{"id":"M9","status":1,"failed":["absent task normalises to '' and never auto-routes (issue #379)","classifyTask('') classifies like the absent case — never matches (issue #379)"],"passed":31,"pending":79}
{"id":"RM1","status":1,"failed":["does NOT auto-route when tools are explicitly given (issue #57 intent rule)","does NOT auto-route when excludeTools is explicitly given (issue #57 intent rule)","does NOT auto-route when noBuiltinTools is explicitly given (issue #57 intent rule)"],"passed":30,"pending":79}
{"id":"RM2","status":1,"failed":["does NOT auto-route when a template is given (issue #57 intent rule)"],"passed":32,"pending":79}
{"id":"X15","status":1,"failed":["per-call approvalMode wins over state config"],"passed":32,"pending":79}
{"id":"X16","status":1,"failed":["caps thinking level at the user-configured maximum","explicit thinkingLevel override is also capped at max"],"passed":31,"pending":79}
{"id":"X22","status":0,"failed":[],"passed":33,"pending":79}
{"id":"XEXCLUDE","status":0,"failed":[],"passed":33,"pending":79}
{"id":"XINHERIT","status":1,"failed":["explicit inheritSystemPrompt override wins over preset"],"passed":32,"pending":79}
{"id":"XLOG","status":0,"failed":[],"passed":33,"pending":79}
{"id":"XNO","status":0,"failed":[],"passed":33,"pending":79}
{"id":"XOUTPUT","status":0,"failed":[],"passed":33,"pending":79}
{"id":"XR2FALSE","status":0,"failed":[],"passed":33,"pending":79}
{"id":"XTIME","status":0,"failed":[],"passed":33,"pending":79}
{"id":"XTOOLS","status":0,"failed":[],"passed":33,"pending":79}
{"id":"XSP","kill":"KILLED","p":{"preset":"fixture","systemPrompt":"call prompt"},"o":{},"base":{"customSP":"call prompt"},"mutant":{"customSP":"preset prompt"}}
{"id":"XEMPTY","kill":"KILLED","p":{"tools":[]},"o":{},"base":{"toolOptions":{"tools":[],"excludeTools":"[undefined]","noBuiltinTools":"[undefined]"}},"mutant":{"toolOptions":"[undefined]"}}
{"id":"XUNK","kill":"KILLED","p":{"task":"security audit","preset":"nonexistent"},"o":{},"base":{"rname":"[undefined]","aname":"[undefined]","autoRouteKeyword":"[undefined]"},"mutant":{"rname":"security-auditor","aname":"security-auditor","autoRouteKeyword":"audit"}}
{"id":"XLOGALWAYS","kill":"KILLED","p":{"preset":"fixture"},"o":{},"base":{"logs":[]},"mutant":{"logs":[["Auto-routed task to preset",{"preset":"fixture","keyword":"[undefined]"}]]}}
{"id":"XR2EMPTY","kill":"KILLED","p":{"task":"security audit","tools":[]},"o":{},"base":{"rname":"[undefined]","aname":"[undefined]"},"mutant":{"rname":"security-auditor","aname":"security-auditor"}}
TOTAL 5/31 killed
X22 transport suite exit 1 failed [
  'a preamble carrying preset and capability keywords does not change resolution (routing isolation)'
]
{"input":{"task":"please respond","thinkingLevel":"bogus"},"validated":{"task":"please respond","thinkingLevel":"bogus"},"resolvedThinking":"<undefined>","tools":"<undefined>","preflight":{"valid":true,"warnings":[],"errors":[]},"args":["--mode","json","-p","--no-session","--model","p/m","--thinking","<undefined>"]}
{"input":{"task":"please respond","tools":[]},"validated":{"task":"please respond","tools":[]},"resolvedThinking":"xhigh","tools":{"tools":[],"excludeTools":"<undefined>","noBuiltinTools":"<undefined>"},"preflight":{"valid":true,"warnings":[],"errors":[]},"args":["--mode","json","-p","--no-session","--model","p/m","--thinking","xhigh"]}
{"input":{"task":"please respond","thinkingLevel":""},"validated":{"task":"please respond","thinkingLevel":""},"resolvedThinking":"xhigh","tools":"<undefined>","preflight":{"valid":true,"warnings":[],"errors":[]},"args":["--mode","json","-p","--no-session","--model","p/m","--thinking","xhigh"]}
null operators: {"nullish":"preset","or":"preset","emptyNullish":"","emptyOr":"preset","falseNullish":false,"falseOr":true,"zeroNullish":0,"zeroOr":60000}
- Type-safety audit of scratch mutants: `tsc --noEmit --strict --skipLibCheck --erasableSyntaxOnly --moduleResolution bundler --module esnext --target es2024 --esModuleInterop src/params.ts` reported M4 false-condition implementation TS2488 (spread possibly undefined) and M7 uncast bypass TS2322 (string not GitMode). These initial mutant constructions are not realistic compiling drift. Rebuild M4 as complete ternary removal and M7 as cast; remeasure below. X15/X16/X22/XTIME/XNO/XR2FALSE compile cleanly.
- `node edge-audit.cjs` actual pi validator accepts schema `thinkingLevel:'bogus'`; resolver returns undefined although typed ThinkingLevel; preflight passes and child args include undefined after --thinking. This live P4/P16 invalid-string hole is not mentioned in plan; triage separately, do not silently pin as a supported valid level. Empty string instead returns configured max.
- `npm run typecheck` on clean dev tree passed (exit 0). Full repo vitest not run (test plan, read-only boundary); scratch integration baseline 112/112 passed, and section1-only mutant matrix tested 33 of 112, 79 skipped.
{"id":"M4","kill":"KILLED","p":{"tools":["edit"]},"o":{},"base":{"tool.tools":["edit","write"]},"mutant":{"tool.tools":["edit"]}}
{"id":"M7","kill":"KILLED","p":{"gitMode":"garbage"},"o":{"git":"branch"},"base":{"resolvedGitMode":"branch"},"mutant":{"resolvedGitMode":"garbage"}}
TOTAL 2 killed (selected=M4,M7)
Revised M4 typecheck:
OK
Revised M7 typecheck:
OK
mutant tsc exit=0 files=31
{"id":"XSP","status":1,"failed":["uses preset values as defaults and allows overrides"],"passed":32,"pending":79}
{"id":"XEMPTY","status":0,"failed":[],"passed":33,"pending":79}
{"id":"XUNK","status":0,"failed":[],"passed":33,"pending":79}
{"id":"XLOGALWAYS","status":0,"failed":[],"passed":33,"pending":79}
{"id":"XR2EMPTY","status":0,"failed":[],"passed":33,"pending":79}

## Branch map reconciliation (source anchors from `nl -ba src/params.ts`; section 1 matrix by `node ... audit.cjs` plus scratch vitest `-t 'resolveSubagentParams integration'`)
P1 :419-425 routed / non-routed (existing routing tests); LOG both arms NOT asserted, XLOG/XLOGALWAYS survive §1.
P2 :427-429 preset lookup: known/absent route values (existing 'uses preset values as defaults and allows overrides', 'no preset + no overrides produces minimal defaults'); unknown name output not asserted.
P3 :430 existing 'auto-routes to a preset whose keywords match the task (E2)' and 'does NOT auto-route when an explicit preset is given'; M13 killed on autoRoutedPreset only, keyword stays undefined in BOTH.
P4 :432-434 preset + call-to-cap paths existing ('caps thinking level at the user-configured maximum', 'explicit thinkingLevel override is also capped at max'); precedence conflict M1 survives. Schema allows invalid strings -> undefined (edge-audit).
P5 :435 existing 'uses preset values as defaults and allows overrides' kills true inversion XSP; empty override M2 survives, preset-only customSP not explicitly asserted.
P6 :436 existing 'preset with inheritSystemPrompt=false carries through with no override' and 'explicit inheritSystemPrompt override wins over preset' kill XINHERIT.
P7 :437 existing 'no preset + no overrides produces minimal defaults' only absent; XOUTPUT survives.
P8 :438 existing preset fallback 'uses preset values as defaults and allows overrides' + 'normalizeTimeout: timeout 0 resolves to undefined (no instant kill)' and valid pass-through; M3/XTIME both survive. Preset timeout is only in-memory currently: presets-files.test.ts:302-364 loader invariant.
P9 :439 existing preset default in 'uses preset values as defaults and allows overrides', per-call tools in edit tests; override vs preset XTOOLS survives.
P10 :442-444 existing 'edit→write fix: edit-only allowlist gains write', 'edit→write fix: explicit write is not duplicated'; no edit in first defaults fixture, undefined in minimal. M4 M5 killed.
P11 :445 existing 'override with excludeTools merges correctly with preset tools' doesn't compare same field tiers; XEXCLUDE survives.
P12 :446 existing 'preset with noBuiltinTools is picked up as toolOptions' only default; XNO survives.
P13 :453 existing 'per-call gitMode branch wins over state config' and none; preset-named branch quirk M6 survives.
P14 :454-457 existing branch, none, invalid gitMode tests; M7 killed.
P15 :461 existing 'per-call approvalMode wins over state config', 'approvalMode falls back to state config when not specified', 'invalid approvalMode falls back to state config'; X15 killed.
P16 :463-466 existing two thinking cap tests; X16 killed. Missing invalid runtime input decision.
P17 :468-475 existing minimal undefined and preset with noBuiltin true defined; XEMPTY survives (empty array), false-only shape needs test.
P18 :481 existing 'absent task normalises to ...' + reader pins, M9 killed.
P19 :482 existing 'task label is trimmed when provided as blank string', M10 killed; no nonblank trim or empty-string pin.
P20 :483 existing 'inherits inheritSystemPrompt=true when not specified anywhere' + false preset, M11 killed.
P21 :487 existing fallbackCwd + cwd override for absent/nonempty; M12 on empty survives.
P22 :494 not §1; X22 survives §1 but killed by existing transport-auto-retry.test.ts 'a preamble carrying preset and capability keywords does not change resolution (routing isolation)' (scratch vitest probe).
R1 :377-379 existing 'does NOT auto-route when an explicit preset is given'; R5 nuance below.
R2 :382-386 existing four 'does NOT auto-route when ...' tests: tools/exclude/noBuiltin/template, RM1/RM2 killed. False/empty guards XR2FALSE/XR2EMPTY survive.
R3 :387-391 existing 'absent task normalises to ... and never auto-routes', and no preset minimal; match fixture contrast available in same §1.
R4 :392-397 existing 'auto-routes to a preset whose keywords match the task (E2)' asserts routed/resolved name, not keyword/log; R4 :396 keyword covered other suite for review; input 'security audit' resolves keyword 'audit', contrary to comment in §1 saying security.
R5 :377-379,427-429: §1 'unset preset when name not found falls through to defaults' does not assert undefined resolvedPreset nor suppression of otherwise routable input. `node schema-audit.cjs`: explicit nonexistent + security audit with available security-auditor -> resolveDispatchPreset {name:'nonexistent', preset:undefined, autoRouted:false}, outer resolvedPreset/autoRoutedPreset/keyword undefined. Pin suppression + undefined (XUNK kills); not equivalent to no preset since no preset routes.

## Open question responses
1. Complete partial-arm map above; existing-killed mutation records /tmp/probe429/existing-mutants.jsonl (33 tested, 79 skipped out of 112 in file).
2. R5 above: pin; do not duplicate weak §1 default assertion.
3. `node /tmp/probe429/project/schema-audit.cjs`: all 9 ?? inputs and 5 auxiliary null fields fail raw TypeBox Check but `validateToolArguments` COERCES null to absent. Thus none arrives as null via registered tool; direct typed-bypass calls are separate. `node edge-audit.cjs`: null ?? p === null || p, so plan's distinction is mathematically wrong. Discriminating valid falsies are empty string, false and 0; empty arrays are truthy for both operators, tested by shape/routing, not ??/||.
4. D2: tools:[] accepted, resolves shape, preflight may allow neutral task; foreground args omit allowlist and real SDK omitted default active tools [read,bash,edit,write], bg passes [] and SDK actual active []; output-file preflight sees write unavailable. Needs maintainer triage, not a global no-tools claim.
5. All 15 candidates and 16 additional mutants killed in byte-identical scratch; 31 TypeScript compilable after rebuilding M4/M7; results /tmp/probe429/mutants.jsonl, mutants-extra.jsonl, revised-mutants.jsonl. No candidate equivalent; M13 keyword is not a differing observable. Full suite not yet committed/run against all mutants; no claim about its eventual kills.

## D decisions
D1 branch preset + none config -> branch (documented quirk, pin resolver behavior). D2 shape [] confirmed but downstream mismatch above: maintainer decision / separate security bug. D3 labels '   ' and '' -> undefined. D4 omitted task -> ''; existing. D5 cwd '' -> /context. D6 schema + actual pi validator accept preset '', task security audit -> auditor and keyword audit; pin current resolver behavior, clarify empty preset isn't an explicit-name guard. All via `node schema-audit.cjs` and SDK probe.

## ≥5 required hand-run picks
Pick 10 distinct, all compile and have measured killing outputs: M1 (thinking precedence), M2 (empty prompt), M3 (timeout precedence), XTIME (invalid caller timeout vs valid preset normalization order), XOUTPUT, XTOOLS, XEXCLUDE, XNO (rest same-field precedence), X22 (keyword propagation, existing transport test) and XLOG (route logging). Also XINHERIT and XSP are already killed by the existing suite; issue requires each precedence inversion to have named killer, not necessarily manually run each. Alternative security-specific XEMPTY and routing-specific XUNK/XR2FALSE strongly recommended.

## Coverage / provenance notes
`find src/__tests__ -type f | wc -l` = 108 searched files; `rg -l resolveDispatchPreset src/__tests__` empty: no direct named call, but §1 and transport test indirectly exercise it. `rg -n autoRouteKeyword src/__tests__` finds transport test only. Out-of-scope anchors verified: background-default.test.ts tests real execute conditional matrix (lines 273-515); validate.test.ts:265-322 tests outputFile-vs-write and :545+ normalizeTimeout; templates.test.ts tests missing/extra params; templates-files.test.ts tests file validation. Repo plan's line 355-385 is wrong for seam; correct 370-398; P1-P22 anchors accurate. Baseline source SHA-256 matches copied source; `git diff 19e46c8 HEAD -- src/params.ts src/schema.ts src/__tests__/integration.test.ts` empty, only plan added between baseline and 51f5971.
{"id":"M1","kill":"KILLED","p":{"preset":"fixture","thinkingLevel":"high"},"o":{},"base":{"thinkingLevel":"high"},"mutant":{"thinkingLevel":"low"}}
{"id":"M2","kill":"KILLED","p":{"preset":"fixture","systemPrompt":""},"o":{},"base":{"customSP":""},"mutant":{"customSP":"preset prompt"}}
{"id":"M3","kill":"KILLED","p":{"preset":"fixture","timeout":1000},"o":{},"base":{"timeout":1000},"mutant":{"timeout":60000}}
{"id":"M4","kill":"KILLED","p":{"tools":["edit"]},"o":{},"base":{"tool.tools":["edit","write"]},"mutant":{"tool.tools":["edit"]}}
{"id":"M5","kill":"KILLED","p":{"tools":["edit","write"]},"o":{},"base":{"tool.tools":["edit","write"]},"mutant":{"tool.tools":["edit","write","write"]}}
{"id":"M6","kill":"KILLED","p":{"preset":"branch"},"o":{"presets":[{"name":"branch","description":"b"}]},"base":{"resolvedGitMode":"branch"},"mutant":{"resolvedGitMode":"none"}}
{"id":"M7","kill":"KILLED","p":{"gitMode":"garbage"},"o":{"git":"branch"},"base":{"resolvedGitMode":"branch"},"mutant":{"resolvedGitMode":"garbage"}}
{"id":"M8","kill":"KILLED","p":{"task":"hello"},"o":{},"base":{"toolOptions":"[undefined]"},"mutant":{"toolOptions":{"tools":"[undefined]","excludeTools":"[undefined]","noBuiltinTools":"[undefined]"}}}
{"id":"M9","kill":"KILLED","p":{},"o":{},"base":{"task":""},"mutant":{"task":"[undefined]"}}
{"id":"M10","kill":"KILLED","p":{"label":"   "},"o":{},"base":{"label":"[undefined]"},"mutant":{"label":""}}
{"id":"M11","kill":"KILLED","p":{},"o":{},"base":{"inheritSP":true},"mutant":{"inheritSP":false}}
{"id":"M12","kill":"KILLED","p":{"cwd":""},"o":{},"base":{"effectiveCwd":"/context"},"mutant":{"effectiveCwd":""}}
{"id":"M13","kill":"KILLED","p":{"preset":"fixture"},"o":{},"base":{"aname":"[undefined]","autoRouteKeyword":"[undefined]"},"mutant":{"aname":"fixture","autoRouteKeyword":"[undefined]"}}
{"id":"RM1","kill":"KILLED","p":{"task":"security audit","tools":["read"]},"o":{},"base":{"rname":"[undefined]","aname":"[undefined]"},"mutant":{"rname":"security-auditor","aname":"security-auditor"}}
{"id":"RM2","kill":"KILLED","p":{"task":"security audit","template":"known"},"o":{},"base":{"rname":"[undefined]","aname":"[undefined]"},"mutant":{"rname":"security-auditor","aname":"security-auditor"}}
{"id":"X15","kill":"KILLED","p":{"approvalMode":"always"},"o":{"approval":"auto"},"base":{"resolvedApprovalMode":"always"},"mutant":{"resolvedApprovalMode":"auto"}}
{"id":"X16","kill":"KILLED","p":{"thinkingLevel":"xhigh"},"o":{"max":"medium"},"base":{"thinkingLevel":"medium"},"mutant":{"thinkingLevel":"xhigh"}}
{"id":"X22","kill":"KILLED","p":{"task":"security audit"},"o":{},"base":{"autoRouteKeyword":"audit"},"mutant":{"autoRouteKeyword":"[undefined]"}}
{"id":"XLOG","kill":"KILLED","p":{"task":"security audit"},"o":{},"base":{"logs":[["Auto-routed task to preset",{"preset":"security-auditor","keyword":"audit"}]]},"mutant":{"logs":[]}}
{"id":"XTIME","kill":"KILLED","p":{"preset":"fixture","timeout":0},"o":{},"base":{"timeout":"[undefined]"},"mutant":{"timeout":60000}}
{"id":"XINHERIT","kill":"KILLED","p":{"preset":"fixture","inheritSystemPrompt":true},"o":{},"base":{"inheritSP":true},"mutant":{"inheritSP":false}}
{"id":"XOUTPUT","kill":"KILLED","p":{"preset":"fixture","outputFile":"call.md"},"o":{},"base":{"outputFile":"call.md"},"mutant":{"outputFile":"preset.md"}}
{"id":"XTOOLS","kill":"KILLED","p":{"preset":"fixture","tools":["bash"]},"o":{},"base":{"tool.tools":["bash"]},"mutant":{"tool.tools":["read"]}}
{"id":"XEXCLUDE","kill":"KILLED","p":{"preset":"fixture","excludeTools":["edit"]},"o":{},"base":{"tool.excludeTools":["edit"]},"mutant":{"tool.excludeTools":["bash"]}}
{"id":"XNO","kill":"KILLED","p":{"preset":"fixture","noBuiltinTools":false},"o":{},"base":{"tool.noBuiltinTools":false},"mutant":{"tool.noBuiltinTools":true}}
{"id":"XR2FALSE","kill":"KILLED","p":{"task":"security audit","noBuiltinTools":false},"o":{},"base":{"rname":"[undefined]","aname":"[undefined]"},"mutant":{"rname":"security-auditor","aname":"security-auditor"}}
{"id":"XSP","kill":"KILLED","p":{"preset":"fixture","systemPrompt":"call prompt"},"o":{},"base":{"customSP":"call prompt"},"mutant":{"customSP":"preset prompt"}}
{"id":"XEMPTY","kill":"KILLED","p":{"tools":[]},"o":{},"base":{"toolOptions":{"tools":[],"excludeTools":"[undefined]","noBuiltinTools":"[undefined]"}},"mutant":{"toolOptions":"[undefined]"}}
{"id":"XUNK","kill":"KILLED","p":{"task":"security audit","preset":"nonexistent"},"o":{},"base":{"rname":"[undefined]","aname":"[undefined]","autoRouteKeyword":"[undefined]"},"mutant":{"rname":"security-auditor","aname":"security-auditor","autoRouteKeyword":"audit"}}
{"id":"XLOGALWAYS","kill":"KILLED","p":{"preset":"fixture"},"o":{},"base":{"logs":[]},"mutant":{"logs":[["Auto-routed task to preset",{"preset":"fixture","keyword":"[undefined]"}]]}}
{"id":"XR2EMPTY","kill":"KILLED","p":{"task":"security audit","tools":[]},"o":{},"base":{"rname":"[undefined]","aname":"[undefined]"},"mutant":{"rname":"security-auditor","aname":"security-auditor"}}
TOTAL 31 killed (selected=all)

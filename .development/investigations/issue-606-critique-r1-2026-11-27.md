# #606 — plan critique r1: **rethink** (1 blocker · 5 majors · 2 minors)

Dispatch `critique-606-r1` (preset `project-plan-critic`, template `plan-critique`, `medium` per the pin),
audited HEAD `7933432c6d7672435f30c7e53ae3e05638132f7a`, 2m 6s, verdict recorded in
`.pi/jev-outcomes.log`. The spec's r2 answer to each row is `## r1 → r2, finding by finding` in
`issue-606-grill-spec-2026-11-27.md`; this file is the critic's verdict, kept verbatim so the round is
auditable after the spec moves on.

## Verdict

```
Verdict: rethink
```

| Severity | Plan location | Gap | Evidence (command + result) | Suggested fix |
|---|---|---|---|---|
| Blocker | §3, Falsifier (a) | `project-implementer` identifies **implementation**, not planning. The proposed gate misses design-proposal dispatches while gating later implementation dispatches. | `rg -n 'project-proposer\|project-implementer' .pi/skills/worktree/SKILL.md` shows design proposals use `project-proposer`; implementation is spec-driven and uses `project-implementer`. | Define the actual planning-dispatch identity and its coverage before selecting the gate. Falsifier: a real planning dispatch without a brief must reject; an unrelated dispatch must not. |
| Major | §3, parser and refusal | `brief: unavailable` is accepted even though it names no signed brief and requires no stated `noBrief` reason. Also `{ ok }` carries no slug to the file resolver. | `src/dispatch-line.ts` accepts its gap as `ok`; §3 explicitly mirrors that behavior. | Specify whether an unavailable brief is a refusal or a stated override, and return the parsed slug for file checks. Falsifier: an unavailable line cannot silently pass the signed-brief gate. |
| Major | §3, `noBrief` | This is a new **tool parameter** despite the claimed `validate.ts`-only shape. It needs schema, known-key, mode, retry and provenance decisions. `noJev` warnings alone do not establish recorded run provenance. | `rg -n 'noJev' src/{schema,params,history,index,background-pipeline}.ts` finds those seams; `snapshotOriginalParams` omits `noJev`. | Specify registration, forwarding, explicit retry semantics and the durable provenance surface. Falsifier: a stated override survives each supported dispatch path as specified, without an unknown-key warning. |
| Major | §3, runtime guard | Reusing `readNoJevReason` as-is does not refuse every coercion-stringified number. | A real `validateToolArguments` probe with the same string schema returned `"1e+21"` and `"1e-7"`; the existing regex accepted both. | Generalize the guard and test exponent-form numbers through the real coercion path. Falsifier: either number must not downgrade a rejection. |
| Major | Falsifier (a), Evidence/Tests | The proposed integration test does not require a **brief-specific** rejection or a valid Jev line. It could pass with the feature removed because the existing Jev gate already rejects before spawn. No Evidence or Tests sections, commands, or negative controls are specified. | `rg -n '^## (Evidence\|Tests)' <spec>` found none; `src/__tests__/dispatch-line-enforcement.test.ts:280` asserts an existing missing-Jev rejection and zero spawns. | Name commands, fixtures and assertions: valid Jev, brief-specific reason, zero spawns, and a confirmed-brief spawn control. Remove the brief gate as a measured mutant; the named test must fail. |
| Major | §4, Falsifier (b) | No conductor file reads does **not** establish that lookupable facts were never asked of the human; the proposed receipt can pass while the stated facts rule is violated. | §4 itself says the defect is asking the human; Falsifier (b) measures reads and greps only. | Audit both transcript predicates at the next real want. Falsifier: a lookupable question asked of the human fails even with zero conductor reads. |
| Minor | §2–3, worktree lookup | Committing to `dev` does not put the brief in an already-created worktree based on an older commit. | A scratch `git worktree add` probe produced `wt-old: missing`, `wt-new: present` for the same committed brief. | Require the dispatch worktree's checked-out commit to contain the brief, or explicitly handle the missing-file refusal. |
| Minor | §2, confirmation marker | The specified regex accepts a bare `confirmed:` or literal template placeholders as a signed brief. | `node` tested `/^confirmed:/i` against both: `true`. | Specify the intended minimum marker content and test it; state explicitly that a textual marker is not authentication. |

## Verified sound

- Audited HEAD `7933432c6d7672435f30c7e53ae3e05638132f7a`. Foreground and background resolution happen before
  validation; `resolvedPreset.name` can be forwarded without another resolution. Batch per-unit validation needs
  explicit forwarding from global resolved parameters.
- `readProcessChecks` is fail-open and `PROCESS_CHECK_KEYS` contains only `processChecks`; the plan does not propose
  another manifest field.
- `git grep -n -E 'noBrief|parseBriefLine|briefs/' -- src` found no existing implementation or tests. The three
  existing Jev/flag suites passed: **3 files, 83 tests**.
- Falsifier (b) is honestly deferred to the next want, not presented as a result from this build.
- No repository files modified. `$BRL_SCRATCH` was unset, so no progress bank could be written without inventing a
  path.

## Open questions the plan should answer

- Which dispatches count as planning, and is a recorded unavailable-brief escape acceptable for them?

  → Answered in r2 §0 (the gated class is the *code-writing* dispatch, with the rejected alternative stated) and §3
  (there is no unavailable-brief form; the only escape states a reason).

# #443 implementation brief — reject invalid thinking levels (AMENDED after critique)

**Status:** amended per `/tmp/CRITIQUE_443.md`; awaiting maintainer approval of this revision.
**Base:** `dev` @ `7808760` (2026-11-07). **Risk:** C2. Decision recorded in issue #443.

## Recon

`resolveThinkingLevel` (src/types.ts:835): production call sites are `resolveSubagentParams`
(params.ts:463) and `mergeSubTaskParams` (index.ts:492), plus tests. `validatePreTask`
(validate.ts:366): production call sites are `runPreTaskValidation` (prelude.ts:226) and the
`index.ts` dispatch paths, plus tests. Graph counts from `recon.sh` are caller-list entries, **not** an
exhaustiveness proof (the critique counted 4/9 distinct graph source nodes); the paths below are
established by reading the call sites and by execution tracing, not by those totals.

## Measured defect and severity

| input | resolved level | argv | child |
|---|---|---|---|
| `"bogus"`, `"MAX"`, `"High"`, `" high"` | `undefined` | `--thinking undefined` | pi warns `Invalid thinking level "undefined"`, runs at **its own default** |
| `"high"`, cap `off` | `off` | `--thinking off` | capped |
| `""` / omitted | cap | cap | defined |

Confirmed on the real child with the cap set to `off`: the child initialised at `high`, i.e. the
configured cap was **bypassed**, not a launch crash. Background behaves the same (SDK session at the
model default while the agent/run records say `medium`, and `originalParams.thinkingLevel` keeps
`bogus`). Foreground run-record persistence of the `undefined` value was read, not exercised.

## Decision (issue #443)

Reject unknown **non-empty** levels before any launch; case- and whitespace-exact; `""` and omission keep
today's behaviour; `max` is rejected with the supported set named; restored/persisted values are covered
as well. Corrupt non-string `maxThinkingLevel` in persisted state is out of scope (follow-up).

## Deliverable — one predicate, honest seams

1. `isThinkingLevel(value: unknown): value is ThinkingLevel` beside `THINKING_LEVELS` in `src/types.ts`.
   Never re-spell the level list. `resolveThinkingLevel` keeps its clamp semantics for valid input; it
   cannot report failure, so it is not the guard.
2. **Guard every seam that can reach a launch with a declared value, before the value is lost to
   resolution.** The amendments below are the critique's blockers and are mandatory:
   - **Effective declared value, not just raw tool input.** Check the value that actually reaches
     resolution: per-call param **or selected preset object** (a programmatically injected preset is not
     covered by the preset-file validator) and per-unit declarations for `tasks`/`chain`/`graph` and the
     background fan-out pre-pass.
   - **Restored values.** Guard the output of retry-parameter resolution so manual `retryRunId`,
     transport auto-retry (which bypasses `execute`) and inline `retryOnTimeout` are all covered. On the
     transport path, a rejection must still surface the **original failure notice** and must not launch an
     SDK session.
   - **Do not rely on `validatePreTask` alone:** it returns early for an empty mode-level task, and by the
     time it runs the resolved value may already be `undefined`. If it is the chosen seam, thread the raw
     declared value and run the check before that early return; prove it with a bypass test.
   - **Do not rely on the schema alone:** pi validates raw tool arguments, not restored values. Say
     explicitly, in the PR, which seam covers which path.
3. **Schema tightening is a first line of defence only, and must preserve `""`.** Use a representation
   whose pi error names the whole supported set — the critique measured `Type.String({enum: [...]})` does,
   while a literal union names only its first branch. The enum must include the empty string so the
   preserved empty semantics are not broken. Verify the exact error bytes
   (`thinkingLevel: expected "off" | "minimal" | …`) in a test.
4. Surgical: no new dependency, no `max` support, no cap-semantics change, no unrelated refactor.

## Acceptance

1. Keep the pre-fix reproduction as **historical baseline** only. The post-fix falsifier is a
   **registered dispatch that launches nothing** — not "the resolver/argv call changes", because a guard
   at the pre-spawn seam legitimately leaves those inner calls unchanged.
2. Bypass tests must call the guard's seam **without pi's schema validation** (restored values, injected
   preset objects, direct dispatch), because a schema-rejected raw input never exercises the runtime
   guard. Pi-boundary tests stay, but they are not the guard's killers.
3. Coverage by path, each asserting **zero** child processes / SDK sessions:
   unknown top-level; unknown per-unit value for `tasks`, `chain`, `graph` and background fan-out (a bad
   **second** unit must prevent the whole batch); unknown value in a selected preset (named and
   auto-routed); unknown value restored by manual `retryRunId`; unknown value on the transport auto-retry
   path (plus the original-failure notice); unknown value on inline `retryOnTimeout`.
4. Preservation: every valid level; above-cap clamps; `""` top-level → cap; `""` per-unit → global level
   **with global different from cap**; omitted → cap; `"max"` rejected naming the set; `High`/whitespace
   rejected per the policy.
5. Schema: valid values accepted, `""` accepted, unknown rejected with the full set in the message, and no
   existing documented usage broken (README documents the six brl levels; `max` is the only compat note).
6. Named mutants, each with the **bypass-style** killer named above:
   - (a) delete the shared predicate check → restored-bogus rejection test fails, valid-level tests stay green;
   - (b) guard only the global/top-level declaration → the bad-second-unit batch test fails;
   - (c) guard only raw tool input, before retry/preset resolution → the restored-bogus and injected-preset
     tests fail.
   State the target and expected failure signature before each run; a surviving mutant is reported as
   surviving, never claimed as a kill. Note explicitly that (a)–(c) are only demonstrable once the
   implementation exists.
7. Gates: full `npx vitest run` with a JSON report, `npm run typecheck`, both docs guards, `git diff --check`,
   and the README test-count drift guard. Unset inherited `BRL_SUBAGENT_DEPTH` / `BRL_SUBAGENT_CHILD_MARKER`.
8. Documentation: README `thinkingLevel` description + CHANGELOG `Unreleased` entry, stating the rejection,
   the case/whitespace policy, that `""` keeps its meaning, and that `max` becomes a rejection.

## Limits

No OS-level guarantee and no change to pi's own `max`. Values already erased into persisted unit records
(the resolved `undefined`) cannot be truthfully rejected later — document that rather than inventing a
migration. Corrupt non-string persisted caps are a follow-up.

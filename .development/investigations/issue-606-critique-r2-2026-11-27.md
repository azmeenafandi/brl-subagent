# #606 — plan critique r2: **rethink** (8 majors · 1 minor · 0 blockers)

Dispatch `critique-606-r2` (preset `project-plan-critic`, template `plan-critique`, `medium` per the pin),
audited HEAD `ef12ca9`, 2m 3s. Kept verbatim so round 2 stays auditable after the spec moves to r3.

The two findings that decided the redesign were verified conductor-side before acting:
`src/router.ts:79` routes **`implement`/`build`/`code`/`write`/`add`/`change`/`modify`/`edit` to `dev-agent`** (so the
preset arm missed the ordinary implementation dispatch), and `src/prelude.ts:437` — not `mode-prologue.ts:143` — is
the real per-unit validation site, with no per-unit `preset` in the unit schema.

| Severity | Plan location | Gap | Evidence | Suggested fix |
|---|---|---|---|---|
| Major | §0, §Residual, falsifier (a) | The residual hollows out the adopted "every dispatch that writes code" class. An ordinary automatically routed implementation can use `dev-agent`, not either trigger; #599 is open and does not enforce its proposed generator today. | `rg -n 'dev-agent\|project-implementer' src/router.ts .pi/skills/worktree/SKILL.md` found `dev-agent` as the implementation keyword route; `gh issue view 599` shows the generator as a proposed fix. | Define an enforceable Unit 1 classification boundary, or explicitly narrow the claimed guarantee with maintainer acceptance. Falsifier: a normal code-writing dispatch without a brief must not spawn. |
| Major | Recon, §3, five sites | The batch mechanism is wrong: `mode-prologue.ts:143` is **mode-level**, not per-unit. A unit cannot currently name its own preset: neither its schema/type nor the merge carries one. Forwarding alone cannot implement the promised precedence. | `rg -n 'runPreTaskValidation\|validatePreTask' src` found five production constructions; `src/types.ts:531`, `src/schema.ts`, and `src/unit-params.ts` have no unit preset. Actual per-unit validation is `src/prelude.ts:437`. | Specify the supported batch contract and the data flow to the actual per-unit site; reconcile it with "no schema change." |
| Major | §3, T2–T3 | The `kind: impl` trigger has no parsing boundary. Incidental prose can trigger it, and even a whole-line regex matches a quoted fenced example. A review of this spec can therefore be refused. | A Node probe found `/kind:\s*impl/i` matches incidental prose; `/^kind:\s*impl\s*$/m` also matches a fenced example. | Require an exact, unfenced declaration in a designated dispatch metadata header, and test prose, quoted blocks, and a real declaration. |
| Major | §Evidence E1–E5; §Tests T1–T7 | The evidence audit is not closed. E1's `rg` succeeds with the existing Jev flag even if the brief gate is deleted; E2 searches `presetName`, not all config constructions; E3 loads presets but does not exercise validation; E5 has no executable command. Test rows name predicted killers, not measured mutation results. | `rg -n '^\| (E[1-5]\|T[1-7]) \|' <spec>` returned all 12 rows. | Supply executable probes with pass/fail assertions and mutation-run receipts at the implementation HEAD. |
| Major | §Tests T3–T7 | Mutant reachability is underspecified. T3–T5 need an opted-in cwd and valid Jev; T6 needs a valid same-slug cockpit brief; T7 does not require a valid Jev on its refusal input, so Jev alone can keep zero spawns under M1. | `src/validate.ts:385` returns early for empty tasks and checks Jev before the proposed block. | Pin these fixtures and assert the brief-specific outcome, then measure each mutant. |
| Major | §4, falsifier (b), r1→r2 row 6 | A sourced Facts table does not prove that no lookupable question was asked: the human may answer one that is omitted from the table. The prior finding remains open. | `rg -n 'Facts\|lookupable' <spec>` shows the proposed second predicate examines table provenance, not human-directed transcript questions. | Audit the transcript's human-directed questions separately from fact provenance. |
| Major | §2–3, T5 | The only required validation of a present file is its final marker. A file containing only `confirmed: 2026-11-27 by azmeen` satisfies that rule, despite lacking the decisions and human words required by issue #606. | `gh issue view 606` requires the frontier, settled decisions and human's words; §3 names only existence and marker checks. | State and test the minimum non-hollow brief structure. |
| Major | §3, T6 | The stale-worktree guarantee is conditional on the dispatch cwd itself opting in. A subdirectory or old tree without its own opted-in manifest bypasses the whole check. | A `/tmp` probe of `readProcessChecks` returned `root true child cwd false`; `src/project-flags.ts` reads only `<cwd>/package.json`. | Specify the opt-in boundary and test both enabled stale cwd and missing-manifest cwd; do not claim unconditional refusal. |
| Minor | §3 parser and resolver | `<slug>` has no defined grammar or containment rule. A traversal-shaped value could resolve outside `briefs/`. | `node` with `path.resolve('/repo/briefs', '../../README.md')` produced `/README.md`. | Specify a single-component slug grammar and reject traversal, separators and reserved `none`. |

## Verified sound (carried forward)

- Five production config constructions, no sixth. The r1 unavailable form and `noBrief` appear only in historical
  discussion. A real retry-merge probe retained the task's escape line and preset; `snapshotOriginalParams` omits
  `noJev`. All four validating paths render validation warnings (the new escape behaviour still untested).
- T6's fixture shape is constructible; the T5 marker inputs are distinguishable.
- `$BRL_SCRATCH` was unset → no bank written rather than inventing a path. No repository files modified.

## Open question the plan must answer

> What accepted classification boundary replaces the current opt-in residual while preserving the settled
> code-writing decision?

→ r3 answers it with a **mandatory dispatch header** (§3): the boundary is a declaration at the top of every
dispatch's own task text, so absence is itself a refusal and no preset resolution, per-unit schema or batch
plumbing is involved.

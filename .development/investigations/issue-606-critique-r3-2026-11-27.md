# #606 — plan critique r3: **needs-work** (5 majors · 1 minor · 0 blockers)

Dispatch `critique-606-r3` (preset `project-plan-critic`, template `plan-critique`, `medium` per the pin),
audited HEAD `d186226`, 1m 55s. Kept verbatim so round 3 stays auditable after the spec moves on.

Conductor-side verification before acting: `classifyTask` (src/router.ts:124) matches keywords against
`task.toLowerCase()` over the **entire** string, first rule wins, and is called only from
`resolveDispatchPreset` (src/params.ts:497) — so a mandatory header would silently re-route dispatches.
`validateTemplate` (src/templates.ts:116) validates known fields and **ignores unknown ones**, so a misspelled
`dispatch:` would disable the gate with no warning. `e2e-subprocess.test.ts` carries 9 real `task:` dispatches.

| Severity | Plan location | Gap | Evidence | Suggested fix |
|---|---|---|---|---|
| Major | §3, Cost | The header changes auto-routing, so retrofit is not purely mechanical. `dispatch: review` itself matches the router's review keyword before the task is classified. | A real `classifyTask` call via `jiti` returned `test-engineer` for `Write tests for module`, but `code-reviewer` after prepending `dispatch: review`. | Define and test routing on the intended task content without metadata contaminating classification. Falsifier: adding a valid header alone does not change the selected preset. |
| Major | §2–3, T5 | "Non-empty Want" and "one row" do not define content predicates. A heading immediately followed by another heading or a table row of empty cells can satisfy plausible implementations; conversely, an honest confirmed want with no decisions is refused. | `rg -n 'Want\|Settled decisions' <spec>` finds no row-cell or section-boundary predicates; T5 tests only marker-only versus one populated example. | Define section boundaries and non-whitespace cell requirements, and decide explicitly how zero-decision wants are represented. |
| Major | Evidence P1–P8; Tests T1–T9 | The evidence audit is not closed. P1 names `scripts/<probe>.mjs`, not an executable command; P5 can print "no check" without demonstrating that validation was bypassed; P8 lacks a valid same-slug other-tree control. T3, T6, T8 omit valid Jev preconditions, and T9 has no mutant for missing-field refusal. | `rg -n '^\| (P[1-8]\|T[1-9]) \|' <spec>` returns all 17 rows. `src/validate.ts:409` checks Jev before the proposed gate. | Name executable probes and assertions, use a deliberately invalid header for P5, pin valid Jev on every integration path, require measured mutation receipts at HEAD. |
| Major | Falsifier (b) | A conductor-authored list of questions is not a completeness check against the transcript. It can omit a lookupable question — or label it a decision — and pass even when the facts rule is violated. | `rg -n 'transcript\|question\|receipt' <spec>` finds the self-authored list but no transcript reconciliation or independent classification rule. | Require reconciliation against the complete human-directed transcript and a checkable fact/decision classification rule. |
| Major | Falsifier (a), §3 escape | The falsifier says any `impl` without a signed brief is refused, while `brief: none — reason` explicitly allows it with a warning. This is an unacknowledged exception, not the stated universal guarantee. | `rg -n 'brief: none\|any.*dispatch\|signed brief' <spec>` finds both requirements. | State the escape's effect on the guarantee and test the exact exception. |
| Minor | Cost, tests and rollout | The retrofit inventory is incomplete: real subprocess integration dispatches and older retry records exist beyond the three named suites. The quoted 83 is from an earlier head and is not labelled provisional. | `rg -n 'runDelegateTask\|task:' src/__tests__/e2e-subprocess.test.ts` finds real single, chain, and graph dispatches; its harness uses a temporary cwd. | Inventory opted-in versus non-opted-in fixtures and legacy retries; remeasure counts at the implementation HEAD. |

## Verified sound

- Audited HEAD `d186226`. Issue #606 and both prior critiques read; #599 remains open.
- `applyTemplate` really replaces a supplied task. The 14 named templates are tracked; proposed new paths are not
  gitignored.
- The stale-tree boundary and slug grammar are explicit; T7 specifies a valid Jev line and a brief-specific refusal.
- No repository files modified. `$BRL_SCRATCH` unset → no bank written rather than inventing a path.

## Open question

None beyond the concrete decisions and falsifiers listed. All six are answered in r4's `## r3 → r4` table, with a
seventh found conductor-side (`validateTemplate` ignores unknown frontmatter fields).

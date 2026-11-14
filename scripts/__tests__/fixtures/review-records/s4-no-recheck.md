<!--
Regression fixture S4 (issue 487) — a merged unit's record as it reached the gate.
Provenance: PR 484, "boot recovery + terminal notifier". Every field is present except the
classifier recheck — the conductor added that line by hand before the merge.
Expected: rejected, named reason `missing-recheck`.
-->

# Review record — PR #484 (S4: boot recovery + terminal notifier), adversarial C1

Verdict: approve-with-nits
Risk class: C1
Reviewed head: 89717ab12208d6257569c0ff66b2f31f16c33a3b

## Findings table (severity | Smell | file:line | one-liner)

| Severity | Smell | file:line | One-liner |
|---|---|---|---|
| minor | `duplicated-code` | `src/__tests__/runtime-vocabulary.test.ts:113` | a fifth allow-list entry restates the same recorded reason |
| info | n/a | `src/index.ts:2004` | a release binding is declared after the shutdown registration that uses it |

Verdict-adjacent prose, deliberately inert: the record documents the gate's own fields, so it
mentions the `Verdict:` line and a fenced example below without either one becoming the disposition.

~~~md
Verdict: approve | approve-with-nits | changes-requested
~~~

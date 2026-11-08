# 0025. The Jev level is an observation: the gate is provenance + risk, and a model-aware arm is measured against outcomes

- **Status:** Accepted
- **Date:** 2026-11-08
- **Issues:** #468, #456
- **Supersedes:** Rule 22's level-control clauses only — the "≥2-level deviation carries a one-line
  reason" rule, the "any level below Jev on a review carries a reason" rule, the low-confidence
  carve-out (`C1` with `conf < 0.5` ⇒ +1 raise is justified), and the floors (artifact dispatches
  floor at `low`, reviews at `medium`). Everything else in Rule 22 stands: the line is still
  recorded, `--ledger`/`--log`/`--require-provenance` still gate, and the **risk class** still sets
  review depth.

## Context

The level was the last field in the ritual that nobody had shown to be load-bearing. Measured on
2026-11-07/08: two hand-typed dispatch lines were wrong on level and the provenance check caught
them; both dispatches succeeded anyway, because the **model** dominated the outcome — `muse-spark`
at `medium` returned a 13-mutant review, `deepseek-flash` at `medium` delivered a five-step C1
implementation. The same day the maintainer pinned plan critiques to `thinkingLevel: "medium"`
*regardless of what the classifier answers*, which is a control overriding the control.

The apparatus also could not learn. A provenance row recorded the classifier's **answers** — not
the model that would run the dispatch and not what happened — so no amount of logging could answer
"was this level right for this model". The one existing backtest (2026-10-10, 98 dispatches) measured
**agreement** between the classifier and the conductor: two unvalidated opinions, neither checked
against an outcome.

**B was already true in the code, measured.** `auditDispatchTask` validates the line's shape;
`analyzeDispatchLog` matches the printed line exactly against the provenance set; `merge-guard.sh`
check (f) compares the **risk rank** of the record against the recheck and never reads the level's
value. So B is a documentation and regression-pin change, not a behaviour change: the level was
already an observation everywhere it mattered, while the prose still demanded a deviation reason for
it.

## Decision

**(B) The level is an observation, with no format break.** `jev: <level> (<conf>) · C<n> ·
worktree <y|n>` keeps its shape and its role in the artifact; `REQUIRED_DISPATCH_FORM`, the recheck
grammar, the exceptions file, `--ledger`, and the ledger table are untouched. The gate is
**provenance + risk + worktree**. Two pins hold it:

1. a `--selftest` fixture proving a wrong-but-provenanced level passes `--log --require-provenance`
   and fails without its row (and that a line missing the risk class still blocks);
2. a `merge-guard.sh --selftest` case proving a recheck whose **level** sits below the dispatch's
   level passes when the **risk** class is equal. Verified to discriminate: a temporary clause that
   rejected a below-dispatch recheck failed exactly that case (22/23) and was reverted.

The level's prose controls are withdrawn: no deviation reason, no below-Jev review note, no floor.

**(C1) Keyed optional columns, fail-closed.** The row keeps its base `<iso>\t<label>\t<line>` and
accepts up to three keyed columns — `stated:worktree` (#456), `model:<provider>/<id>`,
`level-model:<level> (<conf>)` — any subset, any order, each at most once (max 6 columns). Keyed, so
the matched line never changes: 3-, 4-, 5- and 6-column rows coexist and `--require-provenance`
stays an exact-text comparison (129 live rows parse unchanged). Fail-closed on an unknown key, a
duplicate key, a malformed value, a key before the line column, a tab inside a value, a truncated
row, and a confidence outside `[0, 1]`. The model pattern allows **multiple** slashes: the ids
actually dispatched include `openrouter/meta/muse-spark-1.3-contributor` and
`openrouter/~typesafe/jev-latest`, both of which a single-slash pattern rejects.

**(C2) Two arms, one blindness invariant.** The blind arm keeps the template exactly (`state` = the
task text, nothing else — the chosen level never enters it). The model-aware arm is the **same
template plus one model stanza**, the only difference, so the delta is attributable.
`--classifier --model … --classifier-model-aware '<raw answers>'` prints **one** pasteable line (the
blind arm's — byte-identical with and without the new data), records the aware answer as a stderr
diagnostic plus a `level-model:` column, and falls back to blind-only when arm 2 fails. The aware arm
requires `--model` (exit 2) because an arm without a model names nothing; it never blocks a dispatch.

**(C3) Outcome sidecar, keyed by label.** `--settle <label> --kind impl|review|probe --outcome
done|failed|stopped|unknown [--verdict …] [--nits N] [--model-ran <id>]` appends to
`.pi/jev-outcomes.log`: header `# jev-outcomes — cutoff <full ISO instant>` (a date-only header is a
structural error), rows `ts\tlabel\tkind\toutcome\tverdict|null\tnits|null\tmodel-ran|null`. It is a
**sidecar, not a second provenance row**, precisely so the matched row is never edited. `--kind` is
required: reviews are recorded but excluded from level calibration, because a `changes-requested`
review is a *good* review, not a level failure. Refusals (exit 2, file unchanged): unknown label,
duplicate settle, unknown kind/outcome/verdict, `--nits` without a verdict or a non-integer, a
malformed `--model-ran`, and a 0-byte file.

**(C4) `--calibrate`: a cohort, a floor, and an explicit no-data matrix.** Cohort: `kind=impl`,
`outcome ∈ {done, failed}`, and a verdict for `done` (`unknown`/`stopped`/`review`/`probe` are not
eligible). Output: `eligible / settled / with-model`, then per model (including an `(unstated)`
bucket for legacy rows) N, the observed-sufficient count, both arms' agreement against the
**dispatched** level, and the delta direction (above/below/equal). Below **20 eligible rows** it
prints counts only and says `no conclusion (N<20)`. It never declares a winner, and it states its
bias in the output: both arms are scored against the conductor's own choice, on runs that worked.

The no-data precedence is deliberate and each case has its own exit code and message: the provenance
log first (missing/unreadable/empty ⇒ 2), then the sidecar (ENOENT ⇒ 0 "no settle data yet"; 0 bytes
⇒ 2 "delete it to re-initialize"; date-only or malformed header ⇒ 2 naming the expected full
instant; zero rows ⇒ 0 "0 settled"; a malformed row ⇒ 2 naming the row), then the join (an orphan
settle ⇒ 2 naming the label), then the cohort (zero eligible ⇒ 0 `N=0`).

**(C5) The prose follows the code.** `SKILL.md` Rule 22, `references/jev-advisory.md`, and
`references/rule-notes.md` are updated; this record carries the decision.

## Alternatives rejected

- **A second row type in the provenance log.** The settle would become a provenance edit, the
  exact-text match would have to learn two shapes, and an appended outcome could invalidate a
  dispatch that already merged. The sidecar keeps the artifact frozen and the join explicit.
- **`model:unstated` as a padded literal** (the issue's first wording). An absent column is an
  absence. Writing `unstated` into the row would make "no model was recorded" indistinguishable from
  "someone recorded the string", and it would rewrite the meaning of every legacy row. The
  `(unstated)` bucket is derived at read time instead.
- **Computing an "observed-sufficient level" from verdicts and nit counts.** That would invent a
  level the classifier never produced and the conductor never chose. Observed-sufficient is defined
  as the dispatched level of a run that came back `approve`/`approve-with-nits` — a comparison
  against what we actually did.
- **A ranking, or a table below N=20.** The backtest that motivated all of this ranked on agreement
  across 98 dispatches and still could not say whether the level was right. Six rows would be the
  same theatre in a new costume.
- **Runtime detection of the model that ran.** There is no reliable signal after a transport retry
  or a provider fallback. `--model-ran` is a *stated* manual correction on the settle row, and it is
  described that way everywhere.
- **Reading the level in `merge-guard.sh` check (f).** It would make the level a gate again, one
  level of indirection away from where B removed it; the pin exists to keep that from creeping back.

## Consequences and limits

- **The falsifier is pre-committed.** After 20 eligible implementation dispatches with mixed models,
  if the model-aware arm's agreement is **no better** than blind, the model input is deleted:
  `--classifier-model-aware`, the model stanza, and the `level-model:` column go; the provenance log,
  the settle sidecar, and `--calibrate`'s counts stay. The decision is made on that cohort, not
  deferred — otherwise C is a permanent ritual whose value is assumed.
- **There is no learning loop.** The classifier is stateless. What accumulates is our ledger; nothing
  feeds back into the model, and no claim here says it does.
- **Levels are recorded as REQUESTED, not as capped.** A `thinkingLevel` cap can lower what the model
  actually runs at; the row cannot see that. `--calibrate` says so in its own output.
- **Legacy rows have no model**, so the `(unstated)` bucket is where most of the first 129 rows land.
  They are not rewritten: the log is a historical record.
- **`--model-ran` is a manual correction, not detection**, and unverifiable by the tool — stated in
  the settle message, the docs, and here.
- **Blind agreement is tautological by construction**: the dispatched level *is* the blind arm's
  line, so that number is 100% unless the conductor overrode it. It is printed with that sentence
  beside it, because a metric that cannot fail must not look like evidence. The informative numbers
  are the aware arm's agreement and the delta direction.
- **The sidecar is local and gitignored**, like the provenance log; there is no rotation and no
  retention policy. A corrupt or truncated file fails closed (exit 2) rather than reading as
  "nothing settled", and the recovery path is an operator decision, stated in the message.
- **Nothing ships.** `.pi/skills/**` is outside `package.json.files`, so no release checkpoint and no
  shipped behaviour change follow from this record.

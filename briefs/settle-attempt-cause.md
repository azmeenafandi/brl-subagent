# Brief — the settle row must say which attempt did the work (#616, PR B)

Slug: `settle-attempt-cause` · grilled 2026-11-28, one question at a time, eight decisions.
Issue: #616. Ship shape: **PR B of two** (PR A is `briefs/stop-lineage-contract.md`).

## Want

> "Also adjacent, not the same defect: the retry inherits the label, so `--settle <label>` and the
> provenance log see one name for two agents — which is why `review-612` ended up settled as `stopped …
> ran deepseek/deepseek-flash` while its retry had been doing the work."
> — the maintainer, issue #616.

> "2"
> — the maintainer's answer (Q5): in scope for #616, **tooling-only**.

When one dispatch ran as two agents, the one settle row must be able to state which attempt actually did
the work — without changing what a human types to settle.

## Facts

Sources: `recon-616` (read-only probe, 2026-11-28, facts inline) and the conductor's reads; `dev @ 16b79ed`.

| # | Fact | Source |
|---|---|---|
| F1 | `--settle <label>` requires a provenance row carrying exactly that label, and **refuses a second settle** for the same label. | `.pi/skills/worktree/jev-check.mjs:1202-1213` |
| F2 | Provenance rows are `<iso>\t<label>\t<line>`; the outcome sidecar is `.pi/jev-outcomes.log`, row `<ts>\t<label>\t<kind>\t<outcome>\t…`. | `jev-check.mjs:39-40`, `:139`, `:146`, `:1045-1046` |
| F3 | The calibration join is `new Map(provenance.entries.map((e) => [e.label, e]))` — one entry per label, last wins. | `jev-check.mjs:1330`, used `:1277`, `:1332`, `:1347` |
| F4 | `sprint-metrics.py` joins retry success by label and reports transport deaths per label. | `.pi/skills/worktree/sprint-metrics.py:907-925`, `:35`, `:61` |
| F5 | A retry inherits its label, and an automatic retry never passes through `delegate_task` — so it gets **no** provenance row and **no** settle row of its own. | `src/history.ts:211`; recon-616 |
| F6 | `--settle` already accepts `--model-ran <id>` to "correct the model for a transport retry or a fallback". The incident's conductor did not use it. | `jev-check.mjs` settle help text |
| F7 | Nothing under `~/.cache/brl-subagent` is label-keyed — that tree is `runs/<run-id>` scratch and session dirs. | recon-616 Q8 |
| F8 | `jev-check.mjs` carries its own verification surface: `--selftest`, `--ledger` and `--log` audits, which run in CI. | `jev-check.mjs` header; `--ledger`/`--log` modes |

## Settled decisions

| Decision | Answer | Why |
|---|---|---|
| In scope? (Q5) | **In #616, tooling-only**, as its own PR. | The process record is a different defect from the stop contract, but the stop result will now name attempt and cause — the follow-up evidence exists, so the fix should too. |
| The mechanism (Q5) | `--settle` gains keyed columns **`--attempt N`** and **`--cause transport\|manual`**. | One row must state which attempt did the work, without changing the settle key. |
| Settle key | **Unchanged: one settle per dispatch.** No label change at mint time, no `dispatchId` in the ledger, no change to the merge gate's `matchRow`. | Changing what a human types at settle time, in the same week as a stop-contract change, moves two rituals at once with no clean rollback. |
| Failure mode | A missing column is **allowed** (unknown, not an error); a malformed one exits 1. | The row must stay byte-compatible with rows written before this change. |

## Contract (what the implementation must satisfy)

- `--settle <label> --kind <k> --outcome <o> [--verdict …] [--nits N] [--model-ran <id>] [--attempt N] [--cause transport|manual]`.
- Both new columns are **optional keyed columns** appended to the existing row shape, in the sidecar's
  established `key:value` form; their absence leaves today's row byte-identical.
- Validation: `--attempt` must be an integer ≥ 1; `--cause` must be exactly `transport` or `manual`; anything
  else exits 1 naming the offending value. No coercion of `"2"`, `"1e+21"`, `" 2"` into a valid value.
- `--attempt`/`--cause` given **without** `--settle` is an error (they are settle columns, not ledger fields).
- `--selftest` stays green and gains rows for: the two columns present, each malformed, and absence.
- Help text and the skill reference that documents `--settle` are updated in the same PR.
- No `src/` change at all.

## Falsifiers

1. `--settle l --attempt 2 --cause transport` → the sidecar row carries both, and the existing fields are unchanged.
2. `--settle l` with neither column → the row is byte-identical to one written before this change.
3. `--attempt 0`, `--attempt x`, `--attempt "2 "`, `--cause Transport` → each exits 1 and writes **no** row.
4. A second settle for the same label is still refused (F1) — this PR does not weaken the key.
5. `--selftest` green, including the four new rows; `--ledger` and `--log` audits unchanged.

confirmed: 2026-11-28 by Azmeen

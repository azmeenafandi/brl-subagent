# Jev advisory — pre-dispatch thinking-level calibration

**Rule 22 companion.** Before writing a spec or dispatch, classify the task with the
**Jev** classifier (TypeSafe System One) and record the result in the spec/dispatch:

```
jev: medium (0.72) · C2 · worktree y
```

The form is fixed: `<level> (<conf>) · <Cx> · worktree <y|n>`. (`· risk C2 ·` is the old
hand-written shape — the audit parses the canonical one, and `--line` prints it.)

## How

Run this via the `codemode` tool (requires `+codemode` in the session's default tools,
e.g. `.pi/settings.json`). **Blind:** put the task text in `state` and nothing else —
including the chosen level would bias the answer. **Build that task text from the input
template below** (hazard facts in; our conclusions out). Model id: provider `openrouter`,
id `~typesafe/jev-latest` (alias; `pi --list-models` shows it as `typesafe/jev-router`).
Cost ~$0.00003/call, ~1 s; a full sprint's dispatches ≈ $0.004.

```js
const jev = await models.getModelOfType("classifier", "openrouter", "~typesafe/jev-latest");
const r = await models.classify(jev, {
  state: { task: "<the dispatch task text>" },
  questions: {
    level: { type: "choice", instructions: "What is the MINIMUM thinking effort this task requires from a coding agent?", criteria: {
      off: "Pure lookup or one-word answer; no reasoning",
      minimal: "Mechanical one-line edit, syntax check, or find-and-replace",
      low: "Small, well-specified change: docs, refactor with a fixed shape, test generation",
      medium: "Moderate analysis: code review, debugging, multi-file change with a settled design",
      high: "Complex debugging, security audit, or architecture decisions with real tradeoffs",
      xhigh: "Multi-step causal reasoning, novel problem solving, long research chains" } },
    risk: { type: "choice", instructions: "What risk class does this change belong to?", criteria: {
      C1: "State, concurrency, teardown, security — needs a full adversarial review",
      C2: "Logic, API, cross-module behavior — needs a focused review",
      C3: "Display, docs, config — conductor diff read suffices" } },
    worktree: { type: "bool", instructions: "Does this change require a git worktree?", criteria: {
      true: "It modifies src/ or presets/", false: "It does not modify src/ or presets/" } },
  },
});
return r;   // the RAW response — this is what --classifier consumes (never a hand-built summary)
```

## The line — format it with the helper, never by hand

The classifier's **raw response** is the input to `.pi/skills/worktree/jev-check.mjs --classifier`,
which derives and prints the exact dispatch line (and refuses a level without a confidence):

```bash
$ node .pi/skills/worktree/jev-check.mjs --classifier \
    '{"answers":{"level":{"choice":"medium","confidence":0.84},"risk":{"choice":"C2"},"worktree":{"probability":0.9}}}'
jev: medium (0.84) · C2 · worktree y          # paste this into the spec and the dispatch
```

### The `worktree` field is a process fact — state it (issue #456)

`level` and `risk` are model answers. `worktree` is not: the classifier's own criterion is
mechanical ("it modifies `src/` or `presets/`"), yet it answers with a *probability*, and the line
thresholds it at 0.5. Measured 2026-11-07: 16 of 16 src dispatches printed `worktree n` while
**every one** correctly ran in a worktree (Rule 5), so each became an exact-text provenance miss
and needed an exceptions-file entry — the audit turned into paperwork.

State the fact instead:

```bash
$ node .pi/skills/worktree/jev-check.mjs --classifier '<raw answers>' --worktree y --label impl-447
jev-check: worktree y STATED by the conductor (the classifier said n, p=0.26) — recorded as stated, not as a model answer
jev: medium (0.64) · C1 · worktree y
jev-check: provenance row appended to .pi/jev-lines.log (label "impl-447")
```

The printed line is unchanged in shape and still matches exactly at the merge gate; the provenance
row gains a fourth column, `stated:worktree`, so the artifact stays honest about which field the
model produced. `--worktree` is refused with `--line` (that mode takes the field you already
decided, so stating it twice would have no source of truth). The flag does not raise or lower
`level`/`risk` — those remain classifier answers, and hand-typing them is still the Goodhart
failure the log exists to prevent.

$ node .pi/skills/worktree/jev-check.mjs --line '{"level":"medium","conf":0.84,"risk":"C2","worktree":true}' --label impl-1
jev-check: --line is format-only: …            # exit 2 — use --classifier, or --legacy-line to acknowledge
```

**Pipeline:** codemode `return r` → `--classifier` → paste. The `--classifier` step is the only
one that writes provenance: `--line --label` is refused unless `--legacy-line` acknowledges a
conductor-assigned line, because a format-only check cannot tell a classified confidence from an
invented one (2026-10-31: `medium (0.70)` typed, classifier said `high (0.32)`; 2026-11-04: the
same shortcut, and the risk class was wrong — C2 dispatched, C1 classified).

### The model and the second arm (issue #468)

The classifier answers **task difficulty**; the decision is **task × model**. The blind arm keeps
the template exactly (`state` = the task text and nothing else); the model-aware arm is the *same*
template plus one model stanza — the only difference — so any movement between the arms is
attributable. Both run in the same `codemode` call, and one `--classifier` invocation records both:

```bash
$ node .pi/skills/worktree/jev-check.mjs --classifier '<blind raw answers>' \
    --model openrouter/meta/muse-spark-1.3-contributor \
    --classifier-model-aware '<aware raw answers>' --label impl-468
jev-check: aware arm minimal (0.61) — recorded as level-model, never printed: the blind line above is the dispatch line
jev: medium (0.72) · C2 · worktree y
jev-check: provenance row appended to .pi/jev-lines.log (label "impl-468", model openrouter/meta/muse-spark-1.3-contributor, aware arm recorded)
```

- **One line is printed.** The aware arm is a stderr diagnostic plus a record column; a second
  `jev:` line on stdout would let a reader paste the wrong arm.
- **Rollout ordering.** The new columns may be written only **after** this tool is merged: the cockpit's
  merge guard runs its own copy of `jev-check`, and that parser is fail-closed, so a `model:` or
  `level-model:` row written early makes every merge fail structurally. A row without them is
  legacy-shaped and safe on either side of the merge.
- **Blind isolation.** The printed line is byte-identical with and without `--model`/
  `--classifier-model-aware`, so adding the measurement cannot change the dispatch.
- **It never blocks.** `--classifier-model-aware` requires `--model` (exit 2 — an arm without a
  model names nothing), but an *unusable* arm-2 answer falls back to blind-only: the record says so
  and the dispatch proceeds. It is a measurement.
- **The columns are keyed and optional** after the line: `stated:worktree`, `model:<id>`,
  `level-model:<level> (<conf>)` — any subset, any order, each at most once. The matched line never
  changes, so `--require-provenance` keeps comparing exactly, and 3-, 4-, 5- and 6-column rows
  coexist in one log.

## Settle and calibrate — does the level survive contact with an outcome?

The provenance row records what the classifier **answered**; it can never record what **happened**,
so the apparatus was structurally unable to answer "was this level right for this model". The
sidecar closes that gap without touching the matched row:

```bash
$ node .pi/skills/worktree/jev-check.mjs --settle impl-468 --kind impl --outcome done \
    --verdict approve-with-nits --nits 2 --model-ran deepseek/deepseek-flash
$ node .pi/skills/worktree/jev-check.mjs --calibrate
```

- **`.pi/jev-outcomes.log`** — header `# jev-outcomes — cutoff <full ISO instant>`, then
  `ts\tlabel\tkind\toutcome\tverdict|null\tnits|null\tmodel-ran|null`. Keyed by the dispatch label:
  one line per settle, appended, never rewritten. `--kind` is required because a review is a
  different question — a `changes-requested` review is a **good** review, not a level failure.
- **`unknown` is a gap, not a value.** A dead agent settles `unknown`; nothing is inferred.
- **`--model-ran` is a manual correction** for a transport retry or a fallback, on the settle row so
  the provenance row's exact text is untouched. It is not runtime detection, and it is not claimed
  to be.
- **`--calibrate`** prints `eligible / settled / with-model`, then per model: N, observed-sufficient
  count, both arms' agreement against the **dispatched** level, and the delta direction
  (above/below/equal). **Below 20 eligible implementation rows it prints counts only** — the
  comparison floor is the falsifier in ADR 0025, and the bias is stated: both arms are scored
  against the conductor's own choice, on runs that worked. It never names a winner.

**A bare level is a finding.** `jev: medium · C2 · worktree y` records no query — it is the exact
form the 2026-10-13 and 2026-10-23 skips produced. Every spec and dispatch carries the full line
`jev: <level> (<conf>) · Cx · worktree <y|n>`; a review that sees a bare level (or no line at all)
raises it. The ledger check below makes that mechanical.

## The ledger check — the record is machine-audited

The dispatch's `jev:` line and the log row are the **artifact** of the query, so the ritual is
checkable without automating the call:

```bash
node .pi/skills/worktree/jev-check.mjs --ledger .development/investigations/jev-calibration-log.md
```

- Every row dated **on/after 2026-10-12** (the strict-Jev cutoff) must carry a confidence
  `(0.xx)` in the Jev cell **or** an explicit gap marker (`unavailable`, `not classified`, `n/a`,
  `ritual gap`).
- Offenders report `date + dispatch + the cell`, and the check exits 1.
- Zero parsed rows is a hard error (exit 2) — an unparsed or restructured table fails loudly
  rather than passing silently.
- `--ledger` takes an optional path (fixtures, a scratch ledger); `--selftest` proves the pass and
  fail paths with fixtures.

CI runs both (`--selftest` and `--ledger` on the tracked log) beside the test-budget guard, so a
bare level cannot merge. **Historical rows are never edited** to satisfy the check: a genuine
pre-query row stays bare, and the row is a record of the gap.

## The dispatch audit — `--log` (the ledger's blind spot)

The ledger is written **after** a dispatch closes, so it cannot see a skip: a bare level quoted in
the dispatch becomes a tidy `(0.84)` row written afterwards and `--ledger` passes. The 2026-10-27
recurrence (class occurrences #3–#5) proved it — the check had merged (#366) and the skips still
went out. The artifact that *does* exist at dispatch time is the subagent log's spawn event: it
carries the task payload verbatim.

```bash
node .pi/skills/worktree/jev-check.mjs --log                 # default: .pi/subagent-logs/brl-subagent.log
node .pi/skills/worktree/jev-check.mjs --log --since 2026-10-25   # re-audit legacy dispatches
```

- Every `Background agent spawned` event dated **on/after `STRICT_DISPATCH_CUTOFF` (2026-10-28)**
  must carry a valid line in `data.task`: `jev: <level> (<0.xx>) · C<1|2|3> · worktree <y|n>`. The
  line is parsed and then validated by the same code `--line` uses (so a bad confidence or an
  unknown level is a finding, not a pass).
- Offenders print `timestamp`, the task head, and the reason (`missing Rule 22 line`, `bare level
  without its classifier confidence`, …) and the check exits 1.
- **Zero parsed dispatch events is a hard error (exit 2)** — an empty, rotated or wrong-path log
  never reads as "all clean".
- Pre-cutoff events are **grandfathered**: the log is a historical record and is never edited
  (`--since` exists to audit a legacy window deliberately).
- A quoted *template* (`jev: <level> (<conf>) · Cx · worktree y|n`) does not pass — placeholders
  never validate, which is why the line must be pasted from `--line`.

**This mode is conductor/merge-time, not CI.** The log lives under the local, gitignored `.pi/`,
so CI cannot see it; `merge-guard.sh` runs `--log` as its check (e) at the merge point, and the
conductor's own dispatch is in that log — the first dispatch after the cutoff is judged by the
same gate as everyone else's.

## Input template — hazard-shaped, blind

Jev's output is only as good as the task text. The fix is a *uniform* description carrying the
facts the level actually depends on — not free-form prose that happens to include whatever the
conductor was thinking about. Use the same fields every call so outputs are comparable across
dispatches: the value is the ranking, not an absolute truth (the level is a risk policy, not a
fact).

```
WHAT:     <the change in 1–2 sentences>
WHERE:    <symbols/modules/call sites, symbolic — no line numbers>
SURFACE:  <persistence / concurrency / teardown / security / API shape / display — or "none">
VERIFY:   <tests to extend, mutations, real-process probes, cross-module gates>
BLAST:    <files, types, ratchets, consumers; behavior change y/n>
OUT:      <explicitly out of scope>
ARTIFACT: <worktree y/n · PR · evidence required>
```

Rules of the input:
- **Facts in, conclusions out.** "Persists a field", "restores a guard across a process
  boundary", "changes a retry contract" are task facts — include them. "This is C1",
  "recommend high" are OUR answers — never include them.
- **Operational burden is a fact too** — the worktree, the full suite, the mutation battery,
  the PR. Jev's known blind spot is exactly this; the template hands it the burden as facts, and the
  model-aware arm (`--model`) hands it the one input the blind arm never had.
- **Reviews:** include the risk class under review and the attack surfaces (facts), never the
  expected verdict.

## Outcome logging — continuous calibration

One line per dispatch, appended to `.development/investigations/jev-calibration-log.md` when
the dispatch **closes** (merge / rejection), not at dispatch time:

The **machine-readable** half is the sidecar: `jev-check --settle <label> …` appends to
`.pi/jev-outcomes.log`, and `--calibrate` reads it back against the provenance log (see "Settle and
calibrate" above). The table below stays the human narrative, and `--ledger` audits it.

```
| Date | Dispatch | Class | Jev | Chosen | Delta / reason | Outcome | Calibrated? |
```

- **Outcome** = fix rounds · review verdict · defects · cost.
- **Calibrated?** — `under` (defects a higher level would plausibly have prevented) · `over`
  (trivially clean on a low-hazard change) · `consistent` (clean/minor on a surface where
  under-leveling would have shown) · `design-gap` (the miss was the spec's design; the level
  was not the causal variable) · `pending`.
- **Revisit policy with data:** blanket overrides (e.g. a "C1 ⇒ high" convention) compensate
  for input gaps. At ~20 entries, re-run the backtest against this log and delete, keep, or
  justify each override — never argue them from intuition.

## The rules (Rule 22)

- **Advisory only.** The conductor decides; the maintainer's spec approval is the gate.
- **The level is an OBSERVATION (2026-11-08, #468).** Record the line in the spec and the dispatch —
  format it with `.pi/skills/worktree/jev-check.mjs --classifier '<raw answers>'` (a bare level is a
  finding) — and then run whatever level you judge right. No deviation reason, no floor, and no
  "below Jev" note is required or checked: the level rides along in the line and the row so that it
  can be **measured against outcomes**, not so that it can be obeyed. The risk class still gates
  review depth.
- **The two clauses this supersedes** (recorded, because deleting a rule silently is the failure
  mode this file exists to prevent): "Strict Jev — use Jev's level, ANY deviation (either direction)
  carries a one-line reason", "the low-confidence carve-out on a C1 with conf < 0.5", and "Clamps:
  artifact dispatches floor at `low`, reviews floor at `medium`". All three were level *controls*
  with no measured cost behind them, and the 2026-11-07 sub-plan-critique pin already contradicted
  the first. The low-confidence carve-out is superseded by that pin (critiques run at `medium`
  regardless); the floors are withdrawn.
- **The `worktree` cell is stated, not answered** (#456): `--worktree y|n` with `--classifier`
  records `stated:worktree`, because Rule 5 and the worktree guard govern, not a probability.
- **The model and the outcome are recorded** (#468): `--model <provider>/<id>` adds a `model:`
  column to the provenance row; `--classifier-model-aware '<raw answers>'` adds the second arm's
  `level-model:<level> (<conf>)`; `--settle <label> --kind impl|review|probe --outcome
  done|failed|stopped|unknown [--verdict …] [--nits N] [--model-ran <id>]` appends what happened to
  `.pi/jev-outcomes.log`, keyed by label. `--calibrate` joins the two and prints both arms'
  agreement — counts only below 20 eligible implementation rows, and never a winner.
- **Input + log:** build `state.task` from the input template; when the dispatch closes,
  record the outcome line in `.development/investigations/jev-calibration-log.md` and settle it.
- **Unavailable is recorded, not silent:** if `codemode` or the model is missing, write
  `jev: unavailable` and proceed — never block a dispatch on the classifier. The same holds for the
  model-aware arm: an unusable arm 2 falls back to blind-only, because it is a measurement.

## Why advisory (2026-10-10 backtest, 98 dispatches)

- **It flags over-leveling:** 16 of 40 `high` and 19 of 40 `medium` runs were downgraded;
  it independently called the docs/refactor units (`impl-codegraph-phase1`,
  `retire-graphify`, `impl-test-hygiene`, `impl-fix315`) one to two levels lower.
- **It raises reviews:** `review-test-hygiene-r2` (the review that caught the #308
  regression) high→**xhigh**, `review-fix315` → high, `impl-299-probe` medium→**xhigh**.
- **Its biases:** it discounts mechanical plumbing work but also ignores *operational*
  burden (worktree, suite, PR, evidence). The input template above hands it that burden as facts;
  the calibration log and `--calibrate` measure whether it actually helps. The backtest measured
  **agreement** between two unvalidated opinions, never calibration against an outcome — which is
  exactly what the `model:`/`level-model:`/outcome columns now make possible (ADR 0025).
- Evidence: `.development/investigations/jev-thinking-backtest-2026-10-10.md`.

## Recorded exceptions (`--log`)

A dispatch that went out without the line is a **historical** fact — the log is never edited, so
`--log` would otherwise block every merge forever. `node .pi/skills/worktree/jev-check.mjs --log`
reads `.pi/jev-dispatch-exceptions.txt` (local, gitignored; `--exceptions <path>` overrides):
one `<agent-id-prefix>  <reason>` per line. A matching offender is reported as
`acknowledged: <reason>` — never as clean, never as failing — and the ledger row for that
dispatch is the record of record. An exception without a reason is rejected by review, not by
the script.

**Provenance misses need evidence, not prose.** A line that is *format-valid* but has no provenance
row was typed, invented or copied — the 2026-10-31 `medium (0.70)` case. Such a dispatch can also be
acknowledged, but only by an exception whose reason carries `retro:<label>`, where `<label>` is a real
row in `.pi/jev-lines.log`. The report then prints it as an acknowledged **`[provenance miss]`**, so
the offence stays visible; an exception that names no label, or names one that does not exist, leaves
the dispatch an offender and says why.

**A line cannot be its own evidence.** `--line --legacy-line --label` prints the line but writes **no**
provenance row; only `--classifier … --label` does. Before 2026-11-07 it wrote one, so a conductor could
mint the row that validates their own hand-typed line and then cite it in a `retro:` exception — the
spoof chain a #452 review demonstrated live. The retrospective row must therefore come from the
classifier, which is the whole point of naming it.

Why a label and not a sentence: an invented confidence plus a persuasive paragraph would otherwise
clear the gate. The retrospective row must be printed with `--classifier … --label <name>` *after*
the fact, and naming it forces the evidence into the log (2026-11-07: a hand-typed `high (0.62)` whose
classifier answer was `xhigh (0.63)`).

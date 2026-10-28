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
return { level: r.answers.level.choice, conf: r.answers.level.confidence,
         risk: r.answers.risk.choice, worktree: r.answers.worktree.probability > 0.5 };
```

## The line — format it with the helper, never by hand

The classifier JSON above is the input to `.pi/skills/worktree/jev-check.mjs --line`, which
prints the **exact** dispatch line and refuses a level without a confidence:

```bash
$ node .pi/skills/worktree/jev-check.mjs --line \
    '{"level":"medium","conf":0.84,"risk":"C2","worktree":true}'
jev: medium (0.84) · C2 · worktree y          # paste this into the spec and the dispatch

$ node .pi/skills/worktree/jev-check.mjs --line '{"level":"medium","risk":"C2","worktree":true}'
jev-check: missing "conf" — a level without its classifier confidence is the skipped form (#366); …
                                              # exit 1
```

**Pipeline:** codemode block → `--line` → paste. Three steps, one command after the query; no
hand-formatting, no rounding drift, no missing confidence.

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
  the PR. Jev's known blind spot is exactly this; the clamps patch it today, the template
  lets Jev reason about it.
- **Reviews:** include the risk class under review and the attack surfaces (facts), never the
  expected verdict.

## Outcome logging — continuous calibration

One line per dispatch, appended to `.development/investigations/jev-calibration-log.md` when
the dispatch **closes** (merge / rejection), not at dispatch time:

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
- **Record the line** in the spec and the dispatch — format it with
  `.pi/skills/worktree/jev-check.mjs --line '<classifier-json>'` (a bare level is a finding).
  **Strict Jev (ratified 2026-10-12):** use Jev's
  level. **ANY deviation (either direction) carries a one-line reason**; the former C1⇒high convention
  is retired.
- **Low-confidence carve-out (the one standing exception):** on a C1, when Jev's confidence is
  `< 0.5`, a +1 raise is justified — the reason must cite the low confidence. The calibration log tests
  whether the carve-out earns its keep (delete it if raised runs show no outcome difference).
- **Clamps:** artifact-producing dispatches (worktree / PR / verification) floor at
  `low`; reviews floor at `medium`.
- **Input + log:** build `state.task` from the input template; when the dispatch closes,
  record the outcome line in `.development/investigations/jev-calibration-log.md`.
- **The `worktree` cell can misread `src/__tests__`** (observed: it said `n` for a test-only fix).
  Rule 5 and the worktree-guard govern — always treat a `src/**` edit as worktree-required and
  record the override.
- **Unavailable is recorded, not silent:** if `codemode` or the model is missing, write
  `jev: unavailable` and proceed — never block a dispatch on the classifier.

## Why advisory (2026-10-10 backtest, 98 dispatches)

- **It flags over-leveling:** 16 of 40 `high` and 19 of 40 `medium` runs were downgraded;
  it independently called the docs/refactor units (`impl-codegraph-phase1`,
  `retire-graphify`, `impl-test-hygiene`, `impl-fix315`) one to two levels lower.
- **It raises reviews:** `review-test-hygiene-r2` (the review that caught the #308
  regression) high→**xhigh**, `review-fix315` → high, `impl-299-probe` medium→**xhigh**.
- **Its biases:** it discounts mechanical plumbing work but also ignores *operational*
  burden (worktree, suite, PR, evidence) — hence the clamps and advisory-only status. The
  input template above hands it that burden as facts; the calibration log measures whether
  it actually helps.
- Evidence: `.development/investigations/jev-thinking-backtest-2026-10-10.md`.

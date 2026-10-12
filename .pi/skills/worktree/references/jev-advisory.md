# Jev advisory — pre-dispatch thinking-level calibration

**Rule 22 companion.** Before writing a spec or dispatch, classify the task with the
**Jev** classifier (TypeSafe System One) and record the result in the spec/dispatch:

```
jev: medium (0.72) · risk C2 · worktree y
```

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
- **Record the line** in the spec and the dispatch. Deviations **≥2 levels**, and **any
  level below Jev on a review**, carry a one-line reason.
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

# Jev advisory — pre-dispatch thinking-level calibration

**Rule 22 companion.** Before writing a spec or dispatch, classify the task with the
**Jev** classifier (TypeSafe System One) and record the result in the spec/dispatch:

```
jev: medium (0.72) · risk C2 · worktree y
```

## How

Run this via the `codemode` tool (requires `+codemode` in the session's default tools,
e.g. `.pi/settings.json`). **Blind:** put the task text in `state` and nothing else —
including the chosen level would bias the answer. Model id: provider `openrouter`,
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

## The rules (Rule 22)

- **Advisory only.** The conductor decides; the maintainer's spec approval is the gate.
- **Record the line** in the spec and the dispatch. Deviations **≥2 levels**, and **any
  level below Jev on a review**, carry a one-line reason.
- **Clamps:** artifact-producing dispatches (worktree / PR / verification) floor at
  `low`; reviews floor at `medium`.
- **Unavailable is recorded, not silent:** if `codemode` or the model is missing, write
  `jev: unavailable` and proceed — never block a dispatch on the classifier.

## Why advisory (2026-10-10 backtest, 98 dispatches)

- **It flags over-leveling:** 16 of 40 `high` and 19 of 40 `medium` runs were downgraded;
  it independently called the docs/refactor units (`impl-codegraph-phase1`,
  `retire-graphify`, `impl-test-hygiene`, `impl-fix315`) one to two levels lower.
- **It raises reviews:** `review-test-hygiene-r2` (the review that caught the #308
  regression) high→**xhigh**, `review-fix315` → high, `impl-299-probe` medium→**xhigh**.
- **Its biases:** it discounts mechanical plumbing work but also ignores *operational*
  burden (worktree, suite, PR, evidence) — hence the clamps and advisory-only status.
- Evidence: `.development/investigations/jev-thinking-backtest-2026-10-10.md`.

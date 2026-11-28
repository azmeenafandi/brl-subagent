---
name: grill
description: "Grill the human relentlessly about a plan, decision, or idea until the design tree's frontier is empty, then persist the result as a signed brief. Use when stress-testing thinking before a code-writing dispatch, or when the human says 'grill me' / 'grill this'."
metadata:
  credits:
    adapted-from: "mattpocock/skills — productivity/grilling (MIT © 2026 Matt Pocock)"
---

# Grilling

Interview the human relentlessly until you reach a shared understanding. Map this as a **design
tree**: every decision branches into the decisions that hang off it.

Adapted from Matt Pocock's `productivity/grilling` (MIT © 2026 Matt Pocock). The algorithm is his.
Persistence, the refusal and fact-provenance are this repository's additions (§606 Unit 1) — said
plainly so the adaptation never pretends to inherit them.

## The algorithm

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already
settled: the questions you can ask _now_ without guessing at answers you have not heard yet. Ask the
whole frontier in one round: number each question and give your recommended answer. Then wait for the
human's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Word each question so "yes" accepts your recommended answer.

Each round the human's answers reshapes the tree: settled decisions push the frontier outward and
unblock the questions that depended on them. **Recompute** the frontier and ask the next round — never
walk a pre-baked question list in order. A question whose answer depends on another question still open
in this round belongs to a _later_ round, not this one.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left
silently assumed. **Do not act on it until the human confirms you have reached a shared
understanding.** The confirmed proposition is the state of understanding, not the plan document.

## Facts are yours; decisions are the human's

When a frontier question needs a fact from the environment (filesystem, tools, the repository), find
it yourself — dispatch a subagent with a fresh context window, or use `codegraph_explore`. Never ask
the human anything you could look up. Never read the repository's code directly into the interview:
the point of the fresh context window is that the decision-maker's view stays clean.

Do not block on a lookup: a running exploration is an unsettled prerequisite, so only the questions
downstream of it wait for it. Ask the rest of the frontier now.

The **decisions** are the human's: put each to them and wait. No self-answering, no silent assumption.

## Persist the result — `briefs/<slug>.md`

An interview that lives only in context is lost at compaction, so the confirmed understanding is
written down before anything is built. The brief is `briefs/<slug>.md` in the repository (tracked, so
it materialises in every worktree), slug matching `^[a-z0-9][a-z0-9-]{0,63}$`.

The file has four required parts; the gate that reads it refuses a brief missing any of them:

1. **`## Want`** — the human's own words, at least one unfenced line of them. The `confirmed:` marker
   is not content, and a fenced block is not body text.
2. **`## Facts`** — each fact **with its source**: the subagent's report, the `codegraph_explore`
   answer, or a file path and line. Provenance is the addition upstream leaves out: a fact nobody can
   trace is a fact the next session re-derives or, worse, trusts.
3. **`## Settled decisions`** — a table with a non-blank decision cell and a non-blank answer cell per
   row. When nothing needed settling, write the zero-decision form `none — <why>`; an empty reason is
   refused, because "we decided nothing, and here is why" is information.
4. **`confirmed: <YYYY-MM-DD> by <name>`** — the last non-blank line, no `<…>` placeholder left in it.
   This is a **record, not authentication**. Nothing proves the human typed it; the gate records that
   a brief claims to be confirmed, and a reviewer audits the claim.

The worktree skill documents the format an author needs:
[`../worktree/SKILL.md`](../worktree/SKILL.md), "Writing a brief".

## The refusal — the brief is what a code-writing dispatch may not skip

The brief is not advice. A project that opts into `{"brl-subagent": {"processChecks": true}}` makes
`delegate_task` refuse a `dispatch: impl` task that names no brief, and refuse a brief that does not
exist in the dispatch project's tree or does not satisfy the contract above. The two outcomes are
refused (no spawn, an error naming the missing piece) and **escaped** (`brief: none — <reason>`,
spawned with the reason surfaced as a warning).

So the interview ends in one of two honest states: a signed brief, or a recorded escape that says why
there is none. There is no silent third state — which is the whole reason the header is mandatory.

The one prohibition the interview carries with it: **the conductor does not read the repository's code
before the plan is settled.** Facts arrive through a subagent or `codegraph_explore`, never by the
interviewer opening `src/` itself — the counter-example this rule exists for is
`git show HEAD:src/router.ts | head -5`, repository code read with no prohibited tool name in it.
Authorship is not an exemption: a file you wrote is still a file the interview was supposed not to
read. Two exclusions and only two: subagent activity (that is how facts were meant to arrive) and
non-repository sources (network, the private scratch root).

## Where this sits

- **Before** a code-writing dispatch: grill → brief → `dispatch: impl` + `brief: <slug>` → the gate.
- **Not** a factory run. A run never waits for a human: it ends, and the human's later change to the
  ticket tracker or git host triggers the next run. Grilling is the opposite — it waits, deliberately,
  because converting a want into a settled brief is exactly where a human's judgement belongs. The two
  live on different sides of the front door, and only the front door waits.
- Out of scope here: the wiki index and the factory vocabulary (#606 Units 2 and 3), and any cap on
  rounds or questions. "Relentlessly" is the only bound.

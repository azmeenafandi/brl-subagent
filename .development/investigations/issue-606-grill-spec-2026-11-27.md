# #606 — the factory's front door: a grill skill that turns a want into a confirmed brief, and a pre-flight that refuses a plan dispatch without one — spec **r1**

**Issue:** #606 (process, owner priority) · **C2** · worktree **y**.
**jev:** medium (0.89) · C2 · worktree y
**Spec r1:** 2026-11-27, against `339ea53` (`dev`). **Status: decision-ready for review.**

**Scope: Unit 1 only** (the grill). Unit 2 (wiki index) and Unit 3 (vocabulary + lint) are explicitly out of
scope here and are named in `## Out of scope` so they are not lost.

---

## Recon (Rule 13 — codegraph @ `339ea53`)

```
# validatePreTask (src/validate.ts) — the pre-dispatch validator; the refusal lands here as a sibling of the Jev check
# parseDispatchLine (src/dispatch-line.ts) — the analog to copy: a task-line parser gated by processChecks
# delegateTaskParamsSchema (src/schema.ts) — the param surface (a new task-line approach avoids widening this 120-symbol blast radius)
```

- `validatePreTask` — 13 callers, 30 symbols across 20 files. Prod callers: `runPreTaskValidation`
  (src/prelude.ts:291) and `prepareForeground` (src/delegate-handler.ts:949). Tested via
  `validate.test.ts`, `integration.test.ts`, `project-flags.test.ts`, `dispatch-line.test.ts`,
  `empty-tools-442.test.ts`, `presets-files.test.ts`.
- `parseDispatchLine` — 3 callers, only `validatePreTask` + tests. The exact pattern to mirror: a pure parser
  (`DispatchLineVerdict`), a `DISPATCH_LINE_FORM` string quoted verbatim in every rejection, and a gap marker.
- `delegateTaskParamsSchema` (src/schema.ts) — 120 symbols / 119 files. **A new `brief` param would widen this
  blast radius; a task-line (`brief: <slug> (confirmed)`) keeps the change to `validate.ts` + a new parser +
  tests, the same surgical shape the Jev line took.**

**Recon verification.** V1 the Jev check is opt-in per project via `isProcessChecksEnabled`
(`src/project-flags.ts`), fail-open; the brief check reuses the same flag (one umbrella, no new manifest field —
`PROCESS_CHECK_KEYS` is a ratchet and is left alone). V2 `validatePreTask` already parses the task text for the
Jev line at lines 409–430; the brief check is a second block in the same function. V3 the resolver the brief
check needs (read `briefs/<slug>.md`, test for the confirmation marker) is new and has no analog in the existing
validator — the grep delta below confirms no existing `brief` handling.

**Grep delta.** `grep -rniE '\bbrief\b|briefs/' src` → no pre-existing brief-handling (the only hits are the
word "brief" in comments about task text). `git ls-files 'briefs/*'` → none (the directory does not exist yet).
`rg -n 'brief' .pi/skills .development/investigations/issue-606-*` → only this spec and the upstream capture.

---

## Decision

### 1. The grill skill — `.pi/skills/grill/SKILL.md` (adapted, not imported)

Adapt Matt Pocock's `productivity/grilling` (MIT © 2026 Matt Pocock), in our frontmatter format, with
`metadata.credits` as `pr` does:

```yaml
---
name: grill
description: "Grill the user into a shared plan: frontier rounds with recommended answers, facts via subagents, a confirmed brief as the output. Use before any implementation dispatch on a new want."
metadata:
  credits:
    adapted-from: "mattpocock/skills — productivity/grilling (MIT © 2026 Matt Pocock)"
---
```

The skill states the algorithm **in our house wording**, with the upstream's load-bearing pieces preserved and
named (full verbatim upstream capture: `.development/investigations/issue-606-grilling-upstream-2026-11-27.md`):

- **Design tree.** Map the want as a tree of decisions; a decision's children are the decisions that only make
  sense once it is settled. Built during the interview, not given.
- **Frontier.** Every decision whose prerequisites are already settled — the questions you can ask *now* without
  guessing at answers you have not heard yet. Recomputed each round; never a pre-baked list walked in order.
- **One round = the whole frontier**, numbered, each with a **recommended answer** worded so "yes" accepts it.
  Format per question: `❓ **Qn** - **<title>**: <body>` / blank / `➡️ <recommendation>`; questions separated by
  `---`. A question whose answer depends on another question still open this round belongs to a *later* round.
- **Wait for the human's answers before the next round.** Answers reshape the tree; settled decisions push the
  frontier outward.
- **Terminate when the frontier is empty** — every branch visited, *nothing left silently assumed*. **Do not act
  until the human confirms a shared understanding** (upstream's exact gate, the final sentence of the file).
- **Facts vs decisions** (the rule with teeth — §4 below): facts are the conductor's job via subagents, decisions
  are the human's.

The skill is the **conductor's** playbook, not a user-invocable `/grill` command (upstream ships a separate
`grill-me` front door; we do not need it — the conductor invokes the grill at the start of a want).

### 2. The durable brief — `briefs/<slug>.md`, ending in a confirmation line

The grill's output is a **tracked file** `briefs/<slug>.md` (a new top-level directory; committed to `dev` before
any plan dispatch, so it materializes in worktrees). It holds:

```
# Brief: <slug>

## Want
<the human's want, in their words — verbatim, not paraphrased>

## Settled decisions
| # | Decision | Human's answer (verbatim) |
|---|---|---|

## Facts
| Fact | Source (subagent run id · or codegraph_explore query) |
|---|---|---|

## Last frontier
<the final round's frontier, empty at completion — or the remaining questions if the human ended early>

confirmed: <date> by <human>
```

The **confirmation line** is the mechanical marker: a line matching `^confirmed:` (case-insensitive), on its own
line, the last non-blank line of the file. It is the "signed brief". A brief without it is **not** signed, and the
pre-flight in §3 refuses a plan dispatch that names such a brief. (The marker is a line, not a `## Confirmed`
heading, so the check is a one-line regex like the Jev line's — no heading scanner needed.)

### 3. The refusal — a plan dispatch without a signed brief is refused before spawn

Mechanism mirrors the Jev dispatch line, one artefact over:

- **New `src/brief-line.ts`** — a pure parser, `parseBriefLine(task)` → `{ ok } | { ok: false, reason }`, with a
  `BRIEF_LINE_FORM = "brief: <slug> (confirmed)"` quoted verbatim in every rejection, and a gap marker
  (`brief: unavailable`) accepted as a *recorded* gap (analogous to `jev: unavailable`). Kept byte-comparable with
  a script counterpart **only if** a `brief-check.mjs` is warranted; r1 leaves the parser extension-side and adds
  no `.pi` script — the test asserts the parser against the same vector shapes `dispatch-line.test.ts` uses.
- **`src/validate.ts` `validatePreTask`** — a second block beside the Jev check, gated by the **same**
  `isProcessChecksEnabled(config.cwd)` umbrella (fail-open for every user's project):
  - Identify a **plan dispatch** by the resolved preset — `project-implementer` (the implementation shape; a
    review, probe or fetch is not a plan dispatch). This requires plumbing the resolved preset into
    `ValidateConfig` (added at the two prod call sites, `runPreTaskValidation` and `prepareForeground`).
  - If a plan dispatch: require a `brief:` line. Refuse (exit-1 error) when the line is **missing**, or when the
    named `briefs/<slug>.md` does **not exist**, or when it has **no `confirmed:` line**. The message names the
    exact form and the file it looked for, e.g. `missing signed brief: <reason>. A plan dispatch must reference a
    confirmed brief as: brief: <slug> (confirmed) — run the grill first, or pass noBrief: "<reason>".`
  - `noBrief: "<reason>"` downgrades the rejection to a warning that names the reason (ADR 0007's pattern, exactly
    as `noJev` does), read through the same runtime guard `readNoJevReason`-style (a boolean/number is refused, not
    accepted as a bypass).
- **`noJev`/`noBrief` symmetry** is deliberate: both are stated-reason escapes, both are surfaced as warnings, both
  are recorded in the dispatch's provenance. Neither is a silent bypass.

The brief file is read relative to the dispatch cwd (the worktree, for an implementation dispatch, where tracked
`briefs/` materializes per worktree skill rule 4). A missing brief is a refusal, never a fabricated pass.

### 4. The facts rule has teeth — and it is a skill rule, not a human-ask

From #606: *"Facts come from subagents or `codegraph_explore`, never from asking the human and never from the
conductor reading code."* The grill skill states it as a hard rule, and the **brief's `## Facts` table is the
provenance**: every fact the plan rests on carries its source (a subagent run id, or a `codegraph_explore` query).
A grill session that asks the human for something lookupable is a **defect** — enforced by falsifier (b), not by a
code check (a code check cannot see what the human was asked).

---

## Falsifiers (both mechanical, from the issue)

**(a)** A plan dispatch (`project-implementer` preset) with **no `brief:` line**, or whose named brief has **no
`confirmed:` line**, is **refused before spawn** — asserted as validator unit tests + one integration test that
the refusal path is reached before any subprocess spawns. A confirmed brief passes.

**(b)** The process acceptance, recorded for the *next real want* (it cannot fire inside #606's own build): on the
next genuine want, the conductor's transcript contains **no file reads or greps before the plan exists** — only
subagent results and the human's answers. This is the measured receipt the issue names; it is written into the
grill skill as the definition of done, and is verified at the next cycle, not by a unit test now.

---

## Out of scope (named so it is not lost)

- **Unit 2 — wiki.** `.development/HANDOFF.md` becoming an index over pages (already substantially done by #607);
  the chief-of-staff "context pointers + wiki" adaptation (upstream captured: `## Chief-of-staff` in the capture).
- **Unit 3 — vocabulary.** task / trigger / run / runner / ticket tracker, the forbidden-synonym lint, and the
  dispatch→run / worktree→runner mapping — **including the flagged hazard that our worktrees persist across a
  dispatch while upstream's runner remembers nothing** (that is Unit 3's deliberate call, not this spec's).
- **#599 / #602 / #603** (the spine) and `scripts/dispatch.mjs` itself. This spec's brief-refusal is shaped to
  fold into #599's `dispatch.mjs check` without rework (same `--kind impl` vocabulary, same gated pre-flight slot),
  but it does not depend on it and does not build it.
- **No `/grill` user command, no trigger-phrase front door** (upstream's `grill-me`), no round/question cap.

---

## Upstream (adapt, don't import)

Source: `mattpocock/skills` @ `6f7f7831a625f040a8e06a0e7954826b87ce775a` (main, 2026-11-25), MIT © 2026 Matt
Pocock. Primary file `skills/productivity/grilling/SKILL.md` (blob `d2f09a18…`), full verbatim capture in
`.development/investigations/issue-606-grilling-upstream-2026-11-27.md`. The three things Unit 1 **adds** that
upstream does not specify — persistence (`briefs/`), the refusal mechanism, and the fact-provenance rule — are
stated as additions, not inheritances, so a reviewer does not read them as deviations.

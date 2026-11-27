# Issue #606 — upstream capture: Matt Pocock's `grilling` (and the two adjacent skills)

Fetched 2026-11-27. Purpose: faithful capture of the upstream algorithms issue #606 adapts, so
Units 1–3 can be written against the real text rather than a paraphrase.

**Nothing in this document is invented.** Every block below is either a verbatim quote of the
upstream file (marked as such, fenced) or an explicitly-labelled notation about what the raw text
says/is missing. Where the upstream is silent, I say "not stated upstream" rather than filling the
gap.

---

## Grilling algorithm

Source of record: `skills/productivity/grilling/SKILL.md`, 2,077 bytes, blob
`d2f09a18e6a6c65c55f1271ba08dfeaf06f0bed3` at `main` = commit
`6f7f7831a625f040a8e06a0e7954826b87ce775a`.

### The whole file, verbatim

````markdown
---
name: grilling
description: Grill the user relentlessly about a plan, decision, or idea. Use when the user wants to stress-test their thinking, or uses any 'grill' trigger phrases.
---

Interview the user relentlessly until you reach a shared understanding. Map this as a **design tree**: every decision branches into the decisions that hang off it.

Work the tree in **rounds**. The **frontier** is every decision whose prerequisites are already settled: the questions you can ask _now_ without guessing at answers you haven't heard yet. Ask the whole frontier in one round: number each question and give your recommended answer. Then wait for the user's answers before the next round.

Format a round like so:

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Word each question so "yes" accepts your recommended answer.

Each round the user answers reshapes the tree: settled decisions push the frontier outward and unblock questions that depended on them. Recompute the frontier and ask the next round. A question whose answer depends on another question still open in this round belongs to a _later_ round, not this one.

Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the environment (filesystem, tools, etc.), dispatch a sub-agent with a fresh context window to find it; don't ask the user for anything you could look up yourself. Don't block on it: a running exploration is an unsettled prerequisite, so only the questions downstream of it wait for the sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to them and wait.

The session is done when the frontier is empty: every branch of the design tree visited, nothing left silently assumed. Do not act on it until the user confirms you have reached a shared understanding.
````

That is the complete file — 8 body paragraphs and one format block. There are **no reference files
linked from `SKILL.md`**. (See §"Adjacent files fetched" for what else lives in the skill directory.)
The skill is single-tenant by design: the algorithm is ~450 words and everything else is elaboration.

### The algorithm decomposed (each claim anchored to the verbatim text above)

**1. The design tree.** "Map this as a **design tree**: every decision branches into the decisions
that hang off it." The unit of the artifact is a *decision*, and the structure is a tree ordered by
dependency — a decision's children are the decisions that only make sense once it is settled. The
tree is not given; it is built during the interview.

**2. The frontier — how it is computed.** Verbatim definition:

> "The **frontier** is every decision whose prerequisites are already settled: the questions you can
> ask _now_ without guessing at answers you haven't heard yet."

So the frontier = { decisions d in the tree : every prerequisite of d is settled }. The test is
operational, not topological-pedantic: *can I ask this now without guessing at an answer I have not
heard?* The two failure directions are named implicitly — asking something whose parent is open means
guessing (the "haven't heard yet" clause); and the note "A question whose answer depends on another
question still open in this round belongs to a _later_ round, not this one" makes the same point for
intra-round dependency, which is the classic mistake (batching a dependency into the round that
decides its parent).

**3. How one round works.** Four requirements, all in one sentence plus the format block:
- **The whole frontier, in one round.** "Ask the whole frontier in one round" — not one question at
  a time. Round granularity is the frontier, not the question.
- **Numbered.** "number each question".
- **Each carries a recommended answer.** "give your recommended answer"; the format block puts it on
  its own `➡️` line under each `❓ **Qn**`.
- **Worded so "yes" accepts the recommendation.** "Word each question so "yes" accepts your
  recommended answer." This is the load-bearing ergonomic: the question presents a position the
  human can ratify or amend, so the cheap path through the round is assent, and dissent is the
  deliberate act.
- **Then wait.** "Then wait for the user's answers before the next round."

Exact format (verbatim, from the fenced block above):

```
❓ **Q1** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>

---

❓ **Q2** - **<question title>**: <question body, might be multiple paragraphs, including multiple choices>

➡️ <your recommended answer>
```

Structural details of the format worth preserving when we adapt it: `❓ **Qn**` then a bold title
after ` - `; a body that "might be multiple paragraphs, including multiple choices"; a blank line; the
recommendation introduced by `➡️` (U+27A1 + VS16) with no bold; rounds separated by `---` between
questions (not before the first one, per the sample).

**4. How the tree changes between rounds.** "Each round the user answers reshapes the tree: settled
decisions push the frontier outward and unblock questions that depended on them. Recompute the
frontier and ask the next round." Explicitly: **recompute** each round — the frontier is derived
fresh from settled state, never a pre-baked question list walked in order. Answers may also *reshape*
the tree (the word is "reshapes", not "advances"), i.e. an answer can add or delete branches.

**5. Facts vs decisions — the split, and the non-blocking rule.** Verbatim:

> "Finding _facts_ is your job, never the user's. When a frontier question needs a fact from the
> environment (filesystem, tools, etc.), dispatch a sub-agent with a fresh context window to find it;
> don't ask the user for anything you could look up yourself. Don't block on it: a running
> exploration is an unsettled prerequisite, so only the questions downstream of it wait for the
> sub-agent to report; ask the rest of the frontier now. The _decisions_ are the user's: put each to
> them and wait."

Parsed into rules:
- **Facts are the conductor's job, never the human's.** Mechanism named upstream: *dispatch a
  sub-agent with a fresh context window* (not "go read the files yourself" — the fresh context window
  is what keeps the interviewer's own context clean for the human and the tree).
- **A lookup is a prerequisite, not a blocker.** "a running exploration is an unsettled prerequisite,
  so only the questions downstream of it wait for the sub-agent to report; ask the rest of the
  frontier now." So a pending fact removes its dependents from *this* round's frontier and nothing
  else — it never stalls the round.
- **Decisions are the human's: put each to them and wait.** No self-answering, no silent assumption.

**6. Termination.** "The session is done when the frontier is empty: every branch of the design tree
visited, nothing left silently assumed." Two clauses, and the second is the real acceptance test —
emptiness is necessary, "nothing left silently assumed" is what makes emptiness trustworthy.

**7. The confirm-before-acting rule — exact wording, verbatim:**

> **"Do not act on it until the user confirms you have reached a shared understanding."**

This is the final sentence of the file and the only gate in the algorithm. Note its precision:
- "Do not act **on it**" — *it* is the plan/design, not the interview.
- "until the user **confirms**" — the actor is the user; the conductor cannot self-certify.
- "**you have reached a shared understanding**" — the confirmed proposition is the *state of
  understanding*, not the plan document. The human ratifies that the two of them now agree, which is
  a stronger and more checkable claim than "the plan is approved".

For #606's Unit 1 this maps to the "signed brief" requirement and the "a brief with no confirmed
line is refused before spawn" falsifier: the confirmation is the artifact, and its absence is
detectable.

### What upstream does NOT specify (gaps #606 must fill itself)

Stated so the adaptation does not pretend to inherit them:
- **No persistence.** There is no file, path, or schema for the interview's output. The whole
  algorithm is in-context; a compaction loses it. #606's `briefs/<slug>.md` (frontier, each settled
  decision, the human's words) is our addition.
- **No refusal mechanism.** Nothing says what to do when a plan dispatch arrives without a completed
  grill. Ours (refuse before spawn) is our addition.
- **No fact-provenance rule.** Upstream says dispatch a sub-agent; it does not say the fact must be
  recorded with its source in the brief.
- **No trigger-phrase list.** The description says "uses any 'grill' trigger phrases" without
  enumerating them — those live in the sibling `grill-me` skill (below).
- **No cap on rounds or questions per round.** "Relentlessly" is the only bound.
- **No handling of a human who refuses a recommendation and gives no alternative** — the algorithm
  just has an unsettled decision and asks again.

### Adjacent files fetched (so "did you check for references" is answered)

`gh api repos/mattpocock/skills/contents/skills/productivity/grilling` returns exactly two entries:
`SKILL.md` and an `agents/` directory. The directory's sole member is `agents/openai.yaml`
(113 bytes, blob `ddbdb96139c0c1dfe6bca698f39d0465674b8a39`), verbatim:

```yaml
interface:
  display_name: "Grilling"
  short_description: "Stress-test thinking a round of questions at a time"
```

That is harness metadata for the OpenAI skills interface, not an algorithmic reference. **The grilling
skill therefore has no reference files, no templates and no prompts beyond this.**

There is a sibling entry point `skills/productivity/grill-me/SKILL.md` (157 bytes, blob
`3947ff9c4ad980d14fc07fccbf659d47c114e81d`), which is where the "trigger phrases" live — verbatim:

```markdown
---
name: grill-me
description: A relentless interview to sharpen a plan or design.
disable-model-invocation: true
---

Call the Skill tool with "grilling".
```

Note the pattern this establishes, which is relevant to #606's "adapt, don't import": upstream ships a
*user-invocable* front door (`grill-me`, `disable-model-invocation: true`) that does nothing but call
the *model-invocable* algorithm (`grilling`). Two skills, one behaviour.

---

## Chief-of-staff

Source: `skills/in-progress/chief-of-staff/SKILL.md`, 4,470 bytes, blob
`d823bf86956c570f74545e93b77b25338b437671`. **Skim for Unit 2** (the wiki), captured verbatim below
because Unit 2 will quote from it.

```markdown
---
name: chief-of-staff
description: Delegate the work to fresh subagents and remember what it taught you in a dated wiki, so the next session picks up the thread.
disable-model-invocation: true
---

You are a chief of staff. Your job is two things: **delegate** the work to subagents, and **remember** what each one taught you in a wiki the next session can read.

## Delegate

Hand each task's work to a background subagent started with a fresh context window. Your own context stays free for the user and for the wiki. Subagents do the work; the conversation stays with you: ask the user questions, run interviews and check in with them from this session.

Brief the subagent with **context pointers**: wiki pages, research notes, commits, issues, files. Point at material rather than retyping it. Add the goal, what is already ruled out, and the scope.

When it reports back, relay the result to the user: lead with the outcome and anything they must decide, and add detail only when it changes what they would do.

When a task plainly recurs, offer the user a recurring job for it, harness-permitting.

### Procedures

Some procedures you delegate live in other skills, installed beside this one. To run one, read its `SKILL.md` at the path below, relative to this skill's directory, and follow it.

- **Retro** (`../retro/SKILL.md`): run a retro on about one in five of your subagents' sessions, including those an `implement-spec` run dispatches. Pick first the ones where something went wrong. In place of retro's last step, decide yourself which candidates are worth pursuing, then pursue them.
- **Large chunks of work**: write a spec with `../to-spec/SKILL.md`, break it into tickets with `../to-tickets/SKILL.md`, publish both to the issue tracker, then implement them with `../implement-spec/SKILL.md`.

## Remember

Keep your memory in a **wiki**: a folder of interlinked markdown pages that outlives this session. Knowledge that lives only in your context is lost at compaction; the wiki is how it reaches the next session. Look for a shared wiki first, one the user or other agents already keep, and write your pages into it, following its conventions where they differ from the ones below. Only if there is none, agree a location with the user before the first write.

- `index.md` lists every page with a link and a one-line summary, grouped by category.
- Each other page covers one thing: a decision, a recurring problem, a subsystem, a user preference. Link related pages to each other.
- Sources (issues, PRs, transcripts, subagent reports) are never copied in or edited. Pages cite them.

Three operations keep it alive:

- **Ingest.** When you learn something durable (a decision, a user correction, a subagent's finding), update every page it touches and the index, not only a new page.
- **Query.** Before a decision, and before briefing a subagent, read `index.md` and the pages it points to. If the answer you build is worth keeping, file it as a page.
- **Lint.** Every so often, delegate a pass that looks for contradictions, orphan pages, missing links and claims newer sources have overtaken.

### Write history, not the present

The wiki is a historical record. It never claims to describe how things are now, because it cannot keep up with the code.

- Date every claim: "On 2026-10-13, Matt decided..."
- When a claim concerns code, cite the commit it was true at, with its repo: "As of `mattpocock/skills@abc1234`, `retro` loads `writing-for-agents` in step 1."
- Write every claim about code with a date or commit beside it, never a bare "currently", "now" or "is".
- When something changes, add a new dated claim and mark the old one superseded. Leave the old one as written.

## After friction

When a task hit **friction** (a workaround, a retry, a blocked step), ask once you have relayed its result: what would have made that easier? If the answer is a change to the environment the agents work in, offer it to the user, and delegate it once they accept. Every change to your own setup and tools starts as an offer. The changes that pay off most:

- **Constrained interfaces**: narrow APIs, lint rules that force correctness, coding standards a reviewer can enforce.
- **Data sources**: logs from running processes, a test database, a browser for clicking around and taking screenshots.
- **Causes, not workarounds**: when a subagent had to work around a broken convention, offer to fix the convention before the next feature.
```

### The two things Unit 2 needs

**Context pointers** (verbatim): "Brief the subagent with **context pointers**: wiki pages, research
notes, commits, issues, files. Point at material rather than retyping it. Add the goal, what is
already ruled out, and the scope." Four parts: pointers (not retyped content), goal, prior
exclusions, scope.

**The wiki** — a folder of interlinked markdown pages that outlives the session, because "Knowledge
that lives only in your context is lost at compaction". Shape: one `index.md` listing every page
(link + one-line summary, grouped by category); one page per thing (a decision, a recurring problem, a
subsystem, a user preference), interlinked; **sources are cited, never copied or edited**. Three
operations: *Ingest* (update every page a new fact touches, plus the index — not just a new page),
*Query* (read the index before a decision and before every brief; file the answer if it is worth
keeping), *Lint* (delegate a pass for contradictions, orphans, missing links, overtaken claims).

**"Write history, not the present"** is the invariant that makes a wiki cheap to maintain and is the
part most worth stealing wholesale: date every claim ("On 2026-10-13, Matt decided..."), cite the
commit for any code claim ("As of `mattpocock/skills@abc1234`, ..."), never write a bare "currently"
/ "now" / "is", and on change add a new dated claim while marking the old superseded — leaving the old
text as written. Also note the pre-existing-wiki rule: look for a shared wiki the user or other agents
already keep and follow *its* conventions where they differ; only if there is none, agree a location
with the user before the first write.

For #606 Unit 2 (`.development/HANDOFF.md` becoming an index over pages), the direct mapping is:
`index.md` → `HANDOFF.md`, "one page per thing" → `.development/handoff/*.md`, and the existing
`Verified:` protocol is exactly upstream's date/commit-citation rule with a verification stamp on top.

---

## Software-factory

Source: `skills/in-progress/software-factory/SKILL.md`, 6,110 bytes, blob
`ba4adc45935e8c24d6bed9b869792e4436ad5979`. **Skim for Unit 3** (the vocabulary). The five canonical
terms and their _Avoid_ lists are quoted verbatim; the rest of the file is context.

### Context (two lines)

"A **software factory** is a system of agents that turns tickets, PRs and schedules into merged code,
deployed on remote infrastructure the user chooses. This skill is the language for designing one. Use
these terms, and only these, when discussing or whiteboarding a factory; when the user reaches for a
word under _Avoid_, name the canonical term."

### The vocabulary — verbatim

**Tasks and runs**

- **Task**: "A kind of work the factory performs, defined once and run many times: review, explore,
  implement, ratchet. A task may work on a ticket, a PR, or the codebase as a whole."
  _Avoid_: "job, workflow, action, as names for the task. A CI vendor's workflow file and its jobs are
  where a task is wired up, not the task."

- **Trigger**: "The event that starts a run: a change in the ticket tracker or git host, a clock in
  the orchestrator, or another run."
  _(no Avoid list)_

- **Run**: "One execution of a task on one runner, from its trigger to its finish, treated as a black
  box. A run triggers further runs either directly, through logic in the orchestrator, or by changing
  the ticket tracker or git host. A run never waits for a human: it ends, and the human's later change
  to the ticket tracker or git host triggers a new run."
  _Avoid_: "session"

- **Runner**: "The disposable machine a run executes on. Nothing on it survives the run, even when the
  machine itself is long-lived: a run's only memory of earlier runs is the ticket tracker, the git
  host and the orchestrator."
  _Avoid_: "server, host, box, compute, sandbox"

**Services**

- **Ticket tracker**: "Where tickets live, and the factory's human interface: humans schedule work by
  filing tickets, talk to agents in their comments, and their changes to tickets trigger runs."
  _Avoid_: "issue tracker, ticket manager, project board"

- **Ticket source**: "Anything outside the factory that creates tickets in the ticket tracker: a
  feedback button, a monitor, an error tracker, an inbox."
  _Avoid_: "data source, trigger source, intake"

- **Git host**: "Where branches, PRs and reviews live."
  _Avoid_: "code host, forge, repo"

- **Orchestrator**: "The component that receives triggers, starts runs on runners, and records which
  runs are queued, in flight or finished."
  _Avoid_: "dispatcher, scheduler, control plane"

- **Observability platform**: "Where runners send logs, traces and status, so a human can see what
  happened inside each run. Optional: the product filling the runner or orchestrator slot often shows
  enough on its own. A run never decides on it until something writes it into the ticket tracker or
  git host."
  _Avoid_: "observability, logs, monitoring, dashboard"

### The five terms #606 Unit 3 asks for

| Canonical | Definition (condensed from verbatim) | Forbidden synonyms |
| --- | --- | --- |
| **task** | A kind of work defined once, run many times (review, explore, implement, ratchet) | job, workflow, action |
| **trigger** | The event that starts a run: ticket-tracker/git-host change, orchestrator clock, or another run | — |
| **run** | One execution of a task on one runner, trigger→finish, a black box; never waits for a human | session |
| **runner** | The disposable machine a run executes on; nothing on it survives the run | server, host, box, compute, sandbox |
| **ticket tracker** | Where tickets live and the factory's human interface; ticket changes trigger runs | issue tracker, ticket manager, project board |

### Two invariants from the same file that bear directly on our mapping

1. **"A run never waits for a human: it ends, and the human's later change to the ticket tracker or
   git host triggers a new run."** This is the *opposite* of grilling's "put each to them and wait" —
   and the two are compatible only because they live on different sides of the front door. Grilling
   converts a want into a brief and *does* wait; a factory run converts a settled ticket into code and
   *must not*. #606's design should say this explicitly rather than let the two rules look
   contradictory. It also constrains the run/resume shape of a dispatch: a dispatch that blocks on a
   human is not a runner in this vocabulary.
2. **"...a run's only memory of earlier runs is the ticket tracker, the git host and the orchestrator."**
   Nothing on the runner survives, "even when the machine itself is long-lived". Under the #606 Unit 3
   mapping *worktree → runner*, this is a real hazard to check: our worktrees **do** persist across a
   dispatch (and the `worktree` skill is a lifecycle around that persistence). Either the worktree is
   not the runner, or our mapping grants the runner durable memory and must say so as a deliberate
   deviation. Flagged, not decided — that is Unit 3's call.
3. The three brakes ("Automated checks", "Automated review", "Human review") and the "Start slow"
   doctrine ("Every trigger is an accelerator. Accelerators without brakes make a slop cannon") are
   the file's other load-bearing idea, and the "Question every task" five-question checklist
   (trigger / does what / triggers what next / where does a human re-enter / what stops two runs doing
   the same work) is a ready-made grill frontier for a factory design.

---

## Source

| Item | Value |
| --- | --- |
| Repo | `mattpocock/skills` — https://github.com/mattpocock/skills |
| Ref fetched | `main` |
| Commit at fetch | `6f7f7831a625f040a8e06a0e7954826b87ce775a` (2026-11-25T12:08:23Z, "Merge pull request #1485 from mattpocock/glossary-bold-terms") |
| Fetched on | 2026-11-27 |

Files, with blob SHAs (all resolved at the commit above):

- PRIMARY — `skills/productivity/grilling/SKILL.md`, 2,077 B, blob `d2f09a18e6a6c65c55f1271ba08dfeaf06f0bed3`
  - `https://raw.githubusercontent.com/mattpocock/skills/main/skills/productivity/grilling/SKILL.md`
  - `https://github.com/mattpocock/skills/blob/main/skills/productivity/grilling/SKILL.md`
- `skills/productivity/grilling/agents/openai.yaml`, 113 B, blob `ddbdb96139c0c1dfe6bca698f39d0465674b8a39`
  (the directory's only non-`SKILL.md` file; harness metadata, not algorithmic)
- `skills/productivity/grill-me/SKILL.md`, 157 B, blob `3947ff9c4ad980d14fc07fccbf659d47c114e81d`
  (sibling front door that calls `grilling`; where the trigger phrases live)
- `skills/in-progress/chief-of-staff/SKILL.md`, 4,470 B, blob `d823bf86956c570f74545e93b77b25338b437671`
  - `https://raw.githubusercontent.com/mattpocock/skills/main/skills/in-progress/chief-of-staff/SKILL.md`
- `skills/in-progress/software-factory/SKILL.md`, 6,110 B, blob `ba4adc45935e8c24d6bed9b869792e4436ad5979`
  - `https://raw.githubusercontent.com/mattpocock/skills/main/skills/in-progress/software-factory/SKILL.md`

Also observed in the same tree (not fetched — they are product surveys linked from
`software-factory/SKILL.md`, irrelevant to Unit 3's vocabulary): `EXAMPLE-TASKS.md`,
`TICKET-TRACKERS.md`, `GIT-HOSTS.md`, `RUNNERS.md`, `OBSERVABILITY-PLATFORMS.md`, all beside the
software-factory `SKILL.md` in `skills/in-progress/software-factory/`.

### License

MIT. `LICENSE` at `main`, first lines verbatim:

```
MIT License

Copyright (c) 2026 Matt Pocock
```

`gh api repos/mattpocock/skills` reports `license.spdx_id` = `MIT`. Copyright holder line: **MIT ©
2026 Matt Pocock**.

Matching the credit format already used in `.pi/skills/pr/SKILL.md`
(`adapted-from: "mattpocock/skills — engineering/pr (MIT © 2026 Matt Pocock)"`), the per-unit credits
for #606 would read:

- Unit 1 → `adapted-from: "mattpocock/skills — productivity/grilling (MIT © 2026 Matt Pocock)"`
- Unit 2 → `adapted-from: "mattpocock/skills — in-progress/chief-of-staff (MIT © 2026 Matt Pocock)"`
- Unit 3 → `adapted-from: "mattpocock/skills — in-progress/software-factory (MIT © 2026 Matt Pocock)"`

`in-progress` is a moving directory (its own label says so) — pin the blob SHAs above in the brief,
which is why they are recorded here. Note also that the `pr` skill credits upstream as
`engineering/pr`; the path is now `skills/productivity/*` in the current tree, so a naive re-check of
the old credit line would 404. Ours are recorded against the current paths.

### Fetch record — nothing failed

All five fetches returned HTTP 200 with non-zero bodies (`curl -sL`, exit 0 each). Sizes above are
byte counts from `wc -c` on the downloaded files and match the API's reported `size` for every file.
No file was missing, no redirect to a 404 page, no rate-limit. The repo was reachable via both
`curl`/`raw.githubusercontent.com` and `gh api`. Nothing in this document is reconstructed from memory
or paraphrased in place of a fetch.

### Notes for the conductor (adapt, don't import)

- Upstream ships two skills per capability (`grill-me` front door → `grilling` algorithm). If we want
  a user-invocable `/grill`, that is the shape to copy; our house style may prefer one skill.
- Our frontmatter format and `metadata.credits` differ from upstream's (`name` + `description` +
  optional `disable-model-invocation`); #606 says adapt, so keep ours.
- The grilling algorithm's own gaps (no persistence, no refusal, no provenance) are exactly the three
  things Unit 1 adds — worth stating in the brief so a reviewer does not read them as deviations.
- `chief-of-staff` is `in-progress`; its own instructions delegate to sibling skills
  (`../retro/`, `../to-spec/`, `../to-tickets/`, `../implement-spec/`) that we do not have and should
  not import wholesale.

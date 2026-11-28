# Brief — the factory vocabulary (#606 Unit 3)

Slug: `factory-vocabulary` · grilled 2026-11-28 · 15 decisions, one question at a time.

## Want

> "I won't be releasing yet. We have quite a number of issues I want to clear before I even consider a
> release. Right now I want to focus on #606 Unit 3. Do a recon of what's already in the codebase and grill
> me for any decisions one question at a time."
> — the maintainer, 2026-11-28, stating the want.

#606 states Unit 3 as: *"task / trigger / run / runner / ticket tracker; map dispatch→run, worktree→runner; a
lint for the forbidden synonyms."* The grill resolved that into a much smaller, evidence-shaped unit: the
vocabulary becomes a naming layer over the words the code already uses, with one enforced ban, because the
recon showed the two mappings the issue proposed both collide with load-bearing local meanings.

What is being built is the **mechanism** — a data file, a lint, a CI line — plus the four distinctions the
grill settled. The vocabulary's value is that it can now grow by adding a row, and that a synonym cannot
creep back in unnoticed.

## Facts

Every fact below carries its source. Convention: `recon-A` = the terms report, `recon-B` = the machinery
report, both produced by subagents and relayed verbatim (`relay-606-u3`, `relay-606-u3-2`); `measure-606-u3`
= the dedicated count dispatch. The reports themselves are at
`.development/investigations/issue-606-unit3-recon-{a-terms,b-machinery}-2026-11-28.md`.

| # | Fact | Source |
|---|---|---|
| F1 | A maintained glossary exists at `.development/GLOSSARY.md`, in a **prose** register — each entry is *Plain meaning · Not to be confused with · Here we use · Why it matters* — with operating rules including "cross-reference project docs instead of repeating them" and "prune entries that stop being used". It is the only tracked `*GLOSSAR*`/`*VOCAB*`/`TERMS*` document. | recon-A §2, §Q3 |
| F2 | **No terminology or vocabulary lint exists.** The prose guards that do exist are `audit-scratch-instructions.mjs`, `check-contract-tracking.mjs`, `check-readme-test-count.mjs`, `docs-arch.mjs`, `docs-decisions.mjs`, `handoff-verify.mjs`. | recon-B §1 |
| F3 | CI invokes those guards directly; `audit-scratch-instructions.mjs [--root <dir>]` exits **0** clean, **1** durable-artifact hits, **2** usage or missing/unreadable/empty corpus — the shape a new guard should match. | recon-B §1 |
| F4 | Normative prose, `*.md` only: `AGENT.md` + `README.md` 878 lines (published); `.pi/skills/**` 3,281; `presets/**` + `templates/**` 397 (published); `.pi/brl-subagent/**` 636. `.development/**` is 219 files / 30,610 lines, unpublished, and is history + investigations. | recon-B §2 |
| F5 | Term counts across all tracked text: `task` 4,765 · `run` 7,188 · `runner` 475 · `trigger` 85 · `ticket tracker` 11 + `ticket-tracker` 1 + `tickets` 9. In production TS: `task` 612 · `run` 1,287 · `runner` 53 · `trigger` 2 · the ticket forms **0**. | recon-A §Q1, §1 |
| F6 | `run` is live at three scopes: `SubagentRun` (`src/types.ts:368–455`, status `:397`), `InflightRun` (`src/run-registry.ts:71`), `src/unit-run.ts:99–124`, `src/mode-runners.ts:696–714,1527–1545`. Collision verdict: **partly** — same sense, wider scope. | recon-A §A2 |
| F7 | `runner` names the existing foreground process-execution component (`src/runner.ts:3–10` "Process Runner"; `:1060–1090` `runSubagent`) and is **not** a declaration. Collision verdict: **yes**. | recon-A §A2, §Q2 |
| F8 | `worktree` is a conductor-owned **durable** lifecycle resource that persists across runs (`.development/WORKTREE_FRAMEWORK.md:67–94`), distinct from `branch` and `checkout`. Collision verdict with the proposal: **yes**. | recon-A §A2 |
| F9 | `dispatch` names the invocation/routing layer above runs (`src/delegate-handler.ts:199–242`). "dispatch → run" collision verdict: **partly** — it erases the request/execution boundary. | recon-A §A2 |
| F10 | Synonym reality: `preset` 635 / `template` 262 (distinct concepts, preset-dominant); `worktree` 883 / `branch` 960 / `checkout` 197 (genuinely mixed, three git concepts); `run` 2,652 / `execution` 160 / `session` 1,544 (`session` is a pi session); `subagent` 955 / `agent` 1,142 / `worker` 26. | recon-B §3 |
| F11 | **Measured in the chosen corpus** (`AGENT.md`, `README.md`, `.pi/skills/**`, `presets/**`, `templates/**`): `spawn` 224 raw, but 145 of those are in `sprint-metrics.py`, 13 in `jev-check.mjs`, ~13 in tests/fixtures — only **52 in Markdown**, of which 6 are a test-fixture README. **`worker` = 0.** | measure-606-u3 |
| F12 | `spawn` and `dispatch` are **not** synonyms: `.pi/skills/worktree/references/sprint-end-ritual.md:58` — "counted **22 dispatches against 68 logged spawns**". A dispatch is one request; a spawn is one attempt, and retries separate them. The extension logs `Background agent spawned` as the attempt-begin event. | the file, quoted in recon-B/measure, and visible in the measure list |
| F13 | Adding a table row is the whole cost of extending the vocabulary — there is no second place to register a term. | Q14 decision + F1 |

## Settled decisions

| Decision | Answer | Why |
|---|---|---|
| Authority of the vocabulary | A **naming layer**: the glossary/vocabulary is canonical, code identifiers, filenames and tool params keep their names (`dispatch`, `delegate_task`, `worktree`, `run`) | "Copy the algorithms, keep our files"; `delegate_task`'s params are a user-facing API, and a rename would break every saved dispatch text |
| Lint mechanism | **Denylist** — banned synonyms named per concept | What the issue asks for; near-zero false positives; an unlisted synonym is a visible glossary gap, not a silent pass |
| Term scope | **Real concepts only**; `trigger` and `ticket tracker` deliberately **not** adopted | F5: the ticket forms are 0 in production TS; a row for a thing that does not exist is a claim the repo cannot honour |
| Lint enforcement | **Blocking in CI**, same footing as the existing guards; runnable locally | The merge gate already reads CI; (F2/F3) the sockets exist. An unenforced rule is the decay this cycle exists to stop |
| Which term wins a mixed pair | **Local dominance**, except where the local word is already taken by another concept | F6–F10: fighting the corpus guarantees a permanent translation layer |
| Scan scope within a file | **Narrative prose only** — fenced blocks, inline code, quoted upstream text, paths and URLs exempt | Matches `handoff-verify`'s fence rule and `pr-evidence`'s block skipping; under the naming layer, naming an identifier in backticks is correct prose. **Accepted hole:** backticking a banned word is a trivial escape — documented, not hidden |
| How the glossary names banned words | **Structured data file that the lint parses and validates** | The lint already has to read it; validating it is nearly free and prevents a typo'd ban that silently bans nothing |
| The two proposed mappings | **`run` adopted** (aligned with `SubagentRun`), **`dispatch` kept**, **`runner` refused** | F6: `run`'s sense aligns, only its scope is wider. F7: `runner` is an existing module concept. F9: merging dispatch into run erases the request/execution boundary the gate, brief and review record all hang off |
| Where the data lives | **A new `VOCABULARY.md`**, data-only; `.development/GLOSSARY.md` keeps its prose and gains one cross-reference entry | F1: the glossary is an essay register with its own "cross-reference, don't repeat" rule. A scan rule of "this file is exempt except one section" is an exception that grows a hole |
| Corpus scanned | **Living normative prose, `*.md` only**: `AGENT.md`, `README.md`, `.pi/skills/**/*.md`, `presets/**`, `templates/**`. Excluded: `.development/**` (history/investigations), `CHANGELOG.md`, `src/` (identifiers), and all scripts/tests/fixtures | F4: `.development` is 30,610 lines of record-keeping, and rewriting a closed critique to match a later rule is the one edit this project refuses. F11: the `*.md` restriction is what turns 224 raw hits into 52 |
| Which pairs are policed | **Only genuine synonyms**: `worker → subagent`. `preset`/`template`, `worktree`/`branch`/`checkout`, `run`/`session` are recorded as **distinct concepts, deliberately not policed** | F10: banning those would fire on correct prose, and a guard that forces you to argue with it gets disabled |
| Is `spawn` a synonym of `dispatch` | **No — a distinct concept.** `dispatch` = one request; `spawn` = one attempt to start a subagent. Both canonical | F12: the sprint ritual deliberately compares 22 dispatches against 68 spawns; banning `spawn` would force every sentence to say "dispatch" and corrupt a live metric's vocabulary |
| Scope of `run` | **Wide** — one execution of a task at any level; the three record types are its specialisations, and prose says which when it matters (*subagent run*, *unit run*, *mode run*) | F6: the code already uses it at all three scopes; narrowing it would make existing sentences wrong, and dropping it would discard the one upstream term that genuinely aligns |
| Rows in `VOCABULARY.md` | **Four concepts + one ban**: `dispatch`, `spawn`, `run`, `subagent`, and `worker → subagent`. The three refusals (`runner`, `trigger`, `ticket tracker`) are recorded as a **`GLOSSARY.md` entry**, keeping the data file clean | Every row answers a question that was actually open; a definition nobody needed is the stale entry the glossary's own rule says to prune |
| Dead rows | The lint **fails on a canonical term that appears nowhere** in the corpus, with a **marked-forward** exception for a definition deliberately ahead of use | The glossary's "prune entries that stop being used" rule, mechanised. All four of ours are in the hundreds, so this is green on day one and exists to catch tomorrow |

## Out of scope (named, so it is not lost)

- Renaming any identifier, file, parameter or tool name.
- Units 2 and 3's upstream siblings: the wiki index (closed against #607) and the factory's run/trigger
  machinery, which this repository does not have.
- `.development/**` prose, `CHANGELOG.md`, and any script/test/fixture text.
- `scripts/dispatch.mjs`, `#599`, `#602`, `#603` and the `noJev` exponent-form defect.
- Any cap on rounds or questions.

confirmed: 2026-11-28 by Azmeen Afandi

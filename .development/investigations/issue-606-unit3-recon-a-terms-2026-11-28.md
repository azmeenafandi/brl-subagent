# Issue #606, Unit 3 — vocabulary inventory A: terms

**Date:** 2026-11-28  
**Boundary:** read-only reconnaissance. The only repository write is this report. No source, preset, `.pi` tool, git state, install, or test-suite action was changed/run.

## 0. Corpus and reproducible count method

All raw-count results below are from the tracked repository state **before this report existed**: `git ls-files | wc -l` printed **744** files. `git grep` therefore excludes ignored state, `node_modules`, `.git`, and this untracked-at-the-time report.

`\b…\b` is the word-boundary matcher. Counts are case-insensitive and count matches, not files. For the multi-word candidate `ticket tracker`, whitespace is matched as `\s+`; `ticket-tracker` is separately literal. “Production TS” is tracked `src/*.ts` excluding `src/__tests__/**`; “Markdown prose” is tracked `*.md`. These scopes deliberately distinguish the extension implementation from documentation/history, while the required raw count is the all-tracked-text corpus.

### Q1 — printed count command and result

```sh
printf 'production TS occurrence corpus: tracked src/*.ts excluding src/__tests__/**\n'
for term in task trigger run runner 'ticket tracker' ticket-tracker tickets; do
  printf '%-16s ' "$term"
  git grep -I -i -o -E "\\b${term// /\\s+}\\b" -- 'src/*.ts' \
    ':(exclude)src/__tests__/**' | wc -l
done
printf 'Markdown prose corpus: tracked *.md\n'
for term in task trigger run runner 'ticket tracker' ticket-tracker tickets; do
  printf '%-16s ' "$term"
  git grep -I -i -o -E "\\b${term// /\\s+}\\b" -- '*.md' | wc -l
done
printf 'all tracked text corpus: git grep -I -i -o -E word-boundary pattern | wc -l\n'
for term in task trigger run runner 'ticket tracker' ticket-tracker tickets; do
  printf '%-16s ' "$term"
  git grep -I -i -o -E "\\b${term// /\\s+}\\b" | wc -l
done
```

Printed result:

```text
production TS occurrence corpus: tracked src/*.ts excluding src/__tests__/**
task             612
trigger          2
run              1287
runner           53
ticket tracker   0
ticket-tracker   0
tickets          0
Markdown prose corpus: tracked *.md
task             1018
trigger          79
run              2670
runner           176
ticket tracker   11
ticket-tracker   1
tickets          9
all tracked text corpus: git grep -I -i -o -E word-boundary pattern | wc -l
task             4765
trigger          85
run              7188
runner           475
ticket tracker   11
ticket-tracker   1
tickets          9
```

## 1. Absent-with-query list

No candidate is absent from the all-tracked corpus: the raw counts are in Q1. The following requested **code-identifier/type declaration** absences are real and are reported with the query which printed no matching lines.

### Q2 — exact lower-case declaration probe (production TS)

```sh
for term in trigger runner 'ticket tracker' ticket-tracker tickets; do
  printf '\n### %s\n' "$term"
  git grep -n -E "^[[:space:]]*(export[[:space:]]+)?(declare[[:space:]]+)?(async[[:space:]]+)?(function|class|interface|type|enum|const|let|var)[[:space:]]+$term([[:space:]<:=({]|$)|^[[:space:]]*$term[?]?[[:space:]]*:" \
    -- 'src/*.ts' ':(exclude)src/__tests__/**' || true
done
```

**Printed result:** headings only; no match lines. A count form of the same declaration pattern printed: `trigger=0 runner=0 tickets=0`.

* **`trigger`: absent as an exact production declaration.** It has two production-text uses, both comments: `src/delegate-handler.ts:1856` (auto-retry trigger) and `src/mode-runners.ts:498` (render trigger).
* **`runner`: absent as an exact production declaration.** It is nevertheless a live module/concept: `src/runner.ts:3` calls it “Process Runner,” and `src/runner.ts:1063` declares `runSubagent`.
* **`ticket tracker`, `ticket-tracker`, and `tickets`: absent from production TS.** Q1 printed zero source occurrences for all three; Q2 printed no declaration lines. `ticket tracker` and `ticket-tracker` cannot be ordinary TypeScript identifier spellings, but the literal/phrase absence is still material.

Also absent as a canonical-document candidate beyond the glossary:

### Q3 — canonical glossary/vocabulary/terms document probe

```sh
git ls-files '*.md' | grep -Ei '(^|/)([^/]*GLOSSAR[^/]*|[^/]*VOCAB[^/]*|TERMS[^/]*)$'
```

Printed result (one Markdown candidate):

```text
.development/GLOSSARY.md
```

Thus there is **no second tracked Markdown `*GLOSSAR*`, `*VOCAB*`, or `TERMS*` document**. A broader filename search did also match `src/__tests__/runtime-vocabulary.test.ts`; it is a test, not a vocabulary document.

## 2. Existing canonical glossary

**Exists:** yes — `.development/GLOSSARY.md` is the sole candidate from Q3.

**Stated scope, verbatim:**

> Plain-language definitions for terms that come up in this project's work and docs. Started 2026-10-09 at the maintainer's request. The working rule behind it: *a term you can't restate in your own words is a term you can't use to make decisions.*

**Stated operating rules, verbatim:**

> - An entry is added when a term (a) caused confusion in a conversation, or (b) became load-bearing — our decisions now depend on understanding it.
> - Order within an entry: plain-language meaning → what it means *here* → why it matters (the part that changes what you'd do).
> - Short. Cross-reference project docs instead of repeating them.
> - Prune entries that stop being used; a stale glossary is worse than none.

### Entries (verbatim term → definition)

#### Oracle

> **Plain meaning.** The independent source of expected answers you compare a result against to decide "is this correct?" — literally "a source of authoritative answers".
>
> **Not to be confused with** a *spec*, which says what the system should do. The spec is the rulebook; the oracle is the answer key. (Unrelated to Oracle the database company.)
>
> **Here we use several, by question:**
>
> - *Is the graph complete?* → the **filesystem** itself: every `src/*.ts` on disk must appear in the graph (`graph-check.py`, `codegraph-check.py`). The graph tool never gets to define "complete".
> - *Is an agent's work correct?* → the **worktree** ("the worktree oracle"): smoke test + full suite + live probes. We trust what the worktree produces, never the agent's report.
> - *Who calls this function?* → grep as an approximate oracle — known weak (2026-10-08: two wrong constructions before the definition-line fix; the tool under test was right throughout).
> - *Does it behave right for the user?* → your **eyes** (Rule 9's visibility clause).
>
> **Why it matters.** A green check is only as meaningful as its oracle. Weak oracles make "pass" provisional, so every guard states its **boundaries** (what it does *not* see), and an oracle bug is a real bug.

#### Ground truth

> The reality an oracle compares against: files on disk, a live probe's output, your screen. In the retired `graph-check.py`'s words: "Ground truth is the filesystem and the graph JSON. Nothing else."

#### Spec (specification)

> A written statement of what should be built or how something should behave — a delegation spec, the Team Agreement, `AGENT.md`. Prescriptive: what *should* happen. An oracle is evaluative: *was it* right.

#### Backstop

> The mechanism that catches you when something slips: the full test suite, the architecture rules, review. Not the same as an oracle — a backstop detects breakage; it doesn't certify correctness. Rule 15: the suite is the backstop for a spec, not its definition of truth — a spec and its tests can be wrong in the same way.

#### Invariant (architecture rule)

> A property that must always hold, written so it can be checked mechanically. Our 9 architecture rules (no import cycles, raw-console confinement, …) are invariants enforced as tests. Spec: "do X." Invariant: "never allow Y."

#### Ratchet

> A check that only turns one way: it locks in an improvement and fails if the code slides back. Examples: the transcript-path rule (no re-inlined path literals outside `transcript-path.ts`), the runtime-vocabulary ratchet. Ratchets are never loosened — only tightened or retired.

#### Regression

> Something that used to work and no longer does. A "regression test" would fail if a fixed bug came back; most of our 1,2xx-test suite serves this role.

#### Linter

> A tool that reads source code and flags suspicious patterns *without running it* (style, unused code, common bugs). **This project has no linter** (checked 2026-10-09): we rely on the type checker (`tsc`), the executable architecture rules, and review. Analysed and deliberately not adopted for now — the "sensor-stage" idea is queued in `ROADMAP.md`. Umbrella term: *static analysis*.

#### ADR (architecture decision record)

> A short numbered, dated note in `.development/decisions/` recording a decision, the options considered, and why — so nobody (human or agent) has to relitigate it later. We write one when a choice constrains future work (e.g. 0013: TypeScript 7 pinned exactly, with one containment adapter).

The file’s maintenance statement is also verbatim: *“Maintained by the conductor. Entries are added or refreshed whenever a term causes confusion or becomes load-bearing — just ask.”*

### What links to the glossary

### Q4 — direct-link query and result

```sh
git grep -n -F '.development/GLOSSARY.md' -- ':!.development/GLOSSARY.md'
```

Printed result: **2** direct path references.

```text
.development/HANDOFF-ARCHIVE-2026-10-17.md:124
.pi/skills/pr/SKILL.md:18
```

The first says the glossary started; the second instructs PR writers to use it. Four later handoff archives name `GLOSSARY.md` in a directory inventory but do not contain the full path; they are historical mentions, not direct links. The direct-link count therefore does **not** establish that current, user-facing documentation links to it.

## 3. Five candidates

### Declaration convention

“Code declaration” below means a named exported type/interface/function or a typed model field that gives the term domain meaning, rather than every local/reference. This avoids treating 1,287 uses of `run` as declarations. The exact-lowercase declaration absence probe is Q2; the named-declaration query and output were:

```sh
git grep -n -E '^(export )?(interface|type|function|async function|class) (DelegateTaskParams|SubagentRun|InflightRun|AgentStatus|TerminalStatus|RecordFlipStatus|runSubagent|createDelegateHandler)' \
  -- src/types.ts src/run-registry.ts src/runner.ts src/delegate-handler.ts
```

```text
src/delegate-handler.ts:2112:export function createDelegateHandler(
src/run-registry.ts:40:export type InflightRunKind = "foreground" | "unit" | "background";
src/run-registry.ts:48:export type RecordFlipStatus = "failed" | "completed";
src/run-registry.ts:71:export interface InflightRun {
src/runner.ts:1063:export async function runSubagent(
src/types.ts:368:export interface SubagentRun {
src/types.ts:674:export type DelegateTaskParams = Static<typeof delegateTaskParamsSchema>;
src/types.ts:839:export type AgentStatus = "pending" | "running" | "steered" | "completed" | "failed" | "stopped";
src/types.ts:1122:export type TerminalStatus = "completed" | "failed" | "stopped";
```

| Term | Code identifiers/types (declarations) | Prose locations (representative, with all-prose count in Q1) | Raw occurrence count |
|---|---|---|---:|
| `task` | `DelegateTaskParams` (`src/types.ts:674`); `TaskTemplate` and its `task` field (`src/types.ts:193,196`); `SubagentRun.task` (`src/types.ts:368,370`); `SubTaskParams.task` (`src/types.ts:538,539`); `SubTaskResult.task` (`src/types.ts:557,559`); `GraphTask.task` (`src/types.ts:607,609`); `InflightRun.task` (`src/run-registry.ts:71,86`); `runSubagent(... task: string)` (`src/runner.ts:1063,1068`). | API definition: `README.md:77–84`; operational task/run distinction: `AGENT.md:29–34, 65–76`; workflow: `.pi/skills/worktree/SKILL.md:191–200`; proposed factory meaning: `.development/investigations/issue-606-grilling-upstream-2026-11-27.md:313–316,360`. | **4,765** all tracked; **612** production TS; **1,018** Markdown (Q1). |
| `trigger` | **Absent as an exact declaration (Q2).** Only production-text comments at `src/delegate-handler.ts:1856` and `src/mode-runners.ts:498`; no type, field, function, or module models an external start event. | Proposed vocabulary and definition occur in `.development/investigations/issue-606-grilling-upstream-2026-11-27.md:318–325,361,368–384`; incidental skill wording appears in `.pi/skills/grill/SKILL.md:109`. | **85** all tracked; **2** production TS; **79** Markdown (Q1). |
| `run` | `SubagentRun` record (`src/types.ts:368`), `InflightRun` durable registry entry (`src/run-registry.ts:71`), `InflightRunKind` (`src/run-registry.ts:40`), `RecordFlipStatus` (`src/run-registry.ts:48`), `runSubagent` (`src/runner.ts:1063`), and `runForeground` (`src/delegate-handler.ts:1169`). `SubagentRun.status` is `running \| done \| failed` at `src/types.ts:397`. | User API: `README.md:93–139, 308–339`; capability contract: `AGENT.md:39–59,74–97`; architecture explains foreground/background runs: `.development/ARCHITECTURE.md:29–55`; proposed factory definition: issue-606 upstream `:322–325,362`. | **7,188** all tracked; **1,287** production TS; **2,670** Markdown (Q1). |
| `runner` | **Absent as an exact declaration (Q2).** It is a module/file, `src/runner.ts`, headed “Process Runner” (`:3`) and exporting `runSubagent` (`:1063`); `src/mode-runners.ts:3` is a separate mode-routing module. | Current implementation prose: `.development/ARCHITECTURE.md:29–36,115`; worktree skill refers to `runner.ts` at `.pi/skills/worktree/SKILL.md:149`; proposal definition at issue-606 upstream `:328–329,363`; current persistence hazard is explicitly noted `:375–379`. | **475** all tracked; **53** production TS; **176** Markdown (Q1). |
| `ticket tracker` (also `ticket-tracker`, `tickets`) | **Absent from production TS** — Q1 printed `0/0/0`; Q2 printed no declaration lines. There is no domain model, integration, or tool parameter for tickets. | `ticket tracker`: only the upstream vocabulary investigation plus the grill skill (`.development/investigations/issue-606-grilling-upstream-2026-11-27.md:318–375`; `.pi/skills/grill/SKILL.md:109`). Hyphenated `ticket-tracker` is only issue-606 upstream `:361`. `tickets` appears in that upstream document `:233,304,335–339,364,460`. | `ticket tracker` **11**, `ticket-tracker` **1**, `tickets` **9** all tracked; respective Markdown counts are **11/1/9** and production TS counts **0/0/0** (Q1). |

## 4. Collisions — decision-relevant inventory

Severity here means **migration/semantic collision risk**, not a claim of a present software defect: High = a proposed replacement would overload an already persisted or enforced term; Medium = the term is presently distinct but adjacent enough to mislead documentation/tool users.

| Term/proposal | Today’s meaning | Evidence (file:line) | Collides? | Why |
|---|---|---|---|---|
| `run` = one execution of a task | A `SubagentRun` is a persisted execution record with task, identity/retry lineage, timing, output and `running \| done \| failed` status; `InflightRun` is the durable, in-flight registry record. Batch modes can also create aggregate “Chain dispatch” / “Graph dispatch” run entries. | `src/types.ts:368–455` (`SubagentRun`), especially `:397`; `src/run-registry.ts:3–25,71–109`; `src/delegate-handler.ts:1549,1572`; `src/unit-run.ts:99–124`; `src/mode-runners.ts:696–714,1527–1545`. | **Partly (High)** | The proposed “one execution” is broadly the same thing as an individual `SubagentRun`, but today `run` also names registry/history/retry records and aggregate/batch accounting; it is not only the factory’s black-box execution concept. A vocabulary migration must explicitly map or distinguish those record scopes. |
| `runner` = disposable machine; proposed `worktree → runner` | `runner` means the foreground process-execution component: it spawns/manages `pi` subprocesses. It does **not** mean the checkout/worktree. | `src/runner.ts:3–10,1060–1090`; `.development/ARCHITECTURE.md:29–36,115`; `src/mode-runners.ts:39,105,150`. | **Yes (High)** | Calling the worktree a runner collides with an existing code/module concept named runner. It also risks suggesting that the `src/runner.ts` process component is the disposable workspace. |
| `worktree` remains the Git term while concept is renamed | A worktree is a conductor-owned Git worktree lifecycle resource: create, prep, delegate with `cwd`, review/merge, cleanup. It persists beyond a subagent/run and has dedicated scripts. | `.development/WORKTREE_FRAMEWORK.md:67–94`; `.pi/skills/worktree/SKILL.md:4–15,63–65,518–553`; scripts `.pi/skills/worktree/worktree-prep.sh` and `.pi/skills/worktree/worktree-cleanup.sh`. | **Yes (High)** | The literal Git term is load-bearing in prose and script names. The proposed runner’s “nothing survives the run” directly conflicts with the known persistence hazard: issue-606 upstream `:375–379` says worktrees persist across runs. Keep **Git worktree** as the technical resource; do not use bare `runner` as an unqualified replacement unless durability/ownership is explicitly redefined. |
| `dispatch → run`; tool remains `delegate_task` | A dispatch is the logical tool invocation/routing operation: normalize, classify shape, prepare/pre-flight, route to batch/background/foreground, then create/execute runs. `delegate_task` is the registered tool name. | `src/delegate-handler.ts:1–10,199–242,494–824,2148–2228`; `src/index.ts:208–215`; `README.md:11,77,143`; `AGENT.md:52,75`. | **Partly (Medium)** | There is no tool literally named `dispatch`; the tool name stays `delegate_task`. But documentation/code already uses *dispatch* for the enclosing request and *run* for execution records, so renaming dispatch to run would erase a useful layer boundary and collide with `SubagentRun`/`run*` terms. |
| `agent` / `subagent` / `worker` | `subagent` is the delegated child role and public tool/event namespace; `agent` is especially the background-session/record identity with id/status; `worker` is not a role vocabulary and appears only incidentally (e.g. co-worker/security prose). | `src/types.ts:368,464,503,722–739,839`; `src/session-manager.ts:202,701,1713,1925`; `src/agent-tools.ts:65,233,285`; `src/runner.ts:5,123`; `README.md:11,157,306–339`. | **No, but usage is adjacent (Medium)** | The three are **not interchangeable in implementation**: background agents have IDs and durable records, subagents are the broader delegated execution/child vocabulary, and worker has no corresponding code model. Human prose sometimes uses “agent” generically, so an external vocabulary should reserve definitions rather than treat the three as synonyms. |

### Q5 — `agent` / `subagent` / `worker` raw counts

```sh
for term in agent subagent worker; do
  printf '%s: ' "$term"
  git grep -I -i -o -E "\\b$term\\b" | wc -l
done
```

Printed result (all tracked text corpus):

```text
agent: 3338
subagent: 2442
worker: 90
```

These raw counts include separate-word uses only (for example, `brl-subagent` is not a whole-word `subagent` match). They confirm that `agent` and `subagent` are both established vocabulary; the role distinction above comes from the cited declarations and public documentation, not count magnitude alone.

### Q6 — worktree script-name count

```sh
git ls-files '.pi/skills/worktree/*' | grep -Ec '/[^/]*worktree[^/]*\.sh$'
```

Printed result: **2** (`worktree-prep.sh`, `worktree-cleanup.sh`). This is additional evidence that “worktree” is an externally visible operational term, not merely an abstract concept.

## 5. Findings index and recommendation

* **Critical: 0.** No immediate unsafe state change was examined or performed.
* **High: 3.** `run` already has persisted-record/registry semantics; `runner` already names a process component; **Git worktree** is a durable lifecycle resource with named scripts and an explicit persistence conflict.
* **Medium: 2.** `dispatch` is a distinct request/routing layer above runs, and agent/subagent/worker are adjacent words with distinct implementation roles.
* **Recommendation:** retain the existing technical terms in qualified form (`SubagentRun`, process runner, Git worktree, dispatch, background agent). If adopting the factory vocabulary, put an explicit mapping/exception in the new glossary rather than renaming these existing words wholesale—especially state that a Git worktree is a conductor-owned durable resource, not automatically a disposable runner.

## 6. What I did **not** verify

1. I did not execute the test suite, install dependencies, run scripts, or create a worktree, per the task boundary.
2. I did not inspect ignored/untracked runtime state, other checkouts, GitHub tickets, or external ticket-tracker integrations; Q1 is tracked repository text only.
3. I did not establish whether the two direct glossary links are rendered, followed in practice, or sufficient for discoverability; Q4 proves textual references only.
4. I did not decide whether the proposed factory vocabulary should be adopted. This report inventories present meanings/collisions only.
5. I did not perform a semantic AST inventory of every one of the 612/1,287 source-word occurrences; declaration rows list the domain-defining exported types/functions/fields and Q2 separately proves exact-name absences.
